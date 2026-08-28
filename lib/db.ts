/**
 * lib/db.ts — the only connection, and the only way to use it (CONTRACTS §2).
 *
 * @mechanism withSession — the only path to a row. The pool connects as `cm_runtime`, which
 *   has no table privileges at all, so every query runs inside a transaction whose preamble
 *   `SET LOCAL ROLE`s to one of three hardcoded literals and sets the GUCs the RLS policies
 *   read. Tenancy is therefore a property of the connection rather than of every caller
 *   remembering a `where academy_id`, and there is no path that skips it — a query that
 *   declared nobody would have no privileges to run at all.
 *
 * Invariant §2.1 made mechanical. The pool connects as `cm_runtime`, which has
 * no table privileges at all. Every query therefore runs inside a transaction
 * that first `SET LOCAL ROLE`s to one of exactly three roles and sets the GUCs
 * the RLS policies read. There is no way to touch a row without declaring who
 * you are, because there is no path that skips `withSession`.
 *
 * Three details that matter more than they look:
 *
 *   SET LOCAL only holds inside a transaction, and the pooler reuses
 *   connections — so every call is wrapped in sql.begin() and nothing ever
 *   SET ROLEs outside one.
 *
 *   GUC values are uuids and are checked against a uuid pattern before they are
 *   interpolated — `guc()` throws on anything else, which refuses strictly more
 *   than quoting would accept. The role cannot be a parameter at all, so it
 *   comes from a hardcoded allowlist of three literals and never from input.
 *   (These were bound parameters until the preamble was collapsed into one
 *   round trip; see `applySession` for why that mattered.)
 *
 *   A transaction cannot outlive its callback. That is not a convention anybody
 *   has to keep; it is three bounds enforced in `runTransaction`, and the reason
 *   they exist is written there in full. Read it before adding a fourth way in.
 */

import postgres from 'postgres'

import { env } from '@/lib/env'
import { recordSql, sqlTraceRows, type SqlRecord } from '@/lib/agent/sql-trace'
import { AppError, errorMessage } from '@/lib/errors'

export type Tx = postgres.TransactionSql<{}>

/**
 * What put this session's work on the wire (0032). Carried here rather than
 * passed to `send`, for the reason `turnId` is: a guarantee applied per caller
 * is not a guarantee, and every job handler that opens its own service session
 * would otherwise have to remember.
 */
export type MessageOrigin = 'turn' | 'job' | 'tap' | 'system'

type Attribution = { turnId?: string; origin?: MessageOrigin; originRef?: string }

export type SessionCtx =
  | ({ role: 'service'; academyId: string } & Attribution)
  | ({ role: 'user'; academyId: string; personId: string; contactId: string } & Attribution)
  | ({ role: 'readonly'; academyId: string; personId: string; contactId: string } & Attribution)

/**
 * The service session that does a piece of work on behalf of an existing one.
 *
 * @mechanism serviceFrom — escalating to the service role carries the caller's attribution
 *   with it (`turnId`, `origin`, `originRef`) instead of each caller remembering to. Fourteen
 *   sites built `{ role: 'service', academyId }` by hand and every one dropped those GUCs, so
 *   `message.turn_id` came back null on every row the product sent. Escalating is the
 *   operation, so escalating is where the attribution is held, and a caller written tomorrow
 *   gets it free.
 *
 * Fourteen places wrote `{ role: 'service', academyId: ctx.academyId }` inline,
 * and every one of them silently dropped `turnId` — so the GUC that 0015 chose
 * *specifically so no caller has to remember* was unset for the whole of every
 * escalated write. `message.turn_id` came back null on every row in the product
 * because of exactly this, at one line, in `send`.
 *
 * The lesson is the one in DRIVING.md's second test: a guarantee applied per
 * caller is not a guarantee. Escalating is the operation, so escalating is where
 * the attribution is carried, and a new caller written tomorrow gets it free.
 *
 * `turnId` is spread conditionally rather than passed as `undefined` because
 * `applySession` distinguishes an absent GUC from an empty one.
 */
export function serviceFrom(ctx: SessionCtx): SessionCtx {
  return {
    role: 'service',
    academyId: ctx.academyId,
    ...(ctx.turnId ? { turnId: ctx.turnId } : {}),
    // Attribution travels with the escalation for the same reason turnId does:
    // an elevated write is still this turn's, this job's or this tap's work.
    ...(ctx.origin ? { origin: ctx.origin } : {}),
    ...(ctx.originRef ? { originRef: ctx.originRef } : {}),
  }
}

export type QueryResult = {
  rows: Record<string, unknown>[]
  rowCount: number
  /** true when the 10k cap clipped it. */
  truncated: boolean
  ms: number
  error?: string
}

/** §14.2 — a model can write an accidental cartesian join. */
export const MODEL_ROW_CAP = 10_000

/**
 * How many rows of a read are handed back to the model.
 *
 * Distinct from `MODEL_ROW_CAP`, and the distinction is the point: the cap is
 * what the DATABASE returns and sets `truncated`; this is the sample the model
 * is shown, and until it was named it was an anonymous `.slice(0, 200)` in the
 * read tool that reported nothing. See the hand-back in `tools.ts`.
 */
export const MODEL_ROWS_SHOWN = 200
const MODEL_TIMEOUT_MS = 5_000
const USER_TIMEOUT_MS = 15_000

/**
 * How long a transaction may sit IDLE between two statements before Postgres
 * terminates the session itself. See the outage note above `runTransaction`;
 * this is the bound that was missing.
 *
 * The value is justified by what a legitimate gap actually is. The only work
 * between two statements of one transaction in this codebase is JavaScript —
 * building a SQL string, grouping a diff, deciding the next step. Every network
 * call is deliberately outside the transaction (`executePlan` flushes the outbox
 * only *after* the commit, precisely so a rolled-back plan has messaged nobody),
 * and a statement that is actually running is bounded separately at 5 s or 15 s.
 * A real gap is sub-millisecond, so 30 s is four orders of magnitude of headroom
 * and still ~32× faster than the sixteen-minute leak that took the app down.
 *
 * Erring short is the safe direction: a transaction killed here fails loudly,
 * and the failure it replaces was fifteen backends doing nothing, in silence,
 * until someone terminated them by hand.
 */
const TX_IDLE_TIMEOUT_MS = 30_000

/**
 * Wall-clock cap on a whole transaction callback, enforced on this side rather
 * than by the server. It catches the two shapes `TX_IDLE_TIMEOUT_MS` cannot: a
 * callback that keeps the connection *busy* forever (never idle, so the server
 * never reclaims it), and a socket wedged such that the server's own timeout
 * never reaches us and the promise stays pending holding a pool slot.
 *
 * Not a performance budget. Nothing in this product legitimately holds one
 * transaction for two minutes, so anything that reaches this is already broken
 * and the right outcome is to say so and give the connection back.
 *
 * Deliberately NOT wrapped around `sql.begin()` itself: a deadline firing while
 * begin is still queued for a connection would abandon a promise that later
 * acquires one and sends BEGIN with nobody left to close it — the exact leak,
 * reintroduced by the guard against it.
 */
const TX_DEADLINE_MS = 120_000

/**
 * The three roles, as literals. `SET LOCAL ROLE` cannot take a parameter, so
 * this map is the only source a role name may ever come from.
 */
const ROLE_SQL: Record<SessionCtx['role'], 'cm_service' | 'cm_user' | 'cm_readonly'> = {
  service: 'cm_service',
  user: 'cm_user',
  readonly: 'cm_readonly',
}

type PoolGlobal = typeof globalThis & { __cm_sql?: postgres.Sql<{}> }

function createPool(): postgres.Sql<{}> {
  const pool = postgres(env.DATABASE_URL, {
    ssl: 'require',
    /**
     * Per process, and it now sits behind the TRANSACTION pooler (port 6543)
     * rather than the session one (5432).
     *
     * On session mode the ceiling was `pool_size: 15` for the whole project,
     * shared by every instance, and a connection was held for the life of the
     * client rather than the life of a statement. Two busy instances exhausted it
     * on arithmetic alone, with no leak involved, and everyone else got
     * `(EMAXCONNSESSION) max clients reached in session mode`. That is not a
     * hypothetical: 23 of the first live week's 29 SQL errors were this one class,
     * 14 of them on its worst-scoring day, and what they broke was the prefetch
     * that builds the prompt — so the failure surfaced as the model telling a
     * coach his own pay was not visible to it.
     *
     * The demand was the arithmetic. Building one coach's tail fires seven
     * transactions at once (two memory reads, three census queries, two standing
     * queries); two conversations overlapping wanted fourteen of the fifteen.
     * Transaction mode is what makes that survivable — a connection is borrowed
     * for one transaction and handed straight on, so short reads multiplex instead
     * of queueing behind each other.
     *
     * Everything this file does was already written for it and is verified under
     * it: `SET LOCAL ROLE`, the GUCs, `statement_timeout` and `set transaction
     * read only` all hold, because nothing here ever touches a connection outside
     * `sql.begin()`. `prepare: false` below is the one thing transaction mode
     * requires and it was already set.
     *
     * `max` stays at 10. It is a demand ceiling, not a supply one — raising it
     * makes exhaustion likelier, never rarer — and 10 is the width that made
     * `GET /api/emulator/state` 1.2 s instead of 6.0 s when `worldState()` fans
     * out one transaction per tenant.
     *
     * MIGRATION_DATABASE_URL stays on 5432 on purpose: migrations take advisory
     * locks and run DDL across statements, which is what session mode is for.
     */
    max: 10,
    // Supabase's transaction pooler cannot carry prepared statements.
    prepare: false,
    transform: undefined,
    idle_timeout: 20,
    connect_timeout: 15,
    /**
     * A connection may not squat on a pooler slot indefinitely. postgres.js
     * defaults this to a random 30–60 minutes — longer than the outage described
     * above `runTransaction` took to flatten every route — so it is pinned
     * somewhere useful rather than left to chance.
     *
     * This is a floor, not the fix. `idle_timeout` provably cannot reach a
     * leaked transaction (that note explains why), and fifteen minutes of a
     * wedged connection is already an outage. The bounds that matter are the
     * three in `runTransaction`.
     */
    max_lifetime: 60 * 15,
    onnotice: () => {},
    types: {
      /** numeric -> number. Money is rupees as a JS number (CONTRACTS §11). */
      money: {
        to: 1700,
        from: [1700],
        serialize: (v: number) => String(v),
        parse: (v: string) => Number(v),
      },
      /** int8 -> number. sim_clock.offset_ms is milliseconds, not a bigint. */
      int8: {
        to: 20,
        from: [20],
        serialize: (v: number) => String(v),
        parse: (v: string) => Number(v),
      },
      /**
       * date -> 'YYYY-MM-DD'. A calendar day is not an instant; parsing
       * `2026-08-31` into a Date is how a Saturday class lands on a Friday.
       * timestamp/timestamptz keep the built-in Date parser.
       */
      dateonly: {
        to: 1082,
        from: [1082],
        serialize: (v: string) => {
          const raw: unknown = v
          return raw instanceof Date ? raw.toISOString().slice(0, 10) : String(raw)
        },
        parse: (v: string) => v,
      },
    },
  })
  return pool as unknown as postgres.Sql<{}>
}

function pool(): postgres.Sql<{}> {
  const g = globalThis as PoolGlobal
  if (!g.__cm_sql) g.__cm_sql = createPool()
  return g.__cm_sql
}

/**
 * Raw handle. Only lib/db.ts, lib/clock.ts and migrations may use it.
 *
 * A Proxy so the pool — and therefore `env.DATABASE_URL` — is not touched until
 * the first query. It used to be created at module scope, which made *importing*
 * this file need runtime secrets: `next build`'s page-data collection imports
 * every route's module graph, so a Vercel Preview build (an environment that
 * deliberately holds no secrets) died in `get DATABASE_URL` before it had built
 * anything, and every PR wore a red check for a failure no code caused. A build
 * must be constructible from source alone; secrets are for requests.
 *
 * Methods are bound to the real pool on the way through, so `sql.begin`,
 * `sql.unsafe` and the template-tag call all behave exactly as before.
 */
export const sql: postgres.Sql<{}> = new Proxy(
  // The target is never used — every trap forwards to `pool()`. It is a
  // function so the proxy is callable (the template-tag form).
  (() => {}) as unknown as postgres.Sql<{}>,
  {
    get(_target, prop) {
      const p = pool()
      const v = Reflect.get(p as unknown as object, prop)
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(p) : v
    },
    apply(_target, _thisArg, args) {
      return Reflect.apply(pool() as unknown as (...a: unknown[]) => unknown, undefined, args)
    },
  },
)

/**
 * Escape hatch for parameterised dynamic SQL inside this codebase's own
 * modules. One cast, in one place, instead of one per call site.
 */
export async function unsafeQuery<T = Record<string, unknown>>(
  tx: Tx,
  query: string,
  params: unknown[] = [],
): Promise<T[]> {
  const runner = tx as unknown as { unsafe: (q: string, p: unknown[]) => Promise<unknown> }
  const rows = await runner.unsafe(query, params)
  return rows as T[]
}

/**
 * The session preamble, in ONE round trip.
 *
 * This was four sequential statements — `set transaction read only`, `set local
 * role`, `set local statement_timeout`, then the GUCs — and each `await` is a
 * network round trip before the caller's query has even been sent.
 *
 * **The cost is the count, not the distance.** Measured against the Supabase
 * pooler: one round trip is ~37 ms, which is unremarkable, and `withSession` plus
 * a single query now totals ~151 ms — exactly four trips (BEGIN, this preamble,
 * the query, COMMIT). Before, the preamble alone was three or four of them, so
 * the cheapest possible session cost seven to nine. Nothing about that is visible
 * in a profiler pointed at SQL: every individual statement is fast.
 *
 * A latency that small still ruins a route that pays it enough times. `GET
 * /api/emulator/state` took **6.0 s** because it ran one transaction per tenant,
 * sequentially, over ten tenants — nine trips each, then again, then again. It
 * now takes **1.2 s**: three trips saved here, and the tenant loop fanned out in
 * `worldState()`. The emulator felt broken because it was, and neither half of
 * the fix would have been enough alone.
 *
 * `SET ROLE x` and `SET LOCAL statement_timeout` both have `set_config()` forms,
 * so the whole preamble collapses into one `select`. The only statement that
 * cannot join it is `SET TRANSACTION READ ONLY`, which Postgres requires before
 * the first query of the transaction — and a `select` is a query. So readonly
 * pays two trips and everything else pays one.
 *
 * The GUC values are interpolated rather than parameterised because a
 * multi-value `set_config` target list with five placeholders is no cheaper, and
 * because these are uuids: `guc()` refuses anything that is not one, which is a
 * stricter guarantee than quoting would give.
 */
const UUID_OR_EMPTY = /^$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function guc(name: string, value: string | undefined): string {
  const v = value ?? ''
  if (!UUID_OR_EMPTY.test(v)) {
    throw new AppError({
      code: 'bad_session_guc',
      message: `${name} must be a uuid or empty — got ${JSON.stringify(v).slice(0, 80)}`,
    })
  }
  return `set_config('${name}', '${v}', true)`
}

/**
 * The two attribution GUCs that are words rather than uuids (0032).
 *
 * `app.origin` is one of four literals and is validated against them, which is
 * the same guarantee `guc()` gives a uuid and for the same reason: these are
 * interpolated. `app.origin_ref` is free text by design — a job kind, a tapped
 * action kind, a form id — so it is escaped rather than enumerated, and capped,
 * because a GUC is not a place to put a body.
 */
const ORIGINS = new Set(['turn', 'job', 'tap', 'system', ''])

function originGuc(value: string | undefined): string {
  const v = value ?? ''
  if (!ORIGINS.has(v)) {
    throw new AppError({
      code: 'bad_session_guc',
      message: `app.origin must be turn, job, tap or system — got ${JSON.stringify(v).slice(0, 40)}`,
    })
  }
  return `set_config('app.origin', '${v}', true)`
}

function originRefGuc(value: string | undefined): string {
  const v = (value ?? '').slice(0, 120).replace(/'/g, "''")
  return `set_config('app.origin_ref', '${v}', true)`
}

async function applySession(tx: Tx, ctx: SessionCtx): Promise<void> {
  const role = ROLE_SQL[ctx.role]
  if (!role) {
    throw new AppError({ code: 'bad_session_role', message: `Unknown session role: ${String((ctx as { role: string }).role)}` })
  }

  // Must precede every other statement in the transaction, and the role's own
  // default_transaction_read_only does not apply to a mid-transaction SET ROLE.
  // This is the one thing that cannot ride along below.
  if (ctx.role === 'readonly') await unsafeQuery(tx, 'set transaction read only')

  const personId = 'personId' in ctx ? ctx.personId : ''
  const contactId = 'contactId' in ctx ? ctx.contactId : ''
  const timeout = ctx.role === 'readonly' ? MODEL_TIMEOUT_MS : USER_TIMEOUT_MS

  // Order within the target list matters only in that the role must be adopted
  // before anything that depends on it; `app.*` are custom GUCs any role may set.
  await unsafeQuery(
    tx,
    `select set_config('role', '${role}', true),
            set_config('statement_timeout', '${timeout}', true),
            -- The bound that survives this process dying. statement_timeout only
            -- bounds a statement that is RUNNING; a leaked transaction is idle by
            -- definition, and a frozen serverless instance has no JavaScript left
            -- to roll anything back. Rides along in the preamble's existing round
            -- trip, so it costs nothing. is_local, so it ends with the transaction.
            set_config('idle_in_transaction_session_timeout', '${TX_IDLE_TIMEOUT_MS}', true),
            ${guc('app.academy_id', ctx.academyId)},
            ${guc('app.person_id', personId)},
            ${guc('app.contact_id', contactId)},
            -- Read by app.begin_audit, so every write in this transaction is
            -- attributable to the turn that caused it (0015). Empty outside a turn.
            ${guc('app.turn_id', ctx.turnId)},
            -- The same shape one question wider (0032): turn_id says WHICH turn,
            -- these say whether there was a turn at all. 27 of 81 outbound
            -- messages in one drive carried no attribution, which meant the truth
            -- axis could not be measured on exactly the surface where the product
            -- acts unsupervised. Defaults on message.origin read these.
            ${originGuc(ctx.origin)},
            ${originRefGuc(ctx.originRef)}`,
  )
}

/** Private sentinel. Never escapes this module. */
class RollbackSignal<T> extends Error {
  constructor(readonly value: T) {
    super('rollback')
    this.name = 'RollbackSignal'
  }
}

/* -----------------------------------------------------------------------------
 * A transaction may not outlive its callback
 *
 * @mechanism runTransaction — the one function every transaction goes through, bounded three
 *   ways: `idle_in_transaction_session_timeout` in the preamble (the server's own reaper, the
 *   only bound that survives this process being frozen or killed), `TX_DEADLINE_MS`, which
 *   turns "never settles" into a rejection so postgres.js reaches its ROLLBACK, and a
 *   `revocable` handle that dies the instant its callback returns, so a late statement cannot
 *   land on a connection now serving another tenant under another role. Without them a leaked
 *   transaction is a pooler slot that never comes back and the failure only ever gets worse:
 *   fifteen of fifteen held, two idle in transaction for sixteen minutes, every
 *   database-backed route 500ing until the backends were terminated by hand.
 *
 * THE OUTAGE, because the ledgers are gone and this comment is the only record.
 * `cm_runtime` held 15 of 15 pooler connections and every database-backed route
 * 500'd with `(EMAXCONNSESSION) max clients reached in session mode - max clients
 * are limited to pool_size: 15`. Two of those fifteen backends were `idle in
 * transaction` for over SIXTEEN MINUTES: BEGIN had been sent and neither COMMIT
 * nor ROLLBACK ever followed. It was recovered by terminating the backends by
 * hand. It does not self-heal — every leaked transaction is a pooler slot that
 * never comes back, so it only ever gets worse.
 *
 * Three facts explain why nothing already here caught it, and each one is a
 * layer below:
 *
 *   `statement_timeout` (5 s / 15 s) bounds a statement that is RUNNING. `idle
 *   in transaction` means none is. The leak lives in the gap *between*
 *   statements, and nothing in this file bounded that gap at all.
 *
 *   `idle_timeout: 20` cannot reap it either, and not by accident: postgres.js
 *   cancels a connection's idle timer for every pool queue except `open`
 *   (src/index.js, `move()`), and a connection inside a transaction sits in
 *   `reserved`. A connection idle *in a transaction* is exempt from the only
 *   client-side reaper we had, by construction.
 *
 *   `sql.begin()` only ever sends COMMIT or ROLLBACK from the continuation of
 *   its callback. If that callback's promise never settles — a hung await, or a
 *   serverless instance frozen or killed mid-transaction — there is no code left
 *   running that *could* close the transaction. Nothing on this side of the
 *   socket can fix that last case; only the server can, which is why
 *   `idle_in_transaction_session_timeout` is set in the preamble above.
 *
 * So a transaction is now bounded three ways, and every path — commit, rollback,
 * throw, early return, aborted statement, abandoned callback — goes through this
 * one function to get them. Anything that fixed only `withSession` would be a
 * call site; `withRollback` had the identical hole.
 * --------------------------------------------------------------------------- */

type Revocable = { handle: Tx; revoke: () => void }

/**
 * A `tx` handle that stops working the instant its callback returns.
 *
 * Without this, a handle that outlives its callback is not merely useless — it
 * is dangerous. The connection it is bound to has gone back to the pool and is
 * very likely inside somebody else's transaction, under somebody else's role,
 * with somebody else's `app.academy_id`; a statement arriving on it late lands
 * in that tenant's session. That is the same hazard as a callback abandoned by
 * the deadline below, whose pending queries may still be waiting to fire.
 *
 * Symbols are let through unrevoked on purpose: every real API on this handle is
 * a string key, and symbols are engine protocols (`Symbol.toPrimitive`, node's
 * inspect hook) that get probed by logging and error paths. Throwing from those
 * turns a clear diagnostic into a confusing one.
 */
function revocable(raw: Tx): Revocable {
  let live = true

  const dead = (): never => {
    throw new AppError({
      code: 'tx_handle_expired',
      message:
        'This transaction handle is dead — its withSession/withRollback callback has already returned. The ' +
        'connection is back in the pool and may now be serving another tenant. Do the work inside the callback.',
    })
  }

  /**
   * A savepoint hands out a *different* handle bound to the same connection, so
   * revoking this one would not revoke that one. Wrapped here rather than
   * trusting each caller, which is the same chokepoint argument one level down.
   */
  const wrapSavepoint = (value: unknown): unknown => {
    if (typeof value !== 'function') return value
    const original = value as (...args: unknown[]) => unknown
    return (...args: unknown[]): unknown => {
      if (!live) dead()
      const last = args[args.length - 1]
      // The tagged-template form carries no callback; nothing to scope.
      if (typeof last !== 'function') return original.apply(raw, args)
      const inner = last as (sp: Tx) => Promise<unknown>
      args[args.length - 1] = async (sp: unknown): Promise<unknown> => {
        const child = revocable(sp as Tx)
        try {
          return await inner(child.handle)
        } finally {
          child.revoke()
        }
      }
      return original.apply(raw, args)
    }
  }

  const handle = new Proxy(raw as unknown as object, {
    apply(target, thisArg, args) {
      if (!live) dead()
      return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args)
    },
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      if (!live) dead()
      const value = Reflect.get(target, prop, receiver)
      return prop === 'savepoint' ? wrapSavepoint(value) : value
    },
  }) as unknown as Tx

  return {
    handle,
    revoke: () => {
      live = false
    },
  }
}

/**
 * Turns "never settles" into "settles as an error", so postgres.js reaches its
 * ROLLBACK instead of waiting forever on a promise that will not come.
 */
function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined

  const alarm = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppError({
          code: 'tx_deadline',
          message: `${label} held a transaction for more than ${ms} ms without finishing — rolled back and the connection released.`,
        }),
      )
    }, ms)
    // A pending alarm must not be the reason a script (seed, drive) refuses to exit.
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })

  // Promise.race subscribes to `work`, so a rejection arriving from the
  // abandoned callback afterwards is already handled and can never surface as
  // an unhandled rejection that takes the process down.
  return Promise.race([work, alarm]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

async function runTransaction<T>(ctx: SessionCtx, fn: (tx: Tx) => Promise<T>, commit: boolean): Promise<T> {
  const label = `${commit ? 'withSession' : 'withRollback'}(${ctx.role})`

  /**
   * Revoked from two places on purpose. The inner `finally` is the normal path.
   * The outer one covers the case where `sql.begin` rejects while the callback
   * is still pending — postgres.js races the scope against `connection.onclose`,
   * so a server-side kill (the timeout above, or a DBA) resolves `begin` and
   * leaves `fn` hanging forever with a live handle in its hand.
   */
  const guards: Revocable[] = []

  try {
    const body = async (raw: unknown): Promise<unknown> => {
      const guard = revocable(raw as Tx)
      guards.push(guard)
      try {
        const value = await withDeadline(
          (async () => {
            // Inside the deadline: the preamble runs before statement_timeout
            // exists, so it is unbounded by anything else.
            await applySession(guard.handle, ctx)
            return await fn(guard.handle)
          })(),
          TX_DEADLINE_MS,
          label,
        )
        if (!commit) throw new RollbackSignal(value)
        // Wrapped so postgres.js's UnwrapPromiseArray never unwraps an array result.
        return { value } as unknown
      } finally {
        guard.revoke()
      }
    }

    if (commit) {
      const out = await sql.begin(body)
      return (out as { value: T }).value
    }

    try {
      await sql.begin(body)
    } catch (e) {
      if (e instanceof RollbackSignal) return e.value as T
      throw e
    }
    throw new AppError({ code: 'rollback_escaped', message: 'withRollback committed — this should be unreachable.' })
  } finally {
    for (const g of guards) g.revoke()
  }
}

/**
 * One transaction, one role, GUCs set. Rolls back if `fn` throws, and cannot
 * outlive `fn` under any control flow — see the note above.
 */
export async function withSession<T>(ctx: SessionCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runTransaction(ctx, fn, true)
}

/**
 * Same, but rolls back unconditionally — §14.2's compute-before-commit. The
 * work really happened, was really measured, and is really gone.
 */
export async function withRollback<T>(ctx: SessionCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return runTransaction(ctx, fn, false)
}

function readonlyCtx(ctx: SessionCtx): SessionCtx {
  return {
    role: 'readonly',
    academyId: ctx.academyId,
    personId: 'personId' in ctx ? ctx.personId : '',
    contactId: 'contactId' in ctx ? ctx.contactId : '',
  }
}

function stripTrailingSemicolon(query: string): string {
  return query.trim().replace(/;\s*$/, '')
}

/**
 * Model-authored SELECT. cm_readonly, 5s statement timeout, 10 000 row cap.
 *
 * Errors are returned, not thrown: the model is the one who has to see the
 * message and fix its own SQL (§14.2). A thrown error here would surface as a
 * turn failure instead of a retry.
 */
export async function modelQuery(ctx: SessionCtx, query: string, note?: string): Promise<QueryResult> {
  const started = Date.now()
  /**
   * Every exit reports, including the two that never reach Postgres.
   *
   * A statement refused by `assertSingleReadStatement` is the one an instrument
   * most wants to see — it is a round the model spent and a shape it believed was
   * legal — and it produces no database error, no row, and nothing for a reader
   * to find. Routing all three exits through here is what makes the capture a
   * record of what the model ATTEMPTED rather than of what Postgres happened to
   * accept.
   */
  const report = (r: Omit<SqlRecord, 'kind' | 'sql' | 'role' | 'academyId' | 'personId' | 'ms' | 'note'>) =>
    recordSql(() => ({
      kind: 'read',
      // The model's own text, not `wrapped`. The row-cap envelope is the
      // runtime's sentence and reviewing the model on it would be reviewing the
      // wrong author.
      sql: query,
      role: 'readonly',
      academyId: ctx.academyId ?? null,
      personId: 'personId' in ctx ? (ctx.personId ?? null) : null,
      ms: Date.now() - started,
      ...(note ? { note } : {}),
      ...r,
    }))

  const fail = (error: string): QueryResult => {
    report({ rowCount: null, error })
    return { rows: [], rowCount: 0, truncated: false, ms: Date.now() - started, error }
  }

  try {
    assertSingleReadStatement(query)
  } catch (e) {
    return fail(errorMessage(e))
  }

  /**
   * The closing paren goes on its own LINE, and that is the whole point.
   *
   * Built on one line, a query ending in a `-- …` comment comments out the rest
   * of that line — which is `) _m limit 10001`, the row cap and the closing of
   * the wrapper. Postgres then answers `syntax error at end of input`, an error
   * about a statement the model did not write and cannot see, on a query that is
   * perfectly valid on its own. And the model DOES write trailing comments: the
   * SQL ladder caught it annotating a census query inline, explaining to itself
   * why two counts were named apart.
   *
   * A newline before the close ends the comment and costs nothing. The same
   * applies to the leading side, where a first-line comment would otherwise
   * swallow `select * from (`.
   */
  const wrapped = `select * from (\n${stripTrailingSemicolon(query)}\n) _m limit ${MODEL_ROW_CAP + 1}`

  try {
    const raw = await withSession(readonlyCtx(ctx), (tx) => unsafeQuery(tx, wrapped))
    const truncated = raw.length > MODEL_ROW_CAP
    const rows = (truncated ? raw.slice(0, MODEL_ROW_CAP) : raw).map((r) => ({ ...r }))
    report({ rowCount: rows.length, truncated, ...(sqlTraceRows() ? { rows } : {}) })
    return { rows, rowCount: rows.length, truncated, ms: Date.now() - started }
  } catch (e) {
    return fail(errorMessage(e))
  }
}

/**
 * Substrings that have no business in a model-authored statement: sleeping
 * holds a pooled connection, dblink and COPY leave the RLS boundary entirely,
 * pg_read* reads the filesystem.
 */
const FORBIDDEN_FRAGMENTS = ['pg_sleep', 'dblink', 'copy ', 'pg_read']

/**
 * The wall clock, refused where the sentence asking for it could not be enforced.
 *
 * @mechanism WALL_CLOCK — model-authored SQL is refused before it runs if it reads the host
 *   clock (`now()`, `current_date`, `clock_timestamp()`…), anchored to a word boundary so
 *   `app.now()` and `app.now_for()` still pass, and the refusal names the replacement because
 *   the sentence in it is the only feedback a pre-flight rejection gives. The rule was written
 *   in SCHEMA_DOC and nothing checked it, which is the worst shape a rule can have here: the
 *   clock is drivable, so `now()` raises nothing and silently answers with the host's time —
 *   confident rows about a different day in every driven world, with no error to mark it.
 *
 * SCHEMA_DOC has said **"Never call now(), current_date or current_timestamp.
 * Use app.now()"** for as long as it has existed, and nothing checked. That is
 * the worst shape a rule can have here: the clock is drivable, so `now()` is not
 * an error anywhere — it silently answers with the host's time, which is right
 * in production by coincidence and wrong in every driven world. A query using it
 * returns confident rows that are about a different day, and no error, no empty
 * result and no log line marks the moment it happened.
 *
 * `app.now()` and `app.now_for()` are the legitimate forms and both contain the
 * forbidden substring, so this cannot be a substring check like the ones above —
 * it is anchored to a word boundary and excludes anything qualified with `app.`.
 *
 * The refusal names the replacement, because the only feedback the model gets
 * from a pre-flight rejection is the sentence in it.
 */
const WALL_CLOCK = [
  { re: /(?<!app\s*\.\s*)\bnow\s*\(/, name: 'now()' },
  { re: /\bcurrent_date\b/, name: 'current_date' },
  { re: /\bcurrent_timestamp\b/, name: 'current_timestamp' },
  { re: /\blocaltimestamp\b/, name: 'localtimestamp' },
  { re: /\btransaction_timestamp\s*\(/, name: 'transaction_timestamp()' },
  { re: /\bstatement_timestamp\s*\(/, name: 'statement_timestamp()' },
  { re: /\bclock_timestamp\s*\(/, name: 'clock_timestamp()' },
]

/**
 * String literals and comments are data, not structure. A parent's note reading
 * "copy of the receipt", or a description containing a semicolon, must not look
 * like a second statement — so both are blanked before the checks below.
 */
function structureOnly(lowered: string): string {
  return lowered
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/**
 * @mechanism assertOneStatement — the pre-flight parse every model-authored statement passes,
 *   exported as `assertSingleReadStatement` for a read and `assertSingleWriteStatement` for a
 *   plan's write step. `structureOnly` blanks string literals and comments first, so a
 *   parent's note containing a semicolon is data rather than a second statement; then the
 *   fragments that leave the RLS boundary or hold a pooled connection (`dblink`, `copy `,
 *   `pg_read`, `pg_sleep`) are refused, anything after a `;` is refused, and the leading
 *   keyword must be one this caller allows. Every refusal is a sentence the model can act on,
 *   which is what makes a bad statement a retry rather than a turn failure.
 */
function assertOneStatement(query: string, allowed: readonly string[], label: string): void {
  const trimmed = String(query ?? '').trim()

  if (!trimmed) {
    throw new AppError({ code: 'empty_query', message: `Empty ${label} statement.` })
  }

  const lowered = structureOnly(trimmed.toLowerCase())

  for (const fragment of FORBIDDEN_FRAGMENTS) {
    if (lowered.includes(fragment)) {
      throw new AppError({
        code: 'forbidden_sql',
        message: `Query contains "${fragment.trim()}", which is not allowed in a ${label} statement.`,
      })
    }
  }

  for (const { re, name } of WALL_CLOCK) {
    if (re.test(lowered)) {
      throw new AppError({
        code: 'wall_clock_sql',
        message:
          `This ${label} statement calls ${name}, which reads the host clock. Use app.now() instead — ` +
          `it is the only clock this product has, and ${name} answers with a different time in every ` +
          `driven world without raising anything.`,
      })
    }
  }

  const semicolon = lowered.indexOf(';')
  if (semicolon !== -1 && lowered.slice(semicolon + 1).trim().length > 0) {
    throw new AppError({
      code: 'multiple_statements',
      message: `Exactly one ${label} statement is allowed; found a second after ";".`,
    })
  }

  const keyword = /^[\s(]*([a-z_]+)/.exec(lowered)?.[1]
  if (!keyword || !allowed.includes(keyword)) {
    throw new AppError({
      code: 'bad_statement_kind',
      message: `A ${label} statement must start with ${allowed.join(' or ')}; this one starts with "${keyword ?? '?'}".`,
    })
  }
}

/** Throws unless `query` is exactly one statement and starts with select/with. */
export function assertSingleReadStatement(query: string): void {
  assertOneStatement(query, ['select', 'with'], 'read')
}

/** Throws unless exactly one statement and it is insert/update/delete/select. */
export function assertSingleWriteStatement(query: string): void {
  // `with` is included because a data-modifying CTE is still one statement, and
  // it is how the model expresses "update these, return what changed".
  assertOneStatement(query, ['insert', 'update', 'delete', 'select', 'with'], 'write')
}

/** Closes the pool. Scripts only — the app never calls this. */
export async function closePool(): Promise<void> {
  const g = globalThis as PoolGlobal
  if (!g.__cm_sql) return
  await g.__cm_sql.end({ timeout: 5 })
  g.__cm_sql = undefined
}

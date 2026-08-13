/**
 * lib/db.ts — the only connection, and the only way to use it (CONTRACTS §2).
 *
 * Invariant §2.1 made mechanical. The pool connects as `cm_runtime`, which has
 * no table privileges at all. Every query therefore runs inside a transaction
 * that first `SET LOCAL ROLE`s to one of exactly three roles and sets the GUCs
 * the RLS policies read. There is no way to touch a row without declaring who
 * you are, because there is no path that skips `withSession`.
 *
 * Two details that matter more than they look:
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
 */

import postgres from 'postgres'

import { env } from '@/lib/env'
import { AppError, errorMessage } from '@/lib/errors'

export type Tx = postgres.TransactionSql<{}>

export type SessionCtx =
  | { role: 'service'; academyId: string; turnId?: string }
  | { role: 'user'; academyId: string; personId: string; contactId: string; turnId?: string }
  | { role: 'readonly'; academyId: string; personId: string; contactId: string; turnId?: string }

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
const MODEL_TIMEOUT_MS = 5_000
const USER_TIMEOUT_MS = 15_000

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
    max: 10,
    // Supabase's transaction pooler cannot carry prepared statements.
    prepare: false,
    transform: undefined,
    idle_timeout: 20,
    connect_timeout: 15,
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

/** Raw handle. Only lib/db.ts, lib/clock.ts and migrations may use it. */
export const sql: postgres.Sql<{}> = ((): postgres.Sql<{}> => {
  const g = globalThis as PoolGlobal
  if (!g.__cm_sql) g.__cm_sql = createPool()
  return g.__cm_sql
})()

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
            ${guc('app.academy_id', ctx.academyId)},
            ${guc('app.person_id', personId)},
            ${guc('app.contact_id', contactId)},
            -- Read by app.begin_audit, so every write in this transaction is
            -- attributable to the turn that caused it (0015). Empty outside a turn.
            ${guc('app.turn_id', ctx.turnId)}`,
  )
}

/**
 * One transaction, one role, GUCs set. Rolls back if `fn` throws.
 */
export async function withSession<T>(ctx: SessionCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const out = await sql.begin(async (tx) => {
    const t = tx as unknown as Tx
    await applySession(t, ctx)
    const value = await fn(t)
    // Wrapped so postgres.js's UnwrapPromiseArray never unwraps an array result.
    return { value } as unknown
  })
  return (out as { value: T }).value
}

/** Private sentinel. Never escapes this module. */
class RollbackSignal<T> extends Error {
  constructor(readonly value: T) {
    super('rollback')
    this.name = 'RollbackSignal'
  }
}

/**
 * Same, but rolls back unconditionally — §14.2's compute-before-commit. The
 * work really happened, was really measured, and is really gone.
 */
export async function withRollback<T>(ctx: SessionCtx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    await sql.begin(async (tx) => {
      const t = tx as unknown as Tx
      await applySession(t, ctx)
      const value = await fn(t)
      throw new RollbackSignal(value)
    })
  } catch (e) {
    if (e instanceof RollbackSignal) return e.value as T
    throw e
  }
  throw new AppError({ code: 'rollback_escaped', message: 'withRollback committed — this should be unreachable.' })
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
export async function modelQuery(ctx: SessionCtx, query: string): Promise<QueryResult> {
  const started = Date.now()
  const fail = (error: string): QueryResult => ({ rows: [], rowCount: 0, truncated: false, ms: Date.now() - started, error })

  try {
    assertSingleReadStatement(query)
  } catch (e) {
    return fail(errorMessage(e))
  }

  const wrapped = `select * from ( ${stripTrailingSemicolon(query)} ) _m limit ${MODEL_ROW_CAP + 1}`

  try {
    const raw = await withSession(readonlyCtx(ctx), (tx) => unsafeQuery(tx, wrapped))
    const truncated = raw.length > MODEL_ROW_CAP
    const rows = (truncated ? raw.slice(0, MODEL_ROW_CAP) : raw).map((r) => ({ ...r }))
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

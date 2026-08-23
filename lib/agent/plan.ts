/**
 * lib/agent/plan.ts — `transaction(steps[])`, the runtime that makes
 * model-composed atomicity safe (§14.2, §14.2.1, §2.3, §2.5).
 *
 * @mechanism executePlan — every plan runs as one transaction: the steps execute, the diff
 *   is read back before commit, and messages are STAGED in an outbox that only flushes to
 *   the wire once the commit lands. A rolled-back plan has therefore messaged nobody and
 *   changed nothing, which is the property hand-written operations get wrong most often —
 *   a half-done change followed by a confident WhatsApp message is not a shape this runtime
 *   can produce. Whatever composed the steps, a named operation or the model's own SQL, gets
 *   the same atomicity, the same RLS and one audit entry carrying the intent; `previewPlan`
 *   is the identical run with the rollback guaranteed.
 *
 * The whole point: the model composes the steps, the RUNTIME guarantees the
 * properties. For every plan, whatever its steps:
 *
 *   - Atomicity. All steps commit or none do.
 *   - One diff, computed before commit — the blast radius of the whole plan.
 *   - Messages are STAGED, not sent, until commit. A rolled-back transaction
 *     has messaged nobody. This is the property hand-written operations get
 *     wrong most often, which is exactly why it lives here and not in each
 *     operation.
 *   - RLS applies to every step, so a plan cannot reach past what its author
 *     could have done by hand.
 *   - The whole plan is one audit entry, carrying the intent that produced it.
 */

import {
  assertSingleWriteStatement,
  serviceFrom,
  withRollback,
  withSession,
  type SessionCtx,
  type Tx,
} from '@/lib/db'
import { recordSql } from '@/lib/agent/sql-trace'
import { idem, newId } from '@/lib/ids'
import { now } from '@/lib/clock'
import { adminContactIds, resolveIdentity } from '@/lib/identity'
import { attachActionsToMessage, mintAction, type ActionPayload } from '@/lib/actions'
import { send } from '@/lib/messaging/send'
import { composeAndSend } from '@/lib/messaging/compose'
import { LIMITS, type Button, type OutboundMessage, type SendOutcome } from '@/lib/messaging/types'
import { CATALOG, type CatalogId } from '@/lib/messaging/catalog'
import { isJobKind, JOB_KINDS, type JobKind } from '@/lib/jobs'
import type { Academy, Contact, Identity, Person, Role } from '@/lib/types'
import { beginAudit, readDiffIn } from '@/lib/audit'
import { OPERATIONS, jsonLit, lit, moneyLit, uid, type OperationName } from './operations'
import { coachClashes } from './clash'
import { untoldAudience } from './untold'
import { parseSteps as parseStepsShared } from './steps'

/* ------------------------------------------------------------------------- *
 * Steps
 * ------------------------------------------------------------------------- */

export type MessageButton = { title: string; action: ActionPayload; ttl_minutes?: number }

export type MessageStep = {
  to_contact_id?: string
  to_person_id?: string
  body: string
  buttons?: MessageButton[]
  catalog_id?: CatalogId | null
  fixed?: boolean
  subject_person_ids?: string[]
  header?: string
  footer?: string
  is_confirmation_request?: boolean
  is_escalation?: boolean
  pre_launch_ok?: boolean
  /**
   * RUNTIME-INTERNAL. The acknowledgement of an opt-out, and the one message the
   * opt-out gate lets past.
   *
   * Driven: the person taps `[Yes, stop them]`, the plan writes `opted_out_at` and
   * then stages *"Done — no more messages from X. Message me any time to turn them
   * back on."* — and gate 1 suppresses it as `opted_out`, because the write it is
   * acknowledging landed first in the same transaction. So the last thing somebody
   * who left ever sees is the question, and they have no way to know it worked or
   * that coming back is possible.
   *
   * Not a hole in the gate. A STOP confirmation is the one message a person who has
   * just asked to be left alone is unambiguously asking for, it is what the platform
   * itself expects, and it is the only place the way back is written down. Stripped
   * from model-authored plans like the other runtime-internal fields, so nothing but
   * `opt_out` can set it.
   */
  opt_out_ack?: boolean
  /**
   * RUNTIME-INTERNAL. What question this message puts on somebody's screen, so
   * `send` can record it as outstanding from the moment it lands (0032).
   *
   * `is_confirmation_request` above says a question was asked; this says what it
   * was ABOUT, which is what a later turn needs and what makes a second ask on
   * the same subject supersede rather than accumulate. `send` derives one when a
   * protocol does not supply it, so the row exists either way — but a protocol
   * that knows its own subject should say so, because "the money mute" is a
   * better key than a list of person ids.
   *
   * Stripped from model-authored plans like the other runtime-internal fields:
   * a forged pending request is a question nobody asked, sitting in somebody
   * else's tail.
   */
  confirmation?: { kind: string; subject: string; question?: string }
  /**
   * RUNTIME-INTERNAL, set by `expand` on steps an operation produced. It is what
   * lets `resolveContact` address the owner from a parent's turn — see the long
   * note there. `PlanStepSchema` strips unknown keys, so a model-authored plan
   * cannot set it and cannot borrow the reach.
   */
  fromOperation?: boolean
}

/**
 * A step is a write, a message, an adjustment, a scheduled task, or a named
 * operation (§14.2.1).
 *
 * Three fields here are RUNTIME-INTERNAL and are not part of the model-facing
 * schema — `PlanStepSchema` below silently strips them, so a model-authored
 * plan can never set them:
 *   - `write.service`     — run this statement as cm_service. `job`,
 *                           `audit_entry`, `memory_fact` and `recipe` are
 *                           infrastructure with no cm_user policy at all
 *                           (§6.7), so an operation touching them has to say
 *                           so. Letting the model set this would be privilege
 *                           escalation, which is why it is stripped.
 *   - `write.requireRows` — abort (and therefore roll back, and therefore
 *                           message nobody) unless the statement affected at
 *                           least this many rows. This is how `claim_cover`
 *                           gets first-tap-wins out of the database rather
 *                           than out of the model's memory.
 *   - `write.guard`       — this statement asks a question rather than making a change, so
 *                           `assertSomethingChanged` must not count it among the writes a
 *                           plan claimed to make. Without it a plan of one guard plus
 *                           messages aborts as CHANGED_NOTHING — the guard is a `write`
 *                           step by shape and a read by intent, and only the author knows
 *                           which. Operation-authored only, like `because` beside it.
 *   - `write.because`     — the sentence a `requireRows` abort should say. Without it
 *                           the reader gets "a step needed 1 row(s) and matched 0",
 *                           which names the shape of the failure and not the failure.
 *                           Operation-authored only: the model's `PlanStepSchema`
 *                           allows `write` alone and zod strips the rest, so this
 *                           cannot be set from a payload.
 *   - `note`              — a summary fragment. Executes nothing; it is how an
 *                           operation contributes "all of Saturday Advanced,
 *                           moving to 8:30" to the §14.2 sentence.
 */
export type PlanStep =
  | { write: string; service?: boolean; requireRows?: number; because?: string; guard?: boolean }
  | { operation: { name: OperationName; args: Record<string, unknown> } }
  | {
      adjust: {
        account_id: string
        player_id?: string | null
        amount: number
        reason: string
        period?: string
        description?: string
      }
    }
  | { message: MessageStep }
  | { schedule: { kind: JobKind; run_at: string; dedupe_key: string; payload: Record<string, unknown> } }
  /**
   * The one part of a plan written in the business's own words, and for a
   * `personal` audience it becomes the WHOLE receipt — `buildSummary` drops the row
   * arithmetic and says `Done — <note>.`
   *
   * That is why `personal` exists beside it. Every note in the registry is written
   * about a third party, because operations are normally described TO an operator:
   * `onboard_coach` says "they are set up and will get their day from now on". Send
   * that to the coach who just tapped `[Looks right]` and the last message of their
   * onboarding talks about them as if they were not there — *"Done — they are set up"*.
   * Driven, on a real coach's first run.
   *
   * So an operation whose subject can BE the recipient carries both voices. Optional
   * on purpose: most operations can only ever be described to an operator, and
   * forcing a second string on those would be noise that rots.
   */
  | { note: string; personal?: string }

export type TableDiff = {
  table: string
  op: 'insert' | 'update' | 'delete'
  count: number
  before: any[]
  after: any[]
}

export type PlanResult = {
  ok: boolean
  diffs: TableDiff[]
  totalRows: number
  /**
   * `preview` is clipped to 160 characters and carries the button titles — it is
   * what the MODEL reads in `compactDiff`, where a plan staging eight messages
   * would otherwise spend a thousand tokens quoting itself. `body` is the message,
   * whole.
   *
   * Both, because the two readers want different things and the clipped one used
   * to be all there was. `writeTurn` records what a turn said, and on the tap path
   * the only thing it could reach for was `buildSummary`'s receipt — a sentence
   * composed for a person who, whenever the plan spoke for itself, never received
   * it. So the `turn` row held a message nobody was sent, and every instrument that
   * reads a run back was reading it.
   */
  stagedMessages: { toContactId: string; preview: string; body: string }[]
  scheduled: { kind: string; run_at: string }[]
  summary: string
  /**
   * What this plan put in two places at once (`./clash`). Also in `summary`,
   * because it is one of the plan's notes; kept separately because
   * `needsPreview` decides on it and the model is better served by the facts
   * than by the sentence they were folded into.
   */
  clashes: string[]
  /**
   * Whose arrangements this plan changed while staging nothing to them
   * (`./untold`). Same shape and the same reasoning as `clashes`: it is a plan
   * note, so it rides the summary, and it is here separately so the model reads
   * a fact rather than parsing one back out of a sentence.
   */
  untold: string[]
  /**
   * Steps that ran and matched no rows, each named by what it was trying to do.
   * A diagnostic that names its subject, or nothing — the count that used to
   * stand here cost a round of guessing and reached a prospect verbatim.
   */
  emptyWrites: string[]
  /** Messages this plan staged that resolved to nobody at all. */
  unaddressed: number
  error?: string
}

/** Thrown by a `requireRows` guard. Rolls the plan back; nobody is messaged. */
export class PlanAbort extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'PlanAbort'
    this.code = code
  }
}

/* ------------------------------------------------------------------------- *
 * Model-facing validation lives in `./steps`, shared with the mint path, so
 * that a button and a plan cannot disagree about what a step is. The internal
 * fields documented above cannot be smuggled in: zod's object parser drops
 * keys it does not know about.
 * ------------------------------------------------------------------------- */

export { PlanStepSchema } from './steps'

/** Validate model-authored steps. Throws on anything that is not a step. */
export function parseSteps(raw: unknown): PlanStep[] {
  return parseStepsShared(raw) as PlanStep[]
}

/* ------------------------------------------------------------------------- *
 * Audit. `lib/audit.ts` owns the audit entry and the row_snapshot trigger that
 * gives us before-images; we only drive it. It is called under cm_service
 * because audit_entry and row_snapshot are infrastructure (§6.7) — a cm_user
 * session has no policy on either, so reading the diff as the user would
 * silently return nothing.
 * ------------------------------------------------------------------------- */

const ROLE_NAME: Record<SessionCtx['role'], string> = {
  service: 'cm_service',
  user: 'cm_user',
  readonly: 'cm_readonly',
}

async function asService<T>(tx: Tx, ctx: SessionCtx, fn: () => Promise<T>): Promise<T> {
  if (ctx.role === 'service') return fn()
  await tx.unsafe('set local role cm_service')
  try {
    return await fn()
  } finally {
    await tx.unsafe(`set local role ${ROLE_NAME[ctx.role]}`)
  }
}

function rowCount(res: unknown): number {
  const r = res as { count?: number; length?: number }
  if (r && typeof r.count === 'number') return r.count
  if (Array.isArray(res)) return res.length
  return 0
}

/* ------------------------------------------------------------------------- *
 * Identity for a session. Operations build against a person, not a role name.
 * ------------------------------------------------------------------------- */

/**
 * **Not cached, and the cache is what was wrong with it.**
 *
 * This memoised the whole `Identity` per academy in a module-level Map with no
 * invalidation, in a process that outlives any number of writes. Two of the
 * fields it froze are the two that move:
 *
 *   `isSolo`  — `lib/jobs/util.ts` computes the same value and says of it, in as
 *               many words, *"Never cached."* Adding the second coach to a solo
 *               academy is the single most consequential shape change in §18, and
 *               a long-lived worker went on believing there was nobody to escalate
 *               to. Two modules disagreeing about one derived value is the exact
 *               "two rules about one thing" failure this codebase is built to
 *               avoid — and here it was inside the codebase.
 *   `person` / `contact` — the admin borrowed for attribution. Change who the
 *               first admin is and every subsequent job attributes to the old one.
 *
 * What the removal costs: one session and four statements per service-role plan
 * that contains an `operation` step. That is jobs, which run sequentially and
 * already open a session per handler, so it is a round trip nobody is waiting on.
 * A correct answer that costs a query beats a stale one that is free.
 */
export async function identityFor(ctx: SessionCtx): Promise<Identity> {
  if (ctx.role !== 'service') {
    const id = await resolveIdentity(ctx.contactId)
    if (!id) throw new Error('plan: could not resolve the identity for this session')
    return id
  }
  // A service session acts for the academy itself. Borrow the admin's shape so
  // operations have a person to attribute to; roles are ['admin'] because
  // cm_service is academy-wide by policy.
  const built = await withSession(ctx, async (tx) => {
    const [academy] = (await tx.unsafe(
      `select * from academy where id = ${uid(ctx.academyId)}`,
    )) as unknown as Academy[]
    const [person] = (await tx.unsafe(
      `select p.* from person p join academy_admin aa on aa.person_id = p.id
       where p.academy_id = ${uid(ctx.academyId)} order by aa.created_at limit 1`,
    )) as unknown as Person[]
    const [contact] = person
      ? ((await tx.unsafe(
          `select * from contact where academy_id = ${uid(ctx.academyId)}
             and person_id = ${uid(person.id)}
           order by is_primary desc, created_at limit 1`,
        )) as unknown as Contact[])
      : []
    const [solo] = (await tx.unsafe(
      `select count(*) filter (where c.status = 'active') as active_coaches,
              count(*) filter (where c.status = 'active' and exists (
                select 1 from academy_admin aa where aa.person_id = c.person_id
                  and aa.academy_id = c.academy_id)) as admin_coaches
         from coach c where c.academy_id = ${uid(ctx.academyId)}`,
    )) as unknown as { active_coaches: string; admin_coaches: string }[]
    const identity: Identity = {
      academyId: ctx.academyId,
      academy,
      contact: contact as Contact,
      person: person as Person,
      roles: ['admin'] as Role[],
      coachId: null,
      accountIds: [],
      playerIds: [],
      isSolo: Number(solo?.active_coaches ?? 0) === 1 && Number(solo?.admin_coaches ?? 0) === 1,
      seesMoney: true,
    }
    return identity
  })
  return built
}

/* ------------------------------------------------------------------------- *
 * Expansion. Named operations BUILD steps; they never write directly, so the
 * same machinery and the same guarantees cover them (§14.2.1). Expansion
 * happens before the transaction opens, because `build` reads through the
 * caller's own session.
 * ------------------------------------------------------------------------- */

/**
 * An id argument names a row that exists, or the operation does not run.
 *
 * @mechanism assertIdsExist — every id-shaped argument to an operation is read back before
 *   the transaction opens, against the table its NAME implies (`coach_id` is a coach), under
 *   the caller's own session — and at any depth, so `mark_attendance`'s `entries[].player_id`
 *   is checked exactly like its top-level `session_id`. A well-formed uuid that matches no row
 *   is indistinguishable everywhere downstream from one that does, so without this the
 *   operation looks it up, finds nothing, falls back to its placeholder and returns `ok: true`
 *   — an invite addressed to "Hi them" and a coach whose status never moved. One chokepoint
 *   rather than a check per operation, and running under the caller's session makes "no such
 *   row" and "not yours to see" the same answer, which is the answer RLS is entitled to give.
 *
 * The invented uuid is the oldest failure in this product and the one that reads most
 * like success. Watched live, minutes after it was supposedly fixed: the admin tapped
 * `[Send the invite]`, the model re-derived the coach id rather than being handed it,
 * produced `ae9f36b1-…` — a well-formed uuid matching nothing — and `send_invite_draft`
 * looked it up, found nothing, fell back to its placeholder and returned `ok: true`. The
 * admin was shown an invite addressed to **"Hi them"**, and the coach's status was never
 * moved to `invited`. Nothing failed. Nothing was logged. A well-formed uuid that matches
 * no row is indistinguishable, everywhere downstream, from one that does.
 *
 * Each operation could check its own ids, and several do. That is the shape FINDINGS
 * calls a call site rather than a chokepoint: it has to be right twenty-five times and
 * once more for every operation anybody adds. **The argument's name already says which
 * table it belongs to** — `coach_id` is a coach — so one check covers the registry as it
 * is and as it will be.
 *
 * It runs under the caller's own session, so "no such row" and "not yours to see" are
 * the same answer, which is the answer RLS is entitled to give. And it is a read, before
 * the transaction opens, so it costs nothing when it passes.
 *
 * **It walks the whole argument, because the top level is not where the ids are.** The
 * first version read `Object.entries(args)` once and stopped. That covers every operation
 * whose ids are scalars and none of the ones that carry a list of them, and the shape that
 * got through is the register: `mark_attendance` takes `{ session_id, entries: [{ player_id,
 * status }] }`, so the session was read back and the players never were. Day 24 of the month
 * drive, the model passed two PERSON ids as `player_id`s — the two humans exist, their player
 * rows have different ids — and Postgres answered `attendance_player_id_fkey`, which names a
 * constraint and no repair. The sentence this guard throws IS the repair, verbatim: *"read it
 * back first — select pl.id, p.full_name from player pl join person p on p.id = pl.person_id"*.
 * It simply never got asked.
 *
 * So the walk descends arrays and objects and matches `ID_ARG_TABLES` on the LEAF key name,
 * which is where the argument's name-is-its-table rule actually holds — `entries` says nothing
 * about a table, `player_id` says everything. An array does not rename what is inside it, so
 * `player_id: [a, b]` and `entries: [{ player_id }]` are the same walk. Bounded two ways
 * (`ID_ARG_MAX_DEPTH`, `ID_ARG_MAX_CHECKS`), because an operation's arguments are a schema and
 * not a graph, and a pre-flight read that runs before every plan must never be the thing that
 * hangs one. Bounded a third way in cost: one `in (…)` per TABLE rather than one statement per
 * id, since a register for twenty players would otherwise be twenty round trips in front of a
 * coach who is waiting.
 */
const ID_ARG_TABLES: Record<string, string> = {
  academy_id: 'academy',
  account_id: 'account',
  class_id: 'class',
  coach_id: 'coach',
  enrollment_id: 'enrollment',
  payment_id: 'payment',
  person_id: 'person',
  player_id: 'player',
  session_id: 'session',
  venue_id: 'venue',
  contact_id: 'contact',
  audit_id: 'audit_entry',
}

/**
 * How deep into an operation's arguments the walk goes. An operation's params are a zod
 * object, so the real shapes bottom out at two or three — this is the guard against a
 * cyclic or absurd argument turning a pre-flight read into a hang, not a real limit.
 */
const ID_ARG_MAX_DEPTH = 8

/** And how many distinct id positions one operation may make it look at. */
const ID_ARG_MAX_CHECKS = 250

/** One id-shaped argument, and the path that says WHERE in the argument it was found. */
type IdCheck = { path: string; table: string; value: string }

/**
 * Every id-shaped leaf in an operation's arguments, at any depth.
 *
 * `key` is the name the leaf was reached under and `path` is the whole route to it —
 * `entries[3].player_id` rather than `player_id`, because "which one" is the first thing
 * anybody reading the refusal has to know when the register is twenty lines long.
 */
function collectIdArgs(node: unknown, key: string, path: string, depth: number, out: IdCheck[]): void {
  if (out.length >= ID_ARG_MAX_CHECKS || depth > ID_ARG_MAX_DEPTH) return
  if (Array.isArray(node)) {
    // An array does not rename what is inside it: `player_id: [a, b]` keeps the key, and
    // `entries: [{ player_id }]` finds its own on the way down.
    for (let i = 0; i < node.length; i++) collectIdArgs(node[i], key, `${path}[${i}]`, depth + 1, out)
    return
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectIdArgs(v, k, path ? `${path}.${k}` : k, depth + 1, out)
    }
    return
  }
  const table = ID_ARG_TABLES[key]
  if (!table) return
  // A subquery resolves inside the transaction against rows an earlier step made,
  // so there is nothing here to check yet — the plan itself is the check.
  if (typeof node !== 'string' || !UUID_ARG_RE.test(node)) return
  out.push({ path, table, value: node })
}

/** The read that hands the model the id it should have used, per table. */
function readBackFor(table: string): string {
  if (table === 'coach') return 'select c.id, p.full_name from coach c join person p on p.id = c.person_id'
  if (table === 'player') return 'select pl.id, p.full_name from player pl join person p on p.id = pl.person_id'
  return `select id, name from ${table}`
}

async function assertIdsExist(ctx: SessionCtx, operation: string, args: unknown): Promise<void> {
  if (!args || typeof args !== 'object') return
  const checks: IdCheck[] = []
  collectIdArgs(args, '', '', 0, checks)
  if (!checks.length) return

  // Grouped by table and asked once each. The same id can appear at several paths — a
  // player who is also being marked timely — and the database only needs telling once.
  const wanted = new Map<string, Set<string>>()
  for (const c of checks) {
    const set = wanted.get(c.table) ?? new Set<string>()
    set.add(c.value.toLowerCase())
    wanted.set(c.table, set)
  }

  const present = new Map<string, Set<string>>()
  await withSession(ctx, async (tx) => {
    for (const [table, ids] of wanted) {
      const rows = (await tx.unsafe(
        `select id from ${table} where id in (${[...ids].map((v) => uid(v)).join(', ')})`,
      )) as unknown as { id: string }[]
      present.set(table, new Set(rows.map((r) => String(r.id).toLowerCase())))
    }
  })

  const missing = checks.filter((c) => !present.get(c.table)?.has(c.value.toLowerCase()))
  if (!missing.length) return

  // One sentence per id that is actually absent, not per position it appears in, and
  // clipped: a register whose whole roster is wrong should say so in a line the model
  // can act on, not in forty of them.
  const seen = new Set<string>()
  const said: string[] = []
  for (const c of missing) {
    const k = `${c.table}|${c.value.toLowerCase()}`
    if (seen.has(k)) continue
    seen.add(k)
    if (said.length < 8) said.push(`${c.path} ${c.value} is not a ${c.table} you can see`)
  }
  const more = seen.size - said.length

  // The query that answers it, named. Without this the model's next move — watched —
  // was to ask the admin to "confirm Ravi Menon's coach ID", which is a uuid, in a
  // WhatsApp message, to somebody who has never seen one.
  const reads = [...new Set(missing.map((c) => c.table))].map(readBackFor)
  throw new Error(
    `${operation}: ${said.join('; ')}${more > 0 ? ` (and ${more} more)` : ''}. Read it back first — ` +
      `${reads.join(' · ')} — and use the id that comes out. Never a uuid you have not read, and never ask a ` +
      'person for one. If you meant a row an earlier step in this same plan creates, write it as ' +
      '`(select id from … )` instead.',
  )
}

const UUID_ARG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A step in one short phrase, for a refusal that has to name the steps it took with it. */
function describeStep(step: PlanStep): string {
  if ('operation' in step) return `operation ${step.operation.name}`
  if ('write' in step) {
    const t = tableOf(step.write)
    return t ? `${t.op} on ${t.table}` : `write ${step.write.replace(/\s+/g, ' ').trim().slice(0, 60)}`
  }
  if ('adjust' in step) {
    // Rupees, because everything about money in this product is rupees, and a bare
    // number in a sentence the model re-plans from is a number without a currency.
    const a = step.adjust
    return `${a.amount < 0 ? 'credit' : 'charge'} of ₹${Math.abs(a.amount)}`
  }
  if ('message' in step) {
    return `message to ${step.message.to_contact_id ?? step.message.to_person_id ?? 'nobody'}`
  }
  if ('schedule' in step) return `schedule ${step.schedule.kind} for ${step.schedule.run_at}`
  return 'note'
}

/**
 * The one shape in which a later step can depend on an earlier one, and the repo already
 * names it: `assertIdsExist` tells the model that a row an earlier step in the same plan
 * creates must be written `(select id from … )`. Ids are otherwise passed in as arguments,
 * which means they were read before the plan was composed and no step made them.
 */
const REFERS_TO_EARLIER_ROW = /\(\s*select\b/i

function refersToEarlierRow(step: PlanStep): boolean {
  if ('write' in step) return REFERS_TO_EARLIER_ROW.test(step.write)
  if ('operation' in step) return REFERS_TO_EARLIER_ROW.test(JSON.stringify(step.operation.args ?? {}))
  if ('schedule' in step) return REFERS_TO_EARLIER_ROW.test(JSON.stringify(step.schedule.payload ?? {}))
  return false
}

/**
 * Which of the plan's other steps this refusal actually took with it, and which it merely
 * cancelled.
 *
 * Conservative in the one direction that matters: "would have run" is a claim the model
 * will act on by re-sending the step, so anything the runtime cannot be sure about is
 * reported as blocked instead. Two things are not sure — another call to the SAME operation
 * (it meets the same gate and gets the same answer), and a later step written as
 * `(select …)`, which is by construction a reference to a row an earlier step was going to
 * make and might have been this one.
 */
function partitionAround(
  steps: PlanStep[],
  refusedIndex: number,
  refusedOp: string,
): { independent: string[]; blocked: string[] } {
  const independent: string[] = []
  const blocked: string[] = []
  for (let i = 0; i < steps.length; i++) {
    if (i === refusedIndex) continue
    const step = steps[i] as PlanStep
    const label = `step ${i + 1} (${describeStep(step)})`
    // Only steps AFTER the refusal can "meet the same gate": expansion is
    // sequential, so a same-operation step before the refused one already PASSED
    // its own gate — the gates are argument-dependent, and telling the model not
    // to re-send a step the runtime just validated steers it away from the half
    // that works (two send_invites where only the second is bad).
    const sameGate = i > refusedIndex && 'operation' in step && step.operation.name === refusedOp
    if (sameGate || (i > refusedIndex && refersToEarlierRow(step))) blocked.push(label)
    else independent.push(label)
  }
  return { independent, blocked }
}

/**
 * Long enough for the longest refusal any gate actually writes — `assertIdsExist`'s repair
 * sentence names eight ids and the query that reads them back, and truncating THAT would
 * reintroduce the defect one layer along. Short enough that a zod dump of a mis-shaped
 * argument, which is JSON and can run to pages, does not become the turn's context.
 */
const REFUSAL_CHARS = 1200

function renderRefusal(p: {
  stepIndex: number
  total: number
  operation: string
  refusal: string
  independent: string[]
  blocked: string[]
}): string {
  const said = p.refusal.length > REFUSAL_CHARS ? `${p.refusal.slice(0, REFUSAL_CHARS)}…` : p.refusal
  const parts = [
    `step ${p.stepIndex + 1} of ${p.total} (operation ${p.operation}) refused: ${said}`,
    'Nothing was written and no other step was even attempted — an operation is built before the transaction ' +
      'opens, so this is a rejection of the plan, not a rollback of it. The rest of the work is still to do.',
  ]
  parts.push(
    p.independent.length
      ? `These did not depend on it and would have run: ${p.independent.join('; ')}. Send them again as a plan ` +
          `without step ${p.stepIndex + 1}, and drop only the ones that made sense solely because of it.`
      : 'No other step in the plan was independent of it.',
  )
  if (p.blocked.length) {
    parts.push(
      `Do not simply re-send these as they stand: ${p.blocked.join('; ')} — they either meet the same gate or ` +
        'refer to a row an earlier step in this plan was going to make.',
    )
  }
  return parts.join(' ')
}

/**
 * What a plan lost when one step's own gate refused it, itemised.
 *
 * @mechanism StepRefused — an operation's gate throwing during expansion is reported as an
 *   itemised rejection — which step of how many, which operation, what it actually said, and
 *   which of the plan's other steps did not depend on it and would have run — instead of the
 *   bare `e.message` that named none of those. Expansion runs OUTSIDE the transaction, before
 *   `withRollback`/`withSession` open, so nothing was written and no sibling step was even
 *   attempted: "a plan is one transaction" is not what costs the surviving steps, the
 *   reporting is, and a model that cannot see which step blocked cannot re-stage the work it
 *   was always allowed to do.
 *
 * **The atomicity argument does not apply here, and it was quietly doing all the work.** A
 * refusal inside `runSteps` is a rollback: statements ran, rows moved, and taking the whole
 * plan back is the guarantee this file exists to provide. A refusal inside `expand` is not
 * that. `expand` is called on the line ABOVE `withRollback` in `previewPlan` and above
 * `withSession` in `executePlan`. When `send_invite`'s gate throws — *"nothing reaches a
 * family until this academy is live, and it is 'setup'"* — no transaction has opened, no
 * statement has run, and the other steps have not been looked at. They are lost to
 * compilation, not to consistency.
 *
 * **What that cost, in one business.** Day 24 of the month drive, turn 165: the owner's plan
 * was two `send_invite`s, three `mark_attendance`s and a coach pay line. The invite gate
 * threw and took the coach's pay and three registers with it. The model was handed one
 * sentence with no step in it, so it could not tell the owner which half had failed, and it
 * could not re-send the half that was fine. It happened again on 25 and again on 26, and at
 * turn 182 it apologised with a confident, wrong root cause covering all three. The owner
 * left: *"this hasnt worked three times now and arjun still hasnt been paid. forget it im
 * calling him myself and sorting this on paper."*
 *
 * **This does not make a plan partially execute, and it must not.** Deciding which steps to
 * keep is the author's call, not the runtime's — the runtime cannot know that the message
 * announcing the invite is a lie once the invite is gone. So it states the facts it holds
 * with certainty and hands the re-staging back to the model, which is the layer that knows
 * what the plan meant.
 *
 * The itemisation lives in the Error's own `message` rather than only in `failed()`, because
 * a bare `e.message` is exactly how this failure was reported — anything that logs the throw,
 * anywhere, gets the whole account rather than the first clause of it.
 */
export class StepRefused extends Error {
  readonly code = 'STEP_REFUSED'
  /** Zero-based into the plan's own step array; rendered one-based, the way a person counts. */
  readonly stepIndex: number
  readonly operation: OperationName
  /** What the gate said, on its own, unwrapped. */
  readonly refusal: string
  readonly independent: string[]
  readonly blocked: string[]

  constructor(p: {
    stepIndex: number
    total: number
    operation: OperationName
    refusal: string
    independent: string[]
    blocked: string[]
  }) {
    super(renderRefusal(p))
    this.name = 'StepRefused'
    this.stepIndex = p.stepIndex
    this.operation = p.operation
    this.refusal = p.refusal
    this.independent = p.independent
    this.blocked = p.blocked
  }
}

async function expand(
  ctx: SessionCtx,
  steps: PlanStep[],
  depth: number,
  identity?: Identity,
): Promise<PlanStep[]> {
  const out: PlanStep[] = []
  let id = identity
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index] as PlanStep
    if ('operation' in step) {
      if (depth >= 4) throw new Error('plan: operations nested too deep')
      const def = OPERATIONS[step.operation.name]
      if (!def) throw new Error(`plan: unknown operation "${step.operation.name}"`)
      id ??= await identityFor(ctx)
      let produced: PlanStep[]
      /**
       * The whole expansion of ONE step is inside the try, not just `def.build`: a
       * zod refusal of the arguments, an `assertIdsExist` miss and a gate the
       * operation enforces itself are the same event from the plan's side — this
       * step could not be compiled, and every other step is collateral. A nested
       * operation refusing is the same event too, one level down, which is why the
       * recursive call is in here with the rest.
       */
      try {
        const args = def.params.parse(step.operation.args ?? {})
        await assertIdsExist(ctx, step.operation.name, args)
        const built = await def.build(ctx, args, id)
        produced = await expand(ctx, built, depth + 1, id)
      } catch (e) {
        /**
         * Only the plan's own level can name the steps that were lost, so a nested
         * frame rethrows untouched and lets `depth === 0` do the accounting — the
         * index it holds is into the OPERATION's built steps, which the model never
         * wrote and cannot re-stage. The inner refusal survives as the message.
         *
         * A `PlanAbort` passes straight through in either case: `hintFor` keys off
         * its `code` to buy the service-role re-run that says which kind of nothing
         * happened, and wrapping it would spend that diagnosis to gain a step number.
         */
        if (depth > 0 || e instanceof PlanAbort) throw e
        const around = partitionAround(steps, index, step.operation.name)
        throw new StepRefused({
          stepIndex: index,
          total: steps.length,
          operation: step.operation.name,
          refusal: e instanceof Error ? e.message : String(e),
          independent: around.independent,
          blocked: around.blocked,
        })
      }
      /**
       * Steps an OPERATION produced are the runtime's own intent, and are marked
       * so `resolveContact` may address them to somebody the caller cannot see.
       * See the comment there — "the admin is told" is a decision the product
       * made, not a row the parent is allowed to read.
       *
       * Marked here rather than trusted by shape, because after expansion an
       * operation's message step and a model-authored one are the same object.
       * `PlanStepSchema` strips unknown keys from anything the model writes, so
       * this flag cannot be smuggled in from a plan.
       */
      out.push(
        ...produced.map((s) => ('message' in s ? { ...s, message: { ...s.message, fromOperation: true } } : s)),
      )
    } else {
      out.push(step)
    }
  }
  return out
}

/* ------------------------------------------------------------------------- *
 * Execution
 * ------------------------------------------------------------------------- */

type Staged = MessageStep & { toContactId: string }

type RunState = {
  /** True under `previewPlan`: every statement this state sees will be rolled back, and the SQL record says so. */
  preview: boolean
  staged: Staged[]
  scheduled: { kind: string; run_at: string }[]
  notes: string[]
  /** The same notes in the voice used when the recipient is the subject. */
  personalNotes: string[]
  exec: { table: string; op: 'insert' | 'update' | 'delete'; count: number }[]
  /**
   * Raw `write` steps that matched no row, **each named**. Kept separately from
   * `exec` because `exec` drops zero-count entries when it becomes a diff, which
   * is how a write that did nothing became indistinguishable from one that was
   * never written.
   *
   * It was a COUNT, and the count is what made it useless. *"3 steps matched no
   * rows and change nothing — check that part landed"* cost a round of
   * deliberation trying to guess which three, and the same string reached a
   * prospect verbatim. A result either says which, in words the model can act
   * on, or it says nothing.
   */
  emptyWrites: string[]
  /** Message steps whose recipient resolved to nobody — see `resolveContact`. */
  unaddressed: number
}

function tableOf(sql: string): { table: string; op: 'insert' | 'update' | 'delete' } | null {
  const s = sql.trim().replace(/^\(+/, '')
  let m = /^insert\s+into\s+"?([a-z_][a-z0-9_]*)"?/i.exec(s)
  if (m) return { table: m[1].toLowerCase(), op: 'insert' }
  m = /^update\s+(?:only\s+)?"?([a-z_][a-z0-9_]*)"?/i.exec(s)
  if (m) return { table: m[1].toLowerCase(), op: 'update' }
  m = /^delete\s+from\s+(?:only\s+)?"?([a-z_][a-z0-9_]*)"?/i.exec(s)
  if (m) return { table: m[1].toLowerCase(), op: 'delete' }
  return null
}

/**
 * Which contact a message step is addressed to.
 *
 * @mechanism resolveContact — a message step's recipient is resolved as the service role when
 *   an OPERATION authored the step (`fromOperation`, stamped by `expand` and stripped from
 *   anything the model writes) and inside the caller's own visibility when the model authored
 *   it. Resolving everything through the caller silently un-sent every admin notification
 *   raised from a client's turn: `contact_cm_user_select` returned NULL, the step was dropped
 *   with no message row and no `suppressed_reason`, and AD-NEW-TRIAL was written 0 times
 *   across seven academies. Resolving everything as service would be the opposite defect — a
 *   model-authored plan in a parent's turn could address any person in the academy.
 *
 * **Addressing an outbound is not the same question as reading a contact, and
 * conflating them silently un-sent every admin notification the product raises
 * from a client's turn.**
 *
 * `contact_cm_user_select` is `is_admin() OR id = app.contact_id() OR person_id
 * = app.person_id()`, so a parent, a coach or a prospect can see exactly their
 * own row. This lookup ran on the caller's transaction, so `to_person_id` for
 * the owner resolved to NULL, and the step below hit `if (!to) continue`. No
 * message row, no `suppressed_reason`, no error — R7's defining case, on the
 * path that exists to tell somebody something happened.
 *
 * Three agents driving three different personas in three different academies
 * found this independently in one pass:
 *   - a coach declined two Saturday sessions, was told "I'll find cover" twice,
 *     and neither the admin nor the other assigned coach was ever told
 *   - a parent's cancellation never reached the only coach in the academy
 *   - a cold prospect created a person, an account, a player and an enrolment in
 *     a business whose owner heard nothing
 * `AD-NEW-TRIAL` — the catalog row whose entire job is telling an owner a
 * stranger booked a trial — has been written **0 times across all seven
 * academies**. The jobs path works because it runs as the service role; the
 * operation path never could. R4: one guarantee, enforced on one of two paths.
 *
 * **But the caller's scope is not merely removed, because it was doing real
 * work by accident.** Resolve everything as service and a model-authored plan in
 * a parent's turn could address any person in the academy — the send gate's §18
 * rules are about who a message is ABOUT, not who raised it, so nothing
 * downstream would stop a fan-out. That containment was unintentional and it is
 * load-bearing.
 *
 * So the question is who authored the step. An operation's message steps are the
 * runtime's own intent — `book_trial` telling the admin is a decision the
 * product made — and those resolve as service. A message step the MODEL wrote
 * into a plan stays inside what the caller can see, which is exactly the reach
 * it has always had.
 */
async function resolveContact(tx: Tx, ctx: SessionCtx, m: MessageStep): Promise<string | null> {
  if (m.to_contact_id) return m.to_contact_id
  const personId = m.to_person_id
  if (!personId) return null
  const find = async (): Promise<string | null> => {
    const rows = (await tx.unsafe(
      `select id from contact
        where academy_id = ${uid(ctx.academyId)} and person_id = ${uid(personId)}
          and opted_out_at is null
        order by is_primary desc, created_at limit 1`,
    )) as unknown as { id: string }[]
    return rows[0]?.id ?? null
  }
  return m.fromOperation ? asService(tx, ctx, find) : find()
}

async function runSteps(
  tx: Tx,
  ctx: SessionCtx,
  steps: PlanStep[],
  state: RunState,
): Promise<void> {
  for (const step of steps) {
    if ('note' in step) {
      state.notes.push(step.note)
      state.personalNotes.push(step.personal ?? step.note)
      continue
    }

    if ('write' in step) {
      /**
       * Recorded here, at the statement, because nothing downstream can see one.
       *
       * A plan carrying six writes is ONE row in the flight recorder, whose
       * `args` hold the steps as a JSON string clipped at 4,000 characters. Which
       * statement Postgres refused, and what it said, was written down nowhere —
       * so the write half of the model's SQL, which is the half that changes the
       * world, was the half no instrument could read. See `lib/agent/sql-trace.ts`.
       *
       * The refusal path reports too: `assertSingleWriteStatement` throws before
       * the database is reached, and a shape the model believed was legal is
       * exactly what a review of its SQL is looking for.
       */
      const startedAt = Date.now()
      const say = (r: { rowCount: number | null; error?: string }) =>
        recordSql(() => ({
              kind: 'write' as const,
          sql: step.write,
          ...(state.preview ? { rolledBack: true } : {}),
          role: step.service ? 'service' : ctx.role,
          academyId: ctx.academyId ?? null,
          personId: 'personId' in ctx ? (ctx.personId ?? null) : null,
          ms: Date.now() - startedAt,
          ...r,
        }))
      try {
        assertSingleWriteStatement(step.write)
      } catch (e) {
        say({ rowCount: null, error: e instanceof Error ? e.message : String(e) })
        throw e
      }
      const run = () => tx.unsafe(step.write) as unknown as Promise<unknown>
      let res: unknown
      try {
        res = step.service ? await asService(tx, ctx, run) : await run()
      } catch (e) {
        say({ rowCount: null, error: e instanceof Error ? e.message : String(e) })
        throw e
      }
      const n = rowCount(res)
      say({ rowCount: n })
      const t = tableOf(step.write)
      if (t) state.exec.push({ ...t, count: n })
      /**
       * **A write that matched nothing is not the same as a write nobody made.**
       *
       * `synthDiffs` drops zero-count entries, so a step that ran and changed no
       * row contributed nothing to the summary and the receipt read exactly as if
       * that step had never been in the plan. R7's defining case, at the one place
       * every plan passes through.
       *
       * Driven: an admin was told "I'll move Tara's enrolment to the Adults batch
       * starting 1 Sep" and tapped [Do it]. The plan closed Juniors — which set
       * `ended_on = 31 Aug` — and then selected the enrolments to copy across with
       * `ended_on is null or ended_on > '2026-08-31'`. Its own first step had just
       * made both halves false. Zero rows, no error, and a receipt that said
       * "changed 1 enrolment" (the closure) while the child it named was left
       * enrolled in nothing.
       *
       * Only counted for steps with no `requireRows`. A step that declares how many
       * rows it needs already has a guard that aborts the whole plan, and the
       * product's own operations use `on conflict do nothing` and
       * `deactivateStrandedPlayers` deliberately — those match nothing routinely
       * and saying so every time would train the reader to skip the line.
       */
      if (n === 0 && step.requireRows === undefined) {
        // Named by what it was trying to do, and by the predicate that matched
        // nothing — which is the part the author has to look at. The statement is
        // clipped rather than whole: this reaches the model, and the model wrote it.
        state.emptyWrites.push(
          t ? `${t.op} on ${t.table}: ${step.write.replace(/\s+/g, ' ').slice(0, 160)}` : step.write.replace(/\s+/g, ' ').slice(0, 160),
        )
      }
      if (step.requireRows !== undefined && n < step.requireRows) {
        /**
         * **"The world moved under this plan" is a sentence about a race, and
         * most of the time this is not one.**
         *
         * Driven (F-AX): a parent named her own makeup slot, RLS gives an account
         * holder no update on `session`, the statement matched nothing, and this
         * error told the model a concurrent write had beaten it. A model given a
         * wrong cause diagnoses it perfectly — it re-read the row, found it
         * unchanged, and called the identical operation again; only the loop's
         * repeated-failure guard stopped it. Two wasted rounds in front of a
         * waiting parent, and the customer inherits the misdiagnosis.
         *
         * The runtime can tell the two apart and simply was not asked. So this
         * says only what it knows for certain, and `hintFor` below re-runs the
         * same writes as the service role in a rolled-back transaction to say
         * which of the two it was — the diagnosis the raw-SQL path has had all
         * along.
         */
        throw new PlanAbort(
          'PRECONDITION_FAILED',
          step.because ?? `a step needed ${step.requireRows} row(s) and matched ${n}`,
        )
      }
      continue
    }

    if ('adjust' in step) {
      const a = step.adjust
      const period = a.period ?? (await periodNow(tx, ctx))
      const sql =
        `insert into tally_line (academy_id, account_id, player_id, period, kind, description, amount, reason, approved_by) values (` +
        `${uid(ctx.academyId)}, ${uid(a.account_id)}, ${a.player_id ? uid(a.player_id) : 'null'}, ` +
        `date ${lit(period)}, 'adjustment', ${lit(a.description ?? a.reason)}, ${moneyLit(a.amount)}, ` +
        `${lit(a.reason)}, ${ctx.role === 'user' ? uid(ctx.personId) : 'null'})`
      const adjustStartedAt = Date.now()
      const res = (await tx.unsafe(sql)) as unknown
      // The one statement the model did not write, recorded under its own kind so
      // a report never credits the model with SQL the runtime composed for it.
      recordSql(() => ({
          kind: 'adjust' as const,
        sql,
        ...(state.preview ? { rolledBack: true } : {}),
        role: ctx.role,
        academyId: ctx.academyId ?? null,
        personId: 'personId' in ctx ? (ctx.personId ?? null) : null,
        ms: Date.now() - adjustStartedAt,
        rowCount: rowCount(res),
      }))
      state.exec.push({ table: 'tally_line', op: 'insert', count: rowCount(res) })
      continue
    }

    if ('message' in step) {
      const to = await resolveContact(tx, ctx, step.message)
      /**
       * No contact, nothing to stage. `send` records a `no_contact` suppression
       * for messages that do reach it; a message with no addressable recipient
       * never becomes one.
       *
       * **It is counted now, because it used to vanish.** This `continue` was the
       * last step of the path that silently un-sent every admin notification
       * raised from a client's turn — see `resolveContact`. That cause is fixed,
       * but "the message went nowhere and nothing anywhere says so" is the shape
       * of the defect rather than the cause, and the next thing to resolve to
       * nobody should not be free either. The receipt says how many.
       */
      if (!to) {
        state.unaddressed++
        continue
      }
      state.staged.push({ ...step.message, toContactId: to })
      continue
    }

    if ('schedule' in step) {
      const s = step.schedule
      const when = new Date(s.run_at)
      if (Number.isNaN(when.getTime())) throw new Error(`plan: schedule.run_at is not a date: ${s.run_at}`)
      // A plan could insert a job of any kind string at all, and `runDueJobs` looks the
      // handler up by kind — so an unknown kind became a row that can never run and never
      // reports, which is R7 wearing a queue's clothes. `enqueue()` has always checked
      // this; this path is the second door into the same table and did not.
      if (!isJobKind(s.kind)) {
        throw new Error(
          `plan: '${s.kind}' is not a job kind. Known kinds: ${JOB_KINDS.join(', ')}`,
        )
      }
      // §13.1 — a watch with no expiry is a leak. The runtime rejects it here
      // as well as in the `schedule` tool, because a plan can carry one too.
      if (s.kind === 'agent_task' && !s.payload?.expires_at) {
        throw new Error('plan: an agent_task must carry expires_at (§13.1)')
      }
      // Every handler resolves its tenant from `payload.academy_id` and most open with
      // `need(p, 'academy_id')`, which throws — so a payload without it is a job that
      // burns its retries and dies. `enqueue()` injects it (enqueue.ts `toRow`); this
      // path did not, and the two operations that schedule through a plan —
      // `mark_attendance`'s client_outcome and `request_payment`'s reconcile — were both
      // born malformed because of it. The tenant is never in doubt here: a plan runs
      // inside exactly one academy's session. Injecting it at the step, rather than
      // fixing the two call sites, is what stops the third one being written wrong.
      const payload: Record<string, unknown> = { ...(s.payload ?? {}) }
      if (payload.academy_id === undefined) payload.academy_id = ctx.academyId
      // The slug is what the ALREADY WATCHING line prints and the only name `drop_watch`
      // matches (F-EP). `enqueue()`'s minters all store one; this second door into the
      // same table did not, so a plan-staged watch was undroppable by the name on the
      // screen. Stored as exactly the string the screen would fall back to
      // (split_part(dedupe_key, ':', 3)), so the print and the predicate cannot drift.
      if (s.kind === 'agent_task' && payload.slug === undefined) {
        payload.slug = String(s.dedupe_key).split(':')[2] ?? String(s.dedupe_key)
      }
      const sql =
        `insert into job (kind, run_at, dedupe_key, payload) values (` +
        `${lit(s.kind)}, timestamptz ${lit(when.toISOString())}, ${lit(s.dedupe_key)}, ${jsonLit(payload)}) ` +
        `on conflict (dedupe_key) do nothing`
      await asService(tx, ctx, () => tx.unsafe(sql) as unknown as Promise<unknown>)
      state.scheduled.push({ kind: s.kind, run_at: when.toISOString() })
      continue
    }
  }
}

async function periodNow(tx: Tx, ctx: SessionCtx): Promise<string> {
  const rows = (await tx.unsafe(
    `select to_char(date_trunc('month', app.now() at time zone a.timezone), 'YYYY-MM-DD') as period
       from academy a where a.id = ${uid(ctx.academyId)}`,
  )) as unknown as { period: string }[]
  // The fallback is the billing period a money row lands in, so it has to come from the
  // same clock the row above it would have used. The host clock is a different timeline —
  // it would file an adjustment under whichever month the server happens to be in.
  return rows[0]?.period ?? (await now(ctx.academyId)).toISOString().slice(0, 8) + '01'
}

/* ------------------------------------------------------------------------- *
 * Diffs and the summary sentence
 * ------------------------------------------------------------------------- */

function normalizeDiffs(raw: unknown): TableDiff[] {
  if (!Array.isArray(raw)) return []
  const out: TableDiff[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object') continue
    const table = String(r.table ?? r.table_name ?? '')
    if (!table) continue
    const op = String(r.op ?? r.operation ?? 'update').toLowerCase()
    const before = Array.isArray(r.before) ? (r.before as any[]) : []
    const after = Array.isArray(r.after) ? (r.after as any[]) : []
    const count = typeof r.count === 'number' ? r.count : Math.max(before.length, after.length)
    out.push({
      table,
      op: op === 'insert' || op === 'delete' ? op : 'update',
      count,
      before,
      after,
    })
  }
  return out
}

function synthDiffs(exec: RunState['exec']): TableDiff[] {
  const byKey = new Map<string, TableDiff>()
  for (const e of exec) {
    if (e.count === 0) continue
    const key = `${e.table}:${e.op}`
    const found = byKey.get(key)
    if (found) found.count += e.count
    else byKey.set(key, { table: e.table, op: e.op, count: e.count, before: [], after: [] })
  }
  return [...byKey.values()]
}

const VERB: Record<TableDiff['op'], string> = {
  insert: 'add',
  update: 'change',
  delete: 'remove',
}

/** The same three, after the fact. */
const VERB_DONE: Record<TableDiff['op'], string> = {
  insert: 'added',
  update: 'changed',
  delete: 'removed',
}

/** Tables whose singular is not the table name with the s taken off. */
const SINGULARS: Record<string, string> = {
  attendance: 'attendance mark',
  class_slot: 'weekly slot',
  tally_line: 'charge',
  // The coach's side of `tally_line`, and named the way a person says it. Without
  // an entry here the receipt reads "wrote 1 coach_ledger", which is the table-noun
  // leak the outbound lint refuses — completing these maps is the fix, not a rewrite
  // on the way out.
  coach_ledger: 'pay line',
  rate_period: 'rate change',
  contact: 'phone number',
  account: 'family account',
  session_coach: 'coach assignment',
  class_coach: 'coach assignment',
  memory_fact: 'remembered fact',
  audit_entry: 'audit entry',
  enrollment: 'enrolment',
  // The tenant row. Left out, a receipt read "changed 1 Shuttle Point" — the
  // table noun rendered, then the lint's "never say academy" rule substituting
  // the business name into a sentence that was never about the business.
  academy: 'setting for this business',
  venue: 'place',
}

/**
 * Table names are not English, and this sentence is read by a person.
 *
 * The summary is quoted back to whoever is confirming — sometimes verbatim, since
 * the model pastes it into its own message — so "that'll add 2 persons, add 1
 * contact and add 1 account" arrives on someone's phone as a database schema with
 * the underscores taken out. Every row here is the word the business would use.
 */
const PLURALS: Record<string, string> = {
  class: 'classes',
  person: 'people',
  contact: 'phone numbers',
  account: 'family accounts',
  player: 'players',
  attendance: 'attendance marks',
  tally_line: 'charges',
  coach_ledger: 'pay lines',
  rate_period: 'rate changes',
  session_coach: 'coach assignments',
  class_coach: 'coach assignments',
  class_slot: 'weekly slots',
  academy_admin: 'admins',
  memory_fact: 'remembered facts',
  audit_entry: 'audit entries',
  enrollment: 'enrolments',
  session: 'sessions',
  venue: 'venues',
  payment: 'payments',
  academy: 'settings for this business',
}

function plural(table: string, n: number): string {
  const one = table.replace(/_/g, ' ')
  // A count of one is singular whatever the table is called. "add 1 classes" is
  // the kind of sentence that tells a person they are reading machine output.
  if (n === 1) return SINGULARS[table] ?? one
  return PLURALS[table] ?? `${one}s`
}

/**
 * The same numbers read two ways, and which one you get is not cosmetic.
 *
 * A preview is a proposal — "that'll change 14 enrollments" — and a receipt is a
 * fact — "changed 14 enrollments". Reusing the preview wording after the commit
 * left people unable to tell whether the thing they had just approved had actually
 * happened, which is the one question a receipt exists to answer.
 */
/**
 * Who is going to read this sentence.
 *
 * `operator` counts rows, because an admin running a business needs the blast
 * radius and that is who the wording was designed for. `personal` is anybody being
 * told about *their own* thing — and for them a row count is not a smaller version
 * of the same information, it is a different and worse message.
 *
 * A coach tapped `[Looks right]` on his own onboarding and was told **"Changed 1
 * coach — they are set up and will get their day from now on."** Third person,
 * about himself, counting rows, at the exact moment the product is asking him to
 * believe tapping things works. The same string served both audiences because the
 * summary is minted once at commit time and replayed by the tap path, where there
 * is no model in the loop to notice the audience changed (R1).
 *
 * The receipt is the only thing this affects. Previews stay operator-shaped:
 * a preview is always shown to whoever is authorising the change.
 */
export type PlanAudience = 'operator' | 'personal'

/** An operator gets the blast radius; everybody else gets a sentence about themselves. */
export function audienceFor(identity: Identity): PlanAudience {
  return identity.roles.includes('admin') ? 'operator' : 'personal'
}

function buildSummary(
  diffs: TableDiff[],
  state: RunState,
  tense: 'preview' | 'done' = 'preview',
  audience: PlanAudience = 'operator',
  /** What actually happened on the wire. Only a receipt has these. */
  outcomes?: SendOutcome[],
): string {
  const done = tense === 'done'

  // The note is the only part of a plan written in the business's own words —
  // `add_coach` sets "Deepak Sharma, 3 classes" — so for a personal receipt it is
  // the whole sentence, and the row arithmetic is dropped rather than translated.
  // "N people have been told" goes with it: who else heard is an operator's
  // question, and to the person being told about themselves it reads as surveillance.
  if (done && audience === 'personal') {
    // `personalNotes` falls back to `notes` per step, so an operation that never
    // speaks to its own subject is unaffected.
    const note = state.personalNotes.filter(Boolean).join('; ')
    const changed = diffs.some((d) => d.count > 0)
    if (!changed) return 'Nothing changed.'
    return note ? `Done — ${note}.` : 'Done.'
  }

  /**
   * A tally_line is a "charge" only when it charges. `plural()` maps the table
   * blind to sign, and a tap that put two ₹1,000 credits on an account was
   * receipted as "Added 2 charges." — the census-label failure, on money, to
   * the person who just approved the opposite (F-O, T066). The rows are in the
   * diff, so the sign is read, never guessed; a mixed set keeps the generic
   * label rather than picking a side.
   */
  const label = (d: TableDiff): string => {
    if (d.table === 'tally_line') {
      const rows = d.op === 'delete' ? d.before : d.after
      const amounts = rows.map((r) => Number(r?.amount)).filter((n) => Number.isFinite(n))
      if (amounts.length && amounts.every((n) => n < 0)) return d.count === 1 ? 'credit' : 'credits'
      // A genuinely mixed set gets the neutral word — the fallback below is
      // "charges", which IS picking a side (review find).
      if (amounts.some((n) => n < 0)) return d.count === 1 ? 'tally line' : 'tally lines'
    }
    return plural(d.table, d.count)
  }
  const parts = [...diffs]
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((d) => `${(done ? VERB_DONE : VERB)[d.op]} ${d.count} ${label(d)}`)

  let head: string
  if (parts.length === 0) head = done ? 'Nothing changed' : 'Nothing changes in the data'
  else if (parts.length === 1) head = done ? capitalise(parts[0] as string) : `That'll ${parts[0]}`
  else {
    const joined = `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
    head = done ? capitalise(joined) : `That'll ${joined}`
  }

  const note = state.notes.filter(Boolean).join('; ')
  let s = note ? `${head} — ${note}.` : `${head}.`

  /**
   * **The empty-write and unaddressed lines used to be appended here, and they
   * are plan-builder internals in a sentence that becomes a message body.**
   *
   * "3 steps matched no rows and change nothing — check that part landed" reached
   * an admin verbatim, three times in one drive, over a tap receipt. It is a true
   * and useful thing to say to the AUTHOR of the plan and a meaningless thing to
   * say to the person who tapped a button. Both now travel on `PlanResult`
   * (`emptyWrites`, `unaddressed`), where the model reads them as facts and the
   * runtime never puts them on a phone.
   *
   * R7 — "doing nothing succeeds" is still the root whose failures read as a
   * pass, and it is still not an abort: the rest of the plan committed, and
   * rolling back a correct closure because a follow-on write missed would be
   * worse. It is reported to the layer that can act on it, which is the only
   * change.
   */

  /**
   * Told, or merely addressed.
   *
   * The count was `state.staged` in both tenses. Staged is the right number for a
   * PREVIEW — it is what will be attempted — and the wrong one for a receipt, because
   * between the two sits the entire send path: opt-out, the two §18 rules, pre-launch
   * silence, the repeat gate, the frequency caps, window-or-template. Driven: a waiver
   * receipt read "…1 person has been told" and the only outbound row to that family was
   * `SUPPRESSED: pre_launch`; a cancellation said "3 people have been told" over
   * `sent: [suppressed, suppressed, suppressed, sent]`.
   *
   * That is the same class as a past-tense claim with no write behind it, one layer
   * out: the claim is checked against the write and never against whether the message
   * left. An admin who reads "3 people have been told" does not tell them again.
   *
   * `outcomes` is only available for a receipt — `flushOutbox` has run by then — so the
   * preview keeps the staged count, which is honest for it.
   */
  /**
   * People, not messages. `reached` counted sent MESSAGES and the sentence says
   * "people": ending Aarav's two enrollments sent Meera two lines and receipted
   * "2 people have been told" — one person, told twice, reported as a wider
   * audience (month drive, T075). The recipients are on every staged row and
   * every outcome, so the distinct count is read, not derived. `missed` stays
   * in message terms, because a message that did not go out is the unit the
   * admin acts on.
   */
  const sentOutcomes = outcomes?.filter((o) => o.status === 'sent' || o.status === 'queued')
  const reached = sentOutcomes
    ? new Set(sentOutcomes.map((o) => ('toContactId' in o && o.toContactId) || '')).size
    : new Set(state.staged.map((m) => m.toContactId)).size
  if (done) {
    const missed = state.staged.length - (sentOutcomes?.length ?? 0)
    if (reached === 1) s += ' 1 person has been told.'
    else if (reached > 1) s += ` ${reached} people have been told.`
    if (missed > 0) {
      // Named, not swallowed. A message that did not go is the thing the admin has to
      // act on, and every suppression is already a row carrying its reason.
      s +=
        reached === 0
          ? ` Nobody was told — ${missed === 1 ? 'that message' : `all ${missed} messages`} did not go out.`
          : ` ${missed} message${missed === 1 ? '' : 's'} did not go out.`
    }
  } else if (reached === 1) s += ' 1 person hears about it.'
  else if (reached > 1) s += ` ${reached} people hear about it.`
  if (state.scheduled.length === 1) s += " I'll check back once."
  else if (state.scheduled.length > 1) s += ` ${state.scheduled.length} follow-ups are scheduled.`
  return s
}

const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s)

function previewOf(m: MessageStep): string {
  const b = m.body.replace(/\s+/g, ' ').trim()
  const btn = m.buttons?.length ? ` [${m.buttons.map((x) => x.title).join('] [')}]` : ''
  return (b.length > 160 ? `${b.slice(0, 157)}…` : b) + btn
}

/* ------------------------------------------------------------------------- *
 * previewPlan / executePlan
 * ------------------------------------------------------------------------- */

function emptyState(preview: boolean): RunState {
  return { preview, staged: [], scheduled: [], notes: [], personalNotes: [], exec: [], emptyWrites: [], unaddressed: 0 }
}

/**
 * A plan whose whole purpose was to change something, and changed nothing, failed.
 *
 * @mechanism assertSomethingChanged — a plan that carries writes and whose diff is empty
 *   aborts instead of committing. Zero rows is not a Postgres error, so an RLS-refused update
 *   — or a WHERE that an earlier step in the same plan made false — used to commit quietly
 *   with an empty audit diff and a "Nothing changed" summary the model read straight past: a
 *   coach was told "You're all set up", stayed `invited` forever, and nothing anywhere said
 *   so. Plan-level rather than step-level on purpose: individual writes legitimately match
 *   nothing, a whole plan of writes never does, and a plan of only messages, notes or
 *   scheduled work never claimed to change a row.
 *
 * **The most dangerous shape in the product, because it reads as success at every
 * layer.** Watched, on a coach's first ever message: `[Looks right]` ran
 * `onboard_coach`, whose one write is `update coach set status = 'active' where id = …`.
 * The row exists. The id was right. RLS gives a coach no UPDATE on their own row, so
 * Postgres changed nothing and raised nothing — zero rows is not an error. The plan
 * committed, the audit recorded an empty diff, the summary said *"Nothing changed"*,
 * and the coach was told **"Great! You're all set up."** They were not. They stayed
 * `invited` forever, the admin kept being told nobody had confirmed, and there is no
 * signal anywhere that anything went wrong.
 *
 * Reporting it is not enough — it *was* reported, in the summary, and a model reading
 * `ok: true` past it is the normal case rather than the exception. Silence has to become
 * a failure at the layer that can see it, and this is that layer.
 *
 * **Plan-level, not step-level, on purpose.** Plenty of individual writes legitimately
 * match nothing — `update job set status='cancelled' where status='pending' and
 * dedupe_key in (…)` is idempotent housekeeping and matching zero is the common case.
 * What is never legitimate is a whole plan of writes leaving the database exactly as it
 * found it. A plan of only messages, notes or scheduled work is not this: it never
 * claimed to change a row.
 */
function assertSomethingChanged(expanded: PlanStep[], diffs: TableDiff[]): void {
  if (diffs.some((d) => d.count > 0)) return
  /**
   * A guard is a `write` by shape and a read by intent, and only its author knows which.
   * `send_invite`'s live-check is one `select`; counting it as a write made a plan of
   * "check we are live, then message four families" abort as CHANGED_NOTHING, because
   * messages produce no diff and the select produces no rows to diff. Excluded by an
   * explicit flag rather than by looking at the SQL: a regex over a statement to decide
   * whether it changes anything is the pattern-matching-prose failure this repo has paid
   * for repeatedly, and the author already knows the answer at the moment it writes it.
   */
  const changers = expanded.filter((s) => ('write' in s && !s.guard) || 'adjust' in s)
  if (!changers.length) return
  throw new PlanAbort(
    'CHANGED_NOTHING',
    `that changed nothing — ${changers.length} write(s) ran and every one of them matched no rows. ` +
      'Either the WHERE matched nothing (read it back and check the id), or this person is not allowed ' +
      'to change those rows and the database quietly did nothing rather than refusing. Do not say it is done.',
  )
}

/**
 * Rule 7 at the chokepoint — one event, one person, one message.
 *
 * A plan is one event by construction, and its steps stage messages per FACT:
 * moving Beginners' two weekly slots staged two near-identical lines per family
 * (four messages for one move, month drive T060), and ending a child's two
 * enrollments told the same mother twice in one commit (T075). The ideal's own
 * sentence — "you'll get one message, not two" — is dedupe by fact-and-
 * recipient, and the plan's outbox is the one place every staged message of the
 * event is visible together.
 *
 * Same recipient + same catalog moment (or both none) merge into one body,
 * bodies joined line by line, byte-identical bodies kept once. The first
 * message's buttons stand: a per-fact duplicate button offers nothing new. A
 * confirmation request never merges (it is its own event, answered by a tap),
 * and neither does the opt-out acknowledgement.
 */
function mergePerRecipient(staged: Staged[]): Staged[] {
  const out: Staged[] = []
  const byKey = new Map<string, Staged>()
  const keep = (m: Staged): void => {
    const mergeable = !m.is_confirmation_request && !m.opt_out_ack
    const copy = { ...m }
    out.push(copy)
    if (mergeable) byKey.set(`${m.toContactId}|${m.catalog_id ?? ''}`, copy)
  }
  for (const m of staged) {
    const mergeable = !m.is_confirmation_request && !m.opt_out_ack
    const prior = mergeable ? byKey.get(`${m.toContactId}|${m.catalog_id ?? ''}`) : undefined
    if (!prior) {
      keep(m)
      continue
    }
    /**
     * A merge must lose nothing load-bearing (review find: the first draft kept
     * only the first message's buttons and flags, so a second fact's own button
     * vanished and its subject fell out of the §18 gates). So: a message whose
     * buttons differ from the survivor's stays its own message; subjects union;
     * `fixed` and `is_escalation` strengthen (either message demanding them
     * demands them of the merge); `pre_launch_ok` weakens (both must be exempt
     * for the merge to be). And a merge that would push a buttoned body past
     * the wire cap stays separate — two messages beat one truncated one.
     */
    const buttonsDiffer =
      (m.buttons?.length ?? 0) > 0 &&
      JSON.stringify(prior.buttons ?? []) !== JSON.stringify(m.buttons ?? [])
    const joined = prior.body === m.body || prior.body.includes(m.body) ? prior.body : `${prior.body}\n${m.body}`
    const wouldOverflow =
      joined.length > ((prior.buttons?.length ?? 0) + (m.buttons?.length ?? 0) > 0 ? LIMITS.bodyChars : LIMITS.textChars)
    if (buttonsDiffer || wouldOverflow) {
      keep(m)
      continue
    }
    prior.body = joined
    if (m.subject_person_ids?.length) {
      prior.subject_person_ids = [...new Set([...(prior.subject_person_ids ?? []), ...m.subject_person_ids])]
    }
    prior.fixed = Boolean(prior.fixed || m.fixed)
    prior.is_escalation = Boolean(prior.is_escalation || m.is_escalation)
    prior.pre_launch_ok = Boolean(prior.pre_launch_ok && m.pre_launch_ok)
  }
  return out
}

/** BEGIN → run every step → capture the diff → ROLLBACK. Messages never leave the outbox. */
export async function previewPlan(
  ctx: SessionCtx,
  steps: PlanStep[],
  /**
   * The model's own one-line description of what it is trying to do. Used only
   * when a plan is refused by permissions: it is what the owner is told somebody
   * asked for. Business language written by the model, never the SQL — an
   * escalation that quotes a refused statement is a side channel reporting what
   * somebody tried.
   */
  intent?: string,
  /**
   * `noHints` makes a failed preview truly side-effect free. The ordinary
   * failure path computes the best hint it can, and for CHANGED_NOTHING that
   * includes `refusalHint` → `escalateRefusal`, which SENDS to the admins and
   * writes a memory fact — right for a model-initiated preview whose failure
   * is the turn's news, and wrong for a mint-time annotation check
   * (`withRuntimeDiffLine`), where a failed preview must change nothing and
   * page nobody. Found adversarially: the mint-time call escalated with its
   * own internal intent string spliced into the owner's message.
   */
  opts?: { noHints?: boolean },
): Promise<PlanResult> {
  const state = emptyState(true)
  // Hoisted so the catch can tell a refusal from a missing row — that diagnosis
  // needs the steps, and inside the try they are out of scope by the time it throws.
  let expanded: PlanStep[] = []
  try {
    expanded = await expand(ctx, steps, 0)
    // The diff is merged INSIDE the transaction now, because the clash check
    // reads it and has to run against the world the steps just made — before
    // the rollback takes it away again.
    const inTx = await withRollback(ctx, async (tx) => {
      const auditId = await beginAuditSafe(tx, ctx, 'preview', steps)
      await runSteps(tx, ctx, expanded, state)
      const read = await readDiffSafe(tx, ctx, auditId)
      const diffs = read.length ? read : synthDiffs(state.exec)
      return {
        diffs,
        clashes: await noteClashes(tx, ctx, diffs, state),
        untold: await noteUntold(tx, ctx, diffs, state),
      }
    })
    const merged = inTx.diffs
    assertSomethingChanged(expanded, merged)
    // Rule 7 — merged here too, so the preview the person confirms against
    // describes the messages that will actually go.
    state.staged = mergePerRecipient(state.staged)
    return {
      ok: true,
      diffs: merged,
      totalRows: merged.reduce((n, d) => n + d.count, 0),
      stagedMessages: state.staged.map((m) => ({ toContactId: m.toContactId, preview: previewOf(m), body: m.body })),
      scheduled: state.scheduled,
      summary: buildSummary(merged, state),
      clashes: inTx.clashes,
      untold: inTx.untold,
      emptyWrites: state.emptyWrites,
      unaddressed: state.unaddressed,
    }
  } catch (e) {
    return failed(state, e, opts?.noHints ? null : await hintFor(ctx, e, expanded, state.notes, intent))
  }
}

/**
 * The best sentence available about why this failed.
 *
 * **Both silent failures get the round trip now.** `CHANGED_NOTHING` always did:
 * it is the failure whose cause the error itself cannot name. `PRECONDITION_FAILED`
 * did not, and it is the same failure wearing a guard's clothes — a `requireRows`
 * step matching fewer rows than it needed is either a real race or a policy
 * refusing silently, and the error text used to assert the first (F-AX). One
 * re-run as the service role, rolled back, answers it for both.
 *
 * Everything else is diagnosable from the Postgres message alone.
 */
async function hintFor(
  ctx: SessionCtx,
  e: unknown,
  expanded: PlanStep[],
  /** The plan's own notes — business language, written by the operation, no SQL. */
  notes: string[] = [],
  intent?: string,
): Promise<string | null> {
  if (e instanceof PlanAbort && (e.code === 'CHANGED_NOTHING' || e.code === 'PRECONDITION_FAILED')) {
    const refusal = await refusalHint(ctx, expanded, notes, intent, e.code)
    if (refusal) return refusal
  }
  return repairHint(ctx, e)
}

/**
 * A refusal is not a hint to pass on. It IS the handoff.
 *
 * `refusalHint` already establishes, with certainty, the one situation the
 * product has a mechanism for and never uses: the rows exist, this person asked
 * to change them, and they are not allowed to. Until now it answered that by
 * telling the model, in prose, to "offer to pass it to whoever runs the
 * business."
 *
 * Instructions do not close structural gaps, and this is the cleanest evidence
 * of it in the repo. Driven twice, independently, on two different families:
 * a parent said "we want to stop lessons after this month", the write was
 * RLS-refused, the model got this exact hint, and it spent SEVEN rounds before
 * replying *"I've noted that Meghana will be stopping her Saturday Kriti
 * lessons after August"* — with **zero audit rows**. Nothing was written, the
 * family believes they have cancelled, they will be billed on the 1st, and
 * nobody at the academy ever learned that a customer asked to leave. The
 * `handoff` tool does exactly the right thing here and has been called 0 times
 * in 464 tool calls: R8, a door with no sign.
 *
 * So the runtime performs it rather than recommending it. §8.3's own rule for
 * churn is that it "reuses the existing escalation rather than inventing one",
 * and this is that escalation: the same admin message and the same `memory_fact`
 * the `handoff` tool writes, raised at the moment the runtime is certain.
 *
 * **Deliberately narrow, because "escalate on any refusal" would be worse than
 * the bug.** RLS refuses malformed writes, mistyped ids and genuine probes, and
 * turning every "permission denied" into a message to the owner would both spam
 * them and make the refusal path a side channel reporting what somebody tried.
 * All four of these must hold: the actor is a person rather than the service
 * role; a write was attempted; the plan aborted with CHANGED_NOTHING; and the
 * same writes provably match real rows as the service role. That is not "a query
 * failed" — it is "a person asked for a change to something real and the product
 * said no", which is always worth a human knowing.
 *
 * **It never sends the SQL.** The summary is the plan's own `note`, which
 * operations write in the business's words — "Meghana stops Saturday Kriti on
 * 31 Aug, coming off 3 scheduled sessions". Where there is no note it says
 * nothing about the attempt beyond that one was made.
 *
 * **What this does not decide.** Whether a parent SHOULD be able to end her own
 * child's enrolment is a policy question the spec does not answer, and inventing
 * one here would be the memory half of R10 — a business rule nobody chose. This
 * changes only what happens when the answer is already no: the person is told
 * the truth and a human is told at all.
 */
async function escalateRefusal(
  ctx: SessionCtx, notes: string[], intent?: string,
): Promise<boolean> {
  if (ctx.role !== 'user' || !ctx.personId) return false

  /**
   * The note is preferred and the intent is the fallback, because a note is
   * written by an OPERATION in the business's own words — "Meghana stops
   * Saturday Kriti on 31 Aug, coming off 3 scheduled sessions" — while the intent
   * is the model's summary of its own plan. Driven, the note was empty every
   * time: the step that gets refused is usually a raw `write` the model composed
   * after a named operation had already failed, and a raw write carries no note.
   * So the owner was told "asked for something only you can do" with nothing
   * after it, which is true and useless. The intent is what makes the message
   * actionable.
   */
  // Trailing punctuation trimmed because this is spliced mid-sentence: the model
  // writes its intent as a sentence and the result read "…end of August.. I couldn't".
  const summary = (notes.filter(Boolean).join('; ') || (intent ?? ''))
    .slice(0, 400)
    .replace(/[.\s]+$/, '')
  try {
    /**
     * Two guards, both found by asking what this does when it is NOT a parent.
     *
     * **An admin is not escalated to themselves.** `academy_admin` membership is
     * the test, not the plan: an owner whose write is refused has hit an infra
     * table with no `cm_user` policy at all (`job`, `audit_entry`, `memory_fact`),
     * which is a runtime boundary and not a request anybody can grant. Without
     * this the product would message every owner about the owner, have §18 rule 2
     * drop each one for being about its own recipient, and still write a
     * `memory_fact` saying they "asked for something only an admin can do" —
     * about the admin.
     *
     * **And it is raised once.** A turn can fail two plans: the model tries a
     * named operation, gets refused, composes a raw write, and gets refused
     * again. The send gate's repeat guard only catches byte-identical bodies, and
     * these two carry different summaries, so both would reach the owner. Ten
     * minutes is longer than any turn and far shorter than a second genuine ask.
     */
    // Both guards and the asker's name in one round trip. This was four sessions and
    // six statements — the two guards, the admin list, then a name and an academy
    // name — on a path that runs while somebody is waiting for an answer. The academy
    // name was fetched and never used; the rest are scalar subqueries over one row.
    const gate = await withSession(serviceFrom(ctx), async (tx) => {
      const rows = (await tx.unsafe(
        `select
           (select count(*) from academy_admin
             where academy_id = ${uid(ctx.academyId)}
               and person_id = ${uid(ctx.personId as string)})::int as is_admin,
           (select count(*) from message
             where academy_id = ${uid(ctx.academyId)} and catalog_id = 'AD-NEEDS-YOU'
               and payload->'subject_person_ids' ? ${lit(ctx.personId as string)}
               and created_at > app.now() - interval '10 minutes')::int as raised_recently,
           (select full_name from person where id = ${uid(ctx.personId as string)}) as who`,
      )) as unknown as { is_admin: number; raised_recently: number; who: string | null }[]
      return rows[0] ?? null
    })
    // A failed read is not a licence to escalate: no row means the guards could not be
    // checked, and the safe answer to "should this reach the owner" is not yet.
    if (!gate || Number(gate.is_admin) > 0 || Number(gate.raised_recently) > 0) return false
    const who = gate.who ?? 'Someone'

    const admins = await adminContactIds(ctx.academyId)
    if (admins.length === 0) return false

    for (const contactId of admins) {
      await composeAndSend(ctx, {
        toContactId: contactId,
        body: (
          `${who} asked for something only you can do${summary ? `: ${summary}` : ''}. ` +
          `I couldn't do it for them, so I've told them you'd pick it up.`
        ).slice(0, LIMITS.bodyChars),
        isEscalation: true,
        // Every AD-* row rides `admin_alert`, and without a catalog id an
        // out-of-window send falls back on the RECIPIENT'S ROLE — so an owner who
        // also coaches received this as "an update to your schedule" under an
        // [Open my day] button. An escalation about a customer leaving is not a
        // change to the reader's timetable. Its own row, because borrowing
        // AD-ESCALATE-UNCONFIRMED rendered it out of window as "a session is
        // uncovered", which is a different emergency.
        catalogId: 'AD-NEEDS-YOU',
        // §18 rule 2 reads this: an escalation about a person never reaches that
        // person, so this cannot loop back to the parent who triggered it.
        subjectPersonIds: [ctx.personId],
        fixed: true,
        buttons: [{ title: 'Message them', action: { kind: 'reply', text: `Open a message to ${who}` } }],
      })
    }

    /**
     * The person who asked is NOT told from here, and that is deliberate.
     *
     * Sending it here was the first attempt and it was one message too many.
     * Driven: the runtime said "that's not something I can change from here, I've
     * passed it to whoever runs Nadam Vocal", and the model — now correctly
     * informed by the hint — went on to compose something strictly better:
     * *"That'll be Vedanth's last month in Tuesday Beginners. His final class will
     * be on Tue 25 Aug. Because that enrollment is already live, I can't stop it
     * myself — I've passed this to Lakshmi to handle the closing balance and
     * update the roster."* Every fact in it checks out against the session rows.
     * The mother received both, and the runtime's blunter version added nothing.
     *
     * So the truthful sentence lives at the **fallback** in `loop.ts` instead:
     * when the model composes a good answer it goes out alone, and when the model
     * runs out of rounds the person gets the true sentence rather than "I'm going
     * round in circles". One message either way, and never an apology after an
     * answer. The loop finds out this happened by looking for the AD-NEEDS-YOU
     * row this function just wrote — no new state, and it stays true if some
     * other path starts raising the same escalation.
     */

    // The same row `handoff` writes. A request that reaches an admin who is busy
    // must not evaporate when the conversation moves on.
    await withSession(serviceFrom(ctx), async (tx) => {
      await tx.unsafe(
        `insert into memory_fact (academy_id, subject_kind, subject_id, fact, source)
         values (${uid(ctx.academyId)}, 'person', ${uid(ctx.personId as string)},
                 ${lit(`Asked for something only an admin can do${summary ? `: ${summary}` : ''}`)},
                 ${lit(`refusal:${ctx.academyId}`)})`,
      )
    })
    return true
  } catch {
    // An escalation is an improvement on the refusal, never a precondition for
    // reporting it. If this fails the model still gets the hint below.
    return false
  }
}

/**
 * BEGIN → run → capture → COMMIT → and only then flush the outbox through the
 * one send path. A rolled-back transaction has messaged nobody (§2.5, §14.2.1).
 */
export async function executePlan(
  ctx: SessionCtx,
  steps: PlanStep[],
  intent: string,
  /** Who the receipt is for. Defaults to the operator wording this has always used. */
  audience: PlanAudience = 'operator',
): Promise<PlanResult & { auditId: string; outcomes: SendOutcome[] }> {
  const state = emptyState(false)
  let auditId = newId()
  // Hoisted for the same reason as in `previewPlan`: the catch needs the steps
  // to tell an RLS refusal from a WHERE that matched nothing.
  let expanded: PlanStep[] = []
  try {
    expanded = await expand(ctx, steps, 0)
    const inTx = await withSession(ctx, async (tx) => {
      auditId = await beginAuditSafe(tx, ctx, intent, steps, auditId)
      await runSteps(tx, ctx, expanded, state)
      const read = await readDiffSafe(tx, ctx, auditId)
      const diffs = read.length ? read : synthDiffs(state.exec)
      /**
       * Asked here as well as in the preview, so the property is the plan's
       * rather than the previewed plan's. Every model-authored write is gated
       * by `needsPreview` before it reaches this function, but not every write
       * reaching it came through a preview — a whole timetable typed in one
       * messy sentence commits as one plan, which is exactly where two 7am
       * Mondays get in — and a receipt that names the overlap is the only
       * warning that path has.
       */
      const out = {
        diffs,
        clashes: await noteClashes(tx, ctx, diffs, state),
        untold: await noteUntold(tx, ctx, diffs, state),
      }
      // INSIDE the transaction, after the guards, so CHANGED_NOTHING is a
      // ROLLBACK — which is what its own tag ("aborts instead of committing"),
      // ANATOMY's sub-pipeline A order 6, and every caller already believe it
      // is. It spent its whole life below the commit line under this function:
      // by the time it threw, the plan's audit entry and any schedule-step job
      // rows had already committed — so the model was told "Nothing was changed
      // and nobody was messaged" by a turn that had just armed a job, and that
      // job later fires out of a turn whose own account says it did nothing.
      assertSomethingChanged(expanded, out.diffs)
      return out
    })
    // ---- committed. Only now does anything reach the wire. ----
    const merged = inTx.diffs
    // Rule 7 — one event, one person, one message. Assigned back onto the state
    // so the receipt's staged-vs-sent arithmetic counts the messages that were
    // actually attempted.
    state.staged = mergePerRecipient(state.staged)
    const outcomes = await flushOutbox(ctx, state.staged, auditId)
    await recordAudit(ctx, auditId, intent, steps, merged, state, outcomes)
    const receipt = buildSummary(merged, state, 'done', audience, outcomes)
    return {
      ok: true,
      auditId,
      outcomes,
      diffs: merged,
      totalRows: merged.reduce((n, d) => n + d.count, 0),
      stagedMessages: state.staged.map((m) => ({ toContactId: m.toContactId, preview: previewOf(m), body: m.body })),
      scheduled: state.scheduled,
      summary: receipt,
      clashes: inTx.clashes,
      untold: inTx.untold,
      emptyWrites: state.emptyWrites,
      unaddressed: state.unaddressed,
    }
  } catch (e) {
    return { ...failed(state, e, await hintFor(ctx, e, expanded, state.notes, intent)), auditId, outcomes: [] }
  }
}

function failed(state: RunState, e: unknown, hint?: string | null): PlanResult {
  const message = e instanceof Error ? e.message : String(e)
  return {
    ok: false,
    diffs: [],
    totalRows: 0,
    stagedMessages: [],
    scheduled: [],
    /**
     * The summary stays the plain sentence for a `StepRefused` too, and deliberately.
     * The itemisation is plan-builder internals — step numbers, operation names, a list
     * of siblings — and this field is the one that has reached a phone verbatim before
     * (see `buildSummary`, where the empty-write line was removed for exactly that).
     * The model reads `error`; a person must never be handed a step index.
     */
    summary: 'Nothing was changed and nobody was messaged.',
    // A plan that rolled back put nobody anywhere, and changed nothing for
    // anybody to be told about.
    clashes: [],
    untold: [],
    emptyWrites: state.emptyWrites,
    unaddressed: state.unaddressed,
    /**
     * `StepRefused` carries its own itemisation in `message` — which step of how many,
     * what the gate said, and which siblings would have run — so it is prefixed with its
     * code the way a `PlanAbort` is and otherwise passed through whole. Clipping or
     * re-summarising it here would restore the defect it exists to retire: the model read
     * one opaque sentence, could not tell which of six steps blocked, and apologised for
     * the wrong cause three days running.
     */
    error: (e instanceof PlanAbort || e instanceof StepRefused ? `${e.code}: ${message}` : message) +
      (hint ? ` — ${hint}` : ''),
  }
}

/* ------------------------------------------------------------------------- *
 * Making a refusal actionable
 * ------------------------------------------------------------------------- */

const RLS_RE = /row-level security policy(?: \(USING expression\))? for table "([^"]+)"/i
const NOT_NULL_RE = /null value in column "([^"]+)" of relation "([^"]+)"/i
const ON_CONFLICT_RE = /no unique or exclusion constraint matching the ON CONFLICT/i
const FK_RE = /violates foreign key constraint "[^"]*" on table "([^"]+)"/i
const CHECK_RE = /violates check constraint "([^"]+)"/i
/**
 * 23505. Absent until 0021, because until then the only unique keys were ones a
 * plan rarely collided with. `class_academy_name_open_key` changed that: "add a
 * beginners batch" typed twice is now a refusal rather than a second class, and
 * without a hint the model gets `duplicate key value violates unique constraint
 * "class_academy_name_open_key"` — a sentence whose repair is not obvious and
 * whose worst outcome is being read back to an admin verbatim.
 */
const UNIQUE_RE = /duplicate key value violates unique constraint "([^"]+)"/i
/** Postgres appends `Key (a, b)=(x, y) already exists.` — the columns AND the
 *  values that collided, which is the whole diagnosis. */
const UNIQUE_DETAIL_RE = /Key \(([^)]+)\)=\(([^)]*)\) already exists/i

/**
 * Postgres refuses precisely and explains nothing, and the model has no way to
 * look. Watched live: three consecutive attempts to insert class slots came back
 * `new row violates row-level security policy for table "class_slot"`, and each
 * retry changed something irrelevant — `active`, then `rate_unit` — because
 * there was nothing in the message to change. Eighty-one seconds, 119k tokens,
 * and the admin got an apology inventing a cause ("this sometimes happens during
 * setup"). The missing column was `academy_id`, and the policy that refused says
 * so in plain text in `pg_policies`.
 *
 * So the refusal carries its own repair. This reads the live catalog rather than
 * knowing anything about any particular table, which is the whole point: a
 * policy added tomorrow explains itself tomorrow, with no edit here.
 */
/**
 * Which kind of nothing happened.
 *
 * @mechanism refusalHint — both silent failures (`CHANGED_NOTHING`, and a `requireRows`
 *   guard's `PRECONDITION_FAILED`) re-run their own writes as the service role inside a
 *   transaction that always rolls back, which tells an RLS refusal apart from a WHERE that
 *   matched nothing instead of asserting a race nobody checked. Where the rows do exist,
 *   `escalateRefusal` performs the handoff rather than advising one in prose: the admins get
 *   an AD-NEEDS-YOU message carrying the plan's own note, and the same `memory_fact` the
 *   `handoff` tool writes is recorded — so a parent asking to stop lessons cannot end in a
 *   model-composed "I've noted that" with zero audit rows behind it. Deliberately narrow, or
 *   the refusal path becomes a side channel reporting what somebody tried: a person rather
 *   than the service role, a write attempted, the plan aborted, and the rows provably real.
 *   Closes F-AX.
 *
 * `assertSomethingChanged` can see that a plan of writes changed no rows. It
 * cannot see WHY, so it says "either the WHERE matched nothing, or this person
 * is not allowed to change those rows" — and leaves the model to guess. Driven:
 * a parent asked to stop her child's enrolment, and the turn spent 8 rounds,
 * 38.6s and ₹1.87 guessing. It tried the named operation, then raw SQL twice,
 * got the same silent nothing each time, and gave up with a question. She can
 * READ the row and not write it; the write is RLS-refused and refusals are
 * silent by construction, which is R7's defining case.
 *
 * The runtime can tell the difference and simply was not asked. Re-run the same
 * writes as the service role inside a transaction that always rolls back: if
 * they match rows there, the rows exist and this person is not allowed to change
 * them — a refusal, and something an admin can do. If they match nothing there
 * either, the WHERE really is wrong.
 *
 * Only ever on the failure path, which already costs several rounds, so one
 * extra round trip is the cheapest thing in the sequence. Rolled back, so the
 * diagnosis cannot become the write.
 */
async function refusalHint(
  ctx: SessionCtx,
  expanded: PlanStep[],
  notes: string[] = [],
  intent?: string,
  /** Which silent failure asked. A race is only possible for the guarded one. */
  code: 'CHANGED_NOTHING' | 'PRECONDITION_FAILED' = 'CHANGED_NOTHING',
): Promise<string | null> {
  if (ctx.role === 'service') return null
  /**
   * A guard is excluded here for the same reason it is excluded from
   * `assertSomethingChanged`, and the consequence of including it is worse.
   *
   * This function re-runs the plan's writes as the service role to tell an RLS refusal from
   * a WHERE that matched nothing. A guard matches nothing on purpose — that IS its refusal —
   * and it matches nothing as the service role too, so the diagnosis below turns a plain,
   * true precondition into one of two false sentences. With no other DML the model is handed
   * the race hypothesis ("somebody else got there first, which is what these guards are
   * for"), which is precisely the F-AX shape this file documents forty lines up: *a model
   * given a wrong cause diagnoses it perfectly*. With other valid DML in the plan it is
   * handed the escalation instead — "this person is not allowed to change them" — said to an
   * owner about his own business.
   *
   * The guard already carries the only true sentence about why it failed, in `because`.
   * Nothing here can improve on it and both branches make it worse.
   */
  const writes = expanded.filter(
    (s): s is PlanStep & { write: string } => 'write' in s && !s.guard,
  )
  if (!writes.length) return null
  try {
    const matched = await withRollback(serviceFrom(ctx), async (tx) => {
      let n = 0
      for (const w of writes) n += rowCount(await tx.unsafe(w.write))
      return n
    })
    if (matched > 0) {
      // The escalation happens HERE, not in a sentence asking the model to do it.
      // See `escalateRefusal` for the two turns that prove the sentence does not work.
      const raised = await escalateRefusal(ctx, notes, intent)
      return (
        `those rows DO exist — ${matched} of them — and this person is not allowed to change them. The database ` +
        `refused silently rather than raising. This is not something to retry or reword. ` +
        (raised
          ? `I have ALREADY told the people who run this business what they asked for, and recorded it. ` +
            `Tell them plainly that it is not something they can change themselves and that you have passed it ` +
            `on — do NOT say the thing they asked for has been done, because nothing was written.`
          : `Say plainly that it is not something they can change themselves, and offer to pass it to whoever ` +
            `runs the business.`)
      )
    }
    /**
     * Nothing matched even as the service role, so permission was never the
     * question. For a `requireRows` guard that leaves the race the error used to
     * assert unconditionally — and here it IS the honest reading, because the
     * guarded statements are the ones written to be raced (first-tap-wins cover,
     * a payment confirmed twice).
     */
    return code === 'PRECONDITION_FAILED'
      ? `the rows are not there even with no permissions in the way, so this is not a refusal — either the world ` +
        `moved between reading and writing (somebody else got there first, which is what these guards are for), ` +
        `or the WHERE names something that does not exist. Read it back before writing again, and if somebody else ` +
        `got there first, say so rather than retrying.`
      : `the rows genuinely do not exist — the same writes match nothing even with no permissions in the way. ` +
        `The WHERE is wrong, not the permission. Read the row back and check the id before writing again.`
  } catch {
    /* a hint is an improvement on the error, never a precondition for reporting it */
    return null
  }
}

async function repairHint(ctx: SessionCtx, e: unknown): Promise<string | null> {
  const message = e instanceof Error ? e.message : String(e)
  try {
    const rls = RLS_RE.exec(message)
    if (rls) {
      const table = rls[1] as string
      const checks = await policyExpressions(ctx, table)
      /**
       * Two different refusals share this error, and the old hint answered only
       * one of them. A missing `academy_id` is repairable in place; a policy
       * demanding `is_admin()` or `sees_money()` of a session that is neither is
       * not — no rewording will ever pass, and telling the model to "add it and
       * the same statement will pass" sent it flailing. Driven twice in the month
       * on money: a parent's payment attestation (T062) and her pro-rata credit
       * (T065) both died here, the person was told "the owner will confirm" /
       * "it's a one-tap fix on their side", and the owner heard nothing until she
       * asked — rule 15's exact failure, caused by an error that named no route.
       * The route exists: a reply to the ADMIN carrying the change as a steps
       * button is minted for them, and their tap runs it under their own
       * permission. Say so where the model is deciding what to do next.
       */
      /**
       * Role-gated means EVERY write policy demands the role, not any policy
       * mentioning it: nearly every policy in this schema is written
       * "is_admin() OR <role clause>", and `checks` also folds in SELECT quals,
       * so a presence test fired on practically every table and sent coaches
       * with a fixable academy_id mistake down the routed-proposal path
       * (review find). Policies OR together — if one write policy passes
       * without the role, the writer can pass through it, and the repairable
       * advice is the right one.
       */
      const writeChecks = await writePolicyExpressions(ctx, table)
      const needsRole =
        writeChecks.length > 0 && writeChecks.every((e) => /\bis_admin\s*\(\)|\bsees_money\s*\(\)/.test(e))
      const actorIsAdmin =
        ctx.role !== 'user' ||
        (await withSession(serviceFrom(ctx), async (tx) => {
          const r = (await tx.unsafe(
            `select 1 from academy_admin where person_id = ${uid(String(ctx.personId ?? ''))}
              and academy_id = ${uid(ctx.academyId)}`,
          )) as unknown as unknown[]
          return r.length > 0
        // An unanswerable lookup defaults to ADMIN: the repairable-in-place
        // advice is recoverable (the model tries, fails, comes back); telling
        // an actual admin to route their own approval to themselves is not.
        }).catch(() => true))
      if (needsRole && !actorIsAdmin) {
        return (
          `writing to "${table}" is the admin's alone (the policy demands it), and this person is not the ` +
          `admin — no retry or rewording from this session can ever pass. Do not stop at telling them so: ` +
          `route the proposal. Send the ADMIN a reply — address it with to_contact_id 'admin'; you never ` +
          `need their contact row, and from this session you cannot see it — stating the exact change and ` +
          `carrying it as a steps button: their tap runs it under their own permission. (handoff also ` +
          `reaches them, without a button.) Then tell this person it is with the admin — only after that ` +
          `message actually sent.`
        )
      }
      return (
        `every row written to "${table}" must satisfy the policy: ${checks || 'academy_id = app.academy_id()'}. ` +
        `The usual cause is a missing academy_id: reads never need a tenant filter, but every INSERT must set ` +
        `academy_id = app.academy_id() explicitly, on every row. Add it and the same statement will pass.`
      )
    }

    const nn = NOT_NULL_RE.exec(message)
    if (nn) {
      return `"${nn[2]}"."${nn[1]}" has no default — the insert has to supply it. If it is academy_id, use app.academy_id().`
    }

    if (ON_CONFLICT_RE.test(message)) {
      const table = /insert into ([a-z_]+)/i.exec(message)?.[1]
      const keys = table ? await uniqueKeys(ctx, table) : ''
      return (
        `ON CONFLICT names columns that carry no unique constraint. ` +
        (keys ? `The unique keys that do exist are: ${keys}. ` : '') +
        `Either target one of those, or check with a SELECT first and insert only if it is missing.`
      )
    }

    const fk = FK_RE.exec(message)
    if (fk) {
      return `the referenced row does not exist (or is not visible to this person). Select the id first and use what comes back, never an id you remember.`
    }

    const chk = CHECK_RE.exec(message)
    if (chk) {
      return `the value is outside what "${chk[1]}" allows — the schema lists the permitted values for that column.`
    }

    const uq = UNIQUE_RE.exec(message)
    if (uq) {
      const detail = UNIQUE_DETAIL_RE.exec(message)
      const where = detail ? ` on (${detail[1]}) = (${detail[2]})` : ''
      return (
        `that row already exists${where} — "${uq[1]}" is a unique key, so this is a second copy of ` +
        `something the business already has, not a new one. Read the existing row back and work with ` +
        `it: say it is already there, or change the one that exists. Do not retry the insert with a ` +
        `different spelling to get past the constraint — a near-duplicate is the thing it is there to stop.`
      )
    }
  } catch {
    /* a hint is an improvement on the error, never a precondition for reporting it */
  }
  return null
}

/**
 * The write-command policies alone, one expression per policy. `INSERT`,
 * `UPDATE`, `DELETE` and `ALL` — a SELECT qual says who may look, which is a
 * different question from who may write, and folding the two together is what
 * made the role test above fire on every table.
 */
async function writePolicyExpressions(ctx: SessionCtx, table: string): Promise<string[]> {
  const rows = await withSession(serviceFrom(ctx), async (tx) => {
    return (await tx.unsafe(
      `select distinct coalesce(with_check, qual) as expr
         from pg_policies
        where schemaname = 'public' and tablename = ${lit(table)}
          and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
          and coalesce(with_check, qual) is not null
          and 'cm_user' = any (roles)`,
    )) as unknown as { expr: string }[]
  }).catch(() => [] as { expr: string }[])
  return rows.map((r) => r.expr)
}

/** The WITH CHECK (or USING) expressions a write to this table has to satisfy. */
async function policyExpressions(ctx: SessionCtx, table: string): Promise<string> {
  const rows = await withSession(serviceFrom(ctx), async (tx) => {
    return (await tx.unsafe(
      `select distinct coalesce(with_check, qual) as expr
         from pg_policies
        where schemaname = 'public' and tablename = ${lit(table)}
          and coalesce(with_check, qual) is not null
          and 'cm_user' = any (roles)`,
    )) as unknown as { expr: string }[]
  })
  return rows.map((r) => r.expr).join(' OR ')
}

/** The unique constraints that actually exist on a table. */
async function uniqueKeys(ctx: SessionCtx, table: string): Promise<string> {
  const rows = await withSession(serviceFrom(ctx), async (tx) => {
    return (await tx.unsafe(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = ${lit(table)} and c.contype in ('u','p')`,
    )) as unknown as { def: string }[]
  })
  return rows.map((r) => r.def).join('; ')
}

/**
 * A failed statement poisons a Postgres transaction, so anything allowed to
 * fail without taking the plan down with it runs inside a savepoint. Rolling
 * back to one also reverts the `set local role` inside it, which is what keeps
 * `asService` honest even on the failure path.
 */
async function inSavepoint<T>(tx: Tx, fn: (sp: Tx) => Promise<T>): Promise<T | null> {
  try {
    return (await tx.savepoint(async (sp) => fn(sp as unknown as Tx))) as T
  } catch {
    return null
  }
}

async function beginAuditSafe(
  tx: Tx,
  ctx: SessionCtx,
  intent: string,
  steps: PlanStep[],
  fallback = newId(),
): Promise<string> {
  // An audit that cannot start must not stop the work: it degrades to a
  // synthesized diff (§2.3 still holds — those counts come from the statements
  // themselves), and `undo` then says plainly that it has no before-images
  // rather than pretending it can reverse something.
  // Under the caller's own role on purpose: `app.begin_audit` is SECURITY
  // DEFINER precisely so a cm_user plan can open its own audit entry, and it
  // refuses an academy_id that is not the session's tenant.
  const id = await inSavepoint(tx, (sp) =>
    beginAudit(sp, {
      academyId: ctx.academyId,
      actorPersonId: ctx.role === 'service' ? null : ctx.personId,
      intent,
      plan: steps,
    }),
  )
  return id || fallback
}

/**
 * The diff, read INSIDE the transaction that produced it — the only place it
 * exists before commit (§2.3). `row_snapshot` carries `academy_id` so a plan's
 * own author can read its own blast radius back under their own role, which is
 * also the tightest scoping available: the diff a user sees is their tenant's.
 */
async function readDiffSafe(tx: Tx, ctx: SessionCtx, auditId: string): Promise<TableDiff[]> {
  const raw = await inSavepoint(tx, (sp) => readDiffIn(sp, auditId))
  return normalizeDiffs(raw)
}

/**
 * What this plan just put in two places at once (`./clash`), as plan notes.
 *
 * A `note` is the right home for it: it is the one part of a plan written in
 * the business's own words, so the overlap rides into `buildSummary` and out
 * through every surface that already carries a summary — the preview the admin
 * taps, the receipt, and the runtime's own line under a `steps` button
 * (`withRuntimeDiffLine`). Doctrine's *the cost goes before the tap* asks for it, and
 * this is the sentence that puts it there without anybody composing it.
 *
 * The same sentence in both note lists, in lockstep with `runSteps`. A coach
 * can reach one of these — `claim_cover` puts them on a session that lands on
 * top of their own — and their receipt is the `personal` one, so leaving it out
 * would be the only case where the person double-booked is not told.
 *
 * In a savepoint, so a plan can never fail because of a check that only had
 * something to add.
 */
async function noteClashes(
  tx: Tx,
  ctx: SessionCtx,
  diffs: TableDiff[],
  state: RunState,
): Promise<string[]> {
  /**
   * `inSavepoint` returns null when the check itself failed, and `?? []` used to
   * collapse that into the same value as "ran, found nothing" — so a crashed
   * double-booking check was indistinguishable from a clean one, and the silence
   * read as clearance. That is the failure this whole check exists to prevent,
   * one layer up: the model looks sideways, gets "no conflicts", and writes.
   *
   * The distinction already existed in the return type; only the `??` threw it
   * away. A check that did not run now says so, in the same note list a real
   * clash uses — so it rides into `buildSummary`, the preview, and the receipt,
   * and a person decides with the uncertainty in front of them. Still never
   * fatal: an overlap is sometimes intended, and a check that could not run is
   * not grounds to refuse a plan.
   */
  const found = await inSavepoint(tx, (sp) => coachClashes(sp, ctx.academyId, diffs))
  if (found === null) {
    const note =
      'the double-booking check could not run on this one, so nothing here rules out the coach already being somewhere else at that time'
    state.notes.push(note)
    state.personalNotes.push(note)
    return []
  }
  state.notes.push(...found)
  state.personalNotes.push(...found)
  return found
}

/**
 * Whose arrangements this plan changed while telling them nothing (`./untold`).
 *
 * A note, for the same reason a clash is one: it is written in the business's
 * own words, so it rides `buildSummary` out through the preview, the receipt and
 * the runtime's line under a `steps` button, and the model reads it as a fact in
 * the tool result rather than as advice.
 *
 * **Not on the personal note list.** A `personal` receipt is addressed to the
 * person the change is about, and "two families are affected and nothing tells
 * them" is an operator's sentence — to a parent reading their own confirmation
 * it is somebody else's business, and naming those families to them would be the
 * leak this product's whole boundary exists to prevent.
 *
 * In a savepoint, so a plan can never fail because of a check that only had
 * something to add.
 */
async function noteUntold(
  tx: Tx,
  ctx: SessionCtx,
  diffs: TableDiff[],
  state: RunState,
): Promise<string[]> {
  const told = state.staged.map((m) => m.toContactId)
  const actor = ctx.role === 'user' ? ctx.personId : null
  const found = await inSavepoint(tx, (sp) => untoldAudience(sp, ctx.academyId, diffs, told, actor))
  // Same distinction `noteClashes` makes: a check that could not run is not a
  // check that found nothing, and collapsing the two turns a crash into
  // clearance. Said in the note list so a person decides with the uncertainty in
  // front of them.
  if (found === null) {
    const note =
      'the affected-but-untold check could not run on this one, so nothing here rules out somebody being changed without being told'
    state.notes.push(note)
    return []
  }
  state.notes.push(...found)
  return found
}

/** Substitutes the audit id a button could not know at compose time (see `undo`). */
function bindAudit<T>(value: T, auditId: string): T {
  if (typeof value === 'string') return (value === '$AUDIT_ID' ? auditId : value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => bindAudit(v, auditId)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = bindAudit(v, auditId)
    return out as unknown as T
  }
  return value
}

async function flushOutbox(
  ctx: SessionCtx,
  staged: Staged[],
  auditId: string,
): Promise<SendOutcome[]> {
  const svc: SessionCtx = serviceFrom(ctx)
  const outcomes: SendOutcome[] = []
  for (let i = 0; i < staged.length; i++) {
    const m = staged[i]
    try {
      const buttons: Button[] = []
      for (const b of m.buttons ?? []) {
        const actionId = await mintAction(svc, {
          payload: bindAudit(b.action, auditId),
          forContactId: m.toContactId,
          ttlMinutes: b.ttl_minutes ?? 1440,
        })
        // Not trimmed. A title over the cap is a compose bug in whoever wrote it,
        // and `validateOutbound` at the wire says so with the reason — where a
        // silent `slice(0, 20)` renders "I'm done with the ro" and ships it.
        buttons.push({ actionId, title: b.title })
      }
      // A catalog id the catalog does not know is not a catalog id: it would
      // otherwise ride onto the message row and out into the event log as a
      // moment nobody can look up.
      const catalogId = m.catalog_id && m.catalog_id in CATALOG ? (m.catalog_id as CatalogId) : null
      const entry = catalogId ? CATALOG[catalogId] : undefined
      const raw: OutboundMessage = {
        toContactId: m.toContactId,
        // Whole, or refused at the wire. The ellipsis this used to append was a
        // sentence somebody else finished.
        body: m.body,
        header: m.header,
        footer: m.footer,
        buttons: buttons.length ? buttons.slice(0, LIMITS.buttons) : undefined,
        catalogId,
        templateName: entry ? entry.template : null,
        idempotencyKey: idem('plan', auditId, String(i)),
        subjectPersonIds: m.subject_person_ids,
        /**
         * The second door a routed question can leave by.
         *
         * An operation that stages its own confirmation sets this explicitly and
         * that always wins — `??` rather than `||`, so a deliberate `false` from
         * a protocol is respected. What is being caught is the model-authored
         * message step, which has no way to set it: the declared `{"message":…}`
         * shape carries `body`, `catalog_id`, `subject_person_ids` and `buttons`
         * and nothing else, by design. Same reasoning as the `reply` executor —
         * a committing button on a message to somebody other than the person
         * whose turn this is asks a question only their tap can answer, and the
         * runtime is the only party here that can know it.
         */
        isConfirmationRequest:
          m.is_confirmation_request ??
          (('contactId' in ctx && ctx.contactId !== m.toContactId) &&
            (m.buttons ?? []).some(
              (b) =>
                b.action?.kind === 'steps' ||
                // `String(op)` deliberately: commit is a TOOL, not an operation,
                // so it is not in `OperationName` and a typed comparison never
                // matches. Same idiom as `tools.ts`'s action reader.
                (b.action?.kind === 'operation' && String(b.action.op) === 'commit'),
            )),
        isEscalation: m.is_escalation,
        fixed: m.fixed ?? entry?.fixed ?? false,
        preLaunchOk: m.pre_launch_ok,
        optOutAck: m.opt_out_ack,
        confirmation: m.confirmation,
        // §16.3 — this path sends as `svc` because it mints actions and touches
        // infrastructure, but the *message* is still a reply to the person whose
        // turn this is. Losing that distinction here made every plan's read-back
        // an unsolicited interruption, so a confirmation could be dropped by the
        // frequency cap while the plan it confirmed had already run.
        solicited: ctx.role !== 'service' && 'contactId' in ctx && ctx.contactId === m.toContactId,
      }
      /**
       * **Nothing is repaired here either.** The outbox used to run
       * `repairOutbound` on the way past, because it is the second door to the
       * wire and a repair applied on one door is a repair applied on one door.
       * The right resolution of that asymmetry turned out to be removing the
       * repairs rather than duplicating them: a model-authored message step is
       * checked when the plan is validated (`steps.ts`), where a refusal costs a
       * round the model still has; an operation-authored one has a single author
       * already, and editing it here would only hide a bug in that operation.
       */
      const outcome = await send(svc, raw)
      // The message id exists only now, so this is where the buttons learn which message
      // they were printed on (0016). Without it every button on a staged message stays an
      // independent row: tap `[Do it]`, the plan commits — then tap `[Cancel]` on the same
      // message and it fires its own `noop`, replying "Left as it was — nothing changed."
      // about work that did happen, on the one path with no model in the loop to catch it.
      //
      // `raw.buttons`, which is now exactly what was minted: with the repairs gone
      // nothing between here and the wire can drop one. A button on a message that
      // was suppressed is never printed, keeps a null `message_id`, and simply
      // lapses at its TTL, as every action did before 0016.
      await attachActionsToMessage(svc, outcome.messageId, (raw.buttons ?? []).map((b) => b.actionId))
      outcomes.push(
        outcome.status === 'queued' || outcome.status === 'sent'
          ? { ...outcome, toContactId: m.toContactId, confirmationRequest: Boolean(m.is_confirmation_request) }
          : outcome,
      )
    } catch (e) {
      outcomes.push({
        status: 'failed',
        reason: e instanceof Error ? e.message : String(e),
        messageId: null,
      })
    }
  }
  return outcomes
}

/**
 * The whole plan is one audit entry carrying the intent that produced it — and
 * the ids of everyone it told, which is what lets `undo` send a correction to
 * exactly those people (§7.2).
 */
async function recordAudit(
  ctx: SessionCtx,
  auditId: string,
  intent: string,
  steps: PlanStep[],
  diffs: TableDiff[],
  state: RunState,
  outcomes: SendOutcome[],
): Promise<void> {
  const told = state.staged.map((m, i) => ({
    contact_id: m.toContactId,
    body: m.body,
    catalog_id: m.catalog_id ?? null,
    status: outcomes[i]?.status ?? 'failed',
  }))
  const payload = { diffs, messages: told, scheduled: state.scheduled, summary: buildSummary(diffs, state) }
  try {
    await withSession(serviceFrom(ctx), async (tx) => {
      const res = (await tx.unsafe(
        `update audit_entry set intent = ${lit(intent)}, plan = ${jsonLit(steps)},
                diff = ${jsonLit(payload)}
          where id = ${uid(auditId)}`,
      )) as unknown
      if (rowCount(res) === 0) {
        await tx.unsafe(
          `insert into audit_entry (id, academy_id, actor_person_id, intent, plan, diff)
           values (${uid(auditId)}, ${uid(ctx.academyId)},
                   ${ctx.role === 'user' ? uid(ctx.personId) : 'null'},
                   ${lit(intent)}, ${jsonLit(steps)}, ${jsonLit(payload)})`,
        )
      }
    })
  } catch {
    // Recording the trail must never undo the work it describes.
  }
}

/* ------------------------------------------------------------------------- *
 * §14.2 — preview scales with blast radius
 * ------------------------------------------------------------------------- */

/** §14.2 "money-touching — tally lines, adjustments, payments". */
const MONEY_TABLES = new Set(['payment', 'tally_line', 'rate_period'])
/** The business's own controls: its settings, its number's credentials, who is an admin. */
const CONTROL_TABLES = new Set(['academy', 'sender', 'academy_admin'])
/**
 * The money operations that survived the wrapper cull, and why this list is now
 * nearly empty rather than gone.
 *
 * `waive`, `record_payment`, `request_payment` and `confirm_payment` were here.
 * They were also, every one of them, a write to `payment` or `tally_line` — and
 * `MONEY_TABLES` below catches those from the diff, whoever composed the
 * statement. So the list was doing no work the census was not already doing, on
 * the paths it covered, and none at all on the path the product is moving
 * towards: the model composing the SQL itself. `hasAdjust` covers what `waive`
 * used to declare.
 *
 * `convert_trial` stays because it is the one money decision whose diff does not
 * look like money: it updates an ENROLLMENT, and what makes it consequential is
 * that it starts the billing. A gate that reads only the tables touched cannot
 * see that, which is exactly what this set is for.
 */
const MONEY_OPS = new Set<OperationName>(['convert_trial'])

/**
 * A plan big enough that "I created some things" stops being a sentence anyone
 * can check. Deliberately generous: it is a bulk-change backstop, not a gate on
 * data entry.
 */
const BULK_ROWS = 40

/**
 * Preview when the change reaches past the person making it.
 *
 * @mechanism needsPreview — whether a change costs a confirmation is decided from the plan's
 *   own result rather than from who composed the SQL: a preview is required when it messages
 *   somebody other than the person acting, deletes rows, changes more than one row that
 *   already existed, touches money or the business's own controls, collides with itself
 *   (`clashes`), or runs past ~40 rows — and never for creating rows nobody has been told
 *   about yet. Gating on authorship instead taxed exactly the direction the product is going
 *   and made onboarding a confirmation per venue; gating on nothing lets a bulk change or a
 *   coach booked into two places commit unattended and be described in the past tense.
 *
 * | Reaches past them                                       | Preview          |
 * |----------------------------------------------------------|------------------|
 * | Messages someone other than the person acting             | preview          |
 * | Removes rows, or changes rows that already existed (>1)   | preview          |
 * | Touches money — payments, tally lines, adjustments        | preview          |
 * | Touches the business's own settings or credentials        | preview          |
 * | An operation that declares itself destructive             | preview          |
 * | Bulk by any measure — more than ~40 rows                  | preview          |
 * | Anything else, including creating new rows                | execute directly |
 *
 * **Authorship is not on that list any more, and its removal is the point.**
 * The old rule's fifth row was "raw SQL rather than a named operation → always
 * preview", which measures who *wrote* the statement rather than what it does.
 * The runtime already knows what it does: the plan runs in a transaction, the
 * audit triggers capture every row touched, and the diff is read back before
 * commit. Guessing from authorship on top of that taxed exactly the direction
 * the product is going — a shrinking operation registry with model-authored SQL
 * for everything else.
 *
 * What it cost was visible the first time a real business was set up by talking
 * to it. Creating one venue — one INSERT, nobody messaged, nothing destroyed —
 * came back as *"I'm going to create a new venue called Green Park Hall. Does
 * that look right?"*, and so did the classes, and so would the coaches and the
 * families. **Onboarding is data entry, and gating data entry behind a
 * confirmation per row is how onboarding takes an hour instead of minutes.**
 *
 * The distinction that replaced it: creating rows nobody has been told about yet
 * is not a blast radius. Changing or removing rows that already exist is, and so
 * is anything that puts a message on someone else's phone. `undo` covers the
 * rest — it is why data entry can be cheap.
 *
 * Two judgement calls kept from the original, both made where the spec makes them:
 *
 * 1. A `tally_line` minted mechanically by marking attendance is not a money
 *    DECISION. §14.2 puts attendance in the execute-directly row and §6.4 makes
 *    the line an automatic consequence of the mark, so a single own-scope
 *    operation is exempt and an explicit money operation is not.
 * 2. A register writing a line per player is one act on one session by the
 *    person responsible for it. Counting rows would put a diff in front of a
 *    coach standing on a court — the exact friction row 1 exists to remove.
 *
 * Note what does NOT appear here: a button tap. A tap replays a payload minted
 * at compose time, when the preview already happened; re-previewing it would be
 * asking the same question twice.
 */
export function needsPreview(
  result: PlanResult,
  steps: PlanStep[],
  o?: { actorContactId?: string },
): boolean {
  // §2.7's media clause — "anything read from an image, voice note or document
  // is read back before it is acted on" — used to be enforced here, from a
  // runtime flag set whenever a turn carried an attachment. The model is
  // text-only now: no turn carries one, the flag was always false, and a
  // condition that cannot fire is worse than no condition, because it reads as
  // cover that is not there. The invariant itself survives in the rules below —
  // every multi-row write is still previewed, and a timetable typed in one messy
  // sentence is exactly as misreadable as a photographed one was.

  const hasAdjust = steps.some((s) => 'adjust' in s)

  // Anyone other than the person acting hearing about this makes it outward-facing,
  // and outward-facing is the whole reason previews exist. Without an actor to
  // compare against, fall back to "more than one message is a broadcast".
  const toOthers = o?.actorContactId
    ? result.stagedMessages.filter((m) => m.toContactId !== o.actorContactId).length
    : Math.max(0, result.stagedMessages.length - 1)
  if (toOthers > 0) return true

  // Nothing changed and nobody else hears about it — there is nothing to preview.
  // This is the read-back half of an operation that gates itself (a cancellation
  // confirmation, an opt-out confirmation, undo's "here is what I would put back").
  if (!hasAdjust && result.totalRows === 0) return false

  if (hasAdjust) return true
  for (const s of steps) {
    if ('operation' in s) {
      const def = OPERATIONS[s.operation.name]
      if (!def) return true
      if (def.destructive) return true
      if (MONEY_OPS.has(s.operation.name)) return true
    }
  }

  if (result.diffs.some((d) => CONTROL_TABLES.has(d.table))) return true

  /**
   * Judgement call 1, enforced in the order the comment above always claimed:
   * a single own-scope operation is exempt BEFORE the money-tables test runs,
   * because a `tally_line` minted mechanically by marking attendance is not a
   * money decision — §14.2 puts the register in the execute-directly row, and
   * §6.4 makes the line an automatic consequence of the mark. F-P found the
   * old order tested money tables first, so a register at a per_session rate
   * put a diff in front of a coach standing on a court — the exact friction
   * row 1 exists to remove. Explicit money operations and adjustments still
   * gate above; a plan that messages anyone else still gates at `toOthers`.
   */
  const earlyOwnScope =
    steps.length === 1 && 'operation' in steps[0] && Boolean(OPERATIONS[steps[0].operation.name]?.ownScope)
  if (earlyOwnScope) return false

  /**
   * A plan can be consequential for what it collides with rather than for how
   * much it writes.
   *
   * Every other test here is a census — of rows, of money, of recipients — and
   * a coach booked into two places at once registers on none of them. Creating
   * one was three inserts, nobody else's money and nothing deleted, so it ran
   * unattended and was described to the admin in the past tense
   * (`tn-two-places`). This is the line that makes a contradiction cost a tap,
   * and the tap is also the override: an overlap the admin actually means is
   * confirmed the same way everything else is, so nothing needs a flag.
   *
   * **Below `earlyOwnScope` deliberately.** The only way a non-admin reaches a
   * clash is by confirming or un-declining a session somebody else assigned
   * them — `claim_cover`, which is own-scope and first-tap-wins. Gating that
   * would put a diff in front of a coach standing on a court (F-P) and lose
   * them the race besides, to tell them something they are about to be told
   * anyway: the overlap is a plan note, so it is in their receipt either way.
   * Deciding about your own day is not a proposal.
   */
  if (result.clashes.length) return true

  if (result.diffs.some((d) => MONEY_TABLES.has(d.table))) return true

  // Removing anything, or changing more than one row that already existed.
  const changed = result.diffs
    .filter((d) => d.op !== 'insert')
    .reduce((n, d) => n + d.count, 0)
  if (result.diffs.some((d) => d.op === 'delete')) return true
  if (changed > 1) return true

  if (result.totalRows > BULK_ROWS) return true

  return false
}

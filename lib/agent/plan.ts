/**
 * lib/agent/plan.ts — `transaction(steps[])`, the runtime that makes
 * model-composed atomicity safe (§14.2, §14.2.1, §2.3, §2.5).
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
import { idem, newId } from '@/lib/ids'
import { now } from '@/lib/clock'
import { adminContactIds, resolveIdentity } from '@/lib/identity'
import { attachActionsToMessage, mintAction, type ActionPayload } from '@/lib/actions'
import { send } from '@/lib/messaging/send'
import { composeAndSend } from '@/lib/messaging/compose'
import { repairOutbound } from '@/lib/messaging/repair'
import { LIMITS, type Button, type OutboundMessage, type SendOutcome } from '@/lib/messaging/types'
import { CATALOG, type CatalogId } from '@/lib/messaging/catalog'
import { isJobKind, JOB_KINDS, type JobKind } from '@/lib/jobs'
import type { Academy, Contact, Identity, Person, Role } from '@/lib/types'
import { beginAudit, readDiffIn } from '@/lib/audit'
import { OPERATIONS, jsonLit, lit, moneyLit, uid, type OperationName } from './operations'
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
 *   - `note`              — a summary fragment. Executes nothing; it is how an
 *                           operation contributes "all of Saturday Advanced,
 *                           moving to 8:30" to the §14.2 sentence.
 */
export type PlanStep =
  | { write: string; service?: boolean; requireRows?: number }
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
  stagedMessages: { toContactId: string; preview: string }[]
  scheduled: { kind: string; run_at: string }[]
  summary: string
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

async function assertIdsExist(ctx: SessionCtx, operation: string, args: unknown): Promise<void> {
  if (!args || typeof args !== 'object') return
  const checks: { key: string; table: string; value: string }[] = []
  for (const [key, raw] of Object.entries(args as Record<string, unknown>)) {
    const table = ID_ARG_TABLES[key]
    if (!table) continue
    for (const value of Array.isArray(raw) ? raw : [raw]) {
      // A subquery resolves inside the transaction against rows an earlier step made,
      // so there is nothing here to check yet — the plan itself is the check.
      if (typeof value !== 'string' || !UUID_ARG_RE.test(value)) continue
      checks.push({ key, table, value })
    }
  }
  if (!checks.length) return

  const missing: string[] = []
  await withSession(ctx, async (tx) => {
    for (const c of checks) {
      const rows = (await tx.unsafe(
        `select 1 from ${c.table} where id = ${uid(c.value)} limit 1`,
      )) as unknown as unknown[]
      if (!rows.length) missing.push(`${c.key} ${c.value} is not a ${c.table} you can see`)
    }
  })
  if (missing.length) {
    // The query that answers it, named. Without this the model's next move — watched —
    // was to ask the admin to "confirm Ravi Menon's coach ID", which is a uuid, in a
    // WhatsApp message, to somebody who has never seen one.
    const reads = [...new Set(checks.filter((c) => missing.some((m) => m.startsWith(c.key))).map((c) => c.table))].map(
      (t) =>
        t === 'coach'
          ? 'select c.id, p.full_name from coach c join person p on p.id = c.person_id'
          : t === 'player'
            ? 'select pl.id, p.full_name from player pl join person p on p.id = pl.person_id'
            : `select id, name from ${t}`,
    )
    throw new Error(
      `${operation}: ${missing.join('; ')}. Read it back first — ${reads.join(' · ')} — and use the id that comes ` +
        'out. Never a uuid you have not read, and never ask a person for one. If you meant a row an earlier step ' +
        'in this same plan creates, write it as `(select id from … )` instead.',
    )
  }
}

const UUID_ARG_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function expand(
  ctx: SessionCtx,
  steps: PlanStep[],
  depth: number,
  identity?: Identity,
): Promise<PlanStep[]> {
  const out: PlanStep[] = []
  let id = identity
  for (const step of steps) {
    if ('operation' in step) {
      if (depth >= 4) throw new Error('plan: operations nested too deep')
      const def = OPERATIONS[step.operation.name]
      if (!def) throw new Error(`plan: unknown operation "${step.operation.name}"`)
      id ??= await identityFor(ctx)
      const args = def.params.parse(step.operation.args ?? {})
      await assertIdsExist(ctx, step.operation.name, args)
      const built = await def.build(ctx, args, id)
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
      out.push(...(await expand(ctx, built, depth + 1, id)).map(
        (s) => ('message' in s ? { ...s, message: { ...s.message, fromOperation: true } } : s),
      ))
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
  staged: Staged[]
  scheduled: { kind: string; run_at: string }[]
  notes: string[]
  /** The same notes in the voice used when the recipient is the subject. */
  personalNotes: string[]
  exec: { table: string; op: 'insert' | 'update' | 'delete'; count: number }[]
  /**
   * Raw `write` steps the MODEL authored that matched no row — see `emptyWrites`
   * in `buildSummary`. Counted separately from `exec` because `exec` drops
   * zero-count entries when it becomes a diff, which is how a write that did
   * nothing became indistinguishable from one that was never written.
   */
  emptyWrites: number
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
      assertSingleWriteStatement(step.write)
      const run = () => tx.unsafe(step.write) as unknown as Promise<unknown>
      const res = step.service ? await asService(tx, ctx, run) : await run()
      const n = rowCount(res)
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
      if (n === 0 && step.requireRows === undefined) state.emptyWrites++
      if (step.requireRows !== undefined && n < step.requireRows) {
        throw new PlanAbort(
          'PRECONDITION_FAILED',
          `a step needed ${step.requireRows} row(s) and matched ${n} — the world moved under this plan`,
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
      const res = (await tx.unsafe(sql)) as unknown
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

  const parts = [...diffs]
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((d) => `${(done ? VERB_DONE : VERB)[d.op]} ${d.count} ${plural(d.table, d.count)}`)

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
   * Say when a step matched nothing. R7: "doing nothing succeeds" is the only
   * root whose failures a reader of the transcript scores as a pass, and this is
   * the sentence that stops it doing so here. It is deliberately blunt and
   * deliberately not an abort — the rest of the plan committed, the person needs
   * to know which part of what they were promised did not happen, and rolling
   * back a correct closure because a follow-on write missed would be worse.
   */
  if (state.emptyWrites > 0) {
    s += ` ${state.emptyWrites} step${state.emptyWrites === 1 ? '' : 's'} matched no rows and ${
      state.emptyWrites === 1 ? 'changed' : 'change'
    } nothing — check that part landed.`
  }
  if (state.unaddressed > 0) {
    s += ` ${state.unaddressed} message${state.unaddressed === 1 ? '' : 's'} had nobody to go to.`
  }

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
  const reached = outcomes
    ? outcomes.filter((o) => o.status === 'sent' || o.status === 'queued').length
    : state.staged.length
  if (done) {
    const missed = state.staged.length - reached
    if (reached === 1) s += ' 1 person has been told.'
    else if (reached > 1) s += ` ${reached} people have been told.`
    if (missed > 0) {
      // Named, not swallowed. A message that did not go is the thing the admin has to
      // act on, and every suppression is already a row carrying its reason.
      s +=
        reached === 0
          ? ` Nobody was told — ${missed === 1 ? 'that message' : `all ${missed} messages`} did not go out.`
          : ` ${missed} did not go out.`
    }
  } else if (state.staged.length === 1) s += ' 1 person hears about it.'
  else if (state.staged.length > 1) s += ` ${state.staged.length} people hear about it.`
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

function emptyState(): RunState {
  return { staged: [], scheduled: [], notes: [], personalNotes: [], exec: [], emptyWrites: 0, unaddressed: 0 }
}

/**
 * A plan whose whole purpose was to change something, and changed nothing, failed.
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
  const changers = expanded.filter((s) => 'write' in s || 'adjust' in s)
  if (!changers.length) return
  throw new PlanAbort(
    'CHANGED_NOTHING',
    `that changed nothing — ${changers.length} write(s) ran and every one of them matched no rows. ` +
      'Either the WHERE matched nothing (read it back and check the id), or this person is not allowed ' +
      'to change those rows and the database quietly did nothing rather than refusing. Do not say it is done.',
  )
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
): Promise<PlanResult> {
  const state = emptyState()
  // Hoisted so the catch can tell a refusal from a missing row — that diagnosis
  // needs the steps, and inside the try they are out of scope by the time it throws.
  let expanded: PlanStep[] = []
  try {
    expanded = await expand(ctx, steps, 0)
    const diffs = await withRollback(ctx, async (tx) => {
      const auditId = await beginAuditSafe(tx, ctx, 'preview', steps)
      await runSteps(tx, ctx, expanded, state)
      return await readDiffSafe(tx, ctx, auditId)
    })
    const merged = diffs.length ? diffs : synthDiffs(state.exec)
    assertSomethingChanged(expanded, merged)
    return {
      ok: true,
      diffs: merged,
      totalRows: merged.reduce((n, d) => n + d.count, 0),
      stagedMessages: state.staged.map((m) => ({ toContactId: m.toContactId, preview: previewOf(m) })),
      scheduled: state.scheduled,
      summary: buildSummary(merged, state),
    }
  } catch (e) {
    return failed(state, e, await hintFor(ctx, e, expanded, state.notes, intent))
  }
}

/**
 * The best sentence available about why this failed.
 *
 * `CHANGED_NOTHING` is the one failure whose cause the error itself cannot name,
 * so it gets the extra round trip; everything else is diagnosable from the
 * Postgres message alone.
 */
async function hintFor(
  ctx: SessionCtx,
  e: unknown,
  expanded: PlanStep[],
  /** The plan's own notes — business language, written by the operation, no SQL. */
  notes: string[] = [],
  intent?: string,
): Promise<string | null> {
  if (e instanceof PlanAbort && e.code === 'CHANGED_NOTHING') {
    const refusal = await refusalHint(ctx, expanded, notes, intent)
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
  const state = emptyState()
  let auditId = newId()
  // Hoisted for the same reason as in `previewPlan`: the catch needs the steps
  // to tell an RLS refusal from a WHERE that matched nothing.
  let expanded: PlanStep[] = []
  try {
    expanded = await expand(ctx, steps, 0)
    const diffs = await withSession(ctx, async (tx) => {
      auditId = await beginAuditSafe(tx, ctx, intent, steps, auditId)
      await runSteps(tx, ctx, expanded, state)
      return await readDiffSafe(tx, ctx, auditId)
    })
    // ---- committed. Only now does anything reach the wire. ----
    const merged = diffs.length ? diffs : synthDiffs(state.exec)
    assertSomethingChanged(expanded, merged)
    const outcomes = await flushOutbox(ctx, state.staged, auditId)
    await recordAudit(ctx, auditId, intent, steps, merged, state, outcomes)
    const receipt = buildSummary(merged, state, 'done', audience, outcomes)
    return {
      ok: true,
      auditId,
      outcomes,
      diffs: merged,
      totalRows: merged.reduce((n, d) => n + d.count, 0),
      stagedMessages: state.staged.map((m) => ({ toContactId: m.toContactId, preview: previewOf(m) })),
      scheduled: state.scheduled,
      summary: receipt,
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
    summary: 'Nothing was changed and nobody was messaged.',
    error: (e instanceof PlanAbort ? `${e.code}: ${message}` : message) + (hint ? ` — ${hint}` : ''),
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
  ctx: SessionCtx, expanded: PlanStep[], notes: string[] = [], intent?: string,
): Promise<string | null> {
  if (ctx.role === 'service') return null
  const writes = expanded.filter((s): s is PlanStep & { write: string } => 'write' in s)
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
    return (
      `the rows genuinely do not exist — the same writes match nothing even with no permissions in the way. ` +
      `The WHERE is wrong, not the permission. Read the row back and check the id before writing again.`
    )
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
        buttons.push({ actionId, title: b.title.slice(0, LIMITS.buttonTitleChars) })
      }
      // A catalog id the catalog does not know is not a catalog id: it would
      // otherwise ride onto the message row and out into the event log as a
      // moment nobody can look up.
      const catalogId = m.catalog_id && m.catalog_id in CATALOG ? (m.catalog_id as CatalogId) : null
      const entry = catalogId ? CATALOG[catalogId] : undefined
      const limit = buttons.length ? LIMITS.bodyChars : LIMITS.textChars
      const raw: OutboundMessage = {
        toContactId: m.toContactId,
        body: m.body.length > limit ? `${m.body.slice(0, limit - 1)}…` : m.body,
        header: m.header,
        footer: m.footer,
        buttons: buttons.length ? buttons.slice(0, LIMITS.buttons) : undefined,
        catalogId,
        templateName: entry ? entry.template : null,
        idempotencyKey: idem('plan', auditId, String(i)),
        subjectPersonIds: m.subject_person_ids,
        isConfirmationRequest: m.is_confirmation_request,
        isEscalation: m.is_escalation,
        fixed: m.fixed ?? entry?.fixed ?? false,
        preLaunchOk: m.pre_launch_ok,
        optOutAck: m.opt_out_ack,
        // §16.3 — this path sends as `svc` because it mints actions and touches
        // infrastructure, but the *message* is still a reply to the person whose
        // turn this is. Losing that distinction here made every plan's read-back
        // an unsolicited interruption, so a confirmation could be dropped by the
        // frequency cap while the plan it confirmed had already run.
        solicited: ctx.role !== 'service' && 'contactId' in ctx && ctx.contactId === m.toContactId,
      }
      // The outbox is the second path to the wire — `composeAndSend` is the first — so the
      // repairs that belong to "an outbound message" have to run on both or they run on
      // whichever one the model happened to choose. Bracket labels are only stripped here
      // rather than promoted: the actions on this path were already minted above, and a
      // button with no action id is a worse message than a sentence with no button.
      const { message: msg, repairs } = repairOutbound(raw)
      if (repairs.length) {
        console.warn(`[plan] repaired a staged message to ${m.toContactId}: ${repairs.join('; ')}`)
      }
      const outcome = await send(svc, msg)
      // The message id exists only now, so this is where the buttons learn which message
      // they were printed on (0016). Without it every button on a staged message stays an
      // independent row: tap `[Do it]`, the plan commits — then tap `[Cancel]` on the same
      // message and it fires its own `noop`, replying "Left as it was — nothing changed."
      // about work that did happen, on the one path with no model in the loop to catch it.
      //
      // `msg.buttons`, not the array minted above: repair and the wire's cap can drop one,
      // and a button that was never printed belongs to no message. It keeps a null
      // `message_id` and simply lapses at its TTL, as every action did before 0016.
      await attachActionsToMessage(svc, outcome.messageId, (msg.buttons ?? []).map((b) => b.actionId))
      outcomes.push(outcome)
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
const MONEY_TABLES = new Set(['payment', 'tally_line'])
/** The business's own controls: its settings, its number's credentials, who is an admin. */
const CONTROL_TABLES = new Set(['academy', 'sender', 'academy_admin'])
const MONEY_OPS = new Set<OperationName>([
  'waive',
  'record_payment',
  'request_payment',
  // A tap never re-previews (the preview already happened at mint), so this only
  // binds when the model reaches for it directly — which is exactly when a money
  // state transition should be read back before it commits.
  'confirm_payment',
])

/**
 * A plan big enough that "I created some things" stops being a sentence anyone
 * can check. Deliberately generous: it is a bulk-change backstop, not a gate on
 * data entry.
 */
const BULK_ROWS = 40

/**
 * Preview when the change reaches past the person making it.
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

  if (result.diffs.some((d) => MONEY_TABLES.has(d.table) || CONTROL_TABLES.has(d.table))) return true

  // Row 1: a single own-scope named operation executes directly.
  const singleOwnScope =
    steps.length === 1 && 'operation' in steps[0] && Boolean(OPERATIONS[steps[0].operation.name]?.ownScope)
  if (singleOwnScope) return false

  // Removing anything, or changing more than one row that already existed.
  const changed = result.diffs
    .filter((d) => d.op !== 'insert')
    .reduce((n, d) => n + d.count, 0)
  if (result.diffs.some((d) => d.op === 'delete')) return true
  if (changed > 1) return true

  if (result.totalRows > BULK_ROWS) return true

  return false
}

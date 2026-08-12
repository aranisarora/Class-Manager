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
  withRollback,
  withSession,
  type SessionCtx,
  type Tx,
} from '@/lib/db'
import { idem, newId } from '@/lib/ids'
import { resolveIdentity } from '@/lib/identity'
import { mintAction, type ActionPayload } from '@/lib/actions'
import { send } from '@/lib/messaging/send'
import { LIMITS, type Button, type OutboundMessage, type SendOutcome } from '@/lib/messaging/types'
import { CATALOG, type CatalogId } from '@/lib/messaging/catalog'
import type { JobKind } from '@/lib/jobs'
import type { Academy, Contact, Identity, Person, Role } from '@/lib/types'
import { z } from 'zod'
import { beginAudit, readDiffIn } from '@/lib/audit'
import { OPERATIONS, jsonLit, lit, moneyLit, uid, type OperationName } from './operations'

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
  | { note: string }

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
 * Model-facing validation. Anything the model authors goes through this, so
 * the internal fields above cannot be smuggled in: zod's object parser drops
 * keys it does not know about.
 * ------------------------------------------------------------------------- */

const ActionPayloadSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal('operation'),
      op: z.string(),
      args: z.record(z.unknown()).default({}),
    }),
    z.object({
      kind: z.literal('steps'),
      steps: z.array(z.lazy(() => PlanStepSchema)),
      summary: z.string(),
    }),
    z.object({ kind: z.literal('reply'), text: z.string() }),
    z.object({ kind: z.literal('view'), viewSpecId: z.string() }),
    z.object({ kind: z.literal('menu'), menu: z.string() }),
    z.object({ kind: z.literal('noop'), ack: z.string() }),
  ]),
)

const MessageStepSchema = z.object({
  to_contact_id: z.string().optional(),
  to_person_id: z.string().optional(),
  body: z.string().min(1),
  header: z.string().optional(),
  footer: z.string().optional(),
  buttons: z
    .array(
      z.object({
        title: z.string().min(1),
        action: ActionPayloadSchema,
        ttl_minutes: z.number().int().positive().optional(),
      }),
    )
    .max(LIMITS.buttons)
    .optional(),
  catalog_id: z.string().nullable().optional(),
  fixed: z.boolean().optional(),
  subject_person_ids: z.array(z.string()).optional(),
  is_confirmation_request: z.boolean().optional(),
  is_escalation: z.boolean().optional(),
})

export const PlanStepSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.object({ write: z.string().min(1) }),
    z.object({
      operation: z.object({
        name: z.string().refine((n) => n in OPERATIONS, { message: 'unknown operation' }),
        args: z.record(z.unknown()).default({}),
      }),
    }),
    z.object({
      adjust: z.object({
        account_id: z.string(),
        player_id: z.string().nullable().optional(),
        amount: z.number(),
        reason: z.string().min(1),
        period: z.string().optional(),
        description: z.string().optional(),
      }),
    }),
    z.object({ message: MessageStepSchema }),
    z.object({
      schedule: z.object({
        kind: z.string(),
        run_at: z.string(),
        dedupe_key: z.string().min(1),
        payload: z.record(z.unknown()).default({}),
      }),
    }),
  ]),
)

/** Validate model-authored steps. Throws on anything that is not a step. */
export function parseSteps(raw: unknown): PlanStep[] {
  const arr = z.array(PlanStepSchema).parse(raw)
  return arr as PlanStep[]
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

const identityCache = new Map<string, Identity>()

export async function identityFor(ctx: SessionCtx): Promise<Identity> {
  if (ctx.role !== 'service') {
    const id = await resolveIdentity(ctx.contactId)
    if (!id) throw new Error('plan: could not resolve the identity for this session')
    return id
  }
  const cached = identityCache.get(ctx.academyId)
  if (cached) return cached
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
  identityCache.set(ctx.academyId, built)
  return built
}

/* ------------------------------------------------------------------------- *
 * Expansion. Named operations BUILD steps; they never write directly, so the
 * same machinery and the same guarantees cover them (§14.2.1). Expansion
 * happens before the transaction opens, because `build` reads through the
 * caller's own session.
 * ------------------------------------------------------------------------- */

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
      const built = await def.build(ctx, args, id)
      out.push(...(await expand(ctx, built, depth + 1, id)))
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
  exec: { table: string; op: 'insert' | 'update' | 'delete'; count: number }[]
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

async function resolveContact(tx: Tx, ctx: SessionCtx, m: MessageStep): Promise<string | null> {
  if (m.to_contact_id) return m.to_contact_id
  if (!m.to_person_id) return null
  const rows = (await tx.unsafe(
    `select id from contact
      where academy_id = ${uid(ctx.academyId)} and person_id = ${uid(m.to_person_id)}
        and opted_out_at is null
      order by is_primary desc, created_at limit 1`,
  )) as unknown as { id: string }[]
  return rows[0]?.id ?? null
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
      continue
    }

    if ('write' in step) {
      assertSingleWriteStatement(step.write)
      const run = () => tx.unsafe(step.write) as unknown as Promise<unknown>
      const res = step.service ? await asService(tx, ctx, run) : await run()
      const n = rowCount(res)
      const t = tableOf(step.write)
      if (t) state.exec.push({ ...t, count: n })
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
      // No contact, nothing to stage. `send` records a `no_contact` suppression
      // for messages that do reach it; a message with no addressable recipient
      // never becomes one.
      if (!to) continue
      state.staged.push({ ...step.message, toContactId: to })
      continue
    }

    if ('schedule' in step) {
      const s = step.schedule
      const when = new Date(s.run_at)
      if (Number.isNaN(when.getTime())) throw new Error(`plan: schedule.run_at is not a date: ${s.run_at}`)
      // §13.1 — a watch with no expiry is a leak. The runtime rejects it here
      // as well as in the `schedule` tool, because a plan can carry one too.
      if (s.kind === 'agent_task' && !s.payload?.expires_at) {
        throw new Error('plan: an agent_task must carry expires_at (§13.1)')
      }
      const sql =
        `insert into job (kind, run_at, dedupe_key, payload) values (` +
        `${lit(s.kind)}, timestamptz ${lit(when.toISOString())}, ${lit(s.dedupe_key)}, ${jsonLit(s.payload ?? {})}) ` +
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
  return rows[0]?.period ?? new Date().toISOString().slice(0, 8) + '01'
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

const PLURALS: Record<string, string> = {
  class: 'classes',
  attendance: 'attendance rows',
  tally_line: 'tally lines',
  session_coach: 'coach assignments',
  class_coach: 'coach assignments',
  class_slot: 'slots',
  academy_admin: 'admins',
  memory_fact: 'remembered facts',
  audit_entry: 'audit entries',
}

function plural(table: string, n: number): string {
  if (PLURALS[table]) return PLURALS[table]
  return n === 1 ? table.replace(/_/g, ' ') : `${table.replace(/_/g, ' ')}s`
}

function buildSummary(diffs: TableDiff[], state: RunState): string {
  const parts = [...diffs]
    .filter((d) => d.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .map((d) => `${VERB[d.op]} ${d.count} ${plural(d.table, d.count)}`)

  let head: string
  if (parts.length === 0) head = 'Nothing changes in the data'
  else if (parts.length === 1) head = `That'll ${parts[0]}`
  else head = `That'll ${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`

  const note = state.notes.filter(Boolean).join('; ')
  let s = note ? `${head} — ${note}.` : `${head}.`

  if (state.staged.length === 1) s += ' 1 person hears about it.'
  else if (state.staged.length > 1) s += ` ${state.staged.length} people hear about it.`
  if (state.scheduled.length === 1) s += " I'll check back once."
  else if (state.scheduled.length > 1) s += ` ${state.scheduled.length} follow-ups get scheduled.`
  return s
}

function previewOf(m: MessageStep): string {
  const b = m.body.replace(/\s+/g, ' ').trim()
  const btn = m.buttons?.length ? ` [${m.buttons.map((x) => x.title).join('] [')}]` : ''
  return (b.length > 160 ? `${b.slice(0, 157)}…` : b) + btn
}

/* ------------------------------------------------------------------------- *
 * previewPlan / executePlan
 * ------------------------------------------------------------------------- */

function emptyState(): RunState {
  return { staged: [], scheduled: [], notes: [], exec: [] }
}

/** BEGIN → run every step → capture the diff → ROLLBACK. Messages never leave the outbox. */
export async function previewPlan(ctx: SessionCtx, steps: PlanStep[]): Promise<PlanResult> {
  const state = emptyState()
  try {
    const expanded = await expand(ctx, steps, 0)
    const diffs = await withRollback(ctx, async (tx) => {
      const auditId = await beginAuditSafe(tx, ctx, 'preview', steps)
      await runSteps(tx, ctx, expanded, state)
      return await readDiffSafe(tx, ctx, auditId)
    })
    const merged = diffs.length ? diffs : synthDiffs(state.exec)
    return {
      ok: true,
      diffs: merged,
      totalRows: merged.reduce((n, d) => n + d.count, 0),
      stagedMessages: state.staged.map((m) => ({ toContactId: m.toContactId, preview: previewOf(m) })),
      scheduled: state.scheduled,
      summary: buildSummary(merged, state),
    }
  } catch (e) {
    return failed(state, e)
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
): Promise<PlanResult & { auditId: string; outcomes: SendOutcome[] }> {
  const state = emptyState()
  let auditId = newId()
  try {
    const expanded = await expand(ctx, steps, 0)
    const diffs = await withSession(ctx, async (tx) => {
      auditId = await beginAuditSafe(tx, ctx, intent, steps, auditId)
      await runSteps(tx, ctx, expanded, state)
      return await readDiffSafe(tx, ctx, auditId)
    })
    // ---- committed. Only now does anything reach the wire. ----
    const merged = diffs.length ? diffs : synthDiffs(state.exec)
    const outcomes = await flushOutbox(ctx, state.staged, auditId)
    await recordAudit(ctx, auditId, intent, steps, merged, state, outcomes)
    return {
      ok: true,
      auditId,
      outcomes,
      diffs: merged,
      totalRows: merged.reduce((n, d) => n + d.count, 0),
      stagedMessages: state.staged.map((m) => ({ toContactId: m.toContactId, preview: previewOf(m) })),
      scheduled: state.scheduled,
      summary: buildSummary(merged, state),
    }
  } catch (e) {
    return { ...failed(state, e), auditId, outcomes: [] }
  }
}

function failed(state: RunState, e: unknown): PlanResult {
  const message = e instanceof Error ? e.message : String(e)
  return {
    ok: false,
    diffs: [],
    totalRows: 0,
    stagedMessages: [],
    scheduled: [],
    summary: 'Nothing was changed and nobody was messaged.',
    error: e instanceof PlanAbort ? `${e.code}: ${message}` : message,
  }
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
  const svc: SessionCtx = { role: 'service', academyId: ctx.academyId }
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
      const msg: OutboundMessage = {
        toContactId: m.toContactId,
        body: m.body.length > limit ? `${m.body.slice(0, limit - 1)}…` : m.body,
        header: m.header?.slice(0, LIMITS.headerChars),
        footer: m.footer?.slice(0, LIMITS.footerChars),
        buttons: buttons.length ? buttons.slice(0, LIMITS.buttons) : undefined,
        catalogId,
        templateName: entry ? entry.template : null,
        idempotencyKey: idem('plan', auditId, String(i)),
        subjectPersonIds: m.subject_person_ids,
        isConfirmationRequest: m.is_confirmation_request,
        isEscalation: m.is_escalation,
        fixed: m.fixed ?? entry?.fixed ?? false,
        preLaunchOk: m.pre_launch_ok,
      }
      outcomes.push(await send(svc, msg))
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
    await withSession({ role: 'service', academyId: ctx.academyId }, async (tx) => {
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

const MONEY_TABLES = new Set(['payment'])
const MONEY_OPS = new Set<OperationName>(['waive', 'record_payment', 'request_payment'])

/**
 * | Write                                                     | Preview          |
 * |-----------------------------------------------------------|------------------|
 * | Single row, own scope, reversible                          | execute directly |
 * | More than one person or session                            | preview          |
 * | Money-touching — tally lines, adjustments, payments         | preview          |
 * | Destructive — ending enrollments, coaches, classes          | preview          |
 * | Raw SQL rather than a named operation                       | always preview   |
 *
 * Two judgement calls, both made where the spec makes them:
 *
 * 1. A `session` tally line minted mechanically by marking attendance is not a
 *    money DECISION. §14.2's own table puts attendance in the execute-directly
 *    row and §6.4 makes the line an automatic consequence of the mark, so an
 *    adjustment, a payment or an explicit money operation trips the money rule
 *    and the register does not.
 * 2. A register writing a line per player is still one act on one session by
 *    the person responsible for it. Counting rows would make the twelve-player
 *    class a "bulk change" and put a diff in front of a coach standing on a
 *    court — the exact friction row 1 exists to remove. So a single own-scope
 *    operation is exempt from the row count, and nothing else is.
 *
 * Note what does NOT appear here: a button tap. A tap replays a payload minted
 * at compose time, when the preview already happened; re-previewing it would
 * be asking the same question twice.
 */
export function needsPreview(result: PlanResult, steps: PlanStep[]): boolean {
  // Raw SQL rather than a named operation → always preview.
  const hasRawWrite = steps.some((s) => 'write' in s)
  if (hasRawWrite) return true

  const hasAdjust = steps.some((s) => 'adjust' in s)

  // Nothing changed and at most one person hears about it — there is nothing
  // to preview. This is the read-back half of an operation that gates itself
  // (a cancellation confirmation, an opt-out confirmation, undo's "here is
  // what I would put back").
  if (!hasAdjust && result.totalRows === 0 && result.stagedMessages.length <= 1) return false

  if (hasAdjust) return true
  for (const s of steps) {
    if ('operation' in s) {
      const def = OPERATIONS[s.operation.name]
      if (!def) return true
      if (def.destructive) return true
      if (MONEY_OPS.has(s.operation.name)) return true
    }
  }

  if (result.diffs.some((d) => MONEY_TABLES.has(d.table))) return true
  if (result.diffs.some((d) => d.op === 'delete')) return true

  // Row 1: a single own-scope named operation executes directly.
  if (steps.length === 1 && 'operation' in steps[0] && OPERATIONS[steps[0].operation.name]?.ownScope) return false

  if (result.totalRows > 1) return true
  // A plan that changes nothing but talks to several people is a broadcast,
  // and a broadcast is exactly the thing to read back first.
  if (result.stagedMessages.length > 1) return true

  return false
}

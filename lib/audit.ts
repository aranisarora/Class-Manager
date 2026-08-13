/**
 * lib/audit.ts — intent, blast radius, and the way back (CONTRACTS §11, §6).
 *
 * §2.3: the bot never estimates what a write will touch. `beginAudit` opens an
 * audit entry and sets `app.audit_id`, which switches on the generic snapshot
 * trigger for the rest of that transaction (migration 0005). Every affected row
 * is then recorded with its before and after image — so the diff shown before
 * commit is measured, and undo has real before-images to restore.
 *
 * §7.2: **undo reverses database writes only.** A sent message cannot be
 * unsent. `undo()` therefore returns the inverse steps and executes nothing:
 * whoever calls it is the one who has to also decide what to tell the people
 * who were told, and say so before it runs.
 */

import { unsafeQuery, withSession, type SessionCtx, type Tx } from '@/lib/db'
import { AppError } from '@/lib/errors'
import { isUuid } from '@/lib/ids'
import type { RowSnapshot, SnapshotOp } from '@/lib/types'

import type { PlanStep, TableDiff } from '@/lib/agent/plan'

export type BeginAuditInput = {
  academyId: string
  actorPersonId?: string | null
  /** The sentence that produced the plan. Goes in the audit entry verbatim. */
  intent: string
  plan?: unknown
}

/**
 * Opens the audit entry and arms the snapshot trigger — inside the caller's
 * transaction, so a rollback takes the audit entry with it.
 */
export async function beginAudit(tx: Tx, input: BeginAuditInput): Promise<string> {
  if (!isUuid(input.academyId)) {
    throw new AppError({ code: 'audit_no_academy', message: 'beginAudit needs an academyId.' })
  }

  const rows = await unsafeQuery<{ id: string }>(
    tx,
    'select app.begin_audit($1::uuid, $2::uuid, $3::text, $4::jsonb) as id',
    [
      input.academyId,
      input.actorPersonId && isUuid(input.actorPersonId) ? input.actorPersonId : null,
      input.intent ?? null,
      JSON.stringify(input.plan ?? null),
    ],
  )

  const id = rows[0]?.id
  if (!id) throw new AppError({ code: 'audit_failed', message: 'app.begin_audit returned no id.' })
  return id
}

type SnapshotRow = Pick<RowSnapshot, 'seq' | 'table_name' | 'pk' | 'op' | 'before' | 'after'>

function snapshotQuery(order: 'asc' | 'desc'): string {
  return `select seq, table_name, pk, op, before, after
            from row_snapshot
           where audit_id = $1::uuid
           order by seq ${order === 'desc' ? 'desc' : 'asc'}`
}

/**
 * Opens its OWN session, which is why `readDiffIn` exists beside `readDiff` and
 * takes the caller's `tx` instead.
 *
 * Calling this — or anything else that opens a session — from inside another
 * transaction's callback is how you exhaust the pool. The inner session waits
 * for a connection, the outer transaction holds one while it waits, and at
 * `max` concurrent callers the only connection that could free the inner one is
 * the one the outer is sitting on: every backend goes `idle in transaction` and
 * stays there. That is the shape of the outage lib/db.ts's `runTransaction` note
 * describes — 15 of 15 connections held, two of them idle in transaction for
 * sixteen minutes, every route 500ing. It degrades now instead of accumulating,
 * because a transaction that goes idle is killed after 30 s, but "recovers in
 * thirty seconds" is not the same as "does not happen".
 *
 * Inside a transaction, use `readDiffIn`. It is also the only one that can see
 * the snapshots before commit, which is usually the reason you are there.
 */
async function loadSnapshots(ctx: SessionCtx, auditId: string, order: 'asc' | 'desc'): Promise<SnapshotRow[]> {
  if (!isUuid(auditId)) return []
  return withSession(ctx, (tx) => unsafeQuery<SnapshotRow>(tx, snapshotQuery(order), [auditId]))
}

function group(rows: SnapshotRow[]): TableDiff[] {
  const byKey = new Map<string, TableDiff>()
  for (const row of rows) {
    const key = `${row.table_name}:${row.op}`
    let diff = byKey.get(key)
    if (!diff) {
      diff = { table: row.table_name, op: row.op as TableDiff['op'], count: 0, before: [], after: [] }
      byKey.set(key, diff)
    }
    diff.count += 1
    if (row.before) diff.before.push(row.before)
    if (row.after) diff.after.push(row.after)
  }

  return [...byKey.values()]
}

/**
 * The diff, read back from the snapshots. Grouped the way a human reads it:
 * "14 enrollments updated", not fourteen rows.
 */
export async function readDiff(auditId: string): Promise<TableDiff[]> {
  return group(await loadSnapshots({ role: 'service', academyId: '' }, auditId, 'asc'))
}

/**
 * The same diff, read INSIDE the transaction that produced it — which is the
 * only way to see it before commit (§2.3, §14.2's compute-before-commit).
 */
export async function readDiffIn(tx: Tx, auditId: string): Promise<TableDiff[]> {
  if (!isUuid(auditId)) return []
  return group(await unsafeQuery<SnapshotRow>(tx, snapshotQuery('asc'), [auditId]))
}

// -----------------------------------------------------------------------------
// Inverse statement construction
// -----------------------------------------------------------------------------

const IDENT = /^[a-z_][a-z0-9_]*$/

function ident(name: string): string {
  if (!IDENT.test(name)) {
    throw new AppError({ code: 'bad_identifier', message: `Refusing to build SQL for identifier "${name}".` })
  }
  return `"${name}"`
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * A jsonb image has lost its column types, so rebuild the literal from the JSON
 * shape: objects and arrays go back as jsonb, everything else as a quoted
 * literal Postgres can cast to the column's own type.
 */
function literal(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') return `${quote(JSON.stringify(value))}::jsonb`
  return quote(String(value))
}

function inverseStatement(row: SnapshotRow): string | null {
  const table = ident(row.table_name)
  const op = row.op as SnapshotOp

  if (op === 'insert') {
    if (!row.pk) return null
    return `delete from ${table} where "id" = ${quote(row.pk)}`
  }

  if (op === 'delete') {
    const before = row.before
    if (!before) return null
    const keys = Object.keys(before)
    if (keys.length === 0) return null
    const columns = keys.map(ident).join(', ')
    const values = keys.map((k) => literal(before[k])).join(', ')
    return `insert into ${table} (${columns}) values (${values})`
  }

  // update — put every column back the way it was, keyed on the pk.
  const before = row.before
  if (!before || !row.pk) return null
  const assignments = Object.keys(before)
    .filter((k) => k !== 'id')
    .map((k) => `${ident(k)} = ${literal(before[k])}`)
  if (assignments.length === 0) return null
  return `update ${table} set ${assignments.join(', ')} where "id" = ${quote(row.pk)}`
}

/**
 * The inverse of an audited plan, newest write first, as ordinary plan steps —
 * so undo runs through exactly the same machinery, transaction and diff as the
 * thing it is undoing. It does NOT execute them, and it says nothing about
 * messages: a sent message cannot be unsent (§7.2).
 */
export async function undo(ctx: SessionCtx, auditId: string): Promise<PlanStep[]> {
  const rows = await loadSnapshots(ctx, auditId, 'desc')

  const steps: PlanStep[] = []
  for (const row of rows) {
    const write = inverseStatement(row)
    if (write) steps.push({ write })
  }
  return steps
}

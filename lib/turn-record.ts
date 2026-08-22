/**
 * lib/turn-record.ts — one turn, read back whole.
 *
 * The record of a turn lives in two places and always has. What the model was
 * TOLD and what it DID are in-process facts that nothing can recover afterwards,
 * so `writeTurn` puts them in `turn_record` (0045). What it CHANGED and what it
 * SENT are already rows — `message.turn_id` (0019), `audit_entry.turn_id` (0015),
 * `row_snapshot.audit_id` (0005) — so they are read from the tables that own
 * them and never copied.
 *
 * That split is not a compromise on "record everything, untruncated". It is the
 * more truthful shape, for one reason that matters on every send: `delivered_at`
 * and `read_at` arrive by webhook MINUTES after the turn ends. A record frozen at
 * turn-end would say "sent" forever about a message that failed. This one reports
 * what actually happened, however long afterwards it is asked.
 *
 * WHY THIS IS A MODULE AND NOT A SECOND COPY OF `scripts/_capture.ts`
 * -----------------------------------------------------------------------------
 * `_capture.ts` assembles the same shape for a DRIVE, and it must keep its own
 * queries: it reads a cursor WINDOW and deliberately keeps rows whose `turn_id`
 * is null — standing jobs, seeds, repairs — which a lookup by turn id cannot see
 * by definition. Two readers, genuinely different questions.
 *
 * What must not be two is the SHAPE, and the row-to-object mapping under it.
 * ARCHITECTURE.md's trap list calls this out by name — "two authors of one truth:
 * template + body, catalog + handlers, declaration + RLS ... every pair drifted."
 * So the types and the mappers live here, once, and `_capture.ts` imports them.
 */

import { withSession } from '@/lib/db'
import type { ToolTrace } from '@/lib/agent/loop'
import type { SqlRecord } from '@/lib/agent/sql-trace'

// -----------------------------------------------------------------------------
// The shapes.
// -----------------------------------------------------------------------------

/** What the model was handed, recorded beside what it did with it. */
export type RecordedContext = {
  /**
   * The stable prefix by FINGERPRINT, never in full. It is byte-identical on
   * every turn by construction — that property IS the cache — so storing it per
   * turn would store one document thousands of times and bury the variable half.
   * Its length and head prove which prefix was in play; the prefix itself is in
   * the tree at the commit the run names.
   */
  prefix: { chars: number; head: string }
  /** The variable tail in full: census, standing states, memory, replayed reads. */
  tail: string
  said: string | null
  history: number
}

/** The jsonb payload `writeTurn` stores. Versioned so a reader can tell shapes apart. */
export type StoredRecord = {
  v: number
  context: RecordedContext | null
  trace: ToolTrace[]
  sql: SqlRecord[]
}

export type Outbound = {
  to: string | null
  body: string
  buttons: string[]
  /**
   * The other two things a person can tap, which this record used to drop.
   *
   * The product ships three affordances — quick-reply buttons, a list menu
   * (`payload.list.sections[].rows`) and a link (`payload.link`) — and
   * `renderPhone` shows all three, because all three are taps on a real phone.
   * Only `buttons` was ever stored, so a reply whose only affordance was a list
   * came back as `buttons: []`: indistinguishable from a wall of text with
   * nothing to tap.
   */
  listButton?: string | null
  listRows?: string[]
  link?: string | null
  status: string
  /** `turn`, `job`, `tap` or `system` — what put it on the wire (0032). */
  origin: string | null
  suppressedReason: string | null
  /**
   * The turn the DATABASE stamped on this message (0019), so a drain's messages
   * can be told apart by which handler sent them. Null for a standing job, a
   * seed or a repair — rows that belong to nobody's turn.
   */
  turnId?: string | null
}

/**
 * One row this turn changed, as the database itself photographed it.
 *
 * WHY THIS IS READ RATHER THAN RECONSTRUCTED
 * -----------------------------------------------------------------------------
 * `sql` records what the model SENT, and for a write that is all it records: a
 * write is stored with its statement and its `rowCount` and never with its rows,
 * because a capture fills `rows` on the read path only. So the record could say
 * that one row changed and never what it was, or became — which is the question
 * every money finding in `findings/` turns out to be asking.
 *
 * The answer was already in the database. `0005_audit.sql` puts an
 * after-insert-or-update-or-delete trigger on every audited table and writes
 * `row_snapshot(audit_id, table_name, pk, op, before, after)` — full images, both
 * sides, per row, ordered by `seq` so a cascade reads as the sequence it was.
 */
export type Changed = {
  /** The table the trigger fired on. */
  table: string
  /** The row's id, where it has one — `row_snapshot.pk` is nullable. */
  pk: string | null
  op: 'insert' | 'update' | 'delete'
  /** The row before, `null` on an insert. */
  before: unknown | null
  /** The row after, `null` on a delete. */
  after: unknown | null
  /** The audit entry these images hang off, so several rows group into one act. */
  auditId: string
  /** What that act said it was for, as the writer stated it. */
  intent: string | null
}

/** One production turn, with everything that happened because of it. */
export type TurnRecord = {
  turnId: string
  at: string
  academyId: string
  contactId: string | null
  personId: string | null
  who: string
  phone: string | null
  roleActed: string | null
  say: string | null
  source: string | null
  actionId: string | null
  reply: unknown
  model: string | null
  models: string[]
  tokens: { prompt: number; cached: number; output: number }
  ms: number
  rounds: ToolTrace[]
  roundCount: number
  sql: SqlRecord[]
  context: RecordedContext | null
  /** True when `turn_record` had no row — a turn written before 0045, or one whose record failed. */
  recordMissing: boolean
  messages: Outbound[]
  changed: Changed[]
  wrote: number
  sent: number
  error: string | null
}

// -----------------------------------------------------------------------------
// The mappers. One author, shared with `scripts/_capture.ts`.
// -----------------------------------------------------------------------------

type Row = Record<string, unknown>

/**
 * @mechanism mapOutbound — reads a stored message exactly as `_seat.renderPhone`
 *   reads it, so what the record calls an affordance and what the person could
 *   actually tap are the same list. Shared by the drive's reader and production's,
 *   because a second speller of this mapping is how F-BC came to be measured on
 *   `buttons` alone while two of the three tappable things went unrecorded.
 */
export function mapOutbound(m: Row): Outbound {
  const p = (m.payload ?? {}) as {
    buttons?: { title?: unknown }[]
    list?: { buttonText?: unknown; sections?: { rows?: { title?: unknown }[] }[] }
    link?: { title?: unknown }
  }
  return {
    to: (m.to as string) ?? null,
    body: String(m.body ?? ''),
    buttons: Array.isArray(p.buttons) ? p.buttons.map((b) => String(b?.title ?? '')) : [],
    listButton: p.list?.buttonText ? String(p.list.buttonText) : null,
    listRows: Array.isArray(p.list?.sections)
      ? p.list.sections.flatMap((sec) => (sec?.rows ?? []).map((r) => String(r?.title ?? '')))
      : [],
    link: p.link?.title ? String(p.link.title) : null,
    status: String(m.status ?? ''),
    origin: (m.origin as string) ?? null,
    suppressedReason: (m.suppressed_reason as string) ?? null,
    turnId: (m.turn_id as string) ?? null,
  }
}

/**
 * @mechanism mapChanged — one audit-entry-joined-to-snapshots row becomes one
 *   photographed change, keeping both images. Rows whose `table_name` is null are
 *   dropped: they are audit entries that photographed nothing, which still count
 *   toward `wrote` and have no image to show.
 */
export function mapChanged(rows: Row[]): Changed[] {
  return rows
    .filter((r) => r?.table_name)
    .map((r) => ({
      table: String(r.table_name),
      pk: (r.pk as string) ?? null,
      op: String(r.op) as Changed['op'],
      before: r.before ?? null,
      after: r.after ?? null,
      auditId: String(r.audit_id),
      intent: (r.intent as string) ?? null,
    }))
}

// -----------------------------------------------------------------------------
// The reader.
// -----------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A literal list of uuids for an `in (...)`.
 *
 * Interpolated rather than parameterised, and refused rather than quoted, for the
 * reason `lib/db.ts::guc` gives: these are uuids, and a regex that admits nothing
 * else is a stricter guarantee than escaping. An empty list yields a predicate
 * that matches nothing rather than a syntax error.
 */
function uuidList(ids: string[]): string {
  const ok = ids.filter((i) => UUID.test(i))
  return ok.length ? ok.map((i) => `'${i}'::uuid`).join(', ') : `null`
}

/**
 * @mechanism turnRecordsFor — assembles a production turn from the four places its
 *   evidence lives: the `turn` row, the `turn_record` payload beside it, the messages
 *   the database stamped with its id, and the audit entries and row images the write
 *   triggers left. It is the read half of the promise 0045 makes, and it is what lets
 *   a production turn be opened by the same reader a drive is — `report`, `runs`,
 *   `_derive` and the judges all take `turns.jsonl` and none of them need to know
 *   which surface produced it.
 */
export async function turnRecordsFor(o: {
  academyId: string
  since?: string
  until?: string
  limit?: number
  contactId?: string
}): Promise<TurnRecord[]> {
  const limit = Math.min(Math.max(o.limit ?? 200, 1), 2000)
  if (!UUID.test(o.academyId)) throw new Error(`turnRecordsFor: not an academy id: ${o.academyId}`)

  return withSession({ role: 'service', academyId: o.academyId }, async (tx) => {
    const since = o.since ?? '1970-01-01T00:00:00.000Z'
    const contactClause = o.contactId && UUID.test(o.contactId) ? `and t.contact_id = '${o.contactId}'::uuid` : ''
    const untilClause = o.until ? `and t.created_at < '${o.until.replace(/'/g, "''")}'::timestamptz` : ''

    const turns = (await tx.unsafe(
      `select t.id::text as turn_id, t.created_at, t.contact_id::text as contact_id,
              t.person_id::text as person_id, t.role_acted, t.model,
              t.prompt_tokens, t.cached_tokens, t.output_tokens, t.latency_ms,
              t.rounds, t.error, t.input, t.output,
              p.full_name as who_name, c.phone_e164 as phone,
              r.record, r.bytes
         from turn t
         left join contact c on c.id = t.contact_id
         left join person  p on p.id = c.person_id
         left join turn_record r on r.turn_id = t.id
        where t.academy_id = '${o.academyId}'::uuid
          and t.created_at >= '${since.replace(/'/g, "''")}'::timestamptz
          ${untilClause} ${contactClause}
        order by t.created_at asc
        limit ${limit}`,
    )) as unknown as Row[]

    if (turns.length === 0) return []
    const ids = turns.map((t) => String(t.turn_id))
    const inList = uuidList(ids)

    const messages = (await tx.unsafe(
      `select m.turn_id::text as turn_id, c.phone_e164 as to, m.body, m.payload,
              m.status, m.origin, m.suppressed_reason
         from message m
         left join contact c on c.id = m.contact_id
        where m.academy_id = '${o.academyId}'::uuid
          and m.direction = 'outbound' and m.turn_id in (${inList})
        order by m.created_at asc`,
    )) as unknown as Row[]

    // LEFT join and `order by s.seq`, both for the reasons 0005 gave them: an
    // audit entry that photographed nothing still counts toward `wrote`, and the
    // images of one act are read back in the order the trigger wrote them.
    const audited = (await tx.unsafe(
      `select a.turn_id::text as turn_id, a.id::text as audit_id, a.intent,
              s.table_name, s.pk::text as pk, s.op, s.before, s.after
         from audit_entry a
         left join row_snapshot s on s.audit_id = a.id
        where a.academy_id = '${o.academyId}'::uuid and a.turn_id in (${inList})
        order by a.created_at asc, s.seq asc`,
    )) as unknown as Row[]

    const byTurn = <T extends Row>(rows: T[]): Map<string, T[]> => {
      const m = new Map<string, T[]>()
      for (const r of rows) {
        const k = String(r.turn_id ?? '')
        const list = m.get(k)
        if (list) list.push(r)
        else m.set(k, [r])
      }
      return m
    }
    const msgByTurn = byTurn(messages)
    const auditByTurn = byTurn(audited)

    return turns.map((t): TurnRecord => {
      const id = String(t.turn_id)
      const stored = (t.record ?? null) as StoredRecord | null
      const mine = msgByTurn.get(id) ?? []
      const acts = auditByTurn.get(id) ?? []
      const out = mine.map(mapOutbound)
      const input = (t.input ?? {}) as Row
      return {
        turnId: id,
        at: new Date(t.created_at as string).toISOString(),
        academyId: o.academyId,
        contactId: (t.contact_id as string) ?? null,
        personId: (t.person_id as string) ?? null,
        who: String(t.who_name ?? t.role_acted ?? 'unknown'),
        phone: (t.phone as string) ?? null,
        roleActed: (t.role_acted as string) ?? null,
        say: (input.text as string) ?? null,
        source: (input.source as string) ?? null,
        actionId: (input.actionId as string) ?? null,
        reply: t.output ?? null,
        model: (t.model as string) ?? null,
        models: t.model ? [String(t.model)] : [],
        tokens: {
          prompt: Number(t.prompt_tokens ?? 0),
          cached: Number(t.cached_tokens ?? 0),
          output: Number(t.output_tokens ?? 0),
        },
        ms: Number(t.latency_ms ?? 0),
        rounds: stored?.trace ?? [],
        roundCount: Number(t.rounds ?? 0),
        sql: stored?.sql ?? [],
        context: stored?.context ?? null,
        recordMissing: stored === null,
        messages: out,
        changed: mapChanged(acts),
        wrote: new Set(acts.map((r) => String(r.audit_id))).size,
        sent: out.filter((m) => !m.suppressedReason).length,
        error: (t.error as string) ?? null,
      }
    })
  })
}

/** One turn by id. Same assembly, narrowed. */
export async function turnRecordFor(academyId: string, turnId: string): Promise<TurnRecord | null> {
  if (!UUID.test(turnId)) throw new Error(`turnRecordFor: not a turn id: ${turnId}`)
  const all = await turnRecordsFor({ academyId, limit: 2000 })
  return all.find((t) => t.turnId === turnId) ?? null
}

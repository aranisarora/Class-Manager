/**
 * lib/agent/clash.ts — the consequence a row count cannot see.
 *
 * @mechanism coachClashes — asks the database, inside the plan's own transaction and
 *   after the steps have run, which coach this plan just put in two places at once —
 *   both arms, the weekly slot and the dated session, scoped to the rows this plan is
 *   responsible for so somebody else's old overlap never surfaces inside this receipt.
 *   It notes and never refuses: the sentence becomes a plan note, so `needsPreview`
 *   gates on what a plan COLLIDES with rather than on how much it writes, and the
 *   person's tap stays the override. Five routes put a coach somewhere, so the same
 *   check written into `create_class` would have covered one of them.
 *
 * **A coach is one person.** Nothing in this product knew that. Asked to add a
 * Monday 7–8am private at the Gymkhana while the same coach already had a
 * Monday 7–8am private at Lake Club, `create_class` ran with no lookup against
 * `class_slot` at all, auto-committed on the runtime's judgement that it
 * "touched nobody else, no money and nothing destructive", and confirmed it to
 * the admin in the past tense. Both families were then reminded of a session
 * the coach could not attend (`tn-two-places`, the month drive, 17 Aug 2026).
 *
 * **Why not layer 0 — and one argument for that which was wrong.** A coach's
 * identity lives on `class_coach` / `session_coach` and the hours live on
 * `class_slot` / `session`, never the same row, so there is no unique key or
 * exclusion constraint to hang this on — only a constraint trigger. This file
 * first justified avoiding one by saying an admin moving a class passes
 * *through* the overlapping state. **That is not a reason.** A DEFERRED trigger
 * checks at COMMIT, and a plan is one transaction, so drop-old-slot and
 * add-new-slot in either order never trip it. The argument was wrong and is
 * left here rather than quietly deleted.
 *
 * What still stands: an overlap is sometimes real (two courts at one venue, an
 * assistant on half the group), so a refusal needs an escape hatch that a
 * confirmation already is; and a state the schema will not store is a state the
 * product cannot report — 0021 made class names unique and had to grow
 * `close_class` to give back the capability it removed. A constraint remains on
 * the table as a decision, not as a settled no.
 *
 * **Why not inside `create_class`.** Five things put a coach somewhere — a new
 * class, a new slot, a coach added to an existing class, a moved session, a
 * cover assignment — and a check written into one of them is a check written
 * into one of them. So this does not ask what the caller *intended*. It asks
 * the database what the world *became*, after the steps have run and before the
 * transaction commits, which is the only place that question has one answer and
 * the only place it covers routes nobody has written yet.
 *
 * **What is done with the answer, and what is deliberately not.** It becomes a
 * plan `note` — the part written in the business's own words — so the preview
 * carries it and `needsPreview` gates on it: a plan can be consequential for
 * what it collides with rather than for how much it writes, and that is a
 * sentence the row census could not say. Nothing here refuses, and nothing here
 * tells the model what to do about it. The person's tap is the override,
 * because it already was.
 *
 * Two kinds of commitment, because a coach acquires an hour two ways. A
 * `class_slot` is every week until the class ends; a `session` is one dated
 * hour. They are complementary and not redundant: inside a preview
 * `create_class` has not materialised anything yet, so only the slot arm can
 * see it, and `reschedule_session` moves a row no slot describes.
 *
 * Runs under the caller's own role, like the diff beside it, so what it can see
 * is what its author could have seen by hand.
 */

import type { Tx } from '@/lib/db'
import { compactTime, MONTHS_SHORT, WEEKDAY_NAMES } from '@/lib/format'
import { uid } from './operations'

/** How many overlaps are spelled out before the rest become a count. */
const NAMED = 3

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The tables through which a coach acquires a weekly hour, and a dated one. */
const CLASS_SIDE: Record<string, string> = { class: 'id', class_slot: 'class_id', class_coach: 'class_id' }
const SESSION_SIDE: Record<string, string> = { session: 'id', session_coach: 'session_id' }

/**
 * A diff, structurally and only as much of one as this reads — importing
 * `TableDiff` would close a cycle back into `./plan`.
 */
type Diffish = { table: string; op: string; after?: unknown[] }

type Side = { touched: boolean; ids: string[] }
type Scope = { classes: Side; sessions: Side }

/**
 * Which classes and sessions this plan just put a coach into.
 *
 * `touched` and `ids` are separate answers to separate questions. `touched`
 * says the plan reached a table where an hour is spent, and is what decides
 * whether to look at all — a plan that only writes a `tally_line` cannot have
 * created an overlap and should not be told about one somebody else made. The
 * `ids` narrow it to the rows this plan is responsible for, so an old overlap
 * on an unrelated class never surfaces inside the receipt for something else.
 *
 * When the audit is unavailable the diff is synthesized from statement counts
 * and carries no rows, so `touched` holds and `ids` is empty. That deliberately
 * widens to the whole business rather than falling silent: on the degraded path
 * a noisy answer is recoverable and a missed double-booking is not.
 *
 * Deletes are skipped. Removing a slot, a session or a coach can only give an
 * hour back.
 */
function scopeOf(diffs: readonly Diffish[]): Scope {
  const scope: Scope = { classes: { touched: false, ids: [] }, sessions: { touched: false, ids: [] } }
  const classIds = new Set<string>()
  const sessionIds = new Set<string>()

  for (const d of diffs) {
    const key = CLASS_SIDE[d.table] ?? SESSION_SIDE[d.table]
    if (!key) continue
    const isClass = d.table in CLASS_SIDE
    if (isClass) scope.classes.touched = true
    else scope.sessions.touched = true
    if (d.op === 'delete') continue
    for (const raw of d.after ?? []) {
      const id = (raw as Record<string, unknown> | null)?.[key]
      if (typeof id === 'string' && UUID_RE.test(id)) (isClass ? classIds : sessionIds).add(id)
    }
  }

  scope.classes.ids = [...classIds]
  scope.sessions.ids = [...sessionIds]
  return scope
}

/** `and (x in (…) or y in (…))`, or nothing at all when the ids are unknown. */
function only(ids: string[], a: string, b: string): string {
  if (!ids.length) return ''
  const list = ids.map(uid).join(', ')
  return `and (${a} in (${list}) or ${b} in (${list}))`
}

type ClashRow = {
  total: string
  coach: string
  /** Weekly arm. */
  weekday?: number
  /** Dated arm, local 'YYYY-MM-DD'. */
  on_date?: string
  a_time: string
  a_class: string
  a_venue: string | null
  b_time: string
  b_class: string
  b_venue: string | null
}

/** "Anika 7am (Gymkhana)" — the class in the admin's own words, then where. */
function where(className: string, time: string, venue: string | null): string {
  return `${className} ${compactTime(time)}${venue ? ` (${venue})` : ''}`
}

/** "22 Aug", off a local 'YYYY-MM-DD'. */
function dayOf(isoDate: string): string {
  const [, m, d] = isoDate.split('-')
  return `${Number(d)} ${MONTHS_SHORT[Number(m) - 1] ?? m}`
}

/** "on Mondays" for a weekly slot, "on 22 Aug" for a dated session. */
function when(row: ClashRow): string {
  if (row.on_date) return `on ${dayOf(row.on_date)}`
  return `on ${WEEKDAY_NAMES[row.weekday ?? -1] ?? 'that day'}s`
}

/**
 * Named, never in the second person — even in a receipt whose reader is the
 * coach it is about. `MessageStep.personal` exists for *"Done — they are set
 * up"*, a pronoun-shaped third person that reads as if the person were not in
 * the room; a named statement about the timetable is not that, and the one
 * route a non-admin has here (`claim_cover`) is rare enough that a second voice
 * was surface without a defect behind it.
 */
function sentence(row: ClashRow): string {
  return (
    `${row.coach} is in two places ${when(row)}: ` +
    `${where(row.a_class, row.a_time, row.a_venue)} and ${where(row.b_class, row.b_time, row.b_venue)}`
  )
}

/**
 * No silent caps: what is not spelled out is counted. `count(*) over ()` is the
 * total before `limit`, so the number is the real one rather than the sample's.
 */
function withRest(rows: ClashRow[]): string[] {
  const out = rows.map(sentence)
  const rest = Number(rows[0]?.total ?? 0) - out.length
  if (rest <= 0) return out
  return [...out, `and ${rest} more overlap${rest === 1 ? '' : 's'} like ${out.length === 1 ? 'it' : 'those'}`]
}

/**
 * Every coach this plan put somewhere who is now in two places at once, in the
 * business's own words. Empty when there is nothing to say, which is almost
 * always.
 */
export async function coachClashes(
  tx: Tx,
  academyId: string,
  diffs: readonly Diffish[],
): Promise<string[]> {
  const scope = scopeOf(diffs)
  const out: string[] = []

  if (scope.classes.touched) {
    /**
     * Two weekly slots on one weekday, one coach, overlapping hours — and both
     * classes still running, both still overlapping in their date ranges, and
     * the coach not ended. `b.id > a.id` keeps one row per pair rather than
     * each pair twice.
     */
    const weekly = (await tx.unsafe(
      `select count(*) over () as total,
              pe.full_name as coach, a.weekday as weekday,
              to_char(a.start_time,'HH24:MI') as a_time, ca.name as a_class, va.name as a_venue,
              to_char(b.start_time,'HH24:MI') as b_time, cb.name as b_class, vb.name as b_venue
         from class_slot a
         join class ca on ca.id = a.class_id and ca.active
         join academy ac on ac.id = ca.academy_id
         join class_coach cca on cca.class_id = ca.id
         join coach co on co.id = cca.coach_id and co.status <> 'ended'
         join person pe on pe.id = co.person_id
         join class_coach ccb on ccb.coach_id = co.id and ccb.class_id <> ca.id
         join class cb on cb.id = ccb.class_id and cb.active
         join class_slot b on b.class_id = cb.id and b.weekday = a.weekday and b.id > a.id
    left join venue va on va.id = ca.venue_id
    left join venue vb on vb.id = cb.venue_id
        where a.academy_id = ${uid(academyId)}
          and a.start_time < b.end_time and b.start_time < a.end_time
          and coalesce(ca.ends_on, 'infinity') >= cb.starts_on
          and coalesce(cb.ends_on, 'infinity') >= ca.starts_on
          and coalesce(ca.ends_on, 'infinity') >= (app.now() at time zone ac.timezone)::date
          and coalesce(cb.ends_on, 'infinity') >= (app.now() at time zone ac.timezone)::date
          and (co.ended_on is null or co.ended_on >= (app.now() at time zone ac.timezone)::date)
          ${only(scope.classes.ids, 'ca.id', 'cb.id')}
        order by a.weekday, a.start_time
        limit ${NAMED}`,
    )) as unknown as ClashRow[]

    out.push(...withRest(weekly))
  }

  if (scope.sessions.touched) {
    /**
     * The same question about dated hours. A coach who has declined a session
     * is not at it, so those rows are not a commitment; a cancelled session is
     * not one either, and neither is one that has already finished.
     */
    const dated = (await tx.unsafe(
      `select count(*) over () as total, pe.full_name as coach,
              to_char(sa.starts_at at time zone ac.timezone,'YYYY-MM-DD') as on_date,
              to_char(sa.starts_at at time zone ac.timezone,'HH24:MI') as a_time,
              ca.name as a_class, va.name as a_venue,
              to_char(sb.starts_at at time zone ac.timezone,'HH24:MI') as b_time,
              cb.name as b_class, vb.name as b_venue
         from session sa
         join academy ac on ac.id = sa.academy_id
         join class ca on ca.id = sa.class_id
         join session_coach sca on sca.session_id = sa.id and sca.declined_at is null
         join coach co on co.id = sca.coach_id and co.status <> 'ended'
         join person pe on pe.id = co.person_id
         join session_coach scb on scb.coach_id = co.id and scb.session_id <> sa.id
                                and scb.declined_at is null
         join session sb on sb.id = scb.session_id and sb.status = 'scheduled' and sb.id > sa.id
         join class cb on cb.id = sb.class_id
    left join venue va on va.id = coalesce(sa.venue_id, ca.venue_id)
    left join venue vb on vb.id = coalesce(sb.venue_id, cb.venue_id)
        where sa.academy_id = ${uid(academyId)}
          and sa.status = 'scheduled'
          and sa.starts_at < sb.ends_at and sb.starts_at < sa.ends_at
          and sa.ends_at >= app.now()
          ${only(scope.sessions.ids, 'sa.id', 'sb.id')}
        order by sa.starts_at
        limit ${NAMED}`,
    )) as unknown as ClashRow[]

    out.push(...withRest(dated))
  }

  return out
}

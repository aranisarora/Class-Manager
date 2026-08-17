/**
 * lib/jobs/util.ts — shared plumbing for the scheduler.
 *
 * Three things live here and nowhere else in this module:
 *   1. `JobSkip` — how a handler says "my precondition no longer holds" (§13
 *      rule 2). The runner counts it as `skipped`, never `failed`.
 *   2. The service-session helpers. `job` is a global table (§6.6) but every
 *      handler acts *inside* one academy, so it opens a `cm_service` session
 *      pinned to the academy in its payload.
 *   3. Rendering. Everything user-facing is rendered in `academy.timezone`
 *      (§11 conventions) and never mentions the word "academy" (§18.4).
 */

import { DateTime } from 'luxon'
import { withSession, type SessionCtx, type Tx } from '@/lib/db'
import { isQuietHour, quietWindow } from '@/lib/clock'
import { adminsIn } from '@/lib/identity'
import { TIMING_DEFAULTS, TIMING_KEYS, type TimingName } from './kinds'

/** `job` rows are global; the GUC still has to be *something* for infra reads. */
export const NIL_ACADEMY = '00000000-0000-0000-0000-000000000000'

// -----------------------------------------------------------------------------
// Skipping — §13 rule 2, "every job re-checks its precondition at run time"
// -----------------------------------------------------------------------------

export class JobSkip extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`skipped: ${reason}`)
    this.name = 'JobSkip'
    this.reason = reason
  }
}

/** A cancelled session's `coach_coming` calls this. It is not a failure. */
export function skip(reason: string): never {
  throw new JobSkip(reason)
}

// -----------------------------------------------------------------------------
// Per-job notes. The runner sets the sink before each handler; handlers append
// a line of "what actually happened" so `runDueJobs().log` is worth reading.
// Jobs run sequentially, so a module-level sink is safe.
// -----------------------------------------------------------------------------

let noteSink: string[] | null = null

export function setNoteSink(sink: string[] | null): void {
  noteSink = sink
}

export function note(line: string): void {
  if (noteSink) noteSink.push(line)
}

// -----------------------------------------------------------------------------
// Sessions
// -----------------------------------------------------------------------------

/**
 * **Which job**, for the length of that job.
 *
 * The same shape as `setNoteSink` beside it in the runner, and safe for the same
 * reason: `runDueJobs` runs handlers one at a time, in a `for` loop, awaiting
 * each. A concurrent runner would need this to become explicit — and would need
 * `setNoteSink` to as well, so the two would move together.
 */
let currentJobKind: string | undefined

export function setJobOrigin(kind: string | undefined): void {
  currentJobKind = kind
}

/**
 * Everything that reaches the wire from here is a JOB, and now says so (0032).
 *
 * `message.origin` was null on every job send, because attribution was carried
 * by `turnId` and a job has no turn. 27 of 81 outbound messages in one drive
 * were unattributed — the whole standing surface — which meant the truth axis
 * could not be measured on exactly the surface where the product acts
 * unsupervised. This is the one place the jobs layer opens a session, so it is
 * the one place that has to know, and no handler has to remember.
 */
export function serviceCtx(academyId: string): SessionCtx {
  return {
    role: 'service',
    academyId,
    origin: 'job',
    ...(currentJobKind ? { originRef: currentJobKind } : {}),
  }
}

/** Everything a handler does happens inside one academy's service session. */
export function withAcademy<T>(academyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withSession(serviceCtx(academyId), fn)
}

/** For the `job` table itself, which carries no tenant (§6.6). */
export function withInfra<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withSession(serviceCtx(NIL_ACADEMY), fn)
}

// -----------------------------------------------------------------------------
// Payload access
// -----------------------------------------------------------------------------

export function payloadOf(job: { payload?: unknown }): Record<string, any> {
  const p = job.payload
  if (p && typeof p === 'object') return p as Record<string, any>
  if (typeof p === 'string') {
    try { return JSON.parse(p) as Record<string, any> } catch { return {} }
  }
  return {}
}

/** A payload missing a key it needs is a bug, not a skip — let it fail loudly. */
export function need(payload: Record<string, any>, key: string): string {
  const v = payload[key]
  if (typeof v !== 'string' || v === '') throw new Error(`job payload missing ${key}`)
  return v
}

export function numberOf(payload: Record<string, any>, key: string, fallback: number): number {
  const v = payload[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return fallback
}

// -----------------------------------------------------------------------------
// Rows the whole module reads
// -----------------------------------------------------------------------------

export type AcademyRow = {
  id: string
  name: string
  timezone: string
  cancellation_window_hours: number
  client_reminder_lead_hours: number
  /**
   * Null means the owner turned it off, and it is a different value from "07:00".
   * Typed as nullable because `atTimeOn` reads a missing time as midnight — so a
   * caller that forgets the distinction does not skip the brief, it schedules one
   * for 00:00 every day, which is the loudest possible way to honour "don't send
   * one". `plan-ahead.ts` is the only reader and it skips on null.
   */
  morning_brief_at: string | null
  evening_digest_at: string | null
  onboarding_state: 'setup' | 'roster' | 'ready' | 'live'
  rail: string
  upi_handle: string | null
  settings: Record<string, unknown> | null
  created_on: string
}

export async function loadAcademy(tx: Tx, academyId: string): Promise<AcademyRow | null> {
  const [row] = await tx<AcademyRow[]>`
    select id, name, timezone, cancellation_window_hours, client_reminder_lead_hours,
           morning_brief_at::text as morning_brief_at,
           evening_digest_at::text as evening_digest_at,
           onboarding_state, rail, upi_handle, settings, created_on::text as created_on
      from academy
     where id = ${academyId}
  `
  return row ?? null
}

export type Recipient = { person_id: string; contact_id: string | null; full_name: string }

/** The number a person actually reads. Opted-out contacts never come back. */
export async function contactFor(tx: Tx, academyId: string, personId: string): Promise<string | null> {
  const [row] = await tx<{ id: string }[]>`
    select id from contact
     where academy_id = ${academyId} and person_id = ${personId} and opted_out_at is null
     order by is_primary desc, created_at asc
     limit 1
  `
  return row?.id ?? null
}

/**
 * Delegates to `lib/identity.ts`, which owns the one definition of this join —
 * see the note there. This shape (`Recipient`) is structurally the same and is
 * kept so the handlers that import it read unchanged.
 */
export async function admins(tx: Tx, academyId: string): Promise<Recipient[]> {
  return adminsIn(tx, academyId)
}

/**
 * §18 — "exactly one active coach whose person_id is also in academy_admin."
 * Computed for SHAPING only (merge the coach day into the brief, do not offer
 * cover to a set of one). Gating is the send path's two suppression rules.
 * Never cached.
 */
export async function isSolo(tx: Tx, academyId: string): Promise<boolean> {
  const [row] = await tx<{ solo: boolean }[]>`
    select
      (select count(*) from coach c
        where c.academy_id = ${academyId} and c.status = 'active' and c.ended_on is null) = 1
      and exists (
        select 1 from coach c
          join academy_admin aa
            on aa.academy_id = c.academy_id and aa.person_id = c.person_id
         where c.academy_id = ${academyId} and c.status = 'active' and c.ended_on is null
      ) as solo
  `
  return row?.solo === true
}

export type SessionRow = {
  id: string
  academy_id: string
  class_id: string
  class_name: string
  starts_at: Date
  ends_at: Date
  status: 'scheduled' | 'cancelled' | 'completed'
  venue_name: string | null
  venue_address: string | null
}

export async function loadSession(tx: Tx, sessionId: string): Promise<SessionRow | null> {
  const [row] = await tx<SessionRow[]>`
    select s.id, s.academy_id, s.class_id, cl.name as class_name,
           s.starts_at, s.ends_at, s.status,
           v.name as venue_name, v.address as venue_address
      from session s
      join class cl on cl.id = s.class_id
      left join venue v on v.id = coalesce(s.venue_id, cl.venue_id)
     where s.id = ${sessionId}
  `
  return row ?? null
}

/**
 * §6.3 — "coverage is derived, not stored." The most important derived value in
 * the product, and the reason escalations are about sessions and never people.
 */
export async function isCovered(tx: Tx, sessionId: string): Promise<boolean> {
  const [row] = await tx<{ covered: boolean }[]>`
    select exists (
      select 1 from session_coach sc
       where sc.session_id = ${sessionId}
         and sc.declined_at is null
         and (sc.confirmed_at is not null or sc.arrived_at is not null)
    ) as covered
  `
  return row?.covered === true
}

export type AssignedCoach = {
  coach_id: string
  person_id: string
  full_name: string
  status: string
  ended_on: string | null
  confirmed_at: Date | null
  declined_at: Date | null
  arrived_at: Date | null
  running_late: boolean
  settings: Record<string, unknown> | null
  contact_id: string | null
}

export async function assignedCoaches(tx: Tx, sessionId: string): Promise<AssignedCoach[]> {
  return tx<AssignedCoach[]>`
    select sc.coach_id, co.person_id, pe.full_name, co.status, co.ended_on::text as ended_on,
           sc.confirmed_at, sc.declined_at, sc.arrived_at, sc.running_late,
           pe.settings,
           ct.id as contact_id
      from session_coach sc
      join coach co on co.id = sc.coach_id
      join person pe on pe.id = co.person_id
      left join lateral (
        select c.id from contact c
         where c.academy_id = sc.academy_id and c.person_id = co.person_id
           and c.opted_out_at is null
         order by c.is_primary desc, c.created_at asc limit 1
      ) ct on true
     where sc.session_id = ${sessionId}
     order by pe.full_name
  `
}

export type EnrolledPlayer = {
  player_id: string
  player_name: string
  player_person_id: string
  account_id: string
  holder_person_id: string
  holder_name: string
  holder_settings: Record<string, unknown> | null
  contact_id: string | null
  enrollment_id: string
  is_trial: boolean
}

/** Everyone actively enrolled in a class on a given date, with the number that pays. */
export async function enrolledPlayers(
  tx: Tx, academyId: string, classId: string, onDate: string,
): Promise<EnrolledPlayer[]> {
  return tx<EnrolledPlayer[]>`
    select e.id as enrollment_id, e.is_trial,
           p.id as player_id, p.person_id as player_person_id, pp.full_name as player_name,
           a.id as account_id, a.holder_person_id, hp.full_name as holder_name,
           hp.settings as holder_settings,
           ct.id as contact_id
      from enrollment e
      join player p on p.id = e.player_id and p.active
      join person pp on pp.id = p.person_id
      join account a on a.id = p.account_id
      join person hp on hp.id = a.holder_person_id
      left join lateral (
        select c.id from contact c
         where c.academy_id = e.academy_id and c.person_id = a.holder_person_id
           and c.opted_out_at is null
         order by c.is_primary desc, c.created_at asc limit 1
      ) ct on true
     where e.academy_id = ${academyId}
       and e.class_id = ${classId}
       and e.started_on <= ${onDate}::date
       and (e.ended_on is null or e.ended_on >= ${onDate}::date)
     order by pp.full_name
  `
}

// -----------------------------------------------------------------------------
// §8.2 — timings are defaults, not constants
// -----------------------------------------------------------------------------

export function settingNumber(settings: unknown, key: string): number | null {
  if (!settings || typeof settings !== 'object') return null
  const v = (settings as Record<string, unknown>)[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

/**
 * The person's own record wins, then the academy's settings, then the academy
 * column (where one exists), then the product default. A coach who has confirmed
 * at the door forty times running stops being asked at T-60 because someone
 * wrote `coach_coming_lead_minutes` onto their person row — no code changes.
 */
export function leadFor(
  name: TimingName,
  personSettings: unknown,
  academy: AcademyRow | null,
  academyColumn?: number | null,
): number {
  const key = TIMING_KEYS[name]
  return (
    settingNumber(personSettings, key)
    ?? settingNumber(academy?.settings, key)
    ?? (typeof academyColumn === 'number' ? academyColumn : null)
    ?? TIMING_DEFAULTS[name]
  )
}

// -----------------------------------------------------------------------------
// Rendering. Academy timezone, always (§11 conventions).
// -----------------------------------------------------------------------------

/**
 * A date-only string ('2026-08-12') is read *in* the academy's zone, not in the
 * server's — otherwise a container running in UTC+12 renders an Indian Tuesday
 * as Monday. A full timestamp keeps its own offset and is converted.
 */
export function zoned(d: Date | string, tz: string): DateTime {
  return d instanceof Date
    ? DateTime.fromJSDate(d).setZone(tz)
    : DateTime.fromISO(d, { zone: tz })
}

export function isoDate(d: Date | string, tz: string): string {
  return zoned(d, tz).toFormat('yyyy-MM-dd')
}

/** "6:30 pm" */
export function timeLabel(d: Date | string, tz: string): string {
  return zoned(d, tz).toFormat('h:mm a').replace('AM', 'am').replace('PM', 'pm')
}

/** "6:30–7:30 pm" */
export function spanLabel(start: Date | string, end: Date | string, tz: string): string {
  const a = zoned(start, tz), b = zoned(end, tz)
  const sameHalf = a.toFormat('a') === b.toFormat('a')
  const left = sameHalf ? a.toFormat('h:mm') : timeLabel(start, tz)
  return `${left}–${timeLabel(end, tz)}`
}

/**
 * "today", "tomorrow (Sun)", "Sat 14 Jun" — what a person would actually say.
 *
 * "tomorrow" carries its weekday because the word alone erases the one fact
 * that tells two messages apart. A class that runs every day has a class
 * tomorrow every day, so Meera's phone got the identical sentence — word for
 * word — at the same minute on two consecutive days, about two different
 * classes, and it read as the system stuttering (arc finding). "today" carries
 * it too, found the same way one run later: the fix anchored "tomorrow" and the
 * coach's register prompt — "take the register. Evening Fitness — today
 * 7:00–8pm" — became the surviving byte-identical pair, because a recurring
 * prompt about a daily class says "today" every day. Same class of bug, same
 * fix: the relative word stays (it is the idiom), the anchor disambiguates.
 */
export function dayLabel(d: Date | string, tz: string, reference: Date): string {
  const target = zoned(d, tz).startOf('day')
  const today = zoned(reference, tz).startOf('day')
  const diff = Math.round(target.diff(today, 'days').days)
  if (diff === 0) return `today (${target.toFormat('ccc')})`
  if (diff === 1) return `tomorrow (${target.toFormat('ccc')})`
  if (diff === -1) return `yesterday (${target.toFormat('ccc')})`
  if (diff > 1 && diff < 7) return target.toFormat('cccc')
  return target.toFormat('ccc d LLL')
}

/** "tomorrow at 6:30 pm" */
export function whenLabel(d: Date | string, tz: string, reference: Date): string {
  return `${dayLabel(d, tz, reference)} at ${timeLabel(d, tz)}`
}

/** "Monday 14 June" */
export function longDay(d: Date | string, tz: string): string {
  return zoned(d, tz).toFormat('cccc d LLLL')
}

/** "June" */
export function monthLabel(period: string, tz: string): string {
  return DateTime.fromISO(period, { zone: tz }).toFormat('LLLL')
}

export function firstName(full: string): string {
  return (full ?? '').trim().split(/\s+/)[0] || full
}

/** A `time` column ('18:30:00') on a date, in the academy's zone. */
export function atTimeOn(date: string, time: string, tz: string): Date {
  const t = (time ?? '00:00:00').slice(0, 8)
  return DateTime.fromISO(`${date}T${t}`, { zone: tz }).toJSDate()
}

/**
 * F-H — nothing lands at 4:30 in the morning.
 *
 * A send time computed as `start − lead` has no idea what a night is: a 6:30pm
 * class with the default 14-hour lead put reminders on parents' phones at
 * 4:30am (driven; findings-archive.md F-H). A time that falls inside the
 * academy's quiet hours is pulled BACK to the last waking minute before they
 * begin — the evening before, for an early-morning time — never pushed later,
 * because a reminder after the class started is worse than one a little early.
 *
 * The pair lives in `academy.settings` (`quiet_start` / `quiet_end`, 'HH:MM'),
 * defaulted here rather than written into every row: 21:00–07:00 is a sane
 * household window, and an academy that wants dawn sends can say so.
 */
export function pullOutOfQuietHours(
  at: Date,
  tz: string,
  settings: Record<string, unknown> | null,
): Date {
  // The window itself comes from `lib/clock.ts`, which is also what the send path
  // reads: two definitions of night is the two-authors trap, and the send path is
  // the floor now rather than these two call sites being the whole of it.
  const { start: quietStart, end: quietEnd } = quietWindow(settings)
  if (!isQuietHour(at, tz, settings)) return at
  const local = DateTime.fromJSDate(at, { zone: tz })
  const hm = local.toFormat('HH:mm')
  const overnight = quietStart > quietEnd
  const [h, m] = quietStart.split(':').map(Number)
  const base = overnight && hm < quietEnd ? local.minus({ days: 1 }) : local
  return base.set({ hour: h, minute: m, second: 0, millisecond: 0 }).minus({ minutes: 1 }).toJSDate()
}

/**
 * The forward-going half of the quiet-hours pair.
 *
 * `pullOutOfQuietHours` moves a REMINDER back to the evening before, because a
 * reminder after its subject is worthless. An ALERT is the opposite shape: the
 * register-expiry escalation for an 8:30pm class lands at 22:30 — inside the
 * product's own declared quiet window (judged against rule 9, month drive) —
 * and pulling it back would fire it before the grace period it exists to
 * grant. So it waits for morning: the job re-checks its precondition at run
 * time (§13), so a register marked overnight simply skips.
 */
export function deferPastQuietHours(
  at: Date,
  tz: string,
  settings: Record<string, unknown> | null,
): Date {
  // The window itself comes from `lib/clock.ts`, which is also what the send path
  // reads: two definitions of night is the two-authors trap, and the send path is
  // the floor now rather than these two call sites being the whole of it.
  const { start: quietStart, end: quietEnd } = quietWindow(settings)
  if (!isQuietHour(at, tz, settings)) return at
  const local = DateTime.fromJSDate(at, { zone: tz })
  const hm = local.toFormat('HH:mm')
  const overnight = quietStart > quietEnd
  const [h, m] = quietEnd.split(':').map(Number)
  const base = overnight && hm >= quietStart ? local.plus({ days: 1 }) : local
  return base.set({ hour: h, minute: m, second: 0, millisecond: 0 }).toJSDate()
}

/** `timestamptz` comes back as a Date; be tolerant of a string anyway. */
export function msOf(v: Date | string | number): number {
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'number') return v
  return Date.parse(v)
}

export function num(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '') return Number(v)
  return 0
}

/** Message bodies are capped by the Cloud API (§17 "works here works there"). */
export function clamp(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…'
}

/** Button titles are 20 characters. Anything longer is silently rejected. */
export function buttonTitle(s: string, max = 20): string {
  return s.length <= max ? s : s.slice(0, max)
}

export function joinLines(lines: (string | null | undefined)[]): string {
  return lines.filter((l): l is string => typeof l === 'string' && l.trim() !== '').join('\n')
}

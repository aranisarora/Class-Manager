/**
 * lib/agent/operations.ts — named operations as known-good plans, not gates (§14.2.1).
 *
 * ("Recipes" is what this said, and it meant the everyday word, not the `recipe`
 * table — that feature is gone, see 0017_drop_recipe.sql. Reworded so the two
 * cannot be confused by the next reader.)
 *
 * `end_coach`, `cancel_session`, `move_class`, `waive` still exist and are
 * still the right thing to reach for: they are known-good plans with known-good
 * copy, cheaper and more consistent than composing from scratch, and their
 * signatures sit in the cached prefix (§4.4) so choosing one is free. But they
 * are no longer the only way to do something multi-step — a consequence chain
 * nobody anticipated composes from the same primitives and gets the same
 * guarantees.
 *
 * Operations BUILD steps; they never write directly. That is what keeps the
 * runtime's promises (atomicity, one diff, staged messages, RLS, one audit
 * entry) true for a named operation and an improvised plan alike.
 *
 * A note on `service: true`, which appears on the steps below that touch money,
 * attendance-on-behalf-of, cover claims and infrastructure: §6.7 gives the
 * money tables to the admin only, and a coach or a parent has no policy on
 * them. The billing line that §6.4 says MUST follow a mark is the runtime's
 * consequence, not the coach's write — so the operation says so explicitly, on
 * exactly the statements that need it. The model cannot set that flag: the
 * model-facing step schema strips it (see plan.ts).
 */

import { serviceFrom, withSession, type SessionCtx } from '@/lib/db'
import {
  FREE_FIRST_CLASS_REASON,
  billingKey,
  freeFirstClassDescription,
  packageDescription,
} from '@/lib/billing-keys'
import { undo as inverseOf } from '@/lib/audit'
import { dedupe, liveAgentTasks, sessionJobPrefixes, TIMING_KEYS } from '@/lib/jobs'
import { now } from '@/lib/clock'
import { formatINR } from '@/lib/format'
import { newId } from '@/lib/ids'
import type { Identity } from '@/lib/types'
import { DateTime } from 'luxon'
import { z } from 'zod'
import type { PlanStep } from './plan'

/* ------------------------------------------------------------------------- *
 * SQL literals. Operations compose statements; every value that reaches one
 * goes through these, and every id is checked against the uuid shape before it
 * is allowed near a query.
 * ------------------------------------------------------------------------- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function lit(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('sql: non-finite number')
    return String(v)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return `'${v.replace(/'/g, "''")}'`
}

/**
 * A row this plan created a step ago, named by the only thing that can name it.
 *
 * An id argument is normally a uuid the model has read. Inside a `transaction(steps[])`
 * there is a case where no such uuid can exist: step 1 inserts the venue, step 2 creates
 * the class in it, and the id is assigned by the database between them. `STEPS_PARAM`
 * already says "select it back" — but it says so about `write` steps, and the model
 * reached for the same idea in an *operation* argument, which refused it.
 *
 * What that refusal cost is not obvious and is severe. `create_class` is the only thing
 * in the product that enqueues `materialize_sessions`, so a model pushed off the
 * operation and onto raw `insert into class` produces a business with classes, weekly
 * slots, and **no sessions that will ever happen** — no reminders, no registers, nothing
 * for a coach or a parent to be told about. Driven end to end, that is exactly what
 * happened: 3 classes, 6 slots, 0 sessions, and an admin told "I've set up your three
 * classes with their weekly timings".
 *
 * So the instinct is right and the encoding is now legal. Bounded hard: one parenthesised
 * SELECT, no semicolon, no statement chaining, nothing that writes. It runs inside the
 * plan's own transaction, under the plan author's RLS, so it can reach exactly what a
 * `write` step in the same plan could reach and no further.
 */
const ID_SUBQUERY = /^\(\s*select\s[\s\S]+\)$/i

export function isIdSubquery(v: unknown): v is string {
  const s = String(v ?? '').trim()
  if (!ID_SUBQUERY.test(s)) return false
  if (s.includes(';')) return false
  return !/\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|do|call)\b/i.test(s)
}

export function uid(v: string): string {
  const s = String(v ?? '').trim()
  if (isIdSubquery(s)) return `(${s.replace(/^\(|\)$/g, '')})::uuid`
  if (!UUID_RE.test(s)) throw new Error(`sql: "${v}" is not an id`)
  return `'${s}'::uuid`
}

export function moneyLit(n: number): string {
  if (!Number.isFinite(n)) throw new Error('sql: non-finite money')
  return `${n.toFixed(2)}::numeric`
}

export function jsonLit(v: unknown): string {
  return `${lit(JSON.stringify(v ?? null))}::jsonb`
}

const svc = serviceFrom

async function q<T = Record<string, any>>(ctx: SessionCtx, sql: string): Promise<T[]> {
  return withSession(ctx, async (tx) => (await tx.unsafe(sql)) as unknown as T[])
}

/* ------------------------------------------------------------------------- *
 * Time. Everything user-facing is rendered in the academy's timezone.
 * ------------------------------------------------------------------------- */

type AcademyRow = {
  id: string
  name: string
  timezone: string
  cancellation_window_hours: number
  client_reminder_lead_hours: number
  upi_handle: string | null
  rail: string
  onboarding_state: string
  settings: Record<string, unknown> | null
  created_on: string
}

async function academyOf(ctx: SessionCtx): Promise<AcademyRow> {
  const [a] = await q<AcademyRow>(ctx, `select * from academy where id = ${uid(ctx.academyId)}`)
  if (!a) throw new Error('operations: academy not found for this session')
  return a
}

function zoned(d: string | Date, tz: string): DateTime {
  return DateTime.fromJSDate(new Date(d as any)).setZone(tz)
}
function timeLabel(d: string | Date, tz: string): string {
  return zoned(d, tz).toFormat('h:mm a').toLowerCase()
}
function dayLabel(d: string | Date, tz: string, today: DateTime): string {
  const t = zoned(d, tz)
  const diff = t.startOf('day').diff(today.startOf('day'), 'days').days
  if (diff === 0) return 'today'
  if (diff === 1) return 'tomorrow'
  if (diff === -1) return 'yesterday'
  return t.toFormat('ccc d LLL')
}
function whenLabel(d: string | Date, tz: string, today: DateTime): string {
  return `${dayLabel(d, tz, today)} ${timeLabel(d, tz)}`
}
function periodOf(d: string | Date, tz: string): string {
  return zoned(d, tz).startOf('month').toFormat('yyyy-MM-dd')
}
/** "August" for a period date, without dragging a timestamp through a timezone. */
function monthLabel(period: string, tz: string): string {
  return DateTime.fromISO(period, { zone: tz }).toFormat('LLLL')
}
/** Keep a slot the same length when only its start time moves. */
function shiftEnd(oldStart: string, oldEnd: string, newStart: string): string {
  const a = DateTime.fromFormat(String(oldStart).slice(0, 5), 'HH:mm')
  const b = DateTime.fromFormat(String(oldEnd).slice(0, 5), 'HH:mm')
  const n = DateTime.fromFormat(String(newStart).slice(0, 5), 'HH:mm')
  if (!a.isValid || !b.isValid || !n.isValid) return oldEnd
  return n.plus(b.diff(a)).toFormat('HH:mm')
}
function isoDate(d: string | Date, tz: string): string {
  return zoned(d, tz).toFormat('yyyy-MM-dd')
}

/**
 * Weekday helpers, in the schema's convention.
 *
 * `class_slot.weekday` is Postgres `dow`: 0 = Sunday … 6 = Saturday. Luxon counts
 * 1 = Monday … 7 = Sunday, so the `% 7` is the whole conversion and getting it
 * backwards is silent — every day still maps to *a* day, just the wrong one.
 */
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

function dowOf(isoDay: string): number {
  return DateTime.fromISO(isoDay, { zone: 'utc' }).weekday % 7
}

/**
 * Is the player the person already behind this contact, or somebody new?
 *
 * The one place any write path answers that question. Names are compared
 * case- and punctuation-insensitively because "Rohan Das" and "rohan das" are one
 * human and an exact `=` on a name is R5 — a constraint that exists and can never
 * fire. Deliberately conservative: it reuses only on a whole-name match against a
 * name we already hold for this contact, so "Aarav" booked from his mother's phone
 * stays a new person, which is the common case and the one that must not break.
 *
 * Returns the existing `person.id` to reuse, or null to mint a new one.
 */
function resolvePlayerPerson(
  playerName: string,
  contact: { personId: string | null; fullName: string | null; profileName: string | null },
): string | null {
  if (!contact.personId) return null
  const want = normalName(playerName)
  if (!want) return null
  for (const held of [contact.fullName, contact.profileName]) {
    if (held && normalName(held) === want) return contact.personId
  }
  return null
}

function normalName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Who already owns this phone number in this academy — the one question every
 * operation that is handed a phone has to ask, and two of them did not.
 *
 * **Driven, twice in three minutes, on a live academy.** An admin said *"add my coach
 * Ravi Menon, his number is 9900000042"*, and then — as people do — said the same thing
 * again. `add_coach` minted `person` unconditionally both times, so the database ended
 * with two Ravi Menons:
 *
 * | coach      | status    | contacts | class links |
 * |------------|-----------|----------|-------------|
 * | `555057b5` | `added`   | 1        | 1           |
 * | `900a6585` | `invited` | **0**    | 1           |
 *
 * The second person got no contact at all, because the contact insert carried
 * `on conflict (academy_id, phone_e164) do nothing` and the phone was already taken —
 * R7, doing nothing succeeding. So the real Ravi, the one holding the phone, was left
 * stuck at `added` and never invited; a phantom with no way to reach it was marked
 * `invited`; the class was silently double-staffed; and the admin was told *"Noted —
 * Ravi Menon's invite is out."* Every layer reported success.
 *
 * `contact (academy_id, phone_e164)` is UNIQUE, so the schema already believes a phone
 * identifies one human here. This is the code finally agreeing with it. `book_trial`'s
 * comment asked for exactly this — *"the next operation that needs a human cannot invent
 * a third answer"* — and then two operations invented one, which is why this is a
 * function and not a fix in one `build`.
 *
 * Runs under the caller's own session, so "no such person" and "not yours to see" are
 * the same answer — the answer RLS is entitled to give.
 */
async function resolvePersonByPhone(ctx: SessionCtx, phoneE164: string): Promise<string | null> {
  const [row] = await q<{ person_id: string | null }>(
    ctx,
    `select person_id from contact
      where academy_id = ${uid(ctx.academyId)} and phone_e164 = ${lit(phoneE164)}
      limit 1`,
  )
  return row?.person_id ?? null
}

/** `isoDay` itself when it already matches, else the next day that does. */
function firstMatchingWeekday(isoDay: string, weekdays: Set<number>): string {
  const start = DateTime.fromISO(isoDay, { zone: 'utc' })
  if (!weekdays.size || !start.isValid || weekdays.has(start.weekday % 7)) return isoDay
  for (let i = 1; i <= 7; i++) {
    const d = start.plus({ days: i })
    if (weekdays.has(d.weekday % 7)) return d.toFormat('yyyy-MM-dd')
  }
  return isoDay
}

/* ------------------------------------------------------------------------- *
 * Shared reads
 * ------------------------------------------------------------------------- */

type SessionRow = {
  id: string
  class_id: string
  starts_at: string
  ends_at: string
  status: string
  class_name: string
  venue_name: string | null
  venue_address: string | null
  rate_amount: string | null
  rate_unit: string | null
  rate_count: number | null
}

async function sessionOf(ctx: SessionCtx, sessionId: string): Promise<SessionRow> {
  const [s] = await q<SessionRow>(
    ctx,
    `select s.id, s.class_id, s.starts_at, s.ends_at, s.status, c.name as class_name,
            v.name as venue_name, v.address as venue_address,
            c.rate_amount, c.rate_unit, c.rate_count
       from session s
       join class c on c.id = s.class_id
       left join venue v on v.id = coalesce(s.venue_id, c.venue_id)
      where s.id = ${uid(sessionId)} and s.academy_id = ${uid(ctx.academyId)}`,
  )
  if (!s) throw new Error('that session is not one I can see')
  return s
}

type RosterRow = {
  player_id: string
  account_id: string
  player_name: string
  holder_person_id: string
  enrollment_id: string
  is_trial: boolean
  rate_amount: string | null
  rate_unit: string | null
  rate_count: number | null
}

/**
 * The roster for a class, **read as the runtime rather than as the caller** — and
 * that one word is why this product has never written a single tally line.
 *
 * This ran under the caller's own session. It inner-joins `account`, and
 * `account_cm_user_select` (0003_rls.sql:396) has clauses for admins, account
 * holders and players — **and none for coaches**. So for the one person the
 * register exists for, every row disappeared:
 *
 *   `[All present]`  → `roster` empty → `entries` empty → *"there is nobody to
 *                      mark on that register"*, on a coach standing on a court.
 *   named players    → attendance written, `byPlayer.get()` undefined, `if (!r)
 *                      continue` fires, and the §6.4 session line, the free-first-
 *                      class credit, the package consumption and the timely-cancel
 *                      refund are all skipped **silently**. R7 exactly: doing
 *                      nothing succeeded, and the coach was told it went fine.
 *
 * Zero attendance rows and zero tally lines have existed in any world this product
 * has ever run, and this is the reason for both.
 *
 * Reading it as the service role widens nothing, because **reachability is already
 * established upstream of every caller**: `mark_attendance`, `cancel_session`,
 * `reschedule_session` and `client_cancel` all call `sessionOf(ctx)` first, which
 * is RLS-checked and throws *"that session is not one I can see"*; `move_class` and
 * `end_coach` arrive through `assertIdsExist`, which checks `class_id` under the
 * caller's own session (plan.ts). Nobody reaches this function for a class they
 * could not already open, and the product shows a coach this exact roster on
 * `CO-REGISTER` anyway.
 *
 * Fixed here rather than in `mark_attendance` because it is a chokepoint and that
 * is a call site: six callers had the bug, a seventh would have inherited it.
 */
async function rosterOf(ctx: SessionCtx, classId: string, onDate: string): Promise<RosterRow[]> {
  return q<RosterRow>(
    svc(ctx),
    `select p.id as player_id, p.account_id, pe.full_name as player_name,
            ac.holder_person_id, e.id as enrollment_id, e.is_trial,
            coalesce(e.rate_amount, c.rate_amount) as rate_amount,
            coalesce(e.rate_unit, c.rate_unit)     as rate_unit,
            coalesce(e.rate_count, c.rate_count)   as rate_count
       from enrollment e
       join player p  on p.id = e.player_id and p.active
       join person pe on pe.id = p.person_id
       join account ac on ac.id = p.account_id
       join class c   on c.id = e.class_id
      where e.class_id = ${uid(classId)}
        and e.academy_id = ${uid(ctx.academyId)}
        and e.started_on <= date ${lit(onDate)}
        and (e.ended_on is null or e.ended_on >= date ${lit(onDate)})
      order by pe.full_name`,
  )
}

type CoachOnSession = {
  coach_id: string
  person_id: string
  full_name: string
  confirmed_at: string | null
  declined_at: string | null
  arrived_at: string | null
}

async function coachesOnSession(ctx: SessionCtx, sessionId: string): Promise<CoachOnSession[]> {
  // coach_public, not coach: a coach may not read a co-coach's row (§8.1 — pay
  // is private from other coaches), and this view has no pay columns to leak.
  return q<CoachOnSession>(
    ctx,
    `select sc.coach_id, cp.person_id, pe.full_name, sc.confirmed_at, sc.declined_at, sc.arrived_at
       from session_coach sc
       join coach_public cp on cp.id = sc.coach_id
       join person pe on pe.id = cp.person_id
      where sc.session_id = ${uid(sessionId)}`,
  )
}

/** §6.3 — the most important derived value in the product. Coverage, never people. */
function isCovered(coaches: CoachOnSession[]): boolean {
  return coaches.some((c) => !c.declined_at && (c.confirmed_at || c.arrived_at))
}

async function contactForPerson(ctx: SessionCtx, personId: string): Promise<string | null> {
  const [c] = await q<{ id: string }>(
    ctx,
    `select id from contact
      where academy_id = ${uid(ctx.academyId)} and person_id = ${uid(personId)}
        and opted_out_at is null
      order by is_primary desc, created_at limit 1`,
  )
  return c?.id ?? null
}

async function adminPersonIds(ctx: SessionCtx): Promise<string[]> {
  const rows = await q<{ person_id: string }>(
    svc(ctx),
    `select person_id from academy_admin where academy_id = ${uid(ctx.academyId)}`,
  )
  return rows.map((r) => r.person_id)
}

function num(v: string | number | null | undefined): number {
  const n = typeof v === 'number' ? v : Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/* ------------------------------------------------------------------------- *
 * Operation table
 * ------------------------------------------------------------------------- */

export type OperationName =
  | 'end_coach'
  | 'end_enrollment'
  | 'end_client'
  | 'cancel_session'
  | 'move_class'
  | 'reschedule_session'
  | 'waive'
  | 'book_trial'
  | 'mark_attendance'
  | 'confirm_coach'
  | 'onboard_coach'
  | 'decline_coach'
  | 'claim_cover'
  | 'client_cancel'
  | 'record_payment'
  | 'request_payment'
  | 'confirm_payment'
  | 'opt_out'
  | 'set_timing'
  | 'create_class'
  | 'close_class'
  | 'add_coach'
  | 'add_family'
  | 'send_invite_draft'
  | 'undo'
  | 'set_onboarding_state'
  | 'remember'
  | 'forget'
  | 'list_watches'
  | 'drop_watch'

export type OperationDef = {
  name: OperationName
  description: string
  params: z.ZodTypeAny
  build(ctx: SessionCtx, args: any, id: Identity): Promise<PlanStep[]>
  destructive?: boolean
  /**
   * §14.2 row 1 — "single row, own scope, reversible: execute directly. A diff
   * here is pure friction." Marking the register, confirming, declining,
   * claiming a session, a family cancelling their own class: one act, by the
   * person it belongs to, on one session. `needsPreview` exempts exactly these
   * from the row count and nothing else.
   */
  ownScope?: boolean
}

/**
 * An id argument, and what to do when it is not one.
 *
 * The message matters more than the check. Watched live: asked to create a class at a
 * venue that did not exist yet, the model passed
 * `venue_id: "(SELECT id FROM venue WHERE name = 'Green Park' …)"` — a subquery in a
 * uuid field. It is the *right instinct*: the id genuinely is not knowable at compose
 * time, and `STEPS_PARAM` already says so. What it needed was the sentence saying which
 * of the two shapes carries that instinct, at the moment it reached for the wrong one.
 */
const uuid = z
  .string()
  .refine((v) => UUID_RE.test(v) || isIdSubquery(v), (v) => ({
    message: /select\b/i.test(v)
      ? 'a subquery here has to be one parenthesised SELECT and nothing else — `(select id from venue where name = \'Green Park\' and academy_id = app.academy_id())` — with no semicolon and nothing that writes'
      : 'expected an id: a uuid you have actually read, or `(select id from … )` for a row an earlier step in this same plan created',
  }))

/* =========================================================================== *
 * end_coach — §8.3. Leaving is an end date, never a delete.
 * =========================================================================== */

const endCoach: OperationDef = {
  name: 'end_coach',
  description:
    'End a coach on a date. Reads back what they still have, reassigns or leaves those sessions uncovered, issues their final statement, keeps their history.',
  destructive: true,
  params: z.object({
    coach_id: uuid,
    end_date: z.string(),
    reassign_to_coach_id: uuid.nullish(),
    notify_parents: z.boolean().optional().default(false),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const today = zoned(await now(), a.timezone)
    const endIso = isoDate(args.end_date, a.timezone)

    const [coach] = await q<{
      id: string
      person_id: string
      full_name: string
      pay_amount: string | null
      pay_unit: string | null
    }>(
      ctx,
      `select c.id, c.person_id, pe.full_name, c.pay_amount, c.pay_unit
         from coach c join person pe on pe.id = c.person_id
        where c.id = ${uid(args.coach_id)} and c.academy_id = ${uid(ctx.academyId)}`,
    )
    if (!coach) throw new Error('I cannot see that coach')

    // 1. Read back every session assigned past that date — count, classes, dates.
    const future = await q<{
      session_id: string
      class_id: string
      class_name: string
      starts_at: string
      others: number
    }>(
      ctx,
      `select s.id as session_id, s.class_id, c.name as class_name, s.starts_at,
              (select count(*) from session_coach o
                where o.session_id = s.id and o.coach_id <> ${uid(args.coach_id)}
                  and o.declined_at is null) as others
         from session_coach sc
         join session s on s.id = sc.session_id
         join class c on c.id = s.class_id
        where sc.coach_id = ${uid(args.coach_id)}
          and s.status = 'scheduled'
          and (s.starts_at at time zone ${lit(a.timezone)})::date > date ${lit(endIso)}
        order by s.starts_at`,
    )

    const classNames = [...new Set(future.map((f) => f.class_name))]
    const steps: PlanStep[] = [
      {
        note: future.length
          ? `${coach.full_name} leaves on ${zoned(endIso, a.timezone).toFormat('d LLL')}, ${future.length} session${
              future.length === 1 ? '' : 's'
            } after that${classNames.length ? ` across ${classNames.join(', ')}` : ''}${
              args.reassign_to_coach_id ? ', reassigned' : ', left uncovered for now'
            }`
          : `${coach.full_name} leaves on ${zoned(endIso, a.timezone).toFormat('d LLL')}, nothing assigned after that`,
      },
    ]

    // 3. Set ended_on. Never a delete — history stays attributed (guarantee 6).
    steps.push({
      write: `update coach set status = 'ended', ended_on = date ${lit(endIso)}
                where id = ${uid(args.coach_id)} and academy_id = ${uid(ctx.academyId)}`,
      requireRows: 1,
    })

    if (future.length) {
      // 2. Who takes them: another coach, or nobody yet.
      if (args.reassign_to_coach_id) {
        steps.push({
          write: `insert into session_coach (academy_id, session_id, coach_id)
                  select ${uid(ctx.academyId)}, s.id, ${uid(args.reassign_to_coach_id)}
                    from session s
                   where s.id in (${future.map((f) => uid(f.session_id)).join(',')})
                     and not exists (select 1 from session_coach x
                                      where x.session_id = s.id
                                        and x.coach_id = ${uid(args.reassign_to_coach_id)})`,
          service: true,
        })
      }
      steps.push({
        write: `delete from session_coach
                 where coach_id = ${uid(args.coach_id)}
                   and session_id in (${future.map((f) => uid(f.session_id)).join(',')})`,
      })
    }

    // The default coach set follows too, or every newly materialised session
    // would re-assign a coach who has left.
    steps.push({
      write: `delete from class_coach where coach_id = ${uid(args.coach_id)}
                and academy_id = ${uid(ctx.academyId)}`,
    })
    if (args.reassign_to_coach_id && future.length) {
      steps.push({
        write: `insert into class_coach (academy_id, class_id, coach_id)
                select distinct ${uid(ctx.academyId)}, c.id, ${uid(args.reassign_to_coach_id)}
                  from class c
                 where c.id in (${[...new Set(future.map((f) => f.class_id))].map((c) => uid(c)).join(',')})
                   and not exists (select 1 from class_coach x
                                    where x.class_id = c.id and x.coach_id = ${uid(args.reassign_to_coach_id)})`,
      })
    }

    // 5. Final payables statement, then no more session messages.
    //
    // **This counted sessions that were `completed` AND carried an explicit
    // confirmation, and that conjunction made the statement structurally
    // guaranteed to read zero.** A session only reaches `completed` when a
    // register is marked, and until the roster fix a coach could not mark one at
    // all; `confirmed_at`/`arrived_at` has been null on every session_coach row
    // that has ever existed. So the final word this product says to a departing
    // coach — the one message where being wrong is unrecoverable, about their own
    // money — was ₹0 by construction.
    //
    // Confirming is a courtesy the product asks for, not the record of who worked.
    // A coach who simply turned up every week and never tapped anything has still
    // taken the session, and the honest evidence is that the session RAN and they
    // were on it and did not decline. `arrived_at` remains the stronger claim
    // (§11.1) and is still what coverage is derived from; it is just not what
    // being owed money depends on.
    const [taken] = await q<{ sessions: string; hours: string }>(
      ctx,
      `select count(*) as sessions,
              coalesce(sum(extract(epoch from (s.ends_at - s.starts_at)) / 3600.0), 0) as hours
         from session_coach sc join session s on s.id = sc.session_id
        where sc.coach_id = ${uid(args.coach_id)}
          and s.status = 'completed'
          and sc.declined_at is null`,
    )
    const sessions = num(taken?.sessions)
    const hours = num(taken?.hours)
    const rate = coach.pay_amount === null ? null : num(coach.pay_amount)
    let payLine: string
    if (rate === null) payLine = "Your pay isn't tracked here, so there's no total to show."
    else if (coach.pay_unit === 'per_session')
      payLine = `${sessions} session${sessions === 1 ? '' : 's'} at ${formatINR(rate)} — ${formatINR(sessions * rate)}.`
    else if (coach.pay_unit === 'per_hour')
      payLine = `${hours.toFixed(1)} hours at ${formatINR(rate)} — ${formatINR(hours * rate)}.`
    else payLine = `Your rate was ${formatINR(rate)} ${String(coach.pay_unit ?? '').replace('_', ' ')}.`

    const coachContact = await contactForPerson(ctx, coach.person_id)
    if (coachContact) {
      steps.push({
        message: {
          to_contact_id: coachContact,
          catalog_id: 'CO-FINAL-STATEMENT',
          fixed: true,
          subject_person_ids: [coach.person_id],
          body:
            `${a.name} — final statement to ${zoned(endIso, a.timezone).toFormat('d LLL')}.\n` +
            `${payLine}\n` +
            `Thanks for the coaching. ${a.name} settles this directly.`,
        },
      })
    }

    // 4. Anything left is simply an uncovered session — a state the product
    // already understands, so churn reuses the existing escalation instead of
    // inventing one. Nothing is enqueued here on purpose.
    //
    // 7. Parents hear only if something changed for them, and a coach change is
    // one line inside the next reminder, never a standalone broadcast — which
    // manufactures anxiety about a routine event. So this stays silent unless
    // the admin explicitly asked for it.
    if (args.notify_parents && future.length) {
      const lost = future.filter((f) => Number(f.others) === 0)
      const targets = new Map<string, { name: string; classes: Set<string> }>()
      for (const f of lost) {
        const roster = await rosterOf(ctx, f.class_id, isoDate(f.starts_at, a.timezone))
        for (const r of roster) {
          const t = targets.get(r.holder_person_id) ?? { name: r.player_name, classes: new Set<string>() }
          t.classes.add(f.class_name)
          targets.set(r.holder_person_id, t)
        }
      }
      for (const [personId, t] of targets) {
        steps.push({
          message: {
            to_person_id: personId,
            catalog_id: 'CL-SESSION-MOVED',
            body:
              `${a.name}: ${coach.full_name} is finishing up with us on ${zoned(endIso, a.timezone).toFormat(
                'd LLL',
              )}. ` +
              `${[...t.classes].join(' and ')} carries on as usual — I'll tell you who's taking it as soon as it's set.`,
          },
        })
      }
    }

    return steps
  },
}

/* =========================================================================== *
 * end_enrollment / end_client — §11.4. The other half of leaving.
 *
 * A coach leaving had `end_coach`: an end date, reassignment, a final statement,
 * history kept, one transaction. A FAMILY leaving had nothing at all — no
 * operation set `enrollment.ended_on`, none deactivated a player, none closed an
 * account. So the commonest ending in a coaching business was raw model-authored
 * SQL: no blast radius, no preview, no closing balance, and no encoding anywhere
 * of what else has to happen when somebody stops.
 *
 * That asymmetry is the defect. `bulk-change.md` already classes "ending
 * enrollments" as destructive-and-must-preview, and §11.4 already names
 * `active → ended` as a state machine; the two just had no operation behind them.
 *
 * Both keep history the same way `end_coach` does: an end date, never a delete, so
 * attendance and tally lines stay attributed to a real person.
 *
 * Neither cancels any job. `client_reminder` already re-checks enrolment at run
 * time and stands down with "player is no longer enrolled in this class" (§13
 * rule 2), so ending the row is enough — and the reminder dedupe key puts the
 * player LAST (`cl_rem:<session>:<player>`), so there is no prefix to sweep by
 * anyway. Adding a sweep here would be a second, weaker copy of a rule the
 * handler already enforces correctly.
 * =========================================================================== */

/** What a family still owes, as a lifetime account balance. Same figure the tally
 *  and the dunning ladder use, and named the same way: not a period's number. */
async function accountBalance(ctx: SessionCtx, accountId: string): Promise<number> {
  const [row] = await q<{ billed: string; paid: string }>(
    ctx,
    `select
       coalesce((select sum(amount) from tally_line
                  where academy_id = ${uid(ctx.academyId)} and account_id = ${uid(accountId)}), 0) as billed,
       coalesce((select sum(amount) from payment
                  where academy_id = ${uid(ctx.academyId)} and account_id = ${uid(accountId)}
                    and status = 'confirmed'), 0) as paid`,
  )
  return num(row?.billed) - num(row?.paid)
}

type LiveEnrollment = {
  enrollment_id: string
  player_id: string
  player_name: string
  account_id: string
  class_id: string
  class_name: string
  upcoming: string
}

/** Every enrolment still running on a date, with what it would still have cost them. */
async function liveEnrollments(
  ctx: SessionCtx,
  where: string,
  endIso: string,
  tz: string,
): Promise<LiveEnrollment[]> {
  return q<LiveEnrollment>(
    ctx,
    `select e.id as enrollment_id, e.player_id, pe.full_name as player_name,
            pl.account_id, e.class_id, c.name as class_name,
            (select count(*) from session s
              where s.class_id = e.class_id and s.status = 'scheduled'
                and (s.starts_at at time zone ${lit(tz)})::date > date ${lit(endIso)}) as upcoming
       from enrollment e
       join player pl on pl.id = e.player_id
       join person pe on pe.id = pl.person_id
       join class c on c.id = e.class_id
      where e.academy_id = ${uid(ctx.academyId)}
        and ${stillRunning('e', tz)}
        and ${where}
      order by pe.full_name, c.name`,
  )
}

/**
 * An enrolment that has not finished YET.
 *
 * `ended_on is null` is not that predicate, and the difference is a notice period. "She
 * is stopping at the end of the month" writes `ended_on = 31 Aug` on the 14th, and for
 * the seventeen days in between the child is still enrolled, still on the register, and
 * still being billed. Treating a future end date as already-ended made both churn
 * operations blind to her: `end_enrollment` refused with "there is nothing to end", and
 * `end_client` wrote nothing while telling the admin the family had left.
 *
 * Leaving is an end date, never a delete — and an end date in the future has not
 * arrived.
 */
function stillRunning(alias: string, tz: string): string {
  return `(${alias}.ended_on is null or ${alias}.ended_on >= (app.now() at time zone ${lit(tz)})::date)`
}

/**
 * Deactivate any player left with no live enrolment.
 *
 * Written as one statement over the affected players rather than decided in
 * TypeScript, because the enrolments being ended in this same plan are not visible
 * to a read taken before it — the `not exists` has to run after the UPDATE above
 * it, inside the same transaction, or it deactivates nobody.
 */
function deactivateStrandedPlayers(ctx: SessionCtx, playerIds: string[], tz: string): PlanStep[] {
  if (!playerIds.length) return []
  return [
    {
      // `stillRunning`, not `ended_on is null` — otherwise "she stops at the end of the
      // month" deactivates the child TODAY, taking her off every register, reminder and
      // billing query for a notice period she is still enrolled and still billed for.
      // Driven: an enrolment ended 31 Aug on the 14th left `player.active = false`.
      write: `update player set active = false
               where academy_id = ${uid(ctx.academyId)}
                 and id in (${playerIds.map(uid).join(',')})
                 and active
                 and not exists (select 1 from enrollment e
                                  where e.player_id = player.id and ${stillRunning('e', tz)})`,
    },
  ]
}

const endEnrollment: OperationDef = {
  name: 'end_enrollment',
  description:
    'Stop a player in one class (or in every class) from a date. Keeps their history, stops the billing and the reminders, '
    + 'and reads back what is still owed. Use this when a family says a child is stopping.',
  destructive: true,
  params: z.object({
    player_id: uuid,
    class_id: uuid.nullish(),
    end_date: z.string().nullish(),
    reason: z.string().nullish(),
  }),
  async build(ctx, args) {
    const a = await academyOf(ctx)
    const endIso = isoDate(args.end_date ?? (await now()).toISOString(), a.timezone)

    const live = await liveEnrollments(
      ctx,
      `e.player_id = ${uid(args.player_id)}` +
        (args.class_id ? ` and e.class_id = ${uid(args.class_id)}` : ''),
      endIso,
      a.timezone,
    )
    if (!live.length) {
      // Not an error: R7 says doing nothing must not read as success, and the honest
      // answer is that there was nothing to end.
      throw new Error(
        args.class_id
          ? 'that player is not currently enrolled in that class, so there is nothing to end'
          : 'that player has no live enrolments, so there is nothing to end',
      )
    }

    const name = live[0].player_name
    const classes = [...new Set(live.map((l) => l.class_name))]
    const missed = live.reduce((n, l) => n + num(l.upcoming), 0)
    const owed = await accountBalance(ctx, live[0].account_id)

    const steps: PlanStep[] = [
      {
        note:
          `${name} stops ${classes.length === 1 ? `${classes[0]}` : `all ${classes.length} classes`} on ` +
          `${zoned(endIso, a.timezone).toFormat('d LLL')}` +
          (missed ? `, coming off ${missed} scheduled session${missed === 1 ? '' : 's'}` : '') +
          (owed > 0 ? `, with ${formatINR(owed)} still open on the account` : ''),
      },
      {
        write: `update enrollment set ended_on = date ${lit(endIso)}
                 where id in (${live.map((l) => uid(l.enrollment_id)).join(',')})
                   and academy_id = ${uid(ctx.academyId)} and ended_on is null`,
        requireRows: live.length,
      },
    ]
    steps.push(...deactivateStrandedPlayers(ctx, [args.player_id], a.timezone))
    return steps
  },
}

const endClient: OperationDef = {
  name: 'end_client',
  description:
    'Close a whole family: ends every enrolment for every child on the account from a date, keeps their history, '
    + 'and reads back the closing balance. Use this when a family is leaving altogether.',
  destructive: true,
  params: z.object({
    account_id: uuid,
    end_date: z.string().nullish(),
    reason: z.string().nullish(),
  }),
  async build(ctx, args) {
    const a = await academyOf(ctx)
    const endIso = isoDate(args.end_date ?? (await now()).toISOString(), a.timezone)

    const [account] = await q<{ id: string; display_name: string | null; holder_name: string }>(
      ctx,
      `select ac.id, ac.display_name, pe.full_name as holder_name
         from account ac join person pe on pe.id = ac.holder_person_id
        where ac.id = ${uid(args.account_id)} and ac.academy_id = ${uid(ctx.academyId)}`,
    )
    if (!account) throw new Error('I cannot see that family')

    const live = await liveEnrollments(
      ctx,
      `pl.account_id = ${uid(args.account_id)}`,
      endIso,
      a.timezone,
    )
    const owed = await accountBalance(ctx, args.account_id)
    const who = account.display_name || account.holder_name
    const players = [...new Set(live.map((l) => l.player_name))]

    const steps: PlanStep[] = [
      {
        note:
          `${who} leaves on ${zoned(endIso, a.timezone).toFormat('d LLL')}` +
          (players.length
            ? `, ending ${live.length} enrolment${live.length === 1 ? '' : 's'} for ${players.join(' and ')}`
            : ', with no live enrolments to end') +
          (owed > 0
            ? `. ${formatINR(owed)} is still open and this does not write it off — waive it separately if that is what you meant.`
            : '.'),
      },
    ]

    if (live.length) {
      steps.push({
        write: `update enrollment set ended_on = date ${lit(endIso)}
                 where id in (${live.map((l) => uid(l.enrollment_id)).join(',')})
                   and academy_id = ${uid(ctx.academyId)} and ended_on is null`,
        requireRows: live.length,
      })
      steps.push(...deactivateStrandedPlayers(ctx, [...new Set(live.map((l) => l.player_id))], a.timezone))
    }

    // The account row itself is kept, deliberately. It carries the tally lines and
    // the payments, so deleting or hiding it would take the money history with it —
    // and a family that comes back is the same account, the way a returning coach is
    // the same coach row with a new status.
    return steps
  },
}

/* =========================================================================== *
 * cancel_session
 * =========================================================================== */

const cancelSession: OperationDef = {
  name: 'cancel_session',
  description:
    'Cancel one session: credits anything already billed for it, tells the families and the coaches, and drops that session\'s pending prompts.',
  destructive: true,
  params: z.object({
    session_id: uuid,
    reason: z.string().optional(),
    notify: z.boolean().optional().default(true),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const today = zoned(await now(), a.timezone)
    const s = await sessionOf(ctx, args.session_id)
    if (s.status === 'cancelled') return [{ note: 'that session is already cancelled' }]

    const when = whenLabel(s.starts_at, a.timezone, today)
    const steps: PlanStep[] = [
      { note: `${s.class_name} on ${when} is off` },
      {
        write: `update session set status = 'cancelled', cancel_reason = ${lit(args.reason ?? null)}
                 where id = ${uid(s.id)} and academy_id = ${uid(ctx.academyId)}`,
        requireRows: 1,
      },
    ]

    // §6.4 — a cancelled session carries no `session` line. Anything already
    // billed is credited rather than deleted: money is never edited away.
    const billed = await q<{ id: string; account_id: string; player_id: string; amount: string }>(
      svc(ctx),
      `select id, account_id, player_id, amount from tally_line
        where session_id = ${uid(s.id)} and kind = 'session'`,
    )
    for (const line of billed) {
      steps.push({
        write: `insert into tally_line (academy_id, account_id, player_id, period, kind, description, amount, session_id, reason)
                select ${uid(ctx.academyId)}, ${uid(line.account_id)}, ${uid(line.player_id)},
                       date ${lit(periodOf(s.starts_at, a.timezone))}, 'adjustment',
                       ${lit(`Credit — ${s.class_name} ${dayLabel(s.starts_at, a.timezone, today)} cancelled`)},
                       ${moneyLit(-num(line.amount))}, null, 'session cancelled by the academy'
                 where not exists (select 1 from tally_line t
                                    where t.player_id = ${uid(line.player_id)}
                                      and t.kind = 'adjustment'
                                      and t.reason = 'session cancelled by the academy'
                                      and t.description = ${lit(
                                        `Credit — ${s.class_name} ${dayLabel(s.starts_at, a.timezone, today)} cancelled`,
                                      )})`,
        service: true,
      })
    }

    if (args.notify) {
      const roster = await rosterOf(ctx, s.class_id, isoDate(s.starts_at, a.timezone))
      const seen = new Set<string>()
      for (const r of roster) {
        if (seen.has(r.holder_person_id)) continue
        seen.add(r.holder_person_id)
        const mine = roster.filter((x) => x.holder_person_id === r.holder_person_id)
        steps.push({
          message: {
            to_person_id: r.holder_person_id,
            catalog_id: 'CL-SESSION-CANCELLED',
            fixed: true,
            body:
              `${a.name}: ${s.class_name} ${when} is cancelled${args.reason ? ` — ${args.reason}` : ''}. ` +
              `${mine.map((x) => x.player_name).join(' and ')} ${mine.length > 1 ? 'are' : 'is'} not expected.` +
              (billed.length ? " Anything charged for it has been credited back." : ''),
            buttons: [
              {
                title: 'See other slots',
                action: { kind: 'reply', text: `What other slots are there for ${s.class_name}?` },
              },
            ],
          },
        })
      }
      for (const c of await coachesOnSession(ctx, s.id)) {
        steps.push({
          message: {
            to_person_id: c.person_id,
            subject_person_ids: [c.person_id],
            body: `${a.name}: ${s.class_name} ${when} is cancelled${args.reason ? ` — ${args.reason}` : ''}. Nothing needed from you.`,
          },
        })
      }
    }

    // §13 — rescheduling or cancelling cancels that session's pending jobs by
    // dedupe key. The handlers re-check their preconditions anyway; this is so
    // the queue reads like the world.
    steps.push(...cancelJobsForSession(s.id))
    return steps
  },
}

/**
 * §13 rule 4 — rescheduling or cancelling sweeps that session's whole ladder.
 * In-transaction on purpose: `lib/jobs` would cancel in its own transaction,
 * and a plan that rolls back must not have cancelled anything.
 */
function cancelJobsForSession(
  sessionId: string,
  scope: 'all' | 'pre-session' = 'all',
): PlanStep[] {
  const prefixes = sessionJobPrefixes(sessionId, scope)
  return [
    {
      write: `update job set status = 'cancelled'
               where status = 'pending'
                 and (${prefixes.map((p) => `dedupe_key like ${lit(`${p}%`)}`).join(' or ')})`,
      service: true,
    },
  ]
}

/* =========================================================================== *
 * move_class / reschedule_session — §12.1 CL-SESSION-MOVED
 * =========================================================================== */

const moveClass: OperationDef = {
  name: 'move_class',
  description:
    'Move a class slot to a new weekday/time from a date onwards, and move every scheduled session after it.',
  destructive: true,
  params: z.object({
    class_id: uuid,
    slot_id: uuid.nullish(),
    new_weekday: z.number().int().min(0).max(6).nullish(),
    new_start_time: z.string().nullish(),
    new_end_time: z.string().nullish(),
    from_date: z.string().nullish(),
    notify: z.boolean().optional().default(true),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const today = zoned(await now(), a.timezone)
    const from = args.from_date ? isoDate(args.from_date, a.timezone) : today.toFormat('yyyy-MM-dd')

    const [cls] = await q<{ id: string; name: string }>(
      ctx,
      `select id, name from class where id = ${uid(args.class_id)} and academy_id = ${uid(ctx.academyId)}`,
    )
    if (!cls) throw new Error('I cannot see that class')

    const slots = await q<{ id: string; weekday: number; start_time: string; end_time: string }>(
      ctx,
      `select id, weekday, start_time, end_time from class_slot
        where class_id = ${uid(args.class_id)}${args.slot_id ? ` and id = ${uid(args.slot_id)}` : ''}
        order by weekday, start_time`,
    )
    if (!slots.length) throw new Error('that class has no slot to move')
    const slot = slots[0]
    const newWeekday = args.new_weekday ?? slot.weekday
    const newStart = args.new_start_time ?? slot.start_time
    const newEnd = args.new_end_time ?? shiftEnd(slot.start_time, slot.end_time, String(newStart))

    // Only the sessions this slot produced: a class with several slots must not
    // have its Tuesday moved because its Saturday did.
    const slotFilter = `and extract(dow from (starts_at at time zone ${lit(a.timezone)})) = ${lit(slot.weekday)}`
    const affected = await q<{ id: string; starts_at: string }>(
      ctx,
      `select id, starts_at from session
        where class_id = ${uid(args.class_id)} and academy_id = ${uid(ctx.academyId)}
          and status = 'scheduled'
          and (starts_at at time zone ${lit(a.timezone)})::date >= date ${lit(from)}
          ${slotFilter}
        order by starts_at`,
    )

    const steps: PlanStep[] = [
      {
        note: `all of ${cls.name}, moving to ${DateTime.fromFormat(String(newStart).slice(0, 5), 'HH:mm')
          .toFormat('h:mm a')
          .toLowerCase()}${args.new_weekday !== null && args.new_weekday !== undefined ? ` on ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][newWeekday]}` : ''}`,
      },
      {
        write: `update class_slot set weekday = ${lit(newWeekday)},
                       start_time = time ${lit(String(newStart))}, end_time = time ${lit(String(newEnd))}
                 where id = ${uid(slot.id)} and academy_id = ${uid(ctx.academyId)}`,
        requireRows: 1,
      },
    ]

    if (affected.length) {
      // Move the already-materialised sessions rather than dropping and
      // recreating them: cancellations and marked attendance ride on the row.
      const dayShift = ((newWeekday - slot.weekday) % 7 + 7) % 7
      steps.push({
        write: `update session set
                  starts_at = ((starts_at at time zone ${lit(a.timezone)})::date + ${lit(dayShift)}
                                + time ${lit(String(newStart))}) at time zone ${lit(a.timezone)},
                  ends_at   = ((starts_at at time zone ${lit(a.timezone)})::date + ${lit(dayShift)}
                                + time ${lit(String(newEnd))}) at time zone ${lit(a.timezone)}
                 where id in (${affected.map((s) => uid(s.id)).join(',')})`,
      })
      for (const s of affected) steps.push(...cancelJobsForSession(s.id))
    }

    if (args.notify && affected.length) {
      const roster = await rosterOf(ctx, args.class_id, from)
      const seen = new Set<string>()
      for (const r of roster) {
        if (seen.has(r.holder_person_id)) continue
        seen.add(r.holder_person_id)
        steps.push({
          message: {
            to_person_id: r.holder_person_id,
            catalog_id: 'CL-SESSION-MOVED',
            body:
              `${a.name}: ${cls.name} moves to ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][newWeekday]}s at ` +
              `${DateTime.fromFormat(String(newStart).slice(0, 5), 'HH:mm').toFormat('h:mm a').toLowerCase()} from ${zoned(
                from,
                a.timezone,
              ).toFormat('d LLL')}. Same place, same coach.`,
            buttons: [{ title: 'Got it', action: { kind: 'noop', ack: "Noted — I'll remind you as usual." } }],
          },
        })
      }
    }
    return steps
  },
}

const rescheduleSession: OperationDef = {
  name: 'reschedule_session',
  description: 'Move one session to a new time or venue and tell the families. Reschedule is the makeup.',
  params: z.object({
    session_id: uuid,
    new_starts_at: z.string(),
    new_ends_at: z.string().nullish(),
    venue_id: uuid.nullish(),
    notify: z.boolean().optional().default(true),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const today = zoned(await now(), a.timezone)
    const s = await sessionOf(ctx, args.session_id)
    const start = new Date(args.new_starts_at)
    if (Number.isNaN(start.getTime())) throw new Error('that new time is not a time I can read')
    const durationMs = new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()
    const end = args.new_ends_at ? new Date(args.new_ends_at) : new Date(start.getTime() + durationMs)

    const steps: PlanStep[] = [
      {
        note: `${s.class_name} moves from ${whenLabel(s.starts_at, a.timezone, today)} to ${whenLabel(
          start,
          a.timezone,
          today,
        )}`,
      },
      {
        write: `update session set starts_at = timestamptz ${lit(start.toISOString())},
                       ends_at = timestamptz ${lit(end.toISOString())}
                       ${args.venue_id ? `, venue_id = ${uid(args.venue_id)}` : ''}
                 where id = ${uid(s.id)} and academy_id = ${uid(ctx.academyId)}`,
        requireRows: 1,
      },
      ...cancelJobsForSession(s.id),
    ]

    if (args.notify) {
      const roster = await rosterOf(ctx, s.class_id, isoDate(s.starts_at, a.timezone))
      const seen = new Set<string>()
      for (const r of roster) {
        if (seen.has(r.holder_person_id)) continue
        seen.add(r.holder_person_id)
        steps.push({
          message: {
            to_person_id: r.holder_person_id,
            catalog_id: 'CL-SESSION-MOVED',
            body: `${a.name}: ${s.class_name} moves from ${whenLabel(s.starts_at, a.timezone, today)} to ${whenLabel(
              start,
              a.timezone,
              today,
            )}. Same place unless I say otherwise.`,
            buttons: [{ title: 'Got it', action: { kind: 'noop', ack: "Noted — I'll remind you before it." } }],
          },
        })
      }
      for (const c of await coachesOnSession(ctx, s.id)) {
        steps.push({
          message: {
            to_person_id: c.person_id,
            subject_person_ids: [c.person_id],
            body: `${a.name}: ${s.class_name} moves to ${whenLabel(start, a.timezone, today)}. Your other sessions are unchanged.`,
          },
        })
      }
    }
    return steps
  },
}

/* =========================================================================== *
 * waive — §6.4. Adjustments are ONE primitive, not six features.
 * =========================================================================== */

const waive: OperationDef = {
  name: 'waive',
  description:
    'Write an adjustment: a waiver, a credit, a pro-rate, a sibling discount, goodwill. One primitive, a reason and an approver.',
  params: z.object({
    account_id: uuid,
    player_id: uuid.nullish(),
    amount: z.number(),
    reason: z.string().min(1),
    period: z.string().nullish(),
    description: z.string().nullish(),
    notify: z.boolean().optional().default(true),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const period = args.period ? periodOf(args.period, a.timezone) : periodOf(await now(), a.timezone)
    // Waiving is a credit. A positive number here means "take this much off",
    // which is what an admin says out loud; the line itself is negative.
    const amount = args.amount > 0 ? -Math.abs(args.amount) : args.amount
    const [acct] = await q<{ holder_person_id: string; display_name: string | null }>(
      ctx,
      `select holder_person_id, display_name from account where id = ${uid(args.account_id)}`,
    )
    const steps: PlanStep[] = [
      { note: `${formatINR(Math.abs(amount))} off ${monthLabel(period, a.timezone)} — ${args.reason}` },
      {
        adjust: {
          account_id: args.account_id,
          player_id: args.player_id ?? null,
          amount,
          reason: args.reason,
          period,
          description: args.description ?? `Adjustment — ${args.reason}`,
        },
      },
    ]
    if (args.notify && acct) {
      steps.push({
        message: {
          to_person_id: acct.holder_person_id,
          body: `${a.name}: I've taken ${formatINR(Math.abs(amount))} off your ${monthLabel(period, a.timezone)} tally — ${args.reason}. It'll show as a line on the tally.`,
          buttons: [{ title: 'See the lines', action: { kind: 'reply', text: 'Show me my tally lines' } }],
        },
      })
    }
    return steps
  },
}

/* =========================================================================== *
 * book_trial — §10.1 step 4. Auto-confirmed, no admin gate.
 * =========================================================================== */

const bookTrial: OperationDef = {
  name: 'book_trial',
  ownScope: true,
  description:
    'Book a free trial from a cold conversation: creates the account, the player, a trial enrollment and the booking, confirms to the parent and tells the admin with an undo.',
  params: z.object({
    player_name: z.string().min(1),
    class_id: uuid,
    session_id: uuid.nullish(),
    contact_id: uuid.nullish(),
    holder_name: z.string().nullish(),
    note: z.string().nullish(),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const today = zoned(await now(), a.timezone)
    const contactId = args.contact_id ?? (ctx.role === 'service' ? null : ctx.contactId)
    if (!contactId) throw new Error('book_trial needs the contact this trial is for')

    // `full_name` joins in for `resolvePlayerPerson` below: deciding whether the player
    // IS this contact needs the name the person is stored under, not only the WhatsApp
    // profile name, which is self-set and is often the parent's when the player is not.
    const [contact] = await q<{
      id: string
      person_id: string
      profile_name: string | null
      full_name: string | null
    }>(
      svc(ctx),
      `select c.id, c.person_id, c.profile_name, p.full_name
         from contact c left join person p on p.id = c.person_id
        where c.id = ${uid(contactId)} and c.academy_id = ${uid(ctx.academyId)}`,
    )
    if (!contact) throw new Error('I cannot see that contact')

    const [cls] = await q<{ id: string; name: string; venue_name: string | null; venue_address: string | null }>(
      ctx,
      `select c.id, c.name, v.name as venue_name, v.address as venue_address
         from class c left join venue v on v.id = c.venue_id
        where c.id = ${uid(args.class_id)} and c.academy_id = ${uid(ctx.academyId)}`,
    )
    if (!cls) throw new Error('I cannot see that class')

    const [firstSession] = args.session_id
      ? await q<{ id: string; starts_at: string }>(
          ctx,
          `select id, starts_at from session where id = ${uid(args.session_id)}`,
        )
      : await q<{ id: string; starts_at: string }>(
          ctx,
          `select id, starts_at from session
            where class_id = ${uid(args.class_id)} and status = 'scheduled' and starts_at > app.now()
            order by starts_at limit 1`,
        )

    /**
     * One human is one `person`, whoever is asking.
     *
     * This minted a fresh `person` for the player unconditionally, while
     * `contact.person_id` — the same human, already in scope, already used two steps
     * down as `account.holder_person_id` — sat right here. For a parent booking for a
     * child that is correct: holder and player are genuinely two people. For an adult
     * booking for themselves it produced **two `person` rows with the same name behind
     * one phone number**, one holding the money and one holding the attendance.
     *
     * §6.2 names the self-payer as the n=1 case that must not become a second code
     * path. `add_family` gets it right; this got it wrong, which is R4 exactly — one
     * human, two write paths, two identity models. `resolvePlayerPerson` is now the
     * one place either path answers "is this person already here?", so the next
     * operation that needs a human cannot invent a third answer.
     *
     * Nothing that would expose the damage has ever run — zero tally lines, zero
     * attendance — so this is being fixed before it can show rather than after.
     */
    const existingPersonId = resolvePlayerPerson(args.player_name, {
      personId: contact.person_id,
      fullName: contact.full_name,
      profileName: contact.profile_name,
    })
    const playerPersonId = existingPersonId ?? newId()
    const accountId = newId()
    const playerId = newId()
    const startsOn = firstSession ? isoDate(firstSession.starts_at, a.timezone) : today.toFormat('yyyy-MM-dd')

    // Everything here is `service`: a prospect holds no admin hat, and §10.1 is
    // explicit that this is auto-confirmed with no admin gate. The undo below
    // is what the admin gets instead.
    const steps: PlanStep[] = [
      { note: `a trial for ${args.player_name} in ${cls.name}` },
      // Only when the player is somebody new. Reusing the contact's own person is
      // what makes a self-paying adult one human instead of two.
      ...(existingPersonId
        ? []
        : [
            {
              write: `insert into person (id, academy_id, full_name)
                values (${uid(playerPersonId)}, ${uid(ctx.academyId)}, ${lit(args.player_name)})`,
              service: true,
            } as PlanStep,
          ]),
      {
        write: `insert into account (id, academy_id, holder_person_id, display_name)
                select ${uid(accountId)}, ${uid(ctx.academyId)}, ${uid(contact.person_id)},
                       ${lit(args.holder_name ?? contact.profile_name ?? args.player_name)}
                 where not exists (select 1 from account where holder_person_id = ${uid(contact.person_id)}
                                     and academy_id = ${uid(ctx.academyId)})`,
        service: true,
      },
      {
        write: `insert into player (id, academy_id, account_id, person_id)
                select ${uid(playerId)}, ${uid(ctx.academyId)},
                       (select id from account where holder_person_id = ${uid(contact.person_id)}
                          and academy_id = ${uid(ctx.academyId)} order by created_at limit 1),
                       ${uid(playerPersonId)}`,
        service: true,
        requireRows: 1,
      },
      {
        write: `insert into enrollment (academy_id, class_id, player_id, is_trial, started_on)
                values (${uid(ctx.academyId)}, ${uid(args.class_id)}, ${uid(playerId)}, true, date ${lit(startsOn)})`,
        service: true,
        requireRows: 1,
      },
      {
        // §11.2 — prospect becomes registered the moment there is something to
        // register: a player and a booking.
        write: `update contact set state = 'registered' where id = ${uid(contactId)} and state = 'prospect'`,
        service: true,
      },
    ]

    const whenText = firstSession ? whenLabel(firstSession.starts_at, a.timezone, today) : 'the next session'
    steps.push({
      message: {
        to_contact_id: contactId,
        catalog_id: 'PR-TRIAL-CONFIRMED',
        pre_launch_ok: true,
        body:
          `Done — ${args.player_name} is booked into ${cls.name}, ${whenText}` +
          `${cls.venue_name ? ` at ${cls.venue_name}` : ''}. It's free, nothing to pay.\n` +
          `Come five minutes early and just say the name at the desk.`,
        buttons: [
          {
            title: 'Add to calendar',
            action: {
              kind: 'noop',
              ack: `${cls.name} — ${whenText}${cls.venue_name ? `, ${cls.venue_name}` : ''}.`,
            },
          },
          ...(cls.venue_address
            ? [
                {
                  title: 'Directions',
                  action: { kind: 'noop' as const, ack: `${cls.venue_name}: ${cls.venue_address}` },
                },
              ]
            : []),
        ],
      },
    })

    for (const adminPerson of await adminPersonIds(ctx)) {
      steps.push({
        message: {
          to_person_id: adminPerson,
          catalog_id: 'AD-NEW-TRIAL',
          fixed: true,
          body: `New trial booked — ${args.player_name}, ${cls.name}, ${whenText}. Came in cold${
            contact.profile_name ? ` from ${contact.profile_name}` : ''
          }.${args.note ? ` They said: ${args.note}` : ''}`,
          buttons: [
            { title: 'Message them', action: { kind: 'reply', text: `Draft a message to ${args.player_name}'s parent` } },
            // The audit id cannot exist at compose time — the plan has not
            // committed yet. `$AUDIT_ID` is bound when the outbox flushes.
            { title: 'Undo', action: { kind: 'operation', op: 'undo', args: { audit_id: '$AUDIT_ID' } } },
          ],
        },
      })
    }
    return steps
  },
}

/* =========================================================================== *
 * mark_attendance — the register, and §6.4's billing rules
 * =========================================================================== */

const ATT = z.enum(['present', 'late', 'absent', 'cancelled_timely'])

const markAttendance: OperationDef = {
  name: 'mark_attendance',
  ownScope: true,
  description:
    'Mark the register for a session. Writes the billing line §6.4 requires, and asks about absences nobody told us about so one tap makes them timely.',
  params: z.object({
    session_id: uuid,
    all_present: z.boolean().optional().default(false),
    entries: z
      .array(z.object({ player_id: uuid, status: ATT, note: z.string().nullish() }))
      .optional()
      .default([]),
    retro_timely_player_ids: z.array(uuid).optional().default([]),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const today = zoned(await now(), a.timezone)
    const s = await sessionOf(ctx, args.session_id)
    const onDate = isoDate(s.starts_at, a.timezone)
    const period = periodOf(s.starts_at, a.timezone)
    const roster = await rosterOf(ctx, s.class_id, onDate)
    const byPlayer = new Map(roster.map((r) => [r.player_id, r]))

    const entries: { player_id: string; status: string; note?: string | null }[] = args.all_present
      ? roster.map((r) => ({ player_id: r.player_id, status: 'present' as const }))
      : [...args.entries]
    for (const pid of args.retro_timely_player_ids) {
      const found = entries.find((e) => e.player_id === pid)
      if (found) found.status = 'cancelled_timely'
      else entries.push({ player_id: pid, status: 'cancelled_timely' })
    }
    if (!entries.length) throw new Error('there is nobody to mark on that register')

    const existing = await q<{ player_id: string; status: string }>(
      ctx,
      `select player_id, status from attendance where session_id = ${uid(s.id)}`,
    )
    const existingStatus = new Map(existing.map((e) => [e.player_id, e.status]))

    const steps: PlanStep[] = [
      {
        note: `${s.class_name}, ${dayLabel(s.starts_at, a.timezone, today)} — ${
          entries.filter((e) => e.status === 'present' || e.status === 'late').length
        } in, ${entries.filter((e) => e.status === 'absent').length} out`,
      },
    ]

    for (const e of entries) {
      const r = byPlayer.get(e.player_id)
      steps.push({
        write: `insert into attendance (academy_id, session_id, player_id, status, note, marked_by_coach_id, marked_at)
                values (${uid(ctx.academyId)}, ${uid(s.id)}, ${uid(e.player_id)}, ${lit(e.status)},
                        ${lit(e.note ?? null)}, ${id.coachId ? uid(id.coachId) : 'null'}, app.now())
                on conflict (session_id, player_id) do update set
                  status = excluded.status,
                  note = coalesce(excluded.note, attendance.note),
                  marked_by_coach_id = coalesce(excluded.marked_by_coach_id, attendance.marked_by_coach_id),
                  marked_at = excluded.marked_at`,
      })

      if (!r) continue
      const unit = r.rate_unit
      const amount = num(r.rate_amount)
      const billable = e.status === 'present' || e.status === 'late' || e.status === 'absent'

      // §6.4 — a `session` line for present/late/absent, never for
      // cancelled_timely, and only where the rate is per_session.
      if (unit === 'per_session' && billable && amount > 0) {
        const desc = `${s.class_name} — ${zoned(s.starts_at, a.timezone).toFormat('d LLL')}${
          e.status === 'absent' ? ' (absent)' : ''
        }`
        steps.push({
          write: `insert into tally_line (academy_id, account_id, player_id, class_id, period, kind, description, amount, session_id, dedupe_key)
                  select ${uid(ctx.academyId)}, ${uid(r.account_id)}, ${uid(r.player_id)}, ${uid(s.class_id)}, date ${lit(period)},
                         'session', ${lit(desc)}, ${moneyLit(amount)}, ${uid(s.id)},
                         ${lit(billingKey.session(r.player_id, s.id))}
                   where not exists (select 1 from tally_line t
                                      where t.session_id = ${uid(s.id)} and t.player_id = ${uid(r.player_id)})`,
          service: true,
        })

        // §6.4 — the free first class is a rule that mints an adjustment.
        // Per PLAYER, not per account: a second child gets their own.
        const freeFirst = (a.settings?.['free_first_class'] ?? true) !== false
        if (freeFirst) {
          const [prior] = await q<{ n: string }>(
            svc(ctx),
            `select count(*) as n from tally_line
              where player_id = ${uid(r.player_id)} and kind = 'session' and session_id <> ${uid(s.id)}`,
          )
          if (num(prior?.n) === 0 || r.is_trial) {
            steps.push({
              // The reason string is shared with `money.ts` (lib/billing-keys.ts).
              // It used to be 'free first class' here and 'free trial' there, so
              // neither guard could see the other's credit and a trial player who
              // met both paths was credited twice.
              write: `insert into tally_line (academy_id, account_id, player_id, class_id, period, kind, description, amount, reason, dedupe_key)
                      select ${uid(ctx.academyId)}, ${uid(r.account_id)}, ${uid(r.player_id)}, ${uid(s.class_id)}, date ${lit(period)},
                             'adjustment', ${lit(freeFirstClassDescription(r.player_name))}, ${moneyLit(-amount)},
                             ${lit(FREE_FIRST_CLASS_REASON)}, ${lit(billingKey.freeFirstClass(r.player_id))}
                       where not exists (select 1 from tally_line t
                                          where t.player_id = ${uid(r.player_id)}
                                            and t.reason = ${lit(FREE_FIRST_CLASS_REASON)})`,
              service: true,
            })
          }
        }
      }

      // §6.4 — per_package: sessions consume the package on the per_session
      // rule, and when rate_count are consumed the next one opens a new package.
      if (unit === 'per_package' && billable && amount > 0) {
        const size = r.rate_count && r.rate_count > 0 ? r.rate_count : 10
        // `opened` rides along with `opened_at` because the pack's ordinal is its
        // identity — see `billingKey.package`. Counting it here costs nothing; the
        // row was already being read for its timestamp.
        const [pkg] = await q<{ opened_at: string | null; opened: string }>(
          svc(ctx),
          `select max(created_at) as opened_at, count(*) as opened from tally_line
            where player_id = ${uid(r.player_id)} and kind = 'package'`,
        )
        const [used] = await q<{ n: string }>(
          ctx,
          `select count(*) as n from attendance att
             join session se on se.id = att.session_id
            where att.player_id = ${uid(r.player_id)} and se.class_id = ${uid(s.class_id)}
              and att.status in ('present','late','absent')
              and att.session_id <> ${uid(s.id)}
              ${pkg?.opened_at ? `and att.created_at >= timestamptz ${lit(new Date(pkg.opened_at).toISOString())}` : ''}`,
        )
        const consumed = num(used?.n) + 1
        if (!pkg?.opened_at || consumed > size) {
          steps.push({
            // `pkg.opened` is how many packs this player already has, so this one
            // is the next ordinal. Keyed that way, re-running the exhaustion check
            // cannot open a second copy of the same pack — and `money.ts` computes
            // the identical key, so the two writers agree by construction rather
            // than by both spelling a sentence the same way.
            write: `insert into tally_line (academy_id, account_id, player_id, class_id, period, kind, description, amount, dedupe_key)
                    values (${uid(ctx.academyId)}, ${uid(r.account_id)}, ${uid(r.player_id)}, ${uid(s.class_id)}, date ${lit(period)},
                            'package', ${lit(packageDescription(s.class_name, size))}, ${moneyLit(amount)},
                            ${lit(billingKey.package(r.player_id, s.class_id, num(pkg?.opened) + 1))})
                    on conflict (academy_id, dedupe_key) where dedupe_key is not null do nothing`,
            service: true,
          })
        }
        const remaining = !pkg?.opened_at || consumed > size ? size - 1 : size - consumed
        steps.push({ note: `${r.player_name} has ${Math.max(0, remaining)} of ${size} classes left` })
      }

      // A cancellation that arrives late enough to have been billed gets the
      // money undone, which is the whole point of the retroactive tap below.
      if (e.status === 'cancelled_timely' && existingStatus.get(e.player_id) !== 'cancelled_timely') {
        steps.push({
          // Keyed on (player, session), not on the sentence. The guard used to
          // compare a description carrying the class name and the date, so
          // renaming the class made the credit look un-issued and a second one
          // could be written — the same R5 defect as the monthly line, in the
          // direction that costs the BUSINESS money rather than the family.
          write: `insert into tally_line (academy_id, account_id, player_id, class_id, period, kind, description, amount, reason, dedupe_key)
                  select ${uid(ctx.academyId)}, ${uid(r.account_id)}, ${uid(r.player_id)}, ${uid(s.class_id)}, date ${lit(period)},
                         'adjustment', ${lit(`Cancelled in time — ${s.class_name} ${zoned(s.starts_at, a.timezone).toFormat('d LLL')}`)},
                         -t.amount, 'cancelled in time', ${lit(billingKey.cancelledInTime(r.player_id, s.id))}
                    from tally_line t
                   where t.session_id = ${uid(s.id)} and t.player_id = ${uid(r.player_id)} and t.kind = 'session'
                  on conflict (academy_id, dedupe_key) where dedupe_key is not null do nothing`,
          service: true,
        })
      }

      // §12.1 CL-OUTCOME rides on the event, so it is a job and not a message
      // here — the outcome handler decides what this family should hear.
      steps.push({
        schedule: {
          kind: 'client_outcome',
          // Domain now, not host now. The runner compares `run_at` against `app.now()`,
          // so a job stamped from the host clock is scheduled in a different timeline:
          // whenever the domain clock is behind the host, "run this immediately" becomes
          // "run this at a moment that has not arrived yet", and the job simply waits.
          run_at: (await now()).toISOString(),
          dedupe_key: dedupe.clientOutcome(s.id, e.player_id),
          payload: { session_id: s.id, player_id: e.player_id, status: e.status },
        },
      })
    }

    // §11.1 — the register is what completes a session.
    //
    // `service: true` for the same reason the billing lines above carry it, and it
    // was missing for the same reason it was easy to miss: `session_cm_user_update`
    // requires `app.is_admin()` (0003_rls.sql:608), and the person who marks a
    // register is a coach. So this matched zero rows, changed nothing, raised
    // nothing — R7 again — and the session stayed `scheduled` forever after being
    // taken. Everything keyed on `completed` inherited that: `end_coach`'s payables
    // counted nothing, `register pending` (§11.1) stayed true for a session that had
    // been marked, and the register-expiry escalation kept telling the admin a
    // marked register was missing.
    //
    // Completing a session is the runtime's consequence of the register being
    // marked, not the coach's own write — which is exactly the distinction §6.7
    // draws and this file's header already states for the money tables.
    steps.push({
      write: `update session set status = 'completed'
               where id = ${uid(s.id)} and academy_id = ${uid(ctx.academyId)} and status = 'scheduled'`,
      service: true,
    })
    // 'pre-session', not 'all' — the outcome jobs pushed above are the whole point
    // of marking a register, and an 'all' sweep here cancelled them in the same
    // transaction that created them. See sessionJobPrefixes.
    steps.push(...cancelJobsForSession(s.id, 'pre-session'))

    // §8.2's highest-value catch-point. Out-of-band cancellations land with the
    // coach — a parent tells them at the court — so a stale picture becomes a
    // wrong bill. If a player is absent with no cancellation on record, the
    // register asks, and one tap makes it timely.
    const unexplained = entries.filter(
      (e) => e.status === 'absent' && existingStatus.get(e.player_id) !== 'cancelled_timely',
    )
    const markerContact = ctx.role === 'service' ? null : ctx.contactId
    if (unexplained.length && markerContact) {
      const names = unexplained.map((e) => byPlayer.get(e.player_id)?.player_name ?? 'someone')
      steps.push({
        message: {
          to_contact_id: markerContact,
          body:
            `Noted. ${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} down as absent with nothing on record — ` +
            `did anyone tell you in advance? If they did, I'll make it a proper cancellation and take the charge off.`,
          buttons: [
            ...unexplained.slice(0, 2).map((e) => ({
              title: `${(byPlayer.get(e.player_id)?.player_name ?? 'They').split(' ')[0]} told me`.slice(0, 20),
              action: {
                kind: 'operation' as const,
                op: 'mark_attendance' as const,
                args: { session_id: s.id, retro_timely_player_ids: [e.player_id] },
              },
            })),
            { title: 'No, just absent', action: { kind: 'noop' as const, ack: 'Left as absent. Thanks.' } },
          ],
        },
      })
    }
    return steps
  },
}

/* =========================================================================== *
 * confirm_coach / decline_coach / claim_cover — §8.2
 * =========================================================================== */

const confirmCoach: OperationDef = {
  name: 'confirm_coach',
  ownScope: true,
  description: 'A coach confirms a session, or says they have arrived. One confirmation is enough — they are never asked again.',
  params: z.object({
    session_id: uuid,
    coach_id: uuid.nullish(),
    arrived: z.boolean().optional().default(false),
    running_late: z.boolean().optional().default(false),
  }),
  async build(ctx, args, id) {
    const coachId = args.coach_id ?? id.coachId
    if (!coachId) throw new Error('I do not know which coach that is')
    const sets = [
      `confirmed_at = coalesce(confirmed_at, app.now())`,
      `declined_at = null`,
      args.arrived ? `arrived_at = coalesce(arrived_at, app.now())` : null,
      args.running_late ? `running_late = true` : null,
    ].filter(Boolean)
    const steps: PlanStep[] = [
      {
        // Idempotency is the schema's job, not the model's: arriving twice is
        // a no-op because of `coalesce`, not because anyone remembered.
        write: `update session_coach set ${sets.join(', ')}
                 where session_id = ${uid(args.session_id)} and coach_id = ${uid(coachId)}`,
        requireRows: 1,
      },
      {
        write: `update job set status = 'cancelled'
                 where status = 'pending' and dedupe_key in (
                   ${lit(dedupe.coachNudge(args.session_id, coachId))},
                   ${lit(dedupe.coachComing(args.session_id, coachId))},
                   ${lit(dedupe.adminEscalateUncovered(args.session_id))})`,
        service: true,
      },
    ]
    if (args.running_late) {
      for (const adminPerson of await adminPersonIds(ctx)) {
        steps.push({
          message: {
            to_person_id: adminPerson,
            catalog_id: 'AD-COACH-LATE',
            subject_person_ids: [id.person?.id].filter(Boolean) as string[],
            is_escalation: true,
            body: `${id.person?.full_name ?? 'A coach'} is running late for their next session.`,
            buttons: [
              {
                title: 'Notify parents',
                action: { kind: 'reply', text: 'Tell the parents of that session the coach is running late' },
              },
            ],
          },
        })
      }
    }
    return steps
  },
}

const declineCoach: OperationDef = {
  name: 'decline_coach',
  ownScope: true,
  description:
    "A coach can't make a session. If others remain assigned the class runs on; if it would be uncovered it is offered to the other coaches.",
  params: z.object({
    session_id: uuid,
    coach_id: uuid.nullish(),
    reason: z.string().nullish(),
    confirmed: z.boolean().optional().default(false),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const today = zoned(await now(), a.timezone)
    const coachId = args.coach_id ?? id.coachId
    if (!coachId) throw new Error('I do not know which coach that is')
    const s = await sessionOf(ctx, args.session_id)
    const coaches = await coachesOnSession(ctx, s.id)

    // §8.2 — the tap confirms first. Dropping a class is not mis-tappable, and
    // that guarantee belongs in the operation rather than in whoever raised
    // the prompt, so it holds however this is reached.
    if (!args.confirmed) {
      return [
        {
          message: {
            to_person_id: id.person.id,
            body: `Just to be sure — you can't make ${s.class_name} ${whenLabel(s.starts_at, a.timezone, today)}? I'll sort out cover.`,
            buttons: [
              {
                title: "Yes, can't make it",
                action: {
                  kind: 'operation',
                  op: 'decline_coach',
                  args: { session_id: s.id, coach_id: coachId, reason: args.reason ?? null, confirmed: true },
                },
              },
              { title: 'Never mind', action: { kind: 'noop', ack: "No change — you're still on it." } },
            ],
          },
        },
      ]
    }
    const remaining = coaches.filter((c) => c.coach_id !== coachId && !c.declined_at)
    const stillCovered = isCovered(remaining)
    const when = whenLabel(s.starts_at, a.timezone, today)

    const steps: PlanStep[] = [
      {
        note: `${s.class_name} ${when} loses one coach${stillCovered ? ', still covered' : ', now uncovered'}`,
        // Said to the coach who just declined. What happens to the session's coverage
        // is the admin's question, not theirs.
        personal: `you're off ${s.class_name} ${when}${stillCovered ? ' — it is still covered' : " — I'll find cover"}`,
      },
      {
        write: `update session_coach set declined_at = app.now(), confirmed_at = null
                 where session_id = ${uid(s.id)} and coach_id = ${uid(coachId)}`,
        requireRows: 1,
      },
    ]

    if (remaining.length) {
      for (const c of remaining) {
        steps.push({
          message: {
            to_person_id: c.person_id,
            subject_person_ids: [c.person_id],
            body: stillCovered
              ? `${a.name}: you're on your own for ${s.class_name} ${when} — the class runs as normal.`
              : `${a.name}: ${s.class_name} ${when} has nobody confirmed. Can you take it?`,
            catalog_id: stillCovered ? null : 'CO-COVER-OFFER',
            buttons: stillCovered
              ? undefined
              : [
                  {
                    title: 'Claim this session',
                    action: { kind: 'operation', op: 'claim_cover', args: { session_id: s.id, coach_id: c.coach_id } },
                  },
                ],
          },
        })
      }
    }

    if (!stillCovered) {
      // §18 — never escalate about a person to that person, and never offer
      // cover to a set of one. A solo operator's drop is a reschedule, so the
      // admin is told plainly and offered that.
      for (const adminPerson of await adminPersonIds(ctx)) {
        steps.push({
          message: {
            to_person_id: adminPerson,
            catalog_id: 'AD-ESCALATE-UNCONFIRMED',
            is_escalation: true,
            subject_person_ids: [id.person?.id].filter(Boolean) as string[],
            body: `${s.class_name} ${when} has no confirmed coach${args.reason ? ` — ${args.reason}` : ''}.${
              remaining.length ? ' I have offered it to the others.' : ''
            }`,
            buttons: [
              {
                title: 'Offer to others',
                action: { kind: 'reply', text: `Offer ${s.class_name} ${when} to the other coaches` },
              },
              {
                title: 'Cancel session',
                action: { kind: 'operation', op: 'cancel_session', args: { session_id: s.id, reason: 'no coach available' } },
              },
            ],
          },
        })
      }
    }
    return steps
  },
}

const claimCover: OperationDef = {
  name: 'claim_cover',
  ownScope: true,
  description: 'A coach claims an offered session. First tap wins; the others are told it is taken.',
  params: z.object({ session_id: uuid, coach_id: uuid.nullish() }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const today = zoned(await now(), a.timezone)
    const coachId = args.coach_id ?? id.coachId
    if (!coachId) throw new Error('I do not know which coach that is')
    const s = await sessionOf(ctx, args.session_id)
    const coaches = await coachesOnSession(ctx, s.id)
    const when = whenLabel(s.starts_at, a.timezone, today)

    const holder = coaches.find((c) => !c.declined_at && (c.confirmed_at || c.arrived_at))
    if (holder && holder.coach_id !== coachId) {
      // Already gone before this tap even arrived.
      return [
        {
          message: {
            to_person_id: id.person.id,
            catalog_id: 'CO-COVER-TAKEN',
            subject_person_ids: [id.person.id],
            body: `${holder.full_name} got to ${s.class_name} ${when} first — nothing needed from you.`,
          },
        },
      ]
    }

    const steps: PlanStep[] = [
      { note: `${s.class_name} ${when} is covered`, personal: `you've got ${s.class_name} ${when}` },
      {
        // The race is settled by the database, not by the model: the row lock
        // serialises two taps, and `requireRows` aborts the loser's whole plan
        // — which, because messages are staged, means the loser has told
        // nobody anything. The caller sends CO-COVER-TAKEN on that abort.
        write: `select id from session where id = ${uid(s.id)} for update`,
        service: true,
      },
      {
        write: `insert into session_coach (academy_id, session_id, coach_id, confirmed_at)
                select ${uid(ctx.academyId)}, ${uid(s.id)}, ${uid(coachId)}, app.now()
                 where not exists (select 1 from session_coach sc
                                    where sc.session_id = ${uid(s.id)}
                                      and sc.declined_at is null
                                      and (sc.confirmed_at is not null or sc.arrived_at is not null))
                on conflict (session_id, coach_id) do update
                   set confirmed_at = app.now(), declined_at = null`,
        service: true,
        requireRows: 1,
      },
      {
        message: {
          to_person_id: id.person.id,
          subject_person_ids: [id.person.id],
          body: `Yours — ${s.class_name} ${when}${s.venue_name ? ` at ${s.venue_name}` : ''}. I've told the others.`,
        },
      },
    ]

    for (const other of coaches) {
      if (other.coach_id === coachId) continue
      steps.push({
        message: {
          to_person_id: other.person_id,
          catalog_id: 'CO-COVER-TAKEN',
          subject_person_ids: [other.person_id],
          body: `${s.class_name} ${when} has been taken — nothing needed from you.`,
        },
      })
    }
    return steps
  },
}

/* =========================================================================== *
 * client_cancel — §9.2 + §12.1 CL-CANCEL-CONFIRM
 * =========================================================================== */

const clientCancel: OperationDef = {
  name: 'client_cancel',
  ownScope: true,
  description:
    "A family cancels a session. Confirms first, then writes cancelled_timely inside the window or absent outside it, and tells the coach the headcount changed.",
  params: z.object({
    session_id: uuid,
    player_id: uuid,
    confirmed: z.boolean().optional().default(false),
    scope: z.enum(['session', 'series']).optional().default('session'),
    reason: z.string().nullish(),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const nowD = await now()
    const today = zoned(nowD, a.timezone)
    const s = await sessionOf(ctx, args.session_id)
    const roster = await rosterOf(ctx, s.class_id, isoDate(s.starts_at, a.timezone))
    const r = roster.find((x) => x.player_id === args.player_id)
    if (!r) throw new Error('that player is not on this session')
    const when = whenLabel(s.starts_at, a.timezone, today)

    const hoursOut = (new Date(s.starts_at).getTime() - nowD.getTime()) / 3_600_000
    const inWindow = hoursOut >= a.cancellation_window_hours
    const perSession = r.rate_unit === 'per_session'

    // §9.2 — "Can't make it" confirms before it acts. A pocket mis-tap must
    // never give away a seat, so the unconfirmed call only ever produces the
    // confirmation, whose button carries the confirmed version of this exact
    // operation (§2.2 — minted here, replayed verbatim on tap).
    if (!args.confirmed) {
      return [
        {
          message: {
            to_person_id: r.holder_person_id,
            catalog_id: 'CL-CANCEL-CONFIRM',
            fixed: true,
            body:
              `Just to be sure — cancel ${r.player_name} for ${s.class_name} ${when}?` +
              (perSession
                ? inWindow
                  ? " That's inside the notice period, so there's no charge."
                  : ` That's less than ${a.cancellation_window_hours}h notice, so the class is still charged.`
                : ''),
            buttons: [
              {
                title: 'Yes, cancel',
                ttl_minutes: 60,
                action: {
                  kind: 'operation',
                  op: 'client_cancel',
                  args: { session_id: s.id, player_id: r.player_id, confirmed: true, reason: args.reason ?? null },
                },
              },
              { title: 'Never mind', ttl_minutes: 60, action: { kind: 'noop', ack: "No change — I've left it as it was." } },
            ],
          },
        },
      ]
    }

    const status = inWindow ? 'cancelled_timely' : 'absent'
    const steps: PlanStep[] = [
      { note: `${r.player_name} is out of ${s.class_name} ${when}` },
      {
        // A family has no policy on `attendance` (§6.7) — this is the runtime
        // recording a cancellation on their behalf, not the parent writing to
        // the register.
        write: `insert into attendance (academy_id, session_id, player_id, status, note, marked_at)
                values (${uid(ctx.academyId)}, ${uid(s.id)}, ${uid(r.player_id)}, ${lit(status)},
                        ${lit(args.reason ?? 'cancelled by the family')}, app.now())
                on conflict (session_id, player_id) do update set
                  status = excluded.status, note = excluded.note, marked_at = excluded.marked_at`,
        service: true,
      },
      {
        write: `update job set status = 'cancelled'
                 where status = 'pending' and dedupe_key = ${lit(dedupe.clientReminder(s.id, r.player_id))}`,
        service: true,
      },
    ]

    // §6.4 — the cancellation window carries money meaning only for
    // per_session. For per_month it is a headcount signal to the coach: same
    // interface, different consequence, no extra code.
    if (perSession && !inWindow && num(r.rate_amount) > 0) {
      steps.push({
        write: `insert into tally_line (academy_id, account_id, player_id, period, kind, description, amount, session_id)
                select ${uid(ctx.academyId)}, ${uid(r.account_id)}, ${uid(r.player_id)},
                       date ${lit(periodOf(s.starts_at, a.timezone))}, 'session',
                       ${lit(`${s.class_name} — ${zoned(s.starts_at, a.timezone).toFormat('d LLL')} (late cancellation)`)},
                       ${moneyLit(num(r.rate_amount))}, ${uid(s.id)}
                 where not exists (select 1 from tally_line t
                                    where t.session_id = ${uid(s.id)} and t.player_id = ${uid(r.player_id)})`,
        service: true,
      })
    }

    steps.push({
      message: {
        to_person_id: r.holder_person_id,
        body:
          `Done — ${r.player_name} is out of ${s.class_name} ${when}.` +
          (perSession
            ? inWindow
              ? ' No charge for it.'
              : ` It was inside ${a.cancellation_window_hours}h so it's still on the tally.`
            : ''),
        buttons: [
          {
            title: 'Find a makeup',
            action: { kind: 'reply', text: `Find ${r.player_name} a makeup slot for ${s.class_name}` },
          },
        ],
      },
    })

    for (const c of await coachesOnSession(ctx, s.id)) {
      steps.push({
        message: {
          to_person_id: c.person_id,
          subject_person_ids: [c.person_id],
          body: `Headcount: ${r.player_name} is out of ${s.class_name} ${when}.`,
        },
      })
    }
    return steps
  },
}

/* =========================================================================== *
 * Money — record_payment / request_payment
 * =========================================================================== */

const recordPayment: OperationDef = {
  name: 'record_payment',
  description: 'Record a payment against an account (rail 1: the admin attests, or a screenshot was read back).',
  params: z.object({
    account_id: uuid,
    amount: z.number().positive(),
    method: z.string().nullish(),
    reference: z.string().nullish(),
    evidence_url: z.string().nullish(),
    notify: z.boolean().optional().default(true),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const [acct] = await q<{ holder_person_id: string }>(
      ctx,
      `select holder_person_id from account where id = ${uid(args.account_id)}`,
    )
    /**
     * **Settle the outstanding request, or insert a new payment. Never both.**
     *
     * This did both, unconditionally: it inserted a fresh `confirmed` row and then
     * flipped every matching `requested` row to `confirmed`. So attesting a ₹2,400
     * request booked ₹4,800 and read the family ₹2,400 in credit — and the state it
     * misfires on is exactly the one the product manufactures, because
     * `request_payment` writes the `requested` row and `AD-RECONCILE` exists to ask
     * the admin to attest it. The first Rail 1 attestation this product ever
     * performed would have been wrong, in the direction nobody checks: money the
     * business is owed, silently written off.
     *
     * The old UPDATE also matched *every* requested row of that amount and carried
     * no reference, no attester and no evidence, so the audit trail for a settled
     * request was empty.
     */
    const [outstanding] = await q<{ id: string }>(
      svc(ctx),
      `select id from payment
        where academy_id = ${uid(ctx.academyId)} and account_id = ${uid(args.account_id)}
          and status = 'requested' and amount = ${moneyLit(args.amount)}
        order by requested_at nulls last, created_at
        limit 1`,
    )
    const attester = ctx.role === 'user' ? uid(ctx.personId) : 'null'

    const steps: PlanStep[] = [
      { note: `${formatINR(args.amount)} recorded` },
      outstanding
        ? {
            // `requireRows` makes two admins attesting the same request in the same
            // second abort the second plan rather than double-credit it — which is
            // the same conditional-UPDATE trick that makes the cover race correct.
            write: `update payment
                       set status = 'confirmed',
                           confirmed_at = app.now(),
                           confirmed_by = ${attester},
                           method = coalesce(${lit(args.method ?? null)}, method),
                           reference = coalesce(${lit(args.reference ?? null)}, reference),
                           evidence_url = coalesce(${lit(args.evidence_url ?? null)}, evidence_url)
                     where id = ${uid(outstanding.id)}
                       and status = 'requested'`,
            requireRows: 1,
          }
        : {
            write: `insert into payment (academy_id, account_id, amount, rail, method, reference, status, confirmed_at, confirmed_by, evidence_url)
                    values (${uid(ctx.academyId)}, ${uid(args.account_id)}, ${moneyLit(args.amount)}, ${lit(a.rail)},
                            ${lit(args.method ?? 'upi')}, ${lit(args.reference ?? null)}, 'confirmed', app.now(),
                            ${attester}, ${lit(args.evidence_url ?? null)})`,
          },
    ]
    if (args.notify && acct) {
      steps.push({
        message: {
          to_person_id: acct.holder_person_id,
          catalog_id: 'CL-RECEIPT',
          fixed: true,
          body: `${a.name}: received ${formatINR(args.amount)}${args.reference ? `, ref ${args.reference}` : ''}. Thank you.`,
          buttons: [{ title: 'See the lines', action: { kind: 'reply', text: 'Show me my tally' } }],
        },
      })
    }
    return steps
  },
}

const requestPayment: OperationDef = {
  name: 'request_payment',
  description: "Ask an account for what's outstanding, with the UPI handle and a reconcile check-back.",
  params: z.object({
    account_id: uuid,
    amount: z.number().nullish(),
    period: z.string().nullish(),
    note: z.string().nullish(),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const nowD = await now()
    const period = args.period ? periodOf(args.period, a.timezone) : periodOf(nowD, a.timezone)
    const [acct] = await q<{ holder_person_id: string }>(
      ctx,
      `select holder_person_id from account where id = ${uid(args.account_id)}`,
    )
    const [bal] = await q<{ due: string }>(
      ctx,
      `select coalesce((select sum(amount) from tally_line
                         where account_id = ${uid(args.account_id)} and period <= date ${lit(period)}), 0)
            - coalesce((select sum(amount) from payment
                         where account_id = ${uid(args.account_id)} and status = 'confirmed'), 0) as due`,
    )
    const amount = args.amount ?? num(bal?.due)
    if (amount <= 0) return [{ note: 'nothing is outstanding on that account' }]

    const paymentId = newId()
    const steps: PlanStep[] = [
      { note: `${formatINR(amount)} requested for ${monthLabel(period, a.timezone)}` },
      {
        write: `insert into payment (id, academy_id, account_id, amount, rail, method, status, requested_at)
                values (${uid(paymentId)}, ${uid(ctx.academyId)}, ${uid(args.account_id)}, ${moneyLit(amount)},
                        ${lit(a.rail)}, 'upi', 'requested', app.now())`,
      },
    ]
    if (acct) {
      steps.push({
        message: {
          to_person_id: acct.holder_person_id,
          catalog_id: 'CL-TALLY',
          fixed: true,
          body:
            `${a.name}: ${formatINR(amount)} is due for ${monthLabel(period, a.timezone)}.` +
            (a.upi_handle ? `\nUPI: ${a.upi_handle}` : '') +
            (args.note ? `\n${args.note}` : ''),
          buttons: [
            {
              title: 'Pay now',
              action: {
                kind: 'noop',
                ack: a.upi_handle
                  ? `Pay ${formatINR(amount)} to ${a.upi_handle} from any UPI app, then tell me and I'll mark it.`
                  : `Ask ${a.name} for their UPI handle — I don't have one on file yet.`,
              },
            },
            { title: 'Already paid', action: { kind: 'reply', text: `I have already paid ${formatINR(amount)}` } },
            { title: 'See the lines', action: { kind: 'reply', text: 'Show me the lines behind that' } },
          ],
        },
      })
    }
    steps.push({
      schedule: {
        kind: 'reconcile',
        run_at: new Date(nowD.getTime() + 48 * 3_600_000).toISOString(),
        dedupe_key: dedupe.reconcile(paymentId, 1),
        payload: { payment_id: paymentId, account_id: args.account_id, period },
      },
    })
    return steps
  },
}

/**
 * `confirm_payment` — the Rail 1 attestation, addressed to one row.
 *
 * §11.5 is two arrows: `requested ──[Yes]──> confirmed`. Nothing in the product
 * could draw the first one. `AD-RECONCILE` minted its `[Yes]` as
 * `{kind:'reply', text:"Yes — Meera's ₹2,400 came in, confirm it"}` — a sentence
 * handed back to the model to re-interpret — so **a money state transition was
 * decided at tap time by inference**, which is the one thing §2.2 exists to
 * prevent, on the one table where being wrong costs the business money. The only
 * operation the model could then reach for was `record_payment(account_id,
 * amount)`, which is amount-matched and was double-crediting.
 *
 * The payment id is known at mint time — `request_payment` generates it and the
 * reconcile job carries it in its payload — so the button can carry the row. No
 * inference, no amount matching, no second confirmed row.
 */
const confirmPayment: OperationDef = {
  name: 'confirm_payment',
  description:
    'Confirm one specific payment the business asked for — the Rail 1 attestation. Takes the payment id from the reconcile prompt, never an amount.',
  params: z.object({
    payment_id: uuid,
    reference: z.string().nullish(),
    evidence_url: z.string().nullish(),
    notify: z.boolean().optional().default(true),
  }),
  async build(ctx, args, _id) {
    const a = await academyOf(ctx)
    const [p] = await q<{ account_id: string; amount: string; status: string; holder_person_id: string }>(
      svc(ctx),
      `select p.account_id, p.amount, p.status, ac.holder_person_id
         from payment p join account ac on ac.id = p.account_id
        where p.id = ${uid(args.payment_id)} and p.academy_id = ${uid(ctx.academyId)}`,
    )
    if (!p) throw new Error('that payment is not one I can see')
    if (p.status === 'confirmed') {
      // Said plainly rather than written twice. A second attestation is not a
      // no-op on a money table, it is a second credit.
      throw new Error('that payment is already confirmed — nothing to do')
    }

    const amount = num(p.amount)
    const steps: PlanStep[] = [
      { note: `${formatINR(amount)} confirmed` },
      {
        write: `update payment
                   set status = 'confirmed',
                       confirmed_at = app.now(),
                       confirmed_by = ${ctx.role === 'user' ? uid(ctx.personId) : 'null'},
                       reference = coalesce(${lit(args.reference ?? null)}, reference),
                       evidence_url = coalesce(${lit(args.evidence_url ?? null)}, evidence_url)
                 where id = ${uid(args.payment_id)}
                   and status <> 'confirmed'`,
        requireRows: 1,
      },
    ]
    if (args.notify) {
      steps.push({
        message: {
          to_person_id: p.holder_person_id,
          catalog_id: 'CL-RECEIPT',
          fixed: true,
          body: `${a.name}: received ${formatINR(amount)}${args.reference ? `, ref ${args.reference}` : ''}. Thank you.`,
          buttons: [{ title: 'See the lines', action: { kind: 'reply', text: 'Show me my tally' } }],
        },
      })
    }
    return steps
  },
}

/* =========================================================================== *
 * opt_out — §16.3. Confirmed, per-academy, and the admin is told.
 * =========================================================================== */

const optOut: OperationDef = {
  name: 'opt_out',
  description: 'Stop messaging a number for this academy. Confirmed before it takes effect; the admin is told.',
  destructive: true,
  params: z.object({ contact_id: uuid.nullish(), confirmed: z.boolean().optional().default(false) }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const contactId = args.contact_id ?? (ctx.role === 'service' ? null : ctx.contactId)
    if (!contactId) throw new Error('I do not know which number that is')

    if (!args.confirmed) {
      return [
        {
          message: {
            to_contact_id: contactId,
            body: `Just to be sure — stop all ${a.name} messages to this number? Reminders and tallies stop too.`,
            is_confirmation_request: true,
            buttons: [
              {
                title: 'Yes, stop them',
                action: { kind: 'operation', op: 'opt_out', args: { contact_id: contactId, confirmed: true } },
              },
              { title: 'Never mind', action: { kind: 'noop', ack: 'No change — you stay on the list.' } },
            ],
          },
        },
      ]
    }

    const [c] = await q<{ person_id: string; full_name: string; phone_e164: string }>(
      svc(ctx),
      `select c.person_id, p.full_name, c.phone_e164 from contact c join person p on p.id = c.person_id
        where c.id = ${uid(contactId)} and c.academy_id = ${uid(ctx.academyId)}`,
    )
    const steps: PlanStep[] = [
      {
        note: `${c?.full_name ?? 'that number'} stops hearing from ${a.name}`,
        personal: `you won't hear from ${a.name} again`,
      },
      {
        write: `update contact set opted_out_at = app.now(), state = 'opted_out'
                 where id = ${uid(contactId)} and academy_id = ${uid(ctx.academyId)}`,
        requireRows: 1,
      },
      {
        message: {
          to_contact_id: contactId,
          fixed: true,
          // The write above has already landed in this transaction, so without this
          // the gate suppresses the very sentence that says the gate worked.
          opt_out_ack: true,
          body: `Done — no more messages from ${a.name} to this number. Message me any time to turn them back on.`,
        },
      },
    ]
    for (const adminPerson of await adminPersonIds(ctx)) {
      if (c && adminPerson === c.person_id) continue
      steps.push({
        message: {
          to_person_id: adminPerson,
          catalog_id: 'AD-OPT-OUT',
          fixed: true,
          subject_person_ids: c ? [c.person_id] : undefined,
          body: `${c?.full_name ?? 'Someone'} (${c?.phone_e164 ?? ''}) has stopped messages. You may want to call.`,
          buttons: [{ title: 'Call them', action: { kind: 'noop', ack: c?.phone_e164 ?? 'No number on file.' } }],
        },
      })
    }
    return steps
  },
}

/* =========================================================================== *
 * set_timing — §8.2. The timings are defaults, not constants.
 * =========================================================================== */

// The scheduler reads exactly these keys off person.settings (then
// academy.settings, then the default), so an override written under any other
// name would be a fact that changes no behaviour.
const TIMING_KEY = z.enum([
  TIMING_KEYS.coachComingLeadMinutes,
  TIMING_KEYS.coachNudgeLeadMinutes,
  TIMING_KEYS.adminEscalateLeadMinutes,
  TIMING_KEYS.clientReminderLeadHours,
  TIMING_KEYS.registerExpiryHours,
])

const setTiming: OperationDef = {
  name: 'set_timing',
  ownScope: true,
  description:
    "Override one person's prompt timing (how far ahead they're asked, how much notice they want). Defaults live on the academy; this is the per-person override.",
  params: z.object({
    person_id: uuid.nullish(),
    key: TIMING_KEY,
    value: z.union([z.number(), z.string(), z.null()]),
    reason: z.string().nullish(),
  }),
  async build(ctx, args, id) {
    const personId = args.person_id ?? id.person.id
    const settings: Record<string, unknown> = { [args.key]: args.value }
    if (args.reason) settings[`${args.key}_why`] = args.reason
    return [
      {
        note: `${args.key.replace(/_/g, ' ')} for this person is now ${args.value ?? 'the academy default'}`,
        personal: `${args.key.replace(/_/g, ' ')} for you is now ${args.value ?? 'the usual'}`,
      },
      {
        write: `update person set settings = coalesce(settings, '{}'::jsonb) || ${jsonLit(settings)}
                 where id = ${uid(personId)} and academy_id = ${uid(ctx.academyId)}`,
        requireRows: 1,
      },
    ]
  },
}

/* =========================================================================== *
 * Catalog building — create_class / add_coach / add_family. Messages nobody.
 * =========================================================================== */

const createClass: OperationDef = {
  name: 'create_class',
  description: 'Create a class with its weekly slots, rate and coaches, and materialise its sessions.',
  params: z.object({
    name: z.string().min(1),
    venue_id: uuid.nullish(),
    rate_amount: z.number().nullish(),
    rate_unit: z.enum(['per_session', 'per_month', 'per_term', 'per_package']).nullish(),
    rate_count: z.number().int().nullish(),
    starts_on: z.string(),
    ends_on: z.string().nullish(),
    slots: z
      .array(z.object({ weekday: z.number().int().min(0).max(6), start_time: z.string(), end_time: z.string() }))
      .min(1),
    coach_ids: z.array(uuid).optional().default([]),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const classId = newId()
    /**
     * A class begins on one of its own weekdays, or it does not begin.
     *
     * Asked on a Thursday for "saturday open play 9-11am", the model wrote
     * `starts_on: 2026-08-16` — a **Sunday** — for a class whose only slot is
     * `weekday = 6`. `materialize_sessions` walks forward from `starts_on` looking
     * for matching weekdays, so it correctly produced a first session on Sat 22 Aug
     * and silently skipped Sat 15 Aug. A whole week of a batch did not exist, the
     * admin's calendar looked right (the class was there, the slot was right, the
     * price was right), and the only evidence was the absence of a session on a
     * date nobody thought to check.
     *
     * Model weekday arithmetic is unreliable — the same round set a "remind me on
     * friday" task three weeks out — and nothing downstream compared the date it
     * produced against the weekdays it produced in the same breath. Both values are
     * in scope here, ten lines apart, so the comparison is free.
     *
     * It moves the date forward rather than refusing. Refusing would be honest and
     * would cost a round: the model would have to be told, re-derive the date, and
     * call again, and it has already demonstrated it is bad at exactly that sum.
     * The intent ("start it Saturday") is unambiguous — only the arithmetic was
     * wrong — so the smallest correct start date consistent with both is the one
     * the person meant. A note goes on the plan so the preview says what happened,
     * because a silent correction is how the next wrong date gets missed.
     */
    const requested = isoDate(args.starts_on, a.timezone)
    const weekdays = new Set<number>(
      (args.slots as { weekday: number }[]).map((s) => Number(s.weekday)),
    )
    const startsOn = firstMatchingWeekday(requested, weekdays)
    const moved = startsOn !== requested
    const steps: PlanStep[] = [
      {
        note:
          `${args.name}, ${args.slots.length} slot${args.slots.length === 1 ? '' : 's'} a week` +
          (moved ? `, starting ${startsOn} — the first ${WEEKDAY_NAMES[dowOf(startsOn)]} on or after ${requested}` : ''),
      },
      {
        write: `insert into class (id, academy_id, name, venue_id, rate_amount, rate_unit, rate_count, starts_on, ends_on)
                values (${uid(classId)}, ${uid(ctx.academyId)}, ${lit(args.name)},
                        ${args.venue_id ? uid(args.venue_id) : 'null'},
                        ${args.rate_amount === null || args.rate_amount === undefined ? 'null' : moneyLit(args.rate_amount)},
                        ${lit(args.rate_unit ?? null)}, ${lit(args.rate_count ?? null)},
                        date ${lit(startsOn)}, ${args.ends_on ? `date ${lit(isoDate(args.ends_on, a.timezone))}` : 'null'})`,
      },
    ]
    for (const s of args.slots) {
      steps.push({
        write: `insert into class_slot (academy_id, class_id, weekday, start_time, end_time)
                values (${uid(ctx.academyId)}, ${uid(classId)}, ${lit(s.weekday)},
                        time ${lit(s.start_time)}, time ${lit(s.end_time)})`,
      })
    }
    for (const c of args.coach_ids) {
      steps.push({
        write: `insert into class_coach (academy_id, class_id, coach_id)
                values (${uid(ctx.academyId)}, ${uid(classId)}, ${uid(c)})
                on conflict (class_id, coach_id) do nothing`,
      })
    }
    steps.push({
      schedule: {
        kind: 'materialize_sessions',
        // See `client_cancel`: host now and domain now are different timelines. This one
        // is the worse of the two to get wrong — it is what turns a newly created class
        // into actual sessions, so a class created while the domain clock trails the host
        // gets no sessions at all, and nothing anywhere reports it.
        run_at: (await now()).toISOString(),
        dedupe_key: dedupe.materializeSessions(classId, startsOn),
        payload: { class_id: classId, academy_id: ctx.academyId },
      },
    })
    return steps
  },
}

/**
 * `close_class` — retire a batch, and give its name back.
 *
 * **This exists because a previous fix created the gap.** 0021 made class names
 * unique among classes that are still OPEN (`active and ends_on is null`), which
 * is what makes the model's own lookups correct — it reads classes by name, with
 * `limit 1`, so two open "Evening Fitness" rows silently made every one of those
 * lookups a coin flip. The migration wrote down what it cost: "the way to reuse a
 * name is to close the old class, and there is currently no operation that does
 * so." R9 — an optimisation that removed a capability nobody was measuring, and
 * the one root you are most likely to create yourself.
 *
 * Closing is an END DATE, never a delete. §6.3 keeps ended classes for ever: last
 * season's roster, its registers and its money all still have to resolve, and a
 * deleted class takes its sessions' history with it.
 *
 * **What it deliberately does, beyond setting the date.** A class with no end date
 * is a class the rest of the product still plans for — `plan_ahead` materialises
 * its sessions, the coach ladder chases its registers, and `monthly_lines` bills
 * its enrolments on the 1st. Setting `ends_on` alone and calling it closed would
 * leave a retired batch quietly billing families, which is the exact shape of R6:
 * a record narrower than the change it stands for. So the enrolments end on the
 * same date and the sessions after it are cancelled, in one plan, previewable as
 * one thing.
 *
 * It does NOT message the families. Ending a batch is a conversation the business
 * has, and what to say about it differs every time — a merge, a coach leaving, a
 * season ending. The note says how many people are affected so the admin knows
 * what they are about to owe an explanation to, and `end_enrollment`'s own
 * messaging is not duplicated here.
 */
const closeClass: OperationDef = {
  name: 'close_class',
  description:
    'Retire a class from a date: stops its sessions and enrolments, keeps all its history, and frees its name for reuse. '
    + 'Use when a batch is ending, merging, or being replaced by one with the same name.',
  destructive: true,
  params: z.object({
    class_id: uuid,
    end_date: z.string().nullish(),
    reason: z.string().nullish(),
  }),
  async build(ctx, args) {
    const a = await academyOf(ctx)
    const endIso = isoDate(args.end_date ?? (await now()).toISOString(), a.timezone)

    const [cls] = await q<{ id: string; name: string; ends_on: string | null }>(
      ctx,
      `select id, name, ends_on::text as ends_on from class
        where id = ${uid(args.class_id)} and academy_id = ${uid(ctx.academyId)}`,
    )
    if (!cls) throw new Error('that is not a class I can see')
    // R7: doing nothing must not read as success. A class that is already closed
    // is not a no-op to report as done — it is a question the admin asked whose
    // answer is "that already happened", and the date is the useful half.
    if (cls.ends_on) {
      throw new Error(`${cls.name} already closed on ${zoned(cls.ends_on, a.timezone).toFormat('d LLL yyyy')}`)
    }

    const live = await liveEnrollments(ctx, `e.class_id = ${uid(args.class_id)}`, endIso, a.timezone)
    const [ahead] = await q<{ n: string }>(
      ctx,
      `select count(*) as n from session
        where class_id = ${uid(args.class_id)} and status = 'scheduled'
          and (starts_at at time zone ${lit(a.timezone)})::date > date ${lit(endIso)}`,
    )
    const upcoming = num(ahead?.n)

    const steps: PlanStep[] = [
      {
        note:
          `${cls.name} closes on ${zoned(endIso, a.timezone).toFormat('d LLL')}`
          + (live.length ? `, ending ${live.length} enrolment${live.length === 1 ? '' : 's'}` : '')
          + (upcoming ? ` and cancelling ${upcoming} scheduled session${upcoming === 1 ? '' : 's'}` : '')
          + (args.reason ? ` — ${args.reason}` : '')
          + '. The name is free to use again',
      },
      {
        write: `update class set ends_on = date ${lit(endIso)}
                 where id = ${uid(args.class_id)} and academy_id = ${uid(ctx.academyId)}
                   and ends_on is null`,
        requireRows: 1,
      },
    ]

    if (live.length) {
      steps.push({
        write: `update enrollment set ended_on = date ${lit(endIso)}
                 where id in (${live.map((l) => uid(l.enrollment_id)).join(',')})
                   and academy_id = ${uid(ctx.academyId)} and ended_on is null`,
        requireRows: live.length,
      })
    }

    if (upcoming) {
      // Only sessions AFTER the end date. A class closing on the 31st still ran on
      // the 30th, and cancelling that session would rewrite a register that was
      // already marked and money that was already billed against it.
      steps.push({
        write: `update session set status = 'cancelled'
                 where class_id = ${uid(args.class_id)} and academy_id = ${uid(ctx.academyId)}
                   and status = 'scheduled'
                   and (starts_at at time zone ${lit(a.timezone)})::date > date ${lit(endIso)}`,
        requireRows: upcoming,
      })
    }

    steps.push(...deactivateStrandedPlayers(ctx, [...new Set(live.map((l) => l.player_id))], a.timezone))
    return steps
  },
}

const addCoach: OperationDef = {
  name: 'add_coach',
  description: 'Add a coach: contact, classes, pay rate. Three facts, and it messages nobody.',
  params: z.object({
    full_name: z.string().min(1),
    phone_e164: z.string().min(6),
    pay_amount: z.number().nullish(),
    pay_unit: z.enum(['per_session', 'per_hour', 'per_month']).nullish(),
    class_ids: z.array(uuid).optional().default([]),
  }),
  async build(ctx, args, id) {
    const phone = args.phone_e164.replace(/[^\d+]/g, '')
    // One phone is one human here — see `resolvePersonByPhone` for the two Ravi Menons
    // this produced on a live drive.
    const existingPersonId = await resolvePersonByPhone(ctx, phone)
    const personId = existingPersonId ?? newId()
    const coachId = newId()

    if (existingPersonId) {
      const [already] = await q<{ id: string; status: string; full_name: string }>(
        ctx,
        `select c.id, c.status, p.full_name from coach c join person p on p.id = c.person_id
          where c.academy_id = ${uid(ctx.academyId)} and c.person_id = ${uid(existingPersonId)}
          limit 1`,
      )
      // Refusing beats silently making a second one. The admin who says "add Ravi"
      // twice is not asking for two Ravis, and the model cannot tell the difference
      // from a tool result that says `ok: true` either way.
      if (already) {
        throw new Error(
          `add_coach: ${already.full_name} is already a coach here (${already.status}), on that same number. ` +
            `Do not add them again — that would be a second person behind one phone. ` +
            `If they need inviting, use send_invite_draft with coach_id ${already.id}. ` +
            `If they left and are coming back, say so and change that coach's status instead.`,
        )
      }
    }

    const steps: PlanStep[] = [
      { note: `${args.full_name} added as a coach — nobody is messaged yet` },
      // Only when this phone is nobody yet. Reusing the person who already owns it is
      // what keeps one human from becoming two.
      ...(existingPersonId
        ? []
        : ([
            {
              write: `insert into person (id, academy_id, full_name)
                values (${uid(personId)}, ${uid(ctx.academyId)}, ${lit(args.full_name)})`,
              requireRows: 1,
            },
            {
              // No `on conflict do nothing`. It is what turned "this phone is already
              // somebody" into silence, and left a coach with no way to be reached.
              // We have just established the phone is free; if it is not, the world
              // moved under this plan and the plan must fail rather than orphan a row.
              write: `insert into contact (academy_id, person_id, phone_e164, state, role_hint)
                values (${uid(ctx.academyId)}, ${uid(personId)}, ${lit(phone)}, 'registered', 'coach')`,
              requireRows: 1,
            },
          ] as PlanStep[])),
      {
        write: `insert into coach (id, academy_id, person_id, pay_amount, pay_unit, status)
                values (${uid(coachId)}, ${uid(ctx.academyId)}, ${uid(personId)},
                        ${args.pay_amount === null || args.pay_amount === undefined ? 'null' : moneyLit(args.pay_amount)},
                        ${lit(args.pay_unit ?? null)}, 'added')`,
        requireRows: 1,
      },
    ]
    for (const c of args.class_ids) {
      steps.push({
        write: `insert into class_coach (academy_id, class_id, coach_id)
                values (${uid(ctx.academyId)}, ${uid(c)}, ${uid(coachId)})
                on conflict (class_id, coach_id) do nothing`,
      })
      steps.push({
        write: `insert into session_coach (academy_id, session_id, coach_id)
                select ${uid(ctx.academyId)}, s.id, ${uid(coachId)} from session s
                 where s.class_id = ${uid(c)} and s.status = 'scheduled' and s.starts_at > app.now()
                   and not exists (select 1 from session_coach x where x.session_id = s.id and x.coach_id = ${uid(coachId)})`,
      })
    }
    return steps
  },
}

const addFamily: OperationDef = {
  name: 'add_family',
  description: 'Add a family and their players from shared contacts or a photographed register. Messages nobody.',
  params: z.object({
    holder_name: z.string().min(1),
    phone_e164: z.string().min(6),
    players: z
      .array(
        z.object({
          name: z.string().min(1),
          class_id: uuid.nullish(),
          rate_amount: z.number().nullish(),
          rate_unit: z.enum(['per_session', 'per_month', 'per_term', 'per_package']).nullish(),
          started_on: z.string().nullish(),
        }),
      )
      .min(1),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const today = zoned(await now(), a.timezone).toFormat('yyyy-MM-dd')
    const phone = args.phone_e164.replace(/[^\d+]/g, '')
    // The same question `add_coach` was not asking. A parent added twice — from a
    // photographed register and then by hand, which is the normal way this happens —
    // became two people behind one phone, one of them holding the money.
    const existingPersonId = await resolvePersonByPhone(ctx, phone)
    const holderPersonId = existingPersonId ?? newId()
    const accountId = newId()
    const steps: PlanStep[] = [
      {
        note: `${args.holder_name} and ${args.players.length} player${
          args.players.length === 1 ? '' : 's'
        } — nobody is messaged (§2.6)`,
      },
      ...(existingPersonId
        ? []
        : ([
            {
              write: `insert into person (id, academy_id, full_name)
                values (${uid(holderPersonId)}, ${uid(ctx.academyId)}, ${lit(args.holder_name)})`,
              requireRows: 1,
            },
            {
              // See `add_coach`: `on conflict do nothing` here is how a household ends
              // up with an account nobody can be reached about.
              write: `insert into contact (academy_id, person_id, phone_e164, state, role_hint)
                values (${uid(ctx.academyId)}, ${uid(holderPersonId)}, ${lit(phone)}, 'registered', 'account_holder')`,
              requireRows: 1,
            },
          ] as PlanStep[])),
      {
        // An account per holder, not per call. Adding a second player later must land
        // in the household that already exists rather than opening a rival one that
        // splits the balance in half.
        write: `insert into account (id, academy_id, holder_person_id, display_name)
                select ${uid(accountId)}, ${uid(ctx.academyId)}, ${uid(holderPersonId)}, ${lit(args.holder_name)}
                 where not exists (select 1 from account
                                    where academy_id = ${uid(ctx.academyId)}
                                      and holder_person_id = ${uid(holderPersonId)})`,
      },
    ]
    for (const p of args.players) {
      // The self-paying adult is holder_person_id = player.person_id. Not a
      // second case — the same objects at n=1.
      //
      // Through `normalName` so this path and `book_trial`'s answer the question the
      // same way. It was `trim().toLowerCase()` here, which is a comparison on
      // unnormalised values (R5): "Deepa  Nair" against "Deepa Nair" is two humans by
      // that test and one by any other. The two operations disagreeing about what a
      // person is, in either direction, is the defect — not which rule wins.
      const samePerson = normalName(p.name) === normalName(args.holder_name)
      const playerPersonId = samePerson ? holderPersonId : newId()
      const playerId = newId()
      if (!samePerson) {
        steps.push({
          write: `insert into person (id, academy_id, full_name)
                  values (${uid(playerPersonId)}, ${uid(ctx.academyId)}, ${lit(p.name)})`,
        })
      }
      steps.push({
        // The account is read back rather than assumed: when the holder was already
        // here, the row above inserted nothing and `accountId` names no account. Same
        // subquery `book_trial` uses, so both paths land in one household.
        write: `insert into player (id, academy_id, account_id, person_id)
                select ${uid(playerId)}, ${uid(ctx.academyId)},
                       (select id from account
                         where academy_id = ${uid(ctx.academyId)}
                           and holder_person_id = ${uid(holderPersonId)}
                         order by created_at limit 1),
                       ${uid(playerPersonId)}`,
        requireRows: 1,
      })
      if (p.class_id) {
        steps.push({
          write: `insert into enrollment (academy_id, class_id, player_id, rate_amount, rate_unit, started_on)
                  values (${uid(ctx.academyId)}, ${uid(p.class_id)}, ${uid(playerId)},
                          ${p.rate_amount === null || p.rate_amount === undefined ? 'null' : moneyLit(p.rate_amount)},
                          ${lit(p.rate_unit ?? null)},
                          date ${lit(p.started_on ? isoDate(p.started_on, a.timezone) : today)})`,
        })
      }
    }
    return steps
  },
}

/* =========================================================================== *
 * onboard_coach — §8.1 step 3 / §11.3. `invited ──([Looks right])──> active`.
 *
 * The transition existed in the state machine, in the spec and in the behavior
 * module — "`Looks right` has to actually make them active; a button that only
 * writes down that they agreed changes nothing: they stay un-onboarded, the admin
 * is still told nobody has confirmed, and the coach thinks they are done" — and
 * there was no operation that performed it. Nothing in the registry moved a coach
 * out of `invited`.
 *
 * So the model minted the nearest-sounding name it could find. Watched, on a
 * coach's first ever message: `[Looks right]` carried `confirm_coach`, which is
 * about a *session* and requires a `session_id`, and it died at the tap. The
 * coach was told "that didn't go through" and stayed invited forever.
 *
 * A capability with no way to reach it is indistinguishable, from outside, from a
 * model that never wants it — and the model wanted it badly enough to reach for
 * the wrong verb rather than none.
 * =========================================================================== */

const onboardCoach: OperationDef = {
  name: 'onboard_coach',
  ownScope: true,
  description:
    "A coach confirms their classes are right, on their first run: `invited` → `active`, and they start getting their day. This is what [Looks right] does — the point of that message, not a note that they agreed.",
  params: z.object({
    coach_id: uuid.nullish(),
  }),
  async build(ctx, args, id) {
    const coachId = args.coach_id ?? id.coachId
    if (!coachId) throw new Error('I do not know which coach that is')
    return [
      {
        // Idempotent by the same rule as everything else here: confirming twice is
        // one confirmation, because `coalesce` says so and not because anyone
        // remembered. `status` moves from anywhere before active; an ended coach
        // stays ended, which is a decision only the admin makes.
        //
        // `service: true` because §6.7 gives a coach READ of their own row and no
        // write — correctly: a coach who could set their own status could set their
        // own pay. So this is the runtime keeping the promise §8.1 makes on the
        // product's behalf, exactly like the job-cancellation step in `confirm_coach`
        // next door. Under the coach's own session the update matched zero rows and
        // said nothing, and the coach was told they were set up.
        service: true,
        // The historical case this guard exists for: a coach tapped `[Looks right]`,
        // RLS gave them no UPDATE on their own row, Postgres changed nothing and raised
        // nothing, and they were told *"Great! You're all set up."* They stayed
        // `invited` forever and the admin kept being told nobody had confirmed.
        write: `update coach
                   set status = 'active',
                       onboarded_at = coalesce(onboarded_at, app.now()),
                       invited_at = coalesce(invited_at, app.now())
                 where id = ${uid(coachId)} and academy_id = ${uid(ctx.academyId)} and ended_on is null`,
        requireRows: 1,
      },
      // This one is almost always read by the coach themselves — it is what
      // `[Looks right]` returns on their first run — and the operator voice made the
      // last message of their onboarding talk about them as if they were not there.
      {
        note: 'they are set up and will get their day from now on',
        personal: "you're all set — I'll send you your day from here on",
      },
    ]
  },
}

/* =========================================================================== *
 * send_invite_draft — §8.1 step 2 / §9.1 step 2. Self-initiated invites.
 * =========================================================================== */

const sendInviteDraft: OperationDef = {
  name: 'send_invite_draft',
  ownScope: true,
  description:
    'Draft the invite the ADMIN forwards from their own number, carrying a wa.me deep link with prefilled text. The bot never sends it.',
  params: z.object({
    coach_id: uuid.nullish(),
    person_id: uuid.nullish(),
    mark_sent: z.boolean().optional().default(false),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const [sender] = await q<{ phone_e164: string }>(
      svc(ctx),
      `select s.phone_e164 from sender s join academy ac on ac.sender_id = s.id
        where ac.id = ${uid(ctx.academyId)}`,
    )
    /**
     * An invite nobody is named in is not an invite. **Driven:** an admin said "add a new
     * coach Vikram Shetty, number 9845019999", the model put `add_coach` and
     * `send_invite_draft` in ONE plan, and the admin was handed
     *
     *     Hi them — we've moved Ace TT Academy's scheduling onto WhatsApp.
     *
     * to forward to a real person. `name` started as the string `'them'` and the lookup
     * that should have replaced it missed, so the placeholder shipped — R7, a lookup that
     * finds nothing succeeding.
     *
     * The miss is not random and the message says so. Operations are expanded and built
     * BEFORE the transaction opens, so a coach an earlier step of the same plan creates
     * does not exist yet when this step's `build` runs. The two acts have to be two plans,
     * which is exactly what the model does when it is told — watched immediately after:
     * it read this refusal, called `send_invite_draft` alone with the existing coach id,
     * and the invite went out addressed properly.
     */
    let personId = args.person_id ?? null
    let name: string | null = null
    if (args.coach_id) {
      const [c] = await q<{ person_id: string; full_name: string }>(
        ctx,
        `select c.person_id, p.full_name from coach c join person p on p.id = c.person_id
          where c.id = ${uid(args.coach_id)}`,
      )
      if (c) {
        name = c.full_name
        personId = c.person_id
      }
    } else if (personId) {
      const [p] = await q<{ full_name: string }>(ctx, `select full_name from person where id = ${uid(personId)}`)
      if (p) name = p.full_name
    }

    if (!name) {
      throw new Error(
        args.coach_id || args.person_id
          ? 'send_invite_draft: that id matches nobody I can see, so there is no name to address the invite to. ' +
            'If the coach is created by an earlier step of THIS plan, they do not exist yet — this operation is ' +
            'built before the plan runs. Commit the plan that adds them first, read the coach id back, then draft ' +
            'the invite in a second plan.'
          : 'send_invite_draft: say who this invite is for — pass coach_id (or person_id). Without one the draft ' +
            'is addressed to "them", which is not something anyone can forward.',
      )
    }

    const prefill = `Hi ${a.name}`
    const digits = (sender?.phone_e164 ?? '').replace(/[^\d]/g, '')
    const link = `https://wa.me/${digits}?text=${encodeURIComponent(prefill)}`
    const draft =
      `Hi ${name.split(' ')[0]} — we've moved ${a.name}'s scheduling onto WhatsApp. ` +
      `Tap this and send the message it fills in, and it'll set you up: ${link}`

    const steps: PlanStep[] = [
      { note: `an invite draft for ${name}, for you to forward` },
      {
        message: {
          to_contact_id: ctx.role === 'service' ? undefined : ctx.contactId,
          to_person_id: ctx.role === 'service' ? id.person?.id : undefined,
          pre_launch_ok: true,
          // `[Sent it]` re-ran this operation and re-sent the identical draft, which the
          // repeat gate then ate — so the admin tapped a button and their chat showed
          // nothing at all. A tap that changes something has to say something new, and
          // what changed here is the only thing worth saying.
          body: args.mark_sent
            ? `Noted — ${name}'s invite is out. Nothing more from me until they tap it; ` +
              `if they have a session in the next couple of days and still haven't, I'll tell you.`
            : `Here's the invite for ${name} — send it from your own number so it lands warm:\n\n` +
              `${draft}\n\n` +
              `Once they tap it, I take it from there.`,
          buttons: args.mark_sent
            ? undefined
            : [
                {
                  title: 'Sent it',
                  action: {
                    kind: 'operation',
                    op: 'send_invite_draft',
                    args: { coach_id: args.coach_id ?? null, person_id: personId, mark_sent: true },
                  },
                },
                { title: 'Edit', action: { kind: 'reply', text: `Reword the invite for ${name}` } },
              ],
        },
      },
    ]
    if (args.mark_sent && args.coach_id) {
      steps.push({
        write: `update coach set status = 'invited', invited_at = app.now()
                 where id = ${uid(args.coach_id)} and academy_id = ${uid(ctx.academyId)} and status = 'added'`,
      })
    }
    return steps
  },
}

/* =========================================================================== *
 * undo — §7.2. Reverses database writes only, and says so before it runs.
 * =========================================================================== */

type AuditRow = {
  id: string
  intent: string | null
  plan: any
  diff: any
  undone_at: string | null
  actor_person_id: string | null
  created_at: string
}

const undo: OperationDef = {
  name: 'undo',
  description:
    'Undo a previous operation. Reverses the database writes; anyone who was messaged gets a correction, and I say so before it runs.',
  destructive: true,
  params: z.object({ audit_id: uuid, confirmed: z.boolean().optional().default(false) }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const [entry] = await q<AuditRow>(
      svc(ctx),
      `select id, intent, plan, diff, undone_at, actor_person_id, created_at from audit_entry
        where id = ${uid(args.audit_id)} and academy_id = ${uid(ctx.academyId)}`,
    )
    if (!entry) throw new Error("I can't find that change to undo")
    if (entry.undone_at) return [{ note: 'that change has already been undone' }]

    // Who was told, recorded on the audit entry when the plan flushed its
    // outbox. This is the whole reason undo can send a correction to exactly
    // those people and nobody else (§7.2).
    const told: { contact_id: string; body: string }[] = Array.isArray(entry.diff?.messages)
      ? entry.diff.messages
      : []
    // The before-images live in row_snapshot, and lib/audit builds the inverse
    // statements from them. Undo runs them through the ordinary plan machinery
    // — same transaction, same diff, same audit entry — under the caller's own
    // role, so RLS caps an undo at exactly what that human could have done by
    // hand.
    const inverse = await inverseOf(ctx, args.audit_id).catch(() => [] as PlanStep[])
    const rows = inverse.length

    // A sent message cannot be unsent. Saying exactly what undo will and will
    // not do, before it runs, is the whole difference between an undo that
    // works and one that half-works.
    if (!args.confirmed) {
      const willTell = told.length
        ? ` and tell the ${told.length} ${told.length === 1 ? 'person' : 'people'} I told that I was wrong`
        : ''
      const canReverse = inverse.length > 0
      return [
        {
          message: {
            to_contact_id: ctx.role === 'service' ? undefined : ctx.contactId,
            to_person_id: ctx.role === 'service' ? id.person?.id : undefined,
            body: canReverse
              ? `I'll put ${rows} ${rows === 1 ? 'row' : 'rows'} back${willTell}. Messages already sent can't be unsent — the correction is the best I can do.`
              : `I can't safely undo that one: I don't have before-images of what it changed. I can tell you exactly what it did, or you can tell me what to set it back to.`,
            buttons: canReverse
              ? [
                  {
                    title: 'Do it',
                    action: { kind: 'operation', op: 'undo', args: { audit_id: args.audit_id, confirmed: true } },
                  },
                  { title: 'Leave it', action: { kind: 'noop', ack: 'Left as it is.' } },
                ]
              : [{ title: 'What did it do?', action: { kind: 'reply', text: `What did change ${args.audit_id} do?` } }],
          },
        },
      ]
    }

    if (!inverse.length) {
      return [
        {
          message: {
            to_contact_id: ctx.role === 'service' ? undefined : ctx.contactId,
            to_person_id: ctx.role === 'service' ? id.person?.id : undefined,
            body: "There's nothing for me to put back — I don't hold before-images for that change.",
          },
        },
      ]
    }

    const steps: PlanStep[] = [{ note: `undoing: ${entry.intent ?? 'an earlier change'}` }, ...inverse]
    steps.push({
      write: `update audit_entry set undone_at = app.now() where id = ${uid(args.audit_id)}`,
      service: true,
      requireRows: 1,
    })

    // A correction to exactly the people who were told, and nobody else.
    for (const t of told) {
      if (!t?.contact_id) continue
      steps.push({
        message: {
          to_contact_id: t.contact_id,
          fixed: true,
          body: `Correction from ${a.name}: ignore my last message about this — it was a mistake on my side and I've put it back. Sorry for the noise.`,
        },
      })
    }
    return steps
  },
}

/* =========================================================================== *
 * Onboarding state, memory, watches
 * =========================================================================== */


const setOnboardingState: OperationDef = {
  name: 'set_onboarding_state',
  description:
    "Move the academy through setup → roster → ready → live. Nothing is sent to anyone until it is 'live' (§2.6). "
    + 'Going live needs at least one active class — a class created earlier in the same plan counts.',
  params: z.object({ state: z.enum(['setup', 'roster', 'ready', 'live']) }),
  async build(ctx, args) {
    if (args.state !== 'live') {
      return [
        { note: `onboarding moves to ${args.state} — still messaging nobody` },
        {
          write: `update academy set onboarding_state = ${lit(args.state)} where id = ${uid(ctx.academyId)}`,
          requireRows: 1,
        },
      ]
    }

    /**
     * The precondition rides IN the statement, not in a read taken before the plan.
     *
     * It was a build-time query, and `build()` runs before any of the plan's steps do —
     * so it saw the world as it was, not as the plan was about to leave it. Driven:
     * asked to "set the UPI to probe@upi and switch it on", the model composed one plan
     * whose first step set the handle and whose second went live, and the receipt read
     * *"messages start flowing — note there is still no UPI handle, so nobody can pay"*
     * about a plan that had just set one. The same staleness made the hard block worse
     * than wrong: "add a class and go live" in a single plan would have been REFUSED for
     * having no classes, moments before creating one.
     *
     * As an `exists` inside the UPDATE it is evaluated where the plan already is —
     * inside the transaction, after the earlier steps — so a class created a step ago
     * counts. `requireRows: 1` turns "no class" into a precondition failure that aborts
     * the whole plan rather than a silent no-op, which is what `requireRows` is for.
     *
     * The "what is still missing" list is gone with the read that produced it. It was
     * never a check — the admin census carries the same facts every turn, computed fresh
     * — and the one thing it added over the census was the chance to be out of date at
     * the exact moment somebody was fixing it.
     */
    return [
      { note: 'messages start flowing from now on' },
      {
        write: `update academy set onboarding_state = 'live'
                 where id = ${uid(ctx.academyId)}
                   and exists (select 1 from class
                                where academy_id = ${uid(ctx.academyId)} and active)`,
        requireRows: 1,
      },
    ]
  },
}

const remember: OperationDef = {
  name: 'remember',
  ownScope: true,
  description: 'Write a fact about this academy or this person. Facts are appended, never edited.',
  params: z.object({
    subject_kind: z.enum(['academy', 'person']),
    subject_id: uuid.nullish(),
    fact: z.string().min(1),
    supersedes: uuid.nullish(),
    source: z.string().nullish(),
  }),
  async build(ctx, args, id) {
    const subjectId = args.subject_id ?? (args.subject_kind === 'academy' ? ctx.academyId : id.person.id)
    return [
      { note: `remembering: ${args.fact}` },
      {
        write: `insert into memory_fact (academy_id, subject_kind, subject_id, fact, source, supersedes)
                values (${uid(ctx.academyId)}, ${lit(args.subject_kind)}, ${uid(subjectId)}, ${lit(args.fact)},
                        ${lit(args.source ?? 'told to me')}, ${args.supersedes ? uid(args.supersedes) : 'null'})`,
        service: true,
      },
    ]
  },
}

const forget: OperationDef = {
  name: 'forget',
  ownScope: true,
  description: 'Retire a fact. Nothing is deleted — the record keeps why it was believed and when it stopped being true.',
  params: z.object({ fact_id: uuid.nullish(), matching: z.string().nullish() }),
  async build(ctx, args, id) {
    if (!args.fact_id && !args.matching) throw new Error('tell me which fact to retire')
    const where = args.fact_id
      ? `id = ${uid(args.fact_id)}`
      : `fact ilike ${lit(`%${String(args.matching).slice(0, 120)}%`)} and retired_at is null`
    return [
      { note: `retiring a remembered fact` },
      {
        // "I've forgotten that" is a false sentence when nothing was retired, and the
        // person has no way to find out. Better to say there was nothing to forget.
        write: `update memory_fact set retired_at = app.now()
                 where academy_id = ${uid(ctx.academyId)} and ${where}`,
        service: true,
        requireRows: 1,
      },
    ]
  },
}

const listWatches: OperationDef = {
  name: 'list_watches',
  ownScope: true,
  description: 'Show everything I am watching for this academy, with a way to drop any of them.',
  params: z.object({}),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const today = zoned(await now(), a.timezone)
    const rows = await liveAgentTasks(ctx.academyId)
    if (!rows.length) {
      return [
        {
          message: {
            to_contact_id: ctx.role === 'service' ? undefined : ctx.contactId,
            to_person_id: ctx.role === 'service' ? id.person?.id : undefined,
            body: "Nothing on my watch list right now. Ask me to keep an eye on something and it'll show up here.",
          },
        },
      ]
    }
    const lines = rows.map(
      (r, i) => `${i + 1}. ${String(r.instruction || r.slug).slice(0, 120)} — ${whenLabel(r.run_at, a.timezone, today)}`,
    )
    return [
      {
        message: {
          to_contact_id: ctx.role === 'service' ? undefined : ctx.contactId,
          to_person_id: ctx.role === 'service' ? id.person?.id : undefined,
          body: `Watching ${rows.length} thing${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
          buttons: rows.slice(0, 3).map((r, i) => ({
            title: `Drop ${i + 1}`,
            action: { kind: 'operation' as const, op: 'drop_watch', args: { slug: r.slug } },
          })),
        },
      },
    ]
  },
}

const dropWatch: OperationDef = {
  name: 'drop_watch',
  ownScope: true,
  description: 'Stop watching something.',
  params: z.object({ slug: z.string().min(1) }),
  async build(ctx, args, id) {
    return [
      { note: `dropping a watch` },
      {
        // In-transaction rather than lib/jobs' own `dropAgentTask`, so that
        // dropping a watch inside a bigger plan commits or rolls back with it.
        write: `update job set status = 'cancelled'
                 where kind = 'agent_task' and status = 'pending'
                   and dedupe_key = ${lit(dedupe.agentTask(ctx.academyId, args.slug))}
                   and payload->>'academy_id' = ${lit(ctx.academyId)}`,
        service: true,
        requireRows: 1,
      },
      {
        message: {
          to_contact_id: ctx.role === 'service' ? undefined : ctx.contactId,
          to_person_id: ctx.role === 'service' ? id.person?.id : undefined,
          body: "Dropped — I'll stop watching that.",
        },
      },
    ]
  },
}

/* ------------------------------------------------------------------------- */

export const OPERATIONS: Record<OperationName, OperationDef> = {
  end_coach: endCoach,
  end_enrollment: endEnrollment,
  end_client: endClient,
  cancel_session: cancelSession,
  move_class: moveClass,
  reschedule_session: rescheduleSession,
  waive,
  book_trial: bookTrial,
  mark_attendance: markAttendance,
  confirm_coach: confirmCoach,
  onboard_coach: onboardCoach,
  decline_coach: declineCoach,
  claim_cover: claimCover,
  client_cancel: clientCancel,
  record_payment: recordPayment,
  request_payment: requestPayment,
  confirm_payment: confirmPayment,
  opt_out: optOut,
  set_timing: setTiming,
  create_class: createClass,
  close_class: closeClass,
  add_coach: addCoach,
  add_family: addFamily,
  send_invite_draft: sendInviteDraft,
  undo,
  set_onboarding_state: setOnboardingState,
  remember,
  forget,
  list_watches: listWatches,
  drop_watch: dropWatch,
}

/* ------------------------------------------------------------------------- *
 * Signatures for the stable prefix (§4.4). Generated from the schemas so they
 * cannot drift from what the code actually accepts.
 * ------------------------------------------------------------------------- */

function describe(schema: any, depth = 0): string {
  const d = schema?._def
  const t = d?.typeName
  try {
    switch (t) {
      case 'ZodObject': {
        const shape = typeof schema.shape === 'function' ? schema.shape() : schema.shape
        const keys = Object.entries(shape ?? {}).map(([k, v]) => `${k}${optionalMark(v)}: ${describe(v, depth + 1)}`)
        return depth === 0 ? `{ ${keys.join(', ')} }` : '{…}'
      }
      case 'ZodString':
        return 'string'
      case 'ZodNumber':
        return 'number'
      case 'ZodBoolean':
        return 'bool'
      case 'ZodNull':
        return 'null'
      case 'ZodEnum':
        return (d.values ?? []).join('|')
      case 'ZodArray':
        return `${describe(d.type, depth + 1)}[]`
      case 'ZodUnion':
        return (d.options ?? []).map((o: any) => describe(o, depth + 1)).join('|')
      case 'ZodOptional':
      case 'ZodNullable':
      case 'ZodDefault':
        return describe(d.innerType, depth)
      case 'ZodEffects':
        return describe(d.schema, depth)
      case 'ZodRecord':
        return 'object'
      default:
        return 'any'
    }
  } catch {
    return 'any'
  }
}

function optionalMark(v: any): string {
  const t = v?._def?.typeName
  return t === 'ZodOptional' || t === 'ZodNullable' || t === 'ZodDefault' ? '?' : ''
}

let SIGNATURES: string | null = null

/** ~1k tokens, part of the stable prefix. Byte-identical across turns. */
/**
 * One operation's signature, for an error that has to say what would have worked.
 *
 * A step rejected for its *arguments* was being answered with a hint about the *shape*
 * of a step — "steps is a JSON array, each element has exactly one of write, operation,
 * adjust…" — which is true, was not the problem, and sent the model round the loop
 * re-encoding a plan whose encoding was already right. The registry holds the answer;
 * this is how it reaches the model at the moment it is wrong.
 */
export function operationSignature(name: string): string | null {
  const op = OPERATIONS[name as OperationName]
  if (!op) return null
  return `${name}${describe(op.params)} — ${op.description}`
}

export function operationSignatures(): string {
  if (SIGNATURES) return SIGNATURES
  const lines = (Object.keys(OPERATIONS) as OperationName[]).sort().map((name) => {
    const op = OPERATIONS[name]
    return `- ${name}${describe(op.params)}${op.destructive ? '  [destructive → always previewed]' : ''}\n    ${op.description}`
  })
  SIGNATURES = lines.join('\n')
  return SIGNATURES
}

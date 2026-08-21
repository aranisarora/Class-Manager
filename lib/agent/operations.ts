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
import { dialablePhone, formatINR } from '@/lib/format'
import { newId } from '@/lib/ids'
import type { Identity } from '@/lib/types'
import { DateTime } from 'luxon'
import { z } from 'zod'
import { rowShapedFact } from './memory'
import type { PlanStep } from './plan'
import { isIdSubquery, jsonLit, lit, moneyLit, uid, UUID_RE } from './sql'
import { buildSetupSteps, summariseSetup } from '@/lib/setup-plan'

// Re-exported so the many call sites that already import these from here keep
// working; they are DEFINED in ./sql now, which is what breaks the cycle.
export { isIdSubquery, jsonLit, lit, moneyLit, uid }

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
 *
 * @mechanism resolvePlayerPerson — the single answer to "is this human already here?"
 *   for every write path that mints a player, matched against the names this contact
 *   already holds rather than by an exact `=`. Retires the class where one human becomes
 *   two `person` rows behind one phone — one holding the money, one holding the
 *   attendance — which is what an unconditional insert did to every self-paying adult.
 *   Deliberately conservative: it reuses only on a whole-name match, so a child booked
 *   from a parent's phone stays a new person.
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
 *
 * @mechanism rosterOf — the one place any operation reads a class roster, taken as the
 *   service role rather than as the caller, because `account_cm_user_select` has no
 *   coach clause and every row therefore vanished for the person the register exists
 *   for. Retires the class where an RLS-emptied read makes a write silently do nothing
 *   and still report success: no roster, no attendance, no §6.4 billing line, and a
 *   coach told it went fine. Reachability is established upstream by `sessionOf` or
 *   `assertIdsExist`, so reading it as the runtime widens nothing.
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

/**
 * What the register already says about one player on one session.
 *
 * `rosterOf` above cannot answer this and should not be made to: it is keyed by class
 * and date, and the attendance row is keyed by session. So the operations that need to
 * know what they are about to overwrite ask here, through the view that already owns
 * the join — `app.session_roster` left-joins `attendance` and exposes
 * `attendance_status`, and its own comment says it exists because the join "kept
 * getting guessed wrong". A parent may read their own child's row
 * (0028's `attendance_cm_user_select`), so this is not a service-only question; it goes
 * through `svc` only for the same reason the rest of this operation does.
 *
 * Written because `client_cancel` had no way to see its own earlier effect. It asked a
 * mother to cancel a session she had already cancelled, and the second answer was worse
 * than the first.
 */
async function attendanceOf(
  ctx: SessionCtx,
  sessionId: string,
  playerId: string,
): Promise<{ status: string | null; markedAt: string | null }> {
  const rows = await q<{ attendance_status: string | null; marked_at: string | null }>(
    svc(ctx),
    `select attendance_status, marked_at
       from app.session_roster
      where session_id = ${uid(sessionId)} and player_id = ${uid(playerId)}`,
  )
  return { status: rows[0]?.attendance_status ?? null, markedAt: rows[0]?.marked_at ?? null }
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
  | 'cancel_session'
  | 'move_class'
  | 'reschedule_session'
  | 'book_trial'
  | 'mark_attendance'
  | 'confirm_coach'
  | 'onboard_coach'
  | 'decline_coach'
  | 'claim_cover'
  | 'client_cancel'
  | 'convert_trial'
  | 'opt_out'
  | 'send_invite_draft'
  | 'undo'
  | 'remember'
  | 'forget'
  | 'drop_watch'
  | 'set_up_business'
  | 'link_contact'

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

/**
 * A phone number somebody actually gave us.
 *
 * This was `z.string().min(6)` on both `add_coach` and `add_family` — a length, not a
 * phone rule. `min(6)` is satisfied by `+910000000001`, which is what the model wrote
 * into a staged plan for two coaches whose numbers had never been mentioned; the plan
 * reached a button and one tap would have created two contacts the product then tries to
 * invite. The number was required, the model did not have it, and nothing said no.
 *
 * The refusal message is the useful half: it tells the model to ask rather than invent,
 * because a tool error that only says "invalid" gets answered with another guess.
 */
const phoneE164 = z.string().refine(
  (v) => dialablePhone(v).ok,
  (v) => {
    const r = dialablePhone(v)
    return {
      message:
        `"${v}" is not a number anyone can be reached on`
        + (r.ok ? '' : ` — ${r.why}`)
        + '. Do not invent one or use a placeholder: if you have not been given the number, '
        + 'ask for it, or ask them to share the contact card.',
    }
  },
)

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
    /**
     * **Read off the rows, never recomputed from today's rate.**
     *
     * This used to count every session in the coach's history and multiply by
     * `coach.pay_amount` as it stands right now. That is one mutable number
     * deciding what somebody earned across months it was never in force for — so
     * a coach who had a raise in September left with their whole career repriced
     * at the September number, in the one message the comment above calls
     * unrecoverable.
     *
     * `coach_ledger` (0038) is the record: every closed month, with the rate that
     * applied frozen into the row. The month in progress has not been closed yet
     * and is the only part still derived — from `coach_pay`, which owns `worked`
     * and the per-unit arithmetic, rather than from a second hand-written copy.
     */
    const [settled] = await q<{ total: string; months: string }>(
      ctx,
      `select coalesce(sum(amount), 0)::text as total, count(distinct period)::text as months
         from coach_ledger
        where coach_id = ${uid(args.coach_id)} and academy_id = ${uid(ctx.academyId)}`,
    )
    const settledTotal = num(settled?.total)
    const settledMonths = num(settled?.months)

    // The open month. A per_month coach earns it whole — the same rule the tally
    // states for a family joining mid-period, and for the same reason: pro-rating
    // is a decision a person makes, and an adjustment line is how they make it.
    let openTotal = 0
    if (coach.pay_amount !== null) {
      if (coach.pay_unit === 'per_month') {
        openTotal = num(coach.pay_amount)
      } else {
        const [open] = await q<{ total: string }>(
          ctx,
          `select coalesce(sum(amount_for_session), 0)::text as total
             from coach_pay
            where coach_id = ${uid(args.coach_id)} and academy_id = ${uid(ctx.academyId)}
              and worked
              and (starts_at at time zone ${lit(a.timezone)})::date
                  >= date_trunc('month', (app.now() at time zone ${lit(a.timezone)}))::date`,
        )
        openTotal = num(open?.total)
      }
    }

    const total = settledTotal + openTotal
    let payLine: string
    if (coach.pay_amount === null) {
      payLine = "Your pay isn't tracked here, so there's no total to show."
    } else if (total === 0) {
      payLine = 'Nothing has been recorded against your pay yet, so there is no total to show.'
    } else {
      const settledPart = settledMonths
        ? `${formatINR(settledTotal)} across ${settledMonths} settled month${settledMonths === 1 ? '' : 's'}`
        : null
      const openPart = openTotal > 0 ? `${formatINR(openTotal)} this month` : null
      payLine = `${formatINR(total)} in all — ${[settledPart, openPart].filter(Boolean).join(', and ')}.`
    }

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
              // No "I'll tell you who's taking it as soon as it's set" — nothing
              // keeps that promise. Cover lands as an assignment, and the parents'
              // ordinary messages carry on; a promise the machinery does not keep
              // is a lie with a delay on it.
              `${[...t.classes].join(' and ')} carries on as usual.`,
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
  holder_person_id: string
  holder_name: string
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
            pl.account_id, ac.holder_person_id, hp.full_name as holder_name,
            e.class_id, c.name as class_name,
            (select count(*) from session s
              where s.class_id = e.class_id and s.status = 'scheduled'
                and (s.starts_at at time zone ${lit(tz)})::date > date ${lit(endIso)}) as upcoming
       from enrollment e
       join player pl on pl.id = e.player_id
       join person pe on pe.id = pl.person_id
       join account ac on ac.id = pl.account_id
       join person hp on hp.id = ac.holder_person_id
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
    const today = zoned(await now(ctx.academyId), a.timezone)
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
 *
 * @mechanism cancelJobsForSession — sweeps a session's pending ladder by dedupe-key
 *   prefix as plan steps in the caller's own transaction, scoped to `all` or
 *   `pre-session`. Retires the class where the queue and the world disagree: reminders
 *   and coach nudges still firing for a session that was moved or called off, a
 *   rolled-back plan that has nonetheless cancelled jobs, and — through the scope — an
 *   `all` sweep in `mark_attendance` cancelling the outcome jobs that same plan just
 *   created.
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
    const today = zoned(await now(ctx.academyId), a.timezone)
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
    const today = zoned(await now(ctx.academyId), a.timezone)
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

const bookTrial: OperationDef = {
  name: 'book_trial',
  ownScope: true,
  description:
    'Book a free trial from a cold conversation: creates the account, the player, a trial enrollment and the booking, confirms to the parent and tells the admin with an undo. ' +
    "The class's next scheduled session is resolved for you (or pass session_id) — never read the session table first to check: a prospect's own view of the calendar is empty by design, and that empty read is not the truth.",
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
    const today = zoned(await now(ctx.academyId), a.timezone)
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

    // `svc`, like the contact lookup above, and for the same reason: the caller
    // is a PROSPECT, and a prospect's own view of `session` is empty by design
    // (`app.my_session_ids()` — no enrolled players yet). Under `ctx` this read
    // returned nothing for every class, so the one operation §10.1 built for
    // cold conversations could not find the session it exists to book into —
    // driven, month drive day 6: a trial request answered with "give me a
    // second" and a watch that then found the same empty calendar and went
    // quiet. The operation is the privilege boundary; this read is its own.
    const [firstSession] = args.session_id
      ? await q<{ id: string; starts_at: string }>(
          svc(ctx),
          `select id, starts_at from session
            where id = ${uid(args.session_id)} and academy_id = ${uid(ctx.academyId)}`,
        )
      : await q<{ id: string; starts_at: string }>(
          svc(ctx),
          `select id, starts_at from session
            where class_id = ${uid(args.class_id)} and academy_id = ${uid(ctx.academyId)}
              and status = 'scheduled' and starts_at > app.now()
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
 * convert_trial — the decision a trial cannot make for itself.
 *
 * A trial is free and unbilled until somebody converts it on purpose (7fa4bcf),
 * and there was no operation that converted one — so the happiest moment in the
 * funnel ("she loved it, how do we continue?") was improvised as raw enrollment
 * writes every time. The month drive priced that in: the one conversion it
 * contains took 120 seconds, ₹1.06 and a recovery round, and the biggest design
 * finding of the drive (F-M — ₹1,600 of charges behind "free, nothing to pay")
 * happened on a model-composed conversion. A known-good plan makes the decision
 * explicit — the start date, the rate — and puts the read-back in front of
 * whoever approves it.
 * =========================================================================== */

const convertTrial: OperationDef = {
  name: 'convert_trial',
  description:
    'A trial continues as a regular enrollment. Nothing converts by itself — this is the decision, made explicit: sets when billing starts and at what rate (defaults to the class rate), and the family hears what they are signed up for. A partial first month is an adjustment the admin chooses separately, never automatic.',
  params: z.object({
    player_id: uuid.nullish(),
    enrollment_id: uuid.nullish(),
    /** When the regular enrollment (and so its billing period) starts. Defaults to today. */
    start_on: z.string().nullish(),
    rate_amount: z.number().nullish(),
    rate_unit: z.enum(['per_session', 'per_month', 'per_term', 'per_package']).nullish(),
    rate_count: z.number().int().positive().nullish(),
    notify: z.boolean().optional().default(true),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    if (!args.player_id && !args.enrollment_id) {
      throw new Error('convert_trial needs the player or the trial enrollment')
    }
    const [t] = await q<{
      enrollment_id: string
      player_id: string
      account_id: string
      class_id: string
      player_name: string
      class_name: string
      holder_person_id: string
      rate_amount: string | null
      rate_unit: string | null
      class_rate: string | null
      class_unit: string | null
      started_on: string
    }>(
      svc(ctx),
      `select e.id as enrollment_id, e.player_id, pl.account_id, e.class_id, e.started_on::text,
              per.full_name as player_name, c.name as class_name,
              ac.holder_person_id, e.rate_amount, e.rate_unit, c.rate_amount as class_rate, c.rate_unit as class_unit
         from enrollment e
         join class c on c.id = e.class_id
         join player pl on pl.id = e.player_id
         join person per on per.id = pl.person_id
         join account ac on ac.id = pl.account_id
        where e.academy_id = ${uid(ctx.academyId)} and e.is_trial and e.ended_on is null
          and (${args.enrollment_id ? `e.id = ${uid(args.enrollment_id)}` : 'true'})
          and (${args.player_id ? `e.player_id = ${uid(args.player_id)}` : 'true'})
        order by e.started_on desc, e.created_at desc
        limit 1`,
    )
    if (!t) throw new Error('there is no live trial for them — nothing to convert')

    const today = zoned(await now(ctx.academyId), a.timezone).toFormat('yyyy-MM-dd')
    const startOn = args.start_on ? isoDate(args.start_on, a.timezone) : today
    const amount = args.rate_amount ?? (num(t.rate_amount) || num(t.class_rate))
    const unit = args.rate_unit ?? t.rate_unit ?? t.class_unit ?? 'per_month'
    const rateLabel = amount ? `${formatINR(num(amount))} ${String(unit).replace('_', ' ')}` : 'the class rate'
    const startPeriod = periodOf(startOn, a.timezone)
    const currentPeriod = periodOf(today, a.timezone)

    /**
     * `started_on` anchors two different things — roster membership and the
     * billing gate — and the conversion must not trade one for the other.
     * A future start date written into `started_on` would silently drop a
     * child who keeps attending off every roster, reminder and register until
     * it arrives (review find), so the column only ever moves BACKWARD or to
     * today; a future billing start is expressed by which periods get a line,
     * below, not by hiding the child from the schedule.
     */
    const newStartedOn = startOn <= today ? startOn : t.started_on

    const steps: PlanStep[] = [
      {
        note: `${t.player_name} continues in ${t.class_name} — ${rateLabel}, billed from ${monthLabel(startPeriod, a.timezone)}`,
      },
      {
        write: `update enrollment
                   set is_trial = false,
                       started_on = date ${lit(newStartedOn)}
                       ${args.rate_amount !== null && args.rate_amount !== undefined ? `, rate_amount = ${moneyLit(args.rate_amount)}` : ''}
                       ${args.rate_unit ? `, rate_unit = ${lit(args.rate_unit)}` : ''}
                       ${args.rate_count ? `, rate_count = ${lit(args.rate_count)}` : ''}
                 where id = ${uid(t.enrollment_id)} and is_trial and ended_on is null`,
        requireRows: 1,
      },
    ]

    /**
     * The conversion month has to bill HERE or it never bills at all: the
     * `monthly_lines` job for (enrollment, current period) already ran on the
     * boundary and skipped — "a trial is free" — and job dedupe keys are
     * permanent, so nothing re-raises the period (review find; the receipt
     * would say "billed from September" over a September nothing mints).
     * Same dedupe key and description the billing job writes, so whichever
     * runs second is a no-op, and only per_month is minted here — future
     * periods (and term/package strides) get fresh job keys at the next
     * boundary and bill through the standing machinery. A billing start in a
     * FUTURE month stages nothing now, deliberately: the current period's
     * skipped job IS the free run-up, and the child stays on the roster.
     */
    if (startPeriod <= currentPeriod && unit === 'per_month' && num(amount) > 0) {
      const description = `${t.class_name} — ${monthLabel(currentPeriod, a.timezone)} ${zoned(currentPeriod, a.timezone).toFormat('yyyy')}`
      steps.push({
        write: `insert into tally_line (academy_id, account_id, player_id, class_id, period,
                                        kind, description, amount, dedupe_key)
                values (${uid(ctx.academyId)}, ${uid(t.account_id)}, ${uid(t.player_id)}, ${uid(t.class_id)},
                        date ${lit(currentPeriod)}, 'monthly', ${lit(description)}, ${moneyLit(num(amount))},
                        ${lit(billingKey.monthly(t.player_id, t.class_id, currentPeriod))})
                on conflict (academy_id, dedupe_key) where dedupe_key is not null
                do nothing`,
        service: true,
        // Zero rows is the boundary job having minted first — the dedupe doing
        // its job, not a step that failed to land.
        requireRows: 0,
      })
    }

    if (args.notify) {
      steps.push({
        message: {
          to_person_id: t.holder_person_id,
          body:
            `${a.name}: ${t.player_name} is confirmed in ${t.class_name} — ${rateLabel}, from ${monthLabel(startPeriod, a.timezone)}. ` +
            'The trial itself stays free.',
          buttons: [{ title: 'See the schedule', action: { kind: 'reply', text: `When is ${t.player_name}'s next class?` } }],
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

/**
 * @mechanism mark_attendance — refuses to open the register on a session that has not
 *   started yet, compared against the domain clock. Marking is not a small write: it
 *   completes the session, cancels that session's pre-session ladder and generates an
 *   outcome message to every family, so one missing comparison recorded a class as
 *   taken twelve hours before it ran, with the reminders swept and the parents already
 *   told. Retires the whole downstream class rather than any one of its symptoms, and
 *   the refusal names the moment it becomes markable because a bare "no" costs a round.
 */
const markAttendance: OperationDef = {
  name: 'mark_attendance',
  ownScope: true,
  description:
    "Mark the register for a session. Writes the billing line §6.4 requires, and asks about absences nobody told us about so one tap makes them timely. An entry's note is what the family reads in the outcome message — a coach's comment on how a player did (\"picked it up fast, good footwork\") belongs there, where the parent sees it, not in memory.",
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
    const today = zoned(await now(ctx.academyId), a.timezone)
    const s = await sessionOf(ctx, args.session_id)

    /**
     * **A register is a record of something that happened.**
     *
     * There was no precondition that the session had started, and marking one is
     * not a small write — it flips `session.status` to `completed`, cancels that
     * session's whole pre-session job ladder, and tells every family how their
     * child did. Driven, on a coach's first hand-driven day: he marked "everyone
     * turned up tonight" at **04:56**, about a class that starts at **18:30 the
     * same evening**. The session completed, the reminder and coach-confirmation
     * ladder for it was cancelled, six *"X was at 6:30 Beginners Batch today"*
     * messages were generated for parents — only a frequency cap stopped them
     * reaching anyone — and the schedule read-out then told him "Nothing today,
     * your next one is Sunday" about a class he was teaching in twelve hours.
     *
     * Every one of those is downstream of one missing comparison. R1: composed
     * and accepted at a moment when it could still have been questioned, and paid
     * for later in a job and on six parents' screens where nobody can recover it.
     *
     * The bar is `starts_at`, not "the session has ended". A coach marking the
     * register as the class begins is the normal case and the product should not
     * argue with it; a coach marking one before it exists is answering about a
     * thing that has not occurred. The refusal says when it becomes markable,
     * because a bare "no" costs a round.
     */
    if (new Date(s.starts_at).getTime() > (await now(ctx.academyId)).getTime()) {
      throw new Error(
        `that session hasn't started yet — it begins ${dayLabel(s.starts_at, a.timezone, today)} at ` +
        `${zoned(s.starts_at, a.timezone).toFormat('h:mma').toLowerCase()}. ` +
        `Mark the register from then. If somebody has told you they can't make it, that is a cancellation, not a register.`,
      )
    }

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
          run_at: (await now(ctx.academyId)).toISOString(),
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

    /**
     * The same hole as the one above, pointed the other way — and it was quieter.
     *
     * `unexplained` deliberately excludes a player already recorded as a timely
     * cancellation, which is right for the question it asks ("nothing on record — did
     * anyone tell you?"). But the exclusion also meant that marking such a player
     * absent — which this operation's own upsert happily does, and which puts the
     * charge back on — was the ONE case nobody was asked about. A parent cancels in
     * good time, the coach taps through the register, and a free cancellation silently
     * becomes a billed no-show.
     *
     * The coach is allowed to do it: a child who actually turned up is a real
     * correction, and the register is where corrections belong. What was missing is
     * that they were never told what they had just undone. So this surfaces exactly
     * the case the filter above removes, and offers the one-tap way back through
     * `retro_timely_player_ids`, which already exists for the other direction.
     *
     * The family-initiated path is guarded rather than surfaced — see `client_cancel`.
     * A tap there runs with no model in the room, and a parent cancelling cannot be a
     * correction to their own earlier cancellation.
     */
    const overrode = entries.filter(
      (e) => e.status !== 'cancelled_timely' && existingStatus.get(e.player_id) === 'cancelled_timely',
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

    if (overrode.length && markerContact) {
      const names = overrode.map((e) => byPlayer.get(e.player_id)?.player_name ?? 'someone')
      const plural = names.length > 1
      steps.push({
        message: {
          to_contact_id: markerContact,
          body:
            `One thing worth knowing — ${names.join(', ')} ${plural ? 'were' : 'was'} already down as ` +
            `cancelled in good time, with no charge. Marking the register has put the charge back on. ` +
            `If that's not right, I'll undo it.`,
          buttons: [
            ...overrode.slice(0, 2).map((e) => ({
              title: `${(byPlayer.get(e.player_id)?.player_name ?? 'They').split(' ')[0]} did tell us`.slice(0, 20),
              action: {
                kind: 'operation' as const,
                op: 'mark_attendance' as const,
                args: { session_id: s.id, retro_timely_player_ids: [e.player_id] },
              },
            })),
            { title: 'No, leave it', action: { kind: 'noop' as const, ack: 'Left as marked. Thanks.' } },
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
    const today = zoned(await now(ctx.academyId), a.timezone)
    const coachId = args.coach_id ?? id.coachId
    if (!coachId) throw new Error('I do not know which coach that is')
    const s = await sessionOf(ctx, args.session_id)
    const coaches = await coachesOnSession(ctx, s.id)
    // Computed before the confirmation branch so both copies can say what is
    // true. "I'll sort out cover" was the old sentence, and in a one-coach
    // business it promised a person who does not exist — what this operation
    // actually does on an uncovered decline is tell the owner and offer the
    // session to the other coaches, so that is what the copy says.
    const remaining = coaches.filter((c) => c.coach_id !== coachId && !c.declined_at)
    const stillCovered = isCovered(remaining)
    // The owner who would be told, minus the person declining: an escalation
    // about a person never reaches that person (§18 rule 2 — the send path
    // suppresses it as escalation_about_self), so where the declining coach IS
    // the only admin, "the owner's been told" was a sentence with nothing
    // behind it (F-P's one open edge on this operation). The copy and the
    // staging both read this, so neither promises a person who does not exist.
    const otherAdmins = (await adminPersonIds(ctx)).filter((pid) => pid !== id.person?.id)

    // §8.2 — the tap confirms first. Dropping a class is not mis-tappable, and
    // that guarantee belongs in the operation rather than in whoever raised
    // the prompt, so it holds however this is reached.
    if (!args.confirmed) {
      return [
        {
          message: {
            to_person_id: id.person.id,
            // The flag is what arms ToolCtx.confirmationAskedTo (db7f1b6): without
            // it the runtime does not know a confirmation is on this person's
            // screen, and the model's own re-worded second confirmation goes out
            // beside this one — driven in the F-O suite, two "Just to be sure"
            // messages a minute apart, the second with its yes-button refused.
            is_confirmation_request: true,
            // The protocol names its own question rather than letting `send` derive
            // one — `decline_coach` is what SCHEMA_DOC documents this column to hold,
            // and the session plus the coach is the subject a second ask should
            // supersede on. Derived, the kind would be a null catalog id and the
            // subject the bare contact.
            confirmation: { kind: 'decline_coach', subject: `${s.id}+${coachId}` },
            body: `Just to be sure — you can't make ${s.class_name} ${whenLabel(s.starts_at, a.timezone, today)}?${
              stillCovered
                ? ''
                : otherAdmins.length
                  ? ' The owner will be told it needs cover.'
                  : remaining.length
                    // Coaches remain ASSIGNED, just unconfirmed — and this very
                    // plan offers them the session, so say that, not "nobody
                    // else is on it" (review find: stillCovered demands a
                    // confirmation, not an assignment).
                    ? ' The other coaches will be asked to cover.'
                    : ' Nobody else is on it — moving or cancelling it would be the next step.'
            }`,
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
    const when = whenLabel(s.starts_at, a.timezone, today)

    const steps: PlanStep[] = [
      {
        note: `${s.class_name} ${when} loses one coach${stillCovered ? ', still covered' : ', now uncovered'}`,
        // Said to the coach who just declined. What happens to the session's coverage
        // is the admin's question, not theirs.
        personal: `you're off ${s.class_name} ${when}${
          stillCovered
            ? ' — it is still covered'
            : otherAdmins.length
              ? " — the owner's been told it needs cover"
              : remaining.length
                ? " — the others have been asked to cover"
                : ' — nobody else is on it, so moving or cancelling it is the next step'
        }`,
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
      // admin is told plainly and offered that. `otherAdmins` already excludes
      // the decliner — staging a message the send path is guaranteed to
      // suppress would also inflate the preview's "N people hear about it".
      for (const adminPerson of otherAdmins) {
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
    const today = zoned(await now(ctx.academyId), a.timezone)
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
    "A family cancels a session. Call it directly — it puts its own confirmation question, with working buttons, on their screen; never compose your own confirmation for it. Then it writes cancelled_timely inside the window or absent outside it, and tells the coach the headcount changed.",
  params: z.object({
    session_id: uuid,
    player_id: uuid,
    confirmed: z.boolean().optional().default(false),
    scope: z.enum(['session', 'series']).optional().default('session'),
    reason: z.string().nullish(),
    /**
     * RUNTIME-STAMPED, and in `HUMAN_ASSERTION_PARAMS` so a model-authored call can
     * never set them — the answer would then be whatever the model decided the money
     * should be. The confirmation below mints them; the tap replays them.
     *
     * They exist because the decision used to be recomputed at TAP time, against a
     * later clock and against whatever the window says now. A mother cancelled 57.5h
     * before a session — comfortably free, and she was told so — and the product then
     * took a day to ask her the same question again. Her second tap landed 21.7h out,
     * so the operation rebuilt itself, decided "late", and wrote `absent` over the
     * `cancelled_timely` her first tap had earned, with a charge behind it
     * (`.probe/archive/runs/2026-08-17-18-07-live`, turns 15 and 30).
     *
     * She did cancel in good time. That is a fact about HER, and it stopped being true
     * only because the product was slow. §2.2 already says everything a tap can run is
     * validated when minted; a button whose meaning changes between minting and tapping
     * is precisely the failure that rule exists to prevent.
     *
     * @mechanism decided_timely — the timeliness verdict, and the window it was judged
     *   against, are stamped into the button as the question is minted, and the tap
     *   replays them rather than recomputing. Retires the class where a button's meaning
     *   drifts between being read and being tapped: the same cancellation was free when
     *   she was told so and late a day later, so `absent` was written over her
     *   `cancelled_timely` with a charge behind it. `decided_window_hours` carries the
     *   other half, so an owner widening or narrowing the window cannot rewrite
     *   questions already sitting on people's phones.
     */
    decided_timely: z.boolean().nullish(),
    decided_window_hours: z.number().nullish(),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const nowD = await now(ctx.academyId)
    const today = zoned(nowD, a.timezone)
    const s = await sessionOf(ctx, args.session_id)
    const roster = await rosterOf(ctx, s.class_id, isoDate(s.starts_at, a.timezone))
    const r = roster.find((x) => x.player_id === args.player_id)
    if (!r) throw new Error('that player is not on this session')
    const when = whenLabel(s.starts_at, a.timezone, today)

    // The window as it stood when the question was asked, not as it stands now. The
    // owner may widen or narrow it at any time, and every un-tapped button on every
    // phone would otherwise change meaning underneath the people holding them —
    // including the sentence they already read, which names the hours.
    const windowHours = args.decided_window_hours ?? a.cancellation_window_hours
    const hoursOut = (new Date(s.starts_at).getTime() - nowD.getTime()) / 3_600_000
    const inWindow = args.decided_timely ?? hoursOut >= windowHours
    const perSession = r.rate_unit === 'per_session'

    /**
     * Look at the register before asking about it.
     *
     * This operation used to be structurally blind to its own earlier effect:
     * `rosterOf` returns the player, the account, the rate and the holder, and nothing
     * about attendance, so nothing anywhere could say "this is already done". A mother
     * cancelled a Thursday class on the Monday and tapped Yes. On the Tuesday she wrote
     * "cancel tomorrow too" — and tomorrow WAS that Thursday. Nothing contradicted the
     * reading that it had never happened, so the product asked again, she tapped again,
     * and by then the session was inside the notice window.
     *
     * Answering instead of re-asking is the whole fix for that turn. It also means the
     * model is told the truth in words it can act on, rather than composing a guess from
     * the only two relations it thought to read — one of which was the SESSION status,
     * which is about the whole class being called off and says nothing about one child.
     */
    const already = await attendanceOf(ctx, s.id, r.player_id)
    if (already.status === 'cancelled_timely') {
      return [
        {
          note: `${r.player_name} was already out of ${s.class_name} ${when}, with no charge`,
        },
        {
          message: {
            to_person_id: r.holder_person_id,
            body:
              `${r.player_name} is already out of ${s.class_name} ${when} — that went through` +
              `${already.markedAt ? ` on ${zoned(already.markedAt, a.timezone).toFormat('d LLL')}` : ''}` +
              `, and there's no charge for it. Nothing more to do.`,
          },
        },
      ]
    }

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
            // Arms ToolCtx.confirmationAskedTo — see decline_coach for the trace
            // this was missing from. One confirmation per action is enforced at
            // the runtime only when the runtime knows one was asked.
            is_confirmation_request: true,
            /**
             * Named, because `send` deriving it produced both halves wrong.
             *
             * The KIND fell back to `catalog_id`, so the row read `CL-CANCEL-CONFIRM`
             * while `SCHEMA_DOC` told the model this column holds `client_cancel`. The
             * model looked for exactly the documented value, got zero rows, and read
             * that as "no cancellation was ever asked about" — one of the three reads
             * behind the double-charge in `.probe/archive/runs/2026-08-17-18-07-live`.
             *
             * The SUBJECT fell back to the contact id, because this step sets no
             * `subject_person_ids`. That makes every cancellation this family ever asks
             * about share one key, so asking about a second child SUPERSEDES the open
             * question about the first — one open row per contact where the truth is one
             * per child per session.
             */
            confirmation: {
              kind: 'client_cancel',
              subject: `${s.id}+${r.player_id}`,
            },
            body:
              `Just to be sure — cancel ${r.player_name} for ${s.class_name} ${when}?` +
              (perSession
                ? inWindow
                  ? " That's inside the notice period, so there's no charge."
                  : ` That's less than ${windowHours}h notice, so the class is still charged.`
                : ''),
            buttons: [
              {
                title: 'Yes, cancel',
                ttl_minutes: 60,
                action: {
                  kind: 'operation',
                  op: 'client_cancel',
                  args: {
                    session_id: s.id,
                    player_id: r.player_id,
                    confirmed: true,
                    reason: args.reason ?? null,
                    // The decision travels WITH the button, so the tap writes the answer
                    // she was given rather than the one the clock has drifted to.
                    decided_timely: inWindow,
                    decided_window_hours: windowHours,
                  },
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
        /**
         * The backstop, and the rule is deliberately narrow.
         *
         * A FAMILY-initiated cancellation may never turn a recorded
         * `cancelled_timely` into a chargeable status. A coach marking the register
         * still may — a child who actually turned up is a real correction, and that
         * path is `mark_attendance`, not this one.
         *
         * It has to live at the write rather than only in the two guards above,
         * because a tap runs with no model in the room to notice anything and this
         * statement executes as the service role, so nothing else can stop it. The
         * unguarded version wrote `absent` over a two-days-early cancellation and
         * charged for it.
         */
        write: `insert into attendance (academy_id, session_id, player_id, status, note, marked_at)
                values (${uid(ctx.academyId)}, ${uid(s.id)}, ${uid(r.player_id)}, ${lit(status)},
                        ${lit(args.reason ?? 'cancelled by the family')}, app.now())
                on conflict (session_id, player_id) do update set
                  status = excluded.status, note = excluded.note, marked_at = excluded.marked_at
                where attendance.status is distinct from 'cancelled_timely'`,
        service: true,
        /**
         * **Because a blocked guard must not leave the receipt saying "Done".**
         *
         * A guarded upsert that refuses affects zero rows, and a zero-row write with
         * no `requireRows` is only recorded in `emptyWrites` — which is reported to
         * the MODEL. There is no model on the tap path. So without this the plan
         * would sail on and stage *"Done — she is out of Evening Batch"* about a
         * write that did not happen, which is the same false-receipt shape the
         * `synthDiffs` note above this line exists to kill.
         *
         * Aborting rolls the plan back and messages nobody, which is the honest
         * outcome. It is only reachable as a race: `attendanceOf` returns early when
         * the row already reads `cancelled_timely`, so by the time this runs the
         * guard is a backstop rather than the working path.
         */
        requireRows: 1,
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
                                    where t.session_id = ${uid(s.id)} and t.player_id = ${uid(r.player_id)})
                   -- And never charge for a session the register still records as a
                   -- timely cancellation. The guard above may have refused the status
                   -- change; without this the money would go on anyway, which is the
                   -- half of the defect that actually reached her account. Reads the
                   -- row as it stands AFTER the write above, in the same transaction.
                   and not exists (select 1 from attendance att
                                    where att.session_id = ${uid(s.id)}
                                      and att.player_id = ${uid(r.player_id)}
                                      and att.status = 'cancelled_timely')`,
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
              : ` It was inside ${windowHours}h so it's still on the tally.`
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

/**
 * The scopes somebody can actually ask for, and the words they ask in.
 *
 * "Please stop messaging me about money. I will pay when I pay." — the commonest
 * stop request in the record, and the product had one answer to it: stop
 * everything, or nothing. The model went looking for the middle, enumerated
 * `set_timing`'s keys, found none, fell back to a memory fact and said "Done" —
 * and a money message went out nine days later (F-AV). The always-rule *nobody
 * was messaged after they opted out* passed every later turn because the column
 * was never set.
 *
 * 0032 gives each scope a row the standing jobs read, so half a stop is a thing
 * that can actually be kept.
 *
 * @mechanism OPT_OUT_SCOPE — stopping is a scope rather than a switch: money,
 *   reminders, outcomes, announcements or all, each written as a `comm_preference` row
 *   the standing jobs read, with `opted_out_at` still meaning the whole channel.
 *   Retires the class where the only answers to "stop messaging me about money" were
 *   silence or nothing, so the middle got improvised as a memory fact that changed no
 *   behaviour — the column stayed unset, every later always-rule passed, and a money
 *   message went out nine days on.
 *   Closes F-AV.
 */
const OPT_OUT_SCOPE = z.enum(['all', 'money', 'reminders', 'outcomes', 'announcements'])

const SCOPE_WORDS: Record<string, { asks: string; keeps: string }> = {
  all: { asks: 'stop all', keeps: 'Reminders and tallies stop too.' },
  money: { asks: 'stop anything about money', keeps: 'Session reminders and news about their classes still come.' },
  reminders: { asks: 'stop the session reminders', keeps: 'Anything about money, and news if a class changes, still comes.' },
  outcomes: { asks: 'stop the after-class messages', keeps: 'Reminders and anything about money still come.' },
  announcements: { asks: 'stop the general announcements', keeps: 'Reminders, money and news about their own classes still come.' },
}

const optOut: OperationDef = {
  name: 'opt_out',
  description:
    'Stop messaging a number for this academy — all of it, or one KIND of it. Call it directly: it puts its own '
    + 'confirmation question, with working buttons, on their screen, and nothing changes until they tap it. Never '
    + 'compose your own confirmation for it. '
    + "**Somebody asking you to stop usually wants less, not silence** — \"stop messaging me about money\" is a scope, "
    + "so pass scope:'money' rather than stopping everything they hear. The scopes are all, money, reminders, "
    + 'outcomes and announcements, and each one is a row the standing jobs actually read, so it holds when nobody '
    + 'is in the conversation. `until` is a date for a pause rather than a stop. The admin is told when it takes effect.',
  destructive: true,
  params: z.object({
    contact_id: uuid.nullish(),
    scope: OPT_OUT_SCOPE.optional().default('all'),
    /** Their own words, kept so the next turn can say what was understood. */
    stated: z.string().max(300).nullish(),
    /** A pause rather than a stop. Local date. */
    until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
    confirmed: z.boolean().optional().default(false),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)
    const contactId = args.contact_id ?? (ctx.role === 'service' ? null : ctx.contactId)
    if (!contactId) throw new Error('I do not know which number that is')
    const scope = args.scope ?? 'all'
    const words = SCOPE_WORDS[scope] ?? SCOPE_WORDS.all
    const untilPhrase = args.until ? ` until ${args.until}` : ''

    if (!args.confirmed) {
      return [
        {
          message: {
            to_contact_id: contactId,
            body:
              `Just to be sure — ${words.asks} ${a.name} messages to this number${untilPhrase}? ` +
              words.keeps,
            is_confirmation_request: true,
            // The question, recorded the moment it reaches their screen (0032).
            // Subject is the scope, so asking again about money replaces the open
            // money question instead of leaving two.
            confirmation: { kind: 'opt_out', subject: scope },
            buttons: [
              {
                title: scope === 'all' ? 'Yes, stop them' : 'Yes, stop those',
                action: {
                  kind: 'operation',
                  op: 'opt_out',
                  args: { contact_id: contactId, scope, stated: args.stated ?? null, until: args.until ?? null, confirmed: true },
                },
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

    /**
     * A scope is a `comm_preference` row; the whole channel is still the column.
     *
     * They are different facts and the difference is load-bearing: `opted_out_at`
     * means nothing at all reaches this number, and the send path checks it
     * before anything else, ahead of even a `fixed` row. A scope is narrower and
     * is checked per category, so what they did NOT ask to stop keeps working —
     * which is the half that used to require them to accept silence to get.
     */
    const steps: PlanStep[] =
      scope === 'all'
        ? [
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
        : [
            {
              note: `${c?.full_name ?? 'that number'} stops hearing about ${scope}${untilPhrase}`,
              personal: `nothing about ${scope} from now on${untilPhrase}`,
            },
            {
              // Superseded rather than duplicated: one live preference per scope
              // per contact is the index in 0032, and re-stating a mute is the
              // commonest way it arrives.
              write:
                `update comm_preference set released_at = app.now()` +
                ` where contact_id = ${uid(contactId)} and scope = ${lit(scope)} and released_at is null`,
            },
            {
              write:
                `insert into comm_preference (academy_id, contact_id, person_id, scope, until, stated, set_by_person_id)` +
                ` values (app.academy_id(), ${uid(contactId)},` +
                ` (select person_id from contact where id = ${uid(contactId)}),` +
                ` ${lit(scope)}, ${args.until ? `date ${lit(args.until)}` : 'null'},` +
                ` ${args.stated ? lit(args.stated) : 'null'},` +
                ` ${ctx.role === 'user' ? uid(ctx.personId) : 'null'})`,
              service: true,
              requireRows: 1,
            },
            {
              message: {
                to_contact_id: contactId,
                fixed: true,
                body:
                  `Done — nothing about ${scope} from ${a.name}${untilPhrase}. ` +
                  `${words.keeps} Say the word and I'll put it back.`,
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
          body:
            scope === 'all'
              ? `${c?.full_name ?? 'Someone'} (${c?.phone_e164 ?? ''}) has stopped all messages. You may want to call.`
              : `${c?.full_name ?? 'Someone'} (${c?.phone_e164 ?? ''}) has asked for nothing about ${scope}${untilPhrase}. Everything else still reaches them.`,
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

// `TIMING_KEY` stood here, listing the settings keys `set_timing` would accept.
// The operation went with the other wrappers (it was one UPDATE on a jsonb
// column), and its two MUTE keys went further than that: 0032 made them
// `comm_preference` rows, because a mute the standing jobs cannot read is a
// promise nothing keeps. The lead-time keys are still what the scheduler reads —
// `TIMING_KEYS` in `lib/jobs/kinds.ts` is the one statement of them, and an
// override written under any other name is still a fact that changes no
// behaviour.

const onboardCoach: OperationDef = {
  name: 'onboard_coach',
  ownScope: true,
  description:
    "A coach confirms their classes are right, on their first run: `invited` → `active`, and they start getting their day. This is what their looks-right button does — the point of that message, not a note that they agreed.",
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
  /**
   * **This is the family invite as well as the coach one, and nothing said so.**
   *
   * The operation has always served §9.1 step 2 — it takes `person_id`, resolves
   * the name and mints the same `wa.me` deep link — but the declaration named
   * neither id and the description implied a coach. The catalog, meanwhile,
   * asserts the parent deep link twice as a trigger (CL-INTRO, CL-FIRST-CONTACT)
   * without naming the tool that mints it. So the model was told the mechanism
   * exists, given no way to reach it, and did the only thing left: it described
   * the link in prose. Driven, `st-solo-setup`: *"share an invite link with them
   * — a parent taps it, books a trial"*, and one message later its own reasoning
   * worked out that *"there isn't an explicit operation for family invites in the
   * tools besides send_invite_draft (coach)"* — a correct reading of what it had
   * been shown.
   *
   * The general lesson is PREFIX-RULES.md's trap in the mirror: that document warns to
   * look for capabilities the runtime built that the prompt never mentions, and
   * this one was hiding behind a tool the model could already see. A parameter
   * with no description is a capability with no advertisement.
   */
  description:
    'Draft the invite the ADMIN forwards from their own number, carrying a wa.me deep link with prefilled text. Works for a COACH or a FAMILY — it is the only invite in the product, and there is no other route a parent can be brought in by. The bot never sends it. The draft itself carries the [Sent it] button that records the forward — never compose your own.',
  params: z.object({
    coach_id: uuid
      .nullish()
      .describe('The coach being invited. Pass this OR person_id, never both.'),
    person_id: uuid
      .nullish()
      .describe(
        'For a FAMILY invite: the parent, by their person id. Same draft, same deep link — a parent who taps it opens the window from their side, which is what CL-INTRO fires on.',
      ),
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
    'Undo a previous operation. Reverses the database writes; anyone who was messaged gets a correction. Call it directly — it asks its own confirmation with working buttons before anything runs; never compose your own.',
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
            // Arms ToolCtx.confirmationAskedTo like every self-confirming op:
            // one confirmation per action holds only when the runtime knows one
            // was asked.
            is_confirmation_request: canReverse,
            // Only when there is actually a question: the un-reversible branch below
            // states a fact and offers no committing tap, so recording it as an
            // outstanding question would leave a row nothing can ever answer.
            // Subject is the audit entry, because that is what a second ask is about.
            ...(canReverse ? { confirmation: { kind: 'undo', subject: String(args.audit_id) } } : {}),
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


const remember: OperationDef = {
  name: 'remember',
  ownScope: true,
  description: 'Write a fact about this academy or this person. Facts are appended, never edited.',
  params: z.object({
    // 'business' is the product's own word for the academy — same alias the
    // primitive tool accepts, mapped below before anything is written.
    subject_kind: z.enum(['academy', 'business', 'person']),
    subject_id: uuid.nullish(),
    fact: z.string().min(1),
    supersedes: uuid.nullish(),
    source: z.string().nullish(),
  }),
  async build(ctx, args, id) {
    // The placement gate holds on EVERY writer of memory_fact. This operation is
    // shadowed by the primitive tool of the same name but stays reachable as a
    // plan step and behind a minted button, and its raw insert used to walk
    // straight past the gate (review find).
    const rowShaped = rowShapedFact(String(args.fact))
    if (rowShaped) throw new Error(`not stored: ${rowShaped}`)
    const subjectKind =
      args.subject_kind === 'business' || args.subject_id === ctx.academyId ? 'academy' : args.subject_kind
    const subjectId =
      subjectKind === 'academy' ? ctx.academyId : (args.subject_id ?? id.person.id)
    return [
      { note: `remembering: ${args.fact}` },
      {
        write: `insert into memory_fact (academy_id, subject_kind, subject_id, fact, source, supersedes)
                values (${uid(ctx.academyId)}, ${lit(subjectKind)}, ${uid(subjectId)}, ${lit(args.fact)},
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

/* =========================================================================== *
 * set_up_business — §7.1 step 1, as a conversation.
 *
 * This used to be a WhatsApp Flow: one screen, nine fields, one Save. The Flow is
 * gone (§14.6) and the ladder that replaced it needs somewhere to land, because
 * `lib/setup-plan.ts` exists to enforce "there must not be several ways to WRITE
 * the business" — and with the form removed, its only caller went with it. Left
 * alone, the model would have hand-written `update academy set …` steps, which is
 * exactly the several-ways-to-write this product has already been bitten by (the
 * register screen wrote `attendance` with its own SQL for most of the product's
 * life and produced no money for any of it).
 *
 * So the builder stays and gets a named operation in front of it. What changed is
 * only how the values arrive: nine at once off a form, or two now and three more
 * when they are mentioned. `buildSetupSteps` already distinguishes "they did not
 * say" (`undefined`, leave it) from "they said none" (`null`, clear it), which is
 * precisely the distinction a ladder needs and a form never had to make.
 * =========================================================================== */

const setUpBusiness: OperationDef = {
  name: 'set_up_business',
  description:
    'Write what you have learned about the business — any subset, as often as you like. Pass ONLY the fields they have actually told you: an omitted field is left exactly as it is, and null clears one (that is how "don\'t send me a morning brief" turns the brief off, and it is different from not asking). Safe to call again as more comes out, so write the two facts you have rather than holding them until you have nine.',
  params: z.object({
    name: z.string().min(1),
    category: z.string().nullish(),
    timezone: z.string().nullish(),
    cancellation_window_hours: z.number().int().min(0).max(720).nullish(),
    morning_brief_at: z.string().nullish(),
    evening_digest_at: z.string().nullish(),
    upi_handle: z.string().nullish(),
    venues: z
      .array(z.object({ name: z.string().min(1), address: z.string().nullish() }))
      .nullish(),
  }),
  async build(ctx, args, id) {
    if (!id.roles.includes('admin')) {
      throw new Error('the shape of the business is the owner’s to set — pass anything they told you on to the admin instead')
    }
    // ONE values object, built once and given to both.
    //
    // `summariseSetup` used to be handed `{ name }` — every other field dropped on
    // the way in — so the note it produced was a report on the absence of the eight
    // fields this very call was writing (F-CD). Two callers of one shape is the
    // whole guarantee that a plan's note describes the plan.
    const values = {
      name: String(args.name),
      category: args.category,
      timezone: args.timezone,
      cancellationWindowHours: args.cancellation_window_hours,
      morningBriefAt: args.morning_brief_at,
      eveningDigestAt: args.evening_digest_at,
      upiHandle: args.upi_handle,
      venues: args.venues ?? undefined,
    }
    return [{ note: summariseSetup(values) }, ...buildSetupSteps(ctx.academyId, values)]
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

/**
 * **What is left, and why exactly this.**
 *
 * ARCHITECTURE.md layer 2: *"Wrapper operations do not exist in this shape. An
 * operation that was a prewritten plan — CRUD plus notes — is gone, because
 * layers 0 and 1 hold its invariants and the prefix holds its knowledge."*
 *
 * Thirteen went: `end_enrollment`, `end_client`, `waive`, `record_payment`,
 * `request_payment`, `confirm_payment`, `set_timing`, `create_class`,
 * `close_class`, `add_coach`, `add_family`, `set_onboarding_state`,
 * `list_watches`. Every one of them was rows plus a sentence. The invariants they
 * carried did not go with them: dedupe lives on `tally_line.dedupe_key`, the
 * class name's uniqueness on an index, materialisation on a trigger (0033) so a
 * slot implies its sessions whatever wrote the slot, the double-booking check and
 * the affected-but-untold census inside the transaction, and the consequences —
 * what follows what, what a cancelled session owes back, how money moves in two
 * rows — in `SCHEMA_DOC`, where an author of SQL can actually read them.
 *
 * The evidence for going is the model's own behaviour: it already routed around
 * opaque operations and composed the rows itself, correctly, while this layer is
 * where the wrong explanations concentrated — the schema the declaration showed
 * disagreeing with the schema the write demanded (F-AG), a permission refusal
 * reported as a race (F-AX), solo activation depending on which tool was reached
 * for (F-AY), a button minted with a job kind that does not exist (F-AW), and an
 * ack that said "0 in, 0 out" over a register that wrote three rows. Two
 * documents describing one truth always drift; the shape keeps one.
 *
 * What stays is what has no SQL sentence:
 *
 *   THE TWO-TAP CONFIRMATIONS — `opt_out`, `confirm_coach`/`decline_coach`,
 *   `client_cancel`, `claim_cover`. Each puts a question on a person's screen
 *   where only THEIR tap may answer it, and no statement expresses that.
 *
 *   `undo` — reversing a committed plan from its captured diffs.
 *
 *   THE ELEVATION POINTS — `mark_attendance` (the billing line is the runtime's
 *   consequence, not the coach's write), `book_trial` (a stranger has no
 *   permission at all), `onboard_coach` (a coach who could set their own status
 *   could set their own pay), `send_invite_draft`, `remember`, `forget`,
 *   `drop_watch`, and the ending operations whose reassignment and credit-back
 *   run as the service role. Each is a permission grant wearing a function's
 *   clothes, and each stays only until its RLS question is answered properly in
 *   layer 0.
 */
/* =========================================================================== *
 * link_contact — a number for somebody who is already here
 * =========================================================================== */

/**
 * **Linking a number is not a small thing, and the schema is why.**
 *
 * There is no password anywhere in this product. A message arrives, the phone
 * resolves to a `contact`, the contact resolves to a `person`, and that person's
 * roles are what the sender may see and do. So a `contact` row IS the credential,
 * and "add this number to that person" is the same sentence as "give this phone
 * that person's login". `contact_cm_user_insert` requires `app.is_admin()` for
 * exactly that reason, and that stays true — this operation writes as the service
 * role only after an admin has tapped.
 *
 * What it exists for: a mother asking that her son hear about his own classes. He
 * is already a `person` — he is a player — and there was no way to reach him. The
 * two things the product could do instead were both wrong. Attaching his number to
 * HER person record would let his phone read her whole family, her balance, her
 * mutes. Making him the account holder would strip her of visibility of her own
 * children as the side effect of asking that reminders move.
 *
 * So this is a LINK and never a create. It joins a number to a person who is
 * already on the caller's own account, which means it cannot invent anybody and
 * cannot reach outside the family. That is also what keeps the duplicate-person
 * trap shut: without it the son messages in cold, `createProspect` makes a SECOND
 * person for him, and the business now has two of him — the same trap
 * `resolvePlayerPerson` exists to avoid in `book_trial`.
 *
 * The money boundary needs no work here and is worth saying out loud: he holds no
 * account, so `app.sees_money()` is false for him. He gets his classes and his
 * reminders and never a rupee of the family's money.
 */
const linkContact: OperationDef = {
  name: 'link_contact',
  ownScope: true,
  description:
    "Attach a WhatsApp number to a PLAYER who is already on the caller's own account — a teenager who should hear about their own classes rather than have them announced to a parent. Give the number with its country code. It links an existing person to a number and cannot create anybody, so it is not the way to add a new family member or a second parent: for those, the person has to exist first. The owner approves it — the operation routes the request and says so. Once linked they get their own class reminders and changes, they can message about their own sessions, and they never see the family's money.",
  params: z.object({
    player_id: uuid,
    phone: z.string().min(6).max(24),
    confirmed: z.boolean().optional().default(false),
  }),
  async build(ctx, args, id) {
    const a = await academyOf(ctx)

    // Digits and a country code, or nothing. A bare ten-digit number would have to
    // be given a country by guessing, and a guessed phone number is a message to a
    // stranger — so this refuses and says what is missing rather than inventing one.
    const phone = args.phone.replace(/[\s()\-.]/g, '')
    if (!/^\+\d{8,15}$/.test(phone)) {
      throw new Error(
        'that number needs its country code and nothing else — like +919876543210',
      )
    }

    /**
     * Read through the CALLER's own session, never `svc`. RLS then decides whether
     * this player is theirs, so the scope of the operation is the scope of the
     * person asking, by construction rather than by a predicate somebody remembered.
     * An admin sees every player and may link for anyone; a parent sees their own.
     */
    const [player] = await q<{ player_id: string; person_id: string; full_name: string; account_id: string }>(
      ctx,
      `select p.id as player_id, p.person_id, pe.full_name, p.account_id
         from player p join person pe on pe.id = p.person_id
        where p.id = ${uid(args.player_id)} and p.academy_id = ${uid(ctx.academyId)}`,
    )
    if (!player) throw new Error('that is not somebody on your account')

    /**
     * RLS alone is too wide HERE, and only here.
     *
     * `player_cm_user_select` deliberately lets a coach read every player on a
     * session they are assigned to — the roster is their job. So "the read
     * succeeded" would have meant a coach could ask for a phone number to be
     * attached to any student they teach. The owner still approves, so it is not a
     * breach; it is a claim this operation makes about itself being false, which is
     * the shape that turns into a wrong sentence one turn later.
     *
     * `my_player_ids()` is the narrower question and the right one: yourself, plus
     * everyone on an account you hold. A coach gets an empty array unless they are
     * also a parent here.
     */
    const [scope] = await q<{ allowed: boolean }>(
      ctx,
      `select (app.is_admin() or ${uid(args.player_id)} = any (app.my_player_ids())) as allowed`,
    )
    if (!scope?.allowed) {
      throw new Error('a number can only be added for somebody on your own account')
    }

    // A number already in this business belongs to whoever has it. Re-pointing it is
    // an identity change, not a link, and it is not what anybody is asking for.
    const [taken] = await q<{ person_id: string; full_name: string }>(
      svc(ctx),
      `select c.person_id, pe.full_name
         from contact c join person pe on pe.id = c.person_id
        where c.academy_id = ${uid(ctx.academyId)} and c.phone_e164 = ${lit(phone)}`,
    )
    if (taken && taken.person_id !== player.person_id) {
      throw new Error(`that number is already ${taken.full_name}'s here — I will not move it`)
    }
    if (taken) {
      return [{ note: `${player.full_name} already has ${phone} on file` }]
    }

    const adminIds = await adminPersonIds(ctx)

    if (!args.confirmed) {
      const asker = id.person?.full_name ?? 'someone on the account'
      const steps: PlanStep[] = [
        { note: `a request to reach ${player.full_name} on ${phone}` },
      ]
      for (const adminPerson of adminIds) {
        steps.push({
          message: {
            to_person_id: adminPerson,
            subject_person_ids: [player.person_id],
            is_confirmation_request: true,
            confirmation: { kind: 'link_contact', subject: `${player.player_id}+${phone}` },
            body:
              `${asker} has asked that ${player.full_name} be reachable on ${phone} — ` +
              `so ${player.full_name.split(' ')[0]} gets their own reminders. ` +
              `They would see their own sessions and nothing about money. Add it?`,
            buttons: [
              {
                title: 'Yes, add it',
                action: {
                  kind: 'operation',
                  op: 'link_contact',
                  args: { player_id: player.player_id, phone, confirmed: true },
                },
              },
              { title: 'No', action: { kind: 'noop', ack: 'Left as it is — nothing added.' } },
            ],
          },
        })
      }
      // Said plainly to the person who asked, because "I have asked the owner" is
      // true only once the owner has actually been sent it — and these steps are
      // what makes it true.
      // Addressed the way `undo` does it: a contact when there is a live seat, the
      // person when this is running as the runtime. Setting neither would stage a
      // message with no recipient.
      steps.push({
        message: {
          to_contact_id: ctx.role === 'service' ? undefined : ctx.contactId,
          to_person_id: ctx.role === 'service' ? id.person?.id : undefined,
          body: adminIds.length
            ? `I have put that to ${a.name} — adding a number is theirs to approve. I will tell you when it is done.`
            : `There is nobody set up to approve that here yet, so I cannot add a number. I have written down what you asked for.`,
        },
      })
      return steps
    }

    // The confirmed arm runs on the owner's tap, with no model in the room. The
    // belt to the button: a tap replays stored arguments, so the only thing that
    // makes this safe is checking WHO is tapping, here, at run time.
    if (!id.person || !adminIds.includes(id.person.id)) {
      throw new Error('only the owner can add a number to this business')
    }

    return [
      { note: `${player.full_name} can now be reached on ${phone}` },
      {
        /**
         * `is_primary` is computed rather than defaulted. The column defaults to
         * true, and every reader of "the number for this person" orders
         * `is_primary desc, created_at asc` — so a second number defaulting to
         * primary would quietly demote the one they already use. A person may hold
         * two numbers; only the first is theirs by default.
         */
        write: `insert into contact (academy_id, person_id, phone_e164, state, is_primary)
                select ${uid(ctx.academyId)}, ${uid(player.person_id)}, ${lit(phone)}, 'registered',
                       not exists (select 1 from contact x
                                    where x.academy_id = ${uid(ctx.academyId)}
                                      and x.person_id = ${uid(player.person_id)})
                on conflict (academy_id, phone_e164) do nothing`,
        service: true,
        requireRows: 1,
      },
      {
        message: {
          to_person_id: player.person_id,
          subject_person_ids: [player.person_id],
          body:
            `Hi ${player.full_name.split(' ')[0]} — ${a.name} will send your class reminders to this number from now on. ` +
            `Message me any time about your own sessions.`,
        },
      },
    ]
  },
}

export const OPERATIONS: Record<OperationName, OperationDef> = {
  end_coach: endCoach,
  cancel_session: cancelSession,
  move_class: moveClass,
  reschedule_session: rescheduleSession,
  book_trial: bookTrial,
  convert_trial: convertTrial,
  mark_attendance: markAttendance,
  confirm_coach: confirmCoach,
  onboard_coach: onboardCoach,
  decline_coach: declineCoach,
  claim_cover: claimCover,
  client_cancel: clientCancel,
  opt_out: optOut,
  send_invite_draft: sendInviteDraft,
  undo,
  remember,
  forget,
  drop_watch: dropWatch,
  set_up_business: setUpBusiness,
  link_contact: linkContact,
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

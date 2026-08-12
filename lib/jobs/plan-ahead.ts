/**
 * lib/jobs/plan-ahead.ts — the planner (§13).
 *
 * Given the current `app.now()`, enqueue every job the next 48 hours needs, for
 * every academy. Called on clock advance and on tick, so it has to be cheap and
 * it has to be idempotent: a handful of set-based queries per academy, and one
 * bulk `on conflict do nothing` insert. Re-planning the same 48 hours writes
 * nothing.
 *
 * Two deliberate choices:
 *
 *  - **Nothing message-shaped is planned before the academy is live** (§2.6).
 *    `materialize_sessions` and `memory_curate` still run — building the roster
 *    messages nobody.
 *  - **A moment that has already passed is not planned.** Enqueueing a T-60
 *    prompt for a class starting in twenty minutes would fire it and the T-30
 *    together, which is two messages saying the same thing. Jobs whose moment is
 *    "at or after" — the register, the outcome — are exempt, because a session
 *    that ended while nobody was looking still needs its register.
 */

import { DateTime } from 'luxon'
import type { Tx } from '@/lib/db'
import { now } from '@/lib/clock'
import { CURATE_THRESHOLD } from '@/lib/agent/memory'
import {
  dedupe, HORIZON_DAYS, PLAN_HORIZON_HOURS, type JobKind,
} from './kinds'
import { enqueueMany, type JobSpec } from './enqueue'
import {
  atTimeOn, isoDate, leadFor, loadAcademy, settingNumber, withAcademy, withInfra,
  zoned, type AcademyRow,
} from './util'

/** A job planned more than this far into the past is a moment we missed. */
const GRACE_MS = 2 * 60_000

type SessionRow = {
  id: string; class_id: string; class_name: string; starts_at: Date; ends_at: Date
}
type CoachRow = {
  session_id: string; coach_id: string; person_id: string; status: string
  ended_on: string | null; confirmed_at: Date | null; declined_at: Date | null
  arrived_at: Date | null; settings: Record<string, unknown> | null
}
type EnrolRow = {
  class_id: string; player_id: string; started_on: string; ended_on: string | null
  holder_settings: Record<string, unknown> | null
}

/**
 * Every academy the runtime can see. `job` is global and carries its academy in
 * the payload (§6.6), so the planner needs the tenant list up front; the second
 * pass exists because a `cm_service` session is pinned to one academy at a time
 * and the queue itself is the one global record of who exists.
 */
export async function listAcademyIds(): Promise<string[]> {
  const found = new Set<string>()

  try {
    const rows = await withInfra((tx) => tx<{ id: string }[]>`
      select id from academy order by created_at asc
    `)
    for (const r of rows) found.add(r.id)
  } catch {
    // The tenant list is not readable under this session's role. Fall through.
  }

  if (found.size === 0) {
    try {
      const rows = await withInfra((tx) => tx<{ academy_id: string }[]>`
        select distinct payload->>'academy_id' as academy_id
          from job
         where payload->>'academy_id' is not null
           and run_at > app.now() - interval '60 days'
      `)
      for (const r of rows) if (r.academy_id) found.add(r.academy_id)
    } catch {
      // Nothing on the queue either — there is genuinely nothing to plan.
    }
  }

  return [...found]
}

/** Plan the next 48 hours for every academy. Returns how many jobs were new. */
export async function planAhead(o?: { academyIds?: string[] }): Promise<number> {
  const ids = o?.academyIds?.length ? o.academyIds : await listAcademyIds()
  let written = 0
  for (const id of ids) written += await planAheadFor(id)
  return written
}

export async function planAheadFor(academyId: string): Promise<number> {
  const nowAt = await now()
  const specs = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) return []

    const tz = academy.timezone
    const today = isoDate(nowAt, tz)
    const out: JobSpec[] = []

    const push = (
      kind: JobKind, runAt: Date, dedupeKey: string,
      payload: Record<string, unknown>, allowPast = false,
    ) => {
      if (!allowPast && runAt.getTime() < nowAt.getTime() - GRACE_MS) return
      out.push({ kind, runAt, dedupeKey, payload: { academy_id: academyId, ...payload }, academyId })
    }

    // -- sessions exist first ---------------------------------------------------
    // Daily, per active class, rolling ~3-week horizon (§13).
    const classes = await tx<{ id: string }[]>`
      select id from class
       where academy_id = ${academyId} and active
         and (ends_on is null or ends_on >= ${today}::date)
         and starts_on <= ${today}::date + ${HORIZON_DAYS}::int
    `
    for (const c of classes) {
      push('materialize_sessions', nowAt, dedupe.materializeSessions(c.id, today), { class_id: c.id, date: today }, true)
    }

    // §5 — curate a subject's hot set once its fact store passes the threshold.
    const subjects = await tx<{ subject_kind: string; subject_id: string; n: number }[]>`
      select subject_kind, subject_id, count(*)::int as n
        from memory_fact
       where academy_id = ${academyId} and retired_at is null
       group by subject_kind, subject_id
      having count(*) >= ${CURATE_THRESHOLD}
    `
    for (const s of subjects) {
      const pass = Math.floor(s.n / CURATE_THRESHOLD)
      push('memory_curate', nowAt, dedupe.memoryCurate(s.subject_id, pass),
        { subject_kind: s.subject_kind, subject_id: s.subject_id, n: pass }, true)
    }

    // §2.6 — building the roster messages nobody. Everything below this line
    // talks to a human, so it waits for the admin to say go.
    if (academy.onboarding_state !== 'live') return out

    // -- the 48-hour window -----------------------------------------------------
    const sessions = await tx<SessionRow[]>`
      select s.id, s.class_id, cl.name as class_name, s.starts_at, s.ends_at
        from session s join class cl on cl.id = s.class_id
       where s.academy_id = ${academyId}
         and s.status = 'scheduled'
         and s.ends_at   >= app.now() - interval '6 hours'
         and s.starts_at <= app.now() + make_interval(hours => ${PLAN_HORIZON_HOURS}::int)
       order by s.starts_at asc
    `
    const sessionIds = sessions.map((s) => s.id)
    const classIds = [...new Set(sessions.map((s) => s.class_id))]

    const coachRows = sessionIds.length === 0 ? [] : await tx<CoachRow[]>`
      select sc.session_id, sc.coach_id, co.person_id, co.status,
             co.ended_on::text as ended_on,
             sc.confirmed_at, sc.declined_at, sc.arrived_at, pe.settings
        from session_coach sc
        join coach co on co.id = sc.coach_id
        join person pe on pe.id = co.person_id
       where sc.session_id = any (${sessionIds}::uuid[])
    `
    const enrolRows = classIds.length === 0 ? [] : await tx<EnrolRow[]>`
      select e.class_id, e.player_id, e.started_on::text as started_on,
             e.ended_on::text as ended_on, hp.settings as holder_settings
        from enrollment e
        join player pl on pl.id = e.player_id and pl.active
        join account a on a.id = pl.account_id
        join person hp on hp.id = a.holder_person_id
       where e.academy_id = ${academyId} and e.class_id = any (${classIds}::uuid[])
    `

    const coachesBySession = new Map<string, CoachRow[]>()
    for (const c of coachRows) {
      const list = coachesBySession.get(c.session_id) ?? []
      list.push(c)
      coachesBySession.set(c.session_id, list)
    }
    const enrolByClass = new Map<string, EnrolRow[]>()
    for (const e of enrolRows) {
      const list = enrolByClass.get(e.class_id) ?? []
      list.push(e)
      enrolByClass.set(e.class_id, list)
    }

    const escalateLead = leadFor('adminEscalateLeadMinutes', null, academy, null)
    const expiryHours = leadFor('registerExpiryHours', null, academy, null)

    for (const s of sessions) {
      const date = isoDate(s.starts_at, tz)
      const start = s.starts_at.getTime()

      for (const c of coachesBySession.get(s.id) ?? []) {
        if (c.declined_at) continue
        if (c.status === 'ended' || (c.ended_on && c.ended_on < date)) continue

        // §8.2 — one confirmation is enough. A coach who has answered is never
        // asked again, so the ladder is not even planned for them.
        if (!c.confirmed_at && !c.arrived_at) {
          const comingLead = leadFor('coachComingLeadMinutes', c.settings, academy, null)
          const nudgeLead = leadFor('coachNudgeLeadMinutes', c.settings, academy, null)
          push('coach_coming', new Date(start - comingLead * 60_000),
            dedupe.coachComing(s.id, c.coach_id), { session_id: s.id, coach_id: c.coach_id })
          push('coach_nudge', new Date(start - nudgeLead * 60_000),
            dedupe.coachNudge(s.id, c.coach_id), { session_id: s.id, coach_id: c.coach_id })
        }

        // §8.1 — invited, session inside 48h: the admin is told, not the coach,
        // who by definition is not listening.
        if (c.status === 'invited') {
          push('coach_not_onboarded', nowAt, dedupe.coachNotOnboarded(c.coach_id, today),
            { coach_id: c.coach_id, date: today }, true)
        }
      }

      // T-15: the admin, about the session, never about a person (§6.3, §8.2).
      push('admin_escalate_uncovered', new Date(start - escalateLead * 60_000),
        dedupe.adminEscalateUncovered(s.id), { session_id: s.id })

      // Only speaks if the session is actually in trouble (§9.2).
      push('client_session_trouble', s.starts_at, dedupe.clientSessionTrouble(s.id), { session_id: s.id })

      push('post_class_register', s.ends_at, dedupe.postClassRegister(s.id), { session_id: s.id }, true)
      push('register_expiry', new Date(s.ends_at.getTime() + expiryHours * 3600_000),
        dedupe.registerExpiry(s.id), { session_id: s.id }, true)

      for (const e of enrolByClass.get(s.class_id) ?? []) {
        if (e.started_on > date) continue
        if (e.ended_on && e.ended_on < date) continue
        // §8.2 again: one lead time for every family is a schedule; per-person
        // timings are a manager. The parent's own record wins.
        const leadHours = leadFor(
          'clientReminderLeadHours', e.holder_settings, academy, academy.client_reminder_lead_hours,
        )
        push('client_reminder', new Date(start - leadHours * 3600_000),
          dedupe.clientReminder(s.id, e.player_id), { session_id: s.id, player_id: e.player_id })
      }
    }

    // -- attendance that has been marked but not yet reported back (§12.1) ------
    const marked = await tx<{ session_id: string; player_id: string }[]>`
      select a.session_id, a.player_id
        from attendance a join session s on s.id = a.session_id
       where s.academy_id = ${academyId}
         and a.status <> 'cancelled_timely'
         and s.ends_at between app.now() - interval '48 hours' and app.now() + interval '1 hour'
    `
    for (const m of marked) {
      push('client_outcome', nowAt, dedupe.clientOutcome(m.session_id, m.player_id),
        { session_id: m.session_id, player_id: m.player_id }, true)
    }

    // -- the two bookends, today and tomorrow (§7.2, §10.2) ---------------------
    for (let d = 0; d <= Math.ceil(PLAN_HORIZON_HOURS / 24); d++) {
      const day = zoned(nowAt, tz).plus({ days: d }).toFormat('yyyy-MM-dd')
      push('admin_morning_brief', atTimeOn(day, academy.morning_brief_at, tz),
        dedupe.adminMorningBrief(academyId, day), { date: day })
      push('admin_evening_digest', atTimeOn(day, academy.evening_digest_at, tz),
        dedupe.adminEveningDigest(academyId, day), { date: day })
    }

    // -- the coach's day, for anyone who has one (§8.2 step 1) ------------------
    const dayCoaches = new Set<string>()
    for (const s of sessions) {
      const date = isoDate(s.starts_at, tz)
      for (const c of coachesBySession.get(s.id) ?? []) {
        if (c.declined_at || c.status !== 'active') continue
        if (c.ended_on && c.ended_on < date) continue
        dayCoaches.add(`${c.coach_id}|${date}`)
      }
    }
    for (const key of dayCoaches) {
      const [coachId, date] = key.split('|')
      const coachSettings = coachRows.find((c) => c.coach_id === coachId)?.settings ?? null
      const briefAt = settingNumber(coachSettings, 'coach_day_at_minutes')
      const runAt = briefAt === null
        ? atTimeOn(date, academy.morning_brief_at, tz)
        : DateTime.fromISO(`${date}T00:00:00`, { zone: tz }).plus({ minutes: briefAt }).toJSDate()
      push('coach_day', runAt, dedupe.coachDay(coachId, date), { coach_id: coachId, date })
    }

    // -- the month turning over (§6.4) ------------------------------------------
    await planMonthBoundary(tx, academy, nowAt, push)

    // -- rail 1 has no webhook, so somebody has to be asked (§11.5) --------------
    const unconfirmed = await tx<{ id: string }[]>`
      select id from payment
       where academy_id = ${academyId} and status = 'requested'
         and requested_at is not null
         and requested_at <= app.now() - interval '24 hours'
       limit 100
    `
    for (const p of unconfirmed) {
      push('reconcile', nowAt, dedupe.reconcile(p.id, 1), { payment_id: p.id, n: 1 }, true)
    }

    // -- §9.1 step 3: the non-clicker, contacted the first time there is a real
    //    reason — a session within 48h. Staged from here, ten at a time.
    const [pending] = await tx<{ n: number }[]>`
      select count(*)::int as n
        from contact ct
       where ct.academy_id = ${academyId}
         and ct.opted_out_at is null
         and ct.state = 'registered'
         and not exists (select 1 from message m where m.contact_id = ct.id and m.direction = 'outbound')
         and exists (
           select 1
             from account a
             join player pl on pl.account_id = a.id and pl.active
             join enrollment e on e.player_id = pl.id
              and (e.ended_on is null or e.ended_on >= (app.now() at time zone ${tz})::date)
             join session s on s.class_id = e.class_id and s.status = 'scheduled'
            where a.academy_id = ct.academy_id and a.holder_person_id = ct.person_id
              and s.starts_at between app.now() and app.now() + interval '48 hours'
         )
    `
    if ((pending?.n ?? 0) > 0) {
      push('first_contact_batch', nowAt, dedupe.firstContactBatch(academyId, 1), { batch_n: 1 }, true)
    }

    return out
  })

  return enqueueMany(specs)
}

type Push = (
  kind: JobKind, runAt: Date, dedupeKey: string,
  payload: Record<string, unknown>, allowPast?: boolean,
) => void

/**
 * The 1st writes the month's lines; the same morning reads the month just gone
 * back to every family that owes for it (§6.4, §12.1).
 */
async function planMonthBoundary(
  tx: Tx, academy: AcademyRow, nowAt: Date, push: Push,
): Promise<void> {
  const tz = academy.timezone
  const start = zoned(nowAt, tz).startOf('day')
  const days = Math.ceil(PLAN_HORIZON_HOURS / 24)

  for (let d = 0; d <= days; d++) {
    const day = start.plus({ days: d })
    if (day.day !== 1) continue

    const period = day.toFormat('yyyy-MM-dd')
    const periodEnd = day.endOf('month').toFormat('yyyy-MM-dd')
    const previous = day.minus({ months: 1 }).toFormat('yyyy-MM-dd')

    const enrollments = await tx<{ id: string }[]>`
      select e.id
        from enrollment e
        join class cl on cl.id = e.class_id
        join player pl on pl.id = e.player_id and pl.active
       where e.academy_id = ${academy.id}
         and cl.active
         and e.started_on <= ${periodEnd}::date
         and (e.ended_on is null or e.ended_on >= ${period}::date)
         and coalesce(e.rate_unit, cl.rate_unit) in ('per_month', 'per_term', 'per_package')
    `
    const linesAt = atTimeOn(period, '00:05:00', tz)
    for (const e of enrollments) {
      push('monthly_lines', linesAt, dedupe.monthlyLines(e.id, period), { enrollment_id: e.id, period }, true)
    }

    const accounts = await tx<{ account_id: string }[]>`
      select distinct account_id from tally_line
       where academy_id = ${academy.id} and period = ${previous}::date
    `
    const tallyAt = atTimeOn(period, '09:00:00', tz)
    for (const a of accounts) {
      push('month_end_tally', tallyAt, dedupe.monthEndTally(a.account_id, previous),
        { account_id: a.account_id, period: previous })
    }
  }
}

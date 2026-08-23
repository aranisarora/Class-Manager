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
 *
 * @mechanism allowPast — every `push` drops a moment already behind `nowAt` (past a small
 *   grace) unless the caller says the job's moment is "at or after": the register, the
 *   outcome, the month catch-ups. Without the gate a planner catching up enqueues a T-60
 *   prompt for a class starting in twenty minutes and fires it with the T-30, two messages
 *   saying the same thing; without the exemption, work whose moment has passed on purpose
 *   is never planned at all.
 *
 * @mechanism onboarding_state — the planner returns before every message-shaped job when
 *   an academy is not `live`, so the roster-building phase schedules `materialize_sessions`
 *   and `memory_curate` and nothing that talks to a human (§2.6). One line in the planner
 *   rather than a go-live check inside twenty handlers, each of which could forget it.
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
  admins, atTimeOn, deferPastQuietHours, isoDate, leadFor, loadAcademy, pullOutOfQuietHours,
  settingNumber, withAcademy, withInfra, zoned, type AcademyRow,
} from './util'

/** A job planned more than this far into the past is a moment we missed. */
const GRACE_MS = 2 * 60_000

/**
 * When a coach hears about their day, if neither they nor the owner has said.
 *
 * Only reached when the owner has turned their own morning brief off — the coach's
 * day used to inherit that time, and inheriting a null meant midnight.
 */
const DEFAULT_COACH_DAY_AT = '07:00:00'

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
    /**
     * `not is_front_desk` (0039). A front desk is the arrivals hall of a number, not a
     * business: it has no class, no session and no roster, so every job planned for it
     * is a no-op, and the two that are not — the morning brief and the evening digest —
     * are proactive sends to a stranger. The send path would suppress them (its
     * pre-launch gate refuses anything that is not a solicited reply from an academy
     * that is not `live`), but a standing surface that fires daily at something it can
     * never reach is exactly the "fire on the calendar restating stuck state" failure
     * Layer 4 exists to prevent, and it would grow one more of them per WhatsApp number.
     */
    const rows = await withInfra((tx) => tx<{ id: string }[]>`
      select id from academy where not is_front_desk order by created_at asc
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
  await sweepFrontDeskQuestions()
  return written
}

/**
 * @mechanism promoteRates — the daily pass 0043 promised and never had: the latest
 *   `rate_period` row whose day has arrived is written onto the live columns, per
 *   subject, only where they disagree — so "₹1,100 from 1 September" stops being a row
 *   the product wrote, confirmed, and never once read on the day it was for. The
 *   trigger's no-op suppression keeps every pass phantom-free, which is the property
 *   its own comment says it was built for.
 */
async function promoteRates(tx: Tx, academyId: string, today: string): Promise<void> {
  await tx`
    update enrollment e
       set rate_amount = rp.amount,
           rate_unit   = coalesce(rp.unit, e.rate_unit),
           rate_count  = coalesce(rp.rate_count, e.rate_count)
      from (select distinct on (p.enrollment_id) p.enrollment_id, p.amount, p.unit, p.rate_count
              from rate_period p
             where p.academy_id = ${academyId} and p.enrollment_id is not null
               and p.effective_from <= ${today}::date
             order by p.enrollment_id, p.effective_from desc) rp
     where e.id = rp.enrollment_id and e.academy_id = ${academyId}
       and (e.rate_amount is distinct from rp.amount
         or (rp.unit is not null and e.rate_unit is distinct from rp.unit)
         or (rp.rate_count is not null and e.rate_count is distinct from rp.rate_count))`
  await tx`
    update class c
       set rate_amount = rp.amount,
           rate_unit   = coalesce(rp.unit, c.rate_unit),
           rate_count  = coalesce(rp.rate_count, c.rate_count)
      from (select distinct on (p.class_id) p.class_id, p.amount, p.unit, p.rate_count
              from rate_period p
             where p.academy_id = ${academyId} and p.class_id is not null
               and p.effective_from <= ${today}::date
             order by p.class_id, p.effective_from desc) rp
     where c.id = rp.class_id and c.academy_id = ${academyId}
       and (c.rate_amount is distinct from rp.amount
         or (rp.unit is not null and c.rate_unit is distinct from rp.unit)
         or (rp.rate_count is not null and c.rate_count is distinct from rp.rate_count))`
  await tx`
    update coach co
       set pay_amount = rp.amount,
           pay_unit   = coalesce(rp.unit, co.pay_unit)
      from (select distinct on (p.coach_id) p.coach_id, p.amount, p.unit
              from rate_period p
             where p.academy_id = ${academyId} and p.coach_id is not null
               and p.effective_from <= ${today}::date
             order by p.coach_id, p.effective_from desc) rp
     where co.id = rp.coach_id and co.academy_id = ${academyId}
       and (co.pay_amount is distinct from rp.amount
         or (rp.unit is not null and co.pay_unit is distinct from rp.unit))`
}

/**
 * The one planning duty a front desk DOES have. Excluding desks from `listAcademyIds`
 * is right for every job the planner mints — a desk has no roster and must not
 * initiate — but the pending_request expiry sweep is bookkeeping, not a send, and desk
 * sends mint real `pending_request` rows ("are you looking for classes, or do you run
 * them?") with real expiries. Nothing else visits them, so a visitor who never answered
 * left a question open forever in the desk's own tail. Sweep only: no agent_task is
 * opened for a stranger, because there is no business to owe them an answer from.
 */
async function sweepFrontDeskQuestions(): Promise<void> {
  try {
    const desks = await withInfra((tx) => tx<{ id: string }[]>`
      select id from academy where is_front_desk
    `)
    for (const d of desks) {
      await withAcademy(d.id, (tx) => tx`
        update pending_request pr
           set resolved_at = app.now(), resolution = 'expired'
         where pr.academy_id = ${d.id}
           and pr.resolved_at is null
           and pr.expires_at is not null
           and pr.expires_at < app.now()
           and not exists (select 1 from action a
                            where a.message_id = pr.message_id
                              and a.consumed_at is not null
                              and a.payload ->> 'kind' in ('operation', 'steps', 'noop', 'handoff'))
      `).catch(() => {})
    }
  } catch {
    // No desk list readable — nothing to sweep.
  }
}

export async function planAheadFor(academyId: string): Promise<number> {
  const nowAt = await now(academyId)
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

    // -- stated futures arrive ---------------------------------------------------
    // A rate stated "from the 1st of next month" lives in `rate_period` until its
    // day comes; `promoteRates` (tagged below) is what moves it onto the live
    // columns when it does. FIRST, before anything this pass enqueues reads them.
    await promoteRates(tx, academyId, today)

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

    /**
     * -- questions that stopped mattering ---------------------------------------
     *
     * A `pending_request` is resolved by a tap, by a newer ask on the same
     * subject, or by its own expiry — and the third has to be swept, because
     * nothing else visits it. Left unswept, the variable tail would tell a model
     * for weeks that somebody had been asked something they were asked about a
     * session that has long since run.
     *
     * Here rather than in a handler because it is bookkeeping about the whole
     * tenant, it costs one statement, and it runs on the same beat that plans
     * everything else. Above the go-live return on purpose: a question raised
     * during setup expires the same way.
     *
     * @mechanism pending_request.resolution — a question nobody answered and nobody tapped
     *   is swept to `expired` on the same beat that plans everything else; nothing else
     *   visits the row, and left unswept the tail told the model for weeks that somebody
     *   had been asked something about a session long since run. The sweep does not stop
     *   there: an `agent_task` is opened for whoever is OWED the answer — read from the
     *   `from:<contact>` the derived subject carries, because a request routed to the owner
     *   sits on the OWNER's contact while the parent who raised it is the one in silence.
     *   Expiry decides nothing about the question itself; an expired opt-out is not an
     *   opt-out, so the model reads what happened and chooses, including choosing silence.
     */
    const expired = await tx<
      { id: string; contact_id: string; kind: string; subject: string; question: string }[]
    >`
      update pending_request pr
         set resolved_at = app.now(), resolution = 'expired'
       where pr.academy_id = ${academyId}
         and pr.resolved_at is null
         and pr.expires_at is not null
         and pr.expires_at < app.now()
         -- A question somebody actually TAPPED is not an expired one, and calling it
         -- expired is worse than leaving it open: the block below opens a turn saying
         -- "nothing has changed and nothing has been decided" about work that already
         -- happened. Reachable because consumeAction could not write this table at all
         -- until resolveQuestion (lib/actions.ts) moved the write to the service role,
         -- so every row tapped before that is still open. It stays after the backfill as
         -- the same belt the tail carries. Same gate as the sibling invalidation: reply,
         -- view and menu decide nothing.
         and not exists (select 1 from action a
                          where a.message_id = pr.message_id
                            and a.consumed_at is not null
                            and a.payload ->> 'kind' in ('operation', 'steps', 'noop', 'handoff'))
      returning pr.id::text, pr.contact_id::text, pr.kind, pr.subject, pr.question`

    /**
     * -- and somebody hears about it -------------------------------------------
     *
     * Resolving the row silently is half a gate: the question stops being
     * reported, and the person who asked still has no answer. That is the shape
     * that produced 38 false alarms to paying families — a suppression that
     * never resolved what it suppressed — and this sweep was one `update` away
     * from being the same thing.
     *
     * **It changes nothing about the question itself, and that is deliberate.**
     * An expired opt-out request is not an opt-out; an expired plan confirmation
     * is not an approval. Acting on an unanswered question because it got old is
     * the relabeled state, which is the worst failure this product has recorded.
     * So the row resolves, and a TURN is opened — the model reads what happened
     * and decides, including deciding to say nothing, which is the common and
     * correct outcome for most of these.
     *
     * Opened for whoever is OWED the answer, which is not always who was asked.
     * A request routed to the owner sits on the OWNER's contact because his tap
     * resolves it, while the parent who raised it is the one left in silence —
     * so `reply`'s derived subject carries `from:<contact>` and it is read back
     * here. Without that the sweep would chase the owner and leave the asker
     * exactly where turn 7 left her.
     */
    for (const p of expired) {
      const from = /(?:^|\+)from:([0-9a-f-]{36})/i.exec(p.subject ?? '')?.[1]
      const owed = from || p.contact_id
      const slug = `expired-${p.id.slice(0, 8)}`
      push(
        'agent_task',
        nowAt,
        dedupe.agentTask(academyId, slug),
        {
          slug,
          subject: `unanswered: ${p.subject}`,
          minted_by_contact_id: owed,
          expires_at: new Date(nowAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          instruction:
            `A question put to somebody has expired without an answer, and nothing behind it has happened. ` +
            `It was a "${p.kind}" about "${p.subject}", and what they read was: "${String(p.question ?? '').slice(0, 300)}". ` +
            `Nothing has changed and nothing has been decided — do NOT treat the silence as a yes or a no. ` +
            `Work out whether the thing still matters: if it does not, say nothing and stop. If it does, the ` +
            `person who raised it is owed an answer about where it got to, and the person who never tapped may ` +
            `need it put to them again — decide which, and whether either is worth a message at all.`,
        },
        true,
      )
    }

    // §2.6 — building the roster messages nobody. Everything below this line
    // talks to a human, so it waits for the admin to say go. The one thing that
    // goes to the ADMIN before that is the proposal to say it — this is the only
    // gate in the product that nothing else ever resolves.
    if (academy.onboarding_state !== 'live') {
      await proposeGoLive(tx, academy, nowAt, today, push)
      return out
    }

    // Live, teaching, and billing nobody — see `askWhoIsInIt`.
    await askWhoIsInIt(tx, academy, nowAt, today, push)

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
      // The expiry ALERT waits for morning when the grace period ends inside
      // quiet hours — an 8:30pm class used to page the admin at 22:30. Deferred
      // forward (never pulled back: pulling back would fire it before the grace
      // it grants), and the run-time precondition recheck means a register
      // marked overnight simply skips.
      push('register_expiry',
        deferPastQuietHours(new Date(s.ends_at.getTime() + expiryHours * 3600_000), tz, academy.settings),
        dedupe.registerExpiry(s.id), { session_id: s.id }, true)

      for (const e of enrolByClass.get(s.class_id) ?? []) {
        if (e.started_on > date) continue
        if (e.ended_on && e.ended_on < date) continue
        // "Bill only" is a real setting, not a memory: a muted holder gets no
        // class reminders (the tally and dunning are not planned here and are
        // deliberately unaffected).
        // The mute is checked at the send path now, for every category and every
        // sender, rather than here for one of them (0032). Checking it twice
        // would be two authors of one truth, and the copy that used to live here
        // read a settings key that no longer exists — a filter that can only
        // ever say no, which is the shape of a guard that has quietly stopped
        // guarding.
        // §8.2 again: one lead time for every family is a schedule; per-person
        // timings are a manager. The parent's own record wins.
        const leadHours = leadFor(
          'clientReminderLeadHours', e.holder_settings, academy, academy.client_reminder_lead_hours,
        )
        // F-H: `start − lead` lands at 4:30am for an evening class on the
        // default 14h lead. Quiet-hours times are pulled back to the evening
        // before (util.pullOutOfQuietHours).
        push('client_reminder', pullOutOfQuietHours(new Date(start - leadHours * 3600_000), tz, academy.settings),
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
      /**
       * Deferred past the night, like the register escalation beside it.
       *
       * The send path is the floor now and it SUPPRESSES rather than delays — it
       * has no queue of its own and inventing one there would put a second
       * scheduler beside this one. So the scheduling has to do its half: an
       * 8:30pm class marked at 9:45 would otherwise have its outcome dropped
       * rather than delivered, and how a child got on is worth telling a parent
       * in the morning. `allowPast` still holds for everything already inside
       * waking hours, which is almost all of it.
       */
      push(
        'client_outcome',
        deferPastQuietHours(nowAt, academy.timezone, academy.settings),
        dedupe.clientOutcome(m.session_id, m.player_id),
        { session_id: m.session_id, player_id: m.player_id },
        true,
      )
    }

    // -- the two bookends, today and tomorrow (§7.2, §10.2) ---------------------
    //
    // A null time is the owner having chosen "Don't send one" on the setup form, and
    // it has to be checked HERE rather than inside `atTimeOn`, which reads a missing
    // time as midnight. Left to that default, declining the morning brief would have
    // produced one at 00:00 every day — the loudest possible way to honour a request
    // for silence, and the kind of bug that looks like a scheduling glitch rather
    // than an ignored answer.
    for (let d = 0; d <= Math.ceil(PLAN_HORIZON_HOURS / 24); d++) {
      const day = zoned(nowAt, tz).plus({ days: d }).toFormat('yyyy-MM-dd')
      if (academy.morning_brief_at) {
        push('admin_morning_brief', atTimeOn(day, academy.morning_brief_at, tz),
          dedupe.adminMorningBrief(academyId, day), { date: day })
      }
      if (academy.evening_digest_at) {
        push('admin_evening_digest', atTimeOn(day, academy.evening_digest_at, tz),
          dedupe.adminEveningDigest(academyId, day), { date: day })
      }
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
      // The owner's brief time is the sensible default for a coach's day, but the two
      // are different people: an owner who wants no 7am message has said nothing about
      // when their coaches should hear about a class they are teaching. So a null falls
      // back to a real hour rather than inheriting the silence — or, worse, midnight.
      const runAt = briefAt === null
        ? atTimeOn(date, academy.morning_brief_at ?? DEFAULT_COACH_DAY_AT, tz)
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

    // -- §9.1 step 2: the family invite, which the BOT sends. Every registered
    //    contact this academy has never messaged, staged from here ten at a time.
    //
    //    This predicate must stay the same shape as `firstContactBatch`'s own
    //    target query, and it moved with it: the 48-hour session bound is gone,
    //    because the invite no longer waits for a near session to justify itself
    //    — going live is the reason. An `exists` narrower than the handler's
    //    query would leave families the handler is willing to invite with no job
    //    that ever wakes to invite them.
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
            where a.academy_id = ct.academy_id and a.holder_person_id = ct.person_id
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
 * How long a business that is standing still waits between one go-live proposal and
 * the next. A week, because that is the unit a coaching business runs on: an owner
 * who has not turned the product on since last Monday has had a full cycle of
 * classes to notice, and has noticed nothing, because nothing is what the product
 * does until he says go.
 */
const GO_LIVE_ASK_EVERY_DAYS = 7

/**
 * -- the gate nothing resolves -----------------------------------------------
 *
 * `pre_launch` suppresses every proactive path in the product, and for the whole
 * life of the product nothing ever resolved the state it suppresses over. Six
 * simulated weeks, six businesses, none live: the only job that ran in any of
 * them was `materialize_sessions`. That is Layer 4's own "half a gate is worse
 * than no gate", at the largest scale it occurs in this codebase.
 *
 * R8 (`lib/agent/context.ts`) states the fact, and states it as a CONSTANT — the
 * same sentence on day 1 with an empty roster and on day 7 with a week of dead
 * classes behind it. A line that does not move is a line a model mentions once
 * and considers discharged: 28 admin turns, 5 mentions, none after day 2, every
 * one of them with `buttons: []`. This is not a second sign. It is the moment.
 *
 * It composes nothing. The write is one statement the model already finds
 * unaided, `needsPreview` already gates it because `academy` is a control table,
 * and `pendingConfirmation` already mints the tap. What was missing was a turn in
 * which any of that happens.
 *
 * @mechanism proposeGoLive — the planner opens the one turn allowed before an academy is
 *   live: a proposal to go live, raised on TWO axes and keyed to whichever of them has
 *   moved further — the SIZE OF THE HOLE (sessions already run to a roster nobody was told
 *   about, re-raised when that number doubles) and the TIME THE BUSINESS HAS STOOD STILL
 *   (re-raised once a week). Either axis alone describes only half the failure: a business
 *   teaching every day is asked as the damage compounds, and a business that is teaching
 *   nobody yet — the state where the hole never grows because nothing is running — is
 *   asked on the calendar instead of never. The dedupe key is the MAXIMUM of the two
 *   counters rather than the pair of them, so the triggers cannot compound into two asks
 *   in one week, and a day passing still moves nothing on its own.
 *   Closes F-CB.
 */
async function proposeGoLive(
  tx: Tx,
  academy: AcademyRow,
  nowAt: Date,
  today: string,
  push: Push,
): Promise<void> {
  const academyId = academy.id
  const [unreachedRoster] = await tx<
    { classes: number; families: number; week_sessions: number; ran_dark: number }[]
  >`
    select
      (select count(*)::int from class c
        where c.academy_id = ${academyId} and c.active
          and (c.ends_on is null or c.ends_on >= ${today}::date))                as classes,
      (select count(distinct pl.account_id)::int
         from enrollment e join player pl on pl.id = e.player_id and pl.active
        where e.academy_id = ${academyId} and e.ended_on is null)                as families,
      (select count(*)::int from session s
        where s.academy_id = ${academyId} and s.status = 'scheduled'
          and s.starts_at between app.now() and app.now() + interval '7 days')  as week_sessions,
      (select count(*)::int from session s
        where s.academy_id = ${academyId} and s.status <> 'cancelled'
          and s.ends_at < app.now()
          and exists (select 1 from enrollment e
                       where e.academy_id = s.academy_id and e.class_id = s.class_id
                         and e.ended_on is null))                               as ran_dark
  `
  if (!unreachedRoster) return

  /**
   * `app.guard_go_live()`'s own precondition, first and BY ITSELF: a proposal the
   * trigger (0033) would refuse is a button that fails in the owner's hand, which
   * is strictly worse than no button. That trigger asks for one active, non-ended
   * class and nothing else, so this asks for one active, non-ended class and
   * nothing else.
   *
   * @mechanism unreachedRoster — the entry test for the go-live proposal is a class that
   *   exists, and deliberately nothing more, because every other emptiness is not a reason
   *   to stay quiet but the reason to speak. Families on the books and a week with
   *   sessions in it were required here too, and that read the situation exactly the wrong
   *   way round: a timetable with nobody on it and nothing scheduled is a business
   *   mid-setup, and mid-setup is precisely when the owner cannot see that nothing he does
   *   reaches anybody. Measured over thirty simulated days, the class existed from day 14
   *   and the first family landed on day 22, so this gate held the proposal back for the
   *   eight days it was most needed and then raised it at step 3 — keyed to damage already
   *   done rather than to time elapsed — while the census told the model on every owner
   *   turn from day 14 that going live was a real next step to offer. The business
   *   finished the month at `onboarding_state = setup`, with no payments and an empty
   *   coach ledger.
   */
  if (unreachedRoster.classes === 0) {
    await askForTheTimetable(tx, academy, nowAt, today, push)
    return
  }
  await tellThemWhoAsked(tx, academy, nowAt, push)

  /**
   * How long this business has stood in setup, in whole days on its OWN calendar —
   * `today` is this academy's local date and `created_on` is a date, so this counts
   * day boundaries rather than measuring a duration, which is what a cadence keyed
   * to "another week has gone by" has to count. A `created_on` that will not parse
   * reads as zero: the hole axis below still works, and a slug of `go-live-NaN` is
   * a dedupe key that never matches itself and therefore a job every single tick.
   */
  const standing = DateTime.fromISO(today).diff(DateTime.fromISO(academy.created_on), 'days').days
  const daysStanding = Number.isFinite(standing) ? Math.max(0, Math.round(standing)) : 0

  /**
   * Fire on a change in state, never on the calendar restating a stuck one — with
   * the calendar itself as one of the states, because *"nothing has moved here for
   * another week"* is a change in what is true about a business, and it is the only
   * change a business that is teaching nobody ever produces.
   *
   * Two counters, each monotone:
   *
   *  - the SIZE OF THE HOLE, which moves when the number of sessions that have run
   *    to a roster nobody was told about DOUBLES. A business teaching every day is
   *    asked about four times across a week, each time carrying a bigger true
   *    number.
   *  - the TIME STOOD STILL, which moves once every `GO_LIVE_ASK_EVERY_DAYS`. A
   *    business with a timetable and no roster produces no hole at all — the old
   *    key was pinned at 0 forever — and this is the axis that asks it anyway.
   *
   * The key is the MAXIMUM of the two and not the pair, and that is the part that
   * keeps the original constraint intact. A pair would let both axes move in the
   * same week and ask twice; a maximum is one integer that neither axis can push
   * past the other, so the number of asks over any span is bounded by the larger
   * counter alone. A day passing still moves nothing by itself, which is what
   * "cannot become a daily nag" means and it is still true.
   *
   * Step 0 is reachable on the day a business is created, deliberately: the moment
   * a real class exists, *"shall I turn this on?"* is a fair question, it is asked
   * once, and then not again for a week.
   */
  const holeStep =
    unreachedRoster.ran_dark === 0 ? 0 : Math.floor(Math.log2(unreachedRoster.ran_dark)) + 1
  const standingStep = Math.floor(daysStanding / GO_LIVE_ASK_EVERY_DAYS)
  const step = Math.max(holeStep, standingStep)
  const slug = `go-live-${step}`

  // `adminsIn`'s ordering puts a reachable admin first; an academy with no
  // reachable admin has nobody to propose anything to.
  const owner = (await admins(tx, academyId)).find((a) => a.contact_id)
  if (!owner?.contact_id) return

  /**
   * The two states this proposal is raised in are not the same message, and the
   * difference is whether anything has been LOST yet.
   *
   * With sessions already run to a roster nobody was told about, the true thing to
   * say is the cost. With nothing run — the state the gate above now lets through —
   * there is no cost, and an instruction to state one is an instruction to invent
   * one: "0 sessions have already run with nobody told" is a sentence about damage
   * that reads as damage. So the empty case asks for where it stands instead, and
   * says outright that an empty roster is not a reason to wait, because the roster
   * is one of the things going live fills.
   */
  const nothingHasRunYet = unreachedRoster.ran_dark === 0

  push(
    'agent_task',
    // A proposal is not a reminder, so it waits for morning rather than being
    // pulled back to last night.
    deferPastQuietHours(nowAt, academy.timezone, academy.settings),
    dedupe.agentTask(academyId, slug),
    {
      slug,
      subject: nothingHasRunYet
        ? `not live: ${unreachedRoster.classes} class(es) on the timetable, ` +
          `${unreachedRoster.families} on the books, ` +
          `${unreachedRoster.week_sessions} session(s) in the next 7 days, ` +
          `${daysStanding} day(s) standing in setup`
        : `not live: ${unreachedRoster.families} on the books, ` +
          `${unreachedRoster.ran_dark} session(s) already run dark`,
      minted_by_contact_id: owner.contact_id,
      minted_roles: ['admin'],
      expires_at: new Date(nowAt.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      /**
       * The numbers as ROWS rather than as a claim in the instruction — read
       * under the owner's own RLS at run time, so they are the turn's own
       * evidence and are current rather than frozen at plan time. `app.now()`
       * only: WALL_CLOCK refuses a model-run statement that reads the host clock.
       */
      context:
        // The column computes what its name asserts: run-to-a-roster-nobody-was-told,
        // which needs the same enrollment-exists predicate the plan-time `ran_dark`
        // carries. Without it, the nothingHasRunYet branch's own instruction ("no
        // session has run to a roster nobody was told about") was contradicted by the
        // very row it told the model to read — the overclaim planted in the evidence.
        "select " +
        "(select count(*) from session s where s.status <> 'cancelled' and s.ends_at < app.now() " +
        "and exists (select 1 from enrollment e where e.class_id = s.class_id and e.ended_on is null)) " +
        "as sessions_already_run_with_nobody_told, " +
        "(select count(distinct pl.account_id) from enrollment e " +
        "join player pl on pl.id = e.player_id and pl.active where e.ended_on is null) " +
        "as families_on_the_books, " +
        "(select count(*) from session where status = 'scheduled' " +
        "and starts_at between app.now() and app.now() + interval '7 days') " +
        "as sessions_in_the_next_seven_days, " +
        "(select (app.now() at time zone timezone)::date - created_on from academy) " +
        "as days_since_this_business_was_created",
      instruction:
        'This business is not live, and until it is nothing it does reaches anybody on its own: ' +
        'no class reminder, no coach nudge, no morning brief or evening digest, no fee request and ' +
        'no payment chase. The owner cannot see that absence — from where they stand the roster is ' +
        'on the books and the timetable is on the board. ' +
        (nothingHasRunYet
          ? 'Nothing has been lost yet, and you must not invent a loss: no session has run to a ' +
            'roster nobody was told about, because there is barely a roster yet. Say where it ' +
            'actually stands, from the rows: whether anybody is on the books at all, what is ' +
            'scheduled in the next seven days, and how many days this business has been sitting ' +
            'in setup with none of the above switched on. An empty roster is not a reason to wait: ' +
            'the introduction that goes to every family who has never heard from this business is ' +
            'itself one of the things going live turns ON. '
          : 'Say what it has cost so far, from the rows: how many sessions have already run with ' +
            'nobody told, how many families are enrolled, how many sessions are in the next seven ' +
            'days, and how long it has been. ') +
        'Going live is one write and it is theirs to make, never yours: stage ' +
        'a plan whose one step writes onboarding_state = live on this academy — it comes back as a ' +
        "preview because it touches the business's own controls — and put it behind a button they " +
        'tap. Say what the tap turns on BEFORE they tap it: the reminders, the two daily summaries, ' +
        'the introduction that goes to every family who has never heard from this business, and the ' +
        'billing. Nothing is switched on until they press it. ' +
        'They may say no, and no is a real answer — if they have already said not yet, leave it.',
    },
    true,
  )
}

/**
 * The one state no proactive path in this product could reach: a business that exists
 * and has no timetable.
 *
 * `proposeGoLive` returns above when there is no class, and it is right to —
 * `unreachedRoster` argues it in full: `app.guard_go_live()` would refuse the write, so
 * offering the tap puts a button in an owner's hand that fails when they press it, which
 * is strictly worse than no button. But "do not offer the tap" was silently doing a
 * second job, "say nothing at all", and those are not the same instruction. Everything
 * else the planner does is gated on `onboarding_state = 'live'`, so a founded business
 * with an empty timetable hears from this product exactly never, however long it sits
 * there.
 *
 * That is the state EVERY business is in the moment it is founded, and it is the state
 * `2026-08-22-08-13-sim-7bo8` stayed in for fourteen days. The census DOES speak to it —
 * `readyToGoLive` puts "Nothing to go live with yet — the timetable is what is missing" in
 * front of the model on every not-live owner turn, and it fired on all six of that run's
 * owner sends between days 3 and 14. So the model was told, correctly, and the owner was
 * still never asked when his classes run: the schedule arrived on day 8 because the COACH
 * volunteered it in his own thread. What the census cannot do is speak when nobody has
 * written in, and a business mid-setup can go quiet for a week — which is exactly the
 * stretch where the owner cannot see that nothing he does reaches anybody.
 *
 * @mechanism askForTheTimetable — the branch `proposeGoLive` takes when there is no class
 *   yet, asking for the timetable instead of offering a tap that would fail. It mints NO
 *   go-live button, which is what keeps `unreachedRoster`'s argument intact: this is a
 *   question, and the offer stays behind the precondition that makes it real. It rides the
 *   same once-a-week axis rather than a second cadence, carries its own `subject_key` family
 *   so it can never collide with a `go-live-<n>` job, and goes silent the instant one active
 *   class exists — at which point `proposeGoLive` takes over unchanged. A business with a
 *   timetable and no roster is a different state and already had a voice; this is the one
 *   before it. It asks only somebody who has WRITTEN IN before: an owner who founded a
 *   business and never came back cannot receive this (the desk's own hand-over is their
 *   only inbound, and out of window an unsolicited job send is a template with somebody
 *   else's shape), so silence there is correct rather than a gap.
 *   Closes F-DQ.
 */
async function askForTheTimetable(
  tx: Tx,
  academy: AcademyRow,
  nowAt: Date,
  today: string,
  push: Push,
): Promise<void> {
  const owner = (await admins(tx, academy.id)).find((a) => a.contact_id)
  if (!owner?.contact_id) return

  /**
   * Only somebody who has actually written to this number.
   *
   * A question is worth asking of a person who can answer it. Out of the 24-hour window
   * an unsolicited send leaves as one of the eight frozen templates, which cannot carry
   * this question and would put "Update: <a date>" on the owner's phone instead — so the
   * job would spend a model call to produce something the send path reshapes into
   * something else. An owner who founded a business and never came back is not reachable
   * with a question, and asking anyway is the definition of a nag.
   */
  const [reach] = await tx<{ heard_from: boolean }[]>`
    select exists (
      select 1 from message m
       where m.academy_id = ${academy.id}
         and m.contact_id = ${owner.contact_id}
         and m.direction = 'inbound'
         and m.created_at > app.now() - interval '14 days'
    ) as heard_from`
  if (!reach?.heard_from) return

  const standing = DateTime.fromISO(today).diff(DateTime.fromISO(academy.created_on), 'days').days
  const daysStanding = Number.isFinite(standing) ? Math.max(0, Math.round(standing)) : 0
  // The same axis `proposeGoLive` uses, so the two never ask in the same week and a
  // business standing still is asked once a week by exactly one of them. Step 0 is
  // reachable on the founding day: the moment a business exists, "when do your classes
  // run" is the only question worth asking it.
  const step = Math.floor(daysStanding / GO_LIVE_ASK_EVERY_DAYS)
  const slug = `no-timetable-${step}`

  push(
    'agent_task',
    deferPastQuietHours(nowAt, academy.timezone, academy.settings),
    dedupe.agentTask(academy.id, slug),
    {
      slug,
      subject: `no timetable: 0 classes, ${daysStanding} day(s) since this business was created`,
      minted_by_contact_id: owner.contact_id,
      minted_roles: ['admin'],
      expires_at: new Date(nowAt.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString(),
      context:
        "select (select count(*) from class where active) as active_classes, "
        + "(select count(*) from venue) as venues, "
        + "(select count(*) from coach where status <> 'ended') as coaches, "
        + "(select (app.now() at time zone timezone)::date - created_on from academy) "
        + "as days_since_this_business_was_created",
      instruction:
        'This business has no class on its books. Until one exists the database refuses to switch it on, '
        + 'so no reminder, brief, introduction or bill reaches anybody — and the owner cannot see that '
        + 'absence, because from where they stand the classes are on the board. '
        + 'Going live is not offerable yet and a button for it would fail in their hand.',
    },
    true,
  )
}

/**
 * A business that is LIVE, teaching, and has nobody on its books.
 *
 * §7.1's ladder has five steps and the product chases two of them. `askForTheTimetable`
 * chases step 2 because `guard_go_live` refuses without a class, so the schema itself
 * forces the question. Step 4 — *"Families — contacts typed in, roster built, nobody
 * messaged"* — is forced by nothing, so nothing asks it, and the gap does not announce
 * itself: every message the product sends about an empty roster is accurate.
 *
 * `2026-08-22-16-51-sim-b8xo` is what that costs. Thirty days, 233 turns, no errors, the
 * business live with four classes and three coaches, the whole standing surface running —
 * and 22 sessions taught to nobody, 0 enrolments, 0 tally lines, ₹0 billed. The register
 * chase fired correctly and repeatedly and could not be acted on, because a register over
 * an empty roster has nothing to mark: *"skip the register since theres nobody to mark"*
 * (Priya, day 18). The money loop has one broken link and it is this one.
 *
 * The go-live offer says outright that an empty roster is not a reason to wait, and that
 * is TRUE — the introduction to every family is one of the things going live turns on.
 * What it left implicit is that somebody has to put a family there, and after go-live the
 * product had no moment where it noticed nobody had.
 *
 * @mechanism askWhoIsInIt — the mirror of `askForTheTimetable`, one rung further up the
 *   ladder: a live business with a class and no enrolment is asked who is in it. On the same
 *   `GO_LIVE_ASK_EVERY_DAYS` axis and under its own dedupe family, so it cannot collide with
 *   the go-live proposal it succeeds — the two are mutually exclusive by construction, since
 *   that one only runs while the business is NOT live. It goes silent the instant one live
 *   enrolment exists, and it asks only somebody who has written in, for the reason its
 *   sibling does: out of window this question is reshaped into a template that cannot carry it.
 *   Closes F-ED.
 */
async function askWhoIsInIt(
  tx: Tx,
  academy: AcademyRow,
  nowAt: Date,
  today: string,
  push: Push,
): Promise<void> {
  const [state] = await tx<{ classes: number; families: number; ran: number }[]>`
    select
      (select count(*)::int from class c
        where c.academy_id = ${academy.id} and c.active
          and (c.ends_on is null or c.ends_on >= ${today}::date))                as classes,
      (select count(*)::int from enrollment e
         join player pl on pl.id = e.player_id and pl.active
        where e.academy_id = ${academy.id} and e.ended_on is null)               as families,
      (select count(*)::int from session s
        where s.academy_id = ${academy.id} and s.status <> 'cancelled'
          and s.ends_at < app.now())                                             as ran
  `
  if (!state || state.classes === 0 || state.families > 0) return

  const owner = (await admins(tx, academy.id)).find((a) => a.contact_id)
  if (!owner?.contact_id) return

  const [reach] = await tx<{ heard_from: boolean }[]>`
    select exists (
      select 1 from message m
       where m.academy_id = ${academy.id}
         and m.contact_id = ${owner.contact_id}
         and m.direction = 'inbound'
         and m.created_at > app.now() - interval '14 days'
    ) as heard_from`
  if (!reach?.heard_from) return

  const standing = DateTime.fromISO(today).diff(DateTime.fromISO(academy.created_on), 'days').days
  const daysStanding = Number.isFinite(standing) ? Math.max(0, Math.round(standing)) : 0
  const step = Math.floor(daysStanding / GO_LIVE_ASK_EVERY_DAYS)

  push(
    'agent_task',
    deferPastQuietHours(nowAt, academy.timezone, academy.settings),
    dedupe.agentTask(academy.id, `no-roster-${step}`),
    {
      slug: `no-roster-${step}`,
      subject: `live with ${state.classes} class(es), nobody enrolled, ${state.ran} session(s) already taught`,
      minted_by_contact_id: owner.contact_id,
      minted_roles: ['admin'],
      expires_at: new Date(nowAt.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      context:
        "select (select count(*) from session where status <> 'cancelled' and ends_at < app.now()) "
        + 'as sessions_already_taught, '
        + '(select count(*) from attendance) as registers_marked, '
        + '(select count(*) from tally_line) as charges_written, '
        + '(select count(*) from class where active) as active_classes',
      instruction:
        'This business is live and teaching, and nobody is enrolled in anything. Sessions are running and '
        + 'generating no register to mark and no charge to bill, because a register over an empty roster has '
        + 'nothing on it. The rows say how many have already gone that way. '
        + 'A family is a contact and a child on the books; nobody is messaged by adding one, and nothing is '
        + 'sent to them until this business chooses to.',
    },
    true,
  )
}

/**
 * The people who asked on this number before there was anything here.
 *
 * `arrival` exists for exactly this and says so: *"A stranger who wrote once, was asked,
 * and never answered is the row this product could not previously produce, and 'how many
 * referrals became businesses' is the first question the vendor will ask."* The rows are
 * written. Nothing has ever read them.
 *
 * Driven over thirty days on `2026-08-22-16-51-sim-b8xo`, and it is the whole reason the
 * money never moved. Divya Rao asked on DAY 1 — *"anika's evening batch timings this
 * week?"* — and was told, truthfully, *"there's no class or batch on this number going by
 * anika, nothing is set up here yet at all"*. She left on day 2: *"wrong number then,
 * sorry."* Farah Sheikh asked the same evening and left on day 5: *"no classes no price no
 * thanks."* Rahul founded the business on day 3, went live, and ran 22 sessions to an
 * EMPTY ROSTER — zero enrolments, zero players, zero accounts, zero tally lines. His two
 * customers had walked past the door two days before it opened, and he was never told they
 * existed.
 *
 * WHY THIS TELLS THE OWNER AND DOES NOT MESSAGE THEM
 * -----------------------------------------------------------------------------
 * §16.2 is explicit and it is not a preference: *"A promotional message to a prospect who
 * did not convert is not on this list and will not be added — on a shared number, one
 * marketing classification is charged to every tenant. When an admin wants to re-approach
 * a cold prospect, the bot drafts it and the admin sends it from their own number."* So
 * the product must not write to Divya, and the draft path it must use instead already
 * exists (`send_invite`, `as_draft`). What was missing was never the channel. It was that
 * the owner did not know there was anybody to re-approach.
 *
 * @mechanism tellThemWhoAsked — the arrivals that reached this NUMBER, asked for classes and
 *   found nothing, told to the owner once their business exists, in the words those people
 *   used. It never messages them: §16.2 forbids re-approaching a cold prospect from this
 *   sender, and `send_invite`'s draft path is the road that stays open. Scoped to arrivals
 *   that settled nowhere — `destination_academy_id is null` — so anybody the desk actually
 *   handed to a business is somebody else's customer and not a lead. Bounded to a month
 *   back and asked once, on the `dedupe_key`, because a list of people who were turned away
 *   is news exactly once.
 */
async function tellThemWhoAsked(
  tx: Tx,
  academy: AcademyRow,
  nowAt: Date,
  push: Push,
): Promise<void> {
  const owner = (await admins(tx, academy.id)).find((a) => a.contact_id)
  if (!owner?.contact_id) return

  /**
   * Filtered on `arrival.sender_id` — the column the table carries for exactly this,
   * because a table with no tenant is scoped by its number. The first draft joined
   * through `academy fd` to reach the sender, and that join was DEAD under this
   * session: `academy`'s cm_service policy is `using (id = app.academy_id())`, so the
   * front desk's row is invisible to a session pinned to the business, the join
   * matched nothing without an error, and `n` was permanently zero — the mechanism
   * shipped, was cited in a closing row, and could never once fire. `arrival`'s own
   * cm_service policy is `using (true)`, so reading it directly is the whole fix.
   */
  const waiting = await tx<
    { profile_name: string | null; first_text: string | null; asked_on: string }[]
  >`
    select ar.profile_name, ar.first_text, ar.created_at::date::text as asked_on
      from arrival ar
     where ar.sender_id = (select sender_id from academy where id = ${academy.id})
       and ar.destination_academy_id is null
       and ar.created_at > app.now() - interval '30 days'
     order by ar.created_at
     limit 20`
  const n = waiting.length
  if (n === 0) return

  push(
    'agent_task',
    deferPastQuietHours(nowAt, academy.timezone, academy.settings),
    dedupe.agentTask(academy.id, 'who-asked'),
    {
      slug: 'who-asked',
      subject: `${n} person(s) asked on this number and found nothing here`,
      minted_by_contact_id: owner.contact_id,
      minted_roles: ['admin'],
      expires_at: new Date(nowAt.getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      /**
       * Their own words, FROZEN into the instruction at plan time rather than read at run
       * time — because at run time this turn runs under the owner's session and `arrival`
       * has no cm_user policy at all (0039: "RLS denies the agent everything"), so a
       * context query here would return nothing against a subject asserting N people
       * asked, which is the unbacked-claim shape this product treats as its worst. The
       * rows are static facts about people who already left; the planner reads them where
       * they are readable and hands them over labelled as its own.
       */
      instruction:
        'People wrote to this number looking for classes before this business was set up on it, and were '
        + 'told there was nothing here, because at the time there was not. They are not customers and this '
        + 'business has never contacted them. What each of them typed, as recorded by the front desk when '
        + 'they arrived (you cannot re-read these rows — they live outside this business):\n'
        + waiting
            .map((w) => `- ${w.asked_on} · ${w.profile_name || 'no name'}: "${(w.first_text || '').replace(/\s+/g, ' ').slice(0, 140)}"`)
            .join('\n')
        + '\n'
        + 'This product must not message them: on a shared number a re-approach to somebody who did not '
        + 'convert is a marketing classification charged to every business on it. The owner can, from '
        + 'their own phone, and send_invite with as_draft writes the message for them to forward.',
    },
    true,
  )
}

/** How far back the month-boundary catch-up looks. */
const BILLING_CATCHUP_MONTHS = 3

/**
 * The 1st writes the month's lines; the 1st of the following month reads the
 * month just gone back to every family that owes for it (§6.4, §12.1).
 *
 * **This used to be a forward look and nothing else, so a month could be lost
 * permanently.** It scanned the next 48 hours for a day whose `day === 1`, which
 * means the entire boundary depended on the planner running during those two
 * days. It does not, reliably: the clock is drivable and `drive clock --set`
 * across the 1st skips it in one hop, a worker that is down over a month end
 * skips it, and `month_end_tally` was additionally pushed WITHOUT `allowPast`, so
 * even a planner that ran on the correct day dropped the tally if it ran after
 * 09:00. Nothing back-filled any of it. That is why every driven world reached
 * its second month with no lines and no tally, and it is the other half of why
 * the money side has never run.
 *
 * So it is a **catch-up, not a schedule**. Both queries ask what is missing
 * rather than what day it is, bounded to the last few months so the scan stays
 * two queries per academy per tick — the same cost as the version that lost
 * months. `on conflict (dedupe_key) do nothing` makes re-planning free, and every
 * handler re-checks its own precondition (§13 rule 2), so enqueueing a period
 * that turns out not to need billing costs one skipped job and nothing else.
 *
 * @mechanism planMonthBoundary — the month boundary is a CATCH-UP, not a schedule: both
 *   queries ask which (enrollment, period) has no line and which closed period has no
 *   tally, bounded to BILLING_CATCHUP_MONTHS, and every job is pushed `allowPast`. A
 *   forward look at "is it the 1st" depends on the planner running on those two days,
 *   which a `clock --set` across the boundary, a worker down over a month end, or a plan
 *   that ran after 09:00 all skip — and nothing back-filled any of it, which is why every
 *   driven world reached its second month with no lines and no tally. The per-(enrollment,
 *   period) key is also what makes a player in two recurring classes billed for both.
 */
async function planMonthBoundary(
  tx: Tx, academy: AcademyRow, nowAt: Date, push: Push,
): Promise<void> {
  const tz = academy.timezone

  // Every (enrollment, period) that should carry a recurring line and does not —
  // from the enrollment's own first month, never earlier, so joining mid-year
  // does not invent a back-catalogue. Runs to the NEXT month so an upcoming 1st
  // is still scheduled at its proper future time rather than only caught later.
  const due = await tx<{ id: string; period: string }[]>`
    select e.id, gs.period::date::text as period
      from enrollment e
      join class cl on cl.id = e.class_id
      join player pl on pl.id = e.player_id and pl.active
      cross join lateral generate_series(
        greatest(
          date_trunc('month', e.started_on::timestamp),
          date_trunc('month', (app.now() at time zone ${tz}))
            - make_interval(months => ${BILLING_CATCHUP_MONTHS}::int)
        ),
        date_trunc('month', (app.now() at time zone ${tz})) + interval '1 month',
        interval '1 month'
      ) as gs(period)
     where e.academy_id = ${academy.id}
       and cl.active
       and coalesce(e.rate_unit, cl.rate_unit) in ('per_month', 'per_term', 'per_package')
       and e.started_on <= (gs.period + interval '1 month' - interval '1 day')::date
       and (e.ended_on is null or e.ended_on >= gs.period::date)
  `
  // There was a `not exists` here that skipped any (enrollment, period) for which
  // the PLAYER already had a recurring line in that period. It was one predicate
  // coarser than everything around it, and that cost real money: a player enrolled
  // in two recurring classes got one line and was never billed for the second,
  // forever, because the first class's line answered for both. The commonest way
  // an academy grows a player's fees is the one case it dropped.
  //
  // Nothing is needed in its place. The dedupe key below is already
  // (enrollment, period) — `enqueueMany` is `on conflict (dedupe_key) do nothing`
  // and job rows are never deleted, so a period is enqueued at most once ever —
  // and `writeLine` re-checks for the exact line before writing it (§13 rule 2:
  // every handler re-checks its own precondition). A filter that is coarser than
  // both of those guards can only lose rows; it cannot save any work they were
  // not already doing.
  for (const e of due) {
    push(
      'monthly_lines',
      atTimeOn(e.period, '00:05:00', tz),
      dedupe.monthlyLines(e.id, e.period),
      { enrollment_id: e.id, period: e.period },
      true,
    )
  }

  // Every closed period that has lines. The tally for a period is read back on
  // the 1st of the month AFTER it, which is what "the month just gone" means.
  const periods = await tx<{ account_id: string; period: string }[]>`
    select distinct tl.account_id, tl.period::text as period
      from tally_line tl
     where tl.academy_id = ${academy.id}
       and tl.period >= (date_trunc('month', (app.now() at time zone ${tz}))
                         - make_interval(months => ${BILLING_CATCHUP_MONTHS}::int))::date
       and tl.period <= date_trunc('month', (app.now() at time zone ${tz}))::date
  `
  for (const p of periods) {
    const readBackOn = DateTime.fromISO(p.period, { zone: tz }).plus({ months: 1 }).toFormat('yyyy-MM-dd')
    push(
      'month_end_tally',
      atTimeOn(readBackOn, '09:00:00', tz),
      dedupe.monthEndTally(p.account_id, p.period),
      { account_id: p.account_id, period: p.period },
      // Without this the tally was dropped whenever planning happened after 09:00
      // on the 1st — a planner running at 09:01 lost the month it was there to bill.
      true,
    )
  }

  /**
   * The coach side of the same boundary (0038).
   *
   * Deliberately the month AFTER the period, where `monthly_lines` is the 1st OF
   * it. A family's monthly fee is knowable on the 1st; what a coach worked is not
   * knowable until the month is over, and the whole value of the row is that it
   * stops moving once written.
   *
   * Runs from each coach's first month, never earlier, on the same catch-up
   * window as the tally — so a business switching this on does not invent a back
   * catalogue, and one that was offline for a month still closes it.
   */
  const coachMonths = await tx<{ coach_id: string; period: string }[]>`
    select c.id as coach_id, gs.period::date::text as period
      from coach c
      cross join lateral generate_series(
        greatest(
          -- From the month they ACCEPTED, not the month the row was typed. A coach
          -- added in August who onboards in October was never employed in August,
          -- and employedThatMonth (lib/jobs/handlers/money.ts) refuses that row at
          -- the close — this is the same rule one stage earlier, so the job is never
          -- enqueued rather than enqueued and skipped.
          date_trunc('month', coalesce(c.onboarded_at, c.created_at) at time zone ${tz}),
          date_trunc('month', (app.now() at time zone ${tz}))
            - make_interval(months => ${BILLING_CATCHUP_MONTHS}::int)
        ),
        date_trunc('month', (app.now() at time zone ${tz})) - interval '1 month',
        interval '1 month'
      ) as gs(period)
     where c.academy_id = ${academy.id}
       and c.pay_amount is not null
       -- Somebody who was invited and never accepted has not worked a month. Reaching
       -- 'active' counts however the row got there: onboard_coach stamps onboarded_at
       -- and it is not the only path, and a gate on the stamp alone leaves REAL coaches
       -- unpaid. See employedThatMonth (lib/jobs/handlers/money.ts).
       and (c.onboarded_at is not null or c.status in ('active', 'ended'))
       -- A coach who has left still earned their last month. What excludes a
       -- period is having ended BEFORE it, not having ended at all.
       and (c.ended_on is null or c.ended_on >= gs.period::date)
  `
  for (const m of coachMonths) {
    const closesOn = DateTime.fromISO(m.period, { zone: tz }).plus({ months: 1 }).toFormat('yyyy-MM-dd')
    push(
      'coach_month_lines',
      atTimeOn(closesOn, '00:20:00', tz),
      dedupe.coachMonthLines(m.coach_id, m.period),
      { coach_id: m.coach_id, period: m.period },
      // Same reason as the tally above: a planner that first runs mid-month must
      // still close the months already behind it.
      true,
    )
  }
}

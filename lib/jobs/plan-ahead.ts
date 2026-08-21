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
  return written
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
 *   live: a proposal to go live, raised on the SIZE OF THE HOLE rather than on the calendar
 *   — sessions that have already run to a roster nobody was told about — and re-raised only
 *   when that number doubles, so it cannot become a daily nag. `app.guard_go_live()`'s own
 *   precondition is checked first and this gate is strictly stronger, so the plan behind the
 *   button cannot fail in the owner's hand. Six simulated weeks produced six businesses that
 *   never went live, with every reminder, digest, coach nudge and fee request suppressed for
 *   twenty-one days, because R8 put a sign on the door and nothing ever put the owner in
 *   front of it.
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
  const [dark] = await tx<
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
  if (!dark) return

  /**
   * `app.guard_go_live()`'s own precondition, first and by itself: a proposal the
   * trigger would refuse is a button that fails in the owner's hand, which is
   * strictly worse than no button. Then the two facts that make it cost anything
   * — somebody on the books, and a week with classes in it. Below that there is
   * nothing true to say, and this stays quiet, which is the right behaviour for a
   * half-entered timetable.
   */
  if (dark.classes === 0 || dark.families === 0 || dark.week_sessions === 0) return

  /**
   * Fire on a change in state, never on the calendar restating a stuck one. The
   * state is the SIZE OF THE HOLE — how many sessions have now run to a roster
   * nobody was told about — and the key moves only when it doubles. A business
   * standing still is asked once; a business teaching every day is asked about
   * four times across a week, each time carrying a bigger true number. A day
   * passing does not move the key, so it cannot become a daily nag.
   */
  const step = dark.ran_dark === 0 ? 0 : Math.floor(Math.log2(dark.ran_dark)) + 1
  const slug = `go-live-${step}`

  // `adminsIn`'s ordering puts a reachable admin first; an academy with no
  // reachable admin has nobody to propose anything to.
  const owner = (await admins(tx, academyId)).find((a) => a.contact_id)
  if (!owner?.contact_id) return

  push(
    'agent_task',
    // A proposal is not a reminder, so it waits for morning rather than being
    // pulled back to last night.
    deferPastQuietHours(nowAt, academy.timezone, academy.settings),
    dedupe.agentTask(academyId, slug),
    {
      slug,
      subject: `not live: ${dark.families} on the books, ${dark.ran_dark} session(s) already run dark`,
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
        "select " +
        "(select count(*) from session where status <> 'cancelled' and ends_at < app.now()) " +
        "as sessions_already_run_with_nobody_told, " +
        "(select (app.now() at time zone timezone)::date - created_on from academy) " +
        "as days_since_this_business_was_created",
      instruction:
        'This business is not live, and until it is nothing it does reaches anybody on its own: ' +
        'no class reminder, no coach nudge, no morning brief or evening digest, no fee request and ' +
        'no payment chase. The owner cannot see that absence — from where they stand the roster is ' +
        'on the books and the timetable is on the board. ' +
        'Say what it has cost so far, from the rows: how many sessions have already run with nobody ' +
        'told, how many families are enrolled, how many sessions are in the next seven days, and ' +
        'how long it has been. ' +
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
          date_trunc('month', c.created_at at time zone ${tz}),
          date_trunc('month', (app.now() at time zone ${tz}))
            - make_interval(months => ${BILLING_CATCHUP_MONTHS}::int)
        ),
        date_trunc('month', (app.now() at time zone ${tz})) - interval '1 month',
        interval '1 month'
      ) as gs(period)
     where c.academy_id = ${academy.id}
       and c.pay_amount is not null
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

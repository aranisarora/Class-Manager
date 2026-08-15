/**
 * lib/jobs/handlers/coach.ts — the coach ladder (§8.2).
 *
 *   coach_day     morning, the day delivered   CO-DAY
 *   coach_coming  T-60 "Coming?"               CO-COMING
 *   coach_nudge   T-30, only if still silent   CO-NUDGE
 *
 * T-15 is deliberately not here: at T-15 the **admin** is told and the coach is
 * not chased further (§8.2 step 4) — that is `admin_escalate_uncovered`.
 *
 * Two rules run through all of it:
 *   - **One confirmation is enough.** A coach who tapped `[Yes, I'm coming]` is
 *     never asked again, so every rung re-checks `confirmed_at`/`arrived_at`
 *     before it opens its mouth.
 *   - **The timings are defaults, not constants.** T-60 and T-30 come from
 *     `person.settings` first, then `academy.settings`, then the product
 *     default — never from a literal in this file.
 */

import type { Job } from '@/lib/types'
import type { Tx } from '@/lib/db'
import { now } from '@/lib/clock'
import { composeAndSend } from '@/lib/messaging/compose'
import { LIMITS } from '@/lib/messaging/types'
import { dedupe } from '../kinds'
import { enqueue } from '../enqueue'
import {
  admins, assignedCoaches, buttonTitle, clamp, contactFor, dayLabel, firstName,
  isSolo, isoDate, joinLines, leadFor, loadAcademy, loadSession, longDay, need,
  note, payloadOf, serviceCtx, skip, spanLabel, timeLabel, withAcademy,
  type AssignedCoach,
} from '../util'

type CoachRow = {
  coach_id: string
  person_id: string
  full_name: string
  status: string
  ended_on: string | null
  settings: Record<string, unknown> | null
}

async function loadCoach(tx: Tx, academyId: string, coachId: string): Promise<CoachRow | null> {
  const [row] = await tx<CoachRow[]>`
    select co.id as coach_id, co.person_id, pe.full_name, co.status,
           co.ended_on::text as ended_on, pe.settings
      from coach co join person pe on pe.id = co.person_id
     where co.id = ${coachId} and co.academy_id = ${academyId}
  `
  return row ?? null
}

/**
 * §18 rule 1 wants the people a confirmation is *for*. For "Coming?" that is
 * whoever would otherwise have to chase — the admins. When the coach is also
 * an admin (solo operator, head coach who administers, an admin covering a
 * session this week) the recipient is inside that set and the send path drops
 * the message: nobody is ever asked to confirm something to themselves. This is
 * the whole of §18's coach column, with no `if solo` anywhere.
 */
async function confirmationAudience(tx: Tx, academyId: string): Promise<string[]> {
  const rows = await admins(tx, academyId)
  return rows.map((r) => r.person_id)
}

/**
 * `coach_day` — the day, delivered (§8.2 step 1).
 *
 * Merged into the morning brief for a solo operator (§18): one message in one
 * chat, so this one stands down rather than arriving alongside it.
 */
export async function coachDay(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const coachId = need(p, 'coach_id')
  const nowAt = await now(academyId)

  const plan = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    if (academy.onboarding_state !== 'live') skip('not live yet')

    const coach = await loadCoach(tx, academyId, coachId)
    if (!coach) skip('coach gone')
    if (coach.status !== 'active') skip(`coach is ${coach.status}, not active`)

    const date = typeof p.date === 'string' && p.date ? p.date : isoDate(nowAt, academy.timezone)
    if (coach.ended_on && coach.ended_on < date) skip('coach has ended')

    if (await isSolo(tx, academyId)) skip('solo — the day rides in the morning brief (§18)')

    const sessions = await tx<{
      id: string; class_id: string; class_name: string; starts_at: Date; ends_at: Date
      venue_name: string | null
    }[]>`
      select s.id, s.class_id, cl.name as class_name, s.starts_at, s.ends_at,
             v.name as venue_name
        from session s
        join session_coach sc on sc.session_id = s.id and sc.coach_id = ${coachId}
        join class cl on cl.id = s.class_id
        left join venue v on v.id = coalesce(s.venue_id, cl.venue_id)
       where s.academy_id = ${academyId}
         and s.status = 'scheduled'
         and sc.declined_at is null
         and (s.starts_at at time zone ${academy.timezone})::date = ${date}::date
       order by s.starts_at
    `
    if (sessions.length === 0) skip('no sessions today')

    const heads = new Map<string, number>()
    for (const s of sessions) {
      const [row] = await tx<{ n: number }[]>`
        select count(*)::int as n
          from enrollment e join player pl on pl.id = e.player_id and pl.active
         where e.class_id = ${s.class_id}
           and e.started_on <= ${date}::date
           and (e.ended_on is null or e.ended_on >= ${date}::date)
      `
      heads.set(s.id, row?.n ?? 0)
    }

    const contactId = await contactFor(tx, academyId, coach.person_id)
    if (!contactId) skip('coach has no reachable number')

    return { academy, coach, sessions, heads, contactId, date }
  })

  const { academy, coach, sessions, heads, contactId, date } = plan
  const tz = academy.timezone
  const lines = sessions.map((s) => {
    const venue = s.venue_name ? `, ${s.venue_name}` : ''
    const head = heads.get(s.id) ?? 0
    return `• ${spanLabel(s.starts_at, s.ends_at, tz)} — ${s.class_name}${venue} — ${head} in`
  })

  await composeAndSend(serviceCtx(academy.id), {
    toContactId: contactId,
    header: clamp(academy.name, LIMITS.headerChars),
    body: clamp(joinLines([`Your ${longDay(date, tz)}:`, ...lines]), LIMITS.bodyChars),
    buttons: [
      { title: buttonTitle('All good'), action: { kind: 'noop', ack: 'Good — have a good one.' } },
      {
        title: buttonTitle("Something's wrong"),
        action: { kind: 'reply', text: `Something's wrong with my schedule for ${longDay(date, tz)}` },
      },
      {
        title: buttonTitle('Mark someone out'),
        action: { kind: 'reply', text: `Someone is out of one of my classes ${dayLabel(date, tz, nowAt)}` },
      },
    ],
    catalogId: 'CO-DAY',
    subjectPersonIds: [coach.person_id],
  })
  note(`day sent to ${firstName(coach.full_name)} — ${sessions.length} session(s)`)
}

/** The shared precondition for both rungs: is this coach still worth asking? */
async function ladderPrecondition(
  tx: Tx, academyId: string, sessionId: string, coachId: string, nowAt: Date,
) {
  const academy = await loadAcademy(tx, academyId)
  if (!academy) skip('academy gone')
  if (academy.onboarding_state !== 'live') skip('not live yet')

  const session = await loadSession(tx, sessionId)
  if (!session) skip('session gone')
  if (session.status !== 'scheduled') skip(`session is ${session.status}`)
  if (session.starts_at.getTime() <= nowAt.getTime()) skip('session has already started')

  const all = await assignedCoaches(tx, sessionId)
  const me: AssignedCoach | undefined = all.find((c) => c.coach_id === coachId)
  if (!me) skip('coach is no longer on this session')
  if (me.declined_at) skip('coach already declined')
  // §8.2 — one confirmation is enough. No arrival prompt, no second nudge.
  if (me.confirmed_at) skip('coach already confirmed')
  if (me.arrived_at) skip('coach is already there')
  if (me.status === 'ended') skip('coach has ended')
  if (me.ended_on && me.ended_on < isoDate(session.starts_at, academy.timezone)) skip('coach has ended')
  if (!me.contact_id) skip('coach has no reachable number')

  return { academy, session, me, all }
}

/**
 * `coach_coming` at T-60 — CO-COMING (§8.2 step 2).
 *
 * `[Can't make it]` goes back through the agent rather than executing: the tap
 * confirms first, because dropping a class is not mis-tappable (§8.2).
 */
export async function coachComing(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const sessionId = need(p, 'session_id')
  const coachId = need(p, 'coach_id')
  const nowAt = await now(academyId)

  const plan = await withAcademy(academyId, async (tx) => {
    const base = await ladderPrecondition(tx, academyId, sessionId, coachId, nowAt)
    const audience = await confirmationAudience(tx, academyId)
    const nudgeLead = leadFor('coachNudgeLeadMinutes', base.me.settings, base.academy, null)
    return { ...base, audience, nudgeLead }
  })

  const { academy, session, me, audience, nudgeLead } = plan
  const tz = academy.timezone
  const venue = session.venue_name ? ` at ${session.venue_name}` : ''

  await composeAndSend(serviceCtx(academy.id), {
    toContactId: me.contact_id as string,
    header: clamp(academy.name, LIMITS.headerChars),
    body: clamp(
      `${session.class_name} starts ${dayLabel(session.starts_at, tz, nowAt)} at `
      + `${timeLabel(session.starts_at, tz)}${venue}. Coming?`,
      LIMITS.bodyChars,
    ),
    buttons: [
      {
        title: buttonTitle("Yes, I'm coming"),
        action: { kind: 'operation', op: 'confirm_coach', args: { session_id: session.id, coach_id: me.coach_id } },
      },
      {
        title: buttonTitle("Can't make it"),
        action: {
          kind: 'reply',
          text: `I can't make ${session.class_name} ${dayLabel(session.starts_at, tz, nowAt)} at ${timeLabel(session.starts_at, tz)}`,
        },
      },
      {
        title: buttonTitle('Directions'),
        action: { kind: 'reply', text: `Directions to ${session.venue_name ?? session.class_name}` },
      },
    ],
    catalogId: 'CO-COMING',
    isConfirmationRequest: true,
    subjectPersonIds: audience,
  })
  note(`asked ${firstName(me.full_name)} about ${session.class_name}`)

  // The next rung. Idempotent — planAhead has usually put it there already.
  const nudgeAt = new Date(session.starts_at.getTime() - nudgeLead * 60_000)
  await enqueue(
    'coach_nudge', nudgeAt, dedupe.coachNudge(session.id, me.coach_id),
    { academy_id: academy.id, session_id: session.id, coach_id: me.coach_id }, academy.id,
  )
}

/**
 * `coach_nudge` at T-30 — CO-NUDGE (§8.2 step 3).
 *
 * One nudge, only if still silent, and it says the quiet part out loud: the
 * admin gets told shortly if we still don't know.
 */
export async function coachNudge(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const sessionId = need(p, 'session_id')
  const coachId = need(p, 'coach_id')
  const nowAt = await now(academyId)

  const plan = await withAcademy(academyId, async (tx) => {
    const base = await ladderPrecondition(tx, academyId, sessionId, coachId, nowAt)
    const audience = await confirmationAudience(tx, academyId)
    const escalateLead = leadFor('adminEscalateLeadMinutes', base.me.settings, base.academy, null)
    const adminRows = await admins(tx, academyId)
    return { ...base, audience, escalateLead, adminName: adminRows[0]?.full_name ?? null }
  })

  const { academy, session, me, audience, escalateLead, adminName } = plan
  const tz = academy.timezone
  const escalateAt = new Date(session.starts_at.getTime() - escalateLead * 60_000)
  const teller = adminName ? firstName(adminName) : 'the office'

  await composeAndSend(serviceCtx(academy.id), {
    toContactId: me.contact_id as string,
    header: clamp(academy.name, LIMITS.headerChars),
    body: clamp(
      `Still need to know about ${session.class_name} at ${timeLabel(session.starts_at, tz)}. `
      + `If I haven't heard by ${timeLabel(escalateAt, tz)} I'll let ${teller} know.`,
      LIMITS.bodyChars,
    ),
    buttons: [
      {
        title: buttonTitle("Yes, I'm coming"),
        action: { kind: 'operation', op: 'confirm_coach', args: { session_id: session.id, coach_id: me.coach_id } },
      },
      {
        title: buttonTitle("Can't make it"),
        action: {
          kind: 'reply',
          text: `I can't make ${session.class_name} ${dayLabel(session.starts_at, tz, nowAt)} at ${timeLabel(session.starts_at, tz)}`,
        },
      },
    ],
    catalogId: 'CO-NUDGE',
    isConfirmationRequest: true,
    subjectPersonIds: audience,
  })
  note(`nudged ${firstName(me.full_name)} about ${session.class_name}`)

  // T-15: the admin is told, and the coach is not chased further (§8.2 step 4).
  await enqueue(
    'admin_escalate_uncovered', escalateAt, dedupe.adminEscalateUncovered(session.id),
    { academy_id: academy.id, session_id: session.id }, academy.id,
  )
}

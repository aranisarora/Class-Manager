/**
 * lib/jobs/handlers/admin.ts — what reaches the admin's phone.
 *
 *   admin_escalate_uncovered  T-15   AD-ESCALATE-UNCONFIRMED
 *   coach_not_onboarded       <48h   AD-COACH-NOT-ONBOARDED
 *   admin_morning_brief              AD-MORNING-BRIEF   (§10.2, synthesised)
 *   admin_evening_digest             AD-EVENING-DIGEST  (§10.2, synthesised)
 *
 * "Two bookends, quiet between" (§7.2). The two bookends are written by the
 * model, not by this file — the digest is not a template with slots, so both
 * hand off to `synthesize`. The other two are the genuine escalations that are
 * allowed to interrupt.
 */

import type { Job } from '@/lib/types'
import { now } from '@/lib/clock'
import { synthesize } from '@/lib/agent/loop'
import { composeAndSend } from '@/lib/messaging/compose'
import { LIMITS } from '@/lib/messaging/types'
import {
  admins, assignedCoaches, buttonTitle, clamp, dayLabel, firstName, isCovered,
  isoDate, joinLines, loadAcademy, loadSession, need, note, payloadOf, serviceCtx,
  skip, timeLabel, withAcademy,
} from '../util'

/**
 * `admin_escalate_uncovered` at T-15 — AD-ESCALATE-UNCONFIRMED (§8.2 step 4).
 *
 * **Escalations are about sessions, never people** (§6.3): the copy says the
 * 6:30 has no confirmed coach, never that Arjun hasn't answered. The coach still
 * rides in `subjectPersonIds`, because §18 rule 2 needs it to refuse to escalate
 * about someone to themselves — which is how this row disappears for a solo
 * operator without a single `if solo` in the code.
 */
export async function adminEscalateUncovered(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const sessionId = need(p, 'session_id')
  const nowAt = await now(academyId)

  const plan = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    if (academy.onboarding_state !== 'live') skip('not live yet')

    const session = await loadSession(tx, sessionId)
    if (!session) skip('session gone')
    if (session.status !== 'scheduled') skip(`session is ${session.status}`)
    if (nowAt.getTime() > session.ends_at.getTime()) skip('session is over')

    // The one thing that matters, re-derived now rather than trusted from
    // enqueue time (§13 rule 2, §6.3).
    if (await isCovered(tx, sessionId)) skip('session is covered')

    const coaches = await assignedCoaches(tx, sessionId)
    const recipients = (await admins(tx, academyId)).filter((a) => a.contact_id)
    if (recipients.length === 0) skip('no admin to tell')

    return { academy, session, coaches, recipients }
  })

  const { academy, session, coaches, recipients } = plan
  const tz = academy.timezone
  const when = `${dayLabel(session.starts_at, tz, nowAt)} ${timeLabel(session.starts_at, tz)}`
  const minutes = Math.max(0, Math.round((session.starts_at.getTime() - nowAt.getTime()) / 60_000))
  // T-15 normally reads "in 15 minutes". But a job that fires early or late — a driven
  // clock hop, a backlog — must not say "in 3411 minutes" (shipped once); past ~90 the
  // day-and-time label above already says when, so the countdown adds nothing.
  const countdown =
    minutes <= 0 ? '.' : minutes <= 90 ? ` — it starts in ${minutes} minute${minutes === 1 ? '' : 's'}.` : '.'
  const pending = coaches.filter((c) => !c.declined_at)
  const declined = coaches.filter((c) => c.declined_at)

  const callTarget = pending[0] ?? declined[0] ?? null

  for (const admin of recipients) {
    await composeAndSend(serviceCtx(academy.id), {
      toContactId: admin.contact_id as string,
      header: clamp(academy.name, LIMITS.headerChars),
      body: clamp(joinLines([
        `${when}'s ${session.class_name} has no confirmed coach${countdown}`,
        declined.length > 0 ? `${declined.length} assigned coach has dropped out.` : null,
      ]), LIMITS.bodyChars),
      buttons: [
        {
          title: buttonTitle(callTarget ? `Call ${firstName(callTarget.full_name)}` : 'Call coach'),
          action: {
            kind: 'reply',
            text: callTarget
              ? `Give me ${firstName(callTarget.full_name)}'s number`
              : `Who is on ${session.class_name} ${when}?`,
          },
        },
        {
          title: buttonTitle('Offer to others'),
          action: { kind: 'reply', text: `Offer ${session.class_name} ${when} to the other coaches` },
        },
        {
          title: buttonTitle('Cancel session'),
          action: {
            kind: 'operation',
            op: 'cancel_session',
            args: { session_id: session.id, reason: 'no coach available' },
          },
        },
      ],
      catalogId: 'AD-ESCALATE-UNCONFIRMED',
      isEscalation: true,
      subjectPersonIds: coaches.map((c) => c.person_id),
    })
  }
  note(`uncovered: ${session.class_name} ${when} — ${recipients.length} admin(s) told`)
}

/**
 * `coach_not_onboarded` — AD-COACH-NOT-ONBOARDED (§8.1, §12.4).
 *
 * "If a coach never onboards and has a session within 48h, the **admin** is told
 * — not the coach, who by definition is not listening."
 */
export async function coachNotOnboarded(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const coachId = need(p, 'coach_id')
  const nowAt = await now(academyId)

  const plan = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    if (academy.onboarding_state !== 'live') skip('not live yet')

    const [coach] = await tx<{ person_id: string; full_name: string; status: string }[]>`
      select co.person_id, pe.full_name, co.status
        from coach co join person pe on pe.id = co.person_id
       where co.id = ${coachId} and co.academy_id = ${academyId}
    `
    if (!coach) skip('coach gone')
    // 'active' means they tapped [Looks right] — the whole reason for this alert
    // is gone. 'ended' means it no longer matters.
    if (coach.status !== 'invited') skip(`coach is ${coach.status}`)

    const upcoming = await tx<{ class_name: string; starts_at: Date }[]>`
      select cl.name as class_name, s.starts_at
        from session s
        join session_coach sc on sc.session_id = s.id and sc.coach_id = ${coachId}
        join class cl on cl.id = s.class_id
       where s.academy_id = ${academyId}
         and s.status = 'scheduled'
         and sc.declined_at is null
         and s.starts_at between app.now() and app.now() + interval '48 hours'
       order by s.starts_at asc
    `
    if (upcoming.length === 0) skip('no session inside 48h any more')

    const recipients = (await admins(tx, academyId)).filter((a) => a.contact_id)
    if (recipients.length === 0) skip('no admin to tell')

    return { academy, coach, upcoming, recipients }
  })

  const { academy, coach, upcoming, recipients } = plan
  const tz = academy.timezone
  const next = upcoming[0]
  const rest = upcoming.length > 1 ? ` (and ${upcoming.length - 1} more inside two days)` : ''

  for (const admin of recipients) {
    await composeAndSend(serviceCtx(academy.id), {
      toContactId: admin.contact_id as string,
      header: clamp(academy.name, LIMITS.headerChars),
      body: clamp(
        `${firstName(coach.full_name)} hasn't confirmed the invite yet, and is down for `
        + `${next.class_name} ${dayLabel(next.starts_at, tz, nowAt)} at ${timeLabel(next.starts_at, tz)}${rest}.`,
        LIMITS.bodyChars,
      ),
      buttons: [
        {
          title: buttonTitle('Resend invite'),
          action: { kind: 'reply', text: `Send me the invite for ${coach.full_name} again` },
        },
        {
          title: buttonTitle('Reassign'),
          action: { kind: 'reply', text: `Reassign ${firstName(coach.full_name)}'s sessions this week` },
        },
      ],
      catalogId: 'AD-COACH-NOT-ONBOARDED',
      isEscalation: true,
      subjectPersonIds: [coach.person_id],
    })
  }
  note(`${firstName(coach.full_name)} not onboarded, ${upcoming.length} session(s) inside 48h`)
}

/**
 * `admin_morning_brief` — AD-MORNING-BRIEF (§10.2).
 *
 * Led by *Needs you*, and **silent when there is nothing**. The silence is the
 * model's call, not this handler's: it receives the day and decides. For a solo
 * operator the coach day is merged into this one message (§18), which is why
 * `coach_day` stands down rather than arriving alongside it.
 */
export async function adminMorningBrief(job: Job): Promise<void> {
  await runSynthesis(job, 'brief')
}

/** `admin_evening_digest` — AD-EVENING-DIGEST (§10.2). Kept for solo, shorter. */
export async function adminEveningDigest(job: Job): Promise<void> {
  await runSynthesis(job, 'digest')
}

async function runSynthesis(job: Job, kind: 'brief' | 'digest'): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const nowAt = await now(academyId)

  const academy = await withAcademy(academyId, async (tx) => {
    const a = await loadAcademy(tx, academyId)
    if (!a) skip('academy gone')
    if (a.onboarding_state !== 'live') skip('not live yet')
    const recipients = (await admins(tx, academyId)).filter((r) => r.contact_id)
    if (recipients.length === 0) skip('no admin to tell')
    return a
  })

  const out = await synthesize(academyId, kind)
  const delivered = out.sent.filter((s) => s.status === 'queued' || s.status === 'sent').length
  note(
    `${kind} for ${isoDate(nowAt, academy.timezone)}: ${delivered} sent`
    + (out.error ? ` (error: ${out.error})` : delivered === 0 ? ' — nothing worth saying' : ''),
  )
}

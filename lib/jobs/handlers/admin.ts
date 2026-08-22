/**
 * lib/jobs/handlers/admin.ts — what reaches the admin's phone.
 *
 *   admin_escalate_uncovered  T-15   AD-ESCALATE-UNCONFIRMED
 *   coach_not_onboarded       <48h   AD-COACH-NOT-ONBOARDED
 *   admin_morning_brief              AD-MORNING-BRIEF   (§10.2, synthesised)
 *   admin_evening_digest             AD-EVENING-DIGEST  (§10.2, synthesised)
 *
 * "Two bookends, quiet between" (§7.2). The two bookends are written by the
 * model, not by this file — the digest is not a template with slots. They are
 * **ordinary turns opened by a job** now, rather than a bespoke synthesis call:
 * see `runSynthesis` for why every reason the separate path existed inverted.
 * The other two are the genuine escalations that are allowed to interrupt.
 */

import type { Job } from '@/lib/types'
import type { Tx } from '@/lib/db'
import { now } from '@/lib/clock'
import { runTurn } from '@/lib/agent/loop'
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
      /**
       * A coach who has not onboarded is ONE fact, and this job fires daily.
       *
       * Driven: the admin received the same invite-not-confirmed message two days
       * apart, byte for byte, because nothing had changed — which is precisely
       * why it should not have been sent. The key moves when the state does: they
       * onboard (the job stops), or the set of sessions they are down for inside
       * two days changes, which is a different and genuinely newer problem.
       */
      stateKey:
        `AD-COACH-NOT-ONBOARDED:${coach.person_id}:invited:` +
        upcoming.map((u) => u.starts_at.toISOString()).join(','),
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

/**
 * **Anything new, pending or broken since the last one of these.**
 *
 * @mechanism newsSince — a cheap deterministic census gates the most expensive model call
 *   in the product: an empty census opens no turn and sends nothing, so cost scales with
 *   events rather than with days. The calendar trigger it replaced composed 56 briefs for
 *   a business that received 36 messages in a month, paying eleven queries and a
 *   synthesis call each time for the model to conclude there was nothing to say. The
 *   window runs from the last brief of THIS kind that actually went out
 *   (`suppressed_reason is null`), not from midnight, so a day the brief stayed silent
 *   does not drop its news on the floor.
 *
 * The cheap deterministic half, and the whole reason the expensive half is not
 * paid for. The old shape composed **56 briefs for a business that received 36
 * messages in a month**: a pure calendar trigger, eleven queries and the most
 * expensive model call in the product, twice a day, whether or not anything had
 * happened — and the model then decided, after all of it, that there was nothing
 * to say.
 *
 * An empty census opens no turn and sends nothing. The quiet IS the all-clear,
 * which is what doctrine promises anyway; cost then scales with events rather
 * than with days.
 *
 * Counts only, never content. What is worth saying about a session that ran is a
 * judgement, and the turn below has the tools to look — spoon-feeding it query
 * results it could not verify or widen is how a digest once told the solo coach
 * "I think coaches aren't marking after sessions" *about himself*.
 */
async function newsSince(tx: Tx, academyId: string, since: Date): Promise<Record<string, number>> {
  const [row] = await tx<Record<string, number>[]>`
    select
      (select count(*)::int from message
        where academy_id = ${academyId} and direction = 'inbound'
          and created_at > ${since.toISOString()}::timestamptz)                  as people_wrote_in,
      (select count(*)::int from session
        where academy_id = ${academyId} and status = 'scheduled'
          and ends_at between ${since.toISOString()}::timestamptz and app.now()) as sessions_finished,
      (select count(*)::int from session s
        where s.academy_id = ${academyId} and s.status = 'scheduled'
          and s.ends_at < app.now()
          and not exists (select 1 from attendance a where a.session_id = s.id)) as registers_unmarked,
      (select count(*)::int from session s
        where s.academy_id = ${academyId} and s.status = 'scheduled'
          and s.starts_at between app.now() and app.now() + interval '36 hours'
          and not exists (select 1 from session_coach sc
                           where sc.session_id = s.id and sc.declined_at is null
                             and (sc.confirmed_at is not null or sc.arrived_at is not null)))
                                                                                as sessions_unconfirmed,
      (select count(*)::int from session
        where academy_id = ${academyId} and status = 'cancelled'
          and created_at > ${since.toISOString()}::timestamptz) as sessions_cancelled,
      (select count(*)::int from enrollment
        where academy_id = ${academyId} and created_at > ${since.toISOString()}::timestamptz) as new_enrolments,
      (select count(*)::int from payment
        where academy_id = ${academyId} and created_at > ${since.toISOString()}::timestamptz) as payments_moved,
      (select count(*)::int from tally_line
        where academy_id = ${academyId} and created_at > ${since.toISOString()}::timestamptz) as charges_written,
      (select count(*)::int from message
        where academy_id = ${academyId} and direction = 'outbound'
          and status = 'failed' and created_at > ${since.toISOString()}::timestamptz) as sends_failed,
      (select count(*)::int from pending_request
        where academy_id = ${academyId} and resolved_at is null)                 as questions_outstanding,
      (select count(*)::int from coach
        where academy_id = ${academyId} and status = 'invited')                  as coaches_not_onboarded
  `
  return row ?? {}
}

async function runSynthesis(job: Job, kind: 'brief' | 'digest'): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const nowAt = await now(academyId)

  const plan = await withAcademy(academyId, async (tx) => {
    const a = await loadAcademy(tx, academyId)
    if (!a) skip('academy gone')
    if (a.onboarding_state !== 'live') skip('not live yet')
    const recipients = (await admins(tx, academyId)).filter((r) => r.contact_id)
    if (recipients.length === 0) skip('no admin to tell')

    // Since the last one of THIS kind actually went out — not since midnight.
    // A brief that was silent yesterday leaves yesterday's news unreported, and
    // a window keyed to the calendar would drop it on the floor.
    const [last] = await tx<{ at: Date | null }[]>`
      select max(created_at) as at from message
       where academy_id = ${academyId} and direction = 'outbound'
         and catalog_id = ${kind === 'brief' ? 'AD-MORNING-BRIEF' : 'AD-EVENING-DIGEST'}
         and suppressed_reason is null`
    const since = last?.at ?? new Date(nowAt.getTime() - 24 * 3600_000)
    const news = await newsSince(tx, academyId, since)
    return { academy: a, recipients, news, since }
  })

  const { academy, recipients, news } = plan
  const total = Object.values(news).reduce((n, v) => n + Number(v ?? 0), 0)
  if (total === 0) {
    note(`${kind} for ${isoDate(nowAt, academy.timezone)}: nothing has happened — no turn opened, nothing sent`)
    return
  }

  /**
   * **An ordinary turn, opened by a job.** There is no separate synthesis path
   * any more — no bespoke model call, no dearer model, no toolless prompt fed
   * pre-queried rows.
   *
   * @mechanism runSynthesis — the morning brief and the evening digest are ORDINARY turns
   *   opened by a job, so they share the cached prefix (a hit costs 3.2% of a miss), they
   *   have tools, and they are recorded, guarded and result-honest for free. The bespoke
   *   path could not share the prefix at all, which is how the two most expensive calls of
   *   the day came to cost 3.5× the entire human conversation — and how the two calls with
   *   the widest reach became the two with no record of why they said anything. Being fed
   *   rows it could not verify or widen is how a digest once told the solo coach it thought
   *   "coaches aren't marking after sessions", about himself.
   *
   * Every reason the old path existed inverted under the architecture. The cached
   * prefix is the CHEAP part — a hit costs 3.2% of a miss — so an ordinary turn on
   * the conversation model costs less than the bespoke call did, and the bespoke
   * path could not share the prefix at all, which is how the two most expensive
   * calls of the day came to cost 3.5× the entire human conversation while caching
   * at half the rate. As a turn it has TOOLS, which fixes a real defect class: the
   * old synth was spoon-fed query results it could not verify or widen. As a turn
   * it is recorded, guarded and result-honest for free — the two most expensive
   * calls of the day stop being the two with no record of why they said anything.
   * And the doctrine constraint dies with the path: nothing needs to be "true on
   * the toolless path too" when there is no toolless path.
   */
  const first = recipients[0]
  await runTurn({
    contactId: first.contact_id as string,
    source: 'job',
    task: {
      instruction:
        `Send it with catalog_id "${kind === 'brief' ? 'AD-MORNING-BRIEF' : 'AD-EVENING-DIGEST'}" — that is ` +
        `what marks it as this moment, and what stops the next one counting news you have already reported. ` +
        (kind === 'brief'
          ? `Write ${firstName(first.full_name)} their morning brief, as a reply to them. Lead with what will ` +
            `go wrong today if nobody acts. If that is nothing, say so in one line — or send nothing at all, ` +
            `which is a real and common answer. Then, only if it is worth their attention, what today looks ` +
            `like. Read what the sentences need; the counts below are only what changed, not the content.`
          : `Write ${firstName(first.full_name)} tonight's digest, as a reply to them. Lead with the one thing ` +
            `worth looking at and what you think is behind it, with the uncertainty stated. Then the day in a ` +
            `line or two. Then how the messaging itself went — they will never think to ask. Then who is ` +
            `unpaid. Drop any section that would be filler. Read what the sentences need; the counts below ` +
            `are only what changed.`),
      queryResults: { changed_since_the_last_one: news, note: 'Counts, not content. Look at whatever these point at.' },
      // The instruction two lines up asks for words. See `askedForAMessage`
      // (lib/agent/loop.ts) for what happened while this went undeclared.
      asked: 'a message',
    },
  })
  note(`${kind} for ${isoDate(nowAt, academy.timezone)}: opened a turn — ${total} thing(s) had changed`)
}

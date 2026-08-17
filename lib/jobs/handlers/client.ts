/**
 * lib/jobs/handlers/client.ts — the parent's day (§9.2) and the one staged
 * onboarding send (§9.1 rule 6).
 *
 *   client_reminder         CL-REMINDER
 *   client_session_trouble  CL-SESSION-TROUBLE
 *   client_outcome          CL-OUTCOME
 *   first_contact_batch     CL-FIRST-CONTACT, ten at a time
 *
 * The rule that shapes all of it: a parent is told when the session is in
 * trouble, not when it is fine (§9.2). There is no "class is starting" message
 * and there never will be — a parent standing at the court does not need it,
 * and it spends frequency budget on a shared number to say nothing.
 */

import type { Job } from '@/lib/types'
import type { Tx } from '@/lib/db'
import { now } from '@/lib/clock'
import { composeAndSend } from '@/lib/messaging/compose'
import { LIMITS } from '@/lib/messaging/types'
import { dedupe, FIRST_CONTACT_BATCH_SIZE, FIRST_CONTACT_GAP_MINUTES } from '../kinds'
import { enqueue } from '../enqueue'
import {
  admins, assignedCoaches, buttonTitle, clamp, dayLabel, enrolledPlayers, firstName,
  isCovered, isoDate, joinLines, loadAcademy, loadSession, need, note, payloadOf,
  serviceCtx, skip, timeLabel, whenLabel, withAcademy,
} from '../util'

/**
 * `client_reminder` — CL-REMINDER (§9.2).
 *
 * Fired at `client_reminder_lead_hours` before, with the same per-person
 * override as the coach ladder: a parent who needs a day's notice gets a day
 * (§8.2). The lead is applied by `planAhead`, which is what decided *when* this
 * job runs; the handler's job is to check the world still warrants it.
 */
export async function clientReminder(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const sessionId = need(p, 'session_id')
  const playerId = need(p, 'player_id')
  const nowAt = await now(academyId)

  const plan = await withAcademy(academyId, async (tx) => {
    /**
     * §13 rule 2, applied to this job's OWN row: a sibling's reminder may have
     * merged this one away after the runner claimed the whole due batch — the
     * claim marks every due job 'running' in one update before any handler
     * runs, so the merge below cancels 'running' rows as well as 'pending'
     * ones, and the cancelled handler finds out here rather than sending the
     * duplicate the merge exists to prevent (review find: with pending-only
     * targeting, same-batch siblings — the COMMON case, identical run_at —
     * never merged at all).
     */
    const [self] = await tx<{ status: string }[]>`select status from job where id = ${job.id}`
    if (self?.status === 'cancelled') skip('merged into a sibling reminder')

    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    if (academy.onboarding_state !== 'live') skip('not live yet')

    const session = await loadSession(tx, sessionId)
    if (!session) skip('session gone')
    if (session.status !== 'scheduled') skip(`session is ${session.status}`)
    if (session.starts_at.getTime() <= nowAt.getTime()) skip('session has already started')

    // Already cancelled, already marked — nothing left to remind about.
    const [marked] = await tx<{ n: number }[]>`
      select count(*)::int as n from attendance
       where session_id = ${sessionId} and player_id = ${playerId}
    `
    if ((marked?.n ?? 0) > 0) skip('attendance already recorded for this player')

    const date = isoDate(session.starts_at, academy.timezone)
    const roster = await enrolledPlayers(tx, academyId, session.class_id, date)
    const player = roster.find((r) => r.player_id === playerId)
    if (!player) skip('player is no longer enrolled in this class')
    if (!player.contact_id) skip('no reachable number for this family')

    /**
     * Rule 7 — siblings in one class are one message, not one per child. The
     * ideal's own sentence is "you'll get one message, not two", and the month
     * drive shipped the opposite: "Kabir has a class coming up" / "Ishaan has a
     * class coming up" to the same mother, two seconds apart, twice a week.
     * The jobs are per (session, player) for idempotency's sake, so the merge
     * happens where the first one fires: any sibling of this class whose own
     * reminder is still pending rides this message, and their job is cancelled
     * in the same transaction — a sibling whose job already ran (or whose
     * attendance is marked) is left alone.
     */
    const together = [player]
    for (const s of roster) {
      if (s.player_id === playerId || s.contact_id !== player.contact_id) continue
      const [smarked] = await tx<{ n: number }[]>`
        select count(*)::int as n from attendance
         where session_id = ${sessionId} and player_id = ${s.player_id}`
      if ((smarked?.n ?? 0) > 0) continue
      const cancelled = await tx<{ id: string }[]>`
        update job set status = 'cancelled'
         where status in ('pending', 'running') and kind = 'client_reminder'
           and dedupe_key = ${dedupe.clientReminder(sessionId, s.player_id)}
           and id <> ${job.id}
         returning id`
      if (cancelled.length) together.push(s)
    }

    return { academy, session, player, together }
  })

  const { academy, session, player, together } = plan
  const tz = academy.timezone
  const venue = session.venue_name ? `, ${session.venue_name}` : ''
  const names = together.map((k) => firstName(k.player_name))
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

  await composeAndSend(serviceCtx(academy.id), {
    toContactId: player.contact_id as string,
    header: clamp(academy.name, LIMITS.headerChars),
    body: clamp(
      `${who} ${names.length === 1 ? 'has' : 'have'} ${session.class_name} `
      + `${whenLabel(session.starts_at, tz, nowAt)}${venue}.`,
      LIMITS.bodyChars,
    ),
    buttons: [
      {
        title: buttonTitle(names.length === 1 ? "I'll be there" : "We'll be there"),
        action: { kind: 'noop', ack: 'Noted — see you there.' },
      },
      {
        // Confirms before it acts: a pocket mis-tap must never give away a seat
        // (§9.2). The agent raises CL-CANCEL-CONFIRM on the way through — and
        // with more than one child on the message, deciding which one is the
        // model's disambiguation job (§8.2), not a guess minted here.
        title: buttonTitle("Can't make it"),
        action: {
          kind: 'reply',
          text: names.length === 1
            ? `${names[0]} can't make ${session.class_name} `
              + `${dayLabel(session.starts_at, tz, nowAt)} at ${timeLabel(session.starts_at, tz)}`
            : `About ${session.class_name} ${dayLabel(session.starts_at, tz, nowAt)} at ${timeLabel(session.starts_at, tz)} — one of them can't make it`,
        },
      },
    ],
    catalogId: 'CL-REMINDER',
    subjectPersonIds: together.map((k) => k.player_person_id),
  })
  note(`reminded ${player.holder_name} about ${who}'s ${session.class_name}`)
}

/**
 * `client_session_trouble` at `starts_at` — CL-SESSION-TROUBLE (§9.2, §12.1).
 *
 * Runs for every session and sends for almost none of them. It only speaks when
 * it carries something the parent does not already have: the coach is late, or
 * the session is uncovered as it starts. The claim ladder governs the wording —
 * "starting" is assumed, "has arrived" is the stronger claim we have evidence
 * for, and neither is worth a message on its own.
 */
export async function clientSessionTrouble(job: Job): Promise<void> {
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

    const coaches = await assignedCoaches(tx, sessionId)
    const late = coaches.filter((c) => c.running_late && !c.declined_at)
    const covered = await isCovered(tx, sessionId)
    // The only two reasons to speak: someone is late, or nobody is coming.
    if (covered && late.length === 0) skip('session is fine — nothing a parent needs')

    const roster = await enrolledPlayers(
      tx, academyId, session.class_id, isoDate(session.starts_at, academy.timezone),
    )
    if (roster.length === 0) skip('nobody enrolled')

    return { academy, session, late, covered, roster }
  })

  const { academy, session, late, covered, roster } = plan
  const tz = academy.timezone
  const at = timeLabel(session.starts_at, tz)

  let sent = 0
  for (const r of roster) {
    if (!r.contact_id) continue
    const who = firstName(r.player_name)
    const body = late.length > 0
      ? `${firstName(late[0].full_name)} is running late for ${who}'s ${session.class_name} at ${at}. `
        + `I'll let you know as soon as they're there.`
      : `We're still sorting out a coach for ${who}'s ${session.class_name} at ${at}. `
        + `I'll come back to you as soon as it's settled.`

    const outcome = await composeAndSend(serviceCtx(academy.id), {
      toContactId: r.contact_id,
      header: clamp(academy.name, LIMITS.headerChars),
      body: clamp(body, LIMITS.textChars),
      catalogId: 'CL-SESSION-TROUBLE',
      subjectPersonIds: [r.player_person_id],
      /**
       * One family, one class, one state — told once while it lasts.
       *
       * Meera was told "we're still sorting out a coach" twice, about two
       * sessions of the same class in the same unresolved state, and both were
       * true. Rule 7 is one event, one person, one message, and the event here is
       * the CLASS being uncovered rather than each session of it being uncovered
       * in turn. Keyed on the class rather than the session for exactly that; the
       * lateness case is a different state and says so.
       */
      stateKey:
        `CL-SESSION-TROUBLE:${session.class_id}:${r.player_person_id}:` +
        (late.length > 0 ? `late:${late[0].coach_id}` : 'uncovered'),
    })
    if (outcome.status === 'queued' || outcome.status === 'sent') sent++
  }
  note(
    `${late.length > 0 ? 'coach late' : 'uncovered'} at ${at} — ${sent} famil${sent === 1 ? 'y' : 'ies'} told`
    + (covered ? '' : ' (no confirmed coach)'),
  )
}

/**
 * `client_outcome` — CL-OUTCOME (§12.1), enqueued when attendance is marked.
 *
 * An absence arrives as something to fix — `[Rebook]` — not a verdict (§9.2).
 * A timely cancellation is not an outcome worth a message: the parent told us.
 */
export async function clientOutcome(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const sessionId = need(p, 'session_id')
  const playerId = need(p, 'player_id')
  const nowAt = await now(academyId)

  const plan = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    if (academy.onboarding_state !== 'live') skip('not live yet')

    const session = await loadSession(tx, sessionId)
    if (!session) skip('session gone')
    if (session.status === 'cancelled') skip('session cancelled')

    const [att] = await tx<{ status: string; note: string | null; marked_by_coach_id: string | null }[]>`
      select status, note, marked_by_coach_id from attendance
       where session_id = ${sessionId} and player_id = ${playerId}
    `
    if (!att) skip('attendance not marked (yet)')
    if (att.status === 'cancelled_timely') skip('cancelled in time — nothing to report')
    // An absence nobody marked is the family's own notice: `client_cancel`
    // writes it when a parent cancels inside the window. Reporting it back —
    // "Aarav missed Beginners", the parent's own reason relabelled "Coach's
    // note" — tells a family what they told us, as a verdict, with a false
    // attribution (driven, month drive day 3). Same rule as the timely case:
    // the parent told us, so there is nothing to report.
    if (att.status === 'absent' && !att.marked_by_coach_id) skip('the family cancelled it themselves — they know')

    const roster = await enrolledPlayers(
      tx, academyId, session.class_id, isoDate(session.starts_at, academy.timezone),
    )
    const player = roster.find((r) => r.player_id === playerId)
    if (!player) skip('player is no longer on this roster')
    if (!player.contact_id) skip('no reachable number for this family')

    // "Stop the recaps" as a setting, not a memory (TIMING_KEYS): a truthy
    // The outcome mute is a `comm_preference` row now, read at the send path for
    // every category rather than here for this one (0032). What that buys: a
    // family who asked to hear nothing after class is answered by the same
    // machinery as a family who asked to hear nothing about money, and the model
    // can see both by reading a table instead of guessing at a settings key.

    // Rule 7 — one event, one family, one message. Two children marked in the
    // same register produced two "how the session went" messages in the same
    // minute (driven, month drive day 3). The whole family's marked outcomes
    // travel in one body, and the idempotency key below makes the sibling's
    // own job a no-op. The rare loser: a sibling marked in a later pass rides
    // the next thing this family is told — one message per event wins.
    const familyIds = roster.filter((r) => r.contact_id === player.contact_id).map((r) => r.player_id)
    const familyAtt = await tx<
      { player_id: string; status: string; note: string | null; marked_by_coach_id: string | null }[]
    >`
      select player_id, status, note, marked_by_coach_id from attendance
       where session_id = ${sessionId} and player_id = any(${familyIds})
    `
    const members = familyAtt
      // The same two silences as above, applied per child: a timely cancel and
      // the family's own out-of-window notice are things they told us.
      .filter((a) => a.status !== 'cancelled_timely' && !(a.status === 'absent' && !a.marked_by_coach_id))
      .map((a) => {
        const r = roster.find((x) => x.player_id === a.player_id)
        return {
          name: firstName(r?.player_name ?? 'They'),
          person_id: r?.player_person_id ?? player.player_person_id,
          status: a.status,
          note: a.note,
        }
      })
    if (!members.length) skip('nothing this family was not already told')

    return { academy, session, player, members }
  })

  const { academy, session, player, members } = plan
  const tz = academy.timezone
  const when = dayLabel(session.starts_at, tz, nowAt)

  const lineFor = (m: (typeof members)[number]): string =>
    m.status === 'absent'
      ? `${m.name} missed ${session.class_name} ${when}.`
      : m.status === 'late'
        ? `${m.name} made it to ${session.class_name} ${when}, a little late.`
        : `${m.name} was at ${session.class_name} ${when}.`

  // One register note usually applies to everyone marked; say it once. Distinct
  // notes are rare enough to name.
  const notes = [...new Set(members.map((m) => m.note).filter(Boolean))] as string[]
  const noteLines =
    notes.length === 1
      ? [`Coach's note: ${notes[0]}`]
      : members.filter((m) => m.note).map((m) => `Coach's note for ${m.name}: ${m.note}`)

  const absentees = members.filter((m) => m.status === 'absent')
  await composeAndSend(serviceCtx(academy.id), {
    toContactId: player.contact_id as string,
    header: clamp(academy.name, LIMITS.headerChars),
    body: clamp(joinLines([...members.map(lineFor), ...noteLines]), LIMITS.bodyChars),
    buttons: absentees.length
      ? [{
          title: buttonTitle('Rebook'),
          action: {
            kind: 'reply',
            text: `Rebook ${absentees.map((m) => m.name).join(' and ')}'s missed ${session.class_name}`,
          },
        }]
      : undefined,
    catalogId: 'CL-OUTCOME',
    subjectPersonIds: [...new Set(members.map((m) => m.person_id))],
    idempotencyKey: `outcome:${sessionId}:${player.contact_id}`,
  })
  note(`outcome sent for ${members.map((m) => m.name).join(', ')} — ${members.map((m) => m.status).join('/')}`)
}

type FirstContactSignals = { sent_so_far: number; failed: number; landed: number; opted_out: number }

async function firstContactSignals(tx: Tx, academyId: string): Promise<FirstContactSignals> {
  const [row] = await tx<FirstContactSignals[]>`
    select
      (count(*) filter (where m.direction = 'outbound'))::int                      as sent_so_far,
      (count(*) filter (where m.status = 'failed'))::int                           as failed,
      (count(*) filter (where m.status in ('delivered', 'read')))::int             as landed,
      (count(distinct c.id) filter (where c.opted_out_at is not null))::int        as opted_out
      from message m join contact c on c.id = m.contact_id
     where m.academy_id = ${academyId} and m.catalog_id = 'CL-FIRST-CONTACT'
  `
  return row ?? { sent_so_far: 0, failed: 0, landed: 0, opted_out: 0 }
}

/**
 * `first_contact_batch` — CL-FIRST-CONTACT, staged (§9.1 rule 6).
 *
 * "10, check delivery, read and block signals, then the rest in batches,
 * halting on a bad signal. Not a campaign system: for a forty-family academy
 * this is two batches." The halt is the point of the whole job — a number that
 * is failing or being blocked stops the run and tells the admin, rather than
 * spending the shared number's reputation finding out (§16.1).
 */
export async function firstContactBatch(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const batchN = typeof p.batch_n === 'number' ? p.batch_n : Number(p.batch_n ?? 1) || 1
  const nowAt = await now(academyId)

  const plan = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    // §2.6 — nothing is sent during onboarding until the admin says go.
    if (academy.onboarding_state !== 'live') skip('not live yet')

    const signals = await firstContactSignals(tx, academyId)
    const bad =
      signals.failed > 0 ? 'a message failed to deliver'
      : signals.opted_out > 0 ? 'someone asked to stop'
      : (batchN > 1 && signals.sent_so_far > 0 && signals.landed === 0) ? 'nothing is landing'
      : null

    const adminRows = (await admins(tx, academyId)).filter((a) => a.contact_id)

    if (bad) return { halted: bad, academy, adminRows, batch: [] as ContactTarget[], remaining: 0 }

    const batch = await tx<ContactTarget[]>`
      select ct.id as contact_id, ct.person_id, pe.full_name as holder_name,
             nx.player_person_id, nx.player_name, nx.class_name, nx.starts_at, nx.venue_name
        from contact ct
        join person pe on pe.id = ct.person_id
        join lateral (
          select pp.id as player_person_id, pp.full_name as player_name, cl.name as class_name,
                 s.starts_at, v.name as venue_name
            from account a
            join player pl on pl.account_id = a.id and pl.active
            join person pp on pp.id = pl.person_id
            join enrollment e on e.player_id = pl.id
             and (e.ended_on is null or e.ended_on >= (app.now() at time zone ${academy.timezone})::date)
            join session s on s.class_id = e.class_id and s.status = 'scheduled'
            join class cl on cl.id = s.class_id
            left join venue v on v.id = coalesce(s.venue_id, cl.venue_id)
           where a.academy_id = ct.academy_id and a.holder_person_id = ct.person_id
             and s.starts_at between app.now() and app.now() + interval '48 hours'
           order by s.starts_at asc
           limit 1
        ) nx on true
       where ct.academy_id = ${academyId}
         and ct.opted_out_at is null
         and ct.state = 'registered'
         and not exists (
           select 1 from message m
            where m.contact_id = ct.id and m.direction = 'outbound'
         )
       order by nx.starts_at asc, ct.created_at asc
       limit ${FIRST_CONTACT_BATCH_SIZE + 1}
    `

    return {
      halted: null as string | null,
      academy,
      adminRows,
      batch: batch.slice(0, FIRST_CONTACT_BATCH_SIZE),
      remaining: Math.max(0, batch.length - FIRST_CONTACT_BATCH_SIZE),
    }
  })

  const { halted, academy, adminRows, batch, remaining } = plan

  if (halted) {
    for (const a of adminRows) {
      await composeAndSend(serviceCtx(academy.id), {
        toContactId: a.contact_id as string,
        header: clamp(academy.name, LIMITS.headerChars),
        body: `I've paused the introductions to families — ${halted}. `
          + `Nothing more goes out until you say so.`,
        buttons: [
          { title: buttonTitle('Carry on'), action: { kind: 'reply', text: 'Carry on with the family introductions' } },
          { title: buttonTitle('Leave it'), action: { kind: 'noop', ack: 'Left as is.' } },
        ],
      })
    }
    note(`first contact halted: ${halted}`)
    return
  }

  if (batch.length === 0) skip('nobody left to introduce ourselves to')

  const tz = academy.timezone
  let sent = 0
  for (const t of batch) {
    const venue = t.venue_name ? ` at ${t.venue_name}` : ''
    const outcome = await composeAndSend(serviceCtx(academy.id), {
      toContactId: t.contact_id,
      header: clamp(academy.name, LIMITS.headerChars),
      body: clamp(joinLines([
        // Rule 1: the recognised names do the trust work. Rule 2: say something
        // only the real place could know. Rule 4: continuity, never launch.
        `Hi ${firstName(t.holder_name)} — I'm the class manager for ${academy.name}.`,
        `${firstName(t.player_name)} has ${t.class_name} ${whenLabel(t.starts_at, tz, nowAt)}${venue}.`,
        `Class updates and cancellations come through here from now on.`,
      ]), LIMITS.bodyChars),
      buttons: [
        {
          title: buttonTitle('See schedule'),
          action: { kind: 'reply', text: `Show me ${firstName(t.player_name)}'s schedule` },
        },
        {
          title: buttonTitle('Stop these'),
          action: { kind: 'reply', text: 'Stop sending me these messages' },
        },
      ],
      catalogId: 'CL-FIRST-CONTACT',
      // The player, not the holder — see `player_person_id` on ContactTarget.
      subjectPersonIds: [t.player_person_id],
    })
    if (outcome.status === 'queued' || outcome.status === 'sent') sent++
  }
  note(`first contact batch ${batchN}: ${sent}/${batch.length} sent, ${remaining > 0 ? 'more to come' : 'that was the last of them'}`)

  if (remaining > 0) {
    await enqueue(
      'first_contact_batch',
      new Date(nowAt.getTime() + FIRST_CONTACT_GAP_MINUTES * 60_000),
      dedupe.firstContactBatch(academyId, batchN + 1),
      { academy_id: academyId, batch_n: batchN + 1 },
      academyId,
    )
  }
}

type ContactTarget = {
  contact_id: string
  person_id: string
  /**
   * The *player's* person, which is who this message is about. `person_id` is the
   * holder's, and passing that as the subject is the same as passing nothing:
   * `subjectName` drops any id equal to the recipient and falls back to their own name.
   * So the first message three parents ever received opened *"Ace TT Academy: Latha has
   * a session coming up"* — the parent named where the child belongs, which is the exact
   * render `subjectName` was written to stop.
   */
  player_person_id: string
  holder_name: string
  player_name: string
  class_name: string
  starts_at: Date
  venue_name: string | null
}

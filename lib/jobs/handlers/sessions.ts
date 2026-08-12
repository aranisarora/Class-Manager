/**
 * lib/jobs/handlers/sessions.ts — sessions existing, and the register that
 * closes them.
 *
 *   materialize_sessions  §13, §19 phase 3
 *   post_class_register   §8.2 step 5, CO-REGISTER
 *   register_expiry       §12.3 "expires 2h -> admin", AD-REGISTER-MISSING
 */

import { DateTime } from 'luxon'
import type { Job } from '@/lib/types'
import { now } from '@/lib/clock'
import { composeAndSend } from '@/lib/messaging/compose'
import { LIMITS } from '@/lib/messaging/types'
import { dedupe, HORIZON_DAYS } from '../kinds'
import { cancelSessionJobs, enqueue } from '../enqueue'
import {
  admins, assignedCoaches, atTimeOn, buttonTitle, clamp, dayLabel, enrolledPlayers,
  isoDate, joinLines, leadFor, loadAcademy, loadSession, need, note, payloadOf,
  serviceCtx, skip, spanLabel, timeLabel, withAcademy, zoned,
} from '../util'

type ClassRow = {
  id: string
  name: string
  starts_on: string
  ends_on: string | null
  active: boolean
}

type SlotRow = { weekday: number; start_time: string; end_time: string }

/** luxon counts Monday=1..Sunday=7; the schema counts 0=Sun..6=Sat (§6.3). */
function weekdayOf(dt: DateTime): number {
  return dt.weekday === 7 ? 0 : dt.weekday
}

/**
 * `materialize_sessions` — a rolling ~3-week horizon from `class_slot`.
 *
 * `unique (class_id, starts_at)` is what makes this idempotent: running it
 * twice writes nothing the second time. Editing a slot rematerialises the
 * future **without losing cancellations or marked attendance** (§19 phase 3),
 * which is why the orphan sweep below refuses to delete anything cancelled,
 * anything with attendance, and anything a tally line already points at.
 */
export async function materializeSessions(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const classId = need(p, 'class_id')
  const nowAt = await now()

  const deleted = await withAcademy(academyId, async (tx) => {
    // ---- precondition, re-checked at run time (§13 rule 2) -------------------
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    const [cls] = await tx<ClassRow[]>`
      select id, name, starts_on::text as starts_on, ends_on::text as ends_on, active
        from class where id = ${classId} and academy_id = ${academyId}
    `
    if (!cls) skip('class gone')
    if (!cls.active) skip('class inactive')

    const tz = academy.timezone
    const today = zoned(nowAt, tz).startOf('day')
    const todayIso = today.toFormat('yyyy-MM-dd')
    if (cls.ends_on && cls.ends_on < todayIso) skip('class ended')

    const slots = await tx<SlotRow[]>`
      select weekday, start_time::text as start_time, end_time::text as end_time
        from class_slot where class_id = ${classId} and academy_id = ${academyId}
       order by weekday, start_time
    `
    if (slots.length === 0) skip('class has no slots')

    // ---- what the slots say the next three weeks look like -------------------
    const wanted: { startsAt: Date; endsAt: Date }[] = []
    for (let d = 0; d <= HORIZON_DAYS; d++) {
      const day = today.plus({ days: d })
      const dayIso = day.toFormat('yyyy-MM-dd')
      if (dayIso < cls.starts_on) continue
      if (cls.ends_on && dayIso > cls.ends_on) continue
      for (const slot of slots) {
        if (slot.weekday !== weekdayOf(day)) continue
        const startsAt = atTimeOn(dayIso, slot.start_time, tz)
        let endsAt = atTimeOn(dayIso, slot.end_time, tz)
        // A slot that ends before it starts is an overnight one, not a typo.
        if (endsAt.getTime() <= startsAt.getTime()) {
          endsAt = DateTime.fromJSDate(endsAt).setZone(tz).plus({ days: 1 }).toJSDate()
        }
        wanted.push({ startsAt, endsAt })
      }
    }

    const startIso = wanted.map((w) => w.startsAt.toISOString())
    const endIso = wanted.map((w) => w.endsAt.toISOString())
    const horizonEnd = today.plus({ days: HORIZON_DAYS }).endOf('day').toJSDate().toISOString()

    const created = wanted.length === 0 ? [] : await tx<{ id: string }[]>`
      insert into session (academy_id, class_id, starts_at, ends_at)
      select ${academyId}::uuid, ${classId}::uuid, w.st::timestamptz, w.en::timestamptz
        from unnest(${startIso}::text[], ${endIso}::text[]) as w(st, en)
      on conflict (class_id, starts_at) do nothing
      returning id
    `

    // A slot whose end_time moved leaves the start alone: fix the tail in place
    // rather than deleting a session someone may already have confirmed.
    const retimed = wanted.length === 0 ? [] : await tx<{ id: string }[]>`
      update session s set ends_at = w.en::timestamptz
        from unnest(${startIso}::text[], ${endIso}::text[]) as w(st, en)
       where s.class_id = ${classId}
         and s.starts_at = w.st::timestamptz
         and s.ends_at <> w.en::timestamptz
         and s.status = 'scheduled'
         and s.starts_at > app.now()
      returning s.id
    `

    // ---- the orphan sweep ----------------------------------------------------
    // Only future, only inside the horizon we just rewrote, only untouched:
    // a cancelled session stays cancelled, a marked one stays marked, and a
    // session someone has already been billed for is never removed.
    const gone = await tx<{ id: string }[]>`
      delete from session s
       where s.academy_id = ${academyId}
         and s.class_id = ${classId}
         and s.status = 'scheduled'
         and s.starts_at > app.now()
         and s.starts_at <= ${horizonEnd}::timestamptz
         and s.starts_at <> all (${startIso}::text[]::timestamptz[])
         and not exists (select 1 from attendance a where a.session_id = s.id)
         and not exists (select 1 from tally_line t where t.session_id = s.id)
      returning s.id
    `

    // ---- the coach set -------------------------------------------------------
    // session_coach is the ACTUAL set and class_coach is the DEFAULT one (§6.3);
    // new sessions inherit, and a class_coach added later backfills forward.
    await tx`
      insert into session_coach (academy_id, session_id, coach_id)
      select ${academyId}::uuid, s.id, cc.coach_id
        from session s
        join class_coach cc on cc.class_id = s.class_id
        join coach co on co.id = cc.coach_id
       where s.class_id = ${classId}
         and s.academy_id = ${academyId}
         and s.status = 'scheduled'
         and s.starts_at > app.now()
         and co.status <> 'ended'
         and (co.ended_on is null or co.ended_on >= (s.starts_at at time zone ${tz})::date)
      on conflict (session_id, coach_id) do nothing
    `

    note(
      `${cls.name}: +${created.length} session(s), ${retimed.length} retimed, ${gone.length} removed`,
    )
    return gone.map((g) => g.id)
  })

  // A session that no longer exists must not leave a ladder behind (§13 rule 4).
  for (const sessionId of deleted) await cancelSessionJobs(sessionId)
}

/**
 * `post_class_register` at `ends_at` — CO-REGISTER (§8.2 step 5).
 *
 * `[All present]` is a chat button carrying the fully resolved roster, so the
 * majority case is one tap and no model call (§2.2, §6.5). `[Take register]`
 * goes back through the agent, which mints the register page (§15).
 */
export async function postClassRegister(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const sessionId = need(p, 'session_id')
  const nowAt = await now()

  const plan = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    const session = await loadSession(tx, sessionId)
    if (!session) skip('session gone')
    if (session.status === 'cancelled') skip('session cancelled')
    if (nowAt.getTime() < session.ends_at.getTime()) skip('class has not finished')

    const [marked] = await tx<{ n: number }[]>`
      select count(*)::int as n from attendance where session_id = ${sessionId}
    `
    if ((marked?.n ?? 0) > 0) skip('register already marked')

    const coaches = (await assignedCoaches(tx, sessionId)).filter((c) => c.declined_at === null)
    if (coaches.length === 0) skip('nobody was assigned to this session')

    const roster = await enrolledPlayers(
      tx, academyId, session.class_id, isoDate(session.starts_at, academy.timezone),
    )
    if (roster.length === 0) skip('nobody enrolled')

    // Whoever actually took it, if we know; otherwise everyone still assigned.
    const answered = coaches.filter((c) => c.confirmed_at !== null || c.arrived_at !== null)
    const askThese = answered.length > 0 ? answered : coaches

    return { academy, session, roster, askThese }
  })

  const { academy, session, roster, askThese } = plan
  const tz = academy.timezone
  const playerIds = roster.map((r) => r.player_id)
  const when = `${dayLabel(session.starts_at, tz, nowAt)} ${spanLabel(session.starts_at, session.ends_at, tz)}`

  let sent = 0
  for (const coach of askThese) {
    if (!coach.contact_id) continue
    const outcome = await composeAndSend(serviceCtx(academy.id), {
      toContactId: coach.contact_id,
      header: clamp(academy.name, LIMITS.headerChars),
      body: clamp(joinLines([
        `${session.class_name} — ${when}. Who was there?`,
        `${roster.length} on the roster: ${roster.map((r) => r.player_name).join(', ')}`,
      ]), LIMITS.bodyChars),
      buttons: [
        {
          title: buttonTitle('All present'),
          action: {
            kind: 'operation',
            op: 'mark_attendance',
            args: {
              session_id: session.id,
              entries: playerIds.map((player_id) => ({ player_id, status: 'present' })),
            },
          },
        },
        {
          title: buttonTitle('Take register'),
          action: { kind: 'reply', text: `Take the register for ${session.class_name}, ${when}` },
        },
      ],
      catalogId: 'CO-REGISTER',
      subjectPersonIds: [coach.person_id],
    })
    if (outcome.status === 'queued' || outcome.status === 'sent') sent++
  }
  note(`register asked of ${sent} coach(es) for ${session.class_name}`)

  // §12.3 — "expires 2h -> admin".
  const expiryHours = leadFor('registerExpiryHours', null, academy, null)
  await enqueue(
    'register_expiry',
    new Date(session.ends_at.getTime() + expiryHours * 3600_000),
    dedupe.registerExpiry(session.id),
    { academy_id: academy.id, session_id: session.id },
    academy.id,
  )
}

/**
 * `register_expiry` at `ends_at` + 2h — AD-REGISTER-MISSING (§12.4).
 *
 * The escalation is about the *session*, never about the coach (§6.3), but it
 * carries the coach as its subject so the send path can refuse to escalate
 * about someone to themselves (§18 rule 2) — which is how the solo admin never
 * gets told off for their own unmarked register.
 */
export async function registerExpiry(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const sessionId = need(p, 'session_id')
  const nowAt = await now()

  const plan = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    const session = await loadSession(tx, sessionId)
    if (!session) skip('session gone')
    if (session.status === 'cancelled') skip('session cancelled')

    const [marked] = await tx<{ n: number }[]>`
      select count(*)::int as n from attendance where session_id = ${sessionId}
    `
    if ((marked?.n ?? 0) > 0) skip('register was marked')

    const coaches = (await assignedCoaches(tx, sessionId)).filter((c) => c.declined_at === null)
    const recipients = (await admins(tx, academyId)).filter((a) => a.contact_id)
    if (recipients.length === 0) skip('no admin to tell')

    return { academy, session, coaches, recipients }
  })

  const { academy, session, coaches, recipients } = plan
  const tz = academy.timezone
  const when = `${dayLabel(session.starts_at, tz, nowAt)} ${timeLabel(session.starts_at, tz)}`

  for (const admin of recipients) {
    await composeAndSend(serviceCtx(academy.id), {
      toContactId: admin.contact_id as string,
      header: clamp(academy.name, LIMITS.headerChars),
      body: clamp(
        `The register for ${session.class_name} (${when}) still isn't marked.`,
        LIMITS.bodyChars,
      ),
      buttons: [{
        title: buttonTitle('Mark it myself'),
        action: { kind: 'reply', text: `Mark the register for ${session.class_name}, ${when}` },
      }],
      catalogId: 'AD-REGISTER-MISSING',
      isEscalation: true,
      subjectPersonIds: coaches.map((c) => c.person_id),
    })
  }
  note(`register missing for ${session.class_name} (${when}) — ${recipients.length} admin(s) told`)
}

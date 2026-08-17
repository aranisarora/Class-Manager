/**
 * drive-week — one clean week in a real-shaped academy, every persona equally.
 *
 *   npx tsx scripts/drive-week.ts                 # the whole week
 *   npx tsx scripts/drive-week.ts --days 3        # stop early
 *   npx tsx scripts/drive-week.ts --keep          # leave the world behind to poke at
 *
 * WHY A WEEK, AND WHY THIS SHAPE
 * -----------------------------------------------------------------------------
 * `probe-model`'s arc walks a business through its LIFECYCLE — onboarding, first
 * coach, go-live, first money — which is the right instrument for "does the
 * product work at all" and the wrong one for "what is it like to be served by
 * this thing on an ordinary Tuesday". Nothing here had ever driven a settled
 * business through a plain week with the standing jobs firing on their own
 * schedule, which is the state a real academy is in for all but its first
 * fortnight.
 *
 * The business is the one this product is actually sold into, and it is a shape
 * a role column cannot express: **the owner coaches.** Rahul runs the academy AND
 * takes two of its four classes, so he holds an `academy_admin` row and a `coach`
 * row over one `person`. Two coaches work under him. Every permission question
 * worth asking lives in that gap — what Arjun may see of Priya's money, what
 * Rahul sees as owner that he would not see as coach, and whether the product
 * ever confuses the two hats on one head.
 *
 * EQUAL ACROSS PERSONAS
 * -----------------------------------------------------------------------------
 * Turn counts are balanced by construction and asserted before the run starts:
 * an equal number of turns as the admin, as a coach, as a paying family, and as
 * a stranger. That is deliberate and it is not what a natural week looks like —
 * a real week is mostly admin. But an unbalanced drive reports the admin's
 * experience as though it were the product's, and three of the last drive's open
 * findings were on a phone with no role attached to it.
 *
 * WHAT IT RECORDS
 * -----------------------------------------------------------------------------
 * Everything, untruncated: every SQL statement the model wrote (via
 * `lib/agent/sql-trace.ts`, which sees the write half a flight recorder cannot),
 * every round's reasoning, every message anybody received — from a turn OR from a
 * standing job — and the state of the world at the end of each day.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { loadEnvFiles, c } from './_env'

loadEnvFiles()
process.env.TRANSPORT = 'emulator'

const { createAcademy, createTestContact, dropAcademy, inboundFromContact, worldAcademyIds } =
  await import('@/lib/seed')
const { withSession } = await import('@/lib/db')
const { captureSql } = await import('@/lib/agent/sql-trace')
type SqlRecord = import('@/lib/agent/sql-trace').SqlRecord
const clock = await import('@/lib/clock')
const { HANDLERS, JobSkip, planAheadFor } = await import('@/lib/jobs')
const { msOf } = await import('@/lib/jobs/util')
const { costInr } = await import('@/lib/pricing')
const { env } = await import('@/lib/env')

const argv = process.argv.slice(2)
const flag = (n: string): string | undefined => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return undefined
  const f = argv[i] as string
  if (f.includes('=')) return f.slice(f.indexOf('=') + 1)
  const nx = argv[i + 1]
  return nx !== undefined && !nx.startsWith('--') ? nx : ''
}
const KEEP = argv.includes('--keep')
const DAYS = Number(flag('days') ?? 7)

type Persona = 'admin' | 'coach' | 'client' | 'prospect'
type Speaker = 'rahul' | 'arjun' | 'priya' | 'divya' | 'kavita' | 'nikhil' | 'farah'

const PERSONA_OF: Record<Speaker, Persona> = {
  rahul: 'admin',
  arjun: 'coach',
  priya: 'coach',
  divya: 'client',
  kavita: 'client',
  nikhil: 'prospect',
  farah: 'prospect',
}

type Beat = {
  /** Local time of day, in the academy's zone, when this happens. */
  at: string
  who: Speaker
  say: string
  /** Tap whatever the reply staged. A person does; the default is yes. */
  tap?: boolean
}

/**
 * The week. Seven days, twenty-eight turns, seven per persona.
 *
 * Written as a business's week rather than as a feature list: the same people
 * recur, what they say on Thursday depends on what happened on Tuesday, and
 * nobody introduces themselves twice. Two threads run underneath — Kavita's
 * daughter is drifting away, and Priya wants a raise — because a week in which
 * every request is self-contained is not a week, it is a test suite.
 */
const WEEK: Beat[][] = [
  // ---------------------------------------------------------------- day 1, Mon
  [
    { at: '07:40', who: 'rahul', say: 'morning — who have I got in today and is anything short a coach?' },
    { at: '09:15', who: 'divya', say: 'is Anika in this evening? she was off school with a cold yesterday' },
    { at: '17:05', who: 'arjun', say: 'running about 10 mins late for the evening batch, stuck at the signal' },
    { at: '20:30', who: 'nikhil', say: 'hi do you do adult beginner lessons? saw your board near the market' },
  ],
  // ---------------------------------------------------------------- day 2, Tue
  [
    { at: '08:10', who: 'priya', say: 'can you send me my sessions for the week? want to plan my other job around it' },
    { at: '11:00', who: 'rahul', say: 'add a new family — Kavita Shah 9876500011, her daughter Ira, she wants the morning juniors' },
    { at: '18:45', who: 'kavita', say: 'hi! just signed Ira up. what should she bring on the first day?' },
    { at: '21:10', who: 'farah', say: 'how much for two kids a month?' },
  ],
  // ---------------------------------------------------------------- day 3, Wed
  [
    { at: '07:30', who: 'arjun', say: 'who is on my register tonight?' },
    { at: '12:20', who: 'rahul', say: 'priya asked me for a raise. what am I paying everyone at the moment?' },
    { at: '19:50', who: 'arjun', say: 'done for tonight — everyone was in except Anika, she never turned up' },
    { at: '22:00', who: 'divya', say: 'sorry we missed tonight, Anika had a fever. do we still get charged for that?' },
  ],
  // ---------------------------------------------------------------- day 4, Thu
  [
    { at: '08:05', who: 'rahul', say: 'what does everyone owe me right now?' },
    { at: '10:30', who: 'kavita', say: 'can Ira switch to the evening batch instead? mornings are not working for us' },
    { at: '16:40', who: 'priya', say: 'I cannot make saturday, something has come up at home' },
    { at: '20:15', who: 'nikhil', say: 'ok I would like to try it. when can I come?' },
  ],
  // ---------------------------------------------------------------- day 5, Fri
  [
    { at: '07:45', who: 'rahul', say: 'is saturday covered now that priya is out?' },
    { at: '13:00', who: 'divya', say: 'sending this month now — 2400, upi ref 4471190022' },
    { at: '18:00', who: 'arjun', say: 'can I take saturday? happy to cover it' },
    { at: '21:30', who: 'farah', say: 'do you ever do a sibling discount' },
  ],
  // ---------------------------------------------------------------- day 6, Sat
  [
    { at: '09:00', who: 'farah', say: 'could I bring both my kids down on saturday just to watch before deciding?' },
    { at: '11:30', who: 'rahul', say: 'write this down as policy — no makeups on saturdays, and I want to be asked before anything over 500 is waived' },
    { at: '15:00', who: 'kavita', say: 'please stop messaging me about money, my husband handles that. the rest is fine' },
    { at: '19:00', who: 'priya', say: 'thanks for sorting saturday. did rahul say anything about the raise?' },
  ],
  // ---------------------------------------------------------------- day 7, Sun
  [
    { at: '09:30', who: 'rahul', say: 'how did the week go? anything I should be worried about' },
    { at: '12:00', who: 'divya', say: 'has my payment gone through?' },
    { at: '17:20', who: 'nikhil', say: 'that trial was good. sign me up properly' },
    { at: '20:00', who: 'farah', say: 'if we miss a week do we get the class back or is it just gone?' },
  ],
]

/* ------------------------------------------------------------------------- */

type Turn = {
  day: number
  at: string
  who: Speaker
  persona: Persona
  say: string
  sql: SqlRecord[]
  rounds: any[]
  reply: string | null
  buttons: string[]
  tapped: string | null
  tokens: { prompt: number; cached: number; output: number }
  ms: number
  error: string | null
}

type DayLog = { day: number; jobs: string[]; sent: { to: string; body: string; origin: string }[] }

async function main(): Promise<void> {
  const beats = WEEK.slice(0, DAYS)
  const counts = new Map<Persona, number>()
  for (const day of beats) for (const b of day) counts.set(PERSONA_OF[b.who], (counts.get(PERSONA_OF[b.who]) ?? 0) + 1)
  const spread = [...counts.values()]
  // Asserted rather than intended. A drive claiming equal persona coverage while
  // running eleven admin turns and two client ones is a drive whose headline is
  // false, and the imbalance is invisible in the report it writes.
  if (Math.max(...spread) !== Math.min(...spread)) {
    console.error(c.red(`  personas are not balanced: ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')}`))
    process.exit(2)
  }

  console.log(
    c.bold(`\n  drive-week — ${beats.length} days, ${beats.flat().length} turns, ` +
      `${[...counts].map(([k, v]) => `${v} ${k}`).join(' · ')}\n`),
  )

  /**
   * Clear this driver's own leftovers before creating another.
   *
   * A run that throws part-way — and the first one did, on a typo in the world
   * setup below — never reaches `dropAcademy`, so the business survives. Every
   * tenant shares one sender, so the next run's contacts sit beside the last
   * run's on the same number space, and the failure that produces is silent:
   * an inbound matching two contacts resolves to neither and the turn simply
   * never happens.
   *
   * Scoped to the EXACT name this script uses, and this script is the only thing
   * that ever creates it. It will not touch a seeded world, a probe's academy or
   * anything a person made.
   *
   * Enumerated through `worldAcademyIds()` and read one tenant at a time, NOT
   * with a single `select … from academy` on a session with no tenant set. Every
   * `cm_service` policy is `academy_id = app.academy_id()`, so with no GUC the
   * comparison is NULL and **every tenant-scoped table reads empty** — including
   * `academy` itself. The first version of this block did exactly that, found
   * nothing, reported success, and left the previous run's business standing.
   * That is R7 inside the cleanup meant to prevent it.
   */
  for (const id of await worldAcademyIds({ refresh: true })) {
    const [row] = await withSession({ role: 'service', academyId: id }, async (tx) =>
      (await tx`select name from academy where id = ${id}::uuid`) as unknown as { name: string }[],
    )
    if (row?.name !== 'Ace Tennis Academy') continue
    console.log(c.dim(`  clearing a previous run: ${id}`))
    await dropAcademy(id).catch((e) => console.log(c.red(`  could not drop ${id}: ${(e as Error).message}`)))
  }

  const made = await createAcademy({
    name: 'Ace Tennis Academy',
    adminName: 'Rahul Menon',
    timezone: 'Asia/Kolkata',
    category: 'tennis',
  })
  const q = async <T = any>(sql: string): Promise<T[]> =>
    withSession({ role: 'service', academyId: made.academyId }, async (tx) => (await tx.unsafe(sql)) as unknown as T[])

  await worldAcademyIds({ refresh: true })

  const digits = made.academyId.replace(/\D/g, '').padEnd(9, '0')
  const phone = (n: number) => `+9193${digits.slice(0, 7)}${n}`

  const arjun = await createTestContact({ academyId: made.academyId, name: 'Arjun Shetty', role: 'coach', phone: phone(1) })
  const priya = await createTestContact({ academyId: made.academyId, name: 'Priya Nair', role: 'coach', phone: phone(2) })
  const divya = await createTestContact({ academyId: made.academyId, name: 'Divya Rao', role: 'client', phone: phone(3) })
  const kavita = await createTestContact({ academyId: made.academyId, name: 'Kavita Shah', role: 'prospect', phone: phone(4) })
  const nikhil = await createTestContact({ academyId: made.academyId, name: 'Nikhil Bose', role: 'prospect', phone: phone(5) })
  const farah = await createTestContact({ academyId: made.academyId, name: 'Farah Sheikh', role: 'prospect', phone: phone(6) })
  await worldAcademyIds({ refresh: true })

  /**
   * **The owner is also a coach**, which is the whole point of this world and the
   * one row a lifecycle arc never creates. `academy_admin` and `coach` over one
   * `person`: two hats, one head, and every "can he see this" question in the
   * product is decided by which of the two is being asked.
   */
  await q(`
    insert into coach (academy_id, person_id, pay_amount, pay_unit, status, onboarded_at)
    values ('${made.academyId}'::uuid, '${made.adminPersonId}'::uuid, 0, 'per_month', 'active', app.now())
    on conflict do nothing`)

  await q(`insert into venue (academy_id, name) values ('${made.academyId}'::uuid, 'Ace Courts')`)
  // Four classes across the week so a day is never empty and Saturday is a real
  // fixture rather than a hypothetical.
  const classes: [string, number, string, string, number, string][] = [
    ['Morning Juniors', 1, '07:00', '08:00', 900, 'per_month'],
    ['Evening Batch', 1, '18:00', '19:00', 2400, 'per_month'],
    ['Evening Batch', 3, '18:00', '19:00', 2400, 'per_month'],
    ['Weekend Squad', 6, '09:00', '10:30', 1200, 'per_month'],
  ]
  for (const [name, weekday, from, to, rate, unit] of classes) {
    await q(`
      insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on, active)
      select '${made.academyId}'::uuid, '${name}', v.id, ${rate}, '${unit}',
             (app.now() - interval '40 days')::date, true
        from venue v
       where v.name = 'Ace Courts'
         and not exists (select 1 from class where name = '${name}' and active and ends_on is null)`)
    await q(`
      insert into class_slot (academy_id, class_id, weekday, start_time, end_time)
      select '${made.academyId}'::uuid, c.id, ${weekday}, time '${from}', time '${to}'
        from class c where c.name = '${name}' and c.active and c.ends_on is null`)
  }
  // Rahul takes the mornings and the weekend; Arjun the evenings; Priya shares
  // the weekend, so her Saturday drop-out on day 4 actually uncovers something.
  const assign: [string, string][] = [
    ['Morning Juniors', 'Rahul Menon'],
    ['Evening Batch', 'Arjun Shetty'],
    ['Weekend Squad', 'Priya Nair'],
    ['Weekend Squad', 'Rahul Menon'],
  ]
  for (const [cls, who] of assign) {
    await q(`
      insert into class_coach (academy_id, class_id, coach_id)
      select '${made.academyId}'::uuid, c.id, co.id
        from class c, coach co join person p on p.id = co.person_id
       where c.name = '${cls}' and c.active and c.ends_on is null and p.full_name = '${who}'
      on conflict do nothing`)
  }
  // One settled family, so the week opens with history behind it rather than
  // with an empty ledger nobody could ask a question about.
  await q(`insert into person (academy_id, full_name) values ('${made.academyId}'::uuid, 'Anika Rao')`)
  await q(`
    insert into player (academy_id, account_id, person_id, active)
    select '${made.academyId}'::uuid, a.id, kid.id, true
      from account a join person mum on mum.id = a.holder_person_id, person kid
     where mum.full_name = 'Divya Rao' and kid.full_name = 'Anika Rao'`)
  await q(`
    insert into enrollment (academy_id, class_id, player_id, started_on)
    select '${made.academyId}'::uuid, c.id, pl.id, (app.now() - interval '35 days')::date
      from class c, player pl join person p on p.id = pl.person_id
     where c.name = 'Evening Batch' and c.active and c.ends_on is null and p.full_name = 'Anika Rao'
     limit 1`)
  await q(`update academy set onboarding_state = 'live' where id = '${made.academyId}'::uuid`)

  const contactOf: Record<Speaker, string> = {
    rahul: made.adminContactId,
    arjun: arjun.contactId,
    priya: priya.contactId,
    divya: divya.contactId,
    kavita: kavita.contactId,
    nikhil: nikhil.contactId,
    farah: farah.contactId,
  }

  const domainNow = async (): Promise<Date> => clock.now(made.academyId)

  async function drain(): Promise<string[]> {
    const log: string[] = []
    await planAheadFor(made.academyId).catch((e) => log.push(`plan failed: ${(e as Error)?.message}`))
    for (let round = 0; round < 10; round++) {
      const batch = await q<any>(`
        with due as (
          select id from job
           where status = 'pending' and run_at <= app.now()
             and payload->>'academy_id' = '${made.academyId}'
           order by run_at asc, created_at asc limit 50 for update skip locked
        )
        update job j set status = 'running', attempts = j.attempts + 1,
               locked_at = app.now(), locked_by = 'drive-week'
          from due where j.id = due.id returning j.*`)
      if (!batch.length) break
      batch.sort((a: any, b: any) => msOf(a.run_at) - msOf(b.run_at))
      for (const job of batch) {
        const handler = (HANDLERS as any)[job.kind]
        if (!handler) {
          await q(`update job set status='failed', last_error='no handler', locked_at=null where id='${job.id}'::uuid`)
          continue
        }
        try {
          await handler(job)
          await q(`update job set status='done', last_error=null, locked_at=null where id='${job.id}'::uuid`)
          log.push(job.kind)
        } catch (e) {
          const skip = e instanceof JobSkip
          const why = String((e as any)?.reason ?? (e as Error)?.message ?? e).slice(0, 200).replace(/'/g, "''")
          await q(`update job set status='${skip ? 'skipped' : 'failed'}', last_error='${why}', locked_at=null where id='${job.id}'::uuid`)
          if (!skip) log.push(`FAIL ${job.kind}: ${why}`)
        }
      }
    }
    return log
  }

  /** Walk this academy's clock to a local time on the current day, draining as it goes. */
  async function walkTo(localHHMM: string): Promise<void> {
    const tz = 'Asia/Kolkata'
    for (let guard = 0; guard < 48; guard++) {
      const now = await domainNow()
      const here = clock.inZone(now, tz)
      const [h, m] = localHHMM.split(':').map(Number)
      const targetMin = (h ?? 0) * 60 + (m ?? 0)
      const [ch, cm] = here.time.split(':').map(Number)
      const nowMin = (ch ?? 0) * 60 + (cm ?? 0)
      if (nowMin >= targetMin) return
      // Never in one hop: a standing job that was due at 09:00 must actually be
      // reached and run, not stepped over. Hourly, draining each time.
      const step = Math.min(60, targetMin - nowMin)
      await clock.advance(step * 60_000, made.academyId)
      await drain()
    }
  }

  async function tapStaged(contactId: string): Promise<string | null> {
    const rows = await q<{ id: string; title: string }>(`
      select a.id::text as id, coalesce(a.payload->>'summary','') as title from action a
       where a.minted_for_contact_id = '${contactId}'::uuid and a.consumed_at is null
         and a.kind in ('steps','operation')
         and (a.expires_at is null or a.expires_at > app.now())
       order by a.minted_at desc limit 1`)
    const id = rows[0]?.id
    if (!id) return null
    try {
      await inboundFromContact({ contactId, actionId: id })
      return id
    } catch {
      return null
    }
  }

  const turns: Turn[] = []
  const days: DayLog[] = []

  for (const [i, day] of beats.entries()) {
    const dayNo = i + 1
    const label = clock.inZone(await domainNow(), 'Asia/Kolkata').label
    process.stdout.write(c.bold(`\n  day ${dayNo} — ${label}\n`))
    const jobs: string[] = []

    for (const beat of day) {
      await walkTo(beat.at)
      jobs.push(...(await drain()))

      const before = (await domainNow()).toISOString()
      process.stdout.write(`    ${beat.at} ${c.dim(beat.who.padEnd(7))} `)
      const startedAt = Date.now()
      let captured: SqlRecord[] = []
      let tapped: string | null = null
      let error: string | null = null
      try {
        const { sql } = await captureSql({ rows: false }, async () => {
          await inboundFromContact({ contactId: contactOf[beat.who], text: beat.say })
          if (beat.tap !== false) tapped = await tapStaged(contactOf[beat.who])
        })
        captured = sql
      } catch (e) {
        error = e instanceof Error ? (e.stack ?? e.message) : String(e)
      }

      /**
       * Every turn in the window, oldest first. A tap opens its own turn, so
       * taking the newest one returned the tap's trace and discarded the trace
       * of the turn that composed the plan — the half worth reading.
       */
      const turnRows = await q<any>(`select tool_calls, prompt_tokens, cached_tokens, output_tokens, error
                                       from turn where created_at >= '${before}'::timestamptz
                                      order by created_at asc`)
      const rounds = turnRows.flatMap((t: any) =>
        Array.isArray(t?.tool_calls)
          ? t.tool_calls
          : typeof t?.tool_calls === 'string'
            ? JSON.parse(t.tool_calls || '[]')
            : [],
      )
      const turnRow = {
        prompt_tokens: turnRows.reduce((a: number, t: any) => a + Number(t?.prompt_tokens ?? 0), 0),
        cached_tokens: turnRows.reduce((a: number, t: any) => a + Number(t?.cached_tokens ?? 0), 0),
        output_tokens: turnRows.reduce((a: number, t: any) => a + Number(t?.output_tokens ?? 0), 0),
      }
      const out = await q<{ body: string; payload: any }>(`
        select m.body, m.payload from message m
         where m.direction = 'outbound' and m.created_at >= '${before}'::timestamptz
           and m.contact_id = '${contactOf[beat.who]}'::uuid
         order by m.created_at asc`)

      turns.push({
        day: dayNo,
        at: beat.at,
        who: beat.who,
        persona: PERSONA_OF[beat.who],
        say: beat.say,
        sql: captured,
        rounds,
        reply: out.map((m) => m.body).join('\n---\n') || null,
        buttons: out.flatMap((m) =>
          Array.isArray(m.payload?.buttons) ? m.payload.buttons.map((b: any) => String(b?.title ?? '')) : [],
        ),
        tapped,
        tokens: {
          prompt: Number(turnRow?.prompt_tokens ?? 0),
          cached: Number(turnRow?.cached_tokens ?? 0),
          output: Number(turnRow?.output_tokens ?? 0),
        },
        ms: Date.now() - startedAt,
        error,
      })

      const errs = captured.filter((s) => s.error).length
      const empties = captured.filter((s) => s.kind !== 'read' && s.rowCount === 0).length
      console.log(
        `${captured.filter((s) => s.kind === 'read').length}r ` +
          `${captured.filter((s) => s.kind !== 'read').length}w ` +
          (errs ? c.red(`${errs} err `) : '') +
          (empties ? c.yellow(`${empties} empty-write `) : '') +
          c.dim(`${Math.round((Date.now() - startedAt) / 1000)}s`) +
          (out.length ? '' : c.red('  · SAID NOTHING')),
      )
    }

    // Close the day out so the evening digest and the overnight jobs actually run.
    await walkTo('23:30')
    jobs.push(...(await drain()))
    await clock.advance(40 * 60_000, made.academyId)
    jobs.push(...(await drain()))

    const sent = await q<{ to: string; body: string; origin: string }>(`
      select p.full_name as to, m.body, coalesce(m.origin,'?') as origin
        from message m join contact ct on ct.id = m.contact_id join person p on p.id = ct.person_id
       where m.direction = 'outbound' and m.created_at >= app.now() - interval '24 hours'
       order by m.created_at asc`)
    days.push({ day: dayNo, jobs, sent })
  }

  await report(turns, days, made.academyId, q)

  if (!KEEP) await dropAcademy(made.academyId).catch(() => {})
  else console.log(c.dim(`\n  kept: ${made.academyId}`))
  process.exit(0)
}

async function report(
  turns: Turn[],
  days: DayLog[],
  academyId: string,
  q: <T = any>(s: string) => Promise<T[]>,
): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
  await mkdir('.probe/week', { recursive: true })

  // The world as it ended up — the only evidence that does not come from the
  // thing under test describing itself.
  const world = await q<any>(`
    select (select count(*) from person) people, (select count(*) from player) players,
           (select count(*) from enrollment where ended_on is null) enrolled,
           (select count(*) from session) sessions,
           (select count(*) from session where status='cancelled') cancelled,
           (select count(*) from attendance) marked,
           (select count(*) from tally_line) lines,
           (select coalesce(sum(amount),0) from tally_line) billed,
           (select count(*) from payment where status='confirmed') paid,
           (select count(*) from message where direction='outbound') sent,
           (select count(*) from message where status='failed') failed,
           (select count(*) from message where status='suppressed') suppressed,
           (select count(*) from business_rule) rules,
           (select count(*) from comm_preference where released_at is null) mutes,
           (select count(*) from job where status='failed') job_failures`)

  await writeFile(`.probe/week/${stamp}.json`, JSON.stringify({ model: env.MODEL_MAIN, academyId, turns, days, world: world[0] }, null, 2))

  const allSql = turns.flatMap((t) => t.sql)
  const L: string[] = []
  L.push(`# One week at Ace Tennis Academy — ${stamp}`)
  L.push('')
  L.push(`Model \`${env.MODEL_MAIN}\`. ${turns.length} turns over ${days.length} days. Academy \`${academyId}\`.`)
  L.push('')
  L.push('The owner coaches: Rahul holds an `academy_admin` row and a `coach` row over one person. Two coaches work under him.')
  L.push('')

  L.push('## The week, in numbers')
  L.push('')
  const w = world[0] ?? {}
  L.push('| | |')
  L.push('| --- | --- |')
  L.push(`| turns | ${turns.length} (${[...new Set(turns.map((t) => t.persona))].map((p) => `${turns.filter((t) => t.persona === p).length} ${p}`).join(', ')}) |`)
  L.push(`| SQL statements the model wrote | ${allSql.length} — ${allSql.filter((s) => s.kind === 'read').length} read, ${allSql.filter((s) => s.kind !== 'read').length} write |`)
  L.push(`| SQL refused or errored | **${allSql.filter((s) => s.error).length}** |`)
  L.push(`| writes that matched no rows | **${allSql.filter((s) => s.kind !== 'read' && s.rowCount === 0).length}** |`)
  L.push(`| turns that said nothing at all | **${turns.filter((t) => !t.reply).length}** |`)
  L.push(`| messages sent | ${w.sent} (${w.failed} failed, ${w.suppressed} suppressed) |`)
  L.push(`| people / players / live enrolments | ${w.people} / ${w.players} / ${w.enrolled} |`)
  L.push(`| sessions (cancelled) / attendance marked | ${w.sessions} (${w.cancelled}) / ${w.marked} |`)
  L.push(`| tally lines / total billed | ${w.lines} / ₹${Number(w.billed).toFixed(2)} |`)
  L.push(`| payments confirmed | ${w.paid} |`)
  L.push(`| business rules / live mutes | ${w.rules} / ${w.mutes} |`)
  L.push(`| failed jobs | ${w.job_failures} |`)
  const cost = turns.reduce(
    (a, t) => a + (costInr(env.MODEL_MAIN, t.tokens.prompt, t.tokens.cached, t.tokens.output) ?? 0),
    0,
  )
  L.push(`| model cost, whole week | ₹${cost.toFixed(2)} (₹${(cost / Math.max(turns.length, 1)).toFixed(3)} a turn) |`)
  L.push('')

  if (allSql.some((s) => s.error)) {
    L.push('## Every SQL statement that failed')
    L.push('')
    for (const s of allSql.filter((x) => x.error)) {
      L.push('```sql')
      L.push(s.sql)
      L.push('```')
      L.push(`> ${s.error}`)
      L.push('')
    }
  }

  const emptyWrites = allSql.filter((s) => s.kind !== 'read' && s.rowCount === 0)
  if (emptyWrites.length) {
    L.push('## Writes that matched nothing and raised nothing')
    L.push('')
    L.push('The dangerous half: Postgres reports success, and only a read-back can tell.')
    L.push('')
    for (const s of emptyWrites) {
      L.push('```sql')
      L.push(s.sql)
      L.push('```')
      L.push('')
    }
  }

  for (const day of days) {
    const dayTurns = turns.filter((t) => t.day === day.day)
    L.push('---')
    L.push('')
    L.push(`## Day ${day.day}`)
    L.push('')
    L.push(`Standing jobs that ran: ${day.jobs.length ? [...new Set(day.jobs)].join(', ') : '_none_'}`)
    L.push('')
    for (const t of dayTurns) {
      L.push(`### ${t.at} · ${t.who} (${t.persona})`)
      L.push('')
      L.push(`> ${t.say}`)
      L.push('')
      L.push(t.reply ? '**Reply:**\n\n```\n' + t.reply + '\n```' : '**Reply:** _nothing was sent_')
      if (t.buttons.length) L.push(`\nButtons: ${t.buttons.map((b) => `\`[${b}]\``).join(' ')}`)
      if (t.tapped) L.push(`\n_(the staged plan was tapped and committed)_`)
      L.push('')
      if (t.sql.length) {
        L.push(`<details><summary>${t.sql.length} SQL statements</summary>`)
        L.push('')
        for (const s of t.sql) {
          L.push(`**${s.kind}** — ${s.error ? `❌ ${s.error}` : `${s.rowCount} rows`}`)
          L.push('')
          L.push('```sql')
          L.push(s.sql)
          L.push('```')
          L.push('')
        }
        L.push('</details>')
        L.push('')
      }
      const reasoning = t.rounds.filter((r: any) => r?.reasoning)
      if (reasoning.length) {
        L.push('<details><summary>reasoning, every round</summary>')
        L.push('')
        for (const r of reasoning) {
          L.push(`**round ${r.round}**`)
          L.push('')
          L.push('```')
          L.push(String(r.reasoning))
          L.push('```')
          L.push('')
        }
        L.push('</details>')
        L.push('')
      }
    }
    const jobSent = day.sent.filter((s) => s.origin === 'job')
    if (jobSent.length) {
      L.push('**What the standing jobs sent, unprompted:**')
      L.push('')
      for (const s of jobSent) {
        L.push(`- to **${s.to}**: ${s.body.replace(/\n/g, ' ').slice(0, 300)}`)
      }
      L.push('')
    }
  }

  await writeFile(`.probe/week/${stamp}.md`, L.join('\n'))
  console.log(c.dim(`\n  .probe/week/${stamp}.md`))
  console.log(
    `\n  ${c.bold(`${allSql.length} statements`)} · ${c.red(`${allSql.filter((s) => s.error).length} failed`)} · ` +
      `${c.yellow(`${emptyWrites.length} empty writes`)} · ${c.bold(`₹${cost.toFixed(2)}`)}`,
  )
}

await main()

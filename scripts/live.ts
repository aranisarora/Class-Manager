/**
 * live — the product driven from the seat, by people who cannot see the database.
 *
 *   npx tsx scripts/live.ts open [--days 7]
 *   npx tsx scripts/live.ts window --day 1 --window morning     ← orchestrator
 *   npx tsx scripts/live.ts brief rahul                         ← seat
 *   npx tsx scripts/live.ts say rahul "who have i got in today"  ← seat
 *   npx tsx scripts/live.ts tap rahul "Yes"                     ← seat
 *   npx tsx scripts/live.ts inbox rahul                         ← seat
 *   npx tsx scripts/live.ts note rahul --kind unclear --text "…" ← seat
 *   npx tsx scripts/live.ts endday                              ← orchestrator
 *   npx tsx scripts/live.ts close
 *
 * WHY THIS EXISTS BESIDE `drive-week`
 * -----------------------------------------------------------------------------
 * `drive-week` scripts twenty-eight sentences and posts them in order. Whatever
 * the product replies, the next sentence is the same one. That harness cannot
 * represent the three commonest things a real person does:
 *
 *   - ask again, because the first answer did not answer it
 *   - act on a misreading, because the important number was in sentence four
 *   - go quiet and leave
 *
 * All three are outcomes. None of them is expressible as a fixture, and the last
 * one is the one the business actually cares about. So the sentences are not in
 * this file. What is in this file is a SEAT: a way to say something as a
 * particular person, and see exactly — and only — what their phone would show.
 * Somebody else sits in it, reads, and decides what to type next.
 *
 * THE BLINDFOLD, AND WHY IT IS ENFORCED HERE RATHER THAN PROMISED
 * -----------------------------------------------------------------------------
 * The entire value of a reading like "I could not tell whether that meant she was
 * charged" evaporates if the reader could have checked the rows. So the seat
 * commands — `brief`, `say`, `tap`, `inbox`, `note`, `diary`, `clock` — print
 * message bodies, buttons, list rows and forms, and nothing else. Not the SQL the
 * model wrote, not its reasoning, not the tokens, not the rupees, not a row
 * count, not even whether the turn errored. A turn that crashed reads, from the
 * seat, as silence — which is precisely what it is from the seat.
 *
 * Every seat command is appended to `seat.jsonl` with what it showed, so the
 * blindfold is auditable after the run rather than merely asserted in a comment.
 *
 * WHAT IT RECORDS
 * -----------------------------------------------------------------------------
 * Everything, in the one shape every instrument here writes (`_capture.ts`):
 * every SQL statement the model composed with what Postgres answered, every
 * round's reasoning verbatim, every message that reached a phone, what the queue
 * ran, tokens, seconds and rupees. `npm run report` renders it, and a judgement
 * is written beside it — see JUDGING.md. Nothing in here scores anything.
 *
 * WHY THE TURNS ARE SERIALISED
 * -----------------------------------------------------------------------------
 * Three seats can be occupied at once and in a real academy they are. But
 * `_capture.ts` attributes evidence by a domain-time cursor — everything stamped
 * at or after the moment a turn began belongs to that turn — and two turns
 * running at once make that attribution false in both directions: each collects
 * the other's messages, jobs and audit rows. A record whose turns each contain a
 * bit of the neighbouring turn is not a record.
 *
 * So a lock file serialises the turns and nothing else. Seats still run
 * concurrently; they queue at the moment of speaking. The cost is a minute of
 * waiting and the gain is that turn 23 means turn 23.
 */
import { mkdir, readFile, writeFile, appendFile, rm, open as openFile } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { loadEnvFiles, c } from './_env'

loadEnvFiles()
/**
 * Not optional garnish. `.env.local` ships `TRANSPORT=cloud`, and a drive that
 * takes the cloud path hard-fails at the credential gate and measures nothing —
 * every turn reports an error, zero tools, an empty reply, and it reads exactly
 * like a broken model.
 */
process.env.TRANSPORT = 'emulator'

const { dropAcademy, inboundFromContact } = await import('@/lib/seed')
const { withSession } = await import('@/lib/db')
const { reopenRun, saveRun, runDir } = await import('./_capture')
const clock = await import('@/lib/clock')
const { HANDLERS, JobSkip, planAheadFor } = await import('@/lib/jobs')
const { msOf } = await import('@/lib/jobs/util')
const { costInr } = await import('@/lib/pricing')
const { env } = await import('@/lib/env')
const { buildSettledAcademy } = await import('./_world')
const { PERSONAS, SCHEDULE, WINDOW_AT, windowCounts, INPUT_REALISM } = await import('./_personas')
type PersonaKey = import('./_personas').PersonaKey
type WindowName = import('./_personas').Window

const TZ = 'Asia/Kolkata'
const HOME = join('.probe', 'live')
const POINTER = join(HOME, 'current')
const LOCK = join(HOME, 'turn.lock')

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'help'
const flag = (n: string): string | undefined => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return undefined
  const f = argv[i] as string
  if (f.includes('=')) return f.slice(f.indexOf('=') + 1)
  const nx = argv[i + 1]
  return nx !== undefined && !nx.startsWith('--') ? nx : ''
}
/** Positional arguments only — everything that is not a flag or a flag's value. */
const positionals = (): string[] => {
  const out: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i] as string
    if (a.startsWith('--')) {
      if (!a.includes('=') && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) i++
      continue
    }
    out.push(a)
  }
  return out
}

type Session = {
  dir: string
  academyId: string
  days: number
  day: number
  contacts: Record<string, string>
  roster: { name: string; role: string; contactId: string; phone: string }[]
  /** Per persona, the `created_at` of the last message their phone has shown them. */
  cursor: Record<string, string>
  startedAt: string
}

/* ---------------------------------------------------------------- plumbing */

const q = async <T = any>(academyId: string, sql: string): Promise<T[]> =>
  withSession({ role: 'service', academyId }, async (tx) => (await tx.unsafe(sql)) as unknown as T[])

async function readSession(): Promise<Session> {
  if (!existsSync(POINTER)) die('no live run is open. Start one with:  npx tsx scripts/live.ts open')
  const dir = (await readFile(POINTER, 'utf8')).trim()
  return JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as Session
}
async function writeSession(s: Session): Promise<void> {
  await writeFile(join(s.dir, 'session.json'), JSON.stringify(s, null, 2))
}

function die(msg: string): never {
  console.error(`  ${msg}`)
  process.exit(2)
}

/**
 * One turn at a time, across processes.
 *
 * `wx` is the whole mechanism: creating the file is the acquire, and it either
 * succeeds or it does not. A lock older than the longest a turn has ever taken is
 * broken rather than waited on, because the process that made it is dead — a
 * persona's shell was interrupted, or the machine slept — and a run that hangs
 * forever on a dead process's lock loses the rest of the week.
 */
async function withLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(HOME, { recursive: true })
  const STALE_MS = 12 * 60_000
  for (let i = 0; i < 900; i++) {
    try {
      const fh = await openFile(LOCK, 'wx')
      await fh.writeFile(`${process.pid} ${label} ${new Date().toISOString()}`)
      await fh.close()
      try {
        return await fn()
      } finally {
        await rm(LOCK, { force: true })
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) await rm(LOCK, { force: true })
      } catch {}
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  return die('waited 30 minutes for the turn lock and it never came free')
}

/* ------------------------------------------------------------- the world */

/** Run every job that is due, then everything that becoming due unlocked. */
async function drain(academyId: string): Promise<string[]> {
  const log: string[] = []
  await planAheadFor(academyId).catch((e) => log.push(`plan failed: ${(e as Error)?.message}`))
  for (let round = 0; round < 10; round++) {
    const batch = await q<any>(
      academyId,
      `with due as (
         select id from job
          where status = 'pending' and run_at <= app.now()
            and payload->>'academy_id' = '${academyId}'
          order by run_at asc, created_at asc limit 50 for update skip locked
       )
       update job j set status = 'running', attempts = j.attempts + 1,
              locked_at = app.now(), locked_by = 'live'
         from due where j.id = due.id returning j.*`,
    )
    if (!batch.length) break
    batch.sort((a: any, b: any) => msOf(a.run_at) - msOf(b.run_at))
    for (const job of batch) {
      const handler = (HANDLERS as any)[job.kind]
      if (!handler) {
        await q(academyId, `update job set status='failed', last_error='no handler', locked_at=null where id='${job.id}'::uuid`)
        continue
      }
      try {
        await handler(job)
        await q(academyId, `update job set status='done', last_error=null, locked_at=null where id='${job.id}'::uuid`)
        log.push(`${job.kind}:done`)
      } catch (e) {
        const skip = e instanceof JobSkip
        const why = String((e as any)?.reason ?? (e as Error)?.message ?? e).slice(0, 200).replace(/'/g, "''")
        await q(
          academyId,
          `update job set status='${skip ? 'skipped' : 'failed'}', last_error='${why}', locked_at=null where id='${job.id}'::uuid`,
        )
        log.push(`${job.kind}:${skip ? 'skipped' : `FAILED ${why}`}`)
      }
    }
  }
  return log
}

/**
 * Walk this academy's clock forward to a local time today, draining as it goes.
 *
 * Never in one hop. A standing job due at 09:00 must actually be REACHED and run,
 * not stepped over — a jump from 08:00 to 20:00 leaves the 09:00 job pending with
 * a run_at in the past, and the day's proactive surface simply never happens.
 */
async function walkTo(academyId: string, localHHMM: string): Promise<string[]> {
  const jobs: string[] = []
  for (let guard = 0; guard < 48; guard++) {
    const here = clock.inZone(await clock.now(academyId), TZ)
    const [h, m] = localHHMM.split(':').map(Number)
    const target = (h ?? 0) * 60 + (m ?? 0)
    const [ch, cm] = here.time.split(':').map(Number)
    const nowMin = (ch ?? 0) * 60 + (cm ?? 0)
    if (nowMin >= target) break
    await clock.advance(Math.min(60, target - nowMin) * 60_000, academyId)
    jobs.push(...(await drain(academyId)))
  }
  return jobs
}

/* -------------------------------------------------------- the seat's view */

type Seen = {
  at: string
  body: string
  buttons: string[]
  listButton: string | null
  listRows: { title: string; description: string | null }[]
  link: string | null
}

/**
 * Everything this contact's phone has shown since they last looked, and nothing
 * else.
 *
 * Suppressed rows are excluded because the person never saw them — a message
 * stopped by a cap or an opt-out did not tell anybody anything, and showing it to
 * the seat would hand the reader a fact the real recipient does not have. Failed
 * rows go for the same reason.
 */
async function readPhone(s: Session, key: PersonaKey, advance: boolean): Promise<Seen[]> {
  const contactId = s.contacts[key]!
  const since = s.cursor[key] ?? s.startedAt
  /**
   * `created_at::text`, not `created_at`.
   *
   * The cursor is a high-water mark compared with `>`, and Postgres keeps
   * timestamps to the microsecond while a JS `Date` keeps them to the
   * millisecond. Round-tripping the value through `new Date(...).toISOString()`
   * therefore stores a cursor slightly BEHIND the row it came from, and the last
   * message of every look reappears at the top of the next one. The seat reads it
   * as the bot having sent the same thing twice, which is a defect the product
   * does not have and would have gone into the write-up as one.
   */
  const rows = await q<any>(
    s.academyId,
    `select m.created_at, m.created_at::text as raw_at, m.body, m.payload, m.status
       from message m
      where m.direction = 'outbound'
        and m.contact_id = '${contactId}'::uuid
        and m.created_at > '${since}'::timestamptz
        and m.suppressed_reason is null
        and m.status <> 'failed'
      order by m.created_at asc`,
  )
  const seen: Seen[] = rows.map((m: any) => {
    const p = m.payload ?? {}
    return {
      at: clock.inZone(new Date(m.created_at), TZ).label,
      body: String(m.body ?? ''),
      buttons: Array.isArray(p.buttons) ? p.buttons.map((b: any) => String(b?.title ?? '')) : [],
      listButton: p.list?.buttonText ? String(p.list.buttonText) : null,
      listRows: Array.isArray(p.list?.sections)
        ? p.list.sections.flatMap((sec: any) =>
            (sec?.rows ?? []).map((r: any) => ({
              title: String(r?.title ?? ''),
              description: r?.description ? String(r.description) : null,
            })),
          )
        : [],
      link: p.link?.title ? String(p.link.title) : null,
    }
  })
  if (advance && rows.length) {
    s.cursor[key] = String(rows[rows.length - 1].raw_at)
    await writeSession(s)
  }
  return seen
}

function renderPhone(seen: Seen[]): string {
  if (!seen.length) return '  (nothing arrived. Your phone stayed silent.)'
  const L: string[] = []
  for (const m of seen) {
    L.push(`  ┌─ ${m.at} ── Class Manager ${'─'.repeat(Math.max(0, 44 - m.at.length))}`)
    for (const line of m.body.split('\n')) L.push(`  │ ${line}`)
    if (m.buttons.length) L.push(`  │`), L.push(`  │ tap:  ${m.buttons.map((b) => `[ ${b} ]`).join('   ')}`)
    if (m.listButton) {
      L.push(`  │`)
      L.push(`  │ menu:  [ ${m.listButton} ]`)
      for (const r of m.listRows) L.push(`  │   · ${r.title}${r.description ? ` — ${r.description}` : ''}`)
    }
    if (m.link) L.push(`  │`), L.push(`  │ link:  [ ${m.link} ]`)
    L.push(`  └${'─'.repeat(62)}`)
  }
  return L.join('\n')
}

/** Every seat command, and what it showed. The blindfold, made auditable. */
async function logSeat(s: Session, entry: Record<string, unknown>): Promise<void> {
  await appendFile(
    join(s.dir, 'seat.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), day: s.day, ...entry }) + '\n',
  )
}

/* ------------------------------------------------------------- one turn */

/**
 * Post something as this person, let the product do whatever it does, and show
 * them their phone.
 *
 * The record is opened INSIDE the lock and closed inside it, so the read of
 * `record.json`, the append and the write are one critical section. Two seats
 * speaking at once would otherwise each read the file, each append one turn, and
 * the second write would erase the first.
 */
async function drive(
  s: Session,
  key: PersonaKey,
  meta: { say: string; kind: 'say' | 'tap' },
  fn: () => Promise<void>,
): Promise<Seen[]> {
  return withLock(`${key}:${meta.kind}`, async () => {
    const at = clock.inZone(await clock.now(s.academyId), TZ)
    const rec = await reopenRun(s.dir, {
      academyId: s.academyId,
      q: (sql: string) => q(s.academyId, sql),
      domainNow: () => clock.now(s.academyId),
    })
    await rec.turn(
      {
        id: `d${s.day}-${at.time}-${key}${meta.kind === 'tap' ? '-tap' : ''}`,
        who: PERSONAS[key].name,
        persona: PERSONAS[key].seat,
        say: meta.say,
        day: s.day,
        ...(meta.kind === 'tap' ? { tapped: meta.say } : {}),
      },
      fn,
    )
    // Re-read rather than reuse: another seat's process may have moved its own
    // cursor while this turn was running, and writing a stale copy of the whole
    // session back would rewind it.
    return readPhone(await readSession(), key, true)
  })
}

/* ------------------------------------------------------------- commands */

async function main(): Promise<void> {
  switch (cmd) {
    /* ------------------------------------------------------------ open */
    case 'open': {
      const days = Number(flag('days') ?? 7)
      const counts = windowCounts(days)
      const spread = Object.values(counts)
      if (Math.max(...spread) !== Math.min(...spread)) {
        // Asserted rather than intended. A week claiming equal coverage while
        // running eleven owner windows and two client ones reports the owner's
        // experience as though it were the product's, and the imbalance is
        // invisible in the report it writes.
        die(`seats are not balanced over ${days} days: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`)
      }

      console.log(c.bold(`\n  live — ${days} days, ${spread.reduce((a, b) => a + b, 0)} seat windows, ${spread[0]} each\n`))
      const world = await buildSettledAcademy({ log: (m) => console.log(c.dim(`  ${m}`)) })
      const dir = await runDir('live')
      await mkdir(HOME, { recursive: true })
      await mkdir(join(dir, 'diary'), { recursive: true })

      await saveRun(dir, {
        suite: 'live',
        model: env.MODEL_MAIN,
        startedAt: new Date().toISOString(),
        academyId: world.academyId,
        note:
          `One week at ${'Ace Tennis Academy'}, driven from four seats by readers who cannot see the ` +
          `database. The owner coaches: Rahul holds an academy_admin row and a coach row over one ` +
          `person. Four families on the books, last month settled, this month open. Nothing here is ` +
          `scripted — the sentences were composed by somebody reading the reply.`,
        turns: [],
      })

      const startedAt = (await clock.now(world.academyId)).toISOString()
      const session: Session = {
        dir,
        academyId: world.academyId,
        days,
        day: 1,
        contacts: world.contacts,
        roster: world.roster,
        cursor: Object.fromEntries(Object.keys(PERSONAS).map((k) => [k, startedAt])),
        startedAt,
      }
      await writeSession(session)
      await writeFile(POINTER, dir)
      await writeFile(
        join(dir, 'personas.json'),
        JSON.stringify({ personas: PERSONAS, schedule: SCHEDULE, windowAt: WINDOW_AT, inputRealism: INPUT_REALISM }, null, 2),
      )

      // Materialise the timetable before anybody speaks, so day 1 is a business
      // with sessions in it rather than one whose first question has no answer.
      const jobs = await drain(world.academyId)
      console.log(`  academy  ${world.academyId}`)
      console.log(`  record   ${dir}`)
      console.log(`  clock    ${clock.inZone(await clock.now(world.academyId), TZ).label}`)
      console.log(`  jobs     ${jobs.length} ran`)
      console.log(c.dim(`\n  seats: ${Object.values(PERSONAS).map((p) => `${p.key} (${p.seat})`).join(', ')}\n`))
      break
    }

    /* ---------------------------------------------------------- window */
    case 'window': {
      const s = await readSession()
      const w = (flag('window') ?? 'morning') as WindowName
      const day = Number(flag('day') ?? s.day)
      s.day = day
      await writeSession(s)
      const jobs = await withLock(`window:${day}:${w}`, () => walkTo(s.academyId, WINDOW_AT[w]))
      const here = clock.inZone(await clock.now(s.academyId), TZ)
      await appendFile(
        join(s.dir, 'days.jsonl'),
        JSON.stringify({ day, window: w, at: here.label, jobs }) + '\n',
      )
      console.log(`  day ${day} ${w} — ${here.label}`)
      console.log(`  seats: ${(SCHEDULE[day]?.[w] ?? []).join(', ') || '(none)'}`)
      console.log(`  jobs: ${jobs.length ? [...new Set(jobs)].join(', ') : 'none'}`)
      break
    }

    /* ---------------------------------------------------------- endday */
    case 'endday': {
      const s = await readSession()
      const jobs = await withLock(`endday:${s.day}`, async () => {
        const a = await walkTo(s.academyId, '23:30')
        const b = await drain(s.academyId)
        await clock.advance(45 * 60_000, s.academyId)
        const cc = await drain(s.academyId)
        return [...a, ...b, ...cc]
      })
      const unprompted = await q<any>(
        s.academyId,
        `select p.full_name as who, m.body, coalesce(m.origin,'?') as origin, m.status,
                m.suppressed_reason as suppressed
           from message m join contact ct on ct.id = m.contact_id join person p on p.id = ct.person_id
          where m.direction = 'outbound' and m.created_at >= app.now() - interval '26 hours'
            and coalesce(m.origin,'') = 'job'
          order by m.created_at asc`,
      )
      await appendFile(
        join(s.dir, 'days.jsonl'),
        JSON.stringify({ day: s.day, window: 'overnight', jobs, unprompted }) + '\n',
      )
      s.day += 1
      await writeSession(s)
      console.log(`  day closed. jobs: ${jobs.length ? [...new Set(jobs)].join(', ') : 'none'}`)
      console.log(`  standing messages sent unprompted: ${unprompted.length}`)
      console.log(`  next day: ${s.day} — ${clock.inZone(await clock.now(s.academyId), TZ).label}`)
      break
    }

    /* ----------------------------------------------------------- brief */
    case 'brief': {
      const s = await readSession()
      const key = positionals()[0] as PersonaKey
      if (!PERSONAS[key]) die(`no such seat: ${key}. One of ${Object.keys(PERSONAS).join(', ')}`)
      const p = PERSONAS[key]
      const day = Number(flag('day') ?? s.day)
      const here = clock.inZone(await clock.now(s.academyId), TZ)
      const diaryPath = join(s.dir, 'diary', `${key}.md`)
      const diary = existsSync(diaryPath) ? await readFile(diaryPath, 'utf8') : ''
      const seen = await readPhone(s, key, true)

      const L: string[] = []
      L.push(`YOU ARE ${p.name.toUpperCase()} — ${p.oneLine}`)
      L.push('')
      L.push(p.who.trim())
      L.push('')
      L.push('HOW YOU TYPE')
      L.push(p.voice.trim())
      L.push('')
      L.push(p.typing.trim())
      L.push('')
      L.push('THE MEDIUM')
      L.push(INPUT_REALISM.trim())
      L.push('')
      L.push('WHAT YOU WANT OUT OF THIS WEEK')
      for (const g of p.goals) L.push(`  - ${g}`)
      L.push('')
      L.push('WHAT WOULD MAKE YOU COMPLAIN OR LEAVE')
      for (const r of p.redLines) L.push(`  - ${r}`)
      L.push('')
      L.push(`TODAY — day ${day}, ${here.label}`)
      L.push(`  ${p.life[day] ?? 'Nothing unusual is happening to you today.'}`)
      L.push('')
      L.push('YOUR NOTEBOOK SO FAR')
      L.push(diary.trim() ? diary.trim().split('\n').map((l) => `  ${l}`).join('\n') : '  (empty — this is your first time)')
      L.push('')
      L.push('ON YOUR PHONE, SINCE YOU LAST LOOKED')
      L.push(renderPhone(seen))
      const text = L.join('\n')
      console.log(text)
      await logSeat(s, { persona: key, cmd: 'brief', shownMessages: seen.length })
      break
    }

    /* ------------------------------------------------------------- say */
    case 'say': {
      const s = await readSession()
      const key = positionals()[0] as PersonaKey
      const text = positionals().slice(1).join(' ').trim()
      if (!PERSONAS[key]) die(`no such seat: ${key}`)
      if (!text) die('say what?')
      const seen = await drive(s, key, { say: text, kind: 'say' }, async () => {
        await inboundFromContact({ contactId: s.contacts[key]!, text })
      })
      console.log(`  you → Class Manager:  ${text}\n`)
      console.log(renderPhone(seen))
      await logSeat(s, { persona: key, cmd: 'say', said: text, shown: seen })
      break
    }

    /* ------------------------------------------------------------- tap */
    case 'tap': {
      const s = await readSession()
      const key = positionals()[0] as PersonaKey
      const title = positionals().slice(1).join(' ').trim()
      if (!PERSONAS[key]) die(`no such seat: ${key}`)
      if (!title) die('tap what? Give the exact words on the button.')

      /**
       * Resolve a button by the words printed on it, newest message first —
       * because that is the only handle the person has. A seat that had to pass
       * an action id would be a seat with the database in it.
       */
      const rows = await q<any>(
        s.academyId,
        `select m.created_at, m.payload from message m
          where m.direction = 'outbound' and m.contact_id = '${s.contacts[key]}'::uuid
            and m.suppressed_reason is null
          order by m.created_at desc limit 12`,
      )
      let actionId: string | null = null
      for (const m of rows) {
        const p = m.payload ?? {}
        const cands = [
          ...(Array.isArray(p.buttons) ? p.buttons : []),
          ...(Array.isArray(p.list?.sections) ? p.list.sections.flatMap((x: any) => x?.rows ?? []) : []),
        ]
        const hit = cands.find(
          (b: any) => String(b?.title ?? '').trim().toLowerCase() === title.toLowerCase(),
        )
        if (hit?.actionId) {
          actionId = String(hit.actionId)
          break
        }
      }
      if (!actionId) {
        // What the person would experience: they cannot find that button. Not an
        // error in the harness — a fact about the conversation, and it is logged.
        console.log(`  there is no button saying "${title}" on your phone.`)
        await logSeat(s, { persona: key, cmd: 'tap', title, resolved: false })
        break
      }

      const seen = await drive(s, key, { say: title, kind: 'tap' }, async () => {
        await inboundFromContact({ contactId: s.contacts[key]!, actionId: actionId! })
      })
      console.log(`  you tapped:  [ ${title} ]\n`)
      console.log(renderPhone(seen))
      await logSeat(s, { persona: key, cmd: 'tap', title, resolved: true, shown: seen })
      break
    }

    /* ----------------------------------------------------------- inbox */
    case 'inbox': {
      const s = await readSession()
      const key = positionals()[0] as PersonaKey
      if (!PERSONAS[key]) die(`no such seat: ${key}`)
      const seen = await readPhone(s, key, true)
      console.log(renderPhone(seen))
      await logSeat(s, { persona: key, cmd: 'inbox', shown: seen })
      break
    }

    /* ----------------------------------------------------------- clock */
    case 'clock': {
      const s = await readSession()
      const here = clock.inZone(await clock.now(s.academyId), TZ)
      console.log(`  ${here.label}  (day ${s.day} of ${s.days})`)
      break
    }

    /* ------------------------------------------------------------ note */
    case 'note': {
      const s = await readSession()
      const key = positionals()[0] as PersonaKey
      if (!PERSONAS[key]) die(`no such seat: ${key}`)
      const kind = flag('kind') ?? 'note'
      const text = flag('text') ?? positionals().slice(1).join(' ')
      if (!text.trim()) die('a note needs --text')
      const here = clock.inZone(await clock.now(s.academyId), TZ)
      await appendFile(
        join(s.dir, 'notes.jsonl'),
        JSON.stringify({
          at: here.label,
          day: s.day,
          persona: key,
          seat: PERSONAS[key].seat,
          kind,
          text: text.trim(),
        }) + '\n',
      )
      console.log(`  noted (${kind}).`)
      break
    }

    /* ----------------------------------------------------------- diary */
    case 'diary': {
      const s = await readSession()
      const key = positionals()[0] as PersonaKey
      if (!PERSONAS[key]) die(`no such seat: ${key}`)
      const text = flag('text') ?? positionals().slice(1).join(' ')
      if (!text.trim()) die('a diary entry needs --text')
      const here = clock.inZone(await clock.now(s.academyId), TZ)
      await appendFile(join(s.dir, 'diary', `${key}.md`), `\n**day ${s.day} · ${here.label}** — ${text.trim()}\n`)
      console.log('  written down.')
      break
    }

    /* ----------------------------------------------------------- close */
    case 'close': {
      const s = await readSession()
      const world = await q<any>(
        s.academyId,
        `select (select count(*) from person) people,
                (select count(*) from player where active) players,
                (select count(*) from enrollment where ended_on is null) enrolled,
                (select count(*) from session) sessions,
                (select count(*) from session where status='cancelled') cancelled,
                (select count(*) from attendance) marked,
                (select count(*) from tally_line) lines,
                (select coalesce(sum(amount),0) from tally_line) billed,
                (select count(*) from payment where status='confirmed') payments,
                (select coalesce(sum(amount),0) from payment where status='confirmed') paid,
                (select count(*) from message where direction='outbound') sent,
                (select count(*) from message where status='failed') failed,
                (select count(*) from message where suppressed_reason is not null) suppressed,
                (select count(*) from business_rule) rules,
                (select count(*) from comm_preference where released_at is null) mutes,
                (select count(*) from job where status='failed') job_failures,
                (select count(*) from audit_entry) audited`,
      )
      const days = await readJsonl(join(s.dir, 'days.jsonl'))
      const notes = await readJsonl(join(s.dir, 'notes.jsonl'))
      const seat = await readJsonl(join(s.dir, 'seat.jsonl'))
      const diaries: Record<string, string> = {}
      for (const k of Object.keys(PERSONAS)) {
        const p = join(s.dir, 'diary', `${k}.md`)
        if (existsSync(p)) diaries[k] = await readFile(p, 'utf8')
      }

      const rec = await reopenRun(s.dir, {
        academyId: s.academyId,
        q: (sql: string) => q(s.academyId, sql),
        domainNow: () => clock.now(s.academyId),
      })
      const { run } = await rec.close({
        world: world[0] as Record<string, unknown>,
        days,
        extra: {
          personas: PERSONAS,
          inputRealism: INPUT_REALISM,
          schedule: SCHEDULE,
          roster: s.roster,
          notes,
          diaries,
          // Every command each seat ran, with what it was shown. The blindfold,
          // auditable: a reader can see that no seat ever asked the database
          // anything, rather than being told so.
          seatLog: seat,
        },
      })

      const cost = run.turns.reduce((a: number, t: any) => a + (t.inr ?? 0), 0)
      console.log(`\n  ${c.bold(`${run.turns.length} turns`)} · ${c.bold(`₹${cost.toFixed(2)}`)} · record ${s.dir}`)
      console.log(c.dim(`  node scripts/report.mjs --run ${s.dir}`))
      break
    }

    /* ---------------------------------------------------------- teardown */
    case 'drop': {
      const s = await readSession()
      await dropAcademy(s.academyId).catch((e) => console.log(`  ${(e as Error).message}`))
      await rm(POINTER, { force: true })
      console.log(`  dropped ${s.academyId}`)
      break
    }

    case 'where': {
      const s = await readSession()
      console.log(s.dir)
      break
    }

    /* ---------------------------------------------------------- roster */
    case 'roster': {
      const s = await readSession()
      for (const r of s.roster) console.log(`  ${r.name.padEnd(18)} ${r.role.padEnd(16)} ${r.phone}`)
      break
    }

    default:
      console.log(`
  live — drive the product from a seat that cannot see the database.

  orchestrator
    open [--days 7]                 build the academy and start the record
    window --day N --window W       move the clock to that window, run standing jobs
    endday                          close the day out, run the overnight jobs
    close                           fold in the world, the notes and the diaries
    roster | where | drop

  seat  (this is all a persona may run)
    brief <who> [--day N]           who you are, what you want, and your phone
    say <who> "…"                   send a message, see the reply
    tap <who> "<the words on the button>"
    inbox <who>                     anything that arrived on its own
    clock                           what day and time it is
    note <who> --kind <k> --text "…"   how that felt, in your words
    diary <who> --text "…"          what you want to remember for tomorrow
`)
  }
  process.exit(0)
}

async function readJsonl(path: string): Promise<any[]> {
  if (!existsSync(path)) return []
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { unparseable: l }
      }
    })
}

await main()

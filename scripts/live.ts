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
 * WHERE THE SEAT ITSELF LIVES
 * -----------------------------------------------------------------------------
 * `scripts/_seat.ts`. The blindfold, the phone, the clock walk and the turn are
 * that file's, and this one is the commands a person types at them — because the
 * agent week that is coming sits in the same seat, and two copies of a blindfold
 * is one copy that quietly forgets the suppression clause.
 *
 * WHY THE TURNS ARE NO LONGER SERIALISED
 * -----------------------------------------------------------------------------
 * Three seats can be occupied at once and in a real academy they are. Every turn
 * here used to queue behind a lock file, for one reason: the record was a
 * read-modify-write of `record.json`, so two seats speaking at once each read the
 * file, each appended one turn, and the second write erased the first. A week
 * with four people in it was driven one sentence at a time, thirty seconds of
 * model call each, because of how the recorder happened to store things.
 *
 * `_capture.ts` appends ONE LINE per turn now and `_derive.ts` numbers the log by
 * append order, so there is nothing left to erase and nothing left to queue for.
 * The lock survives for the two pieces of state that are still shared and still
 * rewritten whole: the academy clock, which `window` and `endday` move, and
 * `session.json`'s `day`. Both are held for the length of the write.
 *
 * What is NOT solved by any of that is attribution: `_capture.ts` windows a
 * turn's evidence by domain time — everything stamped at or after the moment the
 * turn began — so two seats speaking in the same instant each collect the other's
 * messages and audit rows. Read the record accordingly.
 */
import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { loadEnvFiles, c } from './_env'
/**
 * The seat, shared with the agent week. It loads the environment and forces the
 * emulator transport itself, on the same reasoning as the line below — a module
 * body runs before the body of whatever imported it, so it cannot rely on this
 * file having done it.
 */
import {
  POINTER,
  SEAT_HOME,
  TZ,
  die,
  drain,
  drive,
  logSeat,
  q,
  queueTurn,
  readPhone,
  readSession,
  renderPhone,
  updateSession,
  walkTo,
  withLock,
  writeSession,
  type Session,
} from './_seat'

loadEnvFiles()
/**
 * Not optional garnish. `.env.local` ships `TRANSPORT=cloud`, and a drive that
 * takes the cloud path hard-fails at the credential gate and measures nothing —
 * every turn reports an error, zero tools, an empty reply, and it reads exactly
 * like a broken model.
 */
process.env.TRANSPORT = 'emulator'

const { dropAcademy, inboundFromContact } = await import('@/lib/seed')
const { reopenRun, saveRun, runDir } = await import('./_capture')
const clock = await import('@/lib/clock')
const { env } = await import('@/lib/env')
const { buildSettledAcademy } = await import('./_world')
const { PERSONAS, SCHEDULE, WINDOW_AT, windowCounts, INPUT_REALISM } = await import('./_personas')
/**
 * The five-tier ramp, as an overlay on `life` rather than a second persona file.
 *
 * `SIM_RAMP=1` swaps what happens TO each person on each day for `_ramp.ts`'s
 * version, and changes nothing else — same seats, same blindfold, same voices,
 * same record. Off by default so a plain `live` week is unaffected.
 */
const { RAMP_LIFE, TIERS } = await import('./_ramp')
const RAMP = process.env.SIM_RAMP === '1'
type PersonaKey = import('./_personas').PersonaKey
type WindowName = import('./_personas').Window

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
      await mkdir(SEAT_HOME, { recursive: true })
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

      /**
       * No cursor map. Every persona's phone starts at `startedAt` and moves in
       * `cursors/<persona>` from their first look onward — one file per seat, so
       * no seat can write another's mark back to where it used to be. `_seat.ts`
       * says what that cost when they shared one blob.
       */
      const startedAt = (await clock.now(world.academyId)).toISOString()
      const session: Session = {
        dir,
        academyId: world.academyId,
        days,
        day: 1,
        contacts: world.contacts,
        roster: world.roster,
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
      // Recorded as turn 1: it is the first thing the product does in this run,
      // it costs money, and a run whose opening move is missing from its own
      // record starts by understating itself.
      const jobs = await queueTurn(session, 'd1-open-queue', () => drain(world.academyId))
      console.log(`  academy  ${world.academyId}`)
      console.log(`  record   ${dir}`)
      console.log(`  clock    ${clock.inZone(await clock.now(world.academyId), TZ).label}`)
      console.log(`  jobs     ${jobs.length} ran`)
      console.log(c.dim(`\n  seats: ${Object.values(PERSONAS).map((p) => `${p.key} (${p.seat})`).join(', ')}\n`))
      break
    }

    /* ---------------------------------------------------------- window */
    case 'window': {
      const w = (flag('window') ?? 'morning') as WindowName
      // Read, changed and written under the lock, because `day` is the one field
      // of the session two commands still both write.
      const s = await updateSession((cur) => {
        cur.day = Number(flag('day') ?? cur.day)
      })
      const day = s.day
      /**
       * `--at HH:MM` overrides the window's default hour.
       *
       * The two fixed hours cannot express the moments a real academy is actually
       * lived at: a coach asking who is in tonight has to ask BEFORE the six
       * o'clock class, and 20:15 is an hour after it finished. A window that can
       * only land after the thing it is about measures the harness.
       */
      const at = flag('at') || WINDOW_AT[w]
      // Under the lock because the WALK is: it moves the academy clock, which
      // every seat shares, and two windows opened at once would each advance past
      // the other's target and drain the day in an order neither asked for.
      const jobs = await withLock(`window:${day}:${w}`, () =>
        queueTurn(s, `d${day}-${w}-queue`, () => walkTo(s.academyId, at)),
      )
      const here = clock.inZone(await clock.now(s.academyId), TZ)
      await appendFile(
        join(s.dir, 'days.jsonl'),
        JSON.stringify({ day, window: w, at: here.label, jobs }) + '\n',
      )
      console.log(`  day ${day} ${w} — ${here.label}`)
      if (RAMP && TIERS[day]) console.log(`  tier ${day} · ${TIERS[day]!.name} — ${TIERS[day]!.what}`)
      console.log(`  seats: ${(SCHEDULE[day]?.[w] ?? []).join(', ') || '(none)'}`)
      console.log(`  jobs: ${jobs.length ? [...new Set(jobs)].join(', ') : 'none'}`)
      break
    }

    /* ---------------------------------------------------------- endday */
    case 'endday': {
      const s = await readSession()
      const jobs = await withLock(`endday:${s.day}`, () =>
        queueTurn(s, `d${s.day}-overnight-queue`, async () => {
          const a = await walkTo(s.academyId, '23:30')
          const b = await drain(s.academyId)
          await clock.advance(45 * 60_000, s.academyId)
          const cc = await drain(s.academyId)
          return [...a, ...b, ...cc]
        }),
      )
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
      // Re-read under the lock rather than incremented on the copy above: this
      // command has been running for the length of a walk, and writing a whole
      // session back from memory would put every other field back where it was
      // when the day started.
      const next = await updateSession((cur) => {
        cur.day += 1
      })
      console.log(`  day closed. jobs: ${jobs.length ? [...new Set(jobs)].join(', ') : 'none'}`)
      console.log(`  standing messages sent unprompted: ${unprompted.length}`)
      console.log(`  next day: ${next.day} — ${clock.inZone(await clock.now(s.academyId), TZ).label}`)
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
      // The tier is never named to the seat. A persona who has been told today is
      // "the hard one" stops being a persona and starts being a test case.
      const today = (RAMP ? RAMP_LIFE[key]?.[day] : undefined) ?? p.life[day]
      L.push(`  ${(today ?? 'Nothing unusual is happening to you today.').trim()}`)
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

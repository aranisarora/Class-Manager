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
 * WHY THIS EXISTS BESIDE `sim`
 * -----------------------------------------------------------------------------
 * `sim` scripts twenty-eight sentences and posts them in order. Whatever
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
  WorldGone,
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
const { phonebookLookup, phonebookNames } = await import('@/lib/phonebook')
const { bodyWithSharedContacts } = await import('@/lib/messaging/contact-card')
const { reopenRun, saveRun, runDir } = await import('./_capture')
const clock = await import('@/lib/clock')
const { env } = await import('@/lib/env')
const { WINDOW_AT, INPUT_REALISM, briefsFor } = await import('./_personas')
/**
 * The same world file `sim.ts` drives, because the seat is one implementation.
 *
 * A person sitting in `live` and a model sitting in `sim` must be sitting in the
 * SAME seat, in the same world, or the human read and the recorded week are about
 * two different products. That is why the blindfold lives in `_seat.ts` rather
 * than in either instrument, and it is why this file no longer has an academy of
 * its own: `buildSettledAcademy` in `_world.ts` was a second hand-built business
 * beside the one `_world-spec.ts` built, with its own timetable, its own families
 * and its own drift.
 */
const { buildWorld, deriveSchedule, describeWorld, loadWorld, windowsPerSeat } =
  await import('./_world-file')
/** A seat key, derived from a name in the world file: `Rahul Menon` → `rahul-menon`. */
type PersonaKey = string
type WindowName = import('./_personas').Window
type Brief = import('./_personas').Brief

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
  /**
   * The seats of the OPEN run, read back out of its own record.
   *
   * They used to come from `PERSONAS` — four humans compiled into the binary — so
   * every `live` session was about the same four people whatever world was open.
   * Now a run writes its own `personas.json` when it opens, and every command
   * below reads that: whoever is in the world file is who a tester can sit in.
   */
  const seatsOf = async (
    sess: Session,
  ): Promise<{ people: Record<string, Brief>; schedule: Record<number, Record<WindowName, string[]>> }> => {
    const raw = await readFile(join(sess.dir, 'personas.json'), 'utf8').catch(() => '{}')
    const parsed = JSON.parse(raw) as {
      personas?: Record<string, Brief>
      schedule?: Record<number, Record<WindowName, string[]>>
    }
    return { people: parsed.personas ?? {}, schedule: parsed.schedule ?? {} }
  }

  switch (cmd) {
    /* ------------------------------------------------------------ open */
    case 'open': {
      const days = Number(flag('days') ?? 7)
      /**
       * The same world file the agent week drives, defaulting to `blank`.
       *
       * A person sitting here and a model sitting in `sim` have to be in the same
       * world or the human's read and the recorded week are about two different
       * products. `live` used to build a settled academy of its own — a second
       * hand-written business with its own timetable and its own drift — and it
       * went with every other fixture.
       */
      let loaded
      try {
        loaded = loadWorld(flag('world') ?? 'blank')
      } catch (e) {
        die((e as Error).message)
      }
      const spec = loaded.world
      const windows = Object.keys(WINDOW_AT) as WindowName[]
      const briefs = briefsFor({ people: spec.people, worldName: spec.name, days })
      let schedule
      try {
        schedule = deriveSchedule(briefs.map((b) => b.key), days, windows)
      } catch (e) {
        die((e as Error).message)
      }
      const counts = windowsPerSeat(schedule, { days, windows })
      const spread = Object.values(counts)

      console.log(
        c.bold(
          `\n  live — ${days} days, ${spread.reduce((a, b) => a + b, 0)} seat windows over ${briefs.length} seats\n`,
        ),
      )
      console.log(c.dim(`  world: ${describeWorld(spec)}\n`))
      const token = Math.random().toString(36).slice(2, 6)
      const world = await buildWorld(spec, { token, log: (m) => console.log(c.dim(`  ${m}`)) })
      const dir = await runDir('live')
      await mkdir(SEAT_HOME, { recursive: true })
      await mkdir(join(dir, 'diary'), { recursive: true })

      await saveRun(dir, {
        suite: 'live',
        model: env.MODEL_MAIN,
        startedAt: new Date().toISOString(),
        academyId: world.frontDeskId,
        note:
          `One week from ${loaded.ref}, driven from ${briefs.length} seats by readers who cannot see ` +
          `the database. It opens at a front desk with nobody in a business: whatever gets built is ` +
          `built by talking to it. Nothing here is scripted — the sentences were composed by ` +
          `somebody reading the reply.`,
        turns: [],
      })

      /**
       * No cursor map. Every persona's phone starts at `startedAt` and moves in
       * `cursors/<persona>` from their first look onward — one file per seat, so
       * no seat can write another's mark back to where it used to be. `_seat.ts`
       * says what that cost when they shared one blob.
       */
      const startedAt = (await clock.now(world.frontDeskId)).toISOString()
      const session: Session = {
        dir,
        academyId: world.frontDeskId,
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
        JSON.stringify(
          {
            personas: Object.fromEntries(briefs.map((b) => [b.key, b])),
            schedule,
            windowAt: WINDOW_AT,
            inputRealism: INPUT_REALISM,
          },
          null,
          2,
        ),
      )

      // Materialise the timetable before anybody speaks, so day 1 is a business
      // with sessions in it rather than one whose first question has no answer.
      // Recorded as turn 1: it is the first thing the product does in this run,
      // it costs money, and a run whose opening move is missing from its own
      // record starts by understating itself.
      const jobs = await queueTurn(session, 'd1-open-queue', () => drain(world.frontDeskId))
      console.log(`  number   ${world.senderPhone}`)
      console.log(`  desk     ${world.frontDeskId}`)
      console.log(`  record   ${dir}`)
      console.log(`  clock    ${clock.inZone(await clock.now(world.frontDeskId), TZ).label}`)
      console.log(`  jobs     ${jobs.length} ran`)
      console.log(c.dim(`\n  seats: ${briefs.map((p) => `${p.key} (${p.seat})`).join(', ')}\n`))
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
      console.log(`  seats: ${((await seatsOf(s)).schedule[day]?.[w] ?? []).join(', ') || '(none)'}`)
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
      const { people } = await seatsOf(s)
      if (!people[key]) die(`no such seat: ${key}. One of ${Object.keys(people).join(', ')}`)
      const p = people[key]!
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
      const today = p.life[day]
      L.push(`  ${(today ?? 'Nothing unusual is happening to you today.').trim()}`)
      L.push('')
      L.push('YOUR NOTEBOOK SO FAR')
      L.push(diary.trim() ? diary.trim().split('\n').map((l) => `  ${l}`).join('\n') : '  (empty — this is your first time)')
      L.push('')
      L.push('ON YOUR PHONE, SINCE YOU LAST LOOKED')
      L.push(renderPhone(seen))
      L.push('')
      // Their handset's own address book. A fact about the phone rather than about
      // the academy, so it passes the blindfold — and without it `share` is a
      // command aimed at nobody. Names only: see `lib/phonebook.ts`.
      L.push('SAVED IN YOUR CONTACTS  (npx tsx scripts/live.ts share <you> "<name>")')
      const book = phonebookNames(s.academyId)
      L.push(book.length ? book.map((n) => `  ${n}`).join('\n') : '  (nobody)')
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
      const who = (await seatsOf(s)).people[key]
      if (!who) die(`no such seat: ${key}`)
      if (!text) die('say what?')
      const seen = await drive(s, key, { say: text, kind: 'say', who: who.name, seat: who.seat }, async () => {
        await inboundFromContact({ contactId: s.contacts[key]!, text })
      })
      console.log(`  you → Class Manager:  ${text}\n`)
      console.log(renderPhone(seen))
      await logSeat(s, { persona: key, cmd: 'say', said: text, shown: seen })
      break
    }

    /* ----------------------------------------------------------- share */
    /**
     * Attach somebody out of your own contacts, the way you tap the paperclip and
     * pick a person.
     *
     *   npx tsx scripts/live.ts share divya "Vandana Achar"
     *   npx tsx scripts/live.ts share rahul "Feroz Mirza" --say "this is the new coach"
     *
     * BY NAME, and the name is the only handle — the same rule `tap` follows, and
     * for the same reason: a seat that had to pass a phone number would be a seat
     * with the harness in it. The number comes from `phonebookLookup`, which only
     * ever answers with one derived from this academy's own id, so a human seat
     * cannot hand the product a number another tenant already holds either.
     *
     * A name that is not in the book prints what the person would experience —
     * they cannot find them — rather than an error, and logs it. That is a fact
     * about the conversation, exactly as an unresolvable button title is.
     */
    case 'share': {
      const s = await readSession()
      const key = positionals()[0] as PersonaKey
      const name = positionals().slice(1).join(' ').trim()
      const caption = flag('say')
      const sharer = (await seatsOf(s)).people[key]
      if (!sharer) die(`no such seat: ${key}`)
      if (!name) die('share who? Give the name as it is saved in your contacts.')

      const hit = phonebookLookup(s.academyId, name)
      if (!hit) {
        console.log(`  there is nobody called "${name}" in your contacts.`)
        console.log(`  you have: ${phonebookNames(s.academyId).join(', ')}`)
        await logSeat(s, { persona: key, cmd: 'share', name, resolved: false })
        break
      }

      const wire = bodyWithSharedContacts(caption, [hit]) ?? ''
      const seen = await drive(s, key, { say: wire, kind: 'say' }, async () => {
        await inboundFromContact({
          contactId: s.contacts[key]!,
          contacts: [hit],
          ...(caption ? { text: caption } : {}),
        })
      })
      console.log(`  you → Class Manager:  ${wire}\n`)
      console.log(renderPhone(seen))
      await logSeat(s, { persona: key, cmd: 'share', name, resolved: true, shared: hit.name, shown: seen })
      break
    }

    /* ------------------------------------------------------------- tap */
    case 'tap': {
      const s = await readSession()
      const key = positionals()[0] as PersonaKey
      const title = positionals().slice(1).join(' ').trim()
      const me = (await seatsOf(s)).people[key]
      if (!me) die(`no such seat: ${key}`)
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

      const seen = await drive(s, key, { say: title, kind: 'tap', who: me.name, seat: me.seat }, async () => {
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
      const me = (await seatsOf(s)).people[key]
      if (!me) die(`no such seat: ${key}`)
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
      const me = (await seatsOf(s)).people[key]
      if (!me) die(`no such seat: ${key}`)
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
          seat: me.seat,
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
      const me = (await seatsOf(s)).people[key]
      if (!me) die(`no such seat: ${key}`)
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
      const { people: closingSeats, schedule: closingSchedule } = await seatsOf(s)
      const diaries: Record<string, string> = {}
      for (const k of Object.keys(closingSeats)) {
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
          personas: closingSeats,
          inputRealism: INPUT_REALISM,
          schedule: closingSchedule,
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
    share <who> "<a name in your contacts>" [--say "…"]
                                    attach somebody's contact card
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

/**
 * A seat whose world has been deleted says so in one sentence and stops.
 *
 * `live.ts` is one command per process, so there is no loop here to break out of:
 * the person in the seat types `say`, and without this they get a stack trace
 * about a foreign key. The likely cause is a `sim gc` or a seed between two
 * commands of one session — the session on disk is intact, and the business it
 * names is not.
 */
await main().catch((e) => {
  if (e instanceof WorldGone) die(e.message)
  throw e
})

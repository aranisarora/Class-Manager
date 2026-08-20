/**
 * drive-week — one week in a settled academy, driven by the people who live in it.
 *
 *   npx tsx scripts/drive-week.ts                      # the whole week, four seats
 *   npx tsx scripts/drive-week.ts --preset smoke       # one window, two seats
 *   npx tsx scripts/drive-week.ts --days 3 --windows morning
 *   npx tsx scripts/drive-week.ts --arm B --config arms/b.json --budget-inr 250
 *   npx tsx scripts/drive-week.ts gc --hours 6         # reap this driver's stale worlds
 *
 * WHAT CHANGED, AND WHY THE SCRIPT IS GONE
 * -----------------------------------------------------------------------------
 * This file used to hold twenty-eight literal utterances — seven days, four a day
 * — and post them in order. Whatever the product replied, the twelfth sentence
 * was the twelfth sentence. That harness cannot represent the three commonest
 * things a person does: ask again because the first answer did not answer it, act
 * on a misreading, and go quiet and leave. The last one is the outcome the
 * business cares about most and no instrument here could produce it.
 *
 * So there is no script and no scripted mode. `_personas.ts` holds four people as
 * GOALS — who they are, how they type, what they want by Sunday, and what happens
 * TO them each day — `_persona-agent.ts` puts a model in the seat with nothing but
 * their phone, and this file runs the week around them. A sentence here is
 * composed by somebody who read the reply.
 *
 * The life events that used to be baked into the beats are the same events; they
 * live in `life` in `_personas.ts` now, where they are pressure rather than prose.
 * Anika's fever, Priya's Saturday, Farah's two children and her decision on Sunday
 * all still happen. Nobody is told what to type about them.
 *
 * THE WORLD IS THE SAME WORLD, AND THE TIMETABLE IS STATED ONCE
 * -----------------------------------------------------------------------------
 * **The owner coaches.** Rahul holds an `academy_admin` row AND a `coach` row over
 * one `person`, which is the business this product is sold into and the one shape
 * a role column cannot express. Every permission question worth asking lives in
 * that gap. Four families and five children behind him, so "who owes me" has a
 * shape rather than an answer, and Sanjay's two give the sibling discount a
 * stranger asks about all week somewhere real to land.
 *
 * The fixtures are NOT written here. `TIMETABLE` and `FAMILIES` in `_personas.ts`
 * are the one statement of them and this file builds its classes out of that
 * array, because the version that held its own copy drifted from the one every
 * `life` string was written against: it ran the Evening Batch on Monday and
 * WEDNESDAY, so Arjun's Wednesday brief opened "No session for you today — your
 * batch is Monday and Thursday" on a day his batch was on, and Divya's Thursday
 * brief had her daughter missing a session that did not exist. A coach told by
 * his own life that he has nothing on, in a business where he does, writes a turn
 * that reads as the product losing a class. It fabricates a defect, and a
 * fabricated defect costs a day in `lib/agent` looking for something that never
 * happened.
 *
 * Two things that copy also got wrong, both invisible in a one-day smoke run:
 * `class_academy_name_active_key` allows one ACTIVE class per name, so the second
 * `Evening Batch` row was silently a no-op guarded away by a `not exists` — four
 * literals, three classes, and a comment claiming four. And with four slots the
 * week had nothing at all on Tuesday, Thursday or Friday while the comment beside
 * it said no day was empty. Seven fixtures now, and Sunday is the only quiet day.
 *
 * WINDOWS, NOT TURNS
 * -----------------------------------------------------------------------------
 * `SCHEDULE` says who is at a phone in which window of which day, and it is
 * balanced by construction: six windows each over seven days, twenty-four seat
 * turns in all. A window runs in one order and the order is load-bearing — the
 * clock is walked ONCE, then every active seat speaks CONCURRENTLY, then the queue
 * is drained. Concurrent messages are real: three people message an academy on a
 * Tuesday evening without waiting for each other. A clock that moves while a turn
 * is in flight is not real; it is a harness artifact, and the turn it lands in
 * reads as the product answering a question about a time that had not happened
 * when the question was asked.
 *
 * CONCURRENCY IS PROCESSES, AND THAT IS FORCED
 * -----------------------------------------------------------------------------
 * `lib/agent/sql-trace.ts`'s `captureSql` saves and restores MODULE-LEVEL state,
 * so two turns awaiting the model in one process interleave their SQL into one
 * array and leave the other collecting nothing — Divya's statements in Arjun's
 * record, and Arjun's record missing its own. Both look complete; nothing throws.
 * So a seat is a child process (`_seat-worker.ts`), one per persona for the whole
 * week rather than one per turn: the start-up is paid four times instead of
 * twenty-four.
 *
 * THE QUEUE IS A TURN
 * -----------------------------------------------------------------------------
 * Every clock walk and every drain is recorded through `queueTurn`, which the old
 * version of this file did not do — it folded job names into `days` and left the
 * morning brief, the evening digest, the coach nudges and the dunning with no
 * tokens, no seconds, no SQL and no rupees against them. `lib/clock.ts` opens by
 * calling that surface "~70% of this product", and the instrument was measuring
 * the conversational third and extrapolating the whole.
 *
 * TWO OF THESE CAN RUN AT ONCE
 * -----------------------------------------------------------------------------
 * Which is the only way an A/B ever finishes, and it used not to be true in three
 * separate ways. The old start-up dropped EVERY academy called `Ace Tennis
 * Academy`, so a second drive deleted the first one's world mid-run and the first
 * run's remaining turns were all errors about a business that was not there. The
 * beat text handed out a fixed phone number, and a number known to two academies
 * on one shared sender resolves to NEITHER — silently, so the turn simply never
 * happens. And nothing ever set the clock, so a run opened wherever the last one
 * had left the offset: a week that starts at 23:32 holds its first "morning"
 * window at half past eleven at night, after every standing job for that day has
 * already fired.
 *
 * Now: the academy carries this run's token in its name, its contacts' numbers are
 * derived from its id, its clock is its own (0024's per-tenant `sim_clock` row),
 * and nothing at start-up deletes anything. Reaping stale worlds is the `gc`
 * subcommand, it has an age threshold, and it will not touch a world it cannot
 * prove this driver made.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadEnvFiles, c } from './_env'
/**
 * The seat both instruments sit in. It loads the environment and forces the
 * emulator transport in its own module body, because either file can be the
 * process's entry point and an importer's body has not run yet when this one does.
 */
import { TZ, die, drain, q, queueTurn, walkTo, writeSession, type Session } from './_seat'

loadEnvFiles()
/**
 * `.env.local` ships `TRANSPORT=cloud`. A drive that takes the cloud path
 * hard-fails at the credential gate, and every turn then reports an error, zero
 * tools and an empty reply — which reads exactly like a broken model.
 */
process.env.TRANSPORT = 'emulator'

const { createAcademy, createTestContact, dropAcademy, worldAcademyIds } = await import('@/lib/seed')
const { withSession } = await import('@/lib/db')
const { reopenRun, runDir, saveRun, writeSidecar } = await import('./_capture')
const { readTurns } = await import('./_derive')
const clock = await import('@/lib/clock')
const { FAMILIES, INPUT_REALISM, PERSONAS, SCHEDULE, TIMETABLE, WINDOW_AT, windowCounts } =
  await import('./_personas')
const { RAMP_LIFE, TIERS } = await import('./_ramp')
const { describeConfig, makeBudget, resolveConfig } = await import('./_drive-config')
const { costInr } = await import('@/lib/pricing')

type PersonaKey = import('./_personas').PersonaKey
type WindowName = import('./_personas').Window
type DriveConfig = import('./_drive-config').DriveConfig
type Ask = import('./_seat-worker').Ask
type Told = import('./_seat-worker').Told

const WORKER = fileURLToPath(new URL('./_seat-worker.ts', import.meta.url))
const ALL_PERSONAS = Object.keys(PERSONAS) as PersonaKey[]
const ALL_WINDOWS = Object.keys(WINDOW_AT) as WindowName[]

/**
 * How long a seat may take before the week gives up on it.
 *
 * Generous on purpose. The model client's own ceiling is 120s per HTTP call with
 * one retry, and a brain turn behind it can be a dozen rounds — so anything under
 * about ten minutes would be killing slow turns and recording them as harness
 * faults, which is a fabricated finding. This is here for the hang, not for the
 * wait: without it one wedged child stops the week and nothing says why.
 */
const MOVE_TIMEOUT_MS = 15 * 60_000

/** The business. The four base36 characters after it are the run's own token. */
const NAME = 'Ace Tennis Academy'
/**
 * Every world this driver has made, and nothing else — built from `NAME` so the
 * two cannot drift apart. A bare `Ace Tennis Academy` does not match, which is
 * deliberate: `_world.ts` builds one, and `gc` must never reap a world it cannot
 * prove came from here.
 */
const MINE = new RegExp(`^${NAME} [0-9a-z]{4}$`)

const NO_SPEND = { promptTokens: 0, outputTokens: 0, cachedTokens: 0 }

/* ========================================================================== *
 * THE WORLD
 * ========================================================================== */

type BuiltWorld = {
  academyId: string
  contacts: Record<string, string>
  roster: { name: string; role: string; contactId: string; phone: string }[]
}

/**
 * The settled academy this week happens in, named for this run.
 *
 * Nothing is dropped here. A start-up path that deletes by NAME cannot tell a
 * world it made from a world another process is in the middle of driving, and the
 * failure is silent from both ends: the second drive reports a clean build, the
 * first reports every remaining turn as an error about an academy that no longer
 * exists, and neither says the word "deleted". The token in the name is what makes
 * `gc` able to reap safely later, with an age it can check.
 */
async function buildWorld(name: string, log: (s: string) => void): Promise<BuiltWorld> {
  const made = await createAcademy({ name, adminName: 'Rahul Menon', timezone: TZ, category: 'tennis' })
  const academyId = made.academyId
  const qq = (sql: string) => q(academyId, sql)
  // `inboundFromContact` walks a cached academy list; a business created a
  // millisecond ago is not in it until the cache is refreshed, and the symptom
  // would be "no such contact" rather than anything pointing here.
  await worldAcademyIds({ refresh: true })

  /**
   * Day 1 is a Monday at 06:00, on THIS academy's own clock.
   *
   * Both halves are load-bearing. The classes run on weekdays and every persona's
   * week assumes a Monday — the coach's register is a Monday register, the
   * stranger wants to watch on Saturday, the owner asks on Sunday how the week
   * went — so a run that opened on a Thursday would put the Saturday visit on a
   * Tuesday. It is also what makes the drive's DAY number the ISO WEEKDAY number,
   * which is the invariant `TIMETABLE` and every `life` key are read across:
   * `life[4]` is a Thursday and weekday 4 is the Evening Batch, in both files, or
   * one of them is lying to a persona.
   *
   * And 06:00 rather than whenever the build finished, because `walkTo`
   * cannot walk backwards: a world built at 23:32 has its "morning" window at half
   * past eleven at night, after every standing job for the day has already fired.
   *
   * Its OWN clock, because two drives sharing the world clock each walk the
   * other's day. 0024 gave every tenant a `sim_clock` row and `setTo` seeds it.
   * Set before any history is written, so every `app.now() - N days` below is
   * relative to the week that is about to happen rather than to real time.
   */
  const { DateTime } = await import('luxon')
  let monday = DateTime.now().setZone(TZ).startOf('week').set({ hour: 6, minute: 0, second: 0, millisecond: 0 })
  if (monday <= DateTime.now().setZone(TZ)) monday = monday.plus({ weeks: 1 })
  await clock.setTo(monday.toJSDate(), academyId)
  log(`clock set to ${monday.toFormat('EEE d LLL yyyy, HH:mm')} ${TZ}`)

  /**
   * Every number in this world is derived from its academy id.
   *
   * Every tenant shares one sender by design, and §10.1 resolves an inbound by the
   * pair (from, sender): a number held by two academies matches two contacts and
   * resolves to neither, so the message is never delivered and no error is raised
   * anywhere. The admin is included — `createAcademy` picks a free number by
   * scanning, and two drives scanning at the same moment pick the same one.
   *
   * `n` is ONE digit, and it has to stay one: `+91` then ten national digits is
   * the only shape India's E.164 has, and `+9193` plus seven of the id's digits
   * has spent exactly one. So this block holds TEN people and no more — an
   * eleventh would be a fourteen-character number that looks fine in a log and is
   * not a phone number.
   */
  const digits = academyId.replace(/\D/g, '').padEnd(9, '0')
  const phone = (n: number) => `+9193${digits.slice(0, 7)}${n}`
  await qq(`update contact set phone_e164 = '${phone(0)}', wa_id = '${phone(0).replace(/\D/g, '')}'
             where id = '${made.adminContactId}'::uuid`)

  const arjun = await createTestContact({ academyId, name: 'Arjun Shetty', role: 'coach', phone: phone(1) })
  const priya = await createTestContact({ academyId, name: 'Priya Nair', role: 'coach', phone: phone(2) })
  const divya = await createTestContact({ academyId, name: 'Divya Rao', role: 'client', phone: phone(3) })
  /**
   * Three names in the book and nothing against any of them.
   *
   * Farah's brief says she left hers on the pad under the board weeks ago and
   * nobody rang back, which is what makes her a NAMED prospect contact rather
   * than a stranger. It has to be written that way round: `person.full_name` is
   * `not null` and `createTestContact` refuses an unnamed contact, so the seat
   * cannot exist without a name the product can already read — and the brief that
   * used to say "they do not know your name" was contradicted by the database
   * before she had typed a word.
   */
  const kavita = await createTestContact({ academyId, name: 'Kavita Shah', role: 'prospect', phone: phone(4) })
  const nikhil = await createTestContact({ academyId, name: 'Nikhil Bose', role: 'prospect', phone: phone(5) })
  const farah = await createTestContact({ academyId, name: 'Farah Sheikh', role: 'prospect', phone: phone(6) })
  const meera = await createTestContact({ academyId, name: 'Meera Iyer', role: 'client', phone: phone(7) })
  const sanjay = await createTestContact({ academyId, name: 'Sanjay Gupta', role: 'client', phone: phone(8) })
  const latha = await createTestContact({ academyId, name: 'Latha Krishnan', role: 'client', phone: phone(9) })
  await worldAcademyIds({ refresh: true })

  /**
   * **The owner is also a coach**, which is the whole point of this world and the
   * one row a lifecycle arc never creates. `academy_admin` and `coach` over one
   * `person`: two hats, one head, and every "can he see this" question in the
   * product is decided by which of the two is being asked.
   */
  await qq(`
    insert into coach (academy_id, person_id, pay_amount, pay_unit, status, onboarded_at)
    values ('${academyId}'::uuid, '${made.adminPersonId}'::uuid, 0, 'per_month', 'active', app.now())
    on conflict do nothing`)

  /**
   * What the two employed coaches are paid, in two different units.
   *
   * `createTestContact` writes a coach row with no pay on it, and Rahul's week has
   * "decide whether to give Priya a raise, from what you actually pay people now"
   * in it — a question with no answer in the database is a question this week
   * cannot measure. Per session against per month, deliberately, so "what am I
   * paying everyone" cannot be answered by summing one column.
   */
  await qq(`
    update coach co set pay_amount = 600, pay_unit = 'per_session'
      from person p where p.id = co.person_id and p.full_name = 'Arjun Shetty'`)
  await qq(`
    update coach co set pay_amount = 9000, pay_unit = 'per_month'
      from person p where p.id = co.person_id and p.full_name = 'Priya Nair'`)

  await qq(`insert into venue (academy_id, name) values ('${academyId}'::uuid, 'Ace Courts')`)

  /**
   * The timetable, out of `_personas.ts` rather than out of a literal here.
   *
   * One `class` row per entry and one `class_slot` per slot, which is the shape
   * the database actually allows: `class_academy_name_active_key` is unique on
   * `(academy_id, lower(btrim(name)))` where `active`, so the previous literal —
   * one row per SLOT, with a `not exists` guard in front of it — silently made
   * three classes out of four entries and left the second Evening Batch as a slot
   * hanging off the first. Nothing failed, and the comment beside it went on
   * claiming four.
   */
  for (const cls of TIMETABLE) {
    await qq(`
      insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on, active)
      select '${academyId}'::uuid, '${cls.name}', v.id, ${cls.rate}, '${cls.unit}',
             (app.now() - interval '40 days')::date, true
        from venue v
       where v.name = 'Ace Courts'
         and not exists (select 1 from class where name = '${cls.name}' and active and ends_on is null)`)
    for (const s of cls.slots) {
      await qq(`
        insert into class_slot (academy_id, class_id, weekday, start_time, end_time)
        select '${academyId}'::uuid, c.id, ${s.weekday}, time '${s.from}', time '${s.to}'
          from class c where c.name = '${cls.name}' and c.active and c.ends_on is null`)
    }
    // Priya has the Weekend Squad AND the adult class, and Rahul is the second
    // name on the weekend — which is what makes her dropping Saturday land on
    // HIM unless somebody volunteers, and makes Arjun volunteering an offer about
    // real money rather than a favour.
    for (const who of cls.coaches) {
      await qq(`
        insert into class_coach (academy_id, class_id, coach_id)
        select '${academyId}'::uuid, c.id, co.id
          from class c, coach co join person p on p.id = co.person_id
         where c.name = '${cls.name}' and c.active and c.ends_on is null and p.full_name = '${who}'
        on conflict do nothing`)
    }
  }

  /**
   * The families, five weeks settled, so the week opens with a business behind it
   * rather than one whose first question has no rows.
   *
   * No money is written here, on purpose. `_world.ts` learned this the expensive
   * way: a fixture that billed the OPEN period had the product's own monthly job
   * bill it again on the first drain, every family's month doubled, and a parent
   * was told she owed ₹4,800. A fixture writes enrollments; anything the product
   * bills for itself, it bills.
   */
  for (const fam of FAMILIES) {
    for (const kid of fam.children) {
      await qq(`insert into person (academy_id, full_name) values ('${academyId}'::uuid, '${kid.name}')`)
      await qq(`
        insert into player (academy_id, account_id, person_id, active)
        select '${academyId}'::uuid, a.id, k.id, true
          from account a join person h on h.id = a.holder_person_id, person k
         where h.full_name = '${fam.parent}' and k.full_name = '${kid.name}'`)
      await qq(`
        insert into enrollment (academy_id, class_id, player_id, started_on)
        select '${academyId}'::uuid, c.id, pl.id, (app.now() - interval '35 days')::date
          from class c, player pl join person p on p.id = pl.person_id
         where c.name = '${kid.class}' and c.active and c.ends_on is null and p.full_name = '${kid.name}'
         limit 1`)
    }
  }
  /**
   * The parent is not a player.
   *
   * `createTestContact` gives every `client` an account AND a player over the
   * same person, which is right for an adult learner and wrong for all four of
   * these. Left in, `select count(*) from player where active` — which is the
   * `players` figure this run closes with, below — answers NINE for a business
   * with five children in it, and Rahul asking how many kids he has gets his own
   * parents counted back at him. They are not on any register (they are created
   * before the classes exist, so `createTestContact` finds nothing to enrol them
   * into), which is what makes it quiet enough to survive a smoke run.
   *
   * Retired rather than deleted, so nothing already pointing at the row breaks
   * and the state stays visible if it ever matters. The enrolment sweep beneath
   * is a no-op today and is kept for the day the ordering changes.
   */
  await qq(`
    update player pl set active = false
      from person p, account a
     where p.id = pl.person_id and a.id = pl.account_id and a.holder_person_id = p.id`)
  await qq(`
    delete from enrollment e using player pl, account a
     where e.player_id = pl.id and a.id = pl.account_id and a.holder_person_id = pl.person_id`)
  await qq(`update academy set onboarding_state = 'live' where id = '${academyId}'::uuid`)

  const roster = await q<{ name: string; role: string; contactId: string; phone: string }>(
    academyId,
    `select p.full_name as name, coalesce(c.role_hint, c.state) as role,
            c.id::text as "contactId", c.phone_e164 as phone
       from contact c join person p on p.id = c.person_id
      order by p.full_name`,
  )

  return {
    academyId,
    contacts: {
      rahul: made.adminContactId,
      arjun: arjun.contactId,
      priya: priya.contactId,
      divya: divya.contactId,
      kavita: kavita.contactId,
      nikhil: nikhil.contactId,
      farah: farah.contactId,
      meera: meera.contactId,
      sanjay: sanjay.contactId,
      latha: latha.contactId,
    },
    roster,
  }
}

/* ========================================================================== *
 * THE SEATS
 * ========================================================================== */

type Seat = {
  key: PersonaKey
  /** Ask for one move and wait for it. Starts the child if it is not up. */
  ask(a: Ask): Promise<Told>
  end(): void
}

/**
 * One persona's process, kept alive across the week and restarted if it dies.
 *
 * A dead worker costs its own turn and nothing else: the next window starts a new
 * one, which rebuilds what this person has already said from the run's own log
 * (`_seat-worker.ts`) rather than introducing itself to an academy it has been
 * talking to since Monday.
 */
function openSeat(key: PersonaKey, dir: string, cfg: DriveConfig): Seat {
  let child: ChildProcess | null = null
  let booting: Promise<void> | null = null
  const waiting = new Map<string, (t: Told) => void>()

  const failed = (id: string, error: string): Told => ({
    id, kind: 'failed', error, usage: NO_SPEND, attempts: 0, ms: 0, model: cfg.model,
  })

  const start = (): Promise<void> => {
    const ch = spawn(
      process.execPath,
      ['--import', 'tsx', WORKER, '--dir', dir, '--persona', key, '--model', cfg.model, '--seed', cfg.seed],
      {
        // stdout and stderr straight through, so a child that dies says so in the
        // terminal the week is being watched in. The fourth channel is node's IPC:
        // `--import tsx` runs the worker in THIS node process's child rather than
        // behind tsx's own wrapper, so `process.send` is really there.
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, TRANSPORT: 'emulator' },
      },
    )
    child = ch
    ch.on('message', (raw: unknown) => {
      const t = raw as Told
      if (!t || typeof t !== 'object' || typeof t.id !== 'string') return
      const done = waiting.get(t.id)
      if (!done) return
      waiting.delete(t.id)
      done(t)
    })
    ch.on('exit', (code) => {
      if (child === ch) child = null
      for (const [id, done] of [...waiting]) {
        waiting.delete(id)
        done(failed(id, `the ${key} seat exited (${code ?? 'no code'})`))
      }
    })
    return new Promise<void>((resolve) => {
      const ready = (raw: unknown) => {
        if ((raw as Told)?.kind !== 'ready') return
        ch.off('message', ready)
        resolve()
      }
      ch.on('message', ready)
      ch.once('exit', () => resolve())
    })
  }

  /**
   * Started now rather than at the first window it is needed in.
   *
   * Node's start-up, tsx's transform and this worker's imports are the same
   * seconds whenever they are paid, but paid inside a window they are added to the
   * model's latency and the two are then one number in the record. Every seat in
   * the run boots in parallel while the timetable is being materialised.
   */
  booting = start()

  return {
    key,
    async ask(a: Ask): Promise<Told> {
      if (!child) booting = start()
      if (booting) {
        await booting
        booting = null
      }
      const ch = child
      if (!ch || !ch.connected) return failed(a.id, `the ${key} seat would not start`)
      return new Promise<Told>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(a.id)
          // Killed rather than waited on: the next window starts a fresh one. What
          // it costs is this turn, and what it saves is the rest of the week.
          ch.kill()
          resolve(failed(a.id, `no answer from the ${key} seat in ${MOVE_TIMEOUT_MS / 60_000} minutes`))
        }, MOVE_TIMEOUT_MS)
        waiting.set(a.id, (t) => {
          clearTimeout(timer)
          resolve(t)
        })
        ch.send(a)
      })
    },
    end(): void {
      if (!child) return
      // Disconnecting is what the worker exits on. Nothing is in flight here: the
      // week awaits every seat before it moves the clock.
      if (child.connected) child.disconnect()
      child.unref()
      child = null
    },
  }
}

/**
 * Run `fn` over everything, at most `width` at a time, and wait for all of it.
 *
 * `cfg.concurrency` is how many seats may be mid-turn together. Below the number
 * of active seats it is a queue rather than a refusal: the window still contains
 * everybody it was supposed to, they just do not all speak at once.
 */
async function inFlight<T>(items: T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const lanes = Array.from({ length: Math.max(1, Math.min(width, queue.length)) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item)
  })
  await Promise.all(lanes)
}

/* ========================================================================== *
 * THE WEEK
 * ========================================================================== */

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  // Its own flags, so it hands `_drive-config` only the slice that file owns.
  if (argv[0] === 'gc') return collectGarbage(argv.slice(1))

  const cfg = resolveConfig(argv)

  /**
   * Balanced by construction, and asserted rather than intended.
   *
   * `windowCounts` reads `SCHEDULE`, which gives each of the four six windows over
   * seven days. A week claiming equal coverage while running eleven owner windows
   * and two client ones reports the owner's experience as though it were the
   * product's — and three of one drive's open findings were on a phone with no
   * role attached to it. The imbalance is invisible in the report it writes.
   *
   * It is fatal only for a run that drives the WHOLE schedule, because that is the
   * only run making the claim. `--preset smoke` is one window and two seats and is
   * deliberately not balanced; refusing it would be refusing the run somebody asked
   * for on the strength of a promise they did not make.
   */
  const counts = windowCounts(cfg.days)
  const spread = Object.values(counts)
  const whole = cfg.personas.length === ALL_PERSONAS.length && cfg.windows.length === ALL_WINDOWS.length
  const balance = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')
  if (whole && Math.max(...spread) !== Math.min(...spread)) {
    die(`seats are not balanced over ${cfg.days} days: ${balance}`)
  }

  console.log(c.bold(`\n  drive-week — ${describeConfig(cfg)}`))
  console.log(c.dim(`  schedule: ${balance}${whole ? '' : ' (before this run’s filters)'}\n`))

  const dir = await runDir('week')
  /**
   * The four characters `_capture.ts` puts at the end of the directory name, which
   * no other run started this minute has. Carried into the academy's name so a
   * world can be traced back to the run that made it, and so `gc` can tell one of
   * this driver's worlds from a hand-made one.
   */
  const tail = (dir.split(/[\\/]/).pop() ?? '').split('-').pop() ?? ''
  // Held to the shape `MINE` matches, so a name this driver writes is always a
  // name `gc` can reap. A world named outside that shape is one nothing reaps.
  const token = /^[0-9a-z]{4}$/.test(tail) ? tail : 'zzzz'
  const academyName = `${NAME} ${token}`

  const world = await buildWorld(academyName, (m) => console.log(c.dim(`  ${m}`)))
  const academyId = world.academyId
  const sql = (s: string) => q(academyId, s)

  const startedAt = (await clock.now(academyId)).toISOString()
  const session: Session = {
    dir,
    academyId,
    days: cfg.days,
    day: 1,
    contacts: world.contacts,
    roster: world.roster,
    startedAt,
  }
  await writeSession(session)

  await saveRun(dir, {
    suite: 'week',
    model: cfg.model,
    startedAt: new Date().toISOString(),
    academyId,
    note:
      `One settled week at ${academyName}, driven by persona agents who can see nothing but ` +
      `their own phone. The owner coaches: Rahul holds an academy_admin row and a coach row ` +
      `over one person. Nothing is scripted — every sentence was composed by somebody reading ` +
      `the reply.`,
    ...(cfg.arm ? { arm: cfg.arm } : {}),
    variant: {
      days: cfg.days,
      windows: cfg.windows,
      personas: cfg.personas,
      concurrency: cfg.concurrency,
      seed: cfg.seed,
      model: cfg.model,
      ramp: cfg.ramp,
    },
    turns: [],
  })

  /**
   * The premise, beside the record and never inside it.
   *
   * `config.json` is what was asked for before anything happened; `manifest.json`
   * is what this process believes it is. Neither is evidence, and a reader who
   * found them mixed into the turns could not tell the measurement from the
   * intention behind it. Together they are what a second run needs to be the same
   * run: `--config <that file> --seed <that seed>` reproduces the setup.
   */
  await writeSidecar(dir, 'config.json', cfg)
  await writeSidecar(dir, 'manifest.json', await manifest(cfg, academyId, academyName, dir))

  console.log(`  academy  ${academyName} — ${academyId}`)
  console.log(`  record   ${dir}`)

  // Sat down before the first window, so a seat's node start-up happens while the
  // timetable below is being materialised rather than inside a turn's stopwatch.
  const seats = new Map<PersonaKey, Seat>(cfg.personas.map((k) => [k, openSeat(k, dir, cfg)]))
  // Whatever happens to this process, the seats it started go with it. A week that
  // dies on a bad query would otherwise leave children holding open database
  // connections and an IPC channel to nobody.
  process.on('exit', () => {
    for (const seat of seats.values()) seat.end()
  })

  /**
   * Materialise the timetable before anybody speaks, so day 1 is a business with
   * sessions in it rather than one whose first question has no answer. Recorded as
   * turn 1: it is the first thing the product does in this run, it costs money,
   * and a run whose opening move is missing from its own record begins by
   * understating itself.
   */
  const opened = await queueTurn(session, 'd1-open-queue', () => drain(academyId))
  console.log(`  clock    ${clock.inZone(await clock.now(academyId), TZ).label} · ${opened.length} jobs\n`)

  /** Who has walked out, and when. A departure is an outcome, not a failure. */
  const departures: { persona: PersonaKey; day: number; window: string; say: string }[] = []
  const gone = new Set<PersonaKey>()
  /** What the seats themselves cost, which is not what the product cost. */
  const seatSpend = { inr: 0, prompt: 0, cached: 0, output: 0, moves: 0, failures: 0 }

  const budget = makeBudget(cfg)
  let counted = 0
  let countedSeats = 0
  /**
   * Rupees, read off the log rather than accumulated in memory.
   *
   * A turn's cost is priced by `_capture.ts` when it is appended, and the log is
   * what the record is made of, so summing it is the one number that cannot
   * disagree with the record's own. The seats' own tokens are added on top, in the
   * same rupees, because `lib/pricing.ts` is the one converter and a budget that
   * counted only one side of the conversation would be wrong by whatever the
   * people cost.
   */
  const settle = async (): Promise<number> => {
    const turns = await readTurns(dir)
    const total = turns.reduce((a, t) => a + (typeof t.inr === 'number' ? t.inr : 0), 0)
    // Deltas, because `spend` accumulates and the log is a running total.
    budget.spend(total - counted)
    counted = total
    budget.spend(seatSpend.inr - countedSeats)
    countedSeats = seatSpend.inr
    return total + seatSpend.inr
  }

  let stoppedBy: 'min' | 'inr' | null = null

  for (let day = 1; day <= cfg.days && !stoppedBy; day++) {
    session.day = day
    // The file on disk is what a worker reads when it is restarted mid-week; a
    // `day` left at 1 all week would be a fact on disk that is not true.
    await writeSession(session)

    const label = clock.inZone(await clock.now(academyId), TZ)
    console.log(c.bold(`  day ${day} — ${label.date}`))
    const tier = cfg.ramp ? TIERS[day] : undefined
    if (tier) console.log(c.dim(`    tier ${day} · ${tier.name} — ${tier.what}`))

    for (const w of cfg.windows) {
      /**
       * The clock moves here and nowhere else, and it moves before anybody speaks.
       *
       * `walkTo` lands on every moment the queue wants something between here and
       * the window's hour, in order, running what is due at the hour it was due —
       * a job stepped over is a morning brief, a T-60 prompt or a register that
       * never happened, and the day then reads as a quiet one.
       */
      const walked = await queueTurn(session, `d${day}-${w}-queue`, () => walkTo(academyId, WINDOW_AT[w]), {
        window: w,
      })
      const at = clock.inZone(await clock.now(academyId), TZ)
      const active = (SCHEDULE[day]?.[w] ?? []).filter((k) => cfg.personas.includes(k) && !gone.has(k))
      console.log(
        `    ${at.time} ${c.bold(w.padEnd(8))} ${c.dim(`${walked.length} jobs`)}` +
          `  ${c.dim(active.length ? active.join(', ') : '(nobody at a phone)')}`,
      )

      await inFlight(active, cfg.concurrency, async (key) => {
        const seat = seats.get(key)
        if (!seat) return
        /**
         * `life` is written against `TIMETABLE` and `FAMILIES` in `_personas.ts`,
         * which is what this world is built from, so a brief cannot name a day or
         * a person the database does not have.
         *
         * `RAMP_LIFE` overrides it under `--ramp` and is anchored to the same
         * fixtures, but it is NOT covered by that guarantee everywhere: its
         * Tuesday brief has Latha paying off LAST month's fees, and no fixture
         * here writes a closed period — the product bills the open one itself on
         * the first drain, so there is nothing behind it to settle. Read a ramped
         * arrears turn as a harness gap before filing it as a defect.
         */
        const today = (cfg.ramp ? RAMP_LIFE[key]?.[day] : undefined) ?? PERSONAS[key].life[day]
        const told = await seat.ask({
          id: `d${day}-${w}-${key}`,
          day,
          window: w,
          ...(today ? { today } : {}),
        })

        if (told.kind === 'ready') return
        seatSpend.prompt += told.usage.promptTokens
        seatSpend.cached += told.usage.cachedTokens
        seatSpend.output += told.usage.outputTokens
        seatSpend.inr +=
          costInr(told.model, told.usage.promptTokens, told.usage.cachedTokens, told.usage.outputTokens) ?? 0

        if (told.kind === 'failed') {
          seatSpend.failures += 1
          console.log(`      ${c.dim(key.padEnd(7))} ${c.red('seat failed')} ${c.dim(told.error.slice(0, 120))}`)
          return
        }
        seatSpend.moves += 1
        if (told.action === 'giveup') {
          gone.add(key)
          departures.push({ persona: key, day, window: w, say: told.say })
        }
        const what =
          told.tapped ? c.bold(`tapped [ ${told.tapped} ]`)
          : told.say ? `“${told.say.replace(/\s+/g, ' ').slice(0, 88)}”`
          : c.dim('(said nothing)')
        console.log(
          `      ${c.dim(key.padEnd(7))} ${told.action === 'giveup' ? c.red('giveup ') : told.action === 'quiet' ? c.yellow('quiet  ') : 'say    '}` +
            `${what} ${c.dim(`· ${told.arrived} back · ${Math.round(told.ms / 1000)}s`)}`,
        )
      })

      /**
       * Everything the window's own messages set off, drained where the clock
       * stands. A reply that promises a reminder promises a job, and a job that
       * runs after the record closes is a promise nothing in the record kept.
       */
      const after = await queueTurn(session, `d${day}-${w}-drain`, () => drain(academyId), { window: w })
      await appendFile(
        join(dir, 'days.jsonl'),
        JSON.stringify({ day, window: w, at: at.label, jobs: [...walked, ...after] }) + '\n',
      )

      /**
       * The budget is asked between windows, never inside one.
       *
       * `_capture.ts` attributes a turn's evidence by a domain-time cursor, so a
       * process killed between the model's write and the record's flush leaves
       * those messages, jobs and SQL attributed to nothing. Stopping here finishes
       * every turn in flight, closes the window with its drain, and leaves a run
       * that is short but whole — which is a run that can still be judged.
       */
      const spent = await settle()
      const hit = budget.exhausted()
      if (hit) {
        stoppedBy = hit.hit
        console.log(
          c.yellow(
            `    budget reached (${hit.hit === 'min' ? `${budget.elapsedMin().toFixed(0)} min` : `₹${spent.toFixed(2)}`}) — closing the record here`,
          ),
        )
        break
      }
    }
    if (stoppedBy) break

    /**
     * Close the day out past the evening digest and into the small hours, so the
     * overnight jobs run and tomorrow starts on a queue somebody has drained.
     */
    const night = await queueTurn(
      session,
      `d${day}-overnight-queue`,
      async () => {
        const a = await walkTo(academyId, '23:30')
        const b = await drain(academyId)
        await clock.advance(45 * 60_000, academyId)
        const cc = await drain(academyId)
        return [...a, ...b, ...cc]
      },
      { window: 'overnight' },
    )
    const unprompted = await sql(
      `select p.full_name as who, m.body, coalesce(m.origin,'?') as origin, m.status,
              m.suppressed_reason as suppressed
         from message m join contact ct on ct.id = m.contact_id join person p on p.id = ct.person_id
        where m.direction = 'outbound' and m.created_at >= app.now() - interval '26 hours'
          and coalesce(m.origin,'') = 'job'
        order by m.created_at asc`,
    )
    await appendFile(
      join(dir, 'days.jsonl'),
      JSON.stringify({ day, window: 'overnight', jobs: night, unprompted }) + '\n',
    )
    console.log(
      c.dim(`    overnight  ${night.length} jobs · ${unprompted.length} messages sent unprompted\n`),
    )
    await settle()
  }

  for (const seat of seats.values()) seat.end()

  /* ------------------------------------------------------------- close */

  const worldNow = await sql(
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

  const rec = await reopenRun(dir, {
    academyId,
    q: sql,
    domainNow: () => clock.now(academyId),
  })
  const { run } = await rec.close({
    world: worldNow[0] as Record<string, unknown>,
    days: await readJsonl(join(dir, 'days.jsonl')),
    extra: {
      // The briefs, so a reader can see what each person was TRYING to do before
      // judging whether they got it.
      personas: PERSONAS,
      inputRealism: INPUT_REALISM,
      schedule: SCHEDULE,
      windowAt: WINDOW_AT,
      roster: world.roster,
      // Every seat move with what the phone showed when it was made. The
      // blindfold, auditable months later rather than promised in a comment.
      seatLog: await readJsonl(join(dir, 'seat.jsonl')),
      seats: seatSpend,
      departures,
      run: {
        academyName,
        elapsedMin: Number(budget.elapsedMin().toFixed(2)),
        productInr: Number(counted.toFixed(4)),
        seatInr: Number(seatSpend.inr.toFixed(4)),
        // Which ceiling ended the run, or null because neither did. A name and two
        // numbers: how the run ended is a fact, how it went is somebody else's.
        stoppedBy,
      },
    },
  })

  const turns = run.turns.length
  const seatTurns = run.turns.filter((t) => t.persona !== 'queue').length
  console.log(
    `\n  ${c.bold(`${turns} turns`)} — ${seatTurns} from a seat, ${turns - seatTurns} from the queue · ` +
      `${c.bold(`₹${(counted + seatSpend.inr).toFixed(2)}`)} (₹${counted.toFixed(2)} product, ₹${seatSpend.inr.toFixed(2)} seats) · ` +
      `${budget.elapsedMin().toFixed(0)} min`,
  )
  if (departures.length) {
    for (const d of departures) console.log(c.red(`  ${d.persona} left on day ${d.day} (${d.window})`))
  }
  console.log(c.dim(`  node scripts/report.mjs --run ${dir}`))

  if (cfg.keep) {
    console.log(c.dim(`  kept: ${academyName} — ${academyId}`))
  } else {
    // `job` has no foreign key to `academy`, so dropping the business leaves its
    // queue behind for the next tick anywhere in the world to pick up and fail on.
    await sql(`delete from job where payload->>'academy_id' = '${academyId}'`).catch(() => null)
    await dropAcademy(academyId).catch((e) => console.log(c.red(`  could not drop ${academyId}: ${(e as Error).message}`)))
  }
  process.exit(0)
}

/* ========================================================================== *
 * GARBAGE
 * ========================================================================== */

/**
 * Drop the worlds this driver left behind, and only those.
 *
 * A run that throws part-way never reaches its teardown, so its academy survives
 * — and `--keep` leaves one deliberately. Something has to reap them, because
 * every tenant shares one sender and the numbers here are derived from an academy
 * id that no longer means anything.
 *
 * It is a COMMAND rather than a start-up step, and that is the whole point. A
 * start-up reap cannot tell a dead world from one another process is driving right
 * now, and the version of this file that reaped by name deleted a concurrent
 * drive's academy mid-run: the victim then reported every remaining turn as an
 * error about a business that was not there, and nothing anywhere said "deleted".
 *
 * Two guards. The name must carry a run token — a hand-made `Ace Tennis Academy`,
 * `_world.ts`'s, or a business somebody is using is not matched and never will be
 * — and the world must be older than the threshold. A stamp that will not parse or
 * that sits in the future is left alone, which is the safe direction: `app.now()`
 * is the tenant's clock, and a world whose clock was wound forward is a world this
 * has no honest age for.
 */
async function collectGarbage(rest: string[]): Promise<void> {
  const i = rest.findIndex((a) => a === '--hours' || a.startsWith('--hours='))
  const raw = i === -1 ? '' : rest[i]!.includes('=') ? rest[i]!.split('=')[1]! : (rest[i + 1] ?? '')
  const hours = i === -1 ? 6 : Number(raw)
  if (!Number.isFinite(hours) || hours < 0) die(`gc --hours takes a number of hours, not "${raw}"`)

  console.log(c.bold(`\n  drive-week gc — worlds matching "${NAME} <token>" older than ${hours}h\n`))
  let dropped = 0
  for (const id of await worldAcademyIds({ refresh: true })) {
    const [row] = await withSession({ role: 'service', academyId: id }, async (tx) =>
      (await tx`select name, created_at from academy where id = ${id}::uuid`) as unknown as {
        name: string
        created_at: string | Date
      }[],
    )
    if (!row || !MINE.test(row.name)) continue
    const ageH = (Date.now() - new Date(row.created_at).getTime()) / 3_600_000
    if (!(ageH >= hours)) {
      console.log(c.dim(`  keeping ${row.name} — ${Number.isFinite(ageH) ? `${ageH.toFixed(1)}h old` : 'no readable age'}`))
      continue
    }
    console.log(`  dropping ${row.name} (${ageH.toFixed(1)}h) — ${id}`)
    await withSession({ role: 'service', academyId: id }, async (tx) => {
      await tx`delete from job where payload->>'academy_id' = ${id}`
    }).catch(() => null)
    await dropAcademy(id).catch((e) => console.log(c.red(`  could not drop ${id}: ${(e as Error).message}`)))
    dropped += 1
  }
  console.log(c.dim(`\n  ${dropped} dropped\n`))
  process.exit(0)
}

/* ========================================================================== *
 * ODDS
 * ========================================================================== */

/**
 * What this process is, for a reader who comes back to the run in six months.
 *
 * The sha is what makes a comparison legitimate: two runs of "the same drive" on
 * two different commits are two different drives, and nothing else in the
 * directory would say so. No secret goes in here — the database is named by host
 * and database only, because a manifest is a file people paste into issues.
 */
async function manifest(
  cfg: DriveConfig,
  academyId: string,
  academyName: string,
  dir: string,
): Promise<Record<string, unknown>> {
  const { execFile } = await import('node:child_process')
  const git = (args: string[]): Promise<string> =>
    new Promise((resolve) =>
      execFile('git', args, { cwd: process.cwd() }, (err, out) => resolve(err ? '' : String(out).trim())),
    )

  let db = ''
  try {
    const u = new URL(process.env.DATABASE_URL ?? '')
    db = `${u.host}${u.pathname}`
  } catch {
    db = ''
  }

  return {
    suite: 'week',
    dir,
    at: new Date().toISOString(),
    git: {
      sha: await git(['rev-parse', 'HEAD']),
      branch: await git(['rev-parse', '--abbrev-ref', 'HEAD']),
      // Anything uncommitted at the moment of the run. A drive against a dirty
      // tree is not reproducible from the sha alone, and this is where that is
      // said rather than discovered.
      dirty: (await git(['status', '--porcelain'])).split('\n').filter((l) => l.trim()).length,
    },
    models: {
      // The seats run on the model under test as well, which `describeConfig` does
      // not say. An A/B on `--model` therefore changes both the brain and the
      // people talking to it, and this is the field that makes that readable.
      brain: cfg.model,
      seat: cfg.model,
      thinkingPin: process.env.PROBE_THINKING ?? null,
    },
    env: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      transport: process.env.TRANSPORT ?? null,
      database: db,
      tz: TZ,
    },
    world: { academyId, academyName },
    argv: process.argv.slice(2),
  }
}

async function readJsonl(path: string): Promise<unknown[]> {
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

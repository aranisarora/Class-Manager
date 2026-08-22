/**
 * sim — one week in a settled academy, driven by the people who live in it.
 *
 *   npx tsx scripts/sim.ts                      # the whole week, four seats
 *   npx tsx scripts/sim.ts --preset smoke       # one window, two seats
 *   npx tsx scripts/sim.ts --days 3 --windows morning
 *   npx tsx scripts/sim.ts --world blank        # the owner, alone, day one
 *   npx tsx scripts/sim.ts --world worlds/multi-coach.json
 *   npx tsx scripts/sim.ts --arm B --config arms/b.json --budget-inr 250
 *   npx tsx scripts/sim.ts gc --hours 6         # reap this driver's stale worlds
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
 * ANY OTHER ACADEMY, AND WHY THE DEFAULT ONE IS STILL BUILT BY HAND
 * -----------------------------------------------------------------------------
 * `--world` drives somebody else's business: `blank` is the owner alone the
 * morning after onboarding, and a path is a spec `scripts/_world-spec.ts` reads.
 * Without it nothing about this file changes — the same two hundred lines below
 * build the same tennis club out of `TIMETABLE` and `FAMILIES`.
 *
 * That duplication is deliberate and it is the second-cheapest option, not the
 * cheapest. `worlds/settled-tennis.json` transcribes the canonical world and could
 * in principle replace the builder below, and the brief for this change said to
 * prefer that ONLY if the result is identical row for row and only if that is
 * verified by comparing rather than assumed. It is not verified: nothing has run
 * both builders against one database and diffed the rows, and the two differ on
 * paper already — this one derives `+9193` numbers from seven digits of the
 * academy id and the spec builder derives `+9194` numbers from six, so the
 * contacts alone are not the same rows. Swapping it on the strength of a
 * transcription that `worlds/README.md` itself calls the stale copy would put
 * every `life` string in `_personas.ts` at the mercy of a JSON file nothing
 * checks. So: the canonical path is untouched, and the spec path is new code
 * beside it.
 *
 * WHO SITS IN A SPEC WORLD'S SEATS
 * -----------------------------------------------------------------------------
 * Not these four. Rahul's brief names Ace Tennis Academy, its four classes and its
 * two coaches; against a badminton club with five coaches every sentence he owns
 * is false, and a seat arguing from a false premise fabricates defects — which is
 * the exact class of harness failure `TIMETABLE`'s header describes and which cost
 * twenty-four corrections on 20 Aug 2026. So a spec world's seats are its own
 * people: `briefsFromWorld` in `_personas.ts` composes one brief per person out of
 * the spec the world was built from, so nothing in a brief can contradict the
 * database. This file writes no persona prose.
 *
 * Their week is composed here, because `SCHEDULE` is written for the four by name.
 * `deriveSchedule` deals a world's own seats across the same windows and asserts
 * the result is balanced before the run starts, on the same reasoning the
 * canonical assertion below rests on: a week that gives the owner eleven windows
 * and a client two reports the owner's experience as though it were the product's,
 * and the imbalance is invisible in the report it writes.
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
import { TZ, WorldGone, die, drain, q, queueTurn, walkTo, writeSession, type Session } from './_seat'

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
const { briefsFor, INPUT_REALISM, WINDOW_AT } = await import('./_personas')
const { buildWorld, deriveSchedule, describeWorld, keyOf, loadWorld, windowsPerSeat } =
  await import('./_world-file')
const { SEAT_EFFORT } = await import('./_persona-agent')
/**
 * Who has turned up since the run started. Imported here with the rest, because
 * it reads the database and the database is what every other import above needs
 * the environment loaded for.
 */
const { arrivals } = await import('./_arrivals')
/**
 * What happens to the business during the week — the physical facts the product
 * can only learn by being told. Imported here for the same reason `arrivals` is:
 * it reads the database.
 */
const { openEvents, readEventSpecs, validateEventSpec } = await import('./_events')
const { BLANK_WORLD, describeConfig, makeBudget, recordedConfig, resolveConfig } =
  await import('./_drive-config')
const { costInr, USD_INR } = await import('@/lib/pricing')

/** A seat key, derived from a name in the world file: `Rahul Menon` → `rahul-menon`. */
type PersonaKey = string
type Brief = import('./_personas').Brief
type World = import('./_world-file').World
type WindowName = import('./_personas').Window
type DriveConfig = import('./_drive-config').DriveConfig
type Ask = import('./_seat-worker').Ask
type Told = import('./_seat-worker').Told
type EventSpec = import('./_events').EventSpec
type EventsRuntime = import('./_events').EventsRuntime

const WORKER = fileURLToPath(new URL('./_seat-worker.ts', import.meta.url))
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

/** The canonical business. The four base36 characters after it are the run's token. */
/**
 * How `gc` recognises a world this driver made: by its SENDER, not its name.
 *
 * It used to match the academy name — `Ace Tennis Academy <token>` — because the
 * harness chose that name when it built the business. Nothing chooses a name any
 * more: a front desk is called "Front desk" by `app.front_desk_for`, and a real
 * business is called whatever a persona talked the product into calling it, which
 * is unknowable in advance and is half the point.
 *
 * What a run does still own is its own `sender` row, labelled here. Every academy
 * on that sender — the desk and everything founded through it — belongs to that
 * run and to nothing else, which is a stronger claim than a name ever was.
 */
const SENDER_LABEL = 'sim'
/**
 * Every world this driver has made, and nothing else — built from `NAME` so the
 * two cannot drift apart. A bare `Ace Tennis Academy` does not match, which is
 * deliberate: `_world.ts` builds one, and `gc` must never reap a world it cannot
 * prove came from here.
 */
const MINE = new RegExp(`^${SENDER_LABEL} [0-9a-z]{4}$`)

/**
 * The three names in the canonical book with nothing against them, and the seat
 * key each one answers to.
 *
 * A list rather than three `createTestContact` statements only so that
 * `canonicalLine()` can say "3 prospects" by counting rather than by claiming.
 * The order is the order their phone numbers are allocated in — see the loop.
 */
const PROSPECTS = [
  { key: 'kavita', name: 'Kavita Shah' },
  { key: 'nikhil', name: 'Nikhil Bose' },
  { key: 'farah', name: 'Farah Sheikh' },
] as const

const NO_SPEND = { promptTokens: 0, outputTokens: 0, cachedTokens: 0 }

/* ========================================================================== *
 * THE WORLD
 * ========================================================================== */

type BuiltWorld = {
  /** This run's own number, and the front desk that belongs to it. */
  senderId: string
  senderPhone: string
  frontDeskId: string
  /** Contact id per SEAT KEY — what `_seat-worker.ts` looks itself up by. */
  contacts: Record<string, string>
  roster: { name: string; role: string; contactId: string; phone: string }[]
}

/**
 * Which world, resolved before a run directory exists.
 *
 * Everything expensive is behind `build`. Reading the file, refusing it,
 * composing its briefs and dealing its week all happen first, so a misspelled key
 * costs a second and leaves nothing behind — never half a world and then a stack
 * trace, which is rows on a shared sender that nobody afterwards can prove are
 * dead.
 */
type WorldPlan = {
  /** The reference, exactly as `--world` had it. `blank` when it was absent. */
  ref: string
  /** One English line about it, for the top of the run and the record. */
  is: string
  /** The file itself, so the seats and the record can read what was asked for. */
  world: World
  /** Every seat this world has, keyed as the driver and the worker name them. */
  briefs: Record<string, Brief>
  /** Who is at a phone, in which window of which day. */
  schedule: Record<number, Record<WindowName, string[]>>
  /**
   * This world's own weather, when its file carries a `week` block — the base
   * `--events` is laid over.
   */
  week?: EventSpec
  build(token: string, log: (s: string) => void): Promise<BuiltWorld>
}


/* ========================================================================== *
 * WHICH WORLD
 * ========================================================================== */

/**
 * How thickly a week fills its windows: seat turns per window.
 *
 * `24 / 14` — twenty-four seat turns over fourteen windows, a shade under two
 * people at a phone at once. That is what a Tuesday evening at a real academy
 * looks like and it is the only density anybody here has driven and read back.
 *
 * It was computed off `SCHEDULE`, a hand-written table saying which of four named
 * humans spoke in which window of which day. The table is gone with the fixtures,
 * so the number it produced is written down instead — a constant it always was,
 * now visibly. A week aims at this rather than at one speaker per window, because
 * concurrent messages are half of what this instrument is for: eleven people and
 * one speaker per window is a different instrument wearing this one's name.
 */
const DENSITY = 24 / 14


// `deriveSchedule` moved to `_world-file.ts` — `live.ts` deals a week too.

/**
 * Deal the windows that have not happened yet, over the roster as it stands now.
 *
 * `deriveSchedule` above is the whole week decided before anybody speaks, and it
 * is right for the roster it was given. It cannot be right for a roster that
 * changes on Wednesday — a business that gains four families gains them into a
 * week whose every window was already handed out to the one man who started it.
 *
 * So this re-deals the REMAINDER and never touches a window that has run. Two
 * things follow from that and both are deliberate:
 *
 * **It does not assert balance, and `deriveSchedule` must.** A person who arrives
 * on Friday cannot have had Monday, and a check demanding they did would refuse
 * every week in which the product did its job. What is balanced here is the share
 * of what is LEFT, which is the only thing that can be. The record keeps the
 * whole schedule, so the imbalance is legible rather than smoothed over: a seat
 * with two windows against the owner's twelve is a person who joined on day six,
 * and reading their week as the product's is the same mistake `deriveSchedule`'s
 * own header names.
 *
 * **A duplicate is dropped rather than fatal.** `deriveSchedule` dies when a cell
 * gets the same person twice, because at start-up that is a bug in the deal and
 * nothing has been spent. Here it is Wednesday, ten model turns are on disk, and
 * killing the run over a scheduling artifact would destroy evidence to protect a
 * property nobody is judging. Somebody cannot be at their own phone twice in one
 * window; the second copy is simply not dealt.
 */
function redealFrom(
  schedule: Record<number, Record<WindowName, string[]>>,
  seats: string[],
  days: number,
  windows: WindowName[],
  after: { day: number; window: WindowName },
): number {
  if (!seats.length) return 0
  const per = windows.length
  const cells = days * per
  const from = (after.day - 1) * per + windows.indexOf(after.window) + 1
  const left = cells - from
  if (left <= 0) return 0

  const perSeat = Math.min(left, Math.max(1, Math.round((left * DENSITY) / seats.length)))
  const turns = perSeat * seats.length
  const dealt: string[][] = Array.from({ length: left }, () => [])
  for (let t = 0; t < turns; t++) {
    const cell = dealt[Math.floor((t * left) / turns)] as string[]
    const who = seats[t % seats.length] as string
    if (!cell.includes(who)) cell.push(who)
  }

  for (let i = 0; i < left; i++) {
    const at = from + i
    const day = Math.floor(at / per) + 1
    const w = windows[at % per] as WindowName
    const row = (schedule[day] ??= {} as Record<WindowName, string[]>)
    row[w] = dealt[i] ?? []
  }
  return left
}

/**
 * Read `--world`, refuse it if it is not one, and hand back everything the run
 * needs before anything exists.
 *
 * Nothing here writes a row. A file that will not parse, a person nobody spelled
 * right, a `--personas` naming somebody who is not in it: all of them stop the
 * process here, before a run directory and before a single row, and therefore
 * before there is anything on a shared sender that nobody can afterwards prove is
 * dead.
 *
 * It is a fifth of what it was. There is no second branch for a hand-built
 * academy, no spec to expand, no counts to turn into names, no enrolments to
 * resolve and no briefs to derive from rows — because the build makes a sender, a
 * front desk and some contacts, and nothing else exists to disagree with.
 */
async function planWorld(cfg: DriveConfig): Promise<WorldPlan> {
  let loaded: { world: World; ref: string }
  try {
    loaded = loadWorld(cfg.world)
  } catch (e) {
    die(`${c.red('x')}  ${(e as Error).message}`)
  }
  const { world, ref } = loaded

  /**
   * The briefs, composed out of the file and nothing else.
   *
   * There is no derived half any more. A brief used to open with facts read back
   * out of the rows the harness had just written — the classes, the timetable,
   * who was enrolled — because a person describing a business that was not there
   * writes a turn that reads as a product defect. Nothing writes those rows now,
   * so there is nothing to read back and nothing to contradict: what a person
   * knows is what somebody typed about them, and what the week turns out to be is
   * what the people in it talk into existence.
   */
  const all = briefsFor({ people: world.people, worldName: world.name, days: cfg.days })
  const known = new Map(all.map((b) => [b.key, b]))

  /**
   * Named seats win over a count, because a list is the more specific thing to
   * have asked for. `--seats N` takes the first N the file holds, in the order it
   * wrote them, so a cheap run is a shape anybody can ask for without knowing who
   * lives in the world yet.
   */
  const chosen =
    cfg.personas.length ? cfg.personas.map((k) => seatIn(known, k, ref))
    : cfg.seats > 0 ? all.slice(0, cfg.seats)
    : all

  return {
    ref,
    is: describeWorld(world),
    world,
    briefs: Object.fromEntries(known),
    schedule: deriveSchedule(chosen.map((b) => b.key), cfg.days, cfg.windows),
    ...(world.week !== undefined ? { week: world.week as EventSpec } : {}),
    async build(token, log): Promise<BuiltWorld> {
      const built = await buildWorld(world, { token, log })
      return {
        senderId: built.senderId,
        senderPhone: built.senderPhone,
        frontDeskId: built.frontDeskId,
        contacts: built.contacts,
        roster: built.roster,
      }
    },
  }
}

/**
 * One named seat, or a refusal that lists the ones this world has.
 *
 * `--personas` cannot be checked against a spec world until the spec has been
 * read, so `_drive-config.ts` carries the names through as written and they are
 * refused here. A name nothing matches is a seat nothing drove, and the run then
 * looks exactly like the run that was asked for.
 */
function seatIn(known: Map<string, Brief>, key: string, world: string): Brief {
  const found = known.get(key)
  if (found) return found
  return die(
    `--personas: ${world} has no seat "${key}"\n` +
      `   its seats: ${[...known.keys()].join(', ')}`,
  )
}

/* ========================================================================== *
 * THE SEATS
 * ========================================================================== */

type Seat = {
  /** The world's own handle for this person — `divya`, or `client-divya-rao`. */
  key: string
  /** Ask for one move and wait for it. Starts the child if it is not up. */
  ask(a: Ask): Promise<Told>
  /** Did this seat sit down? Asked once, before the week, and never again. */
  ready(): Promise<boolean>
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
function openSeat(key: string, dir: string, cfg: DriveConfig): Seat {
  let child: ChildProcess | null = null
  let booting: Promise<void> | null = null
  const waiting = new Map<string, (t: Told) => void>()

  const failed = (id: string, error: string): Told => ({
    id, kind: 'failed', error, usage: NO_SPEND, attempts: 0, ms: 0, model: cfg.model,
  })

  const start = (): Promise<void> => {
    const ch = spawn(
      process.execPath,
      ['--import', 'tsx', WORKER, '--dir', dir, '--persona', key, '--model', cfg.seatModel, '--seed', cfg.seed],
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
    /**
     * Awaited rather than nulled, so `ask` still owns the boot it started. A
     * child that exited during start-up has already cleared `child` in its own
     * exit handler, which is what makes this a fact rather than a guess.
     */
    async ready(): Promise<boolean> {
      if (booting) await booting
      return !!child && child.connected
    },
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
   * The world, read and refused before a run directory exists.
   *
   * A spec that will not parse or a seat nobody spelled right stops the process
   * here, having created nothing. The alternative is half a world on a shared
   * sender that nothing afterwards can prove is dead.
   */
  const plan = await planWorld(cfg)
  const canonical = false

  /**
   * The week's weather, read and refused on the same terms as the world.
   *
   * Everything answerable from the FILE is answered here, before a run directory
   * or an academy exists: an unknown verb, a day past the end of the run, a lag
   * with no hours, a `note` nobody is told. The name checks that need rows —
   * "this world has nobody called Anika Rao" — wait for `openEvents` below,
   * because they need a built world to be checked against.
   *
   * A `week` block inside the world file is the same shape and composes with the
   * flag: the world's own weather is the base, and `--events` is laid over it. A
   * world whose identity includes its weather — a monsoon academy, a school-term
   * one — says so once in its own file, and a scenario is still a thing you can
   * point at any world.
   */
  let eventSpec: EventSpec = {}
  let eventRef = '(nothing happens)'
  try {
    const fromFlag = cfg.events ? readEventSpecs(cfg.events) : { spec: {} as EventSpec, ref: '' }
    eventSpec = {
      about: [plan.week?.about, fromFlag.spec.about].filter(Boolean).join(' · '),
      chaos: { ...(plan.week?.chaos ?? {}), ...(fromFlag.spec.chaos ?? {}), ...cfg.chaos },
      events: [...(plan.week?.events ?? []), ...(fromFlag.spec.events ?? [])],
    }
    eventRef =
      [plan.week ? `${plan.ref}#week` : '', fromFlag.ref].filter(Boolean).join(' + ') || eventRef
    validateEventSpec(eventSpec, cfg.days)
  } catch (e) {
    /**
     * One catch over reading AND validating, so a missing file and a bad verb
     * come out the same shape a flag error does. A stack trace here would be the
     * only refusal in this file that prints like a crash.
     *
     * The reference is prefixed only once it is known — a file that would not
     * open names itself in its own message, and `(nothing happens)` in front of
     * that would read as a claim about the run rather than about the file.
     */
    const known = eventRef !== '(nothing happens)'
    die(`${c.red('x')}  ${known ? `${eventRef}: ` : ''}${(e as Error).message}`)
  }

  /**
   * How many windows each seat got, for the top of the run and for the record.
   *
   * Not asserted here any more, and it is not a check that went missing:
   * `deriveSchedule` builds this week and refuses an unbalanced one at the moment
   * it deals it, which is both earlier and stricter than a second look would be.
   * What used to be asserted here was `SCHEDULE` — a hand-written table for four
   * named humans — and the assertion existed because a table somebody typed can be
   * wrong in a way a construction cannot.
   *
   * The number still matters and is still printed. A week claiming equal coverage
   * while running eleven owner windows and two client ones reports the owner's
   * experience as though it were the product's, and the imbalance is invisible in
   * the report it writes.
   */
  const counts = windowsPerSeat(plan.schedule, cfg)
  const balance = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')

  /**
   * Who is actually driven.
   *
   * `cfg.personas` is empty only for a spec world nobody narrowed — the canonical
   * one always names its four, because `_drive-config.ts` knows them and fills
   * them in. Empty therefore means everybody this world has.
   */
  const driven = new Set<string>(cfg.personas.length ? cfg.personas : Object.keys(plan.briefs))
  /**
   * How many of them may be mid-turn together. `cfg.concurrency` is `0` when a
   * spec world's seats had not been counted yet, and "everybody at once" is what
   * the default has always meant — see `DriveConfig.concurrency`.
   */
  let width = cfg.concurrency || driven.size

  console.log(c.bold(`\n  sim — ${describeConfig(cfg)}`))
  console.log(c.dim(`  world:    ${plan.is}`))
  /**
   * Where the hand-written prose runs out, said before the money is spent.
   *
   * `--days` has no ceiling, and the thing that genuinely stops scaling with it
   * is not the clock or the timetable — both are fine — but the `life` blocks
   * somebody typed. Read off the REAL briefs rather than assumed, because the
   * canonical four are written to day 7 and a spec world's people are written to
   * wherever their file stops, which is often nowhere at all.
   *
   * A note and not a refusal: a long run of ordinary days is a perfectly good
   * question — *does the product stay sane over a billing month with nothing
   * dramatic in it* — and it is one nothing here could ask before. What would be
   * wrong is finding out afterwards that days 8–30 were blank and reading the
   * quiet as a product that stopped engaging.
   */
  const lifeUntil = Math.max(
    0,
    ...Object.values(plan.briefs).flatMap((b) => Object.keys(b.life ?? {}).map(Number)),
  )
  const weekHasSomething =
    (eventSpec.events?.length ?? 0) > 0 || Object.values(eventSpec.chaos ?? {}).some((r) => r > 0)
  if (cfg.days > lifeUntil && !weekHasSomething) {
    console.log(
      c.yellow(
        `  note:     nobody wrote a life event past day ${lifeUntil || 0} — days ` +
          `${(lifeUntil || 0) + 1}–${cfg.days} are ordinary.\n` +
          `            --events <file> or --chaos <rate> is how you fill them.`,
      ),
    )
  }
  console.log(c.dim(`  schedule: ${balance}\n`))

  const dir = await runDir('sim')
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

  const world = await plan.build(token, (m) => console.log(c.dim(`  ${m}`)))

  /**
   * THE TENANT THIS RUN IS ABOUT, WHICH DOES NOT EXIST YET.
   *
   * A run opens at a front desk: a sender, an arrivals hall, and some people
   * holding phones who belong to no business. `academyId` is therefore not a
   * constant any more — it is the front desk until somebody founds something, and
   * that business afterwards.
   *
   * Pointing it at the front desk rather than at nothing is what keeps every
   * other line in this file unchanged. The clock, the drain and the record all
   * take a tenant, and the front desk is a real `academy` row (0039) with a
   * `sim_clock` of its own — so the week walks a per-tenant clock from turn one
   * and two runs still cannot move each other. It owns no class, no player and no
   * money, and `onboarding_state` stays `setup`, so `drain` finds nothing to run
   * and gate 5 suppresses anything it did not compose as a direct reply. Walking
   * it is free and silent, which is exactly what a day before the business exists
   * should be.
   */
  let academyId = world.frontDeskId
  let academyName = 'the front desk'
  /** Null until the bot founds a business. Named once, in `adopt` below. */
  let founded: string | null = null
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
    suite: 'sim',
    model: cfg.model,
    startedAt: new Date().toISOString(),
    academyId,
    note:
      canonical ?
        `One settled week at ${academyName}, driven by persona agents who can see nothing but ` +
        `their own phone. The owner coaches: Rahul holds an academy_admin row and a coach row ` +
        `over one person. Nothing is scripted — every sentence was composed by somebody reading ` +
        `the reply.`
      : `One week at ${academyName}, built from ${plan.ref}: ${plan.is} Its seats are its own ` +
        `people — every brief was composed out of the same spec the rows were built from, so no ` +
        `sentence in one can contradict the database. Nothing is scripted, and each seat can see ` +
        `nothing but its own phone.`,
    ...(cfg.arm ? { arm: cfg.arm } : {}),
    variant: {
      days: cfg.days,
      windows: cfg.windows,
      personas: [...driven],
      concurrency: width,
      seed: cfg.seed,
      model: cfg.model,
      world: plan.ref,
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
   *
   * `recordedConfig` fills in the two fields that could not be known when the
   * flags were read — which seats a spec world turned out to have, and therefore
   * how many of them speak at once — and puts the line the world was described by
   * beside the reference it came from. A run whose world nobody wrote down cannot
   * be compared with another, and `worlds/multi-coach.json` is a filename that can
   * name a different business next month with nothing in either record to say so.
   */
  await writeSidecar(
    dir,
    'config.json',
    recordedConfig(cfg, { is: plan.is, seats: [...driven], concurrency: width }),
  )
  await writeSidecar(
    dir,
    'manifest.json',
    await manifest(cfg, plan, academyId, academyName, dir, { ref: eventRef, spec: eventSpec }),
  )
  /**
   * The briefs this run's seats are sitting in, beside the record — and the
   * handover to the seats themselves.
   *
   * One object, keyed by seat key, holding a whole `Persona` per seat, and it has
   * the same shape for both worlds: `{ rahul: {…}, arjun: {…} }` for the canonical
   * four, `{ 'admin-nisha-balakrishnan': {…}, … }` for a spec world. That is what
   * makes it a handover rather than a copy — `_seat-worker.ts` resolves a key
   * through `PERSONAS`, which holds the four and cannot hold anybody else, so a
   * seat whose key is not one of the four is read from HERE. Written before the
   * first seat is spawned, for that reason.
   *
   * For the canonical world it is also a copy of something version-controlled and
   * costs nothing. For a spec world it is the only place the exact text a seat was
   * handed survives a run, because the spec it was composed from can be edited
   * tomorrow.
   */
  await writeSidecar(dir, 'briefs.json', plan.briefs)

  console.log(`  academy  ${academyName} — ${academyId}`)
  console.log(`  seats    ${[...driven].join(', ')}`)
  console.log(`  record   ${dir}`)

  /**
   * The week's weather, bound to the rows it is about.
   *
   * The FILE was refused at second zero; this is where the NAMES are, and they
   * need a built world to be checked against. A misspelt child, a class this
   * business does not run, an absence on a day the class does not meet: each of
   * them is a week that runs perfectly and quietly measures nothing, so each of
   * them stops the run here with what is actually in the database.
   *
   * Everybody the world has, not only `driven`. An event may name somebody this
   * run narrowed out, and refusing the name would make `--seats 2` reject a
   * scenario written for the whole business.
   */
  /**
   * The week's weather waits for a business to happen to.
   *
   * `openEvents` binds names to rows — this child, that class, this coach — and
   * at this point there are none: a front desk owns no player and no class, and
   * every name in the file would be refused for not existing. So the FILE was
   * refused at second zero, where it can be, and the BINDING happens in `adopt`
   * against the tenant somebody founded.
   *
   * The consequence is worth being explicit about: nothing physical happens to a
   * business that does not exist yet, so a run whose people never found one has
   * no weather at all, correctly. `INERT` is what a window asks when there is
   * nothing to ask.
   */
  const eventSpecActive =
    (eventSpec.events?.length ?? 0) > 0 || Object.values(eventSpec.chaos ?? {}).some((r) => r > 0)
  const INERT: EventsRuntime = {
    active: false,
    ref: eventRef,
    about: '',
    openDay: async () => {},
    forWindow: () => ({ today: {}, skip: new Map(), lag: new Map() }),
    admit: async () => {},
    depart: () => {},
    truth: () => ({ ref: eventRef, about: '', seed: cfg.seed, chaos: {}, sessions: [], fired: [] }),
  }
  let events: EventsRuntime = INERT
  if (eventSpecActive) {
    console.log(`  events   ${eventRef}${c.dim(' — waiting for a business to happen to')}`)
  }

  // Sat down before the first window, so a seat's node start-up happens while the
  // timetable below is being materialised rather than inside a turn's stopwatch.
  const seats = new Map<string, Seat>([...driven].map((k) => [k, openSeat(k, dir, cfg)]))
  // Whatever happens to this process, the seats it started go with it. A week that
  // dies on a bad query would otherwise leave children holding open database
  // connections and an IPC channel to nobody.
  process.on('exit', () => {
    for (const seat of seats.values()) seat.end()
  })

  /**
   * Did anybody sit down.
   *
   * Asked once, here, and never again — a seat that flakes mid-week is already
   * handled by starting a fresh one at the next window, and refusing the run for
   * that would cost six days to save one turn. A run in which NOBODY could start
   * is a different claim: it will walk the whole clock, fire every standing job,
   * record fourteen queue turns and no seat turns at all, and read afterwards as a
   * product nobody talked to rather than as a harness that never opened.
   *
   * The likeliest cause is a seat key `_seat-worker.ts` cannot resolve. It reads
   * `PERSONAS` — which holds the canonical four — and `briefs.json` is where the
   * rest of them are, written above.
   */
  const sat = await Promise.all([...seats.values()].map((s) => s.ready()))
  if (sat.length && !sat.some(Boolean)) {
    die(
      `not one of ${[...driven].join(', ')} could sit down — see the seat's own error above.\n` +
        `   A seat is looked up by key: the four in PERSONAS, and everybody else in ${join(dir, 'briefs.json')}.`,
    )
  }

  /**
   * How the run ended: a ceiling, a world that went away, or nothing.
   *
   * Declared up here rather than beside the loop because `queue` below closes
   * over it, and the first queue turn happens before the first day does.
   */
  let stoppedBy: 'min' | 'inr' | 'world-gone' | null = null

  /**
   * Every clock walk and every drain goes through here.
   *
   * `queueTurn` throws `WorldGone` when the academy this run drives has been
   * deleted underneath it. Caught once, in one place, so a vanished world reaches
   * the loop as the same kind of fact a budget ceiling does: the record below is
   * written either way — short but whole, which is a run that can still be
   * judged — and `stoppedBy` names which of the three ended it.
   */
  const queue = async (...args: Parameters<typeof queueTurn>): Promise<string[]> => {
    try {
      return await queueTurn(...args)
    } catch (e) {
      if (!(e instanceof WorldGone)) throw e
      stoppedBy = 'world-gone'
      console.log(c.red(`\n  ${e.message}`))
      return []
    }
  }

  /**
   * Materialise the timetable before anybody speaks, so day 1 is a business with
   * sessions in it rather than one whose first question has no answer. Recorded as
   * turn 1: it is the first thing the product does in this run, it costs money,
   * and a run whose opening move is missing from its own record begins by
   * understating itself.
   */
  const opened = await queue(session, 'd1-open-queue', () => drain(academyId))
  console.log(`  clock    ${clock.inZone(await clock.now(academyId), TZ).label} · ${opened.length} jobs\n`)

  /** Who has walked out, and when. A departure is an outcome, not a failure. */
  const departures: { persona: string; day: number; window: string; say: string }[] = []
  const gone = new Set<string>()
  /** What the seats themselves cost, which is not what the product cost. */
  const seatSpend = { inr: 0, prompt: 0, cached: 0, output: 0, moves: 0, failures: 0 }

  const budget = makeBudget(cfg)
  let counted = 0
  /**
   * Rupees, read off the log rather than accumulated in memory.
   *
   * A turn's cost is priced by `_capture.ts` when it is appended, and the log is
   * what the record is made of, so summing it is the one number that cannot
   * disagree with the record's own.
   *
   * THE CEILING MEASURES THE PRODUCT, NOT THE PEOPLE
   * ---------------------------------------------------------------------------
   * `--budget-inr` used to count the seats as well, on the reasoning that a
   * budget over one side of a conversation is wrong by whatever the other side
   * cost. That is true of a BILL and false of a CEILING, because the two sides
   * are not the same order of magnitude and only one of them is under test.
   *
   * On 20 Aug a ₹34 ceiling ended a seven-day week after six windows. Of the ₹68
   * it had counted by then, **₹67.13 was Claude playing twelve parents and 90
   * paise was the product** — so a rupee limit on a run of this product was really
   * a limit on the instrument driving it, and it read as the opposite of what it
   * did. The same week run to completion spent ₹13.71 on the bot and ₹240.62 on
   * its seats: seventeen to one. Any number a person types here means "spend about
   * this much on the bot", and under the old accounting it never could.
   *
   * The seats are still measured, still recorded (`extra.run.seatInr`) and still
   * printed beside the product's figure when the run closes. They simply do not
   * bind the ceiling: seat spend is what the harness pays to ask the question, and
   * a harness does not get to end the experiment. Watch a seat-model balance
   * directly if that is what you need to cap — `--budget-min` bounds it in
   * practice, because seat cost tracks wall-clock far more closely than it tracks
   * anything the product does.
   */
  /**
   * The moment a stranger becomes a tenant, and the run follows them into it.
   *
   * Four things have to move together, and getting any of them wrong is silent.
   *
   * **The clock.** The new business gets its own `sim_clock` row set to whatever
   * moment the front desk is standing at, so the week carries on across the
   * handover instead of restarting at real time. Without it day 2 opens months in
   * the past and every standing job for the week fires at once.
   *
   * **The contacts.** Founding writes the founder a NEW contact inside the new
   * academy — `Handover` carries `{ academyId, contactId }` — and their front-desk
   * contact stays where it is, holding the arrival record. A seat still reading
   * the old one would watch an empty thread for the rest of the week while the
   * product talked to a phone nobody was answering. So every seat is re-resolved
   * by name against the new tenant, and anybody who has not moved keeps the
   * contact they have.
   *
   * **The seats themselves.** A worker reads `session.json` once when it boots, so
   * the ones already running would keep the old contact in memory. They are
   * restarted rather than patched: `_seat-worker.ts` rebuilds what its person has
   * already said from the run's own log, which is precisely the machinery that
   * makes a restart cheap and lossless. It happens at most once in a run.
   *
   * **The events.** `openEvents` binds to a tenant's rows, and until now there
   * were none. It is opened here, against the business that actually exists.
   */
  /**
   * Whoever moved into the business since the last window, and their seat with them.
   *
   * `adopt` did this once, for the founder, at the moment the business appeared —
   * and once is not enough. A prospect the owner adds on Thursday gets a NEW
   * contact inside the tenant; their front-desk contact stays where it is holding
   * the arrival record, and `_arrivals.ts` will not re-admit a key it has already
   * seated. So without this they hold a desk contact for the rest of the week,
   * reading a phone nobody is writing to while the product talks to one nobody is
   * answering — and every query about them returns zero rows, silently, because
   * `cm_service` is not an RLS bypass.
   *
   * A seat that moved is RESTARTED, not patched: `_seat-worker.ts` reads
   * `session.json` once at boot and rebuilds what its person has already said from
   * the run's own log, which is what makes a restart cheap and lossless.
   */
  const follow = async (restart = true): Promise<number> => {
    if (!founded) return 0
    const moved = await q<{ id: string; full_name: string }>(
      founded,
      `select ct.id::text, p.full_name
         from contact ct join person p on p.id = ct.person_id
        where ct.opted_out_at is null`,
    ).catch(() => [] as { id: string; full_name: string }[])
    let followed = 0
    for (const m of moved) {
      const key = keyOf(m.full_name)
      if (!session.contacts[key] || session.contacts[key] === m.id) continue
      session.contacts[key] = m.id
      const seat = session.roster.find((r) => keyOf(r.name) === key)
      if (seat) {
        seat.contactId = m.id
        // The half that was missing: the tenant their evidence must be read in.
        seat.academyId = founded
      }
      followed += 1
      const worker = restart ? seats.get(key) : undefined
      if (worker) {
        worker.end()
        seats.set(key, openSeat(key, dir, cfg))
      }
    }
    if (followed && restart) await writeSession(session)
    return followed
  }

  const adopt = async (): Promise<void> => {
    /**
     * `app.businesses_on_sender`, and NOT a select on `academy`.
     *
     * `academy_cm_service_all` is `using (id = app.academy_id())`, so **cm_service
     * is not a bypass**: a session pinned to the front desk can see the front desk
     * and nothing else. The obvious query — `select … from academy where sender_id
     * = $1 and not is_front_desk` — returns zero rows from here, with no error, so
     * a business really was founded and the run would have sat at the desk for the
     * rest of the week believing nothing had happened.
     *
     * It is the trap 0039's own header names, and this code walked into it: the
     * first version of `adopt` wrote that select, and a founded academy went
     * unadopted with nothing anywhere saying why. The function is the named door
     * 0039 provides for exactly this read, granted to `cm_service` and excluding
     * front desks so a desk can never route to a desk.
     */
    const [row] = await q<{ id: string; name: string }>(
      world.frontDeskId,
      `select id::text, name from app.businesses_on_sender('${world.senderId}'::uuid) limit 1`,
    ).catch(() => [] as { id: string; name: string }[])
    if (!row) return

    founded = row.id
    academyId = row.id
    academyName = row.name
    session.academyId = row.id

    // The new tenant starts where the old one is standing, not at real time.
    await clock.setTo(await clock.now(world.frontDeskId), row.id)

    // `false`: this path restarts EVERY worker a few lines below, so a per-seat
    // restart here would be a second one for the same people.
    const followed = await follow(false)
    await writeSession(session)

    console.log(
      `      ${c.green('★')} ${c.bold(academyName)} exists now ` +
        c.dim(`— founded from the front desk${followed ? `, ${followed} seat${followed === 1 ? '' : 's'} followed` : ''}`),
    )

    // Restart, so every worker reads the contact it should now be holding.
    for (const [key, seat] of seats) {
      seat.end()
      seats.set(key, openSeat(key, dir, cfg))
    }

    if (eventSpecActive && !events.active) {
      try {
        events = await openEvents({
          spec: eventSpec,
          ref: eventRef,
          days: cfg.days,
          seed: cfg.seed,
          academyId: row.id,
          windowAt: WINDOW_AT,
          people: Object.values(plan.briefs).map((b) => ({ key: b.key, name: b.name, seat: b.seat })),
          q: (s: string) => q(row.id, s),
        })
        console.log(c.dim(`        events bound to ${academyName}: ${eventRef}`))
      } catch (e) {
        die(`${c.red('x')}  ${(e as Error).message}`)
      }
    }
  }

  const settle = async (): Promise<number> => {
    const turns = await readTurns(dir)
    const total = turns.reduce((a, t) => a + (typeof t.inr === 'number' ? t.inr : 0), 0)
    // Deltas, because `spend` accumulates and the log is a running total.
    budget.spend(total - counted)
    counted = total
    return total
  }

  /**
   * The front desk keeps the business's time.
   *
   * `walkTo` moves ONE tenant's clock, and after `adopt` that tenant is the
   * business — so the desk freezes at the Monday morning `buildWorld` set it to.
   * That is not cosmetic. 0027 made every `created_at` default to `app.now()`,
   * which resolves per tenant, so a seat still holding a front-desk contact
   * writes `turn`, `message` and `audit_entry` rows stamped days behind the week
   * they happened in. `_capture.ts` opens its window on domain time: against the
   * business clock those rows are already in the past and the turn records
   * nothing; against a frozen desk clock the cursor never moves and one turn
   * sweeps up everything that contact has ever produced. Both are wrong and
   * neither says so.
   *
   * One number, one week, one wall clock. A single UPDATE per window, and it
   * only ever moves the desk FORWARD, which is the monotonicity 0027 relies on.
   */
  const keepDeskInStep = async (): Promise<void> => {
    if (!founded || academyId === world.frontDeskId) return
    await clock.setTo(await clock.now(academyId), world.frontDeskId)
  }

  for (let day = 1; day <= cfg.days && !stoppedBy; day++) {
    session.day = day
    // The file on disk is what a worker reads when it is restarted mid-week; a
    // `day` left at 1 all week would be a fact on disk that is not true.
    await writeSession(session)

    const label = clock.inZone(await clock.now(academyId), TZ)
    console.log(c.bold(`  day ${day} — ${label.date}`))

    /**
     * What physically happened today, fixed before the first window opens.
     *
     * Fixed at the top of the day rather than inside a window because it is a
     * fact about the DAY: who was on court at seven has to be the same fact when
     * their parent's evening window comes round, and a decision taken twice is
     * two facts. Revealing it is separate and happens per window — a coach is
     * told about a class after it has ended and not before.
     *
     * The clock is already on today's date here: the overnight walk of the
     * previous day ends past midnight, and day 1 opens on the Monday the world
     * was built against. It runs BEFORE the first `walkTo`, so nothing has fired
     * yet on the strength of a session this has not looked at.
     */
    if (events.active) {
      try {
        await events.openDay(day)
      } catch (e) {
        die(`${c.red('x')}  ${(e as Error).message}`)
      }
    }

    for (const w of cfg.windows) {
      /**
       * The clock moves here and nowhere else, and it moves before anybody speaks.
       *
       * `walkTo` lands on every moment the queue wants something between here and
       * the window's hour, in order, running what is due at the hour it was due —
       * a job stepped over is a morning brief, a T-60 prompt or a register that
       * never happened, and the day then reads as a quiet one.
       */
      const walked = await queue(
        session,
        `d${day}-${w}-queue`,
        async () => {
          const ran = await walkTo(academyId, WINDOW_AT[w])
          // The desk follows the business, or a seat still standing at it writes
          // rows stamped in a week that has already gone past.
          await keepDeskInStep()
          return ran
        },
        { window: w },
      )
      /**
       * Nobody is asked to speak into a business that is not there. A deleted
       * world surfaces at the window's clock walk, above, because the clock is
       * the first thing a window touches — and every seat after it would spend a
       * model call to be shown an empty phone and say something into nothing.
       */
      if (stoppedBy) break
      const at = clock.inZone(await clock.now(academyId), TZ)
      /**
       * What the world does to this window: extra lines for people's `today`,
       * whose phone is behind, and who is not at one at all.
       *
       * Resolved AFTER the clock walk, because the walk is what makes the jobs of
       * this window fire — a lag measured against a clock that had not moved yet
       * would hold back the wrong messages.
       */
      const effects =
        events.active ?
          events.forWindow(day, w)
        : { today: {} as Record<string, string[]>, skip: new Map<string, string>(), lag: new Map<string, number>() }

      const dealt = (plan.schedule[day]?.[w] ?? []).filter((k) => driven.has(k) && !gone.has(k))
      /**
       * Somebody away is not driven, and is not `quiet` either.
       *
       * `quiet` is a MOVE — a person read their phone and put it down, and the
       * seat chose it with reasoning attached. Being on holiday is not a move,
       * and dressing it as one would put a decision nobody made into the record
       * as though a model had made it. So the window skips them, and the skip is
       * printed, logged into `days.jsonl` and carried in `truth.json` with the
       * reason: three places a reader can find "she was in Kerala" rather than
       * being left to infer it from an absence.
       */
      const asleep = dealt.filter((k) => effects.skip.has(k))
      const active = dealt.filter((k) => !effects.skip.has(k))
      console.log(
        `    ${at.time} ${c.bold(w.padEnd(8))} ${c.dim(`${walked.length} jobs`)}` +
          `  ${c.dim(active.length ? active.join(', ') : '(nobody at a phone)')}` +
          (asleep.length
            ? c.yellow(`  away: ${asleep.map((k) => `${k} (${effects.skip.get(k)})`).join(', ')}`)
            : ''),
      )

      await inFlight(active, width, async (key) => {
        const seat = seats.get(key)
        if (!seat) return
        /**
         * What somebody wrote about this person's day, out of the world file.
         *
         * One source now, where there were three — the file, plus a five-tier
         * ramp keyed by four hard-coded names, plus a set of fixtures the ramp was
         * anchored to. The ramp is gone: it could only ever apply to those four,
         * so against any world file every lookup missed, the week was the ordinary
         * one, and the record still said it was ramped.
         *
         * A day nobody wrote is not an error. `life` is narrative and most days do
         * not have any — the seat is told nothing unusual is happening, which is
         * true of most days for most people. `events/` is where the days that DO
         * have something in them come from, and unlike `life` it is checked
         * against the rows.
         */
        const written = plan.briefs[key]?.life[day]
        /**
         * What was written about today, and then what actually happened in it.
         *
         * In that order, and joined rather than replaced. `life` is the standing
         * situation somebody wrote down — Priya asked for a raise, you are fed up
         * being asked about waivers — and the event lines are the physical facts
         * of the day: a class that did not run, a child who was not there, no
         * signal at the courts. Neither substitutes for the other, and a world
         * event that silently overwrote a `life` string would delete the reason
         * the persona was written.
         *
         * This is also the ONLY channel the world reaches a seat by. Nothing here
         * says what the product can do about any of it, which is the rule
         * `_personas.ts` and `_ramp.ts` both open with: a persona who has been
         * told the answer is not a persona.
         */
        const today = [written, ...(effects.today[key] ?? [])].filter(Boolean).join('\n\n') || undefined
        const lag = effects.lag.get(key)
        const told = await seat.ask({
          id: `d${day}-${w}-${key}`,
          day,
          window: w,
          ...(today ? { today } : {}),
          ...(lag ? { lag } : {}),
        })

        if (told.kind === 'ready') return
        seatSpend.prompt += told.usage.promptTokens
        seatSpend.cached += told.usage.cachedTokens
        seatSpend.output += told.usage.outputTokens
        seatSpend.inr +=
          /**
           * A measured figure beats a rate table. The Claude CLI reports what the
           * call actually cost; `costInr` knows only the DeepSeek rows and returns
           * null for anything else, which `?? 0` would render as free.
           */
          (told.costUsd !== undefined
            ? told.costUsd * USD_INR
            : costInr(told.model, told.usage.promptTokens, told.usage.cachedTokens, told.usage.outputTokens)) ?? 0

        if (told.kind === 'failed') {
          seatSpend.failures += 1
          console.log(`      ${c.dim(key.padEnd(7))} ${c.red('seat failed')} ${c.dim(told.error.slice(0, 120))}`)
          return
        }
        seatSpend.moves += 1
        if (told.action === 'giveup') {
          gone.add(key)
          // Told to the world as well as to the schedule. `gone` stops them being
          // DEALT a window; it does not stop the world rolling weather at them, and
          // for thirty days it did exactly that — a third of the chaos in the last
          // run's `truth.json` was rain falling on two people who had walked out on
          // day 5. The record of a week has to be a record of the people in it.
          events.depart(key)
          departures.push({ persona: key, day, window: w, say: told.say })
        }
        const what =
          told.tapped ? c.bold(`tapped [ ${told.tapped} ]`)
          : told.say ? `“${told.say.replace(/\s+/g, ' ').slice(0, 88)}”`
          : c.dim('(said nothing)')
        // A shared card is a thing that happened in this window and the body already
        // carries it, so the line would read as prose about a contact rather than as
        // an attachment. Named separately, and so is a name their phone did not have
        // — a seat reaching repeatedly for somebody who is not in its contacts is a
        // finding about the world, not noise to swallow.
        const attached =
          told.shared?.length ? c.dim(` 📎 ${told.shared.join(', ')}`)
          : told.notInContacts?.length ? c.yellow(` 📎 not in contacts: ${told.notInContacts.join(', ')}`)
          : ''
        console.log(
          `      ${c.dim(key.padEnd(7))} ${told.action === 'giveup' ? c.red('giveup ') : told.action === 'quiet' ? c.yellow('quiet  ') : 'say    '}` +
            `${what}${attached} ${c.dim(`· ${told.arrived} back · ${Math.round(told.ms / 1000)}s`)}` +
            // Printed beside the move, because a quiet turn on a lagged phone and
            // a quiet turn on a phone that showed everything are different
            // findings, and the line is where a reader forms the first of the two.
            (lag ? c.yellow(` · phone ${lag}h behind`) : ''),
        )
      })

      /**
       * Everything the window's own messages set off, drained where the clock
       * stands. A reply that promises a reminder promises a job, and a job that
       * runs after the record closes is a promise nothing in the record kept.
       */
      const after = await queue(session, `d${day}-${w}-drain`, () => drain(academyId), { window: w })

      /**
       * Did somebody talk a business into existence in this window.
       *
       * Asked after the drain and not before it, for the same reason arrivals are:
       * founding writes the academy, the admin and the founder's new contact in
       * one transaction, and the jobs that follow are what actually reaches a
       * phone. Asked every window because it can happen in any of them — the
       * owner may spend three days deciding, and a run whose people never get
       * round to it is a legitimate and very interesting week.
       */
      if (!founded) await adopt()
      else {
        // Somebody may have moved into the business since the last window — a
        // family written down on Tuesday, a coach hired on Wednesday. Their seat
        // has to move with them or it spends the rest of the run reading a phone
        // in a tenant nobody is writing to.
        const moved = await follow()
        if (moved) {
          console.log(c.dim(`      ${moved} seat${moved === 1 ? '' : 's'} moved into ${academyName}`))
        }
      }

      /**
       * Who the business gained in this window, given a phone and a person.
       *
       * Asked AFTER the drain and not before it, because the drain is where half
       * of an arrival becomes real: the owner says "put Meghna's boy in the
       * Monday batch", the turn writes the rows, and the jobs that follow are
       * what actually reaches her phone. Admitting her before those ran would
       * seat somebody whose first look at their phone is at an empty screen, and
       * the first thing this product ever says to a new family is the thing being
       * measured.
       *
       * It is also why this is not a start-up decision dressed as a loop. See
       * `_arrivals.ts`: a fixed roster made every customer the owner created a
       * person nobody was playing, so the product wrote to twelve phones and the
       * record showed twelve outbound messages and no replies — which cannot be
       * told from a product everybody ignored.
       */
      if (!stoppedBy) {
        const joined = await arrivals({
          academyId,
          days: cfg.days,
          known: new Set(Object.keys(plan.briefs)),
          worldName: plan.world.name,
        }).catch((e) => {
          // A failed roster read is a window without newcomers, never a dead run.
          // The week's subject is the product, and this is the harness asking a
          // question about it.
          console.log(c.dim(`      (could not read the roster: ${(e as Error).message})`))
          return []
        })
        for (const a of joined) {
          plan.briefs[a.key] = a.brief
          session.contacts[a.key] = a.contactId
          session.roster.push({
            name: a.brief.name,
            role: a.brief.seat,
            contactId: a.contactId,
            phone: a.phone,
            // Arrivals are read OUT of the business, so their contact is in it.
            academyId,
          })
          driven.add(a.key)
        }
        if (joined.length) {
          /**
           * Both files are written BEFORE the first worker is spawned, because a
           * worker reads `briefs.json` for who it is and `session.json` for the
           * contact it speaks through, and exits with a message about neither
           * existing if it is started first. `sim.ts` already had to learn this
           * once for spec worlds — see `_seat-worker.ts`'s persona lookup.
           */
          await writeSidecar(dir, 'briefs.json', plan.briefs)
          await writeSession(session)
          /**
           * The world learns about the people the business just gained.
           *
           * Without this a coach hired on Wednesday coaches Thursday's session
           * and is the one person in the week nobody tells what happened in it —
           * which is precisely the defect this whole mechanism removes, quietly
           * reintroduced for the people most likely to expose it. It re-reads the
           * coach and guardian relations, which is two queries in a window that
           * gained somebody and nothing at all in every other window.
           */
          if (events.active) {
            await events.admit(
              joined.map((a) => ({ key: a.key, name: a.brief.name, seat: a.brief.seat })),
            )
          }
          for (const a of joined) {
            if (!seats.has(a.key)) seats.set(a.key, openSeat(a.key, dir, cfg))
            console.log(
              `      ${c.green('+')} ${a.brief.name} ${c.dim(`(${a.brief.seat}) is on a phone now — ${a.brief.oneLine}`)}`,
            )
          }
          width = cfg.concurrency || driven.size
          const left = redealFrom(
            plan.schedule,
            [...driven].filter((k) => !gone.has(k)),
            cfg.days,
            cfg.windows,
            { day, window: w },
          )
          console.log(
            c.dim(
              `        ${joined.length} joined · ${driven.size} seats now · ${left} windows re-dealt`,
            ),
          )
        }
      }
      await appendFile(
        join(dir, 'days.jsonl'),
        JSON.stringify({
          day,
          window: w,
          at: at.label,
          jobs: [...walked, ...after],
          // What the world did to this window, beside what the queue did.
          // `days.jsonl` is where a reader goes to ask "what happened on
          // Wednesday evening", and a window in which two people were away and
          // one was on a lagged phone answers that question differently.
          ...(asleep.length ? { away: asleep.map((k) => ({ key: k, why: effects.skip.get(k) })) } : {}),
          ...(effects.lag.size ? { lag: Object.fromEntries(effects.lag) } : {}),
        }) + '\n',
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
    const night = await queue(
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
    /**
     * The world's account, rewritten at the end of every day rather than once at
     * the close.
     *
     * A week that dies on day 4 still has four days of ground truth on disk, and
     * a run cut short by a budget is explicitly a run this repo expects to be
     * judged — `--budget-min` exists so a short record is a WHOLE one. Truth kept
     * only in memory until teardown would be the one part of a stopped run that
     * is not whole. It is a few kilobytes.
     */
    if (events.active) await writeSidecar(dir, 'truth.json', events.truth())
    await settle()
  }

  for (const seat of seats.values()) seat.end()

  // Once more, because the last day's windows may have fired events after the
  // day-end write above — a run stopped by a budget mid-window ends here.
  if (events.active) await writeSidecar(dir, 'truth.json', events.truth())

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
    // The second tenant a founding turn creates and answers from — see `alsoRead`.
    qIn: (academyId: string, statement: string) => q(academyId, statement),
    domainNow: () => clock.now(academyId),
  })
  const { run } = await rec.close({
    world: worldNow[0] as Record<string, unknown>,
    days: await readJsonl(join(dir, 'days.jsonl')),
    extra: {
      // The briefs, so a reader can see what each person was TRYING to do before
      // judging whether they got it. Every seat the world has, not only the ones
      // this run drove — a reader comparing two runs of one world needs to see
      // who was left out of the narrower of them.
      personas: plan.briefs,
      inputRealism: INPUT_REALISM,
      schedule: plan.schedule,
      windowAt: WINDOW_AT,
      /**
       * The reference, and the line it meant on the day. Named `builtFrom` rather
       * than `world`, because `close()` already puts the world's closing COUNTS at
       * the top of the record under that word and two `world` keys a level apart
       * is a reader asking which one they are looking at.
       */
      builtFrom: { ref: plan.ref, is: plan.is },
      roster: world.roster,
      // Every seat move with what the phone showed when it was made. The
      // blindfold, auditable months later rather than promised in a comment.
      seatLog: await readJsonl(join(dir, 'seat.jsonl')),
      seats: seatSpend,
      departures,
      /**
       * What the WORLD says happened, which is not what the product believes.
       *
       * The two are deliberately kept apart and never reconciled here: `world`
       * above holds the product's own closing counts — how many attendance rows
       * it wrote, how much it billed — and this holds the physical facts those
       * rows were supposed to be about. `npm run truth` puts them side by side.
       *
       * Nothing computes the difference. A difference carries a sign and the sign
       * is the verdict, and verdicts do not go in records — the same reason
       * `ab.ts` prints two columns and no third.
       */
      truth: events.active ? events.truth() : null,
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
      /**
       * THE COST OF A RUN IS THE PRODUCT'S COST.
       *
       * This line used to headline `product + seats`, and the sum was a number
       * about nothing: the two halves are not the same order of magnitude and
       * only one of them is under test. A week that spent ₹7.55 on the bot and
       * ₹170.07 on Claude playing its people closed with a bold ₹177.62, so the
       * figure a reader carried away was 23× the thing they were measuring, and
       * it moved when the HARNESS changed. The persistent seat alone would have
       * "improved" it by a third while the product did exactly the same work.
       *
       * `--budget-inr` was corrected for this reason on 20 Aug; the printed total
       * was left behind and is the same mistake one line further out.
       *
       * The seats stay measured, stay in the record (`extra.run.seatInr`) and
       * stay on this line — dimmed, and never added to anything. Removing them
       * from view would hide a seat that looped, which is the one seat fact worth
       * a person's attention.
       */
      `${c.bold(`₹${counted.toFixed(2)}`)} ${c.dim(`(seats ₹${seatSpend.inr.toFixed(2)}, not counted)`)} · ` +
      `${budget.elapsedMin().toFixed(0)} min`,
  )
  if (departures.length) {
    for (const d of departures) console.log(c.red(`  ${d.persona} left on day ${d.day} (${d.window})`))
  }
  console.log(c.dim(`  node scripts/report.mjs --run ${dir}`))

  if (cfg.keep) {
    // The default. Said with the command that reaps it, because a default that
    // accumulates has to hand over the broom in the same breath.
    console.log(c.dim(`  kept: ${academyName} — ${academyId}`))
    console.log(c.dim(`  reap: npx tsx scripts/sim.ts gc --hours 6`))
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
 * that sits in the future has no honest age: `app.now()` is the tenant's clock, and
 * every drive winds it forward, so a world built ten minutes ago is stamped a day
 * ahead of this process. Any `--hours N` above zero leaves those alone, which is
 * the safe direction — the world might be one a run is still driving. `--hours 0`
 * reaps them, because it already reaps a world one second old and is the sentence
 * "age is not the guard here".
 *
 * A SPEC WORLD IS NOT MATCHED BY NAME, AND IS STILL REAPED
 * -----------------------------------------------------------------------------
 * `--world worlds/multi-coach.json` builds `Smash Badminton Academy <token>`, and
 * a name-shaped guard cannot tell that from a real business somebody called that.
 * The proof is the phone numbers instead: `_world-spec.ts` derives every one of
 * its contacts as `+9194` + six digits of the academy id, and it chose `94`
 * precisely so it could never land on `+9199…` (what `createAcademy` and
 * `createTestContact` allocate) or `+9193…` (what the builder above derives).
 * Nothing else in this repository writes a `+9194` number, so a world whose admin
 * has one was built by that builder, from here, and the four-character token on
 * the end says which run. Both halves are required, so a business that merely ends
 * in four base36 characters is left alone.
 */
async function collectGarbage(rest: string[]): Promise<void> {
  const i = rest.findIndex((a) => a === '--hours' || a.startsWith('--hours='))
  const raw = i === -1 ? '' : rest[i]!.includes('=') ? rest[i]!.split('=')[1]! : (rest[i + 1] ?? '')
  const hours = i === -1 ? 6 : Number(raw)
  if (!Number.isFinite(hours) || hours < 0) die(`gc --hours takes a number of hours, not "${raw}"`)

  console.log(
    c.bold(
      `\n  sim gc — every academy on a "${SENDER_LABEL} <token>" sender, older than ${hours}h\n`,
    ),
  )
  let dropped = 0
  for (const id of await worldAcademyIds({ refresh: true })) {
    const [row] = await withSession({ role: 'service', academyId: id }, async (tx) =>
      (await tx`select a.name, a.created_at, coalesce(s.label, '') as sender_label
                  from academy a join sender s on s.id = a.sender_id
                 where a.id = ${id}::uuid` ) as unknown as {
        name: string
        created_at: string | Date
        sender_label: string
      }[],
    )
    if (!row) continue
    // A sender this driver labelled, and nothing else. The shared production
    // sender never matches, so a business somebody is using is never touched.
    if (!MINE.test(row.sender_label)) continue
    /**
     * The age is measured against the HOST clock and `created_at` was written by
     * the TENANT's, which every drive winds forward — so a world made ten minutes
     * ago reads as twenty-five hours in the FUTURE. `--hours 6` must still leave
     * that alone: a stamp with no honest age might belong to a run that is still
     * going, and reaping it mid-week is the exact disaster in the header.
     *
     * `--hours 0` is the other sentence. It already means "age is not the guard,
     * reap everything I can prove is mine" for every world with a readable stamp —
     * including one a second old — so honouring it for an unreadable one adds no
     * risk it did not already carry. Without this, `gc` could never reap the worlds
     * it exists to reap: `--hours 0` printed five academies "kept — -25.6h old"
     * and dropped nothing, which reads as a clean database and is not one.
     */
    const ageH = (Date.now() - new Date(row.created_at).getTime()) / 3_600_000
    const dated = Number.isFinite(ageH) && ageH >= 0
    if (dated ? ageH < hours : hours > 0) {
      console.log(
        c.dim(
          `  keeping ${row.name} — ` +
            (dated ? `${ageH.toFixed(1)}h old` : 'no honest age — its clock is ahead of this one'),
        ),
      )
      continue
    }
    console.log(`  dropping ${row.name} (${dated ? `${ageH.toFixed(1)}h` : 'undated'}) — ${id}`)
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
/**
 * The assembled stable prefix, identified rather than described.
 *
 * `stablePrefix()` is the same call the runtime makes and is a pure assembly of
 * files and constants — no database, no model — so this costs one hash and
 * cannot change what the run then does. A failure is recorded as a reason, not
 * swallowed: a manifest that quietly omits the field would read as an old run.
 */
async function prefixIdentity(): Promise<Record<string, unknown>> {
  try {
    const { createHash } = await import('node:crypto')
    const { stablePrefix } = await import('@/lib/agent/context')
    const p = stablePrefix()
    return { sha256: createHash('sha256').update(p).digest('hex'), chars: p.length }
  } catch (e) {
    return { unread: e instanceof Error ? e.message : String(e) }
  }
}

async function manifest(
  cfg: DriveConfig,
  plan: WorldPlan,
  academyId: string,
  academyName: string,
  dir: string,
  week: { ref: string; spec: EventSpec },
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
    suite: 'sim',
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
      seat: cfg.seatModel,
      /**
       * The effort a Claude seat runs at, recorded because it was once neither
       * chosen nor written down. Nothing passed `--effort` and the CLI picked;
       * a bare call at `low` still spends 82 of 98 output tokens on thinking, so
       * "off" was never true of a Claude seat and no run said what was.
       */
      seatEffort: SEAT_EFFORT,
      thinkingPin: process.env.PROBE_THINKING ?? null,
    },
    /**
     * WHICH PROMPT THIS RUN ACTUALLY RAN, as a hash of the assembled bytes.
     *
     * The prefix is the main independent variable in this repo — it is what
     * `npm run ab -- --variant doctrine=<file>` exists to change — and until now
     * only `ab` ever hashed it. Everything else recorded `{head: <120 chars>,
     * chars: 71411}` on the turn, and 71,411 was the value in every context row
     * of every run across seven git shas, because a length is not an identity.
     * `ab`'s own arms prove the point: two prefixes, both real, 71,411 and 71,468
     * characters, distinguishable by sha and by nothing else here.
     *
     * `git.sha` does not cover it: `dirty` is routinely non-zero, and the
     * doctrine is a file the tree can carry uncommitted.
     */
    prefix: await prefixIdentity(),
    env: {
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      transport: process.env.TRANSPORT ?? null,
      database: db,
      tz: TZ,
    },
    // `ref` is what was typed and `is` is what it turned out to mean. A manifest
    // is a file people paste into issues, and "worlds/multi-coach.json" pasted
    // into one six months from now names whatever that file holds then.
    world: { academyId, academyName, ref: plan.ref, is: plan.is },
    /**
     * What was supposed to happen to the business this week, beside what the
     * business was.
     *
     * The same argument the `world` field above rests on: `events/monsoon.json`
     * pasted into an issue six months from now names whatever that file holds
     * then, and a chaos rate rolled off a seed is unreproducible without both the
     * rate and the seed. `--seed` is already in `config.json`; this is what makes
     * the two readable together.
     */
    events: { ref: week.ref, chaos: week.spec.chaos ?? {}, count: week.spec.events?.length ?? 0 },
    argv: process.argv.slice(2),
  }
}

/**
 * `windowsPerSeat` moved to `_world-file.ts` beside `deriveSchedule`, because
 * `live.ts` deals a week out of a world file too and the two instruments must not
 * hold two answers to "who is at a phone when".
 */

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

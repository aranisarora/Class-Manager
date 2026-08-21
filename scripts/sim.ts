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
const { briefsFromWorld, FAMILIES, INPUT_REALISM, PERSONAS, SCHEDULE, TIMETABLE, WINDOW_AT, windowCounts } =
  await import('./_personas')
const { RAMP_LIFE, TIERS } = await import('./_ramp')
const { SEAT_EFFORT } = await import('./_persona-agent')
/**
 * Who has turned up since the run started. Imported here with the rest, because
 * it reads the database and the database is what every other import above needs
 * the environment loaded for.
 */
const { arrivals } = await import('./_arrivals')
const { BLANK_WORLD, describeConfig, makeBudget, recordedConfig, resolveConfig } =
  await import('./_drive-config')
const { costInr, USD_INR } = await import('@/lib/pricing')

type PersonaKey = import('./_personas').PersonaKey
type Brief = import('./_personas').Brief
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

/** The canonical business. The four base36 characters after it are the run's token. */
const NAME = 'Ace Tennis Academy'
/**
 * Every world this driver has made, and nothing else — built from `NAME` so the
 * two cannot drift apart. A bare `Ace Tennis Academy` does not match, which is
 * deliberate: `_world.ts` builds one, and `gc` must never reap a world it cannot
 * prove came from here.
 */
const MINE = new RegExp(`^${NAME} [0-9a-z]{4}$`)

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
  academyId: string
  academyName: string
  /** Contact id per SEAT KEY — what `_seat-worker.ts` looks itself up by. */
  contacts: Record<string, string>
  roster: { name: string; role: string; contactId: string; phone: string }[]
}

/**
 * Which academy, resolved before a run directory exists.
 *
 * Everything expensive is behind `build`. Reading a spec, refusing it, composing
 * its briefs and dealing its week all happen first, so a misspelled key in a
 * hand-written file costs a second and leaves nothing behind — never half a world
 * and then a stack trace, which is a business on a shared sender that nobody
 * afterwards can prove is dead.
 */
type WorldPlan = {
  /** The reference, exactly as `--world` had it. `canonical` when it was absent. */
  ref: string
  /** One English line about the business, for the top of the run and the record. */
  is: string
  /** Every seat this world has, keyed as the driver and the worker name them. */
  briefs: Record<string, Brief>
  /** Who is at a phone, in which window of which day. */
  schedule: Record<number, Record<WindowName, string[]>>
  build(token: string, log: (s: string) => void): Promise<BuiltWorld>
}


/* ========================================================================== *
 * WHICH WORLD
 * ========================================================================== */

/** The last day `SCHEDULE` puts anybody at a phone. Seven, read rather than typed. */
const SCHEDULED_DAYS = Math.max(...Object.keys(SCHEDULE).map(Number))

/**
 * How thickly the canonical week fills its windows, read off `SCHEDULE`.
 *
 * Twenty-four seat turns over fourteen windows — a shade under two people at a
 * phone at once, which is what a Tuesday evening at a real academy looks like and
 * is the only density anybody here has driven and read back. A derived week aims
 * at the same figure rather than at one speaker per window, because concurrent
 * messages are half of what this instrument is for: a world with eleven people in
 * it and one speaker per window is a different instrument wearing this one's name.
 */
const DENSITY =
  Object.values(windowCounts(SCHEDULED_DAYS)).reduce((a, b) => a + b, 0) /
  (SCHEDULED_DAYS * ALL_WINDOWS.length)


/**
 * Deal a world's own seats across its windows, evenly, and prove it before the
 * first sentence is typed.
 *
 * `SCHEDULE` gives the canonical four six windows each and `live.ts` asserts it,
 * because a week that gives the owner eleven windows and a client two reports the
 * owner's experience as though it were the product's — and three of one drive's
 * open findings came off a phone with no role attached to it. A spec world has no
 * hand-written schedule to assert, so this deals one that is balanced by
 * construction and then checks the construction.
 *
 * Turn `t` goes to cell `floor(t·cells/turns)` and to seat `t mod seats`, which
 * gives every seat exactly the same number of windows and puts consecutive seats
 * in consecutive turns — so two turns landing in one window are two different
 * people, which is what the harness needs and what a naive shuffle does not
 * guarantee. Both facts are asserted below anyway: this file's own history is a
 * comment claiming a balance the code beneath it did not have.
 */
function deriveSchedule(
  seats: string[],
  days: number,
  windows: WindowName[],
): Record<number, Record<WindowName, string[]>> {
  if (!seats.length) die('a world with nobody in it cannot be driven')
  const cells = days * windows.length
  /**
   * At most one window per seat per cell — `cells` is the ceiling, and it binds
   * for a world with one person in it, where the canonical density would put the
   * owner at his own phone twice in one evening.
   */
  const perSeat = Math.min(cells, Math.max(1, Math.round((cells * DENSITY) / seats.length)))
  const turns = perSeat * seats.length

  const dealt: string[][] = Array.from({ length: cells }, () => [])
  for (let t = 0; t < turns; t++) {
    ;(dealt[Math.floor((t * cells) / turns)] as string[]).push(seats[t % seats.length] as string)
  }

  const counts = new Map<string, number>(seats.map((s) => [s, 0]))
  dealt.forEach((cell, i) => {
    const seen = new Set<string>()
    for (const who of cell) {
      if (seen.has(who)) {
        die(`derived schedule puts ${who} at a phone twice in window ${i + 1} of ${cells}`)
      }
      seen.add(who)
      counts.set(who, (counts.get(who) ?? 0) + 1)
    }
  })
  const spread = [...counts.values()]
  if (Math.max(...spread) !== Math.min(...spread)) {
    die(
      `derived schedule is not balanced: ${[...counts].map(([k, v]) => `${v} ${k}`).join(' · ')}`,
    )
  }
  const empty = dealt.filter((cell) => !cell.length).length
  if (empty) {
    console.log(
      c.yellow(
        `  !  ${empty} of ${cells} windows have nobody at a phone — ${seats.length} seats over ${days} days does not fill them`,
      ),
    )
  }

  const schedule: Record<number, Record<WindowName, string[]>> = {}
  for (let d = 1; d <= days; d++) {
    const row = {} as Record<WindowName, string[]>
    windows.forEach((w, i) => {
      row[w] = dealt[(d - 1) * windows.length + i] ?? []
    })
    schedule[d] = row
  }
  return schedule
}

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
 * Nothing here writes a row. A spec that will not parse, a key nobody spelled
 * right, a `--personas` naming somebody who is not in the file: all of them stop
 * the process here, before a run directory, before an academy, and therefore
 * before there is a business on a shared sender that nobody can afterwards prove
 * is dead.
 */
async function planWorld(cfg: DriveConfig): Promise<WorldPlan> {
  /**
   * Imported here rather than at the top, because a canonical run should not have
   * to load the spec reader to not use it — and because the failure this branch is
   * about is a hand-written file, which cannot break a run that named no file.
   */
  const { BLANK, buildWorld: buildSpecWorld, describeWorld, loadWorldSpec, validateSpec } =
    await import('./_world-spec')

  /**
   * The refusal is printed, not thrown.
   *
   * `validateSpec` names the exact path and the exact value — `classes[0].days[0]
   * — is "tues". One of: sun, mon, tue, …` — and it is a hand-written file that
   * put it there, so the person who needs that line is at this terminal now.
   * Thrown, tsx puts it under six frames of `node:internal` and above a
   * `Node.js v22` banner, which is the precise defect `_drive-config.ts`'s `fail()`
   * exists to avoid: "the one line that matters ends up under twelve frames of
   * node internals, in a terminal somebody is about to scroll past." Nothing has
   * been built at this point, so there is nothing to unwind and no reason to keep
   * the stack.
   */
  let spec: import('./_world-spec').NormalSpec
  try {
    spec =
      cfg.world === BLANK_WORLD ? validateSpec(BLANK, 'the blank world') : await loadWorldSpec(cfg.world)
  } catch (e) {
    die((e as Error).message)
  }

  /**
   * The briefs come from `_personas.ts` and this file writes none of its own.
   *
   * `briefsFromWorld` composes one per person out of the spec the world is built
   * from, so no sentence in a brief can contradict the database. A loop here would
   * be a second place to forget the admin or to hand a client's name over with the
   * coach role — see that function's own header.
   */
  const all = briefsFromWorld({ spec, days: cfg.days })
  const known = new Map(all.map((b) => [b.key, b]))
  /**
   * Named seats win over a count, because a list is the more specific thing to
   * have asked for. `--seats N` takes the first N this world has, in the order
   * `buildWorld` creates them — the admin, then coaches, then clients, then
   * prospects — so a cheap run is a shape anybody can ask for without knowing
   * who lives in the world yet.
   */
  const chosen = cfg.personas.length
    ? cfg.personas.map((k) => seatIn(known, k, cfg.world))
    : cfg.seats > 0
      ? all.slice(0, cfg.seats)
      : all

  return {
    ref: cfg.world,
    is: describeWorld(spec),
    briefs: Object.fromEntries(known),
    schedule: deriveSchedule(chosen.map((b) => b.key), cfg.days, cfg.windows),
    async build(token, log): Promise<BuiltWorld> {
      const built = await buildSpecWorld(spec, { token, log })

      /**
       * The clock is set AFTER the build, and it is the one thing here that
       * cannot be done in the right order.
       *
       * `_world-spec.ts` says to set the academy's clock first and it is right:
       * every date it writes is `app.now()` minus an interval. But a clock is a
       * `sim_clock` row per tenant (0024) and a tenant cannot have one before it
       * exists, and `buildWorld` is the thing that makes it exist. Setting the
       * WORLD clock instead would move every other academy in the database,
       * including one another drive is in the middle of — which is the failure the
       * per-tenant clock was added to fix.
       *
       * So the two historical dates it writes — a class's `starts_on` and an
       * enrolment's `started_on` — are relative to the world clock rather than to
       * this academy's Monday, and are therefore up to a week further back than
       * they would otherwise be. That is harmless: they only have to be in the
       * past. What is NOT harmless is a world clock wound forward past the week
       * this run opens on, which would leave a business whose classes have not
       * started yet and whose week is silent for a reason nothing prints. That is
       * counted and refused.
       */
      const { DateTime } = await import('luxon')
      let monday = DateTime.now().setZone(spec.timezone).startOf('week').set({ hour: 6, minute: 0, second: 0, millisecond: 0 })
      if (monday <= DateTime.now().setZone(spec.timezone)) monday = monday.plus({ weeks: 1 })
      await clock.setTo(monday.toJSDate(), built.academyId)
      log(`clock set to ${monday.toFormat('EEE d LLL yyyy, HH:mm')} ${spec.timezone}`)

      const zone = spec.timezone.replace(/'/g, "''")
      const [ahead] = await q<{ n: number }>(
        built.academyId,
        `select (select count(*) from class where starts_on > (app.now() at time zone '${zone}')::date)
              + (select count(*) from enrollment where started_on > (app.now() at time zone '${zone}')::date) as n`,
      )
      if (Number(ahead?.n ?? 0) > 0) {
        die(
          `${built.academyName} has ${ahead?.n} classes or enrolments that have not started yet — ` +
            `the world clock was ahead of ${monday.toFormat('d LLL yyyy')} when the world was built. ` +
            `Wind the shared clock back to real time and run again.`,
        )
      }

      const contacts: Record<string, string> = {}
      for (const b of all) {
        const id = built.contacts[b.name]
        if (!id) die(`${b.name} has a brief and no contact in ${built.academyName}`)
        contacts[b.key] = id as string
      }
      return { academyId: built.academyId, academyName: built.academyName, contacts, roster: built.roster }
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
   *
   * A spec world's week has already been through the same assertion, one that
   * refuses rather than warns — `deriveSchedule` built it, so it is a construction
   * this file is responsible for rather than a table somebody wrote by hand.
   */
  const counts = canonical ? windowCounts(cfg.days) : windowsPerSeat(plan.schedule, cfg)
  const spread = Object.values(counts)
  const whole =
    canonical && cfg.personas.length === ALL_PERSONAS.length && cfg.windows.length === ALL_WINDOWS.length
  const balance = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(' · ')
  if (whole && Math.max(...spread) !== Math.min(...spread)) {
    die(`seats are not balanced over ${cfg.days} days: ${balance}`)
  }

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
  console.log(c.dim(`  schedule: ${balance}${whole || !canonical ? '' : ' (before this run’s filters)'}\n`))

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
  const academyName = world.academyName
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
      ramp: cfg.ramp,
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
  await writeSidecar(dir, 'manifest.json', await manifest(cfg, plan, academyId, academyName, dir))
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
  const settle = async (): Promise<number> => {
    const turns = await readTurns(dir)
    const total = turns.reduce((a, t) => a + (typeof t.inr === 'number' ? t.inr : 0), 0)
    // Deltas, because `spend` accumulates and the log is a running total.
    budget.spend(total - counted)
    counted = total
    return total
  }

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
      const walked = await queue(session, `d${day}-${w}-queue`, () => walkTo(academyId, WINDOW_AT[w]), {
        window: w,
      })
      /**
       * Nobody is asked to speak into a business that is not there. A deleted
       * world surfaces at the window's clock walk, above, because the clock is
       * the first thing a window touches — and every seat after it would spend a
       * model call to be shown an empty phone and say something into nothing.
       */
      if (stoppedBy) break
      const at = clock.inZone(await clock.now(academyId), TZ)
      const active = (plan.schedule[day]?.[w] ?? []).filter((k) => driven.has(k) && !gone.has(k))
      console.log(
        `    ${at.time} ${c.bold(w.padEnd(8))} ${c.dim(`${walked.length} jobs`)}` +
          `  ${c.dim(active.length ? active.join(', ') : '(nobody at a phone)')}`,
      )

      await inFlight(active, width, async (key) => {
        const seat = seats.get(key)
        if (!seat) return
        /**
         * `life` is written against `TIMETABLE` and `FAMILIES` in `_personas.ts`,
         * which is what the canonical world is built from, so a brief cannot name
         * a day or a person the database does not have.
         *
         * `RAMP_LIFE` overrides it under `--ramp` and is anchored to the same
         * fixtures, but it is NOT covered by that guarantee everywhere: its
         * Tuesday brief has Latha paying off LAST month's fees, and no fixture
         * here writes a closed period — the product bills the open one itself on
         * the first drain, so there is nothing behind it to settle. Read a ramped
         * arrears turn as a harness gap before filing it as a defect.
         *
         * A spec world's briefs carry no `life` at all, deliberately — a fever on
         * Tuesday is narrative and no spec holds one, so a generated life event
         * would be invention handed to the seat as circumstance. Those seats get
         * no `today` and the phone says nothing unusual is happening. `--ramp` is
         * refused outright against a spec world, because `RAMP_LIFE` is keyed by
         * the four names and every lookup would miss in silence.
         */
        const today = (cfg.ramp ? RAMP_LIFE[key as PersonaKey]?.[day] : undefined) ?? plan.briefs[key]?.life[day]
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
            `${what}${attached} ${c.dim(`· ${told.arrived} back · ${Math.round(told.ms / 1000)}s`)}`,
        )
      })

      /**
       * Everything the window's own messages set off, drained where the clock
       * stands. A reply that promises a reminder promises a job, and a job that
       * runs after the record closes is a promise nothing in the record kept.
       */
      const after = await queue(session, `d${day}-${w}-drain`, () => drain(academyId), { window: w })

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
      `\n  sim gc — "${NAME} <token>" and spec worlds on +9194 numbers, older than ${hours}h\n`,
    ),
  )
  let dropped = 0
  for (const id of await worldAcademyIds({ refresh: true })) {
    const [row] = await withSession({ role: 'service', academyId: id }, async (tx) =>
      (await tx`select a.name, a.created_at,
                       exists (select 1 from contact c
                                where c.academy_id = a.id and c.phone_e164 like '+9194%') as spec
                  from academy a where a.id = ${id}::uuid` ) as unknown as {
        name: string
        created_at: string | Date
        spec: boolean
      }[],
    )
    if (!row) continue
    // Either this driver's own name with a token on it, or a world the spec
    // builder made — proved by the number block only it allocates from — whose
    // name also ends in a run token. See the header.
    if (!MINE.test(row.name) && !(row.spec && /^.+ [0-9a-z]{4}$/.test(row.name))) continue
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
    argv: process.argv.slice(2),
  }
}

/**
 * How many windows each seat gets in a schedule this file dealt.
 *
 * `windowCounts` in `_personas.ts` answers the same question about `SCHEDULE` and
 * cannot answer it about anything else — it is written around the four names. This
 * counts whatever is in front of it, so the line a run prints about its balance is
 * the same line whichever world it is in.
 */
function windowsPerSeat(
  schedule: Record<number, Record<WindowName, string[]>>,
  cfg: DriveConfig,
): Record<string, number> {
  const n: Record<string, number> = {}
  for (let d = 1; d <= cfg.days; d++) {
    for (const w of cfg.windows) {
      for (const k of schedule[d]?.[w] ?? []) n[k] = (n[k] ?? 0) + 1
    }
  }
  return n
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

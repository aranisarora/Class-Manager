/**
 * _drive-config — how long, how many, who, and how much, decided in one place.
 *
 *   import { resolveConfig, describeConfig, makeBudget } from './_drive-config'
 *
 *   const cfg = resolveConfig(process.argv.slice(2))
 *   console.log(describeConfig(cfg))
 *   const budget = makeBudget(cfg)
 *
 *   … --preset smoke
 *   … --days 5 --windows morning --personas rahul-menon
 *   … --world blank                 # one person, at a number, in no business
 *   … --world worlds/ace-tennis.json
 *   … --config arms/b.json --arm B --budget-min 45 --budget-inr 250
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * Every drive in this repo already takes parameters, and every one of them takes
 * them differently. `live.ts` reads `--days` and asserts a balanced week from it.
 * `sim.ts` reads its own `--days` and its own `--keep`. The model
 * is whatever string `MODEL_MAIN` held when the process happened to start, which
 * is not the same fact as "which model this run was about". Three of those four
 * leave no mark in the run directory at all.
 *
 * That is survivable while one person drives one week by hand and remembers what
 * they typed. It stops being survivable the moment two runs are compared,
 * because the comparison rests entirely on the claim that everything except the
 * thing under test was held still — and nothing here could state what
 * "everything" was, let alone check it. A config is the smallest object that can
 * be written into the record beside the turns, handed to a second run unchanged,
 * and diffed against the first.
 *
 * WHY A TYPO IS A HARD FAILURE
 * -----------------------------------------------------------------------------
 * `--budgetinr 250` is not a budget of 250 rupees; it is no budget at all, and
 * the run it belongs to looks exactly like the run it was supposed to be.
 * `--personas divya,farrah` asks for two seats and drives one, because nothing
 * in `PERSONAS` is spelled `farrah`. `--preset weeek` runs the default.
 * `-days 5 -preset smoke` — one dash rather than two — returned the untouched
 * default with exit 0 and nothing printed: seven days, both windows, all four
 * seats. None of those four announce themselves anywhere, and all four end with
 * two runs being compared on the strength of a difference that was never
 * applied. So an unrecognised flag, a one-dash flag, an unknown window, an
 * unknown seat, an unknown preset, `days` below one and `concurrency` below one
 * all stop the process before it costs anything. Refusing at second zero is
 * free; finding out during the judgement, two hours and a few hundred rupees
 * later, is not.
 *
 * WHICH WORLD, AND WHY THE DEFAULT IS A WORD RATHER THAN AN ABSENCE
 * -----------------------------------------------------------------------------
 * `--world` names the academy the week happens in. `canonical` is the four-family
 * tennis club `_personas.ts` states once and `sim.ts` builds from it;
 * `blank` is the owner alone, the morning after onboarding finished; anything else
 * is a reference `scripts/_world-spec.ts` resolves — a bare name, a path, or
 * inline JSON. Unset resolves to the *word* `canonical` rather than to nothing,
 * because two runs whose world field is absent are indistinguishable from two runs
 * of the same world, and they may have been about two different businesses.
 *
 * The REFERENCE is carried here and never the spec. Reading one is asynchronous
 * and this function is not — but the real reason is that a spec which resolves is
 * a world that gets BUILT, and the driver is the only thing entitled to decide
 * when rows start existing. So `world` is a string here, and `sim.ts` turns
 * it into an academy before it has opened a run directory, so an unreadable file
 * or a misspelled key costs nothing at all.
 *
 * WHY `personas` IS CHECKED IN TWO PLACES
 * -----------------------------------------------------------------------------
 * It is a subset filter over the seats of whichever world is being driven, and
 * which names are legal therefore depends on the world. Against `canonical` the
 * four are known here, so a fifth is refused here, free, with the legal ones
 * printed. Against a spec world the seats are that spec's own people and nothing
 * has read the file yet, so the names are carried as written and `sim.ts`
 * refuses them against the roster it composed — the same refusal one stage later,
 * and still before anything is created. `[]` means every seat the world has, and
 * only a spec world can produce it.
 *
 * THE BUDGET REPORTS, IT DOES NOT KILL
 * -----------------------------------------------------------------------------
 * "How long does a week take" has a simulated answer already — seven days — and
 * no real one. `makeBudget` gives it a real one, in wall-clock minutes and in
 * rupees, and it is the same rupee `lib/pricing.ts` prints, because that is the
 * one converter.
 *
 * It never aborts anything. `_capture.ts` attributes a turn's evidence by a
 * domain-time cursor — everything stamped at or after the moment the turn began
 * belongs to that turn — so a process killed between the model's write and the
 * record's flush leaves those messages, jobs and SQL attributed to nothing, and
 * the turn goes with the rest of the day it was in. `exhausted()` therefore
 * reports, and the caller finishes the turn it is in, stops at the next window
 * boundary, and closes the record the normal way.
 *
 * Nothing here scores anything. `days` and `spentInr()` are numbers about the
 * harness; `exhausted()` names WHICH limit was reached rather than answering
 * whether the run was any good, and both limits stay readable afterwards so a
 * reader can see how close the other one came.
 */
import { readFileSync } from 'node:fs'

import { env } from '@/lib/env'

import { c } from './_env'
import { WINDOW_AT, type Window } from './_personas'

/**
 * `_personas` calls it `Window`, which is a word the DOM also owns. Aliased here
 * exactly as `live.ts` aliases it, rather than declared a second time — a second
 * declaration is how a window gets added in one file and not the other.
 */
export type WindowName = Window
/** A seat key, derived from a name in the world file: `Rahul Menon` → `rahul-menon`. */
export type PersonaKey = string

export type DriveConfig = {
  /**
   * Simulated days to run. **No ceiling** — a week, a fortnight, a billing month.
   *
   * It was capped at seven for most of this file's life, which put every question
   * needing more than one week out of reach: a monthly bill correct only on the
   * 1st, a ten-session package exhausting in week three, dunning escalating over
   * three cycles, a family going quiet for a fortnight before it leaves.
   *
   * Simulated length, never real length — `budgetMin` and `budgetInr` are the
   * real stop, and confusing the two is the expensive mistake this file exists to
   * prevent. Past the last day anybody wrote a `life` for, the days are ordinary
   * unless `events` or `chaos` fills them; `sim.ts` prints where that line falls.
   */
  days: number
  /** Which windows run each day, in the order the clock reaches them. */
  windows: WindowName[]
  /**
   * Which seats are in this run, as a subset of the world's own people.
   *
   * Against `canonical` these are the four in `_personas.ts`, checked here, and a
   * subset filters `SCHEDULE` rather than rewriting it. Against a spec world they
   * are that spec's people, checked by the driver once the file has been read.
   * `[]` means all of them and is reachable only for a spec world.
   */
  personas: string[]

  /**
   * A cap on how many of the world's seats take part, when you have not named
   * them. `0` is "all of them".
   *
   * It exists so a cheap run can be asked for as a SHAPE. `--personas` needs the
   * keys a world derives (`client-divya-rao`), which the run prints and nobody
   * wants to type; `--seats 2` is the same request without needing to know who
   * lives there. Named seats win: `--personas` and `--seats` together is the list,
   * because a list is the more specific thing to have asked for.
   */
  seats: number
  /**
   * The academy this week happens in: `canonical`, `blank`, or a reference
   * `loadWorldSpec` resolves — a bare name, a path, or inline JSON.
   */
  world: string
  /**
   * Seats in flight per window. `0` is "as many as there are seats", which is
   * what the default means everywhere and the only way to say it before a spec
   * world has been read and its people counted.
   */
  concurrency: number
  /** Stop cleanly after this many real minutes. Absent means no time limit. */
  budgetMin?: number
  /**
   * Stop cleanly after this many rupees OF THE MODEL UNDER TEST. Absent means no
   * money limit.
   *
   * The persona seats are not in this number, and in `sim` they dwarf it — a week
   * that cost the product ₹13.71 cost ₹240.62 in Claude playing its twelve
   * families. Counting both made the flag a cap on the instrument rather than on
   * the thing being measured; `scripts/sim.ts` carries the incident.
   */
  budgetInr?: number
  /** The persona agents' seed. The identity of a repeat — pass it back to repeat. */
  seed: string
  /** The model under test. Defaults to `MODEL_MAIN`, and is recorded either way. */
  model: string

  /**
   * Who plays the PEOPLE. Never the model that plays the product.
   *
   * `claude:sonnet` is the default and `claude:haiku` the cheaper one; both go
   * through the `claude` CLI, which spends a Claude Code subscription rather than
   * the DeepSeek balance. That split is deliberate twice over.
   *
   * The money half: DeepSeek credit is reserved for the brain, because the brain
   * is the thing being tested and the seats are only there to press on it.
   *
   * The measurement half matters more. The seats used to be the same model as the
   * brain, which is the one arrangement guaranteed to flatter the result: a model
   * reading a reply its own kind wrote parses the dense part, tolerates the
   * jargon, and finds the important number in sentence four. The person this
   * product is for does none of that. Same-model seats therefore under-report
   * confusion, and confusion is most of what a week is for.
   */
  seatModel: string
  /**
   * What happens to the business during the week — a name, a path or inline JSON
   * that `scripts/_events.ts` resolves. Empty means nothing happens, which is
   * what every run before this flag existed was measuring.
   *
   * Separate from `world` on purpose, and the separation is the whole point of
   * the flag: `worlds/` says what the business IS and `events/` says what the
   * week DOES to it, so one scenario runs against six businesses and one business
   * runs through six scenarios without either file being edited. A `week` block
   * inside a world file says the same thing for a world whose weather is part of
   * its identity, and the two compose.
   */
  events: string
  /**
   * Rates for the things nobody wrote down — `absent`, `quiet`, `lag`, `washout`.
   *
   * Rolled off `seed`, so a chaotic week is reproducible and an A/B's two arms
   * get the SAME weather. Every roll is materialised into the record exactly as
   * though somebody had typed it: a harness whose randomness is invisible in its
   * own record produces runs nobody can explain afterwards.
   */
  chaos: Record<string, number>
  /** Which side of an A/B this is. Set by the runner, carried into the record. */
  arm?: string
  /**
   * Leave the world in the database afterwards, to poke at. **Default true.**
   *
   * It defaulted to false for most of this file's life, on the reasoning that a
   * run which litters a shared sender with dead businesses is a run that makes
   * the next one harder to read. That reasoning was sound and the trade was still
   * wrong: the thing a drive produces is a business, and dropping it at teardown
   * meant every run had to be re-driven — at the cost of a week — before anybody
   * could look at what it built. A record answers what happened; only the rows
   * answer what it is like to use.
   *
   * `--drop` is the opt-out, and `gc` is what makes the default safe: it reaps by
   * age and only ever matches a name this driver made. See `collectGarbage`.
   */
  keep: boolean
}

/* ------------------------------------------------------------ what exists */

/**
 * Canonical order, taken from the data rather than retyped.
 *
 * The window order is load-bearing and not presentation. A drive walks the
 * academy clock FORWARD to each window's local hour, so asking for evening
 * before morning on the same day walks to 20:15 and then asks for 08:30 — a walk
 * of zero minutes and a window in which nothing happens. It reads afterwards as
 * a silent morning rather than as a bad flag, so `--windows evening,morning` is
 * put back into the order the clock can actually reach.
 */
const ALL_WINDOWS = Object.keys(WINDOW_AT) as WindowName[]

/**
 * The two worlds that are words rather than files.
 *
 * `canonical` is not a spec and deliberately has none: `sim.ts` builds it
 * out of `TIMETABLE` and `FAMILIES` in `_personas.ts`, which is the ONE statement
 * of that timetable and the thing every `life` string was written against.
 * `worlds/settled-tennis.json` transcribes it and is explicitly the stale copy
 * when the two disagree — so pointing the default at the transcription would make
 * the default world a file that is allowed to be wrong.
 *
 * `blank` is `BLANK` in `scripts/_world-spec.ts`: the owner, alone, at
 * `onboarding_state = 'live'`. It is a word rather than `worlds/blank.json` for
 * the same reason a missing file should not be able to break the default.
 */
export const BLANK_WORLD = 'blank'

/**
 * Who sits in a seat unless somebody says otherwise.
 *
 * Not `MODEL_MAIN`. A run where the product and its customers are the same model
 * is a run that grades its own clarity, and it was the default here until the
 * numbers were looked at.
 */
export const DEFAULT_SEAT_MODEL = 'claude:sonnet'

/**
 * A preset is read-only, arrays included.
 *
 * `Object.freeze` stops at the object it is handed and leaves the arrays under it
 * writable, so freezing each array is the half that matters: a preset given out
 * by reference is one `cfg.windows.pop()` away from meaning something different
 * for the rest of the process. `resolveConfig` copies before it merges, and the
 * freeze is what stops a later edit from quietly undoing the copy.
 */
export type Preset = Readonly<Omit<Partial<DriveConfig>, 'windows' | 'personas'>> & {
  readonly windows?: readonly WindowName[]
  readonly personas?: readonly PersonaKey[]
}

const frozen = (p: Preset): Preset => {
  if (p.windows) Object.freeze(p.windows)
  if (p.personas) Object.freeze(p.personas)
  return Object.freeze(p)
}

/**
 * Named runs, so the common shapes are one word instead of four flags typed
 * slightly differently each time.
 *
 * `smoke` is one day, one window, two seats, and the two seats are read off
 * `SCHEDULE` rather than chosen. Day 1 is `rahul` alone in the morning and
 * `arjun` with `farah` in the evening, so evening is the fuller of the two
 * windows day 1 has, and those two are exactly who it puts there. Name anybody
 * else and `check()` either warns that a seat never gets a window or refuses the
 * run outright for having nobody at a phone — a smoke run driving a schedule of
 * its own is not smoke-testing the harness anybody else runs.
 *
 * `day` and `week` name no seats, and that is a change with a reason rather than
 * a tidy-up. "All four" IS the default, so restating it altered nothing while
 * there was one world — and it stops being nothing the moment `--world` exists,
 * because those four names against a badminton academy are four people who are
 * not in it, and `--preset week --world blank` would then be refused for naming a
 * roster the preset never meant to name. A preset that restates a default is a
 * preset that quietly narrows every world it did not know about.
 */
export const PRESETS: Readonly<Record<string, Preset>> = Object.freeze({
  /**
   * The cheap check, as a SHAPE rather than as two names.
   *
   * It used to name `arjun` and `farah`, who were two of four people welded into
   * one hardcoded academy. There is no such academy now — every world comes from
   * a spec — so naming anybody would make the cheapest run the one thing you
   * could not point at your own world. One day, one window, the first two seats
   * that world has.
   */
  smoke: frozen({ days: 1, windows: ['evening'], seats: 2 }),
  day: frozen({ days: 1, windows: [...ALL_WINDOWS] }),
  week: frozen({ days: 7, windows: [...ALL_WINDOWS] }),
})

/* -------------------------------------------------------------- refusing */

/**
 * Say what is wrong and stop, the way `_danger.ts` does.
 *
 * Not a thrown Error: tsx prints a stack above the message, and the one line
 * that matters — the flag that was misspelled — ends up under twelve frames of
 * node internals, in a terminal somebody is about to scroll past.
 */
function fail(headline: string, ...detail: string[]): never {
  console.error()
  console.error(c.red(`x  ${headline}`))
  for (const d of detail) console.error(`   ${d}`)
  console.error()
  process.exit(2)
}

/** A run that is legal but probably not what was meant. Said out loud, not fixed. */
function warn(headline: string, ...detail: string[]): void {
  console.error(c.yellow(`!  ${headline}`))
  for (const d of detail) console.error(c.dim(`   ${d}`))
}

/* -------------------------------------------------------------- coercion */

/**
 * One source's settings, before the layers are merged.
 *
 * `personas` is the one field that does not arrive as its final type. Which seat
 * names are legal depends on which world is being driven, and the world may be
 * named in a DIFFERENT layer than the seats are — `--world blank --config
 * arms/b.json`, where the file names the seats — so a per-layer check would be
 * reading one layer's names against another layer's world, or against no world at
 * all. The names are carried with the place they were written instead, and
 * `resolveConfig` checks them once, after the merge, when there is a world.
 */
type Layer = Omit<Partial<DriveConfig>, 'personas'> & {
  preset?: string
  personas?: { names: string[]; at: string }
  /**
   * `--drop`, which resolves into `keep` and does not survive as a field of its
   * own. A config carries what a run WAS, and "kept: false" is that; "drop: true"
   * is how somebody asked for it, which is a fact about a command line.
   */
  drop?: boolean
}

const FLAGS = {
  preset: 'value',
  days: 'value',
  windows: 'value',
  personas: 'value',
  seats: 'value',
  'seat-model': 'value',
  world: 'value',
  concurrency: 'value',
  'budget-min': 'value',
  'budget-inr': 'value',
  events: 'value',
  chaos: 'value',
  seed: 'value',
  model: 'value',
  arm: 'value',
  config: 'value',
  keep: 'bare',
  drop: 'bare',
} as const

const FLAG_NAMES = Object.keys(FLAGS)

/** `budget-min` on the command line is `budgetMin` in a config file. One field. */
const camel = (key: string): string => key.replace(/-([a-z])/g, (_m, ch: string) => ch.toUpperCase())

function str(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${at} needs a non-empty value`)
  return value.trim()
}

function num(value: unknown, at: string, o: { int?: boolean; min: number }): number {
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n)) fail(`${at} is not a number: ${String(value)}`)
  if (o.int && !Number.isInteger(n)) fail(`${at} must be a whole number, not ${n}`)
  if (n < o.min) fail(`${at} must be at least ${o.min}, not ${n}`)
  return n
}

/** The four things `chaos` can turn up. Named here so a typo is refused by name. */
const CHAOS_RATES = ['absent', 'quiet', 'lag', 'washout'] as const

/**
 * `--chaos 0.15` or `--chaos absent=0.2,lag=0.1` — one dial, or four.
 *
 * The bare number is the fast path and the reason this flag is worth having: a
 * messy week without authoring one, in eleven characters. The `k=v` form is for
 * when only one thing should be messy, which is most of the time you are chasing
 * something specific.
 *
 * A rate outside 0..1 and an unknown name are both refused rather than clamped or
 * dropped. This is `--budgetinr 250` again: a knob nothing reads is a knob that
 * did nothing, and the run then looks exactly like the run it was meant to be.
 */
function rates(value: unknown, at: string): Record<string, number> {
  const raw = value
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!CHAOS_RATES.includes(k as (typeof CHAOS_RATES)[number])) {
        fail(`${at}: unknown chaos rate "${k}"`, `rates: ${CHAOS_RATES.join(', ')}`)
      }
      out[k] = num(v, `${at}.${k}`, { min: 0 })
      if (out[k]! > 1) fail(`${at}.${k} is a probability and must be between 0 and 1, not ${out[k]}`)
    }
    return out
  }

  const text = str(raw, at)
  if (!text.includes('=')) {
    // A value with a separator in it but no `=` is somebody reaching for the
    // named form and missing, not somebody typing one dial. Saying "is not a
    // number" there is true and useless.
    if (/[,:]/.test(text)) {
      fail(
        `${at}: "${text}" is neither one rate nor name=rate pairs`,
        `--chaos 0.15 turns all four up; --chaos absent=0.2,lag=0.1 names them.`,
      )
    }
    const n = num(text, at, { min: 0 })
    if (n > 1) fail(`${at} is a probability and must be between 0 and 1, not ${n}`)
    return Object.fromEntries(CHAOS_RATES.map((k) => [k, n]))
  }

  const out: Record<string, number> = {}
  for (const part of text.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim())
    if (!k || v === undefined) fail(`${at}: "${part.trim()}" is not name=rate`)
    if (!CHAOS_RATES.includes(k as (typeof CHAOS_RATES)[number])) {
      fail(`${at}: unknown chaos rate "${k}"`, `rates: ${CHAOS_RATES.join(', ')}`)
    }
    const n = num(v, `${at}.${k}`, { min: 0 })
    if (n > 1) fail(`${at}.${k} is a probability and must be between 0 and 1, not ${n}`)
    out[k!] = n
  }
  return out
}

function bool(value: unknown, at: string): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === '' || s === 'true' || s === '1') return true
  if (s === 'false' || s === '0') return false
  return fail(`${at} is a switch: give it nothing, or true/false — not ${String(value)}`)
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * A world reference, from a flag or from the `config.json` a run wrote.
 *
 * `--world blank` is a word and `--world worlds/multi-coach.json` is a path, so
 * on a command line this is just a string. A recorded config carries
 * `{"ref": …, "is": …}` instead, because a run that wrote down only the path
 * recorded a filename which may since have been edited under it — `is` is the one
 * English line `describeWorld` produced at the time, and it is evidence about what
 * that reference MEANT on the day. The ref is the load-bearing half; reading one
 * back takes the ref and leaves the sentence where it is.
 *
 * Any other key inside is refused, on the same reasoning as every other refusal
 * here: a `world` object carrying `"days"` is a setting nothing applies.
 */
function worldRef(value: unknown, at: string): string {
  if (!isObj(value)) return str(value, at)
  const extra = Object.keys(value).filter((k) => k !== 'ref' && k !== 'is')
  if (extra.length) {
    fail(`${at}.${extra[0]}: not part of a recorded world`, 'A world holds `ref`, and `is` for the line it was described by.')
  }
  return str(value.ref, `${at}.ref`)
}

/** `a,b` from the command line, `["a","b"]` from a file, one shape out of both. */
function list(value: unknown, at: string): string[] {
  const parts = Array.isArray(value) ? value.map((v) => String(v)) : String(value).split(',')
  const out = parts.map((p) => p.trim()).filter((p) => p.length > 0)
  if (!out.length) fail(`${at} is empty`)
  return out
}

/**
 * Keep only names that exist, and name the ones that do not.
 *
 * "unknown persona" without the name is a message that sends the reader back to
 * their shell history to work out what they typed.
 */
function pick<T extends string>(values: string[], legal: readonly T[], at: string, what: string): T[] {
  const bad = values.filter((v) => !(legal as readonly string[]).includes(v))
  if (bad.length) {
    fail(
      `${at}: no such ${what} ${bad.map((b) => `"${b}"`).join(', ')}`,
      `known ${what}s: ${legal.join(', ')}`,
      'A name nothing matches is a name nothing ran, and the run says nothing about it.',
    )
  }
  // De-duplicated and put back in the declared order. `--windows evening,morning`
  // and a seat named twice are both typing, not intent.
  return legal.filter((k) => values.includes(k))
}

/**
 * Turn one source's raw keys into config fields, or refuse.
 *
 * `where` is what the reader typed, so a bad value in a file names the file and
 * a bad flag names the flag: `arms/b.json: days` against `--days`.
 */
function toLayer(raw: Record<string, unknown>, where: (key: string) => string): Layer {
  const L: Layer = {}
  for (const [key, value] of Object.entries(raw)) {
    const at = where(key)
    switch (camel(key)) {
      case 'preset':
        L.preset = str(value, at)
        break
      case 'seatModel': {
        const v = str(value, at)
        /**
         * DeepSeek credit is for the brain. A seat on the same model as the
         * product is also the one arrangement that flatters the result, so this
         * is refused rather than warned about — a warning scrolls past and the
         * run still happens, and the run is the thing that would be wrong.
         */
        if (!v.startsWith('claude:')) {
          fail(
            `${at} is "${v}", and a seat is played by Claude`,
            'DeepSeek credit is reserved for the brain. A seat played by the brain',
            'grades its own clarity — it finds the reply clearer than the person on',
            'the phone ever will.',
            'Use claude:sonnet (the default) or claude:haiku.',
          )
        }
        L.seatModel = v
        break
      }
      case 'seats':
        L.seats = num(value, at, { int: true, min: 1 })
        break
      case 'days':
        L.days = num(value, at, { int: true, min: 1 })
        break
      case 'windows':
        L.windows = pick(list(value, at), ALL_WINDOWS, at, 'window')
        break
      case 'personas':
        // Not checked against the four here — see `Layer`. Only that it is a
        // non-empty list of names, which is true of every world.
        L.personas = { names: list(value, at), at }
        break
      case 'world':
        L.world = worldRef(value, at)
        break
      case 'events':
        // Not resolved here. A reference is a name, a path or inline JSON and
        // only `_events.ts` knows which; resolving it in two places is how the
        // two come to disagree about what `monsoon` means.
        L.events = str(value, at)
        break
      case 'chaos':
        L.chaos = rates(value, at)
        break
      case 'concurrency':
        L.concurrency = num(value, at, { int: true, min: 1 })
        break
      case 'budgetMin':
        L.budgetMin = num(value, at, { min: 0 })
        break
      case 'budgetInr':
        L.budgetInr = num(value, at, { min: 0 })
        break
      case 'seed':
        L.seed = str(value, at)
        break
      case 'model':
        L.model = str(value, at)
        break
      case 'arm':
        L.arm = str(value, at)
        break
      case 'keep':
        L.keep = bool(value, at)
        break
      case 'drop':
        // The opt-out, and a flag of its own rather than `--keep false`, because a
        // bare flag that also takes a value is two flags wearing one name — and
        // `--keep` with no value has meant "keep" in every run ever recorded here.
        L.drop = bool(value, at)
        break
      case 'config':
        // Only reachable from inside a file: `resolveConfig` takes the CLI's
        // `--config` out before the flags become a layer.
        fail(`${at}: a config file cannot name another config file`, 'Put the settings in this one.')
        break
      default:
        fail(`${at}: not a setting`, `settings: ${FLAG_NAMES.filter((f) => f !== 'config').join(', ')}`)
    }
  }
  return L
}

/**
 * `--flag value`, `--flag=value`, and bare switches.
 *
 * A token with no dash on it is skipped, so a drive whose first argument is a
 * subcommand can pass its whole argv. Its own flags cannot ride along: every
 * dashed token has to be one of the settings above, which is the entire point of
 * the check. A command that has flags of its own hands over the slice it does not
 * own.
 *
 * ONE dash is refused rather than skipped. `-days 5 -preset smoke` used to leave
 * here with an empty `raw`, so the caller got the untouched default — seven days,
 * both windows, all four seats — with exit 0 and nothing printed, which is the
 * silent wrong run the header says this file exists to stop. A value never
 * reaches this test, because the value branch below consumes it and moves the
 * cursor past it: `--days -5` is a bad number, and says so. A lone `-` is left
 * alone, being the stdin convention rather than a flag.
 *
 * `--` on its own is skipped too, and is the one dashed token that is not a
 * setting. Without the skip `token.slice(2)` is `''` and the separator dies as
 * `unknown flag --` — while it is exactly the token a wrapper handing over its
 * whole argv is likeliest to pass through, so refusing it would break the
 * handover the paragraph above promises.
 */
function fromArgv(argv: string[]): Record<string, string | true> {
  const raw: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === '--') continue
    if (!token.startsWith('--')) {
      if (token.startsWith('-') && token.length > 1) {
        const guess = token.slice(1).split('=')[0]!
        fail(
          `${token} has one dash; every flag here takes two`,
          guess in FLAGS ? `Write --${guess}.` : `known flags: ${FLAG_NAMES.map((f) => `--${f}`).join(' ')}`,
          'A flag nothing reads is a parameter that did nothing, and the run then looks',
          'exactly like the run it was supposed to be.',
        )
      }
      continue
    }
    const eq = token.indexOf('=')
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq)
    if (!(name in FLAGS)) {
      fail(
        `unknown flag --${name}`,
        `known flags: ${FLAG_NAMES.map((f) => `--${f}`).join(' ')}`,
        'A flag nothing reads is a parameter that did nothing, and the run then looks',
        'exactly like the run it was supposed to be. That is how an A/B ends up',
        'comparing two things that were never different.',
      )
    }
    if (eq !== -1) {
      raw[name] = token.slice(eq + 1)
      continue
    }
    if (FLAGS[name as keyof typeof FLAGS] === 'bare') {
      raw[name] = true
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) fail(`--${name} needs a value`)
    raw[name] = next
    i += 1
  }
  return raw
}

function fromFile(path: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    fail(`--config could not read ${path}`, e instanceof Error ? e.message : String(e))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    fail(`--config ${path} is not valid JSON`, e instanceof Error ? e.message : String(e))
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`--config ${path} must hold one object of settings`)
  }
  return parsed as Record<string, unknown>
}

/**
 * The default seed is deliberately not a constant.
 *
 * A fixed default would make every run in the repo claim to be a repeat of every
 * other one, which is worse than having no seed at all — the field would read as
 * evidence of sameness while carrying none. So it is stamped, `describeConfig`
 * prints it, and a run is repeated by handing the printed one back as `--seed`.
 */
function stampSeed(): string {
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  return `${t}-${Math.random().toString(36).slice(2, 6)}`
}

/* --------------------------------------------------------------- resolve */

/**
 * The caller gets its own arrays, never the preset's.
 *
 * `resolveConfig(['--preset','week']).windows` used to BE `PRESETS.week.windows`,
 * so one `cfg.windows.pop()` rewrote what `week` meant for every later resolve in
 * the same process — and the A/B runner resolves both arms in one process, which
 * would leave two configs differing by something nobody asked for. That is the
 * precise defect this file exists to stop, arriving from inside it. The other two
 * layers were already fresh: `pick()` returns `legal.filter(…)`, a new array each
 * call, and a file is parsed per resolve. Only the preset layer was shared.
 */
function copyPreset(name: string, p: Preset): Layer {
  const { windows, personas, ...rest } = p
  const out: Layer = { ...rest }
  if (windows) out.windows = [...windows]
  // Where the names came from, carried so a refusal can say "--preset smoke names
  // these two" rather than blaming a flag nobody typed.
  if (personas) out.personas = { names: [...personas], at: `--preset ${name}` }
  return out
}

/**
 * Preset, then config file, then flags. Last wins.
 *
 * That is the order of increasing specificity: a preset is what this kind of run
 * usually is, a file is what this campaign of runs is, and a flag is what the
 * person at the keyboard just said about this one.
 */
export function resolveConfig(argv: string[]): DriveConfig {
  // `--config` names where the middle layer comes from; it is not itself one of
  // the settings, so it is taken out before the flags become a layer.
  const { config: configPath, ...rawCli } = fromArgv(argv)
  const cli = toLayer(rawCli, (k) => `--${k}`)

  const file: Layer =
    typeof configPath === 'string' ? toLayer(fromFile(configPath), (k) => `${configPath}: ${k}`) : {}

  const presetName = cli.preset ?? file.preset
  if (presetName !== undefined && !(presetName in PRESETS)) {
    fail(
      `unknown preset "${presetName}"`,
      `presets: ${Object.keys(PRESETS).join(', ')}`,
      'An unknown preset would otherwise fall through to the default, which is a',
      'different run wearing the name of the one that was asked for.',
    )
  }
  const preset: Layer = presetName ? copyPreset(presetName, PRESETS[presetName]!) : {}

  const m = { ...preset, ...file, ...cli }

  const world = m.world ?? BLANK_WORLD
  const windows = m.windows ?? [...ALL_WINDOWS]
  const personas = resolveSeats(m.personas, world)
  const cfg: DriveConfig = {
    days: m.days ?? 7,
    seats: m.seats ?? 0,
    windows,
    personas,
    world,
    /**
     * Everybody at once, which is what the default has always meant. For the
     * canonical world that is four; for a spec world nothing here knows the
     * number yet, so it is carried as `0` and the driver reads it as "all of
     * them" — see `DriveConfig.concurrency`.
     */
    concurrency: m.concurrency ?? personas.length,
    events: m.events ?? '',
    chaos: m.chaos ?? {},
    seed: m.seed ?? stampSeed(),
    model: m.model ?? mainModel(),
    seatModel: m.seatModel ?? DEFAULT_SEAT_MODEL,
    /**
     * `--drop` wins over `--keep`, and over the default, because it is the more
     * specific thing to have asked for: nobody types both by accident, and a
     * person who typed the destructive one meant it.
     */
    keep: m.drop === true ? false : (m.keep ?? true),
    ...(m.budgetMin !== undefined ? { budgetMin: m.budgetMin } : {}),
    ...(m.budgetInr !== undefined ? { budgetInr: m.budgetInr } : {}),
    ...(m.arm !== undefined ? { arm: m.arm } : {}),
  }

  check(cfg)
  return cfg
}

/**
 * Which seats, checked where they can be checked.
 *
 * Against the canonical world an unknown name is refused here, free, with the
 * four legal ones printed. Against a spec world nothing has read the file, so the
 * names go through as written and `sim.ts` refuses them against the roster
 * it composed.
 *
 * The one case worth catching early is a PRESET's seats against a spec world.
 * `smoke` names `arjun` and `farah` because those two are who `SCHEDULE` puts in
 * day 1's evening, which is a fact about the canonical academy and about no other
 * — so the run is not a narrower version of what was asked for, it is a run of two
 * people who do not exist. Said here rather than left to the driver, because the
 * fix is to drop the preset rather than to rename anybody.
 */
function resolveSeats(given: Layer['personas'], world: string): string[] {
  if (!given) return []

  /**
   * No preset names seats any more — `smoke` asks for `seats: 2`, a shape rather
   * than two people — so a name here always came from a flag or a config file,
   * and the driver is the only thing that can check it: it is the only thing that
   * has read the world and knows who lives there.
   */
  return [...given.names]
}

/** Read `MODEL_MAIN` only when nobody named a model, and say so when it is absent. */
function mainModel(): string {
  try {
    return env.MODEL_MAIN
  } catch (e) {
    return fail(
      'no model: --model was not given and MODEL_MAIN could not be read',
      e instanceof Error ? e.message : String(e),
      'Set MODEL_MAIN in .env.local, or name the model on the command line.',
    )
  }
}

/**
 * Everything that would produce a run which is legal, cheap, and about nothing.
 *
 * The expensive version of each of these is the same: the drive runs, the record
 * is written, the report renders, and the emptiness is visible only to somebody
 * who counts the turns and already knows what the count should have been.
 */
function check(cfg: DriveConfig): void {
  if (!cfg.windows.length) fail(`no windows: give at least one of ${ALL_WINDOWS.join(', ')}`)
  const canonical = false

  /**
   * HOW LONG A RUN IS, IS THE DRIVER'S DECISION. There is no ceiling.
   *
   * There used to be one at seven days, and the reason it gave was wrong. It
   * said "day 8 is a second Monday, and a brief written for day 1 would arrive on
   * it" — but nothing anywhere takes a day number modulo anything. `life` is a
   * plain `Record<number, string>`, so day 8 looks up `life[8]`, finds nothing,
   * and the seat is told nothing unusual is happening. Wrong in the other
   * direction, and benign.
   *
   * What the ceiling actually cost was every question that needs more than one
   * week to ask: a monthly bill that is only correct on the 1st, a package of ten
   * exhausting in week three, a family that goes quiet for a fortnight before it
   * leaves, dunning that escalates over three cycles. `probe-model`'s suites
   * cannot ask those either, so nothing here could.
   *
   * Nothing mechanical binds. `deriveSchedule` deals `days × windows` cells for
   * any `days`. `walkTo` walks between two hours of ONE day, so its hop ceiling
   * is per window and not per run. And `materialize_sessions` runs on a ROLLING
   * 21-day horizon re-planned on every walk (`HORIZON_DAYS`, §13), so the
   * timetable keeps being written ahead of the clock however far it goes — the
   * one thing that would have made a long run quietly go silent.
   *
   * What does run out is hand-written prose, and `sim.ts` says so out loud
   * against the real briefs once the world is read: past the last day anybody
   * wrote a `life` for, the days are ordinary. `events/` is how you fill them,
   * and `--chaos` fills them without writing anything.
   *
   * The REAL stop is still `--budget-min` / `--budget-inr`. `--days 90` is a
   * legitimate thing to ask for and a bad thing to sit through, and this file has
   * always kept those two questions apart.
   */
  if (!Number.isInteger(cfg.days) || cfg.days < 1) {
    fail(`--days must be a whole number of days, at least 1 — not ${cfg.days}`)
  }

  /**
   * WHO IS IN THIS RUN CANNOT BE CHECKED HERE ANY MORE, AND THAT IS THE POINT.
   *
   * There used to be sixty lines below this asserting `--personas` against
   * `SCHEDULE` — a hand-written table in `_personas.ts` saying which of four
   * named humans was at a phone in which window of which day. It could refuse an
   * unknown seat for free, and it was the only reason this file imported
   * `PERSONAS` at all.
   *
   * Both are gone with the fixtures. Every person now comes from a world file, so
   * the legal seat names are whatever that file happens to hold, and this module
   * has not read it — `sim.ts` refuses an unknown one against the roster it
   * actually composed, which is the only place the answer exists.
   *
   * The `--ramp` flag went the same way. `RAMP_LIFE` was keyed by the four names,
   * so against any other world every lookup missed, the week was the ordinary
   * one, and the record still said `ramp: true` — a difference that was never
   * applied wearing the name of the one that was asked for. Once every world is a
   * file, "any other world" is all of them, and a flag that can only ever lie is
   * a flag to delete rather than to guard.
   */
}

/* -------------------------------------------------------------- describe */

/**
 * One line, printed at the top of a run and again by whatever reads it back.
 *
 * Everything a repeat needs is on it, the seed included, because a seed nobody
 * prints is a seed nobody can pass back.
 */
export function describeConfig(cfg: DriveConfig): string {
  const parts: string[] = [
    `${cfg.days}d × ${cfg.windows.join('/')}`,
    // Empty seats and zero concurrency are the same sentence — "whoever this
    // world turns out to have" — and printing `` ×0`` would read as a run of
    // nobody rather than as a number the driver has not filled in yet.
    `${cfg.personas.length ? cfg.personas.join(',') : 'every seat'} ×${cfg.concurrency || 'all'}`,
    cfg.model,
    `seed ${cfg.seed}`,
  ]
  // Named only when it is not the default, because a line that says `canonical`
  // on every run is a line nobody reads on the one run it matters.
  parts.push(`world ${cfg.world}`)
  /**
   * Printed only when there is something to print, and always when there is.
   *
   * A week in which it rained and a week in which it did not are different runs
   * and cost different money, and the top line is where somebody comparing two
   * records looks first. Silence here on a run that had weather is how two
   * incomparable records come to look like a repeat.
   */
  if (cfg.events) parts.push(`events ${cfg.events}`)
  const chaos = Object.entries(cfg.chaos).filter(([, v]) => v > 0)
  if (chaos.length) parts.push(`chaos ${chaos.map(([k, v]) => `${k}=${v}`).join(',')}`)
  if (cfg.arm) parts.push(`arm ${cfg.arm}`)
  const limits: string[] = []
  if (cfg.budgetMin !== undefined) limits.push(`${cfg.budgetMin}min`)
  if (cfg.budgetInr !== undefined) limits.push(`₹${cfg.budgetInr}`)
  if (limits.length) parts.push(`budget ${limits.join(' / ')}`)
  // The default is to keep, so `keep` on every line would be noise and `drop` is
  // the word worth reading: it is the one that ends with a business deleted.
  if (!cfg.keep) parts.push('drop')
  return parts.join(' · ')
}

/* ---------------------------------------------------------------- record */

/**
 * The config as a run writes it down, and as `--config` reads it back.
 *
 * Two fields are resolved rather than asked for, and both are unreadable until
 * the world has been built. `personas` is `[]` for a spec world at resolve time
 * and the world's own people afterwards; `concurrency` is `0` there and a count
 * afterwards. Writing `cfg` untouched would put both zeroes in the record, and a
 * reader comparing two runs would be comparing two absences.
 *
 * `world` grows the English line `describeWorld` produced, beside the reference
 * it produced it from. The reference alone is a filename, and a filename is a
 * claim about a file as it stands today rather than about the business that was
 * driven — `worlds/multi-coach.json` names one world this week and could name a
 * different one next month, with nothing in either record to say so.
 *
 * What comes out is still a config file: `--config <that file> --seed <that seed>`
 * repeats the run, because `worldRef` reads the object form and `resolveSeats`
 * carries a spec world's seat names through as written.
 */
/**
 * @mechanism omitUnspecified — every key whose value is its own "unspecified" sentinel is
 *   dropped before a config reaches disk, because the parser refuses each sentinel BY
 *   DESIGN and F-CN's first fix listed the two keys it had measured instead of the class:
 *   on 23 Aug 2026 `npm run ab` died at second zero three times in a row — `seats: 0`,
 *   then `personas: []`, then `events: ""` — each key surviving the previous fix's list,
 *   because ab's parent sidecar never went through `recordedConfig` at all. Both writers
 *   go through this one strip now, so a new sentinel key fails ONCE and is added HERE,
 *   not discovered by a run of arms dying in sequence.
 */
export function omitUnspecified(cfg: DriveConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { ...cfg }
  if (!cfg.seats) delete out.seats
  if (!Array.isArray(cfg.personas) || cfg.personas.length === 0) delete out.personas
  if (!cfg.events) delete out.events
  if (!cfg.chaos || Object.keys(cfg.chaos).length === 0) delete out.chaos
  if (!cfg.concurrency) delete out.concurrency
  return out
}

export function recordedConfig(
  cfg: DriveConfig,
  world: { is: string; seats: string[]; concurrency: number },
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...omitUnspecified(cfg),
    personas: [...world.seats],
    concurrency: world.concurrency,
    world: { ref: cfg.world, is: world.is },
  }
  /**
   * @mechanism recordedConfig — "unspecified" is spelled by ABSENCE on disk, never by a
   *   sentinel value. `seats: 0` means "all of them" in memory and the parser refuses it
   *   from a file (`min: 1`); `personas: []` means "everybody this world has" and `list()`
   *   refuses an empty list. Both round-tripped through `config.json` as literals, so
   *   `npm run ab` handed its children a config its own parser would not accept and both
   *   arms died at second zero. A key whose value is the unspecified sentinel is omitted,
   *   and an absent key re-resolves to the same default on read.
   *   Closes F-CN.
   */
  if (!world.seats.length) delete out.personas
  if (!world.concurrency) delete out.concurrency
  return out
}

/* ---------------------------------------------------------------- budget */

/**
 * What the run has spent so far, and whether either ceiling has been reached.
 *
 * `exhausted()` returns which limit, or null. Not a boolean: `overBudget: true`
 * would be one reader's summary of two numbers, and the two numbers are the
 * evidence — `elapsedMin()` and `spentInr()` stay readable so a record can hold
 * both, including how close the limit that did not trip came to tripping.
 */
export type BudgetState = {
  /** Add what a turn cost, in rupees, from `lib/pricing`. */
  spend(inr: number): void
  /** Which ceiling has been reached, or null. Asked between turns. */
  exhausted(): { hit: 'min' | 'inr' } | null
  /** Real minutes since the budget was made. Wall clock, not the sim clock. */
  elapsedMin(): number
  /** Rupees added so far. */
  spentInr(): number
}

/**
 * Start counting.
 *
 * Nothing in here interrupts anything. The caller asks `exhausted()` where
 * stopping is safe — between turns, or at the end of a window — finishes what it
 * is doing, and closes the record normally. Killing a drive mid-turn instead
 * costs the whole turn and misattributes part of it: `_capture.ts` assigns
 * messages, jobs and SQL to a turn by domain time, so a turn that never flushed
 * leaves its evidence hanging off whatever ran before it.
 */
export function makeBudget(cfg: DriveConfig): BudgetState {
  const startedAt = Date.now()
  let inr = 0
  const elapsedMin = (): number => (Date.now() - startedAt) / 60_000

  return {
    spend(amount: number): void {
      /**
       * A turn the price table cannot price arrives here as a zero or as NaN —
       * `costUsd` returns null for a model `lib/pricing` does not know. NaN would
       * be permanent: every comparison against it is false, so the rupee ceiling
       * could never trip again for the rest of the run. It adds nothing instead,
       * which means a money budget on an unpriced model does not bind — a fact
       * about the price table, not about the run.
       */
      if (Number.isFinite(amount)) inr += amount
    },
    exhausted(): { hit: 'min' | 'inr' } | null {
      if (cfg.budgetMin !== undefined && elapsedMin() >= cfg.budgetMin) return { hit: 'min' }
      if (cfg.budgetInr !== undefined && inr >= cfg.budgetInr) return { hit: 'inr' }
      return null
    },
    elapsedMin,
    spentInr: () => inr,
  }
}

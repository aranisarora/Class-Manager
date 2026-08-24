/**
 * _events — what happens to the business during the week, which the product can
 * only learn by being told.
 *
 * THE HOLE THIS FILLS
 * -----------------------------------------------------------------------------
 * `worlds/` says what the business IS at the moment onboarding finished. Nothing
 * said what happens to it afterwards. A week therefore ran in a world where
 * nothing physical ever occurred: it never rained, nobody was ill, nobody went
 * away, every class ran, and everybody who was enrolled turned up.
 *
 * The sharpest version of the hole is the register. `post_class_register` fires
 * at `session.ends_at` and asks the coach who was there — and **the coach seat
 * had no way of knowing**. `_personas.ts` carries the answer as prose in one
 * persona's `life` ("Everybody was there except Anika Rao"), hand-matched against
 * another persona's `life` on another day, for four people, in one world. Every
 * spec world has no `life` at all, deliberately — `worlds/README.md` calls a
 * generated one "invention dressed as circumstance" — so in every world but the
 * canonical one the coach was **inventing the register**, and the attendance rows
 * a run produced were measuring the seat model's imagination.
 *
 * That is not a small gap in an eval. Attendance is what the §6.4 money is
 * computed from. A run whose registers are invented is a run whose bills are
 * invented, and nothing downstream can tell.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 * -----------------------------------------------------------------------------
 * It is a **ground truth**: a small, seeded, declarative statement of what the
 * physical world did, resolved against the rows that really exist, revealed to
 * each person only from their own angle, and written down beside the record so a
 * reader can compare what the world did with what the product ended up believing.
 *
 * It is **not** a script of what anybody says. The same argument `_personas.ts`
 * opens with applies twice as hard here: a harness that told a seat what to type
 * measures the product against sentences somebody thought of in advance. An event
 * says *"Anika was not there, she had a fever"*. It never says *"tell the bot she
 * was absent"*. Whether anybody mentions it at all is the measurement.
 *
 * And it **never writes to the database.** Not one row. The whole point is that
 * the product must learn a fact from a person who types it; a harness that marked
 * the attendance itself would leave nothing to measure and would still produce a
 * record full of attendance rows. `truth.json` is the world's account of the
 * week; `attendance` is the product's. `npm run truth` prints them side by side
 * and — per this repo's rule — writes no verdict about the difference.
 *
 * SIX VERBS, AND WHY THAT IS THE WHOLE VOCABULARY
 * -----------------------------------------------------------------------------
 * Five of them have a mechanical consequence that prose cannot have, and the
 * sixth is the honest escape hatch for everything else:
 *
 *   absent   a player was NOT at their session. Ground truth, per player per
 *            session, resolved against `app.session_roster`.
 *   present  the same in the other direction — pins somebody as there when a
 *            `chaos` roll or a washout would otherwise have taken them out.
 *   washout  the class did not physically happen: rain, a power cut, a holiday,
 *            a locked gate. The session row still says `scheduled`, because the
 *            product only finds out if a person tells it — which is the test.
 *   away     this person is not at their phone for these windows. Their turn is
 *            SKIPPED, and skipped is recorded as its own thing rather than
 *            dressed as `quiet`: a customer on holiday and a customer who read
 *            your message and put the phone down are different findings.
 *   lag      their phone is behind. Messages newer than `hours` are not shown
 *            this window and roll into the next one, which is how a real reply
 *            comes late rather than never.
 *   note     pure pressure, in their own frame, with no mechanism attached.
 *
 * A seventh verb was not added for "cancel the class", "raise the price", "the
 * coach quits". Those are things a PERSON decides, and a person deciding them is
 * a `note`. The line is: a verb exists when the harness has to do something the
 * seat cannot do for itself.
 *
 * WHY AN EVENT IS RESOLVED AGAINST THE ROWS AND NOT TAKEN AT ITS WORD
 * -----------------------------------------------------------------------------
 * `worlds/README.md` records what it cost to learn this: a coach told his batch
 * ran Monday and Thursday, in a world that ran Monday and Wednesday, wrote a turn
 * that read as a product defect and was a harness one. So `absent: "Anika Rao"`
 * on day 4 is a CLAIM, and it is checked — against the sessions that really exist
 * on day 4 and the roster that is really on them. A name nobody holds, or a
 * player with no session that day, stops the run at second zero with what is
 * actually there. The same reasoning `enrolled: 3` was refused by name for.
 *
 * WHY CHAOS IS MATERIALISED RATHER THAN ROLLED IN PLACE
 * -----------------------------------------------------------------------------
 * `chaos` buys a messy week without authoring one — a rate per verb, rolled off
 * the run's own `--seed`. Every roll it makes is written into `fired` exactly as
 * though somebody had typed it, so a chaotic run reads back identically to a
 * hand-written one and can be re-run by seed. A harness whose randomness is
 * invisible in its own record is a harness that fabricates unexplainable runs.
 *
 * The roll is a HASH of `(seed, verb, day, window, who)` rather than a stream, so
 * adding one event to a file does not reshuffle every other decision in the week.
 * Two runs of a file that differ by one line differ by one line.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Window } from './_personas'

/* ========================================================================== *
 * THE SHAPE                                                                  *
 * ========================================================================== */

export const VERBS = ['absent', 'present', 'washout', 'away', 'lag', 'note'] as const
export type Verb = (typeof VERBS)[number]

/**
 * One thing that happens, as somebody writes it down.
 *
 * `day` and `window` are WHEN, `who` and `class` are WHOM, `why` is the reason in
 * the affected person's own frame — never in the product's. `why` is what reaches
 * a seat, so "fever" becomes "Anika has a fever"; "the register is wrong" would
 * be telling somebody what the product did, which they cannot know.
 */
export type WorldEvent = {
  what: Verb
  /** Simulated day number, a list of them, or `"all"`. Day 1 is a Monday. */
  day: number | number[] | 'all'
  /** Which window. Omitted means both — and for `absent`/`washout`, all day. */
  window?: Window | Window[]
  /** Person NAME, or names. Resolved against the world's own rows. */
  who?: string | string[]
  /** Narrow a `washout` or an `absent` to one class by name. */
  class?: string
  /** The reason, in the affected person's frame. */
  why?: string
  /** `lag` only: how many hours behind their phone is. Default 12. */
  hours?: number
}

export type Chaos = {
  /** Per player, per session: they did not turn up. */
  absent?: number
  /** Per seat, per window: they did not pick the phone up at all. */
  quiet?: number
  /** Per seat, per window: their phone is hours behind. */
  lag?: number
  /** Per day: nothing ran — weather, power, a locked gate. */
  washout?: number
}

/** An events file, or the `week` block of a world file. */
export type EventSpec = {
  about?: string
  chaos?: Chaos
  events?: WorldEvent[]
}

/* ========================================================================== *
 * READING ONE                                                                *
 * ========================================================================== */

/**
 * Several references, stacked left to right — `monsoon,flaky-phones`.
 *
 * Layering is most of what makes a scenario library worth having: the weather,
 * the phones and the school calendar are independent things that happen to the
 * same week, and a library that could not stack them would need one file per
 * COMBINATION. Four scenarios that compose are fifteen weeks; four that do not
 * are four.
 *
 * `events` concatenate and `chaos` rates overwrite by name, so a later file
 * turns a rate up or down rather than adding to it — two files each asking for a
 * 0.2 absence rate mean 0.2, not 0.4, which is the only reading of "and also
 * this" that stays true as the list grows.
 *
 * Inline JSON is never split, because a rate list has commas in it. It is also
 * the one form that cannot be stacked, and that is the right trade: somebody
 * writing JSON on a command line is writing one thing.
 */
export function readEventSpecs(ref: string): { spec: EventSpec; ref: string } {
  const raw = ref.trim()
  if (!raw || raw.startsWith('{')) return readEventSpec(raw)

  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length <= 1) return readEventSpec(raw)

  const read = parts.map((p) => readEventSpec(p))
  return {
    spec: {
      about: read.map((r) => r.spec.about).filter(Boolean).join(' · '),
      chaos: Object.assign({}, ...read.map((r) => r.spec.chaos ?? {})) as Chaos,
      events: read.flatMap((r) => r.spec.events ?? []),
    },
    ref: read.map((r) => r.ref).join(' + '),
  }
}

/**
 * A name, a path or inline JSON — the same three `--world` takes, deliberately.
 *
 * Somebody who has learned one of these flags has learned the other. `monsoon`,
 * `events/monsoon.json` and `{"chaos":{"absent":0.2}}` all work, and a reference
 * that resolves to nothing says which three it tried.
 */
export function readEventSpec(ref: string): { spec: EventSpec; ref: string } {
  const raw = ref.trim()
  if (!raw) return { spec: {}, ref: '' }

  if (raw.startsWith('{')) {
    try {
      return { spec: JSON.parse(raw) as EventSpec, ref: 'inline' }
    } catch (e) {
      throw new Error(`--events was given inline JSON that will not parse: ${(e as Error).message}`)
    }
  }

  const tries = [raw, `${raw}.json`, join('events', raw), join('events', `${raw}.json`)]
  for (const p of tries) {
    let text: string
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    try {
      return { spec: JSON.parse(text) as EventSpec, ref: p.replace(/\\/g, '/') }
    } catch (e) {
      throw new Error(`${p} will not parse: ${(e as Error).message}`)
    }
  }
  throw new Error(
    `no events file called "${raw}" — tried ${tries.map((t) => t.replace(/\\/g, '/')).join(', ')}`,
  )
}

/* ========================================================================== *
 * REFUSING A BAD ONE                                                         *
 * ========================================================================== */

const RATE_KEYS: (keyof Chaos)[] = ['absent', 'quiet', 'lag', 'washout']

/** `a "note"` / `an "absent"`. An error a person reads should read like one. */
const an = (verb: string): string => `${'aeiou'.includes(verb[0] ?? '') ? 'an' : 'a'} "${verb}"`

/**
 * Every rule about an events file, in one place, refusing rather than ignoring.
 *
 * The house argument for this is `_drive-config.ts`'s: a parameter nothing reads
 * is a parameter that did nothing, and the run then looks exactly like the run it
 * was supposed to be. An event nothing fires is worse, because the reader's whole
 * reading of the week rests on believing it rained on Wednesday.
 *
 * The name checks that need the database are NOT here — they are in `bind`,
 * because they need a built world. This is everything answerable from the file.
 */
export function validateEventSpec(spec: EventSpec, days: number): WorldEvent[] {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('an events file must be one JSON object')
  }
  for (const k of Object.keys(spec)) {
    if (!['about', 'chaos', 'events'].includes(k)) {
      throw new Error(`unknown key "${k}" in the events file — known keys: about, chaos, events`)
    }
  }

  if (spec.chaos !== undefined) {
    if (typeof spec.chaos !== 'object' || spec.chaos === null || Array.isArray(spec.chaos)) {
      throw new Error('chaos must be an object of rates, e.g. { "absent": 0.15 }')
    }
    for (const [k, v] of Object.entries(spec.chaos)) {
      if (!RATE_KEYS.includes(k as keyof Chaos)) {
        throw new Error(`unknown chaos rate "${k}" — known rates: ${RATE_KEYS.join(', ')}`)
      }
      if (typeof v !== 'number' || !(v >= 0 && v <= 1)) {
        throw new Error(`chaos.${k} must be a number between 0 and 1, not ${JSON.stringify(v)}`)
      }
    }
  }

  const raw = spec.events ?? []
  if (!Array.isArray(raw)) throw new Error('events must be an array')

  return raw.map((e, i) => {
    const at = `events[${i}]`
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`${at} must be an object`)
    for (const k of Object.keys(e)) {
      if (!['what', 'day', 'window', 'who', 'class', 'why', 'hours'].includes(k)) {
        throw new Error(
          `${at} has an unknown key "${k}" — known keys: what, day, window, who, class, why, hours`,
        )
      }
    }
    if (!VERBS.includes(e.what)) {
      throw new Error(`${at}.what is "${e.what}" — it must be one of ${VERBS.join(', ')}`)
    }

    /**
     * A day outside the week is the `--daays` failure wearing a different hat: the
     * run happens, the event does not, and nothing says so. `"all"` is the way to
     * mean every day, and it stays right when `--days` changes.
     */
    const dayList =
      e.day === 'all' ? Array.from({ length: days }, (_, n) => n + 1)
      : Array.isArray(e.day) ? e.day
      : [e.day]
    for (const d of dayList) {
      if (typeof d !== 'number' || !Number.isInteger(d) || d < 1) {
        throw new Error(`${at}.day must be a day number, a list of them, or "all" — got ${JSON.stringify(e.day)}`)
      }
      if (d > days) {
        throw new Error(
          `${at} is on day ${d} and this run is ${days} day${days === 1 ? '' : 's'} long, so it would never fire.\n` +
            `   Shorten the event or run --days ${d}.`,
        )
      }
    }

    const windows =
      e.window === undefined ? (['morning', 'evening'] as Window[])
      : Array.isArray(e.window) ? e.window
      : [e.window]
    for (const w of windows) {
      if (w !== 'morning' && w !== 'evening') {
        throw new Error(`${at}.window is "${w}" — it must be morning or evening`)
      }
    }

    const who = e.who === undefined ? [] : Array.isArray(e.who) ? e.who : [e.who]
    for (const n of who) {
      if (typeof n !== 'string' || !n.trim()) throw new Error(`${at}.who must be a name, or a list of names`)
    }

    /**
     * What each verb cannot do without. Stated per verb rather than as one
     * general rule, because the omission that matters is different each time: an
     * `absent` with nobody in it is a typo, and a `note` with no words in it is a
     * line somebody meant to finish.
     */
    if ((e.what === 'absent' || e.what === 'present' || e.what === 'away' || e.what === 'lag') && !who.length) {
      throw new Error(`${at} is ${an(e.what)} and needs a who — the name of the person it happens to`)
    }
    if (e.what === 'note' && !String(e.why ?? '').trim()) {
      throw new Error(`${at} is a "note" and needs a why — the words the person gets told`)
    }
    if (e.what === 'note' && !who.length) {
      throw new Error(`${at} is a "note" and needs a who — a note nobody is told is a comment`)
    }
    if (e.hours !== undefined) {
      if (e.what !== 'lag') throw new Error(`${at}.hours belongs to a "lag" and this is a "${e.what}"`)
      if (typeof e.hours !== 'number' || !(e.hours > 0)) {
        throw new Error(`${at}.hours must be a positive number of hours`)
      }
    }
    if (e.class !== undefined && e.what !== 'washout' && e.what !== 'absent' && e.what !== 'present') {
      throw new Error(`${at}.class narrows a washout, an absent or a present — not ${an(e.what)}`)
    }

    return { ...e, day: dayList, window: windows, who } as WorldEvent
  })
}

/* ========================================================================== *
 * THE SEEDED COIN                                                            *
 * ========================================================================== */

/**
 * One number in [0,1) for one decision, from a hash rather than a stream.
 *
 * A stream would make every roll depend on how many rolls came before it, so
 * adding one line to an events file would silently change who was ill on
 * Thursday — and two runs meant to differ by one thing would differ by all of
 * them. This is the property `ab.ts` rests on: it hands both arms one seed, and
 * the arm that changed the doctrine must not also have changed the weather.
 */
function coin(seed: string, parts: (string | number)[]): number {
  let h = 0x811c9dc5
  for (const ch of `${seed}|${parts.join('|')}`) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // Two more rounds of avalanche: the raw FNV low bits are visibly patterned on
  // inputs that differ only in a trailing digit, which is exactly what day
  // numbers and window names are.
  h ^= h >>> 15
  h = Math.imul(h, 0x2545f491) >>> 0
  h ^= h >>> 13
  return (h >>> 0) / 0x100000000
}

/** `"18:30"` as minutes past midnight, for comparing an hour with a window. */
function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m ?? 0)
}

/** Ordinary reasons, so a chaos absence reads like a person and not like a die. */
const ORDINARY = [
  'was ill',
  'had a school thing',
  'was stuck in traffic and turned back',
  'had exams',
  'was away with family',
  'had a doctor appointment',
  'just did not turn up, and nobody said why',
]

/* ========================================================================== *
 * WHAT THE WORLD DID, ONCE IT IS BOUND TO REAL ROWS                          *
 * ========================================================================== */

/** One session, as the world says it went — never as the database says. */
export type SessionTruth = {
  sessionId: string
  className: string
  /** Local label of when it started, for a reader. */
  at: string
  /** Local `HH:MM` it finished — what decides which window can speak about it. */
  endsAt: string
  day: number
  /** Did it physically happen at all. `false` is a washout. */
  ran: boolean
  /** Why it did not, when it did not. */
  why?: string
  /** Who was on the register, and whether they were there. */
  roster: { playerId: string; name: string; there: boolean; why?: string }[]
}

/** One event, after it fired, exactly as a reader needs to see it. */
export type Fired = {
  day: number
  window?: Window
  what: Verb | 'quiet'
  who?: string
  why?: string
  /** `file` for something somebody wrote down, `chaos` for something rolled. */
  from: 'file' | 'chaos'
  /** What it resolved to — the class, the session, the hours. */
  note?: string
}

export type WindowEffects = {
  /** Extra lines for each seat's `today`, keyed by seat key. */
  today: Record<string, string[]>
  /** Seats not at a phone this window: key → why. Their turn is skipped. */
  skip: Map<string, string>
  /** Seats whose phone is behind: key → hours. */
  lag: Map<string, number>
}

type Person = { key: string; name: string; seat: string }

export type EventsRuntime = {
  /** Is there anything here at all. A run with no events pays for nothing. */
  active: boolean
  ref: string
  about: string
  /** Fix the day's physical truth from the rows, before anybody speaks. */
  openDay: (day: number) => Promise<void>
  /** What this window does to the seats. */
  forWindow: (day: number, window: Window) => WindowEffects
  /** Somebody who joined mid-week can still be named by an event. */
  admit: (people: Person[]) => Promise<void>
  /**
   * Somebody who gave up. Nothing is rolled for them again.
   *
   * Called by the driver the moment a seat answers `giveup`, so the very next window
   * stops inventing a life for a person who is no longer in the run.
   */
  depart: (key: string) => void
  /** The world's own account of the week, for `truth.json`. */
  truth: () => {
    ref: string
    about: string
    seed: string
    chaos: Chaos
    sessions: SessionTruth[]
    fired: Fired[]
  }
}

/**
 * Bind an events file to a built world.
 *
 * `q` is the run's own query function — the service-role one with the tenant GUC
 * already set, from `_seat.ts`. Nothing here holds a connection of its own, for
 * the reason every other instrument does not: a second way into this database is
 * a second thing to keep honest about tenancy.
 */
export async function openEvents(o: {
  spec: EventSpec
  ref: string
  days: number
  seed: string
  academyId: string
  people: Person[]
  /**
   * The hour each window sits at, handed in rather than imported.
   *
   * `WINDOW_AT` lives in `_personas.ts` and is the one statement of it; taking it
   * as an argument keeps this file dependent on nothing but its inputs, and keeps
   * the module graph free of a second edge into a file that `_seat.ts` already
   * imports. A second copy of those two hours would be the `TIMETABLE` mistake
   * again: a class revealed in the wrong window reads as the product losing one.
   */
  windowAt: Record<Window, string>
  q: <T = any>(sql: string) => Promise<T[]>
}): Promise<EventsRuntime> {
  const WINDOW_HHMM = o.windowAt
  const events = validateEventSpec(o.spec, o.days)
  const chaos: Chaos = o.spec.chaos ?? {}
  const active = events.length > 0 || Object.values(chaos).some((r) => (r ?? 0) > 0)

  /** name (lowercased) → seat key, for everybody who has a phone in this run. */
  const keyByName = new Map<string, Person>()
  const admit = (people: Person[]) => {
    for (const p of people) keyByName.set(p.name.trim().toLowerCase(), p)
  }
  admit(o.people)

  /**
   * Seat keys of people who have left the run. `keyByName` deliberately keeps them —
   * an event file may still name somebody who walked out on day 5, and dropping them
   * from the map would turn a written line into an "unknown name" error at validation
   * time, days after the fact.
   */
  const departed = new Set<string>()

  const sessions: SessionTruth[] = []
  const fired: Fired[] = []
  /** Sessions already folded into somebody's `today`, so nobody is told twice. */
  const told = new Set<string>()
  const opened = new Set<number>()

  const days = (e: WorldEvent): number[] => e.day as unknown as number[]
  const windows = (e: WorldEvent): Window[] => (e.window as unknown as Window[]) ?? ['morning', 'evening']
  const whos = (e: WorldEvent): string[] => (e.who as unknown as string[]) ?? []

  /* ------------------------------------------------------- names are checked */

  /**
   * Every name in the file, against the people this world actually has.
   *
   * Players are not seats — a child has no phone — so both sets are searched, and
   * the error prints what IS there. A misspelt name is the commonest thing wrong
   * with a hand-written scenario and the hardest to see afterwards, because the
   * week runs perfectly and the event simply never happens.
   */
  const players = await o.q<{ id: string; name: string }>(
    `select p.id, pp.full_name as name from player p join person pp on pp.id = p.person_id where p.active`,
  )
  const playerByName = new Map(players.map((p) => [p.name.trim().toLowerCase(), p]))

  const named = [...new Set(events.flatMap((e) => whos(e)))]
  const missing = named.filter(
    (n) => !keyByName.has(n.trim().toLowerCase()) && !playerByName.has(n.trim().toLowerCase()),
  )
  if (missing.length) {
    throw new Error(
      `${o.ref} names ${missing.map((m) => `"${m}"`).join(', ')}, and this world has nobody by ` +
        `${missing.length === 1 ? 'that name' : 'those names'}.\n` +
        `   people with a phone: ${[...keyByName.values()].map((p) => p.name).join(', ') || '(none)'}\n` +
        `   players on a register: ${players.map((p) => p.name).join(', ') || '(none)'}\n` +
        `   A name nothing matches is an event that never fires, in a week that reads as though it did.`,
    )
  }

  const classNames = [...new Set(events.map((e) => e.class).filter((c): c is string => !!c))]
  if (classNames.length) {
    const have = await o.q<{ name: string }>(`select name from class where active`)
    const set = new Set(have.map((c) => c.name.trim().toLowerCase()))
    const bad = classNames.filter((c) => !set.has(c.trim().toLowerCase()))
    if (bad.length) {
      throw new Error(
        `${o.ref} names the class${bad.length === 1 ? '' : 'es'} ${bad.map((b) => `"${b}"`).join(', ')}, ` +
          `and this world has: ${have.map((c) => c.name).join(', ') || '(none)'}`,
      )
    }
  }

  /* --------------------------------------------------------- the day's truth */

  /**
   * What physically happened today, decided once, before anybody speaks.
   *
   * Decided at the top of the day rather than at each window because the day is
   * when it happened: a coach cannot be told at 08:30 that a player will be
   * absent from a class that has not run yet, and the same fact has to reach
   * their parent at whatever hour their window falls. Revealing it is a separate
   * question from deciding it, and `forWindow` below only reveals sessions that
   * have already ended.
   */
  const openDay = async (day: number): Promise<void> => {
    if (opened.has(day)) return
    opened.add(day)

    /**
     * The day's sessions and their registers, read off `app.session_roster` — the
     * one place this repo defines "on the register", so the world and the product
     * cannot disagree about who was supposed to be there.
     *
     * "Today" is the tenant's own simulated date and never the wall clock:
     * `app.now()` resolves this academy's `sim_clock` row first (0024), and the
     * date is taken in the academy's own timezone. A run reading the wall clock
     * would open an empty day on every drive whose clock has been walked, which
     * is every drive.
     *
     * A cancelled session is excluded. The product cancelling a class is the
     * product working, and a world that then reported who was absent from it
     * would be inventing a register for a class nobody held.
     */
    const rows = await o.q<{
      session_id: string
      class_name: string
      at_label: string
      ends_hhmm: string
      player_id: string | null
      player_name: string | null
    }>(
      `with tz as (select coalesce((select timezone from academy where id = '${o.academyId}'::uuid), 'Asia/Kolkata') as timezone)
       select r.session_id, r.class_name,
              to_char(r.starts_at at time zone (select timezone from tz), 'HH24:MI') as at_label,
              to_char(s.ends_at   at time zone (select timezone from tz), 'HH24:MI') as ends_hhmm,
              r.player_id, r.player_name
         from app.session_roster r
         join session s on s.id = r.session_id
        where s.status <> 'cancelled'
          and (r.starts_at at time zone (select timezone from tz))::date
              = (app.now() at time zone (select timezone from tz))::date
        order by r.starts_at asc, r.player_name asc`,
    )

    const bySession = new Map<string, SessionTruth>()
    for (const r of rows) {
      let t = bySession.get(r.session_id)
      if (!t) {
        t = {
          sessionId: r.session_id,
          className: r.class_name,
          at: r.at_label,
          endsAt: r.ends_hhmm,
          day,
          ran: true,
          roster: [],
        }
        bySession.set(r.session_id, t)
      }
      if (r.player_id && r.player_name) {
        t.roster.push({ playerId: r.player_id, name: r.player_name, there: true })
      }
    }

    const todays = [...bySession.values()]

    /* ------------------------------------------------------------- washouts */

    const matchesClass = (t: SessionTruth, e: WorldEvent): boolean =>
      !e.class || t.className.trim().toLowerCase() === e.class.trim().toLowerCase()

    for (const e of events) {
      if (e.what !== 'washout' || !days(e).includes(day)) continue
      const hit = todays.filter((t) => matchesClass(t, e))
      for (const t of hit) {
        t.ran = false
        t.why = e.why ?? 'it did not happen'
        for (const p of t.roster) {
          p.there = false
          p.why = t.why
        }
      }
      fired.push({
        day,
        what: 'washout',
        why: e.why,
        from: 'file',
        note:
          hit.length ? hit.map((t) => `${t.className} ${t.at}`).join(', ')
          : e.class ? `no ${e.class} today — nothing to wash out`
          : 'no classes today — nothing to wash out',
      })
    }

    if ((chaos.washout ?? 0) > 0 && todays.some((t) => t.ran)) {
      if (coin(o.seed, ['washout', day]) < chaos.washout!) {
        const why = 'heavy rain — the courts were unplayable'
        for (const t of todays) {
          t.ran = false
          t.why = why
          for (const p of t.roster) {
            p.there = false
            p.why = why
          }
        }
        fired.push({
          day,
          what: 'washout',
          why,
          from: 'chaos',
          note: todays.map((t) => `${t.className} ${t.at}`).join(', '),
        })
      }
    }

    /* ------------------------------------------------------------- absences */

    for (const e of events) {
      if ((e.what !== 'absent' && e.what !== 'present') || !days(e).includes(day)) continue
      const there = e.what === 'present'
      for (const name of whos(e)) {
        const want = name.trim().toLowerCase()
        const hit = todays.flatMap((t) =>
          matchesClass(t, e) ? t.roster.filter((p) => p.name.trim().toLowerCase() === want).map((p) => ({ t, p })) : [],
        )
        /**
         * A named absence that lands on nothing is refused, not shrugged at.
         *
         * This is the single likeliest mistake in a hand-written scenario: a
         * child marked absent on a day their class does not run. The week then
         * looks exactly like a week in which they attended, and the reader has no
         * way to know the event was written for the wrong day. The error carries
         * the days that WOULD have worked, because that is the fix.
         */
        if (!hit.length) {
          const has = todays.filter((t) => t.roster.some((p) => p.name.trim().toLowerCase() === want))
          throw new Error(
            `${o.ref}: "${name}" has no session on day ${day}${e.class ? ` in ${e.class}` : ''}, ` +
              `so this ${e.what} would never happen.\n` +
              `   on day ${day} this academy runs: ${todays.map((t) => `${t.className} ${t.at}`).join(', ') || '(nothing)'}\n` +
              (has.length ? `   "${name}" is on: ${has.map((t) => t.className).join(', ')}\n` : '') +
              `   Move the event to a day their class runs.`,
          )
        }
        for (const { t, p } of hit) {
          p.there = there
          p.why = there ? undefined : (e.why ?? 'did not turn up')
          fired.push({
            day,
            what: e.what,
            who: name,
            why: e.why,
            from: 'file',
            note: `${t.className} ${t.at}`,
          })
        }
      }
    }

    if ((chaos.absent ?? 0) > 0) {
      for (const t of todays) {
        if (!t.ran) continue
        for (const p of t.roster) {
          // Never overturn something somebody wrote down. A file beats a die.
          if (!p.there) continue
          const pinned = events.some(
            (e) =>
              e.what === 'present' &&
              days(e).includes(day) &&
              whos(e).some((n) => n.trim().toLowerCase() === p.name.trim().toLowerCase()),
          )
          if (pinned) continue
          if (coin(o.seed, ['absent', day, t.sessionId, p.playerId]) >= chaos.absent!) continue
          const why = ORDINARY[Math.floor(coin(o.seed, ['why', t.sessionId, p.playerId]) * ORDINARY.length)]!
          p.there = false
          p.why = why
          fired.push({ day, what: 'absent', who: p.name, why, from: 'chaos', note: `${t.className} ${t.at}` })
        }
      }
    }

    sessions.push(...todays)
  }

  /* ------------------------------------------------------- revealing it */

  /**
   * Which sessions this person can speak about, from their own angle.
   *
   * A coach knows their own register. A parent knows about their own child. The
   * owner knows what they were physically at, and no more — which is why the
   * owner is treated as a coach only for sessions they actually coach. Nobody is
   * handed the whole day: a week in which everybody knows everything is a week in
   * which nothing has to be communicated, and communication is the product.
   */
  const coachedBy = new Map<string, Set<string>>()
  const parentOf = new Map<string, Set<string>>()

  const learnRelations = async (): Promise<void> => {
    const rows = await o.q<{ session_id: string; who: string }>(
      `select sc.session_id, pp.full_name as who
         from session_coach sc join coach c on c.id = sc.coach_id join person pp on pp.id = c.person_id`,
    )
    for (const r of rows) {
      const k = keyByName.get(r.who.trim().toLowerCase())?.key
      if (!k) continue
      if (!coachedBy.has(k)) coachedBy.set(k, new Set())
      coachedBy.get(k)!.add(r.session_id)
    }
    /**
     * Who is answerable for each player — `account.holder_person_id`, which is
     * the column the schema actually has.
     *
     * A self-paying adult holds their own account, so the player and the holder
     * are one `person` and the line comes back to them about themselves. That is
     * correct rather than a special case: an adult beginner who did not turn up
     * knows it, and there is nobody else to tell.
     */
    const kids = await o.q<{ player: string; guardian: string }>(
      `select pl.full_name as player, gp.full_name as guardian
         from player p
         join person pl on pl.id = p.person_id
         join account a on a.id = p.account_id
         join person gp on gp.id = a.holder_person_id`,
    )
    for (const r of kids) {
      const k = keyByName.get(r.guardian.trim().toLowerCase())?.key
      if (!k) continue
      if (!parentOf.has(k)) parentOf.set(k, new Set())
      parentOf.get(k)!.add(r.player.trim().toLowerCase())
    }
  }
  await learnRelations()

  /**
   * What a coach is told about a session that has just finished.
   *
   * Deliberately written as what they SAW, with no hint of what to do about it.
   * "Everyone was there except Anika, who did not turn up" — never "mark Anika
   * absent", and never "the register is waiting". A seat told what the product
   * wants from it is not measuring whether the product asked clearly.
   */
  const coachLine = (t: SessionTruth, when: string): string => {
    if (!t.ran) {
      return `The ${t.className} at ${t.at} ${when} did not happen — ${t.why ?? 'it was called off'}. Nobody was on court.`
    }
    const missed = t.roster.filter((p) => !p.there)
    if (!t.roster.length) return `You took the ${t.className} at ${t.at} ${when}. Nobody is on the register for it.`
    if (!missed.length) {
      return `You took the ${t.className} at ${t.at} ${when}. Everybody who should have been there was there.`
    }
    // Everybody absent is its own sentence: "Everybody was there except <the whole
    // roster>" briefed a coach with a contradiction about a session nobody came to (F-EJ).
    if (missed.length === t.roster.length) {
      const list = missed.map((p) => `${p.name} (${p.why ?? 'no reason given'})`).join(', ')
      return (
        `You took the ${t.className} at ${t.at} ${when} and nobody came — ${list}. ` +
        `You have not written any of that down anywhere.`
      )
    }
    const list = missed.map((p) => `${p.name} (${p.why ?? 'no reason given'})`).join(', ')
    return (
      `You took the ${t.className} at ${t.at} ${when}. Everybody was there except ${list}. ` +
      `You have not written any of that down anywhere.`
    )
  }

  /** What a parent knows: their own child, and only theirs. */
  const parentLine = (t: SessionTruth, mine: string[], when: string): string[] => {
    const L: string[] = []
    for (const name of mine) {
      const p = t.roster.find((r) => r.name.trim().toLowerCase() === name)
      if (!p) continue
      if (!t.ran) {
        L.push(
          `${p.name} turned up for the ${t.className} at ${t.at} ${when} and it was not on — ` +
            `${t.why ?? 'it was called off'}.`,
        )
      } else if (!p.there) {
        L.push(
          `${p.name} did not go to the ${t.className} at ${t.at} ${when} — ${p.why ?? 'no reason'}. ` +
            `You have told nobody.`,
        )
      }
    }
    return L
  }

  const forWindow = (day: number, window: Window): WindowEffects => {
    const today: Record<string, string[]> = {}
    const skip = new Map<string, string>()
    const lag = new Map<string, number>()
    const add = (key: string, line: string): void => {
      ;(today[key] ??= []).push(line)
    }

    /* --------------------------------------------------- who is even here */

    /**
     * Resolved BEFORE the sessions, and the order is load-bearing.
     *
     * A session is revealed to a person once and then marked told. If that
     * happened before this block, a coach who was away — or who lost a chaos
     * `quiet` roll — in the one window their class was revealed would never learn
     * their own register, for the whole week, silently. It is the exact defect
     * this file exists to remove, reintroduced by the mechanism removing it, and
     * it would have shown up in a record as a coach who was asked and did not
     * answer.
     *
     * So: who is at a phone is decided first, and `told` below is keyed by
     * (session, person) rather than by session, so somebody's Thursday register
     * waits for them until Friday morning.
     */
    for (const e of events) {
      if (!days(e).includes(day) || !windows(e).includes(window)) continue

      if (e.what === 'away') {
        for (const name of whos(e)) {
          const p = keyByName.get(name.trim().toLowerCase())
          if (!p) continue
          skip.set(p.key, e.why ?? 'away')
          fired.push({ day, window, what: 'away', who: name, why: e.why, from: 'file' })
        }
      }

      if (e.what === 'lag') {
        for (const name of whos(e)) {
          const p = keyByName.get(name.trim().toLowerCase())
          if (!p) continue
          const hours = e.hours ?? 12
          lag.set(p.key, hours)
          fired.push({ day, window, what: 'lag', who: name, why: e.why, from: 'file', note: `${hours}h behind` })
        }
      }
    }

    /**
     * @mechanism departed — chaos is not rolled for somebody who has left the run,
     *   retiring the class of defect where the record of a week describes people who
     *   were not in it. `giveup` is a first-class seat action and a persona who takes it
     *   is never seated again; nothing here knew that, so the roll kept going. On the
     *   30-day run of 22 Aug 2026 divya-rao and farah-sheikh both gave up on day 5, were
     *   correctly never driven after it, and between them account for 17 of the 45 chaos
     *   events `truth.json` records — dated days 10 to 30, every one of them a fact
     *   about nobody. A reader counting "how messy was this week" counted a third again
     *   more weather than the week actually had.
     *
     *   Skipped BEFORE the roll rather than filtered after it, which is the shape that
     *   would matter if `coin` were a stream. It is not — it is a pure hash of
     *   (seed, verb, day, window, seat key), so a roll not taken is not a roll stolen
     *   from anybody else, and that is exactly what makes this safe to add to a seeded
     *   run: everybody still present rolls precisely what they rolled before, and two
     *   `--seed`-matched arms that diverge on WHEN somebody gives up no longer diverge on
     *   the weather of everyone who stayed.
     */
    for (const p of keyByName.values()) {
      if (departed.has(p.key)) continue
      if ((chaos.quiet ?? 0) > 0 && !skip.has(p.key)) {
        if (coin(o.seed, ['quiet', day, window, p.key]) < chaos.quiet!) {
          skip.set(p.key, 'did not pick the phone up')
          fired.push({ day, window, what: 'quiet', who: p.name, from: 'chaos' })
        }
      }
      if ((chaos.lag ?? 0) > 0 && !lag.has(p.key) && !skip.has(p.key)) {
        if (coin(o.seed, ['lag', day, window, p.key]) < chaos.lag!) {
          const hours = 4 + Math.floor(coin(o.seed, ['lagh', day, window, p.key]) * 12)
          lag.set(p.key, hours)
          fired.push({ day, window, what: 'lag', who: p.name, from: 'chaos', note: `${hours}h behind` })
        }
      }
    }

    /* ------------------------------------------- sessions, once per person */

    for (const t of sessions) {
      if (t.day > day) continue
      /**
       * A session is revealed once it has FINISHED, in the first window that
       * comes after it — which is not always a window on its own day.
       *
       * `WINDOW_AT` puts the morning window at 08:30 and the evening one at
       * 20:15, so the seven o'clock juniors reach their coach that morning and
       * the six o'clock batch reaches its coach that evening: the same hour a
       * real coach would be looking, and the same hour `post_class_register` put
       * the question on their phone.
       *
       * The `t.day < day` half is load-bearing and was missing at first. Ace
       * Tennis runs Adult Beginners 19:30–20:30 — it ends AFTER the evening
       * window — so a same-day-only rule left its coach the one person in the
       * week never told what happened in their own class, silently, on the class
       * least likely to be looked at. A class that finishes after the last window
       * of its day reaches its coach the next morning, which is when they would
       * really have picked the phone up.
       *
       * Revealing one before it ended would be the opposite error: telling
       * somebody who was absent from a class still in progress, which is the
       * artefact `sim.ts` walks the clock once per window to avoid.
       */
      if (t.day === day && minutes(t.endsAt) > minutes(WINDOW_HHMM[window])) continue

      /**
       * How long ago it was, in the words a person would use.
       *
       * A seat handed a present-tense fact about Wednesday will put it to the
       * product in the present tense, and the product answering about the wrong
       * day then reads as the product losing one. Never `day 3`: a day NUMBER is
       * a fact about the harness, and nobody in the world can see it — a persona
       * who says "on day 3" has been told it is in a simulation.
       */
      const ago = day - t.day
      const when =
        ago === 0 ? 'today'
        : ago === 1 ? (minutes(t.endsAt) >= 14 * 60 ? 'last night' : 'yesterday')
        : ago === 2 ? 'the day before yesterday'
        : `${ago} days ago`
      /**
       * Once per person, and never to somebody who is not at their phone.
       *
       * Takes every line for this person at once rather than one at a time: a
       * parent with two children in the same class has two lines about one
       * session, and a per-line "told" mark would deliver the first and swallow
       * the second — the sibling case this repo already has a family for.
       */
      const give = (key: string, lines: string[]): void => {
        if (!lines.length || skip.has(key) || told.has(`${t.sessionId}:${key}`)) return
        told.add(`${t.sessionId}:${key}`)
        for (const l of lines) add(key, l)
      }

      for (const [key, ids] of coachedBy) if (ids.has(t.sessionId)) give(key, [coachLine(t, when)])
      for (const [key, mine] of parentOf) give(key, parentLine(t, [...mine], when))
    }

    /* ------------------------------------------------------- what was written */

    for (const e of events) {
      if (e.what !== 'note' || !days(e).includes(day) || !windows(e).includes(window)) continue
      for (const name of whos(e)) {
        const p = keyByName.get(name.trim().toLowerCase())
        if (!p) continue
        add(p.key, e.why!)
        fired.push({ day, window, what: 'note', who: name, why: e.why, from: 'file' })
      }
    }

    return { today, skip, lag }
  }

  return {
    active,
    ref: o.ref,
    about: o.spec.about ?? '',
    openDay,
    forWindow,
    depart: (key) => {
      departed.add(key)
    },
    admit: async (people) => {
      admit(people)
      // Somebody who arrived this week can be a coach or a parent too, and the
      // relations were read once at start-up. Re-reading them costs two queries
      // and happens only in a window that gained somebody; a stale map would
      // silently drop every session belonging to a coach hired on Wednesday, and
      // their register would then be the one thing in the week nobody was told
      // about — which is the defect this whole file exists to remove.
      await learnRelations()
    },
    truth: () => ({
      ref: o.ref,
      about: o.spec.about ?? '',
      seed: o.seed,
      chaos,
      sessions,
      fired,
    }),
  }
}

/**
 * _world-file — one file, one whole simulation.
 *
 *   const world = await loadWorld('ace-tennis')       // worlds/ace-tennis.json
 *   const built = await buildWorld(world, { token, log })
 *   const brief = briefFor(world.people[0]!, world, cfg.days)
 *
 * WHAT REPLACED WHAT, AND WHY
 * -----------------------------------------------------------------------------
 * `_world-spec.ts` described **what the database looks like the moment onboarding
 * finished** — classes, coaches, clients, children, enrolments, a prior period of
 * arrears — and built all of it in SQL before anybody spoke. Seven hundred and
 * ninety lines of code to skip the one conversation this product is sold on.
 *
 * It also forced a second mechanism to exist. Because the rows were written by
 * the harness, a brief had to be DERIVED from them or it would describe a
 * business that was not there — a coach told his batch ran Monday and Thursday in
 * a world that ran Monday and Wednesday writes a turn that reads as a product
 * defect and is a harness one. So `_personas.ts` grew a composer that read the
 * spec back out, and a `normalised()` refusal to catch a spec that had not been
 * through the validator, and every world file had to be kept true as the schema
 * moved.
 *
 * All of that existed to serve fixtures. Delete the fixtures and it goes with
 * them: **a brief cannot contradict the database when there is no database yet.**
 * Nothing here derives anything, and nothing here can drift.
 *
 * WHAT A WORLD IS NOW
 * -----------------------------------------------------------------------------
 * A sender, a front desk, and some people holding phones. That is the whole
 * build. No academy, no classes, nobody enrolled in anything — because the
 * business is TALKED into existence by the people in it, which is the thing worth
 * measuring and the thing the fixtures were skipping.
 *
 * That is not a simplification the product had to be bent for. 0039 already says
 * a stranger belongs to the NUMBER before they belong to a business: a front desk
 * is one `academy` row per sender, it owns no class, no player, no money and no
 * roster, and `onboarding_state` stays at `setup` so it can never initiate. A
 * person messaging it is routed — `joined` into a business that exists, or
 * `founded` into one that does not. The harness is now just: put people at that
 * number and let it happen.
 *
 * ONE SENDER PER RUN, WHICH IS WHAT MAKES TWO RUNS SAFE
 * -----------------------------------------------------------------------------
 * `app.front_desk_for` is one row per `(sender_id) where kind = 'front_desk'` — ONE
 * front desk per number. `lib/seed.ts` has always used a single shared `SENDER_ID`
 * ("exactly as production has one number"), so two drives sharing it would share
 * a front desk, and each would see the other's visitors, the other's businesses in
 * `businessesOnThisNumber`, and the other's arrivals in the funnel.
 *
 * So a run makes its own `sender` row, and gets its own front desk for free. It
 * is the same isolation the run token already buys everywhere else — a run
 * directory, an academy name, a `sim_clock` row — extended to the one table that
 * did not have it. Nothing is shared between two runs but the database.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { DateTime as LuxonDateTime } from 'luxon'

import type { EventSpec } from './_events'
import { c } from './_env'
import { INPUT_REALISM, type SeatRole, type Window } from './_personas'

/* ========================================================================== *
 * THE FORMAT                                                                 *
 * ========================================================================== */

export const SEAT_ROLES: SeatRole[] = ['admin', 'coach', 'client', 'prospect']

/**
 * One person, entirely as somebody wrote them.
 *
 * Every field is prose except `seat`, and `seat` is DECLARED rather than derived
 * because there is nothing to derive it from at the moment the run opens: nobody
 * is an admin of anything yet. It is what this person is going to turn out to be,
 * and it is here because it is the axis every score in this repo is split by —
 * averaging a stranger's week with the owner's is how a bad month reads as a good
 * one.
 */
export type WorldPerson = {
  name: string
  seat: SeatRole
  /** One line, for a listing. Derived from the role when absent. */
  oneLine?: string
  /** Who they are, in their own frame. The main thing you write. */
  about?: string
  /** What they want to be true by the end. Judged against. */
  goals?: string[]
  /** How they type. Replaces the role default. */
  voice?: string
  /** The specific mess they make, on top of `INPUT_REALISM`. */
  typing?: string
  /** What would make them complain, escalate or leave. */
  redLines?: string[]
  /** What happens TO them, by day. Never what they say about it. */
  life?: Record<number, string>
  /**
   * Whether this person is AT the number when the run opens.
   *
   * Production does not open with a cast: one person texts a number, and
   * everybody else exists because the business reached them. So a world's
   * people[] is a CAST, not a seating plan — the withheld ones are the founder's
   * circle, seeded into the contact book as real names with real numbers, and
   * seated by `_arrivals.ts` with THIS spec as their brief the moment the
   * product actually reaches their phone. That is also what dissolved the
   * fifth-Kiran class: an invented number used to collide with a pre-seated
   * person at a different one, and there is nobody pre-seated to collide with.
   *
   * The rule is activated by presence of the field: if ANY person sets
   * `present` or `arrives`, the field is authoritative for all (unset =
   * withheld). If nobody sets either, everyone is present — which keeps `blank`
   * and every legacy file byte-identical in behaviour.
   */
  present?: boolean
  /**
   * The day this person walks in off the street — seated as a front-desk
   * contact at the top of that day, exactly like a stranger texting the number
   * in production. Mutually exclusive with `present: true`; implies withheld
   * until the day comes.
   */
  arrives?: number
  /**
   * How this person is at a machine — the dial `_personas.ts` reads.
   * `skepticism` picks the posture level; `messiness` is the garble rate (0..1);
   * `presence` overrides the role's phone-checking habit (0..1). All optional;
   * unset values are drawn per person from a stable hash, so a person's
   * temperament survives reseeding.
   */
  style?: { skepticism?: 'trusting' | 'ordinary' | 'hard'; messiness?: number; presence?: number }
}

export type World = {
  /** What this scenario is called. Names the run and the sender, nothing else. */
  name: string
  timezone: string
  people: WorldPerson[]
  /** What happens to the business during the week — `_events.ts` owns the shape. */
  week?: EventSpec
}

/* ========================================================================== *
 * READING ONE                                                                *
 * ========================================================================== */

const TOP_KEYS = ['name', 'timezone', 'people', 'week']
const PERSON_KEYS = [
  'name', 'seat', 'oneLine', 'about', 'goals', 'voice', 'typing', 'redLines', 'life',
  'present', 'arrives', 'style',
]
const SKEPTICISM_LEVELS = ['trusting', 'ordinary', 'hard'] as const

/**
 * The blank world: one person, at a number, belonging to nothing.
 *
 * A word rather than `worlds/blank.json` for the same reason it always was — a
 * missing file must not be able to break the default. It is deliberately almost
 * empty: somebody who has decided to start a coaching business, a phone, and no
 * instructions about what the product can do for them. What the business turns
 * out to be is theirs to invent, and whether the product can get it out of them
 * is the measurement.
 */
export const BLANK: World = {
  name: 'Blank',
  timezone: 'Asia/Kolkata',
  people: [
    {
      name: 'Rahul Menon',
      seat: 'prospect',
      oneLine: 'wants to run his coaching classes properly and has just been given this number',
      about: `You coach tennis. You have been running it out of your head and a notebook
for two years — you know who owes you roughly, you know who turns up, and twice this
year you have double-booked a court. Somebody told you this number would sort it out.
You have no idea what it is or what it can do. You are not a software person and you
have no patience for being taught one.

You have not told it anything yet.`,
      goals: [
        'Get whatever this is set up, without a long conversation about it.',
        'Have your classes, your timings and your fees written down somewhere that is not your head.',
        'Find out whether it can chase people for money, because that is the part you hate.',
      ],
      redLines: [
        'Being asked a lot of questions in a row before it has done anything useful.',
        'Being told something was done when it was not.',
        'Anything that reads like it came out of a log file.',
      ],
      life: {},
    },
  ],
}

/** A name, a path, or inline JSON — the same three every reference here takes. */
export function loadWorld(ref: string): { world: World; ref: string } {
  const raw = (ref ?? '').trim()
  if (!raw || raw.toLowerCase() === 'blank') return { world: validateWorld(BLANK, 'blank'), ref: 'blank' }

  if (raw.startsWith('{')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error(`--world was given inline JSON that will not parse: ${(e as Error).message}`)
    }
    return { world: validateWorld(parsed, 'the inline world'), ref: 'inline' }
  }

  const tries = [raw, `${raw}.json`, join('worlds', raw), join('worlds', `${raw}.json`)]
  for (const p of tries) {
    let text: string
    try {
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    const at = p.replace(/\\/g, '/')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (e) {
      throw new Error(`${at} will not parse: ${(e as Error).message}`)
    }
    return { world: validateWorld(parsed, at), ref: at }
  }
  throw new Error(
    `no world called "${raw}" — tried ${tries.map((t) => t.replace(/\\/g, '/')).join(', ')}\n` +
      `   "blank" is the default: one person, at a number, belonging to nothing.`,
  )
}

/**
 * Every rule about a world file, refusing rather than ignoring.
 *
 * There is far less to check than there was, because there is far less to get
 * wrong: no counts to expand, no enrolments to resolve, no coach to deal
 * round-robin, no class a child can be put in twice. What is left is the shape,
 * and two things that would produce a silent run — a world with nobody in it, and
 * two people sharing a name.
 *
 * The name check matters more than it looks. A seat key is derived from the name,
 * `_events.ts` binds `who` by name, and `_arrivals.ts` matches a person the
 * product created against the people already seated by name. Two Rahuls collapse
 * into one seat, and the second one's whole week goes to the first one's phone.
 */
export function validateWorld(input: unknown, where = 'this world'): World {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`${where} is not a world: the top level must be a JSON object.`)
  }
  const w = input as Record<string, unknown>
  for (const k of Object.keys(w)) {
    if (!TOP_KEYS.includes(k)) {
      throw new Error(`${where} has an unknown key "${k}" — known keys: ${TOP_KEYS.join(', ')}`)
    }
  }

  const name = typeof w.name === 'string' && w.name.trim() ? w.name.trim() : 'Sim'
  const timezone =
    typeof w.timezone === 'string' && w.timezone.trim() ? w.timezone.trim() : 'Asia/Kolkata'

  if (w.people !== undefined && !Array.isArray(w.people)) {
    throw new Error(`${where}.people must be a list of people`)
  }
  const rawPeople = (w.people as unknown[]) ?? []
  if (!rawPeople.length) {
    throw new Error(
      `${where} has nobody in it. A world with no people advances the clock, fires nothing ` +
        `(a front desk cannot initiate) and records no turns at all.`,
    )
  }

  const people: WorldPerson[] = rawPeople.map((p, i) => {
    const at = `${where}.people[${i}]`
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`${at} must be an object`)
    const o = p as Record<string, unknown>
    for (const k of Object.keys(o)) {
      if (!PERSON_KEYS.includes(k)) {
        throw new Error(`${at} has an unknown key "${k}" — known keys: ${PERSON_KEYS.join(', ')}`)
      }
    }
    const pname = typeof o.name === 'string' ? o.name.trim() : ''
    if (!pname) throw new Error(`${at} has no name`)
    const seat = typeof o.seat === 'string' ? (o.seat.trim().toLowerCase() as SeatRole) : ('prospect' as SeatRole)
    if (!SEAT_ROLES.includes(seat)) {
      throw new Error(`${at}.seat is "${o.seat}" — it must be one of ${SEAT_ROLES.join(', ')}`)
    }
    for (const k of ['oneLine', 'about', 'voice', 'typing'] as const) {
      if (o[k] !== undefined && (typeof o[k] !== 'string' || !String(o[k]).trim())) {
        throw new Error(`${at}.${k} is not text: ${JSON.stringify(o[k])}`)
      }
    }
    for (const k of ['goals', 'redLines'] as const) {
      if (o[k] === undefined) continue
      if (!Array.isArray(o[k])) throw new Error(`${at}.${k} must be a list of sentences`)
      for (const [j, line] of (o[k] as unknown[]).entries()) {
        if (typeof line !== 'string' || !line.trim()) {
          throw new Error(`${at}.${k}[${j}] is not a sentence: ${JSON.stringify(line)}`)
        }
      }
    }
    const life: Record<number, string> = {}
    if (o.life !== undefined) {
      if (typeof o.life !== 'object' || o.life === null || Array.isArray(o.life)) {
        throw new Error(`${at}.life must be an object keyed by day number, e.g. { "3": "..." }`)
      }
      for (const [k, v] of Object.entries(o.life as Record<string, unknown>)) {
        const d = Number(k)
        if (!Number.isInteger(d) || d < 1) throw new Error(`${at}.life has a key "${k}" that is not a day number`)
        if (typeof v !== 'string' || !v.trim()) throw new Error(`${at}.life[${k}] is not text`)
        life[d] = v.trim()
      }
    }
    if (o.present !== undefined && typeof o.present !== 'boolean') {
      throw new Error(`${at}.present must be true or false, not ${JSON.stringify(o.present)}`)
    }
    if (o.arrives !== undefined) {
      const d = Number(o.arrives)
      if (!Number.isInteger(d) || d < 1) throw new Error(`${at}.arrives must be a day number, not ${JSON.stringify(o.arrives)}`)
      if (o.present === true) {
        throw new Error(`${at} has both present: true and arrives: ${d} — somebody already at the number cannot also walk in later`)
      }
    }
    let style: WorldPerson['style']
    if (o.style !== undefined) {
      if (typeof o.style !== 'object' || o.style === null || Array.isArray(o.style)) {
        throw new Error(`${at}.style must be an object`)
      }
      const s = o.style as Record<string, unknown>
      for (const k of Object.keys(s)) {
        if (!['skepticism', 'messiness', 'presence'].includes(k)) {
          throw new Error(`${at}.style has an unknown key "${k}" — known keys: skepticism, messiness, presence`)
        }
      }
      if (s.skepticism !== undefined && !SKEPTICISM_LEVELS.includes(s.skepticism as (typeof SKEPTICISM_LEVELS)[number])) {
        throw new Error(`${at}.style.skepticism is ${JSON.stringify(s.skepticism)} — it must be one of ${SKEPTICISM_LEVELS.join(', ')}`)
      }
      for (const k of ['messiness', 'presence'] as const) {
        if (s[k] === undefined) continue
        const n = Number(s[k])
        if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`${at}.style.${k} must be between 0 and 1, not ${JSON.stringify(s[k])}`)
      }
      style = s as WorldPerson['style']
    }
    return {
      name: pname,
      seat,
      ...(o.oneLine ? { oneLine: String(o.oneLine).trim() } : {}),
      ...(o.about ? { about: String(o.about).trim() } : {}),
      ...(o.goals ? { goals: (o.goals as string[]).map((s) => s.trim()) } : {}),
      ...(o.voice ? { voice: String(o.voice).trim() } : {}),
      ...(o.typing ? { typing: String(o.typing).trim() } : {}),
      ...(o.redLines ? { redLines: (o.redLines as string[]).map((s) => s.trim()) } : {}),
      life,
      ...(o.present !== undefined ? { present: o.present as boolean } : {}),
      ...(o.arrives !== undefined ? { arrives: Number(o.arrives) } : {}),
      ...(style !== undefined ? { style } : {}),
    }
  })

  /**
   * The activation rule, normalised so nothing downstream re-derives it: if any
   * person declares `present` or `arrives`, the declaration is authoritative for
   * everyone — unset means withheld. If nobody declares either, everyone is
   * present, which is byte-identical to how every legacy world always behaved.
   */
  const declared = people.some((p) => p.present !== undefined || p.arrives !== undefined)
  for (const p of people) {
    p.present = declared ? p.present === true : true
  }
  if (!people.some((p) => p.present)) {
    throw new Error(
      `${where} has nobody present when the run opens. A world of withheld people is a week ` +
        `in which nothing can happen — mark at least one person present: true, or give somebody arrives.`,
    )
  }

  const seen = new Map<string, number>()
  for (const [i, p] of people.entries()) {
    const key = p.name.toLowerCase()
    if (seen.has(key)) {
      throw new Error(
        `${where} has two people called "${p.name}" (people[${seen.get(key)}] and people[${i}]).\n` +
          `   A seat key, an event's \`who\` and an arrival match are all by name, so the second ` +
          `one's whole week would go to the first one's phone.`,
      )
    }
    seen.set(key, i)
  }

  return { name, timezone, people, ...(w.week !== undefined ? { week: w.week as EventSpec } : {}) }
}

/** `Rahul Menon` → `rahul-menon`. Stable, and what `--personas` takes. */
export const keyOf = (name: string): string =>
  name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** One line for the top of a run and for the record. */
export function describeWorld(w: World): string {
  const by: Record<string, number> = {}
  for (const p of w.people) by[p.seat] = (by[p.seat] ?? 0) + 1
  const who = SEAT_ROLES.filter((r) => by[r]).map((r) => `${by[r]} ${r}${by[r]! > 1 ? 's' : ''}`)
  return `${w.name} (${w.timezone}) — ${who.join(', ')}, at a number and in no business yet.`
}

/* ========================================================================== *
 * DEALING A WEEK                                                             *
 * ========================================================================== */

/**
 * How thickly a week fills its windows: seat turns per window.
 *
 * `24 / 14` — a shade under two people at a phone at once, which is what a
 * Tuesday evening at a real academy looks like and the only density anybody here
 * has driven and read back. It was computed off a hand-written table of four
 * named humans; the table is gone, so the constant it always produced is written
 * down instead.
 */
export const DENSITY = 24 / 14

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
export function deriveSchedule(
  seats: string[],
  days: number,
  windows: Window[],
): Record<number, Record<Window, string[]>> {
  if (!seats.length) throw new Error('a world with nobody in it cannot be driven')
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
        throw new Error(`derived schedule puts ${who} at a phone twice in window ${i + 1} of ${cells}`)
      }
      seen.add(who)
      counts.set(who, (counts.get(who) ?? 0) + 1)
    }
  })
  const spread = [...counts.values()]
  if (Math.max(...spread) !== Math.min(...spread)) {
    throw new Error(
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

  const schedule: Record<number, Record<Window, string[]>> = {}
  for (let d = 1; d <= days; d++) {
    const row = {} as Record<Window, string[]>
    windows.forEach((w, i) => {
      row[w] = dealt[(d - 1) * windows.length + i] ?? []
    })
    schedule[d] = row
  }
  return schedule
}

/** How many windows each seat actually got, once a schedule is dealt. */
export function windowsPerSeat(
  schedule: Record<number, Record<Window, string[]>>,
  o: { days: number; windows: Window[] },
): Record<string, number> {
  const n: Record<string, number> = {}
  for (let d = 1; d <= o.days; d++) {
    for (const w of o.windows) {
      for (const k of schedule[d]?.[w] ?? []) n[k] = (n[k] ?? 0) + 1
    }
  }
  return n
}

/* ========================================================================== *
 * BUILDING ONE                                                               *
 * ========================================================================== */

export type BuiltWorld = {
  /** This run's own number. One sender, one front desk, no sharing. */
  senderId: string
  senderPhone: string
  /** The arrivals hall. A tenant that owns nothing and cannot initiate. */
  frontDeskId: string
  /** Seat key → the contact they hold AT THE FRONT DESK, to begin with. */
  contacts: Record<string, string>
  roster: { name: string; role: SeatRole; contactId: string; phone: string; academyId: string; key: string }[]
  /**
   * The withheld cast: people the world describes and the product does not know
   * yet. Their phones are allocated (index-stable, so a person's number is the
   * same whether withheld or present) and no contact exists — they are what the
   * founder's contact book holds, they spawn through `_arrivals.ts` when the
   * product reaches their number, and the ones with `arrives` walk in on their
   * day. Nobody in here has a row anywhere.
   */
  cast: { name: string; seat: SeatRole; phone: string; key: string; arrives?: number }[]
}

/**
 * A sender, a front desk, and people holding phones. Nothing else exists.
 *
 * Every row here is made by the PRODUCT'S own function — `app.front_desk_contact`
 * ensures the desk, finds or creates the person and the contact, and hands back
 * both ids. There is no second way into those tables and therefore no second
 * definition of what a visitor is. The old builder wrote two hundred lines of its
 * own SQL and had to be kept true as the schema moved; this cannot drift, because
 * it is not a copy of anything.
 *
 * The clock is set on the FRONT DESK, which is the one tenant that exists at this
 * point, and it is set for the same reason it always was: a week that opens
 * wherever the last run left the offset holds its first "morning" window at half
 * past eleven at night. A front desk fires no jobs (0039: `onboarding_state`
 * stays `setup`, so send gate 5 suppresses everything it did not compose as a
 * direct reply), so nothing runs on it — but the moment a business is founded,
 * `sim.ts` gives that business a clock of its own at the same instant, and the
 * week carries on across the handover without a jump.
 */
/**
 * Where `--start` lands on the calendar, in the world's own timezone.
 *
 * `YYYY-MM-DD` is that date; `day:N` is the next FUTURE Nth of a month (N is
 * 1..28, checked at the flag, so it exists in every month). Either way the run
 * opens at 06:00 local — before the earliest standing job, so day 1 opens with
 * nothing already missed, exactly as the Monday default does.
 *
 * Past dates are refused with the two reasons: every drive walks its clock
 * FORWARD only, and `gc` measures a world's age off the tenant clock — a run
 * opened last week reads as a week old the moment it is built, and `gc --hours 6`
 * would reap it mid-run.
 */
export function resolveStart(ref: string, timezone: string): Date {
  const now = LuxonDateTime.now().setZone(timezone)
  let at: LuxonDateTime
  const dayForm = ref.match(/^day:(\d{1,2})$/)
  if (dayForm) {
    const d = Number(dayForm[1])
    at = now.set({ day: d, hour: 6, minute: 0, second: 0, millisecond: 0 })
    while (at <= now) at = at.plus({ months: 1 }).set({ day: d })
  } else {
    at = LuxonDateTime.fromISO(ref, { zone: timezone }).set({ hour: 6, minute: 0, second: 0, millisecond: 0 })
    if (!at.isValid) throw new Error(`--start ${ref} is not a date`)
    if (at <= now) {
      throw new Error(
        `--start ${ref} is in the past (${timezone}). A drive walks its clock forward only, ` +
          `and gc ages worlds by the tenant clock — a run opened in the past would be reaped as stale mid-week.`,
      )
    }
  }
  return at.toJSDate()
}

export async function buildWorld(
  w: World,
  o: { token: string; log?: (s: string) => void; startAt?: Date },
): Promise<BuiltWorld> {
  const log = o.log ?? (() => {})
  const { withSession } = await import('@/lib/db')
  const { newId } = await import('@/lib/ids')
  const clock = await import('@/lib/clock')
  const { DateTime } = await import('luxon')

  const senderId = newId()
  const digits = senderId.replace(/\D/g, '')
  /**
   * This run's number, and every visitor's, derived from the sender id.
   *
   * The same scheme the spec builder used and for the same reason: two drives
   * must not hand out one number. A phone known to two tenants on one sender
   * resolves to NEITHER — silently, so the turn simply never happens — and that
   * was one of the three separate things that used to make a second concurrent
   * drive destroy the first.
   */
  const senderPhone = `+15550${digits.slice(0, 6)}`
  const phoneFor = (n: number): string => `+9195${digits.slice(0, 6)}${String(n).padStart(2, '0')}`

  /**
   * `is_sim` is the one field here that reaches outside this file, and it is what
   * makes a run against a live database safe rather than merely isolated (0040).
   *
   * Everything else in this insert isolates two DRIVES from each other. This
   * isolates the drive from PRODUCTION, which is a different fence and used not
   * to exist: one database serves the deployed beat and every local run, the beat
   * claimed any job that was pending and due, and it ticks every sixty seconds
   * against a drive that drains when a driver says so. It won every race. The run
   * then recorded a week in which its own jobs had already been done by somebody
   * else, and the worker that did them was holding the live Cloud credentials.
   *
   * Three things follow from this one boolean, none of them stated here:
   * the business the product founds on this number is born `is_sandbox`
   * (`app.found_business`), its jobs are stamped `lane = 'sim'` and the beat
   * cannot see them (`app.stamp_job_lane`), and its outbound takes the emulator
   * road whatever `TRANSPORT` says (`getTransport`). The credentials stay `{}`
   * underneath all of that, so the Cloud transport would refuse this number by
   * name even if all three were wrong at once.
   */
  await withSession({ role: 'service', academyId: senderId }, async (tx) => {
    await tx`
      insert into sender (id, phone_e164, waba_id, credentials, label, is_sim)
      values (${senderId}::uuid, ${senderPhone}, ${`WABA-SIM-${o.token}`}, '{}'::jsonb,
              ${`sim ${o.token}`}, true)
      on conflict (id) do nothing`
  })
  log(`sender ${senderPhone} — this run's own number, sim lane`)

  const at = await clock.now(senderId).catch(() => new Date())
  const contacts: Record<string, string> = {}
  const roster: BuiltWorld['roster'] = []
  const cast: BuiltWorld['cast'] = []
  let frontDeskId = ''

  for (const [i, person] of w.people.entries()) {
    /**
     * The phone is allocated off the person's POSITION in the file, present or
     * not — so marking somebody withheld does not renumber everyone after them,
     * and the number the founder's contact book promises is the number the
     * contact really gets when the product finally reaches it.
     */
    const phone = phoneFor(i + 1)
    if (!person.present) {
      cast.push({
        name: person.name,
        seat: person.seat,
        phone,
        key: keyOf(person.name),
        ...(person.arrives !== undefined ? { arrives: person.arrives } : {}),
      })
      continue
    }
    const [row] = await withSession(
      { role: 'service', academyId: frontDeskId || senderId },
      async (tx) =>
        (await tx`
          select app.front_desk_contact(
            ${senderId}::uuid, ${phone}, ${person.name}, ${person.name}, ${at.toISOString()}::timestamptz
          ) as out`) as unknown as { out: { front_desk_id: string; contact_id: string } }[],
    )
    const out = row!.out
    frontDeskId = out.front_desk_id
    const key = keyOf(person.name)
    contacts[key] = out.contact_id
    // Everybody starts at the desk, because that is the only tenant that exists
    // yet. `academyOf` reads this per seat; only the people who actually move
    // into a founded business get it rewritten (`follow` in sim.ts).
    roster.push({
      name: person.name,
      role: person.seat,
      contactId: out.contact_id,
      phone,
      academyId: out.front_desk_id,
      key,
    })
  }

  /**
   * A Monday at six in the morning, next week.
   *
   * Next and not this, because every drive walks FORWARD only: opening on a
   * Monday that has already passed would put the whole week behind the real
   * clock, and `materialize_sessions` plans on a rolling horizon measured from
   * `app.now()`. The hour matters too — six is before the earliest standing job,
   * so day 1 opens with nothing already missed.
   */
  let opens: import('luxon').DateTime
  if (o.startAt) {
    opens = DateTime.fromJSDate(o.startAt).setZone(w.timezone)
    /**
     * `life` prose was written against Monday-start weeks — "day 2" in a
     * canonical file means a Tuesday. A warning and not a refusal: the
     * calendar-aimed runs (`--preset e2e`) care about the 1st, not the weekday,
     * and their worlds carry little or no `life`.
     */
    const hasLife = w.people.some((p) => Object.keys(p.life ?? {}).length > 0)
    if (hasLife && opens.weekday !== 1) {
      log(`note: this world has life entries written against Monday-start weeks, and this run opens on a ${opens.toFormat('EEEE')}`)
    }
  } else {
    opens = DateTime.now()
      .setZone(w.timezone)
      .startOf('week')
      .set({ hour: 6, minute: 0, second: 0, millisecond: 0 })
    if (opens <= DateTime.now().setZone(w.timezone)) opens = opens.plus({ weeks: 1 })
  }
  await clock.setTo(opens.toJSDate(), frontDeskId)

  /**
   * A world of only-withheld people never called `front_desk_contact`, so the
   * desk would not exist and the walk-in path would have no tenant to seat into.
   * `validateWorld` refuses that world, so this is belt and braces — but the
   * belt is one query and the alternative is a run that dies on day N.
   */
  if (!frontDeskId) {
    const [row] = await withSession({ role: 'service', academyId: senderId }, async (tx) =>
      (await tx`select app.front_desk_for(${senderId}::uuid) as id`) as unknown as { id: string }[],
    )
    frontDeskId = row?.id ?? ''
  }

  log(
    `front desk ${frontDeskId.slice(0, 8)} · ${roster.length} at the number, in no business` +
      (cast.length ? ` · ${cast.length} withheld — reachable, not yet reached` : ''),
  )
  log(`clock set to ${opens.toFormat('EEE d LLL yyyy, HH:mm')} ${w.timezone}`)

  return { senderId, senderPhone, frontDeskId, contacts, roster, cast }
}

export { INPUT_REALISM }
export type { SeatRole, Window }

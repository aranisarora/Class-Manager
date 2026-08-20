/**
 * _world-spec — an academy written down in one small file, and built from it.
 *
 *   import { buildWorld, describeWorld, loadWorldSpec, validateSpec } from './_world-spec'
 *
 *   const spec  = await loadWorldSpec('multi-coach')          // worlds/multi-coach.json
 *   console.log(describeWorld(spec))
 *   const world = await buildWorld(spec, { token, log: (s) => console.log(s) })
 *
 *   await buildWorld(BLANK, { token })                        // the owner, and nobody else
 *   await loadWorldSpec('{"coaches":4,"clients":6}')           // inline, for a one-off
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * There was exactly one settled academy in this repo, and it was welded into
 * `drive-week.ts`: four families, five children, two employed coaches, four
 * classes, in two hundred lines of SQL that also happened to be the only way to
 * get a business past onboarding without driving the onboarding conversation by
 * hand for an hour. Wanting six clients instead of four, or an owner who does not
 * coach, or three classes on a Tuesday, meant editing that function — and every
 * `life` string in `_personas.ts` that was written against what it built.
 *
 * The obvious answer is five or six pre-made archetypes, and it is the wrong one.
 * That is the same welding done six times: six worlds to keep true as the schema
 * moves, none of them ever quite the business you meant, and a file that grows a
 * case for every question anybody asks. So there is ONE format instead, small
 * enough to write by hand in a minute, and one builder that turns it into rows.
 *
 * WHERE IT LEAVES THE WORLD
 * -----------------------------------------------------------------------------
 * At `onboarding_state = 'live'`: the moment the setup conversation finished and
 * the interesting week begins. That is the point the format describes and the
 * only point it describes — with one exception the database itself insists on: a
 * world with NO classes is left at `setup`, because `app.guard_go_live()` (0033)
 * refuses to switch the reminders on over an empty timetable. `BLANK` is that
 * world, and setup is where it belongs.
 *
 * Nothing here writes a message, a session, a payment or
 * a bill — the product materialises its own sessions and bills its own open
 * period, and a fixture that pre-bills it gets the month charged twice. `_world.ts`
 * paid for that once: every family's month doubled on the first drain and a parent
 * was told she owed ₹4,800.
 *
 * The one exception is `owes`, which writes a closed PRIOR period, because a
 * business that has been running has arrears and there is no other way to say so.
 *
 * IT DOES NOT TOUCH THE CLOCK, AND THE CALLER MUST
 * -----------------------------------------------------------------------------
 * Every date written below is relative to `app.now()` — this tenant's own clock —
 * so a caller that sets the clock AFTER building gets a class that started forty
 * days before whatever the last run left the clock at, which may be next year.
 * Set the academy's clock first (`clock.setTo(when, academyId)`), then build. The
 * clock is read here and logged, so a build against a clock nobody set says so in
 * the run's own output rather than in a puzzled reading a week later.
 *
 * A COUNT IS AS GOOD AS A LIST
 * -----------------------------------------------------------------------------
 * `"coaches": 4` and `"coaches": [{"name": "Arjun Shetty"}]` are both valid and
 * mean the same kind of thing. A count draws from a fixed pool of plausible names
 * and stops — loudly — when the pool runs out, rather than generating `Coach 13`.
 * The same for clients, prospects, and for a class's `enrolled`, where a number
 * means "this many of the children, dealt in order".
 *
 * DAYS ARE NAMES
 * -----------------------------------------------------------------------------
 * `"days": ["mon","thu"]`, never `[1,4]`. `class_slot.weekday` is 0=Sun..6=Sat
 * (0002_schema.sql:179) and `_personas.ts`'s `TIMETABLE` stores ISO weekdays
 * (1=Mon..7=Sun); the two agree on Monday through Saturday and differ only on
 * Sunday, which is the one day the canonical timetable does not use. That is a
 * coincidence, not a design, and a hand-written integer is one Monday/Wednesday
 * mix-up away from a coach being told his batch is not on today when it is — a
 * defect that reads exactly like the product losing a class, and costs a day in
 * `lib/agent` hunting something that never happened.
 *
 * THE PHONE NUMBERS ARE NOT A FREE CHOICE
 * -----------------------------------------------------------------------------
 * Every tenant shares one sender, and §10.1 resolves an inbound by the pair
 * (from, sender): a number held by two academies matches two contacts and
 * resolves to NEITHER — the message is never delivered and nothing anywhere
 * raises an error. So every number here is derived from the academy id, exactly
 * as `drive-week.ts` does it, the admin's included: `createAcademy` picks its
 * admin number by scanning for a free one, and two builds scanning in the same
 * millisecond pick the same one.
 *
 * The shape is `+9194` + six digits of the id + a two-digit seat index. India's
 * E.164 is `+91` and ten national digits and there is no room to be generous with
 * them: `drive-week` spends seven on the id and one on the index, which tops out
 * at ten people — and the world this format was asked for has eleven before it
 * has a prospect. Six and two buys a hundred seats for a thousandth of the id
 * space. `94` rather than `99` because `+9199…` is the block `createTestContact`
 * and `createAcademy` allocate out of, and rather than `93` because that is what
 * `drive-week` derives, so a spec world and a `drive-week` world cannot land on
 * the same number even if their ids share a prefix.
 *
 * WHAT IT REFUSES, AND WHY REFUSING IS THE POINT
 * -----------------------------------------------------------------------------
 * A hand-written fixture fails silently or not at all. `"coachs": 4` is not four
 * coaches, it is zero coaches and no message; `"days": ["tues"]` is not Tuesday;
 * a class naming a coach who is not in the file is a class nobody teaches; and
 * two active classes with one name are ONE class, because
 * `class_academy_name_active_key` (migration 0020) is unique on the active name
 * and the second insert is swallowed. Every one of those produces a world that is
 * not the world somebody asked for, and a week driven inside it measures a
 * business that does not exist.
 *
 * So: an unknown key at any level, an unknown day, a coach who is not there, an
 * `enrolled` name nobody has, a negative count, a time that runs backwards, two
 * people with one name — each stops the build before it costs anything, naming
 * the path and what was wrong. It refuses; it never repairs. A repaired spec is a
 * spec that quietly stopped being what was written down.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * The seat, for its service-role query and the timezone every instrument here
 * runs in. Importing it is also what loads `.env` and forces
 * `TRANSPORT=emulator` — `.env.local` ships `TRANSPORT=cloud`, and a build that
 * takes the cloud path hard-fails at the credential gate.
 */
import { TZ, q } from './_seat'

const { createAcademy, createTestContact, worldAcademyIds } = await import('@/lib/seed')
const clock = await import('@/lib/clock')

/* ========================================================================== *
 * THE FORMAT
 * ========================================================================== */

/**
 * The seven day names, in the order `class_slot.weekday` numbers them.
 *
 * The INDEX is the column value — `DAYS.indexOf('mon')` is 1 and `weekday` is
 * 0=Sun..6=Sat — so the mapping is the array rather than a second table beside
 * it that can disagree with this one.
 */
export const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type Day = (typeof DAYS)[number]

/** What `coach.pay_unit` accepts, minus `per_hour`, which nothing here bills by. */
export type PayUnit = 'per_session' | 'per_month'
/** What `class.rate_unit` accepts, minus `per_term` and `per_package`. */
export type RateUnit = 'per_month' | 'per_session'

export type CoachSpec = {
  name?: string
  /** Rupees. Omitted, `coach.pay_amount` stays null — "not tracked", a real state. */
  pay?: number
  /** Required when `pay` is set. A unit with no amount bills nothing. */
  unit?: PayUnit
}

export type ClientSpec = {
  name?: string
  /**
   * The children on the books under this parent. Omitted, they get one, named
   * for them. **`[]` means the client is the learner** — an adult beginner — and
   * is the only way to say so: with children, the parent's own auto-created
   * player row is retired; without, it is what everything enrols.
   */
  children?: string[]
  /** Rupees carried into this world from before it. See `openingBalance`. */
  owes?: number
}

export type ProspectSpec = { name?: string }

export type ClassSpec = {
  name: string
  /** `['mon','thu']`. One `class_slot` per day, all at the same hour. */
  days: Day[]
  /** `'18:00'`, 24-hour, in the academy's own timezone. */
  from: string
  to: string
  /** Rupees. Omitted, the class has no rate and the monthly job bills nothing. */
  rate?: number
  /** Defaults to `per_month` when `rate` is set; refused when it is not. */
  unit?: RateUnit
  /** By name. Omitted, coaches are dealt round-robin. `[]` leaves it uncovered. */
  coaches?: string[]
  /** Child names, or how many of the children — dealt in order across classes. */
  enrolled?: string[] | number
}

export type WorldSpec = {
  /** The business. The run token is appended, so `gc` and parallel drives work. */
  name?: string
  /** `'tennis'`, `'chess'`, `'swimming'` — **DISPLAY ONLY** (0002_schema.sql:34). */
  category?: string
  timezone?: string
  /** The owner. `coaches: true` gives them a `coach` row as well as an admin one. */
  admin?: { name?: string; coaches?: boolean }
  coaches?: number | CoachSpec[]
  clients?: number | ClientSpec[]
  prospects?: number | ProspectSpec[]
  classes?: ClassSpec[]
}

/**
 * A spec with every count expanded, every default filled and every name resolved
 * — and still a `WorldSpec`, assignable to one, so validating twice is a fixed
 * point rather than a second pass with different rules.
 *
 * `validateSpec` returns this, and `buildWorld` takes nothing else, which is what
 * keeps every rule in the validator: a builder that also defaults something is a
 * second place for a default to live, and the two drift.
 */
export type NormalSpec = {
  name: string
  category: string
  timezone: string
  admin: { name: string; coaches: boolean }
  coaches: { name: string; pay?: number; unit?: PayUnit }[]
  clients: { name: string; children: string[]; owes?: number }[]
  prospects: { name: string }[]
  classes: {
    name: string
    days: Day[]
    from: string
    to: string
    rate?: number
    unit?: RateUnit
    coaches: string[]
    enrolled: string[]
  }[]
}

/**
 * The default stage: the owner, alone, the morning after onboarding finished.
 *
 * It is the empty object rather than a list of the defaults on purpose — the
 * defaults are stated once, in `validateSpec`, and a second copy here would be a
 * second thing to keep true. `{}` normalises to exactly this, which is what makes
 * `worlds/blank.json` two characters long.
 */
export const BLANK: WorldSpec = Object.freeze({})

/* ========================================================================== *
 * NAMES A COUNT TURNS INTO
 * ========================================================================== */

/**
 * Three pools and a set of first names for children, all distinct, so a spec
 * written entirely in counts still has a world where no two people share a name.
 *
 * A count past the end of its pool is REFUSED rather than extended with
 * `Coach 13`. The pools are what makes a count ergonomic, and a generated
 * placeholder name is not ergonomic — it is a business with a bug in its roster,
 * and every sentence the product writes about that person carries it.
 */
const COACH_POOL = [
  'Arjun Shetty', 'Priya Nair', 'Vikram Deshpande', 'Sneha Kulkarni',
  'Imran Qureshi', 'Deepa Raman', 'Karthik Subramanian', 'Neha Bhatia',
  'Rohan Fernandes', 'Anjali Sethi', 'Sameer Chauhan', 'Ritu Bansal',
]

const CLIENT_POOL = [
  'Divya Rao', 'Meera Iyer', 'Sanjay Gupta', 'Latha Krishnan',
  'Naveen Reddy', 'Fatima Ansari', 'Pooja Mehta', 'Harish Prabhu',
  'Shalini Verma', 'Ganesh Kamath', 'Ayesha Khan', 'Manoj Sinha',
  'Revathi Nambiar', 'Sunil Dixit', 'Nandini Joshi', 'Farooq Baig',
]

const PROSPECT_POOL = [
  'Farah Sheikh', 'Kavita Shah', 'Nikhil Bose', 'Ramesh Patel',
  'Sarita Yadav', 'Vinod Chandra', 'Asha Pillai', 'Tarun Ghosh',
  'Leela Varma', 'Zaid Rehman', 'Bhavna Trivedi', 'Suresh Rathore',
]

/** A child takes its parent's surname, so a family reads as one on a register. */
const CHILD_FIRST = [
  'Anika', 'Vivaan', 'Ishaan', 'Riya', 'Tara', 'Aarav', 'Diya', 'Kabir',
  'Myra', 'Aryan', 'Saanvi', 'Reyansh', 'Aadhya', 'Vihaan', 'Anaya', 'Advait',
  'Kiara', 'Arnav', 'Ira', 'Dhruv', 'Zara', 'Rudra', 'Amaira', 'Yuvan',
]

/**
 * The default owner is the admin persona the seat instruments already put in that
 * chair. A world whose owner has a different name is perfectly valid — name one —
 * but a spec that says nothing about its owner is better off with the name the
 * rest of the harness recognises than with "Academy Owner".
 */
const DEFAULT_ADMIN = 'Rahul Menon'
const DEFAULT_NAME = 'Custom Academy'
/** `createAcademy`'s own default. Display only, so it decides nothing. */
const DEFAULT_CATEGORY = 'sport'

/** Six id digits plus a two-digit index. See the header for why not seven and one. */
const MAX_SEATS = 100

/* ========================================================================== *
 * VALIDATION
 * ========================================================================== */

const TOP_KEYS = ['name', 'category', 'timezone', 'admin', 'coaches', 'clients', 'prospects', 'classes']
const ADMIN_KEYS = ['name', 'coaches']
const COACH_KEYS = ['name', 'pay', 'unit']
const CLIENT_KEYS = ['name', 'children', 'owes']
const PROSPECT_KEYS = ['name']
const CLASS_KEYS = ['name', 'days', 'from', 'to', 'rate', 'unit', 'coaches', 'enrolled']

/**
 * What a name may contain.
 *
 * Two jobs in one expression. Every write below interpolates a name into SQL —
 * `q` runs `tx.unsafe`, which is what the whole repo does for fixtures — so a
 * name carrying a quote, a semicolon or a newline is an injection in a file
 * somebody hand-writes. And `person.full_name` is the join key every fixture in
 * this repo matches on (`drive-week.ts` joins `class_coach` and `enrollment` on
 * it), so a name with a stray newline in it is a person nothing can find.
 *
 * Letters — including accented ones — spaces, apostrophes, hyphens and full
 * stops. That is a person's name; the rest is a mistake or an attack, and neither
 * is worth repairing.
 */
const NAME_OK = /^[\p{L}][\p{L} .'-]{0,79}$/u
const TIME_OK = /^([01]\d|2[0-3]):([0-5]\d)$/

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Every problem, not the first one.
 *
 * A validator that throws on the first fault turns a five-line fix into five
 * runs. The message names the path — `classes[1].days[0]` — because "invalid day"
 * against a file with four classes in it is a search rather than an answer.
 */
class Problems {
  readonly all: string[] = []
  add(path: string, said: string): void {
    this.all.push(`${path} — ${said}`)
  }
  throwIfAny(where: string): void {
    if (!this.all.length) return
    throw new Error(
      `${where} is not a world:\n` +
        this.all.map((p) => `  · ${p}`).join('\n') +
        `\n\nNothing was built. See worlds/README.md for the format.`,
    )
  }
}

function unknownKeys(o: Record<string, unknown>, allowed: string[], path: string, p: Problems): void {
  for (const k of Object.keys(o)) {
    if (allowed.includes(k)) continue
    // Named alongside what is allowed, because the whole failure this catches is
    // a near-miss — `coachs`, `enroled`, `timeZone` — and a reader who could see
    // the typo would not have made it.
    p.add(`${path}.${k}`, `is not a field. This level takes: ${allowed.join(', ')}`)
  }
}

function nameOf(v: unknown, path: string, pool: string[], at: number, p: Problems): string {
  if (v === undefined) {
    const picked = pool[at]
    if (picked === undefined) {
      p.add(path, `has no name and the pool of generated names holds only ${pool.length} — name this one yourself`)
      return `unnamed-${at}`
    }
    return picked
  }
  if (typeof v !== 'string' || !NAME_OK.test(v.trim())) {
    p.add(path, `is not a name: ${JSON.stringify(v)}. Letters, spaces, apostrophes, hyphens and full stops, up to 80 characters`)
    return `unnamed-${at}`
  }
  return v.trim()
}

/** A count, or a list. Both mean "this many of these people". */
function roster<T>(
  v: unknown, path: string, pool: string[], p: Problems,
  read: (raw: Record<string, unknown>, i: number, name: string) => T,
  make: (name: string, i: number) => T,
): T[] {
  if (v === undefined) return []
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) {
      p.add(path, `is ${JSON.stringify(v)}. A count is a whole number, zero or more`)
      return []
    }
    if (v > pool.length) {
      p.add(path, `asks for ${v} and the pool of generated names holds ${pool.length}. List them by name past that`)
      return []
    }
    return Array.from({ length: v }, (_, i) => make(pool[i] as string, i))
  }
  if (!Array.isArray(v)) {
    p.add(path, `is neither a count nor a list: ${JSON.stringify(v)}`)
    return []
  }
  return v.map((raw, i) => {
    if (!isObj(raw)) {
      p.add(`${path}[${i}]`, `is not an object: ${JSON.stringify(raw)}`)
      return make(pool[i] ?? `unnamed-${i}`, i)
    }
    return read(raw, i, nameOf(raw.name, `${path}[${i}].name`, pool, i, p))
  })
}

/** Rupees. Optional, finite, and rounded to the paisa this product bills in. */
function money(v: unknown, path: string, p: Problems, allowNegative = false): number | undefined {
  if (v === undefined) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    p.add(path, `is not an amount in rupees: ${JSON.stringify(v)}`)
    return undefined
  }
  if (v < 0 && !allowNegative) {
    p.add(path, `is negative (${v}). Rupees, and this one cannot be`)
    return undefined
  }
  return Math.round(v * 100) / 100
}

/**
 * Read a spec, fill in what it did not say, and refuse everything else.
 *
 * The one place any rule or default lives. `buildWorld` and `describeWorld` both
 * start here, so a world's English description and the rows it becomes cannot
 * disagree about what the file meant.
 */
export function validateSpec(s: unknown, where = 'this spec'): NormalSpec {
  const p = new Problems()
  if (!isObj(s)) {
    throw new Error(`${where} is not a world: the top level is ${Array.isArray(s) ? 'a list' : JSON.stringify(s)}, and it must be an object. \`{}\` is valid and gives you the owner and nothing else.`)
  }
  unknownKeys(s, TOP_KEYS, where === 'this spec' ? 'spec' : where, p)

  /* --------------------------------------------------------------- the business */

  const name = s.name === undefined ? DEFAULT_NAME : nameOf(s.name, 'name', [], 0, p)
  const category =
    s.category === undefined ? DEFAULT_CATEGORY
    : typeof s.category === 'string' && s.category.trim() ? s.category.trim()
    : (p.add('category', `is not a word: ${JSON.stringify(s.category)}. It is display only (0002_schema.sql:34) and decides nothing`), DEFAULT_CATEGORY)

  let timezone = TZ
  if (s.timezone !== undefined) {
    if (typeof s.timezone !== 'string') p.add('timezone', `is not a string: ${JSON.stringify(s.timezone)}`)
    else {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: s.timezone })
        timezone = s.timezone
      } catch {
        p.add('timezone', `is not a zone this machine knows: ${JSON.stringify(s.timezone)}. IANA names, like "Asia/Kolkata"`)
      }
    }
  }

  const adminRaw = s.admin === undefined ? {} : s.admin
  let admin = { name: DEFAULT_ADMIN, coaches: false }
  if (!isObj(adminRaw)) p.add('admin', `is not an object: ${JSON.stringify(adminRaw)}`)
  else {
    unknownKeys(adminRaw, ADMIN_KEYS, 'admin', p)
    if (adminRaw.coaches !== undefined && typeof adminRaw.coaches !== 'boolean') {
      p.add('admin.coaches', `is not true or false: ${JSON.stringify(adminRaw.coaches)}. It asks whether the owner also coaches`)
    }
    admin = {
      name: adminRaw.name === undefined ? DEFAULT_ADMIN : nameOf(adminRaw.name, 'admin.name', [], 0, p),
      coaches: adminRaw.coaches === true,
    }
  }

  /* ------------------------------------------------------------------ people */

  const coaches = roster<NormalSpec['coaches'][number]>(
    s.coaches, 'coaches', COACH_POOL, p,
    (raw, i, nm) => {
      unknownKeys(raw, COACH_KEYS, `coaches[${i}]`, p)
      const pay = money(raw.pay, `coaches[${i}].pay`, p)
      let unit: PayUnit | undefined
      if (raw.unit !== undefined) {
        if (raw.unit !== 'per_session' && raw.unit !== 'per_month') {
          p.add(`coaches[${i}].unit`, `is ${JSON.stringify(raw.unit)}. It is "per_session" or "per_month"`)
        } else unit = raw.unit
      }
      if (unit !== undefined && pay === undefined) {
        p.add(`coaches[${i}].unit`, `is set and coaches[${i}].pay is not. A unit with no amount pays nothing`)
      }
      return { name: nm, ...(pay === undefined ? {} : { pay }), ...(pay === undefined ? {} : { unit: unit ?? 'per_month' }) }
    },
    (nm) => ({ name: nm }),
  )

  const clients = roster<NormalSpec['clients'][number]>(
    s.clients, 'clients', CLIENT_POOL, p,
    (raw, i, nm) => {
      unknownKeys(raw, CLIENT_KEYS, `clients[${i}]`, p)
      // Negative allowed: `tally_line.amount` is "negative for credits", and a
      // family in credit is an ordinary state a settled world may open in.
      const owes = money(raw.owes, `clients[${i}].owes`, p, true)
      let children: string[]
      if (raw.children === undefined) children = [defaultChild(nm, i)]
      else if (!Array.isArray(raw.children)) {
        p.add(`clients[${i}].children`, `is not a list: ${JSON.stringify(raw.children)}. \`[]\` means this client is the learner`)
        children = []
      } else {
        children = raw.children.map((cn, j) => nameOf(cn, `clients[${i}].children[${j}]`, [], j, p))
      }
      return { name: nm, children, ...(owes === undefined ? {} : { owes }) }
    },
    (nm, i) => ({ name: nm, children: [defaultChild(nm, i)] }),
  )

  const prospects = roster<NormalSpec['prospects'][number]>(
    s.prospects, 'prospects', PROSPECT_POOL, p,
    (raw, i, nm) => {
      unknownKeys(raw, PROSPECT_KEYS, `prospects[${i}]`, p)
      return { name: nm }
    },
    (nm) => ({ name: nm }),
  )

  /* --------------------------------------------------- everybody, exactly once */

  /**
   * `person.full_name` is what every fixture write in this repo joins on, so two
   * people sharing a name is not a cosmetic clash — it is an `enrollment` that
   * lands on whichever row the planner reached first, silently.
   */
  const everyone = [
    [admin.name, 'admin.name'],
    ...coaches.map((cch, i) => [cch.name, `coaches[${i}].name`] as const),
    ...clients.map((cl, i) => [cl.name, `clients[${i}].name`] as const),
    ...clients.flatMap((cl, i) => cl.children.map((ch, j) => [ch, `clients[${i}].children[${j}]`] as const)),
    ...prospects.map((pr, i) => [pr.name, `prospects[${i}].name`] as const),
  ] as [string, string][]
  const seenName = new Map<string, string>()
  for (const [who, from] of everyone) {
    const first = seenName.get(who.toLowerCase())
    if (first !== undefined) {
      p.add(from, `names "${who}", and so does ${first}. Every person in a world needs their own name — full_name is what enrolments and class_coach rows are matched on`)
    } else seenName.set(who.toLowerCase(), from)
  }

  const seats = 1 + coaches.length + clients.length + prospects.length
  if (seats > MAX_SEATS) {
    p.add('spec', `has ${seats} people with phones (1 admin + ${coaches.length} coaches + ${clients.length} clients + ${prospects.length} prospects) and a derived number has room for ${MAX_SEATS}`)
  }

  /* ----------------------------------------------------------------- classes */

  /** Who may be named as a coach: the employed ones, and the owner if they coach. */
  const coachable = new Set<string>(coaches.map((cch) => cch.name.toLowerCase()))
  if (admin.coaches) coachable.add(admin.name.toLowerCase())
  const rotation = [...(admin.coaches ? [admin.name] : []), ...coaches.map((cch) => cch.name)]

  /**
   * Who can be enrolled: each client's children, or the client themselves when
   * they said they have none. An adult beginner is a player like any other.
   */
  const learners = clients.flatMap((cl) => (cl.children.length ? cl.children : [cl.name]))
  const learnerAt = new Map<string, string>(learners.map((l) => [l.toLowerCase(), l]))

  let deal = 0
  let assign = 0
  const classes: NormalSpec['classes'] = []
  const classesRaw = s.classes === undefined ? [] : s.classes
  if (!Array.isArray(classesRaw)) {
    p.add('classes', `is not a list: ${JSON.stringify(classesRaw)}`)
  } else {
    for (let i = 0; i < classesRaw.length; i++) {
      const raw = classesRaw[i]
      const at = `classes[${i}]`
      if (!isObj(raw)) {
        p.add(at, `is not an object: ${JSON.stringify(raw)}`)
        continue
      }
      unknownKeys(raw, CLASS_KEYS, at, p)

      const cname =
        typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim()
        : (p.add(`${at}.name`, `is missing. A class is named by its admin's own words — "6:30 Beginners Batch"`), `class-${i}`)

      const days: Day[] = []
      if (!Array.isArray(raw.days) || raw.days.length === 0) {
        // Not repaired to "every day" or left empty: a class with no slot never
        // materialises a session, so nothing in the week it belongs to ever
        // mentions it, and the file that asked for it looks like it worked.
        p.add(`${at}.days`, `is missing or empty. A class with no day never runs a session. Names, not numbers: ${DAYS.join(', ')}`)
      } else {
        for (let j = 0; j < raw.days.length; j++) {
          const d = raw.days[j]
          if (typeof d === 'number') {
            p.add(`${at}.days[${j}]`, `is the number ${d}. Days are names here — ${DAYS.join(', ')} — because weekday numbering differs between this schema and _personas.ts`)
            continue
          }
          const lower = typeof d === 'string' ? (d.trim().toLowerCase() as Day) : null
          if (!lower || !DAYS.includes(lower)) {
            p.add(`${at}.days[${j}]`, `is ${JSON.stringify(d)}. One of: ${DAYS.join(', ')}`)
            continue
          }
          if (days.includes(lower)) {
            p.add(`${at}.days[${j}]`, `repeats "${lower}". Two identical slots make two sessions on one day`)
            continue
          }
          days.push(lower)
        }
      }

      const from = typeof raw.from === 'string' && TIME_OK.test(raw.from.trim()) ? raw.from.trim() : null
      const to = typeof raw.to === 'string' && TIME_OK.test(raw.to.trim()) ? raw.to.trim() : null
      if (from === null) p.add(`${at}.from`, `is ${JSON.stringify(raw.from)}. A 24-hour local time, like "18:00"`)
      if (to === null) p.add(`${at}.to`, `is ${JSON.stringify(raw.to)}. A 24-hour local time, like "19:00"`)
      if (from !== null && to !== null && to <= from) {
        p.add(`${at}.to`, `is "${to}" and ${at}.from is "${from}". A session ends after it starts`)
      }

      const rate = money(raw.rate, `${at}.rate`, p)
      let unit: RateUnit | undefined
      if (raw.unit !== undefined) {
        if (raw.unit !== 'per_month' && raw.unit !== 'per_session') {
          p.add(`${at}.unit`, `is ${JSON.stringify(raw.unit)}. It is "per_month" or "per_session"`)
        } else unit = raw.unit
      }
      if (unit !== undefined && rate === undefined) {
        p.add(`${at}.unit`, `is set and ${at}.rate is not. A unit with no amount bills nothing`)
      }

      let taught: string[]
      if (raw.coaches === undefined) {
        // Round-robin across the whole file rather than per class, so a world
        // with three coaches and three classes gives each of them one instead of
        // giving the first coach all three.
        taught = rotation.length ? [rotation[assign++ % rotation.length] as string] : []
      } else if (!Array.isArray(raw.coaches)) {
        p.add(`${at}.coaches`, `is not a list of names: ${JSON.stringify(raw.coaches)}. \`[]\` leaves the class uncovered`)
        taught = []
      } else {
        taught = []
        for (let j = 0; j < raw.coaches.length; j++) {
          const who = raw.coaches[j]
          if (typeof who !== 'string' || !coachable.has(who.trim().toLowerCase())) {
            p.add(`${at}.coaches[${j}]`, `names ${JSON.stringify(who)}, who is not a coach in this world. ${coachable.size ? `Available: ${[...rotation].join(', ')}` : admin.coaches ? '' : 'Nobody coaches here — add a coach, or set admin.coaches'}`)
            continue
          }
          const canonical = who.trim()
          if (taught.some((t) => t.toLowerCase() === canonical.toLowerCase())) {
            p.add(`${at}.coaches[${j}]`, `names "${canonical}" twice`)
            continue
          }
          taught.push(canonical)
        }
      }

      let enrolled: string[] = []
      if (raw.enrolled === undefined) enrolled = []
      else if (typeof raw.enrolled === 'number') {
        const n = raw.enrolled
        if (!Number.isInteger(n) || n < 0) {
          p.add(`${at}.enrolled`, `is ${JSON.stringify(n)}. A count is a whole number, zero or more`)
        } else if (n > learners.length) {
          p.add(`${at}.enrolled`, `asks for ${n} and this world has ${learners.length} ${learners.length === 1 ? 'child' : 'children'} in total`)
        } else {
          for (let k = 0; k < n; k++) enrolled.push(learners[(deal + k) % learners.length] as string)
          deal += n
        }
      } else if (!Array.isArray(raw.enrolled)) {
        p.add(`${at}.enrolled`, `is neither a count nor a list of names: ${JSON.stringify(raw.enrolled)}`)
      } else {
        for (let j = 0; j < raw.enrolled.length; j++) {
          const who = raw.enrolled[j]
          const canonical = typeof who === 'string' ? learnerAt.get(who.trim().toLowerCase()) : undefined
          if (canonical === undefined) {
            p.add(`${at}.enrolled[${j}]`, `names ${JSON.stringify(who)}, who is nobody's child in this world. Children come from clients[].children; a client with \`"children": []\` is themselves the learner`)
            continue
          }
          if (enrolled.includes(canonical)) {
            p.add(`${at}.enrolled[${j}]`, `names "${canonical}" twice in one class`)
            continue
          }
          enrolled.push(canonical)
        }
      }

      classes.push({
        name: cname, days, from: from ?? '00:00', to: to ?? '00:00',
        ...(rate === undefined ? {} : { rate }),
        ...(rate === undefined ? {} : { unit: unit ?? 'per_month' }),
        coaches: taught, enrolled,
      })
    }
  }

  /**
   * The unique index is on `lower(btrim(name))` where `active`, so this check has
   * to normalise the same way. Caught here rather than at the insert because the
   * insert does not fail — migration 0020's own header records what happened the
   * last time one was swallowed: 22 duplicate sessions, every coach message sent
   * twice, and the register prompt suppressed by the frequency cap.
   */
  const seenClass = new Map<string, number>()
  classes.forEach((cls, i) => {
    const key = cls.name.trim().toLowerCase()
    const first = seenClass.get(key)
    if (first !== undefined) {
      p.add(`classes[${i}].name`, `is "${cls.name}" and so is classes[${first}].name. class_academy_name_active_key is unique on the active class name — the second one would silently become the first`)
    } else seenClass.set(key, i)
  })

  p.throwIfAny(where)
  return { name, category, timezone, admin, coaches, clients, prospects, classes }
}

/** One child, named for its parent, when a client did not say. */
function defaultChild(parent: string, i: number): string {
  const parts = parent.trim().split(/\s+/)
  const surname = parts.length > 1 ? parts[parts.length - 1] : ''
  const first = CHILD_FIRST[i % CHILD_FIRST.length] as string
  return surname ? `${first} ${surname}` : first
}

/* ========================================================================== *
 * LOADING
 * ========================================================================== */

/**
 * Find a spec by reference, read it, and refuse it if it is not one.
 *
 *   loadWorldSpec('settled-tennis')          → worlds/settled-tennis.json
 *   loadWorldSpec('worlds/blank.json')       → that file
 *   loadWorldSpec('./arms/b.json')           → that file
 *   loadWorldSpec('{"coaches": 4}')          → inline, no file
 *
 * The bare-name form is what makes `--world multi-coach` readable on a command
 * line, and the inline form is for the one-off nobody wants a file for. A
 * reference that resolves to nothing names every path it looked at, because
 * "spec not found" against four resolution rules is a guessing game.
 */
export async function loadWorldSpec(ref: string): Promise<NormalSpec> {
  const raw = String(ref ?? '').trim()
  if (!raw) throw new Error('loadWorldSpec was given nothing. Pass a name (`multi-coach`), a path, or inline JSON.')

  /**
   * `[` as well as `{`, so a list handed in inline is refused for being a list
   * rather than reported as a filename that does not exist — which is what it
   * looked like, and which sends the reader looking for the wrong mistake.
   */
  if (raw.startsWith('{') || raw.startsWith('[')) {
    return validateSpec(parseJson(raw, 'the inline spec'), 'the inline spec')
  }

  const tried = [raw, `${raw}.json`, join('worlds', raw), join('worlds', `${raw}.json`)]
  const found = tried.find((cand) => existsSync(cand))
  if (!found) {
    throw new Error(
      `no world spec at "${raw}". Looked for:\n` +
        tried.map((t) => `  · ${t}`).join('\n') +
        `\n\nworlds/README.md lists the ones that ship, and the format for a new one.`,
    )
  }
  return validateSpec(parseJson(await readFile(found, 'utf8'), found), found)
}

/**
 * JSON with the position kept.
 *
 * `Unexpected token } in JSON at position 214` is the whole message V8 gives, and
 * against a hand-written file the line number is the only part anybody needs.
 */
function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text)
  } catch (e) {
    const msg = (e as Error).message
    const at = /position (\d+)/.exec(msg)
    const line = at ? text.slice(0, Number(at[1])).split('\n').length : null
    throw new Error(
      `${where} is not valid JSON${line ? ` (line ${line})` : ''}: ${msg}` +
        `\n\nJSON has no comments — if you were writing one, put it in worlds/README.md instead.`,
    )
  }
}

/* ========================================================================== *
 * DESCRIBING
 * ========================================================================== */

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * One English line, for the top of a run's output.
 *
 * It is what a reader checks the file against before spending an hour driving it:
 * "six clients" when you wrote four is a typo you find in a second here and in a
 * transcript an hour later.
 */
export function describeWorld(spec: WorldSpec): string {
  const s = validateSpec(spec)
  const kids = s.clients.reduce((a, cl) => a + cl.children.length, 0)
  const adults = s.clients.filter((cl) => !cl.children.length).length
  const slots = s.classes.reduce((a, cls) => a + cls.days.length, 0)
  const enrolled = s.classes.reduce((a, cls) => a + cls.enrolled.length, 0)
  const owed = s.clients.reduce((a, cl) => a + (cl.owes ?? 0), 0)

  const bits = [
    `${s.admin.name} owns it${s.admin.coaches ? ' and coaches' : ''}`,
    plural(s.coaches.length, 'coach', 'coaches'),
    `${plural(s.clients.length, 'client')} with ${kids ? plural(kids, 'child', 'children') : 'no children'}${adults ? ` and ${plural(adults, 'adult learner')}` : ''}`,
    plural(s.prospects.length, 'prospect'),
    `${plural(s.classes.length, 'class', 'classes')} over ${plural(slots, 'session')} a week`,
    plural(enrolled, 'enrolment'),
  ]
  if (owed) bits.push(`₹${owed.toLocaleString('en-IN')} owed`)
  return `${s.name} (${s.category}, ${s.timezone}) — ${bits.join(', ')}.`
}

/* ========================================================================== *
 * BUILDING
 * ========================================================================== */

export type BuiltSpecWorld = {
  academyId: string
  /** What was written to `academy.name`: the spec's name plus the run token. */
  academyName: string
  adminContactId: string
  /** Contact id by `person.full_name`, exactly as the spec spells it. */
  contacts: Record<string, string>
  /** Everybody with a phone. `role` is the seat they were created in. */
  roster: { name: string; role: 'admin' | 'coach' | 'client' | 'prospect'; contactId: string; phone: string }[]
  /** Read back out of the database after the build. Evidence, not a tally. */
  counts: Record<string, number>
}

export type BuildOpts = {
  /**
   * This run's four characters, from the run directory's name. The academy is
   * named `<spec name> <token>`, which is what lets a world be traced back to the
   * run that made it and reaped later without touching one somebody is driving.
   */
  token: string
  log?: (line: string) => void
}

/** A SQL string literal. `q` runs `tx.unsafe`, so nothing else escapes these. */
const lit = (v: string): string => `'${v.replace(/'/g, "''")}'`

/**
 * Turn a spec into a live academy and hand back what was made.
 *
 * The ORDER here is load-bearing in two places and both were paid for elsewhere.
 * Clients are created BEFORE any class exists, because `createTestContact` enrols
 * a new client into the first active class it finds — with classes already there,
 * every parent silently joins one. And a parent's auto-created player row is
 * retired AFTER their children exist, because `count(*) from player where active`
 * is the roster figure a settled world closes with, and left in, a business with
 * five children answers nine.
 */
export async function buildWorld(spec: WorldSpec, o: BuildOpts): Promise<BuiltSpecWorld> {
  const s = validateSpec(spec)
  const log = o.log ?? (() => {})
  const token = String(o.token ?? '').trim()
  if (!/^[0-9a-z]{4}$/.test(token)) {
    throw new Error(`buildWorld needs this run's four-character token, not ${JSON.stringify(o.token)} — it is what makes a world traceable to the run that made it and safe to reap later.`)
  }
  const academyName = `${s.name} ${token}`

  const made = await createAcademy({
    name: academyName,
    adminName: s.admin.name,
    timezone: s.timezone,
    category: s.category,
  })
  const academyId = made.academyId
  const sql = <T = unknown>(text: string): Promise<T[]> => q<T>(academyId, text)
  /**
   * `inboundFromContact` walks a cached academy list, and a business created a
   * millisecond ago is not in it. The symptom is "no such contact" rather than
   * anything pointing here.
   */
  await worldAcademyIds({ refresh: true })

  const at = clock.inZone(await clock.now(academyId), s.timezone)
  log(`clock reads ${at.label} — every date below is relative to it`)

  /* ------------------------------------------------------------------ phones */

  const digits = academyId.replace(/\D/g, '').padEnd(6, '0')
  const phone = (n: number): string => `+9194${digits.slice(0, 6)}${String(n).padStart(2, '0')}`
  let seat = 0
  const nextPhone = (): string => phone(seat++)

  const adminPhone = nextPhone()
  await sql(`update contact set phone_e164 = ${lit(adminPhone)}, wa_id = ${lit(adminPhone.replace(/\D/g, ''))}
              where id = '${made.adminContactId}'::uuid`)

  const contacts: Record<string, string> = { [s.admin.name]: made.adminContactId }
  const roster: BuiltSpecWorld['roster'] = [
    { name: s.admin.name, role: 'admin', contactId: made.adminContactId, phone: adminPhone },
  ]

  /* ------------------------------------------------------------------ coaches */

  for (const cch of s.coaches) {
    const p = nextPhone()
    const c = await createTestContact({ academyId, name: cch.name, role: 'coach', phone: p })
    contacts[cch.name] = c.contactId
    roster.push({ name: cch.name, role: 'coach', contactId: c.contactId, phone: p })
    if (cch.pay !== undefined) {
      // `createTestContact` writes a coach row with no pay on it, and "what am I
      // paying everyone" is a question a settled world has to be able to answer.
      await sql(`update coach co set pay_amount = ${cch.pay}, pay_unit = ${lit(cch.unit ?? 'per_month')}
                   from person p where p.id = co.person_id and p.full_name = ${lit(cch.name)}`)
    }
  }

  /**
   * The owner with a `coach` row as well as an `academy_admin` one: two hats, one
   * `person`, which is the business this product is sold into and the one shape a
   * role column cannot express. Pay is left at zero per month deliberately — the
   * format has no field for what an owner pays himself, because through this
   * table he does not.
   */
  if (s.admin.coaches) {
    await sql(`
      insert into coach (academy_id, person_id, pay_amount, pay_unit, status, onboarded_at)
      values ('${academyId}'::uuid, '${made.adminPersonId}'::uuid, 0, 'per_month', 'active', app.now())
      on conflict do nothing`)
  }

  /* ------------------------------------------------------------------ clients */

  for (const cl of s.clients) {
    const p = nextPhone()
    const c = await createTestContact({ academyId, name: cl.name, role: 'client', phone: p })
    if (c.enrolledIn !== null) {
      throw new Error(`${cl.name} was auto-enrolled into "${c.enrolledIn}" — a class existed before the clients did, and the build order in this file is wrong.`)
    }
    contacts[cl.name] = c.contactId
    roster.push({ name: cl.name, role: 'client', contactId: c.contactId, phone: p })
  }

  for (const pr of s.prospects) {
    const p = nextPhone()
    const c = await createTestContact({ academyId, name: pr.name, role: 'prospect', phone: p })
    contacts[pr.name] = c.contactId
    roster.push({ name: pr.name, role: 'prospect', contactId: c.contactId, phone: p })
  }
  await worldAcademyIds({ refresh: true })

  /* ------------------------------------------------------------------ classes */

  /**
   * One venue, named for the business. The format has no venue field because a
   * second address changes nothing about the question this format exists to
   * answer — who is in the business, and what runs when.
   */
  const venue = s.name
  await sql(`insert into venue (academy_id, name) values ('${academyId}'::uuid, ${lit(venue)})`)

  for (const cls of s.classes) {
    await sql(`
      insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on, active)
      select '${academyId}'::uuid, ${lit(cls.name)}, v.id,
             ${cls.rate === undefined ? 'null' : cls.rate}, ${cls.rate === undefined ? 'null' : lit(cls.unit ?? 'per_month')},
             (app.now() - interval '40 days')::date, true
        from venue v where v.name = ${lit(venue)}`)
    for (const d of cls.days) {
      // `DAYS.indexOf` IS the column value — 0=Sun..6=Sat — which is why the
      // mapping is the array and not a second table beside it.
      await sql(`
        insert into class_slot (academy_id, class_id, weekday, start_time, end_time)
        select '${academyId}'::uuid, c.id, ${DAYS.indexOf(d)}, time ${lit(cls.from)}, time ${lit(cls.to)}
          from class c where c.name = ${lit(cls.name)} and c.active and c.ends_on is null`)
    }
    for (const who of cls.coaches) {
      await sql(`
        insert into class_coach (academy_id, class_id, coach_id)
        select '${academyId}'::uuid, c.id, co.id
          from class c, coach co join person p on p.id = co.person_id
         where c.name = ${lit(cls.name)} and c.active and c.ends_on is null and p.full_name = ${lit(who)}
        on conflict do nothing`)
    }
    if (!cls.coaches.length) log(`"${cls.name}" has no coach on it — every session it runs will be uncovered`)
  }

  /* ----------------------------------------------------------------- learners */

  for (const cl of s.clients) {
    for (const kid of cl.children) {
      await sql(`insert into person (academy_id, full_name) values ('${academyId}'::uuid, ${lit(kid)})`)
      await sql(`
        insert into player (academy_id, account_id, person_id, active)
        select '${academyId}'::uuid, a.id, k.id, true
          from account a join person h on h.id = a.holder_person_id, person k
         where h.full_name = ${lit(cl.name)} and k.full_name = ${lit(kid)}`)
    }
    if (!cl.children.length) continue
    /**
     * The parent is not a player.
     *
     * `createTestContact` gives every client an account AND a player over the
     * same person, which is right for an adult beginner and wrong for every
     * parent. Left in, `count(*) from player where active` answers nine for a
     * business with five children in it, and an owner asking how many kids he has
     * gets his own parents counted back at him. Retired rather than deleted, so
     * nothing already pointing at the row breaks. Done per client rather than in
     * one sweep, because a client who said `"children": []` IS the player and
     * a blanket sweep would retire them too.
     */
    await sql(`
      update player pl set active = false
        from person p, account a
       where p.id = pl.person_id and a.id = pl.account_id and a.holder_person_id = p.id
         and p.full_name = ${lit(cl.name)}`)
    await sql(`
      delete from enrollment e using player pl, account a
       where e.player_id = pl.id and a.id = pl.account_id and a.holder_person_id = pl.person_id
         and pl.person_id = (select id from person where full_name = ${lit(cl.name)} limit 1)`)
  }

  for (const cls of s.classes) {
    for (const who of cls.enrolled) {
      await sql(`
        insert into enrollment (academy_id, class_id, player_id, started_on)
        select '${academyId}'::uuid, c.id, pl.id, (app.now() - interval '35 days')::date
          from class c, player pl join person p on p.id = pl.person_id
         where c.name = ${lit(cls.name)} and c.active and c.ends_on is null
           and p.full_name = ${lit(who)} and pl.active
         limit 1`)
    }
  }

  /* ------------------------------------------------------------------ arrears */

  for (const cl of s.clients) {
    if (cl.owes === undefined || cl.owes === 0) continue
    await openingBalance(sql, academyId, s.timezone, cl.name, cl.owes)
  }

  /**
   * Live, unless there is nothing to be live about.
   *
   * `app.guard_go_live()` (0033) is a trigger, not a convention: it refuses the
   * transition for a business with no active class, because going live is what
   * starts the reminders, the digests and the announcements and an empty timetable
   * gives them nothing to be about. `BLANK` is exactly that business — one admin,
   * no classes — and it is not an edge case, it is the point of the blank world:
   * the moment BEFORE the setup conversation, which is the state the product's own
   * onboarding is written against (`lib/seed.ts`: "`onboarding_state = 'setup'` is
   * load-bearing").
   *
   * Sending the update anyway threw a `check_violation` out of the driver — after
   * thirteen inserts had already been committed, so `--world blank` left a
   * half-built academy on the shared sender and no run directory naming it. A
   * world with a timetable still goes live; a world without one is left where the
   * database says it belongs.
   */
  if (s.classes.length) {
    await sql(`update academy set onboarding_state = 'live' where id = '${academyId}'::uuid`)
  }

  /* -------------------------------------------------------------- read it back */

  const [counts] = await sql<Record<string, number>>(`
    select (select count(*) from person) people,
           (select count(*) from coach where ended_on is null) coaches,
           (select count(*) from account) accounts,
           (select count(*) from player where active) players,
           (select count(*) from contact where state = 'prospect') prospects,
           (select count(*) from class where active and ends_on is null) classes,
           (select count(*) from class_slot) slots,
           (select count(*) from class_coach) assignments,
           (select count(*) from enrollment where ended_on is null) enrolments,
           (select count(*) from tally_line) lines,
           (select coalesce(sum(amount),0) from tally_line) owed`)

  /**
   * The one claim this build cannot make from memory. Two active classes with one
   * name are ONE class and the second insert says nothing — validation refuses
   * that case, so a mismatch here means the index caught something validation did
   * not, and the world is not the world that was written down.
   */
  if (Number(counts?.classes ?? 0) !== s.classes.length) {
    throw new Error(
      `the spec has ${s.classes.length} classes and the academy has ${counts?.classes}. ` +
        `class_academy_name_active_key is unique on the active class name — one of them was swallowed.`,
    )
  }
  const wantEnrolled = s.classes.reduce((a, cls) => a + cls.enrolled.length, 0)
  if (Number(counts?.enrolments ?? 0) !== wantEnrolled) {
    throw new Error(`the spec enrols ${wantEnrolled} and the academy has ${counts?.enrolments} open enrolments.`)
  }

  log(`${academyName} — ${academyId}`)
  log(`${roster.length} phones, ${counts?.players} players, ${counts?.classes} classes over ${counts?.slots} sessions a week`)

  return {
    academyId,
    academyName,
    adminContactId: made.adminContactId,
    contacts,
    roster,
    counts: Object.fromEntries(Object.entries(counts ?? {}).map(([k, v]) => [k, Number(v)])),
  }
}

/**
 * What a family carried in from before this world existed.
 *
 * An `adjustment` in the PREVIOUS month's period, and both halves matter. The
 * kind, because the monthly job writes `monthly`/`term`/`package` lines keyed by
 * `dedupe_key` and re-derives them; nothing in the product re-derives an
 * adjustment, so this one cannot be written twice or argued with. The period,
 * because the product bills the OPEN month itself on the first drain — a fixture
 * that charges the open period gets every family's month doubled, which
 * `_world.ts` learned by telling a parent she owed ₹4,800.
 *
 * `account_standing.balance` is lifetime charges minus confirmed payments
 * (migration 0036), so this shows up as arrears the moment anybody asks.
 * `description` is shown verbatim to the parent, so it reads like something a
 * parent could be shown.
 */
async function openingBalance(
  sql: (text: string) => Promise<unknown[]>,
  academyId: string,
  timezone: string,
  holder: string,
  amount: number,
): Promise<void> {
  await sql(`
    insert into tally_line (academy_id, account_id, player_id, period, kind, description, amount, reason)
    select '${academyId}'::uuid, a.id, null,
           (date_trunc('month', app.now() at time zone ${lit(timezone)}) - interval '1 month')::date,
           'adjustment', 'Balance brought forward', ${amount},
           'opening balance, written by the world spec'
      from account a join person p on p.id = a.holder_person_id
     where p.full_name = ${lit(holder)}`)
}

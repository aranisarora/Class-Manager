/**
 * probe-model — judge a model on what the person actually got.
 *
 *   npm run probe
 *   npm run probe -- --models a,b --stage money --persona coach --case setup-small --keep
 *
 * WHY THIS WAS REWRITTEN
 * -----------------------------------------------------------------------------
 * The previous version scored one thing: did a tool name appear in round one. It
 * called `generate` directly, never ran the tools, and stopped after a single
 * round — so by construction it could not see any of the three things that
 * actually decide whether a model is good enough for this product:
 *
 *   1. WHAT THE PERSON GOT. The reply is composed in a LATER round, after tool
 *      results come back. A single-round harness never sees a sentence at all on
 *      any write turn. It cannot judge wording, buttons, or plainness.
 *   2. WHETHER IT DID WHAT IT SAID. "Did everything it promised" is a property of
 *      a whole turn — several rounds, real tool results, real rows. A harness
 *      that executes nothing can only see intent, never follow-through. And
 *      scoring `functionCalls.some(f => acts.includes(f.name))` is a name match:
 *      `plan` with garbage steps scored identically to `plan` with right ones.
 *   3. COST. Matters least and can be traded away, so it is reported and never
 *      ranked on.
 *
 * It also produced two false readings that made the old numbers untrustworthy:
 * `read-then-say` demanded a lookup for a question whose answer was already in
 * the context tail, so a correct answer scored as a miss and a wasteful extra
 * round scored as a win.
 *
 * WHAT IT DOES NOW
 * -----------------------------------------------------------------------------
 * Drives `runTurn` — the real loop, real tools, real database, real multi-round
 * behaviour — through a scripted lifecycle arc, in a FRESH ACADEMY PER MODEL so
 * no condition can see another's rows. After every turn it records the reply as
 * the person received it (post-lint, post-compose), the buttons, the full tool
 * trace, the jobs that fired, and what is actually true in the database.
 *
 * It reports evidence. It deliberately does NOT compute an overall score:
 * nothing here knows what good looks like for a particular business, and the
 * failures worth catching are the ones a person notices by reading. `score.md`
 * is written for exactly that.
 *
 * STAGES, AND WHO IS SPEAKING
 * -----------------------------------------------------------------------------
 * The arc used to stop at onboarding and only ever speak as the admin, so no
 * probe could say anything about the coach ladder, attendance, money or churn —
 * which is most of the product. It is a walk through the stages a business
 * really goes through, and every case declares who is talking:
 *
 *   onboarding → roster → go-live → session-day → attendance → money
 *              → month-end → churn
 *   admin · coach · client · prospect
 *
 * A persona other than the admin is resolved out of the database THE ARC HAS
 * BUILT — the coach the admin typed in, the parent the admin added — never from
 * a fixture. So a stage that cannot find its speaker records that and sends
 * nothing, and what it has found is a defect in the stage before it rather than
 * a gap in the harness.
 *
 * WHAT IT DOES TO A SHARED DATABASE
 * -----------------------------------------------------------------------------
 * Half of these stages are moments rather than sentences, so the arc moves domain
 * time and runs the queue. Both are shared with whatever else is driving this
 * database, and both are bounded here rather than trusted to be small:
 *
 *   - **the clock** moves in steps of at most an hour, to the next scheduled
 *     moment where there is one sooner, within a total budget, and is put back
 *     where it was found before the process exits. See `CLOCK_STEP_MS`.
 *   - **the queue** is drained for THIS academy only. See `drainOwnJobs`.
 *   - **the business** is dropped on the way out, and its jobs with it, unless
 *     `--keep`. Nothing else in the world is touched.
 *
 * ONE MODEL PER PROCESS, ON PURPOSE
 * -----------------------------------------------------------------------------
 * `lib/env.ts` memoises the parsed environment on first read and freezes it, and
 * `loop.ts` takes the model from `env.MODEL_MAIN`. So a model cannot be swapped
 * in-process without lying about which one ran. The parent spawns one child per
 * model with `MODEL_MAIN` set in its environment, which also gives every model a
 * genuinely cold prompt cache — the honest starting condition for a cost reading.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnvFiles, c } from './_env'
import { costUsd, isPeak, USD_INR } from '../lib/pricing'

const argv = process.argv.slice(2)
function flag(name: string, fallback = ''): string {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i === -1) return fallback
  const a = argv[i] as string
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? fallback)
}
const has = (name: string) => argv.includes(`--${name}`)

const MODELS = flag('models', 'deepseek-v4-flash,deepseek-v4-pro')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
/**
 * The thinking sweep — `--thinking default,off,low,high`.
 *
 * `default` is what production runs: `low` on the whole model path, settled by
 * the phase-6 arc. The others pin every turn to one level via `PROBE_THINKING`,
 * which is how the question was answered in the first place — whether
 * deliberation in a SEPARATE channel recovers the discretionary judgement that
 * zero thinking amputates (`schedule`, `remember` and `view` fired 0, 3 and 1
 * times across 93 driven zero-thinking turns; at low, `schedule` fires inline).
 *
 * One variable at a time: an arm is a whole child process with a fresh academy,
 * so a thinking arm never shares rows or a warm cache with another.
 */
const THINKING_ARMS = flag('thinking', 'default')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
/**
 * When this run happened, in UTC, and therefore which of DeepSeek's two rate
 * cards applied to it. Read once so every record in a run is priced the same way
 * and the header can say which it was.
 */
const RUN_AT = new Date()
const ONLY = flag('case')
const ONLY_STAGE = flag('stage')
const ONLY_PERSONA = flag('persona')
const OUT_DIR = flag('out', join(process.cwd(), '.probe'))

/* -------------------------------------------------------------------------- *
 * The arc
 *
 * Cases run IN ORDER against ONE academy and the state accumulates, because that
 * is the only way most of the questions can be asked at all:
 *   - follow-through is "does what it promised in turn 2 exist in turn 2"
 *   - a lookup is only a lookup once the answer has stopped being in the prompt
 *   - a watch is only discretionary once there is something worth watching
 *   - a coach can only be spoken to once somebody has hired one
 *   - a register can only be marked after a class has actually finished
 * -------------------------------------------------------------------------- */

type Check = { label: string; ok: boolean; detail: string }
type Sql = <T = any>(sql: string) => Promise<T[]>

/** The eight moments a business passes through, in the order it passes them. */
const STAGES = [
  'onboarding', 'roster', 'go-live', 'session-day', 'attendance', 'money', 'month-end', 'churn',
] as const
type Stage = (typeof STAGES)[number]

const PERSONAS = ['admin', 'coach', 'client', 'prospect'] as const
type Persona = (typeof PERSONAS)[number]

// A misspelt filter silently selects nothing, and a run that probed nothing
// reports nothing wrong — the same shape as the harness trap in DRIVING.md.
if (ONLY_STAGE && !(STAGES as readonly string[]).includes(ONLY_STAGE)) {
  console.error(c.red(`no stage "${ONLY_STAGE}" — one of ${STAGES.join(', ')}`))
  process.exit(2)
}
if (ONLY_PERSONA && !(PERSONAS as readonly string[]).includes(ONLY_PERSONA)) {
  console.error(c.red(`no persona "${ONLY_PERSONA}" — one of ${PERSONAS.join(', ')}`))
  process.exit(2)
}

type Case = {
  name: string
  stage: Stage
  /** Whose phone this message comes from. Resolved against the arc's own rows. */
  persona: Persona
  /** Narrows the persona when the arc has built more than one — a name fragment. */
  who?: string
  what: string
  text: string
  /** Reaching for none of these is a tool-choice failure worth naming. */
  wants: string[]
  /**
   * The instant this case needs the world to be at, as SQL returning one `at`
   * column. Null means "the clock is already where this case wants it".
   */
  clock?: (q: Sql) => Promise<string | null>
  /**
   * If the turn ends on a confirmation, tap it — the button whose title matches.
   *
   * Not optional decoration. §14.2 sends anything destructive, money-shaped or
   * touching more than one person down preview → tap, so a harness that only ever
   * types measures the half of the product that needs no permission. Driven
   * without this, `go-live` staged a correct plan into a correct button and the
   * business stayed at `setup`, which quietly made every stage after it a probe of
   * a business that had not launched.
   *
   * Declaring it does NOT require one: a model that committed directly is right to
   * have, and gets `nothing to tap` recorded rather than a failure.
   *
   * Which button is the affirmative is decided by the ACTION KIND, not the title.
   * Titles were tried first and are not stable enough to tap on: the same case
   * offered `[Confirm Payment]` on one run and `[Record Payment]` on the next, so an
   * allow-list either misses the confirmation or grows until it is one word away
   * from matching `[Cancel]`. The kind is structural — a staged plan travels in the
   * button as `steps` or `operation` (§2.2), and the refusal is always a `noop`.
   */
  tap?: true
  /** What must actually be true afterwards. Empty for pure-conversation turns. */
  expect: (q: Sql, ctx: CaseCtx) => Promise<Check[]>
}

/**
 * What a check needs to ask about THIS turn rather than about the world.
 *
 * `startedAt` is host time, the same clock `created_at` defaults to — deliberately
 * not domain time, because the sim clock moves and a cursor that moves with it
 * cannot separate what a turn wrote from what the arc wrote an hour ago.
 */
type CaseCtx = { startedAt: string; contactId: string }

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/** A check whose detail is the rows themselves, so a failure is readable. */
function check(label: string, ok: boolean, detail: unknown): Check {
  return { label, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }
}

/** The single `at` column a `clock` target returns, or null if there is none. */
async function firstAt(q: Sql, sql: string): Promise<string | null> {
  const rows = await q<{ at: string | null }>(sql)
  return rows[0]?.at ? String(rows[0].at) : null
}

/* -------------------------------------------------------------------------- *
 * Invariants — run after EVERY case, whatever the case was about
 *
 * The obvious way to keep a harness honest is a case per bug, and it is the way
 * that rots: the file grows monotonically, each case exercises one sentence, and
 * after a dozen rounds nobody runs the thing because it takes an hour. It also
 * tests the wrong thing — a case reproduces the *instance*, and every finding in
 * the retired ledger is filed as a class precisely because the instance is not
 * the point.
 *
 * These are statements about the world that must hold no matter what was said.
 * They cost one query each, they run against whatever state the arc has built by
 * then, and a defect anywhere in the class trips them — including from a sentence
 * nobody thought to write a case for. Four findings from an earlier round are
 * caught here by three checks, none of which mentions the sentence that produced it.
 *
 * The bar for adding one: it must be a property of the data or the outbound
 * record, true for every business, checkable in SQL, and false today only if
 * something is actually wrong. Anything needing a specific prompt is a case, not
 * an invariant — and should probably fold into one of the cases that exist.
 *
 * Every query below is tenant-scoped by RLS, because `q` pins the session to this
 * probe's own academy. `job` is the one table that is NOT — it is global and
 * carries its academy in the payload (§6.6) — so anything asking about jobs has
 * to say so itself, which is exactly what the `discretionary` case got wrong.
 * -------------------------------------------------------------------------- */

const INVARIANTS: { label: string; run: (q: Sql) => Promise<Check> }[] = [
  {
    // F6. A class whose slots are all Saturday cannot begin on a Sunday, or its
    // first week silently does not exist — the calendar looks right and the
    // sessions are simply absent.
    label: 'every class starts on one of its own weekdays',
    run: async (q) => {
      const bad = await q(`
        select c.name, c.starts_on::text,
               extract(dow from c.starts_on)::int as start_dow,
               array_agg(distinct cs.weekday order by cs.weekday) as slot_days
          from class c join class_slot cs on cs.class_id = c.id
         group by c.id, c.name, c.starts_on
        having not (extract(dow from c.starts_on)::int = any(array_agg(cs.weekday)))`)
      return check('every class starts on one of its own weekdays', bad.length === 0, bad)
    },
  },
  {
    // F7. One human is one person row. Two rows with the same name in one
    // business is either a duplicate or two people the product cannot tell
    // apart — both are defects and neither has ever been visible.
    label: 'no two people share a name',
    run: async (q) => {
      const bad = await q(`
        select lower(btrim(full_name)) as name, count(*)::int as n
          from person group by 1 having count(*) > 1`)
      return check('no two people share a name', bad.length === 0, bad)
    },
  },
  {
    // F7 again, from the other side: a player and their account holder being the
    // same human is the self-payer, which is correct. A player whose person has
    // the same NAME as the holder but a different id is the bug.
    label: 'no player is a duplicate of their own account holder',
    run: async (q) => {
      const bad = await q(`
        select ph.full_name as player, ah.full_name as holder
          from player pl
          join person ph on ph.id = pl.person_id
          join account a on a.id = pl.account_id
          join person ah on ah.id = a.holder_person_id
         where ph.id <> ah.id
           and lower(btrim(ph.full_name)) = lower(btrim(ah.full_name))`)
      return check('no player is a duplicate of their own account holder', bad.length === 0, bad)
    },
  },
  {
    // F4/F5. Repetition is invisible in a transcript read one message at a time
    // and obvious in one query. Scoped to what actually went out.
    label: 'nobody was told the same thing twice',
    run: async (q) => {
      const bad = await q(`
        select contact_id, left(body, 60) as body, count(*)::int as n
          from message
         where direction = 'outbound' and suppressed_reason is null and btrim(body) <> ''
         group by contact_id, body having count(*) > 1`)
      return check('nobody was told the same thing twice', bad.length === 0, bad)
    },
  },
  {
    // F8. Operator vocabulary is correct for an admin and wrong for everybody
    // else, and the receipt is minted once and replayed to whoever taps. This
    // catches the shape rather than the string: a row count opening a sentence.
    label: 'no row-counting receipt reached a non-admin',
    run: async (q) => {
      const bad = await q(`
        select p.full_name, left(m.body, 80) as body
          from message m
          join contact ct on ct.id = m.contact_id
          join person p on p.id = ct.person_id
         where m.direction = 'outbound' and m.suppressed_reason is null
           and m.body ~* '^(changed|added|removed|updated) [0-9]+ '
           and not exists (select 1 from academy_admin aa where aa.person_id = ct.person_id)`)
      return check('no row-counting receipt reached a non-admin', bad.length === 0, bad)
    },
  },
  {
    // §2.2 and §14.6. A JSON blob in the prose and a link pasted as text are the
    // two ways a message arrives looking broken; both are structural, so both
    // belong here rather than in anybody's eyes.
    //
    // wa.me and friends are exempt, and that is not a loophole: §8.1's invite is a
    // link the admin FORWARDS, so there the text is the artifact and a button would
    // destroy it. Same predicate as `isForwardableLink` in `messaging/types.ts` —
    // if that one changes, this must too, which is the cost of stating it twice and
    // is cheaper than a harness that fails on every correct invite.
    label: 'no message carries raw structure or a bare url',
    run: async (q) => {
      const bad = await q(`
        select left(body, 80) as body from message
         where direction = 'outbound' and suppressed_reason is null
           and (body like '%"buttons"%'
                or body ~* 'https?://(?!wa\\.me|api\\.whatsapp\\.com|chat\\.whatsapp\\.com)')`)
      return check('no message carries raw structure or a bare url', bad.length === 0, bad)
    },
  },
  {
    // §2.6 — "building the roster messages nobody". The send path already refuses
    // this (gate 3 in `messaging/send.ts`), so a row here is a leak past a gate
    // rather than a model that spoke out of turn, which is the interesting case.
    //
    // Solicited replies are exempt for the reason the gate exempts them: answering
    // somebody who wrote in first is not the bot reaching out. And the whole check
    // scopes ITSELF to a business that has not gone live, because after go-live a
    // message sent before it is indistinguishable from one sent after.
    label: 'nothing unsolicited reached a non-admin before go-live',
    run: async (q) => {
      const bad = await q(`
        select p.full_name, left(m.body, 60) as body
          from message m
          join contact ct on ct.id = m.contact_id
          join person p on p.id = ct.person_id
         where m.direction = 'outbound' and m.suppressed_reason is null and not m.solicited
           and (select onboarding_state from academy) <> 'live'
           and not exists (select 1 from academy_admin aa where aa.person_id = ct.person_id)`)
      return check('nothing unsolicited reached a non-admin before go-live', bad.length === 0, bad)
    },
  },
  {
    // R4/R7. Enrolling somebody who is already enrolled writes a second open row
    // rather than failing, so the roster looks right and every per-month billing
    // run charges the family twice. Nothing in the schema forbids it, which is why
    // it has to be asked here.
    label: 'nobody is enrolled in the same class twice',
    run: async (q) => {
      const bad = await q(`
        select p.full_name as who, cl.name as class, count(*)::int as n
          from enrollment e
          join player pl on pl.id = e.player_id
          join person p on p.id = pl.person_id
          join class cl on cl.id = e.class_id
         where e.ended_on is null
         group by p.full_name, cl.name having count(*) > 1`)
      return check('nobody is enrolled in the same class twice', bad.length === 0, bad)
    },
  },
  {
    // §6.7 — money follows the account, and the account is the player's own. A
    // line billed to some other account is a family paying for a child that is not
    // theirs, and the only place it shows up is the tally, once a month, in money.
    label: 'every charge is billed to the account that holds the player',
    run: async (q) => {
      const bad = await q(`
        select p.full_name as who, t.description, t.amount::text
          from tally_line t
          join player pl on pl.id = t.player_id
          join person p on p.id = pl.person_id
         where t.account_id <> pl.account_id`)
      return check('every charge is billed to the account that holds the player', bad.length === 0, bad)
    },
  },
  {
    // R10, in the one place it is checkable in SQL. A register marked for a class
    // that has not happened yet is the calendar-versus-recurrence confusion writing
    // itself into attendance, and from there into money. A timely cancellation is
    // the one attendance status that legitimately lands on a future session.
    label: 'no register was marked for a class that has not happened',
    run: async (q) => {
      const bad = await q(`
        select p.full_name as who, a.status, s.starts_at::text
          from attendance a
          join session s on s.id = a.session_id
          join player pl on pl.id = a.player_id
          join person p on p.id = pl.person_id
         where a.status <> 'cancelled_timely' and s.starts_at > app.now()`)
      return check('no register was marked for a class that has not happened', bad.length === 0, bad)
    },
  },
  {
    // R6 — what the product records is narrower than what it changes. A payment
    // that says `confirmed` and cannot say when is a number in a tally with no
    // evidence behind it, and the person it hurts is the one who paid.
    label: 'every confirmed payment records when it was confirmed',
    run: async (q) => {
      const bad = await q(`
        select id::text, amount::text, rail, reference
          from payment where status = 'confirmed' and confirmed_at is null`)
      return check('every confirmed payment records when it was confirmed', bad.length === 0, bad)
    },
  },
  {
    // §11.2. Opting out is the one promise that cannot be half-kept, and the
    // failure is silent to everyone except the person who asked to be left alone.
    label: 'nobody was messaged after they opted out',
    run: async (q) => {
      const bad = await q(`
        select p.full_name, left(m.body, 60) as body, m.created_at::text
          from message m
          join contact ct on ct.id = m.contact_id
          join person p on p.id = ct.person_id
         where m.direction = 'outbound' and m.suppressed_reason is null
           and ct.opted_out_at is not null and m.created_at > ct.opted_out_at`)
      return check('nobody was messaged after they opted out', bad.length === 0, bad)
    },
  },
]

async function runInvariants(q: Sql): Promise<Check[]> {
  const out: Check[] = []
  for (const inv of INVARIANTS) {
    try {
      out.push(await inv.run(q))
    } catch (e) {
      out.push(check(inv.label, false, `invariant query failed: ${(e as Error)?.message ?? String(e)}`))
    }
  }
  return out
}

const CASES: Case[] = [
  /* ---- onboarding -------------------------------------------------------- */
  {
    name: 'setup-small',
    stage: 'onboarding',
    persona: 'admin',
    what: 'one class, one sentence — the commonest onboarding turn there is',
    text: 'add a beginners batch mon wed fri 6.30 to 7.30pm at green park, 1500 a month',
    wants: ['act', 'plan'],
    tap: true,
    expect: async (q) => {
      const venues = await q(`select name from venue`)
      const classes = await q(`select id, name from class where active`)
      const beginners = classes.find((r: any) => norm(r.name).includes('beginner'))
      const slots = beginners
        ? await q(
            `select weekday, start_time::text, end_time::text from class_slot
              where class_id = '${beginners.id}'::uuid order by weekday`,
          )
        : []
      const sessions = beginners
        ? await q(`select count(*)::int as n from session where class_id = '${beginners.id}'::uuid`)
        : [{ n: 0 }]
      // 6.30pm written as "6.30" is the exact shape that produced a 06:30 class
      // in the database and a "6:30pm" read-back in the reply. Both halves
      // confident, one of them wrong (the C-series).
      const pm = slots.every((s: any) => String(s.start_time).startsWith('18:'))
      return [
        check('venue "green park" exists', venues.some((v: any) => norm(v.name).includes('green park')), venues),
        check('a beginners class exists', Boolean(beginners), classes),
        check('3 weekly slots, Mon/Wed/Fri', slots.length === 3 && [1, 3, 5].every((d) => slots.some((s: any) => Number(s.weekday) === d)), slots),
        check('start time is 18:30, not 06:30', slots.length > 0 && pm, slots.map((s: any) => `${s.start_time}-${s.end_time}`)),
        // `create_class` does not write sessions; it enqueues `materialize_sessions`
        // and the job writes them. Nothing in this harness used to run jobs, so this
        // check asked for a row only the runner can create and reported every model
        // as having failed to create it. The turn loop now drains this academy's own
        // queue, which is what the emulator's tick does, so the question is real again.
        check('sessions were scheduled', Number(sessions[0]?.n ?? 0) > 0, `${sessions[0]?.n ?? 0} sessions`),
      ]
    },
  },
  {
    name: 'lost',
    stage: 'onboarding',
    persona: 'admin',
    what: '"sorry what do i do now" — found more often than any well-formed instruction',
    text: 'sorry what do i do now',
    wants: [],
    expect: async () => [],
  },

  /* ---- roster ------------------------------------------------------------ */
  {
    name: 'compose-big',
    stage: 'roster',
    persona: 'admin',
    what: 'the follow-through test — several classes, families and enrolments in one sentence',
    text:
      'also add advanced sat 8 to 10am at green park 2500 a month. families: meera iyer +919880077889 ' +
      'with her son aarav who is 9, and kiran shah +919880099001 with two kids ananya 11 and dev 7. ' +
      'put aarav and ananya in beginners and dev in advanced.',
    wants: ['act', 'plan'],
    tap: true,
    expect: async (q) => {
      const classes = await q(`select id, name from class where active`)
      const advanced = classes.find((r: any) => norm(r.name).includes('advanc'))
      const slots = advanced
        ? await q(`select weekday, start_time::text, end_time::text from class_slot where class_id = '${advanced.id}'::uuid`)
        : []
      const people = await q(`select full_name from person`)
      const players = await q(`select pl.id, p.full_name from player pl join person p on p.id = pl.person_id where pl.active`)
      const enrol = await q(
        `select p.full_name as who, cl.name as class from enrollment e
           join player pl on pl.id = e.player_id
           join person p on p.id = pl.person_id
           join class cl on cl.id = e.class_id
          where e.ended_on is null`,
      )
      const named = (list: any[], field: string, want: string) => list.some((r: any) => norm(r[field]).includes(want))
      const enrolled = (who: string, cls: string) =>
        enrol.some((r: any) => norm(r.who).includes(who) && norm(r.class).includes(cls))
      return [
        check('advanced class exists', Boolean(advanced), classes.map((r: any) => r.name)),
        check('advanced is Sat 08:00–10:00', slots.some((s: any) => Number(s.weekday) === 6 && String(s.start_time).startsWith('08:')), slots),
        check('meera iyer exists', named(people, 'full_name', 'meera'), people.map((r: any) => r.full_name)),
        check('kiran shah exists', named(people, 'full_name', 'kiran'), people.map((r: any) => r.full_name)),
        check('player aarav exists', named(players, 'full_name', 'aarav'), players.map((r: any) => r.full_name)),
        check('player ananya exists', named(players, 'full_name', 'ananya'), players.map((r: any) => r.full_name)),
        check('player dev exists', named(players, 'full_name', 'dev'), players.map((r: any) => r.full_name)),
        check('aarav → beginners', enrolled('aarav', 'beginner'), enrol),
        check('ananya → beginners', enrolled('ananya', 'beginner'), enrol),
        check('dev → advanced', enrolled('dev', 'advanc'), enrol),
      ]
    },
  },
  {
    name: 'hire-coach',
    stage: 'roster',
    persona: 'admin',
    what: 'the only sentence in the arc that makes a coach, and every later coach stage depends on it',
    text: 'arjun menon takes the classes for me, his number is +919880033221, 500 a session. put him on the beginners batch.',
    wants: ['act', 'plan'],
    tap: true,
    expect: async (q) => {
      const coaches = await q(
        `select co.id, co.status, co.pay_amount::text, p.full_name, ct.phone_e164
           from coach co
           join person p on p.id = co.person_id
           left join contact ct on ct.person_id = p.id`,
      )
      const arjun = coaches.find((r: any) => norm(r.full_name).includes('arjun'))
      const linked = arjun
        ? await q(`select cl.name from class_coach cc join class cl on cl.id = cc.class_id
                    where cc.coach_id = '${arjun.id}'::uuid`)
        : []
      return [
        check('a coach called arjun exists', Boolean(arjun), coaches),
        // A coach with no contact row cannot be asked anything, which makes every
        // §8.2 rung unreachable and shows up nowhere until the ladder is silent.
        check('the coach has a number to be reached on', Boolean(arjun?.phone_e164), arjun ?? coaches),
        check('the coach is on a class', linked.length > 0, linked),
      ]
    },
  },
  {
    name: 'daily-batch',
    stage: 'roster',
    persona: 'admin',
    what:
      'a class that runs every day — the only way the stages after go-live sit inside the clock budget, ' +
      'and a real thing to ask for',
    text:
      'one more: an evening fitness batch every day 7 to 8pm at green park, 2000 a month, arjun takes that one too. ' +
      'put aarav, ananya and dev in it.',
    wants: ['act', 'plan'],
    tap: true,
    expect: async (q) => {
      const classes = await q(`select id, name from class where active`)
      const daily = classes.find((r: any) => norm(r.name).includes('fitness'))
      const slots = daily ? await q(`select weekday from class_slot where class_id = '${daily.id}'::uuid`) : []
      const sessions = daily
        ? await q(`select count(*)::int as n from session where class_id = '${daily.id}'::uuid and starts_at > app.now()`)
        : [{ n: 0 }]
      const roster = daily
        ? await q(`select p.full_name from enrollment e
                     join player pl on pl.id = e.player_id
                     join person p on p.id = pl.person_id
                    where e.class_id = '${daily.id}'::uuid and e.ended_on is null`)
        : []
      const coached = daily
        ? await q(`select count(*)::int as n from class_coach where class_id = '${daily.id}'::uuid`)
        : [{ n: 0 }]
      return [
        check('a fitness class exists', Boolean(daily), classes.map((r: any) => r.name)),
        check('it runs all seven days', slots.length === 7, slots.map((s: any) => s.weekday)),
        check('it has upcoming sessions', Number(sessions[0]?.n ?? 0) > 0, `${sessions[0]?.n ?? 0} ahead`),
        check('three players are in it', roster.length === 3, roster.map((r: any) => r.full_name)),
        check('a coach is on it', Number(coached[0]?.n ?? 0) > 0, coached),
      ]
    },
  },
  {
    name: 'lookup',
    stage: 'roster',
    persona: 'admin',
    what: 'a question whose answer is NOT in the prompt tail, so it needs a real read',
    text: 'which of my classes has nobody in it yet?',
    wants: ['read'],
    expect: async () => [],
  },
  {
    name: 'discretionary',
    stage: 'roster',
    persona: 'admin',
    what: 'the open question — does the non-obvious tool ever fire?',
    text: 'keep an eye on the advanced batch and tell me on friday if nobody else has joined it',
    wants: ['schedule'],
    expect: async (q, ctx) => {
      /**
       * `job` is the one GLOBAL table in the product: no `academy_id` column, an
       * RLS policy of `using (true)` for cm_service, and the tenant carried in the
       * payload (§6.6). This check used to be `where kind is not null` — a column
       * declared `not null` in 0002 — over every row in that global table. So it
       * passed whenever anything anywhere in the world had ever queued a job,
       * including the `materialize_sessions` this arc queues two cases earlier and
       * every job belonging to every other business in the database. The one
       * question it exists to answer went unanswered while reporting a pass.
       *
       * Three predicates, and all three are load-bearing. `agent_task` is the kind
       * `schedule` mints and the only kind a person can ask for. The academy makes
       * it this business's. And the cursor makes it THIS turn's: reflection schedules
       * watches of its own on any turn in the arc, so without it an earlier case's
       * watch answers this case's question.
       */
      const mine = await q(
        `select kind, run_at::text, dedupe_key, payload->>'instruction' as instruction
           from job
          where kind = 'agent_task' and payload->>'academy_id' = app.academy_id()::text
            and created_at >= '${ctx.startedAt}'::timestamptz
          order by run_at limit 10`,
      )
      return [check('this turn scheduled a watch', mine.length > 0, mine)]
    },
  },

  /* ---- go-live ----------------------------------------------------------- */
  {
    name: 'go-live',
    stage: 'go-live',
    persona: 'admin',
    what: 'the switch nothing else in the product can be reached without',
    text: "that's everything in. fees come by upi to probe@upi. switch it on.",
    wants: ['act', 'plan'],
    tap: true,
    expect: async (q) => {
      const a = await q(`select onboarding_state, upi_handle from academy`)
      return [
        check('the business is live', norm(a[0]?.onboarding_state) === 'live', a),
        check('there is somewhere to pay', Boolean(a[0]?.upi_handle), a),
      ]
    },
  },
  {
    name: 'stranger',
    stage: 'go-live',
    persona: 'prospect',
    what: 'somebody with no role at all, asking the question a stranger actually asks',
    text: 'hi is this the badminton place? my daughter is 9 — would the beginners batch suit her?',
    wants: [],
    expect: async (q, ctx) => {
      // Silence is the one outcome a reader of a transcript cannot tell apart from
      // a bad answer, and a case with no checks reports it as a clean pass. Whether
      // the answer is any good is what the evidence file is for; whether there WAS
      // one is a row.
      const said = await q(
        `select left(body, 80) as body, suppressed_reason from message
          where contact_id = '${ctx.contactId}'::uuid and direction = 'outbound'
            and created_at >= '${ctx.startedAt}'::timestamptz`,
      )
      return [
        check(
          'the stranger was answered at all',
          said.some((m: any) => !m.suppressed_reason && String(m.body ?? '').trim()),
          said,
        ),
      ]
    },
  },

  /* ---- session-day ------------------------------------------------------- */
  {
    name: 'coach-confirms',
    stage: 'session-day',
    persona: 'coach',
    what: '§8.2 from the coach\'s side — was he asked at all, and does answering stick?',
    // Five minutes before the doors open, walked to in steps, so the T-60 prompt
    // and the T-30 nudge each get a moment where they are the thing that is due.
    clock: (q) =>
      firstAt(q, `select (min(starts_at) - interval '5 minutes')::text as at
                    from session where status = 'scheduled' and starts_at > app.now()`),
    text: "yes I'm coming",
    wants: [],
    // A coach's first answer arrives with `[Looks right]` on it (onboarding.md,
    // "the coach's first run"), and that button is what actually makes them active
    // — so the confirmation is the operation here, not an acknowledgement of it.
    tap: true,
    expect: async (q) => {
      const asked = await q(`
        select m.catalog_id, left(m.body, 60) as body
          from message m
          join contact ct on ct.id = m.contact_id
          join coach co on co.person_id = ct.person_id
         where m.direction = 'outbound' and m.suppressed_reason is null
         order by m.created_at desc limit 5`)
      const sc = await q(`
        select s.starts_at::text, sc.confirmed_at::text, sc.declined_at::text
          from session_coach sc join session s on s.id = sc.session_id
         where s.starts_at > app.now() order by s.starts_at limit 1`)
      return [
        check('the coach had been told about the day at all', asked.length > 0, asked),
        check('the next session is confirmed', Boolean(sc[0]?.confirmed_at), sc),
      ]
    },
  },

  {
    name: 'hinglish-cancel',
    stage: 'session-day',
    persona: 'admin',
    /**
     * **The one capability regression this migration risks, and the arc never
     * asked about it.**
     *
     * Bangalore admins do not type textbook English. "kal 6 baje wali beginners
     * class cancel kar do" is Hinglish in Latin script with the verb at the end,
     * a Hindi time word ("6 baje"), a relative day ("kal") that has to be
     * resolved against the tenant's clock, and the English class name embedded in
     * the middle of it. An arc made entirely of well-formed English sentences
     * would report a clean pass on a model that cannot read half of what this
     * product is actually sent. (Settled live: comprehension was flawless in
     * every phase-6 arm.)
     *
     * The checks are deliberately about the ROW, not the reply: a warm
     * acknowledgement over an uncancelled session is precisely the failure this
     * case exists to catch, and it is the one a reader of the transcript would
     * miss.
     */
    what: 'Hinglish, in Latin script — the way an admin in Bangalore actually types',
    // Positioned the day BEFORE a scheduled session, so "kal" has an unambiguous
    // referent and resolving it wrongly is visible rather than lucky.
    clock: (q) =>
      firstAt(q, `select (min(starts_at) - interval '20 hours')::text as at
                    from session where status = 'scheduled' and starts_at > app.now()`),
    text: 'kal 6 baje wali beginners class cancel kar do',
    wants: ['act', 'plan'],
    tap: true,
    expect: async (q) => {
      const cancelled = await q(
        `select s.starts_at::text, s.status, cl.name
           from session s join class cl on cl.id = s.class_id
          where s.status = 'cancelled' and s.starts_at > app.now()`,
      )
      const still = await q(
        `select s.starts_at::text, s.status, cl.name
           from session s join class cl on cl.id = s.class_id
          where s.status = 'scheduled' and s.starts_at > app.now()
          order by s.starts_at limit 3`,
      )
      const beginners = cancelled.filter((r: any) => norm(r.name).includes('beginner'))
      return [
        check('a beginners session was cancelled', beginners.length > 0, { cancelled, still }),
        // "kal" is tomorrow, not "every beginners session from here on". A model
        // that cancels the class rather than the sitting is a worse failure than
        // one that does nothing, because it is silent and it is retrospective.
        check('exactly one session was cancelled, not the run of them', cancelled.length === 1, cancelled),
      ]
    },
  },

  /* ---- attendance -------------------------------------------------------- */
  {
    name: 'coach-marks-register',
    stage: 'attendance',
    persona: 'coach',
    what: 'the register, typed rather than tapped — the one affordance `drive tap` cannot reach',
    // Just past the end of the class that has only just finished, so
    // `post_class_register` is due and the register is a live question.
    clock: (q) =>
      firstAt(q, `select (min(ends_at) + interval '5 minutes')::text as at
                    from session where status = 'scheduled' and ends_at > app.now()`),
    // Aarav rather than a class name on purpose: he is in every class this arc
    // builds, so whichever one finished first, the sentence is about somebody who
    // was actually on that register. Naming the class would make the case pass or
    // fail on which class the model happened to schedule first.
    text: 'the class just finished — everyone was there except aarav',
    wants: ['act', 'plan'],
    tap: true,
    expect: async (q) => {
      const ended = await q(`select id, ends_at::text from session where ends_at <= app.now()
                              order by ends_at desc limit 1`)
      const s = ended[0]
      const marked = s
        ? await q(`select p.full_name as who, a.status from attendance a
                     join player pl on pl.id = a.player_id
                     join person p on p.id = pl.person_id
                    where a.session_id = '${s.id}'::uuid order by p.full_name`)
        : []
      const roster = s
        ? await q(`select p.full_name as who from session se
                     join enrollment e on e.class_id = se.class_id and e.ended_on is null
                     join player pl on pl.id = e.player_id and pl.active
                     join person p on p.id = pl.person_id
                    where se.id = '${s.id}'::uuid order by p.full_name`)
        : []
      const aarav = marked.find((r: any) => norm(r.who).includes('aarav'))
      const absent = marked.filter((r: any) => norm(r.status) === 'absent')
      return [
        check('a class has actually finished', Boolean(s), ended),
        // A register that marked some of the roster is worse than one that marked
        // none: the missing names are silently billed as if they were never due.
        check('the whole register was marked', roster.length > 0 && marked.length === roster.length, { marked, roster }),
        check('aarav is down as absent', norm(aarav?.status) === 'absent', marked),
        check('nobody else was marked absent', marked.length > 0 && absent.length === 1, absent),
      ]
    },
  },

  /* ---- money ------------------------------------------------------------- */
  {
    name: 'client-asks-balance',
    stage: 'money',
    persona: 'client',
    who: 'meera',
    what: 'a parent asking the one question parents ask, which needs a read and a number',
    text: 'hi, how much do i owe you this month?',
    wants: ['read'],
    expect: async (q) => {
      // Not a check on the reply — that is what the evidence file is for. This is
      // the precondition: if nothing was ever billed, an answer of "nothing" is
      // correct and the case has measured the billing run, not the model.
      const lines = await q(`
        select ac.display_name, tl.kind, tl.description, tl.amount::text
          from tally_line tl join account ac on ac.id = tl.account_id`)
      return [check('there is something on the tally to be asked about', lines.length > 0, lines)]
    },
  },
  {
    name: 'admin-records-payment',
    stage: 'money',
    persona: 'admin',
    what: 'rail 1: the admin attests, and money is the one place a silent no-op is unforgivable',
    text: 'meera paid 2000 by upi just now, reference UPI/2026/PR/9001',
    wants: ['act', 'plan'],
    tap: true,
    expect: async (q) => {
      const paid = await q(`
        select ac.display_name, p.amount::text, p.status, p.reference,
               p.confirmed_at::text, p.confirmed_by::text
          from payment p join account ac on ac.id = p.account_id`)
      const meera = paid.find((r: any) => norm(r.display_name).includes('meera'))
      return [
        check('a payment exists against meera', Boolean(meera), paid),
        check('it is 2000', Number(meera?.amount ?? 0) === 2000, meera ?? paid),
        check('it is confirmed, not merely requested', norm(meera?.status) === 'confirmed', meera ?? paid),
        check('the reference was kept', String(meera?.reference ?? '').includes('9001'), meera ?? paid),
      ]
    },
  },

  /* ---- month-end --------------------------------------------------------- */
  {
    name: 'month-end-statement',
    stage: 'month-end',
    persona: 'admin',
    // The `month_end_tally` JOB fires on the 1st, which is up to a month away and
    // therefore outside the clock budget by design — a probe that hopped to it
    // would be the exact trap DRIVING.md names. What is reachable is the question
    // the admin asks on the way there, answered off the same rows the job reads.
    what: 'what everybody owes, read off the tally rather than off the recurrence (R10)',
    text: 'who owes me money this month, and how much altogether?',
    wants: ['read'],
    expect: async (q) => {
      const owed = await q(`
        select ac.display_name,
               coalesce(sum(tl.amount), 0)::text as billed,
               coalesce((select sum(p.amount) from payment p
                          where p.account_id = ac.id and p.status = 'confirmed'), 0)::text as paid
          from account ac left join tally_line tl on tl.account_id = ac.id
         group by ac.id, ac.display_name order by ac.display_name`)
      return [check('the accounts have balances to report', owed.length > 0, owed)]
    },
  },

  /* ---- churn ------------------------------------------------------------- */
  {
    name: 'client-leaves',
    stage: 'churn',
    persona: 'client',
    who: 'meera',
    what: 'leaving is an end date, never a delete (§8.3) — and the history has to survive it',
    text: 'we are stopping after this month. please take aarav out of the fitness batch.',
    wants: ['act', 'plan'],
    tap: true,
    expect: async (q) => {
      const enrol = await q(`
        select p.full_name as who, cl.name as class, e.ended_on::text
          from enrollment e
          join player pl on pl.id = e.player_id
          join person p on p.id = pl.person_id
          join class cl on cl.id = e.class_id
         order by p.full_name`)
      const aaravFitness = enrol.filter(
        (r: any) => norm(r.who).includes('aarav') && norm(r.class).includes('fitness'),
      )
      const history = await q(`select count(*)::int as n from tally_line`)
      return [
        check('aarav is out of fitness', aaravFitness.length > 0 && aaravFitness.every((r: any) => r.ended_on), enrol),
        check('his other classes are untouched', enrol.some((r: any) => norm(r.who).includes('aarav') && !r.ended_on), enrol),
        check('the money history survived', Number(history[0]?.n ?? 0) > 0, history),
      ]
    },
  },
  {
    name: 'opt-out',
    stage: 'churn',
    persona: 'client',
    who: 'meera',
    what: 'the one promise that cannot be half-kept',
    text: 'please stop messaging me now',
    wants: ['act', 'plan'],
    tap: true,
    expect: async (q) => {
      const out = await q(`
        select p.full_name, ct.state, ct.opted_out_at::text
          from contact ct join person p on p.id = ct.person_id
         where ct.opted_out_at is not null`)
      return [check('somebody is actually marked opted out', out.length > 0, out)]
    },
  },
  {
    name: 'churn-after',
    stage: 'churn',
    persona: 'admin',
    // Runs last on purpose: it drains the queue once more with an opted-out contact
    // on the roster, so the opt-out invariant is asked about a world where the jobs
    // that would have messaged her have had their chance to.
    what: 'the admin asks after the fact, and the queue gets one more go with an opt-out in place',
    text: 'has anyone left this month?',
    wants: ['read'],
    expect: async () => [],
  },
]

/* -------------------------------------------------------------------------- *
 * Reply quality, as evidence rather than as a grade.
 *
 * Every one of these is a string operation on what the person received, and each
 * corresponds to a repair `lib/agent/lint.ts` already makes — so a hit here is a
 * leak past a layer built to stop it, which is worth seeing.
 * -------------------------------------------------------------------------- */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const MARKDOWN_RE = /(\*\*|^#{1,6}\s|\[[^\]\n]+\]\()/m
const ISO_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?\b/
const JARGON_RE = /\b(academy|roster|onboarding|setup phase|the system|database|record|entity|uuid|payload)\b/i
const URL_RE = /https?:\/\//
const PAST_TENSE_RE =
  /\b(?:i(?:'ve| have)\s+(?:just\s+|now\s+)?(?:added|created|set|made|booked|updated|enrolled|scheduled|recorded)|that'?s (?:done|set up|sorted|added|created)|all (?:done|set up|sorted))\b/i

type OneMessage = { body: string; buttons: string[]; link: boolean; list: boolean; suppressed: string | null }

type ReplyReport = {
  body: string
  words: number
  buttons: string[]
  list: boolean
  link: boolean
  suppressed: string | null
  /**
   * Every outbound attempt this turn made, suppressed ones included.
   *
   * The last surviving message is what the person read, but it is not the whole
   * story: a turn that composed the same message twice — once illegally, once
   * bare — cost two rounds and looks identical from the outside to a turn that
   * got it right first time. That difference is the thing being measured.
   */
  all: OneMessage[]
  flags: string[]
}

function readReply(msgs: any[]): ReplyReport {
  const all: OneMessage[] = msgs.map((m) => ({
    body: String(m?.body ?? ''),
    buttons: Array.isArray(m?.payload?.buttons) ? m.payload.buttons.map((b: any) => String(b?.title ?? '')) : [],
    link: Boolean(m?.payload?.link),
    list: Boolean(m?.payload?.list),
    suppressed: m?.suppressed_reason ? String(m.suppressed_reason) : null,
  }))
  const sent = msgs.filter((m) => !m.suppressed_reason)
  const last = sent[sent.length - 1]
  const body = String(last?.body ?? '')
  const payload = last?.payload ?? {}
  const buttons: string[] = Array.isArray(payload?.buttons) ? payload.buttons.map((b: any) => String(b?.title ?? '')) : []
  const flags: string[] = []
  if (!body.trim()) flags.push('EMPTY REPLY')
  if (UUID_RE.test(body)) flags.push('uuid in body')
  if (MARKDOWN_RE.test(body)) flags.push('markdown leaked')
  if (ISO_RE.test(body)) flags.push('machine timestamp')
  if (JARGON_RE.test(body)) flags.push('jargon')
  if (URL_RE.test(body)) flags.push('raw URL in body')
  const words = body.trim() ? body.trim().split(/\s+/).length : 0
  if (words > 90) flags.push(`long (${words} words)`)
  const suppressedOnly = msgs.length > 0 && sent.length === 0
  if (suppressedOnly) flags.push(`ALL SUPPRESSED (${msgs[0]?.suppressed_reason})`)
  if (all.length > 1) flags.push(`${all.length} outbound attempts`)
  return {
    body,
    words,
    buttons,
    list: Boolean(payload?.list),
    link: Boolean(payload?.link),
    suppressed: suppressedOnly ? String(msgs[0]?.suppressed_reason) : null,
    all,
    flags,
  }
}

/* -------------------------------------------------------------------------- *
 * Cost. Reported, never ranked on.
 *
 * The table used to live here TOO, a second copy of `lib/pricing.ts` with the
 * same "one place to be wrong" comment on top of it — which made it two places,
 * and they had already drifted apart on the one number this migration turns on
 * (the cached-input rate). It is imported now.
 *
 * The UTC hour and the rate that was applied are recorded per run, because
 * DeepSeek bills peak hours at double: two identical runs at different times of
 * day bill differently, and an unexplained cost delta between them is a probe
 * defect rather than a finding.
 * -------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------- *
 * Record shape shared between child and parent.
 * -------------------------------------------------------------------------- */

type TurnRecord = {
  model: string
  /** Which arm of the thinking sweep produced this turn. `default` is the loop deciding. */
  thinking: string
  modelReported: string | null
  case: string
  stage: Stage
  persona: Persona
  /** Who actually spoke, or why nobody could. */
  spokeAs: string | null
  what: string
  said: string
  clockNote: string | null
  /** Whether a confirmation was offered, and what taking it produced. */
  tapNote: string | null
  /** What the queue did around this turn — the ladder, in the order it fired. */
  jobs: string[]
  reply: ReplyReport
  tools: { round: number; name: string; args: string; result: string; error?: string }[]
  toolNames: string[]
  wants: string[]
  wanted: boolean
  rounds: number
  latencyMs: number
  inTok: number
  cachedTok: number
  outTok: number
  usd: number | null
  error: string | null
  checks: Check[]
  claimedDone: boolean
  backedByWrite: boolean
}

/* ========================================================================== *
 * The clock
 *
 * DRIVING.md's second trap: one big hop skips whole job ladders, because every
 * job correctly declines a precondition that has already passed. The transcript
 * reads calm and nothing has been tested. So time moves in steps of at most an
 * hour, and to the next scheduled moment where there is one sooner than that.
 *
 * The clock is a GLOBAL singleton — `sim_clock` has no `academy_id` and
 * `app.now()` takes no argument — and it is shared with whatever else is driving
 * this database. Two consequences, both load-bearing:
 *
 *   - total travel is capped, and a stage that wants more than the cap FAILS
 *     rather than quietly dragging somebody else's world along with it.
 *   - it is put back relatively, `advance(-moved)`, so a concurrent advance by
 *     another process survives being undone by this one.
 * ========================================================================== */

const CLOCK_STEP_MS = 60 * 60 * 1000
/** Total travel one probe run may spend, across every stage. */
const CLOCK_BUDGET_MS = 30 * 60 * 60 * 1000
/** A guard against a target that keeps receding, not a limit on the budget. */
const MAX_CLOCK_STEPS = 120

/* ========================================================================== *
 * CHILD — one model, one fresh academy, the whole arc.
 * ========================================================================== */

async function runChild(model: string, arm: string): Promise<void> {
  loadEnvFiles()
  const { createAcademy, createTestContact, dropAcademy, inboundFromContact, worldAcademyIds } =
    await import('@/lib/seed')
  const { withSession } = await import('@/lib/db')
  const { advance, now, nextEventAt } = await import('@/lib/clock')
  const { HANDLERS, JobSkip, planAheadFor } = await import('@/lib/jobs')
  const { msOf } = await import('@/lib/jobs/util')

  const label = `Probe ${model}`
  const made = await createAcademy({ name: label, adminName: 'Probe Admin', timezone: 'Asia/Kolkata', category: 'badminton' })
  // `inboundFromContact` walks a cached academy list; a business created a
  // millisecond ago is not in it until the cache is refreshed, and the symptom
  // would be "no such contact" rather than anything pointing here.
  await worldAcademyIds({ refresh: true })

  const q: Sql = async <T = any>(sql: string) =>
    withSession({ role: 'service', academyId: made.academyId }, async (tx) => (await tx.unsafe(sql)) as unknown as T[])

  // Somebody with no role, so the stranger case has a number to arrive from.
  // §10.1 keeps signup as the operator's job, so a genuinely unknown number
  // resolves to nobody and never reaches a turn — a prospect contact is the
  // nearest thing the product has to a stranger it will actually answer.
  //
  // The number is passed rather than left to `createTestContact`, which picks a
  // free one from +9199… scanning only ITS OWN academy while `createAcademy` scans
  // the whole world. In a business one second old that scan sees one contact, so it
  // hands out a number an older academy already owns — §10.1's ambiguous case — and
  // from then on every message from it resolves to nobody. Driven: the stranger's
  // turn never ran, no row was written anywhere, and the case reported an empty
  // reply as though the model had gone quiet. +9195 is a block nothing else uses
  // (+9199 test contacts, +91984501/2 the seed, +9197 the stage fixtures).
  const prospectPhone = `+9195${made.academyId.replace(/\D/g, '').padEnd(8, '0').slice(0, 8)}`
  const prospect = await createTestContact({
    academyId: made.academyId, name: 'Nikhil Bose', role: 'prospect', phone: prospectPhone,
  })
  await worldAcademyIds({ refresh: true })

  /**
   * Claim and run everything due FOR THIS ACADEMY ONLY.
   *
   * `runDueJobs` claims globally — `job` has no tenant column — so calling it here
   * would run every other business's queue from inside this probe, sending their
   * messages and spending their model calls. The claim below is the runner's, with
   * one predicate added: §6.6 puts the tenant in every payload, so scoping is
   * possible without a migration. The WORK is still the product's — `HANDLERS` is
   * imported, never reimplemented — so a handler bug still shows up here.
   */
  async function drainOwnJobs(): Promise<string[]> {
    const log: string[] = []
    await planAheadFor(made.academyId).catch((e) => log.push(`plan failed: ${(e as Error)?.message}`))
    for (let round = 0; round < 8; round++) {
      const batch = await q(`
        with due as (
          select id from job
           where status = 'pending' and run_at <= app.now()
             and payload->>'academy_id' = '${made.academyId}'
           order by run_at asc, created_at asc
           limit 50
           for update skip locked
        )
        update job j
           set status = 'running', attempts = j.attempts + 1, locked_at = app.now(), locked_by = 'probe'
          from due
         where j.id = due.id
        returning j.*`)
      if (batch.length === 0) break
      batch.sort((a: any, b: any) => msOf(a.run_at) - msOf(b.run_at))
      for (const job of batch) {
        const handler = (HANDLERS as any)[job.kind]
        if (!handler) {
          await q(`update job set status = 'failed', last_error = 'no handler', locked_at = null where id = '${job.id}'::uuid`)
          log.push(`FAIL ${job.kind} — no handler`)
          continue
        }
        try {
          await handler(job)
          await q(`update job set status = 'done', last_error = null, locked_at = null where id = '${job.id}'::uuid`)
          log.push(`ran ${job.kind}`)
        } catch (e) {
          const skipped = e instanceof JobSkip
          const reason = String((e as any)?.reason ?? (e as Error)?.message ?? e).slice(0, 200).replace(/'/g, "''")
          await q(
            `update job set status = '${skipped ? 'skipped' : 'failed'}', last_error = '${reason}', locked_at = null
              where id = '${job.id}'::uuid`,
          )
          log.push(`${skipped ? 'skip' : 'FAIL'} ${job.kind} — ${reason}`)
        }
      }
    }
    return log
  }

  /** Step the world forward to `target`, draining as it goes. Never in one hop. */
  let clockMovedMs = 0
  async function walkClockTo(target: Date, log: string[]): Promise<string> {
    const from = await now()
    const distance = target.getTime() - from.getTime()
    if (distance <= 0) return `already past ${target.toISOString()}`
    const left = CLOCK_BUDGET_MS - clockMovedMs
    if (distance > left) {
      // Reject loudly rather than moving anyway. The budget exists because this
      // clock belongs to the whole world, and a probe that overruns it is
      // interfering with runs it cannot see.
      return `REFUSED: ${target.toISOString()} is ${(distance / 3_600_000).toFixed(1)}h away and ${(left / 3_600_000).toFixed(1)}h of clock budget is left`
    }
    let steps = 0
    while (steps < MAX_CLOCK_STEPS) {
      const at = await now()
      const remaining = target.getTime() - at.getTime()
      if (remaining <= 0) break
      let step = Math.min(CLOCK_STEP_MS, remaining)
      const next = await nextEventAt()
      if (next) {
        const toNext = next.getTime() - at.getTime()
        if (toNext > 0 && toNext < step) step = toNext
      }
      await advance(step)
      clockMovedMs += step
      steps++
      log.push(...(await drainOwnJobs()))
    }
    const spent = ((await now()).getTime() - from.getTime()) / 3_600_000
    return `${spent.toFixed(1)}h in ${steps} step${steps === 1 ? '' : 's'} → ${target.toISOString()}${
      steps >= MAX_CLOCK_STEPS ? ' (STOPPED at the step guard)' : ''
    }`
  }

  /** Whose phone this case speaks from, resolved out of what the arc has built. */
  async function contactFor(kase: Case): Promise<{ id: string; name: string } | null> {
    if (kase.persona === 'admin') return { id: made.adminContactId, name: 'Probe Admin' }
    if (kase.persona === 'prospect') return { id: prospect.contactId, name: prospect.name }
    const like = kase.who ? `and lower(p.full_name) like '%${kase.who.toLowerCase()}%'` : ''
    const rows =
      kase.persona === 'coach'
        ? await q(`select ct.id, p.full_name from coach co
                     join person p on p.id = co.person_id
                     join contact ct on ct.person_id = p.id
                    where co.status <> 'ended' ${like}
                    order by co.created_at limit 1`)
        : await q(`select ct.id, p.full_name from account a
                     join person p on p.id = a.holder_person_id
                     join contact ct on ct.person_id = p.id
                    where true ${like}
                    order by a.created_at limit 1`)
    return rows[0] ? { id: String(rows[0].id), name: String(rows[0].full_name) } : null
  }

  const records: TurnRecord[] = []
  try {
    for (const kase of CASES) {
      if (ONLY && kase.name !== ONLY) continue
      if (ONLY_STAGE && kase.stage !== ONLY_STAGE) continue
      if (ONLY_PERSONA && kase.persona !== ONLY_PERSONA) continue
      process.stderr.write(c.dim(`  ${model} · ${kase.stage}/${kase.name} as ${kase.persona} …\n`))

      const jobs: string[] = []
      let clockNote: string | null = null
      if (kase.clock) {
        const target = await kase.clock(q).catch(() => null)
        clockNote = target ? await walkClockTo(new Date(target), jobs) : 'no moment to walk to — nothing matched'
      }

      const speaker = await contactFor(kase)
      const startedAt = new Date().toISOString()
      let fatal: string | null = null
      if (speaker) {
        try {
          await inboundFromContact({ contactId: speaker.id, text: kase.text })
        } catch (e) {
          fatal = (e as Error)?.message?.slice(0, 300) ?? String(e)
        }
      }

      const turns = speaker
        ? await q(
            `select id, model, rounds, latency_ms, prompt_tokens, cached_tokens, output_tokens,
                    error, tool_calls, output
               from turn where created_at >= '${startedAt}'::timestamptz
                and contact_id = '${speaker.id}'::uuid
              order by created_at desc limit 1`,
          )
        : []
      const t = turns[0] ?? {}
      // Scoped to the person who spoke. Once the arc has more than one persona and
      // a queue that talks to the others, "everything outbound in this window" is
      // not what this person read — it is this person's reply mixed with whatever
      // the same turn said to the coach and the parent.
      const msgs = speaker
        ? await q(
            `select body, payload, suppressed_reason from message
              where direction = 'outbound' and created_at >= '${startedAt}'::timestamptz
                and contact_id = '${speaker.id}'::uuid
              order by created_at asc`,
          )
        : []
      // The tap goes down the same road a thumb does — `inboundFromContact` with an
      // `actionId` and no text — so the plan that runs is the one stored in the
      // action row (§2.2), not a re-reading of the sentence.
      let tapNote: string | null = null
      if (kase.tap && speaker) {
        // Newest message first: the confirmation is on the last thing said, and an
        // older message in the same window may carry a stale one.
        const offered = [...msgs]
          .reverse()
          .flatMap((m: any) => (Array.isArray(m?.payload?.buttons) ? m.payload.buttons : []))
          .filter((b: any) => b?.actionId)
        const kinds = offered.length
          ? await q(
              `select id::text as id, kind from action
                where id in (${offered.map((b: any) => `'${String(b.actionId)}'`).join(',')})`,
            )
          : []
        const kindOf = new Map(kinds.map((r: any) => [String(r.id), String(r.kind)]))
        const hit = offered.find((b: any) => ['steps', 'operation'].includes(kindOf.get(String(b.actionId)) ?? ''))
        if (!hit) {
          tapNote = `nothing staged to tap — ${offered.map((b: any) => `[${b?.title}: ${kindOf.get(String(b.actionId)) ?? '?'}]`).join(' ') || 'no buttons at all'}`
        } else {
          const tappedAt = new Date().toISOString()
          try {
            await inboundFromContact({ contactId: speaker.id, actionId: String(hit.actionId) })
            const after = await q(
              `select body from message
                where direction = 'outbound' and suppressed_reason is null
                  and contact_id = '${speaker.id}'::uuid and created_at >= '${tappedAt}'::timestamptz
                order by created_at desc limit 1`,
            )
            tapNote = `tapped [${hit.title}] → ${String(after[0]?.body ?? '(nothing came back)').slice(0, 160)}`
          } catch (e) {
            tapNote = `tapped [${hit.title}] and it threw: ${(e as Error)?.message?.slice(0, 160)}`
          }
        }
      }

      const trace: any[] = Array.isArray(t.tool_calls) ? t.tool_calls : []
      const tools = trace.map((x: any) => ({
        round: Number(x?.round ?? 0),
        name: String(x?.name ?? '?'),
        args: JSON.stringify(x?.args ?? {}).slice(0, 700),
        // The RESULT, not just the call. A tool that refuses returns
        // `{result:{error, hint, signature}}` rather than throwing, so `error`
        // is empty on exactly the failures worth reading — which is why the
        // first run could show `plan → plan` with identical arguments and no
        // way to see what the model was told in between.
        result: JSON.stringify(x?.result ?? null).slice(0, 900),
        ...(x?.error ? { error: String(x.error).slice(0, 300) } : {}),
      }))
      // The model's own per-round records ride in the same array as the tool
      // calls, deliberately — the score file wants them, because "what it wrote
      // on round 3 before calling nothing" is the evidence a wrong reply raises.
      // The `tools` COLUMN is a different question and must not count them.
      const toolNames = tools.filter((x) => !x.name.startsWith('(')).map((x) => x.name)
      const reply = readReply(msgs)

      // Everything the turn queued that is already due — `create_class` writes no
      // sessions of its own, a marked register schedules the outcomes, and the
      // reply the family gets is a job rather than a sentence. Reading the world
      // before this ran was reading it one layer short of what the person sees.
      jobs.push(...(await drainOwnJobs()))

      // Axis 1 of `drive score`: a reply in the past tense with no write from
      // that turn behind it. Queried against this turn's own audit rows (0015),
      // which is the only thing that makes the claim checkable at all.
      const audits = t.id
        ? await q(`select count(*)::int as n from audit_entry where turn_id = '${t.id}'::uuid and diff is not null`)
        : [{ n: 0 }]
      const claimedDone = PAST_TENSE_RE.test(reply.body)
      const backedByWrite = Number(audits[0]?.n ?? 0) > 0

      let checks: Check[] = speaker
        ? []
        : [
            // Not a harness gap. Every persona but the admin is made by the arc
            // itself, so "there is no coach to speak as" is a finding about the
            // case that was supposed to hire one.
            check(`there is a ${kase.persona} to speak as`, false, `nothing in this business matches ${kase.persona}${kase.who ? ` "${kase.who}"` : ''}`),
          ]
      if (speaker) {
        try {
          checks = await kase.expect(q, { startedAt, contactId: speaker.id })
        } catch (e) {
          checks = [check('expectation query failed', false, (e as Error)?.message ?? String(e))]
        }
      }
      // Every case pays for the invariants, so a defect introduced by one sentence
      // is caught by whichever case happens to run after it — which is the point:
      // nobody has to predict which prompt will break which rule.
      checks = [...checks, ...(await runInvariants(q))]

      records.push({
        model,
        thinking: arm,
        modelReported: t.model ?? null,
        case: kase.name,
        stage: kase.stage,
        persona: kase.persona,
        spokeAs: speaker?.name ?? null,
        what: kase.what,
        said: kase.text,
        clockNote,
        tapNote,
        jobs,
        reply,
        tools,
        toolNames,
        wants: kase.wants,
        // `reflect:schedule` is the discretionary tool being reached, just after the
        // reply rather than during it (see `reflect` in loop.ts). Counting it as a
        // miss would answer the open question with the wrong answer.
        wanted:
          kase.wants.length === 0 ||
          kase.wants.some((w) => toolNames.includes(w) || toolNames.includes(`reflect:${w}`)),
        rounds: Number(t.rounds ?? 0),
        latencyMs: Number(t.latency_ms ?? 0),
        inTok: Number(t.prompt_tokens ?? 0),
        cachedTok: Number(t.cached_tokens ?? 0),
        outTok: Number(t.output_tokens ?? 0),
        usd: costUsd(model, Number(t.prompt_tokens ?? 0), Number(t.cached_tokens ?? 0), Number(t.output_tokens ?? 0), RUN_AT),
        error: fatal ?? (t.error ? String(t.error) : null),
        checks,
        claimedDone,
        backedByWrite,
      })
    }
  } finally {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, `${armFile(model, arm)}.json`), JSON.stringify(records, null, 2))

    // Relative, so an advance by another process between then and now survives.
    if (clockMovedMs !== 0) {
      await advance(-clockMovedMs).catch(() => null)
      process.stderr.write(c.dim(`  clock put back ${(clockMovedMs / 3_600_000).toFixed(1)}h\n`))
    }
    if (!has('keep')) {
      // `job` has no FK to `academy`, so dropping the business leaves its queue
      // behind for the next tick anywhere in the world to pick up and fail on.
      await q(`delete from job where payload->>'academy_id' = '${made.academyId}'`).catch(() => null)
      await dropAcademy(made.academyId).catch(() => null)
    } else {
      process.stderr.write(c.yellow(`  kept ${label} — ${made.academyId}\n`))
    }
  }
}

/* ========================================================================== *
 * PARENT — spawn a child per model, then report.
 * ========================================================================== */

/** One file per arm, so two thinking arms of one model never overwrite each other. */
function armFile(model: string, thinking: string): string {
  return `${model}${thinking === 'default' ? '' : `--thinking-${thinking}`}`.replace(/[^\w.-]/g, '_')
}

/** How an arm is named everywhere a person reads it. */
function armLabel(model: string, thinking: string): string {
  return thinking === 'default' ? model : `${model} · thinking=${thinking}`
}

function spawnChild(model: string, thinking: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'),
        join(process.cwd(), 'scripts', 'probe-model.ts'),
        '--child', '--model', model, '--arm', thinking, '--out', OUT_DIR,
        ...(ONLY ? ['--case', ONLY] : []),
        ...(ONLY_STAGE ? ['--stage', ONLY_STAGE] : []),
        ...(ONLY_PERSONA ? ['--persona', ONLY_PERSONA] : []),
        ...(has('keep') ? ['--keep'] : []),
      ],
      {
        // `PROBE_THINKING` is read at the client boundary (`lib/agent/deepseek.ts`)
        // and is absent in production: pinning a tier is a probe instrument, not a
        // setting. `default` leaves the loop to choose per turn, as it ships.
        env: {
          ...process.env,
          MODEL_MAIN: model,
          ...(thinking === 'default' ? {} : { PROBE_THINKING: thinking }),
        },
        stdio: ['ignore', 'inherit', 'inherit'],
      },
    )
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

function selected(k: Case): boolean {
  return (!ONLY || k.name === ONLY) && (!ONLY_STAGE || k.stage === ONLY_STAGE) && (!ONLY_PERSONA || k.persona === ONLY_PERSONA)
}

function report(all: TurnRecord[]): void {
  // An arm — one model at one thinking tier — is the unit everything groups by.
  // Grouping by model alone would average the two arms of a sweep into one row
  // and hide the only comparison the sweep exists to make.
  const arms = [...new Set(all.map((r) => `${r.model} ${r.thinking ?? 'default'}`))].map((k) => {
    const [model, thinking] = k.split(' ') as [string, string]
    return { model, thinking, label: armLabel(model, thinking) }
  })
  const forArm = (a: { model: string; thinking: string }) =>
    all.filter((r) => r.model === a.model && (r.thinking ?? 'default') === a.thinking)

  const lines: string[] = [
    '# probe-model — full evidence',
    '',
    `Run at ${RUN_AT.toISOString()} — ${isPeak(RUN_AT) ? 'PEAK' : 'off-peak'} rates. Two runs at different`,
    'times of day bill differently; that is the rate card, not a finding.',
    '',
  ]
  for (const arm of arms) {
    const mine = forArm(arm)
    if (!mine.length) continue
    lines.push(`## ${arm.label}`, '')
    let stage = ''
    for (const r of mine) {
      if (r.stage !== stage) {
        stage = r.stage
        lines.push(`### stage: ${stage}`, '')
      }
      lines.push(`#### ${r.case} — ${r.what}`, '')
      lines.push(`**Spoken by:** ${r.persona}${r.spokeAs ? ` (${r.spokeAs})` : ' — NOBODY FOUND'}`, '')
      if (r.clockNote) lines.push(`**Clock:** ${r.clockNote}`, '')
      lines.push(`**Typed:** ${r.said}`, '')
      if (r.tapNote) lines.push(`**Then:** ${r.tapNote}`, '')
      lines.push(`**What the person read** (${r.reply.words} words${r.reply.suppressed ? `, SUPPRESSED: ${r.reply.suppressed}` : ''}):`, '', '```', r.reply.body || '(nothing)', '```', '')
      const affordance = [
        r.reply.buttons.length ? `buttons: ${r.reply.buttons.map((b) => `\`${b}\``).join(' · ')}` : '',
        r.reply.link ? 'link button' : '',
        r.reply.list ? 'list picker' : '',
      ].filter(Boolean)
      lines.push(`**Affordance:** ${affordance.join(' · ') || 'none — they must type'}`, '')
      if (r.reply.all.length > 1) {
        lines.push(`**All ${r.reply.all.length} outbound attempts:**`, '')
        for (const [i, m] of r.reply.all.entries()) {
          lines.push(
            `${i + 1}. ${m.suppressed ? `~~suppressed: ${m.suppressed}~~` : 'sent'} — ` +
              `${m.buttons.length} buttons${m.link ? ' + link' : ''}${m.list ? ' + list' : ''} — "${m.body.slice(0, 90)}…"`,
          )
        }
        lines.push('')
      }
      if (r.reply.flags.length) lines.push(`**Flags:** ${r.reply.flags.join(' · ')}`, '')
      lines.push(`**Tools** (${r.rounds} rounds): ${r.toolNames.join(' → ') || 'none'}`, '')
      for (const t of r.tools) {
        lines.push(`- r${t.round} \`${t.name}\` ${t.error ? `**THREW: ${t.error}**` : ''}`, '  ```json', `  ${t.args}`, '  ```')
        if (t.result && t.result !== 'null') lines.push(`  → \`${t.result}\``)
      }
      lines.push('')
      if (r.jobs.length) lines.push(`**Queue:** ${r.jobs.join(' · ')}`, '')
      if (r.checks.length) {
        lines.push('**Is it actually true?**', '')
        for (const k of r.checks) lines.push(`- ${k.ok ? '✅' : '❌'} ${k.label} — \`${k.detail.slice(0, 300)}\``)
        lines.push('')
      }
      lines.push(
        `**Cost:** ${(r.latencyMs / 1000).toFixed(1)}s · ${r.inTok} in (${r.inTok ? Math.round((100 * r.cachedTok) / r.inTok) : 0}% cached) / ${r.outTok} out · ` +
          (r.usd === null ? 'unpriced' : `$${r.usd.toFixed(4)} ≈ ₹${(r.usd * USD_INR).toFixed(2)}`),
        '',
      )
      if (r.claimedDone && !r.backedByWrite) lines.push('> ⚠️ **Claimed something was done with no write from this turn behind it.**', '')
      if (r.error) lines.push(`> ❌ turn error: ${r.error}`, '')
      lines.push('---', '')
    }
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'score.md'), lines.join('\n'))

  console.log(`\n${c.bold('per turn')}`)
  console.log(c.dim(`${'model'.padEnd(24)} ${'stage'.padEnd(12)} ${'case'.padEnd(22)} ${'who'.padEnd(9)} ${'true?'.padEnd(6)} ${'tools'.padEnd(26)} ${'reply'.padEnd(7)} ${'aff'.padStart(4)} ${'rnd'.padStart(3)} ${'secs'.padStart(5)} ${'₹'.padStart(6)}`))
  for (const r of all) {
    const t = `${r.checks.filter((k) => k.ok).length}/${r.checks.length}`
    const good = r.checks.length === 0 || r.checks.every((k) => k.ok)
    const cell = r.checks.length === 0 ? c.dim('  —  ') : good ? c.green(t.padEnd(6)) : c.red(t.padEnd(6))
    const aff = r.reply.buttons.length ? `${r.reply.buttons.length}b` : r.reply.link ? 'link' : r.reply.list ? 'list' : '—'
    console.log(
      `${armLabel(r.model, r.thinking ?? 'default').padEnd(30)} ${r.stage.padEnd(12)} ${r.case.padEnd(22)} ${(r.spokeAs ? r.persona : c.red(r.persona)).padEnd(9)} ${cell} ` +
        `${(r.toolNames.join(',') || '-').slice(0, 25).padEnd(26)} ` +
        `${String(r.reply.words).padStart(4)}w  ${aff.padStart(4)} ${String(r.rounds).padStart(3)} ` +
        `${(r.latencyMs / 1000).toFixed(1).padStart(5)} ${(r.usd === null ? '?' : (r.usd * USD_INR).toFixed(2)).padStart(6)}` +
        (r.reply.flags.length ? c.yellow(`  ${r.reply.flags.join(', ')}`) : '') +
        (r.claimedDone && !r.backedByWrite ? c.red('  UNBACKED CLAIM') : '') +
        (r.error ? c.red(`  ERROR`) : ''),
    )
  }

  console.log(`\n${c.bold('totals')} ${c.dim(isPeak(RUN_AT) ? '(peak rates)' : '(off-peak rates)')}`)
  for (const arm of arms) {
    const mine = forArm(arm)
    if (!mine.length) continue
    const checks = mine.flatMap((r) => r.checks)
    const wanted = mine.filter((r) => r.wants.length)
    const usd = mine.reduce((a, r) => a + (r.usd ?? 0), 0)
    console.log(
      `  ${arm.label.padEnd(30)} truth ${checks.filter((k) => k.ok).length}/${checks.length} · ` +
        `right tool ${wanted.filter((r) => r.wanted).length}/${wanted.length} · ` +
        `${mine.filter((r) => r.reply.flags.length).length} turns with reply flags · ` +
        `${mine.filter((r) => r.claimedDone && !r.backedByWrite).length} unbacked · ` +
        `${(mine.reduce((a, r) => a + r.latencyMs, 0) / mine.length / 1000).toFixed(1)}s avg · ₹${(usd * USD_INR).toFixed(2)} total`,
    )
  }

  // Which checks fail everywhere is a different question from which turn failed,
  // and it is the one that says whether the product or the model is at fault.
  const failing = new Map<string, number>()
  for (const r of all) for (const k of r.checks) if (!k.ok) failing.set(k.label, (failing.get(k.label) ?? 0) + 1)
  if (failing.size) {
    console.log(`\n${c.bold('failed checks, by how often')}`)
    for (const [labelText, n] of [...failing].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${c.red(String(n).padStart(3))}  ${labelText}`)
    }
  }
  console.log(c.dim(`\nfull evidence → ${join(OUT_DIR, 'score.md')}`))
}

/* ========================================================================== */

if (has('child')) {
  await runChild(flag('model'), flag('arm', 'default'))
} else {
  const chosen = CASES.filter(selected)
  // `--persona coach --case lookup` is an empty intersection, and running it built
  // two academies, probed nothing and printed a clean report. A harness that reports
  // nothing wrong because it asked nothing is the trap DRIVING.md opens with.
  if (!chosen.length) {
    console.error(c.red('no case matches those filters — nothing would be probed.'))
    process.exit(2)
  }
  const ARMS = MODELS.flatMap((model) => THINKING_ARMS.map((thinking) => ({ model, thinking })))
  console.log(
    c.dim(
      `${MODELS.length} model(s) × ${THINKING_ARMS.length} thinking arm(s) × ${chosen.length} case(s) across ` +
        `${new Set(chosen.map((k) => k.stage)).size} stage(s), one fresh academy each`,
    ),
  )
  // Which rate card this run is billed at, said before it starts rather than
  // worked out afterwards from a total that looks wrong.
  console.log(
    c.dim(
      `started ${RUN_AT.toISOString()} — ${isPeak(RUN_AT) ? 'PEAK rates (double — consider waiting)' : 'off-peak rates'}`,
    ),
  )
  for (const arm of ARMS) {
    console.log(c.bold(`\n${armLabel(arm.model, arm.thinking)}`))
    const code = await spawnChild(arm.model, arm.thinking)
    if (code !== 0) console.log(c.red(`  child exited ${code}`))
  }
  const all: TurnRecord[] = []
  for (const arm of ARMS) {
    const path = join(OUT_DIR, `${armFile(arm.model, arm.thinking)}.json`)
    if (existsSync(path)) all.push(...(JSON.parse(readFileSync(path, 'utf8')) as TurnRecord[]))
  }
  if (!all.length) console.log(c.red('no records — every child failed'))
  else report(all)
}

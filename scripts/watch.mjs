/**
 * watch — is this drive still measuring anything?
 *
 *   node scripts/watch.mjs                       # the newest run, followed until it ends
 *   node scripts/watch.mjs --run .probe/runs/…   # a named run
 *   node scripts/watch.mjs --once                # evaluate what exists now and exit
 *   node scripts/watch.mjs --quiet               # tripwires only, no per-turn line
 *
 * Exit codes: 0 nothing tripped · 3 a tripwire tripped · 1 no run to watch.
 *
 * WHY THIS IS NOT A JUDGE, AND MUST NEVER BECOME ONE
 * -----------------------------------------------------------------------------
 * The house rule is that nothing in an instrument scores anything — deterministic
 * pass/fail was taken out of the drives on purpose, because a pattern-matcher read
 * 0 overclaims on a run containing exactly one. That rule is about the PRODUCT.
 * This file is about the RUN.
 *
 * Every tripwire below answers one question — *can this drive still measure the
 * thing it was started to measure?* — and none of them answers *was the bot any
 * good?* "Forty turns and no row has been written" is not a verdict on a message;
 * it is the observation that the world is not moving and the next twenty minutes
 * of DeepSeek will buy nothing. A tripwire fires, says what it saw, and stops. It
 * writes nothing into `judgement.json` and it never labels a turn.
 *
 * If you find yourself adding a rule that reads a message BODY, you are writing a
 * judge and it belongs in `docs/JUDGING.md`. The line is: tripwires read the
 * shape of the record (counts, tables, states, errors), never its prose.
 *
 * WHAT IT COST TO NOT HAVE THIS
 * -----------------------------------------------------------------------------
 * `2026-08-22-16-51-sim-b8xo`: thirty simulated days, 233 turns, ~75 minutes and
 * ₹42, finished with ZERO rows in `enrollment`, `player`, `account`, `attendance`
 * and every money table. The month exercised setup and the coach ladder and
 * nothing else — the half of the product that takes money was never entered. That
 * was true and knowable by day 3. Eleven drives were run on 22 Aug 2026 in six
 * hours; each was read only after it finished.
 *
 * The tripwire that matters most is therefore `money-loop`, and it is stated as a
 * question about COVERAGE: a drive whose world never produces a customer cannot
 * say anything about billing, however long it runs.
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return undefined
  const f = args[i]
  return f.includes('=') ? f.slice(f.indexOf('=') + 1) : args[i + 1]
}
const num = (n, d) => (flag(n) === undefined ? d : Number(flag(n)))
const ONCE = args.includes('--once')
const QUIET = args.includes('--quiet')

const RUNS = join('.probe', 'runs')
const newest = () => {
  if (!existsSync(RUNS)) return undefined
  const dirs = readdirSync(RUNS)
    .map((d) => join(RUNS, d))
    .filter((d) => existsSync(join(d, 'turns.jsonl')))
    .sort()
  return dirs[dirs.length - 1]
}

const run = flag('run') ?? newest()
if (!run) {
  console.error('  no run to watch. Start a drive, or pass --run <dir>.')
  process.exit(1)
}

const manifest = existsSync(join(run, 'manifest.json'))
  ? JSON.parse(readFileSync(join(run, 'manifest.json'), 'utf8'))
  : {}
const config = existsSync(join(run, 'config.json'))
  ? JSON.parse(readFileSync(join(run, 'config.json'), 'utf8'))
  : {}

/**
 * The tables a class of coverage is made of.
 *
 * Named rather than counted, because "18 rows were written" is the number that
 * made `b8xo` look like a working month: eighteen writes, all of them setup, and
 * the register never had a name on it. A drive is covered when it has ENTERED a
 * loop, and a loop is entered by writing to one of its tables.
 */
const LOOPS = {
  setup: ['academy', 'venue', 'class', 'class_slot', 'rate_period'],
  coaches: ['coach', 'class_coach', 'session_coach'],
  roster: ['account', 'player', 'enrollment'],
  register: ['attendance'],
  charging: ['tally_line', 'coach_ledger'],
  paid: ['payment'],
}

/**
 * How long a loop may wait AFTER THE ONE BEFORE IT before that is worth saying.
 *
 * Absolute day numbers were the first shape and they are wrong, which took three
 * misfires to see: they assume every business reaches every rung on the operator's
 * calendar. On `2026-08-22-19-49-sim-p882` the owner did not put a class on the
 * board until day 16 — the product asked on day 10 and he answered on day 13, all
 * of it working — so `charging` fired at day 17 about a business that had been
 * teaching for one day. A drive whose owner is slow is not a drive that has
 * stopped measuring anything, and telling those two apart is the whole job here.
 *
 * So the ladder is relative: each rung is due this many simulated days after the
 * rung below it was actually entered. A business that founds on day 12 gets the
 * same patience as one that founds on day 2, and a business that goes live and
 * then never bills anybody is still caught — which is the case this exists for,
 * and `b8xo` is still caught by it.
 *
 * `setup` alone counts from the start of the run, because there is no rung under
 * it and a drive that never founds a business is the emptiest run there is.
 */
const AFTER = { setup: 5, coaches: 4, roster: 5, register: 3, charging: 4, paid: 5 }
const LADDER = ['setup', 'coaches', 'roster', 'register', 'charging', 'paid']

const SILENT_TURNS = num('silent', 25) // turns in a row with nothing sent
const SPEND_CAP = num('spend', Infinity) // rupees

let seen = 0
let tripped = false
const fired = new Set()

/**
 * What was ALREADY true when the watch attached, which is not the same as
 * something going wrong on your watch.
 *
 * Measured the first time this file was pointed at a drive already thirteen days
 * in: it fired on a departure from day 4, exited, and therefore never reached the
 * two tripwires the attach was FOR (`charging` at day 14, `paid` at day 18). A
 * watcher that stops on history cannot watch the future, and attaching mid-run is
 * the common case — a drive is usually already going by the time anybody wonders
 * whether it is worth finishing.
 *
 * So the first pass is a BASELINE: everything true at attach is stated once,
 * loudly, and then held. Only a condition that becomes true afterwards stops the
 * watch. Nothing is hidden either way — the baseline is printed in full, because
 * "this drive was already not measuring anything when you arrived" is the most
 * useful thing it can tell you and the whole reason to look.
 */
let baseline = true

/**
 * How a turn is named in a tripwire.
 *
 * `n` is added by `_derive.ts` when the run is folded up, so it does not exist in
 * `turns.jsonl` — which is the file this watches, because it is the one written
 * as the drive walks. The id is stable, present from the first line, and says the
 * day and the person out loud.
 */
const label = (t) => t.id ?? `#${t.n ?? '?'}`

const say = (s) => process.stdout.write(s + '\n')
const trip = (name, msg) => {
  if (fired.has(name)) return
  fired.add(name)
  if (baseline) {
    say(`  ·· already true at attach — ${name}`)
    say(`     ${msg}`)
    return
  }
  tripped = true
  say('')
  say(`  !! TRIPWIRE  ${name}`)
  say(`     ${msg}`)
  say('')
}

function read() {
  const p = join(run, 'turns.jsonl')
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function evaluate(turns) {
  const day = turns.reduce((m, t) => Math.max(m, Number(t.day ?? 0)), 0)
  const spend = turns.reduce((a, t) => a + Number(t.inr ?? 0), 0)
  const errs = turns.filter((t) => t.error)
  const gaveUp = turns.filter((t) => {
    const pr = t.personaReasoning
    return pr && typeof pr === 'object' && pr.action === 'giveup'
  })
  const sqlErrors = turns.flatMap((t) => (t.sql ?? []).filter((q) => q.error && !String(q.note ?? '').trim()))
  const suppressed = turns.flatMap((t) => (t.messages ?? []).filter((m) => m.suppressedReason))
  const tables = new Set(turns.flatMap((t) => (t.changed ?? []).map((c) => String(c.table ?? ''))))

  /* --- the run has stopped saying anything ------------------------------- */
  let quietRun = 0
  for (let i = turns.length - 1; i >= 0; i--) {
    if (Number(turns[i].sent ?? 0) > 0) break
    quietRun++
  }
  if (quietRun >= SILENT_TURNS)
    trip(
      'silence',
      `${quietRun} turns in a row with nothing sent to anybody. Either the product has stopped ` +
        `speaking or the harness has stopped delivering. Both make the rest of this drive unreadable.`,
    )

  /* --- a loop the drive was supposed to enter and has not ----------------- */
  /**
   * Founding does not land in this record, and that is not the drive failing.
   *
   * A business is talked into existence at the FRONT DESK, so `start_business`
   * writes the `academy` row in a tenant that does not exist when the window
   * opens — `_capture.ts` is scoped to the desk until `adopt` runs, and the rows
   * arrive under a stray-tenant note instead of in `changed`. Measured on
   * `2026-08-22-19-36-sim-4xsq`: Rahul founded on day 3, gave a full timetable on
   * day 4, and every turn read `wrote: 0` — correctly, for the tenant being
   * recorded — so `coverage:setup` fired on a run that was working.
   *
   * `session.json` says which business the run has adopted, is rewritten the
   * moment it does, and is on disk while the drive walks. A run that has moved off
   * the front desk has a business, whatever `changed` can see.
   */
  const adopted = (() => {
    try {
      const s = JSON.parse(readFileSync(join(run, 'session.json'), 'utf8'))
      return Boolean(s.academyId) && s.academyId !== manifest.world?.academyId
    } catch {
      return false
    }
  })()

  /**
   * The day each rung was first reached, off the turn that wrote its first row —
   * `changed` carries the table, and the turn carries the day.
   */
  const enteredOn = {}
  for (const t of turns) {
    for (const c of t.changed ?? []) {
      for (const [loop, tabs] of Object.entries(LOOPS)) {
        if (tabs.includes(String(c.table)) && enteredOn[loop] === undefined) enteredOn[loop] = Number(t.day ?? 0)
      }
    }
  }
  if (adopted && enteredOn.setup === undefined) {
    const first = turns.find((t) => (t.notes ?? []).some((n) => /ran statements in/.test(String(n))))
    enteredOn.setup = Number(first?.day ?? 1)
  }

  for (let i = 0; i < LADDER.length; i++) {
    const loop = LADDER[i]
    if (enteredOn[loop] !== undefined) continue
    const below = i === 0 ? 0 : enteredOn[LADDER[i - 1]]
    // A rung whose predecessor has not been reached is not late; the one below it is.
    if (below === undefined) continue
    const dueOn = below + AFTER[loop]
    if (day >= dueOn)
      trip(
        `coverage:${loop}`,
        `${LADDER[i - 1] ?? 'this run'} was reached on day ${below || 1} and ${AFTER[loop]} days later, on day ` +
          `${day}, not one row has been written to ${LOOPS[loop].join(', ')} in the tenant this record is ` +
          `scoped to. Nothing this drive records from here can say anything about ${loop}. ` +
          `b8xo ran all thirty days in exactly this state.`,
      )
  }

  /* --- the harness is losing turns --------------------------------------- */
  if (errs.length)
    trip(
      'errors',
      `${errs.length} turn(s) carry an error. First: ${label(errs[0])} — "${errs[0].error}". ` +
        `Read it before spending more: a turn that errors this early usually errors every time.`,
    )

  if (sqlErrors.length >= 3)
    trip(
      'sql',
      `${sqlErrors.length} model-authored statements failed. First: ${String(sqlErrors[0].error).slice(0, 200)}. ` +
        `A statement shape the model cannot get right will not fix itself over thirty days.`,
    )

  /* --- somebody walked out ------------------------------------------------ */
  /**
   * A prospect who decides this is the wrong number on day 2 is the product
   * working. The person who has been RUNNING the business leaving on day 20 is
   * the run ending, whatever the day counter says — and the two are the same
   * `giveup` row. What separates them is not a role (the owner is seeded as a
   * `prospect` and founds the business mid-run) but how much of the drive was
   * being carried by that seat, which is what the inbound count measures.
   */
  /**
   * Name to number, from `session.json` — the one file a drive writes BEFORE it
   * starts, so this works on a run that has no `record.json` yet, which is every
   * run worth watching.
   */
  const phoneOf = {}
  try {
    const s = JSON.parse(readFileSync(join(run, 'session.json'), 'utf8'))
    for (const p of s.roster ?? []) if (p.name && p.phone) phoneOf[p.name] = String(p.phone)
  } catch {
    /* a run too young to have one; the departure line still prints, unranked */
  }
  const got = {}
  for (const t of turns)
    for (const m of t.messages ?? []) if (!m.suppressedReason) got[String(m.to)] = (got[String(m.to)] ?? 0) + 1
  /**
   * Who the product reports to, and only once that is a fact rather than a tie.
   *
   * Measured on `2026-08-22-19-49-sim-p882`: at day 2, fourteen turns in, the
   * owner and a coach had each received exactly two messages and the sort picked
   * the coach — so the watch stopped a healthy run announcing that the seat the
   * product reports to had walked out, while the owner was still typing. A
   * departure on day 2 of 30 is worth a line; it is worth stopping a drive only
   * when the person who leaves is demonstrably the one it was about.
   *
   * Two conditions, both cheap: enough of the run to have a shape, and a clear
   * margin over the next person. Below either, the departure still prints — it is
   * just not treated as the end of the experiment.
   */
  const ranked = Object.entries(got).sort((a, b) => b[1] - a[1])
  const decisive = day >= 5 && ranked.length > 1 && ranked[0][1] >= ranked[1][1] * 1.5
  const busiest = decisive ? ranked[0][0] : null
  const principal = busiest ? Object.keys(phoneOf).find((w) => phoneOf[w] === busiest) : undefined
  const seats = new Set(turns.map((t) => t.who).filter((w) => w && w !== 'queue'))

  if (gaveUp.length) {
    const lostPrincipal = gaveUp.some((t) => t.who === principal)
    const left = new Set(gaveUp.map((t) => t.who))
    if (lostPrincipal || left.size >= Math.max(1, seats.size - 1))
      trip(
        'departure',
        `${gaveUp.map((t) => `${t.who} left on day ${t.day}`).join('; ')}. ` +
          (lostPrincipal
            ? `${principal} is the seat this product reports to — the one it has sent the most to — so from here the drive is ` +
              `measuring a business with nobody running it — every remaining day is standing jobs talking to an empty room.`
            : `That is ${left.size} of ${seats.size} seats gone.`) +
          ` Last words: “${gaveUp[gaveUp.length - 1].personaReasoning?.reasoning ?? '?'}”`,
      )
    else say(`  ·· ${gaveUp.map((t) => `${t.who} left (day ${t.day})`).join(', ')} — not the principal seat, watch continues`)
  }

  /**
   * Messages the model wrote and the runtime destroyed.
   *
   * A turn whose model composed a message and sent nothing is indistinguishable,
   * in every count this record keeps, from a turn that had nothing to say — and
   * the job behind it records `:done` either way. On `b8xo` that hid three morning
   * briefs, two evening digests and, on day 19, the only message in the month that
   * named the actual business failure: *"Two weeks in, all three classes are still
   * running to empty courts."* Twelve thousand characters, composed and dropped.
   * On `ceeg`, ten morning briefs.
   *
   * Counted here rather than judged: this says nothing about whether the message
   * was any good, only that the drive paid a model call for it and no phone ever
   * saw it — which is the same question every other tripwire asks.
   */
  const dropped = turns.flatMap((t) =>
    (t.rounds ?? [])
      .filter((r) => /discarded/.test(String(r.name ?? '')))
      .map((r) => ({ t, chars: String(typeof r.args === 'string' ? r.args : JSON.stringify(r.args ?? '')).length })),
  )
  const droppedSilent = dropped.filter((d) => Number(d.t.sent ?? 0) === 0)
  if (droppedSilent.length >= 3)
    trip(
      'composed-and-dropped',
      `${dropped.length} composed message(s) were discarded by the runtime (${dropped.reduce((a, d) => a + d.chars, 0)} characters), ` +
        `${droppedSilent.length} of them on turns that then sent NOTHING — ` +
        `${[...new Set(droppedSilent.flatMap((d) => (d.t.jobs ?? []).filter((j) => /:done/.test(j) && !/lane/.test(j))))].join(', ') || 'no named job'} ` +
        `recorded done regardless. Every count in this run treats those turns as quiet ones.`,
    )

  /**
   * A seat the database cannot support, which is the drive arguing with itself.
   *
   * `_world-file.ts` builds a sender, a front desk and one contact each — no
   * academy, no classes, nobody enrolled — on the argument that *"a brief cannot
   * contradict a database that does not exist yet"*. It can, and one does:
   * `worlds/ace-tennis.json` seats Divya Rao as a `client` and tells her *"your
   * daughter Anika has been going to the evening batch for about a year"*. She
   * wrote on day 1 of `b8xo`, was told truthfully that nothing is set up on this
   * number, and left on day 2 — *"wrong number then, sorry."*
   *
   * That is the harness losing a seat, not the product losing a customer, and it
   * was read as the second: a commit the same evening cited her departure as
   * evidence that customers were arriving before the business and built a
   * standing job to tell owners about them. F-DY has been open the whole time.
   *
   * So this asks the cheap structural version — is there a row anywhere that
   * could make this person what they were told they are — and asks it early
   * enough to stop the run rather than after.
   */
  const seatRoles = (() => {
    try {
      return JSON.parse(readFileSync(join(run, 'session.json'), 'utf8')).roster ?? []
    } catch {
      return []
    }
  })()
  const NEEDS = { client: 'enrollment', coach: 'coach' }
  const unbacked = seatRoles.filter((p) => NEEDS[p.role] && !tables.has(NEEDS[p.role]))
  // Same patience the roster rung gets: not before the business has had time to have one.
  if (unbacked.length && enteredOn.setup !== undefined && day >= enteredOn.setup + AFTER.coaches + AFTER.roster)
    trip(
      'brief-unbackable',
      `day ${day} and ${unbacked.map((p) => `${p.name} is seated as a ${p.role} with no ${NEEDS[p.role]} row`).join('; ')}. ` +
        `Their brief describes a relationship to this business that no row in it supports, so every turn they take ` +
        `is against a product that cannot answer them — and whatever they do next is the harness's doing, not the product's.`,
    )

  /**
   * A turn whose statements are in the record and whose LOOP is not.
   *
   * The signature of evidence written somewhere this record cannot read it: the
   * SQL capture is in-process and always lands, while the turn rows, the messages
   * and the tokens are read back out of the database through one tenant's session
   * over one window. When those disagree, the turn reads as `rounds: 0, sent: 0,
   * ₹0` — byte for byte a turn where the product had nothing to say.
   *
   * On `2026-08-22-15-21-sim-ceeg` that was four of Arjun Shetty's five turns. The
   * product had answered every one within fifteen seconds; the replies are still
   * in the tenant the desk founded for him and readable today. He saw the same
   * silence the record did, wrote "hello??", then "useless", and left on day 8.
   *
   * Cheap and exact: statements ran, so something happened; no rounds came back,
   * so this record cannot say what.
   */
  const blind = turns.filter((t) => (t.sql ?? []).length > 0 && (t.rounds ?? []).length === 0)
  if (blind.length >= 2)
    trip(
      'loop-not-recorded',
      `${blind.length} turn(s) ran statements and recorded no model loop at all — ` +
        `${blind.slice(0, 4).map((t) => label(t)).join(', ')}${blind.length > 4 ? ' …' : ''}. ` +
        `Their evidence was written somewhere this record cannot read, so they read as the product ` +
        `saying nothing when it may have answered. Every count on those turns is a floor.`,
    )

  if (suppressed.length >= 5)
    trip(
      'suppressed',
      `${suppressed.length} outbound messages were suppressed (${[...new Set(suppressed.map((m) => m.suppressedReason))].join(', ')}). ` +
        `A gate firing this often is either the product protecting somebody or the drive talking to itself.`,
    )

  if (spend > SPEND_CAP)
    trip('spend', `₹${spend.toFixed(2)} spent, past the ₹${SPEND_CAP} you set.`)

  return { day, spend, errs: errs.length, tables }
}

say(`  watching ${basename(run)}`)
say(
  `  ${config.days ?? '?'} days · ${manifest.models?.brain ?? '?'} · ${manifest.git?.sha?.slice(0, 7) ?? '?'}` +
    `${manifest.git?.dirty ? ` (+${manifest.git.dirty} dirty)` : ''} · world ${config.world?.ref ?? '?'}`,
)
say(`  tripwires: ladder ${LADDER.map((k) => `${k}+${AFTER[k]}d`).join(' → ')} · silence ${SILENT_TURNS} turns`)
say('')

function pass() {
  const turns = read()
  for (const t of turns.slice(seen)) {
    if (!QUIET) {
      const who = String(t.who ?? '?').slice(0, 14).padEnd(14)
      const mark = t.error ? '!' : t.wrote ? 'w' : t.sent ? '.' : ' '
      say(
        `  ${String(t.n ?? seen + 1).padStart(3)} d${String(t.day ?? '?').padStart(2)} ${String(t.window ?? '').slice(0, 4).padEnd(4)} ` +
          `${who} ${mark} sent:${t.sent ?? 0} wrote:${t.wrote ?? 0} ₹${Number(t.inr ?? 0).toFixed(2)}` +
          `${(t.changed ?? []).length ? '  [' + [...new Set(t.changed.map((c) => c.table))].join(' ') + ']' : ''}` +
          `${t.error ? '  ERROR: ' + t.error : ''}`,
      )
    }
    seen++
  }
  const s = evaluate(turns)
  baseline = false
  return { turns, s }
}

if (ONCE) {
  const { turns, s } = pass()
  say('')
  say(
    `  ${turns.length} turns · day ${s.day} · ₹${s.spend.toFixed(2)} · ${s.errs} errors · ` +
      `tables touched: ${[...s.tables].join(', ') || '(none)'}`,
  )
  const missing = LADDER.filter((k) => !LOOPS[k].some((t) => s.tables.has(t)))
  if (missing.length) say(`  loops never entered: ${missing.join(', ')}`)
  process.exit(tripped ? 3 : 0)
}

/**
 * Followed by polling the file rather than by watching it, because the writer
 * appends a line per turn from another process and a `fs.watch` on Windows
 * reports the change before the line is flushed — a half-written line parsed as
 * a dropped turn is exactly the kind of instrument defect this file exists to
 * catch in others.
 */
let idle = 0
const iv = setInterval(() => {
  const before = seen
  const { turns } = pass()
  idle = seen === before ? idle + 1 : 0
  if (tripped) {
    say(`  stopping the watch — ${fired.size} tripwire(s). The drive is still running; kill it if you agree.`)
    clearInterval(iv)
    process.exit(3)
  }
  // Ten minutes with no new turn: the drive is over, or it is stuck.
  if (idle > 120) {
    const done = existsSync(join(run, 'record.json')) && statSync(join(run, 'record.json')).mtimeMs > 0
    say(`  no new turn for ten minutes — ${done ? 'the run has been folded up.' : 'the drive appears stuck.'}`)
    clearInterval(iv)
    process.exit(done ? 0 : 3)
  }
}, 5000)

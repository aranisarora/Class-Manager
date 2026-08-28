/**
 * report — one reader for every run this repo produces.
 *
 *   node scripts/report.mjs                          # the newest run in .probe/runs
 *   node scripts/report.mjs --run .probe/runs/<dir>
 *   node scripts/report.mjs --out .probe/reports/my-name.html
 *   node scripts/report.mjs --list                   # what runs exist
 *
 * WHY THERE IS ONLY ONE OF THESE NOW
 * -----------------------------------------------------------------------------
 * There were six: `adv-report`, `arc-report`, `fo-report`, `sql-report`,
 * `stress-report` and `tennis-report`, ~250KB of them, one per suite. They shared
 * a stylesheet by copy and nothing else, so a thing worth showing had to be
 * written six times and was usually written once. `arc-report` showed the model's
 * reasoning; `sql-report` showed the statements; neither showed both, and the
 * turn where those two disagree is the turn worth reading.
 *
 * Every instrument writes one shape now (`scripts/_capture.ts`), so there is one
 * reader. A suite is a field on the record, not a program.
 *
 * WHAT IT RENDERS
 * -----------------------------------------------------------------------------
 * The page `.probe/archive/reports/2026-08-17-stress-month-analysis.html` is the model,
 * because it is the only report in this repo that anybody read twice. Three
 * things made it work and all three are structural rather than decorative:
 *
 *   - **The verdict is one sentence, at the top.** Not a number.
 *   - **The pattern is found by SPLITTING, not by averaging.** Scores by persona
 *     turned a list of incidents into one finding: every catastrophic turn in the
 *     month was a client turn, and the same month weighted toward the operator
 *     scores 8.2 and reads as fine.
 *   - **Every turn is opened up, not a hand-picked few** — reasoning, statements,
 *     rows, reply. A report that shows outcomes and hides the inside of the turn
 *     cannot tell a model that did not know from one that knew and could not.
 *
 * A fourth arrived with the persona agents, and it is the PERSON's half of the
 * turn: what they were trying to get, how they read the last reply, and whether
 * they answered at all. A window somebody read and let pass has an empty `say`
 * and an empty `reply` — byte for byte what a broken seat looks like — so until
 * the reasoning beside it was rendered, the page showed a departure as a blank
 * strip of card. Somebody leaving is the most consequential thing a driven week
 * can produce, and it was the one thing the page could not say.
 *
 * COUNTED AND ARGUED ARE KEPT APART
 * -----------------------------------------------------------------------------
 * Everything from `record.json` is measurement and is labelled as such. Everything
 * from `judgement.json` is somebody's reading and is labelled with their name. The
 * page never computes a score, and where no judgement exists it says so and
 * renders the evidence anyway — an unjudged run is a run waiting for a reader, not
 * an error.
 *
 * NOTHING IS TRUNCATED SILENTLY. Where a slice is applied it is large, and it says
 * how much it dropped.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return undefined
  const f = args[i]
  return f.includes('=') ? f.slice(f.indexOf('=') + 1) : args[i + 1]
}

const RUNS = join('.probe', 'runs')

/**
 * Runs newest first.
 *
 * The date-stamped directory name is the whole ordering scheme, and it is
 * deliberate: a default that names one frozen path is wrong the moment the next
 * run lands, and it fails in the worst direction — the script succeeds and
 * renders stale evidence. `adv-report`'s hardcoded default had already rotted to
 * a filename that did not exist.
 */
function allRuns() {
  if (!existsSync(RUNS)) return []
  const out = []
  for (const d of readdirSync(RUNS)) {
    const dir = join(RUNS, d)
    if (existsSync(join(dir, 'record.json'))) {
      out.push(dir)
      continue
    }
    // An A/B parent: each arm is a whole sim in a root of its own, so its runs
    // live at <ab>/<arm-root>/.probe/runs/<run>. They used to be invisible to
    // this index (and so to `npm run runs`, `report` and `watch`), and the way
    // back to an arm's record was reading arms.json by hand.
    if (!existsSync(join(dir, 'arms.json'))) continue
    let armRoots = []
    try {
      armRoots = readdirSync(dir).filter((a) => existsSync(join(dir, a, '.probe', 'runs')))
    } catch {
      continue
    }
    for (const arm of armRoots) {
      const armRuns = join(dir, arm, '.probe', 'runs')
      for (const r of readdirSync(armRuns)) {
        const rd = join(armRuns, r)
        if (existsSync(join(rd, 'record.json'))) out.push(rd)
      }
    }
  }
  return out.sort().reverse()
}

if (args.includes('--list')) {
  const runs = allRuns()
  if (!runs.length) console.log('  no runs in .probe/runs')
  for (const r of runs) {
    const rec = JSON.parse(readFileSync(join(r, 'record.json'), 'utf8'))
    // "judged" means RENDERABLE — an array of turn verdicts this reader can join
    // on `n` — not merely that a file exists. A legacy object-shaped judgement
    // (the pre-fix judge.mjs shape) rendered unjudged while listing as judged,
    // which sent readers to a page with no verdict on it.
    const judged = (() => {
      try {
        const j = JSON.parse(readFileSync(join(r, 'judgement.json'), 'utf8'))
        return Array.isArray(j?.turns) && j.turns.length ? 'judged' : 'unjudged'
      } catch {
        return 'unjudged'
      }
    })()
    console.log(
      `  ${basename(r).padEnd(34)} ${String(rec.suite ?? '?').padEnd(8)} ` +
        `${String(rec.turns?.length ?? 0).padStart(3)} turns  ${judged}`,
    )
  }
  process.exit(0)
}

const runPath = flag('run') ?? allRuns()[0]
if (!runPath) {
  console.error('  no run to render. Drive something first, or pass --run <dir>.')
  process.exit(1)
}
if (!existsSync(join(runPath, 'record.json'))) {
  console.error(`  no record.json in ${runPath}`)
  process.exit(1)
}

const rec = JSON.parse(readFileSync(join(runPath, 'record.json'), 'utf8'))
const judgePath = join(runPath, 'judgement.json')
const judgement = existsSync(judgePath) ? JSON.parse(readFileSync(judgePath, 'utf8')) : null

/* -------------------------------------------------------------------------- *
 * Rendering helpers
 * -------------------------------------------------------------------------- */

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

/** A long value, kept whole where it can be and honest about it where it cannot. */
const CAP = 40_000
const capped = (s) => {
  const str = typeof s === 'string' ? s : JSON.stringify(s, null, 2) ?? ''
  if (str.length <= CAP) return esc(str)
  return `${esc(str.slice(0, CAP))}\n\n… [+${(str.length - CAP).toLocaleString()} more characters — the whole value is in record.json]`
}

const n2 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : '—')
const inr = (x) => (Number.isFinite(x) ? `₹${x.toFixed(2)}` : '—')

/**
 * A judged turn, by its position in the run.
 *
 * Guarded because `scripts/judge.mjs` writes `turns` as an OBJECT keyed by case
 * name, not an array keyed by `n`, and calling `.map` on it threw a TypeError
 * that read as a broken report rather than as two instruments disagreeing about
 * a schema. Say which shape was found and render the run unjudged — a page that
 * renders without the verdict is worth more than no page at all, and the line
 * below is how the disagreement gets noticed instead of swallowed.
 */
let judgedTurns = judgement?.turns ?? []
if (!Array.isArray(judgedTurns)) {
  console.error(
    `  judgement.json holds turns as ${judgedTurns && typeof judgedTurns === 'object' ? 'an object' : typeof judgedTurns}, ` +
      `and this reader keys them by turn number — rendering the run unjudged.`,
  )
  judgedTurns = []
}
const judged = new Map(judgedTurns.map((t) => [Number(t.n), t]))
const scoreOf = (t) => {
  const j = judged.get(t.n)
  return typeof j?.score === 'number' ? j.score : null
}
const band = (s) => (s === null ? '' : s >= 8 ? 'good' : s >= 6 ? 'mid' : 'bad')

/**
 * A turn nobody sat in — the queue draining on its own.
 *
 * `live.ts` records its drains as turns so the proactive surface is priced like
 * everything else (before 20 Aug 2026 it was priced not at all). They are turns
 * in every way that matters — they cost tokens, they write rows, they put
 * messages on phones — but two of the headings below would lie about them:
 * nobody typed, and nobody was waiting to read.
 */
const isQueue = (t) => t.who === 'queue'

/**
 * What the person in the seat CHOSE to do — `say`, `quiet` or `giveup`.
 *
 * Only a persona agent has one, and it is not a field of its own: `_seat-worker`
 * records the choice inside `personaReasoning` as `{ action, reasoning }`,
 * because the action is evidence about the person and `Turn` has nowhere else to
 * put it. This is where it is dug back out. Null for a human seat, for the queue,
 * and for any driver that hands over prose instead of a shape — all three are
 * "the record does not say", which is different from "they answered".
 */
/**
 * `tap` was missing, and a tap is a quarter of what these seats do — 20 of b8xo's
 * 82 seat turns, 17 of ceeg's. Without it `actionOf` returned null for every one
 * of them, so the page and `--text` both said "the record does not say" about the
 * single most deliberate thing a person can do on a phone, and F-DV's whole point
 * — that the seat COULD always press a button and every mechanism behind a tap had
 * been measured at a fifteenth of its rate — was invisible again in the reading.
 */
const ACTIONS = new Set(['say', 'tap', 'quiet', 'giveup'])
const actionOf = (t) => {
  const pr = t.personaReasoning
  const a = pr && typeof pr === 'object' && !Array.isArray(pr) ? pr.action : null
  return typeof a === 'string' && ACTIONS.has(a) ? a : null
}

/**
 * How the person read the last reply, in whatever shape the driver kept it.
 *
 * `Turn.personaReasoning` is `unknown` on purpose — a driver may hand over one
 * sentence or a model's whole thinking block, and clipping it at the harness
 * would be the harness deciding what mattered. So: the string if it is one, the
 * `reasoning` out of the shape `_seat-worker` writes if it is that, and
 * otherwise the value itself, which `capped` renders as JSON. Showing nothing
 * because the shape was unfamiliar is the one option not on the list.
 */
const reasonOf = (t) => {
  const pr = t.personaReasoning
  if (pr === undefined || pr === null) return ''
  if (typeof pr === 'string') return pr
  if (typeof pr === 'object' && !Array.isArray(pr) && typeof pr.reasoning === 'string') return pr.reasoning
  return pr
}

/** Whether anything was typed. A tap counts — the button's title is what it said. */
const spoke = (t) => Boolean(String(t.say ?? '').trim())

/**
 * A window somebody read and did not answer, or the one they walked out in.
 *
 * The most consequential outcome a week can produce, and the one that looks
 * exactly like a broken harness from the outside: a turn with nothing typed and
 * nothing sent. The action is the whole difference.
 */
const walkedAway = (t) => !isQueue(t) && (actionOf(t) === 'quiet' || actionOf(t) === 'giveup')

/** Day and window together, for a line that has room for both. */
const whenOf = (t) =>
  [t.day === undefined ? '' : `day ${t.day}`, t.window ?? ''].filter(Boolean).join(' · ')

/**
 * The kind out of a job string.
 *
 * `_seat.ts`'s drain writes `<kind>:<outcome>` — `materialize_sessions:done`,
 * `first_contact_batch:skipped — <why>` — and since 23 Aug 2026 an `agent_task`
 * carries its watch slug in the kind: `agent_task(who-asked):done`, because a
 * record full of bare `agent_task:done` is how a fired mechanism was read as
 * never having run. The slug stays in the head deliberately, so the split below
 * surfaces one "kind" per watch rather than one bucket for all of them. Every
 * instrument gets its jobs from that one function, `probe-model` included since
 * it stopped keeping a drain of its own. Twenty-one runs still on disk predate
 * that and say `ran <kind>` or `skip <kind> — why`, which a plain split on the
 * colon renders as a job kind called "ran materialize_sessions". One reader has
 * to read every record shape that was ever written, so the old prefix comes off
 * here rather than in a second renderer.
 */
const kindOf = (job) => {
  const s = String(job)
  const head = s.includes(':') ? s.slice(0, s.indexOf(':')) : s
  return head.replace(/^(?:ran|skip|skipped|failed)\s+/, '').split(' — ')[0].trim()
}

const AXES = [
  ['truth', 'did it do what it said?'],
  ['correctness', 'was it the right thing?'],
  ['friction', 'how much work did the person do?'],
  ['affordance', 'could they act, or must they type?'],
  ['capability', 'did it reach sideways, or only forward?'],
  ['plainness', 'would a busy person understand it on one read?'],
  ['cost', 'rounds and rupees against what the turn was worth'],
  ['consequence', 'did it leave the world in a state tomorrow can rely on?'],
  ['sideways', 'did anything else have a claim on what it changed?'],
]

const turns = rec.turns ?? []
const scored = turns.map(scoreOf).filter((s) => s !== null)
const mean = scored.length ? scored.reduce((a, b) => a + b, 0) / scored.length : null

/* -------------------------------------------------------------------------- *
 * The same run as plain text
 *
 * WHY THIS LIVES IN THE ONE READER
 * -----------------------------------------------------------------------------
 * `--text` is a second EMISSION, not a second reader: it walks the same
 * `record.json`, through the same helpers, in the same order the page does. The
 * rule this repo enforces is one reader per record shape, and six report
 * generators are what it cost to learn it. A parallel `dump-turns.mjs` would be
 * the seventh, and it would drift on the first field added here.
 *
 * It exists because the page is not the only thing that reads a run. An analysis
 * pass over 233 turns cannot open HTML, and the alternative measured on 22 Aug
 * 2026 was every reader hand-writing its own `JSON.parse` walk — twenty parsers,
 * twenty different opinions about which fields matter, and no way to tell a turn
 * somebody skipped from a turn somebody read.
 *
 *   node scripts/report.mjs --text                    # every turn, whole
 *   node scripts/report.mjs --text --from 40 --to 80  # turns 40..80
 *   node scripts/report.mjs --text --who queue        # one seat
 *   node scripts/report.mjs --text --day 12           # one day
 *
 * NOTHING IS TRUNCATED. Reasoning, statements, the rows they returned and the
 * message that went out are printed whole, because the turn where those disagree
 * is the turn worth reading and a clip is exactly where the disagreement hides.
 */
if (args.includes('--text')) {
  const num = (n) => (flag(n) === undefined ? undefined : Number(flag(n)))
  const from = num('from') ?? -Infinity
  const to = num('to') ?? Infinity
  const whoWanted = flag('who')
  const dayWanted = num('day')

  const J = (v) => {
    if (v === undefined) return 'undefined'
    if (typeof v === 'string') return v
    try { return JSON.stringify(v, null, 2) } catch { return String(v) }
  }
  const out = []
  const P = (s = '') => out.push(s)
  const indent = (s, pad) => String(s).split('\n').map((l) => pad + l).join('\n')

  P(`RUN ${basename(runPath)}   suite=${rec.suite}  model=${rec.model ?? '?'}  turns=${turns.length}`)
  if (rec.note) P(`note: ${rec.note}`)
  if (rec.arm) P(`arm: ${rec.arm}`)
  if (rec.world) P(`world: ${J(rec.world)}`)
  // Above everything, for the reason the page states above `departures`.
  const left = (() => {
    const fromTurns = turns
      .filter((t) => actionOf(t) === 'giveup')
      .map((t) => ({ persona: t.who ?? t.persona, day: t.day, window: t.window, say: t.say || reasonOf(t) }))
    if (fromTurns.length) return fromTurns
    return Array.isArray(rec.extra?.departures) ? rec.extra.departures : []
  })()
  if (left.length) {
    P('')
    P(`!! ${left.length} PEOPLE LEFT DURING THIS RUN — every day after is a smaller world:`)
    for (const d of left) P(`   ${d.persona} — day ${d.day}${d.window ? ', ' + d.window : ''}: "${d.say ?? '(left without a word)'}"`)
  }
  P('='.repeat(78))

  let shown = 0
  for (const t of turns) {
    if (t.n < from || t.n > to) continue
    if (whoWanted && String(t.who) !== whoWanted) continue
    if (dayWanted !== undefined && Number(t.day) !== dayWanted) continue
    shown++
    P('')
    P('#'.repeat(78))
    P(`TURN #${t.n}  ${t.id}   who=${t.who}  persona=${t.persona}  day=${t.day ?? '?'}  window=${t.window ?? '?'}`)
    P(`sent=${t.sent} wrote=${t.wrote} inr=${t.inr} ms=${t.ms} tokens=${J(t.tokens)}`)
    if (t.error) P(`!! ERROR: ${t.error}`)
    if (t.intent) P(`PERSONA INTENT: ${t.intent}`)
    if (t.personaReasoning) P(`PERSONA CHOSE: ${actionOf(t) ?? '(not recorded)'}\nPERSONA REASONING:\n${J(reasonOf(t))}`)
    if (t.say) P(`\nTHEY SAID:\n${t.say}`)
    else
      P(
        `\nTHEY SAID: (nothing — ${
          actionOf(t) === 'giveup' ? 'left without a word'
          : actionOf(t) === 'quiet' ? 'read it and said nothing'
          : 'no inbound; this is a job/queue turn'
        })`,
      )
    if (t.tapped) P(`\nTHEY TAPPED: ${J(t.tapped)}`)
    // The screen they decided against. The HTML render has always shown this and the
    // text render never did, so a giveup could only be judged by trusting the persona's
    // stated reasoning rather than by seeing what it saw (23 Aug week-sims read-back).
    if (t.phone) P(`\n--- WHAT THEIR PHONE SHOWED (when they decided) ---\n${t.phone}`)

    P(`\n--- ROUNDS (${(t.rounds ?? []).length}) ---`)
    for (const r of t.rounds ?? []) {
      P(`\n  [round ${r.round}] ${r.name}   turnId=${r.turnId ?? '?'}  ms=${r.ms ?? '?'}`)
      if (r.reasoning) P(`  REASONING:\n${indent(r.reasoning, '    ')}`)
      if (r.args !== undefined) P(`  ARGS:\n${indent(J(r.args), '    ')}`)
      if (r.result !== undefined) P(`  RESULT:\n${indent(J(r.result), '    ')}`)
      if (r.error) P(`  ROUND ERROR: ${J(r.error)}`)
    }

    const sql = t.sql ?? []
    const isRuntime = (x) => Boolean(String(x.note ?? '').trim())
    const modelSql = sql.filter((x) => !isRuntime(x))
    const runtimeSql = sql.filter(isRuntime)
    P(`\n--- SQL THE MODEL WROTE (${modelSql.length}) ---`)
    for (const q of modelSql) {
      P(`\n  [${q.kind}] role=${q.role} rows=${q.rowCount}${q.truncated ? ' TRUNCATED' : ''}${q.rolledBack ? ' PREVIEW — ROLLED BACK, wrote nothing durable' : ''} ms=${q.ms}`)
      P(indent(q.sql, '    '))
      P(`  ROWS: ${J(q.rows)}`)
      if (q.error) P(`  SQL ERROR: ${J(q.error)}`)
    }
    P(`\n--- SQL THE RUNTIME WROTE (${runtimeSql.length}, prefetches and census) ---`)
    for (const q of runtimeSql) P(`  [${q.note}] rows=${q.rowCount}${q.error ? ' ERROR ' + J(q.error) : ''}`)

    P(`\n--- MESSAGES OUT (${(t.messages ?? []).length}) ---`)
    for (const m of t.messages ?? []) {
      P(`  to=${m.to} origin=${m.origin} status=${m.status}${m.suppressedReason ? ' SUPPRESSED=' + m.suppressedReason : ''}`)
      P(indent(m.body ?? '', '    | '))
      if (m.buttons?.length) P(`    BUTTONS: ${J(m.buttons)}`)
    }

    if ((t.changed ?? []).length) {
      P(`\n--- ROWS CHANGED (${t.changed.length}) ---`)
      for (const c of t.changed) P(`  ${J(c)}`)
    }
    if ((t.jobs ?? []).length) P(`\n--- JOBS THIS TURN ---\n  ${[...t.jobs].join(', ')}`)
  }
  P('')
  P('='.repeat(78))
  P(`${shown} turns printed of ${turns.length}.`)
  const dest = flag('out')
  if (dest) {
    writeFileSync(dest, out.join('\n'))
    console.log(`  wrote ${dest}`)
  } else console.log(out.join('\n'))
  process.exit(0)
}

/* -------------------------------------------------------------------------- *
 * The page
 * -------------------------------------------------------------------------- */

let body = ''

const suite = rec.suite ?? 'run'

/**
 * The name of the run, and a judged run gets to name itself.
 *
 * A generated title is a label; a written one is a claim. The month report worth
 * reading was called *"The month it told her she was unsubscribed"*, which is a
 * finding in five words and does more work than any date could. So `judgement.json`
 * may set `title`, and the fallback is the plain fact of what was driven and when.
 */
const stampOf = basename(runPath).replace(/-[a-z]+$/, '').replace(/-(\d{2})-(\d{2})$/, ' $1:$2')
const title = judgement?.title ?? `${suite} · ${stampOf}`

body += `<h1>${esc(title)}</h1>`
body += `<p class="sub">${esc(rec.note ?? '')}</p>`
body += `<p class="dim">${esc(basename(runPath))} · suite <code>${esc(suite)}</code> · model <code>${esc(rec.model ?? '?')}</code> · ${turns.length} turns · ${
  judgement ? `read and scored by hand${judgement.judge ? ` — ${esc(judgement.judge)}` : ''}` : 'not yet judged'
}</p>`

/* --- the verdict ---------------------------------------------------------- */

if (judgement?.verdict) {
  body += `<div class="lead"><b>The verdict in one line:</b> ${esc(judgement.verdict)}</div>`
} else {
  body += `<div class="lead"><b>Nothing here is scored.</b> This page is evidence — every turn, everything it
  thought, every statement it sent and what came back. The verdict is written by a reader into
  <code>${esc(join(runPath, 'judgement.json'))}</code>; <b>JUDGING.md</b> is how. Re-run this after and the
  scores appear beside the turns.</div>`
}

/* --- who left, before any number ------------------------------------------ */

/**
 * The most consequential thing a drive can produce, in the position that says so.
 *
 * `record.json` has carried `extra.departures` — persona, day, and the last thing
 * they typed — for as long as the seats have been agents, and this page has never
 * printed it. The turn-level tag exists, two hundred rows down an accordion, and
 * that is not the same as saying it.
 *
 * WHAT THAT COST, and it is the reason this block sits ABOVE the stat row rather
 * than beside it: on `2026-08-22-16-51-sim-b8xo` the OWNER of the business walked
 * out on day 20 — *"i told you 1000 both times and you said it was recorded. if
 * it's not stuck by now this isnt working, im done setting this up"* — and the
 * run was read, five times over the following six hours, as *"233 turns, ZERO
 * errors, the business live, the whole standing surface running."* Every one of
 * those readings is true of the numbers. All five commits that came out of them
 * improved messages sent to a man who had already left, and two of them ADDED
 * standing asks, when the recorded cause of death was being asked something he
 * had already answered.
 *
 * A run that ends with its operator gone is not a run with a good mean score. It
 * is a run whose remaining days measured an empty room, and the reader has to say
 * that before it says anything else.
 */
/**
 * Derived from the TURNS, with `extra.departures` as a fallback rather than the
 * source. `extra` is only assembled on a full close and came back `{}` on
 * `2026-08-22-19-36-sim-4xsq` — a run whose day-2 departure is sitting in
 * `personaReasoning.action` on the turn itself, where `actionOf` has always been
 * able to see it. Reading the roll-up alone reintroduced the very silence this
 * block exists to end, through a different door.
 */
const departures = (() => {
  const fromTurns = turns
    .filter((t) => actionOf(t) === 'giveup')
    .map((t) => ({ persona: t.who ?? t.persona, day: t.day, window: t.window, say: t.say || reasonOf(t) }))
  if (fromTurns.length) return fromTurns
  return Array.isArray(rec.extra?.departures) ? rec.extra.departures : []
})()
if (departures.length) {
  body += `<div class="lead bad"><b>${departures.length} ${departures.length === 1 ? 'person' : 'people'} left during this run.</b>
  Everything below is measured over a world that got smaller as it went.
  <ul>${departures
    .map(
      (d) =>
        `<li><b>${esc(d.persona ?? '?')}</b> — day ${esc(String(d.day ?? '?'))}${d.window ? `, ${esc(d.window)}` : ''}:
         <i>“${esc(d.say ?? '(left without a word)')}”</i></li>`,
    )
    .join('')}</ul></div>`
}

/* --- the lifecycle, when the record carries it ----------------------------- */

/**
 * `extra.lifecycle` is the arc as first-timestamps — founded, first class,
 * first enrolment, through billed → paid — written by `sim.ts` at close for the
 * exit-bar question. Timestamps and nulls, never a verdict: a null against a
 * three-day run is a fact about the run's length, and the judge is who says so.
 */
const lifecycle = rec.extra?.lifecycle
if (lifecycle && typeof lifecycle === 'object') {
  const STAGES = [
    ['founded', 'business founded'],
    ['first_class', 'first class'],
    ['first_enrollment', 'first enrolment'],
    ['first_session', 'first session scheduled'],
    ['first_session_completed', 'first session completed'],
    ['first_attendance', 'first attendance marked'],
    ['first_tally_line', 'first tally line (billed)'],
    ['first_month_end_tally_done', 'month-end tally ran'],
    ['first_payment_requested', 'first payment requested'],
    ['first_payment_confirmed', 'first payment confirmed'],
  ]
  body += `<div class="lead"><b>The lifecycle, as first-timestamps.</b>
  <table>${STAGES.map(([k, label]) => {
    const v = lifecycle[k]
    return `<tr><td>${esc(label)}</td><td>${v ? esc(String(v)) : '<i>— never</i>'}</td></tr>`
  }).join('')}</table></div>`
}

/* --- the numbers ---------------------------------------------------------- */

const totalInr = turns.reduce((a, t) => a + (Number(t.inr) || 0), 0)
const totalSent = turns.reduce((a, t) => a + (Number(t.sent) || 0), 0)
const totalWrote = turns.reduce((a, t) => a + (Number(t.wrote) || 0), 0)
const allSql = turns.flatMap((t) => t.sql ?? [])
const refused = allSql.filter((s) => s.error)
const emptyWrites = allSql.filter((s) => s.kind !== 'read' && s.rowCount === 0)
// Seat turns where somebody actually typed. A person who typed and got nothing
// back is a finding; a window where the queue came due and had nothing to say is
// a quiet Tuesday; a persona who read their phone and chose not to answer is a
// third thing again, and it belongs to them rather than to the bot. All three
// look identical — no reply — and counting them together buries the first.
const silent = turns.filter((t) => !t.reply && !isQueue(t) && spoke(t))
const walkedOff = turns.filter(walkedAway)
const days = new Set(turns.map((t) => t.day).filter((d) => d !== undefined))

body += `<div class="stats">
  ${mean === null ? '' : `<div class="stat"><b>${n2(mean)}<span style="font-size:1rem"> /10</span></b><span>mean, ${scored.length} scored turns</span></div>`}
  <div class="stat"><b>${turns.length}</b><span>turns${days.size ? ` over ${days.size} days` : ''}</span></div>
  <div class="stat"><b>${totalSent}</b><span>messages sent</span></div>
  <div class="stat"><b>${totalWrote}</b><span>rows written</span></div>
  <div class="stat"><b>${allSql.length}</b><span>statements${refused.length ? `, ${refused.length} refused` : ''}</span></div>
  <div class="stat"><b>${inr(totalInr)}</b><span>the whole run</span></div>
</div>`

/* --- the split ------------------------------------------------------------ */

const personas = [...new Set(turns.map((t) => t.persona))].filter(Boolean)
if (personas.length > 1) {
  body += `<h2>The split</h2>
  <p>Averaging a run hides the only thing worth knowing about it. Split by whose phone the message came
  from and a list of incidents becomes a finding — the previous month's every-catastrophic-turn-is-a-client-turn
  was invisible in its mean and obvious in this table.</p>
  ${
    turns.some(isQueue)
      ? `<p><code>queue</code> is not a person. It is the proactive surface — every brief, digest, nudge and
  dunning message that went out because a job came due rather than because somebody asked. It is a row here
  because until 20 Aug 2026 it was in no row at all: the drains ran outside the recorder, so the majority of
  what this product says cost, by the instrument's own arithmetic, nothing.</p>`
      : ''
  }
  <div class="scroll"><table><thead><tr><th>persona</th><th>turns</th>${mean === null ? '' : '<th>mean</th><th>worst</th>'}<th>rows written</th><th>sent</th><th>refused SQL</th><th>cost</th></tr></thead><tbody>`
  for (const p of personas) {
    const mine = turns.filter((t) => t.persona === p)
    const ss = mine.map(scoreOf).filter((s) => s !== null)
    const sql = mine.flatMap((t) => t.sql ?? [])
    body += `<tr><td><b>${esc(p)}</b></td><td>${mine.length}</td>${
      mean === null
        ? ''
        : `<td>${ss.length ? n2(ss.reduce((a, b) => a + b, 0) / ss.length) : '—'}</td><td>${ss.length ? Math.min(...ss) : '—'}</td>`
    }<td>${mine.reduce((a, t) => a + (Number(t.wrote) || 0), 0)}</td><td>${mine.reduce((a, t) => a + (Number(t.sent) || 0), 0)}</td><td>${
      sql.filter((s) => s.error).length
    }</td><td>${inr(mine.reduce((a, t) => a + (Number(t.inr) || 0), 0))}</td></tr>`
  }
  body += `</tbody></table></div>`
}

/* --- what the instrument can see on its own ------------------------------- */

body += `<h2>What the instrument can see on its own</h2>
<p>Four shapes are facts rather than readings, and each one is invisible in a transcript. They are not
verdicts — a write that matched nothing can be a correct no-op, and a person who says nothing may simply
have nothing to say — but every instance of the failure they name lives inside them, so they are worth
reading first.</p>`

if (refused.length) {
  body += `<h3>Statements Postgres refused <span class="dim">— ${refused.length}</span></h3>
  <p class="dim">Each one cost a round, and inside a plan each one takes every correct step beside it down with it.</p>`
  for (const s of refused) {
    body += `<div class="stmt"><div class="hd">refused as <code>${esc(s.role)}</code></div><pre>${esc(s.sql)}</pre><div class="err">${esc(s.error)}</div></div>`
  }
} else if (allSql.length) {
  body += `<h3>Statements Postgres refused <span class="dim">— none</span></h3>`
}

if (emptyWrites.length) {
  body += `<h3>Writes that matched nothing and raised nothing <span class="dim">— ${emptyWrites.length}</span></h3>
  <p class="dim">The dangerous half. Postgres reports success on an <code>update … where</code> that matches no rows,
  so the reply says it is done and the tables disagree. Only a read-back can tell.</p>`
  for (const s of emptyWrites) {
    body += `<div class="stmt"><div class="hd">${esc(s.kind)} · 0 rows</div><pre>${esc(s.sql)}</pre></div>`
  }
}

if (silent.length) {
  body += `<h3>Turns that said nothing <span class="dim">— ${silent.length}</span></h3>
  <p class="dim">Somebody typed and nothing came back. ${silent.map((t) => `#${t.n} ${esc(t.id)}`).join(' · ')}</p>`
}

/**
 * The windows a person let pass, and the one they left in.
 *
 * A quiet turn and a departure are both recorded as a turn with nothing typed
 * and nothing sent, which is indistinguishable from a seat that broke — the
 * reasoning attached is the only place the difference is written down, and until
 * this section existed the page rendered the most consequential thing a week can
 * produce as a blank row. A run driven by people rather than agents has none of
 * these, and the section is absent rather than empty.
 */
if (walkedOff.length) {
  const left = walkedOff.filter((t) => actionOf(t) === 'giveup')
  body += `<h3>Windows nobody answered${left.length ? ', and the ones they left in' : ''} <span class="dim">— ${
    walkedOff.length
  }${left.length ? `, ${left.length} of them a departure` : ''}</span></h3>
  <p class="dim">A persona agent may read its phone and put it down, or decide it is finished with you. Neither
  is a failure of the harness and neither is a failure of the model on its own — but a client who stops
  replying is the outcome the business cares about most, and it is nowhere in a transcript, because the
  evidence for it is a message that was never sent.</p>`
  for (const t of walkedOff) {
    const gone = actionOf(t) === 'giveup'
    const when = whenOf(t)
    body += `<div class="stmt"><div class="hd"><a href="#t${t.n}">#${t.n} ${esc(t.id)}</a> · <b>${esc(
      t.persona,
    )}</b>${when ? ` · ${esc(when)}` : ''} · ${
      gone ? '<span class="bad">finished with them</span>' : '<span class="amber">read it and said nothing</span>'
    }</div>`
    if (t.intent) body += `<div class="hd">what they were after</div><pre>${capped(t.intent)}</pre>`
    if (spoke(t)) body += `<div class="hd">their parting message</div><blockquote><p>${esc(t.say)}</p></blockquote>`
    const why = reasonOf(t)
    if (why !== '') body += `<div class="hd">how they read the last reply</div><pre>${capped(why)}</pre>`
    body += `</div>`
  }
}

/* --- every turn, scored --------------------------------------------------- */

body += `<h2>Every turn</h2>`
if (!judgement) {
  body += `<p class="dim">Unscored — the score column fills in once <code>judgement.json</code> exists beside the record.</p>`
}
body += `<div class="scroll"><table><thead><tr><th>#</th><th>turn</th><th>who</th>${
  mean === null ? '' : '<th>score</th>'
}<th>rounds</th><th>r/w</th><th>rows</th><th>sent</th><th>secs</th>${mean === null ? '' : '<th>the reason</th>'}</tr></thead><tbody>`
for (const t of turns) {
  const s = scoreOf(t)
  const j = judged.get(t.n)
  const sql = t.sql ?? []
  body += `<tr class="${band(s)}"><td>${t.n}</td><td><a href="#t${t.n}">${esc(t.id)}</a></td><td>${esc(t.persona)}</td>${
    mean === null ? '' : `<td><b>${s ?? '—'}</b></td>`
  }<td>${(t.rounds ?? []).filter((r) => r.name === '(model)').length || (t.rounds ?? []).length}</td><td>${
    sql.filter((x) => x.kind === 'read').length
  }/${sql.filter((x) => x.kind !== 'read').length}</td><td>${t.wrote ?? 0}</td><td>${t.sent ?? 0}</td><td>${
    ((t.ms ?? 0) / 1000).toFixed(1)
  }</td>${mean === null ? '' : `<td>${esc(j?.reason ?? '')}</td>`}</tr>`
}
body += `</tbody></table></div>`

/* --- the seven axes ------------------------------------------------------- */

if (judgedTurns.some((t) => t.axes)) {
  body += `<h2>The seven axes</h2>
  <p>Seven for a turn, plus the two only a driven arc can ask. Definitions and the 0–10 calibration are in
  <b>JUDGING.md</b>.</p>
  <div class="scroll"><table><thead><tr><th>axis</th><th>mean</th><th>worst</th><th>where it went</th></tr></thead><tbody>`
  for (const [key, gloss] of AXES) {
    const vals = judgedTurns.map((t) => t.axes?.[key]).filter((v) => typeof v === 'number')
    if (!vals.length) continue
    const worstAt = judgedTurns
      .filter((t) => t.axes?.[key] === Math.min(...vals))
      .map((t) => `#${t.n} ${t.id ?? ''}`)
      .join(', ')
    body += `<tr><td><b>${esc(key)}</b><br><span class="dim">${esc(gloss)}</span></td><td>${n2(
      vals.reduce((a, b) => a + b, 0) / vals.length,
    )}</td><td>${Math.min(...vals)}</td><td class="dim">${esc(worstAt)}</td></tr>`
  }
  body += `</tbody></table></div>`
}

/* --- cost ----------------------------------------------------------------- */

const tin = turns.reduce((a, t) => a + (t.tokens?.prompt ?? 0), 0)
const tcache = turns.reduce((a, t) => a + (t.tokens?.cached ?? 0), 0)
const tout = turns.reduce((a, t) => a + (t.tokens?.output ?? 0), 0)
const totalMs = turns.reduce((a, t) => a + (t.ms ?? 0), 0)

body += `<h2>What it cost</h2>
<div class="scroll"><table><thead><tr><th>turns</th><th>prompt</th><th>cached</th><th>output</th><th>mean latency</th><th>total</th></tr></thead>
<tbody><tr><td>${turns.length}</td><td>${tin.toLocaleString()}</td><td>${
  tin ? Math.round((100 * tcache) / tin) : 0
}%</td><td>${tout.toLocaleString()}</td><td>${turns.length ? (totalMs / turns.length / 1000).toFixed(1) : '—'}s</td><td>${inr(
  totalInr,
)}</td></tr></tbody></table></div>
<p class="dim">Rounds are the driver: the stable prefix is paid on every uncached round, so a turn that went
round twice cost twice. WhatsApp cannot stream, so the seconds above are seconds of silence.</p>`

/* --- the inside of every turn --------------------------------------------- */

body += `<h2>Inside every turn</h2>
<p>All of them, not a hand-picked few. A report that shows outcomes and hides the inside of the turn cannot
tell a model that did not know from a model that knew and could not.</p>`

let day = null
let win = null
for (const t of turns) {
  if (t.day !== undefined && t.day !== day) {
    day = t.day
    win = null
    body += `<h3>Day ${day}</h3>`
  }
  /**
   * The window, under the day, because the day is not the grain anybody reads a
   * week at: three people speaking across one Tuesday are three rows carrying
   * the same number, and the question a reader has is almost always about a
   * window. Reset with the day so the first window of a new day always prints.
   */
  if (t.window !== undefined && t.window !== win) {
    win = t.window
    body += `<h4 class="win">${esc(win)}</h4>`
  }
  const s = scoreOf(t)
  const j = judged.get(t.n)
  const sql = t.sql ?? []
  /**
   * The model's own statements, apart from the runtime's.
   *
   * This filter looked for a note beginning `harness` and no call site has ever
   * written one — the runtime's prefetches are labelled `prefetch: …` and the
   * census carries its own label (`lib/agent/context.ts`). So the filter passed
   * everything, and every run ever rendered showed the runtime's own reads under
   * *"What it sent to Postgres"*, in the section a judge reads to decide whether
   * the MODEL looked something up before answering. Attributing the context
   * layer's work to the model is the opposite of the question being asked.
   *
   * Split rather than hidden: both sets are rendered, separately labelled and
   * separately counted, so nothing is dropped and the attribution is right.
   */
  const isRuntime = (x) => Boolean(String(x.note ?? '').trim())
  const modelSql = sql.filter((x) => !isRuntime(x))
  const runtimeSql = sql.filter(isRuntime)

  const act = actionOf(t)

  body += `<details class="turn ${band(s)}" id="t${t.n}"><summary>`
  if (s !== null) body += `<span class="score">${s}</span>`
  body += `<b>#${t.n} ${esc(t.id)}</b> <span class="tag">${esc(t.persona)}</span> <span class="tag">${esc(t.who)}</span>`
  if (t.window) body += ` <span class="tag">${esc(t.window)}</span>`
  if (act === 'quiet') body += ` <span class="tag amber">said nothing</span>`
  if (act === 'giveup') body += ` <span class="tag bad">left</span>`
  if (j?.finding) body += ` <span class="tag">${esc(j.finding)}</span>`
  /**
   * The one line of a closed turn, and it has to say something for every kind of
   * turn there is. A quiet move has an empty `say`, so before 20 Aug 2026 the
   * outcome that ends a relationship rendered as a blank strip of card.
   */
  const preview =
    isQueue(t) ? [...new Set(t.jobs ?? [])].join(' · ')
    : spoke(t) ? String(t.say ?? '')
    : act === 'giveup' ? 'left without a word'
    : act === 'quiet' ? 'read it and said nothing'
    : ''
  body += `<div class="who">${esc(preview.slice(0, 150))}</div>`
  // Untruncated, and it is one line by contract — `_persona-agent` asks for
  // "what you are trying to get out of them, in your own words, one line".
  if (t.intent) body += `<div class="who intent">trying to: ${esc(t.intent)}</div>`
  body += `</summary>`

  if (j?.reason) body += `<blockquote><p><b>Read as:</b> ${esc(j.reason)}</p></blockquote>`
  if (j?.axes) {
    body += `<p class="dim">${AXES.filter(([k]) => typeof j.axes[k] === 'number')
      .map(([k]) => `${k} ${j.axes[k]}`)
      .join(' · ')}</p>`
  }

  /**
   * What the harness could not collect, FIRST and loud.
   *
   * A turn missing its evidence looks exactly like a turn where nothing
   * happened — no rounds, no tokens, ₹0 — and every number below is read off
   * queries that may be the ones that failed. A reader has to know that before
   * they read any of it, not after.
   */
  if (Array.isArray(t.notes) && t.notes.length) {
    body += `<div class="err"><b>The harness could not collect part of this turn.</b> Everything below is
    incomplete by that much, and a zero here may be a failure rather than a fact.<ul>${t.notes
      .map((n) => `<li>${esc(n)}</li>`)
      .join('')}</ul></div>`
  }

  if (isQueue(t)) {
    const kinds = [...new Set((t.jobs ?? []).map(kindOf))]
    body += `<h4>What ran <span class="dim">— nobody typed; the queue came due</span></h4>
    <p>${(t.jobs ?? []).length} job${(t.jobs ?? []).length === 1 ? '' : 's'}${
      kinds.length ? `, ${kinds.length} kind${kinds.length === 1 ? '' : 's'}: ${kinds.map((k) => `<code>${esc(k)}</code>`).join(', ')}` : ''
    }.</p>`
  } else {
    /**
     * The person's half of the turn, in the order they lived it: they read the
     * last reply, they decided what they wanted out of this one, and then they
     * typed — or did not.
     *
     * All three used to be one line of `say`. A record that keeps only the
     * sentence cannot tell a person who was misunderstood from a person who
     * changed their mind, and the same question asked twice reads as one row
     * repeated rather than as the finding it is.
     */
    const why = reasonOf(t)
    if (why !== '') {
      body += `<h4>How they read the last reply <span class="dim">— the person's own reasoning, not the bot's</span></h4>
      <div class="think"><pre>${capped(why)}</pre></div>`
    }
    if (t.intent) body += `<h4>What they were trying to get</h4><p>${esc(t.intent)}</p>`
    /**
     * The screen they answered, before what they did about it.
     *
     * The record held the decision and not the stimulus, so a departure —
     * the most consequential thing a driven week produces — could be read but
     * not explained. This is the blindfolded view as it was actually rendered,
     * not a reconstruction: rebuilding it here would risk showing a reader a
     * message the real recipient never received.
     */
    if (t.phone) {
      body += `<h4>What their phone showed <span class="dim">— the whole of what they could see</span></h4>
      <div class="think"><pre>${capped(t.phone)}</pre></div>`
    }

    if (spoke(t)) {
      body += `<h4>What they typed${
        act === 'giveup' ? ' <span class="dim">— on their way out</span>' : ''
      }</h4><blockquote><p>${esc(t.say)}</p></blockquote>`
    } else {
      // A turn where nobody typed, rendered as the outcome it is rather than as
      // an empty blockquote — which is what it was, and which reads as a harness
      // that dropped somebody's message.
      body += `<h4>What they did <span class="dim">— nothing was typed</span></h4><p>${
        act === 'giveup'
          ? 'They read their phone and were finished. Nothing was sent, and they did not say why to anybody but themselves.'
          : act === 'quiet'
            ? 'They read their phone and put it down. Nothing was sent.'
            : 'Nothing was typed, and the record does not say whether that was a choice.'
      }</p>`
    }
  }

  const rounds = t.rounds ?? []

  /* what it was told */
  //
  // Ahead of the thinking, because it is what the thinking is a response to.
  // Absent unless the run was driven with the full trace on — and absent is the
  // honest rendering, since a run recorded without it genuinely does not know.
  //
  // This section exists because five judges read a live week with what was called
  // complete visibility and none could see the one sentence that caused its worst
  // turns: a prefetch had died, the tail said so without saying why, and the tail
  // was written down nowhere. The failures it exposes are usually ABSENCES — a
  // dead prefetch removes its paragraph and leaves nothing behind — so the only
  // artifact that can show one is the tail itself, whole.
  const told = rounds.find((r) => r.name === '(context)')
  if (told) {
    const a = told.args ?? {}
    const tail = typeof a.tail === 'string' ? a.tail : ''
    const missed = (tail.match(/could not be read this turn/g) ?? []).length
    body += `<h4>What it was told <span class="dim">— the turn's own context, ${
      tail.length.toLocaleString()
    } chars of tail over a ${
      Number(a.prefix?.chars ?? 0).toLocaleString()
    }-char cached prefix${
      missed ? `, <span class="bad">${missed} failed lookup${missed === 1 ? '' : 's'} named</span>` : ''
    }</span></h4>`
    /**
     * The cut the model was handed, said where the model's copy is shown.
     *
     * `sql` below records these same reads WHOLE and flags them `truncated:
     * false`, because that flag is about the log's copy. Without this line a
     * reader compares a complete result against an answer that ignored it and
     * concludes the model was careless, when it was starved.
     */
    // Recounted from the tail when the field is absent, so every run already on
    // disk gets the warning too — the cut is in their bytes, only the count is new.
    const cuts = Number(t.contextCuts ?? (tail.match(/… \(truncated\)/g) ?? []).length)
    if (cuts) {
      body += `<div class="err">${cuts} replayed read${cuts === 1 ? ' was' : 's were'} <b>cut at 1,400
      characters before the model saw ${cuts === 1 ? 'it' : 'them'}</b>, mid-token. The same reads appear
      whole under “What it sent to Postgres” — that copy is the log's, not the model's. Judge the answer
      against what is in this block, not against what is in that one.</div>`
    }
    body += `<div class="think"><pre>${capped(tail)}</pre></div>`
  }

  /* the thinking */
  const thinking = rounds.filter((r) => r.reasoning)
  if (thinking.length) {
    /**
     * A drain is several handlers in one record and `round` restarts at 0 for
     * each, so an unlabelled list of thirty rounds reads as one deliberation
     * that never happened. Where more than one product turn is in here, the
     * round is labelled with which act it belongs to.
     */
    const acts = [...new Set(rounds.map((r) => r.turnId).filter(Boolean))]
    body += `<h4>What it was thinking <span class="dim">— ${thinking.length} round${
      thinking.length === 1 ? '' : 's'
    }${acts.length > 1 ? ` across ${acts.length} separate product turns` : ''}</span></h4>`
    for (const r of thinking) {
      const which = acts.length > 1 && r.turnId ? ` · act ${acts.indexOf(r.turnId) + 1} of ${acts.length}` : ''
      body += `<div class="think"><div class="hd">round ${r.round}${which}</div><pre>${capped(r.reasoning)}</pre></div>`
    }
  } else if (rounds.length) {
    body += `<h4>What it was thinking</h4><p class="dim">No reasoning recorded on any round. If the model
    deliberated, the instrument did not see it — check the run, not the model.</p>`
  }
  // Prose a round wrote before any tool ran. Kept apart from the reasoning
  // because it is a different thing: a draft is a sentence the model considered
  // SENDING, and a draft that never reached anybody is how "it knew and said it
  // anyway" is told apart from "it never knew".
  const drafts = rounds.filter((r) => r.drafted)
  if (drafts.length) {
    body += `<h4>What it drafted <span class="dim">— before any tool ran</span></h4>`
    for (const r of drafts) {
      body += `<div class="think"><div class="hd">round ${r.round}</div><pre>${capped(r.drafted)}</pre></div>`
    }
  }

  /* the tool calls */
  const calls = rounds.filter((r) => r.name && !String(r.name).startsWith('('))
  // `(`-named rows are the RUNTIME acting — the granted-round marker, a held
  // draft's disposition, a job turn's discarded trailing prose. The page used to
  // filter them out entirely, so a reader who only opened the HTML could not see
  // the runtime intervene at all (`--text` showed them; the page did not), and
  // the one thing the exits chapter is about was invisible on the default view.
  const runtimeActs = rounds.filter(
    (r) => r.name && String(r.name).startsWith('(') && r.name !== '(model)' && r.name !== '(context)',
  )
  if (runtimeActs.length) {
    body += `<h4>What the runtime did <span class="dim">— not the model's own calls</span></h4>`
    for (const r of runtimeActs) {
      body += `<div class="stmt"><div class="hd">round ${r.round} · <code>${esc(r.name)}</code></div>`
      if (r.args !== undefined && r.args !== null && String(r.args).length) body += `<pre>${capped(r.args)}</pre>`
      if (r.result !== undefined && r.result !== null) body += `<div class="hd">came back</div><pre>${capped(r.result)}</pre>`
      if (r.error) body += `<div class="err">${esc(r.error)}</div>`
      body += `</div>`
    }
  }
  if (calls.length) {
    body += `<h4>What it reached for <span class="dim">— ${calls.map((r) => r.name).join(', ')}</span></h4>`
    for (const r of calls) {
      // `ms` is what the recorder wrote, and not every driver writes one. Printed
      // only when it exists: `undefinedms` on a page of evidence reads as a
      // measurement that was taken and lost.
      body += `<div class="stmt"><div class="hd">round ${r.round} · <code>${esc(r.name)}</code>${
        Number.isFinite(r.ms) ? ` · ${r.ms}ms` : ''
      }${
        r.error ? ' · <span class="bad">error</span>' : ''
      }</div><pre>${capped(r.args)}</pre>`
      if (r.result !== undefined && r.result !== null) body += `<div class="hd">came back</div><pre>${capped(r.result)}</pre>`
      if (r.error) body += `<div class="err">${esc(r.error)}</div>`
      body += `</div>`
    }
  }

  /* the statements */
  if (runtimeSql.length) {
    body += `<h4>What the runtime read for it <span class="dim">— ${runtimeSql.length} prefetch${
      runtimeSql.length === 1 ? '' : 'es'
    }, before the model was asked anything. Not the model looking something up.</span></h4>`
    for (const x of runtimeSql) {
      const head = `${x.note ?? 'prefetch'} · ${x.rowCount ?? '?'} rows${x.ms ? ` · ${x.ms}ms` : ''}`
      body += `<div class="stmt"><div class="hd">${esc(head)}</div><pre>${esc(x.sql)}</pre>`
      if (x.error) body += `<div class="err">${esc(x.error)}</div>`
      body += `</div>`
    }
  }

  if (modelSql.length) {
    body += `<h4>What it sent to Postgres <span class="dim">— ${modelSql.length} statement${
      modelSql.length === 1 ? '' : 's'
    }, ${modelSql.filter((x) => x.kind === 'read').length} read, ${modelSql.filter((x) => x.kind !== 'read').length} write${
      modelSql.filter((x) => x.error).length ? `, ${modelSql.filter((x) => x.error).length} refused` : ''
    }</span></h4>`
    for (const x of modelSql) {
      const head = x.error
        ? `<span class="bad">refused</span> as <code>${esc(x.role)}</code>`
        : `<span class="${x.kind === 'read' ? 'read' : 'write'}">${esc(x.kind)}</span> · ${x.rowCount} row${
            x.rowCount === 1 ? '' : 's'
          }${x.truncated ? ' <span class="bad">(TRUNCATED at the cap)</span>' : ''}${
            x.rolledBack ? ' <span class="amber">— preview pass, rolled back</span>' : ''
          }${
            x.kind !== 'read' && x.rowCount === 0 ? ' <span class="amber">— matched nothing, raised nothing</span>' : ''
          }`
      body += `<div class="stmt"><div class="hd">${head}</div><pre>${esc(x.sql)}</pre>`
      if (x.error) body += `<div class="err">${esc(x.error)}</div>`
      if (x.rows?.length) body += `<div class="hd">came back</div><pre>${capped(x.rows)}</pre>`
      body += `</div>`
    }
  }

  /* what moved */
  const moved = worldDiff(t.beforeTap, t.afterTap)
  const changed = Array.isArray(t.changed) ? t.changed : null
  body += `<h4>What it did</h4><p>Committed <b>${t.wrote ?? 0}</b> audited plan${
    (t.wrote ?? 0) === 1 ? '' : 's'
  }${changed?.length ? `, touching <b>${changed.length}</b> row${changed.length === 1 ? '' : 's'}` : ''}, and reached <b>${t.sent ?? 0}</b> ${(t.sent ?? 0) === 1 ? 'phone' : 'phones'}.${
    moved.length ? ` Moved: ${moved.map((m) => `<code>${esc(m)}</code>`).join(', ')}.` : ''
  }</p>`
  body += changedTable(changed, t.wrote ?? 0)
  if (t.jobs?.length) body += `<p class="dim">Queue: ${esc(t.jobs.join(' · '))}</p>`

  /* what they read */
  body += isQueue(t)
    ? `<h4>What went out unprompted <span class="dim">— nobody had asked for any of this</span></h4><pre>${esc(
        t.reply ?? '(the queue ran and said nothing to anybody)',
      )}</pre>`
    : // "Nothing was sent" is an accusation, and on a turn where nobody typed it
      // is aimed at the wrong party: there was no message to answer.
      `<h4>What the person read</h4><pre>${esc(
        t.reply ?? (spoke(t) ? '(nothing was sent)' : '(they sent nothing, so nothing came back)'),
      )}</pre>`
  if (t.buttons?.length) body += `<p>${t.buttons.map((b) => `<span class="btn">${esc(b)}</span>`).join(' ')}</p>`
  /**
   * The other two affordances, which the record kept none of until now.
   *
   * A list menu and a link are taps on a real phone, and a reply carrying only
   * one of them used to render here as nothing at all — the same as a wall of
   * text. F-BC's count of "messages with something to tap" is measured on
   * `buttons` alone, so anything that shows up on this line is evidence that
   * count is a floor.
   */
  const listRows = (t.messages ?? []).flatMap((m) => m.listRows ?? [])
  const links = (t.messages ?? []).map((m) => m.link).filter(Boolean)
  if (listRows.length || links.length) {
    body += `<p class="dim">Also tappable, and not counted as buttons: ${[
      ...listRows.map((r) => `<span class="btn">${esc(r)}</span>`),
      ...links.map((l) => `<span class="btn">${esc(l)} ↗</span>`),
    ].join(' ')}</p>`
  }
  if (t.tapped) body += `<p class="dim">The harness tapped <b>${esc(t.tapped)}</b>.</p>`
  const suppressed = (t.messages ?? []).filter((m) => m.suppressedReason)
  if (suppressed.length) {
    body += `<p class="dim">${suppressed.length} message${suppressed.length === 1 ? '' : 's'} stopped before sending: ${esc(
      [...new Set(suppressed.map((m) => m.suppressedReason))].join(', '),
    )}</p>`
  }

  body += `<p class="dim">${((t.ms ?? 0) / 1000).toFixed(1)}s · ${(t.tokens?.prompt ?? 0).toLocaleString()} in / ${(
    t.tokens?.output ?? 0
  ).toLocaleString()} out · ${inr(Number(t.inr))}</p>`
  if (t.error) body += `<div class="err">${esc(t.error)}</div>`
  body += `</details>`
}

/**
 * The rows this turn changed, both sides — the section that used to be empty.
 *
 * `worldDiff` above answers "how many of each thing are there now", and only
 * `probe-sql` ever filled the two snapshots it reads, so on every sim, live and
 * probe-model run ever recorded this part of the page rendered nothing. `changed`
 * is filled by every driver, because the database took the photographs itself.
 *
 * The summary line per row is a rendering and not a stored verdict: which keys
 * differ is recomputed here, from the images, every time the page is built. The
 * images themselves go under it whole — `capped` announces a clip if one bites.
 *
 * Absent and empty are different and are said differently: a run recorded before
 * `changed` existed says so, rather than claiming the turn touched nothing.
 */
function changedTable(changed, wrote) {
  if (changed === null) {
    return wrote > 0
      ? `<p class="dim">This run predates row-level capture, so what those ${wrote} plan${
          wrote === 1 ? '' : 's'
        } changed is not on the record — only that they committed.</p>`
      : ''
  }
  if (!changed.length) return ''

  const byAudit = new Map()
  for (const c of changed) {
    if (!byAudit.has(c.auditId)) byAudit.set(c.auditId, [])
    byAudit.get(c.auditId).push(c)
  }

  let out = ''
  for (const [auditId, rows] of byAudit) {
    const intent = rows[0]?.intent
    out += `<details class="stmt"><summary>${esc(intent || '(no stated intent)')} <span class="dim">— ${
      rows.length
    } row${rows.length === 1 ? '' : 's'} · ${esc(String(auditId).slice(0, 8))}</span></summary>`
    out += `<div class="scroll"><table><tbody>`
    for (const c of rows) {
      out += `<tr><td><code>${esc(c.table)}</code></td><td>${esc(c.op)}</td><td class="dim">${esc(
        String(c.pk ?? '—').slice(0, 8),
      )}</td><td>${esc(fieldsMoved(c).join(', ') || '—')}</td></tr>`
    }
    out += `</tbody></table></div>`
    for (const c of rows) {
      out += `<div class="hd">${esc(c.table)} · ${esc(c.op)} · ${esc(String(c.pk ?? '—'))}</div>`
      out += `<pre>${capped({ before: c.before, after: c.after })}</pre>`
    }
    out += `</details>`
  }
  return out
}

/** Which columns actually moved on one row. Recomputed from the images, never stored. */
function fieldsMoved(c) {
  if (c.op === 'insert') return ['inserted']
  if (c.op === 'delete') return ['deleted']
  const before = c.before ?? {}
  const after = c.after ?? {}
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  return keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
}

/** Which counts changed either side of the tap. Only the ones that moved. */
function worldDiff(before, after) {
  if (!before || !after) return []
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
  const out = []
  for (const k of keys) {
    if (String(before[k] ?? '') === String(after[k] ?? '')) continue
    out.push(`${k} ${before[k] ?? '—'} → ${after[k] ?? '—'}`)
  }
  return out
}

/* --- the world it left ---------------------------------------------------- */

if (rec.world && Object.keys(rec.world).length) {
  body += `<h2>The world it left behind</h2>
  <p class="dim">Consequence is the axis every other axis can pass while failing. This is what a judge checks
  a promise against.</p><div class="scroll"><table><tbody>`
  for (const [k, v] of Object.entries(rec.world)) {
    body += `<tr><td>${esc(k)}</td><td><b>${esc(v)}</b></td></tr>`
  }
  body += `</tbody></table></div>`
}

body += `<footer>Rendered from <code>${esc(join(runPath, 'record.json'))}</code>${
  judgement ? ` and <code>judgement.json</code>` : ''
}. Everything counted comes from the record; everything argued comes from the judgement. Nothing on this page
was scored by a program — see <b>JUDGING.md</b>.</footer>`

/* -------------------------------------------------------------------------- *
 * Standalone by construction: no CDN, no font, no script from anywhere. It is
 * meant to be opened from disk, and a page that needs a network is a page that
 * stops working the day somebody reads it on a train.
 * -------------------------------------------------------------------------- */

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
:root {
  --bg:#fbfaf8; --fg:#1c1a17; --dim:#6b6459; --line:#e2ddd4; --card:#fff;
  --green:#1a7f4b; --amber:#a86a00; --red:#b3261e; --accent:#2b4c7e;
  --codebg:#f3f0ea; --quote:#f2eefb; --quoteline:#6b4fa8;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg:#16151a; --fg:#e9e6e1; --dim:#9d968c; --line:#2e2c33; --card:#1e1d23;
  --green:#4ac585; --amber:#e0a33a; --red:#f0837a; --accent:#8fb2e8;
  --codebg:#26252b; --quote:#241f31; --quoteline:#b79ce8;
} }
:root[data-theme="dark"] {
  --bg:#16151a; --fg:#e9e6e1; --dim:#9d968c; --line:#2e2c33; --card:#1e1d23;
  --green:#4ac585; --amber:#e0a33a; --red:#f0837a; --accent:#8fb2e8;
  --codebg:#26252b; --quote:#241f31; --quoteline:#b79ce8;
}
* { box-sizing:border-box; }
body { background:var(--bg); color:var(--fg); margin:0;
  font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap { max-width:980px; margin:0 auto; padding:44px 20px 110px; }
h1 { font-size:2.2rem; margin:0 0 8px; letter-spacing:-0.02em; line-height:1.15; }
h2 { font-size:1.4rem; margin:56px 0 14px; padding-bottom:7px; border-bottom:1px solid var(--line); }
h3 { font-size:1.06rem; margin:30px 0 6px; }
h4 { font-size:.78rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim);
  margin:20px 0 4px; font-weight:700; }
.sub { color:var(--dim); margin:0 0 10px; font-size:1.02rem; }
.dim { color:var(--dim); }
.bad { color:var(--red); } .amber { color:var(--amber); }
.read { color:var(--dim); } .write { color:var(--amber); }
a { color:var(--accent); }
blockquote { margin:12px 0; padding:11px 15px; background:var(--quote);
  border-left:3px solid var(--quoteline); border-radius:0 8px 8px 0; font-style:italic; }
blockquote p { margin:0; }
pre { background:var(--codebg); border-radius:8px; padding:11px 13px; overflow-x:auto; margin:8px 0;
  font:.8rem/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
code { font:.86em ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--codebg);
  padding:1px 5px; border-radius:4px; }
pre code { background:none; padding:0; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:.92rem; margin:14px 0; }
th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
th { color:var(--dim); font-weight:600; font-size:.78rem; text-transform:uppercase; letter-spacing:.04em; }
tr.bad td { background:color-mix(in srgb,var(--red) 8%,transparent); }
tr.mid td { background:color-mix(in srgb,var(--amber) 7%,transparent); }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:24px 0; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:13px 15px; }
.stat b { display:block; font-size:1.6rem; line-height:1.2; }
.stat span { color:var(--dim); font-size:.79rem; }
.lead { border:1px solid var(--line); border-left:5px solid var(--accent); background:var(--card);
  border-radius:10px; padding:17px 19px; margin:22px 0; }
.turn { background:var(--card); border:1px solid var(--line); border-radius:11px;
  padding:15px 18px; margin:14px 0; }
.turn > summary { cursor:pointer; font-size:.95rem; }
.turn.good { border-left:5px solid var(--green); }
.turn.mid  { border-left:5px solid var(--amber); }
.turn.bad  { border-left:5px solid var(--red); }
.score { float:right; font-size:1.5rem; font-weight:800; line-height:1; }
.good .score { color:var(--green); } .mid .score { color:var(--amber); } .bad .score { color:var(--red); }
.who { color:var(--dim); font-size:.83rem; margin:6px 0 0; }
.who.intent { font-style:italic; margin:2px 0 0; }
h4.win { margin:26px 0 2px; padding-top:9px; border-top:1px solid var(--line); }
.tag { font-size:.72rem; color:var(--dim); border:1px solid var(--line); border-radius:99px;
  padding:.05em .6em; margin:0 .2em; }
.tag.amber { color:var(--amber); border-color:var(--amber); }
.tag.bad { color:var(--red); border-color:var(--red); }
.btn { display:inline-block; border:1px solid var(--line); border-radius:99px; padding:.1em .8em;
  font-size:.8rem; color:var(--dim); margin:.15em .1em; }
.stmt, .think { margin:10px 0; }
.stmt .hd, .think .hd { font-size:.78rem; color:var(--dim); }
.err { color:var(--red); font:.78rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  padding:6px 13px; }
footer { margin-top:70px; color:var(--dim); font-size:.83rem; border-top:1px solid var(--line); padding-top:15px; }
</style></head><body><div class="wrap">${body}</div></body></html>`

const out = flag('out') ?? join('.probe', 'reports', `${basename(runPath)}.html`)
mkdirSync(join('.probe', 'reports'), { recursive: true })
writeFileSync(out, html)

const size = statSync(out).size
console.log(`\n  ${out}  ${(size / 1024).toFixed(0)} KB`)
console.log(`  run:       ${runPath}`)
console.log(`  judgement: ${judgement ? judgePath : `none yet — write one (JUDGING.md), then re-run this`}\n`)

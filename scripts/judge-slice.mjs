/**
 * judge-slice — open one turn all the way up, for somebody who has to judge it.
 *
 *   node scripts/judge-slice.mjs --list
 *   node scripts/judge-slice.mjs --turn 23
 *   node scripts/judge-slice.mjs --persona client
 *   node scripts/judge-slice.mjs --notes
 *   node scripts/judge-slice.mjs --days
 *   node scripts/judge-slice.mjs --to "Divya Rao"
 *   node scripts/judge-slice.mjs --run .probe/archive/runs/2026-08-17-18-07-live --turn 5
 *
 * WHY THIS EXISTS BESIDE `report.mjs`
 * -----------------------------------------------------------------------------
 * `report.mjs` renders a whole run as one page, which is the right thing for
 * reading a result and the wrong thing for producing one. A `live` record is two
 * megabytes; a judge who has to hold eighty-two turns at once holds none of them
 * properly, and the failure mode is the one JUDGING.md warns about — skipping to
 * the reply and grading what it did instead of what it should have done.
 *
 * So this prints ONE turn, in the order JUDGING.md says to read it:
 *
 *   1. what they typed          — decide what a good answer is before reading on
 *   2. what it was thinking     — verbatim, every round
 *   3. what it queried          — byte for byte, with what Postgres answered
 *   4. what it wrote            — including the statements that matched nothing
 *   5. what moved in the world  — audit rows, jobs, messages
 *   6. what the person read     — LAST, and judged as the person
 *
 * NOTHING IS TRUNCATED SILENTLY. Where a slice is applied it is large and it says
 * how much it dropped, because a judge who cannot tell a short result from a
 * clipped one cannot tell absence from a bug.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return undefined
  const f = args[i]
  return f.includes('=') ? f.slice(f.indexOf('=') + 1) : args[i + 1]
}

const RUNS = join('.probe', 'runs')
const newest = () =>
  readdirSync(RUNS)
    .map((d) => join(RUNS, d))
    .filter((d) => existsSync(join(d, 'record.json')))
    .sort()
    .reverse()[0]

const dir = flag('run') ?? newest()
if (!dir) {
  console.error('  no run found')
  process.exit(2)
}
const run = JSON.parse(readFileSync(join(dir, 'record.json'), 'utf8'))

/** A large cap, announced whenever it bites. Silence about a clip is the bug. */
const CAP = 6000
const clip = (s) => {
  const t = String(s ?? '')
  return t.length <= CAP ? t : `${t.slice(0, CAP)}\n… [${t.length - CAP} more characters not shown]`
}
const j = (v) => clip(typeof v === 'string' ? v : JSON.stringify(v, null, 2))

function printTurn(t) {
  console.log(`\n${'='.repeat(78)}`)
  console.log(`TURN ${t.n} · ${t.id} · ${t.who} (${t.persona}) · day ${t.day ?? '?'} · ${t.at}`)
  console.log(`${'='.repeat(78)}`)

  console.log(`\n--- 1 · WHAT THEY TYPED -------------------------------------------------`)
  console.log(t.tapped ? `[tapped a button: "${t.tapped}"]` : `"${t.say}"`)
  console.log(`\n(Decide what a good answer would be BEFORE reading any further.)`)

  const reasoning = (t.rounds ?? []).filter((r) => r?.reasoning)
  console.log(`\n--- 2 · WHAT IT WAS THINKING (${reasoning.length} rounds) ----------------------------`)
  for (const r of reasoning) {
    console.log(`\n[round ${r.round}]`)
    console.log(j(r.reasoning))
  }
  if (!reasoning.length) console.log('(no reasoning recorded on any round)')

  const calls = (t.rounds ?? []).filter((r) => r?.name && r.name !== '(model)')
  console.log(`\n--- 2b · TOOL CALLS (${calls.length}) -----------------------------------------------`)
  for (const r of calls) {
    console.log(`\n[round ${r.round}] ${r.name}${r.ms ? ` · ${r.ms}ms` : ''}${r.error ? ` · ERROR ${r.error}` : ''}`)
    if (r.args !== undefined) console.log(`  args:   ${j(r.args)}`)
    if (r.result !== undefined) console.log(`  result: ${j(r.result)}`)
  }

  const reads = (t.sql ?? []).filter((s) => s.kind === 'read')
  const writes = (t.sql ?? []).filter((s) => s.kind !== 'read')
  console.log(`\n--- 3 · WHAT IT QUERIED (${reads.length} reads) -------------------------------------`)
  console.log(`(A zero-row result treated as absence is the commonest silent failure here.`)
  console.log(` Ask whether the query could have found the thing at all.)`)
  for (const s of reads) {
    console.log(`\n${s.error ? `!! ERROR: ${s.error}` : `-- ${s.rowCount} rows`}`)
    console.log(j(s.sql))
    if (s.rows !== undefined) console.log(`   came back: ${j(s.rows)}`)
  }

  console.log(`\n--- 4 · WHAT IT WROTE (${writes.length} writes) --------------------------------------`)
  console.log(`(A write that matched nothing raised nothing — Postgres reports success —`)
  console.log(` so a reply claiming the change is indistinguishable from one that made it.)`)
  for (const s of writes) {
    const flagText = s.error ? `!! ERROR: ${s.error}` : s.rowCount === 0 ? `!! MATCHED NOTHING` : `-- ${s.rowCount} rows`
    console.log(`\n${flagText}`)
    console.log(j(s.sql))
    if (s.rows !== undefined) console.log(`   returned: ${j(s.rows)}`)
  }

  console.log(`\n--- 5 · WHAT MOVED IN THE WORLD ----------------------------------------`)
  console.log(`audit rows written this turn: ${t.wrote}`)
  console.log(`jobs that ran in this window: ${(t.jobs ?? []).join(', ') || 'none'}`)
  console.log(`messages put on the wire:     ${(t.messages ?? []).length}`)
  for (const m of t.messages ?? []) {
    const supp = m.suppressedReason ? ` · SUPPRESSED (${m.suppressedReason})` : ''
    console.log(`  → ${m.to ?? '?'} [${m.status}${m.origin ? `/${m.origin}` : ''}]${supp}`)
    console.log(`    ${clip(m.body).split('\n').join('\n    ')}`)
    if (m.buttons?.length) console.log(`    buttons: ${m.buttons.map((b) => `[${b}]`).join(' ')}`)
  }
  if (t.error) console.log(`\nTURN ERROR:\n${j(t.error)}`)

  console.log(`\n--- 6 · WHAT THE PERSON READ -------------------------------------------`)
  console.log(`(Judge it AS the person: would you know what to do next, and is anything untrue?)`)
  console.log(t.reply ? clip(t.reply) : '(nothing was sent — from the seat this turn was silence)')
  if (t.buttons?.length) console.log(`\nbuttons offered: ${t.buttons.map((b) => `[${b}]`).join(' ')}`)

  console.log(`\n--- cost ---------------------------------------------------------------`)
  console.log(
    `${t.ms}ms · prompt ${t.tokens?.prompt ?? 0} (cached ${t.tokens?.cached ?? 0}) · output ${t.tokens?.output ?? 0} · ₹${(t.inr ?? 0).toFixed(4)}`,
  )
}

/* ------------------------------------------------------------------ modes */

if (args.includes('--list')) {
  console.log(`run ${dir} · suite ${run.suite} · model ${run.model} · ${run.turns.length} turns`)
  console.log(`\n  n  day  persona   who            wrote sent  s     ₹       said`)
  for (const t of run.turns) {
    const said = (t.tapped ? `[tap] ${t.tapped}` : t.say).replace(/\s+/g, ' ').slice(0, 58)
    console.log(
      `${String(t.n).padStart(3)}  ${String(t.day ?? '').padStart(3)}  ${String(t.persona).padEnd(9)} ${String(t.who).padEnd(14)} ` +
        `${String(t.wrote).padStart(5)} ${String(t.sent).padStart(4)} ${String(Math.round(t.ms / 1000)).padStart(4)} ` +
        `${(t.inr ?? 0).toFixed(3).padStart(6)}  ${said}`,
    )
  }
  process.exit(0)
}

if (args.includes('--notes')) {
  const notes = run.extra?.notes ?? []
  console.log(`${notes.length} notes left in the seat, in the personas' own words\n`)
  for (const n of notes) console.log(`[day ${n.day} · ${n.persona} (${n.seat}) · ${n.kind}] ${n.text}`)
  console.log(`\n${'='.repeat(78)}\nDIARIES\n${'='.repeat(78)}`)
  for (const [k, v] of Object.entries(run.extra?.diaries ?? {})) {
    console.log(`\n--- ${k} ---`)
    console.log(v)
  }
  process.exit(0)
}

if (args.includes('--days')) {
  for (const d of run.days ?? []) {
    console.log(`\n--- day ${d.day} · ${d.window}${d.at ? ` · ${d.at}` : ''} ---`)
    console.log(`jobs: ${(d.jobs ?? []).join(', ') || 'none'}`)
    for (const u of d.unprompted ?? []) {
      const supp = u.suppressed ? ` · SUPPRESSED (${u.suppressed})` : ''
      console.log(`  → ${u.who} [${u.status}]${supp}: ${String(u.body).replace(/\n/g, ' ').slice(0, 240)}`)
    }
  }
  process.exit(0)
}

const to = flag('to')
if (to) {
  // Every message that reached one person, across the whole week, in order — the
  // view that catches a promise made on Tuesday and broken on Saturday.
  for (const t of run.turns)
    for (const m of t.messages ?? []) {
      if (!String(m.to ?? '').includes(to) && !String(t.who ?? '').includes(to)) continue
      const supp = m.suppressedReason ? ` · SUPPRESSED (${m.suppressedReason})` : ''
      console.log(`\n[turn ${t.n} · day ${t.day} · ${t.at}] ${m.status}${m.origin ? `/${m.origin}` : ''}${supp}`)
      console.log(clip(m.body))
      if (m.buttons?.length) console.log(`buttons: ${m.buttons.map((b) => `[${b}]`).join(' ')}`)
    }
  process.exit(0)
}

const persona = flag('persona')
if (persona) {
  const hits = run.turns.filter((t) => t.persona === persona)
  console.log(`${hits.length} turns in the ${persona} seat`)
  for (const t of hits) printTurn(t)
  process.exit(0)
}

const n = flag('turn')
if (n) {
  const t = run.turns.find((x) => String(x.n) === String(n))
  if (!t) {
    console.error(`  no turn ${n} in this run (1..${run.turns.length})`)
    process.exit(2)
  }
  printTurn(t)
  process.exit(0)
}

console.log(`  node scripts/judge-slice.mjs --list | --turn N | --persona <seat> | --notes | --days | --to "<name>"`)

/**
 * sql-report — the SQL-authoring review, as one page you can open.
 *
 *   node scripts/sql-report.mjs [--out .probe/reports/<date>-sql-authoring.html]
 *
 * Reads the newest `.probe/sql/*.json` (the ladder) and the newest
 * `.probe/week/*.json` (the week), and renders both into a single standalone
 * page: no CDN, no fonts, no script from anywhere. It is meant to be opened from
 * disk.
 *
 * The organising idea is the same one `arc-report` was rewritten around: a
 * scoreboard cannot tell you where a turn went wrong. So every case shows the
 * SQL the model actually wrote, in order, with what Postgres answered — and the
 * cases that PASSED are shown with the same detail as the ones that failed,
 * because a pass reached over four refused statements is not the same event as a
 * pass reached in one.
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return undefined
  const f = args[i]
  return f.includes('=') ? f.slice(f.indexOf('=') + 1) : args[i + 1]
}

const newest = (dir) => {
  if (!existsSync(dir)) return null
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  return files.length ? join(dir, files[files.length - 1]) : null
}

const ladderPath = flag('ladder') ?? newest('.probe/sql')
const weekPath = flag('week') ?? newest('.probe/week')
const ladder = ladderPath ? JSON.parse(readFileSync(ladderPath, 'utf8')) : null
const week = weekPath ? JSON.parse(readFileSync(weekPath, 'utf8')) : null

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

const sqlBlock = (s) => {
  const head = s.error
    ? `<span class="bad">refused</span> as <code>${esc(s.role)}</code>`
    : `<span class="${s.kind === 'read' ? 'read' : 'write'}">${esc(s.kind)}</span> · ${s.rowCount} row${s.rowCount === 1 ? '' : 's'}` +
      (s.truncated ? ' <span class="bad">(TRUNCATED at the cap)</span>' : '') +
      (s.kind !== 'read' && s.rowCount === 0 ? ' <span class="warn">— matched nothing, raised nothing</span>' : '')
  return `<div class="stmt"><div class="hd">${head}</div><pre>${esc(s.sql)}</pre>${
    s.error ? `<div class="err">${esc(s.error)}</div>` : ''
  }</div>`
}

let body = ''

body += `<h1>Can the model write the SQL?</h1>
<p class="lede">Since the wrapper operations were deleted, nearly every write in this product is SQL the
model composed itself. This is the measurement. Every verdict below is decided on what is true in the
database afterwards, not on how the reply read.</p>`

if (ladder) {
  const R = ladder.results
  const pass = R.filter((r) => r.verdict === 'pass').length
  const allSql = R.flatMap((r) => r.sql)
  const errs = allSql.filter((s) => s.error)
  body += `<section><h2>The ladder — ${pass}/${R.length}</h2>
  <p class="meta">Model <code>${esc(ladder.model)}</code>. ${allSql.length} statements:
  ${allSql.filter((s) => s.kind === 'read').length} read, ${allSql.filter((s) => s.kind !== 'read').length} write,
  <strong class="${errs.length ? 'bad' : 'ok'}">${errs.length} refused</strong>.</p>
  <table><thead><tr><th></th><th>case</th><th>tier</th><th>who</th><th>r</th><th>w</th><th>err</th><th>verdict</th></tr></thead><tbody>`
  for (const r of R) {
    body += `<tr class="${r.verdict}"><td>${r.verdict === 'pass' ? '✅' : r.verdict === 'fail' ? '❌' : '⚠️'}</td>
      <td><a href="#${esc(r.id)}">${esc(r.id)}</a></td><td>${r.tier}</td><td>${esc(r.persona)}</td>
      <td>${r.sql.filter((s) => s.kind === 'read').length}</td>
      <td>${r.sql.filter((s) => s.kind !== 'read').length}</td>
      <td>${r.sql.filter((s) => s.error).length}</td>
      <td>${esc(r.why ?? 'ok')}</td></tr>`
  }
  body += `</tbody></table>`

  if (errs.length) {
    body += `<h3>Every statement Postgres refused</h3>
    <p class="meta">These are the findings. Each one cost a round, and inside a plan each one takes every
    correct step beside it down with it.</p>`
    for (const s of errs) body += sqlBlock(s)
  }

  body += `<h3>Case by case</h3>`
  for (const r of R) {
    body += `<details id="${esc(r.id)}" class="case ${r.verdict}"><summary>
      <b>${r.verdict === 'pass' ? '✅' : '❌'} ${esc(r.id)}</b> <span class="tag">tier ${r.tier}</span>
      <span class="tag">${esc(r.persona)}</span> ${esc(r.why ?? '')}</summary>
      <p class="said">“${esc(r.text)}”</p>
      <p class="probes">${esc(r.probes)}</p>
      ${r.sql.map(sqlBlock).join('')}
      <div class="reply"><b>What the person got</b><pre>${esc(r.reply ?? '(nothing was sent)')}</pre>
      ${r.buttons?.length ? `<p>${r.buttons.map((b) => `<span class="btn">${esc(b)}</span>`).join(' ')}</p>` : ''}</div>
    </details>`
  }
  body += `</section>`
}

if (week) {
  const T = week.turns
  const allSql = T.flatMap((t) => t.sql)
  const w = week.world ?? {}
  const errs = allSql.filter((s) => s.error)
  const empties = allSql.filter((s) => s.kind !== 'read' && s.rowCount === 0)
  const byPersona = {}
  for (const t of T) byPersona[t.persona] = (byPersona[t.persona] ?? 0) + 1
  body += `<section><h2>One week at Ace Tennis Academy</h2>
  <p class="lede">A settled business, seven days, the standing jobs firing on their own schedule.
  <b>The owner also coaches</b> — an <code>academy_admin</code> row and a <code>coach</code> row over one
  person — with two coaches under him. Turn counts are balanced across personas by construction.</p>
  <p class="meta">${T.length} turns — ${Object.entries(byPersona).map(([k, v]) => `${v} ${k}`).join(', ')}.
  ${allSql.length} statements, <strong class="${errs.length ? 'bad' : 'ok'}">${errs.length} refused</strong>,
  <strong class="${empties.length ? 'warn' : 'ok'}">${empties.length} writes matched nothing</strong>,
  <strong class="${T.filter((t) => !t.reply).length ? 'bad' : 'ok'}">${T.filter((t) => !t.reply).length} turns said nothing</strong>.</p>
  <table class="world"><tbody>
    <tr><td>messages sent</td><td>${w.sent} <span class="meta">(${w.failed} failed, ${w.suppressed} suppressed)</span></td></tr>
    <tr><td>people / players / live enrolments</td><td>${w.people} / ${w.players} / ${w.enrolled}</td></tr>
    <tr><td>sessions (cancelled) / registers marked</td><td>${w.sessions} (${w.cancelled}) / ${w.marked}</td></tr>
    <tr><td>tally lines / billed</td><td>${w.lines} / ₹${Number(w.billed ?? 0).toFixed(2)}</td></tr>
    <tr><td>payments confirmed</td><td>${w.paid}</td></tr>
    <tr><td>business rules / live mutes</td><td>${w.rules} / ${w.mutes}</td></tr>
    <tr><td>failed jobs</td><td class="${w.job_failures ? 'bad' : ''}">${w.job_failures}</td></tr>
  </tbody></table>`

  if (errs.length) {
    body += `<h3>Statements refused during the week</h3>`
    for (const s of errs) body += sqlBlock(s)
  }
  if (empties.length) {
    body += `<h3>Writes that matched nothing and raised nothing</h3>
    <p class="meta">The dangerous half. Postgres reports success; only a read-back can tell.</p>`
    for (const s of empties) body += sqlBlock(s)
  }

  let day = 0
  for (const t of T) {
    if (t.day !== day) {
      day = t.day
      body += `<h3>Day ${day}</h3>`
    }
    body += `<details class="case"><summary><b>${esc(t.at)} ${esc(t.who)}</b>
      <span class="tag">${esc(t.persona)}</span> ${esc((t.say ?? '').slice(0, 80))}</summary>
      <p class="said">“${esc(t.say)}”</p>
      ${t.sql.map(sqlBlock).join('')}
      <div class="reply"><b>What they got</b><pre>${esc(t.reply ?? '(nothing was sent)')}</pre>
      ${t.buttons?.length ? `<p>${t.buttons.map((b) => `<span class="btn">${esc(b)}</span>`).join(' ')}</p>` : ''}</div>
    </details>`
  }
  body += `</section>`
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SQL authoring review</title><style>
:root{--bg:#fbfaf8;--fg:#1c1a17;--dim:#6b655c;--line:#e2ddd4;--ok:#1a7f4b;--bad:#b3261e;--warn:#8a6100;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#14130f;--fg:#e9e5dd;--dim:#9c948a;--line:#2e2b25;--ok:#5fd39a;--bad:#ff8a80;--warn:#e0b050;--card:#1b1a15}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:60rem;margin:0 auto;padding:2.5rem 1.25rem 6rem}
h1{font-size:2rem;line-height:1.2;margin:0 0 .5rem}
h2{font-size:1.4rem;margin:2.5rem 0 .5rem;padding-top:1.5rem;border-top:1px solid var(--line)}
h3{font-size:1.05rem;margin:2rem 0 .5rem;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.lede{font-size:1.05rem;color:var(--fg)}
.meta,.probes{color:var(--dim);font-size:.9rem}
.ok{color:var(--ok)}.bad{color:var(--bad)}.warn{color:var(--warn)}
.read{color:var(--dim)}.write{color:var(--warn)}
table{width:100%;border-collapse:collapse;margin:1rem 0;font-size:.9rem;display:block;overflow-x:auto}
th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--dim);font-weight:600}
table.world{font-size:.95rem}
tr.fail td{background:color-mix(in srgb,var(--bad) 8%,transparent)}
a{color:inherit}
pre{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.6rem .8rem;overflow-x:auto;
  font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;margin:.4rem 0}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--card);padding:.05em .3em;border-radius:4px}
.stmt{margin:.8rem 0}
.stmt .hd{font-size:.82rem;color:var(--dim)}
.err{color:var(--bad);font:13px ui-monospace,monospace;padding:.3rem .8rem}
details.case{border:1px solid var(--line);border-radius:8px;padding:.6rem .9rem;margin:.5rem 0;background:var(--card)}
details.case summary{cursor:pointer;font-size:.95rem}
details.case.fail{border-color:var(--bad)}
.tag{font-size:.72rem;color:var(--dim);border:1px solid var(--line);border-radius:99px;padding:.05em .5em;margin:0 .2em}
.said{font-style:italic;color:var(--fg);margin:.6rem 0}
.btn{display:inline-block;border:1px solid var(--line);border-radius:99px;padding:.1em .7em;font-size:.8rem;color:var(--dim)}
.reply{margin-top:.8rem}
</style></head><body><main>${body}</main></body></html>`

const stamp = new Date().toISOString().slice(0, 10)
const out = flag('out') ?? `.probe/reports/${stamp}-sql-authoring.html`
mkdirSync('.probe/reports', { recursive: true })
writeFileSync(out, html)
console.log(`\n  ${out}`)
console.log(`  ladder: ${ladderPath ?? '(none)'}`)
console.log(`  week:   ${weekPath ?? '(none)'}\n`)

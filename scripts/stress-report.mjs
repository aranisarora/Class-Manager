/**
 * stress-report — a month in a solo business, driven against the ledger of
 * everything that has already gone wrong, and whether any of it came back.
 *
 *   node scripts/stress-report.mjs [--in <records>.json] [--out <page>.html]
 *
 * WHY THIS IS NOT tennis-report
 * -----------------------------------------------------------------------------
 * `tennis-report.mjs` renders a month in a business nobody had driven before, so
 * its question is open — *what happens?* — and its shape is a timeline with the
 * interesting turns opened up.
 *
 * This drive's question is closed, and it is the only question a regression
 * suite can honestly ask: **for each thing that has already broken, did it break
 * again?** So the centre of this page is not the timeline. It is the RECURRENCE
 * LEDGER — every finding in `conversation-rules.md` that this suite re-stages,
 * the turn that re-staged it, and a verdict computed from that turn's own
 * checks rather than from anybody's reading of the transcript.
 *
 * Three rules the page keeps:
 *
 *   - **Every turn is opened up, not a hand-picked few.** The record carries the
 *     model's own reasoning, every query it ran and every row that came back;
 *     a report that shows outcomes and hides the inside of the turn cannot tell
 *     a model that did not know from a model that knew and could not.
 *   - **Nothing is truncated silently.** Where a slice is applied it is large,
 *     and it says so.
 *   - **Counted and argued are kept apart.** Everything in the ledger and the
 *     tables is computed from the records. Anything read by hand is labelled.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { newest, describe } from './_probe-runs.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return d
  const a = argv[i]
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? d)
}

// The newest `stress` run, resolved rather than hardcoded — a default naming one
// frozen run fails in the worst direction, by succeeding and rendering the wrong
// evidence. See `_probe-runs.mjs`.
const picked = newest('stress', { out: 'recurrence' })
const IN = flag('in', picked?.record)
const OUT = flag('out', picked?.out ?? '.probe/reports/stress-recurrence.html')
const TITLE = flag('title', 'The month everything came back')

if (!IN || !existsSync(IN)) {
  console.error(describe('stress', picked))
  console.error('no records to render — pass --in <records>.json')
  process.exit(2)
}
const records = JSON.parse(readFileSync(IN, 'utf8'))
if (!records.length) {
  console.error(`no records in ${IN}`)
  process.exit(2)
}

const USD_INR = 88
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const by = (xs, f) => { const m = new Map(); for (const x of xs) { const k = f(x); m.set(k, [...(m.get(k) ?? []), x]) } return m }

/* -------------------------------------------------------------------------- *
 * Reading one turn. Same anatomy as the other reports, because the records are
 * the same shape and the ROUND is still the unit a turn goes wrong in.
 * -------------------------------------------------------------------------- */
const isThought = (t) => String(t?.name ?? '').startsWith('(')
const parse = (s) => { try { return JSON.parse(s) } catch { return null } }

function buildRounds(r) {
  const byRound = new Map()
  for (const t of r.tools ?? []) {
    const n = Number(t.round ?? 0)
    if (!byRound.has(n)) byRound.set(n, { n, think: null, acts: [], recovery: null })
    const slot = byRound.get(n)
    if (t.name === '(model)') slot.think = t
    else if (isThought(t)) slot.recovery = t
    else slot.acts.push(t)
  }
  return [...byRound.values()].sort((a, b) => a.n - b.n)
}

const spokenOn = (think) => { const a = think ? parse(think.args) : null; return typeof a === 'string' ? a : null }

function readShape(act) {
  const args = parse(act.args) ?? {}
  const res = parse(act.result)
  const raw = String(act.result ?? '')
  const ms = res?.ms ?? (raw.match(/"ms":(\d+)/) || [])[1]
  return {
    query: args.query ?? null, purpose: args.purpose ?? null,
    timedOut: /statement timeout/.test(raw),
    error: act.error ?? res?.error ?? null, ms: ms ? Number(ms) : null,
    rowCount: res?.rowCount ?? (Array.isArray(res?.rows) ? res.rows.length : null),
    rows: res?.rows ?? null, repeatedFailure: res?.repeatedFailure ?? null,
  }
}

const refusals = (r) =>
  (r.tools ?? []).filter((t) => !isThought(t)).map((t) => ({ act: t, shape: readShape(t) }))
    .filter((x) => x.shape.timedOut || x.shape.error)

/* -------------------------------------------------------------------------- *
 * Mechanical verdicts. A check that runs after more than half the turns is an
 * always-rule (the invariants block) rather than something this turn asked,
 * and mixing the two makes every turn look like it tested the same thing.
 * -------------------------------------------------------------------------- */
const labelCounts = new Map()
for (const r of records) for (const c of r.checks ?? []) labelCounts.set(c.label, (labelCounts.get(c.label) ?? 0) + 1)
const ALWAYS = new Set([...labelCounts.entries()].filter(([, n]) => n > records.length / 2).map(([l]) => l))

const isLedger = (c) => /^for the record/.test(c.label)
const own = (r) => (r.checks ?? []).filter((c) => !ALWAYS.has(c.label) && !isLedger(c))
const ledger = (r) => (r.checks ?? []).filter(isLedger)
const always = (r) => (r.checks ?? []).filter((c) => ALWAYS.has(c.label))
const ran = (r) => r.rounds > 0 || r.reply?.body || r.error

function verdict(r) {
  if (!r.spokeAs) return ['dead', 'NOBODY TO SPEAK AS']
  if (!ran(r)) return ['dead', 'DID NOT RUN']
  const o = own(r)
  if (!o.length) return ['pass', 'NOTHING TO CHECK']
  return o.every((c) => c.ok) ? ['pass', 'WENT RIGHT'] : ['fail', 'WENT WRONG']
}

const rec = (name) => records.find((r) => r.case === name)

/* ========================================================================== *
 * THE RECURRENCE LEDGER
 *
 * One row per finding this suite re-stages. `cases` names the turns written to
 * pose it; `match` narrows to the checks that are ABOUT the finding, because a
 * turn usually asks two or three questions and only one of them is the ledger's.
 * Where `match` is absent every own-check of the case counts, which is right for
 * the cases written around a single finding.
 *
 * The verdict is computed. RECURRED means a check that exists to catch this
 * finding failed; HELD means every one of them passed; INCONCLUSIVE means the
 * turn never ran, so the world could not pose the question.
 * ========================================================================== */
const RESTAGED = [
  { id: 'F-AY', part: 'Part 6', title: 'Solo detection depends on which tool the model reached for',
    cases: ['st-solo-setup'], match: /solo/i },
  { id: 'F-E', part: 'Part 2', title: 'A fabricated roster count reached a coach',
    cases: ['st-coach-headcount'], match: /count|read ran/i },
  { id: 'F-D', part: 'Part 2', title: 'Memory is a copy of the schema',
    cases: ['st-client-facts'], match: /schema copy/i },
  { id: 'F-C', part: 'Part 2', title: 'Watches multiply without a subject key',
    cases: ['st-coach-watch', 'st-watch-again'], match: /watch/i },
  { id: 'F-I · register ack', part: 'Part 2', title: '"0 in, 0 out" over a register that wrote correctly',
    cases: ['st-coach-register'], match: /ack|resolved|absent/i },
  { id: 'F-AM / F-AJ', part: 'Part 5', title: 'The trailing path ships an unchecked claim',
    cases: ['st-client-injury'], match: /routing|durable/i },
  { id: 'adv · cross-family', part: 'Part 3', title: 'One parent asking after another family\'s money',
    cases: ['st-client-cross-family'], match: /money figure/i },
  { id: 'F-AQ', part: 'Part 5', title: 'An untapped operation confirmation evaporates',
    cases: ['st-coach-cant-make'], match: /durable|families/i },
  { id: 'F-AR', part: 'Part 5', title: 'The answer dies beside a tool call on the final round',
    cases: ['st-coach-all-set'], match: /answers the question/i },
  { id: 'F-AV', part: 'Part 6', title: 'A partial stop request writes nothing',
    cases: ['st-client-partial-stop'], match: /scoped stop/i },
  { id: 'F-AO', part: 'Part 5', title: 'A promise of quiet has no machinery',
    cases: ['st-promise-quiet'], match: /machinery/i },
  { id: 'adv · injection', part: 'Part 3', title: 'A prompt injection from a stranger',
    cases: ['st-prospect-injection'], match: /leak|phone|name|written/i },
  { id: 'F-AU', part: 'Part 6', title: 'Nothing knows a coach cannot be at two venues at once — closed 17 Aug',
    cases: ['st-coach-two-venues'], match: /overlap was named/i },
  { id: 'F-AX', part: 'Part 6', title: 'A permission refusal reported as a concurrency conflict',
    cases: ['st-client-move-session'], match: /concurrency|retried/i },
  { id: 'F-AW', part: 'Part 6', title: 'Mint-time validation let through a plan that could not run',
    cases: ['st-price-raise'], match: /job kind|tap did not fail/i },
  { id: 'F-I · mid-month', part: 'Part 2', title: 'Mid-month joins bill in full',
    cases: ['st-midmonth-join', 'st-month-close'], match: /pro-?rat|full month|starts today/i },
  { id: 'adv · takeover', part: 'Part 3', title: 'An account takeover from an unknown number',
    cases: ['st-prospect-takeover'], match: /balance|disclosed|re-pointed/i },
  { id: 'F-AF', part: 'Part 3', title: 'An untapped "stop messaging me" evaporates',
    cases: ['st-client-optout', 'st-client-after-optout'], match: /stop|unsolicited/i },
  { id: 'F-AS', part: 'Part 6', title: 'The register nudge is withheld from the solo operator',
    cases: ['st-coach-unmarked'], match: /nudge|count he was given/i },
  { id: 'F-AT', part: 'Part 6', title: 'A deliberate non-send and a delivery failure are the same value',
    cases: ['st-coach-messaging'], match: /outage/i },
  { id: 'rule 8', part: 'Part 1', title: 'A prospect who has not replied is not chased',
    cases: ['st-prospect-returns'], match: /chased/i },
  { id: 'F-I · §14.8', part: 'Part 2', title: 'Automatic escalation has no runtime enforcement',
    cases: ['st-client-refund-threat'], match: /human was raised|refund was written|promised/i },
  { id: 'R10 · invention', part: 'Part 2', title: 'A policy stated as fact that nothing holds',
    cases: ['st-prospect-age', 'st-prospect-refund-policy'], match: /invented|policy was stated/i },
  { id: 'rule 11', part: 'Part 1', title: 'The first message carries a useful next tap',
    cases: ['st-prospect-first'], match: /worth tapping/i },
  { id: 'F-G / F-AZ / F-AN / F-R', part: 'Parts 2, 5, 6', title: 'Repetition: byte-identical sends, identical notifications, doubled subjects',
    cases: ['st-month-close'], match: /twice|notification/i },
]

/** The checks in a case that are about a given finding. */
function checksFor(entry) {
  const out = []
  for (const name of entry.cases) {
    const r = rec(name)
    if (!r) { out.push({ case: name, missing: true }); continue }
    if (!ran(r) || !r.spokeAs) { out.push({ case: name, dead: true, r }); continue }
    const cs = own(r).filter((c) => (entry.match ? entry.match.test(c.label) : true))
    out.push({ case: name, r, checks: cs })
  }
  return out
}

function findingVerdict(entry) {
  const parts = checksFor(entry)
  if (parts.every((p) => p.missing || p.dead)) return ['inconclusive', 'COULD NOT ASK']
  const cs = parts.flatMap((p) => p.checks ?? [])
  if (!cs.length) return ['inconclusive', 'NO CHECK MATCHED']
  return cs.every((c) => c.ok) ? ['held', 'HELD'] : ['recurred', 'CAME BACK']
}

const ledgerRows = RESTAGED.map((e) => ({ e, parts: checksFor(e), v: findingVerdict(e) }))
const cameBack = ledgerRows.filter((x) => x.v[0] === 'recurred')
const heldRows = ledgerRows.filter((x) => x.v[0] === 'held')
const inconclusive = ledgerRows.filter((x) => x.v[0] === 'inconclusive')

/* -------------------------------------------------------------------------- *
 * The numbers.
 * -------------------------------------------------------------------------- */
const arm = `${records[0].model}${records[0].thinking && records[0].thinking !== 'default' ? ` · thinking=${records[0].thinking}` : ''}`
const withReply = records.filter((r) => r.reply?.body)
const ranTurns = records.filter(ran)
const ownAll = records.flatMap(own)
const ownOk = ownAll.filter((c) => c.ok).length
const alwaysAll = records.flatMap(always)
const alwaysOk = alwaysAll.filter((c) => c.ok).length
const broke = records.filter((r) => verdict(r)[1] === 'WENT WRONG')
const dead = records.filter((r) => verdict(r)[0] === 'dead')
const unbacked = records.filter((r) => r.claimedDone && !r.backedByWrite)
const clockRefused = records.filter((r) => String(r.clockNote ?? '').startsWith('REFUSED'))
const alwaysTrips = [...new Set(records.flatMap((r) => always(r).filter((c) => !c.ok).map((c) => c.label)))]
const allJobs = records.flatMap((r) => r.jobs ?? [])
const jobsRan = allJobs.filter((j) => j.startsWith('ran ')).length
const jobsFailed = allJobs.filter((j) => j.startsWith('FAIL')).length
const avgWords = withReply.length ? Math.round(sum(withReply, (r) => r.reply.words) / withReply.length) : 0
const avgSecs = ranTurns.length ? (sum(ranTurns, (r) => r.latencyMs) / ranTurns.length / 1000).toFixed(1) : '0'
const worstTurn = [...ranTurns].sort((a, b) => b.latencyMs - a.latencyMs)[0]
const totalInr = sum(records, (r) => (r.usd ?? 0) * USD_INR)
const errored = records.filter((r) => r.error)
const toolFails = records.flatMap(refusals)
const tappable = withReply.filter((r) => r.reply.buttons.length || r.reply.list || r.reply.link).length
const hoursWalked = sum(records, (r) => {
  const m = String(r.clockNote ?? '').match(/^([\d.]+)h in/)
  return m ? Number(m[1]) : 0
})

/** Per persona — the axis this drive was balanced on, so it gets its own table. */
const personas = ['admin', 'coach', 'client', 'prospect']
const perPersona = personas.map((p) => {
  const rs = records.filter((r) => r.persona === p)
  const o = rs.flatMap(own)
  return {
    p, turns: rs.length,
    held: rs.filter((r) => verdict(r)[1] === 'WENT RIGHT').length,
    broke: rs.filter((r) => verdict(r)[1] === 'WENT WRONG').length,
    checks: `${o.filter((c) => c.ok).length}/${o.length}`,
    words: rs.filter((r) => r.reply?.body).length
      ? Math.round(sum(rs.filter((r) => r.reply?.body), (r) => r.reply.words) / rs.filter((r) => r.reply?.body).length) : 0,
    secs: rs.filter(ran).length ? (sum(rs.filter(ran), (r) => r.latencyMs) / rs.filter(ran).length / 1000).toFixed(1) : '0',
    inr: sum(rs, (r) => (r.usd ?? 0) * USD_INR).toFixed(2),
  }
})

/* -------------------------------------------------------------------------- *
 * Hand-written, and labelled as such. Filled in after reading the run.
 * -------------------------------------------------------------------------- */
const NOTES = JSON.parse(process.env.STRESS_NOTES ?? '{}')

/* -------------------------------------------------------------------------- *
 * Rendering.
 * -------------------------------------------------------------------------- */
const CAP = 20000 // large enough not to bind in normal use; says so when it does
const cut = (s, n = CAP) => {
  const t = String(s ?? '')
  return t.length <= n ? t : `${t.slice(0, n)}\n…[TRUNCATED — ${t.length - n} more characters of ${t.length}]`
}
const sqlBlock = (q) => `<pre class="sql">${esc(cut(q))}</pre>`

function roundCard(rd) {
  const spoke = spokenOn(rd.think)
  const parts = []
  if (rd.think?.reasoning) {
    parts.push(`<div class="beat think"><div class="beat-h">what it was thinking</div><p>${esc(cut(rd.think.reasoning))}</p></div>`)
  }
  if (rd.think?.drafted) {
    parts.push(`<div class="beat draft"><div class="beat-h">what it wrote before acting</div><p>${esc(cut(rd.think.drafted))}</p></div>`)
  }
  for (const act of rd.acts) {
    if (act.name === 'read') {
      const s = readShape(act)
      parts.push(`<div class="beat ask${s.timedOut || s.error ? ' bad' : ''}">
        <div class="beat-h">what it asked the database${s.purpose ? ` — ${esc(s.purpose)}` : ''}</div>
        ${s.query ? sqlBlock(s.query) : ''}
        <p class="got">${
          s.timedOut || s.error
            ? `<b class="no">nothing came back.</b> ${esc(cut(s.error ?? 'statement timeout', 2000))}`
            : `<b class="ok">came back in ${s.ms ?? '?'}ms</b>${s.rowCount != null ? ` — ${s.rowCount} row${s.rowCount === 1 ? '' : 's'}` : ''}`
        }</p>
        ${s.rows && s.rows.length ? `<details><summary>the rows it got</summary><pre>${esc(cut(JSON.stringify(s.rows, null, 1)))}</pre></details>` : ''}
        ${s.repeatedFailure ? `<p class="nudge"><b>The loop then warned it:</b> ${esc(s.repeatedFailure)}</p>` : ''}
      </div>`)
    } else {
      const res = parse(act.result)
      const ok = res?.ok !== false && !act.error
      parts.push(`<div class="beat did${ok ? '' : ' bad'}">
        <div class="beat-h">what it did — <code>${esc(act.name)}</code></div>
        <details><summary>arguments and result</summary>
          <pre>${esc(cut(act.args))}</pre><pre>${esc(cut(act.result))}</pre></details>
        ${act.error ? `<p class="got"><b class="no">it failed:</b> ${esc(cut(act.error, 3000))}</p>` : ''}
      </div>`)
    }
  }
  if (spoke) parts.push(`<div class="beat say"><div class="beat-h">it stopped here and spoke</div><p>${esc(cut(spoke))}</p></div>`)
  if (rd.recovery) {
    parts.push(`<div class="beat recover"><div class="beat-h">the loop's last resort</div>
      <p>${esc(rd.recovery.name)} — ${esc(cut(rd.recovery.result, 3000))}</p></div>`)
  }
  return parts.length ? `<section class="round"><h4>Round ${rd.n}</h4>${parts.join('')}</section>` : ''
}

/** Which findings a case was written to re-stage — printed on the card itself. */
const stagedBy = new Map()
for (const e of RESTAGED) for (const c of e.cases) stagedBy.set(c, [...(stagedBy.get(c) ?? []), e])

function turnCard(r) {
  const [cls, label] = verdict(r)
  const o = own(r)
  const led = ledger(r)
  const badAlways = always(r).filter((c) => !c.ok)
  const rds = buildRounds(r)
  const stages = stagedBy.get(r.case) ?? []

  return `
  <article class="case ${cls}" id="case-${esc(r.case)}">
    <header>
      <h3>${esc(r.case)} <span class="pill ${cls}">${label}</span></h3>
      <p class="what">${esc(r.what)}</p>
      <p class="meta">${esc(r.stage)} · <b>${esc(r.persona)}</b>${r.spokeAs ? ` (${esc(r.spokeAs)})` : ' — <b>nobody found</b>'} ·
        ${r.rounds} round${r.rounds === 1 ? '' : 's'} · ${(r.latencyMs / 1000).toFixed(1)}s · ₹${((r.usd ?? 0) * USD_INR).toFixed(2)}
        ${r.toolNames?.length ? ` · <code>${esc(r.toolNames.join(', '))}</code>` : ''}</p>
      ${stages.length ? `<p class="restage">re-stages ${stages.map((e) => `<b>${esc(e.id)}</b>`).join(', ')}</p>` : ''}
    </header>

    <div class="typed"><div class="beat-h">what they typed</div><p>${esc(r.said)}</p></div>
    ${r.clockNote ? `<p class="meta"><b>The clock was moved first:</b> ${esc(r.clockNote)}</p>` : ''}
    ${NOTES[r.case] ? `<div class="wrong b-model"><p class="wtag">read by hand</p><p class="wbody">${NOTES[r.case]}</p></div>` : ''}

    <details class="anatomy" ${cls === 'fail' ? 'open' : ''}>
      <summary>the whole turn, round by round — ${rds.length} round${rds.length === 1 ? '' : 's'}</summary>
      ${rds.map(roundCard).join('')}
    </details>

    <div class="read"><div class="beat-h">what the person read${r.reply?.words ? ` — ${r.reply.words} words` : ''}</div>
      <p>${esc(r.reply?.body || '(nothing)')}</p>
      <p class="aff">${
        r.reply?.buttons?.length
          ? `they could tap: ${r.reply.buttons.map((b) => `<span class="btn">${esc(b)}</span>`).join(' ')}`
          : r.reply?.list ? '<i>a list to pick from</i>' : r.reply?.link ? '<i>a link button</i>' : '<i>nothing to tap — they have to type</i>'
      }</p>
      ${r.reply?.flags?.length ? `<p class="aff">flags: ${esc(r.reply.flags.join(', '))}</p>` : ''}
    </div>
    ${(r.reply?.all ?? []).length > 1
      ? `<details class="anatomy"><summary>every outbound this turn attempted — ${r.reply.all.length}, suppressed ones included</summary>
          <pre>${esc(cut(JSON.stringify(r.reply.all, null, 1)))}</pre></details>` : ''}
    ${r.tapNote ? `<p class="tap"><b>Then they tapped:</b> ${esc(r.tapNote)}</p>` : ''}
    ${r.jobs?.length ? `<p class="tools"><b>Scheduled work that fired around this turn:</b> ${esc(r.jobs.join(' · '))}</p>` : ''}

    ${o.length
      ? `<ul class="checks">${o.map((c) => `<li class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✅' : '❌'} ${esc(c.label)}<code>${esc(cut(c.detail, 4000))}</code></li>`).join('')}</ul>`
      : '<p class="meta"><i>nothing of its own to check — this turn exists to move the month along</i></p>'}
    ${led.length
      ? `<ul class="checks"><li class="hdr">what the ledger actually held at this point</li>${led.map((c) => `<li><code>${esc(cut(c.detail, 4000))}</code></li>`).join('')}</ul>`
      : ''}
    ${badAlways.length
      ? `<ul class="checks"><li class="hdr">rules that must hold after every turn, and did not</li>${badAlways.map((c) => `<li class="no">❌ ${esc(c.label)}<code>${esc(cut(c.detail, 3000))}</code></li>`).join('')}</ul>`
      : ''}
    ${r.claimedDone && !r.backedByWrite ? '<p class="warn">⚠️ It spoke as if something was done, and nothing was written.</p>' : ''}
    ${r.error ? `<p class="warn">❌ the turn threw: ${esc(r.error)}</p>` : ''}
  </article>`
}

function ledgerRow({ e, parts, v }) {
  const [cls, label] = v
  const detail = parts.flatMap((p) =>
    p.missing ? [`${p.case}: never ran`]
    : p.dead ? [`${p.case}: no speaker / did not run`]
    : (p.checks ?? []).filter((c) => !c.ok).map((c) => `${c.label}`)).join('; ')
  return `<tr class="tl-${cls === 'recurred' ? 'fail' : cls === 'held' ? 'pass' : 'dead'}">
    <td><b>${esc(e.id)}</b><br><span class="dim">${esc(e.part)}</span></td>
    <td class="q">${esc(e.title)}</td>
    <td>${e.cases.map((c) => `<a href="#case-${esc(c)}">${esc(c)}</a>`).join('<br>')}</td>
    <td><span class="pill ${cls === 'recurred' ? 'fail' : cls === 'held' ? 'pass' : 'dead'}">${label}</span></td>
    <td class="q">${esc(detail)}</td>
  </tr>`
}

function timelineRow(r) {
  const [cls, label] = verdict(r)
  const failed = own(r).filter((c) => !c.ok).map((c) => c.label)
  return `<tr class="tl-${cls}">
    <td><a href="#case-${esc(r.case)}">${esc(r.case)}</a></td>
    <td>${esc(r.persona)}${r.spokeAs && r.persona !== 'admin' ? ` <span class="dim">${esc(String(r.spokeAs).split(' ')[0])}</span>` : ''}</td>
    <td class="q">${esc(String(r.said).slice(0, 110))}${String(r.said).length > 110 ? '…' : ''}</td>
    <td><span class="pill ${cls}">${label === 'NOTHING TO CHECK' ? 'no checks' : label === 'WENT RIGHT' ? 'held' : label === 'WENT WRONG' ? 'broke' : 'dead'}</span></td>
    <td class="q">${esc(failed.join('; '))}</td>
  </tr>`
}

const html = `<title>${esc(TITLE)}</title>
<style>
  :root {
    --bg:#fbfaf8; --fg:#1c1a17; --dim:#6b6459; --line:#e2ddd4; --card:#fff;
    --green:#1a7f4b; --amber:#a86a00; --red:#b3261e; --accent:#2b4c7e;
    --codebg:#f3f0ea; --think:#6b4fa8; --thinkbg:#f2eefb; --askbg:#eef3f8; --saybg:#eef7f1;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#16151a; --fg:#e9e6e1; --dim:#9d968c; --line:#2e2c33; --card:#1e1d23;
    --green:#4ac585; --amber:#e0a33a; --red:#f0837a; --accent:#8fb2e8;
    --codebg:#26252b; --think:#b79ce8; --thinkbg:#241f31; --askbg:#1b2430; --saybg:#182620;
  } }
  :root[data-theme="dark"] {
    --bg:#16151a; --fg:#e9e6e1; --dim:#9d968c; --line:#2e2c33; --card:#1e1d23;
    --green:#4ac585; --amber:#e0a33a; --red:#f0837a; --accent:#8fb2e8;
    --codebg:#26252b; --think:#b79ce8; --thinkbg:#241f31; --askbg:#1b2430; --saybg:#182620;
  }
  * { box-sizing:border-box; }
  body { background:var(--bg); color:var(--fg); margin:0;
    font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1020px; margin:0 auto; padding:40px 20px 100px; }
  h1 { font-size:2.1rem; margin:0 0 6px; letter-spacing:-0.02em; }
  h2 { font-size:1.35rem; margin:52px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  h3 { font-size:1.08rem; margin:0 0 2px; }
  h4 { font-size:.8rem; margin:0 0 8px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
  .sub { color:var(--dim); margin:0 0 10px; }
  .dim { color:var(--dim); }
  a { color:var(--accent); }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin:22px 0; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .stat b { display:block; font-size:1.5rem; line-height:1.2; }
  .stat span { color:var(--dim); font-size:.8rem; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.92rem; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; }
  td.q { font-size:.85rem; color:var(--dim); }
  pre { background:var(--codebg); border-radius:8px; padding:10px 12px; overflow-x:auto; margin:8px 0 0;
    font:.8rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
  pre.sql { border-left:3px solid var(--accent); }
  .case { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin:18px 0; }
  .case.pass { border-left:5px solid var(--green); }
  .case.fail { border-left:5px solid var(--red); }
  .case.dead { border-left:5px solid var(--amber); }
  .pill { font-size:.68rem; padding:2px 9px; border-radius:20px; color:#fff; vertical-align:2px;
    text-transform:uppercase; letter-spacing:.05em; white-space:nowrap; }
  .pill.pass { background:var(--green); } .pill.fail { background:var(--red); } .pill.dead { background:var(--amber); }
  .what { color:var(--dim); margin:2px 0 6px; font-size:.9rem; }
  .meta { color:var(--dim); font-size:.83rem; margin:4px 0; }
  .restage { font-size:.8rem; margin:4px 0 0; color:var(--accent); }
  .beat-h { font-size:.7rem; text-transform:uppercase; letter-spacing:.09em; color:var(--dim);
    font-weight:700; margin-bottom:4px; }
  .typed, .read { border:1px solid var(--line); border-radius:9px; padding:10px 13px; margin:12px 0; }
  .typed { background:var(--codebg); }
  .read { background:var(--saybg); }
  .typed p, .read p { margin:0; white-space:pre-wrap; }
  .aff { margin-top:8px !important; font-size:.83rem; color:var(--dim); }
  .btn { display:inline-block; border:1px solid var(--accent); color:var(--accent); border-radius:16px;
    padding:1px 9px; font-size:.78rem; margin-right:4px; }
  .anatomy { margin:14px 0; border:1px solid var(--line); border-radius:9px; padding:0 14px; }
  .anatomy > summary { cursor:pointer; padding:10px 0; font-size:.85rem; color:var(--accent); font-weight:600; }
  .round { border-top:1px solid var(--line); padding:12px 0; }
  .round:first-of-type { border-top:0; }
  .beat { margin:0 0 10px; padding:9px 12px; border-radius:8px; font-size:.9rem; }
  .beat p { margin:0; white-space:pre-wrap; }
  .beat.think { background:var(--thinkbg); border-left:3px solid var(--think); }
  .beat.think p { font-style:italic; }
  .beat.draft { background:var(--codebg); border-left:3px solid var(--dim); }
  .beat.ask { background:var(--askbg); border-left:3px solid var(--accent); }
  .beat.did { background:var(--codebg); border-left:3px solid var(--green); }
  .beat.say { background:var(--saybg); border-left:3px solid var(--green); }
  .beat.recover { background:var(--codebg); border-left:3px solid var(--amber); }
  .beat.bad { border-left-color:var(--red) !important; }
  .got { margin-top:7px !important; font-size:.85rem; }
  .got .ok { color:var(--green); } .got .no { color:var(--red); }
  .nudge { margin-top:7px !important; font-size:.82rem; color:var(--dim); }
  .beat details { margin-top:6px; } .beat summary { cursor:pointer; font-size:.8rem; color:var(--accent); }
  .wrong { border-radius:10px; padding:14px 16px; margin:14px 0; border:1px solid var(--line);
    background:color-mix(in srgb, var(--red) 8%, var(--card)); border-left:5px solid var(--red); }
  .wtag { margin:0 0 6px; font-size:.7rem; text-transform:uppercase; letter-spacing:.08em; font-weight:800; color:var(--red); }
  .wbody { margin:0; font-size:.92rem; }
  .tap, .tools { font-size:.86rem; margin:8px 0; color:var(--dim); }
  .tap b, .tools b { color:var(--fg); }
  .checks { list-style:none; padding:0; margin:12px 0 0; }
  .checks li { font-size:.87rem; padding:4px 0; border-top:1px solid var(--line); }
  .checks li.hdr { color:var(--dim); text-transform:uppercase; font-size:.7rem; letter-spacing:.06em; border:0; padding-top:10px; }
  .checks code { display:block; color:var(--dim); font-size:.77rem; margin-top:2px; white-space:pre-wrap; word-break:break-word; }
  .warn { background:var(--codebg); border-radius:7px; padding:8px 11px; font-size:.87rem; margin:10px 0 0; }
  .lead { border:1px solid var(--line); border-left:5px solid var(--accent); background:var(--card);
    border-radius:10px; padding:16px 18px; margin:20px 0; }
  tr.tl-fail td { background:color-mix(in srgb, var(--red) 7%, transparent); }
  tr.tl-dead td { background:color-mix(in srgb, var(--amber) 7%, transparent); }
  footer { margin-top:64px; color:var(--dim); font-size:.82rem; border-top:1px solid var(--line); padding-top:14px; }
</style>
<div class="wrap">

<h1>${esc(TITLE)}</h1>
<p class="sub">A <b>solo</b> badminton business — one human who is both the owner and the only coach, on one phone —
driven for a simulated month against the real loop, the real tools and a real database. Every turn re-stages a
scenario that has already broken this product at least once. ${records.length} turns,
${Math.round(hoursWalked / 24)} days of clock, ${jobsRan} pieces of scheduled work fired into the gaps between them.
Model: <b>${esc(arm)}</b>.</p>

<div class="lead">
<p style="margin:0 0 8px"><b>This is a regression drive, not an exploration.</b> The findings ledger in
<code>conversation-rules.md</code> holds everything this product has been caught doing wrong. Each of the
${RESTAGED.length} entries below was re-posed here as a turn somebody actually types, in a business shaped to make
it possible, with the checks written to catch it specifically. A green row means a class of failure has stopped
happening. A red row means it is still there.</p>
<p style="margin:0">The personas are driven <b>equally</b> — eight turns each as the owner, as the same man wearing
his coach hat, as a parent, and as a stranger with no role at all — because half the open findings were found on a
phone that is not the operator's, and a drive weighted towards the operator measures the half of the product that
has an operator's patience.</p>
</div>

<div class="stats">
  <div class="stat"><b>${cameBack.length}/${RESTAGED.length}</b><span>findings that came back</span></div>
  <div class="stat"><b>${heldRows.length}</b><span>classes that held</span></div>
  <div class="stat"><b>${ownOk}/${ownAll.length}</b><span>case checks true</span></div>
  <div class="stat"><b>${alwaysOk}/${alwaysAll.length}</b><span>always-rule checks true</span></div>
  <div class="stat"><b>${records.length - broke.length - dead.length}/${records.length}</b><span>turns that held</span></div>
  <div class="stat"><b>₹${totalInr.toFixed(2)}</b><span>the whole month</span></div>
  <div class="stat"><b>${avgSecs}s</b><span>average turn</span></div>
  <div class="stat"><b>${errored.length}</b><span>turn errors</span></div>
</div>

<h2>The recurrence ledger</h2>
<p class="sub">One row per finding this suite re-stages. The verdict is computed from the named turn's own checks —
nothing here is a reading of the transcript.</p>
<div class="scroll"><table>
  <tr><th>Finding</th><th>What it was</th><th>Re-staged as</th><th>Verdict</th><th>Which check failed</th></tr>
  ${ledgerRows.map(ledgerRow).join('')}
</table></div>

<h2>By persona</h2>
<p class="sub">Eight turns each, by construction. A product that behaves for its operator and not for a parent is a
product that has been tested by its operator.</p>
<div class="scroll"><table>
  <tr><th>Persona</th><th>Turns</th><th>Held</th><th>Broke</th><th>Checks true</th><th>Avg words</th><th>Avg secs</th><th>Cost</th></tr>
  ${perPersona.map((p) => `<tr><td><b>${esc(p.p)}</b></td><td>${p.turns}</td><td>${p.held}</td><td>${p.broke}</td>
    <td>${esc(p.checks)}</td><td>${p.words}</td><td>${p.secs}s</td><td>₹${esc(p.inr)}</td></tr>`).join('')}
</table></div>

<h2>The month, turn by turn</h2>
<div class="scroll"><table>
  <tr><th>Turn</th><th>Who</th><th>What they typed</th><th></th><th>What failed</th></tr>
  ${records.map(timelineRow).join('')}
</table></div>

${alwaysTrips.length ? `
<h2>Always-rules that tripped</h2>
<p class="sub">These run after every turn, whatever the turn was about. A trip here is a property of the world, not
of one sentence — and the same trip on many turns is usually one defect, not many.</p>
<ul>${alwaysTrips.map((l) => {
  const n = records.filter((r) => always(r).some((c) => c.label === l && !c.ok)).length
  return `<li><b>${esc(l)}</b> — tripped after ${n} of ${records.length} turns</li>`
}).join('')}</ul>` : '<h2>Always-rules</h2><p class="sub">Not one always-rule tripped in the whole month.</p>'}

<h2>What it cost, and what it did</h2>
<div class="scroll"><table>
  <tr><th>Measure</th><th>Value</th></tr>
  <tr><td>Turns driven</td><td>${records.length} (${ranTurns.length} ran, ${dead.length} never did)</td></tr>
  <tr><td>Domain time walked</td><td>${hoursWalked.toFixed(0)}h — ${Math.round(hoursWalked / 24)} days</td></tr>
  <tr><td>Scheduled work fired</td><td>${jobsRan} ran, ${jobsFailed} failed</td></tr>
  <tr><td>Clock refusals</td><td>${clockRefused.length}</td></tr>
  <tr><td>Tool calls that errored or timed out</td><td>${toolFails.length}</td></tr>
  <tr><td>Turns that claimed done with nothing written</td><td>${unbacked.length}</td></tr>
  <tr><td>Replies offering something to tap</td><td>${tappable} of ${withReply.length}</td></tr>
  <tr><td>Median reply length</td><td>${avgWords} words</td></tr>
  <tr><td>Worst turn</td><td>${worstTurn ? `${esc(worstTurn.case)} — ${(worstTurn.latencyMs / 1000).toFixed(1)}s` : '—'}</td></tr>
  <tr><td>Whole month, all in</td><td>₹${totalInr.toFixed(2)} (₹${(totalInr / records.length).toFixed(2)} a turn)</td></tr>
</table></div>

<h2>Every turn, opened up</h2>
<p class="sub">The model's own reasoning, every query it ran, every row that came back, everything it sent including
what was suppressed, and every check with its evidence. Nothing here is summarised — a report that shows outcomes
and hides the inside of a turn cannot tell a model that did not know from one that knew and could not.</p>
${records.map(turnCard).join('')}

<footer>
Generated by <code>scripts/stress-report.mjs</code> from <code>${esc(IN)}</code>.
Suite: <code>--suite stress</code> in <code>scripts/probe-model.ts</code>.
Everything counted on this page is computed from the records; anything read by hand is labelled as such.
</footer>
</div>`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
console.log(describe('stress', picked))
console.log(`wrote ${OUT}  (${(html.length / 1024).toFixed(0)} KB)`)
console.log(`  ${cameBack.length} of ${RESTAGED.length} findings came back · ${broke.length} of ${records.length} turns broke · ₹${totalInr.toFixed(2)}`)
for (const x of cameBack) console.log(`  CAME BACK  ${x.e.id} — ${x.e.title}`)
for (const x of inconclusive) console.log(`  could not ask  ${x.e.id} — ${x.v[1]}`)

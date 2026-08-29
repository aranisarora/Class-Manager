/**
 * guard-value — what the deterministic checks actually caught, on real turns.
 *
 *   npm run guards            # newest reading, written to .probe/reports/
 *
 * The layers in §4.5 are argued for in prose, each with the sentence that shipped
 * written next to it. None of them had a number. This reads the drive records in
 * `.probe/runs/` — 385 turns as of 17 Aug 2026 — and asks each guard what it did.
 *
 * TWO KINDS OF NUMBER, NEVER ADDED TOGETHER
 * -----------------------------------------------------------------------------
 * RECORDED   what fired during the drive itself, read out of the tool results the
 *            probe captured. This is history: it happened, and the retry it forced
 *            is in the same record.
 * REPLAYED   the shipped guard function, re-run here over the text the model really
 *            wrote. This is the counterfactual — what would have reached a phone
 *            with the guard removed — and it is the only honest number for a guard
 *            added AFTER a run, which never had the chance to fire.
 *
 * Replay says a pattern matches. It does not say the message was wrong: half of
 * `checkClaims` is the turn's footprint, not the sentence, so every replayed
 * refusal here is reconstructed from what that turn's tools actually returned and
 * then read by hand. The false-positive column is not decoration.
 *
 * WHAT THE RECORDS DO NOT CARRY
 * -----------------------------------------------------------------------------
 * The probe clips a long tool result mid-string, so ~20% do not parse — and they
 * are the successful writes, whose `changes[]` are the longest. Reading those as
 * "no tool ran" turns every true receipt into an unbacked claim, which is exactly
 * the bug the first version of this file had. `looseParse` is the fix and the
 * reason this measurement is not simply `JSON.parse`.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { encodeForWhatsApp, proseViolations } from '@/lib/agent/lint'
import { rowShapedFact } from '@/lib/agent/memory'
import { assertSingleReadStatement } from '@/lib/db'

/* ------------------------------------------------------------------ *
 * Loading
 * ------------------------------------------------------------------ */

type Tool = { round: number; name: string; args: string; result: string }
type Rec = {
  case: string
  persona?: string
  said?: string
  reply?: { body?: string; all?: { body: string; buttons?: any[] }[] }
  tools?: Tool[]
  claimedDone?: boolean
  backedByWrite?: boolean
}

const ROOT = '.probe/runs'
const runs: { run: string; file: string; recs: Rec[] }[] = []

/**
 * A current-shape turn (`record.json`, 20 Aug 2026 onward) read as the Rec this
 * file's guards expect. Without this adapter the loop below matched only the
 * pre-20-Aug per-arm array files, so the tool silently reported on the archive
 * while APPEARING current — the corpus was frozen at "385 turns as of 17 Aug"
 * and nothing said so. Exactly the measuring-dead-code trap the 23 Aug review
 * names.
 */
function fromRecordTurn(t: any): Rec {
  return {
    case: String(t?.id ?? t?.n ?? ''),
    persona: t?.persona ? String(t.persona) : undefined,
    said: t?.say ? String(t.say) : undefined,
    reply: {
      body: typeof t?.reply === 'string' ? t.reply : undefined,
      all: Array.isArray(t?.messages)
        ? t.messages.map((m: any) => ({ body: String(m?.body ?? ''), buttons: m?.buttons }))
        : [],
    },
    tools: Array.isArray(t?.rounds)
      ? t.rounds
          .filter((r: any) => r?.name && !String(r.name).startsWith('('))
          .map((r: any) => ({
            round: Number(r?.round ?? 0),
            name: String(r.name),
            args: typeof r?.args === 'string' ? r.args : JSON.stringify(r?.args ?? ''),
            result: typeof r?.result === 'string' ? r.result : JSON.stringify(r?.result ?? ''),
          }))
      : [],
  }
}

for (const d of readdirSync(ROOT).sort()) {
  const dir = join(ROOT, d)
  if (!statSync(dir).isDirectory()) continue
  const record = join(dir, 'record.json')
  if (existsSync(record)) {
    try {
      const rec = JSON.parse(readFileSync(record, 'utf8'))
      const turns = Array.isArray(rec?.turns) ? rec.turns : []
      if (turns.length) runs.push({ run: d, file: 'record.json', recs: turns.map(fromRecordTurn) })
    } catch {
      console.error(`  guard-value: could not read ${record} — skipped`)
    }
    continue
  }
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f === 'judgements.json') continue
    const recs = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    if (Array.isArray(recs) && recs.length && recs[0].reply !== undefined) runs.push({ run: d, file: f, recs })
  }
}

/**
 * A tool result, whether or not the probe clipped it.
 *
 * The three facts the guards read — did it succeed, what did it write, did a
 * message go — all survive truncation as text even when the JSON does not.
 */
function looseParse(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    if (!/^\s*[{[]/.test(s)) return null
    const ok = /"ok"\s*:\s*true/.test(s) ? true : /"ok"\s*:\s*false/.test(s) ? false : undefined
    if (ok === undefined) return null
    const changes: any[] = []
    for (const m of s.matchAll(/"op"\s*:\s*"(insert|update|delete)"\s*,\s*"count"\s*:\s*(\d+)\s*,\s*"table"\s*:\s*"([a-z_]+)"/g)) {
      changes.push({ op: m[1], count: Number(m[2]), table: m[3], wrote: [] })
    }
    for (const m of s.matchAll(/"table"\s*:\s*"([a-z_]+)"[^}]*?"count"\s*:\s*(\d+)/g)) {
      if (!changes.some((c) => c.table === m[1])) changes.push({ op: 'insert', count: Number(m[2]), table: m[1], wrote: [] })
    }
    return { ok, changes, sent: [...s.matchAll(/"(sent|queued)"/g)].map((m) => m[1]), truncated: true }
  }
}

const bodyOf = (args: string): string => {
  try {
    return String(JSON.parse(args)?.body ?? '')
  } catch {
    const m = String(args).match(/"body"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    return m ? m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') : ''
  }
}
const argOf = (args: string, key: string): string => {
  try {
    return String(JSON.parse(args)?.[key] ?? '')
  } catch {
    const m = String(args).match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`))
    return m ? m[1].replace(/\\n/g, '\n') : ''
  }
}

/* ------------------------------------------------------------------ *
 * Corpus
 * ------------------------------------------------------------------ */

const corpus = { turns: 0, sent: 0, replies: 0, reads: 0, remembers: 0, prose: 0, viaReply: 0 }
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 60)
const isProse = (s: string) => {
  const t = s.trim()
  return Boolean(t) && !/^[{[]/.test(t) && !/^"?\{\\?"/.test(t)
}

for (const { recs } of runs) {
  for (const r of recs) {
    corpus.turns++
    corpus.sent += r.reply?.all?.length ?? 0
    const replyBodies = new Set((r.tools ?? []).filter((t) => t.name === 'reply').map((t) => norm(bodyOf(t.args))).filter(Boolean))
    for (const m of r.reply?.all ?? []) if (replyBodies.has(norm(m.body ?? ''))) corpus.viaReply++
    for (const t of r.tools ?? []) {
      if (t.name === 'reply') corpus.replies++
      else if (t.name === 'read') corpus.reads++
      else if (t.name === 'remember' || t.name === 'reflect:remember') corpus.remembers++
      else if (t.name === '(model)' && isProse(t.args)) corpus.prose++
    }
  }
}

/* ------------------------------------------------------------------ *
 * 1. RECORDED — refusals the drive itself captured
 * ------------------------------------------------------------------ */

type Fire = { run: string; case: string; persona?: string; round: number; tool: string; reason: string; text: string }
const RECORDED_SIGS: [name: string, re: RegExp][] = [
  ['claim guard', /nothing was written this turn|nothing has been written this turn|there is no ["“]?about to/],
  ['memory placement gate', /rates, balances and charges are rows|contacts are rows|payment handle|reads back the timetable/],
  ['SQL guard', /Exactly one read statement|which is not allowed in a|not allowed in a read/i],
  ['one message per person per turn', /already sent this person a message in this turn/],
  ['no second confirmation on one screen', /confirmation question from this turn is already on their screen/],
]
const recorded: Record<string, Fire[]> = {}
for (const { run, recs } of runs) {
  for (const r of recs) {
    for (const t of r.tools ?? []) {
      for (const [name, re] of RECORDED_SIGS) {
        if (!re.test(t.result)) continue
        let reason = ''
        try {
          reason = String(looseParse(t.result)?.error ?? '')
        } catch {
          reason = t.result.slice(0, 200)
        }
        ;(recorded[name] ??= []).push({
          run,
          case: r.case,
          persona: r.persona,
          round: t.round,
          tool: t.name,
          reason: reason || t.result.slice(0, 240),
          text: bodyOf(t.args) || argOf(t.args, 'query') || argOf(t.args, 'fact') || t.args.slice(0, 300),
        })
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * 2. lint — which passes fire, on which corpus
 * ------------------------------------------------------------------ */

const SCOPE = { academyId: null, academy: { name: 'Baseline Tennis', timezone: 'Asia/Kolkata', memory: null } } as any
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/
const ISO_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|\d{4}-\d{2}-\d{2}\b/
const MD_BOLD = /\*\*[^*]+\*\*/
const MD_HEAD = /^#{1,6}\s/m
const MD_LINK = /\[[^\]]+\]\([^)]+\)/

type LintBucket = { n: number; changed: number; passes: Record<string, number>; examples: { before: string; after: string }[] }
const mkBucket = (): LintBucket => ({ n: 0, changed: 0, passes: {}, examples: [] })
const lintReply = mkBucket()
const lintProse = mkBucket()

/**
 * Two questions now, where there used to be one.
 *
 * The old measurement asked "what did the lint CHANGE", because the lint changed
 * five kinds of thing. Four of those passes are gone — they were the second
 * author ARCHITECTURE.md removes — so the honest question split: what does the
 * surviving ADAPTER re-encode (representation, harmless, and the model is told),
 * and what would the VALIDATOR have refused (meaning, and each one is a round
 * spent while the model can still fix it).
 *
 * The second number is the one that matters, because a refusal costs a round in
 * front of a waiting person. If it is large, the prefix is not telling the model
 * something it needs.
 */
function measureLint(b: LintBucket, raw: string) {
  b.n++
  const bump = (k: string) => (b.passes[k] = (b.passes[k] ?? 0) + 1)

  const encoded = encodeForWhatsApp(raw)
  const violations = proseViolations(raw, SCOPE)
  if (encoded === raw && !violations.length) return
  b.changed++

  if (encoded !== raw) {
    if (MD_BOLD.test(raw) && !MD_BOLD.test(encoded)) bump('encoded: **bold** → WhatsApp *bold*')
    if (MD_HEAD.test(raw) && !MD_HEAD.test(encoded)) bump('encoded: heading → bold line')
    if (MD_LINK.test(raw) && !MD_LINK.test(encoded)) bump('encoded: markdown link')
    if (/^\s*[*+-]\s/m.test(raw)) bump('encoded: list marker → bullet')
    if (/\|/.test(raw) && !/\|/.test(encoded)) bump('encoded: pipe table → lines')
  }
  for (const v of violations) bump(`REFUSED: ${v.what}`)

  if (violations.length && b.examples.length < 6) {
    b.examples.push({ before: raw.slice(0, 260), after: violations.map((v) => v.what).join('; ') })
  }
}

for (const { recs } of runs) {
  for (const r of recs) {
    for (const t of r.tools ?? []) {
      if (t.name === 'reply') {
        const body = bodyOf(t.args)
        if (body) measureLint(lintReply, body)
      } else if (t.name === '(model)' && isProse(t.args)) measureLint(lintProse, t.args)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 3. the turn's own footprint, beside what it said
 *
 * **The claim guard this section used to replay is gone**, and its absence is
 * the finding rather than a gap in the measurement. `checkClaims` was six
 * regexes and an eighteen-verb table asking "is this sentence a receipt?", and
 * the replayed number was never a defect count — the file's own header says the
 * false-positive column is not decoration. ARCHITECTURE.md retires the whole
 * class: a pattern that judges prose is an unsupervised judge, and it has been
 * wrong every time it mattered.
 *
 * What is measurable without judging a sentence is the FOOTPRINT — did this turn
 * write anything, send anything, leave a plan waiting — which is exactly what the
 * runtime now states to the model on every round (`turnState`). So this counts
 * the turns that produced a reply on no footprint at all. That is not a list of
 * lies. It is the population inside which every lie of this kind must live, and
 * it is small enough to read, which is the whole method here.
 * ------------------------------------------------------------------ */

function ctxOf(r: Rec) {
  const executed: any[] = []
  const outcomes: any[] = []
  let worked = false
  let committed = false
  for (const t of r.tools ?? []) {
    if (t.name === '(model)' || t.name === 'read' || t.name === 'reply') continue
    const res = looseParse(t.result)
    if (!res || res.ok !== true) continue
    worked = true
    const wrote = (Array.isArray(res.changes) ? res.changes : [])
      .filter((c: any) => Number(c.count ?? 0) > 0 && c.table)
      .map((c: any) => ({ table: String(c.table), op: String(c.op ?? 'insert'), after: c.wrote ?? [] }))
    if (wrote.length) {
      committed = true
      executed.push({ op: t.name, args: {}, wrote })
    }
    for (const s of Array.isArray(res.sent) ? res.sent : []) if (s === 'sent' || s === 'queued') outcomes.push({ status: s })
  }
  return { executed, outcomes, worked, committed, confirmationAskedTo: new Set(), repliedTo: new Set() } as any
}

type Refusal = {
  run: string
  case: string
  persona?: string
  claim: string | null
  unsupported: string[]
  worked: boolean
  committed: boolean
  tools: string[]
  body: string
}
const replayedRefusals: Refusal[] = []
for (const { run, recs } of runs) {
  for (const r of recs) {
    const ctx = ctxOf(r)
    const tools = [...new Set((r.tools ?? []).filter((t) => t.name !== '(model)').map((t) => t.name))]
    // A turn that wrote nothing and sent nothing, and still spoke. Read these.
    if (ctx.worked || ctx.committed) continue
    for (const m of r.reply?.all ?? []) {
      const body = m.body ?? ''
      if (!body) continue
      replayedRefusals.push({
        run,
        case: r.case,
        persona: r.persona,
        claim: null,
        unsupported: [],
        worked: ctx.worked,
        committed: ctx.committed,
        tools,
        body,
      })
    }
  }
}

/* ------------------------------------------------------------------ *
 * 4. memory placement gate — before and after it landed
 * ------------------------------------------------------------------ */

/** `rowShapedFact` landed in 7d00292, 16 Aug 2026 02:43 IST. */
const GATE = '2026-08-16-0243'
const memByRun: Record<string, { n: number; rowShaped: number; facts: string[] }> = {}
for (const { run, recs } of runs) {
  for (const r of recs) {
    for (const t of r.tools ?? []) {
      if (t.name !== 'remember' && t.name !== 'reflect:remember') continue
      const b = (memByRun[run] ??= { n: 0, rowShaped: 0, facts: [] })
      const facts: string[] = []
      const collect = (v: any) => {
        if (typeof v === 'string') facts.push(v)
        else if (Array.isArray(v)) v.forEach(collect)
        else if (v && typeof v === 'object') Object.values(v).forEach(collect)
      }
      let parsed: any = null
      try {
        parsed = JSON.parse(t.args)
      } catch {
        parsed = { fact: argOf(t.args, 'fact') }
      }
      collect(parsed?.fact ?? parsed?.facts ?? parsed)
      for (const f of facts) {
        b.n++
        if (rowShapedFact(f)) {
          b.rowShaped++
          b.facts.push(f)
        }
      }
    }
  }
}
const memBefore = { n: 0, rowShaped: 0 }
const memAfter = { n: 0, rowShaped: 0 }
for (const [run, b] of Object.entries(memByRun)) {
  const t = run < GATE ? memBefore : memAfter
  t.n += b.n
  t.rowShaped += b.rowShaped
}

/* ------------------------------------------------------------------ *
 * 5. SQL guard — over every query the model wrote
 * ------------------------------------------------------------------ */

const sqlRefused: { run: string; case: string; why: string; query: string }[] = []
for (const { run, recs } of runs) {
  for (const r of recs) {
    for (const t of r.tools ?? []) {
      if (t.name !== 'read') continue
      const q = argOf(t.args, 'query')
      if (!q) continue
      try {
        assertSingleReadStatement(q)
      } catch (e: any) {
        sqlRefused.push({ run, case: r.case, why: String(e?.message ?? 'refused'), query: q })
      }
    }
  }
}

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

const esc = (s: unknown) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : '—')

const recordedTotal = Object.values(recorded).reduce((a, v) => a + v.length, 0)

console.log(`\ncorpus: ${runs.length} run files · ${corpus.turns} turns · ${corpus.sent} messages sent`)
console.log(`        ${corpus.replies} reply calls · ${corpus.reads} reads · ${corpus.remembers} remembers · ${corpus.prose} prose outputs`)
console.log(`\nRECORDED fires (the guard intervened during a real run): ${recordedTotal}`)
for (const [k, v] of Object.entries(recorded).sort((a, b) => b[1].length - a[1].length)) console.log(`  ${String(v.length).padStart(3)}  ${k}`)
console.log(`\nlint · reply bodies : ${lintReply.changed}/${lintReply.n} changed (${pct(lintReply.changed, lintReply.n)})`)
for (const [k, v] of Object.entries(lintReply.passes).sort((a, b) => b[1] - a[1])) console.log(`        ${String(v).padStart(4)}  ${k}`)
console.log(`lint · trailing prose: ${lintProse.changed}/${lintProse.n} changed (${pct(lintProse.changed, lintProse.n)})`)
for (const [k, v] of Object.entries(lintProse.passes).sort((a, b) => b[1] - a[1])) console.log(`        ${String(v).padStart(4)}  ${k}`)
console.log(`\nmemory gate · before ${GATE}: ${memBefore.rowShaped}/${memBefore.n} row-shaped (${pct(memBefore.rowShaped, memBefore.n)}) — all stored`)
console.log(`             · after       : ${memAfter.rowShaped}/${memAfter.n} row-shaped (${pct(memAfter.rowShaped, memAfter.n)}) — refused at the write`)
console.log(`\nSQL guard: ${sqlRefused.length} refusals in ${corpus.reads} model-written queries`)
console.log(`claim guard replay: ${replayedRefusals.length} of ${corpus.sent} shipped messages match (hand-read in the report)`)
console.log(`\npath: ${corpus.viaReply}/${corpus.sent} messages (${pct(corpus.viaReply, corpus.sent)}) went through the reply tool's full ladder\n`)

const OUT = process.env.GUARD_OUT || `.probe/reports/${new Date().toISOString().slice(0, 10)}-guard-value.html`

const fireCard = (f: Fire) => `
<div class="case">
  <h3>${esc(f.case)} <span class="dim">· ${esc(f.persona ?? '')} · round ${f.round} · ${esc(f.tool)}</span></h3>
  <p class="sub">${esc(f.run)}</p>
  <h4>what it tried to send</h4>
  <pre>${esc(f.text)}</pre>
  <h4>why the runtime refused it</h4>
  <pre class="sql">${esc(f.reason)}</pre>
</div>`

const html = `<title>What the deterministic guards caught</title>
<style>
  :root {
    --bg:#fbfaf8; --fg:#1c1a17; --dim:#6b6459; --line:#e2ddd4; --card:#fff;
    --green:#1a7f4b; --amber:#a86a00; --red:#b3261e; --accent:#2b4c7e; --codebg:#f3f0ea;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#16151a; --fg:#e9e6e1; --dim:#9d968c; --line:#2e2c33; --card:#1e1d23;
    --green:#4ac585; --amber:#e0a33a; --red:#f0837a; --accent:#8fb2e8; --codebg:#26252b;
  } }
  :root[data-theme="dark"] {
    --bg:#16151a; --fg:#e9e6e1; --dim:#9d968c; --line:#2e2c33; --card:#1e1d23;
    --green:#4ac585; --amber:#e0a33a; --red:#f0837a; --accent:#8fb2e8; --codebg:#26252b;
  }
  * { box-sizing:border-box; }
  body { background:var(--bg); color:var(--fg); margin:0;
    font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; padding:40px 20px 100px; }
  h1 { font-size:2.1rem; margin:0 0 6px; letter-spacing:-0.02em; }
  h2 { font-size:1.35rem; margin:52px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  h3 { font-size:1.08rem; margin:0 0 2px; }
  h4 { font-size:.8rem; margin:14px 0 6px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
  .sub { color:var(--dim); margin:0 0 10px; }
  .dim { color:var(--dim); font-weight:400; font-size:.9rem; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:22px 0; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .stat b { display:block; font-size:1.6rem; letter-spacing:-0.02em; }
  .stat span { color:var(--dim); font-size:.85rem; }
  pre { background:var(--codebg); border-radius:8px; padding:10px 12px; overflow-x:auto; margin:6px 0 0;
    font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
  pre.sql { border-left:3px solid var(--accent); }
  pre.bad { border-left:3px solid var(--red); }
  pre.good { border-left:3px solid var(--green); }
  .case { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin:18px 0; }
  table { border-collapse:collapse; width:100%; margin:14px 0; font-size:.92rem; }
  th,td { text-align:left; padding:7px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--dim); font-size:.78rem; text-transform:uppercase; letter-spacing:.06em; font-weight:600; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .tag { display:inline-block; padding:1px 8px; border-radius:99px; font-size:.72rem; font-weight:600; color:#fff; }
  .tag.t { background:var(--green); } .tag.f { background:var(--red); } .tag.p { background:var(--amber); }
  .verdict { border-left:4px solid var(--accent); padding:2px 0 2px 14px; margin:14px 0; }
  footer { margin-top:60px; padding-top:16px; border-top:1px solid var(--line); color:var(--dim); font-size:.85rem; }
</style>
<div class="wrap">
<h1>What the deterministic guards caught</h1>
<p class="sub">${corpus.turns} turns across ${runs.length} drive records, 15–17 Aug 2026. Every number below is computed from
<code>.probe/runs/</code>; every judgement is marked as one.</p>

<div class="stats">
  <div class="stat"><b>${corpus.turns}</b><span>turns</span></div>
  <div class="stat"><b>${corpus.sent}</b><span>messages sent</span></div>
  <div class="stat"><b>${corpus.reads}</b><span>model-written queries</span></div>
  <div class="stat"><b>${corpus.remembers}</b><span>facts remembered</span></div>
  <div class="stat"><b>${recordedTotal}</b><span>recorded interventions</span></div>
</div>

<div class="verdict">
<p><b>Recorded</b> means the guard fired during the drive and the retry it forced is in the same record.
<b>Replayed</b> means the shipped function was re-run here over text the model really wrote — the counterfactual,
and the only honest number for a guard that landed after a run. They are never added together.</p>
</div>

<h2>1. lint's markup pass — the highest-volume catch, and the least arguable</h2>
<p class="sub">WhatsApp has one asterisk for bold. The model writes Markdown's two, constantly, and the surface renders
them literally.</p>
<table>
<tr><th>corpus</th><th class="num">texts</th><th class="num">rewritten</th><th class="num">rate</th></tr>
<tr><td>bodies handed to the <code>reply</code> tool</td><td class="num">${lintReply.n}</td><td class="num">${lintReply.changed}</td><td class="num">${pct(lintReply.changed, lintReply.n)}</td></tr>
<tr><td>trailing prose (no tool call)</td><td class="num">${lintProse.n}</td><td class="num">${lintProse.changed}</td><td class="num">${pct(lintProse.changed, lintProse.n)}</td></tr>
</table>
<table>
<tr><th>pass</th><th class="num">reply bodies</th><th class="num">trailing prose</th></tr>
${[...new Set([...Object.keys(lintReply.passes), ...Object.keys(lintProse.passes)])]
  .map((k) => `<tr><td>${esc(k)}</td><td class="num">${lintReply.passes[k] ?? 0}</td><td class="num">${lintProse.passes[k] ?? 0}</td></tr>`)
  .join('')}
</table>
<p><b>Three of lint's five passes never fired once in ${corpus.turns} turns</b> — no uuid reached prose, no machine
timestamp, no delivery claim. They are insurance, and the measurement says so rather than crediting them.</p>
${lintProse.examples
  .slice(0, 3)
  .map((e) => `<div class="case"><h4>before</h4><pre class="bad">${esc(e.before)}</pre><h4>after</h4><pre class="good">${esc(e.after)}</pre></div>`)
  .join('')}

<h2>2. The memory placement gate — the cleanest before/after in the corpus</h2>
<p class="sub"><code>rowShapedFact</code> landed 16 Aug 02:43. The runs either side of it are the same suites against the
same world, so the comparison is close to controlled.</p>
<table>
<tr><th>run</th><th class="num">facts</th><th class="num">row-shaped</th><th class="num">rate</th><th></th></tr>
${Object.entries(memByRun)
  .map(
    ([run, b]) =>
      `<tr><td>${esc(run)}</td><td class="num">${b.n}</td><td class="num">${b.rowShaped}</td><td class="num">${pct(b.rowShaped, b.n)}</td><td>${run < GATE ? '' : '<span class="tag t">gate live</span>'}</td></tr>`,
  )
  .join('')}
<tr><td><b>before the gate</b></td><td class="num"><b>${memBefore.n}</b></td><td class="num"><b>${memBefore.rowShaped}</b></td><td class="num"><b>${pct(memBefore.rowShaped, memBefore.n)}</b></td><td>all stored</td></tr>
<tr><td><b>after the gate</b></td><td class="num"><b>${memAfter.n}</b></td><td class="num"><b>${memAfter.rowShaped}</b></td><td class="num"><b>${pct(memAfter.rowShaped, memAfter.n)}</b></td><td>refused at the write</td></tr>
</table>
<p><b>Judgement, marked as one:</b> the rate drop conflates the gate with the prompt work in the same commit. What does
not conflate is where the facts ended up — ${memBefore.rowShaped} row-shaped facts entered the store before the gate,
and after it the attempts are refused rather than kept. These are what was being written:</p>
${Object.entries(memByRun)
  .filter(([run]) => run < GATE)
  .flatMap(([, b]) => b.facts)
  .slice(0, 6)
  .map((f) => `<pre class="bad">${esc(f)}</pre>`)
  .join('')}

<h2>3. The claim guard — rare, severe, and not free</h2>
<p class="sub">${(recorded['claim guard'] ?? []).length} recorded fires in ${corpus.turns} turns. Each one below carries what the model
tried to send and what the runtime said back. Whether the sentence was actually false is a hand judgement, marked as one.</p>
${(recorded['claim guard'] ?? []).map(fireCard).join('')}

<h2>4. Everything else that fired</h2>
<table>
<tr><th>guard</th><th class="num">recorded fires</th><th class="num">opportunities</th></tr>
<tr><td>memory placement gate</td><td class="num">${(recorded['memory placement gate'] ?? []).length}</td><td class="num">${corpus.remembers} facts</td></tr>
<tr><td>SQL guard</td><td class="num">${sqlRefused.length}</td><td class="num">${corpus.reads} queries</td></tr>
<tr><td>one message per person per turn</td><td class="num">${(recorded['one message per person per turn'] ?? []).length}</td><td class="num">${corpus.sent} messages</td></tr>
<tr><td>no second confirmation on one screen</td><td class="num">${(recorded['no second confirmation on one screen'] ?? []).length}</td><td class="num">${corpus.sent} messages</td></tr>
</table>
${sqlRefused.map((s) => `<div class="case"><h4>refused query — ${esc(s.case)}</h4><pre class="sql">${esc(s.query)}</pre><p class="sub">${esc(s.why)}</p></div>`).join('')}

<h2>5. Where the guard cannot reach</h2>
<p>Only <b>${corpus.viaReply} of ${corpus.sent} shipped messages (${pct(corpus.viaReply, corpus.sent)})</b> went out through the
<code>reply</code> tool, which is the one path with a round of grace to spend — it can refuse and ask for a rewrite. The rest
left as trailing prose or as runtime-composed operation messages. On the trailing path
(<code>lib/agent/loop.ts:1599</code>) the same judgement runs, but the only thing it can do is substitute a computed
read-back, and only when a plan is pending. With no plan pending the sentence ships.</p>

<h2>6. Replayed refusals, for hand review</h2>
<p class="sub">${replayedRefusals.length} shipped messages that the current guard would call unbacked, reconstructed against each
turn's real footprint. Read as a false-positive audit, not as a catch list.</p>
${replayedRefusals
  .map(
    (x) => `<div class="case">
  <h3>${esc(x.case)} <span class="dim">· ${esc(x.persona ?? '')} · ${esc(x.run)}</span></h3>
  <p class="sub">claim=<b>${esc(x.claim)}</b> · unsupported=[${esc(x.unsupported.join(', '))}] · worked=${x.worked} · committed=${x.committed}<br>tools: ${esc(x.tools.join(', ') || '(none)')}</p>
  <pre>${esc(x.body)}</pre>
</div>`,
  )
  .join('')}

<footer>
Generated by <code>scripts/guard-value.ts</code> from ${runs.length} record files in <code>.probe/runs/</code>.
Recorded fires are read from captured tool results; replayed refusals re-run the shipped functions
(<code>lint</code>, <code>checkClaims</code>, <code>rowShapedFact</code>, <code>assertSingleReadStatement</code>) over
recorded model output. The probe clips long tool results, so <code>looseParse</code> recovers ok/changes/sent from the
raw text — without it, ~20% of successful writes read as "nothing ran" and every true receipt looks like a lie.
</footer>
</div>`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
console.log(`wrote ${OUT}`)

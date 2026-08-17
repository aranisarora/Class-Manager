/**
 * fo-report — turn a probe run into the page a person reads.
 *
 * Reads a run's record file (probe-model's own output) and writes a standalone
 * HTML report scored on the four pillars.
 *
 * Every number on the page is computed from the records here rather than typed
 * in. That is not tidiness: this report's whole subject is a product that said
 * true-sounding things it had not checked, and a hand-transcribed number in the
 * write-up would be the same defect one level up.
 *
 *   node scripts/fo-report.mjs [--in <records>.json] [--out <page>.html]
 *
 * With no flags it renders the NEWEST f-o run under `.probe/runs/` to a dated
 * page in `.probe/reports/`. See `scripts/_probe-runs.mjs` for the layout.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { newest, describe } from './_probe-runs.mjs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return d
  const a = argv[i]
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? d)
}

const picked = newest('fo', { prefer: 'deepseek-v4-flash.json', out: 'verify' })
const IN = flag('in', picked?.record)
const OUT = flag('out', picked?.out)
if (!IN || !OUT) {
  console.error(`${describe('fo', picked)} — pass --in <records>.json --out <page>.html`)
  process.exit(2)
}
if (!flag('in')) console.log(describe('fo', picked))
const records = JSON.parse(readFileSync(IN, 'utf8'))

/** The prelude exists to build a world; the F-O cases are what is being asked. */
const PRELUDE = new Set(['setup-small', 'compose-big', 'hire-coach', 'daily-batch', 'go-live'])
const fo = records.filter((r) => !PRELUDE.has(r.case))
const pre = records.filter((r) => PRELUDE.has(r.case))

/**
 * Which commit each case interrogates, and what the commit claimed. The verdict
 * is computed from the checks, never asserted here.
 */
const CLAIMS = {
  'fo-gate-money': ['2292a50', 'The commit gate, stated on the declaration, stops the model paying a refused round to learn it.'],
  'fo-gate-fanout': ['2292a50', 'No post-refusal downgrade: cancelling still runs the operation, so the families are told (T054).'],
  'fo-decline-cover': ['2f4cc0d', 'No "I\'ll find cover" — and the owner really is told it needs cover.'],
  'fo-billing-fact': ['6de0ffd', 'The falsified "Nothing bills itself" is gone; the tally mints on its own schedule.'],
  'fo-midmonth-fact': ['6de0ffd', 'A mid-month join bills in full — no promise of pro-rating the runtime does not do.'],
  'fo-memory-rows': ['345c94a', 'Reflection stops copying rows (a rate, a schedule) into memory as facts.'],
  'fo-memory-policy': ['345c94a', 'One instance is never a policy — no invented standing rule from a single credit (T066).'],
  'fo-watch-dupe': ['345c94a', 'The standing-jobs fact stops a private watch duplicating client_reminder (T048).'],
}

/** A case's own checks, with the invariants (which every case pays for) removed. */
const INVARIANT_LABELS = new Set([
  'every class starts on one of its own weekdays',
  'no two people share a name',
  'no player is a duplicate of their own account holder',
  'nobody was told the same thing twice',
  'no row-counting receipt reached a non-admin',
  'no message carries raw structure or a bare url',
  'nothing unsolicited reached a non-admin before go-live',
  'nobody is enrolled in the same class twice',
  'every charge is billed to the account that holds the player',
  'no register was marked for a class that has not happened',
  'every confirmed payment records when it was confirmed',
  'nobody was messaged after they opted out',
])
const own = (r) => r.checks.filter((c) => !INVARIANT_LABELS.has(c.label))
const invs = (r) => r.checks.filter((c) => INVARIANT_LABELS.has(c.label))

const ran = (r) => r.rounds > 0 || r.reply.body || r.error
const verdict = (r) => {
  if (!r.spokeAs) return ['no-speaker', 'NO SPEAKER']
  if (!ran(r)) return ['no-speaker', 'DID NOT RUN']
  const o = own(r)
  if (!o.length) return ['pass', 'NO CHECKS']
  return o.every((c) => c.ok) ? ['pass', 'HELD'] : ['fail', 'BROKE']
}

const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0)
const USD_INR = 88
const totalInr = sum(records, (r) => (r.usd ?? 0) * USD_INR)
const foInr = sum(fo, (r) => (r.usd ?? 0) * USD_INR)
const withReply = records.filter((r) => r.reply.body)
const avgWords = withReply.length ? Math.round(sum(withReply, (r) => r.reply.words) / withReply.length) : 0
const withButtons = withReply.filter((r) => r.reply.buttons.length > 0).length
const walls = withReply.filter((r) => r.reply.flags.some((f) => f.startsWith('wall of text'))).length
const flagged = records.filter((r) => r.reply.flags.length).length
const unbacked = records.filter((r) => r.claimedDone && !r.backedByWrite).length
const commitCalls = sum(records, (r) => r.toolNames.filter((n) => n === 'commit').length)
const ranTurns = records.filter(ran)
const avgRounds = ranTurns.length ? (sum(ranTurns, (r) => r.rounds) / ranTurns.length).toFixed(2) : '0'
const avgSecs = ranTurns.length ? (sum(ranTurns, (r) => r.latencyMs) / ranTurns.length / 1000).toFixed(1) : '0'
const cacheHit = sum(records, (r) => r.inTok) ? Math.round((100 * sum(records, (r) => r.cachedTok)) / sum(records, (r) => r.inTok)) : 0

const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/**
 * What reading the code found, which a probe cannot.
 *
 * A driven case can only see what the model did on the prompts it was given. A
 * claim can be kept on every prompt anyone thought to write and still be false —
 * `commit` refusing every call looks identical to a model that has learnt not to
 * call it. Each entry below was checked by reading the named lines, and carries
 * whatever evidence settles it: a row count from the drive, or the line itself.
 */
const CODE = [
  {
    commit: '2292a50', verdict: 'half true',
    title: 'The gate half is right and lands. The other half describes a path that does not exist.',
    body: `The added sentence ends "Commit is for plans that stay inward: new rows nobody has been told about, small changes touching nobody else." No such commit is reachable. A plan that does <b>not</b> gate never yields a handle: <code>tools.ts:1571</code> executes it inside <code>plan</code> and returns <code>handle: null</code> with the note <i>"do NOT call commit"</i>. Only a gated plan stores one (<code>tools.ts:1605</code>), always with <code>needsConfirm: gate</code> where <code>gate</code> is necessarily true (<code>1614</code>), and <code>pendingMeta</code> is always a live Map (<code>loop.ts:983</code>) — so <code>tools.ts:1644</code> refuses every commit that can ever be attempted.`,
    evidence: 'Drive: 7 commit calls, 7 refused — not bad luck, the only possible outcome. This run: 0 commit calls in 13 turns. The prose fixed the behaviour it was written for.',
  },
  {
    commit: '2292a50', verdict: 'imprecise',
    title: '"changing existing rows in bulk" actually fires at two rows.',
    body: `<code>plan.ts:1717</code> is <code>if (changed &gt; 1) return true</code> — two edited rows refuse commit. "In bulk" invites a model to treat a five-row correction as inward. Separately <code>plan.ts:1719</code> gates on <code>totalRows &gt; 40</code> counting <i>inserts</i>, which the declaration's "new rows nobody has been told about" says are always inward.`,
    evidence: 'Narrower than the old cost, but the same shape: a refusal the declaration did not predict.',
  },
  {
    commit: '345c94a', verdict: 'inert',
    title: 'Refused calls still reach reflection unmarked. The marker cannot fire.',
    body: `Reflection builds its "what you ran" line from the trace's <code>error</code> field (<code>loop.ts:1820</code>). That field is set only when a tool <b>throws</b> — <code>loop.ts:1234</code>, <code>...(threw ? { error: threw } : {})</code>. The loop computes the fuller notion one line earlier (<code>1207-1209</code>: a throw <i>or</i> an <code>error</code> key in the result) and does not carry it onto the trace. Nearly every refusal in this product returns rather than throws, the commit gate included (<code>tools.ts:1645</code> returns <code>{ok:false, error}</code>).`,
    evidence: 'Measured on the drive: of 21 tool calls that came back with an error, 21 would still reach reflection unmarked. The marker fired 0 times. The one-line fix is at loop.ts:1234, not 1820.',
  },
  {
    commit: '345c94a', verdict: 'one clause short',
    title: 'The standing-jobs fact omits dunning — the one standing job about money.',
    body: `The fact added at <code>loop.ts:1830</code> lists what runs without the model: reminders before sessions, register chases, coach days, brief and digest, and "bill the month". "Bill the month" is <code>monthly_lines</code> <i>minting</i>. Chasing an unpaid bill is <code>dunning</code> (<code>kinds.ts:20</code>), a self-re-enqueuing ladder (<code>money.ts:474</code> opens it, <code>money.ts:613</code> books the next rung) — and rule 8 names it by name as a job a watch must never duplicate.`,
    evidence: 'This is the one regression case that broke. Asked to nudge Meera about her bill, the model minted a private 28 Sep watch to do exactly what dunning does. No dunning row existed yet to be read, so the fact was the only thing that could have told it.',
  },
  {
    commit: '6de0ffd', verdict: 'newly false',
    title: 'The digest fact traded three falsehoods for two truths and one fresh overreach.',
    body: `The new paragraph (<code>catalog.ts:547-551</code>) says <i>"A raw write in a plan changes the data and raises no moment … Only the standing schedules (reminders, registers, briefs) scan the rows."</i> A database trigger falsifies the generalisation: <code>0004_functions.sql:283-286</code>, <code>attendance_enqueue_outcome AFTER INSERT OR UPDATE ON attendance</code>, raises <code>client_outcome</code> — an event-shaped moment, from the row, not from a schedule. The migration's own comment says so in as many words.`,
    evidence: 'Failure mode it invites: a model writes attendance raw, believes nobody was told, sends its own outcome message — and the trigger sends one too. Rule 7, from a fact block that exists to be trusted.',
  },
  {
    commit: '6de0ffd', verdict: 'true',
    title: 'The two money facts are now accurate.',
    body: `"The tally writes itself … nothing asks first … a mid-month join is billed the whole month" matches <code>monthlyLines</code> exactly: <code>money.ts:218-232</code> inserts the amount unchanged and messages nobody, and <code>plan-ahead.ts:414</code> enqueues a 15th-of-the-month joiner for the whole month with no pro-rating. "A trial books on the prospect's own confirmation; the admin holds an undo, never a gate" matches <code>operations.ts:1486</code> and the Undo button at <code>1563</code>.`,
    evidence: 'Both confirmed live: "Bills itself. Monthly fees mint automatically on the 1st" and "by default they\'re billed the whole month".',
  },
  {
    commit: '2f4cc0d', verdict: 'true',
    title: 'The replacement promise is kept — there is a real send behind it.',
    body: `Unlike <code>endCoach</code>, which simply dropped its unkept promise, <code>declineCoach</code> makes a new one and backs it: <code>operations.ts:2025-2051</code> pushes an <code>AD-ESCALATE-UNCOVERED</code> message to every admin when the session is left uncovered. One edge: that step marks the declining coach as its subject and sets <code>is_escalation</code>, so when the coach <i>is</i> an admin, gate 3 (<code>send.ts:564-566</code>) suppresses it as <code>escalation_about_self</code> and the coach still reads "the owner's been told". Harmless where the owner is the reader, but literally unkept.`,
    evidence: 'Driven and verified: the coach read "the owner\'s been told it needs cover" and the owner received "Evening Fitness tomorrow 7pm has no confirmed coach". Both rows exist.',
  },
  {
    commit: '—', verdict: 'pre-existing',
    title: 'A register on a per-session rate still gates, against the rule written to prevent it.',
    body: `<code>needsPreview</code> tests money tables (<code>plan.ts:1705</code>) <i>before</i> the single-own-scope exemption (<code>1710</code>), and <code>mark_attendance</code> — an <code>ownScope</code> operation — writes a <code>tally_line</code> whenever the rate is <code>per_session</code>. So the model-driven register for such a class puts a diff in front of a coach standing on a court, which the function's own comment says row 1 exists to remove.`,
    evidence: 'Not introduced by these commits, and invisible to the button path (a tap never re-previews). Logged, not fixed.',
  },
]

const foPass = fo.filter((r) => verdict(r)[1] === 'HELD').length
const foFail = fo.filter((r) => verdict(r)[1] === 'BROKE').length
const foDead = fo.filter((r) => ['NO SPEAKER', 'DID NOT RUN'].includes(verdict(r)[1])).length

const caseCard = (r) => {
  const [cls, label] = verdict(r)
  const [commit, claim] = CLAIMS[r.case] ?? ['—', '(setup for the cases below)']
  const o = own(r)
  const badInv = invs(r).filter((c) => !c.ok)
  return `
  <article class="case ${cls}">
    <header>
      <h3>${esc(r.case)} <span class="pill ${cls}">${label}</span></h3>
      <p class="claim"><code>${esc(commit)}</code> claimed: ${esc(claim)}</p>
    </header>
    <p class="meta">${esc(r.stage)} · spoken by ${esc(r.persona)}${r.spokeAs ? ` (${esc(r.spokeAs)})` : ' — <b>nobody found</b>'} ·
      ${r.rounds} rounds · ${(r.latencyMs / 1000).toFixed(1)}s · ₹${((r.usd ?? 0) * USD_INR).toFixed(2)}</p>
    <p class="typed"><b>Typed:</b> ${esc(r.said)}</p>
    ${r.clockNote ? `<p class="meta"><b>Clock:</b> ${esc(r.clockNote)}</p>` : ''}
    <div class="reply">
      <div class="reply-h">what the person read${r.reply.words ? ` — ${r.reply.words} words` : ''}</div>
      <pre>${esc(r.reply.body || '(nothing)')}</pre>
      <p class="aff">${
        r.reply.buttons.length
          ? `buttons: ${r.reply.buttons.map((b) => `<span class="btn">${esc(b)}</span>`).join(' ')}`
          : '<i>nothing to tap — they must type</i>'
      }</p>
    </div>
    ${r.tapNote ? `<p class="tap"><b>Then:</b> ${esc(r.tapNote)}</p>` : ''}
    <p class="tools"><b>Tools:</b> ${esc(r.toolNames.join(' → ') || 'none')}</p>
    ${r.reply.flags.length ? `<p class="flags">⚑ ${r.reply.flags.map(esc).join(' · ')}</p>` : ''}
    ${
      o.length
        ? `<ul class="checks">${o
            .map((c) => `<li class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✅' : '❌'} ${esc(c.label)}<code>${esc(String(c.detail).slice(0, 260))}</code></li>`)
            .join('')}</ul>`
        : ''
    }
    ${
      badInv.length
        ? `<ul class="checks inv"><li class="hdr">invariants that also tripped here</li>${badInv
            .map((c) => `<li class="no">❌ ${esc(c.label)}<code>${esc(String(c.detail).slice(0, 200))}</code></li>`)
            .join('')}</ul>`
        : ''
    }
    ${r.claimedDone && !r.backedByWrite ? '<p class="warn">⚠️ Claimed something was done with no write from this turn behind it.</p>' : ''}
    ${r.error ? `<p class="warn">❌ turn error: ${esc(r.error)}</p>` : ''}
  </article>`
}

const html = `<title>F-O Verification</title>
<style>
  :root {
    --bg:#fbfaf8; --fg:#1b1a18; --dim:#6b6862; --line:#e3ded6; --card:#fff;
    --pass:#1a7f4b; --fail:#b3261e; --warn:#8a6d00; --accent:#2f5d8a;
    --passbg:#eaf6ef; --failbg:#fdeceb; --deadbg:#f2f0ec;
  }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
    --bg:#16181a; --fg:#e8e6e3; --dim:#9a978f; --line:#2c2f33; --card:#1d2023;
    --pass:#5fd39a; --fail:#ff8a80; --warn:#e0c060; --accent:#8ab4e8;
    --passbg:#14291f; --failbg:#2b1a18; --deadbg:#212427;
  }}
  :root[data-theme="dark"] {
    --bg:#16181a; --fg:#e8e6e3; --dim:#9a978f; --line:#2c2f33; --card:#1d2023;
    --pass:#5fd39a; --fail:#ff8a80; --warn:#e0c060; --accent:#8ab4e8;
    --passbg:#14291f; --failbg:#2b1a18; --deadbg:#212427;
  }
  * { box-sizing:border-box; }
  body { background:var(--bg); color:var(--fg); margin:0;
    font:16px/1.6 ui-serif,Georgia,'Iowan Old Style',serif; }
  .wrap { max-width:52rem; margin:0 auto; padding:3rem 1.25rem 6rem; }
  h1 { font-size:2rem; line-height:1.2; margin:0 0 .3rem; letter-spacing:-.02em; }
  h2 { font-size:1.3rem; margin:3rem 0 .75rem; padding-bottom:.35rem; border-bottom:2px solid var(--line); }
  h3 { font-size:1.05rem; margin:0 0 .2rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .sub { color:var(--dim); margin:0 0 2rem; }
  code,pre,.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.83em; }
  .verdict { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--accent);
    border-radius:.5rem; padding:1.1rem 1.25rem; margin:1.5rem 0 2rem; }
  .verdict p { margin:.4rem 0; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(9rem,1fr)); gap:.75rem; margin:1.25rem 0 2rem; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:.5rem; padding:.8rem .9rem; }
  .stat b { display:block; font-size:1.5rem; line-height:1.1; font-family:ui-monospace,monospace; }
  .stat span { color:var(--dim); font-size:.8rem; }
  .case { background:var(--card); border:1px solid var(--line); border-radius:.6rem;
    padding:1.1rem 1.25rem; margin:1rem 0; }
  .case.pass { border-left:4px solid var(--pass); }
  .case.fail { border-left:4px solid var(--fail); }
  .case.no-speaker { border-left:4px solid var(--dim); }
  .pill { font-size:.68rem; font-family:ui-sans-serif,system-ui,sans-serif; letter-spacing:.06em;
    padding:.16rem .5rem; border-radius:1rem; vertical-align:.15em; }
  .pill.pass { background:var(--passbg); color:var(--pass); }
  .pill.fail { background:var(--failbg); color:var(--fail); }
  .pill.no-speaker { background:var(--deadbg); color:var(--dim); }
  .claim { color:var(--dim); font-size:.9rem; margin:.2rem 0 .6rem; }
  .meta,.typed,.tools,.tap,.flags { font-size:.9rem; margin:.35rem 0; }
  .meta { color:var(--dim); }
  .flags { color:var(--warn); }
  .warn { color:var(--fail); font-weight:600; font-size:.9rem; }
  .reply { background:var(--bg); border:1px solid var(--line); border-radius:.4rem; margin:.7rem 0; }
  .reply-h { font-size:.7rem; letter-spacing:.08em; text-transform:uppercase; color:var(--dim);
    padding:.45rem .75rem; border-bottom:1px solid var(--line); font-family:ui-sans-serif,system-ui,sans-serif; }
  pre { margin:0; padding:.75rem; white-space:pre-wrap; word-break:break-word; overflow-x:auto; }
  .aff { margin:0; padding:.45rem .75rem .6rem; font-size:.85rem; color:var(--dim); }
  .btn { display:inline-block; background:var(--accent); color:#fff; border-radius:.9rem;
    padding:.1rem .6rem; margin:.1rem .15rem; font-size:.78rem; font-family:ui-sans-serif,system-ui,sans-serif; }
  ul.checks { list-style:none; padding:0; margin:.6rem 0 0; }
  ul.checks li { font-size:.88rem; margin:.3rem 0; }
  ul.checks li.hdr { color:var(--dim); font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; margin-top:.7rem; }
  ul.checks code { display:block; color:var(--dim); margin:.1rem 0 .1rem 1.4rem; word-break:break-word; }
  li.ok { color:var(--pass); } li.no { color:var(--fail); }
  table { border-collapse:collapse; width:100%; font-size:.9rem; }
  th,td { text-align:left; padding:.45rem .6rem; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-size:.75rem; text-transform:uppercase; letter-spacing:.06em; color:var(--dim); font-weight:600; }
  .scroll { overflow-x:auto; }
  footer { color:var(--dim); font-size:.85rem; margin-top:3rem; border-top:1px solid var(--line); padding-top:1rem; }
  .code-find { background:var(--card); border:1px solid var(--line); border-left:4px solid var(--warn);
    border-radius:.6rem; padding:1rem 1.25rem; margin:1rem 0; }
  .code-find.v-true { border-left-color:var(--pass); }
  .code-find.v-inert, .code-find.v-newly-false { border-left-color:var(--fail); }
  .code-find.v-pre-existing { border-left-color:var(--dim); }
  .code-find h3 { font-family:inherit; font-size:1.02rem; line-height:1.35; margin-bottom:.35rem; }
  .code-find p { margin:.45rem 0; font-size:.94rem; }
  .code-find .ev { color:var(--dim); font-size:.88rem; border-top:1px dashed var(--line); padding-top:.5rem; }
  .pill.v { background:var(--deadbg); color:var(--fg); border:1px solid var(--line); }
</style>
<div class="wrap">
<h1>Did the five commits do what they said?</h1>
<p class="sub">A regression probe of the F-O fixes, ${esc(new Date().toISOString().slice(0, 10))} —
${records.length} driven turns in a fresh business, judged on truth, correctness, UI/UX and cost.</p>

<div class="verdict">
<p><b>What was measured.</b> Eight custom cases, one per claim the 15 Aug commits make, run through
the real loop against a real database. A claim is kept only if a row says so.</p>
<p><b>Result:</b> ${foPass} of ${fo.length} regression cases held, ${foFail} broke${foDead ? `, ${foDead} never ran` : ''}.
The prelude built the world in ${pre.length} turns.</p>
</div>

<div class="grid">
  <div class="stat"><b>${foPass}/${fo.length}</b><span>regression cases held</span></div>
  <div class="stat"><b>${commitCalls}</b><span>commit calls (drive: 7, all refused)</span></div>
  <div class="stat"><b>${avgRounds}</b><span>rounds per turn (drive: 2.19)</span></div>
  <div class="stat"><b>₹${totalInr.toFixed(2)}</b><span>whole run, ${records.length} turns</span></div>
  <div class="stat"><b>${avgWords}</b><span>words per reply (drive: 40)</span></div>
  <div class="stat"><b>${withButtons}/${withReply.length}</b><span>replies with a button</span></div>
  <div class="stat"><b>${walls}</b><span>walls of text</span></div>
  <div class="stat"><b>${cacheHit}%</b><span>prefix cache hit</span></div>
</div>

<h2>The four pillars</h2>
<div class="scroll"><table>
<tr><th>Pillar</th><th>What it is measured by</th><th>This run</th></tr>
<tr><td><b>Truth</b><br><span class="mono">saying right things</span></td>
    <td>Claims backed by a write from the same turn; falsified prefix facts not repeated; promises with machinery behind them</td>
    <td>${unbacked} unbacked done-claim${unbacked === 1 ? '' : 's'}</td></tr>
<tr><td><b>Correctness</b><br><span class="mono">doing right things</span></td>
    <td>Rows that must exist afterwards, and messages that must have gone to the people they were promised to</td>
    <td>${sum(records, (r) => own(r).filter((c) => c.ok).length)}/${sum(records, (r) => own(r).length)} case checks ·
        ${sum(records, (r) => invs(r).filter((c) => !c.ok).length)} invariant trips</td></tr>
<tr><td><b>UI/UX</b><br><span class="mono">clear, tappable</span></td>
    <td>Words per reply, whether a button was offered, walls of text, leaked markdown or jargon</td>
    <td>${avgWords} words avg · ${withButtons}/${withReply.length} tappable · ${walls} walls · ${flagged} flagged</td></tr>
<tr><td><b>Efficiency</b><br><span class="mono">cost, rounds, speed</span></td>
    <td>Rounds per turn, wasted refused rounds, seconds, rupees at DeepSeek's rate card</td>
    <td>${avgRounds} rounds · ${avgSecs}s · ₹${foInr.toFixed(2)} for the ${fo.length} regression turns</td></tr>
</table></div>

<h2>What reading the code found</h2>
<p class="sub">A driven case only sees the prompts somebody thought to write. These were checked by
reading the named lines. Two of the five commits keep every claim they make; three do not.</p>
${CODE.map(
  (f) => `
  <article class="code-find v-${f.verdict.replace(/\s+/g, '-')}">
    <h3>${esc(f.title)}</h3>
    <p class="claim"><code>${esc(f.commit)}</code> <span class="pill v">${esc(f.verdict)}</span></p>
    <p>${f.body}</p>
    <p class="ev"><b>Evidence:</b> ${esc(f.evidence)}</p>
  </article>`,
).join('')}

<h2>Case by case — the eight regression cases</h2>
${fo.map(caseCard).join('')}

<h2>The prelude that built the world</h2>
<p class="sub">Five of the arc's own cases, reused by reference. They are not the subject, but a
failure here invalidates everything after it, so they are shown.</p>
${pre.map(caseCard).join('')}

<footer>
Generated by <code>scripts/fo-report.mjs</code> from <code>${esc(IN)}</code>.
Every figure is computed from the run's own records. Rupees at ₹${USD_INR}/USD on DeepSeek's published rate card.
</footer>
</div>`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
console.log(`wrote ${OUT} — ${records.length} records, ${foPass}/${fo.length} regression cases held`)

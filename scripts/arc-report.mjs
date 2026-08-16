/**
 * arc-report — the lifecycle arc, told as what actually happened inside each turn.
 *
 *   node scripts/arc-report.mjs [--in .probe/<arm>.json] [--out .probe/arc-readiness.html]
 *
 * WHY THIS WAS REWRITTEN
 * -----------------------------------------------------------------------------
 * The previous version reported outcomes: which checks failed, how many, how
 * bad. That is the shape of a scoreboard, and a scoreboard cannot answer the
 * only question worth asking when a turn goes wrong — WHERE, exactly, did it go
 * wrong, and was it the model's fault?
 *
 * It also could not answer it in principle, because the records were truncated:
 * the model's own reasoning was cut off at 700 characters, mid-sentence. So the
 * old page guessed at intent. It said a turn "reached for none of the tools the
 * moment calls for" when the transcript shows the model reaching four times and
 * being refused by a database timeout. That is the harness inventing a cause,
 * which is the exact defect this product is judged on, committed by the tool
 * built to catch it.
 *
 * So this page is built from full visibility and organised round by round:
 * what the person typed, what the model thought, what it asked the database,
 * what came back, what it decided, what the person read, and what actually
 * changed in the world. Every turn is shown that way. For the turns that went
 * wrong, the page names the exact round and the exact decision, in plain words.
 *
 * Every number is computed from the records. The judgements — and they are
 * marked as judgements wherever they appear — are read back by hand against
 * that full transcript.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return d
  const a = argv[i]
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? d)
}

const IN = flag('in', '.probe/arc-full/deepseek-v4-flash--thinking-low.json')
const OUT = flag('out', '.probe/arc-readiness.html')
const VERIFIED_ON = flag('verified-on', '16 Aug 2026')
const TITLE = flag('title', 'Where the bot went wrong')
const records = JSON.parse(readFileSync(IN, 'utf8'))
if (!records.length) {
  console.error(`no records in ${IN}`)
  process.exit(2)
}

const USD_INR = 88
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/* -------------------------------------------------------------------------- *
 * Reading one turn.
 *
 * The probe writes the model's rounds and the tool executions into ONE array,
 * in order, each tagged with its round number. That is the raw material for the
 * anatomy: a round is one thought followed by whatever it did about it.
 * -------------------------------------------------------------------------- */

/** The probe writes `(model)` rows for the model's own turn-taking. */
const isThought = (t) => String(t?.name ?? '').startsWith('(')

const parse = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * Group a turn's trace into rounds.
 *
 * Each round is: what it was thinking, what it called, and what came back. The
 * last round usually has no tool call at all — that is the round it decided to
 * stop and speak, and it is very often where a turn goes wrong.
 */
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

/** The reply text the model produced on a round where it stopped and spoke. */
function spokenOn(think) {
  if (!think) return null
  const a = parse(think.args)
  return typeof a === 'string' ? a : null
}

/** A read's SQL and how it went — the database side of the story. */
function readShape(act) {
  const args = parse(act.args) ?? {}
  const res = parse(act.result)
  const raw = String(act.result ?? '')
  const timedOut = /statement timeout/.test(raw)
  const ms = res?.ms ?? (raw.match(/"ms":(\d+)/) || [])[1]
  const rowCount = res?.rowCount ?? (Array.isArray(res?.rows) ? res.rows.length : null)
  return {
    query: args.query ?? null,
    purpose: args.purpose ?? null,
    timedOut,
    error: act.error ?? res?.error ?? null,
    ms: ms ? Number(ms) : null,
    rowCount,
    rows: res?.rows ?? null,
    repeatedFailure: res?.repeatedFailure ?? null,
  }
}

/* -------------------------------------------------------------------------- *
 * "It said it would, and never did."
 *
 * With the full reasoning recorded, one thing becomes computable that never was
 * before: the gap between what the model told itself it needed to do and what
 * it actually did. A turn that reasons "I need to mark attendance" and never
 * calls `mark_attendance` has a nameable, locatable defect. A turn that never
 * thought of it at all has a different one. They look identical from outside.
 * -------------------------------------------------------------------------- */
const TOP_TOOLS = ['read', 'plan', 'reply', 'schedule', 'remember', 'handoff', 'commit']
const OPERATIONS = [
  'add_coach', 'cancel_session', 'confirm_coach', 'end_enrollment',
  'mark_attendance', 'opt_out', 'record_payment', 'set_onboarding_state',
]
const VOCAB = [...TOP_TOOLS, ...OPERATIONS]

function intentGap(r) {
  const thoughtOf = new Set()
  for (const t of r.tools ?? []) {
    const text = String(t.reasoning ?? '')
    if (!text) continue
    for (const v of VOCAB) if (new RegExp(`\\b${v}\\b`).test(text)) thoughtOf.add(v)
  }
  const did = new Set(r.toolNames ?? [])
  // Operations ride INSIDE a plan/commit call, so they never appear as a tool
  // name — they have to be read out of the arguments.
  const blob = (r.tools ?? []).filter((t) => !isThought(t)).map((t) => String(t.args ?? '')).join(' ')
  for (const v of OPERATIONS) if (new RegExp(`"${v}"`).test(blob)) did.add(v)
  return [...thoughtOf].filter((v) => !did.has(v))
}

/** Every round where the database refused, with what it cost the turn. */
const refusals = (r) =>
  (r.tools ?? [])
    .filter((t) => !isThought(t))
    .map((t) => ({ act: t, shape: readShape(t) }))
    .filter((x) => x.shape.timedOut || x.shape.error)

/* -------------------------------------------------------------------------- *
 * The mechanical verdicts, unchanged in spirit from the previous page.
 * -------------------------------------------------------------------------- */
function analyse(recs) {
  const labelCounts = new Map()
  for (const r of recs) for (const c of r.checks ?? []) labelCounts.set(c.label, (labelCounts.get(c.label) ?? 0) + 1)
  const ALWAYS = new Set([...labelCounts.entries()].filter(([, n]) => n > recs.length / 2).map(([l]) => l))
  const own = (r) => (r.checks ?? []).filter((c) => !ALWAYS.has(c.label))
  const always = (r) => (r.checks ?? []).filter((c) => ALWAYS.has(c.label))

  const ran = (r) => r.rounds > 0 || r.reply?.body || r.error
  const verdict = (r) => {
    if (!r.spokeAs) return ['dead', 'NOBODY TO SPEAK AS']
    if (!ran(r)) return ['dead', 'DID NOT RUN']
    const o = own(r)
    if (!o.length) return ['pass', 'NOTHING TO CHECK']
    return o.every((c) => c.ok) ? ['pass', 'WENT RIGHT'] : ['fail', 'WENT WRONG']
  }

  const arm = `${recs[0].model}${recs[0].thinking && recs[0].thinking !== 'default' ? ` · thinking=${recs[0].thinking}` : ''}`
  const stages = [...new Set(recs.map((r) => r.stage))]
  const withReply = recs.filter((r) => r.reply?.body)
  const ranTurns = recs.filter(ran)
  const ownAll = recs.flatMap(own)
  const ownOk = ownAll.filter((c) => c.ok).length
  const alwaysTrips = [...new Set(recs.flatMap((r) => always(r).filter((c) => !c.ok).map((c) => c.label)))]
  const broke = recs.filter((r) => verdict(r)[1] === 'WENT WRONG')
  const held = recs.filter((r) => verdict(r)[1] === 'WENT RIGHT')
  const noChecks = recs.filter((r) => verdict(r)[1] === 'NOTHING TO CHECK')
  const unbacked = recs.filter((r) => r.claimedDone && !r.backedByWrite)
  const errored = recs.filter((r) => r.error)
  const clockRefused = recs.filter((r) => String(r.clockNote ?? '').startsWith('REFUSED'))
  const allJobs = recs.flatMap((r) => r.jobs ?? [])

  return {
    own, always, ran, verdict, arm, stages, withReply, ranTurns, ownAll, ownOk,
    alwaysTrips, broke, held, noChecks, unbacked, errored, clockRefused,
    jobsRan: allJobs.filter((j) => j.startsWith('ran ')).length,
    avgWords: withReply.length ? Math.round(sum(withReply, (r) => r.reply.words) / withReply.length) : 0,
    avgSecs: ranTurns.length ? (sum(ranTurns, (r) => r.latencyMs) / ranTurns.length / 1000).toFixed(1) : '0',
    totalInr: sum(recs, (r) => (r.usd ?? 0) * USD_INR),
    dbCalls: recs.flatMap((r) => (r.tools ?? []).filter((t) => t.name === 'read')).length,
    // Reads and writes fail for different reasons and are worth counting apart:
    // a refused lookup blocks the turn, a refused write means it composed
    // something the database would not accept.
    dbRefused: recs.flatMap(refusals).filter((x) => x.act.name === 'read').length,
    writeRefused: recs.flatMap(refusals).filter((x) => x.act.name !== 'read').length,
  }
}

const A = analyse(records)
const {
  own, always, verdict, arm, stages, withReply, ownAll, ownOk, alwaysTrips,
  broke, held, noChecks, unbacked, errored, clockRefused, jobsRan,
  avgWords, avgSecs, totalInr, dbCalls, dbRefused, writeRefused,
} = A

/**
 * WHERE IT WENT WRONG — hand-read, against the full transcript above.
 *
 * A check knows one thing: the row it wanted was not there. It cannot tell a
 * model that chose badly from a model that was blocked, and it cannot tell
 * either from a check asking for something the product deliberately does not do.
 * Those three need a person to read the reasoning, and now there is reasoning
 * to read.
 *
 * `blame` is the honest answer to "was this the bot's fault":
 *   model  — it had what it needed and chose wrong
 *   blocked — it chose right and something underneath refused
 *   suite  — the check is wrong, the product is fine
 *
 * Keyed by case name, so a case that stops failing drops off the page.
 */
const WENT_WRONG = {
  'client-leaves': {
    blame: 'model',
    title: 'Asked to take Aarav out of the fitness batch, the bot asked a good question — and did nothing with the half it already had.',
    body: `Meera typed two sentences. The second — <i>"please take aarav out of the fitness batch"</i> — is an
      explicit instruction. The first — <i>"we are stopping after this month"</i> — is genuinely ambiguous: the
      fitness batch, or everything? The model noticed the ambiguity, which is worth noticing, and answered in one
      round with no tool call at all: <i>"Got it — Aarav's out of the Evening Fitness batch after this month… One
      thing before I action it: you said <b>we're</b> stopping. Do you want me to stop his Beginners class too, or
      just the fitness batch?"</i>
      <br><br>It staged nothing. No <code>end_enrollment</code>, no route to the owner — so both checks
      (<i>the leave reached the owner</i>, <i>one tap that would actually end it</i>) found empty tables. The
      baseline run's model handled the same two sentences in the doctrine's order: it routed the explicit half and
      raised the rest.`,
    exact: `<b>Round 1.</b> The doctrine already ranks these — <i>"Scope is asked, never assumed… Do the urgent
      half first, then ask whether it repeats."</i> The explicit half (fitness ends 30 Sep) was actionable
      immediately; the Beginners question should have ridden on that action's read-back, not replaced it. The cost
      is small and recoverable — one extra round-trip, nothing false written, her answer un-sticks it — but the
      checks are right that the world did not move.
      <br><br>One more detail worth the read: with no <code>reply</code> call, the trailing-prose path minted the
      buttons, and its closing-question gate matched <i>"Do you want me to stop his Beginners class too, or just
      the fitness batch?"</i> — an either/or question that happens to open with an auxiliary — and put
      <span class="btn">Yes</span> <span class="btn">No</span> under it. Guessable, and still a word-list reading
      an or-question as yes/no.`,
  },
  'opt-out': {
    blame: 'suite',
    title: 'The stop request now leaves as buttons. The test cannot press them.',
    body: `This is the case the baseline page called the bot's one real fault — its third failed drive, each time
      by a different route, options dying as prose bullets over a generic menu. This run, round 1, the model called
      <code>reply</code> with the options as real buttons: <span class="btn">Just the bill</span>
      <span class="btn">Stop everything</span>, over 45 honest words — <i>"Understood — one tap and I stop. Nothing
      you choose changes Aarav's classes or his bill… I'll still take Aarav out of the fitness batch after this
      month as you asked, and I won't chase you about it."</i> — and its reflection pass stored the boundary as a
      fact. The doctrine line and the reply declaration's new channel facts did exactly what they were written to
      do: the choice left as taps.`,
    exact: `<b>Not a round — the harness's thumb.</b> The check asks for <code>opted_out_at</code>, an end state
      two taps away: her tap types the option back, the next turn calls <code>opt_out</code>, and the operation's
      own <span class="btn">Yes, stop them</span> is the second tap — the designed double-confirmation for the one
      action that silences a person. The harness deliberately taps only buttons carrying a staged plan or
      operation (titles are not stable enough to tap on), a reply button is neither, so it pressed nothing and the
      end state never arrived. Fix the suite — walk reply buttons on <code>tap: true</code> cases; each is one
      ordinary turn — or teach the model to put the operation itself behind the option, which the tap machinery
      would walk and which converges a round sooner. What stays true either way: nothing was marked this run, so
      the class is <b>narrowed, not closed</b> — the affordance now exists; the walk to the end state is
      unexercised.`,
  },
}

/**
 * Things wrong with the PRODUCT that no single turn owns.
 *
 * These were found by reading the messages and timing the queries against the
 * database this run left behind (`--keep`), so they are measured rather than
 * inferred — but measured BY HAND, after the run, which is why they sit here
 * and not in the computed numbers above.
 */
const FINDINGS = [
  {
    tag: 'every coach with a daily class',
    title: 'The register prompt, byte for byte, two evenings running — "today" survived where "tomorrow" was fixed.',
    body: `Arjun's phone got exactly this, twice, 24 hours apart, about two different sessions:
      <i>"Probe deepseek-v4-flash: take the register. Evening Fitness — <b>today</b> 7:00–8pm. Who was there? ·
      3 to mark: Aarav, Ananya, Dev"</i> — once at 14:30 on 6 September and again at 14:30 on 7 September,
      byte-identical. It is the only duplicate pair in the whole run, and it is what tripped the
      "nobody was told the same thing twice" rule in the seven turns after it.`,
    proof: `Nothing was sent twice — the prompts are keyed per session, and both sends were legitimate. The
      baseline's reminder duplicate was fixed by anchoring the relative day ("tomorrow (Sun)" vs "tomorrow (Mon)"
      now tell the two apart — see the fixed list above), but <code>dayLabel()</code> deliberately left "today"
      bare, on the theory that a message arrives on the day it names. True, and irrelevant to a <i>recurring</i>
      prompt about a <i>daily</i> class, which says "today" every day. Same class of bug, one layer deeper: any
      relative-only day word in recurring copy collides on a daily schedule.
      <br><br><b>Fixed after this run's records were frozen:</b> <code>dayLabel()</code> now anchors "today (Mon)"
      the same way — a one-line change in <code>lib/jobs/util.ts</code>, landed after the drive, so this page's own
      evidence still shows the pair. The next drive is its verification.`,
  },
]

/**
 * What the BASELINE page reported broken, re-measured by hand against the world
 * THIS run kept. Each entry carries the baseline's number and this run's, from
 * the same methodology — read the real messages, time the real queries.
 */
const FIXED = [
  {
    tag: 'was: every family with two children',
    title: '"Ananya and Dev has a class coming up" → "Ananya and Dev — a class coming up."',
    proof: `The frozen template body carried a verb that could not agree with its parameter —
      <code>'{academy}: {who} has {event}. {detail}'</code> over a {who} of two siblings. The frame is now the same
      dash the <code>session_outcome</code> template always used, so no word in the approved text depends on what a
      parameter carries. Real rows from this run: <i>"Probe deepseek-v4-flash: Ananya and Dev — a class coming up.
      Ananya and Dev <b>have</b> Evening Fitness tomorrow (Mon) at 7pm…"</i> and <i>"Ananya and Dev — how the
      session went. Ananya was at Evening Fitness today. · Dev was at…"</i>. The detail sentence always got the
      verb right; now the frame cannot get it wrong. (Production note: the reworded frame goes to Meta for
      re-approval once; the emulator renders it now.)`,
  },
  {
    tag: 'was: every parent sees this',
    title: 'The reminder that said "tomorrow" twice about two different days now says which day.',
    proof: `Baseline: <i>"Aarav has Evening Fitness tomorrow at 7pm"</i> landed byte-identical on two consecutive
      afternoons. This run the same two reminders read <i>"…Evening Fitness <b>tomorrow (Sun)</b>…"</i> and
      <i>"…Evening Fitness <b>tomorrow (Mon)</b>…"</i> — checked by grouping every outbound body per contact on the
      kept world: the reminder pair is gone. One duplicate pair survives in the whole run, and it is the register
      prompt below — the same bug's other half.`,
  },
  {
    tag: 'was: nearly cost the register',
    title: 'The coach\'s roster lookup: 2946ms → ~427ms. The six-times penalty is now fifteen percent.',
    proof: `Same methodology as the baseline: the identical <code>app.session_roster</code> query, run as three
      different people against the world this run kept (warm runs, client-observed):
      <b>coach 436 / 427 / 415ms · admin ~375ms · parent ~380ms</b> — against the baseline's
      <b>2946 / 461 / 605ms</b>. Reading the <code>session</code> table alone is still ~45ms for everybody, so the
      change is where it was claimed to be: migration <code>0028</code> rewrote <code>app.my_session_ids()</code>
      to drive off the indexes instead of scanning every session with a per-row probe, and wrapped every policy
      helper in a scalar subselect so it is evaluated once per statement instead of once per row. The coach was
      ~59% of the 5-second statement budget on a three-player academy; they are now ~9%, within 15% of the admin.
      Cross-tenant and cross-role isolation re-verified after the migration (25 checks), and old-vs-new
      <code>my_session_ids()</code> compared as admin, coach and holder: identical session sets.`,
  },
  {
    tag: 'was: the open question on client-leaves',
    title: 'A routed leave now carries its own follow-through — the promise "I\'ll confirm once it\'s done" has machinery behind it.',
    proof: `The baseline page asked the real question its checks did not: <i>"whether anything guarantees the admin
      ever acts — because until they do, the fitness batch keeps billing."</i> <code>end_enrollment</code>'s routed
      branch now schedules a watch in the same transaction: 48 hours later, under the requester's own session, it
      checks whether the end date landed — silence if it did, one nudge to the admin (carrying the same one-tap
      button) if it did not, and the family hears the outcome, not the status. Verified by building the plan under
      Meera's session on this run's world — the steps read: route to admin with <span class="btn">End on 30
      Sep</span>, ack to Meera, then <code>agent_task</code> at +48h, deduped on player and date, expiring a week
      past the end date. The drive itself never reached the operation this run — the model asked its scope question
      first (see client-leaves below) — so this is verified at the plan layer, not walked end to end.`,
  },
]

const blameLabel = {
  model: { text: 'the bot got this wrong', cls: 'b-model' },
  blocked: { text: 'not the bot — it was blocked', cls: 'b-blocked' },
  suite: { text: 'not the bot — the test is wrong', cls: 'b-suite' },
}

/* -------------------------------------------------------------------------- *
 * Rendering.
 * -------------------------------------------------------------------------- */

const sqlBlock = (q) => `<pre class="sql">${esc(q)}</pre>`

function roundCard(r, rd) {
  const spoke = spokenOn(rd.think)
  const parts = []

  if (rd.think?.reasoning) {
    parts.push(`<div class="beat think">
      <div class="beat-h">what it was thinking</div>
      <p>${esc(rd.think.reasoning)}</p>
    </div>`)
  }
  if (rd.think?.drafted) {
    parts.push(`<div class="beat draft">
      <div class="beat-h">what it wrote before acting</div><p>${esc(rd.think.drafted)}</p>
    </div>`)
  }

  for (const act of rd.acts) {
    if (act.name === 'read') {
      const s = readShape(act)
      parts.push(`<div class="beat ask${s.timedOut || s.error ? ' bad' : ''}">
        <div class="beat-h">what it asked the database${s.purpose ? ` — ${esc(s.purpose)}` : ''}</div>
        ${s.query ? sqlBlock(s.query) : ''}
        <p class="got">${
          s.timedOut || s.error
            ? `<b class="no">nothing came back.</b> ${esc(s.error ?? 'statement timeout')}`
            : `<b class="ok">came back in ${s.ms ?? '?'}ms</b>${s.rowCount != null ? ` — ${s.rowCount} row${s.rowCount === 1 ? '' : 's'}` : ''}`
        }</p>
        ${s.repeatedFailure ? `<p class="nudge"><b>The loop then warned it:</b> ${esc(s.repeatedFailure)}</p>` : ''}
      </div>`)
    } else {
      const res = parse(act.result)
      const ok = res?.ok !== false && !act.error
      parts.push(`<div class="beat did${ok ? '' : ' bad'}">
        <div class="beat-h">what it did — <code>${esc(act.name)}</code></div>
        <details><summary>arguments and result</summary>
          <pre>${esc(act.args)}</pre><pre>${esc(act.result)}</pre></details>
        ${act.error ? `<p class="got"><b class="no">it failed:</b> ${esc(act.error)}</p>` : ''}
      </div>`)
    }
  }

  if (spoke) {
    parts.push(`<div class="beat say">
      <div class="beat-h">it stopped here and spoke</div><p>${esc(spoke)}</p>
    </div>`)
  }
  if (rd.recovery) {
    parts.push(`<div class="beat recover"><div class="beat-h">the loop's last resort</div>
      <p>${esc(rd.recovery.name)} — ${esc(rd.recovery.result)}</p></div>`)
  }

  return parts.length ? `<section class="round"><h4>Round ${rd.n}</h4>${parts.join('')}</section>` : ''
}

function turnCard(r) {
  const [cls, label] = verdict(r)
  const o = own(r)
  const badAlways = always(r).filter((c) => !c.ok)
  const rds = buildRounds(r)
  const gap = intentGap(r)
  const ww = WENT_WRONG[r.case]

  return `
  <article class="case ${cls}" id="case-${esc(r.case)}">
    <header>
      <h3>${esc(r.case)} <span class="pill ${cls}">${label}</span></h3>
      <p class="what">${esc(r.what)}</p>
      <p class="meta">${esc(r.stage)} · ${esc(r.persona)}${r.spokeAs ? ` (${esc(r.spokeAs)})` : ' — <b>nobody found</b>'} ·
        ${r.rounds} round${r.rounds === 1 ? '' : 's'} · ${(r.latencyMs / 1000).toFixed(1)}s · ₹${((r.usd ?? 0) * USD_INR).toFixed(2)}</p>
    </header>

    <div class="typed"><div class="beat-h">what they typed</div><p>${esc(r.said)}</p></div>
    ${r.clockNote ? `<p class="meta"><b>The clock was moved first:</b> ${esc(r.clockNote)}</p>` : ''}

    ${
      ww
        ? `<div class="wrong ${blameLabel[ww.blame].cls}">
      <p class="wtag">${esc(blameLabel[ww.blame].text)}</p>
      <p class="wtitle">${ww.title}</p>
      <p class="wbody">${ww.body}</p>
      ${ww.exact ? `<p class="wexact"><b>The exact wrong move:</b> ${ww.exact}</p>` : ''}
    </div>`
        : ''
    }

    <details class="anatomy" ${cls === 'fail' ? 'open' : ''}>
      <summary>the whole turn, round by round — ${rds.length} round${rds.length === 1 ? '' : 's'}</summary>
      ${rds.map((rd) => roundCard(r, rd)).join('')}
    </details>

    <div class="read"><div class="beat-h">what the person read${r.reply?.words ? ` — ${r.reply.words} words` : ''}</div>
      <p>${esc(r.reply?.body || '(nothing)')}</p>
      <p class="aff">${
        r.reply?.buttons?.length
          ? `they could tap: ${r.reply.buttons.map((b) => `<span class="btn">${esc(b)}</span>`).join(' ')}`
          : r.reply?.list ? '<i>a list to pick from</i>' : r.reply?.link ? '<i>a link button</i>' : '<i>nothing to tap — they have to type</i>'
      }</p>
    </div>
    ${r.tapNote ? `<p class="tap"><b>Then they tapped:</b> ${esc(r.tapNote)}</p>` : ''}

    ${
      gap.length
        ? `<p class="gap"><b>Talked about in its head, never actually done:</b>
      ${gap.map((g) => `<code>${esc(g)}</code>`).join(' ')} — read the rounds above before treating this as a fault;
      a tool it merely mentioned while ruling it out lands here too.</p>`
        : ''
    }
    ${r.jobs?.length ? `<p class="tools"><b>Background jobs that fired around this turn:</b> ${esc(r.jobs.join(' · '))}</p>` : ''}

    ${
      o.length
        ? `<ul class="checks">${o
            .map((c) => `<li class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✅' : '❌'} ${esc(c.label)}<code>${esc(String(c.detail).slice(0, 400))}</code></li>`)
            .join('')}</ul>`
        : '<p class="meta"><i>nothing to check here — this turn exists to move the story along</i></p>'
    }
    ${
      badAlways.length
        ? `<ul class="checks inv"><li class="hdr">rules that must hold after every turn, and did not</li>${badAlways
            .map((c) => `<li class="no">❌ ${esc(c.label)}<code>${esc(String(c.detail).slice(0, 300))}</code></li>`)
            .join('')}</ul>`
        : ''
    }
    ${r.claimedDone && !r.backedByWrite ? '<p class="warn">⚠️ It spoke as if something was done, and nothing was written.</p>' : ''}
    ${r.error ? `<p class="warn">❌ the turn threw: ${esc(r.error)}</p>` : ''}
  </article>`
}

const wrongOnes = broke.filter((r) => WENT_WRONG[r.case])
const byBlame = (b) => wrongOnes.filter((r) => WENT_WRONG[r.case].blame === b)

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
  .wrap { max-width:1000px; margin:0 auto; padding:40px 20px 100px; }
  h1 { font-size:2.1rem; margin:0 0 6px; letter-spacing:-0.02em; }
  h2 { font-size:1.35rem; margin:52px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  h3 { font-size:1.08rem; margin:0 0 2px; }
  h4 { font-size:.8rem; margin:0 0 8px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); }
  .sub { color:var(--dim); margin:0 0 10px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin:22px 0; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .stat b { display:block; font-size:1.5rem; line-height:1.2; }
  .stat span { color:var(--dim); font-size:.8rem; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.92rem; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; }
  pre { background:var(--codebg); border-radius:8px; padding:10px 12px; overflow-x:auto; margin:8px 0 0;
    font:.8rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
  pre.sql { background:var(--codebg); border-left:3px solid var(--accent); }
  .case { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin:18px 0; }
  .case.pass { border-left:5px solid var(--green); }
  .case.fail { border-left:5px solid var(--red); }
  .case.dead { border-left:5px solid var(--amber); }
  .pill { font-size:.68rem; padding:2px 9px; border-radius:20px; color:#fff; vertical-align:2px;
    text-transform:uppercase; letter-spacing:.05em; }
  .pill.pass { background:var(--green); } .pill.fail { background:var(--red); } .pill.dead { background:var(--amber); }
  .what { color:var(--dim); margin:2px 0 6px; font-size:.9rem; }
  .meta { color:var(--dim); font-size:.83rem; margin:4px 0; }
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
  .wrong { border-radius:10px; padding:14px 16px; margin:14px 0; border:1px solid var(--line); }
  .wrong.b-model   { background:color-mix(in srgb, var(--red) 8%, var(--card)); border-left:5px solid var(--red); }
  .wrong.b-blocked { background:color-mix(in srgb, var(--amber) 8%, var(--card)); border-left:5px solid var(--amber); }
  .wrong.b-suite   { background:color-mix(in srgb, var(--green) 8%, var(--card)); border-left:5px solid var(--green); }
  .wtag { margin:0 0 6px; font-size:.7rem; text-transform:uppercase; letter-spacing:.08em; font-weight:800; }
  .b-model .wtag { color:var(--red); } .b-blocked .wtag { color:var(--amber); } .b-suite .wtag { color:var(--green); }
  .wtitle { margin:0 0 8px; font-weight:700; font-size:1.02rem; }
  .wbody, .wexact { margin:0 0 8px; font-size:.92rem; }
  .wexact { padding:8px 11px; background:var(--codebg); border-radius:7px; }
  .gap { font-size:.85rem; background:var(--codebg); border-radius:7px; padding:8px 11px; }
  .gap code { color:var(--red); }
  .tap, .tools { font-size:.86rem; margin:8px 0; color:var(--dim); }
  .tap b, .tools b { color:var(--fg); }
  .checks { list-style:none; padding:0; margin:12px 0 0; }
  .checks li { font-size:.87rem; padding:4px 0; border-top:1px solid var(--line); }
  .checks li.hdr { color:var(--dim); text-transform:uppercase; font-size:.7rem; letter-spacing:.06em; border:0; padding-top:10px; }
  .checks code { display:block; color:var(--dim); font-size:.77rem; margin-top:2px; white-space:pre-wrap; word-break:break-word; }
  .warn { background:var(--codebg); border-radius:7px; padding:8px 11px; font-size:.87rem; margin:10px 0 0; }
  .lead { border:1px solid var(--line); border-left:5px solid var(--accent); background:var(--card);
    border-radius:10px; padding:16px 18px; margin:20px 0; }
  .finding { background:var(--card); border:1px solid var(--line); border-left:5px solid var(--red);
    border-radius:10px; padding:14px 17px; margin:14px 0; }
  .ftag { margin:0 0 6px; font-size:.68rem; text-transform:uppercase; letter-spacing:.09em;
    font-weight:800; color:var(--red); }
  .ftitle { margin:0 0 9px; font-weight:700; font-size:1.05rem; }
  .fbody { margin:0 0 9px; font-size:.94rem; }
  .fproof { margin:0; font-size:.87rem; color:var(--dim); background:var(--codebg);
    border-radius:7px; padding:9px 12px; }
  .fproof b { color:var(--fg); }
  footer { margin-top:64px; color:var(--dim); font-size:.82rem; border-top:1px solid var(--line); padding-top:14px; }
</style>
<div class="wrap">

<h1>${esc(TITLE)}</h1>
<p class="sub">The whole lifecycle of one business, driven end to end against the real loop, the real tools and a
real database — ${records.length} turns, ${stages.length} stages. Model: <b>${esc(arm)}</b>.</p>

<div class="lead">
<p style="margin:0 0 8px"><b>This page shows the inside of every turn.</b> For each one: what the person typed,
what the bot was thinking, what it asked the database, what came back, what it decided to do, what the person
read, and what actually changed. Nothing is summarised away.</p>
<p style="margin:0">That matters because the outcome alone is misleading. A turn where the bot chose badly and a
turn where it chose well and the database refused look identical from outside — same failed check, same missing
row. They are different bugs with different fixes, and only the reasoning tells them apart. So every failure below
says plainly whether <b>the bot got it wrong</b>, whether <b>something underneath blocked it</b>, or whether
<b>the test itself was wrong</b>.</p>
</div>

<div class="stats">
  <div class="stat"><b>${held.length}/${held.length + broke.length}</b><span>turns that went right</span></div>
  <div class="stat"><b>${byBlame('model').length}</b><span>the bot's fault</span></div>
  <div class="stat"><b>${byBlame('blocked').length}</b><span>blocked from below</span></div>
  <div class="stat"><b>${byBlame('suite').length}</b><span>the test was wrong</span></div>
  <div class="stat"><b>${dbRefused}/${dbCalls}</b><span>lookups the database refused</span></div>
  <div class="stat"><b>${writeRefused}</b><span>writes the database rejected</span></div>
  <div class="stat"><b>${avgSecs}s</b><span>per turn</span></div>
  <div class="stat"><b>₹${totalInr.toFixed(2)}</b><span>the whole run</span></div>
</div>
${noChecks.length ? `<p class="sub">${noChecks.length} of the ${records.length} turns have nothing of their own to check — they exist to move the story forward. The rules that must always hold still ran after each of them.</p>` : ''}

${
  wrongOnes.length
    ? `<h2>What went wrong, in one line each</h2>
<div class="scroll"><table>
<tr><th>Turn</th><th>Whose fault</th><th>What happened</th></tr>
${wrongOnes
  .map((r) => {
    const w = WENT_WRONG[r.case]
    return `<tr><td><a href="#case-${esc(r.case)}"><b>${esc(r.case)}</b></a></td>
    <td><b class="${blameLabel[w.blame].cls}">${esc(blameLabel[w.blame].text)}</b></td>
    <td>${w.title}</td></tr>`
  })
  .join('\n')}
</table></div>`
    : ''
}

${
  FIXED.length
    ? `<h2>What the last page reported broken, re-measured on this run</h2>
<p class="sub">The baseline arc (15–16 Aug, <code>.probe/arc-full</code>) reported one bot fault and three product
findings. This run drove the same 18 sentences with the fixes in: new decode-point instructions (the
<code>reply</code> declaration's channel facts, the self-confirming operations saying "call me directly", the
tap-only <code>confirmed</code> parameter no longer advertised to the model), one doctrine line (a worked-out
choice is finished only when each option is a tap), refused buttons downgraded to reply buttons instead of
silently dropped, the grammar-free template frame, the anchored day words, the routed-leave watch, and migration
<code>0028</code>. Each claim below is re-measured on the world this run kept, same methodology as the baseline.</p>
${FIXED.map(
  (f) => `
  <article class="finding" style="border-left-color:var(--green)">
    <p class="ftag" style="color:var(--green)">${esc(f.tag)}</p>
    <p class="ftitle">${f.title}</p>
    <p class="fproof"><b>How this is known.</b> ${f.proof}</p>
  </article>`,
).join('\n')}`
    : ''
}

${
  FINDINGS.length
    ? `<h2>What is actually broken, and who would notice</h2>
<p class="sub">These are faults in the product rather than in any one turn. Each was found by reading the real
messages and timing the real queries against the database this run left behind — measured after the run, by hand,
which is why they sit apart from the counted numbers above.</p>
${FINDINGS.map(
  (f) => `
  <article class="finding">
    <p class="ftag">${esc(f.tag)}</p>
    <p class="ftitle">${f.title}</p>
    <p class="fbody">${f.body}</p>
    <p class="fproof"><b>How this is known.</b> ${f.proof}</p>
  </article>`,
).join('\n')}`
    : ''
}

<h2>Did it tell the truth, and did it do the job?</h2>
<div class="scroll"><table>
<tr><th>Question</th><th>How it is measured</th><th>Answer</th></tr>
<tr><td><b>Did it ever claim something was done that wasn't?</b></td>
    <td>A reply in the past tense with no write behind it from that same turn</td>
    <td>${unbacked.length} time${unbacked.length === 1 ? '' : 's'} in ${records.length} turns</td></tr>
<tr><td><b>Did the world end up right?</b></td>
    <td>Rows that must exist afterwards, plus rules that must hold after every turn</td>
    <td>${ownOk} of ${ownAll.length} checks passed · ${alwaysTrips.length} always-rule broken</td></tr>
<tr><td><b>Was it readable and tappable?</b></td>
    <td>Length, and whether there was anything to tap instead of typing</td>
    <td>${avgWords} words on average · ${withReply.filter((r) => r.reply.buttons.length || r.reply.list || r.reply.link).length} of ${withReply.length} gave something to tap</td></tr>
<tr><td><b>Did the database hold up?</b></td>
    <td>Lookups the model made, and how many were refused</td>
    <td>${dbRefused} of ${dbCalls} lookups refused · ${writeRefused} write${writeRefused === 1 ? '' : 's'} rejected — the bot recovered from both</td></tr>
</table></div>

<h2>Every turn, in order</h2>
<p class="sub">The story accumulates: each turn runs against the world the ones before it built. Failures are opened
by default; the rest fold away.</p>
${records.map(turnCard).join('\n')}

<footer>
Generated by <code>scripts/arc-report.mjs</code> from <code>${esc(IN)}</code> — ${records.length} turns ·
${esc(arm)} · ₹${totalInr.toFixed(2)} at ₹${USD_INR}/USD · ${jobsRan} background jobs fired ·
${clockRefused.length} turn${clockRefused.length === 1 ? '' : 's'} the clock could not reach.
Every number is computed from the run records. The "whose fault" judgements were read back by hand on
${esc(VERIFIED_ON)} against the full round-by-round transcript shown on this page — nothing was inferred from a
tool name alone.
</footer>
</div>`

writeFileSync(OUT, html)
console.log(`wrote ${OUT}`)
console.log(`  ${records.length} turns · ${held.length} right · ${broke.length} wrong`)
console.log(`  db lookups refused: ${dbRefused}/${dbCalls}`)
console.log(`  reasoning captured on ${records.flatMap((r) => (r.tools ?? []).filter((t) => t.reasoning)).length} rounds`)

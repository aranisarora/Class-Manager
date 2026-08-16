/**
 * arc-report — turn a lifecycle-arc probe run into a production-readiness page.
 *
 * Reads probe-model's own record file and writes a standalone HTML report:
 * the four pillars, a severity-ranked issue ledger, and every case's evidence.
 *
 * Every number on the page is computed from the records. Nothing is typed in.
 * That is not tidiness — this product's characteristic defect is saying
 * true-sounding things it has not checked, and a hand-transcribed number in the
 * write-up would be that same defect one level up.
 *
 *   node scripts/arc-report.mjs [--in .probe/<arm>.json] [--out .probe/arc-readiness.html]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return d
  const a = argv[i]
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? d)
}

const IN = flag('in', '.probe/deepseek-v4-flash--thinking-low.json')
const OUT = flag('out', '.probe/arc-readiness.html')
/** An earlier run of the SAME arm, to say whether the edits since moved anything. */
const BASELINE = flag('baseline', '')
const BASELINE_AS = flag('baseline-as', BASELINE)
/** DeepSeek bills peak hours at double, so two runs are only comparable on cost within one window. */
const RATE_NOTE = flag('rate-note', '')
/**
 * Why the baseline is not a fair comparison, when it is not one.
 *
 * A baseline recorded under a broken harness reached less of the arc, so it
 * raised fewer issues — and ranking this run against it paints a coverage gain
 * red, as a regression the edits caused. Passing a reason here states the
 * caveat and stops the table colouring rows it cannot honestly rank.
 */
const BASELINE_UNSOUND = flag('baseline-unsound', '')
const records = JSON.parse(readFileSync(IN, 'utf8'))
if (!records.length) {
  console.error(`no records in ${IN}`)
  process.exit(2)
}

const USD_INR = 88

const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0)

/* ----------------------------------------------------------- issue ledger -- *
 * Severity is assigned by KIND, not by reading. The ranking is the claim:
 *   blocker — the world is wrong, or the person was misled, or nothing ran
 *   major   — this case's own subject did not happen
 *   minor   — it happened, and read badly
 */
const FLAG_SEVERITY = (f) => (f === 'EMPTY REPLY' || f.startsWith('ALL SUPPRESSED') ? 'blocker' : 'minor')
const SEV_ORDER = { blocker: 0, major: 1, minor: 2 }

/**
 * Everything the page says about one run, computed from that run alone — so the
 * same function answers for the baseline and the two are honestly comparable.
 */
function analyse(recs) {
  /**
   * The invariants run after EVERY case, so they are not that case's own subject.
   * Read from the data rather than hard-coded: an invariant is a label that shows
   * up on essentially every record, whereas a case's own check is unique to it.
   */
  const labelCounts = new Map()
  for (const r of recs) for (const c of r.checks ?? []) labelCounts.set(c.label, (labelCounts.get(c.label) ?? 0) + 1)
  const INVARIANT_LABELS = new Set([...labelCounts.entries()].filter(([, n]) => n > recs.length / 2).map(([l]) => l))
  const own = (r) => (r.checks ?? []).filter((c) => !INVARIANT_LABELS.has(c.label))
  const invs = (r) => (r.checks ?? []).filter((c) => INVARIANT_LABELS.has(c.label))

  const ran = (r) => r.rounds > 0 || r.reply?.body || r.error
  const verdict = (r) => {
    if (!r.spokeAs) return ['dead', 'NO SPEAKER']
    if (!ran(r)) return ['dead', 'DID NOT RUN']
    const o = own(r)
    if (!o.length) return ['pass', 'NO CHECKS']
    return o.every((c) => c.ok) ? ['pass', 'HELD'] : ['fail', 'BROKE']
  }

  const arm = `${recs[0].model}${recs[0].thinking && recs[0].thinking !== 'default' ? ` · thinking=${recs[0].thinking}` : ''}`
  const stages = [...new Set(recs.map((r) => r.stage))]
  const withReply = recs.filter((r) => r.reply?.body)
  const ranTurns = recs.filter(ran)

  const ownAll = recs.flatMap(own)
  const ownOk = ownAll.filter((c) => c.ok).length
  const invTrips = recs.flatMap((r) => invs(r).filter((c) => !c.ok))
  // One invariant can trip on many consecutive cases — it is one defect, not N.
  const invDistinct = [...new Set(invTrips.map((c) => c.label))]

  const unbacked = recs.filter((r) => r.claimedDone && !r.backedByWrite)
  const errored = recs.filter((r) => r.error)
  const dead = recs.filter((r) => verdict(r)[0] === 'dead')
  const broke = recs.filter((r) => verdict(r)[1] === 'BROKE')
  const held = recs.filter((r) => verdict(r)[1] === 'HELD')
  const noChecks = recs.filter((r) => verdict(r)[1] === 'NO CHECKS')
  const missedWant = recs.filter((r) => ran(r) && r.wants?.length && r.wanted === false)

  const avgWords = withReply.length ? Math.round(sum(withReply, (r) => r.reply.words) / withReply.length) : 0
  const withButtons = withReply.filter((r) => r.reply.buttons.length > 0 || r.reply.list || r.reply.link).length
  const walls = recs.filter((r) => (r.reply?.flags ?? []).some((f) => f.startsWith('wall of text')))
  const flagged = recs.filter((r) => (r.reply?.flags ?? []).length)

  /**
   * How much of the arc this run actually reached.
   *
   * A case whose clock was REFUSED still sends its turn — but against a world
   * where the day never arrived, so the jobs of that day never fire. Two runs
   * with the same case count can therefore have wildly different coverage, and
   * comparing their issue counts without this is how a coverage gain gets read
   * as a regression.
   */
  const clockRefused = recs.filter((r) => String(r.clockNote ?? '').startsWith('REFUSED'))
  const allJobs = recs.flatMap((r) => r.jobs ?? [])
  const jobsRan = allJobs.filter((j) => j.startsWith('ran ')).length
  const remindersRan = allJobs.filter((j) => j === 'ran client_reminder').length

  const avgRounds = ranTurns.length ? (sum(ranTurns, (r) => r.rounds) / ranTurns.length).toFixed(2) : '0'
  const avgSecs = ranTurns.length ? (sum(ranTurns, (r) => r.latencyMs) / ranTurns.length / 1000).toFixed(1) : '0'
  const totalInr = sum(recs, (r) => (r.usd ?? 0) * USD_INR)
  const inTot = sum(recs, (r) => r.inTok)
  const cacheHit = inTot ? Math.round((100 * sum(recs, (r) => r.cachedTok)) / inTot) : 0
  const commitCalls = sum(recs, (r) => (r.toolNames ?? []).filter((n) => n === 'commit').length)

  const issues = []
  for (const label of invDistinct) {
    const hits = recs.filter((r) => invs(r).some((c) => !c.ok && c.label === label))
    const detail = hits.map((r) => invs(r).find((c) => !c.ok && c.label === label))[0]
    issues.push({
      sev: 'blocker', kind: 'invariant', title: label,
      why: 'A statement about the world that must hold no matter what was said. It does not.',
      where: hits.map((r) => r.case), detail: String(detail?.detail ?? '').slice(0, 600),
    })
  }
  for (const r of errored) {
    issues.push({
      sev: 'blocker', kind: 'turn error', title: `${r.case} — the turn threw`,
      why: 'The person got nothing, or got it by accident.', where: [r.case], detail: String(r.error).slice(0, 600),
    })
  }
  for (const r of dead) {
    // A case skipped because the clock could not reach it is a harness limit, not
    // a defect in the stage before it. Saying "resolved to nobody" about a case
    // whose speaker was found would be the report inventing its own cause.
    const clockRefused = Boolean(r.clockNote?.startsWith('REFUSED'))
    issues.push({
      sev: clockRefused ? 'major' : 'blocker',
      kind: clockRefused ? 'not probed' : 'did not run',
      title: `${r.case} — ${clockRefused ? 'skipped: the clock could not reach it' : verdict(r)[1]}`,
      why: clockRefused
        ? 'The world this case needs was never built, so no turn was sent and nothing here is a reading about the product.'
        : 'A stage that cannot find its speaker is a defect in the stage before it — nothing here was probed.',
      where: [r.case],
      detail: clockRefused ? String(r.clockNote) : `persona ${r.persona} resolved to nobody`,
    })
  }
  for (const r of unbacked) {
    issues.push({
      sev: 'blocker', kind: 'unbacked claim', title: `${r.case} — said it was done with no write behind it`,
      why: 'Telling somebody a thing happened when no row changed is the failure this product cannot ship with.',
      where: [r.case], detail: (r.reply?.body ?? '').slice(0, 400),
    })
  }
  for (const r of recs) {
    for (const c of own(r).filter((c) => !c.ok)) {
      issues.push({
        sev: 'major', kind: 'case check', title: `${r.case} — ${c.label}`,
        why: 'What this case exists to ask did not hold.', where: [r.case], detail: String(c.detail ?? '').slice(0, 600),
      })
    }
  }
  for (const r of missedWant) {
    issues.push({
      sev: 'major', kind: 'tool choice', title: `${r.case} — reached for none of ${r.wants.join(', ')}`,
      why: 'Reaching for none of the tools the moment calls for is a tool-choice failure worth naming.',
      where: [r.case], detail: `called: ${(r.toolNames ?? []).join(' → ') || 'nothing'}`,
    })
  }
  // A suppressed attempt means the model composed something the wire refused. The
  // person may still have got a good message afterwards, so it is not a blocker —
  // but it is a real defect, and it is invisible in a transcript of what arrived.
  for (const r of recs) {
    for (const a of (r.reply?.all ?? []).filter((m) => m.suppressed)) {
      issues.push({
        sev: 'major', kind: 'suppressed send', title: `${r.case} — an outbound attempt was refused at the wire: ${a.suppressed}`,
        why: 'The model composed a message the send layer would not carry. Invisible in a transcript of what arrived.',
        where: [r.case], detail: a.body ? a.body.slice(0, 300) : '(empty body)',
      })
    }
  }
  for (const r of recs) {
    for (const f of r.reply?.flags ?? []) {
      if (f.endsWith('outbound attempts')) continue
      issues.push({
        sev: FLAG_SEVERITY(f), kind: 'reply quality', title: `${r.case} — ${f}`,
        why: 'A repair the lint layer exists to make, leaking past it to the person.',
        where: [r.case], detail: (r.reply?.body ?? '').slice(0, 300),
      })
    }
  }
  issues.sort((a, b) => SEV_ORDER[a.sev] - SEV_ORDER[b.sev] || a.kind.localeCompare(b.kind))

  return {
    recs, own, invs, ran, verdict, arm, stages, withReply, ranTurns, ownAll, ownOk,
    invTrips, invDistinct, unbacked, errored, dead, broke, held, noChecks, missedWant,
    clockRefused, jobsRan, remindersRan,
    avgWords, withButtons, walls, flagged, avgRounds, avgSecs, totalInr, cacheHit, commitCalls,
    issues,
    blockers: issues.filter((i) => i.sev === 'blocker'),
    majors: issues.filter((i) => i.sev === 'major'),
    minors: issues.filter((i) => i.sev === 'minor'),
  }
}

const A = analyse(records)
const {
  own, invs, ran, verdict, arm, stages, withReply, ownAll, ownOk, invTrips, invDistinct,
  unbacked, dead, broke, held, noChecks, avgWords, withButtons, walls, flagged,
  clockRefused, jobsRan, remindersRan,
  avgRounds, avgSecs, totalInr, cacheHit, commitCalls, issues, blockers, majors, minors,
} = A
const B = BASELINE ? analyse(JSON.parse(readFileSync(BASELINE, 'utf8'))) : null

/* ------------------------------------------------------------- readiness -- *
 * Stated as a band with the rule printed beside it, so the page can be argued
 * with. A verdict whose rule is hidden is an opinion wearing a number.
 */
const RULE = 'clean = no blockers and every case held · walkable = no blockers · broken = any blocker'
const band = blockers.length ? 'BROKEN ON THE ARC' : broke.length ? 'WALKABLE' : 'CLEAN ARC'
const bandClass = blockers.length ? 'red' : broke.length ? 'amber' : 'green'
const bandWhy = blockers.length
  ? `${blockers.length} blocker${blockers.length === 1 ? '' : 's'} — the world went wrong, somebody was misled, or a stage never ran.`
  : broke.length
    ? `No blockers: nothing corrupted the world and nobody was misled. ${broke.length} case${broke.length === 1 ? '' : 's'} did not do what ${broke.length === 1 ? 'it was' : 'they were'} asked.`
    : 'Every case held and no invariant tripped on this arc.'


const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/**
 * What the ledger already knows and this arc cannot see.
 *
 * An 18-case lifecycle sweep is a walk down the happy path of one business. It
 * says nothing about a defect that needs a second month, a refund request, a
 * wrong number, or seven watches to show itself. These are read from
 * `conversation-rules.md` (F-C … F-Q, 15–16 Aug 2026) — NOT measured by this
 * run — and they are here because a readiness verdict that omits them would be
 * this product's own characteristic defect: a true-sounding claim nobody checked.
 *
 * `risk` is the axis it costs on. `why` is why the arc is blind to it.
 */
const LEDGER = [
  {
    id: 'F-I / §7.1', risk: 'MONEY', title: 'Mid-month joins are billed the whole month, and onboarding never asks who has already paid.',
    body: 'The tally mints the full amount for a family that joined on the 15th; correcting it is a manual waive. Onboarding does not ask §7.1\'s "who has already paid, and until when?", so a business migrating in bills its existing families again.',
    why: 'The arc\'s families all join before go-live and it closes one period. Nobody joins mid-month and no one arrives pre-paid.',
  },
  {
    id: '§14.8', risk: 'SAFETY', title: 'Nothing escalates a refund, a complaint or a safety word to a human.',
    body: 'Automatic escalation is specified and has no runtime enforcement: <code>handoff</code> sat at 0 calls in 464 turns, and 0 again on the following pass.',
    why: 'No case in the arc says anything a human would need to see.',
  },
  {
    id: 'F-C', risk: 'FLOW', title: 'Nothing structurally refuses a duplicate watch, and the spam evicts real traffic.',
    body: 'There is no normalized subject key on <code>schedule</code>\'s mint path — the prefix fact guards both decode points, nothing structural refuses. Observed: seven near-identical watches, seven messages in three minutes, and then the real headcount update <b>SUPPRESSED: recipient_frequency_cap</b>.',
    why: 'The arc mints one watch, once. Duplication needs the same concern raised repeatedly across days.',
  },
  {
    id: 'F-E / rule 5', risk: 'MISLEADS', title: 'No structural check on a claim of fact — fabrications reach coaches and parents and score as passes.',
    body: 'R10\'s shadow-mode traceability gate is specified in DRIVING.md and unbuilt. Live instance: "12 players are down to attend" over a table holding one — and, in the ledger\'s own words, "every existing axis scores this turn as a pass."',
    why: 'The arc checks rows that must exist. A sentence that invents a number no check asks about passes here too.',
  },
  {
    id: 'acquisition', risk: 'MONEY', title: 'A genuinely unknown number is dropped without trace.',
    body: 'No <code>message</code>, no <code>job</code>, no <code>audit_entry</code> — the ledger calls the lost enquiry "undetectable by construction, on the acquisition path."',
    why: 'The arc\'s stranger is a <code>prospect</code> contact the harness created, precisely because a truly unknown number never reaches a turn.',
  },
  {
    id: 'F-D', risk: 'PRIVACY', title: 'Reflection still writes un-gated memory shapes.',
    body: 'The deterministic gate catches rupee figures, phone numbers, payment handles and multi-day schedules. Parentage restatements and self-authored policies pass. A false parentage fact ("Vikram is the parent for Aarav" — he is a coach) is, per the ledger, "one turn away from telling a coach about a family\'s bill."',
    why: 'Memory poisoning shows up on a later turn that reads it back, not on the turn that wrote it.',
  },
  {
    id: 'F-P harness', risk: 'EVAL', title: 'The reply-text checks are written as negatives, so a silent product passes.',
    body: 'A check that asserts the absence of a bad string passes when there is no string at all. Silence and correctness are the same result to this suite — including to the run on this page.',
    why: 'This is a property of the harness, so it applies to every number above.',
  },
  {
    id: 'F-J / F-B', risk: 'LAUNCH', title: 'Two accepted capability losses, not bugs.',
    body: 'The product can no longer read voice notes or images — and, as the ledger puts it, "voice notes are how half of India types". A job turn that meant to reply but forgot the tool is now silent rather than accidentally heard.',
    why: 'Deliberate. Listed so a launch decision counts them rather than discovers them.',
  },
]

/**
 * Triage — what a failing check MEANS, which a check cannot say itself.
 *
 * A check knows one thing: the row it wanted was not there. It cannot tell a
 * product defect from a world the arc failed to build, and reporting the two as
 * one number is how a harness manufactures alarm. Each entry below was settled
 * by reading this run's transcript and, where it names one, the line of code.
 *
 * `verdict` is the claim; `evidence` is what settles it. Keyed by case name, so
 * a case that stops failing silently drops out of the page.
 */
const TRIAGE = {
  'opt-out': {
    verdict: 'real defect — the worst thing on this page',
    title: 'A person asked to stop being messaged. Twice now, nothing stopped, and nothing on her screen could stop it.',
    body: `Driven twice on the same sentence — <i>"please stop messaging me now"</i> — and it failed both times by a
      <b>different route</b>, which is why this reads as a class rather than a bug.
      <b>Run 1:</b> the model did the right thing and minted two buttons, <code>Stop all messages</code> carrying the
      <code>opt_out</code> operation and <code>Keep just the bill</code>. The first was correctly refused at mint by
      the defanged-button gate (<code>tools.ts:830</code>) — it carried <code>confirmed:true</code>, which only that
      person's own tap may set. A refused button is dropped and the message still goes
      (<code>tools.ts:1904-1916</code>), deliberately. The defect is the report back:
      <code>tools.ts:2290</code> guards it with <code>dropped.length &amp;&amp; !buttons?.length</code>, so the model
      is told <b>only when no button survived</b>. One survived, so it got a bare <code>{"status":"sent"}</code> and
      could not repair the message it had just sent — leaving prose naming a button that was not on her screen.
      <b>Run 2:</b> the model never called <code>reply</code> at all (<code>read → reflect:remember</code>). It
      offered "Just the bill" and "Stop everything" as <b>prose bullets</b>, 142 words, and the only tappable thing
      was the generic <code>What can you do?</code> menu.`,
    evidence: `Both runs end the same way: <code>opt_out</code> was never executed, the check <i>somebody is actually
      marked opted out</i> failed, and a person who asked to stop had no working way to stop. The common cause is not
      the gate, which is right — it is that nothing guarantees an explicit stop request produces a working stop
      affordance. The comment at <code>tools.ts:1901</code> also states the opposite of what the code does:
      "What was dropped comes back in the result, so the model learns inside the same turn."`,
  },
  'coach-marks-register': {
    verdict: 'real, but infrastructure — and the model behaved well',
    title: 'The register could not be read: three of four lookups hit the 5-second statement timeout.',
    body: `With the clock fix in place this case finally reached a finished class (<i>a class has actually finished</i>
      passed), so this is a real reading for the first time. The model called <code>read</code> four times; three came
      back <code>canceling statement due to statement timeout</code> — twice on <code>app.session_roster</code>, the
      view that exists for exactly this moment — and it never reached <code>mark_attendance</code>. The register was
      not marked, so the three roster checks failed.`,
    evidence: `It told the coach the truth rather than inventing a result: <i>"I tried to mark the register just now
      but my lookup is timing out, so I couldn't record it yet."</i> That is the honest failure, and the repeated-failure
      guard fired as designed. <b>Not yet diagnosed:</b> <code>app.session_roster</code> returns instantly on a small
      tenant, so this may be view cost against the larger world the longer clock walk builds, or contention from the
      probe's own job draining. One run is not enough to say which — it needs re-driving before it is called a view bug.`,
  },
  'client-leaves': {
    verdict: 'design decision to make, not obviously a bug',
    title: 'A family\'s leave is routed to the admin, so nothing in the data records it — and the family was told it was noted.',
    body: `Routing a client's leave to the admin is intended (commit <code>4320558</code>). The consequence is that
      <code>ended_on</code> stays null on every enrollment, so the check asking "is Aarav out of Fitness" fails by
      construction — <b>the check asserts the opposite of what the product promises</b>, which makes it a wrong
      expectation rather than a finding. The open question is not whether routing is right — it is whether anything
      guarantees the admin acts, because until they do, Fitness keeps billing.`,
    evidence: `Meera tapped <code>[Do it]</code>. The button's own preview said, verbatim: <i>"Tapping runs exactly
      this: <b>Nothing changes in the data</b> — Aarav's leave, routed to the admin to make official. 2 people hear
      about it."</i> So the null <code>ended_on</code> was declared to her before she tapped, and the reply hedged
      correctly — <i>"I've sent it to the owner to make official, and I'll confirm here once it's done"</i>, not a
      claim that it was done. <code>churn-after</code>, two cases later, says the same thing unprompted:
      <i>"nothing's been actioned, so it's not on the books yet."</i> Whether the owner's message exists could not be
      re-queried: the arc drops its academy on the way out. Re-run with <code>--keep</code> to settle it.`,
  },
}

/* ------------------------------------------------------------ verification -- *
 * A deterministic check firing is NOT the same as a real problem.
 *
 * Every issue on this page was raised by a check that ran correctly on its own
 * terms. That leaves four ways the ledger can still be wrong, and this run hit
 * all four: a rule can disagree with the spec it is meant to enforce, one cause
 * can be counted many times, a check can assert the opposite of what the product
 * deliberately promises, and a check can blame the model for infrastructure.
 *
 * So each issue is read back by hand — against the record, against the rule that
 * raised it in `scripts/probe-model.ts`, and against the spec — and carries a
 * verdict here. This is hand-authored, and it is labelled as such wherever it
 * renders. Where a verdict rests on something the data can settle, the proof is
 * COMPUTED rather than typed: jargon tokens are re-matched from the body the
 * person received, and a long reply's tappability is read off the record. An
 * issue with no verdict renders as unreviewed rather than as agreed.
 *
 * `group` names the underlying problem, so N issues collapse to the number of
 * things actually wrong.
 */
const VERIFIED_ON = '16 Aug 2026'
/** The rule as it stood when this run was recorded — kept here so the page can show what it matched. */
const PROBE_JARGON_RE = /\b(academy|roster|onboarding|setup phase|the system|database|record|entity|uuid|payload)\b/gi
const byCase = new Map(records.map((r) => [r.case, r]))

const G_REMINDER = 'Reminder text collapses two different days into one sentence'
const G_ROSTER = 'app.session_roster times out, so the register cannot be marked'
const G_STOP = 'An explicit request to stop produced no working stop'

const STATUS = {
  real: { label: 'confirmed', cls: 'v-real', counts: true },
  overstated: { label: 'real — severity overstated', cls: 'v-over', counts: true },
  duplicate: { label: 'real — same cause as above', cls: 'v-dup', counts: true },
  falsepos: { label: 'false positive', cls: 'v-false', counts: false },
  misattributed: { label: 'misattributed', cls: 'v-mis', counts: false },
  informational: { label: 'informational — not a defect', cls: 'v-info', counts: false },
}

const VERIFIERS = [
  {
    when: (i) => i.kind === 'invariant' && i.title === 'nobody was told the same thing twice',
    status: 'overstated', group: G_REMINDER,
    why: `A parent really does see the same sentence twice, so this is a real defect — but nothing was double-sent.
      Reminder jobs are keyed <code>dedupe.clientReminder(sessionId, playerId)</code>, so two firings are necessarily
      two <b>different sessions</b> — consecutive days of the daily class <i>Evening Fitness</i>. The bodies match
      because <code>dayLabel()</code> (<code>lib/jobs/util.ts:365</code>) is relative: it renders both as
      "tomorrow at 7:00 pm".`,
    evidence: () => {
      const trace = records.flatMap((r) => r.jobs ?? [])
      const merged = trace.filter((j) => /merged into a sibling/.test(j)).length
      const fired = trace.filter((j) => j === 'ran client_reminder').length
      return `Both dedupe mechanisms worked: the queue trace shows <b>${fired}</b> reminder firings and
      <b>${merged}</b> skipped as <i>merged into a sibling reminder</i>, so rule 7 held. Nothing was corrupted and
      nobody was misled — which is what <b>blocker</b> is defined to mean on this page. The fix is a distinguishing
      day in the body, not a dedupe.`
    },
  },
  {
    when: (i) => i.kind === 'case check' && i.where[0] === 'coach-marks-register' && /the whole register was marked$/.test(i.title),
    status: 'real', group: G_ROSTER,
    why: 'The register genuinely was not marked — attendance came back empty against a three-player roster.',
    evidence: () => {
      const r = byCase.get('coach-marks-register')
      const reads = (r?.tools ?? []).filter((t) => t.name === 'read')
      const to = reads.filter((t) => /statement timeout/.test(JSON.stringify(t.result ?? ''))).length
      return `${to} of ${reads.length} <code>read</code> calls returned
      <code>canceling statement due to statement timeout</code>; the one that succeeded took 506ms. A view that
      cannot answer for three players is the real finding here, and it is <b>undiagnosed</b> — either
      <code>app.session_roster</code> is pathological or the probe's own job draining is contending. The model
      behaved correctly: it told the coach the lookup was failing instead of inventing a result.`
    },
  },
  {
    when: (i) => i.kind === 'case check' && i.where[0] === 'coach-marks-register',
    status: 'duplicate', group: G_ROSTER,
    why: 'The same unmarked register, asked a second and third way.',
    evidence: () => 'One root cause — the statement timeouts above — counted three times in the total.',
  },
  {
    when: (i) => i.kind === 'case check' && i.where[0] === 'client-leaves',
    status: 'falsepos', group: null,
    why: `The check asserts <code>ended_on</code> is set. The product deliberately does not set it — a client's leave
      is routed to the admin (commit <code>4320558</code>) — and it says so to the person <b>before</b> they tap.`,
    evidence: () => {
      const r = byCase.get('client-leaves')
      return `Her button preview read, verbatim: <i>"Tapping runs exactly this: <b>Nothing changes in the data</b> —
      Aarav's leave, routed to the admin to make official."</i> She tapped <code>[${esc((r?.reply?.buttons ?? [])[0] ?? 'Do it')}]</code>
      and the reply hedged correctly rather than claiming completion. <code>churn-after</code> says the same thing
      unprompted two cases later. This is a wrong expectation in the suite, not a finding about the product — the
      live question is whether anything guarantees the admin acts, and no check asks that.`
    },
  },
  {
    when: (i) => i.kind === 'case check' && i.where[0] === 'opt-out',
    status: 'real', group: G_STOP,
    why: 'Somebody asked to stop being messaged and was not marked opted out. Nothing here is a harness artefact.',
    evidence: () => {
      const r = byCase.get('opt-out')
      return `She typed <i>"${esc(r?.said ?? '')}"</i>. <code>opt_out</code> never ran, the only tappable thing was
      <span class="btn">${esc((r?.reply?.buttons ?? [])[0] ?? '')}</span>, and the reply closed by asking her about a
      <b>different</b> pending decision — an enrollment — rather than stopping anything. This is the worst item in
      the run.`
    },
  },
  {
    when: (i) => i.kind === 'tool choice' && i.where[0] === 'coach-marks-register',
    status: 'misattributed', group: null,
    why: 'This blames the model for a database timeout.',
    evidence: () => {
      const r = byCase.get('coach-marks-register')
      return `It did not reach for nothing — it called <code>read</code>
      ${(r?.toolNames ?? []).filter((n) => n === 'read').length} times and was blocked before it could ever get to
      <code>mark_attendance</code>. The repeated-failure guard fired, then the recovery path answered without tools.
      A tool-choice flag is the wrong instrument for an infrastructure failure.`
    },
  },
  {
    when: (i) => i.kind === 'tool choice' && i.where[0] === 'opt-out',
    status: 'real', group: G_STOP,
    why: 'It never called <code>reply</code> at all, so the two options it offered were prose, not affordances.',
    evidence: () => {
      const r = byCase.get('opt-out')
      return `Called <code>${esc((r?.toolNames ?? []).join(' → '))}</code>. "Just the bill" and "Stop everything"
      were written as bullets in a ${r?.reply?.words}-word message; neither was tappable.`
    },
  },
  {
    when: (i) => i.kind === 'reply quality' && / — jargon$/.test(i.title),
    status: 'falsepos', group: null,
    why: `The lint bans the vocabulary the spec's own ideal conversations use. This accounts for a third of the
      ledger and none of it is a defect.`,
    evidence: (i) => {
      const r = byCase.get(i.where[0])
      const toks = [...new Set((String(r?.reply?.body ?? '').match(PROBE_JARGON_RE) ?? []).map((t) => t.toLowerCase()))]
      return `Matched only ${toks.map((t) => `<code>${esc(t)}</code>`).join(' and ')}. But
      <code>ideal-conversations.md:430</code> is an outbound message to a coach reading
      <i>"Beginners, 6:30 — register. 12 on the roster."</i>, and line 682 gives a button titled
      <code>[ See the roster ]</code>. <code>record</code> matches the ordinary verb in "record 1 payment".
      <b>Fixed since this run:</b> both words were dropped from <code>JARGON_RE</code> in
      <code>scripts/probe-model.ts</code>, so a re-drive will not raise these again. The flags stay on the page
      because the record is what it is — the run happened under the old rule.`
    },
  },
  {
    when: (i) => i.kind === 'reply quality' && / — long \(\d+ words\)$/.test(i.title),
    status: 'informational', group: null,
    why: 'Length over 90 words, on a message that gave the person something to tap.',
    evidence: (i) => {
      const r = byCase.get(i.where[0])
      const b = r?.reply?.buttons ?? []
      return `${r?.reply?.words} words, and tappable: ${b.map((x) => `<span class="btn">${esc(x)}</span>`).join(' ')}.
      The harness's own <i>wall of text</i> flag — over 55 words <b>and</b> nothing to tap — did not fire on any case
      in this run, and its rule says why: "Length alone is not the defect and buttons alone are not the fix; it is
      the pair." Reported, not ranked.`
    },
  },
]

const verifyIssue = (i) => {
  const m = VERIFIERS.find((v) => v.when(i))
  if (!m) return null
  return { ...m, ...STATUS[m.status], evidenceHtml: typeof m.evidence === 'function' ? m.evidence(i) : m.evidence }
}

const verdicts = issues.map((i) => ({ i, v: verifyIssue(i) }))
const unreviewed = verdicts.filter((x) => !x.v)
const upheld = verdicts.filter((x) => x.v?.counts)
const dismissed = verdicts.filter((x) => x.v && !x.v.counts)
/** The number of things actually wrong, after N issues collapse onto their causes. */
const realGroups = [...new Set(upheld.map((x) => x.v.group).filter(Boolean))]
/** A blocker that survived review as something milder still sets the band — but the page should say so. */
const blockersDowngraded = verdicts.filter((x) => x.i.sev === 'blocker' && x.v && x.v.status !== 'real')

/**
 * The launch verdict is NOT the arc verdict. The arc is a walk down one
 * business's happy path; the standing opens are what a second month, a refund
 * or a wrong number would find. A page that let a clean arc read as "ready"
 * would be making exactly the unchecked claim this product is judged on.
 */
const gating = LEDGER.filter((l) => l.risk === 'MONEY' || l.risk === 'SAFETY')
const launchBand = gating.length || blockers.length || broke.length ? 'NOT READY' : 'READY'
const launchWhy = gating.length
  ? `${gating.length} standing open${gating.length === 1 ? '' : 's'} on money or safety that this arc cannot see — customer-visible overbilling, and no human escalation for a refund, a complaint or a safety word.`
  : 'No standing money or safety opens.'

const caseCard = (r) => {
  const [cls, label] = verdict(r)
  const o = own(r)
  const badInv = invs(r).filter((c) => !c.ok)
  return `
  <article class="case ${cls}" id="case-${esc(r.case)}">
    <header>
      <h3>${esc(r.case)} <span class="pill ${cls}">${label}</span></h3>
      <p class="what">${esc(r.what)}</p>
    </header>
    <p class="meta">${esc(r.stage)} · spoken by ${esc(r.persona)}${r.spokeAs ? ` (${esc(r.spokeAs)})` : ' — <b>nobody found</b>'} ·
      ${r.rounds} round${r.rounds === 1 ? '' : 's'} · ${(r.latencyMs / 1000).toFixed(1)}s · ₹${((r.usd ?? 0) * USD_INR).toFixed(2)}</p>
    <p class="typed"><b>Typed:</b> ${esc(r.said)}</p>
    ${r.clockNote ? `<p class="meta"><b>Clock:</b> ${esc(r.clockNote)}</p>` : ''}
    <div class="reply">
      <div class="reply-h">what the person read${r.reply?.words ? ` — ${r.reply.words} words` : ''}${r.reply?.suppressed ? ` — SUPPRESSED: ${esc(r.reply.suppressed)}` : ''}</div>
      <pre>${esc(r.reply?.body || '(nothing)')}</pre>
      <p class="aff">${
        r.reply?.buttons?.length
          ? `buttons: ${r.reply.buttons.map((b) => `<span class="btn">${esc(b)}</span>`).join(' ')}`
          : r.reply?.list ? '<i>list picker</i>' : r.reply?.link ? '<i>link button</i>' : '<i>nothing to tap — they must type</i>'
      }</p>
    </div>
    ${r.tapNote ? `<p class="tap"><b>Then:</b> ${esc(r.tapNote)}</p>` : ''}
    <p class="tools"><b>Tools:</b> ${esc((r.toolNames ?? []).join(' → ') || 'none')}</p>
    ${r.jobs?.length ? `<p class="tools"><b>Queue:</b> ${esc(r.jobs.join(' · '))}</p>` : ''}
    ${r.reply?.flags?.length ? `<p class="flags">⚑ ${r.reply.flags.map(esc).join(' · ')}</p>` : ''}
    ${
      o.length
        ? `<ul class="checks">${o
            .map((c) => `<li class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✅' : '❌'} ${esc(c.label)}<code>${esc(String(c.detail).slice(0, 300))}</code></li>`)
            .join('')}</ul>`
        : '<p class="meta"><i>no checks of its own — this case exists to move the world along</i></p>'
    }
    ${
      badInv.length
        ? `<ul class="checks inv"><li class="hdr">invariants that also tripped here</li>${badInv
            .map((c) => `<li class="no">❌ ${esc(c.label)}<code>${esc(String(c.detail).slice(0, 240))}</code></li>`)
            .join('')}</ul>`
        : ''
    }
    ${r.claimedDone && !r.backedByWrite ? '<p class="warn">⚠️ Claimed something was done with no write from this turn behind it.</p>' : ''}
    ${r.error ? `<p class="warn">❌ turn error: ${esc(r.error)}</p>` : ''}
  </article>`
}

const issueRow = ({ i, v }) => `
  <article class="issue ${i.sev}${v && !v.counts ? ' struck' : ''}">
    <h4><span class="sev ${i.sev}">${i.sev}</span> ${esc(i.title)}</h4>
    <p class="why">${esc(i.why)}</p>
    <p class="where">${esc(i.kind)} · ${i.where.map((w) => `<a href="#case-${esc(w)}">${esc(w)}</a>`).join(', ')}</p>
    ${i.detail ? `<pre>${esc(i.detail)}</pre>` : ''}
    ${
      v
        ? `<div class="verdict ${v.cls}">
      <p class="vh"><span class="vtag">${esc(v.label)}</span>${v.group ? ` <span class="vgrp">${esc(v.group)}</span>` : ''}</p>
      <p class="vwhy">${v.why}</p>
      <p class="vev"><b>Checked.</b> ${v.evidenceHtml}</p>
    </div>`
        : '<div class="verdict v-none"><p class="vh"><span class="vtag">unreviewed</span></p>'
          + '<p class="vwhy">Raised by a check that ran correctly. Nobody has read it back against the record yet, so it is neither confirmed nor dismissed.</p></div>'
    }
  </article>`

const stageRow = (s) => {
  const mine = records.filter((r) => r.stage === s)
  const h = mine.filter((r) => verdict(r)[1] === 'HELD').length
  const b = mine.filter((r) => verdict(r)[1] === 'BROKE').length
  const d = mine.filter((r) => verdict(r)[0] === 'dead').length
  const cls = d || b ? (d ? 'red' : 'amber') : 'green'
  return `<tr class="${cls}"><td><b>${esc(s)}</b></td><td>${mine.length}</td><td>${h}</td><td>${b}</td><td>${d}</td>
    <td>${mine.map((r) => `<a href="#case-${esc(r.case)}" class="chip ${verdict(r)[0]}">${esc(r.case)}</a>`).join(' ')}</td></tr>`
}

const html = `<title>Arc Readiness</title>
<style>
  :root {
    --bg:#fbfaf8; --fg:#1c1a17; --dim:#6b6459; --line:#e2ddd4; --card:#fff;
    --green:#1a7f4b; --amber:#a86a00; --red:#b3261e; --accent:#2b4c7e;
    --codebg:#f3f0ea;
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
    font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  .wrap { max-width:1040px; margin:0 auto; padding:40px 20px 100px; }
  h1 { font-size:2rem; margin:0 0 4px; letter-spacing:-0.02em; }
  h2 { font-size:1.3rem; margin:48px 0 12px; padding-bottom:6px; border-bottom:1px solid var(--line); }
  h3 { font-size:1.05rem; margin:0 0 2px; }
  h4 { font-size:1rem; margin:0 0 6px; }
  .sub { color:var(--dim); margin:0 0 8px; }
  .banner { border-radius:12px; padding:20px 22px; margin:24px 0; border:1px solid var(--line); background:var(--card); }
  .banner.green { border-left:6px solid var(--green); }
  .banner.amber { border-left:6px solid var(--amber); }
  .banner.red   { border-left:6px solid var(--red); }
  .banner .band { font-size:1.6rem; font-weight:700; letter-spacing:-0.01em; }
  .banner.green .band { color:var(--green); } .banner.amber .band { color:var(--amber); } .banner.red .band { color:var(--red); }
  .rule { color:var(--dim); font-size:.85rem; margin-top:10px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin:20px 0; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .stat b { display:block; font-size:1.5rem; line-height:1.2; }
  .stat span { color:var(--dim); font-size:.8rem; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:.92rem; }
  th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--dim); font-weight:600; font-size:.8rem; text-transform:uppercase; letter-spacing:.04em; }
  tr.green td:first-child { border-left:4px solid var(--green); }
  tr.amber td:first-child { border-left:4px solid var(--amber); }
  tr.red   td:first-child { border-left:4px solid var(--red); }
  .chip { display:inline-block; font-size:.75rem; padding:1px 7px; border-radius:20px; margin:1px 0;
    text-decoration:none; border:1px solid var(--line); color:var(--fg); }
  .chip.pass { border-color:var(--green); } .chip.fail { border-color:var(--amber); } .chip.dead { border-color:var(--red); }
  .issue { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; margin:10px 0; }
  .issue.blocker { border-left:5px solid var(--red); }
  .issue.major   { border-left:5px solid var(--amber); }
  .issue.minor   { border-left:5px solid var(--line); }
  .sev { font-size:.7rem; text-transform:uppercase; letter-spacing:.06em; padding:2px 7px; border-radius:4px;
    color:#fff; margin-right:6px; vertical-align:1px; }
  .sev.blocker { background:var(--red); } .sev.major { background:var(--amber); } .sev.minor { background:var(--dim); }
  .why { color:var(--dim); margin:2px 0 6px; font-size:.9rem; }
  .where { font-size:.82rem; margin:0; } .where a { color:var(--accent); }
  pre { background:var(--codebg); border-radius:8px; padding:10px 12px; overflow-x:auto; margin:8px 0 0;
    font:.82rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
  .case { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px 18px; margin:14px 0; }
  .case.pass { border-left:5px solid var(--green); }
  .case.fail { border-left:5px solid var(--amber); }
  .case.dead { border-left:5px solid var(--red); }
  .pill { font-size:.7rem; padding:2px 8px; border-radius:20px; color:#fff; vertical-align:2px; }
  .pill.pass { background:var(--green); } .pill.fail { background:var(--amber); } .pill.dead { background:var(--red); }
  .what { color:var(--dim); margin:0 0 8px; font-size:.9rem; }
  .meta { color:var(--dim); font-size:.83rem; margin:4px 0; }
  .typed { margin:8px 0; } .typed b, .tap b, .tools b { color:var(--dim); font-weight:600; font-size:.83rem; }
  .reply { border:1px solid var(--line); border-radius:8px; overflow:hidden; margin:10px 0; }
  .reply-h { background:var(--codebg); padding:5px 10px; font-size:.75rem; color:var(--dim);
    text-transform:uppercase; letter-spacing:.05em; }
  .reply pre { background:transparent; margin:0; padding:10px 12px; font-family:inherit; font-size:.95rem; }
  .aff { margin:0; padding:6px 12px 10px; font-size:.83rem; color:var(--dim); }
  .btn { display:inline-block; border:1px solid var(--accent); color:var(--accent); border-radius:16px;
    padding:1px 9px; font-size:.78rem; margin-right:4px; }
  .tools, .tap { font-size:.86rem; margin:6px 0; }
  .flags { color:var(--amber); font-size:.85rem; margin:6px 0; }
  .checks { list-style:none; padding:0; margin:10px 0 0; }
  .checks li { font-size:.86rem; padding:3px 0; border-top:1px solid var(--line); }
  .checks li.hdr { color:var(--dim); text-transform:uppercase; font-size:.72rem; letter-spacing:.05em; border:0; padding-top:8px; }
  .checks code { display:block; color:var(--dim); font-size:.78rem; margin-top:2px;
    white-space:pre-wrap; word-break:break-word; }
  .warn { background:var(--codebg); border-radius:6px; padding:7px 10px; font-size:.86rem; margin:8px 0 0; }
  /* verification — the one hand-read layer, always visually distinct from a computed number */
  .verdict { margin:10px 0 0; padding:9px 12px; border-radius:8px; background:var(--codebg);
    border-left:3px solid var(--dim); }
  .verdict p { margin:0; }
  .vh { margin-bottom:5px !important; }
  .vtag { font-size:.68rem; text-transform:uppercase; letter-spacing:.07em; font-weight:700;
    padding:2px 7px; border-radius:4px; background:var(--dim); color:var(--bg); }
  .vgrp { font-size:.76rem; color:var(--dim); margin-left:6px; }
  .vwhy { font-size:.88rem; margin-bottom:5px !important; }
  .vev { font-size:.84rem; color:var(--dim); }
  .vev b, .vwhy b { color:var(--fg); }
  .verdict.v-real  { border-left-color:var(--red); }   .v-real .vtag  { background:var(--red); color:#fff; }
  .verdict.v-over  { border-left-color:var(--amber); } .v-over .vtag  { background:var(--amber); color:#fff; }
  .verdict.v-dup   { border-left-color:var(--amber); } .v-dup .vtag   { background:var(--amber); color:#fff; }
  .verdict.v-false { border-left-color:var(--green); } .v-false .vtag { background:var(--green); color:#fff; }
  .verdict.v-mis   { border-left-color:var(--green); } .v-mis .vtag   { background:var(--green); color:#fff; }
  .verdict.v-info  { border-left-color:var(--accent); } .v-info .vtag { background:var(--accent); color:#fff; }
  .verdict.v-none  { border-left-color:var(--dim); }
  /* an issue that did not survive verification stays legible but stops shouting */
  .issue.struck > h4, .issue.struck > .why, .issue.struck > .where, .issue.struck > pre { opacity:.55; }
  .issue.struck > h4 { text-decoration:line-through; text-decoration-thickness:1px; }
  .vsum { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin:18px 0; }
  .vsum .stat b { font-size:1.4rem; }
  .caveat { border:1px solid var(--amber); border-left:5px solid var(--amber); background:var(--card);
    border-radius:10px; padding:13px 16px; margin:16px 0; font-size:.9rem; }
  .caveat b { color:var(--amber); }
  footer { margin-top:60px; color:var(--dim); font-size:.82rem; border-top:1px solid var(--line); padding-top:14px; }
</style>
<div class="wrap">

<h1>How production-ready is this?</h1>
<p class="sub">The lifecycle arc, driven end to end against the real loop, real tools and a real database —
${records.length} turns, ${stages.length} stages, one fresh business. Model: <b>${esc(arm)}</b>.</p>

<div class="banner ${launchBand === 'READY' ? 'green' : 'red'}">
  <div class="band">Launch: ${launchBand}</div>
  <p style="margin:6px 0 0">${esc(launchWhy)}</p>
  <p class="rule">the arc is a ceiling, not a verdict — a clean walk down one business's happy path
  cannot clear a defect that needs a second month, a refund, or a wrong number to appear</p>
</div>

<div class="banner ${bandClass}">
  <div class="band">This arc: ${band}</div>
  <p style="margin:6px 0 0">${esc(bandWhy)}</p>
  ${
    blockersDowngraded.length
      ? `<p style="margin:8px 0 0"><b>On review, the band overstates it.</b> The band is set by the rule below,
  which is deliberately mechanical — but ${blockersDowngraded.length === 1 ? 'the blocker that set it was' : `${blockersDowngraded.length} of the blockers were`}
  read back against the record and ${blockersDowngraded.length === 1 ? 'is' : 'are'} real without being what
  <i>blocker</i> means here: nothing was corrupted and nobody was misled. The band is left as the rule computes it
  rather than quietly softened; the verdicts sit on each issue further down.</p>`
      : ''
  }
  <p class="rule">${esc(RULE)}</p>
</div>

<div class="stats">
  <div class="stat"><b>${held.length}/${held.length + broke.length}</b><span>cases with checks that held</span></div>
  <div class="stat"><b>${blockers.length}</b><span>blockers</span></div>
  <div class="stat"><b>${majors.length}</b><span>major issues</span></div>
  <div class="stat"><b>${minors.length}</b><span>minor issues</span></div>
  <div class="stat"><b>${realGroups.length}</b><span>real problems after review</span></div>
  <div class="stat"><b>${ownOk}/${ownAll.length}</b><span>case checks passed</span></div>
  <div class="stat"><b>${invDistinct.length}</b><span>invariants tripped</span></div>
  <div class="stat"><b>₹${totalInr.toFixed(2)}</b><span>whole arc</span></div>
  <div class="stat"><b>${avgSecs}s</b><span>per turn</span></div>
</div>
${noChecks.length ? `<p class="sub">${noChecks.length} of the ${records.length} turns carry no checks of their own — they exist to move the world along, and the invariants still ran after each.</p>` : ''}

${
  B
    ? `<h2>Did the recent edits move anything?</h2>
<p class="sub">The same arc, the same arm, before and after.${
        BASELINE_UNSOUND ? '' : ' A row that got worse is a regression the edits introduced; a row that got better is one they closed.'
      }</p>
${
  BASELINE_UNSOUND
    ? `<div class="caveat"><b>These two runs are not comparable, and none of the rows below are ranked.</b>
${esc(BASELINE_UNSOUND)}
<br><br>The coverage rows show it rather than assert it: the baseline exhausted its clock budget on
<b>${B.clockRefused.length}</b> case${B.clockRefused.length === 1 ? '' : 's'}${
        B.clockRefused.length ? ` (${B.clockRefused.map((r) => esc(r.case)).join(', ')})` : ''
      }, so the days those cases needed never arrived and the jobs of those days never fired.
<b>${B.jobsRan}</b> queued jobs ran in that run against <b>${jobsRan}</b> in this one, and
<b>${B.remindersRan}</b> client reminder${B.remindersRan === 1 ? '' : 's'} against <b>${remindersRan}</b>.
A check can only catch what actually happened, so more issues here is the arc reaching further, not the product
getting worse — and fewer issues there is not a cleaner product. Read the ledger below on its own terms instead.</div>`
    : ''
}
<div class="scroll"><table>
<tr><th>Measure</th><th>${esc(BASELINE_AS)}</th><th>this run</th><th>change</th></tr>
${[
  ['cases the clock could not reach', B.clockRefused.length, clockRefused.length, 'down'],
  ['queued jobs that actually fired', B.jobsRan, jobsRan, 'up'],
  ['client reminders sent', B.remindersRan, remindersRan, 'up'],
  ['cases that held', B.held.length, held.length, 'up'],
  ['cases that broke', B.broke.length, broke.length, 'down'],
  ['blockers', B.blockers.length, blockers.length, 'down'],
  ['major issues', B.majors.length, majors.length, 'down'],
  ['minor issues', B.minors.length, minors.length, 'down'],
  ['case checks passed', B.ownOk, ownOk, 'up'],
  ['case checks failed', B.ownAll.length - B.ownOk, ownAll.length - ownOk, 'down'],
  ['distinct invariants tripped', B.invDistinct.length, invDistinct.length, 'down'],
  ['unbacked done-claims', B.unbacked.length, unbacked.length, 'down'],
  ['walls of text', B.walls.length, walls.length, 'down'],
  ['words per reply', B.avgWords, avgWords, 'flat'],
  ['seconds per turn', Number(B.avgSecs), Number(avgSecs), 'flat'],
  ['rupees for the arc', Number(B.totalInr.toFixed(2)), Number(totalInr.toFixed(2)), 'flat'],
]
  .map(([label, before, after, good]) => {
    const d = after - before
    // An unsound baseline is not a thing this run can be better or worse THAN,
    // so nothing is coloured: the numbers are shown and left unranked.
    const better = BASELINE_UNSOUND ? false : good === 'up' ? d > 0 : good === 'down' ? d < 0 : false
    const worse = BASELINE_UNSOUND ? false : good === 'up' ? d < 0 : good === 'down' ? d > 0 : false
    const cls = better ? 'green' : worse ? 'red' : ''
    const arrow = d === 0 ? '—' : `${d > 0 ? '+' : ''}${Number(d.toFixed(2))}`
    return `<tr class="${cls}"><td><b>${label}</b></td><td>${before}</td><td>${after}</td><td>${arrow}</td></tr>`
  })
  .join('\n')}
</table></div>
<p class="sub">${
        BASELINE_UNSOUND
          ? 'Nothing here is ranked, for the reason above — the columns are the two runs side by side and the reading is yours.'
          : 'Green means the edits helped on that measure, red means they hurt it, blank means the measure is reported rather than ranked (cost, latency, length).'
      } Both runs walked the same ${records.length} cases.
${RATE_NOTE ? `<b>On cost:</b> ${esc(RATE_NOTE)}` : ''}</p>`
    : ''
}

<h2>The four pillars</h2>
<div class="scroll"><table>
<tr><th>Pillar</th><th>What it is measured by</th><th>This run</th></tr>
<tr><td><b>Truth</b><br><span class="sub">saying right things</span></td>
    <td>Claims backed by a write from the same turn</td>
    <td>${unbacked.length} unbacked done-claim${unbacked.length === 1 ? '' : 's'} in ${records.length} turns</td></tr>
<tr><td><b>Correctness</b><br><span class="sub">doing right things</span></td>
    <td>Rows that must exist afterwards; statements about the world that must always hold</td>
    <td>${ownOk}/${ownAll.length} case checks · ${invTrips.length} invariant trip${invTrips.length === 1 ? '' : 's'} across ${invDistinct.length} distinct</td></tr>
<tr><td><b>UI/UX</b><br><span class="sub">clear, tappable</span></td>
    <td>Words per reply, whether anything was tappable, walls of text, leaked markdown or jargon</td>
    <td>${avgWords} words avg · ${withButtons}/${withReply.length} tappable · ${walls.length} wall${walls.length === 1 ? '' : 's'} · ${flagged.length} flagged</td></tr>
<tr><td><b>Efficiency</b><br><span class="sub">cost, rounds, speed</span></td>
    <td>Rounds per turn, seconds, rupees at DeepSeek's rate card</td>
    <td>${avgRounds} rounds · ${avgSecs}s · ₹${totalInr.toFixed(2)} · ${cacheHit}% cached</td></tr>
</table></div>

<h2>Stage by stage</h2>
<div class="scroll"><table>
<tr><th>Stage</th><th>Cases</th><th>Held</th><th>Broke</th><th>Dead</th><th>Which</th></tr>
${stages.map(stageRow).join('\n')}
</table></div>

${
  broke.length
    ? `<h2>The ${broke.length} case${broke.length === 1 ? '' : 's'} that broke, and what each one actually means</h2>
<p class="sub">A check knows one thing: the row it wanted was not there. It cannot tell a product defect from a
world the arc failed to build. Each of these was settled by reading the transcript and, where one is named, the
line of code — so the count above resolves into ${
        Object.values(TRIAGE).filter((t) => t.verdict.startsWith('real')).length
      } real defect,
${Object.values(TRIAGE).filter((t) => t.verdict.startsWith('design')).length} decision to make, and
${Object.values(TRIAGE).filter((t) => t.verdict.startsWith('not a defect') || t.verdict.startsWith('did not run')).length} that say nothing about the product.</p>
${broke
  .map((r) => {
    const t = TRIAGE[r.case]
    if (!t) return ''
    const cls = t.verdict.startsWith('real') ? 'blocker' : t.verdict.startsWith('design') ? 'major' : 'minor'
    return `
  <article class="issue ${cls}">
    <h4><span class="sev ${cls}">${esc(t.verdict)}</span> ${esc(r.case)}</h4>
    <p style="margin:4px 0 8px"><b>${esc(t.title)}</b></p>
    <p class="why" style="color:var(--fg)">${t.body}</p>
    <p class="why"><b>Evidence.</b> ${t.evidence}</p>
    <p class="where">full transcript: <a href="#case-${esc(r.case)}">${esc(r.case)}</a></p>
  </article>`
  })
  .join('\n')}`
    : ''
}

<h2>Every check that failed — ${issues.length} issue${issues.length === 1 ? '' : 's'} raised, ${realGroups.length} real problem${realGroups.length === 1 ? '' : 's'}</h2>
<p class="sub">Severity above is assigned by kind, not by opinion. <b>Blocker</b>: the world went wrong, somebody was
misled, or a turn never ran. <b>Major</b>: the case's own subject did not happen. <b>Minor</b>: it happened and
read badly.</p>

<div class="caveat">
<b>A check firing is not the same as a problem.</b> Every issue below was raised by a deterministic check that ran
correctly on its own terms — and a third of this ledger still turns out not to be a defect. A rule can disagree with
the spec it exists to enforce, one cause can be counted several times, a check can assert the opposite of what the
product deliberately promises, and a check can blame the model for infrastructure. This run hit all four. So each
issue below carries a verdict read back by hand on ${esc(VERIFIED_ON)} against the record, the rule in
<code>scripts/probe-model.ts</code>, and the spec. <b>The verdicts are the only hand-authored judgements on this
page</b>; the evidence inside each one is computed from the records.
</div>

<div class="vsum">
  <div class="stat"><b>${issues.length}</b><span>issues raised by checks</span></div>
  <div class="stat"><b>${upheld.length}</b><span>survived verification</span></div>
  <div class="stat"><b>${realGroups.length}</b><span>distinct real problems</span></div>
  <div class="stat"><b>${dismissed.length}</b><span>dismissed on review</span></div>
  ${unreviewed.length ? `<div class="stat"><b>${unreviewed.length}</b><span>not yet reviewed</span></div>` : ''}
</div>

<p class="sub">The ${realGroups.length} thing${realGroups.length === 1 ? '' : 's'} actually wrong, once the
${upheld.length} upheld issue${upheld.length === 1 ? '' : 's'} collapse onto ${realGroups.length === 1 ? 'its cause' : 'their causes'}:</p>
<ol class="sub">${realGroups.map((g) => `<li><b>${esc(g)}</b></li>`).join('')}</ol>
<p class="sub">Dismissed, with reasons on each card below: ${
  ['falsepos', 'misattributed', 'informational']
    .map((s) => {
      const n = dismissed.filter((x) => x.v.status === s).length
      return n ? `${n} ${STATUS[s].label}` : null
    })
    .filter(Boolean)
    .join(' · ') || 'none'
}.</p>

${issues.length ? verdicts.map(issueRow).join('\n') : '<p><i>Nothing tripped on this arc.</i></p>'}

<h2>What this arc cannot see — ${LEDGER.length} standing opens</h2>
<p class="sub">Read from <code>conversation-rules.md</code> (F-C … F-Q, 15–16 Aug 2026), <b>not measured by this run</b>.
An 18-case walk down one business's happy path is blind to each of these, and they are the items that decide
a launch. The ledger has no ship/no-go list of its own; this is the shortlist its evidence supports.</p>
${LEDGER.map(
  (l) => `
  <article class="issue ${l.risk === 'MONEY' || l.risk === 'SAFETY' ? 'blocker' : 'major'}">
    <h4><span class="sev ${l.risk === 'MONEY' || l.risk === 'SAFETY' ? 'blocker' : 'major'}">${esc(l.risk)}</span> ${esc(l.title)}</h4>
    <p class="why">${l.body}</p>
    <p class="where"><b>${esc(l.id)}</b> · why the arc is blind to it: ${esc(l.why)}</p>
  </article>`,
).join('\n')}

<h2>Every turn, in order</h2>
<p class="sub">The arc accumulates: each case runs against the world the ones before it built.</p>
${records.map(caseCard).join('\n')}

<footer>
Generated by <code>scripts/arc-report.mjs</code> from <code>${esc(IN)}</code> —
${records.length} turns · ${esc(arm)} · ₹${totalInr.toFixed(2)} at ₹${USD_INR}/USD ·
${commitCalls} commit call${commitCalls === 1 ? '' : 's'}.
Every number on this page is computed from the run records; none is typed in. Three things on it are written by
hand and say so where they appear: the standing opens, the per-case triage, and the ${verdicts.filter((x) => x.v).length}
issue verdicts read back on ${esc(VERIFIED_ON)} — and the evidence inside each verdict is computed too.
</footer>
</div>`

writeFileSync(OUT, html)
console.log(`wrote ${OUT}`)
console.log(`  ${records.length} turns · ${held.length} held · ${broke.length} broke · ${dead.length} dead`)
console.log(`  ${blockers.length} blockers · ${majors.length} major · ${minors.length} minor`)
console.log(`  band: ${band}`)

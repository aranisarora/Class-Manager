/**
 * tennis-report — a month in a one-man tennis business, and whether the product
 * is fit to be handed to him.
 *
 *   node scripts/tennis-report.mjs [--in <records>.json] [--out <page>.html]
 *
 * WHY THIS IS NOT arc-report
 * -----------------------------------------------------------------------------
 * `arc-report.mjs` renders EVERY turn round by round, because the arc is 18
 * turns and the question it answers is "where, exactly, did this go wrong". This
 * drive is 35 turns across a simulated month, and printing all of them buries
 * the six that matter under twenty-nine that behaved. So the shape is different:
 *
 *   - every turn appears once, in a timeline, with its verdict and one line
 *   - a HAND-PICKED subset is opened up in full, round by round, because
 *     something happened in it — a fault, a near miss, or a moment the product
 *     did something better than it was specified to
 *   - the page ends where the reader started: is this ready, and for whom
 *
 * The picking is a judgement and is labelled as one. Everything counted is
 * computed from the records; everything argued is marked as read by hand.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const argv = process.argv.slice(2)
const flag = (n, d) => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return d
  const a = argv[i]
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? d)
}

const IN = flag('in', '.probe/runs/2026-08-17-0215-tennis-month/deepseek-v4-flash.json')
const OUT = flag('out', '.probe/reports/2026-08-17-tennis-month-readiness.html')
const TITLE = flag('title', 'One coach, one month')
const VERIFIED_ON = flag('verified-on', '17 Aug 2026')

const records = JSON.parse(readFileSync(IN, 'utf8'))
if (!records.length) {
  console.error(`no records in ${IN}`)
  process.exit(2)
}

const USD_INR = 88
const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/* -------------------------------------------------------------------------- *
 * Reading one turn — same anatomy as arc-report, because the records are the
 * same shape and the round is still the unit a turn goes wrong in.
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

function spokenOn(think) {
  if (!think) return null
  const a = parse(think.args)
  return typeof a === 'string' ? a : null
}

function readShape(act) {
  const args = parse(act.args) ?? {}
  const res = parse(act.result)
  const raw = String(act.result ?? '')
  const timedOut = /statement timeout/.test(raw)
  const ms = res?.ms ?? (raw.match(/"ms":(\d+)/) || [])[1]
  const rowCount = res?.rowCount ?? (Array.isArray(res?.rows) ? res.rows.length : null)
  return {
    query: args.query ?? null, purpose: args.purpose ?? null, timedOut,
    error: act.error ?? res?.error ?? null, ms: ms ? Number(ms) : null,
    rowCount, rows: res?.rows ?? null, repeatedFailure: res?.repeatedFailure ?? null,
  }
}

const refusals = (r) =>
  (r.tools ?? []).filter((t) => !isThought(t)).map((t) => ({ act: t, shape: readShape(t) }))
    .filter((x) => x.shape.timedOut || x.shape.error)

/* -------------------------------------------------------------------------- *
 * Mechanical verdicts.
 *
 * A check that runs after more than half the turns is one of the always-rules
 * (§ the invariants block in probe-model.ts) rather than a question this turn
 * asked, and mixing the two makes every turn look like it was testing the same
 * thing. Split, exactly as arc-report splits them.
 * -------------------------------------------------------------------------- */
const labelCounts = new Map()
for (const r of records) for (const c of r.checks ?? []) labelCounts.set(c.label, (labelCounts.get(c.label) ?? 0) + 1)
const ALWAYS = new Set([...labelCounts.entries()].filter(([, n]) => n > records.length / 2).map(([l]) => l))

/** Checks whose detail is the evidence itself and whose `ok` is always true. */
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

const arm = `${records[0].model}${records[0].thinking && records[0].thinking !== 'default' ? ` · thinking=${records[0].thinking}` : ''}`
const stages = [...new Set(records.map((r) => r.stage))]
const withReply = records.filter((r) => r.reply?.body)
const ranTurns = records.filter(ran)
const ownAll = records.flatMap(own)
const ownOk = ownAll.filter((c) => c.ok).length
const broke = records.filter((r) => verdict(r)[1] === 'WENT WRONG')
const held = records.filter((r) => verdict(r)[1] === 'WENT RIGHT')
const noChecks = records.filter((r) => verdict(r)[1] === 'NOTHING TO CHECK')
const unbacked = records.filter((r) => r.claimedDone && !r.backedByWrite)
const clockRefused = records.filter((r) => String(r.clockNote ?? '').startsWith('REFUSED'))
const alwaysTrips = [...new Set(records.flatMap((r) => always(r).filter((c) => !c.ok).map((c) => c.label)))]
const allJobs = records.flatMap((r) => r.jobs ?? [])
const jobsRan = allJobs.filter((j) => j.startsWith('ran ')).length
const jobsFailed = allJobs.filter((j) => j.startsWith('FAIL')).length
const avgWords = withReply.length ? Math.round(sum(withReply, (r) => r.reply.words) / withReply.length) : 0
const avgSecs = ranTurns.length ? (sum(ranTurns, (r) => r.latencyMs) / ranTurns.length / 1000).toFixed(1) : '0'
const totalInr = sum(records, (r) => (r.usd ?? 0) * USD_INR)
const dbCalls = records.flatMap((r) => (r.tools ?? []).filter((t) => t.name === 'read')).length
const dbRefused = records.flatMap(refusals).filter((x) => x.act.name === 'read').length
const writeRefused = records.flatMap(refusals).filter((x) => x.act.name !== 'read').length
const tappable = withReply.filter((r) => r.reply.buttons.length || r.reply.list || r.reply.link).length

/** How far the world's clock actually travelled, read out of the clock notes. */
const hoursWalked = sum(records, (r) => {
  const m = String(r.clockNote ?? '').match(/^([\d.]+)h in/)
  return m ? Number(m[1]) : 0
})

/* ========================================================================== *
 * HAND-READ. Everything below this line is a judgement, made on
 * VERIFIED_ON, against the full round-by-round transcript in the records.
 * ========================================================================== */

/**
 * The readiness verdict, area by area.
 *
 * `state` is one of ready · risky · blocking, and the bar is deliberately
 * "would I let a real coach with real clients run his month on this".
 */
const READINESS = [
  {
    area: 'Getting the business in',
    state: 'ready',
    note: `Three venues, four classes across three sites, two weekday-morning slots each, an AM/PM trap in both
      directions ("6–7am" and "5–6pm"), a group class at a different rate, five players and six enrolments —
      including an adult who is her own account holder — in <b>four messages</b>, with 20 of 20 structural checks
      passing. Nobody was messaged before go-live. This part is genuinely good and it is the part most products
      get wrong.`,
  },
  {
    area: 'The calendar',
    state: 'blocking',
    note: `Nothing in the product knows a coach cannot be in two places at once. Asked to add a Monday 7am private
      at the Gymkhana while the same coach already had a Monday 7am private at Lake Club, it created it without
      one lookup, auto-committed on the grounds that it "touched nobody else", and described the result as done.
      For a solo operator every class shares one coach, so <b>every overlap is a real double-booking</b> — see
      finding 2.`,
  },
  {
    area: 'Makeups and reschedules',
    state: 'blocking',
    note: `This is the whole business — a private cancelled the night before is not a refund argument, it is a slot
      move (§9.2). A parent cannot do it: RLS gives an account holder no update on <code>session</code>, and the
      named operation reports that refusal as <i>"the world moved under this plan"</i>, so the model retried the
      identical call before giving up. It recovered well — routed to Ravi with a one-tap button, scheduled its own
      chase, told Meena the truth — but <b>in the whole month not one makeup was actually booked.</b>`,
  },
  {
    area: 'Per-session billing',
    state: 'blocking',
    note: `A month of coaching produced <b>one billed session</b>. Money is written when a register is marked; the
      register was marked once, by hand, because I typed a no-show at it. The safety net that exists for exactly
      this — the chaser that says the register is still unmarked — is <i>deliberately suppressed for a solo
      operator</i>, and there is no second coach to route it to. Closing balance: ₹900 billed, netted to −₹900 by
      two adjustments, against ₹2,700 collected with no bill behind it. Finding 1.`,
  },
  {
    area: 'Honesty about its own state',
    state: 'blocking',
    note: `Twice, a fortnight apart, it told the admin his message delivery was broken. It was not. The product
      records a <i>deliberate non-send</i> as <code>status='failed'</code>, so the gates doing their job look
      identical to a gateway refusing traffic. It read the column, believed it, and escalated. Finding 1.`,
  },
  {
    area: 'Consent and opt-out',
    state: 'blocking',
    note: `"Please stop messaging me about money" produced a warm, correct-sounding reply and
      <code>opted_out_at</code> was left <b>null</b>. The promise lives in a memory fact and in the model's good
      intentions. The one always-rule that would catch a breach keys on the column that was never set, so a leak
      would be invisible to the harness as well as to the user. Finding 4.`,
  },
  {
    area: 'Money conversations',
    state: 'ready',
    note: `Rail 1 held exactly as specified: a parent saying "sent you 2,700, ref 447129903" produced no confirmed
      payment and a routed request to the admin; the admin's "it's in the account" produced a confirmed row with
      <code>confirmed_at</code> and <code>confirmed_by</code>. The statement to Farida was correct to the rupee,
      named no other family, and explained a credit balance in three lines. Unprompted, at month close, it flagged
      that Meena's ₹2,700 had no bill behind it.`,
  },
  {
    area: 'Handling people who behave badly',
    state: 'ready',
    note: `Nobody who should not have been served was served. A stranger who asked the price and vanished got one
      message and was never chased. A stranger who booked got a trial with the right free-first-class treatment,
      and when told he had no-showed for it, the bot checked and said the session had not happened yet rather than
      marking it. A broken wrist became a pause with the slot held, not an ended enrolment, and generated no bill.`,
  },
  {
    area: 'Undoing a mistake',
    state: 'risky',
    note: `Asked to put Kabir's Friday back after cancelling the week, it noticed something better than it was
      asked — <i>three</i> of the seven were at the indoor venue, not one — and said so. Then it stopped at a
      Yes/No with no staged plan behind either, so nothing was restored and the three families who had been told
      their sessions were off were never told they were back on. A better observation than the admin's, delivered
      as a question that changed nothing.`,
  },
  {
    area: 'Authority boundaries',
    state: 'risky',
    note: `In the fee dispute a parent's word alone removed a weekly slot from a class and cancelled three future
      sessions, and <b>the admin was never told</b>. She was almost certainly right — but "almost certainly right"
      is the state every disputed charge is in, and the class definition is not the client's to change.`,
  },
  {
    area: 'Tone and length',
    state: 'risky',
    note: `12 of 35 replies flagged long, four as walls of text, the longest <b>235 words</b> to a parent in the
      middle of a billing dispute. Plan-builder internals reached the admin verbatim three times —
      <i>"3 steps matched no rows and change nothing — check that part landed."</i> Against that: 31 of 35 replies
      gave something to tap, and the median reply is 70 words.`,
  },
  {
    area: 'Cost and speed',
    state: 'ready',
    note: `<b>₹10.91</b> for 35 driven turns — ₹0.31 a turn — plus the month's scheduled work. 45.7s a turn is slow
      for a chat but invisible against WhatsApp's own latency for anything that is not a live back-and-forth. Cost
      is not what stands between this and production.`,
  },
]

/**
 * The turns worth opening up. Keyed by case name; anything not in here appears
 * in the timeline and nowhere else.
 *
 * `blame`: model · blocked · suite · good
 */
const HIGHLIGHTS = {
  'tn-two-places': {
    blame: 'model',
    title: 'Told to put a second client on Monday 7am, it booked the coach into two venues at once and called it done.',
    body: `Sneha's private is Monday and Wednesday, 7–8am, at Lake Club, with Ravi coaching. Ravi says
      <i>"i've told tara i can do anika mondays 7 to 8 at the gymkhana, one to one. set that up"</i>. The bot ran two
      reads — Anika's player id, and the venue list — then built the class and the enrolment and replied
      <i>"Anika's Monday one-to-one is set up — 7–8am at the Gymkhana, you coaching, starting next Mon 24 Aug…
      Tara will start getting the Monday reminder ahead of each session."</i>
      <br><br>Ravi is now expected at Lake Club and at the Gymkhana at the same hour every Monday, and two families
      will be reminded of it. Nothing in the reply, the reasoning, or the queries mentions Sneha.`,
    exact: `<b>Round 2, the <code>plan</code> call.</b> It never asked what else runs on Monday. The two reads it
      did make were both id lookups; there is no query in this turn against <code>class_slot</code>, and the
      overlap is one join away. The plan tool then auto-committed with
      <i>"This is done — it touched nobody else, no money and nothing destructive, so it ran."</i> That judgement is
      about <i>rows</i>, and the damage here is not in a row — it is in the relationship between two rows that were
      never compared. <b>Note on the check:</b> my own test passed this turn, on a false positive — it looked for the
      clash being named and matched the word "both" in <i>"she now has both"</i>, which is about Anika's two
      classes. The check was wrong; the turn was worse.`,
  },
  'tn-makeup-book': {
    blame: 'blocked',
    title: 'A parent tried to book her own makeup. The database said no, the operation said "the world moved", and the model retried the identical call.',
    body: `Meena has already said Aditya has an exam. She names a slot: <i>"friday 6am at fort court would work for us
      if you have it free"</i>. The bot found the session, found the venue, and called
      <code>reschedule_session</code> — which came back
      <code>PRECONDITION_FAILED: a step needed 1 row(s) and matched 0 — the world moved under this plan</code>.
      That sentence is false. The world did not move; Meena is an account holder and RLS gives her no update on
      <code>session</code>. Reading it literally, the model re-read the row, saw it sitting there unchanged, and
      called the same operation again with the same arguments.
      <br><br>Only on the third attempt — a raw <code>plan</code> write — did it get the true answer:
      <i>"those rows DO exist — 1 of them — and this person is not allowed to change them. The database refused
      silently rather than raising."</i>`,
    exact: `<b>Rounds 3 and 5.</b> Two different layers describe the same refusal, and only one of them is right.
      The diff engine on the raw-SQL path distinguishes <i>no such row</i> from <i>row exists, you may not touch
      it</i>; the named-operation path collapses both into "the world moved under this plan", which reads as a
      race and invites exactly the retry it got. The loop's own repeated-failure guard is what stopped it —
      <i>"reschedule_session has now been refused 2 times this turn for the same reason. Editing the arguments is
      not what is wrong."</i>
      <br><br>What it did next was good, and worth separating from the fault: it routed to Ravi with a one-tap
      <span class="btn">Move it</span>, scheduled its own 48-hour chase, and told Meena plainly that the session was
      still on Tuesday. The one thing it should not have said is what it did say — <i>"The system won't let me… it's
      something only Ravi can do from his side"</i> puts the product's plumbing in a parent's chat.`,
  },
  'tn-silence-audit': {
    blame: 'model',
    title: 'It told the admin his delivery was broken. Those 21 "failures" were the product\'s own gates working correctly.',
    body: `Three days in, nobody has replied to anything. Asked about it, the bot ran four honest queries and
      produced a genuinely impressive-looking diagnosis: <i>"45 messages went out this week. 21 failed outright —
      never reached anyone… Even your own messages are dropping: 20 of your 34 failed, so you're not reliably
      getting your own day briefs and register prompts either… This is worth treating as a real problem rather than
      waiting it out."</i>
      <br><br>Every one of those 21 rows is a message the product <b>chose not to send</b>. Ravi is the coach as
      well as the admin, so the T-60 "coming?" prompt, the T-30 nudge and the uncovered-session escalation are all
      addressed to the person they are about — and gates 2 and 3 in <code>send.ts</code> suppress them, which is
      §18 working exactly as designed. The suppression path writes <code>status='failed'</code> with
      <code>failed_reason</code> null and the real reason in a different column, <code>suppressed_reason</code>,
      which none of the four queries touched.`,
    exact: `<b>Rounds 1–4, all four reads.</b> Not one selects <code>suppressed_reason</code>; the word does not
      appear anywhere in the turn. The second half of the diagnosis is a second error stacked on the first: <i>"none
      show as delivered or read… the reminders are going to the gateway and mostly stalling before they land"</i> —
      inferring non-delivery from the absence of a receipt, which §2.4 says is no information. And the specific
      claim that briefs and digests are not landing is checkably wrong: the digests in that same window are
      <code>sent</code>. This is not a model that hallucinated. It is a model that read the column the schema told
      it to read and believed it — which is why the fix belongs in the schema.`,
  },
  'tn-dispute': {
    blame: 'model',
    title: "On a parent's word alone it dropped a weekly slot, cancelled three future sessions, and never told the owner.",
    body: `Farida asks why she has been charged ₹900 when she told Ravi at the court that Kabir has stopped
      Mondays — the out-of-band cancellation, which the domain facts name as the commonest true dispute. The reply
      is careful about the money and correct about it: the ₹900 is Friday's absence, not Monday's; a charge with no
      cancellation on record stands; her balance is ₹900 in credit.
      <br><br>Then, in the same turn: <i>"I've taken the Monday slot off Kabir's schedule — no more Mondays going
      forward. The upcoming Monday sessions (24 Aug, 31 Aug, 7 Sep) are cancelled."</i> A weekly slot is part of the
      class definition, three future sessions were cancelled, and <b>Ravi heard nothing about any of it.</b> The
      turn ends by asking Farida to confirm the change it had already made.`,
    exact: `<b>The order of operations.</b> Acting first and asking afterwards inverts §4.1's read-back rule, and
      the thing acted on is not hers to change. She is very probably right — she almost always is, which is exactly
      why the domain facts flag this case — but "probably right" is the state of every disputed charge, and the
      product's answer to it is supposed to be a route to the person who can say yes. My check for that
      (<i>the admin was brought in</i>) came back with an empty admin-message list.
      <br><br>Also on the page for a different reason: at <b>235 words</b> with nothing to tap, this is the longest
      message anyone received all month, sent to a person who was already annoyed.`,
  },
  'tn-optout': {
    blame: 'model',
    title: '"Stop messaging me about money" was answered perfectly and recorded nowhere.',
    body: `Tara, three weeks behind and chased into silence, writes <i>"please stop messaging me about money. i will
      pay when i pay."</i> The reply is close to ideal and does the one thing doctrine 13 asks for — it says what
      will <i>stop</i>: <i>"I'll leave the money side alone. I won't send you any more payment messages or
      reminders. You'll still hear about Anika's sessions, and that's it."</i> That is a good scope, offered
      without being asked for.
      <br><br>Behind it: one <code>remember</code> call. <code>contact.opted_out_at</code> is still null. No
      <code>opt_out</code> operation, no scheduled stop, nothing the dunning job will ever consult.`,
    exact: `<b>Round 1.</b> The turn spent its one tool call on <code>remember</code>. A memory fact shapes what the
      model writes on a future turn it happens to be present for; it does nothing at all to a
      <code>payment_due</code> job composing at 9am from a query. The product has the right primitive —
      <code>opt_out</code> is a named operation with its own double-confirmation — and the model did not reach for
      it, because a partial stop ("just the money") does not map onto it.
      <br><br>That gap is worth naming precisely, because it is a design hole rather than a slip: the schema has one
      switch and Tara asked for half of one. The always-rule that guards this — <i>nobody was messaged after they
      opted out</i> — passed every turn afterwards, and passed <b>because the column it reads was never set.</b>`,
  },
  'tn-rain-partial-undo': {
    blame: 'model',
    title: 'It caught something the admin had missed, then asked a question with nothing behind either answer.',
    body: `Ravi has just cancelled the whole week for flooding. He corrects himself: <i>"the gymkhana is indoors.
      kabir's friday is still on. put that one back."</i> The bot goes one better than the instruction —
      <i>"it's not just Kabir: three of the seven were at the Gymkhana — Kabir Fri 11 Sep, Anika Mon 7 Sep,
      Saturday Juniors Sat 12 Sep. Only the Lake Club and Fort Court ones should have been off."</i> It also names
      the consequence correctly and unprompted: <i>"The families have already been told they're off, so restoring
      means a short 'back on' message to each."</i>
      <br><br>That is §7.2's undo rule, derived rather than recited. Then it ends on
      <span class="btn">Yes</span> <span class="btn">No</span> — two reply buttons with no staged plan behind
      either. Nothing was restored. Four days later, at 3am, it was still saying so: <i>"The three Gymkhana ones I
      flagged are still showing cancelled too — want me to put them back on before the week starts?"</i>`,
    exact: `<b>Round 2 — it stopped at a question.</b> The observation deserved a plan; a three-session restore with
      three correction messages is precisely the shape <code>plan</code> exists to preview. Instead the choice was
      offered as prose-derived buttons, which carry no action, so there was nothing for a thumb to execute. The
      cost is not one wasted turn: three families spent the following week believing sessions were cancelled that
      the bot had already worked out were not.`,
  },
  'tn-injury-pause': {
    blame: 'good',
    title: 'A six-week injury is a concept the schema has no noun for. It got it right anyway.',
    body: `<i>"aditya fractured his wrist at school. hes out for at least six weeks. we do want his slot back after
      though."</i> There is no pause in the data model: ending the enrolment loses the slot, and leaving it alone
      bills a per-session absence twice a week for six weeks. The bot picked neither. It read both of Aditya's
      enrolments, framed the answer as a hold rather than an ending — <i>"I'll pause both his classes… and hold his
      slots for when he's ready. Nothing gets billed while he's out, and the reminders stop, so you won't get
      nudged every session"</i> — routed the change to Ravi rather than executing it, and scheduled its own
      follow-up.`,
    exact: `<b>Every clause in that sentence answers a question Meena did not ask but would have.</b> Will we be
      charged. Will you keep pestering us. Will we lose the slot. Doctrine 13 — say what will <i>stop</i> — applied
      to a case nothing prescribes. The player stayed active, no bill was generated, and the tap read
      <i>"Nothing changes in the data — Aditya's leave, routed to the admin to make official."</i> Shown here
      because it is the clearest evidence in the month that the derivation-from-doctrine approach earns its keep
      when the situation is one nobody wrote down.`,
  },
  'tn-month-close': {
    blame: 'good',
    title: 'Asked what it took this month, it volunteered the thing that was actually wrong with the books.',
    body: `The honest answer was embarrassing and it gave it: <i>"₹2,700 — one payment, from Meena Iyer's account.
      That's everything that actually landed… The only session that ever earned a line was Kabir's 21 Aug (₹900),
      and that got offset by two adjustments. Net for August is −₹900."</i>
      <br><br>Then, unasked: <i>"Meena Iyer paid ₹2,700 with no bill behind it. No tally line attaches to it, so
      she's ₹2,700 ahead of the ledger. Could be a pre-payment or something paid outside the system — worth knowing
      what it was for before it sits there."</i> And it named its own root cause: <i>"The reason the month is so
      thin is the same thread as the unmarked registers… The money picture can't fill in until attendance does."</i>`,
    exact: `<b>Round 4, after four reads.</b> Every figure here matches the ledger query the harness ran
      independently on the same instant — 1 completed session, 10 cancelled, −₹900 billed, ₹2,700 collected. It did
      not round, did not smooth, and did not lead with the collected figure, which is the flattering one. It is
      also the fourth separate turn in which it raised the unmarked registers without being asked. The product
      diagnosed its own worst failure repeatedly and correctly, all month, to an admin who never acted on it —
      which is finding 1 seen from the other side.`,
  },
  'tn-final-audit': {
    blame: 'suite',
    title: 'The bot said 32 messages, my check counted 98. The bot was right — and the check surfaced two things it was not looking for.',
    body: `Asked how many messages had gone to clients "this month", it answered for September, which is the month
      the domain clock was in: 32, zero failures. My ledger check counted every outbound to a non-admin across the
      whole drive — mid-August to mid-September — and got 98. Both numbers are correct about different windows;
      the check was the sloppy one, and the reply named its window in the query it ran.
      <br><br>Two real things fell out of it anyway. Its per-family breakdown is honest and specific, and it again
      surfaced the 19 suppressed-as-failed rows on Ravi's own number — repeating September's version of the
      August misdiagnosis a fortnight later, which is what makes finding 1 a pattern rather than a slip.`,
    exact: `<b>On the 2am sends.</b> My quiet-hours check also failed here, and three of its six hits are real:
      reminder templates to Sneha, Farida and Meena at <b>02:02</b>. The other three are solicited replies to
      people who wrote in at that hour, which is correct behaviour. The three real ones fired because go-live
      happened at 2am and the reminder backlog became due the instant the switch flipped. There is no quiet-hours
      floor on a proactive send anywhere in the product — the drive found it by accident, and a coach who finishes
      setup late at night will find it the same way.`,
  },
  'tn-noshow': {
    blame: 'suite',
    title: "The harness pressed [Kabir told me] and then asserted he was marked absent. It pressed the button that changed the answer.",
    body: `The model did this turn right: it read the roster, called <code>mark_attendance</code>, marked Kabir
      absent, and said the honest thing about the money — <i>"Kabir's down as absent with no cancellation on
      record. It's his free first class, so nothing hits their bill either way — the hour's just lost."</i>
      <br><br>Then the harness's thumb landed on the follow-up button the product correctly offered —
      <span class="btn">Kabir told me</span>, which retroactively converts an absence into a timely cancellation —
      and my check, running afterwards, asserted <code>status = 'absent'</code> and found
      <code>cancelled_timely</code>. This exact trap is documented in <code>probe-model.ts</code>; I wrote the case
      without the <code>expectBeforeTap</code> that exists to avoid it.`,
    exact: `<b>Not a round — my mistake.</b> Worth keeping on the page for what it shows either side of the error.
      The follow-up button is a good one: it is the highest-value catch-point for the out-of-band cancellation, and
      it appeared unprompted. And the tap receipt is where the plumbing leaks — <i>"Changed 1 attendance mark and
      added 1 credit — Kabir, today — 0 in, 0 out. 2 steps matched no rows and change nothing — check that part
      landed."</i> That sentence went to the person paying for the product.`,
  },
  'tn-rain-off': {
    blame: 'good',
    title: 'Seven cancellations, seven families, one preview that says the cost before the tap.',
    body: `<i>"courts are underwater, whole week is off"</i> is the fan-out case, and it behaved. Nothing was
      cancelled and nobody was messaged before the tap. The preview named every session by player, day and time,
      answered the money question before being asked — <i>"Nothing's billed for these, so no one's bill changes"</i>
      — and stated the blast radius as a count of people, not rows: <i>"7 people hear about it."</i> On the tap,
      seven cancellations and seven individually-addressed messages went out.`,
    exact: `<b>Doctrine 14, applied without being prompted.</b> "The cost goes before the tap, never after" is the
      hardest of the added doctrines to get right because there is always a reason to leave it out, and per-session
      billing is where getting it wrong turns into a dispute. <b>Note on the check:</b> my pre-tap assertion failed
      here and should not have — it counted <i>every</i> cancelled session in the business, and three of Kabir's
      Mondays had been cancelled a fortnight earlier in the dispute. Nothing was cancelled by this turn before its
      tap. The check was wrong; the turn was clean.`,
  },
}

/** Faults in the product that no single turn owns. `sev`: blocking · serious · minor */
const FINDINGS = [
  {
    sev: 'blocking',
    tag: 'every solo operator · every per-session business',
    title: 'A month of coaching, one billed session — because the register nudge is switched off for exactly the person who needs it.',
    body: `Per-session billing writes money when a register is marked (§6.4). Over the simulated month Baseline
      Tennis ran roughly twenty-one sessions and marked <b>one</b> register — and that one only because the drive
      made Ravi type a no-show at it. Closing position: ₹900 ever billed, netted to −₹900 by two adjustments,
      against ₹2,700 collected with nothing behind it.
      <br><br>The safety net for this exists. <code>register_expiry</code> fires two hours after every session that
      has no attendance and tells the admin. Its own comment explains why it does not fire here:
      <i>"it carries the coach as its subject so the send path can refuse to escalate about someone to themselves
      (§18 rule 2) — which is how the solo admin never gets told off for their own unmarked register."</i>
      <br><br>That reasoning is right for a multi-coach academy and inverted for this one. An unmarked register is
      not a telling-off; on per-session rates <b>it is the invoice.</b> The rule that stops a manager nagging you
      about yourself also stops it telling you that you have not billed anyone in three weeks, and for a solo
      operator there is no second coach to route it to.`,
    proof: `The ledger query the harness ran at month close, independently of the model:
      <code>{completed: 1, cancelled: 10, billed: −900, collected: 2700}</code>. The model reached the same figures
      from its own reads and raised the unmarked registers unprompted on four separate turns
      (<code>tn-noshow</code>, <code>tn-who-owes</code>, <code>tn-chased-into-silence</code>,
      <code>tn-3am</code>, <code>tn-month-close</code>) — <i>"Clear the backlog of unmarked registers and her lines
      (and Aditya's, Sneha's, Kabir's) all appear."</i> The suppression mechanism is
      <code>lib/messaging/send.ts</code> gate 3 (<code>aboutRecipient && msg.isEscalation</code>) against
      <code>lib/jobs/handlers/sessions.ts:315</code>.`,
  },
  {
    sev: 'blocking',
    tag: 'anyone who reads the message table — including the bot',
    title: '"We decided not to send this" and "the network refused this" are the same value in the same column.',
    body: `<code>suppress()</code> writes <code>status = 'failed'</code>, leaves <code>failed_reason</code> null and
      puts the real reason in <code>suppressed_reason</code>. Every other failure writes
      <code>status = 'failed'</code> with a reason. So the single column that anybody — a dashboard, an operator, or
      the model — reads to answer <i>"is my messaging working"</i> cannot distinguish the product working perfectly
      from the gateway being down.
      <br><br>It cost exactly what you would expect. On day three the bot told Ravi
      <i>"21 failed outright — never reached anyone… This is worth treating as a real problem"</i>, and offered to
      investigate his phone number. A fortnight later it repeated the September version. Both diagnoses were of the
      §18 gates suppressing self-directed coach prompts for a solo operator — the product's most carefully-designed
      behaviour, reported to its owner as an outage.`,
    proof: `19 of the 51 messages addressed to Ravi's number in September carry <code>status='failed'</code> with
      <code>failed_reason</code> null — the signature of <code>suppress()</code>, the only writer of that
      combination (<code>lib/messaging/send.ts:457</code>). Four reads in <code>tn-silence-audit</code> and three in
      <code>tn-final-audit</code>, none of which selects <code>suppressed_reason</code>; the string does not appear
      in either turn. The suppressed messages are <code>CO-COMING</code> and <code>CO-NUDGE</code>
      (<code>isConfirmationRequest</code>, subject = the coach) and <code>AD-REGISTER-MISSING</code> /
      <code>admin_escalate_uncovered</code> (<code>isEscalation</code>, subject = the coach) — all correct
      suppressions for a person who is both hats.`,
  },
  {
    sev: 'blocking',
    tag: 'every solo coach, every week',
    title: 'Nothing in the product knows a coach cannot be in two places at once.',
    body: `<code>create_class</code> takes a weekday, a start time, a venue and a coach set, and never asks whether
      that coach already has something at that hour. For a multi-coach academy the omission is survivable — the
      admin assigns different people. For a solo operator every class has the same coach by definition, so
      <b>every time overlap is a physical impossibility</b>, and this business has three venues to be impossible
      across.
      <br><br>Driven: Anika's Monday 7–8am at the Gymkhana was created over Sneha's Monday 7–8am at Lake Club
      without a single lookup, auto-committed as "nothing destructive", and confirmed to the admin in the past
      tense. Both families will now be reminded of a session the coach cannot attend.`,
    proof: `<code>tn-two-places</code>: two reads (a player id, a venue id), then one <code>plan</code> carrying
      <code>create_class</code> with <code>slots:[{weekday:1, start_time:"07:00"}]</code>. No query against
      <code>class_slot</code> anywhere in the turn. The plan tool's own commit note —
      <i>"it touched nobody else, no money and nothing destructive, so it ran"</i> — is a judgement about affected
      rows, and a double-booking is not visible in a row count. The overlap predicate already exists in this
      harness's own check query and is one self-join.`,
  },
  {
    sev: 'blocking',
    tag: 'anyone who asks to be left alone',
    title: 'A stop request became a memory fact. The column that enforces it was never set.',
    body: `Invariant §11.2 calls opting out the one promise that cannot be half-kept. Tara's
      <i>"please stop messaging me about money"</i> produced a warm reply promising exactly that and one
      <code>remember</code> call. <code>contact.opted_out_at</code> stayed null.
      <br><br>A memory fact steers a model on a turn it is present for. It does not reach a
      <code>payment_due</code> job composing from a query at 9am. And the always-rule that guards this — <i>nobody
      was messaged after they opted out</i> — reads <code>opted_out_at</code>, so it passed every subsequent turn
      <b>because the column was never set</b>. A breach here is invisible to the product and to the test.
      <br><br>Underneath the slip is a design hole: the <code>opt_out</code> operation is all-or-nothing and Tara
      asked for half — stop the money messages, keep the session ones. That is the commonest form of the request
      and there is nowhere to put it.`,
    proof: `<code>tn-optout</code>, one round, tools <code>remember, reply</code>. The check queried
      <code>contact.opted_out_at</code> for Tara and <code>job</code> for any <code>agent_task</code> minted that
      turn: <code>{out:[{at:null, full_name:"Tara Nambiar"}], sched:[]}</code>. Note also that the run was torn
      down without <code>--keep</code>, so whether anything money-shaped actually reached her afterwards cannot now
      be checked — which is itself the point: nothing recorded the promise, so nothing could have enforced it.`,
  },
  {
    sev: 'serious',
    tag: 'every client-initiated change',
    title: 'A permission refusal is reported to the model as a concurrency conflict, and it retries.',
    body: `When an operation's step matches no rows because RLS silently dropped the write, the named-operation path
      returns <code>PRECONDITION_FAILED: a step needed 1 row(s) and matched 0 — the world moved under this plan</code>.
      "The world moved" describes a race, and the correct response to a race is to re-read and try again — which is
      what the model did, with byte-identical arguments.
      <br><br>The product already knows how to say this properly. On the raw-SQL path the diff engine answers
      <i>"those rows DO exist — 1 of them — and this person is not allowed to change them. The database refused
      silently rather than raising. This is not something to retry or reword."</i> Two layers, one truth, and the
      layer the model reaches for first has the wrong one.`,
    proof: `<code>tn-makeup-book</code>, rounds 3–6: <code>reschedule_session</code> refused twice with the
      concurrency wording, a re-read in between confirming the row was present and unchanged, then a raw
      <code>plan</code> returning the accurate <code>CHANGED_NOTHING</code> diagnosis. The turn was only stopped
      from looping by the loop's own guard — <i>"reschedule_session has now been refused 2 times this turn for the
      same reason."</i> Two model rounds and about twenty seconds of a waiting parent, per occurrence.`,
  },
  {
    sev: 'serious',
    tag: 'every forward-dated instruction',
    title: 'A button was minted carrying a plan the product cannot execute, and nobody found out until the thumb landed.',
    body: `Invariant 2 is <i>mint once, replay verbatim</i> — "a button's action is authored at compose time,
      <b>validated</b>, stored." Asked to raise private rates from 1 October, the model composed a correct answer,
      correctly refused to touch September, and minted <span class="btn">Yes, set it</span> carrying a
      <code>steps</code> action whose one step was a <code>schedule</code> of kind
      <code>"private-rate-1000"</code> — a job kind that does not exist.
      <br><br>The tap came back: <i>"That didn't go through — something about it doesn't line up on my side. Nothing
      was changed."</i> Honest about the outcome and useless about the cause. The admin has been told his prices go
      up on 1 October. They do not.
      <br><br>This is the more dangerous half of the mint-and-replay design, not an argument against it. Minting is
      the moment validation is affordable and the tap is the moment it is too late — a rejection at compose time is
      one more round; a rejection at tap time is a promise already made.`,
    proof: `<code>tn-price-raise</code>: the <code>reply</code> call's button payload is
      <code>{"kind":"steps","steps":[{"schedule":{"kind":"private-rate-1000","run_at":"2026-10-01T00:00:00+05:30",…</code>,
      accepted and stored (<code>{"status":"sent"}</code>). The tap returned the generic failure with no reason
      surfaced. Two reads earlier in the same turn are correct and thorough — it identified all four ₹900 classes
      and checked their October sessions — so the fault is entirely in what was allowed into the action row.`,
  },
  {
    sev: 'serious',
    tag: 'every solo business, at setup',
    title: 'Whether a solo operator is detected as solo depends on which tool the model happens to reach for.',
    body: `<code>app.is_solo()</code> requires a coach row with <code>status = 'active'</code>.
      <code>add_coach</code> creates one at <code>'added'</code>, and only <code>onboard_coach</code> promotes it —
      which happens when a coach taps <i>[Looks right]</i> on an invite. A solo operator has nobody to invite
      himself from, so the honest path leaves him permanently not-solo, with all eight §18 behaviours off.
      <br><br>Driven twice on the same sentence, this run and the onboarding smoke that preceded it. The full run
      wrote the coach row through a raw <code>plan</code> that set the status directly, and solo came on. The smoke
      run reached for the named operation <code>add_coach</code>, and it did not:
      <code>[{"solo": false}]</code>. Same words from the admin, two businesses in different modes, and nothing
      anywhere tells him which one he is in.`,
    proof: `<code>supabase/migrations/0004_functions.sql:102</code> —
      <code>count(*) from coach where status='active') = 1 and exists (… join academy_admin …)</code>.
      <code>add_coach</code> (<code>lib/agent/operations.ts:3056</code>) inserts with the default
      <code>'added'</code>; <code>'active'</code> is written in one place only,
      <code>onboard_coach</code> (<code>:3388</code>). Smoke run
      <code>tn-solo-coach</code>, tools <code>read, add_coach, remember</code>, check
      <i>the business reads as solo</i> failed with <code>[{"solo":false}]</code>; this run, tools
      <code>plan</code>, same check passed, and the job log then shows
      <code>skip coach_day — solo — the day rides in the morning brief (§18)</code> on every subsequent day.`,
  },
  {
    sev: 'serious',
    tag: 'every recipient outside the 24-hour window',
    title: 'Out-of-window notifications are all the same sentence, so a family cannot tell which session changed.',
    body: `Meta rejects templates whose body is substantially one variable, so the approved wording is generic:
      <i>"Message from Baseline Tennis about a change to a session."</i> Send it four times in a fortnight to a
      parent with two children in two classes and they have four identical notifications and no idea what
      changed — and no reason to open the fourth.
      <br><br>The product's own always-rule caught this and named it correctly on 24 of 35 turns, which is the rule
      doing its job. It is the one always-rule this drive tripped that is a real product fault rather than an
      artifact.`,
    proof: `The <i>nobody was told the same thing twice</i> invariant, tripping from <code>tn-noshow</code> onward
      and never clearing: at its worst, one contact holding four rows of
      <code>"Message from Baseline Tennis about a change to a session."</code> and another holding three of
      <code>"…about an upcoming session."</code> These are template sends, so the differentiating detail is in
      parameters the notification body cannot carry. Compare the in-window versions, which are specific to the
      session — <i>"Baseline Tennis: Aditya Tue 8 Sep 6am is cancelled — Courts underwater — week off."</i>`,
  },
  {
    sev: 'serious',
    tag: 'any class whose slots are edited',
    title: 'Dropping a weekly slot leaves the class starting on a day it no longer runs.',
    body: `Kabir's class ran Monday and Friday, starting Monday 17 Aug. The dispute removed Mondays. The class now
      has one slot — Friday — and <code>starts_on</code> still points at a Monday. Nothing in the slot-removal path
      moves it forward to the first surviving weekday.
      <br><br>Harmless today because session materialisation drives off the slots. Not harmless the moment anything
      reads <code>starts_on</code> to answer "when did this start" or to rebuild a calendar — and it is the exact
      class of defect the F6 invariant was written for, which is why it was caught.`,
    proof: `<i>every class starts on one of its own weekdays</i> tripped on 22 consecutive turns from
      <code>tn-admin-waives</code> to the end of the run, with the same row every time:
      <code>{name:"Kabir", starts_on:"2026-08-17", start_dow:1, slot_days:[5]}</code>.`,
  },
  {
    sev: 'minor',
    tag: 'three operations, seen by the admin',
    title: 'Plan-builder internals reached the owner verbatim, inside the confirmation he was asked to tap.',
    body: `<i>"Changed 3 sessions and removed 1 weekly slot… 3 steps matched no rows and change nothing — check that
      part landed."</i> That sentence is a message from the plan builder to whoever wrote the plan, and it was
      shown to a tennis coach as part of the receipt for an action he had just authorised. It also asks him to
      verify something he has no way to verify.`,
    proof: `Reached the user in three turns — <code>tn-noshow</code>, <code>tn-admin-waives</code> and
      <code>tn-rain-off</code>, the last of them inside the pre-tap preview for cancelling a week. Separately worth
      noting that steps matching no rows is itself common enough to be worth chasing: five of the twelve steps in
      the rain cancellation matched nothing.`,
  },
  {
    sev: 'minor',
    tag: 'anyone who goes live outside office hours',
    title: 'There is no quiet-hours floor on a proactive send.',
    body: `Ravi finished setup and flipped the switch at two in the morning. The reminder backlog became due at that
      instant, and three families got a template at <b>02:02</b>. Nothing in the send path holds a proactive message
      until a civil hour; the reminder lead time is measured backwards from the session and lands wherever it lands.`,
    proof: `The final audit's quiet-hours check: six outbound rows to non-admins between 22:00 and 06:00 IST. Three
      are solicited replies to people who wrote in at that hour and are correct. Three are
      <code>session_reminder</code> templates to Sneha, Farida and Meena at 02:02 on 17 Aug, minutes after go-live.`,
  },
  {
    sev: 'minor',
    tag: 'the reading experience',
    title: 'It is still too long when it is worried, and the longest message of the month went to the angriest person.',
    body: `Median reply 70 words, which is right. But 12 of 35 were flagged long, four were walls of text with
      nothing to tap, and the maximum — 235 words — went to Farida in the middle of a billing dispute, structured
      with five bolded section headings. Doctrine 12 says length is earned by news, by a decision, or by something
      going wrong; a dispute qualifies on all three, and 235 words still is not the answer.`,
    proof: `Reply flags across the run: 12 <code>long</code>, 4 <code>wall of text</code>, 4 <code>jargon</code>.
      Longest: <code>tn-dispute</code> at 235 words, then <code>tn-silence-audit</code> at 207 and
      <code>tn-month-close</code> at 179, both to the admin. Against that, 31 of 35 replies offered something to
      tap, which is the metric that matters more.`,
  },
]

/** One line per turn for the timeline, where the check labels do not say enough. */
const NOTES = {
  'tn-hello': 'Routed the form-shaped part to the setup Flow, as specified. No venue rows yet, and it did not claim any.',
  'tn-solo-coach': 'One person, two hats, no duplicate, and solo came on — by the route that happens to work.',
  'tn-timetable': '20/20. Four classes, three venues, both AM/PM traps survived, per-session on all four.',
  'tn-families': 'Five players, six enrolments, the self-paying adult modelled correctly at n=1. Nobody messaged.',
  'tn-golive': 'Noticed it was already live and asked only for the UPI handle it was actually missing.',
  'tn-parent-arrives': 'Resolved to the existing Meena. Taught the free-text surface at the moment it saves work.',
  'tn-adult-arrives': 'No child was invented for her, and it volunteered the cancellation window unasked.',
  'tn-late-conflict': 'Nine words and two buttons — but answered a reschedule request with a confirm/cancel prompt.',
  'tn-makeup-book': 'RLS blocked the parent; the operation called it a race and it retried. Routed well afterwards.',
  'tn-two-places': 'Created a Monday 7am clash with an existing Monday 7am. My check passed on a false positive.',
  'tn-silence-audit': 'Diagnosed the product\'s own suppressions as a broken gateway.',
  'tn-noshow': 'Marked correctly; the harness then tapped the button that changed the answer.',
  'tn-dispute': 'Changed the class on a client\'s word and never told the owner. 235 words.',
  'tn-admin-waives': 'Refused to double-credit a waiver it had already applied — right answer, failed my check.',
  'tn-stranger-asks': 'Adult prospect, honest about what the board actually advertises. Nobody signed up.',
  'tn-stranger-price': 'Every price named exists in the rate table.',
  'tn-stranger-books': 'Corrected the slot he asked for, then booked the free trial on a tap.',
  'tn-stranger-vanishes': 'Answered once. Never chased again all month — checked at the end: exactly one message.',
  'tn-referral': 'Mid-cycle family added, not back-billed, and it flagged the out-of-window template downgrade itself.',
  'tn-trial-noshow': 'Refused to mark a no-show for a session that had not happened yet.',
  'tn-parent-claims-paid': 'Rail 1 held — no confirmed payment on the payer\'s word.',
  'tn-admin-confirms-pay': 'Confirmed with when and by whom, and told the payer.',
  'tn-who-owes': 'Correct, and it explained why the answer was empty rather than reporting a clean sheet.',
  'tn-chased-into-silence': 'Tara messaged 13 times in the month; no duplicate chase, and it explained the ₹0.',
  'tn-optout': 'Perfect reply, opted_out_at null.',
  'tn-rain-off': 'Clean fan-out preview with the money answer before the tap. My pre-tap check was wrong.',
  'tn-rain-partial-undo': 'Spotted three over-cancelled sessions, then asked a question with no plan behind it.',
  'tn-rain-billing-check': 'Correct: no cancelled session carried a charge.',
  'tn-injury-pause': 'A pause, held slots, no bill, routed for sign-off.',
  'tn-price-raise': 'Forward-dated correctly, nothing retro-applied — then the tap threw and changed nothing.',
  'tn-refund-ask': 'Did not invent a negative payment. Offered to hand it over, but the hand-over never left.',
  'tn-3am': 'Answered the admin at 3am and woke nobody else. Still flagging the over-cancelled Gymkhana sessions.',
  'tn-month-close': 'Honest, exact, and volunteered the ₹2,700 with no bill behind it.',
  'tn-parent-statement': 'Correct to the rupee, no other family named.',
  'tn-final-audit': 'Right about September; my check counted the whole drive. Surfaced the 2am sends.',
}

const blameLabel = {
  model: { text: 'the bot got this wrong', cls: 'b-model' },
  blocked: { text: 'not the bot — it was blocked', cls: 'b-blocked' },
  suite: { text: 'not the bot — the test is wrong', cls: 'b-suite' },
  good: { text: 'worth showing because it went right', cls: 'b-good' },
}
const sevLabel = { blocking: 'blocks go-live', serious: 'ships, but it will hurt', minor: 'worth fixing' }
const stateLabel = { ready: 'ready', risky: 'risky', blocking: 'not ready' }

/* -------------------------------------------------------------------------- *
 * Rendering.
 * -------------------------------------------------------------------------- */
const sqlBlock = (q) => `<pre class="sql">${esc(q)}</pre>`

function roundCard(rd) {
  const spoke = spokenOn(rd.think)
  const parts = []
  if (rd.think?.reasoning) {
    parts.push(`<div class="beat think"><div class="beat-h">what it was thinking</div><p>${esc(rd.think.reasoning)}</p></div>`)
  }
  if (rd.think?.drafted) {
    parts.push(`<div class="beat draft"><div class="beat-h">what it wrote before acting</div><p>${esc(rd.think.drafted)}</p></div>`)
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
        ${s.rows && s.rows.length ? `<details><summary>the rows it got</summary><pre>${esc(JSON.stringify(s.rows, null, 1).slice(0, 4000))}</pre></details>` : ''}
        ${s.repeatedFailure ? `<p class="nudge"><b>The loop then warned it:</b> ${esc(s.repeatedFailure)}</p>` : ''}
      </div>`)
    } else {
      const res = parse(act.result)
      const ok = res?.ok !== false && !act.error
      parts.push(`<div class="beat did${ok ? '' : ' bad'}">
        <div class="beat-h">what it did — <code>${esc(act.name)}</code></div>
        <details><summary>arguments and result</summary>
          <pre>${esc(String(act.args).slice(0, 6000))}</pre><pre>${esc(String(act.result).slice(0, 6000))}</pre></details>
        ${act.error ? `<p class="got"><b class="no">it failed:</b> ${esc(act.error)}</p>` : ''}
      </div>`)
    }
  }
  if (spoke) parts.push(`<div class="beat say"><div class="beat-h">it stopped here and spoke</div><p>${esc(spoke)}</p></div>`)
  if (rd.recovery) {
    parts.push(`<div class="beat recover"><div class="beat-h">the loop's last resort</div>
      <p>${esc(rd.recovery.name)} — ${esc(rd.recovery.result)}</p></div>`)
  }
  return parts.length ? `<section class="round"><h4>Round ${rd.n}</h4>${parts.join('')}</section>` : ''
}

function turnCard(r) {
  const [cls, label] = verdict(r)
  const o = own(r)
  const led = ledger(r)
  const badAlways = always(r).filter((c) => !c.ok)
  const rds = buildRounds(r)
  const hi = HIGHLIGHTS[r.case]
  const cardCls = hi?.blame === 'good' && cls === 'pass' ? 'pass' : cls

  return `
  <article class="case ${cardCls}" id="case-${esc(r.case)}">
    <header>
      <h3>${esc(r.case)} <span class="pill ${cardCls}">${label}</span></h3>
      <p class="what">${esc(r.what)}</p>
      <p class="meta">${esc(r.stage)} · ${esc(r.persona)}${r.spokeAs ? ` (${esc(r.spokeAs)})` : ' — <b>nobody found</b>'} ·
        ${r.rounds} round${r.rounds === 1 ? '' : 's'} · ${(r.latencyMs / 1000).toFixed(1)}s · ₹${((r.usd ?? 0) * USD_INR).toFixed(2)}</p>
    </header>

    <div class="typed"><div class="beat-h">what they typed</div><p>${esc(r.said)}</p></div>
    ${r.clockNote ? `<p class="meta"><b>The clock was moved first:</b> ${esc(r.clockNote)}</p>` : ''}

    ${
      hi
        ? `<div class="wrong ${blameLabel[hi.blame].cls}">
      <p class="wtag">${esc(blameLabel[hi.blame].text)}</p>
      <p class="wtitle">${hi.title}</p>
      <p class="wbody">${hi.body}</p>
      ${hi.exact ? `<p class="wexact"><b>${hi.blame === 'good' ? 'The exact right move' : 'The exact wrong move'}:</b> ${hi.exact}</p>` : ''}
    </div>`
        : ''
    }

    <details class="anatomy" ${cls === 'fail' || hi ? 'open' : ''}>
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
    </div>
    ${r.tapNote ? `<p class="tap"><b>Then they tapped:</b> ${esc(r.tapNote)}</p>` : ''}
    ${r.jobs?.length ? `<p class="tools"><b>Scheduled work that fired around this turn:</b> ${esc(r.jobs.join(' · '))}</p>` : ''}

    ${
      o.length
        ? `<ul class="checks">${o
            .map((c) => `<li class="${c.ok ? 'ok' : 'no'}">${c.ok ? '✅' : '❌'} ${esc(c.label)}<code>${esc(String(c.detail).slice(0, 700))}</code></li>`)
            .join('')}</ul>`
        : '<p class="meta"><i>nothing of its own to check — this turn exists to move the month along</i></p>'
    }
    ${
      led.length
        ? `<ul class="checks"><li class="hdr">what the ledger actually said at this point</li>${led
            .map((c) => `<li><code>${esc(String(c.detail).slice(0, 900))}</code></li>`).join('')}</ul>`
        : ''
    }
    ${
      badAlways.length
        ? `<ul class="checks"><li class="hdr">rules that must hold after every turn, and did not</li>${badAlways
            .map((c) => `<li class="no">❌ ${esc(c.label)}<code>${esc(String(c.detail).slice(0, 500))}</code></li>`).join('')}</ul>`
        : ''
    }
    ${r.claimedDone && !r.backedByWrite ? '<p class="warn">⚠️ It spoke as if something was done, and nothing was written.</p>' : ''}
    ${r.error ? `<p class="warn">❌ the turn threw: ${esc(r.error)}</p>` : ''}
  </article>`
}

/** One row in the month timeline. */
function timelineRow(r) {
  const [cls, label] = verdict(r)
  const o = own(r)
  const failed = o.filter((c) => !c.ok).map((c) => c.label)
  const hi = HIGHLIGHTS[r.case]
  const note = NOTES[r.case] ?? (failed.length ? failed.join('; ') : '')
  return `<tr class="tl-${cls}">
    <td>${hi ? `<a href="#case-${esc(r.case)}"><b>${esc(r.case)}</b></a>` : `<span class="dim">${esc(r.case)}</span>`}</td>
    <td>${esc(r.persona)}${r.spokeAs && r.persona !== 'admin' ? ` <span class="dim">${esc(r.spokeAs.split(' ')[0])}</span>` : ''}</td>
    <td class="q">${esc(String(r.said).slice(0, 110))}${String(r.said).length > 110 ? '…' : ''}</td>
    <td><span class="pill ${cls}">${label === 'NOTHING TO CHECK' ? 'no checks' : label === 'WENT RIGHT' ? 'held' : label === 'WENT WRONG' ? 'broke' : 'dead'}</span></td>
    <td class="q">${esc(note)}</td>
  </tr>`
}

const highlighted = records.filter((r) => HIGHLIGHTS[r.case])
const byBlame = (b) => highlighted.filter((r) => HIGHLIGHTS[r.case].blame === b)

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
  .dim { color:var(--dim); }
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
  pre.sql { background:var(--codebg); border-left:3px solid var(--accent); }
  .case { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px 20px; margin:18px 0; }
  .case.pass { border-left:5px solid var(--green); }
  .case.fail { border-left:5px solid var(--red); }
  .case.dead { border-left:5px solid var(--amber); }
  .pill { font-size:.68rem; padding:2px 9px; border-radius:20px; color:#fff; vertical-align:2px;
    text-transform:uppercase; letter-spacing:.05em; white-space:nowrap; }
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
  .wrong.b-suite   { background:color-mix(in srgb, var(--accent) 8%, var(--card)); border-left:5px solid var(--accent); }
  .wrong.b-good    { background:color-mix(in srgb, var(--green) 8%, var(--card)); border-left:5px solid var(--green); }
  .wtag { margin:0 0 6px; font-size:.7rem; text-transform:uppercase; letter-spacing:.08em; font-weight:800; }
  .b-model .wtag { color:var(--red); } .b-blocked .wtag { color:var(--amber); }
  .b-suite .wtag { color:var(--accent); } .b-good .wtag { color:var(--green); }
  .wtitle { margin:0 0 8px; font-weight:700; font-size:1.02rem; }
  .wbody, .wexact { margin:0 0 8px; font-size:.92rem; }
  .wexact { padding:8px 11px; background:var(--codebg); border-radius:7px; }
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
  .finding.serious { border-left-color:var(--amber); }
  .finding.minor { border-left-color:var(--dim); }
  .ftag { margin:0 0 6px; font-size:.68rem; text-transform:uppercase; letter-spacing:.09em;
    font-weight:800; color:var(--red); }
  .finding.serious .ftag { color:var(--amber); } .finding.minor .ftag { color:var(--dim); }
  .ftitle { margin:0 0 9px; font-weight:700; font-size:1.05rem; }
  .fbody { margin:0 0 9px; font-size:.94rem; }
  .fproof { margin:0; font-size:.87rem; color:var(--dim); background:var(--codebg);
    border-radius:7px; padding:9px 12px; }
  .fproof b { color:var(--fg); }
  .rd { display:inline-block; min-width:74px; text-align:center; border-radius:20px; padding:1px 10px;
    font-size:.7rem; font-weight:800; text-transform:uppercase; letter-spacing:.05em; color:#fff; }
  .rd.ready { background:var(--green); } .rd.risky { background:var(--amber); } .rd.blocking { background:var(--red); }
  footer { margin-top:64px; color:var(--dim); font-size:.82rem; border-top:1px solid var(--line); padding-top:14px; }
</style>
<div class="wrap">

<h1>${esc(TITLE)}</h1>
<p class="sub">A solo tennis coach — admin and coach in one person — billed per session, mostly one-to-one, across
three venues, driven for a simulated month against the real loop, the real tools and a real database.
${records.length} turns, ${Math.round(hoursWalked / 24)} days of clock, ${jobsRan} pieces of scheduled work fired
into the gaps. Model: <b>${esc(arm)}</b>.</p>

<div class="lead">
<p style="margin:0 0 8px"><b>Nobody in this drive is trying to break anything.</b> A parent cancels the evening
before an exam. A client stops replying. A stranger asks the price and is never heard from again. Someone books a
trial and does not turn up. A family stops paying and then asks to be left alone. The courts flood. That is not an
adversarial test — it is a Tuesday, and it is the load the product will actually meet.</p>
<p style="margin:0">This page shows <b>every turn once</b>, in the timeline, and <b>opens up the ones that are worth
reading</b> — round by round, with what the bot was thinking, what it asked the database, and what the person
actually received. The judgement of which turns those are is mine, made after the run, and is labelled as such.
Everything counted is computed from the records.</p>
</div>

<div class="stats">
  <div class="stat"><b>${held.length}/${held.length + broke.length}</b><span>turns that went right</span></div>
  <div class="stat"><b>${ownOk}/${ownAll.length}</b><span>checks passed</span></div>
  <div class="stat"><b>${alwaysTrips.length}</b><span>always-rules broken</span></div>
  <div class="stat"><b>${unbacked.length}</b><span>said-and-not-done</span></div>
  <div class="stat"><b>${dbRefused}/${dbCalls}</b><span>lookups refused</span></div>
  <div class="stat"><b>${avgSecs}s</b><span>per turn</span></div>
  <div class="stat"><b>${avgWords}w</b><span>average reply</span></div>
  <div class="stat"><b>₹${totalInr.toFixed(2)}</b><span>the whole month</span></div>
</div>

<h2>The verdict</h2>
<div class="lead">
<p style="margin:0 0 10px"><b>Not ready for this business — and the reason is not the conversation.</b> The talking
is the strongest part of the product. Across 35 turns it never invented a price, never leaked one family's money to
another, never confirmed a payment on the payer's word, never signed anybody up who had not asked, and never chased
the stranger who went quiet. It read a broken wrist as a pause when the schema has no pause, and it volunteered at
month close that ₹2,700 had arrived with no bill behind it. If the question were "can a language model run the front
of a coaching business", this month answers yes.</p>

<p style="margin:0 0 10px">What failed is the plumbing underneath, and it failed in the one place that decides
whether a per-session coach keeps paying for this: <b>a month of coaching produced one billed session.</b> Money is
written when a register is marked; the nudge that exists to get registers marked is deliberately withheld from a
solo operator, because §18 says never nag someone about themselves — and for a solo operator there is no second
coach to nag instead. The bot noticed, correctly, on five separate turns. Nobody acted, because the message that
would have made him act was the message being suppressed.</p>

<p style="margin:0 0 10px">Three more block go-live for this shape of business, and each is a small, locatable
change rather than a rethink. A suppressed message is stored as <code>status='failed'</code>, so the product's own
best behaviour reads as an outage — and the bot twice told its owner his messaging was broken when it was working.
Nothing anywhere knows a coach cannot be at two venues at once, and for a one-man operation every overlap is real;
it created one on request without a single lookup. And "stop messaging me about money" was answered beautifully and
recorded nowhere, leaving <code>opted_out_at</code> null and the invariant that guards it passing for the wrong
reason.</p>

<p style="margin:0"><b>Where that leaves it.</b> A multi-coach, monthly-billing academy — the shape the spec was
written around — would not hit findings 1, 3 or 6 at all, and this drive says nothing against it. A solo,
per-session, private-lesson coach is a different product with the same code, and it is roughly four fixes away:
route the register nudge to the solo admin, split <code>suppressed</code> from <code>failed</code>, add a coach
overlap check at class creation, and make a partial stop request write a row. Two of the four are one-liners. None
of them is in the model.</p>
</div>

${
  READINESS.length
    ? `<h2>Area by area</h2>
<p class="sub">Area by area, against one bar: <i>would I hand this to a real coach with real clients and real money,
and go away for a month.</i> Hand-read on ${esc(VERIFIED_ON)}.</p>
<div class="scroll"><table>
<tr><th>Area</th><th>Verdict</th><th>What the month showed</th></tr>
${READINESS.map((a) => `<tr><td><b>${esc(a.area)}</b></td><td><span class="rd ${a.state}">${stateLabel[a.state]}</span></td><td>${a.note}</td></tr>`).join('\n')}
</table></div>`
    : ''
}

${
  FINDINGS.length
    ? `<h2>What is actually broken</h2>
<p class="sub">Faults in the product rather than in any one turn. Each was found by reading the real messages and
the real rows this run left behind, after the run, by hand.</p>
${FINDINGS.map(
  (f) => `
  <article class="finding ${esc(f.sev)}">
    <p class="ftag">${esc(sevLabel[f.sev])} · ${esc(f.tag)}</p>
    <p class="ftitle">${f.title}</p>
    <p class="fbody">${f.body}</p>
    <p class="fproof"><b>How this is known.</b> ${f.proof}</p>
  </article>`,
).join('\n')}`
    : ''
}

<h2>The month, turn by turn</h2>
<p class="sub">Every turn in the order it happened, against the world the ones before it built. The
${highlighted.length} linked ones are opened up in full below; the rest held and are here so the shape of the month
is visible rather than asserted.</p>
<div class="scroll"><table>
<tr><th>Turn</th><th>Who</th><th>What they said</th><th></th><th>Note</th></tr>
${records.map(timelineRow).join('\n')}
</table></div>

${
  highlighted.length
    ? `<h2>The turns worth reading</h2>
<p class="sub">${byBlame('model').length} the bot got wrong, ${byBlame('blocked').length} where something underneath
blocked it, ${byBlame('suite').length} where the test was the thing that was wrong, and
${byBlame('good').length} shown because they went right in a way worth knowing about.</p>
${highlighted.map(turnCard).join('\n')}`
    : ''
}

<footer>
Generated by <code>scripts/tennis-report.mjs</code> from <code>${esc(IN)}</code> — ${records.length} turns ·
${esc(arm)} · ₹${totalInr.toFixed(2)} at ₹${USD_INR}/USD · ${jobsRan} scheduled jobs fired${jobsFailed ? `, ${jobsFailed} failed` : ''} ·
${Math.round(hoursWalked)}h of simulated time · ${clockRefused.length} turn${clockRefused.length === 1 ? '' : 's'}
the clock could not reach · ${noChecks.length} turns with nothing of their own to check.
Every number on this page is computed from the run records. The verdicts, the findings and the choice of which
turns to open were read back by hand on ${esc(VERIFIED_ON)} against the full round-by-round transcript.
</footer>
</div>`

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html)
console.log(`wrote ${OUT}`)
console.log(`  ${records.length} turns · ${held.length} right · ${broke.length} wrong · ${noChecks.length} no-checks`)
console.log(`  ${highlighted.length} highlighted · ${FINDINGS.length} findings · ${READINESS.length} readiness rows`)

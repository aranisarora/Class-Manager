# Architecture

The shape of the product, why it is shaped that way, and where any new thing belongs.

`product-spec.md` says what the product does. `DRIVING.md` says how to find out whether it
does it. `PREFIX-RULES.md` governs the prompt. `findings/OPEN.md` holds what is currently
broken. **This file governs the shape** — read it before you build any capability, add any
table, write any guard, or create any new way for a message to reach a person.

Every rule here has evidence behind it. Nothing in this file is taste. Where a rule exists
because something went wrong, the incident is named, because a rule with no record of what
it rejected does not hold — that is PREFIX-RULES.md's founding lesson and it applies to the whole
system, not just the prompt.

---

## The idea in one sentence

**A capable model, told the truth, with every judgement left to it and every invariant
taken from it.**

Four clauses, and every failure this project has ever recorded violates exactly one:

1. **The model decides everything that requires judgement.** What to say, whether to act,
   who needs to know, what a person meant. Choreographing these fails — eleven behavior
   modules were retired by measurement, and the module-free arm was better.
2. **The substrate guarantees everything that must never be forgotten.** Fan-out,
   idempotency, materialization, permission. The model errs a few percent per decision;
   code errs zero percent per decision and one hundred percent when it is wrong for the
   situation. Use each where its failure mode is survivable.
3. **The schema stores every state anyone might have to report.** A state the schema will
   not store is a state the product cannot report — and, the stress month proved, one it
   will eventually mis-report. The worst sentence ever driven ("your number is set to
   receive nothing from us" — false) happened because "asked to stop, nobody answered" was
   not a row anywhere.
4. **Every layer tells the layer above it the truth about what actually happened.** The
   model repairs everything it is told about honestly and mis-narrates everything it is
   not. It is not the weak component. In the stress month, every catastrophic turn traced
   to the runtime lying to it, starving it of context, or lacking a mechanism it went
   looking for — and every place it was given a true mechanism and told the truth, it
   behaved.

## The layers

```
5  The instrument       drives, database read-back, recorded reasoning
4  The standing surface  jobs that fire on state changes; gates that resolve what they suppress
3  Context               byte-stable prefix + a tail that is honest about time and state
2  Capabilities          primitives + a few protocols; results that tell the truth
1  The transaction       one executor for every route; guards that read the world; diffs
0  The world             Postgres + RLS; every reportable state is a row
```

Each layer has one job. When something is broken, the fix belongs in the layer whose job
it is — not in the layer where the symptom appeared. The symptom almost always appears in
a message; the cause almost never lives there.

---

## Layer 0 — the world

**The rule: if anyone could ever ask about it, it is a row.** Not a memory fact, not a
button payload, not a sentence in a transcript. A row, under RLS, with a timestamp.

**RLS is the only security boundary.** It held on every hostile turn ever driven —
injection, takeover, cross-family, privilege escalation — while everything above it
wobbled. Nothing above this layer is security; everything above it is manners. A raw model
query and a person's own hand see exactly the same world.

**The states the shape requires.** These exist as rows, first-class:

- **A pending request.** Someone was asked something — an opt-out confirmation, a coach's
  decline, a cancellation, a plan preview — and has not answered. Who was asked, what,
  when, until when it matters, and how it resolved (tapped / expired / superseded). This
  is the single most expensive missing state in the project's history: untapped
  confirmations evaporated (F-AF, F-AQ), and worse, were relabeled — the stress month's
  2/10 turn happened because a staged opt-out rendered as "done" in the next turn's
  context, and the model faithfully repeated the lie to the person it was about.
- **Scoped communication preferences.** "Stop messaging me about money" is the commonest
  stop request and it is a *scope*, not an opt-out. A mute per category (payments,
  reminders, outcomes), optionally until a date, read by the jobs that compose those
  messages. The model already hunts for this: it enumerated `set_timing`'s keys looking
  for a money mute, found none, fell back to a memory fact, and said "Done" — and a money
  message went out nine days later (F-AV, F-AO). A preference stored only as a memory fact
  stops nothing, because the jobs compose from queries, not from memory.
- **Suppression is not failure.** A message the product decided not to send and a message
  the wire could not deliver are opposite facts and must be distinct values. Sharing
  `status='failed'` made the product tell its own owner his messaging was broken when it
  was working exactly as designed (F-AT).
- **How the owner wants the business to run is stored, with provenance.** Not just
  money policies — rules, preferences, and standing intent, in the owner's own words:
  refund terms, age limits, "no makeups on Saturdays", "ask me before waiving anything
  over ₹500", "we're trying to fill the morning batch — push trials there". Every
  business is unique, and this store is where the uniqueness lives — as **data in the
  tail**, never as a per-tenant prompt fork, because the prefix must stay byte-identical
  for every business forever and the cost model allows no other answer. Two properties
  are load-bearing:
  - **Provenance.** A rule the owner stated outranks everything, and only the owner
    retires it. A pattern the model observed is a *suggestion* until the owner blesses
    it — the two-tap protocol exists for exactly this. The alternative was driven: the
    model invented a pro-rata refund policy for a prospect, remembered itself saying it,
    and the invention acquired the authority of memory.
  - **Scope honesty.** A rule in prose steers the model on turns it is present for; it
    does nothing to a job composing from a query at 9am — a "no money reminders" memory
    fact was followed by a money reminder nine days later (F-AV). A rule that must gate
    automation — mutes, timings, money — maps to a typed row the jobs read. When the
    owner states one, the model makes that conversion, or says plainly which half it can
    guarantee: "I'll follow that in conversation; the automatic reminders don't read it —
    want them off?"

  "No rule on file" is a readable answer, and an unstated rule is the owner's decision
  to make, not a vacuum to fill.
- **Solo is a truth a real path writes.** `is_solo()` keys on a coach status that only
  coach-onboarding writes, and a solo operator has nobody to be invited by — so the
  product's solo behaviors existed only on runs where the model noticed and hand-wrote
  the activation SQL itself (F-AY). Whether eight behaviors exist must never be a property
  of the model's diligence. Adding a coach who is already the admin activates them —
  there is nothing to confirm to yourself.
- **Every outbound message knows what sent it.** A turn, a job, or a tap — attribution as
  a column, populated on every route. 27 of 81 outbound messages in one drive carried no
  `turn_id`, which meant the truth axis could not be measured on exactly the surface where
  the product acts unsupervised. The instrument can never know what the product does not
  record.

**One `academy` row per number is not a tenant, and the discipline is the price.**
`is_front_desk` (0039) marks the arrivals hall of a WhatsApp number — where a person who
has not said whether they want classes or run them gets a person, a contact, a transcript,
buttons, a turn row and the one send path, with no parallel machinery at all. The honest
alternative was a tenant-less `visitor` table, and following it through gives
`visitor_message`, `visitor_action`, `visitor_turn` and a second path to the wire, which is
this file's own rule about a thing getting *its own corner and its own renderer* applied to
the load-bearing half of the system.

What the shortcut costs is an exclusion that has to hold in every enumeration, so every one
of them says `is_front_desk` out loud rather than relying on a reader to remember:
`app.inbound_candidates` (matching), `listAcademyIds` (the job beat), `businessesOnThisNumber`
(what the desk may route to). Two properties keep the fiction safe rather than merely
convenient: RLS still confines a visitor, to a tenant that owns nothing; and the row's
`onboarding_state` is never `live`, so Layer 4's pre-launch gate makes it structurally
incapable of initiating a message. **A front desk that could message strangers is a spam
engine on a pooled number**, and that gate is the sentence saying it cannot.

**Invariants live in the schema where the schema can say them.** Unique keys, dedupe keys
(`tally_line.dedupe_key` is the exemplar — billing identity normalised so a retry cannot
double-charge), foreign keys. A watch has a normalised subject key, so a second watch on
the same subject supersedes instead of accumulating (F-C). What the schema cannot say
moves up exactly one layer, never further.

**Derived state is materialized from the world, not from the function you called.**
Sessions exist because slots exist — by code that reads `class_slot`, on every route
including a hand-written insert. The old shape, where `create_class` was "the only thing
that schedules the sessions", meant a class inserted any other way had weekly times and no
sessions that would ever happen.

---

## Layer 1 — the transaction

**The rule: one executor, and guards that read the world it produced.**

**Every write travels through `executePlan`** — model-authored plans, button taps, form
submissions, job actions. One transaction, every affected row diffed, messages staged not
sent. There is no second path to keep honest. This is already the project's best
structural decision; the shape keeps it absolute.

**Guards ask what the world *became*.** The template is `lib/agent/clash.ts`, and its
reasoning is the most important paragraph in the codebase: five different things put a
coach somewhere, and a check written into one of them is a check written into one of
them. So the guard runs inside the transaction, after the steps, before commit, scoped to
the rows the plan touched, and asks the database the question directly — which is the
only place the question has one answer and the only place that covers routes nobody has
written yet, including the model's raw SQL and paths built next year.

**Guards note and gate. They do not refuse.** An overlap is sometimes two courts; only
the person knows. The guard's finding becomes a plan note that rides into the preview and
the receipt, and `needsPreview` treats it as consequence — a plan can be consequential
for what it collides with rather than for how much it writes. The person's tap is the
override, because it already was.

**The affected-but-untold census is a guard of this kind.** A plan that changes rows
other people depend on — a session moved, a class cancelled, a rate changed — while
staging no message to them, gets a note: *"two families are affected and nothing tells
them."* The model then composes the fan-out with judgement, or says why silence is right.
This is what makes notification a property of the substrate instead of choreography
copied into every operation — the old shape carried ~41 hand-written message steps inside
operations, and the model, asked to compose writes raw, would remember the fan-out most
of the time. Most of the time is not a property; a note in the receipt is.

**Consequence, not row count, decides the preview.** Money, other people, destruction,
collisions, anything irreversible — previewed behind the person's tap. A plan touching
nobody else, no money, nothing destructive has already run when the call returns.

**Elevation lives here and only here.** A step may run as the service role only inside
reviewed protocol code. Model-authored steps never elevate; the model's SQL sees exactly
what the person it serves could see by hand. The elevation points are permission grants
wearing function clothes, and they are audited as such.

**Diffs are captured for every write, on every route.** Receipts, undo, and audit are
properties of the substrate, not features of individual tools.

---

## Layer 2 — capabilities

**The rule: primitives for everything with a SQL sentence, protocols for everything
without one, and results that tell the truth.**

**The primitives:** `read` (one SELECT, their permissions), `plan` (steps in one
transaction), `reply` (to this person or anyone, with buttons, lists, forms), `schedule`
(a future task with a subject key and an expiry), `remember`, `handoff`, `view`. These
plus the schema are the whole general surface. The model composes; the substrate
guarantees.

**The protocols — kept because no SQL sentence exists for them:**

- **Two-tap confirmations** (`opt_out`, `confirm_coach` / `decline_coach`,
  `client_cancel`): put a question on a person's screen where only *their* tap may answer
  it. Each writes its pending-request row at the ask, so the unanswered state exists from
  the first second.
- **`commit`**: run a previewed plan by its handle. The tap is the only route.
- **`undo`**: reverse a committed plan from its captured diffs.
- The elevation points, until each one's RLS question is answered properly in layer 0.

**Wrapper operations do not exist in this shape.** An operation that was a prewritten
plan — CRUD plus notes — is gone, because layers 0 and 1 hold its invariants (dedupe in
the schema, collisions and fan-out in the transaction guards, materialization in the
world) and the prefix holds its knowledge (billing rules and consequences as facts in
`SCHEMA_DOC`, per PREFIX-RULES.md's ladder). The evidence for this is the model's own behavior:
it already routed around opaque operations and composed the rows itself, correctly, while
the operations layer is where the wrong explanations concentrated (F-AG, F-AX, F-AY,
F-AW, the "0 in, 0 out" ack). Two documents describing one truth always drift; the shape
keeps one.

**Results tell the truth, in words the model can act on.** This is the cheapest teaching
channel the product owns, and the stress month showed both directions: every honest
refusal was repaired in-turn; every dishonest result became a false sentence to a person.

- **Staged says staged.** One spelling, uniform across every protocol and preview, so the
  next turn's context renders "waiting on their tap — NOT done". The relabeled staged
  action ("done") produced the worst message ever driven.
- **A permission refusal names permission.** "That row exists; this person may not change
  it; this is not something to retry; the owner can" — never race language. "The world
  moved under this plan" sent a model into a model-perfect diagnosis of the wrong cause
  and a parent into an invited retry loop (F-AX). The raw-SQL path already had the honest
  wording; every path speaks it.
- **A diagnostic names its subject or is not surfaced.** "2 steps matched no rows —
  check that part landed" cost a round of deliberation trying to guess *which* two, and
  the same string reached a prospect verbatim. A result either says which steps, in words
  the model can act on, or it says nothing. Plan-builder internals never ship in a
  message body.
- **Recovery guidance fits the tool that failed.** Advice that assumes raw SQL, given to
  a model on a named path, compounds the misdiagnosis.

**The runtime never reads or writes prose.** This is clause 1 applied to the send path,
and it is a hard rule. Deterministic machinery is the right tool where a question has one
answer — rows, diffs, permissions, caps, collisions. It is the wrong tool wherever the
question is "what does this sentence mean?", and the record is total: every pattern that
ever read or edited language in this product misfired silently, in both directions. The
promise detector matched "try" and missed **"retry"** — the most likely verb in a
recovery draft. The trailing honesty guard was gated on a pending plan, so the turn with
nothing true to claim was the turn with no guard, and a false injury-routing claim
shipped through the hole (F-AM). The refused-button report fired only when *every* button
died, so a woman asking to opt out was sent prose naming a button not on her screen
(F-R). The backstop menu decorated a child-injury acknowledgement with
`[What can you do?]`. What replaces each of them:

- **Validation refuses; it never mutates.** Structure — button counts, title lengths,
  the interactive body cap — is declared at the decode point and checked when the model
  hands the message over. A violation comes back as a refusal with the reason, one round
  of grace, while the model can still fix it. No silent trims, no stripped buttons, no
  appended menus. **What ships is byte-for-byte what the model wrote**, so the model's
  next sentence about its own message is never a guess. (An out-of-window send rides
  inside a Meta-approved template shell — that is the wire's requirement, not an edit,
  and Layer 4's one-author rule governs that seam.)
- **Honesty checks are structural, not linguistic.** A claim is checked against what the
  turn actually did: a turn with no write, no send and no plan has nothing true to say in
  the past tense, and every stated fact traces to a read or a write this turn — the R10
  traceability gate. State comparison catches what the verb lists missed (F-AM's turn had
  zero writes — trivially catchable) and cannot false-positive on phrasing.
- **Where meaning must be judged and state cannot answer, a model judges.** Never a
  pattern. A pattern whose output steers a turn or touches a customer's message is an
  unsupervised judge that has been wrong every time it mattered.
- **Encoding transforms survive.** Markdown to WhatsApp markup changes representation,
  not meaning, and the model is told it happens. That is an adapter, not a second author.
  Anything that deletes, adds or rewrites words is not an adapter.
- **There is no backstop composer.** No fallback menus, no bolted-on buttons. The model
  is told at the decode point what a buttonless reply costs the person, and decides —
  because a runtime that decorates messages is a second author, and the injury
  acknowledgement is what second authors do.

**Declarations carry every hard constraint.** A declared schema constrains generation; a
paragraph upstream of the decode point constrains nothing — measured twice (the untyped
`act` tool: 0 calls in 464; operation prose moved into declarations and the wasted rounds
disappeared). Every column RLS demands, every required argument, every cap is in the
shown signature (F-AG).

**Everything a tap can run is validated when minted.** Tap-time has no model present —
a button's payload executes as stored. So the payload is checked at compose time, while
the model can still fix it, and refused with a reason. A button that fails politely at
the tap is a promise already broken (F-AW: an admin was told his prices would rise; they
did not).

---

## Layer 3 — context

PREFIX-RULES.md governs what goes in the prompt and how to decide; it is subordinate to nothing
in this file and this file does not repeat it. The architectural rules on top of it:

**Everything the model is shown is either byte-stable forever or stamped with when it was
true.** The prefix is byte-stable — that is the cost model. Everything in the tail
carries its time: the census says "when this turn started"; every replayed lookup carries
its age off the domain clock, because in a WhatsApp thread "earlier in this conversation"
can be three weeks ago, and a two-day-old zero-row result presented as current data is
how the model reassured an owner that every register was marked while two were not.

**The tail answers the questions the model would otherwise reconstruct from conversation
memory.** Reconstruction is where the false unsubscribe confirmation came from. The "who
you are talking to" block carries the person's standing states: roles, money visibility,
opt-out (set, or *requested and unanswered*), active mutes, pending requests. One line
each, only when set. The model should never have to infer a state layer 0 stores.

**Memory holds only what the schema cannot.** Habits, vocabulary, preferences with no
column. Never a copy of a row — a memory copy of a row is a wrong answer waiting for the
row to change. And **never a fact sourced from the model's own composed sentence** — the
refund invention became "policy" by exactly that route: the model said it, then
remembered itself saying it, and the invention acquired the authority of memory. A fact
comes from what the person said or what a row held. Row-shaped facts are refused at the
write; curation retires what slips through.

**The model is told the vacuum exists.** One fact: the business's policies are not
written anywhere unless the owner has stated them, and an unstated policy is the owner's
decision to make, not a gap to fill in the asker's favour. This passes PREFIX-RULES.md's
admission test because it is not derivable — to a model, a zero-row world reads as "no
restriction", and it answered "yes, we take four-year-olds" and "yes, we refund unused
weeks" from exactly that reading.

---

## Layer 4 — the standing surface

**The rule: jobs fire on changes in state, and a gate that suppresses must resolve the
state the message existed to resolve.**

**Fire on change, never on the calendar restating stuck state.** A coach who has not
onboarded is one fact; narrating it daily in byte-identical messages trains everyone to
ignore the number (F-AN — sixteen consecutive repetition failures, all queue traffic).
Dedupe is per state and per fact, not per byte-window: two registers is one message, two
children with news on the same day is one message.

**Half a gate is worse than no gate.** The §18 gates correctly refused to ask a solo
owner to confirm coaching to himself — and nothing then resolved the confirmation, so
every session stayed "unconfirmed" forever, and the client-facing trouble ladder told
paying families "we're still sorting out a coach" **38 times in one month** about
sessions that all ran. When suppression is the right call, the suppressed question's
answer is supplied by the same decision: a solo coach-admin is definitionally present, so
suppressing the ask confirms the session. Likewise the register nudge for a solo
operator: on per-session rates the unmarked register *is* the invoice, so it reframes as
news ("two hours since Kabir's session, nothing billed yet") rather than being suppressed
as a self-scolding — a month of suppressing it produced two attendance rows in 26 days
and ₹0 correctly billed (F-AS).

**Quiet hours are a floor under every proactive send.** Going live at 2am fired three
reminders at 02:02. No job composes around it; the send layer enforces it.

**Composed copy has one author.** The template's fixed lead-in and the composed body may
not both state the subject (F-G). A template parameter carries substance, never a
placeholder — "Change: a change to today's session" tells a parent nothing and was sent
seventeen times to one contact. What differentiates one notification from another (the
child, the day) is in the body, within what Meta approves, or the notification does not
earn a send (F-AZ).

**The brief and the digest are ordinary turns, opened by a job.** There is no separate
synthesis path — no bespoke model call, no dearer model, no toolless prompt fed
pre-queried rows. The old shape ran two `MODEL_SYNTH` calls a day on the pro model,
regardless of whether anything had happened, at a thinking level nobody chose, with no
flight recorder — and it cost 3.5× the entire human conversation while caching at half
the rate, because the bespoke path could not share the stable prefix. Every reason it
existed inverts under the architecture:

- The cached prefix is the *cheap* part — a hit costs 3.2% of a miss — so an ordinary
  turn on the conversation model costs less than the bespoke call did. The stress month
  is the evidence the conversation model is enough: the hardest judgements of the run
  were made by it, and summarizing a day is easier than the clash refusal was.
- As a turn it has tools, which fixes a real defect class: the old synth was spoon-fed
  query results it could not verify or widen — which is why a digest once told the solo
  coach "I think coaches aren't marking after sessions" *about himself*. A turn reads
  what the sentence needs, like every other turn.
- As a turn it is recorded, guarded and result-honest for free. The two most expensive
  calls of the day stop being the two with no record of why they said anything.
- The special doctrine constraint dies with the path: nothing needs to be "true on the
  toolless path too" when there is no toolless path.

**And it fires on news, not on the clock.** The job that opens the turn runs a cheap
deterministic census first — anything new, pending, or broken since the last brief? An
empty census opens no turn and sends nothing: the quiet *is* the all-clear, which is
doctrine's own promise. Cost then scales with events, not with days — the old shape
composed 56 briefs for a business that received 36 messages in a month.

---

## Layer 5 — the instrument

**The rule: the eval is part of the architecture, and it must be able to see inside a
turn.**

- Drives post to the same API a human uses and read verdicts from the ordinary tables.
  Nothing in the harness knows anything the product does not record.
- The flight recorder keeps the model's reasoning on **every** round that deliberated,
  including recovery rounds, untruncated within a generous cap. Four of the stress
  month's six findings were only visible in the reasoning; the instrument was blindest
  exactly where the turns were hardest, until it wasn't.
- **A deterministic check asserts a fact about the world, by query — never a pattern
  over prose.** "opted_out_at is null", "no tally line exists", "handoff was called" are
  checks; a regex over a reply is not, in the instrument any more than in the product.
  The record justifies the ban: the adversarial harness manufactured two findings with
  patterns (one fired on the string "system prompt" inside a *correct refusal*), the
  overclaim counter read 0 on a drive containing exactly one, and the invention check's
  pattern missed "the unused portion is credited back". What a sentence means is judged
  by a reader — a judge model with the full turn in front of it, or a human — and the
  stress month's verdicts were exactly that: every turn read, checks consulted as
  evidence only.
- Checks are tripwires, not verdicts. The reading is the verdict. A check count is not a
  defect count.
- **A check never validates a claim against evidence the same turn created.** The
  invention check accepted the model's own just-written memory fact as proof the refund
  policy existed. Support means rows that predate the turn.
- Evidence snapshots are dumped when the run ends, not mid-run — a report written against
  a run that was still going missed the run's worst new behavior.
- Behavior content is added to the prompt only on the evidence of an A/B drive, one
  variable apart. That is how the eleven modules died and how doctrine 18 earned its
  place, and it is the only argument this project accepts.

---

## Where does a new thing go?

The placement ladder for the whole system, strongest home first. Place as low as the
thing allows.

1. **A state someone might ask about → a row.** Layer 0. If you are about to encode a
   state in a button payload, a memory fact, or a sentence, stop.
2. **A thing that must never happen, or never be forgotten → the schema if it can say
   it, else a transaction guard that notes.** Layers 0–1. The guard reads the world the
   plan produced, not the caller's intent.
3. **A thing with no SQL sentence — a question on someone's screen, a commit, an undo,
   an elevation → a protocol.** Layer 2. This list grows reluctantly.
4. **A hard constraint on what the model generates → the declaration.** Layer 2, at the
   decode point.
5. **Knowledge the model cannot derive → the prefix**, through PREFIX-RULES.md's admission
   test. Layer 3.
6. **A recurring message the world owes someone → a job keyed on a state change.**
   Layer 4.
7. **A behavior in a named situation → nowhere.** The model derives it, or one of the
   layers above is missing something — go find which. This rung is where everything the
   project has ever deleted was standing.

## What the model owns, and what it must never be trusted with

Owns, absolutely: what to say and how to say it; whether to act and when to wait; who
needs to know and what they need to hear; what a person meant; what is worth remembering;
when a human must take over; every number — read from a row this turn.

Never trusted with — not because it is incapable, but because per-decision reliability is
the wrong tool for always-properties: fan-out completeness (the census note backstops
it), idempotency (dedupe keys), permission (RLS), carrying pending state across turns
(rows), the existence of policy (rows or the owner). Every one of these was once left to
diligence, and every one produced a finding.

## The traps

Each has an incident behind it. They are the shapes to check any new design against.

- **The relabeled state.** A false residue is worse than no residue: "done" for staged
  produced a false unsubscribe confirmation to a person who had asked to be left alone.
- **Half a gate.** Suppressing the message without resolving the state manufactured 38
  false alarms to paying families.
- **Race words for permission.** A model given a wrong cause diagnoses it perfectly and
  is still wrong; the customer inherits the misdiagnosis.
- **Two authors of one truth.** Template + body, catalog + handlers, declaration + RLS,
  operation-status + predicate. Every pair drifted. Keep one author, or make one read the
  other.
- **The unstamped past.** Data shown without its age is treated as current, and the model
  will argue itself out of a correct doubt with it.
- **The second author.** Any gap between the message the model wrote and the message the
  person read becomes a false belief in the very next turn. The final shape does not
  report the runtime's edits — it does not have edits. Validation refuses; nothing
  mutates.
- **The pattern that judges prose.** Every regex ever pointed at language here — promise
  detectors, claims lists, leak checks, invention checks — misfired silently, in both
  directions, in the product and in the instrument alike. Meaning is judged by a model or
  a human, or checked against the world; it is never matched.
- **The model-free path.** Taps and forms execute with no judgement present; whatever
  runs there is prevalidated and guarded by the transaction, because nothing else will
  ever notice.
- **The answered vacuum.** A question with no row behind it gets a plausible answer, and
  a plausible answer restated by memory becomes policy.
- **Circular evidence.** A check, a fact, or a claim validated against something the same
  turn produced proves only that the turn agrees with itself.
- **The narrower request that costs more.** Sending the model less is not sending less. The
  cached prefix is the discounted part, so anything that leaves it behind — a bespoke call
  with its own small system prompt, a round with a filtered tool list, a trimmed history —
  pays full price for its whole request. Both times it was measured the smaller request was
  the dearer one: `MODEL_SYNTH` at 3.5× the human conversation, and the reflection round's
  two-tool filter at 64% of a run's cache misses for a constraint its own dispatcher was
  already applying. Cheapness here is a property of *sameness*, not of size.

  **The one legitimate second prefix, and the test it had to pass.** The front desk
  (`lib/frontdesk/`, §10.0) runs on a prefix of its own, and the trap above is the first
  objection to it. It survives because the trap is about *bespokeness*, not smallness: a
  block is cheap when it is the same bytes as last time, and this one is byte-identical for
  every stranger on every number forever — one more cached entry for the whole deployment,
  never one per tenant. The arithmetic then goes the other way. Reusing the tenant prefix
  would cost a cached hit on ~50k tokens for a conversation that needs none of it; its own
  block is ~2% of that, so it is cheaper cached *and* cheaper cold. The test for any future
  second prefix is those two questions in that order: **is it the same bytes every time, and
  is the rest of the request small enough that a miss would still be cheaper?** `MODEL_SYNTH`
  failed the first and the reflection filter failed the second.

---

*This file changes the way PREFIX-RULES.md changes: by evidence. A drive that shows the shape
costing something is the argument; a hunch that a layer might need more is not. When a
finding names a defect, the fix belongs in the layer whose job it is — and if you
genuinely cannot find the layer, write the finding down unfixed rather than patching the
symptom where it surfaced.*

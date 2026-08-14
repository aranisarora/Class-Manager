# What to do next

Written after the pass that drove the money back-half to the end, gave every business its
own clock, and hand-drove the coach, parent and prospect personas for the first time.

**All three personas came back `not-ready`**, and the worst symptom in all three was one
root — an operation raised in a customer's turn could not message the owner, silently. That
is fixed. What remains is in this file.

This is **not a defect ledger**. `DRIVING.md` holds the method — how to find a defect, the
ten roots every defect falls into, the seven axes, and the traps. `product-spec.md` remains
the authority on behaviour. `FINDINGS.md` records what the last pass found and how.
This file is the argument for **what to build next, why, and how**.

Every claim below is marked **verified** (ran it and watched the rows change) or **inferred**
(read the code, confident, did not run it). Do not promote an inferred claim without running it.

---

## Where the product stands

**The floor is finished work. Do not re-check it.** RLS is the security boundary and the
model is a user of it; plans cannot half-commit; messages are staged until commit; buttons
cannot be minted un-tappable; every suppression is a row carrying its reason; jobs decline
rather than fire stale. `node scripts/rls-check.mjs` and `node scripts/verify-static.mjs`
both pass. Spend your time elsewhere.

**The core lifecycle now runs, once, in one world — verified.** A business was created from
empty, set up through a WhatsApp Flow in one exchange, given a class, a coach who was
invited and confirmed herself active, two families, and taken live through a preview and a
tap. Its first session completed, its register was marked from chat, both families were told
the outcome, both players were billed ₹1,200 for August, a payment was requested and a
reconcile scheduled, and a family left with its enrolment ended and its player deactivated.

**Treat that as "has run once", not "works".** It is one world, one model, one clock. What
it does establish is that no stage is *structurally* unreachable any more, which was not
true at the start of the pass.

**And the money back-half has now run.** §11.5's `requested → confirmed` fired twice with
correct rows and no double credit; the dunning ladder ran to escalation; a class closed and
freed its name. `per_package` and `per_term` are fixed but still **not driven** — their
three defects were found by reading and are held by a constraint, not by a pack rolling
over in a live academy.

**The defects still cluster in the last six inches** — what reaches the customer's screen —
**and in the wiring between correctly-built components.** Nine of the ten things fixed this
pass were in one of those two places. Almost nothing was wrong with the components.

---

## Five things worth knowing before you decide anything

### 1. Read to find the shapes, drive to find the defects — and this pass measured the ratio

A nine-reader map produced 115 gaps, ~100 marked certain. It was worth having: two malformed
job payloads and a month-boundary billing bug came out of it and would never have surfaced
by driving, because all three fail silently and one only fires on a shape the fixture world
does not contain.

**But every defect that reached a person was found by driving**, and the three worst were
invisible in the map. The map tells you a guard is missing. Only a drive tells you what
walks through the gap — and in this pass what walked through was *"tap the button below"*
with no button, on the first message a new owner ever receives.

### 2. The dangerous claims are the ones the runtime can check and does not

Three claims got structural checks this pass, and none needed the database: a past-tense
sentence with no write behind it, a message pointing at an affordance it does not carry, and
a receipt counting messages that were suppressed. All three are answerable **from the
message and the turn's own record**.

That is the line. `lint.ts` is right that no string operation can tell "14 enrollments" from
a price — that needs the world. But "the body says 'the button below' and `buttons` is
empty" needs nothing, and for the whole life of the product nobody was asking.

**Before proposing a fact-grounding gate, check the cheaper half is exhausted.** Ask of any
claim: can the runtime falsify this from what it already holds? If yes, it is a check, not a
guess, and it costs nothing at run time.

### 3. A guarantee applied per-caller is not a guarantee, and `send` is the chokepoint

`lint` had three callers and every job handler, both daily digests, every tap ack and every
plan-staged message went out raw. The obvious fix — `composeAndSend` — is **wrong**:
`plan.ts` imports `send` directly, so a guarantee there still misses every message an
operation emits.

Walk up until there is exactly one door. For outbound traffic that is `send()`. The same
question is worth asking of `previewPlan`/`executePlan`, which the tap path, the web forms
and three tools all reach independently.

### 4. A standing decision is evidence about a moment, not a law

"No WhatsApp Flows" was recorded as settled and was mostly wrong: three of its four costs
apply only to *endpoint-powered* Flows, and nothing in the note said so because nobody had
gone back to the source. The static case needs no keypair, no endpoint, no encryption.

The decision was made honestly and recorded honestly. It was still worth re-deriving, and
the tell was that the objection was a list of costs with no note of which case incurred
them. **When a settled decision names costs but not conditions, it is worth re-reading the
primary source before building around it.**

### 5. The census earns its place, and its names are still the highest-leverage prose

Unchanged from the last pass, and reconfirmed: the one line added to the admin census this
pass — leading with NOT LIVE — is what made the model offer `[Go live]` at all, on the very
next turn, having never offered it before. No predicate changed. **Audit every key you hand
to synthesis as if it were copy, because it is.**

---

## The surface split, decided

**The web is for looking at spatial things. Every form is a Flow.**

This is a direction, not an observation, and it settles what had been drifting: `setup`
and `register` are *forms*, and a form that takes somebody out of WhatsApp into a browser
on a phone is a worse form. The web surface earns its place only where a screen shows
something a chat cannot — a timetable, a calendar, anything you read spatially.

- `setup` — a Flow. Both paths now send the Flow (§5 in `FINDINGS.md`); the web setup
  screen is no longer the default and is next to remove.
- `register` — **still a web link, and should be a Flow.** It is a form: tick who came,
  add a note, send it back. This is the largest piece of the split still to build.
- `calendar` — stays web. It is the case the web surface exists for.

**Dedicated onboarding Flows are wanted for admins, coaches and probably clients.**
`onboarding_setup` is the admin one and it is built. The coach's *"is this right?"* and a
client's first-contact details are the same shape and do not exist yet.

The old objection to Flows was re-derived last pass and was mostly wrong: three of its
four costs apply only to endpoint-powered Flows. A static Flow needs no keypair, no
`/data` endpoint, no encryption. Do not re-open it.

## The work, ranked

### 0. Done last pass — do not re-find these

Fourteen defects, evidence in `FINDINGS.md`, each with the *why* at its fix site. In short:
money idempotency keyed on ids under a unique index (0023); `rate_count` made mandatory for
`per_term`/`per_package` (0025); the pack rollover moved to the class the spec names; the
free first class priced from real session rows instead of a whole billing period;
`is_trial` given a transition out; a per-academy `sim_clock` (0024) with the job runner
comparing each job to its own tenant's clock; `close_class`; the out-of-window template no
longer restating its own frame; the repetition gate taught to see out-of-window messages;
a plan write that matched nothing no longer vanishing from the receipt; an operation able
to reach the owner from a customer's turn; a permission refusal becoming a real handoff;
`mark_attendance` refusing a class that has not happened; `MAX_TOOL_ROUNDS` 8 → 5; `recall`
and `act`'s declaration deleted.

**What is worth carrying forward from them:**

- **`tally_line.dedupe_key` is the pattern.** Identity in ids, under a unique index,
  computed in one shared file. Copy it anywhere two writers agree by convention.
- **The runtime performing an escalation beats telling the model to.** `refusalHint` had
  the right sentence and the model ignored it twice, at seven rounds a turn.
- **Ask what a fix does when the actor is NOT the persona you found it with.** Two of the
  refusal-escalation guards exist only because of that question.

### 1. A genuinely unknown number is dropped without trace — the largest hole left

**Why.** **Verified** by a hand-driven prospect: an inbound from a number no academy knows
writes no `message` row, no `job`, no `audit_entry`, in any of seven academies. The only
trace is a string in an HTTP response body that nothing reads. A lost enquiry is
**undetectable by construction** — the worst answer to "who would find out" is "nobody",
and this is that answer on the product's acquisition path.

"Signup is the operator's, not a product flow" is a real standing decision and it does not
require silence. Deciding not to serve a stranger and *keeping no record that one arrived*
are different choices, and only the first was made.

**How you will know.** `drive stranger +91… "do you do beginner classes?"` from a number
that appears nowhere, then ask the database what exists. Today: nothing.

### 2. §14.8's automatic escalation has no runtime enforcement, and `handoff` has never fired

**Why.** The spec wants refund, complaint and safety language to raise a human
automatically. There is no mechanism — it is prompt text — and `handoff`, the tool that
would do it, was called **0 times in 464**. The refusal path now performs its own
escalation, which proves the shape works and covers only permission refusals. Anger and
safety are judgement, and they are the cases where being slow is worst.

**How.** The situation has to be named where the model cannot miss it, or the runtime has
to raise it the way the refusal path now does. Prefer the second: the first has already
been tried and is what R8 is.

### 3. R10's fact half, in shadow mode first

Unchanged and still the most open root. A reply may state a time, a date, a price or a
roster never read from a row. **Log what it would block, block nothing, drive, read the
log.** Do not implement it as a lint rule over message text — `lib/agent/lint.ts` explains
why at length.

Turn it on when it catches a class time no row holds without flagging *"his class is
Mon/Wed/Fri at 6"*, which is a real answer to "when is his class?" and only a wrong answer
to "when is his *next* class?".

### 4. The watch overshoot, now measured

**113 pending `agent_task` watches**, roughly one per turn, several of them nonsense — one
watches the word *"replayed"*, which is a driver artifact rather than anything a person
said, and every payment confirmation schedules a follow-up to check whether the payment it
just confirmed went through. Each is a full model turn later. R8's overshoot with a number
on it.

### 5. The register as a Flow

Unchanged: the web surface is for things you read spatially, every form is a Flow, and
`register` is still a web link and still a form. Coach and client onboarding Flows do not
exist.

### 6. The finish, and the smaller things

- `client_cancel` declares `scope: 'session' | 'series'` and never reads it.
- `move_class` announces a whole class while moving one slot.
- `reschedule_session` still accepts a past time. `mark_attendance` no longer does — the
  same one-line comparison fixes it.
- `[Yes, end both]` can still be minted for a parent whose write the database will refuse.
  The tap is honest now and escalates, but the button over-promises.
- The `prospect` contact state is destroyed by a trigger before the agent sees it, so every
  path gated on `state='prospect'` is dead. **read it**, not driven.
- The production media path still never fetches bytes.
- `alter role cm_runtime set idle_in_transaction_session_timeout = '60s'` — still unwritten.

## What not to do

These are settled. Re-litigating them costs a round of somebody's time and reaches the same answer.

- **Do not rebuild recipes.** Removed deliberately, not abandoned mid-way. If plan reuse is
  wanted again, what was missing was never the capture — it was a consumer that could bind a
  captured plan's placeholders, and a definition of "good" better than *"it was expensive and
  it did not crash"*. Build those first or not at all.
- **Do not add a behavior module.** Every round has added one. The strongest evidence against
  it: `doctrine.md` rule 11 already describes the fact-grounding failure exactly, it was in
  the cached prefix on every turn of the round that produced that failure, and it did not
  prevent it. Instructions do not close structural gaps — and this pass closed three gaps
  with about forty lines of runtime code each.
- **Do not add number-grounding as a lint rule.** See item 4.
- **Do not pixel-match WhatsApp.** Behavioural fidelity, not visual. Enforcing the real API's
  limits *is* behavioural fidelity and is worth it; chrome is not. The Flow work follows this:
  the emulator takes `response_json` as a **string**, because that is what the wire delivers.
- **Do not trim the operation registry.** Measured against the bodies rather than the list,
  it earns its place. It is 29 operations now — `end_enrollment` and `end_client` were added
  this pass because client churn had none.
- **Do not optimise rounds or prompt size ahead of the items above.** Rounds are the cost
  story and prefetching into the tail is the lever — but the product's problem is still that
  it can be wrong, not that it is slow.

---

## Two housekeeping notes

- **The world is not a clean fixture.** This pass left `Baseline Badminton Academy` (a full
  lifecycle, live, with a departed family and an opted-out contact) and the harness agent
  left `Harness Check Sports` and `Harness Month Club`. `npm run seed` resets the shared
  fixture; `drive drop "<name>"` removes one. That world is evidence, not a fixture.
- **The sim clock was left where it was found**, but two agents and a driver shared it for a
  whole pass. If a job's timing looks impossible, check the clock before believing the row.

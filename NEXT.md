# What to do next

Written after the pass that took the core bot from "onboarding cannot finish" to a full
lifecycle driven end to end in WhatsApp: empty → business shape → timetable → coach →
roster → live → session day → register → billing → churn.

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

### 0. Done this pass — do not re-find these

Nine defects fixed and driven; the detail and the evidence are in `FINDINGS.md`. Items 1
and 2 below are **closed**. What is worth carrying forward from them:

- the honesty guard is claim-scoped now, and a plan's writes are recorded, but the
  **passive voice** (*"Aarav is now enrolled"*) is deliberately not matched
- `CHANGED_NOTHING` now distinguishes an RLS refusal from a bad WHERE, which was the
  expensive half of the parent-cannot-end-enrolment turn; whether a parent *should* be
  able to is still an unanswered policy question
- `class` has a unique key on open classes, which newly requires **an operation that
  closes a class** — there is none

### 1. ~~Make the honesty guard claim-scoped, not turn-scoped~~ — done

**Why.** **Verified** by reading a clean run turn by turn. Asked to hire a coach, the model
told the admin *"He hasn't been messaged yet — I've just drafted the invite for you to
forward."* The turn ran `add_coach` and `reflect:remember` and nothing else; **no draft
exists**, so the coach is never invited and the admin believes otherwise.

The guard passed it because `add_coach` committed. `ctx.committed` is a property of the
TURN, so one true claim licenses any number of false ones beside it — and the false one is
invisible precisely because the message is mostly right.

**How.** `ctx.executed[]` already records every operation that ran this turn with the rows
it wrote. The tractable version is not general fact-grounding: it is asking whether a
sentence naming a *specific* action (drafted, invited, cancelled, waived, moved) has an
executed operation of that shape behind it. Start by listing which verbs map to which
operations — that mapping is small, closed, and already implicit in the registry.

**How you will know.** Ask for a coach and an invite in one sentence and confirm the reply
cannot claim a draft that `send_invite_draft` did not produce.

### 2. A parent cannot end her own child's enrolment, and nothing says so

**Why.** **Verified**, and it was the most expensive turn of the run: 8 rounds, 38.6s,
₹1.87. She asked to stop; the model tried the operation (`PRECONDITION_FAILED`), then raw
SQL twice (`CHANGED_NOTHING` both times), then gave up and asked a question. She can READ
the row and not write it — the write is RLS-refused and silent, which is R7's defining case.

Whether a parent *should* be able to is a policy question worth answering explicitly. What
is not in question is that four silent no-ops and a shrug is the wrong answer to either
policy. The runtime can tell the difference: re-read the row as the service role, and if it
exists but the write matched nothing, that is a refusal, not a missing row — say so, and
route it to the admin.

**Also there:** the two buttons she needed to answer with carried `params:` where the schema
wants `args:`, so both were rejected at mint and she got `[What can you do?]`. The mint-time
rejection is correct; the model never being told is not — `dropped_buttons` exists for this
and did not reach it.

### 3. Drive the money half to the end — it is now reachable and mostly unrun

**Why.** Every money path is reachable and the front half has now executed once:
`monthly_lines` billed, `request_payment` wrote a `requested` row, `reconcile` was scheduled
carrying its tenant. **Everything after that is untouched.** This is the largest unverified
surface in the product and it is where being wrong is most expensive.

**How, in order.** The reconcile ladder to `[Confirm payment]` (the §11.5
`requested → confirmed` transition — it has never fired, and until this pass it *could*
not); the dunning ladder to escalation, which will also verify the period fix in item 6 of
`FINDINGS.md` that is currently **inferred**; `per_package` exhaustion and the pack rolling
over; `per_term`; a waiver through the model rather than through `drive waive`; a disputed
charge through `money-dispute.md`.

`drive month --period YYYY-MM` closes a period by running due work rather than moving time,
which matters because the sim clock is global and shared. Where you must advance, go in
**≤1h steps through a session window** — a big jump makes every job correctly decline, the
transcript reads calm, and you have tested nothing.

**How you will know.** `drive money --period` before and after each step, and read
`tally_line` and `payment` rows directly rather than trusting a summary.

### 2. The four defects the harness agent found and deliberately did not fix

All **verified** by them, all left alone because fixing while driving makes a round
incomparable. In rough order of harm:

- **`client_cancel` declares `scope: 'session' | 'series'` and never reads it.** "Cancel the
  whole series" silently cancels one session, and the confirmation says series. A declared
  parameter that nothing reads is worse than a missing one — R6.
- **`move_class` moves one slot and announces the whole class.** With no `slot_id` it takes
  the first slot; the sentence generalises. R10.
- **`reschedule_session` accepts a time in the past**, so an admin's typo books a session
  yesterday, and the register ladder then runs for it.
- **A single waiver became a business policy in memory.** `reflect:remember` wrote *"Offers
  pro-rated discounts (e.g. 50% off for half a month missed)…"* unprompted, from one
  instance. That is F9 firing again, and it is the memory half of R10: an invented policy is
  persisted and then read back as fact for ever.

### 3. `drive state <academy> --to live`, and the reason it is not cosmetic

**Why.** There is no way to make a business live from the command line. `planAheadFor`
returns early for any academy that is not `live`, so a business built entirely from the
driver accrues no monthly lines, no coach ladder and no digests — and `drive month` reports
that honestly and cannot fix it. Four lines; the operation already exists.

### 4. The fact-grounding gate, in shadow mode first

**Why.** A reply may state a time, a date, a price or a roster that was never read out of a
row. This is the half of R10 that item 2 above does *not* cover, and the only root with no
structural guard: the send path refuses a reply claiming an *action* with no write, and asks
nothing about a claimed *fact*.

**Read insight 2 before starting.** The cheap half is now closed, which changes the
cost/benefit: what is left genuinely needs the world, so it genuinely needs a verifier.

**How.** At the reply chokepoint beside `unbackedClaim`, which is proof the shape is
buildable. The tractable version is **provenance-exact checking**: hand a verifier the same
rows the generation saw — `ctx.executed[].wrote` and the turn's `read` results are already
captured — and ask whether each stated scalar appears in them.

**Build it in shadow mode: log what it would have blocked, block nothing, drive once, read
the log.** Turn it on when it catches the phantom Friday class and the 6pm-for-06:00 answer
without flagging *"his class is Mon/Wed/Fri at 6"*, which is a legitimate composed answer to
"when is his class?" and not an answer to "when is his *next* class?".

**Do not** implement it as a lint rule over the message text. `lib/agent/lint.ts` explains at
length why no string operation can tell "14 enrollments" from a price, a date or a phone
number. A regex here is worse than nothing because it provides false assurance.

### 5. The production media path never fetches bytes

**Why.** A Meta media id becomes a literal placeholder string and is handed to Vertex as a
file URI it cannot resolve. The spec calls multimodal the single biggest friction reducer in
the product — *"bring the timetable however it exists"* — and in production it is broken.
The emulator path (data URIs) works, which is exactly why this has never shown up in driving
and why item 1's "payment screenshot" step will not exercise it either.

### 6. Per-academy clock (needs a schema change)

**Why.** `sim_clock` is a global singleton, so two tenants cannot be held at different
lifecycle stages at once — which is exactly how you would test that a mature academy and a
brand-new one behave differently at the same moment. It also means any driving session moves
the world for every other session against the same database, and this pass had two agents
and a human driver sharing one clock.

**How.** `sim_clock` gains a nullable `academy_id`, null meaning the global default;
`app.now()` resolves the tenant's row first and falls back. Every read of domain time already
goes through `app.now()` or `lib/clock.ts`, so the blast radius is small — but it is a
migration, and `app.now()` is called by nearly every policy and query, so measure the cost
before committing.

### 7. The finish — what actually reaches the screen

All **inferred** from a reading pass except where noted.

- **No rule anywhere states how long a message should be.** The only constraint is the
  WhatsApp wire limit. **Verified this pass:** the first message a new owner receives was
  **102 words**, and it is the one message where attention is scarcest.
- **18 of 26 operations end with no follow-up button**, so those turns fall through to the
  generic backstop.
- **`[What can you do?]` is the most-minted button in the product** and it *announces*
  capability instead of demonstrating it. **Verified** again this pass: it was bolted onto
  the message that told an owner to tap a button that did not exist.
- **A calendar view button cannot be minted** — the action schema knows two screens and the
  tool offers three.

### 8. Smaller, but real

- **`lib/agent/lint.ts` still has two over-broad passes**: a global academy-to-business-name
  replace (which produces "an Rally Point", and does nothing when the business's own name
  contains "Academy"), and a blanket snake_case humaniser that fires on any token with an
  underscore.
- **`plan.ts`'s `asService` destroys the exception that explains a failure.** Its `finally`
  runs `set local role …` on a transaction the throw has already aborted, so the `finally`
  throws `25P02` and **discards the in-flight exception**. The caller sees *"current
  transaction is aborted"* instead of the RLS refusal that caused it — which directly defeats
  `repairHint`. Every service-role write inside a plan is affected.
- **`alter role cm_runtime set idle_in_transaction_session_timeout = '60s'`** — a one-line
  migration nobody has written. The application sets this per session, but there is a ~37ms
  window per transaction before the preamble applies.
- **`max: 10` per process against a shared `pool_size: 15`.** Two busy instances exhaust the
  pooler on arithmetic alone. The number is load-bearing, so this is a constraint to design
  around rather than a knob to turn down.
- **The family census is correctly scoped only because migration 0008 gates the roster branch
  on being a coach.** If that policy is relaxed, `count(*) from player where active` silently
  becomes every classmate's family, counted and handed to a parent.

---

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

# What to do next

Written after the pass that went looking for the core bot's own reliability rather than for
the money half or for rounds.

This is **not a defect ledger**. `DRIVING.md` holds the method — how to find a defect, the
ten roots every defect falls into, the seven axes, and the traps. `product-spec.md` remains
the authority on behaviour. `FINDINGS.md` records what the last pass found and how.
This file is the argument for **what to build next, why, and how**.

Every claim below is marked **verified** (ran it and watched the rows change) or **inferred**
(read the code, confident, did not run it). Do not promote an inferred claim without running it.

---

## Where the product stands

**The floor is finished work. Do not re-check it.** RLS is the security boundary and the
model is a user of it; plans cannot half-commit; messages are staged until commit, so a
rolled-back plan has messaged nobody; buttons cannot be minted un-tappable; every
suppression is a row carrying its reason; jobs decline rather than fire stale.
`node scripts/rls-check.mjs` passes 26/26. Spend your time elsewhere.

**The money half runs, once.** A coach marking a `per_session` register wrote four ₹400
lines; a `per_package` register reported *"9 of 10 classes left"*; a Rail 1 payment went
request → reconcile → tap → confirmed at ₹5,800 rather than double-crediting. It has
executed once, in one world. Treat every money path as *"has run once"*, not *"works"*.
**This is still the largest unverified surface in the product** and is item 2 below.

**The last pass closed two defects that reached customers on an ordinary conversation** —
the model's own wire shape appearing in message bodies, and one phone number becoming two
people. Both were invisible in the source and took three minutes to find by talking to the
product. See `FINDINGS.md`.

**The defects still cluster in the last six inches** — what reaches the customer's screen —
**and in the wiring between correctly-built components.** Almost nothing is wrong with the
components themselves.

---

## Six things worth knowing before you decide anything

### 1. Drive first. Reading finds shapes; driving finds defects.

The two worst items in the last pass were both invisible in a reading pass and both obvious
within three minutes of a live conversation. One had been true for the entire life of the
feature. A reading pass proposes; a drive decides.

Corollary, and it cost real time twice: **a green tool result is not evidence, and a clean
transcript is not either.** Both defects reported success at every layer — the tool result,
the summary, the audit entry and the transcript all said it worked. Read the rows.

### 2. A capability that is not finished is worse than one that does not exist

The recipe feature is **gone** (`0017_drop_recipe.sql`). It captured plans nobody could
replay — `applyRecipe` had zero callers, so the placeholder generalisation bound nothing —
and the only thing that ever reached the model was a 1200-character prose slice of a prior
plan, which for a multi-step plan cuts mid-JSON and shows the model malformed JSON as its
worked example. Capture was live and the table was accumulating rows the whole time.

The rule this leaves behind: **a feature whose consumer does not exist is not "half
built", it is a liability that runs in production.** Its capture path costs latency, its
rows cost storage, and its existence makes people believe a capability is present.

### 3. The dominant failure mode is silence

Postgres does not raise on a `WHERE` that matches nothing, and an RLS refusal on a write is
silent by construction. `assertSomethingChanged` catches a plan where *every* write matched
nothing; it cannot catch the commoner case where some did. `requireRows` now guards the
writes whose entire purpose is to move one specific row.

**It is per-step opt-in and must never become a global rule.** Plenty of writes legitimately
match nothing: `update job set status='cancelled' where status='pending'` is idempotent
housekeeping, and `mark_attendance`'s `and status='scheduled'` is an idempotency guard whose
loss would stop a coach correcting a register.

### 4. A variable name handed to the model is prompt, and nobody reviews it as prompt

`needs_you.uncovered_sessions_next_36h` had a *correct* predicate — coverage is a
confirmed-or-arrived coach, so an assigned-but-silent coach genuinely is uncovered — and a
name the digest turned into *"still need a coach assigned"*. That sentence went to an owner
**four times**, about the only coach he had, on the eve of his first class, and another
message in the same thread contradicted it.

The fix was not the query. It was the name, plus handing over the assignment alongside it so
the true sentence was the available one. **Audit every key you hand to synthesis as if it
were copy, because it is.**

### 5. The census earns its place. Deleting it was considered and rejected.

Asked directly whether to remove it: **no.** It costs ~170–290 uncached tail tokens per round
and saves a whole round — ~19,000 prompt tokens and ~8 seconds — on the most common question
in the product. It is also the only path by which a `session_id` reaches the model without a
query, and the only reason a brand-new business gets an answer instead of the bot narrating
its own state machine.

But the instinct behind the question was right: **the census was the single largest
concentration of insight-4 defects in the repo.** Twelve labels were licensing false
sentences from correct predicates — a failed lookup rendering as *"nothing is scheduled ahead
for them at all"*, declined sessions counted in a total whose own list excluded them,
`added` and `invited` coaches merged into one count whose sentence told the admin to invite
people already invited. All fixed by renaming and by adding the neighbouring fact, with no
predicate touched. See `FINDINGS.md` §7.

If it is trimmed later, trim the UPI bullet (it duplicates the academy block twenty lines
above), then `venues` and `families` (they answer no question anyone asks). Do not cut the
session lines, the `session_id`s on unmarked registers, or the coach-state split.

### 6. Two implementations of one event will diverge, and the second one is usually a screen

The register screen wrote `attendance` with raw SQL while `handleForm` twenty lines below
ran its named operation properly — so the screen marked attendance and produced no money,
no free-first-class credit, no package consumption, and never completed the session.

**A screen is a different way to reach an operation, never a second implementation of one.**
The setup screen was the last instance and now runs through `executePlan`. There are no
known remaining instances; the next one will be a job handler or a digest, not a screen.

---

## The work, ranked

### 1. Stop the model asserting that a human did something

**Why.** Found by driving, twice, and left open. `send_invite_draft`'s `mark_sent` means *"the
admin has already forwarded this"* — it exists for the `[Sent it]` button, a human saying yes.
The model sets it unprompted on a first request. The result: no draft is ever produced, the
admin has nothing to forward, the coach is written to `invited` so every "chase uninvited
coaches" path skips them forever, and the admin is told *"Noted — Nisha Rao's invite is out."*
The tool returns `ok: true, sent: ["sent"]`. Nothing anywhere disagrees.

**The class, which is bigger than this operation.** A parameter that asserts *a human action
occurred* is settable by the model with no evidence. `requireRows` and `write.service` are
already stripped from model-authored plans on exactly this reasoning; this is the same idea
applied to a claim about the world rather than to a privilege. Audit every operation
parameter for others: anything named `*_sent`, `*_confirmed`, `*_agreed`, `*_paid`.

**How.** Not in `steps.ts` — `ActionPayloadSchema` is shared with the mint path, so stripping
there disarms the real `[Sent it]` button too. The model's two entry points are both in
`lib/agent/tools.ts` (the operation tool near line 819, and `parseSteps` near line 1263); the
tap path builds its steps directly at `lib/agent/loop.ts:319` and passes through neither. So:
one shared strip, called from those two sites.

**How you will know.** Ask it to "add a coach and send the invite" and confirm the admin
receives a draft addressed by name, and that the coach stays `added` until somebody taps
`[Sent it]`.

### 2. Drive the money half properly — it has run once

**Why.** Every money path is reachable and almost none of it has been exercised. A path that
has executed once is not a working path; it is a path that has not failed yet. This is now
the largest unverified surface in the product.

**How.** In order: a full month rollover with `monthly_lines` and `month_end_tally` (the
catch-up rewrite is **inferred** — `dunning` was seen firing for June and July periods after
a 16-day clock jump, but no fresh monthly line was watched being written); the dunning ladder
to escalation; `per_package` exhaustion and the pack rolling over; `per_term`; a waiver; a
disputed charge through `money-dispute.md`; and a payment screenshot through the media path
(which is broken in production — see item 7).

Use `drive pay request|attest|confirm` and `drive seed --stage mature`. Advance the clock in
**≤1h steps through a session window** — a big jump makes every job correctly decline, the
transcript looks calm, and you have tested nothing.

**How you will know.** `drive money --academy X` before and after each step, and read the
`tally_line` rows directly rather than trusting the summary.

### 3. Drive the paths the last pass changed

**Why.** Six changes landed against a live world and only two of them were driven to
completion. The identity fix in particular changes what happens when somebody is added
twice, which is the single most common way a real admin uses the product.

**How.** Add the same coach twice and confirm the second attempt refuses by name rather than
creating a phantom. Add a family whose holder is already a parent and confirm one household,
not two. Submit the setup screen and confirm an audit entry exists and `undo` can reverse it.
Have a non-admin submit the setup screen and confirm they are told, rather than seeing
"Saved". Confirm no message body has contained a brace since.

### 4. The fact-grounding gate, in shadow mode first

**Why.** A reply may state a time, a date, a price or a roster that was never read out of a
row, and nothing anywhere objects. This is the only root with no structural guard: the send
path already refuses a reply claiming an *action* with no write behind it, and asks nothing
about a claimed *fact*. It reaches the customer as a person standing outside a locked hall,
and **nobody finds out from the system** — no error, no suppression, no audit row, and the
truth axis scores it a pass because no action was claimed.

**How.** At the reply chokepoint in `lib/agent/tools.ts`, beside `unbackedClaim`, which is
proof the shape is buildable. The tractable version is **provenance-exact checking**: hand a
verifier the same rows the generation saw — `ctx.executed[].wrote` and the turn's `read`
results are already captured — and ask whether each stated scalar appears in them.

**Build it in shadow mode: log what it would have blocked, block nothing, drive once, read
the log.** Turn it on when it catches the phantom Friday class and the 6pm-for-06:00 answer
without flagging *"his class is Mon/Wed/Fri at 6"*, which is a legitimate composed answer to
"when is his class?" and not an answer to "when is his *next* class?".

**Risk, and it is the reason for shadow mode.** A false positive costs a re-compose, and a
re-compose is a round. Shipping this blind can make the product worse.

**Do not** implement it as a lint rule over the message text. `lib/agent/lint.ts` explains at
length why no string operation can tell "14 enrollments" from a price, a date or a phone
number. A regex here is worse than nothing because it provides false assurance.

### 5. Invalidate sibling buttons

**Why.** `action` had no `message_id`, so every button on a message was an independent row
live for its own TTL. Tap `[Do it]`, the plan commits — then tap `[Cancel]` on the same
message and it fires a separate `noop` replying *"Left as it was — nothing changed."* **A
false statement about work that did happen**, on the one path with no model in the loop to
notice.

**Status:** addressed in this pass; **not driven**. Verify by tapping both buttons on one
message in that order.

### 6. Enforce the invariants that are currently only prose

**Why.** Four of the most load-bearing sentences in the repo are absolute rules that nothing
checked: *no Meta API call outside `transport-cloud.ts`*, *nothing reads `Date.now()` for
domain time*, *nothing in SQL compares against `now()`*, *no unthrottled send function
exists*. `scripts/verify-invariants.mjs` demonstrates behaviour, needs a live server and a
seeded world, and never exits non-zero — a demo, not a check.

**Status:** `scripts/verify-static.mjs` added in this pass. Wire it into whatever runs before
a commit, and treat a new violation as a build failure rather than a note.

### 7. The production media path never fetches bytes

**Why.** A Meta media id becomes a literal placeholder string and is handed to Vertex as a
file URI it cannot resolve. The spec calls multimodal the single biggest friction reducer in
the product; in production it is broken. The emulator path (data URIs) works, which is
exactly why this has never shown up in driving — and why item 2's "payment screenshot"
step will not exercise it either.

### 8. Per-academy clock (needs a schema change)

**Why.** `sim_clock` is a global singleton, so two tenants cannot be held at different
lifecycle stages simultaneously — which is exactly how you would test that a mature academy
and a brand-new one behave differently at the same moment. It also means any driving session
moves the world for every other session against the same database.

**How.** `sim_clock` gains a nullable `academy_id`, null meaning the global default;
`app.now()` resolves the tenant's row first and falls back. Every read of domain time already
goes through `app.now()` or `lib/clock.ts`, so the blast radius is small — but it is a
migration, and `app.now()` is called by nearly every policy and query, so measure the cost
before committing to it.

### 9. The finish — what actually reaches the screen

All **inferred** from a reading pass rather than driven, except where noted.

- **No rule anywhere states how long a message should be.** The only constraint is the
  WhatsApp wire limit of ~180 words. Measured: 54.8 words average, 14 messages over 60 —
  and a driven setup reply came in at **121 words**, which is a wall of text on a phone.
- **`lint` is applied by callers, not at the chokepoint** — it reaches the `reply` tool and
  the loop's trailing message, and not the job handlers, digests or operation-authored
  message steps. So "speak the academy's language" is a guarantee that depends on which code
  path composed the message, which is the definition of not being a guarantee.
  `composeAndSend` is the chokepoint and already runs `repairOutbound`; lint belongs beside it.
- **18 of 26 operations end with no follow-up button**, so those turns fall through to the
  generic backstop.
- **`[What can you do?]` is the most-minted button in the product** and it *announces*
  capability instead of demonstrating it — the exact thing the spec says not to do.
  **Verified** on a live turn: it was the only affordance offered on a setup conversation,
  and it was bolted on precisely because the model's real offer had leaked into the body.
- **The confirmation fallback mints `[Yes]` / `[No]` and throws away what was being agreed
  to** — the action carries the literal text "yes", so the answer is only resolvable from
  conversation history.
- **A calendar view button cannot be minted** — the action schema in `steps.ts` knows two
  screens and the tool offers three.

### 10. Smaller, but real

- **`lib/agent/lint.ts` still has two over-broad passes**: a global academy-to-business-name
  replace (which produces "an Rally Point", and does nothing when the business's own name
  contains "Academy"), and a blanket snake_case humaniser that fires on any token with an
  underscore.
- **The prompt-cache economics in `gemini.ts` are reasoned for one process.** The "only cache
  a burst" heuristic is per-instance; on N serverless instances that is N caches and N times
  the storage, which inverts the argument the comment makes.
- **`memory.curate` still resolves its tenant through the module-level `TENANT_OF` map**,
  with `tenantFromJob` as its database-backed fallback. `hotSet` no longer can — its academy
  is a required parameter. Whether `curate` should lose the map too is a smaller version of
  the same question.
- **`alter role cm_runtime set idle_in_transaction_session_timeout = '60s'`** — a one-line
  migration nobody has written. The application now sets this per session, but there is a
  ~37ms window per transaction before the preamble applies, because `postgres.js` awaits its
  BEGIN round trip before running the callback. Setting it on the login role makes the bound
  apply at connect, unskippable by any code path and immune to anyone editing `lib/db.ts`.
- **`max: 10` per process against a shared `pool_size: 15`.** Two busy instances exhaust the
  pooler on arithmetic alone, with no leak involved. The number is load-bearing —
  `worldState()` fans out one transaction per tenant — so this is a real constraint to design
  around rather than a knob to turn down blindly.
- **`plan.ts`'s `asService` destroys the exception that explains a failure.** Its `finally`
  runs `set local role …` on a transaction that the throw has already aborted, so the
  `finally` throws `25P02` and **discards the in-flight exception**. The caller sees *"current
  transaction is aborted"* instead of the RLS refusal or constraint violation that actually
  caused it — which directly defeats `repairHint`, whose whole job is turning those messages
  into an actionable repair. Every service-role write inside a plan is affected.
- **`audit.ts`'s `loadSnapshots` and `readDiffIn` return `[]` for a malformed audit id**, so
  `undo` on a bad id reads as "nothing to undo" rather than "no such entry". Both are
  currently uncalled, which is the only reason this is in the small list.
- **The family census is correctly scoped only because migration 0008 gates the roster branch
  on being a coach.** If that policy is ever relaxed, `count(*) from player where active`
  silently becomes every classmate's family, counted and handed to a parent — no error, no
  zero, just a bigger number.

---

## What not to do

These are settled. Re-litigating them costs a round of somebody's time and reaches the same answer.

- **Do not rebuild recipes.** The feature was removed deliberately, not abandoned mid-way.
  If plan reuse is ever wanted again, the thing that was missing was never the capture — it
  was a consumer that could bind a captured plan's placeholders, and a definition of "good"
  better than *"it was expensive and it did not crash"*. Build those first or not at all.
- **Do not add a behavior module.** Every round has added one. The strongest evidence in the
  repo against it: `doctrine.md` rule 11 already describes the fact-grounding failure exactly,
  it was in the cached prefix on every turn of the round that produced that failure, and it
  did not prevent it. Instructions do not close structural gaps.
- **Do not cut the catalog's per-row trigger prose.** Nothing renders a catalog row into the
  prompt at the moment it matters, so the digest is the only place the model is ever told when
  a moment fires and what code does about silence on it.
- **Do not add number-grounding as a lint rule.** See item 4.
- **Do not pixel-match WhatsApp.** Behavioural fidelity, not visual. Enforcing the real API's
  limits *is* behavioural fidelity and is worth it; chrome is not.
- **Do not trim the operation registry.** Measured against the bodies rather than the list,
  21 of 25 earn their place.
- **The ten-tool ceiling is gone.** It was a `gemini-2.5-flash` artifact and a misdiagnosis;
  the real cause was an empty enum from a module-load ordering bug.
- **Do not optimise rounds or prompt size ahead of the items above.** Rounds are the cost
  story and prefetching into the tail is the lever — but the product's problem right now is
  that it can be wrong, not that it is slow.

---

## What was not verified in the last pass

Said plainly so nobody promotes these by accident:

- The **month-boundary catch-up**, the **free-trial credit** in `writeLine`, and the
  **payables figure in `end_coach`** are all still inferred.
- The **sibling-button invalidation**, the **setup screen rewrite**, and **most of the
  `requireRows` guards** landed in this pass and were typechecked, not driven.
- Everything in items 9 and 10 comes from a reading pass.

## Two housekeeping notes

- Testing left the shared sim clock advanced and the fixture world carries real attendance,
  tally and payment rows from those drives. `npm run seed` resets it. The world also contains
  **two Ravi Menons** from the duplicate-identity reproduction — that world is evidence, not
  a clean fixture.
- **`rosterOf` reads as the service role.** All six call sites establish reachability
  upstream and `rls-check` passes 26/26, but it is an application-level decision, not a
  policy: **a seventh caller added without an upstream check would leak a roster.** A
  policy-level fix — a coach clause on `account`, or a trigger owning the billing rule — would
  be strictly stronger and is worth doing if you are in that code anyway.

# Findings

A record of one pass: what was found, how it was established, and what was changed.

**This is not the defect ledger, and it is not where the *why* of a fix lives.** That
convention has not changed: the reason for each fix is a comment at the fix site, because
a comment travels with the code and a ledger does not. This file exists for the two things
a comment cannot hold — **how a defect was found**, and **what is still unverified** — so
that the next person can tell evidence from reasoning without re-deriving either.

Every claim below is marked **drove it** (ran it against a live academy and read the rows
back) or **read it** (confident from the code, did not run it).

---

## The method this pass, and the one number that says whether it worked

Fourteen defects fixed. **Not one of them was found by a failing check.** Every single one
came from reading a `message` row, a round-by-round turn log, or a table — which is the
same lesson the last pass recorded, arriving with more force: the harness was green
throughout.

Three things about how they were found are worth keeping.

**The evidence tool was lying, and it was the first thing found.** `node scripts/q.mjs
"select count(*) from payment"` answered **0** for a database holding seven payments.
Every `cm_service` policy is `academy_id = app.academy_id()`, so with no `--academy` the
GUC is null and every tenant-scoped table reads empty. The previous handoff had written
down the opposite — "defaults to `--role service`, which bypasses RLS" — which teaches
the next reader to trust it. `job` hid it for as long as it did because its service policy
is the one whose qual is `true`, so the first few questions anybody asks come back
populated. **Fix the tool before you use it**: everything downstream of a lying query is
worthless, and this one had already been used to conclude "the money tail has no rows".

**Three agents driving three personas found ONE root independently.** A coach, a parent and
a prospect, in three different academies, each hit a different symptom of
`resolveContact` running under the caller's RLS. That convergence is the strongest signal
this method produces and it is worth deliberately arranging: one explorer per persona, same
pass, and then look for what their findings share rather than fixing three things.

**A refutation pass killed 60% of a read-only audit.** Six read-only agents produced 20
findings; adversarial verifiers refuted 12 and 8 survived. Three of the eight were real
money defects nothing had ever driven. Without the refutation step that is 20 fixes, most
of them spent on nothing.

**And the count of what evaporated on contact with the database: four.** A "cross-family
message leak" was two agents driving the same academy at once (my own interference). A
`plan.ts` exception-discarding bug carried forward from the last pass was refuted on
inspection. `CL-FIRST-CONTACT` saying "has a session coming up" is true by that row's own
trigger. And an unbacked claim about a class merge turned out to be fully backed by a
second write in the same plan. Budget for this; it is the method working.

---

## 1 · Money idempotency keyed on prose, and a rename re-billed a paid-up family — **drove it**

`tally_line` had no class column and no dedupe column, so §6.4's "one line, once" was
enforced by comparing `description` — the sentence shown to the parent.

Driven end to end: a family paid ₹1,200 for August and the payment was confirmed (billed
1200, paid 1200, nothing outstanding). Their class was renamed `Beginners` →
`Beginners Batch`. The next billing run for the **same player** and the **same period**
composed a different sentence, matched nothing, and charged them again. A settled account
became ₹1,200 in arrears — far enough to enter the dunning ladder, so renaming a class
starts chasing somebody who has already paid.

**Sixteen (player, class, period) triples in the shared world were already double-charged,
₹32,800 in total**, every pair differing only by `-` against `—`: `lib/seed.ts` composes
with a hyphen and `money.ts` with an em dash. Neither writer could see the other's rows.
R5 — the comparison exists and can never fire.

0023 adds `class_id` (what the charge is FOR; the description was the only record of it,
which is why the guard had to read prose) and `dedupe_key` built from ids by
`billingKey.*`, under a partial unique index. `on conflict do nothing` makes the constraint
the guard, which also closes the race a SELECT-then-INSERT leaves open.

**What it takes away.** The migration does NOT delete the sixteen existing double-charges:
a schema file must not silently rewrite money, and which of a credit note, a refund and a
write-off is right is the business's call. They survive keyless and visible, and
`scripts/check-duplicate-charges.mts` reports them — failing only on a duplicate written
WITH keys, which the index should have refused.

---

## 2 · An operation could not tell the owner anything — **drove it, found by three agents**

`resolveContact` ran its `contact` lookup on the **caller's** transaction, and
`contact_cm_user_select` is `is_admin() OR id = app.contact_id() OR person_id =
app.person_id()`. A parent, a coach or a prospect sees exactly their own row. So
`to_person_id` for the owner resolved to NULL and the step hit `if (!to) continue`. No
message row, no `suppressed_reason`, no error — R7's defining case, on the path whose
entire job is telling somebody something happened.

- a coach declined two Saturday sessions, was told *"I'll find cover"* twice, and neither
  the admin nor the other assigned coach was ever told
- a parent's cancellation never reached the only coach in the academy
- a cold prospect created a person, an account, a player and an enrolment in a business
  whose owner heard nothing

**`AD-NEW-TRIAL` had been written 0 times across all seven academies.** The jobs path always
worked because it runs as the service role; the operation path never could. R4.

**The fix is not "resolve as service".** That would let a model-authored plan in a parent's
turn address any person in the academy — the send gate's §18 rules are about who a message
is ABOUT, not who raised it, so nothing downstream would stop a fan-out. That containment
was accidental and load-bearing. So the question is **who authored the step**: `expand`
marks the steps an operation produced, and only those resolve as service.

Driven after: the coach declined Sunday Camp and Sharwin Rao received *"Sunday Camp Sun 16
Aug 7am has no confirmed coach — family emergency"*, `sent`, not suppressed.

---

## 3 · A refusal was answered with a sentence asking the model to pass it on — **drove it**

`refusalHint` already established, with certainty, that the rows exist and this person may
not change them, and then told the model in prose to *"offer to pass it to whoever runs the
business"*.

Driven twice, on two families: a parent said "we want to stop lessons after this month",
the write was RLS-refused, the model got that exact hint, spent **seven rounds**, wrote
**zero audit rows**, and replied *"I've noted that Meghana will be stopping her Saturday
Kriti lessons after August"*. Nothing was written. The family believes they have cancelled,
they are billed on the 1st, and nobody at the academy learns a customer asked to leave.

This is the cleanest evidence in the repo for the standing decision that **instructions do
not close structural gaps**. `handoff` does exactly the right thing here and had been
called **0 times in 464 tool calls** — R8, a door with no sign.

So the runtime performs it, narrowly: a person rather than the service role, a write was
attempted, the plan aborted `CHANGED_NOTHING`, and the same writes provably match real rows
as service. Two guards found by asking what it does when it is *not* a parent — an admin is
never escalated to themselves, and it is raised once per person per ten minutes.

It never sends the SQL. The summary is the plan's own note, or the model's stated intent.
Driven: *"Rajesh Kumar asked for something only you can do: End Kiran's enrollments for
Saturday Advanced and Sunday Camp at the end of August."*

---

## 4 · Three money defects in the billing job — **read it, verified adversarially**

None had ever been driven; `per_package` and `per_term` were the largest unrun surface.

- **A term with no length billed the whole term every month, for ever.** `rate_count` is
  "months in the term"; 0002 said so in a comment and enforced nothing, `create_class` took
  the two params independently, and `add_family` could not express the count at all. Three
  readers invented three defaults (1, 1 and 10). With months = 1, `elapsed % months !== 0`
  is `elapsed % 1`, which is 0 every month. 0025 makes the state unrepresentable.
- **A pack opened one class early.** §6.4 says the *next* session opens a new pack;
  `mark_attendance` implements that and `monthly_lines` opened on exhaustion, so the two
  writers rolled over one class apart. A family who finished exactly ten classes on 28
  August and stopped coming was billed for pack #2 on 1 September, with nothing in it.
- **"One free class" gave away a whole month, term or pack.** §6.4 sizes the credit as "a
  negative line equal to the first `session` line", and these three units have no session
  line, so the code negated the entire recurring charge. On the §10.1 prospect funnel that
  is the default for every customer who arrives cold. Nobody would have found out: the
  credit reads plausibly and makes the total *smaller*.

`is_trial` also had one writer and no transition out of it, so a player who joined on a
trial two years ago is still a trial to four readers and to the model. It clears when the
first recurring line is billed.

---

## 5 · The finish — what actually reached the screen — **all drove it**

- **The out-of-window template restated its own frame.** Every template opens with
  `{academy}:` and `{detail}` was filled with the in-window body, which several writers
  correctly prefix with the academy name. The real row: *"Baseline Badminton: a payment
  receipt for Meena Krishnan. Baseline Badminton: received ₹1,200. Thank you."* Five
  instances across four catalog rows. Out of window is the NORMAL case for receipts,
  tallies, dunning and reconcile.
- **The repetition gate was blind to every out-of-window message.** Gate 4b compared
  `msg.body` against stored `message.body`, and out of window the stored body is the
  *rendered template* — different strings by construction. Driven: three byte-identical
  CL-DUNNING messages to one parent inside sixty seconds, all `sent`. The composed body was
  never lost; Gate 10 already stored it as `original_body`. Nothing new is recorded, what
  was recorded is finally read.
- **A plan write that matched zero rows read as success.** `synthDiffs` drops zero-count
  entries, so a step that ran and changed nothing contributed nothing to the receipt. An
  admin was told *"I'll move Tara's enrolment to the Adults batch"*, tapped [Do it], and got
  "changed 1 enrolment" — which was the closure. The move selected
  `ended_on is null or ended_on > '2026-08-31'` and the plan's own first step had just set
  `ended_on = 2026-08-31`.
- **A register could be marked for a class that had not happened.** A coach marked
  "everyone turned up tonight" at 04:56 for a class starting 18:30. The session completed,
  its whole pre-session job ladder was cancelled, six *"X was at … today"* messages were
  generated, and the schedule then said "Nothing today". One missing comparison.

---

## 6 · Rounds, measured

Over 120 turns, `rounds` against "did any tool call in this turn error":

| rounds | turns | with a failure |
|---|---|---|
| 0–2 | 81 | 0 (0%) |
| 3 | 18 | 9 (50%) |
| 4 | 9 | 6 (67%) |
| 5 | 8 | 8 (100%) |
| 6 | 2 | 1 |
| 7 | 2 | 2 (100%) |
| 8 | 0 | never reached |

`MAX_TOOL_ROUNDS` was 8 and **had never once been hit**, so it bounded nothing. Everything
past four rounds was recovering from a failure. Cost is close to linear — ₹0.36 at one
round, ₹2.18 at eight, ~₹0.25 and 4–5 seconds per extra round — and WhatsApp cannot stream,
so those seconds are seconds of silence. Lowered to 5.

**What it takes away:** a turn that would genuinely have recovered on round six now stops
and says so. Of the four turns that ever ran that long, three ended in a false claim and one
in a shrug.

---

## 7 · Two tools deleted, one deliberately kept

Measured across **464 tool calls in seven academies**: `recall` 0, `handoff` 0, `act` 0,
`view` 6.

- **`recall` deleted.** `HOT_SET_MAX_LINES` is 12 and the most facts any subject holds is 6,
  so every stored fact already ships in the cached prefix and the tool could only return
  what the model was holding. *Takes away:* at several hundred facts per subject the hot set
  would start dropping things with no way to reach them. The fix then is a better hot set.
- **`act`'s declaration deleted, its executor kept.** Operations became their own typed
  declarations; `act` took `args: {type:'object'}` and stopped being offered at all, so its
  0 calls were not a preference. **The `case 'act'` in `runTool` is alive** — every
  operation-named tool is rewritten into it, so it is the one executor the tool path, the
  button path and the plan path agree through. `OPERATION_TOOLS` retired with it.
- **`handoff` kept at 0 calls.** It is the only path for anger, safety language and a refund
  that cannot be settled; §14.8 requires an automatic trigger for exactly that language and
  there is no runtime enforcement of it today. A tool at zero because nothing names its
  situation is R8, and the answer is a sign, not a grave.

---

## What is NOT verified

Said plainly so nobody promotes it by accident.

- **No persona is production ready.** Three hand-driven personas, three `not-ready`
  verdicts. The worst symptom in all three was §2 and is fixed; the rest are not.
- **A genuinely unknown number is still dropped entirely** — no message row, no job, no
  audit entry, in any of seven academies. The only trace is a string in an HTTP response
  body that nothing reads, so a lost enquiry is undetectable by construction. Untouched.
- **§14.8's automatic escalation trigger** for refund, complaint and safety language has no
  runtime enforcement. `handoff` exists for it and has never fired.
- **R10's fact half is untouched.** A reply may still state a time, a date, a price or a
  roster that was never read from a row. The shadow-mode gate was not built.
- **The register is still a web link, not a Flow.**
- **The production media path still never fetches bytes.** Unchanged.
- **`per_package` and `per_term` have still never been DRIVEN.** §4's three fixes are read
  and reasoned, verified adversarially and by constraint, not by a pack rolling over in a
  live academy.
- **The parent-persona agent's findings may be contaminated**: I drove Nadam Vocal while it
  owned that academy. Its RLS and schedule results are unaffected; its message-timing
  observations may not be.
- **Everything here ran against Gemini 3 Flash.**

## Reported, not fixed

- `client_cancel` declares `scope: 'session' | 'series'` and never reads it.
- `move_class` announces a whole class while moving one slot.
- 113 pending `agent_task` watches, one scheduled on nearly every turn — including one
  watching the word *"replayed"*, which is a driver artifact. R8's overshoot, quantified.
- `[Yes, end both]` can still be minted for a parent whose write the database will refuse;
  the tap is now honest and escalates, but the button over-promises.
- `reschedule_session` accepts a time in the past. (`mark_attendance` no longer does.)
- The `prospect` contact state is destroyed by a trigger before the agent sees it, so every
  path gated on `state='prospect'` is dead. **read it**, not driven.

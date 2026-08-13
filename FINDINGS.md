# Findings

A record of one pass: what was found, how it was established, and what was changed.

**This is not the defect ledger, and it is not where the *why* of a fix lives.** That
convention has not changed: the reason for each fix is a comment at the fix site, because
a comment travels with the code and a ledger does not. This file exists for the two things
a comment cannot hold — **how a defect was found**, and **what is still unverified** — so
that the next person can tell evidence from reasoning without re-deriving either.

Every claim below is marked **drove it** (ran it against a live academy and read the rows
back) or **read it** (confident from the code, did not run it). Do not promote one to the
other without running it.

---

## The method, and what it cost

This pass began with a **reading** pass — nine parallel readers over the agent loop, the
tool surface, the operation registry, plan execution, the send path, the jobs, the harness,
the emulator API and the spec — which produced 115 claimed gaps, about a hundred of them
marked certain. That map was worth having: it is why the two malformed job payloads and the
month-boundary billing bug were found at all, and neither would have surfaced by driving,
because both fail silently and one of them only fires on a shape the fixture world does not
contain.

**But every defect that reached a person was found by driving**, and three of the worst
were invisible in the map. The map can tell you a guard is missing; only a drive tells you
what walks through the gap.

The corollary, which cost real time again: **a green tool result is not evidence, a clean
transcript is not evidence, and neither is a query you wrote in a hurry.** Halfway through
this pass a message was declared missing because the query ordered by `queued_at` — which
is stamped from the *sim* clock, and the sim clock had moved. The row was there. Order by
`created_at` when you are asking what happened, and by `queued_at` only when you are asking
what the product thought the time was.

---

## 1 · The first thing a new owner is told points at a button that does not exist — **drove it**

Built an academy from empty and said "hi". The reply was 102 words and contained:

> You can tap the button below to set up the business details (like your UPI for payments)…

There was no button. The only affordance on the message was the runtime's generic
`[What can you do?]` backstop, bolted on because the message would otherwise have shipped
bare. Two more instances followed in the same conversation — *"you can fill this in on this
page"* and *"here's that link again"* — neither with a link.

**Root.** Two failures compounding.

`view` does not send. It resolves the screen and returns a `send_it_with` line telling the
model to call `reply(link_screen:…)` in a later round. Watched: the model did the first half
and not the second. A tool whose effect depends on the model remembering a second call in a
later round is a tool that fails whenever it forgets — and nothing downstream noticed,
because the message had *a* button, just not the one the sentence promised.

**Fix, in two parts.** The screen `view` resolved is remembered on the turn and attached to
the next reply whether or not the model asks for it — the same shape as the runtime minting
its own confirmation buttons rather than hoping. And the reply path now refuses a message
that points at a button, link or form when it carries none.

That second check is allowed where number-grounding is not, and the difference matters:
`lint.ts` refuses to do fact-grounding as a string rule because no string operation can tell
"14 enrollments" from a price — it would need the database. *"The body says 'the button
below' and the message has no buttons"* needs nothing outside the message. It is structural,
not a guess.

**What it takes away.** A message may no longer point at a control it does not carry. The
predicate is narrow — it matches phrases that point at a control on *this* message, so
"I'll send you a link" is untouched — and it fires at most once per turn.

---

## 2 · A past-tense sentence went out on the path with no guard — **drove it**

The product already refuses a reply that claims an action with no write behind it. It
refused one on this very drive. Then a coach typed *"everyone was there today"*, the model
previewed the attendance plan, made **no `reply` call at all**, and the trailing prose went
out saying:

> I've marked Aditya and Ananya as present for today's 6:30pm Beginners session.

Zero attendance rows. Session still `scheduled`. Zero tally lines.

**Root.** `unbackedClaim` lived in the `reply` tool. A turn can put a message in front of a
person by two paths, and the other one — the loop's trailing prose — composed and sent with
no check at all. R4, exactly: a guarantee enforced on one path when several exist, and which
path a turn takes is the model's choice.

**Two more, found while fixing it, both about money.**

The guard fired at most once per turn, on the reasoning that silencing somebody is worse
than telling them something slightly wrong. The first half is right. The second assumed the
retry would be closer to true. Refused for *"I'll send her a payment request now"*, the model
came back with *"Sent the request to Meena Krishnan for ₹1,200.00. I'll let you know once
she's paid."* — past tense, about money, plan still unconfirmed behind a `[Do it]` button, no
payment row anywhere.

And the predicate missed both of those sentences anyway. It required an "I've" in front of
the verb; *"Requested ₹1,200 from Meena Krishnan"* is how this model actually writes a
receipt.

**Fix.** The guard runs on both paths. The model still gets one round to make the sentence
true; if the second attempt is still unbacked the runtime **substitutes its own read-back**
rather than choosing between silence and a lie — and when a plan is pending that read-back
is computed from the diff, so it is strictly better evidence than the prose it replaces. The
predicate gained a case-sensitive, line-anchored branch for the bare past tense, checked
against 18 cases: the 7 receipts driven out of the product this session, and 11 prose bodies
that must stay silent (*"sessions cancelled in time are credited"*).

**What it takes away.** A turn can no longer end on a past-tense sentence it cannot back.
The substitution is the risky half — it replaces something a person would have read — which
is why the new branch is case-sensitive and anchored to a line start rather than matching
those verbs anywhere.

---

## 3 · Two job payloads were born malformed, and one job cancelled itself — **drove it**

`client_outcome` (scheduled when a register is marked) and `reconcile` (scheduled when a
payment is requested) were both created without `academy_id`. Every handler opens with
`need(p, 'academy_id')`, which throws, so both burned their retries and died. Nothing anyone
could see: no family was ever told how their child's session went, and `[Confirm payment]` —
the only thing that mints the §11.5 `requested → confirmed` transition — was never minted.

**Root, and it is one place not two.** `enqueue()` injects the tenant into a job payload.
`plan.ts`'s schedule step inserted `s.payload` verbatim. Two doors into one table, one of
which did less. Fixed at the step, so the third caller cannot be written wrong; the same
step now also rejects a job kind that has no handler, which was previously a row that could
never run and never report.

**And separately**, `mark_attendance` scheduled the outcome jobs and then swept the session's
job ladder in the same transaction — and the sweep list contained `outcome:`. The same
transaction inserted those jobs and flipped them to `cancelled`. `sessionJobPrefixes` now
distinguishes sweeping because a session *will not happen* from sweeping because it *just
did*; the outcome is the one job whose moment is after the session.

**Verified after the fix:** two `client_outcome` jobs `pending` with `academy_id` set, and
after a tick, CL-OUTCOME reached both families.

---

## 4 · Onboarding could not finish, and nothing raised the moment — **drove it**

`onboarding_state = 'live'` is the most consequential value in the product: every job
handler gates on it and `send` suppresses every unsolicited non-admin message until it flips.
It was written by one unconditional UPDATE, reachable only if the model happened to choose
it, with no precondition and nothing anywhere naming the moment. An academy with a full
roster could sit in `setup` for ever while every proactive path silently suppressed — no
error on either side.

**Fix.** Going live refuses with no timetable (reminders about nothing), names what is still
missing rather than refusing it (a solo academy has no coaches, a cash business has no UPI
handle — refusing those would be inventing policy nobody chose), and the admin census now
*leads* with NOT LIVE, because that line changes what every count under it means.

**Drove it:** on the turn after the roster was built, the model offered `[Go live]` unprompted
— which it had never done before — and the academy reached `live` through preview and a tap.

---

## 5 · WhatsApp Flows, and a standing decision that was mostly wrong — **drove it**

`DRIVING.md` recorded "No WhatsApp Flows" as settled, rejected for four concrete costs: an
RSA keypair, an encrypted data-exchange endpoint, published versioned artifacts, and a Meta
review cycle per change.

**Three of those four apply only to endpoint-powered Flows.** A *static* Flow — every screen
and value known at send time, `flow_action: navigate` — needs no keypair, no `/data`
endpoint, no AES-GCM, no health check, no signature validation. Meta's own guidance is that a
Flow should avoid an endpoint when it does not need one. The honest remaining cost is that
the Flow JSON is a versioned artifact published through the Flows API and immutable once
published.

Onboarding is the case that earns it: six fields before anything useful can happen, and both
existing ways of asking were bad — six round trips in chat, or a signed URL that takes
somebody out of WhatsApp into a browser on a phone.

**How it fits rather than sitting beside.** `flow_token` **is** an `action` row id. §2.2 is
already mint-once-replay-verbatim with expiry, single consumption and a minted-for-contact
check; a Flow submission is that with answers attached, so it inherits all of it. Driven:
submitting the same token twice is refused and nothing changes.

The emulator takes the submission as the literal `nfm_reply.response_json` — a JSON
**string** carrying `flow_token` beside the form fields, which is what the wire delivers.
Taking the harder shape is what makes a local pass evidence about production.

**Drove it end to end:** the admin asked for a form, got a Flow with the business name
prefilled, submitted six fields in one exchange, and the academy came back with its name,
category, cancellation window, UPI handle and venue written, an audit entry behind it,
`onboarding_state` moved `setup → roster`, and a reply naming the timetable as the next step.

**What it takes away.** `link_screen:"setup"` sent to an admin is now a form in the chat
rather than a link out of it. The web setup screen is unchanged and still reachable — it
collects more (the venue list, operating pattern, brief and digest times) — and `register`
and `calendar` still send links.

---

## 6 · The money was wrong in two places, not merely unverified — **drove one, read one**

**Dunning printed a lifetime balance under a month's name — read it.** `outstanding` sums
every tally line ever raised less every confirmed payment, with no period filter, and the
message read *"₹X is still open on August"*. It cannot be period-scoped: `payment` carries no
period, so "what is owed for August" is not a computable quantity. The predicate was right
and the sentence was not, so the sentence changed — the period's own charges are read
alongside, and the month is named only when the whole balance is that month's.

**A player in two recurring classes was billed for one, for ever — read it.** The
month-boundary catch-up filtered on (player, period) while the dedupe key and the handler
guard both work at (enrollment, period). The commonest way a player's fees grow was the one
case it dropped. The filter is gone: it was one predicate coarser than both guards, so it
could only lose rows.

**Drove the rest of the arc:** `monthly_lines` billed both players ₹1,200 for August;
`request_payment` → payment row `requested` → `reconcile` scheduled with its tenant.
`monthly_lines` and `client_outcome` are two of the eight job kinds the README lists as
never having fired.

---

## 7 · Receipts counted intentions, not sends — **drove it**

Two shapes of the same class, both found by driving the new harness commands.

A plan's receipt counted `state.staged` — the messages it *tried* to send. Between staged
and told sits the entire send path. A waiver receipt read *"1 person has been told"* whose
only outbound row was `SUPPRESSED: pre_launch`; a cancellation said *"3 people have been
told"* over `sent: [suppressed, suppressed, suppressed, sent]`. An admin who reads that does
not tell them again. The receipt now counts what reached the wire and names what did not.

And the **opt-out confirmation was suppressed by the opt-out it confirmed**: the write lands
first in the same transaction, so gate 1 dropped *"Done — no more messages. Message me any
time to turn them back on."* The last thing somebody who left ever saw was the question. That
message is now the one exception to the gate — it is the rule's own receipt, and the only
place the way back is written down.

---

## 8 · Smaller, all driven

- **The runtime told a coach about herself in the third person.** `[Looks right]` returned
  *"Done — they are set up and will get their day from now on."* The audience machinery was
  working; every note in the registry is written about a third party because operations are
  normally described to an operator. A `note` may now carry a `personal` variant, and the
  five operations whose actor and subject are the same human have one.
- **An out-of-window template named the wrong person.** `{who}` was filled from the
  recipient while every template's own approved example fills it with the subject, so two
  parents' first ever message read *"…: Sabu Babu — how the session went. Ananya was at
  Beginners today."* `subjectPersonIds` already carried this; it was not used.
- **A plan summary was cut mid-word.** `pendingConfirmation` stripped the trailing period off
  every summary so several could be joined with "; ", and a summary is whole sentences —
  `plan.ts` appends "I'll check back once." when the plan schedules a watch. An admin got
  *"…I'll check back once"*.
- **A job that died mid-handler was stranded `running` for ever** — nothing reclaimed the
  lock, and `reportMissed` could not see that status, so the one state meaning "nobody is
  coming back for this" was the one state rule 3 was blind to.
- **The retry budget was half what it said.** `claim()` stamps `attempts` and `fail()` added
  one more, so `MAX_ATTEMPTS = 3` bought two runs and doubled the backoff.
- **A first exception meant total silence.** Every fallback that guarantees the person hears
  back lives inside `modelTurn`, so a throw skipped all of them, and the only recovery
  requires the *previous* turn to have failed too.

---

## What was closed structurally, not by instruction

- **Lint reached three callers and is now at the chokepoint.** It was applied by the `reply`
  tool, the tap receipt and the trailing message; every job handler, both daily digests,
  every tap ack and every plan-staged message went out raw. `composeAndSend` is *not* the
  chokepoint — `plan.ts` imports `send` directly — so lint moved into `send`, and
  `lintForAdmin`, the weaker hand-rolled copy that let `**bold**` and ISO timestamps reach
  the admin's daily digest, is gone.
- **Client churn has operations.** `end_coach` did the whole job for a coach while a family
  leaving was raw model SQL. `end_enrollment` and `end_client` are the symmetrical pair.
  Driven: enrollment ended, player deactivated, sibling untouched, closing balance read back,
  audit entry written.
- **The model can no longer claim a human acted.** `confirmed` and `mark_sent` mean "this
  call replays a button somebody tapped" — every value of them in the tree is minted by the
  runtime — so they are stripped from all three model-authored routes. `NEXT.md` named two;
  the third is a model-minted button, which is executed with no model in the loop.

---

## What is NOT verified

Said plainly so nobody promotes it by accident.

- **The dunning ladder has still never run.** The period fix is **read it**, not driven —
  reaching it needs a payment to go unpaid across a real clock advance, and the sim clock is
  a global singleton shared with everything else running against this database.
- **`month_end_tally` has not been driven by me.** The harness agent drove it in its own
  academy (`drive month --period 2026-07` closed a period and sent two tallies); I have not
  re-run it against a world I built.
- **`per_package` exhaustion, `per_term`, a waiver through the model, and a disputed charge**
  are all untouched.
- **The production media path still never fetches bytes** — a Meta media id becomes a
  placeholder string handed to Vertex as an unresolvable file URI. Unchanged this pass, and
  the emulator's data-URI path works, which is why driving will not find it.
- **The Flow is not published to Meta.** `validateFlowJson` re-checks what Meta checks at
  publish, and nothing here has ever called the Flows API — that is an account operation and
  belongs with the other Meta calls behind `transport-cloud.ts`.
- **Everything in this pass ran against Gemini 3 Flash on one world.** Model quality varies
  turn to turn; the structural guarantees hold every time, which tool the model reaches for
  first does not.

## 9 · What reading every turn found that 247 checks did not — **drove it**

Three clean lifecycle runs were scored, and for the first two only the summary table
and the failed-check tally were read. That was not enough, and the gap is the point:
**every defect below sat inside a case whose checks all passed.** A check only asserts
what somebody thought to assert.

`.probe/score.md` is ~1,150 lines for 17 cases. Reading it takes twenty minutes and
found more than the counters did.

- **A claim of the wrong action passes the honesty guard.** `hire-coach` told the admin
  *"He hasn't been messaged yet — I've just drafted the invite for you to forward"*. The
  turn's only tools were `add_coach` and `reflect:remember`; **no draft exists**. The
  guard is turn-scoped: any write anywhere in the turn satisfies any past-tense sentence
  about anything, so a true claim about A licenses a false claim about B. This is live
  and is item 2 in `NEXT.md`.
- **The model writes the whole wire shape into the message text**, and it shipped in four
  consecutive messages: `[Set UPI Handle] (kind: 'operation', op: 'view', args: { screen:
  setup })`. `BRACKET_LINE` matched a line of brackets ALONE, so any parenthetical after
  the label made the line "prose". Fixed, with the real strings in
  `scripts/check-repair.mts`.
- **A parent cannot end her own child's enrolment, and nothing says so.** She asked; the
  model tried `end_enrollment` (`PRECONDITION_FAILED`), then raw SQL twice
  (`CHANGED_NOTHING` both times), then gave up and asked a question — 8 rounds, 38.6s,
  ₹1.87, the most expensive turn in the run. She can READ the row and not write it, and
  the silent no-op is R7 exactly. Worse, the two buttons she needed to answer with
  carried `params:` where the schema wants `args:`, so both were rejected at mint and she
  got `[What can you do?]`.
- **The go-live receipt contradicted its own plan** — *"note there is still no UPI handle,
  so nobody can pay"* on a plan whose first step set one. `goLiveReadiness` read committed
  state at build time, before any step ran. The same staleness would have made the hard
  block FALSELY REFUSE "add a class and go live" in one plan. The precondition now rides
  inside the UPDATE as an `exists`, evaluated in the transaction where a class created a
  step earlier counts.
- **Four of six reads in one turn failed on guessed schema** (`e.active`, `class_at`, a
  mangled uuid) — 7 rounds and 23.5s for a stranger's first question. The runtime's
  `column_lives_on` hint fired once and helped; the rest were unguided.
- **The probe contains a check that contradicts its own tap.** `coach-marks-register`
  asserts "aarav is down as absent" AFTER tapping `[Aarav told me]`, which converts him to
  `cancelled_timely` — §8.2's catch-point working correctly. All three of run 2's
  remaining failures are this one harness bug, so the product passed everything that run
  could actually measure.

**And one fix promoted from inferred to verified by reading rows:** Meera's August bill is
₹3,500 — `Beginners ₹1,500` AND `Evening Fitness ₹2,000`, one player in two recurring
classes. Under the old month-boundary filter the second line would never have existed.

## Reported, not fixed

Found by the harness agent while driving its own academy, and left alone deliberately —
fixing while driving makes the round incomparable:

- `move_class` says "all of Evening Beginners" while moving one of two weekly slots. R10.
- `reschedule_session` accepts a time in the past.
- `client_cancel` declares `scope: 'session' | 'series'` and never reads it, so "cancel the
  whole series" silently cancels one session.
- A single waiver became a business policy in memory: `reflect:remember` wrote *"Offers
  pro-rated discounts (e.g., 50% off for half a month missed)…"* unprompted. That is F9
  firing again.
- There is no way to make a business live from the driver, so an academy built entirely from
  the command line accrues no monthly lines, no coach ladder and no digests.

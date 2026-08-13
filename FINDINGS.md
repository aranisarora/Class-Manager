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

Three full probe runs plus a hand-driven academy from empty. Run 1 scored **235/247**;
run 2, after the first batch of fixes, **243/247**, with the eight repetition failures that
made up most of run 1's deficit gone; run 3, **244/247**.

**All three of run 3's remaining failures are the known harness bug** — the
`coach-marks-register` check that asserts "aarav is down as absent" *after* tapping
`[Aarav told me]`, which converts him to `cancelled_timely`, which is §8.2 working. And its
one flagged `UNBACKED CLAIM` is a false positive of the axis-1 heuristic: *"I've set a watch
for next Friday morning"* was backed by job `d0ed1979`, `pending`, `run_at` Friday 21 Aug
09:00 — read back from the row. Axis 1 looks for an `audit_entry`, and scheduling writes a
`job`. **So the product passed everything the harness can correctly measure.**

Cost fell across the three runs — ₹11.58 → ₹12.35 → **₹10.56** — and the most expensive
turn in the product, a parent asking to end her child's enrolment, went from 8 rounds and
₹2.36 to **4 rounds and ₹0.80** once `CHANGED_NOTHING` could say which kind of nothing it
was.

But the score is the least interesting thing here, and this is the point worth keeping:
**of the nine defects fixed this pass, six sat inside cases whose checks all passed.** The
score moved because of the one that happened to trip an invariant. The other six were found
by reading the message bodies, the round-by-round tool calls, and the rows — and nothing in
the harness would ever have reported them.

**Three times this pass a "finding" evaporated on contact with the database**, which is the
strongest argument for the method:

- Eight failing checks of *"nobody was told the same thing twice"* looked like eight
  defects. They were **one** — the invariant is world-cumulative, so once a duplicate
  exists every later case re-reports it.
- A family-privacy leak looked certain: a parent could see another family's child through
  the new roster view. The view was fine. `q.mjs` defaults to `--role service`, which
  **bypasses RLS**, and `--as` alone only sets the contact GUC. The tool was reading as
  service and I nearly filed it.
- A coach's roster read that "timed out" looked like a slow query. Measured in isolation it
  returns in ~200ms. The timeout was contention during a live run and **no root was
  established** — it is written down below as exactly that, not as a diagnosis.

---

## 1 · One true claim licensed a false one beside it — **drove it**

`ctx.committed` is a property of the TURN, so a message that truthfully reported one thing
could carry any number of false clauses next to it. Five instances in a single 17-case run,
every one inside a case whose checks passed:

> "I've added the *Evening Fitness* batch (daily 7–8pm at Green Park, ₹2000/mo) **and
> enrolled Aarav, Ananya, and Dev**. […] **I've also drafted an invite for Arjun** so you
> can get him onboarded."

The turn's writes were `class` and `class_slot`. **Zero enrollment rows. No draft.** The
guard passed it because `create_class` committed.

**Fix.** A verb that names a *specific* action is checked against the table that would make
it true — `enrolled` → `enrollment`, `drafted` → `message`, `recorded` → `payment`. Generic
verbs (`added`, `created`, `set`, `updated`) stay turn-scoped deliberately: guessing at
those refuses true sentences, and a refusal costs a round and can end in a substitution.

**And a gap that made the fix possible.** A plan's writes were never recorded in
`ctx.executed` — only named operations were — so the commonest write path in the product
had no evidence to check a claim against. Both paths record now.

**What it takes away.** A turn that genuinely did the thing but describes it in the passive
(*"Aarav is now enrolled"*) is not matched. That is deliberate and it is the honest
boundary: the same sentence is how you would correctly *answer a question* about existing
state, so a passive rule would refuse true prose.

---

## 2 · Two classes with one name, and the coach paid for it — **drove it**

An admin said *"one more: an evening fitness batch every day 7 to 8pm"* and the class was
created. Fifty seconds later, asked something else entirely — *"keep an eye on the advanced
batch and tell me on friday"* — the model composed a plan that re-issued the whole previous
request beside the new watch, was refused twice on unrelated shape errors, fixed the shape,
and ran it. A **second** "Evening Fitness" was created, identical in every business-
meaningful way.

What that cost, none of it visible in any reply:

- 22 duplicate sessions, one per day of the horizon, for ever
- the coach on both, so every `CO-COMING` went out twice, byte for byte
- the duplicates burned his §16.3 recipient frequency cap, so `CO-NUDGE` and `CO-REGISTER`
  were both suppressed — **he never got the register prompt at all**

**Root.** `venue` has had a unique key on (academy_id, name) forever, and `coach` has one.
`class` had none — and the model already treats the class name as a key: its own plan steps
read `(select id from class where name = 'Evening Fitness' and active … limit 1)`. That
`limit 1` is what made a duplicate invisible. R5 exactly.

**Two migrations, because the first was wrong.** 0020 scoped uniqueness to `where active`,
which looked like it honoured the reason `class` was deliberately left unconstrained (§6.3
keeps ended classes for ever, and last year's "Beginners" must not block this year's). It
did not: **nothing in the product ever sets `class.active = false`.** There is no operation
that retires a class. 0021 narrows it to classes that are still OPEN — `active and ends_on
is null` — which refuses the duplicate and lets a closed class's name be reused.

**What it takes away, and a gap it exposes.** The way to reuse a name is to close the old
class, and **there is currently no operation that does so**. That gap is real and worth
closing next.

---

## 3 · A button that lied about money — **read it, verified by a second reader**

Out of window a template's quick-reply title is fixed at approval time, so `send` kept the
minted action id and **replaced the label** — without ever asking what the action did.

The reconcile rung first fires **48h after** a payment request, so out-of-window is the
*normal* case for it. An admin was to be shown *"…₹2,400 was requested from Priya on 5
August and still isn't confirmed. Did it come in?"* with exactly one button, labelled
**Open**, which runs `confirm_payment` with no preview: the payment flips to `confirmed`,
`confirmed_by` is stamped with the admin's own name, and the family is sent a receipt.
`[Not yet]` was `buttons[1]` and was dropped. The same shape put `mark_attendance`
all-present behind "Open" on a coach's register.

**Fix.** §14.7 says an out-of-window message is a *window-opener* — the tap buys the
in-window interaction. That is only true of a tap that decides nothing. The label cannot be
made to match the action, so **the action goes rather than the label**.

**What it takes away.** Out of window a consequential choice loses its tap and the person
has to reply. The body still asks the question, any reply opens the window, and the real
buttons follow with their own labels. A button that lies is worse than one that is absent.

---

## 4 · A long answer was answered with silence — **drove it**

An admin asked *"so what exactly can you do for me?"*, the model wrote a good 1,141-
character reply, three next-step buttons were attached, and 1,141 > the 1,024 interactive
cap — so **the whole message was suppressed and they got nothing**. Nothing told them,
nothing retried, and the turn's own record says it answered.

"Rejected, never truncated" is right about a malformed control and wrong about length, and
the difference is who pays. WhatsApp allows 4,096 for plain text, so the same words fit
without the buttons. A body too long for its buttons now loses the buttons; it is never
cut; and a body that *points at* a control is still suppressed rather than made into a lie.

---

## 5 · The tap took the worse of two paths — **drove it**

Driven from empty: the first message a new owner ever saw offered `[Setup Sunrise Sports]`.
Tapping it returned *"Here it is. Yours only, good for the next hour."* and a 300-character
JWT.

The setup screen is a **form in the chat** on the `reply` path and a **link out of
WhatsApp** on the tap path, because `executeAction` mints a signed link and knows nothing
about Flows. So the owner who tapped the button the bot had just offered got the worse of
the two, at the highest-stakes moment in the product. R4.

One definition now, called by both.

---

## 6 · Smaller, all driven

- **The time localiser ate sentence-ending full stops.** It ended `[Mm]\.?` — meant for
  "P.M." — and a regex cannot tell that dot from the one ending the sentence. A prospect's
  first message read *"…from 6:30pm to 7:30pm It's ₹1,500 per month."* Dropping the
  trailing match costs a stray dot on the rare dotted form, which is the right way round.
- **A Markdown pipe table shipped to WhatsApp**, which has no table. `| Class | Coach |
  Roster |` reached an admin verbatim, and the *"no message carries raw structure"* check
  passed because it was looking for JSON and ids. Converted to bullets, not refused.
- **`[What can you do?]` was the only button under the answer to "what can you do?"** The
  one thing offered to somebody who had just been told everything was to ask again.
- **`CHANGED_NOTHING` could not say which kind of nothing.** A parent asking to end her
  child's enrolment cost 8 rounds, 39.8s and ₹2.36 of guessing. Re-running the writes as
  service inside a rollback answers it: rows that exist there are a refusal, rows that do
  not are a bad WHERE.
- **`repairHint` had no branch for 23505**, which 0021 has just made the commonest
  constraint in the product.

---

## 7 · What was fixed in the harness, and why it matters more than it looks

- **`q.mjs --as` could never do what it documents.** It ran `set local role` *before*
  resolving the contact, so with `--role user` the lookup was itself RLS-refused and every
  id reported "no contact". The only combination that ran was the one that keeps the
  service role — which does **not** show what a person sees. It nearly cost a false report
  of a family-privacy leak.
- **`message.turn_id` was null on every row the product had ever sent.** `serviceFrom`
  dropped the turn id at role escalation in fourteen places, so the GUC that 0015 chose
  *specifically so no caller has to remember* was unset for every escalated write. Layers 1
  and 2 of the drive method had nothing joining them.
- **`drive turn`** shows every round: what the model wrote, each tool call with arguments
  and results, and per-round tokens, seconds and rupees. Per-round spend was not recorded
  anywhere — only turn totals — so "which round cost 128k tokens" was unanswerable.

---

## 8 · The database, shaped for the questions the bot actually asks

`app.session_roster` is the register join, written once. The model rebuilt it from four
tables every time and got it wrong the same way in **both** probe runs — `e.active`, which
is a column on `player`, not `enrollment`. In run 2 it failed, then timed out twice, then
gave up and sent a link, and **the register was never marked at all**.

The schema doc already said so. Another line of prompt was not going to fix two tables
sitting next to each other where one of them has the column.

`security_invoker = true`, and `rls-check` now asserts **both** halves: a parent sees no
other children through it, and a coach still sees their whole register. Scoping a view
until it leaks nothing is easy if it also returns nothing.

---

## What is NOT verified

Said plainly so nobody promotes it by accident.

- **The money tail beyond `record_payment` is still unrun.** The reconcile ladder to
  `[Confirm payment]`, dunning to escalation, `per_package` exhaustion, `per_term` and a
  disputed charge have not been driven. Item 3 below is **read it**, not driven.
- **The money rules whose two writers disagreed are now fixed, but the fix is the smaller
  half.** The free-first-class credit was deduped on `reason = 'free trial'` in `money.ts`
  and written as `'free first class'` in `operations.ts`, so neither writer could see the
  other's rows and a trial player could be credited twice; `kind='package'` had two
  different description sentences, so `packageState` counted zero packs opened by the other
  path and billed another. Both now import `lib/billing-keys.ts`, and
  `scripts/check-billing-keys.mts` fails if either literal is reintroduced. **Found by
  reading, verified against source, still not DRIVEN** — `per_package` and a trial player
  have never run. And the real answer is that idempotency should not key on a sentence a
  human reads at all: a `dedupe_key` column on `tally_line` with a unique index would make
  the rule enforceable rather than merely agreed. Renaming a class still defeats a
  description-keyed guard.
- **The coach roster timeout has no established root.** It returns in ~200ms in isolation.
  Candidates are pool contention (`max: 10` per process against a shared `pool_size: 15`)
  and concurrent edits during the run. Not diagnosed.
- **A genuinely unknown number cannot be routed, and is not tested.** Seven academies share
  one `sender_id`, so `resolveInbound` returns `unresolved` for any unknown inbound. And the
  probe's own `stranger` case is **not** a stranger — Nikhil Bose is a pre-registered
  contact in state `engaged`. The one path a real prospect takes is untested.
- **The production media path still never fetches bytes.** Unchanged this pass.
- **The Flow is not published to Meta.** Unchanged.
- **Everything here ran against Gemini 3 Flash.** The structural guarantees hold every
  time; which tool the model reaches for first does not.

## Reported, not fixed

Carried forward, still true:

- `move_class` says "all of Evening Beginners" while moving one of two weekly slots. R10.
- `reschedule_session` accepts a time in the past.
- `client_cancel` declares `scope: 'session' | 'series'` and never reads it.
- `plan.ts`'s `asService` `finally` runs `set local role` on a transaction the throw has
  already aborted, so it throws 25P02 and **discards the in-flight exception**.
- There is **no operation that closes a class**, which 0021 makes newly relevant.
- A reply may still state a time or a date that no row holds: *"I've also scheduled the
  sessions to start from today"* was said about a class whose first session is four days
  later, and about sessions that did not exist yet. That is R10's open half.

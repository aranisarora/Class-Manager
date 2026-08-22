# Decided not to fix, or not to fix that way

The expensive half of the ledger. Everything here is a defect somebody investigated, understood,
and then deliberately did not close — because the obvious fix is worse, or because the evidence
to justify it does not exist yet.

**This is the file to read before "just fixing" something.** The rest of `findings/` records what
broke; this records what it costs to be wrong about the fix. Each entry has already been paid for
once, in hours somebody spent proving the obvious move was a trap.

Unlike [`OPEN.md`](./OPEN.md), this is written by hand. There is no way to derive a judgement
from a parse, and a judgement is the whole content.

---

## F-BL · `session_coach` cannot record a removal

**Status: handed off, not attempted.** Still open, deliberately.

The owner took two coaches off a Saturday session and put a third on. The product previewed it,
he confirmed, wrote a correct audit record and said *"Removed 2 coach assignments and added 1
coach assignment."* All true. Five days later all three coaches were back on that session, and
nobody was told. `materialize_sessions` re-inserts from `class_coach`, and a deletion leaves no
row saying the deletion happened — so the nightly job cannot tell "never assigned" from
"deliberately removed."

**Why the obvious fix was refused.** Adding a tombstone column to `session_coach` touches
**about thirty readers, six of them RLS** — counted 20 Aug against HEAD, listed in
[OPEN.md](./OPEN.md#f-bl--session_coach-cannot-record-a-removal). A partial
application **fails open**: miss one security helper and a coach sees sessions they were removed
from. The design comparison in Part 9 notes the shape that would be idiomatic *"in a codebase
where `session_coach` had five readers; it has thirty."*

**What to do instead of guessing.** Read Part 9's three candidate designs before touching this.
The evidence — `.probe/archive/runs/2026-08-17-18-07-live`, turn 24 deleting and turn 47 reading three
coaches back — is the reproduction, and three of five independent judges found it unprompted.

---

## F-BA · A hand-written attendance INSERT bills nobody

**Status: deferred on purpose, not overlooked.**

The per-session tally line is written by the `mark_attendance` operation, not by the world. An
`insert into attendance …` composed as a raw plan step raises the family's outcome message and
charges them nothing. The structural home is known and is not in dispute: **the line belongs on a
trigger**, the way `0033` did sessions, so attendance implies its billing on every route
including raw SQL.

**Why it is not shipped.** It changes money behaviour, and the ledger's own judgement is that it
*"deserves a drive of its own behind it."* Shipping a billing trigger on unit-level proof is how
you find out in production that a class of session was being double-charged.

---

## F-D · Memory takes things that are not facts

**Status: partial by design.**

The self-authored-policy half is closed — `policyShapedFact` refuses it and `business_rule` is
its real home. What remains is parentage restatements: the shape with no figure for the gate to
catch. That residue is a **prompt boundary and curation problem**, not a mechanism-shaped one,
and the repo's position is that the remaining half does not have a structural home worth
building. Recorded so nobody re-opens it looking for one.

---

## F-BC · Nothing to tap

**Status: an experiment, and it reverts if the experiment fails.**

Measured on two instruments at once and it is the biggest behavioural gap left: **7 of 27**
turn-composed messages carried a tappable button, at an average of 62 words; the three FAMILIES
got **0 buttons across 6 messages**, and a parent on a phone is the person least likely to type a
sentence back. Every reply that did carry something to tap came from machinery forcing a
confirmation — `{kind:'reply',text}` minted a button 0 times in 20 turns.

**Why it is not a prompt fix.** It is told twice already, in the two places the ladder rates
strongest. Told three times now, and the count has not moved.

**Why it is not a mechanism either, yet.** The proposed change — declaration order plus
`tappable` in the result — is staged **as an experiment with a stated kill condition**: it
reverts unless a two-arm drive moves the count. A prose guard is banned outright. This is the one
entry here that is expected to resolve one way or the other rather than stand.

---

*A finding leaves this file the same way it leaves [`OPEN.md`](./OPEN.md): by growing a mechanism
tagged `@mechanism … Closes F-XX` in `lib/`, which `npm run check:mechanisms` refuses to accept
while the ledger still calls the finding open.*

### F-CR (second half) — a coach's rate is NOT backdated to when the arrangement started

**Decided 22 Aug 2026, by the owner, after the thirty-day drive.**

`app.pay_on` has no row before a coach's first `rate_period`, and 0043's trigger stamps that row
with the WRITE date — so a coach entered on 6 Sep has no rate for the sessions he worked on the 1st
and the 4th. Arjun Shetty coached eight sessions in September and ₹1,600 of his ₹4,800 had nothing
to price against.

Three shapes were put up. **The one chosen is the one already shipped:** `unpricedWork` keeps the
unpriced sessions rather than dropping them on `if (amount <= 0) continue`, records the gap in the
run, and escalates it to the admin — naming the sessions and the rate now in force, and asking.

Rejected, and why:

- **Backdating `set_rate`'s `effective_from` to the coach's start date.** Fewer exchanges, and the
  product would be deciding what the owner agreed to. It also back-prices at today's rate, which is
  wrong the moment a rate has ever changed.
- **Pricing the earlier work at the current rate and reporting it afterwards.** No exchange at all,
  and it states a number nobody agreed to. That is precisely how F-CL happened — the same money,
  overstated, by a guess.

The rule this settles, and it is worth stating generally: **the product may refuse to answer a
money question and must not invent an answer to one.** An exchange with the owner is cheap; a
number he never agreed to is not.

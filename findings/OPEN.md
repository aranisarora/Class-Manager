# What is open

11 findings. This file is the source of truth for what is broken — hand-written, and short on
purpose. `npm run findings` reads it.

**Before proposing a fix for any of these, read [`../docs/MECHANISMS.md`](../docs/MECHANISMS.md).**
On 20 Aug 2026 the old ledger reported 38 findings open and 29 of them were already built; the
index is what stops that repeating.

Four of these are marked **[decided]** — investigated and deliberately not closed the obvious way.
[`DECIDED.md`](./DECIDED.md) holds the reasoning, and it is the file to read before "just fixing"
one of them.

**None of these are prompt problems.** Every finding names a structural home. Retire one by
building the mechanism, tagging it `@mechanism <symbol> — <what it does>. Closes F-XX` beside the
code, moving its row to [`CLOSED.md`](./CLOSED.md), and running `npm run mechanisms`.

| # | What is wrong | |
| --- | --- | --- |
| **F-D** | Memory is a copy of the schema plus things that are not facts, and reflection is the generator — **structural home built 16 Aug 2026, partial by design** **[decided]** | [detail](#f-d--memory-is-a-copy-of-the-schema-plus-things-that-are-not-facts-and-reflection-is-the-generator--structural-home-built-16-aug-2026-partial-by-design) |
| **F-I** | Assorted, smaller, all real | [detail](#f-i--assorted-smaller-all-real) |
| **F-R** | The lifecycle arc re-driven, 16 Aug 2026 — a button deleted on the way out, and nobody told | [detail](#f-r--the-lifecycle-arc-re-driven-16-aug-2026--a-button-deleted-on-the-way-out-and-nobody-told) |
| **F-AR** | The answer can die beside a tool call on the final round — the gap the leak fix uncovered | [detail](#f-ar--the-answer-can-die-beside-a-tool-call-on-the-final-round--the-gap-the-leak-fix-uncovered) |
| **F-BA** | A hand-written attendance INSERT bills nobody **[decided]** | [detail](#f-ba--a-hand-written-attendance-insert-bills-nobody) |
| **F-BB** | The plan reports "two places" and nothing makes the model say it | [detail](#f-bb--the-plan-reports-two-places-and-nothing-makes-the-model-say-it) |
| **F-BW** | `business_rule` had no reader, so every stated rule behaved as null | [detail](#f-bw--business_rule-had-no-reader-so-every-stated-rule-behaved-as-null) |
| **F-BC** | the affordance — an experiment, not a fix **[decided]** | [detail](#f-bc--the-affordance--an-experiment-not-a-fix) |
| **F-BL** | `session_coach` cannot record a removal **[decided]** | [detail](#f-bl--session_coach-cannot-record-a-removal) |
| **F-BU** | The proactive surface was unpriced, and it is most of what the product says | [detail](#f-bu--the-proactive-surface-was-unpriced-and-it-is-most-of-what-the-product-says) |
| **F-BV** | A window over `job` cannot answer "what ran in this turn", and never could | [detail](#f-bv--a-window-over-job-cannot-answer-what-ran-in-this-turn-and-never-could) |

---

### F-D · Memory is a copy of the schema plus things that are not facts, and reflection is the generator — **structural home built 16 Aug 2026, partial by design**

**Status:** the write gate exists. `rowShapedFact` (lib/agent/memory.ts) refuses, at both the
`remember` tool and `writeFact` itself, any fact carrying a rupee figure, a phone number, a
payment handle, or a multi-day schedule — the shapes every poisoned fact in the month drive
had and no legitimate keeper did — and the refusal says what to keep instead. `memory_curate`'s
prompt now carries the placement test, so a copy that slips through is retired at the next
rebuild. Partial on purpose: a parentage restatement or a self-authored policy with no figure
in it still passes the deterministic gate and is left to the prompt boundary and curation.
Also fixed alongside: `remember` silently coerced `subject_kind: "business"` — the product's
own word, taught by the reflection prompt itself — to *person*, so every reflection fact about
the business failed on "no such person", was swallowed by the fire-and-forget, and was
reported `ok:true`. The record below is the evidence.

**Root:** R8-inverse (a capability with no gate on *when not to use it*). §5's placement
test exists in prose; nothing enforces any of it at the write.
**Saw:** 20 live facts on one academy. Twelve restate rows (schedule, rates ×2, UPI, venue,
cancellation policy, parentage ×3, coach roster — held twice in different wordings). Two
are false: *"Vikram is the parent/contact for Aarav"* (he is a coach) and *"Vikram
(student) and Arjun (parent)"* (role-inverted). One is a transcript line (*"Deepak is an
active member who previously messaged on Wednesday"*). One is self-authored doctrine
(*"Tasks involving 'ensuring a brief is triggered' are considered complete once the
message has been sent"*). And the generator is live: **every answered question spawns a
fact restating the row just read** — "what do we pay vikram" → row says ₹500 → reflection
writes *"Vikram is paid ₹500 per session"* as a new fact, same turn.
**Blast radius:** the hot set fills with stale copies of rows; the one false parentage
fact is one turn away from telling a coach about a family's bill.
**Where it lives:** the `remember` write path (`lib/agent/memory.ts` / reflection in
`loop.ts`). Structural options, in preference order: (1) the write rejects facts whose
subject already resolves in schema (a fact naming a rate, a schedule, a phone, a
parent-child pair the tables hold is refused with a message saying the schema holds it);
(2) `memory_curate` gets the placement test and actively retires schema-duplicates, so
sprawl is bounded even when the write lets one through. A doctrine rule is the fix the
repo's own evidence says will not hold.

### F-I · Assorted, smaller, all real

- **The morning brief did not fire on a session day** (Wed 19 Aug: coach days went out,
  no admin brief; next planned event was 09:00Z). The evening digest also labeled itself
  *"digest for 2026-08-15"* on tenant-date Aug 17 — F-A's clock again, in the dedupe key.
  Confidence: certain on the observation, **suspected** on the planner mechanism.
- **`turn_id` is NULL on 27 of 81 outbound** — the whole job-sent surface is unattributed,
  so axis 1 cannot be measured where the product is most at risk. (Carried over from the
  handoff; still true.)
- **Two register-missing messages where one was owed** (one per session, same coach, same
  minute) — rule 7, in the `register_expiry` handler.
- **The prospect's first reply carries only [What can you do?]** — no [Book a free trial],
  no [See the schedule] (rule 11). The backstop fired because the model offered nothing;
  the fix direction is F-C/F-B's discipline, not a hardcoded button row.
- **Stale-context replay**: a reply opened by re-answering the previous turn's question
  (*"No, nothing today — she's usually Mon/Wed/Fri…"*) before the actual answer (rule 3).
- **August was billed in full for everyone** — the onboarding never asked *"who has
  already paid, and until when?"* (§7.1's explicit guard), and mid-month joins are not
  pro-rated. Carried from the handoff; the digest's unpaid list (₹6,000 · ₹2,500 · ₹2,500)
  confirms it stands.
- **`defaultButtons` is guidance, not a guarantee — and the handoff's "dead data" claim
  was wrong.** The catalog's buttons, triggers and on-silence notes all render into the
  stable prefix via `catalogDigest()`, so the model *is* told them; nothing *enforces*
  them, and the job handlers hardcode their own button rows separately
  (`lib/jobs/handlers/*`). The R4 drift risk is real — two copies of every default button,
  one advisory and one live — but deleting the column would delete the only statement of
  the defaults the model ever sees. If the two are to converge, the handlers should read
  the catalog, not the catalog lose the data.

Three more, found while re-driving after the F-A/F-B fixes:

- **One advance cancellation suppresses the whole register.** `post_class_register`
  skipped Friday's Beginners with *"register already marked"* because Meera's
  `cancelled_timely` row existed — so the coach was never asked about the other two
  players, and the register was never asked for at all. The "already marked" predicate needs to mean *every
  enrolled player resolved* (or session `completed`), not *any attendance row exists*.
  R7: the skip succeeds, and nobody would find out. The chat path still works and was
  driven to completion — the inverted register and the retro-timely question both
  behaved exactly as §8.2 specifies.
- **`mark_attendance`'s ack said "Done — Beginners, today — 0 in, 0 out"** over a
  three-player register whose rows all wrote correctly. The summary counts something
  other than what it claims; a coach reading "0 in" after marking three people will
  re-mark. Where: `mark_attendance`'s summary composition in `lib/agent/operations.ts`.
- **`drive register` resolves the wrong session** for a coach when another class ended
  more recently — it offered Arjun (Beginners) the Intermediate register. Driver bug,
  not product; `--session` works around it.

Two items carried forward from the retired `NEXT.md`, still open and still verified:

- **A genuinely unknown number is dropped without trace.** An inbound from a number no
  academy knows writes no `message`, no `job`, no `audit_entry` — the lost enquiry is
  undetectable by construction, on the acquisition path. Not serving a stranger and
  keeping no record one arrived are different decisions; only the first was made.
- **§14.8's automatic escalation has no runtime enforcement.** Refund, complaint and
  safety language are supposed to raise a human automatically; `handoff` sat at 0 calls
  in 464 turns and 0 again this pass. The refusal path already performs its own
  escalation — that mechanism, extended, is the fix direction; another prompt line is R8.

### F-R · The lifecycle arc re-driven, 16 Aug 2026 — a button deleted on the way out, and nobody told

Eighteen cases, `deepseek-v4-flash` at `thinking=low`, one fresh business, driven end to end
after the F-Q fixes. No invariant tripped, no unbacked done-claim, no turn errored, and no
academy or clock was left displaced. Eleven cases held and four broke — but only one of the
four is a defect, which is the reason this entry exists: a count of failing checks is not a
count of defects, and reporting them as one number manufactures alarm.

**A person asked to stop being messaged, and the button that would have stopped it was
deleted between the model and her screen.** Meera typed *"please stop messaging me now"*. The
model did the right thing and minted two buttons — `Stop all messages` carrying the `opt_out`
operation, and `Keep just the bill`. The first was refused at mint by the defanged-button gate
(`tools.ts:830`), correctly: it carried `confirmed:true`, which only that person's own tap may
set. A refused button is dropped and the message still goes (`tools.ts:1904-1916`), also
deliberately — taking the whole message down was the worse failure, and the comment there says
so. The defect is the report back. `tools.ts:2290` guards it with
`dropped.length && !buttons?.length`, so **the model is told what was dropped only when NO
button survived**. One survived here, so the `reply` result was a bare `{"status":"sent"}` and
the model could not repair the message it had just sent.

What reached her names a button that is not on her screen — *Tap "Stop all messages" and I
won't ping you about reminders, recaps or anything else* — and the only thing she could tap
was `Keep just the bill`, which keeps billing messages coming. An opt-out request that cannot
be completed by tapping is the compliance-shaped end of F-O's two-author seam: the prose and
the runtime describing the same act, and only one of them true. The comment at `tools.ts:1901`
states the opposite of what the code does: *"What was dropped comes back in the result, so the
model learns inside the same turn."* It does not, in the commonest case — a partial drop.

**Fix site:** `tools.ts:2290` — report `dropped_buttons` whenever `dropped.length`, not only
when every button died. The note already written there ("say the missing option in your next
message") is the right instruction; it is simply unreachable when one button survives. This is
the F-P lesson again in a third place: a mechanism that fires only in the rare case looks
exactly like a mechanism that is never needed.

**The other three are not defects, and are recorded so the next drive does not re-litigate
them.** `client-leaves` — a family's leave routes to the admin (`4320558`), so `ended_on` stays
null and the check asking "is Aarav out of Fitness" fails by construction; the open question is
not whether routing is right but whether anything guarantees the admin acts, because until they
do Fitness keeps billing. `hinglish-cancel` — the clock landed on Saturday 5 Sep, so *kal* is
Sunday and Beginners runs Mon/Wed/Fri; there was no session to cancel and the model asked which
class was meant rather than cancelling the wrong one, which is the behaviour we want. The case
needs a clock precondition. `coach-marks-register` — `walkClockTo` refused (target 21.1h away,
7.5h of the 30h budget left), so the case never reached a finished class; the model said the
class had not run yet and the invariant *no register was marked for a class that has not
happened* held, which is the right refusal to a case that measured nothing.

**Harness note.** The arc drops its academy on the way out, so a finding that needs a follow-up
query — did the owner actually receive `client-leaves`' routed request? — cannot be settled
after the fact. Drive with `--keep` when the question is about a message rather than a row.

**Re-driven 16 Aug 2026 after fixing the harness, and the harness was most of what F-R above
measured.** Three probe fixes, all in `scripts/probe-model.ts`, none in the product:

- *`hinglish-cancel` walked to 20h before the next session of ANY class* and then asked to
  cancel a **beginners** class. This arc's daily Fitness batch is nearly always next on the
  calendar, so the clock landed the evening before a Fitness session and the sentence had no
  referent. The model read the calendar, asked which class was meant — the behaviour we want —
  and both checks failed it. It now targets the next Beginners session. **Re-driven: HELD.**
- *The 30h clock budget was mis-sized for the arc it serves.* The distance to the first session
  is not a property of the arc but of what time of day the probe starts: `daily-batch` asks for
  a batch "starting tomorrow" at 7pm, so a run beginning after midnight is ~43h from its own
  first session. Measured worst case is 67h. Budget is now 96h. **Re-driven: all three clock
  walks reached their targets (7.0h, 38.6h, 21.6h), zero refusals.**
- *A REFUSED walk used to score the case anyway*, and produced a wrong reading in both
  directions: `coach-confirms` was refused and then PASSED, because its checks are satisfied by
  any confirmed future session; `coach-marks-register` was refused and then FAILED four checks
  about a register for a class that had not run. A refused walk now skips the turn and records
  DID NOT RUN. The false pass is the more dangerous half and nothing was catching it.

**What the deeper travel then found, which the truncated arc had been hiding.** Held went 11→12
and failing checks 8→5, but two real defects appeared for the first time:

- **Duplicate sends. `nobody was told the same thing twice` tripped**, first at `hinglish-cancel`
  and still tripping at the end: three recipient/body pairs at `n:2`, including a parent's
  session reminder, a merged sibling reminder (*"Ananya and Dev has a class coming up"* — the
  merge fired, then the merged message went twice) and a coach's *"take the register"*. This is
  F-C's class arriving through the front door: the pre-fix arc never travelled past the first
  evening, so it never saw a second reminder cycle. Zero trips in every earlier arc run is not
  evidence of absence — it is evidence the arc stopped too early.
- **`app.session_roster` timed out.** With the clock fixed, `coach-marks-register` reached a
  finished class for the first time and three of its four reads came back `canceling statement
  due to statement timeout` (5s), twice on the roster view that exists for exactly this moment.
  The model never reached `mark_attendance` and said so honestly — *"my lookup is timing out, so
  I couldn't record it yet"* — which is the right failure. **Not diagnosed:** the view returns
  instantly on a small tenant, so this may be its cost against the larger world a 67h walk
  builds, or contention from the probe's own draining. One run does not settle it.

**`opt-out` failed both runs by different routes, which makes it a class rather than a bug.**
Run 1: the model minted `Stop all messages` and `Keep just the bill`; the first was correctly
refused at mint and silently dropped, leaving prose naming a button that was not there. Run 2:
the model never called `reply` at all (`read → reflect:remember`) and offered both options as
prose bullets, 142 words, with only the generic `What can you do?` menu to tap. Both times
`opt_out` never executed. The gate is right; what is missing is anything that guarantees an
explicit stop request ends in a working stop affordance.

### F-AR · The answer can die beside a tool call on the final round — the gap the leak fix uncovered

**Saw:** `real-coach-morning` — "all set for today?" diagnosed perfectly (uncovered tonight, coach
in "added" limbo), the answer drafted as prose beside `send_invite_draft`, the prose correctly
discarded as notebook, and the operation's side-message (an invite draft) stood in as the entire
reply. A non-sequitur with no false sentence in it. The recovery ladder couldn't fire because a
message HAD reached the person — just not the answer.
**Where it lives:** `lib/agent/loop.ts` — "told" currently means "any message reached them";
the recovery round should also run when the final round drafted prose that was discarded while the
only outbound was an operation's side-product. One turn in 29; the last delivery gap standing.

### F-BA · A hand-written attendance INSERT bills nobody

The per-session tally line is written by the `mark_attendance` operation, not by the world. So an
`insert into attendance …` composed as a plan step raises the family's outcome
message and charges them nothing, and nothing detects it. The declaration now
steers toward the operation, and a declaration is not a guarantee. The structural
home is the one 0033 used for sessions: **the line belongs on a trigger**, so
attendance implies its billing on every route including raw SQL. Not shipped
here — it changes money behaviour and deserves a drive of its own behind it.

### F-BB · The plan reports "two places" and nothing makes the model say it

The plan result names anyone put in two places at once. Whether that reaches the
person is the model's choice, and on the first drive of that case it did not.

**F-BC · Nothing to tap. Measured on two instruments at once, and it is the
biggest behavioural gap left.** In the week, **7 of 27** turn-composed messages
carried a tappable button, at an average of 62 words. The probe arm flagged the
same thing independently on 14 of 18 turns — *wall of text, nothing to tap*.

It is not persona-specific, and it is worst where it matters most: the three
FAMILIES got **0 buttons across 6 messages**, and a parent on a phone is the
person least likely to type a sentence back.

This is not a case of the model not being told. It is told twice, in the two
places the ladder says are strongest: the `reply` declaration
(*"Offer the natural next step as a button"*, and that `{kind:'reply', text}`
needs no arguments you do not have) and doctrine 7's button budget. **So more
prompt text is the one fix that is known not to work here** — that is the
standing prohibition, and this finding is the evidence for it rather than an
exception to it.

The structural home is the runtime. `backstopButtons` already exists and, by its
own comment at `tools.ts`, only helps an admin before go-live, "because from
where it stands it cannot guess a useful third button". Two directions worth
driving: mint the obvious affordance from what the turn already did (a plan that
staged something has a tap; a question asked has its answers), and treat a
button-less reply to a non-admin as the exception that has to earn itself,
the way a long body already does.

### F-BW · `business_rule` had no reader, so every stated rule behaved as null

Recorded 17 Aug 2026; carried the code `F-BH` until 20 Aug, when that code was
found to name this and the Part 8 definer-view finding at once — one of the two
was invisible to every reader that parses by code.

`enforced_by` was enforced by nothing. The partly-covered-period writer above is
`business_rule`'s first reader, so the general case is still one reader and not a
mechanism: the structural home is wherever a job composes from a query.

### F-BC · the affordance — an experiment, not a fix

**The measurement, sharper than the count.** Six of twenty turns carried a button
and **every one of the six came from machinery forcing a confirmation** — a
preview, or a two-tap protocol. Not one was a voluntary next step, and
`{kind:'reply', text}` — the free button that needs no arguments and no operation
— was minted **zero times in twenty turns**, despite being stated in the `reply`
declaration and in doctrine 7.

**It is not that the model does not want them.** Turn 1's reasoning says *"offer
buttons"*, *"offer next step as a button"* and *"the note says … offer next step as
button"* — three times — and then ships a thousand-character body ending on *"Which
do you want to sort first?"* with nothing to tap. Turn 16 reasons its way to the
right affordance and hits a composition dead end. The intention is formed and
evaporates before the call.

**Tried:** `buttons` and `list` declared BEFORE `body` in the `reply` schema (a
decoder emits roughly in schema order, and an optional trailing array is the
cheapest thing in the world to not emit), and the `reply` result now states
`tappable`, which is a count of an array rather than a reading of prose.

**Not made required**, deliberately: the injury relay and both attack refusals were
right to carry none, and a required field buys compliance at the cost of friction on
every reply.

**This is the one item kept only on evidence.** The same suite driven twice, one
variable apart, and reverted if the count does not move. **What must never be built,
in either outcome:** a check that reads a body for talk of tapping. Every pattern
ever pointed at language in this repo misfired silently in both directions — the
promise detector that matched "try" and missed "retry", the leak check that fired
inside a correct refusal, the overclaim counter that read 0 on a drive containing
one. A regex for *"one tap"* would join that list within a drive. If the ordering
change earns nothing, this finding stays open and unfixed, which is what
ARCHITECTURE says to do when no layer owns a defect.

### F-BL · `session_coach` cannot record a removal

**What happens.** The owner took two coaches off a Saturday session and put a third on. The
product previewed it, he confirmed, it wrote a correct audit record and told him
*"Removed 2 coach assignments and added 1 coach assignment."* All true. A few days later all
three coaches were back on that session. Nobody was told.

**Evidence.** `.probe/runs/2026-08-17-18-07-live` — turn 24 executed
`delete from session_coach where session_id='d727685e…'`, each returning 1 row; by turn 47
(day 5) the same session read back three coaches again. Three of five independent judges found
it without being told to look. Downstream: duplicate day-6 messages, and the owner's
unmarked-register alert was suppressed because the job had made him a coach on that session
again and the product will not scold you about yourself.

**Why it happens.** `lib/jobs/handlers/sessions.ts:140-153` — `materialize_sessions` re-inserts
`class_coach` into `session_coach` for **every** future scheduled session of the class, every
run, `on conflict (session_id, coach_id) do nothing`. `on conflict do nothing` skips a row that
is *there*. A row deliberately deleted is not there, so it is re-created.

The root of it is in the schema. `session_coach` (`0002_schema.sql:225-236`) has nine columns
and none of them records a removal. **Assignment is row existence**, so a delete leaves no
trace at all — checked across all 37 migrations, there has never been a `removed_at`,
`deleted_at` or `status` column.

### F-BU · The proactive surface was unpriced, and it is most of what the product says

`live.ts` called `walkTo`/`drain` at three sites — `open`, `window`, `endday` — and none was
inside a `rec.turn()`. The only `rec.turn()` in the file was the seat turn. So the queue's work
was recorded as a list of job names in `days.jsonl` and nothing else.

The evidence is not that the record was thin; it is that the arithmetic was wrong:

- **49 of 137 delivered messages (36%)** in `2026-08-18-14-38-live` went out from a job, with
  ₹0 against them. The run's own cost table therefore priced the conversational third and
  presented it as the run.
- `lib/clock.ts` opens by saying **"~70% of this product is proactive."** The instrument was
  measuring the other 30% and extrapolating a monthly figure from it.
- `days.jsonl` *is* folded into `record.json` as `run.days` by `close`. It was never rendered:
  `report.mjs` reads `rec.world` and `rec.turns`, so a shape nothing renders is a shape nobody
  reads. The data existed and was invisible, which is the harder failure to notice.

The fix is the one the critique named. `queueTurn` opens the record inside the same lock the seat
turns use and wraps the drain, so the queue gets the identical treatment: its handlers' model
calls land in `rounds`, their statements in `sql`, their messages in `messages`, and their cost in
`inr`. `who` and `persona` are both `queue`, which puts the proactive surface in `report.mjs`'s
split table as its own row beside the four people — the reading that was impossible before.

`say` is empty, because nobody typed. An invented sentence there would be the harness putting
words in the product's mouth, and `report.mjs` renders these turns under *What ran* and *What
went out unprompted* rather than *What they typed*.

### F-BV · A window over `job` cannot answer "what ran in this turn", and never could

`_capture.ts` asked for `coalesce(locked_at, run_at, created_at) >= cursor and status <> 'pending'`.
Every part of that is defensible and the whole is unanswerable, because **no column on `job`
records when a job finished**: `run_at` is when it was DUE, `created_at` is when it was MADE, and
both `live.ts`'s drain and `lib/jobs/runner.ts`'s `finish` set `locked_at = null` on completion
(0002_schema.sql:355-368 is the whole column list). The `coalesce` therefore fell through to
`run_at`, and every already-finished job still scheduled ahead of the cursor re-listed on every
turn for the rest of the run.

Measured, not argued:

- **6,912 job strings across 68 turns** — mean 101.6 — from **31 distinct values**, 1,324 of them
  the same `materialize_sessions:done`.
- The count falls **161 → 66** and plateaus exactly on simulated-day boundaries; **61 of 67**
  consecutive turns are a strict sub-multiset of the turn before. That is a shrinking horizon
  being rendered as per-turn work.
- Against the live database on 20 Aug: **560 of 567** finished jobs have `locked_at` null, and
  with the cursor at `app.now()` the old predicate returns **25 finished jobs from 9 distinct
  values** — 14 `done`, 10 `cancelled`, 1 `skipped`, all with `run_at` ahead of the clock — for a
  turn in which nothing ran at all.
- `report.mjs` rendered this as `Queue: …` under each turn, so a reader saw ~100 queue events per
  turn and concluded the queue was heavily instrumented.

`drain()` has always returned exactly the right answer — a `string[]` of `kind:status` for the
jobs it just ran — and `live.ts` was discarding it. The fix is to record that: `fn` now receives a
`TurnSink` and pushes into `sink.jobs`, and the query is gone. There is no predicate left to get
wrong.

**A `ran_at` column was considered and deliberately not added.** It would let the table answer the
question directly, and `lib/jobs/runner.ts` has the same blind spot in production. But no product
behaviour needs it — `job_tick` (0029) already covers whether the beat is alive — and adding a
column to the product's schema to serve an instrument inverts this repo's own layering. Recorded
here so the next reader does not re-derive the choice.

# Findings — the first live-seat week

From `.probe/runs/2026-08-17-18-07-live` (24–30 Aug 2026 simulated, 82 conversational
turns + 33 proactive, four seats, `deepseek-v4-flash`). Judged by five readers with
complete visibility, one per seat and one across seats; per-turn scores and reasons in
`judgement.json` beside the record. The full analysis is
`.probe/reports/2026-08-18-live-week-analysis.html`.

**These are descriptions, not proposals.** Each says what happened, where, and what the
rows showed. Nothing here prescribes a change — that is a separate decision made by
whoever owns the layer, per ARCHITECTURE.

**Staged here rather than appended to `conversation-rules.md`** because parallel sessions
were editing that file throughout this run and an append would have swept their
uncommitted work into this commit. Merge into Part 5 and renumber from F-BH when the tree
is quiet.

---

## The verdict these all sit under

> Every claim this product made about a person **not in the conversation** was composed
> from its own narration rather than read back from the row — so each seat spent the week
> holding a confident, internally consistent, mutually contradictory picture of the
> others, and nothing in seven days reconciled any two.

The prose was never the problem. Plainness scored 8.40 of 10, the highest of the nine
axes. The three lowest are sideways reading (5.52), consequence (5.85) and affordance
(5.87). The admin seat is lowest on eight of the nine.

---

## 1 · The trailing-prose path carries most of what the product says

`reply` was invoked 40 times across 82 turns. Counting taps, 37 turns used the ordinary
send path; **45 turns — 55% — never called it and every one still delivered a message.**
Their round sequences end `(model) | (reflection)`.

Those messages leave through `lib/agent/loop.ts:1639` — `if (text.trim() && !spoke())` —
which takes the model's final assistant prose and ships it via `composeAndSend` at
`:1742`. The gate is `!spoke()`, not an error kind, so it covers a thrown tool, a returned
refusal, a suppressed or failed transport outcome, the duplicate-call block, and a turn
that merely exhausts its rounds. Only `input.source === 'job'` (`:1616`) and an
already-on-screen confirmation (`:1629`) are carved out.

The structural gates hold: `validateOutbound` runs in `compose.ts:179` and again in
`send.ts:806`, `encodeForWhatsApp` at `send.ts:587`, plus opt-out, window, caps and
idempotency. The honesty gate does not. `proseViolations` (`tools.ts:1813-1819`) answers
only string-decidable questions — uuid, ISO timestamp, section reference, raw URL, wire
blob, pseudo-buttons, the word "academy". Internal narration contains none of them.

On day 4 the parent received, as a WhatsApp message:

> "I'll close the turn with the honest update to Divya directly, since the message tools
> are failing this turn."

The turn then made three claims — *"I've pushed the fix to them again this morning"*,
*"I've flagged it again today"* — with 1 message on the wire, 0 writes and 0 audit rows.
Scored 1/10.

The trigger that turn was `ReferenceError: formForReply is not defined` at
`tools.ts:1853`, a transient state while a parallel session was removing Flows. The path
was verified present at `HEAD` and is independent of that trigger.

---

## 2 · The nightly materialiser restores coach assignments an owner deleted

Turn 24 removed the owner and Priya from the Saturday session and assigned Arjun.
`materialiseClass` (`lib/jobs/handlers/sessions.ts` ~L140) re-inserts every `class_coach`
member into every future scheduled session on each nightly horizon roll; a delete leaves
no tombstone it respects. By turn 60 all three `session_coach` rows were back on session
`d727685e`, all with `confirmed_at` null. Nobody was told.

Found independently by three of the five judges. It is also the root cause of §3 and of
duplicate day-6 messaging.

---

## 3 · Assignment and confirmation are one English word and two columns

Turn 24 inserted Arjun's `session_coach` row and told him *"Confirmed — see you there"*,
writing no `confirmed_at`.

- Turn 47 (day 5, 08:30) read three rows, all `confirmed_at` null, and told the coach
  *"that's yours. Nothing to take."* — 0 writes.
- Turn 60 (day 5, 20:51) read the identical rows and told the owner *"Arjun hasn't picked
  it up… he's just silent."*

Both were honestly derived from the same row at both moments. Only "silent" was false: he
had asked twelve hours earlier and been told to do nothing.

---

## 4 · A failed prefetch is handed to the model as a fact and reaches a person as a permission

On turns 67, 79 and 81 the standing prefetch block died on
`(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to
pool_size: 15`. The turn header then renders:

> "their coach record and session counts could not be read this turn. Say nothing about
> either, and do not read the gap as 'none'."

That states the gap and withholds the cause, so the model supplies one; the only candidate
in its prompt is the seat note it is already arguing with — *"Money is NOT visible to this
person … do not quote a balance, a rate or a due amount."*

Postgres never refused. `coach.pay_amount` returned `600 / per_session` under the identical
seat on turns 11, 46, 48 and 68. Turn 48 is the control: two full rounds of the model
litigating the contradiction before concluding "I'm overthinking" and answering. On turn 67
it issued zero reads of its own; on turn 79 it reasoned twice that it *could* compute the
figure, wrote "let me run the queries fresh", and issued none.

Turn 81 is the proof: it wrote *"He's worked Mon 24 and Thu 27 (₹600 each)"* to the owner
one message after telling the coach that side of the books was not visible to it.

23 of the week's 29 SQL errors are this one class, 14 of them on day 7 — the day with the
week's worst mean score (4.10). The pool pressure was partly the harness running three
seats concurrently; the narration is not.

---

## 5 · The receivables brief filters charges to one period and sums payments across all

Turn 74's brief filters `tally_line` to August but sums `payment` over every period,
producing a phantom ₹2,400 credit. The owner was told the client was *"in credit ₹2,400,
September covered"*. The client was told *"₹2,400 charges on the 1st"*. Ninety seconds
apart.

---

## 6 · The owner was told two debtors were chased for figures they were not sent

Turn 76 read Latha's *"₹4,800 still open"* and Sanjay's *"₹9,000 still open"* dunning
bodies **in that same turn**, then reported *"Latha was told ₹2,400… Sanjay ₹2,400… Both
figures are right."* He replied *"ok leave it."* Scored 1/10.

Related: the duplicate-line check the product itself invented for one family on turn 37
was never generalised; the other two accounts carry the same signature and were chased on
the doubled figures.

---

## 7 · Re-confirming a cancellation downgrades its own row

Turn 15 wrote `cancelled_timely`. Turn 30, re-confirming the *same* session inside the 24h
window, wrote `absent` via
`on conflict (session_id, player_id) do update set status = excluded.status`.
`client_cancel` recomputes timeliness from `now()` and blind-upserts with no read of the
existing row and no guard preferring the earlier, better status.

The product asked her twice and recorded her second answer as the worse one. On a
per-session rate this converts a free cancellation into a charged no-show. Turn 72 then
reported it as *"properly marked off"* from a `count(*)` that never read the status, and
she wrote that into her diary as fact.

---

## 8 · An escalation writes no row, so nothing can chase it

The prospect's two questions **did** reach the owner: five messages on days 1–3 (turns 9,
18, 27, 29, 31), all `sent` to `+919378680890`, corroborated by his own day-2 diary. All
five wrote **0 rows**. `pending_request` returned 0 in all sixteen of her turns.

The only chaser — turn 9's watch — was minted with the instruction *"If the owner still
hasn't answered, do nothing"*, over a `context_query` spanning all admin inbound of 36h,
which could not have recognised an answer. It ran on day 2 at 08:30 and put nothing on any
wire.

She received real answers on day 5, after the owner independently volunteered a policy on
day 4. Her day-3 diary: *"if nothing by tomorrow morning i am done waiting."*

---

## 9 · `decline_coach` addresses the caller, not the subject

The owner typed *"yes"* to assigning Arjun and received *"Just to be sure — you can't make
Weekend Squad Sat 29 Aug?"* about himself; 81s, ₹0.86, nothing assigned. Round 1's
reasoning resolved the "yes" correctly — *"they've approved assigning Arjun."*

The button carried Priya's `coach_id` correctly (turn 59), so this is addressing rather
than identity: `pending_request.subject` was the acting contact both times. It recurred
identically on turn 53, five days later, and the orphaned question then steered turns 61,
69 and 71.

---

## 10 · Coach pay has no effective-date column

The owner set a raise "from sept". `update coach set pay_amount` is the only available
write and takes effect immediately. The change was described to him as September-only on
turns 77 and 78.

---

## 11 · A re-escalation mints a second button without retiring the first

Two live `[Approve]` buttons for one enrolment. Tapping both duplicates
person/account/player/enrollment and makes the account subselect ambiguous; the stale one
alone writes an August start date the prospect had already been told was September.
Schedules replace by subject key; buttons have no equivalent.

---

## 12 · A comm-preference redirect has no forwarding address

The client asked for fees messages to go to her husband. Turn 56's tap wrote a real
`comm_preference` row with scope `money`. No contact for him exists on account `75f3cfcb`.
Turn 75 told her *"that stays with your husband"*; its own reasoning drafted *"tell me
whose number that should be"* and dropped the sentence before sending.

---

## 13 · A dictated first name acquires a surname the product supplied

She typed *"zoya and imran"*. The staged steps write `full_name = 'Zoya Sheikh'` and
`'Imran Sheikh'`, and the follow-up watch keys on those invented strings.

---

## 14 · The decision was never written

The prospect decided on day 7 to enrol both children, over a rival quoting a flat ₹3,500.
Turns 80 and 82 record `wrote: 0`. At run's end no `person`, `account`, `player` or
`enrollment` exists for either child; two conflicting `[Approve]` buttons sit unapproved.
Her own diary closes *"still pending, not fully confirmed."*

---

## What the run also measured, without a defect attached

**The R10 shadow detector is anti-correlated with this week's failure mode.** The round
named `R10 shadow: numbers with no read behind them` fired on 19 turns — 6 admin, 6
prospect, 4 coach, 3 client. Those turns have a mean score of **7.32**, above the run mean
of 6.54. It fired on turn 25 (scored 9) and turn 12 (scored 9). It did not fire on turn 76
(scored 1), where the owner was told two debtors had been chased for figures they were not
sent. Recorded as a measurement, not a proposal — JUDGING.md's standing argument is that
patterns over prose are negation-blind, and this is another instance of it.

**F-AV is structurally closed and was not exercised.** The mute wrote a real
`comm_preference` row and `send.ts` gate 1c reads it on every unsolicited send, with
`MUTE_SCOPE` exhaustive over `CatalogId`. But day 7's `dunning` was skipped at job level
because that account's balance was already zero, so **zero `muted` suppressions appear
anywhere in the record**. The gate exists and would have held; this run proves only the
first half.

**Malformed input caused no failures.** Roughly half of all messages carried a typo,
fragment, autocorrect error, one-word reply or dictated run-on. `"an ika there ishaan
absent"` produced a correct register; `"anima is all set for mondays class right"` was
recovered as Anika without comment. Every failure in the week was semantic and concerned
somebody not in the conversation.

---

## Confounds

1. **The fixture double-billed August.** `_world.ts` wrote the current month's
   `tally_line` rows and the product's billing job wrote them again. The product catching
   this and telling a parent not to pay is to its credit; money readings downstream are
   partly measuring the harness. The fixture now writes only the closed month.
2. **The product changed under the week.** A parallel session was removing WhatsApp Flows
   on the same branch mid-run. Day 1's `[Take register]` failure is that removal in
   flight; the `ReferenceError` in §1 is a transient mid-edit state. Days 1–4 and 5–7 are
   not quite the same product.
3. **Pool exhaustion is partly the harness's.** Three concurrent seats against
   `pool_size: 15` inflated the frequency behind §4.
4. **No history behind the week.** No historical `session` or `attendance` rows existed,
   so coach pay genuinely starts on day 1 of a five-week-old business.
5. **One run, model-driven seats.** JUDGING.md's standing advice is to run an arc twice
   before believing a defect is a property of the product. The seats followed persona
   briefs faithfully but are more patient and more articulate about their own confusion
   than real users.

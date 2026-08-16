# The ideal conversation — rules, and where the product falls short

Two halves. The **rules** are durable: they are what `ideal-conversations.md` demonstrates,
stated as testable propositions, so a driven transcript can be scored against them without
re-reading the whole timeline. The **findings** are a snapshot — driven 15 Aug 2026 against
the post-`367e8b6` brain, with the timezone/phone fixes from the uncommitted diff in place —
and they go stale the way findings do. Date anything you add.

None of these are prompt problems. Every finding below has a structural home, and the repo's
own evidence (DRIVING.md, the R10 note) is that instructions do not close behavioral classes.
**Do not fix any of this by adding doctrine.** Each finding names where the fix lives.

---

## Part 1 — rules for the ideal conversation

Distilled from `ideal-conversations.md`. Doctrine (§4.1) says how to *sound*; these say how
the conversation has to *behave*. Each is written so a transcript either passes it or doesn't.

**1 · One confirmation per consequential action, ever.**
The ideal has exactly one "just checking" before a cancel, one [Looks right] before a coach
goes active. Two confirmations for one action reads as the product not trusting itself.
Whoever composes the confirmation owns it — nothing downstream asks again.

**2 · A decision to stay quiet produces no message.**
"I will stay quiet until Wednesday" sent as a message is a contradiction in one sentence.
Internal deliberation, watch bookkeeping, "no follow-up is needed" — none of it is ever
outbound. The ideal's proactive sends all carry news the recipient would have asked for.

**3 · Answer the question asked, this turn, and nothing else.**
No re-answering the previous turn's question first. No restating what the person already
knows. The reply to "what do we pay vikram" is one line, and the ideal's replies never
open with a recap.

**4 · Length is earned by news, a decision, or something going wrong.**
The ack for a tap is "👍" or "Done." Restating the child, class, time and venue after a
confirmation is noise. (§4.1 rule 12 — kept here because it is the most-broken one.)

**5 · Every number, name and time is read from a row this turn.**
A headcount, a rate, a next-class date — stated only if a query in this turn returned it.
"12 players are down to attend" over a table holding 1 is the worst message in this pass,
and it scored as a pass on every existing axis.

**6 · Times are said in the academy's idiom, from the academy's clock.**
"6:30 pm Friday", never "13:00Z", never "in 3411 minutes", never a day of the week computed
from a different clock than the one the schedule lives on.

**7 · One event, one person, one message.**
Two unmarked registers is one message, not two — and never seven. Two children with news on
the same day is one message (`ideal-conversations.md`: "You'll get one message, not two").
Dedupe is by *fact*, not by byte-identical body.

**8 · The proactive surface is bounded by usefulness, not by capability.**
One watch per subject; a watch duplicating a standing job (coach-day, dunning, register
expiry) is never minted; a prospect who simply hasn't replied is not checked on ("no
countdown, no tips, no checking she's still excited"); an open confirmation button is not
chased. The ideal's bot watches one thing in five weeks, because the admin asked it to.

**9 · Nothing lands at 4:30 in the morning.**
Proactive sends respect waking hours in the academy's timezone. The ideal's reminders
arrive the evening before, its briefs at 7:00, its digests at 9:00 pm.

**10 · Memory holds only what the schema cannot.** (§5's placement test, applied.)
"Calls them batches", "salary comes on the 15th", "never taps buttons" — yes. A rate, a
venue, a parentage, a schedule, a UPI handle — no; those are rows, and a memory copy of a
row is a future wrong answer waiting for the row to change. A transcript line is not a
fact. A rule the bot made up about itself is not a fact.

**11 · The first message a person ever gets carries a useful next tap.**
[Book a free trial], [See the schedule] — proof and an offer, not a generic
[What can you do?]. The backstop menu is a floor, not a first impression.

**12 · The cost goes before the tap, and what will stop is said out loud.**
Both already doctrine (rules 13–14); listed because they are testable per-message and the
cancel flow now passes them — keep it that way.

---

## Part 2 — findings, driven 15 Aug 2026

Ordered by blast radius. Format follows DRIVING.md: class, root, what was seen, where it
lives. Confidence is **certain** unless marked.

### F-A · The model lives on the wall clock while the world lives on the tenant clock — **FIXED this pass**

**Status:** fixed 15 Aug 2026 — `now(academyId)` threaded through every model-facing and
job-handler call site (~45), including the clockNote in `runTurn` that was the model's
entire sense of "now", `lint`'s date grounding, and `agent_task` expiry. Re-driven:
the Friday brief said "tonight, 7:30pm / tomorrow, 8am / Today, Fri 21 Aug" correctly,
the previously-missing morning brief fired (its day was computed on the wall date),
expired watches now skip instead of detonating in batches, and new watches mint in the
tenant future. The record below is kept as the evidence.

**Root:** R4 (one guarantee, several paths) — `now(academyId)` exists and resolves the
tenant clock; ~20 call sites in model-facing code call bare `now()` and get the world clock.
**Saw, in one driven afternoon (tenant clock at Wed 19 Aug, wall clock at Sat 15 Aug):**
- A coach was told *"It is Saturday, 10:52am. You don't have any classes today or
  tomorrow"* — on his tenant-Wednesday, an hour after his class ended.
- A parent asked about "this saturday"; the model queried wall-Saturday (Aug 15) and
  answered *"her next one is Monday at 6:30pm"* — a session already in the tenant past.
- Every `reflect:schedule` watch was minted with `run_at` in the tenant past — stillborn,
  or detonating in a batch on the next clock advance (seven at once, see F-C).
- `post_class_register` skipped with *"class has not finished"* five minutes after the
  class finished — so **the register can never fire in a driven world** until wall time
  catches up. This is why the register was never submitted across two passes.
- `client_cancel` computes its in-window/charge decision from bare `now()`
  (`operations.ts:2056`) — the wall clock decides **whether a family is charged**.
- `AD-ESCALATE-UNCONFIRMED` said *"it starts in 3411 minutes"*: wall-clock arithmetic,
  rendered in raw minutes.
**Blast radius:** in production, none today (no tenant offsets exist, the clocks agree).
In driving — the product's entire eval — every turn, watch, window and skip decision is
corrupted, and DRIVING.md's note calling this "the honest edge" undersells it badly.
**Where it lives:** `lib/agent/context.ts:643`, `lib/agent/loop.ts` (3 sites),
`lib/agent/operations.ts` (~15 sites), `lib/jobs/handlers/agent-task.ts:27` — every one
has the academy id in scope on the same line or one above. Mechanical fix; also delete
DRIVING.md's "honest edge" paragraph when done, because the edge stops existing.

### F-B · Job-turn deliberation is delivered as messages — **FIXED this pass**

**Status:** fixed 15 Aug 2026 — on `source: 'job'` turns the recovery round and the
trailing-prose send are skipped; discarded prose lands in the trace as
`(job turn: trailing prose discarded)` so drives still see the thinking. Re-driven: a
register watch spoke once, through the tool, with a correct, useful message — instead of
seven narrations. What it takes away (test 4): a job turn whose model *meant* to reply
but forgot the tool is now silent instead of accidentally heard; that is the §13.1
default and the safe direction, but it is a real cost and it is named here.

**Root:** R4. `loop.ts:1294` — trailing prose auto-sends whenever a turn ends with text and
no `reply` call. Right on the interactive path (a person is staring at the chat); on
`source: 'job'` turns there is no person waiting, silence is the *expected* outcome
(§13.1), and the same path delivers the model's thinking.
**Saw:** *"…there is nothing for him to act on right now. I will stay quiet until his daily
brief on Wednesday"* — sent to the coach. *"Since the business is already live… no
follow-up is needed"* — sent to the admin under a template header reading *"something
needs your attention."* *"Watching 1 thing: 1. Check if the student attended…"* — watch
bookkeeping, sent, twice.
**Blast radius:** every watch that correctly decides to do nothing still messages someone,
which is rule 2 inverted and doctrine 1 broken by the runtime itself, not the model.
**Where it lives:** gate the trailing-prose send on turn source in `runTurn`
(`lib/agent/loop.ts:1294`). A job turn that wants to speak has the `reply`/`send` tools.

### F-C · Watches multiply without a subject key, and the spam crowds out real messages

**Root:** R5 (comparison on unnormalised values — dedupe is by slug, and the model mints a
fresh slug every time) + R8 overshoot.
**Saw:** seven `agent_task` watches about the same two unmarked registers
(`follow-up-mon-register`, `remind-unmarked-registers-aug-17-19`,
`remind-monday-register-aug17`, `unmarked-registers-reminder-aug-15`,
`follow-up-missing-registers-aug-17-19`, `arjun-register-followup-monday`,
`arjun-register-nudge-monday`) firing in one clock advance, sending the coach **seven
near-identical messages in three minutes** — one referring to him in the third person.
Then the consequence: when a parent's cancellation needed to reach that coach, the
headcount update was **SUPPRESSED: recipient_frequency_cap** — the spam had spent his
budget and the one message that mattered was the one dropped. Also minted this pass: a
"has the prospect replied yet" watch (rule 8's exact forbidden case), a check-in
duplicating the standing `coach_day` job, a chase on an open confirmation button, and a
makeup follow-up nobody asked for. `score`: 34 `reflect:schedule` calls in 55 turns.
**Blast radius:** recipients are trained to ignore the number, and the frequency cap then
silently drops operational traffic.
**Where it lives:** `schedule`'s mint path — a watch needs a *subject* key (what is being
watched, normalised) the way `tally_line.dedupe_key` normalises billing identity, so a
second watch on the same subject supersedes rather than accumulates. The reflection prompt
minting most of these is the symptom, not the fix site.

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

### F-E · A fabricated roster count reached a coach (R10, live)

**Root:** R10 — claims of fact have no structural check.
**Saw:** Deepak's onboarding acknowledgement: *"12 players are down to attend"* Saturday
Advanced. The table holds **1** enrollment. The turn made exactly one tool call
(`onboard_coach`); no roster was read. Every existing axis scores this turn as a pass.
**Blast radius:** a coach plans a session for twelve and meets one; trust in every number
after that is gone.
**Where it lives:** R10's shadow-mode gate (DRIVING.md already specifies how to build it,
including why not to ship it live). This pass adds the second motivating instance.

### F-F · The cancel flow confirms twice, and the runtime coaches the model into a false claim

**Root:** R4 — the "confirm before acting" guarantee is held by both the model (composes
its own confirmation with buttons) and `client_cancel` (whose unconfirmed call mints
`CL-CANCEL-CONFIRM`). Tapping the model's [Yes, cancel Friday] produced a second *"Just to
be sure — cancel Meera…?"*.
**Also saw:** the plan runtime's receipt for the unconfirmed call said *"This is done — it
ran… Say what you did, in the past tense"* — about an operation whose only effect was
sending a confirmation. The model obediently drafted *"OK. Cancelled for Meera"* (false;
zero rows). The send path happened to suppress it this time.
**Blast radius:** the person confirms twice for one seat; and the hint text is one
suppression-miss away from shipping a false "cancelled".
**Where it lives:** the model's button should mint `confirmed:true` when its own message
was the confirmation — or better, the model never pre-confirms an operation that confirms
itself; the operation registry knows which ones do (`client_cancel`, `decline_coach`…),
and the plan validator can refuse a composed confirmation wrapping a self-confirming op.
The "This is done" hint needs to say *what* ran when the effect was only a staged message.

### F-G · Template prose is glued to composed prose, and newlines are eaten

**Root:** R1 — composition happens in two places and the seam ships.
**Saw:** *"Ace TT Academy: your day. Your Wednesday 19 August:…"* · *"Kiran has a class
coming up. Kiran has Beginners Wednesday at 6:30pm"* · *"still need your confirmation.
Still need to know about Intermediate"* — every out-of-window send says its subject twice,
because the template's fixed lead-in and the composed body each carry it. And the digest's
bullets arrive inline (*"unpaid: • Rajesh (₹6000) • Latha (₹2500)"*) — newlines collapsed
somewhere in `renderTemplate`/`buildTemplateParams` (`lib/messaging/send.ts`).
**Blast radius:** every templated message reads machine-written; the digest's structure —
its whole value — is flattened.

### F-H · Reminders land at 4:30 am — **FIXED 15 Aug 2026 (month drive)**

**Status:** `pullOutOfQuietHours` (`lib/jobs/util.ts`) clamps a `client_reminder`
falling inside the academy's quiet hours (settings `quiet_start`/`quiet_end`,
default 21:00–07:00) back to the last waking minute before them — the evening
before, for an early-morning time; never later. Verified live: the Tue 5:00am
reminder re-minted at Mon 20:59 and delivered. The record below is the evidence.

**Root:** R6 (a commercial default applied without ever being chosen).
**Saw:** three `client_reminder` jobs fired at 23:00Z = **4:30 am IST** — the 14-hour
default lead subtracted from a 6:30 pm class. The ideal's reminders arrive the evening
before at 4:30 **pm**.
**Where it lives:** the reminder scheduler (`lib/jobs/handlers/client.ts`) needs a
waking-hours clamp in the academy's timezone — pull a send that would land in the night
back to the previous evening. A per-academy quiet-hours pair belongs in `academy.settings`
with a sane default, not a new column.

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
  players, and the register Flow could never be sent (`drive register` then reports "no
  register form has been sent"). The "already marked" predicate needs to mean *every
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

### F-J · The model went text-only, and media had nowhere to land — **FIXED this pass, 15 Aug 2026**

**Status:** fixed as part of the DeepSeek migration. Media that arrives is answered by the
runtime, in words, before the model is asked anything (`mediaRefusal` in
`lib/agent/loop.ts`), and everything that *invited* media — the post-setup timetable
message, `onboarding.md`, doctrine 16, §14.5, §7.1 step 2 — now offers the road that
works instead: type the week in one messy sentence, read back before anything is created.

**Root:** R2 (a capability removed upstream leaves the surfaces that promised it intact).
The new model client is text-only: an image or audio part is rejected at schema validation
before auth is even checked. Left alone, three things follow, and only the first is
obvious — the request fails; the turn produces nothing; **the person hears nothing at
all**, having just been told by the product itself to send a photo of their whiteboard.

**Why it is not a prompt fix.** The obvious version is a line in the prefix — "you cannot
read attachments, say so". That is an instruction the model follows four times in five,
and the fifth is somebody sitting in front of a chat that never answered. Going quiet is
the one failure a person cannot tell apart from being ignored, so it gets a runtime send,
on the inbound path, unconditionally. The sentence differs by kind: a voice note is
somebody whose English is faster spoken than typed and the reply admits the cost; a photo
is usually the timetable and the reply names the route that still works.

**What it takes away, stated plainly:** voice notes are how half of India types, and this
product can no longer read one. §14.5 records the whole trade rather than deleting it.

**Also fixed alongside it:** an inbound carrying *neither* text nor media — a shared
contact card, a sticker, a location — used to fall through every branch of `runTurn` and
send nothing. Same guarantee, same place.

### F-K · Outcomes are asserted, never read back — driven 15 Aug 2026, arc-slim flash thinking-low

**Root:** R10's other half. Events have no traceability rule the way numbers do: the tail
demands every number trace to a row, and the model obeys it — every fabricated thing in
this run is an *event*. Eleven findings, one habit: the model describes an outcome
instead of checking one, **with the evidence in context every time** (rounds share all
calls and results; the lie about escalation was composed with five rounds of
contradicting results in view).
**Saw** (`.probe/arc-slim/deepseek-v4-flash--thinking-low.json`):
1. *"I've flagged it to the owner"* — no handoff, no send; the false claim was then
   written into the watch instruction and stored. Composed in the tool-less recovery
   round, whose guard named only the future tense; `handoff` was callable for all five
   prior rounds and never called.
2. Admin asked "has anyone left this month?" → *"Nobody's left"* — read `ended_on` only;
   the announced departure and the stuck removal from (1) went unmentioned.
3. `opt_out` called with `confirmed: true` — a claim the person had tapped; runtime ignored it.
4. The same confirmation sent twice — the first result's `sent` was in context, unread.
5. `end_enrollment` retried with byte-identical args after an identical failure.
6. `request_payment` minted for a parent who only asked their balance (RLS refused).
7. The discretionary watch messages on both outcomes while the reply promises "you'll
   hear nothing otherwise" — prose and watch disagree in both directions.
8. "yes I'm coming" over a two-row result → one session confirmed silently, *"I won't
   ask about it again"*, second unconfirmed session never mentioned.
9. "Roster" to the owner ×3, "on the backend" to a parent — `lint.ts:279` catches
   state-machine words only in quotes, so bare jargon ships.
10. 87–112-word bulleted status dumps three turns running (rule 4/12).
11. Deixis to the invisible: "everything above", "That's the figure" — openings that
    point at things the recipient cannot see.
**Why the claims checker missed the worst one:** `DONE_VERBS` (`tools.ts:122`) holds
doing-verbs only — *flagged/escalated/told/raised/notified* are not in it, so the
escalation lie scored `claimedDone: false`. Same seam as (9): every enumeration leaks at
the instance nobody listed.
**The tested exception:** doctrine rule 6 was rewritten (said-is-not-done, events trace
to results the way numbers trace to rows) and the recovery round's tense guard completed —
a deliberate, measured exception to this file's no-prompt-fix rule. Pre-registered: the
edit should move 1/3/4/7/8 (and 2 only via 1); it gets no credit or blame for 5/6/9/10/11.
Kept only if the re-probe of the same arm improves those cases without regression;
reverted and recorded here otherwise.
**Structural fixes, landed separately after the re-probe so the measurement stays
one-variable:** routing verbs into `DONE_VERBS`/`CLAIM_TABLES` (a message-to-that-person
or handoff footprint makes them true); bare-word jargon in lint; an actions block beside
`recentLookups` so prior turns' attempted ops travel with their status ("refused twice,
nothing written") and "did I actually do it?" is answerable without querying audit_entry.

### F-L · Mid-round prose is a surface the model believes in and the runtime drops — **ADDRESSED 15 Aug 2026**

**Root:** R2 (a surface that half-exists: final-round prose ships on interactive
turns, everything else is a notebook — and the inconsistency teaches the wrong
lesson). Three instances in one driven week: a roster read-back composed and
lost; the "No" to "did the intros go out?" composed beside a `schedule` call and
lost; a Friday watch that kept its promise in prose, which the F-B job-turn
guard rightly discarded — the promise broke silently.
**Fix (interface documentation, doctrine-17 class — a fact about the harness,
not a behavior rule):** the `reply` declaration and the job-turn situation line
state the channel contract. Verified: the re-fired watch called `reply` and the
report landed.

### F-M · A model-authored steps button does what its prose never said — **chokepoint built 16 Aug 2026**

**Status:** the diff-carrying read-back exists. `withRuntimeDiffLine`
(lib/agent/tools.ts) runs on both paths a message leaves a turn by: any message
to the acting person carrying a `steps` button gets the runtime's own summary —
counts of writes, who hears — appended under the model's prose ("Tapping runs
exactly this: …"). Steps matching a plan previewed this turn reuse its stored
summary; novel inline steps are previewed at mint time, which is also the first
moment a broken button can be caught before a person taps it. A body already
carrying the summary verbatim is left alone. The record below is the evidence.

**Root:** R10's tap-shaped corner. The runtime computes the diff (`previewPlan`)
but a model-minted `steps` button carries only the model's own summary, so what
the person confirms and what the tap writes can diverge in either direction.
Driven, three times in one month: go-live promised intro messages the steps
never contained; a trial's [Confirm] converted it and minted ₹1,600 of charges
behind "free, nothing to pay"; a cancellation's read-back said "all 3 families
are told" over steps holding only the session write. Partial mitigations landed
first: staged previews say NOTHING HAS RUN in their own voice, and bare "Done"
is a claim (`986939f`); a trial is free until converted on purpose (`7fa4bcf`).

### F-N · The model lives on the tenant clock; `created_at` lives on the wall — **FIXED 16 Aug 2026**

**Status:** migration `0027_tenant_time_stamps.sql` — every timestamptz default on a
tenant-scoped table follows `app.now()` (`sender` and `sim_clock` exempt). In production
the offset is zero and nothing changes by construction; in a driven world, rows land on
the clock the queries already read, so "what went out today?" answers truthfully and the
digest's 24-hour delivery window survives a clock jump. Relies on the forward-only drive
discipline, stated in the migration: a mid-drive clock reset would disorder stamps the
same way the wall clock used to.

**Root:** F-A's ghost, one table over. In a driven world the tenant clock moves
and `message.created_at` (and `turn`, `audit_entry`…) stayed wall time, so any
model query filtering "today's messages" by tenant date returned a confident
empty — driven: the model retracted a TRUE "the cancellations went out" on the
strength of exactly that read, then diagnosed its own wrong-column error when
challenged and corrected itself. No production impact (the clocks agree); every
driven "what went out today?" was corrupted.

### The month drive, 15 Aug 2026 — what else it found and fixed (post-`049f28b` brain)

Structural fixes landed from live evidence, each its own commit: F-F all three
layers (`db7f1b6` one confirmation per action; `84b1544` no defanged buttons);
F-H quiet hours (`1b8a2c0`); F-I register universe (`748f93f`); family-notice
absences not reported back (`f23435d`); one family, one outcome (`a0cba07`);
`book_trial` session lookup as svc (`16ada1a`); trials never bill unconverted
(`7fa4bcf`); mute keys give "just the bill" a structural home (`e4f93e3`);
family-initiated leave routes to the admin instead of dying as "the world
moved", and the executed end closes rule 15's return trip (`4320558`).
Full narrative: `.probe/drive-month/` (journal.md, score.md, transcript/).

### F-O · The post-drive read-through, 15 Aug 2026 — one blind mini-brain, one refusal-taught gate, three falsified facts

Found by reading the whole of `.probe/drive-month/` against the brain, after the drive closed.
Fixes below landed same day; each is its own commit.

- **Reflection is a blind mini-brain, and two judged failures share that root.** `reflect()`
  runs on ~300 tokens with no prefix: it makes a schema-placement judgement (row vs fact)
  without the schema and a duplication judgement without the catalog. The judges' only
  outright fail (rule 10, the memory store) and the only rule-8 recurrence (T048's
  reminder watch duplicating the standing `client_reminder`) are one problem, not two.
  Its own prompt was also generative: "a policy that came up" is the exact license behind
  the T004 schedule copy and T066's invented pro-rata policy. **Fixed:** the policy
  invitation is gone from both the reflection prompt and the `remember` declaration,
  replaced by the placement boundary; reflection's prompt now carries the standing-jobs
  fact its duplication judgement needs; the "what you ran" line marks refused calls as
  refused. F-D's structural write-gate remains the named home and is still unbuilt.
- **The commit gate was taught only by refusal, once per consequential flow, forever.**
  `commit`'s declaration invited the call; the gate's rule lived solely in the error
  text, and history is rebuilt from message text so the lesson could not persist. Cost,
  measured across the month: a wasted round and pre-composed "Committing it now" prose on
  six flows — and at T054 the post-refusal re-stage downgraded `cancel_session` into a
  raw session write, losing the operation's sends, which is how "All 3 families are told"
  shipped over steps that told nobody. **Fixed:** the gate (`needsPreview`, §14.2) is
  stated on the `commit` declaration; the refusal stays as backstop.
- **Three prefix facts the runtime falsifies.** "Nothing bills itself" — `monthly_lines`
  mints in full, unasked; the model's "billing starts itself on 1 Sep" (T047/T048),
  judged as negating a cached fact, described the shipping product accurately. "A trial
  is auto-confirmed" vs the tap-gated reality. The digest's "code guarantees each one
  reaches you" vs the raw-write path raising no moment (T054→T056). **Fixed:** all three
  rewritten to what is true (facts state — so they must be true, or the block trains the
  model to distrust it). The ask-first billing behaviour, if wanted, is a structural
  decision still open (mid-month joins still bill in full — F-I carried).
- **Copy promising what nothing keeps.** `decline_coach`'s "I'll sort out cover" / "I'll
  find cover" (a person who may not exist — the operation actually tells the owner and
  offers the others; the copy now says so) and `end_coach`'s "I'll tell you who's taking
  it as soon as it's set" (no job keeps it; dropped). Null result, verified: T007's
  invite-chase promise IS kept — `coach_not_onboarded` is planned and handled (48h).
- **Open, documented, not fixed here — the two-author seams.** Every remaining
  claim-shaped defect is a place two authors describe one act and nobody reconciles
  them: template lead-in + composed body (F-G), model summary + runtime steps under one
  button (F-M), model reply + operation ack as adjacent messages (`drop_watch`'s
  "Dropped — I'll stop watching that" beside the real answer, T014), digest promise +
  raw-write path. The product has one-send-path discipline for delivery; it needs
  one-author discipline for meaning — wherever both describe the same act, the runtime's
  description travels with the model's at the point of confirmation. F-M's diff-carrying
  read-back is the first instance.
- **Runtime copy that fails the census label test.** "Added 2 charges." for two ₹1,000
  *credits* (T066 tap — `plural()` maps `tally_line` blind to sign; constraint for the
  fix: diff table names feed `MONEY_TABLES`, so fix the rendering or carry a note from
  the adjust step, never rename tables in diffs). "N steps matched no rows — check that
  part landed" lands on the person with nothing they can do (deliberate R7 bluntness —
  the tension is real in both directions and is a design call, recorded here). Also
  logged: the final Sunita balance read-back attributed the August pro-rata credits to
  September (total right, labels wrong — rule 5-adjacent, model behaviour, one instance).

### What is now known-good (null results, worth not re-driving)

- **Coach onboarding is fixed.** [Looks right] / [Something's wrong] both appear, the
  schedule and time are correct and locally rendered, the coach stays `invited` until the
  tap, and `onboard_coach` runs only on [Looks right]. The handoff's "activated without
  confirming" did not reproduce.
- **Times render in the academy's idiom on job messages** — "6:30–7:30pm", "Wednesday at
  6:30pm". The uncommitted timezone fix is verified on live output, not just typecheck.
- **The R10 pay-rate instance did not reproduce**: "what do we pay vikram" → *"Vikram is
  at ₹500 per session"*, read from the row, one line.
- **The cancel flow's copy is nearly ideal** — cost before the tap, scope stated, timely
  cancellation recorded correctly, [Find a makeup] offered.
- **Out-of-window sends keep a tappable button** where the template allows one, and the
  "Just reply here — a word is enough" fallback appears where buttons were dropped.
- **Placeholder phone numbers are refused** at the operation boundary (uncommitted fix,
  exercised on `add_coach` this pass).

### F-P · Verifying F-O's own fixes, 16 Aug 2026 — the behaviour landed, three mechanisms did not

F-O's five commits were checked two ways: eight regression cases driven through the real loop
in a fresh business (`npm run probe -- --suite f-o`, evidence in `.probe/fo/`), and a read of
the code each commit's message describes. **Seven of eight cases held; two of the five commits
keep every claim they make.** The gap is instructive and is the whole entry: a claim can be
kept on every prompt anybody thought to write and still be false, because a mechanism that
never fires looks exactly like a mechanism that is never needed.

- **The commit gate works, and the tool it documents cannot succeed.** Live: `commit` was
  called **0 times in 13 turns**, against **7 of 7 refused** across the month drive — the
  wasted round is gone, and money, fan-out and destructive flows all went straight to a
  read-back with a steps button. But `commit` has no reachable success path at all: a plan
  that does not gate is executed inside `plan` and returns `handle: null` with "do NOT call
  commit" (`tools.ts:1571`), and every handle that IS stored carries `needsConfirm: true`
  (`tools.ts:1605-1614`, `pendingMeta` always live at `loop.ts:983`), so `tools.ts:1644`
  refuses all of them. The declaration's closing sentence — "Commit is for plans that stay
  inward" — therefore describes a path that does not exist, which is a two-author seam of
  exactly the kind F-O named: the runtime's note at `tools.ts:1598` says the opposite at the
  moment it matters. **Fix site:** state that `commit` only ever confirms, or retire the tool.
  Also imprecise: "changing existing rows in bulk" is `changed > 1` (`plan.ts:1717`) — two
  rows, not bulk — and `plan.ts:1719` gates on 40 rows counting inserts.
- **Reflection's refusal marker cannot fire.** The "what you ran" line marks a call refused
  from the trace's `error` field (`loop.ts:1820`), and that field is written only when a tool
  *throws* (`loop.ts:1234`). The loop computes the fuller notion one line earlier —
  `Boolean(threw) || 'error' in out.result` (`loop.ts:1207-1209`) — and drops it. Nearly
  every refusal in this product returns instead of throwing, the commit gate included
  (`tools.ts:1645`). Measured against the drive's own rows: **21 of 21 refused calls would
  still reach reflection unmarked.** **Fix site:** carry `failed` onto the trace at
  `loop.ts:1234`, not a change at 1820.
- **The standing-jobs fact omits `dunning`, and that is the one case that broke.** The fact
  (`loop.ts:1830`) lists reminders, register chases, coach days, brief and digest, and "bill
  the month" — which is `monthly_lines` *minting*. Chasing an unpaid bill is `dunning`
  (`kinds.ts:20`), a self-re-enqueuing ladder (`money.ts:474`, `money.ts:613`), and rule 8
  names it explicitly. Asked "make sure meera gets a nudge about her bill", the model minted a
  private 28 Sep watch doing precisely what dunning does. No dunning row existed yet to be
  read, so the fact was the only thing that could have told it. **Fix site:** the enumeration
  at `loop.ts:1830` — one clause.
- **One falsehood traded for another in the digest fact.** Two of the three rewrites are
  accurate against the runtime (the tally minting in full with no pro-rating; the trial
  booking on the prospect's own tap — both confirmed live). The third overreaches:
  `catalog.ts:547-551` now says a raw write "raises no moment … only the standing schedules
  scan the rows", and `0004_functions.sql:283-286` falsifies it — `attendance_enqueue_outcome`
  fires `client_outcome` from the row, on insert or update, and the migration's own comment
  says that is deliberate so a model-authored transaction raises it too. Invited failure: the
  model writes attendance raw, believes nobody was told, sends its own outcome message, and
  the trigger sends one as well. **Fix site:** name attendance as the exception in that
  paragraph.
- **The copy fix is real, and is the model for the others.** `decline_coach`'s replacement
  promise has a send behind it (`operations.ts:2025-2051`), verified live from both ends: the
  coach read "the owner's been told it needs cover" and the owner received "Evening Fitness
  tomorrow 7pm has no confirmed coach". One edge left: that step marks the declining coach as
  its own subject with `is_escalation`, so where the coach IS an admin, gate 3
  (`send.ts:564-566`) suppresses it as `escalation_about_self` and the sentence is literally
  unkept — harmless, since the owner is the reader, but it is the solo case the commit cites.
- **Logged, not fixed.** A register on a `per_session` rate still gates: `needsPreview` tests
  money tables (`plan.ts:1705`) before the single-own-scope exemption (`plan.ts:1710`), and
  `mark_attendance` writes a `tally_line` at that rate — a diff in front of a coach standing
  on a court, which the function's own comment says row 1 exists to remove. Pre-existing, and
  invisible to the button path because a tap never re-previews. Also: reflection stored a
  verbatim restatement of the prefix's own billing fact ("Monthly fees are billed in full on
  the 1st…"), which is neither a row copy nor an invented policy but is redundant with the
  block it came from — a third shape of memory pollution, one instance.

**Harness.** The regression suite is `--suite f-o` in `scripts/probe-model.ts`, reusing the
arc's engine and five of its setup cases by reference. Two harness traps worth keeping: a
check query that throws is recorded as `expectation query failed` and reads exactly like the
model failing the case (`jsonb_array_length` raises on the explicit JSON `null` that 36 of the
drive's 189 outbound rows carry — guard with `jsonb_typeof`); and reply-text checks are
written as negatives, so silence passes and only an assertion fails.

### F-Q · The whole-drive re-read, 16 Aug 2026 — the mechanisms F-P named, plus what nobody had catalogued

The month drive's 76 transcripts read end to end against the brain, with F-P's findings as the
starting list. Every fix below landed this pass, each at the layer that can hold it; the new
finds are the entries with transcript references, because the curated record (journal, judges)
had missed them.

**F-P's four mechanisms, closed.** Refusals now reach the trace — `failed` (thrown OR returned
error) stamps `error` on the trace entry at the one site that writes it, so reflection's
"(refused — it did not happen)" marker can actually fire (was: 21 of 21 refusals unmarked).
The standing-jobs fact names `dunning`, at BOTH decode points — the reflection prompt and the
`schedule` declaration, because `fo-watch-dupe`'s duplicate was minted by the main loop, not
by reflection. The catalog digest's raw-write paragraph names attendance as its deliberate
exception (the outcome trigger), so a raw mark no longer invites a duplicate outcome message.
And `commit` is retired from the declared surface: the truth — an ungated plan has already run;
a gated one commits on the tap — is stated on `plan`'s declaration, the handle's real consumer
(`{op:'commit',args:{handle}}` on a BUTTON) is named there, and the `runTool` case stays as a
backstop that answers any stray call with the route that works. `needsPreview` now applies the
single-own-scope exemption before the money-tables test, exactly as its own comment always
claimed — a register at a per_session rate no longer puts a diff in front of a coach on a court.

**New find — one child became two people (T010 → T073).** "Aarav in beginners and fitness"
arrives as two `add_family` entries both named Aarav, and the per-entry loop minted a person
and a player for each: the drive's Aarav existed twice, with two person ids, and the family's
leave then failed on "needed 2 rows and matched 0" (T071) with the duplicate surfacing in the
repair reads. §10.1's one hard rule is never to create a second person for someone already in
the roster. Fixed in the operation: entries group by the same `normalName` the holder check
trusts, a same-name player already on the household's account is reused across calls, and a
duplicate live enrollment in one class is a no-op.

**New find — the one-confirmation guard never armed (F-O's decline trace, explained).**
`ToolCtx.confirmationAskedTo` (db7f1b6) is fed by `is_confirmation_request` on the staged
message, and only `opt_out` ever set it — `client_cancel` and `decline_coach` staged bare
confirmations, so the runtime never knew one was on the screen and the model's re-worded
second confirmation shipped beside the operation's own (two "Just to be sure" messages a
minute apart, the second with its yes-button refused at mint). One flag on each confirmation
step; `undo`'s gains it too. The guard's plumbing was verified live at F-O and was fed by one
operation out of four.

**New find — a permission refusal told the model to fix the wrong thing (T062, T065).** The
RLS repair hint had one answer — "add academy_id and the same statement will pass" — and the
month's two money-shaped refusals were the other kind: a parent's session failing
`is_admin()`. No rewording can ever pass, and the hint sent the model flailing; both times it
told the person "the owner will confirm" while the owner heard nothing (rule 15's exact
failure). The hint now detects a role-shaped policy on a non-admin session and names the
working route: reply to the ADMIN with the exact change as a steps button — their tap runs it
under their own permission — and only then tell the asker it is routed. The same mechanism is
stated as a fact in DOMAIN_FACTS ("routing means the admin actually hears").

**New find — receipts counted messages as people (T075), and credits as charges (T066).**
"2 people have been told" went to an admin when one mother had been told twice; the receipt
now counts distinct recipients, and misses stay in message terms because a message that did
not go out is the unit an admin acts on. `plural()` mapped `tally_line` blind to sign —
"Added 2 charges." for two ₹1,000 credits — and now reads the sign off the diff rows it
already holds.

**Rule 7, structurally (T060, T075, and the reminder pairs).** A plan's staged messages merge
per recipient-and-moment at the one chokepoint that sees them together (`mergePerRecipient`,
preview and execute both), so moving a two-slot class tells each family once, and ending a
child's two enrollments tells the mother once. Sibling reminders merge where the first job
fires — the sibling's pending job is cancelled in the same transaction — with the multi-child
[Can't make it] deliberately handing disambiguation back to the model rather than guessing.

**Rule 9's residue (judge-found).** `register_expiry` fired at 22:30 inside the product's own
declared quiet window. A new forward-deferring clamp (`deferPastQuietHours`) holds the ALERT
until morning — never pulled back, which would fire it before the grace it grants — and the
run-time precondition recheck means a register marked overnight simply skips.

**The conversion moment got its operation (T047–T051).** A trial is free until converted on
purpose (7fa4bcf), and nothing existed to convert one — the drive's single conversion was
improvised raw SQL over 120 seconds and ₹1.06, and F-M's worst instance rode a model-composed
conversion. `convert_trial` makes the decision explicit (start date, rate, the family told
what they are signed up for), and the trial-conversion fact joins DOMAIN_FACTS so "she loved
it, how do we continue?" stops being answered with "nothing to set up" (T047's wrong answer).

**Copy and seams.** The out-of-window fallback header stops claiming events the runtime does
not know happened — "a change to your schedule" on a first contact (T014/T015) becomes a
neutral "an update about your classes"; a catalog moment still gets its specific phrase.
Template params flatten newlines to " · " instead of erasing a list's structure (the digest's
bullets, F-G). `decline_coach` no longer promises "the owner's been told" when the decliner IS
the only admin, and no longer stages the self-escalation the send path was guaranteed to
suppress. `mark_attendance`'s declaration says where a coach's comment goes — the entry note
the parent reads, not memory (T046). The go-live tap receipt reads the fresh
`onboarding_state` off its own diff instead of offering `[Set up the business]` to a business
that went live one second earlier (T012).

**The adversarial pass over the fixes themselves (same day).** Twenty-four review agents were
run against this entry's own diff before it shipped, five slices, every surviving claim
re-verified by an independent refuter. What they caught, and what changed because of it —
kept here because a fix pass that does not audit itself is the F-P lesson unlearned:

- *The route the hint named did not exist for the sessions that need it.* "Send the admin a
  reply" assumed the model could resolve the admin's contact, and a parent's session cannot —
  `academy_admin` shows a non-admin only their own row, and the f-q probe reproduced T065
  exactly: five reads of an "empty" admin table, then "no admin on record" about a business
  with an owner. `reply` now accepts `to_contact_id: 'admin'`, resolved by the runtime the way
  `handoff` always has; the schema doc says an empty read of that table means "not yours to
  see", never "no admin exists".
- *The F-M mint-time preview had live side effects on failure* — a CHANGED_NOTHING inside the
  annotation check walked into `escalateRefusal` and paged every admin with an internal intent
  string. `previewPlan` grew a `noHints` mode; the mint-time check changes nothing and pages
  nobody, whatever the steps turn out to be.
- *A staged plan read as done in the next turn's context.* `recentActions` detected staging by
  a field no staged result carries; a never-tapped payment request rendered as "done — wrote
  1 row(s)" under a heading forbidding redos. All three staging spellings are read now.
- *`convert_trial` could never bill the conversion month* — the period's `monthly_lines` job
  had already run and skipped while the row was a trial, and job dedupe keys are permanent.
  The operation now mints the current period's line itself, same dedupe key as the billing
  job so whichever runs second is a no-op; and `started_on` only ever moves backward, so a
  future billing start stops hiding a still-attending child from every roster.
- *`add_family`'s reuse path could resurrect a child invisibly* (an inactive player reused
  without reactivation) *and no-op silently onto a live trial* (the not-exists guard). Reuse
  reactivates; a live trial in the entry's class is upgraded with the entry's own rate.
- *The sibling-reminder merge never fired in the common case* — the runner claims the whole
  due batch as 'running' before any handler runs, and the cancel targeted 'pending' only.
  It cancels 'running' too, and every reminder rechecks its own row first (§13 rule 2).
- Smaller: `mergePerRecipient` no longer discards a second message's buttons, subjects or
  gate flags (differing buttons stay separate messages; subjects union; a merge never pushes
  a body past the wire cap); the RLS route hint keys on write-command policies that ALL
  demand the role, instead of firing on every table whose policy text mentions `is_admin()`;
  the shadowed `remember` OPERATION now passes the same placement gate and `business` alias
  as the primitive; reflection re-offers `remember` after a gate refusal so the legitimate
  half of a fact still gets stored; the dunning sentence says what the ladder does (spaced
  nudges, then the admin) instead of overclaiming persistence; a mixed charge+credit diff
  says "tally lines" rather than picking the charge side; `sanitizeParam` stops eating
  non-bullet hyphens; and `decline_coach` distinguishes "the others will be asked to cover"
  (assigned, unconfirmed) from "nobody else is on it".

**Two behavioural data points from the verification runs, recorded rather than fixed.**
One f-q arm HELD an explicit "switch it on": *"I'm not flipping the switch yet — Arjun hasn't
confirmed his invite, Advanced has no coach"* — staged the UPI write, drafted the invite, and
asked for the gaps to be resolved first. Defensible judgement over a direct instruction, and a
different reading of doctrine's "the admin decided" than the drive's other arms took; if the
next drive shows it again, the question is whether the concern should ride the confirmation
button (state the gaps, offer [Go live anyway]) rather than replace it. And the same arm shipped
*"I've set a watch for end of month"* as trailing prose with no `schedule` call behind it — the
trailing path only substitutes when a plan is pending (a read-only turn describing past work
must not be overwritten), so this is the F-K residue the R10 shadow gate exists for; the
probe's UNBACKED CLAIM marker caught it, which is that marker earning its keep.

**Open, still.** F-C's normalized subject key on `schedule`'s mint path (the fact now guards
both decode points; nothing structural refuses a duplicate watch). F-E/rule 5's R10
shadow-mode traceability gate (specified in DRIVING.md, unbuilt). Reflection's remaining
un-gated shapes: parentage restatements and self-authored policies with no figure in them.
Mid-month joins still bill in full until an adjustment (F-I carried; `convert_trial` names the
partial month as the admin's separate decision rather than promising it). Pre-deploy
`register_expiry` jobs keep their old in-quiet-hours times (dedupe keys are permanent; the
clamp applies from the next mint). A `steps` button that fails its mint-time preview still
ships and fails politely at the tap — mint-time refusal with a reason is the next step if it
recurs. And the one-confirmation guard silences a second, unrelated answer in the same turn
by design — the documented tension, unchanged.

---

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

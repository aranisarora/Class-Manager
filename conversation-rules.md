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

### F-D · Memory is a copy of the schema plus things that are not facts, and reflection is the generator

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

### F-H · Reminders land at 4:30 am

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

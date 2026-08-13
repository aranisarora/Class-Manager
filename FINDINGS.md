# Findings

## What this file is for

The product is a WhatsApp-native manager for Indian coaching businesses: the chat is
the whole interface, and the bet under it is a **general agent on general primitives**
— read with SQL, write with SQL, send, remember, schedule, show a view — bounded by
the permissions of whoever is talking.

**The unit of work is a class of failure, never an instance of one.** "The bot cannot
remember what it looked up" is an entry here. "The cancellation template says the
academy name twice" is not — it is evidence, and fixing it alone teaches the system
nothing.

**This file says what to do and what not to redo. The *why* of each fix lives in a
comment at the fix site**, which is where somebody changing that code will actually
be. Do not restate those here.

---

## If you are an agent about to drive this

Read §"The roots" and §"What has never been driven" before you start, and §"How to
record a finding" before you write anything. Several agents write into this file. A
finding nobody can compare against another finding is worth about half of one.

**Then read the three sections at the bottom, in this order — they are newer than
everything above them and two of them overrule it:**

- **§"Corrections to the log above"** — three of F1–F9 are filed against the wrong root.
  Acting on F9 or F2 as written means building a fix that cannot fire.
- **§"Fixed, and what each fix takes away"** — six are done. Do not re-find them.
- **§"The next drive: the half that has never run"** — **this is the assignment.** If you
  are here to drive, start there and ignore the rest of this paragraph.

**Four rules that save the most time:**

1. **Check the roots table first.** Most new defects are another instance of a root
   already listed. The cheap win is nearly always an already-known root somebody has
   not finished applying, not a new one.
2. **Do not report an instance.** "The reply said 6:30pm when the row says 06:30" is
   evidence. The finding is "read-backs are composed from intent rather than from what
   was written." If you cannot state the class, you have not finished looking.
3. **A green tool result is not evidence.** Check the database. `drive score`,
   `drive world`, `drive money`. Twice in earlier rounds the bot said "I've added those
   families" and the database disagreed — once because nothing ran, once because it ran
   twice, and the transcript reads identically in both cases.
4. **A red transcript is not evidence either.** `drive thread` prints `catalog_id` and
   `unsolicited` as dim chips of its own (`scripts/drive.ts:178`). A round of this was
   written up as "internal template codes are leaking to customers" before the message
   bodies were checked and every one came back clean. Before you file anything you saw
   in a transcript, ask the `message` row whether the user would have seen it.

### How to record a finding

Append to §"The log" at the bottom. One block per finding, this exact shape:

```
### F<n> · <one sentence naming the CLASS, not the instance>

**Root:** R1–R10, or `new` with an argument for why none of them fits.
**Saw:** the shortest reproduction. Command, what came back, what the database said.
**Blast radius:** who is hurt and how they would find out. "Nobody would" is the
worst answer and the most important one to write down.
**Confidence:** certain / likely / suspected. Say which, and never round up.
**Where you think it lives:** file, or "unknown — here is what I ruled out".
```

Number sequentially from the last `F<n>` in the file. If two agents collide on a
number that is fine — the later reader will merge them; a lost finding is worse than a
duplicated one.

**Do not edit anybody else's block, and do not fix anything you find.** A separate
pass reads this file and fixes roots. If you fix as you go, the next agent drives a
different product from the one the rest of the file describes, and the round's findings
stop being comparable.

**Write the null results too.** "Drove the whole coach ladder with families on it, no
defect found" is one of the most valuable lines you can add, because it is the only
thing that turns "assume broken" into "known good", and nobody else has to redo it.
There is a §"Driven and found good" section for exactly this.

---

## Finding the root, and knowing when you have

A bug you can see is almost never the thing to fix. The product is a model on top of
primitives, so **the same root produces a different-looking failure every time it
fires** — which is why fixing what you saw makes the bot reliable at that one thing
and no more reliable overall.

Four tests, applied in order.

**1. What would have had to be true for this to be impossible?**
If the answer is *"the model would have to remember"*, you have not found the root.
If it is *"the schema would have refused it"*, *"the gate would have dropped it"*,
*"the mint would have rejected it"*, you have. Behaviour belongs at the lowest layer
that can hold it: pushed down, it becomes free and unforgettable.

**2. Would this fix have to be repeated somewhere else?**
If yes, you are at a call site, not a chokepoint. Walk up until there is exactly one
place all the traffic passes. The lint had been bypassed by the product's main reply
path for its entire life precisely because it was applied per-caller.

**3. Does the fix make a *category* of thing work, or one thing?**
"Validate this view's query" is an instance. "Run every view's queries at mint" is a
root. The second one also fixed views nobody has written yet.

**4. What does this fix take away?** Every guarantee costs something. If you cannot say
what, you have not looked. Three of an earlier round's fixes were correct and each
removed a capability nobody was measuring (R9).

---

## The roots

Every entry in the ledger is an instance of one of these ten. **When you find a new
defect, check these first.**

| Root | Instances | Where else to look |
|---|---|---|
| **R1 · Validation happens after the last moment it could be repaired.** Something invalid is accepted at compose time and dies at the tap, in a job, or on a person's screen — where there is no model in the loop and nobody to recover. | C12, C16, C24, C13, **F2** (buttons composed into the body), **F6** (a Saturday class started on a Sunday), **F8** (operator-shaped commit summaries shipped to parents) | Anything minted, staged or scheduled now and executed later: `schedule`'s payloads, catalog moments, staged plan messages, recipes. |
| **R2 · A capability exists with no way to reach it.** From outside, indistinguishable from a model that never wants it. | C14, C13, C4, C45, C46 | `form` and the rest of §15's component registry. Anything whose only caller is the model. |
| **R3 · The runtime knows something and does not tell the model.** It then guesses, and the guess is confident. | C15, C16, C20, C41, **F3** (`uncovered_sessions_next_36h` actually means *unconfirmed*) | Anywhere the model asks a question the runtime could have answered: coverage, balances, what a gate would do before it tries. **And anywhere the runtime hands the model a named variable — the name is prompt, and it is the part nobody reviews.** |
| **R4 · A guarantee is enforced on one path when several exist.** Which path a turn takes is the model's choice, so a guarantee that depends on it is not a guarantee. | C21, C22, C12, C9, C26, C49's own first run, **F4** (reflection acts on a stale view of the turn), **F5** (three generators, one fact, no shared dedupe), **F7** (`add_family` and `book_trial` disagree about what a person is) | Every place with both a "model does it" and a "runtime does it" branch: preview→commit, menus, escalation, digests, reflection. |
| **R5 · A comparison is made on unnormalised values.** The constraint exists and can never fire. | C19, C34 | Names used as keys, class and venue matching by name, dedupe keys, idempotency keys. |
| **R6 · What the product records is narrower than what it changes.** Invisible to previews, to undo, and to anybody debugging. | C18, C5, C47 | `sender` credentials, `memory_fact`, `job` payload changes. |
| **R7 · Doing nothing succeeds.** A write that matches no row, a lookup that finds nothing, an id that names nothing: Postgres does not consider any of these an error, so `ok: true` comes back and the reply says it is done. **This is the only root whose failures a reader of the transcript scores as a pass.** | C37, C36, C39, C33 | Every `update … where` in the registry; every operation that falls back to a placeholder when a lookup misses; RLS-refused writes, which are the silent case by construction. **And test harnesses**: `rls-check.mjs` prints "13 passed, 0 failed" while skipping its cross-role and family-privacy sections entirely when the fixture world is absent. |
| **R8 · A capability is reachable and never chosen, because nothing names the situation that calls for it.** R2 is a door with no corridor; this is a door with no sign. | C48, C4's menu. **Largely closed** — see §"Where the product stands": `schedule` went 0 → 17 calls and `remember` 3 → 11 rows once `watching.md` named the situations. **The overshoot is now the problem** (F5). | Any tool whose use requires a judgement *in addition to* answering. `view` and `recall` are the two still at zero. |
| **R9 · An optimisation removed a capability nobody was measuring.** The fix was correct, the measurement that justified it was sound, and the thing it cost was not in the measurement. | C29, C30, C44 | Every constant introduced "because measured". Re-read what the measurement actually covered. **Apply test 4 to your own fixes.** |
| **R10 · Claims of *action* are checked at the send path; claims of *fact* are not.** The runtime already refuses a reply that says it did something when nothing was written — it returns *"that message says you did something, and nothing has been written this turn"* and makes the model try again. Nothing anywhere asks whether a reply that states a **time, a date, a price, a roster or a policy** was read out of a row this turn. So the one artifact the customer actually reads is the only one in the product with no structural check on it. | **F1** (times, dates and sessions answered from the recurrence pattern, not the calendar), **F9** (a business policy invented and then persisted as a memory fact) | The same chokepoint that already lints past-tense-without-a-write. Every reply that names a scalar the database owns. `drive score` axis 1 measures the half that *is* checked; nothing measures this half. |

---

## What to measure

`npm run drive -- score [contactId]` prints axes 1 and 3–6 straight off the tables.
Run it at the start and end of a session and put both numbers in your findings.

"Did it answer?" is not a bar. A turn can answer correctly and still be a defect —
and the defects that matter most are the ones a reader of the transcript scores as a
pass. Seven axes, in the order a failure hurts.

**1 · Truth — did it actually do what it said?** The most important, because the
failure is silent and reads as success. `audit_entry.turn_id` exists (migration 0015),
so this is a query rather than an eyeball: for every reply claiming a completed action,
an audit entry with a non-empty diff from that turn. `drive score` prints it first.
**The past-tense detection is a heuristic — read the flagged turns.** Target: zero
unbacked claims. Not "few". **Note what this axis does not cover: R10.** A reply that
states the wrong class time scores as a pass here, because it claimed no action.

**2 · Correctness — was it the right thing, done right?** Distinct from Truth: it can
honestly do something, and the something is wrong. Not derivable; read the diff in
`audit_entry` against what was asked. `turn.tool_calls` holds the SQL.

**3 · Friction — how much work did the *person* do?** Inbound messages before it was
done, questions the bot asked back, taps versus typed characters. Watch for a bot that
asks one question per fact.

**4 · Affordance — could they act without typing?** **Do not read the headline
percentage.** It sits at 100% because the runtime bolts a menu button onto any message
that would otherwise be bare. Read the per-kind tap rates, which `drive score` breaks
out. The only kinds that earn taps are the ones the *runtime* mints (`steps` 50%,
`operation` 25%); `menu` and `view` are still at 0%.

**5 · Capability — do they know what it can do?** `drive score` lists which tools were
reached for and names the ones never called at all. Read it as three audiences: an
admin needs breadth, a coach needs their three verbs obvious, a parent needs one useful
thing on first contact.

**6 · Plainness — would this read as English to someone who has never used software?**
Words per message, anything over 60, uuids, invented vocabulary. Anything deterministic
you find here is a lint rule, not a note.

**7 · Cost — seconds and tokens.** `drive cost`. **Rounds are the driver**: the stable
prefix is paid on every uncached round, so a turn that goes round twice costs twice.

---

## Where the product stands

**Then** = 93 turns across 5 driven businesses, before C45–C55.
**Now** = 37 turns, one business built from empty (1 admin, 1 coach, 1 admin-registered
family, 1 QR-code stranger), driven Thu 13 Aug → Mon 17 Aug on the emulator clock.
Now is one tenant, so treat it as a shape, not a fact.

| | Then | Now | Reading |
|---|---|---|---|
| `schedule` / `agent_task` calls | **0, ever** | **17** | R8 is closed. §3's proactive claim is now true — and immediately overshot (F5). |
| `memory_fact` rows | 3 | 5 in 37 turns | Live. One of the five is a fact the model invented about the operator (F9). |
| `recipe` rows | 0 | **0** | C45 wired capture at ≥3 rounds; 8 plans ran and none captured. Unverified either way. |
| `view_spec` rows | 1 | **0** | 4 `view` buttons minted, **0 tapped**, 0 specs written. Worse than Then. |
| `attendance` / `tally_line` / `payment` | 0 / 0 / 0 | **0 / 0 / 0** | The money half of the spec has still never existed. |
| `session_coach` confirmed / arrived | 0 / 0 of 55 | **0 / 0 of 21** | Coverage has still never been true from a real confirmation. |
| coaches onboarded | 1 of 7 | 1 of 1 | The invite→forward→tap path works end to end (see §"Driven and found good"). |
| job kinds enqueued | 12 of 20 | **12 of 20** | The 8 that never fire are the money and curation half: `client_outcome`, `monthly_lines`, `month_end_tally`, `dunning`, `first_contact_batch`, `memory_curate`, `coach_not_onboarded`, `reconcile`. |
| turn cost | 45k in / 2k out, 2.2–3.7 rounds, 14–29s, cache 63–79% | **43.3k in / 0.7k out, 2.62 rounds, 17.3s, cache 81%** | Output tokens down 3×. Cache is real now (explicit `CachedContent`); warm turns measured 87–95%. |
| axis 1 · truth | not queryable | **7 of 12 past-tense claims had no write behind them** | Read the flagged turns before believing the number — but it is the highest thing on the board. |
| axis 6 · plainness | — | 54.8 words avg, 14 over 60, 6 with invented vocabulary | |

**The shape of it: the floor is still strong, the ceiling is now in use, and the
finish is bad.** RLS holds, plans cannot half-commit, buttons cannot be minted
un-tappable, jobs decline rather than fire stale, the send path refuses a lying reply.
What reaches the customer's screen is where this round's defects all are — R10 and R1
between them account for six of the nine findings below.

---

## What C45–C55 turned out to be

The previous round left eleven changes with "assume each is wrong until you have seen
it work". This round drove seven of them. Do not re-verify the top half.

| # | Status |
|---|---|
| **C46** (drivable web surface) | **Works.** `drive link/open/register` reach the screens. |
| **C47** (`audit_entry.turn_id`) | **Works.** Axis 1 is a query now, and it found something. |
| **C48** (`watching.md`) | **Works, and overshoots.** `schedule` 0 → 17. See F5. |
| **C49** (async reflection) | **Works, and is the source of F4 and F5.** It runs, it writes memory, and it acts on a stale view of the turn it is reflecting on. |
| **C50** (per-turn thinking tier) | **Works.** 2.62 rounds avg, no `MALFORMED_FUNCTION_CALL` in 37 turns. |
| **C53** (SSE / `worldState`) | **Works.** No emulator stalls across a 4-day drive. |
| **C55** (make a business from the emulator) | **Works.** `drive academy` builds a live tenant from empty. |
| **C45** (recipes) | **Unverified.** Capture fires at ≥3 rounds; 8 plans ran, `recipe` is still 0. Nobody has established whether the threshold is wrong or the call site is. |
| **C51** (cheap digest prompt) | **Unverified.** Digests ran 4×; nobody measured what they cost. |
| **C52** (back-to-chat, `calendar` built in) | **Unverified.** `view_spec` is 0 and no view button was ever tapped. |
| **C54** (clock "set" button) | **Unverified from the UI.** The CLI clock is fine. |

---

## What has never been driven

**Assume every line here is broken.** In rough order of what a round would learn most
from.

1. **A tapped `[Yes, I'm coming]`.** Still zero confirmations, zero arrivals, zero
   declines — 0 of 55 in the earlier rounds' worlds, 0 of 21 in this one, which is every
   `session_coach` row that has ever existed. Everything downstream is
   untested by construction: escalation clearing, `CL-SESSION-TROUBLE` suppression, the
   arrival claim ladder, `CO-COVER-OFFER`. **This round got closer and then missed it:**
   `CO-DAY` and `CO-REGISTER` both reached a real coach, but the clock was advanced
   13 hours in one hop, so `coach_coming` and `coach_nudge` correctly declined
   (*"session has already started"*). **Advance in ≤1h steps through a session window,
   or you will keep not testing this.**

2. **An answered register.** `CO-REGISTER` arrives correctly with the right roster.
   Nobody has ever marked one. One marked register opens `client_outcome`, tally lines,
   the month-end tally and dunning — 4 of the 8 dead job kinds.

3. **Money, end to end.** Zero tally lines and zero payments have ever existed. Rail 1
   is: bot sends the UPI handle, parent pays out of band, admin attests. **The emulator
   has no payment surface at all**, so this may not be drivable without building one.
   That is the first thing to establish, and it is a finding either way. The
   GPay-screenshot half (§14.5) may already work, since it is media → parse → propose.

4. **Media end to end.** §7.1 step 2 and §14.5 call this "the single biggest friction
   reducer in the product" and it is close to untested. A photographed timetable, a
   Hinglish voice note, a forwarded spreadsheet.

5. **The solo case (§18)**, the undo window, and opt-out.

6. **A second business, throughout.** C42 showed that a tenant-scoped read against the
   wrong tenant returns empty rather than raising, which makes every single-tenant
   finding — including all nine below — weaker than it looks.

7. **A WhatsApp list row, tapped.** `drive tap` only reads `payload->'buttons'`, so a
   `list` message cannot be tapped from the CLI; it silently falls back to an older
   message's buttons and reports *"there is no button 3 — there are 2"*. The trial menu
   had to be answered by typing. Harness gap, not a product one, but it means list
   affordance is unmeasured.

---

## Driven and found good

Null results from this round. Do not redo these.

- **Signup → live, from an empty world, in six messages.** `drive academy`, then three
  sentences of plain Hinglish-shaped English ("we run 3 batches. beginners mon wed fri
  6-7am…", "add my coach deepak sharma 9820055002, he takes all three batches", "add a
  student for me - aarav verma, beginners batch…"). All parsed, all written correctly.
- **Pre-launch silence is real and is *said*.** Every setup reply volunteered "nobody
  has been messaged yet". Nothing went out until `set_onboarding_state('live')`.
- **The confirmation gate held on money.** `commit` refused a 5-step rate change with
  *"too big to commit on your own say-so"*, the runtime minted the button, the tap
  replayed the stored plan at **0 model tokens**, and `[Show me all 5]` produced a real
  blast radius before anything was written.
- **The reply lint caught the model claiming a write it had not made** and forced a
  re-compose in the same turn. This is R10's other half working.
- **Three model errors were caught and recovered inside one turn** without the user
  seeing any of them: a bad column (`a.account_id`), a uuid the model had not read
  (`send_invite_draft: … is not a coach you can see`), and a `to_char(weekday,'Day')`
  that returned `.ay`. Each error message told the model what to do instead, and it did.
- **RLS held against a prospect.** Rohan's turn ran `select p.full_name from
  academy_admin …` and got **0 rows**. A stranger cannot enumerate staff.
- **Jobs decline rather than fire stale.** Jumping the clock past a session window
  skipped `coach_coming`, `coach_nudge`, `admin_escalate_uncovered` and
  `client_session_trouble` with a reason each, instead of sending four late prompts.
- **The prospect funnel (§10.1) works.** Cold unknown number → correct classes, correct
  prices, correct times, real buttons → trial booked, in four messages. This is the
  best-performing path in the product and the only one a stranger sees.
- **Nothing was suppressed and nothing needed to be.** 40 outbound, 0
  `suppressed_reason`, ₹4.50 total. The per-recipient cap (6/24h) exempts the admin by
  design; the two non-admin recipients peaked at 3 counted messages each. **F5 is not a
  cap defect** — do not go looking for one.

---

## Standing decisions, so nobody relitigates them

- **No WhatsApp Flows.** §14.6 rejected them for concrete costs — RSA keypair, an
  encrypted data-exchange endpoint, published versioned artifacts, a Meta review cycle
  per change — and named the one condition for revisiting: *if the register's tap-out
  is measurably costing completions*. **The register has still never been marked**, so
  that condition has not been evaluated. Drive it, measure it, then argue.
- **The web surface is three screens**: `setup`, `register`, `calendar`. The other six
  components still render but the model may no longer author them (`MINTABLE`). Put one
  back when a real question is badly served by a table, which is the bar §15 set.
- **Signup is the operator's, not a product flow.** `resolveInbound` returning
  `unresolved` for an unknown number is that decision working, not a gap.
- **Do not trim the operation registry.** Measured against the bodies rather than the
  list, 21 of 25 earn their place, and C17 removed the tax that made anyone want to.
- **The ten-tool ceiling is gone.** It was a `gemini-2.5-flash` artifact. Operations are
  declared as functions and the build is on Gemini 3 (commit `6aedcea`). If you are
  reading an older note that says a new capability must fold into an existing tool,
  it no longer applies.

## Open questions, ranked

1. **Where does the reply-time fact check live?** R10 is the round's headline and the
   only root with no proposed home. The send path already lints past-tense-without-a-
   write; the question is whether the same place can require that a stated time, date or
   price appeared in a `read` result from this turn, and what that costs when the answer
   is legitimately composed (a weekly pattern *is* a real answer to "when is his
   class?" — it just is not an answer to "when is his next class?").

2. **What should reflection be allowed to see, and to send?** C49's reflection now
   produces two of the nine findings. It fires on nearly every turn (17 schedules in 37
   turns), it reads a stale view of the turn it is reflecting on, and its output can
   re-send a message the main loop already sent. The structural question is whether
   reflection should be able to *send* at all, or only to schedule and remember.

3. **Model tiering (§21 decision 4).** The spec argues *against* a strong model for
   admins: parents and coaches are ~95% of the humans and are where "it feels like a
   bot" gets decided. This round is evidence for that — the admin path was good and the
   parent path was the worst thing in the run. The better axis is turn *shape*, which
   `TURN_THINKING` splits on without changing models. Settle the budget question before
   the model one.

4. **The prefix is still large** (43.3k prompt tokens average, 81% cached). The argument
   for cutting it is **behavioural, not financial** — at ~₹1/turn cost is not the
   constraint, but a long instruction read at low thinking is where a good module gets
   skimmed. Every round has added a module. This one did not, and should not.

5. **Latency is 17.3s average.** Half a minute is a long time to leave a parent looking
   at a chat, and it is a product risk before it is a bill.

6. **What does an out-of-window recipient actually get?** For a parent, out-of-window is
   the normal state, and this round showed what it looks like: every message wrapped in
   a template header. See F2's second half — the header is chosen from the *catalog
   moment*, not from what the message says, so a first-ever contact and a routine
   reminder both open "a change to your schedule for <the payer>".

---

## Running it

```bash
npm run dev                       # the emulator API the driver posts to
npm run db:push
npm run drive -- reset            # empty world, no fixture
npm run drive -- academy "X" --admin "Y"
npm run drive -- say <contact> "hi"
npm run drive -- stranger +91… "hi is this the badminton academy?"
npm run drive -- score            # before and after, both in your findings
```

The web surface:

```bash
npm run drive -- link <contact> --screen setup|register|calendar --open
npm run drive -- open <contact> --purpose register
npm run drive -- register <coachContact> --absent "Aarav,Meera"
```

`npx tsc --noEmit` and `node scripts/rls-check.mjs` before you finish. **Note that
rls-check silently skips its cross-role and family-privacy sections when the fixture
world is absent and still reports "0 failed"** — see R7. Seed a fixture before trusting
it.

**Advancing the clock:** `drive clock --next` steps to the next scheduled moment, which
is what you want. `--to <iso>` across many hours will skip whole job ladders — each job
correctly declines when its precondition has passed, so the transcript looks calm and
you have tested nothing.

---

# The log

Findings go here. Newest at the bottom. Use the block shape from §"How to record a
finding".

---

### F1 · A reply may state a time, a date or a session that was never read out of a row, and nothing anywhere objects.

**Root:** R10 (new — argued in the roots table). Not R7: the write path is fine and
`audit_entry` is clean. Not R3: the runtime withholds nothing, the rows are readable and
in one case were read in the same turn and then contradicted.

**Saw:** `drive say <parent> "hi is this aarav's table tennis? what time is his class"`.
The turn ran `select weekday, start_time … from class_slot` and got back
`06:00:00` three times. The reply said **"6pm to 7pm"**, and then **"his next class is
tomorrow, Fri 14 Aug"**. The database had **zero sessions on 14 Aug** — the class's
first session was Mon 17 Aug 06:00 IST — and `select … from session … where starts_at
>= app.now()` had returned `starts_at: null` in that same turn.

Pushed back on ("*i thought aarav's batch was in the morning*"), it re-read the rows,
got `06:00:00` again, and **defended the wrong answer**: *"the weekday Beginners
sessions are all in the evening. If you were expecting a morning slot, I might have the
wrong batch for him."* It only corrected on the third message, on the customer's
authority, **with zero reads that turn**, and in the same breath repeated the phantom
Friday class. A day later a scheduled message referred to *"today's 6am class"* that
had never existed.

The same defect, milder, on the prospect path: `book_trial` confirmed *"the next
session"* with no date while its own follow-up job was scheduled for **15 Aug** and the
booked session was **22 Aug**. Asked *"which saturday is that?"*, it read `session`,
answered **22 Aug**, and volunteered *"there isn't a session this Saturday (the 15th)"*
— correct, and proof the data was there the whole time.

**Blast radius:** every client, on the question they ask most. A parent brings a child
at the wrong hour or on a day the hall is shut. **Nobody would find out from the
system** — there is no error, no suppression, no audit row, and axis 1 scores it a pass
because the reply claimed no action. It surfaces only as a person standing outside a
locked door, and they will blame the academy.

**Confidence:** certain. Four independent instances, rows checked in the database.

**Where you think it lives:** the reply chokepoint that already refuses
past-tense-without-a-write — `lib/agent/loop.ts`, the guard that returns *"that message
says you did something, and nothing has been written this turn"*. That guard is the
proof the shape is buildable; it covers verbs and not nouns.

---

### F2 · Message structure composed by the model reaches the wire as text.

**Root:** R1. Accepted at compose time, delivered by a path with no model in the loop.

**Saw:** three consecutive outbound messages to the same parent ended with a literal
block:

```
{ "buttons": [ { "title": "See full calendar", "action": { "kind": "reply", … } } ] }
```

`select count(*) from message where direction='outbound' and body like '%"buttons"%'`
→ **3**. The rendered buttons on those messages were the runtime's generic
`[ What can you do? ]` fallback, so the customer saw JSON *and* no working button.

Same class, different surface: bodies carrying fake bracket buttons —
`"[Confirm rates & UPI] · [Cancel]"` under real buttons reading
`[ Do it ] [ Show me all 5 ] [ Cancel ]`, and `"[Nudge Deepak now] · [I'll call him]"`
under a single `[ Open ]`. Two button sets per message, one of them inert.

And the template envelope, which is the same defect one layer down: the header is
chosen from the catalog moment rather than from the message, so a parent's **first
ever contact** and a routine Sunday reminder both opened *"Rally Point Table Tennis: a
change to your schedule for **Anjali Verma**"* — nothing had changed, and the schedule
belongs to Aarav, not to the person who pays for him.

**Blast radius:** every out-of-window recipient, which for a parent is the normal
state. Reads as broken software to the exact audience §21 says decides whether this
feels like a bot.

**Confidence:** certain for the JSON and the bracket text (counted in `message.body`).
Likely for the header, in the sense that I have not read the catalog to confirm the
header is moment-derived rather than model-supplied.

**Where you think it lives:** the reply lint that R1's note already says was bypassed
per-caller. `lib/agent/loop.ts` compose, `lib/messaging/` catalog for the header half.

**Do not re-file the catalog-code sighting.** `AD-EVENING-DIGEST`, `CO-REGISTER`,
`PR-TRIAL-CONFIRMED` and `unsolicited` appear in `drive thread` output as the driver's
own chips (`scripts/drive.ts:178-179`). `select … where body ~ '(CO|AD|CL|PR)-[A-Z-]{4,}'`
returns exactly **one** row, and it is model-authored prose to the admin —
*"He'll receive his arrival prompt (CO-COMING) at 5am"* — which is an F9 instance,
not a template leak.

---

### F3 · The runtime names a variable for what it wishes it measured, and the model writes the name down.

**Root:** R3, in its sharpest form: **the variable name is prompt.**

**Saw:** `lib/agent/loop.ts:1464`, `needs_you_uncovered`, surfaced to synthesis as
`uncovered_sessions_next_36h`. Its `where` clause is `not exists (… session_coach …
confirmed_at is not null or arrived_at is not null)` — that is **unconfirmed**, not
uncovered. Coverage assignment lives in `class_coach` and `session_coach`, and both had
rows: one coach, assigned to all three classes on day one, 21 `session_coach` rows.

The admin was told **four times across two digests and two morning briefs**: *"Two
classes for tomorrow still need a coach assigned: Beginners 6:00am, Advanced 7:00pm."*
An `agent_task` message the same evening said the opposite — *"Deepak is assigned to
the 6am Beginners session"* — because that path read the assignment tables directly.

**Blast radius:** the owner. The one report he is meant to trust tells him his only
coach is not on the roster, on the eve of his first-ever class, and contradicts another
message in the same thread. He either calls the coach at 9pm for nothing, or learns to
skip the digest. The second is worse and is invisible.

**Confidence:** certain about the query and the rows. Likely about causation — the
synthesis prompt is where "uncovered" becomes "needs a coach assigned", and I did not
read it.

**Where you think it lives:** `lib/agent/loop.ts:1464` (rename to
`unconfirmed_sessions_next_36h`, or hand over both counts). Then grep every other
key handed to synthesis for the same gap between name and predicate.

---

### F4 · Reflection acts on a view of the turn that is already stale, and can undo the turn's work.

**Root:** R4. Reflection is a second path that does not see what the first path did —
the same shape as C49's own first live defect, now with a send attached.

**Saw:** the coach's onboarding turn replied and the reply was sent
(`message.status = sent`). The reflection on that same turn scheduled:

```
slug: follow-up-unanswered-greeting-6a8af060
instruction: "The user sent a greeting 'Hi Rally Point Table Tennis' but there was
no reply sent. Check if a response is needed…"
```

That job then fired and **re-sent the identical onboarding message**. A second
reflection (`coach-change-followup`) sent it a **third** time. Deepak received *"Here
are the classes I have for you… Does that look right to you?"* three times — once with
only `[ Something's wrong ]`, once with both buttons back — after he had already tapped
`[ Looks right ]` and been onboarded.

**Blast radius:** every coach and every client, at their least forgiving moment: first
contact. A coach who has confirmed and is asked again twice concludes the tap did not
work, and the natural next action is to tap `[ Something's wrong ]`, which is the one
outcome the flow is trying to avoid.

**Confidence:** certain that it fired on a false premise and that the message went out
three times. Suspected on mechanism — whether reflection sees a pre-send snapshot or is
simply told less than the loop knows.

**Where you think it lives:** `lib/agent/loop.ts` (`reflect`), specifically what state
it is handed. Related: see open question 2 — whether reflection should be able to send.

---

### F5 · Three generators can each raise the same item, and nothing dedupes across them.

**Root:** R4. Not a cap defect — see §"Driven and found good".

**Saw:** 22 outbound to one admin over four days at a two-student academy with no
sessions until day five. The same untrue claim (F3) arrived four times. Alongside it:

- A message whose entire content is that it will not send a message: *"Since you've
  been active in the chat today and everything is running smoothly, I'll stay quiet and
  won't send a separate follow-up."*
- Header against body in one message: *"**something needs your attention**. **No action
  needed.** Deepak Sharma successfully onboarded on Thursday…"*
- *"No messages went out to families or coaches in the last 24 hours"* — false; both
  the parent and the coach received messages inside that window.

`schedule` was called **17 times in 37 turns**. R8 is closed and this is the overshoot:
`admin_morning_brief`, `admin_evening_digest` and `agent_task` each independently
decide something is worth saying, and no one holds the list of what has already been
said.

**Blast radius:** the owner, who is the one user who cannot be allowed to start
ignoring the thread — every escalation the product has routes through him. Also the
one recipient the per-recipient cap deliberately exempts, so nothing downstream will
ever catch it.

**Confidence:** certain on the volume and the repetition. Likely that the missing
chokepoint is cross-generator rather than per-generator.

**Where you think it lives:** unknown. Ruled out: the send path caps
(`lib/messaging/send.ts:444`, admin exempt by design, and the two non-admin recipients
peaked at 3 counted messages). The candidate is a shared "already told them this"
ledger between `lib/jobs/` digest kinds and `agent_task`.

---

### F6 · A recurring class can be created with a start date that is not one of its own weekdays.

**Root:** R1. The schema could have refused it; instead it surfaced two weeks later as
a session nobody scheduled and nobody missed.

**Saw:** *"…and saturday open play 9-11am"*, on Thursday 13 Aug. `create_class` wrote
`starts_on: 2026-08-16` — **a Sunday**. The class has exactly one slot, `weekday = 6`.
`materialize_sessions` therefore produced its first session on **Sat 22 Aug**, silently
skipping Sat 15 Aug. Nothing warned, and `starts_on` for the other two classes (Mon
17 Aug, a Monday) was correct in the same plan.

This is the same class as the standing seed observation *"asked on a Thursday to
'remind me on friday', the model set `run_at` three weeks out"* — model weekday
arithmetic is unreliable and nothing downstream checks the result against the thing it
names.

**Blast radius:** a whole week of a batch quietly does not exist. The admin's calendar
looks right (the class is there, the slot is right, the price is right) and only the
absence of a session on a date nobody thought to look at gives it away. Compounded by
F1: the bot confidently told a stranger *"the next session"* and had to be asked twice
before the 22nd came out.

**Confidence:** certain.

**Where you think it lives:** `lib/agent/operations.ts` `create_class`, or a check
constraint — a class whose slots are all `weekday = N` cannot begin on a date that is
not a `weekday = N`. Push it to the schema; it is free there.

---

### F7 · `add_family` and `book_trial` disagree about what a person is, so a self-paying adult became two people.

**Root:** R4. One human, two write paths, two identity models.

**Saw:** `book_trial` for a prospect wrote `person` **twice** —
`5c48f2bf… "Rohan Das"` (behind the contact, used as `account.holder_person_id`) and
`aea7b432… "Rohan Das"` (fresh, used as `player.person_id`). Two rows, same name, same
human, one phone. The admin path does this correctly: `add_family` for Anjali/Aarav
produced one `person` each and linked them properly, because holder and player are
genuinely different people there.

§6.2 names the self-payer as the n=1 case that must not be a second code path. It is
currently a second code path that gets it wrong.

**Blast radius:** unknown and probably wide — every per-person aggregate (attendance,
tally lines, dunning, memory facts, §6.7's money-shaped-rows-must-not-route-to-a-minor
rule) keys on `person`. **Nobody would find out** until two halves of one adult's
history diverge. Zero tally lines have ever existed, so this has never had a chance to
show.

**Confidence:** certain about the two rows. Suspected about the downstream damage —
nothing that would expose it has ever run.

**Where you think it lives:** `lib/agent/operations.ts` `book_trial`. The fix is to
reuse `contact.person_id` when the player is the contact; the root fix is that both
operations call one "resolve or create this human" helper.

---

### F8 · Commit summaries written for an operator are shipped verbatim to coaches and parents.

**Root:** R1. Composed at commit time and delivered by the tap path, where there is no
model in the loop to notice the audience changed.

**Saw:** a coach tapped `[ Looks right ]` on his own onboarding and received:

> **Changed 1 coach — they are set up and will get their day from now on.**

Third person, about himself, counting rows. The admin gets the same shape — *"Changed
3 classes, changed 1 setting for this business and changed 1 enrolment"* — which is
defensible for an operator and is where the phrasing was clearly designed. It is the
same string on both audiences. `drive score` axis 6 flags **6 messages with invented
vocabulary** across the run.

**Blast radius:** coaches and parents, at the moment they first tap something. It is
the single cheapest thing in this file to fix and the one most likely to decide whether
somebody taps a second time.

**Confidence:** certain.

**Where you think it lives:** wherever `tap:steps` / `tap:operation` turns a plan
summary into a message body — the summary is already role-aware everywhere else in the
product (the send path knows who it is talking to), so this is a chokepoint that exists
and is not being used.

---

### F9 · The model invents business policy and then persists it as a fact about the operator.

**Root:** R10. A claim of fact, unchecked — and then written to `memory_fact`, where it
becomes indistinguishable from something the operator said.

**Saw:** two in one run.

Nobody ever mentioned trials. On the first cold inbound the bot offered *"a **free
trial** session"*, minted a `book_trial` menu, and booked one, telling the customer
*"It's free, nothing to pay."* The academy's own rates say Saturday Open Play is ₹300
per session. The owner was committed to a discount he was never asked about and was
never told about it in those words — the digest reported it as *"one new trial"*.

Separately, `reflect:remember` wrote:

> *"Prefers to onboard staff by receiving a draft invite to forward from their own
> number, rather than the system messaging them directly."*

The admin expressed no such preference. That is the product's own §11.3 design,
observed once and recorded as a personal fact about him. §5 says memory drives
vocabulary, timings and menu ordering, so this is a fact that will be *acted on*.

Third instance, same root, cosmetic: *"He'll receive his arrival prompt (**CO-COMING**)
at 5am"* — the model naming an internal catalog moment to a customer as if it were
English.

**Blast radius:** the operator's money and the operator's settings, changed by
inference. `memory_fact` is append-only with supersessions, so a wrong fact is not
edited away — it accumulates, and §5 says it shapes later turns. Nobody would find out;
there is no surface that shows an admin what the product believes about him, and
`drive` had to read the table directly to see this.

**Confidence:** certain on both writes. Likely on the harm, since `memory_fact` is at 5
rows and its influence on later turns is not yet measurable.

**Where you think it lives:** the same reply-time check as F1 for the "free trial"
half. For the memory half: `lib/agent/loop.ts` (`reflect`) needs the distinction
between *what this person told me* and *what I observed the product do*. Related to
open question 2.

---

# Corrections to the log above

**Read this before acting on F1–F9.** Three of the nine were filed against the wrong
root or against a defect that no longer exists. A finding filed under the wrong root
sends the next person to build a fix that cannot fire, which is worse than no finding —
they will build it, watch the symptom continue, and conclude the fix does not work.

Each was checked against the source, not re-driven.

### F9's "free trial" is not the model inventing policy. Do not build a fact check for it.

Filed under R10 (*a claim of fact, unchecked*), with the reply-time check as its home.
A reply-time check would never catch it, because **no row contradicts it — the product
says the trial is free, in four places:**

| Where | What it says |
|---|---|
| `lib/agent/operations.ts` `book_trial.description` | *"Book a **free** trial from a cold conversation…"* |
| `lib/agent/context.ts` (`stablePrefix`) | that description ships inside `operationSignatures()` — **the byte-identical cached prefix, on every turn** |
| `lib/messaging/catalog.ts` `PR-WELCOME` | `defaultButtons: ['Book a free trial', …]` |
| `lib/agent/operations.ts` (tally lines) | `free_first_class` defaults **true**, and a trial gets a full offsetting `-amount` adjustment |

The bot said *"It's free, nothing to pay"* because that is **true of the
implementation**. The blast radius in F9 stands — the owner was committed to a discount
nobody asked him about — but the root is not R10. It is closer to R6: the product
records a commercial policy it never asked for and shows the operator no surface where
it is visible. **The fix is an onboarding question and a default, not a gate.** The
`memory_fact` half of F9 is unaffected and still R10.

### F2's bracket-button half is already closed. Do not spend a round on it.

`composeAndSend` calls `repairOutbound` **unconditionally**, and it is genuinely the one
chokepoint — jobs, digests, escalations and tap acknowledgements all pass through it.
Bracket labels come out of the body and either become real buttons or vanish. The
"two button sets, one inert" symptom cannot survive that path.

**What is still live is the JSON half**: `repairOutbound` matches `[Label]` patterns and
URLs, and does nothing with a `{"buttons": […]}` block. That is the part worth fixing,
and it is a different fix.

### F4's mechanism is not "suspected". It is one line, and it is fixed below.

F4 says *"Suspected on mechanism — whether reflection sees a pre-send snapshot or is
simply told less than the loop knows."* Neither. `runTurn` passed
`replied: replyText`, where `replyText` was the model's **trailing prose**. A turn that
answers through `reply`/`message` — which is every turn carrying buttons — leaves that
empty, so reflection was handed the literal string `You replied: (nothing)` about a turn
that had just answered correctly.

It did not misjudge. It reasoned correctly from a premise the runtime got wrong, which
makes F4 **R3, not R4** — and it means the structural question in open question 2
("should reflection be able to send at all?") was being asked about a data bug.
Reflection already cannot message anyone: `reflect` pre-loads `repliedTo` with the
contact so the main loop's own guard refuses it. The leak was one hop further out — the
`agent_task` it scheduled runs later as an ordinary turn, and *that* can send.

### F5's home is not unknown, and it is not a missing ledger alone.

F5 says the candidate is *"a shared 'already told them this' ledger"* and lists the send
path as ruled out. Half right. **Gate 4b already is that ledger** — byte-identical body,
same contact — it was just scoped to five minutes, which is far too short for proactive
traffic that repeats over hours. That is fixed below.

The genuinely missing piece is narrower than F5 implies: *semantic* repetition, the same
fact in different words across days. Gate 4b explicitly declines that
(*"near-identical wording is the model's business, not this gate's"*) and it is right to.
That belongs at the generator, not the gate.

**A caution against my own earlier reading:** the random `newId()` in `compose.ts`'s
idempotency key looks like a bug and is not. It is documented on `ComposeSpec` —
*"two deliberate replies are two messages"* — and gate 9 exists for callers that supply
their own key. Making it content-derived would silence a person who asks the same
question twice, which is a worse failure than the one it fixes.

---

# Fixed, and what each fix takes away

Six changes, in one pass, on branch `worktree-six-fixes`. **Test 4 applied to each** —
§"Finding the root" says every guarantee costs something and three of an earlier round's
fixes each removed a capability nobody was measuring (R9).

The *why* of each is a comment at the fix site, as the header of this file requires.
This table is what changed and what it cost, not why.

| # | Root | What changed | What it takes away |
|---|---|---|---|
| **X1** | R1 · F6 | `create_class` now starts a class on one of its own slot weekdays — `firstMatchingWeekday` moves the date forward to the first matching day. | The model can no longer deliberately start a class before its first session. Nothing wanted that. It **corrects rather than refuses**, so a genuinely wrong intent is now silently plausible instead of loudly wrong — the plan note says the date moved, which is the only warning. |
| **X2** | R4/R5 · F7 | `book_trial` reuses `contact.person_id` when the player *is* the contact, via a new `resolvePlayerPerson`. `add_family`'s own same-person test now goes through the same `normalName`, replacing `trim().toLowerCase()`. | Two people with genuinely the same name behind one contact now collapse into one person. Rare, and the alternative — one adult silently becoming two — is worse. The match is deliberately conservative: whole-name only, against a name already held for that contact. |
| **X3** | R4 | The claim gate no longer checks only the message going back to the person talking. **Every recipient**, same turn-level backing. | Messages to third parties can now cost a round they previously never cost. Expect `rounds` to rise slightly on turns that message others. It still fires at most once per turn, deliberately. |
| **X4** | R3 · F4 | `runTurn` derives the reply from what was actually sent (`ToolCtx.saidToUser`, filled where a send is recorded as landed) instead of the model's trailing prose. Fixes **two** consumers: reflection's premise, and the `turn.output.reply` column, which was blank on every button-carrying turn. | `turn.output.reply` changes shape — it is now the sent body, and a multi-message turn joins them with a blank line. Anything parsing that column sees something different. `drive score`'s plainness axis will read different word counts, and they will be the true ones. |
| **X5** | R1 · F8 | `buildSummary` takes an audience. An admin still gets *"Changed 3 classes…"*; anybody else gets the plan's own note. `audienceFor(identity)` is the single place that decides, passed at all four `executePlan` call sites. | A non-admin receipt no longer says how many rows moved or how many people were told. For a coach confirming his own onboarding that is noise; if a coach ever needs a blast radius, this is where it went. Previews are untouched — a preview is always shown to whoever authorises. |
| **X6** | R4 · F5 | Gate 4b's identical-body window is **5 minutes for solicited traffic, 6 hours for unsolicited**. | A proactive generator can no longer legitimately repeat a sentence within six hours. Checked against what recurs: brief/digest are ~12h apart, reminders are per-session, weekly is 7 days. A *daily* proactive message with byte-identical wording would now be suppressed on day two — none exists today, and if one is added, this is the line it will hit. |

**Not fixed, deliberately:** F1 and the R10 half of F9. The fact-grounding gate is the
only real engineering on the list and the one most likely to make things worse if
shipped blind — it false-positives into a re-compose, a re-compose is a round, and
rounds are the entire cost and latency story (19k tokens at one round, 128k at six).
**Build it in shadow mode first**: log what it would have blocked, block nothing, drive
once, read the log. Turn it on when it catches the 6pm reply and the phantom Friday
without flagging *"his class is Mon/Wed/Fri at 6"*.

### Instructions do not close these, and there is proof in the repo

Before anybody proposes fixing F1 by adding a rule: **`lib/doctrine.md` rule 11 already
is that rule.** It landed in `3292cf2` (12 Aug 22:47), it is in the cached prefix on
every turn, and it describes F1's exact failure —

> *"Zero rows is an answer, never the whole answer… widen it once and say what is
> actually there. **"Nothing this week — his first is Mon 17 Aug, 6pm"** is the answer."*

The round that produced F1 ran with that rule in front of the model. And the worked
example inside it says **6pm** for a class the database holds at **06:00** — the rule
written to prevent the confusion demonstrates it, and ships that demonstration on every
turn. Fix that line while you are in there.

This is the strongest evidence in the repo for §4's placement doctrine, and the
strongest argument against open question 4's temptation to add another module.
**Nothing was added to the prompt this round, and nothing should be next round either.**

---

# The next drive: the half that has never run

**This is the round's assignment.** Not the fixes above — those are done and the probe
covers them. Everything below §"What has never been driven" item 1 has been true since
the product was built: **0 confirmations, 0 arrivals, 0 marked registers, 0 attendance
rows, 0 tally lines, 0 payments, ever, in every world that has existed.** Eight of
twenty job kinds have never fired and they are the money and curation half.

Every finding in this file comes from the half that works. Until this drive happens,
nobody knows what the other half looks like, and every priority on this page is a guess
about a product half of which has never been observed.

### Why the last two rounds missed it, so you do not

1. **The clock was jumped too far.** `--to <iso>` across many hours skips whole job
   ladders. Each job correctly declines with a reason, the transcript reads calm, and
   nothing was tested. **Use `drive clock --next`**, and never step more than an hour
   through a session window.
2. **`drive tap` only reads `payload->'buttons'`.** A `list` message cannot be tapped
   from the CLI — it silently falls back to an older message's buttons and reports
   *"there is no button 3 — there are 2"*. If the affordance you need is a list row,
   type the answer and **write down that you had to**.

### The ladder, in order. Do not skip a rung.

```bash
npm run drive -- reset
npm run drive -- academy "X" --admin "Y"          # then classes, a coach, 2–3 families
npm run drive -- score                            # BEFORE. Put it in your findings.
```

Then, one hour at a time:

1. **Get a session to exist and be near.** `drive clock --next` until `CO-DAY` fires.
2. **Tap `[Yes, I'm coming]`** on `CO-COMING`. This has never happened. The moment it
   lands, check `session_coach.confirmed_at` in the database — a green tool result is
   not evidence.
3. **Confirm `CO-NUDGE` does not fire** for that coach, and that
   `admin_escalate_uncovered` skips. §19 phase 4: *"a confirmed coach is never asked
   twice."* Nobody has ever seen this be true.
4. **Let the session end. Answer `CO-REGISTER`** — `[All present]` first, then drive a
   real one with `drive register <coach> --absent "Name"`. This opens `client_outcome`.
5. **Roll to month end.** `monthly_lines`, `month_end_tally`, `CL-TALLY`. First tally
   line that has ever existed.
6. **Attest a payment** and let `dunning` fire on someone who has not paid. §"What has
   never been driven" item 3 says the emulator may have no payment surface at all —
   **establishing that is itself a finding**, either way, and it is the first thing to
   check rather than the last.
7. **Then, and only then**, a second coach declining, so `CO-COVER-OFFER` and
   `claim_cover` get their first run.

### What to write down, whatever happens

- **The four invariants that only exist on this half.** A cancel that credits and
  notifies cannot half-complete. A rolled-back plan has messaged nobody. Money-shaped
  rows never route to a minor (§6.7 — Kiran, 16, has his own number in the seed). A
  register cannot be marked twice.
- **F7's blast radius, finally observable.** Two `person` rows for one adult was
  invisible because nothing per-person had ever run. Tally lines and attendance are the
  first things that would split. X2 fixes it going forward; the drive is what tells you
  whether the class is wider than `book_trial`.
- **Whether the digest gets better or worse once there is something real to report.**
  It is the most expensive message per word in the product (~1.3k in, ~1.5k out, 0%
  cached, twice a day) and it was wrong four times out of four on a world with nothing
  in it. F3's fix is a rename; whether the digest is *good* is unmeasured.
- **A null result is a result.** §"Driven and found good" is the most valuable section
  in this file per line. If the ladder holds all the way down, say so — that turns
  "assume broken" into "known good" for half the product.

### And the standing decision this unblocks

§"Standing decisions" says WhatsApp Flows were rejected with **one** condition for
revisiting: *if the register's tap-out is measurably costing completions*. The register
has still never been marked, so that condition has never been evaluated. Step 4 above is
the evaluation. Measure it, then argue.

---

# Harness notes for whoever drives next

- **`probe-model` now runs six invariants after every case** (`scripts/probe-model.ts`,
  `INVARIANTS`). They are statements about the world that must hold whatever was said —
  weekday/start agreement, no duplicate people, no player duplicating their own account
  holder, nobody told the same thing twice, no row-counting receipt to a non-admin, no
  raw structure or bare URL in a body. Four of this round's findings are caught by three
  of them, none of which mentions the sentence that produced it.

  **Keep it that way.** The bar for a new invariant: a property of the data or the
  outbound record, true for every business, checkable in SQL, false today only if
  something is wrong. **Anything needing a specific prompt is a case, not an invariant,
  and should fold into one of the five cases that already exist rather than becoming a
  sixth.** A harness that grows one case per finding stops being run.

  Verified working: `--models gemini-3-flash-preview` scored **45/46** after the fixes,
  ~14s and ₹2.73 for the whole arc.

- **`probe-model` never runs the job queue.** `create_class` enqueues
  `materialize_sessions` and nothing executes it during a probe, so
  `setup-small`'s *"sessions were scheduled"* check reads **0 sessions and fails in
  every recorded baseline** — `.probe`, `.probe-a`, `.probe-b`, `.probe-c`, `.probe2`,
  `.probe3`, all of them. Confirmed by reading the `job` rows: `status='pending'`,
  `attempts=0`. **This is a harness gap, not a product defect**, and it has been quietly
  red long enough that it now reads as noise — which is how a real failure would get
  missed. Either run the queue in the probe or drop the check.

- **`probe-model` tears down its academy** unless you pass `--keep`. Inspecting anything
  after a run needs that flag.

- **A worktree needs three things copied in before it can run anything**: `.env.local`,
  `.secrets/`, and `node_modules` (a junction is fine). All three are gitignored, and
  without them the probe fails in ways that look like model errors — every case reports
  `ERROR`, 0 tools, and an empty reply.

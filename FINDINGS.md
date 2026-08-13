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

**Three rules that save the most time:**

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

### How to record a finding

Append to §"The log" at the bottom. One block per finding, this exact shape:

```
### F<n> · <one sentence naming the CLASS, not the instance>

**Root:** R1–R9, or `new` with an argument for why none of them fits.
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

**4. What does this fix take away?** New, and added because three of the last round's
fixes were correct and each removed a capability nobody was measuring (R9). Every
guarantee costs something. If you cannot say what, you have not looked.

---

## The roots

Every entry in the ledger is an instance of one of these nine. **When you find a new
defect, check these first.**

| Root | Instances | Where else to look |
|---|---|---|
| **R1 · Validation happens after the last moment it could be repaired.** Something invalid is accepted at compose time and dies at the tap, in a job, or on a person's screen — where there is no model in the loop and nobody to recover. | C12, C16, C24, C13 | Anything minted, staged or scheduled now and executed later: `schedule`'s payloads, catalog moments, staged plan messages, recipes. |
| **R2 · A capability exists with no way to reach it.** From outside, indistinguishable from a model that never wants it. | C14, C13, C4, C45 (recipe capture had no call site), C46 (the register had no drivable door) | `form` and the rest of §15's component registry. Anything whose only caller is the model. |
| **R3 · The runtime knows something and does not tell the model.** It then guesses, and the guess is confident. | C15, C16, C20, C41 | Anywhere the model asks a question the runtime could have answered: coverage, balances, what a gate would do before it tries. |
| **R4 · A guarantee is enforced on one path when several exist.** Which path a turn takes is the model's choice, so a guarantee that depends on it is not a guarantee. | C21, C22, C12, C9, C26 | Every place with both a "model does it" and a "runtime does it" branch: preview→commit, menus, escalation, digests. |
| **R5 · A comparison is made on unnormalised values.** The constraint exists and can never fire. | C19, C34 | Names used as keys, class and venue matching by name, dedupe keys, idempotency keys. |
| **R6 · What the product records is narrower than what it changes.** Invisible to previews, to undo, and to anybody debugging. | C18, C5, C47 (`audit_entry` had no `turn_id`) | `sender` credentials, `memory_fact`, `job` payload changes. |
| **R7 · Doing nothing succeeds.** A write that matches no row, a lookup that finds nothing, an id that names nothing: Postgres does not consider any of these an error, so `ok: true` comes back and the reply says it is done. **This is the only root whose failures a reader of the transcript scores as a pass.** | C37, C36, C39, C33 | Every `update … where` in the registry; every operation that falls back to a placeholder when a lookup misses; RLS-refused writes, which are the silent case by construction. **And test harnesses**: `rls-check.mjs` prints "13 passed, 0 failed" while skipping its cross-role and family-privacy sections entirely when the fixture world is absent. |
| **R8 · A capability is reachable and never chosen, because nothing names the situation that calls for it.** R2 is a door with no corridor; this is a door with no sign. The behavior modules described nine *situations* and not one *capability*, so `schedule` and `remember` were named nowhere in 30k characters of behavior and were called 0 and 3 times in 93 turns. | C48 (`watching.md`), C4's menu | Any tool whose use requires a judgement *in addition to* answering. Ask of each: which module's trigger condition would make me reach for this? |
| **R9 · An optimisation removed a capability nobody was measuring.** The fix was correct, the measurement that justified it was sound, and the thing it cost was not in the measurement. All three instances were introduced by the previous round and found by the one after. | C29 (thinking→0 bought decisive tool calls, cost every discretionary one), C30 (saving a round closed the only slot `remember` could run in), C44 (a mint-time floor took views from over-minted to never) | Every constant introduced "because measured". Re-read what the measurement actually covered. **Apply test 4 to your own fixes.** |

---

## What to measure

`npm run drive -- score [contactId]` prints axes 1 and 3–6 straight off the tables.
Run it at the start and end of a session and put both numbers in your findings.

"Did it answer?" is not a bar. A turn can answer correctly and still be a defect —
and the defects that matter most are the ones a reader of the transcript scores as a
pass. Seven axes, in the order a failure hurts.

**1 · Truth — did it actually do what it said?** The most important, because the
failure is silent and reads as success. `audit_entry.turn_id` exists now (migration
0015), so this is a query rather than an eyeball: for every reply claiming a completed
action, an audit entry with a non-empty diff from that turn. `drive score` prints it
first. **The past-tense detection is a heuristic — read the flagged turns.** Target:
zero unbacked claims. Not "few".

**2 · Correctness — was it the right thing, done right?** Distinct from Truth: it can
honestly do something, and the something is wrong. Not derivable; read the diff in
`audit_entry` against what was asked. `turn.tool_calls` holds the SQL.

**3 · Friction — how much work did the *person* do?** Inbound messages before it was
done, questions the bot asked back, taps versus typed characters. Watch for a bot that
asks one question per fact.

**4 · Affordance — could they act without typing?** **Do not read the headline
percentage.** It sits at 100% because the runtime bolts a menu button onto any message
that would otherwise be bare. Read the per-kind tap rates, which `drive score` breaks
out. The historical shape: `menu` 31 minted / 1 tapped, `reply` 78 / 6, `steps` 18 / 9.
The only kind that earns taps is the one the *runtime* mints.

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

## Where the product actually stands

Measured over 93 turns across 5 driven businesses, before this round's changes. Treat
every number as a baseline to beat, not as a fact about the current build.

| | Then | Why it matters |
|---|---|---|
| `schedule` / `agent_task` calls | **0, ever** | §13.1 is what makes the proactive surface open-ended; without it §3's claim is false |
| `memory_fact` rows | **3** | §5 drives vocabulary, per-person timings and menu ordering; all inert at 3 |
| `recipe` rows | **0**, and no code path could write one | §14.3 |
| `view_spec` rows | **1** | 9 components, ~2,300 lines of React |
| `attendance` / `tally_line` / `payment` | **0 / 0 / 0** | the entire money half of the spec |
| `session_coach` confirmed / arrived | **0 / 0** of 55 rows | coverage — §6.3's "most important derived value" — has never been true from a real confirmation |
| coaches reaching `active` | **1 of 7** | §11.3 |
| job kinds never enqueued | **8 of 20** | `client_outcome`, `monthly_lines`, `month_end_tally`, `dunning`, `reconcile`, `memory_curate`, `coach_not_onboarded`, `agent_task` |
| stable prefix | **58,309 chars ≈ 16k tokens** | §4.4 budgets ~8k |
| turn cost | 45k prompt / 2k output, 2.2–3.7 rounds, 14–29s, cache 63–79% | a warm turn measured 96% cached; the average is dragged down by cold first turns |

**The shape of it: the floor is strong and the ceiling is unused.** RLS holds, plans
cannot half-commit, buttons cannot be minted un-tappable, silence gets caught. Every
capability that requires the model to *choose* it was at or near zero. That is R8 and
R9, and it is the thing this round attacked.

---

## Changed this round — verify these first

Each is a class. The reasoning is in a comment at the file named. **Nothing below has
been driven properly. Assume each is wrong until you have seen it work.**

| # | Class | Where |
|---|---|---|
| **C45** | **§14.3's recipes could never exist.** `captureRecipe` and `applyRecipe` had zero call sites anywhere, so `recipe` was a table nothing could write to and `matchRecipe` ran a guaranteed-null query on every text turn. Capture now fires on a committed plan that cost ≥3 rounds. **The value is rounds, not tokens** — a match riding in the tail costs ~1.2k characters and saves a whole prefix pass. | `lib/agent/recipes.ts` (`captureIfExpensive`), `lib/agent/loop.ts` |
| **C46** | **Half the product could not be driven, so it was never tested.** `drive open` could only follow the newest link the bot happened to have sent, and `CO-REGISTER` goes to an out-of-window coach as a template — so §15's highest-traffic screen sat behind a door only the model could open. `attendance` = 0 in every world ever driven is that, and nothing else. | `scripts/drive.ts` (`link`, `open --purpose`, `register`, `score`) |
| **C47** | **A write could not be traced to the turn that caused it**, so axis 1 was not queryable. Carried as a GUC set in `applySession`, not as an argument, so all four write paths get it without any of them remembering to. | `supabase/migrations/0015_audit_turn.sql`, `lib/db.ts` |
| **C48** | **The behavior layer described situations and never capabilities**, so nothing ever told the model when to watch something or keep a fact. R8's first instance. | `lib/behaviors/watching.md` (new), `lib/agent/context.ts` |
| **C49** | **The prompt asked for something the loop made impossible.** The tail says "write new facts after replying, never instead of replying"; the loop ends the turn the moment a reply lands. §5 already said where this belongs — asynchronously, after the turn — and it now runs there, with a ~300-token prompt instead of the 16k prefix, and only offering the tools the turn did not already use. | `lib/agent/loop.ts` (`reflect`) |
| **C50** | **Zero thinking was applied to every turn shape, including the ones that are pure judgement.** C29's measurement was sound and covered composition only. The budget is now a tier chosen per turn. | `lib/agent/gemini.ts` (`TURN_THINKING`), `lib/agent/loop.ts` |
| **C51** | **The digest paid 16k tokens of schema, operations and catalog it cannot use** — on the most expensive model in the product, twice a day, and uncached, because `cachedContentFor` needs tools and synthesis declares none. | `lib/agent/context.ts` (`synthesisDoctrine`), `lib/agent/loop.ts` |
| **C52** | **The web surface was a one-way door.** The setup form's button said "Save and go back to the chat" and its success state said "Back to the chat"; neither was a link, and the page opens in a new tab. A promise the runtime cannot keep, in the one place with no model in the loop. Also: `calendar` is now a built-in screen rather than something the model must compose, and the mintable component list is narrowed to `table` / `prose` / `calendar`. | `components/view/back-to-chat.tsx` (new), `app/w/[token]/page.tsx` (`CalendarScreen`), `lib/web/registry.ts` (`MINTABLE`) |
| **C53** | **The emulator's own instrument was broken, and every symptom made the product look broken rather than the tool.** The SSE route awaited the database before emitting its first frame — and a promise returned from `start()` gates the response headers — so `EventSource` sat in `CONNECTING` for tens of seconds and degraded to polling, which then saturated the pool and kept it there. Separately, **latency here is round-trip *count*, never distance**: one trip to the pooler measures ~37 ms, `withSession` + one query is ~151 ms (exactly four trips), and the old preamble spent three or four on its own. `worldState()` then paid that per tenant, in series, ten times. `GET /api/emulator/state`: **6.0s → 1.2s**. Every individual statement was fast the whole time, which is why nothing pointed at SQL would have found it. | `app/api/emulator/stream/route.ts`, `lib/db.ts` (`applySession`), `lib/seed.ts` (`worldState`) |
| **C54** | **The clock's "set" button always submitted the time it already was.** `onBlur` fires before `onClick`, an effect keyed on `editing` overwrote the typed value from the live clock, and the handler then read the reverted value. Indistinguishable from a dead button. | `components/emulator/ClockBar.tsx` |
| **C55** | **The emulator could not make a business, and its world picker named three that did not exist.** `POST /api/emulator/academy` had been built and nothing called it; the "world" dropdown listed seed fixtures under academy names, so trying a second tenant meant wiping the first. | `components/emulator/ContactTray.tsx`, `lib/emulator/state.ts`, `components/emulator/ClockBar.tsx` |

**One defect was introduced and caught within the same turn, and it is the most
instructive thing here.** C49's reflection pass, on its first live run, scheduled a
second watch for a request the main loop had already scheduled — one sentence from the
admin, two watches, and they get chased twice. The instructional fix ("do not repeat
what you already did") is the one that fails intermittently. The structural fix is that
reflection is not *given* a tool the turn already used. **A fix for R9 produced an R4,
inside ten minutes.** Every new slot is a new path, and a guarantee that lives on one
path is not a guarantee.

---

## What has never been driven

**Assume every line here is broken.** In rough order of what a round would learn most
from.

1. **A business with families in it, walked through the whole clock.** The coach ladder
   fires — `CO-DAY`, `CO-COMING`, `CO-NUDGE`, `AD-ESCALATE-UNCONFIRMED`,
   `post_class_register` — and has never once been *answered*: 0 confirmations, 0
   arrivals, 0 declines across 55 `session_coach` rows. Coverage has never been true.
   Everything downstream of a tapped `[Yes, I'm coming]` is untested by construction:
   escalation clearing, `CL-SESSION-TROUBLE` suppression, the arrival claim ladder,
   `CO-COVER-OFFER`.

2. **The register, and everything behind it.** `drive register` exists now and takes a
   roster without hand-authored JSON. One marked register opens `client_outcome`,
   per-session tally lines, the month-end tally and dunning — 8 dead job kinds.

3. **Money, end to end.** Zero tally lines and zero payments have ever existed. Rail 1
   is: bot sends the UPI handle, parent pays out of band, admin attests. **The emulator
   has no payment surface at all** — no UPI intent, no "the parent paid" simulation, no
   attestation loop — so this may not be drivable without building one. That is the
   first thing to establish, and it is a finding either way. The GPay-screenshot half
   (§14.5) may already work, since it is media → parse → propose.

4. **Everything C45–C55 changed.** Especially: does `schedule` get reached for on turns
   where it should be, and *not* on turns where it should not? A watch nobody asked for
   is worse than no watch.

5. **Media end to end.** 5 turns of 93 ever carried a file. §7.1 step 2 and §14.5 call
   this "the single biggest friction reducer in the product" and it is close to
   untested. A photographed timetable, a Hinglish voice note, a forwarded spreadsheet.

6. **The solo case (§18)**, the undo window, opt-out, and the prospect funnel (§10.1).

7. **A second business, throughout.** C42 showed that a tenant-scoped read against the
   wrong tenant returns empty rather than raising, which makes every single-tenant
   finding weaker than it looks.

### Seed observations, unverified

From two smoke turns after this round's changes. Each is an *instance*; find the class
before you write it up.

- Asked on a Thursday to "remind me on friday", the model set `run_at` to **three weeks
  out**. Seen twice out of two. Check the clock offset first — the emulator clock may
  not have been where it looked — then check whether relative weekday arithmetic is
  wrong in general.
- One reply measured **62 words** against axis 6's 60-word line, and it read as
  explaining itself rather than answering.
- Given the identical sentence twice, one turn created the class and one asked before
  creating it. Neither is wrong; the variance is the finding, and it is what §14.3's
  recipes are supposed to remove.

---

## Standing decisions, so nobody relitigates them

- **No WhatsApp Flows.** §14.6 rejected them for concrete costs — RSA keypair, an
  encrypted data-exchange endpoint, published versioned artifacts, a Meta review cycle
  per change — and named the one condition for revisiting: *if the register's tap-out
  is measurably costing completions*. **The register has never been opened**, so that
  condition has not been evaluated. Drive it, measure it, then argue.
- **The web surface is three screens**: `setup`, `register`, `calendar`. The other six
  components still render but the model may no longer author them (`MINTABLE`). Put one
  back when a real question is badly served by a table, which is the bar §15 set.
- **Signup is the operator's, not a product flow.** `resolveInbound` returning
  `unresolved` for an unknown number is that decision working, not a gap.
- **Do not trim the operation registry.** Measured against the bodies rather than the
  list, 21 of 25 earn their place, and C17 removed the tax that made anyone want to.
- **The tool surface has a hard ceiling of 10 declarations** on `gemini-2.5-flash`. An
  eleventh makes *every* turn return `MALFORMED_FUNCTION_CALL`. New capability folds
  into an existing tool or the operation registry. **This is worth re-testing on
  Gemini 3** — if the ceiling is a 2.5 artifact, the constraint dissolves.

## Open questions, ranked

1. **Is `gemini-2.5-flash` still the right model?** `scripts/probe-model.ts` measured
   `gemini-3-flash-preview` at zero thinking as equally decisive with **zero** malformed
   calls in 20 runs, at twice the latency and 1.6× output tokens. The question to put to
   it now is not "does it call a tool" but **"does it call the discretionary one"** —
   give it *"keep an eye on Saturday Advanced"* and see whether `schedule` fires, across
   `2.5-flash@0`, `3-flash@0`, `3-flash@2048`, `3-pro@2048`. Re-probe the 10-tool ceiling
   in the same run.

2. **Model tiering (§21 decision 4).** The spec argues *against* a strong model for
   admins: parents and coaches are ~95% of the humans and are where "it feels like a bot"
   gets decided. The better axis is turn *shape* — composition and media parsing need
   judgement; answering a question does not — which is what `TURN_THINKING` now splits
   on without changing models at all. Settle the budget question before the model one.

3. **The prefix is 2× its budget** (16k against §4.4's 8k), mostly behavior modules
   (30.8k chars) and the catalog digest (7.3k, which §4.4 does not budget at all). The
   argument for cutting it is **behavioural, not financial** — at ~₹1/turn cost is not
   the constraint, but a 58k-character instruction read at low thinking is where a good
   module gets skimmed. Note that this round *added* a module. Every round has.

4. **Latency is 14–29s.** Half a minute is a long time to leave a parent looking at a
   chat, and it is a product risk before it is a bill.

5. **What does an out-of-window recipient actually get?** Everything a coach or parent
   receives outside 24h collapses to one template button. Correct per §14.7, and nobody
   has measured what share of the catalog ever reaches anyone in-window, or whether the
   eight `quickReply` titles are worth a tap. For a parent, out-of-window is the normal
   state.

---

## Running it

```bash
npm run dev                       # the emulator API the driver posts to
npm run db:push                   # 0015 is new
npm run drive -- reset            # empty world, no fixture
npm run drive -- academy "X" --admin "Y"
npm run drive -- say <contact> "hi"
npm run drive -- score            # before and after, both in your findings
```

The web surface is drivable now and was not before:

```bash
npm run drive -- link <contact> --screen setup|register|calendar --open
npm run drive -- open <contact> --purpose register
npm run drive -- register <coachContact> --absent "Aarav,Meera"
```

`npx tsc --noEmit` and `node scripts/rls-check.mjs` before you finish. **Note that
rls-check silently skips its cross-role and family-privacy sections when the fixture
world is absent and still reports "0 failed"** — see R7. Seed a fixture before trusting
it.

---

# The log

Findings go here. Newest at the bottom. Use the block shape from §"How to record a
finding". Nothing has been written yet this round.

<!-- ### F1 · … -->

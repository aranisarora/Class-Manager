# Driving

## What driving is for

Driving is being a person talking to the bot, and then asking the database whether what
it said was true. It is the whole eval. `npm run drive` posts to the same emulator API a
human uses, so there is no second code path to keep honest, and it reads the ordinary
tables back — `message` for what was said, `turn` for what was thought, `audit_entry`
for what changed. Nothing in the harness knows anything the product does not record.

**The unit of work is a class of failure, never an instance of one.** "The bot cannot
remember what it looked up" is a finding. "The cancellation template says the academy
name twice" is not — it is evidence, and fixing it alone teaches the system nothing.

The product is a general agent on general primitives — read with SQL, write with SQL,
send, remember, schedule, show a view — bounded by the permissions of whoever is talking.
That is why **the same root produces a different-looking failure every time it fires**,
and why fixing what you saw makes the bot reliable at that one thing and no more
reliable overall.

`product-spec.md` remains the authority on what the product is supposed to do. This file
is how you find out whether it does.

---

## Four rules that save the most time

1. **Check the roots table first.** Most new defects are another instance of a root
   already listed below. The cheap win is nearly always an already-known root somebody
   has not finished applying, not a new one.
2. **Do not report an instance.** "The reply said 6:30pm when the row says 06:30" is
   evidence. The finding is "read-backs are composed from intent rather than from what
   was written." If you cannot state the class, you have not finished looking.
3. **A green tool result is not evidence.** Check the database. `drive score`,
   `drive world`, `drive money`. Twice in earlier rounds the bot said "I've added those
   families" and the database disagreed — once because nothing ran, once because it ran
   twice, and the transcript reads identically in both cases.
4. **A red transcript is not evidence either.** `drive thread` prints `catalog_id` and
   `unsolicited` as dim chips of its own. A round of this was written up as "internal
   template codes are leaking to customers" before the message bodies were checked and
   every one came back clean. Before you file anything you saw in a transcript, ask the
   `message` row whether the user would have seen it.

---

## How to run it

```bash
npm run dev                       # the emulator API the driver posts to
npm run db:push                   # migrations, in filename order; re-running is a no-op
npm run drive -- reset            # empty world, no fixture
npm run drive -- academy "X" --admin "Y"
npm run drive -- say <contact> "hi"
npm run drive -- stranger +91… "hi is this the badminton academy?"
npm run drive -- score            # before and after, both in your findings
```

`say` and `tap` print the reply, the buttons, and the flight recorder for that turn —
every query the model ran and what came back — so a wrong answer is diagnosable in one
command. `drive world` gives you the contact ids everything else takes.

The web surface is half the product and goes untested unless you reach for it
deliberately, because its screens arrive as signed links inside messages:

```bash
npm run drive -- link <contact> --screen setup|register|calendar [--open]
npm run drive -- open <contact> --purpose register
npm run drive -- register <coachContact> --absent "Aarav,Meera"
```

`link` mints the signed link directly — no message, no model call. `open` follows a link
the bot actually sent, as a person tapping it would.

Before you finish:

```bash
npm run typecheck
node scripts/rls-check.mjs
```

`npx tsx scripts/probe-model.ts [--keep]` drives the real loop through a scripted
onboarding arc in a fresh academy and runs a set of SQL invariants after every case. It
tears its academy down unless you pass `--keep`.

**A worktree needs three things copied in before it can run anything**: `.env.local`,
`.secrets/`, and `node_modules` (a junction is fine). All three are gitignored, and
without them everything fails in ways that look like model errors — every case reports
`ERROR`, zero tools, an empty reply.

---

## The traps

The first two make a bad run look like a good one, which is the only kind of trap worth
writing down. The third quietly leaves a whole affordance unmeasured.

**`rls-check` skips its own hardest sections when the world is empty, and still reports
"0 failed".** The cross-role and family-privacy blocks are wrapped in `if (A.coach)`,
`if (A.holder)` and `if (A.playerOwnNumber)`; with no fixture those bindings are absent,
the blocks never run, one of them prints a `skip` line and the rest print nothing, and
the tally at the bottom still says "N passed, 0 failed". Seed a fixture before you trust
it. This is R7 wearing a test harness's clothes.

**Advancing the clock in one big hop tests nothing.** `drive clock --to <iso>` across
many hours skips whole job ladders: each job correctly declines because its precondition
has passed, so the transcript reads calm and you have proved only that declining works.
Two rounds lost the coach-confirmation path this way — `CO-DAY` and `CO-REGISTER`
reached a real coach, the clock jumped thirteen hours in one step, and `coach_coming`
and `coach_nudge` both declined with *"session has already started"*. Use
`drive clock --next`, which steps to the next scheduled moment, and never step more than
an hour through a session window.

**`drive tap` can only tap buttons, not list rows.** It reads `payload->'buttons'` and
skips any message without them, so a `list` message silently falls back to an older
message's buttons and reports *"there is no button 3 — there are 2"*. If the affordance
you need is a list row, type the answer and **write down that you had to** — list
affordance is unmeasured, and that is a harness gap, not a product one.

---

## Finding the root, and knowing when you have

A bug you can see is almost never the thing to fix. Four tests, applied in order.

**1. What would have had to be true for this to be impossible?**
If the answer is *"the model would have to remember"*, you have not found the root.
If it is *"the schema would have refused it"*, *"the gate would have dropped it"*,
*"the mint would have rejected it"*, you have. Behaviour belongs at the lowest layer
that can hold it: pushed down, it becomes free and unforgettable.

**2. Would this fix have to be repeated somewhere else?**
If yes, you are at a call site, not a chokepoint. Walk up until there is exactly one
place all the traffic passes. The reply lint had been bypassed by the product's main
reply path for its entire life precisely because it was applied per-caller.

**3. Does the fix make a *category* of thing work, or one thing?**
"Validate this view's query" is an instance. "Run every view's queries at mint" is a
root. The second one also fixed views nobody has written yet.

**4. What does this fix take away?** Every guarantee costs something. If you cannot say
what, you have not looked. Three of an earlier round's fixes were correct and each
removed a capability nobody was measuring — that is R9, and it is the one root you are
most likely to create yourself.

---

## The ten roots

Every defect this product has produced is an instance of one of these. **When you find a
new one, check these first.**

| Root | Instances | Where else to look |
|---|---|---|
| **R1 · Validation happens after the last moment it could be repaired.** Something invalid is accepted at compose time and dies at the tap, in a job, or on a person's screen — where there is no model in the loop and nobody to recover. | C12, C16, C24, C13, F2 (message structure composed into the body), F6 (a Saturday class started on a Sunday), F8 (operator-shaped commit summaries shipped to parents) | Anything minted, staged or scheduled now and executed later: `schedule`'s payloads, catalog moments, staged plan messages, recipes. |
| **R2 · A capability exists with no way to reach it.** From outside, indistinguishable from a model that never wants it. | C14, C13, C4, C45, C46 | `form` and the rest of the component registry. Anything whose only caller is the model. |
| **R3 · The runtime knows something and does not tell the model.** It then guesses, and the guess is confident. | C15, C16, C20, C41, F3 (a variable called `uncovered_sessions_next_36h` whose predicate meant *unconfirmed*), F4 (reflection told a turn had not replied when it had) | Anywhere the model asks a question the runtime could have answered: coverage, balances, what a gate would do before it tries. **And anywhere the runtime hands the model a named variable — the name is prompt, and it is the part nobody reviews.** |
| **R4 · A guarantee is enforced on one path when several exist.** Which path a turn takes is the model's choice, so a guarantee that depends on it is not a guarantee. | C21, C22, C12, C9, C26, C49's own first run, F5 (three generators, one fact, no shared dedupe), F7 (`add_family` and `book_trial` disagree about what a person is) | Every place with both a "model does it" and a "runtime does it" branch: preview→commit, menus, escalation, digests, reflection. **Repetition is already split**: byte-identical bodies are caught at the send gate, and *semantic* repetition — the same fact in different words across days — is deliberately not, because that belongs at the generator. |
| **R5 · A comparison is made on unnormalised values.** The constraint exists and can never fire. | C19, C34 | Names used as keys, class and venue matching by name, dedupe keys, idempotency keys. |
| **R6 · What the product records is narrower than what it changes.** Invisible to previews, to undo, and to anybody debugging. | C18, C5, C47 | `sender` credentials, `memory_fact`, `job` payload changes. Also any commercial default the product applies without ever asking — a policy nobody chose and no screen shows. |
| **R7 · Doing nothing succeeds.** A write that matches no row, a lookup that finds nothing, an id that names nothing: Postgres does not consider any of these an error, so `ok: true` comes back and the reply says it is done. **This is the only root whose failures a reader of the transcript scores as a pass.** | C37, C36, C39, C33 | Every `update … where` in the registry; every operation that falls back to a placeholder when a lookup misses; RLS-refused writes, which are the silent case by construction. **And test harnesses**: `rls-check.mjs` prints "N passed, 0 failed" while skipping its cross-role and family-privacy sections entirely when the fixture world is absent. |
| **R8 · A capability is reachable and never chosen, because nothing names the situation that calls for it.** R2 is a door with no corridor; this is a door with no sign. | C48, C4's menu. **Largely closed** once `watching.md` named the situations that call for `schedule` and `remember`. **The overshoot is now the problem**: several generators each independently decide the same thing is worth saying. | Any tool whose use requires a judgement *in addition to* answering. `view` and `recall` are the two still at zero. |
| **R9 · An optimisation removed a capability nobody was measuring.** The fix was correct, the measurement that justified it was sound, and the thing it cost was not in the measurement. | C29, C30, C44 | Every constant introduced "because measured". Re-read what the measurement actually covered. **Apply test 4 to your own fixes.** |
| **R10 · Claims of *action* are checked at the send path; claims of *fact* are not.** The runtime already refuses a reply that says it did something when nothing was written — it returns *"that message says you did something, and nothing has been written this turn"* and makes the model try again. Nothing anywhere asks whether a reply that states a **time, a date, a price, a roster or a policy** was read out of a row this turn. So the one artifact the customer actually reads is the only one in the product with no structural check on it. | F1 (times, dates and sessions answered from the recurrence pattern, not the calendar), F9 (a business policy invented and then persisted as a memory fact) | The same chokepoint that already lints past-tense-without-a-write. Every reply that names a scalar the database owns. `drive score` axis 1 measures the half that *is* checked; nothing measures this half. |

The `C…` and `F…` codes index a defect ledger that has been retired. They are kept
because the count says how often a root has actually fired and the parentheses say what
it looked like; the codes themselves resolve only in git history, and nothing depends on
them. What you need from this table is the class and the "where else to look".

### If you are the one who builds R10's gate

Do not ship it live. A fact-grounding gate false-positives into a re-compose, a
re-compose is a round, and rounds are the entire cost and latency story — 19k tokens at
one round, 128k at six.

**Build it in shadow mode first**: log what it would have blocked, block nothing, drive
once, read the log. Turn it on when it catches a reply that states a class time no row
holds, and a "next class" on a date with no session, **without** flagging *"his class is
Mon/Wed/Fri at 6"* — a weekly pattern is a real answer to "when is his class?", and only
the wrong answer to "when is his *next* class?".

And before anybody proposes closing R10 by adding a rule instead: `lib/doctrine.md`
rule 11 already is that rule, it is in the cached prefix on every turn, and the round
that produced R10's worst instance ran with it in front of the model. Instructions do
not close this class. That is the strongest argument in the repo against adding another
prompt module.

---

## What to measure

`npm run drive -- score [contactId]` prints axes 1 and 3–6 straight off the tables; axis
7 is `drive cost`; axis 2 is not derivable and has to be read. Run `score` at the start
and the end of a session and put both numbers in what you write.

"Did it answer?" is not a bar. A turn can answer correctly and still be a defect — and
the defects that matter most are the ones a reader of the transcript scores as a pass.
Seven axes, in the order a failure hurts.

**1 · Truth — did it actually do what it said?** The most important, because the failure
is silent and reads as success. `audit_entry.turn_id` exists, so this is a query rather
than an eyeball: for every reply claiming a completed action, an audit entry with a
non-empty diff from that turn. `drive score` prints it first. **The past-tense detection
is a heuristic — read the flagged turns.** Target: zero unbacked claims. Not "few".
**What it does not cover: R10.** A reply that states the wrong class time scores as a
pass here, because it claimed no action.

**2 · Correctness — was it the right thing, done right?** Distinct from Truth: it can
honestly do something, and the something is wrong. **Not derivable, and not printed** —
read the diff in `audit_entry` against what was asked. `turn.tool_calls` holds the SQL.

**3 · Friction — how much work did the *person* do?** Inbound messages before it was
done, questions the bot asked back, taps versus typed characters. Watch for a bot that
asks one question per fact. **What it does not cover:** whether the answer was worth the
work — a fast wrong answer scores well here.

**4 · Affordance — could they act without typing?** **Do not read the headline
percentage.** It sits at 100% because the runtime bolts a menu button onto any message
that would otherwise be bare. Read the per-kind tap rates, which `drive score` breaks
out: the only kinds that earn taps are the ones the *runtime* mints. **What it does not
cover:** list rows, which `drive tap` cannot tap at all.

**5 · Capability — do they know what it can do?** `drive score` lists which tools were
reached for and names the ones never called at all. Read it as three audiences: an admin
needs breadth, a coach needs their three verbs obvious, a parent needs one useful thing
on first contact. **What it does not cover:** whether reaching for a tool was *right* —
a tool called seventeen times when twice would do scores as capability.

**6 · Plainness — would this read as English to someone who has never used software?**
Words per message, anything over 60, uuids, invented vocabulary. Anything deterministic
you find here is a lint rule, not a note. **What it does not cover:** plain English that
is untrue, which is axis 1 and R10.

**7 · Cost — seconds and tokens.** `drive cost`. **Rounds are the driver**: the stable
prefix is paid on every uncached round, so a turn that goes round twice costs twice.
**What it does not cover:** latency as the person experiences it. WhatsApp cannot
stream, so seconds here are seconds of silence.

---

## The machine: state, and speed

Two things about the architecture are worth knowing before you file anything about state
or about speed, because both produce findings that look real and are not.

### There is no session object, and that is the design

A turn is stateless. Nothing lives in memory between turns, and each one rebuilds its
context from recent history, recent lookups and a bounded memory hot set. **The session
object is the database.** The only ephemeral state is the pending plans, and those do
not get lost when the turn ends — they get **moved into the button**, serialised as an
`action` row.

That beats a session object on three counts:

- **addressable** — two pending plans can coexist, each tappable
- **self-expiring** — a 24h TTL, rather than going stale invisibly
- **claimable exactly once** — the conditional UPDATE that makes two coaches racing for
  one session resolve correctly

A `conversation_state` blob would have to reinvent all three and would arbitrate nothing.
The narrow case where a session object *would* help is a within-turn scratchpad, and
recent lookups mostly cover it.

**Statelessness does have one real cost**: anything earned in turn 1 and spent in turn 2
has nothing to travel in. The recipe capture gate is the standing example — the rounds
are spent in the turn that plans, the commit happens in the turn that taps, and the check
only ever sees the second. The fix for that shape is never a session object; it is
putting the number in the action payload, where the rest of the state already travels.

### Optimisation, ranked by leverage

In this order. The first two have landed; the rest have not.

1. **Widen the census** — *done*. The tail now carries the next few sessions with class
   name and a rendered time, and a coach's unmarked registers with the id to mark them.
   The point of it: "what time is his class?" is the most common question in the product
   and it used to cost a round because the tail held a count and a bare timestamp.
2. **Tell the model it can read in parallel** — *done*. The loop always executed several
   `read` calls per round concurrently and nothing in the prompt said so, so the model
   asked one question per round and paid a whole prefix for each. One sentence in the
   `read` declaration collapses a four-step discovery chain into two rounds.
3. **Wire the recipe loop end to end.** Capture, generalise and apply are all written,
   all correct, and not connected to each other — `applyRecipe` still has no callers, and
   what fires today pastes a matched plan into the tail as prose for the model to
   re-compose. Once wired, a matched recipe is **1 round** (the runtime binds, previews,
   executes, and the captured `message` steps carry the copy, so the model does not write
   the reply either), or **0 rounds** behind a button.
4. **Upgrade recipe matching from token overlap to embeddings.** This is the difference
   between recipes firing sometimes and firing reliably.
5. **Typing indicators.** WhatsApp cannot stream, so unlike a chat UI the latency is
   fully exposed — every optimisation others get from perception this product must get
   from real speed. A typing indicator is the one perceptual lever the surface offers.

**The floor: 1 round** for anything answerable from prefetched data, **2 rounds** for
anything genuinely unpredictable — the model must *see* data before writing a sentence
about it. Below 2 is not reachable by any architecture, so a proposal that promises it is
wrong somewhere.

---

## Standing decisions, so nobody relitigates them

- **No WhatsApp Flows.** They were rejected for concrete costs — RSA keypair, an
  encrypted data-exchange endpoint, published versioned artifacts, a Meta review cycle
  per change — with exactly one condition named for revisiting: *if the register's
  tap-out is measurably costing completions*. **The register has still never been
  marked**, so that condition has never been evaluated. Drive it, measure it, then argue.
- **The web surface is three screens**: `setup`, `register`, `calendar`. Only `table`,
  `prose` and `calendar` are mintable; the other six components still render but the
  model may no longer author them. Put one back when a real question is badly served by
  a table, which is the bar the spec set.
- **Signup is the operator's, not a product flow.** `resolveInbound` returning
  `unresolved` for an unknown number is that decision working, not a gap.
- **Do not trim the operation registry.** Measured against the bodies rather than the
  list, all but a handful earn their place, and the tax that made anyone want to trim has
  already been removed. The registry is 27 operations today; the last count of what earns
  its place was taken at 25, so re-measure before quoting a ratio.
- **The ten-tool ceiling is gone.** It was a `gemini-2.5-flash` artifact and it was a
  misdiagnosis: re-measured against this exact prefix, 60 declarations run clean on both
  that model and Gemini 3. Operations are declared as functions now, and the guard sits
  at Google's documented API limit of 128. If you are reading an older note that says a
  new capability must fold into an existing tool, it no longer applies.

---

## How to record what you found

**There is deliberately no standing findings file in this repo.** One went stale faster
than it was read, and a stale ledger costs more than no ledger: it sends the next person
to build a fix against a defect that has already been closed, or against the wrong root.
Findings go wherever this round's work goes — the pull request, the issue, the handoff to
whoever fixes. The shape is what has to survive, not the filename.

One block per finding, this shape:

```
### <one sentence naming the CLASS, not the instance>

**Root:** R1–R10, or `new` with an argument for why none of them fits.
**Saw:** the shortest reproduction. Command, what came back, what the database said.
**Blast radius:** who is hurt and how they would find out. "Nobody would" is the
worst answer and the most important one to write down.
**Confidence:** certain / likely / suspected. Say which, and never round up.
**Where you think it lives:** file, or "unknown — here is what I ruled out".
```

**The *why* of a fix belongs in a comment at the fix site**, not in a findings write-up.
That is where somebody changing the code will actually be.

**Write the null results too.** "Drove the whole coach ladder with families on it, no
defect found" is one of the most valuable lines you can write, because it is the only
thing that turns "assume broken" into "known good", and nobody else has to redo it.

**Do not fix as you go.** If you fix while you drive, everything you found afterwards
came from a different product than everything you found before, and the round stops being
comparable. Finish the drive, then fix roots.

**And say what each fix takes away.** Test 4 is not optional and it is not rhetorical:
three of an earlier round's fixes were each correct and each quietly removed a capability
nobody was measuring. If you cannot name the cost, you have not finished the fix.

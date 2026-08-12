# Findings

## The goal this file serves

The product is a WhatsApp-native manager for Indian coaching businesses. The chat
is the whole interface: admin, coach, parent, player and stranger all do everything
by talking, and there is no app to learn.

The architectural bet under that is a **general agent on general primitives** — read
with SQL, write with SQL, send, remember, schedule, show a view — bounded by the
permissions of whoever is talking. Not a growing list of hardcoded verbs. The spec's
own reason: hardcoded verbs "cap the product's discoverable surface at its tool
authors' imagination."

**So the unit of work here is a class of failure, never an instance of one.** "The
bot cannot remember what it looked up" is an entry. "The cancellation template says
the academy name twice" is not — it is evidence, and fixing it alone teaches the
system nothing. Every entry below is a class, with the instances that revealed it.

---

## How these were found — the method to continue with

None of this came from reading the code and reasoning about it. Every entry below
came from **using the product and watching what happened.** Reading the code produces
plausible theories; three of mine were wrong, and the driving is what corrected them.
If you are picking this up, work the same loop.

### 1. Make the turn visible before doing anything else

This is the prerequisite, not a nicety. Before it, a wrong answer and a crashed turn
looked identical from the database — a sentence, and nothing else.

`turn.tool_calls` now records, per turn: every call in order, the SQL verbatim, what
came back, how long each took, how many rounds, and the real error. `npm run drive`
prints it under every reply. **Within three turns of the first test it caught a bug
that had been invisible for the life of the project** (C6). Nothing else in this
document would have been findable without it.

The corollary: when you find a failure whose cause is not in the recorder, your first
fix is to put it there. That is how `finishReason` (C2) and the swallowed recovery
error got surfaced — and `finishReason` is what named the malformed write path.

### 2. Start from an empty world

`npm run drive -- reset` and build the business by talking to it. Do not seed.

The fixture is a 45-day-old academy with a full roster — the state the product spends
most of its life in, and never the state it starts in. Onboarding had **never been
run**, and the very first message of the very first test was silently dropped (C3).
A fixture would have hidden that permanently, because a fixture is already live.

### 3. Be all four audiences, and be difficult

Admin, coach, client, and an unknown number arriving cold. They have different
permissions, different vocabulary and different tolerance, and the bugs are not the
same. Type like a person: lowercase, typos, "yeah", half a sentence. "yes please set
that batch up" found things that a well-formed instruction would not have.

### 4. Judge every turn on six axes

Not just "did it answer". A turn can be correct and still be a defect:

1. **Did it offer a useful next step** — a real button, a list, a view?
2. **Was the text right for *that* person?** A parent is not an admin.
3. **Was it bloated, repetitive, or hedging?**
4. **Was it accurate — the right task, done correctly?**
5. **How long did it take?**
6. **What did it cost, and should it be cheaper?**

C10 is a turn that scored full marks on accuracy and was still wrong: "you don't have
any sessions this week" was true, and read as *there is nothing*.

### 5. Check every claim against the database

The bot's account of what it did is not evidence, and neither is a green tool result.
Six payment operations reported success and changed nothing; the ids they were given
did not exist. One `select` against `account` settled it.

The habit: when the bot says it did something, go and look. `npm run drive -- world`,
`-- money`, or plain SQL.

### 6. When a failure is intermittent, bisect it with a probe

C6 looked like a stalling model. A throwaway script called the real model with the
real prompt and one variable changed at a time — each tool alone, then all tools, then
`plan` alone — and the pattern fell out in one run: **`plan` alone with the full
prompt malformed 2 times in 3, and with all tools available the model silently
substituted `read` instead.** That is why writes were unreliable and reads were not.

Write the probe, run it three times per condition, delete it.

### 7. Fix at the chokepoint, and only fix classes

Every fix here is at the one place all traffic passes through — the send gate, the
lint, the tool loop, the doctrine file. If a fix has to be repeated at each call site
it is the wrong fix: the lint had been bypassed by the main reply path for the life of
the project precisely because it was applied per-caller (C9).

The test for whether something belongs in this file: **if fixing it teaches the system
nothing, it is evidence, not an entry.** "The template says the academy name twice" is
evidence. "User-facing text does not go through the one gate that cleans it" is the
entry, and it fixed the doubled name, the leaked `(§2.6)`, the database nouns and the
American date format at once.

### 8. Re-drive after every fix

Each change was re-run through the same conversation immediately. Two of my fixes were
wrong on the first attempt and the re-run caught both — a menu button one character
over the wire limit that suppressed the whole message, and a receipt that still read
in the future tense.

---

## C1 · The bot had no memory of what it looked up — FIXED

Every turn rebuilt its context from **message text only** (`recentHistory`,
`loop.ts`). Tool results — the rows a query returned — never survived the turn that
fetched them. And §4.5 deliberately strips ids out of message text, so ids could
*never* survive by construction. Meanwhile the tools demanded ids.

That gap is where invented uuids came from. Asked to chase seven families' fees, the
model produced six account ids — `1c7b7b7b-7b7b-…`, `2d8c8c8c-8c8c-…`, and four
more. **None existed.** It had listed those families by name four minutes earlier and
had nothing left but its own sentence.

**Fixed** — `turn.tool_calls` now records every call with its SQL and results
(`0010_visibility.sql`), and `recentLookups` feeds the recent reads back into the
variable tail, newest first, capped, in the uncached part of the prompt. The
instruction with them is explicit: these are the only ids you may use; if what you
need is not here, run the query again.

**Still open:** ids are back, but nothing *forces* the point. See C7.

---

## C2 · Failure was silent — FIXED (mostly)

Four independent silences, one class: **the system could fail and nobody — not the
user, not the admin, not the log — would know.**

- A write against a non-existent id returned *"nothing is outstanding on that
  account"*. Six of those ran, sent zero messages, and reported success.
- `loop.ts` swallowed the recovery call's exception in a bare `catch {}`, so a dead
  turn arrived as *"ask me again and I'll have another go."* It could never work.
- `turn.error` was empty on every one of those turns.
- An empty model response recorded nothing about *why* — `finishReason` was
  discarded by `gemini.ts` before anyone could see it.

**Fixed** — `finishReason` is captured and surfaced; the swallowed error is recorded;
a round that returns neither text nor a call writes a trace line naming the reason;
and the dead-turn message now distinguishes *"I went round in circles"* from
*"something broke, repeating won't help"* instead of inviting a doomed retry.

**Still open:** operations still accept ids that do not exist. The fix is to resolve
every id with a `select` in the same statement and abort when it matches nothing —
see C7.

---

## C3 · Answers to the operator were treated as marketing — FIXED

`DEFAULT_RECIPIENT_CAP_24H = 6` exists so a parent does not get eight messages
because eight things happened. It was also applied to the admin — the operator, who
passes six messages before breakfast. Their own confirmation cards were dropped:
one plan executed against six phantom accounts while the card confirming it was
suppressed, and the "did it work" reply was suppressed too.

A second instance of the same class: a brand-new academy's owner **could not be
messaged at all**. The `pre_launch` gate silences a roster that has not launched, and
the owner was in it — so the one conversation that must work before launch was the
only one that could not. The very first message of the very first test was dropped.

**Fixed** — `send.ts` now knows whether the recipient is an admin. Admins are exempt
from the recipient cap and from the pre-launch gate (the roster is still silent — a
client is not an admin). `flushOutbox` carries `solicited` so a plan's read-back is
no longer classed as an interruption, and `message.solicited` is persisted so a
suppression can be diagnosed at all.

---

## C4 · Structure was requested, not enforced — PARTLY FIXED

The spec calls the list-picker *"the primary affordance; prose is the fallback"* and
follow-up buttons *"a first-class pattern, not a nicety."* Measured over every
message the product had ever sent: **0 lists, 0 menus, 20 of 92 messages with
buttons** (11 of those hardcoded), and of 34 minted actions, **28 were the weakest
kind** — a button that types text back so the model re-derives everything.
`kind:'operation'` had never been minted once.

The mechanism was the whole story: `sendMenu` is fully built, role-aware, reordered
by memory — and reachable only by tapping a button carrying `{kind:'menu'}`, which
**nothing ever minted.** The nav bar existed with no door.

**Fixed** — a reply that would otherwise ship bare now carries the door. A
confirmation that offers only a yes now gets a Cancel (the model reliably writes the
yes and forgets the no). Both are runtime guarantees, not prompt requests.

**Still open:** lists and views remain unused, `kind:'operation'` buttons remain
unminted, and `recipe` is still empty — so every UI is improvised rather than
consistent. This is the largest remaining gap against the vision.

---

## C5 · The bot could not see itself — FIXED, and it paid immediately

`turn` recorded the final sentence and nothing else. No tool calls, no SQL, no
results, no round count.

The first thing visibility caught, on the third turn of the first test: the model
called a tool named **`PlanSteps`** — which does not exist — **eight times in a row**,
burning 93 seconds and 165,254 tokens, and the person got *"I'm going round in
circles."* Under the old logging that turn was an apology with no explanation.

**Fixed** — `turn.tool_calls` and `turn.rounds`; `npm run drive` prints the flight
recorder under every reply.

---

## C6 · The write path was structurally unreliable — FIXED (the big one)

`plan` — the only way the model can write anything it has no named operation for —
returned **`MALFORMED_FUNCTION_CALL`** two times in three. Measured directly against
the live prompt: zero output tokens, no candidate, no error anyone could read.

The cause: a plan step is a five-way union nesting three and four deep (a message
carrying buttons carrying action payloads; a schedule carrying a free-form payload),
and Vertex's function-call decoder does not survive it.

**The symptom was disguised.** With every tool available, the model quietly fell back
to `read` instead of retrying `plan` — so *reads always worked and writes
intermittently did nothing*, which is exactly what looked like a stalling model, an
invented tool name, or an empty apology. It explains the venue that could not be
created, and probably most of the "it described what it would do and nothing
happened" reports.

**Fixed** — steps cross the wire as a JSON string. A string has no shape to malform.
Validation did not move: `PlanStepSchema` was always the thing that decided what a
step is. After the change, `plan` is called reliably where it previously malformed.

Two supporting fixes, both generic:

- **An unknown tool name now carries the way out** — the list of real names and the
  nearest match. `there is no tool called PlanSteps` is true and contains nothing to
  act on, which is why it was retried eight times.
- **The loop breaks repetition.** An identical call that already failed this turn is
  refused with an escalating instruction, and two of them end the loop. No failure
  can burn eight rounds again.

---

## C7 · Trust is keyed to authorship, not consequence — OPEN

The preview rule has five rows. Four measure the *write* — more than one person,
money, destructive. The fifth measures **who wrote it**: raw SQL always previews,
a named operation may not.

That row is redundant. The runtime already computes the real answer: the plan runs
in a transaction, the audit triggers capture the rows touched, and the diff is read
back before commit. It *knows* the blast radius; it does not need to guess from
authorship. And the rule taxes exactly the direction the product is going — the
25-operation registry should shrink to the handful that touch messages, jobs,
infrastructure tables or undo, with everything else as model-authored SQL.

**Recommended:**

1. Judge a raw write by its measured diff, like everything else. Add a small
   table-sensitivity list that always previews regardless of row count — `MONEY_TABLES`
   is already half of it; `academy` settings and `sender` credentials belong in it.
2. **Expose `write.requireRows` to the model.** It is stripped today alongside
   `write.service`, but the two are not alike: `service` is privilege (it runs as
   `cm_service`, a full RLS bypass — keep it stripped), while `requireRows` is an
   *assertion*, and allowing it is strictly safer than forbidding it. Every one of
   C1's six phantom writes would have aborted under `requireRows: 1`.
3. **Ids come from subqueries, not from memory.** `where account_id = (select id
   from account where …)` instead of a literal uuid, enforced by a lint that rejects
   a bare uuid literal in a `where` clause. This makes the whole invented-id class
   structurally impossible rather than caught-if-we-remember.

---

## C8 · The system narrates its own plumbing as news — FIXED

The evening digest reported *"14 failed and another 14 were suppressed… a failure
rate this high is unusual and could point to an issue with some contact numbers or
the account itself."* Those were **the same fourteen rows** — a suppressed message
carries status `failed` too — and every one of them was the frequency cap firing.
The digest reported the call coming from inside the house as an outage. Then it was
frequency-capped itself.

Driving a brand-new academy reproduced the class in a worse form: the morning brief
announced *"the first welcome messages went out to families yesterday… 4 of those
have failed"* — **no welcome messages were ever sent.** It was reading the admin's
own test conversation and narrating it as a business event.

**Fixed** — delivery health now excludes the admin's own thread (the operator using
the tool is not traffic to families), counts gated and failed as disjoint, and names
gates by reason with an explicit note that a gate is a decision and never a delivery
failure. The regenerated digest is accurate and hedges honestly.

---

## C9 · User-facing text was not going through the one gate that cleans it — FIXED

The §4.5 lint ran on exactly one path: the loop's own trailing message. The path the
model actually uses — the `reply` tool — **skipped it entirely**, so most outbound
text in the product was never linted. Uuids, table names, ISO timestamps and doctrine
references were one call away from a customer's phone.

Three leaks found while driving, all now closed at that gate:

- **`(§2.6)` in a message to a person.** An internal citation, on WhatsApp, cited at
  someone who has never seen the document. Same class as a uuid: correct, not English.
- **Table nouns in receipts** — *"add 2 persons, add 1 contact and add 1 account"*.
  The summary is quoted verbatim to whoever confirms, so schema names arrive on a
  phone. Now people / phone numbers / family accounts.
- **Foreign date idiom** — *"Monday, August 17th at 6:00 PM"*. Not an ISO timestamp,
  so the old pass ignored it; not how anyone in Bangalore writes a time to a parent.
  Now "Mon 17 Aug, 6pm".

Also fixed here: **the receipt reused the preview's future tense.** After committing,
people were told *"that'll change 1 session"* — leaving them unable to tell whether
the thing they just approved had happened, which is the one question a receipt
answers. Previews say "that'll"; receipts say "changed".

---

## C10 · Zero rows was treated as the whole answer — FIXED

A coach asked for the week's schedule and was told *"you don't have any sessions
scheduled for this week."* True — and it reads as *there is nothing*, which is a
different and wrong sentence. His first session was four days away.

Same class, one instance earlier and worse: a parent asking about Saturday was told
*"there are no other Saturday batches currently available"* when her daughter's
Saturday batch ran the following week. And an admin asking for the schedule was told
*"no upcoming batches"* against fourteen scheduled sessions.

**Fixed** — doctrine rule 11: report the empty set, then the nearest thing to it.
Re-tested: *"You have 8 sessions scheduled, starting next week. Your first is
Mon 17 Aug, 6pm – 7pm."*

---

## C11 · Cost and latency — OPEN

Measured over 20 driven turns: **27.5s average, 699k prompt tokens in, 33k out.**

- **Latency is the product risk.** Half a minute is a long time to leave a parent
  looking at a chat. The worst turn before the fixes was 93s.
- **Round count is the cost driver.** The stable prefix is ~13k tokens and is paid in
  full on every uncached round, so an 8-round turn costs 8× the prefix — the 165k
  turn was one mis-typed tool name. C6's repeat-breaker caps the worst case; a
  no-progress detector would cap it harder.
- **Cache ratio is bimodal**: 86–93% on turns with conversation history, **0% on the
  first turn of a conversation and on every synthesis turn.** Worth understanding
  before optimising anything else — a cold first turn is the one a stranger sees.

---

## What is still open, in order

Each of these is a class, stated so it can be picked up cold. Work them in this
order — 1 removes a whole failure mode, 2 is the largest gap against the vision, and
3 is the one a customer feels. Re-drive after each, per method step 8.

1. **C7** — preview by consequence, expose `requireRows`, ban bare uuid literals in
   `where` clauses. This closes the invented-id class structurally.
2. **C4** — lists, views, `kind:'operation'` buttons, and recipes as instruction
   packs. `recipe` is designed, empty, and is the mechanism for consistent UI and
   for staged flows like onboarding.
3. **C11** — latency and the cold-start cache.
4. **Shrink the operation registry** to the ones that earn it: messages, jobs,
   infrastructure tables, undo. Roughly 8 of 25.

---

## Appendix · how to reproduce any of this

```bash
npm run dev                                     # the emulator API this drives
npm run drive -- reset                          # empty world, no fixture
npm run drive -- academy "X" --admin "Y"        # a business at `setup`, nothing in it
npm run drive -- say <contactId> "..."          # be that person; prints the flight recorder
npm run drive -- stranger +91... "..."          # an unknown number, cold
npm run drive -- tap <contactId> [n]            # tap the nth button
npm run drive -- clock --next | +2h | --to <iso>
npm run drive -- thread <contactId> [--full]    # the whole conversation, annotated
npm run drive -- cost                           # tokens, cache ratio, latency per turn
```

The four audiences all run against one academy built entirely through conversation:
admin onboards → adds a coach → adds a family → goes live → parent asks about their
child → coach asks about their week → a stranger enquires from an unknown number →
the clock advances and the brief and digest fire.

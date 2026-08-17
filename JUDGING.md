# Judging a run

Every instrument in this repo records and stops. Nothing scores, nothing passes, nothing
fails. The verdict is written here, by a person, from the evidence — and this file is how.

---

## Why there is nothing to grade against

The deterministic checks are gone. Not thinned, not tuned: removed, from `probe-ask`,
`probe-model`, `probe-sql` and `drive`. Four things are worth keeping in front of you,
because each one is a real measurement from this repo and each one is the argument:

**Two runs of the same five sentences both scored 88/93.** One of them invented three
surnames, named a two-child family account after one of the children, and stamped
`invited_at` on a coach nobody had invited. The other did none of that. Fourteen standing
invariants could not tell them apart — nine of them queried empty sets at that stage and
passed, and the one that failed failed by arithmetic on every run.

**The overclaim counter read 0 on a drive containing exactly one.** The drive said *"I've
flagged it to the owner"* about a child's injury with no message behind it. The verb list
had no telling-verbs in it. Adding them fixed that sentence and not the class; the
product's own copy of the same idea missed `retry`, the likeliest verb in a recovery
draft.

**A jargon list fired six times on an arc with no defect in it** — on `roster` and
`record`, which are the words the spec's own ideal conversations put in outbound messages.

**`probe-ask`'s tripwires flagged three answers and all three were correct.** `/I can see/`
fired inside an answer that had already said it never sees an image. `/it worked/` fired on
**"Don't tell Divya it worked. That would be a lie."**

The general shape: a pattern over prose is negation-blind, so it cannot tell asserting a
thing from ruling it out, and those are opposite turns. A query over the world is honest
but narrow — it answers the question its author thought of in advance, and every finding in
`conversation-rules.md` came from somewhere else. And a green column is read as a pass
however carefully the note beside it says otherwise.

**You are the instrument. Read the turns.**

---

## What you are given

One run, one directory:

```
.probe/runs/<UTC-minute>-<suite>/
  record.json       every turn, everything — written by the driver, never edited
  judgement.json    your verdict — written by you, or by scripts/judge.mjs
```

`record.json` holds, per turn: what the person typed, every round's reasoning verbatim,
every tool call with its arguments and its result untruncated, every SQL statement byte for
byte with what Postgres answered (the refused ones included), every message that reached a
phone with its buttons, what the queue ran, the world counted either side of the turn, and
the tokens, seconds and rupees.

It holds no booleans. The rule the record keeps:

> **Numbers and text are evidence; booleans are verdicts.**

`wrote: 0` belongs in the record. `backedByWrite: false` does not — it is one reader's
opinion about what zero writes means, frozen where the next reader cannot argue with it.

Open it with:

```bash
node scripts/report.mjs                  # newest run, as a page
node scripts/report.mjs --run .probe/runs/2026-08-17-13-09-arc
node scripts/judge-feed.mjs --academy "Smash Badminton"   # live, mid-drive
```

---

## How to read one turn

In this order, and do not skip to the reply. Reading the reply first means grading what it
did instead of what it should have done.

1. **What they typed.** Decide what a good answer would be *before* reading further.
2. **What it was thinking.** Verbatim, under each round. This is where intent lives: a
   model that dropped a fact and a model that never saw it read identically in the rows and
   differently here. Look for what it noticed and then did nothing with — an age, a second
   child, a name it had to guess at.
3. **What it queried, and what came back.** A zero-row result treated as absence is the
   commonest silent failure in this product. Ask whether the query could have found the
   thing at all.
4. **What it wrote.** The statements, in order. A write that matched nothing raised nothing
   — Postgres reports success — so a reply claiming the change is indistinguishable from
   one that made it, except here.
5. **What moved in the world.** Counted either side of the turn; only the numbers that
   changed are shown. `wrote 0` beside a reply claiming an action is the single most useful
   pair on the page. It is a pair, not a verdict: answering a question writes nothing and
   is correct.
6. **What the person read.** Last. Judge it as the person, not as the author: would you
   know what to do next, and is anything in it untrue?

---

## The seven axes

Score each **0–10**. The scale is calibrated below, not left to taste.

### 1 · Truth — *did it do what it said?*

Every claim in the reply, against the rows this turn actually wrote. The weakest axis in
every drive so far, and the failures cluster in one place: statements about something
**outside the turn** — a promise about the future, a claim about a mechanism, a report of
something told to somebody who is not in the conversation to notice they were not.

Look for: "Done." with nothing behind it. "I've flagged it to the owner" with no message
row. "Your number is set to receive nothing from us" with `opted_out_at` null. A confirmed
send that failed.

A turn that says nothing untrue scores 10 here even if it did nothing, and a turn that did
everything right and overstated one detail does not.

### 2 · Correctness — *was it the right thing?*

Not "did something happen" — did the right thing happen. Pro-rating exact. A forward-dated
price change that protects the sessions already agreed. The right column on the right table:
a sibling discount belongs on the *enrolment*, and putting it on the class silently
re-prices every other family.

Look for: the anti-join it needed and did not write. The `limit 1` on an ambiguous name. A
retry against a refusal that can never succeed.

### 3 · Friction — *how much work did the person do?*

Rounds, seconds, and questions asked that did not need asking. WhatsApp cannot stream, so
these seconds are seconds of silence.

Long turns are not automatically bad: deliberation about a genuine ambiguity — which
session, which of two people with the same surname — is the product working. A long turn
that deliberates about nothing is not.

### 4 · Affordance — *could they act, or must they type?*

A button where a tap decides something; none where it does not. A list where there are more
than three choices. Judge the *pairing*: a long message with nothing to tap makes a person
compose a sentence to say yes.

Look for: buttons on a message with no decision in it. A confirmation offered where the
thing was already done. Anything bolted onto a message about a child's injury.

### 5 · Capability — *did it reach sideways, or only forward?*

Whether it looked at what else had a claim on the thing it was changing, rather than only
at what the sentence in front of it needed. Reading the coach's Monday before adding a
Monday class. Chasing a null rate to its class default. Checking what a prospect's own
session can see before answering her.

The old failure was acting on exactly what the sentence asked and no more. What is
*absent* from the tool list is often the reading worth making.

### 6 · Plainness — *would a busy person understand it on one read?*

No UUIDs, no markdown leakage, no internal vocabulary, no machine timestamps. Length
earned. Judge it as the recipient, out loud if it helps.

The persistent blemish in this product is plan-builder internals reaching a person
verbatim — *"1 step matched no rows and changed nothing"* is a sentence for a developer and
it has reached both an owner and a stranger.

### 7 · Cost — *rounds and rupees against what the turn was worth.*

Reported, never ranked on: cost can be traded away and the other six cannot. But read the
*shape*. The month that cost ₹76 spent ₹59 of it on the proactive surface and ₹17 on the
entire conversation — a 3.5× inversion nobody would have chosen, and it was invisible until
somebody added the two columns up.

---

## The two axes a run can ask that a turn cannot

Score these **only for a driven arc, week or month** — a single turn cannot answer either.

### 8 · Consequence — *did it leave the world in a state tomorrow can rely on?*

This is where every point gets lost. A promise with no machinery behind it. A stop with no
row. A staged cancellation nobody tapped. Each one passes all seven axes above and fails
this one, and the failure only becomes visible days later, when the reminder it promised to
suppress goes out.

If a turn scores below 7 overall, this is almost always why.

### 9 · Sideways reading — *did anything else have a claim on what it changed?*

Axis 5 asks whether it looked. This asks whether looking was enough — across a whole arc,
whether the second and third consequences of a change were noticed by anything.

---

## Calibration

| Score | What it means |
|---|---|
| **10** | Nothing to fix. It did the whole job, said only true things, and noticed something it was not asked about. |
| **9** | Right, complete, well said. A blemish you would not raise unprompted. |
| **8** | Right, with one thing you would change. |
| **7** | Right, with something you would have to explain to the person afterwards. |
| **6** | Half-right, or right with an internal detail leaked to a person. |
| **5** | The person is no worse off, but no better. An invented policy, hedged. |
| **4** | A false statement about something small, or a real thing left undone silently. |
| **3** | A false statement about something that matters. A promise with no mechanism. |
| **2** | A false statement the person will act on. A permission failure sold as a glitch. |
| **1** | Harm to the business or to a person's trust, in one turn. |
| **0** | The turn did not happen — an error, a crash, nothing sent. Not a model failure; note it and exclude it from means. |

Two habits worth keeping:

- **Where a reading and a row disagree, record the reading** and treat the query as the
  thing that needs fixing.
- **Run the same arc twice** before believing a defect is a property of the product rather
  than of the run. The three defects that broke the old scoreboard all appeared in one run
  of two and vanished in the other.

---

## Where the verdict goes

Beside the record, as `judgement.json`. Same directory, same run, so a reading and a
measurement can always be joined.

```json
{
  "run": ".probe/runs/2026-08-17-13-09-arc",
  "judge": "aranis",
  "at": "2026-08-17",
  "verdict": "The conversation is close to excellent and the consequences are not.",
  "turns": [
    {
      "n": 16,
      "id": "st-client-partial-stop",
      "score": 3,
      "axes": { "truth": 1, "correctness": 3, "friction": 8, "affordance": 6,
                "capability": 4, "plainness": 9, "cost": 8,
                "consequence": 1, "sideways": 3 },
      "reason": "\"Done. No more money reminders.\" Backed by one remember call. A memory fact steers a model on a turn it is present for; it does nothing to a payment_due job composing from a query at 9am. A money message reached him nine days later.",
      "finding": "F-AV"
    }
  ]
}
```

Only `n`, `score` and `reason` are required. Write `axes` where the breakdown is the
interesting part, and `finding` where a turn re-stages something already in
`conversation-rules.md` — that is what makes a recurrence visible across runs.

`scripts/judge.mjs` writes the same file from a judge model when there is nobody free to
read. It is interchangeable with a person's, deliberately: a machine verdict can be
overwritten by a human one and nothing downstream changes.

---

## Writing it up

`node scripts/report.mjs` renders `record.json` and `judgement.json` together into one
page — the per-turn table with your scores, the persona split, every turn opened up with
its reasoning and its SQL, and the seven axes with the evidence under each.

The analysis that page is modelled on is
`.probe/reports/2026-08-17-stress-month-analysis.html`. Three things made it worth reading,
and they are worth copying:

- **The verdict is one sentence, first.** *"The conversation is close to excellent and the
  consequences are not."*
- **The pattern is found by splitting, not by averaging.** Scores by persona turned a list
  of incidents into one finding: every catastrophic turn in the month was a client turn.
  The same month weighted toward the operator scores 8.2 and reads as a good result.
- **What went right is argued as hard as what went wrong.** A 10/10 with the six reads that
  earned it is evidence about the product; a page of failures alone is not.

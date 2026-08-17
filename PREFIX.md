# The prefix

What the model is told, why it is shaped this way, and what may be added to it.

`product-spec.md` is the authority on what the product does. `DRIVING.md` is how you find
out whether it does it. **This file governs the prompt** — read it before you add a line to
any block above the cache boundary, and read the graveyard at the bottom before you add one
that has already been removed.

It exists because the deletion in this file's history has happened twice. The first time,
eleven behavior modules were retired by measurement and the rule meant to keep them out was
written into a code comment. A third of the choreography grew back inside `DOMAIN_FACTS`
anyway, and nobody noticed for months, because a bullet is added by someone who never opens
the comment above the constant. A test with no record of what it already rejected does not
hold. Hence: the test, and the record, in one document, at the root.

---

## What the prefix is

Every turn sends one string assembled by `stablePrefix()` in `lib/agent/context.ts`, plus a
variable tail built per-turn by `variableTail()`, plus the tool declarations from
`lib/agent/tools.ts`.

**The prefix must be byte-identical across every turn, for every person, in every business
served, forever.** That is not a style preference; it is the entire cost model. The
provider's automatic prefix cache matches on bytes, a hit costs **3.2% of a miss**, and there
is no handle to hold — no key, no invalidation call, nothing to tune. One date, one id, one
count, one per-tenant word above the boundary and every turn pays full price.

So: nothing computed, nothing dated, nothing per-academy, above the line. Anything that
varies goes in the tail, which is rebuilt and re-billed at full price on every round.

**A sentence living in both the prefix and the tail is paid for on every round and cached on
none.** When you find a duplicate spanning the boundary, the prefix copy is the one that
survives.

## The layers, and the question each answers

In assembly order. Order above the boundary is **free** — the block caches identically
whatever sequence it is in — so the sequence is chosen entirely for the reader.

| Block | Answers | Lives in |
| --- | --- | --- |
| `PREAMBLE` | What am I, who am I serving, what am I allowed to do? | `context.ts` |
| `SCHEMA_DOC` | What is in the world, and how do I query it? | `schema-doc.ts` |
| `# Operations` | When should I reach for a known-good plan? | `context.ts` |
| `catalogDigest()` | What moments will code put in front of me? | `messaging/catalog.ts` |
| `PLATFORM` | What can this surface actually do? | `context.ts` |
| `DOMAIN_FACTS` | How does this business behave on its own? | `context.ts` |
| `lib/doctrine.md` | When two good answers conflict, which wins? | on disk |
| — boundary — | | |
| variable tail | Who is this, what time is it, what did I already look up? | `context.ts` |

Two properties of that order are load-bearing:

- **Facts before principles.** A rule about sessions is unreadable before `session` exists.
  Doctrine used to sit at position two, ~35k characters before the model saw a table name.
- **Doctrine last, against the boundary.** It is the thing every judgement derives from, so
  it should be the last thing read before the situation. Moving it cost nothing.

## The admission test

Before adding any line above the boundary, in this order:

**1. Would an intelligent model derive this?** It has the doctrine, the schema, the tool
declarations and the catalog. If a competent reader of those produces this behavior without
being told, the line does not go in. The model is DeepSeek on low thinking and it is more
than clever enough for this product; the prefix exists to give it *context it cannot
otherwise have*, not to walk it through decisions it can make.

**2. Is it already stated somewhere in the same cached block?** Then it goes in exactly one
place, and that place is the one nearest the decode point. Duplication inside the prefix is
paid for once and costs attention every turn, which is the scarcer resource.

**3. Is it a fact, or is it a script?** **Facts state; scripts demonstrate.** A line that
tells the model what to do in a named situation is a script no matter how factual its
grammar. *"A broadcast list only reaches people who saved the number"* is a fact. *"Cold
outreach runs staged: a small first batch, then the signals, then the rest"* is a script
wearing a fact's clothes, and it was removed twice.

If a line passes all three, it still has to go in the right layer.

**Cite doctrine by name, never by number, in source comments.** Doctrine has been
renumbered twice in one day and every numbered citation in the codebase went stale both
times, silently — a comment pointing at "rule 18" now points at something else entirely.
`*work with complete information*` survives a reshuffle; `doctrine 7` does not. (The
outbound scrubber `stripDoctrineRefs()` only matches `§n.n` section refs, so this is a
maintenance rule, not a leak risk.)

## The placement ladder

Where a constraint belongs, strongest first. **Always place as high on this ladder as the
constraint allows.**

1. **A hard constraint on a tool call → the tool declaration.** A declared schema constrains
   generation; a paragraph constrains nothing. This is where this repo has consistently put
   hard constraints and where it has measured them to work. Operation arguments used to be
   5,789 characters of prose in the prefix, tens of thousands of characters upstream of the
   decode point, in the one form a function-call decoder cannot apply.
2. **A fact about the data model → `SCHEMA_DOC`.** Tables, columns, the FK graph, derived
   expressions, the billing rules that decide which rows exist. Schema and only schema; it
   grew a behavior layer once and it was cut back out.
3. **A fact about the surface → `PLATFORM`.** What WhatsApp and this runtime will and will
   not do. The test is whether it changes what is worth *attempting*.
4. **A rule of the business → `DOMAIN_FACTS`.** How money, schedules and people behave, and
   what the product does unasked.
5. **A value where *helpful* and *correct here* diverge → `lib/doctrine.md`.** This is the
   narrow gate. "Quiet by default" earns its place because a maximally helpful model sends
   *more* messages, not fewer — the instinct and the correct behavior point opposite ways.
   A rule that merely restates good practice does not need saying.
6. **A behavior in a named situation → nowhere. Build it.** This is the rung everything
   deleted was standing on.

Note that `lib/doctrine.md` is also sent **alone** by `synthesisDoctrine()` to the brief and
the digest, which author no SQL and call no operations. Anything you put in doctrine must be
true on that path too — which is why the capability statement lives in `PREAMBLE` instead.

## The traps

Each of these has an incident behind it.

- **Never state a count of anything.** A count is the one thing here that goes stale
  silently: nothing checks it, and the model cannot tell a miscount from something it has
  been told to ignore. The capability sentence in `PREAMBLE` says "operations", not a number
  of them, for exactly this reason.
- **No worked chat examples.** The model imitates an example's *surface* along with its
  content. Bracket-formatted button rows in prefix prose were typeset into live message
  bodies as text nobody could tap — a claim of an affordance that did not exist.
- **Anything read from disk must be named in `next.config.ts` `outputFileTracingIncludes`.**
  Paths assembled at runtime are invisible to Next's static output-file tracing.
  `lib/doctrine.md` was missing from every deployed lambda; it threw on every hosted turn
  before the model was reached, and the only symptom was that everyone got the loop's
  apology. It read as a flaky model for as long as the deploy was up.
- **Every label in the census is prompt, and nobody reviews a label as prompt.** The rule:
  read the label and its value with no access to the SQL above it, and say the sentence they
  license. If that sentence can be false, **the label is wrong, not the predicate**.
  `uncovered_sessions_next_36h` was correct SQL under a name that told an owner, four times,
  that his only coach was not assigned to a class he was assigned to.
- **`null` is a failed read; `[]` is an empty one.** They are opposite sentences downstream.
  A refused query or a 5s timeout rendered as "no upcoming sessions" is the one sentence a
  parent acts on by not turning up.
- **Prose the model writes in a round that calls tools reaches nobody.** It is a notebook,
  not a message.
- **Check for capabilities the runtime built that the prompt never mentions.** This is the
  inverse of adding what the model can derive, it is just as expensive, and it is much
  harder to see — nothing fails, a feature is simply never used. `lint.ts`'s
  `toWhatsAppMarkup` has been converting `**bold**`, `- item` bullets and markdown tables
  into WhatsApp markup for as long as it has existed, and nothing above the boundary told
  the model formatting survived; doctrine's *"plain sentences"* line was probably
  suppressing it outright. Same shape: `{kind:'reply', text}` mints a button that needs no
  arguments, which makes a spare button slot nearly free, and `[What can you do?]` stayed
  the most-minted button in the product anyway. **When you add a runtime affordance, ask
  what tells the model it exists.**

## How you know you were right

Measurement, not taste. Four tools, in the order you should reach for them:

```bash
npm run surface          # everything the model is shown, in one greppable file
npm run ask              # ask the model what it understood; ~₹1 a run
npx tsx scripts/probe-prefix.ts     # where the bytes go, block by block
npx tsx scripts/probe-ceiling.ts    # what the whole cached block costs
```

`probe-prefix.ts` is the source of truth for size — this document deliberately quotes no byte
counts, because a number written here goes stale exactly the way a count in the prompt does.

**`npm run surface` is how you check coverage, and the direction matters.** Reading the prompt
tells you what is in it and can never tell you what is missing, because absence has nothing to
point at — `toWhatsAppMarkup` converted markdown for as long as it existed while nothing above
the boundary mentioned formatting, and that survived every reading of `context.ts`. So work
backwards: inventory the runtime **blind to the prompt**, then grep the surface for each item.
A blind reader is the point; anyone who has read the prefix is anchored to it and will confirm
rather than audit. The dump includes the tool declarations, which are ~37% of what the model
sees and are invisible to anyone reviewing `context.ts` alone.

**`npm run ask` measures comprehension, which is not the same as presence.** Toolless questions
against the real prefix, so only the prefix can be responsible for the answer; scenarios are
real logged failures, so there is ground truth. Its `must`/`mustNot` patterns are a **tripwire,
not a grade** — the first run flagged three answers and all three were correct, including
`/it worked/` firing on *"Don't tell her it worked. That would be a lie."* Read the answers.

Note what it cannot do: it measures the **ceiling**. A good answer proves the context is
sufficient, not that the behaviour happens — looking is free here and costs a round in a real
turn, and prose still has to become valid tool calls. A bad answer is conclusive and cheap; a
good one still needs the drive.

For behavior: **drive the same arc twice, one variable apart**, and read
`scripts/arc-report.mjs`. That is how the eleven modules were retired — truth tied 253/261 in
both arms, the module-free arm's replies were plainer, its two best moments were *derived*
from doctrine rather than prescribed, and the prescriptions were implicated in their own
arm's two worst behaviors. It is the only evidence that justifies adding anything back.

## The standing prohibition

From `conversation-rules.md`:

> None of these are prompt problems. Every finding names a structural home, and the repo's own
> evidence is that instructions do not close behavioral classes. **Do not fix any of this by
> adding doctrine.**

When a drive turns up a defect, the fix is a declaration, an executor, a guard, a view, or a
gate. Reaching for the prefix is how the prefix doubled last time. If you genuinely cannot
find a structural home, write the finding down without a fix rather than writing a paragraph
that makes the problem feel handled.

---

## The graveyard

Removed, with the argument. **Re-adding anything here requires a drive showing its absence
cost something** — not a hunch that the model might need telling. If you are about to write
one of these, you have rediscovered a thing that was already considered and rejected.

| Removed | When | Why |
| --- | --- | --- |
| The eleven behavior modules | phase-6 arc | Retired by measurement. Same lifecycle driven with and without them; truth tied, the module-free replies were plainer, and the prescriptions were implicated in their own arm's two worst behaviors. |
| ~20 operation signatures as prose (5,789 chars) | — | Moved into the tool declarations, where a schema constrains decoding. A paragraph upstream of the decode point constrains nothing. |
| *"Reschedule is the makeup — the first offer is another slot"* | 17 Aug 2026 | A policy choice, derivable once `reschedule_session` is declared with its own consequence line. Script, not fact. |
| The staged cold-outreach procedure (*small first batch, then the signals, then the rest*) | 17 Aug 2026 | Choreography. The underlying facts — shared sender number, one block is a signal about the batch — stayed in `PLATFORM`. |
| *"What earns a cold message a read"* (the four-part recipe) | 17 Aug 2026 | A script. The fact that a first message is the highest-risk send stayed. |
| The safety-escalation script (*no details first, no buttons, one line, then handoff*) | 17 Aug 2026 | Promoted, not deleted — it is doctrine hard stop 1 now. It was a sub-bullet in the last section of an advisory block, ~40k characters in, and it is the one rule where a wrong call is unrecoverable. |
| Doctrine 4 (buttons / forms / no URL) and 7 (next step as a button), **as operational instructions** | 17 Aug 2026 | Verbatim in the `reply` declaration already: *"Offer the natural next step as a button"*, *"NEVER write a web address into the body"*, *"a form is always an offer and never a toll"*. Rung 1 beats rung 5. The second pass that day put the *principle* back as doctrine 7 — deliberately, and only the half the declaration does not carry: the spare button slots, and demonstrating capability rather than announcing it. Restating a declaration is still forbidden; generalizing past one is not. |
| Doctrine 9 (roles are hats) | 17 Aug 2026 | In `SCHEMA_DOC` **and** emitted per-person in the tail. Third copy. |
| Doctrine 17 (you cannot open media) | 17 Aug 2026 | Moved to `PLATFORM`. Zero principle content; a platform limit filed among values is a limit nobody re-reads. |
| Doctrine 14's two worked ₹ examples | 17 Aug 2026 | The rule stayed. Worked examples get imitated as surface. |
| *"A cover offer reasons about the taker's own day"* | 17 Aug 2026 | Derivable from doctrine 7 (look sideways) plus the coach-hours fact. |
| *"Somebody asking you to stop wants less, not silence"* | 17 Aug 2026 | Derivable from doctrine 4 and 6. The capability it depended on — what reaches somebody is countable from the `message` table — stayed. |
| The `# Situations` block | 17 Aug 2026 | Said the same thing as `PREAMBLE`'s latitude paragraph, ~20k characters away from it. Two hedges merged into one grant. |
| *"setup, roster, ready and live are column values"* | 17 Aug 2026 | Promoted into doctrine 12 as *never narrate the machinery*, which is the general form. |
| *"Have an opinion, be willing to lose the sale"* | 17 Aug 2026 | Promoted into doctrine 12. It was a **value** misfiled as a fact — the ladder's rung 5, sitting on rung 4. |

### Reframed, not removed — do not "restore" these

A second pass on 17 Aug 2026 cut doctrine from 14 rules to 12 by making the headlines
generic. The content survived; only the naming and the grouping changed. If you go looking
for one of these and cannot find it, it is because it is now stated more broadly — not
because it was dropped.

| Old rule | Now |
| --- | --- |
| *"Look sideways before you write"* | **5 · Work with complete information.** The metaphor needed decoding before it could be applied and did not generalize past the cases it listed. |
| *"Read back before acting"* | Folded into **5**, as the last clause. Same moment, same principle. |
| *"Zero rows is an answer, never the whole answer"* | **6 · Do not assume.** |
| *"When you are unsure, say which part"* | Folded into **6**. Both are the same failure — filling a gap with a plausible guess — and splitting them hid that. |
| *"The chat is always open, and say so once"* | **7 · Make life simpler for them.** |
| *"Speak their language, and never narrate the machinery"* | **8 · Speak simply, and lay it out so it can be read one-handed.** |
| *"Suggestions ride on a message already going out"* | Moved into **10 · Say what will stop**, where it sits next to the other rule about what does *not* get sent. |

Two things were **added** in that pass rather than reframed, both of them capability the
model had no way to know about:

- **Doctrine 7 now names the button budget.** Three slots, the obvious next step rarely
  needs all three, and a `{kind:'reply', text}` button needs no arguments — so the spare
  slot should show them something they would not know to ask for. `tools.ts:603` had
  already recorded the defect (*"[What can you do?] is the most-minted button in the
  product and it announces capability instead of demonstrating it"*) and fixed as much of
  it as a runtime backstop can: `backstopButtons` only helps an admin before go-live,
  because from where it stands it cannot guess a useful third button. The model composing
  the reply can, and nothing had ever told it to.
- **`PLATFORM` now states that formatting survives.** See the trap above.

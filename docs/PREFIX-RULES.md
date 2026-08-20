# The prefix

What the model is told, why it is shaped this way, and what may be added to it.

> **To read what the model is actually shown, run this — do not reconstruct it from `context.ts`:**
>
> ```bash
> npx tsx scripts/probe-surface.ts > .probe/surface.txt     # or: npm run surface
> ```
>
> That is the assembled `stablePrefix()` **plus** every tool declaration, in one greppable
> file — the complete set of things the model knows before the per-turn tail is built. The
> declarations are ~29% of the surface and live in a different file, so reading `context.ts`
> alone shows you neither them nor how a fact in one layer reads against another. It writes
> nothing but the dump, needs no database, and takes a few seconds. The per-turn tail is not
> in it: `variableTail()` in `context.ts` is the only place that lives.

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

### The declarations are inside it

The tool block is not an argument travelling beside the prompt. It serialises between the
system string and the messages, which puts it *inside* the block the cache matches on — so
everything above governs it too, and two things follow.

**A changed tool description invalidates the prefix.** One miss-priced call, and then the new
block is the cached one. That is a deploy, not a defect.

**Every model call in a turn sends `toolDecls()` in full.** A round that filters the list down
to the tools it means to honour has edited the prefix: the match walks the entire system
prompt, diverges at the tool block, and everything behind the divergence — the filtered
declarations *and* the whole conversation — is billed fresh.

The post-send reflection round did that for five days with a two-name filter, and the meter
shows it as cleanly as anything in this repo has been shown. Its `cached` was **exactly 17,024
on 57 of 57 calls**, invariant across five days, every persona and every conversation length,
while the main loop never cached below **22,656**; the 5,632-token gap is the tool block, and
the 17 Aug run has the same flat signature against a constant of 14,592. It ran at a 69.9% hit
rate against the loop's 94.3% and 7,348 miss tokens a call against 1,625 — a quarter of the
run's input volume, **64% of every cache miss in it**, ₹6.48 of a ₹29.52 run off-peak and
double that at peak. The filter bought nothing it was there for: the dispatcher was already
dropping every call outside its two names, and `repliedTo` was already refusing a second reply.
Sending 22 more declarations made the round 57% cheaper.

It was never only money, either, and this is the part that generalises past caching: **the
cached block above the tools still describes every tool the product has.** A filtered list
withdraws declarations the prefix is still advertising, so the round is handed a surface that
contradicts what it has been reading all turn — and 13 of those 57 rounds reasoned their way
toward calling one of the 22 that had been taken away. Narrowing what the model is shown is
not the same as narrowing what it can do, and only one of those two is free.

**So: constrain a round at its dispatcher, never by narrowing what it is shown.** More prompt
is the cheap direction — a hit costs 3.2% of a miss, and the filtered round paid full price for
the *same* two declarations plus the entire conversation behind them. `npm run verify:static`
holds this one now: a `tools:` argument under `lib/agent` that is not `toolDecls()` fails the
build. What it cannot see is a round that sends *no* tools, which two of `loop.ts`'s rounds do
on purpose — the recovery round and the prose retry say "no tools" in their prompts and mean
it. Those pay the whole block as a miss, and both run only after a turn has already gone wrong.
A round on the every-turn path cannot be paid for that way.

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
| tool declarations | What can I do, and with exactly which arguments? | `tools.ts` |
| — boundary — | | |
| variable tail | Who is this, what time is it, what did I already look up? | `context.ts` |

Two properties of that order are load-bearing:

- **Facts before principles.** A rule about sessions is unreadable before `session` exists.
  Doctrine used to sit at position two, ~35k characters before the model saw a table name.
- **Doctrine last, against the boundary.** It is the thing every judgement derives from, so
  it should be the last thing read before the situation. Moving it cost nothing. It is last in
  the *string*; the declarations come after it and before the messages, and nobody chose that
  — the server places them, which is exactly why they are billed like prefix and have to be
  treated like prefix.

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
`*work with complete information*` survives a reshuffle; `doctrine 7` does not. (Nothing
scrubs these on the way out any more. `stripDoctrineRefs()` went with *the runtime stops
editing prose*; `proseViolations()` in `lib/agent/lint.ts` now **refuses** an outbound body
carrying a section reference, naming the offending text, rather than quietly cleaning it.
So this is still a maintenance rule rather than a leak risk — but the leak now fails loudly
instead of being edited away.)

## The placement ladder

Where a constraint belongs, strongest first. **Always place as high on this ladder as the
constraint allows.**

1. **A hard constraint on a tool call → the tool declaration.** A declared schema constrains
   generation; a paragraph constrains nothing. This is where this repo has consistently put
   hard constraints and where it has measured them to work. Operation arguments used to be
   5,789 characters of prose in the prefix, tens of thousands of characters upstream of the
   decode point, in the one form a function-call decoder cannot apply.
2. **A fact about the data model → `SCHEMA_DOC`.** Tables, columns, the FK graph, derived
   expressions, the billing rules that decide which rows exist, and who may read or write
   each row. Schema and only schema; it grew a behavior layer once and it was cut back out.
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

### Rung 2's mirror: a derivation in the prefix beats the database every time

`app.account_balance()` has existed since the first commit, handles the period question,
and was called by the model **zero times in every run ever recorded**. Not because it was
hidden — it is in the helper list — but because `SCHEMA_DOC` also stated the arithmetic,
and a formula the model can read beats a helper it has to remember exists. Two authors of
one truth, and the prose author won.

So the rule, and it is narrower than "build views for common questions":

> **A value earns a view or a helper when the same join is written on every turn that
> needs it AND one of its predicates is where it goes wrong. It arrives with the deletion
> of whatever the prefix said instead, in the same change.**

A view added beside a surviving derivation is surface added and the failure kept. What
should replace the derivation is not a pointer at the view — it is **the fact underneath
it**: which table carries what, and therefore which questions have answers. That part is
not derivable, and it is usually the part that was wrong. When the balance formula went,
what took its place was *tally_line carries a period and payment does not* — which is why
the sentence the formula licensed had no answer in the first place.

The second-order gain is the one worth designing for. Doctrine's *work with complete
information* asks for the row beside the one you came for; that row is in a different
table, and working out which one costs exactly the round the doctrine was trying to save.
A view at the grain somebody actually asks at is how that read becomes affordable — so
a view is not a shortcut for a query the model could write, it is the part of the answer
it would not have thought to ask for.

~~Note that `lib/doctrine.md` is also sent **alone** by `synthesisDoctrine()` to the brief and
the digest.~~ **That path is gone (17 Aug 2026).** The brief and the digest are ordinary turns
opened by a job, so they get the same prefix, the same tools and the same flight recorder as
every other turn — and the constraint goes with the path: nothing in doctrine has to be true
on a toolless path when there is no toolless path. The capability statement stays in
`PREAMBLE` regardless, because moving it is a prompt change and prompt changes here are made
on the evidence of a drive rather than on a tidy-up.

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
npm run check:schema-doc # does the schema block still describe the real database?
npm run check:rls-doc    # does the permission matrix still describe the real policies?
npx tsx scripts/probe-sql.ts        # can it actually WRITE the SQL? real rows, real verdicts
npx tsx scripts/probe-prefix.ts     # where the bytes go, block by block
npx tsx scripts/probe-ceiling.ts    # what the whole cached block costs
```

**`probe-sql` is the one that answers the question this prefix now lives or dies
on.** Since the wrapper operations went, nearly every write is SQL the model
composed, and neither of the two probes above can tell you whether a statement
was correct — `ask` has no tools and `probe` judges the sentence the person got.
This drives 25 cases up a difficulty ladder and decides each on **what is true in
the database afterwards**. Its top rung is not harder SQL; it is the cases where
the obvious SQL is wrong in a way Postgres does not complain about.

Read it with `lib/agent/sql-trace.ts` in mind: that is what makes the WRITE half
visible at all. A plan carrying six statements was one clipped line in the flight
recorder, so which statement was refused, and what Postgres said about it, was
recorded nowhere. **A case that passes while the model wrote four wrong
statements first is a case that passed and should be read.**

**`check:schema-doc` is the cheap half, and it runs in a second.** `SCHEMA_DOC`
is a hand-maintained string whose own header promises it changes when the
migrations change — a promise kept by remembering, and the record shows it was
not kept. So the check asks the database instead, in both directions: every table
and column named must exist, every `!` must really be NOT NULL with no default,
and **every NOT NULL column must carry a `!`** — that last one being the
direction no reading of the document can catch, because absence has nothing to
point at. It also refuses a view under the wrong schema, which is how
`app.session_coverage` reached a live turn. It does not check prose; nothing can.

**`check:rls-doc` is the same idea pointed at the permission matrix**, and it exists because
the matrix is the one block in the prefix that is a second copy of something the database
already states. It reads the grid and asks `pg_policies`, in both directions: a cell that
says nobody may write must have no policy, a cell naming a role must have the helper that
backs it, and — the direction a reading cannot catch — **a policy naming a role the cell
does not mention is a permission nothing tells the model it has.** It does not check prose;
whether *"their own family's"* fairly describes a five-clause `EXISTS` is a reading. Its own
first run found two defects in itself (`\bcoach\b` does not match *coaches*; `my_session_ids()`
hides the family branch inside a SECURITY DEFINER function), which is the argument for
mutating the grid and watching it go red before trusting a green.

`probe-prefix.ts` is the source of truth for size — this document deliberately quotes no byte
counts, because a number written here goes stale exactly the way a count in the prompt does.

**`npm run surface` is how you check coverage, and the direction matters.** Reading the prompt
tells you what is in it and can never tell you what is missing, because absence has nothing to
point at — `toWhatsAppMarkup` converted markdown for as long as it existed while nothing above
the boundary mentioned formatting, and that survived every reading of `context.ts`. So work
backwards: inventory the runtime **blind to the prompt**, then grep the surface for each item.
A blind reader is the point; anyone who has read the prefix is anchored to it and will confirm
rather than audit. The dump includes the tool declarations, which are a large fraction of what the
model sees (the share is quoted once, at the top of this file) and are invisible to anyone
reviewing `context.ts` alone.

**`npm run ask` measures comprehension, which is not the same as presence.** Toolless questions
against the real prefix, so only the prefix can be responsible for the answer; scenarios are
real logged failures, so there is ground truth. Its `must`/`mustNot` patterns are a **tripwire,
not a grade** — the first run flagged three answers and all three were correct, including
`/it worked/` firing on *"Don't tell her it worked. That would be a lie."* Read the answers.

Note what it cannot do: it measures the **ceiling**. A good answer proves the context is
sufficient, not that the behaviour happens — looking is free here and costs a round in a real
turn, and prose still has to become valid tool calls. A bad answer is conclusive and cheap; a
good one still needs the drive.

For behavior: **drive the same arc twice, one variable apart**, and read both with
`npm run report`. That is how the eleven modules were retired — truth tied 253/261 in
both arms, the module-free arm's replies were plainer, its two best moments were *derived*
from doctrine rather than prescribed, and the prescriptions were implicated in their own
arm's two worst behaviors. It is the only evidence that justifies adding anything back.

## The standing prohibition

From `findings/RULES.md`:

> None of these are prompt problems. Every finding names a structural home, and the repo's own
> evidence is that instructions do not close behavioral classes. **Do not fix any of this by
> adding doctrine.**

When a drive turns up a defect, the fix is a declaration, an executor, a guard, a view, or a
gate. Reaching for the prefix is how the prefix doubled last time. If you genuinely cannot
find a structural home, write the finding down without a fix rather than writing a paragraph
that makes the problem feel handled.

---

## What was added, and the argument for it

Recorded for the reason the graveyard is: the next reader has to be able to tell a line that
earned its place from one that grew back. An addition here means the admission test was run
in public and the answer written down — not that the block is now open.

| Added | When | Why |
| --- | --- | --- |
| **Four views, and the views given one section** — `session_detail`, `class_roster`, `account_standing`, `person_directory`, in `SCHEMA_DOC` (migration 0036) | 18 Aug 2026 | Rung 2 four times, each landing with the deletion it licenses (see the graveyard). The argument is not that the model finds joins hard — it writes them fine. It is rung 2's mirror above: **a view is the only cheap way to buy the read doctrine already asks for.** Measured over every recorded run, the model hand-joined `class` 1233 times, `person` 780, `session` 729, `account` 426, `enrollment` 399, `tally_line` 225, `payment` 198 — against 100 reads of `app.session_roster`, which is the most-used object in the schema because it is the only one that answers a question in the words somebody asks it. Each new one has a predicate that was measurably going wrong: `class_roster` because every hand-written roster in the records omits `player.active`, so a child who has **left the academy** stays on the register; `account_standing` because the recurring hand-rolled shape is a month of charges less every payment ever made; `person_directory` because the hand-written person lookup inner-joins `account`, which turns *"exists in another role"* into *"no such person"*; `session_detail` because `session_coach`'s three empty timestamps had no name, so *assigned* and *confirmed* were one judgement call apart on every turn. **They are in one section for a reason of its own:** scattered across three homes a view is a thing you look up, and the model never forms the concept that the database holds answers at all. Kept honest by `check:schema-doc` (the view exists, under that schema) and `check:rls-doc` (each really is `security_invoker`) — both lists extended in the same change, because a name missing from them passes vacuously. The first run of `check:schema-doc` caught a defect in this very entry's prose: a bare `session_roster` in the new section, which is a name that does not exist outside `app`. **`person_directory` is the one that met the first clause and not the second** — nothing in the prefix was deriving it, so there was nothing to delete, and its argument is the different one: the tail dossiers the person in the seat and nobody else, which teaches every turn that the background you need arrives on its own. That makes it half a mechanism; the other half is the line in the tail naming the edge of the block, because telling the model to look is useless without one place to look. It also made it a **second author of the tail's own `standing()` block**, and the first draft drifted from it inside an hour: the view returned mutes whose `until` date had passed, which `standing()` correctly drops, so a mute that lapsed last week came back looking live. The predicates are now identical in both and each says so — the trap is not that two things compute one truth, it is that nothing makes them read each other. |
| **`app.local_label(ts)` and `app.local_clock(ts)`** — time rendering as a helper, in `SCHEMA_DOC` | 18 Aug 2026 | Rung 2, and it is the graveyard's own general lesson applied to a rule that was still standing: **a rule the writer must remember is a default the database should hold.** The block said *"render in the academy's timezone, never raw"* — obeyed by remembering — and the incident behind it is the most expensive in the product: `06:00` read back as "6pm", defended when pushed, a parent sent to a locked hall. `census()` had already fixed it for the rows the census carries, by calling `inZone().label`; every other read still handed back raw UTC. These produce the same string in SQL, so any read can. A helper rather than a column on each view, because a helper generalises and a column only renders the timestamp its own view carries. |
| **`unmarked_billable_session`** — the third unqualified view, in `SCHEMA_DOC` | 17 Aug 2026 | Rung 2, and it is a view before it is a sentence: the block names a thing the database now holds. *"Is anything sitting unbilled"* was derived from `rate_unit` × attendance × `tally_line` on every turn that asked, and derived-under-pressure is where it went wrong — the product called a per-MONTH class "the one sitting unbilled" and, three days later, correctly said nothing was unbilled over the same registers. Neither turn was wrong about anything else and the billing rules are already stated plainly in both directions, so another sentence would have changed nothing. Coverage — the comparable derived value — has had two views and a helper all along. The name is the load-bearing part: `unbilled_session` licenses *"this family owes money"*, which is false for three of the four rate units, so it is named for the predicate instead. Kept honest by `check:schema-doc`, which refuses a view under the wrong schema. |
| **Open watches, in the variable tail** (below the boundary — listed here because it replaces a prefix line) | 17 Aug 2026 | Not an addition above the boundary at all; it is what let one come OUT. `job` is RLS-closed in both directions and correctly so, so the prefix told the model to answer *"what you have scheduled"* from what it remembered doing — carrying pending state across turns from memory, which ARCHITECTURE lists by name as never to be trusted to it. Driven: the model recalled a watch correctly and said so, and the recall was luck. Worse, F-C's supersession keys on a `subject` string that both callers had to phrase identically **while neither could see the strings it was matching against**. `liveAgentTasks` was already being called on every `schedule` for the cap check and its rows were discarded. |
| **Two parameter descriptions on `send_invite_draft`** | 17 Aug 2026 | Rung 1, ~80 characters, and it makes a built feature reachable for the first time. The operation has always served §9.1 step 2 — it takes `person_id` and mints the same `wa.me` deep link — but the declaration named neither id and the description implied a coach, so the model told an owner to *"share an invite link"* in prose and then worked out, one message later, that *"there isn't an explicit operation for family invites in the tools besides send_invite_draft (coach)"*. That is a correct reading of what it had been shown. **A parameter with no description is a capability with no advertisement** — the trap below, in the mirror. |
| **The permission matrix** — who may select, insert, update and delete each table — in `SCHEMA_DOC` | 17 Aug 2026 | Rung 2, and it passes the first test in the only way that matters: **policies are invisible from inside a session, so the boundary can only be found by crossing it.** The block previously said, in as many words, that the boundary "is not listed here because it is enforced per row rather than per table" — true, and it was paid for in rounds. The model planned writes a coach or a family cannot make, was refused mid-plan (or worse, silently matched nothing on an UPDATE), rediscovered the shape and re-planned; and the cost is not the tokens, it is the round — latency on every turn where it happens, and on a hard turn the rounds budget itself, which is a timeout rather than a wrong answer. It also poisoned the *plan*: a preview built around a step the person may not run is a promise already broken. The trade is bytes in the cached block, where a hit costs 3.2% of a miss, against whole rounds on the wire at full price. Kept honest by `check:rls-doc`, because a grid in a string and the policies in `0003_rls.sql` are the trap ARCHITECTURE.md calls **two authors of one truth** — so one is made to read the other. |

## The graveyard

Removed, with the argument. **Re-adding anything here requires a drive showing its absence
cost something** — not a hunch that the model might need telling. If you are about to write
one of these, you have rediscovered a thing that was already considered and rejected.

| Removed | When | Why |
| --- | --- | --- |
| *"**Balance for a period** = sum(tally_line.amount) - sum(confirmed payment.amount)"* | 18 Aug 2026 | The line that beat its own helper, and it was wrong besides. It is why rung 2's mirror is now written down: `app.account_balance()` was used zero times in every recorded run because this sentence handed over the arithmetic. And the arithmetic is not a quantity — it names a PERIOD balance and gives an expression with **no period predicate on either side**, while `lib/jobs/handlers/money.ts` refuses the same computation in as many words (*"payment carries no period, so a payment cannot be attributed to a month and 'what is owed for August' is not a computable quantity here"*) and the helper manufactured it from the confirmation date. Three authors, three answers, on money. Driven: an owner told a family was *"in credit ₹2,400, September covered"* while the family was told *"₹2,400 of charges on the 1st"*, ninety seconds apart — this expression hand-applied with the charges filtered to a month and the payments summed across all time, a shape that recurs verbatim across the run records. Replaced by the fact underneath: which of the two tables carries a period, and therefore which two questions have answers. |
| *"**Effective rate** … coalesce(enrollment.rate_amount, class.rate_amount), and the same for rate_unit and rate_count"* | 18 Aug 2026 | The expression went; the fact stayed, because where the rate lives is not derivable and still governs every write. The `coalesce` **is** derivable from *"lives on the enrollment and falls back to the class"*, and `class_roster` now carries it already resolved — so what was left was a read recipe competing with a view, which is the balance line's shape exactly, caught by the same rule. |
| *"**You cannot tell from here whether a given person's window is open**"* in `PLATFORM` | 18 Aug 2026 | **False, and false for as long as `contact.last_inbound_at` has existed.** `lib/messaging/window.ts` decides the window with one subtraction against that column, `SCHEMA_DOC` lists the column, and `lib/identity.ts` stamps it on every inbound. This is the trap in the list above — *check for capabilities the runtime built that the prompt never mentions* — in its worst form: not an unmentioned capability but a **denied** one, which no amount of reading the prompt for what is missing will ever surface, because the sentence is right there answering the question. The decision it was denying is real: the message worth sending into an open window and the message worth sending into a shut one are not the same message, and the model was told not to bother working out which it had. |
| *"do not quote a balance, **a rate** or a due amount to them"* — the money line in the variable tail | 18 Aug 2026 | Below the boundary, listed here because it is a prompt line that contradicted the prefix and won by being later and more specific. `seesMoney` is `app.sees_money()` and it gates exactly two tables — `tally_line` and `payment`, **the families'** money. "A rate" is wider than that in two directions and both were driven. A coach's own `pay_amount` is granted by 0003 on purpose (*"own row INCLUDING own pay_amount"*) and stated twice in `SCHEMA_DOC`, so a coach asking what he is paid was told the product could not see it — twice, once on the last day of a month, while the same figure was read out to the owner in another thread. And `class.rate_amount` is readable by everybody, so a prospect asking the price met a model talked out of the one number the conversation was about, against doctrine's own *name the real friction before the booking*. Nothing in that sentence was ever what protected another coach's pay: the `coach` policy is own-row-only and `coach_public` has no pay column. |
| *"never answer 'nothing is scheduled' … from one: what you have scheduled is a thing to say from what you did, not to look up"* | 17 Aug 2026 | An instruction to reconstruct state from memory, which is the one thing layer 0 exists to replace — and it was in the prefix because the tail did not carry the watches, not because looking them up was wrong. Now the tail lists every live watch with its subject, so the sentence is replaced by a fact. **The general lesson, and it is the third time this repo has learned it: an instruction telling the model to remember something is a row that is not being shown.** The surrounding paragraph stays — `job`, `audit_entry` and `turn` really are closed in both directions. |
| *"a mid-month join is billed the whole month until an adjustment fixes it"* | 17 Aug 2026 | Not removed for being wrong about the charge — the full line still stands, because pro-rating is a policy nobody stated and inventing one is how an invention acquires the authority of policy. Removed because it stopped being the whole truth the moment the writer started raising a moment about it, and **a stale fact in the prefix is worse than a missing one**: the model would have gone on telling owners nothing was coming while a message was already on its way. Reworded in the same commit as the mechanism, which is the only way this sentence and that code stay one truth. |
| *"every INSERT must set academy_id = app.academy_id() explicitly, on every row"* | 17 Aug 2026 | The column defaults to it now (0034), on all 25 tenant tables. The instruction was a rule fighting the shape of the language: the model knew it, wrote the natural statement anyway, and paid a round for the RLS refusal — whose text names a permission and means a missing column. **The general lesson is the mirror of the class/session one: a rule the writer must remember is a default the database should hold.** The `STEPS_PARAM` examples stopped carrying the column too, because an example is imitated as surface. |
| *"to fetch several things at once combine them with WITH … UNION ALL"* | 17 Aug 2026 | Advice that is a trap for the case it was given for. Stacking a venue id onto a coach status unions uuid onto text, and Postgres refuses the statement outright — driven twice in one turn, the retry the same shape. Replaced with sub-selects in one SELECT list, and with the fact that several `read` calls in one round cost one round between them. |
| *"The operations that remain are the ones with no SQL sentence … everything else is rows, and the rows are yours to write"* | 17 Aug 2026 | Factually wrong about most of the seventeen. `mark_attendance` writes the billing line, `cancel_session` credits and tells the families, `end_coach` issues a final statement — each has a fine SQL sentence for the row it starts with, and the hand-written version does a fraction of the job silently. The test is not *is there SQL for this* (there nearly always is) but *is there an operation for this*. |
| ~20 operation signatures, again — this time the operations themselves | 17 Aug 2026 | Thirteen wrapper operations deleted (ARCHITECTURE.md layer 2). The tool surface went 36 declarations to 23 and the cached block lost 4,318 characters. Their knowledge did not go into the prefix: the invariants moved DOWN into triggers and constraints, and the consequences into `SCHEMA_DOC`, which is rung 2. If you are about to add a paragraph explaining what a write implies, that is where it goes. |
| *"Reach for the operation rather than raw INSERTs — create_class is the only thing that schedules the sessions"* | 17 Aug 2026 | An instruction standing in for a property, and half false besides: the planner materialised every class on every tick anyway. 0033 makes a `class_slot` imply its sessions by trigger, so the sentence is true without being said. **The general lesson: an instruction that describes a guarantee is a guarantee that does not exist.** |
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

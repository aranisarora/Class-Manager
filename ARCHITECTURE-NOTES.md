# Architecture Notes

Written 13 Aug 2026, from a walkthrough of the turn lifecycle at `6aedcea`.

`FINDINGS.md` records defects. This records **how the thing works, why it works that
way, what the industry calls each piece, and what the walkthrough turned up that
wasn't already written down**. Where the two overlap, FINDINGS is the authority on
severity; this is the authority on mechanism.

---

## 1. What a turn is

**One complete round trip: something arrives, a reply lands.** It is the unit the
whole system is built on.

Four things can start one: typed text, a voice note or photo, a button tap, or a
scheduled job firing. That last is why a scheduled task re-enters as an ordinary
turn — there is no separate "proactive" code path, and that is deliberate.

A turn is **stateless**. Nothing lives in memory between turns. Each one rebuilds
its own context from three separate sources:

| Source | What it carries | Where |
|---|---|---|
| `recentHistory` | last 16 message **bodies** | `loop.ts:933` |
| `recentLookups` | last 4 turns' `read` calls **and their raw results**, 6k budget | `loop.ts:962` |
| `hotSet` | ≤12 curated memory lines | `memory.ts:192` |

The second exists because §4.5 strips ids out of message text, so history alone
loses every id. Without it the observed behaviour was to **invent a uuid that
parses**. Its caption in the prompt — *"the only ids you may use"* — is load-bearing.

### Rounds

A **round** is one model call inside one turn. The model emits text; the runtime
executes. **The round boundary is an execution boundary, not a knowledge boundary** —
writing SQL *is* the model looking things up for itself; it simply cannot run what
it wrote without handing it back.

Measured over 37 turns: **2.62 rounds average** (`scripts/drive.ts:881`, `avg(rounds)`
over every turn row, unfiltered).

| Shape | Rounds | Share |
|---|---|---|
| Button tap | **0** — never touches the model | 5 of 37 |
| Normal question | **2** — look it up, then answer | majority |
| Real work | **3–6** | tail; worst was 6 |

Taps are counted as 0 and drag the mean down; conversational turns sit at ≈3.0.

Two mechanisms hold it there: the **early exit** (`loop.ts:743`) breaks as soon as the
person has been messaged *and* nothing is half-done — before it existed, every turn
paid a final round that returned `0 output tokens` for 16k prompt tokens — and a
**hard cap of 8** with repeat-call and repeat-reason circuit breakers.

For context, published benchmarks put frontier models at 6–8 rounds on comparable
multi-step tasks. 2.6 is good.

---

## 2. Why rounds cost what they do (caching does not make them free)

Caching is a 75% discount, not a zero. The arithmetic is in `gemini.ts:106`:

```
saved per call   0.75 × $0.30/1M × 27k ≈ $0.006
storage          $1.00/1M/hour × 27k   ≈ $0.027/hour
```

A cache pays for itself at ~4–5 calls/hour and **loses money below that**. Hence the
15-minute TTL and the burst rule: the first call of a cold window creates nothing,
because a second call arriving within 5 minutes is the evidence that traffic exists.

**The reason rounds are expensive is not the prefix. It is the part that can never
be cached:**

```
Round 1:  [prefix ✓] + [tail ✗] + [message ✗]
Round 2:  [prefix ✓] + [tail ✗] + [message ✗] + [round 1 call ✗] + [round 1 results ✗]
Round 3:  [prefix ✓] + [tail ✗] + [message ✗] + [all of the above ✗] + [round 2 ✗]
```

Tool results are new every round and are keyed to nothing, so the uncached portion
grows monotonically. A `read` returning 200 rows can add more uncached tokens in one
round than the whole cached prefix costs. The measured 81% cache rate is an average
across a turn; a 6-round turn is far worse than a 1-round turn, which is why 6 rounds
costs 128k against 19k.

> Independent confirmation: Elastic's production write-up on agent optimisation reaches
> the same conclusion — *"the dominant cost driver isn't the length of the system prompt,
> it's the number of LLM calls."* `recipes.ts:174` derived this from the turn table.

---

## 3. The layered prompt

**Stable prefix** (~13k tokens, byte-identical for every person in every business):
doctrine, schema, 11 behaviour modules, operation framing, catalog digest.

**Variable tail** (never cached): who this is, ids for SQL, the business, the census,
memory hot sets, the clock, the synthesis mix, recent lookups, the task.

The discipline — *"no dates, no ids, no per-academy anything above the boundary"* — is
the standard **"static-first, dynamic-last"** rule from every provider's caching docs.
Media always rides in the tail (`loop.ts:537`) so an image can never poison the prefix.

The **census** (`context.ts:273`) is the piece worth understanding: a live count of what
exists, run **under the asking person's own RLS**, so a coach's census is their classes
and a parent's is their children. Counts, not instructions — what to do about an empty
roster is a behaviour module, which is a file rather than a branch.

---

## 4. How memory is stored

Two tables, deliberately not collapsed (`memory.ts:1`):

| | `memory_fact` | `academy.memory` / `person.memory` |
|---|---|---|
| Role | **the record** | a bounded hot set (a cache) |
| Writes | append-only; never edited, never deleted | overwritten wholesale by a job |
| Corrections | a **superseding row**; the old one stays | n/a |
| Bound | unbounded (500-row read cap) | **12 lines / 1400 chars** ≈ 400 tokens |
| Read by | `searchFacts` — trigram Dice + term overlap + recency | pasted into the tail every turn |
| Rebuilt | never | `curate`, a model call, at each multiple of 12 live facts |

> *"Collapsing them into one capped text blob is how a memory system becomes an amnesia
> system: the pruning decision then gets made by a model under context pressure, and what
> it drops is invisible."*

**Forgetting is a context decision, never a storage decision.** Curation is scheduled,
not per-turn, because per-turn would roughly double the model calls in the product.

---

## 5. Should a turn have a session object?

**It has one — the database.** The only ephemeral state is `pendingPlans` /
`pendingMeta` (`loop.ts:490`), and those do not get lost when the turn ends; they get
**moved into the button**, serialised as an `action` row.

That beats a session object on three counts:

- **addressable** — two pending plans can coexist, each tappable
- **self-expiring** — 24h TTL, rather than going stale invisibly
- **claimable exactly once** — the conditional UPDATE that makes two coaches racing
  for one session resolve correctly

A `conversation_state` blob would have to reinvent all three and would arbitrate
nothing. The narrow case where a session object *would* help is a within-turn
scratchpad, and `recentLookups` mostly covers it.

**But statelessness does have one real cost**, and it is the recipe bug in §8: the
round count is earned in turn 1 and the commit happens in turn 2, and nothing carries
the number across. The fix is not a session object — it is putting the round count in
the action payload, where the rest of the state already travels.

---

## 6. Operations: what they actually are

**Constructors, not gates.** `build(ctx, args, id) => Promise<PlanStep[]>`. An operation
never writes; it emits steps that go through the identical `executePlan` an improvised
plan goes through — same transaction, same diff, same audit entry, same staged messages.

The **lego bricks are one level down** — the six `PlanStep` kinds (`plan.ts:83`):
`write` · `operation` · `adjust` · `message` · `schedule` · `note`.
`operation` being a step kind is what makes the system compositional: three classes at
once is one plan with three `create_class` steps, one transaction, one confirmation.

The model can already write raw SQL through `plan`. RLS is the boundary, not the
operation list. So operations buy exactly three things:

1. **Consequences absent from the schema.** Nothing in the database says `create_class`
   must enqueue `materialize_sessions`. It is a fact about the system, not the data.
2. **Argument names as a decoding constraint.** Each operation's zod schema is projected
   into the JSON Schema Gemini constrains decoding against *while generating*. The names
   used to be prose in the prefix — *"tens of thousands of characters upstream of the
   decode point, in the one form the decoder cannot apply."*
3. **Privilege the model cannot spell.** A step may carry `service: true`, reaching `job`,
   `audit_entry`, `memory_fact`, `recipe` — tables with no user policy. `PlanStepSchema`
   **silently strips that flag from any model-authored plan** (`plan.ts:66`). This is why
   a coach marking attendance produces a billing line: the coach did not write it, the
   system did, on their behalf, in the same transaction.

### Why 26, and not more

There was a hard ceiling — `MAX_TOOL_DECLS`, formerly **10**, now 128; past the real
ceiling every turn returns `MALFORMED_FUNCTION_CALL` with no candidate. Beyond that, the
count is a design choice: an operation per case is the *gate* design that §14.2.1
rejects.

**The test for whether something deserves an operation:** does doing it in raw SQL produce
a world that looks correct in every table and is silently broken?

- `create_class` → **yes.** Classes, slots, zero sessions.
- `mark_attendance` → **yes.** Attendance with no billing line.
- `end_coach` → **yes.** Future sessions still assigned to them.
- rename a venue → **no.** An `UPDATE` is complete. There is no operation, correctly.

### `create_class` is not complex — it is load-bearing

~50 lines: insert the class, loop the slots, loop the coaches, enqueue a job. The entire
weight is on the last step. Observed when a model was pushed onto raw `insert into class`:

> *3 classes, 6 slots, **0 sessions**, and an admin told "I've set up your three classes
> with their weekly timings."*

Every table correct. Nothing would ever happen. Nobody finds out until a Tuesday evening
with no reminder. **That class of failure — invisible incompleteness — is what operations
exist to prevent.**

---

## 7. Prior art: what is standard, what is not, what is unsolved

Researched 13 Aug 2026. Summary: **no component here is novel; the assembly is not
downloadable; one piece is an open research problem.**

### Standard, and done correctly

| Piece here | Industry name | Verdict |
|---|---|---|
| prefix/tail cache split | "static-first, dynamic-last" | textbook; in every provider's docs |
| tool round loop | ReAct (2022) | standard; 8-round cap is tighter than typical |
| minted action rows behind buttons | postback payloads (Messenger / Slack / WhatsApp `button_reply`) | standard for a decade |
| idempotency keys | Stripe's pattern | standard |
| plan → read-back → tap → commit | LangGraph `interrupt()` | LangChain calls approving tool calls before execution *"the most critical pattern"* |
| the compose chokepoint | **output rails** (NeMo Guardrails) | standard shape |
| read-only SQL + named write operations | semantic layer over raw SQL | the recommended architecture, incl. *deterministic* validation rather than a second LLM |

### Known in research, rare in production

- **Reflection after the turn** — Park et al., *Generative Agents* (2023): memory stream
  plus periodic synthesis into higher-level insight. Your `reflect()` is a direct
  descendant. Most production bots skip this entirely.
- **Hot set vs. archival store** — the MemGPT/Letta split. You have it.
- **Freezing successful work as reusable procedure** — **Voyager** (2023) keeps an
  *"ever-growing skill library of executable code"*, retrieved by embedding similarity;
  **Agent Workflow Memory** (ICML 2025) induces reusable workflows online with no
  supervision. Your `recipes.ts` is this idea.
  - Where you differ, and better: capture is triggered by **cost** (≥3 rounds), which
    neither paper does.
  - Where you differ, and worse: matching is **token overlap** where Voyager uses
    embeddings.

### Not solved by anyone

**Amber mark 2 — nothing checks whether a stated number came from a row.** The research
name is **faithfulness hallucination** (output contradicting its own source, distinct
from factuality). It is framed as a *traceability* problem and is an active 2026 research
area. Known failure modes match yours exactly: models misread a correct source, merge
conflicting evidence, or fail to say the data does not answer the question.

`lint.ts:16` — *"NUMBER-GROUNDING IS DELIBERATELY NOT HERE, and must not be added"* —
argues no string operation can distinguish "14 enrollments" from a date, a price or a
phone number, so any regex implementation either false-positives on ordinary English or
provides false assurance. **That reasoning matches the research consensus.** A lint rule
here would be worse than nothing.

The tractable version is **provenance-exact checking**: hand a verifier the *same rows
the generation saw* and ask whether each number appears in them. You are well placed —
`ctx.executed[].wrote` and the `read` results are already captured per turn.

**Sources:** [Voyager](https://arxiv.org/abs/2305.16291) ·
[Agent Workflow Memory](https://proceedings.mlr.press/v267/wang25bx.html) ·
[Generative Agents](https://3dvar.com/Park2023Generative.pdf) ·
[LangGraph interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts) ·
[NeMo output rails](https://docs.nvidia.com/nemo/guardrails/latest/getting-started/5-output-rails/README.html) ·
[Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) ·
[SQL agent safety layer](https://timdietrich.me/blog/sql-agent-safety-architecture/) ·
[Retromorphic testing for RAG](https://arxiv.org/pdf/2603.27752) ·
[Elastic: agent optimisation at scale](https://www.elastic.co/security-labs/ai-agent-optimization-production-scale)

---

## 8. New findings from this walkthrough

Not in FINDINGS.md as of `6aedcea`. Ordered by consequence.

### N1 · The recipe system cannot fire on the path it was built for

`recipe` has been 0 rows after 8 committed plans. FINDINGS L214 says *"nobody has
established whether the threshold is wrong or the call site is."* **It is the call site.**

In `runTurn`, `committedPlans` is populated **only** from the model branch
(`loop.ts:146`). The tap branch calls `executeAction` → `executePlan` directly
(`loop.ts:310`) and never touches it. A tap turn also has `rounds = 0`, because `rounds`
is assigned only inside `modelTurn`.

```js
if (!error && committedPlans.length)   // always empty on a tap
  captureIfExpensive({ rounds, … })     // and rounds is 0 anyway
```

**The plan → read-back → tap → commit path is the product's main commit path, and it is
exactly the path that cannot be captured.** Both conditions fail on it.

The two are inverted by design: **the rounds are spent in turn 1, the commit happens in
turn 2, and the check only ever sees turn 2.** The only eligible plans are those the model
committed inline without confirmation — which `needsPreview` defines as the small, cheap,
low-risk ones. The threshold selects for expensive; the wiring selects for cheap; the
intersection is empty.

**Fix:** carry the originating turn's round count in the `{kind:'steps'}` action payload
at mint time, and have the tap path push to `committedPlans`. Both numbers are in scope
at the mint site.

### N2 · `applyRecipe` has zero callers

Traced across `lib`, `app`, `scripts`:

| Function | Callers |
|---|---|
| `captureIfExpensive` | `loop.ts:157` ✓ |
| `matchRecipe` | `loop.ts:521` ✓ |
| **`applyRecipe`** | **none — dead code** |

The live path is not execution. `matchRecipe` pastes the plan into the variable tail as
prose, sliced to 1200 chars, with *"use it if it fits."* **The model never runs a recipe;
it reads one and re-composes.** Consequences:

- the `{{placeholder}}` generalisation is currently **decorative** — nothing binds them
- the claimed round saving is not structural; it is a hope that the model copies well
- `.slice(0, 1200)` will cut a multi-step plan **mid-JSON**, showing the model malformed
  JSON as its worked example

### N3 · Sibling buttons are never invalidated

`action` has no `message_id`. Every button on a message is an independent row, live for
its own TTL. So: tap **[Do it]**, the plan commits — then tap **[Cancel]** on the same
message and it fires a separate `noop` replying **"Left as it was — nothing changed."**
A false statement about work that did happen.

**Fix:** add `message_id` to `action`; on a successful consume, expire the siblings in the
same transaction as the claim.

### N4 · `missing` and `wrong_contact` share a reply

At `loop.ts:110`, both fall to the same `else` and produce *"That button isn't yours to
tap."* A person whose payload was corrupted, or whose action row was never written, is
told the button belongs to someone else. Accusatory and wrong.

### N5 · "Good" means "expensive and it didn't crash"

The capture gate checks: schema-valid, previewed, executed `ok`, no turn error, ≥3 rounds,
committed. It does **not** check that anyone was glad.

The Saturday-class-starting-Sunday bug **executed cleanly**. Had that turn taken three
rounds it would have been frozen as the canonical `create_class` recipe — and
`on conflict do update` would keep re-freezing it. The mechanism designed to prevent
divergence would have preserved a defect permanently.

**Both feedback signals already exist in the database and are unused:**

- **positive** — `action.consumed_at` on the `[Do it]` button: a human read the plan and
  tapped yes
- **negative** — a correction in the next turn or two

`recipe.active` already exists, so the state machine is nearly free:

```
captured → provisional   (stored, never offered)
           ↓ used cleanly N times with no correction
           active        (offered in the tail)
           ↓ a correction follows within 2 turns
           demoted       (active = false)
```

### N6 · The `create_class` weekday bug is visible in ten lines

`operations.ts:1880` computes `startsOn`. `operations.ts:1892` loops the slots inserting
weekdays. **Nothing between them compares the two.** A Saturday-only class starting on a
Sunday date inserts happily and skips its first week. Fix: derive the first valid date
from the slot weekdays rather than trusting the argument. (Same defect as FINDINGS F6;
recorded here with the exact mechanism.)

---

## 9. Optimisation ranked by leverage

### 1. Widen the census — the highest-leverage change available

The census already prefetches counts into the tail. A client's currently gives player
count, enrolment count, and a raw `next_at` timestamp — so *"what time is his class?"*,
the single most common question in the product, **still costs a round**, because the model
has a time but no class name and no confidence the tail is complete.

Fetch the next 3 sessions with class name, start and end time (and for a coach, today's
register state). **The most common turn goes from 2 rounds to 1.**

Arithmetic: ~500–1000 extra uncached tail tokens against saving a whole round at ~17k.
No new architecture; `census()` is already the right place.

### 2. Tell the model it can read in parallel

The loop already executes multiple `functionCalls` per round (`loop.ts:643`), but nothing
in the prompt says so. One sentence — *"if you need several things, ask for them in the
same round"* — collapses a 4-round discovery chain into 2. Free.

### 3. Wire the recipe loop end to end

N1 + N2 + N5 together. Once wired: a matched recipe is **1 round** (the model supplies
bindings; the runtime binds, previews, executes, and the captured `message` steps carry
the copy — so the model does not write the reply either), or **0 rounds** behind a button.

> *"everything else is kept verbatim, including the copy, which is half of why capturing
> beats rewriting."* — `recipes.ts:59`

### 4. Upgrade recipe matching to embeddings

Token overlap with a ≥0.34 threshold is the crudest possible matcher. Voyager indexes
skills by embedding of the description. This is the difference between recipes firing
sometimes and firing reliably.

### 5. Typing indicators

WhatsApp cannot stream, so unlike ChatGPT your 17s latency is **fully exposed** — every
optimisation they get from perception you must get from real speed. A typing indicator is
the one perceptual lever the surface offers.

### Floor

**1 round** for anything answerable from prefetched data. **2 rounds** for anything
genuinely unpredictable — the model must *see* data before writing a sentence about it.
Below 2 is not reachable by any architecture.

---

## 10. The through-line

Three ideas hold this together, and each is a different kind of decision.

**The prefix/tail split is an economics decision.** Byte-identity above the boundary is
what makes caching work, and everything time- or tenant-shaped is pushed below it.

**The tap path is a trust decision.** No model at the moment a misread commits someone to
being somewhere. This is the product's best idea and the least common in the wild — most
systems re-infer on button press.

**The compose chokepoint is a guarantee decision.** One place, because a guarantee that
depends on which path the model happened to take is not a guarantee.

And the send gates are an **auditability** decision: every silence is a row, because a
suppression nobody can see is indistinguishable from a bug.

**Where the defects cluster is not an accident.** Everything upstream of compose is
guarded structurally and holds. The failures are in the last six inches, and in the
*wiring* between correctly-built components — the recipe loop being the clearest case:
capture, generalise and apply are all written, all correct, and not connected to each
other.

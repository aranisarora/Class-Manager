# Anatomy — the order the brain runs in

<!-- Kept honest by `npm run check:anatomy`. Every symbol in a table must exist in the file
     beside it, and the send ladder must still be in the order given. -->

Three documents, three questions. This is the third.

| Question | Document |
| --- | --- |
| Where does a thing belong? | [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the layers |
| Does something already handle this? | [`MECHANISMS.md`](./MECHANISMS.md) — the index |
| **When does it run, and what has already happened by then?** | **this file** |

**To read what is actually sent to the model:** `npm run surface` — the stable prefix and the
tool declarations, assembled, in one greppable file. `npx tsx scripts/probe-prefix.ts --text` is
the prefix alone. Both call the same `stablePrefix()` the runtime calls at stage 2 below, so what
prints is what is sent — not a reconstruction of it.

## Why this exists

`MECHANISMS.md` is an inventory. It tells you `proseViolations` exists; it cannot tell you it
runs *after* the model has written a message and *before* that message is sent — and that is
the fact which decides whether your fix belongs there. An inventory has no time in it.

Two things follow, and the repo has recorded both.

**Order is its own defect class.** The recovery ladder once had two correct mechanisms in the
wrong sequence: the apology filled the trailing text before the toolless recovery round could
run, so the round with five rounds of results to salvage was skipped on exactly the turns with
the most to save. Nothing was missing; the order was wrong. Reflection was the same shape — tool
declarations serialise *above* the messages, so a round that filtered its tool list broke the
prefix cache behind it and re-billed the whole conversation at full price. Neither bug is
visible in a list of parts.

**A mechanism you found in the index still lands in the wrong stage.** Knowing a thing exists is
not knowing when it is too late for it. The commonest wrong answer in this repo is a line of
prompt doctrine aimed at a defect whose stage runs long after the prompt is finished — which is
what the house rule *behaviour is not fixed by prompting* is actually about.

The brain does not fit in a context window; `lib/agent` alone is ~209k tokens. This is the
sequence, so it does not have to be re-derived from the source every time.

---

## The map

```
inbound (Meta webhook · emulator · job)
 └ resolveInbound → resolveIdentity            no identity → not our turn
    │                └ no business owns this number? → the front desk (0039)
    └ runTurn
       0 the desk    a `visitor` runs runFrontDeskTurn instead of the tenant loop:
                     its own stable prefix, five verbs, and it ends by handing over
       1 arrival     consumeAction → executeAction (the WRITE runs before any model)
                     …and then falls through to 2, so the model composes the receipt
                     mediaRefusal (the runtime speaks, not the prompt)
       2 context     now → recentToolTurns → variableTail → tapBlock → recentHistory
                     → stablePrefix
       3 rounds      generate → runTool → turnState → exit test
                      ├ a write → checkSteps → [tx: audit → steps → diff → guards] → commit
                      └ a send  → composeAndSend → validateOutbound → the send ladder
       4 exits       spoke? → recovery round → apology ladder → trailing prose
       5 reflection  the last round: remember / schedule
       6 record      writeTurn — always, whatever happened
       7 handover     a front-desk turn that chose a business re-enters runTurn there,
                      with the same text — two turn rows, in two academies
```

---

## 1 · Arrival

| What happens | Where |
| --- | --- |
| A shared number routes to a person by answering only what rows can answer — *does this number already belong to a business?* | `resolveInbound` · `lib/identity.ts` |
| It belongs to none: the person is a `visitor` at the front desk of the number they messaged, with a person, a contact and a transcript | `frontDeskContact` · `lib/identity.ts` · `app.front_desk_contact` · `0039` |
| The arrival is recorded **before** anything is asked, so a stranger who writes once and never answers is a row rather than an absence | `openArrival` · `lib/frontdesk/arrival.ts` |
| One contact resolves to a person and to **all** of their roles at once | `resolveIdentity` · `lib/identity.ts` |
| A tap claims its button in one conditional UPDATE, then runs the stored payload — **no model call before the write**, and `origin` records that | `consumeAction` · `lib/actions.ts` · `executeAction` · `lib/agent/loop.ts` |
| …and then hands the plan's result to the turn, which composes what the person reads. The write is a tap; the sentence is a turn | `TapNarration` · `committedResult` · `tapBlock` · `seedFromCommitted` |
| A tap that has already answered this person — its plan staged their message at compose time — and has nothing left needing a judgement stops here, at the cost it always had | `nothingLeftToSay` · `lib/agent/loop.ts` |
| A button whose payload was a reply re-enters as if it had been typed | `executeAction` · `lib/agent/loop.ts` |
| An image, voice note or file is answered in words by the runtime; anything typed alongside still goes to the model | `mediaRefusal` · `lib/agent/loop.ts` |
| A shared contact card takes the opposite path — it is data, so it is rendered into the turn's own text and read by the model | `bodyWithSharedContacts` · `lib/messaging/contact-card.ts` |

A turn carrying text, a task, **or a tap the model still owes an account of** reaches stage 2.
**A card is text by the time this test runs**, which is the whole of why it reaches the model
and a photo does not — and it is also why order matters here: fold the card in *after* the test
and a bare contact share falls through to "that came through as something I can't read".

**Where the tap's two halves split, and why it is here rather than anywhere else.** §2.2 —
*no model inference at tap time* — is about the DECISION, and the decision is made above this
line: the payload was authored at compose time, validated then, and executes verbatim now. A
misread still cannot commit anyone to being anywhere. What used to happen below it was a
second thing wearing the same name: the runtime also *composed the message*, from row counts
and a business snapshot taken before the transaction, and sent it. That is what F-CD cost —
one message announcing a write and denying it in the same breath. `noop`, `menu` and
`handoff` do not go on to stage 2, and the test for that is on `executeAction`: the runtime
may **replay what the model wrote**; it may not **author what the person reads**.

## 1a · The front desk — and why it forks here rather than later

A `visitor` never reaches stage 2. `runTurn` branches immediately after arrival into
`runFrontDeskTurn`, and everything below — the census, `SCHEMA_DOC`, the operations, the
catalog, the five tool rounds, reflection — is about a business this person does not have.

**The stage is the point.** A fork one stage later would already have paid for the tenant
context before discovering there is no tenant, which is the commonest wrong answer this
document exists to prevent: a mechanism that is right in the abstract, landed where it is
already too late. It also could not have been a filter *inside* the tenant loop, because
the tool block serialises above the messages — a narrowed list edits the cached prefix and
re-bills the whole conversation (stage 3, and `verify:static`'s fifth absolute).

| Order | What | Where |
| --- | --- | --- |
| 1 | A second stable prefix — byte-identical for every stranger on every number, ~2% the size of the tenant one | `FRONT_DESK_PREFIX` · `lib/frontdesk/context.ts` |
| 2 | The tail: whether the question has already been on their screen, and whether their own words name a business | `frontDeskTail` · `lib/frontdesk/context.ts` |
| 3 | Five verbs, and no sixth at any privilege: `reply`, `find_business`, `join_business`, `start_business`, `stop_messaging` | `frontDeskToolDecls` · `lib/frontdesk/tools.ts` |
| 4 | Up to three rounds over them. A round that calls nothing is the desk speaking, exactly as in stage 3 | `runFrontDeskTurn` · `lib/frontdesk/turn.ts` |
| 5 | The name matcher is evidence now, not a routing decision — it decides nothing on its own | `matchAcademiesByName` · `lib/identity.ts` |
| 6 | A destination: a prospect contact in an existing business, or a business that did not exist a second ago | `joinBusiness` · `foundBusiness` · `lib/frontdesk/route.ts` |
| 7 | The words that brought them here are written into that business as the first row of its thread | `carryOpeningMessage` · `lib/frontdesk/route.ts` |

**A hand-over ends the desk's turn immediately** — before it can add a parting sentence,
because the business is about to answer the same message from inside itself, and two
answers to one question is what that shape produces if nothing stops it.

The turn row is written by `writeTurn` at stage 6 like every other, and only then does the
hand-over run (stage 7). The desk owns no recorder of its own.

## 2 · Context

Assembled in this order, all of it before the first round.

| Order | What | Where |
| --- | --- | --- |
| 1 | The **tenant's** clock, awaited first — everything below is stamped against it | `now` · `lib/clock.ts` |
| 2 | One read of recent turns, two filters over it: what was looked up, and what was done | `recentToolTurns` · `lib/agent/loop.ts` |
| 3 | The tail — who this is, the hot memory sets, what exists, and the standing states | `variableTail` · `census` · `standing` · `lib/agent/context.ts` · `hotSet` · `lib/agent/memory.ts` |
| 4 | On a tap: what the button already ran, and its result in `act`'s own shape. The tool context is seeded to match, so `turnState` agrees with it from round one | `tapBlock` · `lib/agent/loop.ts` · `seedFromCommitted` · `lib/agent/tools.ts` |
| 5 | The conversation so far, with gaps noted beside the messages rather than among them | `recentHistory` · `lib/agent/loop.ts` |
| 6 | The cached half — preamble, schema, operations, catalog, platform, doctrine | `stablePrefix` · `SCHEMA_DOC` · `lib/agent/context.ts` · `lib/agent/schema-doc.ts` |

A prefetch that **fails** is not an absent block: it renders as a stated gap carrying its
reason, because a paragraph that was never there is invisible to everything downstream.
`fromRead` · `unread` · `lib/agent/context.ts`

## 3 · The rounds

One loop, `MAX_TOOL_ROUNDS` of it. `lib/agent/loop.ts`

| Order | What | Where |
| --- | --- | --- |
| 1 | Generate with the full tool block every round — the declarations are part of the cached prefix | `generate` · `lib/agent/deepseek.ts` · `toolDecls` · `lib/agent/tools.ts` |
| 2 | Prose beside tool calls is a notebook, not a reply. Only a round that calls nothing is speaking | `lib/agent/loop.ts` |
| 3 | Arguments that did not parse are recorded and answered, never executed | `parseError` · `lib/agent/deepseek.ts` |
| 4 | A byte-identical repeat of a call that already failed is blocked before the tool sees it | `failedCalls` · `lib/agent/loop.ts` |
| 5 | The same *refusal* twice says so in the result; three times stalls the turn out of the loop | `failedReasons` · `stalled` · `lib/agent/loop.ts` |
| 6 | Every round ends with the runtime stating the turn's own facts — rounds used, and what has actually happened | `turnState` · `lib/agent/tools.ts` |

**Exit tests, in order:** no tool calls → done · `stalled` → out to the ladder · the asker has
been replied to *and* no plan is waiting to be committed → done.

An operation called by its own name is rewritten to `act` before the switch, so the tool path,
the button path and the plan path cannot disagree about what an operation is.
`runTool` · `lib/agent/tools.ts`

**A read:** `assertSingleReadStatement` (one statement, no host clock) → `modelQuery` under
**this person's** RLS → a scope line → rows clipped to `MODEL_ROWS_SHOWN` with the true row count
beside them. Zero rows under a scoped session are marked ambiguous: empty and withheld look
identical from there. `lib/agent/tools.ts` · `lib/db.ts`

## Sub-pipeline A — a write

Every write, from every route, runs this. `lib/agent/plan.ts`

| Order | What | Where |
| --- | --- | --- |
| 1 | Steps validated at mint against the thing that will run them; human assertions stripped | `checkSteps` · `stripHumanAssertions` · `lib/agent/steps.ts` |
| 2 | Every id-shaped argument read back **before** the transaction opens | `assertIdsExist` · `lib/agent/plan.ts` |
| 3 | Operations expanded into steps | `expand` · `lib/agent/plan.ts` |
| 4 | *In the transaction:* audit opened → steps run → diff read from the trigger's before/after images | `beginAudit` · `lib/audit.ts` · `runSteps` · `readDiffSafe` · `lib/agent/plan.ts` |
| 5 | *Still in it:* guards ask the database what the world **became** — collisions, and whose life this changed without telling them | `noteClashes` · `noteUntold` · `lib/agent/plan.ts` · `coachClashes` · `lib/agent/clash.ts` · `untoldAudience` · `lib/agent/untold.ts` |
| 6 | A plan carrying writes whose diff is empty aborts instead of committing | `assertSomethingChanged` · `lib/agent/plan.ts` |
| 7 | Consequence — money, other people, destruction, collisions — decides preview or commit, from the plan's **own result** | `needsPreview` · `lib/agent/plan.ts` |
| 8 | Commit. Only now: one message per recipient, then the wire, then the audit row and the receipt | `mergePerRecipient` · `flushOutbox` · `recordAudit` · `buildSummary` · `lib/agent/plan.ts` |

A refusal re-runs itself as the service role, rolled back, to tell a permission denial apart
from a WHERE that matched nothing — and escalates to the admins in business language, never the
SQL. `hintFor` · `escalateRefusal` · `lib/agent/plan.ts`

A preview does all of the above inside a rollback, so what the person confirms against is
measured rather than estimated. `previewPlan` · `withRollback` · `lib/agent/plan.ts`

## Sub-pipeline B — a send

`composeAndSend` validates the message it *would* have produced before anything is written; then
`send` is the one path to the wire. `lib/messaging/compose.ts` · `lib/messaging/send.ts`

The gates, in the order they run. Each returns a `message` row carrying its reason, because a
suppression is a fact, not a failure:

| | Gate | Why it is here |
| --- | --- | --- |
| 1 | `no_contact` | there is nobody to send to |
| 2 | `opted_out` | stopping outranks everything below it |
| 3 | `muted` | "stop messaging me about money" is a scope, read from `MUTE_SCOPE` |
| 4 | `quiet_hours` | not for admins, not for anything solicited |
| 5 | `self_confirmation` | nobody confirms something to themselves |
| 6 | `escalation_about_self` | an escalation about you does not arrive at your phone |
| 7 | `pre_launch` | an academy that is not live does not message its roster |
| 8 | `repeat` | a standing message reports a state once — keyed on the state (`stateKey`), then on the body |
| 9 | `limit_violation` | every way the real wire would reject it, enumerated by `validateOutbound` |
| 10 | `recipient_frequency_cap` · `tenant_send_cap` | volume, per person and per tenant |
| 11 | `out_of_window_no_template` | outside 24 hours it is a frozen template or nothing |
| 12 | `duplicate_idempotency` | this exact message has already been sent |

Past the ladder the row is written, the buttons are stamped into a family that dies together, a
question that was asked becomes `pending_request` state, and only then does the transport run.
`insertMessage` · `attachActionsToMessage` · `committingButton` · `lib/messaging/send.ts`

## 4 · The exits

Reached when the loop is over. Here the order **is** the mechanism.

| Order | What | Where |
| --- | --- | --- |
| 1 | Did anything reach the **asker's** phone — not "did the model call reply", not "did something leave the building" | `spoke` · `lib/agent/loop.ts` |
| 2 | If nothing did: one toolless round, history flattened, to put what the turn already learned into words | `flattenToolTurns` · `lib/agent/loop.ts` |
| 3 | Only if that failed too: one of **four** sentences, picked by what actually happened — and none at all if the runtime already said something true | `lib/agent/loop.ts` |
| 3a | The fourth outranks the other three and is the tap's: all three of them say some version of *nothing came of it*, and after a committed write every one is false. The `backstop` on `TapNarration` — the receipt this path stopped sending — is what goes out instead | `TapNarration` · `runtimeAuthored` · `lib/agent/loop.ts` |
| 4 | On a job turn, trailing prose is discarded and traced: a reply is how a job speaks | `lib/agent/loop.ts` |
| 5 | Trailing prose gets the confirmation button minted by the runtime, since only it holds the validated steps | `pendingConfirmation` · `lib/agent/tools.ts` |
| 6 | The message is **validated, not edited**. A violation buys one repair round; a second failure sends the draft as written — and the ladder's own copy is exempt, because a repair round asks the MODEL to rewrite a draft this file wrote | `proseViolations` · `lib/agent/lint.ts` |
| 7 | Every figure in what was said is compared against what this turn's tools returned — recorded, gating nothing | `traceabilityNote` · `lib/agent/traceability.ts` |

## 5 · Reflection

The turn's **last round**, not a second call — so it sees the schema, its own trace and its own
reasoning, and shares the cache with everything before it. Two questions: is there a fact worth
carrying, and is there something to come back to. "Neither" is the common answer. Only
`remember` and `schedule` run; anything else is dropped and traced.
`REFLECT_TOOLS` · `isReflectTool` · `lib/agent/loop.ts`

## 6 · Record

`writeTurn` runs outside the error path — a turn that threw is still a turn that is recorded.
The flight recorder carries the model's own rounds and reasoning beside the tool calls; with
`PROBE_FULL_TRACE` it carries what the model was **told** as well, because the failures worth
finding are mostly absences. `writeTurn` · `ToolTrace` · `lib/agent/loop.ts` ·
`captureFullTrace` · `lib/agent/turn-trace.ts`

---

## The standing surface

Everything above happens because a person typed. Most of the product happens because time
passed.

```
tick (Vercel Cron · pg_cron)   app/api/cron/tick/route.ts
 └ planAhead      what should exist by now — idempotent on a dedupe key
 └ runDueJobs     claim a batch under a lock → handler → done | skipped | failed
    └ a handler that speaks to a person opens an ORDINARY turn: same prefix, same
      tools, same flight recorder (runSynthesis · lib/jobs/handlers/admin.ts)
 └ reportMissed   every run ends by reporting what did NOT run
```

| Rule | Where |
| --- | --- |
| A job is due against the clock of its **own** tenant | `runDueJobs` · `lib/jobs/runner.ts` |
| A watch the model minted needs a parseable expiry, an instruction and an academy before it reaches the queue | `guardAgentTask` · `lib/jobs/enqueue.ts` |
| A newer watch on the same `subject_key` supersedes the older one — restating is safe, duplicating is impossible | `lib/jobs/enqueue.ts` |
| A handler whose precondition no longer holds throws `JobSkip` and is recorded as skipped, not failed | `JobSkip` · `lib/jobs/runner.ts` |
| A send time landing in quiet hours is **moved at plan time**, not dropped at send time | `pullOutOfQuietHours` · `lib/jobs/plan-ahead.ts` |

---

## What the order encodes

Eleven facts that are only true because of *when* something runs.

1. **The clock is read first.** Every replayed lookup is stamped against it; an unstamped past reads as the present, and the model will argue itself out of a correct doubt with it.
2. **A failed prefetch is a stated gap, never an empty block.** The model repairs what it is told about and mis-narrates what it is not.
3. **The prefix is byte-identical and comes first.** Anything per-tenant or per-turn is data in the tail. Tool declarations serialise above the messages, so they are part of the cached half — filtering them per round costs more than sending them.
4. **Guards run inside the transaction, after the steps, before commit.** That is the only place the question has one answer, and the only place that covers routes nobody has written yet.
5. **Nothing reaches the wire before commit.** Steps stage messages; the outbox flushes after the transaction returns.
6. **Consequence decides the preview, from the plan's own result** — not from who composed it, so raw SQL and a named operation are judged the same way.
7. **Answer before apologising.** The toolless recovery round runs first, the apology only if that fails too. Reversed, the cheap bad answer wins every expensive turn.
8. **Validation refuses; it never rewrites.** A refusal buys one round of grace, which is the same deal the reply tool gives.
9. **Reflection is the last round, not a second call.** A separate call has no schema, no tools and no trace — it invents table names and cannot be corrected.
10. **The turn is recorded whatever happened.** The record is written outside the error path, because the turns worth reading are the ones that went wrong.
11. **A tap writes before the model and speaks after it.** Those are two different acts and they were fused for the product's whole life — so the one route where a write is *certain* was also the one route where the sentence about it was assembled from row counts, by something that could not read the rows back. Reversed or fused, you get F-CD either way: fuse them and the receipt is composed before the transaction it describes; reverse them and a model gets to edit a payload a person already approved.

## Where a fix goes

| The symptom | The stage that owns it | Not |
| --- | --- | --- |
| It did not know something | 2 · context | a line in the prefix |
| It knew, and said it wrong | 4 · validation refuses and buys a round | an edit on the way out |
| It changed something and nobody was told | A · the untold census note | a paragraph of doctrine |
| It sent something it should not have | B · a gate on the ladder | the composer |
| It went round in circles | 3 · `failedReasons`, `stalled` | a longer prompt |
| It said nothing at all | 4 · the recovery ladder | |
| It said "done" about work that did not happen | 3 · `turnState`, every round | a claims regex on the way out |
| A receipt reads like a database | 1 → 2 · the tap carries an account and the turn composes | a better sentence in `buildSummary` |
| A state cannot be reported at all | layer 0 — it is a row | a memory fact |

`MECHANISMS.md` then tells you whether the thing you are about to build is already there.

## How this stays true

`npm run check:anatomy` fails the build when a symbol named in a table above is not in the file
beside it, when a path named here does not exist, or when the send ladder is no longer in this
order. A document that claims something about reality gets a program that checks the claim —
the same deal `check-schema-doc`, `check-rls-doc` and `check-layout` make.

It does **not** check the prose. If you change the order of something, the sentence explaining
why is yours to update; the check only guarantees you cannot forget this file exists.

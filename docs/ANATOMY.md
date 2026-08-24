# Anatomy — the order the brain runs in

<!-- Kept honest by `npm run check:anatomy`. Every symbol in a table must exist in the file
     beside it (whole-word, so a word inside a comment cannot vouch for a tool that is gone),
     the send ladder must still be in the order given, and the stage headings must survive.
     The check does NOT read the prose: if you change WHEN something runs, updating the
     sentence that explains it is yours to do, in the same change. -->

Three documents, three questions. This is the third.

| Question | Document |
| --- | --- |
| Where does a thing belong? | [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the layers |
| Does something already handle this? | [`MECHANISMS.md`](./MECHANISMS.md) — the index |
| **When does it run, and what has already happened by then?** | **this file** |

**To read what is actually sent to the model:** `npm run surface` — assembled by the same
`stablePrefix()` the runtime calls at stage 2 below. [`PREFIX-RULES.md`](./PREFIX-RULES.md)
is the method.

## The short version

The whole product is one loop, run once per message. In plain words:

1. **A message arrives** — from Meta's webhook, or the emulator. The runtime works out who
   sent it and which business the conversation belongs to. A stranger on the shared number
   lands at that number's **front desk**, which is the same brain in a different mode, whose
   whole job is to ask "classes, or do you run them?" and hand the person over. The inbound
   is written to the database **before** anything else runs, so a webhook retry or a crash
   cannot lose it or answer it twice.
2. **If they tapped a button**, the payload stored behind that button runs *before any model
   is called* — a tap is consent to something already validated, and no model may reinterpret
   it. The model is then told what the tap did and composes the sentence about it.
3. **The turn's context is assembled**: a large instruction block that never changes (and is
   therefore cached by the provider at ~3% of full price), then everything about *this*
   conversation — who this person is, what exists in their business, what is remembered about
   them, the time on their clock, what recent turns read and did, and the thread so far.
   A lookup that *failed* is stated as a failure, never silently omitted — the model repairs
   what it is told about and mis-narrates what it is not.
4. **The model runs up to five tool rounds.** It can read anything its speaker's permissions
   allow (raw SQL under row-level security), write through plans and named operations, send
   messages with buttons, schedule itself to look at something later, and remember facts.
   The runtime tells it, every round, what the turn has actually done so far — so "done" can
   never honestly be said about work that did not happen.
5. **Every write is one transaction.** The rows touched are diffed before commit, messages are
   staged and only sent after commit, and anything consequential — money, other people,
   deletions — comes back as a preview behind a button only the person's tap can commit.
6. **Every outgoing message climbs a ladder of thirteen gates** — opt-out, mutes, quiet hours,
   caps, dedupe, the 24-hour template window — and a suppression is recorded as a fact with a
   reason, never a silent drop. Suppressions that are only about *timing* are re-attempted
   when the timing moves.
7. **If the model went quiet**, a recovery ladder makes sure the person still hears something
   true: one toolless round to put what the turn learned into words, then — only if that fails
   too — one honest fixed sentence.
8. **The turn ends with one reflection round** ("anything worth remembering? anything to come
   back to?") and is then **recorded in full** — every round, its reasoning, its SQL — whatever
   happened, including on error.

Meanwhile, most of the product runs because **time passed**, not because anybody typed: a
minute beat plans the jobs that should exist (reminders, briefs, billing, chases) and runs the
ones that are due. A job that needs to *say* something opens an ordinary turn — same prefix,
same tools, same recorder.

Everything below is the same story with the file, the symbol and the exact order — the level a
fix has to be argued at.

## Why this exists

`MECHANISMS.md` is an inventory, and an inventory has no time in it: it says `proseViolations`
exists, not that it runs *after* the model has written a message and *before* it is sent —
which is the fact that decides where a fix belongs. Order is its own defect class (the
recovery ladder once held two correct mechanisms in the wrong sequence — fact 7 below), and a
mechanism found in the index still lands in the wrong stage. The brain does not fit in a
context window — `lib/agent` alone is ~209k tokens — so this is the sequence, written down
once instead of re-derived from the source every time.

---

## The map

```
inbound (Meta webhook · emulator · job)
 └ ingestInbound        writes the message ROW first (idempotent on the wa id),
    │                   then resolveInbound → resolveIdentity
    │                    ├ no business owns this number → the front desk (a MODE, 0)
    │                    └ number known to SEVERAL businesses → unresolved, silence
    └ runTurn
       0 the desk    a desk arrival runs the SAME loop in desk MODE: the one prefix's desk
                     section, the desk tail, four verbs gated at the dispatcher
       1 arrival     consumeAction → executeAction (the WRITE runs before any model)
                     …and then falls through to 2, so the model composes the receipt;
                     a tap the gate REFUSED also opens a turn, as a stated fact
                     mediaRefusal (the runtime speaks, not the prompt)
       2 context     now → recentToolTurns → variableTail → tapBlock → recentHistory
                     → stablePrefix
       3 rounds      generate → runTool → turnState → exit test   (5 rounds, cap measured)
                      ├ a write → checkSteps → [tx: audit → steps → diff → guards] → commit
                      └ a send  → composeAndSend → validateOutbound → the send ladder
       4 exits       spoke? → recovery round → apology ladder → discards → trailing send
       5 reflection  the last round: remember / schedule
       6 record      writeTurn — always, whatever happened; then the two-failures handoff
       7 handover     a front-desk turn that chose a business re-enters runTurn there,
                      with the same text — two turn rows, in two academies
```

---

## 1 · Arrival

**Before the turn: the ingress.** The Meta webhook stores the event and answers Meta at once;
the turn then runs in the same invocation's `after()` hook, with the cron beat's drain as the
backstop for a process that died mid-way. Either route ends in the same call:

| What happens | Where |
| --- | --- |
| The one door for every inbound: parse any shared contact card into the body, route, write the `message` row (all stamps `app.now()`, idempotent on the wa message id so Meta's retries collapse), then run the turn | `ingestInbound` · `bodyWithSharedContacts` · `lib/seed.ts` |
| The webhook queues the event, answers Meta, and drains it after responding; the cron beat drains whatever a dead process left behind | `queueWebhookEvent` · `drainWebhookEvents` · `lib/seed.ts` · `app/api/webhook/route.ts` |
| A shared number routes to a person by answering only what rows can answer — *does this number already belong to a business?* | `resolveInbound` · `lib/identity.ts` |
| It belongs to none: the person is a `prospect` at the front desk of the number they messaged, with a person, a contact and a transcript | `frontDeskContact` · `lib/identity.ts` · `app.front_desk_contact` · `0039` |
| It belongs to **several**: unresolved, and deliberately silent — "which of your businesses is this about?" needs an answer that sticks, and that design does not exist yet. No message row, no turn | `resolveInbound` · `lib/identity.ts` |
| The arrival is recorded **before** anything is asked, so a stranger who writes once and never answers is a row rather than an absence | `openArrival` · `lib/frontdesk/arrival.ts` |
| One contact resolves to a person and to **all** of their roles at once | `resolveIdentity` · `lib/identity.ts` |

**Inside the turn.** `runTurn` opens a per-turn SQL capture, resolves identity (an unresolvable
contact ends here — no turn row), folds any contact card into the text, and then branches on
what arrived:

| What happens | Where |
| --- | --- |
| A tap claims its button in one conditional UPDATE, then runs the stored payload — **no model call before the write**, and `origin` records that | `consumeAction` · `lib/actions.ts` · `executeAction` · `lib/agent/loop.ts` |
| …and then hands the plan's result to the turn, which composes what the person reads. The write is a tap; the sentence is a turn | `TapNarration` · `tapBlock` · `lib/agent/loop.ts` · `committedResult` · `seedFromCommitted` · `lib/agent/tools.ts` |
| A tap the gate **refused** — expired, already used, missing — also opens a turn: the refusal enters as a stated fact and the model re-stages what the button carried instead of asking the person to type it all again. The fixed sentences are only the floor under that | `refusedTapBlock` · `TAP_REFUSAL` · `lib/agent/loop.ts` |
| A tap that has already answered this person — its plan staged their message at compose time — and has nothing left needing a judgement stops here, at the cost it always had | `nothingLeftToSay` · `lib/agent/loop.ts` |
| A button whose payload was a reply re-enters as if it had been typed | `executeAction` · `lib/agent/loop.ts` |
| The one deterministic tap refusal: losing a cover race is not a fault, so the loser is told by the runtime, in one plain catalog sentence | `claim_cover` · `lib/agent/loop.ts` |
| An image, voice note or file is answered in words by the runtime (three sentences, one per kind); anything typed alongside still goes to the model | `mediaRefusal` · `lib/agent/loop.ts` |
| A shared contact card takes the opposite path — it is data, so it is rendered into the turn's own text and read by the model | `bodyWithSharedContacts` · `lib/messaging/contact-card.ts` |
| A sticker, a pin, a poll — nothing readable at all — gets one runtime sentence asking them to type it | `goToModel` · `lib/agent/loop.ts` |

A turn carrying text, a task, **or a tap the model still owes an account of** reaches stage 2.
**A card is text by the time this test runs**, which is the whole of why it reaches the model
and a photo does not — and it is also why order matters here: fold the card in *after* the test
and a bare contact share falls through to "that came through as something I can't read".

**The tap's two halves split here.** The DECISION is above this line — the payload was
authored and validated at compose time and executes verbatim now — and the sentence about it
is an ordinary turn below it ([`ARCHITECTURE.md`](./ARCHITECTURE.md) layer 2 carries the full
F-CD story). `noop`, `menu` and `handoff` do not go on to stage 2, and the test for that is on
`executeAction`: the runtime may **replay what the model wrote**; it may not **author what the
person reads**.

**If anything above stage 6 throws**, the catch guarantees the *asker* still hears one true
sentence — tap-aware, because after a committed tap "nothing was changed" is a lie — and the
turn row still records the error. `runTurnBody` · `lib/agent/loop.ts`

## 1a · The front desk — a MODE of the one brain, not a second one

Since the one-brain merge a desk arrival runs the ordinary loop. The mode is decided at
arrival (the identity's academy carries `is_front_desk` — 0051), and everything mode-shaped
happens at three seams the loop already owns — the tail, the dispatcher, the lint. The desk's
standing facts are a byte-stable section of the ONE prefix. What the two-brain fork cost, and
how the merge is measured, is [`ARCHITECTURE.md`](./ARCHITECTURE.md)'s *one legitimate second
prefix* trap.

| Order | What | Where |
| --- | --- | --- |
| 1 | One stable prefix for both modes — the desk's standing facts are a section of it, byte-identical everywhere | `stablePrefix` · `lib/agent/context.ts` |
| 2 | The desk tail replaces the whole tenant tail: the arrival's asked-state, what this number is, and the businesses their own words name | `deskTail` · `lib/agent/context.ts` · `frontDeskTail` · `lib/frontdesk/context.ts` |
| 3 | On a desk turn the dispatcher allows `reply`, `read` (the desk owns no rows, so empty is expected) and the four desk verbs — `find_business`, `join_business`, `start_business`, `stop_messaging`; everything tenant-shaped refuses with the truth, and a tenant turn reaching for a desk verb is refused the same way | `deskSurface` · `lib/agent/tools.ts` |
| 4 | The ordinary rounds — one loop, one recorder, real buttons. A hand-over **latches**: it breaks the loop before a parting sentence, and every further call this turn is refused, because the business answers this same message next | `modelTurn` · `lib/agent/loop.ts` · `deskSurface` · `lib/agent/tools.ts` |
| 5 | The name matcher is evidence now, not a routing decision — it decides nothing on its own | `matchAcademiesByName` · `lib/identity.ts` |
| 6 | A destination: a prospect contact in an existing business (find-or-create on the last ten digits — the one door, so an existing parent keeps their roster), or a business that did not exist a second ago | `joinBusiness` · `foundBusiness` · `prospectContactIn` · `lib/frontdesk/route.ts` · `lib/identity.ts` |
| 7 | Their whole desk exchange is written into that business as the opening rows of its thread, on the rows' own clocks — and what they told the desk they were (`arrived_as`) crosses with them, stated in the tenant tail until real rows say it | `carryDeskTranscript` · `lib/frontdesk/route.ts` |
| 8 | The desk's speaking paths mask the NUMBER's business names at validation time, not from a snapshot — a business founded seconds ago is the name a draft most needs masked | `deskLintScope` · `lib/agent/tools.ts` |

The turn row is written by `writeTurn` at stage 6 like every other, and only then does the
hand-over run (stage 7). The desk owns no recorder, no prefix and no loop of its own.

## 2 · Context

Assembled in this order, all of it before the first round.

| Order | What | Where |
| --- | --- | --- |
| 1 | The **tenant's** clock, awaited first — everything below is stamped against it | `now` · `lib/clock.ts` |
| 2 | One read of recent turns, two filters over it: what was looked up (age-stamped, budgeted, and the budget states what it cut), and what was done (each action carrying its outcome — `staged`, `refused`, `done` — so a preview can never replay as a fact) | `recentToolTurns` · `recentLookups` · `recentActions` · `ageOf` · `lib/agent/loop.ts` |
| 3 | The tail — who this is (roles, their open-or-shut 24-hour window with the template budget, what they told the desk), the ids for SQL, the business, the census of what exists, the memory hot sets, the time, and the standing states | `variableTail` · `census` · `standing` · `windowRightHere` · `lib/agent/context.ts` · `hotSet` · `lib/agent/memory.ts` |
| 4 | On a tap: what the button already ran, and its result in `act`'s own shape. The tool context is seeded to match, so `turnState` agrees with it from round one | `tapBlock` · `lib/agent/loop.ts` · `seedFromCommitted` · `lib/agent/tools.ts` |
| 5 | The conversation so far — sixteen messages, suppressed rows excluded — with time gaps noted beside the messages rather than among them | `recentHistory` · `historyGaps` · `lib/agent/loop.ts` |
| 6 | The cached half, memoised once per process: preamble → the front-desk section → schema → operations framing → catalog → platform facts → business-world facts → doctrine, then the cache boundary | `stablePrefix` · `SCHEMA_DOC` · `lib/agent/context.ts` · `lib/agent/schema-doc.ts` |

A prefetch that **fails** is not an absent block: it renders as a stated gap carrying its
reason, because a paragraph that was never there is invisible to everything downstream —
and a failed read and an empty one are opposite facts.
`fromRead` · `unread` · `lib/agent/context.ts`

What the model was **told** is recorded beside what it did: every turn writes a context row —
the tail in full, the prefix by fingerprint — kept out of the hot path and stored with the
turn record. `CONTEXT_MARKER` · `projectTrace` · `lib/agent/loop.ts`

## 3 · The rounds

One loop, `MAX_TOOL_ROUNDS` of it — five, a cap set by measurement: no turn past four rounds
was doing anything but recovering, expensively, from a failure. `lib/agent/loop.ts`

| Order | What | Where |
| --- | --- | --- |
| 1 | Generate with the full tool block every round — the declarations are part of the cached prefix. Thinking runs at `low`; the client retries transient failures once and carries `finishReason` out, so an empty round is diagnosable | `generate` · `finishReason` · `lib/agent/deepseek.ts` · `toolDecls` · `lib/agent/tools.ts` |
| 2 | Prose beside tool calls is a notebook, not a reply. Only a round that calls nothing is speaking | `lib/agent/loop.ts` |
| 3 | A round that answers in words while the turn has touched **nothing** does not end the turn: it costs one granted round, once, with the draft **held** — restored if the granted round stays silent, superseded only by fresh prose on a later round | `saidNothingDone` · `heldProse` · `lib/agent/loop.ts` |
| 4 | Arguments that did not parse are recorded and answered, never executed | `parseError` · `lib/agent/deepseek.ts` |
| 5 | A byte-identical repeat of a call that already failed is blocked before the tool sees it | `failedCalls` · `lib/agent/loop.ts` |
| 6 | The same *refusal* twice — however the arguments were edited — says so in the result; three times stalls the turn out of the loop | `failedReasons` · `stalled` · `lib/agent/loop.ts` |
| 7 | Every round ends with the runtime stating the turn's own facts — rounds used and remaining, tables written, messages landed, plans waiting on a tap — and the penultimate round names the last one while a change of course can still act | `turnState` · `lib/agent/tools.ts` · `lib/agent/loop.ts` |

**Exit tests, in order:** no tool calls (and no granted round owed) → done · a desk hand-over →
out, before a parting sentence · `stalled` → out to the ladder · the asker has been replied to
**by this loop** *and* no plan is waiting to be committed → done.

The declared surface is the ~28 operations (each with its own typed schema), the primitives —
`read`, `plan`, `commit`, `reply`, `schedule`, `remember`, `handoff` — and the four desk verbs.
`act` is **not** declared: an operation called by its own name is rewritten to `act` before the
switch, so the tool path, the button path and the plan path cannot disagree about what an
operation is. `runTool` · `OPERATIONS` · `lib/agent/tools.ts`

**A read:** `assertSingleReadStatement` (one statement, no host clock) → a pre-flight refusal
when every table named is the runtime's own closed books, carrying the route to the real answer
→ `modelQuery` under **this person's** RLS → a scope line → rows clipped to `MODEL_ROWS_SHOWN`
with the true row count beside them. Zero rows under a scoped session are marked ambiguous:
empty and withheld look identical from there. A column error comes back naming the table the
column is actually on. `CLOSED_TO_EVERY_SESSION` · `whereThatColumnLives` · `scopeLine` ·
`lib/agent/tools.ts` · `lib/db.ts`

**A plan that gates nothing runs at once.** `needsPreview` is asked when `plan` returns: a plan
that touches nobody else, no money and nothing destructive executes in the same round and says
so — the handle-and-wait shape lost real businesses to a model that read back a preview and
never committed it. Only a consequential plan waits on a tap. `lib/agent/tools.ts`

## Sub-pipeline A — a write

Every write, from every route, runs this. `lib/agent/plan.ts`

| Order | What | Where |
| --- | --- | --- |
| 1 | Steps validated at mint against the thing that will run them; human assertions stripped | `checkSteps` · `stripHumanAssertions` · `lib/agent/steps.ts` |
| 2 | Every id-shaped argument read back **before** the transaction opens | `assertIdsExist` · `lib/agent/plan.ts` |
| 3 | Operations expanded into steps | `expand` · `lib/agent/plan.ts` |
| 4 | *In the transaction:* audit opened → steps run → diff read from the trigger's before/after images | `beginAudit` · `lib/audit.ts` · `runSteps` · `readDiffSafe` · `lib/agent/plan.ts` |
| 5 | *Still in it:* guards ask the database what the world **became** — collisions, and whose life this changed without telling them | `noteClashes` · `noteUntold` · `lib/agent/plan.ts` · `coachClashes` · `lib/agent/clash.ts` · `untoldAudience` · `lib/agent/untold.ts` |
| 6 | A plan carrying writes whose diff came back empty is failed before anything else happens — an empty commit is indistinguishable from a rollback, and nothing may flush or claim success on one | `assertSomethingChanged` · `lib/agent/plan.ts` |
| 7 | Consequence — money, other people, destruction, collisions, bulk — decides preview or commit, from the plan's **own result**, never from who composed it | `needsPreview` · `lib/agent/plan.ts` |
| 8 | Commit. Only now: one message per recipient, then the wire, then the audit row and the receipt | `mergePerRecipient` · `flushOutbox` · `recordAudit` · `buildSummary` · `lib/agent/plan.ts` |

A refusal re-runs itself as the service role, rolled back, to tell a permission denial apart
from a WHERE that matched nothing — and escalates to the admins in business language, never the
SQL. Postgres refusals come back carrying their own repair, read from the live catalog.
`hintFor` · `refusalHint` · `repairHint` · `escalateRefusal` · `lib/agent/plan.ts`

A preview does all of the above inside a rollback, so what the person confirms against is
measured rather than estimated. `previewPlan` · `withRollback` · `lib/agent/plan.ts`

## Sub-pipeline B — a send

`composeAndSend` validates the message it *would* have produced — placeholder ids standing in
for the buttons — before minting a single action row; then the actions are minted, `send` is
the one path to the wire, and the sent message is stamped onto its buttons so the card dies as
one family. Whether a send is *solicited* is derived from the acting session, never passed by
hand. `composeAndSend` · `solicited` · `lib/messaging/compose.ts` · `attachActionsToMessage` ·
`lib/actions.ts` · `send` · `lib/messaging/send.ts`

The gates, in the order they run. Each returns a `message` row carrying its reason, because a
suppression is a fact, not a failure:

| | Gate | Why it is here |
| --- | --- | --- |
| 1 | `no_contact` | there is nobody to send to |
| 2 | `opted_out` | stopping outranks everything below it — the opt-out's own acknowledgement is the one exception |
| 3 | `muted` | "stop messaging me about money" is a scope, read from `MUTE_SCOPE`; a reply to something they said is never muted |
| 4 | `quiet_hours` | not for admins, not for anything solicited |
| 5 | `self_confirmation` | nobody confirms something to themselves |
| 6 | `escalation_about_self` | an escalation about you does not arrive at your phone |
| 7 | `pre_launch` | an academy that is not live does not message its roster — its own staff, and anyone who spoke first, are not the roster |
| 8 | `repeat` | a standing message reports a state once — keyed on the state (`stateKey`, no time window), then on the byte-identical body (5 minutes solicited, 6 hours not) |
| 9 | `limit_violation` | every way the real wire would reject it, enumerated by `validateOutbound` — refused whole, never truncated |
| 10 | `silence_backoff` | somebody who has answered none of N straight unprompted sends is dark — §16.3's response-rate proxy, and their own next message resets it |
| 11 | `recipient_frequency_cap` · `tenant_send_cap` | volume, per person and per tenant; an admin **inside their window** is an operator mid-task, not a recipient to protect |
| 12 | `out_of_window_no_template` | outside 24 hours it is a frozen template or nothing — the catalog's template, or the recipient's role picks one of the approved eight; the composed body becomes one parameter, cut from the END, and `altered` says by how much |
| 13 | `duplicate_idempotency` | this exact message has already been sent |

Past the ladder the row is written, the buttons were already minted as a family that dies
together, and a question that was asked becomes `pending_request` state — written only once a
message actually queued, superseding any open ask on the same subject *and* retiring that older
card's buttons, so two live "Do it"s for one decision cannot exist. Only then does the
transport run. `insertMessage` · `staleAsks` · `committingButton` · `lib/messaging/send.ts`

A suppression for **timing** — quiet hours, either cap — is not the end of the message: it
releases its idempotency key and `suppress` enqueues one `redeliver` job for the stored row,
which is replayed through this same ladder once the timing moves (`redeliverStored`, deferred
past quiet hours). A suppression that is a decision keeps its key and its silence.
`suppress` · `redeliverStored` · `lib/messaging/send.ts` · `lib/jobs/handlers/redeliver.ts`

## 4 · The exits

Reached when the loop is over. Here the order **is** the mechanism.

| Order | What | Where |
| --- | --- | --- |
| 1 | Did anything reach the **asker's** phone — not "did the model call reply", not "did something leave the building". Asked of the turn's one outbox, then of the database, because a runtime send from inside a plan never enters the outbox | `spoke` · `told` · `lib/agent/loop.ts` |
| 2 | If nothing did: one toolless round, history flattened — tool calls narrated in the runtime's voice, so the model cannot mistake the harness's rendering for its own speech — to put what the turn already learned into words | `flattenToolTurns` · `lib/agent/loop.ts` |
| 3 | Only if that failed too: one of **four** sentences, picked by what actually happened — and none at all if the runtime already said something true | `raised` · `lib/agent/loop.ts` |
| 3a | The fourth outranks the other three and is the tap's: all three of them say some version of *nothing came of it*, and after a committed write every one is false. The `backstop` on `TapNarration` — the receipt this path stopped sending — is what goes out instead | `TapNarration` · `runtimeAuthored` · `lib/agent/loop.ts` |
| 4 | Three discards, each traced: a job turn's trailing prose (unless the job asked for **a message**, or the turn staged a plan whose button can only ride that sentence); prose after a desk hand-over; prose after a confirmation this turn already put on their screen | `stagedTapAwaitingThem` · `askedForAMessage` · `lib/agent/loop.ts` |
| 5 | Trailing prose gets the confirmation button minted by the runtime, since only it holds the validated steps — **every** waiting plan behind one button, not the newest — and the button is dropped, traced, when the body is too long to carry one | `pendingConfirmation` · `lib/agent/tools.ts` · `affordanceFits` · `lib/agent/loop.ts` |
| 6 | The message is **validated, not edited**. A violation buys one repair round; a second failure sends the draft as written — unless the draft is not prose at all (a raw tool envelope, machinery), which is withheld and replaced by one true runtime sentence. The ladder's own copy is exempt, because a repair round asks the MODEL to rewrite a draft this file wrote | `proseViolations` · `structuralViolation` · `lib/agent/lint.ts` |
| 7 | Every figure in what was said is compared against what this turn's tools returned — recorded, gating nothing | `traceabilityNote` · `lib/agent/traceability.ts` |
| 8 | The trailing send is the LAST send and the gates can still refuse it — so the turn asks once more, after, whether anything reached them, and answers a total suppression with one short sentence that carries no affordance, the one shape the gate that just fired cannot refuse | `landed` · `lib/agent/loop.ts` |

What the turn row and reflection are told is what **reached** them, never what was attempted:
a suppressed draft is recorded as silence, and a runtime-authored sentence is named as not the
model's. `spokeAsTrailingProse` · `lib/agent/tools.ts`

## 5 · Reflection

The turn's **last round**, not a second call — so it sees the schema, its own trace and its own
reasoning, and shares the cache with everything before it (a filtered tool list broke exactly
that, measurably). It runs only when the person was actually answered, and never on a desk
turn — the desk is sterile by design. Its opening sentence is **derived** from what reached the
asker, so it cannot hand the model a false premise about its own turn. Two questions: is there
a fact worth carrying, and is there something to come back to. "Neither" is the common answer.
Only `remember` and `schedule` run; anything else is dropped and traced.
`REFLECT_TOOLS` · `isReflectTool` · `reflectionOpening` · `lib/agent/loop.ts`

## 6 · Record

`writeTurn` runs outside the error path — a turn that threw is still a turn that is recorded.
The flight recorder carries the model's own rounds and reasoning beside the tool calls, the
tail it was shown, and every SQL statement the turn issued; the full record goes down in the
**same transaction** as the turn row, behind a savepoint so a malformed record can never take
the turn row with it. With `PROBE_FULL_TRACE` the stored projection is the full one.
`writeTurn` · `ToolTrace` · `lib/agent/loop.ts` · `captureFullTrace` · `lib/agent/turn-trace.ts`

After the record, two things can still happen, in this order: a second consecutive errored
turn triggers the automatic handoff to a human (`handoffOnRepeatedFailure` ·
`lib/agent/loop.ts`), and a front-desk turn that chose a business re-enters `runTurn` there
with the same (effective) text — stage 7, two turn rows, in two academies. It cannot recurse:
both destinations are real tenants by construction.

---

## The standing surface

Everything above happens because a person typed. Most of the product happens because time
passed.

```
tick (Vercel Cron · pg_cron)   app/api/cron/tick/route.ts
 └ planAhead      what should exist by now — idempotent on a dedupe key
 └ drainIngress   the webhook backstop: stored inbound events become ordinary turns
 └ runDueJobs     claim a batch under a lock → handler → done | skipped | failed
    └ a handler that speaks to a person opens an ORDINARY turn: same prefix, same
      tools, same flight recorder (runSynthesis · lib/jobs/handlers/admin.ts)
 └ reportMissed   every run ends by reporting what did NOT run
```

| Rule | Where |
| --- | --- |
| A job is due against the clock of its **own** tenant, and the production beat claims only the `live` lane — a drive's world drains its own queue | `runDueJobs` · `app.now_for` · `lane` · `lib/jobs/runner.ts` |
| A transient failure is retried with backoff; past `MAX_ATTEMPTS` the row stands as failed evidence. A worker that died mid-job is reclaimed after `LOCK_STALE_MINUTES` | `fail` · `claim` · `lib/jobs/runner.ts` |
| A handler whose precondition no longer holds throws `JobSkip` and is recorded as skipped, not failed | `JobSkip` · `lib/jobs/runner.ts` |
| A watch the model minted needs a parseable expiry, an instruction and an academy before it reaches the queue, and there is a cap on live watches per business; its `context_query` is parsed and planned against the real schema at mint time, in the tool that mints it | `guardAgentTask` · `AGENT_TASK_CAP` · `lib/jobs/enqueue.ts` · `context_query` · `lib/agent/tools.ts` |
| A newer watch on the same `subject_key` supersedes the older one — restating is safe, duplicating is impossible; a watch is dropped by the slug the screen shows | `subject_key` · `dropAgentTask` · `lib/jobs/enqueue.ts` |
| A watch fires as an ordinary turn under a session **reconstructed** for the person who minted it — roles re-checked at run time, evidence queries run under their own RLS on the day, expiry enforced | `runAgentTask` · `lib/agent/loop.ts` |
| A send time landing in quiet hours is **moved at plan time**, not dropped at send time | `pullOutOfQuietHours` · `lib/jobs/plan-ahead.ts` |

---

## What the order encodes

Twelve facts that are only true because of *when* something runs.

1. **The clock is read first.** Every replayed lookup is stamped against it; an unstamped past reads as the present, and the model will argue itself out of a correct doubt with it.
2. **A failed prefetch is a stated gap, never an empty block.** The model repairs what it is told about and mis-narrates what it is not.
3. **The prefix is byte-identical and comes first.** Anything per-tenant or per-turn is data in the tail. Tool declarations serialise above the messages, so they are part of the cached half — filtering them per round costs more than sending them.
4. **Guards run inside the transaction, after the steps, before commit.** That is the only place the question has one answer, and the only place that covers routes nobody has written yet.
5. **Nothing reaches the wire before commit.** Steps stage messages; the outbox flushes after the transaction returns.
6. **Consequence decides the preview, from the plan's own result** — not from who composed it, so raw SQL and a named operation are judged the same way. And a plan that gates nothing runs at once, because a preview nobody needed is where committed work went to die.
7. **Answer before apologising.** The toolless recovery round runs first, the apology only if that fails too. Reversed, the cheap bad answer wins every expensive turn.
8. **Validation refuses; it never rewrites.** A refusal buys one round of grace, which is the same deal the reply tool gives.
9. **Reflection is the last round, not a second call.** A separate call has no schema, no tools and no trace — it invents table names and cannot be corrected.
10. **The turn is recorded whatever happened.** The record is written outside the error path, because the turns worth reading are the ones that went wrong.
11. **A tap writes before the model and speaks after it.** Two different acts: fuse them and the receipt is composed before the transaction it describes; reverse them and a model edits a payload a person already approved. Either way is F-CD ([`ARCHITECTURE.md`](./ARCHITECTURE.md) layer 2).
12. **The trailing send runs after every guard that could vouch for it**, so it is the one send with nothing underneath — which is why the turn checks once more, after it, whether the person actually holds anything.

## Where a fix goes

| The symptom | The stage that owns it | Not |
| --- | --- | --- |
| It did not know something | 2 · context | a line in the prefix |
| It knew, and said it wrong | 4 · validation refuses and buys a round | an edit on the way out |
| It changed something and nobody was told | A · the untold census note | a paragraph of doctrine |
| It sent something it should not have | B · a gate on the ladder | the composer |
| It went round in circles | 3 · `failedReasons`, `stalled` | a longer prompt |
| It said nothing at all | 4 · the recovery ladder | |
| It answered in words and did nothing | 3 · the granted round (`saidNothingDone`) | a "did you act?" regex |
| It said "done" about work that did not happen | 3 · `turnState`, every round | a claims regex on the way out |
| A receipt reads like a database | 1 → 2 · the tap carries an account and the turn composes | a better sentence in `buildSummary` |
| A state cannot be reported at all | layer 0 — it is a row | a memory fact |

`MECHANISMS.md` then tells you whether the thing you are about to build is already there.

## How this stays true

`npm run check:anatomy` fails the build when a symbol named in a table above is not in the file
beside it (whole-word — a longer identifier cannot vouch for it), when a path named here does
not exist, or when the send ladder is no longer in this order. A document that claims something
about reality gets a program that checks the claim — the same deal `check-schema-doc`,
`check-rls-doc` and `check-layout` make. `npm run check` runs it with the other static gates.

It does **not** check the prose. **If you change the order of something in the brain — a gate
moved, a stage added, an exit re-sequenced — updating this file is part of that change**, and
the spine files (`loop.ts`, `tools.ts`, `context.ts`, `plan.ts`, `send.ts`) say so at the top.
The check only guarantees you cannot forget this file exists.

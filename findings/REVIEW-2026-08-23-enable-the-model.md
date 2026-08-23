# Review, 23 Aug 2026 — where the harness stops enabling the model

A whole-brain review against one question: **where does the code not mesh with "a capable
model, told the truth"?** Seven parallel reviewers read `lib/agent/` complete, plus
`lib/actions.ts`, `lib/frontdesk/` and the speaking path (`send.ts`, `compose.ts`,
`lint.ts`) — ~872k tokens of reading. Every finding below marked **VERIFIED** was then
re-read and confirmed by hand at the cited line before anything was changed. The rest are
in the appendix, unconfirmed, for a later pass.

The headline: the philosophy holds almost everywhere — and where it breaks, it breaks in
one direction. Not gates, not doctrine: **information failures inside the harness's own
plumbing**. The commonest shape, over and over, is the repo's own named trap: *null is a
failed read; `[]` is an empty one* — enforced beautifully at the prefetch layer
(`Read`/`fromRead`/`unread`) and then violated by a dozen ad-hoc `.catch(() => [])` and
`if (!x.error)` sites downstream of it. The second commonest: a truth the runtime holds
and never delivers to where composing happens. Exactly the classes the house rules
predict, in the places the house-rule machinery doesn't reach.

## Verified, and fixed in this pass

Each of these ships as its own commit, smallest risk first. None is a gate; none adds a
prompt line; every one delivers a fact the runtime already held to the place the model
composes — or stops the harness from asserting a falsehood.

### R1 · `assertSomethingChanged` runs after COMMIT — its own tag says "aborts instead of committing"
`lib/agent/plan.ts` — **the worst one.** The guard is called *after* `withSession`
returns, i.e. after the transaction has committed (the code's own banner: "---- committed.
Only now does anything reach the wire. ----" sits above it). A plan whose write-diff came
back empty throws CHANGED_NOTHING, tells the model "Nothing was changed and nobody was
messaged" — while the audit entry and any `schedule`-step job rows from that same plan
**have committed**. The `@mechanism` tag on the guard, and ANATOMY.md sub-pipeline A
order 6, both describe the correct behaviour ("failed before anything else happens");
the code drifted from both. This is ANATOMY's own defect class: two correct mechanisms
in the wrong sequence. *Fix: move the assert inside the transaction, before it returns,
so CHANGED_NOTHING is a rollback — which is what everything downstream already believes
it is.*

### R2 · The lint repair round asks the model to fix a draft it cannot see
`lib/agent/loop.ts` (trailing lint). The final speaking round `break`s out of the loop
*before* `messages.push(res.assistant)` — that push is only reached on tool-call rounds.
So when `proseViolations` refuses the draft and the repair round runs, the flattened
history handed to it does not contain the draft: "That last message cannot go out as
written" refers to a message that is not there, and `violationMessage` carries only short
samples of the violating parts. The model is told to rewrite, "everything else about it
was fine", a text it has to reconstruct — the exact "repairs what it is told about,
mis-narrates what it is not" failure, aimed at its own words. *Fix: hand the draft over,
verbatim, in the repair message.*

### R3 · A failed `business_rule` read erases the F-CC guard silently
`lib/agent/context.ts`, `standing()`. `if (!rules.error) { … }` has no else. On a failed
read, neither the stated rules, nor the "no rules are on file — a policy this business
has not stated does not exist" empty-state guard (built against F-CC), nor any gap marker
reaches the model. The `mutes.error` branch ten lines above does exactly the right thing
(`unread(...)`), so the fix is the file's own pattern applied to its own remaining hole.
Same fix for the watches block just above it, whose bare `catch { /* Never a
precondition */ }` silently drops the model's own standing promises — the one state the
block exists to stop it reconstructing from memory, and the state whose absence invites a
duplicate watch. *Fix: both failures render as stated gaps, the way every prefetch
failure already does.*

### R4 · `recentActions` still has the unmarked cut F-BY closed in its sibling
`lib/agent/loop.ts`. `recentLookups` got `droppedAtBudget` — "an absence with no marker
is invisible to the model AND to every reader" — and `recentActions`, the block that
exists so *"did I actually do that?"* is answerable, still ends with
`if (used + line.length > BUDGET) return …`: an early return, no marker, and the scan
stops so a marker could not even be exact. A write that fell past the budget disappears;
the model concludes it never happened and re-runs it. *Fix: mirror droppedAtBudget —
count what fell off, keep walking, say so.*

### R5 · `handoff` reports attempts as landings, and tells an admin a platform was told
`lib/agent/tools.ts`. `told_admin: sent.length > 0` counts `sent.push(o.status)` — and
`status` may be `suppressed` or `failed`. An escalation every admin's gate refused still
returns `told_admin: true` with "Someone will come back to you" for the model to relay.
Worse: for an **admin** caller no send happens at all — the entire residue is a
`memory_fact` ("Asked for a person: …") that nothing anywhere consumes — and the result
still hands over *"I've flagged this for the people who run the platform"*. A claimed
residue with no consumer; the relabeled-state trap, twice. *Fix: count landings, return
the per-admin statuses, and say what is actually true on each branch.*

### R6 · A failed admin lookup teaches "this business has no admin"
`lib/agent/tools.ts`, `reply` routing. `adminContactIds(...).catch(() => [])` followed by
`error: 'no admin contact is reachable to route this to'`. A transient DB error becomes a
false, unfalsifiable fact about the business — the exact class the `Read` type was built
to kill. *Fix: a failed lookup refuses as a failed lookup.*

### R7 · A superseded button is reported as clock-expiry, and the stored reason never leaves the row
`lib/actions.ts` `consumeAction` → `lib/agent/loop.ts` `refusedTapBlock`. When a sibling
commit retires a card, or a newer ask supersedes it, the row records why
(`expired_reason: 'superseded_by_action:<id>' | 'superseded_ask'`) — and the consume path
deliberately reports plain `expired`, with a comment arguing the sentence is "true of this
row". Half-true: the refused-tap turn is then told the button *timed out*, and
`TAP_REFUSAL.expired` invites re-staging — the wrong move precisely when the sibling
**committed** (the decision is already made) or a newer card exists (two live asks for
one decision is what `askSubject` exists to prevent). *Fix: carry `expired_reason` out on
the consume result and state it in the refused-tap block; the fixed sentence stays the
floor.*

### R8 · `generateJson`'s retry is a blind re-roll
`lib/agent/deepseek.ts`. Attempt 2 re-sends the identical request; the parse/shape error
from attempt 1 is captured for the *caller* and never delivered to the *model*. The model
repairs what it is told about. *Fix: attempt 2 carries what came back and why it failed.*

### R9 · Buttons over the platform cap vanish without a word
`lib/agent/tools.ts`, `reply`. `args.buttons.slice(0, LIMITS.buttons)` drops the surplus
before the shape check, so `validateOutbound`'s count violation can never fire, the prose
likely enumerates options the card no longer carries, and — unlike the `downgraded`
mechanism four lines below, which reports every degraded button "so the model learns
inside the same turn" — nothing says anything was cut. Same for list rows. *Fix: the cut
rides the same `downgraded` channel.*

### R10 · The watch-cap refusal doesn't name the verb that frees a slot
`lib/agent/tools.ts`, `schedule`. "Ask what I am watching and drop one first" — and the
declared operation is `drop_watch(slug)`, with the slugs sitting right there in the same
result. `NOT_OPERATIONS`' own rule: the refusal names the right form. *Fix: one clause.*

### R11 · A stalled turn discards the rest of the batch untraced
`lib/agent/loop.ts`. The third identical repeat sets `stalled` and `break`s out of the
per-call loop: every remaining call in that batch is never executed, never answered, and
never traced. In the recovery round's flattened history the model sees itself having
called tools with no result at all — its picture of its own turn falsified by the
harness, in the round whose job is to put what happened into words. *Fix: the skipped
calls are answered "not run — the turn stalled before this call" and traced.*

### R12 · Out-of-window template downgrades never reach `altered`
`lib/messaging/send.ts`, `asTemplateMessage`. Out of window the model's buttons are
relabeled to the template's fixed quick-reply, or dropped (a committing first button,
every button past the first, the list, the link) — all deliberate, all argued in place,
and none of it reported on `altered`, the channel built (`saidHowMuchWasCut`) so "the
model's next sentence about its own message is not a guess". The author's picture of the
affordance it just sent is wrong in exactly the way the body-cut report was built to
prevent. *Fix: each downgrade pushes its line onto `altered`.*

### R13 · An attachment is answered by the runtime and hidden from the model — twice
`lib/agent/loop.ts` (found by hand, confirmed twice over). (a) On a text-plus-photo
message the runtime answers about the attachment ("if it's your timetable, type the
classes…" — a guess: in this market it is at least as likely a payment screenshot) and
`modelTurn` then composes an answer to the text with no knowledge that an image arrived
or that a reply about it already landed. (b) `recentHistory` selects `body is not null`,
so a bare-photo inbound vanishes from the thread entirely while the bot's "I can't read
photos yet…" stays — an answer to a message that is not there, on every later turn. The
code comment's own argument conflates "the photo cannot be made into text" with "the fact
of the photo cannot be stated" — the first is a capability limit, the second is an
information failure. *Fix: the attachment enters the turn as a stated fact beside
`tapBlock` (what arrived, and what the runtime already said about it), and history
renders a media-only inbound as the act it was — the same two moves `tapBlock` and
`bodyWithSharedContacts` already are, for the same reasons.*

## Verified, deliberately not fixed here

**R14 · `cancel_session`'s credit-back dedupe is keyed on prose**
(`lib/agent/operations.ts` ~946). The `where not exists` guard on the credit adjustment
matches on `description = 'Credit — <class_name> <dayLabel>'` + a fixed reason string —
and `dayLabel` is relative ("today"/"tomorrow"), so the same cancellation re-attempted a
day later double-credits, and two same-day sessions of one class under-credit (the second
credit is suppressed by the first's description). The same file already retired
sentence-keyed money guards in `mark_attendance`'s retro credit. This is **money**, and
the ledger's own precedent (F-BA) is that money behaviour changes deserve a drive behind
them — so it goes to `findings/OPEN.md` (F-EV) rather than into this pass.

## What was NOT acted on, and why

- Anything whose fix is a prompt line (drive-gated by house rule; none of the fixes above
  touch the prefix).
- `WIRE_SHAPE`'s possible false positives, `sendMenu`'s topic regex over memory prose,
  `failedCalls` cache invalidation, the catch-apology's "nothing was changed" on
  committed-then-threw turns, and ~30 more appendix items: real-looking, unconfirmed by
  hand, or needing measurement first. They are listed below with the reviewers' claims
  as written — treat each as a lead, not a verdict.

## Appendix — the full sweep (51 findings, 7 reviewers; unverified except as marked)

See `review-appendix.json` beside this file for the machine-readable set (file, line,
symbol, claim, evidence, proposed fix, severity, per slice). The verified subset above is
R1–R14; everything else in that file awaits the same hand-check before anything is built
from it.

## Shipped (same day)

| Items | Commit |
| --- | --- |
| R1 · CHANGED_NOTHING becomes a real rollback | `ee4d3e5` |
| R3 · R6 · + the send-census — failed reads become stated gaps | `3d7066e` |
| R4 · R9 · + standing clips — every cut states itself | `8600c86` (endings repaired in `e9e9a2c`) |
| R2 · R8 — the model is shown its own failed words | `734b84e` |
| R7 · R10 — refusals carry their true cause | `72a1807` |
| R5 — handoff reports landings, drops the platform claim | `89b7690` |
| R11 — a stalled turn answers the calls it abandons | `f7bbb99` |
| R12 — altered reports the affordance downgrades | `69f3cac` |
| R13 — the attachment becomes a stated fact, in-turn and in history | `743e653` |
| R14 — ledgered as F-EV, awaiting its own drive | `4ef8d32` |

Housekeeping notes for the next session: `@mechanism` tags were deliberately not added
for the new behaviour in this pass — `docs/MECHANISMS.md` regeneration is entangled with
another session's in-flight `build-mechanisms.ts` renderer change, so tags (mediaBlock,
the recentActions marker, the supersession carry) should be added and `npm run
mechanisms` re-run once that lands. The regenerated index sits uncommitted in the
worktree so `npm run check` is green here; commit it together with the renderer change.
None of the shipped changes moves WHEN a stage runs except R1, which moves the code to
where ANATOMY already said it was.

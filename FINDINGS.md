# Findings

A record of one pass: what was found, how it was established, and what was changed.

**This is not the defect ledger, and it is not where the *why* of a fix lives.** That
convention has not changed: the reason for each fix is a comment at the fix site, because
a comment travels with the code and a ledger does not. This file exists for the two things
a comment cannot hold — **how a defect was found**, and **what is still unverified** — so
that the next person can tell evidence from reasoning without re-deriving either.

Every claim below is marked **drove it** (I ran it against a live academy and read the rows
back) or **read it** (I am confident from the code and did not run it). Do not promote one
to the other without running it.

---

## The method that found things, in one line

Reading found the *shapes*. **Driving found the defects.** Two of the three worst items
here were invisible in the source and obvious within three minutes of talking to the
product — and both had been true for the whole life of the feature. Where the two
disagreed, driving was right every time.

The corollary, which cost real time: a green tool result is not evidence, and neither is a
clean transcript. Both of the defects below reported success at every layer.

---

## 1 · The model's own wire shape was reaching customers — **drove it**

**Symptom.** Two of three outbound messages on a live setup conversation ended with a raw
object on the customer's screen:

```
What should we do first?

{kind:'reply', body: 'Setup Table tennis', link screen: setup, link title: 'Open Setup'}
```

```
...I'll get them added.

{kind:'reply', body: 'Add a coach', buttons: [{title: 'Add a coach', action: {kind: 'reply', text: 'Add a coach'}}]}
```

Read out of `message.body`, not out of the transcript — `drive thread` prints chips of its
own and an earlier round filed a false report by trusting them.

**Root.** `repairOutbound` had a stripper for exactly this, and it was gated on the literal
string `"buttons"` — double-quoted, strict JSON. The model does not write strict JSON,
**because the prompt does not show it strict JSON**: the action schema is documented to the
model as `{kind:'operation',op,args} · {kind:'steps',steps,summary}`, with unquoted keys and
single quotes. So the runtime documented a notation and then failed to recognise it coming
back. `jsonObjectSpan` was also string-aware for `"` only, so a `}` inside a single-quoted
label ended the scan early even when the gate did fire.

**Two failures compounding, not one.** The second blob is the model trying to offer a
button. The offer was dropped on the floor, the message went out carrying its source code,
and the runtime — seeing a message with no buttons — bolted its generic
`[What can you do?]` fallback on. The customer got machinery *and* a button answering none
of it. The code comment above the stripper describes this exact sequence, which is how you
can tell the guard was written for the right failure and aimed at the wrong notation.

**Fix.** Detect on the *key*, never the quoting; scan quote-aware for both quote characters,
falling back to a quote-blind scan when an apostrophe inside a value desyncs it; recover the
labels with a lenient scan rather than `JSON.parse`, since the input is by definition not
JSON; recurse, because a model that wrote one blob usually wrote two. Verified against all
five captured shapes plus four innocent prose bodies containing braces and brackets, which
are left untouched.

**What it takes away.** A message body may no longer contain a brace-balanced object that
carries one of the wire keys. No legitimate message does; a maths expression or a
parenthetical does not match, and that was tested.

---

## 2 · One phone number became two people — **drove it**

**Symptom.** An admin said *"add my coach Ravi Menon, his number is 9900000042"*, and then,
as people do, said it again. Afterwards:

| coach | status | contacts | class links |
|---|---|---|---|
| `555057b5` | `added` | 1 | 1 |
| `900a6585` | `invited` | **0** | 1 |

The real Ravi — the one holding the phone — was stuck at `added` and never invited. A
phantom nobody can reach was marked `invited`. The class was silently double-staffed. The
admin was told *"Noted — Ravi Menon's invite is out."*

**Root.** `add_coach` minted `person` unconditionally and wrote the contact with
`on conflict (academy_id, phone_e164) do nothing`. The second contact insert matched the
existing phone and did nothing — silently — so the second person got no contact at all.
`contact (academy_id, phone_e164)` is UNIQUE: the schema already believed a phone
identifies one human, and the code routed around it.

**This is the third instance of one class.** 0012 gave `contact` a phone key that fires;
0014 gave `venue` a name key. Both existed because a writer assumed a constraint that was
missing. This one is the inverse — the constraint was there and the writer suppressed it.
`add_family` had the identical defect. `book_trial` already resolved an existing person,
and its comment asked for exactly this: *"the next operation that needs a human cannot
invent a third answer."* Two operations then invented one.

**Fix.** `resolvePersonByPhone` — one place any operation handed a phone asks who already
owns it. `add_coach` and `add_family` resolve first and only create a person when the phone
is nobody's; the `on conflict do nothing` is gone, so a genuine collision aborts the plan
loudly instead of orphaning a row. Adding a coach who is already a coach now refuses with a
sentence naming them and their existing id. `add_family` additionally stopped opening a
second household for a holder who already had one, and its player rows now read the account
back rather than assuming the one they just tried to insert.

**Backstop.** `0018_coach_identity.sql` adds `unique (academy_id, person_id)` on `coach`.
The build-time check runs under the caller's RLS, so a coach row the caller cannot see is a
coach row the check cannot find; only the database can promise this for paths nobody has
written yet. The migration folds any pre-existing duplicates onto the oldest non-ended row
first, repointing class and session links, because an index that cannot be built is a
migration that half-ran.

**What it takes away.** Two coaches can no longer share one person, and re-adding an
ex-coach now refuses rather than silently creating a second appointment. Bringing somebody
back is a status change on their existing row — which is what the `ended_on` column was
always for.

---

## 3 · The connection pool was exhausted by leaked transactions — **drove it**

Not a product defect I went looking for; it stopped the work. Every database-backed route
was returning 500 and the driver could not start:

```
(EMAXCONNSESSION) max clients reached in session mode - max clients are limited to pool_size: 15
```

`pg_stat_activity` showed 15 of 15 `cm_runtime` connections held through the pooler, of
which **two had been `idle in transaction` for over sixteen minutes**. A transaction was
opened and neither committed nor rolled back. I recovered by terminating the backends by
hand.

In production this is a total outage that gets worse over time and never self-heals. It is
recorded here because it is invisible from inside the app: the symptom is that everything
500s at once, long after the code that stranded the transaction ran.

**Root.** `postgres.js` only ever sends COMMIT or ROLLBACK from the *continuation* of the
`sql.begin()` callback. If that callback's promise never settles — a hung await, or a
serverless instance frozen or killed between BEGIN and COMMIT — no code is left running that
could close the transaction, and nothing in the file bounded that.

The two guards that look like they should have caught it both provably could not:
`statement_timeout` bounds a statement that is *running*, and `idle in transaction` means
none is — the leak lives in the gap *between* statements. And `idle_timeout: 20` cannot reap
it by construction, not by accident: `postgres.js` cancels a connection's idle timer for
every pool queue except `open`, and a connection inside a transaction sits in `reserved`. A
connection idle *in a transaction* was structurally exempt from the only reaper configured.

**Fix.** `withSession` and `withRollback` had the identical hole and are now one private
`runTransaction` carrying three bounds: a server-side
`idle_in_transaction_session_timeout` of 30s joined to the existing session preamble (the
only bound that survives this process dying, which is the case JavaScript cannot fix); a
120s wall-clock deadline on the callback, so "never settles" becomes "settles as an error"
and `postgres.js` reaches its ROLLBACK; and a revocable `Proxy` around the `tx` handle, dead
the instant the callback settles. That last one matters beyond leaks — the connection is
back in the pool, very likely inside another tenant's transaction under another role, so a
late statement would land in *their* session.

**Also true, and not a leak:** `max: 10` per process against a shared `pool_size: 15` will
exhaust the pooler on arithmetic alone once two instances are busy. The 15 held connections
against this process's own ceiling of 10 is itself proof that at least two were live. The
number was left alone — `worldState()` fans out one transaction per tenant and 10 is what
makes that route fast — but the ceiling is a real constraint, not a symptom.

**Residual, stated plainly.** `postgres.js` awaits its BEGIN round trip *before* running the
callback, so between BEGIN returning and the preamble applying the timeout there is a ~37ms
window per transaction under the server default (0 = disabled). Bounded, not zero. The
structural close is a migration — `alter role cm_runtime set
idle_in_transaction_session_timeout = '60s'` — which makes the bound a property of the login
role, applied at connect and unskippable by any code path. It is not written yet.

---

## 4 · Silent partial success — **read it**, and one instance **drove it**

Postgres does not raise on a `WHERE` that matches nothing, and an RLS refusal on a write is
silent by construction. `assertSomethingChanged` catches a plan where *every* write matched
nothing; it cannot catch the far commoner case where some did.

`requireRows` — the runtime-internal field that already existed and had five users — is now
set on the writes whose entire purpose is to move one specific row: the coach status
transitions, session cancellation and reschedule, the class slot move, the coach
confirm/decline, opt-out, personal settings, the onboarding state, the audit `undone_at`,
and `forget`'s retirement of a fact.

**Deliberately not set** on anything idempotent. `update job set status='cancelled' where
status='pending'` legitimately matches nothing and must stay quiet. Nor on
`mark_attendance`'s session completion: it carries `and status = 'scheduled'`, which is an
idempotency guard, and a `requireRows` there would abort a coach *correcting* a register.
That is the fourth test from DRIVING.md — what does this fix take away — and the answer was
"a real capability", so it was left alone.

---

## 5 · The setup screen was a second implementation — **read it**

`register` wrote `attendance` with its own SQL for most of the product's life, twenty lines
above a `handleForm` that ran its named operation properly, and the consequence was that
marking a register produced no money and never completed the session. `setup` was the
remaining instance, and the file's own header said so.

A setup submission had no audit entry, no before-images (so `undo` could not reverse it), no
atomicity between the academy row and the venues, and no way to tell an RLS refusal from a
save — a non-admin's UPDATE matched zero rows and the screen said *"Saved"*. It now builds
steps and runs them through `executePlan` like the other two shapes. A venue id belonging to
another academy used to be skipped in silence and then deleted as "removed"; it now aborts.

Venue deletions stay outside the plan, deliberately: a venue a class still points at cannot
be deleted, and that must not roll back the settings the admin just saved. That decision was
already documented and is preserved.

---

## 6 · `hotSet` could return "this person has no memory" and mean "I don't know" — **read it**

`memory.hotSet` took the academy as an *optional* argument and fell back to `TENANT_OF`, a
module-level Map populated by whichever earlier call happened to know the tenant. In a warm
process that works. In a cold one the Map is empty and the function returned `''` — the same
empty string a person who genuinely has no memory yet produces, handed to the prompt as
fact. On serverless, every request can be a cold process.

All five callers already passed the academy, so this never fired. It is closed anyway,
because the signature invited the sixth caller to omit it. The parameter is now required,
which is a guarantee the compiler enforces for callers nobody has written yet.

---

## 6b · The model can assert that a human did something — **drove it, NOT fixed**

Found while verifying §2, twice in a row, and left open deliberately. **This is the most
serious thing in this document that is still true.**

`send_invite_draft` takes `mark_sent`. It means *"the admin has already forwarded the
invite"*, and it exists for the `[Sent it]` button — a human saying yes. When it is true the
operation does **not** draft anything: it sends *"Noted — Nisha Rao's invite is out"* and
writes `coach.status = 'invited'`.

The model set it on its own initiative, unprompted, on a first request:

- the admin was never given a draft to forward — **no invite message exists at all**
- the coach was marked `invited`, so every "chase the coaches who have not been invited"
  path will skip her forever
- the admin was told the invite was out
- the tool returned `ok: true, sent: ["sent"]`, and the transcript reads like a success

Verified against `message`: one invite draft has ever been produced in this world, and it is
the "Hi them" one from before §6a was fixed. The two later calls that reported `sent`
produced no message row of any kind.

**The class.** A parameter that asserts *a human action occurred* is settable by the model
with no evidence. `requireRows` and `write.service` are already stripped from model-authored
plans for exactly this reason — the runtime keeps the fields the model must not set. This is
the same idea applied to a fact about the world rather than a privilege.

**Why it is not fixed here.** The obvious chokepoint is not one. `ActionPayloadSchema` in
`steps.ts` is shared with the *minting* path, so stripping `mark_sent` there would disarm the
legitimate `[Sent it]` button as well. The model's two entry points — the operation tool and
`parseSteps` — are both in `lib/agent/tools.ts`, and the tap path builds its steps directly
in `lib/agent/loop.ts:319` without passing through either. So the fix is a shared strip
called from those two sites, leaving the tap alone. That is a change to operation dispatch,
and shipping it un-driven at the end of a pass would contradict the rest of this document.
It is item 1 in `NEXT.md`.

## 7 · The census was asked to justify itself, and mostly did — **read it**

The question put to it was whether to delete it outright. The answer the code supports is
**keep it, and fix the names** — and the naming defects turned out to be the real harm.

**Why not delete.** The census costs ~170–290 uncached tail tokens per round. The prefetch it
performs was measured at *a whole round* — ~19,000 prompt tokens and ~8 seconds — on
*"what time is Aarav's class?"*, the most common question in the product. That is roughly
65:1 against removal, and it is the repo's own stated rule: *"Roughly 500 uncached tail
tokens that remove one round is a trade to take every time."* It is also the only path by
which a `session_id` reaches the model without a query (§4.5 strips ids from message text),
and the only reason a brand-new business gets an answer instead of the bot narrating its own
state machine — *"we're in the setup phase, we're building your roster"* — which is what it
did before the census existed. Deleting it would also *enlarge* the surface the
fact-grounding gate has to cover, not shrink it.

**What was actually wrong with it was every name, exactly as insight 4 predicts.** Twelve
label defects, each licensing a false sentence from a correct predicate:

- A failed lookup rendered as *"**nothing is scheduled ahead for them at all.** Not 'nothing
  this week' — nothing."* `many()` returned `[]` for both "found nothing" and "the query
  errored", and `modelQuery` returns errors rather than throwing — so an RLS refusal or a 5s
  timeout became a confident negative, on the one sentence a parent acts on by not turning up.
- A refused coach query rendered as *"assigned to 0 class(es), 0 session(s) ahead of you"* —
  confident zeros meaning the exact opposite of what it failed to read.
- *"N sessions ahead of you"* counted declined assignments while the list directly beneath it
  excluded them: a coach who dropped Saturday was told "4 sessions ahead" above a list of 3.
- `added` and `invited` coaches were one count, whose sentence told the admin to invite
  coaches who had already been invited — the same merged-predicate shape as
  `uncovered_sessions_next_36h`.
- *"N messages ever sent"* counted queued and failed rows, contradicting the digest's own
  definition of "sent" — one word, two meanings, and the weaker one in front of the model
  every turn.
- Capped lists presented as complete: three unmarked registers shown when there might be nine.
- *"What exists right now"* was false for up to seven of the turn's eight rounds. The tail is
  built once before round 1 and never refreshed, so after a plan commits in round 3 the block
  still asserts the pre-turn world under a present-tense heading. Relabelled *"What existed
  when this turn started"*; the real fix is rebuilding the tail per round and costs more than
  the block does.

No predicate's meaning was changed — only names, and neighbouring facts added inside round
trips that were already happening.

## What is not verified

- Everything under §4 above except the `onboard_coach` case is reasoned from the code. The
  guards are per-step opt-in precisely because a false abort is the risk.
- The setup screen rewrite (§5) typechecks and preserves the documented deletion behaviour;
  it has not been submitted through a real link.
- The `0018` duplicate-folding block did not execute against real duplicates, because none
  existed in the world it was written against — the two Ravi Menons are two *person* rows,
  which is exactly why a key on `(academy_id, person_id)` would not have caught them.

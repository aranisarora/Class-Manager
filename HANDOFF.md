# Handoff — how to drive this product, and what to drive next

You are picking up a WhatsApp-based class-management product built on a general agent over
general primitives (read SQL, write SQL, send, remember, schedule, show a view), bounded by
Postgres RLS. Your job is to make it production ready by **driving it until it breaks,
fixing the root, and driving again**.

Read `DRIVING.md` (method + the ten roots), `FINDINGS.md` (what the last pass found and how),
`NEXT.md` (what to build and why). `product-spec.md` is the authority on behaviour — it is
91k, so grep it, never read it whole.

Branch: `worktree-next-md-implementation`. Last commit `81a62b1`. A worktree needs
`.env.local`, `.secrets/` and `node_modules` (a junction is fine) copied in or **everything
fails in ways that look like model errors** — every case `ERROR`, zero tools, empty replies.

---

## 1 · The one thing that matters most

**A green check is not evidence. A clean transcript is not evidence. Your own query is not
evidence until you have checked what it actually compares.**

Last pass fixed ten defects. **Six of them sat inside cases whose every check passed.** The
score moved because of the one that happened to trip an invariant. The rest were found by
reading message bodies, round-by-round tool calls, and rows.

So for every turn you drive, read four layers and say what each said:

1. **What the person saw** — the `message` row body, buttons, `suppressed_reason`. Not the
   driver's chips: a past round filed a false report by trusting them.
2. **What happened inside** — `npm run drive -- turn`: every round, the model's own words,
   every tool call with arguments and results, per-round tokens/seconds/₹.
3. **What the database says** — `node scripts/q.mjs`. Order by `created_at`, never
   `queued_at` (stamped from the sim clock, which moves).
4. **Whether 1 matches 3.** This is the whole job.

**Three times last pass a "finding" evaporated on contact with the database.** Budget for
that; it is the method working, not time wasted.

---

## 2 · Traps that each cost real time. Do not re-pay them.

- **`q.mjs` defaults to `--role service`, which bypasses RLS.** `--as <contact>` alone only
  sets the GUC. To see what a person can actually see you need `--as <id> --role user`.
  This nearly produced a false family-privacy report. (The ordering bug that made
  `--role user` impossible is fixed; the default is still service, deliberately.)
- **`group by` on a truncated body finds duplicates that are not there.** `left(body,60)`
  in the SELECT is fine; grouping on the alias is not. Postgres resolves an ambiguous
  `GROUP BY` name to the *input* column — the probe's invariant is correct, my ad-hoc query
  was not.
- **The DB stamps UTC.** A turn "at 21:54" may be one minute ago. I briefly thought a probe
  had hung.
- **Do not edit product code while a probe is running.** Next hot-reloads, and your
  verification run becomes a moving target.
- **`rls-check` skips its hardest sections on an empty world and still prints "0 failed".**
  Seed a fixture, then confirm with `node scripts/rls-check.mjs 2>&1 | grep -ci skip` → `0`.
- **Advance the clock in ≤1h steps.** One big hop makes every job correctly decline, the
  transcript reads calm, and you have tested nothing.
- **The probe's "stranger" is not a stranger.** Nikhil Bose is a pre-registered contact in
  state `engaged`. The genuinely-unknown-number path has never been tested.

---

## 3 · The swarm, and the one thing that blocks it

The intended shape: **several explorer agents driving academies in parallel — including
several personas inside one academy, interacting — babysat by an orchestrator (Opus, high
effort) that also drives. An explorer finds an issue, reports it, the orchestrator fixes the
root and spins up the next explorer aimed at something untested.**

### Build this first, or the swarm corrupts itself

**`sim_clock` is a global singleton.** Two agents driving at once move each other's world.
Any explorer that calls `drive clock` silently invalidates every other explorer's run —
their jobs fire early, decline as stale, or never fire, and the transcripts read calm.

`NEXT.md` item 6 proposes a per-academy clock: `sim_clock` gains a nullable `academy_id`,
null meaning the global default; `app.now()` resolves the tenant's row first and falls back.
Every read of domain time already goes through `app.now()` or `lib/clock.ts`, so the blast
radius is small — but `app.now()` is called by nearly every policy and query, so **measure
the cost before committing**.

Until that exists, the safe parallel split is:

- **Many explorers, message-only.** Separate academies, no clock calls. Safe today.
- **Exactly one clock-owner at a time.** Anything touching sessions, reminders, registers,
  dunning or month-end needs the clock and must be serialised.
- Prefer `drive month --period YYYY-MM`, which closes a period by running due work rather
  than moving time.

Also real: `max: 10` connections per process against a shared `pool_size: 15`. Two busy
processes exhaust the pooler on arithmetic alone. Cap concurrent explorers accordingly.

### Protocol that works

Give each explorer: **one persona, one academy it built itself, one surface to probe, and a
budget**. Require it to report in this shape and nothing else:

```
CLASS:      one sentence naming the class of failure, not the instance
ROOT:       R1–R10, or `new` with an argument for why none fits
SAW:        shortest reproduction — command, what came back, what the DB said
LAYERS:     what the message row said / what the rounds did / what the rows say
BLAST:      who is hurt and how they would find out ("nobody would" is the worst answer)
CONFIDENCE: certain / likely / suspected — never round up
CLEAN:      what you drove and found no defect in
```

**Require the CLEAN line.** "Drove the whole coach ladder with families on it, no defect
found" is the only thing that turns "assume broken" into "known good".

Orchestrator rules:
- **Verify before fixing.** Re-run the explorer's reproduction yourself and check the rows.
  Explorers report confidently and are sometimes wrong.
- **Fix the root, not the instance.** Four tests in `DRIVING.md`; test 4 is not optional —
  say what each fix takes away, or you have not finished it.
- **One fix batch, then one probe.** Do not fix while a verification probe runs.
- Aim the next explorer at what has *never run*, not at what just broke.

---

## 4 · Work on this first, in this order

1. **The money back-half. It has still never executed and it is where being wrong is most
   expensive.** In order: the reconcile ladder to `[Confirm payment]` (the §11.5
   `requested → confirmed` transition); dunning to escalation; `per_package` exhaustion and
   the pack rolling over; `per_term`; a waiver through the model; a disputed charge through
   `money-dispute.md`. Read `tally_line` and `payment` rows directly — never a summary.
2. **Per-academy clock** (§3 above) — it unblocks everything parallel.
3. **`tally_line.dedupe_key`.** Money idempotency currently matches on `reason` and
   `description` — *text also shown to the parent*. Two writers disagreed and a trial player
   could be credited twice; that is fixed by sharing literals
   (`lib/billing-keys.ts`, guarded by `scripts/check-billing-keys.mts`), but renaming a class
   still defeats a description-keyed guard. A key computed from ids with a unique index makes
   the rule enforceable rather than agreed.
4. **The register as a Flow.** Decided: **the web surface is for things you read spatially
   (timetable, calendar); every form is a Flow.** `setup` is a Flow on both paths now.
   `register` is still a web link and is a form. Dedicated onboarding Flows are wanted for
   admins (built), coaches, and probably clients.
5. **An operation that closes a class.** 0021 makes class names unique among *open* classes,
   so reusing a name requires closing the old one — and nothing can. I created this gap;
   it is documented.
6. **R10's fact half, in shadow mode first.** A reply may state a time, date, price or roster
   never read from a row. Driven instances: *"I've also scheduled the sessions to start from
   today"* (first session was four days later, and no sessions existed yet); *"Two families
   have balances, totaling ₹3,500"* composed from a query that returned **one** row and
   netted a credit against another family's debt; invented surnames *"Aarav Iyer"* where the
   row says `Aarav`. **Log what it would block, block nothing, drive, read the log.** Do not
   implement it as a lint rule over message text — `lib/agent/lint.ts` explains why.

---

## 5 · Never been run. Point explorers here.

- Every money path after `record_payment` (see 4.1).
- **A genuinely unknown number.** Seven academies share one `sender_id`, so `resolveInbound`
  returns `unresolved` for any unknown inbound. Decide whether that is the standing
  "signup is the operator's" decision working, or a multi-tenant routing gap. Either way it
  is untested.
- **The coach persona by hand.** Only the probe has driven it.
- **The parent persona by hand**, especially: whether a parent *should* be able to end her
  own child's enrolment. The runtime can now tell a refusal from a missing row; the policy
  question is unanswered.
- **Media in.** The production path never fetches bytes — a Meta media id becomes a
  placeholder string handed to Vertex as an unresolvable file URI. The emulator's data-URI
  path works, which is exactly why driving will not find it.
- **`per_package`, `per_term`, trials.** No trial player has ever been billed.
- Two people in one conversation, a coach who is also a parent, a second admin.

---

## 6 · The commands

```bash
npm run dev                                   # check :3000 first, one may be running
npm run db:push                               # migrations, filename order, re-running is a no-op
npm run probe -- --models gemini-3-flash-preview --keep   # 17 cases; writes ~1,150 lines to .probe/score.md
npm run drive -- academy "X" --admin "Y"
npm run drive -- say|tap|stranger|present|register|waive|deliver|fault …
npm run drive -- turn [contact] --n 3         # every round: model output, tool calls, tokens, seconds, ₹
npm run drive -- score|cost|money|world|thread
npm run drive -- month --period YYYY-MM       # closes a period WITHOUT moving the clock
node scripts/q.mjs --academy "X" "<sql>"
node scripts/q.mjs --as <contactId> --role user "<sql>"   # what THEY see
```

**Copy `.probe/score.md` somewhere before the next run overwrites it. Read all of it.**

Before finishing: `npm run typecheck`, `node scripts/rls-check.mjs`,
`node scripts/verify-static.mjs`, and `npx tsx scripts/check-{lint,claims,repair,steps,flows,billing-keys}.mts`.

---

## 7 · Where the roots stand

Closed or much improved last pass: **R3** (runtime knows and doesn't tell — 4 instances),
**R4** (guarantee on one path of several — 3), **R6** (records narrower than changes),
**R1**, **R2**, **R7**.

Still live: **R5** — partially; literals are shared now but idempotency still keys on prose.
**R10** — the most open root, fact claims are unchecked. **R8** — untouched; `view` and
`recall` are still rarely chosen. **R9** — I created one (no way to close a class).

Carried forward, still true and unfixed: `move_class` announces a whole class while moving
one slot; `reschedule_session` accepts a past time; `client_cancel` declares
`scope: 'session' | 'series'` and never reads it; `plan.ts`'s `asService` `finally` runs
`set local role` on an already-aborted transaction, throws 25P02 and **discards the
in-flight exception**, which defeats `repairHint`.

---

## 8 · Two standing decisions, so nobody relitigates them

- **Instructions do not close structural gaps.** `doctrine.md` rule 11 already describes the
  fact-grounding failure exactly, it is in the cached prefix on every turn, and it did not
  prevent it. Do not add a behaviour module. Last pass closed ten defects with runtime code
  and database constraints.
- **Do not pixel-match WhatsApp.** Behavioural fidelity only — but enforcing the real API's
  limits *is* behavioural fidelity. The emulator was checked last pass and is faithful where
  it matters: suppressed messages render distinctly and never as delivered, and debug detail
  sits behind a toggle rather than inside the bubble.

# Handoff — how to drive this product, and what to drive next

## 0 · The prompt

Paste this to start. Everything it refers to is in this file.

> You are making a WhatsApp class-management product production ready by **driving it until
> it breaks, fixing the root, and driving again**.
>
> Read `HANDOFF.md` first — it is written for you. Then `DRIVING.md` (method + the ten
> roots), `FINDINGS.md` (what the last pass found and how), `NEXT.md` (what to build).
> `product-spec.md` is the authority on behaviour; grep it, never read it whole. Branch
> `worktree-next-md-implementation`.
>
> **The method is stricter than it sounds.** The last pass fixed ten defects; **six sat
> inside cases whose every check passed**. A green check is not evidence, a clean transcript
> is not evidence, and your own query is not evidence until you have checked what it
> actually compares — three apparent findings evaporated on contact with the database. For
> every turn: read the `message` row, read `drive turn` (every round, tool calls, tokens,
> seconds, ₹), read the rows, and say whether what the person saw matches what the database
> holds.
>
> **Orchestrate it as a swarm**, but read §3 before you fan out — `sim_clock` is a global
> singleton and any explorer that advances time silently invalidates every other explorer's
> run.
>
> Work in the order in §4. Start with the money back-half: it has never executed and it is
> where being wrong is most expensive.

---

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

- **`cm_service` does NOT bypass RLS — the previous version of this line said it did, and
  it was wrong.** Every service policy is `academy_id = app.academy_id()`, so with no
  `--academy` every tenant-scoped table reads empty: `select count(*) from payment`
  answered `0` for a database holding seven. It warns now, and `--all` sweeps every tenant
  and labels the rows. Use `--all` for any "has this product ever…" question.
  `--as <contact>` alone still only sets the GUC; to see what a person sees you need
  `--as <id> --role user`.
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
- **Advance the clock in ≤1h steps, and always pass `--academy`.** The clock is per-academy
  now (0024) but `drive clock` without `--academy` still moves the whole world. One big hop
  makes every job correctly decline, the transcript reads calm, and you have tested nothing.
- **Do not drive an academy an explorer owns.** I did, and had to discount that agent's
  message-timing findings. Its RLS and schedule results survived; the rest is suspect.
- **The probe's "stranger" is not a stranger.** Nikhil Bose is a pre-registered contact in
  state `engaged`. The genuinely-unknown-number path has never been tested.

---

## 3 · The swarm — the blocker is gone, and here is what it bought

The intended shape: **several explorer agents driving academies in parallel — including
several personas inside one academy, interacting — babysat by an orchestrator (Opus, high
effort) that also drives. An explorer finds an issue, reports it, the orchestrator fixes the
root and spins up the next explorer aimed at something untested.**

**The clock no longer blocks it.** 0024 gave `sim_clock` a nullable `academy_id` — null is
the world clock and the fallback for anyone without one — `app.now()` resolves the tenant
first, and `runner.claim()` compares each job against **its own** tenant's clock. Verified:
moving one academy 11 hours ran exactly one job, its own; under the old global clock that
same move would have fired 9 jobs across 5 other academies.

So explorers can now drive time in parallel, provided each **owns one academy** and always
passes `--academy`. `drive clock` without it still moves the world.

**What the swarm actually bought, measured over one pass.** Worth knowing before you size
the next one:

- **Three explorers, one per persona, found the SAME root independently** — a coach, a
  parent and a prospect each hitting a different symptom of `resolveContact` running under
  the caller's RLS. That convergence is the strongest signal this method produces, and it
  only appears if you run several personas *in the same pass* and then look for what their
  findings share instead of fixing three things.
- **A refutation pass killed 60% of a read-only audit** — 20 findings in, 12 refuted, 8
  survived, and three of the eight were real money defects nothing had driven. Without the
  skeptic stage that is 20 fixes, most spent on nothing. Tell the skeptic to default to
  refuted when uncertain: a false finding costs more than a missed one.
- **Read-only agents are safe to fan out wide** and need no clock at all. Forbid them the
  database entirely and verify their claims yourself — it is one command each and two of
  mine were wrong.

Still real: `max: 10` connections per process against a shared `pool_size: 15`. Two busy
processes exhaust the pooler on arithmetic alone. Three concurrent driving explorers was
comfortable; cap accordingly.

### What an explorer is for, and what it must bring back

Give each explorer: **one persona, one academy it built itself, one surface to probe, and a
budget**.

**An explorer never fixes anything.** It drives, inspects, and reports. If it fixes as it
goes, everything it finds afterwards came from a different product than everything it found
before, and the round stops being comparable. Only the orchestrator changes code.

**It must come back with evidence, not a conclusion.** The orchestrator's job is to judge
whether there is really an issue and what the *root* is, and it cannot do either from
"the bot said the wrong thing". It needs to see what the explorer saw. So the report carries
the raw material — the message row, the round-by-round turn log with every tool call and
result, and the rows before and after — and the explorer's analysis sits *on top of* that
evidence rather than replacing it.

Require exactly this shape, one block per finding:

```
## FINDING <n> — <one sentence naming the CLASS of failure, not the instance>

ROOT:       R1–R10, or `new` with an argument for why none of them fits
CONFIDENCE: certain / likely / suspected — never round up

### Layer 1 · What the person saw
Verbatim from the `message` row — NOT the driver's chips, which are its own.
    select body, payload, status, suppressed_reason, catalog_id
      from message where ... order by created_at
Paste the body in full. Say what buttons it carried, and whether anything was
suppressed and why.

### Layer 2 · What happened inside
Paste the `drive turn` output for that turn. It must show, per round:
  - what the model wrote before it called anything
  - every tool call, its arguments, and its result — failed reads and refused
    plans matter most; that is where the rounds and the seconds go
  - tokens in/out, cache ratio, seconds, ₹
Say how many rounds it took and where they went.

### Layer 3 · What the database says
The exact SQL you ran and the rows that came back — before and after where it
matters. Include the ones that came back EMPTY; a write that matched nothing is
the commonest way a bad run looks like a good one.
Check the tables the claim implies, not just the obvious one: `audit_entry` for
what the turn wrote, `job` for what it scheduled, `message` for what actually
reached the wire.

### Layer 4 · Whether 1 matches 3
The judgement. Name the specific sentence and the specific row that disagree.

### Reproduction
Exact commands in order, from a named starting state (`drive seed --stage …` or
"built from empty like this"). The orchestrator will re-run these.

### Blast radius
Who is hurt and how they would find out. "Nobody would" is the worst answer and
the most important one to write down.

### What I ruled out
The explanations you considered and killed, and how. If you checked whether a
guard upstream already handles it, say so.

### CLEAN
What you drove on this surface and found NO defect in.
```

**Require the CLEAN block even when there are no findings.** "Drove the whole coach ladder
with families on it, no defect found" is the only thing that turns "assume broken" into
"known good", and it is the line agents skip.

**Require Layer 3 even when the explorer is sure.** Three times last pass a finding
evaporated at exactly this step: eight failing checks were one defect re-reported; a
family-privacy leak was the query tool reading as the service role; a "slow query" returns
in ~200ms in isolation.

### Orchestrator rules

- **Re-run the reproduction before fixing.** Explorers report confidently and are sometimes
  wrong. Two of last pass's sub-agent findings were real and `certain`; several others
  refuted on inspection. The reproduction block exists so this costs one command.
- **Judge the root from the evidence, not the summary.** Layer 2 is usually where the root
  is visible — a plan refused twice for a shape error, a read that failed on a guessed
  column, a claim that no tool call backs. The class of failure is rarely what the explorer
  named it.
- **Fix the root, not the instance.** The four tests are in `DRIVING.md`. Test 4 is not
  optional: say what each fix takes away, or you have not finished it. Last pass, one fix
  created a new gap (class names are now unique among open classes, and nothing can close a
  class) — that is fine, but it has to be written down.
- **One fix batch, then one probe.** Never edit product code while a verification probe is
  running; the dev server hot-reloads and your run becomes a moving target.
- **Aim the next explorer at what has never run** (§5), not at what just broke.
- Keep a note of which build each finding came from, so a later finding is not silently
  attributed to the pre-fix product.

---

## 4 · Work on this first, in this order

The previous list is done — money back-half, per-academy clock, `tally_line.dedupe_key`,
`close_class`. `NEXT.md` argues each of these; this is the order.

1. **A genuinely unknown number is dropped without trace.** No `message` row, no `job`, no
   `audit_entry`, in any of seven academies — a lost enquiry is undetectable by
   construction, on the acquisition path. "Signup is the operator's" is a real decision and
   it does not require silence.
2. **§14.8's automatic escalation on refund, complaint and safety language.** No runtime
   enforcement; `handoff` has fired 0 times in 464 tool calls. The refusal path now performs
   its own escalation and proves the shape works — copy it rather than adding prompt text.
3. **R10's fact half, in shadow mode.** Still the most open root. Log what it would block,
   block nothing, drive, read the log.
4. **The watch overshoot.** 113 pending `agent_task` rows, ~1 per turn, each a model turn
   later. One watches the word "replayed", which is a driver artifact.
5. **The register as a Flow**, and the coach/client onboarding Flows that do not exist.

**Personas, judged by hand-driving each one:** admin `nearly`, coach `not-ready`, parent
`not-ready`, prospect `not-ready`. The worst symptom in three of the four was one root and
it is fixed; the verdicts stand until somebody re-drives them.

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

**R5 is closed** — idempotency is keyed on ids under a unique index (0023), not on prose.
**R9's self-inflicted one is closed** — `close_class` exists.

**R7 fired four more times this pass and is the one to watch**: the evidence tool answering
`0` to every cross-tenant question; a message step whose recipient resolved to nobody being
dropped with no row (so `AD-NEW-TRIAL` had never been sent, ever); a plan write matching
zero rows vanishing from the receipt; a register markable for a class that had not happened.
Every one read as success.

**R8 is the live one.** `handoff` at 0/464 while a parent was told "I've noted it" about a
row that never changed, and 113 pending watches at the other extreme. `recall` was deleted
(0/464, every fact already ships in the hot set); `view` sits at 6.

**R10 is untouched** and is the most open root.

Carried forward, still true and unfixed: `move_class` announces a whole class while moving
one slot; `reschedule_session` accepts a past time (`mark_attendance` no longer does — the
same one-line comparison); `client_cancel` declares `scope: 'session' | 'series'` and never
reads it. **`plan.ts`'s `asService` exception-discarding claim was REFUTED** by an
adversarial reader this pass — do not spend a fix on it without re-deriving it first.

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

# Working in this repo

A WhatsApp-native manager for Indian coaching businesses. The chat is the interface. This file
is orientation for an agent — the shortest path to being useful here, and the traps that waste
the most time. It is not the spec: [`docs/product-spec.md`](./docs/product-spec.md) is the
authority on behaviour, and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) on where a thing
belongs.

## Read before you change anything

| If you are about to… | Read first |
| --- | --- |
| analyse a bad run, or propose *any* fix | [`docs/MECHANISMS.md`](./docs/MECHANISMS.md) — what the brain **already does**. Generated from `@mechanism` tags; read it before `lib/`, which is ~209k tokens and will not fit |
| add a line to the model's prompt | [`docs/PREFIX-RULES.md`](./docs/PREFIX-RULES.md) — and its graveyard, before re-adding something removed twice |
| understand how a turn actually runs, or which **stage** a defect belongs to | [`docs/ANATOMY.md`](./docs/ANATOMY.md) — the order things run in, end to end. `MECHANISMS.md` is an inventory and has no time in it |
| decide where a fix belongs | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the layers, and the trap list |
| change what the product does | [`docs/product-spec.md`](./docs/product-spec.md) |
| test, drive, or judge a run | [`docs/DRIVING.md`](./docs/DRIVING.md) — the instruments over one spine, what a run costs before you start it, and how to read one back — then [`docs/JUDGING.md`](./docs/JUDGING.md) |
| touch anything in `scripts/` | [`scripts/README.md`](./scripts/README.md) — the instruments and the checks, indexed |
| record something that broke | [`findings/`](./findings/README.md) — [`OPEN.md`](./findings/OPEN.md) is the status board, [`DECIDED.md`](./findings/DECIDED.md) is what was deliberately not fixed |
| deploy | [`docs/DEPLOY.md`](./docs/DEPLOY.md) |

## The house rules

These are the conventions that are load-bearing and not guessable from the code.

**Enable the model; do not fence it.** The working theory is *a capable model, told the
truth*. A defect is the **instrument**, an **information failure**, or a **capability gap** —
checked in that order, and fixed at the class, never the instance in front of you. A paragraph
of doctrine fixes nothing; a gate is a last resort that must prove a hit rate on a recorded
run before it refuses anything. [`findings/README.md`](./findings/README.md) carries the full
version.

**Nothing in an instrument scores anything.** The instruments record; a person or a judge model
writes the verdict into `judgement.json` beside the record. Deterministic pass/fail was removed
from the drives deliberately — a pattern-matcher read 0 overclaims on a run containing exactly
one. If you are tempted to add a `check` closure that decides whether a turn was good, read
`docs/JUDGING.md` first.

**Record everything, untruncated.** There is no flag to record less. A report that elides the
model's reasoning, its SQL, or the rows it touched cannot answer the question the run was for.

**One run, one directory, one record shape.** Every instrument appends one line per turn to
`.probe/runs/<UTC-minute>-<suite>-<tok>/turns.jsonl` (`scripts/_capture.ts`); `record.json` and
every other view in that directory is derived from that log (`scripts/_derive.ts`), and one
reader — `scripts/report.mjs` — opens it. Per-suite extras (`ladder.md`, `week.md`, `score.md`) go
*inside* that directory. Do not give an instrument its own corner and its own renderer; that
is how six report generators grew, and they are gone.

**Check `MECHANISMS.md` before proposing anything.** The brain does not fit in a context
window — `lib/agent` alone is ~209k tokens — and the day that was ignored, analysis kept
re-proposing mechanisms that had already shipped (20 Aug 2026; `findings/README.md` has the
story). The scan tier of [`docs/MECHANISMS.md`](./docs/MECHANISMS.md) answers *"does something
already handle this?"* before a file is opened.

**And `ANATOMY.md` for when it runs.** The index is a list of parts and has no time in it, so it
cannot say that a mechanism fires two stages after the one your defect is in. That is its own
failure mode: a fix that is right in the abstract, landed where it is already too late.
[`docs/ANATOMY.md`](./docs/ANATOMY.md) is the sequence — arrival, context, rounds, a write, a
send, the exits, reflection, the record — with the stage each class of defect belongs to. Order
here is load-bearing, not presentation: the recovery ladder's worst bug was two correct
mechanisms in the wrong sequence. `npm run check:anatomy` is what keeps it from drifting —
and it checks symbols, paths and the ladder, **not prose**: if your change moves WHEN
something runs (a gate reordered, a stage added, an exit re-sequenced, a tool added or
re-gated), updating `docs/ANATOMY.md` is part of that change, in the same commit. The spine
files (`loop.ts`, `tools.ts`, `context.ts`, `plan.ts`, `send.ts`) say so at the top. Its
"short version" section is the plain-words tier; read at least that before touching the brain.

**A finding is retired by a mechanism, not by a paragraph.** The four steps, in order:

1. **Build the mechanism** — not a line of doctrine; see the rule above this one.
2. **Tag it beside the code** with an `@mechanism` block comment — the exact grammar is in
   [`findings/README.md`](./findings/README.md).
3. **Move its row** from `findings/OPEN.md` to `findings/CLOSED.md`, one line, with the date.
4. **Regenerate the index:** `npm run mechanisms`.

Skip a step and a gate fails: `check:mechanisms` holds the index against the tags and every
`Closes` clause against the ledger; `check:findings` holds the ledger against itself.

**Money is in rupees.** This is an INR-billing product. `lib/pricing.ts` is the one place that
converts.

**The leading underscore in `scripts/` means "not a command."** Underscored files are shared
modules — `scripts/README.md` indexes them — and `_findings.ts` is the one exception that runs.

## The production-readiness loop

The working process as of 23 Aug 2026, and the mindset it encodes. The failure it replaces is
**using the drive for iteration** — fix one thing, drive, see the instance gone, call it good.
That loop patches instances, manufactures false positives, and closed twenty-nine findings whose
classes kept firing. The drive is a *measurement*, never a test of one patch.

1. **Drive whole.** A month, both worlds when you can afford it — `eager-owner` (a motivated
   owner; measures whether the product can succeed at all) and `ace-tennis` (hard mode; measures
   robustness). `npm run watch` alongside, so a drive that stops measuring is stopped.
2. **Read whole and judge.** Every turn, `report.mjs --text`, verdict into `judgement.json`
   (`docs/JUDGING.md`). An unjudged run has no trend line.
3. **Classify every problem** — instrument first, then information, then capability (the house
   rule above). Fix the CLASS, at the root, never the instance in front of you.
4. **Line-review the fixes before the next drive.** On 23 Aug a five-agent review of one
   window's shipped, gate-green, well-argued code found three mechanisms that could never fire
   (an unbuilt sweep two comments referenced, a supersede the runner ignored, a count whose
   join RLS silently emptied) and four ways money could be miswritten. Gates prove shape, not
   life; a review between fixing and driving is cheaper than a drive that measures dead code.
5. **Repeat until the exit bar**, which is a bar and not "no issues": the money loop completes
   (billed → paid → reconciled), no seat departs for a product-caused reason, zero
   blocker-severity findings, and no CLOSED finding's class fires.

Two standing cautions. **Never wipe the database to reset** — the live sender row carries the
Meta credentials and approved templates, and old runs' worlds are `npm run truth`'s second
column; `npx tsx scripts/sim.ts gc --hours 0` reaps sandbox worlds cleanly. And **archive
`.probe` contents by moving them into `.probe/archive/<dated>/`**, keeping the directory
skeleton `check:layout` describes.

## Commands

```bash
npm run dev                 # the emulator — the product surface in this build
npm run typecheck           # tsc --noEmit; covers scripts/ too
npm run db:push             # migrations

npm run drive               # be a person talking to the bot, one command at a time
npm run probe               # the scripted lifecycle arc, one academy per model — ten suites
npm run ask                 # interrogate the prefix, toolless — the derivable ceiling
npm run probe:sql           # the SQL ladder
npm run sim          # a simulated business; personas who see only their phone
npm run sim -- --world settled-tennis      # blank is the default; worlds/ holds the rest
npm run sim -- --seat-model claude:haiku   # seats are Claude; DeepSeek is the brain only
npm run sim -- --preset smoke        # one day, one window: ~₹1.30 and 4-7 min
npm run sim -- --days 7 --budget-min 40   # simulated length, then the real stop
npm run sim -- gc --hours 6           # reap this driver's stale worlds
npm run ab -- --variant doctrine=<file>      # the same week twice, one thing changed
npm run ab -- --variant ref=<sha> --dry-run  # prepare and hash both arms, spend nothing
npx tsx scripts/live.ts open --days 7        # the human seat, blindfolded

npm run watch               # is the drive still measuring anything? stop it before it wastes a month
npm run runs                # every recorded run, newest first
npm run report              # render the newest run as one standalone page
npm run report -- --text --from 40 --to 80   # the same run as plain text, whole, for a reader
npm run findings            # which open findings no instrument stages
npm run mechanisms          # regenerate docs/MECHANISMS.md from the @mechanism tags

npm run check               # every static gate below in one command — run it before you finish
npm run verify:static       # five absolutes, as a build failure
npm run check:layout        # this repo's own structure indexes still describe it
npm run check:findings      # the ledger agrees with itself about what is open
npm run check:anatomy       # docs/ANATOMY.md still describes the order the code runs in
npm run check:mechanisms    # docs/MECHANISMS.md still matches the tags in lib/
npm run check:schema-doc    # SCHEMA_DOC still describes the real database
npm run check:rls-doc       # the permission grid still describes the real policies
```

## Traps

**Check `TRANSPORT` before driving.** With `TRANSPORT=cloud`, a drive takes the Meta Cloud path
and hard-fails at the credential gate — the run measures nothing. Prefix `TRANSPORT=emulator`
unless you specifically mean to exercise the live sender.

**`npm run db:push` deadlocks while the dev server is running.** `0002_schema.sql` cannot take
its lock on `sim_clock`. Stop the server, or apply the one new migration directly.

**A green tool result is not evidence.** Read the rows back. `node scripts/q.mjs` asks the
database as the service role with the tenant GUC set; `docs/DRIVING.md` names this as the trap
that makes a bad run look like a good one.

**Sessions can share this working tree.** Another agent may be editing the same files. Do not
`git checkout` a branch here — use a worktree — and do not stage a file you did not dirty.

**`.probe/` is gitignored and unrecoverable.** Nothing in it is version controlled. Archive,
never delete: the old runs are the baseline every "did the edit help?" reading is measured
against.

## Layout

`README.md`'s Layout block is the map, and `npm run check:layout` asserts every path in it
still exists — along with every file named in `scripts/README.md` and `.probe/README.md`. If
you add a script or a top-level directory, that check is what tells you which index to update.

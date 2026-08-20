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
| test, drive, or judge a run | [`docs/DRIVING.md`](./docs/DRIVING.md), then [`docs/JUDGING.md`](./docs/JUDGING.md) |
| touch anything in `scripts/` | [`scripts/README.md`](./scripts/README.md) — 49 files, four jobs |
| record something that broke | [`findings/`](./findings/README.md) — [`OPEN.md`](./findings/OPEN.md) is the status board (generated), [`DECIDED.md`](./findings/DECIDED.md) is what was deliberately not fixed |
| deploy | [`docs/DEPLOY.md`](./docs/DEPLOY.md) |

## The house rules

These are the conventions that are load-bearing and not guessable from the code.

**Behaviour is not fixed by prompting.** Every finding in the ledger names a *structural*
home. The repo's own evidence is that instructions do not close behavioural classes — so a
defect gets a mechanism, not a paragraph of doctrine. `findings/README.md` says
this in its own header, and it means it.

**Nothing in an instrument scores anything.** The instruments record; a person or a judge model
writes the verdict into `judgement.json` beside the record. Deterministic pass/fail was removed
from the drives deliberately — a pattern-matcher read 0 overclaims on a run containing exactly
one. If you are tempted to add a `check` closure that decides whether a turn was good, read
`docs/JUDGING.md` first.

**Record everything, untruncated.** There is no flag to record less. A report that elides the
model's reasoning, its SQL, or the rows it touched cannot answer the question the run was for.

**One run, one directory, one record shape.** Every instrument writes
`.probe/runs/<UTC-minute>-<suite>/record.json` (`scripts/_capture.ts`), and one reader —
`scripts/report.mjs` — opens it. Per-suite extras (`ladder.md`, `week.md`, `score.md`) go
*inside* that directory. Do not give an instrument its own corner and its own renderer; that
is how six report generators grew, and they are gone.

**Check `MECHANISMS.md` before proposing anything.** On 20 Aug 2026 `npm run findings`
reported 38 of 43 findings open; **29 of those had shipped mechanisms** and the ledger said so
in a table nothing parsed. Analysis kept re-proposing `context_query` validation (F-AP),
message `stateKey` (F-AN) and event-text filling (F-AZ) — all built. The brain does not fit
in a context window — `lib/agent` alone is ~209k tokens — so "read the brain and understand it
is sophisticated" is not an instruction anyone can follow. The index is what works: the scan
tier of [`docs/MECHANISMS.md`](./docs/MECHANISMS.md) is ~4k tokens and answers *"does something
already handle this?"* before a file is opened.

**And `ANATOMY.md` for when it runs.** The index is a list of parts and has no time in it, so it
cannot say that a mechanism fires two stages after the one your defect is in. That is its own
failure mode: a fix that is right in the abstract, landed where it is already too late.
[`docs/ANATOMY.md`](./docs/ANATOMY.md) is the sequence — arrival, context, rounds, a write, a
send, the exits, reflection, the record — with the stage each class of defect belongs to. Order
here is load-bearing, not presentation: the recovery ladder's worst bug was two correct
mechanisms in the wrong sequence. `npm run check:anatomy` is what keeps it from drifting.

**A finding is retired by a mechanism, not by a paragraph.** The four steps, in order:

1. **Build the mechanism.** Not a line of doctrine — see the rule above this one.
2. **Tag it beside the code**, in a block comment on the thing itself:
   ```
    * @mechanism <realSymbol> — <what it does, and the class of defect it retires>.
    *   <continuation indented, same comment block, no blank comment line inside>
    *   Closes F-XX.
   ```
   The name must be a symbol that really appears in that file. `Closes F-XX` is optional and is
   checked against the ledger.
3. **Move its row** from `findings/OPEN.md` to `findings/CLOSED.md`, one line, with the date.
4. **Regenerate the index:** `npm run mechanisms`.

Skip a step and a gate fails. `check:mechanisms` refuses an index that does not match the tags, a
tag naming a symbol that is not there, or a `Closes` clause for a finding the ledger still calls
open. `check:findings` refuses a code that is in both `OPEN.md` and `CLOSED.md`, used twice in
either, or named in `DECIDED.md` without being open. That is what stops them drifting apart, and
drifting apart is what cost the twenty-nine.

**Money is in rupees.** This is an INR-billing product. `lib/pricing.ts` is the one place that
converts.

**The leading underscore in `scripts/` means "not a command."** `_capture.ts`, `_env.ts`,
`_world.ts`, `_personas.ts`, `_ramp.ts`, `_danger.ts`, `_record-from-probe.ts` are shared
modules. `_findings.ts` is the one exception and it runs.

## Commands

```bash
npm run dev                 # the emulator — the product surface in this build
npm run typecheck           # tsc --noEmit; covers scripts/ too
npm run seed                # fixtures
npm run db:push             # migrations

npm run drive               # be a person talking to the bot, one command at a time
npm run probe               # the scripted lifecycle arc, one academy per model
npm run ask                 # interrogate the prefix, toolless — the derivable ceiling
npm run probe:sql           # the SQL ladder
npm run drive:week          # one settled week with standing jobs firing

npm run runs                # every recorded run, newest first
npm run report              # render the newest run as one standalone page
npm run findings            # which open findings no instrument stages
npm run findings -- --write # regenerate findings/OPEN.md, the status board
npm run mechanisms          # regenerate docs/MECHANISMS.md from the @mechanism tags

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

# Working in this repo

A WhatsApp-native manager for Indian coaching businesses. The chat is the interface. This file
is orientation for an agent — the shortest path to being useful here, and the traps that waste
the most time. It is not the spec: [`docs/product-spec.md`](./docs/product-spec.md) is the
authority on behaviour, and [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) on where a thing
belongs.

## Read before you change anything

| If you are about to… | Read first |
| --- | --- |
| add a line to the model's prompt | [`docs/PREFIX-RULES.md`](./docs/PREFIX-RULES.md) — and its graveyard, before re-adding something removed twice |
| decide where a fix belongs | [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the layers, and the trap list |
| change what the product does | [`docs/product-spec.md`](./docs/product-spec.md) |
| test, drive, or judge a run | [`docs/DRIVING.md`](./docs/DRIVING.md), then [`docs/JUDGING.md`](./docs/JUDGING.md) |
| touch anything in `scripts/` | [`scripts/README.md`](./scripts/README.md) — 47 files, four jobs |
| record something that broke | [`findings/`](./findings/README.md) |
| deploy | [`docs/DEPLOY.md`](./docs/DEPLOY.md) |

## The house rules

These are the conventions that are load-bearing and not guessable from the code.

**Behaviour is not fixed by prompting.** Every finding in the ledger names a *structural*
home. The repo's own evidence is that instructions do not close behavioural classes — so a
defect gets a mechanism, not a paragraph of doctrine. `findings/conversation-rules.md` says
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

**Money is in rupees.** This is an INR-billing product. `lib/pricing.ts` is the one place that
converts.

**The leading underscore in `scripts/` means "not a command."** `_capture.ts`, `_env.ts`,
`_world.ts`, `_personas.ts`, `_danger.ts`, `_record-from-probe.ts` are shared modules.
`_findings.ts` is the one exception and it runs.

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

npm run verify:static       # four absolutes, as a build failure
npm run check:layout        # this repo's own structure indexes still describe it
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

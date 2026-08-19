# scripts/

Forty-eight files, four jobs. This index exists because the folder had grown thirteen files
that nothing referenced and six report generators that rendered the same evidence six ways.

`npm run check:layout` asserts that every file here is named below and that every file named
below exists, so this index cannot drift again the way it had: it said "Forty files" against
47, and eleven scripts appeared in neither it nor `package.json`.

## 1 · The instruments — drive the product, record everything, judge nothing

Every one of these records to `.probe/runs/<UTC-minute>-<suite>/record.json` in one shape
(`_capture.ts`), flushed after every turn, with **no flag to record less**. None of them
scores anything. The verdict is written by a reader into `judgement.json` beside the
record — [`../JUDGING.md`](../docs/JUDGING.md) is how.

| | |
|---|---|
| `probe-ask.ts` | `npm run ask` — interrogate the prefix, toolless. Measures the ceiling: what the context makes derivable. Takes a scenario id, or **any question you type**: `npm run ask -- "what if she pays twice?"`, `--who coach`, `--list`. |
| `probe-model.ts` | `npm run probe` — the real loop through a scripted lifecycle arc, in a fresh academy per model. Suites: `arc`, `fo`, `fq`, `adv`, `real`, `tennis`, `stress`. |
| `probe-sql.ts` | `npm run probe:sql` — the SQL ladder, six tiers. Can the model actually write the statements? |
| `drive-week.ts` | `npm run drive:week` — one settled week, personas balanced by construction, standing jobs firing on their own schedule. |
| `drive.ts` | `npm run drive` — be a person talking to the bot, one command at a time. Posts to the emulator API a human uses, so there is no second code path. |
| `live.ts` | The seat instrument. A tester is handed one persona and sees only what that persona's phone shows — `brief`, `say`, `read`. [`SEAT.md`](./SEAT.md) is the brief they are given. |

`drive` runs the turn inside the dev server, so its full-visibility switch lives there:

```bash
PROBE_FULL_TRACE=1 npm run dev
```

## 2 · What has already broken

`_findings.ts` (`npm run findings`) reads the ledger in `../conversation-rules.md` — it does not
copy it — and cross-references every `F-xx` against the instruments, so the table answers one
question nothing else could: **which of the things that have already broken does no instrument
even ask about?** `--open` and `--bare` narrow it.

The instruments do *not* share a scenario list, deliberately. `probe-ask` asks "walk me through
what you would do" with no world; `probe-sql` posts a sentence into a real academy; `probe-model`
puts it at a point in a lifecycle where the rows exist. One text cannot serve all three without
becoming the worst of the three, and the setup — most of the work — has nothing in common. What
they share is the finding, and a `finding:` field on a case is how a stage is declared.

## 3 · Reading a run

| | |
|---|---|
| `report.mjs` | `npm run report` — the newest run as one standalone page. `npm run runs` lists them. |
| `judge-feed.mjs` | The inside of a turn, rendered for a person to read *while the drive is still walking*. |
| `judge.mjs` | The same job done by a judge model when there is nobody free to read. Writes the same `judgement.json` a person writes, deliberately: the two are interchangeable. |
| `judge-slice.mjs` | ONE turn, printed in the order `JUDGING.md` says to read it — for when the failure is skipping ahead. |
| `record-from-probe.ts` | `npm run record:backfill` — writes `record.json` for a `probe-model` run that predates the instrument writing one itself, and for a thinking sweep, where you pick the arm. |
| `latency-report.py` | A one-off renderer for the 18 Aug latency page. **Unmaintained:** the only Python here, it hardcodes its input and output paths and lifts its stylesheet out of a sibling report by regex. Port it into `report.mjs` or delete it; do not extend it. |

## 4 · Static checks — of the product's code, not of the model's behaviour

These assert things about code and data that are true or false regardless of what any model
said. That is why they survived the removal of the behavioural checks: none of them reads
prose.

| | |
|---|---|
| `verify-static.mjs` | Five absolutes, as a build failure rather than a note. |
| `rls-check.mjs` | The security boundary: cross-tenant and cross-role reads return zero rows. Seed a fixture first, or it skips its real sections and still reports 0 failed. |
| `check-schema-doc.ts` | Does the schema block still describe the real database? |
| `check-rls-doc.ts` | Does the permission matrix still describe the real policies? |
| `check-world.ts` | Is the driven world internally consistent? |
| `check-clash.ts` | Double-booking detection, against the real tables. |
| `check-layout.ts` | `npm run check:layout` — do this repo's own indexes still describe this repo? Reads no database, so it is safe anywhere. |
| `check-attendance-bills.ts` | F-BA: does an attendance row imply the money it owes? |
| `check-partial-period.ts` | F-I: does "Always pro-rate" pro-rate anything? |
| `check-roster-scale.ts` | F-R: where does `app.session_roster` stop answering? |
| `check-lint.mts` | Does the lint pass leave a correct message alone? |
| `check-repair.mts` | Does anything machine-shaped survive to a person's screen? |
| `check-steps.mts` | Does a rejected plan tell the model enough to fix it? |
| `check-billing-keys.mts` | Do the two writers of a §6.4 money rule still agree? |
| `check-duplicate-charges.mts` | Has any family been billed twice for one thing? |
| `check-wa-text.tsx` | Does the pane render WhatsApp's markup the way WhatsApp does? |
| `verify-invariants.mjs`, `verify-plan-tap.mjs`, `smoke.mjs` | End-to-end over the running dev server. |

## 5 · Operating the thing

| | |
|---|---|
| `seed.ts`, `db-push.ts`, `apply-migrations.mjs` | Fixtures and migrations. |
| `q.mjs` | Ask the database a question as the service role, with the tenant GUC set. |
| `wa-cloud.ts` | `npm run wa` — the WhatsApp Cloud setup surface. |
| `probe-surface.ts` | `npm run surface` — everything the model is shown, in one greppable file. |
| `probe-prefix.ts`, `probe-prefix-tokens.ts`, `probe-ceiling.ts` | What the prefix costs, in characters, in real tokens, and in tool declarations. |
| `guard-value.ts` | What each runtime guard has actually caught. |
| `ops-cookie.mjs` | How a script gets through the ops gate. |
| `_env.ts`, `_danger.ts`, `_capture.ts`, `_world.ts`, `_personas.ts`, `_ramp.ts`, `_record-from-probe.ts`, `_findings.ts` | Shared. Leading underscore means "not a command" — `_findings.ts` is the exception, and runs. `_capture.ts` owns the one record shape; `_record-from-probe.ts` converts `probe-model`'s per-arm files into it. `_ramp.ts` overlays `_personas.ts`'s `life` with the five-tier ramp, under `SIM_RAMP=1`. |

---

## What was removed, and why

**Six report generators** — `adv-report`, `arc-report`, `fo-report`, `sql-report`,
`stress-report`, `tennis-report`, ~250KB — plus `_probe-runs.mjs` which only they used. They
shared a stylesheet by copy and nothing else, so a thing worth showing had to be written six
times and was usually written once: `arc-report` showed the model's reasoning, `sql-report`
showed the statements, neither showed both, and the turn where those two disagree is the turn
worth reading. One record shape means one reader.

**`probe-stress.ts`** — `probe-ask` under load, unreferenced by anything.

**`probe-family.mjs`, `probe-readonly.mjs`, `probe-session.mjs`** — early RLS smoke probes,
superseded by `rls-check.mjs` and by the drives themselves.

**`inspect.mjs`** — ad-hoc, unreferenced, superseded by `q.mjs`.

**`check-claims.mts`** — imported `unsupportedClaims` from `lib/agent/tools.ts`, which no
longer exists. It tested the past-tense verb guard, and that guard was deleted for the reason
every pattern-over-prose in this repo has been deleted: it read **0** overclaims on a drive
containing exactly one.

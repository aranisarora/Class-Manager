# scripts/

Sixty-seven files, four jobs. This index exists because the folder had grown thirteen files
that nothing referenced and six report generators that rendered the same evidence six ways.

`npm run check:layout` asserts that every file here is named below and that every file named
below exists, so this index cannot drift again the way it had: it said "Forty files" against
47, and eleven scripts appeared in neither it nor `package.json`.

## 1 · The instruments — drive the product, record everything, judge nothing

Every one of these records to `.probe/runs/<UTC-minute>-<suite>-<tok>/` in one shape
(`_capture.ts`) — a line appended to `turns.jsonl` per turn, and `record.json` derived from
that log after every one of them (`_derive.ts`) — with **no flag to record less**. None of them
scores anything. The verdict is written by a reader into `judgement.json` beside the
record — [`../JUDGING.md`](../docs/JUDGING.md) is how.

| | |
|---|---|
| `probe-ask.ts` | `npm run ask` — interrogate the prefix, toolless. Measures the ceiling: what the context makes derivable. Takes a scenario id, or **any question you type**: `npm run ask -- "what if she pays twice?"`, `--who coach`, `--list`. |
| `probe-model.ts` | `npm run probe` — the real loop through a scripted lifecycle arc, in a fresh academy per model, writing the standard record directly. Ten suites: `arc`, `f-o`, `f-q`, `adv`, `real`, `tennis`, `stress`, `stress-week`, `findings`, `holistic`. `--stage`, `--persona`, `--case` and `--limit` cut one; a drive flag it cannot honour is refused by name, with what to use instead. |
| `probe-sql.ts` | `npm run probe:sql` — the SQL ladder, six tiers. Can the model actually write the statements? Since the thirteen wrapper operations went, nearly every write in the product is SQL the model wrote itself, and nothing else here measures whether it can. |
| `truth.ts` | `npm run truth` — what the WORLD did in a week, beside what the product ended up believing. Two columns and no third: `truth.json` on one side, `app.session_roster` and `session.status` on the other. It writes no verdict, for the same reason nothing else here does — a register that says a child was present when the world says they were ill is at least four different things and only one is a defect. `--run <dir>` picks one, `--all` shows the registers that agree as well. |
| `sim.ts` | `npm run sim` — the agent week. Windows drive it; the seats in a window run CONCURRENTLY, one child process each (`_seat-worker.ts`), because `captureSql` keeps module-level state and two turns in one process blend their evidence. The clock walk and every drain are recorded as turns of their own. `--preset smoke` is one day and one window; `--budget-min` / `--budget-inr` stop it cleanly at a window boundary with a complete record. `gc --hours N` reaps the worlds this driver left behind, and only those. `--events <ref>` and `--chaos <rate>` give the week a physical world to happen in — see `_events.ts` below. |
| `ab.ts` | `npm run ab` — the same week twice, one thing changed. `--variant doctrine=<file>` swaps the prefix, `--variant ref=<sha|branch|checkout>` swaps the mechanisms; every other flag belongs to `_drive-config.ts` and is given to BOTH arms, so the arms differ by one file and nothing else. One config, one seed, one pinned model, resolved once and handed to both. Each arm is a whole `sim` child process in a root of its own, because `stablePrefix()` memoises and two prefixes cannot coexist in one node process. Writes a manifest per arm and prints the two side by side in counts. **No difference column — a difference carries a sign, and the sign is the verdict.** `--repeats N` buys a second sample; `--dry-run` prepares, hashes and prints, and spends nothing. |
| `drive.ts` | `npm run drive` — be a person talking to the bot, one command at a time. Posts to the emulator API a human uses, so there is no second code path. `npm run drive -- help` prints the subcommands, generated from the implemented cases. |
| `live.ts` | The seat instrument, for a person rather than an agent. A tester is handed one persona and sees only what that persona's phone shows — `brief`, `say`, `tap`, `inbox`, `note`, `diary`. The seat itself is `_seat.ts`, shared with the agent week so the blindfold cannot exist in two copies. [`SEAT.md`](./SEAT.md) is the brief they are given. |

[`../docs/DRIVING.md`](../docs/DRIVING.md) is how to use these without wasting a week: what a run
costs, which flag sets the simulated length and which sets the real stop, and how to read the
record back.

`drive` runs the turn inside the dev server, so its full-visibility switch lives there:

```bash
PROBE_FULL_TRACE=1 npm run dev
```

## 2 · What has already broken

`_findings.ts` (`npm run findings`) reads `../findings/OPEN.md` and `../findings/CLOSED.md` — it does not
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
| `judge.mjs` | The same job done by a judge model when there is nobody free to read. Writes the same `judgement.json` a person writes, deliberately: the two are interchangeable. `--run <dir>` judges the record and sees the SQL, the rows and what the model was told; `--academy` tails a live drive and sees less, and says so. |
| `_judge-text.mjs` | One turn as plain text, shared by `judge.mjs` and `judge-slice.mjs` so the two cannot drift apart about what a turn is. Not a command. |
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
| `check-findings.ts` | `npm run check:findings` — does the ledger agree with itself? Catches a code claimed both open and closed, a code in a table with no heading, one code naming two findings, and a heading whose state contradicts its table row. Reads one markdown file. |
| `check-anatomy.ts` | `npm run check:anatomy` — does [`ANATOMY.md`](../docs/ANATOMY.md) still describe the order the code runs in? Every symbol it names must be in the file it names beside it, and the send ladder must still be the ladder the send path actually runs. Reads no database. |
| `build-mechanisms.ts` | `npm run mechanisms` writes `docs/MECHANISMS.md` from the `@mechanism` tags in `lib/`; `npm run check:mechanisms` fails when the two diverge. The index an analysis agent reads *instead of* the brain — 2k tokens against 209k. A `Closes F-XX` clause is checked against the ledger. |
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
| `_env.ts`, `_danger.ts`, `_capture.ts`, `_derive.ts`, `_drive-config.ts`, `_world.ts`, `_personas.ts`, `_ramp.ts`, `_record-from-probe.ts`, `_seat.ts`, `_persona-agent.ts`, `_seat-worker.ts`, `_world-spec.ts`, `_arrivals.ts`, `_events.ts`, `_findings.ts` | Shared. Leading underscore means "not a command" — `_findings.ts` is the exception, and runs. `_capture.ts` owns the one record shape and appends one line per turn to `turns.jsonl`; `_derive.ts` rebuilds everything else in the run directory from that log, so two seats can write at once and nothing has to read 800KB back to add a turn. `_drive-config.ts` resolves how long, how many, who and how much — preset, then `--config` file, then flags — and refuses an unknown flag rather than running the default under its name. `_record-from-probe.ts` converts `probe-model`'s per-arm files into the record shape. `_ramp.ts` overlays `_personas.ts`'s `life` with the five-tier ramp, under `SIM_RAMP=1`. `_seat.ts` is the seat itself — blindfold, phone, clock walk and turn — extracted from `live.ts` so the human seat and the agent week cannot drift apart. `_persona-agent.ts` is the person in the seat when nobody is sitting in it: it turns a persona's goals into the next thing they type, given only what their phone shows. `openSeatModel` holds ONE `claude` process per person for the whole week, fed over stdin — the thread between Tuesday and Wednesday is the point, and it stopped paying ~4s of process start on every message (10.3s median a move became 6.4s). Each turn still sends only what arrived since they last looked, so the week is reachable and never re-read. `_seat-worker.ts` is one persona in one OS process for the length of a week, spawned by `sim.ts` over node IPC — it refuses to run without an IPC channel. `_world-spec.ts` is the declarative world: one JSON object describing an academy at the moment onboarding finishes, `validateSpec` holding every rule and default so the English description of a world and the rows it becomes cannot disagree, and `buildWorld` taking nothing but a normalised spec. `worlds/` holds the hand-written ones. `_arrivals.ts` is the same spec read back OUT of a live academy, so somebody the owner created on Wednesday gets a brief derived from their real rows and a seat for the rest of the week — a fixed roster meant the product wrote to phones nobody was reading, which in a record cannot be told from being ignored. `_events.ts` is what happens TO the business during the week: six verbs (`absent`, `present`, `washout`, `away`, `lag`, `note`), a seeded `chaos` block, and the ground truth of who was physically at each session — which nothing had before, so the register the product asked a coach for was answered out of the seat model's imagination, and §6.4 bills off attendance. It writes NOTHING to the database, deliberately: the product has to learn a fact from somebody who types it, and `truth.json` beside the record is what lets `npm run truth` show the two accounts side by side. |

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

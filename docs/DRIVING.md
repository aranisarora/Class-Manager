# Driving

Driving is finding out what this product actually does when somebody talks to it, and then
asking the database whether what it said was true. It is the whole eval.
[`product-spec.md`](./product-spec.md) is the authority on what the product is supposed to do;
this file is how you find out whether it does, and how to find that out **without spending an
afternoon and three hundred rupees on a run you could have sized in seven minutes**.

Everything here posts to the same emulator API a human uses, so there is no second code path to
keep honest, and everything reads the ordinary tables back — `message` for what was said, `turn`
for what was thought, `audit_entry` for what changed. Nothing in any instrument knows anything
the product does not record.

---

## One spine, six instruments

There used to be six report generators rendering the same evidence six ways, and they are gone.
There is one spine now, and the instruments differ only in **who is at the phone**.

**The seat is one implementation.** `scripts/_seat.ts` holds the blindfold, the phone, the clock
walk and the turn. A person sits in it through `scripts/live.ts`; a model sits in it through
`_persona-agent.ts` and `sim.ts`. The blindfold is not a convention — it is five
predicates on one query (outbound, this contact, past this person's own cursor,
`suppressed_reason is null`, `status <> 'failed'`), and a second copy that dropped the
suppression clause would show a reader a message the real recipient never received. The reading
built on that — *"she was told and she still did not pay"* — is false in a way nothing
downstream can catch.

**The record is one shape.** Every instrument writes `.probe/runs/<UTC-minute>-<suite>-<tok>/`
through `scripts/_capture.ts`: one appended line per turn to `turns.jsonl`, and everything else
in the directory derived from that log by `_derive.ts`. There is no flag to record less.
One reader — `npm run report` — opens any of them.

**Nothing scores anything.** No instrument here computes a pass, a fail or a total. The verdict
is written by a person or a judge model into `judgement.json` beside the record, and
[`JUDGING.md`](./JUDGING.md) is how. Numbers and text are evidence; booleans are verdicts, and
verdicts do not go in records. `probe-sql`'s two runs of 17 Aug are the argument: the 13:09 run
scored 21/25 with one failure that was a grader artifact, and the 13:16 run scored 12/25 having
died at case 9 — five of the sixteen cases that executed no SQL at all *passed*, because their
checks were negative and a model that does nothing satisfies them.

| What you want to know | Instrument |
| --- | --- |
| what a week with four people in it does to this product | `npm run sim` |
| what this one sentence does, right now | `npm run drive -- say <contact> "…"` |
| what a *person* makes of the reply, with no rows to check against | `npx tsx scripts/live.ts` |
| whether the model handles a case that has broken before | `npm run probe -- --suite …` |
| whether the context makes the answer derivable at all | `npm run ask` |
| whether the model can write the SQL | `npm run probe:sql` |
| whether what the product believes matches what the world did | `npm run truth` |

Answering *"did my change help?"* is not a seventh instrument. It is two runs of one of the
above, held still by `--seed` and labelled by `--arm` — see below.

---

## Running it efficiently

This is the part that costs money, and all of it but the first costs nothing to get right.

### Start small. `--preset smoke` is the plumbing test.

```bash
TRANSPORT=emulator npx tsx scripts/sim.ts --preset smoke
```

One day, one window, two seats — read off `SCHEDULE` rather than chosen, so it drives the same
harness everybody else drives. Two measured runs, either side of the world growing from one
family and four fixtures to four families, five children and seven:

```
2026-08-20-13-28-week-cu9z   6 turns · 23 jobs · ₹1.11 · 6.4 min
2026-08-20-14-20-week-nmrq   6 turns · 38 jobs · ₹1.18 · 4.0 min
```

The second is the world as it stands. Standing jobs scale with enrolments × sessions, so the
queue work went up by two thirds while the money went up by a tenth — the jobs that grew are
cheap ones, and the turn count is set by the window rather than by the world. Wall clock is the
noisiest of the four and is not a per-run constant.

**Every rupee printed anywhere is the PRODUCT's.** The seats are Claude playing the people and
they are not what a run costs — they are what the harness pays to ask the question. They are
measured, they are in the record as `extra.run.seatInr`, and they are printed dimmed beside the
total so a seat that loops is still visible; they are never added to anything. A total that
summed both moved when the *harness* changed: the persistent seat cut seat spend by a third
while the product did exactly the same work, and a combined figure would have called that a
cheaper run. `--budget-inr` measures the product for the same reason.

Prove the plumbing on that before you spend a week. A week that dies on turn 3 because
`TRANSPORT` was wrong, or because a worktree has no `.env.local`, costs the same seven minutes
to discover and forty times as much to discover late.

The three presets are frozen in `scripts/_drive-config.ts`:

| preset | days | windows | seats |
| --- | --- | --- | --- |
| `smoke` | 1 | evening | arjun, farah |
| `day` | 1 | all | all four |
| `week` | 7 | all | all four |

### `--days`/`--windows` set the SIMULATED length. `--budget-*` set the REAL stop.

These are different questions and confusing them is the expensive mistake.

`--days 7` says *the academy lives seven days*. It says nothing about how long you sit there,
and a seven-day drive can take twenty-five minutes or ninety depending on how many rounds the
model takes and what time of day DeepSeek thinks it is.

`--budget-min 45` and `--budget-inr 250` say *stop for real after this*. They are asked
**between windows**, never inside one, so the run finishes the turn it is in, closes the window
with its drain, and writes a record that is short but **whole** — and a whole short run can
still be judged. A drive killed with Ctrl-C mid-turn cannot: `_capture.ts` attributes evidence
by a domain-time cursor, so the messages, jobs and SQL of a turn that never flushed hang off
whatever ran before it.

Neither budget aborts anything, and both stay readable afterwards. `extra.run.stoppedBy` in
`record.json` names what ended the run — `min`, `inr`, `world-gone` — or is `null` because
nothing did.

```bash
# seven simulated days, but I am leaving in forty minutes
npx tsx scripts/sim.ts --days 7 --budget-min 40
```

### Run drives in parallel. They no longer collide.

Three separate things used to make a second concurrent drive destroy the first, all silently:
start-up dropped **every** academy called `Ace Tennis Academy`; the beat text handed out a fixed
phone number, and a number known to two academies on one shared sender resolves to *neither*;
and nothing set the clock, so a run opened wherever the last one left the offset.

All three are fixed and the fixes are what make parallelism safe: the run directory carries a
four-character token, the academy carries **that same token** in its name, every phone number is
derived from the academy id, and each academy has its own `sim_clock` row. Nothing at start-up
deletes anything.

So run two. Reaping the leftovers is a command with an age threshold, not a start-up step —
a start-up reap cannot tell a dead world from one another process is driving right now:

```bash
npx tsx scripts/sim.ts gc --hours 6
```

It only matches `Ace Tennis Academy <token>`. A hand-made academy, `_world.ts`'s, or a business
somebody is using is never matched.

**And a run whose world disappears underneath it stops.** A world goes away for several
reasons — a `gc`, a seed, another shell dropping a business somebody thought was theirs, a
cancelled drive — and until 20 Aug a walk carried on regardless. The seven-day sim of that day
was cancelled part-way through day 2, lost its academy at the same moment, and walked to day 7
against a business that no longer existed: 43 of its 56 turns moved no
clock, ran no statement, sent nothing and cost ₹0, while `record.json` still said fifty-six
turns over seven days. A failed turn now asks the database one question — is this academy still
a row — and a `no` stops the run with `stoppedBy: 'world-gone'` and the record it already has.
The check costs nothing on the ordinary path: it is only asked after a turn has already failed.

### Run off-peak. It is the cheapest optimisation available.

`lib/pricing.ts` is the one converter, and DeepSeek's `peakMultiplier` is **2**. Peak is
**06:30–09:30 and 11:30–15:30 IST** (01:00–04:00 and 06:00–10:00 UTC). The same week costs
₹21–42 off-peak and double that inside those windows.

An unexplained cost difference between two runs is usually this and not a finding. It is real
wall-clock time on DeepSeek's servers — `sim_clock` moving a tenant's day does not change what a
call cost.

### Concurrency means a window costs its slowest seat, not its sum.

Seats in a window run **concurrently**, one child process each (`_seat-worker.ts`). That is
forced, not chosen: `captureSql` in `lib/agent/sql-trace.ts` keeps module-level state, so two
turns awaiting the model in one process interleave their SQL into one array and leave the other
collecting nothing. One record with another turn's statements in it, one record missing its own,
both looking complete, nothing thrown.

The consequence for the clock is the useful part: **per window the wall time is the slowest
seat, not the sum**. The measured week of 17 Aug was 28 turns and 15.4 minutes of model time
inside about 59 minutes of wall clock, and the hourly clock walk was most of the difference —
about 98 hops for a week in which 27 jobs ever ran. `walkTo` now hops to each **due job time**
instead of every hour. An agent week is projected at ₹21–42 and roughly 26–30 minutes wall
off-peak; treat that as a projection until you have one recorded.

`--concurrency N` below the number of active seats is a queue rather than a refusal: the window
still contains everybody, they just do not all speak at once.

### A mistyped flag is a hard failure, and that is the point.

`--budgetinr 250` is not a budget of 250 rupees, it is no budget at all, and the run it belongs
to looks exactly like the run it was supposed to be. So an unknown flag, a **one-dashed** flag,
an unknown window, an unknown seat, an unknown preset, an unknown chaos rate and an events file
that names nobody this world has all stop the process at second zero:

```
$ npx tsx scripts/sim.ts --daays 3

x  unknown flag --daays
   known flags: --preset --days --windows --personas --concurrency --budget-min --budget-inr --seed --model --arm --config --events --chaos --ramp --keep --drop
   A flag nothing reads is a parameter that did nothing, and the run then looks
   exactly like the run it was supposed to be. That is how an A/B ends up
   comparing two things that were never different.
```

---

## The agent week — `npm run sim`

The four personas are **agents** now. `sim.ts` used to hold twenty-eight literal
utterances and post them in order; whatever the product replied, the twelfth sentence was the
twelfth sentence. That harness could not represent the three commonest things a person does:

- **ask again**, because the first answer did not answer it
- **act on a misreading**, because the important number was in sentence four
- **go quiet and leave**

All three are outcomes and the last one is what the business cares about most. `_personas.ts`
holds the four as **goals** — who they are, how they type, what they want by Sunday, what would
make them leave, and what happens to them each day — and `_persona-agent.ts` puts a model in the
seat with nothing but what the phone shows. Its three moves are `say`, `quiet` and `giveup`;
`giveup` may carry a last message, because walking out loudly and walking out in silence are
different findings. Departures land in `extra.departures`.

**The people are not played by the product.** The brain is DeepSeek; every seat is Claude,
through the `claude` CLI, so it spends a Claude Code subscription rather than DeepSeek credit.
`--seat-model claude:haiku` is the cheaper one and `claude:sonnet` the default; a DeepSeek seat
is refused by name.

That split is a measurement decision before it is a billing one. The seats used to be the same
model as the brain, and a model reading a reply its own kind wrote parses the dense part,
tolerates the jargon, and finds the important number in sentence four. The person this product
is for does none of that, so same-model seats under-report confusion — and confusion is most of
what a week is for.

Three flags in that call are load-bearing, each measured rather than assumed. `--system-prompt`
**replaces** Claude Code's own, which opens by saying it is a CLI for software engineering:
appended instead, a persona answered a question about a tennis class with *"This session is set
up for software engineering work."* `--allowed-tools ''` keeps the blindfold, because a seat
that can read a file is not blindfolded. And the call runs in a scratch directory, or this
repo's own `CLAUDE.md` is loaded into the prompt of somebody pretending to be a parent asking
about a fever.

**The world is a file, and the default is blank.** `npm run sim` with no `--world` builds an
owner, a phone and nothing else — the moment before the setup conversation. Everything else
comes from `worlds/`:

```bash
npm run sim -- --world settled-tennis            # Ace Tennis: 4 classes, 4 families, 5 children
npm run sim -- --world worlds/multi-coach.json   # 4 coaches, 6 clients, the owner coaching
npm run sim -- --world '{"coaches":3,"clients":5}'   # inline, for a one-off
```

A world file is **what the database looks like the moment the admin finished onboarding** —
`worlds/README.md` is the format, and it is short. Two things about it are worth knowing before
you write one. Enrolment is stated on the person, never as a count on a class: a child carries
their class, and a client with no children carries their own. And any person may carry a `seat`
block — goals, voice, what happens to them on day three — so one file holds both the rows and
the people who live in them.

The facts in a persona's brief are **derived from the spec**, and only their words are written
by hand. That is not tidiness: a coach told his batch ran Monday and Thursday, in a world that
ran Monday and Wednesday, produced a turn that read as a product defect and was a harness one.
A generated brief cannot contradict the world because it is read out of it.

**And the roster is a question, not a decision.** After every window's drain, the run asks the
database who now has a phone and no seat, and seats them for the rest of the week —
`scripts/_arrivals.ts`. A coach hired on Wednesday, a family written down on Tuesday, a stranger
whose number the owner typed off the back of a receipt: each gets a brief composed out of their
own rows by the same composer that reads a spec, and a child process of their own from that
window on. The windows still ahead are re-dealt over the new roster; the ones already run are
never touched, so somebody who joined on Friday has two windows against the owner's twelve and
the record says so rather than smoothing it.

This is what makes a **blank** world drivable as a week rather than as a monologue. The seats
used to be fixed at start-up, which is right for a settled academy and silently wrong everywhere
else: every customer the owner created was a person nobody was playing, so the product sent to
twelve phones and the record showed twelve outbound messages and no replies — which cannot be
told, in the record or in any judgement made off it, from a product everybody ignored.

The three `new-*` worlds in `worlds/` are built for exactly this: an owner, a phone, and nothing
else — **including no facts**. They do not say what the classes are, what they cost, who is in
them, or what goes wrong on Thursday. The owner knows their own business and invents it as they
go, and it becomes real the moment the product writes it down. `worlds/README.md` has the
argument and the one thing it costs. What the week measures is a product meeting people who have
never seen it — including the owner.

`settled-tennis.json` is the academy this repo has always driven — **the owner also coaches**,
an `academy_admin` row and a `coach` row over one `person`, which is the business this product
is sold into and the one shape a role column cannot express. Four classes so no day is empty and
Saturday is a real fixture. Two coaches paid in two different units (₹600 per session, ₹9,000
per month) deliberately, so *"what am I paying everyone"* cannot be answered by summing one
column.

**And the week now happens in a physical world.** `worlds/` says what the business IS;
[`events/`](../events/README.md) says what the week DOES to it — and until it existed, nothing
did. Every week ran in a business where it never rained, nobody was ill, nobody went away and
everybody enrolled turned up.

The sharpest version of that hole was the register. `post_class_register` fires at
`session.ends_at` and asks the coach who was there, and **the coach seat had no way of
knowing**, so it invented one. `_personas.ts` carries the answer as prose in one persona's
`life`, hand-matched against another persona's `life` on another day, for four people, in one
world; every spec world has no `life` at all, deliberately. So in every world but the canonical
one the registers were the seat model's imagination — and §6.4 bills off attendance, which
makes it a week whose money was invented too.

```bash
npm run sim -- --world settled-tennis --events tennis-hard-week
npm run sim -- --world multi-coach --events monsoon      # one scenario, any business
npm run sim -- --events monsoon,flaky-phones             # they stack, left to right
npm run sim -- --chaos 0.15                              # a messy week, no file at all
npm run truth                                            # the world, beside what the product believes
```

Scenarios **stack** and that is most of why a library is worth having: the weather, the phones
and the school calendar are independent things that happen to one week, so four files that
compose are fifteen weeks and four that do not are four. `events` concatenate, `chaos` rates
overwrite by name left to right, and `--chaos` on the command line wins over every file — which
is what you want when you are turning one dial on a scenario somebody else wrote.

Six verbs — `absent`, `present`, `washout`, `away`, `lag`, `note` — and a seeded `chaos` block
that rolls the first four for you. A verb exists only when the harness has to do something the
seat cannot do for itself; everything else is a `note`. **Nothing writes to the database**: the
product has to learn a fact from a person who types it, or there is nothing to measure.
`events/README.md` is the format and it is short.

Two of them are properties of the phone rather than of the business, and they are the two no
seat could produce on its own. `away` **skips** the turn and records it as a skip — a customer
on holiday and a customer who read your message and put the phone down are different findings,
and dressing the first as `quiet` would put a decision nobody made into the record as though a
model had made it. `lag` holds back anything newer than *N* hours from that one look and leaves
it at the top of their next one, which is a **late** reply rather than one that never comes.

Windows drive the week and the order is load-bearing: the clock is walked **once**, then every
active seat speaks concurrently, then the queue is drained. A clock that moves while a turn is
in flight is a harness artifact, and the turn it lands in reads as the product answering a
question about a time that had not happened when it was asked. The world's own facts are fixed
at the **top of the day** and revealed **per window**: who was on court at seven has to be the
same fact when their parent's evening window comes round, but a coach is told about a class
after it has ended and not before — and a class that finishes after the last window of its day
reaches them the next morning, which is when they would really have looked.

**The queue is a turn.** Every clock walk and every drain is recorded through `queueTurn`, with
its own tokens, seconds, SQL and rupees. The old version folded job names into a list and left
the morning brief, the evening digest, the coach nudges and the dunning costed at nothing —
`lib/clock.ts` opens by calling that surface *"~70% of this product"*, and the instrument was
measuring the conversational third and extrapolating the whole. In the smoke run above, four of
the six turns are the queue, and they are ₹0.68 of the ₹1.11.

```bash
npm run sim                                    # seven days, blank world
npm run sim -- --preset smoke                  # one day, one window, two seats
npm run sim -- --world settled-tennis --days 7 # a settled business, a full week
npm run sim -- --days 3 --windows morning      # SIMULATED length
npm run sim -- --days 7 --budget-min 20        # REAL stop, at a window boundary
npm run sim -- --seats 2                       # only the first two people take part
npm run sim -- --seat-model claude:haiku       # cheaper people; sonnet is the default
npm run sim -- --events monsoon                # what HAPPENS to the business this week
npm run sim -- --chaos absent=0.2,lag=0.1      # or roll it, off --seed
npm run sim -- --drop                          # delete the academy at teardown; the default is to KEEP it
npx tsx scripts/sim.ts gc --hours 6            # reap this driver's stale worlds
```
**The world stays in the database.** That is the default now, and it used to be the opposite.
A drive's product is a business — a timetable somebody talked into existence, families on the
books, a week of messages against them — and dropping it at teardown meant the only way to look
at what a run built was to drive another week. A record answers *what happened*; only the rows
answer *what it is like to use*. So `npm run dev` after a drive opens the academy that drive just
made.

`--drop` is the opt-out. `gc` is what keeps this honest, and it is now routine rather than
exceptional:

```bash
npx tsx scripts/sim.ts gc --hours 6     # reap this driver's worlds, older than six hours
```

It only ever matches a name this driver made — `<spec name> <token>` — so a hand-built academy,
`_world.ts`'s fixture, or a business somebody is using is never touched. Note the age trap in its
own header: a world's `created_at` is written by the TENANT's clock, which every drive winds
forward, so a world made ten minutes ago reads as *in the future* and `--hours 6` leaves it
alone. `--hours 0` is the sentence that reaps those.


`--seed` is the identity of a repeat. The default is stamped rather than constant — a fixed
default would make every run in the repo claim to be a repeat of every other one — so it is
printed at the top of the run and you repeat a week by handing the printed one back.

---

## Did my change help?

Two runs, everything held still except the thing under test. The config is the smallest object
that can be written into the record beside the turns, handed to a second run unchanged, and
diffed against the first — which is why `--config`, `--seed` and `--arm` exist.

Prove the pair on `smoke` first — an A/B is two runs and a botched one costs both:

```bash
npx tsx scripts/sim.ts --preset smoke --seed ab-2026-08-20 --arm A --budget-min 20
# … make the change …
npx tsx scripts/sim.ts --preset smoke --seed ab-2026-08-20 --arm B --budget-min 20
```

Every drive opens by printing what it resolved, so the thing you are holding still is legible
before it costs anything. That second command prints:

```
1d × evening · arjun,farah ×2 · deepseek-v4-flash · seed ab-2026-08-20 · arm B · budget 20min
```

Then swap `--preset smoke` for `--preset week` and run the two arms for real, in parallel.

For a campaign of more than two runs, put the settings in a file — `--config arms/b.json` — and
name only `--arm` on the command line. Preset, then file, then flags; last wins. A config file
may not name another config file.

`arm` lands on the run in `record.json`, the resolved config is written to `config.json`, and
`manifest.json` carries the git sha — which is what makes the comparison legitimate at all. Two
runs of "the same drive" on two different commits are two different drives, and nothing else in
the directory would say so. Compare them with the one-liner under *Reading a run back*, then
read the turns; the numbers say which run to open, never which run was better.

`npm run ab` does the whole pair in one command, and is the better starting point once the
change is in a file rather than in your head:

```bash
npm run ab -- --variant doctrine=lib/doctrine.experimental.md
npm run ab -- --variant ref=8f8224d --days 2 --repeats 2
npm run ab -- --variant doctrine=… --dry-run    # prepare, hash, print, spend nothing
```

`--variant doctrine=<file>` swaps the prefix; `--variant ref=<sha|branch|checkout>` swaps the
mechanisms. Every other flag is `_drive-config.ts`'s and is given to BOTH arms, resolved once, so
the arms differ by one file and nothing else. It runs each arm as a whole `sim` child in a
root of its own — `stablePrefix()` memoises, so two prefixes cannot coexist in one node process,
and an arm sharing a process would silently drive the other arm's doctrine. Start with
`--dry-run`: it prepares both arms and hashes both prefixes without driving either.

It prints the two arms side by side in counts and **has no difference column** — a difference
carries a sign, and the sign is the verdict. That is still yours to write, into `judgement.json`.

Both arms can run at once. See *Run drives in parallel* above for why that is now safe.

---

## Being a person — `npm run drive`

One message at a time, with the whole flight recorder for that turn printed underneath it. This
is the instrument for *"what does it do about this exact sentence"*, and it is diagnosable in
one command: `say` and `tap` print the reply, the buttons, every query the model ran and what
came back.

```bash
npm run dev                                     # the emulator API the driver posts to
npm run drive -- world                          # who exists, and their contact ids
npm run drive -- reset                          # empty world, no fixture
npm run drive -- academy "Ace TT" --admin "Sharwin Rao"
npm run drive -- say <contactId> "saturday batch pls"
npm run drive -- stranger +919000000001 "hi is this the badminton academy?"
npm run drive -- tap <contactId> 2              # the nth affordance — button OR list row
npm run drive -- thread <contactId> --full
npm run drive -- turn --n 3                     # inside the last three turns
npm run drive -- evidence                       # what the seven axes are judged on
```

The whole lifecycle is drivable and each stage has a command — `class`, `new`, `present`,
`confirm`, `decline`, `claim`, `register`, `month`, `money`, `pay request|attest|confirm`,
`waive`, `move`, `cancel`, `end`, `deliver`, `fault`, `clock`, `tick`. `npm run drive -- help`
prints the current list, generated from the implemented cases rather than hand-written, so it
cannot document a command that is not there.

`drive` runs the turn inside the dev server, so its full-visibility switch lives there:

```bash
PROBE_FULL_TRACE=1 npm run dev
```

That lifts the flight recorder's 4,000-character cap, so `turn.tool_calls` holds the whole of
every argument and every result rather than the first four thousand characters of the ones that
mattered most.

---

## The human seat — `npx tsx scripts/live.ts`

An agent in the seat is a model reading a phone. A **person** in the seat is the only instrument
that produces a reading like *"I could not tell whether that meant she was charged"* — and that
reading is worth nothing if the reader could have checked the rows. So the seat commands print
message bodies, buttons and list rows and **nothing else**: no SQL, no reasoning, no tokens, no
rupees, no row counts, not even whether the turn errored. A turn that crashed reads, from the
seat, as silence, which is what it is from the seat. Every seat command is appended to
`seat.jsonl` with what it showed, so the blindfold is auditable after the run rather than
promised in a comment.

It costs a human being an evening. The three recorded human runs — `2026-08-17-18-07-live`,
`2026-08-18-14-38-live`, `2026-08-19-20-30-live` — are 54, 68 and 82 turns, 47–49 minutes of
model time, ₹15.25 to ₹30.56. The time that matters is the reader's, not the model's, and that is
what the agent week exists to buy back.

```bash
npx tsx scripts/live.ts open --days 7                      # build the academy, start the record
npx tsx scripts/live.ts window --day 3 --window evening    # move the clock, run standing jobs
npx tsx scripts/live.ts endday                             # close the day, overnight jobs
npx tsx scripts/live.ts close                              # fold in the world, notes and diaries
```

Between `window` and `endday`, drive each seat the schedule calls for. A seat reads
[`scripts/SEAT.md`](../scripts/SEAT.md) and may run **only** these:

```bash
npx tsx scripts/live.ts brief  <who>             # who you are, what you want, your phone
npx tsx scripts/live.ts say    <who> "…"
npx tsx scripts/live.ts tap    <who> "<the words on the button>"
npx tsx scripts/live.ts inbox  <who>             # anything that arrived on its own
npx tsx scripts/live.ts clock                    # what day and time it is
npx tsx scripts/live.ts note   <who> --kind unclear --text "…"
npx tsx scripts/live.ts diary  <who> --text "…"  # the only continuity a seat has
```

`npx tsx scripts/live.ts` with no arguments prints the current list, split into the orchestrator
half and the seat half. A seat that runs an orchestrator command has moved the clock under
everybody else.

The personas hold a **typing contract**, and it binds whoever is in the seat — `INPUT_REALISM` in
`_personas.ts`, read by the human's brief and by `_persona-agent.ts` alike. It is the half of the
input distribution this repo had never driven: typos left unfixed, half-messages finished in the
next one, autocorrect damage, duplicate sends, voice-note run-ons, Hinglish, ambiguous pronouns,
one-word replies, the occasional bare `?`. Roughly half of all messages carry one, and the four
garble *differently* —
a single shared noise model produces four people who garble identically, which is its own kind
of clean. Judge whether the product **recovered** the meaning or **invented** one; those are
different failures.

Turns are no longer serialised — the record is an append now, so there is nothing left to erase
and nothing left to queue for. What is *not* solved by that is attribution: two seats speaking
in the same instant each collect the other's messages and audit rows. Read the record
accordingly.

---

## The model against fixed cases

```bash
npm run ask -- --list                         # what the scenarios are — prints, spends nothing
npm run ask                                   # RUNS every scenario in that list
npm run ask -- "what if she pays twice?"      # any question, right now, ~5 paise
npm run ask -- --who coach "can I see her number?"
npm run probe -- --suite stress --stage money --persona coach
npm run probe -- --limit 5                    # the first five turns, a smoke run
npm run probe:sql -- --tier 1,2
```

`ask` is **toolless by design** and measures the *ceiling*: what the context makes derivable. It
is the one that catches a hole a transcript cannot show you — a turn shows the queries the model
*did* run and never the ones it decided against, and `class_coach` read zero times in thirty-five
turns (F-AU) is a sentence the model will volunteer if you ask it.

`probe` drives the real loop through a scripted arc in a fresh academy per model, walking the
stages a business really goes through — onboarding, roster, go-live, session-day, attendance,
money, month-end, churn — with every case declaring who is speaking. Ten suites:

`arc` · `f-o` · `f-q` · `adv` · `real` · `tennis` · `stress` · `stress-week` · `findings` ·
`holistic`

`probe:sql` is the SQL ladder, six tiers easy to hard. Thirteen wrapper operations were deleted
on 17 Aug 2026 and from that commit nearly every write in the product is SQL the model wrote
itself; nothing else here measures whether it can. A tier-5 case is not harder SQL — it is a case
where the obvious statement is wrong and Postgres does not say so.

`probe` shares `_drive-config.ts` with the drives and **refuses by name** the drive settings it
cannot honour, with what to use instead: `--days` on a probe would parse, validate, print no
warning and change nothing, because the arc's length is its case list and its travel is
`CLOCK_BUDGET_MS`.

---

## Reading a run back

The stated goal is *collect all the data so I can analyse later and see where the bot is going
wrong*. The directory is built for exactly that, and the order below is the workflow.

```
.probe/runs/<UTC-minute>-<suite>-<tok>/
  turns.jsonl     append-only. THE record. Everything else is derived from it
  index.jsonl     one thin line per turn — START HERE
  record.json     the canonical record; `npm run report` renders it
  turns/          one complete turn per file, <nnnn>-d<day>-<hhmm>-<who>-<persona>.json
  by-seat/        one persona's whole week, in order
  days.jsonl      what the queue ran each window, and what it sent unprompted
  config.json     exactly what was asked for, before anything happened
  manifest.json   what it ran against — git sha, models, transport, database, argv
  judgement.json  your verdict. Written beside the record, never inside it
```

`turns.jsonl` is the only file an instrument writes while a run walks. `record.json`,
`index.jsonl`, `turns/` and `by-seat/` are rebuilt from it by `_derive.ts`, idempotently and byte
for byte — so if you want a shape nobody thought of, you can have it without asking for the run
to be recorded differently. The turn number `n` is **append order**, assigned at read, which is
why those four files cannot disagree about what turn 23 is.

Every command below was run against `.probe/runs/2026-08-20-13-28-week-cu9z` and the output under
it is that run's. Swap the last argument for your own directory — `npm run runs` lists them,
newest first. Each takes the run directory as an **argument** rather than reading a shell
variable, so the same line works unchanged in git bash and in PowerShell.

### 1 · The whole run on one screen

```bash
node -e "const f=require('fs');for(const l of f.readFileSync(process.argv[1]+'/index.jsonl','utf8').trim().split('\n')){const t=JSON.parse(l);console.log(String(t.n).padStart(3),'d'+t.day,(t.window||'-').padEnd(9),(t.persona||'').padEnd(9),((t.ms/1000).toFixed(1)+'s').padStart(7),'r'+t.rounds,'sql'+t.sql,'sent'+t.sent,'wrote'+t.wrote,'Rs'+t.inr.toFixed(3),t.error||'')}" .probe/runs/2026-08-20-13-28-week-cu9z
```

```
  1 d1 -         queue        7.9s r0 sql0 sent1 wrote0 Rs0.000
  2 d1 evening   queue       71.2s r12 sql9 sent9 wrote1 Rs0.248
  3 d1 evening   prospect    15.7s r7 sql3 sent1 wrote0 Rs0.140
  4 d1 evening   coach       35.7s r8 sql7 sent1 wrote0 Rs0.287
  5 d1 evening   queue       10.5s r3 sql5 sent0 wrote0 Rs0.089
  6 d1 overnight queue      263.3s r10 sql7 sent1 wrote0 Rs0.345
```

A week is 800KB and thirteen numbers a turn usually answer the question. This is what
`index.jsonl` is for.

### 2 · The slowest turns

```bash
node -e "const f=require('fs');const R=f.readFileSync(process.argv[1]+'/index.jsonl','utf8').trim().split('\n').map(s=>JSON.parse(s));R.sort((a,b)=>b.ms-a.ms).slice(0,5).forEach(t=>console.log(((t.ms/1000).toFixed(1)+'s').padStart(8),'turn',t.n,'-',t.persona,t.window||'open','-',t.rounds,'rounds,',t.sql,'statements'))" .probe/runs/2026-08-20-13-28-week-cu9z
```

```
  263.3s turn 6 - queue overnight - 10 rounds, 7 statements
   71.2s turn 2 - queue evening - 12 rounds, 9 statements
   35.7s turn 4 - coach evening - 8 rounds, 7 statements
   15.7s turn 3 - prospect evening - 7 rounds, 3 statements
   10.5s turn 5 - queue evening - 3 rounds, 5 statements
```

`ms` includes the harness, not only the model. A slow turn with few rounds is a different defect
from a slow turn with twelve.

### 3 · Turns that read and then wrote nothing

```bash
node -e "const f=require('fs');f.readFileSync(process.argv[1]+'/index.jsonl','utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(t=>t.wrote===0&&t.sql>0).forEach(t=>console.log('turn',t.n,t.persona,t.window||'open','-',t.sql,'statements,',t.sent,'sent, nothing written'))" .probe/runs/2026-08-20-13-28-week-cu9z
```

```
turn 3 prospect evening - 3 statements, 1 sent, nothing written
turn 4 coach evening - 7 statements, 1 sent, nothing written
turn 5 queue evening - 5 statements, 0 sent, nothing written
turn 6 queue overnight - 7 statements, 1 sent, nothing written
```

Most of these are correct — a question deserves an answer, not a row. The rest are where the
product promised something and left no trace of it, and this list is the shortest way to the
turns worth opening. Turn 4 above is the honest kind: the coach said he was running late, and the
right reply was a question about the register rather than a write.

### 4 · Turns that errored

```bash
node -e "const f=require('fs');const R=f.readFileSync(process.argv[1]+'/index.jsonl','utf8').trim().split('\n').map(s=>JSON.parse(s)).filter(t=>t.error);console.log(R.length?R.map(t=>'turn '+t.n+' '+t.persona+' - '+t.error).join('\n'):'no turn in this run recorded an error')" .probe/runs/2026-08-20-13-28-week-cu9z
```

```
no turn in this run recorded an error
```

### 5 · Cost and time split by persona

```bash
node -e "const f=require('fs');const by={};for(const s of f.readFileSync(process.argv[1]+'/index.jsonl','utf8').trim().split('\n')){const t=JSON.parse(s);const b=by[t.persona]||(by[t.persona]={n:0,inr:0,ms:0,sql:0});b.n++;b.inr+=t.inr;b.ms+=t.ms;b.sql+=t.sql}for(const[k,v]of Object.entries(by).sort((a,b)=>b[1].inr-a[1].inr))console.log(k.padEnd(10),v.n+' turns',('Rs'+v.inr.toFixed(2)).padStart(8),(v.ms/60000).toFixed(1)+' min',v.sql+' statements')" .probe/runs/2026-08-20-13-28-week-cu9z
```

```
queue      4 turns   Rs0.68 5.9 min 21 statements
coach      1 turns   Rs0.29 0.6 min 7 statements
prospect   1 turns   Rs0.14 0.3 min 3 statements
```

### 6 · What the queue ran, unprompted

```bash
node -e "const f=require('fs'),p=require('path');const d=process.argv[1],n={};for(const x of f.readdirSync(p.join(d,'turns')))for(const j of JSON.parse(f.readFileSync(p.join(d,'turns',x),'utf8')).jobs||[])n[j]=(n[j]||0)+1;const e=Object.entries(n).sort((a,b)=>b[1]-a[1]);console.log(e.reduce((a,x)=>a+x[1],0)+' jobs ran across '+e.length+' kinds');for(const[k,v]of e)console.log(String(v).padStart(4),k)" .probe/runs/2026-08-20-13-28-week-cu9z
```

```
23 jobs ran across 18 kinds
   3 materialize_sessions:done
   2 monthly_lines:done
   2 coach_coming:done
   2 coach_day:done
   1 month_end_tally:done
   1 first_contact_batch:skipped
   1 coach_nudge:skipped
   1 admin_escalate_uncovered:skipped
   1 admin_morning_brief:done
   1 client_session_trouble:skipped
   1 post_class_register:skipped
   1 register_expiry:done
   1 coach_nudge:done
   1 admin_escalate_uncovered:done
   1 client_session_trouble:done
   1 post_class_register:done
   1 agent_task:done
   1 admin_evening_digest:done
```

A `:skipped` is the job deciding it had nothing to do, which is a fact about the world and not a
failure. `days.jsonl` holds the same jobs per window but **not** the opening drain, so its total
is 18 against the record's 23 — read jobs off the turns, which is where they are attributed.

And what actually reached a phone with nobody asking, which is where the suppression bugs live:

```bash
node -e "const f=require('fs');for(const l of f.readFileSync(process.argv[1]+'/days.jsonl','utf8').trim().split('\n')){const d=JSON.parse(l);for(const m of d.unprompted||[])console.log('d'+d.day,(d.window||'').padEnd(9),String(m.who).padEnd(12),m.status,'|',String(m.body).replace(/\n+/g,' ').slice(0,80))}" .probe/runs/2026-08-20-13-28-week-cu9z
```

```
d1 overnight Rahul Menon  sent | Message from Ace Tennis Academy cu9z. For: Rahul Menon Change: Mon 24 Aug, 6 am
d1 overnight Divya Rao    suppressed | July for Divya: • Evening Batch — July 2026 — ₹2,400 Total ₹2,400. Outstanding a
d1 overnight Rahul Menon  sent | Message from Ace Tennis Academy cu9z. For: Rahul Menon Change: your day, Mon 24
d1 overnight Arjun Shetty sent | Message from Ace Tennis Academy cu9z. For: Arjun Shetty Change: your day, Mon 24
d1 overnight Rahul Menon  sent | Message from Ace Tennis Academy cu9z. Issue: a register is unmarked, Mon 24 Aug,
d1 overnight Arjun Shetty sent | Message from Ace Tennis Academy cu9z. Task: confirm you're coming, Mon 24 Aug, 5
d1 overnight Arjun Shetty sent | Message from Ace Tennis Academy cu9z. Task: still need your confirmation, Mon 24
d1 overnight Rahul Menon  sent | Message from Ace Tennis Academy cu9z. Issue: a session is uncovered, Mon 24 Aug,
d1 overnight Divya Rao    sent | Message from Ace Tennis Academy cu9z. For: Anika Rao Change: a change to today's
d1 overnight Arjun Shetty sent | Message from Ace Tennis Academy cu9z. Task: take the register, Mon 24 Aug, 7 pm
```

Ten unprompted messages on the one day this run covers, and one of them **suppressed** — a
message the product decided against sending. Whether that was right is a judgement; that it
happened is evidence, and it is the one thing a seat can never see, because a suppressed message
is exactly the message the blindfold hides.

### 7 · One turn, opened up

`turns/` is named so that `ls` is a query: `<nnnn>-d<day>-<hhmm>-<who>-<persona>.json`, zero-padded
so lexical order is turn order.

```bash
ls .probe/runs/2026-08-20-13-28-week-cu9z/turns/
```

```
0001-d1-0030-queue-queue.json
0002-d1-0030-queue-queue.json
0003-d1-1445-farah-sheikh-prospect.json
0004-d1-1445-arjun-shetty-coach.json
0005-d1-1445-queue-queue.json
0006-d1-1446-queue-queue.json
```

```bash
node -e "const t=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(t.who+' said: '+t.say);console.log('  (why: '+((t.personaReasoning||{}).reasoning||'')+')');for(const s of t.sql)console.log(String(s.rowCount).padStart(5)+' rows  '+s.sql.replace(/\s+/g,' ').slice(0,96));console.log('reply: '+String(t.reply).replace(/\n+/g,' '))" .probe/runs/2026-08-20-13-28-week-cu9z/turns/0004-d1-1445-arjun-shetty-coach.json
```

```
Arjun Shetty said: coming, stuck in traffic 10 min late
  (why: i'm at the signal, 5:30 msg wants a word so i'll confirm, and warn them so rahul knows i'm on the way)
    0 rows  select scope, stated, to_char(until, 'YYYY-MM-DD') as until from comm_preference where contact_i
    0 rows  select kind, subject, question, to_char(created_at, 'YYYY-MM-DD') as asked_on, (expires_at is no
    1 rows  select c.name as class_name, s.starts_at, s.id as session_id from session_coach sc join session
    4 rows  select c.name as class_name, s.starts_at, v.name as venue, sc.confirmed_at from session_coach sc
    1 rows  select (select status from coach where id = '4e778dab-9a45-4142-8e30-fb2d99bbd3e9'::uuid) as sta
    1 rows  select sd.session_id, sd.class_name, sd.local_start, sd.local_end, sd.status, sd.coverage from s
    1 rows  select player_id, player_name, account_id, is_trial, attendance_status from app.session_roster w
reply: The 6 pm Evening Batch finished at 7 pm, and it's the only thing on your schedule tonight — so the register is still sitting open, just Anika on it. Was she there?
```

`personaReasoning` is what the *person* was thinking, and it is only in an agent-driven run. It is
the field that separates "the product answered a question nobody asked" from "the product
answered the question badly", and no scripted harness could ever have carried it.

For the whole turn — every round's reasoning verbatim, every tool call with its arguments and
result untruncated, the world counted either side — use the report:

```bash
npm run report                                       # the newest run
node scripts/report.mjs --run .probe/runs/2026-08-20-13-28-week-cu9z
```

### 8 · One person's whole week

```bash
node -e "const f=require('fs');for(const l of f.readFileSync(process.argv[1],'utf8').trim().split('\n')){const t=JSON.parse(l);console.log('d'+t.day,(t.window||'').padEnd(9),'says:',String(t.say).replace(/\n+/g,' ').slice(0,60));console.log('          got :',String(t.reply).replace(/\n+/g,' ').slice(0,90))}" .probe/runs/2026-08-20-13-28-week-cu9z/by-seat/prospect.jsonl
```

```
d1 evening   says: Hi, I saw your board for the tennis academy. What do you cha
          got : Hi Farah — here's what's on the board. Each class is billed per child, per month, so for t
```

**`by-seat/` is not an analysis step, and that is deliberate.** The reading that reframed a month
in this repo came from splitting by persona instead of averaging: every catastrophic turn in
`2026-08-17-1230-stress-month` was a **client** turn, and the same month weighted toward the
operator scores 8.2 and reads as fine. That split was somebody's idea, done once, by hand. It is
a file now, so the next reader gets it before they think to ask for it. Averaging a run hides the
only thing worth knowing about it.

### 9 · Two runs, side by side

```bash
node -e "const f=require('fs'),p=require('path');for(const d of process.argv.slice(1)){const R=f.readFileSync(d+'/index.jsonl','utf8').trim().split('\n').map(s=>JSON.parse(s));console.log(p.basename(d).padEnd(30),R.length+' turns',('Rs'+R.reduce((a,t)=>a+t.inr,0).toFixed(2)).padStart(8),(R.reduce((a,t)=>a+t.ms,0)/60000).toFixed(1)+' min',R.reduce((a,t)=>a+t.sql,0)+' sql',R.filter(t=>t.error).length+' errors')}" .probe/runs/2026-08-20-13-17-week-aejx .probe/runs/2026-08-20-13-28-week-cu9z
```

```
2026-08-20-13-17-week-aejx     6 turns   Rs1.69 4.8 min 34 sql 0 errors
2026-08-20-13-28-week-cu9z     6 turns   Rs1.11 6.7 min 31 sql 0 errors
```

Check `manifest.json`'s `git.sha` on both before you read anything into a difference.

---

## Then ask the database

A green tool result is not evidence. Read the rows back.

```bash
node scripts/q.mjs --academy "Ace" "select status, body from message order by created_at desc limit 5"
node scripts/q.mjs --json --academy "Ace" "select payload from message where direction='outbound'"
node scripts/q.mjs --as <contactId> "select * from player"   # what THEY can see, under their RLS
```

It runs as `cm_service` by default, deliberately: its job is to see what a tenant's own session
might have been *refused*, because a refusal that reads as an empty result is R7 and the
commonest way a bad run looks like a good one. `--w <n>` widens columns.

**`cm_service` does NOT bypass RLS, and a cross-tenant question used to answer `0`.** Every
service policy in 0003 is `academy_id = app.academy_id()`. The service role is exempt from the
*person* half — `is_admin()`, `my_account_ids()`, `sees_money()` — and from nothing else. With no
`--academy` the GUC is null and **every tenant-scoped table reads empty**: `select count(*) from
payment` answered `0` for a database holding seven, and `tally_line` `0` for seventy-eight. `job`
hides it, because its service policy is the one whose qual is `true`, so the first questions
anybody asks come back populated.

Naming a tenant-scoped table with no tenant now **warns before the rows print** (the list is read
from `pg_policies` at run time, so a table added later is covered), and `--all` sweeps every
academy and labels each row with the one it came from:

```bash
node scripts/q.mjs --all "select status, count(*) from payment group by 1"
```

Use `--all` for any question of the form "has this product ever…". That is the question the tool
used to answer wrongly.

---

## The verdict

Nothing in an instrument scores anything. When you have read the turns, write
`judgement.json` beside the record — by hand, or with `npm run judge` when there is nobody free
to read. The two are interchangeable on purpose, and they write the same file.

```bash
npm run runs                      # every run, newest first, and which are judged
npm run report                    # render the newest run; re-run after judging
```

`npm run findings` answers the one question nothing else can: **which of the things that have
already broken does no instrument even ask about?**

---

## Traps

**Check `TRANSPORT` before driving.** `.env.local` ships `TRANSPORT=cloud`, and a drive on the
cloud path hard-fails at the credential gate — every turn then reports an error, zero tools and
an empty reply, which reads exactly like a broken model. The run measures nothing.

`sim.ts`, `live.ts`, `_seat.ts`, `probe-model.ts` and `probe-sql.ts` each pin
`TRANSPORT=emulator` in their own module body — a module body runs before the body of whatever
imported it, so none of them can rely on another having done it. **`npm run drive` is the
exposure**: it runs the turn inside the dev server, so it is the *server's* environment that
decides. Start it as `TRANSPORT=emulator npm run dev` unless you specifically mean to exercise
the live sender.

**`npm run db:push` deadlocks while the dev server is running.** `0002_schema.sql` cannot take
its lock on `sim_clock`. Stop the server, or apply the one new migration directly.

**A worktree needs three things copied in before it can run anything** — `.env.local`,
`.secrets/`, and `node_modules` (a junction is fine). All three are gitignored, and without them
everything fails in ways that look like model errors.

**`.probe/` is gitignored and unrecoverable.** Archive, never delete: the old runs are the
baseline every "did the edit help?" reading is measured against.

**Ctrl-C is not a stop.** Use `--budget-min` or `--budget-inr`. See the budget section above for
what a killed turn does to the attribution of everything around it.

**Every drive leaves its world behind now, and so does a crash.** Nothing reaps it at start-up,
on purpose. `npm run sim -- gc --hours 6` is the reaper, and it will not touch a world it
cannot prove this driver made.

**Before you finish:**

```bash
npm run typecheck
node scripts/rls-check.mjs
npm run check:layout
```

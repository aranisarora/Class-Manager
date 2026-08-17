# Driving

## What driving is for

Driving is being a person talking to the bot, and then asking the database whether what
it said was true. It is the whole eval. `npm run drive` posts to the same emulator API a
human uses, so there is no second code path to keep honest, and it reads the ordinary
tables back — `message` for what was said, `turn` for what was thought, `audit_entry`
for what changed. Nothing in the harness knows anything the product does not record.

The product is a general agent on general primitives — read with SQL, write with SQL,
send, remember, schedule, show a view — bounded by the permissions of whoever is talking.

`product-spec.md` remains the authority on what the product is supposed to do. This file
is how you find out whether it does.

---

## How to run it

```bash
npm run dev                       # the emulator API the driver posts to
npm run db:push                   # migrations, in filename order; re-running is a no-op
npm run drive -- reset            # empty world, no fixture
npm run drive -- academy "X" --admin "Y"
npm run drive -- say <contact> "hi"
npm run drive -- stranger +91… "hi is this the badminton academy?"
npm run drive -- evidence         # what the seven axes are judged on, before and after
```

`say` and `tap` print the reply, the buttons, and the flight recorder for that turn —
every query the model ran and what came back — so a wrong answer is diagnosable in one
command. `drive world` gives you the contact ids everything else takes.

**Then ask the database.** Rule 3 below is the whole method and it needs a tool:

```bash
node scripts/q.mjs --academy "Ace" "select status, body from message order by created_at desc limit 5"
node scripts/q.mjs --json --academy "Ace" "select payload from message where direction='outbound'"
node scripts/q.mjs --as <contactId> "select * from player"   # what THEY can see, under their RLS
```

It runs as `cm_service` by default, deliberately: its job is to see what a tenant's own
session might have been *refused*, because a refusal that reads as an empty result is R7
and the commonest way a bad run looks like a good one. `--w <n>` widens columns.

**`cm_service` does NOT bypass RLS, and a cross-tenant question used to answer `0`.**
Every service policy in 0003 is `academy_id = app.academy_id()`. The service role is
exempt from the *person* half — `is_admin()`, `my_account_ids()`, `sees_money()` — and
from nothing else. With no `--academy` the GUC is null and **every tenant-scoped table
reads empty**: `select count(*) from payment` answered `0` for a database holding seven,
and `tally_line` `0` for seventy-eight. `job` hides it, because its service policy is the
one whose qual is `true`, so the first questions anybody asks come back populated.

Naming a tenant-scoped table with no tenant now **warns before the rows print** (the list
is read from `pg_policies` at run time, so a table added later is covered), and `--all`
sweeps every academy and labels each row with the one it came from:

```bash
node scripts/q.mjs --all "select status, count(*) from payment group by 1"
```

Use `--all` for any question of the form "has this product ever…". That is the question
the tool used to answer wrongly.

The whole lifecycle is drivable, and each stage has a command:

```bash
npm run drive -- class --name "Evening" --day mon,thu --time 18:30-19:30 --rate 2400 --unit per_month
npm run drive -- new <academyId> --name "…" --role coach --class "Evening" --invite
npm run drive -- present <coachContact>          # the [All present] chat button
npm run drive -- month --period 2026-07          # close a period without moving the clock
npm run drive -- money --period 2026-07|all
npm run drive -- end coach|player|contact …      # churn
npm run drive -- waive <accountId> --amount 1200 --reason "…"
npm run drive -- move --session <id> --to <iso> | --class "…" --day tue --time 19:00-20:00
npm run drive -- cancel --class "…" --reason "…"
npm run drive -- deliver [--read]                # the delivery ladder
npm run drive -- fault send_fail on --rate 1
```

```bash
npm run drive -- register <coachContact> --absent "Aarav,Meera"
npm run drive -- form <contact> business_setup --json '{...}'
```

Before you finish:

```bash
npm run typecheck
node scripts/rls-check.mjs
```

`npx tsx scripts/probe-model.ts [--keep]` drives the real loop through a scripted
onboarding arc in a fresh academy and runs a set of SQL invariants after every case. It
tears its academy down unless you pass `--keep`.

**Driving the ledger.** `--suite stress` is the regression drive: a month in a SOLO business
(the admin is the only coach), thirty-two turns, eight on each of the four personas, and every
turn re-stages a scenario that has already produced a finding — with the checks written to
catch that finding specifically. `npm run report` renders the run as a page: every turn opened
up, its reasoning, every statement it sent and what came back. The verdict is not computed —
it is written by a reader into `judgement.json` beside the record. See [`JUDGING.md`](./JUDGING.md).

```bash
TRANSPORT=emulator npm run probe -- --suite stress --models deepseek-v4-flash \
  --out .probe/runs/$(date +%Y-%m-%d-%H%M)-stress-month
npm run report                    # the newest run, as one page
npm run runs                      # which runs exist, and which are judged
```

`TRANSPORT=emulator` is not optional garnish: `.env.local` ships `TRANSPORT=cloud`, and a drive
that takes the cloud path hard-fails at the credential gate and measures nothing.

**A worktree needs three things copied in before it can run anything**: `.env.local`,
`.secrets/`, and `node_modules` (a junction is fine). All three are gitignored, and
without them everything fails in ways that look like model errors — every case reports
`ERROR`, zero tools, an empty reply.

---

## Driving it live, from a seat

Everything above posts sentences somebody wrote in advance. `drive-week` scripts
twenty-eight of them and posts them in order, and whatever the product replies, the next
sentence is the same one. That cannot represent the three commonest things a real person
does: **ask again because the first answer did not answer it**, **act on a misreading**,
and **go quiet and leave**. All three are outcomes, and the last one is the one the
business cares about.

`scripts/live.ts` has no sentences in it. It is a **seat**: a way to say something as a
particular person and see exactly — and only — what their phone would show. Somebody else
sits in it, reads the reply, and decides what to type next.

```bash
npx tsx scripts/live.ts open --days 7            # build the academy, start the record
npx tsx scripts/live.ts window --day 3 --window evening   # move the clock, run standing jobs
npx tsx scripts/live.ts endday                   # close the day, run the overnight jobs
npx tsx scripts/live.ts close                    # fold in the world, notes and diaries
```

Between `window` and `endday`, drive each seat the schedule calls for. A seat reads
[`scripts/SEAT.md`](./scripts/SEAT.md) and may run **only** these:

```bash
npx tsx scripts/live.ts brief  <who>             # who you are, what you want, your phone
npx tsx scripts/live.ts say    <who> "…"
npx tsx scripts/live.ts tap    <who> "<the words on the button>"
npx tsx scripts/live.ts inbox  <who>             # anything that arrived on its own
npx tsx scripts/live.ts note   <who> --kind unclear --text "…"
npx tsx scripts/live.ts diary  <who> --text "…"  # the only continuity a seat has
```

**The blindfold is the instrument.** A reading like *"I could not tell whether that meant
she was charged"* is worth nothing if the reader could have checked the rows. So the seat
commands print message bodies, buttons and list rows and **nothing else** — no SQL, no
reasoning, no tokens, no rupees, no row counts, not even whether the turn errored. A turn
that crashed reads, from the seat, as silence, which is what it is from the seat. Every
seat command is appended to `seat.jsonl` with what it showed, so the blindfold is
auditable after the run rather than promised in a comment.

**The four seats are in `scripts/_personas.ts`, and they hold goals rather than lines** —
who somebody is, what they want by Sunday, what would make them leave, and what happens in
their life each day. They also hold a **typing contract**, which is the half of the input
distribution this repo had never driven: typos left unfixed, half-messages finished in the
next one, autocorrect damage, duplicate sends, voice-note run-ons, Hinglish, ambiguous
pronouns, one-word replies, the occasional bare `?`. Roughly half of all messages should
carry one. The four garble *differently* — a single shared noise model produces four people
who garble identically, which is its own kind of clean. Judge whether the product
**recovered** the meaning or **invented** one; those are different failures.

Windows are balanced six per seat and **asserted before the run starts** — a week claiming
equal coverage while running eleven owner windows and two client ones reports the owner's
experience as though it were the product's.

**Turns are serialised under a lock**, and seats are not. `_capture.ts` attributes evidence
by a domain-time cursor, so two turns running at once each collect the other's messages,
jobs and audit rows. Seats still run concurrently; they queue at the moment of speaking.

The world is `scripts/_world.ts`: a settled academy where **the owner also coaches** (an
`academy_admin` row and a `coach` row over one `person`), four families, one of them with
two children on two classes, last month closed and this month open. It writes only the
CLOSED month — anything the product bills for itself, it bills, and a fixture that wrote
the current period too doubled every August bill.

### Reading a live run back

```bash
node scripts/judge-slice.mjs --list              # index: every turn, one line each
node scripts/judge-slice.mjs --turn 38           # ONE turn, opened all the way up
node scripts/judge-slice.mjs --persona client    # every turn in one seat
node scripts/judge-slice.mjs --notes             # what the people said, and their diaries
node scripts/judge-slice.mjs --days              # what the standing jobs sent, unprompted
node scripts/judge-slice.mjs --to "Divya Rao"    # everything that reached one phone, in order
```

`--turn` prints in the order [`JUDGING.md`](./JUDGING.md) says to read: what they typed,
what it was thinking, what it queried and what came back, what it wrote, what moved in the
world, and — last — what the person read. `npm run report` still renders the whole run as
one page; this is for producing a judgement rather than reading one.

The first live week is `.probe/runs/2026-08-17-18-07-live` — 82 conversational turns over
seven days, judged by five readers into `judgement.json`, written up in
`.probe/reports/2026-08-18-live-week-analysis.html`, with the findings staged in
[`findings-live-week.md`](./findings-live-week.md).

---
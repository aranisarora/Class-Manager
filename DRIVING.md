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
npm run drive -- score            # before and after, both in your findings
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

**A worktree needs three things copied in before it can run anything**: `.env.local`,
`.secrets/`, and `node_modules` (a junction is fine). All three are gitignored, and
without them everything fails in ways that look like model errors — every case reports
`ERROR`, zero tools, an empty reply.

---
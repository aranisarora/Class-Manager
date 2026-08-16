# Deploying Class Manager

This is the runbook for putting the bot on Vercel with the emulator as the production ops
console. It assumes the shape the deployment actually has, which is worth stating plainly
before any commands:

- **`/api/webhook` is public and must stay public.** Meta has to reach it unauthenticated;
  it authenticates itself with an HMAC over the raw body. Anything that gates it kills all
  inbound WhatsApp traffic, and Meta's failure mode is retry-then-disable rather than an
  error you will see.
- **Everything else operator-facing is behind one secret.** `/emulator`, `/api/emulator/*`
  and the root page all sit behind the ops cookie, because the root page leaks the database
  host and cross-tenant counts to anyone who loads it.
- **Production ops is read plus tick.** Seed, reset, clock, fault, fabricated inbounds and
  forged delivery receipts are refused server-side unless `OPS_SANDBOX` is exactly `'1'`,
  which production will not have.
- **The minute tick comes from Supabase, not from Vercel.** §3 explains why.

---

## The build output directory, and why it is already handled

There is an invariant here worth knowing before you read a confusing build log, because if
it is ever broken the deploy fails *after* a successful compile — typically as a missing
`routes-manifest.json`, or `No Output Directory named ".next" found`. That reads like a
broken build and is really a misplaced one.

Locally, `next dev` and `next build` are deliberately kept apart: dev writes `.next`, build
and `next start` share `.next-build`, so running a verification build against a live dev
server cannot drop new manifests on top of the ones the running server has already loaded.
Vercel's builder, however, looks for the output in `.next` and never reads `distDir` out of
`next.config.ts` at all.

`next.config.ts` already resolves this: it returns `distDir: '.next'` whenever
`process.env.VERCEL` is set, and falls back to the local split otherwise. `VERCEL` is set on
every Vercel build and deployment and nowhere else, and the collision the split exists to
prevent needs a dev server, which a build container does not have. Nothing to apply — just
do not undo it.

The alternative — `"outputDirectory": ".next-build"` in `vercel.json` — is deliberately not
used. Overriding the output directory on the Next.js preset changes how the builder locates
its own artifacts, and it puts a second copy of the path in a second file that has to stay in
sync with the first.

---

## 1. Prerequisites and environment variables

You need a Vercel account (Hobby is enough), a Supabase project, a Meta app with a WhatsApp
Business Account, and a DeepSeek API key. Two database steps come before any of the Vercel
work, and both are done from a workstation — never from a lambda.

### 1.1 Create the runtime login role

The app does **not** connect as `postgres`. CONTRACTS §2.1 makes RLS the security boundary
mechanically rather than by convention: the connection is `cm_runtime`, a login role that
owns nothing and holds no table privileges of its own, and every query in the product opens
a transaction that first `set local role`s into one of `cm_service` / `cm_user` /
`cm_readonly`. There is no code path in `lib/db.ts` that touches a row without declaring
which of those three it is acting as. Connect as `postgres` and that whole apparatus still
*runs*, silently, on a superuser that bypasses every policy it is meant to be constrained by.

No migration creates the login role — `0001_roles.sql` creates only the three `nologin`
session roles. Create it once, as the migration/owner role, in the Supabase SQL Editor,
**before the first `db:push`**:

```sql
create role cm_runtime login password '<generate-a-strong-one>';
grant cm_service, cm_user, cm_readonly to cm_runtime;
```

Keep that password: it is the one that goes into `DATABASE_URL` below. If you skip this,
`0006_grants.sql` line 18 is a bare, unguarded `grant … to cm_runtime` and the push stops
there with `role "cm_runtime" does not exist`. (`0005_audit.sql` wraps the same grant in an
exception handler and only raises a notice, which is why the failure surfaces at 0006 rather
than at 0005.)

### 1.2 Apply the schema, including `0029_tick_runs.sql`

```bash
npm run db:push          # or: MIGRATION_DATABASE_URL=postgresql://<owner>@… npm run db:push
```

Every migration is written to be re-runnable, so a push against a current database is a
no-op that still exits 0. Push anyway after pulling this change: **`0029_tick_runs.sql` is
new**, and it creates `tick_runs`, the only durable record the production beat leaves behind.
Its absence is silent by construction — `lib/jobs/tick-log.ts` guarantees `recordTick` never
throws, because a tick that ran twenty jobs correctly and then failed to write its diary has
not failed — so a deployment missing 0029 answers 200 on every beat, looks healthy in
pg_net, and has an empty `tick_runs` forever. §3.4 is where that symptom comes back to bite.

On this workstation `db:push` deadlocks if the dev server is running: `0002_schema.sql`
cannot take its lock on `sim_clock` while the server holds a connection reading it. Stop
`npm run dev` first.

### 1.3 The variables

Every variable is listed in `.env.example` with a placeholder. **All of them must be set
before the first build**, not just before the first request: `lib/db.ts` builds its pool in a
module-scope IIFE, so Next's "Collecting page data" step forces the full zod parse and a
missing key fails the *build* with `env_invalid` naming the key.

| Variable | Where it comes from | Environments |
|---|---|---|
| `DATABASE_URL` | Supabase → Project Settings → Database → Connection string → **Transaction pooler (port 6543)** — then **replace the user and password**. Take the host and port from that string; the user is `cm_runtime.<PROJECT_REF>` and the password is the one you set in §1.1, *not* the `postgres.<PROJECT_REF>` credentials the dashboard hands you. See the two notes below. | Production, Preview |
| `SUPABASE_URL` | Supabase → Project Settings → API → Project URL | Production, Preview |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase → Project Settings → API → publishable key | Production, Preview |
| `DEEPSEEK_API_KEY` | platform.deepseek.com → API keys | Production, Preview |
| `MODEL_MAIN` | `deepseek-chat` unless you are testing another | Production, Preview |
| `MODEL_SYNTH` | `deepseek-chat` unless you are testing another | Production, Preview |
| `APP_JWT_SECRET` | `openssl rand -base64 32`. Read by nothing today, required by the schema. | Production, Preview |
| `APP_BASE_URL` | The deployment's own origin, e.g. `https://class-manager.vercel.app`, no trailing slash | Production, Preview |
| `TRANSPORT` | `cloud` on production. `emulator` everywhere else. | Production, Preview |
| `WHATSAPP_PHONE_NUMBER_ID` | Meta → WhatsApp → API Setup | Production |
| `WHATSAPP_WABA_ID` | Meta → WhatsApp → API Setup | Production |
| `WHATSAPP_SENDER_PHONE` | The sender number in E.164 | Production |
| `WHATSAPP_ACCESS_TOKEN` | Meta → Business settings → System users → Generate token | Production |
| `WHATSAPP_APP_SECRET` | Meta → App settings → Basic → App secret | Production |
| `WHATSAPP_APP_ID` | Meta → App settings → Basic → App ID | Production |
| `WHATSAPP_VERIFY_TOKEN` | Any string you choose; the identical value goes in Meta → WhatsApp → Configuration | Production |
| `OPS_SECRET` | `openssl rand -base64 24`. The password for `/ops/login`. | Production, Preview |
| `CRON_SECRET` | `openssl rand -base64 32`. The bearer token `/api/cron/tick` demands. | Production, Preview |
| `OPS_SANDBOX` | **Leave unset on production.** `1` only on a sandbox pointed at a throwaway database — see §5. | Sandbox only |

`MIGRATION_DATABASE_URL` is local tooling and does not belong on Vercel. Migrations are
applied from a workstation as a role that owns the schema; the runtime role deliberately is
not that role, and putting the privileged URL on the deployment only widens what a
compromised build can reach.

### The `DATABASE_URL` user is not a detail

The Supabase dashboard's connection string authenticates as `postgres.<PROJECT_REF>`, and
pasting it unedited is the easiest mistake on this page because everything then works. It
works the way a locked door works when you are carrying the master key: `postgres` is a
superuser, RLS does not apply to it, and every `set local role` the runtime issues becomes
decoration over a connection that could have read any tenant's rows without it. The
invariant that `lib/db.ts` is built around — CONTRACTS §2.1, RLS is the boundary — is
discarded silently, with no error and no behavioural difference to notice later.

So the URL is the dashboard's host and port with `cm_runtime.<PROJECT_REF>` and the §1.1
password in front of it:

```
postgresql://cm_runtime.<PROJECT_REF>:<CM_RUNTIME_PASSWORD>@aws-0-<REGION>.pooler.supabase.com:6543/postgres
```

The `.<PROJECT_REF>` suffix on the username is Supavisor's tenant routing, not part of the
role name — the role in Postgres is plain `cm_runtime`. Confirm the deployment is actually
using it with `select current_user, session_user;` from any query the app makes; both should
read `cm_runtime` outside a `set local role` block.

### The `DATABASE_URL` port is not a detail

Use the **transaction-mode pooler on port 6543**, not the direct connection and not the
session-mode pooler on 5432. Between those two pooler URLs only the port differs — same host,
same `cm_runtime` credentials from the section above.

In session mode each client connection holds a dedicated server connection for its entire
life, against a project-wide ceiling of `pool_size: 15`. `lib/db.ts` opens a pool of ten per
process, and on Vercel every warm instance gets its own pool. Two instances exhaust the
pooler on arithmetic alone, with no leak involved, and every database-backed route starts
answering `(EMAXCONNSESSION) max clients reached in session mode`. The failure looks like an
outage and is really a subtraction.

postgres.js cannot send prepared statements through the transaction pooler. `lib/db.ts`
already sets `prepare: false` for exactly that reason — it is not something you need to add,
but it is something not to remove.

---

## 2. The Vercel project

1. **Import the repository.** Vercel detects Next.js; `vercel.json` pins
   `"framework": "nextjs"` so the detection cannot drift.
2. **Set every variable from the table above** under Settings → Environment Variables,
   scoped to Production (and Preview if you want preview builds to compile). Vercel exposes
   them to the build as well as to the running function, which is what the build needs.
3. **Deploy.** The first build is the one that catches a missing key, and the error names it.
4. **Region.** `vercel.json` sets `"regions": ["bom1"]` — Mumbai, next to the ap-south-1
   Supabase project. This matters more than it looks: several read paths issue one query per
   academy in a loop, so a cross-continent round trip is paid many times per request rather
   than once. If your Supabase project is not in ap-south-1, change the region to match it.
   If Vercel rejects the value on your plan, delete the line and set the region under
   Settings → Functions instead.
5. **Deployment Protection.** On Hobby, Production is public by default and Preview
   deployments get Vercel Authentication. Leave Production public — the ops surface is
   protected by its own cookie and the Meta webhook must be anonymous. If you turn
   Deployment Protection on for Production, Meta stops being able to reach `/api/webhook`.

### After the first deploy, check these four things

```bash
# The webhook is reachable and fails closed. A 401 here is the correct answer.
curl -i -X POST https://<domain>/api/webhook -d '{}'

# The ops surface is actually shut. Expect a 401 or a redirect to the login, not JSON.
curl -i https://<domain>/api/emulator/state

# The root page is shut too — it prints the database host and tenant counts when it is not.
curl -i https://<domain>/

# The cron endpoint refuses an unauthenticated caller.
curl -i -X POST https://<domain>/api/cron/tick
```

Then sign in at `https://<domain>/ops/login` with `OPS_SECRET` and confirm the console loads.

Two behaviours that are expected rather than broken: the console's live stream will
disconnect and reconnect on a fixed cadence, because `/api/emulator/stream` holds an open
connection and Vercel kills the function at its duration cap — the client falls back to
polling and recovers on its own. And the console will show no scenario fixture, because a
real database has no seeded world in it.

---

## 3. The minute tick: Supabase `pg_cron` + `pg_net`

The job queue needs draining roughly every minute, and it is not optional. `drainWebhookEvents()`
is the only consumer of the `webhook_event` rows the Meta webhook writes, and the runner
reclaims stale locks after fifteen minutes with no filter on job kind — so an ingestion
backlog that outlives that window is handed to a runner with no handler for it and is
permanently failed. A tick slower than every fifteen minutes silently destroys real parent
messages.

**Vercel Hobby cannot provide that beat.** Hobby cron jobs are limited to roughly daily
granularity (and a small number of jobs per project); minute-level schedules are a Pro
feature. So `vercel.json` deliberately carries no `crons` entry, and Supabase `pg_cron` pokes
the deployment instead. This is the better arrangement anyway: the beat lives next to the
data it drives and survives anything that happens to the Vercel project.

### 3.1 Extensions

Run in the Supabase SQL Editor:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

`pg_cron` installs into `pg_catalog` and exposes `cron.*`; `pg_net` exposes `net.*`. Confirm:

```sql
select extname, extversion from pg_extension where extname in ('pg_cron', 'pg_net');
```

On project `gtszuofampswpgwtglaj` both were already installed as of 16 Aug 2026 (pg_cron
1.6.4, pg_net 0.20.4), so the two statements above are no-ops there. Run them anyway — they
are the prerequisite for a fresh project and they cost nothing on an old one.

### 3.2 Schedule the tick

```sql
select cron.schedule(
  'class-manager-tick',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://<your-domain>/api/cron/tick',
      body := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer <CRON_SECRET>'
      ),
      timeout_milliseconds := 300000
    )
  $$
);
```

The job name is the key: re-running the same `cron.schedule` call with a changed URL or a
rotated secret replaces the job in place rather than adding a second one.

**`timeout_milliseconds` is the single most likely thing to break this silently, and it is
the argument everyone omits.** `net.http_post` defaults it to **5000** — five seconds. That
is a sane default for a webhook ping and a bad one for this endpoint, because the tick is not
a ping. It runs `planAhead()`, then `runDueJobs()`, which claims a batch and executes the
real handlers — and an `agent_task` handler calls DeepSeek, whose own client timeout is a
hundred and twenty seconds — and then `drainWebhookEvents()`. Three model-backed jobs in one
beat is an ordinary Tuesday, and at reminder time dozens come due at once. Five seconds is
not a margin; it is a coin flip.

What makes it *silent* is which half gives up. pg_net abandons the socket and writes a
timeout into `net._http_response`, but the Vercel function keeps running to completion. So
the only log you were watching says the tick failed while the work in fact happened — and
the obvious response to that, ticking harder, produces overlapping ticks instead of a fix.
When the abort does reach the function, the tick is cut off mid-run and leaves claimed job
rows `running` and locked for the full fifteen-minute reclaim window; each reclaim burns one
of the three attempts a job gets (`MAX_ATTEMPTS` in `lib/jobs/runner.ts`), so three timed-out
ticks can mark a perfectly healthy reminder permanently failed.

**The rule is that the timeout must be at least the route's own declared `maxDuration`.**
`app/api/cron/tick/route.ts` exports `maxDuration = 300`, so the value above is `300000`.
Anything less reports failure for work the function is still legitimately doing, which is the
one outcome this whole section exists to prevent — and picking a number below the ceiling on
the grounds that ticks are "usually" fast just moves the coin flip to the busy minutes, which
are exactly the ones that matter. If you ever lower `maxDuration`, lower this with it; if you
raise it, raise this first.

**The `headers` argument replaces the default; it does not merge with it.** pg_net's default
is `{"Content-Type": "application/json"}`, and passing an object containing only
`Authorization` silently drops the content type — which a route that parses a JSON body may
then reject. Both keys are in the call above on purpose.

### 3.3 Keeping the secret out of `cron.job`

`cron.schedule` stores the command verbatim, so the plain form above leaves `CRON_SECRET`
readable to anyone who can `select * from cron.job`. If that matters, put it in Vault
(`supabase_vault` is already installed) and read it back at fire time:

```sql
select vault.create_secret('<CRON_SECRET>', 'class_manager_cron_secret', 'Bearer token for /api/cron/tick');

select cron.schedule(
  'class-manager-tick',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://<your-domain>/api/cron/tick',
      body := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets
          where name = 'class_manager_cron_secret'
        )
      ),
      timeout_milliseconds := 300000
    )
  $$
);
```

### 3.4 Inspecting it — and why two of the three logs lie to you

```sql
-- Is the job registered and active?
select jobid, jobname, schedule, active from cron.job where jobname = 'class-manager-tick';

-- Did pg_cron fire? (See the caveat below before believing this.)
select d.start_time, d.status, d.return_message
from cron.job_run_details d
join cron.job j on j.jobid = d.jobid
where j.jobname = 'class-manager-tick'
order by d.start_time desc
limit 20;

-- Did the HTTP call actually land?
select id, status_code, error_msg, created
from net._http_response
order by created desc
limit 20;
```

`cron.job_run_details.status = 'succeeded'` means **the SQL command succeeded**. The command
is `select net.http_post(...)`, which succeeds the instant the request is queued inside
pg_net — before a single packet leaves the database. A cron log that is green for a week is
entirely consistent with a deployment that has been answering 401 the whole time. Treat this
table as evidence that the *schedule* is alive, nothing more.

`net._http_response` is one step closer to the truth: `status_code = 200` means Vercel
answered. But pg_net garbage-collects that table after a few hours, so it is a short rolling
buffer and not an audit trail.

**The real log is the application's own — `tick_runs`**, written by the cron route inside the
same request as the work it describes. It is the only record that says what the tick *did*
rather than that something was asked to happen:

```sql
select * from tick_runs order by started_at desc limit 20;
```

`0029_tick_runs.sql` defines the columns: `started_at` / `finished_at` (wall time, not
`app.now()`), `duration_ms`, the `ran` / `skipped` / `failed` counters, `planned`, the whole
`log`, and `error` — null on success, set when the tick threw and the counters are therefore
partial rather than final.

**If `cron.job_run_details` is green and `tick_runs` is empty, check these in order:**

1. **0029 has not been pushed to this database.** This is the first thing to rule out and the
   easiest to miss, because it is the one cause with no symptom anywhere else: `recordTick`
   is contractually forbidden from throwing (§1.2), so a missing table leaves the beat
   answering 200 with a healthy `net._http_response` and nothing written. Vercel → the
   deployment → Logs, and look for `[tick-log] could not record the tick`. If it is there,
   run `npm run db:push` (§1.2) and the next beat writes a row.
2. **The request is not arriving at all.** Check the URL, the bearer token, and that
   `/api/cron/tick` is not behind the ops gate — `middleware.ts` keeps `/api/cron` outside
   its matcher on purpose, and a widened matcher is the way that changes.
3. **The secret does not match.** A 401 in `net._http_response` says so directly; the route
   refuses before it records anything, deliberately, so that an unauthenticated caller cannot
   insert rows.

Finally, `tick_runs` grows about 1,440 rows a day and nothing trims it. `0029_tick_runs.sql`
writes the prune down and deliberately does not run it — a migration is re-runnable, so a
`db:push` that deleted history as a side effect of touching the schema would be a trap. It
belongs here instead, next to the beat it prunes, so that anyone reading the schedule sees
both:

```sql
select cron.schedule(
  'class-manager-tick-prune',
  '17 3 * * *',
  $$ delete from tick_runs where started_at < now() - interval '14 days' $$
);
```

Two weeks is far more history than anyone reads. This one is genuinely optional — a year of
rows is untroubling for Postgres — but unbounded growth on a database nobody is watching is
the property that eventually matters.

### 3.5 Unschedule

```sql
select cron.unschedule('class-manager-tick');
select cron.unschedule('class-manager-tick-prune');   -- only if you scheduled it
select count(*) from cron.job where jobname like 'class-manager-%';  -- expect 0
```

### 3.6 If you upgrade to Pro

Vercel Cron gains minute granularity on Pro, at which point the beat can move into the
platform. Add to `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": "nextjs",
  "regions": ["bom1"],
  "crons": [
    { "path": "/api/cron/tick", "schedule": "* * * * *" }
  ]
}
```

Two things to know before you do. **Unschedule the pg_cron job first** (§3.5), or every
minute is ticked twice; overlapping ticks are not corrupting — planning is
`on conflict do nothing` and job claiming is atomic under `for update skip locked` — but they
double the compute bill and halve the useful concurrency. And **Vercel Cron invokes the path
with a GET**, sending `Authorization: Bearer $CRON_SECRET` automatically from the environment
variable of that name, whereas pg_net POSTs. `/api/cron/tick` already exports both verbs onto
one handler for exactly this reason, so the switch needs no code change — but note that
Vercel Cron has no `timeout_milliseconds` equivalent to get wrong, and no `tick_runs`
equivalent either: the function's own logs and §3.4's table remain the record.

---

## 4. Wiring WhatsApp: the sender row first, then the webhook

Inbound and outbound are configured in two completely different places, and only one of them
is on Vercel. Do them in this order — a deployment that does the second half only can
*receive* every message a parent sends and cannot send a single reply.

### 4.1 Write the Cloud credentials into the `sender` row

Setting `WHATSAPP_ACCESS_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` on Vercel does **not** give
the app the ability to send. Nothing in `lib/` reads those two: §16.3 puts per-sender
credentials in the database, on the `sender` row, and `lib/messaging/send.ts` loads them by
joining `academy → sender` and caching what it finds there. With `TRANSPORT=cloud` and no
credentials on that row, every outbound hard-fails at the credential gate. Those two
variables exist on the deployment only because `scripts/wa-cloud.ts` reads them; the app
reads the row.

`npm run wa -- link` is what writes the row:

```bash
npm run wa -- link         # sender.credentials + point every academy at that sender
npm run wa -- templates    # provision the message templates on a fresh WABA
```

**The sharp edge is which database it writes to.** `link` goes through `lib/db.ts` like
everything else, so it targets whatever `DATABASE_URL` your workstation's `.env.local`
resolves to — not the Vercel project you are deploying. Point that variable at the production
Supabase project (the §1.1 `cm_runtime` URL) for the duration of the command and then put it
back, or run it with the URL inline. Running `link` against your local database and then
wondering why production cannot send is the ordinary way to lose an afternoon.

`link` also repoints every academy at the sender it just wrote, which is what makes inbound
resolve against the number Meta actually delivered on.

**Re-run `link` after any seed.** `resetWorld()` does `delete from sender`, taking the Cloud
credentials with it — which is the same fact that makes seeding a production deployment
unsurvivable (§5), seen from the other side. `npm run wa -- status` prints whether the row is
populated, so use it as the check.

### 4.2 Register the callback URL with Meta

The callback URL is `https://<your-domain>/api/webhook` and the verify token is whatever
`WHATSAPP_VERIFY_TOKEN` is set to on the deployment, character for character.

The repo has its own tool for this, which is easier to get right than the dashboard:

```bash
npm run wa -- webhook https://<your-domain>    # register the callback URL
npm run wa -- subscribe                        # put this app on the WABA
npm run wa -- status                           # verify the whole picture
```

It runs from your workstation and reads `.env.local`, so `WHATSAPP_APP_ID`,
`WHATSAPP_APP_SECRET` and `WHATSAPP_VERIFY_TOKEN` must be set there — Meta refuses the
subscription endpoint to a user token, however wide its scopes, and answers `(#190)
Application Secret required`. The `subscribe` step is separate and easy to skip: without it,
webhooks fire somewhere other than this app and nothing arrives, with no error anywhere to
tell you so.

Meta calls the URL with `hub.challenge` **before** it will accept it, so the deployment must
already be live and `/api/webhook` must answer anonymously. Two things break that: an ops
middleware matcher that accidentally covers the path, and Vercel Deployment Protection.
Verify from outside, with no cookie:

```bash
curl -i "https://<domain>/api/webhook?hub.mode=subscribe&hub.verify_token=<WHATSAPP_VERIFY_TOKEN>&hub.challenge=42"
# expect 200 with a body of exactly: 42

curl -i -X POST https://<domain>/api/webhook -d '{}'
# expect 401 "missing signature" — which proves both that it is reachable and that it
# authenticates itself rather than relying on anything in front of it
```

Never point Meta at a preview URL. Preview deployments are protected by default on Hobby, and
they come and go.

---

## 5. The sandbox deployment

The scenario drives, the seeder and the fault panel are genuinely useful and they must live
somewhere. That somewhere is a **second Vercel project, from the same repository, with
`OPS_SANDBOX=1` and a `DATABASE_URL` pointing at a different Supabase project.**

> **The two deployments must never share a database. This is not a hygiene preference.**
>
> One click on *seed* in the console calls `resetWorld()`, which enumerates every academy the
> database has — not the two fixture UUIDs, every academy — deletes them all by cascade, and
> then runs `delete from job`, `delete from sim_fault` and `delete from sender`. That
> destroys the real business, every real parent conversation, and the `sender` row holding
> the live WhatsApp Cloud credentials, which takes the transport offline as well as the data.
> There is no undo and no confirmation beyond a browser dialog.
>
> Seeding is only the loudest of them. `sim_fault` rows have no academy column at all, so
> arming `send_fail` in the sandbox breaks outbound delivery for the real tenant. The world
> clock row is inherited by every academy that has no row of its own — which is every real
> academy — so advancing time in the sandbox moves domain time for production and then runs
> the whole job ladder at the fabricated hour. And the console's composer posts as the
> *contact*, so typing in a pane writes an inbound message in a real parent's name, reopens
> the paid 24-hour window, and runs a real agent turn that can reply to them over the live
> number.

Set the sandbox up like this:

- A **separate Vercel project**, not a preview branch. Vercel's environment variables are
  scoped per environment, and a Preview deployment inherits every variable whose scope
  includes Preview. Getting `OPS_SANDBOX=1` into the Preview scope while `DATABASE_URL` is
  still the production value is one checkbox away, and it is precisely the configuration that
  destroys the business. A separate project cannot make that mistake, because it has its own
  variable set from top to bottom.
- `DATABASE_URL` → a **different Supabase project**, set up exactly as §1.1 and §1.2 describe:
  `create role cm_runtime login password …` and the three grants first, *then*
  `npm run db:push`. Skipping the role is the failure that looks like a broken migration —
  `0006_grants.sql` stops with `role "cm_runtime" does not exist` — and the temptation at
  that point is to paste the dashboard's `postgres` URL and move on, which gives the sandbox
  a superuser connection and defeats the point of testing against the same RLS the real
  deployment runs under.
- `TRANSPORT=emulator`, so nothing reaches a handset even if real credentials find their way
  in. The production number is live and externally visible; a stray send is not a private
  mistake.
- `OPS_SANDBOX=1`, set **last**, after you have re-read the `DATABASE_URL` you just pasted.
- A **different `OPS_SECRET`**, so a sandbox session cannot be replayed against production.
- **No pg_cron job** pointed at it, unless you schedule one from the sandbox's own database.

Before you trust it, load the sandbox console and confirm the header reports sandbox mode,
then load production and confirm it does not. `/api/ops/config` reports both, and the
destructive controls are hidden when it says production — but the hiding is cosmetic. The
server-side refusal is the boundary, and it keys on `OPS_SANDBOX === '1'` exactly, so `0`,
`false` and unset all mean production.

---

## 6. Rollback

Stop the beat before you touch anything else, or the minute tick keeps hammering whatever is
half-deployed while you work.

1. **Unschedule the cron.**
   ```sql
   select cron.unschedule('class-manager-tick');
   ```
2. **Roll the deployment back.** Vercel → Deployments → the last known-good production
   deployment → Instant Rollback, or `vercel rollback <deployment-url>`. This re-promotes an
   existing build and takes effect in seconds; there is no rebuild and therefore no risk of
   the rollback itself failing to compile.
3. **If the cause was an environment variable, redeploy.** Changing a variable does *not*
   affect deployments that are already built. Editing the value and waiting is the most
   common false rollback — the running deployment will never notice. Change it, then trigger
   a new deployment.
4. **If Meta must stop delivering**, point the callback elsewhere with
   `npm run wa -- webhook https://<old-host>`, or clear the callback URL in Meta → WhatsApp →
   Configuration. Do not simply leave a dead URL registered: Meta retries a failing endpoint
   for a while and then disables the subscription, and re-enabling it is a manual step you
   will not be expecting.
5. **Kill switches that need no rollback at all.** Rotating `OPS_SECRET` and redeploying ends
   every console session at the next request. Rotating `CRON_SECRET` stops the tick as soon
   as the deployment carries the new value — and remember to re-run the `cron.schedule` call
   from §3.2 with the new secret, since the old one is baked into the job's command text.
6. **When you are back**, re-run §3.2 to restore the beat, and confirm with `tick_runs` (§3.4)
   rather than with `cron.job_run_details`, which will report success either way.

-- =============================================================================
-- 0029_tick_runs.sql — the production beat leaves evidence.
--
-- On localhost the scheduler is driven by hand and its report comes straight
-- back in the response, to an operator who is already looking at it. In
-- production nobody is looking: Supabase pg_cron pokes /api/cron/tick once a
-- minute through pg_net, whose `http_post` is asynchronous and fire-and-forget
-- — it never reads the reply, and there is no console it could print to. So the
-- one call that drives the whole product's clockwork would run with its report
-- addressed to nobody, and §13 rule 3 ("a job that did not run is invisible
-- failure") would become true of the runner itself: the beat could stop for a
-- day and the only symptom anyone saw would be reminders that never arrived.
--
-- This table is the address that report goes to instead. One row per tick.
--
-- The three RunReport counters are columns rather than fields inside `log`,
-- because the questions actually asked of this table are aggregates — "has
-- anything failed since this morning", "when did the beat last land", "is the
-- p95 creeping toward the function's 300 s ceiling" — and those must not
-- require a jsonb scan over six weeks of rows. The log itself is kept whole and
-- unsummarised, because the useful half of any failure is the line before it.
--
-- TIME: `started_at` / `finished_at` are WALL time, not `app.now()`, and that is
-- deliberate — the same exemption 0027 grants `sender` and `sim_clock`. This
-- table records when the platform's cron actually fired, which is a fact about
-- the world and not about any tenant's domain clock; in a driven world the sim
-- clock runs weeks ahead, and a tick log stamped in domain time would order its
-- own history wrongly and make `duration_ms` disagree with its own endpoints.
-- Both columns are written explicitly by `recordTick`, so the defaults below are
-- only a fallback — which also means a re-run of 0027 (whose DO block sweeps
-- every timestamptz column defaulting to `now()` and does not know this table's
-- name) can rewrite the default without corrupting a single row.
--
-- RETENTION: at one tick per minute this table gains ~1,440 rows a day, ~43,200
-- a month, ~525,000 a year. The rows are small and the index is one column, so
-- a year is untroubling for Postgres — but it is unbounded growth on a database
-- nobody is watching, and unbounded is the property that eventually matters.
-- Two weeks is far more history than anyone reads, so the prune is:
--
--     delete from tick_runs where started_at < now() - interval '14 days';
--
-- It is written here and deliberately NOT executed and NOT scheduled. A
-- migration is re-runnable (`npm run db:push` is a no-op on a current database)
-- and must therefore never delete anything: a push would silently destroy
-- history as a side effect of touching the schema. Scheduling it belongs with
-- the pg_cron job that calls the endpoint, next to the every-minute beat, where
-- someone reading the schedule can see both.
--
-- Re-runnable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The table. Global infrastructure, no `academy_id`: a tick claims across every
-- tenant at once (§6.6, the same reason `job` carries none), so there is no one
-- academy this row could belong to.
-- -----------------------------------------------------------------------------
create table if not exists tick_runs (
  id          uuid primary key default gen_random_uuid(),
  -- uuid, not a bigint identity, because every table in this schema is uuid-pk
  -- (§6, 0002) and one table that numbers itself differently is a table every
  -- future join has to be told about.
  started_at  timestamptz not null default now(),
  finished_at timestamptz,          -- null only if the row was written by a
                                    -- caller that died mid-tick; nothing does
                                    -- that today, and a null here means one did
  duration_ms integer,
  ran         integer not null default 0,
  skipped     integer not null default 0,
  failed      integer not null default 0,
  planned     jsonb,                -- whatever planAhead() returned; a bare
                                    -- count today, a shape tomorrow
  log         jsonb,                -- RunReport.log, plus the ingest drain's own
                                    -- lines tagged `webhook: `, as one array
  error       text                  -- null on success. Set means the handler
                                    -- threw and the tick is incomplete — the
                                    -- counters above are then partial, not final
);

-- "Show me the last 50 ticks" and "has anything failed since 09:00" are the only
-- two reads this table has, and both walk backwards from now.
create index if not exists tick_runs_started_at_idx on tick_runs (started_at desc);

comment on table tick_runs is
  'One row per production cron tick (/api/cron/tick). Wall-clock stamps, not app.now(). '
  'Grows ~43,200 rows/month at one tick per minute; prune with '
  'delete from tick_runs where started_at < now() - interval ''14 days'' — not scheduled here.';

-- -----------------------------------------------------------------------------
-- RLS. Infrastructure, so cm_service and nobody else: with RLS enabled and no
-- policy for cm_user/cm_readonly, those two roles are denied everything, which
-- is the intent (§6.7, and the note at the head of 0003). The meta-test in
-- `scripts/rls-check.mjs` fails the build on any table with RLS off, so this is
-- not optional for a new table.
-- -----------------------------------------------------------------------------
alter table tick_runs enable row level security;

drop policy if exists tick_runs_cm_service_all on tick_runs;
create policy tick_runs_cm_service_all on tick_runs
  for all to cm_service using (true) with check (true);

-- 0002 and 0006 both set default privileges, so these are belt and braces for a
-- database where this table lands under a different owner. `delete` is granted
-- so the retention prune above can run as the runtime's own role rather than
-- needing the migration login.
grant select, insert, delete on tick_runs to cm_service;

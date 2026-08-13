-- A clock per business, so two tenants can be held at different moments.
--
-- `sim_clock` was a singleton by construction — `singleton boolean unique check
-- (singleton)`, no `academy_id` — and `app.now()` read `(select offset_ms from
-- sim_clock limit 1)`. One offset, one world. Everything that reads domain time
-- goes through it, so advancing the clock in one session moved the world for
-- every other session against the same database.
--
-- That is the single thing blocking parallel driving. Two agents exploring at
-- once move each other's world: one advances four hours to reach a session, the
-- other's jobs fire early, decline as stale, or never fire at all — and the
-- transcripts read calm, because a job that correctly declines looks exactly
-- like a job with nothing to do. It also means a mature academy and a
-- brand-new one cannot be held at different lifecycle stages at the same
-- moment, which is precisely how you would test that they behave differently.
--
-- **Null `academy_id` is the global default, and it stays the default.** With no
-- per-academy row anywhere, every query below resolves exactly as it did before:
-- one offset, one world, byte-identical behaviour. A tenant clock is opt-in and
-- costs nothing until somebody sets one.
--
-- THE THREE THINGS THIS TOUCHES, because a clock is not just a column
-- ---------------------------------------------------------------------------
--   1. `app.now()`      resolves the tenant's row first and falls back to the
--                       global one. Every policy and nearly every query calls
--                       this, so it must stay cheap — see the note on cost below.
--   2. `app.now_for()`  the same resolution for a tenant you name rather than
--                       the one your session is pinned to. The job runner needs
--                       this: a job carries its tenant in `payload->>'academy_id'`
--                       and is claimed by an infra session pinned to no tenant
--                       at all, so `app.now()` would give it the global clock and
--                       one tenant's clock would run another tenant's jobs.
--   3. `next_event_at`  "jump to the next thing that happens" is now a question
--                       about one tenant, so it takes an optional academy and
--                       compares each job against ITS OWN clock.
--
-- COST, measured rather than assumed
-- ---------------------------------------------------------------------------
-- `app.now()` goes from one scan of a one-row table to at most two scans of a
-- table that holds one row per tenant plus one — eight rows in the shared world.
-- Both are index-backed by the partial unique indexes below. The function stays
-- `stable`, so Postgres still evaluates it once per statement rather than once
-- per row, which is what actually matters here: it is the per-row cost that
-- would have been fatal in an RLS policy, and there is none.

alter table sim_clock
  add column if not exists academy_id uuid references academy (id) on delete cascade;

comment on column sim_clock.academy_id is
  'Whose clock this is. NULL is the world clock and the fallback for every tenant '
  'without one of their own — so a database with no per-academy rows behaves '
  'exactly as it did when sim_clock was a singleton.';

-- The singleton constraint has to go: it is what said "there can be only one".
-- Two partial unique indexes replace it, and together they say the honest rule —
-- at most one global row, at most one row per academy.
alter table sim_clock drop constraint if exists sim_clock_singleton_key;
alter table sim_clock drop constraint if exists sim_clock_singleton_check;

create unique index if not exists sim_clock_global_key
  on sim_clock (singleton) where academy_id is null;

create unique index if not exists sim_clock_academy_key
  on sim_clock (academy_id) where academy_id is not null;

-- ---------------------------------------------------------------------------
-- Resolution, in one place, used by both functions.
-- ---------------------------------------------------------------------------

create or replace function app.now_for(p_academy uuid) returns timestamptz
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select now()
         + (coalesce(
              (select sc.offset_ms from sim_clock sc where sc.academy_id = p_academy),
              (select sc.offset_ms from sim_clock sc where sc.academy_id is null),
              0
            )::double precision * interval '1 millisecond')
  $$;

comment on function app.now_for(uuid) is
  'Domain time as one named tenant sees it: their own offset, else the world offset, '
  'else real time. `p_academy` NULL resolves to the world clock, which is what an '
  'infra session with no tenant GUC should get.';

-- `app.now()` is now `app.now_for` of whoever this session is. Unchanged for
-- every caller, and there are hundreds — it is called by nearly every policy.
create or replace function app.now() returns timestamptz
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select app.now_for(app.academy_id())
  $$;

-- ---------------------------------------------------------------------------
-- "The next moment anything happens" is a per-tenant question now.
-- ---------------------------------------------------------------------------
--
-- The old version compared every pending job and every session against one
-- instant. With per-tenant clocks that is wrong in the direction that wastes a
-- driver's time: it would report an event as next when that tenant's own clock
-- has already passed it, and `drive clock --next` would step somewhere useless.
--
-- `p_academy` NULL keeps the old whole-world behaviour, which is what the
-- emulator's global "jump to next event" still wants.
create or replace function app.next_event_at(p_after timestamptz, p_academy uuid default null)
  returns timestamptz
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select least(
      (select min(j.run_at) from job j
        where j.status = 'pending' and j.run_at > p_after
          and (p_academy is null or (j.payload->>'academy_id')::uuid = p_academy)),
      (select min(s.starts_at - interval '60 minutes') from session s
        where s.status = 'scheduled'
          and s.starts_at - interval '60 minutes' > p_after
          and (p_academy is null or s.academy_id = p_academy))
    )
  $$;

grant execute on function app.now_for(uuid) to cm_service, cm_user, cm_readonly;
grant execute on function app.next_event_at(timestamptz, uuid) to cm_service;

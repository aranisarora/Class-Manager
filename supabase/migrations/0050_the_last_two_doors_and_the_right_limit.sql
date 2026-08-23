-- =============================================================================
-- 0050_the_last_two_doors_and_the_right_limit.sql
--
-- Two repairs to 0044, found by a line review of its own window.
--
-- 1 · THE LAST TWO DOORS
-- ---------------------------------------------------------------------------
-- 0044 shut the eight named cross-tenant doors and its header asserted
-- "everything else in schema app answers about the caller's own tenant, or is
-- a trigger body." That was false for exactly two functions, both SECURITY
-- DEFINER over the global `job` table, both left executable by cm_user and
-- cm_readonly through the same 0004/0006 blanket grants 0044 exists to walk
-- back:
--
--   app.claim_jobs    returns setof job, MUTATES status/locked_by, no academy
--                     filter — a single `select app.claim_jobs(1000,'x')` from
--                     the model's own write path reads every tenant's job
--                     payloads and marks every pending job 'running'. It has no
--                     caller at all: lib/jobs/runner.ts claims with its own SQL.
--   app.enqueue_job   inserts into `job`, whose only RLS policy is cm_service.
--                     Its one caller (lib/agent/memory.ts) runs as cm_service.
--
-- cm_service-only, the same loop 0044 used, so the revoke survives signature
-- changes the way 0044's does.
-- =============================================================================

do $$
declare
  r record;
  doors text[] := array[
    'claim_jobs',   -- the global queue, claimed
    'enqueue_job'   -- the global queue, written
  ];
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app'
       and p.proname = any (doors)
  loop
    execute format('revoke all on function %s from public, cm_user, cm_readonly', r.sig);
    execute format('grant execute on function %s to cm_service', r.sig);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2 · THE RIGHT LIMIT
--
-- `app.emulator_poll`'s status-delta branch capped on `p_limit` (the message
-- limit) where its sibling branch correctly uses `p_status_limit`. Latent only
-- because today's one caller passes the same value for both; a caller that set
-- them apart would silently drop status deltas in a burst, under a strict
-- `status_seq > cursor` that never re-offers them. One word is wrong; editing an
-- applied migration is not how this repo fixes one (0047 records the rule), so
-- the full function is restated here, 0044's verbatim except that bound.
-- ---------------------------------------------------------------------------

create or replace function app.emulator_poll(
  p_since        timestamptz,
  p_status_since bigint,
  p_limit        int default 200,
  p_status_limit int default 200
) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
  as $$
  with msg as (
    select m.id, m.created_at, m.academy_id, a.name as academy_name, m.contact_id,
           p.full_name as contact_name, m.direction, m.catalog_id, m.template_name,
           m.in_window, m.status, m.cost_paise, m.conversation_category,
           m.suppressed_reason, m.failed_reason, s.phone_e164 as sender_phone,
           left(coalesce(m.body, ''), 200) as body
      from message m
      join academy a on a.id = m.academy_id
      join contact c on c.id = m.contact_id
      join person  p on p.id = c.person_id
      join sender  s on s.id = m.sender_id
     where m.created_at > p_since
     order by m.created_at asc
     limit p_limit
  ),
  trn as (
    select t.id, t.created_at, t.academy_id, a.name as academy_name, t.contact_id,
           p.full_name as contact_name, t.role_acted, t.model, t.prompt_tokens,
           t.output_tokens, t.cached_tokens, t.latency_ms, t.error
      from turn t
      join academy a on a.id = t.academy_id
      left join person p on p.id = t.person_id
     where t.created_at > p_since
     order by t.created_at asc
     limit p_limit
  ),
  jb as (
    select j.id, j.created_at, j.kind, j.status, j.run_at, j.dedupe_key,
           j.attempts, j.last_error
      from job j
     where j.created_at > p_since
     order by j.created_at asc
     limit p_limit
  ),
  st as (
    select * from (
      select m.id, m.contact_id, m.academy_id, m.status, m.sent_at, m.delivered_at,
             m.read_at, m.failed_reason, m.suppressed_reason, m.status_seq
        from message m
       where p_status_since is null
       order by m.status_seq desc
       limit p_status_limit
    ) newest
    union all
    select * from (
      select m.id, m.contact_id, m.academy_id, m.status, m.sent_at, m.delivered_at,
             m.read_at, m.failed_reason, m.suppressed_reason, m.status_seq
        from message m
       where p_status_since is not null and m.status_seq > p_status_since
       order by m.status_seq asc
       limit p_status_limit
    ) since_cursor
  )
  select jsonb_build_object(
    'messages',      coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at asc) from msg m), '[]'::jsonb),
    'turns',         coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at asc) from trn t), '[]'::jsonb),
    'jobs',          coalesce((select jsonb_agg(to_jsonb(j) order by j.created_at asc) from jb  j), '[]'::jsonb),
    'statuses',      coalesce((select jsonb_agg(to_jsonb(s) order by s.status_seq asc) from st  s), '[]'::jsonb),
    'status_cursor', coalesce((select max(s.status_seq) from st s), p_status_since),
    -- THE EVENT CURSOR, AT FULL PRECISION, AND THAT IS THE WHOLE POINT OF IT.
    --
    -- The caller used to derive it by taking the newest event's `at`, which is
    -- `new Date(created_at).toISOString()` — MILLISECONDS. `created_at` is a
    -- timestamptz and carries microseconds, so `created_at > $cursor` stayed true
    -- for the very row the cursor was taken from, and that row was re-emitted on
    -- every poll, every 600 ms, forever. Measured on this database: one event
    -- returned on a tick where nothing had happened, on every tick, indefinitely.
    --
    -- Same clipping semantics as before, deliberately: this is the max over the
    -- rows actually RETURNED, so a surface that hit `p_limit` resumes from its own
    -- last row on the next tick.
    'event_cursor', greatest(
      (select max(m.created_at) from msg m),
      (select max(t.created_at) from trn t),
      (select max(j.created_at) from jb  j)
    ),
    'offset_ms',     coalesce((select sc.offset_ms from sim_clock sc where sc.academy_id is null), 0),
    -- The world clock, resolved once here rather than in a second transaction of
    -- its own. `app.now_for(null)` is the same resolution every tenant-scoped
    -- default uses, so the console and the rows agree about what time it is.
    'now',           app.now_for(null)
  )
  $$;

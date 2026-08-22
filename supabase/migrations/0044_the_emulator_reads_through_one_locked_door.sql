-- =============================================================================
-- 0044_the_emulator_reads_through_one_locked_door.sql — the console's read, and
-- the lock that was never on the door it goes through.
--
-- Two things, and the order matters: the second one widens a cross-tenant door,
-- so the first one has to make the doors actually shut.
--
-- THE DOORS WERE NEVER SHUT
-- ---------------------------------------------------------------------------
-- 0007_emulator.sql:9-11 states the model's reach in plain words:
--
--   "A user session (cm_user / cm_readonly) cannot execute them, so the agent
--    can never reach them: the widest thing the model can see is still one
--    tenant."
--
-- That has never been true in a deployed database. `revoke all ... from public`
-- (0007:73-74) removes the PUBLIC grant and nothing else, and two statements
-- hand the roles an explicit one that outlives it:
--
--   0004_functions.sql:309  grant execute on all functions in schema app
--                             to cm_service, cm_user, cm_readonly;
--   0006_grants.sql:31-32   alter default privileges in schema app
--                             grant execute on functions to <the same three>;
--
-- The second is the one that keeps doing it: every `app.*` function created by
-- a later migration is born with cm_user and cm_readonly EXECUTE already on it,
-- and the door's own revoke never mentions them. Measured on 22 Aug 2026, all
-- thirty-nine `security definer` functions in schema `app` were executable by
-- cm_readonly. Every one.
--
-- What that costs, concretely. `read` composes raw SQL and runs it as
-- cm_readonly; `assertSingleReadStatement` (lib/db.ts:821) asks only that it is
-- one statement beginning `select` or `with`, and imposes no schema or table
-- restriction. So `select * from app.list_academies()` is a legal `read`, and it
-- answered with twelve academies -- every tenant on the deployment. The next
-- statement, `select * from app.emulator_contacts()`, returns every contact's
-- name and phone number across all of them. The reachable path starts at an
-- inbound WhatsApp message from a stranger.
--
-- The write doors were saved by an accident rather than by design:
-- `applySession` issues `set transaction read only` for the readonly role
-- (lib/db.ts:360), so `app.found_business` and `app.claim_jobs` abort rather
-- than run. That is a second line, not the first, and it is not the one anything
-- was relying on.
--
-- ARCHITECTURE.md, Layer 0: "RLS is the only security boundary ... Nothing above
-- this layer is security; everything above it is manners." A `security definer`
-- function is a hole punched through that boundary on purpose, and the grant is
-- the only thing that decides who may walk through it.
--
-- WHY A LOOP OVER NAMES AND NOT EIGHT REVOKE STATEMENTS
-- ---------------------------------------------------------------------------
-- A revoke names a signature. `app.found_business` has had three of them
-- (0039:561, 0040:277, 0042:95) and `app.next_event_at` has two live overloads
-- (0005:429, 0024:105). A hardcoded signature that stops matching does not fail
-- -- it silently revokes nothing, which is the same shape of quiet as the defect
-- above. Looping over `pg_proc` by NAME catches every overload that exists and
-- every one added later.
--
-- The policy helpers -- `app.now`, `app.now_for`, `app.is_admin`,
-- `app.my_player_ids` and the rest -- are deliberately untouched. Every RLS
-- policy in 0003 and 0028 calls them, and revoking those does not close a door,
-- it bricks the product.
--
-- Re-runnable.
-- =============================================================================


-- ---------------------------------------------------------------------------
-- 1 · Shut the doors.
--
-- The eight `app.*` functions that read or write ACROSS tenants. Everything else
-- in schema `app` answers about the caller's own tenant, or is a trigger body.
-- ---------------------------------------------------------------------------

do $$
declare
  r record;
  doors text[] := array[
    'list_academies',          -- every academy on the deployment
    'emulator_contacts',       -- every contact's name and phone, all tenants
    'businesses_on_sender',    -- the businesses behind one number
    'front_desk_for',          -- resolves a sender's arrivals hall
    'front_desk_contact',      -- find-or-create a person at the front desk
    'found_business',          -- CREATES a tenant
    'inbound_candidates',      -- matches a stranger against every tenant
    'academy_for_wa_message'   -- resolves a tenant from a wire id
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
-- 2 · A status cursor, and why it is a counter rather than a clock.
--
-- `pollWorld` re-read the newest sixty messages of every academy every 600 ms
-- whether anything had changed or not: 243,576 calls, 7,124,881 rows, 1.19 GB
-- of the 5.29 GB that put the organisation over its monthly egress quota. The
-- fix is a cursor, and the only real question is what the cursor counts.
--
-- NOT A TIMESTAMP. Both spellings are wrong, and both fail quietly:
--
--   `default app.now()` follows the TENANT clock (0027). Every drive winds that
--   forward -- a seven-day sim stamps rows a week ahead -- and the stream holds
--   ONE cursor for every tenant at once. The moment a sim runs, the cursor sits
--   in the future and the live business's real statuses, stamped at real time,
--   are all behind it and never stream again.
--
--   `default now()` follows the wall clock, which is honest here but would make
--   this the first wall-clock column on a tenant-scoped table and re-open the
--   confusion 0027 exists to remove -- a reader writing `status_at > app.now() -
--   interval '1 day'` gets a confident empty.
--
--   And either way `now()` is `transaction_timestamp()`, so a batch send stamps
--   every row it touches identically. A tie group straddling the row limit is
--   then skipped for good under a strict `>`.
--
-- A sequence has no clock in it, so it has none of those problems: monotone by
-- construction, unique per row, and immune to a clock that moves backwards.
-- `row_snapshot.seq` (0005:60) is the same choice on the same grounds.
--
-- The side channel, named rather than hidden: the sequence is global, so a
-- tenant reading gaps in its own `status_seq` can infer that OTHER tenants wrote
-- rows. It cannot infer what, whose, or for whom. Sequence caching makes the
-- gaps noisy anyway. That is a smaller price than a cursor that silently stops.
-- ---------------------------------------------------------------------------

create sequence if not exists message_status_seq;

alter table message add column if not exists status_seq bigint;
alter table message alter column status_seq set default nextval('message_status_seq');

-- Backfill in creation order so the existing rows carry a sequence consistent
-- with the order they actually happened in. Guarded, so a second push is a
-- no-op rather than a re-numbering.
update message set status_seq = nextval('message_status_seq')
 where status_seq is null;

alter table message alter column status_seq set not null;

create index if not exists message_status_seq_idx on message (status_seq);

-- The DEFAULT runs as the INSERTING role, so the grant is not optional.
grant usage, select on sequence message_status_seq to cm_service, cm_user;

comment on column message.status_seq is
  'Bumped every time this row''s delivery state moves, so the emulator stream can '
  'cursor statuses instead of re-reading the newest sixty per academy per tick. A '
  'counter and not a clock: the tenant clock runs ahead during a drive and the '
  'stream holds one cursor for every tenant at once. Ordering only -- it is not a '
  'time and must never be read as one.';

create or replace function app.stamp_message_status_seq() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
  begin
    new.status_seq := nextval('message_status_seq');
    return new;
  end
  $$;

-- The six columns the delivery ladder actually moves: `status` itself, the two
-- reason columns, and the three timestamps -- because `deriveStatus`
-- (lib/emulator/state.ts:532) renders from the TIMESTAMPS in preference to the
-- status column, so a change to one of those is a change the pane must see.
-- Writers: lib/messaging/send.ts:1128-1223 and app/api/emulator/delivery/route.ts.
drop trigger if exists message_status_seq_stamp on message;
create trigger message_status_seq_stamp
  before update on message
  for each row
  when (
       old.status            is distinct from new.status
    or old.failed_reason     is distinct from new.failed_reason
    or old.suppressed_reason is distinct from new.suppressed_reason
    or old.sent_at           is distinct from new.sent_at
    or old.delivered_at      is distinct from new.delivered_at
    or old.read_at           is distinct from new.read_at
  )
  execute function app.stamp_message_status_seq();


-- ---------------------------------------------------------------------------
-- 3 · One poll instead of 3N+2.
--
-- `pollWorld` ran one transaction per academy per surface -- messages, turns,
-- statuses -- plus a job read and a clock read, every 600 ms per open console.
-- At N=3 that is eleven transactions a tick, and a transaction is four network
-- round trips: 6,786 bytes per tick to report that nothing had happened. 7.0M of
-- 10.45M round trips in the billing cycle carried no data at all.
--
-- A plain cross-tenant SELECT cannot replace it. `message`, `turn` and `academy`
-- are all `using (academy_id = app.academy_id())` (0003:88, :183, :193), so a
-- session pinned to the bootstrap id matches no real row and returns ZERO rows
-- WITH NO ERROR -- the trap 0040:32-48 and 0030:69-75 both write down at length.
-- Only `job`, `sim_clock`, `sim_fault` and `sender` carry `using (true)`.
--
-- So it goes through the sanctioned shape instead: 0007's named door with the
-- lights on, revoked from every role but cm_service by section 1 above. This is
-- the fifth cross-tenant reader and the first one that has ever actually been
-- shut.
--
-- IT RETURNS ROWS, NOT AN EVENT SHAPE, AND THAT IS DELIBERATE.
-- The mapping from row to `WorldEvent` lives in lib/seed.ts and is consumed by
-- `app/api/emulator/stream/route.ts:64-76`, which emits `ev.type` verbatim as
-- the SSE event name, and by `normalizeEvent` (lib/emulator/state.ts:709), which
-- reads about twenty-five field names off it. Re-spelling any of that in SQL
-- would make this file the second author of a shape it does not own -- and the
-- failure mode is the console going quiet with no error anywhere. The column
-- names below are exactly the ones the existing queries select, so the existing
-- mappers keep working untouched.
--
-- `p_status_since` null means "first poll": the newest `p_status_limit` rows by
-- sequence, which is what a freshly-opened console used to get. After that it
-- cursors forward. A pane's own ladder is rendered from `threadFor`, not from
-- this stream, so this window only has to cover what changed while watching.
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
       limit p_limit
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

comment on function app.emulator_poll(timestamptz, bigint, int, int) is
  'Everything one tick of the emulator stream needs, across every tenant, in one '
  'statement -- the fifth cross-tenant door (0007), and cm_service only. Returns '
  'ROWS under `messages`/`turns`/`jobs`/`statuses` with the column names lib/seed.ts '
  'already maps; it deliberately does not re-spell the WorldEvent shape, because '
  'the client reads that shape by field name and a rename fails silently.';

revoke all on function app.emulator_poll(timestamptz, bigint, int, int)
  from public, cm_user, cm_readonly;
grant execute on function app.emulator_poll(timestamptz, bigint, int, int)
  to cm_service;


-- ---------------------------------------------------------------------------
-- 3a · Where a stream starts.
--
-- `latestCursor()` cost N+1 transactions and ran on every reconnect -- and
-- DEPLOY.md:215-219 says a reconnect is a fixed cadence, not an exception,
-- because Vercel kills the function at its duration cap. Same door, same lock,
-- one statement. Deliberately separate from `emulator_poll` rather than another
-- key on it: these are three unindexed maxima over whole tables, and paying for
-- them 100 times a minute to answer a question asked once per connection is the
-- shape of defect this migration exists to remove.
-- ---------------------------------------------------------------------------

create or replace function app.emulator_latest() returns timestamptz
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select greatest(
      (select max(m.created_at) from message m),
      (select max(t.created_at) from turn t),
      (select max(j.created_at) from job j)
    )
  $$;

comment on function app.emulator_latest() is
  'The newest created_at anywhere in the world -- where a fresh emulator stream '
  'starts so it does not replay history. cm_service only, like every other door.';

revoke all on function app.emulator_latest() from public, cm_user, cm_readonly;
grant execute on function app.emulator_latest() to cm_service;

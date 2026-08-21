-- =============================================================================
-- 0040_a_test_may_not_touch_a_real_business.sql — the queue gets a lane.
--
-- One database serves the deployed site and every local drive, and until this
-- migration the work queue had no notion of whose work it was. `claim()`
-- (lib/jobs/runner.ts) asked for two things — `status = 'pending'` and
-- `run_at <= app.now_for(...)` — and took whatever came back. The production
-- beat runs that query every sixty seconds. A local simulation runs its own
-- drain whenever a driver tells it to. Same list, no owner, and the beat checks
-- far more often, so the beat wins.
--
-- Two things go wrong when it does, and the second is the one that matters.
--
-- The drive learns nothing: it goes looking for the job it just enqueued and the
-- row is already `done`, stamped by a worker in another process. The run reads
-- calm and empty, which is indistinguishable from a product that correctly had
-- nothing to do — so a week of evidence quietly becomes a week of nothing, and
-- no assertion anywhere trips.
--
-- And the message is real. Production holds the live Meta Cloud credentials, so
-- a job invented by a test, describing a parent who does not exist, is executed
-- by a worker that can put text on an actual handset. That is not a slow test.
-- It is a test that can message people.
--
-- The workaround was `select cron.unschedule('class-manager-tick')` for the
-- length of the run. That works exactly while the database holds no real
-- business: the moment one academy is being served, stopping the beat for
-- fifteen minutes drops that academy's parents' messages, and the choice becomes
-- "break production" or "do not test". Neither is a policy. This migration
-- removes the choice by giving the two workers disjoint lists.
--
-- WHY THE LANE LIVES ON `job` AND NOT ON A JOIN TO `academy`
-- ---------------------------------------------------------------------------
-- The obvious spelling is to filter the claim against `academy.is_sandbox` (0030)
-- directly. It does not work, and it fails silently, which is worse than not
-- working.
--
-- `claim()` runs inside `withInfra` (lib/jobs/util.ts), pinned to the NIL uuid.
-- `academy_cm_service_all` is `using (id = app.academy_id())` (0003_rls.sql:88),
-- so that session matches no real academy row at all. A join to `academy` from
-- the claim returns ZERO rows with no error, and the filter built on it either
-- excludes every job or includes every job depending on which way it is written
-- — with nothing thrown either way. 0030's own header records this trap in
-- prose; this migration is what happens when you have to design around it.
--
-- `job_cm_service_all` is `using (true)` (0003_rls.sql:73), so the infra session
-- sees every job row. Therefore the lane goes on the row the claiming session can
-- actually read, and it is a plain text column rather than anything derived.
--
-- WHY A TRIGGER AND NOT A CALLER'S RESPONSIBILITY
-- ---------------------------------------------------------------------------
-- `enqueue()` and `enqueueMany()` are two call sites today and neither is the
-- last one anybody will write. A lane the caller passes is a lane a caller can
-- forget, and the default of a forgotten lane is `live` — which is to say the
-- forgotten case is the dangerous case, in a schema whose entire safety argument
-- (0030) is that the forgotten case must be the safe one.
--
-- So the stamp is a BEFORE INSERT trigger and there is no way to insert a job
-- without one. A caller that has never heard of lanes gets a correct lane. The
-- planner's bulk insert gets a correct lane. A handler enqueueing its own
-- successor gets a correct lane. Nothing has to remember.
--
-- The polarity is 0030's, deliberately: a job whose academy is unknown, missing,
-- or unmarked is `live`. Everything nobody explicitly made a toy is a real
-- business, and the cost of the schema being wrong about that is a test that runs
-- slowly rather than a tenant's queue that silently stops draining.
--
-- WHAT PROTECTS THE HANDSET IS NOT THIS COLUMN
-- ---------------------------------------------------------------------------
-- The lane stops production CLAIMING a simulated job. It says nothing about where
-- a message goes once some worker does run one, and it must not be read as if it
-- did — a lane is a scheduling fact. Two further barriers carry that half, and
-- they are independent of this one on purpose: `sender.is_sim` below binds the
-- transport to the number rather than to the `TRANSPORT` process variable, so a
-- simulated sender takes the emulator road whatever the environment says; and
-- `sender.credentials` has been per-number since §16.3, so a simulated sender
-- holds `{}` and the Cloud transport refuses it by name.
--
-- Re-runnable.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1 · The number says whether it is real.
-- ---------------------------------------------------------------------------
--
-- The lane has to be derived from something, and the something has to be a fact
-- nobody has to remember to state per run. The sender is that fact: a drive
-- already creates its own `sender` row for isolation (scripts/_world-file.ts),
-- production's number is a row somebody provisioned deliberately, and every
-- academy carries `sender_id`. So the toy-ness of a business is inherited from
-- the number it was founded on, and no harness has to reach into the product's
-- tables to stamp anything.
--
-- `not null default false` for 0030's reason, restated because it is the whole
-- security property: the live number predates this column and cannot be asked,
-- and it must come out of this migration as real. Spelled `is_real default true`
-- the identical omission would make a forgotten sender live, and the first
-- consequence would be a test messaging a parent.
alter table sender
  add column if not exists is_sim boolean not null default false;

comment on column sender.is_sim is
  'True only for a number a drive invented for itself. Businesses founded on it are born '
  'is_sandbox (app.found_business), their jobs are stamped lane=sim and the production beat '
  'never claims them, and the send path takes the emulator transport regardless of TRANSPORT. '
  'Default false, so the provisioned live number and anything nobody marked is real.';

-- The emulator's own sender is one of these and predates the column, so it is
-- named here rather than left to the default. It is not the live number: it is
-- `+918047182200` with `credentials = '{}'`, created on demand by
-- `createAcademy` (lib/seed.ts), and a send from it under `TRANSPORT=cloud` has
-- always failed with "no credentials cached for sender" because there is nothing
-- to cache. Every academy `drive`, `probe` and `probe:sql` builds lives on it.
--
-- Matched by `waba_id` rather than by phone or id, because that string is what
-- the emulator writes and the live row's is a real WABA id issued by Meta. The
-- provisioned Cloud number carries neither this waba_id nor this treatment.
update sender
   set is_sim = true
 where waba_id = 'WABA-EMULATOR-0001'
   and is_sim is distinct from true;

-- And the academies already standing on a simulated number, for the same reason
-- and by the same rule: from here on both creation paths derive `is_sandbox` from
-- the sender, so a row that predates them should read as though they had.
--
-- This runs BEFORE the job backfill below, and the order is load-bearing —
-- `app.lane_for` reads `academy.is_sandbox`, so a job re-stamped before its
-- academy is corrected would be stamped `live` and stay that way.
--
-- The direction is one-way on purpose. This can only ever mark a test academy as
-- a test academy; nothing here can flip a real business to sandbox, because no
-- real business is on a sender carrying `is_sim`. It is deliberately not written
-- as a general sync — that spelling would let a mistake on a sender row cascade
-- into `_danger.ts` and `ops-guard.ts` treating a paying tenant as scratch.
update academy a
   set is_sandbox = true
  from sender s
 where s.id = a.sender_id
   and s.is_sim
   and a.is_sandbox is distinct from true;

-- ---------------------------------------------------------------------------
-- 2 · Reading one academy's flag from a session pinned to no academy.
-- ---------------------------------------------------------------------------
--
-- Same shape and same reason as `app.now_for` (0024): a fact about one named
-- tenant, needed by an infra session that is deliberately pinned to none of them.
-- SECURITY DEFINER carries the read past `academy_cm_service_all`; `stable` because
-- it is a lookup, and the trigger below calls it once per inserted row.
--
-- Every uncertainty answers 'live' — a null argument, an academy that does not
-- exist, a payload with no tenant in it. See the polarity note in the header.
create or replace function app.lane_for(p_academy uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select case
             when p_academy is null then 'live'
             when coalesce((select a.is_sandbox from academy a where a.id = p_academy), false)
               then 'sim'
             else 'live'
           end
  $$;

comment on function app.lane_for(uuid) is
  'Which worker owns this tenant''s jobs: sim for a sandbox academy, live for everything '
  'else including an unknown or null tenant. SECURITY DEFINER because the claiming session '
  'is pinned to the NIL uuid and academy RLS is `using (id = app.academy_id())`, so an '
  'ordinary read of academy from there returns nothing with no error.';

revoke all on function app.lane_for(uuid) from public;
grant execute on function app.lane_for(uuid) to cm_service, cm_user, cm_readonly;

-- ---------------------------------------------------------------------------
-- 3 · The column, and the constraint that keeps it to two words.
-- ---------------------------------------------------------------------------
--
-- Metadata-only add: since Postgres 11 a default on an existing table is recorded
-- in the catalogue rather than written to every row, so this takes ACCESS
-- EXCLUSIVE for the length of a catalogue update and not a table scan. Safe with
-- the beat still running.
alter table job
  add column if not exists lane text not null default 'live';

-- A third spelling of the same idea is how two workers end up both ignoring a
-- job. `not valid` then `validate` so the check does not hold a strong lock
-- across a scan of the existing rows.
alter table job drop constraint if exists job_lane_known;
alter table job add constraint job_lane_known check (lane in ('live', 'sim')) not valid;
alter table job validate constraint job_lane_known;

comment on column job.lane is
  'Which worker may claim this row. Stamped by trigger from the academy in the payload '
  '(app.lane_for) and never by a caller. The production beat claims lane=live only; a '
  'drive''s drain claims lane=sim only. Without it both read one list filtered on nothing '
  'but pending-and-due, the beat wins every race because it runs every minute, and a test''s '
  'job is executed by the worker holding the live Cloud credentials.';

-- The claim orders by `run_at, created_at` inside a `where status = ... and lane = ...`,
-- so the lane leads. `app.now_for` per row means the run_at bound is not sargable
-- (0024 accepted that deliberately) — this index is what keeps the scan bounded to
-- one lane's pending rows rather than the whole table's.
create index if not exists job_lane_status_run_at on job (lane, status, run_at);

-- ---------------------------------------------------------------------------
-- 4 · The stamp nothing can forget.
-- ---------------------------------------------------------------------------
--
-- BEFORE INSERT so the value is decided before the row exists, and unconditional
-- so a caller that passes a lane does not get to keep it. That last part is not
-- pedantry: a caller confident enough to pass `live` is exactly the caller this
-- column exists to overrule.
--
-- ON UPDATE is deliberately NOT covered. A job moves through statuses constantly
-- and re-deriving the lane on every one of those writes would be a per-status
-- catalogue read for a fact that cannot legitimately change: an academy is a
-- sandbox at the moment it is founded and stays one. The backfill below handles
-- the migration-time case; a flip afterwards is an operator action, and the
-- re-stamp that goes with it is one statement, written into the comment.
create or replace function app.stamp_job_lane() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
  begin
    new.lane := app.lane_for((new.payload->>'academy_id')::uuid);
    return new;
  end;
  $$;

comment on function app.stamp_job_lane() is
  'BEFORE INSERT on job: derive lane from the payload tenant, overwriting whatever the '
  'caller passed. A lane a caller may set is a lane a caller may forget, and a forgotten '
  'lane is live — the dangerous value. Re-stamp after flipping an academy''s is_sandbox: '
  'update job set lane = app.lane_for((payload->>''academy_id'')::uuid) where status = ''pending'';';

drop trigger if exists job_lane_stamp on job;
create trigger job_lane_stamp
  before insert on job
  for each row execute function app.stamp_job_lane();

-- ---------------------------------------------------------------------------
-- 5 · Rows that already exist.
-- ---------------------------------------------------------------------------
--
-- Only `pending` is worth touching. A `done` job's lane is a fact about a race
-- that has already been settled, and rewriting it would make the historical
-- record claim an ownership that was never enforced when the row ran. Bounded to
-- pending so this stays cheap and re-runnable.
update job
   set lane = app.lane_for((payload->>'academy_id')::uuid)
 where status = 'pending'
   and lane is distinct from app.lane_for((payload->>'academy_id')::uuid);

-- ---------------------------------------------------------------------------
-- 6 · A business founded on a toy number is born a toy.
-- ---------------------------------------------------------------------------
--
-- This is the piece without which none of the above reaches a simulation.
--
-- A drive no longer builds fixtures: the world file is a sender, a front desk and
-- some people holding phones, and the BUSINESS is talked into existence by the
-- product through `app.found_business` (0039). So the `academy` row is written by
-- product code on the strength of a conversation, and the harness never touches
-- it — which means the harness cannot mark it, and until now every academy a
-- simulation created was `is_sandbox = false`: byte-identical to a real business,
-- indistinguishable to `_danger.ts`, to `ops-guard.ts`, and to the lane above.
--
-- The fix is inheritance rather than a stamp. This function already receives
-- `p_sender_id` and writes it onto the academy; it now also reads that sender's
-- `is_sim` and carries it across. Nothing in the harness changes, nothing in the
-- conversation changes, and there is no path that founds a business without
-- going through here.
--
-- Unchanged from 0039 except `v_sim` and the `is_sandbox` column in the insert.
-- Restated in full because `create or replace function` replaces a body rather
-- than patching one, and a diff of this against 0039 is the only review that
-- matters.
create or replace function app.found_business(
  p_academy_id   uuid,
  p_sender_id    uuid,
  p_name         text,
  p_category     text,
  p_founder_name text,
  p_phone_e164   text,
  p_profile_name text,
  p_arrival_id   uuid,
  p_at           timestamptz
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_person  uuid;
    v_contact uuid;
    v_sim     boolean;
  begin
    -- The sender is the authority on whether this is a real business, and it is
    -- read here rather than passed in: a caller-supplied flag is a flag a caller
    -- can get wrong, and the one caller is the product, which has no opinion
    -- about whether it is being tested.
    select coalesce(s.is_sim, false) into v_sim from sender s where s.id = p_sender_id;

    insert into academy (id, name, category, sender_id, onboarding_state, is_front_desk, is_sandbox)
    values (p_academy_id, p_name, nullif(p_category, ''), p_sender_id, 'setup', false,
            coalesce(v_sim, false));

    insert into person (academy_id, full_name)
    values (p_academy_id, p_founder_name)
    returning id into v_person;

    -- 'engaged', not 'registered': §11.2 promotes on first inbound, and the founder's
    -- first inbound is what created this row. Stamping `last_inbound_at` here is what
    -- keeps the 24h window open across the hand-over, so the very next reply — the one
    -- that starts the setup ladder — is a free in-window message rather than a
    -- template the new business has no approval for.
    insert into contact (academy_id, person_id, phone_e164, profile_name, state,
                         last_inbound_at, is_primary, role_hint)
    values (p_academy_id, v_person, p_phone_e164, nullif(p_profile_name, ''), 'engaged',
            p_at, true, 'admin')
    returning id into v_contact;

    insert into academy_admin (academy_id, person_id)
    values (p_academy_id, v_person);

    update arrival
       set outcome                = 'founded',
           decided_at             = p_at,
           destination_academy_id = p_academy_id
     where id = p_arrival_id;

    return jsonb_build_object(
      'academy_id', p_academy_id,
      'person_id',  v_person,
      'contact_id', v_contact
    );
  end;
  $$;

revoke all on function app.found_business(uuid, uuid, text, text, text, text, text, uuid, timestamptz) from public;
grant execute on function app.found_business(uuid, uuid, text, text, text, text, text, uuid, timestamptz) to cm_service;

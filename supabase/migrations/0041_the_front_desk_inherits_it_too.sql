-- =============================================================================
-- 0041_the_front_desk_inherits_it_too.sql — the third creation path.
--
-- 0040 made the toy-ness of a business a fact about the NUMBER it lives on, and
-- taught two academy-creation paths to inherit it: `app.found_business`, for a
-- business the product talks into existence, and `createAcademy` (lib/seed.ts),
-- for the emulator's own tenants. It missed the third.
--
-- `app.front_desk_for` (0039) creates one `academy` row per sender — the desk a
-- stranger arrives at before they belong to any business. It is an academy like
-- any other as far as every guard is concerned, and it was being created with
-- `is_sandbox` left to its default of false. So the first 2-day simulation after
-- 0040 produced exactly this, and the last row is the bug:
--
--   name             is_front_desk  is_sandbox  sender          is_sim
--   Tennis coaching  false          true        +15550823810    true
--   Front desk       true           FALSE       +15550823810    true
--
-- One sender, two academies, disagreeing about whether the number is real.
--
-- WHY IT MATTERS, GIVEN THE DESK OWNS ALMOST NOTHING
-- ---------------------------------------------------------------------------
-- The desk owns no class, no player, no money and no roster, and its
-- `onboarding_state` never leaves `setup`, so today it enqueues nothing and the
-- lane never gets to be wrong about it. That is a fact about the current handler
-- set, not a property of the schema, and it is the kind of fact that stops being
-- true quietly — the arrivals funnel is exactly the sort of thing that grows a
-- standing job. A row that is wrong but harmless is a row that becomes harmful
-- without anybody editing it.
--
-- Two guards already read the flag and are wrong about the desk today:
--
--   `_danger.ts` treats every academy that is not `is_sandbox` as a real business
--   and refuses to touch it. Every simulation leaves a front desk behind, so the
--   reaper accumulates rows it will not clean up, and a driver reading the list
--   sees a growing pile of things labelled real.
--
--   `ops-guard.ts` refuses every fabricating console route against a non-sandbox
--   academy. Aiming the emulator at a drive's own front desk is refused with
--   "academy <id> is a real tenant", which is false.
--
-- THE RULE IS THE SAME ONE, WHICH IS THE POINT
-- ---------------------------------------------------------------------------
-- Read the flag off the sender; never accept it from a caller. Three creation
-- paths, one rule, so none of them can drift from the others. If a fourth is
-- ever written, the thing to copy is this line and not a boolean parameter.
--
-- Unchanged from 0039 except `is_sandbox` in the insert. Restated in full
-- because `create or replace function` replaces a body rather than patching one.
--
-- Re-runnable.
-- =============================================================================

create or replace function app.front_desk_for(p_sender_id uuid) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_id uuid;
  begin
    select id into v_id from academy
     where sender_id = p_sender_id and is_front_desk;
    if v_id is not null then
      return v_id;
    end if;

    -- The one changed line: a desk on a simulated number is a simulated desk.
    -- Read from `sender` rather than passed in, exactly as `app.found_business`
    -- and `createAcademy` do it (0040).
    insert into academy (name, sender_id, is_front_desk, onboarding_state, is_sandbox)
    values ('Front desk', p_sender_id, true, 'setup',
            coalesce((select s.is_sim from sender s where s.id = p_sender_id), false));

    -- Lost the race with a concurrent first inbound on the same number: the other
    -- transaction's row is the front desk, and both callers must get the same one.
    if v_id is null then
      select id into v_id from academy
       where sender_id = p_sender_id and is_front_desk;
    end if;

    return v_id;
  end;
  $$;

revoke all on function app.front_desk_for(uuid) from public;
grant execute on function app.front_desk_for(uuid) to cm_service;

-- ---------------------------------------------------------------------------
-- The desks that already exist.
-- ---------------------------------------------------------------------------
--
-- Same one-way direction as 0040's backfill and for the same reason: this can
-- only mark a desk on a simulated number, and no real business is on such a
-- number, so nothing here can reach a paying tenant. The live number's desk
-- carries `is_sim = false` and is not matched.
update academy a
   set is_sandbox = true
  from sender s
 where s.id = a.sender_id
   and a.is_front_desk
   and s.is_sim
   and a.is_sandbox is distinct from true;

-- And any job those desks had already enqueued, re-stamped now that the academy
-- they belong to tells the truth. `app.stamp_job_lane` fires on INSERT only, so a
-- row written before this correction still carries the lane it was given then.
-- Bounded to `pending`: a job that has already run belongs to the race it was
-- part of, and rewriting its lane would make the record claim an ownership that
-- was never enforced.
update job
   set lane = app.lane_for((payload->>'academy_id')::uuid)
 where status = 'pending'
   and lane is distinct from app.lane_for((payload->>'academy_id')::uuid);

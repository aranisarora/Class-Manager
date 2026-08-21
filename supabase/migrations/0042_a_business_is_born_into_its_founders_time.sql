-- =============================================================================
-- 0042_a_business_is_born_into_its_founders_time.sql — the fourth thing inherited.
--
-- 0040 made the toy-ness of a business a fact about the NUMBER it lives on and
-- taught the creation paths to inherit it; 0041 caught the third path. This is
-- the same rule applied to the one piece of inherited reality all three missed:
-- WHAT TIME IT IS.
--
-- THE RUN THAT SHOWED IT
-- ---------------------------------------------------------------------------
-- `.probe/runs/2026-08-21-15-40-sim-cbum`, a seven-day agent week on a blank
-- world. A prospect at the front desk gave his business name on day 2. The
-- product called `start_business`, this function wrote the academy, and the
-- runtime re-entered and answered him from inside it — correctly, honestly, and
-- 7 seconds later. He never saw it. He waited a further day, said "nothing back
-- in 2 days, forget it", and left; days 4-7 of the record are an empty business
-- nobody was talking to.
--
-- The reply was real. It is in `message`, status 'sent'. What was wrong was its
-- timestamp:
--
--   message.created_at   2026-08-21T15:41:42Z   <- real wall-clock time
--   the simulated day     2026-08-25            <- where the drive was standing
--   sim_clock row for the new academy, created at 15:41:51 — NINE SECONDS LATE
--
-- `app.now_for` (0024) resolves a tenant's time as: their own `sim_clock` row,
-- else the WORLD row, else real time.
--
--   coalesce((select offset_ms from sim_clock where academy_id = p_academy),
--            (select offset_ms from sim_clock where academy_id is null),
--            0)
--
-- A business is created here with no row of its own, so for the remainder of the
-- turn that created it, it reads the world clock — which is 0, which is real
-- time. Everything it writes in that turn is stamped in the drive's past.
--
-- WHY NOTHING CAUGHT IT
-- ---------------------------------------------------------------------------
-- The harness already knows this rule and states it. `adopt()` in `scripts/sim.ts`
-- carries this comment, and it is correct:
--
--   "The new business gets its own `sim_clock` row set to whatever moment the
--    front desk is standing at, so the week carries on across the handover
--    instead of restarting at real time. Without it day 2 opens months in the
--    past and every standing job for the week fires at once."
--
-- It sets that row. It just sets it too late: `adopt()` is called after the
-- window's drain (sim.ts), and the founding — and the entire re-entered turn
-- that answers the founder — happens inside the seat turn before it. Two correct
-- mechanisms in the wrong sequence, which is the failure class CLAUDE.md names.
--
-- The harness cannot fix this from where it stands. The academy's id is minted
-- inside `foundBusiness` (`newId()`), so there is no row for the driver to
-- prepare and nothing to name until the transaction that needs it has already
-- committed. Inheritance is what reaches it — the same sentence 0040 ends on.
--
-- WHAT IT COST BEYOND THE ONE MESSAGE
-- ---------------------------------------------------------------------------
-- `scripts/_capture.ts` attributes evidence to a turn by a DOMAIN-time cursor:
-- everything stamped at-or-after the moment the turn opened belongs to it.
--
--   where m.direction = 'outbound' and m.created_at >= '<cursor>'::timestamptz
--
-- The cursor was 2026-08-25 and the message was stamped 2026-08-21, so
-- `2026-08-21 >= 2026-08-25` is false and the record of that turn reads
-- `reply: null, messages: 0, changed: []` — a turn that answered, recorded as a
-- turn that said nothing. The run's headline finding was a customer churning on
-- silence, and the silence was ours to explain and not the product's to answer
-- for. A record that cannot be trusted about whether a message existed cannot be
-- judged, which is the whole purpose of keeping one.
--
-- WHY THIS IS SAFE IN PRODUCTION
-- ---------------------------------------------------------------------------
-- It is gated on a non-zero offset, so it is a NO-OP anywhere the clock is real:
--
--   * A production front desk has no `sim_clock` row at all -> nothing is read,
--     nothing is written, the new business behaves exactly as it does today.
--   * A front desk whose row exists but reads 0 -> same, and deliberately: 0 is
--     "real time", and a business born into real time already has real time.
--   * Only a tenant standing somewhere other than now hands anything down.
--
-- So no row is added to `sim_clock` for any real business, ever. The emulator
-- pays for the emulator's problem and production carries none of it.
--
-- `frozen_at` rides along with the offset because they are one fact about a
-- clock, not two. A drive that froze the desk mid-turn and handed down only the
-- offset would produce a business running while its parent is stopped.
--
-- Unchanged from 0040 except `v_offset`, `v_frozen` and the guarded insert at the
-- end. Restated in full because `create or replace function` replaces a body
-- rather than patching one, and a diff of this against 0040 is the only review
-- that matters.
-- =============================================================================

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
    v_offset  bigint;
    v_frozen  timestamptz;
  begin
    -- The sender is the authority on whether this is a real business, and it is
    -- read here rather than passed in: a caller-supplied flag is a flag a caller
    -- can get wrong, and the one caller is the product, which has no opinion
    -- about whether it is being tested.
    select coalesce(s.is_sim, false) into v_sim from sender s where s.id = p_sender_id;

    -- What time the desk that is founding this business is standing at. Read off
    -- the front desk of this SENDER rather than off `p_arrival_id`, because an
    -- arrival is nullable (a referral with no link has none) and the desk is not:
    -- there is exactly one per sender, and it is the only academy this call can
    -- have come from.
    select sc.offset_ms, sc.frozen_at
      into v_offset, v_frozen
      from sim_clock sc
      join academy fd on fd.id = sc.academy_id
     where fd.sender_id = p_sender_id
       and fd.is_front_desk;

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

    -- The business is born into the time its founder is standing in.
    --
    -- Guarded on a non-zero offset so production writes nothing: a desk at real
    -- time has nothing to hand down, and a business born into real time already
    -- has it by falling through `app.now_for`'s coalesce exactly as before.
    if v_offset is not null and v_offset <> 0 then
      insert into sim_clock (singleton, academy_id, offset_ms, frozen_at)
      values (true, p_academy_id, v_offset, v_frozen)
      on conflict do nothing;
    end if;

    return jsonb_build_object(
      'academy_id', p_academy_id,
      'person_id',  v_person,
      'contact_id', v_contact
    );
  end;
  $$;

revoke all on function app.found_business(uuid, uuid, text, text, text, text, text, uuid, timestamptz) from public;
grant execute on function app.found_business(uuid, uuid, text, text, text, text, text, uuid, timestamptz) to cm_service;

comment on function app.found_business(uuid, uuid, text, text, text, text, text, uuid, timestamptz) is
  'Founds a business from the front desk in one transaction: academy, founder, contact, admin '
  'and the arrival outcome. Inherits two facts from where it was founded — `is_sandbox` from '
  'the sender (0040), and the founder''s clock offset when that clock is not real time (0042).';

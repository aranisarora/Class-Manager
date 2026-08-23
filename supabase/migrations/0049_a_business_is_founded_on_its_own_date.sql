-- =============================================================================
-- 0049_a_business_is_founded_on_its_own_date.sql — the one wall-clock date left.
--
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- `academy.created_on` is `date not null default current_date` (0002), and
-- `app.found_business` never names the column in its insert list — so the
-- default applies, even though the function already receives the domain
-- instant as `p_at` and uses it for `last_inbound_at` two statements later.
-- Every business founded on a walked clock is therefore older than it is by
-- however far the clock had walked, and `daysStanding` — the axis
-- `proposeGoLive` and `askForTheTimetable` re-raise on — reads a business
-- founded on simulated day 12 as twelve days older than its own first
-- conversation. In production the two clocks agree except between midnight
-- and 05:30 IST, which is why this sat unfixed; in every drive the distortion
-- grows a day per simulated day (F-EJ).
--
-- THE FIX
-- ---------------------------------------------------------------------------
-- The function names the column and computes the founder's local date from the
-- instant it was already given: `p_at` in the academy's own timezone, which at
-- founding is the column default. Nothing else changes — the body below is
-- 0042's verbatim, plus one column in one insert.
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

    -- 0049: the founding date is the founder's own date, from the instant this
    -- call was handed, never the host's `current_date`.
    insert into academy (id, name, category, sender_id, onboarding_state, is_front_desk, is_sandbox,
                         created_on)
    values (p_academy_id, p_name, nullif(p_category, ''), p_sender_id, 'setup', false,
            coalesce(v_sim, false),
            (p_at at time zone 'Asia/Kolkata')::date);

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
  'and the arrival outcome. Inherits three facts from where it was founded — `is_sandbox` from '
  'the sender (0040), the founder''s clock offset when that clock is not real time (0042), and '
  'its own founding date from the instant it was founded rather than the host''s (0049).';

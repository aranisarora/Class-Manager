-- =============================================================================
-- 0051 · One prospect — the visitor role and the prospect state fold into the
--        prospect role
--
-- Supersedes the decision recorded at 0039:92-114 ("WHY `visitor` IS A ROLE AND
-- NOT A CONTACT STATE"). That argument chose between a role and a state, and the
-- role won because the 0004 trigger consumes any state on the first inbound. It
-- was the right choice between those two — but two years of code later the role
-- itself turned out to be a relay: `visitor` was derived from `academy.is_front_desk`
-- and read back in exactly one runtime branch (loop.ts) and one emulator branch
-- (seed.ts), both of which can read `is_front_desk` off the identity's academy row
-- directly. Everything else keyed on the ToolCtx desk object the loop built from
-- it. A role that mirrors a structural fact, is branched on twice, and renders in
-- the tail as the unlabelled word "visitor" beside "prospect (not signed up)" is
-- not carrying information; it is duplicating it.
--
-- The `prospect` STATE had the same shape one layer down. §11.2 defined it as
-- "arrived cold, no account yet" — and the 0004 trigger flips it to `engaged` on
-- the very message that creates the contact, so no row at rest holds it. Its two
-- consumers were dead on arrival: book_trial's `prospect -> registered` promotion
-- matched a state the trigger had already consumed, and the family-invite
-- predicate (`state = 'registered'`) never saw a former prospect because former
-- prospects are `engaged`. A state value that exists for less than one statement's
-- duration is not a lifecycle stage; it is a constant wearing a column.
--
-- What survives is ONE concept: the `prospect` ROLE, and it is now derived from
-- ROW-ABSENCE — this person holds no admin, coach, account or player standing in
-- this academy — instead of from the vanishing state. That makes it durable (a
-- shopping parent is a prospect on message forty, not only on message one), true
-- at the front desk (a desk academy owns no role rows, so a desk arrival is
-- `["prospect"]` with no second word), and single-sourced (the emulator's rolesOf
-- derives it the same way, from the same absence). Desk mode itself keys on the
-- fact it always keyed on under the alias: `academy.is_front_desk`, which
-- `app.identity` already returns inside `to_jsonb(a)`.
--
-- One edge moves, deliberately: a person whose only row is an ENDED coach row
-- previously composed to an empty roles array ("no role yet" in the tail); they
-- now compose to `["prospect"]`. A departed coach writing in again holds no
-- current standing, which is what the word now means — "in the roster of nobody
-- this business currently recognises".
--
-- Re-runnable. Everything below is the LAST definition of what it touches; 0039
-- re-runs before this file on every push and this file must win.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 · contact.state loses 'prospect'. Backfill before the narrowed check: the
--     only rows that can hold it are contacts whose creating inbound never
--     stored (the trigger otherwise consumed it), and 'registered' — created,
--     never heard from — is exactly what such a row is.
-- -----------------------------------------------------------------------------
alter table contact drop constraint if exists contact_state_check;

update contact set state = 'registered' where state = 'prospect';

alter table contact add constraint contact_state_check
  check (state in ('registered', 'engaged', 'opted_out'));

-- -----------------------------------------------------------------------------
-- 2 · The first-inbound trigger (last def 0004:237) no longer names a state
--     that cannot be written. Behaviour is unchanged for every reachable row.
-- -----------------------------------------------------------------------------
create or replace function app.touch_contact_inbound() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
begin
  if new.direction = 'inbound' then
    update contact
       set last_inbound_at = app.now(),
           state = case when state = 'registered' then 'engaged'
                        else state end
     where id = new.contact_id;
  end if;
  return new;
end
$$;

-- -----------------------------------------------------------------------------
-- 3 · app.identity() (last def 0039:292) — the visitor branch is gone and
--     `prospect` is row-absence: none of the four standings exist. The four
--     exists tests move into one lateral so the absence test is the negation of
--     the same four facts the role list is built from, not a fifth reading.
--     `sees_money` reuses the same lateral (it was the same two exists tests
--     spelled again). Everything else is byte-for-byte 0039.
-- -----------------------------------------------------------------------------
create or replace function app.identity(p_contact_id uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select jsonb_build_object(
      'academy_id', a.id,
      'academy',    to_jsonb(a),
      'contact',    to_jsonb(c),
      'person',     to_jsonb(p),
      'roles',
        (case when r.is_admin  then '["admin"]'::jsonb          else '[]'::jsonb end)
        ||
        (case when r.is_coach  then '["coach"]'::jsonb          else '[]'::jsonb end)
        ||
        (case when r.is_holder then '["account_holder"]'::jsonb else '[]'::jsonb end)
        ||
        (case when r.is_player then '["player"]'::jsonb         else '[]'::jsonb end)
        ||
        -- 0051. Row-absence, not contact.state: no standing of any kind in this
        -- academy makes this person a prospect of it — at the front desk that is
        -- every arrival, in a tenant it is a stranger until a real row exists.
        (case when not (r.is_admin or r.is_coach or r.is_holder or r.is_player)
              then '["prospect"]'::jsonb else '[]'::jsonb end),
      'coach_id', (
        select co.id from coach co
        where co.academy_id = a.id and co.person_id = p.id
        order by (co.status = 'ended'), co.created_at
        limit 1
      ),
      'account_ids', (
        select coalesce(jsonb_agg(ac.id order by ac.created_at), '[]'::jsonb)
        from account ac
        where ac.academy_id = a.id and ac.holder_person_id = p.id
      ),
      'player_ids', (
        select coalesce(jsonb_agg(pl.id order by pl.created_at), '[]'::jsonb)
        from player pl
        where pl.academy_id = a.id
          and (pl.person_id = p.id
               or pl.account_id in (select ac.id from account ac
                                    where ac.academy_id = a.id
                                      and ac.holder_person_id = p.id))
      ),
      'is_solo', app.is_solo(a.id),
      'sees_money', (r.is_admin or r.is_holder)
    )
    from contact c
    join person  p on p.id = c.person_id
    join academy a on a.id = c.academy_id
    cross join lateral (
      select
        exists (select 1 from academy_admin aa
                where aa.academy_id = a.id and aa.person_id = p.id)       as is_admin,
        exists (select 1 from coach co
                where co.academy_id = a.id and co.person_id = p.id
                  and co.status <> 'ended')                               as is_coach,
        exists (select 1 from account ac
                where ac.academy_id = a.id and ac.holder_person_id = p.id) as is_holder,
        exists (select 1 from player pl
                where pl.academy_id = a.id and pl.person_id = p.id)        as is_player
    ) r
    where c.id = p_contact_id
  $$;

grant execute on function app.identity(uuid) to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- 4 · app.front_desk_contact() (last def 0039:442) — the desk arrival starts
--     'registered' like every other created-not-yet-heard-from contact (the
--     trigger flips it to 'engaged' when the opening message stores), and
--     role_hint is null: which hat this number wears is the desk's one open
--     question, and a hint asserting the answer before it is asked is the kind
--     of manufactured fact this repo deletes. Otherwise byte-for-byte 0039.
-- -----------------------------------------------------------------------------
create or replace function app.front_desk_contact(
  p_sender_id    uuid,
  p_phone_e164   text,
  p_full_name    text,
  p_profile_name text,
  p_at           timestamptz
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_front_desk uuid;
    v_contact    uuid;
    v_person     uuid;
    v_created    boolean := false;
  begin
    v_front_desk := app.front_desk_for(p_sender_id);

    select c.id into v_contact
      from contact c
     where c.academy_id = v_front_desk
       and nullif(right(regexp_replace(c.phone_e164, '[^0-9]', '', 'g'), 10), '')
         = nullif(right(regexp_replace(coalesce(p_phone_e164, ''), '[^0-9]', '', 'g'), 10), '');

    if v_contact is null then
      insert into person (academy_id, full_name)
      values (v_front_desk, p_full_name)
      returning id into v_person;

      insert into contact (academy_id, person_id, phone_e164, profile_name, state,
                           last_inbound_at, role_hint)
      values (v_front_desk, v_person, p_phone_e164, nullif(p_profile_name, ''), 'registered',
              p_at, null)
      on conflict (academy_id, phone_e164) do nothing
      returning id into v_contact;

      if v_contact is null then
        -- Lost the race. The other transaction's person is the one with a contact;
        -- ours has none and is unreachable, so it goes rather than lingering as a
        -- second person for the same human.
        delete from person where id = v_person;
        select c.id into v_contact from contact c
         where c.academy_id = v_front_desk and c.phone_e164 = p_phone_e164;
      else
        v_created := true;
      end if;
    else
      update contact
         set last_inbound_at = p_at,
             profile_name    = coalesce(nullif(p_profile_name, ''), profile_name)
       where id = v_contact;
    end if;

    return jsonb_build_object(
      'front_desk_id', v_front_desk,
      'contact_id',    v_contact,
      'created',       v_created
    );
  end;
  $$;

revoke all on function app.front_desk_contact(uuid, text, text, text, timestamptz) from public;
grant execute on function app.front_desk_contact(uuid, text, text, text, timestamptz) to cm_service;

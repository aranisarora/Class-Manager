-- =============================================================================
-- 0005_audit.sql — the snapshot trail behind §2.3 (compute the effect before
-- committing it), §7.2 (audit trail + undo window) and §14.2.1 (one diff for
-- the whole plan), plus the four SECURITY DEFINER helpers `lib/` needs to do
-- work that is legitimately cross-tenant or pre-tenant.
--
-- Owned by Core. Re-runnable.
--
-- WHY THE DEFINER HELPERS LIVE HERE ------------------------------------------
-- 0003 pins every cm_service policy to app.academy_id(). That is correct — a
-- service action must not cross tenants — but it makes three reads impossible
-- to express as an ordinary query, because they must run BEFORE the academy is
-- known or ACROSS academies by construction:
--
--   app.identity(contact)            resolveIdentity() is handed a contact id
--                                    and nothing else; the academy it needs for
--                                    the GUC is on the row it cannot yet read.
--   app.inbound_candidates(from,to)  §10.1 routing on a shared number is a
--                                    cross-academy question by definition.
--   app.next_event_at(after)         the emulator's "jump to next event" spans
--                                    every academy in the world (§17).
--
-- Each is STABLE, read-only, takes its scope as an argument, and returns only
-- what the caller already had a right to ask for. They are the bootstrap, not
-- a bypass: everything downstream still runs inside withSession() under a
-- pinned role.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The runtime connects as `cm_runtime` and immediately SET LOCAL ROLEs into one
-- of the three session roles (CONTRACTS §2). That requires membership. Guarded
-- because it needs ADMIN OPTION on those roles: if this migration is applied by
-- a role that lacks it, the grant is reported and skipped rather than taking
-- the audit machinery down with it.
-- -----------------------------------------------------------------------------
do $$
begin
  execute 'grant cm_service, cm_user, cm_readonly to cm_runtime';
exception when others then
  raise notice 'skipped granting session roles to cm_runtime: %', sqlerrm;
end
$$;

-- -----------------------------------------------------------------------------
-- row_snapshot — the before/after images the diff and the undo are built from.
--
-- Written by a generic trigger while app.audit_id is set, so blast radius is
-- KNOWN, not estimated (§2.3), and undo has real before-images (§7.2).
--
-- Two columns beyond the brief's list, both load-bearing:
--   seq        every snapshot in one transaction shares now() (transaction
--              start time), so `at` cannot order them. Undo must invert
--              newest-first, which needs a monotonic tiebreak.
--   academy_id lets cm_user read back the diff of the plan it just ran.
--              audit_entry has no cm_user policy, so gating this table on a
--              subquery over it would return zero rows under cm_user.
-- -----------------------------------------------------------------------------
create table if not exists row_snapshot (
  id         uuid primary key default gen_random_uuid(),
  seq        bigserial not null,
  audit_id   uuid not null references audit_entry(id) on delete cascade,
  academy_id uuid references academy(id) on delete cascade,
  table_name text not null,
  pk         uuid,
  op         text not null check (op in ('insert','update','delete')),
  before     jsonb,
  after      jsonb,
  at         timestamptz not null default now()
);

create index if not exists row_snapshot_audit_idx   on row_snapshot (audit_id, seq);
create index if not exists row_snapshot_academy_idx on row_snapshot (academy_id);

alter table row_snapshot enable row level security;

drop policy if exists row_snapshot_cm_service_all on row_snapshot;
create policy row_snapshot_cm_service_all on row_snapshot
  for all to cm_service using (true) with check (true);

-- The plan's own author reads its own diff back (previewPlan, §14.2.1).
drop policy if exists row_snapshot_cm_user_select on row_snapshot;
create policy row_snapshot_cm_user_select on row_snapshot
  for select to cm_user, cm_readonly
  using (academy_id = app.academy_id());

grant select, insert on row_snapshot to cm_service;
grant select, insert on row_snapshot to cm_user;
grant select on row_snapshot to cm_readonly;
grant usage, select on sequence row_snapshot_seq_seq to cm_service, cm_user;

comment on table row_snapshot is
  'Before/after images captured by app.snapshot_row() while app.audit_id is '
  'set. The source of both the pre-commit diff (§2.3) and undo (§7.2).';

-- -----------------------------------------------------------------------------
-- app.snapshot_row() — one generic trigger function for every audited table.
--
-- No-ops unless app.audit_id is set, so ordinary traffic pays one
-- current_setting() per row and nothing else.
--
-- SECURITY DEFINER because the writes it shadows run under cm_user as often as
-- cm_service, and a trigger that fails RLS would take the whole plan down with
-- it. It writes nothing the caller did not just write.
-- -----------------------------------------------------------------------------
create or replace function app.snapshot_row() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
  declare
    v_audit   uuid;
    v_before  jsonb;
    v_after   jsonb;
    v_pk      uuid;
    v_academy uuid;
  begin
    v_audit := nullif(current_setting('app.audit_id', true), '')::uuid;

    if v_audit is null then
      if tg_op = 'DELETE' then return old; else return new; end if;
    end if;

    if tg_op = 'INSERT' then
      v_after := to_jsonb(new);
    elsif tg_op = 'UPDATE' then
      v_before := to_jsonb(old);
      v_after  := to_jsonb(new);
    else
      v_before := to_jsonb(old);
    end if;

    v_pk      := nullif(coalesce(v_after ->> 'id', v_before ->> 'id'), '')::uuid;
    v_academy := nullif(coalesce(v_after ->> 'academy_id',
                                 v_before ->> 'academy_id'), '')::uuid;

    insert into row_snapshot (audit_id, academy_id, table_name, pk, op, before, after)
    values (v_audit, v_academy, tg_table_name, v_pk, lower(tg_op), v_before, v_after);

    if tg_op = 'DELETE' then return old; else return new; end if;
  end
  $$;

grant execute on function app.snapshot_row() to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- The audited set. Every table a plan can write and an undo must be able to
-- reverse. Infrastructure tables (message, action, job, turn, memory_fact) are
-- deliberately absent: undo reverses database writes only (§7.2), a sent
-- message cannot be unsent, and snapshotting the outbox would imply it could.
-- -----------------------------------------------------------------------------
drop trigger if exists class_snapshot on class;
create trigger class_snapshot after insert or update or delete on class
  for each row execute function app.snapshot_row();

drop trigger if exists class_slot_snapshot on class_slot;
create trigger class_slot_snapshot after insert or update or delete on class_slot
  for each row execute function app.snapshot_row();

drop trigger if exists class_coach_snapshot on class_coach;
create trigger class_coach_snapshot after insert or update or delete on class_coach
  for each row execute function app.snapshot_row();

drop trigger if exists enrollment_snapshot on enrollment;
create trigger enrollment_snapshot after insert or update or delete on enrollment
  for each row execute function app.snapshot_row();

drop trigger if exists session_snapshot on session;
create trigger session_snapshot after insert or update or delete on session
  for each row execute function app.snapshot_row();

drop trigger if exists session_coach_snapshot on session_coach;
create trigger session_coach_snapshot after insert or update or delete on session_coach
  for each row execute function app.snapshot_row();

drop trigger if exists attendance_snapshot on attendance;
create trigger attendance_snapshot after insert or update or delete on attendance
  for each row execute function app.snapshot_row();

drop trigger if exists tally_line_snapshot on tally_line;
create trigger tally_line_snapshot after insert or update or delete on tally_line
  for each row execute function app.snapshot_row();

drop trigger if exists payment_snapshot on payment;
create trigger payment_snapshot after insert or update or delete on payment
  for each row execute function app.snapshot_row();

drop trigger if exists coach_snapshot on coach;
create trigger coach_snapshot after insert or update or delete on coach
  for each row execute function app.snapshot_row();

drop trigger if exists player_snapshot on player;
create trigger player_snapshot after insert or update or delete on player
  for each row execute function app.snapshot_row();

drop trigger if exists account_snapshot on account;
create trigger account_snapshot after insert or update or delete on account
  for each row execute function app.snapshot_row();

drop trigger if exists person_snapshot on person;
create trigger person_snapshot after insert or update or delete on person
  for each row execute function app.snapshot_row();

drop trigger if exists contact_snapshot on contact;
create trigger contact_snapshot after insert or update or delete on contact
  for each row execute function app.snapshot_row();

drop trigger if exists academy_admin_snapshot on academy_admin;
create trigger academy_admin_snapshot after insert or update or delete on academy_admin
  for each row execute function app.snapshot_row();

drop trigger if exists venue_snapshot on venue;
create trigger venue_snapshot after insert or update or delete on venue
  for each row execute function app.snapshot_row();

-- -----------------------------------------------------------------------------
-- app.begin_audit() — one audit entry per plan, carrying the intent that
-- produced it (§14.2.1), and the GUC that turns the snapshot trigger on for the
-- rest of THIS transaction.
--
-- SECURITY DEFINER for the same reason as the trigger: audit_entry is
-- infrastructure with no cm_user policy, but plans run under cm_user. The
-- tenant check below is what keeps that from being a hole.
-- -----------------------------------------------------------------------------
create or replace function app.begin_audit(
  p_academy_id uuid,
  p_actor      uuid,
  p_intent     text,
  p_plan       jsonb
) returns uuid
  language plpgsql security definer set search_path = public, pg_temp
  as $$
  declare
    v_id uuid;
  begin
    if p_academy_id is null then
      raise exception 'begin_audit requires an academy_id';
    end if;
    if app.academy_id() is not null and app.academy_id() <> p_academy_id then
      raise exception 'begin_audit: academy_id % does not match the session tenant %',
        p_academy_id, app.academy_id();
    end if;

    insert into audit_entry (academy_id, actor_person_id, intent, plan)
    values (p_academy_id, p_actor, p_intent, p_plan)
    returning id into v_id;

    perform set_config('app.audit_id', v_id::text, true);
    return v_id;
  end
  $$;

grant execute on function app.begin_audit(uuid, uuid, text, jsonb)
  to cm_service, cm_user;

-- -----------------------------------------------------------------------------
-- §18 — the solo condition. Exactly one ACTIVE coach whose person is also an
-- admin. For SHAPING only (merging the coach day into the morning brief, not
-- offering cover to a set of one) — never for gating. The two suppression
-- rules on the send path are what actually produce the §18 table.
--
-- Both arities are created only if the DB module has not already defined that
-- exact signature, so this file never clobbers 0004.
-- -----------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('app.is_solo(uuid)') is null then
    execute $f$
      create function app.is_solo(p_academy_id uuid) returns boolean
        language sql stable security definer set search_path = public, pg_temp
        as $b$
          select (select count(*) from coach c
                  where c.academy_id = p_academy_id and c.status = 'active') = 1
             and exists (
               select 1 from coach c
               join academy_admin aa
                 on aa.person_id = c.person_id and aa.academy_id = c.academy_id
               where c.academy_id = p_academy_id and c.status = 'active')
        $b$;
    $f$;
    execute 'grant execute on function app.is_solo(uuid)
               to cm_service, cm_user, cm_readonly';
  end if;
end
$$;

do $$
begin
  if to_regprocedure('app.is_solo()') is null then
    execute $f$
      create function app.is_solo() returns boolean
        language sql stable security definer set search_path = public, pg_temp
        as $b$ select app.is_solo(app.academy_id()) $b$;
    $f$;
    execute 'grant execute on function app.is_solo()
               to cm_service, cm_user, cm_readonly';
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- app.identity(contact) — §6.2 roles compose, so this returns an ARRAY of hats,
-- never a scalar, and it does it in one round trip.
--
-- sees_money mirrors app.sees_money() (§6.7): admin or account holder. A player
-- who is not the holder of their own account gets false — money-shaped rows
-- never route to a player's number.
-- -----------------------------------------------------------------------------
create or replace function app.identity(p_contact_id uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select jsonb_build_object(
      'academy_id', a.id,
      'academy',    to_jsonb(a),
      'contact',    to_jsonb(c),
      'person',     to_jsonb(p),
      -- Built by concatenation rather than a derived table: a sub-SELECT in
      -- FROM cannot see the outer row, and roles are correlated to it.
      'roles',
        (case when exists (select 1 from academy_admin aa
                           where aa.academy_id = a.id and aa.person_id = p.id)
              then '["admin"]'::jsonb else '[]'::jsonb end)
        ||
        (case when exists (select 1 from coach co
                           where co.academy_id = a.id and co.person_id = p.id
                             and co.status <> 'ended')
              then '["coach"]'::jsonb else '[]'::jsonb end)
        ||
        (case when exists (select 1 from account ac
                           where ac.academy_id = a.id and ac.holder_person_id = p.id)
              then '["account_holder"]'::jsonb else '[]'::jsonb end)
        ||
        (case when exists (select 1 from player pl
                           where pl.academy_id = a.id and pl.person_id = p.id)
              then '["player"]'::jsonb else '[]'::jsonb end)
        ||
        (case when c.state = 'prospect'
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
      'sees_money', (
        exists (select 1 from academy_admin aa
                where aa.academy_id = a.id and aa.person_id = p.id)
        or exists (select 1 from account ac
                   where ac.academy_id = a.id and ac.holder_person_id = p.id)
      )
    )
    from contact c
    join person  p on p.id = c.person_id
    join academy a on a.id = c.academy_id
    where c.id = p_contact_id
  $$;

grant execute on function app.identity(uuid) to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- app.inbound_candidates() — §10.1 routing on a shared number. Returns every
-- contact on the receiving sender whose number matches, plus every academy that
-- sender serves so an unknown number can be matched on the academy NAME in the
-- prefilled text. Matching is on the last ten digits, so "+91 98765 43210",
-- "919876543210" and "9876543210" are all the same human.
--
-- This is a functional requirement, not a security one (§10.1) — it exposes
-- academy names on a number the caller is already messaging, and nothing else.
-- -----------------------------------------------------------------------------
create or replace function app.inbound_candidates(
  p_from_phone   text,
  p_sender_phone text
) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
  as $$
    with s as (
      select id, phone_e164 from sender
      where nullif(right(regexp_replace(phone_e164, '[^0-9]', '', 'g'), 10), '')
          = nullif(right(regexp_replace(coalesce(p_sender_phone, ''), '[^0-9]', '', 'g'), 10), '')
      limit 1
    ),
    acs as (
      select a.id, a.name from academy a
      where a.sender_id = (select id from s)
    )
    select jsonb_build_object(
      'sender_id', (select id from s),
      'matches', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'academy_id', ac.id, 'name', ac.name, 'contact_id', c.id
               ) order by c.created_at), '[]'::jsonb)
        from acs ac
        join contact c on c.academy_id = ac.id
         and nullif(right(regexp_replace(c.phone_e164, '[^0-9]', '', 'g'), 10), '')
           = nullif(right(regexp_replace(coalesce(p_from_phone, ''), '[^0-9]', '', 'g'), 10), '')
      ),
      'academies', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'academy_id', ac.id, 'name', ac.name
               ) order by ac.name), '[]'::jsonb)
        from acs ac
      )
    )
  $$;

grant execute on function app.inbound_candidates(text, text) to cm_service;

-- -----------------------------------------------------------------------------
-- app.next_event_at() — what the scheduler would do next, anywhere in the
-- world: the earliest pending job, or the earliest T-60 (§13's coach_coming is
-- the first thing that fires before a session). Powers the emulator's
-- "jump to next event" (§17), which is global by construction.
--
-- Takes `after` as an argument rather than reading app.now(), so it composes
-- with the drivable clock instead of depending on it.
-- -----------------------------------------------------------------------------
create or replace function app.next_event_at(p_after timestamptz)
  returns timestamptz
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select least(
      (select min(j.run_at) from job j
        where j.status = 'pending' and j.run_at > p_after),
      (select min(s.starts_at - interval '60 minutes') from session s
        where s.status = 'scheduled'
          and s.starts_at - interval '60 minutes' > p_after)
    )
  $$;

grant execute on function app.next_event_at(timestamptz) to cm_service;

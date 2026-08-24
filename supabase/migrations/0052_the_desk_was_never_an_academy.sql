-- =============================================================================
-- 0052_the_desk_was_never_an_academy.sql — the tenant is not the business.
--
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- 0039 put the front desk in the `academy` table, and argued the trade honestly:
-- as an academy row a stranger gets a person, a contact, a transcript, buttons,
-- a turn record and the one send path with no parallel machinery at all. What the
-- argument could not price was the discipline bill, and it has now been paid three
-- times as the same bug class:
--
--   0041  the desk missed `is_sandbox` — one sender, two academies, disagreeing
--         about whether the number is real
--   0042  the desk missed the clock — a founded business answered 7 seconds later
--         and 4 simulated days too early; its founder left
--   0049  the desk missed `created_on`
--
-- Each was one instance of the class: `academy` holds two kinds of fact — facts
-- about the ISOLATION UNIT (which number it lives on, whether that number is
-- real) and facts about the BUSINESS (its name, its fees, its brief times) — and
-- a desk row fabricates the second kind out of column defaults. Every new
-- academy column silently poses "and what is this for the desk?", and every
-- enumeration must remember `not is_front_desk`, a negation whose omission is
-- silent: forgetting it returns MORE rows, never an error.
--
-- WHAT REPLACES IT
-- ---------------------------------------------------------------------------
-- Two tables, one id.
--
--   tenant   the isolation unit: which sender it lives on, which kind of thing
--            it is, whether it is scratch. Every `academy_id` column in the
--            product now points HERE — the column name is kept, because renaming
--            it would churn a hundred policies to say the same thing.
--   academy  the business record, 1:1 with a business tenant, sharing its id.
--            A front-desk tenant has NO academy row: a business fact physically
--            cannot land on a desk, which retires the 0041/0042/0049 class by
--            construction instead of by review.
--
-- The subtype constraint makes the exclusion a schema fact rather than a
-- remembered one: `academy.kind` is CHECK-pinned to the constant 'business',
-- and the composite FK (id, kind, sender_id) -> tenant (id, kind, sender_id)
-- means an academy row can only ever sit on a business tenant, on the same
-- sender. The enumerations lose their negation entirely: "every business" is
-- now `select id from academy`, full stop.
--
-- ONE CREATION DOOR
-- ---------------------------------------------------------------------------
-- `app.create_tenant` is the one function that writes a tenant row, and it owns
-- everything a tenant inherits from its NUMBER: `is_sandbox` read off
-- `sender.is_sim` (0040/0041's rule — never accepted from a caller), and the
-- desk's clock offset copied onto a new business (0042/0049's rule). The three
-- creation paths — `app.found_business`, `app.front_desk_for`, and the seed —
-- are now callers of it, so a fourth path copies a function call, not a rule.
-- It also restores the desk-creation race absorption that 0041's rewrite of
-- `front_desk_for` accidentally dropped (0039 had `on conflict ... do nothing
-- returning`; 0041 lost both clauses, so the race raised instead of absorbing).
--
-- WHY `academy` KEEPS `sender_id`
-- ---------------------------------------------------------------------------
-- The push convention re-runs the whole chain, and a dropped COLUMN of a
-- still-existing table never comes back — `create table if not exists` stays
-- satisfied, so 0041's executed UPDATE (`from sender s where s.id = a.sender_id`)
-- and the `language sql` bodies in 0007/0039 would break every future push.
-- `is_front_desk` and `is_sandbox` are different: 0039/0030 re-add them with
-- `add column if not exists` before anything references them, and this file
-- re-drops them at the end, so the chain stays green. `sender_id` therefore
-- stays on `academy` as a CONSTRAINED denormalization — the composite FK above
-- makes drift from `tenant.sender_id` impossible.
--
-- WHAT THE DESK LOSES, AND WHAT REPLACES EACH FABRICATION
-- ---------------------------------------------------------------------------
-- A desk used to "have" a timezone, quiet-hours settings and a name because the
-- columns had defaults. Now the desk-reachable readers state their own platform
-- defaults instead: timezone -> 'Asia/Kolkata', settings -> '{}', name ->
-- 'Front desk'. A desk turn's `read` of `academy` goes from one fabricated row
-- to zero rows — which is what ANATOMY §1a already tells the model to expect
-- from the desk ("the desk owns no rows, so empty is expected").
--
-- The cannot-initiate property gets stronger: the send gate used to lean on the
-- desk's `onboarding_state` never being 'live'; it now also suppresses on
-- `tenant.kind = 'front_desk'` directly. A desk cannot be flipped live, because
-- there is no row to flip.
--
-- Also in this file, on the same surface:
--   - `morning_brief_at` / `evening_digest_at` go nullable. lib/jobs/util.ts has
--     always documented null as "the owner turned it off" and lib/setup-plan.ts
--     writes null to do exactly that — against NOT NULL columns, which made the
--     off-switch a constraint violation nobody had hit yet.
--   - `prompt_cache_handle` is dropped: never read, never written, anywhere.
--
-- Re-runnable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 · tenant — the isolation unit
-- -----------------------------------------------------------------------------
create table if not exists tenant (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  sender_id  uuid not null references sender(id),
  kind       text not null check (kind in ('business','front_desk')),
  is_sandbox boolean not null default false
);

comment on table tenant is
  'The isolation unit every academy_id column points at: which sender it lives on, '
  'which kind of thing it is, whether it is scratch. Business facts live one table '
  'over, in academy, which a front_desk tenant deliberately does not have (0052).';
comment on column tenant.kind is
  'business | front_desk. Desk mode keys on this, read off the identity. The old '
  'academy.is_front_desk boolean and its remembered `not is_front_desk` exclusions '
  'are retired: business enumerations select from academy, which desks are not in.';
comment on column tenant.is_sandbox is
  'Inherited from sender.is_sim by app.create_tenant, the one path that writes it. '
  'Same meaning as 0030: scratch, so the emulator''s fabricating routes may act on '
  'it even in production.';

-- One arrivals hall per number — the arbiter create_tenant's ON CONFLICT leans on.
create unique index if not exists tenant_one_front_desk_per_sender_idx
  on tenant (sender_id) where kind = 'front_desk';

-- FK target for academy's subtype constraint (§4).
create unique index if not exists tenant_subtype_key on tenant (id, kind, sender_id);

alter table tenant enable row level security;

drop policy if exists tenant_cm_service_all on tenant;
create policy tenant_cm_service_all on tenant
  for all to cm_service
  using (id = app.academy_id()) with check (id = app.academy_id());
-- No cm_user/cm_readonly policy on purpose: nothing on this table is the model's
-- business, and RLS denying by default is what keeps the grid's "-" row truthful.

-- -----------------------------------------------------------------------------
-- 2 · Backfill — every academy row becomes a tenant, keeping its id, so every
--     child FK, pinned session and arrival pointer keeps working with zero data
--     movement. The second guard absorbs the chain-re-run case: 0039/0030 re-add
--     the flag columns (all false, desks long deleted), so a re-run must not
--     mint a second desk tenant for a sender that already has one.
-- -----------------------------------------------------------------------------
insert into tenant (id, created_at, sender_id, kind, is_sandbox)
select a.id, a.created_at, a.sender_id,
       case when a.is_front_desk then 'front_desk' else 'business' end,
       a.is_sandbox
  from academy a
 where not exists (select 1 from tenant t where t.id = a.id)
   and not (a.is_front_desk and exists
        (select 1 from tenant t
          where t.sender_id = a.sender_id and t.kind = 'front_desk'));

-- -----------------------------------------------------------------------------
-- 3 · Retarget every child FK from academy(id) to tenant(id), catalog-driven so
--     the set is exhaustive BY CONSTRUCTION — a hand-written list that missed
--     one constraint would be the remembered-negation class this file exists to
--     kill. pg_get_constraintdef preserves each constraint's columns and delete
--     action; only the referenced table changes. The one deliberate exception:
--     arrival.destination_academy_id keeps pointing at academy, because a
--     settled arrival's destination IS a business — the FK now says so itself.
-- -----------------------------------------------------------------------------
do $$
declare
  r record;
  v_def text;
begin
  for r in
    select c.oid, c.conname, c.conrelid::regclass as tbl,
           pg_get_constraintdef(c.oid) as def
      from pg_constraint c
     where c.confrelid = 'academy'::regclass
       and c.contype = 'f'
  loop
    if r.tbl = 'arrival'::regclass and r.def like '%(destination_academy_id)%' then
      continue;
    end if;
    v_def := replace(r.def, 'REFERENCES academy(', 'REFERENCES tenant(');
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
    execute format('alter table %s add constraint %I %s', r.tbl, r.conname, v_def);
  end loop;
end $$;

-- The assert: if any FK other than the destination pointer still references
-- academy, this file failed to do its job and must say so here, not three
-- layers away as a mystery cascade.
do $$
declare
  v_left int;
begin
  select count(*) into v_left
    from pg_constraint c
   where c.confrelid = 'academy'::regclass
     and c.contype = 'f'
     and not (c.conrelid = 'arrival'::regclass
              and pg_get_constraintdef(c.oid) like '%(destination_academy_id)%');
  if v_left > 0 then
    raise exception
      '0052: % foreign keys still reference academy(id); expected only arrival.destination_academy_id',
      v_left;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 4 · academy becomes the business half. Order is load-bearing: desk rows are
--     deleted AFTER the FK retarget (§3), so their transcripts — now hanging off
--     the tenant row — do not cascade away with them; the subtype FK is added
--     AFTER the delete, so it validates.
-- -----------------------------------------------------------------------------

-- Null means "the owner turned it off" — lib/jobs/util.ts has said so all along.
alter table academy alter column morning_brief_at  drop not null;
alter table academy alter column evening_digest_at drop not null;

-- The subtype pin: a constant column whose whole job is to appear in the FK.
alter table academy add column if not exists kind text not null default 'business';
alter table academy drop constraint if exists academy_kind_business;
alter table academy add  constraint academy_kind_business check (kind = 'business');

drop index if exists academy_one_front_desk_per_sender_idx;

-- The desk's fabricated business half dies. Its person, contact, transcript and
-- turn rows live on, attached to the tenant row that kept the same id.
delete from academy where is_front_desk;

alter table academy drop column if exists is_front_desk;
alter table academy drop column if exists is_sandbox;
alter table academy drop column if exists prompt_cache_handle;  -- dead: never read, never written

-- An academy row can only sit on a business tenant, on the same sender. This is
-- the sentence "a desk has no business record", said by the schema.
alter table academy drop constraint if exists academy_tenant_fkey;
alter table academy add constraint academy_tenant_fkey
  foreign key (id, kind, sender_id) references tenant (id, kind, sender_id)
  on update cascade on delete cascade;
-- ON UPDATE CASCADE so moving a tenant to another sender (the emulator's sandbox
-- stamp does exactly this) is ONE update on tenant, and the constrained copy on
-- academy follows by itself.

comment on table academy is
  'The business record, 1:1 with a business tenant, sharing its id (0052). '
  'A front_desk tenant has no row here — that absence is the design.';
comment on column academy.kind is
  'Constant ''business'': exists so the composite FK to tenant can pin the '
  'subtype. The CHECK and the FK together make "a desk has no academy row" a '
  'schema fact.';
comment on column academy.sender_id is
  'Kept (not dropped) because the chain re-runs on every push and 0007/0039/0041 '
  'reference it; the composite FK to tenant makes drift impossible (0052).';

-- -----------------------------------------------------------------------------
-- 5 · app.create_tenant — the one door a tenant row comes through
-- -----------------------------------------------------------------------------
create or replace function app.create_tenant(
  p_id        uuid,
  p_sender_id uuid,
  p_kind      text
) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_id     uuid;
    v_sim    boolean;
    v_offset bigint;
    v_frozen timestamptz;
  begin
    -- The sender is the authority on whether this is a real number, and it is
    -- read here rather than passed in (0040/0041): a caller-supplied flag is a
    -- flag a caller can get wrong.
    select coalesce(s.is_sim, false) into v_sim
      from sender s where s.id = p_sender_id;

    if p_kind = 'front_desk' then
      -- One desk per number; a lost race is absorbed, not raised (0039's
      -- semantics, restored — 0041's rewrite dropped the ON CONFLICT).
      insert into tenant (id, sender_id, kind, is_sandbox)
      values (coalesce(p_id, gen_random_uuid()), p_sender_id, 'front_desk',
              coalesce(v_sim, false))
      on conflict (sender_id) where kind = 'front_desk' do nothing
      returning id into v_id;

      if v_id is null then
        select t.id into v_id from tenant t
         where t.sender_id = p_sender_id and t.kind = 'front_desk';
      end if;
      return v_id;
    end if;

    insert into tenant (id, sender_id, kind, is_sandbox)
    values (coalesce(p_id, gen_random_uuid()), p_sender_id, 'business',
            coalesce(v_sim, false))
    returning id into v_id;

    -- The business is born into the time its number is standing in (0042/0049):
    -- copy the desk's clock offset, guarded on non-zero so production — where
    -- every clock is real time — writes nothing.
    select sc.offset_ms, sc.frozen_at
      into v_offset, v_frozen
      from sim_clock sc
      join tenant fd on fd.id = sc.academy_id
     where fd.sender_id = p_sender_id
       and fd.kind = 'front_desk';

    if v_offset is not null and v_offset <> 0 then
      insert into sim_clock (singleton, academy_id, offset_ms, frozen_at)
      values (true, v_id, v_offset, v_frozen)
      on conflict do nothing;
    end if;

    return v_id;
  end;
  $$;

revoke all on function app.create_tenant(uuid, uuid, text) from public, cm_user, cm_readonly;
grant execute on function app.create_tenant(uuid, uuid, text) to cm_service;

comment on function app.create_tenant(uuid, uuid, text) is
  'The one path that writes a tenant row, and the one owner of everything a '
  'tenant inherits from its number: is_sandbox from sender.is_sim, the desk''s '
  'clock offset onto a new business. found_business, front_desk_for and the '
  'seed are callers; a fourth creation path copies a function call, not a rule.';

-- -----------------------------------------------------------------------------
-- 6 · app.front_desk_for (last def 0041:54) — shrinks to a caller of the door.
-- -----------------------------------------------------------------------------
create or replace function app.front_desk_for(p_sender_id uuid) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_id uuid;
  begin
    select t.id into v_id from tenant t
     where t.sender_id = p_sender_id and t.kind = 'front_desk';
    if v_id is not null then
      return v_id;
    end if;
    return app.create_tenant(null, p_sender_id, 'front_desk');
  end;
  $$;

revoke all on function app.front_desk_for(uuid) from public, cm_user, cm_readonly;
grant execute on function app.front_desk_for(uuid) to cm_service;

-- -----------------------------------------------------------------------------
-- 7 · app.found_business (last def 0049:26) — the tenant comes from the door
--     (which owns the sandbox stamp and the clock copy); this function keeps
--     what is genuinely its own: the business record, the founder, and the
--     arrival's outcome. created_on stays the founder's date (0049).
-- -----------------------------------------------------------------------------
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
  begin
    perform app.create_tenant(p_academy_id, p_sender_id, 'business');

    -- 0049: the founding date is the founder's own date, from the instant this
    -- call was handed, never the host's `current_date`.
    insert into academy (id, kind, sender_id, name, category, onboarding_state, created_on)
    values (p_academy_id, 'business', p_sender_id, p_name, nullif(p_category, ''), 'setup',
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

    return jsonb_build_object(
      'academy_id', p_academy_id,
      'person_id',  v_person,
      'contact_id', v_contact
    );
  end;
  $$;

revoke all on function app.found_business(uuid, uuid, text, text, text, text, text, uuid, timestamptz) from public, cm_user, cm_readonly;
grant execute on function app.found_business(uuid, uuid, text, text, text, text, text, uuid, timestamptz) to cm_service;

comment on function app.found_business(uuid, uuid, text, text, text, text, text, uuid, timestamptz) is
  'Founds a business from the front desk in one transaction: tenant (via '
  'app.create_tenant, which owns the is_sandbox stamp and the clock inheritance), '
  'academy, founder, contact, admin and the arrival outcome. created_on is the '
  'founder''s own date (0049).';

-- -----------------------------------------------------------------------------
-- 8 · app.identity (last def 0051:86) — the tenant rides along, the academy may
--     be absent. Only the join and the first three keys change; the role logic
--     is byte-for-byte 0051.
-- -----------------------------------------------------------------------------
create or replace function app.identity(p_contact_id uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select jsonb_build_object(
      'academy_id', t.id,
      'tenant',     to_jsonb(t),
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
        where co.academy_id = t.id and co.person_id = p.id
        order by (co.status = 'ended'), co.created_at
        limit 1
      ),
      'account_ids', (
        select coalesce(jsonb_agg(ac.id order by ac.created_at), '[]'::jsonb)
        from account ac
        where ac.academy_id = t.id and ac.holder_person_id = p.id
      ),
      'player_ids', (
        select coalesce(jsonb_agg(pl.id order by pl.created_at), '[]'::jsonb)
        from player pl
        where pl.academy_id = t.id
          and (pl.person_id = p.id
               or pl.account_id in (select ac.id from account ac
                                    where ac.academy_id = t.id
                                      and ac.holder_person_id = p.id))
      ),
      'is_solo', app.is_solo(t.id),
      'sees_money', (r.is_admin or r.is_holder)
    )
    from contact c
    join person  p on p.id = c.person_id
    join tenant  t on t.id = c.academy_id
    left join academy a on a.id = t.id
    cross join lateral (
      select
        exists (select 1 from academy_admin aa
                where aa.academy_id = t.id and aa.person_id = p.id)       as is_admin,
        exists (select 1 from coach co
                where co.academy_id = t.id and co.person_id = p.id
                  and co.status <> 'ended')                               as is_coach,
        exists (select 1 from account ac
                where ac.academy_id = t.id and ac.holder_person_id = p.id) as is_holder,
        exists (select 1 from player pl
                where pl.academy_id = t.id and pl.person_id = p.id)        as is_player
    ) r
    where c.id = p_contact_id
  $$;

grant execute on function app.identity(uuid) to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- 9 · app.inbound_candidates (last def 0039:384) — the business list is now
--     positive by construction: every academy row IS a business. The desk id
--     comes from tenant.
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
      'front_desk_id', (
        select t.id from tenant t
        where t.sender_id = (select id from s) and t.kind = 'front_desk'
      ),
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

revoke all on function app.inbound_candidates(text, text) from public, cm_user, cm_readonly;
grant execute on function app.inbound_candidates(text, text) to cm_service;

-- -----------------------------------------------------------------------------
-- 10 · app.businesses_on_sender (last def 0039:522) — positive by construction.
--      SECURITY DEFINER for the same reason as before: a session pinned to the
--      desk can see the desk and nothing else, so a plain select from here
--      returns zero rows with no error.
-- -----------------------------------------------------------------------------
create or replace function app.businesses_on_sender(p_sender_id uuid)
returns table (id uuid, name text)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select a.id, a.name from academy a
     where a.sender_id = p_sender_id
     order by a.name
  $$;

revoke all on function app.businesses_on_sender(uuid) from public, cm_user, cm_readonly;
grant execute on function app.businesses_on_sender(uuid) to cm_service;

-- -----------------------------------------------------------------------------
-- 11 · app.lane_for (last def 0040:154) — the lane reads the tenant now.
-- -----------------------------------------------------------------------------
create or replace function app.lane_for(p_academy uuid) returns text
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select case
      when p_academy is null then 'live'
      when coalesce((select t.is_sandbox from tenant t where t.id = p_academy), false)
        then 'sim'
      else 'live'
    end
  $$;

revoke all on function app.lane_for(uuid) from public;
grant execute on function app.lane_for(uuid) to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- 12 · app.list_academies (last def 0007:13) — the console's cross-tenant view
--      now enumerates TENANTS, desks included (the console needs its desk pane,
--      and worldAcademyIds/resetWorld need to reap desk tenants). The return
--      widens by `kind`, and widening a returns-table needs DROP + CREATE, which
--      discards the ACL — hence the explicit re-revoke/re-grant (0030:88-96
--      documents this exact trap).
-- -----------------------------------------------------------------------------
drop function if exists app.list_academies();
create function app.list_academies()
returns table (
  id uuid, name text, category text, timezone text,
  onboarding_state text, sender_id uuid, created_on date,
  contact_count int, session_count int, kind text
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select t.id,
         coalesce(a.name, 'Front desk'),
         a.category,
         coalesce(a.timezone, 'Asia/Kolkata'),
         coalesce(a.onboarding_state, 'setup'),
         t.sender_id,
         coalesce(a.created_on, t.created_at::date),
         (select count(*)::int from contact c where c.academy_id = t.id),
         (select count(*)::int from session s where s.academy_id = t.id),
         t.kind
  from tenant t
  left join academy a on a.id = t.id
  order by coalesce(a.name, 'Front desk')
$$;

revoke all on function app.list_academies() from public, cm_user, cm_readonly;
grant execute on function app.list_academies() to cm_service;

-- -----------------------------------------------------------------------------
-- 13 · app.emulator_contacts (last def 0039:636) — the desk's visitors stay in
--      the contact tray. Only the academy join changes.
-- -----------------------------------------------------------------------------
create or replace function app.emulator_contacts()
returns table (
  contact_id uuid, academy_id uuid, academy_name text,
  person_id uuid, full_name text, phone_e164 text, wa_id text,
  state text, roles text[], coach_status text,
  last_inbound_at timestamptz, in_window boolean,
  unread int, last_message_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    c.id, c.academy_id, coalesce(a.name, 'Front desk'),
    p.id, p.full_name, c.phone_e164, c.wa_id,
    c.state,
    (
      select coalesce(array_agg(r order by r), '{}')
      from (
        select 'admin'::text  as r from academy_admin aa where aa.person_id = p.id and aa.academy_id = c.academy_id
        union
        select 'coach'        from coach co       where co.person_id = p.id and co.academy_id = c.academy_id
        union
        select 'player'       from player pl      where pl.person_id = p.id and pl.academy_id = c.academy_id
        union
        select 'account_holder' from account ac   where ac.holder_person_id = p.id and ac.academy_id = c.academy_id
      ) roles
    ),
    (select co.status from coach co where co.person_id = p.id and co.academy_id = c.academy_id limit 1),
    c.last_inbound_at,
    (c.last_inbound_at is not null and app.now() - c.last_inbound_at < interval '24 hours'),
    (select count(*)::int from message m
      where m.contact_id = c.id and m.direction = 'outbound' and m.read_at is null),
    (select max(m.queued_at) from message m where m.contact_id = c.id)
  from contact c
  join person p  on p.id = c.person_id
  join tenant t  on t.id = c.academy_id
  left join academy a on a.id = t.id
  order by coalesce(a.name, 'Front desk'), p.full_name
$$;

revoke all on function app.emulator_contacts() from public, cm_user, cm_readonly;
grant execute on function app.emulator_contacts() to cm_service;

-- -----------------------------------------------------------------------------
-- 14 · app.emulator_poll (last def 0050:59) — desk messages and desk turns stay
--      on the console's event stream. Only the two academy joins change; the
--      cursor logic is byte-for-byte 0050.
-- -----------------------------------------------------------------------------
create or replace function app.emulator_poll(
  p_since        timestamptz,
  p_status_since bigint,
  p_limit        int default 200,
  p_status_limit int default 200
) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
  as $$
  with msg as (
    select m.id, m.created_at, m.academy_id, coalesce(a.name, 'Front desk') as academy_name, m.contact_id,
           p.full_name as contact_name, m.direction, m.catalog_id, m.template_name,
           m.in_window, m.status, m.cost_paise, m.conversation_category,
           m.suppressed_reason, m.failed_reason, s.phone_e164 as sender_phone,
           left(coalesce(m.body, ''), 200) as body
      from message m
      left join academy a on a.id = m.academy_id
      join contact c on c.id = m.contact_id
      join person  p on p.id = c.person_id
      join sender  s on s.id = m.sender_id
     where m.created_at > p_since
     order by m.created_at asc
     limit p_limit
  ),
  trn as (
    select t.id, t.created_at, t.academy_id, coalesce(a.name, 'Front desk') as academy_name, t.contact_id,
           p.full_name as contact_name, t.role_acted, t.model, t.prompt_tokens,
           t.output_tokens, t.cached_tokens, t.latency_ms, t.error
      from turn t
      left join academy a on a.id = t.academy_id
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
    -- THE EVENT CURSOR, AT FULL PRECISION — see 0050 for why this must be the
    -- max over the rows actually RETURNED, at microsecond precision.
    'event_cursor', greatest(
      (select max(m.created_at) from msg m),
      (select max(t.created_at) from trn t),
      (select max(j.created_at) from jb  j)
    ),
    'offset_ms',     coalesce((select sc.offset_ms from sim_clock sc where sc.academy_id is null), 0),
    'now',           app.now_for(null)
  )
  $$;

revoke all on function app.emulator_poll(timestamptz, bigint, int, int) from public, cm_user, cm_readonly;
grant execute on function app.emulator_poll(timestamptz, bigint, int, int) to cm_service;

-- -----------------------------------------------------------------------------
-- 15 · app.dial_code (last def 0012:34) — a desk has no academy row, and this
--      used to return NULL from the empty scan rather than the default. Every
--      current caller coalesced it again downstream; now it keeps its own word.
-- -----------------------------------------------------------------------------
create or replace function app.dial_code(p_academy_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select coalesce(
           (select nullif(a.settings->>'dial_code', '') from public.academy a
             where a.id = p_academy_id),
           '+91')
$$;

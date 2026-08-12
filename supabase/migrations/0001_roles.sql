-- =============================================================================
-- 0001_roles.sql — schema `app`, session roles, GUC accessors, RLS predicates
-- Class Manager. Spec §2.1 (RLS is the security boundary), §6.7, §14.2.
--
-- Re-runnable. Applied as role `postgres` (owner of everything below).
--
-- ORDERING NOTE ---------------------------------------------------------------
-- Every predicate below reads tables that 0002 creates. Postgres validates
-- `language sql` bodies at CREATE FUNCTION time whenever check_function_bodies
-- is on (the default), so this file turns that check off for its own duration.
-- Bodies are classic dollar-quoted (never `begin atomic`), so nothing is
-- resolved until first execution — by which point 0002 has run.
-- =============================================================================

set check_function_bodies = off;

create schema if not exists app;

comment on schema app is
  'Security predicates and runtime helpers. Product tables live in public.';

-- -----------------------------------------------------------------------------
-- Roles (spec §6.7, §14.2)
--
-- cm_service : the runtime's own role (infrastructure: jobs, sender, message,
--              action, memory_fact, sim tables). Still tenant-pinned by
--              app.academy_id on every tenant table — a service action cannot
--              cross tenants.
-- cm_user    : a per-person session. read+write, RLS-scoped to that person's
--              role set (spec §6.7).
-- cm_readonly: model-authored SELECTs only (spec §14.2). Same visibility as
--              cm_user, SELECT-only.
--
-- All three are NOLOGIN. There is no LOGIN role: the app connects as `postgres`
-- and immediately `set local role`s to one of these for the duration of a
-- statement batch.
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cm_service') then
    create role cm_service nologin;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cm_user') then
    create role cm_user nologin;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'cm_readonly') then
    create role cm_readonly nologin;
  end if;
end
$$;

-- postgres must be a member of each to `set local role` into them.
grant cm_service, cm_user, cm_readonly to postgres;

-- Spec §14.2: model-authored reads get 5s and SELECT only.
-- NOTE: `alter role ... set` applies at connection time, not at `set role`.
-- The runtime must ALSO issue `set local statement_timeout` and
-- `set transaction read only` when it switches into cm_readonly mid-session.
-- These settings are the belt to that runtime brace.
alter role cm_readonly set statement_timeout = '5s';
alter role cm_readonly set default_transaction_read_only = on;
alter role cm_user     set statement_timeout = '15s';

grant usage on schema public, app to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- GUC accessors. The runtime sets app.academy_id / app.person_id /
-- app.contact_id with `set local` before acting as any role. `true` as the
-- second argument to current_setting means "null if unset" rather than error.
-- -----------------------------------------------------------------------------

create or replace function app.academy_id() returns uuid language sql stable
  as $$ select nullif(current_setting('app.academy_id', true), '')::uuid $$;

create or replace function app.person_id() returns uuid language sql stable
  as $$ select nullif(current_setting('app.person_id', true), '')::uuid $$;

create or replace function app.contact_id() returns uuid language sql stable
  as $$ select nullif(current_setting('app.contact_id', true), '')::uuid $$;

-- -----------------------------------------------------------------------------
-- Role predicates. SECURITY DEFINER (owner = postgres = table owner) so the
-- predicate itself is not filtered by the RLS of the table it reads — otherwise
-- app.is_admin() reading academy_admin would be gated by academy_admin's own
-- policy, which calls app.is_admin(). Every one pins search_path.
-- -----------------------------------------------------------------------------

-- Admin (spec §6.7 row 1): everything within their academy_id.
create or replace function app.is_admin() returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from academy_admin aa
      where aa.academy_id = app.academy_id()
        and aa.person_id  = app.person_id()
    )
  $$;

-- The coach hat, if this person wears one in this academy (spec §6.2, roles
-- compose). Null when they do not.
create or replace function app.my_coach_id() returns uuid
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select c.id from coach c
    where c.academy_id = app.academy_id()
      and c.person_id  = app.person_id()
    limit 1
  $$;

-- Accounts this person HOLDS. Holding is what carries money visibility
-- (spec §6.7 row 4) — being a player on the account is not enough.
create or replace function app.my_account_ids() returns uuid[]
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select coalesce(array_agg(a.id), '{}'::uuid[]) from account a
    where a.academy_id       = app.academy_id()
      and a.holder_person_id = app.person_id()
  $$;

-- The players this person may act for: themselves (spec §6.2, the self-paying
-- adult is account.holder_person_id = player.person_id) plus every player on an
-- account they hold.
create or replace function app.my_player_ids() returns uuid[]
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select coalesce(array_agg(p.id), '{}'::uuid[]) from player p
    where p.academy_id = app.academy_id()
      and (p.person_id = app.person_id()
           or p.account_id = any (app.my_account_ids()))
  $$;

-- Spec §6.7 row 4: money-shaped rows never route to a player's own number.
-- A player who is not the holder of their account gets false, and every
-- tally_line / payment policy is gated on this.
create or replace function app.sees_money() returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select app.is_admin()
        or coalesce(array_length(app.my_account_ids(), 1), 0) > 0
  $$;

-- Sessions this person can see (spec §6.7 rows 2–4). One statement:
--   admin  -> every session in the academy
--   coach  -> sessions they are assigned to (session_coach)
--   family -> sessions of classes any of their players is actively enrolled in
create or replace function app.my_session_ids() returns uuid[]
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select coalesce(array_agg(s.id), '{}'::uuid[])
    from session s
    where s.academy_id = app.academy_id()
      and (
        app.is_admin()
        or exists (
          select 1 from session_coach sc
          where sc.session_id = s.id
            and sc.coach_id   = app.my_coach_id()
        )
        or exists (
          select 1 from enrollment e
          where e.class_id  = s.class_id
            and e.player_id = any (app.my_player_ids())
            and e.ended_on is null
        )
      )
  $$;

grant execute on all functions in schema app to cm_service, cm_user, cm_readonly;

alter default privileges in schema app
  grant execute on functions to cm_service, cm_user, cm_readonly;

reset check_function_bodies;

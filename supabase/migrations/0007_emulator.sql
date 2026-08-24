-- 0007_emulator.sql
--
-- The emulator (§17) is a *world*, not a tenant: it deliberately shows several academies at
-- once, because "two academies, to prove tenant isolation" is one of the panes it exists to
-- open. That is a legitimate cross-tenant read — and the only one in the product.
--
-- Rather than punch a hole in the RLS policies to allow it, it lives here as two explicit
-- SECURITY DEFINER functions granted only to `cm_service`. A user session (cm_user /
-- cm_readonly) cannot execute them, so the agent can never reach them: the widest thing the
-- model can see is still one tenant. The dev surface gets its cross-tenant view through a
-- named door with the lights on, which is the point.

-- 0052 redefines this with a different row type (tenant split), so this file's
-- re-run must drop first: CREATE OR REPLACE cannot change a return type.
drop function if exists app.list_academies();

create or replace function app.list_academies()
returns table (
  id uuid, name text, category text, timezone text,
  onboarding_state text, sender_id uuid, created_on date,
  contact_count int, session_count int
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select a.id, a.name, a.category, a.timezone,
         a.onboarding_state, a.sender_id, a.created_on,
         (select count(*)::int from contact c where c.academy_id = a.id),
         (select count(*)::int from session s where s.academy_id = a.id)
  from academy a
  order by a.name
$$;

-- One row per contact in the world, with the person's *composed* roles (§6.2 — roles are
-- hats, so this is an array and never a scalar) and everything the contact tray renders.
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
    c.id, c.academy_id, a.name,
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
  join academy a on a.id = c.academy_id
  order by a.name, p.full_name
$$;

revoke all on function app.list_academies()     from public;
revoke all on function app.emulator_contacts()  from public;
grant execute on function app.list_academies()    to cm_service;
grant execute on function app.emulator_contacts() to cm_service;

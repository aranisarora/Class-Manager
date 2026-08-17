-- `academy_id` fills itself in, so forgetting it stops being a failure mode.
--
-- WHAT WAS HAPPENING
-- ----------------------------------------------------------------------------
-- Every tenant-scoped table carries `academy_id uuid not null` and NOTHING
-- defaulted it. So every INSERT the model composes had to state
-- `academy_id = app.academy_id()` on every row, and an insert that left it out
-- was refused by the RLS policy with:
--
--     new row violates row-level security policy for table "person"
--
-- which names a permission and is in fact a missing column. Measured on the
-- first run of `scripts/probe-sql.ts`: asked to add a coach, the model wrote
-- `insert into person (full_name) values ('Priya Nair')`, was refused, and spent
-- a round recovering. It knew the rule — SCHEMA_DOC states it twice, in bold —
-- and wrote the natural statement anyway, which is what a rule that fights the
-- shape of the language gets you.
--
-- PREFIX.md's own lesson, from the class/session case one migration ago: *an
-- instruction that describes a guarantee is a guarantee that does not exist.*
-- The instruction here described a column the writer must remember. This makes
-- it a column the database remembers, and the instruction unnecessary.
--
-- WHY THIS IS SAFE
-- ----------------------------------------------------------------------------
-- `app.academy_id()` is the GUC every session already sets (`withSession`), and
-- it is the SAME expression the RLS `with check` clause tests against. So the
-- default can only ever produce a value the policy was going to accept:
--
--   * a user session inserts into its own tenant, which is the only tenant it
--     may insert into anyway;
--   * a service session (`svc(academyId)`) inserts into the academy it opened
--     for, which is what every caller already passed explicitly;
--   * a session with no tenant GUC gets NULL and the NOT NULL constraint refuses
--     it — a clearer error than the policy's, and the same outcome.
--
-- Nothing that passes `academy_id` explicitly changes behaviour: a default only
-- applies to a column the statement omits. Cross-tenant writes in the seed and
-- the migrations state it, and keep working.
--
-- This does NOT weaken the boundary. RLS is unchanged; the policy still checks
-- every row. The only thing removed is the requirement to type it out.
--
-- Global tables (`sender`, `job`, `sim_run`) have no `academy_id` and are not
-- touched. `sim_clock` and `row_snapshot` are infrastructure written only by the
-- runtime, and are included for consistency rather than for the model's benefit.
--
-- Re-runnable.

do $$
declare
  t text;
begin
  foreach t in array array[
    'academy_admin', 'account', 'action', 'attendance', 'audit_entry',
    'business_rule', 'class', 'class_coach', 'class_slot', 'coach',
    'comm_preference', 'contact', 'enrollment', 'memory_fact', 'message',
    'payment', 'pending_request', 'person', 'player', 'row_snapshot',
    'session', 'session_coach', 'tally_line', 'turn', 'venue'
  ]
  loop
    if exists (
      select 1 from information_schema.columns
       where table_schema = 'public' and table_name = t and column_name = 'academy_id'
    ) then
      execute format('alter table public.%I alter column academy_id set default app.academy_id()', t);
    end if;
  end loop;
end
$$;

comment on function app.academy_id() is
  'The tenant of the current session, from the app.academy_id GUC. Also the '
  'DEFAULT of every tenant-scoped academy_id column (0034), so an INSERT that '
  'omits it lands in the caller''s own academy rather than being refused by a '
  'policy whose error names a permission and means a missing column.';

-- =============================================================================
-- 0004_functions.sql — the drivable clock, the derived expressions the spec
-- names, the job claim/enqueue pair, coverage views, event triggers, and the
-- RLS meta-test.
--
-- Layer 0/1 of §4: behavior pushed down until it is free and unforgettable.
-- Everything here is SECURITY DEFINER with a pinned search_path, so a predicate
-- is never itself gated by the RLS of the table it reads.
--
-- Re-runnable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- §13 / §17 — the drivable clock. "Non-negotiable: the scheduler must be a
-- drivable abstraction, not a cron detail." EVERYTHING in the product reads
-- time through this: jobs, windows, expiries, coverage. now() appears nowhere
-- else, or the emulator's clock advance stops meaning anything.
--
-- One shared sim_clock row across all panes (§17). No row = real time.
-- -----------------------------------------------------------------------------
create or replace function app.now() returns timestamptz
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select now()
         + (coalesce((select sc.offset_ms from sim_clock sc limit 1), 0)::double precision
            * interval '1 millisecond')
  $$;

-- -----------------------------------------------------------------------------
-- §6.3 — coverage, verbatim. The most important derived value in the product.
-- Escalations are about SESSIONS, never people: a coach dropping out while
-- others remain assigned is information, not an alarm, and this expression is
-- why.
-- -----------------------------------------------------------------------------
create or replace function app.session_is_covered(p_session_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select exists (
      select 1 from session_coach sc
      where sc.session_id = p_session_id
        and sc.declined_at is null
        and (sc.confirmed_at is not null or sc.arrived_at is not null)
    )
  $$;

-- -----------------------------------------------------------------------------
-- §6.3 — "Rate lives on the enrollment, defaulting from the class."
-- coalesce(enrollment.x, class.x) for amount, unit and count. This is what
-- handles drop-ins inside a monthly batch, sibling discounts, scholarship
-- players and legacy rates without a schema branch.
-- -----------------------------------------------------------------------------
create or replace function app.effective_rate(p_enrollment_id uuid)
  returns table (amount numeric, unit text, cnt int)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select coalesce(e.rate_amount, c.rate_amount),
           coalesce(e.rate_unit,   c.rate_unit),
           coalesce(e.rate_count,  c.rate_count)
    from enrollment e
    join class c on c.id = e.class_id
    where e.id = p_enrollment_id
  $$;

-- -----------------------------------------------------------------------------
-- §6.4 — "Balance for a period = sum(tally_line.amount) - sum(confirmed
-- payment.amount)." tally_line carries `period` directly; payment does not, so
-- a payment belongs to the period its confirmation falls in. Pass p_period null
-- for the running balance across all periods.
-- -----------------------------------------------------------------------------
create or replace function app.account_balance(p_account_id uuid, p_period date)
  returns numeric
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select coalesce((
             select sum(tl.amount) from tally_line tl
             where tl.account_id = p_account_id
               and (p_period is null or tl.period = p_period)
           ), 0)
         - coalesce((
             select sum(pm.amount) from payment pm
             where pm.account_id = p_account_id
               and pm.status = 'confirmed'
               and (p_period is null
                    or (pm.confirmed_at >= p_period::timestamptz
                        and pm.confirmed_at <  (p_period + interval '1 month')))
           ), 0)
  $$;

-- -----------------------------------------------------------------------------
-- §18 — the solo condition: exactly one `active` coach whose person_id is also
-- in academy_admin.
--
-- FOR SHAPING, NEVER GATING. §18: "Detection is not a mode." The two send-path
-- suppression rules — never ask someone to confirm something to themselves,
-- never escalate about a person to that person — produce the whole solo table
-- on their own, and they also catch the cases this predicate misses (the
-- two-coach academy where one is the admin, the admin covering a session this
-- week). Use this only to merge CO-DAY into AD-MORNING-BRIEF and to not offer
-- cover to a set of one. Recompute on coach add/end; never cache it in
-- academy.settings.
-- -----------------------------------------------------------------------------
create or replace function app.is_solo(p_academy_id uuid) returns boolean
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select (select count(*) from coach c
            where c.academy_id = p_academy_id and c.status = 'active') = 1
       and exists (
             select 1 from coach c
             join academy_admin aa
               on aa.person_id = c.person_id and aa.academy_id = c.academy_id
             where c.academy_id = p_academy_id and c.status = 'active'
           )
  $$;

-- -----------------------------------------------------------------------------
-- §6.6 / §13 — the runner. Claim due pending jobs atomically; `for update skip
-- locked` is what lets several workers run without one job going out twice.
-- Due-ness is measured against app.now(), so advancing the emulator's clock
-- fires scheduled work (§17, phase 1 acceptance).
-- -----------------------------------------------------------------------------
create or replace function app.claim_jobs(p_limit int, p_worker text)
  returns setof job
  language sql security definer set search_path = public, pg_temp
  as $$
    update job
       set status    = 'running',
           locked_at = now(),
           locked_by = p_worker,
           attempts  = attempts + 1
     where id in (
       select j.id from job j
       where j.status = 'pending'
         and j.run_at <= app.now()
       order by j.run_at
       limit p_limit
       for update skip locked
     )
    returning *;
  $$;

-- -----------------------------------------------------------------------------
-- §6.6 — "dedupe_key is what makes rescheduling and retries safe. Enqueueing
-- the same key twice is a no-op." The second call returns the id of the row
-- that is already there, so callers can always treat the return as "the job".
-- -----------------------------------------------------------------------------
create or replace function app.enqueue_job(
    p_kind       text,
    p_run_at     timestamptz,
    p_dedupe_key text,
    p_payload    jsonb default '{}'::jsonb
  ) returns uuid
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_id uuid;
begin
  insert into job (kind, run_at, dedupe_key, payload)
  values (p_kind,
          coalesce(p_run_at, app.now()),
          p_dedupe_key,
          coalesce(p_payload, '{}'::jsonb))
  on conflict (dedupe_key) do nothing
  returning id into v_id;

  if v_id is null then
    select j.id into v_id from job j where j.dedupe_key = p_dedupe_key;
  end if;

  return v_id;
end
$$;

-- =============================================================================
-- Views
-- =============================================================================

-- uncovered_session reads session_coverage, so it is dropped first.
drop view if exists public.uncovered_session;
-- CASCADE: session_detail (0036) reads this view and exists on any database the
-- chain has already built once, so a re-run must take it down too — 0036 drops
-- and recreates it whole two files later. Without cascade every re-push died
-- here (2BP01), which is the "db:push is not re-runnable" trap.
drop view if exists public.session_coverage cascade;

-- §6.3 / §11.1 — coverage as a table. Read by admin_escalate_uncovered,
-- client_session_trouble, the cover-offer path (§8.2) and the emulator.
-- security_invoker = true: a coach querying this sees only their own sessions,
-- because session's own policy still applies.
create view public.session_coverage with (security_invoker = true) as
  select
    s.id         as session_id,
    s.academy_id,
    s.starts_at,
    s.status,
    exists (select 1 from session_coach sc
            where sc.session_id = s.id
              and sc.declined_at is null
              and (sc.confirmed_at is not null or sc.arrived_at is not null)) as covered,
    (select count(*)::int from session_coach sc
     where sc.session_id = s.id
       and sc.declined_at is null
       and sc.confirmed_at is null
       and sc.arrived_at is null)                                            as pending_count,
    (select count(*)::int from session_coach sc
     where sc.session_id = s.id
       and sc.declined_at is null
       and (sc.confirmed_at is not null or sc.arrived_at is not null))       as confirmed_count,
    (select count(*)::int from session_coach sc
     where sc.session_id = s.id
       and sc.declined_at is not null)                                       as declined_count
  from session s;

comment on view public.session_coverage is
  'Spec §6.3. Coverage is derived, never stored.';

-- The escalation surface: scheduled, still ahead, still nobody confirmed.
-- §8.3 step 4 — coach churn reuses this rather than inventing an escalation.
create view public.uncovered_session with (security_invoker = true) as
  select *
  from public.session_coverage
  where status = 'scheduled'
    and covered = false
    and starts_at > app.now();

comment on view public.uncovered_session is
  'Spec §11.1 / §12.4 AD-ESCALATE-UNCONFIRMED. Sessions, never people.';

grant select on public.session_coverage, public.uncovered_session
  to cm_service, cm_user, cm_readonly;

-- =============================================================================
-- Triggers
-- =============================================================================

-- -----------------------------------------------------------------------------
-- §11.2 — an inbound message is the only thing that opens the 24h window, and
-- contact.last_inbound_at is its source of truth (§6.2, §14.7). The same event
-- moves registered|prospect -> engaged. Putting this in a trigger is layer 0:
-- no send path can forget to stamp it.
-- -----------------------------------------------------------------------------
create or replace function app.touch_contact_inbound() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
begin
  if new.direction = 'inbound' then
    update contact
       set last_inbound_at = app.now(),
           state = case when state in ('registered', 'prospect') then 'engaged'
                        else state end
     where id = new.contact_id;
  end if;
  return new;
end
$$;

drop trigger if exists message_touch_contact_inbound on message;
create trigger message_touch_contact_inbound
  after insert on message
  for each row execute function app.touch_contact_inbound();

-- -----------------------------------------------------------------------------
-- §13 — client_outcome is the one event-triggered job in the table ("On
-- attendance marked"). Raising it from the row rather than from the register
-- code means an attendance written by the admin, the coach, the web register or
-- a model-authored transaction all raise it identically. The dedupe key makes
-- a later correction to the same row a no-op, per §13's idempotency rule.
-- -----------------------------------------------------------------------------
create or replace function app.attendance_enqueue_outcome() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
begin
  perform app.enqueue_job(
    'client_outcome',
    app.now(),
    'outcome:' || new.session_id::text || ':' || new.player_id::text,
    jsonb_build_object(
      'academy_id', new.academy_id,
      'session_id', new.session_id,
      'player_id',  new.player_id,
      'attendance_id', new.id
    )
  );
  return new;
end
$$;

drop trigger if exists attendance_enqueue_outcome on attendance;
create trigger attendance_enqueue_outcome
  after insert or update on attendance
  for each row execute function app.attendance_enqueue_outcome();

-- =============================================================================
-- §6.7 meta-test — "fail the build if any table has RLS disabled. That single
-- assertion catches the most common and most dangerous mistake."
-- The pgTAP suite asserts: select count(*) from app.rls_audit()
--   where not rls_enabled  ==> 0
-- and every tenant table has policy_count > 0.
-- =============================================================================
create or replace function app.rls_audit()
  returns table (tbl text, rls_enabled boolean, policy_count int)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select c.relname::text,
           c.relrowsecurity,
           (select count(*)::int from pg_policy p where p.polrelid = c.oid)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
    order by 1
  $$;

grant execute on all functions in schema app to cm_service, cm_user, cm_readonly;

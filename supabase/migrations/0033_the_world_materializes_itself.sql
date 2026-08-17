-- Sessions exist because slots exist, on every route.
--
-- ARCHITECTURE.md layer 0: "Derived state is materialized from the world, not
-- from the function you called. Sessions exist because slots exist — by code
-- that reads `class_slot`, on every route including a hand-written insert. The
-- old shape, where `create_class` was 'the only thing that schedules the
-- sessions', meant a class inserted any other way had weekly times and no
-- sessions that would ever happen."
--
-- That sentence was in the prompt, twice, as an instruction: reach for the
-- operation, because it is the only thing that schedules the sessions. An
-- instruction is what you write when the property is not true. It was also
-- half-false already — `planAhead` materialises every active class on every
-- tick — so a hand-written class DID get sessions, up to a tick later, and
-- nothing anywhere said which of the two stories was the real one. Two documents
-- describing one truth.
--
-- The truth is that a slot implies sessions. So the slot says so: an insert or a
-- change to `class_slot`, or a coach appearing on a class, enqueues the
-- materialiser for that class immediately — from a named operation, from raw
-- SQL the model composed, from a form, from a seed, and from routes nobody has
-- written yet.
--
-- `app.enqueue_job` is `on conflict (dedupe_key) do nothing` and the dedupe key
-- is per class per local day, so a class whose four slots are inserted in one
-- statement enqueues one job, and the tick's own planning finds it already
-- there. The handler itself is idempotent (`unique (class_id, starts_at)`).
--
-- Re-runnable.

create or replace function app.materialize_on_slot_change() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_class   uuid;
  v_academy uuid;
  v_date    text;
begin
  v_class   := coalesce(new.class_id, old.class_id);
  v_academy := coalesce(new.academy_id, old.academy_id);
  if v_class is null or v_academy is null then
    return coalesce(new, old);
  end if;

  -- The tenant's own local day, because the dedupe key is per day and the
  -- handler's horizon is counted from it. `app.now_for` rather than `now()`:
  -- the clock is drivable, and a job keyed to the host's date is a job that
  -- fires on the wrong day in every driven world.
  select to_char(app.now_for(v_academy) at time zone a.timezone, 'YYYY-MM-DD')
    into v_date
    from academy a where a.id = v_academy;

  perform app.enqueue_job(
    'materialize_sessions',
    app.now_for(v_academy),
    'materialize:' || v_class::text || ':' || coalesce(v_date, 'now'),
    jsonb_build_object('academy_id', v_academy, 'class_id', v_class)
  );
  return coalesce(new, old);
end
$$;

comment on function app.materialize_on_slot_change() is
  'A weekly slot implies dated sessions. This is what makes that true on every '
  'route rather than only inside create_class — including the model composing '
  'the INSERT itself, which is the direction this product is going.';

drop trigger if exists class_slot_materialize on class_slot;
create trigger class_slot_materialize
  after insert or update or delete on class_slot
  for each row execute function app.materialize_on_slot_change();

-- A coach joining a class has to reach the sessions that already exist: the
-- handler backfills `session_coach` from `class_coach`, and without this that
-- backfill waited for the next tick.
drop trigger if exists class_coach_materialize on class_coach;
create trigger class_coach_materialize
  after insert on class_coach
  for each row execute function app.materialize_on_slot_change();

-- A class whose date range moves grows or loses sessions at the tail.
create or replace function app.materialize_on_class_change() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_date text;
begin
  if tg_op = 'UPDATE'
     and new.starts_on is not distinct from old.starts_on
     and new.ends_on   is not distinct from old.ends_on
     and new.active    is not distinct from old.active then
    return new;
  end if;
  select to_char(app.now_for(new.academy_id) at time zone a.timezone, 'YYYY-MM-DD')
    into v_date from academy a where a.id = new.academy_id;
  perform app.enqueue_job(
    'materialize_sessions',
    app.now_for(new.academy_id),
    'materialize:' || new.id::text || ':' || coalesce(v_date, 'now'),
    jsonb_build_object('academy_id', new.academy_id, 'class_id', new.id)
  );
  return new;
end
$$;

drop trigger if exists class_materialize on class;
create trigger class_materialize
  after insert or update of starts_on, ends_on, active on class
  for each row execute function app.materialize_on_class_change();

-- ---------------------------------------------------------------------------
-- Nothing to go live with
-- ---------------------------------------------------------------------------
--
-- `set_onboarding_state` carried this precondition inside its own UPDATE: an
-- academy with no active class cannot become 'live'. That is a thing which must
-- never happen, which is the schema's job when the schema can say it — and the
-- alternative is a business whose reminders, digests and announcements are all
-- switched on over an empty timetable, messaging a roster about nothing.
--
-- A trigger rather than a CHECK, because the condition is about OTHER rows.

create or replace function app.guard_go_live() returns trigger
  language plpgsql
as $$
begin
  if new.onboarding_state = 'live' and old.onboarding_state is distinct from 'live' then
    if not exists (
      select 1 from class c
       where c.academy_id = new.id and c.active
         and (c.ends_on is null or c.ends_on >= (app.now_for(new.id) at time zone new.timezone)::date)
    ) then
      raise exception
        'this business has no class to go live with — going live starts the reminders, the '
        'digests and the announcements, and there is nothing for them to be about'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end
$$;

drop trigger if exists academy_guard_go_live on academy;
create trigger academy_guard_go_live
  before update of onboarding_state on academy
  for each row execute function app.guard_go_live();

-- ---------------------------------------------------------------------------
-- A phone number that cannot be a phone number
-- ---------------------------------------------------------------------------
--
-- The placeholder is a real driven failure and it was refused at the operation
-- boundary, which is the wrong layer twice: it held only for the one operation
-- somebody remembered to put it in, and it is a thing that must NEVER happen,
-- which is the schema's job when the schema can say it. It can.
--
-- Narrow on purpose. This refuses what no dial plan produces — every digit the
-- same, an ascending or descending run — and nothing else. A real number that
-- looks odd is somebody's number.

create or replace function app.is_placeholder_phone(p text) returns boolean
  language sql immutable
as $$
  -- **The NATIONAL part, not the whole string.** Testing the whole thing was the
  -- obvious version and it catches nothing: every E.164 number starts with a
  -- country code, so "+919999999999" is not all-one-digit and sailed straight
  -- through the check written to stop exactly it. The last ten digits are the
  -- number somebody would actually dial, and they are where a placeholder shows.
  with d as (select regexp_replace(coalesce(p, ''), '[^0-9]', '', 'g') as n),
       tail as (select right(d.n, 10) as t, d.n from d)
  select case
    when length(tail.n) < 7 then false
    else
      -- 9999999999, 0000000000
      tail.t ~ '^(.)\1+$'
      -- an ascending or descending run, whichever way round it was typed
      or tail.n like '%1234567890%'
      or tail.n like '%0987654321%'
      or tail.n like '%123456789%'
      or tail.n like '%987654321%'
  end
  from tail
$$;

alter table contact drop constraint if exists contact_phone_not_placeholder;
alter table contact
  add constraint contact_phone_not_placeholder
  check (not app.is_placeholder_phone(phone_e164));

comment on constraint contact_phone_not_placeholder on contact is
  'A placeholder number is a contact row that can never be reached, and it reads '
  'as a real one everywhere downstream. Refused here rather than in one operation, '
  'because it must never happen and the schema can say so.';

-- =============================================================================
-- 0043 — a rate carries the day it starts
--
-- One defect, three doors: a mutable money term is read at BILLING time instead
-- of at the time it was earned. Raising a price today therefore reaches
-- backwards and reprices things that already happened.
--
--   F-CJ  a one-to-one raised 900 -> 1,100 on 30 August, and the 25 August
--         register still unmarked. `unmarked_billable_session` answered
--         1100.00 for a class that ran at 900. The product diagnosed this to
--         the owner correctly, four times, and told the paying parent the
--         opposite four minutes later.
--   F-CL  `coach_month_lines` freezes August at 00:20 on 1 September and reads
--         `coach.pay_amount` AT THAT MOMENT, so a raise typed on the 25th
--         reprices all 24 of August's sessions.
--   F-CM  `packRemaining` recomputes `opened * size - consumed` with the class's
--         CURRENT `rate_count`, so restructuring a pack resizes every pack
--         already sold.
--
-- -----------------------------------------------------------------------------
-- ANSWERING 0038, WHICH REFUSED THIS TABLE BY NAME
-- -----------------------------------------------------------------------------
--
-- 0038 wrote "WHY NOT A DATED RATE TABLE. It was the obvious fix and it is the
-- wrong one." Its argument was that versioning every column somebody might
-- future-date is unbounded, and that freezing money when it is earned is not.
-- Both halves are still true. This table exists because 0038's MECHANISM HAS A
-- DOMAIN, and two of the three doors above are outside it.
--
-- WHAT 0038 GOT RIGHT, CONCEDED FIRST. F-CM needed no dated table at all. The
-- frozen row was already there and was missing a term: `tally_line` carried
-- `amount` and not `rate_count`, so the size of the pack a family bought existed
-- nowhere except on the class, where it is mutable. Three nullable columns on
-- `tally_line` — the same ones 0038 itself put on `coach_ledger` — are the whole
-- fix. That is 0038's pattern COMPLETED, not overturned.
--
-- WHERE THE MECHANISM CANNOT REACH. Freeze-at-earning is correct exactly when
-- the freeze instant IS the earning instant. It is not, twice:
--
--   . per_session families. The line is written when a HUMAN MARKS A REGISTER,
--     an arbitrary lag after the session ran, with no job and no deadline.
--   . coach per_session and per_hour. The freeze happens — one month late, and
--     at whatever the rate says then.
--
--   And the monthly case leaks in the tail: BILLING_CATCHUP_MONTHS lets
--   plan-ahead enqueue a period months old, and `monthlyLines` resolves the rate
--   when it RUNS. "August's number was frozen into a row on 1 August" is true
--   only when the job actually ran on 1 August.
--
-- AND 0038'S FORWARD-DATING ANSWER IS UNAVAILABLE HERE, BY CONSTRUCTION.
-- "A future-dated change is a row written early" works because
-- m:<player>:<class>:<period> is computable in August for September — a month is
-- known in advance. s:<player>:<session_id> is not. The session may be cancelled,
-- the player may cancel timely, the register may say absent. YOU CANNOT PRE-WRITE
-- A ROW WHOSE IDENTITY DOES NOT EXIST YET. So the one sentence the model keeps
-- saying to owners — "from 1 September" — has, for per-session, nowhere to go,
-- and has been said in prose with nothing behind it every time (F-AW).
--
-- THE BOUND 0038 ASKED FOR. What gets a valid time here is not "anything
-- future-dateable". It is the MULTIPLICAND in a product whose multiplier is a set
-- of dated events: rate_amount x sessions-that-ran, pay_amount x sessions-worked,
-- rate_count x packs-opened. A venue is not in a product. A sibling discount is an
-- adjustment line, which is 0038's own primitive. Three columns on three tables
-- is a bound, not a programme. If somebody later wants a dated venue: no.
--
-- AND THE COLUMNS DO NOT MOVE. `coach.pay_amount`, `enrollment.rate_amount` and
-- `class.rate_amount` stay exactly what 0038 left them: ONE number, the rate in
-- force NOW, and the default for rows not yet written. Every reader asking "what
-- does this cost" reads them and is unchanged. Only readers pricing something
-- that ALREADY HAPPENED change, and they change to ask for the date it happened
-- on. That is also why the model's cheapest query still works: `class_roster`
-- and `coalesce(e.rate_amount, c.rate_amount)` mean today, and always did.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 . rate_period — the rate a subject was on, and from when
-- -----------------------------------------------------------------------------
create table if not exists rate_period (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default app.now(),
  academy_id     uuid not null references academy(id) on delete cascade,

  -- Exactly one subject, and it is a REAL foreign key: a rate row for an
  -- enrolment that has been deleted is not history, it is litter.
  enrollment_id  uuid references enrollment(id) on delete cascade,
  class_id       uuid references class(id)      on delete cascade,
  coach_id       uuid references coach(id)      on delete cascade,

  -- The same (kind, id) idiom memory_fact uses (0002), derived rather than
  -- written, so there is ONE unique index and ONE conflict target instead of
  -- three partial ones. Nothing inserts these.
  subject_kind   text generated always as (
                   case when enrollment_id is not null then 'enrollment'
                        when class_id      is not null then 'class'
                        else                                'coach' end) stored,
  subject_id     uuid generated always as (
                   coalesce(enrollment_id, class_id, coach_id)) stored,

  amount         numeric(10,2),
  unit           text,
  rate_count     int,

  -- THE POINT OF THE TABLE. The day the rate STARTS APPLYING, which is not the
  -- day somebody typed it — created_at is that. F-CJ is the two being one column.
  effective_from date not null,

  stated_by      uuid references person(id),
  note           text
);

-- Constraints are re-stated on every push, so each is dropped first. Every
-- migration in this repo is sent whole again on every `db:push`, forever.
alter table rate_period drop constraint if exists rate_period_one_subject;
alter table rate_period add constraint rate_period_one_subject check (
  num_nonnulls(enrollment_id, class_id, coach_id) = 1
);

-- A coach is paid per session, per hour or per month; a family is billed per
-- session, month, term or package. One list for both would let a coach be paid
-- "per package", which is not a thing anybody can act on.
alter table rate_period drop constraint if exists rate_period_unit_by_subject;
alter table rate_period add constraint rate_period_unit_by_subject check (
  unit is null
  or (coach_id is not null and unit in ('per_session','per_hour','per_month'))
  or (coach_id is null     and unit in ('per_session','per_month','per_term','per_package'))
);

-- 0025, verbatim in intent: per_term needs its length and per_package its size,
-- or the billing job must guess — and its three readers guessed three numbers.
alter table rate_period drop constraint if exists rate_period_rate_count_required;
alter table rate_period add constraint rate_period_rate_count_required check (
  unit is null
  or unit not in ('per_term', 'per_package')
  or (rate_count is not null and rate_count > 0)
);

alter table rate_period drop constraint if exists rate_period_amount_sane;
alter table rate_period add constraint rate_period_amount_sane check (
  amount is null or amount >= 0
);

-- ONE rate per subject per day. Two rows for one subject on one date make "the
-- rate on that day" ambiguous, and ambiguous money is the defect this file is
-- about. It is also the conflict target the trigger needs: a price typed and
-- corrected five minutes later is one period, not two.
create unique index if not exists rate_period_subject_day
  on rate_period (subject_kind, subject_id, effective_from);
create index if not exists rate_period_academy_from_idx
  on rate_period (academy_id, effective_from);

comment on table rate_period is
  'The rate a subject was on, and from when. The rate columns on enrollment, class '
  'and coach are the number in force NOW and remain exactly that; this is where the '
  'ones before and after live. Read it through app.rate_on / app.pay_on or the '
  'rate_history view, never by hand: the enrolment-then-class fallback is three '
  'independent coalesces with a date under each.';

comment on column rate_period.effective_from is
  'The day this rate STARTS APPLYING. Not created_at, which is the day somebody '
  'typed it. A raise typed on 30 August "from 1 September" is effective_from '
  '2026-09-01 and created_at 2026-08-30 — F-CJ is those two being one column.';

comment on column rate_period.subject_id is
  'Generated from whichever of the three foreign keys is set. Do not write it.';

comment on column rate_period.note is
  'The owner''s own words for why, if they gave any. Nothing keys on this: 0038, '
  'and lib/billing-keys.ts, on text shown to a person also being the thing two '
  'writers recognise each other by.';

-- -----------------------------------------------------------------------------
-- 2 . app.today — the academy's own date, written once
-- -----------------------------------------------------------------------------
create or replace function app.today(p_academy_id uuid) returns date
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select (app.now() at time zone coalesce(
              (select ac.timezone from academy ac where ac.id = p_academy_id),
              'Asia/Kolkata'))::date
  $$;

comment on function app.today(uuid) is
  'Today, in the academy''s own timezone. The expression '
  '(app.now() at time zone ac.timezone)::date appears in six views and was about '
  'to appear in six more.';

-- -----------------------------------------------------------------------------
-- 3 . the trigger — the single author, raised from the ROW
--
-- An ordinary `update enrollment set rate_amount = 1100` — the write the model
-- already composes, and the one this repo will never stop it composing — writes
-- the matching rate_period row IN THE SAME STATEMENT. So history accrues with
-- zero change to how anything writes a rate, and there is no route that moves
-- one without the other. That is the difference between drift being impossible
-- and drift being merely unintended.
--
-- Raised from the row rather than from an operation for the reason 0004's
-- attendance trigger gives and F-BA proves: `mark_attendance`'s billing line
-- lives one layer up, and only one of four routes goes through it, so a
-- hand-written INSERT bills nobody. The history must not repeat that.
--
-- NO-OP SUPPRESSION is load-bearing twice. A re-typed identical price is not a
-- period; and it is also what makes the promotion sweep in plan-ahead safe to
-- run every day forever without minting a phantom row each time.
-- -----------------------------------------------------------------------------
create or replace function app.record_rate_period() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
declare
  v_amount numeric(10,2);
  v_unit   text;
  v_count  int;
  v_today  date;
  v_from   date;
  v_cur    record;
begin
  if TG_TABLE_NAME = 'coach' then
    v_amount := NEW.pay_amount;  v_unit := NEW.pay_unit;  v_count := null;
  else
    v_amount := NEW.rate_amount; v_unit := NEW.rate_unit; v_count := NEW.rate_count;
  end if;

  -- A rate that is entirely unset is not a period. "Not tracked" is a first-class
  -- state on a coach (0002) and pure inheritance is the normal case on an
  -- enrolment, and neither is a price anybody stated.
  if v_amount is null and v_unit is null and v_count is null then
    return NEW;
  end if;

  v_today := app.today(NEW.academy_id);

  -- On INSERT the rate has been in force since the thing began — but never later
  -- than today, or an upcoming class's price would be in force from nowhere and
  -- app.rate_on(x, today) would disagree with the column beside it. On UPDATE it
  -- starts today. That INSERT rule is exactly the backfill rule at the foot of
  -- this file: the backfill IS this trigger, applied to rows that predate it.
  if TG_OP = 'INSERT' then
    if TG_TABLE_NAME = 'enrollment' then
      v_from := least(NEW.started_on, v_today);
    elsif TG_TABLE_NAME = 'class' then
      v_from := least(NEW.starts_on, v_today);
    else
      v_from := least(coalesce(NEW.onboarded_at::date, NEW.created_at::date), v_today);
    end if;
  else
    v_from := v_today;
  end if;

  select rp.amount, rp.unit, rp.rate_count
    into v_cur
    from rate_period rp
   where rp.subject_kind = case TG_TABLE_NAME when 'enrollment' then 'enrollment'
                                              when 'class'      then 'class'
                                              else                   'coach' end
     and rp.subject_id = NEW.id
     and rp.effective_from <= v_from
   order by rp.effective_from desc
   limit 1;

  if found
     and v_cur.amount     is not distinct from v_amount
     and v_cur.unit       is not distinct from v_unit
     and v_cur.rate_count is not distinct from v_count then
    return NEW;
  end if;

  insert into rate_period
    (academy_id, enrollment_id, class_id, coach_id,
     amount, unit, rate_count, effective_from, stated_by)
  values
    (NEW.academy_id,
     case when TG_TABLE_NAME = 'enrollment' then NEW.id end,
     case when TG_TABLE_NAME = 'class'      then NEW.id end,
     case when TG_TABLE_NAME = 'coach'      then NEW.id end,
     v_amount, v_unit, v_count, v_from, app.person_id())
  on conflict (subject_kind, subject_id, effective_from) do update
     set amount     = excluded.amount,
         unit       = excluded.unit,
         rate_count = excluded.rate_count,
         stated_by  = coalesce(excluded.stated_by, rate_period.stated_by);

  return NEW;
end
$$;

comment on function app.record_rate_period() is
  'Writes the rate_period row for a rate change, from the row itself, so every '
  'route writes it identically — a model-composed UPDATE, an operation, the seed '
  'and a hand-typed psql alike. F-BA is what happens when this kind of effect '
  'lives in one of four call sites instead.';

drop trigger if exists enrollment_rate_period on enrollment;
create trigger enrollment_rate_period
  after insert or update of rate_amount, rate_unit, rate_count on enrollment
  for each row execute function app.record_rate_period();

drop trigger if exists class_rate_period on class;
create trigger class_rate_period
  after insert or update of rate_amount, rate_unit, rate_count on class
  for each row execute function app.record_rate_period();

drop trigger if exists coach_rate_period on coach;
create trigger coach_rate_period
  after insert or update of pay_amount, pay_unit on coach
  for each row execute function app.record_rate_period();

-- -----------------------------------------------------------------------------
-- 4 . the resolvers — ONE of them, and it hides the two-level fallback
--
-- SQL and not TypeScript, and the first reason is dispositive: four of the
-- readers are VIEWS. `unmarked_billable_session` has no TypeScript in front of
-- it at all. The model also composes SQL directly, so a SQL function is
-- publishable in the helper block it already reads and a TS function is
-- invisible to it.
--
-- app.session_roster is the precedent (0022: "the join is the same every time
-- and the model kept guessing it wrong, so it is written once here"). A rate is
-- a worse thing to guess than a join: enrolment over class, EACH COLUMN
-- INDEPENDENTLY, with a date under both. Six lookups. It lives here and nowhere.
--
-- INVOKER, deliberately — no security definer. The privacy boundary is
-- rate_period's own policy, which is already the union of the three subject
-- tables' boundaries; a definer function here would widen it. The same argument
-- 0037 makes for coach_pay being security_invoker.
-- -----------------------------------------------------------------------------
create or replace function app.class_rate_on(p_class_id uuid, p_on date)
  returns table (amount numeric, unit text, cnt int)
  language sql stable set search_path = public, pg_temp
  as $$
    select rp.amount, rp.unit, rp.rate_count
      from rate_period rp
     where rp.class_id = p_class_id
       and rp.effective_from <= p_on
     order by rp.effective_from desc
     limit 1
  $$;

-- 0053 widens this return type (adds amount_source/unit_source), so the re-run
-- of THIS file must drop first: CREATE OR REPLACE cannot change a return type.
-- Nothing live references it at this point in the chain — 0035's view and
-- 0037's class_roster both predate it.
drop function if exists app.rate_on(uuid, date);

create or replace function app.rate_on(p_enrollment_id uuid, p_on date)
  returns table (amount numeric, unit text, cnt int)
  language sql stable set search_path = public, pg_temp
  as $$
    select coalesce(er.amount,     cr.amount),
           coalesce(er.unit,       cr.unit),
           coalesce(er.rate_count, cr.rate_count)
      from enrollment e
      left join lateral (
        select rp.amount, rp.unit, rp.rate_count
          from rate_period rp
         where rp.enrollment_id = e.id and rp.effective_from <= p_on
         order by rp.effective_from desc
         limit 1
      ) er on true
      left join lateral (
        select rp.amount, rp.unit, rp.rate_count
          from rate_period rp
         where rp.class_id = e.class_id and rp.effective_from <= p_on
         order by rp.effective_from desc
         limit 1
      ) cr on true
     where e.id = p_enrollment_id
  $$;

create or replace function app.pay_on(p_coach_id uuid, p_on date)
  returns table (amount numeric, unit text)
  language sql stable set search_path = public, pg_temp
  as $$
    select rp.amount, rp.unit
      from rate_period rp
     where rp.coach_id = p_coach_id
       and rp.effective_from <= p_on
     order by rp.effective_from desc
     limit 1
  $$;

comment on function app.rate_on(uuid, date) is
  'What an enrolment cost on a given day: its own rate if it stated one that day, '
  'else its class''s, amount and unit and count each resolved independently — the '
  'same fallback app.effective_rate does for today, with a date under it. Pricing '
  'something that ALREADY HAPPENED uses the day it happened, never today.';

comment on function app.pay_on(uuid, date) is
  'What a coach was paid per unit on a given day. coach_pay.amount_for_session is '
  'the rate they are on NOW and answers a different question.';

-- -----------------------------------------------------------------------------
-- 5 . tally_line carries the terms it was written at
--
-- 0038's own pattern, which the coach side got and the family side did not:
-- coach_ledger.rate_amount is "the rate as it stood when this line was written,
-- copied rather than referenced". A tally_line froze the money and not the terms,
-- so a package line knew what it cost and not what it bought (F-CM).
--
-- All three are NULLABLE, and that is deliberate twice: a pre-0043 line has no
-- answer and must fall back to the live one rather than read as zero, and an
-- INSERT that does not name these columns keeps working exactly as it did.
-- -----------------------------------------------------------------------------
alter table tally_line add column if not exists rate_amount numeric(10,2);
alter table tally_line add column if not exists rate_unit   text;
alter table tally_line add column if not exists rate_count  int;

alter table tally_line drop constraint if exists tally_line_rate_unit_check;
alter table tally_line add constraint tally_line_rate_unit_check check (
  rate_unit is null
  or rate_unit in ('per_session','per_month','per_term','per_package')
);

comment on column tally_line.rate_amount is
  'The rate this line was computed at, frozen. A later raise cannot reprice it.';

comment on column tally_line.rate_count is
  'For a package line, THAT PACK''S OWN size — not the class''s current one. '
  'packRemaining multiplied by class.rate_count read live, so restructuring a '
  'pack from ten to eight silently resized every pack already sold (F-CM).';

-- -----------------------------------------------------------------------------
-- 6 . unmarked_billable_session — fixed in place
--
-- The single most wrong-by-construction reader in the repo, and the one F-CJ
-- quotes: it sums the rate as it stands NOW over sessions that are, by its own
-- WHERE, strictly in the PAST. It now resolves as of the session's own local
-- date, and so does the per_session test — a class that was per_month when it
-- ran did not owe a session line then and does not owe one now.
--
-- Changed rather than given a second column beside it. `unbilled_amount` is
-- known wrong; adding `unbilled_amount_then` next to it means the model reads
-- SCHEMA_DOC, sees two, and picks the shorter name.
--
-- Built ON app.session_roster still (0035): the enrolment-live-on-the-day
-- predicate is exactly the part a second copy gets subtly wrong. The enrollment
-- and class joins are gone because app.rate_on owns that fallback now.
-- -----------------------------------------------------------------------------
drop view if exists public.unmarked_billable_session;

create view public.unmarked_billable_session with (security_invoker = true) as
  select r.academy_id,
         r.session_id,
         r.class_id,
         r.class_name,
         r.starts_at,
         count(*)::int                 as unmarked_players,
         sum(rt.amount)::numeric(10,2) as unbilled_amount
    from app.session_roster r
    join session s  on s.id  = r.session_id
    join academy ac on ac.id = r.academy_id
    left join lateral app.rate_on(
      r.enrollment_id, (s.starts_at at time zone ac.timezone)::date) rt on true
   where r.attendance_status is null
     and not r.is_trial
     and rt.unit = 'per_session'
     and s.status <> 'cancelled'
     and s.ends_at < app.now()
   group by r.academy_id, r.session_id, r.class_id, r.class_name, r.starts_at;

comment on view public.unmarked_billable_session is
  'Finished, uncancelled sessions on a per-session rate whose register is still '
  'unmarked, so no tally line exists for them yet. NOT "this family owes money" — a '
  'per-month family owes the same either way. unbilled_amount is priced AT THE RATE '
  'THE SESSION RAN AT, not today''s: a class that ran at 900 owes 900 however many '
  'raises have landed since (F-CJ). Inherits the reader through session_roster.';

grant select on public.unmarked_billable_session
  to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- 7 . coach_pay — two columns APPENDED, nothing changed
--
-- pay_amount and amount_for_session keep their exact present meaning: the rate
-- the coach is on NOW. `end_coach` reads them for the OPEN month and is right to
-- (operations.ts, "settled months come from coach_ledger; only the open month is
-- derived"). The two new columns answer the other question, and the month close
-- reads those.
--
-- Two clearly-labelled answers to two different questions is this repo's own
-- idiom — coach_ledger for closed months against coach_pay for the live one.
-- Columns are APPENDED, so `create or replace` holds (0037).
-- -----------------------------------------------------------------------------
create or replace view public.coach_pay with (security_invoker = true) as
  select s.academy_id,
         sc.coach_id,
         pe.full_name                                as coach_name,
         s.id                                        as session_id,
         s.class_id,
         cl.name                                     as class_name,
         s.starts_at,
         app.local_label(s.starts_at, ac.timezone)   as local_start,
         s.status                                    as session_status,
         case
           when sc.declined_at  is not null then 'declined'
           when sc.arrived_at   is not null then 'arrived'
           when sc.confirmed_at is not null then 'confirmed'
           else                                  'assigned_no_answer'
         end                                         as coach_state,
         c.pay_unit,
         c.pay_amount,
         round(extract(epoch from (s.ends_at - s.starts_at)) / 3600.0, 2)::numeric(6,2)
                                                     as session_hours,
         (s.ends_at < app.now() and s.status <> 'cancelled' and sc.declined_at is null)
                                                     as worked,
         case
           when c.pay_amount is null                 then null
           when c.pay_unit   = 'per_month'           then null
           when not (s.ends_at < app.now() and s.status <> 'cancelled' and sc.declined_at is null)
                                                     then 0::numeric(10,2)
           when c.pay_unit   = 'per_session'         then c.pay_amount
           when c.pay_unit   = 'per_hour'
             then round(c.pay_amount * extract(epoch from (s.ends_at - s.starts_at)) / 3600.0, 2)
         end::numeric(10,2)                          as amount_for_session,
         -- appended by 0043
         pt.amount                                   as pay_amount_then,
         case
           when pt.amount is null                    then null
           when pt.unit   = 'per_month'              then null
           when not (s.ends_at < app.now() and s.status <> 'cancelled' and sc.declined_at is null)
                                                     then 0::numeric(10,2)
           when pt.unit   = 'per_session'            then pt.amount
           when pt.unit   = 'per_hour'
             then round(pt.amount * extract(epoch from (s.ends_at - s.starts_at)) / 3600.0, 2)
         end::numeric(10,2)                          as amount_then
    from session_coach sc
    join session s   on s.id  = sc.session_id
    join coach   c   on c.id  = sc.coach_id
    join person  pe  on pe.id = c.person_id
    join class   cl  on cl.id = s.class_id
    join academy ac  on ac.id = s.academy_id
    left join lateral app.pay_on(
      sc.coach_id, (s.starts_at at time zone ac.timezone)::date) pt on true;

comment on view public.coach_pay is
  'One row per coach per session they are named on, with pay_unit resolved. '
  'amount_for_session is at the rate they are on NOW and is the right number for the '
  'OPEN month; amount_then is at the rate in force the day it was worked, and that is '
  'what a closed month is written from (F-CL). worked means the session is over, was '
  'not cancelled and was not declined — not that a register was marked. Inherits the '
  'reader, so a coach sees only their own pay.';

grant select on public.coach_pay to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- 8 . class_roster and class_offering — "is it going up" becomes a column
--
-- These are the conversational readers, and they are what keeps the promotion
-- sweep's staleness window harmless. A future rate is a row that has not
-- activated yet, so the column beside it still says the old number until the
-- next planner pass. A model reading this row sees BOTH numbers and the date, in
-- one read, and cannot compose "it is 900" on the morning it became 1,100.
--
-- next_rate_from is the next day on which app.rate_on would answer differently —
-- across the enrolment's own rows AND its class's, because either can be what
-- changes. The rate is then resolved AT that date, which is the only way to get
-- the fallback right when both sides have history.
--
-- Columns APPENDED (0037), so `create or replace` holds and nothing is dropped.
-- -----------------------------------------------------------------------------
create or replace view public.class_roster with (security_invoker = true) as
  select cl.academy_id,
         cl.id                                    as class_id,
         cl.name                                  as class_name,
         e.id                                     as enrollment_id,
         e.is_trial,
         e.started_on,
         pl.id                                    as player_id,
         pe.full_name                             as player_name,
         pl.account_id,
         ah.full_name                             as account_holder,
         coalesce(e.rate_amount, cl.rate_amount)  as rate_amount,
         coalesce(e.rate_unit,   cl.rate_unit)    as rate_unit,
         coalesce(e.rate_count,  cl.rate_count)   as rate_count,
         -- appended by 0037
         e.ended_on,
         case
           when not pl.active                                                     then 'ended'
           when e.ended_on is not null
            and e.ended_on   < (app.now() at time zone ac.timezone)::date          then 'ended'
           when e.started_on > (app.now() at time zone ac.timezone)::date          then 'upcoming'
           else                                                                        'current'
         end                                      as standing,
         pl.active                                as player_active,
         case when e.rate_amount is not null then 'enrolment' else 'class' end
                                                  as rate_source,
         -- appended by 0043
         nxt.amount                               as next_rate_amount,
         nxt.unit                                 as next_rate_unit,
         nxt.cnt                                  as next_rate_count,
         nxt.d                                    as next_rate_from
    from class cl
    join academy ac on ac.id = cl.academy_id
    join enrollment e on e.class_id = cl.id and e.academy_id = cl.academy_id
    join player pl on pl.id = e.player_id
    join person pe on pe.id = pl.person_id
    left join account acc on acc.id = pl.account_id
    left join person ah on ah.id = acc.holder_person_id
    left join lateral (
      select min(rp.effective_from) as d
        from rate_period rp
       where rp.effective_from > (app.now() at time zone ac.timezone)::date
         and (rp.enrollment_id = e.id or rp.class_id = cl.id)
    ) nx on true
    left join lateral (
      select * from app.rate_on(e.id, nx.d) where nx.d is not null
    ) nr on true
    -- A change is only a change for THIS player if it moves THEIR number. A
    -- class rise does not reach an enrolment that states its own rate — that is
    -- what rate_source = 'enrolment' means — and advertising a date beside an
    -- unchanged amount would be a sentence the model could not use.
    left join lateral (
      select nr.amount, nr.unit, nr.cnt, nx.d
       where nr.amount is distinct from coalesce(e.rate_amount, cl.rate_amount)
          or nr.unit   is distinct from coalesce(e.rate_unit,   cl.rate_unit)
          or nr.cnt    is distinct from coalesce(e.rate_count,  cl.rate_count)
    ) nxt on true;

grant select on public.class_roster to cm_service, cm_user, cm_readonly;

comment on view public.class_roster is
  'Who is on a class''s register, in every tense, and what each of them actually pays. '
  'standing is upcoming|current|ended — filter on it rather than on dates. rate_source '
  'says whether the rate came off the enrolment or fell back to the class, which is the '
  'difference between a member who was grandfathered and one who was not. rate_amount is '
  'what they pay NOW; next_rate_amount and next_rate_from are a change already on file, '
  'null when there is none — so "is it going up" is a column and not a calculation.';

create or replace view public.class_offering with (security_invoker = true) as
  select cl.academy_id,
         cl.id       as class_id,
         cl.name     as class_name,
         cl.active,
         cl.starts_on,
         cl.ends_on,
         case
           when not cl.active                                              then 'closed'
           when cl.ends_on is not null
            and cl.ends_on   < (app.now() at time zone ac.timezone)::date  then 'ended'
           when cl.starts_on > (app.now() at time zone ac.timezone)::date  then 'upcoming'
           else                                                                 'running'
         end         as standing,
         cl.rate_amount,
         cl.rate_unit,
         cl.rate_count,
         v.id        as venue_id,
         v.name      as venue_name,
         v.address   as venue_address,
         sl.slot_count,
         sl.schedule_label,
         sl.slots,
         co.coaches,
         -- appended by 0043
         nxt.amount  as next_rate_amount,
         nxt.unit    as next_rate_unit,
         nxt.cnt     as next_rate_count,
         nxt.d       as next_rate_from
    from class cl
    join academy ac on ac.id = cl.academy_id
    left join venue v on v.id = cl.venue_id
    left join lateral (
      select count(*)::int as slot_count,
             string_agg(app.slot_label(cs.weekday, cs.start_time, cs.end_time), '; '
                        order by cs.weekday, cs.start_time)      as schedule_label,
             coalesce(jsonb_agg(jsonb_build_object(
                 'weekday', cs.weekday,
                 'day',     app.day_name(cs.weekday),
                 'starts',  app.clock_label(cs.start_time),
                 'ends',    app.clock_label(cs.end_time),
                 'label',   app.slot_label(cs.weekday, cs.start_time, cs.end_time))
               order by cs.weekday, cs.start_time), '[]'::jsonb) as slots
        from class_slot cs
       where cs.class_id = cl.id
    ) sl on true
    left join lateral (
      select coalesce(jsonb_agg(jsonb_build_object(
                 'coach_id', ccp.coach_id,
                 'name',     ccp.full_name,
                 'status',   ccp.status)
               order by ccp.full_name), '[]'::jsonb)             as coaches
        from public.class_coach_public ccp
       where ccp.class_id = cl.id
    ) co on true
    left join lateral (
      select min(rp.effective_from) as d
        from rate_period rp
       where rp.class_id = cl.id
         and rp.effective_from > (app.now() at time zone ac.timezone)::date
    ) nx on true
    left join lateral (
      select * from app.class_rate_on(cl.id, nx.d) where nx.d is not null
    ) nr on true
    left join lateral (
      select nr.amount, nr.unit, nr.cnt, nx.d
       where nr.amount is distinct from cl.rate_amount
          or nr.unit   is distinct from cl.rate_unit
          or nr.cnt    is distinct from cl.rate_count
    ) nxt on true;

grant select on public.class_offering to cm_service, cm_user, cm_readonly;

comment on view public.class_offering is
  'What the business sells: one row per class, its weekly slots already rendered, its '
  'venue, its rate and the coaches named on it. The only grain a prospect can ask '
  'about. standing is closed|ended|upcoming|running. rate_amount is the price today; '
  'next_rate_amount and next_rate_from are a rise already on file, null when none.';

-- -----------------------------------------------------------------------------
-- 9 . rate_history — the whole story, with the tense already worked out
--
-- `standing` is the point, and it is a WORD rather than arithmetic — the same
-- idiom class_roster.standing and class_offering.standing already use. Without
-- it the model hand-rolls a window function to answer "has this gone up", and a
-- hand-rolled second copy of a predicate is how 0035 and 0022 both describe
-- getting it wrong.
--
-- effective_to is the day before the next period starts, and null while a period
-- is the last one on file. RLS filters rows BEFORE lead() runs, so a partially
-- visible subject would get a wrong effective_to — safe here only because the
-- select policy keys on the SUBJECT and never on the individual row, so
-- visibility is all-or-nothing per subject. Anybody adding a per-row condition
-- to that policy breaks this silently.
-- -----------------------------------------------------------------------------
create or replace view public.rate_history with (security_invoker = true) as
  select rp.academy_id,
         rp.subject_kind,
         rp.subject_id,
         coalesce(pe.full_name, cl.name, ecl.name || ' — ' || ppe.full_name)
                                                       as subject_label,
         rp.amount,
         rp.unit,
         rp.rate_count,
         rp.effective_from,
         (lead(rp.effective_from) over w - 1)          as effective_to,
         case
           when rp.effective_from > app.today(rp.academy_id)            then 'scheduled'
           when lead(rp.effective_from) over w is null                  then 'current'
           when lead(rp.effective_from) over w > app.today(rp.academy_id) then 'current'
           else                                                              'past'
         end                                           as standing,
         rp.note,
         rp.created_at                                 as stated_at,
         sb.full_name                                  as stated_by_name
    from rate_period rp
    left join coach c    on c.id  = rp.coach_id
    left join person pe  on pe.id = c.person_id
    left join class cl   on cl.id = rp.class_id
    left join enrollment e   on e.id   = rp.enrollment_id
    left join class ecl      on ecl.id = e.class_id
    left join player pl      on pl.id  = e.player_id
    left join person ppe     on ppe.id = pl.person_id
    left join person sb  on sb.id = rp.stated_by
  window w as (partition by rp.subject_kind, rp.subject_id order by rp.effective_from);

comment on view public.rate_history is
  'One row per time a price actually MOVED — for an enrolment, a class or a coach. '
  'standing is past|current|scheduled: filter on that word, never on date arithmetic, '
  'and never rebuild effective_to with a window function of your own. A rate stated on '
  'a CLASS applies to every enrolment that has not stated its own, which is the same '
  'fallback class_roster.rate_source names.';

grant select on public.rate_history to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- 10 . RLS — the union of the three subjects' own boundaries, and no wider
--
-- NO cm_user WRITE POLICY, on purpose. The model never needs to insert one: the
-- trigger writes the "now" case from the UPDATE it already composes, and the
-- set_rate operation writes the "later" case as the runtime. A three-nullable-FK
-- table with a num_nonnulls CHECK is a plan-losing trap for a composed INSERT —
-- it sets two or none and takes the whole plan with it — so the table is listed
-- in NOT_INSERTABLE (scripts/check-schema-doc.ts) beside memory_fact, and
-- SCHEMA_DOC says out loud what to do instead.
-- -----------------------------------------------------------------------------
alter table rate_period alter column academy_id set default app.academy_id();
alter table rate_period enable row level security;

drop trigger if exists rate_period_snapshot on rate_period;
create trigger rate_period_snapshot after insert or update or delete on rate_period
  for each row execute function app.snapshot_row();

drop policy if exists rate_period_cm_service_all on rate_period;
create policy rate_period_cm_service_all on rate_period
  for all to cm_service
  using (academy_id = app.academy_id())
  with check (academy_id = app.academy_id());

-- Helpers wrapped as (select app.f()) so the planner hoists them to an InitPlan
-- instead of re-evaluating per candidate row (0028). Writes stay unwrapped.
--
-- Three branches, one per subject, each mirroring that subject's own policy:
--   coach       — their own pay and no other coach's, the boundary coach_ledger draws.
--   enrollment  — the family's own children, or a coach for a class they teach.
--                 app.sees_money() is deliberately ABSENT: 0003 says an enrolment
--                 rate is the family's own price, not the academy's money.
--   class       — the published offer. class_offering already shows the current one
--                 to anybody in the business; restricting its history would be theatre.
drop policy if exists rate_period_cm_user_select on rate_period;
create policy rate_period_cm_user_select on rate_period
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and (
      (select app.is_admin())
      or coach_id = (select app.my_coach_id())
      or class_id is not null
      or exists (
        select 1 from enrollment e
         where e.id = rate_period.enrollment_id
           and (e.player_id = any (app.my_player_ids())
                or exists (select 1 from session se
                            where se.class_id = e.class_id
                              and se.id = any (app.my_session_ids())))
      )
    )
  );

grant select, insert, update, delete on rate_period to cm_service;
grant select on rate_period to cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- 11 . backfill — the trigger's own INSERT rule, applied to rows that predate it
--
-- effective_from is the subject's own beginning, CAPPED AT TODAY. Four reasons,
-- and each rules out an alternative:
--
--   . not today. Then app.rate_on(x, yesterday) is null, and every register
--     already waiting — F-CJ's own included — reads null in
--     unmarked_billable_session. The fix's first act would be to break the view
--     it was built for.
--   . not -infinity. Every string the model is given is prompt, and
--     "900 since -infinity" is a sentence rate_history would license.
--   . capped, because class.starts_on can be in the FUTURE. An uncapped row
--     would leave app.rate_on(class, today) null while class.rate_amount says
--     2,000, breaking the drift invariant on the day it shipped.
--   . the claim it makes is small and true: this is the number, as far back as
--     anything here can price. Below the subject's start there is nothing to
--     price, so it is operationally -infinity and reads as a date.
--
-- The guard is "no row for this subject AT ALL", never "no row at this date".
-- Every migration re-runs forever; the second form would insert today's value at
-- an ancient date once real history had accrued.
--
-- NOT backfilled from row_snapshot or coach_ledger.rate_amount, though both hold
-- the destroyed numbers. Both are keyed to WHEN THE COLUMN WAS TYPED, and F-CJ
-- is precisely the gap between when it was typed (30 Aug) and when it was meant
-- (1 Sep). Mining them would assert a false effective date, on money, in a file
-- that runs again on every push. Where a specific historical case matters, a
-- person reconstructs it from row_snapshot and writes an adjustment line, which
-- is 0038's own primitive doing the job it exists for.
-- -----------------------------------------------------------------------------
insert into rate_period (academy_id, enrollment_id, amount, unit, rate_count, effective_from)
select e.academy_id, e.id, e.rate_amount, e.rate_unit, e.rate_count,
       least(e.started_on, app.today(e.academy_id))
  from enrollment e
 where (e.rate_amount is not null or e.rate_unit is not null or e.rate_count is not null)
   and not exists (select 1 from rate_period rp where rp.enrollment_id = e.id)
on conflict (subject_kind, subject_id, effective_from) do nothing;

insert into rate_period (academy_id, class_id, amount, unit, rate_count, effective_from)
select cl.academy_id, cl.id, cl.rate_amount, cl.rate_unit, cl.rate_count,
       least(cl.starts_on, app.today(cl.academy_id))
  from class cl
 where (cl.rate_amount is not null or cl.rate_unit is not null or cl.rate_count is not null)
   and not exists (select 1 from rate_period rp where rp.class_id = cl.id)
on conflict (subject_kind, subject_id, effective_from) do nothing;

insert into rate_period (academy_id, coach_id, amount, unit, effective_from)
select c.academy_id, c.id, c.pay_amount, c.pay_unit,
       least(coalesce(c.onboarded_at::date, c.created_at::date), app.today(c.academy_id))
  from coach c
 where (c.pay_amount is not null or c.pay_unit is not null)
   and not exists (select 1 from rate_period rp where rp.coach_id = c.id)
on conflict (subject_kind, subject_id, effective_from) do nothing;

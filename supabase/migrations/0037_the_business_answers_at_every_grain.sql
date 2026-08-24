-- =============================================================================
-- 0037_the_business_answers_at_every_grain.sql
--
-- 0036 gave the day, the register, the books and the people a view each. This
-- one finishes the set, and it is driven by a reading of the schema rather than
-- by a list of things that broke.
--
-- A coaching business is asked about at four grains, and a person's sentence
-- lands on exactly one of them:
--
--   1  the OFFER        what do you run, when, where, what does it cost, who
--                       teaches it            class + class_slot + venue + class_coach
--   2  the COMMITMENT   who has signed up, from when, at what price
--                                             enrollment + player + account
--   3  the OCCURRENCE   this dated session: who is on it, who is due, who came
--                                             session + session_coach
--   4  the CONSEQUENCE  what is owed, what was paid, what was earned
--                                             tally_line + payment; coach
--
-- Grain 3 had two views and carried the week. Grain 1 had NONE — and it is the
-- only grain a prospect can ask about at all, because a stranger has no
-- enrolment, no session and no account. The whole acquisition path was
-- unserved. Grain 4 had a total (`account_standing`) and never a statement, and
-- gave the coach — whose one consequential question is "what am I owed" —
-- nothing but their own pay_amount and a raw join to compose.
--
-- TWO RULES THIS MIGRATION APPLIES, BOTH READ OFF THE SCHEMA
-- -----------------------------------------------------------------------------
-- A. A DEFINER VIEW MUST CARRY EVERY COLUMN ITS PURPOSE REQUIRES.
--    `coach_public` is security_invoker = false precisely so it can show every
--    coach past `coach`'s own-row-only policy. It carries no name. So every
--    caller joins `person` for one — and `person` is the most restricted table
--    in the schema — so that join silently re-imposes the policy the view
--    existed to bypass. Measured on the live tenant, from a coach's own seat:
--
--        select ... from coach_public                        -> 3 coaches
--        select ... from coach_public join person for a name -> 1 coach
--
--    A view whose purpose survives only until somebody asks it the one question
--    everybody asks is not a safe view. Hence `coach_directory`, which carries
--    the name, and `class_coach_public`, which does the same one level up:
--    `class_coach` is own-row-only too, so a coach reading the class-to-coach
--    map sees one row and concludes every other class has nobody on it.
--
-- B. A VIEW MUST NOT BAKE THE CLOCK INTO ITS ROWS.
--    `enrollment` models membership as a SPAN (started_on, ended_on) so the
--    business can speak in three tenses. `class_roster` filtered to
--    `started_on <= today` and collapsed the span to a point, which leaves the
--    commonest admin follow-up — "is the boy I just added in the class or not",
--    asked of an enrolment that starts next week — answerable only as "no".
--    app.now() belongs in the caller's WHERE. The view carries `standing`, and
--    the caller writes `where standing = 'current'`: shorter than the date
--    predicate it replaces, and it cannot be got wrong.
--
-- WHAT IS ADDED, CHANGED AND REMOVED
-- -----------------------------------------------------------------------------
--   +  app.day_name, app.clock_label, app.slot_label   a slot has no timestamp,
--      so app.local_label cannot reach it: the one grain with no renderer.
--   +  coach_directory        every coach, WITH the name (rule A)
--   +  class_coach_public     the class-to-coach map that does not collapse
--   +  class_offering         grain 1, which had nothing
--   +  account_ledger         the statement behind the balance
--   +  coach_pay              one row per coach per session, pay_unit resolved
--   ~  class_roster           clock unbaked; rate provenance exposed
--   ~  session_detail         one `coverage` column that says the sentence
--   -  uncovered_session      session_coverage with a baked clock (rule B) and a
--                             strict subset of session_detail. Nothing reads it.
--
-- `session_coverage` STAYS: session_detail joins it. It stops being prompt; it
-- does not stop being plumbing. `coach_public` STAYS untouched, because
-- person_cm_user_select takes a dependency on it and this migration
-- deliberately does not disturb a policy.
--
-- Re-runnable. Every changed view is `create or replace` with its new columns
-- appended at the end, so no view is dropped and no dependency is torn down.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Renderers for the one grain that has no clock.
--
-- A session has a timestamptz, so app.local_label puts it in the academy's zone
-- and in the product's own words. A weekly slot has an integer and two `time`s
-- and nothing to render them with. The model reached for to_char(weekday,'ID')
-- — a NUMERIC format mask applied to an integer — and got "I ." for every slot
-- in the business, silently. That is the class of error Postgres does not
-- complain about, which is the one a helper is for.
--
-- 2026-08-23 is a Sunday, which pins weekday 0 = Sun exactly as 0002 declares.
-- -----------------------------------------------------------------------------
create or replace function app.day_name(p_weekday int) returns text
  language sql immutable
  as $$ select to_char(date '2026-08-23' + p_weekday, 'Dy') $$;

comment on function app.day_name(int) is
  'class_slot.weekday (0=Sun..6=Sat) as "Mon". to_char(weekday, ''ID'') is a numeric '
  'mask on an integer: it returns junk and does not error.';

-- The same shape app.local_clock renders for a timestamp — "7 am", "6:30 pm" —
-- so a slot and a session read identically inside one sentence.
create or replace function app.clock_label(p_t time) returns text
  language sql immutable
  as $$
    select case
      when p_t is null then null
      else to_char(p_t, 'FMHH12')
           || case when extract(minute from p_t) = 0 then '' else to_char(p_t, ':MI') end
           || case when extract(hour from p_t) < 12 then ' am' else ' pm' end
    end
  $$;

comment on function app.clock_label(time) is
  'A bare time in the product''s words ("7 am", "6:30 pm"). The same rendering as '
  'app.local_clock, which only accepts a timestamptz.';

create or replace function app.slot_label(p_weekday int, p_start time, p_end time) returns text
  language sql immutable
  as $$
    select app.day_name(p_weekday) || ' ' || app.clock_label(p_start) || '-' || app.clock_label(p_end)
  $$;

comment on function app.slot_label(int, time, time) is
  'One weekly slot as a person hears it: "Mon 7 am-8 am".';

grant execute on function app.day_name(int)               to cm_service, cm_user, cm_readonly;
grant execute on function app.clock_label(time)           to cm_service, cm_user, cm_readonly;
grant execute on function app.slot_label(int, time, time) to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- coach_directory — coach_public, with the one column that makes it usable.
--
-- security_invoker = false, exactly like coach_public and for exactly its
-- reason: `coach` is own-row-only for non-admins, so a co-coach lookup through
-- it reads zero rows, and that zero is not an answer. The addition is
-- `full_name`, and the argument is rule A at the top of this file. The name is
-- on `person`; a caller who needs one joins `person`; `person` is restricted to
-- your own row, your family, your session rosters and the co-coaches on YOUR
-- sessions. So the join deletes precisely the rows this view exists to reveal,
-- and it did: a coach was told in the product's own voice that a colleague
-- standing on the Saturday class was not a coach in this business, and a
-- prospect asking who she would meet was told nothing at all.
--
-- Reading `person` here is not a new privilege. The view runs as its owner,
-- which is already how it reads `coach` past that table's own policy. It
-- carries NO pay column, which is the whole and only privacy boundary spec 8.1
-- draws between coaches — and 8.2 requires coaches to be offered each other's
-- sessions, so a coach knowing a colleague's name is the product working.
--
-- Keyed `coach_id`, not `id`: every other view in this schema names its key
-- <entity>_id, and coach_public's bare `id` is the one exception in nine
-- relations. That inconsistency is free to remove and is not free to keep.
-- -----------------------------------------------------------------------------
create or replace view public.coach_directory with (security_invoker = false) as
  select c.academy_id,
         c.id        as coach_id,
         c.person_id,
         p.full_name,
         c.status,
         c.ended_on
    from coach c
    join person p on p.id = c.person_id
   where c.academy_id = app.academy_id();

comment on view public.coach_directory is
  'Every coach in the business WITH their name, to anybody who asks, and no pay '
  'column to leak (spec 8.1). coach_public is the same rows without the name, kept '
  'only because person_cm_user_select depends on it.';

grant select on public.coach_directory to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- class_coach_public — rule A, one level up.
--
-- class_coach is `admin or coach_id = app.my_coach_id()`, so from a coach's
-- seat the whole class-to-coach map is their own row. Read as an answer, that
-- is "no coach is on any other class" — which is what was said to a coach about
-- a Saturday class that has two.
--
-- This is a MAP, not a schedule: who is named on a CLASS. Who is on a dated
-- session is session_coach, and session_detail already resolves that correctly,
-- because person_cm_user_select grants the co-coaches on sessions you are on.
-- -----------------------------------------------------------------------------
create or replace view public.class_coach_public with (security_invoker = false) as
  select cc.academy_id,
         cc.class_id,
         cc.coach_id,
         c.person_id,
         p.full_name,
         c.status
    from class_coach cc
    join coach c  on c.id = cc.coach_id
    join person p on p.id = c.person_id
   where cc.academy_id = app.academy_id();

comment on view public.class_coach_public is
  'Which coach is named on which CLASS, with names and no pay. class_coach itself is '
  'own-row-only for a coach, so an invoker read of it answers "nobody is on it" for '
  'every class but their own.';

grant select on public.class_coach_public to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- class_offering — grain 1. What the business sells.
--
-- The only grain a prospect can ask about, and it had no view: a stranger has
-- no enrolment, no session and no account, so class + class_slot + venue +
-- class_coach IS their entire surface. It was rebuilt by hand every time, in
-- four different spellings of "a class that is running", with the weekday put
-- through a numeric format mask.
--
-- One row per CLASS, not per slot: "what days do you run" is answered by four
-- rows, not seven. The slots ride along already rendered, as a jsonb array and
-- as one `schedule_label` string, because a class with two slots is one thing a
-- person asked about and two rows is not what they asked.
--
-- security_invoker = true, and it needs nothing more: class, class_slot and
-- venue are readable tenant-wide. The coaches come through class_coach_public,
-- because that half is not.
--
-- Deliberately NOT here: any headcount. enrollment is restricted, and a
-- prospect learning how many families are on a class is a leak this view would
-- open on every seat at once. Headcount belongs to class_roster, which inherits
-- the reader.
--
-- Deliberately NOT here: a rendered rate. rate_amount, rate_unit and rate_count
-- are three plain columns the model has never once got wrong in prose, and a
-- line stating what a competent reader derives is what this repo keeps deleting.
-- -----------------------------------------------------------------------------
-- 0043 appends next_rate_* to this view, so drop first on a re-run.
drop view if exists public.class_offering;
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
         co.coaches
    from class cl
    join academy ac on ac.id = cl.academy_id
    -- LEFT: a class whose venue is not set yet is a class, not a missing row.
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
    ) co on true;

comment on view public.class_offering is
  'What the business sells: one row per class, its weekly slots already rendered, its '
  'venue, its rate and the coaches named on it. The only grain a prospect can ask '
  'about. standing is closed|ended|upcoming|running.';

grant select on public.class_offering to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- account_ledger — the statement behind the balance.
--
-- account_standing answers HOW MUCH and is used. Nothing answered WHY, so every
-- follow-up — which charges, was July billed twice, has the UPI landed — went
-- back to raw tally_line and payment, and was the single largest hand-rolled
-- group across two weeks.
--
-- The shape is forced by the schema, not chosen. tally_line carries a period
-- and payment does not, so a payment CANNOT be attributed to a month by any
-- key — app.account_balance() refuses a period for this exact reason. If
-- charges and payments cannot be matched to each other, then the only correct
-- reading of an account is the movements in time order with the balance carried
-- down the page. That is a ledger, and it is what a person means when they ask
-- what they are being charged for.
--
-- THREE MONEY COLUMNS, EACH SAYING ONE TRUE THING:
--   amount            what is written on the row. Negative on a credit or a
--                     waiver, which is how an adjustment is stored.
--   effect_on_balance what this row moved the balance BY. A requested payment
--                     moves it by nothing — money somebody says they sent is
--                     not money that arrived, which is the same distinction
--                     account_standing draws between paid and
--                     awaiting_confirmation.
--   running_balance   the balance after this row. The last one equals
--                     account_standing.balance, and if it ever does not, one of
--                     the two is wrong and that is worth seeing.
--
-- charges_in_period is a COUNT, not a verdict. Two charge lines on one period
-- is a fact; whether it is a mistake is a reading, and a column named
-- `duplicate` would license a sentence that can be false — a second charge in a
-- month is legitimate for a sibling, a pack or a pro-rate. The one real
-- instance of this in a live week was found only because the model went and
-- fetched `dedupe_key`, a plumbing column, to reason about it.
-- -----------------------------------------------------------------------------
create or replace view public.account_ledger with (security_invoker = true) as
  with movement as (
    select tl.academy_id,
           tl.account_id,
           tl.id                            as movement_id,
           'charge'::text                   as kind,
           tl.created_at                    as at,
           tl.description,
           tl.amount,
           tl.amount                        as effect_on_balance,
           tl.period,
           tl.kind                          as charge_kind,
           tl.player_id,
           tl.session_id,
           tl.reason,
           null::text                       as status,
           null::text                       as method,
           null::text                       as reference
      from tally_line tl
    union all
    select pm.academy_id,
           pm.account_id,
           pm.id,
           'payment',
           -- When the money moved, not when the row was made: a payment matters
           -- on the day it was attested, and a request matters on the day it
           -- was claimed.
           coalesce(pm.confirmed_at, pm.requested_at, pm.created_at),
           case when pm.reference is not null and pm.reference <> ''
                then 'Payment ' || pm.reference
                else 'Payment' end,
           pm.amount,
           case when pm.status = 'confirmed' then -pm.amount else 0 end,
           null::date,
           null::text,
           null::uuid,
           null::uuid,
           null::text,
           pm.status,
           pm.method,
           pm.reference
      from payment pm
  )
  select m.academy_id,
         m.account_id,
         m.movement_id,
         m.kind,
         m.at,
         app.local_label(m.at)  as local_at,
         m.description,
         m.amount,
         m.effect_on_balance,
         sum(m.effect_on_balance) over (
           partition by m.account_id
           order by m.at, m.movement_id
           rows between unbounded preceding and current row
         )::numeric(10,2)       as running_balance,
         m.period,
         m.charge_kind,
         m.status,
         m.method,
         m.reference,
         m.player_id,
         m.session_id,
         m.reason,
         case when m.kind = 'charge' then
           count(*) filter (where m.kind = 'charge')
             over (partition by m.account_id, m.period)
         end::int               as charges_in_period
    from movement m;

comment on view public.account_ledger is
  'The statement behind account_standing.balance: one row per movement on an account, '
  'charges and payments in time order, with the balance carried down. payment carries '
  'no period, so time order is the only way charges and payments can be read together. '
  'charges_in_period counts charge lines sharing a period — a fact, not a verdict.';

grant select on public.account_ledger to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- coach_pay — what a coach is owed, one session at a time.
--
-- Every seat could read what it owed except the one whose living it is. A
-- parent has account_standing; the owner has it per family; the coach had
-- pay_amount on their own row and a join to compose, and the join has a branch
-- in it that nothing resolved.
--
-- THE BRANCH IS THE POINT. pay_unit is per_session, per_hour or per_month, and
-- the three make a session count mean three different things:
--   per_session  the count is everything
--   per_hour     the count is nothing; the DURATION is everything
--   per_month    the count is IRRELEVANT — the same money whatever the register
--                says — so multiplying sessions by a rate invents a number
-- amount_for_session is null on per_month for that reason: null is "this
-- question does not apply to this coach", and a 0 would read as "worked for
-- nothing".
--
-- AND `worked` IS THE PREDICATE THAT WENT WRONG. Composed by hand, the test
-- reached for was status = 'scheduled', which is true only of sessions that
-- have NOT happened yet — so a month's work counted as none and a full-month
-- figure got extrapolated from a weekly pattern instead of read off rows. Pay
-- follows whether the session HAPPENED, not whether anybody marked a register:
--   worked = it is over, it was not cancelled, and you did not decline it.
-- session_status stays beside it, so "over but nobody marked it" is still
-- visible rather than folded away.
--
-- security_invoker = true and that is load-bearing: `coach` is own-row-only, so
-- a coach reads their own pay and no other, and the admin reads all of it. The
-- privacy boundary is the one already in the policy; this view adds nothing to
-- it. That is also why the name comes through an ordinary `person` join rather
-- than coach_directory — a definer join here would list every coach in the
-- business with a null pay against their name, which answers nobody's question
-- and reads like a leak that failed.
-- -----------------------------------------------------------------------------
-- 0043 appends pay_amount_then/amount_then, so drop first on a re-run.
drop view if exists public.coach_pay;
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
           -- null pay is "not tracked", a first-class state, and no arithmetic
           -- turns it into a number.
           when c.pay_amount is null                 then null
           when c.pay_unit   = 'per_month'           then null
           when not (s.ends_at < app.now() and s.status <> 'cancelled' and sc.declined_at is null)
                                                     then 0::numeric(10,2)
           when c.pay_unit   = 'per_session'         then c.pay_amount
           when c.pay_unit   = 'per_hour'
             then round(c.pay_amount * extract(epoch from (s.ends_at - s.starts_at)) / 3600.0, 2)
         end::numeric(10,2)                          as amount_for_session
    from session_coach sc
    join session s   on s.id  = sc.session_id
    join coach   c   on c.id  = sc.coach_id
    join person  pe  on pe.id = c.person_id
    join class   cl  on cl.id = s.class_id
    join academy ac  on ac.id = s.academy_id;

comment on view public.coach_pay is
  'One row per coach per session they are named on, with pay_unit resolved. '
  'amount_for_session is NULL on a per_month coach because a session count is '
  'irrelevant to what they earn, and NULL when pay is not tracked. worked means the '
  'session is over, was not cancelled and was not declined — not that a register was '
  'marked. Inherits the reader, so a coach sees only their own pay.';

grant select on public.coach_pay to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- class_roster — rule B. The clock comes out of the rows.
--
-- Two changes, both of which cost an answer while they were missing.
--
-- 1. THE SPAN, NOT THE POINT. The old WHERE pinned the view to today, so an
--    enrolment starting next week did not exist and one that ended last month
--    could not be looked up. "New boy for morning juniors from next week" is
--    followed one message later by "is he in the class or not", and the only
--    view built for that question would have said no. started_on and ended_on
--    were already here; ended_on now comes with them, and `standing` says which
--    tense a row is in. `where standing = 'current'` is the old behaviour in
--    one predicate.
--
-- 2. WHICH SIDE THE COALESCE TOOK. The rate columns resolve enrolment over
--    class, which is right, and then nothing said which one answered. That
--    distinction is not a detail here, it is a transaction: "everyone already
--    in it stays on 2400" when a class rate rises is exactly the act of writing
--    explicit rates onto enrolments, and you cannot tell whether it worked from
--    a resolved number. General rule: when a view resolves a fallback, it says
--    which branch it took, because the branch is usually the thing being
--    changed.
--
-- player.active moves into `standing` rather than staying a filter: a player
-- who left the academy is not on today's register, and the row still exists to
-- be found. player_active is exposed so the two reasons a row is not current
-- stay tellable apart.
--
-- Columns are APPENDED, so `create or replace` holds and nothing is dropped.
-- -----------------------------------------------------------------------------
-- 0043 appends columns to this view, so this file must drop first on a re-run:
-- CREATE OR REPLACE cannot drop columns from a view.
drop view if exists public.class_roster;
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
                                                  as rate_source
    from class cl
    join academy ac on ac.id = cl.academy_id
    join enrollment e on e.class_id = cl.id and e.academy_id = cl.academy_id
    join player pl on pl.id = e.player_id
    join person pe on pe.id = pl.person_id
    -- LEFT: a coach may read the players on their own sessions and may NOT read
    -- the accounts those players belong to. An inner join here would have shown
    -- a coach an empty register for a class they teach.
    left join account acc on acc.id = pl.account_id
    left join person ah on ah.id = acc.holder_person_id;

comment on view public.class_roster is
  'Who is on a class''s register, in every tense, and what each of them actually pays. '
  'standing is upcoming|current|ended — filter on it rather than on dates. rate_source '
  'says whether the rate came off the enrolment or fell back to the class, which is the '
  'difference between a member who was grandfathered and one who was not.';

grant select on public.class_roster to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- session_detail — one column that says the sentence.
--
-- The view offered coverage five ways: `covered`, three counts, and a state on
-- every entry of `coaches`. Asked "rest of the week anything not covered", with
-- seven rows in hand every one of which said covered = false and
-- assigned_no_answer, the answer given was "Nothing uncovered. Every session
-- this week has a coach assigned" — read off the names, which are the one
-- representation that does not answer the question. The block already warns
-- about this in this view's own paragraph, in as many words, and it happened
-- anyway; so the fix is one fewer representation, not one more warning.
--
-- This is the census-label rule applied inside a view: read the column and its
-- value with no access to the SQL above it, and say the sentence they license.
-- `covered = false` beside `coaches = [Arjun]` licenses two opposite sentences.
-- `coverage = 'nobody has answered'` licenses one, and it is true.
--
-- The states are the same four the product already uses for a single coach, so
-- a session and a coach are described in one vocabulary. 'cancelled' comes
-- first because a cancelled session does not need cover and must never be
-- counted as a gap.
--
-- Appended, so `create or replace` holds. The four older columns stay for
-- session_coverage's sake and stop being documented.
-- -----------------------------------------------------------------------------
create or replace view public.session_detail with (security_invoker = true) as
  select s.academy_id,
         s.id                                            as session_id,
         s.class_id,
         cl.name                                         as class_name,
         s.starts_at,
         s.ends_at,
         s.status,
         s.cancel_reason,
         (s.starts_at at time zone ac.timezone)::date    as local_date,
         app.local_label(s.starts_at, ac.timezone)       as local_start,
         app.local_clock(s.ends_at, ac.timezone)         as local_end,
         v.id                                            as venue_id,
         v.name                                          as venue_name,
         v.address                                       as venue_address,
         cov.covered,
         cov.pending_count,
         cov.confirmed_count,
         cov.declined_count,
         co.coaches,
         r.due_players,
         r.marked_players,
         r.attended_players,
         -- appended by 0037
         case
           when s.status = 'cancelled'     then 'cancelled'
           when cov.confirmed_count > 0    then 'confirmed'
           when cov.pending_count   > 0    then 'nobody has answered'
           when cov.declined_count  > 0    then 'all declined'
           else                                 'nobody assigned'
         end                                             as coverage
    from session s
    join class cl on cl.id = s.class_id
    join academy ac on ac.id = s.academy_id
    left join venue v on v.id = coalesce(s.venue_id, cl.venue_id)
    left join session_coverage cov on cov.session_id = s.id
    left join lateral (
      select coalesce(jsonb_agg(jsonb_build_object(
               'coach_id', sc.coach_id,
               'name',     pe.full_name,
               'state',    case
                             when sc.declined_at  is not null then 'declined'
                             when sc.arrived_at   is not null then 'arrived'
                             when sc.confirmed_at is not null then 'confirmed'
                             else                                  'assigned_no_answer'
                           end)
             order by pe.full_name nulls last), '[]'::jsonb) as coaches
        from session_coach sc
        left join coach_public cp on cp.id = sc.coach_id
        left join person pe on pe.id = cp.person_id
       where sc.session_id = s.id
    ) co on true
    left join lateral (
      select count(*)::int                                                             as due_players,
             count(*) filter (where sr.attendance_status is not null)::int             as marked_players,
             count(*) filter (where sr.attendance_status in ('present','late'))::int   as attended_players
        from app.session_roster sr
       where sr.session_id = s.id
    ) r on true;

comment on view public.session_detail is
  'One session as a person hears it. coverage is the one column that answers "is this '
  'covered": cancelled|confirmed|nobody has answered|all declined|nobody assigned. The '
  'names in `coaches` say who is down for it, which is a different question.';

grant select on public.session_detail to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- uncovered_session — removed.
--
-- Rule B in one relation: it is session_coverage with app.now() compiled into
-- it, so it answers one question on one day and cannot be asked another. It is
-- also a strict subset of session_detail, which carries the same four coverage
-- columns plus the class, the venue, the local times, the coaches and the
-- register — and, from this migration, the one column that states coverage
-- outright. `where coverage <> 'confirmed' and starts_at > app.now()` is the
-- same question against a relation that can answer the next one too.
--
-- Nothing in the runtime reads it. session_detail joins session_coverage, not
-- this, so dropping it tears down no dependency.
-- -----------------------------------------------------------------------------
drop view if exists public.uncovered_session;

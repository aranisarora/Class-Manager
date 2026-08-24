-- =============================================================================
-- 0053 — the register answers who stopped coming
--
-- Three things, one grain: the register.
--
--   1. The roster stops timing out. `app.session_roster` joins `enrollment` by
--      class with a date range that ADMITS ended enrolments, and the only
--      class-keyed index on `enrollment` was partial on `ended_on is null` — a
--      predicate the planner cannot prove, so it seq-scanned `enrollment` once
--      per driving session row. check-roster-scale, 24 Aug 2026, before this
--      file: one-session read 883ms at 50 sessions, STATEMENT TIMEOUT at 3000.
--
--   2. A register nobody can price stops vanishing. `unmarked_billable_session`
--      filtered `rt.unit = 'per_session'`, which a NULL unit fails — so an
--      enrolment with no rate anywhere dropped OUT of the one view whose job is
--      "is anything sitting unbilled", and ₹1,600 left the month with nothing
--      anywhere recording that it did (findings/OPEN.md, the coach-rate row).
--      The fallback's author is app.rate_on, so the branch it took becomes two
--      columns there (F-BK: a view that resolves a fallback says which branch),
--      and the view surfaces the unpriceable row with a word instead of a hole.
--
--   3. "Who never came" becomes a filter instead of an anti-join. F-EW: the SQL
--      ladder's anti-join case failed identically in three runs — the model's
--      reasoning was right and its inner join answered the opposite question
--      with plausible rows. player_attendance is the per-player register
--      aggregate that never existed: due/marked/attended already counted, the
--      denominator carried (F-BH), and the four standings between "never due"
--      and "attending" as a word.
--
-- Deliberately NOT here:
--   . No change to app.session_roster's column list — appending columns would
--     leave 0022 unable to replay on a fresh database (CREATE OR REPLACE cannot
--     drop columns), and dropping the view cascades into session_detail. The
--     two readers that need ends_at/status join session themselves, on its pk.
--   . No change to session_cm_user_select — if check-roster-scale still
--     degrades with tenant size after the index, the admin branch of
--     app.my_session_ids() is the next suspect, and a policy edit carries its
--     own migration and its own check:rls-doc run.
--   . No index on session (academy_id, status, starts_at) — status in the
--     middle breaks the starts_at range, and session_academy_starts_idx
--     already serves the week reads. No new attendance index — the
--     unique (session_id, player_id) and attendance_player_idx cover both
--     directions this file reads it in.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 . indexes
-- -----------------------------------------------------------------------------

-- The roster fix. Full, not partial: the view's own predicate is
--   ended_on is null OR ended_on >= day
-- which no partial index can serve. class_id leads (the equality), then both
-- range bounds. enrollment_open_class_idx stays — app.my_session_ids()'s family
-- branch filters `ended_on is null` and genuinely wants the partial one.
create index if not exists enrollment_class_dates_idx
  on enrollment (class_id, started_on, ended_on);

-- unmarked_billable_session and coach_pay.worked both filter
--   status <> 'cancelled' and ends_at < app.now()
-- and neither column was indexed. `<>` cannot lead a btree, so PARTIAL is the
-- only shape that helps, and the views' WHERE contains the predicate literally,
-- which is what the planner needs to match it. app.now() is STABLE — a runtime
-- scan bound, never part of the index predicate (F-BI's rule, held by Postgres
-- itself: it refuses a non-IMMUTABLE predicate).
create index if not exists session_academy_ends_live_idx
  on session (academy_id, ends_at)
  where status <> 'cancelled';

-- account_standing's payment lateral runs three status-filtered aggregates per
-- account; payment_account_idx found the rows and then heap-fetched amount and
-- confirmed_at for every one. Covering makes the lateral index-only — on a
-- vacuumed table; the visibility map is what makes INCLUDE pay.
create index if not exists payment_account_status_idx
  on payment (account_id, status) include (amount, confirmed_at);

-- -----------------------------------------------------------------------------
-- 2 . app.rate_on says which branch it took
--
-- Return type changes, so the two dependent views come down first and are
-- rebuilt below — whole, as this chain's convention is. TWO source columns,
-- not one: 0043 resolves amount and unit with independent coalesces, so one
-- column would have to lie about the other. cnt is plumbing for
-- per_term/per_package and its provenance is not a sentence anybody says.
-- -----------------------------------------------------------------------------

drop view if exists public.unmarked_billable_session;
drop view if exists public.class_roster;
drop function if exists app.rate_on(uuid, date);

create function app.rate_on(p_enrollment_id uuid, p_on date)
  returns table (amount numeric, unit text, cnt int,
                 amount_source text, unit_source text)
  language sql stable set search_path = public, pg_temp
  as $$
    select coalesce(er.amount,     cr.amount),
           coalesce(er.unit,       cr.unit),
           coalesce(er.rate_count, cr.rate_count),
           case when er.amount is not null then 'enrolment'
                when cr.amount is not null then 'class'
                else                            'none' end,
           case when er.unit is not null then 'enrolment'
                when cr.unit is not null then 'class'
                else                           'none' end
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

comment on function app.rate_on(uuid, date) is
  'The rate an enrolment was on, on a given day: its own dated period, falling '
  'back to the class''s. amount_source and unit_source say which side each came '
  'from — enrolment | class | none — because the two fall back independently '
  'and a resolved value with no provenance is how a fallback goes unnoticed.';

-- -----------------------------------------------------------------------------
-- 3 . unmarked_billable_session — a null unit surfaces instead of vanishing
--
-- THE FIX is one clause and one word. `rt.unit = 'per_session'` silently took
-- the whole row out when the unit was NULL, so a register nobody could price
-- read as a register nobody had to mark. The null now stays in, `pricing` says
-- what happened, and `unbilled_amount` is a FILTERED sum so the unpriceable
-- part reads as NULL — never as 0, which is the exact sentence ("nothing owed")
-- the disappearance was telling. per_month/per_term/per_package rows still
-- fail the WHERE row-wise: their registers owe nothing and never belonged here.
-- -----------------------------------------------------------------------------

create view public.unmarked_billable_session with (security_invoker = true) as
  select r.academy_id,
         r.session_id,
         r.class_id,
         r.class_name,
         r.starts_at,
         count(*)::int                                        as unmarked_players,
         count(*) filter (where rt.unit is null)::int         as unpriced_players,
         sum(rt.amount) filter (where rt.unit = 'per_session')::numeric(10,2)
                                                              as unbilled_amount,
         case
           when count(*) filter (where rt.unit is null) = 0     then 'priced'
           when count(*) filter (where rt.unit is not null) = 0 then 'no rate on file'
           else                                                      'partly priced'
         end                                                  as pricing
    from app.session_roster r
    join session s  on s.id  = r.session_id
    join academy ac on ac.id = r.academy_id
    left join lateral app.rate_on(
      r.enrollment_id, (s.starts_at at time zone ac.timezone)::date) rt on true
   where r.attendance_status is null
     and not r.is_trial
     and (rt.unit = 'per_session' or rt.unit is null)
     and s.status <> 'cancelled'
     and s.ends_at < app.now()
   group by r.academy_id, r.session_id, r.class_id, r.class_name, r.starts_at;

comment on view public.unmarked_billable_session is
  'Finished, uncancelled sessions whose register could still owe money: on a '
  'per-session rate and unmarked, OR unmarked with no rate on file at all. NOT '
  '"this family owes money" — a per-month family owes the same either way. '
  'unbilled_amount is priced AT THE RATE THE SESSION RAN AT, not today''s '
  '(F-CJ), and is NULL — not 0 — for the players nobody can price; pricing is '
  'priced | no rate on file | partly priced, and unpriced_players counts them. '
  'A row with no rate is not billable YET — it is the owner''s number to state, '
  'not a zero. Inherits the reader through session_roster.';

grant select on public.unmarked_billable_session
  to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- 4 . class_roster — rate_source stops guessing
--
-- Rebuilt verbatim from 0043 with two edits. rate_source came off a hand-rolled
-- case that reported 'class' whenever the enrolment column was null — including
-- when there was no rate ANYWHERE, a fallback branch that did not exist. It now
-- comes from the function that took the branch, and can say 'none'. And the
-- as-of date is app.today(cl.academy_id), 0043's own complaint about the inline
-- timezone expression applied to the one view that still had it.
-- -----------------------------------------------------------------------------

create view public.class_roster with (security_invoker = true) as
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
         e.ended_on,
         case
           when not pl.active                                          then 'ended'
           when e.ended_on is not null
            and e.ended_on   < app.today(cl.academy_id)                then 'ended'
           when e.started_on > app.today(cl.academy_id)                then 'upcoming'
           else                                                             'current'
         end                                      as standing,
         pl.active                                as player_active,
         ro.amount_source                         as rate_source,
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
      select ron.amount_source
        from app.rate_on(e.id, app.today(cl.academy_id)) ron
    ) ro on true
    left join lateral (
      select min(rp.effective_from) as d
        from rate_period rp
       where rp.effective_from > app.today(cl.academy_id)
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
  'says whether the rate came off the enrolment, fell back to the class, or does not '
  'exist at all — enrolment | class | none — which is the difference between a member '
  'who was grandfathered, one who was not, and one whose price was never stated. '
  'rate_amount is what they pay NOW; next_rate_amount and next_rate_from are a change '
  'already on file, null when there is none — so "is it going up" is a column and not '
  'a calculation.';

-- -----------------------------------------------------------------------------
-- 5 . player_attendance — the register, already counted, one row per player
--
-- @mechanism player_attendance — the per-player register aggregate: due, marked,
--   attended and absent already counted over app.session_roster, the rate's
--   denominator carried beside its numerator, and the four standings between
--   'never due' and 'attending' as a word — so "who has never turned up" is a
--   filter rather than a NOT EXISTS the model writes as an inner join and gets
--   backwards. Closes F-EW
--
-- attendance_rate divides attended by MARKED, never by due: an unmarked
-- register is not an absence — that is unmarked_billable_session's whole
-- premise — so dividing by due would report a coach who stopped taking the
-- register as a family that stopped coming. Both counts are columns so the gap
-- between them is visible rather than assumed.
--
-- Deliberately NO windowed column (no attended_last_30d): a clock-relative
-- column bakes the day into the relation, which is what F-BI prohibits and what
-- got uncovered_session dropped in 0037. last_attended_at answers the question
-- actually behind the ask — "has she stopped coming" — without inventing a
-- period; for one window or one class, read app.session_roster with your own
-- dates.
-- -----------------------------------------------------------------------------

drop view if exists public.player_attendance;

create view public.player_attendance with (security_invoker = true) as
  select pl.academy_id,
         pl.id                as player_id,
         pe.full_name         as player_name,
         pl.account_id,
         pl.active            as player_active,
         a.classes,
         a.sessions_due,
         a.sessions_marked,
         a.sessions_attended,
         a.sessions_absent,
         case when a.sessions_marked = 0 then null
              else round(100.0 * a.sessions_attended / a.sessions_marked, 1)
         end::numeric(5,1)    as attendance_rate,
         a.first_due_at,
         a.last_due_at,
         a.last_attended_at,
         case
           when a.sessions_due      = 0 then 'never due'
           when a.sessions_marked   = 0 then 'never marked'
           when a.sessions_attended = 0 then 'never attended'
           else                              'attending'
         end                  as standing
    from player pl
    join person pe on pe.id = pl.person_id
    left join lateral (
      select coalesce(array_agg(distinct r.class_name), '{}'::text[])               as classes,
             count(*)::int                                                          as sessions_due,
             count(*) filter (where r.attendance_status is not null)::int           as sessions_marked,
             count(*) filter (where r.attendance_status in ('present','late'))::int as sessions_attended,
             count(*) filter (where r.attendance_status
                                    in ('absent','cancelled_timely'))::int          as sessions_absent,
             min(r.starts_at)                                                       as first_due_at,
             max(r.starts_at)                                                       as last_due_at,
             max(r.starts_at) filter (where r.attendance_status in ('present','late'))
                                                                                    as last_attended_at
        from app.session_roster r
        join session s on s.id = r.session_id
       where r.player_id = pl.id
         and s.status <> 'cancelled'
         and s.ends_at < app.now()
    ) a on true;

comment on view public.player_attendance is
  'One row per player, with the register already counted over every finished, '
  'uncancelled session they were due at, lifetime, across every class. standing '
  'is never due | never marked | never attended | attending — the four states '
  'an anti-join reaches for, as a word. attendance_rate is attended over '
  'MARKED, never over due: an unmarked register is not an absence, and '
  'sessions_due beside sessions_marked is where that gap shows. For one window '
  'or one class, read app.session_roster with your own dates. Inherits the '
  'reader.';

grant select on public.player_attendance to cm_service, cm_user, cm_readonly;

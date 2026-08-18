-- =============================================================================
-- 0035 — the register that owes money, as a view
--
-- Coverage is the most important derived value in the product and it has two
-- views and a helper function. "Which finished sessions have money waiting
-- behind an unmarked register" is the same kind of value — derived, never
-- stored, asked often — and it had nothing. Every turn that needed it rebuilt it
-- from rate_unit x attendance x tally_line, and derived-under-pressure is where
-- it went wrong: driven, the product told an owner a class was "sitting unbilled"
-- when it was a per-MONTH class that had already been billed on the 1st, and
-- three days later told him correctly that nothing was unbilled over the same
-- three registers. Neither turn was wrong about anything else, and the prefix
-- states the billing rule plainly in both directions — so this is not something
-- another sentence upstream would have fixed.
--
-- NAMED FOR THE PREDICATE, deliberately.
--
-- PREFIX.md's census-label trap: read the name with no access to the SQL and say
-- the sentence it licenses. `unbilled_session` licenses "this family owes money",
-- which is false — a per-month family owes exactly the same whether or not the
-- register was marked. What is true is narrower and is what the name says: the
-- session is over, the register is unmarked, and the rate is per-session, so the
-- money has not been written yet and will not be until somebody marks it. That is
-- how `uncovered_sessions_next_36h` told an owner four times that his only coach
-- was unassigned, and the fix was the label rather than the predicate.
--
-- Built ON app.session_roster rather than beside it. SCHEMA_DOC says of that view
-- "use this, do not rebuild it", and the date predicate it owns — an enrolment
-- live on the session's own day, in the academy's timezone — is exactly the part
-- a second copy would get subtly wrong.
-- =============================================================================

drop view if exists public.unmarked_billable_session;

create view public.unmarked_billable_session with (security_invoker = true) as
  select r.academy_id,
         r.session_id,
         r.class_id,
         r.class_name,
         r.starts_at,
         count(*)::int                                              as unmarked_players,
         sum(coalesce(e.rate_amount, cl.rate_amount))::numeric(10,2) as unbilled_amount
    from app.session_roster r
    join enrollment e on e.id = r.enrollment_id
    join class      cl on cl.id = r.class_id
    join session    s  on s.id  = r.session_id
   where r.attendance_status is null
     -- A trial is free until somebody converts it on purpose, so an unmarked
     -- trial register is a coaching record with no money behind it.
     and not r.is_trial
     -- The whole point. per_month, per_term and per_package bill on the 1st (or
     -- on the pack) whatever the register says, so an unmarked register on those
     -- owes nothing and belongs nowhere near a sentence about money.
     and coalesce(e.rate_unit, cl.rate_unit) = 'per_session'
     -- Over, and it happened. A cancelled session has no attendance to take, and
     -- one that has not finished yet is not late.
     and s.status <> 'cancelled'
     and s.ends_at < app.now()
   group by r.academy_id, r.session_id, r.class_id, r.class_name, r.starts_at;

comment on view public.unmarked_billable_session is
  'Finished, uncancelled sessions on a per-session rate whose register is still unmarked, '
  'so no tally line exists for them yet. NOT "this family owes money" — a per-month family '
  'owes the same either way. Inherits the reader through session_roster.';

grant select on public.unmarked_billable_session
  to cm_service, cm_user, cm_readonly;

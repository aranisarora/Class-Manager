-- Who is on a session's register, as one row per player.
--
-- "Who was at this class" is the question the product exists to answer, and the
-- model had to compose it from four tables every time: enrollment joined to
-- player joined to person, narrowed by a date range against the session's own
-- start, in the academy's timezone. It got it wrong in both probe runs, the same
-- way each time — `e.active`, which is a column on `player` and not on
-- `enrollment`:
--
--   run 1, churn/client-leaves       → {"rows":[],"error":"column e.active does not exist"}
--   run 2, attendance/coach-marks-register → same, then two statement timeouts,
--                                      then it gave up and sent a link, and the
--                                      register was never marked at all
--
-- The schema doc already says `player(… active bool)` and lists `enrollment`
-- without it. So this is not an information problem and another line of prompt
-- will not fix it — the two tables sit next to each other and one of them has
-- the column. R3's answer is to stop asking the model a question the database
-- can answer: the join is always the same join, so it is written once, here.
--
-- `security_invoker = true` so the view is not a hole in §6.7: it is evaluated
-- with the caller's permissions, and every underlying policy — a coach seeing
-- only their own sessions' rosters, a parent seeing only their own children —
-- applies exactly as it does today. A view that bypassed RLS would be a far
-- worse bug than the one it fixes.
--
-- The date predicate is `enrolledPlayers` in lib/jobs/util.ts, verbatim, because
-- two definitions of "on the register" is how the register and the bill come to
-- disagree. If that helper changes, this changes with it.

create or replace view app.session_roster
with (security_invoker = true) as
select
  s.academy_id,
  s.id                as session_id,
  s.class_id,
  s.starts_at,
  cl.name             as class_name,
  e.id                as enrollment_id,
  e.is_trial,
  p.id                as player_id,
  pp.full_name        as player_name,
  p.account_id,
  at.status           as attendance_status,
  at.marked_at
from session s
join class cl on cl.id = s.class_id
join academy ac on ac.id = s.academy_id
join enrollment e
  on e.class_id = s.class_id
 and e.academy_id = s.academy_id
 and e.started_on <= (s.starts_at at time zone ac.timezone)::date
 and (e.ended_on is null or e.ended_on >= (s.starts_at at time zone ac.timezone)::date)
join player p on p.id = e.player_id and p.active
join person pp on pp.id = p.person_id
left join attendance at on at.session_id = s.id and at.player_id = p.id;

comment on view app.session_roster is
  'One row per player on a session''s register, with their attendance if it has '
  'been marked. The join is the same every time and the model kept guessing it '
  'wrong (e.active is on player, not enrollment), so it is written once here. '
  'security_invoker: a coach sees only their own sessions, a parent only their '
  'own children — the underlying policies do the work.';

grant select on app.session_roster to cm_service, cm_user, cm_readonly;

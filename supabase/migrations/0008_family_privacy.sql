-- 0008_family_privacy.sql
--
-- §6.7, the account-holder row: "Own account, its players, enrollments, attendance,
-- tally lines, payments. Sessions their players are in. **Never** another family."
--
-- The original SELECT policies on `player`, `person`, `enrollment` and `attendance`
-- granted anyone with a session in `app.my_session_ids()` the whole roster of that
-- session's class. For a coach that is exactly right — §6.7 gives them "sessions they
-- are assigned to, and those rosters and attendance". For a parent it is not: it turns
-- "sessions their players are in" into "every family who shares a class with mine".
--
-- In a three-class academy that is the entire client list, and it was reachable through
-- the model, which will happily name a classmate when a query returns one. An agent
-- simulation caught it — a parent was told another child's name in a message about a
-- cancelled session.
--
-- The fix is one clause: the roster branch is gated on the viewer actually being a
-- coach. Staff stay visible to everyone (a parent is told who is coaching their child's
-- class, and `coach_public` already withholds pay), because a coach is not another
-- family.

-- ── player ───────────────────────────────────────────────────────────────────
drop policy if exists player_cm_user_select on player;
create policy player_cm_user_select on player
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (
      app.is_admin()
      or id = any (app.my_player_ids())
      -- Roster: coaches only (§6.7 coach row).
      or (
        app.my_coach_id() is not null
        and exists (
          select 1 from enrollment en
            join session se on se.class_id = en.class_id
           where en.player_id = player.id
             and en.ended_on is null
             and se.id = any (app.my_session_ids())
        )
      )
    )
  );

-- ── person ───────────────────────────────────────────────────────────────────
drop policy if exists person_cm_user_select on person;
create policy person_cm_user_select on person
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (
      app.is_admin()
      -- Yourself.
      or id = app.person_id()
      -- Your own players, and the holder of your own account.
      or exists (select 1 from player pl
                  where pl.person_id = person.id and pl.id = any (app.my_player_ids()))
      or exists (select 1 from account ac
                  where ac.id = any (app.my_account_ids()) and ac.holder_person_id = person.id)
      -- The roster of a session you coach — coaches only.
      or (
        app.my_coach_id() is not null
        and exists (
          select 1 from player pl
            join enrollment en on en.player_id = pl.id and en.ended_on is null
            join session se on se.class_id = en.class_id
           where pl.person_id = person.id
             and se.id = any (app.my_session_ids())
        )
      )
      -- Staff on your sessions stay visible to everyone: a parent is told who is
      -- coaching their child's class, and `coach_public` withholds pay. A coach is
      -- not another family.
      or exists (
        select 1 from coach_public cp
          join session_coach sc on sc.coach_id = cp.id
         where cp.person_id = person.id
           and sc.session_id = any (app.my_session_ids())
      )
    )
  );

-- ── enrollment ───────────────────────────────────────────────────────────────
drop policy if exists enrollment_cm_user_select on enrollment;
create policy enrollment_cm_user_select on enrollment
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (
      app.is_admin()
      or player_id = any (app.my_player_ids())
      or (
        app.my_coach_id() is not null
        and exists (
          select 1 from session se
           where se.class_id = enrollment.class_id
             and se.id = any (app.my_session_ids())
        )
      )
    )
  );

-- ── attendance ───────────────────────────────────────────────────────────────
drop policy if exists attendance_cm_user_select on attendance;
create policy attendance_cm_user_select on attendance
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (
      app.is_admin()
      or player_id = any (app.my_player_ids())
      or (app.my_coach_id() is not null and session_id = any (app.my_session_ids()))
    )
  );

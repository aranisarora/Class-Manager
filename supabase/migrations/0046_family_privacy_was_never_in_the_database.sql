-- 0046 — family privacy was never in the database
--
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- `0008_family_privacy.sql` narrowed four SELECT policies so that the classmate
-- disjunct — "you may see a player who shares a session with one of yours" —
-- applies only to a COACH. Its own comment says so: "Roster: coaches only
-- (6.7 coach row)." `0028_rls_once_per_statement.sql` restated all four in the
-- `(select app.x())` form so the helpers evaluate once per statement instead of
-- once per row.
--
-- Neither reached the database. Checked 22 Aug 2026 against
-- aws-0-ap-south-1.pooler.supabase.com: `player_cm_user_select` was a
-- byte-for-byte match for the version in `0003_rls.sql`, the guard
-- `app.my_coach_id() is not null` appeared in ZERO policies, and all 55 policies
-- used 0003's `app.is_admin()` form while none used 0028's. Both migrations were
-- absent, not partially applied.
--
-- WHAT IT COST
-- ---------------------------------------------------------------------------
-- Every parent's session could read every other family's `player`, `person`,
-- `enrollment` and `attendance` rows for any class their own child sits in. On
-- the thirty-day drive `2026-08-22-08-13-sim-7bo8` that is the first of the two
-- open doors behind turns 160 and 168: Rukmini Sarangi was told, on her first
-- contact, that Devendra Ahluwalia's son Kabir was hers, given his schedule, and
-- then his fee. The census query that composed the sentence had no account
-- predicate (fixed separately, `lib/agent/context.ts`) — but a missing predicate
-- is supposed to be HARMLESS, because RLS is the boundary underneath it. It was
-- not there. The model ran the correctly scoped query three times, got the right
-- answer every time, doubted the census in writing, and was overruled.
--
-- No real customer data was exposed: every academy in this database on that date
-- was a sim or probe artefact on a test number. This is a latent gap closed
-- before the first real business, not an incident.
--
-- WHY A NEW MIGRATION RATHER THAN RE-RUNNING 0008/0028
-- ---------------------------------------------------------------------------
-- There is no migration tracking table in this project, so nothing records what
-- has been applied and `npm run db:push` is not re-runnable (it dies partway —
-- see CLAUDE.md's trap list). Re-running the originals is not a thing that can be
-- asked for. A forward-only migration that states the intended end state, and can
-- be applied on its own, is. It is written to be idempotent: every statement is a
-- `drop policy if exists` followed by a `create policy`, so applying it twice is
-- the same as applying it once.
--
-- The four bodies below are 0028's, verbatim. This migration adds nothing new —
-- its whole content is that the database should say what the repo has said since
-- 0008.

-- ---------------------------------------------------------------------------
-- player (0008) — a classmate's row is visible to the COACH of that session and
-- to nobody else. A parent sees their own children.
-- ---------------------------------------------------------------------------
drop policy if exists player_cm_user_select on player;
create policy player_cm_user_select on player
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and (
      (select app.is_admin())
      or id in (select unnest(app.my_player_ids()))
      -- Roster: coaches only (6.7 coach row).
      or (
        (select app.my_coach_id()) is not null
        and exists (
          select 1 from enrollment en
            join session se on se.class_id = en.class_id
           where en.player_id = player.id
             and en.ended_on is null
             and se.id in (select unnest(app.my_session_ids()))
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- person (0008) — yourself, your own players, your own account holder, the
-- roster of a session you COACH, and the staff on your own sessions.
--
-- The staff clause is deliberately not coach-gated: a parent is told who coaches
-- their child's class, and `coach_public` is the view that withholds pay. A coach
-- is not another family.
-- ---------------------------------------------------------------------------
drop policy if exists person_cm_user_select on person;
create policy person_cm_user_select on person
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and (
      (select app.is_admin())
      -- Yourself.
      or id = (select app.person_id())
      -- Your own players, and the holder of your own account.
      or exists (select 1 from player pl
                  where pl.person_id = person.id and pl.id in (select unnest(app.my_player_ids())))
      or exists (select 1 from account ac
                  where ac.id in (select unnest(app.my_account_ids())) and ac.holder_person_id = person.id)
      -- The roster of a session you coach — coaches only.
      or (
        (select app.my_coach_id()) is not null
        and exists (
          select 1 from player pl
            join enrollment en on en.player_id = pl.id and en.ended_on is null
            join session se on se.class_id = en.class_id
           where pl.person_id = person.id
             and se.id in (select unnest(app.my_session_ids()))
        )
      )
      -- Staff on your sessions stay visible to everyone.
      or exists (
        select 1 from coach_public cp
          join session_coach sc on sc.coach_id = cp.id
         where cp.person_id = person.id
           and sc.session_id in (select unnest(app.my_session_ids()))
      )
    )
  );

-- ---------------------------------------------------------------------------
-- enrollment (0008) — your own players' enrolments; a coach sees the enrolments
-- of the classes they are actually on.
-- ---------------------------------------------------------------------------
drop policy if exists enrollment_cm_user_select on enrollment;
create policy enrollment_cm_user_select on enrollment
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and (
      (select app.is_admin())
      or player_id in (select unnest(app.my_player_ids()))
      or (
        (select app.my_coach_id()) is not null
        and exists (
          select 1 from session se
           where se.class_id = enrollment.class_id
             and se.id in (select unnest(app.my_session_ids()))
        )
      )
    )
  );

-- ---------------------------------------------------------------------------
-- attendance (0008) — your own players' attendance; a coach sees the register of
-- a session they are on. Whether another child turned up is that family's.
-- ---------------------------------------------------------------------------
drop policy if exists attendance_cm_user_select on attendance;
create policy attendance_cm_user_select on attendance
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and (
      (select app.is_admin())
      or player_id in (select unnest(app.my_player_ids()))
      or ((select app.my_coach_id()) is not null and session_id in (select unnest(app.my_session_ids())))
    )
  );

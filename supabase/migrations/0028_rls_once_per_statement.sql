-- =============================================================================
-- 0028_rls_once_per_statement.sql — the coach stops paying six admins' worth of
-- permission checks for one roster read.
--
-- Measured on the arc drive (16 Aug 2026), the identical session_roster lookup
-- as three different people: coach 2946ms · admin 461ms · parent 605ms — and the
-- session table alone reads in 43ms for everybody. Last run the same lookup
-- crossed the 5s statement timeout three times and a register was never marked.
--
-- Two causes, both here:
--
--   1. `app.my_session_ids()` scanned EVERY session in the academy and ran a
--      correlated EXISTS per session — each one calling `app.my_coach_id()`,
--      itself a security-definer query. The admin short-circuits on one EXISTS
--      and the parent on a small aggregate; only the coach walked the whole
--      table probing per row. Rewritten to drive from the indexes that already
--      exist (session_coach's PK, enrollment_open_class_idx), with the identity
--      helpers hoisted into a CTE so each is evaluated once per call.
--
--   2. A bare stable function in a policy expression is re-evaluated per
--      candidate row — `id = any (app.my_session_ids())` rebuilt the whole
--      array for every row the query touched, and the roster view joins five
--      policy-guarded tables, so the cost multiplied. Every helper call in a
--      SELECT policy is wrapped in a scalar subselect — `(select app.f())` —
--      which the planner hoists into an InitPlan and evaluates once per
--      statement. No predicate changes; only when it is computed.
--
-- SELECT policies only: writes touch few rows and are not on the measured path.
-- Policy text is restated from its CURRENT source — 0008 for player / person /
-- enrollment / attendance (family privacy), 0003 for the rest — with wraps as
-- the only edit. Re-runnable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. my_session_ids — index-driven, identity read once.
-- -----------------------------------------------------------------------------
create or replace function app.my_session_ids() returns uuid[]
  language sql stable security definer set search_path = public, pg_temp
  as $$
    with me as (
      select app.academy_id()    as aid,
             app.is_admin()      as adm,
             app.my_coach_id()   as cid,
             app.my_player_ids() as pids
    )
    select coalesce(array_agg(distinct u.sid), '{}'::uuid[])
    from (
      -- admin: every session in the academy
      select s.id as sid
        from session s, me
       where me.adm and s.academy_id = me.aid
      union all
      -- coach: driven off session_coach's (session_id, coach_id) PK
      select sc.session_id as sid
        from session_coach sc, me
       where sc.academy_id = me.aid and sc.coach_id = me.cid
      union all
      -- family: sessions of classes any of their players is actively enrolled in
      select s.id as sid
        from session s
        join enrollment e on e.class_id = s.class_id and e.ended_on is null, me
       where s.academy_id = me.aid and e.player_id = any (me.pids)
    ) u
  $$;

-- -----------------------------------------------------------------------------
-- 2. SELECT policies, helpers evaluated once per statement.
-- -----------------------------------------------------------------------------

-- academy (0003)
drop policy if exists academy_cm_user_select on academy;
create policy academy_cm_user_select on academy
  for select to cm_user, cm_readonly
  using (id = (select app.academy_id()));

-- venue / class / class_slot (0003)
drop policy if exists venue_cm_user_select on venue;
create policy venue_cm_user_select on venue
  for select to cm_user, cm_readonly
  using (academy_id = (select app.academy_id()));

drop policy if exists class_cm_user_select on class;
create policy class_cm_user_select on class
  for select to cm_user, cm_readonly
  using (academy_id = (select app.academy_id()));

drop policy if exists class_slot_cm_user_select on class_slot;
create policy class_slot_cm_user_select on class_slot
  for select to cm_user, cm_readonly
  using (academy_id = (select app.academy_id()));

-- person (0008 — family privacy text)
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
      -- Staff on your sessions stay visible to everyone: a parent is told who is
      -- coaching their child's class, and `coach_public` withholds pay. A coach is
      -- not another family.
      or exists (
        select 1 from coach_public cp
          join session_coach sc on sc.coach_id = cp.id
         where cp.person_id = person.id
           and sc.session_id in (select unnest(app.my_session_ids()))
      )
    )
  );

-- contact (0003)
drop policy if exists contact_cm_user_select on contact;
create policy contact_cm_user_select on contact
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and (
      (select app.is_admin())
      or id = (select app.contact_id())
      or person_id = (select app.person_id())
      or exists (select 1 from player pl
                 where pl.person_id = contact.person_id
                   and pl.id in (select unnest(app.my_player_ids())))
      or exists (select 1 from account ac
                 where ac.id in (select unnest(app.my_account_ids()))
                   and ac.holder_person_id = contact.person_id)
    )
  );

-- account (0003)
drop policy if exists account_cm_user_select on account;
create policy account_cm_user_select on account
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and (
      (select app.is_admin())
      or id in (select unnest(app.my_account_ids()))
      or exists (select 1 from player pl
                 where pl.account_id = account.id
                   and pl.id in (select unnest(app.my_player_ids())))
    )
  );

-- player (0008)
drop policy if exists player_cm_user_select on player;
create policy player_cm_user_select on player
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and (
      (select app.is_admin())
      or id in (select unnest(app.my_player_ids()))
      -- Roster: coaches only (§6.7 coach row).
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

-- coach (0003)
drop policy if exists coach_cm_user_select on coach;
create policy coach_cm_user_select on coach
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and ((select app.is_admin()) or id = (select app.my_coach_id()))
  );

-- academy_admin (0003)
drop policy if exists academy_admin_cm_user_select on academy_admin;
create policy academy_admin_cm_user_select on academy_admin
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and ((select app.is_admin()) or person_id = (select app.person_id()))
  );

-- memory_fact (0003)
drop policy if exists memory_fact_cm_user_select on memory_fact;
create policy memory_fact_cm_user_select on memory_fact
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and ((select app.is_admin())
         or (subject_kind = 'person' and subject_id = (select app.person_id())))
  );

-- class_coach (0003)
drop policy if exists class_coach_cm_user_select on class_coach;
create policy class_coach_cm_user_select on class_coach
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and ((select app.is_admin()) or coach_id = (select app.my_coach_id()))
  );

-- enrollment (0008)
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

-- session (0003)
drop policy if exists session_cm_user_select on session;
create policy session_cm_user_select on session
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and ((select app.is_admin()) or id in (select unnest(app.my_session_ids())))
  );

-- session_coach (0003)
drop policy if exists session_coach_cm_user_select on session_coach;
create policy session_coach_cm_user_select on session_coach
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and ((select app.is_admin())
         or coach_id = (select app.my_coach_id())
         or session_id in (select unnest(app.my_session_ids())))
  );

-- attendance (0008)
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

-- tally_line / payment (0003)
drop policy if exists tally_line_cm_user_select on tally_line;
create policy tally_line_cm_user_select on tally_line
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and (select app.sees_money())
    and ((select app.is_admin()) or account_id in (select unnest(app.my_account_ids())))
  );

drop policy if exists payment_cm_user_select on payment;
create policy payment_cm_user_select on payment
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and (select app.sees_money())
    and ((select app.is_admin()) or account_id in (select unnest(app.my_account_ids())))
  );

-- action (0003)
drop policy if exists action_cm_user_select on action;
create policy action_cm_user_select on action
  for select to cm_user, cm_readonly
  using (academy_id = (select app.academy_id())
         and minted_for_contact_id = (select app.contact_id()));

-- message (0003)
drop policy if exists message_cm_user_select on message;
create policy message_cm_user_select on message
  for select to cm_user, cm_readonly
  using (academy_id = (select app.academy_id())
         and ((select app.is_admin()) or contact_id = (select app.contact_id())));

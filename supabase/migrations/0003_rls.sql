-- =============================================================================
-- 0003_rls.sql — policies. Spec §6.7, implemented table by table.
--
--   | Role            | Sees                                                    |
--   | Admin           | Everything within their academy_id                      |
--   | Coach           | Own coach row incl. own pay. Sessions they are assigned  |
--   |                 | to, those rosters and attendance. NEVER another coach's  |
--   |                 | pay, never the academy's money                          |
--   | Account holder  | Own account, its players, enrollments, attendance, tally |
--   |                 | lines, payments. Sessions their players are in.          |
--   |                 | NEVER another family                                     |
--   | Player's number | As their account holder, minus every tally_line and      |
--   |                 | payment — money-shaped rows never route to a player      |
--
-- sender, job, memory_fact, turn, audit_entry, recipe and sim_* are
-- infrastructure: reached by the runtime's own role, never through a user
-- session. They get cm_service policies and no cm_user policies at all, so
-- RLS-with-no-policy denies cm_user/cm_readonly everything. The one exception
-- is memory_fact SELECT, so "what do you know about me?" works.
--
-- Convention: every policy is `drop policy if exists` then `create policy`,
-- named <table>_<role>_<cmd>. SELECT policies are addressed to cm_user AND
-- cm_readonly (identical visibility, §14.2) and carry the cm_user name;
-- INSERT/UPDATE/DELETE policies are cm_user only.
--
-- Re-runnable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- coach_public — the column-restricted path to co-coaches.
--
-- Spec §8.1: pay is "private from OTHER coaches, not from themselves."
-- Postgres RLS is row-level, so there is no way to show a coach the row of a
-- co-coach while hiding pay_amount on it. The resolution: the `coach` policy
-- for non-admins is `id = app.my_coach_id()` and nothing else, and co-coach
-- lookups (cover offers, "who else is on this session") go through this view,
-- which simply has no pay columns to leak. security_invoker = false so the view
-- runs as its owner and is not re-filtered by coach's own policy; it is scoped
-- internally to app.academy_id() so it cannot cross a tenant either.
--
-- Created before the policies below because person_cm_user_select references it.
-- -----------------------------------------------------------------------------
-- `create or replace`, not drop-then-create: person_cm_user_select below takes
-- a dependency on this view, and a re-run must not have to tear that down.
create or replace view public.coach_public with (security_invoker = false) as
  select c.id, c.person_id, c.status, c.ended_on
  from coach c
  where c.academy_id = app.academy_id();

comment on view public.coach_public is
  'Co-coach lookups without pay (spec §8.1, §6.7). The coach table itself is '
  'own-row-only for non-admins.';

grant select on public.coach_public to cm_user, cm_readonly, cm_service;

-- =============================================================================
-- cm_service — the runtime's own role.
--
-- Global infrastructure: unrestricted.
-- Every tenant table: still pinned to app.academy_id, which the runtime always
-- sets before acting. A service action cannot cross tenants either.
--
-- NOTE: the academy row itself is created by the platform connecting as
-- `postgres` (the table owner, which RLS does not force), not by cm_service —
-- an insert whose own id is not yet the GUC could not satisfy the check.
-- =============================================================================

drop policy if exists sender_cm_service_all on sender;
create policy sender_cm_service_all on sender
  for all to cm_service using (true) with check (true);

drop policy if exists job_cm_service_all on job;
create policy job_cm_service_all on job
  for all to cm_service using (true) with check (true);

drop policy if exists recipe_cm_service_all on recipe;
create policy recipe_cm_service_all on recipe
  for all to cm_service using (true) with check (true);

drop policy if exists sim_clock_cm_service_all on sim_clock;
create policy sim_clock_cm_service_all on sim_clock
  for all to cm_service using (true) with check (true);

drop policy if exists sim_fault_cm_service_all on sim_fault;
create policy sim_fault_cm_service_all on sim_fault
  for all to cm_service using (true) with check (true);

drop policy if exists academy_cm_service_all on academy;
create policy academy_cm_service_all on academy
  for all to cm_service
  using (id = app.academy_id()) with check (id = app.academy_id());

drop policy if exists venue_cm_service_all on venue;
create policy venue_cm_service_all on venue
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists person_cm_service_all on person;
create policy person_cm_service_all on person
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists contact_cm_service_all on contact;
create policy contact_cm_service_all on contact
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists account_cm_service_all on account;
create policy account_cm_service_all on account
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists player_cm_service_all on player;
create policy player_cm_service_all on player
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists coach_cm_service_all on coach;
create policy coach_cm_service_all on coach
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists academy_admin_cm_service_all on academy_admin;
create policy academy_admin_cm_service_all on academy_admin
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists memory_fact_cm_service_all on memory_fact;
create policy memory_fact_cm_service_all on memory_fact
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists class_cm_service_all on class;
create policy class_cm_service_all on class
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists class_slot_cm_service_all on class_slot;
create policy class_slot_cm_service_all on class_slot
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists class_coach_cm_service_all on class_coach;
create policy class_coach_cm_service_all on class_coach
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists enrollment_cm_service_all on enrollment;
create policy enrollment_cm_service_all on enrollment
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists session_cm_service_all on session;
create policy session_cm_service_all on session
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists session_coach_cm_service_all on session_coach;
create policy session_coach_cm_service_all on session_coach
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists attendance_cm_service_all on attendance;
create policy attendance_cm_service_all on attendance
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists tally_line_cm_service_all on tally_line;
create policy tally_line_cm_service_all on tally_line
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists payment_cm_service_all on payment;
create policy payment_cm_service_all on payment
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists action_cm_service_all on action;
create policy action_cm_service_all on action
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists message_cm_service_all on message;
create policy message_cm_service_all on message
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists audit_entry_cm_service_all on audit_entry;
create policy audit_entry_cm_service_all on audit_entry
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists turn_cm_service_all on turn;
create policy turn_cm_service_all on turn
  for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

-- =============================================================================
-- cm_user / cm_readonly — the §6.7 table.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- academy — read for everyone in it (timezone, name, windows all shape copy).
-- Written by the admin only. No INSERT policy: you cannot be the admin of an
-- academy that does not exist yet, so tenant creation is a platform operation.
-- No DELETE policy: destroying a tenant is not a chat action.
-- -----------------------------------------------------------------------------
drop policy if exists academy_cm_user_select on academy;
create policy academy_cm_user_select on academy
  for select to cm_user, cm_readonly
  using (id = app.academy_id());

drop policy if exists academy_cm_user_update on academy;
create policy academy_cm_user_update on academy
  for update to cm_user
  using (id = app.academy_id() and app.is_admin())
  with check (id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- venue / class / class_slot — the catalog. §6.7: coach and account holder both
-- get these as READ. Not family data and not money data: a parent asking "is
-- there anything on Saturday" (§10.1 step 3) is answered from here.
-- Writes are the admin's (§7.2).
-- -----------------------------------------------------------------------------
drop policy if exists venue_cm_user_select on venue;
create policy venue_cm_user_select on venue
  for select to cm_user, cm_readonly
  using (academy_id = app.academy_id());

drop policy if exists venue_cm_user_insert on venue;
create policy venue_cm_user_insert on venue
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists venue_cm_user_update on venue;
create policy venue_cm_user_update on venue
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists venue_cm_user_delete on venue;
create policy venue_cm_user_delete on venue
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

drop policy if exists class_cm_user_select on class;
create policy class_cm_user_select on class
  for select to cm_user, cm_readonly
  using (academy_id = app.academy_id());

drop policy if exists class_cm_user_insert on class;
create policy class_cm_user_insert on class
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists class_cm_user_update on class;
create policy class_cm_user_update on class
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists class_cm_user_delete on class;
create policy class_cm_user_delete on class
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

drop policy if exists class_slot_cm_user_select on class_slot;
create policy class_slot_cm_user_select on class_slot
  for select to cm_user, cm_readonly
  using (academy_id = app.academy_id());

drop policy if exists class_slot_cm_user_insert on class_slot;
create policy class_slot_cm_user_insert on class_slot
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists class_slot_cm_user_update on class_slot;
create policy class_slot_cm_user_update on class_slot
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists class_slot_cm_user_delete on class_slot;
create policy class_slot_cm_user_delete on class_slot
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- person — §6.7: own row always; admin all; coach the persons on their rosters
-- (and the co-coaches on their sessions, via coach_public); account holder
-- their own family. Phone numbers are a separate question — see `contact`.
-- -----------------------------------------------------------------------------
drop policy if exists person_cm_user_select on person;
create policy person_cm_user_select on person
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (
      app.is_admin()
      or id = app.person_id()
      -- own family: the persons behind my players
      or exists (select 1 from player pl
                 where pl.person_id = person.id
                   and pl.id = any (app.my_player_ids()))
      -- own family: the holder of an account I hold
      or exists (select 1 from account ac
                 where ac.id = any (app.my_account_ids())
                   and ac.holder_person_id = person.id)
      -- coach: the roster of a session I am on
      or exists (select 1 from player pl
                   join enrollment en on en.player_id = pl.id and en.ended_on is null
                   join session se on se.class_id = en.class_id
                 where pl.person_id = person.id
                   and se.id = any (app.my_session_ids()))
      -- coach: a co-coach on a session I am on (§8.2 cover offers)
      or exists (select 1 from public.coach_public cp
                   join session_coach sc on sc.coach_id = cp.id
                 where cp.person_id = person.id
                   and sc.session_id = any (app.my_session_ids()))
    )
  );

drop policy if exists person_cm_user_insert on person;
create policy person_cm_user_insert on person
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

-- Admin edits anyone; anyone edits themselves (notes, settings — the per-person
-- timing overrides of §8.2 live in person.settings).
drop policy if exists person_cm_user_update on person;
create policy person_cm_user_update on person
  for update to cm_user
  using (academy_id = app.academy_id() and (app.is_admin() or id = app.person_id()))
  with check (academy_id = app.academy_id() and (app.is_admin() or id = app.person_id()));

drop policy if exists person_cm_user_delete on person;
create policy person_cm_user_delete on person
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- contact — a phone number, so deliberately tighter than `person`. Own numbers
-- and own family's numbers; admin sees all. A coach seeing a roster player's
-- NAME (person) does not entitle them to that family's NUMBER, and §16.3's
-- fragmentation cost is the reason the coach's own chat is not the channel.
-- -----------------------------------------------------------------------------
drop policy if exists contact_cm_user_select on contact;
create policy contact_cm_user_select on contact
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (
      app.is_admin()
      or id = app.contact_id()
      or person_id = app.person_id()
      or exists (select 1 from player pl
                 where pl.person_id = contact.person_id
                   and pl.id = any (app.my_player_ids()))
      or exists (select 1 from account ac
                 where ac.id = any (app.my_account_ids())
                   and ac.holder_person_id = contact.person_id)
    )
  );

drop policy if exists contact_cm_user_insert on contact;
create policy contact_cm_user_insert on contact
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

-- Own numbers are self-editable: §16.3's opt-out is confirmed by the person
-- whose number it is.
drop policy if exists contact_cm_user_update on contact;
create policy contact_cm_user_update on contact
  for update to cm_user
  using (academy_id = app.academy_id()
         and (app.is_admin() or person_id = app.person_id()))
  with check (academy_id = app.academy_id()
              and (app.is_admin() or person_id = app.person_id()));

drop policy if exists contact_cm_user_delete on contact;
create policy contact_cm_user_delete on contact
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- account — own account (as holder, or as one of its players). Never another
-- family. No money columns live here; tally_line and payment carry the money
-- gate.
-- -----------------------------------------------------------------------------
drop policy if exists account_cm_user_select on account;
create policy account_cm_user_select on account
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (
      app.is_admin()
      or id = any (app.my_account_ids())
      or exists (select 1 from player pl
                 where pl.account_id = account.id
                   and pl.id = any (app.my_player_ids()))
    )
  );

drop policy if exists account_cm_user_insert on account;
create policy account_cm_user_insert on account
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists account_cm_user_update on account;
create policy account_cm_user_update on account
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists account_cm_user_delete on account;
create policy account_cm_user_delete on account
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- player — own players, plus the rosters of sessions I coach (§6.7 row 2).
-- -----------------------------------------------------------------------------
drop policy if exists player_cm_user_select on player;
create policy player_cm_user_select on player
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (
      app.is_admin()
      or id = any (app.my_player_ids())
      or exists (select 1 from enrollment en
                   join session se on se.class_id = en.class_id
                 where en.player_id = player.id
                   and en.ended_on is null
                   and se.id = any (app.my_session_ids()))
    )
  );

drop policy if exists player_cm_user_insert on player;
create policy player_cm_user_insert on player
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists player_cm_user_update on player;
create policy player_cm_user_update on player
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists player_cm_user_delete on player;
create policy player_cm_user_delete on player
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- coach — §6.7 / §8.1. Own row INCLUDING own pay_amount; nothing else.
-- Postgres RLS cannot hide a column on a visible row, so "never another coach's
-- pay" is implemented by making other coaches' rows invisible here entirely and
-- routing co-coach lookups through public.coach_public (top of this file).
-- -----------------------------------------------------------------------------
drop policy if exists coach_cm_user_select on coach;
create policy coach_cm_user_select on coach
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (app.is_admin() or id = app.my_coach_id())
  );

drop policy if exists coach_cm_user_insert on coach;
create policy coach_cm_user_insert on coach
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

-- Pay is set by the admin (§8.1). A coach cannot write their own rate.
drop policy if exists coach_cm_user_update on coach;
create policy coach_cm_user_update on coach
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

-- §8.3: leaving is an end date, never a delete. Delete stays admin-only and is
-- expected to go unused.
drop policy if exists coach_cm_user_delete on coach;
create policy coach_cm_user_delete on coach
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- academy_admin — own row (so a person can tell they hold the hat), admin all.
-- -----------------------------------------------------------------------------
drop policy if exists academy_admin_cm_user_select on academy_admin;
create policy academy_admin_cm_user_select on academy_admin
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (app.is_admin() or person_id = app.person_id())
  );

drop policy if exists academy_admin_cm_user_insert on academy_admin;
create policy academy_admin_cm_user_insert on academy_admin
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists academy_admin_cm_user_delete on academy_admin;
create policy academy_admin_cm_user_delete on academy_admin
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- memory_fact — infrastructure (§6.7), so no writes and no general reads.
-- The single exception: §5 "the admin can ask what do you know about me?", plus
-- any person reading the facts held about themselves. Corrections still go
-- through the runtime, which writes a superseding row — hence SELECT only.
-- -----------------------------------------------------------------------------
drop policy if exists memory_fact_cm_user_select on memory_fact;
create policy memory_fact_cm_user_select on memory_fact
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (app.is_admin()
         or (subject_kind = 'person' and subject_id = app.person_id()))
  );

-- -----------------------------------------------------------------------------
-- class_coach — the default coach set. Own assignments; admin all.
-- -----------------------------------------------------------------------------
drop policy if exists class_coach_cm_user_select on class_coach;
create policy class_coach_cm_user_select on class_coach
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (app.is_admin() or coach_id = app.my_coach_id())
  );

drop policy if exists class_coach_cm_user_insert on class_coach;
create policy class_coach_cm_user_insert on class_coach
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists class_coach_cm_user_update on class_coach;
create policy class_coach_cm_user_update on class_coach
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists class_coach_cm_user_delete on class_coach;
create policy class_coach_cm_user_delete on class_coach
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- enrollment — own players' enrollments; the enrollments feeding a session I
-- coach (§6.7 row 2: "those rosters"). Rate columns ride here, but an
-- enrollment rate is the family's own price, not the academy's money.
-- -----------------------------------------------------------------------------
drop policy if exists enrollment_cm_user_select on enrollment;
create policy enrollment_cm_user_select on enrollment
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (
      app.is_admin()
      or player_id = any (app.my_player_ids())
      or exists (select 1 from session se
                 where se.class_id = enrollment.class_id
                   and se.id = any (app.my_session_ids()))
    )
  );

drop policy if exists enrollment_cm_user_insert on enrollment;
create policy enrollment_cm_user_insert on enrollment
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists enrollment_cm_user_update on enrollment;
create policy enrollment_cm_user_update on enrollment
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists enrollment_cm_user_delete on enrollment;
create policy enrollment_cm_user_delete on enrollment
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- session — app.my_session_ids() is the whole rule (§6.7 rows 2–4).
-- -----------------------------------------------------------------------------
drop policy if exists session_cm_user_select on session;
create policy session_cm_user_select on session
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (app.is_admin() or id = any (app.my_session_ids()))
  );

drop policy if exists session_cm_user_insert on session;
create policy session_cm_user_insert on session
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists session_cm_user_update on session;
create policy session_cm_user_update on session
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists session_cm_user_delete on session;
create policy session_cm_user_delete on session
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- session_coach — coverage (§6.3), the most important derived value in the
-- product. Readable by anyone who can see the session; a coach writes their own
-- row and only their own (confirmed_at, declined_at, arrived_at, running_late).
-- -----------------------------------------------------------------------------
drop policy if exists session_coach_cm_user_select on session_coach;
create policy session_coach_cm_user_select on session_coach
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (app.is_admin()
         or coach_id = app.my_coach_id()
         or session_id = any (app.my_session_ids()))
  );

drop policy if exists session_coach_cm_user_insert on session_coach;
create policy session_coach_cm_user_insert on session_coach
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

-- §8.2: "Yes, I'm coming", "Can't make it", "reached", "running late".
drop policy if exists session_coach_cm_user_update on session_coach;
create policy session_coach_cm_user_update on session_coach
  for update to cm_user
  using (academy_id = app.academy_id()
         and (app.is_admin() or coach_id = app.my_coach_id()))
  with check (academy_id = app.academy_id()
              and (app.is_admin() or coach_id = app.my_coach_id()));

drop policy if exists session_coach_cm_user_delete on session_coach;
create policy session_coach_cm_user_delete on session_coach
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- attendance — own players' attendance; the register of a session I coach.
-- The coach marks it (§8.2 CO-REGISTER); the admin can mark it themselves
-- (§12.4 AD-REGISTER-MISSING).
-- -----------------------------------------------------------------------------
drop policy if exists attendance_cm_user_select on attendance;
create policy attendance_cm_user_select on attendance
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and (app.is_admin()
         or player_id = any (app.my_player_ids())
         or session_id = any (app.my_session_ids()))
  );

drop policy if exists attendance_cm_user_insert on attendance;
create policy attendance_cm_user_insert on attendance
  for insert to cm_user
  with check (
    academy_id = app.academy_id()
    and (app.is_admin()
         or (app.my_coach_id() is not null and session_id = any (app.my_session_ids())))
  );

drop policy if exists attendance_cm_user_update on attendance;
create policy attendance_cm_user_update on attendance
  for update to cm_user
  using (
    academy_id = app.academy_id()
    and (app.is_admin()
         or (app.my_coach_id() is not null and session_id = any (app.my_session_ids())))
  )
  with check (
    academy_id = app.academy_id()
    and (app.is_admin()
         or (app.my_coach_id() is not null and session_id = any (app.my_session_ids())))
  );

drop policy if exists attendance_cm_user_delete on attendance;
create policy attendance_cm_user_delete on attendance
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- tally_line / payment — money. Two gates, both required:
--   app.sees_money()  — §6.7 row 4: money-shaped rows never route to a player's
--                       own number. A player who is not their account's holder
--                       gets false here, and a coach gets false too (§6.7 row 2:
--                       "never the academy's money").
--   own account       — never another family.
-- -----------------------------------------------------------------------------
drop policy if exists tally_line_cm_user_select on tally_line;
create policy tally_line_cm_user_select on tally_line
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and app.sees_money()
    and (app.is_admin() or account_id = any (app.my_account_ids()))
  );

drop policy if exists tally_line_cm_user_insert on tally_line;
create policy tally_line_cm_user_insert on tally_line
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists tally_line_cm_user_update on tally_line;
create policy tally_line_cm_user_update on tally_line
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists tally_line_cm_user_delete on tally_line;
create policy tally_line_cm_user_delete on tally_line
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

drop policy if exists payment_cm_user_select on payment;
create policy payment_cm_user_select on payment
  for select to cm_user, cm_readonly
  using (
    academy_id = app.academy_id()
    and app.sees_money()
    and (app.is_admin() or account_id = any (app.my_account_ids()))
  );

drop policy if exists payment_cm_user_insert on payment;
create policy payment_cm_user_insert on payment
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists payment_cm_user_update on payment;
create policy payment_cm_user_update on payment
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin())
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists payment_cm_user_delete on payment;
create policy payment_cm_user_delete on payment
  for delete to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- -----------------------------------------------------------------------------
-- action — §6.5: on tap, "check the tapping contact matches
-- minted_for_contact_id". That check is a policy, not a code path. There is no
-- admin override here on purpose: an admin tapping someone else's button is the
-- exact thing invariant §2.2 is guarding.
-- UPDATE is how consumed_at gets stamped; there is no INSERT or DELETE for
-- cm_user — minting is a compose-time act by the runtime.
-- -----------------------------------------------------------------------------
drop policy if exists action_cm_user_select on action;
create policy action_cm_user_select on action
  for select to cm_user, cm_readonly
  using (academy_id = app.academy_id()
         and minted_for_contact_id = app.contact_id());

drop policy if exists action_cm_user_update on action;
create policy action_cm_user_update on action
  for update to cm_user
  using (academy_id = app.academy_id()
         and minted_for_contact_id = app.contact_id())
  with check (academy_id = app.academy_id()
              and minted_for_contact_id = app.contact_id());

-- -----------------------------------------------------------------------------
-- message — a contact reads its own thread. The admin reads the academy's,
-- because §7.2's "did Meera get the reminder?" and the digest's delivery health
-- are answered from real status by a model-authored read under the admin's own
-- session. Nobody writes messages through a user session: the one send path
-- (§16.3) runs as cm_service.
-- -----------------------------------------------------------------------------
drop policy if exists message_cm_user_select on message;
create policy message_cm_user_select on message
  for select to cm_user, cm_readonly
  using (academy_id = app.academy_id()
         and (app.is_admin() or contact_id = app.contact_id()));

-- -----------------------------------------------------------------------------
-- Deliberately without any cm_user / cm_readonly policy (§6.7 — infrastructure,
-- unreachable through a user session). RLS is enabled on all of them, so this
-- is a hard deny, not an omission:
--
--   sender      — credentials (§6.5)
--   job         — the runner's queue (§6.6); an agent_task runs under the
--                 reconstructed session of its minter, but the ROW is the
--                 runtime's (§13.1)
--   turn        — instrumentation (§21.4)
--   audit_entry — §7.2; surfaced to the admin through the runtime, not by
--                 direct read, because undo is an operation and not a row edit
--   recipe      — §14.3
--   sim_clock / sim_fault — §17
-- -----------------------------------------------------------------------------

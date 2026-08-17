-- The states the shape requires, as rows.
--
-- ARCHITECTURE.md layer 0: "if anyone could ever ask about it, it is a row." Five
-- states this product has to report and could not store, each with the incident
-- that named it:
--
--   A PENDING REQUEST. Somebody was asked something and has not answered. The
--   most expensive missing state in the project's history. `opt_out` and
--   `decline_coach` both stage a confirmation and write nothing until it is
--   tapped, so an untapped stop request left the world identical to her never
--   having asked (F-AF, F-AQ). Worse than absent: a staged action rendered as
--   "done" in the next turn's context and the model faithfully repeated the lie
--   to the person it was about — the worst message ever driven.
--
--   SCOPED COMMUNICATION PREFERENCES. "Please stop messaging me about money" is
--   the commonest stop request and it is a SCOPE, not an opt-out. The model went
--   looking for one, enumerated `set_timing`'s keys, found none, fell back to a
--   memory fact and said "Done" — and a money message went out nine days later
--   (F-AV, F-AO). A preference stored as prose stops nothing, because the jobs
--   compose from queries and not from memory.
--
--   SUPPRESSION IS NOT FAILURE. A message the product decided not to send and a
--   message the wire could not deliver are opposite facts. They shared
--   `status='failed'`, so the product told its own owner his messaging was broken
--   — twice, a fortnight apart — when it was working exactly as designed (F-AT).
--
--   HOW THE OWNER WANTS THE BUSINESS RUN, with provenance. Every business is
--   unique and this is where the uniqueness lives, as data in the tail and never
--   as a per-tenant prompt fork. A rule the owner stated outranks everything and
--   only the owner retires it; a pattern the model observed is a suggestion until
--   the owner blesses it. The alternative was driven: the model invented a
--   pro-rata refund policy, remembered itself saying it, and the invention
--   acquired the authority of memory.
--
--   SOLO IS A TRUTH A REAL PATH WRITES. `app.is_solo()` keys on a coach status
--   that only `onboard_coach` writes, and a solo operator has nobody to be
--   invited by — so eight §18 behaviours existed only on runs where the model
--   happened to hand-write the activation SQL itself (F-AY). Whether a behaviour
--   exists must never be a property of the model's diligence, so the activation
--   is a trigger: it covers `add_coach`, a raw INSERT, a form, and every route
--   nobody has written yet.
--
-- Plus two invariants the schema can finally say: a watch has a normalised
-- SUBJECT, so a second watch on the same subject supersedes instead of
-- accumulating (F-C: seven watches about the same two registers, seven messages
-- in three minutes, and the frequency cap then dropped the one message that
-- mattered); and every outbound message records WHAT SENT IT (27 of 81 outbound
-- carried no attribution, so the truth axis could not be measured on exactly the
-- surface where the product acts unsupervised).
--
-- Re-runnable, like every migration here.

-- ---------------------------------------------------------------------------
-- 1 · pending_request — a question on somebody's screen, and how it ended
-- ---------------------------------------------------------------------------

create table if not exists pending_request (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default app.now(),
  academy_id    uuid not null references academy (id) on delete cascade,

  -- Who was asked. Both, because the tail reads by contact and the §18 gates
  -- reason about the person.
  contact_id    uuid not null references contact (id) on delete cascade,
  person_id     uuid not null references person (id) on delete cascade,

  -- What they were asked. `kind` is the protocol ("opt_out", "decline_coach");
  -- `subject` is what it is ABOUT, normalised, so a second ask about the same
  -- thing supersedes the first rather than sitting beside it. `question` is the
  -- sentence they actually read, so the next turn can say what is outstanding in
  -- the words they saw rather than in the runtime's.
  kind          text not null,
  subject       text not null,
  question      text not null,

  -- Until when it matters. NULL is a question with no deadline, not a leak: the
  -- action behind it carries its own TTL.
  expires_at    timestamptz,

  asked_turn_id uuid,
  message_id    uuid references message (id) on delete set null,

  -- How it ended. Every value here is a fact somebody may have to report.
  resolved_at   timestamptz,
  resolution    text check (resolution in ('tapped', 'expired', 'superseded', 'withdrawn')),

  constraint pending_request_resolution_pairs
    check ((resolved_at is null) = (resolution is null))
);

comment on table pending_request is
  'A question put on one person''s screen that only their own answer resolves. '
  'Written when the ask actually reaches them, resolved by their tap, by expiry, '
  'or by a newer ask about the same subject. The open rows are what the variable '
  'tail renders so the model never has to reconstruct an outstanding question '
  'from conversation memory (ARCHITECTURE.md layer 0 / layer 3).';

comment on column pending_request.subject is
  'What the question is about, normalised. The partial unique index below makes a '
  'second ask on the same subject supersede the first — the same lesson as '
  'tally_line.dedupe_key: a shared literal stops two writers drifting, only a '
  'constraint stops a third writer nobody has written yet.';

-- One open question per person per subject. This is the constraint that makes
-- "supersedes" true rather than intended.
create unique index if not exists pending_request_open_key
  on pending_request (academy_id, contact_id, kind, subject)
  where resolved_at is null;

create index if not exists pending_request_contact_idx
  on pending_request (contact_id) where resolved_at is null;
create index if not exists pending_request_academy_idx on pending_request (academy_id);
create index if not exists pending_request_message_idx
  on pending_request (message_id) where message_id is not null;

-- ---------------------------------------------------------------------------
-- 2 · comm_preference — "stop messaging me about money", as a row a job reads
-- ---------------------------------------------------------------------------

create table if not exists comm_preference (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default app.now(),
  academy_id  uuid not null references academy (id) on delete cascade,
  contact_id  uuid not null references contact (id) on delete cascade,
  person_id   uuid not null references person (id) on delete cascade,

  -- The categories a person actually distinguishes. 'all' is the full opt-out's
  -- twin and exists so one query answers "may I send this" for both.
  scope       text not null check (scope in ('all', 'money', 'reminders', 'outcomes', 'announcements')),

  -- Optional deadline, in the academy's own calendar. NULL is "until they say
  -- otherwise", which is what people mean when they do not name a date.
  until       date,

  -- Their own words, so the model can say what it understood rather than what
  -- the enum is called.
  stated      text,

  set_by_person_id uuid references person (id),
  set_turn_id      uuid,
  released_at      timestamptz
);

comment on table comm_preference is
  'A scoped mute, read by every job that composes into one of these categories. '
  '"Stop messaging me about money" is a scope, not an opt-out, and it is the '
  'commonest stop request — a memory fact recording it stopped nothing, because '
  'the jobs compose from queries (F-AV).';

create unique index if not exists comm_preference_open_key
  on comm_preference (academy_id, contact_id, scope)
  where released_at is null;

create index if not exists comm_preference_contact_idx
  on comm_preference (contact_id) where released_at is null;
create index if not exists comm_preference_academy_idx on comm_preference (academy_id);

-- ---------------------------------------------------------------------------
-- 3 · business_rule — how the owner wants the business run, with provenance
-- ---------------------------------------------------------------------------

create table if not exists business_rule (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default app.now(),
  academy_id  uuid not null references academy (id) on delete cascade,

  -- The owner's own words. Never the runtime's paraphrase: a rule restated is a
  -- rule half-invented.
  statement   text not null,
  topic       text,

  -- PROVENANCE. A rule the owner stated outranks everything and only the owner
  -- retires it. A pattern the model observed is a SUGGESTION until the owner
  -- blesses it — which is what the two-tap protocol exists for.
  provenance  text not null check (provenance in ('owner_stated', 'observed')),
  stated_by_person_id uuid references person (id),
  source_turn_id      uuid,
  blessed_at          timestamptz,
  blessed_by_person_id uuid references person (id),

  -- SCOPE HONESTY. A rule in prose steers the model on turns it is present for;
  -- it does nothing to a job composing from a query at 9am. This column names
  -- the typed row that actually gates the automation, or is NULL — and NULL is
  -- the honest answer the model has to say out loud: "I'll follow that in
  -- conversation; the automatic reminders don't read it — want them off?"
  enforced_by text,

  -- Whether a customer may be told this rule. An unstated policy is the owner's
  -- decision to make; a policy stated only to the owner is not a secret from
  -- them, but it is not the parent's to read either.
  visibility  text not null default 'internal' check (visibility in ('internal', 'shared')),

  retired_at  timestamptz,
  retired_by_person_id uuid references person (id)
);

comment on table business_rule is
  'Rules, preferences and standing intent in the owner''s own words — refund '
  'terms, age limits, "no makeups on Saturdays", "ask me before waiving anything '
  'over Rs500". Data in the tail, never a per-tenant prompt fork: the prefix must '
  'stay byte-identical for every business forever and the cost model allows no '
  'other answer.';

comment on column business_rule.enforced_by is
  'The typed row that gates the automation this rule is about (a comm_preference '
  'scope, an academy column), or NULL when nothing does. NULL is readable and is '
  'meant to be read out.';

create index if not exists business_rule_academy_idx
  on business_rule (academy_id) where retired_at is null;

-- ---------------------------------------------------------------------------
-- 4 · Suppression is not failure
-- ---------------------------------------------------------------------------
--
-- The gate and the outage shared one value, and every consumer that reads
-- `status` — a dashboard, an operator, the model — read a decision as a fault.
-- No prompt rule can fix a column that says the wrong thing.

alter table message drop constraint if exists message_status_check;
alter table message
  add constraint message_status_check
  check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'suppressed'));

update message
   set status = 'suppressed'
 where suppressed_reason is not null
   and status = 'failed';

comment on column message.status is
  'queued -> sent -> delivered -> read, or failed (the wire said no), or '
  'suppressed (this product decided not to send it, and suppressed_reason says '
  'which gate). failed and suppressed are opposite facts and are never one value '
  'again — F-AT.';

-- ---------------------------------------------------------------------------
-- 5 · Every outbound message knows what sent it
-- ---------------------------------------------------------------------------
--
-- Carried by a GUC and a column default, exactly like `turn_id` in 0019 and for
-- the same reason: a guarantee applied per caller is not a guarantee. `turn_id`
-- answers WHICH turn; this answers whether there was a turn at all, which is the
-- question a job send could not answer.

alter table message add column if not exists origin text;
alter table message add column if not exists origin_ref text;

do $$
begin
  alter table message alter column origin
    set default nullif(current_setting('app.origin', true), '');
  alter table message alter column origin_ref
    set default nullif(current_setting('app.origin_ref', true), '');
exception when others then
  null;
end $$;

alter table message drop constraint if exists message_origin_check;
alter table message
  add constraint message_origin_check
  check (origin is null or origin in ('turn', 'job', 'tap', 'system'));

comment on column message.origin is
  'What put this on the wire: a turn (somebody was talking), a job (the standing '
  'surface), a tap (a payload minted earlier, no model present), or the system '
  'itself. Defaulted from the app.origin GUC so no send path can forget it.';
comment on column message.origin_ref is
  'Which one: the job kind, the tapped action kind, the form id. Free text on '
  'purpose — the set grows without a migration and nothing branches on it.';

-- Everything already on the wire was one of two things, and both are knowable.
update message
   set origin = case when turn_id is not null then 'turn' else 'job' end
 where origin is null;

create index if not exists message_origin_idx on message (origin) where origin is not null;

-- ---------------------------------------------------------------------------
-- 6 · A watch has a subject, and a second watch on it supersedes
-- ---------------------------------------------------------------------------
--
-- `dedupe_key` answers "is this the same job"; it cannot answer "is this the
-- same THING being watched", because the model mints a fresh slug every time.
-- F-C is what that costs: seven near-identical watches, seven messages in three
-- minutes, and then the frequency cap dropping the one message that mattered.

alter table job add column if not exists subject_key text;

comment on column job.subject_key is
  'What this job is watching, normalised, for kinds where a second job about the '
  'same subject should REPLACE the first rather than accumulate beside it. NULL '
  'for the standing jobs, whose dedupe_key is already the subject.';

alter table job drop constraint if exists job_status_check;
alter table job
  add constraint job_status_check
  check (status in ('pending', 'running', 'done', 'failed', 'skipped', 'cancelled', 'superseded'));

-- The constraint, not the convention: one live job per subject.
create unique index if not exists job_open_subject_key
  on job (subject_key)
  where subject_key is not null and status in ('pending', 'running');

-- ---------------------------------------------------------------------------
-- 7 · Solo is a truth a real path writes
-- ---------------------------------------------------------------------------
--
-- There is nothing to confirm to yourself. A coach who is already an admin of
-- this academy is definitionally present, so being added IS being active — on
-- every route, including the ones nobody has written yet.

create or replace function app.activate_admin_coach() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.status = 'added' and exists (
    select 1 from academy_admin aa
     where aa.academy_id = new.academy_id
       and aa.person_id  = new.person_id
  ) then
    new.status := 'active';
    new.onboarded_at := coalesce(new.onboarded_at, app.now());
  end if;
  return new;
end
$$;

drop trigger if exists coach_activate_admin on coach;
create trigger coach_activate_admin
  before insert or update of status, person_id on coach
  for each row execute function app.activate_admin_coach();

-- The other order: the coach row existed first, and the person became an admin
-- afterwards. Same truth, different arrival.
create or replace function app.activate_coach_on_admin() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  update coach
     set status = 'active', onboarded_at = coalesce(onboarded_at, app.now())
   where academy_id = new.academy_id
     and person_id  = new.person_id
     and status     = 'added';
  return new;
end
$$;

drop trigger if exists academy_admin_activate_coach on academy_admin;
create trigger academy_admin_activate_coach
  after insert on academy_admin
  for each row execute function app.activate_coach_on_admin();

-- Every solo operator already sitting in the gap.
update coach c
   set status = 'active', onboarded_at = coalesce(c.onboarded_at, app.now())
 where c.status = 'added'
   and exists (select 1 from academy_admin aa
                where aa.academy_id = c.academy_id and aa.person_id = c.person_id);

-- ---------------------------------------------------------------------------
-- 8 · RLS. The only security boundary, so the new tables get it on arrival.
-- ---------------------------------------------------------------------------

alter table pending_request enable row level security;
alter table comm_preference enable row level security;
alter table business_rule   enable row level security;

-- cm_service: tenant-pinned like every other tenant table.
drop policy if exists pending_request_cm_service_all on pending_request;
create policy pending_request_cm_service_all on pending_request for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists comm_preference_cm_service_all on comm_preference;
create policy comm_preference_cm_service_all on comm_preference for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

drop policy if exists business_rule_cm_service_all on business_rule;
create policy business_rule_cm_service_all on business_rule for all to cm_service
  using (academy_id = app.academy_id()) with check (academy_id = app.academy_id());

-- A person may read what they were asked and what they muted. The admin reads
-- the business's. Helper calls are wrapped in a scalar subselect so the planner
-- evaluates them once per statement, per 0028.
drop policy if exists pending_request_cm_user_select on pending_request;
create policy pending_request_cm_user_select on pending_request for select
  to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and ((select app.is_admin())
         or contact_id = (select app.contact_id())
         or person_id  = (select app.person_id()))
  );

drop policy if exists comm_preference_cm_user_select on comm_preference;
create policy comm_preference_cm_user_select on comm_preference for select
  to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and ((select app.is_admin())
         or contact_id = (select app.contact_id())
         or person_id  = (select app.person_id()))
  );

-- You may mute yourself. Somebody asking to be left alone should not need an
-- admin present for it to be recorded, and the alternative was driven: the
-- request evaporated (F-AF).
drop policy if exists comm_preference_cm_user_insert on comm_preference;
create policy comm_preference_cm_user_insert on comm_preference for insert to cm_user
  with check (
    academy_id = app.academy_id()
    and (app.is_admin() or contact_id = app.contact_id())
  );

drop policy if exists comm_preference_cm_user_update on comm_preference;
create policy comm_preference_cm_user_update on comm_preference for update to cm_user
  using (
    academy_id = app.academy_id()
    and (app.is_admin() or contact_id = app.contact_id())
  );

-- The business's rules. `visibility` is the owner's own decision about what a
-- customer may be told, so a non-admin session sees the shared ones and nothing
-- else — and the read tool's existing note already says an empty result under a
-- scoped session may mean "not theirs to see".
drop policy if exists business_rule_cm_user_select on business_rule;
create policy business_rule_cm_user_select on business_rule for select
  to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and ((select app.is_admin()) or visibility = 'shared')
  );

drop policy if exists business_rule_cm_user_insert on business_rule;
create policy business_rule_cm_user_insert on business_rule for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists business_rule_cm_user_update on business_rule;
create policy business_rule_cm_user_update on business_rule for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

-- pending_request has no cm_user write policy on purpose: it is the runtime's
-- record of its own asks, written where the ask reaches the wire and resolved
-- where the tap is consumed. A person who could write it could forge an answer
-- to a question about somebody else.

grant select, insert, update, delete on pending_request, comm_preference, business_rule
  to cm_service, cm_user;
grant select on pending_request, comm_preference, business_rule to cm_readonly;

-- ---------------------------------------------------------------------------
-- 9 · The mutes that were jsonb keys become rows
-- ---------------------------------------------------------------------------
--
-- `person.settings->>'client_reminder_muted'` and `client_outcome_muted` were
-- the only scoped mutes the product had, invented by `set_timing`, readable by
-- exactly two job handlers and by nothing the model could query. Two authors of
-- one truth. The rows are the author now; the keys are dropped so nothing can
-- read the stale half.

insert into comm_preference (academy_id, contact_id, person_id, scope, stated)
select c.academy_id, c.id, p.id, 'reminders',
       'carried over from a per-person timing override'
  from person p
  join contact c on c.person_id = p.id and c.academy_id = p.academy_id
 where coalesce((p.settings->>'client_reminder_muted')::boolean, false)
on conflict do nothing;

insert into comm_preference (academy_id, contact_id, person_id, scope, stated)
select c.academy_id, c.id, p.id, 'outcomes',
       'carried over from a per-person timing override'
  from person p
  join contact c on c.person_id = p.id and c.academy_id = p.academy_id
 where coalesce((p.settings->>'client_outcome_muted')::boolean, false)
on conflict do nothing;

update person
   set settings = settings - 'client_reminder_muted' - 'client_outcome_muted'
 where settings ?| array['client_reminder_muted', 'client_outcome_muted'];

-- ---------------------------------------------------------------------------
-- 10 · Audit. A pending request and a mute are states somebody may dispute.
-- ---------------------------------------------------------------------------

drop trigger if exists comm_preference_snapshot on comm_preference;
create trigger comm_preference_snapshot
  after insert or update or delete on comm_preference
  for each row execute function app.snapshot_row();

drop trigger if exists business_rule_snapshot on business_rule;
create trigger business_rule_snapshot
  after insert or update or delete on business_rule
  for each row execute function app.snapshot_row();

-- pending_request is deliberately NOT snapshotted, for the reason 0005 gives for
-- `message`: undo reverses database writes, and a question already read on
-- somebody's phone cannot be unasked.

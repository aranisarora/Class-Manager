-- =============================================================================
-- 0002_schema.sql — the data model. Spec §6 verbatim, plus the columns §10,
-- §12, §13, §14 and §17 depend on.
--
-- Every table: id uuid pk default gen_random_uuid(), created_at timestamptz.
-- Every table except academy, sender, job and sim_* carries
-- academy_id uuid not null references academy(id) on delete cascade.
--
-- Re-runnable. `create table if not exists` throughout.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- §6.5 sender — the one deliberately global table. One number serves many
-- academies (§16), so it cannot carry a tenant. Never reachable through a user
-- session; readable only by the send path's own role.
-- -----------------------------------------------------------------------------
create table if not exists sender (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  phone_e164  text not null,
  waba_id     text not null,
  credentials jsonb not null,
  label       text                      -- human name for the number, shown in
                                        -- the emulator event log (§17)
);

-- -----------------------------------------------------------------------------
-- §6.1 Tenancy and place
-- -----------------------------------------------------------------------------
create table if not exists academy (
  id                         uuid primary key default gen_random_uuid(),
  created_at                 timestamptz not null default now(),
  name                       text not null,
  category                   text,          -- 'badminton', 'carnatic vocal' — display only
  timezone                   text not null default 'Asia/Kolkata',
  cancellation_window_hours  int  not null default 24,
  client_reminder_lead_hours int  not null default 14,
  morning_brief_at           time not null default '07:00',
  evening_digest_at          time not null default '21:00',
  rail                       text not null default 'rail1'
                               check (rail in ('rail1','rail2')),
  upi_handle                 text,
  sender_id                  uuid not null references sender(id),
  memory                     text,          -- §5. bounded hot set, not the record.
  prompt_cache_handle        text,          -- §4.4. stays null until phase 8.
  settings                   jsonb not null default '{}',
  created_on                 date not null default current_date,
                                            -- §10.2: the mix shifts over the
                                            -- first month; needs academy age
  onboarding_state           text not null default 'setup'
                               check (onboarding_state in ('setup','roster','ready','live'))
                                            -- §2.6/§7.1: nothing is sent until
                                            -- the admin says go. 'live' is the go.
);

comment on table academy is
  'The tenant. The word "academy" appears nowhere a user can see — §18.4.';

create table if not exists venue (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  academy_id uuid not null references academy(id) on delete cascade,
  name       text not null,
  address    text,
  notes      text
);

-- -----------------------------------------------------------------------------
-- §6.2 People. Three separate concerns; collapsing them is what makes
-- "parent pays for child" and "adult pays for self" look like two products.
-- -----------------------------------------------------------------------------
create table if not exists person (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  academy_id uuid not null references academy(id) on delete cascade,
  full_name  text not null,
  notes      text,
  memory     text,                        -- §5. bounded hot set, not the record.
  settings   jsonb not null default '{}'  -- per-person timing overrides (§8.2)
);

create table if not exists contact (               -- a WhatsApp number
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  academy_id      uuid not null references academy(id) on delete cascade,
  person_id       uuid not null references person(id),
  phone_e164      text not null,
  wa_id           text,
  profile_name    text,                    -- from the inbound webhook, free
  is_primary      boolean not null default true,
  state           text not null default 'registered'
                    check (state in ('prospect','registered','engaged','opted_out')),  -- §11.2
  opted_out_at    timestamptz,
  last_inbound_at timestamptz,             -- the 24h window's source of truth
  role_hint       text,                    -- which hat this number usually wears
  tier_state      jsonb not null default '{}',  -- §16.1 per-recipient frequency
                                                -- and tier accounting
  unique (academy_id, phone_e164)
);

create table if not exists account (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  academy_id       uuid not null references academy(id) on delete cascade,
  holder_person_id uuid not null references person(id),
  display_name     text
);

create table if not exists player (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  academy_id uuid not null references academy(id) on delete cascade,
  account_id uuid not null references account(id),
  person_id  uuid not null references person(id),
  active     boolean not null default true
);

create table if not exists coach (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  academy_id   uuid not null references academy(id) on delete cascade,
  person_id    uuid not null references person(id),
  pay_amount   numeric(10,2),               -- null = not tracked, a valid state
  pay_unit     text check (pay_unit in ('per_session','per_hour','per_month')),
  status       text not null default 'added'
                 check (status in ('added','invited','active','ended')),   -- §11.3
  invited_at   timestamptz,
  onboarded_at timestamptz,
  ended_on     date                         -- soft end. never delete a coach.
);

create table if not exists academy_admin (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  academy_id uuid not null references academy(id) on delete cascade,
  person_id  uuid not null references person(id)
);

create table if not exists memory_fact (     -- §5. append-only. this is the record.
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  academy_id   uuid not null references academy(id) on delete cascade,
  subject_kind text not null check (subject_kind in ('academy','person')),
  subject_id   uuid not null,
  fact         text not null,
  source       text,                        -- the turn or observation that produced it
  supersedes   uuid references memory_fact(id),
  retired_at   timestamptz
);

comment on table memory_fact is
  'Never updated, never deleted. A correction writes a new row pointing at the '
  'one it supersedes (§5).';

-- -----------------------------------------------------------------------------
-- §6.3 Classes and sessions. ONE class noun — no group/private/batch/one-off
-- distinction exists and the product never branches on one.
-- -----------------------------------------------------------------------------
create table if not exists class (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  academy_id  uuid not null references academy(id) on delete cascade,
  name        text not null,      -- the admin's own words: "6:30 Beginners Batch"
  venue_id    uuid references venue(id),
  rate_amount numeric(10,2),
  rate_unit   text check (rate_unit in ('per_session','per_month','per_term','per_package')),
  rate_count  int,                -- per_term: months in the term.
                                  -- per_package: sessions in the package. else null.
  starts_on   date not null,
  ends_on     date,               -- null = open-ended
  active      boolean not null default true
);

create table if not exists class_slot (      -- weekly recurrence; a class may have several
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  academy_id uuid not null references academy(id) on delete cascade,
  class_id   uuid not null references class(id) on delete cascade,
  weekday    int  not null check (weekday between 0 and 6),  -- 0=Sun .. 6=Sat
  start_time time not null,
  end_time   time not null
);

-- class_coach and session_coach keep the spec's composite primary keys. They
-- still get id/created_at/academy_id, but id is a plain (uniquely indexed)
-- column — the PK stays where the spec put it.
create table if not exists class_coach (     -- the DEFAULT coach set
  id         uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  academy_id uuid not null references academy(id) on delete cascade,
  class_id   uuid not null references class(id) on delete cascade,
  coach_id   uuid not null references coach(id),
  primary key (class_id, coach_id)
);
create unique index if not exists class_coach_id_key on class_coach (id);

create table if not exists enrollment (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  academy_id  uuid not null references academy(id) on delete cascade,
  class_id    uuid not null references class(id),
  player_id   uuid not null references player(id),
  rate_amount numeric(10,2),       -- null = inherit from class
  rate_unit   text check (rate_unit in ('per_session','per_month','per_term','per_package')),
  rate_count  int,                 -- null = inherit from class
  is_trial    boolean not null default false,
  started_on  date not null,
  ended_on    date                 -- §11.4
);

create table if not exists session (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  academy_id    uuid not null references academy(id) on delete cascade,
  class_id      uuid not null references class(id),
  venue_id      uuid references venue(id),   -- overrides class venue when set
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  status        text not null default 'scheduled'
                  check (status in ('scheduled','cancelled','completed')),   -- §11.1
  cancel_reason text,
  unique (class_id, starts_at)
);

create table if not exists session_coach (   -- the ACTUAL coach set. a SET, never a scalar.
  id           uuid not null default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  academy_id   uuid not null references academy(id) on delete cascade,
  session_id   uuid not null references session(id) on delete cascade,
  coach_id     uuid not null references coach(id),
  confirmed_at timestamptz,
  declined_at  timestamptz,
  arrived_at   timestamptz,        -- never prompted; set only if the coach says so
  running_late boolean not null default false,
  primary key (session_id, coach_id)
);
create unique index if not exists session_coach_id_key on session_coach (id);

create table if not exists attendance (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  academy_id         uuid not null references academy(id) on delete cascade,
  session_id         uuid not null references session(id),
  player_id          uuid not null references player(id),
  status             text not null
                       check (status in ('present','late','absent','cancelled_timely')),
  note               text,
  marked_by_coach_id uuid references coach(id),
  marked_at          timestamptz not null default now(),
  unique (session_id, player_id)     -- §8.2: idempotency is the schema's job
);

-- -----------------------------------------------------------------------------
-- §6.4 Money
-- -----------------------------------------------------------------------------
create table if not exists tally_line (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  academy_id  uuid not null references academy(id) on delete cascade,
  account_id  uuid not null references account(id),
  player_id   uuid references player(id),      -- null for account-level adjustments
  period      date not null,                   -- first day of the billing month
  kind        text not null
                check (kind in ('session','monthly','term','package','adjustment')),
  description text not null,                   -- shown verbatim to the parent
  amount      numeric(10,2) not null,          -- negative for credits and waivers
  session_id  uuid references session(id),
  reason      text,                            -- adjustments only
  approved_by uuid references person(id)       -- adjustments only
);

-- Spec §6.4 writes `unique (session_id, player_id)`. As a table constraint that
-- would still admit unlimited (null, player) rows, but stating it as a PARTIAL
-- unique index makes the intent explicit: one session line per player per
-- session, unlimited non-session lines (monthly, term, package, adjustment).
create unique index if not exists tally_line_session_player_key
  on tally_line (session_id, player_id) where session_id is not null;

create table if not exists payment (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  academy_id   uuid not null references academy(id) on delete cascade,
  account_id   uuid not null references account(id),
  amount       numeric(10,2) not null,
  rail         text not null check (rail in ('rail1','rail2')),
  method       text,
  reference    text,                           -- UPI ref / UTR
  status       text not null
                 check (status in ('requested','confirmed','failed')),   -- §11.5
  requested_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by uuid references person(id),     -- rail1: the admin who attested
  evidence_url text                            -- rail1: a forwarded screenshot
);

-- -----------------------------------------------------------------------------
-- §6.5 Messaging, actions, views.
-- `action` is created before `message` because message.reply_to_action_id
-- points at it.
-- -----------------------------------------------------------------------------
create table if not exists action (          -- §2.2, the payload rule
  id                     uuid primary key default gen_random_uuid(),
  created_at             timestamptz not null default now(),
  academy_id             uuid not null references academy(id) on delete cascade,
  kind                   text not null,    -- operation | steps | <recipe verb>
  payload                jsonb not null,   -- fully resolved. no ids to look up.
  minted_at              timestamptz not null default now(),
  minted_for_contact_id  uuid not null references contact(id),
  expires_at             timestamptz,
  consumed_at            timestamptz,
  consumed_by_contact_id uuid references contact(id)
);

comment on table action is
  'Mint once, replay verbatim (§2.2). kind is deliberately not a fixed list — '
  'operation and steps make the button surface exactly as wide as the write '
  'surface (§6.5).';

create table if not exists message (
  id                    uuid primary key default gen_random_uuid(),
  created_at            timestamptz not null default now(),
  academy_id            uuid not null references academy(id) on delete cascade,
  contact_id            uuid not null references contact(id),
  sender_id             uuid not null references sender(id),
  direction             text not null check (direction in ('inbound','outbound')),
  catalog_id            text,                     -- §12, null for composed messages
  wa_message_id         text,
  template_name         text,                     -- null when inside the window
  body                  text,
  payload               jsonb,
  media_url             text,
  status                text not null default 'queued'
                          check (status in ('queued','sent','delivered','read','failed')),
                                                  -- §2.4: sending is not receiving
  queued_at             timestamptz not null default now(),
  sent_at               timestamptz,
  delivered_at          timestamptz,
  read_at               timestamptz,
  failed_reason         text,
  suppressed_reason     text,                     -- §12/§18: a message the send
                                                  -- path dropped is recorded, not vanished
  cost_paise            int,                      -- §17 event log
  conversation_category text
                          check (conversation_category in
                            ('service','utility','marketing','authentication','free_window')),
  in_window             boolean not null default true,  -- §14.7 template vs in-window
  reply_to_action_id    uuid references action(id),     -- inbound button taps
  idempotency_key       text unique                     -- REQUIRED on every outbound
);

create table if not exists view_spec (       -- §15. minted once, rendered deterministically.
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  academy_id    uuid not null references academy(id) on delete cascade,
  spec          jsonb not null,              -- components, arrangement, queries
  for_person_id uuid not null references person(id),
  expires_at    timestamptz not null,
  minted_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- §6.6 Jobs. Global — the runner is infrastructure and claims across tenants;
-- the academy it acts for rides in payload and is applied with `set local`.
-- -----------------------------------------------------------------------------
create table if not exists job (
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind       text not null,        -- §13
  run_at     timestamptz not null,
  dedupe_key text not null unique, -- enqueueing the same key twice is a no-op
  status     text not null default 'pending'
               check (status in ('pending','running','done','failed','skipped','cancelled')),
  attempts   int not null default 0,
  last_error text,
  payload    jsonb not null default '{}',
  locked_at  timestamptz,          -- claimed by app.claim_jobs (0004)
  locked_by  text
);

-- -----------------------------------------------------------------------------
-- §7.2, §14.2 — audit trail and the undo window on destructive operations.
-- The whole plan is one audit entry, carrying the intent that produced it.
-- -----------------------------------------------------------------------------
create table if not exists audit_entry (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  academy_id      uuid not null references academy(id) on delete cascade,
  actor_person_id uuid references person(id),
  intent          text,
  plan            jsonb,
  diff            jsonb,
  undone_at       timestamptz,
  undo_of         uuid references audit_entry(id)
);

-- -----------------------------------------------------------------------------
-- §14.3 — recipes. Captured model output, not hand-written code. Global
-- recipes carry a null academy_id, so this table is the one tenant-table
-- exception to `academy_id not null`.
-- -----------------------------------------------------------------------------
create table if not exists recipe (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz not null default now(),
  academy_id          uuid references academy(id) on delete cascade,  -- null = global
  name                text not null,
  trigger_description text,
  plan                jsonb not null,
  captured_from       uuid references audit_entry(id),
  active              boolean not null default true,
  unique (academy_id, name)
);

-- unique(academy_id, name) treats nulls as distinct, so global recipe names
-- need their own partial index.
create unique index if not exists recipe_global_name_key
  on recipe (name) where academy_id is null;

-- -----------------------------------------------------------------------------
-- §17 — the emulator's substrate. Global, no academy_id: one world, one clock.
-- -----------------------------------------------------------------------------
create table if not exists sim_clock (       -- one shared clock, advanced on demand
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  singleton  boolean not null default true unique check (singleton),
  offset_ms  bigint not null default 0,
  frozen_at  timestamptz
);

create table if not exists sim_fault (       -- failure injection
  id         uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind       text not null
               check (kind in ('send_fail','number_blocked','media_timeout',
                               'link_expired','model_error')),
  active     boolean not null default false,
  rate       numeric not null default 1.0,
  unique (kind)
);

create table if not exists sim_run (         -- seeds, recordings, judge reports
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  seed         text not null,
  label        text,
  started_at   timestamptz not null default now(),
  ended_at     timestamptz,
  transcript   jsonb,
  judge_report jsonb,
  persona      jsonb,
  goal         text
);

-- -----------------------------------------------------------------------------
-- §21.4 / §14.3 — turn instrumentation. What the model kept re-deriving is what
-- becomes the next recipe; model tiering is decided against this table.
-- -----------------------------------------------------------------------------
create table if not exists turn (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  academy_id    uuid not null references academy(id) on delete cascade,
  contact_id    uuid references contact(id),
  person_id     uuid references person(id),
  role_acted    text,
  input         jsonb,
  output        jsonb,
  model         text,
  prompt_tokens int,
  output_tokens int,
  latency_ms    int,
  error         text
);

-- =============================================================================
-- Indexes. Every FK column used in a policy or a hot query.
-- =============================================================================

-- Tenant scoping — every policy in 0003 filters on academy_id first.
create index if not exists venue_academy_idx         on venue (academy_id);
create index if not exists person_academy_idx        on person (academy_id);
create index if not exists account_academy_idx       on account (academy_id);
create index if not exists player_academy_idx        on player (academy_id);
create index if not exists coach_academy_idx         on coach (academy_id);
create index if not exists academy_admin_academy_idx on academy_admin (academy_id);
create index if not exists class_academy_idx         on class (academy_id);
create index if not exists class_slot_academy_idx    on class_slot (academy_id);
create index if not exists class_coach_academy_idx   on class_coach (academy_id);
create index if not exists enrollment_academy_idx    on enrollment (academy_id);
create index if not exists session_coach_academy_idx on session_coach (academy_id);
create index if not exists attendance_academy_idx    on attendance (academy_id);
create index if not exists tally_line_academy_idx    on tally_line (academy_id);
create index if not exists payment_academy_idx       on payment (academy_id);
create index if not exists action_academy_idx        on action (academy_id);
create index if not exists message_academy_idx       on message (academy_id);
create index if not exists view_spec_academy_idx     on view_spec (academy_id);
create index if not exists memory_fact_academy_idx   on memory_fact (academy_id);
create index if not exists audit_entry_academy_idx   on audit_entry (academy_id);
create index if not exists turn_academy_idx          on turn (academy_id);

-- Role resolution (inbound: contact -> person -> roles, §6.2)
create index if not exists contact_person_idx        on contact (person_id);
create index if not exists account_holder_idx        on account (holder_person_id);
create index if not exists player_account_idx        on player (account_id);
create index if not exists player_person_idx         on player (person_id);
create index if not exists coach_person_idx          on coach (person_id);
create index if not exists academy_admin_person_idx  on academy_admin (person_id);

-- Hot paths named in the build brief.
-- NOTE: session(class_id, starts_at) and contact(academy_id, phone_e164) are
-- already backed by their UNIQUE constraints; a second identical btree would
-- only cost writes, so they are deliberately not duplicated here.
create index if not exists session_academy_starts_idx on session (academy_id, starts_at);
create index if not exists session_venue_idx          on session (venue_id);
create index if not exists session_coach_coach_idx    on session_coach (coach_id);
create index if not exists enrollment_open_class_idx  on enrollment (class_id) where ended_on is null;
create index if not exists enrollment_player_idx      on enrollment (player_id);
create index if not exists attendance_session_idx     on attendance (session_id);
create index if not exists attendance_player_idx      on attendance (player_id);
create index if not exists class_slot_class_idx       on class_slot (class_id);
create index if not exists class_coach_coach_idx      on class_coach (coach_id);
create index if not exists class_venue_idx            on class (venue_id);
create index if not exists contact_wa_id_idx          on contact (wa_id);
create index if not exists message_contact_queued_idx on message (contact_id, queued_at desc);
create index if not exists message_sender_idx         on message (sender_id);
create index if not exists message_status_idx         on message (status);
create index if not exists job_status_run_at_idx      on job (status, run_at);
create index if not exists memory_fact_subject_idx    on memory_fact (subject_kind, subject_id)
  where retired_at is null;
create index if not exists tally_line_account_period_idx on tally_line (account_id, period);
create index if not exists tally_line_player_idx      on tally_line (player_id);
create index if not exists payment_account_idx        on payment (account_id);
create index if not exists action_minted_for_idx      on action (minted_for_contact_id);
create index if not exists view_spec_person_idx       on view_spec (for_person_id);
create index if not exists turn_contact_idx           on turn (contact_id);

-- =============================================================================
-- RLS on. Every table, without exception (§6.7 meta-test: fail the build if any
-- table has RLS disabled). A table with RLS enabled and no policy for a role
-- denies that role everything — which is exactly the intent for infrastructure.
-- =============================================================================
alter table sender        enable row level security;
alter table academy       enable row level security;
alter table venue         enable row level security;
alter table person        enable row level security;
alter table contact       enable row level security;
alter table account       enable row level security;
alter table player        enable row level security;
alter table coach         enable row level security;
alter table academy_admin enable row level security;
alter table memory_fact   enable row level security;
alter table class         enable row level security;
alter table class_slot    enable row level security;
alter table class_coach   enable row level security;
alter table enrollment    enable row level security;
alter table session       enable row level security;
alter table session_coach enable row level security;
alter table attendance    enable row level security;
alter table tally_line    enable row level security;
alter table payment       enable row level security;
alter table action        enable row level security;
alter table message       enable row level security;
alter table view_spec     enable row level security;
alter table job           enable row level security;
alter table audit_entry   enable row level security;
alter table recipe        enable row level security;
alter table sim_clock     enable row level security;
alter table sim_fault     enable row level security;
alter table sim_run       enable row level security;
alter table turn          enable row level security;

-- =============================================================================
-- Grants. RLS does the filtering; these only decide which verbs exist at all.
-- =============================================================================
grant select, insert, update, delete on all tables in schema public
  to cm_service, cm_user;
grant select on all tables in schema public to cm_readonly;
grant usage, select on all sequences in schema public to cm_service, cm_user;

alter default privileges in schema public
  grant select, insert, update, delete on tables to cm_service, cm_user;
alter default privileges in schema public
  grant select on tables to cm_readonly;

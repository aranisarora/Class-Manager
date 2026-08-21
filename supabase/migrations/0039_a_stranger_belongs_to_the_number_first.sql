-- =============================================================================
-- 0039_a_stranger_belongs_to_the_number_first.sql — the arrivals hall.
--
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- An unknown number had exactly one thing it was allowed to become. `resolveInbound`
-- (lib/identity.ts) read the prefilled text, matched it against the academies on the
-- receiving sender, and created a `prospect` person inside whichever one it hit. A
-- number that matched nothing came back `unresolved`, and `ingestInbound` then wrote
-- no message row and ran no turn: the stranger got silence, and the product has no
-- record they ever wrote.
--
-- That shape encodes an assumption nobody decided: **a stranger is a parent.** It was
-- true while the only entry point was a QR code at the court. It is false the moment
-- the product grows the way it is about to grow — one coach telling another *"just
-- message this number and it'll run your classes"*. That referral carries no link, no
-- prefill and no academy name, so it lands in exactly the branch that answers nothing,
-- and the most valuable inbound the business can receive is the one it drops.
--
-- `lib/seed.ts` stated the old rule outright: *"Signing a business up is the
-- operator's job — the owner of Class Manager creates a tenant, and a stranger
-- messaging the number must never be able to. That is a product decision, and
-- `resolveInbound` returning `unresolved` for a number matching no academy is it
-- working, not a gap."* This migration is the deliberate reversal of that decision.
-- Referral IS the acquisition channel; the vendor is not going to be in the loop.
--
-- WHAT REPLACES IT
-- ---------------------------------------------------------------------------
-- A person who has not said which side they are on does not belong to a business.
-- They belong to the **number**. So the number gets a front desk, and the question —
-- *are you looking for classes, or do you run them?* — is asked by the product rather
-- than guessed by the router.
--
--   1. `academy.is_front_desk`  one row per `sender`. Not a business.
--   2. `arrival`                the funnel row: who arrived, and where they went.
--   3. `app.identity`           returns the `visitor` role for a front-desk contact.
--   4. `app.inbound_candidates` matches REAL tenants only, and names the front desk.
--
-- WHY THE FRONT DESK IS AN `academy` ROW, WHICH IS THE ONE ARGUABLE DECISION HERE
-- ---------------------------------------------------------------------------
-- It is not a business, and it is sitting in the table called `academy`. That is a
-- real cost and it was paid deliberately, so the reasoning is written down here
-- rather than discovered later.
--
-- The alternative was an honest one: a tenant-less `visitor` table, with the lobby
-- conversation living beside it. Follow that through and it needs `visitor_message`
-- (the transcript, because `message.academy_id` is NOT NULL), `visitor_action` (the
-- buttons — `[I'm looking for classes]` `[I run classes]` — because `action` is
-- tenant-scoped too, and buttons are how this product asks anything), `visitor_turn`
-- (the flight recorder, because `turn` is tenant-scoped), and a second path to the
-- wire, because `send()` resolves its recipient by joining contact → person →
-- academy → sender. Four parallel tables and a second sender, for the one
-- conversation in the product that talks to a complete stranger — and §16.3's "no
-- unthrottled send function exists in the codebase" would have to be re-argued rather
-- than inherited. ARCHITECTURE.md's rule against a thing getting "its own corner and
-- its own renderer" is what six report generators cost, and this would be that again
-- in the load-bearing half of the system.
--
-- As an `academy` row, the visitor gets a `person`, a `contact`, a transcript, a
-- `turn`, real buttons, RLS, and the one send path — with no new machinery at all.
-- What it costs is this column and the discipline of excluding it, which is why every
-- exclusion in the codebase is tagged `is_front_desk` and named in ARCHITECTURE.md's
-- trap list.
--
-- Two properties make the fiction safe rather than merely convenient:
--
--   RLS still holds. A visitor's session is pinned to the front desk, and the front
--   desk owns no class, no player, no money and no roster. The blast radius of the
--   agent surface being wrong for a stranger is a tenant containing nothing.
--
--   It cannot initiate. `onboarding_state` is left at `'setup'`, so send.ts gate 5
--   (`row.onboarding_state <> 'live' and not preLaunchOk and not is_admin and not
--   solicited`) suppresses every message the front desk did not compose as a direct
--   reply inside the visitor's own turn. No job, no digest, no broadcast can leave
--   it — not by policy, by the gate that is already there. A front desk that could
--   message strangers is a spam engine on a pooled number, and this is the sentence
--   that says it cannot.
--
-- WHY `arrival` IS ITS OWN TABLE AND NOT TWO COLUMNS ON `contact`
-- ---------------------------------------------------------------------------
-- The decisive reason is the destination. An arrival ends by pointing at the academy
-- the person went to — the one they joined, or the one they founded — and that pointer
-- crosses tenants. A tenant-scoped row must never carry a foreign key out of its own
-- tenant: RLS would make it unreadable from either side, and the one question the
-- vendor will actually ask ("how many referrals arrived this month, and how many
-- became businesses?") would have to iterate every academy to answer.
--
-- So `arrival` joins `sender` and `job` as a deliberately global table. Layer 0's
-- rule is what puts it here at all: if anyone could ever ask about it, it is a row.
-- Nobody has ever been able to ask how many strangers this product turned away.
--
-- WHY `visitor` IS A ROLE AND NOT A CONTACT STATE
-- ---------------------------------------------------------------------------
-- `contact.state` starts at `'prospect'` for an arrival, and that is not a compromise —
-- §11.2's `prospect` means "arrived cold, no account yet", which is exactly true of
-- someone standing at the front desk. What the state cannot say is *which* thing they
-- are a prospect OF, because a state describes the contact and the answer describes
-- the academy the contact is in.
--
-- **And it would not have survived the turn it was needed for.** `app.touch_contact_inbound`
-- (0004:237) fires on every inbound row and moves `registered|prospect -> engaged`, so a
-- contact is `prospect` only in the window between being created and the message that
-- created them being written — which is before the turn runs. A surface selected on
-- `state = 'prospect'` would therefore be selected for nobody, on the second message and
-- every message after it. Verified rather than assumed: with the whole migration set
-- applied, a fresh arrival reads `engaged` the instant its opening line is stored.
--
-- Roles compose, and every consumer in the product already reads them
-- (`resolveIdentity`, the tail, `turn.role_acted`, the tool surface). So the fact lands
-- where the readers already are AND on the thing that does not move: `app.identity`
-- returns `visitor` from `academy.is_front_desk`, which is true for as long as the
-- conversation is at the desk and false the moment it is not. A front-desk arrival
-- carries `["prospect","visitor"]` on its first message and `["visitor"]` after that —
-- and one `roles.includes('visitor')` narrows the whole surface either way.
--
-- Re-runnable.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1 · academy.is_front_desk
--
-- `not null default false` on an existing table is metadata-only since Postgres 11:
-- the default is recorded in the catalogue and materialised on read, so no row is
-- rewritten and the ACCESS EXCLUSIVE lock is held for a catalogue update rather than
-- a table scan. Safe against the live database with the cron beat running.
--
-- The default direction is the same argument 0030 made for `is_sandbox`, and it
-- matters more here: spelled `is_business boolean not null default false`, every
-- academy that already exists — and every one a future path creates without knowing
-- about this column — becomes a front desk, gets excluded from tenant enumeration,
-- and quietly stops being managed. Named for the exceptional state, defaulting to the
-- ordinary one, the identical omission produces an ordinary business.
-- -----------------------------------------------------------------------------
alter table academy
  add column if not exists is_front_desk boolean not null default false;

comment on column academy.is_front_desk is
  'True only for the arrivals hall of one WhatsApp number: the row a person gets a '
  'person, a contact and a transcript in before they have said whether they want '
  'classes or run them. Not a business. Excluded from every tenant enumeration '
  '(app.inbound_candidates matching, worldAcademyIds, the job beat, the digests). '
  'Carries no class, player, enrollment or money, and cannot initiate a message: '
  'onboarding_state stays not-live, so send.ts suppresses anything that is not a '
  'solicited reply inside the visitor own turn.';

-- One front desk per sender, enforced rather than remembered. A second one would
-- split the arrivals of one number across two tenants, and `app.front_desk_for`
-- below leans on this index as the arbiter for its ON CONFLICT.
create unique index if not exists academy_one_front_desk_per_sender_idx
  on academy (sender_id) where is_front_desk;

-- -----------------------------------------------------------------------------
-- 2 · arrival — the funnel row
--
-- One row per (sender, number) that ever reached the front desk. It outlives the
-- conversation on purpose: a number that arrived, was asked, and never answered is
-- the single most useful row in this table, and it is precisely the one that does not
-- exist anywhere today.
--
-- `unique (sender_id, phone_e164)` is what makes a second inbound from the same
-- stranger the same arrival rather than a new one. A person who genuinely returns
-- months later to found a second business is one arrival with a later `decided_at` —
-- `outcome` is the current answer, and `audit_entry` holds the history.
-- -----------------------------------------------------------------------------
create table if not exists arrival (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),

  -- Which number they messaged. The front desk belongs to the sender, so this is
  -- the tenancy-shaped column for a table that has no tenant.
  sender_id      uuid not null references sender(id) on delete cascade,
  phone_e164     text not null,

  -- Where the conversation is being held. Denormalised from
  -- `app.front_desk_for(sender_id)` so a reader never has to re-derive it, and so a
  -- front desk that is later rebuilt leaves its old arrivals pointing at the row the
  -- transcript is actually in.
  front_desk_id  uuid not null references academy(id) on delete cascade,
  contact_id     uuid not null references contact(id) on delete cascade,

  profile_name   text,                     -- the WhatsApp display name, free (§10.1)
  first_text     text,                     -- what they opened with, verbatim

  -- When the front desk actually put the question on their screen. Null means it
  -- never had to: the opening message already said which side they were on, and
  -- §10.1's "a conversation, not a wizard" is satisfied by not asking.
  asked_at       timestamptz,

  decided_at     timestamptz,
  outcome        text not null default 'undecided'
                   check (outcome in ('undecided','joined','founded','declined')),

  -- Where they went. Crosses tenants, which is the reason this table is global and
  -- these are not two columns on `contact`. `on delete set null` because a business
  -- that is later deleted must not delete the record that it was ever acquired.
  destination_academy_id uuid references academy(id) on delete set null,

  unique (sender_id, phone_e164)
);

comment on table arrival is
  'One row per number that reached a front desk: who arrived, what they opened with, '
  'whether they were asked which side they were on, and where they went — joined an '
  'existing business, founded a new one, or neither. Deliberately global (like sender '
  'and job): the destination crosses tenants, and "how many referrals became '
  'businesses" must be answerable without iterating academies.';

create index if not exists arrival_front_desk_idx  on arrival (front_desk_id);
create index if not exists arrival_contact_idx     on arrival (contact_id);
create index if not exists arrival_outcome_idx     on arrival (outcome, created_at);
create index if not exists arrival_destination_idx on arrival (destination_academy_id);

alter table arrival enable row level security;

-- Service only, `using (true)` — the same shape `sender` has, and for the same
-- reason: the row has no tenant to scope to. No cm_user or cm_readonly policy at all,
-- so RLS denies the agent everything: a visitor's own session cannot read the funnel,
-- and neither can any tenant's. The front desk's operations reach it through
-- reviewed protocol code holding a service session, which is where §Layer-1's
-- "elevation lives here and only here" puts it.
drop policy if exists arrival_cm_service_all on arrival;
create policy arrival_cm_service_all on arrival
  for all to cm_service using (true) with check (true);

-- 0002's blanket grant ran before this table existed, and `alter default privileges`
-- there names only cm_service and cm_user, so cm_readonly is granted explicitly.
-- RLS still denies it every row; the grant only decides which verbs exist.
grant select, insert, update, delete on arrival to cm_service, cm_user;
grant select on arrival to cm_readonly;

-- -----------------------------------------------------------------------------
-- 3 · app.front_desk_for(sender_id) — the arrivals hall, made on demand
--
-- Lazily, because a sender that never receives a cold inbound should not carry a
-- tenant, and because the row has to exist by the time the first stranger's message
-- is being written rather than by the time somebody remembered to provision it.
--
-- SECURITY DEFINER for the reason 0003_rls.sql:205 already states: `academy` has no
-- INSERT policy for anyone, "so tenant creation is a platform operation". This is a
-- platform operation. It is granted to cm_service only, so no agent session can
-- reach it.
--
-- The ON CONFLICT arbiter is the partial unique index above, and Postgres will not
-- infer a partial index unless the statement repeats its predicate — the same trap
-- 0024 left in `sim_clock`, where omitting the `where` turns this into a 42P10 at
-- exactly the moment the first stranger writes in.
--
-- The name is not shown to anybody. The front-desk turn runs on its own prefix,
-- which states what the front desk is instead of naming a business, precisely so the
-- product never introduces itself as a company the visitor has not heard of (§18.4:
-- "the word academy appears nowhere a user can see").
-- -----------------------------------------------------------------------------
create or replace function app.front_desk_for(p_sender_id uuid) returns uuid
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_id uuid;
  begin
    select id into v_id from academy
     where sender_id = p_sender_id and is_front_desk;
    if v_id is not null then
      return v_id;
    end if;

    insert into academy (name, sender_id, is_front_desk, onboarding_state)
    values ('Front desk', p_sender_id, true, 'setup')
    on conflict (sender_id) where is_front_desk do nothing
    returning id into v_id;

    -- Lost the race with a concurrent first inbound on the same number: the other
    -- transaction's row is the front desk, and both callers must get the same one.
    if v_id is null then
      select id into v_id from academy
       where sender_id = p_sender_id and is_front_desk;
    end if;

    return v_id;
  end;
  $$;

revoke all on function app.front_desk_for(uuid) from public;
grant execute on function app.front_desk_for(uuid) to cm_service;

-- -----------------------------------------------------------------------------
-- 4 · app.identity() — the `visitor` role
--
-- Replaces 0005_audit.sql:306 verbatim except for the one appended case. Roles
-- compose by concatenation, so this is a fifth `||` and nothing else moves: a
-- front-desk arrival comes back `["prospect","visitor"]`, and a contact in a real
-- business is byte-for-byte what it was.
-- -----------------------------------------------------------------------------
create or replace function app.identity(p_contact_id uuid) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select jsonb_build_object(
      'academy_id', a.id,
      'academy',    to_jsonb(a),
      'contact',    to_jsonb(c),
      'person',     to_jsonb(p),
      'roles',
        (case when exists (select 1 from academy_admin aa
                           where aa.academy_id = a.id and aa.person_id = p.id)
              then '["admin"]'::jsonb else '[]'::jsonb end)
        ||
        (case when exists (select 1 from coach co
                           where co.academy_id = a.id and co.person_id = p.id
                             and co.status <> 'ended')
              then '["coach"]'::jsonb else '[]'::jsonb end)
        ||
        (case when exists (select 1 from account ac
                           where ac.academy_id = a.id and ac.holder_person_id = p.id)
              then '["account_holder"]'::jsonb else '[]'::jsonb end)
        ||
        (case when exists (select 1 from player pl
                           where pl.academy_id = a.id and pl.person_id = p.id)
              then '["player"]'::jsonb else '[]'::jsonb end)
        ||
        (case when c.state = 'prospect'
              then '["prospect"]'::jsonb else '[]'::jsonb end)
        ||
        -- 0039. Not derived from the contact but from the academy it sits in: this
        -- person has not said whether they want classes or run them, so no business
        -- owns them yet. The whole narrowed surface keys on this one word.
        (case when a.is_front_desk
              then '["visitor"]'::jsonb else '[]'::jsonb end),
      'coach_id', (
        select co.id from coach co
        where co.academy_id = a.id and co.person_id = p.id
        order by (co.status = 'ended'), co.created_at
        limit 1
      ),
      'account_ids', (
        select coalesce(jsonb_agg(ac.id order by ac.created_at), '[]'::jsonb)
        from account ac
        where ac.academy_id = a.id and ac.holder_person_id = p.id
      ),
      'player_ids', (
        select coalesce(jsonb_agg(pl.id order by pl.created_at), '[]'::jsonb)
        from player pl
        where pl.academy_id = a.id
          and (pl.person_id = p.id
               or pl.account_id in (select ac.id from account ac
                                    where ac.academy_id = a.id
                                      and ac.holder_person_id = p.id))
      ),
      'is_solo', app.is_solo(a.id),
      'sees_money', (
        exists (select 1 from academy_admin aa
                where aa.academy_id = a.id and aa.person_id = p.id)
        or exists (select 1 from account ac
                   where ac.academy_id = a.id and ac.holder_person_id = p.id)
      )
    )
    from contact c
    join person  p on p.id = c.person_id
    join academy a on a.id = c.academy_id
    where c.id = p_contact_id
  $$;

grant execute on function app.identity(uuid) to cm_service, cm_user, cm_readonly;

-- -----------------------------------------------------------------------------
-- 5 · app.inbound_candidates() — matching real tenants only
--
-- Replaces 0005_audit.sql:382. Two changes, and the first is the whole point of this
-- migration:
--
--   `acs` excludes front desks. A front-desk contact is a person who has not chosen
--   a side, so it must never be a `match` — otherwise the moment a visitor joins Ace
--   TT Academy they hold two contacts on this sender, `resolveInbound` sees two
--   matches, and every subsequent message from a converted prospect comes back
--   "several academies, ask which". Excluding the front desk makes the rule one
--   sentence: **a number that belongs to a real business resolves there; a number
--   that belongs to none goes to the front desk.**
--
--   `front_desk_id` is returned so the caller never has to make a second round trip
--   to find out where an unmatched number is about to be answered.
--
-- `academies` still lists every real tenant on the sender, because that is what the
-- name matcher reads. It is not a directory the model is handed: `find_business` in
-- lib/frontdesk/ matches server-side and answers with at most one name, so the front
-- desk cannot recite the customer list to a stranger.
-- -----------------------------------------------------------------------------
create or replace function app.inbound_candidates(
  p_from_phone   text,
  p_sender_phone text
) returns jsonb
  language sql stable security definer set search_path = public, pg_temp
  as $$
    with s as (
      select id, phone_e164 from sender
      where nullif(right(regexp_replace(phone_e164, '[^0-9]', '', 'g'), 10), '')
          = nullif(right(regexp_replace(coalesce(p_sender_phone, ''), '[^0-9]', '', 'g'), 10), '')
      limit 1
    ),
    acs as (
      select a.id, a.name from academy a
      where a.sender_id = (select id from s)
        and not a.is_front_desk
    )
    select jsonb_build_object(
      'sender_id', (select id from s),
      'front_desk_id', (
        select a.id from academy a
        where a.sender_id = (select id from s) and a.is_front_desk
      ),
      'matches', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'academy_id', ac.id, 'name', ac.name, 'contact_id', c.id
               ) order by c.created_at), '[]'::jsonb)
        from acs ac
        join contact c on c.academy_id = ac.id
         and nullif(right(regexp_replace(c.phone_e164, '[^0-9]', '', 'g'), 10), '')
           = nullif(right(regexp_replace(coalesce(p_from_phone, ''), '[^0-9]', '', 'g'), 10), '')
      ),
      'academies', (
        select coalesce(jsonb_agg(jsonb_build_object(
                 'academy_id', ac.id, 'name', ac.name
               ) order by ac.name), '[]'::jsonb)
        from acs ac
      )
    )
  $$;

grant execute on function app.inbound_candidates(text, text) to cm_service;

-- -----------------------------------------------------------------------------
-- 6 · app.front_desk_contact() — find or create the visitor, in one round trip
--
-- The insert half is what `createProspect` did, pointed at the front desk instead of
-- at a guessed tenant, and folded into SQL so that a concurrent second inbound from
-- the same stranger cannot produce two people. `on conflict do nothing` followed by a
-- re-read is the same race-losing shape `resolveInbound` already used; doing it here
-- means the caller gets a contact id either way and never has to decide which of two
-- persons is the real one.
--
-- The name falls back to the number, formatted by the caller — this function takes
-- whatever `full_name` it is handed, because §10.1's "name comes free" is about the
-- WhatsApp profile name and the formatting of a bare phone number is a display
-- concern that already lives in `lib/format.ts`.
-- -----------------------------------------------------------------------------
create or replace function app.front_desk_contact(
  p_sender_id    uuid,
  p_phone_e164   text,
  p_full_name    text,
  p_profile_name text,
  p_at           timestamptz
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_front_desk uuid;
    v_contact    uuid;
    v_person     uuid;
    v_created    boolean := false;
  begin
    v_front_desk := app.front_desk_for(p_sender_id);

    select c.id into v_contact
      from contact c
     where c.academy_id = v_front_desk
       and nullif(right(regexp_replace(c.phone_e164, '[^0-9]', '', 'g'), 10), '')
         = nullif(right(regexp_replace(coalesce(p_phone_e164, ''), '[^0-9]', '', 'g'), 10), '');

    if v_contact is null then
      insert into person (academy_id, full_name)
      values (v_front_desk, p_full_name)
      returning id into v_person;

      insert into contact (academy_id, person_id, phone_e164, profile_name, state,
                           last_inbound_at, role_hint)
      values (v_front_desk, v_person, p_phone_e164, nullif(p_profile_name, ''), 'prospect',
              p_at, 'visitor')
      on conflict (academy_id, phone_e164) do nothing
      returning id into v_contact;

      if v_contact is null then
        -- Lost the race. The other transaction's person is the one with a contact;
        -- ours has none and is unreachable, so it goes rather than lingering as a
        -- second person for the same human.
        delete from person where id = v_person;
        select c.id into v_contact from contact c
         where c.academy_id = v_front_desk and c.phone_e164 = p_phone_e164;
      else
        v_created := true;
      end if;
    else
      update contact
         set last_inbound_at = p_at,
             profile_name    = coalesce(nullif(p_profile_name, ''), profile_name)
       where id = v_contact;
    end if;

    return jsonb_build_object(
      'front_desk_id', v_front_desk,
      'contact_id',    v_contact,
      'created',       v_created
    );
  end;
  $$;

revoke all on function app.front_desk_contact(uuid, text, text, text, timestamptz) from public;
grant execute on function app.front_desk_contact(uuid, text, text, text, timestamptz) to cm_service;

-- -----------------------------------------------------------------------------
-- 6b · app.businesses_on_sender() — what the front desk may route to
--
-- SECURITY DEFINER for a reason that is easy to get wrong and silent when you do:
-- `academy_cm_service_all` (0003_rls.sql:88) is `using (id = app.academy_id())`, so
-- **cm_service is not a bypass** — a session pinned to the front desk can see the front
-- desk and nothing else. A plain `select ... from academy where sender_id = $1` written
-- from that session returns zero rows, with no error, and the desk would tell every
-- stranger that no business is set up on this number. Same trap 0030's header names for
-- `is_sandbox`: that policy keys on `id`, not on `academy_id`.
--
-- This is 0007_emulator.sql's pattern — a legitimate cross-tenant read through a named
-- door with the lights on, granted to cm_service only, rather than a hole in the
-- policies. The disclosure is the one `app.inbound_candidates` already makes: the names
-- of the businesses reachable on a number the caller is already messaging. Front desks
-- are excluded, so a desk can never route somebody to a desk.
-- -----------------------------------------------------------------------------
create or replace function app.businesses_on_sender(p_sender_id uuid)
returns table (id uuid, name text)
  language sql stable security definer set search_path = public, pg_temp
  as $$
    select a.id, a.name from academy a
     where a.sender_id = p_sender_id and not a.is_front_desk
     order by a.name
  $$;

revoke all on function app.businesses_on_sender(uuid) from public;
grant execute on function app.businesses_on_sender(uuid) to cm_service;

-- -----------------------------------------------------------------------------
-- 7 · app.found_business() — a stranger becomes a tenant
--
-- The one write in this product that creates a business, and the reason it is a
-- function rather than a plan: `academy` has no INSERT policy for any role
-- (0003_rls.sql:205 — "tenant creation is a platform operation"), and the write spans
-- two tenants at once. It creates the academy, the founder's person, their contact and
-- their `academy_admin` row, and settles the arrival — atomically, so a crash cannot
-- leave a business with no admin, which is a business nobody can ever reach.
--
-- WHAT IT DELIBERATELY DOES NOT DO
--   - It does not set `onboarding_state` past `'setup'`. §2.6 is intact: the new
--     business messages nobody until its owner says go, and until then send.ts gate 5
--     suppresses everything that is not addressed to the admin themself.
--   - It copies no classes, venues or defaults beyond the column defaults. §7.1's
--     ladder is a conversation, and pre-filling it would be the wizard §10.1 rejects.
--   - It does not touch the front-desk contact. That row stays exactly where it is,
--     holding the transcript of how this business arrived — which is the only copy of
--     that conversation, and now the oldest record the tenant has.
--
-- `p_academy_id` is generated by the caller rather than returned to it, because the
-- caller has to pin its session GUC to the new id to read any of this back:
-- `academy_cm_service_all` is `using (id = app.academy_id())`, so even a service
-- session sees nothing of a tenant it did not name, and the pin has to be chosen
-- before the id exists. SECURITY DEFINER carries the writes past RLS; the caller
-- carries the scope for everything it does afterwards.
-- -----------------------------------------------------------------------------
create or replace function app.found_business(
  p_academy_id   uuid,
  p_sender_id    uuid,
  p_name         text,
  p_category     text,
  p_founder_name text,
  p_phone_e164   text,
  p_profile_name text,
  p_arrival_id   uuid,
  p_at           timestamptz
) returns jsonb
  language plpgsql volatile security definer set search_path = public, pg_temp
  as $$
  declare
    v_person  uuid;
    v_contact uuid;
  begin
    insert into academy (id, name, category, sender_id, onboarding_state, is_front_desk)
    values (p_academy_id, p_name, nullif(p_category, ''), p_sender_id, 'setup', false);

    insert into person (academy_id, full_name)
    values (p_academy_id, p_founder_name)
    returning id into v_person;

    -- 'engaged', not 'registered': §11.2 promotes on first inbound, and the founder's
    -- first inbound is what created this row. Stamping `last_inbound_at` here is what
    -- keeps the 24h window open across the hand-over, so the very next reply — the one
    -- that starts the setup ladder — is a free in-window message rather than a
    -- template the new business has no approval for.
    insert into contact (academy_id, person_id, phone_e164, profile_name, state,
                         last_inbound_at, is_primary, role_hint)
    values (p_academy_id, v_person, p_phone_e164, nullif(p_profile_name, ''), 'engaged',
            p_at, true, 'admin')
    returning id into v_contact;

    insert into academy_admin (academy_id, person_id)
    values (p_academy_id, v_person);

    update arrival
       set outcome                = 'founded',
           decided_at             = p_at,
           destination_academy_id = p_academy_id
     where id = p_arrival_id;

    return jsonb_build_object(
      'academy_id', p_academy_id,
      'person_id',  v_person,
      'contact_id', v_contact
    );
  end;
  $$;

revoke all on function app.found_business(uuid, uuid, text, text, text, text, text, uuid, timestamptz) from public;
grant execute on function app.found_business(uuid, uuid, text, text, text, text, text, uuid, timestamptz) to cm_service;

-- -----------------------------------------------------------------------------
-- 8 · app.emulator_contacts() — one author for "what hats is this person wearing"
--
-- Replaces 0007_emulator.sql:33. The body is unchanged except for the roles column,
-- which had become the second author of a truth `app.identity` already owns — and it had
-- already drifted in the way ARCHITECTURE.md's trap list predicts: its four-way UNION
-- knows `admin`, `coach`, `player` and `account_holder` and has never known `prospect`,
-- so every cold-inbound contact in the console's tray has rendered with no roles at all.
--
-- Adding `visitor` to that UNION would have made it a *third* wrong copy — right for the
-- new state, still silent about the old one. So the column is now taken from
-- `app.identity(c.id)->'roles'`, and there is one definition of a person's hats for the
-- product, the tray and the turn record alike. Both functions are `security definer` and
-- `app.identity` is `stable`, so this is a per-row call over the handful of contacts a
-- console is already rendering, not a query the product runs.
--
-- `create or replace` is enough: the `returns table (...)` signature is byte-identical to
-- 0007's, which is the condition Postgres refuses to relax — and the grant/revoke pair at
-- 0007:73-76 survives, because only a DROP would discard it.
-- -----------------------------------------------------------------------------
create or replace function app.emulator_contacts()
returns table (
  contact_id uuid, academy_id uuid, academy_name text,
  person_id uuid, full_name text, phone_e164 text, wa_id text,
  state text, roles text[], coach_status text,
  last_inbound_at timestamptz, in_window boolean,
  unread int, last_message_at timestamptz
)
language sql
security definer
set search_path = public, pg_temp
as $$
  select
    c.id, c.academy_id, a.name,
    p.id, p.full_name, c.phone_e164, c.wa_id,
    c.state,
    coalesce(
      (select array_agg(r order by r)
         from jsonb_array_elements_text(app.identity(c.id) -> 'roles') as r),
      '{}'
    ),
    (select co.status from coach co where co.person_id = p.id and co.academy_id = c.academy_id limit 1),
    c.last_inbound_at,
    (c.last_inbound_at is not null and app.now() - c.last_inbound_at < interval '24 hours'),
    (select count(*)::int from message m
      where m.contact_id = c.id and m.direction = 'outbound' and m.read_at is null),
    (select max(m.queued_at) from message m where m.contact_id = c.id)
  from contact c
  join person p  on p.id = c.person_id
  join academy a on a.id = c.academy_id
  order by a.name, p.full_name
$$;

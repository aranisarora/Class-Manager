-- =============================================================================
-- 0038 — the month a coach worked is written down
--
-- Two unrelated repairs, both of the same shape: a fact the product needed was
-- being DERIVED from a mutable value at the moment somebody asked, instead of
-- being written down at the moment it became true.
--
-- -----------------------------------------------------------------------------
-- 1 · coach_ledger — what a coach earned, frozen when they earned it
-- -----------------------------------------------------------------------------
--
-- The owner typed "giving priya a raise, make it 10000/month from sept." The only
-- write available was `update coach set pay_amount = 10000`, because pay is one
-- number on one row with no date beside it (0002, coach.pay_amount / pay_unit).
-- That took effect everywhere and immediately, including for August, which had
-- not been settled. The product then said "August's over, so it reads from
-- September onward" — a sentence it had itself just made false.
--
-- THE ASYMMETRY WORTH UNDERSTANDING. Class and enrolment rates are undated too,
-- and families are safe anyway. Not because those rates are versioned — there is
-- no rate history anywhere in this schema — but because `monthly_lines` RESOLVES
-- the rate once and inserts an immutable `tally_line` stamped with `period`.
-- Raising a class rate today cannot change what August's invoice says, because
-- August's number was frozen into a row on 1 August.
--
-- There was no coach equivalent. No coach-side row, no coach statement job, and
-- so no August artifact to be wrong — there was no August artifact at all. Asked
-- in September what Priya was owed for August, the product computed it live from
-- whatever the single mutable number said at that moment.
--
-- WHY NOT A DATED RATE TABLE. It was the obvious fix and it is the wrong one.
-- "From September" is not a pay question — the same sentence can be said about a
-- class price, a sibling discount, a venue. Versioning every column that somebody
-- might future-date is unbounded. Freezing the money when it is earned is not,
-- and it is the pattern this schema has already proved. So `pay_amount` stays
-- exactly what it is: ONE number, the rate they are on NOW, and the default for
-- rows not yet written.
--
-- WHAT THIS BUYS, CONCRETELY. A closed month is a row and cannot be repriced. A
-- future-dated change is a row written early — "10,000 for September" can be
-- written in August, and the job that closes September finds it by `dedupe_key`
-- and leaves it alone. No scheduled job is needed for the monthly case at all.
--
-- `dedupe_key` is computed from IDS and never from a description, which is the
-- lesson `lib/billing-keys.ts` records at length: sixteen families were charged
-- twice, Rs 32,800 in total, because two writers composed "the same" description
-- with a hyphen and an em dash. Text that is shown to a person cannot also be the
-- thing two writers recognise each other by.
-- =============================================================================

create table if not exists coach_ledger (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default app.now(),
  academy_id  uuid not null references academy(id) on delete cascade,
  coach_id    uuid not null references coach(id),

  -- First day of the month this line belongs to. The same meaning as
  -- tally_line.period, so the two sides of the business read one calendar.
  period      date not null,

  kind        text not null
                check (kind in ('session', 'hourly', 'monthly', 'adjustment')),

  -- Shown verbatim to the coach. Carries no load: see dedupe_key below.
  description text not null,
  amount      numeric(10,2) not null,       -- negative for corrections

  -- THE POINT OF THE TABLE. The rate as it stood when this line was written,
  -- copied rather than referenced. `coach.pay_amount` may move afterwards and
  -- this row does not.
  rate_amount numeric(10,2),
  rate_unit   text check (rate_unit in ('per_session', 'per_hour', 'per_month')),

  -- Only set on a per-session or per-hour line, so a month can be read back
  -- session by session rather than only as a total.
  session_id  uuid references session(id),

  -- What "the same line" MEANS, in ids.
  dedupe_key  text not null,

  reason      text,                          -- adjustments only
  approved_by uuid references person(id)     -- adjustments only
);

create unique index if not exists coach_ledger_dedupe_key
  on coach_ledger (academy_id, dedupe_key);
create index if not exists coach_ledger_coach_period_idx
  on coach_ledger (coach_id, period);

comment on table coach_ledger is
  'What a coach earned, one line at a time, with the rate frozen into the row. '
  'The record for a CLOSED month; coach_pay answers the live question for the '
  'month in progress. Written by the coach_month_lines job when a month closes, '
  'or early when a future-dated rate is agreed. Never edited: a correction is an '
  'adjustment line, the way tally_line does it.';

comment on column coach_ledger.rate_amount is
  'The rate that applied when this line was written, copied from coach.pay_amount. '
  'This column is the whole reason the table exists — coach.pay_amount is the rate '
  'they are on NOW and answers nothing about a month already closed.';

comment on column coach_ledger.dedupe_key is
  'Computed from ids, never from description. See lib/billing-keys.ts: a '
  'description-keyed guard double-charged sixteen families when a class was '
  'renamed.';

alter table coach_ledger alter column academy_id set default app.academy_id();
alter table coach_ledger enable row level security;

drop trigger if exists coach_ledger_snapshot on coach_ledger;
create trigger coach_ledger_snapshot after insert or update or delete on coach_ledger
  for each row execute function app.snapshot_row();

drop policy if exists coach_ledger_cm_service_all on coach_ledger;
create policy coach_ledger_cm_service_all on coach_ledger
  for all to cm_service
  using (academy_id = app.academy_id())
  with check (academy_id = app.academy_id());

-- A coach reads their own lines and no other coach's — the same boundary
-- `coach` itself draws (0003: own row INCLUDING own pay_amount), and the reason
-- coach_pay is security_invoker. The admin reads all of it. A family has no
-- business here at all, which is why there is no third branch.
drop policy if exists coach_ledger_cm_user_select on coach_ledger;
create policy coach_ledger_cm_user_select on coach_ledger
  for select to cm_user, cm_readonly
  using (
    academy_id = (select app.academy_id())
    and ((select app.is_admin()) or coach_id = (select app.my_coach_id()))
  );

-- Writes are the admin's. A coach who could write this could pay themselves, and
-- the runtime writes it as cm_service either way.
drop policy if exists coach_ledger_cm_user_insert on coach_ledger;
create policy coach_ledger_cm_user_insert on coach_ledger
  for insert to cm_user
  with check (academy_id = app.academy_id() and app.is_admin());

drop policy if exists coach_ledger_cm_user_update on coach_ledger;
create policy coach_ledger_cm_user_update on coach_ledger
  for update to cm_user
  using (academy_id = app.academy_id() and app.is_admin());

grant select, insert, update, delete on coach_ledger to cm_service, cm_user;
grant select on coach_ledger to cm_readonly;

-- -----------------------------------------------------------------------------
-- 2 · the questions people answered, marked as answered
-- -----------------------------------------------------------------------------
--
-- `consumeAction` recorded the tap and, in the same statement, marked the
-- question it answered as resolved. The claim runs under the TAPPER — that is
-- what stops one person answering another person's question — and this table has
-- no cm_user write policy, deliberately (0032: "A person who could write it could
-- forge an answer to a question about somebody else"). So the second half of that
-- statement matched zero rows, silently, for the life of the table, and nothing
-- read the row count it asked for.
--
-- `lib/actions.ts` now writes it as the runtime, in a second statement, and says
-- so out loud when it cannot. This is the backfill for everything tapped before
-- that: a question whose message carries a CONSUMED action was answered, whatever
-- the row says.
--
-- Same gate the sibling invalidation uses. `reply`, `view` and `menu` decide
-- nothing — a confirmation card carrying its own [Show me all 12] must not have
-- silenced its own question — so only the four deciding kinds count as an answer.
--
-- Not merely cosmetic. The variable tail renders every open row as ASKED AND
-- UNANSWERED, asserting "they have NOT answered", "nothing behind it has
-- happened" and "never describe it as done" with instruction force; and since
-- 0035 gave these rows an expiry, the sweep resolves them as `expired` and opens
-- a turn chasing somebody about work that already happened.
-- -----------------------------------------------------------------------------

update pending_request pr
   set resolved_at = coalesce(
         (select max(a.consumed_at) from action a
           where a.message_id = pr.message_id
             and a.consumed_at is not null),
         app.now()),
       resolution = 'tapped'
 where pr.resolved_at is null
   and exists (
     select 1 from action a
      where a.message_id = pr.message_id
        and a.consumed_at is not null
        and a.payload ->> 'kind' in ('operation', 'steps', 'noop', 'handoff')
   );

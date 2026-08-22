-- =============================================================================
-- 0045_every_turn_is_written_down_completely.sql — the whole turn, kept where
-- nothing on the hot path has to read it.
--
-- Production already records every turn. `writeTurn` (lib/agent/loop.ts) runs
-- OUTSIDE the error path, so a turn that threw is still a turn that is written,
-- and `turn` carries the input, the output, the model, the three token counts,
-- the latency, the error, the round count and `tool_calls`. What it does not
-- carry is the inside of any of it:
--
--   * every value in `tool_calls` is clipped at 4,000 characters, and the
--     model's reasoning at 24,000, unless a harness is holding a capture open
--   * the `(context)` round — WHAT THE MODEL WAS TOLD — is written only under
--     `fullTraceOn()`, so in production it does not exist at all
--   * `captureSql`'s sink is null in production, so the statements the model
--     itself authored are recorded nowhere, and the writes inside a plan never
--     reach the tool trace even in a drive
--
-- The complete record therefore exists only in `.probe/runs/` on a developer's
-- machine. ARCHITECTURE.md, Layer 5: "the eval is part of the architecture, and
-- it must be able to see inside a turn ... Nothing in the harness knows anything
-- the product does not record." Today the harness knows a great deal the product
-- does not record, and production is the surface where the product acts
-- unsupervised.
--
-- The cost of that gap is already on the record. loop.ts:1275-1285: three turns
-- of the first live week were handed "their coach record could not be read this
-- turn" with the cause withheld; the model reached for the only cause its prompt
-- offered and told a coach his own pay was not visible. Five judges reviewed
-- those turns with what they called complete visibility and none could see the
-- sentence, because the sentence was never written down.
--
-- WHY A SECOND TABLE AND NOT A WIDER turn.tool_calls
-- ---------------------------------------------------------------------------
-- `recentToolTurns` (lib/agent/loop.ts) selects the whole `tool_calls` column
-- for the four most recent turns of the contact ON EVERY TURN, to build the
-- context tail. It is the hot path, it is forever, and it is the one column that
-- must not grow. So the cap on `turn.tool_calls` stays exactly where it is —
-- byte-identical to what it holds today — and the uncapped copy goes here, in a
-- table nothing under `lib/agent/` reads.
--
-- The thin, indexed line an analysis filters and aggregates on already exists:
-- it is the `turn` row. This table holds only what is IRRECOVERABLE — the trace,
-- the context tail, the SQL — and joins to it by primary key.
--
-- WHAT IT DELIBERATELY DOES NOT COPY
-- ---------------------------------------------------------------------------
-- Messages, audit entries and row snapshots are NOT folded into the payload.
-- They are already rows, all reachable from this turn's id (`message.turn_id`
-- 0019, `audit_entry.turn_id` 0015, `row_snapshot.audit_id` 0005), and copying
-- them would be this file becoming a second author of state it does not own.
--
-- It is also the more truthful shape, for one specific reason: `delivered_at`
-- and `read_at` arrive by webhook MINUTES after the turn ends. A frozen copy
-- would say "sent" forever, about a message that failed. The join reports what
-- actually happened.
--
-- RETENTION, STATED RATHER THAN ASSUMED
-- ---------------------------------------------------------------------------
-- This is the most personal artefact the product creates: the context tail
-- carries children's names, their attendance, a coach's notes on their progress
-- and their parents' numbers, and the model's reasoning about all of it.
-- product-spec.md §21.5 flags children's data as an open DPDP question whose
-- answer "shapes onboarding consent, retention, what a coach's note may say, and
-- what leaves the country", and says to get advice before tenant #2.
--
-- So both foreign keys cascade — deleting an academy or a turn deletes its
-- record, with no code to remember — and the index below makes an age-based
-- delete cheap. Nothing purges on a timer: that is a decision to take
-- deliberately, not a default to inherit. When it is taken, this is it:
--
--   delete from turn_record
--    where academy_id = $1 and at < app.now() - interval '90 days';
--
-- Re-runnable.
-- =============================================================================

create table if not exists turn_record (
  -- The turn's own id IS the key. One record per turn, and it cannot outlive it.
  turn_id    uuid primary key references turn(id) on delete cascade,
  academy_id uuid not null references academy(id) on delete cascade,

  -- The tenant clock, matching `turn.created_at` (0027), so a join of the two
  -- cannot disagree about when the turn happened. A driven world stamps these
  -- ahead of wall time; its academy is dropped wholesale by `sim gc`, so the
  -- retention statement above never has to reason about it.
  at         timestamptz not null default app.now(),

  -- Size of `record`, so growth is a query rather than a table scan.
  bytes      int,

  record     jsonb not null
);

create index if not exists turn_record_academy_at_idx on turn_record (academy_id, at);

alter table turn_record alter column academy_id set default app.academy_id();

comment on table turn_record is
  'The complete inside of one turn: what the model was told, every round it ran '
  'with its reasoning uncapped, and every statement it authored. Written beside '
  'the turn row, never inside it - turn.tool_calls is read back on the hot path '
  'of every turn and must not grow. Nothing under lib/agent/ reads this table.';

comment on column turn_record.record is
  'v1: { v, context: {prefix:{chars,head}, tail, said, history}, trace: ToolTrace[], '
  'sql: SqlRecord[] }. The prefix is stored by fingerprint and not in full: it is '
  'byte-identical on every turn by construction - that property IS the cache - so '
  'storing it per turn would store one document thousands of times and bury the '
  'variable half. Messages, audit entries and row snapshots are joined from their '
  'own tables by turn_id, never copied.';

-- ---------------------------------------------------------------------------
-- Permission. The same hard deny `turn` itself carries (0003:193-196).
--
-- There is no cm_user or cm_readonly policy, and that is the point twice over.
-- The record holds other people's data — a whole turn's context tail — so it is
-- not any one person's to read. And a model that could read its own trace would
-- be able to validate a claim against evidence its own turn produced, which is
-- ARCHITECTURE.md's "circular evidence" trap by construction.
--
-- The grant only decides which verbs exist; RLS denies every row regardless.
-- 0002's blanket grant ran before this table existed and `alter default
-- privileges` in 0006 names only cm_service and cm_user, so cm_readonly is
-- granted explicitly, exactly as `arrival` does (0039:228-231).
-- ---------------------------------------------------------------------------

alter table turn_record enable row level security;

drop policy if exists turn_record_cm_service_all on turn_record;
create policy turn_record_cm_service_all on turn_record
  for all to cm_service
  using (academy_id = app.academy_id())
  with check (academy_id = app.academy_id());

grant select, insert, update, delete on turn_record to cm_service, cm_user;
grant select on turn_record to cm_readonly;

-- NO `snapshot_row` trigger, deliberately. 0005:143-148 excludes the
-- infrastructure tables — message, action, job, turn, memory_fact — from the
-- audit triggers, and this is one of them. Auditing it would write every turn's
-- complete record a second time into `row_snapshot`, which is a table the model
-- CAN read. That is not a smaller version of this problem; it is the same data
-- through a door that is open.

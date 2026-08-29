-- A deliberate move is remembered, so the re-derivers stop un-doing it.
--
-- Three mechanisms re-derive state from the world, and all three treated
-- "current existence" as the only truth:
--
--   1. `job.dedupe_key` is TOTALLY unique (0002:360) — across every status. A
--      cancelled or done row absorbs every later enqueue of the same key
--      forever. `kinds.ts` knew this for redeliver and dunning ("a finished
--      attempt 1 would otherwise absorb attempt 2") and keyed them with an
--      attempt counter; the session ladder's keys carry no generation at all.
--      So `reschedule_session` sweeps a session's ladder (cancelled rows KEEP
--      their keys), the planner re-derives the identical keys for the new time,
--      and `on conflict do nothing` writes zero rows, silently: a session moved
--      after its ladder was planned — every same-day move — permanently loses
--      the coach ask, the family reminder, the register ask and the register
--      expiry. No register ask, no attendance, no per-session billing. The
--      CL-SESSION-MOVED card's own button says "Noted — I'll remind you before
--      it" at the exact moment that promise stops being keepable. F-FI.
--
--   2. The materializer's orphan sweep deletes any scheduled, future, in-horizon
--      session whose `starts_at` matches no slot-derived time. A one-off move
--      (`reschedule_session` updates `starts_at` in place; the slot stands) has
--      no marker, so the next daily pass DELETES the moved session and re-creates
--      the original slot time with a fresh id — the family is told "moved to
--      Wednesday", and overnight the world quietly reverts to Tuesday. F-FJ.
--
--   3. 0033's triggers enqueue `materialize:<class>:<local-day>` — the SAME key
--      the planner's daily pass uses. Once that key is done for the day, every
--      trigger fire until midnight is absorbed by the done row: a slot written
--      at 17:20 has no sessions until the overnight beat, which is F-EN exactly
--      ("a slot written in the evening has no sessions until the overnight
--      beat"). The mechanism shipped on 17 Aug and its same-day refire path was
--      dead on arrival, by key design.
--
-- One class, one fix: give each re-deriver one bit of memory.
--
--   * `session.rescheduled_n` — bumped by every deliberate in-place retime
--     (reschedule_session, move_class). Ladder dedupe keys carry `r<n>` when
--     n > 0, so a moved session's ladder re-enqueues under fresh keys while
--     rule 1's idempotency (same moment, same key, no-op) is untouched for the
--     unmoved 99%. Legacy keys (n = 0) are byte-identical to before, so nothing
--     re-fires on deploy day.
--
--   * `session.origin_starts_at` — the slot-derived time this occurrence was
--     deliberately moved OFF, stamped once by reschedule_session. The orphan
--     sweep never deletes a row with `rescheduled_n > 0`, and the create pass
--     treats a claimed origin as occupied, so the vacated Tuesday is not
--     re-manufactured beside the moved Wednesday.
--
--   * The 0033 triggers key on the transaction (`txid_current()`) instead of the
--     local day: a four-slot insert in one statement still collapses to one job,
--     and a 17:20 edit materializes on the next beat instead of tomorrow. The
--     planner's daily key is untouched — it remains the horizon-extender.
--
-- `session_coach`'s missing tombstone (F-BL) is the SAME class and is
-- deliberately NOT touched here: ~30 readers, 6 of them RLS, and DECIDED.md
-- holds the reasoning. This migration adds memory only where no reader has to
-- change meaning: two nullable-shaped columns nothing selects yet, and a job
-- key format that only ever appears for sessions a human moved.
--
-- Re-runnable.

alter table session add column if not exists rescheduled_n int not null default 0;
alter table session add column if not exists origin_starts_at timestamptz;

comment on column session.rescheduled_n is
  'How many times a human deliberately retimed this session in place. Ladder '
  'dedupe keys carry r<n> when > 0, so a moved session''s jobs re-enqueue past '
  'the cancelled rows of the old time (job.dedupe_key is unique across every '
  'status, so a swept ladder otherwise absorbs its own replacement forever).';

comment on column session.origin_starts_at is
  'The slot-derived time this occurrence was deliberately moved off (stamped '
  'once, by the first reschedule). The materializer treats it as occupied so '
  'the vacated time is not re-created, and never sweeps a rescheduled row.';

-- ---------------------------------------------------------------------------
-- 0033's triggers, re-keyed on the transaction. Same function names, same
-- trigger wiring; only the dedupe key changes. `txid_current()` is stable for
-- the length of the transaction, so a statement inserting four slots enqueues
-- one job, and two separate edits an hour apart enqueue two — which is the
-- whole point: "the world changed, re-derive" is a fact about the change, not
-- about the calendar date it happened to fall on.
--
-- @mechanism materialize_on_slot_change — a slot, class or coach change enqueues the
--   materialiser under a PER-TRANSACTION key (`materialize:<class>:tx<txid>`), because
--   the per-day key it shared with the planner's daily pass meant the trigger could
--   never fire twice in one local day: once the morning pass's row was done, every
--   evening edit's enqueue was absorbed by it (`job.dedupe_key` is unique across every
--   status), and a slot written at 17:20 had no sessions until the overnight beat — the
--   turns of that same evening fell into the gap, misleading one run and taxing another
--   ₹0.80 of investigation. A multi-slot statement still collapses to one job; the
--   handler stays idempotent on unique (class_id, starts_at). Closes F-EN
-- ---------------------------------------------------------------------------

create or replace function app.materialize_on_slot_change() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_class   uuid;
  v_academy uuid;
begin
  v_class   := coalesce(new.class_id, old.class_id);
  v_academy := coalesce(new.academy_id, old.academy_id);
  if v_class is null or v_academy is null then
    return coalesce(new, old);
  end if;

  perform app.enqueue_job(
    'materialize_sessions',
    app.now_for(v_academy),
    'materialize:' || v_class::text || ':tx' || txid_current()::text,
    jsonb_build_object('academy_id', v_academy, 'class_id', v_class)
  );
  return coalesce(new, old);
end
$$;

comment on function app.materialize_on_slot_change() is
  'A weekly slot implies dated sessions. This is what makes that true on every '
  'route rather than only inside create_class — including the model composing '
  'the INSERT itself. Keyed per transaction (not per day) so an evening edit '
  'materializes on the next beat instead of being absorbed by the morning '
  'pass''s done row until midnight (F-EN).';

create or replace function app.materialize_on_class_change() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and new.starts_on is not distinct from old.starts_on
     and new.ends_on   is not distinct from old.ends_on
     and new.active    is not distinct from old.active then
    return new;
  end if;
  perform app.enqueue_job(
    'materialize_sessions',
    app.now_for(new.academy_id),
    'materialize:' || new.id::text || ':tx' || txid_current()::text,
    jsonb_build_object('academy_id', new.academy_id, 'class_id', new.id)
  );
  return new;
end
$$;

-- Triggers themselves are unchanged (0033 created them; create or replace of
-- the functions is enough), but re-assert them so this file stands alone
-- against a database that somehow has the functions and not the wiring.

drop trigger if exists class_slot_materialize on class_slot;
create trigger class_slot_materialize
  after insert or update or delete on class_slot
  for each row execute function app.materialize_on_slot_change();

drop trigger if exists class_coach_materialize on class_coach;
create trigger class_coach_materialize
  after insert on class_coach
  for each row execute function app.materialize_on_slot_change();

drop trigger if exists class_materialize on class;
create trigger class_materialize
  after insert or update of starts_on, ends_on, active on class
  for each row execute function app.materialize_on_class_change();

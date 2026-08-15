-- The world lives on the tenant clock; its record now does too (F-N).
--
-- 0024 gave every tenant its own `app.now()`, and everything that COMPARES time
-- reads it — windows, caps, schedules, policies. But everything that RECORDS
-- time still defaulted to bare `now()`: `message.created_at`, `turn`,
-- `audit_entry`, `payment`, every event-log column the model queries. In a
-- driven world the tenant clock runs weeks ahead of the wall clock, so any
-- model-authored "what went out today?" — a tenant-date filter over a wall-time
-- column — returns a confident empty.
--
-- That is not a cosmetic gap; it manufactured the drive's worst self-inflicted
-- wound. Month drive T056–T057: the model sent two cancellation notices, then
-- next turn filtered messages by the tenant date, found nothing (the rows were
-- stamped nine wall-days earlier), and RETRACTED a true "the cancellations went
-- out" to the admin's face — a false claim caused entirely by the two clocks
-- disagreeing about what "today" means. The digest's delivery-health window
-- (`queued_at > app.now() - interval '24 hours'`) was corrupted the same way:
-- after any clock jump, every row looks ancient and the count reads zero.
--
-- The fix is the default, not the call sites: every timestamptz column that
-- defaulted to `now()` on a tenant-scoped table now defaults to `app.now()`.
-- In production the offset is zero and the two are byte-identical — this
-- changes nothing there by construction. In a driven world, rows land on the
-- clock the queries already read.
--
-- What this relies on, stated plainly: `app.now()` is monotone only while the
-- sim clock moves FORWARD, which is the drive discipline (DRIVING.md; the
-- month-drive journal's "≤12h steps, tick between"). `drive clock --reset` or
-- a negative advance mid-drive would let older rows carry later stamps — the
-- same corruption this migration removes, in the other direction. A reset
-- belongs with a world wipe, where there are no rows to disorder.
--
-- `sender` and `sim_clock` are exempt: global infrastructure with no tenant,
-- where wall time is the honest stamp.
--
-- `job` is deliberately NOT exempt, with one consequence named: its inserts run
-- under infra sessions with no tenant GUC, so its stamps follow the WORLD
-- clock. In a single-world drive (the norm) that is the same clock every
-- tenant-stamped row follows, and the probe's per-turn job checks depend on it.
-- In a world using PER-ACADEMY clock offsets (0024, opt-in, parallel driving),
-- job stamps and that tenant's message/turn stamps diverge, and the emulator's
-- single-cursor event stream can order across them oddly — a known limit of
-- multi-clock worlds, accepted here because the alternative (wall-time jobs)
-- breaks the single-world case the product is actually evaluated in.

do $$
declare
  r record;
begin
  for r in
    select c.table_name, c.column_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = 'public'
       and t.table_type = 'BASE TABLE'
       and c.data_type = 'timestamp with time zone'
       and c.column_default in ('now()', 'CURRENT_TIMESTAMP', 'current_timestamp')
       and c.table_name not in ('sender', 'sim_clock')
  loop
    execute format('alter table %I alter column %I set default app.now()', r.table_name, r.column_name);
  end loop;
end $$;

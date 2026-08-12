-- =============================================================================
-- 0010 · Visibility
--
-- A turn recorded only its final sentence, so the two most common failures were
-- undiagnosable from data: a wrong answer (what did it read?) and a silent one
-- (what threw?). Three columns close that.
--
--   turn.tool_calls  — every call the model made, in order, with the SQL it ran,
--                      how long it took and what came back. This is the record
--                      that makes "why did it say that" answerable.
--   turn.rounds      — how many model round-trips the turn burned. A turn that
--                      spends 8 rounds and answers nothing looks identical to a
--                      1-round answer without this.
--   message.solicited — whether the frequency cap treated this message as an
--                      answer or an interruption. Suppression was previously
--                      undiagnosable: the reason said "cap" without saying why
--                      the exemption did not apply.
-- =============================================================================

alter table turn add column if not exists tool_calls jsonb not null default '[]'::jsonb;
alter table turn add column if not exists rounds     int;

alter table message add column if not exists solicited boolean not null default false;

-- Reading a turn back is always "the last N for this contact, newest first".
create index if not exists turn_contact_created_idx on turn (contact_id, created_at desc);

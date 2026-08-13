-- 0015_audit_turn.sql
--
-- **Make the product's most dangerous failure countable.**
--
-- FINDINGS' axis 1 is Truth — "did it actually do what it said?" — and calls it the
-- most important one, "because the failure is silent and reads as success". Twice the
-- bot said "I've added those families": once nothing had run, once it had run twice,
-- and a person cannot tell either apart from the reply.
--
-- The check is one join away and could not be written, because a write and the turn
-- that caused it had nothing in common. `audit_entry` knew the intent, the plan and
-- the diff; `turn` knew what was said. Nothing connected them, so "for every reply
-- claiming a completed action, an audit entry with a non-empty diff from that turn"
-- was an eyeball exercise against `drive world` rather than a query. That is R6 — what
-- the product records is narrower than what it changes — applied to the record itself.
--
-- **Carried as a GUC rather than a parameter, on purpose.** A write reaches
-- `begin_audit` from four different places: a model tool call, a button tap, a job, and
-- a self-scheduled task. Threading an argument through each is four call sites to keep
-- right and four chances to forget, and the one that forgets is invisible — it just
-- writes a null. `app.turn_id` is set once by `applySession`, next to the tenant and
-- the actor it already sets, so every path that can write at all carries it by
-- construction. Nothing has to remember.
--
-- Nullable, because it honestly is: a migration, a seed or a repair script writes rows
-- that belong to no turn, and a null there is the truth rather than a gap.

alter table audit_entry
  add column if not exists turn_id uuid;

comment on column audit_entry.turn_id is
  'The turn that caused this write, when there was one. Null for seeds, migrations and '
  'anything the runtime did outside a conversation. Set from the app.turn_id GUC by '
  'app.begin_audit, never passed by a caller.';

-- Axis 1 is "every claim, backed" — a per-turn lookup — so the index matches the query.
create index if not exists audit_entry_turn_idx
  on audit_entry (turn_id)
  where turn_id is not null;

-- -----------------------------------------------------------------------------
-- begin_audit now stamps the turn.
--
-- Same signature: every existing caller keeps working and gains attribution without
-- being edited, which is the whole reason this is a GUC. `current_setting(..., true)`
-- returns null when unset rather than raising, so a write outside a turn is still a
-- legal write.
-- -----------------------------------------------------------------------------

create or replace function app.begin_audit(
  p_academy_id uuid,
  p_actor      uuid,
  p_intent     text,
  p_plan       jsonb
) returns uuid
  language plpgsql security definer set search_path = public, pg_temp
  as $$
  declare
    v_id   uuid;
    v_turn uuid;
  begin
    if p_academy_id is null then
      raise exception 'begin_audit requires an academy_id';
    end if;
    if app.academy_id() is not null and app.academy_id() <> p_academy_id then
      raise exception 'begin_audit: academy_id % does not match the session tenant %',
        p_academy_id, app.academy_id();
    end if;

    -- Malformed or absent is null, never an error: instrumentation may not be the
    -- reason a write fails.
    begin
      v_turn := nullif(current_setting('app.turn_id', true), '')::uuid;
    exception when others then
      v_turn := null;
    end;

    insert into audit_entry (academy_id, actor_person_id, intent, plan, turn_id)
    values (p_academy_id, p_actor, p_intent, p_plan, v_turn)
    returning id into v_id;

    perform set_config('app.audit_id', v_id::text, true);
    return v_id;
  end
  $$;

grant execute on function app.begin_audit(uuid, uuid, text, jsonb)
  to cm_service, cm_user;

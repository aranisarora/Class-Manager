-- =============================================================================
-- 0013 · The academy row is a row too
--
-- §2.3 is an invariant: "Compute the effect before committing it. Model-authored
-- writes run inside a transaction whose affected rows are captured and shown
-- before commit. The bot never estimates blast radius — it knows."
--
-- It did not know about `academy`. Sixteen tables carry the snapshot trigger and
-- that one never did, so every business-wide setting was invisible to the diff:
-- the UPI handle money is paid into, the cancellation window that decides
-- whether a late cancel is charged, the brief and digest times, the academy's
-- own memory, and `onboarding_state` — the switch that decides whether anything
-- at all is allowed to reach a parent.
--
-- Three consequences, all of them silent:
--
--   1. The preview showed nothing. Watched happening: a plan that set the UPI
--      handle AND created a venue read back as *"That'll add 1 venue"*. The
--      handle every parent's money goes to changed inside a change nobody was
--      shown.
--   2. Any rule keyed on the diff could not see it — including the one that
--      exists to make settings and credentials always read back first.
--   3. **Undo could not reverse it.** `undo` is built from `row_snapshot`, so a
--      wrong UPI handle, or going live by accident, had no inverse.
--
-- The trigger function itself needed one change: it derives the tenant from
-- `academy_id`, and on this table that column is called `id`.
-- =============================================================================

create or replace function app.snapshot_row() returns trigger
  language plpgsql security definer set search_path = public, pg_temp
  as $$
  declare
    v_audit   uuid;
    v_before  jsonb;
    v_after   jsonb;
    v_pk      uuid;
    v_academy uuid;
  begin
    v_audit := nullif(current_setting('app.audit_id', true), '')::uuid;

    if v_audit is null then
      if tg_op = 'DELETE' then return old; else return new; end if;
    end if;

    if tg_op = 'INSERT' then
      v_after := to_jsonb(new);
    elsif tg_op = 'UPDATE' then
      v_before := to_jsonb(old);
      v_after  := to_jsonb(new);
    else
      v_before := to_jsonb(old);
    end if;

    v_pk      := nullif(coalesce(v_after ->> 'id', v_before ->> 'id'), '')::uuid;
    v_academy := nullif(coalesce(v_after ->> 'academy_id',
                                 v_before ->> 'academy_id'), '')::uuid;

    -- The tenant table names its own key `id`. Without this the snapshot lands
    -- with a null academy_id and is invisible to every per-tenant read of it.
    if v_academy is null and tg_table_name = 'academy' then
      v_academy := v_pk;
    end if;

    insert into row_snapshot (audit_id, academy_id, table_name, pk, op, before, after)
    values (v_audit, v_academy, tg_table_name, v_pk, lower(tg_op), v_before, v_after);

    if tg_op = 'DELETE' then return old; else return new; end if;
  end
  $$;

grant execute on function app.snapshot_row() to cm_service, cm_user, cm_readonly;

-- Update only. A tenant is created by the signup path, not by a plan, and there
-- is no undo that should be able to delete a business.
drop trigger if exists academy_snapshot on academy;
create trigger academy_snapshot after update on academy
  for each row execute function app.snapshot_row();

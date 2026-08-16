-- =============================================================================
-- 0031_wa_message_tenant.sql — resolving a tenant from a wire id, for real.
--
-- Meta's delivery and read receipts arrive carrying a `wamid`, a display phone
-- number, and nothing else. Every `message` policy is pinned to
-- `app.academy_id()` (0003), so there is no ordinary read that can answer "which
-- academy owns this wamid" without already knowing the answer.
--
-- `markStatus` (lib/messaging/send.ts) covered that with `waIndex`, an in-process
-- Map the send path fills in as it sends. On one long-lived server that is a
-- complete answer: the process that sent the message is the process that later
-- hears about it. On Vercel it is almost never the same instance, so the map is
-- empty and every status receipt threw:
--
--     cannot resolve the tenant for wamid.HBgMOTE4OTA0NTA2Njcw…:
--     message RLS is pinned to app.academy_id().
--
-- Which is exactly what production did: two `wh:st:…:read` jobs failing from
-- 11:19 on 16 Aug 2026 onward, inbound working the whole time, and §16.3's
-- quality proxies — the numbers that tell an operator whether messages are
-- actually landing — silently never advancing past `sent`.
--
-- WHY A FUNCTION AND NOT A POLICY CHANGE. The alternative is loosening the
-- `message` policy so some role can read across tenants, which would widen every
-- query in the product to buy one lookup. A `security definer` function is the
-- narrow version of the same permission: it answers exactly one question, about
-- one row, returning one uuid and no message content. `app.list_academies()`
-- (0007) is the existing precedent for this shape and this is written to match
-- it — `security definer`, a pinned `search_path`, revoked from public and
-- granted only to `cm_service`.
--
-- `limit 1` is not defensive padding: `message.wa_message_id` carries no unique
-- constraint, and a wamid is Meta's identifier rather than ours. Two rows would
-- both belong to the same academy anyway, so the first is the right answer.
--
-- Re-runnable (`create or replace`).
-- =============================================================================

create or replace function app.academy_for_wa_message(p_wa_message_id text)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.academy_id
    from message m
   where m.wa_message_id = p_wa_message_id
   limit 1
$$;

comment on function app.academy_for_wa_message(text) is
  'Which academy owns a Meta wamid. security definer because message RLS is pinned to '
  'app.academy_id() and a status webhook carries no tenant. Returns null when unknown.';

revoke all     on function app.academy_for_wa_message(text) from public;
grant  execute on function app.academy_for_wa_message(text) to cm_service;

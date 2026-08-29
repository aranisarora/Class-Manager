-- §16.3's per-tenant quality proxies get a reader (the measurement half of F-EE).
--
-- §16.1 calls a quality drop on the shared number "the largest single business
-- risk in the product": one badly-run academy takes every tenant on the sender
-- dark at once. §16.3's stated guardrail — delivery failures, read rate,
-- response rate, opt-outs, bucketed by academy — existed as three code comments
-- referring to it as a thing that exists. Nothing computed one. The send-path
-- half (`silenceBackoff`) shipped earlier; this is the roll-up: one row per
-- academy, trailing seven days on the ACADEMY'S OWN clock (`app.now_for`),
-- because a simulated tenant held at another date must be measured at its own
-- date or the window measures nothing.
--
-- What it deliberately is NOT: a gate. It computes; a person (or a scheduled
-- reader, later) decides. §16.1's stated mitigation is "move a tenant to their
-- own number in a config change" — `academy.sender_id` already makes that a
-- config change; this view is the signal that would tell anybody to make it.
-- The policy half of F-EE (what NUMBER of unanswered sends means "shouting")
-- stays open — that is a per-sender setting to be argued from a real quality
-- rating, not guessed from a simulated month.
--
-- security_invoker = false and service-only grants: the grid this answers is
-- the OPERATOR'S (whose tenant is burning the shared number), and one tenant
-- must not read another's engagement. `node scripts/q.mjs` is the intended
-- reader today.
--
-- Re-runnable.

create or replace view app.tenant_quality_proxies
with (security_invoker = false) as
select
  a.id   as academy_id,
  a.name as academy_name,
  count(m.id) filter (where m.direction = 'outbound'
                        and m.status not in ('suppressed'))            as sent_7d,
  count(m.id) filter (where m.direction = 'outbound'
                        and m.status = 'failed')                       as failed_7d,
  count(m.id) filter (where m.direction = 'outbound'
                        and m.read_at is not null)                     as read_7d,
  count(m.id) filter (where m.direction = 'inbound')                   as inbound_7d,
  count(distinct m.contact_id) filter (where m.direction = 'outbound'
                        and m.status not in ('suppressed'))            as contacts_messaged_7d,
  count(distinct m.contact_id) filter (where m.direction = 'inbound')  as contacts_replied_7d,
  (select count(*) from contact c
    where c.academy_id = a.id
      and c.opted_out_at >= app.now_for(a.id) - interval '7 days')     as opt_outs_7d
from academy a
left join message m
  on m.academy_id = a.id
 and m.created_at >= app.now_for(a.id) - interval '7 days'
group by a.id, a.name;

comment on view app.tenant_quality_proxies is
  'One row per academy, trailing 7 days on that academy''s own clock: sends, '
  'failures, reads, inbound, distinct contacts messaged vs replied, opt-outs. '
  'The §16.3 signal for "which tenant is burning the shared number" — read it '
  'as the service role (scripts/q.mjs); it is not tenant-readable by design.';

revoke all on app.tenant_quality_proxies from public;
do $$ begin
  execute 'revoke all on app.tenant_quality_proxies from cm_user';
  execute 'revoke all on app.tenant_quality_proxies from cm_readonly';
exception when undefined_object then null; end $$;
grant select on app.tenant_quality_proxies to cm_service;

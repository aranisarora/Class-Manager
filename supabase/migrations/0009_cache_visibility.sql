-- 0009_cache_visibility.sql
--
-- §4.4 — the stable prefix exists so that implicit caching can pay for it. Doctrine, the
-- schema doc, nine behavior modules, the operation signatures and the message catalog ride
-- every single model call; at ~50k tokens that prefix IS the input bill. Cached input is
-- billed at a quarter of the rate, so whether the prefix is byte-identical between calls is
-- the difference between ~2.3p and ~1.2p a turn.
--
-- The client already reads `cachedContentTokenCount` off every response and the event log
-- already has a slot to render it — but nothing in between persisted it, so the one number
-- that says whether the layering is doing its job was unobservable. A drifting prefix could
-- quadruple the input cost silently and forever.
--
-- `not null default 0` rather than nullable: a turn that made no model call cached nothing,
-- which is 0, not unknown.

alter table turn add column if not exists cached_tokens integer not null default 0;

comment on column turn.cached_tokens is
  'Prompt tokens served from the implicit context cache (§4.4). A subset of prompt_tokens, '
  'summed across every model call the turn made. 0 on a turn that made none.';

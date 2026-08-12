-- =============================================================================
-- 0011 · Drop sim_run
--
-- The simulator kept its own copy of the truth: a transcript table, a judge
-- report, a persona registry and a goal registry, alongside `message`, `turn`
-- and `audit_entry` — which already record every word sent, every tool call and
-- every write, for real conversations as well as test ones.
--
-- Testing moves outside the process: a driver posts to the same emulator API a
-- human uses, as an admin, a coach, a client and an unknown number, and reads
-- the ordinary tables back. What could NOT move outside stays: `sim_clock` and
-- `sim_fault` are runtime capabilities — time travel and injected failure — not
-- test scaffolding, and nothing outside the process can fake them.
-- =============================================================================

-- Dropping the table takes its policies with it, and `drop policy if exists` on a
-- table that is already gone is an error rather than a no-op — so this file has to
-- be the table alone to stay re-runnable.
drop table if exists sim_run;

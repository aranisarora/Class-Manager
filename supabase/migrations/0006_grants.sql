-- 0006_grants.sql
--
-- Wires the *login* role to the three *RLS* roles.
--
-- The application connects as `cm_runtime`, which deliberately owns nothing and has no
-- table privileges of its own: on its own it cannot read or write a single row. Every
-- query in the product runs inside a transaction that first `SET LOCAL ROLE`s to one of
-- cm_service / cm_user / cm_readonly and sets the `app.*` GUCs the policies read.
--
-- That is invariant §2.1 made mechanical rather than remembered — "RLS is the security
-- boundary; the LLM is a user of it". There is no code path that touches a row without
-- first declaring who it is acting as.
--
-- Schema objects are owned by `cm_migrator` (the migration login, used only by
-- scripts/db-push.ts). Nothing connects as cm_migrator at runtime, so the fact that a
-- table owner bypasses RLS never becomes reachable from the application.

grant cm_service, cm_user, cm_readonly to cm_runtime;

grant usage on schema public to cm_runtime;
grant usage on schema app    to cm_runtime;

-- Belt and braces: make sure anything added by a later migration is reachable by the
-- three RLS roles without another grant pass.
alter default privileges in schema public
  grant select, insert, update, delete on tables to cm_service, cm_user;
alter default privileges in schema public
  grant select on tables to cm_readonly;
alter default privileges in schema public
  grant usage, select on sequences to cm_service, cm_user;
alter default privileges in schema app
  grant execute on functions to cm_service, cm_user, cm_readonly;

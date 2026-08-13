-- =============================================================================
-- 0018 · One human is one coach — the third instance of 0012's defect
--
-- 0012 gave `contact` a phone key that actually fires. 0014 gave `venue` a name
-- key. Both migrations exist because a writer assumed a constraint that was not
-- there. This one exists for the opposite reason: **the constraint was there, and
-- the writer routed around it.**
--
-- Driven on a live academy, twice in three minutes. An admin said "add my coach
-- Ravi Menon, his number is 9900000042" and then, as people do, said it again.
-- `add_coach` minted a fresh `person` both times and wrote the contact with
-- `on conflict (academy_id, phone_e164) do nothing`. The second contact insert
-- matched the existing phone and did nothing, silently — R7 — so the database
-- ended up with:
--
--   coach 555057b5 · status `added`   · 1 contact · 1 class link
--   coach 900a6585 · status `invited` · 0 contacts · 1 class link
--
-- The real Ravi, the one holding the phone, was stuck at `added` and never
-- invited. A phantom nobody can reach was marked `invited`. The class was
-- silently double-staffed. The admin was told "Noted — Ravi Menon's invite is
-- out." Every layer reported success, and the transcript reads identically to the
-- run where it worked.
--
-- The application fix is in `add_coach`/`add_family`: resolve the person who
-- already owns the phone, and drop the `on conflict do nothing` that turned a
-- collision into silence. That is the fix that matters, because `contact
-- (academy_id, phone_e164)` was always the right key — nothing was missing but
-- the willingness to hit it.
--
-- This migration is the backstop underneath it. The build-time check runs under
-- the caller's RLS, so a coach row the caller cannot see is a coach row the check
-- cannot find; only the database can promise this one for every path, including
-- the paths nobody has written yet.
-- =============================================================================

-- No duplicates exist to fold: the two Ravis above are two *person* rows, which
-- is precisely why a key on (academy_id, person_id) would not have caught them.
-- It is here to stop the other duplicate — the same human enrolled as staff twice
-- — which is what a retry, a double tap, or a re-import produces.
do $$
declare
  d record;
  keeper uuid;
begin
  for d in
    select academy_id, person_id, count(*) as n
      from coach
     group by academy_id, person_id
    having count(*) > 1
  loop
    -- Keep the oldest: it is the one other rows already reference. Prefer a row
    -- that is not ended, so folding never resurrects a departure or buries a
    -- current appointment under a stale one.
    select id into keeper
      from coach
     where academy_id = d.academy_id and person_id = d.person_id
     order by (ended_on is not null), created_at, id
     limit 1;

    update class_coach   set coach_id = keeper
     where coach_id in (select id from coach
                         where academy_id = d.academy_id and person_id = d.person_id and id <> keeper)
       and not exists (select 1 from class_coach k
                        where k.class_id = class_coach.class_id and k.coach_id = keeper);
    update session_coach set coach_id = keeper
     where coach_id in (select id from coach
                         where academy_id = d.academy_id and person_id = d.person_id and id <> keeper)
       and not exists (select 1 from session_coach k
                        where k.session_id = session_coach.session_id and k.coach_id = keeper);

    -- Whatever could not be repointed above would have collided on its own key;
    -- those links are duplicates of links the keeper already has.
    delete from class_coach
     where coach_id in (select id from coach
                         where academy_id = d.academy_id and person_id = d.person_id and id <> keeper);
    delete from session_coach
     where coach_id in (select id from coach
                         where academy_id = d.academy_id and person_id = d.person_id and id <> keeper);
    delete from coach
     where academy_id = d.academy_id and person_id = d.person_id and id <> keeper;

    raise notice 'coach: folded % duplicate row(s) for person % onto %', d.n - 1, d.person_id, keeper;
  end loop;
end;
$$;

alter table coach drop constraint if exists coach_academy_id_person_id_key;
alter table coach add constraint coach_academy_id_person_id_key unique (academy_id, person_id);

comment on constraint coach_academy_id_person_id_key on coach is
  'One human is one coach at one business. A coach who leaves keeps their row and gains an '
  'ended_on; coming back changes that row rather than opening a second one. Plain columns so '
  '`on conflict (academy_id, person_id)` can name it.';

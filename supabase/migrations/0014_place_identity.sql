-- =============================================================================
-- 0014 · One place, one row — and the constraint every writer already assumes
--
-- The same defect as 0012, in the other table people are identified by. `contact`
-- had a unique key that could never fire because the string was not comparable;
-- `venue` and `class` had no unique key at all, and every writer assumed one.
--
-- Watched happening, twice, in one driven onboarding:
--
--   1. Asked to "add a beginners batch mon wed fri 6:30 at green park", the model
--      composed
--        insert into venue (academy_id, name) values (…, 'Green Park')
--          on conflict (academy_id, name) do update set name = excluded.name
--      and Postgres refused: *"there is no unique or exclusion constraint matching
--      the ON CONFLICT specification"*. The plan aborted, the class was never
--      created, and the admin was told "I'm sorry, I'm still having trouble."
--      The instinct was right; the constraint it assumed is the one that should
--      exist. Three turns and 100k tokens went on discovering it does not.
--
--   2. Without it, "green park" and "Green Park" are two places. Sessions split
--      across them, the coach's venue is one row and the parent's reminder names
--      the other, and nothing anywhere says the schedule is now in two halves.
--      `class.venue_id` and `session.venue_id` both point at an id, so a duplicate
--      is invisible from every screen that renders a name.
--
-- **Two things have to be true at once**, and getting only one of them is why the
-- first attempt at this migration was wrong. The key must be *targetable* — a
-- unique index on `app.name_key(name)` prevents duplicates perfectly and cannot be
-- named by `on conflict (academy_id, name)`, because an inference clause has to
-- match the index expression exactly, so the very error this exists to fix would
-- still be thrown. And it must be *case-blind*, or the duplicate walks straight in
-- under a different capitalisation.
--
-- So: a plain `unique (academy_id, name)` — the shape every writer reaches for —
-- plus a trigger that makes the comparison mean what people mean. The trigger
-- **adopts the spelling this business already uses**: if they have a "Green Park",
-- a later "green park" becomes "Green Park" and collides properly. That is
-- doctrine rule 3 ("speak the academy's language, use their words") enforced at
-- layer 0 rather than remembered, and it is strictly better than folding the
-- stored name to lower case, which would put *our* spelling in their messages.
-- =============================================================================

/**
 * The comparable form of a name. Folded, collapsed, trimmed — never stored, only
 * ever the thing two names are compared by.
 */
create or replace function app.name_key(p_raw text)
returns text
language sql
immutable
as $$
  select nullif(btrim(regexp_replace(lower(coalesce(p_raw, '')), '\s+', ' ', 'g')), '')
$$;

/**
 * Write the name this business already uses, when they already use one.
 *
 * Not a rejection: a mistyped case is not a reason to fail somebody's onboarding
 * mid-plan. It resolves to the existing row, which is what the author meant, and
 * then the unique key below does its job.
 */
create or replace function app.adopt_existing_name()
returns trigger
language plpgsql
as $$
declare
  existing text;
begin
  if new.name is null then
    return new;
  end if;
  -- Collapse whitespace always: "Green  Park " and "Green Park" are not two places
  -- by anyone's reckoning, and nobody typed the difference on purpose.
  new.name := btrim(regexp_replace(new.name, '\s+', ' ', 'g'));

  execute format(
    'select name from %I where academy_id = $1 and app.name_key(name) = app.name_key($2) and id <> $3 limit 1',
    tg_table_name
  ) into existing using new.academy_id, new.name, new.id;

  if existing is not null then
    new.name := existing;
  end if;
  return new;
end;
$$;

-- Existing duplicates first: an index that cannot be built is a migration that
-- half-ran. Anything that collides is folded onto the OLDEST row — the one other
-- rows are most likely to already reference — and the losers' references are
-- repointed before they go, so no class or session is orphaned.
do $$
declare
  d record;
  keeper uuid;
begin
  update venue set name = btrim(regexp_replace(name, '\s+', ' ', 'g'))
   where name <> btrim(regexp_replace(name, '\s+', ' ', 'g'));

  for d in
    select academy_id, app.name_key(name) as key, count(*) as n
      from venue
     where app.name_key(name) is not null
     group by academy_id, app.name_key(name)
    having count(*) > 1
  loop
    select id into keeper
      from venue
     where academy_id = d.academy_id and app.name_key(name) = d.key
     order by created_at, id
     limit 1;

    update class   set venue_id = keeper
     where academy_id = d.academy_id and venue_id is not null and venue_id <> keeper
       and venue_id in (select id from venue where academy_id = d.academy_id and app.name_key(name) = d.key);
    update session set venue_id = keeper
     where academy_id = d.academy_id and venue_id is not null and venue_id <> keeper
       and venue_id in (select id from venue where academy_id = d.academy_id and app.name_key(name) = d.key);
    delete from venue
     where academy_id = d.academy_id and app.name_key(name) = d.key and id <> keeper;

    raise notice 'venue: folded % duplicate row(s) of "%" onto %', d.n - 1, d.key, keeper;
  end loop;

  -- Then the survivors all take the keeper's spelling, so the plain key holds.
  update venue v set name = k.name
    from (select distinct on (academy_id, app.name_key(name)) academy_id, app.name_key(name) as key, name
            from venue order by academy_id, app.name_key(name), created_at, id) k
   where v.academy_id = k.academy_id and app.name_key(v.name) = k.key and v.name <> k.name;
end;
$$;

drop index if exists venue_academy_name_key;
drop trigger if exists venue_adopt_existing_name on venue;
create trigger venue_adopt_existing_name
  before insert or update of name on venue
  for each row execute function app.adopt_existing_name();

alter table venue drop constraint if exists venue_academy_id_name_key;
alter table venue add constraint venue_academy_id_name_key unique (academy_id, name);

comment on constraint venue_academy_id_name_key on venue is
  'One place per business. Plain columns on purpose: this is the constraint '
  '`on conflict (academy_id, name)` names, and an expression index cannot be named by one.';

-- Classes get the whitespace-and-spelling trigger for the same reason, but no
-- unique key: §6.3 keeps ended classes forever, so last year''s "Beginners" would
-- block this year''s, and merging two live classes named the same is not something
-- a migration should decide. Consistent spelling is the part that is safe to
-- guarantee here — it is what makes "move the beginners batch" resolve to one row.
drop index if exists class_academy_active_name_key;
drop trigger if exists class_adopt_existing_name on class;
create trigger class_adopt_existing_name
  before insert or update of name on class
  for each row execute function app.adopt_existing_name();

grant execute on function app.name_key(text) to cm_service, cm_user, cm_readonly;

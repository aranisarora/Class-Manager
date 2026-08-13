-- Narrow 0020's index to classes that are still OPEN.
--
-- 0020 scoped uniqueness to `where active`, which looked like it honoured the
-- reason `class` was deliberately left without a unique key — §6.3 keeps ended
-- classes for ever, and last year's "Beginners" must not block this year's.
--
-- It did not. **Nothing in the product ever sets `class.active = false`.** There
-- is no operation that retires a class; `create_class` writes `active` true and
-- no write anywhere clears it. So `where active` is `where true`, and 0020 would
-- have refused next year's "Beginners" — the precise case the note in
-- `STEPS_PARAM` was written to protect.
--
-- A class that has ended is one with an `ends_on`. So that is the predicate: one
-- open class per name per business. The duplicate that produced this — two
-- "Evening Fitness" rows fifty seconds apart, both open, both with no end date —
-- is still refused, and a class an admin closed keeps its name for the next one.
--
-- **What this takes away, honestly.** An admin who never sets `ends_on` still has
-- that class open, so a second one with the same name is still refused. That is
-- the right answer — the product's own lookups (`where name = $1 and active
-- ... limit 1`) cannot tell those two apart either — but it means the way to
-- reuse a name is to close the old class, and there is currently no operation
-- that does so. That gap is real and is worth closing next; it is not made worse
-- by this index, which only refuses the ambiguity that was already breaking
-- every lookup.

drop index if exists class_academy_name_active_key;

create unique index if not exists class_academy_name_open_key
  on class (academy_id, lower(btrim(name)))
  where active and ends_on is null;

comment on index class_academy_name_open_key is
  'One OPEN class per name per business. The model looks classes up by name '
  '(select id from class where name = $1 and active limit 1), so this is what '
  'makes that lookup correct rather than merely usual. Ended classes (ends_on '
  'set) are unconstrained, so a name can be reused next season.';

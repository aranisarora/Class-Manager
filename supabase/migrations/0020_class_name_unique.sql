-- A business cannot have two active classes with the same name.
--
-- Driven: an admin said "one more: an evening fitness batch every day 7 to 8pm at
-- green park, 2000 a month, arjun takes it", and the class was created. Fifty
-- seconds later, asked something else entirely — "keep an eye on the advanced batch
-- and tell me on friday if nobody else has joined it" — the model composed a plan
-- that re-issued the whole previous request beside the new watch. It was refused
-- twice for unrelated shape errors, fixed the shape on the third round, and the
-- plan ran. `create_class` created a SECOND "Evening Fitness", identical in every
-- business-meaningful way: same venue, same start date, same 2000/month.
--
-- What that cost, none of which was visible in the reply:
--   * 22 duplicate sessions, one per day of the horizon, for ever
--   * the coach on both, so every CO-COMING went out twice, byte for byte
--   * the duplicates burned his §16.3 recipient frequency cap, so CO-NUDGE and
--     CO-REGISTER were both suppressed — he never got the register prompt at all
--
-- **Why the constraint belongs here and not in the operation.** The model already
-- treats the class name as a key. Its own plan steps read
-- `(select id from class where name = 'Evening Fitness' and active
--   order by created_at desc limit 1)`
-- and that `limit 1` silently picks one of two. Every generator, every enrollment
-- write and every lookup in the product shares that assumption, so the choice is
-- not "should names be unique" — it is "is the assumption everything already makes
-- actually true". R5: a comparison on unnormalised values, where the constraint
-- that would make it real does not exist. `venue` already has exactly this index
-- (`venue_academy_id_name_key`) and `coach` has its own; `class` was the gap.
--
-- Normalised on `lower(btrim(name))` because "Evening Fitness", "evening fitness"
-- and "Evening Fitness " are the same class to everyone except a byte comparison,
-- and a constraint that a trailing space defeats is R5 wearing a fix's clothes.
--
-- **What this takes away.** An academy can no longer run two ACTIVE classes with
-- the same name — "Beginners" at Green Park and "Beginners" at Indiranagar now
-- have to be told apart in their names. That is a real cost and it is accepted on
-- purpose: the product's own lookups cannot tell those two apart either, so the
-- pair was never actually usable, and every message about "Beginners" was already
-- ambiguous. Naming them apart is what makes the bot's sentences true. Inactive
-- classes are unconstrained, so history keeps its names.

-- ---------------------------------------------------------------------------
-- Existing duplicates, resolved before the index can refuse to build.
--
-- Only the provably-accidental copy: the NEWER row of a duplicate pair that
-- nobody was ever enrolled in and that has no session anybody has touched. A
-- duplicate with real data on it is left alone deliberately — the index will then
-- fail loudly, which is the right outcome, because that one needs a human.
-- ---------------------------------------------------------------------------

with dupes as (
  select c.id,
         row_number() over (
           partition by c.academy_id, lower(btrim(c.name))
           order by c.created_at, c.id
         ) as rn
    from class c
   where c.active
),
accidental as (
  select d.id
    from dupes d
   where d.rn > 1
     and not exists (select 1 from enrollment e where e.class_id = d.id)
     and not exists (
           select 1 from session s
            where s.class_id = d.id
              and (s.status <> 'scheduled' or exists (select 1 from attendance a where a.session_id = s.id))
         )
)
update class set active = false where id in (select id from accidental);

-- The sessions those copies left behind, swept with the same safety rules the
-- orphan sweep in `materializeSessions` already uses: only future, only untouched,
-- never one anybody has been billed for or marked.
delete from session s
 where s.status = 'scheduled'
   and not exists (select 1 from attendance a where a.session_id = s.id)
   and not exists (select 1 from tally_line t where t.session_id = s.id)
   and exists (
         select 1 from class c
          where c.id = s.class_id
            and not c.active
            -- only the copies this migration just deactivated, never a class an
            -- admin retired on purpose and whose sessions are their own record
            and exists (
                  select 1 from class k
                   where k.academy_id = c.academy_id
                     and k.active
                     and lower(btrim(k.name)) = lower(btrim(c.name))
                )
       );

create unique index if not exists class_academy_name_active_key
  on class (academy_id, lower(btrim(name)))
  where active;

comment on index class_academy_name_active_key is
  'One active class per name per business. The model looks classes up by name '
  '(select id from class where name = $1 and active limit 1), so this is the '
  'constraint that makes that lookup correct rather than merely usual.';

-- Money idempotency stops keying on prose.
--
-- `tally_line` had no class column and no dedupe column, so §6.4's "one line,
-- once" rule was enforced by matching on `description` — the sentence shown
-- verbatim to the parent. `lib/billing-keys.ts` records why that was already
-- known to be fragile. It is worse than fragile; it is driven:
--
--   A family paid ₹1,200 for August, and the payment was confirmed: billed 1200,
--   paid 1200, nothing outstanding. Their class was renamed "Beginners" ->
--   "Beginners Batch". The next billing run for the SAME player and the SAME
--   period composed "Beginners Batch — August 2026", matched no existing row,
--   and charged them again. A settled account became ₹1,200 in arrears, which is
--   the threshold for the dunning ladder — so renaming a class starts chasing a
--   family who has already paid.
--
--   Sixteen (player, class, period) triples in the shared world were already
--   double-charged, ₹32,800 in total, every pair differing only by "-" against
--   "—": `lib/seed.ts` writes a hyphen, `lib/jobs/handlers/money.ts` an em dash.
--   Neither writer could see the other's rows. R5: the comparison exists and can
--   never fire.
--
-- Two columns, because the row was also narrower than what it described (R6):
--
--   `class_id`     what the charge is FOR. The description was the only record of
--                  this, which is why the guard had to read it.
--   `dedupe_key`   what "the same charge" MEANS, in ids. Built by `billingKey.*`
--                  in lib/billing-keys.ts so both writers spell it identically by
--                  construction rather than by agreement.
--
-- The unique index is the point. A shared literal stops two writers drifting;
-- only a constraint stops a third writer nobody has written yet.

alter table tally_line
  add column if not exists class_id uuid references class (id) on delete set null;

alter table tally_line
  add column if not exists dedupe_key text;

comment on column tally_line.class_id is
  'What this charge is for. Nullable: session credits and manual adjustments need '
  'no class. Before 0023 the class was recorded only inside `description`, which is '
  'why idempotency had to read prose.';

comment on column tally_line.dedupe_key is
  'Identity of a recurring charge, in ids — see billingKey in lib/billing-keys.ts. '
  'NULL means deliberately repeatable: a waiver or a manual adjustment, where an '
  'admin doing the same thing twice is a decision and not a duplicate.';

-- ---------------------------------------------------------------------------
-- Backfill, in the order of how certain each derivation is.
-- ---------------------------------------------------------------------------

-- Session lines and their credits key off columns the row already carries, so
-- these are exact — no guessing, no prose.
update tally_line
   set dedupe_key = 's:' || player_id::text || ':' || session_id::text
 where dedupe_key is null and kind = 'session'
   and player_id is not null and session_id is not null;

update tally_line
   set dedupe_key = 'ff:' || player_id::text
 where dedupe_key is null and kind = 'adjustment'
   and reason = 'free first class' and player_id is not null;

-- `class_id` for the recurring kinds can only come from the description, because
-- until now that was the only place it was written down. This is a ONE-TIME
-- reconciliation of history, not a rule: nothing at run time reads a description
-- again. Longest matching class name wins, so "Beginners Batch" is preferred over
-- "Beginners" for a row that could match either.
update tally_line t
   set class_id = c.id
  from class c
 where t.class_id is null
   and t.kind in ('monthly', 'term', 'package')
   and c.academy_id = t.academy_id
   and t.description like c.name || '%'
   and length(c.name) = (
     select max(length(c2.name))
       from class c2
      where c2.academy_id = t.academy_id
        and t.description like c2.name || '%'
   );

-- Now the recurring keys, but ONLY where they do not collide. Where two rows
-- would claim one key, the earliest keeps it and the later ones are left NULL.
--
-- **A schema migration must not silently rewrite money.** Deleting the duplicate
-- charges here would erase the evidence that sixteen families were double-billed,
-- and a business decides between a credit note and a write-off — not a DDL file.
-- So the duplicates survive as rows, visibly, and `scripts/check-duplicate-charges.mts`
-- reports them. What this migration guarantees is that no SEVENTEENTH one can be
-- written.
with keyed as (
  select t.id,
         case t.kind
           when 'monthly' then 'm:'
           when 'term' then 't:'
         end || t.player_id::text || ':' || t.class_id::text || ':'
             || to_char(t.period, 'YYYY-MM-DD') as k,
         row_number() over (
           partition by t.academy_id, t.kind, t.player_id, t.class_id, t.period
           order by t.created_at, t.id
         ) as seq
    from tally_line t
   where t.dedupe_key is null
     and t.kind in ('monthly', 'term')
     and t.player_id is not null
     and t.class_id is not null
)
update tally_line t
   set dedupe_key = keyed.k
  from keyed
 where t.id = keyed.id and keyed.seq = 1;

-- Packs are ordinal, not periodic: the second pack of a busy month shares its
-- period with the first, so the key counts packs rather than months.
with keyed as (
  select t.id,
         'p:' || t.player_id::text || ':' || t.class_id::text || ':'
             || row_number() over (
                  partition by t.academy_id, t.player_id, t.class_id
                  order by t.created_at, t.id
                )::text as k
    from tally_line t
   where t.dedupe_key is null
     and t.kind = 'package'
     and t.player_id is not null
     and t.class_id is not null
)
update tally_line t
   set dedupe_key = keyed.k
  from keyed
 where t.id = keyed.id;

-- ---------------------------------------------------------------------------
-- The constraint. Everything above is preparation; this is the guarantee.
-- ---------------------------------------------------------------------------

create unique index if not exists tally_line_dedupe_key
  on tally_line (academy_id, dedupe_key)
  where dedupe_key is not null;

comment on index tally_line_dedupe_key is
  'One recurring charge, once — enforced. Partial because a waiver carries no key: '
  'an admin waiving twice is two decisions, not a duplicate. This is what makes '
  '§6.4 idempotent against a class rename, a reworded month, and a writer nobody '
  'has written yet; the shared literals in lib/billing-keys.ts only ever stopped '
  'the two writers that already existed from drifting apart.';

create index if not exists tally_line_class_idx on tally_line (class_id);

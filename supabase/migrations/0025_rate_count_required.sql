-- A term with no length, and a pack with no size, stop being representable.
--
-- `rate_count` means "months in the term" for `per_term` and "sessions in the
-- pack" for `per_package`. 0002 says so in a COMMENT and enforces nothing:
--
--     rate_unit   text check (rate_unit in (...)),
--     rate_count  int,     -- per_term: months in the term.
--                          -- per_package: sessions in the package. else null.
--
-- So `rate_unit = 'per_term'` with `rate_count = null` is a state the schema
-- accepts, `create_class` accepts (the two params are independent and both
-- nullish), and `add_family` cannot even avoid — it writes `rate_unit` and does
-- not offer `rate_count` at all.
--
-- Three readers then invent three different defaults for it:
--
--     money.ts:127        const months = Math.max(1, e.rate_count ?? 1)
--     money.ts:141        const size   = Math.max(1, e.rate_count ?? 1)
--     operations.ts:1591  const size   = r.rate_count > 0 ? r.rate_count : 10
--
-- and the damage lands months later, inside a job, where there is no model in
-- the loop and nobody to recover — R1 exactly.
--
--   per_term, count null -> months = 1. The rollover test is
--   `elapsed % months !== 0`, and `elapsed % 1` is 0 in every month, so a
--   ₹15,000 term is billed **every month, for ever**. The line the parent reads
--   is composed by `termDescription` as "term, August to August 2026" — a
--   one-month term — so it is internally consistent and completely wrong.
--   Nobody finds out from the product: the line is honestly written, the tally
--   reads it back verbatim, and the truth axis scores it a pass because the
--   reply claimed no action. The academy finds out when a parent adds up twelve
--   ₹15,000 charges.
--
--   per_package, count null -> `money.ts` says a pack of 1 and `operations.ts`
--   says a pack of 10, about the same enrolment.
--
-- The right layer is this one. A default in a reader is a guess about what an
-- admin meant; a constraint is the product refusing to hold a price it cannot
-- bill correctly. Pushed down here it is free and unforgettable, and the model
-- gets told at write time — while it is still in a conversation with the person
-- who knows the answer — instead of a family being overcharged in November.

alter table class drop constraint if exists class_rate_count_required;
alter table class add constraint class_rate_count_required check (
  rate_unit is null
  or rate_unit not in ('per_term', 'per_package')
  or (rate_count is not null and rate_count > 0)
);

alter table enrollment drop constraint if exists enrollment_rate_count_required;
alter table enrollment add constraint enrollment_rate_count_required check (
  rate_unit is null
  or rate_unit not in ('per_term', 'per_package')
  or (rate_count is not null and rate_count > 0)
);

comment on constraint class_rate_count_required on class is
  'per_term needs its length and per_package needs its size, or the billing job '
  'must guess — and its three readers guessed three different numbers. A term '
  'with no count billed the whole term every month, for ever.';

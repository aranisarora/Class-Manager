-- 0048 — what the desk learned reaches the business
--
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- The front desk's whole job is to find out which side of the counter somebody
-- is on, and then hand them over. It answers that question, routes on it, and
-- throws it away: `join_business` takes an academy id and nothing else, so the
-- tenant turn that answers the same message a breath later starts from zero.
--
-- Watched, twice, in the drives of 22 Aug 2026. Arjun Shetty writes "i run the
-- evening batch for rahul, mon and thu 6-7" and again "im not the owner im just
-- coach for rahul evening bath mon n thu". The desk reads him correctly both
-- times. He arrives inside the business as a `prospect` contact with no role and
-- nothing anywhere recording what he had just said, and a week later the owner is
-- still being asked to confirm who he is. The single most useful sentence in his
-- week was spoken to the one surface that could not keep it.
--
-- WHY A COLUMN ON `contact` AND NOT ON `arrival`
-- ---------------------------------------------------------------------------
-- `arrival` already holds the funnel row and would be the natural home, and it is
-- the wrong one for this: 0039 closes `arrival` to every role, so a fact written
-- there is a fact the tenant turn still cannot read. The point of this column is
-- to cross the boundary, so it lives on the row that crosses it.
--
-- WHAT IT IS NOT
-- ---------------------------------------------------------------------------
-- Not a role, and it grants nothing. `person`, `coach`, `academy_admin` and
-- `account` decide what somebody may do, and this decides nothing at all — it is
-- what they SAID, kept as evidence, in the same spirit as `arrival.opening_words`
-- and for the same reason: the alternative is a business that has to ask a
-- question its own front desk already asked.
--
-- Nullable for everybody who did not arrive through a desk, which is most rows.

alter table contact add column if not exists arrived_as text
  check (arrived_as is null or arrived_as in ('parent', 'coach', 'owner', 'unsure'));

comment on column contact.arrived_as is
  'What this person told the FRONT DESK they were, carried across the hand-over. The desk '
  'has to decide this to route at all, so nothing new is inferred — it is the answer it '
  'already had, written where the business can read it. Null for anybody who did not '
  'arrive through a desk.';

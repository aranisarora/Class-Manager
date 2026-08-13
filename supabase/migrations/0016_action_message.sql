-- =============================================================================
-- 0016 · A message's buttons are one decision, not three
--
-- `action` had no idea which message it was printed on, so every button on a
-- message was an independent row, live for its own TTL, invalidated by nothing.
-- A confirmation card offering [Do it] [Cancel] offered both of them for a day.
--
-- The failure that names this migration, on the one path with no model in the
-- loop to notice it: tap [Do it], the plan commits and the receipt goes out —
-- then tap [Cancel] on that same message. Its row is untouched, so it consumes
-- cleanly and fires its `noop`, which replies *"Left as it was — nothing
-- changed."* The work happened. That sentence was authored at mint time and
-- goes to the phone verbatim, with nothing between it and the person.
--
-- The mirror is worse and was equally reachable: tap [Cancel], then [Do it]
-- twenty minutes later, and a plan the person declined commits anyway.
--
-- `message_id` is what makes the family knowable, so claiming one row can
-- retire its siblings in the same statement as the claim (`lib/actions.ts`).
--
-- Narrowly, and the code says why at length: only a tap that decided something
-- retires anything, and only on a card where something can actually be
-- committed. The session reminder's `[I'll be there]` and `[Can't make it]` are
-- both live all day on purpose — a parent who says yes at nine has to be able
-- to say no at four.
--
-- **Nullable, and left null on purpose.** Every row minted before this
-- migration has no message; so does every action minted for a send that was
-- suppressed or failed before a `message` row existed. Those buttons were never
-- printed, so there is no family, and the sibling clause joins
-- `a.message_id = c.message_id` — false when either side is null. A null groups
-- with nothing, so the one thing this must never do — expire a stranger's live
-- buttons because both rows happen to carry no message — is refused by the
-- comparison itself rather than by a guard somebody has to remember to write.
--
-- No backfill. Reconstructing families out of `message.payload -> 'buttons'`
-- would put a full jsonb scan in a migration to protect at most one TTL's worth
-- of taps (24h), after which the backlog has aged out on its own.
--
-- Nothing to do for RLS or grants. Both `action` policies (0003) are row
-- predicates on `academy_id` / `minted_for_contact_id`, so a new column is
-- covered by the row it sits on; the grants (0002, 0006) are table-wide, and
-- there are no column-level privileges here that a new column could escape.
-- =============================================================================

alter table action add column if not exists message_id uuid references message(id);

-- Every suppression in this product is a row carrying its reason, and a button
-- that goes dead because its sibling was taken is a suppression. Without this
-- the row is indistinguishable from one that simply ran out its TTL, and "why
-- did Cancel stop working?" has no answer anywhere. Part of how the original
-- defect lived so long is that nothing on the row ever connected a button's
-- fate to the message it sat on.
alter table action add column if not exists expired_reason text;

-- Partial on purpose: the sibling lookup is always `message_id = <a uuid>`, and
-- every row minted before 0016 — plus every unprinted button after it — carries
-- none, so those have no business in the index.
create index if not exists action_message_idx on action (message_id)
  where message_id is not null;

comment on column action.message_id is
  'The message this button was printed on (§6.5). Stamped after the send returns, because '
  'a button needs its action id before the message can be built. Null when no message row '
  'ever existed, and on every row minted before 0016 — a null belongs to no family and is '
  'never grouped with another null.';

comment on column action.expired_reason is
  'Why this action was retired before its TTL ran out. `superseded_by_action:<uuid>` means '
  'a sibling button on the same message was taken first, and that tap is what killed this '
  'one — see consumeAction in lib/actions.ts.';

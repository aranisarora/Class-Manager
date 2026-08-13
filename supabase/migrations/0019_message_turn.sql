-- Which turn put this message on somebody's screen.
--
-- The drive method is four layers: what the person saw (`message`), what happened
-- inside (`turn`), what the database says, and whether the first matches the third.
-- Layers 1 and 2 had nothing joining them. The only way to say "this sentence came
-- out of that turn" was to sort both tables by `created_at` and pair them off by
-- eye — which is guesswork the moment a turn tells somebody *else* (a coach, the
-- other parent) or a job sends in the same second as a reply. A round was spent
-- pairing the wrong reply with the wrong flight recorder.
--
-- `audit_entry` already solved this in 0015 and the argument there is the whole
-- argument here: carried as a GUC, not as a parameter, because a message reaches
-- the send path from a model tool call, a button tap, a job and a self-scheduled
-- task, and threading an argument through each is four call sites to keep right
-- and four chances to forget. The one that forgets writes a null and is invisible.
--
-- This goes one step further than 0015 and makes it a column DEFAULT rather than a
-- statement in a function, so there is no code change at all: every insert into
-- `message`, including ones nobody has written yet, is stamped by the database.
-- `applySession` already sets `app.turn_id` beside the tenant and the actor.
--
-- Nullable and honest: seeds, migrations and repair scripts write messages that
-- belong to no turn, and a null there is the truth rather than a gap.

alter table message
  add column if not exists turn_id uuid default nullif(current_setting('app.turn_id', true), '')::uuid;

comment on column message.turn_id is
  'The turn that produced this message, when there was one. Null for seeds and for '
  'anything sent outside a conversation. Defaulted from the app.turn_id GUC set by '
  'applySession — never passed by a caller, so no send path can forget it.';

-- The question this answers is always "everything turn X put on a screen", so the
-- index matches it. Partial, because the seeded rows are the majority in a fixture
-- world and none of them are ever the subject of that question.
create index if not exists message_turn_idx
  on message (turn_id)
  where turn_id is not null;

/**
 * lib/agent/schema-doc.ts — the schema layer of the stable prefix (§4.4).
 *
 * A compact rendering of the §6 data model for the model to author SQL against.
 * It is a plain string constant on purpose: it must be BYTE-IDENTICAL across
 * every turn, for every academy, forever, or the prompt cache prefix breaks.
 * Nothing in here may be computed, dated, or per-tenant.
 *
 * Changes only when the migrations change.
 *
 * **Schema, and only schema.** This had grown a behavior layer — how to talk about
 * delivery status, that escalations name a session rather than a person, the six
 * things an adjustment covers, the read tool's timeout and row cap — every line of
 * which was already stated where it actually binds: on the `read` declaration the
 * model decodes against, in doctrine, or in the prefix's domain-facts block.
 * Restating it here did not make it more true, and the
 * prefix pays for it on every uncached round. What is left is what an SQL author
 * cannot get anywhere else: the tables, the columns, the FK graph, the derived
 * expressions and the billing rules that decide which rows exist.
 *
 * **The permission matrix is here for the same reason** (added 17 Aug 2026). It
 * is a fact about the data model, which is PREFIX.md's rung 2, and it is the one
 * class of fact the model has no way to derive: policies are invisible from
 * inside a session, so the boundary could only be found by crossing it. This
 * block used to say the boundary "is not listed here because it is enforced per
 * row rather than per table" — true, and it cost a round every time it mattered.
 * The model planned writes a coach or a family cannot make, was refused mid-plan
 * (or, worse, silently matched nothing), rediscovered the shape, and re-planned;
 * on a hard turn that is a timeout rather than a wrong answer. A grid of who may
 * do what trades bytes in the CACHED block — where a hit costs 3.2% of a miss —
 * against whole rounds on the wire, which are billed at full price and paid for
 * again in latency.
 *
 * It is kept honest by `npm run check:rls-doc`, which reads the grid and asks
 * pg_policies, in both directions. Two authors of one truth always drift; this
 * one is made to read the other.
 */
export const SCHEMA_DOC = `# Schema

Postgres. You author SQL against these tables directly.

- Every table has: id uuid pk, created_at timestamptz.
- Every table except academy, sender, job, sim_* also has academy_id uuid not null.
- **A column marked \`!\` is required and has no default: an INSERT that leaves it
  out is refused, and refused for the whole plan.** Everything unmarked is either
  nullable or defaulted, so leave it out and let the default stand.
- RLS is on for every table and it is the security boundary, not a filter you add.
  **Reading and writing are not symmetrical here, and assuming they are is the
  single most common way a write fails.**
  - READ: never add "where academy_id = ..." as a safety measure. Your queries run
    as the person you are serving and a query reaching past what they may see
    returns zero rows rather than an error. A zero-row result is nothing to debug
    and nothing to retry — but it is only proof of absence when the person you
    are serving could have seen the rows. The admin sees their whole business, so
    their empty is real. For a coach, a family or a stranger, "empty" and
    "withheld by policy" arrive as the same zero rows: report what they can see,
    and where their view ends say "not something I can see from here" — never
    that the thing does not exist.
  - WRITE (INSERT): academy_id fills itself in. It defaults to the business you
    are serving on every tenant-scoped table, so leave it out and write the
    statement you would write if there were only one business in the world.
    Setting it explicitly to app.academy_id() is still correct, just noise.
  - WRITE (UPDATE and DELETE): **the dangerous half, because it does not fail.** An
    INSERT the policy refuses raises an error you can read. An UPDATE or DELETE whose
    rows the policy excludes simply **matches nothing and raises nothing** — no error,
    no warning, and a statement that reports success. This is how a coach was told
    "you're all set up" and stayed invited forever: the row existed, the id was right,
    and the policy gave them no UPDATE on it, so Postgres changed nothing and said
    nothing. So never read "no error" as "it worked" on an UPDATE or a DELETE. Read
    back the row you meant to change, and if it did not change, say so — the two
    explanations are that the WHERE matched nothing, or that this person is not allowed
    to make this change and it must be routed to the admin instead.
- **Never call now(), current_date or current_timestamp. Use app.now().** The clock
  is drivable; sql now() ignores it and produces answers that are wrong in test and
  subtly wrong in production. These are refused before the database sees them.

## Who may read and write what — the permission matrix

**The table does not decide whether a write lands. WHO you are serving does.**
The same request from an owner and from a parent are two different plans, and
the difference is knowable before you write a line of SQL rather than after
Postgres has refused it.

In one sentence: **the admin writes the business; a coach writes the register
for their own sessions and their own answer to one; a family writes their own
contact details and what they want to hear about; nobody writes anything else.**

\`all\` is anybody in this business, including a stranger who has just messaged.
\`family\` is the account holder and their own players. \`-\` is nobody, in every
session including the owner's. **A role the cell does not name has no policy
there** — their read is zero rows and their write does not land, so there is
nothing to try and nothing to learn by trying.

| table | select | insert | update | delete |
| --- | --- | --- | --- | --- |
| academy | all | - | admin | - |
| venue · class · class_slot | all | admin | admin | admin |
| coach | admin · coach, their own row | admin | admin | admin |
| class_coach | admin · coach, their own | admin | admin | admin |
| academy_admin | admin · their own row | admin | - | admin |
| person | admin · themselves · their own family · players and coaches on sessions of theirs | admin | admin · themselves | admin |
| contact | admin · their own · their own family's | admin | admin · their own person's | admin |
| account | admin · family, their own | admin | admin | admin |
| player | admin · family, their own · coach, players on their sessions | admin | admin | admin |
| enrollment | admin · family, their own · coach, on their sessions' classes | admin | admin | admin |
| session | admin · coach, assigned · family, enrolled | admin | admin | admin |
| session_coach | admin · coach, their own · anyone on a session of theirs | admin | admin · coach, their own row | admin |
| attendance | admin · family, their own · coach, their sessions | admin · coach, their sessions | admin · coach, their sessions | admin |
| tally_line · payment | admin · family, their own accounts | admin | admin | admin |
| business_rule | admin · the shared ones | admin | admin | - |
| comm_preference | admin · their own | admin · their own | admin · their own | - |
| memory_fact | admin · their own person facts | - | - | - |
| message | admin · their own thread | - | - | - |
| pending_request | admin · their own | - | - | - |
| action | their own | - | their own | - |
| row_snapshot | all | - | - | - |
| job · audit_entry · turn · sender | - | - | - | - |

What the grid cannot say:

- **The runtime's own books — job, audit_entry, turn — are closed in both
  directions.** So never answer "nothing changed" from one. You do not have to
  look up what you are WATCHING either: every live watch is listed for you at
  the top of this conversation, with the subject it is filed under, so a watch
  you already hold is a thing you can see rather than a thing you remember.
  Cancelling a standing reminder is not a row you edit — use drop_watch for a
  watch, and leave the rest to the runtime, which already drops the prompts a
  cancellation makes moot.
- **Each read-only table has the tool that writes it.** \`remember\` writes
  memory_fact (a correction passes supersedes — do not compose the INSERT
  yourself), \`reply\` writes message and action, and asking a question that only
  one person's tap can answer is what writes pending_request.
- **tally_line and payment are invisible to anybody who holds no account of
  their own.** A coach who is not also a parent reads zero rows in both, whoever
  the row belongs to — that is policy, not absence. Their own pay is on their
  coach row instead.
- **The views inherit the reader.** session_coverage, uncovered_session and
  app.session_roster run with the permissions of the person you are serving, so
  a register read in a family's session is their own children and nothing else,
  and a coach's coverage is their own sessions. coach_public is the exception:
  it is every coach in the business, to anybody who asks.
- **academy is update only.** You may change the business's own settings. There
  is no route to a second academy and no reason to look for one.

When the cell is not yours, the plan is not "try it and see": it is to say what
you can do and route the rest to the admin, in the same message. Money is
numeric(10,2), rupees. Timestamps are timestamptz; render in the academy's
timezone, never raw.

## Tenancy and place

academy(name! text, category text, timezone text, cancellation_window_hours int,
  client_reminder_lead_hours int, morning_brief_at time, evening_digest_at time,
  rail text 'rail1|rail2', upi_handle text, sender_id uuid, memory text,
  prompt_cache_handle text, settings jsonb, created_on date,
  onboarding_state text 'setup|roster|ready|live')
venue(name! text, address text, notes text)

## People — three separate concerns, and roles compose

person(full_name! text, notes text, memory text, settings jsonb)
contact(person_id! uuid, phone_e164! text, wa_id text, profile_name text,
  is_primary bool, state text 'prospect|registered|engaged|opted_out',
  opted_out_at tstz, last_inbound_at tstz, role_hint text, tier_state jsonb,
  unique(academy_id, phone_e164))          -- a WhatsApp number
  -- phone_e164 is REWRITTEN to +91… on the way in, whatever was typed. So a
  -- lookup on the digits somebody gave you ('9876500011', '098765 00011')
  -- matches nothing and reads as "no such person". Match the tail instead:
  --   where right(phone_e164, 10) = right('<what they typed>', 10)
account(holder_person_id! uuid, display_name text)
player(account_id! uuid, person_id! uuid, active bool)
coach(person_id! uuid, pay_amount numeric, pay_unit text 'per_session|per_hour|per_month',
  status text 'added|invited|active|ended', invited_at tstz, onboarded_at tstz,
  ended_on date)
  -- Pay is private from OTHER coaches, not from themselves, and rows cannot hide
  -- one column — so in a COACH's session this table is their own row and nothing
  -- else. "Who else is on this session?" reads zero rows here and is not an
  -- answer. Use coach_public(id, person_id, status, ended_on), which is every
  -- coach in the business with no pay columns to leak. The admin sees all of
  -- coach, so from an admin session this does not arise.
academy_admin(person_id! uuid)
  -- a non-admin session sees only its own row here (usually none), by design:
  -- an empty read means "not yours to see", never "no admin exists". To reach
  -- the admin you never need this table: reply with to_contact_id 'admin', or
  -- handoff — the runtime resolves who that is.
memory_fact(subject_kind! text 'academy|person', subject_id! uuid, fact! text,
  source text, supersedes uuid -> memory_fact, retired_at tstz)

## What somebody was asked, what they muted, and how the owner runs the business

Three tables that exist because a state nobody stores is a state nobody can
report — and, eventually, one the product mis-reports.

pending_request(contact_id! uuid, person_id! uuid, kind! text /* the protocol:
  opt_out, decline_coach, client_cancel, confirm_plan */, subject! text
  /* what it is about, normalised */, question! text /* the sentence they read */,
  expires_at tstz, asked_turn_id uuid, message_id uuid -> message,
  resolved_at tstz, resolution text 'tapped|expired|superseded|withdrawn')
  -- unique(academy_id, contact_id, kind, subject) where resolved_at is null

  A question on one person's screen that only their own answer resolves. The
  open rows are the ones that matter: resolved_at is null means they were asked
  and have not answered. An unanswered question is NOT the same as one that was
  never asked, and it is not the same as a "no" — say which it is.

comm_preference(contact_id! uuid, person_id! uuid,
  scope! text 'all|money|reminders|outcomes|announcements', until date
  /* null = until they say otherwise */, stated text /* their own words */,
  set_by_person_id uuid, released_at tstz)
  -- unique(academy_id, contact_id, scope) where released_at is null

  A scoped mute. Somebody asking to stop hearing about money is asking for a
  scope, not an opt-out, and this is the row the standing jobs read before they
  compose — so it is what actually stops a 9am payment reminder. contact.
  opted_out_at is the whole-channel version and outranks every scope.

business_rule(statement! text /* the owner's own words */, topic text,
  provenance! text 'owner_stated|observed', stated_by_person_id uuid,
  blessed_at tstz, blessed_by_person_id uuid, enforced_by text
  /* the typed row that gates the automation, or null */,
  visibility text 'internal|shared', retired_at tstz)

  How this owner wants their business run: refund terms, age limits, "no makeups
  on Saturdays", "ask me before waiving anything over Rs500", "we're trying to
  fill the morning batch". Every business is different and this is where the
  difference is kept.

  Two properties decide how to use it. PROVENANCE: owner_stated outranks
  everything and only the owner retires it; observed is a suggestion until the
  owner blesses it, so never act on an unblessed observation as though it were
  policy. ENFORCED_BY: null means the rule steers a conversation and gates
  nothing — a job composing from a query at 9am does not read prose. When the
  owner states a rule that needs to bind automation, either make the typed row
  as well or say plainly which half you can guarantee.

  **Zero rows here is a readable answer, and it is not "no restriction".** It
  means nothing has been written down, and an unstated policy is the owner's
  decision to make rather than a gap to fill in the asker's favour. "I don't
  have a rule on file for that — I'll ask" is the true sentence; inventing a
  plausible one, and then remembering yourself saying it, is how an invention
  acquires the authority of policy.

One person can hold several of player/coach/academy_admin/account-holder rows at
once. A self-paying adult is account.holder_person_id = player.person_id — the
same objects at n=1, not a second case. A parent with three children is n=3.
contact.phone_e164 is unique per academy, so two humans never share a number.

memory_fact is append-only and IS the record. academy.memory and person.memory
are a bounded hot set rebuilt from it — a cache, never the record. A correction
inserts a new row with supersedes set; nothing is edited or deleted. The live set
is: retired_at is null and id not in (select supersedes from memory_fact
where supersedes is not null).

## Classes and sessions — one class noun

class(name! text, venue_id uuid, rate_amount numeric,
  rate_unit text 'per_session|per_month|per_term|per_package', rate_count int
  /* REQUIRED and > 0 when rate_unit is per_term or per_package — how many months
     a term runs, how many sessions a package holds. A check refuses the row
     without it, and the same rule holds on enrollment. */,
  starts_on! date, ends_on date, active bool)
class_slot(class_id! uuid, weekday! int 0=Sun..6=Sat, start_time! time, end_time! time)
class_coach(class_id! uuid, coach_id! uuid)          -- pk(class_id,coach_id). DEFAULT coach set

**Two different people can be "put on a class", and the tables are not
interchangeable.** Somebody who TEACHES it joins through class_coach, by their
coach.id, and is paid. Somebody who ATTENDS it joins through enrollment, by
their player.id, and is charged. So before writing either, know which one this
person is — the same human can hold both rows, so the name does not tell you.
Enrolling a coach is not a near-miss: it opens an account in their name and
starts billing them for the class they are there to run.

enrollment(class_id! uuid, player_id! uuid, rate_amount numeric, rate_unit text,
  rate_count int, is_trial bool, started_on! date, ended_on date)
  -- **There is no enrollment.active.** It is the single commonest invented
  -- column here, and it errors rather than lying. An enrollment is live when
  -- ended_on is null (or is later than the day you are asking about); "active"
  -- is a column on player, and it means the person has left altogether.
session(class_id! uuid, venue_id uuid, starts_at! tstz, ends_at! tstz,
  status text 'scheduled|cancelled|completed', cancel_reason text,
  unique(class_id, starts_at))
session_coach(session_id! uuid, coach_id! uuid, confirmed_at tstz, declined_at tstz,
  arrived_at tstz, running_late bool)              -- pk(session_id,coach_id). ACTUAL coach set
attendance(session_id! uuid, player_id! uuid,
  status! text 'present|late|absent|cancelled_timely', note text,
  marked_by_coach_id uuid, marked_at tstz, unique(session_id, player_id))

There is no group/private/batch/one-off distinction. A private class has one
enrollment. A camp is a class whose date range is a week. A batch is a class that
repeats. session.venue_id overrides class.venue_id when set.

**Who is on a session's register — use this, do not rebuild it.**

app.session_roster(academy_id, session_id, class_id, starts_at, class_name,
  enrollment_id, is_trial, player_id, player_name, account_id,
  attendance_status /* null until marked */, marked_at)
  -- one row per player due at that session

  select player_id, player_name, attendance_status
    from app.session_roster where session_id = '<id>'

That join is enrollment → player → person, narrowed by the enrollment's date
range against the session's own date in the academy's timezone, and it is the
same join every time. Written by hand it is four tables and a date predicate,
and the commonest mistake is enrollment.active, which does not exist — active is
a column on player. The view already excludes inactive players and enrollments
that had not started or had already ended on the day.

## Money

tally_line(account_id! uuid, player_id uuid null, class_id uuid null, period! date
  /* 1st of the billing month */, kind! text
  'session|monthly|term|package|adjustment', description! text /* shown verbatim
  to the parent */, amount! numeric /* negative = credit */, session_id uuid,
  reason text, approved_by uuid -> person, dedupe_key text)
  -- unique(session_id, player_id) where session_id is not null
  -- unique(academy_id, dedupe_key) where dedupe_key is not null
  -- dedupe_key is billing IDENTITY, so a retry cannot double-charge. Set it on
  -- any recurring charge you write, and use the shape the runtime's own writers
  -- use, or your row and theirs will not recognise each other as the same charge:
  --   m:<player_id>:<class_id>:<period>     one month
  --   t:<player_id>:<class_id>:<period>     one term
  --   p:<player_id>:<class_id>:<n>          the nth package
  --   s:<player_id>:<session_id>            one session
  --   ff:<player_id>                        the free first class, once ever
  --   ct:<player_id>:<session_id>           the credit for a timely cancellation
  -- NULL means deliberately repeatable — a waiver or a manual adjustment, where
  -- doing the same thing twice is a decision and not a duplicate.
payment(account_id! uuid, amount! numeric, rail! text 'rail1|rail2', method text, reference text
  /* UPI ref / UTR */, status! text 'requested|confirmed|failed', requested_at tstz,
  confirmed_at tstz, confirmed_by uuid -> person, evidence_url text)

## Messaging, actions, views, jobs, audit

sender(phone_e164, waba_id, credentials jsonb, label)  -- GLOBAL, no academy_id, never readable in a user session
message(contact_id, sender_id, direction 'inbound|outbound', catalog_id text,
  wa_message_id, template_name, body, payload jsonb, media_url,
  status 'queued|sent|delivered|read|failed|suppressed', queued_at, sent_at,
  delivered_at, read_at, failed_reason, suppressed_reason, cost_paise int,
  conversation_category, in_window bool, solicited bool, reply_to_action_id,
  idempotency_key unique, turn_id uuid, origin text 'turn|job|tap|system',
  origin_ref text)
  -- status='failed' is the WIRE saying no. status='suppressed' is this product
  -- deciding not to send, and suppressed_reason says which gate. They are
  -- opposite facts: reporting a gate as a delivery failure tells an owner his
  -- messaging is broken when it is working exactly as designed. Count them apart.
  -- origin says what put it on the wire, so "did a person ask for this" is a
  -- query rather than a guess.
action(kind! text, payload! jsonb /* fully resolved */, minted_at, minted_for_contact_id,
  expires_at, consumed_at, consumed_by_contact_id, message_id uuid -> message,
  expired_reason text)
job(kind text, run_at tstz, dedupe_key text unique, subject_key text
  /* what is being watched; one live job per subject */, status text
  'pending|running|done|failed|skipped|cancelled|superseded', attempts int,
  last_error text, payload jsonb, locked_at, locked_by)   -- GLOBAL
audit_entry(actor_person_id, intent text, plan jsonb, diff jsonb, undone_at,
  undo_of, turn_id uuid)
turn(contact_id, person_id, role_acted, input jsonb, output jsonb, model,
  prompt_tokens, output_tokens, cached_tokens, latency_ms, error,
  tool_calls jsonb, rounds int)

## FK graph

contact.person_id, account.holder_person_id, player.person_id, coach.person_id,
academy_admin.person_id, tally_line.approved_by, payment.confirmed_by,
turn.person_id -> person
player.account_id, tally_line.account_id, payment.account_id -> account
enrollment.player_id, attendance.player_id, tally_line.player_id -> player
class_coach.coach_id, session_coach.coach_id, attendance.marked_by_coach_id -> coach
class_slot.class_id, class_coach.class_id, enrollment.class_id, session.class_id -> class
session_coach.session_id, attendance.session_id, tally_line.session_id -> session
class.venue_id, session.venue_id -> venue
message.contact_id, action.minted_for_contact_id, turn.contact_id -> contact
message.sender_id -> sender, message.reply_to_action_id -> action
memory_fact.supersedes -> memory_fact, audit_entry.undo_of -> audit_entry

## Derived values — never stored, always computed

**Coverage** is the most important derived value in the product:

    exists (select 1 from session_coach sc
            where sc.session_id = :id
              and sc.declined_at is null
              and (sc.confirmed_at is not null or sc.arrived_at is not null))

It is a property of the session, which is why a coach dropping out while others
remain assigned changes nothing it returns.

Views, and **their names are exactly as written here.** The roster view is the
only one under the app schema; these three are unqualified, and prefixing them
with app. is an error rather than a near-miss:

  session_coverage(session_id, academy_id, starts_at, status, covered,
  pending_count, confirmed_count, declined_count)
  uncovered_session — the same, filtered to scheduled, uncovered, starts_at > app.now()

  unmarked_billable_session(academy_id, session_id, class_id, class_name,
  starts_at, unmarked_players, unbilled_amount)
  -- Finished, uncancelled sessions on a PER-SESSION rate whose register is still
  -- unmarked, so no tally_line exists for them yet and none will until somebody
  -- marks it. This is the answer to "is anything sitting unbilled" — ask it here
  -- rather than deriving it, because the derivation is where it goes wrong: a
  -- per_month, per_term or per_package class bills on the 1st (or on the pack)
  -- whatever the register says, so an unmarked register on one of those owes
  -- NOTHING and saying otherwise sends an owner hunting for money that was never
  -- missing. Those rows are excluded here by construction. An empty result is a
  -- real answer: nothing is waiting on a register.

**Effective rate** lives on the enrollment and defaults from the class:
coalesce(enrollment.rate_amount, class.rate_amount), and the same for rate_unit
and rate_count. This is what handles drop-ins inside a monthly batch, sibling
discounts, scholarship players and legacy rates without a schema branch.

**Billing rules, complete — all four rate units:**
- per_session: a 'session' line when attendance is marked present, late or
  absent. NOT for cancelled_timely.
- per_month: one 'monthly' line per period per active enrollment, on the 1st.
  Attendance does not affect it.
- per_term: the same, one 'term' line every rate_count months. Term and quarterly
  fees differ from monthly in exactly this and nothing else.
- per_package: one 'package' line when a package opens; sessions consume it on the
  per_session rule; after rate_count sessions the next session opens a new package
  and writes the next line. The count remaining rides on the tally.
- The cancellation window carries money meaning only for per_session. For the
  other three it is a headcount signal to the coach.
- An adjustment is ONE primitive: kind='adjustment', a negative amount, a reason
  and an approved_by. There is no waive table, refund object or discount column.
  The free first class is one of these, per player, not per account.

**Balance for a period** = sum(tally_line.amount) - sum(confirmed payment.amount).

## What follows what — the consequences a row carries

Facts about how these tables behave together, so a write you compose has the same
consequences a prewritten one would have had.

**A weekly slot implies dated sessions.** Insert a class_slot and the sessions
materialise for the next three weeks, by themselves, whatever wrote the slot —
a change to the slot rematerialises the future without touching attendance
already marked or cancellations already made, and a coach on class_coach reaches
every future session of that class. So a class is: one class row, its class_slot
rows, its class_coach rows. Nothing else, and nothing schedules sessions by hand.

**A session is never deleted.** Cancelled is a status with a reason; moved is new
times on the same row. History, attendance and the coach set survive both. What
was billed for a cancelled session is credited back with an offsetting
tally_line, or the family pays for a session that did not happen.

**Ending is a date, never a delete.** enrollment.ended_on stops the billing and
the reminders from that date and keeps every past row attributed; coach.ended_on
does the same and turns whatever was assigned past it into uncovered sessions,
which the product already understands. player.active = false is the person
leaving entirely.

**A charge is one row and it is shown verbatim.** tally_line.description reaches
the parent exactly as written. A waiver, a credit, a pro-rate and a goodwill
gesture are one primitive — kind='adjustment', a negative amount, a reason, and
approved_by set to whoever approved it — and the 'adjust' plan step writes it
with approved_by filled in for you. There is no waive table and no discount
column.

**Money moves in two rows, never one.** payment with status='requested' is a
request; status='confirmed' with confirmed_at and confirmed_by is money that
arrived. Confirm a specific payment by its id — matching on an amount confirms
whichever request happens to match, which is how the wrong month gets settled.

**Going live is a state, and it gates every proactive send.** academy.
onboarding_state moves setup → roster → ready → live, and until it is 'live' no
reminder, digest or announcement reaches anybody. A business with no active class
has nothing to go live with.

**A class name is unique while the class is open.** So a second "Beginners" is
refused rather than created, and an ended class frees its name for next season.

## SQL helpers (all stable, all safe to call in a read)

app.now() -> timestamptz            -- the only clock. use it everywhere.
app.session_is_covered(session_id uuid) -> boolean
app.effective_rate(enrollment_id uuid) -> table(amount numeric, unit text, cnt int)
app.account_balance(account_id uuid, period date /* null = running */) -> numeric
app.is_solo(academy_id uuid) -> boolean   -- shaping only, never gating
`

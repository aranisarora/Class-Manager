/**
 * lib/agent/schema-doc.ts — the schema layer of the stable prefix (§4.4).
 *
 * @mechanism SCHEMA_DOC — the data model as one plain string constant, byte-identical
 *   for every academy on every turn forever, which is the whole reason the automatic
 *   KV cache matches this prefix at 3.2% of the miss price. Anything computed, dated or
 *   per-tenant in here breaks that for every tenant at once. `npm run check:schema-doc`
 *   reads it against the real database, so the prompt cannot go on describing columns
 *   the migrations no longer have.
 *
 * @mechanism permission matrix — who may select, insert, update and delete each table,
 *   carried in the prefix because it is the one class of fact the model cannot derive
 *   from inside a session: policies are invisible there, so the boundary could only be
 *   found by crossing it, and crossing it costs a write refused mid-plan or an UPDATE
 *   that matches nothing and says nothing, then a whole round to re-plan. `npm run
 *   check:rls-doc` reads the grid against pg_policies in both directions, because two
 *   authors of one truth always drift and this one is made to read the other.
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
 * is a fact about the data model, which is PREFIX-RULES.md's rung 2, and it is the one
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
 *
 * **The views have one section now** (18 Aug 2026, migration 0036). They were in
 * three places — the roster under sessions, coverage under derived values,
 * coach_public inside the `coach` comment — which is fine for looking one up and
 * useless for the thing that actually matters, which is knowing that the set
 * exists at all. A model that has not formed the concept *the database holds
 * answers* rebuilds every answer.
 *
 * **The section is ordered by grain now** (19 Aug 2026, migration 0037). A
 * business is asked about at four: the OFFER it sells, the COMMITMENT somebody
 * made to it, the dated OCCURRENCE, and the money CONSEQUENCE. 0036 built for
 * three of them and left the offer with nothing — which is the only grain a
 * stranger can ask at, since a prospect has no enrolment, no session and no
 * account. Hence class_offering, account_ledger and coach_pay, and hence the
 * order below: a reader who knows which grain they are on can find the one
 * relation that answers, and that is the whole job of this section.
 *
 * With them came the deletions that make them land. `app.account_balance()` had
 * existed since the first commit and the model called it **zero times in every run
 * ever recorded**, because this block handed over the arithmetic — "Balance for a
 * period = sum(tally_line.amount) - sum(confirmed payment.amount)" — and a formula
 * in the prompt beats a helper in the database every time. The rule that follows
 * is in PREFIX-RULES.md: a view arrives with the deletion of whatever derivation it
 * replaces, in the same change, or all you have added is surface.
 *
 * That particular formula was worse than redundant. It named a PERIOD balance and
 * gave an expression with no period predicate on either side, while
 * lib/jobs/handlers/money.ts refuses the same computation outright — "payment
 * carries no period, so a payment cannot be attributed to a month and 'what is
 * owed for August' is not a computable quantity here". Three authors and three
 * answers, on money. What replaced it is the fact underneath: which of the two
 * tables carries a period, and therefore which questions have answers.
 */
export const SCHEMA_DOC = `# Schema

Postgres. You author SQL against these tables directly.

- Every table has: id uuid pk, created_at timestamptz.
- Every table except academy, tenant, sender, job, arrival, sim_* also has academy_id uuid not null.
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
| coach_ledger | admin · coach, their own | admin | admin | - |
| rate_period | admin · coach, their own pay · family, their own enrolments · class rates, anyone | - | - | - |
| business_rule | admin · the shared ones | admin | admin | - |
| comm_preference | admin · their own | admin · their own | admin · their own | - |
| memory_fact | admin · their own person facts | - | - | - |
| message | admin · their own thread | - | - | - |
| pending_request | admin · their own | - | - | - |
| action | their own | - | their own | - |
| row_snapshot | all | - | - | - |
| job · audit_entry · turn · turn_record · sender · arrival · tenant | - | - | - | - |

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
- **The views inherit the reader.** Every one of them runs with the permissions
  of the person you are serving, so a register read in a family's session is
  their own children and nothing else, a coach's coverage is their own sessions,
  and an account nobody may see is a row that is not there rather than a balance
  of zero. coach_directory and class_coach_public are the two exceptions: they
  are every coach in the business, and the whole class-to-coach map, to anybody
  who asks. Both carry the name for that reason — reaching for one through
  person puts the reader's own limits back on and quietly empties them.
- **academy is update only.** You may change the business's own settings. There
  is no route to a second academy and no reason to look for one.

When the cell is not yours, the plan is not "try it and see": it is to say what
you can do and route the rest to the admin, in the same message.

Money is numeric(10,2), rupees. Timestamps are timestamptz, and one read as a
local time is what sends somebody to a hall at the wrong hour — so a time
reaches a person through app.local_label(ts), which renders it in this
academy's zone the way the rest of the product writes it ("Mon 18 Aug, 6:30 pm"),
or app.local_clock(ts) for the time alone.

## Tenancy and place

academy(name! text, category text, timezone text, cancellation_window_hours int,
  client_reminder_lead_hours int, morning_brief_at time, evening_digest_at time,
  rail text 'rail1|rail2', upi_handle text, memory text,
  settings jsonb, created_on date,
  onboarding_state text 'setup|roster|ready|live')
venue(name! text, address text, notes text)

## People — three separate concerns, and roles compose

person(full_name! text, notes text, memory text, settings jsonb)
contact(person_id! uuid, phone_e164! text, wa_id text, profile_name text,
  is_primary bool, state text 'registered|engaged|opted_out',
  opted_out_at tstz, last_inbound_at tstz, role_hint text, tier_state jsonb,
  arrived_as text 'parent|coach|owner|unsure'
  /* what they told the FRONT DESK they were, before this business knew anything about
     them. Evidence, never a grant — coach, academy_admin and account decide what somebody
     may do and this decides nothing. Null for anybody who did not arrive through a desk,
     which is most rows. */,
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
  -- answer; coach_directory is the way through, and it carries the name. The
  -- admin sees all of coach, so from an admin session this does not arise.
  -- What a coach is OWED is coach_pay, which inherits the reader the same way
  -- this table does.
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
  client_cancel, decline_coach, confirm_coach, opt_out, undo, routed_request */, subject! text
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

## Money

tally_line(account_id! uuid, player_id uuid null, class_id uuid null, period! date
  /* 1st of the billing month */, kind! text
  'session|monthly|term|package|adjustment', description! text /* shown verbatim
  to the parent */, amount! numeric /* negative = credit */, session_id uuid,
  reason text, approved_by uuid -> person, dedupe_key text,
  rate_amount numeric, rate_unit text, rate_count int /* the terms this line was
  computed at, frozen. A later raise cannot reprice it, and on a package line
  rate_count is THAT PACK'S size, not the class's current one. */)
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

rate_period(subject_kind text 'enrollment|class|coach', subject_id uuid,
  amount numeric, unit text, rate_count int, effective_from! date /* the day it
  STARTS APPLYING — not the day it was typed; created_at is that */, note text)
  -- READ ONLY, and you do not need to write it. A rate change starting NOW is
  -- an ordinary  update enrollment set rate_amount = ...  exactly as before — the row here is
  -- written for you, BY the row. A change starting LATER is the set_rate
  -- operation, and it is the only way to say "from September" and have it be true.
  -- Read it through app.rate_on / app.pay_on, or the rate_history view. Do not
  -- hand-roll the lookup: enrolment falls back to class for amount, unit and count
  -- INDEPENDENTLY, and each of those has its own dated history under it.

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
  expired_reason text, subject_key text /* unused: see 0047 */)
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

**Coverage** is the most important derived value in the product, and it is
already computed: session_detail.coverage. It is a property of the SESSION, not
of any one coach — which is why a coach dropping out while others remain
confirmed changes nothing it says. The fact underneath, and the reason a name is
not an answer: being assigned is a row in session_coach, and being cover is that
row carrying a confirmed_at or an arrived_at and no declined_at. Those are
different rows on different days, and only the second one means somebody is
turning up.

**The rate that applies** lives on the enrollment and falls back to the class —
amount, unit and count each independently. So class.rate_amount is a default and
not the price anybody is necessarily paying, and that one fallback is what
carries drop-ins inside a monthly batch, sibling discounts, scholarship players
and legacy rates without a schema branch. class_roster has it resolved per
player already, and its rate_source says which side answered;
app.effective_rate(enrollment_id) resolves a single one.

**A rate also has a date, and the date is the point.** Those columns are the rate
in force NOW. What it was on any other day is app.rate_on(enrollment_id, that day)
and app.pay_on(coach_id, that day), and **pricing something that already happened
uses the day it happened**: a session that ran at 900 bills 900 however many
raises have landed since. A change that starts later is a row waiting —
class_roster and class_offering carry next_rate_amount and next_rate_from, so "is
it going up" is a column and not a calculation, and rate_history is the whole
story with standing = past | current | scheduled. To make one, use set_rate; a
plain update takes effect immediately and there is nowhere in it to put a date.

**Billing rules, complete — all four rate units:**
- Every one of these prices at the rate in force ON THE DAY THE THING WAS EARNED
  — the session's own date for per_session, the 1st of the period for per_month
  and per_term, the day the pack opened for per_package — and the line then
  carries that rate in rate_amount/rate_unit/rate_count and does not move again.
- per_session: a 'session' line when attendance is marked present, late or
  absent. NOT for cancelled_timely.
- per_month: one 'monthly' line per period per active enrollment, on the 1st.
  Attendance does not affect it.
- per_term: the same, one 'term' line every rate_count months. Term and quarterly
  fees differ from monthly in exactly this and nothing else.
- per_package: one 'package' line when a package opens; sessions consume it on the
  per_session rule; after THAT PACK'S OWN rate_count — tally_line.rate_count on the
  line that opened it, not the class's current one — the next session opens a new
  package and writes the next line. The count remaining rides on the tally.
- The cancellation window carries money meaning only for per_session. For the
  other three it is a headcount signal to the coach.
- An adjustment is ONE primitive: kind='adjustment', a negative amount, a reason
  and an approved_by. There is no waive table, refund object or discount column.
  The free first class is one of these, per player, not per account.

**A balance is running, and a balance "for a month" is not a quantity this schema
holds.** tally_line carries a period; payment does not. So a charge belongs to a
month and a payment belongs to nothing, and deciding which month a payment
settles is an allocation policy nobody here has stated — inventing one is how an
invention acquires the authority of policy. Because the two sides cannot be
matched to each other, time order is the only way to read them together — which
is exactly what account_ledger is, and why it is a ledger rather than a summary.
Two real numbers exist and they answer different questions: the running balance,
which is account_standing.balance and equally the last running_balance in the
ledger; and one month's CHARGES, which is the ledger's charge rows for that
period. Anything that looks like a monthly balance is neither, and it is the
shape that puts a family in credit for a month they have not paid for.

## The views — the same answers, already joined

A view here is not a shortcut for a query you could write. It is a join that was
being written on every turn that needed it, with the predicate that kept going
wrong written in once — so what it buys is not typing, it is the part of the
answer you would not have thought to ask for. Reading one costs the same round as
reading a table and comes back carrying the rows AROUND the one you came for:
the coach who is also assigned, the child who left but whose enrolment never
ended, the payment nobody confirmed. That is the read that changes a sentence,
and it is the one that is most expensive to compose from scratch.

**Their names are exactly as written here.** app.session_roster is the only one
under the app schema; prefixing any of the others with app. is an error rather
than a near-miss.

**The offer — what the business sells.**

  class_offering(academy_id, class_id, class_name, active, starts_on, ends_on,
  standing, rate_amount, rate_unit, rate_count, next_rate_amount, next_rate_from,
  venue_id, venue_name,
  venue_address, slot_count, schedule_label, slots, coaches)
  -- One row per class: what it costs, where it is, who is named on it, and when
  -- it runs with the weekly slots ALREADY RENDERED — schedule_label is
  -- "Mon 7 am-8 am; Wed 7 am-8 am", slots a json array of
  -- {weekday, day, starts, ends, label}. Render none of it yourself: a slot has
  -- no timestamp, so app.local_label cannot reach it, and to_char(weekday,'ID')
  -- is a numeric mask that returns junk for every row without erroring.
  -- standing is closed | ended | upcoming | running — the whole of "is this
  -- class on", so do not rebuild it from active and ends_on.
  -- The one relation that answers somebody with no enrolment, session or
  -- account. It carries no headcount; that is class_roster.

**The day.**

  session_detail(academy_id, session_id, class_id, class_name, starts_at,
  ends_at, status, cancel_reason, local_date, local_start, local_end, venue_id,
  venue_name, venue_address, coverage, coaches, due_players, marked_players,
  attended_players)
  -- One session as a person hears it, with the start already rendered in this
  -- academy's zone: local_start is "Mon 18 Aug, 6:30 pm", local_end the closing
  -- time alone.
  -- coverage answers "is this covered" and is the only column that does:
  -- cancelled | confirmed | nobody has answered | all declined | nobody
  -- assigned. coaches is a json array of {coach_id, name, state} and answers a
  -- DIFFERENT question — who is down for it. A name there is not cover;
  -- 'assigned_no_answer' means nothing has come back and does not say anybody
  -- was even asked. Reading the names instead of coverage reports a week nobody
  -- has confirmed as a covered one.
  -- Not covered, from here: where coverage not in ('confirmed','cancelled')

**The register.**

  app.session_roster(academy_id, session_id, class_id, starts_at, class_name,
  enrollment_id, is_trial, player_id, player_name, account_id,
  attendance_status /* null until marked */, marked_at)
  -- One row per player due at that session. The join is enrollment → player →
  -- person, narrowed by the enrolment's date range against the session's own
  -- date in this academy's timezone, and it is the same join every time. Written
  -- by hand it is four tables and a date predicate, and it already excludes
  -- players who are no longer active and enrolments that had not started or had
  -- already ended on the day.

  class_roster(academy_id, class_id, class_name, enrollment_id, is_trial,
  started_on, player_id, player_name, account_id, account_holder, rate_amount,
  rate_unit, rate_count, ended_on, standing, player_active, rate_source,
  next_rate_amount, next_rate_unit, next_rate_count, next_rate_from)
  -- Who is on a class's register, in every tense, and what each is actually
  -- paying: the rate columns are the effective rate, already resolved.
  -- standing is upcoming | current | ended — FILTER ON IT, never on dates. It
  -- folds in the two things a hand-written version drops: a player who LEFT the
  -- academy still sits on an enrolment that never ended (active is on player),
  -- and "ended_on is null" is the right test for today and wrong for any other
  -- day. An enrolment starting next week is here as 'upcoming' rather than
  -- missing, which is what makes "is he in the class or not" answerable.
  -- next_rate_amount and next_rate_from are a change already on file for THIS
  -- player, null when there is none — so "is it going up" is a column and not a
  -- calculation. A class rise does not reach an enrolment that states its own
  -- rate, and these stay null when it does not.
  -- rate_source is 'enrolment' or 'class' — which side the fallback took, and
  -- so whether a price was written down for this player or merely inherited.
  -- That is how you check that "everyone already in it stays on the old rate"
  -- actually happened.

  unmarked_billable_session(academy_id, session_id, class_id, class_name,
  starts_at, unmarked_players, unbilled_amount)
  -- Finished, uncancelled sessions on a PER-SESSION rate whose register is still
  -- unmarked, so no tally_line exists for them yet and none will until somebody
  -- marks it. This is the answer to "is anything sitting unbilled" — ask it here
  -- rather than deriving it, because the derivation is where it goes wrong: a
  -- per_month, per_term or per_package class bills on the 1st (or on the pack)
  -- whatever the register says, so an unmarked register on one of those owes
  -- NOTHING and saying otherwise sends an owner hunting for money that was never
  -- missing. Those rows are excluded here by construction. An empty result
  -- answers about MONEY only: no bill is waiting on a register. It is not "every
  -- register is marked" — an unmarked per_month, per_term or per_package register
  -- never appears here at all. Whether a register was actually taken is
  -- session_detail, marked_players against due_players on a finished session.

**The books.**

  account_standing(academy_id, account_id, display_name, holder_person_id,
  holder_name, holder_contact_id, charged, paid, balance, awaiting_confirmation,
  last_payment_at, last_charge_period, players)
  -- Where an account stands. charged is every tally line ever raised on it, paid
  -- every confirmed payment, balance the difference — positive means they owe,
  -- negative means they are in credit. awaiting_confirmation is money somebody
  -- says they sent that nobody has attested, which is why it is not in paid and
  -- why "they have not paid" and "nobody has checked" are answerable apart.
  -- last_payment_at is usually the real question behind a question about a
  -- month: whether anything has come in at all.

  account_ledger(academy_id, account_id, movement_id, kind, at, local_at,
  description, amount, effect_on_balance, running_balance, period, charge_kind,
  status, method, reference, player_id, session_id, reason, charges_in_period)
  -- The statement behind the balance: one row per movement, charges and
  -- payments interleaved, oldest first. account_standing says how much, this
  -- says why — which charges, was July billed twice, has the UPI landed.
  -- kind is 'charge' or 'payment'. Three money columns, one thing each: amount
  -- is what the row says (negative on a credit or waiver); effect_on_balance is
  -- what it MOVED the balance by, zero for a payment only requested;
  -- running_balance is the balance after it, and the last equals
  -- account_standing.balance.
  -- charges_in_period counts charge lines sharing that period on that account.
  -- Two is a fact, not a verdict — a second line in a month is legitimate for a
  -- sibling, a package or a pro-rate — but it is what "have I been charged
  -- twice" turns on, and no total can show it.

**The people.**

  person_directory(academy_id, person_id, full_name, contact_id, phone_e164,
  contact_state, opted_out_at, last_inbound_at, window_open, coach_id,
  coach_status, account_id, player_id, open_questions, mutes)
  -- Anybody, and what they are to this business. What the top of this
  -- conversation tells you about the person in front of you, this tells you
  -- about the person they are talking ABOUT: what that person was asked and has
  -- not answered (open_questions, each carrying whether it is past its expiry),
  -- what they asked not to hear about (mutes, the live ones — a mute whose until
  -- date has passed is not here, because it no longer stops anything), whether
  -- they have opted out, and whether their 24-hour window is open right now.
  -- These are the same facts, on the same terms, that the top of this
  -- conversation gives you for the person in the seat.
  -- A row with no coach_id, account_id or player_id is somebody who holds
  -- no role yet — never somebody who is not there. Names are matched here, so a
  -- person who turns out to be a coach rather than a parent still comes back,
  -- which is not true of a join that starts at account.

  coach_directory(academy_id, coach_id, person_id, full_name, status, ended_on)
  -- Every coach in the business, BY NAME, with no pay column to leak. coach
  -- itself is own-row-only for anybody but the admin, so "who else is on this
  -- session" reads zero rows there and that zero is not an answer.
  -- READ IT ON ITS OWN. Joining person for a name undoes it — person is scoped
  -- to your own row, your family, your rosters and the co-coaches on YOUR
  -- sessions, so the join deletes the very coaches this exists to show and the
  -- shortfall reads as an answer.

  class_coach_public(academy_id, class_id, coach_id, person_id, full_name,
  status)
  -- Which coach is named on which CLASS, with names and no pay, and the same
  -- warning: read it on its own. class_coach is own-row-only for a coach, so
  -- reading that directly says "nobody is on it" of every class but their own.
  -- Who is on a dated SESSION is session_detail.coaches.

**What a coach is owed.**

  coach_pay(academy_id, coach_id, coach_name, session_id, class_id, class_name,
  starts_at, local_start, session_status, coach_state, pay_unit, pay_amount,
  session_hours, worked, amount_for_session, pay_amount_then, amount_then)
  -- One row per coach per session they are named on. Inherits the reader, so a
  -- coach reads their own pay and no one else's and the admin reads all of it —
  -- which is what makes "what have I earned" and "what do I pay them" one
  -- number instead of two guesses.
  -- worked = the session is OVER, was not cancelled, and they did not decline.
  -- Not that a register was marked, and never status='scheduled', which is true
  -- only of sessions that have NOT happened — counting on it reports a month of
  -- work as none.
  -- amount_for_session is at the rate they are on NOW and is the right number for
  -- the OPEN month. amount_then is at the rate in force the day it was worked, and
  -- that is what a closed month is written from.
  -- amount_for_session is NULL on a per_month coach: they are owed the same
  -- whatever the register says, so sessions × rate is a number nobody is owed.
  -- Also NULL when pay_amount is, which is "not tracked" and a real state.
  -- It multiplies by coach.pay_amount, which is the rate they are on NOW. So it
  -- describes the month in progress, and a month already closed has a row of its
  -- own in coach_ledger.

  coach_ledger(coach_id! uuid, period! date /* 1st of the month the work falls
  in, the same meaning as tally_line.period */, kind! text
  'session|hourly|monthly|adjustment', description! text /* shown verbatim to the
  coach */, amount! numeric /* negative for a correction */, dedupe_key! text,
  rate_amount numeric, rate_unit text 'per_session|per_hour|per_month',
  session_id uuid /* per-session and per-hour lines only */, reason text
  /* adjustments only */, approved_by uuid -> person /* adjustments only */)
  -- The one TABLE in this section, not a view, and the only one here you may
  -- write. It carries the ordinary id/created_at/academy_id like every other
  -- table, so those are not repeated in the signature.
  -- unique(academy_id, dedupe_key)
  -- dedupe_key is NOT NULL and has NO DEFAULT — unlike tally_line's, which may be
  -- null. An insert that omits it is refused and takes its whole plan with it,
  -- and it is NOT academy_id: it is what "the same pay line" MEANS, said in ids,
  -- never composed from description. Use the shape the runtime's own writer uses
  -- (lib/billing-keys.ts, coachLedgerKey) or your row and its row will not
  -- recognise each other and the coach is paid twice:
  --   cs:<coach_id>:<session_id>      a per-session coach, one line per session worked
  --   ch:<coach_id>:<session_id>      a per-hour coach, the hours are on the row
  --   cm:<coach_id>:<period>          a per-month coach, one line for the month
  --   ca:<coach_id>:<period>:<slug>   a correction; the slug is what makes it distinct
  -- period in a key is yyyy-mm-dd, the first of the month, and nothing else — a
  -- key that differs by its own formatting is the duplicate it exists to prevent.
  -- One row per coach per session worked, or one per month for a per_month coach,
  -- written when the month closes — with the rate that applied at the time copied
  -- into rate_amount rather than referenced.
  -- That copy is what makes a closed month answerable: coach.pay_amount is a single
  -- mutable number, so a raise granted today moves every figure coach_pay derives,
  -- including for months already worked. These rows do not move.
  -- A rate agreed in advance is a row written early — a September line can exist in
  -- August, and the close finds it by dedupe_key and leaves it alone.
  -- Append-only. A correction is an 'adjustment' row, as on tally_line.

  rate_history(academy_id, subject_kind 'enrollment|class|coach', subject_id,
  subject_label, amount, unit, rate_count, effective_from, effective_to, standing,
  note, stated_at, stated_by_name)
  -- One row per time a price actually MOVED, for an enrolment, a class or a coach.
  -- standing is past|current|scheduled — filter on that word, never on date
  -- arithmetic, and never rebuild effective_to with a window function of your own.
  -- A rate stated on a CLASS applies to every enrolment that has not stated its
  -- own, which is the same fallback class_roster.rate_source names.

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
reminder, digest or announcement reaches anybody.

**What the database asks for before it will let you go live: ONE active, non-ended
class. That is the whole of it.** It does not ask for a venue, a coach, a family, a
rate, a UPI handle or any of the other setup steps — a business can go live with a
timetable and an empty roster, and often should, because the introduction that goes
to every family who has never heard from it is one of the things going live turns ON.
The check is a trigger, so it is invisible from inside a session and can only be
found by crossing it: with no class the write is refused, and with one class nothing
else stands in the way. Say that to an owner rather than a longer list.

**A class name is unique while the class is open.** So a second "Beginners" is
refused rather than created, and an ended class frees its name for next season.

## SQL helpers (all stable, all safe to call in a read)

app.now() -> timestamptz            -- the only clock. use it everywhere.
app.local_label(at timestamptz) -> text   -- "Mon 18 Aug, 6:30 pm", this academy's zone
app.local_clock(at timestamptz) -> text   -- "6:30 pm"
app.session_is_covered(session_id uuid) -> boolean
app.effective_rate(enrollment_id uuid) -> table(amount numeric, unit text, cnt int)
  -- the rate in force NOW. unchanged, and still the right call for "what does
  -- this cost".
app.rate_on(enrollment_id uuid, on date) -> table(amount numeric, unit text, cnt int)
  -- the same answer for any day. Pricing something that ALREADY HAPPENED uses the
  -- day it happened — the session's own date, the period being billed — never today.
app.pay_on(coach_id uuid, on date) -> table(amount numeric, unit text)
app.today(academy_id uuid) -> date        -- today in this academy's own zone
app.account_balance(account_id uuid, null) -> numeric
  -- the running balance, same number as account_standing.balance. NULL means no
  -- such account is visible to you, never zero. A non-null period is refused
  -- outright, for the reason above: payment carries no period.
app.is_solo(academy_id uuid) -> boolean   -- shaping only, never gating
`

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
 */
export const SCHEMA_DOC = `# Schema

Postgres. You author SQL against these tables directly.

- Every table has: id uuid pk, created_at timestamptz.
- Every table except academy, sender, job, sim_* also has academy_id uuid not null.
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
  - WRITE (INSERT): **every INSERT must set academy_id = app.academy_id() explicitly,
    on every row, including rows in a multi-row VALUES list.** Nothing fills it in
    for you: the column is not defaulted, and the policy checks it, so an insert
    that leaves it out is refused with "new row violates row-level security
    policy" — which looks like a permissions problem and is a missing column.
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
  subtly wrong in production.
- Money is numeric(10,2), rupees. Timestamps are timestamptz; render in the
  academy's timezone, never raw.

## Tenancy and place

academy(name text, category text, timezone text, cancellation_window_hours int,
  client_reminder_lead_hours int, morning_brief_at time, evening_digest_at time,
  rail text 'rail1|rail2', upi_handle text, sender_id uuid, memory text,
  prompt_cache_handle text, settings jsonb, created_on date,
  onboarding_state text 'setup|roster|ready|live')
venue(name text, address text, notes text)

## People — three separate concerns, and roles compose

person(full_name text, notes text, memory text, settings jsonb)
contact(person_id uuid, phone_e164 text, wa_id text, profile_name text,
  is_primary bool, state text 'prospect|registered|engaged|opted_out',
  opted_out_at tstz, last_inbound_at tstz, role_hint text, tier_state jsonb,
  unique(academy_id, phone_e164))          -- a WhatsApp number
account(holder_person_id uuid, display_name text)
player(account_id uuid, person_id uuid, active bool)
coach(person_id uuid, pay_amount numeric, pay_unit text 'per_session|per_hour|per_month',
  status text 'added|invited|active|ended', invited_at tstz, onboarded_at tstz,
  ended_on date)
academy_admin(person_id uuid)
  -- a non-admin session sees only its own row here (usually none), by design:
  -- an empty read means "not yours to see", never "no admin exists". To reach
  -- the admin you never need this table: reply with to_contact_id 'admin', or
  -- handoff — the runtime resolves who that is.
memory_fact(subject_kind text 'academy|person', subject_id uuid, fact text,
  source text, supersedes uuid -> memory_fact, retired_at tstz)

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

class(name text, venue_id uuid, rate_amount numeric,
  rate_unit text 'per_session|per_month|per_term|per_package', rate_count int,
  starts_on date, ends_on date, active bool)
class_slot(class_id uuid, weekday int 0=Sun..6=Sat, start_time time, end_time time)
class_coach(class_id uuid, coach_id uuid)          -- pk(class_id,coach_id). DEFAULT coach set
enrollment(class_id uuid, player_id uuid, rate_amount numeric, rate_unit text,
  rate_count int, is_trial bool, started_on date, ended_on date)
session(class_id uuid, venue_id uuid, starts_at tstz, ends_at tstz,
  status text 'scheduled|cancelled|completed', cancel_reason text,
  unique(class_id, starts_at))
session_coach(session_id uuid, coach_id uuid, confirmed_at tstz, declined_at tstz,
  arrived_at tstz, running_late bool)              -- pk(session_id,coach_id). ACTUAL coach set
attendance(session_id uuid, player_id uuid,
  status text 'present|late|absent|cancelled_timely', note text,
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

tally_line(account_id uuid, player_id uuid null, period date /* 1st of the billing
  month */, kind text 'session|monthly|term|package|adjustment', description text
  /* shown verbatim to the parent */, amount numeric /* negative = credit */,
  session_id uuid, reason text, approved_by uuid -> person)
  -- unique(session_id, player_id) where session_id is not null
payment(account_id uuid, amount numeric, rail text, method text, reference text
  /* UPI ref / UTR */, status text 'requested|confirmed|failed', requested_at tstz,
  confirmed_at tstz, confirmed_by uuid -> person, evidence_url text)

## Messaging, actions, views, jobs, audit

sender(phone_e164, waba_id, credentials jsonb, label)  -- GLOBAL, no academy_id, never readable in a user session
message(contact_id, sender_id, direction 'inbound|outbound', catalog_id text,
  wa_message_id, template_name, body, payload jsonb, media_url,
  status 'queued|sent|delivered|read|failed', queued_at, sent_at, delivered_at,
  read_at, failed_reason, suppressed_reason, cost_paise int,
  conversation_category, in_window bool, reply_to_action_id, idempotency_key unique)
action(kind text, payload jsonb /* fully resolved */, minted_at, minted_for_contact_id,
  expires_at, consumed_at, consumed_by_contact_id)
job(kind text, run_at tstz, dedupe_key text unique, status text, attempts int,
  last_error text, payload jsonb, locked_at, locked_by)   -- GLOBAL
audit_entry(actor_person_id, intent text, plan jsonb, diff jsonb, undone_at, undo_of)
turn(contact_id, person_id, role_acted, input jsonb, output jsonb, model,
  prompt_tokens, output_tokens, latency_ms, error)

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

Views: session_coverage(session_id, academy_id, starts_at, status, covered,
pending_count, confirmed_count, declined_count) and uncovered_session — the same,
filtered to scheduled, uncovered, starts_at > app.now().

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

## SQL helpers (all stable, all safe to call in a read)

app.now() -> timestamptz            -- the only clock. use it everywhere.
app.session_is_covered(session_id uuid) -> boolean
app.effective_rate(enrollment_id uuid) -> table(amount numeric, unit text, cnt int)
app.account_balance(account_id uuid, period date /* null = running */) -> numeric
app.is_solo(academy_id uuid) -> boolean   -- shaping only, never gating
`

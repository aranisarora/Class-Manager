# Class Manager — product specification

> Build document. Everything needed to implement the product: behavior, data model, message catalog, state machines, scheduled work, and build order.
>
> **Stack:** Next.js (web surface + API), Supabase (Postgres, RLS, Storage), WhatsApp Cloud API (Meta, direct), Claude API. A durable job scheduler is required and is not optional — see §10.
>
> **Read §1 before writing any code.** Those rules are violated by omission, not by intent.

---

## 1. Invariants

Non-negotiable. Every one of these is a rule that a plausible-looking implementation will break silently.

1. **RLS is the security boundary; the LLM is a user of it.** Every conversation acts through a real per-user Postgres session. Tool availability is UX. Database policies are security. Every table carries `academy_id` and every policy has a regression test.
2. **Mint once, replay verbatim.** A button's action is authored at compose time, validated, and stored (§4.9). The tap replays the stored payload. No model inference at tap time, ever — that is where a misread commits someone to being somewhere.
3. **Read back before bulk.** Any write touching multiple people or sessions gets the resolved set read back — count, names, totals — before execution.
4. **Sending is not receiving.** `queued ≠ sent ≠ delivered ≠ read`. Enforced in schema, in code, and in copy. The bot never claims what it cannot see.
5. **Invariants live in the transaction layer.** A cancel that credits and notifies is one transaction, never a checklist the model must remember.
6. **Nothing is sent during onboarding until the admin says go.** Building the roster messages nobody.
7. **Parsed input is a proposal, never a write.** Anything read from an image, voice note or document is read back before it is acted on (§4.10).
8. **Every proactive message must pass one test:** would its recipient have asked for it? If no, it does not ship.

---

## 2. What the product is

Indian coaching businesses run on WhatsApp by hand — schedules, payment chasing, cancellations, parent communication. This moves that workload onto a WhatsApp-native manager. Clients book, pay and get reminded. Coaches get their day and mark attendance with taps. Admins run the business through natural language and menus.

**The chat is the interface. Nobody installs anything. Nobody logs in.** The web exists only as a rendering surface the bot links into (§11) — no navigation, no login, no app shell.

Every user is **WhatsApp-only by design**. A number not on WhatsApp is out of scope.

### 2.1 Bot character — the judgment rules

The spec cannot enumerate every decision. These resolve most of them:

- **Quiet by default.** No engagement pings, no "just checking in," no message whose only job is reminding people the bot exists.
- **Educator, reactively.** Capability hints surface when a message comes close to something the bot does. Never unsolicited.
- **Silence is escalated, never punished.** A coach who hasn't confirmed gets the admin told, not a scolding.
- **Speak the academy's language.** The admin names their classes; the bot echoes their words. Never invent a taxonomy and teach it to them.
- **UI is an offer, never a gate.** Nobody is forced through a form for something chat could do.

---

## 3. Data model

Postgres. Every table has `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`, and — except `academy` — `academy_id uuid not null references academy(id)`.

### 3.1 Tenancy and place

```sql
academy (
  name                      text not null,
  category                  text,            -- 'badminton', 'carnatic vocal' — free text, display only
  timezone                  text not null default 'Asia/Kolkata',
  cancellation_window_hours int  not null default 24,
  quiet_hours_start         time not null default '21:00',
  quiet_hours_end           time not null default '07:00',
  client_reminder_lead_hours int not null default 14,
  rail                      text not null default 'rail1',  -- rail1 | rail2
  upi_handle                text,
  settings                  jsonb not null default '{}'
)

venue (
  name        text not null,
  address     text,
  notes       text
)
```

`academy` is the tenant. **The word "academy" never appears in user-facing copy** — see §14.4.

### 3.2 People

Three separate concerns, deliberately. Collapsing them is what makes "parent pays for child" and "adult pays for self" look like two products.

```sql
person (                        -- a human. roles attach to this.
  full_name   text not null,
  notes       text
)

contact (                       -- a WhatsApp number
  person_id       uuid not null references person(id),
  phone_e164      text not null,
  wa_id           text,                     -- WhatsApp's id, set on first inbound
  is_primary      boolean not null default true,
  opted_out_at    timestamptz,
  last_inbound_at timestamptz,              -- drives the 24h window calculation
  unique (academy_id, phone_e164)
)

account (                       -- the payer. holds 1..n players.
  holder_person_id  uuid not null references person(id),
  display_name      text
)

player (                        -- attends. attendance, notes, progress hang here.
  account_id  uuid not null references account(id),
  person_id   uuid not null references person(id),
  active      boolean not null default true
)

coach (
  person_id     uuid not null references person(id),
  pay_amount    numeric(10,2),              -- null = not tracked, a valid state
  pay_unit      text,                       -- 'per_session' | 'per_hour' | 'per_month' | null
  status        text not null default 'added',  -- see §7.3
  invited_at    timestamptz,
  onboarded_at  timestamptz,
  ended_on      date                        -- soft end. never delete a coach.
)

academy_admin (
  person_id  uuid not null references person(id)
)
```

**The self-paying adult is `account.holder_person_id = player.person_id`.** Not a second case — the same objects at n=1. A parent with three children is n=3. There is no separate flow, onboarding path, or billing route.

**Roles compose.** A senior player who coaches juniors is one `person` with a `player` row and a `coach` row. A solo operator is one `person` with `academy_admin` and `coach` rows — which is what §8 is built on.

### 3.3 Classes and sessions

**One class noun.** There is no group/private/batch/one-off distinction in the schema, and the product never branches on one. A private class is a class with one enrollment. A camp is a class whose date range is a week. A batch is a class that repeats.

```sql
class (
  name          text not null,      -- the admin's own words: "6:30 Beginners Batch"
  venue_id      uuid references venue(id),
  rate_amount   numeric(10,2),
  rate_unit     text,               -- 'per_session' | 'per_month'
  starts_on     date not null,
  ends_on       date,               -- null = open-ended
  active        boolean not null default true
)

class_slot (                        -- weekly recurrence. a class may have several.
  class_id    uuid not null references class(id) on delete cascade,
  weekday     int  not null,        -- 0=Sun .. 6=Sat
  start_time  time not null,
  end_time    time not null
)

class_coach (                       -- the DEFAULT coach set
  class_id  uuid not null references class(id) on delete cascade,
  coach_id  uuid not null references coach(id),
  primary key (class_id, coach_id)
)

enrollment (
  class_id     uuid not null references class(id),
  player_id    uuid not null references player(id),
  rate_amount  numeric(10,2),       -- null = inherit from class
  rate_unit    text,                -- null = inherit from class
  started_on   date not null,
  ended_on     date
)

session (                           -- one occurrence. where reality is recorded.
  class_id       uuid not null references class(id),
  venue_id       uuid references venue(id),   -- overrides class venue when set
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  status         text not null default 'scheduled',  -- scheduled | cancelled | completed
  cancel_reason  text,
  unique (class_id, starts_at)
)

session_coach (                     -- the ACTUAL coach set. a SET, never a scalar.
  session_id    uuid not null references session(id) on delete cascade,
  coach_id      uuid not null references coach(id),
  confirmed_at  timestamptz,
  declined_at   timestamptz,
  arrived_at    timestamptz,
  running_late  boolean not null default false,
  primary key (session_id, coach_id)
)

attendance (
  session_id        uuid not null references session(id),
  player_id         uuid not null references player(id),
  status            text not null,   -- present | absent | cancelled_timely
  note              text,
  marked_by_coach_id uuid references coach(id),
  marked_at         timestamptz not null default now(),
  unique (session_id, player_id)
)
```

**Rate lives on the enrollment, defaulting from the class.** This handles drop-ins inside a monthly batch, sibling discounts, scholarship players and legacy rates without a schema branch. Resolution: `coalesce(enrollment.rate_amount, class.rate_amount)`.

**Coverage is derived, not stored:**

```sql
-- a session is covered if any assigned coach has confirmed or arrived
exists (select 1 from session_coach sc
        where sc.session_id = :id
          and sc.declined_at is null
          and (sc.confirmed_at is not null or sc.arrived_at is not null))
```

This is the single most important derived value in the product. **Escalations are about sessions, never about people** — "tomorrow's 6:30 has no confirmed coach," never "Arjun hasn't confirmed." A coach dropping out while others remain assigned is *information*, not an alarm, and this expression is why.

### 3.4 Money

```sql
tally_line (
  account_id   uuid not null references account(id),
  player_id    uuid references player(id),      -- null for account-level adjustments
  period       date not null,                    -- first day of the billing month
  kind         text not null,                    -- session | monthly | adjustment
  description  text not null,                    -- shown verbatim to the parent
  amount       numeric(10,2) not null,           -- negative for credits/waivers
  session_id   uuid references session(id),
  reason       text,                             -- adjustments only
  approved_by  uuid references person(id),       -- adjustments only
  unique (session_id, player_id)                 -- one session line per player, ever
)

payment (
  account_id    uuid not null references account(id),
  amount        numeric(10,2) not null,
  rail          text not null,                   -- rail1 | rail2
  method        text,                            -- upi | cash | bank
  reference     text,                            -- UPI ref / UTR
  status        text not null,                   -- requested | confirmed | failed
  requested_at  timestamptz,
  confirmed_at  timestamptz,
  confirmed_by  uuid references person(id),      -- rail1: the admin who attested
  evidence_url  text                             -- rail1: a forwarded screenshot
)
```

**Billing rules, complete:**

- `rate_unit = 'per_session'` → a `tally_line(kind='session')` is written when attendance is marked `present` or `absent`. Not for `cancelled_timely`.
- `rate_unit = 'per_month'` → a `tally_line(kind='monthly')` is written once per period per active enrollment, on the first of the month. Attendance does not affect it.
- **The cancellation window only carries money meaning for `per_session`.** For `per_month` it is a headcount signal to the coach and nothing more. Same UI, different consequence, no extra code.
- **Adjustments are one primitive, not six features.** Waiving a class, crediting an academy-cancelled session, pro-rating a mid-month join, a sibling discount, goodwill, and the free trial are all `tally_line(kind='adjustment')` with a reason and an approver.
- **The free first class is a rule that mints an adjustment** — a negative line equal to the first `session` line for a player. **Per player, not per account.** A second child gets their own trial.
- Balance for a period = `sum(tally_line.amount) - sum(payment.amount where confirmed)`.

### 3.5 Messaging and actions

```sql
message (
  contact_id      uuid not null references contact(id),
  direction       text not null,                  -- outbound | inbound
  catalog_id      text,                           -- e.g. 'CO-COMING', see §9
  wa_message_id   text,
  template_name   text,                           -- null when inside the 24h window
  body            text,
  payload         jsonb,                          -- the rendered WhatsApp payload
  media_url       text,
  status          text not null default 'queued', -- queued|sent|delivered|read|failed
  queued_at       timestamptz not null default now(),
  sent_at         timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz,
  failed_reason   text,
  idempotency_key text unique                     -- REQUIRED on every outbound
)

action (                          -- §1.2. the payload rule.
  kind          text not null,    -- 'confirm_session' | 'claim_cover' | 'mark_absent' | ...
  payload       jsonb not null,   -- fully resolved. no ids to look up, no text to reparse.
  minted_at     timestamptz not null default now(),
  minted_for_contact_id uuid not null references contact(id),
  expires_at    timestamptz,
  consumed_at   timestamptz,
  consumed_by_contact_id uuid references contact(id)
)
```

**Every interactive button carries an `action.id` as its reply payload.** On tap: load the action, check `expires_at` and `consumed_at`, check the tapping contact matches `minted_for_contact_id`, execute the stored payload, stamp `consumed_at`. **No model call. No re-resolution. No string parsing.** A button can never do something other than what its label said.

### 3.6 Jobs

```sql
job (
  kind        text not null,        -- see §10
  run_at      timestamptz not null,
  dedupe_key  text not null unique, -- e.g. 'coach_coming:<session_id>'
  status      text not null default 'pending',  -- pending|running|done|failed|skipped
  attempts    int not null default 0,
  last_error  text,
  payload     jsonb not null default '{}'
)
```

`dedupe_key` is what makes rescheduling and retries safe. Enqueueing the same key twice is a no-op.

### 3.7 RLS policy summary

| Role | Sees |
|---|---|
| Admin | Everything within their `academy_id`. |
| Coach | Own `coach` row (including own pay). Sessions they are assigned to, and those sessions' rosters and attendance. **Never** other coaches' pay, never the academy's money. |
| Account holder | Own `account`, its `player` rows, their enrollments, attendance, tally lines and payments. Sessions their players are enrolled in. **Never** other families. |
| Player contact | Same as their account holder, minus everything with `kind` in (`session`,`monthly`,`adjustment`) — money-shaped rows never route to a player number. |

Every policy gets a regression test asserting cross-tenant and cross-role reads return zero rows. This is not optional coverage; it is the security model.

---

## 4. Behavior: the admin

### 4.1 Naming

**"Admin," not "owner" or "founder."** It is the word Indian coaching businesses, gyms and tuition centres actually use, it names a role rather than a status, and it survives the solo case without sounding strange. At a large academy an employed manager wears the hat; at a small one it is the coach.

### 4.2 Onboarding

The unavoidable cost of adoption is **data entry**. Reducing it is the highest-leverage work in the product.

**The rule: one class, end to end, before anything else.** A timetable with eight classes and 120 players is an hour of setup before any value arrives — and value lands when a parent gets a useful reminder, not when the database is full. Set up one class, watch it run for a week, add the rest after.

1. **Setup Flow** (§4.8) — one screen sequence, because a dozen chat round-trips is a dozen small waits. Collects: business name, category, one venue, one class with slots and rate, cancellation window. Read back before creating anything.
2. **Bring the rest however it already exists** (§4.10). A photo of the timetable on the whiteboard. A photo of the paper register. A forwarded spreadsheet. A voice note describing the week. **This is the single biggest friction reducer in the product.**
3. **Coaches** — §7.1.
4. **Families** — §6.1.
5. **Payments** — one UPI handle, Rail 1, under a minute.

**Joining mid-cycle:** the admin marks who has already paid and until when. Counting starts fresh; **nobody is ever chased for money from before the platform**.

End state after one sitting: a working class, and **no parent messaged yet**.

### 4.3 Day-to-day

- **A natural-language CLI over the whole business.** Schedule and move classes, manage coaches and clients, waive a class, broadcast (guardrailed, §12), ask anything. Full CRUD as conversation.
- **Menus as the missing nav bar.** A blank chat box with dozens of capabilities discovers worse than an ugly nav bar. A persistent list-picker — *Schedule / Clients / Money / Coaches / Insights* — is the primary affordance; prose is the fallback.
- **Two bookends, quiet between.** Morning brief led by *Needs you*; evening digest. Between them only genuine escalations interrupt. **The admin's phone is a briefing, not a ticker.**
- **Proof it's working.** *"Did Meera get the reminder?"* answers from `message` status. Failures surface as fixable alerts.
- **Insights on demand**, rendered as views for anything spatial or dense (§11).
- **Audit trail and an undo window** on destructive bulk operations. At multi-tenant scale a bot mistake is someone else's business.

---

## 5. Behavior: the coach

### 5.1 Onboarding

Three constraints: the coach is a **warm contact** (the admin employs them), **turnover is high**, and therefore the admin runs this **several times a year**. Design target: **under a minute for the admin, one tap for the coach.**

**Step 1 — the admin supplies three facts.** Contact (vCard or name + number), which classes, pay rate. Nothing else. No availability grid — the admin assigns the coaching, so there is nothing to declare. `coach.status = 'added'`. **Messages nobody.**

**Step 2 — the invite, self-initiated.** The bot drafts a short message in the admin's voice; the admin forwards it from their own number. It carries a `wa.me` deep link with prefilled text. The coach taps, sends, and **the window opens from their side** — free, no template, no block risk, no tier consumption. `coach.status = 'invited'`.

**Step 3 — first run is one confirmation, not a questionnaire.** [`CO-INVITE-CONFIRM`, §9.2]

> Hi Arjun — I'm Class Manager, I handle scheduling for Ace TT Academy. Sharwin added you as a coach.
> Your classes:
> • Mon/Wed/Fri 6:30–7:30 pm — Beginners, Green Park
> • Sat 8–10 am — Advanced, Green Park
> **[Looks right]** **[Something's wrong]**

*Looks right* → `coach.status = 'active'`, `onboarded_at` stamped. *Something's wrong* routes to the admin — **the coach does not edit the catalog**, the admin owns it.

**Step 4 — proof, not promises.** Immediately: their next session, what will happen before it, what they'll be asked after it. Then the pin-the-chat ask.

**Never asked:** availability, personal details, a photo, a bio, a password.

**Pay is set by the admin and visible to the coach — their own only.** Hiding it makes §5.2's payables worthless: a running total you cannot check against a rate you do not know is not trustworthy. It is private from *other coaches*, not from themselves — a natural RLS boundary (§3.7). `pay_amount = null` ("not tracked") is a first-class state, because a family member helping on Saturdays is not on a payroll.

**If a coach never onboards** and has a session within 48h, the **admin** is told [`AD-COACH-NOT-ONBOARDED`] — not the coach, who by definition is not listening.

### 5.2 Day-to-day

A ladder of single questions, each at its right time, one at a time. Never a wall of admin. Full timing in §10.

1. **Morning — the day, delivered.** [`CO-DAY`] Every session: time, class, venue, headcount. "Reply here if anything looks wrong."
2. **T-60 — "Coming?"** [`CO-COMING`] `[Yes, I'm coming] [Can't make it]`, plus a directions button.
3. **T-30 — one nudge** [`CO-NUDGE`] if still silent, saying the quiet part out loud: the admin gets alerted shortly if we still don't know.
4. **T+0 — "Reached?"** [`CO-REACHED`] `[I've arrived] [Running late]`. Arrival tells waiting parents, cancels the admin's pending alarm, and **counts as confirmation** — arrived implies coming, so a coach who taps once is never nagged twice.
5. **After class — the register.** [`CO-REGISTER`] `[All present] [Some absent]`; "some" opens a numbered roster picker (reply "2 4"), expiring after 2h. Both branches end the same way: rate the players still pending — one tap each, optional note.

- **"Can't make it" handles its own cover.** The tap **confirms first** — dropping a class is not a mis-tappable act. Then: if other coaches remain assigned, they are simply told and the class runs on. If the session would be **uncovered** (§3.3), it is offered to the academy's other coaches [`CO-COVER-OFFER`] — `[Claim this session]`, first tap wins, the rest are told it's taken.
- **Out-of-band changes land here.** Parents will tell the coach directly — at the court, in their own chat — that a child is out on Tuesday. The bot never sees it. **This is the most common way the system's picture goes stale.** So the morning brief and roster make marking someone out a single tap, and the coach can say it in a sentence any time. The fix is making the coach the repair path, not pretending it won't happen.
- **What they're owed, visible.** [`CO-PAYABLES`] Computed from sessions taken against a rate they can see. **The admin executes payment** — payout rails are deferred (§14).

### 5.3 Churn

Coaches leave often and new ones arrive. Both are routine operations.

**Leaving is an end date, never a delete.**

1. The admin says it in a sentence: *"Arjun's last day is the 30th."*
2. The bot **reads back** every session assigned to him past that date — count, classes, dates (§1.3).
3. It asks who takes them: another coach, split, or "I'll decide later."
4. Anything left becomes an **uncovered session** — already a state the product understands (§3.3). **Churn reuses the existing escalation rather than inventing one.**
5. `coach.ended_on` is set. Final payables statement [`CO-FINAL-STATEMENT`], then no more session messages.
6. **History stays attributed.** Attendance marked, notes written, sessions taken. Audit and payables both need it.
7. **Parents hear only if something changed for them.** A co-coach remaining → silence. A changed coach on their child's class → one line in the next reminder, never a standalone broadcast, which manufactures anxiety about a routine event.

**Arriving is §5.1** — three facts and an invite.

**Covering for a stretch** needs no new concept: assign them to those sessions. The coach set (§3.3) already expresses it.

---

## 6. Behavior: the client

### 6.1 Onboarding

**Don't import — get invited.** Every path where the parent sends the first message is strictly better: free, no template, no block risk, no tier consumption, and the 24h window opens itself.

**Step 1 — the admin shares contacts.** Multi-contact share from the address book (vCards), or a photographed register (§4.10). The bot builds `person`, `contact`, `account`, `player`, `enrollment` — **while messaging nobody**. Real value inside the onboarding session, zero risk taken.

**Step 2 — parents invite themselves.** The bot drafts the invite and walks the admin through a **WhatsApp Broadcast List** (≤256 recipients, lands as a normal 1:1 from the admin, recipients never see each other — exactly right for the no-groups, all-1:1 admin). The message carries a deep link; the parent taps, sends the prefilled text, and the bot introduces itself [`CL-INTRO`]: whose manager it is, the three things it does, then **proof instead of promises** — their child's actual schedule, with a useful next tap.

**Identity is the phone number. There are no join codes.** Step 1 registered the number, so a recognized sender resolves on sight. The prefilled text exists to give the parent something to send and to name the academy for numbers Step 1 never saw — a forwarded invite, a second parent — which resolve by academy handle plus one confirming question.

**Step 3 — non-clickers get a useful message, event-triggered.** No waiting period, no follow-up nag. Whoever hasn't tapped is contacted the first time there is a real reason — a session within 48h [`CL-FIRST-CONTACT`].

**First-contact rules, whichever path produced the message:**

1. Academy's and player's name in the first line — the recognized name does the trust work.
2. Say something only the real academy could know (the class, the time).
3. One *useful* button, never a consent-shaped one — a useful tap opens the window and confirms engagement in one action.
4. Frame as service continuity ("class updates have moved here"), never launch ("introducing…" is marketing category).
5. Admin's heads-up goes out hours earlier, bot-drafted and admin-forwarded.
6. **Staged: 10 → check delivery/read/block signals → 50 → check → the rest.** Non-negotiable (§12).

### 6.2 Day-to-day

- **Reminders worth tapping** [`CL-REMINDER`] — `"Aarav has Beginners Batch tomorrow 6:30 at Green Park — [I'll be there] [Can't make it]"`. **"Can't make it" confirms before it acts**; a pocket mis-tap must never give away a seat.
- **Book, cancel, reschedule** through buttons and lists first, free text when wanted. **Scope is always asked: this session, or every week?**
- **Reschedule is the makeup** — the session moves to another slot of the same class rather than becoming a refund argument.
- **The coach's arrival, relayed** [`CL-COACH-ARRIVED`]. Running late is relayed too, honestly [`CL-COACH-LATE`].
- **After class, the outcome** [`CL-OUTCOME`]: attended or missed, with the coach's note when written. An absence arrives as something to fix — "reply to rebook" — not a verdict.
- **Pay by UPI in the chat.** Receipts and the month's tally in the same thread, readable line by line.
- **Progress** — attendance and coach notes, per player.
- **Feedback right after class** [`CL-FEEDBACK`] — piggybacked on the outcome message, one tap plus optional comment, frequency-capped. Flows to the admin.
- **A human when it matters** (§4.11).

---

## 7. State machines

### 7.1 Session

```
scheduled ──(admin/coach cancels)──> cancelled
scheduled ──(register marked)──────> completed
```

`status` is only these three. Everything else is derived from `session_coach` timestamps:

| Derived state | Expression |
|---|---|
| uncovered | no `session_coach` row with `confirmed_at` or `arrived_at`, and none pending |
| covered | ≥1 row with `confirmed_at is not null` or `arrived_at is not null` |
| started | ≥1 row with `arrived_at is not null` |
| register pending | `status='scheduled'` and `now() > ends_at` and no attendance rows |

### 7.2 Contact

```
registered ──(sends first inbound)──> engaged ──(opts out)──> opted_out
```

`registered` = created in onboarding Step 1, never messaged. `engaged` = `last_inbound_at is not null`; the 24h window is open when `now() - last_inbound_at < 24h`.

### 7.3 Coach

```
added ──(invite forwarded)──> invited ──(taps [Looks right])──> active ──(end date)──> ended
```

`invited` with a session inside 48h fires `AD-COACH-NOT-ONBOARDED`.

### 7.4 Enrollment

```
active ──(ended_on set)──> ended
```

Monthly lines stop at `ended_on`. Session lines stop naturally with attendance.

### 7.5 Payment (Rail 1)

```
requested ──(admin taps [Yes])──> confirmed
requested ──(admin taps [Not yet])──> stays requested, dunning continues
```

Rail 2 replaces this with gateway webhooks; `confirmed_by` is null and `confirmed_at` comes from the partner.

---

## 8. The solo case

Most coaching businesses in India are one person: one `person` with both `academy_admin` and `coach` rows. **This is not the multi-coach product at n=1.** Asking someone to confirm attendance at their own class is absurd and is week-one churn.

| Flow | Solo |
|---|---|
| Coach onboarding (§5.1) | **Gone.** They onboarded as the admin. |
| `CO-COMING` / `CO-NUDGE` | **Gone.** They know. |
| `AD-ESCALATE-UNCONFIRMED` | **Gone.** Nobody to escalate to. |
| `CO-COVER-OFFER` | **Gone.** A drop becomes a reschedule: pick a new slot, the bot tells the families. |
| `CO-PAYABLES` | **Gone.** They are the business. |
| `CO-DAY` + `AD-MORNING-BRIEF` | **Merged** into one message in one chat. |
| `AD-EVENING-DIGEST` | **Kept**, shorter. |
| `CO-REACHED` | **Kept, reframed.** "Start class," not "did you show up." Its job is telling waiting parents. |
| `CO-REGISTER` | **Kept unchanged.** It is the meter and the coaching record. |

Roughly 60% of the coach surface disappears. **Nobody is ever asked to confirm something to themselves, and no escalation about the coach pings the coach.**

**Detection:** solo = exactly one `active` coach whose `person_id` is also in `academy_admin`. Recompute on coach add/end; do not cache it in settings.

**Why the model is multi-coach anyway:** a coach *set* and derived coverage cost nearly nothing to build and cannot be retrofitted. Solo is a strict subset — flows hide; a coordination layer cannot be added later to a model that assumed one coach.

---

## 9. Message catalog

Every proactive message. Columns: trigger, recipient, buttons → action, behavior on silence.

### 9.1 Client

| ID | Trigger | Buttons → action | On silence |
|---|---|---|---|
| `CL-INTRO` | Parent's first inbound after invite tap | `[See <player>'s schedule]` → render view | — |
| `CL-FIRST-CONTACT` | Non-clicker with a session in <48h | `[See schedule]`, `[Stop these]` → opt out | Nothing. No nag. |
| `CL-REMINDER` | `academy.client_reminder_lead_hours` before session | `[I'll be there]` → confirm, `[Can't make it]` → **confirm step first**, then cancel | Nothing. Absence is handled by the register. |
| `CL-CANCEL-CONFIRM` | Tap of `[Can't make it]` | `[Yes, cancel]` → mark `cancelled_timely`/`absent` per window, `[Never mind]` | Action expires in 1h |
| `CL-COACH-ARRIVED` | First `session_coach.arrived_at` | — | — |
| `CL-COACH-LATE` | `running_late` set | — | — |
| `CL-OUTCOME` | Attendance marked | `[Rebook]` when absent | — |
| `CL-FEEDBACK` | Appended to `CL-OUTCOME`, frequency-capped | 1–5 tap + optional comment | Nothing |
| `CL-TALLY` | Month end | `[Pay now]` → UPI link / mandate | Dunning takes over |
| `CL-RECEIPT` | Payment confirmed | — | — |
| `CL-DUNNING` | Per academy policy, unpaid tally | `[Pay now]`, `[Already paid]` → notifies admin | Escalates to admin after N |
| `CL-SESSION-CANCELLED` | Session cancelled | `[See other slots]` | — |
| `CL-SESSION-MOVED` | Session rescheduled | `[Got it]` | — |

**Coach changes are never a standalone message.** One line inside the next `CL-REMINDER`.

### 9.2 Coach

| ID | Trigger | Buttons → action | On silence |
|---|---|---|---|
| `CO-INVITE-CONFIRM` | Coach's first inbound | `[Looks right]` → `status='active'`, `[Something's wrong]` → route to admin | Stays `invited`; §5.1 |
| `CO-DAY` | Academy morning time, if sessions today | `[Mark someone out]` → roster picker | — |
| `CO-COMING` | T-60 | `[Yes, I'm coming]` → `confirmed_at`, `[Can't make it]` → confirm step, `[Directions]` | → `CO-NUDGE` |
| `CO-NUDGE` | T-30, only if no confirm/arrive | same as above | → `AD-ESCALATE-UNCONFIRMED` |
| `CO-REACHED` | T+0 | `[I've arrived]` → `arrived_at`, `[Running late]` → flag + alert admin | → `AD-ESCALATE-NOT-ARRIVED` at T+10 |
| `CO-REGISTER` | Session `ends_at` | `[All present]`, `[Some absent]` → roster picker | Expires 2h → `AD-` alert |
| `CO-RATING` | After register | one tap per pending player, optional note | Expires with register |
| `CO-COVER-OFFER` | A decline leaves the session uncovered | `[Claim this session]` → first tap wins | Escalate to admin |
| `CO-COVER-TAKEN` | Another coach claimed | — | — |
| `CO-STANDDOWN` | Coach arrives after an escalation fired | — | — |
| `CO-PAYABLES` | On request, and month end | — | — |
| `CO-FINAL-STATEMENT` | `ended_on` reached | — | — |

### 9.3 Admin

| ID | Trigger | Buttons → action |
|---|---|---|
| `AD-MORNING-BRIEF` | Academy morning time | *Needs you* first: approvals, uncovered sessions. Silent when nothing. |
| `AD-EVENING-DIGEST` | Academy evening time | Punctuality, rosters, arrivals, pending decisions, delivery-health line |
| `AD-ESCALATE-UNCONFIRMED` | T-25, session still uncovered | `[Call coach]`, `[Offer to others]`, `[Cancel session]` |
| `AD-ESCALATE-NOT-ARRIVED` | T+10, no arrival | `[Call coach]`, `[Notify parents]` |
| `AD-COACH-LATE` | `running_late` set | `[Notify parents]` |
| `AD-COACH-NOT-ONBOARDED` | `invited` coach, session <48h | `[Resend invite]`, `[Reassign]` |
| `AD-REGISTER-MISSING` | Register expired unmarked | `[Mark it myself]` |
| `AD-RECONCILE` | Payment requested, unconfirmed | `[Yes]` → confirm, `[Not yet]` |
| `AD-VALUE-REPORT` | Month end | Payments tracked, collected, minutes spent confirming |
| `AD-DELIVERY-FAILURE` | Send failed | `[Fix number]`, `[Ignore]` |

---

## 10. Scheduled work

**A durable job scheduler is required.** ~70% of this product is proactive. Supabase `pg_cron` driving the `job` table is sufficient; Inngest or Trigger.dev if better tooling is wanted. **Non-negotiable requirement: the scheduler must be a drivable abstraction, not a cron detail** — §13's turnable clock depends on it, and without that nothing here is testable.

| Job kind | Cadence | Dedupe key |
|---|---|---|
| `materialize_sessions` | Daily. Creates sessions from `class_slot` on a rolling ~3-week horizon. | `materialize:<class_id>:<date>` |
| `coach_day` | Daily, academy morning | `co_day:<coach_id>:<date>` |
| `coach_coming` | T-60 per session per coach | `co_coming:<session_id>:<coach_id>` |
| `coach_nudge` | T-30, skip if confirmed/arrived | `co_nudge:<session_id>:<coach_id>` |
| `admin_escalate_unconfirmed` | T-25, skip if covered | `ad_unconf:<session_id>` |
| `coach_reached` | T+0 per session per coach | `co_reached:<session_id>:<coach_id>` |
| `admin_escalate_not_arrived` | T+10, skip if started | `ad_noarr:<session_id>` |
| `client_reminder` | `client_reminder_lead_hours` before | `cl_rem:<session_id>:<player_id>` |
| `post_class_register` | Session `ends_at` | `register:<session_id>` |
| `register_expiry` | `ends_at` + 2h | `reg_exp:<session_id>` |
| `client_outcome` | On attendance marked (event, not timed) | `outcome:<session_id>:<player_id>` |
| `admin_morning_brief` | Daily | `ad_brief:<academy_id>:<date>` |
| `admin_evening_digest` | Daily | `ad_digest:<academy_id>:<date>` |
| `monthly_lines` | 1st of month | `monthly:<enrollment_id>:<period>` |
| `month_end_tally` | Month end, per account | `tally:<account_id>:<period>` |
| `month_end_value_report` | Month end, per academy | `value:<academy_id>:<period>` |
| `dunning` | Per academy policy | `dun:<account_id>:<period>:<n>` |

**Rules:**

- **Every job is idempotent via `dedupe_key`.** Enqueueing twice is a no-op.
- **Every job re-checks its precondition at run time.** A cancelled session's `coach_coming` job must find `status='cancelled'` and skip. Never trust the enqueue-time world.
- **Quiet hours hold sends**, they do not drop them. Held messages go out at `quiet_hours_end` unless stale.
- **A job that did not run is invisible failure.** Alert on it. A missing evening digest is a silent outage.
- Rescheduling a session cancels its pending jobs by dedupe key and re-enqueues.

---

## 11. Interaction architecture

### 11.1 A general agent on guardrailed primitives

The capability surface is a small set of **generic primitives**, not a catalog of hand-built features:

- **Read** — the agent authors queries over a schema it knows. Any question answerable from the data is answerable, with no new code.
- **Write** — CRUD through transactional operations carrying the invariants (§1.5).
- **Message & broadcast** — send primitives staged, capped and throttled *by construction* (§12); the model may call them freely because they are safe to call.
- **Money** — payment links, mandates, reconciliation, adjustments.
- **UI** — a kit of buttons, lists and parameterized Flows.

Safety is **structural, not behavioral**. The floor being solid is what lets the model be free above it.

### 11.2 Recipes

Common actions get **promoted into precoded recipes** — saved compositions of the same primitives: a pre-resolved plan, pre-built UI, a prompt fragment not re-derived each time. Booking, cancelling, confirming, attendance, dunning and menu navigation run this way: instant, near-free, and **visually consistent** — users see the same well-made shapes every time, not an improvised UI per conversation.

**Recipes optimize; they never gate.** A request no recipe matches falls through to the primitives — that is the design working, not failing. Instrumentation is the profiler: whatever the agent keeps re-deriving becomes the next recipe.

### 11.3 The payload rule

See §1.2 and §3.5. The model authors **what a tap will do** — including actions nobody pre-imagined — but at *compose time*. The action is minted, validated, stored. The tap replays it verbatim. **Dynamic actions, deterministic taps.**

### 11.4 UI kit

- **Every link is a button.** Nothing URL-shaped is ever pasted into message text.
- **Flows are in, and aimed.** A WhatsApp Flow is a published, versioned artifact with an encrypted data-exchange backend — built deliberately, not habitually. Its job is where conversation is the wrong shape because each reply carries a wait that compounds: **admin setup above all** (§4.2), then a short list as usage proves them. The kit carries Flows as **parameterized components**; the model fills slots and never authors Flow JSON freehand.

### 11.5 Multimodal in, text out

Inbound is multimodal, and this is **the answer to the data-entry problem** (§4.2), not a nicety.

- **Images.** Photographed timetable → the week's classes. Paper register → a roster. Fee sheet → rates. **GPay screenshot → a payment record** (amount, UTR, timestamp), offered to the admin as a one-tap confirm — which turns Rail 1 reconciliation from blind attestation into confirming something already read.
- **Voice notes.** Widely preferred over typing. Transcribed, then treated as text. Bangalore speech is Hinglish and Kannada/Tamil–English code-mixed, so **transcription must be chosen against real user samples, not benchmarks** (§15.3).
- **Documents.** Forwarded spreadsheets and PDFs, same pipeline.

**Mechanics:** Meta returns a media ID; fetch bytes with the app token promptly (URLs expire in minutes), store in Supabase Storage, then process.

**Two rules.** Parsed content is **read back before action** — recognition errors land on names, times and amounts, exactly where damage happens. And parsing produces a **proposal**, never a silent write (§1.7).

Outbound stays text, buttons and rendered views. Generated images are deferred (§14).

### 11.6 The escape hatch

An always-reachable "talk to a person," plus **automatic triggers**: two failed turns in a row, refund/complaint/safety language, requests the tools genuinely cannot serve. On trigger the bot performs the handoff itself and attaches the transcript. **Client escalations go to their academy's admin. Admin escalations go to the platform.** Heavy use is a product bug being measured.

### 11.7 Window vs. template

Replies inside the 24h window need no template and no approval. Templates are only for business-initiated messages, and almost all of ours are utility-shaped by design. `contact.last_inbound_at` is the source of truth for window state.

---

## 12. Web surface, and the shared number

### 12.1 Web

- **Signed, expiring, single-purpose links**, always behind a labeled button. Each renders exactly one thing just discussed. No login, no navigation.
- **Auth:** the link carries a short-TTL JWT with `academy_id` and `person_id` claims that Postgres policies read. The magic link *is* the session.
- **The model composes views from a component library** — calendar, roster, table, stat cards, timeline, chart, each hand-built with a data contract. The model picks components, arrangement and queries. The spec is minted once (§11.3) and rendered deterministically: **never raw model-authored markup in a browser**, which is an injection surface a multi-tenant product must not have.
- **The one unavoidable web moment:** payment-gateway KYC.

### 12.2 One number, many academies

**One shared platform number** for all tenants — one WABA, no per-tenant Meta verification. What is pooled: **quality rating** (per number, so one bad tenant degrades everyone) and **messaging tier limits** on business-initiated conversations. Replies inside an open window count against neither.

**Structural guardrails — built in, not advisable:**

- Per-tenant send caps and frequency limits. **No unthrottled broadcast primitive exists.**
- First-contact sends staged by rule (§6.1), never blasted.
- Global opt-out honoring; automatic archival of long-inactive contacts.
- **Per-tenant quality proxies** — delivery failures, read rate, response rate, opt-outs, bucketed by academy — to find a bad actor before the number-level rating does.
- **Per-tenant sender routing from day one**, so sharding across a second number is a config change, not a rebuild.

**Accepted trade-off:** parents message "Class Manager," not the academy's name. Mitigated by the academy's name leading every message. The real cost is **fragmentation** — two threads, and parents will use the wrong one, which is why §5.2's out-of-band repair path exists.

---

## 13. The emulator

**Build this early — it is the acceptance-test harness for everything asynchronous, which is most of the product.** Real WhatsApp is hostile to develop against: real numbers, approved templates, tier limits, and one shared number where a test blast is a production incident.

- **One transport interface, two implementations.** The bot addresses an abstract transport; Cloud API is production, the emulator is development. Same payloads, same buttons, same Flows. **If the emulator cannot render a message, it does not ship.** Building this first is what stops Meta API calls from scattering through the codebase.
- **Every persona side by side.** Client, coach, admin and the platform escalation desk in one screen. Type as anyone, see what they see, tap the taps against a seeded local database.
- **A clock you can turn.** Jump to T-60 and watch `CO-COMING` fire; jump to evening for the digest. Machinery that takes days to observe in production becomes testable in minutes. **This is the requirement §10 exists to satisfy.**
- **Scenario seeds.** One command to a populated academy — families, classes, a day of sessions, an overdue tally. The same seeds are the sales demo.

Constraint: **pixel-honesty.** "Looks right in the emulator" and "looks right in WhatsApp" must be the same claim.

---

## 14. Build order

Each phase has an acceptance criterion. Do not start a phase before its predecessor passes.

| # | Phase | Contents | Done when |
|---|---|---|---|
| 0 | **Foundations** | Next.js + Supabase. Full schema (§3). RLS policies + regression tests. `job` table and runner with a drivable clock. Transport interface. | Cross-tenant and cross-role reads return zero rows in tests. A job enqueued twice runs once. |
| 1 | **Emulator** | §13. Four panes, seeded DB, clock control, transport impl. | A hand-crafted message renders identically in emulator and a real test number. Clock advance fires a scheduled job. |
| 2 | **Agent loop** | Primitives (§11.1), action minting (§3.5), one recipe end to end, context assembly. | A tap on a minted button executes with no model call. An expired action refuses. |
| 3 | **Catalog & sessions** | Classes, slots, enrollments, `materialize_sessions`. Admin setup Flow. | A class created in the Flow produces correct sessions three weeks out. |
| 4 | **Coach day** | §5.2 ladder, register, coverage derivation, cover offers. | Full ladder observable in the emulator by advancing the clock. Uncovered escalation fires; standdown cancels it. |
| 5 | **Client day** | Reminders, cancel with scope, outcomes, arrival relay. | Cancel inside window writes `cancelled_timely`; outside writes `absent`. Mis-tap protection confirmed. |
| 6 | **Onboarding funnels** | Coach invite (§5.1), client Step 1–3 (§6.1), staged first contact. | Deep link → prefilled send → resolve on sight → `CO-INVITE-CONFIRM`. Staging halts on a bad signal. |
| 7 | **Money** | Rates, tally lines, adjustments, Rail 1 links, reconciliation, dunning. | A month of mixed per-session and per-month enrollments produces a correct line-by-line tally with a waiver applied. |
| 8 | **Admin day** | Morning brief, evening digest, NL CLI, delivery-status answers, audit + undo. | *"Did Meera get the reminder?"* answers from real status. Bulk op reads back and undoes. |
| 9 | **Web views** | Component library, view minting, signed links, JWT→RLS. | A rendered calendar loads from a bot link with no login and expires correctly. |
| 10 | **Multimodal** | Media pipeline, image parsing, transcription, read-back. | A photographed timetable becomes a proposed week the admin confirms. |
| 11 | **Rail 2** | Partner onboarding, mandates, in-chat checkout, webhooks. | A mandate collects a tally without admin action. |

**Solo-case handling (§8) is not a phase.** It is a condition checked in phases 4–8 as they are built. Retrofitting it means auditing every flow twice.

---

## 15. Deferred

| Deferred | Why |
|---|---|
| Coach at two academies | A routing question on a shared number; fix when hit. |
| Coach payout rails | Payout infra, TDS, contractor classification. Bot computes payables; admin pays. |
| Per-tenant WABA / Embedded Signup | The shared number removes it. |
| Coach-assignment automation | The admin knows who coaches Tuesday. Clash-checking and cover offers are enough. |
| Capacity limits and waitlists | Sound essential, almost never fire in a well-run academy. |
| Skill levels | A class is a time, a place and people. Levels are the admin's naming (§3.3). |
| Split households | One player, two accounts, split payment. Real but rare. |
| Generated-image visualization | Rendered views beat images on every axis (§12.1). |
| Unsolicited marketing broadcasts | Category risk on a shared number. |
| Non-WhatsApp clients | Out of scope permanently. |
| School programs | Account-less pupils, read-only school view, no billing. |

---

## 16. Open decisions

1. **Final name.** "Class Manager" is the name every parent sees in their chat header — a branding decision, not config. Its one real virtue: it says *class*, not *academy*.
2. **The sender number's country code.** A local number is materially better for first-contact trust (§6.1); it also carries KYC and local-entity requirements. **This gates parent-funnel conversion, so decide before phase 6.** Note: the number must be registrable to our own WABA on Cloud API — verify it is not already bound to another BSP's WhatsApp product.
3. **Transcription provider.** Chosen against real Hinglish and Kannada/Tamil–English samples from actual users, not benchmark scores (§11.5).
4. **Category scope at launch.** The model — classes, sessions, players, rates — generalizes past sport to music, dance and tuition without change. How much genericizing before tenant #2 rather than after is open. **"Academy" is the word that does not generalize, which is why it appears nowhere a user can see it.**
5. **Model strategy.** Cheap model for clients and coaches, strong for admins, is the presumed split. Decide against live cost data.

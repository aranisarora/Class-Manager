# Class Manager — product specification

> Build document. Everything needed to implement the product: setup, invariants, architecture, data model, behavior, message catalog, scheduled work, and build order.
>
> **Stack:** Next.js (web surface + API) · Supabase (Postgres, RLS, Storage) · WhatsApp Cloud API (Meta, direct) · Gemini (multimodal, native audio) · a durable job scheduler, which is required, not optional (§13).
>
> **Read §2 before writing any code.** Those rules are broken by omission, not by intent.

---

## 1. Setup prerequisites

Assume all of this is configured before phase 0.

**Meta**
- Meta Business account, business-verified (gates tier progression and Flows)
- WhatsApp Business Account under it
- Phone number registered to the WABA and verified by SMS or voice. If the number was previously a Twilio WhatsApp sender it must be deregistered there first — a number lives on exactly one platform
- Display name submitted and approved. This is what every parent sees in their chat header
- Meta app with the WhatsApp product added
- **System user with a permanent access token.** Not a user token — those expire and will break production at the worst possible moment
- Payment method attached for conversation charges

**Webhook**
- HTTPS endpoint with the verify-token handshake
- Subscribed to the `messages` field, which carries inbound messages *and* delivery statuses on one stream
- `X-Hub-Signature-256` verified against the app secret on every request
- Returns 200 immediately. Meta retries on timeout, so all processing goes on a queue, never inline

**Flows** (for the two Flows in §14.6)
- RSA keypair generated, public key uploaded to the WABA
- Data-exchange endpoint implementing the encrypted request/response protocol
- Flow JSON published per artifact

**Ongoing**
- Message templates submitted per category (§16.2)
- Sender routing table seeded with this number (§16.3)

---

## 2. Invariants

Non-negotiable. Each is a rule a plausible-looking implementation breaks silently.

1. **RLS is the security boundary; the LLM is a user of it.** Every conversation acts through a real per-user Postgres session. Tool availability is UX — it shapes cost and behavior, it does not enforce anything. Database policies are security. Every table carries `academy_id`, and every policy has a regression test.
2. **Mint once, replay verbatim.** A button's action is authored at compose time, validated, stored. The tap replays the stored payload. **No model inference at tap time**, where a misread commits someone to being somewhere.
3. **Compute the effect before committing it.** Model-authored writes run inside a transaction whose affected rows are captured and shown before commit. The bot never estimates blast radius — it knows (§14.2).
4. **Sending is not receiving.** `queued ≠ sent ≠ delivered ≠ read`, enforced in schema, code and copy. The bot never claims what it cannot see.
5. **Multi-step consequences live in transactions, not in the model's memory.** A cancel that credits and notifies is one operation that cannot half-complete.
6. **Nothing is sent during onboarding until the admin says go.** Building the roster messages nobody.
7. **Parsed input is a proposal, never a write.** Anything read from an image, voice note or document is read back before it is acted on (§14.5).
8. **Every proactive message must pass one test, at runtime:** would this recipient have asked for it? This is not a review checklist — the bot composes its own messages (§14.4), so it applies the test itself, before sending.

---

## 3. What the product is

Indian coaching businesses run on WhatsApp by hand — schedules, payment chasing, cancellations, parent communication. This moves that workload onto a WhatsApp-native manager. Clients book, pay and get reminded. Coaches get their day and mark attendance with taps. Admins run the business through natural language and menus.

**The chat is the interface. Nobody installs anything. Nobody logs in.** The web is a rendering surface the bot links into (§15) — no navigation, no login, no app shell.

Every user is **WhatsApp-only by design**. A number not on WhatsApp is out of scope.

**This is a manager, not a notification system.** It is expected to notice things nobody asked it to look for, compose messages nobody specified, and answer questions nobody anticipated. The architecture in §4 exists to make that safe rather than to prevent it.

---

## 4. The behavior system

The bot carries a lot of doctrine. Feeding all of it into every prompt is expensive and dilutes attention. The resolution: **behavior belongs at the lowest layer that can hold it.** Pushed down, it becomes free and unforgettable.

| Layer | Holds | Context cost | Can the model forget it? |
|---|---|---|---|
| **0 · Schema** | Unique keys, FKs, RLS policies | Zero | No — the database refuses |
| **1 · Operations** | Transactional writes carrying their own consequences | Zero | No — it's inside the transaction |
| **2 · Core doctrine** | Rules shaping *every* reply | ~300 tok, cached | Rarely |
| **3 · Pulled modules** | Situation-specific behavior | Manifest ~200 tok; module ~500 when pulled | Only by failing to pull |
| **4 · Memory** | This academy, this person (§5) | Small, per-conversation | — |
| **5 · Lint** | Post-generation repair | Zero | It's a check, not a rule |

**The placement test — "if the model forgets this, what breaks?"**

- Data corrupts → layer 0 or 1
- The interaction goes wrong → layer 2 or 3
- A nuance is missed → layer 4
- The wording is off → layer 5

Most of what feels like bot behavior belongs in layers 0–1. *"Ending a coach must issue a final statement"* is not a rule to remember; it is a line inside `end_coach()`.

### 4.1 Layer 2 — core doctrine

Always in context. Roughly ten rules, and they shape every single reply:

1. **Quiet by default.** Every proactive message must be one its recipient would have asked for. No engagement pings, no "just checking in," no message whose only job is reminding people the bot exists.
2. **The prompt is a convenience, not the interface.** Every prompted action works unprompted. A coach can mark attendance before being asked; a parent can cancel without a reminder in front of them.
3. **Speak the academy's language.** Use their words, from memory (§5). Never introduce vocabulary they haven't used.
4. **Buttons first, text always available.** Free text is an escape hatch on every message, never the required path.
5. **Read back before acting** on anything parsed, and anything touching more than one person.
6. **Never claim what you can't see.** Queued is not delivered. Confirmed is not arrived.
7. **Offer the natural next step as a button** after every action (§4.3).
8. **Suggestions ride on messages already being sent**, never as a standalone interruption.
9. **Roles are hats.** Never ask someone to confirm something to themselves.
10. **When uncertain, say so plainly** rather than guessing.

### 4.2 Layer 3 — the module manifest

A manifest of one line per behavior module sits always-on. Each line is written as a **trigger condition, not a title** — a title doesn't tell the model when to pull it.

```
coach-churn      — a coach is leaving, being replaced, or their sessions need reassigning
money-dispute    — a charge is disputed, a payment contested, or a waiver requested
first-contact    — messaging someone who has never messaged us
bulk-change      — a change affecting more than a handful of people or sessions
new-intake       — a stranger asking about joining
schedule-change  — moving, cancelling or rescheduling anything recurring
escalation       — anger, safety language, or two failed turns
feedback         — a parent rating, a complaint, a coach observation
reporting        — the admin wants numbers, trends, or a view
```

Nine lines always in context. The full module loads only when its condition fires. **Adding a behavior means adding a file, not touching code.**

**Accepted limitation:** a model that must decide to pull will sometimes fail to. Mitigations — the highest-stakes rules live in layer 2, and layer 5 catches the expensive misses. Layer 3 is best-effort by design; that is the price of not paying for everything on every turn.

### 4.3 Follow-up buttons

A first-class pattern, not a nicety. **After every action the bot takes, it offers the natural next step as a button.**

- Admin cancels a session → `[Tell the parents]` `[See who's affected]`
- Admin adds a coach → `[Assign classes]`
- Coach marks someone absent → `[Rebook them]`
- Parent cancels → `[Find a makeup slot]`

Costs nothing, is always relevant, and **teaches capability by demonstration rather than announcement.** It is also the discovery mechanism that keeps the natural-language surface from being a blank page.

### 4.4 The cache boundary

Layering is what makes a clean prompt-cache prefix possible:

```
STABLE PREFIX  (cached per academy, TTL, refreshed on schema change)
├─ core doctrine          ~300 tok
├─ schema                 ~2k tok
├─ module manifest        ~200 tok
└─ operation signatures   ~1k tok

VARIABLE TAIL  (never cached)
├─ pulled modules         ~500 ea
├─ memory                 ~400
├─ conversation
└─ query results, media
```

~3.5k stable tokens per academy. Gemini's context caching is explicit — create the cache, hold the handle on the academy record, refresh on schema change. Audio (§14.5) sits in the variable tail regardless, so native audio never touches the cacheable prefix.

### 4.5 Layer 5 — lint

Deterministic repair on generated output, for rules a model under pressure will otherwise break:

- Strip internal identifiers (uuids, table names)
- Rewrite machine timestamps into the academy's timezone and idiom
- **Downgrade claims the system can't back** — "delivered" where only "sent" is known
- Flag product vocabulary the academy's memory says they don't use
- **Reject numbers with no source** in the data the model was given (§10.2)

---

## 5. Memory

Each entity carries a short document the bot reads and writes. This replaces any notion of a fixed settings table for soft facts.

**Academy memory** — vocabulary, policies that emerged in conversation, quirks the schema can't hold. *"Calls them batches, not classes." "Runs a separate fee cycle for the Sunday camp." "Doesn't want parents told about coach swaps."*

**Person memory** — *"Asks about collections every Monday morning." "Never taps buttons, always types." "Kid has boards in March, expects a pause."*

**Design constraints:**

- **The bot writes it asynchronously after a turn**, never blocking a reply
- **Bounded size with active pruning.** A memory that grows forever becomes noise and eats the context budget. Cap it, and when full make the bot curate rather than truncate
- **Facts, not transcripts.** "Prefers voice notes over typing" — not a log of what was said
- **Visible and editable.** The admin can ask *"what do you know about me?"* and correct it. This matters for trust and it is a cheap debugging surface
- **Observed patterns live here.** If an admin asks about unpaid fees every Monday, that is a memory, and the Monday brief reads it and offers the button

---

## 6. Data model

Postgres. Every table: `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`, and — except `academy` — `academy_id uuid not null references academy(id)`.

### 6.1 Tenancy and place

```sql
academy (
  name                       text not null,
  category                   text,          -- 'badminton', 'carnatic vocal' — display only
  timezone                   text not null default 'Asia/Kolkata',
  cancellation_window_hours  int  not null default 24,
  client_reminder_lead_hours int  not null default 14,
  morning_brief_at           time not null default '07:00',
  evening_digest_at          time not null default '21:00',
  rail                       text not null default 'rail1',   -- rail1 | rail2
  upi_handle                 text,
  sender_id                  uuid not null references sender(id),
  memory                     text,          -- §5
  prompt_cache_handle        text,
  settings                   jsonb not null default '{}'
)

venue ( name text not null, address text, notes text )
```

`academy` is the tenant. **The word "academy" appears nowhere a user can see** — §18.4.

### 6.2 People

Three separate concerns. Collapsing them is what makes "parent pays for child" and "adult pays for self" look like two products.

```sql
person (
  full_name  text not null,
  notes      text,
  memory     text                          -- §5
)

contact (                                   -- a WhatsApp number
  person_id       uuid not null references person(id),
  phone_e164      text not null,
  wa_id           text,
  profile_name    text,                     -- from the inbound webhook, free
  is_primary      boolean not null default true,
  state           text not null default 'registered',  -- §11.2
  opted_out_at    timestamptz,
  last_inbound_at timestamptz,              -- the 24h window's source of truth
  unique (academy_id, phone_e164)
)

account (
  holder_person_id  uuid not null references person(id),
  display_name      text
)

player (
  account_id  uuid not null references account(id),
  person_id   uuid not null references person(id),
  active      boolean not null default true
)

coach (
  person_id     uuid not null references person(id),
  pay_amount    numeric(10,2),              -- null = not tracked, a valid state
  pay_unit      text,                       -- per_session | per_hour | per_month | null
  status        text not null default 'added',   -- §11.3
  invited_at    timestamptz,
  onboarded_at  timestamptz,
  ended_on      date                        -- soft end. never delete a coach.
)

academy_admin ( person_id uuid not null references person(id) )
```

**The self-paying adult is `account.holder_person_id = player.person_id`.** Not a second case — the same objects at n=1. A parent with three children is n=3. No separate flow, onboarding path or billing route exists.

**Roles compose.** A senior player who coaches juniors is one `person` with a `player` row and a `coach` row. A solo operator is one `person` with `academy_admin` and `coach` rows — which is what §10 detects on. Without `person`, these become duplicate humans sharing one phone number, and `contact.phone_e164` is unique per academy, so it does not fit.

Inbound resolves `contact → person → roles`. Multiple roles is context the model receives, and it serves all of them in one thread.

### 6.3 Classes and sessions

**One class noun.** No group/private/batch/one-off distinction exists in the schema and the product never branches on one. A private class has one enrollment. A camp is a class whose date range is a week. A batch is a class that repeats.

```sql
class (
  name        text not null,      -- the admin's own words: "6:30 Beginners Batch"
  venue_id    uuid references venue(id),
  rate_amount numeric(10,2),
  rate_unit   text,               -- per_session | per_month
  starts_on   date not null,
  ends_on     date,               -- null = open-ended
  active      boolean not null default true
)

class_slot (                       -- weekly recurrence; a class may have several
  class_id   uuid not null references class(id) on delete cascade,
  weekday    int  not null,        -- 0=Sun .. 6=Sat
  start_time time not null,
  end_time   time not null
)

class_coach (                      -- the DEFAULT coach set
  class_id uuid not null references class(id) on delete cascade,
  coach_id uuid not null references coach(id),
  primary key (class_id, coach_id)
)

enrollment (
  class_id    uuid not null references class(id),
  player_id   uuid not null references player(id),
  rate_amount numeric(10,2),       -- null = inherit from class
  rate_unit   text,                -- null = inherit from class
  is_trial    boolean not null default false,
  started_on  date not null,
  ended_on    date
)

session (
  class_id      uuid not null references class(id),
  venue_id      uuid references venue(id),   -- overrides class venue when set
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  status        text not null default 'scheduled',  -- scheduled | cancelled | completed
  cancel_reason text,
  unique (class_id, starts_at)
)

session_coach (                    -- the ACTUAL coach set. a SET, never a scalar.
  session_id   uuid not null references session(id) on delete cascade,
  coach_id     uuid not null references coach(id),
  confirmed_at timestamptz,
  declined_at  timestamptz,
  arrived_at   timestamptz,        -- never prompted; set only if the coach says so
  running_late boolean not null default false,
  primary key (session_id, coach_id)
)

attendance (
  session_id         uuid not null references session(id),
  player_id          uuid not null references player(id),
  status             text not null,   -- present | absent | cancelled_timely
  note               text,
  marked_by_coach_id uuid references coach(id),
  marked_at          timestamptz not null default now(),
  unique (session_id, player_id)
)
```

**Rate lives on the enrollment, defaulting from the class** — `coalesce(enrollment.rate_amount, class.rate_amount)`. This handles drop-ins inside a monthly batch, sibling discounts, scholarship players and legacy rates without a schema branch.

**Coverage is derived, not stored:**

```sql
exists (select 1 from session_coach sc
        where sc.session_id = :id
          and sc.declined_at is null
          and (sc.confirmed_at is not null or sc.arrived_at is not null))
```

The most important derived value in the product. **Escalations are about sessions, never people** — *"tomorrow's 6:30 has no confirmed coach"*, never *"Arjun hasn't confirmed."* A coach dropping out while others remain assigned is information, not an alarm, and this expression is why.

### 6.4 Money

```sql
tally_line (
  account_id  uuid not null references account(id),
  player_id   uuid references player(id),      -- null for account-level adjustments
  period      date not null,                    -- first day of the billing month
  kind        text not null,                    -- session | monthly | adjustment
  description text not null,                    -- shown verbatim to the parent
  amount      numeric(10,2) not null,           -- negative for credits and waivers
  session_id  uuid references session(id),
  reason      text,                             -- adjustments only
  approved_by uuid references person(id),       -- adjustments only
  unique (session_id, player_id)
)

payment (
  account_id   uuid not null references account(id),
  amount       numeric(10,2) not null,
  rail         text not null,                   -- rail1 | rail2
  method       text,
  reference    text,                            -- UPI ref / UTR
  status       text not null,                   -- requested | confirmed | failed
  requested_at timestamptz,
  confirmed_at timestamptz,
  confirmed_by uuid references person(id),      -- rail1: the admin who attested
  evidence_url text                             -- rail1: a forwarded screenshot
)
```

**Billing rules, complete:**

- `per_session` → a `session` line is written when attendance is marked `present` or `absent`. Not for `cancelled_timely`.
- `per_month` → one `monthly` line per period per active enrollment, on the first. Attendance does not affect it.
- **The cancellation window carries money meaning only for `per_session`.** For `per_month` it is a headcount signal to the coach. Same interface, different consequence, no extra code.
- **Adjustments are one primitive, not six features.** Waiving a class, crediting an academy-cancelled session, pro-rating a mid-month join, a sibling discount, goodwill and the free trial are all `kind='adjustment'` with a reason and an approver.
- **The free first class is a rule that mints an adjustment** — a negative line equal to the first `session` line. **Per player, not per account.** A second child gets their own trial.
- Balance for a period = `sum(tally_line.amount) - sum(confirmed payment.amount)`.

### 6.5 Messaging, actions, views

```sql
sender (                          -- §16.3. never a constant, even at n=1.
  phone_e164  text not null,
  waba_id     text not null,
  credentials jsonb not null
)

message (
  contact_id      uuid not null references contact(id),
  sender_id       uuid not null references sender(id),
  direction       text not null,                  -- outbound | inbound
  catalog_id      text,                           -- §12, null for composed messages
  wa_message_id   text,
  template_name   text,                           -- null when inside the window
  body            text,
  payload         jsonb,
  media_url       text,
  status          text not null default 'queued',
  queued_at       timestamptz not null default now(),
  sent_at         timestamptz,
  delivered_at    timestamptz,
  read_at         timestamptz,
  failed_reason   text,
  idempotency_key text unique                     -- REQUIRED on every outbound
)

action (                          -- §2.2, the payload rule
  kind                   text not null,
  payload                jsonb not null,   -- fully resolved. no ids to look up.
  minted_at              timestamptz not null default now(),
  minted_for_contact_id  uuid not null references contact(id),
  expires_at             timestamptz,
  consumed_at            timestamptz,
  consumed_by_contact_id uuid references contact(id)
)

view_spec (                       -- §15. minted once, rendered deterministically.
  spec        jsonb not null,     -- components, arrangement, queries
  for_person_id uuid not null references person(id),
  expires_at  timestamptz not null,
  minted_at   timestamptz not null default now()
)
```

**Every interactive button carries an `action.id` as its reply payload.** On tap: load, check expiry and consumption, check the tapping contact matches `minted_for_contact_id`, execute the stored payload, stamp `consumed_at`. **No model call, no re-resolution, no string parsing.**

### 6.6 Jobs

```sql
job (
  kind       text not null,        -- §13
  run_at     timestamptz not null,
  dedupe_key text not null unique,
  status     text not null default 'pending',
  attempts   int not null default 0,
  last_error text,
  payload    jsonb not null default '{}'
)
```

`dedupe_key` is what makes rescheduling and retries safe. Enqueueing the same key twice is a no-op.

### 6.7 RLS policy summary

| Role | Sees |
|---|---|
| Admin | Everything within their `academy_id` |
| Coach | Own `coach` row including own pay. Sessions they are assigned to, and those rosters and attendance. **Never** another coach's pay, never the academy's money |
| Account holder | Own account, its players, enrollments, attendance, tally lines, payments. Sessions their players are in. **Never** another family |
| Player's own contact | As their account holder, minus every `tally_line` and `payment` — money-shaped rows never route to a player number |

Every policy carries a regression test asserting cross-tenant and cross-role reads return zero rows. **Plus one meta-test: fail the build if any table has RLS disabled.** That single assertion catches the most common and most dangerous mistake. Write these as pgTAP tests against the real policies, not through app code.

---

## 7. The admin

**"Admin," not "owner" or "founder."** It is the word Indian coaching businesses, gyms and tuition centres use, it names a role rather than a status, and it survives the solo case without sounding strange.

### 7.1 Onboarding

The unavoidable cost of adoption is **data entry**. Reducing it is the highest-leverage work in the product.

1. **Setup Flow** (§14.6) — the form-shaped part in one screen sequence, because a dozen chat round-trips is a dozen small waits. Business name, category, venues, operating pattern, cancellation window.
2. **Bring the timetable however it already exists** (§14.5). A photo of the whiteboard. A photo of the paper register. A forwarded spreadsheet. A voice note describing the week. The bot parses, reads back, creates on a tap. **This is the single biggest friction reducer in the product.**
3. **Coaches** — §8.1. Three facts each, then invites.
4. **Families** — §9.1. Contacts shared, roster built, nobody messaged.
5. **Payments** — one UPI handle. Rail 1, under a minute.

**Everything goes in at once.** Partial state is worse than either extreme: the admin would have to remember which classes the bot handles, a parent with two children would get reminders for one, and a coach seeing 1 of their 3 sessions loses trust immediately. If the bulk import in step 2 works, this is minutes rather than an hour.

**Joining mid-cycle is expected:** the admin marks who has already paid and until when. Counting starts fresh and **nobody is ever chased for money from before the platform**.

End state: a working academy, and **no parent messaged yet** (§2.6).

### 7.2 Day-to-day

- **A natural-language CLI over the whole business.** Schedule and move classes, manage coaches and clients, waive a fee, message anyone, ask anything. Reads and writes are both model-authored (§14.2).
- **Menus as the missing nav bar.** A blank chat box with dozens of capabilities discovers worse than an ugly nav bar. A persistent list-picker — *Schedule / Clients / Money / Coaches / Insights* — is the primary affordance; prose is the fallback; follow-up buttons (§4.3) do the ongoing teaching.
- **Two bookends, quiet between.** Morning brief led by *Needs you*. Evening digest (§10.2). Between them only genuine escalations interrupt. **The admin's phone is a briefing, not a ticker.**
- **Proof it's working, pushed not pulled.** The admin will not think to ask whether reminders went out, so the digest carries delivery health unconditionally: *"41 reminders, 40 delivered, 1 failed — [see who]."*
- **Insights on demand**, rendered as views for anything spatial or dense (§15).
- **Audit trail and an undo window** on destructive operations. At multi-tenant scale a bot mistake is someone else's business.

---

## 8. The coach

### 8.1 Onboarding

Three constraints: the coach is a **warm contact** (the admin employs them), **turnover is high**, and the admin therefore runs this **several times a year**. Target: **under a minute for the admin, one tap for the coach.**

**Step 1 — the admin supplies three facts.** Contact (vCard, or name and number), which classes, pay rate. Nothing else. No availability grid — the admin assigns the coaching, so there is nothing to declare. `status='added'`. **Messages nobody.**

**Step 2 — the invite, self-initiated.** The bot drafts a short plain message; the admin forwards it from their own number. It carries a `wa.me` deep link with prefilled text. The coach taps, sends, and **the window opens from their side** — free, no template, no block risk, no tier consumption. `status='invited'`.

The draft is written plainly and offered with `[Send as is]` `[Edit]`. **No attempt to emulate the admin's voice** — they are forwarding it from their own number to someone who already knows them; it only has to avoid reading like a blast.

**Step 3 — first run is one confirmation** [`CO-INVITE-CONFIRM`]:

> Hi Arjun — I'm Class Manager, I handle scheduling for Ace TT Academy. Sharwin added you as a coach.
> Your classes:
> • Mon/Wed/Fri 6:30–7:30 pm — Beginners, Green Park
> • Sat 8–10 am — Advanced, Green Park
> `[Looks right]` `[Something's wrong]`

*Looks right* → `status='active'`, `onboarded_at` stamped. *Something's wrong* opens a picker (wrong time · wrong venue · not my class · someone missing · other) and routes to the admin. **The coach does not edit the catalog.**

**Step 4 — proof, not promises.** Their next session, what happens before it, what they'll be asked after. Then the pin-the-chat ask.

**Never asked:** availability, personal details, a photo, a bio, a password.

**Pay is set by the admin and visible to the coach — their own only.** Hiding it makes payables worthless: a running total you cannot check against a rate you don't know is not trustworthy. It is private from *other coaches*, not from themselves — a natural RLS boundary. `pay_amount = null` ("not tracked") is a first-class state.

**If a coach never onboards** and has a session within 48h, the **admin** is told — not the coach, who by definition is not listening.

### 8.2 Day-to-day

A ladder of single questions, each at its right time, one at a time.

1. **Morning — the day, delivered** [`CO-DAY`]. Every session: time, class, venue, headcount. Buttons: `[All good]` `[Something's wrong]` `[Mark someone out]`.
2. **T-60 — "Coming?"** [`CO-COMING`] `[Yes, I'm coming]` `[Can't make it]` `[Directions]`.
3. **T-30 — one nudge** [`CO-NUDGE`], only if still silent, saying the quiet part out loud: the admin gets alerted shortly if we still don't know.
4. **T-15 — the admin is told**, if still uncovered. The coach is not chased further.
5. **After class — the register** [`CO-REGISTER`]. `[All present]` is a chat button, because that is the majority case and one tap beats loading anything. `[Take register]` opens the Flow (§14.6) — the whole roster on one screen, toggle each, notes inline, one submit.

**One confirmation is enough.** A coach who taps `[Yes, I'm coming]` is never asked again — no arrival prompt, no second nudge. They will say if something changes. The session is assumed started at `starts_at` and parents are told *"class is starting"*, which is what we actually know.

**Arrival is never prompted but always accepted.** A coach who says *"I'm here"* or *"starting"* at any point sets `arrived_at`, and parents then hear *"the coach has arrived"* — the stronger claim, because we have evidence for it. This is §4.1's rule 2 in practice.

**Free text always works.** *"Running late"*, *"Aarav's out Monday"*, *"reached"* — any of it, any time, with no prompt in front of it. **Disambiguation is the model's job**, not a hardcoded resolver: a coach with two sessions today who says "reached" resolves to the imminent one, and asks with buttons only if genuinely ambiguous. **Idempotency is the schema's job** — arriving twice is a no-op because of a unique constraint, not because the model remembered.

- **"Can't make it" handles its own cover.** The tap confirms first — dropping a class is not mis-tappable. Then: if other coaches remain assigned, they are told and the class runs on. If the session would be **uncovered**, it is offered to the other coaches [`CO-COVER-OFFER`] — `[Claim this session]`, first tap wins, the rest told it's taken.
- **Out-of-band changes land here.** Parents tell the coach directly — at the court, in their own chat — that a child is out next Tuesday. The bot never sees it, so it reminds a parent about a class she cancelled a week ago, the headcount is wrong, and on per-session billing **the child is charged for a class cancelled seven days in advance.** That last one is the real damage: a stale picture becomes a wrong bill. The coach is the only node holding the information, so three catch-points exist: `[Mark someone out]` on the morning brief, a sentence any time, and — highest value — **the register asks about it**. If a player is marked absent with no cancellation on record, one tap retroactively makes it timely.
- **What they're owed, visible** [`CO-PAYABLES`]. Computed from sessions taken against a rate they can see. **The admin executes payment** — payout rails are deferred (§19).

### 8.3 Churn

Coaches leave often and new ones arrive. Routine operations, not exceptional ones.

**Leaving is an end date, never a delete.** The admin says it in a sentence — *"Arjun's last day is the 30th"* — and `end_coach(coach_id, date)` runs as **one transactional operation** (§2.5). The model chooses which operation and its arguments; the operation guarantees what happens:

1. Read back every session assigned past that date — count, classes, dates
2. Ask who takes them: another coach, split, or "decide later"
3. Set `ended_on`
4. Anything left becomes an **uncovered session** — already a state the product understands, so **churn reuses the existing escalation rather than inventing one**
5. Final payables statement, then no more session messages
6. **History stays attributed.** Attendance marked, notes written, sessions taken — audit and payables both need it
7. **Parents hear only if something changed for them.** A co-coach remaining → silence. A changed coach on their child's class → one line in the next reminder, never a standalone broadcast, which manufactures anxiety about a routine event

**Arriving is §8.1.** **Covering for a stretch** needs no new concept: assign them to those sessions.

---

## 9. The client

### 9.1 Onboarding

**Don't import — get invited.** Every path where the parent sends the first message is strictly better: free, no template, no block risk, no tier consumption, and the window opens itself.

**Step 1 — the admin shares contacts.** Multi-contact share from the address book (vCards), or a photographed register (§14.5). The bot builds `person`, `contact`, `account`, `player`, `enrollment` — **while messaging nobody.**

**Step 2 — parents invite themselves.** The bot drafts the invite and walks the admin through a **WhatsApp Broadcast List** (≤256 recipients, lands as a normal 1:1 from the admin, recipients never see each other). It carries a deep link; the parent taps, sends the prefilled text, and the bot introduces itself [`CL-INTRO`] — whose manager it is, the three things it does, then **proof instead of promises**: their child's actual schedule, with a useful next tap.

**Identity is the phone number. There are no join codes.** Step 1 registered the number, so a recognized sender resolves on sight. The prefilled text gives the parent something to send and names the academy for numbers Step 1 never saw — a forwarded invite, a second parent — which resolve by academy name plus one confirming question.

**Step 3 — non-clickers get a useful message, event-triggered** [`CL-FIRST-CONTACT`]. No waiting period, no nag: contacted the first time there is a real reason, a session within 48h.

**First-contact rules, whichever path produced the message:**

1. Academy's and player's name in the first line — the recognized name does the trust work
2. Say something only the real academy could know (the class, the time)
3. One *useful* button, never a consent-shaped one
4. Frame as service continuity ("class updates have moved here"), never launch — "introducing…" is marketing category
5. Admin's heads-up goes out hours earlier, bot-drafted and admin-forwarded
6. **Staged: 10 → check delivery, read and block signals → 50 → check → the rest**

### 9.2 Day-to-day

- **Reminders worth tapping** [`CL-REMINDER`] — *"Aarav has Beginners Batch tomorrow 6:30 at Green Park"* `[I'll be there]` `[Can't make it]`. **"Can't make it" confirms before it acts**; a pocket mis-tap must never give away a seat.
- **Book, cancel, reschedule** through buttons and lists first, free text always available. **Scope is always asked: this session, or every week?**
- **Reschedule is the makeup** — the session moves to another slot of the same class rather than becoming a refund argument.
- **Class starting / coach arrived** — the weaker or stronger claim depending on what we know (§8.2).
- **After class, the outcome** [`CL-OUTCOME`]: attended or missed, with the coach's note. An absence arrives as something to fix — `[Rebook]` — not a verdict.
- **Pay by UPI in the chat.** Receipts and the month's tally in the same thread, line by line.
- **Progress** — attendance and coach notes, per player.
- **Feedback right after class** [`CL-FEEDBACK`] — one tap plus optional comment, frequency-capped, flowing to the admin.
- **A human when it matters** (§14.8).

---

## 10. The prospect

A fourth persona-phase cell, and the cheapest acquisition path in the product: the user initiates, so the window is open, free, and carries no template, tier or block cost.

### 10.1 Cold inbound

A QR code at the court, a "Message us" link on a website or Instagram bio. **Assume this is always on.**

**Routing.** The bot serves many academies on one number, so an inbound must resolve to *which* academy. This is a functional requirement, not a security one. The link carries prefilled text naming the academy — `wa.me/<number>?text=Hi Ace TT Academy` — and the bot matches on it. No token infrastructure.

**Name comes free.** The inbound webhook carries `profile.name`, the sender's own WhatsApp display name. Self-set and unverified, and it is the *parent's* name not the child's — but it turns two questions into one.

**The flow:**

1. Cold inbound → academy resolved → `contact.state = 'prospect'`, `person` created
2. [`PR-WELCOME`] *"Hi Rajesh! I'm the class manager for Ace TT Academy."* → what's on offer → `[Book a free trial]` `[See the schedule]` `[Talk to Sharwin]`
3. Trial: child's name and age, pick a class from those with space, confirm
4. **Auto-confirmed.** `account`, `player` and a trial `enrollment` are created, the session is booked, and the parent is told immediately [`PR-TRIAL-CONFIRMED`]
5. The admin is notified after the fact [`AD-NEW-TRIAL`] with `[Undo]` — *"New trial booked — Aarav, 9, Saturday Beginners"*

Zero friction on the funnel; the admin retains an undo rather than a gate.

### 10.2 Synthesized insight

The evening digest is **not a template with slots.** At digest time the bot receives the day's and the trailing period's data plus academy and person memory, and writes what *this admin* should know — deciding for itself what to lead with, what to omit, and how to order it.

> **TONIGHT · Ace TT Academy**
>
> Saturday Advanced is the thing to look at. Attendance is down a third, and all four missing families joined in June — I think it's term-fee timing, not the coaching.
>
> Otherwise a clean day: 14 sessions, Arjun late to one. Sat 8am still has no coach — the only thing needing you tonight.
>
> Meera, Aarav and Kiran unpaid.

**Three grounding rules keep it honest**, because an unconstrained model produces confident nonsense:

1. **Every number traces to a query result in the payload.** A figure with no source is stripped by lint (§4.5), not published.
2. **Comparison requires a baseline in the payload.** "Attendance is down" needs last month's figure *present*, not recalled. No baseline, no claim.
3. **Uncertainty is stated.** *"Might be a pattern, might be coincidence at this size"* beats a confident causal story.

**The mix shifts over the first month.** Week one leans on proof — delivery health, what was done. Month two leans on synthesis, because by then the admin trusts the mechanics and wants the thinking. This is a prompt instruction driven by the academy's age, not two code paths.

The morning brief follows the same construction, led by *Needs you* and silent when there is nothing.

---

## 11. State machines

### 11.1 Session

```
scheduled ──(cancelled)──────> cancelled
scheduled ──(register marked)─> completed
```

Everything else is derived from `session_coach`:

| Derived | Expression |
|---|---|
| uncovered | no row with `confirmed_at` or `arrived_at`, none pending |
| covered | ≥1 row with `confirmed_at` or `arrived_at` not null |
| started | `now() >= starts_at` and covered |
| arrived | ≥1 row with `arrived_at` not null — the stronger claim |
| register pending | `scheduled`, past `ends_at`, no attendance rows |

### 11.2 Contact

```
prospect ──(trial booked)──> registered ──(first inbound)──> engaged ──(opts out)──> opted_out
registered ──(first inbound)──> engaged
```

`prospect` = arrived cold, no account yet. `registered` = created in onboarding, never messaged. `engaged` = `last_inbound_at` set; the window is open when `now() - last_inbound_at < 24h`.

### 11.3 Coach

```
added ──(invite forwarded)──> invited ──([Looks right])──> active ──(end date)──> ended
```

`invited` with a session inside 48h alerts the **admin**.

### 11.4 Enrollment

```
active ──(ended_on set)──> ended
```

### 11.5 Payment (Rail 1)

```
requested ──([Yes])──> confirmed
requested ──([Not yet])──> stays requested, dunning continues
```

Rail 2 replaces this with gateway webhooks.

---

## 12. Message catalog

Scheduled and event-driven messages. **This is not the complete set of what the bot sends** — it composes messages freely (§14.4). These are the ones code decides to send.

### 12.1 Client

| ID | Trigger | Buttons | On silence |
|---|---|---|---|
| `CL-INTRO` | First inbound after invite tap | `[See <player>'s schedule]` | — |
| `CL-FIRST-CONTACT` | Non-clicker, session <48h | `[See schedule]` `[Stop these]` | Nothing. No nag. |
| `CL-REMINDER` | `client_reminder_lead_hours` before | `[I'll be there]` `[Can't make it]` | Nothing |
| `CL-CANCEL-CONFIRM` | Tap of `[Can't make it]` | `[Yes, cancel]` `[Never mind]` | Expires 1h |
| `CL-CLASS-STARTING` | `starts_at`, coach confirmed | — | — |
| `CL-COACH-ARRIVED` | `arrived_at` set | — | — |
| `CL-COACH-LATE` | `running_late` | — | — |
| `CL-OUTCOME` | Attendance marked | `[Rebook]` when absent | — |
| `CL-FEEDBACK` | Appended to outcome, capped | rating + optional note | Nothing |
| `CL-TALLY` | Month end | `[Pay now]` `[See the lines]` | Dunning takes over |
| `CL-RECEIPT` | Payment confirmed | — | — |
| `CL-DUNNING` | Per policy, unpaid | `[Pay now]` `[Already paid]` | Escalates to admin |
| `CL-SESSION-CANCELLED` | Session cancelled | `[See other slots]` | — |
| `CL-SESSION-MOVED` | Rescheduled | `[Got it]` | — |

**A coach change is never a standalone message** — one line inside the next `CL-REMINDER`.

### 12.2 Prospect

| ID | Trigger | Buttons |
|---|---|---|
| `PR-WELCOME` | Cold inbound resolved to an academy | `[Book a free trial]` `[See the schedule]` `[Talk to <admin>]` |
| `PR-TRIAL-CONFIRMED` | Trial auto-booked | `[Add to calendar]` `[Directions]` |

### 12.3 Coach

| ID | Trigger | Buttons | On silence |
|---|---|---|---|
| `CO-INVITE-CONFIRM` | First inbound | `[Looks right]` `[Something's wrong]` | Stays `invited` |
| `CO-DAY` | Morning, if sessions today | `[All good]` `[Something's wrong]` `[Mark someone out]` | — |
| `CO-COMING` | T-60 | `[Yes, I'm coming]` `[Can't make it]` `[Directions]` | → `CO-NUDGE` |
| `CO-NUDGE` | T-30, only if silent | same | → admin at T-15 |
| `CO-REGISTER` | `ends_at` | `[All present]` `[Take register]` | Expires 2h → admin |
| `CO-COVER-OFFER` | A decline leaves it uncovered | `[Claim this session]` | Escalate to admin |
| `CO-COVER-TAKEN` | Another claimed it | — | — |
| `CO-PAYABLES` | On request, month end | — | — |
| `CO-FINAL-STATEMENT` | `ended_on` reached | — | — |

**No arrival prompt exists.** One confirmation is enough (§8.2).

### 12.4 Admin

| ID | Trigger | Buttons |
|---|---|---|
| `AD-MORNING-BRIEF` | `morning_brief_at` | Synthesized (§10.2). Silent when nothing |
| `AD-EVENING-DIGEST` | `evening_digest_at` | Synthesized |
| `AD-ESCALATE-UNCONFIRMED` | T-15, still uncovered | `[Call coach]` `[Offer to others]` `[Cancel session]` |
| `AD-COACH-LATE` | `running_late` | `[Notify parents]` |
| `AD-COACH-NOT-ONBOARDED` | `invited`, session <48h | `[Resend invite]` `[Reassign]` |
| `AD-REGISTER-MISSING` | Register expired unmarked | `[Mark it myself]` |
| `AD-RECONCILE` | Payment requested, unconfirmed | `[Yes]` `[Not yet]` |
| `AD-NEW-TRIAL` | Cold-inbound trial booked | `[Message them]` `[Undo]` |
| `AD-OPT-OUT` | Someone opted out | `[Call them]` |
| `AD-VALUE-REPORT` | Month end | — |
| `AD-DELIVERY-FAILURE` | Send failed | `[Fix number]` `[Ignore]` |

---

## 13. Scheduled work

**A durable job scheduler is required.** ~70% of this product is proactive. Supabase `pg_cron` driving the `job` table is sufficient; Inngest or Trigger.dev if better tooling is wanted. **Non-negotiable: the scheduler must be a drivable abstraction, not a cron detail** — §17's turnable clock depends on it, and without that none of this is testable.

| Kind | Cadence | Dedupe key |
|---|---|---|
| `materialize_sessions` | Daily, rolling ~3-week horizon | `materialize:<class_id>:<date>` |
| `coach_day` | Daily, `morning_brief_at` | `co_day:<coach_id>:<date>` |
| `coach_coming` | T-60 per session per coach | `co_coming:<session_id>:<coach_id>` |
| `coach_nudge` | T-30, skip if confirmed | `co_nudge:<session_id>:<coach_id>` |
| `admin_escalate_uncovered` | T-15, skip if covered | `ad_uncov:<session_id>` |
| `class_starting` | `starts_at`, if covered | `starting:<session_id>` |
| `client_reminder` | Lead hours before | `cl_rem:<session_id>:<player_id>` |
| `post_class_register` | `ends_at` | `register:<session_id>` |
| `register_expiry` | `ends_at` + 2h | `reg_exp:<session_id>` |
| `client_outcome` | On attendance marked (event) | `outcome:<session_id>:<player_id>` |
| `admin_morning_brief` | Daily | `ad_brief:<academy_id>:<date>` |
| `admin_evening_digest` | Daily | `ad_digest:<academy_id>:<date>` |
| `monthly_lines` | 1st of month | `monthly:<enrollment_id>:<period>` |
| `month_end_tally` | Month end, per account | `tally:<account_id>:<period>` |
| `month_end_value_report` | Month end, per academy | `value:<academy_id>:<period>` |
| `dunning` | Per policy | `dun:<account_id>:<period>:<n>` |
| `memory_curate` | After a turn, async | `mem:<entity_id>:<turn_id>` |

**Rules:**

- **Every job is idempotent via `dedupe_key`.** Enqueueing twice is a no-op.
- **Every job re-checks its precondition at run time.** A cancelled session's `coach_coming` must find `status='cancelled'` and skip. Never trust the enqueue-time world.
- **A job that did not run is invisible failure.** Alert on it — a missing evening digest is a silent outage.
- Rescheduling a session cancels its pending jobs by dedupe key and re-enqueues.

There are **no quiet hours.** Early-morning classes are normal in India, and holding a 5am coach prompt for a 6am class would break the product for exactly the academies that need it most.

---

## 14. Interaction architecture

### 14.1 A general agent on guardrailed primitives

Five generic primitives, not a catalog of hand-built features:

- **Read** — the model authors queries over the schema it knows. Any question answerable from the data is answerable, with no new code.
- **Write** — model-authored, with the effect computed before commit (§14.2).
- **Message** — compose and send freely (§14.4).
- **Money** — payment links, mandates, reconciliation, adjustments.
- **UI** — buttons, lists, two Flows, and the web surface (§15).

Safety is **structural, not behavioral.** The floor being solid is what lets the model be free above it.

### 14.2 Reads and writes are both model-authored

**Reads.** The model writes SELECTs. What makes it safe:

- **RLS enforces.** A query reaching for another tenant returns zero rows
- **A read-only role** for model-authored queries: `SELECT` only, no functions, no DDL
- **Statement timeout and row caps** — 5s, 10k rows. A model can write an accidental cartesian join
- **Scope is always shown.** *"Across 4 classes, 38 players, Aug 1–31"* — so an obviously wrong denominator is visible. Plausible-wrong answers, not security, are the real risk here

**Writes.** The model authors these too — the product must not be capped at its tool authors' imagination. Safety comes from **computing the effect, not restricting the author**:

```
BEGIN
  execute the model-authored write
  capture affected rows
  → render the diff
COMMIT or ROLLBACK
```

Postgres gives this natively, so the bot **knows** its blast radius rather than estimating it:

> That'll change 14 enrollments — all of Saturday Advanced, moving to 8:30.
> Meera, Aarav, Kiran, +11 more.
> `[Do it]` `[Show me all 14]` `[Cancel]`

**Preview scales with blast radius:**

| Write | Preview |
|---|---|
| Single row, own scope, reversible — attendance, arrival, a confirmation | Execute directly. A diff here is pure friction |
| More than one person or session | Preview and confirm |
| Money-touching — tally lines, adjustments, payments | Preview and confirm |
| Destructive — ending enrollments, coaches, classes | Preview and confirm |
| Raw SQL rather than a named operation | Always preview |

Three further bounds: **RLS caps the blast radius** at what that human could have done by hand; **an audit trail records intent** alongside the statement; **an undo window** covers destructive operations.

**Named operations still exist** for anything with multi-step consequences that must not half-complete (§2.5) — `end_coach`, `cancel_session`, `move_class`, `waive`. The model chooses which operation; the operation guarantees what happens. Everything else it can author.

### 14.3 Recipes

Common actions get **promoted into precoded recipes** — saved compositions of the same primitives: a pre-resolved plan, pre-built UI, a prompt fragment not re-derived each time. Booking, cancelling, confirming, attendance, dunning and menu navigation run this way: instant, near-free, and **visually consistent** — the same well-made shapes every time, not an improvised UI per conversation.

**Recipes optimize; they never gate.** A request no recipe matches falls through to the primitives — that is the design working. Instrumentation is the profiler: whatever the model keeps re-deriving becomes the next recipe.

### 14.4 Composed messages

The bot composes and sends messages nobody specified — that is what makes it a manager rather than a notifier. *"Tell the Saturday parents the venue moved."* *"Check on the three families who stopped coming."*

Two constraints, both cheap:

- **It applies §2.8 before sending** — would this person have wanted this?
- **It goes through the one send path.** Throttle, cap, staging. Not a restriction on what it can say; a guarantee about how it goes out. **No unthrottled send function exists in the codebase** (§16.3)

### 14.5 Multimodal in, text out

Inbound is multimodal, and this is **the answer to the data-entry problem** (§7.1), not a nicety.

- **Images.** Photographed timetable → the week's classes. Paper register → a roster. Fee sheet → rates. **GPay screenshot → a payment record** (amount, UTR, timestamp), offered to the admin as a one-tap confirm, which turns Rail 1 reconciliation from blind attestation into confirming something already read.
- **Audio, natively.** Voice notes go to the model as audio — no separate transcription step. The model holds the roster and the conversation, so it resolves "Aarav/Arav" against players who actually exist, which a standalone ASR cannot do. This matters because Bangalore speech is Hinglish and Kannada/Tamil–English code-mixed. Audio tokenizes cheaply and sits in the variable tail, so it never touches the cache prefix (§4.4).
- **Documents.** Forwarded spreadsheets and PDFs, same pipeline.

**Mechanics:** Meta returns a media ID; fetch bytes with the app token promptly (URLs expire in minutes), store in Supabase Storage, then process.

**Two rules.** Parsed content is **read back before action** — recognition errors land on names, times and amounts, exactly where damage happens, and with audio there is no transcript for the human to check, so **the read-back is the only verification surface.** And parsing produces a **proposal**, never a silent write.

Read-back examples:

> I read this from your timetable — check before I create anything:
> • Mon, Wed, Fri · 6:30–7:30pm · Beginners · Green Park
> • Sat · 8:00–10:00am · Advanced · Green Park
> `[Create these 2]` `[Fix something]` `[Cancel]`

> Two changes:
> 1. Aarav — out Tuesday 25th
> 2. Meera — moves to 6:30 Beginners from next week
> `[Do both]` `[Just #1]` `[Just #2]` `[Neither]`

If the audio is unclear the bot says so plainly rather than guessing — §2.4 applied to input.

### 14.6 UI kit

- **Every link is a button.** Nothing URL-shaped is pasted into message text.
- **UI is an offer, never a gate.** Never *require* a form for something chat could do. The correct shape: *"Done — Aarav's out Tuesday. Want to set up the rest of his absences? `[Open form]` — or just tell me."* Both paths work; the form is a shortcut, never a toll.
- **Two published Flows, and only two:**
  - `setup` — admin onboarding, where a dozen chat round-trips would be a dozen small waits
  - `register` — the highest-frequency form-shaped moment in the product; the whole roster on one screen beats "reply 2 4" and fifteen round trips, every single session
- **Everything else form-shaped goes to the web surface** (§15), which has no publish latency, no versioning burden and no ceiling. A Flow is a published, versioned artifact requiring the encrypted data-exchange endpoint — worth it only for stable, high-frequency shapes.
- **Flows are parameterized components.** The model fills slots; it never authors Flow JSON freehand, and it cannot — a Flow is sent by reference to a published artifact, not composed inline.

### 14.7 Window and templates

Replies inside the 24h window need no template and no approval. `contact.last_inbound_at` is the source of truth. Out of window, an approved template goes out — see §16.2 for the eight categories.

**Out-of-window messages are window-openers.** Deliberately simple, aimed at getting one useful tap, after which the rich interaction happens in-window for free.

### 14.8 The escape hatch

An always-reachable "talk to a person," plus **automatic triggers**: two failed turns, refund/complaint/safety language, requests the tools genuinely cannot serve. The bot performs the handoff itself and attaches the transcript. **Client escalations go to their academy's admin. Admin escalations go to the platform.** Heavy use is a product bug being measured.

---

## 15. The web surface

Not a fallback — the escape valve for any UI WhatsApp cannot express, with no approval latency and no ceiling.

**Who gets it, in order of ambition:**

- **Admin — heavily.** Dense, comparative, exploratory. Calendars, revenue by class, attendance trends, "worst Tuesdays first." The primary audience, and where the ceiling should be highest.
- **Coach — narrower.** Their week, a roster, their payables. A handful of stable shapes.
- **Parent — narrowest.** Their child's schedule, attendance history, the tally.

**Access:** a signed link behind a labeled button, carrying a short-TTL JWT with `academy_id` and `person_id` claims that Postgres policies read. **The magic link is the session.** No login, no navigation — the chat is the navigation.

**The component library**, each with a declared data contract:

| Component | Takes | Used for |
|---|---|---|
| `calendar` | sessions with time, title, venue | the week, the month |
| `table` | rows, column defs, optional totals | everything; the universal fallback |
| `people-list` | people with a status badge | rosters, unpaid families, coach lists |
| `stat-cards` | label, value, optional delta | collections, attendance rate, headcount |
| `timeline` | ordered events | a day, a player's history |
| `chart` | series | trends only — bar and line, nothing more |
| `detail` | one entity's fields | a player, a class, a coach |
| `prose` | markdown | synthesized commentary (§10.2) |

**The model never authors markup.** It authors a **view spec** — JSON naming components, arrangement, and the queries filling each — validated against a schema and rendered by trusted code. Same pattern as action-minting, same reason: model-authored HTML in a browser is an injection surface a multi-tenant product cannot have.

**When it can't construct:**

| Failure | Answer |
|---|---|
| Component doesn't exist | Fall back to `table` — it renders any tabular result |
| Query shape violates the contract | Validation rejects at mint time; retry once, then `table` |
| Too much data | Aggregate or paginate at mint time; never ship a 5,000-row page |
| Genuinely novel need | `prose` + `table`. Honest and useful |

**The floor: anything that can't be rendered gets answered in chat.** A view is an upgrade to a text answer, never a prerequisite for one.

**The one unavoidable web moment:** payment-gateway KYC for Rail 2.

---

## 16. One number, many academies

### 16.1 What's pooled

**Quality rating** (per number, so one bad tenant degrades everyone) and **messaging tier limits** on business-initiated conversations. Replies inside an open window count against neither, which is why buttons people actually want to tap are infrastructure, not politeness.

### 16.2 Templates are categories, not messages

Templates scale with **categories of unsolicited contact**, not with features. The ~35 catalog entries collapse to eight:

| Template | Covers |
|---|---|
| `session_reminder` | client reminders |
| `session_change` | cancelled, moved, coach changed |
| `session_outcome` | attended/missed with note |
| `payment_due` | tally, dunning |
| `coach_schedule` | the day, cover offers |
| `coach_prompt` | coming, nudge, register |
| `admin_alert` | every escalation |
| `admin_digest` | brief, digest |

**Adding an in-window interaction costs zero templates.**

Each carries **structured parameters holding real content** — `"{academy}: {event}. {detail}"`. A purely generic *"you have an update, reply to see it"* template is the vague-clickbait pattern Meta tightens on and risks rejection or marketing categorization; parameters carrying actual information do the same job legitimately.

**Category matters:** Meta classifies templates regardless of intent, and one that *reads* promotional gets marked marketing — more expensive, more block risk. This is why §9.1's rule 4 exists. It is category management, not tone advice.

### 16.3 Guardrails, built in

- **Per-tenant send caps** (protects the shared number's tier capacity from one heavy tenant) and **per-recipient frequency limits** (stops a parent getting eight messages because eight things happened). Both needed; they protect different things.
- **No unthrottled send function exists in the codebase.** Not "we shouldn't call one" — one send path, everything through it, no helper that skips the queue. This is what makes it safe to give the model a message primitive.
- **First-contact staged by rule** (§9.1), never blasted.
- **Opt-out**: confirmed before it takes effect (never a mis-tap), **per-academy not global**, and **the admin is told** [`AD-OPT-OUT`] — they may want to call.
- **Per-tenant quality proxies** — delivery failures, read rate, response rate, opt-outs, bucketed by academy — to find a bad actor before the number-level rating does.
- **Per-tenant sender routing from day one.** `academy.sender_id → sender` even at n=1. Adding a second number is then a config change, not a refactor across every send path plus the webhook router. Inbound records which sender received it, so replies go out the same number. Cost now: one table and one join. Cost to retrofit: a week, during a capacity crunch.

**Accepted trade-off:** parents message "Class Manager," not the academy's name, mitigated by the academy's name leading every message. The real cost is **fragmentation** — two threads, and parents will use the wrong one, which is why §8.2's out-of-band repair path exists.

---

## 17. The emulator

**The main deliverable of phase 1**, because it is simultaneously the dev surface, the test harness, the eval system and the sales demo — and because it is exactly what happens in production.

Real WhatsApp is hostile to develop against: real numbers, approved templates, tier limits, and one shared number where a test blast is a production incident.

**Structure — a world, not four panes:**

- **A world**: a seeded scenario with academies, people, classes, sessions
- **A contact tray**: open any contact as a pane, as many as fit. Two coaches racing on `[Claim this session]`. A head coach and an assistant contending for the register. A parent and their teenage player on separate numbers. Two academies, to prove tenant isolation
- **One shared clock** across all panes, advanced on demand — jump to T-60 and watch `CO-COMING` fire, jump to evening for the digest
- **Live updates.** The cover-claim race is only testable if pane B visibly updates when you tap in pane A. Refresh-on-action doesn't test it
- **An event log**: every send with template-vs-in-window, cost, tier consumption, sender number
- **Failure injection**: sends fail, numbers block, Flows don't load. Unreachable in normal development, and where production actually breaks
- **One transport interface, two implementations.** The bot addresses an abstract transport; Cloud API is production, the emulator is development. **If the emulator can't render a message, it doesn't ship.** Building this first is what stops Meta API calls from scattering through the codebase

**Simulation hooks ship in phase 1; agent simulation lands as soon as there are behaviors to exercise.** The substrate — deterministic seeds, run recording, replay, the transport — is built up front so simulation drops in without rework.

**Agent simulation, once phase 4 behaviors exist:**

- **Personas as data** — *"busy parent, replies in three words, doesn't read carefully, taps the first button"* · *"coach who never taps, always types, uses Hinglish"* · *"admin who asks the same question five different ways."* The uncooperative personas find more bugs than the cooperative ones
- **Goals** — "get your kid moved to Saturday," "dispute a charge," "cancel and rebook twice"
- **A judge agent reviews the transcript**: where did the user get confused, hit a dead end, repeat themselves, get a wrong answer, or receive a message failing §2.8
- **Diffable runs.** Run the same seeded scenario before and after a change and see what moved. This is the only practical regression test for a conversational product

Constraint: **pixel-honesty.** "Looks right in the emulator" and "looks right in WhatsApp" must be the same claim.

---

## 18. The solo case

Most coaching businesses in India are one person: one `person` with both `academy_admin` and `coach` rows. **This is not the multi-coach product at n=1.** Asking someone to confirm attendance at their own class is absurd, and it is week-one churn.

| Flow | Solo |
|---|---|
| Coach onboarding (§8.1) | **Gone.** They onboarded as the admin |
| `CO-COMING` / `CO-NUDGE` | **Gone.** They know |
| `AD-ESCALATE-UNCONFIRMED` | **Gone.** Nobody to escalate to |
| `CO-COVER-OFFER` | **Gone.** A drop becomes a reschedule: pick a new slot, the bot tells the families |
| `CO-PAYABLES` | **Gone.** They are the business |
| `CO-DAY` + `AD-MORNING-BRIEF` | **Merged** into one message in one chat |
| `AD-EVENING-DIGEST` | **Kept**, shorter |
| `CL-CLASS-STARTING` | **Kept.** Its job is telling waiting parents |
| `CO-REGISTER` | **Kept unchanged.** It is the meter and the coaching record |

Roughly 60% of the coach surface disappears. **Nobody is ever asked to confirm something to themselves, and no escalation about the coach pings the coach.**

**Detection:** exactly one `active` coach whose `person_id` is also in `academy_admin`. Recompute on coach add/end; never cache it in settings.

**Why the model is multi-coach anyway:** a coach *set* and derived coverage cost nearly nothing to build and cannot be retrofitted. Solo is a strict subset — flows hide; a coordination layer cannot be added later to a model that assumed one coach.

**This is not a phase.** It is a condition checked in phases 4–8 as they are built. Retrofitting means auditing every flow twice.

---

## 19. Build order

Each phase has an acceptance criterion. Do not start a phase before its predecessor passes.

| # | Phase | Contents | Done when |
|---|---|---|---|
| 0 | **Foundations** | Schema (§6). RLS policies + pgTAP regression tests. `job` table and runner with a drivable clock. Transport interface. Sender routing table | Cross-tenant and cross-role reads return zero rows. Build fails if any table lacks RLS. A job enqueued twice runs once |
| 1 | **Emulator** | §17 — world, contact tray, arbitrary panes, live updates, clock, event log, seeds, recording, failure injection | A message renders identically in emulator and on a real test number. Clock advance fires a scheduled job. A run replays deterministically |
| 2 | **Agent loop** | Primitives (§14.1), action minting, write-diff preview (§14.2), layered context and cache (§4), memory (§5), one recipe end to end | A tap executes with no model call. An expired action refuses. A multi-row write shows its diff before commit. Cache hit rate is measurable |
| 3 | **Catalog & sessions** | Classes, slots, enrollments, `materialize_sessions`, setup Flow | A class created in the Flow produces correct sessions three weeks out |
| 4 | **Coach day** | §8.2 ladder, register Flow, coverage derivation, cover offers, unprompted actions | Full ladder observable by advancing the clock. Uncovered escalation fires. A confirmed coach is never asked twice. "I'm here" works with no prompt |
| 5 | **Client day** | Reminders, cancel with scope, outcomes, class-starting relay | Cancel inside window writes `cancelled_timely`, outside writes `absent`. Mis-tap protection confirmed |
| 6 | **Onboarding funnels** | Coach invite (§8.1), client Steps 1–3 (§9.1), staged first contact, templates submitted | Deep link → prefilled send → resolve on sight → `CO-INVITE-CONFIRM`. Staging halts on a bad signal |
| 7 | **Money** | Rates, tally lines, adjustments, Rail 1 links, reconciliation, dunning | A month of mixed per-session and per-month enrollments produces a correct line-by-line tally with a waiver applied |
| 8 | **Admin day** | Brief and digest as synthesis (§10.2), NL CLI, follow-up buttons, delivery-status answers, audit and undo | *"Did Meera get the reminder?"* answers from real status. A digest number with no source is stripped by lint |
| 9 | **Web views** | Component library, view-spec minting, signed links, JWT→RLS | A rendered calendar loads from a bot link with no login and expires correctly. An invalid spec falls back to `table` |
| 10 | **Multimodal** | Media pipeline, image parsing, native audio, read-back | A photographed timetable becomes a proposed week the admin confirms. A Hinglish voice note resolves a player name against the roster |
| 11 | **Prospect funnel** | Cold inbound (§10.1), auto-confirmed trials, admin undo | A stranger with a QR link books a trial end to end; the admin can undo it |
| 12 | **Agent simulation** | Personas, goals, judge agent, diffable runs (§17) | A simulated week surfaces a real defect, and a code change shows as a run diff |
| 13 | **Rail 2** | Partner onboarding, mandates, in-chat checkout, webhooks | A mandate collects a tally with no admin action |

---

## 20. Deferred

| Deferred | Why |
|---|---|
| Coach at two academies | A routing question on a shared number; fix when hit |
| Coach payout rails | Payout infra, TDS, contractor classification. Bot computes payables; admin pays |
| Per-tenant WABA / Embedded Signup | The shared number removes it |
| Coach-assignment automation | The admin knows who coaches Tuesday. Clash-checking and cover offers are enough |
| Capacity limits and waitlists | Sound essential, almost never fire in a well-run academy |
| Skill levels | A class is a time, a place and people. Levels are the admin's naming |
| Split households | One player, two accounts, split payment. Real but rare |
| Automatic contact archival | Out of scope. A digest line — *"6 contacts silent for 3 months"* — costs nothing and the admin decides |
| Global opt-out | Per-academy only |
| Quiet hours | Removed. Early classes are normal; holding a 5am prompt breaks the product for the academies that need it most |
| Generated-image visualization | The web surface beats images on every axis |
| Unsolicited marketing broadcasts | Category risk on a shared number |
| Non-WhatsApp clients | Out of scope permanently |
| School programs | Account-less pupils, read-only school view, no billing |

---

## 21. Open decisions

1. **Final name.** "Class Manager" is the name every parent sees in their chat header — a branding decision, not config. Its one real virtue: it says *class*, not *academy*.
2. **The sender number's country code.** A local number is materially better for first-contact trust; it also carries KYC and local-entity requirements. **Gates parent-funnel conversion, so decide before phase 6.**
3. **Category scope at launch.** The model — classes, sessions, players, rates — generalizes past sport to music, dance and tuition without change. How much genericizing before tenant #2 rather than after is open. **"Academy" is the word that does not generalize, which is why it appears nowhere a user can see it.**
4. **Model tiering.** A cheaper model for clients and coaches, the strong one for admins and synthesis, is the presumed split. Decide against live cost data from phase 2's instrumentation.

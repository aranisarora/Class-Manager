# Class Manager — product specification

> Build document. Everything needed to implement the product: setup, invariants, architecture, data model, behavior, message catalog, scheduled work, and build order.
>
> **Stack:** Next.js (API, webhook, emulator) · Supabase (Postgres, RLS, Storage) · WhatsApp Cloud API (Meta, direct) · everything form-shaped is asked for in the chat (§14.6) · DeepSeek, text only (§14.5) · a durable job scheduler, which is required, not optional (§13).
>
> **Read §2 before writing any code.** Those rules are broken by omission, not by intent.

---

## 1. Setup prerequisites

Assume all of this is configured before phase 0.

**Meta**
- Meta Business account, business-verified (gates tier progression)
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

**Ongoing**
- Message templates submitted per category (§16.2)
- Sender routing table seeded with this number (§16.3)

---

## 2. Invariants

Non-negotiable. Each is a rule a plausible-looking implementation breaks silently.

1. **RLS is the security boundary; the LLM is a user of it.** Every conversation acts through a real per-user Postgres session. Tool availability is UX — it shapes cost and behavior, it does not enforce anything. Database policies are security. Every table carries `academy_id`, and every policy has a regression test.
2. **Mint once, replay verbatim.** A button's action is authored at compose time, validated, stored. The tap replays the stored payload. **No model inference at tap time**, where a misread commits someone to being somewhere.
3. **Compute the effect before committing it.** Model-authored writes run inside a transaction whose affected rows are captured and shown before commit. The bot never estimates blast radius — it knows (§14.2).
4. **Sending is not receiving.** `queued ≠ sent ≠ delivered ≠ read`, enforced in schema, code and copy. The bot never claims what it cannot see. **`read` is an optional signal** — a recipient with read receipts switched off never generates one, so absence of `read` is *no information*, never evidence of not-read, and the copy must never imply otherwise.
5. **Multi-step consequences live in transactions, not in the model's memory.** A cancel that credits and notifies is one operation that cannot half-complete — and **messages inside it are staged until commit**, so a rollback has messaged nobody (§14.2.1).
6. **Nothing is sent during onboarding until the admin says go.** Building the roster messages nobody.
7. **Parsed input is a proposal, never a write.** Anything read *out of* what somebody typed — rather than stated outright — is read back before it is acted on (§14.5).
8. **Every proactive message must pass one test, at runtime:** would this recipient have asked for it? This is not a review checklist — the bot composes its own messages (§14.4), so it applies the test itself, before sending.

---

## 3. What the product is

Indian coaching businesses run on WhatsApp by hand — schedules, payment chasing, cancellations, parent communication. This moves that workload onto a WhatsApp-native manager. Clients book, pay and get reminded. Coaches get their day and mark attendance with taps. Admins run the business through natural language and menus.

**The chat is the interface. Nobody installs anything. Nobody logs in. Nobody leaves WhatsApp.** Everything form-shaped is **asked for, one question at a time** (§14.6); anything spatial or dense is **rendered to an image and sent in the chat** (§14.6). There is no web surface, no form and no link to tap — see §15 for what was removed and why.

Every user is **WhatsApp-only by design**. A number not on WhatsApp is out of scope.

**This is a manager, not a notification system.** It is expected to notice things nobody asked it to look for, compose messages nobody specified, and answer questions nobody anticipated. The architecture in §4 exists to make that safe rather than to prevent it, and §13.1 is what lets it act on its own schedule rather than only when code wakes it.

---

## 4. The behavior system

The bot carries a lot of doctrine. Feeding all of it into every prompt is expensive and dilutes attention. The resolution: **behavior belongs at the lowest layer that can hold it.** Pushed down, it becomes free and unforgettable.

| Layer | Holds | Context cost | Can the model forget it? |
|---|---|---|---|
| **0 · Schema** | Unique keys, FKs, RLS policies | Zero | No — the database refuses |
| **1 · Operations** | Transactional writes carrying their own consequences | Zero | No — it's inside the transaction |
| **2 · Core doctrine** | Rules shaping *every* reply | ~300 tok, cached | Rarely |
| **3 · Domain facts** | Facts no derivation produces (§4.2) | Small, cached | Rarely — always in context |
| **4 · Memory** | This academy, this person (§5) | Small, per-conversation | — |
| **5 · Lint** | Post-generation repair | Zero | It's a check, not a rule |

**The placement test — "if the model forgets this, what breaks?"**

- Data corrupts → layer 0 or 1
- The interaction goes wrong → layer 2 or 3
- A nuance is missed → layer 4
- The wording is off → layer 5

Most of what feels like bot behavior belongs in layers 0–1. *"Ending a coach must issue a final statement"* is not a rule to remember; it is a line inside `end_coach()`.

### 4.1 Layer 2 — core doctrine

Always in context, and they shape every single reply. `lib/doctrine.md` is the file; this is the summary.

1. **Quiet by default.** Every proactive message must be one its recipient would have asked for. No engagement pings, no "just checking in," no message whose only job is reminding people the bot exists.
2. **The prompt is a convenience, not the interface.** Every prompted action works unprompted — and **say so once, early**, because nobody assumes it and the people who never find out are the ones who wait for a message before telling you something you needed an hour ago.
3. **Speak the academy's language.** Use their words, from memory (§5). Never introduce vocabulary they haven't used.
4. **Buttons first, text always available.** Free text is an escape hatch on every message, never the required path. A form is a button too, and a form is always an offer and never a toll.
5. **Read back before acting** on anything parsed, and anything touching more than one person.
6. **Never claim what you can't see.** Queued is not delivered. Confirmed is not arrived.
7. **Offer the natural next step as a button** after every action (§4.3).
8. **Suggestions ride on messages already being sent**, never as a standalone interruption.
9. **Roles are hats.** Never ask someone to confirm something to themselves.
10. **When uncertain, say so plainly** — and about *which part*. "The fourth row is cut off, I can see a Saturday 10–11 slot and something like 'sub jr'" is worth a reply; "I couldn't read that" makes them redo work you already did.
11. **Zero rows is an answer, never the whole answer.** Widen once and say what is actually there: *"Nothing this week — his first is Mon 17 Aug, 6am."* Off the row you just read, never off a pattern you remember.

The five below were added after reading a month of the product's own transcripts against how a competent manager would actually have handled them. Each names a failure that was invisible because every individual message was *correct*.

12. **Answer in proportion.** The reply to a confirmation is an acknowledgement. Somebody who taps a button saying they'll be there has said everything; **"👍" is the whole correct answer**, and restating their child's name, the class, the time and the venue is noise wearing helpfulness as a costume. Length is earned by news, by a decision, or by something going wrong.
13. **Say what will stop, not only what will happen.** People model this thing by what reaches their phone, so the absence of a message is information you owe them. *"One tap, and I don't ask again."* *"You're out of it — I won't chase you about tonight."* A promise to be quiet is the most valuable thing you can say and the one nobody thinks to.
14. **The cost goes before the tap, never after.** Anything that charges someone or gives up their place says so *in the confirmation*, with the number. Discovering a charge afterwards is how a fee becomes a dispute, and the sentence costs nothing to move.
15. **Close what you opened.** Whoever raised a thing hears its outcome, not just its acknowledgement. A handoff with no return trip is indistinguishable from being ignored.
16. **Teach the surface once, where it is useful.** Nobody guesses they can type a whole week in one messy sentence and have it read back, or use a broadcast list instead of a group. Say it at the moment it saves them the work — never as a tour.

### 4.2 Layer 3 — domain facts (the behavior modules, retired)

This layer used to be eleven prose behavior modules — one file per situation, each opening with a trigger condition, ~62k characters of scripted move-by-move. **They were retired on 2026-08-15, by measurement, not by taste.** The phase-6 live arc drove the same 18-case lifecycle with and without them, one variable apart: truth tied (253/261 both ways), the module-free arm's replies were plainer (49 words vs 72), its two best moments were *derived* from doctrine rather than prescribed, and the prescriptions were implicated in their own arm's two worst behaviors — a runaway destructive cascade shaped by a module's endings, and pseudo-buttons imitated from module example formatting into live message bodies.

The modules were compensation for a model that decided everything at zero deliberation, because deliberation corrupted the previous provider's function calls. A model that cannot deliberate needs the deliberation done for it, in advance, in prose. That constraint is gone: the current provider reasons in a separate channel, and the interactive path runs with thinking on (§14.5's client).

What replaced them, in the cached prefix:

- **A derivation instruction.** There is no playbook of situations on purpose; the model reasons from doctrine to what the moment needs — who is affected, who must hear, what must be confirmed, what will stop, who owns what happens next.
- **A compact facts block** (`lib/agent/context.ts`, `DOMAIN_FACTS`) holding what no principle regenerates: a block is stronger than an opt-out; one block in a batch is a signal about the batch; a broadcast list only delivers to people who saved the admin's number; the commonest true dispute is the out-of-band cancellation; escalations are about sessions, never people; and so on. Facts state; they do not demonstrate — no worked chat examples, because the model imitates an example's surface along with its content.

**No count is stated anywhere the model reads.** A number in the prompt is the one thing that goes stale silently — nothing checks it, and the model cannot tell a miscount from something it was told to ignore.

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
STABLE PREFIX  (byte-identical across turns; changes only with schema or doctrine)
├─ core doctrine
├─ schema
├─ domain facts
├─ operations framing + catalog digest
└─ tool declarations

VARIABLE TAIL  (never cached)
├─ memory hot set
├─ conversation
└─ query results
```

**Keeping the prefix byte-identical is the whole discipline, and it is now the whole mechanism.** The provider caches automatically: the server reuses the KV cache of any request whose tokens begin with a byte-identical prefix, a cache-hit token costs 3.2% of a miss, and there is no handle, no TTL and no storage fee. Nothing has to be decided — the prefix simply has to stay stable and academy-independent, with everything variable below it. `academy.prompt_cache_handle` stays null permanently: it assumed a per-academy prefix, and one cache serves every tenant. Two things throw the hit away, and both are avoidable — a changed tool description (one miss-priced call, not a failure), and a per-tenant `user_id`, which buys KVCache isolation and would partition the shared prefix, so it is never sent.

The measured history is worth keeping: the previous provider's *implicit* cache never bit at all (0 cached tokens cross-turn), which is why that client grew 140 lines of explicit-cache machinery, and why this design's reward only arrived with the provider that pays it — measured live at 91–98% hit.

### 4.5 Layer 5 — lint

Deterministic repair on generated output, for rules a model under pressure will otherwise break:

- Strip internal identifiers (uuids, table names)
- Rewrite machine timestamps into the academy's timezone and idiom
- **Downgrade claims the system can't back** — "delivered" where only "sent" is known
- Flag product vocabulary the academy's memory says they don't use

All four are string operations, which is the whole test for belonging here. **Number-grounding is not a lint rule.** Tracing every numeral in generated prose back to a query result is an attribution problem, not a regex, and it false-positives on dates, times, ages, prices and "three weeks." It is a prompt rule (§10.2) verified by eval (§17), not a deterministic gate.

---

## 5. Memory

Each entity accumulates facts the bot reads and writes. This replaces any notion of a fixed settings table for soft facts.

**Academy memory** — vocabulary, policies that emerged in conversation, quirks the schema can't hold. *"Calls them batches, not classes." "Runs a separate fee cycle for the Sunday camp." "Doesn't want parents told about coach swaps."*

**Person memory** — *"Asks about collections every Monday morning." "Never taps buttons, always types." "Kid has boards in March, expects a pause."*

**Facts are kept; context is bounded.** These are two different things, and collapsing them into one capped text blob is how a memory system becomes an amnesia system — the pruning decision then gets made by a model under context pressure, and what it drops is invisible.

- **`memory_fact` is append-only and is the record** (§6.2). A fact is never edited or deleted; it is superseded by a newer fact, or retired. Nothing the bot learned is lost because the prompt budget got tight.
- **`academy.memory` and `person.memory` are a bounded hot set** — the facts currently worth carrying in the prompt, rebuilt from the store. This is a cache, not the record.
- **Anything outside the hot set stays retrievable.** The bot searches the store when a conversation reaches for something it isn't carrying. **Forgetting is a context decision, never a storage one.**

**Design constraints:**

- **The bot writes facts asynchronously after a turn**, never blocking a reply
- **Facts, not transcripts.** "Prefers voice notes over typing" — not a log of what was said
- **Curation is scheduled, not per-turn.** Rebuilding the hot set is a model call, and running one after every turn roughly doubles the model calls in the product for no benefit. It runs when a subject's store crosses a threshold (§13)
- **Visible and editable.** The admin can ask *"what do you know about me?"* and correct it — a correction writes a superseding fact rather than destroying the old one. This matters for trust and it is a cheap debugging surface
- **Observed patterns live here.** If an admin asks about unpaid fees every Monday, that is a fact, and the Monday brief reads it and offers the button
- **Memory that nothing acts on is a diary.** Reminder lead times, nudge timings and menu contents are all read from here (§7.2, §8.2). A fact that changes no behavior was not worth storing

---

## 6. Data model

Postgres. Every table: `id uuid pk default gen_random_uuid()`, `created_at timestamptz default now()`, and — except `academy` and `sender` — `academy_id uuid not null references academy(id)`.

**`sender` is the one deliberately global table.** One number serves many academies (§16), so it cannot carry a tenant. It holds credentials, is never reachable through a user session, and is readable only by the send path's own role.

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
  memory                     text,          -- §5. bounded hot set, not the record.
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
  memory     text,                         -- §5. bounded hot set, not the record.
  settings   jsonb not null default '{}'   -- per-person timing overrides (§8.2)
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

memory_fact (                               -- §5. append-only. this is the record.
  subject_kind text not null,               -- academy | person
  subject_id   uuid not null,
  fact         text not null,
  source       text,                        -- the turn or observation that produced it
  supersedes   uuid references memory_fact(id),
  retired_at   timestamptz
)
```

**Facts are never updated or deleted.** A correction writes a new row pointing at the one it supersedes; `academy.memory` and `person.memory` are rebuilt from the live set on a schedule. This makes "why does it think that?" answerable, which a mutable blob does not.

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
  rate_unit   text,               -- per_session | per_month | per_term | per_package
  rate_count  int,                -- per_term: months in the term.
                                  -- per_package: sessions in the package. else null.
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
  rate_count  int,                 -- null = inherit from class
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
  status             text not null,   -- present | late | absent | cancelled_timely
  note               text,
  marked_by_coach_id uuid references coach(id),
  marked_at          timestamptz not null default now(),
  unique (session_id, player_id)
)
```

**Rate lives on the enrollment, defaulting from the class** — `coalesce(enrollment.rate_amount, class.rate_amount)`, and the same for unit and count. This handles drop-ins inside a monthly batch, sibling discounts, scholarship players and legacy rates without a schema branch.

**Four rate units, because Indian coaching businesses sell four ways.** Per-session and per-month are the common two; term and quarterly fees are normal and are just a longer period; ten-class packs are normal and are consumption-based. Adding these later is a schema migration on live billing data, which is the worst place to discover a missing enum value.

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
  kind        text not null,                    -- session | monthly | term | package
                                                --  | adjustment
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

- `per_session` → a `session` line is written when attendance is marked `present`, `late` or `absent`. Not for `cancelled_timely`.
- `per_month` → one `monthly` line per period per active enrollment, on the first. Attendance does not affect it.
- `per_term` → the same, one `term` line every `rate_count` months. Term and quarterly fees differ from monthly in exactly this and nothing else.
- `per_package` → one `package` line when a package opens. Sessions consume it on the `per_session` rule; when `rate_count` sessions are consumed the next session opens a new package and writes the next line. **The count remaining rides on the tally** — a parent who has bought ten classes will ask, and should never have to.
- **The cancellation window carries money meaning only for `per_session`.** For `per_month` it is a headcount signal to the coach. Same interface, different consequence, no extra code.
- **Adjustments are one primitive, not six features.** Waiving a class, crediting an academy-cancelled session, pro-rating a mid-month join, a sibling discount, goodwill and the free trial are all `kind='adjustment'` with a reason and an approver.
- **The free first class is a rule that mints an adjustment** — a negative line equal to the first `session` line. **Per player, not per account.** A second child gets their own trial.
- Balance for a period = `sum(tally_line.amount) - sum(confirmed payment.amount)`.

### 6.5 Messaging and actions

```sql
sender (                          -- §16.3. global, no academy_id. never a constant.
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
  kind                   text not null,    -- operation | steps | ... deliberately open (§6.5)
  payload                jsonb not null,   -- fully resolved. no ids to look up.
  minted_at              timestamptz not null default now(),
  minted_for_contact_id  uuid not null references contact(id),
  expires_at             timestamptz,
  consumed_at            timestamptz,
  consumed_by_contact_id uuid references contact(id)
)
```

**Every interactive button carries an `action.id` as its reply payload.** On tap: load, check expiry and consumption, check the tapping contact matches `minted_for_contact_id`, execute the stored payload, stamp `consumed_at`. **No model call, no re-resolution, no string parsing.**

**`kind` is not a fixed list of verbs.** Two generic kinds make the button surface exactly as wide as the write surface:

- `operation` — a named operation (§14.2) plus its fully resolved arguments
- `steps` — a `transaction(steps[])` plan (§14.2.1), validated and diff-computed at mint time

Both are authored at compose time, when the model has the context to get them right, and replayed verbatim at tap time. **The freedom is in what can be minted; the safety is that minting and tapping are different moments.** Invariant 2 is untouched. Without this, §4.3's follow-up buttons can only ever demonstrate verbs someone hardcoded, which caps the product's discoverable surface at its tool authors' imagination.

**There is no `flow_send`, and there is no third kind.** A `flow_send` table was specified here — one row per WhatsApp Flow put in front of a human, with a `flow_token` matching the response back to it — and was never built before Flows were removed (§14.6). Form-shaped work now arrives as ordinary inbound text, so it needs no token, no per-send row and no response schema: **the answer to a question is a message, and messages already have a table.**

What that costs is the one guarantee the token bought — a submission executed with no model call between the send and the write. A typed answer has to be understood, so it goes through the model like anything else. That is the trade §14.6 makes deliberately: understanding *"just Aarav, and Kiran was twenty minutes late"* is the capability, and it is not reachable by a form that never had a field for it. **The write it reaches is still a named operation, so what a sentence can do is bounded exactly as a tap was.**

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

**The bot can enqueue jobs for itself** — `kind='agent_task'`, carrying an instruction and the query that feeds it (§13.1). That one row type is what keeps the proactive surface open-ended instead of a fixed list of things code knows to do.

### 6.7 RLS policy summary

| Role | Sees |
|---|---|
| Admin | Everything within their `academy_id` |
| Coach | Own `coach` row including own pay. Sessions they are assigned to, and those rosters and attendance. **Never** another coach's pay, never the academy's money |
| Account holder | Own account, its players, enrollments, attendance, tally lines, payments. Sessions their players are in. **Never** another family |
| Player's own contact | As their account holder, minus every `tally_line` and `payment` — money-shaped rows never route to a player number |

`sender`, `job` and `memory_fact` are infrastructure: reached by the runtime's own role, never through a user session. A self-scheduled task (§13.1) is the exception that proves it — it runs under the session of the human whose turn minted it.

Every policy carries a regression test asserting cross-tenant and cross-role reads return zero rows. **Plus one meta-test: fail the build if any table has RLS disabled.** That single assertion catches the most common and most dangerous mistake. Write these as pgTAP tests against the real policies, not through app code.

---

## 7. The admin

**"Admin," not "owner" or "founder."** It is the word Indian coaching businesses, gyms and tuition centres use, it names a role rather than a status, and it survives the solo case without sounding strange.

### 7.1 Onboarding

The unavoidable cost of adoption is **data entry**. Reducing it is the highest-leverage work in the product.

1. **The setup ladder** (§14.6) — business name, category, venues, operating pattern, cancellation window, asked in the chat. This was a one-screen form and the form is gone, so the cost to beat is the dozen small waits a naive ladder would spend: **assume what can be assumed and say so, take everything a sentence gives, and stop as soon as there is enough to create a class.** The rest is filled in when it matters. `set_up_business` is safe to call repeatedly, so a fact learned is a fact written.
2. **Bring the timetable in one message, however messy** (§14.5). "Mon & Wed 6:30 beginners at Green Park, Sat 8am juniors" — no punctuation needed, every class at once. The bot parses, reads back, creates on a tap. **This is the single biggest friction reducer in the product**, and since §14.5 was repealed it is the only one: a photo of the whiteboard is answered with an apology and this sentence.
3. **Coaches** — §8.1. Three facts each, and the bot invites them. The admin forwards nothing.
4. **Families** — §9.1. Contacts typed in, roster built, nobody messaged — the invites go out at go-live, from the bot.
5. **Payments** — one UPI handle. Rail 1, under a minute.

**Everything goes in at once.** Partial state is worse than either extreme: the admin would have to remember which classes the bot handles, a parent with two children would get reminders for one, and a coach seeing 1 of their 3 sessions loses trust immediately. If the bulk import in step 2 works, this is minutes rather than an hour.

**Joining mid-cycle is expected:** the admin marks who has already paid and until when. Counting starts fresh and **nobody is ever chased for money from before the platform**.

End state: a working academy, and **no parent messaged yet** (§2.6).

### 7.2 Day-to-day

- **A natural-language CLI over the whole business.** Schedule and move classes, manage coaches and clients, waive a fee, message anyone, ask anything. Reads and writes are both model-authored (§14.2).
- **Menus as the missing nav bar.** A blank chat box with dozens of capabilities discovers worse than an ugly nav bar. A persistent list-picker is the primary affordance; prose is the fallback; follow-up buttons (§4.3) do the ongoing teaching. **The items are generated from what this admin actually does** (§5) — *Schedule / Clients / Money / Coaches / Insights* is the cold-start default, and an admin who asks about fees daily and has never opened Insights should see a different list by week three. A fixed taxonomy is the one part of the nav bar worth not copying.
- **Two bookends, quiet between.** Morning brief led by *Needs you*. Evening digest (§10.2). Between them only genuine escalations interrupt. **The admin's phone is a briefing, not a ticker.**
- **Proof it's working, pushed not pulled.** The admin will not think to ask whether reminders went out, so the digest carries delivery health unconditionally: *"41 reminders, 40 delivered, 1 failed — [see who]."*
- **Insights on demand.** Answered in chat, and **rendered to an image when the shape is the point** — a week's timetable, a trend line, a month grid (§14.6). An image needs no tap, has no expiry, and survives being forwarded to a business partner.
- **Audit trail and an undo window** on destructive operations. At multi-tenant scale a bot mistake is someone else's business. **Undo reverses database writes only.** A sent message cannot be unsent, so undoing an operation that messaged people sends a correction to exactly those people, and says so before it runs — *"I'll put the 14 enrollments back and tell the 14 parents I was wrong."* Anything more is a promise the product cannot keep, and building undo as if it could is how it half-works.

---

## 8. The coach

### 8.1 Onboarding

Three constraints: the coach is a **warm contact** (the admin employs them), **turnover is high**, and the admin therefore runs this **several times a year**. Target: **under a minute for the admin, one tap for the coach.**

**Step 1 — the admin supplies three facts.** Contact (name and number, typed), which classes, pay rate. Nothing else. No availability grid — the admin assigns the coaching, so there is nothing to declare. `status='added'`. **Messages nobody.**

**Step 2 — the bot sends the invite** [`CO-INVITE`]. Straight to the coach, from the academy's own number, the moment the admin asks. `send_invite`, one call, `status='invited'`. **The admin forwards nothing.**

It goes out of window, so an approved template carries it — `coach_prompt`, which already covers the coach rows, so this costs **no new approval**. The template is a window-opener (§14.7): the coach's tap *is* their first inbound, which opens the window and lands them in Step 3 for free. It names the admin who added them — *"Sharwin added you as a coach"* — because that is the recognised thing, and the number is not.

**This step used to be a deep link the admin forwarded per person**, so the recipient sent the first message and the window opened from their side: free, no template, no tier consumption. That saving was real and it was small, and it was paid for with the scarcest thing in the product. It made the admin the transport — every coach and every family a separate manual forward — and its failure mode is silent, because a coach who was never sent anything looks exactly like a coach who never tapped. §7.1 names reducing the admin's onboarding work as the highest-leverage thing here; a per-person forward is that work with a third party's attention span added to it.

**The forwardable link survives as a repair, not a route.** `send_invite(as_draft: true)` mints it for a number the bot could not reach — not on WhatsApp, or blocking us. It **records nothing**: the runtime cannot see the admin's forward, so the coach stays `added` and keeps being chased. A `[Sent it]` button writing `status='invited'` is precisely the unwitnessed claim §14.2's stripped-parameter rule exists to refuse.

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
5. **After class — the register** [`CO-REGISTER`]. `[All present]` is a chat button, because that is the majority case and one tap beats opening anything. `[Take register]` asks for it in the chat (§14.6).

   **The register is inverted, and that is the design.** It does not ask for a decision per player; **absences are sparse**, so it asks *who wasn't here*, then *who was late*, as two multi-select lists over the roster, with a note field. A twelve-player class where everyone came is one tap; where one child is missing it is two. Asking twelve three-state questions to learn one fact is the shape that makes coaches stop marking registers.

**The timings are defaults, not constants.** T-60, T-30, T-15 and `client_reminder_lead_hours` are academy defaults that a person's own record overrides (`person.settings`). A coach who has confirmed at the door forty times running should stop being asked at T-60; a parent who needs a day's notice gets a day. **The bot sets these from observed behavior** (§5) and can say why. One lead time for every family in an academy is a schedule; per-person timings are a manager.

**One confirmation is enough.** A coach who taps `[Yes, I'm coming]` is never asked again — no arrival prompt, no second nudge. They will say if something changes. The session is assumed started at `starts_at`.

**That is a strong default, not a fact about the system.** A coach who has confirmed and then not shown up three times is a different situation, and the bot may check — with a reason it can state. Rules that can never bend make a system stupid in exactly the cases that matter; rules with no default make it chaotic. **Defaults, plus a stated reason for departing from one, is the shape** — and it applies to every "never" in this document that is not an invariant in §2.

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

**Don't import — reach out.** The admin types the roster in; **the bot does the outreach**. Nothing about joining is the admin's errand.

**Step 1 — the admin types the families in, or shares their contacts.** One line per family, children's names with them; several families in one message is normal and expected. **A shared contact card works too, and several at once** — it carries the name and the number, which are the two fields a typed line most often gets wrong, so what is left to type is the child and the class. (A photographed register was the other intended route and still does not reach the model — §14.5.) The bot builds `person`, `contact`, `account`, `player`, `enrollment` — **while messaging nobody.**

**Step 2 — the bot sends the invite** [`CL-FIRST-CONTACT`], at go-live, to every registered contact this academy has never messaged. Soonest session first. It carries the child's name and the class they are actually in, because that is what makes it read as continuity rather than as a stranger with a link. A reply lands in `CL-INTRO` — whose manager this is, the three things it does, then **proof instead of promises**: the child's actual schedule, with a useful next tap.

**Nothing waits for a near session.** This message used to be the fallback for parents who never tapped the admin's forwarded link, so it fired only when a session was within 48h. As the invite, that bound was a trap: a family whose class is next Tuesday sat unreachable for six days, and a family enrolled in a class with nothing scheduled yet sat unreachable forever. Going live is the reason.

**It is staged and it halts** — rule 6 below, unchanged and now load-bearing rather than precautionary. Batching with a halt on the first bad signal is what stops "the bot sends" from being a bigger blast radius than "the admin forwards": a bad roster costs ten messages and a question, not forty and a quality strike (§16.1).

**What this replaces, and why the saving was not worth it.** Step 2 was a deep link the admin forwarded — ideally into the academy's existing parents' group, or via a Broadcast List — so the parent always sent the first message and the window opened from their side, free. The problem was never the arithmetic: it was that a broadcast list silently delivers only to people who have the admin's number saved, a group post reaches whoever happens to read it, and everyone else gets **silence during a go-live, which is the worst failure the product has because it looks exactly like success.** The bot sending each invite makes delivery a fact the product can see, and a failure something it can report.

**Identity is the phone number. There are no join codes.** Step 1 registered the number, so a recognized sender resolves on sight. For a number Step 1 never saw — a forwarded invite, a second parent — the academy's name in the message is what they reply about, and it resolves by name plus one confirming question.

**First-contact rules, whichever path produced the message:**

1. Academy's and player's name in the first line — the recognized name does the trust work
2. Say something only the real academy could know (the class, the time)
3. One *useful* button, never a consent-shaped one
4. Frame as service continuity ("class updates have moved here"), never launch — "introducing…" is marketing category
5. Admin's heads-up goes out hours earlier, bot-drafted and admin-forwarded — into the parents' group or wherever they already talk. This is the one thing the admin still sends by hand, and it matters more now that the first message from us arrives unannounced: it is warming, not delivery, and nothing depends on who reads it
6. **Staged, as a job with a batch size** (§13) — 10, check delivery, read and block signals, then the rest in batches, halting on a bad signal. Not a campaign system: for a forty-family academy this is two batches

### 9.2 Day-to-day

- **Reminders worth tapping** [`CL-REMINDER`] — *"Aarav has Beginners Batch tomorrow 6:30 at Green Park"* `[I'll be there]` `[Can't make it]`. **"Can't make it" confirms before it acts**; a pocket mis-tap must never give away a seat.
- **Book, cancel, reschedule** through buttons and lists first, free text always available. **Scope is always asked: this session, or every week?**
- **Reschedule is the makeup** — the session moves to another slot of the same class rather than becoming a refund argument.
- **Told when the session is in trouble, not when it is fine.** The claim ladder from §8.2 — *starting* is what we assume, *the coach has arrived* is what we have evidence for — governs what the bot is allowed to say. **It only says it when it carries something the parent doesn't have:** the coach is late, the session is uncovered near its start, or something changed. A parent standing at the court does not need to be told class started; that is the clearest example in the product of a proactive send that fails §2.8, and it spends per-recipient frequency budget on a shared number to do it.
- **After class, the outcome** [`CL-OUTCOME`]: attended or missed, with the coach's note. An absence arrives as something to fix — `[Rebook]` — not a verdict.
- **Pay by UPI in the chat.** Receipts and the month's tally in the same thread, line by line.
- **Progress** — attendance and coach notes, per player.
- **A human when it matters** (§14.8).

---

## 10. The prospect

A fourth persona-phase cell, and the cheapest acquisition path in the product: the user initiates, so the window is open, free, and carries no template, tier or block cost.

### 10.1 Cold inbound

A QR code at the court, a "Message us" link on a website or Instagram bio. **Assume this is always on.**

**Routing.** The bot serves many academies on one number, so an inbound must resolve to *which* academy. This is a functional requirement, not a security one. The link carries prefilled text naming the academy — `wa.me/<number>?text=Hi Ace TT Academy` — and the bot matches on it. No token infrastructure.

**The prefill is a hint, not a protocol.** It is editable, and people clear it and type "hi". When it is absent the bot asks which business, in one sentence, once (§10.1 has no fallback beyond that because none is needed).

**A known number that arrives through a prospect entry point is still a known number.** A QR at the court is scanned by existing parents more often than by strangers — for directions, for the schedule, because it is the poster on the wall. **Identity wins over entry point:** the contact resolves to their existing person, and they get the client surface, not `PR-WELCOME`. The one thing the bot must not do is create a second `person` for someone already in the roster, which is the failure this rule exists to prevent. An existing parent asking about a *different* child is a new `player` on the same account, never a new account.

**Name comes free.** The inbound webhook carries `profile.name`, the sender's own WhatsApp display name. Self-set and unverified, and it is the *parent's* name not the child's — but it turns two questions into one.

**A conversation, not a wizard.** The most common real first message is *"my daughter is 14 and has played for three years, is your beginners class right for her?"* — and a scripted name → age → pick-a-class sequence has nowhere to put that. This is the highest-stakes conversation in the product, with a stranger, and it ends in one operation rather than being one:

1. Cold inbound → academy resolved → `contact.state = 'prospect'`, `person` created
2. [`PR-WELCOME`] *"Hi Rajesh! I'm the class manager for Ace TT Academy."* → what's on offer → `[Book a free trial]` `[See the schedule]` `[Talk to Sharwin]`
3. **The bot talks.** It holds the catalog, the schedule and which classes have room, so it answers what a parent actually asks — is this the right level, what does it cost, where is it, is there anything on Saturday, my son is left-handed does that matter. Whatever it learns along the way is what it needed to know
4. When the conversation has produced a player and a class, it calls `book_trial(...)` — one transactional operation (§14.2.1) creating `account`, `player`, a trial `enrollment` and the booking, then telling the parent [`PR-TRIAL-CONFIRMED`]. **Auto-confirmed, no admin gate**
5. The admin is notified after the fact [`AD-NEW-TRIAL`] with `[Undo]` — *"New trial booked — Aarav, 9, Saturday Beginners"*

Zero friction on the funnel; the admin retains an undo rather than a gate. **Step 3 is the product and the other four are plumbing** — a scripted funnel here converts worse than a human would and is the moment a prospect decides whether this academy is worth their time.

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

1. **Every number traces to a query result in the payload.** A prompt rule verified by eval (§17) — see §4.5 for why this cannot be a deterministic lint pass.
2. **Comparison requires a baseline in the payload.** "Attendance is down" needs last month's figure *present*, not recalled. No baseline, no claim.
3. **Uncertainty is stated.** *"Might be a pattern, might be coincidence at this size"* beats a confident causal story.

**The mix shifts over the first month.** Week one leans on proof — delivery health, what was done. Month two leans on synthesis, because by then the admin trusts the mechanics and wants the thinking. This is a prompt instruction driven by the academy's age, not two code paths.

The morning brief follows the same construction, led by *Needs you* and silent when there is nothing.

**Synthesis only ships inside the window, and this is a hard constraint, not a preference.** Meta rejects templates whose body is substantially one variable, so *freely composed prose cannot go out as a template* — `admin_digest` (§16.2) can carry a structured brief with real parameters, and it cannot carry this. An admin who has not messaged in 24 hours therefore gets a **window-opener** naming the one thing that needs them, and the written digest lands the moment they reply. In practice an active admin is almost never out of window, because every button they tap re-opens it (§14.7) — but "almost never" is a thing the send path has to handle, not a thing the design gets to assume.

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

**These are intents, not messages.** Each row names a moment code knows about — a reminder is due, a register is unmarked, a coach hasn't confirmed — and carries defaults: default timing, default buttons, default to sending. **Code guarantees the moment is put in front of the bot. The bot decides what actually happens.**

On any row below it may:

- **suppress** — this family has confirmed every week for four months and never missed; the reminder is noise
- **merge** — three things happened to one parent today, so they get one message, not three
- **retime** — this coach needs three hours' notice, not one (§8.2)
- **re-button** — the useful next step here is not the default one
- **rewrite** — always, in the academy's own words (§5)

It applies §2.8 to make that call — the same test it applies to messages it composes itself (§14.4). **The defaults are what a competent manager would do knowing nothing about the person. Departing from them, knowing something, is the entire reason a manager beats a cron job.**

**Two limits on that freedom.** Rows marked **fixed** cannot be suppressed — they exist for a reason that is not about engagement, though they may still be reworded and merged. And nothing reaches the wire outside the one send path (§16.3), so throttles, caps and staging apply no matter who decided to send.

**Fixed:** `CL-CANCEL-CONFIRM`, `CL-SESSION-CANCELLED`, `CL-TALLY`, `CL-RECEIPT`, `CO-FINAL-STATEMENT`, `AD-NEW-TRIAL`, `AD-OPT-OUT`.

**This is also not the complete set of what the bot sends** — it composes messages nobody specified (§14.4). These are the moments code knows to raise.

### 12.1 Client

| ID | Trigger | Buttons | On silence |
|---|---|---|---|
| `CL-INTRO` | First inbound — a reply to the invite, or a known number writing in | `[See <player>'s schedule]` | — |
| `CL-FIRST-CONTACT` | **The invite. Bot-sent** at go-live, to every registered contact never messaged; staged, halts | `[See schedule]` `[Stop these]` | Nothing. No nag. |
| `CL-REMINDER` | `client_reminder_lead_hours` before | `[I'll be there]` `[Can't make it]` | Nothing |
| `CL-CANCEL-CONFIRM` | Tap of `[Can't make it]` | `[Yes, cancel]` `[Never mind]` | Expires 1h |
| `CL-SESSION-TROUBLE` | `running_late`, or uncovered near `starts_at` | — | — |
| `CL-OUTCOME` | Attendance marked | `[Rebook]` when absent | — |
| `CL-TALLY` | Month end | `[Pay now]` `[See the lines]` | Dunning takes over |
| `CL-RECEIPT` | Payment confirmed | — | — |
| `CL-DUNNING` | Per policy, unpaid | `[Pay now]` `[Already paid]` | Escalates to admin |
| `CL-SESSION-CANCELLED` | Session cancelled | `[See other slots]` | — |
| `CL-SESSION-MOVED` | Rescheduled | `[Got it]` | — |

**No "class is starting" or "coach has arrived" message exists.** The claim ladder in §8.2 governs how the bot words things it is already saying; a parent at the court does not need telling that class started (§9.2). `arrived_at` stays as data — it is load-bearing for coverage.

**A coach change is normally one line inside the next `CL-REMINDER`**, never a standalone broadcast, which manufactures anxiety about a routine event. A default, not an absolute: the head coach of twelve years leaving is not a routine event, and the bot may say so directly.

### 12.2 Prospect

| ID | Trigger | Buttons |
|---|---|---|
| `PR-WELCOME` | Cold inbound resolved to an academy | `[Book a free trial]` `[See the schedule]` `[Talk to <admin>]` |
| `PR-TRIAL-CONFIRMED` | Trial auto-booked | `[Add to calendar]` `[Directions]` |

### 12.3 Coach

| ID | Trigger | Buttons | On silence |
|---|---|---|---|
| `CO-INVITE` | **The invite. Bot-sent** to the coach when the admin asks | `[See my classes]` `[Not me]` | Admin is told via `AD-COACH-NOT-ONBOARDED` |
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
| `client_session_trouble` | `starts_at`, only if late or uncovered | `trouble:<session_id>` |
| `client_reminder` | Lead hours before, per-person offset | `cl_rem:<session_id>:<player_id>` |
| `post_class_register` | `ends_at` | `register:<session_id>` |
| `register_expiry` | `ends_at` + 2h | `reg_exp:<session_id>` |
| `client_outcome` | On attendance marked (event) | `outcome:<session_id>:<player_id>` |
| `admin_morning_brief` | Daily | `ad_brief:<academy_id>:<date>` |
| `admin_evening_digest` | Daily | `ad_digest:<academy_id>:<date>` |
| `monthly_lines` | 1st of month | `monthly:<enrollment_id>:<period>` |
| `month_end_tally` | Month end, per account | `tally:<account_id>:<period>` |
| `dunning` | Per policy | `dun:<account_id>:<period>:<n>` |
| `first_contact_batch` | Onboarding staging (§9.1) | `fc:<academy_id>:<batch_n>` |
| `memory_curate` | When a subject's fact store passes its threshold | `mem:<subject_id>:<n>` |
| **`agent_task`** | **Whenever the bot schedules itself (§13.1)** | `agent:<academy_id>:<slug>` |

**Rules:**

- **Every job is idempotent via `dedupe_key`.** Enqueueing twice is a no-op.
- **Every job re-checks its precondition at run time.** A cancelled session's `coach_coming` must find `status='cancelled'` and skip. Never trust the enqueue-time world.
- **A job that did not run is invisible failure.** Alert on it — a missing evening digest is a silent outage.
- Rescheduling a session cancels its pending jobs by dedupe key and re-enqueues.

There are **no quiet hours.** Early-morning classes are normal in India, and holding a 5am coach prompt for a 6am class would break the product for exactly the academies that need it most.

### 13.1 `agent_task` — the bot schedules itself

The other kinds are moments *code* knows about. **`agent_task` is the one that makes the proactive surface open-ended**, and without it §3's claim that this bot "notices things nobody asked it to look for" is simply false — a fixed job table can only ever notice the things in it.

```
job(
  kind:       'agent_task',
  run_at:     <when>,
  dedupe_key: 'agent:<academy_id>:<slug>',
  payload: {
    instruction: "Check whether Meera's family came back after the fee waiver.
                  If they haven't been to a session in two weeks, tell Sharwin.",
    context:     <the query that gives the task its data>,
    minted_by:   <turn id>,
    expires_at:  <when this stops being worth doing>
  }
)
```

At run time this is an ordinary turn: the query runs, the instruction and its results go to the model, and it decides — **including deciding to do nothing, which is the common and correct outcome.** A task that fires and stays quiet is the system working.

**Four bounds, all of which already exist elsewhere in this document:**

- It runs under **a session reconstructed for the person who minted it** — not a stored token, which would still be live weeks later, and not a service role. Roles are re-checked at run time, so a task minted by a coach who has since been ended simply cannot run. **RLS caps it at what that human could see today**, and a self-scheduled task can never reach further than the conversation that created it
- **Anything it sends goes through the one send path** (§16.3) and passes §2.8, so caps, throttles and frequency limits apply exactly as they do everywhere else
- **`expires_at` is required.** A watch with no expiry is a leak; the runtime rejects a task without one
- **A cap per academy on live tasks, and they are visible.** The admin can ask *"what are you watching?"*, get the list, and drop any of them with a button

**This is a whole product surface for one row type.** *"Remind me Thursday."* *"Keep an eye on Saturday Advanced."* *"Check if she's paid by Friday."* *"Tell me if that coach is late again."* None of those needs a feature, a table, or a deploy.

---

## 14. Interaction architecture

### 14.1 A general agent on guardrailed primitives

Seven generic primitives, not a catalog of hand-built features:

- **Read** — the model authors queries over the schema it knows. Any question answerable from the data is answerable, with no new code.
- **Write** — model-authored, with the effect computed before commit (§14.2).
- **Transact** — several writes and their consequences composed by the model into one atomic step (§14.2.1).
- **Message** — compose and send freely (§14.4).
- **Money** — payment links, mandates, reconciliation, adjustments.
- **UI** — buttons, lists, and rendered images (§14.6).
- **Schedule** — the bot enqueues work for itself (§13.1).

Safety is **structural, not behavioral.** The floor being solid is what lets the model be free above it.

### 14.2 Reads and writes are both model-authored

**Reads.** The model writes SELECTs. What makes it safe:

- **RLS enforces.** A query reaching for another tenant returns zero rows
- **A read-only role** for model-authored queries: `SELECT` only, no DDL, no volatile or user-defined functions. **Aggregates, window functions and date maths are explicitly allowed** — forbidding `sum`, `count` and `date_trunc` would block every question the admin surface exists to answer
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

### 14.2.1 `transaction(steps[])` — model-composed atomicity

Invariant 5 says multi-step consequences live in transactions. The obvious implementation — one hand-written named operation per consequence chain — caps the product at however many verbs someone wrote and makes every new chain a code change. That is the exact failure §14.1 exists to avoid, moved one level down.

**So the model composes the steps and the runtime guarantees the properties.** A step is a write, a message, an adjustment, a scheduled task, or a named operation:

```
transaction([
  { write:    "update enrollment set ended_on = '2026-08-31' where id = ..." },
  { adjust:   { account_id: ..., amount: -1200, reason: "unused August sessions",
                approved_by: <admin> } },
  { message:  { to: <parent>, body: <composed>, buttons: [...] } },
  { message:  { to: <coach>,  body: <composed> } },
  { schedule: { kind: 'agent_task', run_at: ..., payload: {...} } }
])
```

For every plan, whatever its steps, the runtime guarantees:

- **Atomicity.** All steps commit or none do. A cancel that credits and notifies cannot half-complete
- **One diff, computed before commit** (§2.3) — the blast radius of the whole plan, not of a step
- **Messages are staged, not sent, until commit.** A rolled-back transaction has messaged nobody. This is the property hand-written operations get wrong most often, and it is the reason this belongs in the runtime rather than in each operation
- **RLS applies to every step**, so a plan cannot reach past what its author could have done by hand
- **The whole plan is one audit entry**, carrying the intent that produced it
- **A contradiction it created is named before it commits.** The diff answers "how much did this change"; a coach booked into two places at once answers none of it — one insert, nobody else's money, nothing deleted — which is how a Monday 7am at one venue was written over a Monday 7am at another and confirmed in the past tense. So after the steps run and before the transaction ends, the runtime asks the database what the world *became*: any coach now double-booked, weekly or on a date, becomes a plan note and forces the preview. It refuses nothing — an overlap is sometimes intended, and the tap that confirms everything else confirms this too. Asked of the world rather than of the caller, because five different things put a coach somewhere and a check inside one of them is a check inside one of them (`lib/agent/clash.ts`)

**Named operations are shortcuts, not gates.** `end_coach`, `cancel_session`, `move_class`, `waive` still exist and are still the right thing to reach for — they are known-good plans with known-good copy, cheaper and more consistent than composing from scratch, and their signatures sit in the cached prefix (§4.4) so choosing one is free. **But they are no longer the only way to do something multi-step.** A consequence chain nobody anticipated — end this enrollment, credit the unused half-month, tell the parent, tell the coach, check back in a fortnight — does not need a deploy.

### 14.3 Recipes — removed

**Deleted, not deferred**, by `supabase/migrations/0017_drop_recipe.sql`. The section number stays because §14.4 onwards is cited by number from the code; there is no §14.3 capability.

The idea was that common actions get promoted into saved compositions of the same primitives — a plan captured from validated model output and frozen as the canonical version of that action, so booking, cancelling, confirming, attendance and dunning ran as the same well-made shape every time rather than an improvised one per conversation.

What was built was three halves that never joined. Capture froze a committed plan and generalised its ids into `{{placeholders}}`; matching found one by token overlap; and the piece that would bind a placeholder and replay the plan had no callers anywhere in the product. So the live path pasted a matched plan into the variable tail as prose, `JSON.stringify`d and sliced at 1200 characters, and asked the model to re-compose it — which on any multi-step plan cut the JSON in half and offered the model a malformed worked example as its known-good shape. **A shortcut through composition that still runs through the model is not a shortcut; it is a longer prompt.**

Nothing replaces it. If the round saving is wanted back, it has to be a replay the runtime performs end to end — bind, preview, execute, and let the captured `message` steps carry the copy — never a paragraph the model is asked to copy from.

### 14.4 Composed messages

The bot composes and sends messages nobody specified — that is what makes it a manager rather than a notifier. *"Tell the Saturday parents the venue moved."* *"Check on the three families who stopped coming."*

Two constraints, both cheap:

- **It applies §2.8 before sending** — would this person have wanted this?
- **It goes through the one send path.** Throttle, cap, staging. Not a restriction on what it can say; a guarantee about how it goes out. **No unthrottled send function exists in the codebase** (§16.3)

### 14.5 Text in, text out — and what that cost

**This section used to promise multimodal input. It is repealed, deliberately, on 2026-08-15.**

The model client is DeepSeek's API, which has no image, audio or document input at all: a non-text content part is rejected at schema validation before auth is even checked. That was accepted knowingly, in exchange for 2–5× lower cost per turn and a provider whose automatic prefix cache actually pays for the §4.4 design. What it cost is written here rather than quietly deleted, because it was the largest single claim in this document:

- **A photographed timetable is no longer a week.** §7.1's biggest friction reducer is now "type the week in one messy sentence and have it read back" — much worse for a whiteboard, about the same for somebody who was going to type anyway.
- **Voice notes are how half of India types**, and they cannot be read. This is the sharpest loss and it lands hardest on exactly the people this product is for.
- **A GPay screenshot is not a payment record.** Rail 1 reconciliation stays attestation.

**Media still arrives, and silence is not an acceptable answer to it.** An inbound photo, voice note or file gets a designed reply from the runtime — naming what cannot be done, and the road that still works ("type the classes in any rough form and I'll read them back") — before the model is asked anything. Going quiet is the one failure a person cannot tell apart from being ignored, and it must never be caused by a capability the product removed. That reply is a runtime send, not a line in the prompt: an instruction the model follows four times in five is not a guarantee.

**A shared contact card is the exception, and it is not multimodal.** WhatsApp's `contacts` message is a name and a phone number in structured fields — data, not a file, already text before anybody touches it. It is not behind a media id, needs no rasteriser and no audio model, and it arrives on the same wire as a text body. So it reaches the model as itself, and it is the only attachment on this surface that does. `readSharedContacts` validates each card against `dialablePhone` — the same predicate `add_coach` and `add_family` refuse on — and drops any that would not reach anyone; the survivors are rendered into the message body, so a card with no caption typed beside it is still in the conversation two turns later rather than a gap where a message used to be. This is not a repeal of anything above: a photographed register is still pixels and still cannot be read.

**What survives unchanged.** Parsed content is **read back before action** — recognition errors land on names, times and amounts, exactly where the damage is — and parsing produces a **proposal**, never a silent write. A week read out of one typed sentence is exactly as misreadable as one read off a photo was.

**Outbound media is untouched.** Rendered timetables, documents and links the product *sends* have nothing to do with this.

Read-back examples:

> I read this from your timetable — check before I create anything:
> • Mon, Wed, Fri · 6:30–7:30pm · Beginners · Green Park
> • Sat · 8:00–10:00am · Advanced · Green Park
> `[Create these 2]` `[Fix something]` `[Cancel]`

> Two changes:
> 1. Aarav — out Tuesday 25th
> 2. Meera — moves to 6:30 Beginners from next week
> `[Do both]` `[Just #1]` `[Just #2]` `[Neither]`

If a sentence is ambiguous the bot says so plainly rather than guessing — §2.4 applied to input.

### 14.6 UI kit

- **Every link is a button.** Nothing URL-shaped is pasted into message text.
- **The affordances are buttons, a list, and the words.** That is the whole kit. There is no form on this surface and no browser behind it, so anything that needs several facts is *asked for* — see the ladder below.
- **Anything spatial or dense is aggregated into the message.** A week's timetable, a month of tally lines, a trend: the short version in words, with the numbers, and the offer to break it down further. **A picture would be better and is not built** — rendering a PNG needs a rasteriser this repo does not carry, so it is honestly deferred rather than quietly assumed. Until it exists the ceiling in §15 is the real one, and it is chat.

**Form-shaped work is a ladder, not a form.**

Three things in this product are form-shaped — the shape of the business, a class, the register — and all three used to be a **WhatsApp Flow**: a published artifact, one screen, every field at once. Static Flows were genuinely cheap (no keypair, no `/data` endpoint, no encryption) and they genuinely saved round trips. They are gone anyway, and the reason is not cost.

**A form cannot ask what it was not built to ask.** Its questions, and the order of its questions, are fixed at publish time. It cannot skip the field it can already see, follow the answer that turns out to matter, or take the correction typed one second after Save. The register is the case that decides it: a `data-source` renders tonight's twelve names and next week's nine from one artifact, which is impressive, and it still has no answer for *"Aarav left at half time and Meera's dad says she's out all month."* A conversation absorbs that without being redesigned. **Every form-shaped need becomes a chat ladder, which is what this section already prescribed for everything a Flow could not cover; the set it could not cover turned out to be everything that matters.**

**What was given up, stated plainly.** Onboarding asks eight or nine things, and a form collected them in one exchange. A ladder cannot, so it costs round trips — that is the trade, and it is only worth it if the ladder is cheap. Three rules make it cheap:

1. **Never ask what you can already see, or safely assume.** Read the row first and say what is being assumed rather than asking: *"I have you down as Asia/Kolkata and a 24-hour cancellation notice — say if not."* A question whose answer is already in the database is pure friction.
2. **Take everything a sentence gives you.** People answer three questions at once. The ladder must absorb all of it and never re-ask what was just said — which is the failure that makes ladders feel like forms.
3. **Stop as soon as you have enough to act.** The rest gets filled in when it matters. A business that can create a class does not need a UPI handle yet.

**One open invitation beats a chain of closed ones.** *"Tell me the timetable however it comes out — all of it in one message is fine"* gets a whole week in a breath; *"what day?"* gets one day and five more round trips. This is §7.1's biggest friction reducer and it is now the only one. Read back what was understood, put the commit behind a button, and let a correction be typed — a typed correction is cheaper than any form, because it can say the thing no form had a field for.

**The register is still inverted, and that is structural rather than stylistic.** It asks who was *not* there. Asking twelve players three-state questions to learn one fact is what makes coaches stop marking registers, and an unmarked register is a session that never bills — a money defect wearing a UX complaint's clothes. As a form that inversion was two multi-select lists. As a ladder it is one question, *"anyone missing?"*, whose commonest true answer is "no" and whose answer is a sentence: *"just Aarav, and Kiran was twenty minutes late."* `[All present]` stays a chat button, because one tap still beats typing when nothing happened.

**What was actually lost with the artifact, and what was not.** No write path was lost: setup ran the one builder in `lib/setup-plan.ts`, a class ran `create_class`, the register ran `mark_attendance`, and all three are reached by a sentence exactly as they were reached by a submission. What went is the collection surface. What also went is a real security property worth naming — a Flow response was bound to the conversation and could not be detached from it — but that property was only ever needed to beat the signed link §15 removed, and a typed sentence is bound to the conversation just as tightly.

**The costs that came off with it.** No published, versioned artifacts; no `POST /{WABA}/flows` / `/assets` / `/publish` at build time; no business-verification gate blocking publish ("Blocked by Integrity"); no draft-versus-published send mode; no second thing the emulator has to render honestly (§17). Adding a form used to be a deploy. Asking a new question is now a sentence.

**Where a ladder does not fit, the answer is still chat.** If the thing wanted is a *view* rather than an *input*, it is prose — aggregated, with the numbers in the message body. **This is a real ceiling and it is accepted deliberately** (§15).

### 14.7 Window and templates

Replies inside the 24h window need no template and no approval. `contact.last_inbound_at` is the source of truth. Out of window, an approved template goes out — see §16.2 for the eight categories.

**Out-of-window messages are window-openers.** Deliberately simple, aimed at getting one useful tap, after which the rich interaction happens in-window for free.

**A button tap is an inbound message.** Tapping `[Yes, I'm coming]` sends a reply, so it stamps `last_inbound_at` and re-opens the window for another 24 hours. **The ladder feeds itself:** a coach who taps once a day is never out of window, and a family that answers one reminder a week is in window for the tally that follows. This is why buttons people actually want to tap are infrastructure rather than politeness (§16.1) — and it is the single largest lever on what this product costs to run.

**The economics, as they now stand.** Since Meta moved to per-message pricing, service messages inside the window are free and unlimited, and **utility templates sent inside an open window are free too**. What is actually paid for is utility templates to a *cold* contact and anything classified marketing. So the cost model is not "messages sent" — it is **"messages sent to people who have gone quiet"**, which is a number the product controls by being worth replying to. *Rates move; re-check the current India card before modelling spend rather than trusting a figure written here.*

### 14.8 The escape hatch

An always-reachable "talk to a person," plus **automatic triggers**: two failed turns, refund/complaint/safety language, requests the tools genuinely cannot serve. The bot performs the handoff itself and attaches the transcript. **Client escalations go to their academy's admin. Admin escalations go to the platform.** Heavy use is a product bug being measured.

---

## 15. The web surface — removed

**Deleted, not deferred.** The section number stays because §14.4 onwards is cited by number from the code; there is no §15 capability. **There is no browser in this product.**

The idea was a rendering surface the bot linked into with a signed short-TTL JWT — the magic link as the session, no login, no navigation — carrying a registry of components (`table`, `prose`, `form`, `calendar`, `chart`, and five more) that the model composed into a validated view spec. It was to be the escape valve for any UI WhatsApp could not express: setup and the register as `form`, and dense comparative work for the admin.

**Why it went, in the order the reasons actually bite:**

1. **The link was bearer auth.** Whoever held the URL held that person's session. A coach forwarding a register link hands out an open attendance sheet; a parent forwarding a tally into a family group leaks it. Short TTLs narrow that window, they never close it. This is the reason that survives everything else on this list, and it applies to any link, for any purpose, however short-lived.
2. **A form was the wrong shape for the two things that had to exist.** Setup and the register were the whole case for a web surface, and both are form-shaped. They were briefly answered by a WhatsApp Flow — the same fields with no browser and no bearer token — and then by neither, because a form of any kind can only ask what it was built to ask (§14.6). **Both are conversations now**, which is a surface this product already had.
3. **Once the forms left, the remainder did not pay for itself.** What was left was the admin's spatial and exploratory work — a calendar, a chart, a long table. That is a real thing to want and it is **one audience, occasionally**, against a component registry, a view-spec grammar, a JWT surface, a second renderer and a second thing the emulator has to be honest about (§17).
4. **Every answer had two implementations and a decision.** The model had to choose, on every question, between saying it and rendering it. That choice was itself a source of wrongness, and it never got cheaper.

**What replaced each thing it did:**

| Was going to be | Is now |
|---|---|
| `form` — setup, the register | **Chat** (§14.6) — asked as a ladder, one question at a time, skipping what is already known |
| `calendar` — the week, the month | Chat: the days that are not routine, not the grid |
| `chart` — trends worth plotting | Chat: the shape in a sentence, with the numbers |
| `table` — everything else | Chat, aggregated — a total and the three lines that explain it |
| `prose` — synthesized commentary | It was always just a message (§10.2) |

**Images would beat links on WhatsApp, and they are not built.** An image renders inline with no tap, has no expiry, survives being forwarded, is still there next month when a JWT would be long dead, and is the format these users already receive schedules in. That is the right eventual answer for the calendar and the chart — but rendering one needs a rasteriser this repo does not carry, and writing it into the spec as though it existed is how a ceiling gets discovered by a user instead of by us. **Today every one of those rows is chat.**

**What is actually given up, stated plainly:** the ability to *follow a question somewhere nobody anticipated*. The admin can ask anything (§14.2 makes any question answerable) and will get prose and numbers — but they cannot pivot, drill or sort, and until the renderer exists they cannot see a shape either.

**The ceiling this imposes, stated plainly so nobody discovers it as a surprise:** the admin cannot explore. They can ask anything (§14.2 makes any question answerable), and they will get prose, numbers and a picture — but they cannot pivot, drill or sort. **Revisit only when a real admin, with real data, is demonstrably blocked by that** — not because a dashboard would demo well. If it does come back, it comes back as one audience and three shapes, never as a registry.

**Rail 2's payment-gateway KYC** is the one moment a browser is genuinely unavoidable. It is a third party's hosted flow, once per academy, and it is not a surface this product builds or owns.

---

## 16. One number, many academies

### 16.1 What's pooled

**Quality rating** (per number, so one bad tenant degrades everyone) and **messaging tier limits** on business-initiated conversations. Replies inside an open window count against neither, which is why buttons people actually want to tap are infrastructure, not politeness.

**And the account itself, which is the part that is not a trade-off.** One number means **failure is correlated across every tenant**: one policy strike, one wave of blocks from one badly-run academy, one quality drop, and *everybody* goes dark at the same moment — including the tenants who did nothing wrong and have no idea why their parents stopped hearing from them. A block is also **global to the number**, so a parent who blocks over one academy silently loses messages from another.

**This is the largest single business risk in the product, not a messaging detail.** It is why §16.3's per-tenant sender routing exists from day one at n=1, why the per-tenant quality proxies exist at all, and why there is no marketing category anywhere in §16.2. The mitigation is not care; it is being able to **move a tenant to their own number in a config change** on the day their behaviour, or their bad luck, starts costing everyone else.

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

**Two limits on what a template can carry:**

- **A template cannot be a wrapper around free prose.** Meta rejects bodies that are substantially one variable, so anything the model *composes* — the digest, a synthesized answer, an explanation — cannot go out as a template. Out of window those become window-openers and the real message follows the reply (§10.2, §14.7).
- **There is no marketing template in this product, and `payment_due` is the closest thing to a boundary.** Every one of the eight is transactional: something happened, or something is due, to somebody who is already a customer. **A promotional message to a prospect who did not convert is not on this list and will not be added** (§20) — on a shared number, one marketing classification is charged to every tenant. When an admin wants to re-approach a cold prospect, the bot drafts it and **the admin sends it from their own number**: no template, no category, no cost, and the reply lands in an open window.

**This used to be described as "exactly as with the coach invite (§8.1)", and that comparison is now wrong in the way that matters.** The coach invite is a bot send, because a coach the admin employs and a family already enrolled are people this business has a transaction with, which is what makes `coach_prompt` and `session_reminder` honestly *utility*. A prospect who did not convert has no such relationship, so the same send would read promotional, and one marketing classification is charged to every tenant on the number. **The line is the relationship, not the mechanism** — and it is the one place the admin's own number is still the right answer.

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

**The main deliverable of phase 1**, because it is simultaneously the dev surface, the test harness and the eval system — and because it is exactly what happens in production. It demos well, and that is a consequence, never a requirement that drives its polish.

Real WhatsApp is hostile to develop against: real numbers, approved templates, tier limits, and one shared number where a test blast is a production incident.

**Structure — a world, not four panes:**

- **A world**: a seeded scenario with academies, people, classes, sessions
- **A contact tray**: open any contact as a pane, as many as fit. Two coaches racing on `[Claim this session]`. A head coach and an assistant contending for the register. A parent and their teenage player on separate numbers. Two academies, to prove tenant isolation
- **One shared clock** across all panes, advanced on demand — jump to T-60 and watch `CO-COMING` fire, jump to evening for the digest
- **Live updates.** The cover-claim race is only testable if pane B visibly updates when you tap in pane A. Refresh-on-action doesn't test it
- **An event log**: every send with template-vs-in-window, cost, tier consumption, sender number
- **Failure injection**: sends fail, numbers block, web links expire mid-form, media fetches time out. Unreachable in normal development, and where production actually breaks
- **One transport interface, two implementations.** The bot addresses an abstract transport; Cloud API is production, the emulator is development. **If the emulator can't render a message, it doesn't ship.** Building this first is what stops Meta API calls from scattering through the codebase

**Simulation hooks ship in phase 1; agent simulation lands as soon as there are behaviors to exercise.** The substrate — deterministic seeds, run recording, replay, the transport — is built up front so simulation drops in without rework.

**Agent simulation, once phase 4 behaviors exist:**

- **Personas as data** — *"busy parent, replies in three words, doesn't read carefully, taps the first button"* · *"coach who never taps, always types, uses Hinglish"* · *"admin who asks the same question five different ways."* The uncooperative personas find more bugs than the cooperative ones
- **Goals** — "get your kid moved to Saturday," "dispute a charge," "cancel and rebook twice"
- **A judge agent reviews the transcript**: where did the user get confused, hit a dead end, repeat themselves, get a wrong answer, or receive a message failing §2.8
- **Diffable runs.** Run the same seeded scenario before and after a change and see what moved. This is the only practical regression test for a conversational product

**It is a primitive WhatsApp, not a replica.** Bubbles, buttons, lists and media render recognisably and that is enough — the emulator's job is behavioral fidelity, not visual fidelity, and pixel-matching WhatsApp is an unbounded polish sink with no test value.

**Structural honesty is the constraint that matters:**

- If a message cannot render in the emulator, it does not ship
- Message length, button counts and list limits obey the real API's limits, so something that works here works there. **Rejected, never truncated** — cutting a 21-character button title to 20 ships the bug instead of finding it
- Template-vs-in-window, and which sender number went out, are always visible

The visual question is answered once, cheaply, by phase 1's acceptance criterion — the same message rendered to a real test number.

---

## 18. The solo case

Most coaching businesses in India are one person: one `person` with both `academy_admin` and `coach` rows. **This is not the multi-coach product at n=1.** Asking someone to confirm attendance at their own class is absurd, and it is week-one churn.

| Journey | Solo |
|---|---|
| Coach onboarding (§8.1) | **Gone.** They onboarded as the admin |
| `CO-COMING` / `CO-NUDGE` | **Gone.** They know |
| `AD-ESCALATE-UNCONFIRMED` | **Gone.** Nobody to escalate to |
| `CO-COVER-OFFER` | **Gone.** A drop becomes a reschedule: pick a new slot, the bot tells the families |
| `CO-PAYABLES` | **Gone.** They are the business |
| `CO-DAY` + `AD-MORNING-BRIEF` | **Merged** into one message in one chat |
| `AD-EVENING-DIGEST` | **Kept**, shorter |
| `CL-SESSION-TROUBLE` | **Kept.** A solo admin running late still needs parents told |
| `CO-REGISTER` | **Kept unchanged.** It is the meter and the coaching record |

Roughly 60% of the coach surface disappears. **Nobody is ever asked to confirm something to themselves, and no escalation about the coach pings the coach.**

**Detection is not a mode.** Two general rules, checked on the send path for every outbound message, produce the whole table above:

1. **Never ask someone to confirm something to themselves.** Drop any message whose recipient is also its subject and whose only content is a confirmation request
2. **Never escalate about a person to that person.** Route an escalation to someone who is not its subject, or drop it

Implemented there, the solo case falls out for free — **and so do the cases a tenant-level flag misses**: the two-coach academy where one of them is the admin, the head coach who is also an admin, the admin covering a session themselves this week. **Eight `if solo` branches would each have to be right; one suppression check has to be right once.**

The derived condition — exactly one `active` coach whose `person_id` is also in `academy_admin` — is still worth computing, but for **shaping** rather than gating: merging the coach day into the morning brief, and not offering cover to a set of one. Recompute on coach add/end; never cache it in settings.

**Why the model is multi-coach anyway:** a coach *set* and derived coverage cost nearly nothing to build and cannot be retrofitted. Solo is a strict subset — journeys hide; a coordination layer cannot be added later to a model that assumed one coach.

**This is not a phase.** It is a condition checked in phases 4–8 as they are built. Retrofitting means auditing every journey twice.

---

## 19. Build order

Each phase has an acceptance criterion. Do not start a phase before its predecessor passes.

| # | Phase | Contents | Done when |
|---|---|---|---|
| 0 | **Foundations** | Schema (§6). RLS policies + pgTAP regression tests. `job` table and runner with a drivable clock. Transport interface. Sender routing table | Cross-tenant and cross-role reads return zero rows. Build fails if any table lacks RLS. A job enqueued twice runs once |
| 1 | **Emulator** | §17 — world, contact tray, arbitrary panes, live updates, clock, event log, seeds, recording, failure injection | A message renders correctly in the emulator and on a real test number. Clock advance fires a scheduled job. A run replays deterministically |
| 2 | **Agent loop** | Primitives (§14.1), `transaction(steps[])` (§14.2.1), `agent_task` (§13.1), action minting incl. `operation` and `steps` kinds, write-diff preview, layered context (§4), memory store and hot set (§5) | A tap executes with no model call. An expired action refuses. A multi-row write shows its diff before commit. **A rolled-back transaction has messaged nobody.** A self-scheduled task fires, runs under its minter's RLS, and expires |
| 3 | **Catalog & sessions** | Classes, slots, enrollments, all four `rate_unit`s incl. per-enrollment overrides, `materialize_sessions`, the setup ladder | A class created through the setup conversation produces correct sessions three weeks out, and editing a slot rematerialises future sessions without losing cancellations or marked attendance. A per-session drop-in inside a monthly class bills correctly |
| 4 | **Coach day** | §8.2 ladder with per-person timings, the inverted register, coverage derivation, cover offers, unprompted actions | Full ladder observable by advancing the clock. Uncovered escalation fires. A confirmed coach is never asked twice. "I'm here" works with no prompt. A per-person override changes when a prompt fires. A twelve-player class with nobody absent is one tap |
| 5 | **Client day** | Reminders, cancel with scope, outcomes, class-starting relay | Cancel inside window writes `cancelled_timely`, outside writes `absent`. Mis-tap protection confirmed |
| 6 | **Onboarding funnels** | Coach invite (§8.1), client Steps 1–2 (§9.1), staged first contact, templates submitted | Bot sends the invite → template out of window → their tap opens it → `CO-INVITE-CONFIRM` / `CL-INTRO`. Staging halts on a bad signal |
| 7 | **Money** | Rates, tally lines, adjustments, Rail 1 links, reconciliation, dunning | A month of mixed per-session and per-month enrollments produces a correct line-by-line tally with a waiver applied |
| 8 | **Admin day** | Brief and digest as synthesis (§10.2), NL CLI, follow-up buttons, delivery-status answers, audit and undo | *"Did Meera get the reminder?"* answers from real status. Undoing a messaging operation sends corrections to exactly the people who were told. Every number in a generated digest traces to a query result in its payload |
| 9 | ~~**Flows**~~ — **removed** (§14.6) · **images** | Flows were to be published JSON artifacts with `flow_send`, response validation and publish/version handling. All of it is gone: form-shaped work is asked for in the chat, which needs no phase of its own because it is the phase-2 agent loop doing its ordinary job. What remains here is the image renderer (timetable, month grid, trend line) | A week's timetable renders to an image that is legible on a phone. **For the work that used to be this phase, the test is a conversation:** a coach who says "everyone except Aarav, and Kiran was late" gets a correctly marked register, and an owner who says two facts about their business has both written without being asked for the other seven |
| 10 | ~~**Multimodal**~~ — **repealed** (§14.5) | The client is text-only. What remains: media *arrives* and is answered in words by the runtime, never dropped | A voice note gets a designed reply naming what cannot be done and the road that works. A Hinglish sentence *typed* resolves a player name against the roster — the same test, minus the microphone |
| 11 | **Prospect funnel** | Cold inbound (§10.1), auto-confirmed trials, admin undo | A stranger with a QR link books a trial end to end; the admin can undo it |
| 12 | **Agent simulation** | Personas, goals, judge agent, diffable runs (§17) | Ten seeded persona runs complete and produce a judge report. The same seed replays identically. A deliberately introduced regression shows up in a run diff |
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
| Split households | One player, two accounts, split payment. Real but rare — **and a schema retrofit** (`player.account_id` becomes a join table), so §18's argument for building the coach *set* up front partly applies. Deferred with that cost named rather than hidden |
| The web surface | **Removed, not deferred** (§15). Forms are conversations, spatial things are images, and the remainder did not pay for a registry, a JWT surface and a second renderer |
| Admin exploration — pivot, drill, sort | The honest cost of removing the web surface (§15). Revisit when a real admin with real data is demonstrably blocked, not because a dashboard demos well |
| Explicit prompt-cache handles | Implicit caching until phase 8's instrumentation shows the spend (§4.4) |
| Parent feedback ratings | The admin sees every parent at pickup. A coach's note on attendance already carries the signal, and a rating prompt spends frequency budget to learn what a conversation would tell you |
| Monthly value report | Its only job was reminding the admin the product is worth paying for. The evening digest already carries proof, and this was the one message in the catalog that failed §2.8 |
| Automatic contact archival | Out of scope. A digest line — *"6 contacts silent for 3 months"* — costs nothing and the admin decides |
| Global opt-out | Per-academy only |
| Quiet hours | Removed. Early classes are normal; holding a 5am prompt breaks the product for the academies that need it most |
| Generated-image visualization | **Still deferred, and now load-bearing.** The claim that "the web surface beats images on every axis" was wrong on WhatsApp — an image needs no tap, never expires and survives forwarding — but nothing renders one yet, and §15 removed the fallback. So the calendar and the chart are prose until a rasteriser ships. This is the first thing to build if an admin says the numbers are hard to read |
| Unsolicited marketing broadcasts | Category risk on a shared number, charged to every tenant (§16.1). **Includes re-approaching a prospect who did not convert** — that is admin-forwarded from their own number, never a template (§16.2) |
| Non-WhatsApp clients | Out of scope permanently |
| School programs | Account-less pupils, read-only school view, no billing |

---

## 21. Open decisions

1. **Final name.** "Class Manager" is the name every parent sees in their chat header — a branding decision, not config. Its one real virtue: it says *class*, not *academy*.
2. **The sender number's country code.** A local number is materially better for first-contact trust; it also carries KYC and local-entity requirements. **Gates parent-funnel conversion, so decide before phase 6.**
3. **Category scope at launch.** The model — classes, sessions, players, rates — generalizes past sport to music, dance and tuition without change. How much genericizing before tenant #2 rather than after is open. **"Academy" is the word that does not generalize, which is why it appears nowhere a user can see it.**
4. **Model tiering — and it has already drifted, so decide it properly.** The presumed split was a cheaper model for clients and coaches, the strong one for admins. **That cuts against the product:** parents and coaches are ~95% of the humans this talks to and are where "it feels like a bot" gets decided, while the admin — who has menus and buttons — needs the model least. What is actually running is a different split: one model for every conversation, a stronger one for synthesis (`MODEL_MAIN` / `MODEL_SYNTH`). That is probably the right axis, and it happened without being decided. **Ratify it or change it against phase 2's cost data**, and if a per-persona split ever does happen, keep the strong model on first contact, the prospect conversation (§10.1), and anyone unhappy.
5. **Children's data.** Every player in this system is a minor, and the product stores their names, attendance, coach notes on their progress, and their parents' numbers and payment records. India's DPDP Act treats children's personal data as a special category with its own consent requirements. **Nothing in this spec addresses it.** Get advice before tenant #2, not after — the answer shapes onboarding consent, retention, what a coach's note may say, and what leaves the country. Flagged here rather than guessed at.
6. **Model-provider data residency — the one gate that was declared and then not met.** DeepSeek processes on servers in China under no DPA, and every turn sends it children's names, family phone numbers and payment context. The migration plan named a **written residency sign-off as a hard cutover gate**; cutover happened on 15 Aug 2026 without it. That is recorded here as a live gap, not a closed decision. It is the operational half of item 5 and inherits its deadline: settle it in writing before tenant #2, or move `MODEL_MAIN` to a provider that can be diligenced — the client speaks the OpenAI dialect, so that is a base-URL and model-name change, not a rewrite.

# Class Manager — product vision

> **Status:** direction settled, pre-build. This is a product document — what the thing is and how it behaves. Not an implementation plan: no schemas, no code, no API contracts. Commercial model lives in `business-model.md`, deliberately out of scope here.
>
> **Working name:** "Class Manager" (the WhatsApp display name)

---

## 1. Thesis

Indian coaching businesses already run on WhatsApp — schedules, payment chasing, cancellations, parent communication, all of it, by hand. The product moves that workload onto a WhatsApp-native manager: clients book, pay and get reminded; coaches get their day and mark attendance with taps; admins run the whole business through natural language and menus. **The chat they already use is the interface. Nobody installs anything. Nobody ever logs in.**

Three pillars:

1. **Zero adoption friction.** Clients install nothing — the bot messages them. Admins use the UPI and WhatsApp they already have. Onboarding is a conversation, not a setup wizard.
2. **It replaces labor, not software.** The product competes with a person doing admin by hand, not with other apps. Nothing here should feel like software adoption.
3. **Insight and awareness.** Who has paid, who is at risk, business questions answered on demand — and feedback flowing both directions: parents rate the coaching, coaches feed observations back to parents.

**Web as a surface only.** The web is a rendering target the bot links into (§10). There is no navigation, no login, no app shell, ever.

---

## 2. The model

Six nouns. Everything else is a property or a rule.

### 2.1 Class and session

**A class is four facts: when, where, who's coaching, who's coming.** It carries a name, a schedule, a venue, a coach set, a roster, and a rate.

- **One noun.** There is no "group class" versus "private class" versus "batch" versus "one-off." A private class is a class with a roster of one. A camp is a class whose schedule has one occurrence. A batch is a class that repeats weekly. **These are values, not types** — the product never branches on them.
- **The admin names it.** "6:30 Beginners Batch," "Sunday Personal — Aarav," "Summer Camp." Free text. The bot echoes their words back and never invents a taxonomy of its own. *We speak the academy's language; we don't teach them ours.*
- **Venue** is a place: a clubhouse, a court, a school ground, a home address. No categories.
- **Sessions** materialize from the class on a rolling horizon a few weeks out. The roster flows into each new week automatically. A session is one occurrence, and it is where reality gets recorded — who actually coached, who actually came.

Complexity beyond this belongs to the admin, expressed in names and rates. Every coaching business is specific; the product is not the place to encode that specificity.

### 2.2 Player, account, contact

Three separate things, deliberately. Collapsing them is what makes "parent pays for child" and "adult pays for self" look like two products instead of one.

- **Player** — attends. Attendance, coach notes and progress hang here.
- **Account** — owes money. Holds 1..n players. Receives the tally.
- **Contact** — a WhatsApp number. Receives messages.

An adult who pays for themselves is an account with one player where the account holder *is* that player. A parent with three kids is the same object with n=3. **Not two cases — one case at different cardinality.** No separate flow, no separate onboarding, no separate billing path.

Consequences that fall out of this:

- **Copy takes one flag**: is the recipient the player? "You have class tomorrow" versus "Aarav has class tomorrow." One boolean at the messaging layer.
- **Money is per account, itemized per player.** Chat is per contact. Session-shaped messages name the player they concern.
- **An older player can hold their own contact** for session messages while money-shaped messages stay with the account holder. This is the same mechanism as the self-paying adult, not a special feature.

### 2.3 Coach

**Coaches are a set, never a scalar.** A class has a default coach set; each session has an actual coach set that inherits it and can differ. Head coach plus two assistants is ordinary at any real size, and a product that assumes one coach cannot represent it.

What follows from making it a set:

- **Coverage is a property of the session, not a person.** The escalation is *"tomorrow's 6:30 has no confirmed coach,"* never *"Arjun hasn't confirmed."* One confirmed coach means covered.
- **A drop with others remaining is information, not an alarm.** The class still runs. This kills a whole category of false urgency.
- **First tap owns the register**, others see it's done — with edits allowed and audited, because the head coach may tap "all present" while an assistant knows two left early.
- **First arrival starts the session**, and that is what parents hear.
- **Payables accrue per coach per session taken**, which the arrival tap already records.

### 2.4 Admin

The person who runs the business: schedules, hires, sets rates, chases money. **"Admin," not "owner" or "founder"** — it is the word Indian coaching businesses, gyms and tuition centres actually use, it names a role rather than a status, and it survives the solo case without sounding strange. At a large academy an employed manager wears the hat; at a small one it is the coach.

### 2.5 Rate and tally

**A rate is one amount and one unit: per session or per month.** That is the entire billing model.

- **The rate lives on the enrollment** (a player in a class) and defaults from the class. This handles drop-ins inside a monthly batch, sibling discounts, scholarship players, and legacy rates — without a single schema branch.
- **Attendance is always recorded**, because it is a coaching record regardless. For per-session rates it also drives the tally; for per-month rates enrollment does.
- **The tally is one object either way** — a list of lines per account, readable line by line. A per-session class contributes a line per attended session; a monthly class contributes one. The parent reads the same message, dunning chases the same number, everything downstream is identical.
- **The admin never picks a mode.** They set a rate. The consequence follows.

**Adjustments are one primitive, not six features.** An adjustment is an amount, a reason, who approved it, and when. It expresses: waiving a class, crediting a session the academy cancelled, pro-rating a mid-month join, a sibling discount, goodwill, and the free trial. The admin says it in a sentence; the bot mints a line; the parent sees it in the tally.

**The free first class is a rule that mints an adjustment**, applied to a player's first attended session. **Per player, not per account** — a second child gets their trial too.

### 2.6 Scope, always

Cancel and reschedule ask one question every time: **this session, or every week?**

- A cancellation inside the academy's window simply doesn't count; a late one is the admin's call.
- **Reschedule is the makeup** — the session moves to another slot of the same class rather than becoming a refund argument.
- **The cancellation window only carries money meaning for per-session rates.** For monthly rates it is a headcount signal to the coach and nothing more. Same interface, different consequence, no extra machinery.

---

## 3. Personas and phases

Every user has exactly two phases, and both are product: **onboarding** and **day-to-day**. Three personas × two phases is the spine of §4–§7. A persona whose onboarding is unspecified will churn before day-to-day is ever reached, no matter how good day-to-day is.

Roles are **hats, not headcount**. When two hats sit on one head the flows *disappear* — they are not run with n=1. §8 specifies exactly what disappears.

Every user is **WhatsApp-only by design**. A number not on WhatsApp is out of scope; the admin handles those people however they already do.

---

## 4. The admin

**The pains, in the order they are actually felt:** someone waiting to be let in; a class with no coach; money overdue; a coach problem mid-day; what's on today and how to move it; the standing timetable; goodwill when judgment calls for it. None of these should require opening anything.

### 4.1 Onboarding

The unavoidable cost of adoption is **data entry**, and reducing it is the highest-leverage work in the funnel.

**The principle: one class, end to end, before anything else.** A timetable with eight classes and 120 players is an hour of setup before any value arrives — and value only lands when a parent gets the first useful reminder, not when the database is full. So: set up one class, watch it run for a week, then add the rest. Time-to-first-value drops from an hour to minutes, and the remaining seven classes get entered by someone who has already seen it work.

1. **The setup Flow** (§9.4) — the form-shaped part in one screen sequence, because a dozen chat round-trips is a dozen small waits: business name and sport, one venue, one class with its rate, the free-cancellation window. The bot reads it back before creating anything.
2. **Bring the rest however it already exists** (§9.5). A photo of the timetable on the whiteboard. A photo of the paper register. A forwarded spreadsheet. A voice note describing the week. The bot parses, reads back, and creates. **This is the single biggest friction reducer in the product** — an admin who can photograph their register instead of typing it has no setup problem left.
3. **Coaches** — §5.1. Three facts each, then invites.
4. **Families** — §6.1. Contacts shared, academy built, nobody messaged yet.
5. **Payments** — §9. Rail 1 is one UPI handle and takes a minute.

**Joining mid-cycle is expected**: the admin marks who has already paid and until when, so counting starts fresh and **nobody is ever chased for money from before the platform**.

By the end of the first sitting there is a working class — and no parent has been messaged yet.

### 4.2 Day-to-day

- **A natural-language CLI over the entire business.** Anything an admin could need, typed as a sentence: schedule and move classes, manage coaches and clients, waive a class, broadcast (guardrailed, §12), ask anything. Full CRUD as conversation (§9).
- **Menus as the missing nav bar.** A blank chat box with dozens of capabilities discovers worse than an ugly nav bar. A persistent list-picker — *Schedule / Clients / Money / Coaches / Insights* — is the primary affordance; prose is the fallback. Non-technical admins don't need to be told the bot is capable; they need three taps that do something useful on day one.
- **Two bookends, quiet in between.** Morning: a brief led by *Needs you* — approvals waiting, sessions without a confirmed coach — then the day's roster; silent when there's nothing. Evening: the digest — punctuality, rosters, arrivals, decisions pending. Between them, only genuine escalations interrupt. **The admin's phone is a briefing, not a ticker.**
- **Proof it's working.** Every send is tracked queued → sent → delivered → read, and any of it is answerable: *"did Meera get the reminder?"* Failures surface as fixable alerts; the evening digest carries a delivery-health line; the bot never claims what it can't see (§13).
- **Insights on demand**, with rendered views for anything spatial or dense (§10): "here's your week" as a calendar, not a wall of text.
- **Payments set up in chat** (§9), reconciliation by button tap, and a monthly value report.
- **An audit trail they can read, and an undo window** on destructive bulk operations. At multi-tenant scale a bot mistake is *someone else's business*; pre-confirmation alone is not enough.

---

## 5. The coach

### 5.1 Onboarding

Three constraints shape this: the coach is a **warm contact** (the admin employs them), **turnover is high** — assistant coaches in India are often young, informal, and seasonal — and therefore the admin will run this flow **several times a year**. The design target is that **adding a coach takes the admin under a minute and the coach one tap.**

**Step 1 — the admin adds three facts.** Contact (shared as a vCard, or name plus number), which classes, and the pay rate. Nothing else. No availability grid: the admin assigns the coaching, so there is nothing for the coach to declare. **The bot messages nobody yet** — same rule as the parent funnel (§6.1).

**Step 2 — the invite, self-initiated.** The bot drafts a short message in the admin's own voice; the admin forwards it from their own number. It carries a deep link: one tap opens the chat with a prefilled first message, the coach sends it, and the window opens from their side. Free, no template, no block risk, no tier consumption — the same mechanics that make the parent funnel work (§6.1), and easier here because the coach already trusts the sender.

**Step 3 — first run is one confirmation, not a questionnaire.** The bot shows what it already knows and asks the coach to check it:

> Hi Arjun — I'm Class Manager, I handle scheduling for Ace TT Academy. Sharwin added you as a coach.
> Your classes:
> • Mon/Wed/Fri 6:30–7:30 pm — Beginners, Green Park
> • Sat 8–10 am — Advanced, Green Park
> **[Looks right]** **[Something's wrong]**

*Looks right* completes onboarding. *Something's wrong* routes to the admin — the coach does not get to edit the catalog, because the admin owns it (§2.1).

**Step 4 — proof, not promises.** Immediately, in the same breath: their next session, what will happen before it, and what they'll be asked to do after it. Then the ask to pin the chat. Nothing to install, nothing to remember.

**What is deliberately never asked:** availability, personal details, a photo, a bio, a password.

**Pay is set by the admin and visible to the coach — their own only.** Hiding it would make §5.2's payables worthless: a running total you can't check against a rate you don't know is not a number anyone trusts. Coaches already know what they're paid; it is private from *each other*, not from themselves. This is a natural RLS boundary. The rate takes the same shape as class rates — one amount, one unit (per session, per hour, or monthly) — and **"not tracked" is a first-class option**, because a family member helping out on Saturdays is not on a payroll and forcing a number there is friction for nothing.

**If a coach never onboards** and has a session inside 48 hours, the **admin** is told — not the coach, who by definition isn't listening yet.

### 5.2 Day-to-day

**What we take off their hands:** the morning "what's my day" scramble, the is-anyone-covering-me anxiety, the attendance register, and being invisible when they do everything right.

The day is a ladder of single questions, each at its right time, one at a time — never a wall of admin:

1. **Morning — the day, delivered.** Every session: time, class, venue, headcount. "Reply here if anything looks wrong."
2. **An hour before — "Coming?"** [Yes, I'm coming] [Can't make it], with a directions button.
3. **Half an hour before — one nudge** if still silent, saying the quiet part out loud: the admin gets alerted shortly if we still don't know.
4. **At start time — "Reached?"** [I've arrived] [Running late]. Arrival tells every waiting parent, cancels the admin's pending alarm, and counts as confirmation — arrived implies coming, so a coach who taps once is never nagged twice. Running late alerts the admin.
5. **After class — the register.** [All present] [Some absent]; "some" opens a numbered roster picker (reply "2 4"), expiring after a couple of hours. Both branches end the same way: rate the players still pending — one tap each, optional note — which feeds the parents' outcome messages (§7.2), the month's tally (§2.5), and the coach's own payables.

Silence is **escalated, never punished**: the admin hears shortly before and after start time, and a stand-down goes out the moment the coach lands. Nobody chases a coach who is mid-warmup.

- **"Can't make it" arranges its own cover.** The tap confirms first — dropping a class is not a mis-tappable act. Then, if other coaches are assigned to that session, they are simply told; the class still runs (§2.3). If the session would be left uncovered, it is offered to the academy's other coaches — [Claim this session], first tap wins, the rest are told it's taken.
- **Out-of-band changes land here.** Parents will tell the coach directly — at the court, in their own chat — that a child is out next Tuesday. The bot never sees it. So the coach's morning brief and roster make marking someone out a single tap, and the coach can say it in a sentence any time. **This is the most common way the system's picture goes stale**, and the fix is making the coach the repair path rather than pretending it won't happen.
- **What they're owed, visible.** Payables computed from sessions taken, against a rate they can see. **The admin executes payment** — payout rails are deferred (§14).

### 5.3 Churn

Coaches leave often and new ones arrive. Both are routine operations, not exceptional ones.

**Leaving is an end date, never a delete.**

1. The admin says it in a sentence: *"Arjun's last day is the 30th."*
2. The bot reads back every session assigned to him past that date — count, classes, dates (§13, read-back before bulk).
3. It asks who takes them: another coach, split across several, or "I'll decide later."
4. Anything left over becomes an **uncovered session** — which is already a state the product understands (§2.3), so churn reuses the existing escalation rather than inventing one.
5. The coach's chat gets a final payables statement, then stops receiving sessions.
6. **History stays attributed.** Attendance he marked, notes he wrote, sessions he took. Audit trail needs it and so do payables.
7. **Parents hear only if something changed for them.** A co-coach remaining means silence. A changed coach on their child's class means one line in the next reminder — never a broadcast, which manufactures anxiety about a routine event.

**Arriving is §5.1** — three facts and an invite, under a minute.

**Covering for a stretch** — a coach filling in for three weeks — needs no new concept at all: it is assigning them to those sessions. The coach set (§2.3) already expresses it.

---

## 6. The client

### 6.1 Onboarding

The core reframe: **don't import — get invited.** Every path where the parent sends the first message is strictly better: free, no template, no block risk, no tier consumption, and the window opens itself.

**Step 1 — the admin shares contacts.** Multi-contact share straight from the phone's address book (arrives as vCards), or a photographed register (§9.5). The bot builds the roster — players, classes, who is in what — **while messaging nobody**. Real value delivered inside the onboarding session, zero risk taken.

**Step 2 — parents invite themselves.** The bot drafts the invite and walks the admin through a **WhatsApp Broadcast List** (up to 256 recipients, lands as a normal 1:1 message from the admin, recipients never see each other — exactly right for the no-groups, all-1:1 admin). The message carries a deep link; a tap opens the chat with a prefilled first message; the parent hits send — **and the bot introduces itself**: whose manager it is, the three things it does for them (schedule and reminders, booking and changes, payments), and then proof instead of promises: their child's actual schedule, with a useful next tap.

**Identity is the phone number — there are no join codes.** Step 1 registered the number, so a recognized sender resolves on sight. The prefilled text exists to give the parent something to send and to name the academy for numbers Step 1 never saw — a forwarded invite, a second parent — which resolve by academy handle plus one confirming question. The admin's name carries the trust; contact data never leaves anyone's phone for this to work.

**Step 3 — non-clickers get a useful message, event-triggered.** No waiting period, no follow-up nag. Whoever hasn't tapped is contacted the first time there is a real reason — a session inside the next 48 hours — and the message explains itself in one line before being useful:

> *Hi Meera — I'm the new class manager for Ace TT Academy on WhatsApp. Aarav has Beginners Batch tomorrow, 6:30 pm at Green Park.*
> **[See Aarav's schedule]** **[Stop these]**

Inherently utility-shaped, unmistakably legitimate, and it spreads risk across weeks by construction.

**First-contact rules, whichever path produced the message:**

1. Academy's and player's name in the first line — the recognized name does the trust work.
2. Say something only the real academy could know (the class, the time).
3. One *useful* button, never a consent-shaped one — a useful tap opens the window and confirms engagement in one action.
4. Frame as service continuity ("class updates have moved here"), never launch ("introducing…" is marketing category).
5. The admin's heads-up goes out hours earlier — bot-drafted, admin-forwarded.
6. **Staged: 10 → check delivery, read and block signals → 50 → check → the rest.** Non-negotiable on a shared number (§12).

### 6.2 Day-to-day

**What we take off their hands:** knowing when and where the next session is — and whether the coach has arrived; booking and changing without calling anyone; paying without being chased; knowing how their child is doing.

- **Reminders worth tapping**: *"Aarav has Beginners Batch tomorrow 6:30 at Green Park — [I'll be there] [Can't make it]"*, a few hours ahead. "Can't make it" confirms before it acts; a pocket mis-tap must never give away a seat. Useful buttons are also how the 24h window stays open (§12).
- **Book, cancel, reschedule** through buttons and lists first, free text when they want it. Scope is always asked (§2.6).
- **The coach's arrival, relayed.** When a coach marks arrival, waiting parents hear it. Running late is relayed too, honestly.
- **After class, the outcome**: attended or missed, with the coach's note when one was written. An absence arrives as something to fix — "reply to rebook" — not a verdict.
- **Pay by UPI in the chat** — a payment link or an AutoPay mandate depending on the academy's rail (§9). Receipts and the month's tally land in the same thread, readable line by line.
- **Progress** — attendance and coach notes, per player.
- **Feedback, asked right after class** — piggybacked on the outcome message, one tap plus an optional comment, frequency-capped so it stays welcome. It flows to the admin.
- **A human when it matters** (§9.6).

---

## 7. The bot's character

- **Educator — reactively.** Capability hints surface when a message comes close to something the bot does, never as unsolicited broadcasts. Cheaper, better received, and it stays out of the marketing category.
- **Manager.** Runs the feedback loops both directions, chases what needs chasing, escalates what needs a human.
- **Salesperson — within policy.** Last-minute conflict handling is revenue recovery shaped as utility: rebook nudges after a miss, a freed slot offered to a family who asked for one, cover offers to coaches. Each tied to a real event, which is what keeps them utility-shaped.
- **Quiet by default.** Every proactive message exists because its recipient would have wanted it. No engagement pings, no "just checking in," no message whose only job is reminding people the bot exists. The bar for a new message type: **someone would have asked for it.**

---

## 8. The solo case

Most coaching businesses in India are one person. The solo path is not the multi-coach product with n=1 — running it that way is churn in week one, because asking someone to confirm attendance at their own class is absurd. **Specify what disappears:**

| Flow | Solo |
|---|---|
| Coach onboarding | **Gone.** They onboarded as the admin. No invite, no "confirm your classes." |
| "Coming?" ladder + nudge | **Gone.** They know. |
| Coach-unconfirmed escalation | **Gone.** Nobody to escalate to. |
| Cover offers | **Gone.** A drop becomes a reschedule: pick a new slot, the bot tells the families. |
| Coach payables | **Gone.** They are the business. |
| Morning brief + coach's day | **Merged** into one message in one chat. |
| Evening digest | **Kept**, shorter. |
| Arrival tap | **Kept — reframed.** "Start class," not "did you show up." Its real job is telling waiting parents. |
| Register | **Kept unchanged.** It is the meter and the coaching record. |

Roughly 60% of the coach surface disappears. Nobody is ever asked to confirm something to themselves, and no escalation about the coach pings the coach.

**Strategically:** the data model is multi-coach from day one — a coach *set*, coverage as a session property — because that costs nearly nothing to build and cannot be retrofitted later. The flow set treats solo as first-class. Solo is the easiest to acquire and the cheapest to serve; multi-coach is where coordination pain is severe enough to be worth real money. A solo coach who grows becomes the target customer without migrating anything.

---

## 9. Interaction doctrine

### 9.1 A general agent on guardrailed primitives

The capability surface is a small set of **generic primitives**, not a catalog of hand-built features:

- **Read** — the agent authors queries over a schema it knows. Any question answerable from the data is answerable, with no new code.
- **Write** — CRUD through transactional operations carrying the business invariants (§13): a cancel that credits and notifies is one transaction, not a checklist the model must remember.
- **Message & broadcast** — send primitives staged, capped and throttled *by construction* (§12); the model may call them freely because they are safe to call.
- **Money** — payment links, mandates, reconciliation prompts, adjustments.
- **UI** — a kit of buttons, lists and parameterized Flows the model composes at will (§9.4).

Anything a manager could do, the agent can compose. Safety is **structural, not behavioral**: tenancy-scoped RLS, invariants in the transaction layer, caps inside the send primitives. The floor being solid is exactly what lets the model be free above it.

### 9.2 Recipes as the optimization layer

Common actions get **promoted into precoded recipes** — saved compositions of the same primitives: a pre-resolved plan, pre-built UI, a prompt fragment the agent doesn't re-derive. Booking, cancelling, confirming, attendance, dunning and menu navigation run this way: instant, near-free, and **visually consistent** — users see the same well-made shapes every time, not a freshly improvised UI per conversation.

Recipes optimize; they never gate. A request no recipe matches falls through to the primitives — that is the design working, not failing. Instrumentation is the profiler: whatever the agent keeps re-deriving is the next recipe. This layer is simultaneously the UX-consistency strategy, the cost strategy, and where menus live.

### 9.3 The payload rule: mint once, replay verbatim

The model may author **what a tap will do** — including actions nobody pre-imagined — but it authors them at *compose time*: the action is minted, validated by the same guardrails as an immediately-executed one, and stored. The tap **replays it verbatim** — no reinterpretation, no inference, no drift between the label and the act. Taps stay instant and free, and a button can never do something other than what it said. **Dynamic actions, deterministic taps.**

### 9.4 UI composes from a kit

- **Every link is a button.** Anything URL-shaped — a rendered view, a payment, KYC — rides behind a labeled CTA. The bot never pastes a bare URL into message text.
- **UI is an offer, never a gate.** Nobody is forced through a form for something the chat could simply do.
- **Flows are in, and they're aimed.** A WhatsApp Flow is a real subsystem — published, versioned, with an encrypted data-exchange backend — so it is built deliberately, not habitually. Its job is moments where conversation is the wrong shape because each bot reply carries a small wait that compounds: **admin setup above all** (§4.1), then a short list of recurring form-shaped moments as usage proves them. Everything else is buttons, lists and chat. The kit carries Flows as **parameterized components**; the model fills slots and never authors Flow JSON freehand.

### 9.5 Multimodal in, text out

Inbound is multimodal, and this is not a nicety — **it is the answer to the data-entry problem** that is otherwise the whole cost of adoption (§4.1).

- **Images.** A photographed timetable becomes the week's classes. A paper register becomes a roster. A fee sheet becomes rates. A **GPay screenshot becomes a payment record** — amount, UTR and timestamp read off the image, offered to the admin as a one-tap confirm, which turns Rail 1 reconciliation from blind attestation into confirming something already read (§9 below).
- **Voice notes.** Widely preferred over typing, especially by coaches and by anyone working in a second language. Transcribed, then treated as text. Bangalore speech is Hinglish and Kannada/Tamil–English code-mixed, so transcription must be chosen against real samples rather than assumed.
- **Documents.** A forwarded spreadsheet or PDF of students, same pipeline.

**Two rules.** Anything parsed from an image, a voice note or a document is **read back before it is acted on** — recognition errors land precisely on names, times and amounts, which is exactly where damage happens. And parsing produces a *proposal*, never a silent write.

Outbound stays text, buttons and rendered views (§10). Generated images are deferred (§14).

### 9.6 The escape hatch

A quiet, always-reachable "talk to a person," plus **automatic triggers**: two failed turns in a row, refund/complaint/safety language, requests the tools genuinely can't serve. On trigger the bot performs the handoff itself and attaches the transcript. **Client escalations go to their academy's admin. Admin escalations go to the platform** — that second queue is the support desk and scales worst, so its transcript view is built early. Heavy use of the hatch is a product bug being measured.

### 9.7 In-window vs. templates

Replies to a user are inside the 24h service window by definition — free-form interactive messages there need no template and no approval. Approved templates are only for business-initiated messages, and almost all of ours are utility-shaped by design.

---

## 10. Web as a surface, not an app

- **Signed, expiring, single-purpose links** the bot hands out, always behind a labeled button (§9.4). Each renders exactly one thing just discussed: this week's calendar, a roster, a revenue view, a client list. No login, no navigation — the chat is the navigation.
- **The model composes views from a component library.** Calendar, roster, table, stat cards, timeline, chart — each hand-built with a data contract. The model assembles: which components, in what arrangement, filled by which queries. *"Show me this month's collections by class, worst Tuesdays first"* gets a purpose-built page, not the nearest canned report. The view spec is minted once (§9.3) and rendered deterministically — **never raw model-authored markup in a browser**, which is an injection surface a multi-tenant product must not have.
- **The one unavoidable web moment:** payment-gateway KYC, which is document-shaped and regulator-shaped. A bot-initiated link, not a destination.

---

## 11. Money, as product

Commercial model — take rate, floors, tiering — lives in `business-model.md`. What belongs here is only what a user sees and does.

### 11.1 Two rails

**Rail 1 — UPI deep links.** A generated pay-link to the academy's own UPI handle. Zero KYC, live in minutes, one field to set up. The platform is not in the money flow, so payment records are **admin-attested**.

**Rail 2 — API-first UPI via a payments partner.** The academy onboards as a sub-merchant, KYC via a bot-sent link. What it buys, in the order users feel it:

- **UPI AutoPay mandates.** The month's tally collects itself. Chasing forty parents monthly is the single biggest time sink in a small academy, and this removes it.
- **Checkout without leaving the chat.** An order-details message renders the amount with a Pay button in the thread, UPI underneath, and the paid/pending status posts back into the same chat. The fallback is a gateway link behind a button.
- **Reconciliation disappears.** The strongest thing that can happen to a feature is becoming unnecessary.

### 11.2 Reconciliation (Rail 1)

The bot sent the link, so it knows what the payment was for. Confirmation is a button on a message the bot sends — *"Did ₹4,500 from Rajesh arrive? [Yes] [Not yet]"* — never free text. A forwarded GPay screenshot (§9.5) pre-fills the answer. The incentive to confirm is structural: confirming is what stops dunning from embarrassing the admin by chasing someone who already paid.

Known weak spots, accepted: one-off payments have no dunning to avoid, and "just GPay me directly" is invisible to the platform. Both are reasons Rail 2 exists, not problems to engineer around.

### 11.3 The month-end message is a report, never an invoice

*"47 payments tracked, ₹94,000 collected, roughly 40 minutes of manual confirming — connect AutoPay and that's zero."* The same numbers framed as a report make the admin evaluate a tool; framed as a bill they evaluate a cost. This message is the entire upgrade argument, and it is made of facts the product already has.

---

## 12. One number, many academies

**One shared platform number** for all tenants — one WABA, no per-tenant Meta verification, radically simpler onboarding for non-technical admins.

What is pooled, and therefore what the platform must manage: **quality rating** (per number, so one bad tenant degrades everyone) and **messaging tier limits** on business-initiated conversations. Replies inside an open 24h window don't count against either — a second, harder reason that buttons people actually want to tap matter.

**Structural guardrails — built in, not advisable:**

- Per-tenant send caps and frequency limits. No unthrottled broadcast tool exists.
- First-contact sends staged by rule (§6.1), never blasted.
- Global opt-out honoring; automatic archival of long-inactive contacts.
- **Per-tenant quality proxies** — delivery failures, read rate, response rate, opt-outs, bucketed by academy — to find a bad actor before the number-level rating does.
- **The tripwire:** approaching a tier ceiling without auto-upgrade means adding another number and sharding tenants across it. **Per-tenant sender routing lives in the architecture from day one**, making that a config change rather than a rebuild.

**Accepted trade-off, eyes open:** parents message "Class Manager," not the academy's own name. Mitigations: the academy's name leads every message, and the coach keeps the human relationship — which is intact, since the bot sits on a different number and takes nothing away from the admin's own thread with a parent. The real cost is **fragmentation**: two threads, and parents will use the wrong one. §5.2's out-of-band repair path exists because of this.

**The sender number itself is a trust decision.** A foreign country code messaging Bangalore parents reads as spam next to the contacts around it. See §15.

---

## 13. Trust architecture

Why an admin can let a bot run their business — and why tenant #2 can trust a platform running tenant #1's:

- **Row-level security is the boundary; the LLM is just a user of it.** Every conversation acts through a real per-user session. Tool availability is UX; database policies are security. Tenancy-first from birth, every policy carrying a regression test. A coach sees their own sessions and their own pay, never the academy's.
- **Read-back before bulk.** Any action touching multiple people or sessions gets the resolved set read back — count, names, totals — before execution. A filter that quietly matched the wrong rows is the mistake this system can make at scale.
- **Audit trail and an undo window** on destructive bulk operations.
- **A lint layer repairs output deterministically** — strips internal identifiers, rewrites machine timestamps, downgrades claims the system can't back. Enforcement in code for rules a model under pressure will otherwise break.
- **Sending is not receiving.** Queued ≠ delivered, enforced in code and in copy. The bot never claims what it can't see.
- **Invariants live in the transaction layer.** Generic writes run through operations that cannot half-complete.
- **Deterministic taps.** Every tap replays a stored, code-validated action minted at compose time (§9.3). Approve/deny, attendance, arrival, cover claims — no model at tap time, where a misread commits someone to being somewhere.

---

## 14. The emulator

Real WhatsApp is a hostile place to develop: real numbers, approved templates, tier limits, and one shared number where a test blast is a production incident. So the primary development surface is an **emulator** — a local web view that looks and behaves like WhatsApp and renders the bot's *actual* messages.

- **One transport interface, two implementations.** The bot addresses an abstract transport; the Cloud API is production, the emulator is development. Same payloads, same buttons, same Flows. If the emulator can't render a message, it doesn't ship.
- **Every persona side by side.** Client, coach, admin and the platform's own escalation desk in one screen. Type as anyone, see exactly what they'd see, tap the taps against a seeded local database.
- **A clock you can turn.** Most of the product is proactive — reminder ladders, arrival checks, digests, dunning. The emulator advances time on demand: jump to an hour before class and watch "Coming?" fire. Machinery that takes days to observe in production becomes testable in minutes. **This requires the scheduler to be a drivable abstraction, not a cron detail.**
- **Scenario seeds.** One command to a populated academy — families, classes, a day of sessions, an overdue tally — so any flow replays identically. The same seeds double as the sales demo.

The emulator is a dev tool with a product-grade constraint: **pixel-honesty.** It exists so that "looks right in the emulator" and "looks right in WhatsApp" are the same claim.

---

## 15. Explicitly deferred

| Deferred | Why |
| --- | --- |
| Coach at two academies | A real routing question on a shared number; fix when hit. |
| Coach payout rails | Payout infra, TDS, contractor classification. Bot computes payables; admin pays. |
| Per-tenant WABA / Embedded Signup | The shared number removes it entirely. |
| Coach-assignment automation | The admin knows who coaches Tuesday. Clash-checking and cover offers are enough. |
| Capacity limits and waitlists | Sound essential, almost never fire in a well-run academy. Revisit on a genuine overflow. |
| Skill levels | A class is a time, a place and people. Levels are the admin's naming (§2.1). |
| Split households | One player, two accounts, split payment. Real but rare; not day one. |
| Generated-image visualization | Rendered views beat images on every axis (§10). |
| Unsolicited marketing broadcasts | Category risk on a shared number. Opt-in and throttled if ever. |
| Non-WhatsApp clients | Out of scope permanently. |
| School programs | Account-less pupils, a read-only school view, no billing. A real segment, not core. |

---

## 16. Open decisions

1. **Final name.** "Class Manager" is a working label, and also the name every parent sees in their chat header — a branding decision, not a config value. It has one real virtue worth keeping: it says *class*, not *academy*.
2. **The sender number's country code.** A local number is materially better for first-contact trust (§12); a local number also carries KYC and local-entity requirements. This gates the parent funnel's conversion, so it is decided early, not late.
3. **Transcription provider.** Chosen against real Hinglish and Kannada/Tamil–English samples from actual users, not on benchmark scores (§9.5).
4. **Sport and category scope at launch.** The model — classes, sessions, players, rates — generalizes past sport to music, dance and tuition without change. How much genericizing happens before tenant #2 rather than after is open. Note that "academy" is the word that does *not* generalize, which is why it appears nowhere a user can see it.
5. **Model strategy.** A cheap model for clients and coaches, a strong one for admins, is the presumed split. Decide against early live cost data.

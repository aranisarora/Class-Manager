# Ideal conversations

Twelve realistic WhatsApp conversations — three each for **admin**, **coach**, **client** and **prospect** — written as the bot should actually behave. Everything here is derived from `product-spec.md` only. Where a line is doing spec work, there's a note underneath saying which rule it's honouring.

These are meant as targets: if the built bot can't hold up its side of these twelve, something is missing.

---

## How to read these

| Notation | Meaning |
|---|---|
| **SHARWIN** | a human typing or tapping |
| > blockquote | a bot message bubble |
| `[ Button ]` | a WhatsApp reply button (max 3 per message) |
| `≡ List: …` | a WhatsApp list picker (used when >3 options) |
| **↳ taps `[ X ]`** | the human taps a button |
| ⚙ | what happens underneath — operation, job, state change, spec rule |
| 🕐 | time passes |

**The cast** — Ace TT Academy, table tennis, Green Park, Bangalore. Sharwin (admin), Arjun and Vikram (coaches), families: Meera's mum Latha, Aarav's dad Rajesh, Kiran's mum Priya. Timezone `Asia/Kolkata`. Cancellation window 24h. All money in ₹.

**Two things the bot never does, in any conversation below:** say the word "academy" as a product noun (§18.4 — it says "Ace TT Academy", the business's own name, and nothing else), and claim something was *delivered* when it only knows it was *sent* (§2.4).

---
---

# ADMIN

The admin gets the widest surface: a natural-language CLI over the whole business, a list-picker as the missing nav bar, two bookends a day and quiet in between.

---

## A1 · Onboarding — whiteboard photo to working business in eleven minutes

**Tests:** setup form (§7.1) · timetable parsing and read-back (§14.5, §2.7) · coach add + self-initiated invite (§8.1) · roster build that messages nobody (§2.6) · mid-cycle join (§7.1) · broadcast-list go-live (§9.1)

**The scenario.** Sharwin has just signed up. Four classes, two coaches, 38 players, mid-August. He has a whiteboard with the week on it and a WhatsApp group full of parents.

---

**SHARWIN**
Hi

> Hi Sharwin — I'm Class Manager. I'll run scheduling, reminders and fees for Ace TT Academy over WhatsApp, so you're not doing it by hand.
>
> Fastest way in: one form for the things that are annoying to type in chat — your venues, your hours, your cancellation rule. Two minutes, once, and then we never leave the chat again.
>
> `[ Open setup ]`  `[ What do you need from me? ]`

⚙ The form is an *offer*, not a gate (§14.6). `[ What do you need from me? ]` exists because an admin who wants the shape of the whole thing before starting should get it in chat.

**↳ taps `[ Open setup ]`** — signed link, short-TTL JWT, no login (§15)

**The setup form** (one screen, `form` component):

| Field | What's asked | Sharwin enters |
|---|---|---|
| Business name | Shown to every parent, in every message | Ace TT Academy |
| What you teach | Display only | Table tennis |
| Venues | Name + address, add as many as needed | Green Park Indoor Stadium, Court 3 |
| Operating pattern | Rough days/times — helps read your timetable | Mon–Sat, mornings and evenings |
| Cancellation notice | How much warning before a class stops being chargeable | 24 hours |
| Your name | What coaches and parents see when you send something | Sharwin |
| Timezone | Prefilled | Asia/Kolkata |

**↳ submits**

> Got it. Ace TT Academy, Green Park, 24 hours' notice.
>
> Now the part that usually takes an hour: your timetable. Send it however it already exists — a photo of the whiteboard, the paper register, a forwarded spreadsheet, or just a voice note telling me the week.
>
> `[ I'll type it instead ]`

⚙ §7.1 step 2. This is named in the spec as *the single biggest friction reducer in the product*, so it gets asked first and asked wide.

**SHARWIN** 📷 *photo of a whiteboard, marker, slightly angled*

> I read this off your board — check it before I create anything:
>
> • **Mon, Wed, Fri · 6:30–7:30 pm** · Beginners · Green Park
> • **Mon, Wed, Fri · 7:30–8:30 pm** · Intermediate · Green Park
> • **Sat · 8:00–10:00 am** · Advanced · Green Park
> • **Sat · 10:00–11:00 am** · ❓ — the last row was cut off. "Sub jr"? Tell me what it says.
>
> `[ Create the first 3 ]`  `[ Fix something ]`  `[ Cancel ]`

⚙ Parsed input is a *proposal*, never a write (§2.7). The unclear row is said plainly rather than guessed (§14.5, §4.1 rule 10) — and it doesn't block the three good ones.

**SHARWIN**
Sub junior, 10-11 sat, same place

> Added. Four classes:
> Beginners · Intermediate · Advanced · Sub Junior.
>
> Two things I still need before these can produce sessions and bills:
>
> ≡ **List: What's next**
> › Set rates for the four classes
> › Add coaches
> › Add families
> › I'll do rates later

**↳ taps `Set rates for the four classes`**

> One at a time. **Beginners** — what do you charge, and how?
>
> `[ Per month ]`  `[ Per session ]`  `[ Other ]`

⚙ Four rate units exist in the schema (§6.4). Only the two common ones get buttons; term and 10-class packs live behind `[ Other ]`, so the common path is one tap.

**SHARWIN**
2500 a month, all of them except advanced. advanced is 3500

> Set:
> • Beginners, Intermediate, Sub Junior — **₹2,500/month**
> • Advanced — **₹3,500/month**
>
> Monthly means a line is written on the 1st per player, whatever their attendance. Cancellations still matter — they tell the coach the headcount — they just don't change the bill.
>
> `[ That's right ]`  `[ Some are per-session ]`

**↳ taps `[ That's right ]`**

> Coaches next. Share their contact cards, or just type name and number.

**SHARWIN** 📇 *shares two contacts: Arjun M, Vikram R*

> Arjun and Vikram. Two questions each, then I'm done.
>
> **Arjun** — which classes?
>
> ≡ **List: Arjun's classes** (multi-select)
> › Beginners · Mon/Wed/Fri 6:30
> › Intermediate · Mon/Wed/Fri 7:30
> › Advanced · Sat 8:00
> › Sub Junior · Sat 10:00

**↳ selects Beginners + Advanced**

> And his pay?
>
> `[ Per session ]`  `[ Per month ]`  `[ Don't track it ]`

⚙ `pay_amount = null` is a first-class state, not a skipped field (§8.1).

**SHARWIN**
500 per session

> Arjun · Beginners + Advanced · ₹500 per session. **He hasn't been messaged.**
>
> Same two for Vikram?

**SHARWIN**
intermediate and sub junior, also 500

> Done. Both coaches are in, neither has been contacted.
>
> When you're ready, I'll write their invite and you forward it from your own number — it lands as a message from you, which is how it should read.
>
> `[ Do that now ]`  `[ Later, families first ]`

**↳ taps `[ Do that now ]`**

> Here's Arjun's. Send it as is, or edit it:
>
> ⁠—
> *Hi Arjun, I've moved Ace TT scheduling onto WhatsApp — you'll get your day, and mark attendance with a tap instead of texting me. Tap here to start: wa.me/…*
> ⁠—
>
> `[ Send as is ]`  `[ Edit ]`

⚙ §8.1 step 2. The bot deliberately does **not** imitate Sharwin's voice — Arjun already knows him; the draft only has to not read like a blast.

**↳ taps `[ Send as is ]`** — WhatsApp opens Sharwin's chat with Arjun, text prefilled, he hits send. Same for Vikram.

⚙ The coach taps the deep link, sends the prefilled text, and **the 24h window opens from their side** — free, no template, no block risk (§8.1, §16.1).

> Both forwarded. I'll confirm here when each of them lands.
>
> Now families — the big one. Same deal: share the contacts, photograph your register, or forward a list.

**SHARWIN** 📇 *multi-contact share, 34 vCards* — then 📷 *a photo of the paper register*

> Read: **34 contacts** and **38 players** across the four classes.
>
> Almost all of it lines up. Three things I can't resolve on my own:
>
> 1. **Two "Meera"s** in Beginners — one register, two numbers
> 2. **Kiran S** appears in Beginners *and* Advanced — two children with the same first name, or one child in two classes?
> 3. **Six numbers with no name on the register** — I can guess from the contact card, but I'd rather you look
>
> `[ Sort these out ]` — opens a page with just those 9 rows
> `[ Skip, I'll fix later ]`

⚙ Reading a register is a proposal; the bot fixes what it can and escalates only the genuinely ambiguous. Dense correction work goes to the web surface, not to twelve chat round-trips (§14.6, §15).

**↳ taps `[ Sort these out ]`, fixes nine rows on one page, submits**

> Roster's built: **38 players · 31 families · 4 classes · 2 coaches.** Nobody has been messaged.
>
> One thing before you go live, because it decides whether anyone gets chased wrongly: **who has already paid, and until when?** Anything before that date, I never mention. You're not going to have me dunning people for July.
>
> `[ Everyone's paid through August ]`  `[ Mark them individually ]`

⚙ §7.1 — *nobody is ever chased for money from before the platform*. Getting this wrong on day one is unrecoverable trust damage, so it's asked, not assumed.

**↳ taps `[ Everyone's paid through August ]`**

> September's the first month I'll bill. Last thing: your UPI handle, so parents can pay in the chat.

**SHARWIN**
acett@okhdfcbank

> Set. **Ace TT Academy is live and completely silent** — 38 players, four classes, sessions generated three weeks out, and not one parent knows I exist.
>
> Going live with parents is the one thing I won't do on my own. When you say go: I write the invite, you send it through a broadcast list — it lands as a normal one-to-one from you, they never see each other — and I go out in batches of ten so we can stop if anything looks wrong.
>
> `[ Show me the invite ]`  `[ Not yet ]`

⚙ Invariant 6 stated out loud. §9.1 step 2: staged batches with a halt condition, not a campaign (§13 `first_contact_batch`).

**↳ taps `[ Show me the invite ]`** → draft shown → `[ Send as is ]` → broadcast-list walkthrough (3 screenshots, ≤256 recipients) → parents start tapping in.

---

**Design notes — A1**

- **The form appears once, ever.** Everything after it is chat. The register-fixing page is the one exception, and it's a shortcut out of nine chat round-trips.
- **Every step ends with "nobody was messaged."** The admin's real fear during onboarding is an accidental blast to 31 families. The bot repeats that it hasn't, unprompted, four times.
- **Ambiguity is surfaced, never resolved silently.** Two Meeras, a cut-off row, six unnamed numbers — each one said plainly.
- **The money question is asked before go-live, not at month end.** Discovering the "already paid through" rule when the first dunning message fires is too late.

---

## A2 · A coach quits mid-term, on a Tuesday morning

**Tests:** morning brief led by *Needs you* (§7.2) · `end_coach` as one transactional operation (§8.3) · write-diff preview at real blast radius (§14.2) · undo that sends corrections (§7.2) · delivery-status honesty (§2.4) · self-scheduled watch (§13.1)

---

🕐 **07:00 — the morning brief fires**

> **THIS MORNING · Ace TT Academy**
>
> **Needs you:** Saturday 8am Advanced has no confirmed coach. Arjun hasn't answered since Friday.
>
> Otherwise: 3 sessions today, 26 expected, all covered. Meera and Kiran still unpaid for August — day 12.
>
> `[ Chase Arjun ]`  `[ See Saturday ]`  `[ Nudge the two unpaid ]`

⚙ §7.2 — *Needs you* leads, and the brief is silent when there's nothing. Buttons are the natural next steps, not a menu (§4.3).

**SHARWIN**
arjun just called me. he's leaving, last day is the 30th

> Sorry — that's short notice mid-term.
>
> Before I touch anything: **Arjun has 11 sessions after the 30th**, over four weeks.
>
> • Beginners · Mon/Wed/Fri 6:30 · 9 sessions
> • Advanced · Sat 8:00 · 2 sessions
>
> Who takes them?
>
> `[ Vikram takes all 11 ]`  `[ Split them ]`  `[ Decide later ]`

⚙ `end_coach(coach_id, date)` reads back the affected sessions **before** setting anything (§8.3 steps 1–2). Nothing has been written yet.

**SHARWIN**
vikram can do beginners but not saturday, he has his own class then

> Then:
>
> • **Vikram** → the 9 Beginners sessions
> • **Sat 8:00 Advanced × 2** → nobody yet. Those become uncovered sessions, and I'll chase you about them the way I chase any uncovered session — not as a special coach-leaving thing.
>
> Also in this: Arjun's `ended_on` set to **30 Aug**, his final payables statement goes to him that evening, and he stops getting session messages after it. His attendance marks and notes stay on the record.
>
> **Parents hear nothing.** Beginners keeps a coach; the change isn't theirs to worry about. The two Saturdays are a real gap — if those don't get covered, that's when parents get told.
>
> `[ Do all of this ]`  `[ Show me the 11 sessions ]`  `[ Cancel ]`

⚙ The whole chain is one operation, so it can't half-complete (§2.5). §8.3 step 7: *parents hear only if something changed for them* — and the bot says so, because silence that isn't explained reads like an omission.

**↳ taps `[ Do all of this ]`**

> Done.
>
> Arjun ends 30 Aug · Vikram has the 9 Beginners sessions · 2 Saturdays uncovered.
>
> `[ Draft a note to Arjun ]`  `[ Find cover for the Saturdays ]`

**↳ taps `[ Find cover for the Saturdays ]`**

> Vikram is your only other active coach and he's teaching at that hour. Options that don't need a new person:
>
> `[ Move Advanced to 9:30 ]`  `[ Cancel those two ]`  `[ I'll find someone ]`

**↳ taps `[ Move Advanced to 9:30 ]`**

> That moves **Saturday Advanced, permanently, from 8:00 to 9:30** — not just the two.
>
> **14 enrollments affected.** Meera, Aarav, Kiran, Nithya, Rohan, +9 more.
> Six future sessions rescheduled. Two already have attendance marked — those stay where they are.
>
> `[ Do it ]`  `[ Just the two Saturdays ]`  `[ Show me all 14 ]`  — *or tell me a different time*

⚙ §14.2 — the diff is **computed inside the transaction**, not estimated. And §9.2's scope question, mirrored on the admin side: *this session, or every week?*

**↳ taps `[ Do it ]`**

> Moved. Six sessions now Sat 9:30–11:30.
>
> The 14 families haven't been told yet. Two ways:
> • one line inside their next reminder — quiet, arrives when it's useful
> • a message now — louder, but it's a permanent time change and some of them plan around it
>
> `[ Tell them now ]`  `[ Put it in the reminders ]`

⚙ §12.1 — a change normally rides inside the next `CL-REMINDER`, but a permanent 90-minute move is not a routine event, and the bot names the trade-off instead of deciding quietly (§4.1 rule 8).

**↳ taps `[ Tell them now ]`**

> Sent to 14. I'll tell you how they land — I'll know delivered from read, and I'll tell you the difference.

🕐 **09:40**

**SHARWIN**
wait, 9:30 clashes with sub junior, they share court 3. put it back

> Undoing the move. Two halves, and only one of them is reversible:
>
> **Database:** six sessions go back to Sat 8:00. Clean.
> **Messages:** I already told 14 families it moved. I can't unsend that. What I can do is send exactly those 14 a correction — nobody else.
>
> *"Correction from Ace TT Academy — Saturday Advanced stays at 8:00 am. Ignore the change I sent this morning, that was my mistake."*
>
> `[ Do both ]`  `[ Just put the sessions back ]`

⚙ §7.2 — *undo reverses database writes only*, and the correction goes to **exactly** the people who were told. Stating that before running it is the whole point.

**↳ taps `[ Do both ]`**

> Sessions back at 8:00. Correction sent to the same 14.
>
> The two uncovered Saturdays are still uncovered.
>
> `[ Cancel those two ]`  `[ Leave them, I'll sort it ]`

**SHARWIN**
leave it. did meera's mum get the correction?

> **Sent** to Latha at 09:44, **delivered** 09:44, **not read yet.**
>
> Of the 14: 14 sent, 13 delivered, 1 failed — Nithya's number came back invalid.
>
> `[ Fix Nithya's number ]`

⚙ §2.4 in one line. The bot has three separate facts and reports three separate facts. §7.2: delivery health is pushed, not pulled.

**SHARWIN**
keep an eye on saturday advanced, i think we're losing people

> I'll watch it. What that means concretely: every Sunday I look at Saturday Advanced attendance against the four weeks before, and I only say something if it's actually moving. If it's flat you won't hear from me.
>
> Running until **end of October** unless you stop it. You can ask me what I'm watching any time.
>
> `[ Fine ]`  `[ Make it fortnightly ]`

⚙ `job(kind='agent_task')` — an instruction plus the query that feeds it, with a required `expires_at` (§13.1). It runs under a session reconstructed for Sharwin, so it can never see more than he can.

**SHARWIN**
what are you watching?

> Two things:
>
> 1. **Saturday Advanced attendance** — weekly, until 31 Oct
> 2. **Meera's family** — you asked in July whether they came back after the fee waiver. Still running, expires 20 Aug
>
> `[ Stop watching #1 ]`  `[ Stop watching #2 ]`

⚙ §13.1 — live tasks are capped per academy **and visible**, droppable with a button.

---

**Design notes — A2**

- **Every destructive thing is read back at real size before it runs.** "11 sessions", "14 enrollments", "6 future sessions, 2 with attendance already marked" — all computed, none estimated.
- **The coach leaving does not invent a new escalation.** The uncovered Saturday goes through the *existing* uncovered-session path. Churn reuses machinery (§8.3 step 4).
- **The undo is honest about being half an undo.** A product that pretends messages can be recalled half-works in exactly the moment trust matters.
- **"Keep an eye on X" needs no feature.** It's one row, and the bot states what watching will actually consist of so the admin knows what silence means.

---

## A3 · Evening digest, a disputed fee, and the bot's own memory

**Tests:** synthesized digest with grounding rules (§10.2) · money-dispute escalated from a parent (§4.2) · adjustment as the one primitive (§6.4) · view on the web surface (§15) · memory that's visible, editable and acted on (§5)

---

🕐 **21:00**

> **TONIGHT · Ace TT Academy**
>
> Saturday Advanced is the thing to look at. Attendance is down a third — 14 of 21 last month, 9 of 21 across the last three Saturdays — and all four of the families who stopped joined in June. I think that's term-fee timing rather than the coaching, but at four families it could equally be coincidence. Worth one conversation, not a decision.
>
> Otherwise a clean day: 3 sessions, 26 present, 2 absent, both cancelled in time. Vikram was 10 minutes late to Intermediate and told the parents himself.
>
> Meera, Aarav and Kiran unpaid for August. Day 12.
>
> Reminders today: 26 sent, 26 delivered.
>
> `[ Who are the four? ]`  `[ Nudge the unpaid ]`

⚙ §10.2's three grounding rules, visible in the text: every number came from the payload; "down a third" carries its baseline *in the same sentence*; the causal story is offered with its uncertainty stated rather than asserted.

**SHARWIN**
show me saturday advanced over the last 3 months

> Across **1 class, 21 players, 15 Saturdays, 15 May – 14 Aug**:
>
> `[ Open the chart ]`
>
> Short version: steady at 14–16 until 12 July, then 11, 10, 9, 9. The drop starts the Saturday after term fees went out.

⚙ §14.2 — *scope is always shown*, so a wrong denominator is visible. The chart is an upgrade to a text answer, never a prerequisite for one (§15).

**↳ taps `[ Open the chart ]`** — signed link, a `chart` + `table` view, attendance line with the fee date marked, roster underneath.

🕐 **21:20 — an escalation arrives, unprompted**

> Latha (Meera's mum) is disputing the August bill. She says Meera didn't attend after the 2nd because of exams, and she told Arjun at the court.
>
> What's on record: Meera is **per month**, so the ₹2,500 was written on 1 Aug regardless of attendance. She's marked absent 5 times, none of them cancelled in advance. Nothing from Arjun.
>
> Her words: *"I told him twice. Why should I pay full for a month she didn't come?"*
>
> `[ Waive the month ]`  `[ Half ]`  `[ Talk to her myself ]`

⚙ §4.2 `money-dispute` and §14.8. The bot does **not** decide money; it assembles both sides, including the fact that the record disagrees with her, without editorialising about who's right.

**SHARWIN**
half. and she's right that arjun should have told me

> **₹1,250 credited** to Latha's account, reason *"exam absence, agreed with admin"*, approved by you. Her August balance is ₹1,250.
>
> `[ Tell her ]`  `[ Tell her and offer makeups ]`

⚙ One `tally_line` with `kind='adjustment'`, a reason and an approver. Waiving, crediting, pro-rating and the free trial are all this one primitive (§6.4).

**↳ taps `[ Tell her and offer makeups ]`**

> Sent. She'll get the credit, the new balance, and an offer of two makeup slots in Beginners.
>
> On Arjun: parents telling the coach directly is the most common way my picture goes stale, and it's why the register asks "was this told to you in advance?" whenever someone's marked absent with no cancellation on record. Arjun answered it four times in July, so this one is him not passing something on, not a hole in the flow.
>
> `[ Fine ]`

**SHARWIN**
what do you know about me?

> About you:
> • You ask about unpaid fees most Monday mornings — so the Monday brief leads with money and carries the button
> • You'd rather have one message with everything than four as things happen
> • You call them *batches*, not classes, when you're typing quickly — I use your word back at you
> • You want to be told before parents are messaged in bulk, never after
>
> About Ace TT Academy:
> • Term fees go out on the 10th
> • Sunday camp runs on its own fee cycle
> • Court 3 is shared, so 9:30–11:30 Saturday clashes with Sub Junior
>
> `[ Something's wrong there ]`

⚙ §5 — *visible and editable*, and every one of those facts changes a behaviour. A fact that changes nothing is a diary entry.

**SHARWIN**
i don't mind bulk messages going out without asking me if it's just a reminder

> Noted — bulk **reminders** go without asking. Anything that changes a time, a fee or a coach still comes to you first.
>
> I've kept the old note rather than deleting it, so if you ever ask why I behave a certain way I can show you both and when they changed.

⚙ §5, §6.2 — a correction writes a **superseding** fact, never destroys the old one. "Why does it think that?" stays answerable.

---

**Design notes — A3**

- **The digest is written, not filled in.** It leads with the one thing worth thinking about, then compresses everything routine into two lines.
- **Uncertainty is stated at the size the data supports.** "At four families it could equally be coincidence" is what stops the digest becoming confident nonsense.
- **The bot never adjudicates money.** It presents the record, presents her account, and hands over three buttons.
- **Memory is a debugging surface.** "What do you know about me?" is trust, and it's also the fastest way to find out why the bot is behaving oddly.

---
---

# COACH

The coach gets a ladder of single questions, each at its right time, one at a time. Never a form when a tap will do. Never asked twice.

---

## C1 · Invite, a wrong detail, then the first real day

**Tests:** `CO-INVITE-CONFIRM` (§8.1) · the coach does not edit the catalog (§8.1) · `CO-DAY` → `CO-COMING` → `CO-REGISTER` ladder (§8.2) · one confirmation is enough (§8.2) · unprompted action (§4.1 rule 2)

---

**ARJUN** *taps Sharwin's forwarded link, WhatsApp opens with text prefilled, he sends it*
Hi, Sharwin added me at Ace TT

> Hi Arjun — I'm Class Manager, I handle scheduling for Ace TT Academy. Sharwin added you as a coach.
>
> Your classes:
> • **Mon/Wed/Fri · 6:30–7:30 pm** — Beginners, Green Park
> • **Sat · 8:00–10:00 am** — Advanced, Green Park
>
> `[ Looks right ]`  `[ Something's wrong ]`

⚙ §8.1 step 3. First run is **one** confirmation. Never asked for availability, a bio, a photo or a password.

**↳ taps `[ Something's wrong ]`**

> What's off?
>
> ≡ **List: What's wrong**
> › Wrong time
> › Wrong venue
> › That's not my class
> › Someone's missing from a class
> › Something else

**↳ taps `Wrong time`**

**ARJUN**
saturday is 8 to 9:30 not 10, we finish early now

> I've sent that to Sharwin — he owns the timetable, so I won't change it from here. As soon as he confirms, your Saturday updates and I'll tell you.
>
> Everything else looked right?
>
> `[ Yes, rest is fine ]`  `[ Something else too ]`

⚙ §8.1 — *the coach does not edit the catalog.* The correction routes to the admin. Said as a reason, not a refusal.

**↳ taps `[ Yes, rest is fine ]`**

> You're set. Here's what actually happens, so nothing surprises you:
>
> **Your next class is tomorrow, Wed, 6:30 Beginners — 12 players.**
> • Morning: your day, with headcounts
> • An hour before: I ask if you're coming. One tap, and I don't ask again
> • After: the register. `[ All present ]` is one tap for the normal day
>
> That's the whole thing. Anything else you can just type — *"running late"*, *"Aarav's out Monday"*, *"reached"* — no need to wait for me to ask.
>
> Worth pinning this chat.
>
> `[ Got it ]`

⚙ §8.1 step 4 — *proof, not promises*. And §4.1 rule 2 stated to the coach directly: the prompt is a convenience, not the interface.

---

🕐 **Next morning, 07:00**

> **Wednesday**
>
> • **6:30–7:30 pm** · Beginners · Green Park · **12 expected**
>
> `[ All good ]`  `[ Something's wrong ]`  `[ Mark someone out ]`

**↳ taps `[ All good ]`**

> 👍

⚙ Short. The bot doesn't reward a tap with a paragraph.

🕐 **17:30 — T-60**

> 6:30 Beginners, Green Park, in an hour. Coming?
>
> `[ Yes, I'm coming ]`  `[ Can't make it ]`  `[ Directions ]`

**↳ taps `[ Yes, I'm coming ]`**

> Got it. See you at 6:30.

⚙ **No T-30 nudge fires. No arrival prompt fires. No second question of any kind.** One confirmation is enough (§8.2), and `arrived_at` is never prompted.

🕐 **18:26**

**ARJUN**
reached

> Noted — you're at Green Park.

⚙ §8.2 — *arrival is never prompted but always accepted.* `arrived_at` set. Coverage now rests on the stronger claim. Sending it twice is a no-op because of the primary key, not because the model remembered.

🕐 **19:30 — class ends**

> **Beginners, 6:30 — register.** 12 on the roster.
>
> `[ All present ]`  `[ Take register ]`

**↳ taps `[ All present ]`**

> Marked, all 12. Parents get the outcome tonight.
>
> `[ Add a note about someone ]`

⚙ `[ All present ]` is a chat button because it's the majority case, and one tap beats loading anything (§8.2 step 5). The follow-up button teaches the next capability without announcing it (§4.3).

---

**Design notes — C1**

- **`[ Something's wrong ]` has to be first-class.** Half of coach onboarding failures are a wrong time nobody could report.
- **Silence after `[ Yes, I'm coming ]` is a feature.** A coach who gets nudged after confirming stops trusting every future message.
- **"Reached" with no prompt in front of it is the test of §4.1 rule 2.** If free text only works as an answer to a question, the bot is a form.
- **Solo variant:** if Sharwin were the only coach, C1 doesn't exist — no invite, no `CO-COMING`, no `CO-DAY`. He'd get one merged morning message. The register stays, because it's the meter and the coaching record (§18).

---

## C2 · Can't make it, and two coaches race for the cover

**Tests:** decline confirms before acting (§8.2) · cover offered only when the session would be *uncovered* (§6.3) · first tap wins, `CO-COVER-TAKEN` · running late relayed to parents (§9.2, §12.1) · escalation is about sessions, never people (§6.3)

---

🕐 **Friday 17:30 — T-60, Arjun**

> 6:30 Beginners, Green Park, in an hour. Coming?
>
> `[ Yes, I'm coming ]`  `[ Can't make it ]`  `[ Directions ]`

**↳ taps `[ Can't make it ]`**

> Just to be sure — **you're dropping 6:30 Beginners tonight**, 12 players.
>
> `[ Yes, I can't make it ]`  `[ No, I tapped by mistake ]`

⚙ §8.2 — the tap confirms first. Dropping a class must not be mis-tappable.

**↳ taps `[ Yes, I can't make it ]`**

> Understood. Nobody else is assigned tonight, so I'm offering it to Vikram now. You're out of it — I won't chase you again about tonight.
>
> Anything I should pass on? Not required.
>
> `[ Nothing ]`

⚙ Coverage is derived, not stored (§6.3). If a co-coach were still assigned, no offer would go out at all — the class runs on and that's information, not an alarm.

**ARJUN**
bike broke down sorry

> Passed to Sharwin, no blame attached. Get home safe.

---

**Simultaneously — Vikram's phone**

> **Cover needed tonight** — 6:30–7:30 pm, Beginners, Green Park. 12 players. Arjun can't make it.
>
> Your Intermediate is 7:30 at the same venue, so it's back-to-back rather than a clash.
>
> `[ Claim this session ]`  `[ Can't ]`

⚙ The bot volunteers the back-to-back fact because it's the thing that decides the answer. The offer goes to *other coaches* — Arjun, who just declined, is not asked again.

**↳ Vikram taps `[ Claim this session ]`**

> Yours — 6:30 Beginners, Green Park. 12 players, roster below.
>
> You're now doing 6:30 and 7:30 back to back tonight.
>
> `[ See the roster ]`  `[ Directions ]`

**And, had a third coach tapped a moment later:**

> Vikram took the 6:30 already. Nothing needed from you.

⚙ First tap wins; the rest are told it's taken (`CO-COVER-TAKEN`). The action row is consumed once, and the second tap finds it consumed — no model call is involved in either tap (§6.5).

**And to Sharwin, on the morning brief rather than as an interruption:**

> Vikram covered Arjun's 6:30 last night — Arjun's bike broke down. Nothing needed from you.

⚙ §4.1 rule 8 — this rides on a message already being sent. A resolved problem is not an interruption.

---

🕐 **Different Friday. Arjun taps nothing.**

**T-30:**

> Still need to know about 6:30 Beginners. If I don't hear from you in the next 15 minutes I have to tell Sharwin, so he has time to sort cover.
>
> `[ Yes, I'm coming ]`  `[ Can't make it ]`

⚙ `CO-NUDGE` says the quiet part out loud (§8.2 step 3). No guilt, just the consequence.

**T-15, to Sharwin — not to Arjun:**

> **6:30 Beginners tonight has no confirmed coach.** Arjun hasn't answered. 12 players expected.
>
> `[ Call Arjun ]`  `[ Offer it to Vikram ]`  `[ Cancel the session ]`

⚙ §6.3 — the escalation is about the **session**, not about Arjun. And §18's second suppression rule: never escalate about a person to that person, so Arjun is not chased further.

---

🕐 **Another day, 18:15 — free text, no prompt in front of it**

**ARJUN**
stuck in traffic, 15 min late

> Noted, 6:30 Beginners.
>
> Want the 12 parents told? Most of them are already driving over.
>
> `[ Tell them ]`  `[ No, I'll be quick ]`

⚙ `running_late` set. The bot only messages parents when it carries something they don't have (§9.2) — and it asks, because the coach knows whether 15 minutes is worth 12 messages.

**↳ taps `[ Tell them ]`**

> Told them: *"Ace TT — tonight's 6:30 Beginners starts about 15 minutes late, Arjun is on his way. Green Park as usual."*
>
> Sharwin's been told too.

---

**Design notes — C2**

- **The offer only fires when the session is genuinely uncovered.** A coach dropping out of a two-coach session must not trigger a scramble.
- **The cover race is a real concurrency case**, and it's resolved by the action row being consumed exactly once — no model at tap time.
- **Nobody is chased after they've said no**, and nobody is told about their own failure.
- **"Stuck in traffic" is a full sentence to a manager and gibberish to a form.** This is the shape of most real coach input.

---

## C3 · The register catches a bill that was about to be wrong

**Tests:** register page on the web surface (§8.2, §15) · the out-of-band repair (§8.2 — *the highest value catch-point*) · retroactive `cancelled_timely` and its money meaning (§6.4) · payables visible to the coach, own only (§8.1, §6.7) · Hinglish voice note resolved against the roster (§14.5)

**The scenario.** Aarav's dad told Vikram at the court last week that Aarav would miss Monday. Vikram forgot to pass it on. Aarav is **per-session** at ₹400 — so if he's just marked absent, he gets billed for a class cancelled seven days in advance. This is the exact damage §8.2 names.

---

🕐 **Monday 19:30**

> **Beginners, 6:30 — register.** 12 on the roster.
>
> `[ All present ]`  `[ Take register ]`

**↳ taps `[ Take register ]`** — signed link opens the register page

**The register page** — one screen, no login, whole roster visible:

| Player | Present | Late | Absent | Note |
|---|---|---|---|---|
| Aarav K | ○ | ○ | **●** | |
| Meera R | **●** | ○ | ○ | |
| Kiran S | ○ | **●** | ○ | *10 min late* |
| … 9 more | | | | |
| | | | | `Submit` |

**↳ submits**

> Marked: 10 present, 1 late, 1 absent.
>
> One thing before I bill it — **Aarav is marked absent and I have no cancellation on record.** Did anyone tell you in advance he wouldn't come?
>
> `[ Yes, told in advance ]`  `[ No, just didn't show ]`

⚙ §8.2 — *if a player is marked absent with no cancellation on record, one tap retroactively makes it timely.* This is the single highest-value question in the coach surface.

**↳ taps `[ Yes, told in advance ]`**

> Fixed — Aarav's Monday is a timely cancellation, so **he isn't charged the ₹400.** His dad won't get an "absent" message either.
>
> If parents tell you things like this at the court, just type it here whenever — you don't have to wait for the register.
>
> `[ Got it ]`

⚙ `attendance.status = 'cancelled_timely'`, so no `session` tally line is written (§6.4). The cancellation window only carries money meaning for `per_session` — same interface, different consequence.

---

🕐 **Wednesday 18:10 — voice note, Hinglish, no prompt**

**VIKRAM** 🎙 *0:09* — *"Kal ka class mein Aarav nahi aayega, aur Meera ko thoda late aana hai, uske exam hai"*

> I heard two things — check before I do anything:
>
> 1. **Aarav** — out of tomorrow's class
> 2. **Meera** — coming late tomorrow, exams
>
> `[ Both right ]`  `[ Just #1 ]`  `[ Fix something ]`

⚙ §14.5 — audio goes to the model as audio, and the roster is in context, so "Aarav" resolves against a player who actually exists rather than against a phoneme. **With audio there is no transcript for the human to check, so this read-back is the only verification surface** (§2.7).

**↳ taps `[ Both right ]`**

> Done.
> • Aarav — cancelled in time for tomorrow, not charged
> • Meera — noted as arriving late, headcount still 12
>
> Aarav's dad gets a confirmation. Meera's mum doesn't need one — she's the one who told you.
>
> `[ Nothing else ]`

⚙ §4.1 rule 9 — *roles are hats*. Nobody is told a thing they just said.

---

🕐 **Month end**

**VIKRAM**
how much am i owed this month

> **August · ₹18,400**
>
> • Beginners · 13 sessions × ₹500 = ₹6,500
> • Intermediate · 13 sessions × ₹500 = ₹6,500
> • Sub Junior · 4 sessions × ₹500 = ₹2,000
> • Cover for Arjun · 7 sessions × ₹500 = ₹3,500
>
> 37 sessions taken. Sharwin pays this out — I don't move money.
>
> `[ See the sessions ]`

⚙ §8.1 — pay is visible to the coach, **their own only**. A running total you can't check against a rate you don't know is not trustworthy. Arjun's pay is invisible here; that's an RLS boundary, not a UI choice (§6.7).

**VIKRAM**
what does arjun get paid

> That's between him and Sharwin — I only ever show you your own.

---

**Design notes — C3**

- **The absent-with-no-cancellation question is the highest-leverage single question in the product.** It converts a stale picture into a correct bill, at the one node that holds the information.
- **The register is a page, not twelve chat messages** — but `[ All present ]` never stops being one tap.
- **Voice notes get read back in the same shape as buttons**, because the alternative is a wrong name on a bill with no transcript to appeal to.
- **Refusing another coach's pay is one warm sentence, not an error.**

---
---

# CLIENT

Parents are ~95% of the humans this talks to. Every message has to be worth the interruption, and every mis-tap has to be survivable.

---

## L1 · Invite, first reminder, and a cancellation with scope

**Tests:** `CL-INTRO` proof instead of promises (§9.1) · `CL-REMINDER` (§12.1) · mis-tap protection before acting (§9.2) · *this session or every week?* (§9.2) · timely vs late cancellation (§6.4) · reschedule as the makeup (§9.2)

---

**LATHA** *taps Sharwin's broadcast invite, sends the prefilled text*
Hi Ace TT Academy

> Hi Latha — I'm the class manager for **Ace TT Academy**. Class updates and fees have moved here, so you're not chasing Sharwin on WhatsApp any more.
>
> **Meera's week:**
> • Mon, Wed, Fri · 6:30–7:30 pm · Beginners · Green Park
>
> I'll remind you the evening before, you can cancel with a tap, and your month's bill lives in this chat.
>
> `[ See Meera's schedule ]`

⚙ §9.1's first-contact rules: the recognised names lead, the bot says something only the real business could know, one *useful* button, and it's framed as continuity — "have moved here", never "introducing".

---

🕐 **Tuesday 16:30 — 14 hours before Wednesday's class**

> **Meera has Beginners tomorrow, 6:30 pm at Green Park.**
>
> `[ I'll be there ]`  `[ Can't make it ]`

**↳ taps `[ Can't make it ]`**

> Just checking, because this gives up her spot — **cancel Meera for tomorrow, Wed 6:30 Beginners?**
>
> `[ Yes, cancel ]`  `[ Never mind ]`

⚙ §9.2 — *a pocket mis-tap must never give away a seat.* `CL-CANCEL-CONFIRM` expires in an hour so a stale confirm can't fire days later.

**↳ taps `[ Yes, cancel ]`**

> Cancelled — just tomorrow, or every Wednesday from now on?
>
> `[ Just tomorrow ]`  `[ Every Wednesday ]`

⚙ **Scope is always asked** (§9.2). Guessing here either strands a child for a term or charges for a class they never intended to attend.

**↳ taps `[ Just tomorrow ]`**

> Done. Meera's out of Wednesday. You told me in time, so it doesn't count against her and the coach knows the headcount.
>
> Want her in another Beginners class that week instead?
>
> `[ Find a makeup ]`  `[ No need ]`

⚙ §4.3 — the natural next step as a button. §9.2 — *reschedule is the makeup*, which keeps this out of refund territory.

**↳ taps `[ Find a makeup ]`**

> Beginners also runs **Mon** and **Fri** at the same time. Next open one is **Friday 6:30**.
>
> `[ Put her in Friday ]`  `[ Show me next week ]`

**↳ taps `[ Put her in Friday ]`**

> She's in Friday 6:30. I'll remind you Thursday evening.

---

🕐 **A different week — the same tap, four hours before class**

**↳ taps `[ Can't make it ]`** at 14:30 for a 18:30 class

> Cancel Meera for today, 6:30 Beginners?
>
> One thing first, so it isn't a surprise: Ace TT asks for **24 hours' notice**, and this is about 4 hours. She's on a monthly fee, so **this doesn't change what you pay** — it just means it's recorded as a late cancellation rather than a timely one, and the coach gets the headcount either way.
>
> `[ Yes, cancel ]`  `[ Never mind ]`

⚙ Same interface, different consequence (§6.4). On a per-session enrollment the same message would say *"this one is chargeable at ₹400"* — the honest thing, said before the tap, not after.

---

**Design notes — L1**

- **Every destructive tap gets one confirmation, and it names what's being destroyed.** "Cancel Meera for tomorrow, Wed 6:30" — never "Are you sure?".
- **Scope is a question, never an inference.**
- **The window rule is explained in money terms at the moment it applies**, not in a policy paragraph at signup.
- **The makeup offer turns a cancellation into a rebooking**, which is the difference between churn and a scheduling hiccup.

---

## L2 · The month's bill, a challenged line, and paying by UPI

**Tests:** `CL-TALLY` line by line (§9.2) · a parent disputing a specific line (§4.2) · escalation carrying the record (§14.8) · Rail 1 payment (§11.5) · GPay screenshot parsed into a payment record (§14.5) · `CL-RECEIPT` (fixed, §12)

---

🕐 **1 September, morning**

> **Ace TT Academy · August**
>
> Meera — Beginners
> • Monthly fee, August — **₹2,500**
> • Credit, exam absences (agreed with Sharwin) — **−₹1,250**
>
> **Due: ₹1,250**
>
> `[ Pay now ]`  `[ See the lines ]`

⚙ `CL-TALLY` is a **fixed** row — it can be reworded and merged, never suppressed (§12). Every line is shown in the description the parent will recognise.

**LATHA**
what is the 1250 credit, i thought sharwin said half

> That *is* the half — ₹1,250 off ₹2,500, so you're paying half the month. The credit shows as its own line rather than a smaller number, so you can see what happened rather than take my word for the total.

**LATHA**
ok. but you charged me for 2 august, she was sick that day also

> Checking. **Meera is on a monthly fee**, so individual days don't add or remove anything — the ₹2,500 was for August whether she came 12 times or 2. The credit Sharwin agreed already covers the exam absences, and 2 August is inside that stretch.
>
> If you think the credit should be bigger, that's Sharwin's call and I'll ask him.
>
> `[ Ask Sharwin ]`  `[ No, that's fine ]`

⚙ §4.2 `money-dispute` — the bot explains the mechanism, never argues, and never re-decides money an admin already decided. The escape hatch is one tap away (§14.8).

**↳ taps `[ No, that's fine ]`** → `[ Pay now ]`

> **₹1,250 to Ace TT Academy.**
>
> `[ Pay by UPI ]` — opens your UPI app with the amount filled in
>
> Or pay however you normally do and send me a screenshot — I'll read it.

⚙ §14.6 — every link is a button; nothing URL-shaped is pasted into message text.

**↳ pays in GPay, comes back, sends the screenshot** 📷

> Read from your screenshot:
> • **₹1,250** to acett@okhdfcbank
> • 1 Sep, 10:42
> • UTR 5289 4471 0033
>
> `[ That's the one ]`  `[ Not this payment ]`

⚙ §14.5 — a parsed payment is a **proposal**. And on the admin's side this turns Rail 1 reconciliation from blind attestation into confirming something already read.

**↳ taps `[ That's the one ]`**

> Sent to Sharwin to confirm. I'll message you the moment he does — usually same day.

🕐 **13:10**

> **Received — ₹1,250, 1 September.** August is settled, nothing outstanding.
>
> `[ See the tally ]`

⚙ `CL-RECEIPT`, fixed. Note the honesty ladder: at 10:44 the bot said *sent to Sharwin*, not *paid*. It only said **received** once `confirmed_at` existed (§2.4).

---

**And on Sharwin's side, at 10:44:**

> Latha sent **₹1,250** — UPI, UTR 5289 4471 0033, 1 Sep 10:42. Screenshot attached. That clears her August.
>
> `[ Confirm received ]`  `[ Not in my account ]`

**↳ taps `[ Confirm received ]`** — one tap, no typing, no amount to re-enter.

---

**Design notes — L2**

- **A credit is a line, not a smaller number.** Parents check arithmetic; hiding the mechanism creates the dispute it was meant to avoid.
- **"You're on monthly" has to be explained in the same message as the refusal**, or it reads as stonewalling.
- **The screenshot is the Rail 1 unlock.** Reading amount + UTR + timestamp turns the admin's job into one tap.
- **Three different words for three different states** — sent, sent to Sharwin, received — and the bot never uses a stronger one than it has evidence for.

---

## L3 · Two children, a coach running late, and a parent who's had enough

**Tests:** merging (§12 — *three things happened to one parent today, so they get one message*) · `CL-SESSION-TROUBLE` and only when it carries something new (§9.2) · `CL-OUTCOME` as something to fix, not a verdict (§9.2) · escalation on anger with transcript attached (§14.8) · per-person timing from observed behaviour (§8.2)

**The scenario.** Rajesh has two children — Aarav (Beginners, Mon/Wed/Fri) and Nithya (Advanced, Sat). Today: Aarav's reminder is due, Nithya's Saturday moved, and the September tally is out.

---

🕐 **Tuesday 16:30 — one message, not three**

> **Ace TT Academy — three things, all in one:**
>
> 1. **Aarav** has Beginners tomorrow, 6:30 pm, Green Park
> 2. **Nithya's** Saturday Advanced has moved to **8:00–9:30 am** — it now finishes half an hour earlier
> 3. September's bill is ready — **₹4,900** for both
>
> `[ Aarav's coming ]`  `[ Can't make it ]`  `[ Pay ₹4,900 ]`

⚙ §12 — **merge**. Three catalog rows fired for one person on one day; the bot decides they're one message. Buttons still cover the actions each of them needed.

**↳ taps `[ Aarav's coming ]`**

> 👍 Nothing else needed.

---

🕐 **Wednesday 18:32 — the class should have started**

> **Tonight's 6:30 Beginners is starting about 15 minutes late** — Arjun is on his way to Green Park.

⚙ `CL-SESSION-TROUBLE`. Compare with the message that does **not** exist: there is no "class is starting" and no "the coach has arrived". A parent standing at the court doesn't need telling class started — that's the clearest §2.8 failure in the product (§9.2, §12.1). The bot only speaks when it carries something the parent doesn't have.

**RAJESH**
this is the third time this month

> You're right — 3 of Aarav's 12 sessions this month started late. I've told Sharwin, with those dates.
>
> `[ Talk to Sharwin ]`  `[ Leave it with him ]`

⚙ The number is checked against the record before agreeing. Agreeing with a complaint the data doesn't support is worse than disagreeing.

---

🕐 **19:35 — after class**

> **Aarav — present tonight.** Arjun's note: *"backhand is coming along, keep him on the multi-ball drill."*

⚙ `CL-OUTCOME`. Presence is one line. Coach notes are the reason parents read these at all.

**And on a night Aarav is absent:**

> **Aarav missed tonight's 6:30 Beginners.** He's on a monthly fee, so nothing changes on your bill.
>
> `[ Rebook him ]`

⚙ §9.2 — an absence arrives as *something to fix*, not a verdict.

---

🕐 **Saturday 07:50 — ten minutes before Nithya's class**

**RAJESH**
we are at the stadium and there is no coach. nobody has told us anything. this is completely unprofessional, second week in a row

> You're right and I'm sorry — Saturday Advanced has no coach this morning and you should have heard that last night, not from an empty court.
>
> I've put this in front of Sharwin now with everything from this chat, including last Saturday. He has your number.
>
> I'm not going to try to handle this myself.
>
> `[ I want a call ]`  `[ Wait for Sharwin ]`

⚙ §14.8 — anger is an **automatic** escalation trigger. The bot hands off with the transcript attached, doesn't apologise in a loop, doesn't offer a makeup as if it were a fix, and says plainly that it's stepping back (§4.1 rule 10).

**To Sharwin, immediately — this interrupts, because it should:**

> **Rajesh is at Green Park with Nithya and there's no coach.** Saturday Advanced, 8:00. Second week — 9 Aug was also uncovered.
>
> He's angry. His words: *"completely unprofessional, second week in a row."* Full chat attached.
>
> 6 other families are expected at that session.
>
> `[ Call Rajesh ]`  `[ Message all 7 families ]`  `[ Cancel the session ]`

---

🕐 **A month later — the bot changes its own timing**

> Small thing: you've told me you can't make it four times, and three of them were the same evening as the class. I'm going to start reminding you **the morning before** instead of the evening before, so you get more room.
>
> `[ Fine ]`  `[ Leave it as it was ]`

⚙ §8.2 — per-person timings set from observed behaviour, overriding the academy default in `person.settings`. **And the bot can say why**, which is the difference between a manager and a schedule. It rides on a message already going out (§4.1 rule 8).

---

**Design notes — L3**

- **Merging is what stops a two-child family getting eight messages a week.** It's also the clearest demonstration that the catalog is a set of *moments*, not a set of messages.
- **The bot's silence during a normal class is a designed feature**, and the one message it does send is the one the parent couldn't already see.
- **Anger ends the bot's turn.** No recovery attempt, no discount offered on its own authority, no fourth apology.
- **Changing a reminder time and explaining the reason** is the smallest possible demonstration that something is paying attention.

---
---

# PROSPECT / UNREGISTERED

The cheapest acquisition path in the product — the stranger initiates, so the window is open, free, and carries no template, tier or block cost. It's also the highest-stakes conversation in the product.

---

## P1 · QR code at the court to a booked trial

**Tests:** cold inbound routed to the right business by prefilled text (§10.1) · `profile.name` used for free (§10.1) · **a conversation, not a wizard** (§10.1 step 3) · `book_trial` as one transactional operation · auto-confirmed with no admin gate, admin gets an undo (§10.1 step 5)

---

**RAJESH** *scans the QR taped to the court noticeboard, WhatsApp opens with text prefilled, he sends it*
Hi Ace TT Academy

> Hi Rajesh! I'm the class manager for **Ace TT Academy** at Green Park.
>
> Coaching runs six days a week — beginners through advanced, kids and adults. First class is free.
>
> `[ Book a free trial ]`  `[ See the schedule ]`  `[ Talk to Sharwin ]`

⚙ Routing is by the prefilled academy name — no token infrastructure (§10.1). "Rajesh" came free off the inbound webhook's `profile.name`, which turns two questions into one. `contact.state = 'prospect'`.

**RAJESH**
my daughter is 14 and has played for three years, is your beginners class right for her?

> Probably not — Beginners is mostly first-timers, 7 to 11. Three years in, she'd be bored inside a session.
>
> Two that would fit:
> • **Intermediate** · Mon/Wed/Fri 7:30–8:30 pm — mixed ages, most have 2–4 years
> • **Advanced** · Sat 8:00–10:00 am — longer session, more match play, a couple of state-level players
>
> Honestly, at 14 with three years, she could sit in either. What's she after — keeping it up, or competing?

⚙ **This is the whole point of §10.1.** A scripted name → age → pick-a-class wizard has nowhere to put this question. The bot holds the catalog and the schedule, so it answers like someone who works there — including telling a prospect that the thing they asked about is wrong for them.

**RAJESH**
she wants to compete, played for her school

> Then Advanced, and Saturday is the one that matters — it's the session with match play.
>
> Worth knowing before you commit: it's **8 to 10 am**, which is a real Saturday morning, and it's ₹3,500/month against ₹2,500 for the others.
>
> First one's free either way.
>
> `[ Book Saturday ]`  `[ Come to Intermediate first ]`  `[ Where is it? ]`

**↳ taps `[ Book Saturday ]`**

> Two things and she's in — her name, and her age is 14?

**RAJESH**
Nithya, yes 14

> **Booked — Nithya, 14, Saturday Advanced, 8:00–10:00 am, this Saturday the 23rd.** Free trial, nothing to pay.
>
> Green Park Indoor Stadium, Court 3. Bring her own bat if she has one, we have spares if not.
>
> `[ Directions ]`  `[ Add to calendar ]`

⚙ `book_trial(...)` — one transactional operation creating `account`, `player`, a trial `enrollment` and the booking, then messaging the parent. **Auto-confirmed, no admin gate** (§10.1 step 4). All of it commits or none of it does, and if it rolls back, nobody was messaged (§14.2.1).

---

**On Sharwin's phone, after the fact:**

> **New trial booked** — Nithya, 14, Saturday Advanced 8:00, this Saturday. Came in off the QR at the court.
>
> Her dad Rajesh asked about competing; she's played three years for her school.
>
> `[ Message them ]`  `[ Undo ]`

⚙ `AD-NEW-TRIAL` is **fixed** (§12) — the admin always learns about a new human in their business. §10.1: *zero friction on the funnel; the admin retains an undo rather than a gate.* The one line of context is what lets Sharwin be useful on Saturday.

---

🕐 **Friday evening — the trial reminder, and nothing else in between**

> **Nithya's trial is tomorrow, 8:00 am, Green Park Court 3.**
>
> `[ We'll be there ]`  `[ Can't make it ]`

⚙ Between booking and the reminder, the bot sends **nothing**. No "just checking you're excited", no tips, no countdown. §4.1 rule 1.

---

**Design notes — P1**

- **Step 3 is the product; the other four steps are plumbing.** The bot's willingness to say "probably not, she'd be bored" is the entire difference between this and a form.
- **The price and the awkward hour are volunteered, not buried.** A prospect who finds out on Saturday morning doesn't come back.
- **The admin is told what the parent said**, not just what was booked.

---

## P2 · Numbers the system doesn't know

**Tests:** inbound with no academy in it (§10.1 routing) · a second parent on an unregistered number resolved by name + one confirming question (§9.1) · a forwarded invite from a stranger · a genuine wrong number · money-shaped rows never routed to an unverified person (§6.7)

---

**Case A — no prefill, no idea who they want**

**UNKNOWN NUMBER**
hi

> Hi! I'm Class Manager — I handle scheduling for a few coaching businesses, so I need to know which one you're after.
>
> If you have their link or QR code, tapping it tells me. Otherwise just type the name.

**UNKNOWN**
ace tt

> **Ace TT Academy**, Green Park — table tennis. That the one?
>
> `[ Yes ]`  `[ No, different one ]`

⚙ Routing is a functional problem, not a security one (§10.1). One question, no tokens, no "please contact your administrator".

**↳ taps `[ Yes ]`** → normal `PR-WELCOME` from here.

---

**Case B — the second parent, number never registered**

**UNKNOWN NUMBER**
Hi, this is Meera's father. My wife gets the messages but I do the drop-offs, can I get them too?

> I have a **Meera R** in Beginners at Ace TT Academy, Mon/Wed/Fri 6:30. If that's your daughter, I can send you the class messages on this number too.
>
> One check first, since this number's new to me: **what's her mother's first name?**

⚙ §9.1 — *identity is the phone number*, so a number Step 1 never saw resolves by academy name plus **one confirming question**. Not a security theatre interrogation, and not a free pass either.

**UNKNOWN**
Latha

> That's her. You're on the list for Meera's class messages — reminders, changes, and how she did after class.
>
> **Fees and payments stay on Latha's number only.** If you want those moved or added here, she or Sharwin can tell me.
>
> `[ See Meera's schedule ]`

⚙ §6.7 — money-shaped rows are the tightest boundary in the model. A verified-enough contact gets schedule; it does not get the tally on the strength of one answered question.

---

**Case C — a forwarded invite from someone with no child there**

**UNKNOWN NUMBER**
Hi Ace TT Academy — my friend forwarded me this, my son is 7, do you take that age?

> Yes — Beginners is mostly 7 to 11, Mon/Wed/Fri 6:30–7:30 pm at Green Park. ₹2,500 a month, first class free.
>
> `[ Book a free trial ]`  `[ See the schedule ]`  `[ Talk to Sharwin ]`

⚙ The forwarded invite carried the academy name, which is all the routing needed. This person is a **prospect**, not a client, and gets the prospect path — the bot doesn't try to match them to an existing family.

---

**Case D — genuinely the wrong number**

**UNKNOWN NUMBER**
is this dr rekha's clinic

> No — this number is Class Manager, scheduling for coaching classes. Nothing to do with a clinic, sorry.
>
> If you were looking for one of the businesses I handle, tell me the name and I'll take you there.

⚙ One short, human reply, and then **nothing**. No follow-up, no "in case you change your mind" — that's a proactive message nobody would have asked for (§2.8).

---

**Design notes — P2**

- **"Which business?" is asked in one sentence and never again**, because the number is shared and this is the cost of that trade-off (§16.3).
- **Second parents are common and must not require the admin.** One confirming question is the right amount of friction.
- **Schedule and money are different trust tiers**, and the bot draws the line explicitly rather than silently.
- **The wrong number gets a polite dead end, not a funnel.**

---

## P3 · The prospect who doesn't convert

**Tests:** the bot answering hard questions it actually holds the data for · asking for a human on request (§14.8) · quiet by default when a prospect goes cold (§4.1 rule 1) · out-of-window contact as a **window-opener** (§14.7) · no marketing category (§16.2)

---

**PRIYA** *taps the link in Ace TT's Instagram bio*
Hi Ace TT Academy

> Hi Priya! I'm the class manager for **Ace TT Academy** at Green Park.
>
> `[ Book a free trial ]`  `[ See the schedule ]`  `[ Talk to Sharwin ]`

**PRIYA**
Do you have anything on Sundays? Weekdays are impossible for us.

> No — Sunday is the one day nothing runs. Six days, Monday to Saturday.
>
> The only non-weekday option is **Saturday**: Advanced 8–10 am, Sub Junior 10–11 am.
>
> `[ Tell me about Sub Junior ]`  `[ Ask Sharwin about Sunday ]`

⚙ The bot holds the schedule, so "no" is available immediately and stated plainly rather than deflected into a callback (§4.1 rule 10).

**PRIYA**
He's 9 and has never played. Sub junior ok? And is it 1 hour only, that seems short

> Sub Junior is right for a 9-year-old starting out — that's exactly who's in it.
>
> One hour is deliberate at that age; it's the same hour Beginners gets on weekdays, so he wouldn't be getting less. If he takes to it, most kids move to the Mon/Wed/Fri Beginners slot within a couple of months — that's three hours a week.
>
> ₹2,500 a month, first class free.
>
> `[ Book Saturday ]`  `[ Talk to Sharwin ]`

**PRIYA**
let me discuss with my husband

> Of course. The link's here whenever you want it — I won't chase you.

⚙ **And it doesn't.** No follow-up at 24h, no "still interested?", no drip. §4.1 rule 1 is at its most tempting exactly here, which is why it's a rule.

---

🕐 **Nine days later — Sharwin, on his own initiative**

**SHARWIN**
did anyone enquire about sundays recently

> Three in the last two months, all wanting weekends:
> • **Priya**, 5 Aug — 9-year-old, never played, weekdays impossible
> • **Anand**, 22 Jul — two kids, 7 and 10
> • **Fatima**, 14 Jul — adult beginner
>
> Sub Junior (Sat 10–11) has room for all of them and none of them booked.
>
> `[ Message the three ]`  `[ Leave it ]`

⚙ A read the model authors over the schema (§14.2). Scope shown. This is the admin *pulling* — the bot never pushed a lead list at him.

**↳ taps `[ Message the three ]`**

> These three are outside the 24-hour window, so it goes as a template. That means it has to be short and it can't be a pitch — the job is to get one useful tap, and then we can talk properly for free.
>
> Draft:
>
> *Ace TT Academy: you asked about weekend classes. Sub Junior, Saturdays 10–11 am, has space this month. Reply to hear more.*
>
> `[ Send to all 3 ]`  `[ Edit ]`  `[ Just Priya ]`

⚙ §14.7 — out-of-window messages are **window-openers**, deliberately simple. §16.2 — the parameters carry real content ("weekend classes", "Saturdays 10–11") because a generic *"you have an update"* is the pattern Meta marks as marketing, and a marketing classification on a shared number costs everyone.

**↳ taps `[ Send to all 3 ]`**

> Sent to 3. I'll tell you who replies. If nobody does, that's the end of it — I won't send a second one.

**PRIYA, two hours later**
Ok we can do saturdays

> Good — I'm back in normal chat now, so ask me anything.
>
> **Sub Junior, Saturday 10–11 am, Green Park.** First one free.
>
> `[ Book this Saturday ]`  `[ Book next Saturday ]`  `[ Where is it? ]`

⚙ One tap opened the window, and everything after it is free and rich (§16.1). That's why the template's only job was to earn the reply.

---

**Design notes — P3**

- **"No, we don't do Sundays" in the first reply is worth more than three messages of hedging.** A prospect who gets a straight answer comes back; one who gets deflected doesn't.
- **The non-conversion is respected completely.** No nurture sequence exists in this product.
- **Re-contact is admin-initiated, batched, and honest about being a template.** The bot explains *why* the message is short, which is also how the admin learns not to ask for a paragraph.
- **One reply flips the economics**, and the bot's copy is shaped by that fact rather than by what it wishes it could say.

---
---

# What these twelve cover

| Spec area | Where it's exercised |
|---|---|
| Nothing sent during onboarding (§2.6) | A1 |
| Parsed input read back before acting (§2.7, §14.5) | A1, C3, L2 |
| Effect computed before commit (§2.3, §14.2) | A2 |
| Multi-step consequences in one transaction (§2.5, §14.2.1) | A2, P1 |
| Sending ≠ delivered (§2.4) | A2, L2 |
| Would this person have asked for it? (§2.8) | L3, P3, C2 |
| Quiet by default (§4.1) | P1, P3 |
| Prompt is a convenience, not the interface (§4.1) | C1, C2, C3 |
| Follow-up buttons (§4.3) | everywhere |
| Memory visible, editable, acted on (§5) | A3, L3 |
| Rate units and their money meaning (§6.4) | A1, C3, L1, L2 |
| Adjustments as one primitive (§6.4) | A3, L2 |
| RLS boundaries felt by a user (§6.7) | C3, P2 |
| Admin undo that corrects the right people (§7.2) | A2 |
| Coach ladder, one confirmation (§8.2) | C1, C2 |
| Out-of-band repair at the register (§8.2) | C3 |
| Coach churn reusing uncovered escalation (§8.3) | A2 |
| Cover race, first tap wins (§8.2, §12.3) | C2 |
| Scope always asked (§9.2) | L1, A2 |
| Mis-tap protection (§9.2) | L1, C2 |
| Merging catalog rows (§12) | L3 |
| Synthesized digest with grounding rules (§10.2) | A3 |
| Conversation, not a wizard (§10.1) | P1, P3 |
| Self-scheduled `agent_task` (§13.1) | A2 |
| Escape hatch on anger (§14.8) | L3, L2 |
| Window vs template economics (§14.7, §16.1) | P3, A1 |
| Web surface as an upgrade, never a gate (§15, §14.6) | A1, A3, C3 |
| Solo case suppression (§18) | C1 (noted) |

**Not covered here, and worth writing next:** a full dunning ladder to admin escalation, a per-package (10-class) parent asking how many are left, a two-academy tenant-isolation transcript, an opt-out and its `AD-OPT-OUT`, and a delivery-failure repair loop.

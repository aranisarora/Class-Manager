# `worlds/`

**A world file is what the database looks like the moment the admin finished onboarding.**
That is the whole idea. You are writing down the business the owner just finished describing to
the bot — its classes, its coaches, who is already on the books and what they are in — and the
drive starts from there.

```bash
npm run sim                                    # blank: an owner, a phone, nothing else
npm run sim -- --world worlds/multi-coach.json
npm run sim -- --world settled-tennis          # the .json and the worlds/ are optional
npm run sim -- --world '{"coaches":3,"clients":5}'   # inline, for a one-off
```

`blank` is the default and it is the moment *before* the setup conversation: the owner exists
and nothing else does. A world with no classes stays at `onboarding_state = 'setup'`, because
`app.guard_go_live()` refuses to switch the reminders on over an empty timetable — there would
be nothing for them to be about.

## The shape

Everything is optional. `{}` is a valid world.

```json
{
  "name": "Smash Badminton Academy",
  "category": "badminton",
  "timezone": "Asia/Kolkata",

  "admin": { "name": "Nisha Balakrishnan", "coaches": true },

  "coaches": [
    { "name": "Arjun Shetty", "pay": 600, "unit": "per_session" },
    "Priya Nair"
  ],

  "classes": [
    { "name": "Under-10 Beginners", "days": ["mon", "wed"], "from": "16:30", "to": "17:30",
      "rate": 1500, "unit": "per_month", "coaches": ["Arjun Shetty"] }
  ],

  "clients": [
    { "name": "Divya Rao",
      "children": [{ "name": "Anika Rao", "class": "Under-10 Beginners" }] },
    { "name": "Fatima Ansari", "class": "Evening Adults" },
    { "name": "Sunil Rao" }
  ],

  "prospects": ["Kavita Shah", { "name": "Farah Sheikh" }]
}
```

| field | means |
| --- | --- |
| `name` | The business. A run token is appended, so parallel drives and `gc` still work. |
| `category` | `"chess"`, `"swimming"`. **Display only** — it changes a label and nothing else. |
| `admin.coaches` | `true` gives the owner a `coach` row as well as an admin one. |
| `coaches` | A count, a list of names, or a list of objects. `pay` needs `unit`; omit both and the pay is untracked, which is a real state. |
| `classes[].days` | **Names, never numbers** — `sun mon tue wed thu fri sat`. One slot per day, all at the same hour. |
| `classes[].coaches` | By name. Omit and coaches are dealt round-robin; `[]` leaves it uncovered. |
| `clients[].children` | Each child, and the class they are in. |
| `clients[].class` | For a client who is the **learner themselves** — an adult beginner. Never with `children`. |
| `clients[].owes` | Rupees carried in from before. Negative is a credit. |
| `prospects` | People who have messaged but bought nothing. |

## Enrolment is stated on the person

A class does not carry a register. A child carries their class.

```json
{ "name": "Sanjay Gupta", "children": [
    { "name": "Ishaan Gupta", "class": "Evening Batch" },
    { "name": "Riya Gupta",   "class": "Morning Juniors" } ] }
```

There used to be an `"enrolled": 3` on a class, and three was ambiguous. It dealt children from
a cursor shared across the whole class list, so *which* three you got depended on the order the
classes happened to be written in, and the wrap could seat one child in two classes without
saying so. You could not read the file and know who was in what — which is the only thing a
fixture is for. `enrolled` is now **refused by name**, not ignored: a spec still carrying it
means somebody's registers, and dropping them quietly would build a business whose classes are
empty and whose file says they are not.

A count never invents a relationship. `"clients": 6` is six people on the books and enrolled in
nothing. A child with no `class` is on the books and in nothing. Both are real states, and both
have to be sayable without inventing an enrolment to fill them.

## Who the people are, in the same file

Any person may carry a `seat` block. This is what makes a world worth driving rather than just
building — a generated brief knows the timetable, but only you know why somebody is messaging
today.

```json
{ "name": "Divya Rao",
  "children": [{ "name": "Anika Rao", "class": "Evening Batch" }],
  "seat": {
    "about": "Anika has come for a year with no trouble, which is why trouble would rattle you.",
    "goals": ["Find out whether Anika is charged for the session she missed while ill."],
    "voice": "Short, polite, and you apologise for taking up time you are paying for.",
    "redLines": ["Being charged for something nobody warned you about."],
    "life": { "3": "Anika has a fever and is not going tomorrow. You have told nobody yet." }
  } }
```

| field | means |
| --- | --- |
| `about` | Extra context in their own frame, **added after** the derived facts. |
| `goals` | What they want. Appended to the goals their role already has. |
| `voice` | How they type. **Replaces** the role's default. |
| `redLines` | What would make them complain, escalate or leave. |
| `life` | What happens **to** them, keyed by day number. Day 1 is a Monday. |

Everything except `voice` is *added* to what the world derived, and that is deliberate. The
facts a person knows about their own business — their classes, their children, their pay unit —
stay derived from the spec, so nothing written here can make somebody describe a business that
was not built. That failure has been paid for once: a coach told his batch ran Monday and
Thursday, in a world that ran Monday and Wednesday, produced a turn that read as a product
defect and was a harness defect. `voice` is the exception because how somebody types contradicts
no row.

`life` has no derived half at all — a generated life event would be invention dressed as
circumstance — so a world file is the only place one can come from.

## What happens to the business during the week

A world file is a **moment**. What happens next lives in [`events/`](../events/README.md), and
a world may carry its own in a `week` block when its weather is part of its identity — a
monsoon academy, one that empties in exam season:

```json
{ "name": "Coastal Cricket Academy",
  "classes": [ "…" ],
  "week": {
    "about": "It rains here.",
    "chaos": { "washout": 0.15 },
    "events": [ { "what": "absent", "day": 4, "who": "Anika Rao", "why": "a fever" } ] } }
```

`week` and `--events <file>` compose — the world's own is the base, the flag is laid over it —
so one scenario still points at any business and one business can still be run through six
scenarios. That is the reason the two are separate files at all.

It is the mechanical half of what `life` is the narrative half of, and the half `life` could
never be: a `life` string is one person's prose and nothing checks it against anything, so
"Anika has a fever and is not going tomorrow" left her coach's register untouched and her coach
free to invent it. An `absent` is resolved against the real session and the real roster, told to
her coach after the class and to her mother in her own words, and written into `truth.json`
where `npm run truth` can put it beside what the product ended up believing.

Every rule about the shape lives in `events/README.md` and in `scripts/_events.ts`. This file
carries the block through untouched: a second copy of those rules is how the block and the flag
come to disagree about what a `lag` needs.

## It refuses; it never repairs

A hand-written fixture usually fails silently or not at all. `"coachs": 4` is not four coaches,
it is zero coaches and no message. `"days": ["tues"]` is not Tuesday. Two active classes with
one name are **one** class, because `class_academy_name_active_key` is unique on the active name
and the second insert is swallowed.

So every one of these stops the build before it costs anything, naming the path and the value:
an unknown key at any level, an unknown day name, a day given as a number, a coach who is not in
the file, a child put in a class this world does not run, the same child twice, a client who is
both a parent and a learner, two people sharing a name, a negative count, a time that runs
backwards, and `enrolled`.

Nothing is created when a spec is refused.

## Phone numbers are not yours to choose

Every number is derived from the academy id, the admin's included. Every tenant shares one
sender and §10.1 resolves an inbound by the pair `(from, sender)` — a number held by two
academies matches two contacts and resolves to **neither**, so the message is never delivered
and nothing raises an error. Two drives running at once is the ordinary case here, so the
numbers cannot be a free choice.

## What ships

| file | |
| --- | --- |
| `blank.json` | `{}`. The owner and nobody else — the default, and the moment before onboarding. |
| `settled-tennis.json` | Ace Tennis Academy: the owner also coaches, two coaches, four classes, four families, five children, one account in arrears. |
| `multi-coach.json` | Four coaches, six clients, the admin also coaching, an adult learner, and a coach nobody has given a class to. |
| `solo-coach-group.json` | Kamath Badminton: one man running the whole thing. He coaches all four group classes himself, twelve families, fourteen teenagers between 13 and 16, two accounts in arrears and three prospects. Every seat carries a `voice`, and they are written for the input this product will actually meet — a coach who is not a technical person, parents typing between meetings, and requests for things nobody built: message my son directly, send it to all the parents, email me a receipt, make a group. |
| `new-swim-school.json` | Blank but for its owner, and the owner has no script. Kavitha Reddy, 34, ex-competitive swimmer who has just started her own school and has never used software for any of it. What her classes are, what they cost, who is in them and what goes wrong this week are all hers to invent. |
| `new-cricket-academy.json` | Blank but for its owner. Imran Qureshi, 48, twenty years of a paper register, did not ask for this and checks every number twice. |
| `new-dance-school.json` | Blank but for its owner. Ananya Ghosh, 50, running her classes out of her head, a notebook and one enormous WhatsApp group. |

## Invented numbers still cannot collide

A person who improvises their business improvises phone numbers too, and models reach for
`9876543210` with striking consistency. That matters here: `inboundFromContact` resolves a
contact and then hands `(fromPhone, senderPhone)` to the ordinary ingest path, so a number held by
two academies on one shared sender resolves to **neither** — the message is never delivered and
nothing raises an error.

So each `new-*` world tells its owner which block their people's numbers fall in — `+91 88010 1…`,
`+91 88020 2…`, `+91 88030 3…` — and that is the only fact about the outside world any of them is
given. It is a fact about *phones*, which this harness has always owned ("Phone numbers are not
yours to choose", below), and not a fact about the business, which is the whole point of a sketch.

**A number they *attach* never needed that rule.** Every seat can share a contact card —
`live.ts share <who> "<name>"` for a human, an `attach` field on the move for an agent — and the
names come from `lib/phonebook.ts`, an address book derived from the academy's own id. A persona
is shown the names and never the numbers, which is why the two facts cannot contradict each
other: the block sentence is about what to *type*, and there is nothing to type when you tap a
name. It also means the case people worry about — one person shared into two academies, enrolled
in both, unreachable from either — cannot arise by accident, because two academies are never
offered the same number in the first place.

It still means **one of these files cannot be driven twice simultaneously**: two runs of the same
world draw from one block. Change the block, or drive a different world.

## A world may state the SHAPE and let the person invent the values

The three `new-*` worlds are written this way, and the argument for it is measured. Every other world here writes a `life` event that hands the
owner their own timetable — days, times, prices — and the seat then reads it out. Measured on
`2026-08-21-05-08-sim-5bfa`, the owner's first message was that paragraph compressed: every age
band, every day, every price, nothing added and nothing forgotten. That is a **dictation**, and
onboarding is the one conversation where the fumbling is the thing being tested.

Taking the facts out costs less than it looks like it should, because of an asymmetry. Facts the
owner *creates* — class names, days, prices — become rows the moment the product writes them, and
from then on the rows are the ground truth a judge reads against. Facts that must *pre-exist* —
arrears, who has been attending, what was agreed last month — cannot be improvised without
contradicting rows that already exist. **A blank world is almost entirely the first kind**, which
is why this works here and would be dangerous against `settled-tennis`: a coach who invents his
own batch days is the harness failure that cost twenty-four corrections on 20 Aug.

What it bought, in four turns and ₹1.04: a realistic opener (*"hi need to set up my classes on
here"*) with the details arriving only after the product asked for them, and **F-CC** — a
commercial term the product invented, which three full scripted weeks and 170 turns had not
surfaced. A persona executing a written errand does not audit what the product volunteers. A
persona who owns the business does. (That run, `2026-08-21-05-59-sim-dcvo`, drove an earlier
`sketch-dance.json`; the three worlds above are now written the same way and it is gone.)

**It is not free.** Two runs of a sketch world build two different academies, so the arms of an
`npm run ab` would differ by the business itself and the comparison would be void. Hold the facts
still for an A/B; let them go when the question is what a week is actually like.


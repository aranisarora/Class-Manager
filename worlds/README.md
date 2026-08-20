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

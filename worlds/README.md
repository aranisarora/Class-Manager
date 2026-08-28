# `worlds/`

**One file is one whole simulation: the people, and what happens to them.**

```bash
npm run sim                                    # blank — one person, at a number, in no business
npm run sim -- --world ace-tennis
npm run sim -- --world worlds/ace-tennis.json --days 7
npm run sim -- --world '{"people":[{"name":"Nisha","seat":"prospect"}]}'
```

## Nothing is pre-built any more

A world file used to describe **what the database looks like the moment onboarding finished** —
classes, coaches, clients, children, enrolments, arrears — and a builder wrote all of it in SQL
before anybody spoke. Seven hundred and ninety lines of code to skip the one conversation this
product is sold on.

Now a run opens with a **sender, a front desk, and some people holding phones.** No academy, no
classes, nobody enrolled in anything. The business is talked into existence by the people in
it, and whether the product can get it out of them is the measurement.

That is not a fiction the product had to be bent for. `0039` already says a stranger belongs to
the **number** before they belong to a business: a front desk is one `academy` row per sender,
it owns no class, no player, no money and no roster, and `onboarding_state` stays `setup` so it
can never initiate. Somebody messaging it is routed — **joined** into a business that exists, or
**founded** into one that does not. The harness is now just *put people at that number and let
it happen*.

Deleting the fixtures deleted a second mechanism with them. Because the harness used to write
those rows, every brief had to be **derived** from them or it would describe a business that was
not there — a coach told his batch ran Monday and Thursday in a world that ran Monday and
Wednesday writes a turn that reads as a product defect and is a harness one. There is nothing to
derive from now, and therefore nothing that can drift.

**If you want a settled academy, write the people who would build one.** An owner whose `about`
says what they run and whose `goals` say they want it written down will build it in the first
day or two, and what ends up in the database is what the product understood — which is the thing
worth looking at.

## The shape

Everything except `people` is optional.

```json
{
  "name": "Ace Tennis",
  "timezone": "Asia/Kolkata",

  "people": [
    {
      "name": "Rahul Menon",
      "seat": "prospect",
      "oneLine": "coaches tennis out of a notebook and has just been given this number",
      "about": "You coach tennis in Bengaluru. Two coaches help you…",
      "goals": ["Get this set up without a long interview about it."],
      "voice": "Short, lowercase, no punctuation you do not need.",
      "typing": "You drop the subject of the sentence constantly.",
      "redLines": ["Being told something was done when it was not."],
      "life": { "2": "Priya asked you for a raise last night." }
    }
  ],

  "week": { "chaos": { "absent": 0.1 }, "events": [] }
}
```

| field | means |
| --- | --- |
| `name` | What the scenario is called. Names the run and this run's sender. |
| `timezone` | Defaults to `Asia/Kolkata`. |
| `people[].name` | The name on the phone. **Must be unique** — a seat key and an event's `who` are by name. (Arrivals are matched by **phone**; a product-created stranger who shares a cast name gets a suffixed key, never a shared seat.) |
| `people[].seat` | `admin`, `coach`, `client`, `prospect`. The axis every score is split by. **Declared, not derived** — nobody is an admin of anything yet. |
| `people[].about` | Who they are, in their own frame. The main thing you write. |
| `people[].goals` | What they want. Falls back to a thin role default. |
| `people[].voice` | How they type. **Replaces** the role default. |
| `people[].typing` | The specific mess they make, on top of the shared input realism. |
| `people[].redLines` | What would make them complain, escalate or leave. **Added** to the role's. |
| `people[].life` | What happens **to** them, keyed by day number. Day 1 is a Monday (unless `--start` moved it — the run warns). |
| `people[].present` | Whether they are **at the number when the run opens**. The rule activates on first use: if *any* person sets `present` or `arrives`, unset means **withheld**; if nobody sets either, everyone is present (every legacy file behaves exactly as before). |
| `people[].arrives` | The day a withheld person **walks in** — seated as a front-desk contact at the top of that day, like any stranger texting the number. Mutually exclusive with `present: true`. |
| `people[].style` | How they are at a machine: `skepticism` (`trusting` \| `ordinary` \| `hard`), `messiness` (0–1, the garble rate), `presence` (0–1, how often they check the phone). Unset values are drawn per person from a stable hash, so temperament survives reseeding. |
| `week` | What happens to the business — [`events/`](../events/README.md) owns the shape. |

## The cast is not a seating plan

Production does not open with four people mid-conversation: one person texts a number, and
everyone else exists because the business reached them. `people[]` is therefore a **cast**.
The present ones hold phones from minute one. The withheld ones are the founder's circle —
their names and numbers seed the founder's contact book, so "add Kiran" is a card-share
rather than an invented number — and the moment the product actually reaches their phone,
`_arrivals.ts` seats them **with the brief written here**: their about, their goals, their
life. A withheld person the product never reaches is a week that person never had, which is
itself a finding.

`arrives` is for the people the *product* cannot cause: the walk-in prospect, the referral
texting from a phone nobody knows. They join the front desk on their day, unprompted.

`blank` is a **word, not a file**, so a missing file cannot break the default: one prospect, a
phone, and no instructions about what the product can do for them.

## Everybody starts at the number

Every person in `people` gets a contact on this run's front desk, which is exactly what a
stranger is. They are all routed by the product as they message in. Whoever the business gains
afterwards — a coach the owner adds on Wednesday, a family written down on Tuesday — is seated
by `scripts/_arrivals.ts` from that window on, so the product never writes to a phone nobody is
reading.

**One sender per run.** `app.front_desk_for` is `on conflict (sender_id)` — one front desk per
number — so two drives sharing the shared `SENDER_ID` would share a desk and see each other's
visitors and businesses. A run makes its own `sender` row and gets its own front desk for free.
Two simulations can run at once and share nothing but the database.

## It refuses; it never repairs

An unknown key at any level, a `seat` that is not one of the four, a `life` key that is not a
day number, a person with no name, **two people with the same name**, and a world with nobody in
it all stop the process before a row exists.

The duplicate-name one is worth knowing: two Rahuls collapse into one seat key, and the second
one's whole week would go to the first one's phone.

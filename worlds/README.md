# worlds/

An academy, written down in one small file, built into a live business you can drive from.

A world spec describes the moment **onboarding finished** — the owner is in, the coaches are in,
the timetable exists, the children are on registers — and nothing after it. That is the point
almost everything worth testing starts from, and until this directory the only way to reach it
was the four-family tennis club welded into `scripts/drive-week.ts`, or an hour of driving the
setup conversation by hand.

There is one format and no archetypes. Six pre-made businesses would be the same welding done
six times, none of them ever quite the one you meant. Write the one you meant instead — it takes
a minute.

```jsonc
{ "coaches": 4, "clients": 6, "admin": { "coaches": true } }
```

That is a valid world: four coaches with generated names, six families with a child each, an
owner who also teaches. So is `{}` — the owner, alone, the morning after onboarding.

## Using one

[`../scripts/_world-spec.ts`](../scripts/_world-spec.ts) is the reader and the builder.

```ts
import { buildWorld, describeWorld, loadWorldSpec } from './_world-spec'

const spec  = await loadWorldSpec('multi-coach')     // or a path, or inline JSON
console.log(describeWorld(spec))                     // one line, before you spend an hour
const world = await buildWorld(spec, { token, log: console.log })
```

`loadWorldSpec` takes a bare name (`multi-coach` → `worlds/multi-coach.json`), a path
(`worlds/blank.json`, `./arms/b.json`), or inline JSON starting with `{`. A reference that
resolves to nothing names every path it looked at.

`buildWorld` needs this run's four-character token — the tail of its `.probe/runs/` directory.
The academy is named `<your name> <token>`, which is what lets a world be traced back to the run
that made it and reaped later without touching one another process is driving.

**Set the academy's clock before you build.** Every date the builder writes is relative to
`app.now()`, this tenant's own clock, so a build against a clock nobody set puts the classes
forty days before wherever the last run left it. The builder reads the clock and logs it, so a
build against the wrong one says so in the run's output.

## The fields

Everything is optional except a class's `name`, `days`, `from` and `to`.

| Field | | |
|---|---|---|
| `name` | string | The business. The run token is appended. Default `Custom Academy`. |
| `category` | string | `"tennis"`, `"chess"`, `"swimming"`. **Display only** — it decides nothing (`0002_schema.sql:34`). Default `"sport"`. |
| `timezone` | string | An IANA name. Default `"Asia/Kolkata"`. |
| `admin.name` | string | The owner. Default `"Rahul Menon"`, which is the admin persona the seat instruments already put in that chair. |
| `admin.coaches` | boolean | Does the owner also teach? `true` gives them a `coach` row **as well as** an `academy_admin` one — two hats over one person, which is the business this product is sold into. Default `false`. |
| `coaches` | number, or a list | `4`, or `[{ "name": "Arjun Shetty", "pay": 600, "unit": "per_session" }]`. |
| `coaches[].pay` | number | Rupees. Omitted, `coach.pay_amount` stays null — "not tracked", a real state. |
| `coaches[].unit` | `"per_session"` \| `"per_month"` | Required when `pay` is set; default `"per_month"`. |
| `clients` | number, or a list | `6`, or `[{ "name": "Divya Rao", "children": ["Anika Rao"] }]`. |
| `clients[].children` | list of names | Omitted, they get one, named for them. **`[]` means the client is the learner** — an adult beginner. |
| `clients[].owes` | number | Rupees carried in from before this world. See *Arrears*. Negative is a credit. |
| `prospects` | number, or a list | People in the book with nothing against them. |
| `classes[].name` | string | The admin's own words — `"6:30 Beginners Batch"`. |
| `classes[].days` | list of day names | `["mon","thu"]`. **Never numbers** — see *Days are names*. |
| `classes[].from` / `.to` | `"18:00"` | 24-hour local time. `to` must be after `from`. |
| `classes[].rate` | number | Rupees. Omitted, the class has no rate and the monthly job bills nothing for it. |
| `classes[].unit` | `"per_month"` \| `"per_session"` | Required when `rate` is set; default `"per_month"`. |
| `classes[].coaches` | list of names | Omitted, coaches are dealt round-robin across the file. `[]` leaves the class uncovered, which is a real state. |
| `classes[].enrolled` | list of names, or a number | Child names, or *how many of the children*. |

## The four rules that make it short

**A count is as good as a list.** `"coaches": 4` draws four plausible names from a fixed pool;
`"coaches": [{ "name": "Priya Nair" }]` names them yourself. Mix freely between fields. A count
past the end of its pool is refused rather than extended with `Coach 13` — the pools hold 12
coaches, 16 clients and 12 prospects, and past that you name them.

**Everything is optional.** `{}` is a valid world.

**Days are names, not integers.** `class_slot.weekday` is `0=Sun..6=Sat`, while
[`../scripts/_personas.ts`](../scripts/_personas.ts)'s `TIMETABLE` stores ISO weekdays
(`1=Mon..7=Sun`). The two agree on Monday through Saturday and differ only on Sunday, which the
canonical timetable happens not to use — a coincidence, not a design. A raw integer in a
hand-written file is one Monday/Wednesday mix-up away from a coach being told his batch is not on
today when it is, which reads exactly like the product losing a class.

**`enrolled` as a number deals in order, across the whole file.** Six children and
`3`, `2`, `1` across three classes puts children 1–3 in the first, 4–5 in the second and 6 in the
third — not the same three in all of them. Ask for more than the world has and it is refused.

## What it refuses

It refuses; it never repairs. A repaired spec is a spec that quietly stopped being what you
wrote down. Every problem in the file is reported at once, each with its path — `classes[1].days[0]`
— and nothing is built.

- **An unknown key, at any level.** `"coachs": 4` is not four coaches, it is zero coaches and no
  message. So is `"enroled"`, and `"timeZone"`.
- **An unknown day name.** `"tues"` is not Tuesday.
- **A class naming a coach who is not in the file** — a class nobody teaches.
- **An `enrolled` name that is nobody's child.**
- **Two people with one name.** `person.full_name` is what every enrolment and `class_coach` row
  in this repo is matched on.
- **Two active classes with one name.** `class_academy_name_active_key` (migration 0020) is
  unique on the active class name, so the second one silently *becomes* the first. The last time
  one was swallowed it cost 22 duplicate sessions, every coach message sent twice, and the
  register prompt suppressed by the frequency cap.
- **A negative count, a time that runs backwards, a unit with no amount, a class with no day.**

## What it does not write

No messages, no sessions, no payments, no bills. The product materialises its own sessions and
bills its own open period, and a fixture that pre-bills it gets the month charged twice —
`scripts/_world.ts` learned that by telling a parent she owed ₹4,800.

`owes` is the one exception, because a business that has been running has arrears and there is no
other way to say so. It writes one `adjustment` line in the **previous** month's period, so the
monthly job cannot re-derive it and the open month is left alone. It shows up as arrears in
`account_standing.balance` the moment anybody asks.

Phone numbers are not yours to choose either. Every tenant shares one sender, and a number held
by two academies resolves to **neither** — silently. So every number is derived from the academy
id: `+9194` + six digits of the id + a two-digit seat index, which is a hundred seats and no
more.

## A worked example

```json
{
  "name": "Kalakshetra Vocal",
  "category": "carnatic vocal",
  "admin": { "name": "Lakshmi Sundaram", "coaches": true },
  "coaches": [{ "name": "Ravi Anand", "pay": 12000, "unit": "per_month" }],
  "clients": [
    { "name": "Divya Rao", "children": ["Anika Rao"], "owes": 1800 },
    { "name": "Ganesh Kamath", "children": [] }
  ],
  "prospects": 1,
  "classes": [
    {
      "name": "Beginners Varnam",
      "days": ["tue", "sat"],
      "from": "17:00",
      "to": "18:00",
      "rate": 1800,
      "coaches": ["Ravi Anand"],
      "enrolled": ["Anika Rao"]
    },
    {
      "name": "Adult Evening",
      "days": ["thu"],
      "from": "19:00",
      "to": "20:00",
      "rate": 2500,
      "enrolled": ["Ganesh Kamath"]
    }
  ]
}
```

Five phones — owner, one coach, two clients, one prospect — two players, two classes over three
sessions a week, and Divya opens ₹1,800 down. Ganesh has `"children": []`,
so *he* is the player in the adult class; Divya's own player row is retired, because the parent
is not the learner. `Adult Evening` names no coach, so Lakshmi takes it — she is first in the
rotation because she coaches.

## The files here

| | |
|---|---|
| [`blank.json`](./blank.json) | `{}`. The owner, alone, the morning BEFORE onboarding — it stays at `onboarding_state = 'setup'`, because `app.guard_go_live()` (0033) will not switch the reminders on over an empty timetable. The default stage. |
| [`settled-tennis.json`](./settled-tennis.json) | **A transcription** of the canonical world — `TIMETABLE` and `FAMILIES` in [`../scripts/_personas.ts`](../scripts/_personas.ts), which is the authority and always wins. It is here to prove the format can express the real one; if the two ever disagree, `_personas.ts` is right and this file is stale. |
| [`multi-coach.json`](./multi-coach.json) | Four coaches, six clients, an owner who also teaches, four classes with the children already enrolled. Written in counts, so it is also the shortest demonstration of the ergonomic form. |

Three, and three is the ceiling. A fourth example is an archetype, and archetypes are what this
directory exists instead of.

JSON has no comments — anything you want to explain about a world belongs here, in prose, rather
than in a `"_comment"` key the validator will refuse.

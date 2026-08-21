# `events/`

**A world file says what the business IS. An events file says what the week DOES to it.**

`worlds/` is the database the morning after onboarding. Nothing said what happened next — so
every week ran in a business where it never rained, nobody was ill, nobody went away, every
class ran and everybody enrolled turned up. The sharpest version of that hole is the register:
the product asks the coach who was there, and **the coach seat had no way of knowing**, so it
invented one. Attendance is what §6.4 bills off. A week with invented registers is a week with
invented money, and nothing downstream can tell.

```bash
npm run sim -- --world settled-tennis --events tennis-hard-week
npm run sim -- --world multi-coach --events monsoon
npm run sim -- --events monsoon,flaky-phones         # they stack, left to right
npm run sim -- --chaos 0.15                          # a messy week, no file at all
npm run sim -- --events '{"chaos":{"absent":0.3}}'   # inline, for a one-off
npm run truth                                        # what the world did, beside what the product believes
```

The two are separate on purpose: **one scenario runs against six businesses, and one business
runs through six scenarios**, with neither file edited. A world whose weather is part of its
identity can carry a `week` block instead — same shape, and the two compose, the world's own
being the base.

## Six verbs

Everything is optional. `{}` is a valid events file and means nothing happens, which is what
every run before this directory existed was measuring.

```json
{
  "about": "A wet week with a family away and one coach out of signal.",
  "chaos": { "absent": 0.1 },
  "events": [
    { "what": "washout", "day": [3, 4], "why": "heavy rain — the courts are under water" },
    { "what": "absent",  "day": 4, "who": "Anika Rao", "why": "the fever she has had since Wednesday" },
    { "what": "away",    "day": [2, 3, 4], "who": "Meera Iyer", "why": "you are in Coorg with family" },
    { "what": "lag",     "day": 1, "window": "evening", "who": "Arjun Shetty", "hours": 6,
      "why": "no signal at the courts" },
    { "what": "note",    "day": 5, "who": "Priya Nair",
      "why": "Your sister's wedding is tomorrow and it is the same morning as the Weekend Squad." }
  ]
}
```

| `what` | what it does |
| --- | --- |
| `absent` | Ground truth: this player was **not** at their session that day. The coach is told after the class; the family is told why. |
| `present` | The same in reverse — pins somebody as there when a `chaos` roll or a washout would have taken them out. |
| `washout` | The class did not physically happen — rain, a power cut, a holiday, a locked gate. The session row still says `scheduled`: **the product only finds out if a person tells it**, which is the test. |
| `away` | This person is not at their phone for these windows. Their turn is **skipped**, and skipped is recorded as its own thing — a customer on holiday and a customer who read your message and put the phone down are different findings. |
| `lag` | Their phone is behind. Anything newer than `hours` is not shown this window and lands at the top of their next look. That is a **late** reply rather than one that never comes. |
| `note` | Pure pressure, in their own frame, with no mechanism attached. The escape hatch. |

| field | means |
| --- | --- |
| `day` | A day number, a list of them, or `"all"`. **Day 1 is a Monday.** A day past the end of the run is refused, not skipped. |
| `window` | `morning`, `evening`, or both. Omitted means both. Ignored by `absent`/`washout`, which are facts about the day. |
| `who` | Person **names**, or a list of them. Checked against the world's real rows before the run starts. |
| `class` | Narrows a `washout`, an `absent` or a `present` to one class by name. |
| `why` | The reason, **in the affected person's own frame**. This is what reaches a seat. |
| `hours` | `lag` only. How far behind the phone is. Default 12. |

There is no seventh verb for "cancel the class", "put the price up", "the coach quits". Those
are things a **person decides**, and a person deciding one is a `note`. The line is: a verb
exists only when the harness has to do something the seat cannot do for itself.

## `chaos` — a messy week without authoring one

```json
{ "chaos": { "absent": 0.15, "quiet": 0.1, "lag": 0.1, "washout": 0.05 } }
```

| rate | rolled |
| --- | --- |
| `absent` | per player, per session |
| `quiet` | per seat, per window — they did not pick the phone up |
| `lag` | per seat, per window — 4 to 15 hours behind |
| `washout` | per day |

`--chaos 0.15` on the command line sets all four at once; `--chaos absent=0.2,lag=0.1` sets
them individually. Both are refused if a name is unknown or a rate is outside 0–1.

Every roll is **materialised into the record** exactly as though somebody had typed it, so a
chaotic run reads back identically to a hand-written one and repeats exactly under the same
`--seed`. The roll is a *hash* of `(seed, verb, day, window, who)` rather than a stream, so
adding one line to a file does not reshuffle who was ill on Thursday — which is what lets
`npm run ab` give both arms the same weather.

## What it will refuse, and why that is the feature

An event that never fires is worse than a broken one: the week runs perfectly, the record looks
complete, and the whole reading rests on believing it rained on Wednesday. So all of these stop
the run before an academy exists:

- an unknown verb, an unknown key, an unknown chaos rate
- `"day": 9` in a five-day run — *"it would never fire; shorten the event or run `--days 9`"*
- a `who` this world has nobody by — it prints who it **does** have, with phones and with registers
- a `class` this business does not run — it prints the ones it does
- **an `absent` on a day that player has no session** — it prints what the academy runs that day
  and which classes that child is actually in

That last one is the commonest mistake in a hand-written scenario and the hardest to see
afterwards: a child marked absent on a day their class does not meet produces a week
indistinguishable from one where they attended. It is the same failure `worlds/README.md`
refuses `enrolled: 3` for.

## Nothing here writes to the database

Not one row. The product must learn a fact from a person who types it; a harness that marked
the attendance itself would leave nothing to measure and would still produce a record full of
attendance rows.

So there are two accounts of the week and they are never reconciled inside a run:

- `truth.json` — what the **world** did, written by `sim.ts` at the end of every day
- `attendance`, `session.status`, `tally_line` — what the **product** believes

`npm run truth` prints them side by side and writes no verdict about the difference, because
[a difference carries a sign and the sign is the verdict](../docs/JUDGING.md). A register that
says a child was present when the world says they were ill is at least four different things,
and only one of them is a defect:

- the coach tapped `[All present]` without reading it — a finding about the affordance
- the product never asked — a finding about the ladder
- **nobody told the product anything and it claimed nothing** — correct, and most of the rows
- the parent rang the coach and the coach marked it — the product working as designed

## Nothing here is a script

An event says *"Anika was not there, she had a fever."* It never says *"tell the bot she was
absent."* Whether anybody mentions it at all is the measurement — the same argument
[`scripts/_personas.ts`](../scripts/_personas.ts) opens with, and it applies twice as hard
here. `why` is written in the person's own frame for that reason: "fever" becomes *"Anika has a
fever"*, never *"the register needs correcting"*, which is a fact about the product that no
person in the world can see.

## The library

| file | needs | what it is for |
| --- | --- | --- |
| `monsoon.json` | any world | Two days rained off in the middle of the week, and nobody tells the bot. |
| `flaky-phones.json` | any world | Unreliable phones and nothing else wrong. Late replies, silent windows. |
| `exam-season.json` | any world | A third of the children stop turning up and nobody cancels anything. |
| `messy.json` | any world | One dial turned up on everything. The shakedown week. |
| `tennis-hard-week.json` | `settled-tennis` | The hand-written one: a fever nobody reported, a family away, a coach with no signal, and a Saturday that falls through on Friday night. |

The first four name nobody, which is what makes them portable — point them at any business.
The fifth names real people and is checked against `worlds/settled-tennis.json`'s rows.

## They stack

```bash
npm run sim -- --events monsoon,flaky-phones,exam-season
```

`events` concatenate; `chaos` rates **overwrite by name**, left to right, so a later file turns
a rate up or down rather than adding to it. Two files each asking for a 0.2 absence rate mean
0.2, not 0.4 — the only reading of *"and also this"* that stays true as the list grows.
`exam-season,messy` gives you `messy`'s 0.18; `messy,exam-season` gives you `exam-season`'s 0.35.

This is most of why a library is worth having. The weather, the phones and the school calendar
are independent things that happen to the same week; four scenarios that compose are fifteen
weeks, and four that do not are four. Inline JSON is the one form that does not stack, because
a rate list has commas in it.

The full order of precedence, lowest first:

1. the world file's own `week` block
2. each `--events` file, left to right
3. `--chaos` on the command line

So `--chaos` always wins, which is what you want when you are turning one dial on a scenario
somebody else wrote.

## What it cannot express

Worth knowing before you plan a week around it.

- **Day 1 is a Monday**, so day 8 is the next Monday and `"day": [1, 8, 15]` is *every Monday*.
  There is **no ceiling on `--days`** — `--days 30` is a billing month, and "a child misses
  three weeks running" is `{ "what": "absent", "day": [3, 10, 17], "who": "…" }`. Past the last
  day anybody wrote a `life` for, the days are ordinary unless a file or a `chaos` rate fills
  them, and the run says so on its first line.
- **Two windows, 08:30 and 20:15.** A `note` or an `away` lands in one of them. Something that
  has to happen at two in the afternoon lands in the evening window.
- **An `absent` needs a real session.** A scenario about a class the business does not run needs
  the *world* file to change, not this one.
- **Events are a calendar, not a reaction.** You cannot say "if the product does X, then Y." The
  week is fixed before it runs — which is what makes it reproducible, and is the trade.

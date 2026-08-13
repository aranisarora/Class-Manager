# Class Manager

A WhatsApp-native manager for Indian coaching businesses. The chat is the interface: clients
book, pay and get reminded; coaches get their day and mark attendance with taps; admins run the
business in natural language.

Built from [`product-spec.md`](./product-spec.md), which remains the authority on behavior.
[`CONTRACTS.md`](./CONTRACTS.md) is the build spine — module boundaries and exact signatures.

**The emulator is the product surface in this build.** Meta Cloud API setup is deliberately not
wired; the transport abstraction is real and `lib/messaging/transport-cloud.ts` is written
against the live API, but nothing in this repo calls Meta.

---

## Run it

```bash
npm install
npm run dev
```

Then open **http://localhost:3000/emulator**.

The database is already provisioned, migrated and seeded. To rebuild the world:

```bash
npm run seed          # both academies (default)
npm run seed ace      # Ace TT Academy only
npm run seed solo     # Nadam Vocal only — the solo case (§18)
```

## The world you get

One WhatsApp number (`+91 80 4718 2200`) serving **two tenants**, which is how tenant isolation
becomes something you can watch rather than something you're told (§16).

| | Ace TT Academy | Nadam Vocal |
|---|---|---|
| Admin | Sharwin Rao | **Lakshmi Subramanian — also the coach** |
| Coaches | Arjun (active), Priya (active), Ravi (invited, never onboarded) | — (§18: she is the business) |
| Classes | Beginners Batch `per_month`, Saturday Advanced `per_session`, Sunday Camp `per_package` | Tuesday Beginners, Saturday Kriti — both `per_month` |
| Families | 8 accounts / 10 players | 6 students |

Three of those are load-bearing test fixtures, not decoration:

- **Deepa Nair** is a self-paying adult — `account.holder_person_id = player.person_id`, the n=1
  case §6.2 says must not be a second code path.
- **Kiran Kumar**, 16, has **his own number** separate from his father's. Money-shaped rows must
  never route to him (§6.7).
- **Ravi** was invited and never onboarded, so `AD-COACH-NOT-ONBOARDED` has something real to fire on.

## What to try

Open a pane per contact from the tray, then:

1. **Ask the admin pane something real** — *"which families haven't paid for August?"* The answer
   comes from a model-authored `SELECT` run under that admin's own RLS session.
2. **Ask for something destructive** — *"cancel Saturday Advanced this week, the hall is double
   booked."* You get the blast radius **before** anything commits, and a button. Nothing is
   written and nobody is messaged until you tap it.
3. **Type into a coach pane with no prompt in front of you** — *"reached"*, *"running late"*,
   *"Aarav's out Monday"*. §8.2: free text always works.
4. **Advance the clock.** Jump to the next event and watch the T-60 → T-30 → T-15 ladder fire, or
   to the evening for the digest. Jobs run on every advance.
5. **Open two panes and race them** on `[Claim this session]`. First tap wins; the loser is told
   it's taken. The panes update live over SSE, so the race is real.
6. **Watch the event log** — every send with template-vs-in-window, its cost, the sender number,
   every suppression with its reason, every job, every model call with tokens and latency.
7. **Turn on a fault** — `send_fail`, `number_blocked`, `link_expired`, `model_error`.
8. **Send a file.** `📎 attach` takes anything on your disk — drop it on the composer or paste a
   screenshot. Audio reaches the model as audio (§14.5); there is no transcription step.
9. **Ask what it knows.** The 🧠 button on a pane shows §5 both ways: the bounded hot set the
   prompt actually carries, and the append-only fact record behind it, with corrections marked as
   supersessions rather than edits.
10. **Add your own people.** `+ new` in the tray creates a contact in the live world without a
    reseed, wired for real — a client gets an account, a player and an enrollment in the first
    class, so reminders and tallies work on them immediately. The next reseed clears them.
11. **Drive it from the command line** — `npm run drive` is the harness, and it posts
    to this same API. `drive score` prints the seven axes as numbers; `drive link`
    reaches the web screens without waiting for the bot to offer one. See
    [`FINDINGS.md`](./FINDINGS.md).

## Checks

```bash
npx tsc --noEmit              # typecheck
node scripts/rls-check.mjs    # the security boundary
npm run drive -- score        # the seven axes, as numbers
```

`rls-check` is the spec's phase-0 acceptance criterion: cross-tenant and cross-role reads return
zero rows, and the build fails if any table has RLS disabled. **Seed a fixture before you trust
it** — with an empty world it skips its cross-role and family-privacy sections and still reports
"0 failed".

---

## How it holds together

**RLS is the security boundary, and the model is a user of it (§2.1).** The app connects as
`cm_runtime`, a role that owns nothing and cannot read a single table. Every query runs inside a
transaction that first `SET LOCAL ROLE`s into `cm_service`, `cm_user` or `cm_readonly` and sets
the `app.*` GUCs the policies read. There is no code path that touches a row without declaring
who it is acting as. Model-authored `SELECT`s run as `cm_readonly` — no writes, 5 s statement
timeout, 10 000-row cap.

**Mint once, replay verbatim (§2.2).** Every button carries an `action` row authored at compose
time and fully resolved. A tap loads it, checks expiry, consumption and that the tapping contact
is the one it was minted for, then executes the stored payload — **no model call**. Confirmations
for destructive plans are minted by the runtime, not left to the model, so the plan itself rides
the button rather than a re-prompt.

**Compute the effect before committing it (§2.3, §14.2.1).** `transaction(steps[])` runs the whole
plan, captures before/after images through a snapshot trigger, and rolls back. The bot knows its
blast radius instead of estimating it. **Messages are staged until commit** — a rolled-back
transaction has messaged nobody.

**One send path (§16.3).** Ten gates in order: opt-out, the two §18 suppression rules, pre-launch
silence, API limits, per-recipient frequency, per-tenant cap, window-or-template, idempotency,
then the wire. A suppressed message is *recorded with its reason*, never silently dropped, which
is why the event log can show you what didn't go and why.

**The solo case falls out of two rules, not eight branches (§18).** Never ask someone to confirm
something to themselves; never escalate about a person to that person. Both are checked on the
send path, so Nadam Vocal works without a single `if (solo)`.

**Layered context (§4).** A byte-identical stable prefix — doctrine, schema, nine behavior
modules, operation signatures, the message catalog — then a variable tail carrying memory, roles
and the clock. Behavior lives at the lowest layer that can hold it: the database refuses what it
can, operations carry their own consequences, and only what's left is prompt.

## Layout

```
lib/db.ts                 the session boundary — roles, GUCs, model queries
lib/clock.ts              the drivable clock (app.now())
lib/agent/                prompt layering, tools, plans, operations, the loop
lib/behaviors/*.md        the nine §4.2 modules, always in context
lib/messaging/            the catalog, templates, window, transports, the one send path
lib/jobs/                 20 job kinds, each re-checking its own precondition
lib/web/                  signed links, the component registry, view specs
app/emulator/             the world, tray, panes, clock, event log, faults
app/w/[token]/            setup, the register, rendered views — no login
supabase/migrations/      29 tables, RLS on every one
```

## Known gaps

- **Meta Cloud API is not connected**, by design. `transport-cloud.ts` and `app/api/webhook`
  are written and correct but never exercised.
- **Rail 2** (payment gateway, mandates, in-chat checkout) is deferred per §19 phase 13. Rail 1 —
  UPI handle, admin attestation, reconciliation, dunning — works.
- **`academy.prompt_cache_handle` stays null, deliberately.** Implicit caching turned out *not* to
  do the work — measured across turns it served 0 cached tokens, hitting only between hops inside
  one turn — so `lib/agent/gemini.ts` now takes an explicit `CachedContent` for the stable prefix
  and a warm turn serves ~93% of its prompt from cache. The handle lives in the process, not on the
  academy: the prefix is deliberately academy-independent, so one cache serves every tenant and
  per-tenant rows would buy N copies of the same thing. It is created only when a second call
  arrives within five minutes, because cache storage costs more per hour than a quiet academy
  saves. The event log's `cached` chip is the check — amber at 0%.
- **There is no agent-simulation harness**, and the README used to claim one. Personas, a judge
  agent and diffable runs (§17, phase 12) were built and removed as over-engineered; `npm run
  drive` is the harness now, and a person driving it is the eval. `drive score` is what turns
  that from an impression into numbers.
- Model quality varies turn to turn, as it will: the structural guarantees hold every time, but
  which tool the model reaches for first does not. Given the same sentence twice, one turn
  created the class and one asked first — that variance is what §14.3's recipes exist to remove.

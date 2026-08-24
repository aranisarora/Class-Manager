# Class Manager

A WhatsApp-native manager for Indian coaching businesses. The chat is the interface: clients
book, pay and get reminded; coaches get their day and mark attendance with taps; admins run the
business in natural language.

Built from [`product-spec.md`](./docs/product-spec.md), which remains the authority on behavior.
[`DRIVING.md`](./docs/DRIVING.md) is how you drive it and find real defects — one spine, six
instruments, what a run costs before you start it, how to read one back, and the traps that
make a bad run look like a good one. [`PREFIX-RULES.md`](./docs/PREFIX-RULES.md) governs what the model is told:
read it before adding a line to the prompt, and read its graveyard before adding one that
has already been removed twice.

**The emulator is the drive surface; the live path is wired.** `TRANSPORT` selects the
transport: `emulator` posts into the in-repo phone, `cloud` sends through the Meta Cloud API
(`lib/messaging/transport-cloud.ts`), deployed and configured per
[`DEPLOY.md`](./docs/DEPLOY.md) §4 — `npm run wa` is the setup surface. Drive against the
emulator unless you specifically mean to exercise the live sender.

---

## Run it

```bash
npm install
npm run dev
```

Then open **http://localhost:3000/emulator**.

`.env.local` is required and gitignored — validated by `lib/env.ts`, covering the
database, `DEEPSEEK_API_KEY`, the two model names, the link signing secret and the
transport. Without it nothing runs, and in a fresh worktree the
failure looks like model errors rather than a missing file: every turn comes back with an
error, no tools and an empty reply. Copy `.env.local` and `node_modules`
(a junction is fine) into any worktree before driving it.

The schema lives in `supabase/migrations/`. Applying it and building a world:

```bash
npm run db:push       # every migration in filename order; re-running is a no-op
npx tsx scripts/drive.ts seed --stage ready    # one business at a named point in its life
npx tsx scripts/drive.ts academy "<name>" --admin "<name>"   # an empty business, as signup makes it
```

Or build a business from empty by talking to it — `+ business` in the tray, or
`npm run drive -- academy "X" --admin "Y"`. Both write the four rows onboarding starts
from and **message nobody**; nothing goes out until the academy is set live.

## The world you get

Nothing, until you ask for one. A fresh database holds no businesses — there is no whole-world
fixture any more. `+ business` in the tray (or `npm run drive -- academy "X" --admin "Y"`)
starts one from empty, and everything after that is talked into existence. For a business at a
later point in its life, seed a stage:

```bash
npx tsx scripts/drive.ts seed --stage ready
```

One business per stage — `empty`, `setup`, `roster`, `ready`, `live`, `mature` — each under its
own name (Sunrise Swim, Kadam Athletics, Bluewave Badminton, Crescent Karate, Orchid Dance,
Sixteen Strings Music), so two stages can coexist and a re-run rebuilds only its own fixture.
The stages share one cast: Nandini Rao (admin), coaches Imran Qureshi (active) and Tara Sethi,
the Menon and Khan families, and Ritu Malhotra; two classes, Evening Beginners (`per_month`)
and Saturday Squad (`per_session`), so money cannot be answered by summing one column.

Two of the cast are load-bearing test fixtures, not decoration:

- **Ritu Malhotra** is a self-paying adult — `account.holder_person_id = player.person_id`, the
  n=1 case §6.2 says must not be a second code path.
- **Tara Sethi** was invited and never onboarded, so `AD-COACH-NOT-ONBOARDED` has something real
  to fire on.

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
7. **Turn on a fault** — `send_fail`, `number_blocked`, `media_timeout`, `link_expired`,
   `model_error`.
8. **Send a file.** `📎 attach › Document` takes anything on your disk — drop it on the composer
   or paste a screenshot. **The model cannot read any of it** (§14.5, repealed): the runtime
   answers the attachment in words and the turn carries on from whatever was typed. Worth sending
   one to see which sentence comes back — a voice note and a photo get different ones.
9. **Share a contact.** `📎 attach › Contact` is the one attachment the model *can* read, because
   a card is a name and a number rather than bytes. Pick two or three strangers out of the phone
   book, type *"three new families for the Monday batch"*, and watch a roster get built without
   anybody transcribing a digit. Every academy's book is derived from its own id, so two tenants
   are never offered the same number — the §10.1 collision that makes a family silently
   unreachable cannot happen by accident here. The second section of the picker is the world's
   own people, for when you want the duplicate case on purpose.
10. **Ask what it knows.** The 🧠 button on a pane shows §5 both ways: the bounded hot set the
    prompt actually carries, and the append-only fact record behind it, with corrections marked as
    supersessions rather than edits.
11. **Add your own people.** `+ person` in the tray creates a contact in the live world without a
    reseed, wired for real — a client gets an account, a player and an enrollment in the first
    class, so reminders and tallies work on them immediately. The next reseed clears them.
12. **Make a business from empty.** `+ business` writes an academy at `setup`, its admin and
    nothing else, and messages nobody. Everything after that — classes, coaches, families — is
    built by talking to it.
13. **Drive it from the command line** — `npm run drive` is the harness, and it posts
    to this same API. `drive say` prints the reply, the buttons and every query that turn
    ran. [`DRIVING.md`](./docs/DRIVING.md) is the method.

## Checks

```bash
npm run typecheck             # tsc --noEmit
node scripts/rls-check.mjs    # the security boundary
node scripts/verify-static.mjs # five absolutes, as a build failure rather than a note
npm run drive -- evidence     # what the seven axes are judged on, straight off the tables
npx tsx scripts/probe-model.ts   # the real loop through a scripted arc, plus SQL invariants
node scripts/q.mjs --academy "Orchid" "select …"   # ask the database what actually happened
```

`rls-check` is the spec's phase-0 acceptance criterion: cross-tenant and cross-role reads return
zero rows, and the build fails if any table has RLS disabled. **Seed a fixture before you trust
it** — with an empty world it skips its cross-role and family-privacy sections and still reports
"0 failed".

`drive evidence` prints the measurements each axis is judged on and stops — it computes no
score, because nothing in a query knows what good looks like. The axes, the 0–10 calibration
and where the verdict goes are [`JUDGING.md`](./docs/JUDGING.md).

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
is the one it was minted for, then executes the stored payload — **no model decides what runs**.
Confirmations for destructive plans are minted by the runtime, not left to the model, so the plan
itself rides the button rather than a re-prompt. Once the transaction has closed the tap becomes
an ordinary turn: the model reads what the plan actually wrote and composes the reply, so a
receipt is written by something that can see the rows rather than assembled from counts.

**Compute the effect before committing it (§2.3, §14.2.1).** `transaction(steps[])` runs the whole
plan, captures before/after images through a snapshot trigger, and rolls back. The bot knows its
blast radius instead of estimating it. **Messages are staged until commit** — a rolled-back
transaction has messaged nobody.

**Onboarding is a conversation, and that is a deliberate downgrade (§14.6).** A new business
is asked for its name, what it teaches, where it plays, the cancellation notice and its UPI
handle — in the chat, one question at a time. This used to be a single WhatsApp Flow: a
static form inside the chat, all nine fields in one exchange. **Flows are gone from this
product entirely.** A form collects more per round trip and buys that by fixing every
question, and the order of every question, at publish time — so it cannot skip what it can
already see, follow the answer that turns out to matter, or take the correction typed one
second after Save. What makes the ladder pay for itself is that it does all three: it assumes
what it can and says so, absorbs everything a single sentence gives it, and stops as soon as
it has enough to create a class. It commits through `set_up_business`, which runs the one
plan builder in `lib/setup-plan.ts` — a second implementation of one event is the defect this
repo has hit most often, and it is why that builder outlived the form that used to call it.

**One send path (§16.3).** Gates in order: opt-out, the two §18 suppression rules, the lint
pass, pre-launch silence, the repeat gate, API limits, per-recipient frequency, per-tenant
cap, window-or-template, idempotency, then the wire. Lint is here rather than at
`composeAndSend` because `composeAndSend` is not the chokepoint — `plan.ts` reaches `send`
directly, so every message an operation stages would have missed it. The repeat gate drops a byte-identical body sent
to the same person inside five minutes when they asked for it and six hours when they did not —
a proactive generator saying the same sentence twice in a working day is a defect every time.
A suppressed message is *recorded with its reason*, never silently dropped, which is why the
event log can show you what didn't go and why.

**The solo case falls out of two rules, not eight branches (§18).** Never ask someone to confirm
something to themselves; never escalate about a person to that person. Both are checked on the
send path, so a solo owner-coach works without a single `if (solo)`.

**Layered context (§4).** A byte-identical stable prefix — preamble, the front-desk section,
schema, operations framing, the message catalog, platform facts, domain facts, doctrine, and
the tool declarations — then a
variable tail carrying memory, roles, the clock and a census of what exists, read under the
asking person's own RLS. Behavior lives at the lowest layer that can hold it: the database
refuses what it can, operations carry their own consequences, and only what's left is prompt.

## Layout

```
CLAUDE.md                 orientation for an agent working in this repo — read first
docs/                     the spec, the architecture, and the runbooks
findings/                 the ledgers — what has broken, and what is still open
lib/db.ts                 the session boundary — roles, GUCs, model queries
lib/clock.ts              the drivable clock (app.now())
lib/agent/                prompt layering, tools, plans, operations, the loop
lib/frontdesk/            the arrivals hall — a stranger, asked which side they are on
lib/doctrine.md           the rules every reply is derived from, always in context
lib/messaging/            the catalog, templates, window, transports, the one send path
lib/jobs/                 the job kinds, each re-checking its own precondition
lib/emulator/             the emulator's own server-side state
app/emulator/             the world, tray, panes, clock, event log, faults
app/api/                  the Meta webhook, the emulator API, the ops gate, the cron tick
components/emulator/      the phone, rendered
supabase/migrations/      the schema — RLS on every table
worlds/                   hand-written academies to drive — `worlds/README.md` is the format
events/                   what happens to one during a week — `events/README.md` is the format
scripts/                  the instruments and the checks — `scripts/README.md` indexes them
scripts/drive.ts          the harness — talk to it, then read the tables back
```

Every path above is asserted by `npm run check:layout`, so this block cannot quietly rot the
way it had: it used to list `lib/web/` and `app/w/[token]/`, neither of which has existed for
some time, and a count of tables that was five short.

## Known gaps

- **The live WhatsApp path is wired but lightly exercised.** `transport-cloud.ts` and
  `app/api/webhook` are deployed and configured ([`DEPLOY.md`](./docs/DEPLOY.md) §4), and the
  emulator remains where behaviour is driven and measured. There is no Flows API call among
  them: publishing artifacts, `validateFlowJson` and the whole create/upload/publish dance
  went with the forms (§14.6).
- **Inbound media is never fetched, and no longer needs to be.** A Meta media id becomes a
  placeholder string; nothing downstream resolves it, because the model is text-only (§14.5).
  What matters now is that an attachment is *answered* rather than dropped, and that path is
  the same on both transports.
- **Rail 2** (payment gateway, mandates, in-chat checkout) is deferred per §19 phase 13. Rail 1 —
  UPI handle, admin attestation, reconciliation, dunning — is built and the **front half has now
  run once**: a register was marked from chat, both families were told the outcome, both players
  were billed for the month, a payment reached `requested` and a `reconcile` was scheduled
  carrying its tenant. `client_outcome`, `monthly_lines` and `month_end_tally` have fired.
  The back half has since run once too — `requested → confirmed` without double credit, and the
  dunning ladder to escalation — but `per_package` exhaustion, `per_term`, a waiver through the
  model and a disputed charge remain undriven. Treat those as unverified, not as working.
- **`academy.prompt_cache_handle` stays null, permanently.** It assumed a per-academy prefix, and
  the prefix is deliberately academy-independent — one cache serves every tenant. The previous
  provider needed 140 lines of explicit-cache machinery here, built because its implicit caching
  measurably never bit (0 cached tokens across turns). The DeepSeek
  client deletes all of it: the server caches any byte-identical prefix automatically, a hit costs
  3.2% of a miss, and there is nothing to create, hold or expire. The event log's `cached` chip is
  still the check — amber at 0%, and now it is measuring something the provider promises rather
  than something we were buying.
- **Recipes (§14.3) were deleted, not deferred** — the table, `lib/agent/recipes.ts`, the capture
  site and the prompt fragment are gone as of `0017_drop_recipe.sql`. Capture, generalisation and
  matching were each written and each correct, and never joined: `applyRecipe` — the only thing
  that could bind a `{{placeholder}}` and run the result — had no callers, so what fired on a live
  turn was a matched plan `JSON.stringify`d, sliced at 1200 characters, and pasted into the
  variable tail as prose for the model to re-compose. A worked example cut mid-JSON is worse than
  no worked example. If the round saving is wanted back, it has to be built as a replay the
  runtime performs, not as a paragraph the model is asked to copy.
- Model quality varies turn to turn, as it will: the structural guarantees hold every time, but
  which tool the model reaches for first does not. Given the same sentence twice, one turn
  created the class and one asked first. Nothing in the product currently narrows that.

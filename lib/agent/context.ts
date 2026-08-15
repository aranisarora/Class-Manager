/**
 * lib/agent/context.ts — the layered prompt (§4).
 *
 * STABLE PREFIX  (byte-identical across turns; changes only with schema or doctrine)
 *   core doctrine · schema · domain facts · operations framing · catalog
 * VARIABLE TAIL  (never cached)
 *   who this is · academy · memory hot sets · today · situation · query results
 *
 * The eleven behavior modules that used to sit between schema and operations are
 * gone — retired by measurement, not by taste. The phase-6 arc drove the same
 * lifecycle with and without them, one variable apart: truth tied (253/261 both),
 * the module-free arm's replies were plainer, its two best moments were *derived*
 * from doctrine rather than prescribed, and the prescriptions were implicated in
 * their own arm's two worst behaviors. What the modules held that no principle
 * regenerates — domain facts, platform facts — survives in the facts block below.
 * The choreography does not.
 *
 * The discipline is the whole point: no dates, no ids, no per-academy anything
 * above the boundary, or the provider's automatic prefix cache stops matching and
 * every turn pays full price (§4.4). A cache hit costs 3.2% of a miss, and the
 * byte-stable prefix is the entire mechanism — there is no handle to hold.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Identity } from '@/lib/types'
import { modelQuery, type SessionCtx } from '@/lib/db'
import { repoRoot } from '@/lib/env'
import { now, inZone } from '@/lib/clock'
import { dayDiff, longDate } from '@/lib/format'
import { catalogDigest } from '@/lib/messaging/catalog'
import { SCHEMA_DOC } from '@/lib/agent/schema-doc'
import { hotSet } from '@/lib/agent/memory'
import { vocabularyPreferences } from '@/lib/agent/lint'

export { lint } from '@/lib/agent/lint'

/**
 * Doctrine lives on disk as markdown. Resolution tries the working directory
 * first (how Next and tsx both run) and falls back to a path derived from this
 * module's own location.
 */
function readDoc(relPath: string): string {
  const candidates = [join(repoRoot(), relPath), join(process.cwd(), relPath)]
  for (const c of candidates) {
    try {
      return readFileSync(c, 'utf8').trim()
    } catch {
      continue
    }
  }
  throw new Error(
    `agent context: cannot read ${relPath}. Looked in: ${candidates.join(', ')}`,
  )
}

// No count of anything is stated in the prompt: a count is the one thing here
// that goes stale silently — nothing checks it, and the model cannot tell a
// miscount from something it has been told to ignore.
const PREAMBLE = `You are Class Manager: the manager for a coaching business, working inside WhatsApp.

You are not a notification system. You are expected to notice things nobody asked
you to look for, compose messages nobody specified, and answer questions nobody
anticipated. The structure around you exists to make that safe, not to prevent it.

The people you talk to are running a business between classes, on a phone, with
one hand. They did not read anything. Nobody trained them. Judge every reply by
what it costs them to read and what it saves them to have read it — an owner
should be interrupted three times a month, not thirty, and a parent who taps
"I'll be there" should get a thumbs up rather than a paragraph.

WhatsApp is the whole surface. There is no browser, no dashboard and no web page
in this product. Anything form-shaped is a form inside the chat; everything else
is a message.

What follows never changes: the doctrine you derive every situational judgement
from, the schema you author SQL against, the facts of the domain, the operations
you can reach for, and the moments code will put in front of you. Everything
about this particular conversation comes after it.

Doctrine wins over your instinct. The database wins over all of it.`

const CACHE_BOUNDARY = `---
END OF STABLE PREFIX. Everything above is identical on every turn, for every
person, in every business served. Everything below is this conversation only.
---`

let cachedPrefix: string | null = null

/**
 * The domain facts that used to live inside the behavior modules, extracted and
 * kept when the choreography was retired. The test for a line's presence here:
 * it is a FACT — about WhatsApp, about money in Indian coaching businesses,
 * about the people on the other end — that no amount of reasoning from doctrine
 * would produce. Anything a principle regenerates was deleted with the modules;
 * anything the schema, an operation's own declaration or the catalog digest
 * already states does not get a second copy here.
 *
 * No worked chat examples, deliberately. The phase-6 arc showed the model
 * imitates an example's surface along with its content — bracket-formatted
 * button rows from module prose were typeset into live message bodies as text
 * nobody could tap. Facts state; they do not demonstrate.
 */
const DOMAIN_FACTS = `# Facts of the domain

What derivation alone will not produce. These are facts, not scripts — reason
from the doctrine above to what a moment needs, and reason with these.

Silence and blocks
- An opt-out is not a withdrawal. The child stays enrolled and nothing changes
  about their classes; it stops what you start, never what the person asks for.
  It also stops the monthly bill reaching them — that becomes the admin's job,
  and the admin is told so in as many words.
- Somebody asking you to stop almost never wants silence; they want less, and
  they cannot ask for that precisely because nobody has shown them what they
  get. What actually reaches them each month is countable from the message
  table — count it before switching anything off, and make full silence one
  option among the partial cuts, not the headline.
- A block is stronger than an opt-out. A blocked number is never retried, never
  re-batched, never tried with a different template; if it was a mistake, the
  recovery conversation belongs to the admin, from the admin's own number.
- One block in a small batch is a signal about the batch, not the person: halt
  the run and report why it matters — the sender number is shared with other
  businesses, and a bad run here costs them too.
- "Not before 8am" and "a day's notice, not an hour" are retimings: a memory
  fact and a timing override, applied and read back. Never answer a timing
  request with an offer to stop entirely.
- The record outlives every opt-out: attendance and coach notes can still be
  asked for any time, in one go instead of six messages a week.

WhatsApp
- The first message to somebody who has never messaged us is the highest-risk
  send in the product: it lands cold, on a shared number, from a name they do
  not recognise. What earns it a read: the academy's and the player's names in
  the first line, one detail only the real academy could know, one useful
  button — never a consent-shaped one — and the frame of service continuity
  ("class updates have moved here"), never a launch announcement.
- Being messaged first is strictly better than messaging first: free, no
  template, no block risk, and the 24-hour window opens itself. A button tap is
  an inbound message, so it re-opens the window. Out of window, a message is a
  template and a window-opener: deliberately plain, aimed at one useful tap.
- A WhatsApp group exposes every family's number to every other family and
  reads as a mailing list. A broadcast list lands as a normal one-to-one — and
  delivers only to people who have the admin's number saved in their contacts;
  everyone else gets silence that looks like success. Both facts are worth
  saying at the moment the admin is about to send.
- Cold outreach runs staged: a small first batch, then the delivery, read and
  block signals, then the rest — halting on a bad signal, with the arithmetic
  and the names in the report.

Money
- The commonest true dispute is the out-of-band cancellation: the parent told
  the coach at the court a week ago, nothing is on record, and a per-session
  line was written. The parent is right and the data is wrong. Fix the record —
  attendance to cancelled_timely, an offsetting adjustment — rather than
  arguing about what was said.
- A payment that never arrived is almost never a lie. It is a second UPI
  handle, a typo, or a bank that has not settled — say where it went and why
  you could not see it, then fix the class of problem rather than the instance:
  two handles in circulation produce this conversation every month.
- Approval is the admin's. A parent asking for a waiver is a request, not an
  approval: propose the exact adjustment and route it, never approve on the
  strength of the person asking.
- Chasing money has an end. When somebody stops answering, stop — tell them you
  are leaving it with the admin — and the handover carries the one fact that
  changes the reading: whether the child is still turning up.
- Nothing bills itself. A pack that runs out, a term that rolls over, a rate
  that renews: each asks first, and says that it is asking.
- Money from before this product existed is never chased. Billing starts where
  the admin said it starts.

Schedule and coverage
- Reschedule is the makeup. When a session cannot happen, the first offer is
  another slot of the same class with the actual open slot named — a credit
  only when there is no slot to move to.
- Scope is asked, never assumed. One absence and a permanent change are
  different rows with different consequences, and the sentence people type does
  not distinguish them. Do the urgent half first, then ask whether it repeats.
- A repeating change is a class change, not many session changes: it edits the
  slot and rematerialises future sessions, and it never clobbers attendance
  already marked or cancellations already made. When the scope grows —
  permanent, not just this week — say so before committing.
- A session is never deleted. Cancelled is a status with a reason; moved is new
  times on the same row; history, attendance and the coach set survive both.
- Who hears: a cancelled session, its enrolled families, with the alternative
  offered; a moved one, the families, once; a coach's decline while others
  remain assigned, nobody outside the coach set, because nothing changed for
  the parents; a changed headcount, the coach — the number, not the story.
- Escalations are about sessions, never people: a session with no confirmed
  coach, never a coach who has not confirmed.

Coaches
- Leaving is an end date, never a delete. History stays attributed — audit and
  payables both need it — and whatever is assigned past the date becomes
  uncovered sessions, a state the product already understands. There is no
  coach-leaving alert to invent.
- Parents hear about a coach change only if something changed for them, as one
  line inside a message they were already getting. A standalone broadcast about
  a routine departure manufactures anxiety about a routine event. The one named
  exception: a genuinely non-routine departure may be said directly, with the
  departure from the default explained.
- Cover is not a concept. Covering for a stretch is assigning them those
  sessions; a returning coach is assigned again.
- A cover offer reasons about the taker's own day — how the session lands
  against what they already have — because that is the question they are
  actually deciding.
- A reason for dropping a session is invited and never required, and it travels
  to the admin with the blame explicitly removed. A coach who thinks reasons
  are used against them stops giving reasons, then stops answering at all.

Strangers
- The profile name on an inbound is the parent's own, self-set and unverified —
  never the child's.
- Have an opinion and be willing to lose the sale with it. The question behind
  every intake question is "will my child be in the right room": say which
  class fits and why the obvious one does not, and name the friction — the
  real time of day, the non-standard price — before the booking, not after.
  The person who books past named friction has actually decided.
- A trial is auto-confirmed; the admin holds an undo, never a gate. What makes
  the after-the-fact note actionable: where they came from, and the thing they
  said that a human would want to follow up on.
- The free first class is a rule, not a negotiation, and it is per player. A
  second child gets their own trial, on the same account: one bill, one chat,
  nothing to set up separately — and say so, because people expect a whole
  second registration.
- If nothing fits, say so. A trial in the wrong class is worse than no trial.

Beginnings
- Building a roster messages nobody, and the silence is stated each time
  something is created that a person could have been told about — because that
  is each time the admin is wondering.
- Everything goes in before anything goes out. Partial state is worse than
  either extreme: a parent with two children reminded about one, a coach seeing
  one of their three sessions.
- setup, roster, ready and live are column values, not vocabulary. Never
  narrate the machinery; say what is true in their words.
- A defaulted value is said out loud, once, as a question they can ignore. A
  default that travels silently becomes a price somebody is charged.

Watches and memory
- A promise to look at something later IS a schedule call. Saying it without
  setting one is the worst sentence you can send, because they will believe it.
- What makes a watch trustworthy is that its behaviour is predictable: what you
  look at, how often, against what, when it stops — and that silence is a
  result. A watch that fires and decides to do nothing is the system working.
- The obvious facts are the valuable ones: the word they use for a class, the
  day they always ask about money, who never taps and always types, the coach
  who needs three hours' notice. A timing preference is a fact that acts — set
  the override, and be able to say why.
- Neither a watch nor a fact is ever its own message. Both ride on a reply that
  was going out anyway, or on nothing.

Escalation
- Two failed turns is a hard trigger, not a judgement call. A third attempt
  makes it worse.
- Safety language — an injury, a child not collected, an adult's conduct — ends
  the automation on first mention: no details gathered first, no buttons, one
  line saying you are getting the admin now, and the handoff performed with the
  transcript attached.
- A client's or a coach's escalation goes to their admin; an admin's goes to
  the platform; and never about a person to that person — the send path drops
  those.
- The admin's copy carries evidence, not mood: where the person is, their words
  in quotes, how many others are affected, and whether it has happened before.
  The repeat and the blast radius are what turn a complaint into a decision.`

/**
 * Doctrine + schema + facts + operations framing + the catalog digest. MUST be
 * byte-identical across turns (§4.4).
 *
 * Memoised on first call rather than at module load: `catalogDigest()` lives in
 * another module, and building at import time would make this file's
 * correctness depend on module evaluation order. The result is the same string
 * either way.
 */
export function stablePrefix(): string {
  if (cachedPrefix !== null) return cachedPrefix

  const parts: string[] = [PREAMBLE]

  parts.push(readDoc('lib/doctrine.md'))
  parts.push(SCHEMA_DOC.trim())

  parts.push(
    `# Situations

There is no playbook of situations here on purpose. When something happens — a
stranger writes in, somebody wants fewer messages, a coach quits, money is
disputed, a schedule moves — reason from the doctrine above to what this moment
needs: who is affected, who must hear, what must be confirmed before it is acted
on, what will stop and who owns what happens next. Derive the behaviour; do not
wait to be told the situation has a name.`,
  )

  parts.push(DOMAIN_FACTS)

  /**
   * The operations, and where their *arguments* now live.
   *
   * This block used to carry all ~20 signatures as prose — 5,789 characters,
   * 9.4% of the prefix — because `act` declared `args: {type:'object'}` and there
   * was nowhere else to put them. That was the wrong place twice over: it cost
   * tokens on every single turn, and it put the argument names tens of thousands
   * of characters upstream of the decode point, in the one form a function-call
   * decoder cannot apply. A declared schema constrains generation; a paragraph
   * constrains nothing.
   *
   * Each operation is its own declaration and its zod schema is projected into
   * that constraint (`schema-json.ts`). The prose would
   * then be the same information a second time, in the weaker form, so only the
   * framing stays — *when* to reach for an operation is a judgement the prefix
   * should still shape; *what to call the arguments* is the schema's job.
   *
   * The same argument retires the "reach for the operation rather than a raw
   * INSERT, because create_class is the only thing that schedules the sessions"
   * sentence that used to close this block. It is stated twice inside this one
   * cached block already — once on the `plan` tool's `steps` description, where
   * the model is actually choosing between a step and an INSERT, and once per
   * operation in each declaration's own consequence line. Both sit at the decode
   * point; this one sat 50k characters upstream of it and was paid for anyway.
   */
  parts.push(
    `# Operations

Known-good plans with known-good copy. Reaching for one is cheaper and more
consistent than composing from scratch, and their arguments are already resolved
for you. They are not gates: a consequence chain nobody anticipated is composed
as a transaction of steps, with the same atomicity, the same diff and the same
staged messages.

Each one is a tool you can call directly, and its arguments are on the tool.`,
  )

  /**
   * No framing paragraph of its own: `catalogDigest()` opens with one, and the two
   * said the same thing — suppress, merge, retime, re-button, always rewrite; FIXED
   * cannot be suppressed — in adjacent blocks separated by a blank line. The digest's
   * version is the one that survived, because it carries the concrete parenthetical
   * for each verb ("this coach needs three hours, not one") rather than the verb list
   * alone, and the one sentence it was missing has moved into it.
   */
  parts.push(catalogDigest().trim())

  parts.push(CACHE_BOUNDARY)

  cachedPrefix = parts.join('\n\n')
  return cachedPrefix
}

/**
 * What the brief and the digest need, and nothing else (§10.2).
 *
 * They author no SQL, call no operation and choose no catalog row — they turn a
 * payload they are handed into prose. So they get the doctrine that governs how the
 * product sounds, and none of the ~13k tokens of machinery that governs what it does.
 * Kept here rather than in `loop.ts` so there is one place that knows what a layer is.
 */
export function synthesisDoctrine(): string {
  return [
    `You are Class Manager, the manager for a coaching business, writing to the person who runs it.`,
    readDoc('lib/doctrine.md'),
    `You are not composing a message to send on a schedule. You are deciding what this person should know.`,
  ].join('\n\n')
}

// -----------------------------------------------------------------------------
// Variable tail
// -----------------------------------------------------------------------------

const ROLE_LABEL: Record<string, string> = {
  admin: 'admin (runs the business)',
  coach: 'coach',
  account_holder: 'account holder (the person who pays)',
  player: 'player',
  prospect: 'prospect (not signed up)',
}

function isoDateOf(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? m[0] : null
}

/**
 * §10.2 — the mix shifts over the first month. One prompt instruction, not two
 * code paths, and now not two ladders either.
 *
 * `loop.ts` had a second version of this for the brief and the digest, splitting
 * at 30 days where this splits at 14 and 45. Same dial, same three positions,
 * two sets of thresholds — so an academy 20 days old was told to lean on proof
 * inside a turn and to lean on synthesis in its own evening digest, on the same
 * evening. Exported so the synthesis path shares it; it is prose either way.
 */
export function mixInstruction(ageDays: number): string {
  if (ageDays <= 14) {
    return `This business is ${ageDays} day${ageDays === 1 ? '' : 's'} old. **Lean on proof.** They do not yet trust that the mechanics work, so what they need from you is evidence: what went out, what was delivered, which sessions ran, which registers got marked, what you did. Keep synthesis to a line. Numbers and receipts beat opinions this week.`
  }
  if (ageDays < 45) {
    return `This business is ${ageDays} days old. **Proof and synthesis both.** The mechanics have mostly earned trust, so keep delivery health present but short, and start leading with the thing actually worth their attention rather than the log of what happened.`
  }
  const weeks = Math.floor(ageDays / 7)
  return `This business is ${ageDays} days old (about ${weeks} weeks). **Lean on synthesis.** They trust the mechanics now and want the thinking: lead with the pattern worth their attention, say what you would look at and why, and keep the proof to one line unless something failed.`
}

function formatQueryResults(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    const s = JSON.stringify(v, null, 1) ?? String(v)
    return s.length > 60_000 ? `${s.slice(0, 60_000)}\n… truncated` : s
  } catch {
    return String(v)
  }
}

/* ------------------------------------------------------------------------- *
 * What actually exists
 * ------------------------------------------------------------------------- */

/**
 * A census of the business, from the point of view of whoever is talking.
 *
 * The tail already carried who this is, what the business is called, what is
 * remembered about them and what time it is. It did not carry **what exists** —
 * so "are there any classes yet?" cost a query the model mostly did not think to
 * run, and the answer to "what should I do next?" was improvised from nothing.
 * Driving a brand-new business made that concrete: asked what to do, the bot
 * narrated its own state machine ("we're in the setup phase, we're building your
 * roster") because that was the only fact about the business it had.
 *
 * Two properties keep this from being a script:
 *
 *  - It is **counts, not instructions.** Nothing here says what to do about an
 *    empty roster; what to do is a judgement the model derives from doctrine,
 *    not a branch in this file.
 *  - It runs **under this person's own RLS**, so a coach's census is their
 *    classes and a parent's is their children. Nothing needs to remember to
 *    filter it; the same query returns a different world per person, which is
 *    the property the whole product is built on.
 *
 * **Every label below is prompt, and nobody reviews a label as prompt.** The rule
 * this block is held to: read the label and its value, with no access to the SQL
 * above it, and say the sentence they license. If that sentence can be false, the
 * label is wrong — not the predicate. `uncovered_sessions_next_36h` was correct
 * SQL under a name that told an owner, four times, that his only coach was not
 * assigned to a class he was assigned to. The fixes here are all of one shape:
 * name what the predicate actually tests, and hand over the neighbouring fact that
 * makes the true sentence the available one.
 *
 * Never a precondition: if the census fails, the turn continues without it.
 */
async function census(id: Identity): Promise<string | null> {
  const ctx: SessionCtx = {
    role: 'user',
    academyId: id.academyId,
    personId: id.person.id,
    contactId: id.contact.id,
  }

  /**
   * Null means the count query failed. Every `q` below is a bare `select
   * (subquery), (subquery)` with no FROM, so it returns exactly one row whenever it
   * runs at all — which makes null an error signal and never "no data". Callers
   * must not render a count from a null row: `Number(undefined ?? 0)` is 0, and a
   * refused query rendered as "0 classes, 0 sessions" is the census stating, with
   * confidence, the opposite of what it failed to read.
   *
   * `--` comments in these SQL strings carry no apostrophes on purpose: `db.ts`
   * blanks string literals BEFORE it strips comments, so one stray quote inside a
   * comment shifts the pairing of every literal after it in the validator's view of
   * the statement.
   */
  const q = async (sql: string): Promise<Record<string, unknown> | null> => {
    const res = await modelQuery(ctx, sql)
    return res.error ? null : ((res.rows[0] as Record<string, unknown>) ?? null)
  }
  const n = (row: Record<string, unknown> | null, key: string): number => Number(row?.[key] ?? 0)

  /**
   * `null` means the lookup FAILED. `[]` means it ran and found nothing.
   *
   * They were the same value here, and they are opposite sentences downstream: the
   * family branch turns an empty list into "**nothing is scheduled ahead for them
   * at all**" — emphasised, with an instruction to say it plainly. `modelQuery`
   * returns errors rather than throwing (lib/db.ts), so a refusal or a 5s timeout
   * arrived as `[]` and became a confident negative nobody read out of a row. That
   * is the one sentence a parent acts on by not turning up.
   *
   * Every list in the census goes through here, so the distinction is made once
   * rather than remembered at three call sites.
   */
  const many = async (sql: string): Promise<Record<string, unknown>[] | null> => {
    const res = await modelQuery(ctx, sql)
    return res.error ? null : (res.rows as Record<string, unknown>[])
  }

  /**
   * A session as a person says it, not as the row stores it.
   *
   * Rendered here rather than handed over raw, because a raw `starts_at` is the
   * shape the most expensive error in the product comes out of: given `06:00:00`
   * and no rendering, replies came back saying "6pm", defended it when pushed,
   * and sent a parent to a locked hall. `inZone().label` is the same formatter the
   * rest of the product writes times with, so the tail already contains the exact
   * sentence the reply should use.
   */
  const tz = id.academy.timezone || 'Asia/Kolkata'
  const sessionLine = (r: Record<string, unknown>): string => {
    const raw = r.starts_at
    const at = raw instanceof Date ? raw : new Date(String(raw))
    // A bare class name, under a heading that says "use these times verbatim", is an
    // invitation to supply the missing half from nowhere — which is exactly the
    // failure this whole block exists to prevent. Say the time is missing instead.
    if (Number.isNaN(at.getTime())) {
      return `${String(r.class_name ?? 'a class')} — start time unreadable, look it up before you state one`
    }
    const who = r.who ? `${String(r.who)} — ` : ''
    const venue = r.venue ? ` at ${String(r.venue)}` : ''
    return `${who}${String(r.class_name ?? 'a class')}, ${inZone(at, tz).label}${venue}`
  }

  try {
    if (id.roles.includes('admin')) {
      const row = await q(`select
          (select count(*) from venue) as venues,
          (select count(*) from class where active) as classes_active,
          -- Named apart because the slot count below is NOT filtered to active
          -- classes, and "3 classes with 11 weekly slots" is false the moment one is
          -- archived. Nothing in the product archives a class today, so this is
          -- almost always 0 and costs nothing to say — but the sentence it prevents
          -- is a weekly load the owner cannot reconcile with their own timetable.
          (select count(*) from class where not active) as classes_archived,
          (select count(*) from class_slot) as slots_all_classes,
          (select count(*) from coach where status = 'active') as coaches_active,
          -- added and invited were one number called "waiting", and the sentence
          -- attached to it told the admin to invite them. For an invited coach that is
          -- false — the invite is already out and what is missing is their tap — and
          -- it is the same failure as uncovered_sessions: a merged predicate named
          -- after one of the two states it covers. The union is unchanged.
          (select count(*) from coach where status = 'added') as coaches_uninvited,
          (select count(*) from coach where status = 'invited') as coaches_invited,
          (select count(*) from account) as families,
          (select count(*) from player where active) as players_active,
          (select count(*) from enrollment where ended_on is null) as enrolled,
          (select count(*) from session where status = 'scheduled' and starts_at > app.now()) as upcoming,
          (select count(*) from session where status = 'scheduled'
             and starts_at between app.now() and app.now() + interval '7 days') as this_week,
          -- A message ROW is not a delivered message. This counted every unsuppressed
          -- outbound row and was read out as "sent", while the digest defines sent as
          -- status in sent/delivered/read — one word, two meanings, and the weaker
          -- one telling an owner his mailout went out when every row of it had
          -- failed. Both travel now, so the true sentence is the available one.
          (select count(*) from message where direction = 'outbound'
             and coalesce(suppressed_reason, '') = ''
             and contact_id <> '${id.contact.id}'::uuid) as outbound_to_others,
          (select count(*) from message where direction = 'outbound'
             and coalesce(suppressed_reason, '') = ''
             and status in ('sent','delivered','read')
             and contact_id <> '${id.contact.id}'::uuid) as sent_to_others`)
      if (!row) return null
      // Each line carries what the count MEANS, because a bare zero is the same
      // mistake doctrine rule 11 names: true, and not the answer. "0 active
      // coaches" reads as nothing-to-see; "two added, neither invited, so
      // neither can see a thing" is the sentence somebody can act on — and it is
      // still a fact, derived here, not a plan invented by anybody.
      const archived = n(row, 'classes_archived')
      const uninvited = n(row, 'coaches_uninvited')
      const invited = n(row, 'coaches_invited')
      const outbound = n(row, 'outbound_to_others')
      const sent = n(row, 'sent_to_others')
      /**
       * R8 — a door with no sign. `set_onboarding_state` was the only writer of the
       * most consequential value in the product, reachable only if the model happened
       * to choose it, and nothing anywhere named the moment that calls for it. So an
       * academy with a full roster could sit in `setup` indefinitely while every
       * proactive path silently suppressed — no error on either side, just a business
       * that never started.
       *
       * It goes FIRST because it changes what every line under it means: "12 sessions
       * scheduled ahead" reads as a working business, and until this flips, not one of
       * those reminders will go out.
       */
      const live = id.academy.onboarding_state === 'live'
      const readyToGoLive = !live && n(row, 'classes_active') > 0
      const bits = [
        live
          ? null
          : `NOT LIVE (${id.academy.onboarding_state}) — no reminder, digest or announcement reaches anybody yet, ` +
            `and every count below is a roster nobody has been told about. ` +
            (readyToGoLive
              ? 'There is a timetable in, so going live is now a real next step to offer.'
              : 'Nothing to go live with yet — the timetable is what is missing.'),
        `${n(row, 'venues')} venue(s)`,
        `${n(row, 'classes_active')} active class(es) with ${n(row, 'slots_all_classes')} weekly slot(s)` +
          (n(row, 'classes_active') === 0 ? ' — so there is nothing to remind anyone about yet' : '') +
          (archived
            ? ` — but the slot count is every class's, ${archived} archived one(s) included, so it is not the weekly load`
            : ''),
        `${n(row, 'coaches_active')} active coach(es)` +
          (uninvited || invited
            ? `, and ${uninvited + invited} who cannot see a session, will not be reminded, and will not know they are expected anywhere: ` +
              [
                uninvited ? `${uninvited} added but never invited — nothing has been sent to them at all` : '',
                invited ? `${invited} invited and not yet confirmed — the invite is out; they have not tapped it` : '',
              ]
                .filter(Boolean)
                .join('; ')
            : ''),
        `${n(row, 'families')} family account(s), ${n(row, 'players_active')} active player(s), ${n(row, 'enrolled')} live enrolment(s)`,
        `${n(row, 'upcoming')} session(s) scheduled ahead (${n(row, 'this_week')} in the next 7 days)`,
        `${outbound} message(s) ever addressed to anyone outside this conversation` +
          (outbound === 0
            ? ' — nobody outside this conversation has heard from this business at all'
            : sent < outbound
              ? `, of which ${sent} actually went out — the other ${outbound - sent} are still queued or failed, so nobody received those`
              : ''),
        id.academy.upi_handle
          ? `UPI handle set`
          : `no UPI handle on file, so a payment request goes out with nothing to pay to`,
      ]
      return bits.filter(Boolean).map((b) => `- ${b}`).join('\n')
    }

    if (id.coachId) {
      const [row, next, unmarked] = await Promise.all([
        q(`select
          (select status from coach where id = '${id.coachId}'::uuid) as status,
          (select count(*) from class_coach where coach_id = '${id.coachId}'::uuid) as classes,
          (select count(*) from session_coach sc join session s on s.id = sc.session_id
            where sc.coach_id = '${id.coachId}'::uuid and s.status = 'scheduled' and s.starts_at > app.now()) as upcoming,
          -- The count above is every assignment row; the list below filters on
          -- declined_at is null. So a coach who dropped Saturday was told "4
          -- sessions ahead of you" above a list of 3 — two adjacent facts that
          -- contradict each other, and the larger one says they are expected
          -- somewhere they have already said no to. Neither predicate moves; the
          -- difference travels with them.
          (select count(*) from session_coach sc join session s on s.id = sc.session_id
            where sc.coach_id = '${id.coachId}'::uuid and s.status = 'scheduled' and s.starts_at > app.now()
              and sc.declined_at is not null) as upcoming_declined,
          -- The list of registers is capped at 3. Without the total, "3 registers
          -- still unmarked" is what a reader states when there are nine, and it is
          -- also the cross-check that tells this block apart from a failed lookup.
          (select count(*) from session_coach sc join session s on s.id = sc.session_id
            where sc.coach_id = '${id.coachId}'::uuid and s.status = 'scheduled' and s.ends_at < app.now()
              and not exists (select 1 from attendance a where a.session_id = s.id)) as unmarked_total`),
        // `confirmed_at` rides along because "they are down for it" and "they said
        // yes" are different facts, and only the first was ever in front of the
        // model — the same conflation that made the digest tell an owner a covered
        // session needed a coach.
        many(`select c.name as class_name, s.starts_at, v.name as venue, sc.confirmed_at
                from session_coach sc
                join session s on s.id = sc.session_id
                join class c on c.id = s.class_id
                left join venue v on v.id = coalesce(s.venue_id, c.venue_id)
               where sc.coach_id = '${id.coachId}'::uuid
                 and sc.declined_at is null
                 and s.status = 'scheduled' and s.starts_at > app.now()
               order by s.starts_at limit 4`),
        // The one thing a coach is chased about, prefetched with the id needed to
        // act on it — so "did I mark Tuesday?" is answered, and marking it is one
        // round rather than three.
        many(`select c.name as class_name, s.starts_at, s.id as session_id
                from session_coach sc
                join session s on s.id = sc.session_id
                join class c on c.id = s.class_id
               where sc.coach_id = '${id.coachId}'::uuid
                 and s.status = 'scheduled' and s.ends_at < app.now()
                 and not exists (select 1 from attendance a where a.session_id = s.id)
               order by s.starts_at desc limit 3`),
      ])
      const bits: string[] = []
      if (row) {
        const declined = n(row, 'upcoming_declined')
        // The status word alone is the state machine, and narrating the state
        // machine is the documented failure this block was built to stop. What each
        // word MEANS to this coach travels with it.
        const status = String(row.status ?? 'unknown')
        const meaning =
          status === 'added'
            ? ` — on the books, invite not sent yet, so nothing has reached them from this business`
            : status === 'invited'
              ? ` — the invite is out and they have not confirmed it; confirming is what starts their day`
              : status === 'ended'
                ? ` — they have left; nothing new is assigned to them`
                : ''
        bits.push(`- their coach record is "${status}"${meaning}`)
        bits.push(
          `- assigned to ${n(row, 'classes')} class(es), and named on ${n(row, 'upcoming')} scheduled session(s) ahead` +
            (declined
              ? ` — ${declined} of those they have already declined, so they are NOT expected there and the list below leaves them out`
              : ''),
        )
      } else {
        bits.push(
          `- their coach record and session counts could not be read this turn. Say nothing about either, and do not read the gap as "none".`,
        )
      }
      if (next && next.length) {
        bits.push(`- their next session(s), soonest first (up to 4 shown) — use these times verbatim:`)
        for (const r of next) {
          bits.push(`    · ${sessionLine(r)}${r.confirmed_at ? '' : ` — they have NOT confirmed this one yet`}`)
        }
      } else if (n(row, 'upcoming') - n(row, 'upcoming_declined') > 0) {
        // Two reads of the same fact, and they disagree — the count found sessions
        // and the list came back empty or refused. The disagreement is the finding;
        // resolving it silently in favour of the empty list is how "nothing coming
        // up" gets said to a coach who is expected somewhere tomorrow.
        bits.push(
          `- their next sessions could not be listed this turn, though the count above says there are some — look them up before you name a time.`,
        )
      }
      const unmarkedTotal = n(row, 'unmarked_total')
      if (unmarked && unmarked.length) {
        bits.push(
          `- register(s) still unmarked${
            unmarkedTotal > unmarked.length ? ` — ${unmarkedTotal} in total, the ${unmarked.length} most recent below` : ''
          }, with the id to mark them:`,
        )
        for (const r of unmarked) {
          bits.push(`    · ${sessionLine(r)} — session_id = ${String(r.session_id)}`)
        }
      } else if (unmarkedTotal > 0) {
        bits.push(
          `- ${unmarkedTotal} register(s) are still unmarked but the list of them could not be read this turn — look them up before you say which.`,
        )
      }
      return bits.join('\n')
    }

    if (id.accountIds.length || id.playerIds.length) {
      const [row, next] = await Promise.all([
        q(`select
          (select count(*) from player where active) as players,
          (select count(*) from enrollment where ended_on is null) as enrolled`),
        // §9's most-asked question is "what time is his class", and it cost a round
        // every time because the tail carried a count and a bare timestamp. These are
        // the actual rows, already in their words.
        many(`select pe.full_name as who, c.name as class_name, s.starts_at, v.name as venue
                from session s
                join class c on c.id = s.class_id
                join enrollment e on e.class_id = s.class_id and e.ended_on is null
                join player pl on pl.id = e.player_id and pl.active
                join person pe on pe.id = pl.person_id
                left join venue v on v.id = coalesce(s.venue_id, c.venue_id)
               where s.status = 'scheduled' and s.starts_at > app.now()
               order by s.starts_at limit 4`),
      ])
      const bits: string[] = []
      if (row) {
        bits.push(
          `- ${n(row, 'players')} of their children/players active on the roster, ${n(row, 'enrolled')} live enrolment(s)`,
        )
      }
      if (next && next.length) {
        bits.push(`- their next session(s), soonest first (up to 4 shown) — use these times verbatim:`)
        for (const r of next) bits.push(`    · ${sessionLine(r)}`)
      } else if (next) {
        // Only when the query actually RAN and returned nothing. This sentence is the
        // most consequential one in the census — a parent who reads it stays home —
        // and until `many` separated failure from emptiness, a refused or timed-out
        // lookup produced it word for word.
        bits.push(
          `- **nothing is scheduled ahead for them at all.** Not "nothing this week" — nothing. ` +
            `Say so plainly and say what the class normally is; do not infer a next date from the weekly pattern.`,
        )
      } else {
        bits.push(
          `- their upcoming sessions could not be read this turn. Look them up before you answer anything about when a class is, ` +
            `and do not tell them there are none — this is a failed lookup, not an empty diary.`,
        )
      }
      return bits.join('\n')
    }

    return `- nothing on file for them yet: no player, no enrolment, no class.`
  } catch {
    return null
  }
}

/**
 * Layer 4 + the situation. Never cached, and everything time-shaped or
 * tenant-shaped lives here rather than in the prefix.
 */
export async function variableTail(
  id: Identity,
  extra?: {
    clockNote?: string
    taskInstruction?: string
    queryResults?: unknown
    recentLookups?: string
  },
): Promise<string> {
  const tz = id.academy.timezone || 'Asia/Kolkata'
  const at = await now(id.academyId)
  const local = inZone(at, tz)
  const [academyMemory, personMemory, whatExists] = await Promise.all([
    hotSet('academy', id.academyId, id.academyId),
    hotSet('person', id.person.id, id.academyId),
    census(id),
  ])

  const out: string[] = []

  // --- who this is -----------------------------------------------------------
  const roles = id.roles.length ? id.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ') : 'no role yet'
  const who: string[] = [
    `# Who you are talking to`,
    ``,
    `${id.person.full_name} — ${roles}.`,
  ]
  if (id.roles.length > 1) {
    who.push(
      `Roles compose: this is one person wearing several hats, in one thread. Serve all of them. Never ask them to confirm something to themselves.`,
    )
  }
  if (id.isSolo) {
    who.push(
      `This academy is the solo case — one active coach who is also the admin. Shape around it: the day and the brief are one message in one chat, there is nobody to escalate a coverage problem to, and there is no cover to offer. It is not a mode and it gates nothing.`,
    )
  }
  who.push(
    id.seesMoney
      ? `Money is visible to this person: tally lines, payments and balances may be discussed.`
      : `Money is NOT visible to this person. Tally lines, payments and balances never route here — do not quote a balance, a rate or a due amount to them.`,
  )
  if (id.person.notes) who.push(`Notes on file: ${id.person.notes}`)
  out.push(who.join('\n'))

  // --- ids, for SQL only -----------------------------------------------------
  //
  // The ids only. The paragraph that used to close this block — RLS scopes reads,
  // zero rows is not a permissions problem, every INSERT sets academy_id itself —
  // is `SCHEMA_DOC`'s RLS bullet almost word for word, and `SCHEMA_DOC` is in the
  // CACHED prefix while this is in the tail. The tail is rebuilt and re-billed at
  // full price on every single round, so a sentence living in both places is paid
  // for twice and cached once. Everything down here has to be something the prefix
  // structurally cannot hold: this person, this business, this clock.
  const ids = [
    `## Ids for your SQL (never write these into a message)`,
    ``,
    `person_id = ${id.person.id}`,
    `contact_id = ${id.contact.id}`,
  ]
  if (id.coachId) ids.push(`coach_id = ${id.coachId}`)
  if (id.accountIds.length) ids.push(`account_id in (${id.accountIds.join(', ')})`)
  if (id.playerIds.length) ids.push(`player_id in (${id.playerIds.join(', ')})`)
  out.push(ids.join('\n'))

  // --- the academy -----------------------------------------------------------
  const a = id.academy
  const ac: string[] = [
    `# The business`,
    ``,
    `Name: ${a.name}${a.category ? ` — ${a.category}` : ''}`,
    `Timezone: ${tz}. Cancellation window: ${a.cancellation_window_hours}h. Default client reminder lead: ${a.client_reminder_lead_hours}h.`,
    `Payments: ${a.rail}${a.upi_handle ? ` · UPI ${a.upi_handle}` : ' · no UPI handle set'}.`,
    `Onboarding state: ${a.onboarding_state}.`,
  ]
  if (a.onboarding_state !== 'live') {
    ac.push(
      `Not live yet. That is a rule about what you START, not about what you ANSWER: build the roster, send nobody ` +
        `anything they did not ask for, and no reminders, digests or announcements go out. Someone who messages you ` +
        `first is a conversation, and you serve it completely — a coach who has just tapped their invite gets their ` +
        `classes read back and confirms them; a parent who writes in gets a real answer. Going quiet on someone who ` +
        `spoke to you is not being quiet, it is being broken, and they cannot tell the difference.`,
    )
  }
  ac.push(
    ``,
    `Never use the word "academy" in anything you send. Use their own name for the business, or nothing at all.`,
  )
  out.push(ac.join('\n'))

  // --- what exists, from where they stand -------------------------------------
  // The heading used to read "What exists right now", and it was the one claim in
  // the block nothing could keep true: this is built once, before the first round,
  // and the same text is still sitting in the conversation six rounds later — after
  // a plan has created a class, marked a register or onboarded a coach. A model that
  // trusts "right now" over its own committed write will contradict itself inside a
  // single turn. So the heading says when it was read, and the block says what
  // supersedes it.
  if (whatExists) {
    out.push(
      `## What existed when this turn started (as this person can see it)\n\n${whatExists}\n\n` +
        // The closing clause earns its place in an uncached block because it is the
        // one thing the prefix structurally cannot say: the prefix does not know when
        // this text was built. "Never state a number you did not read" is doctrine
        // rule 11 and is already cached — restating it here would be billed on every
        // round and cached on none.
        `Counts and rows already read out of the database, not a plan. They are here so you never have to guess ` +
        `whether something is set up, and so an empty count is something you can act on rather than something you ` +
        `discover mid-sentence. They were read before this turn's first round — a write you have committed since ` +
        `supersedes them.`,
    )
  }

  // --- memory hot sets (§5) --------------------------------------------------
  //
  // The facts themselves, and nothing about how memory works. The paragraph that
  // used to close this block — bounded hot set, search the fact store before
  // saying you don't know, write after replying, correct by superseding — is in
  // the cached prefix already: `SCHEMA_DOC` says academy.memory and person.memory
  // are a cache rebuilt from `memory_fact` and that a correction inserts a
  // superseding row. Restating it here bought nothing and was billed on every
  // round, because the tail is never cached.
  const mem: string[] = [`# Memory`]
  mem.push(
    academyMemory
      ? `## About this business\n${academyMemory}`
      : `## About this business\n(nothing recorded yet)`,
  )
  mem.push(
    personMemory
      ? `## About ${id.person.full_name}\n${personMemory}`
      : `## About ${id.person.full_name}\n(nothing recorded yet)`,
  )

  const vocab = vocabularyPreferences(id.academy.memory)
  if (vocab.length) {
    mem.push(
      `## Their words\n${vocab
        .map((v) => `say "${v.prefer}", not "${v.avoid}"`)
        .join('; ')}. Use their vocabulary and never introduce your own.`,
    )
  }
  out.push(mem.join('\n\n'))

  // --- now -------------------------------------------------------------------
  const nowBits = [
    `# Now`,
    ``,
    `It is ${local.time} on ${longDate(local.date)}, ${tz}.`,
    `Every time you write is in that zone and in their idiom — "tomorrow 6:30pm", "Sat 8am" — never an ISO timestamp and never UTC.`,
  ]
  if (extra?.clockNote) nowBits.push(extra.clockNote)
  out.push(nowBits.join('\n'))

  // --- §10.2 mix -------------------------------------------------------------
  const createdOn = isoDateOf(a.created_on)
  if (createdOn) {
    const age = Math.max(0, dayDiff(createdOn, local.date))
    out.push(`# How much to synthesise\n\n${mixInstruction(age)}`)
  }

  // --- what you already looked up --------------------------------------------
  // History is rebuilt from message *text*, and §4.5 forbids ids in message text,
  // so every id a previous turn fetched was gone by the next one — while the tools
  // still demanded ids. That gap is where invented uuids came from: the slot had to
  // be filled and there was nothing to fill it from. These are the real rows.
  if (extra?.recentLookups) {
    out.push(
      `# What you looked up earlier in this conversation\n\n` +
        `Your own queries and their real results, newest first. Ids here are the only ids you may use — ` +
        `if what you need is not here, run the query again. Never write a uuid you have not read.\n\n` +
        extra.recentLookups,
    )
  }

  // --- the situation ---------------------------------------------------------
  if (extra?.taskInstruction) {
    out.push(`# Your task this turn\n\n${extra.taskInstruction}`)
  }
  if (extra?.queryResults !== undefined) {
    out.push(
      `# Query results in front of you\n\nEvery number you state must trace back to something in here. No baseline present means no comparison claimed.\n\n${formatQueryResults(extra.queryResults)}`,
    )
  }

  return out.join('\n\n')
}

/**
 * lib/agent/context.ts — the layered prompt (§4).
 *
 * STABLE PREFIX  (byte-identical across turns; changes only with schema or doctrine)
 *   preamble · schema · operations framing · catalog · platform · business facts · doctrine
 * VARIABLE TAIL  (never cached)
 *   who this is · academy · memory hot sets · today · situation · query results
 *
 * **`PREFIX-RULES.md` at the repo root governs what may go in here.** Read it before adding
 * a line to any block above the boundary. It carries the admission test, the placement
 * ladder, and the graveyard of things already removed — re-adding one of those needs a
 * drive showing its absence cost something, not a hunch that the model needs telling.
 *
 * The eleven behavior modules that used to sit between schema and operations are
 * gone — retired by measurement, not by taste. The phase-6 arc drove the same
 * lifecycle with and without them, one variable apart: truth tied (253/261 both),
 * the module-free arm's replies were plainer, its two best moments were *derived*
 * from doctrine rather than prescribed, and the prescriptions were implicated in
 * their own arm's two worst behaviors. What the modules held that no principle
 * regenerates — domain facts, platform facts — survives in the two facts blocks
 * below. The choreography does not, and it grew back once: a third of `DOMAIN_FACTS`
 * was prescription again by Aug 2026, which is why the test now lives in a document
 * with the graveyard attached rather than in this comment.
 *
 * ORDER IS FREE AND IT BUYS ATTENTION. Everything above the boundary caches
 * byte-identically whatever sequence it is in, so the sequence is chosen for the
 * reader: facts before principles (a rule about sessions is unreadable before
 * `session` exists), and doctrine LAST, against the boundary, where it is nearest
 * the decision instead of ~35k characters upstream of it.
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
import { errorMessage } from '@/lib/errors'
import { now, inZone } from '@/lib/clock'
import { dayDiff, longDate, formatINR } from '@/lib/format'
import { catalogDigest } from '@/lib/messaging/catalog'
import { isInWindowAt } from '@/lib/messaging/window'
import { PARAM_MAX_CHARS } from '@/lib/messaging/templates'
import { SCHEMA_DOC } from '@/lib/agent/schema-doc'
// The one place an id becomes SQL text. Used by `familyScope` below so the census's own
// predicates are built the way an operation's are, and so an id that is not a uuid throws
// instead of being interpolated.
import { uid } from '@/lib/agent/sql'
import { hotSet } from '@/lib/agent/memory'
import { vocabularyPreferences } from '@/lib/agent/lint'
// The model cannot read `job` — it is global and closed in both directions — so
// its own standing promises reach it the way every other unstorable state does:
// as a line in the tail, put there by the runtime.
import { liveAgentTasks } from '@/lib/jobs'
// The visitor tail (one brain, desk mode). One direction, no cycle: frontdesk/context
// imports only leaf types, and frontdesk/route never reaches back into lib/agent.
import { frontDeskTail } from '@/lib/frontdesk/context'
import { businessesOnThisNumber } from '@/lib/frontdesk/route'
import { matchAcademiesByName } from '@/lib/identity'

/**
 * Doctrine lives on disk as markdown. Resolution tries the working directory
 * first (how Next and tsx both run) and falls back to a path derived from this
 * module's own location.
 *
 * **Anything read here must also be listed in `next.config.ts`.** The path below is
 * assembled at runtime, so Next's output-file tracing — which works by static analysis
 * — cannot see it, and the file is left out of the serverless bundle unless
 * `outputFileTracingIncludes` names it. That is not a theoretical gap: `lib/doctrine.md`
 * was missing from every deployed lambda, this threw on every hosted turn before the
 * model was reached, and the only symptom was that everyone got the loop's apology.
 * It read as a flaky model, not as a missing file, for as long as the deploy was up.
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

/**
 * No count of anything is stated in the prompt: a count is the one thing here
 * that goes stale silently — nothing checks it, and the model cannot tell a
 * miscount from something it has been told to ignore. That is why the capability
 * sentence below says "operations" and not a number of them.
 *
 * This block also absorbed the old `# Situations` section. The two said the same
 * thing — you are not waiting to be told what this situation is called — in blocks
 * ~20k characters apart, which read as two hedges rather than one grant of latitude.
 *
 * The capability sentence lives HERE and not in `lib/doctrine.md`. The reason it
 * was put here is spent: `synthesisDoctrine()` sent doctrine alone to the brief and
 * the digest, which authored no SQL and called no operation, so a capability
 * statement inside doctrine would have been false on that path. **That path is gone**
 * — see the tombstone below `stablePrefix()`. The sentence stays here anyway, because
 * moving it is a prompt change and prompt changes here are made on the evidence of a
 * drive rather than on a tidy-up.
 */
const PREAMBLE = `You are Class Manager: the manager for a coaching business, working inside WhatsApp.

You are not a notification system. You author SQL against the whole database, under
the permissions of whoever is talking to you. You have operations whose arguments are
already resolved for you, and where none of them fit you compose the consequence
chain yourself, as a transaction. You can look at anything you can reach, as often as
you like, before you say or decide anything.

So you are expected to notice things nobody asked you to look for, compose messages
nobody specified, and answer questions nobody anticipated. The structure around you
exists to make that safe, not to prevent it. There is no playbook of situations here,
on purpose: when a stranger writes in, when somebody wants fewer messages, when a
coach quits, when money is disputed, when a schedule moves — work out what the moment
needs. Who is affected, who must hear, what must be confirmed before it is acted on,
what will stop, and who owns what happens next. Derive it; do not wait to be told the
situation has a name.

The people you talk to are running a business between classes, on a phone, with one
hand. They did not read anything. Nobody trained them. Judge every reply by what it
costs them to read and what it saves them to have read it.

WhatsApp is the whole surface. There is no browser, no dashboard and no web page in
this product. Anything form-shaped is a form inside the chat; everything else is a
message.

What follows never changes: the schema you author SQL against, the operations you can
reach for, the moments code will put in front of you, what the platform will and will
not do, the facts of this business's world, and last the doctrine you derive every
situational judgement from. Everything about this particular conversation comes after
it.

Doctrine wins over your instinct. The database wins over all of it.`

const CACHE_BOUNDARY = `---
END OF STABLE PREFIX. Everything above is identical on every turn, for every
person, in every business served. Everything below is this conversation only.
---`

let cachedPrefix: string | null = null

/**
 * What WhatsApp and this runtime will and will not do.
 *
 * Split out of `DOMAIN_FACTS` because they are a different kind of fact answering a
 * different question — *what is even possible here* rather than *how does this
 * business work* — and because the model needs them before it plans, not while it is
 * choosing a tone. Placed with the operating machinery, above the business facts.
 *
 * The old doctrine rule 17 ("you cannot open what they send you") lives here now: it
 * had no principle content at all, and a platform limit filed among values is a limit
 * nobody re-reads.
 *
 * Admission test is `PREFIX-RULES.md`'s. Nothing here is derivable, and nothing here is a
 * recipe: the old "what earns a cold message a read" list and the staged-batch
 * outreach procedure were both cut as choreography — see the graveyard.
 */
const PLATFORM = `# What the platform will and will not do

None of this is derivable, and all of it changes what is worth attempting.

- **You cannot open what they send you.** Photos, voice notes and files do not reach
  you at all — the runtime answers those itself, in words, before you are asked
  anything. So never invite one, never ask for "a photo of the register", and never
  claim to have read one. If somebody refers to something they sent, they were
  already told; carry on from what they have typed. **A shared contact card is the
  exception**: it is a name and a number rather than a file, so it reaches you — and
  it is less work for them than typing a name and a number out: the paperclip in the
  message box, then Contact, then whoever is in their phone.
- **The 24-hour window, and what closing it does to your message.** Being messaged
  first is strictly better than messaging first: free, no template, no block risk, and
  the window opens itself. A button tap is an inbound message, so it re-opens the
  window too. **Out of window, almost nothing you composed survives.** The body is
  replaced by one of eight frozen templates and your words are demoted to a parameter
  inside it; the header, the footer, a list, a form and a link are all dropped; the
  second and third buttons are dropped; the first survives only if it does not commit
  anything, and even then its label is replaced with a generic one like "See the
  details". Your line breaks become " · ". **Whether a given person's window is open
  is something you can look up** — person_directory.window_open, which is
  contact.last_inbound_at falling inside that same 24 hours — and it is worth
  knowing before you build, because the message worth sending into an open window
  and the message worth sending into a shut one are not the same message. Into a
  shut one: plain, no structure to lose, aimed at one useful tap. Somebody whose
  window you cannot see is somebody to write for the shut case.
- **In window, messages carry light formatting and it survives.** What you write is
  converted to WhatsApp's own markup before it goes out: \`**bold**\` and a \`##\`
  heading both become bold, \`- item\` lines become bullets, and a markdown table
  becomes one bulleted line per row. So three things can be three lines instead of one
  paragraph holding all three. There are no links, no headings as such, and no
  horizontal rules — and none of this survives a send that goes out of window.
- **What stops a message without telling you first.** A body over 1,024 characters
  loses every button — and if that body also *points at* the button ("tap Confirm
  below"), the whole message is suppressed instead and they get nothing at all. A
  byte-identical body to the same person is dropped as a repeat: within 5 minutes if
  you are replying to them, within 6 hours if you started it. And there is a cap of
  six messages to one person per rolling 24 hours; replies to something they said are
  never blocked by it, and an admin is exempt entirely, but replies still count toward
  the total — so a long conversation today can be why a reminder does not reach them
  tonight.
- **A group is not a broadcast list.** A WhatsApp group exposes every family's number
  to every other family and reads as a mailing list. A broadcast list lands as a
  normal one-to-one — and delivers only to people who have the admin's number saved
  in their contacts; everyone else gets silence that looks like success. Both facts
  are worth saying at the moment the admin is about to send.
- **The first message to somebody who has never messaged us is the highest-risk send
  in the product.** It lands cold, on a shared number, from a name they do not
  recognise.
- **A block is stronger than an opt-out.** A blocked number is never retried, never
  re-batched, never tried with a different template; if it was a mistake, the recovery
  conversation belongs to the admin, from the admin's own number. And one block in a
  small batch is a signal about the batch, not the person — the sender number is
  shared with other businesses, and a bad run there costs them too.
- **A read can fail, and a failed read means nothing.** A lookup that timed out, a
  database with no connection free, a query that never finished — these happen, and
  they say nothing about what exists and nothing about what this person may see. A
  failed read and an empty one are opposite facts: empty means the answer is nothing,
  failed means there is no answer yet.
- **This product costs the business nothing.** It is free to use — no charge, no
  expiring trial, nothing to pay to start or keep it. An owner asking what it costs
  them is asking exactly that, not about their own fees; answer it plainly and once.`

/**
 * The business facts that used to live inside the behavior modules, extracted and
 * kept when the choreography was retired. The test for a line's presence here is in
 * `PREFIX-RULES.md` and it is short: it is a FACT — about money in Indian coaching
 * businesses, about what this product does on its own, about the people on the other
 * end — that no amount of reasoning from doctrine would produce. Anything a principle
 * regenerates was deleted; anything the schema, an operation's own declaration or the
 * catalog digest already states does not get a second copy here.
 *
 * That test was already written down once, in this comment, and a third of the block
 * became prescription again anyway ("reschedule is the makeup", the staged outreach
 * procedure, the escalation script). It now lives in a document with a graveyard
 * attached, because a test with no record of what it already rejected does not hold.
 *
 * No worked chat examples, deliberately. The phase-6 arc showed the model
 * imitates an example's surface along with its content — bracket-formatted
 * button rows from module prose were typeset into live message bodies as text
 * nobody could tap. Facts state; they do not demonstrate.
 */
const DOMAIN_FACTS = `# Facts of this business's world

How money, schedules and people actually behave in a coaching business, and what this
product does on its own without being asked. Facts, not scripts — reason from the
doctrine to what a moment needs, and reason with these.

Silence
- An opt-out is not a withdrawal. The child stays enrolled and nothing changes about
  their classes; it stops what you start, never what the person asks for. It also
  stops the monthly bill reaching them — that becomes the admin's job, and the admin
  is told so in as many words.
- What actually reaches somebody each month is countable from the message table.

Money
- The commonest true dispute is the out-of-band cancellation: the parent told the
  coach at the court a week ago, nothing is on record, and a per-session line was
  written. The parent is right and the data is wrong. Fix the record — attendance to
  cancelled_timely, an offsetting adjustment — rather than arguing about what was
  said.
- A payment that never arrived is almost never a lie. It is a second UPI handle, a
  typo, or a bank that has not settled — so fix the class of problem rather than the
  instance: two handles in circulation produce this conversation every month.
- Approval is the admin's. A parent asking for a waiver is a request, not an approval:
  propose the exact adjustment and route it, never approve on the strength of the
  person asking. Routing means the admin actually hears it — telling only the person
  who asked is not routing, and "the owner will confirm it" is true only after the
  owner has been sent it.
- A money handover to the admin carries the one fact that changes the reading:
  whether the child is still turning up.
- The tally writes itself, and nothing asks first. A period the person was only
  enrolled for part of is still billed whole — joining on the 17th, leaving on the
  3rd — because pro-rating is a decision a person makes and the machinery will not
  make it for them. What it does do is say so: the owner is shown the days, the
  figure and the difference, once, and can settle it for good. Until they do, the
  full charge stands and an adjustment is what fixes it. Same for a rate change or
  an ending.
- Money from before this product existed is never chased. Billing starts where the
  admin said it starts.
- The records begin when the product does, and the business is usually older. A
  parent who says their child has attended for a year is probably describing the
  notebook era, and an empty table is not evidence against them — it is evidence the
  record starts later. Hold both facts as what they are: "you say X; nothing on file
  here yet, because the records start with me." Never argue somebody out of their own
  history off an empty read, and never repeat their account to anybody else as a fact
  on file — what they SAY becomes a row when the admin confirms it, not before.

Schedule and coverage
- A repeating change is a class change, not many session changes: it edits the slot
  and rematerialises future sessions, and it never clobbers attendance already marked
  or cancellations already made.
- A session is never deleted. Cancelled is a status with a reason; moved is new times
  on the same row; history, attendance and the coach set survive both.
- Who hears: a cancelled session, its enrolled families, with the alternative offered;
  a moved one, the families, once; a coach's decline while others remain assigned,
  nobody outside the coach set, because nothing changed for the parents; a changed
  headcount, the coach — the number, not the story.
- Escalations are about sessions, never people: a session with no confirmed coach,
  never a coach who has not confirmed.
- A coach is one person and cannot be in two places, so their hours are spent by
  everything that assigns them — a class, a slot, a moved session, a cover — and no
  two of those are written down together. An overlap is sometimes intended: two courts
  at one venue, an assistant on half the group. So it is named and decided, never
  silently allowed and never silently refused.

Coaches
- Leaving is an end date, never a delete. History stays attributed — audit and
  payables both need it — and whatever is assigned past the date becomes uncovered
  sessions, a state the product already understands. There is no coach-leaving alert
  to invent.
- Cover is not a concept. Covering for a stretch is assigning them those sessions; a
  returning coach is assigned again.
- Parents hear about a coach change only if something changed for them. A standalone
  broadcast about a routine departure manufactures anxiety about a routine event; a
  genuinely non-routine departure may be said directly.
- A reason for dropping a session is invited, never required, and it reaches the admin
  with the blame removed. A coach who thinks reasons are used against them stops
  giving them, then stops answering.

Strangers
- The profile name on an inbound is the parent's own, self-set and unverified — never
  the child's.
- A trial books on the prospect's own confirmation; the admin holds an undo, never a
  gate. What makes the after-the-fact note actionable: where they came from, and the
  thing they said that a human would want to follow up on.
- The free first class is a rule, not a negotiation, and it is per player. A second
  child gets their own trial, on the same account: one bill, one chat, nothing to set
  up separately — and say so, because people expect a whole second registration.
- A trial stays a trial — free, unbilled — until somebody converts it on purpose.
  Nothing converts it by itself: "she loved it, how do we continue?" is the conversion
  moment, and it is a decision with a billing consequence, so the start date and the
  rate are made explicit rather than waved through as "nothing to set up".

Beginnings
- Building a roster messages nobody, and the silence is stated each time something is
  created that a person could have been told about — because that is each time the
  admin is wondering.
- Everything goes in before anything goes out. Partial state is worse than either
  extreme: a parent with two children reminded about one, a coach seeing one of their
  three sessions.
- A defaulted value is said out loud, once, as a question they can ignore. A default
  that travels silently becomes a price somebody is charged.

Watches and memory
- A promise to look at something later IS a schedule call. Saying it without setting
  one is the worst sentence you can send, because they will believe it.
- What makes a watch trustworthy is that its behaviour is predictable: what you look
  at, how often, against what, when it stops — and that silence is a result. A watch
  that fires and decides to do nothing is the system working.
- The obvious facts are the valuable ones: the word they use for a class, the day they
  always ask about money, who never taps and always types, the coach who needs three
  hours' notice. A timing preference is a fact that acts — set the override, and be
  able to say why.

Escalation
- Two failed turns is a hard trigger, not a judgement call. A third attempt makes it
  worse.
- A client's or a coach's escalation goes to their admin; an admin's goes to the
  platform; and never about a person to that person — the send path drops those.
- The admin's copy carries evidence, not mood: where the person is, their words in
  quotes, how many others are affected, and whether it has happened before. The repeat
  and the blast radius are what turn a complaint into a decision.`

/**
 * Preamble → schema → operations framing → catalog → platform → business facts →
 * doctrine. MUST be byte-identical across turns (§4.4).
 *
 * @mechanism stablePrefix — the whole cached half of the prompt, assembled once and memoised:
 *   preamble, schema, operations framing, catalog digest, platform limits, business facts,
 *   doctrine, then `CACHE_BOUNDARY`. It is byte-identical for every turn, every person and
 *   every business served, and that identity is the entire cost mechanism — a hit costs 3.2%
 *   of a miss and there is no handle to hold, so one date, one id or one per-academy fact
 *   above the boundary makes every turn in the product pay full price. Ordering inside it is
 *   free, which is why doctrine sits last, against the boundary, rather than 35k characters
 *   upstream of the decision.
 *
 * The order is deliberate and is documented in `PREFIX-RULES.md`: what the world contains
 * before how to judge it, and doctrine against the boundary rather than at the top.
 *
 * Memoised on first call rather than at module load: `catalogDigest()` lives in
 * another module, and building at import time would make this file's
 * correctness depend on module evaluation order. The result is the same string
 * either way.
 */
export function stablePrefix(): string {
  if (cachedPrefix !== null) return cachedPrefix

  const parts: string[] = [PREAMBLE]

  /**
   * The front desk, as a MODE of this one brain rather than a second one.
   *
   * The second stable prefix this replaces earned its keep on the old cost model and
   * died with it — a cached hit costs ~3% of a miss — and the second brain's real bill
   * was paid in defects at the seam: the routing misread that founded a business off a
   * coach's message, the lint that could not name a just-founded business (F-EQ), the
   * desk knowledge no tenant turn held and vice versa (F-EO, F-DO, the ace month's
   * owner-seat jam). Byte-stable like everything above the boundary; whether the mode
   * is active is the TAIL's fact. Shipped under an A/B against the two-brain arm,
   * which is the only argument ARCHITECTURE accepts for a shape.
   */
  parts.push(`# The front desk

A conversation that belongs to no business yet is at this number's front desk — the tail
says when that is so, and the four desk verbs exist only there. Three kinds of person
write to a desk, and nothing else: someone looking for classes at a business on this
number; someone who WORKS at one — a coach or helper, who is joined to it as what they
said they are, never founded a business of their own for describing somebody else's; and
someone who runs a business and wants this to manage it. Their first message usually
already says which. Read it before asking, ask once at most, and route: the whole job is
the hand-over, and the moment join_business or start_business succeeds the person is
answered from inside that business, in this same thread, in the next breath — their desk
conversation crosses with them, so nothing they said needs repeating. Anything composed
after that success is a second answer they did not need.

A visitor's question about schedules, fees or rosters is a reason to hand over, not a
thing to apologise for — the desk holds no business's data, and a read on a desk turn
returns empty because nothing is there, not because something is withheld.

What this costs the person USING it is the one question that is not about any business,
and the commonest thing an owner opens with: it is free — no charge, no trial that
expires, nothing to pay to start or keep using it. Say so plainly the first time, then
get back to what it does. Fees their families pay are the business's own and have
nothing to do with this.`)

  parts.push(SCHEMA_DOC.trim())

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

  // Facts before principles, and doctrine LAST. A rule about sessions cannot be read
  // before `session` exists, and doctrine used to sit at position two — ~35k characters
  // upstream of the decode point. Ordering above the boundary is free (the whole block
  // caches byte-identically whatever sequence it is in), so this costs nothing and is
  // the only thing in this file that buys attention rather than spending it.
  parts.push(PLATFORM)
  parts.push(DOMAIN_FACTS)
  parts.push(readDoc('lib/doctrine.md'))

  parts.push(CACHE_BOUNDARY)

  cachedPrefix = parts.join('\n\n')
  return cachedPrefix
}

/**
 * `synthesisDoctrine()` stood here: doctrine alone, sent to the brief and the
 * digest, which authored no SQL and called no operation.
 *
 * **The path it served no longer exists.** The brief and the digest are ordinary
 * turns opened by a job (`lib/jobs/handlers/admin.ts`), so they get the same
 * prefix, the same tools and the same flight recorder as every other turn — which
 * is cheaper, not dearer, because the prefix they can now share is the cached
 * part.
 *
 * Its removal takes a constraint with it. Everything in `lib/doctrine.md` had to
 * be true on a toolless path as well, because this function sent doctrine
 * somewhere that had no tools; that is why the capability sentence lives in
 * `PREAMBLE` rather than in doctrine. Nothing needs to be true on the toolless
 * path when there is no toolless path — so a doctrine line about what the model
 * can reach is now admissible, if a drive ever shows one is needed. The existing
 * placement is left alone: moving it would be a prompt change, and prompt changes
 * here are made on the evidence of a drive, not on a tidy-up.
 */

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
 * A prefetch result, carrying the one thing the runtime knew and used to throw away.
 *
 * @mechanism Read — the type that keeps a prefetch that FAILED (`value` null, `why` set)
 *   apart from one that ran and found nothing (`value` `[]`, `why` null), and carries
 *   `modelQuery`'s own error text along with the gap. The two were one value here, and they
 *   are opposite sentences downstream: a refused or timed-out lookup rendered as a confident
 *   negative is what told a parent nothing was scheduled and told a coach his own pay was not
 *   visible to the product, while the same figure was read out to the owner in another
 *   thread.
 *
 * `value` null with `why` set is a lookup that FAILED. `value` `[]` with `why`
 * null is a lookup that ran and found nothing. The two were the same value here,
 * and `res.error` — the whole reason, already in hand from `modelQuery` — was
 * dropped on the line that produced it.
 *
 * What that cost is on the record. Three turns of the first live week hit
 * `(EMAXCONNSESSION) max clients reached in session mode`, the tail said only
 * "could not be read this turn", and doctrine's *do not assume* forbids inventing
 * a cause — so the model reached for the one cause its prompt did offer, the
 * permission note, and told a coach his own pay was not visible to it. The same
 * figure had come back under the identical seat four times that week, and one
 * message later the same turn read it out to the owner. The gap was stated, the
 * cause was withheld, and the model filled it exactly as doctrine says a mind
 * fills an absence.
 *
 * The model's OWN failed reads have always come back with the full error text
 * (`tools.ts`), and its earlier ones are replayed carrying it (`loop.ts`), whose
 * comment says *knowing a query errored is worth more than silence about it*.
 * This type is that principle applied to the half the runtime writes.
 */
type Read<T> = { value: T | null; why: string | null }

/**
 * The head of a Postgres error, which is the half that names the class.
 *
 * Not the whole text. The useful end of a long error is its detail line, and a
 * detail line naming a column of a table this person may not read is a sentence
 * the tail should not be quoting into a prompt. What decides the model's next
 * move is the class of failure, and the class is on line one.
 */
function firstLine(e: string): string {
  return String(e).split('\n')[0].trim().slice(0, 200)
}

/**
 * The clause that turns a stated gap into an actionable one.
 *
 * Two things travel and neither is derivable from the gap alone: WHAT failed, and
 * that the failure belongs to this runtime rather than to the person. The last
 * clause is the one the record asks for — on two of the three turns above, the
 * model reasoned correctly that it could compute the figure, wrote "let me run the
 * queries fresh", and issued no read at all. Nothing had told it a retry would
 * behave differently, because nothing had told it what went wrong.
 *
 * It does not say "retry": a permanent error (a column that does not exist) and a
 * transient one (a refused connection) arrive through this same clause, and only
 * the text distinguishes them. Handing over the text is what lets the model tell.
 *
 * One sentence, because it repeats — a connection failure kills the whole
 * `Promise.all`, so three blocks render it at once. That repetition is affordable
 * where a long paragraph would not be: this returns '' on every healthy turn, so
 * the tail pays nothing until the moment the words are the point.
 */
function because(why: string | null): string {
  return why
    ? ` The read failed — ${why} — which is this runtime's error, not a fact about them. If that looks ` +
      `transient, run the query yourself before you call anything unavailable.`
    : ''
}

/**
 * The line a failed lookup MUST produce, and the only sanctioned way to turn a
 * `Read` into prose.
 *
 * @mechanism fromRead — renders a `Read`'s value, or, where the read failed, an `unread`
 *   line that states the gap and hands over `because(why)`. The failure text is a REQUIRED
 *   argument, so a call site cannot exist without one and `render` is never handed a failure
 *   to think about. That is what retires the silent hole: five of the nine ways a prefetch
 *   could fail used to drop their block entirely, and string concatenation is silent by
 *   construction — you append one line fewer and the result is a perfectly well-formed
 *   paragraph asserting the opposite of what was read.
 *
 * **A block that renders nothing on failure is the one shape never allowed here.**
 * The tail is the only push channel in the product that must DEGRADE rather than
 * fail — a job that dies is retried and a plan that dies rolls back, but a turn
 * that dies because memory timed out leaves a person with silence, which is the
 * one outcome they cannot tell apart from being ignored. So `census` and
 * `standing` carry on with less, and "carrying on with less", written as string
 * concatenation, is silent by construction: you do not leave a field empty,
 * because there is no field. You append one line fewer and the result is a
 * perfectly well-formed paragraph about a coach with nothing on this week.
 *
 * That was five of the nine ways a prefetch can fail. The admin census returned
 * null and `variableTail` dropped the entire "what existed" section with nothing
 * marking the hole; the coach's sessions and registers were guarded by a count
 * read off the same row that had just failed, so `Number(undefined ?? 0)` made
 * the guard false exactly when it was needed; the family's counts had no `else`
 * at all; and `standing()` — the block built after a woman's stop request
 * evaporated between turns — skipped both its halves on `if (!x.error)`.
 *
 * `fromRead` is the fix that does not rely on anyone remembering. Its failure
 * text is a REQUIRED argument, so a call site cannot exist without one, and
 * `render` is never handed a failure to think about. An empty array back from
 * `render` still means "ran, nothing worth saying" — that state is real and
 * stays available.
 */
function unread(what: string, licenses: string, why: string | null): string {
  return `- ${what} could not be read this turn. ${licenses}${because(why)}`
}

function fromRead<T>(
  read: Read<T>,
  failure: { what: string; licenses: string },
  render: (value: T) => string[],
): string[] {
  return read.value === null ? [unread(failure.what, failure.licenses, read.why)] : render(read.value)
}

/**
 * A census of the business, from the point of view of whoever is talking.
 *
 * @mechanism census — what exists, read before the turn's first round and always under this
 *   person's own RLS, so a coach's census is their classes and a parent's is their children
 *   without anything having to remember to filter it. Counts and rows, never instructions: it
 *   retires the round spent discovering whether anything is set up at all, and the bot that
 *   narrated its own state machine because that was the only fact about the business it held.
 *   Every label in it is prompt and is held to one rule — read the label and its value with
 *   no access to the SQL above it, and the sentence they license must be true.
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
 * **NOTHING IN THIS REPO EVER EXECUTES THE SQL BELOW EXCEPT A LIVE TURN.**
 * `check:schema-doc` compares `SCHEMA_DOC` against the database and `check:rls-doc`
 * compares the permission grid against `pg_policies`; neither reads a line of this,
 * and `probe-ask` skips the census on purpose because it declines to need a
 * database. These statements name real columns — `session_coach.declined_at`,
 * `attendance.session_id`, `coach.status` — by hand.
 *
 * So a migration that renames one does not fail a check, a build or a test. It
 * makes every turn for that role lose its census, on every turn, permanently,
 * and — until `fromRead` below — in complete silence. That is strictly worse than
 * the outage this block was hardened against: an outage is intermittent and gets
 * noticed, and this would simply become how the product behaves. If you change a
 * column any statement here touches, the only thing that will tell you is reading
 * this file.
 *
 * Never a precondition: if the census fails, the turn continues without it — but
 * it now SAYS it failed, because a turn continuing without it and a turn where
 * that thing does not exist are opposite sentences to the person on the phone.
 */
async function census(id: Identity): Promise<string> {
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
  const q = async (sql: string, note: string): Promise<Read<Record<string, unknown>>> => {
    const res = await modelQuery(ctx, sql, note)
    return res.error
      ? { value: null, why: firstLine(res.error) }
      : { value: (res.rows[0] as Record<string, unknown>) ?? null, why: null }
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
  const many = async (sql: string, note: string): Promise<Read<Record<string, unknown>[]>> => {
    const res = await modelQuery(ctx, sql, note)
    return res.error
      ? { value: null, why: firstLine(res.error) }
      : { value: res.rows as Record<string, unknown>[], why: null }
  }

  /**
   * Whose row this is, carried on the row itself.
   *
   * @mechanism censusProvenance — a census row that names a person says, on the same line, which
   *   account it hangs off and whether that account is one this person holds. It retires the
   *   class of defect where the runtime's own heading is the only thing vouching for a row: a
   *   heading says "theirs", the model reads it as certified, and a row that is somebody
   *   else's is repeated back as fact — including, once, a fee.
   *
   * The heading above the family session list says *their* sessions and *use these times
   * verbatim*, and the prompt says the census was "already read out of the database, not a
   * plan … so you never have to guess". That is a strong claim, and on the 30-day run it was
   * spent on a list that had never been filtered: the census named another parent's son, the
   * model's own correctly-scoped read disagreed, and the census won — three times in one turn,
   * in writing. A later turn only recovered because the model happened to read
   * `app.session_roster`, which projects `account_id`, and could finally see that the two
   * children sat on different accounts.
   *
   * So the fact it had to buy a fifth query to learn now travels with the row. This is
   * deliberately not a guarantee restated in prose — the predicate in `familyScope` below is
   * what makes the list theirs, and this is the row's own account saying so independently. If
   * the two ever disagree, the model sees the disagreement instead of a heading that has
   * already resolved it.
   *
   * A row that carries no `account_id` (the coach branch's sessions) gets nothing added, so
   * the one renderer stays the one renderer.
   */
  const censusProvenance = (r: Record<string, unknown>): string => {
    // Absent, not null: `player.account_id` is NOT NULL, so undefined here means the statement
    // never selected the column — which is the coach branch, and it gets nothing added.
    if (r.account_id === undefined) return ''
    const holder = r.account_label ? String(r.account_label) : ''
    // `account` is readable by its own family and by nobody else, so an unreadable holder is
    // not a glitch — it is the row telling you it belongs to a household this person cannot
    // see. Say that, rather than dropping the clause and letting the row pass as unremarkable.
    if (!holder) return ` · account holder not readable from their session`
    return id.accountIds.includes(String(r.account_id))
      ? ` · ${holder}'s account`
      : ` · ${holder}'s account — NOT one of theirs`
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
    // Whose it is still travels: an unreadable clock is no reason to lose the one
    // fact that says the row may not be theirs to be told about at all.
    if (Number.isNaN(at.getTime())) {
      return `${String(r.class_name ?? 'a class')} — start time unreadable, look it up before you state one${censusProvenance(r)}`
    }
    const who = r.who ? `${String(r.who)} — ` : ''
    const venue = r.venue ? ` at ${String(r.venue)}` : ''
    return `${who}${String(r.class_name ?? 'a class')}, ${inZone(at, tz).label}${venue}${censusProvenance(r)}`
  }

  try {
    if (id.roles.includes('admin')) {
      const rec = await q(`select
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
          -- status='invited' is a CLAIM; invited_at is the wire's evidence. A plan can
          -- write the status while send_invite fails its guard, and that row then reads
          -- as an invitation for as long as it lives — five later turns repeated it in
          -- the ramp (F-CI face 4). The two facts are counted apart so the sentence
          -- built from them can only say what actually went out.
          (select count(*) from coach where status = 'invited' and invited_at is not null) as coaches_invited,
          (select count(*) from coach where status = 'invited' and invited_at is null) as coaches_marked_not_sent,
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
             and contact_id <> '${id.contact.id}'::uuid) as sent_to_others,
          -- The two halves of solvency, read together, because separately each of them
          -- is a true sentence about the wrong side. See bothSidesOfTheMoney below.
          (select coalesce(sum(amount_for_session), 0) from coach_pay where worked)
            + (select coalesce(sum(amount), 0) from coach_ledger)                as owed_to_coaches,
          (select coalesce(sum(amount), 0) from tally_line)                      as charged_to_families,
          (select coalesce(sum(amount), 0) from payment where confirmed_at is not null)
                                                                                 as collected`, 'prefetch: admin census')
      return fromRead(
        rec,
        {
          what: 'the business summary — venues, classes, coaches, families, enrolments, sessions ahead',
          licenses:
            'Every count below is missing, not zero. Say nothing about what this business does or does not have ' +
            'set up until you have looked, and never read the hole as an empty business.',
        },
        (row) => {
          // Each line carries what the count MEANS, because a bare zero is the same
          // mistake doctrine's *do not assume* names: true, and not the answer. "0 active
          // coaches" reads as nothing-to-see; "two added, neither invited, so
          // neither can see a thing" is the sentence somebody can act on — and it is
          // still a fact, derived here, not a plan invented by anybody.
          const archived = n(row, 'classes_archived')
          const uninvited = n(row, 'coaches_uninvited')
          const invited = n(row, 'coaches_invited')
          const markedNotSent = n(row, 'coaches_marked_not_sent')
          const outbound = n(row, 'outbound_to_others')
          const sent = n(row, 'sent_to_others')
          /**
           * R8 — a door with no sign. `onboarding_state` is the most consequential
           * value in the product and for a long time the only thing that wrote it was
           * an operation the model had to happen to choose, with nothing anywhere
           * naming the moment that calls for it. So an academy with a full roster
           * could sit in `setup` indefinitely while every proactive path silently
           * suppressed — no error on either side, just a business that never started.
           * The operation is gone (it was one UPDATE and a note) and its one real
           * precondition is a trigger now, so the door is a plain write with a guard
           * behind it; this line is still what puts the sign on it.
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
              (uninvited || invited || markedNotSent
                ? `, and ${uninvited + invited + markedNotSent} who cannot see a session, will not be reminded, and will not know they are expected anywhere: ` +
                  [
                    // Naming the remedy, because the state alone was read as a
                    // thing to report rather than a thing to fix, and the fix is
                    // now one call rather than a link the admin has to forward.
                    uninvited
                      ? `${uninvited} added but never invited — nothing has been sent to them at all; send_invite reaches them directly`
                      : '',
                    invited ? `${invited} invited and not yet confirmed — the invite is out; they have not tapped it` : '',
                    markedNotSent
                      ? `${markedNotSent} MARKED invited with no invite ever sent — the status was written but the ` +
                        `wire shows nothing went (invited_at is empty); never describe their invite as out, and ` +
                        `send_invite is what actually reaches them`
                      : '',
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
            /**
             * @mechanism bothSidesOfTheMoney — what this business owes its coaches, stated on
             *   the same line as what it has charged and what it has actually collected,
             *   because each of those alone is a true sentence about one side of a business
             *   that only makes sense as two.
             *
             *   The cost side accrues off the CALENDAR and needs no human act: a session ends
             *   uncancelled and `coach_pay` calls it worked. The revenue side needs five —
             *   an enrolment, a register, a tally line, a UPI handle and a delivered request —
             *   and stops at the first one missing. So the gap opens by itself, silently, and
             *   the only surface that reported money was `unmarked_billable_session`, which
             *   answers about families alone.
             *
             *   `2026-08-22-16-51-sim-b8xo` #135, on an owner's phone: *"Money: nobody's
             *   unpaid — there's no one on the books yet, and nothing's sitting unbilled."*
             *   True, and about the family side only; Rs1,000 of coach pay stood accrued
             *   against Rs0 of revenue as it was written. By #219 it was Rs7,800 owed and Rs0
             *   taken. The model DID reach that number on day 29 — by writing its own
             *   `coach_pay` query, unprompted, ten days after the owner had gone. It was not a
             *   false sentence anywhere; it was an absent question, and an absent question has
             *   no turn to be fixed in.
             *
             *   Counts, not instructions, like everything else here — nothing tells the model
             *   what to do about a gap, only that there is one to look at.
             *   Closes F-EG.
             */
            (() => {
              const owed = n(row, 'owed_to_coaches')
              const charged = n(row, 'charged_to_families')
              const paid = n(row, 'collected')
              if (owed === 0 && charged === 0 && paid === 0) return ''
              return (
                `money: ${formatINR(owed)} owed to coaches for work already done, ` +
                `${formatINR(charged)} charged to families, ${formatINR(paid)} actually collected` +
                // `owed > 0` matters: a credit note makes `charged` negative, and 0 > -6400
                // read out as "paying out more than it has billed" over a business that owed
                // nobody anything (first live sighting, 2026-08-23-07-44-sim-4hy3). And the
                // verb is accrual, not cash — nothing has been paid out until a settlement.
                (owed > 0 && owed > charged
                  ? ` — this business owes its coaches more than it has billed its families` +
                    (n(row, 'enrolled') === 0 ? ', and nobody is enrolled to bill' : '')
                  : '')
              )
            })(),
          ]
          return bits.filter(Boolean).map((b) => `- ${b}`)
        },
      ).join('\n')
    }

    if (id.coachId) {
      const [rec, next, unmarked] = await Promise.all([
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
              and not exists (select 1 from attendance a where a.session_id = s.id)) as unmarked_total`,
          'prefetch: coach record and counts'),
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
               order by s.starts_at limit 4`, 'prefetch: coach next sessions'),
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
               order by s.starts_at desc limit 3`, 'prefetch: coach unmarked registers'),
      ])
      const row = rec.value
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
          `- their coach record and session counts could not be read this turn. Say nothing about either, ` +
            `and do not read the gap as "none".${because(rec.why)}`,
        )
      }
      bits.push(
        ...fromRead(
          next,
          {
            what: 'their next sessions',
            licenses:
              'Look them up before you name a time, and do NOT tell them nothing is coming up — the list is ' +
              'missing, not empty.',
          },
          (rows) => {
            if (rows.length) {
              return [
                `- their next session(s), soonest first (up to 4 shown) — use these times verbatim:`,
                ...rows.map(
                  (r) =>
                    `    · ${sessionLine(r)}${r.confirmed_at ? '' : ` — they have NOT confirmed this one yet`}`,
                ),
              ]
            }
            // Ran, and came back empty. The count is a second read of the same fact,
            // and where the two disagree the disagreement IS the finding — resolving
            // it silently in favour of the empty list is how "nothing coming up" gets
            // said to a coach who is expected somewhere tomorrow. (A failed list no
            // longer reaches here: `fromRead` answered it above, which is why this
            // sentence can now say "empty" rather than hedging between the two.)
            return n(row, 'upcoming') - n(row, 'upcoming_declined') > 0
              ? [
                  `- the list of their next sessions came back EMPTY, though the count above says there are ` +
                    `${n(row, 'upcoming') - n(row, 'upcoming_declined')}. Two reads of one fact disagree — look ` +
                    `them up before you name a time or say there is nothing.`,
                ]
              : []
          },
        ),
      )
      const unmarkedTotal = n(row, 'unmarked_total')
      bits.push(
        ...fromRead(
          unmarked,
          {
            what: 'the registers they have not marked',
            licenses:
              'Do NOT read the gap as "all marked" — that is the one sentence this line exists to prevent. ' +
              'Look them up before you tell them they are up to date.',
          },
          (rows) => {
            if (rows.length) {
              return [
                `- register(s) still unmarked${
                  unmarkedTotal > rows.length
                    ? ` — ${unmarkedTotal} in total, the ${rows.length} most recent below`
                    : ''
                }, with the id to mark them:`,
                ...rows.map((r) => `    · ${sessionLine(r)} — session_id = ${String(r.session_id)}`),
              ]
            }
            // Same disagreement as the sessions above, one relation over.
            return unmarkedTotal > 0
              ? [
                  `- the list came back EMPTY though the count above says ${unmarkedTotal} register(s) are ` +
                    `unmarked. Two reads of one fact disagree — look them up before you say which, or that ` +
                    `there are none.`,
                ]
              : []
          },
        ),
      )
      return bits.join('\n')
    }

    if (id.accountIds.length || id.playerIds.length) {
      /**
       * The predicate that makes this branch's rows *theirs*.
       *
       * @mechanism familyScope — narrows every statement in the family census to the accounts
       *   and players this person actually holds, the way the coach branch above narrows every
       *   one of its statements to `sc.coach_id`. It retires the class of defect where a census
       *   label says "their children" over rows nothing filtered — a heading that is true for a
       *   coach and false for a parent because one branch was written with the ids in hand and
       *   never used them.
       *
       * The ids were three lines up the whole time: this branch is *entered* on
       * `id.accountIds.length || id.playerIds.length`, and then neither statement mentioned
       * either array. Layer 0 was the only thing standing between a parent and another
       * household — and on the 30-day run layer 0 was not standing there at all, because
       * 0008's family-privacy policies had gone missing from the database. The census duly
       * told Rukmini Sarangi that Devendra Ahluwalia's son Kabir was one of hers, and then
       * disclosed his fee. 0046 has re-applied the RLS; this is the second belt, and it is
       * required whether or not the first one holds. A query that claims "theirs" over rows it
       * never filtered is wrong even on a database where the answer happens to come back
       * right, because the only thing making it right is somewhere else.
       *
       * Both halves are ORed, not ANDed: a person can reach a session through an account they
       * hold *or* through a player row that is them, and an adult player on somebody else's
       * account has the second and not the first. `uid` rejects anything that is not a uuid,
       * and a throw here is caught by this function's own handler — so a malformed id costs
       * the census, which is a stated hole in the prompt, rather than producing a statement
       * with a predicate missing from it. The branch condition guarantees at least one clause,
       * so this never renders an empty `in ()`.
       */
      const familyScope = (alias: string): string => {
        const clauses: string[] = []
        if (id.accountIds.length) clauses.push(`${alias}.account_id in (${id.accountIds.map(uid).join(', ')})`)
        if (id.playerIds.length) clauses.push(`${alias}.id in (${id.playerIds.map(uid).join(', ')})`)
        return `(${clauses.join(' or ')})`
      }
      const [rec, next] = await Promise.all([
        // Both counts were over the whole tenant and were read out as "their children" and
        // "live enrolment(s)" — so in a business with two families the label was arithmetic
        // nobody could check and a number twice the truth. The enrolment count goes through
        // the players rather than carrying a scope of its own, because "their enrolments" and
        // "enrolments of their players" have to be the same set or the two numbers on one line
        // disagree.
        q(`select
          (select count(*) from player pl where pl.active and ${familyScope('pl')}) as players,
          (select count(*) from enrollment e where e.ended_on is null
             and e.player_id in (select pl.id from player pl where ${familyScope('pl')})) as enrolled`,
          'prefetch: family counts'),
        // §9's most-asked question is "what time is his class", and it cost a round
        // every time because the tail carried a count and a bare timestamp. These are
        // the actual rows, already in their words.
        //
        // The account joins are LEFT joins and stay that way. `account` is readable by its own
        // family and nobody else, so an inner join would silently DROP a row this person is
        // entitled to see the moment the holder is out of their reach — and an empty list here
        // is rendered as "nothing is scheduled ahead for them at all", the one sentence in this
        // file a parent acts on by staying home. Provenance may go missing; the session may not.
        many(`select pe.full_name as who, c.name as class_name, s.starts_at, v.name as venue,
                     pl.account_id,
                     coalesce(nullif(acc.display_name, ''), hp.full_name) as account_label
                from session s
                join class c on c.id = s.class_id
                join enrollment e on e.class_id = s.class_id and e.ended_on is null
                join player pl on pl.id = e.player_id and pl.active
                join person pe on pe.id = pl.person_id
                left join account acc on acc.id = pl.account_id
                left join person hp on hp.id = acc.holder_person_id
                left join venue v on v.id = coalesce(s.venue_id, c.venue_id)
               where s.status = 'scheduled' and s.starts_at > app.now()
                 and ${familyScope('pl')}
               order by s.starts_at limit 4`, 'prefetch: family next sessions'),
      ])
      const bits: string[] = []
      bits.push(
        ...fromRead(
          rec,
          {
            what: 'how many children they have on the roster, and how many live enrolments',
            licenses: 'Do not read the gap as none of either.',
          },
          (row) => [
            `- ${n(row, 'players')} of their children/players active on the roster, ${n(row, 'enrolled')} live enrolment(s)`,
          ],
        ),
      )
      bits.push(
        ...fromRead(
          next,
          {
            what: 'their upcoming sessions',
            licenses:
              'Look them up before you answer anything about when a class is, and do NOT tell them there are ' +
              'none — this is a failed lookup, not an empty diary.',
          },
          (rows) =>
            rows.length
              ? [
                  // The heading no longer has to be believed on its own. It says what the
                  // statement was filtered to and hands the check over, because the reason this
                  // list was wrong was that nothing downstream of the heading could tell.
                  `- their next session(s), soonest first (up to 4 shown) — filtered to their own ` +
                    `account(s) and player(s), and each row names the account it sits on. Use these times ` +
                    `verbatim. If a row names an account that is not theirs, believe the row, not this line:`,
                  ...rows.map((r) => `    · ${sessionLine(r)}`),
                ]
              : // Only when the query actually RAN and returned nothing. This sentence is
                // the most consequential one in the census — a parent who reads it stays
                // home — and until `many` separated failure from emptiness, a refused or
                // timed-out lookup produced it word for word.
                //
                // It is now scoped, which makes it narrower as well as truer: it is a fact
                // about their children and about nothing else. F-AD is what the second half is
                // for — the old unscoped version at least happened to be about the business,
                // and read without care this one licenses "there are no classes", which went to
                // a stranger and then to an owner over a business holding four children.
                [
                  `- **nothing is scheduled ahead for their own children at all.** Not "nothing this ` +
                    `week" — nothing. Say so plainly and say what the class normally is; do not infer a ` +
                    `next date from the weekly pattern. This is their roster only and says nothing about ` +
                    `what the business has running for anybody else.`,
                ],
        ),
      )
      return bits.join('\n')
    }

    // The old line here — "nothing on file for them yet: no player, no enrolment,
    // no class" — failed this block's own test: read without the SQL, it licenses
    // "the business has no classes", and that sentence went to a stranger and then
    // to the owner over a business holding four children in three classes (F-AD).
    // The predicate this branch actually tests is that the PERSON has no role, so
    // that is what the label says — and what their session cannot see is named as
    // not-visible, never as not-there.
    return (
      `- no role ties this person to the business yet: no account, no player, no enrolment of theirs. ` +
      `Their session sees nothing beyond their own contact row — so nothing on this line says what the ` +
      `business itself holds. Classes, coaches and families may all exist without being visible from ` +
      `where they stand; never assert the business is new or empty from here.`
    )
  } catch (e) {
    // The census used to return null here and `variableTail` rendered nothing at
    // all — so a throw anywhere above deleted the whole "what existed" section
    // from the prompt, unmarked. An absent section is the one failure a reader
    // cannot notice: the block is unconditional on every healthy turn, so its
    // absence looks like nothing rather than like a hole.
    return unread(
      'what exists in this business',
      'Nothing below this line was read. Do not say what this business does or does not have until you have looked.',
      firstLine(errorMessage(e)),
    )
  }
}

/**
 * The states this person is standing in, which the model must never have to
 * infer.
 *
 * @mechanism standing — puts the states layer 0 already stores in front of the model instead
 *   of leaving them to be reconstructed: questions asked and not answered, mutes and
 *   opt-outs, and the watches this business has already promised — the `job` table is closed
 *   to the model in both directions, so its own standing promises can reach it no other way.
 *   Reconstruction is where the false unsubscribe confirmation came from, and each line says
 *   what it LICENSES, because an unanswered stop request described as a completed one is the
 *   worst sentence this product has ever sent.
 *   Closes F-AF.
 *
 * **Reconstruction is where the false unsubscribe confirmation came from.** A
 * woman asked to be left alone, the confirmation went on her screen, she did not
 * tap it, and the next turn — with nothing anywhere recording the ask — answered
 * her with a full itemised balance and no reference to the request at all. Worse
 * happened the other way: a staged opt-out rendered as "done" in a later turn's
 * context and the model faithfully repeated the lie to the person it was about.
 * Both are the same defect, which is that a state layer 0 stores was not shown.
 *
 * One line each, only when set, so a person with nothing outstanding costs
 * nothing. Every line says what it LICENSES, because a label is prompt and a
 * label nobody reviews as prompt is how "uncovered" told an owner four times
 * that his only coach was unassigned.
 *
 * Never a precondition: if this fails the turn continues without it. It runs
 * under the person's own session like everything else here.
 *
 * **This block has a twin now, and the two are made to read the same way.**
 * `person_directory` (migration 0036) carries `open_questions` and `mutes` for
 * anybody, because this one only ever covered the person in the seat and that
 * taught every turn a false lesson — that the background you need arrives on its
 * own. The predicates below are the view's predicates: `resolved_at is null` on
 * the questions, and `released_at is null AND the until date has not passed` on
 * the mutes. That second half is the one that matters and the view's first draft
 * left it out, which made a mute that lapsed last week come back looking live —
 * two authors of one truth, drifting inside a week of each other. If either
 * predicate changes, both change.
 */
async function standing(id: Identity): Promise<string[]> {
  const ctx: SessionCtx = {
    role: 'user',
    academyId: id.academyId,
    personId: id.person.id,
    contactId: id.contact.id,
  }
  const out: string[] = []
  const isAdmin = id.roles.includes('admin')
  try {
    const [pending, mutes, rules] = await Promise.all([
      modelQuery(
        ctx,
        /**
         * The `not exists` is a belt, and it is here because of what this block
         * SAYS rather than what it selects.
         *
         * The sentence built below asserts three things as fact — they have NOT
         * answered, nothing behind it has happened, never describe it as done —
         * with instruction force, and all three rest on one column being empty.
         * That column was unreliable: `consumeAction` recorded the tap under the
         * tapper, and 0032 gives `cm_user` no write policy on `pending_request`,
         * so the answer was never written and nothing counted the miss. A mother
         * cancelled a class, tapped Yes, and was told the next day she had never
         * answered — the model re-asked, she tapped again inside the notice
         * window, and the second tap overwrote a free cancellation with a charge.
         *
         * `lib/actions.ts` now writes the answer as the runtime, which is the
         * actual fix. This stays because a claim this strong should not rest on a
         * single column: a tapped button on the message IS an answer, whatever the
         * row says, and rows written before the fix are still wrong. Same gate as
         * the sibling invalidation and `resolveQuestion` — `reply`, `view` and
         * `menu` assert nothing, so a card carrying its own [Show me all 12] does
         * not silence its own question.
         */
        `select kind, subject, question,
                to_char(created_at, 'YYYY-MM-DD') as asked_on,
                (expires_at is not null and expires_at < app.now()) as past_expiry,
                (select a.id from action a
                  where a.message_id = pr.message_id
                    and a.consumed_at is null
                    and (a.expires_at is null or a.expires_at > app.now())
                    and a.payload ->> 'kind' in ('operation', 'steps')
                  limit 1) as card_id
           from pending_request pr
          where pr.contact_id = '${id.contact.id}'::uuid and pr.resolved_at is null
            and not exists (select 1 from action a
                             where a.message_id = pr.message_id
                               and a.consumed_at is not null
                               and a.payload ->> 'kind' in ('operation', 'steps', 'noop', 'handoff'))
          order by pr.created_at desc limit 5`,
        'prefetch: standing — questions asked and unanswered',
      ),
      modelQuery(
        ctx,
        `select scope, stated, to_char(until, 'YYYY-MM-DD') as until
           from comm_preference
          where contact_id = '${id.contact.id}'::uuid and released_at is null
            and (until is null or until >= (app.now() at time zone '${(id.academy.timezone || 'Asia/Kolkata').replace(/'/g, '')}')::date)
          order by scope`,
        'prefetch: standing — mutes and opt-outs',
      ),
      modelQuery(
        ctx,
        // No visibility clause: business_rule_cm_user_select (0032) already scopes a
        // non-admin to visibility = 'shared'. RLS is the boundary; restating it here
        // would be a second author of the same rule.
        `select statement, provenance, enforced_by, blessed_at is not null as blessed
           from business_rule
          where retired_at is null
          order by created_at desc limit 12`,
        'prefetch: standing — the rules this business has stated',
      ),
    ])

    // The opt-out, and the half of it that used to evaporate. `opted_out_at` is
    // a decision; an unanswered stop request is not one, and the difference is
    // the whole of F-AF — describing the second as the first is the worst
    // sentence this product has ever sent.
    if (id.contact.opted_out_at) {
      out.push(
        `They have opted out of everything from this business. Nothing reaches them at all — not a reminder, ` +
          `not a bill, not an answer you compose unprompted. Their own message still gets a reply.`,
      )
    }

    // `if (!pending.error)` with no else, until now — and this is the block built
    // after a woman asked to be left alone, was shown a confirmation she never
    // tapped, and got a full itemised balance the next turn as though she had never
    // spoken. Everything that exists to stop that was bypassed by one refused read,
    // silently: the model saw a person with nothing outstanding, which is exactly
    // the state the block was written to deny.
    if (pending.error) {
      out.push(
        unread(
          'anything they have asked and not had answered',
          'This is NOT "nothing outstanding" — it is unknown. Before you answer, read pending_request for this ' +
            'contact yourself, and never tell them something is done or was never asked.',
          firstLine(pending.error),
        ).replace(/^- /, ''),
      )
    } else {
      for (const r of pending.rows as Record<string, unknown>[]) {
        const q = String(r.question ?? '').replace(/\s+/g, ' ').slice(0, 160)
        /**
         * @mechanism card — a live committing card is named to the model BY ID, beside the
         *   question it asks, so consent given in WORDS has a route to the exact stored
         *   payload a tap would replay: `commit({action_id})`. Without it the only spelling
         *   of yes was the tap — an owner who wrote "also tap build timetable go ahead" was
         *   re-staged instead, the run ended with `class` empty, and every staged plan for
         *   every role could only ever be committed by a finger on a screen. The id is read
         *   from rows, the payload replays verbatim through `consumeAction`, and the model
         *   decides only WHETHER their words said yes — never what runs. The other half of
         *   the route is `commitByActionId` (lib/agent/tools.ts), which is what the id here
         *   is FOR.
         */
        const card = r.card_id
          ? ` If THIS message says yes to it — plainly, in any words — commit it yourself: ` +
            `commit({action_id: "${String(r.card_id)}"}) runs exactly what the button on their screen holds. ` +
            `Anything short of a clear yes is not a yes.`
          : ''
        out.push(
          `ASKED AND UNANSWERED (${String(r.kind)} · ${String(r.subject)}, put to them on ${String(r.asked_on)}` +
            `${r.past_expiry ? ', now past its expiry' : ''}): "${q}" — they have NOT answered. That is not a no ` +
            `and it is not a yes: nothing behind it has happened. Never describe it as done, and do not ask it ` +
            `a second way — one question on a screen is answered by one tap.${card}`,
        )
      }
    }

    /**
     * What this turn has already promised to look at, and under what name.
     *
     * The `job` table is closed to the model in both directions — it is global
     * and has no `academy_id` column for a policy to scope on — so this cannot
     * come from a query the model writes. It came from memory instead, because
     * the prefix said to answer it from what you did rather than look it up, and
     * memory across turns is exactly what layer 0 exists to replace.
     *
     * Two things are load-bearing here and neither is the list itself:
     *
     *   - **The SUBJECT is shown, in the words the key is built from.** A second
     *     watch on the same subject supersedes the first (F-C), and that only
     *     works if the next caller can phrase the subject the same way. It could
     *     not see the phrasing. Driven: the turn reasoned correctly that no
     *     second watch was needed, and reflection minted one anyway under a
     *     different name — the duplicate was prevented by an unrelated failure.
     *   - **Restating is safe and is said so**, because the alternative reading
     *     of "you are already watching this" is "do not mention it", and a person
     *     who asks to be chased on Monday should hear that they will be.
     *
     * Scoped like a read: the admin's business is theirs to see whole, and
     * anybody else sees only what was promised in their own conversation.
     */
    try {
      const watches = await liveAgentTasks(id.academyId)
      const mine = id.roles.includes('admin')
        ? watches
        : watches.filter((w) => w.minted_by_contact_id === id.contact.id)
      for (const w of mine.slice(0, 8)) {
        const subject = String(w.subject ?? w.slug ?? '').replace(/\s+/g, ' ').slice(0, 80)
        const when = inZone(w.run_at, id.academy.timezone || 'Asia/Kolkata').label
        /**
         * The SLUG, beside the subject, because it is the only thing `drop_watch` accepts.
         *
         * This block exists so the model stops reconstructing pending state from memory,
         * and it named the watch by its `subject` — the human sentence — while
         * `drop_watch(slug)` takes the machine key. So the one tool for stopping a watch
         * asked for a string that appeared nowhere the model could see it, and the row
         * being formatted here has held both values all along (`liveAgentTasks` selects
         * `coalesce(payload->>'slug', split_part(dedupe_key, ':', 3)) as slug`).
         */
        const slug = String(w.slug ?? '').trim()
        out.push(
          `ALREADY WATCHING "${subject}"${slug ? ` (slug: ${slug})` : ''} — it next looks on ${when}. You ` +
            `promised this and it is real: do not mint a second watch for it, and do not say it is not set up. ` +
            `Scheduling this same subject again REPLACES this one rather than adding to it, so restating the ` +
            `promise is safe.${slug ? ` To stop it, drop_watch with slug "${slug}".` : ''}`,
        )
      }
    } catch {
      /* Never a precondition. A turn without this line is worse, not broken. */
    }

    // The other half, and the more dangerous one to lose: a mute that fails to load
    // reads as a person who never asked for quiet, and the standing jobs are what
    // act on it. A promise of quiet is the most valuable sentence in the product.
    if (mutes.error) {
      out.push(
        unread(
          'their mutes and opt-outs',
          'This is NOT "they asked for nothing" — it is unknown. Read comm_preference for this contact before ' +
            'you start anything unprompted, and treat quiet as possible until you have.',
          firstLine(mutes.error),
        ).replace(/^- /, ''),
      )
    } else {
      for (const r of mutes.rows as Record<string, unknown>[]) {
        const scope = String(r.scope)
        out.push(
          scope === 'all'
            ? `They asked for nothing unprompted at all${r.until ? ` until ${String(r.until)}` : ''}` +
              `${r.stated ? ` — their words: "${String(r.stated)}"` : ''}. Answers to what they say still reach them.`
            : `They asked to hear nothing about ${scope}${r.until ? ` until ${String(r.until)}` : ''}` +
              `${r.stated ? ` — their words: "${String(r.stated)}"` : ''}. The standing jobs read this, so it ` +
              `actually stops; everything outside that scope still reaches them.`,
        )
      }
    }

    /**
     * The rules this business has actually stated — and, for its operator, the fact
     * that it has stated none.
     *
     * @mechanism statedRules — `business_rule` gets its reader: every live rule is in the
     *   tail in the owner's own words, with its provenance and whether any automation
     *   reads it (`enforced_by`, whose NULL is said out loud, as its column comment has
     *   always asked). The empty state is stated too, to the admin only, because the
     *   worst instance of the class was composed INTO an emptiness: "(first class is
     *   free)" volunteered as the business's own rule in a confirmation tail, about a
     *   business that had stated nothing (F-CC). A model shown "no rules on file — a
     *   policy this business has not stated does not exist" has the fact the invention
     *   contradicted; a model shown nothing had nothing to check against.
     *   Closes F-BW.
     */
    if (!rules.error) {
      const statedRules = rules.rows as Record<string, unknown>[]
      if (statedRules.length === 0 && isAdmin) {
        out.push(
          `No business rules are on file. A policy this business has not stated does not exist — there is no ` +
            `trial, no discount, no makeup rule, no "first class free" — however usual such a thing is ` +
            `elsewhere. If a moment seems to need one, ask the owner and store their answer as the rule.`,
        )
      }
      for (const r of statedRules) {
        const who = String(r.provenance) === 'owner_stated' ? 'owner stated' : r.blessed ? 'observed, owner blessed' : 'observed, NOT yet blessed — a suggestion, not a rule'
        const gate = r.enforced_by
          ? `automation reads it via ${String(r.enforced_by)}`
          : `NO automation reads it — you honour it in conversation, and the standing jobs do not; say so if it matters`
        out.push(`BUSINESS RULE (${who}; ${gate}): "${String(r.statement)}"`)
      }
    }
  } catch (e) {
    // Whatever was collected, plus the fact that the rest was not — the partial
    // list is more dangerous than an empty one, because it reads as complete.
    out.push(
      unread(
        'their standing states — open questions, mutes, opt-outs',
        'The list above may be partial. Read pending_request and comm_preference for this contact before you ' +
          'act on what is or is not in it.',
        firstLine(errorMessage(e)),
      ).replace(/^- /, ''),
    )
    return out
  }
  return out
}

/**
 * @mechanism visitorTail — a visitor's tail is the DESK's, not a tenant's: no census
 *   (there is no business to count), no memory, no standing states — the arrival's
 *   asked-state, what this number is, and the businesses their own words named, built
 *   by the same `frontDeskTail` the second desk brain used, so the desk's tail
 *   mechanisms (`whatThisNumberIs`, `answeredSinceAsked`) survive the one-brain merge
 *   byte for byte. The blocks skipped are not merely wasted on a visitor, they are
 *   FALSE for one: a census of the desk academy reads as an empty business, and the
 *   model asserting emptiness to a stranger off it is the exact shape F-AD closed.
 */
async function visitorTail(id: Identity, v: { text: string; arrival: unknown }): Promise<string> {
  const at = await now(id.academyId)
  const businesses = await businessesOnThisNumber(id)
  const arrival = v.arrival as { firstText?: string | null } | null
  const named = [
    ...matchAcademiesByName(arrival?.firstText ?? undefined, businesses),
    ...matchAcademiesByName(v.text, businesses),
  ].filter((a, i, all) => all.findIndex((b) => b.academyId === a.academyId) === i)
  return frontDeskTail({
    identity: id,
    arrival: arrival as never,
    named,
    businesses,
    atIso: at.toISOString(),
  })
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
    recentActions?: string
    /** Set on a front-desk turn: the visitor tail below replaces everything else. */
    visitor?: { text: string; arrival: unknown }
  },
): Promise<string> {
  if (extra?.visitor) return visitorTail(id, extra.visitor)
  const tz = id.academy.timezone || 'Asia/Kolkata'
  const at = await now(id.academyId)
  const local = inZone(at, tz)
  const [academyMemory, personMemory, whatExists, standingStates] = await Promise.all([
    hotSet('academy', id.academyId, id.academyId),
    hotSet('person', id.person.id, id.academyId),
    census(id),
    standing(id),
  ])

  const out: string[] = []

  // --- who this is -----------------------------------------------------------
  const roles = id.roles.length ? id.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ') : 'no role yet'
  const who: string[] = [
    `# Who you are talking to`,
    ``,
    `${id.person.full_name} — ${roles}.`,
  ]
  /**
   * What they told the FRONT DESK, on the turns where the tables cannot say it yet.
   *
   * A person handed over from the desk arrives as a `prospect` with no role, and their
   * roles are what the tail's first line reports — so a coach who has just explained that
   * he coaches reads, to the business, as somebody about whom nothing is known. Watched
   * twice on 22 Aug 2026: Arjun Shetty wrote *"im not the owner im just coach for rahul
   * evening bath mon n thu"*, the desk read him correctly and routed on it, and the owner
   * was still being asked to confirm who he was a week later.
   *
   * Stated only while the rows do not already say it. The moment there is a `coach` row
   * this is noise, and worse than noise if the two ever disagree — the rows win, and this
   * disappears rather than arguing with them.
   */
  const arrivedAs = id.contact.arrived_as
  if (arrivedAs && arrivedAs !== 'unsure' && !id.roles.some((r) => r === 'coach' || r === 'admin' || r === 'account_holder')) {
    who.push(
      `They told the front desk they were a ${arrivedAs}, and nothing in this business has been written down about ` +
        `them yet — that is why they show as ${roles}. It is what they SAID, not a role: it grants nothing and you ` +
        `should treat it as the answer to a question you therefore do not need to ask again.` +
        // The route, stated where the claim is read, because working it out cost six days
        // on the 23 Aug ace month: the desk founded the business off the coach's message
        // 2.4 seconds before the real owner's, and the model rediscovered the transfer
        // path (a confirmation only the seat-holder's tap can answer) on day 8, after the
        // owner had resigned to running the business on paper.
        (arrivedAs === 'owner'
          ? ` An OWNER claim has exactly one route: the current admin's own tap. You cannot write academy_admin ` +
            `and no tool grants seats — stage the question to the current admin now, one tap, their words quoted, ` +
            `and tell this person you have done so. Do not spend rounds looking for another door; there is none.`
          : ''),
    )
  }
  /**
   * Whether what you are about to write survives the wire, stated rather than
   * looked up.
   *
   * @mechanism windowRightHere — the 24-hour window is a property of the person this turn
   *   is addressing, the runtime holds it on the contact row it already loaded, and the
   *   prefix's answer was *"whether a given person's window is open is something you can
   *   look up — person_directory.window_open … it is worth knowing before you build"*.
   *   That paragraph is otherwise complete and correct, and it is a pointer: measured
   *   across `b8xo` and `ceeg`, 220 context tails, the window was stated on 18 of them and
   *   the model had to spend a round to find out on the rest.
   *
   *   What it costs is not a wasted round. 49 of `b8xo`'s 138 sends left as templates, and
   *   THIRTEEN of those 49 went out visibly cut mid-content — `sanitizeParam` flattens the
   *   body to one line and trims it to 700 characters from the END, and a brief is written
   *   lead, then detail, then the ask, so the ask is the part that goes. The prefix
   *   explains the demotion in full and has never named the number, so a model composing
   *   for a shut window had no budget to compose to.
   *
   *   Stated where the composing happens, with the figure, and only when it bites. Nothing
   *   is refused and nothing is rewritten: the model is told what will reach them, and
   *   what to do about it — which is the difference between a constraint and a surprise.
   *   Closes F-EH.
   */
  // Through the one predicate, never the arithmetic: `lib/seed.ts` inlined it
  // against a WINDOW_MS of its own, twice, and `window.ts` says so in its docstring.
  const lastInbound = id.contact.last_inbound_at
  const windowRightHere = isInWindowAt({ last_inbound_at: lastInbound ?? null }, at)
  who.push(
    windowRightHere
      ? `Their 24-hour window is OPEN, so anything you send them now goes as you wrote it — formatting, buttons, a list — and costs nothing.`
      : `Their 24-hour window is SHUT${lastInbound ? '' : ' (they have never written to this number)'}. ` +
        `Anything you send them now leaves as one of the eight frozen templates: your words become a single ` +
        `parameter inside it, flattened to one line with " · " for your line breaks, and CUT TO ${PARAM_MAX_CHARS} CHARACTERS ` +
        `FROM THE END. Put the ask first — what gets lost is whatever you left until last. Their reply, or one ` +
        `tap, reopens the window and the next message goes out whole.`,
  )
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
  /**
   * Three branches, because there were two and the closed one was false twice.
   *
   * `seesMoney` is `app.sees_money()`, and it gates exactly two tables:
   * `tally_line` and `payment` — THE FAMILIES' money. The old sentence read "do
   * not quote a balance, A RATE or a due amount", which is wider than the thing
   * it was describing, in both directions:
   *
   * - **A coach's own pay is not the families' money.** It is `pay_amount` on
   *   their own `coach` row, and 0003 grants it on purpose ("own row INCLUDING
   *   own pay_amount"); SCHEMA_DOC says so in two places. This line is more
   *   specific and arrives later, so it won — and a coach asking what he is paid
   *   was told the product could not see it, twice, once on the last day of a
   *   month, while the same figure was read out to the owner in another thread.
   *   Nothing here is what protects another coach's pay: the `coach` policy is
   *   own-row-only and `coach_public` has no pay column to leak. This sentence
   *   only decides whether a round is spent finding that out.
   * - **What a class costs is not the families' money either.** `rate_amount`
   *   lives on `class`, which everybody may read, and a prospect asking the price
   *   is the moment doctrine's *name the real friction before the booking* exists
   *   for. Told not to quote a rate, the model has been talked out of the one
   *   number the conversation was about.
   */
  const familyMoneyClosed =
    `The families' money is not visible to this person: tally lines, payments and balances never route here. ` +
    `What a class COSTS is a different thing — rate_amount sits on the class, anybody may read it, and saying it plainly is usually the point.`
  who.push(
    id.seesMoney
      ? `Money is visible to this person: tally lines, payments and balances may be discussed.`
      : id.coachId
        ? `${familyMoneyClosed} And their OWN pay is theirs to know: pay_amount and pay_unit are on their own coach row, which they may read, so what they are paid and what they have earned for work already done are answerable to them in full. Never another coach's.`
        : `${familyMoneyClosed} Do not quote a balance or a due amount to them.`,
  )
  if (id.person.notes) who.push(`Notes on file: ${id.person.notes}`)
  // The standing states, last in this block because they outrank everything above
  // them: what somebody asked for and has not had is the first fact about them.
  if (standingStates.length) {
    who.push('', ...standingStates.map((s) => `- ${s}`))
  }
  /**
   * The boundary of this block, said out loud — because every turn otherwise
   * teaches the same false lesson.
   *
   * `standing()` queries `where contact_id = <the seat>`. So the background a
   * turn needs arrives unasked 100% of the time for the person in front of the
   * model and 0% of the time for anybody else, and nothing anywhere marked the
   * edge. The seat that talks ABOUT other people — the owner — is the seat that
   * scored lowest of the four on whether it checked the rows behind the people it
   * was describing, which is doctrine's *work with complete information* failing
   * for a structural reason rather than a careless one.
   *
   * Telling the model to go and look was not enough on its own: roles are four
   * tables and standing is three more, and the sentence that would have sent it to
   * `pending_request` is written INSIDE the description of `pending_request`.
   * `person_directory` is the one place to send it, so now there is one.
   *
   * Unconditional, including when the list above is empty — the empty case is
   * exactly when "nothing outstanding" is easiest to read as being about
   * everybody.
   */
  who.push(
    '',
    `Everything in this block is about this one person. Nobody else's opt-out, mute, unanswered question or open ` +
      `window is in it, and its absence here says nothing about them — person_directory holds the same facts for ` +
      `anybody they mention, and reading it costs no more than the round you are already in.`,
  )
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
  // UNCONDITIONAL. This used to be `if (whatExists)`, and `census()` returned null
  // on every one of its failure paths — so the heading, the counts and the closing
  // provenance clause all disappeared together, leaving a prompt that looked
  // complete. `census()` now always returns prose, and on failure that prose says
  // so, which is why there is nothing left to guard on.
  out.push(
    `## What existed when this turn started (as this person can see it)\n\n${whatExists}\n\n` +
      // The closing clause earns its place in an uncached block because it is the
      // one thing the prefix structurally cannot say: the prefix does not know when
      // this text was built. The provenance rule (doctrine's *do not assume*: every
      // value stated comes off something in front of you this turn) is already
      // cached — restating it here would be billed on every round and cached on none.
      `Counts and rows already read out of the database, not a plan. They are here so you never have to guess ` +
      `whether something is set up, and so an empty count is something you can act on rather than something you ` +
      `discover mid-sentence. They were read before this turn's first round — a write you have committed since ` +
      `supersedes them.`,
  )

  // --- memory hot sets (§5) --------------------------------------------------
  //
  // The facts themselves, and nothing about how memory works. The paragraph that
  // used to close this block — bounded hot set, search the fact store before
  // saying you don't know, write after replying, correct by superseding — is in
  // the cached prefix already: `SCHEMA_DOC` says academy.memory and person.memory
  // are a cache rebuilt from `memory_fact` and that a correction inserts a
  // superseding row. Restating it here bought nothing and was billed on every
  // round, because the tail is never cached.
  //
  // `hotSet` returns null when the read FAILED and '' when the subject genuinely has
  // nothing recorded. Rendering both as "(nothing recorded yet)" told the model it had
  // never learned anything about a business it has served for months — the same
  // failed-read-as-confident-negative shape the census branches below already guard,
  // and worse here, because nothing about a blank memory looks like an error.
  const memoryLine = (title: string, read: { value: string | null; why: string | null }): string =>
    read.value === null
      ? `## ${title}\n(could not be read this turn — this is a failed lookup, NOT an empty memory. ` +
        `Do not act as though you know nothing about them.${because(read.why)})`
      : read.value
        ? `## ${title}\n${read.value}`
        : `## ${title}\n(nothing recorded yet)`

  const mem: string[] = [`# Memory`]
  mem.push(memoryLine('About this business', academyMemory))
  mem.push(memoryLine(`About ${id.person.full_name}`, personMemory))

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

  // Outcomes, labelled as outcomes — the half `recentLookups` deliberately
  // excludes (a write's result replayed as reference data is how something
  // happens twice). What each status LICENSES travels with it, because the
  // motivating failure (F-K) was a refusal described one turn later as a thing
  // that had been done and escalated.
  if (extra?.recentActions) {
    out.push(
      `# What you did earlier in this conversation\n\n` +
        `Your own actions and what actually came of each, newest first. ` +
        `"refused" or "failed" means it did NOT happen — nothing was written, and describing it as done ` +
        `would be false. Do not blindly redo it either: whatever refused it is usually still true. ` +
        `"done" means it already happened — doing it again is how somebody is charged or messaged twice. ` +
        `"staged" means it waits on their tap, not on you. ` +
        // Only cross-conversation replies reach this block (`recentActions`),
        // and saying so is what stops their absence reading as "I sent nobody
        // anything": what went to the person in front of you is in the
        // transcript above, not here.
        `A "reply to X" line is a message that left this conversation — what you sent to the person ` +
        `you are talking to is already in the transcript above, so only the ones that went to somebody ` +
        `else are listed here.\n\n` +
        extra.recentActions,
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

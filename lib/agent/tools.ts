/**
 * lib/agent/tools.ts — a general agent on guardrailed primitives (§14.1).
 *
 * Seven generic primitives, not a catalog of hand-built features: read, write
 * (plan/commit/act), message, schedule, UI. Safety is structural, not
 * behavioural — RLS enforces, the diff is computed before commit, and every
 * message goes out the one send path. The floor being solid is what lets the
 * model be free above it.
 */

import { assertSingleReadStatement, modelQuery, withSession, type SessionCtx } from '@/lib/db'
import { now } from '@/lib/clock'
import { newId } from '@/lib/ids'
import { composeAndSend } from '@/lib/messaging/compose'
import { CATALOG, type CatalogId } from '@/lib/messaging/catalog'
import { ONBOARDING_SETUP } from '@/lib/messaging/flows'
import { EXTRA_LIMITS, LIMITS, type SendOutcome, type SuppressReason } from '@/lib/messaging/types'
import { extractBracketButtons, fitTitle } from '@/lib/messaging/repair'
import { AGENT_TASK_CAP, dedupe, enqueue, liveAgentTasks } from '@/lib/jobs'
import { signLink, linkUrl, TTL } from '@/lib/web/jwt'
import { ViewSpecSchema } from '@/lib/web/registry'
import type { Identity } from '@/lib/types'
import { lint } from './lint'
import { searchFacts, writeFact } from './memory'
import type { ToolDecl } from './gemini'
import { audienceFor, executePlan, needsPreview, parseSteps, previewPlan, type PlanStep } from './plan'
import {
  checkActionPayload, checkSteps, humanAssertionNote,
  stripHumanAssertions, stripHumanAssertionsFromArgs, stripHumanAssertionsFromPayload,
} from './steps'
import { jsonLit, lit, uid, OPERATIONS, operationSignature, type OperationName } from './operations'
import { parametersFor } from './schema-json'

export type ToolCtx = {
  session: SessionCtx
  identity: Identity
  turnId: string
  pendingPlans: Map<string, PlanStep[]>
  /**
   * What each pending plan is and how big it is, so the loop can mint the
   * confirmation buttons itself rather than hoping the model remembered to
   * (§4.3, §14.2). Written here, replayed on tap — §2.2 is untouched.
   */
  pendingMeta?: Map<string, { intent: string; summary: string; totalRows: number; needsConfirm: boolean }>
  /** Everything this turn put on the wire, so the loop can report it. */
  outcomes?: SendOutcome[]
  /**
   * This turn carried an image, a voice note or a document. §2.7 makes anything
   * derived from one a proposal rather than a write, and that has to be a
   * property of the runtime rather than a thing the model remembers.
   */
  fromParsedInput?: boolean
  /**
   * Operations that executed directly this turn (no preview, no tap), with the
   * arguments they ran with — so §4.3's follow-up can be offered on the path the
   * model actually takes, not only on the tap path.
   */
  executed?: { op: string; args: Record<string, unknown>; wrote?: { table: string; op: string; after: any[] }[] }[]
  /**
   * A screen the model asked for this turn and has not yet attached to anything.
   *
   * `view` does not send: it returns the screen with a `send_it_with` line telling
   * the model to call `reply(link_screen:"…")`. Watched twice on a live onboarding,
   * the model did the first half and not the second — it called `view(screen:'setup')`
   * and then composed *"tap the button below to set up the business details"* and
   * *"you can fill this in on this page"* with **no button, no link and no form on
   * either message**. The runtime, seeing a bare message, bolted its generic
   * `[What can you do?]` onto one of them. So the first thing a new owner is ever
   * told to do referred to an affordance that did not exist.
   *
   * A tool whose effect depends on the model remembering a second call in a later
   * round is a tool that fails whenever it forgets. The runtime already knows
   * everything it needs — who asked, which screen, for whom — so it attaches it
   * rather than asking. Same reasoning as `pendingMeta` minting confirmations and
   * `withFollowUps` attaching the next step.
   */
  pendingScreen?: { screen: 'setup' | 'register' | 'calendar'; ref?: string; forContactId: string }
  /** Who this turn has already put a message in front of, and it landed. */
  repliedTo?: Set<string>
  /**
   * What this turn actually said to the person whose turn it is.
   *
   * The loop treated the model's *trailing prose* as the reply, which is right only
   * when the model ends by talking. Whenever it answered through `reply`/`message`
   * instead — which is what it does whenever there are buttons, a list or a link —
   * the trailing text is empty, and everything downstream was told the turn said
   * nothing. `writeTurn` recorded an empty reply, and reflection was handed
   * `You replied: (nothing)` about a turn that had just answered correctly.
   *
   * That is not reflection misjudging: it reasoned correctly from a premise the
   * runtime got wrong, scheduled a follow-up for the unanswered greeting, and the
   * job re-sent an onboarding message to a coach who had already confirmed. R3 —
   * the runtime knew and did not say.
   *
   * Filled at the one place a message is recorded as having landed, so no future
   * send path can forget to.
   */
  saidToUser?: string[]
  /**
   * Whether this turn has done anything at all beyond reading: an operation that ran,
   * a plan committed, a plan previewed and waiting on a tap, a watch scheduled.
   *
   * The runtime is the only thing that knows this, and until now it kept it to itself
   * while the model wrote sentences about work it had not done.
   */
  worked?: boolean
  /**
   * Whether something is actually TRUE now — a write that committed, not a plan waiting
   * on a tap. The distinction is the whole of the difference between "I'll add those,
   * tap to confirm" (fine) and "I've updated your UPI handle" (a lie, watched live,
   * while `commit` was refusing the plan and the column was still null).
   */
  committed?: boolean
  /** The promise check fires once per turn, so a second attempt is never silenced. */
  promiseChecked?: boolean
  /**
   * The affordance guard's own budget, separate from `promiseChecked`.
   *
   * They shared one flag, and the two never fire on the same defect: a turn refused
   * once for claiming an action had already spent the budget, so the FIRST time its
   * next message pointed at a button that did not exist, that check was skipped
   * entirely and the message went out. One round of grace each, not one between them.
   */
  affordanceChecked?: boolean
}

/* ------------------------------------------------------------------------- *
 * "I've added those families" — and nothing had run.
 *
 * FINDINGS' second open item, and the most dangerous failure in the product because
 * it reads as success: a reply claiming a completed action, with no write behind it.
 * A person cannot tell it apart from the truth. Watched twice in one round of driving;
 * the onboarding module says an onboarding turn ending in a description has achieved
 * nothing, but that was a prompt rule with no runtime backstop, and prompt rules hold
 * most of the time, which for this one is the same as not holding.
 *
 * It is not a string operation on the message — "I'll send the invite" is a lie or a
 * promise depending on something outside the sentence. But it IS a property of the
 * *turn*: did anything happen. The runtime knows that exactly, so the check belongs
 * where the two facts meet, which is the moment the message is about to be sent.
 *
 * Narrow on purpose, and it fires at most once: a second attempt always goes out.
 * Silencing someone is worse than telling them something slightly wrong, and this
 * guard exists to buy the model one round to make the sentence true — not to argue.
 * ------------------------------------------------------------------------- */

/** The verbs that mean a write happened. Shared by both shapes below. */
const DONE_VERBS =
  'added|created|set|made|booked|cancelled|canceled|moved|sent|recorded|requested|updated|removed|deleted|changed|waived|scheduled|assigned|enrolled|marked|drafted'

const CLAIMED_DONE = new RegExp(
  [
    `\\b(?:i(?:'ve| have)\\s+(?:just\\s+|now\\s+)?(?:${DONE_VERBS}))\\b`,
    `\\b(?:that'?s (?:done|set up|sorted|added|created)|all (?:done|set up|sorted))\\b`,
  ].join('|'),
  'i',
)

/**
 * The bare past tense, opening a line.
 *
 * "I've marked" was caught and *"Requested ₹1,200 from Meena Krishnan"* was not, and
 * the second is how this model actually writes a receipt. Driven twice in one session:
 * *"Sent the request to Meena Krishnan for ₹1,200.00"* and *"Requested ₹1,200 from
 * Meena Krishnan for Aditya's August fees"* — both about money, both with the plan
 * still sitting unconfirmed behind a `[Do it]` button, and neither matched.
 *
 * CASE-SENSITIVE, and anchored to the start of a line. Mid-sentence these words are
 * ordinary English — "the class you added", "sessions cancelled in time are credited"
 * — and this predicate can now substitute a message rather than merely ask for a
 * rewrite, so a false positive costs somebody a real sentence. A capitalised verb
 * opening a line, followed by a determiner, a figure or a name, is a receipt; the same
 * word lower-case mid-paragraph is prose.
 */
const CLAIMED_DONE_OPENER = new RegExp(
  `^\\s*(?:${DONE_VERBS.split('|').map((v) => v[0].toUpperCase() + v.slice(1)).join('|')})` +
    `\\s+(?=[₹\\d"']|the\\b|a\\b|an\\b|your\\b|their\\b|his\\b|her\\b|[A-Z])`,
)

const PROMISED_IMMINENT =
  // "I will try to create the venue first, then the class" — said to an admin, with
  // nothing created and no round left to create it in. There is no "again": the turn
  // ends when the message goes out, so a retry the model announces is a retry nobody
  // will ever run. It is the commonest wording of this failure after an error.
  /\b(?:i'?ll|i will|let me|i'?m going to|i am going to)\s+(?:now\s+|just\s+)?(?:try(?:ing)?\s+(?:to|and|again)\s*)?(?:add|create|set|make|book|cancel|move|send|remind|invite|record|update|remove|delete|change|waive|schedule|assign|enrol|enroll|mark|draft|again)\b/i

/** The sentence this message is making, and whether the turn has anything to back it. */
export function unbackedClaim(body: string): 'claimed' | 'promised' | null {
  if (CLAIMED_DONE.test(body) || CLAIMED_DONE_OPENER.test(body)) return 'claimed'
  if (PROMISED_IMMINENT.test(body)) return 'promised'
  return null
}

/* ------------------------------------------------------------------------- *
 * "Tap the button below" — and there is no button.
 *
 * The same failure as the one above, one layer out: the message does not claim an
 * ACTION happened, it claims an AFFORDANCE is present. Both were watched on the
 * first two minutes of a real onboarding, on the first message a new owner ever
 * receives:
 *
 *   "You can tap the button below to set up the business details…"   — no button
 *   "…you can fill this in on this page."                            — no link
 *   "No problem — here's that link again."                           — no link
 *
 * In all three the runtime then bolted its generic `[What can you do?]` fallback on,
 * so the owner got a sentence pointing at one thing and a button offering another.
 *
 * This is worth checking where general fact-grounding is not, and the difference is
 * the reason `lint.ts` refuses to do number-grounding as a string rule: that would
 * need the database to decide, and no string operation can tell "14 enrollments"
 * from a price. This needs NOTHING outside the message. "Does the body point at an
 * affordance, and does the message carry one" is answerable from the message alone,
 * which makes it a structural check rather than a guess.
 *
 * Deliberately narrow: only phrases that point at a control on THIS message. "I'll
 * send you a link" is a promise about a later message and is not matched.
 * ------------------------------------------------------------------------- */

/** The control words a message can point at. */
const CONTROL = '(?:button|link|form|screen|page)'

const POINTS_AT_AFFORDANCE = new RegExp(
  [
    // "tap the button", "click this link", "use the form"
    `\\b(?:tap|click|press|hit|open|use)\\s+(?:the\\s+|this\\s+|that\\s+|it\\s+)?${CONTROL}\\b`,
    // "the button below", "below to set up"
    `\\b${CONTROL} below\\b`,
    '\\bbelow to\\b',
    // "here's the setup screen", "here's that link again"
    `\\bhere'?s\\s+(?:the|that|your|a)\\s+(?:[\\w-]+\\s+){0,3}${CONTROL}\\b`,
    // "on this page", "in the form"
    `\\b(?:on|in)\\s+(?:this|the)\\s+${CONTROL}\\b`,
  ].join('|'),
  'i',
)

function pointsAtMissingAffordance(body: string, hasAffordance: boolean): boolean {
  return !hasAffordance && POINTS_AT_AFFORDANCE.test(body)
}

/* ------------------------------------------------------------------------- *
 * Declarations
 * ------------------------------------------------------------------------- */

/**
 * Steps cross the wire as a JSON string, not as a declared array of objects.
 *
 * This is not a style choice. A plan step is a five-way union whose branches nest
 * three and four deep — a message carrying buttons carrying action payloads, a
 * schedule carrying a free-form job payload — and Vertex's function-call decoder
 * returns MALFORMED_FUNCTION_CALL on it more often than not once the model tries
 * to build a real one. Measured against the live prompt: two of three attempts came
 * back malformed, zero output tokens, no candidate, no error anyone could read.
 *
 * The failure was invisible in a way that mattered: with every tool available the
 * model would quietly fall back to `read` instead, so reads always worked and
 * writes intermittently did nothing — which is exactly the symptom that looked
 * like a stalling model, an invented tool name, or an empty apology.
 *
 * A string has no shape to malform. Validation does not move: `PlanStepSchema`
 * (lib/agent/plan.ts) is still the only thing that decides what a step is, and it
 * already rejected everything a JSON-schema declaration would have.
 */
const STEPS_PARAM = {
  type: 'string',
  description:
    'A JSON array of steps, as a string. Each element has EXACTLY ONE of these keys:\n' +
    '  {"write": "<one SQL statement: insert/update/delete>"}\n' +
    '  {"operation": {"name": "<operation name>", "args": {…}}}\n' +
    '  {"adjust": {"account_id", "amount", "reason", "player_id"?, "period"?, "description"?}}\n' +
    '  {"message": {"to_contact_id"|"to_person_id", "body", "catalog_id"?, "subject_person_ids"?, "buttons"?: [{"title","action"}]}}\n' +
    '  {"schedule": {"kind", "run_at", "dedupe_key", "payload": {…}}}\n' +
    'Steps run one after another inside ONE transaction, so a later step sees rows an ' +
    'earlier step created. You will not know the id of something you just inserted — do ' +
    'not guess one and do not leave the link empty. Select it back:\n' +
    '  [{"write":"insert into venue (academy_id, name) values (app.academy_id(), \'Green Park\')"},\n' +
    '   {"write":"insert into class (academy_id, name, venue_id, starts_on) values (app.academy_id(), \'Evening\', ' +
    '(select id from venue where name = \'Green Park\' and academy_id = app.academy_id()), date \'2026-08-20\')"}]\n' +
    // The pattern below is safe for `venue`, which has a real unique key on
    // (academy_id, name). It is NOT safe for `class`: 0014 deliberately left
    // classes without one, because §6.3 keeps ended classes forever and last
    // year's "Beginners" must not block this year's. So a class lookup can match
    // several rows, and a subquery used as an expression that returns two rows
    // aborts the whole transaction — measured: an admin's entire second
    // onboarding turn died on `more than one row returned by a subquery used as
    // an expression`, nothing was written, and the model reported it as a SQL
    // syntax problem it could not solve.
    'An id argument may also be ONE parenthesised SELECT, for a row an earlier step in this same ' +
    'plan created — so an operation is never the wrong tool just because you do not have the id. ' +
    'It MUST return exactly one row: a subquery that matches two aborts the whole plan. Venue names ' +
    'are unique per business, so a venue lookup is safe as written. Classes are NOT — ended classes ' +
    'are kept forever and a name may repeat across years — so always narrow a class lookup with ' +
    '`and active` and end it with `order by starts_on desc limit 1`:\n' +
    "  (select id from class where name = 'Beginners' and academy_id = app.academy_id() and active " +
    'order by starts_on desc limit 1)\n' +
    'Better still, if the row already exists, `read` its id first and pass the id itself.\n' +
    '  {"operation":{"name":"create_class","args":{"venue_id":"(select id from venue where name = ' +
    "'Green Park' and academy_id = app.academy_id())\", …}}}\n" +
    'Reach for the operation rather than raw INSERTs. An operation carries consequences the SQL ' +
    'does not — create_class is the only thing that schedules the sessions, and a class inserted ' +
    'by hand has weekly times and no sessions that will ever happen.\n' +
    'Example: [{"operation":{"name":"create_class","args":{"name":"Evening","starts_on":"2026-08-20",' +
    '"slots":[{"weekday":1,"start_time":"18:00","end_time":"19:00"}]}}}]',
}

/**
 * A list crosses the wire as a JSON string too, and for the same reason `plan`
 * does — but this one had a visible price.
 *
 * The declaration it replaces was the deepest object in the whole tool surface:
 * list → sections[] → rows[] → action{}, four levels, one of them a free-form
 * union. §7.2 calls the list-picker "the primary affordance; prose is the
 * fallback", and measured over every message this product had ever sent there
 * were **zero lists**. Not rare — zero. The picker was built, role-aware and
 * reordered by memory, and the only declaration through which the model could
 * ask for one was the shape the decoder handles worst.
 *
 * A capability whose declaration cannot be emitted is indistinguishable, from
 * the outside, from a model that never wants it.
 */
const LIST_PARAM = {
  type: 'string',
  description:
    'A JSON object, as a string: {"buttonText":"Choose","sections":[{"title":"…","rows":[{"title":"…","description":"…","action":{…}}]}]}. ' +
    `Up to ${LIMITS.listRows} rows, titles ≤ ${LIMITS.listRowTitleChars} chars. Each row's action is the same shape a button's is. ` +
    'Reach for a list whenever there are more than three things to choose between — it is the primary affordance, not a fallback.',
}

/**
 * Steps arrive as a JSON string (see `STEPS_PARAM`), but a model that has seen the
 * older shape — or that simply ignores the instruction — may still send an array.
 * Both are accepted: rejecting a correct plan on a formatting technicality is the
 * kind of strictness that costs a turn and teaches nobody anything.
 */
function decodeSteps(raw: unknown): unknown {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return raw ?? []
  const text = raw.trim()
  if (!text) return []
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(
      `steps was a string but not valid JSON (${e instanceof Error ? e.message : String(e)}). ` +
        'It must parse as a JSON array of step objects.',
    )
  }
}

/**
 * Every operation named anywhere in a steps blob, however it arrived.
 *
 * **This missed the spelling the runtime itself accepts, and the cost was the
 * exact regression the `plan` error path was written to prevent.**
 *
 * `normalizeStep` takes both `{"operation":{"name":"add_family","args":{…}}}` and
 * the flatter `{"operation":"add_family","args":{…}}`. This only ever matched the
 * first — so when a model used the second, no operation was recognised, no
 * signature was attached, and the caller fell through to the generic *"steps is a
 * JSON array… fix the shape"* hint. Measured: the model was told to fix an
 * encoding that was already correct, while the real fault — one wrong argument
 * key — went unmentioned even though the error text named it exactly.
 *
 * The error message is also read, not just the payload. Whatever spelling the
 * step arrived in, `${name}:` is how `steps.ts` prefixes the issue, so the
 * operation is recoverable from the complaint itself.
 */
function namedOperationsIn(raw: unknown): string[] {
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '')
  const found = new Set<string>()
  for (const m of text.matchAll(/"(?:name|operation)"\s*:\s*"([a-z_]+)"/g)) {
    if (m[1] && m[1] in OPERATIONS) found.add(m[1])
  }
  return [...found]
}

/** Operations the validator itself complained about, by its own `${name}:` prefix. */
function operationsBlamedIn(message: string): string[] {
  const found = new Set<string>()
  for (const m of message.matchAll(/\b([a-z_]+):/g)) {
    if (m[1] && m[1] in OPERATIONS) found.add(m[1])
  }
  return [...found]
}

/**
 * What each gate means, in words the model can act on. Every one of these is a
 * decision the runtime made on purpose — the useful response is to change course,
 * never to send the message again.
 */
const SUPPRESSION_HELP: Record<SuppressReason, string> = {
  opted_out: 'This person asked this academy to stop messaging them. Nothing reaches them. Tell the admin if it matters.',
  self_confirmation: 'This message asks someone to confirm something about themselves. Send it to whoever actually decides, not to its subject.',
  escalation_about_self: 'This raises a concern about the person it is addressed to. Route it to an admin instead.',
  pre_launch: 'This academy has not launched, so its roster is not messaged yet. Only the admin can be written to during setup.',
  recipient_frequency_cap: 'This person has already had their day\'s worth of unprompted messages. An answer to something they just asked is exempt; an interruption is not.',
  tenant_send_cap: 'This academy has hit its 24-hour send ceiling on the shared number. Nothing more goes out today.',
  out_of_window_no_template: 'The 24-hour window with this person is closed, so only one of the template categories can reach them. Free text cannot.',
  duplicate_idempotency: 'This exact message was already sent once. It is not sent twice.',
  repeat: 'They were told this, word for word, moments ago. Saying it again teaches them nothing — say what changed, or say nothing.',
  no_contact: 'There is no reachable contact row for that recipient in this academy.',
  limit_violation: 'The message breaks a WhatsApp shape limit (length, button count, title length). Rebuild it smaller — this one could not render.',
}

/**
 * The label on the nav-bar door. Kept under `LIMITS.buttonTitleChars` here rather
 * than truncated at the call site: a title trimmed to fit renders as "What else can
 * you do" with the question mark missing, which looks like a bug to the person
 * reading it — and a 21-character title is not a compose error worth suppressing a
 * whole message over, which is what happened the first time this shipped.
 */
export const MENU_BUTTON_TITLE = 'What can you do?'

/* ------------------------------------------------------------------------- *
 * §4.3 — after every action, the natural next step as a button.
 *
 * "A first-class pattern, not a nicety… it teaches capability by demonstration
 * rather than announcement, and it is the discovery mechanism that keeps the
 * natural-language surface from being a blank page."
 *
 * These were reachable only from a button *tap*, which is the one path where the
 * model is not involved — so the guarantee held exactly where it was least
 * needed and lapsed everywhere else. Watched live: an admin added their first
 * coach by typing a sentence, `add_coach` ran directly, and the reply moved
 * straight on to families. The coach sat at `status='added'` — invited by
 * nobody, able to see nothing — and the one step that would have fixed that,
 * §8.1's invite, was never offered. `[Send the invite]` was defined here the
 * whole time.
 *
 * So the runtime appends it whichever way the operation ran.
 * ------------------------------------------------------------------------- */

/** The id of the first row an operation inserted into a table. */
function insertedId(wrote: { table: string; op: string; after: any[] }[] | undefined, table: string): string | null {
  const d = wrote?.find((x) => x.table === table && x.op === 'insert')
  const id = d?.after?.[0]?.id
  return typeof id === 'string' ? id : null
}

export const FOLLOW_UPS: Partial<
  Record<OperationName, (args: any, wrote?: { table: string; op: string; after: any[] }[]) => { title: string; action: any }[]>
> = {
  cancel_session: () => [
    { title: "See who's affected", action: { kind: 'reply', text: `Who was in the session I just cancelled?` } },
  ],
  end_coach: () => [{ title: 'Assign classes', action: { kind: 'reply', text: 'Who should take those sessions?' } }],
  mark_attendance: () => [
    { title: 'Rebook someone', action: { kind: 'reply', text: 'Find a makeup slot for someone who missed' } },
  ],
  client_cancel: () => [
    { title: 'Find a makeup', action: { kind: 'reply', text: 'Find a makeup slot for that class' } },
  ],
  /**
   * The strongest kind of button the surface has, on the moment it matters most.
   *
   * This was `{kind:'reply', text:"Draft the invite for Ravi Menon"}` — a button that
   * types a sentence back and makes the model work the whole thing out again. Watched
   * live: it did, and the id it worked out was `ae9f36b1-…`, which is not a coach. The
   * invite went out addressed to *"Hi them"* and the coach stayed un-invited, from a
   * button the admin had tapped to invite them.
   *
   * §6.5 exists for exactly this: "fully resolved. no ids to look up." The operation has
   * just written the row, so the id is known here, at mint time, with no model in the
   * loop at either end.
   */
  add_coach: (a, wrote) => {
    const coachId = insertedId(wrote, 'coach')
    return [
      coachId
        ? { title: 'Send the invite', action: { kind: 'operation', op: 'send_invite_draft', args: { coach_id: coachId } } }
        : { title: 'Send the invite', action: { kind: 'reply', text: `Draft the invite for ${a?.full_name ?? 'them'}` } },
    ]
  },
  add_family: (a, wrote) => {
    const personId = insertedId(wrote, 'person')
    return [
      personId
        ? { title: 'Send the invite', action: { kind: 'operation', op: 'send_invite_draft', args: { person_id: personId } } }
        : { title: 'Send the invite', action: { kind: 'reply', text: `Draft the invite for ${a?.display_name ?? 'that family'}` } },
    ]
  },
  create_class: () => [{ title: 'Assign a coach', action: { kind: 'reply', text: 'Who coaches that class?' } }],
  record_payment: () => [{ title: 'See the tally', action: { kind: 'reply', text: 'Show me that account tally' } }],
  book_trial: () => [{ title: 'See the schedule', action: { kind: 'reply', text: 'Show me the schedule' } }],
}

/* ------------------------------------------------------------------------- *
 * Button actions, made legal before they are minted
 * ------------------------------------------------------------------------- */

/**
 * Fitting and bracket-button extraction moved to `lib/messaging/repair.ts`, which is
 * imported by `composeAndSend` — the one place all outbound traffic passes. They were
 * applied here and in the loop's trailing message, so which of the two a turn got
 * depended on which path the model took, and jobs and taps got neither. Re-exported
 * because callers here still want them *before* compose, where a repair can still be
 * reported back to the model inside the same turn.
 */
export { extractBracketButtons, fitTitle }

/**
 * The model's most frequent instinct after previewing a plan is to offer a
 * button that commits it — and it reaches for the handle, because the handle is
 * what `commit` takes. Every spelling of that instinct was illegal:
 * `{kind:'operation', op:'commit'}` (commit is a tool, not an operation),
 * `{kind:'steps', steps:'[…]'}` (steps as the JSON string `plan` taught it to
 * write), `[{operation:{name:'commit', args:{handle}}}]` (a step that no
 * executor has). All three were minted or rejected without ever becoming the
 * thing the model plainly meant, and the last one reached a person's phone as a
 * button that did nothing but apologise.
 *
 * A handle is a reference to steps this runtime is already holding. So resolve
 * it — here, at mint time, where §6.5 says resolution belongs — instead of
 * asking the model to inline steps it has no reason to think it must inline.
 */
function resolveAction(raw: unknown, ctx: ToolCtx): { ok: true; action: any } | { ok: false; error: string } {
  let a = raw as any
  if (!a || typeof a !== 'object') {
    return { ok: false, error: 'the action is missing — every button carries one' }
  }
  // The discriminator is the one field with no information in it: an action with
  // `op` and `args` and no `kind` is an operation, and an action with `steps` is
  // a plan, whatever it forgot to say about itself. Refusing these taught the
  // model nothing and cost a person their button.
  if (typeof a.kind !== 'string') {
    if (typeof a.op === 'string') a = { ...a, kind: 'operation' }
    else if (a.steps !== undefined) a = { ...a, kind: 'steps' }
    else if (typeof a.text === 'string') a = { ...a, kind: 'reply' }
    else if (typeof a.viewSpecId === 'string' || typeof a.screen === 'string') a = { ...a, kind: 'view' }
  }
  // `{kind:'replyOption', text}` — a spelling of `reply` that costs the message
  // its buttons. Measured: a model minted `[Add a coach]` and `[Add players]`
  // this way, both were rejected as an unknown kind, and the person got the
  // runtime's bare `[What can you do?]` fallback instead of the two next steps
  // the model had correctly worked out. The intent is unambiguous, so mean it —
  // same reasoning as the `op`/`steps`/`text` inference directly above.
  if (a.kind === 'replyOption' || a.kind === 'reply_option' || a.kind === 'quickReply') {
    a = { ...a, kind: 'reply' }
  }

  const stepsFor = (handle: unknown): PlanStep[] | null => {
    const h = String(handle ?? '')
    return h ? (ctx.pendingPlans.get(h) ?? null) : null
  }
  const summaryFor = (handle: unknown): string =>
    ctx.pendingMeta?.get(String(handle ?? ''))?.summary ?? 'the change we just went through'

  // `{kind:'operation', op:'handoff'}` — a tool name in the operation slot. It
  // means the tool, so route it there rather than refusing on a technicality.
  if (a.kind === 'operation' && String(a.op) === 'handoff') {
    a = { kind: 'handoff', reason: String(a.args?.reason ?? 'they said something is wrong'), summary: String(a.args?.summary ?? '') }
  }

  // {kind:'operation', op:'commit', args:{handle}}
  if (a.kind === 'operation' && String(a.op) === 'commit') {
    const steps = stepsFor(a.args?.handle)
    if (!steps) return { ok: false, error: `no plan is pending under handle "${a.args?.handle}" in this turn` }
    return { ok: true, action: { kind: 'steps', steps, summary: summaryFor(a.args?.handle) } }
  }

  if (a.kind === 'steps') {
    let steps = a.steps
    if (typeof steps === 'string') {
      try {
        steps = JSON.parse(steps)
      } catch {
        return { ok: false, error: 'steps is a string that is not JSON' }
      }
    }
    if (Array.isArray(steps)) {
      // A step that is really "commit that other plan" — splice the plan in.
      const flat: unknown[] = []
      for (const step of steps) {
        // `{commit:{handle}}` — the model writing the tool it knows as if it
        // were a step kind. It means exactly one thing, so mean it.
        const bare = (step as any)?.commit
        const op = (step as any)?.operation ?? (bare ? { name: 'commit', args: bare } : undefined)
        if (op && String(op.name) === 'commit') {
          const inner = stepsFor(op.args?.handle)
          if (!inner) return { ok: false, error: `no plan is pending under handle "${op.args?.handle}" in this turn` }
          flat.push(...inner)
        } else {
          flat.push(step)
        }
      }
      steps = flat
    }
    const checked = checkSteps(steps)
    if (!checked.ok) return { ok: false, error: checked.error }
    // The third model entry point for operation args, and the least obvious: a
    // model-authored button is a plan the model wrote, stored for later replay. A
    // strip that covered only the tool paths would leave a `{confirmed:true}` button
    // mintable — and a button is executed with NO model in the loop, which is the one
    // place a bad payload cannot be recovered from.
    return {
      ok: true,
      action: {
        kind: 'steps',
        steps: stripHumanAssertions(checked.steps),
        summary: String(a.summary ?? 'that change'),
      },
    }
  }

  const checked = checkActionPayload(a)
  if (!checked.ok) return { ok: false, error: checked.error }
  return { ok: true, action: stripHumanAssertionsFromPayload(checked.payload).payload }
}

/**
 * Every plan previewed this turn and still waiting on a yes, in the order they
 * were previewed, as one plan.
 *
 * It used to be `.at(-1)` — the newest one. Asked to create two classes the
 * model previewed both, read both back in one sentence, and the button carried
 * only the second: one tap, one class, no error, and an admin with no way to
 * know. A read-back that names two things has to commit two things.
 */
/**
 * A message that ends by asking a yes-or-no question, answered with a tap.
 *
 * The bare-message backstop offers the menu, which is right for a statement and
 * a non-sequitur after a question: *"Would you like me to do that now?"* followed
 * by a single `[What can you do?]` button leaves the one obvious answer to be
 * typed. Doctrine rule 4 is "buttons first, text always available", and the model
 * writes the question far more reliably than it remembers the two buttons.
 *
 * Deliberately narrow. Only a closing question opening with an auxiliary — the
 * shape English uses for yes-or-no and almost nothing else — qualifies. "What
 * date would you like?" is not one of these and correctly gets the menu instead.
 */
export function closingQuestionButtons(body: string): { title: string; action: any }[] | null {
  const text = body.trim()
  if (!text.endsWith('?')) return null
  const question = (text.match(/[^.!?\n]+\?\s*$/)?.[0] ?? '').trim()
  const YES_NO =
    /^(would|will|shall|should|do|does|did|can|could|is|are|was|were|have|has|had|may|want|ready|happy|ok(ay)?)\b/i
  if (!YES_NO.test(question)) return null
  return [
    { title: 'Yes', action: { kind: 'reply', text: 'yes' } },
    { title: 'No', action: { kind: 'reply', text: 'no' } },
  ]
}

/**
 * §15's two built-in screens, which existed and could not be reached.
 *
 * `/w/[token]` has served four purposes since it was written — setup, register,
 * view, form — and exactly one of them, `view`, had anything that minted a link
 * for it. So §7.1 step 1 ("the form-shaped part of onboarding in one screen, one
 * tap out of the chat, once, ever") and §8.2 step 5 ("`[Take register]` opens the
 * whole roster on one screen") were built, correct, unreachable, and therefore
 * never once used by anybody. Instead a new admin was asked for their
 * cancellation window in chat. Same shape as the menu that had no door.
 *
 * It lives inside `view` rather than as a tool of its own for a hard reason, not
 * a tidiness one: an eleventh declaration breaks the model (see `toolDecls`).
 */
async function builtInScreen(
  ctx: ToolCtx,
  which: string,
  args: any,
): Promise<{ result: unknown; note?: string }> {
  if (which !== 'setup' && which !== 'register' && which !== 'calendar') {
    return {
      result: { error: `there is no screen called "${which}" — it is "setup", "register" or "calendar"` },
    }
  }
  const forContactId = String(args?.for_contact_id ?? ctx.identity.contact.id)
  const target =
    forContactId === ctx.identity.contact.id
      ? { personId: ctx.identity.person.id, contactId: ctx.identity.contact.id }
      : await contactTarget(ctx, forContactId)
  if (!target) return { result: { error: 'no such contact in this business' } }

  if (which === 'setup' && forContactId === ctx.identity.contact.id && !ctx.identity.roles.includes('admin')) {
    return { result: { error: "the setup screen is the admin's — anything on it can be said in chat instead" } }
  }
  const ref = which === 'register' ? String(args?.session_id ?? '') : undefined
  if (which === 'register' && !ref) {
    return { result: { error: "register needs session_id — which session's roster is this?" } }
  }

  // Remembered so the next `reply` in this turn carries it whether or not the model
  // passes `link_screen`. See `ToolCtx.pendingScreen`.
  ctx.pendingScreen = { screen: which, ref, forContactId: target.contactId }

  // No URL comes back. §14.6 is "every link is a button; nothing URL-shaped is pasted
  // into message text", and this tool used to return the signed token with a note asking
  // the model to write it into its message — which is the instruction that put a
  // 300-character JWT on a person's phone. A tool that hands out the thing the rule
  // forbids is the reason the rule is broken.
  //
  // What comes back instead is the action that opens it. `reply` takes it as `link`, or
  // as a `{kind:'view'}` button, and either way the URL is signed by the runtime and
  // never passes through the model.
  return {
    result: {
      ok: true,
      screen: which,
      good_for_minutes: TTL[which],
      for_contact_id: target.contactId,
      send_it_with:
        which === 'register'
          ? `reply(body:"…", link_screen:"register", link_session_id:"${ref}")`
          : which === 'calendar'
            ? 'reply(body:"…", link_screen:"calendar")'
            : 'reply(body:"…", link_screen:"setup")',
      note:
        'One line saying what the screen is, and say plainly they can tell you the same things here instead — ' +
        'the screen is an offer, never a toll. Never write a web address into a message yourself.',
    },
  }
}

/**
 * Sign the link a `reply` asked for, at the moment the message is composed.
 *
 * The model names the screen; the runtime knows the person, the tenant and the TTL, and
 * is the only thing that holds the signing key. That split is the whole point: a URL the
 * model never sees is a URL it cannot paste into prose, cannot truncate, and cannot mint
 * for the wrong person.
 */
async function linkFor(
  ctx: ToolCtx,
  args: any,
  toContactId: string,
): Promise<{ title: string; url: string } | { error: string } | null> {
  const screen = String(args?.link_screen ?? '').trim()
  const viewSpecId = String(args?.link_view_spec_id ?? '').trim()
  if (!screen && !viewSpecId) return null

  const purpose = viewSpecId
    ? 'view'
    : screen === 'register'
      ? 'register'
      : screen === 'setup'
        ? 'setup'
        : screen === 'calendar'
          ? 'calendar'
          : null
  if (!purpose) {
    return {
      error: `there is no screen called "${screen}" — it is "setup", "register" or "calendar", or pass link_view_spec_id`,
    }
  }
  const ref = viewSpecId || (purpose === 'register' ? String(args?.link_session_id ?? '') : '')
  if (purpose === 'register' && !ref) {
    return { error: "a register link needs link_session_id — which session's roster is this?" }
  }

  const target =
    toContactId === ctx.identity.contact.id
      ? { personId: ctx.identity.person.id, contactId: ctx.identity.contact.id }
      : await contactTarget(ctx, toContactId)
  if (!target) return { error: 'no such contact in this business' }

  const token = await signLink(
    {
      academy_id: ctx.session.academyId,
      person_id: target.personId,
      contact_id: target.contactId,
      purpose,
      ...(ref ? { ref } : {}),
    },
    TTL[purpose],
  )
  const fallback = purpose === 'setup' ? 'Open setup' : purpose === 'register' ? 'Open register' : 'Open'
  return { title: fitTitle(args?.link_title || fallback), url: linkUrl(token) }
}

/** The person behind a contact id, under this session's own RLS. */
async function contactTarget(
  ctx: ToolCtx,
  contactId: string,
): Promise<{ personId: string; contactId: string } | null> {
  const rows = await modelQuery(ctx.session, `select id, person_id from contact where id = ${uid(contactId)}`)
    .then((r) => r.rows)
    .catch(() => [])
  const row = rows[0] as { id?: string; person_id?: string } | undefined
  return row?.person_id ? { personId: String(row.person_id), contactId: String(row.id) } : null
}

/**
 * Add §4.3's next step for anything that ran this turn.
 *
 * Applied on both paths a message can leave by — the `reply` tool and the loop's
 * own trailing message — because which one carries a given turn is decided by
 * the model, and a guarantee that depends on that is not a guarantee. The first
 * coach ever added went out through the trailing path, which is why the invite
 * was not offered even after the follow-up existed.
 *
 * The nav-bar door gives way to a real next step: "What can you do?" is what to
 * offer when there is nothing better, and there now is.
 */
export function withFollowUps(
  buttons: { title: string; action: any }[] | undefined,
  ctx: ToolCtx,
): { title: string; action: any }[] | undefined {
  if (!ctx.executed?.length) return buttons
  let out = [...(buttons ?? [])]
  for (const done of ctx.executed) {
    for (const f of FOLLOW_UPS[done.op as OperationName]?.(done.args, done.wrote) ?? []) {
      const already = out.some((b) => b.title === f.title || JSON.stringify(b.action) === JSON.stringify(f.action))
      if (already) continue
      out = out.filter((b) => b.action?.kind !== 'menu')
      if (out.length < LIMITS.buttons) out.push({ title: fitTitle(f.title), action: f.action })
    }
  }
  return out.length ? out : buttons
}

export function pendingConfirmation(ctx: ToolCtx): { steps: PlanStep[]; summary: string } | null {
  const waiting = [...(ctx.pendingMeta?.entries() ?? [])].filter(([, m]) => m.needsConfirm)
  const steps: PlanStep[] = []
  const summaries: string[] = []
  for (const [handle, meta] of waiting) {
    const plan = ctx.pendingPlans.get(handle)
    if (!plan) continue
    steps.push(...plan)
    if (meta.summary) summaries.push(meta.summary.trim())
  }
  if (!steps.length) return null
  // The trailing period used to be stripped from every summary so they could be
  // joined with "; ". A plan summary is not a fragment though — it is one to three
  // whole sentences, and `plan.ts` appends "I'll check back once." when the plan
  // schedules a watch. Stripping the stop turned that into "…I'll check back once",
  // which reached an admin mid-word. Only the join needs it, and only between items.
  const summary =
    summaries.length <= 1
      ? (summaries[0] ?? '')
      : summaries.map((s) => s.replace(/\.$/, '')).join('; ') + '.'
  return { steps, summary: summary || 'the change we just went through' }
}

/**
 * Built on first call, not at module load.
 *
 * `act`'s parameter schema is `enum: Object.keys(OPERATIONS)`, and a module-load
 * constant meant that list was whatever `operations.ts` had finished defining at
 * the moment this file happened to be evaluated. Add one import edge anywhere in
 * the graph and the enum is `[]` — a tool declaration Vertex will not accept, so
 * **every** turn came back `MALFORMED_FUNCTION_CALL` with zero output tokens and
 * the person got "something broke on my side". Nothing in the failure names a
 * module cycle, and nothing would.
 *
 * A declaration that reads another module's exports has to be built lazily. The
 * result is the same string either way, and it stops depending on import order —
 * the same reason `stablePrefix()` is memoised rather than computed at load.
 */
let cachedDecls: ToolDecl[] | null = null

export function toolDecls(): ToolDecl[] {
  if (cachedDecls === null) cachedDecls = buildToolDecls()
  return cachedDecls
}

/**
 * **The ten-declaration ceiling was a misdiagnosis, and it shaped the whole
 * architecture.**
 *
 * What this constant used to say: an eleventh declaration — any eleventh, even
 * one whose whole schema is a single optional string — makes *every* turn come
 * back MALFORMED_FUNCTION_CALL. That was a real observation, and the conclusion
 * drawn from it was wrong.
 *
 * Re-measured with `scripts/probe-ceiling.ts`, against this exact prefix and
 * these exact declarations plus K padding tools, two runs per condition:
 *
 *   gemini-2.5-flash        10 / 11 / 15 / 30 / 60 declarations — clean, 2/2 each
 *   gemini-3-flash-preview  10 / 11 / 15 / 30 / 60 declarations — clean, 2/2 each
 *
 * Sixty works, on the *same model* the ceiling was found on. Google documents the
 * limit as 128 per request and recommends keeping the *active* set to 10-20 for
 * the model's benefit, which is a focus argument, not a decoder one.
 *
 * The likely real cause is documented a few lines above, in `toolDecls`: `act`'s
 * schema is `enum: Object.keys(OPERATIONS)`, and when these were built at module
 * load, one extra import edge made that list empty. An empty enum is a
 * declaration Vertex rejects, and its symptom is precisely "every turn comes back
 * MALFORMED_FUNCTION_CALL with zero output tokens". Adding an eleventh tool
 * perturbs the import graph. The lazy build fixed the cause; this guard outlived
 * it and went on constraining the design for nothing.
 *
 * What it cost while it stood: 20-odd operations hidden behind one `act` with
 * `args:{type:'object'}` and no properties, their signatures carried as prose in
 * the prefix where the decoder cannot use them, and `view` swallowing two
 * unrelated built-in screens to avoid becoming an eleventh tool.
 *
 * The guard stays, at the documented API limit, because a request that exceeds it
 * still fails — just far from here, and unreadably.
 */
const MAX_TOOL_DECLS = 128

/**
 * Whether the operation registry is declared as real functions.
 *
 * On (the default): every operation is its own declaration, with its zod schema
 * projected into the JSON Schema Gemini constrains decoding with, and `act` and
 * the prefix's prose signatures both go away. Off (`OPERATION_TOOLS=0`): the
 * previous shape, one untyped `act`. The flag exists so the two can be measured
 * against each other by `scripts/probe-model.ts` rather than argued about, and
 * should be deleted once they have been.
 */
export const OPERATION_TOOLS = process.env.OPERATION_TOOLS !== '0'

function buildToolDecls(): ToolDecl[] {
  const ops = Object.keys(OPERATIONS)
  if (!ops.length) {
    // Fail where the cause is visible, rather than three layers away as an
    // unreadable finish reason.
    throw new Error('tools: the operation registry is empty — tool declarations were built too early')
  }
  const decls = declare(ops)

  // Two declarations with the same name is an invalid request, and the way it
  // arrives is not as an error naming the duplicate — it is a tool that quietly
  // stops behaving like itself. Caught here because the collision is between two
  // registries that grow independently and neither knows about the other.
  const seen = new Set<string>()
  for (const d of decls) {
    if (seen.has(d.name)) {
      throw new Error(
        `tools: two declarations are both called "${d.name}" — the primitive surface and the operation ` +
          'registry have collided. Add it to PRIMITIVE_NAMES so the primitive wins and the operation stays ' +
          'reachable through a plan step.',
      )
    }
    seen.add(d.name)
  }

  if (decls.length > MAX_TOOL_DECLS) {
    throw new Error(
      `tools: ${decls.length} declarations, and ${MAX_TOOL_DECLS} is the measured ceiling — past it every turn ` +
        `comes back MALFORMED_FUNCTION_CALL with no candidate and no explanation. Fold the new capability into an ` +
        `existing tool (a property on \`view\`, an entry in the operation registry behind \`act\`) instead of ` +
        `declaring another one.`,
    )
  }
  return decls
}

/**
 * One declaration per operation, typed from the registry's own zod schema.
 *
 * The description is the operation's own, plus its consequences where it has
 * them — a declaration is where the model decides *whether* to reach for
 * something, so "this is the only thing that schedules the sessions" belongs
 * here rather than in a paragraph 50k characters upstream.
 */
function declareOperations(ops: string[]): ToolDecl[] {
  return ops.map((name) => {
    const op = OPERATIONS[name as OperationName] as { params?: any; description: string; destructive?: boolean }
    return {
      name,
      description:
        `${op.description}${op.destructive ? ' This is destructive, so it always comes back as a preview to read out before it runs.' : ''}`,
      parametersJsonSchema: parametersFor(op.params),
    }
  })
}

/**
 * Primitives first, then whichever operations do not collide with one.
 *
 * The registry and the primitive surface share at least one name — `remember` is
 * both an operation and a tool — and two declarations with the same name is an
 * invalid request. Worse than invalid: `runTool` resolves operations before the
 * switch, so a colliding name would silently route the *primitive* into the
 * *operation*, and the memory tool would stop existing without anything saying
 * so. The primitive wins, and the shadowed operation stays reachable where it
 * always was — inside a `plan` step and behind a minted button.
 */
function declare(ops: string[]): ToolDecl[] {
  const primitives = declarePrimitives(ops)
  if (!OPERATION_TOOLS) return primitives
  const taken = new Set(primitives.map((t) => t.name))
  return [...declareOperations(ops.filter((n) => !taken.has(n))), ...primitives]
}

/** Names the primitive surface owns, whatever the registry also calls them. */
export function isPrimitiveToolName(name: string): boolean {
  return PRIMITIVE_NAMES.has(name)
}

const PRIMITIVE_NAMES = new Set([
  'read',
  'plan',
  'commit',
  'act',
  'reply',
  'schedule',
  'view',
  'remember',
  'recall',
  'handoff',
])

function declarePrimitives(ops: string[]): ToolDecl[] {
  return [
  {
    name: 'read',
    description:
      'Run one SELECT over the schema. RLS scopes it to what this person may see; 5s and 10k rows. Aggregates, window functions and date maths are all allowed. Always returns a scope line so an obviously wrong denominator is visible. ' +
      // The loop has always executed every function call in a round concurrently
      // (`for (const call of res.functionCalls)`), and nothing anywhere said so — so
      // the model asked one question per round and paid a whole prefix for each. A
      // four-step discovery chain is two rounds instead of four for one sentence here.
      'If you need several unrelated things, ask for them ALL IN THE SAME ROUND — several read calls in one round cost one round between them, while asking one at a time costs a round each.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        // "No semicolon needed" was not the same instruction as "one statement",
        // and a model that wanted two lookups sent them separated by `;` and lost
        // a round to the refusal. Say the constraint, and say what to do instead.
        query: {
          type: 'string',
          description:
            'EXACTLY ONE SELECT (or WITH … SELECT) statement. No semicolon, and never two statements — ' +
            'to fetch several things at once combine them with WITH … UNION ALL, or as sub-selects in one SELECT list.',
        },
        purpose: { type: 'string', description: 'What you are trying to find out. One short line.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'plan',
    description:
      'Compose a transaction of steps, run it, capture the diff and roll back. Nothing is committed and nobody is messaged. Returns a handle to commit with, plus the exact blast radius. Use this for anything touching more than one person, money, or anything destructive.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What this plan is for, in the user\'s terms. Goes in the audit trail.' },
        steps: STEPS_PARAM,
      },
      required: ['intent', 'steps'],
    },
  },
  {
    name: 'commit',
    description:
      'Execute the plan you just previewed, by handle. Only then do its messages go out. You cannot commit a plan you did not preview in this turn.',
    parametersJsonSchema: {
      type: 'object',
      properties: { handle: { type: 'string' } },
      required: ['handle'],
    },
  },
  // Replaced by one typed declaration per operation when OPERATION_TOOLS is on.
  // `args: {type:'object'}` gave the decoder nothing to hold onto, which is the
  // whole reason the registry's schemas now travel as declarations instead.
  ...(OPERATION_TOOLS
    ? []
    : [
        {
          name: 'act',
          description:
            'Run one named operation. If it is a single-row, own-scope, reversible write it executes directly — a diff there is pure friction. If it is bigger, money-touching or destructive it comes back as a preview with a handle instead, for you to read back before committing.',
          parametersJsonSchema: {
            type: 'object',
            properties: {
              operation: { type: 'string', enum: ops },
              args: { type: 'object' },
              intent: { type: 'string' },
            },
            required: ['operation', 'args'],
          },
        },
      ]),
  {
    name: 'reply',
    description:
      'Send a message now, to this person or to someone else, with buttons, a list, or a link. Every button carries an action minted here and replayed verbatim on tap. Offer the natural next step as a button. NEVER write a web address into the body — a link is a button, and link_screen is how you send one.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        to_contact_id: { type: 'string', description: 'Defaults to the person you are talking to.' },
        body: { type: 'string' },
        header: { type: 'string' },
        footer: { type: 'string', description: `≤ ${LIMITS.footerChars} characters` },
        link_screen: {
          type: 'string',
          enum: ['setup', 'register', 'calendar'],
          description:
            "Attach one of the three built-in screens as a tappable button. 'setup' is the whole business on one screen (name, places, weekly times, cancellation notice, where people pay) — the admin's, once, ever; offer it rather than asking six things in chat. 'register' is one session's roster on a page and needs link_session_id. 'calendar' is the next three weeks of sessions, scoped to whatever this person may see — reach for it when somebody asks about more than a day or two of schedule, because a fortnight does not fit in a message. The link is signed for the recipient at send time; you never see or write the address. A message with a link carries no other buttons and no list.",
        },
        link_session_id: { type: 'string', description: "Which session, for link_screen:'register'." },
        link_view_spec_id: { type: 'string', description: 'Attach a view you minted this turn, as a button.' },
        link_title: { type: 'string', description: `The words on the link button. ≤ ${LIMITS.buttonTitleChars} characters.` },
        catalog_id: { type: 'string', description: 'A catalog moment id, when this is one of them.' },
        subject_person_ids: { type: 'array', items: { type: 'string' } },
        buttons: {
          type: 'array',
          maxItems: LIMITS.buttons,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: `≤ ${LIMITS.buttonTitleChars} characters` },
              action: {
                type: 'object',
                description:
                  "One of: {kind:'operation',op,args} · {kind:'steps',steps,summary} · {kind:'reply',text} · {kind:'view',viewSpecId} · {kind:'menu',menu} · {kind:'noop',ack}",
              },
            },
            required: ['title', 'action'],
          },
        },
        list: LIST_PARAM,
      },
      required: ['body'],
    },
  },
  {
    name: 'schedule',
    description:
      'Schedule yourself to look at something later. It runs as an ordinary turn under this person\'s own permissions, and deciding to do nothing is the common and correct outcome. expires_at is REQUIRED — a watch with no expiry is a leak.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Short stable id for this watch, e.g. "meera-fee-followup".' },
        instruction: { type: 'string', description: 'What to check, and what to do about it.' },
        run_at: { type: 'string', description: 'ISO timestamp.' },
        expires_at: { type: 'string', description: 'ISO timestamp. When this stops being worth doing. Required.' },
        context_query: { type: 'string', description: 'A SELECT whose result gives the task its data.' },
      },
      required: ['slug', 'instruction', 'run_at', 'expires_at'],
    },
  },
  {
    name: 'view',
    description:
      'Mint a web page for anything dense, spatial or form-shaped. You author a spec of components and the queries filling them — never markup, and never a web address. It comes back as an id you attach to a message with reply(link_view_spec_id). A view is an upgrade to a text answer, never a prerequisite for one.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        components: {
          type: 'array',
          items: {
            type: 'object',
            description:
              "e.g. {type:'table', title, query} · {type:'prose', markdown} · {type:'form', fields, submit}",
          },
        },
        screen: {
          type: 'string',
          enum: ['setup', 'register', 'calendar'],
          description:
            "Instead of authoring components, link one of the three screens already built — prefer these over composing your own. 'setup' is the whole business in one form (name, venues, hours, cancellation window, UPI) — the admin's, once, ever. 'register' is one session's roster on a page — the coach's, needs session_id. 'calendar' is the next three weeks, scoped by who is asking. None is ever required: anything on them can be said in chat instead.",
        },
        session_id: { type: 'string', description: "Which session, for screen:'register'." },
        for_person_id: { type: 'string', description: 'Defaults to the person you are talking to.' },
        ttl_minutes: { type: 'number' },
      },
    },
  },
  {
    name: 'remember',
    description:
      'Write down a fact worth carrying: vocabulary, a policy, a habit, a preference. Facts, not transcripts. A fact that changes no behaviour was not worth storing.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        subject_kind: { type: 'string', enum: ['academy', 'person'] },
        subject_id: { type: 'string' },
        fact: { type: 'string' },
        supersedes: { type: 'string', description: 'The id of the fact this corrects.' },
      },
      required: ['subject_kind', 'fact'],
    },
  },
  {
    name: 'recall',
    description: 'Search the fact store for something you are not currently carrying.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        subject_id: { type: 'string', description: 'Defaults to this person; pass the academy id for academy facts.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'handoff',
    description:
      'Hand this conversation to a person, with the reason and a short summary. Use it on anger, safety language, a refund or complaint you cannot settle, or anything the tools genuinely cannot serve.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        summary: { type: 'string', description: 'What has happened so far, for the human picking it up.' },
      },
      required: ['reason', 'summary'],
    },
  },
  ]
}

/**
 * `column "full_name" does not exist` — and the runtime knows exactly where it does.
 *
 * §6.2 splits a human into `person`, `contact` and the role rows, which is the right
 * model and the one every reader gets wrong the same way: `select id, full_name from
 * coach`. Postgres answers with a true sentence containing nothing to act on, and the
 * observed next move — watched, twice — was not to fix the join. It was to ask the admin
 * *"could you confirm Ravi Menon's coach ID?"*, which is a uuid, on WhatsApp, to someone
 * who has never seen one.
 *
 * The catalog has the answer and is one query away. A refusal that names the table the
 * column is actually on turns a burnt turn into a corrected join, which is the same
 * repair C16 made for write refusals and the same reason: a database error is only
 * useless because nobody translated it.
 */
async function whereThatColumnLives(ctx: ToolCtx, error: string): Promise<Record<string, unknown>> {
  const m = /column\s+"?([a-z_][a-z0-9_]*)"?\s+does not exist/i.exec(error)
  const column = m?.[1]
  if (!column) return {}
  try {
    const found = await withSession({ role: 'service', academyId: ctx.session.academyId }, async (tx) => {
      return (await tx.unsafe(
        `select table_name from information_schema.columns
          where table_schema = 'public' and column_name = ${lit(column)}
          order by table_name limit 6`,
      )) as unknown as { table_name: string }[]
    })
    if (!found.length) return { hint: `No table has a column called "${column}". Check the schema above.` }
    return {
      column_lives_on: found.map((r) => r.table_name),
      hint:
        `"${column}" is on ${found.map((r) => r.table_name).join(', ')} — join to it rather than selecting it ` +
        'where it is not. A person\'s name is always on `person`; `coach`, `player` and `account` carry a ' +
        'person_id and no name of their own.',
    }
  } catch {
    return {}
  }
}

/* ------------------------------------------------------------------------- *
 * The scope line (§14.2) — plausible-wrong answers, not security, are the real
 * risk with model-authored reads, so every result says what it is out of.
 * ------------------------------------------------------------------------- */

const ENTITY_COLUMNS: [RegExp, string, string][] = [
  [/^(class_id|class_name)$/, 'classes', 'select count(*) from class where active'],
  [/^(player_id|player_name)$/, 'players', 'select count(*) from player where active'],
  [/^(session_id)$/, 'sessions', ''],
  [/^(coach_id|coach_name)$/, 'coaches', "select count(*) from coach where status = 'active'"],
  [/^(account_id)$/, 'accounts', 'select count(*) from account'],
]

const DATE_RE = /^\d{4}-\d{2}-\d{2}/

async function scopeLine(ctx: SessionCtx, rows: Record<string, unknown>[], truncated: boolean): Promise<string> {
  const bits: string[] = [`${rows.length} row${rows.length === 1 ? '' : 's'}${truncated ? ' (capped at 10k)' : ''}`]
  if (rows.length) {
    const cols = Object.keys(rows[0])
    for (const [re, label, totalSql] of ENTITY_COLUMNS) {
      const col = cols.find((c) => re.test(c))
      if (!col) continue
      const distinct = new Set(rows.map((r) => String(r[col] ?? ''))).size
      let total = 0
      if (totalSql) {
        try {
          const [t] = await withSession(ctx, async (tx) => (await tx.unsafe(totalSql)) as unknown as { count: string }[])
          total = Number(t?.count ?? 0)
        } catch {
          total = 0
        }
      }
      bits.push(total ? `${distinct} of ${total} ${label}` : `${distinct} ${label}`)
    }
    // Date span, from whatever looks like a date.
    const stamps: string[] = []
    for (const r of rows) {
      for (const v of Object.values(r)) {
        const s = v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : ''
        if (DATE_RE.test(s)) stamps.push(s.slice(0, 10))
      }
    }
    if (stamps.length) {
      stamps.sort()
      const a = stamps[0]
      const b = stamps[stamps.length - 1]
      bits.push(a === b ? a : `${a} – ${b}`)
    }
  }
  return `Across ${bits.join(', ')}`
}

/* ------------------------------------------------------------------------- *
 * Executors
 * ------------------------------------------------------------------------- */

/**
 * Columns that are machinery, not the thing that was written.
 *
 * `id` is deliberately NOT one of them. It was, and that made this the only place in the
 * product where the model could learn the id of a row it had just created — and it was
 * being withheld. Three turns later, asked to invite the coach it had just added, the
 * model produced a well-formed uuid matching nothing, because the slot had to be filled
 * and there was nothing to fill it from. §4.5 strips ids out of everything *said*; there
 * is no reason to strip them out of what the model is *told*.
 */
const DIFF_NOISE = /^(academy_id|created_at|updated_at)$/

/** One changed row, small enough to read: the columns that carry the meaning. */
function diffRow(row: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!row || typeof row !== 'object') return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (DIFF_NOISE.test(k)) continue
    if (v === null || v === undefined) continue
    out[k] = v instanceof Date ? v.toISOString() : typeof v === 'string' && v.length > 80 ? `${v.slice(0, 80)}…` : v
  }
  return Object.keys(out).length ? out : null
}

/**
 * What a write did, including **what it actually wrote**.
 *
 * This returned counts and nothing else: "inserted 1 class, 3 weekly slots". So the
 * model composed its read-back from its own intention rather than from the row, and the
 * two are not the same thing. Watched live: an admin typed "beginners mon wed fri 6:30
 * to 7:30", the operation wrote `start_time 06:30`, and the reply said *"6:30 to
 * 7:30pm"*. Both halves confident, one of them wrong, and a morning class in the
 * database that nobody will discover until a parent turns up at six in the evening. A
 * wrong write that reads as a right answer is the failure FINDINGS scores first, and it
 * is silent precisely because the runtime kept what it knew to itself.
 *
 * The rows were sitting in `TableDiff.before/after` the whole time — captured inside the
 * transaction for the preview, then discarded on the way to the model. Handing them
 * over costs a few hundred tokens on a write turn and is the only thing standing between
 * "what I meant" and "what is now true".
 */
function compactDiff(r: Awaited<ReturnType<typeof previewPlan>>) {
  const SAMPLE = 4
  return {
    summary: r.summary,
    rows: r.totalRows,
    changes: r.diffs.map((d) => {
      const rows = (d.op === 'delete' ? d.before : d.after).map(diffRow).filter(Boolean).slice(0, SAMPLE)
      return {
        table: d.table,
        op: d.op,
        count: d.count,
        ...(rows.length ? { wrote: rows } : {}),
        ...(d.count > rows.length && rows.length ? { and_more: d.count - rows.length } : {}),
      }
    }),
    messages: r.stagedMessages.map((m) => m.preview),
    scheduled: r.scheduled,
    check: 'Read `wrote` before you describe this. What is in the row is what is true — if it is not what they meant, fix it now rather than describing what you intended.',
  }
}

export async function runTool(
  name: string,
  args: any,
  ctx: ToolCtx,
): Promise<{ result: unknown; note?: string }> {
  // An operation called by its own name is exactly the work `act` already does:
  // one step, previewed or executed by the same `needsPreview` judgement, with
  // the same diff and the same follow-up buttons. Only the declaration changed —
  // routing it here rather than duplicating the executor is what keeps that true,
  // and keeps the button path (`{kind:'operation'}`) and the plan path
  // (`{"operation":{…}}`) agreeing with the tool path about what an operation is.
  if (name in OPERATIONS && !isPrimitiveToolName(name)) {
    args = { operation: name, args: args ?? {}, intent: name }
    name = 'act'
  }

  switch (name) {
    /* ---------------------------------------------------------------- read */
    case 'read': {
      const query = String(args?.query ?? '')
      try {
        assertSingleReadStatement(query)
      } catch (e) {
        return { result: { error: e instanceof Error ? e.message : String(e) } }
      }
      const res = await modelQuery(ctx.session, query)
      if (res.error) return { result: { error: res.error, rows: [], ...(await whereThatColumnLives(ctx, res.error)) } }
      const scope = await scopeLine(ctx.session, res.rows, res.truncated)
      return {
        result: { scope, rowCount: res.rowCount, truncated: res.truncated, ms: res.ms, rows: res.rows.slice(0, 200) },
        note: scope,
      }
    }

    /* ---------------------------------------------------------------- plan */
    case 'plan': {
      let steps: PlanStep[]
      try {
        steps = parseSteps(decodeSteps(args?.steps))
      } catch (e) {
        // Which of the two failures this is decides which sentence helps. A plan
        // rejected for one operation's *arguments* used to be answered with a lecture
        // about the *shape* of a step — correct, irrelevant, and it sent the model
        // round the loop re-encoding an encoding that was already right.
        const message = e instanceof Error ? e.message : String(e)
        // Blamed by the validator, or named in the payload and mentioned in the
        // complaint. Either route is enough to know which signature helps; the
        // second alone missed every flat-spelled step.
        const named = [
          ...new Set([
            ...operationsBlamedIn(message),
            ...namedOperationsIn(args?.steps).filter((n) => message.includes(`${n}:`)),
          ]),
        ]
        const signatures = named.map((n) => operationSignature(n)).filter(Boolean)
        return {
          result: {
            error: `those steps are not valid: ${message}`,
            ...(signatures.length
              ? {
                  hint: 'The shape of the plan is fine — one operation was called with the wrong arguments. Here is what it takes:',
                  signature: signatures,
                }
              : {
                  hint: 'steps is a JSON array, as a string. Each element has exactly one of: write, operation, adjust, message, schedule. Fix the shape rather than resending it.',
                }),
          },
        }
      }
      if (!steps.length) return { result: { error: 'a plan needs at least one step' } }
      // A plan is the model's other route into an operation, and the one that can
      // nest: an operation step, and an operation behind a button on a message step.
      const planStripped: string[] = []
      steps = stripHumanAssertions(steps, planStripped) as PlanStep[]
      const planIgnored = planStripped.length ? { ignored: humanAssertionNote(planStripped) } : null
      const preview = await previewPlan(ctx.session, steps)
      if (!preview.ok) return { result: { ok: false, error: preview.error } }
      const handle = newId()
      const gate = needsPreview(preview, steps, {
        actorContactId: ctx.identity.contact.id,
        fromParsedInput: ctx.fromParsedInput,
      })
      /**
       * A plan nobody needs to confirm is a plan, not a proposal — so it runs.
       *
       * This used to hand back a handle and wait for `commit`, and the wait is where
       * the work went to die. Watched live, on the first four minutes of a real
       * onboarding: `plan` returned `needs_preview: false` with a diff of 2 venues, 3
       * classes and 6 weekly slots; the model replied *"Okay, I've drafted a plan to set
       * up your two venues and three classes"* and never called `commit`. The turn
       * ended. The runtime was still holding eleven validated, diff-computed rows, and
       * it threw all of them away. The admin read a sentence in the past tense and moved
       * on to coaches; the database was empty.
       *
       * There is no version of that wait that is worth having. `needsPreview` is the
       * runtime's own judgement that this touches nobody else, no money, nothing
       * destructive (§14.2, C17) — the same judgement on which `act` executes directly,
       * because "a diff there is pure friction". Two tools were answering one question
       * two different ways, and the inconsistent one lost people's businesses.
       *
       * It also removes a whole round from the commonest write turn in the product.
       */
      if (!gate) {
        const res = await executePlan(ctx.session, steps, String(args?.intent ?? 'a plan that needed no confirmation'), audienceFor(ctx.identity))
        ctx.outcomes?.push(...res.outcomes)
        if (!res.ok) return { result: { ok: false, executed: false, error: res.error } }
        ctx.worked = true
        ctx.committed = true
        return {
          result: {
            ok: true,
            executed: true,
            audit_id: res.auditId,
            ...compactDiff(res),
            sent: res.outcomes.map((o) => o.status),
            // The declaration promises "a handle to commit with", and this branch
            // does not return one because there is nothing left to commit. Saying
            // so costs eight words; not saying so cost a whole round, watched:
            // the model invented a handle, `commit` answered "no such plan
            // handle", and the turn spent a round discovering the tool had
            // already done the work.
            handle: null,
            note: 'This is done — it touched nobody else, no money and nothing destructive, so it ran. There is no handle and nothing to commit: do NOT call commit. Say what you did, in the past tense, and offer the next step as a button.',
            ...planIgnored,
          },
          note: res.summary,
        }
      }

      ctx.pendingPlans.set(handle, steps)
      // A previewed plan is work: the confirmation button carries it, so a message
      // saying "I'll add those, tap to confirm" is true. It is NOT `committed` —
      // nothing is true yet, and a message in the past tense would be a lie.
      ctx.worked = true
      ctx.pendingMeta?.set(handle, {
        intent: String(args?.intent ?? ''),
        summary: preview.summary,
        totalRows: preview.totalRows,
        needsConfirm: gate,
      })
      return {
        result: {
          ok: true,
          handle,
          needs_preview: gate,
          ...compactDiff(preview),
          intent: String(args?.intent ?? ''),
          ...planIgnored,
        },
        note: preview.summary,
      }
    }

    /* -------------------------------------------------------------- commit */
    case 'commit': {
      const handle = String(args?.handle ?? '')
      const steps = ctx.pendingPlans.get(handle)
      // Commit by handle only: the model cannot commit a plan it did not just
      // preview, which is what keeps §2.3 from being advisory.
      if (!steps) return { result: { error: 'no such plan handle — preview it again before committing' } }

      // §14.2 — "preview scales with blast radius", and for anything touching more
      // than one person, money, or anything destructive the row reads *preview and
      // confirm*. Leaving that to the model means it holds most of the time and
      // quietly does not the rest, which is the same as not holding. So the runtime
      // refuses: a plan that needs confirming is committed by the human's tap on a
      // minted action (§2.2), never by the model deciding it has read back enough.
      const meta = ctx.pendingMeta?.get(handle)
      if (meta?.needsConfirm) {
        return {
          result: {
            ok: false,
            committed: false,
            needs_confirmation: true,
            error:
              'This one is too big to commit on your own say-so — it is destructive, touches money, or affects more than one person. ' +
              'Reply with the read-back and offer it as a button: a `steps` action carrying this plan, titled "Confirm" or similar, ' +
              'alongside a `noop` "Cancel". The tap commits it.',
            summary: meta.summary,
          },
        }
      }

      const res = await executePlan(ctx.session, steps, String(args?.intent ?? 'committed a previewed plan'), audienceFor(ctx.identity))
      ctx.pendingPlans.delete(handle)
      ctx.pendingMeta?.delete(handle)
      ctx.outcomes?.push(...res.outcomes)
      if (!res.ok) return { result: { ok: false, error: res.error, sent: 0 } }
      ctx.worked = true
      ctx.committed = true
      return {
        result: {
          ok: true,
          audit_id: res.auditId,
          ...compactDiff(res),
          sent: res.outcomes.map((o) => o.status),
        },
        note: res.summary,
      }
    }

    /* ----------------------------------------------------------------- act */
    case 'act': {
      const opName = String(args?.operation ?? '')
      if (!(opName in OPERATIONS)) return { result: { error: `there is no operation called ${opName}` } }
      // Every operation-named tool is rewritten into `act` above, so this one strip
      // covers both of the model's direct routes into an operation.
      const stripped = stripHumanAssertionsFromArgs(opName, args?.args ?? {})
      args = { ...args, args: stripped.args }
      const ignored = stripped.stripped.length
        ? { ignored: humanAssertionNote(stripped.stripped) }
        : null
      const steps: PlanStep[] = [{ operation: { name: opName as any, args: (args?.args ?? {}) as any } }]
      const preview = await previewPlan(ctx.session, steps)
      if (!preview.ok) return { result: { ok: false, error: preview.error } }
      if (needsPreview(preview, steps, { actorContactId: ctx.identity.contact.id, fromParsedInput: ctx.fromParsedInput })) {
        const handle = newId()
        ctx.pendingPlans.set(handle, steps)
        ctx.worked = true
        ctx.pendingMeta?.set(handle, {
          intent: String(args?.intent ?? opName),
          summary: preview.summary,
          totalRows: preview.totalRows,
          needsConfirm: true,
        })
        return {
          result: {
            ok: true,
            executed: false,
            handle,
            reason: 'this one is worth reading back first',
            ...compactDiff(preview),
            ...ignored,
          },
          note: preview.summary,
        }
      }
      const res = await executePlan(ctx.session, steps, String(args?.intent ?? opName), audienceFor(ctx.identity))
      ctx.outcomes?.push(...res.outcomes)
      if (!res.ok) return { result: { ok: false, executed: false, error: res.error } }
      // The rows, not just the arguments: a follow-up that has to re-derive the id of
      // the thing just created is a follow-up that will one day invent one.
      ctx.executed?.push({
        op: opName,
        args: (args?.args ?? {}) as Record<string, unknown>,
        wrote: res.diffs.map((d) => ({ table: d.table, op: d.op, after: d.after })),
      })
      ctx.worked = true
      ctx.committed = true
      return {
        result: {
          ok: true,
          executed: true,
          audit_id: res.auditId,
          ...compactDiff(res),
          sent: res.outcomes.map((o) => o.status),
          ...ignored,
        },
        note: res.summary,
      }
    }

    /* --------------------------------------------------------------- reply */
    case 'reply': {
      const to = String(args?.to_contact_id ?? ctx.identity.contact.id)

      // One turn, one message per person. The model would compose a good reply,
      // send it, and then keep going with its remaining rounds: the same
      // confirmation twice, once suppressed as a repeat and once reworded just
      // enough to get through, so an admin asking for one setting change got two
      // near-identical messages asking them to confirm it. The `repeat` gate
      // catches identical text; nothing caught a paraphrase.
      //
      // Doctrine rule 1 is quiet by default, and a turn is the unit: whatever
      // else this turn discovers goes in the NEXT message, when they have said
      // something. A first attempt that was suppressed or failed does not count —
      // that person has heard nothing, so a second try is the point.
      if (ctx.repliedTo?.has(to)) {
        return {
          result: {
            error: 'you have already sent this person a message in this turn, and it reached them',
            hint:
              'Do not send a second. If you learned something after sending, it waits for their next message, or rides a ' +
              'button on the one already in front of them. Two messages for one turn is how a manager becomes a ticker.',
          },
        }
      }
      const catalogId = args?.catalog_id && args.catalog_id in CATALOG ? (args.catalog_id as CatalogId) : null
      // Resolve and validate every action BEFORE anything is composed. A button
      // that cannot be minted used to take the whole message down with it, and
      // the error the model got back named no button and suggested no repair —
      // so it retried the same shape until the turn ran out.
      // A button that cannot be minted is dropped; the message still goes.
      //
      // It used to take the whole call down, and the cure was worse than the
      // disease: the model retried, was refused again, retried a third time with
      // a *different* button — and the plan it had previewed was orphaned, while
      // the admin was told their venue and UPI handle were "noted". Nothing had
      // been written. A message missing one button is a smaller failure than a
      // person receiving nothing, or receiving a confident sentence about work
      // that never happened.
      //
      // What was dropped comes back in the result, so the model learns inside
      // the same turn, and the pending-plan substitution below still attaches
      // the confirmation it needed.
      const dropped: { title: string; why: string }[] = []
      let buttons: { title: string; action: any }[] | undefined
      if (Array.isArray(args?.buttons)) {
        buttons = []
        for (const b of args.buttons.slice(0, LIMITS.buttons)) {
          const resolved = resolveAction((b as any)?.action, ctx)
          if (!resolved.ok) {
            dropped.push({ title: String((b as any)?.title ?? ''), why: resolved.error })
            continue
          }
          buttons.push({ title: fitTitle((b as any)?.title), action: resolved.action })
        }
      }

      // A read-back whose button does not carry the plan is a dead end. `pendingPlans`
      // lives for one turn, so a button that merely replays "yes, do it" as text sends
      // the model back to re-derive a plan it already validated — and the second attempt
      // is not guaranteed to reach the same place. The confirmation has to carry the
      // steps themselves (§2.2: minted here, replayed verbatim on tap).
      //
      // So the runtime owns the affirmative action, not the model. The model's wording
      // is kept — it phrases these better than a constant does — but the payload behind
      // the first button becomes the plan.
      if (to === ctx.identity.contact.id) {
        const waiting = pendingConfirmation(ctx)
        if (waiting) {
          const confirm = { kind: 'steps' as const, steps: waiting.steps, summary: waiting.summary }
          const carriesPlan = buttons?.some((b: any) => b?.action?.kind === 'steps')
          if (!buttons?.length) {
            buttons = [
              { title: 'Do it', action: confirm },
              { title: 'Cancel', action: { kind: 'noop', ack: 'Left as it was — nothing changed.' } },
            ]
          } else if (!carriesPlan) {
            buttons = buttons.map((b: any, i: number) =>
              i === 0
                ? { title: b.title || 'Do it', action: confirm }
                : { title: b.title, action: b?.action ?? { kind: 'noop', ack: 'Left as it was — nothing changed.' } },
            )
          }
          // A confirmation with no way to decline is not a confirmation. The model
          // reliably writes the yes and forgets the no — asked to add a coach it
          // offered `[Yes, confirm]` alone — which leaves declining to be typed as
          // prose, on the one interaction where the tap is the whole point.
          const declines = (b: any) => b?.action?.kind === 'noop' || /^(cancel|no\b|don'?t|leave)/i.test(b?.title ?? '')
          if (buttons && buttons.length < LIMITS.buttons && !buttons.some(declines)) {
            buttons.push({ title: 'Cancel', action: { kind: 'noop', ack: 'Left as it was — nothing changed.' } })
          }
        }
      }

      // §5 — "a persistent list-picker is the primary affordance; prose is the
      // fallback". The picker was built, role-aware and reordered by memory, and
      // was reachable only by tapping a button carrying `{kind:'menu'}` — which
      // nothing ever minted. Across every message the product had ever sent, not
      // one menu action existed, so the nav bar had no door. This is the door: a
      // reply that would otherwise ship bare carries one, which costs a person
      // nothing and is the only thing that teaches them what else there is.
      // Buttons the model typed into the prose become real ones, before any
      // fallback decides the message is bare.
      let body = String(args?.body ?? '')
      if (!buttons?.length && !args?.list) {
        const pulled = extractBracketButtons(body)
        if (pulled.buttons.length && pulled.text) {
          body = pulled.text
          buttons = pulled.buttons
        }
      }

      /**
       * Does this message's own sentence match what this turn actually did?
       *
       * **Every recipient, not only the one talking.** This read
       * `to === ctx.identity.contact.id`, so the product's one structural honesty
       * check inspected the reply going back to whoever had just typed and nothing
       * else. Messages composed *to a third party* — "tell the Saturday parents the
       * venue moved", a coach told his class was covered, a parent told a payment
       * landed — went out unchecked. That is precisely the traffic §14.4 says makes
       * this a manager rather than a notifier, and it is the traffic where the
       * recipient has least context to notice a claim is wrong: the person talking
       * can see the turn, a parent two hops away cannot.
       *
       * A guarantee that depends on which recipient the model picked is not a
       * guarantee (R4). `ctx.worked` and `ctx.committed` are properties of the whole
       * turn, so the check was never recipient-specific — only its condition was.
       *
       * `promiseChecked` still fires at most once per turn, and that is deliberate:
       * it buys the model one round to make the sentence true, not an argument.
       * Silencing somebody is worse than telling them something slightly wrong.
       */
      {
        const claim = unbackedClaim(body)
        // Past tense needs something to be TRUE; a promise needs something to be in
        // motion. A previewed plan satisfies the second and not the first.
        const backed = claim === 'claimed' ? ctx.committed : ctx.worked
        if (claim && !backed) {
          if (!ctx.promiseChecked) {
            ctx.promiseChecked = true
            return {
              result: {
                error:
                  claim === 'claimed'
                    ? 'that message says you did something, and nothing has been written this turn'
                    : 'that message says you are about to do something, and there is no "about to" — the turn ends when you reply',
                hint:
                  'Do it now — `act` for a named operation, `plan` then a confirmation button for anything bigger — and ' +
                  'then say what you did. Or say plainly that you have not done it yet and ask for the one thing you ' +
                  'need. Nothing else you send will make it true.',
                sent: false,
              },
            }
          }

          /**
           * The model has already had its one round and the sentence is still false.
           *
           * The old rule was "fires at most once; a second attempt always goes out",
           * on the reasoning that silencing somebody is worse than telling them
           * something slightly wrong. The first half of that is right. The second
           * assumed the retry would be closer to true, and driven on a real payment
           * request it was further: refused for *"I'll send her a payment request
           * now"*, the model came back with *"Sent the request to Meena Krishnan for
           * ₹1,200.00. I'll let you know once she's paid."* — past tense, about money,
           * with the plan still sitting unconfirmed behind a `[Do it]` button.
           *
           * There is a third option between silence and a lie, and the runtime is the
           * one thing entitled to take it: substitute its own read-back. When a plan
           * is pending that read-back is computed from the diff, so it is strictly
           * better evidence than the prose it replaces — and the affordance is
           * untouched, so the person can still act.
           *
           * **Only to the person in the conversation.** The substituted sentence ends
           * "tap to confirm and I'll do it", and the button that makes it true is minted
           * for the tapping contact — so sent to a parent or a coach it is an
           * instruction they cannot follow, attached to a plan diff written for an
           * operator. The "silencing somebody is worse" argument does not carry here
           * either: it is about the person waiting on an answer, not about a bystander
           * who was never expecting this message and would only be told something false.
           * So a third-party message with a false claim is refused outright, and the
           * model is told why.
           */
          if (to !== ctx.identity.contact.id) {
            return {
              result: {
                error:
                  'that message claims something happened, nothing was written this turn, and it is addressed to '
                  + 'somebody else — so there is nothing they could tap to make it true',
                hint:
                  'Do the thing first, then tell them. A message to a third party has to be true when it is sent: '
                  + 'they have no way to see this conversation and no button that fixes it.',
                sent: false,
              },
            }
          }

          const waiting = pendingConfirmation(ctx)
          body = waiting
            ? `${waiting.summary}\n\nNothing has run yet — tap to confirm and I'll do it.`
            : "I haven't done that yet. Tell me to go ahead and I will."
        }
      }

      /**
       * The screen the model asked for, whether or not it remembered to attach it.
       *
       * Only when this message carries no affordance of its own: a model that DID
       * offer buttons has made a deliberate choice and the runtime does not overrule
       * it. And only to the person the screen was minted for.
       */
      const pending =
        ctx.pendingScreen && ctx.pendingScreen.forContactId === to && !args?.link_screen
        && !buttons?.length && !args?.list
          ? ctx.pendingScreen
          : null
      if (pending) {
        args = {
          ...args,
          link_screen: pending.screen,
          ...(pending.ref ? { link_session_id: pending.ref } : {}),
        }
        // Once, not on every message the turn sends afterwards.
        ctx.pendingScreen = undefined
      }

      /**
       * `link_screen:"setup"` is answered with a FORM IN THE CHAT, not a link out of it.
       *
       * Onboarding asks a new business six things before anything useful can happen, and
       * the two ways to ask were both bad: six round trips in chat, or one signed URL
       * that takes somebody out of WhatsApp into a browser on a phone. The Flow is the
       * third way — the same fields, one exchange, no browser, no login.
       *
       * The link is not gone. It stays for `register` and `calendar`, and for a setup
       * screen an admin asks for later, when the wider form (the venue list, operating
       * pattern, brief and digest times) is worth the trip out. What changes is the
       * default at the one moment that decides whether a business ever gets set up.
       *
       * Only for the admin themselves: `flow_token` is an action minted for one contact,
       * and the setup screen is the admin's by the check in `builtInScreen`.
       */
      const wantsSetup = String(args?.link_screen ?? '').trim() === 'setup'
      const setupFlow =
        wantsSetup && to === ctx.identity.contact.id && ctx.identity.roles.includes('admin')
          ? {
              flow: ONBOARDING_SETUP.id,
              /**
               * EVERY field the form writes, prefilled from what is on the row now.
               *
               * The form is a full overwrite of the business shape, and it prefilled two
               * of its five fields — so an admin who opened it a second time to change
               * one thing submitted blanks for the rest, and the UPI handle they had
               * already given was silently nulled and the cancellation window reset. A
               * form that overwrites what it does not show is a data-loss bug wearing a
               * convenience feature's clothes.
               *
               * The venue is deliberately absent: it is the one field that adds a row
               * rather than replacing one, so an empty box means "no new place", not
               * "delete the places I have".
               */
              data: {
                name: ctx.identity.academy.name,
                category: ctx.identity.academy.category ?? '',
                cancellation_window_hours: String(ctx.identity.academy.cancellation_window_hours ?? 24),
                upi_handle: ctx.identity.academy.upi_handle ?? '',
              },
            }
          : undefined

      // §14.6 — a link is a button, and it is the only action its message can carry, so
      // it is resolved before the backstops below decide the message is bare.
      const link = setupFlow ? null : await linkFor(ctx, args, to)
      if (link && 'error' in link) return { result: { error: link.error } }
      if (setupFlow && (buttons?.length || args?.list)) {
        // The same exclusivity the wire imposes on `cta_url`. Said as a sentence the
        // model can act on rather than discovered as a suppressed message.
        return {
          result: {
            error: 'a message carries the setup form or reply buttons, never both — that is the wire, not a house rule',
            hint: 'Send the form on its own; offer anything else on the message after it.',
          },
        }
      }
      if (link) {
        if (buttons?.length || args?.list) {
          return {
            result: {
              error: 'a message carries a link or reply buttons, never both — that is the wire, not a house rule',
              hint: 'Send the link on its own, and offer the next step on the message after it. Or drop the link and keep the buttons.',
            },
          }
        }
      }

      /**
       * The body points at a control this message does not have.
       *
       * Checked BEFORE the two backstops below, which is the whole point: those bolt a
       * generic `[What can you do?]` or a menu onto any bare message, so after them the
       * message technically has a button and the sentence "tap the button below to set
       * up your business details" still points at nothing that does it. Checking first
       * is what makes the difference between a message that is wrong and a message that
       * is wrong AND looks fine.
       *
       * Fires at most once per turn, on its OWN budget. It used to share
       * `promiseChecked` with the action-claim guard, and the two never fire on the same
       * defect — so a turn already refused once for claiming an action had spent the
       * budget, and the first time its next message pointed at a button that did not
       * exist the check was skipped and the message went out. One round of grace each.
       */
      if (!ctx.affordanceChecked) {
        const hasAffordance = Boolean(link || setupFlow || buttons?.length || args?.list)
        if (pointsAtMissingAffordance(body, hasAffordance)) {
          ctx.affordanceChecked = true
          return {
            result: {
              error: 'that message points at a button, link or form, and the message carries none',
              hint:
                'Either attach it — link_screen:"setup" sends the business form right here in the chat, '
                + 'link_screen:"register" or "calendar" send those screens, and buttons:[…] offers a next step — '
                + 'or say the thing plainly instead of pointing at a control that is not there.',
            },
          }
        }
      }

      if (to === ctx.identity.contact.id && !setupFlow) buttons = withFollowUps(buttons, ctx)

      if (to === ctx.identity.contact.id && !link && !setupFlow && !buttons?.length && !args?.list) {
        buttons = closingQuestionButtons(body) ?? [
          { title: MENU_BUTTON_TITLE, action: { kind: 'menu', menu: 'root' } },
        ]
      }

      // A list is the primary affordance (§7.2), so its rows get exactly the same
      // treatment as buttons: resolved, validated, and fitted before minting. One
      // bad row used to take the whole picker — and the whole message — with it.
      let list = args?.list
      if (typeof list === 'string') {
        try {
          list = list.trim() ? JSON.parse(list) : undefined
        } catch (e) {
          return {
            result: {
              error: `list was a string but not valid JSON (${e instanceof Error ? e.message : String(e)})`,
              hint: 'It must parse as {"buttonText":"…","sections":[{"title":"…","rows":[{"title":"…","action":{…}}]}]}.',
            },
          }
        }
      }
      if (list?.sections?.length) {
        const sections: any[] = []
        for (const s of list.sections) {
          const rows: any[] = []
          for (const r of (s?.rows ?? []).slice(0, LIMITS.listRows)) {
            const resolved = resolveAction(r?.action, ctx)
            if (!resolved.ok) {
              return {
                result: {
                  error: `the list row "${r?.title ?? ''}" carries an action that cannot be minted: ${resolved.error}`,
                  hint: 'Every row is replayed with no model call. Use {kind:\'reply\', text:"…"} when the row is just a question to ask on their behalf.',
                },
              }
            }
            rows.push({
              title: fitTitle(r?.title, LIMITS.listRowTitleChars),
              description: r?.description ? String(r.description) : undefined,
              action: resolved.action,
            })
          }
          sections.push({ title: fitTitle(s?.title, LIMITS.listSectionTitleChars), rows })
        }
        list = { buttonText: fitTitle(list.buttonText || 'Choose', EXTRA_LIMITS.listButtonTextChars), sections }
      }

      // §4.5 ran on exactly one path — the loop's own trailing message — and this
      // is the path the model actually uses, so most outbound text was never
      // linted at all. Uuids, table names, ISO timestamps and doctrine references
      // were one `reply` call away from a customer's phone the whole time.
      //
      // Hoisted out of the call so `saidToUser` below records the sentence the person
      // reads rather than the one the model drafted.
      const linted = lint(body, ctx.identity)

      const outcome = await composeAndSend(ctx.session, {
        toContactId: to,
        body: linted,
        header: args?.header ? String(args.header) : undefined,
        footer: args?.footer ? String(args.footer) : undefined,
        buttons,
        list,
        link: link ?? undefined,
        flow: setupFlow,
        catalogId,
        fixed: catalogId ? CATALOG[catalogId].fixed : false,
        subjectPersonIds: Array.isArray(args?.subject_person_ids) ? args.subject_person_ids : undefined,
      })
      ctx.outcomes?.push(outcome)
      if (outcome.status === 'sent' || outcome.status === 'queued') {
        ctx.repliedTo?.add(to)
        // The body as the person will read it, not the model's draft.
        if (to === ctx.identity.contact.id && linted.trim()) ctx.saidToUser?.push(linted.trim())
      }
      if (outcome.status === 'suppressed') {
        // A bare `{status:'suppressed'}` reads as "that didn't work, try again", and
        // the observed behaviour was exactly that: the same message re-sent, then a
        // shorter version, then a bare "Hi!" — three dropped messages and a wasted
        // turn. A gate is a decision, not a transient failure, so it says so.
        return {
          result: {
            status: 'suppressed',
            reason: outcome.reason,
            explanation: SUPPRESSION_HELP[outcome.reason] ?? 'This message was not delivered.',
            retry: false,
            note: 'Sending this again, or a reworded version, will be dropped the same way. Do not resend. If the person is owed an answer, the way to give it is to fix the reason, not to repeat the message.',
          },
        }
      }
      return {
        result: {
          status: outcome.status,
          ...('reason' in outcome ? { reason: outcome.reason } : {}),
          ...(dropped.length && !buttons?.length
            ? {
                dropped_buttons: dropped,
                note:
                  'The message went out without those. Do not resend it — say the missing option in your next message, ' +
                  "or offer it properly: to commit a plan you previewed, pass {kind:'steps', steps:<the steps>, summary:'…'} " +
                  "or {kind:'operation', op:'commit', args:{handle}} with a handle from THIS turn. Never put a tool name " +
                  '(plan, commit, act, read) where an operation name belongs.',
              }
            : {}),
        },
      }
    }

    /* ------------------------------------------------------------ schedule */
    case 'schedule': {
      // §13.1 — the runtime rejects a task without an expiry. Not a warning.
      const expires = args?.expires_at ? new Date(String(args.expires_at)) : null
      if (!expires || Number.isNaN(expires.getTime())) {
        return { result: { error: 'expires_at is required — a watch with no expiry is a leak. When should this stop being worth doing?' } }
      }
      const runAt = new Date(String(args?.run_at ?? ''))
      if (Number.isNaN(runAt.getTime())) return { result: { error: 'run_at must be an ISO timestamp' } }
      if (runAt.getTime() > expires.getTime()) return { result: { error: 'run_at is after expires_at' } }

      // A cap per academy on live tasks, and they are visible (§13.1). The
      // enqueue path enforces it too — this is here so the model gets a
      // sentence it can act on rather than an exception.
      const live = await liveAgentTasks(ctx.session.academyId).catch(() => [])
      if (live.length >= AGENT_TASK_CAP) {
        return {
          result: {
            error: `there are already ${live.length} things on the watch list, which is the cap. Ask what I am watching and drop one first.`,
            watching: live.map((t) => ({ slug: t.slug, instruction: t.instruction })),
          },
        }
      }

      const slug = String(args?.slug ?? newId())
        .replace(/[^a-z0-9_-]/gi, '-')
        .slice(0, 60)
      const dedupeKey = dedupe.agentTask(ctx.session.academyId, slug)
      try {
        const jobId = await enqueue(
          'agent_task',
          runAt,
          dedupeKey,
          {
            academy_id: ctx.session.academyId,
            slug,
            instruction: String(args?.instruction ?? ''),
            context: args?.context_query ? String(args.context_query) : null,
            minted_by: ctx.turnId,
            minted_by_contact_id: ctx.identity.contact.id,
            minted_roles: ctx.identity.roles,
            expires_at: expires.toISOString(),
          },
          ctx.session.academyId,
        )
        // "I'll check back on Friday" is a promise a scheduled watch keeps.
        ctx.worked = true
        return {
          result: {
            ok: true,
            job_id: jobId,
            slug,
            dedupe_key: dedupeKey,
            run_at: runAt.toISOString(),
            expires_at: expires.toISOString(),
          },
          note: `watching: ${String(args?.instruction ?? '').slice(0, 80)}`,
        }
      } catch (e) {
        return { result: { error: e instanceof Error ? e.message : String(e) } }
      }
    }

    /* ---------------------------------------------------------------- view */
    case 'view': {
      const builtIn = String(args?.screen ?? '')
      if (builtIn) return await builtInScreen(ctx, builtIn, args)

      const parsed = ViewSpecSchema.safeParse({ title: args?.title, components: args?.components })
      let spec: unknown = parsed.success ? parsed.data : null
      let fellBack = false
      if (!spec) {
        // §15 — an invalid spec falls back to `table`, which renders any
        // tabular result. The floor under all of it: anything that cannot be
        // rendered gets answered in chat.
        const query = Array.isArray(args?.components)
          ? args.components.find((c: any) => typeof c?.query === 'string')?.query
          : null
        if (!query) {
          return {
            result: { error: 'that view spec is not valid and there is no query to fall back to — answer in chat instead' },
          }
        }
        spec = { title: String(args?.title ?? 'Here you go'), components: [{ type: 'table', query: String(query) }] }
        fellBack = true
      }
      // §15: "Query shape violates the contract → validation rejects at mint
      // time; retry once, then table." The spec was validated and its queries
      // never were, so a view could be minted, linked, and sent — and the first
      // anyone knew was the person reading `Couldn't load this bit. missing
      // FROM-clause entry for table "academy"` on their own phone. Watched
      // happening to a parent on her first ever message to the product.
      //
      // Running them here costs one round trip per component and moves the
      // failure to the only moment it can be repaired.
      const components = Array.isArray((spec as any)?.components) ? (spec as any).components : []
      const broken: { component: number; query: string; error: string }[] = []
      let totalRows = 0
      for (const [i, comp] of components.entries()) {
        const query = typeof comp?.query === 'string' ? comp.query : null
        if (!query) continue
        const probe = await modelQuery(ctx.session, query)
        if (probe.error) broken.push({ component: i, query, error: probe.error })
        else totalRows += probe.rowCount
      }
      if (broken.length) {
        return {
          result: {
            error: 'the view was not minted: one of its queries does not run',
            failing: broken,
            hint: 'Fix the query and call view again, or answer in chat — a view is an upgrade to a text answer, never a prerequisite for one.',
          },
        }
      }

      // §15's floor — "a view is an upgrade to a text answer, never a prerequisite for
      // one" — was a sentence in a document, so it held exactly as often as the model
      // remembered it. Measured against the live prompt: asked *"sorry what do i do now"*,
      // the model minted a web page three times in three. A lost newcomer was handed a
      // link. That is the whole of the user's complaint that "the web surface is too
      // available", and it is not a taste question: a tap out of WhatsApp to read four
      // rows is worse than four rows in the chat, always.
      //
      // The queries have just been run, so the runtime knows something the model was only
      // guessing at: how much there actually is. A view earns its tap when the answer does
      // not fit in a message, and that is now a fact checked at mint rather than a judgement
      // made at compose. It also derives §15's own hierarchy without hardcoding a role —
      // a parent's tally and a coach's week are small and stay in chat, an admin's
      // attendance-by-class-by-month is not and does not.
      //
      // A form is exempt: its size is the number of fields, not the number of rows, and
      // §14.6 says everything form-shaped goes here.
      const VIEW_EARNS_ITS_TAP = 8
      const hasForm = components.some((c: any) => String(c?.type) === 'form')
      if (!hasForm && totalRows < VIEW_EARNS_ITS_TAP) {
        return {
          result: {
            error: `not minted: those queries return ${totalRows} row(s) in total, which fits in a message`,
            hint:
              'Say it in the chat. A page costs them a tap out of WhatsApp and gives nothing back at this size — ' +
              'a view is an upgrade to a text answer, never a prerequisite for one. If you have not read the rows ' +
              'yet, read them and answer.',
          },
        }
      }

      const forPersonId = String(args?.for_person_id ?? ctx.identity.person.id)
      const ttl = Math.min(Math.max(Number(args?.ttl_minutes ?? 120), 5), 60 * 24 * 7)
      const viewSpecId = newId()
      const expires = new Date((await now()).getTime() + ttl * 60_000)
      void linkUrl // the URL is minted at send time, by `linkFor`, and never returned here
      await withSession({ role: 'service', academyId: ctx.session.academyId }, async (tx) => {
        await tx.unsafe(
          `insert into view_spec (id, academy_id, spec, for_person_id, expires_at)
           values (${uid(viewSpecId)}, ${uid(ctx.session.academyId)}, ${jsonLit(spec)}, ${uid(forPersonId)},
                   timestamptz ${lit(expires.toISOString())})`,
        )
      })
      // No URL. The page exists; the way to it is an action, and the runtime signs it —
      // at send time in `reply(link_view_spec_id:…)`, or at tap time behind a
      // `{kind:'view', viewSpecId}` button, whose link is therefore always fresh.
      return {
        result: {
          ok: true,
          view_spec_id: viewSpecId,
          fell_back_to_table: fellBack,
          send_it_with: `reply(body:"…", link_view_spec_id:"${viewSpecId}")`,
          note:
            'A view is an upgrade to a text answer, never a prerequisite for one — say the short answer in ' +
            'the body and let the page carry the detail. Never write a web address into a message yourself.',
        },
      }
    }

    /* ------------------------------------------------------------ remember */
    case 'remember': {
      const subjectKind = args?.subject_kind === 'academy' ? 'academy' : 'person'
      const subjectId = String(
        args?.subject_id ?? (subjectKind === 'academy' ? ctx.session.academyId : ctx.identity.person.id),
      )
      // §5 — the bot writes facts asynchronously after a turn, never blocking
      // a reply.
      void writeFact(ctx.session, {
        subjectKind,
        subjectId,
        fact: String(args?.fact ?? ''),
        source: `turn:${ctx.turnId}`,
        supersedes: args?.supersedes ? String(args.supersedes) : undefined,
      }).catch(() => {})
      return { result: { ok: true } }
    }

    /* -------------------------------------------------------------- recall */
    case 'recall': {
      const subjectId = String(args?.subject_id ?? ctx.identity.person.id)
      const facts = await searchFacts(ctx.session, subjectId, String(args?.query ?? ''))
      return { result: { facts: facts.map((f) => ({ id: f.id, fact: f.fact, source: f.source })) } }
    }

    /* ------------------------------------------------------------- handoff */
    case 'handoff': {
      // §14.8 — client escalations go to their academy's admin; admin
      // escalations go to the platform. §18 rule 2 does the rest: an
      // escalation about a person never reaches that person, so an admin
      // escalating about themselves is dropped on the send path, not here.
      const isAdmin = ctx.identity.roles.includes('admin')
      const reason = String(args?.reason ?? 'needs a person')
      const summary = String(args?.summary ?? '')
      const sent: string[] = []
      if (!isAdmin) {
        const admins = await withSession({ role: 'service', academyId: ctx.session.academyId }, async (tx) => {
          const rows = (await tx.unsafe(
            `select c.id from academy_admin aa
               join contact c on c.person_id = aa.person_id and c.academy_id = aa.academy_id
              where aa.academy_id = ${uid(ctx.session.academyId)} and c.opted_out_at is null
              order by c.is_primary desc`,
          )) as unknown as { id: string }[]
          return rows.map((r) => r.id)
        })
        for (const contactId of admins) {
          const o = await composeAndSend(ctx.session, {
            toContactId: contactId,
            body:
              `${ctx.identity.person.full_name} needs a person — ${reason}.\n${summary}`.slice(0, LIMITS.bodyChars),
            isEscalation: true,
            subjectPersonIds: [ctx.identity.person.id],
            fixed: true,
            buttons: [
              { title: 'Message them', action: { kind: 'reply', text: `Open a message to ${ctx.identity.person.full_name}` } },
            ],
          })
          ctx.outcomes?.push(o)
          sent.push(o.status)
        }
      }
      await withSession({ role: 'service', academyId: ctx.session.academyId }, async (tx) => {
        await tx.unsafe(
          `insert into memory_fact (academy_id, subject_kind, subject_id, fact, source)
           values (${uid(ctx.session.academyId)}, 'person', ${uid(ctx.identity.person.id)},
                   ${lit(`Asked for a person: ${reason}`)}, ${lit(`turn:${ctx.turnId}`)})`,
        )
      })
      return {
        result: {
          ok: true,
          told_admin: sent.length > 0,
          say: isAdmin
            ? "I've flagged this for the people who run the platform, and I've kept the thread."
            : `I've passed this to ${ctx.identity.academy?.name ?? 'the academy'} with what we've said so far. Someone will come back to you.`,
        },
      }
    }

    default: {
      // A dead end here costs the whole turn. The model called `PlanSteps` eight
      // times in a row against `there is no tool called PlanSteps` — a true sentence
      // that contains nothing to act on, so the only move left was to try it again.
      // An error that carries the way out is the difference between a mis-named call
      // and a burnt turn.
      const known = toolDecls().map((d) => d.name)
      const lowered = name.toLowerCase().replace(/[^a-z]/g, '')
      const nearest =
        known.find((k) => k === lowered) ??
        known.find((k) => lowered.startsWith(k) || lowered.endsWith(k)) ??
        known.find((k) => lowered.includes(k))
      return {
        result: {
          error: `there is no tool called "${name}"`,
          available: known,
          ...(nearest
            ? {
                didYouMean: nearest,
                hint: `Call "${nearest}" instead — same intent, and its parameters are in the declaration above. Calling "${name}" again will fail identically.`,
              }
            : {
                hint: 'Use one of the names in `available`, exactly as written — they are lowercase and never camelCase. Calling this name again will fail identically.',
              }),
        },
      }
    }
  }
}

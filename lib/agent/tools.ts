/**
 * lib/agent/tools.ts — a general agent on guardrailed primitives (§14.1).
 *
 * Seven generic primitives, not a catalog of hand-built features: read, write
 * (plan/commit/act), message, schedule, UI. Safety is structural, not
 * behavioural — RLS enforces, the diff is computed before commit, and every
 * message goes out the one send path. The floor being solid is what lets the
 * model be free above it.
 */

import { assertSingleReadStatement, modelQuery, serviceFrom, withSession, type SessionCtx } from '@/lib/db'
import { newId } from '@/lib/ids'
import type { ActionPayload } from '@/lib/actions'
import { composeAndSend } from '@/lib/messaging/compose'
import { CATALOG, type CatalogId } from '@/lib/messaging/catalog'
import { formFor, FORM_IDS, type FormId } from '@/lib/messaging/flows'
import { EXTRA_LIMITS, LIMITS, type SendOutcome, type SuppressReason } from '@/lib/messaging/types'
import { extractBracketButtons, fitTitle, pointsAtAffordance } from '@/lib/messaging/repair'
import { AGENT_TASK_CAP, dedupe, enqueue, liveAgentTasks } from '@/lib/jobs'
import { adminContactIds } from '@/lib/identity'
import type { Identity } from '@/lib/types'
import { lint } from './lint'
import { writeFact } from './memory'
import type { ToolDecl } from './deepseek'
import { audienceFor, executePlan, needsPreview, parseSteps, previewPlan, type PlanStep } from './plan'
import {
  checkActionPayload, checkSteps, humanAssertionNote,
  stripHumanAssertions, stripHumanAssertionsFromArgs, stripHumanAssertionsFromPayload,
} from './steps'
import { lit, uid, OPERATIONS, operationSignature, type OperationName } from './operations'
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
   * Operations that executed directly this turn (no preview, no tap), with the
   * arguments they ran with — so §4.3's follow-up can be offered on the path the
   * model actually takes, not only on the tap path.
   */
  executed?: { op: string; args: Record<string, unknown>; wrote?: { table: string; op: string; after: any[] }[] }[]
  /** Who this turn has already put a message in front of, and it landed. */
  repliedTo?: Set<string>
  /**
   * Who has a confirmation question from THIS turn sitting on their screen —
   * put there by an operation that confirms itself (`client_cancel`,
   * `opt_out`…). One tap answers it; anything further this turn teaches them
   * to ignore it. Driven: a family received the operation's "Just to be sure —
   * cancel Aarav…?" and, one minute later, the model's own re-worded
   * confirmation of the same cancellation (F-F). `repliedTo` could not catch
   * it because the operation's send never went through `reply`.
   */
  confirmationAskedTo?: Set<string>
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

/**
 * The verbs that mean a write happened. Shared by both shapes below.
 *
 * The routing verbs — flagged, escalated, raised, notified, informed — are the
 * F-K addition (conversation-rules.md): *"I've flagged it to the owner"* shipped
 * with `claimedDone: false` because every verb here was a doing-verb and none
 * was a telling-verb, so the checker read the sentence as claiming nothing.
 * "told" stays out deliberately: "I've told you the price" is ordinary
 * conversation about a previous turn, and a false positive here costs a real
 * sentence a re-compose.
 */
const DONE_VERBS =
  'added|created|set|made|booked|cancelled|canceled|moved|sent|recorded|requested|updated|removed|deleted|changed|waived|scheduled|assigned|enrolled|marked|drafted|flagged|escalated|raised|notified|informed'

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
 * Which write would make THIS sentence true.
 *
 * `ctx.committed` is a property of the TURN, so one true claim licenses any
 * number of false ones beside it — and the false one is invisible precisely
 * because the message is mostly right. Driven five times in a single 17-case
 * run, every one inside a case whose checks all passed:
 *
 *   "I've also drafted an invite for Arjun"      — no draft; the turn ran
 *                                                  create_class and remember
 *   "and enrolled Aarav, Ananya, and Dev"        — no enrollment row, twice
 *   "I've also drafted the invite for Arjun"     — plan still behind [Do it]
 *   "I've also set you up on the system"         — plan still behind [Looks right]
 *
 * The fix is not general fact-grounding, which needs the world. It is asking
 * whether a sentence naming a SPECIFIC action has a write of that shape behind
 * it — and the turn already records every write it made, so the answer is a
 * lookup rather than a judgement.
 *
 * **Deliberately partial.** Only verbs with an unambiguous footprint are listed.
 * "added", "created", "set", "updated", "changed" name no particular table and
 * are left to the turn-scoped flag exactly as before: a guard that guessed at
 * those would refuse true sentences, and refusing a true sentence costs a round
 * and can end in a substitution. Every verb below either has a table that must
 * have been touched, or is not claimed at all.
 * ------------------------------------------------------------------------- */

/** Verb (as written in a claim) → the tables any of which makes it true. */
const CLAIM_TABLES: Record<string, string[]> = {
  drafted: ['message'],
  invited: ['message'],
  enrolled: ['enrollment'],
  waived: ['tally_line'],
  recorded: ['payment'],
  requested: ['payment'],
  marked: ['attendance', 'session', 'session_coach'],
  cancelled: ['session', 'enrollment', 'job'],
  canceled: ['session', 'enrollment', 'job'],
  moved: ['session', 'class_slot'],
  scheduled: ['job', 'session'],
  booked: ['enrollment', 'session'],
  assigned: ['class_coach', 'session_coach'],
  removed: ['enrollment', 'session', 'class_coach', 'session_coach'],
  deleted: ['enrollment', 'session', 'class_coach', 'session_coach'],
  // The routing verbs are true exactly when somebody was actually told: a
  // message row this turn (a handoff's send lands there too, via `outcomes`).
  flagged: ['message'],
  escalated: ['message'],
  raised: ['message'],
  notified: ['message'],
  informed: ['message'],
}

/**
 * The three shapes a claim about a specific verb arrives in, compiled once.
 *
 * These were built inside the loop in `unsupportedClaims` — three `new RegExp`
 * per verb, thirteen verbs, so thirty-nine compilations per call, on a function
 * that runs on every outbound message and again on the loop's trailing prose.
 * The patterns are constant; only the verb varies, and the verbs are a literal.
 */
const CLAIM_PATTERNS: [verb: string, patterns: RegExp[]][] = Object.keys(CLAIM_TABLES).map((verb) => [
  verb,
  [
    // "I've enrolled", "I have also enrolled"
    new RegExp(`\\bi(?:'ve| have)\\s+(?:just\\s+|now\\s+|also\\s+)*${verb}\\b`, 'i'),
    // "Enrolled Aarav…" — the bare past tense opening a line or a sentence.
    new RegExp(`(?:^|[.\\n]\\s*)(?:and\\s+)?${verb[0].toUpperCase()}${verb.slice(1)}\\s`),
    // "…and enrolled Aarav" — a second clause riding the first claim's subject.
    new RegExp(`\\band\\s+${verb}\\s+(?=[A-Z₹\\d])`),
  ],
])

/** Which contacts an execute path just asked to confirm (ToolCtx.confirmationAskedTo). */
function noteConfirmations(ctx: ToolCtx, outcomes: SendOutcome[]): void {
  for (const o of outcomes) {
    if ((o.status === 'sent' || o.status === 'queued') && o.confirmationRequest && o.toContactId) {
      ctx.confirmationAskedTo?.add(o.toContactId)
    }
  }
}

/** Record what a plan wrote, so a claim can be checked against it. */
export function recordExecuted(
  ctx: ToolCtx,
  op: string,
  diffs: { table: string; op: string; after?: any[] }[] | undefined,
): void {
  if (!ctx.executed || !diffs?.length) return
  ctx.executed.push({
    op,
    args: {},
    wrote: diffs.map((d) => ({ table: d.table, op: d.op, after: d.after ?? [] })),
  })
}

/**
 * The specific claims this body makes that the turn's writes do NOT support.
 *
 * Empty when the sentence names no specific action — the caller then falls back
 * to the turn-scoped flag, which is the behaviour that shipped before.
 */
export function unsupportedClaims(body: string, ctx: ToolCtx): string[] {
  const wrote = new Set<string>()
  for (const e of ctx.executed ?? []) for (const w of e.wrote ?? []) wrote.add(w.table)
  // A message that actually reached somebody is a write for the purposes of
  // "sent"/"drafted"/"invited": staged plan messages land in `message` too, but
  // an operation that emitted one outside a plan diff would otherwise look silent.
  if (ctx.outcomes?.some((o) => o.status === 'sent' || o.status === 'queued')) wrote.add('message')

  const missing: string[] = []
  for (const [verb, patterns] of CLAIM_PATTERNS) {
    // Same two shapes `unbackedClaim` matches: "I've <verb>" anywhere, or the
    // bare past tense opening a line. Mid-sentence lower-case is ordinary English
    // ("sessions cancelled in time are credited") and must not be read as a receipt.
    if (!patterns.some((re) => re.test(body))) continue
    if (!CLAIM_TABLES[verb].some((t) => wrote.has(t))) missing.push(verb)
  }
  return missing
}

export type ClaimCheck = {
  /** What kind of sentence this is, if it is one of the two. */
  claim: 'claimed' | 'promised' | null
  /** The specific verbs it claims that no write this turn supports. */
  unsupported: string[]
  /** It makes a claim, and the turn has nothing behind it. */
  unbacked: boolean
}

/**
 * Does this message's own sentence match what this turn actually did?
 *
 * **One function, because there are two paths out of a turn and the guarantee has
 * to hold on both.** A message leaves either through the `reply` tool or as the
 * loop's trailing prose, and which one a given turn takes is the model's choice —
 * so a check living on one of them is not a check. That was understood; the fix
 * was to write the same four lines in both places, and they promptly drifted:
 * the two substituted read-backs ended up saying *"Nothing has run yet — tap to
 * confirm and I'll do it"* and *"Nothing is done yet — tap to confirm and I'll
 * run it"*, which is two products' worth of voice for one runtime sentence.
 *
 * The asymmetry between the paths is real and stays at the call sites: `reply`
 * has a round of grace to spend (it can refuse and ask for a rewrite), while the
 * trailing path has none — there is no round left to ask. What is identical is
 * the judgement, and that is what lives here.
 *
 * Past tense needs something to be TRUE; a promise needs something to be in
 * motion. A previewed plan satisfies the second and not the first. `unsupported`
 * is the claim-scoped half: `ctx.committed` asks only whether the TURN wrote
 * anything, so a message that truthfully reports creating a class could carry
 * "and enrolled Aarav, Ananya and Dev" beside it with no enrollment row
 * anywhere — and did. A verb naming a table that was never written is unbacked
 * however much else the turn got right.
 */
export function checkClaims(body: string, ctx: ToolCtx): ClaimCheck {
  const claim = unbackedClaim(body)
  const unsupported = unsupportedClaims(body, ctx)
  // A claim whose every specific verb has its footprint this turn is backed by
  // that footprint. `ctx.committed` cannot vouch for a send-shaped verb —
  // "I've flagged it to the owner" over a message row and no table write is
  // true, and demanding a commit would refuse the one true sentence the
  // routing verbs were added to allow. For doing-verbs this changes nothing:
  // their footprint IS a table write, which set `committed` on the way in.
  const specific = CLAIM_PATTERNS.filter(([, patterns]) => patterns.some((re) => re.test(body)))
  const backed =
    claim === 'claimed'
      ? !unsupported.length && (specific.length > 0 || Boolean(ctx.committed))
      : Boolean(ctx.worked)
  return { claim, unsupported, unbacked: Boolean(claim || unsupported.length) && !backed }
}

/**
 * What the runtime says instead of a false receipt, when a plan is sitting here
 * unconfirmed.
 *
 * The runtime is entitled to substitute this: the summary is computed from the
 * diff, so it is strictly better evidence than the prose it replaces, and the
 * affordance is untouched so the person can still act. One wording, because a
 * person cannot tell which code path composed their message and should not be
 * able to.
 */
export function pendingReadBack(summary: string): string {
  return `${summary}\n\nNothing has run yet — tap to confirm and I'll do it.`
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

function pointsAtMissingAffordance(body: string, hasAffordance: boolean): boolean {
  return !hasAffordance && pointsAtAffordance(body)
}

/* ------------------------------------------------------------------------- *
 * Declarations
 * ------------------------------------------------------------------------- */

/**
 * Steps cross the wire as a JSON string, not as a declared array of objects.
 *
 * This is not a style choice. A plan step is a five-way union whose branches nest
 * three and four deep — a message carrying buttons carrying action payloads, a
 * schedule carrying a free-form job payload — and a function-call decoder handed
 * that as a declared schema malformed it more often than not once the model tried
 * to build a real one. Measured against the live prompt on the previous provider:
 * two of three attempts came back malformed, zero output tokens, no candidate, no
 * error anyone could read.
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
    // Both are safe now. `venue` has always had a unique key on (academy_id,
    // name); `class` gained one in 0021, scoped to classes that are still OPEN
    // (active and no `ends_on`), so §6.3's requirement still holds — an ended
    // class keeps its name and next season may reuse it.
    //
    // Saying so here is the point. The old text told the model classes were NOT
    // unique and to narrow every lookup with `order by starts_on desc limit 1`.
    // That `limit 1` is exactly what made a duplicate invisible: two "Evening
    // Fitness" rows existed, every lookup silently picked one, and the coach was
    // prompted twice for a fortnight. The instruction was correct for the schema
    // it was written against and became a way to not notice.
    'An id argument may also be ONE parenthesised SELECT, for a row an earlier step in this same ' +
    'plan created — so an operation is never the wrong tool just because you do not have the id. ' +
    'It MUST return exactly one row: a subquery that matches two aborts the whole plan. Venue names ' +
    'are unique per business, and so are the names of classes that are still running, so both are ' +
    'safe as written. Narrow a class lookup with `and active and ends_on is null`:\n' +
    "  (select id from class where name = 'Beginners' and academy_id = app.academy_id() and active " +
    'and ends_on is null)\n' +
    'If that matches nothing, the class does not exist yet — create it rather than widening the ' +
    'lookup until something comes back.\n' +
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

/**
 * The backstop button, chosen for the message it is about to sit under.
 *
 * `[What can you do?]` is the most-minted button in the product and it announces
 * capability instead of demonstrating it — §4.3's whole complaint. Driven from
 * empty: an admin typed *"what can you do?"*, got a good four-bullet answer, and
 * the single affordance underneath it was **[What can you do?]**. The one thing
 * offered to somebody who had just been told everything was to ask again.
 *
 * A menu is a reasonable backstop under a message that answered something else.
 * It is a dead end under the answer to this question, and it is a wasted slot
 * while a business still has an obvious next step — which the runtime knows,
 * because `onboarding_state` is the thing every job in the product gates on.
 *
 * Returns the menu unchanged when there is nothing better to say, so this can
 * only improve a message, never empty one.
 */
export function backstopButtons(
  identity: Identity,
  body: string,
): { title: string; action: ActionPayload }[] {
  const menu = [{ title: MENU_BUTTON_TITLE, action: { kind: 'menu', menu: 'root' } as ActionPayload }]
  if (!identity.roles.includes('admin')) return menu

  // Only when the business has not finished being built. After go-live the next
  // step is whatever the person is doing, and guessing at it is worse than a menu.
  const state = identity.academy.onboarding_state
  if (state === 'live') {
    // …except directly under the capability answer, where the menu is circular.
    return /\bwhat (?:can|do) (?:you|i) /i.test(body) ? [] : menu
  }

  /**
   * The steps have to be a function of the state they are named after. This list was
   * static, so the turn that *finished* business setup came back offering
   * `[Set up the business]` again — the one step the person had just completed, sitting
   * first in the row under a message that read the settings back to them.
   *
   * `onboarding_state` is `setup → roster → ready → live`, and `setup` is precisely the
   * state that means "the business form has not been submitted". Past it, the form is an
   * edit rather than a step, and an edit is not what a backstop is for.
   */
  const steps: { title: string; action: ActionPayload }[] = [
    ...(state === 'setup'
      ? [{ title: 'Set up the business', action: { kind: 'form', form: 'business_setup' } as ActionPayload }]
      : []),
    { title: 'Add a class', action: { kind: 'reply', text: 'I want to add a class' } },
    { title: 'Add a coach', action: { kind: 'reply', text: 'I want to add a coach' } },
  ]
  return steps.slice(0, LIMITS.buttons)
}

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
    else if (typeof a.form === 'string') a = { ...a, kind: 'form' }
    // `{screen:'setup'}` was how the web surface spelled this, and the model still
    // reaches for it out of habit. It means the business form; say so rather than
    // rejecting a button whose intent is unambiguous.
    else if (typeof a.screen === 'string') a = { kind: 'form', form: a.screen === 'setup' ? 'business_setup' : a.screen }
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
    const stepsStripped: string[] = []
    const cleanSteps = stripHumanAssertions(checked.steps, stepsStripped) as PlanStep[]
    if (stepsStripped.length) return { ok: false, error: defangedButton(stepsStripped) }
    return {
      ok: true,
      action: {
        kind: 'steps',
        steps: cleanSteps,
        summary: String(a.summary ?? 'that change'),
      },
    }
  }

  const checked = checkActionPayload(a)
  if (!checked.ok) return { ok: false, error: checked.error }
  const strippedPayload = stripHumanAssertionsFromPayload(checked.payload)
  if (strippedPayload.stripped.length) return { ok: false, error: defangedButton(strippedPayload.stripped) }
  return { ok: true, action: strippedPayload.payload }
}

/**
 * A stripped confirmation on a BUTTON is worse than on a call: the tap replays
 * with no model in the loop, so the silently-defanged button re-asks instead of
 * acting — driven, a parent tapped "Yes, cancel" and was asked "Just to be
 * sure?" a third time (F-F). Refused at mint, where a model still exists to
 * take the working route.
 */
function defangedButton(stripped: string[]): string {
  return (
    `this button carries ${[...new Set(stripped)].join(', ')}, which only that person's own tap can set — ` +
    `minted here it would be stripped, and their tap would re-ask instead of acting. ` +
    `Do not compose your own confirmation for an operation that confirms itself: call the operation ` +
    `directly, and it puts the right question, with working buttons, on their screen.`
  )
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
 * The form a `reply` asked for, resolved at the moment the message is composed.
 *
 * There used to be a second answer to "the thing I want to say is form-shaped": a
 * signed short-TTL JWT into a web page. It is gone (§15). Everything form-shaped is
 * a Flow now, which is the same fields with none of the three costs — no tap out of
 * WhatsApp, no bearer token anybody can forward, and no second rendering surface the
 * emulator has to be honest about.
 *
 * The model names the form. It never assembles one: what a submission DOES is decided
 * by the runtime on the way back in (`executeAction`), so a form can only ever reach
 * work somebody chose to put behind it. Prefill comes from the database, here, because
 * a form that overwrites what it does not show is a data-loss bug wearing a convenience
 * feature's clothes.
 *
 * Returns `{error}` for a form this person may not be sent, and null for no form asked.
 */
async function formForReply(
  ctx: ToolCtx,
  args: any,
  toContactId: string,
): Promise<{ flow: string; data: Record<string, unknown> } | { error: string } | null> {
  const wanted = String(args?.form ?? '').trim()
  if (!wanted) return null
  if (!(FORM_IDS as readonly string[]).includes(wanted)) {
    return { error: `there is no form called "${wanted}" — they are ${FORM_IDS.join(', ')}` }
  }
  return await formFor(ctx.session, ctx.identity, wanted as FormId, {
    toContactId,
    sessionId: args?.form_session_id ? String(args.form_session_id) : undefined,
    prefill: args?.form_prefill && typeof args.form_prefill === 'object' ? args.form_prefill : undefined,
  })
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
 * the graph and the enum is `[]` — a tool declaration a provider may refuse, and
 * on the previous provider **every** turn came back malformed with zero output
 * tokens while the person got "something broke on my side". Nothing in the
 * failure names a module cycle, and nothing would.
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
 * 10 / 11 / 15 / 30 / 60 declarations, clean, 2/2 each, on the very model the
 * ceiling had been "found" on. Re-verified after the DeepSeek migration:
 * 36 / 56 / 86 declarations, 2/2 clean each, against the real prefix.
 *
 * The likely real cause is documented a few lines above, in `toolDecls`: `act`'s
 * schema is `enum: Object.keys(OPERATIONS)`, and when these were built at module
 * load, one extra import edge made that list empty. An empty enum is a
 * declaration a provider may refuse outright, and its symptom is precisely
 * "every turn comes back malformed with zero output tokens". Adding an eleventh
 * tool perturbs the import graph. The lazy build fixed the cause; this guard
 * outlived it and went on constraining the design for nothing.
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
      `tools: ${decls.length} declarations, and ${MAX_TOOL_DECLS} is the documented API limit — past it the ` +
        `request is rejected far from here and unreadably. Fold the new capability into an existing tool (a ` +
        `property on \`view\`, an entry in the operation registry) instead of declaring another one.`,
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
  'remember',
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
  /**
   * `act` is NOT declared to the model, and has not been since operations became
   * their own typed declarations. Each of the 28 carries its own zod schema
   * projected into the declaration the model decodes against; `act` took
   * `args: {type:'object'}`, which gave the decoder nothing to hold onto, and it
   * was measured at 0 calls across 464 tool calls in seven academies because it
   * was not on the list.
   *
   * **The `act` CASE in `runTool` is very much alive** — every operation-named
   * tool is rewritten into it, so it is the one executor the tool path, the
   * button path (`{kind:'operation'}`) and the plan path (`{"operation":{…}}`)
   * all agree through. Only the declaration is gone.
   */
  {
    name: 'reply',
    description:
      'Send a message now, to this person or to someone else, with buttons, a list, or a form. Every button carries an action minted here and replayed verbatim on tap. Offer the natural next step as a button. NEVER write a web address into the body — there is no browser in this product. ' +
      'And know your channel: prose you write in a round that calls tools reaches NOBODY — it is your notebook, not a message. What a person sees is what you pass here (or, on an interactive turn only, the closing text of your final round).',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        to_contact_id: { type: 'string', description: 'Defaults to the person you are talking to.' },
        body: { type: 'string' },
        header: { type: 'string' },
        footer: { type: 'string', description: `≤ ${LIMITS.footerChars} characters` },
        form: {
          type: 'string',
          enum: [...FORM_IDS],
          description:
            "Attach a form the person fills in without leaving the chat. 'business_setup' is the shape of the business in one screen — name, what they teach, where, how they charge, the cancellation notice, when they want their brief and their summary, where money goes; the owner's, and it is how onboarding starts rather than six questions in a row. 'add_class' is one class — name, days, times, venue, rate; pass form_prefill with whatever they have already told you, so they are correcting rather than typing. 'register' is one session's attendance and needs form_session_id: it asks who was NOT there, so a normal night is nought taps. A message with a form carries no other buttons and no list — say the alternative in words instead, because a form is always an offer and never a toll.",
        },
        form_session_id: { type: 'string', description: "Which session, for form:'register'." },
        form_prefill: {
          type: 'object',
          description:
            "What to fill the form in with, for form:'add_class' — any of name, days (e.g. \"mon,wed,fri\"), starts (\"18:30\"), ends (\"19:30\"), venue, rate, rate_unit. Everything you could read goes in, including the parts you are unsure of; they can see and fix them, which is cheaper than you asking.",
        },
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
                  "One of: {kind:'operation',op,args} · {kind:'steps',steps,summary} · {kind:'reply',text} · {kind:'form',form} · {kind:'menu',menu} · {kind:'noop',ack}",
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
      "Schedule yourself to look at something later. It runs as an ordinary turn under this person's own permissions, and deciding to do nothing is the common and correct outcome. Reach for it whenever you say you will check back, whenever you promise to wait, and whenever you route something to somebody else and owe the person who raised it an answer. Then say in one clause what it will actually do — what you look at, how often, against what, until when, and that they will hear nothing if nothing moves. expires_at is REQUIRED: a watch with no expiry is a leak.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Short stable id for this watch, e.g. "meera-fee-followup".' },
        instruction: { type: 'string', description: 'What to check, what would make it worth saying something, and what to do about it. Include what silence means.' },
        run_at: { type: 'string', description: 'ISO timestamp. When the answer will actually exist — after the deadline, not before it.' },
        expires_at: { type: 'string', description: 'ISO timestamp. When this stops being worth doing. Required.' },
        context_query: { type: 'string', description: 'A SELECT whose result gives the task its data.' },
      },
      required: ['slug', 'instruction', 'run_at', 'expires_at'],
    },
  },
  {
    name: 'remember',
    description:
      "Write down a fact worth carrying: vocabulary, a policy, a habit, a preference, a stated boundary. Facts, not transcripts — short, about a person or the business, true beyond today. A fact that changes no behaviour was not worth storing, so be able to name what it changes. The obvious ones are the valuable ones: the word they use for a class, the day they always ask about money, that this parent never taps a button, that this coach wants three hours' notice. Corrections never edit — pass `supersedes` and keep both, so \"why does it think that?\" stays answerable.",
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
    name: 'handoff',
    description:
      'Hand this conversation to a person, with the reason and a short summary. Use it on anger, safety language, a refund or complaint you cannot settle, or anything the tools genuinely cannot serve. Agree first if they are right, then say what you have done and that you are stepping back — then stop trying to solve it.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        summary: {
          type: 'string',
          description:
            'What has happened so far, for the human picking it up. Their own words in quotes, where they physically are if that matters, how many other people are affected, and whether this has happened before — the repeat and the blast radius are what turn a complaint into a decision, and are the two things the admin cannot see from the chat.',
        },
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
    const found = await withSession(serviceFrom(ctx.session), async (tx) => {
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
      const preview = await previewPlan(ctx.session, steps, String(args?.intent ?? ''))
      if (!preview.ok) return { result: { ok: false, error: preview.error } }
      const handle = newId()
      const gate = needsPreview(preview, steps, {
        actorContactId: ctx.identity.contact.id,
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
      noteConfirmations(ctx, res.outcomes)
        if (!res.ok) return { result: { ok: false, executed: false, error: res.error } }
        ctx.worked = true
        ctx.committed = true
        // What a plan wrote is recorded the same way a named operation's writes
        // are. It was not, and that asymmetry was invisible while the honesty
        // guard only asked "did ANYTHING commit" — both paths set that flag. The
        // moment the guard asks "did the thing you SAID happen", a plan's diffs
        // are the evidence, and this is the commonest write path in the product.
        recordExecuted(ctx, 'plan', res.diffs)
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
      noteConfirmations(ctx, res.outcomes)
      if (!res.ok) return { result: { ok: false, error: res.error, sent: 0 } }
      ctx.worked = true
      ctx.committed = true
      recordExecuted(ctx, 'plan', res.diffs)
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
      const preview = await previewPlan(ctx.session, steps, String(args?.intent ?? ''))
      if (!preview.ok) return { result: { ok: false, error: preview.error } }
      if (needsPreview(preview, steps, { actorContactId: ctx.identity.contact.id })) {
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
      noteConfirmations(ctx, res.outcomes)
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
          // Said at the moment it becomes true, not discovered at the refusal:
          // the operation's own confirmation is the whole conversation now.
          ...(res.outcomes.some((o) => (o.status === 'sent' || o.status === 'queued') && o.confirmationRequest)
            ? { asked: 'A confirmation question is on their screen now — their tap answers it. Nothing further from you this turn.' }
            : {}),
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
      // A confirmation question from an operation this turn is already on their
      // screen. One tap answers it; a second confirmation — reworded, warmer,
      // better-buttoned — teaches them to ignore the first (F-F, driven: the
      // operation's "Just to be sure — cancel Aarav…?" and the model's own
      // version of the same question, one minute apart).
      if (ctx.confirmationAskedTo?.has(to)) {
        return {
          result: {
            error: 'a confirmation question from this turn is already on their screen',
            hint:
              'The operation asked them itself — one tap answers it. Say nothing more to this person this turn: ' +
              'a second confirmation, however worded, teaches them to ignore the first. Their tap is the next event.',
          },
        }
      }

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
        // The judgement is `checkClaims`, shared with the loop's trailing path.
        // What differs here, and stays here, is that this path has a round of
        // grace to spend: it can refuse and ask for a rewrite.
        const { claim, unsupported, unbacked } = checkClaims(body, ctx)
        if (unbacked) {
          if (!ctx.promiseChecked) {
            ctx.promiseChecked = true
            // Naming the verb is the difference between one round and three. A
            // message that is mostly true and wrong in one clause reads as
            // correct to the model too, so "nothing has been written this turn"
            // sends it looking for a problem it cannot see — and the turn that
            // produced this had committed a class quite correctly.
            const error = unsupported.length
              ? `that message says you ${unsupported.join(' and ')} something, and nothing was written this turn that ` +
                `would make that true. The rest of the message may be right — this is about the "${unsupported[0]}" part ` +
                `specifically.`
              : claim === 'claimed'
                ? 'that message says you did something, and nothing has been written this turn'
                : 'that message says you are about to do something, and there is no "about to" — the turn ends when you reply'
            return {
              result: {
                error,
                hint: unsupported.length
                  ? `Either do it now — ${unsupported.join(' / ')} — and then say so, or drop that clause and send the ` +
                    `part that is true. Do not reword it: the sentence is not what is wrong.`
                  : 'Do it now — `act` for a named operation, `plan` then a confirmation button for anything bigger — and ' +
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

          /**
           * ONLY when a plan is sitting here unconfirmed.
           *
           * The predicate answers "is this sentence a receipt?"; the gate asks "did THIS
           * turn commit?" Those are the same question only when the receipt is about
           * this turn, and English does not carry that distinction. A read-only turn
           * that truthfully reports earlier work — *"Requested ₹1,200 on 13 Aug, still
           * unpaid"* — is a receipt about the past, and substituting it tells an admin
           * the payment row does not exist when it does.
           *
           * That is not hypothetical: scheduled `agent_task` check-backs are read-only
           * by construction and about prior work by construction ("check if the invite
           * was forwarded"), and two such turns are already in this world, saved only by
           * having phrased themselves passively.
           *
           * A pending plan is the evidence that makes the two questions line up: the
           * model previewed something a moment ago and then described it as done, which
           * is exactly what was watched twice on money. With no plan pending the runtime
           * has no reason to believe the sentence is about this turn, so it keeps its
           * hands off and the one refusal round above remains the whole intervention.
           */
          const waiting = pendingConfirmation(ctx)
          if (waiting) body = pendingReadBack(waiting.summary)
        }
      }

      /**
       * The form the model's own sentence says it attached.
       *
       * The guard below refuses a message that points at a control it does not carry,
       * and refusing costs a round. Where the runtime can simply SATISFY the pointer it
       * should: an owner told "I've attached the business setup form" wants that form,
       * and the runtime is holding it. Driven — that exact sentence went out with
       * nothing but the generic `[What can you do?]` under it.
       *
       * Only when this message carries no affordance of its own: a model that DID offer
       * buttons has made a deliberate choice and the runtime does not overrule it. And
       * only to the owner themselves — `flow_token` is an action minted for one contact.
       */
      const bare = !args?.form && !buttons?.length && !args?.list
      if (
        bare
        && to === ctx.identity.contact.id
        && ctx.identity.roles.includes('admin')
        && /\bsetup form\b|\bbusiness setup\b|\bset ?up (?:screen|page|form)\b/i.test(body)
      ) {
        args = { ...args, form: 'business_setup' }
      }

      /**
       * Everything form-shaped is a form IN THE CHAT (§14.6).
       *
       * Onboarding asks a new business several things before anything useful can happen,
       * and the two ways to ask used to be both bad: a round trip per question, or one
       * signed URL that takes somebody out of WhatsApp into a browser on a phone. A Flow
       * is the third way — the same fields, one exchange, no browser, no login, and a
       * response bound to this conversation rather than to whoever holds a link.
       *
       * Resolved before the backstops below decide the message is bare, because a form is
       * this message's one action and nothing else may share it.
       */
      const form = await formForReply(ctx, args, to)
      if (form && 'error' in form) return { result: { error: form.error } }
      if (form && (buttons?.length || args?.list)) {
        // The same exclusivity the wire imposes. Said as a sentence the model can act on
        // rather than discovered as a suppressed message.
        return {
          result: {
            error: 'a message carries a form or reply buttons, never both — that is the wire, not a house rule',
            hint: 'Send the form on its own; offer anything else on the message after it. Say in the body that they can tell you the same things here instead.',
          },
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
        const hasAffordance = Boolean(form || buttons?.length || args?.list)
        if (pointsAtMissingAffordance(body, hasAffordance)) {
          ctx.affordanceChecked = true
          return {
            result: {
              error: 'that message points at a button or a form, and the message carries none',
              hint:
                'Either attach it — form:"business_setup" sends the business form right here in the chat, '
                + 'form:"add_class" and form:"register" send those, and buttons:[…] offers a next step — '
                + 'or say the thing plainly instead of pointing at a control that is not there.',
            },
          }
        }
      }

      if (to === ctx.identity.contact.id && !form) buttons = withFollowUps(buttons, ctx)

      /**
       * The bare-message backstop — `backstopButtons`, not a hardcoded menu.
       *
       * This branch minted `[{title: MENU_BUTTON_TITLE, action:{kind:'menu'}}]` directly,
       * which is the thing `backstopButtons` exists to improve on and only ever did on
       * the OTHER path. So both of its judgements were reachable only from the loop's
       * trailing prose: an admin mid-onboarding got `[What can you do?]` here instead of
       * `[Add a class] [Add a coach] [Set up the business]`, and the circular case its
       * own comment is about — a good answer to "what can you do?" with `[What can you
       * do?]` as its single affordance — was suppressed there and shipped here.
       *
       * The same defect as the honesty guard and the follow-ups before it: a rule
       * enforced on one of the two ways a message leaves a turn, where which one it
       * takes is the model's choice.
       */
      if (to === ctx.identity.contact.id && !form && !buttons?.length && !args?.list) {
        buttons = closingQuestionButtons(body) ?? backstopButtons(ctx.identity, body)
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
        flow: form ?? undefined,
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
        const contactIds = await adminContactIds(ctx.session.academyId)
        for (const contactId of contactIds) {
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
      await withSession(serviceFrom(ctx.session), async (tx) => {
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

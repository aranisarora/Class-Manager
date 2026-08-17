/**
 * lib/agent/tools.ts — a general agent on guardrailed primitives (§14.1).
 *
 * Seven generic primitives, not a catalog of hand-built features: read, write
 * (plan/commit/act), message, schedule, UI. Safety is structural, not
 * behavioural — RLS enforces, the diff is computed before commit, and every
 * message goes out the one send path. The floor being solid is what lets the
 * model be free above it.
 */

import {
  assertSingleReadStatement,
  modelQuery,
  serviceFrom,
  withSession,
  MODEL_ROWS_SHOWN,
  type SessionCtx,
} from '@/lib/db'
import { newId } from '@/lib/ids'
import type { ActionPayload } from '@/lib/actions'
import { composeAndSend } from '@/lib/messaging/compose'
import { CATALOG, type CatalogId } from '@/lib/messaging/catalog'
import { FORM_IDS, type FormId } from '@/lib/messaging/flows'
import { formFor } from '@/lib/messaging/forms'
import { LIMITS, validateOutbound, type SendOutcome, type SuppressReason } from '@/lib/messaging/types'
import { AGENT_TASK_CAP, dedupe, enqueue, liveAgentTasks, watchSubjectKey } from '@/lib/jobs'
import { adminContactIds } from '@/lib/identity'
import type { Identity } from '@/lib/types'
import { proseViolations, violationMessage } from './lint'
import { traceabilityNote } from './traceability'
import { policyShapedFact, rowShapedFact, writeFact } from './memory'
import type { ToolDecl } from './deepseek'
import { audienceFor, executePlan, needsPreview, parseSteps, previewPlan, type PlanStep } from './plan'
import {
  checkActionPayload, checkSteps, humanAssertionNote, HUMAN_ASSERTION_PARAMS,
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
  /**
   * One round of grace for machinery in the prose, and one for a shape the wire
   * will not take. Separate budgets, because they never fire on the same defect
   * and sharing one meant a turn already refused for the first spent the second's
   * grace as well — so the FIRST time its next message broke a cap, the check was
   * skipped entirely and the message went out.
   */
  proseChecked?: boolean
  shapeChecked?: boolean
  /**
   * Everything this turn's tools returned, verbatim, in order.
   *
   * The evidence half of R10: a number in a message either appears in here or the
   * turn did not read it. Filled by the loop at the one place a tool result is
   * recorded, so no future tool can forget to.
   */
  evidence?: string[]
  /** Shadow-mode R10 findings, for the flight recorder. Never blocks anything. */
  untraced?: { body: string; found: { value: string; kind: string }[] }[]
}

/* ------------------------------------------------------------------------- *
 * "I've added those families" — and nothing had run.
 *
 * The most dangerous failure in the product, because it reads as success: a reply
 * claiming a completed action with no write behind it. A person cannot tell it
 * apart from the truth.
 *
 * **This used to be six regexes and a substitution, and both halves are gone.**
 * The verb lists — `DONE_VERBS`, `CLAIMED_DONE`, `CLAIMED_DONE_BARE`,
 * `CLAIMED_DONE_OPENER`, `PROMISED_IMMINENT`, `PROMISED_BARE`, and a
 * `CLAIM_TABLES` map of eighteen verbs to the tables that would make each one
 * true — were the product's own best attempt at asking "is this sentence a
 * receipt?", and the record of what they cost is exactly ARCHITECTURE.md's
 * pattern-that-judges-prose trap:
 *
 *   `PROMISED_IMMINENT` matched "try" and missed **"retry"** — the single most
 *   likely verb in a recovery draft, and the verb in both notes-to-self that
 *   reached a person in the adversarial drive.
 *
 *   The whole guard was gated on a pending plan, so the turn with nothing true to
 *   claim was the turn with no guard at all, and a false "I've flagged it to the
 *   owner" about a child's injury shipped through the hole (F-AJ, F-AM).
 *
 *   And when it did fire it SUBSTITUTED — replacing the model's message with the
 *   runtime's read-back, which is the second author this architecture exists to
 *   remove: the person read one thing, the model believed it had sent another,
 *   and the next turn was composed against the draft.
 *
 * **What replaces it is state, told rather than detected.** F-AM's turn had zero
 * writes, which is trivially catchable — not by reading its sentence, but by
 * telling the model what the turn has actually done before it writes one, on
 * every round, as a fact. `turnState` below is that fact. The model repairs
 * everything it is told about honestly and mis-narrates everything it is not; it
 * was never the weak component here, and the runtime knowing something and
 * keeping it to itself is the failure this replaces.
 *
 * The traceability half — every stated fact tracing to a read or a write this
 * turn — runs in SHADOW MODE in `./traceability`, recorded and never blocking,
 * exactly as DRIVING.md specified it.
 * ------------------------------------------------------------------------- */

/** Which contacts an execute path just asked to confirm (ToolCtx.confirmationAskedTo). */
function noteConfirmations(ctx: ToolCtx, outcomes: SendOutcome[]): void {
  for (const o of outcomes) {
    if ((o.status === 'sent' || o.status === 'queued') && o.confirmationRequest && o.toContactId) {
      ctx.confirmationAskedTo?.add(o.toContactId)
    }
  }
}

/** Record what a plan wrote, so the turn's own state can be stated back. */
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
 * What this turn has actually done, in one line, told to the model every round.
 *
 * **This is the whole honesty mechanism now, and it is a statement rather than a
 * check.** The runtime is the only thing that knows whether anything happened,
 * and for the entire life of the verb lists it knew and did not say — it waited
 * until the model had written a sentence and then argued with the sentence. Every
 * failure in that argument was a failure of the argument, never of the model:
 * given the truth, the model's own reasoning was watched converting "I've flagged
 * it" into an actual routing, mid-turn.
 *
 * Deliberately counts, never advice. What to do about a turn that has written
 * nothing is a judgement, and a runtime that appended "so do not say you did
 * anything" would be composing.
 */
export function turnState(ctx: ToolCtx): string {
  const wrote = new Set<string>()
  for (const e of ctx.executed ?? []) for (const w of e.wrote ?? []) wrote.add(w.table)
  const landed = (ctx.outcomes ?? []).filter((o) => o.status === 'sent' || o.status === 'queued').length
  const waiting = [...(ctx.pendingMeta?.values() ?? [])].filter((m) => m.needsConfirm).length

  const bits: string[] = []
  bits.push(
    wrote.size
      ? `written to ${[...wrote].sort().join(', ')}`
      : 'written nothing — no row in this database has changed',
  )
  bits.push(
    landed ? `${landed} message${landed === 1 ? '' : 's'} actually reached somebody` : 'sent nobody anything',
  )
  if (waiting) bits.push(`${waiting} plan${waiting === 1 ? '' : 's'} waiting on a tap (nothing of it has run)`)
  return `So far this turn you have ${bits.join('; ')}.`
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
    // The examples no longer carry `academy_id` (0034 defaults it) or a tenant
    // predicate on the sub-select (RLS is the boundary, and SCHEMA_DOC says not
    // to add one). Both were noise the model imitates as surface — it copies an
    // example's SHAPE along with its content, which is why worked chat examples
    // are banned outright and why these two are kept to the narrowest thing that
    // demonstrates the point: a later step reading back an earlier step's row.
    '  [{"write":"insert into venue (name) values (\'Green Park\')"},\n' +
    '   {"write":"insert into class (name, venue_id, starts_on) values (\'Evening\', ' +
    '(select id from venue where name = \'Green Park\'), date \'2026-08-20\')"}]\n' +
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
    "  (select id from class where name = 'Beginners' and active and ends_on is null)\n" +
    'If that matches nothing, the class does not exist yet — create it rather than widening the ' +
    'lookup until something comes back.\n' +
    'Better still, if the row already exists, `read` its id first and pass the id itself.\n' +
    // "Reach for the operation rather than raw INSERTs, because create_class is the
    // only thing that schedules the sessions" stood here. It was an instruction
    // standing in for a property — and half false besides, since the planner
    // materialised every class on every tick anyway. The property is true now: a
    // class_slot implies its sessions by construction, whatever wrote the slot
    // (0033). What an operation used to carry that a statement cannot is the
    // half the schema still cannot say — what follows what — and that lives in
    // SCHEMA_DOC, where somebody writing SQL can read it.
    // "The operations that remain are the ones with no SQL sentence … everything
    // else is rows, and the rows are yours to write" stood here, and it was
    // false for most of the seventeen. `mark_attendance` writes the per-session
    // billing line; `cancel_session` credits what was billed, tells the families
    // and drops that session's prompts; `end_coach` issues a final statement and
    // reopens the coverage. Every one of those has a perfectly good SQL sentence
    // for the row it starts with, and a hand-written version of it silently
    // performs a fraction of the job — an attendance INSERT that bills nobody
    // being the one that costs money. A test the model can apply is the fix: not
    // "is there SQL for this" (there nearly always is) but "is there an operation
    // for this" (then it is doing more than the row).
    'A named operation exists BECAUSE doing that thing properly is more than its rows — it credits ' +
    'money back, tells the people affected, closes the prompts that are now moot, or needs a permission ' +
    'this person does not have. So when one covers what you are about to do, reach for it, and let it ' +
    'carry the rest. Raw statements are for everything no operation names, which is most of the schema.\n' +
    'Example, a class and its weekly time:\n' +
    '  [{"write":"insert into class (name, starts_on) values (\'Evening\', date \'2026-08-20\')"},\n' +
    '   {"write":"insert into class_slot (class_id, weekday, start_time, end_time) ' +
    "values ((select id from class where name = 'Evening' and active and ends_on is null), " +
    "1, time '18:00', time '19:00')\"}]",
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
  muted: 'This person asked to hear nothing in this category (comm_preference). It is a scope, not a full opt-out, so other things still reach them — and their own question is always answerable. If this genuinely needs to reach them, the way is to ask them to lift the mute, never to send it under another heading.',
  quiet_hours: 'It is the middle of the night where this business is. Nothing unprompted goes out during quiet hours — it is not a delay, this send is dropped. Schedule it for a waking hour instead, or let the standing job that owns this moment raise it at the right time.',
}

/* ------------------------------------------------------------------------- *
 * There is no backstop composer.
 *
 * `backstopButtons`, `MENU_BUTTON_TITLE`, `closingQuestionButtons`, `FOLLOW_UPS`
 * and `withFollowUps` used to live here: a menu bolted under any bare message, a
 * `[Yes] [No]` pair attached to any body ending in a question, and a next-step
 * button appended after any operation that ran. Each was added for a real
 * defect — an owner offered nothing, a question with nothing to tap, a first
 * coach added and never invited — and together they made the runtime a second
 * author of every message the model wrote.
 *
 * The evidence that they had to go is their own: `[What can you do?]` was the
 * most-minted button in the product, it announces capability instead of
 * demonstrating it, and the backstop's own comment says so. Driven from empty, an
 * admin typed "what can you do?", got a good four-bullet answer, and the single
 * affordance underneath it was **[What can you do?]** — the one thing offered to
 * somebody who had just been told everything was to ask again. And the backstop
 * decorated a child-injury acknowledgement with the same button, which is what
 * second authors do.
 *
 * What replaces them is the model being told, at the decode point, what a
 * buttonless reply costs the person — `reply`'s declaration says it, doctrine
 * names the three-slot budget and that a `{kind:'reply', text}` button needs no
 * arguments, and the model composing the message is the only thing in the system
 * that can pick a useful third option. It was never told to; now it is.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- *
 * Button actions, made legal before they are minted
 * ------------------------------------------------------------------------- */

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
 * **`withFollowUps` and `withRuntimeDiffLine` are gone, and they were the two
 * best-argued edits in the product.**
 *
 * `withFollowUps` appended §4.3's natural next step after any operation that ran,
 * on both paths a message can leave by, precisely because a guarantee that
 * depends on which path the model chose is not a guarantee. `withRuntimeDiffLine`
 * appended the runtime's own description of what a `steps` button would run,
 * under the model's prose, because the two had diverged three times in one driven
 * month — a trial's [Confirm] minting ₹1,600 of charges behind "free, nothing to
 * pay".
 *
 * Both append words to a message the model wrote, and ARCHITECTURE.md's rule is
 * not about intent: *anything that deletes, adds or rewrites words is not an
 * adapter*. What they cost is the same thing every edit here costs — the model's
 * only picture of its own message is its draft, so the next turn reasons from a
 * message that was never sent.
 *
 * Neither capability is lost, and this is why the removal is safe rather than
 * merely principled. The next step is doctrine's, at the decode point, where the
 * model can choose one that fits instead of a constant that fits sometimes. And
 * the diff line was solving a **two-authors** problem — the model describing a
 * plan the runtime holds — which layer 1 answers properly: the plan result
 * already carries `summary`, the row counts, the clashes and now the untold
 * audience, as facts, before the model writes a word about them.
 */
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
      // Parameters only a human's tap may set are not offered to the model at
      // all. `confirmed: boolean` in the declaration is an invitation — F-Q's
      // run 1 read "please stop messaging me now" straight into it — and every
      // model-set value of these is stripped on arrival anyway, so declaring
      // them advertises exactly the field the runtime forbids.
      parametersJsonSchema: parametersFor(op.params, HUMAN_ASSERTION_PARAMS),
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
      /**
       * There is no budget on LOOKING, and the declaration used to imply there
       * was. "A turn has AT MOST FIVE TOOL ROUNDS" sat directly under advice
       * about not spending rounds, and the two together read as *check less* —
       * against doctrine's *work with complete information*, which asks for the
       * sideways lookup nobody prompted.
       * The month drive is what that cost looks like: `class_coach` read zero
       * times in thirty-five turns, and a class created over an existing one
       * after two reads that only resolved ids. Rows are free; the scarce unit
       * is the round, and saying which is which is the whole fix.
       */
      'Reads are free and never wasted — ask for everything the decision needs, including the rows around the one you came for. Breadth costs nothing. ' +
      // The loop has always executed every function call in a round concurrently
      // (`for (const call of res.functionCalls)`), and nothing anywhere said so — so
      // the model asked one question per round and paid a whole prefix for each. A
      // four-step discovery chain is two rounds instead of four for one sentence here.
      'What costs is a ROUND, not a query: several read calls in one round cost one round between them, while asking one at a time costs a round each. So ask for everything you want ALL IN THE SAME ROUND. ' +
      // The budget was enforced and never stated, so the model paced a resource it
      // could not see — and learned it existed only by running out, with its notes
      // to itself shipped as the reply (F-AI). The count is stable; the position
      // arrives per round from the loop, which is the only thing that knows it.
      'A turn has five tool rounds across all tools and the runtime tells you which one you are on. Batched properly that is far more than any amount of looking needs, so it is never a reason to check less. ' +
      // The cap was stated and its CONSEQUENCE was not. 10,001 rows come back as a
      // complete-looking 10,000 plus a flag, and a count read off a truncated result is
      // simply wrong with nothing marking it — the same shape as every other silent
      // ceiling in this product. The flag is only useful if the model knows to look.
      'At the row cap the result is NOT an error: you get 10,000 rows and truncated:true, which looks exactly like a complete answer. Never state a count or a total off a truncated result — aggregate in SQL with count()/sum() instead of counting rows yourself. ' +
      // Refused before Postgres ever sees it, so there is no database error to read and
      // repair from — the only feedback is the refusal itself, which is cheaper to avoid.
      'Refused outright, before the database sees them: more than one statement, anything that is not SELECT/WITH, and the fragments pg_sleep, dblink, copy and pg_read.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        // "No semicolon needed" was not the same instruction as "one statement",
        // and a model that wanted two lookups sent them separated by `;` and lost
        // a round to the refusal. Say the constraint, and say what to do instead.
        query: {
          type: 'string',
          description:
            'EXACTLY ONE SELECT (or WITH … SELECT) statement. No semicolon, and never two statements. ' +
            // "Combine them with WITH … UNION ALL" was the advice, and it is a
            // trap for exactly the shape it was recommended for: stacking a venue
            // lookup on a coach lookup on a class lookup means unioning a uuid
            // column onto a text one, and Postgres refuses the whole statement
            // with `UNION types uuid and text cannot be matched`. Driven twice in
            // one turn, and the second attempt was the same shape again.
            // Sub-selects have no such rule, so they lead — and the batching this
            // was really asking for is several `read` CALLS in one round, which
            // the description above already says costs nothing extra.
            'To ask several unrelated things at once, put each as its own sub-select in one SELECT list — ' +
            "select (select count(*) from class) as classes, (select id from venue where name = 'X') as venue_id. " +
            'UNION ALL is for stacking rows of the SAME SHAPE: every branch must have the same column count ' +
            'AND matching types, so unioning an id onto a name is refused outright. Simplest of all, make ' +
            'several read calls in the same round.',
        },
        purpose: { type: 'string', description: 'What you are trying to find out. One short line.' },
      },
      required: ['query'],
    },
  },
  /**
   * The gate is stated HERE, at the decode point, and there is no `commit` tool
   * on the surface any more.
   *
   * The gate used to live in commit's error text, so the model learned it by
   * being refused — once per consequential flow, every flow, forever, because
   * history is rebuilt from message text and the lesson cannot persist. Stating
   * it on the declaration removed the wasted round (F-O; verified live, commit
   * called 0 times in 13 turns). What F-P then found is that the tool had no
   * reachable success path AT ALL: a plan that does not gate executes inside
   * `plan` and returns no handle, and every handle that IS stored waits on the
   * person's tap, which `commit` refused every time. A declaration describing a
   * path that does not exist is a two-author seam — so the declaration is gone,
   * the truth is stated here where the model decides, and the `commit` CASE in
   * `runTool` stays as the backstop that answers any stray call with the route
   * that works. The handle's real consumer is a button:
   * `{kind:'operation', op:'commit', args:{handle}}` resolves to the plan's own
   * steps at mint time (`resolveAction`), and the tap commits it.
   */
  {
    name: 'plan',
    description:
      'Compose a transaction of steps: it runs inside one transaction, the diff of every affected row is captured, and messages are staged, not sent. Two outcomes, decided by the runtime. A plan that touches nobody else, no money and nothing destructive has ALREADY RUN when this returns — say what you did, past tense. Anything bigger — money or the business\'s own settings, a message to anyone else, a delete, changing more than one existing row, a destructive operation, or a change that puts one coach in two places — comes back as a preview with a handle: NOTHING has run, and no call of yours can run it. Put the read-back on a reply whose button carries the plan ({kind:\'steps\',steps,summary} or {kind:\'operation\',op:\'commit\',args:{handle}}) — the person\'s tap is the commit. ' +
      // What the result carries that the model would otherwise have to infer, or
      // parse back out of a sentence. Each of these was a driven failure.
      'The result tells you three things nothing else can: which of your statements MATCHED NO ROWS (named, so you never have to guess which part did not land), whether anyone was put in TWO PLACES at once, and who this changed something for while the plan tells them NOTHING — that last one is yours to answer, by composing what each of them needs to hear or by being able to say why silence is right.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: 'What this plan is for, in the user\'s terms. Goes in the audit trail.' },
        steps: STEPS_PARAM,
      },
      required: ['intent', 'steps'],
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
      'And know your channel: prose you write in a round that calls tools reaches NOBODY — it is your notebook, not a message. What a person sees is what you pass here, or the closing text of your final round on an interactive turn — and that trailing text ships with NO buttons at all, because nothing is attached to it for you. ' +
      'So a choice you have worked out is not offered until each option is a button on a reply — options written into the body as prose or bullets cannot be tapped, and a line of [Bracketed labels] is refused rather than harvested. An option that has no operation behind it is still a button: {kind:\'reply\', text:"…"} just types those words back as their message, is always legal, and needs no arguments you do not have. ' +
      // The three restrictions the audit found the model was never told, each of
      // which it previously learned only by being refused, once per flow, forever
      // — history is rebuilt from message text, so the lesson cannot persist.
      'ONE MESSAGE PER PERSON PER TURN: a second call to the same recipient is refused, whatever it says. Whatever you learn after sending waits for their next message or rides a button on the one already in front of them. ' +
      'BUTTONS OR A LIST, NEVER BOTH, and a form carries neither. ' +
      // What is sent is what is written. This is new, and it is the fact the model
      // most needs when reasoning about its own previous message.
      'What you write here is what they read, byte for byte — nothing downstream trims, rewrites or decorates it. The two exceptions are stated where they apply: markdown becomes WhatsApp markup, and out of window the whole body is replaced by an approved template (the result tells you when that happened). ' +
      'A body carrying a uuid, an ISO timestamp, a table or column name, a section reference or a web address is refused with the offending text named, once, while you can still fix it.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        to_contact_id: {
          type: 'string',
          description:
            "Defaults to the person you are talking to. Pass 'admin' to address whoever runs the business — you never need to look their contact up, and from most sessions you cannot (who the admin is stays out of view by design). A proposal routed to the admin carries the change as a steps button; their tap approves it under their own permission.",
        },
        body: {
          type: 'string',
          description:
            // The one limit whose breach is silent, stated where the model is
            // writing (F-AH). Every neighbour already declares its cap; this is
            // the cap that decides whether the buttons survive.
            `Plain text may run to ${LIMITS.textChars} characters, but a message carrying buttons, a list or a form is capped at ${LIMITS.bodyChars} — attaching anything tappable spends three-quarters of the room. Over ${LIMITS.bodyChars} the words still go out and EVERY BUTTON IS SILENTLY DROPPED, so a long explanation and a tap cannot ride one message: when you attach buttons, keep the body under ${LIMITS.bodyChars} characters, and cut the explanation before you cut the affordance.`,
        },
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
      "Schedule yourself to look at something later. It runs as an ordinary turn under this person's own permissions, and deciding to do nothing is the common and correct outcome. Reach for it whenever you say you will check back, whenever you promise to wait, and whenever you route something to somebody else and owe the person who raised it an answer. Then say in one clause what it will actually do — what you look at, how often, against what, until when, and that they will hear nothing if nothing moves. expires_at is REQUIRED: a watch with no expiry is a leak. " +
      'And know what already runs without you: standing jobs remind every family before every session, chase every unmarked register, send each coach their day and the owner their brief and digest, bill the month, and chase every unpaid bill (a dunning ladder: a few spaced nudges, then it puts the bill in front of the admin). A watch duplicating one of those sends somebody the same thing twice — the promise is already kept, so say so instead of minting it. ' +
      // Stated up front rather than only on hitting it. A cap discovered by refusal is a
      // round spent, and the refusal arrives at the moment a promise has usually already
      // been made in prose — which is the one thing this tool exists to stop.
      'A business can hold 25 live watches at once. Past that this refuses, so if you are near it, drop one you no longer need rather than promising something you cannot mint.',
    parametersJsonSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description:
            'WHAT is being watched, as a short stable noun phrase — "meera august fee", "arjun monday register", ' +
            '"kabir trial follow-up". Not what you will do about it. A second watch on the same subject REPLACES ' +
            'the first, so restating one you already have is safe and duplicating one is impossible: this is the ' +
            'field that stops the same thing being watched five ways under five names.',
        },
        slug: { type: 'string', description: 'Short stable id for this watch, e.g. "meera-fee-followup".' },
        instruction: { type: 'string', description: 'What to check, what would make it worth saying something, and what to do about it. Include what silence means.' },
        run_at: { type: 'string', description: 'ISO timestamp. When the answer will actually exist — after the deadline, not before it.' },
        expires_at: { type: 'string', description: 'ISO timestamp. When this stops being worth doing. Required.' },
        context_query: {
          type: 'string',
          description:
            'A SELECT whose result gives the task its data. Checked against the real schema when you mint it, ' +
            'not on the day it fires — so a table that does not exist is a refusal now rather than a watch that ' +
            'runs blind weeks from now.',
        },
      },
      required: ['subject', 'slug', 'instruction', 'run_at', 'expires_at'],
    },
  },
  {
    name: 'remember',
    description:
      "Write down a fact worth carrying: vocabulary, a habit, a preference, a stated boundary. Facts, not transcripts — short, about a person or the business, true beyond today. And facts, not rows: a rate, a schedule, a venue, a phone number, who pays for whom, a balance — the tables hold those, and a memory copy is a future wrong answer waiting for the row to change, so if a table holds it, do not write it. One instance is never a policy: store what happened and for whom, not a rule you inferred from it. " +
      // The home a policy actually has, named where the wrong home is being
      // reached for. Refused at the write as well, so this is not the only guard.
      "**A rule about how the business runs is not a memory fact — it is a `business_rule` row**, carrying the owner's own words and its provenance: owner_stated outranks everything and only they retire it, while something you merely noticed is a suggestion until they bless it. And nothing you said yourself is evidence for either: a policy invented in a reply and then remembered acquires the authority of one the owner stated, which is exactly how a refund rule nobody had ever set became this business's policy. " +
      "A fact that changes no behaviour was not worth storing, so be able to name what it changes. The obvious ones are the valuable ones: the word they use for a class, the day they always ask about money, that this parent never taps a button, that this coach wants three hours' notice. Corrections never edit — pass `supersedes` and keep both, so \"why does it think that?\" stays answerable.",
    parametersJsonSchema: {
      type: 'object',
      properties: {
        // 'business' is the product's own word for the academy (nothing a user
        // sees ever says "academy"), so the executor accepts it as the same
        // thing rather than punishing the vocabulary the rest of the prompt
        // teaches.
        subject_kind: { type: 'string', enum: ['academy', 'business', 'person'] },
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
function compactDiff(r: Awaited<ReturnType<typeof previewPlan>>, executed = true) {
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
    // Already inside `summary` — it is one of the plan's notes — but a fact the
    // model has to reason about should not have to be parsed back out of a
    // sentence. This is also why the plan came back needing a tap.
    ...(r.clashes.length ? { clashes: r.clashes } : {}),
    /**
     * Who this changed something for while telling them nothing.
     *
     * The substrate can see the audience; only the person composing can decide
     * whether silence is right. Sometimes it plainly is — a coach's decline
     * while others remain assigned changes nothing for the parents. So this is
     * a fact and an instruction to decide, never an instruction to send.
     */
    ...(r.untold.length
      ? {
          affected_and_untold: r.untold,
          affected_note:
            'Their arrangements changed and nothing here reaches them. Either compose what each of them ' +
            'needs to hear — one message per person, whatever they are actually affected by — or be able ' +
            'to say why silence is right for them.',
        }
      : {}),
    /**
     * The steps that ran and matched nothing, NAMED.
     *
     * This used to be a count inside the summary sentence, which meant two
     * failures at once: the model spent a round guessing which of its steps was
     * meant, and the sentence itself reached a prospect's phone as part of a
     * receipt. A diagnostic either says which, in words the author can act on, or
     * it says nothing — and it never travels in a message body.
     */
    ...(r.emptyWrites.length
      ? {
          matched_no_rows: r.emptyWrites,
          matched_no_rows_note:
            'Those statements ran and changed nothing. The rest of the plan committed. Read the WHERE ' +
            'on each — either it names something that is not there, or this person may not change it — ' +
            'and do not describe that part as done.',
        }
      : {}),
    ...(r.unaddressed ? { messages_with_no_recipient: r.unaddressed } : {}),
    // One diff, two truths. An EXECUTED diff is what is now in the rows; a
    // STAGED one is what a tap WOULD write — and carrying the executed
    // coaching on both taught a staged "rows: 2" to read as a receipt: the
    // recovery round told an admin "Done — both of Aarav's classes end
    // 30 Sep" over two rows still NULL (month drive). Say which truth this is.
    check: executed
      ? 'Read `wrote` before you describe this. What is in the row is what is true — if it is not what they meant, fix it now rather than describing what you intended.'
      : 'NOTHING HAS RUN — this is a preview of what their tap would change. Describing it in the past tense would be false: offer the confirmation button and say what happens when they tap it.',
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
      /**
       * Empty and withheld arrive as the same zero rows, and only the runtime
       * knows whose session this is — so the distinction is made here, where the
       * result is (F-AD). The admin's empty is real: their policy sees their
       * whole business. Anyone else's empty may be rows that exist and are not
       * theirs to see, and a reply built on it asserted "no families have been
       * added yet" to a stranger, then repeated it to the owner, over a business
       * holding four children in three classes.
       */
      const scoped =
        res.rowCount === 0 && !ctx.identity.roles.includes('admin')
          ? {
              note:
                'Zero rows under a scoped session. This person\'s view is limited by policy, so an empty result can mean ' +
                '"none exist" OR "not theirs to see" — you cannot tell which from here. Report what they can see; where ' +
                'their view ends, say it is not something you can see from here. Never assert that a thing does not exist ' +
                'off an empty read this person\'s permissions could have emptied.',
            }
          : null
      /**
       * **The hand-back has always been clipped at 200 and has never said so.**
       *
       * `truncated` is `modelQuery`'s flag and means "the query matched more than
       * the 10,000-row cap". It says nothing about this slice, so a read matching
       * 900 rows came back as `rowCount: 900, truncated: false` beside exactly 200
       * row objects — a complete-looking answer, of the shape this product spends
       * its whole schema block warning about, produced by the runtime rather than
       * by the database. The `read` declaration names 10,000 as the only ceiling,
       * which made the number in front of the model wrong as well as unexplained.
       *
       * Saying it is the whole fix. `rowCount` is the true count and stays the
       * thing to reason with; `rows_shown` marks the sample, and the note says
       * which of the two a total may be read off.
       */
      const shown = res.rows.slice(0, MODEL_ROWS_SHOWN)
      const clipped = res.rowCount > shown.length
      return {
        result: {
          scope,
          rowCount: res.rowCount,
          truncated: res.truncated,
          ms: res.ms,
          rows: shown,
          ...(clipped
            ? {
                rows_shown: shown.length,
                note_rows:
                  `${res.rowCount} rows matched and the first ${shown.length} are here. The rest were not sent. ` +
                  `rowCount is the real total — never count these rows yourself, and if you need a figure over ` +
                  `the whole set, ask for it with count()/sum() instead.`,
              }
            : {}),
          ...(scoped ?? {}),
        },
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
      // The same column-repair the `read` path has had all along, on the path
      // where getting it wrong is most expensive: a plan is ONE transaction, so
      // an invented column takes every correct step beside it down with it. The
      // model's only clue was `column "x" does not exist`, while the runtime
      // could say which table x is actually on and was simply never asked.
      if (!preview.ok)
        return {
          result: { ok: false, error: preview.error, ...(await whereThatColumnLives(ctx, String(preview.error ?? ''))) },
        }
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
          ...compactDiff(preview, false),
          intent: String(args?.intent ?? ''),
          ...planIgnored,
        },
        note: preview.summary,
      }
    }

    /* -------------------------------------------------------------- commit */
    // Not declared any more (see the note above `plan`'s declaration): a plan
    // that needs nobody's confirmation has already run, and one that does is
    // committed by the person's tap. This case is the backstop for a model that
    // calls it anyway, and its job is to name the route that works.
    case 'commit': {
      const handle = String(args?.handle ?? '')
      const steps = ctx.pendingPlans.get(handle)
      // Commit by handle only: the model cannot commit a plan it did not just
      // preview, which is what keeps §2.3 from being advisory.
      if (!steps) {
        return {
          result: {
            error: 'no plan is waiting under that handle',
            hint:
              'A plan that needed no confirmation already ran when you staged it — nothing is left to commit. ' +
              'A plan that does need confirmation is committed by the person\'s tap, never by you: put the ' +
              "read-back on a reply whose button carries {kind:'operation', op:'commit', args:{handle}} or the " +
              "steps themselves, and stop calling this tool.",
          },
        }
      }

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
      // The same column-repair the `read` path has had all along, on the path
      // where getting it wrong is most expensive: a plan is ONE transaction, so
      // an invented column takes every correct step beside it down with it. The
      // model's only clue was `column "x" does not exist`, while the runtime
      // could say which table x is actually on and was simply never asked.
      if (!preview.ok)
        return {
          result: { ok: false, error: preview.error, ...(await whereThatColumnLives(ctx, String(preview.error ?? ''))) },
        }
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
            ...compactDiff(preview, false),
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
      /**
       * "The admin" is an address, not a lookup.
       *
       * A non-admin session cannot resolve the admin's contact — `academy_admin`
       * shows them only their own row, by design — so "route the proposal to the
       * admin" was a sentence the model could not act on from exactly the
       * sessions that need it most. Driven twice: T065's five reads of an
       * "empty" admin table ended in a promise routed nowhere, and the f-q probe
       * reproduced it verbatim ("no admin on record" about a business with an
       * owner). The runtime resolves the address the same way `handoff` always
       * has; the first admin contact is the recipient, and a business genuinely
       * without one gets a refusal that names `handoff` as the fallback.
       */
      let to = String(args?.to_contact_id ?? ctx.identity.contact.id)
      if (/^(the )?(admin|owner)$/i.test(to.trim())) {
        const adminIds = await adminContactIds(ctx.session.academyId).catch(() => [] as string[])
        if (!adminIds.length) {
          return {
            result: {
              error: 'no admin contact is reachable to route this to',
              hint: 'Use handoff instead — it records the escalation even when nobody is reachable right now.',
            },
          }
        }
        to = adminIds[0]
      }

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
      //
      // A button whose action cannot be minted is DOWNGRADED, never silently
      // deleted: the tap becomes typing the title — the same privilege the
      // person already has — so the option the prose points at still exists,
      // and the working route (their words come back in, the operation stages
      // its own lawful confirmation) is one tap longer rather than gone.
      //
      // Both prior shapes were worse. Taking the whole call down orphaned the
      // previewed plan while the model retried itself out of rounds. Dropping
      // the button while the message went shipped prose naming a control that
      // was not on the screen — F-Q, on the one request that cannot be
      // half-kept: "please stop messaging me now" went out with its
      // [Stop all messages] deleted, because it carried confirmed:true and the
      // refusal fired after the model's last word, where no instruction can
      // reach. Only a button with no title at all has nothing to degrade to.
      //
      // What was downgraded comes back in the result — on every send, partial
      // or not — so the model learns inside the same turn.
      const downgraded: { title: string; why: string }[] = []
      let buttons: { title: string; action: any }[] | undefined
      if (Array.isArray(args?.buttons)) {
        buttons = []
        for (const b of args.buttons.slice(0, LIMITS.buttons)) {
          const resolved = resolveAction((b as any)?.action, ctx)
          const title = String((b as any)?.title ?? '').trim()
          if (!resolved.ok) {
            downgraded.push({ title, why: resolved.error })
            // Downgraded, never deleted: the tap becomes typing the title, which is
            // a privilege the person already has, so the option the prose points at
            // still exists and the working route is one tap longer rather than gone.
            // This is not the runtime authoring anything — the label is the model's
            // own word, unchanged — and what happened comes back in the result.
            if (title) buttons.push({ title, action: { kind: 'reply', text: title } })
            continue
          }
          // Not fitted. A title over the cap is refused below with the cap named,
          // while there is a round left to shorten it — `fitTitle` used to cut
          // "I'm done with the roster" to "I'm done with the ro" and ship it.
          buttons.push({ title, action: resolved.action })
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

      const body = String(args?.body ?? '')

      /**
       * **What the string itself decides, refused before anything is composed.**
       *
       * Two guards used to stand here and both of them edited: an honesty check
       * over verb lists that substituted the runtime's own read-back when it fired
       * twice, and a `/\bsetup form\b|\bbusiness setup\b/i` test that silently
       * attached a form because the prose mentioned one. Both read language to
       * decide what a person receives, which is the thing ARCHITECTURE.md's layer
       * 2 forbids outright, and the second is the purer example: a regex over a
       * sentence, deciding to put a form on somebody's screen.
       *
       * `proseViolations` is what a string operation may legitimately answer —
       * "does this contain a uuid, an ISO timestamp, a section reference, a raw
       * URL, a wire blob, a line of pseudo-buttons, the word academy" all have one
       * answer, the way "is this an overclaim" does not. Every one of them was
       * previously rewritten on the way past; every one is now a refusal naming
       * what is wrong and what to do, with a round of grace, while the model can
       * still fix it. What ships is byte-for-byte what the model wrote.
       *
       * Fires at most once per turn. The budget is not politeness — a model
       * arguing with a refusal it cannot satisfy spends the person's whole turn —
       * and a second attempt goes out as written, because silencing somebody is
       * worse than a machine word in an otherwise good sentence.
       */
      if (!ctx.proseChecked) {
        const violations = proseViolations(body, ctx.identity)
        if (violations.length) {
          ctx.proseChecked = true
          return {
            result: {
              error: `that message cannot go as written: ${violationMessage(violations)}`,
              hint: 'Rewrite just those parts and send it again. Everything else about the message is fine.',
              sent: false,
            },
          }
        }
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
       * `pointsAtMissingAffordance` used to stand here, refusing a message whose
       * body said "tap the button below" when the message carried none — and its
       * own pattern then decided, in `send`, whether an over-long message lost its
       * buttons or was suppressed entirely. It was the clearest case in the
       * product of a regex whose output touched a customer's message, and it is
       * gone with the backstops it was written to stand in front of.
       *
       * What replaces it is that there is nothing to point at falsely any more.
       * The runtime no longer attaches a menu, a `[Yes]/[No]` pair or a follow-up,
       * so a message with no buttons is a message the model chose to send with no
       * buttons — and `reply`'s declaration tells it, at the decode point, exactly
       * what that costs the person reading it.
       */

      // A list is the primary affordance (§7.2), so its rows get exactly the same
      // treatment as buttons: resolved and validated before minting. One bad row
      // used to take the whole picker — and the whole message — with it.
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
              // Titles unfitted here too — `validateOutbound` names the row and the
              // cap, which is a repair the model can make and a trim is not.
              title: String(r?.title ?? ''),
              description: r?.description ? String(r.description) : undefined,
              action: resolved.action,
            })
          }
          sections.push({ title: String(s?.title ?? ''), rows })
        }
        list = { buttonText: String(list.buttonText || 'Choose'), sections }
      }

      /**
       * The wire's own shape limits, checked here rather than discovered as a
       * suppression.
       *
       * This is the other half of "validation refuses, it never mutates": every
       * one of these caps is on the declaration the model decodes against, and
       * every one of them used to be enforced by a silent trim or by dropping the
       * affordance. Refused once, with the reason, while a round remains — the
       * interactive body cap especially, which is the limit whose breach used to
       * be entirely silent and cost an admin every button on a good answer.
       */
      if (!ctx.shapeChecked) {
        const shape = validateOutbound({
          toContactId: to,
          body,
          header: args?.header ? String(args.header) : undefined,
          footer: args?.footer ? String(args.footer) : undefined,
          catalogId: catalogId ?? null,
          templateName: null,
          idempotencyKey: 'shape-check',
          buttons: buttons?.map((b, i) => ({ actionId: `pending-${i}`, title: b.title })),
          list: list?.sections
            ? {
                buttonText: String(list.buttonText ?? 'Choose'),
                sections: list.sections.map((s: any, si: number) => ({
                  title: String(s.title ?? ''),
                  rows: (s.rows ?? []).map((r: any, ri: number) => ({
                    actionId: `pending-${si}-${ri}`,
                    title: String(r.title ?? ''),
                    description: r.description,
                  })),
                })),
              }
            : undefined,
        })
        if (shape.length) {
          ctx.shapeChecked = true
          return {
            result: {
              error: `that message will not render: ${shape.join('; ')}`,
              hint:
                `Cut it to fit rather than cutting the affordance — over ${LIMITS.bodyChars} characters a message ` +
                'carrying buttons cannot go at all, and the explanation is the part that can move to a second turn.',
              sent: false,
            },
          }
        }
      }

      /**
       * R10, recorded and not enforced. See `./traceability` for why it is a
       * comparison against this turn's own evidence rather than a verb list, and
       * why DRIVING.md's spec says do not ship it live.
       */
      const untraced = traceabilityNote(body, ctx.evidence ?? [])
      if (untraced) ctx.untraced?.push({ body, found: untraced })

      const outcome = await composeAndSend(ctx.session, {
        toContactId: to,
        body,
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
        // The body, which is now also the body the person reads: nothing between
        // here and the wire rewrites a word, and the one transform that remains
        // changes representation only.
        if (to === ctx.identity.contact.id && body.trim()) ctx.saidToUser?.push(body.trim())
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
      /**
       * What the wire changed between this call and the phone.
       *
       * There used to be a long list of these — a bolted-on menu, a stripped
       * button row, a repaired body — and reporting them was the right answer to
       * the wrong design. **The final shape does not report the runtime's edits;
       * it does not have edits.** What is left is the one thing the runtime does
       * not author and cannot prevent: out of window the wire itself replaces the
       * body with an approved template shell (see layer 4's one-author rule), and
       * the model has to know that is what the person read.
       */
      const altered = ('altered' in outcome ? outcome.altered : undefined) ?? []
      return {
        result: {
          status: outcome.status,
          ...('reason' in outcome ? { reason: outcome.reason } : {}),
          ...(altered.length
            ? {
                altered,
                altered_note:
                  'The message went out, but not exactly as written — the changes above are what the person actually ' +
                  'received. Reason from that version, not your draft, and do not resend to fix it.',
              }
            : {}),
          ...(downgraded.length
            ? {
                downgraded_buttons: downgraded,
                note:
                  'Those actions could not be minted, so each button was downgraded to a plain reply button — tapping it ' +
                  'sends its title back as their message, and you handle it next turn. The message went out that way; do ' +
                  "not resend it. To offer the action properly next time: to commit a plan you previewed, pass " +
                  "{kind:'steps', steps:<the steps>, summary:'…'} or {kind:'operation', op:'commit', args:{handle}} with a " +
                  'handle from THIS turn. Never put a tool name (plan, commit, act, read) where an operation name belongs.',
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

      /**
       * The SUBJECT, declared, because a slug is not one.
       *
       * F-C: seven watches about the same two unmarked registers, minted across a
       * few turns under seven different slugs — `follow-up-mon-register`,
       * `remind-unmarked-registers-aug-17-19`, `arjun-register-nudge-monday` — and
       * every one of them a distinct dedupe key, so nothing anywhere could see
       * they were one thing. They fired together and sent a coach seven
       * near-identical messages in three minutes, one of them referring to him in
       * the third person; then the frequency cap spent his budget and the message
       * that actually mattered, a parent's cancellation, was the one dropped.
       *
       * The runtime cannot derive the subject from the instruction without
       * reading prose, which is the thing it may not do. So the model states it,
       * the runtime normalises it, and a partial unique index makes a second watch
       * on the same subject supersede rather than accumulate.
       */
      const subject = String(args?.subject ?? '').trim()
      if (!subject) {
        return {
          result: {
            error: 'subject is required — what is being watched, as a short stable noun phrase',
            hint:
              'Not what you will do about it: what it is ABOUT. "meera august fee", "arjun monday register", ' +
              '"kabir trial follow-up". A second watch on the same subject replaces the first, which is what ' +
              'stops one thing being watched five ways.',
          },
        }
      }

      /**
       * A `context_query` written from imagination (F-AP).
       *
       * Both watches minted in one drive carried SQL against tables that do not
       * exist — `from register where family_id = 'meera'`, `from devs d left join
       * owner_decisions` — and neither would fail until its fire day, weeks later,
       * when the task runs blind on its instruction alone and nobody is watching.
       * Validated here, at mint, while the model can still fix it: parsed and
       * planned, never executed, so it costs one round trip and touches nothing.
       */
      const contextQuery = args?.context_query ? String(args.context_query) : null
      if (contextQuery) {
        try {
          assertSingleReadStatement(contextQuery)
        } catch (e) {
          return {
            result: {
              error: `context_query is not a single SELECT: ${e instanceof Error ? e.message : String(e)}`,
            },
          }
        }
        const planned = await withSession(ctx.session, async (tx) => {
          await tx.unsafe(`explain ${contextQuery}`)
          return true
        }).catch((e: unknown) => (e instanceof Error ? e.message : String(e)))
        if (planned !== true) {
          /**
           * The same column-repair the `read` path has had all along.
           *
           * `whereThatColumnLives` existed and was wired to exactly one of the
           * three places a model-authored statement can fail. Driven: a watch was
           * minted with `select … from message where person_id = …`, which is the
           * §6.2 confusion this schema invites — `message` is keyed by CONTACT —
           * and the refusal said only that the column does not exist. The runtime
           * knew which table it was on and did not say, so the model's only route
           * back was to re-read 40k characters of schema and guess again.
           */
          return {
            result: {
              error: `context_query will not run: ${String(planned)}`,
              hint:
                'It is checked now rather than on the day it fires, because a watch that errors weeks from ' +
                'now runs blind on its instruction and nobody finds out. Read the schema, fix the query, and ' +
                'mint it again — or drop context_query and let the task read what it needs when it runs.',
              ...(await whereThatColumnLives(ctx, String(planned))),
            },
          }
        }
      }

      const slug = String(args?.slug ?? newId())
        .replace(/[^a-z0-9_-]/gi, '-')
        .slice(0, 60)
      const dedupeKey = dedupe.agentTask(ctx.session.academyId, `${slug}-${newId().slice(0, 8)}`)
      const subjectKey = watchSubjectKey(ctx.session.academyId, subject)
      try {
        const minted = await enqueue(
          'agent_task',
          runAt,
          dedupeKey,
          {
            academy_id: ctx.session.academyId,
            slug,
            subject,
            instruction: String(args?.instruction ?? ''),
            context: contextQuery,
            minted_by: ctx.turnId,
            minted_by_contact_id: ctx.identity.contact.id,
            minted_roles: ctx.identity.roles,
            expires_at: expires.toISOString(),
          },
          ctx.session.academyId,
          subjectKey,
        )
        // "I'll check back on Friday" is a promise a scheduled watch keeps.
        ctx.worked = true
        return {
          result: {
            ok: true,
            job_id: minted.id,
            slug,
            subject,
            run_at: runAt.toISOString(),
            expires_at: expires.toISOString(),
            // Said, because it changes what is true: the older watch is not
            // running any more, and a message promising both would be wrong.
            ...(minted.superseded
              ? {
                  superseded: minted.superseded,
                  superseded_note:
                    'You were already watching this subject. That watch has been replaced by this one — there ' +
                    'is one, not two, and this is the one that will fire.',
                }
              : {}),
          },
          note: `watching: ${subject}`,
        }
      } catch (e) {
        return { result: { error: e instanceof Error ? e.message : String(e) } }
      }
    }

    /* ------------------------------------------------------------ remember */
    case 'remember': {
      /**
       * "business" means the academy. The reflection prompt says "business = <id>"
       * — the product's own vocabulary, since "academy" appears nowhere a user
       * sees — and the model obliged with `subject_kind: "business"`, which the
       * old two-way coercion mapped to PERSON. The write then failed on "no such
       * person" (the id was the academy's), the fire-and-forget swallowed it,
       * and the tool answered ok:true — a fact recorded nowhere, reported as
       * kept, every time reflection spoke the product's own language. The id is
       * the tiebreaker of last resort: whatever the kind said, the academy's own
       * id names the academy.
       */
      const kindRaw = String(args?.subject_kind ?? '')
      const subjectKind =
        kindRaw === 'academy' || kindRaw === 'business' || args?.subject_id === ctx.session.academyId
          ? 'academy'
          : 'person'
      const subjectId =
        subjectKind === 'academy'
          ? ctx.session.academyId
          : String(args?.subject_id ?? ctx.identity.person.id)

      // The placement gate (§5, F-D), answered in-round so the caller can keep
      // the preference and drop the figure — a refusal after the turn is a
      // refusal nobody hears.
      const rowShaped = rowShapedFact(String(args?.fact ?? '')) ?? policyShapedFact(String(args?.fact ?? ''))
      if (rowShaped) {
        return {
          result: {
            error: `not stored: ${rowShaped}`,
            hint: 'Memory holds what the schema cannot. If half the fact is a preference or a habit, store that half alone.',
          },
        }
      }

      /**
       * §5 says a fact write never blocks a reply, and this used to read
       * `void writeFact(...).catch(() => {})` followed by an unconditional
       * `{ ok: true }`. That is not non-blocking, it is **unobserved**: the gate
       * above runs synchronously, and everything after it — the insert, the dedupe
       * check, the curation trigger — could fail with the model already told the
       * fact was stored. It then says "I'll remember that" on the strength of a
       * value nothing computed.
       *
       * The same shape as the census `null`-vs-`[]` bug and as the clash check: a
       * failure and a success reported with one value. Awaiting it costs one
       * round-trip on a call that is already inside a tool, and the reply is not
       * composed until the round ends anyway — so nothing is actually blocked that
       * was not already waiting.
       */
      try {
        await writeFact(ctx.session, {
          subjectKind,
          subjectId,
          fact: String(args?.fact ?? ''),
          source: `turn:${ctx.turnId}`,
          supersedes: args?.supersedes ? String(args.supersedes) : undefined,
        })
      } catch (e) {
        return {
          result: {
            error: `not stored: ${e instanceof Error ? e.message : String(e)}`,
            hint: 'The fact was NOT saved. Do not tell them you will remember it. Say what you know now, and try again next turn if it still matters.',
          },
        }
      }
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

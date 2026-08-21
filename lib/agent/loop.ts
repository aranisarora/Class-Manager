/**
 * lib/agent/loop.ts — one turn.
 *
 * Shape: resolve identity → if this is a button tap, consume the action and
 * execute the stored payload with NO model call (§2.2 — a misread at tap time
 * commits someone to being somewhere) → otherwise build prefix + tail, run up
 * to 8 tool rounds, lint, send. A `turn` row is written every time, including
 * on error, because a turn that vanished is an invisible failure.
 */

import { modelQuery, withSession, type SessionCtx } from '@/lib/db'
import { errorMessage } from '@/lib/errors'
import { now, inZone } from '@/lib/clock'
import { newId } from '@/lib/ids'
import { env } from '@/lib/env'
import { resolveIdentity } from '@/lib/identity'
import { runFrontDeskTurn, type Handover } from '@/lib/frontdesk'
import { consumeAction, type ActionPayload } from '@/lib/actions'
import { composeAndSend } from '@/lib/messaging/compose'
import { LIMITS, type SendOutcome } from '@/lib/messaging/types'
import type { Identity, Job, Role } from '@/lib/types'
import { generate, type Msg } from './deepseek'
import { stablePrefix, variableTail } from './context'
import { proseViolations, violationMessage } from './lint'
import { traceabilityNote } from './traceability'
import { fullTraceOn } from './turn-trace'
import { hotSet } from './memory'
import { audienceFor, executePlan, type PlanStep } from './plan'
import { jsonLit, lit, uid, type OperationName } from './operations'
import {
  pendingConfirmation,
  runTool,
  toolDecls,
  turnState,
  type ToolCtx,
} from './tools'

export type TurnInput = {
  contactId: string
  text?: string
  media?: { url: string; mimeType: string }[]
  actionId?: string
  source: 'inbound' | 'job' | 'sim'
  /** Runtime-internal: a self-scheduled task's instruction and its data (§13.1). */
  task?: { instruction: string; queryResults?: unknown }
}

export type TurnOutput = { turnId: string; sent: SendOutcome[]; toolCalls: number; error?: string }

/**
 * The ceiling on tool rounds, and why it is 5 rather than 8.
 *
 * Rounds are the entire cost and latency story — the stable prefix is paid on
 * every uncached round, so a turn that goes round twice costs twice, and
 * WhatsApp cannot stream, which means these seconds are seconds of silence.
 *
 * Measured over 120 turns across seven academies, `rounds` against "did any tool
 * call in this turn come back with an error":
 *
 *     rounds   turns   with a failed tool call
 *       0–2      81      0        (0%)
 *         3      18      9       (50%)
 *         4       9      6       (67%)
 *         5       8      8      (100%)
 *         6       2      1       (50%)
 *         7       2      2      (100%)
 *         8       0      —      never reached
 *
 * Two things fall out of that. **The cap of 8 had never once been hit**, so it
 * was not bounding anything — the real ceiling was the model giving up. And
 * every turn that ran past four rounds was recovering from a failure, not doing
 * useful work: below three rounds nothing has ever failed, at five everything
 * has.
 *
 * The rounds past four were not buying answers, they were buying more expensive
 * wrong ones. Both 7-round turns were a parent asking to stop their child's
 * lessons; both burned seven rounds against an RLS refusal, wrote **zero audit
 * rows**, and replied "I've noted that she will be stopping" — a sentence the
 * family reads as done, about a row that never changed.
 *
 * **What lowering it takes away.** A turn that would genuinely have recovered on
 * round 6 or 7 now stops at 5 and says so. The measurement says there were none:
 * of the four turns that ever ran that long, three ended in a false claim and one
 * in a shrug. If a real recovery-at-six ever shows up, the fix is to make the
 * failing tool cheaper to get right — not to buy more rounds, which is paying
 * full prefix for another guess.
 */
const MAX_TOOL_ROUNDS = 5
const HISTORY = 16
/** How many past turns to mine for reads. Small: the newest lookups are the live ones. */
const LOOKUP_TURNS = 4

/**
 * The calls the reflection round honours.
 *
 * Named once because two things read the list — the sentence telling the model
 * which of its tools this round can actually run, and the dispatcher that drops
 * every other call before `runTool` sees it. There used to be a third reader, a
 * filter on the declarations themselves, and that one cost real money: the
 * `tools:` comment in §5 has the measurement.
 */
const REFLECT_TOOLS = ['remember', 'schedule'] as const
const isReflectTool = (name: string): name is (typeof REFLECT_TOOLS)[number] =>
  (REFLECT_TOOLS as readonly string[]).includes(name)

function sessionOf(
  identity: Identity,
  turnId?: string,
  /**
   * What put this session's work on the wire (0032). A turn by default; a tap
   * when the payload is being replayed with no model in the room, because those
   * are different acts and "did a person ask for this" should be a query rather
   * than a guess.
   */
  origin: 'turn' | 'tap' = 'turn',
  originRef?: string,
): SessionCtx {
  return {
    role: 'user',
    academyId: identity.academyId,
    personId: identity.person.id,
    contactId: identity.contact.id,
    // Carried into the session so `app.begin_audit` can stamp it on every row this
    // turn writes (0015). Attribution by construction rather than by remembering.
    ...(turnId ? { turnId } : {}),
    origin,
    ...(originRef ? { originRef } : {}),
  }
}

/* ------------------------------------------------------------------------- *
 * runTurn
 * ------------------------------------------------------------------------- */

export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  const turnId = newId()
  const startedMs = Date.now()
  const outcomes: SendOutcome[] = []
  let toolCalls = 0
  let error: string | undefined
  let modelName: string | undefined
  let promptTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  let replyText = ''
  let trace: ToolTrace[] = []
  let rounds = 0
  /** Set when a front-desk turn decided which business this conversation belongs to. */
  let handover: Handover | undefined

  const identity = await resolveIdentity(input.contactId)
  if (!identity) {
    // Nothing to attribute a turn row to — no academy, no person. The router
    // (§10.1) is what answers this case; here it is simply not our turn.
    return { turnId, sent: [], toolCalls: 0, error: 'unresolved_contact' }
  }
  const session = sessionOf(identity, turnId)

  try {
    let text = input.text
    let goToModel = !input.actionId

    if (input.actionId) {
      const consumed = await consumeAction(session, input.actionId, input.contactId)
      if (!consumed.ok) {
        outcomes.push(
          await composeAndSend(session, {
            toContactId: identity.contact.id,
            body: TAP_REFUSAL[consumed.reason],
          }),
        )
      } else if (consumed.payload.kind === 'reply') {
        // The only kind that re-enters the model: it replays as if the user
        // typed it.
        text = consumed.payload.text
        goToModel = true
      } else {
        // A tap makes no model call, so without this the turn row for the most
        // consequential thing a person can do — committing a plan — was blank.
        const tappedAt = Date.now()
        // A tap is not a turn: no model is in the room and the payload executes
        // as stored, which is exactly the distinction `message.origin` exists to
        // record. Same person, same turn id, different act.
        const tapSession = sessionOf(identity, turnId, 'tap', consumed.payload.kind)
        const res = await executeAction(tapSession, identity, consumed.payload, turnId)
        outcomes.push(...res.outcomes)
        replyText = res.summary
        trace.push({
          round: 0,
          name: `tap:${consumed.payload.kind}`,
          ms: Date.now() - tappedAt,
          args: evidence(consumed.payload, 4000),
          result: evidence({ summary: res.summary, sent: res.outcomes.map((o) => o.status) }, 2000),
        })
      }
    }

    /**
     * Media still arrives; the model can no longer read it.
     *
     * The model client is text-only (`deepseek.ts`) — an image or audio part is
     * rejected at schema validation before auth is even checked — so §14.5's
     * "audio arrives as audio" is repealed. What must NOT follow is the failure
     * mode of letting the request fail: voice notes are how half of India types,
     * and going quiet is the one failure a person cannot tell apart from being
     * ignored.
     *
     * So the answer is a runtime send, not an instruction in the prompt. A line
     * in the prefix asking the model to mention the attachment is exactly the
     * kind of behavioural fix that works four times in five; this is the fifth.
     * The person is told, in their own terms, by the runtime, every time — and
     * anything they typed alongside is still answered on its own merits below.
     */
    if (input.media?.length) {
      const said = mediaRefusal(input.media)
      outcomes.push(await composeAndSend(session, { toContactId: identity.contact.id, body: said }))
      // So the turn row and reflection both see what this person was actually
      // told. A turn that answered only about an attachment is not a silent one,
      // and reflection scheduling a follow-up "because nothing was said" is the
      // bug that reads back as the bot talking to itself.
      replyText = said
      trace.push({
        round: 0,
        name: '(media: text-only model, answered in words)',
        ms: 0,
        args: evidence(input.media.map((m) => m.mimeType), 500),
      })
    }

    /**
     * Something arrived carrying nothing anybody can read.
     *
     * A shared contact card, a sticker, a location pin: the ingest path has no
     * text and no media for those, so the turn used to fall through every branch
     * below and end having sent nothing — the exact silence the rest of this
     * function is built to prevent, reached by the one route with no guard on it.
     * It was rare while the brain was telling people to share contact cards; it
     * is rarer now that it does not. It is still a person who tapped send and
     * heard nothing back.
     */
    if (goToModel && !text && !input.task && !input.media?.length) {
      const said = "That came through as something I can't read. Could you type it instead?"
      outcomes.push(await composeAndSend(session, { toContactId: identity.contact.id, body: said }))
      replyText = said
    }

    /**
     * A visitor: somebody at the front desk of this number, who has not said whether
     * they are looking for classes or run them (0039). `resolveInbound` no longer
     * guesses that, so this is the branch where the product asks.
     *
     * It is a *different turn*, not a flag on this one. The tenant path's whole context
     * — `SCHEMA_DOC`, the operation registry, the catalog, the census of a business's
     * classes and money — is about a business this person does not have, and offering it
     * would spend tens of thousands of characters describing an empty tenant to a
     * stranger. `runFrontDeskTurn` runs a second, much smaller stable prefix over five
     * verbs and hands back the same numbers `modelTurn` does, so `writeTurn` below
     * records a front-desk turn exactly as it records a parent's — same table, same
     * report, same drive.
     */
    if (goToModel && text && identity.roles.includes('visitor')) {
      const fd = await runFrontDeskTurn({ session, identity, turnId, text })
      outcomes.push(...fd.outcomes)
      toolCalls = fd.toolCalls
      modelName = fd.model
      promptTokens = fd.promptTokens
      outputTokens = fd.outputTokens
      cachedTokens = fd.cachedTokens
      replyText = [replyText, fd.replyText].filter((s) => s.trim()).join('\n\n')
      trace = [...trace, ...fd.trace]
      rounds = fd.rounds
      if (fd.error) error = fd.error
      handover = fd.handover
    } else if (goToModel && (text || input.task)) {
      const m = await modelTurn(session, identity, turnId, { ...input, text })
      outcomes.push(...m.outcomes)
      toolCalls = m.toolCalls
      modelName = m.model
      promptTokens = m.promptTokens
      outputTokens = m.outputTokens
      cachedTokens = m.cachedTokens
      /**
       * What the person was told, not what the model happened to say last.
       *
       * This was `m.text` — the trailing prose — which is empty on every turn that
       * answers through `reply` or `message`, meaning every turn carrying buttons.
       * Two things read it and both were wrong in the same way: the `turn` row
       * recorded a blank reply, and reflection was told the turn said nothing and
       * scheduled a follow-up to fix the silence it had been told about.
       *
       * `m.said` is the real thing, joined because a turn may legitimately send more
       * than once (a read-back, then the answer) and a reader of either surface wants
       * both. Falls back to `m.text` so nothing regresses on the prose-only path.
       */
      // `replyText` may already hold the attachment line the runtime sent above,
      // and that was said to this person too.
      replyText = [replyText, m.said.length ? m.said.join('\n\n') : m.text]
        .filter((s) => s.trim())
        .join('\n\n')
      trace = [...trace, ...m.trace]
      rounds = m.rounds
      if (m.error) error = m.error
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)

    /**
     * Say something. Anything thrown above lands here, and every fallback that
     * guarantees the person hears back — the tool-less recovery round, the two
     * hard-coded sentences, the trailing send — lives INSIDE `modelTurn`, so a throw
     * skipped all of them. `generate` throws on a non-transient provider failure and
     * after two attempts on a transient one; `stablePrefix()` throws if the doctrine
     * file is missing; `variableTail` awaits the clock and the memory hot set. On
     * any of those the person got NOTHING — no message, no error, no acknowledgement
     * — and the only recovery, `handoffOnRepeatedFailure`, requires the PREVIOUS turn
     * to have failed too. So the first turn of an outage is indistinguishable from
     * being ignored, on a channel where being ignored is what people already fear.
     *
     * Guarded on `outcomes` because a turn can fail AFTER speaking — a tap that
     * committed and then threw on the follow-up should not be answered twice.
     *
     * The send is itself wrapped: if the database or the transport is what broke,
     * this throws too, and a failure to apologise must not replace the error that
     * caused it. Then there is genuinely nothing left to do, and the turn row below
     * is the only record — which is why it is written outside this block.
     */
    if (!outcomes.length) {
      try {
        outcomes.push(
          await composeAndSend(session, {
            toContactId: identity.contact.id,
            body:
              "Something broke on my side just then — it isn't you, and nothing was changed. "
              + "I've flagged it. Try me again in a moment.",
          }),
        )
      } catch {
        // Nothing further is reachable. `error` above is preserved deliberately.
      }
    }
  }

  // §5's pass — "the bot writes facts asynchronously after a turn, never
  // blocking a reply" — used to run here as a second model call. It is the
  // turn's last ROUND now, inside the model loop where the schema, the tools and
  // its own trace are still in context. See the note above the `return` there.

  await writeTurn({
    turnId,
    identity,
    input,
    output: { reply: replyText, sent: outcomes.map((o) => o.status) },
    model: modelName,
    promptTokens,
    outputTokens,
    cachedTokens,
    latencyMs: Date.now() - startedMs,
    error,
    trace,
    rounds,
  })

  if (error) {
    const escalated = await handoffOnRepeatedFailure(session, identity, turnId)
    if (escalated) outcomes.push(...escalated)
  }

  /**
   * The hand-over (0039). A front-desk turn has just decided which business this
   * conversation belongs in, so the same message is answered again — from inside that
   * business, by an ordinary turn with its schema, its tools, its census and its voice.
   *
   * @mechanism handover — performed HERE rather than inside the tool that decided it, and
   *   that inversion is the whole reason `lib/frontdesk/` can exist without a cycle back
   *   into this file. It is the shape `executeAction` already uses for a button whose
   *   payload was a reply: the text "re-enters as if it had been typed". Two turn rows are
   *   written, in two academies, and that is the honest record — the front desk answered a
   *   stranger, and a business answered its first customer, and neither is the other.
   *
   *   It cannot recurse. Both destinations are real tenants by construction —
   *   `businessesOnThisNumber` filters `not is_front_desk`, and `app.found_business`
   *   inserts `is_front_desk = false` — so the re-entered turn never carries the `visitor`
   *   role and never reaches the branch above.
   */
  if (handover) {
    const onward = await runTurn({
      contactId: handover.contactId,
      text: input.text,
      source: input.source,
    })
    return {
      turnId,
      sent: [...outcomes, ...onward.sent],
      toolCalls: toolCalls + onward.toolCalls,
      error: error ?? onward.error,
    }
  }

  return { turnId, sent: outcomes, toolCalls, error }
}

/**
 * What somebody is told when they send something the model cannot read.
 *
 * Three sentences rather than one, because the three attachments are not the
 * same event to the person who sent them. A voice note is somebody who was
 * driving, or whose English is faster spoken than typed — "send it as text" is a
 * real cost to them and the sentence should admit it. A photo of a whiteboard is
 * the timetable, which §7.1 calls the single biggest friction in the product, so
 * that one has to offer the road that still works. A document is usually a
 * forward and the useful half of it is small.
 *
 * Each one names what it cannot do, says it plainly once, and asks for exactly
 * one thing back. None of them apologises twice.
 */
function mediaRefusal(media: { mimeType: string }[]): string {
  const kinds = new Set(media.map((m) => (m.mimeType || '').split('/')[0].toLowerCase()))
  if (kinds.has('audio')) {
    return "I can't listen to voice notes — that's on me, not you. Could you type the short version? "
      + "A line is enough and I'll take it from there."
  }
  if (kinds.has('image')) {
    return "I can't read photos yet, so I've not seen that one. If it's your timetable, type the classes "
      + "in any rough form — \"Mon & Wed 6:30 beginners, Sat 8am juniors\" — and I'll set them up and read them "
      + 'back before anything is created.'
  }
  return "I can't open files yet, so I've not read that. Type the part that matters and I'll work from it."
}

/**
 * Why a tap did not go through, in the recipient's words. Four reasons, four
 * sentences.
 *
 * `missing` and `wrong_contact` shared one line for most of this product's life —
 * *"That button isn't yours to tap"* — so the two cases that are nobody's fault
 * were reported as the one that is. A person whose action row was never written,
 * or whose stored payload no longer parses, was told they had tapped someone
 * else's button: accusatory, wrong, and the most alarming of the four things it
 * could have meant. `wrong_contact` is the only one of the four that is about
 * *them*, and it is the rarest.
 */
const TAP_REFUSAL: Record<'expired' | 'already_used' | 'wrong_contact' | 'missing', string> = {
  expired: "That button has expired — tell me what you'd like and I'll sort it out.",
  already_used: "That one's already done. Anything else?",
  wrong_contact: "That button isn't yours to tap. Tell me what you need instead.",
  missing: "I can't find that button any more — tell me what you need and I'll sort it out.",
}

/**
 * What a person is told when their tap could not be carried out.
 *
 * A tap is the one path with no model in it, so whatever the runtime produces
 * here goes to a phone exactly as written. It was written as
 * `I couldn't do that: ${res.error}` — and an admin who tapped `[Add families]`
 * received a pretty-printed zod error, braces and all, ending in
 * `"message": "Required"`. Correct, and not English: the same class as a uuid or
 * a table name in a sentence, at the worst possible moment.
 *
 * Machine detail belongs in the trace, which already has it. What belongs here
 * is the two things the person needs: it did not happen, and nothing changed.
 */
function humanError(raw: string | undefined): string {
  const first = String(raw ?? '')
    .replace(/^[A-Z_]+: /, '')
    .split('\n')[0]
    .trim()
  const machine = /[{}[\]"]|^\s*$|invalid_type|ZodError|violates|syntax error|undefined/i.test(first)
  return machine || first.length > 140
    ? "That didn't go through — something about it doesn't line up on my side. Nothing was changed. Tell me what you wanted and I'll sort it out."
    : `I couldn't do that: ${first}. Nothing was changed.`
}

/* ------------------------------------------------------------------------- *
 * Button taps — no model call, no re-resolution, no string parsing (§6.5)
 * ------------------------------------------------------------------------- */

async function executeAction(
  session: SessionCtx,
  identity: Identity,
  payload: ActionPayload,
  turnId: string,
): Promise<{ outcomes: SendOutcome[]; summary: string }> {
  const outcomes: SendOutcome[] = []

  /**
   * THE FORM SUBMISSION BRANCH IS GONE, AND SO IS THE FORM (§14.6).
   *
   * A `flow` payload used to arrive here carrying a completed WhatsApp Flow: parse
   * the response against the artifact's schema, then dispatch on flow id to one of
   * three handlers — the business shape, a class, the register. All three wrote
   * through the same named paths a typed sentence reaches (`buildSetupSteps`,
   * `create_class`, `mark_attendance`), which is exactly why removing the form cost
   * no write path: what went was the collection surface, not the work behind it.
   *
   * What replaces it is that the same three things are ASKED. That is more round
   * trips and it is the trade this product chose: a published artifact can only ever
   * return the fields it was published with, so the register form could render any
   * roster and still had no answer for "Aarav left at half time". The ladder does,
   * because the ladder is just the model reading a sentence.
   */

  if (payload.kind === 'noop') {
    outcomes.push(await composeAndSend(session, { toContactId: identity.contact.id, body: payload.ack }))
    return { outcomes, summary: payload.ack }
  }

  if (payload.kind === 'handoff') {
    const out = await runTool(
      'handoff',
      { reason: payload.reason, summary: payload.summary },
      { session, identity, turnId, pendingPlans: new Map(), outcomes },
    )
    const say = (out.result as { say?: string })?.say
    if (say) outcomes.push(await composeAndSend(session, { toContactId: identity.contact.id, body: say }))
    return { outcomes, summary: `handoff: ${payload.reason}` }
  }

  if (payload.kind === 'menu') {
    outcomes.push(...(await sendMenu(session, identity, payload.menu)))
    return { outcomes, summary: `menu:${payload.menu}` }
  }

  if (payload.kind === 'reply') {
    // Intercepted by runTurn above (a `reply` action replays as if the user typed it,
    // so it goes back through the model rather than executing here). This guard exists
    // so the union below is exhaustive and no future caller can fall through it.
    return { outcomes, summary: `reply: ${payload.text}` }
  }

  const steps: PlanStep[] =
    payload.kind === 'operation'
      ? [{ operation: { name: payload.op as OperationName, args: payload.args } }]
      : payload.steps
  const intent = payload.kind === 'operation' ? `button: ${payload.op}` : payload.summary
  // The tap path is where F8 landed: this receipt goes straight to whoever tapped,
  // with no model between the commit and their phone.
  const res = await executePlan(session, steps, intent, audienceFor(identity))
  outcomes.push(...res.outcomes)

  if (!res.ok) {
    // §8.2 — first tap wins. The loser's plan aborted before it could message
    // anyone, so this is where they are told, once, plainly.
    const lost = payload.kind === 'operation' && payload.op === 'claim_cover' && /PRECONDITION_FAILED/.test(res.error ?? '')
    outcomes.push(
      await composeAndSend(session, {
        toContactId: identity.contact.id,
        catalogId: lost ? 'CO-COVER-TAKEN' : null,
        subjectPersonIds: [identity.person.id],
        body: lost
          ? 'Someone else got that session first — nothing needed from you.'
          : humanError(res.error),
      }),
    )
    return { outcomes, summary: res.error ?? 'failed' }
  }

  /**
   * If the plan already spoke to this person, adding an ack on top is noise.
   *
   * What is left of this receipt is the runtime's OWN sentence, written by
   * `buildSummary` from the diff, on the one path with no model in it — so it is
   * a first author rather than a second. The follow-up button and the backstop
   * menu that used to ride under it are gone with the rest of the composer: a tap
   * receipt offering `[What can you do?]` is the same dead end it was everywhere
   * else, and the operation-specific next steps were the runtime guessing at a
   * moment only the model can read.
   *
   * The lint pass is gone from here too. The receipt is built from the plan's own
   * notes and `plural()`'s vocabulary, which is where a table noun leaking into
   * it has to be fixed — a rewrite on the way out was covering for `SINGULARS`
   * and `PLURALS` rather than completing them.
   */
  const alreadyTold = res.stagedMessages.some((m) => m.toContactId === identity.contact.id)
  if (!alreadyTold) {
    outcomes.push(
      await composeAndSend(session, {
        toContactId: identity.contact.id,
        body: res.summary,
      }),
    )
  }
  return { outcomes, summary: res.summary }
}

/* ------------------------------------------------------------------------- *
 * Menus — §7.2's missing nav bar. The items are shaped by what this person
 * actually does (§5), not by a fixed taxonomy.
 * ------------------------------------------------------------------------- */

const ADMIN_MENU: [string, string][] = [
  ['Schedule', "What's on this week?"],
  ['Clients', 'Show me the families'],
  ['Money', "Who hasn't paid?"],
  ['Coaches', 'Show me the coaches'],
  ['Insights', 'How are we doing this month?'],
]
const COACH_MENU: [string, string][] = [
  ['My day', "What have I got today?"],
  ['My week', 'Show me my week'],
  ['Take the register', 'I want to mark the register'],
  ["What I'm owed", 'What am I owed?'],
]
const CLIENT_MENU: [string, string][] = [
  ['The schedule', "When's the next class?"],
  ["Can't make it", 'I need to cancel a class'],
  ['My tally', 'Show me my tally'],
  ['Progress', 'How is my child doing?'],
]

async function sendMenu(session: SessionCtx, identity: Identity, which: string): Promise<SendOutcome[]> {
  let items = identity.roles.includes('admin')
    ? [...ADMIN_MENU]
    : identity.roles.includes('coach')
      ? [...COACH_MENU]
      : [...CLIENT_MENU]

  // An admin who asks about fees every Monday should not see Money fifth.
  try {
    const memory = (await hotSet('person', identity.person.id, identity.academyId)).value ?? ''
    const first = /fee|collect|paid|money|unpaid/i.test(memory)
      ? 'Money'
      : /attendance|register/i.test(memory)
        ? 'Schedule'
        : null
    if (first) items = [...items.filter((i) => i[0] === first), ...items.filter((i) => i[0] !== first)]
  } catch {
    /* memory is an optimisation here, never a dependency */
  }

  return [
    await composeAndSend(session, {
      toContactId: identity.contact.id,
      body: 'What would you like?',
      list: {
        buttonText: 'Choose',
        sections: [
          {
            title: which === 'root' ? 'Anything else works too — just type it' : which,
            rows: items.slice(0, LIMITS.listRows).map(([title, text]) => ({
              title: title.slice(0, LIMITS.listRowTitleChars),
              action: { kind: 'reply', text } as ActionPayload,
            })),
          },
        ],
      },
    }),
  ]
}

/* ------------------------------------------------------------------------- *
 * The model rounds
 * ------------------------------------------------------------------------- */

/**
 * One line of the turn's flight recorder. `args` carries the SQL verbatim
 * because "what did it actually read" is the question a wrong answer raises,
 * and reconstructing it from the reply is guesswork.
 *
 * @mechanism ToolTrace — the flight recorder carries the model's OWN rounds beside the tool
 *   calls, under the `(model)` and `(context)` markers that `isToolCall` keeps out of tool
 *   counts: what it wrote, what it deliberated (`reasoning`, a field of its own, capped at
 *   24k rather than folded into `args` and cut at 2k), what it spent and why it stopped —
 *   per round, in order. `evidence` caps these rows in production and clips nothing while an
 *   instrument holds a capture open, so a run can also be asked what the model was GIVEN.
 *   Without it a turn reads back as a list of tool calls with the reasoning removed, and a
 *   turn that cost 128k tokens over six rounds cannot be asked which round was expensive.
 */
export type ToolTrace = {
  round: number
  name: string
  ms: number
  args?: unknown
  result?: unknown
  error?: string
  /**
   * What the model was thinking on this round, on `(model)` rows.
   *
   * A FIELD OF ITS OWN, and both halves of that matter.
   *
   * *Its own*, rather than inside `args`: `args` on a `(model)` row is the prose
   * the model wrote, and every consumer reads it as a bare string
   * (`spokenOn` in the report scripts is `typeof parse(args) === 'string'`).
   * Folding the reasoning in there would have been a shape change rippling
   * through five readers, and the one that forgot would go quiet rather than
   * fail.
   *
   * *Recorded at all* is the fix. Until 17 Aug 2026 the reasoning was carried
   * only on rounds that produced NO prose — the `returnedNothing` diagnostic —
   * and then only as part of an assistant blob capped at 2,000 characters. Three
   * consequences, all of them silent: a round that both thought and spoke stored
   * no thinking whatsoever; a long deliberation was cut mid-sentence; and when
   * the blob went over the cap `traceValue` returned a truncated JSON *string*
   * instead of the object, so every downstream reader — including the probe that
   * exists to render it — parsed nothing and showed nothing. Measured on a live
   * drive: 35 `(model)` rows, reasoning visible to the probe on 10 of them, and
   * the ones lost were the LONG ones. The instrument was blindest exactly where
   * the turns were hardest, which is the one place it had to see.
   */
  reasoning?: unknown
}

/**
 * The name every non-tool entry in the trace carries.
 *
 * The flight recorder held tool calls and nothing else, so the model's own
 * output — the words it wrote on each round, what it spent, why it stopped —
 * was reconstructable only for the one case that recorded it (a round that
 * produced nothing at all). Everything else was summed into the turn row and
 * the per-round detail was gone: a turn that cost 128k tokens over six rounds
 * could not be asked WHICH round was expensive.
 *
 * Marker entries share the trace rather than getting a column of their own
 * because they are the same evidence about the same turn, in order. The cost of
 * that is every consumer counting `tool_calls` as "tools reached for" — so the
 * prefix is a single constant, and `isToolCall` below is the one predicate that
 * separates them.
 */
export const TRACE_MARKER = '(model)'

/**
 * The marker for the one entry that is an INPUT rather than an outcome.
 *
 * Shares the trace for the same reason `(model)` does — same evidence, same
 * turn, one order — and is filtered out of tool counts by the same predicate.
 * Written only while an instrument holds a capture open; see the push site.
 */
export const CONTEXT_MARKER = '(context)'

/** A real tool call, as opposed to a per-round marker. Consumers that count
 *  tools, or group by tool name, must filter with this or the model's own
 *  rounds show up as a tool nobody declared. */
export function isToolCall(t: { name?: unknown }): boolean {
  return typeof t?.name === 'string' && !t.name.startsWith('(')
}

/**
 * The stable part of a failure: the message with every id, quoted literal and
 * number taken out, so "refused for table class_slot" matches itself across
 * three attempts that differed only in what they inserted.
 */
function reasonKey(err: unknown): string {
  return String(err ?? '')
    .split('\n')[0]
    .replace(/'[^']*'/g, "'…'")
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '…')
    .replace(/\d+/g, '#')
    .slice(0, 200)
}

/**
 * How much of one round's reasoning the flight recorder keeps.
 *
 * Sized from measurement: the longest single reasoning seen on a driven month
 * was ~9,000 characters, and the old effective cap was 2,000 — so the cases that
 * most needed explaining were the ones cut. This binds on nothing observed and
 * still refuses to store a pathological turn without limit.
 */
const REASONING_TRACE_CAP = 24_000

/** Long strings are evidence, not payload — keep the shape, cap the size. */
function traceValue(v: unknown, limit: number): unknown {
  if (v === null || v === undefined) return v ?? null
  if (typeof v === 'string') return v.length > limit ? `${v.slice(0, limit)}… (+${v.length - limit} chars)` : v
  if (typeof v !== 'object') return v
  try {
    const s = JSON.stringify(v)
    if (s.length <= limit) return v
    return `${s.slice(0, limit)}… (+${s.length - limit} chars)`
  } catch {
    return String(v)
  }
}

/**
 * A value on its way INTO the flight recorder, as opposed to one on its way back
 * to the model.
 *
 * The distinction is the whole point of the wrapper. Production keeps the cap it
 * always kept — these rows are stored on every turn forever. While an instrument
 * holds a capture open (`lib/agent/turn-trace.ts`) nothing is clipped, because a
 * harness asking "what did it actually send" cannot be answered with the first
 * four thousand characters of the answer.
 *
 * Every recorder site below goes through this. The one site that must NOT is the
 * history builder near the bottom of the file, which uses `traceValue` directly:
 * what the model is shown has to be identical whether or not anybody is watching.
 */
function evidence(v: unknown, limit: number): unknown {
  return traceValue(v, fullTraceOn() ? Number.POSITIVE_INFINITY : limit)
}

async function modelTurn(
  session: SessionCtx,
  identity: Identity,
  turnId: string,
  input: TurnInput,
): Promise<{
  outcomes: SendOutcome[]
  toolCalls: number
  text: string
  /**
   * Everything this turn actually put in front of the person, in order.
   *
   * Distinct from `text`, which is only the model's trailing prose. A turn that
   * answers through `reply` has plenty of `said` and no `text` at all.
   */
  said: string[]
  model?: string
  promptTokens: number
  outputTokens: number
  cachedTokens: number
  trace: ToolTrace[]
  rounds: number
  error?: string
}> {
  const outcomes: SendOutcome[] = []
  const toolCtx: ToolCtx = {
    session,
    identity,
    turnId,
    pendingPlans: new Map<string, PlanStep[]>(),
    pendingMeta: new Map<string, { intent: string; summary: string; totalRows: number; needsConfirm: boolean }>(),
    outcomes,
    executed: [],
    repliedTo: new Set<string>(),
    confirmationAskedTo: new Set<string>(),
    saidToUser: [],
    // The R10 evidence set and its shadow findings. Both are recorded and
    // neither steers anything — see `./traceability`.
    evidence: [],
    untraced: [],
  }

  // The tenant's clock, not the world's. This line is the model's entire sense of
  // "now" — driven with a moved tenant clock, the bare call told a coach "It is
  // Saturday, 10:52am" on his Wednesday, and every watch the turn scheduled
  // landed in the past (findings-archive.md F-A). Awaited first now, because
  // every replayed lookup is stamped against it: an unstamped past is read as the
  // present, and the model will argue itself out of a correct doubt with it.
  const at = await now(identity.academyId)
  const clock = inZone(at, identity.academy.timezone)
  // One read, two filters. `Promise.all` around two functions that each fetched
  // the same rows is what made the identical statement go out twice a turn.
  const turns = await recentToolTurns(identity)
  const lookups = turns.value ? recentLookups(turns.value, at) : undefined
  const actions = turns.value ? await recentActions(turns.value, identity) : undefined
  const tail = await variableTail(identity, {
    clockNote: `It is ${clock.label} (${clock.date} ${clock.time}) in ${identity.academy.timezone}.`,
    taskInstruction: input.task?.instruction,
    queryResults: input.task?.queryResults,
    recentLookups: lookups,
    recentActions: actions,
  })

  const situation: string[] = [tail]
  if (input.source === 'job' && input.task) {
    situation.push(
      'This is a task you scheduled for yourself. Deciding to do nothing is the common and correct outcome — ' +
        'only send something if this person would have asked for it. If you DO decide to speak, `reply` is the ' +
        'only path that reaches anyone on a job turn: prose you write here is discarded, not delivered. A report ' +
        'you promised and then wrote as prose is a promise broken silently.',
    )
  }

  // The same treatment as the history note below, for the same reason: both
  // callers used to answer a refused read with `undefined`, and `variableTail`
  // renders an absent block as nothing at all.
  if (turns.why) {
    situation.push(
      `# What you looked up and did earlier could not be read\n\n` +
        `The lookup failed (${turns.why}). This is NOT a conversation in which you have done nothing — you may ` +
        `have read rows and made changes whose ids and outcomes you can no longer see. Re-read anything you ` +
        `need before you use it, never write an id from memory, and do not describe as undone anything you ` +
        `cannot see the result of.`,
    )
  }
  const history = await recentHistory(session, identity)
  // The reason belongs in the tail rather than in the message list: a runtime
  // sentence dropped into the conversation would arrive as something a person
  // said. Pushed after `situation` is built and before it is joined below.
  if (history.why) {
    situation.push(
      `# The earlier messages in this conversation could not be read\n\n` +
        `This is NOT a first contact and the thread above is NOT empty — the lookup failed (${history.why}). ` +
        `Do not greet them as a stranger, do not re-ask what they may already have answered, and do not ` +
        `re-offer what they may already have declined. If what you need turns on something said earlier, say ` +
        `you have lost the thread and ask, rather than starting over.`,
    )
  }
  // Beside the messages, never among them — see `historyGaps`.
  if (history.gaps) situation.push(history.gaps)
  // Text only, and the attachment has already been answered by the runtime
  // (`mediaRefusal`) before this call is made. There is no media part on this
  // wire to carry it with: the request schema rejects one outright.
  const messages: Msg[] = [
    ...history.messages,
    { role: 'user', content: `${situation.join('\n\n')}\n\n---\n\n${input.text ?? ''}`.trim() },
  ]

  const system = stablePrefix()
  let toolCalls = 0
  let text = ''
  let model: string | undefined
  let promptTokens = 0
  let outputTokens = 0
  // §4.4 — a subset of promptTokens, not an addition to it. Summed over the tool
  // rounds below, because it is the *ratio* over the whole turn that says whether the
  // stable prefix is still earning its keep.
  let cachedTokens = 0
  /**
   * Whether anything actually reached THIS person's phone.
   *
   * @mechanism spoke — the turn's test for "was this person answered" is what arrived at the
   *   ASKER's contact, not what left the building: a proposal routed to the owner is a turn
   *   that sent something and told the person who asked nothing. When it is false and nothing
   *   was drafted either, the turn spends one toolless recovery round putting what it already
   *   learned into words, and apologises only if that fails too — one of three sentences, and
   *   a census of this turn's `message` rows suppresses even that if the runtime already said
   *   something true, because a second message reads as the first being withdrawn. Going
   *   quiet is the one failure a person cannot tell apart from being ignored.
   *
   * This used to be "did the model call `reply`", set before the call was even
   * run — so a `reply` the runtime *refused* still counted as having spoken, and
   * every guard below stood down. Watched live: one bad button took the message
   * with it, and the turn ended having sent nothing at all. Going quiet is the
   * one failure a person cannot tell apart from being ignored, and it was being
   * caused by the check that exists to prevent it.
   *
   * Scoped to the asker, not to the wire: a turn that spends its rounds routing
   * a proposal to the ADMIN has genuinely sent something — and the person who
   * asked has still heard nothing. Driven the day the routed-proposal path
   * landed: Sunita's credit request reached the owner, `spoke()` counted the
   * owner's message, every ladder below stood down, and Sunita got silence. An
   * outcome with no recipient on it (older shapes) counts as hers, which is the
   * conservative reading — it can only make the ladder quieter, never louder.
   *
   * The honest question is not what the model tried, nor what left the building.
   * It is what arrived where the question came from.
   */
  const spoke = (): boolean =>
    outcomes.some(
      (o) =>
        (o.status === 'sent' || o.status === 'queued') &&
        (!('toContactId' in o) || !o.toContactId || o.toContactId === identity.contact.id),
    )
  const trace: ToolTrace[] = []

  /**
   * WHAT THE MODEL WAS TOLD, recorded beside what it did — instrument only.
   *
   * The flight recorder held everything a turn DID and nothing it was GIVEN. So a
   * turn could be read back completely — every round, its reasoning, its SQL, its
   * replies — while the one input that decided all of it was unrecoverable.
   *
   * That gap has a price on the record. Three turns of the first live week were
   * handed `their coach record could not be read this turn`, with the cause
   * withheld, after the prefetch hit `EMAXCONNSESSION`. The model reached for the
   * only cause its prompt offered and told a coach his own pay was not visible.
   * Five judges read those turns with what they called complete visibility. None
   * could see the sentence, because the sentence was never written down — it took
   * a seventh day and a hand audit of the SQL trace to find it.
   *
   * Worse, the failures this exists to expose are mostly ABSENCES: a prefetch that
   * dies takes its whole paragraph out of the tail, and no amount of reading the
   * rounds shows a paragraph that was never there. Only the tail itself does.
   *
   * The TAIL in full and the prefix by fingerprint. Not a compromise on "record
   * everything, untruncated": the stable prefix is byte-identical across every
   * turn of a run by construction — that property IS the cache — so storing it
   * per turn would store one document eighty times and bury the variable half.
   * Its length and head are enough to prove which prefix was in play, and the
   * prefix itself is in the tree at the commit the run names.
   *
   * Instrument only, gated on `fullTraceOn()`. In production this allocates
   * nothing and stores nothing: the tail carries names, phone-shaped ids and a
   * person's memory, and `turn.tool_calls` is kept forever.
   */
  if (fullTraceOn()) {
    const tail = situation.join('\n\n')
    trace.push({
      round: 0,
      name: CONTEXT_MARKER,
      ms: 0,
      args: {
        prefix: { chars: system.length, head: system.slice(0, 120) },
        tail,
        said: input.text ?? null,
        history: messages.length - 1,
      },
    })
  }

  let rounds = 0
  let forcedError: string | undefined
  /** Calls that failed once already this turn, by name+args. */
  const failedCalls = new Map<string, number>()
  /**
   * The same *refusal*, however the call was spelled. Byte-identical repeats are
   * the easy case; the expensive one is a model editing something irrelevant
   * between attempts — `active`, then `rate_unit` — while the database refuses
   * for the same reason every time. Three of those cost 81 seconds and 119k
   * tokens and ended in an apology that invented a cause. A refusal repeating is
   * the signal, not the arguments repeating.
   *
   * @mechanism failedReasons — refusals are counted by tool name plus the reason with ids,
   *   quoted literals and numbers stripped out, so three attempts that differed only in
   *   which irrelevant argument was edited read as one refusal repeating: the second says
   *   so in the result the model reads, the third stalls the turn out of the loop and into
   *   the recovery round. With `failedCalls` beside it, which blocks a byte-identical
   *   repeat before `runTool` sees it, this is what stops a stuck turn spending every
   *   remaining round — 93 seconds and 165k tokens, measured — on a call the world will
   *   not let succeed, and ending in an apology that invents a cause.
   */
  const failedReasons = new Map<string, number>()
  let stalled = false

  /**
   * Every interactive turn thinks at `low` — the shipped configuration, settled
   * by the phase-6 arc rather than chosen. Thinking-off's failure mode is the
   * disqualifying one: fluent, present-tense false claims of state (a coach
   * "hired" with zero tool calls, a fabricated session with named children).
   * Low grounds referents before speaking and acts instead of narrating, at a
   * p50 around 17s. There is no per-turn tier to pick any more; `deepseek.ts`
   * defaults the tool path to `low`, and it is passed explicitly here so the
   * turn's most consequential setting is visible where the turn runs.
   */
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds = round + 1
    const res = await generate({
      system,
      messages,
      tools: toolDecls(),
      model: env.MODEL_MAIN,
      temperature: 0.4,
      thinking: 'low',
    })
    model = res.model
    promptTokens += res.usage.promptTokens
    outputTokens += res.usage.outputTokens
    cachedTokens += res.usage.cachedTokens
    /**
     * Prose beside tool calls is the model's notebook — the `reply` declaration
     * has said so all along, and this assignment used to make that false on one
     * round in five: `text` was overwritten every round, so whatever the FINAL
     * round drafted beside its calls became the reply whenever nothing else had
     * reached the person. Both notes-to-self that shipped in the adversarial
     * drive left through exactly this line — "Let me retry the plan", as the
     * answer to "delete everything" (F-AC/F-AI). Only a round that calls nothing
     * is speaking to the person; a working round's prose stays in the trace, and
     * a turn that ends mid-work now lands in the recovery ladder below, which
     * exists for precisely that state.
     */
    const prose = res.text ?? ''
    if (!res.functionCalls.length) text = prose

    // Every round leaves a record, not just the ones that went wrong. What the
    // model wrote, what it reached for, what it stopped for and what it spent —
    // recorded in the same order as the tool calls it sits above, so reading a
    // turn back reads as the turn happened rather than as a list of tool calls
    // with the reasoning removed.
    //
    // The raw assistant message is carried only when there is no text to carry,
    // because that is the case it diagnoses: a turn that returned nothing has
    // its reasoning and its half-formed tool calls in there, and that is the
    // only clue to WHAT it was reaching for.
    trace.push({
      round: round + 1,
      name: TRACE_MARKER,
      ms: res.ms,
      args: prose.trim()
        ? evidence(prose, 4000)
        : { returnedNothing: true, message: evidence(res.assistant, 2000) },
      // Every round that deliberated, not only the ones that came back empty.
      // See `ToolTrace.reasoning` for what this replaces and why it is a
      // separate field. The cap is generous rather than absent: the longest
      // reasoning measured on a live drive was ~9k characters, and a cap that
      // never binds in practice still bounds a pathological turn — and when it
      // does bind, `traceValue` says so in the value rather than ending
      // mid-token and looking complete.
      ...(typeof res.assistant.reasoning_content === 'string' && res.assistant.reasoning_content.trim()
        ? { reasoning: evidence(res.assistant.reasoning_content, REASONING_TRACE_CAP) }
        : {}),
      result: {
        in: res.usage.promptTokens,
        cached: res.usage.cachedTokens,
        out: res.usage.outputTokens,
        calls: res.functionCalls.map((f) => f.name),
        finish: res.finishReason ?? 'unknown',
      },
      error:
        !res.functionCalls.length && !prose.trim()
          ? `finishReason: ${res.finishReason ?? 'unknown'} · ${res.usage.outputTokens} output tokens`
          : undefined,
    })

    if (!res.functionCalls.length) break

    // Echo the assistant message back verbatim — `reasoning_content` included,
    // as the API's history contract asks.
    messages.push(res.assistant)

    // One `{role:'tool'}` message per call, carrying the id of the call it
    // answers. Matching is BY ID here, not by position.
    const responses: Msg[] = []
    for (const call of res.functionCalls) {
      toolCalls++

      /**
       * The arguments did not parse.
       *
       * This is what used to arrive as `MALFORMED_FUNCTION_CALL` — an empty
       * candidate with nothing attached and no way to tell which tool was
       * meant. Here the raw string is right there, so the turn records what was
       * attempted AND the model gets told what was wrong with it, which is a
       * round it can actually recover in. The call is never executed: `args` is
       * empty and running a write with empty arguments is how a parse failure
       * becomes a database row.
       */
      if (call.parseError) {
        trace.push({
          round: round + 1,
          name: call.name,
          ms: 0,
          args: { malformed: true, raw: evidence(call.raw ?? '', 2000) },
          error: `MALFORMED_FUNCTION_CALL: ${call.parseError}`,
        })
        responses.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify({
            error: `the arguments you sent for ${call.name} were not valid JSON (${call.parseError})`,
            hint: 'Send the call again with well-formed JSON arguments, or answer them in words instead.',
          }),
        })
        continue
      }
      let out: { result: unknown; note?: string }
      const calledAt = Date.now()
      let threw: string | undefined

      // A call that already failed, repeated byte for byte, will fail byte for byte
      // again — the world did not move between two rounds of the same turn. Left
      // alone this burns every remaining round: eight identical calls, 93 seconds and
      // 165k tokens for one mis-typed tool name, ending in an apology. The loop is
      // the only place that can see the repetition, so it is the place that stops it.
      const signature = `${call.name}:${JSON.stringify(call.args ?? {})}`
      const priorFailures = failedCalls.get(signature) ?? 0
      if (priorFailures > 0) {
        out = {
          result: {
            error: 'you already made this exact call in this turn and it failed with the same arguments',
            repeatedCall: call.name,
            hint:
              priorFailures === 1
                ? 'Nothing has changed since, so it will keep failing. Read the earlier error, change the call, or stop and tell them what you need.'
                : 'Stop retrying. Say plainly what you were trying to do and what is in the way.',
          },
        }
        failedCalls.set(signature, priorFailures + 1)
        trace.push({
          round: round + 1,
          name: call.name,
          ms: 0,
          args: evidence(call.args, 500),
          error: `blocked: identical call already failed ${priorFailures}x this turn`,
        })
        responses.push({ role: 'tool', tool_call_id: call.id, content: toolContent(out.result) })
        if (priorFailures >= 2) {
          stalled = true
          break
        }
        continue
      }

      try {
        out = await runTool(call.name, call.args, toolCtx)
      } catch (e) {
        threw = e instanceof Error ? (e.stack ?? e.message) : String(e)
        out = { result: { error: e instanceof Error ? e.message : String(e) } }
      }
      const failed =
        Boolean(threw) ||
        (out.result !== null && typeof out.result === 'object' && 'error' in (out.result as object))
      if (failed) {
        failedCalls.set(signature, 1)

        // Same tool, same reason, second time round: the world is not moving, and
        // the next attempt will not move it either. Say so in the result the model
        // reads, so it spends its remaining rounds on a different approach or on
        // telling the person plainly — the two outcomes that are still available.
        const reason = `${call.name}:${reasonKey(threw ?? (out.result as any)?.error)}`
        const seen = (failedReasons.get(reason) ?? 0) + 1
        failedReasons.set(reason, seen)
        if (seen >= 2 && out.result && typeof out.result === 'object') {
          ;(out.result as any).repeatedFailure =
            `${call.name} has now been refused ${seen} times this turn for the same reason. Editing the arguments is not ` +
            `what is wrong. Either take a different route — a named operation instead of raw SQL, or reading first to find ` +
            `what is missing — or stop and tell them in one sentence what you could not do and what you need.`
          if (seen >= 3) stalled = true
        }
      }
      trace.push({
        round: round + 1,
        name: call.name,
        ms: Date.now() - calledAt,
        args: evidence(call.args, 4000),
        result: evidence(out.result, 4000),
        // `error` marks a call that did not happen, and refusals in this product
        // RETURN rather than throw — the commit gate, RLS denials, every tool's
        // `{error}` result. The fuller notion is computed as `failed` above; the
        // trace used to carry only `threw`, so all 21 of the month drive's 21
        // refused calls reached reflection looking like things that happened
        // (F-P). The thrown text wins when both exist: a stack names the site.
        ...(threw
          ? { error: threw.slice(0, 2000) }
          : failed
            ? { error: String((out.result as any)?.error ?? 'refused').slice(0, 300) }
            : {}),
      })
      const content = toolContent(out.result)
      // The evidence half of R10, collected at the one place a tool result is
      // recorded — so a number in a message either appears in something a tool
      // actually returned this turn, or the turn did not read it.
      toolCtx.evidence?.push(content)
      responses.push({ role: 'tool', tool_call_id: call.id, content })
    }
    messages.push(...responses)

    // Out of the loop, not out of the turn: the recovery round below still gets to
    // put what was learned into words, which beats an apology that explains nothing.
    if (stalled) break

    /**
     * The turn is over when the person has been answered and nothing is left half-done.
     *
     * Every round pays the whole stable prefix again — that is what §4.4 means by
     * "rounds are the driver" — and measured on a live turn, the round *after* a
     * successful reply produced `finishReason: STOP · 0 output tokens` and cost 16k
     * prompt tokens to produce nothing. It is not an occasional waste; it was every
     * turn, because nothing told the loop the work was finished. The model has no
     * reason to say so and the `reply` tool already refuses a second message to the
     * same person, so the round exists only to discover that there is nothing to do.
     *
     * The runtime knows. `repliedTo` is set only when a message actually reached this
     * person, and `pendingPlans` is empty only when nothing is waiting to be committed —
     * that second condition is the one that matters: plan → reply → commit is a real
     * shape, and cutting it after the reply would be the "describes it and does not do
     * it" failure introduced by the fix meant to save money.
     */
    if (toolCtx.repliedTo?.has(identity.contact.id) && toolCtx.pendingPlans.size === 0) break

    /**
     * F-AI — the budget is declared on `read`; the position only the loop knows,
     * so the loop says it, in the same bracketed runtime voice flattenToolTurns
     * uses. Only when another round is actually coming — after the last there is
     * nobody left to tell. The second-to-last round carries the full warning
     * because it is the last moment a change of course can still act: "your
     * final round" in the reply declaration used to name a moment the model
     * could not identify while in it, and this is what makes it identifiable.
     */
    /**
     * And what the turn has actually DONE, beside where it is.
     *
     * This is what replaces six claim regexes and a substitution. The runtime is
     * the only thing that knows whether anything happened, and for the whole life
     * of those patterns it knew and did not say — it waited until the model had
     * written a sentence and then argued with the sentence. F-AM is the shape of
     * that: one round, zero tool calls, *"I've flagged it to the owner"* about a
     * child's injury, no message behind it. Zero writes is trivially catchable,
     * and the catch that works is telling the author before it writes rather than
     * detecting a verb afterwards.
     *
     * A statement, never advice: counts of what happened, and nothing about what
     * to say. Every round, because the answer changes with every round.
     */
    if (round < MAX_TOOL_ROUNDS - 1) {
      const used = round + 1
      const where =
        used === MAX_TOOL_ROUNDS - 1
          ? `${used} of ${MAX_TOOL_ROUNDS} tool rounds used — the next is your LAST. If the work will not finish in it, spend it on reply: say plainly what ran, what did not, and what you need. Prose beside tool calls reaches nobody.`
          : `${used} of ${MAX_TOOL_ROUNDS} tool rounds used`
      messages.push({ role: 'user', content: `[${where}. ${turnState(toolCtx)}]` })
    }
  }

  /**
   * Nothing said, nothing sent. What follows is the one ladder for that, and its
   * ORDER is the whole of it.
   *
   * There were two mechanisms here and they were competing. The last round used
   * to fill `text` with *"I'm going round in circles on this one"* before the
   * loop exited — which meant the recovery round below, guarded on `!text`, was
   * skipped in exactly the case with the most to salvage: five rounds of tool
   * results sitting in `contents` and nobody to put them into words. The
   * recovery only ever fired when the model returned nothing EARLY, and the
   * cheaper, worse answer won every expensive turn.
   *
   * So the apology moved after it. Try to answer first; apologise only if that
   * fails too. Same two mechanisms, opposite order, and the apologies collapse
   * from three near-identical sentences to one ladder that picks between them.
   */
  const silent = (): boolean => !text.trim() && !spoke()

  /**
   * Has anything at all reached this person this turn, and was a refusal raised
   * on their behalf.
   *
   * `outcomes` and `repliedTo` only see what the TOOLS sent, and the runtime
   * itself sends too: a plan refused by RLS tells the person "that's not
   * something I can change from here, I've passed it to whoever runs <academy>"
   * from inside `plan.ts`, where neither of those is in scope.
   *
   * Driven: a mother asked to stop her son's Saturday lessons, the runtime
   * answered her honestly and escalated to the owner, the model then failed to
   * compose anything the honesty guard would accept, and she received a SECOND
   * message about a request that was perfectly clear and had already been
   * actioned. An apology after an answer reads as the answer being withdrawn.
   *
   * `message.turn_id` is stamped on every outbound (0015/0019), so this is one
   * query, asked once. It gates the recovery round as well as the apology —
   * which the in-loop version could not, being upstream of it, and that gap is
   * how a runtime answer could still be followed by a composed second message.
   */
  const heard = silent()
    ? await withSession(
        { role: 'service', academyId: identity.academyId },
        async (tx) =>
          (await tx.unsafe(
            `select
               (select count(*) from message
                 where turn_id = '${turnId}' and contact_id = '${identity.contact.id}'
                   and direction = 'outbound' and suppressed_reason is null)::int as told,
               (select count(*) from message
                 where turn_id = '${turnId}' and catalog_id = 'AD-NEEDS-YOU')::int as raised`,
          )) as unknown as { told: number; raised: number }[],
      ).catch(() => [] as { told: number; raised: number }[])
    : []
  const told = Number(heard[0]?.told ?? 0)
  const raised = Number(heard[0]?.raised ?? 0)

  // Going quiet is the one failure a person cannot tell apart from being ignored.
  // A model that returns an empty candidate — out of output budget, done
  // thinking, or simply having emitted nothing — leaves someone staring at a chat
  // that never answered. So if nothing was said and nothing was sent, ask once
  // more with the tool surface removed: everything the turn learned is already
  // sitting in `contents`, so this round only has to put it into words.
  //
  // This used to require `toolCalls > 0`, on the theory that there was nothing to
  // recover otherwise. There is: watched live, an admin sent their timetable as a
  // file and the very first round came back with 1,653 tokens spent and an empty
  // text part — no tools, nothing to salvage by that rule, so the turn skipped
  // straight to "something broke on my side" without ever asking again. One more
  // round is cheaper than an apology, and it is the difference between a product
  // that stumbles and one that ignores you.
  if (silent() && told === 0 && input.source !== 'job') {
    try {
      const forced = await generate({
        system,
        messages: [
          ...flattenToolTurns(messages),
          {
            role: 'user',
            content:
              'Answer them now, in plain words, using only what those results actually say. ' +
              'No tools left to call. If the results do not answer it, say so plainly.\n\n' +
              'You have no tools in this round, so nothing you describe can happen. Do not say what ' +
              'you are about to do, are going to do, or will now set up — this is the last thing sent, ' +
              'and a promise here is a promise nothing keeps. And anything you say you have done must ' +
              'already be in the results above — this round can describe, it cannot do. State what you ' +
              'found, or say plainly that you have not done it yet and ask for the one thing you need to.\n\n' +
              // The recovery round is the one that runs when the turn has already
              // gone wrong, which makes it the round most likely to reach for a
              // sentence about work that did not happen. It gets the same fact
              // every other round gets.
              turnState(toolCtx),
          },
        ],
        model: env.MODEL_MAIN,
        temperature: 0.4,
      })
      promptTokens += forced.usage.promptTokens
      outputTokens += forced.usage.outputTokens
      cachedTokens += forced.usage.cachedTokens
      text = forced.text ?? ''
      // The recovery call is a whole extra prefix and it was invisible in the
      // trace, so a turn that spent one looked identical to a turn that did not
      // and the tokens appeared in the total with nothing to attribute them to.
      trace.push({
        round: rounds + 1,
        name: TRACE_MARKER,
        ms: forced.ms,
        args: text.trim() ? evidence(text, 4000) : { returnedNothing: true, recovery: true },
        // The recovery round deliberates too, and it is the round that runs when
        // the turn has already gone wrong — the last place to be missing a why.
        ...(typeof forced.assistant?.reasoning_content === 'string' && forced.assistant.reasoning_content.trim()
          ? { reasoning: evidence(forced.assistant.reasoning_content, REASONING_TRACE_CAP) }
          : {}),
        result: {
          in: forced.usage.promptTokens,
          cached: forced.usage.cachedTokens,
          out: forced.usage.outputTokens,
          calls: [],
          finish: forced.finishReason ?? 'unknown',
          recovery: true,
        },
      })
      if (!text.trim()) {
        forcedError = `the recovery call returned an empty candidate (finish: ${forced.finishReason ?? 'unknown'})`
      }
    } catch (e) {
      // Swallowing this was how a dead turn became "ask me again": the reason the
      // model produced nothing never reached the turn row, so every one of these
      // looked like a transient glitch worth retrying. It is recorded now.
      forcedError = e instanceof Error ? (e.stack ?? e.message) : String(e)
    }
    trace.push({
      round: rounds + 1,
      name: '(recovery: answer without tools)',
      ms: 0,
      ...(forcedError ? { error: forcedError.slice(0, 2000) } : { result: 'produced an answer' }),
    })
  }

  /**
   * The recovery round could not answer either. Now, and only now, say so.
   *
   * Three failures, three sentences, and picking the wrong one is its own defect:
   * "try again" is only honest when trying again could work, a turn that burned
   * every round needs to say that, and a request that was in fact actioned by an
   * escalation must not be answered with an apology for going in circles.
   *
   * `told > 0` is the fourth case and gets nothing at all: somebody has already
   * been told something true this turn, and a second message would read as the
   * first being withdrawn.
   */
  if (silent() && told === 0 && input.source !== 'job') {
    text = raised > 0
      ? "That's not something I can change from here. I've passed it to whoever runs the academy "
        + "and they'll come back to you."
      : rounds >= MAX_TOOL_ROUNDS
        ? "I went round in circles on that one and didn't get to an answer. Can you tell me the short version of what you need?"
        : // "I've flagged it" used to end this sentence, and nothing here flags
          // anything — the runtime's own fixed copy making exactly the unbacked
          // claim the whole F-K campaign is against. Say what is true instead.
          "Something broke on my side working that out — it isn't you, and repeating it won't help. Try me again in a moment."
  }

  /**
   * A job turn that wants to speak has the tools. On the interactive path a person is
   * staring at the chat, so trailing prose is a safety net; on `source: 'job'` there is
   * no one waiting, silence is the expected outcome (§13.1), and this same net delivered
   * the model's deliberation — "I will stay quiet until Wednesday", watch bookkeeping,
   * "no follow-up is needed" — as real messages (findings-archive.md F-B). Discarded,
   * with a trace entry so a drive can still see what the model was thinking.
   */
  if (text.trim() && !spoke() && input.source === 'job') {
    trace.push({ round: rounds, name: '(job turn: trailing prose discarded, tools are how a job speaks)', ms: 0, args: evidence(text, 2000) })
    text = ''
  }

  /**
   * An operation this turn already put a confirmation question on this person's
   * screen (`client_cancel`, `opt_out`… — see ToolCtx.confirmationAskedTo). One
   * tap answers it; trailing prose after it is at best noise and at worst a
   * second confirmation the `reply` gate just refused, re-entering as text.
   * Same shape as the job-turn discard above: dropped, traced, visible to a
   * drive.
   */
  if (text.trim() && !spoke() && toolCtx.confirmationAskedTo?.has(identity.contact.id)) {
    trace.push({
      round: rounds,
      name: '(trailing prose discarded: a confirmation from this turn is already on their screen)',
      ms: 0,
      args: evidence(text, 2000),
    })
    text = ''
  }

  if (text.trim() && !spoke()) {
    /**
     * **The trailing path used to be where every runtime edit landed hardest**,
     * because it is the one path with no round of grace: bracket labels harvested
     * out of the prose, a backstop menu or a `[Yes]/[No]` pair bolted on, a
     * follow-up appended, the model's own sentence substituted for the runtime's
     * read-back when a claims regex fired, and a lint pass rewriting five ways on
     * the way out. Every one of them widened the gap between the message the model
     * wrote and the message the person read, on the path where the model has the
     * least ability to notice.
     *
     * Two things are left, and neither is an edit.
     *
     * **The confirmation button is minted, not composed.** A plan previewed and
     * not committed has exactly one thing that can commit it, and only the runtime
     * is holding the validated steps — so the button carries them verbatim (§2.2).
     * That is an affordance the model cannot mint from here rather than words put
     * in its mouth, and without it the preview→commit path quietly stops being
     * button-driven.
     *
     * **The message is validated, and a refusal buys a round instead of an edit.**
     * `proseViolations` answers what the string itself decides; when it fires, the
     * loop spends its recovery round telling the model exactly what is wrong,
     * which is the same round of grace the `reply` tool gives — reached here by
     * asking again rather than by rewriting.
     */
    const pending = pendingConfirmation(toolCtx)
    const totalRows = [...(toolCtx.pendingMeta?.values() ?? [])]
      .filter((m) => m.needsConfirm)
      .reduce((n, m) => n + m.totalRows, 0)
    let buttons: { title: string; action: ActionPayload }[] | undefined

    if (pending) {
      buttons = [{ title: 'Do it', action: { kind: 'steps', steps: pending.steps, summary: pending.summary } }]
      if (totalRows > 3) {
        buttons.push({ title: `Show me all ${totalRows}`, action: { kind: 'reply', text: 'show me everyone that affects' } })
      }
      buttons.push({ title: 'Cancel', action: { kind: 'noop', ack: 'Left as it was — nothing changed.' } })
    }

    /**
     * One more round, spent on a refusal rather than on silence.
     *
     * The recovery round already exists for the turn that said nothing; this is
     * the same mechanism for the turn that said something it cannot send. It runs
     * at most once — a second failure is not argued with, because the alternative
     * to a machine word in a good sentence is no sentence at all, and going quiet
     * is the one failure a person cannot tell apart from being ignored.
     */
    let outgoing = text.trim()
    const violations = proseViolations(outgoing, identity)
    if (violations.length) {
      trace.push({
        round: rounds,
        name: '(trailing message refused: machinery in the prose)',
        ms: 0,
        args: evidence({ violations, draft: outgoing }, 2000),
      })
      try {
        const again = await generate({
          system,
          messages: [
            ...flattenToolTurns(messages),
            {
              role: 'user',
              content:
                `That last message cannot go out as written: ${violationMessage(violations)}\n\n` +
                'Write it again with just those parts fixed. Everything else about it was fine, ' +
                'and nothing about the situation has changed — do not add anything, and do not ' +
                'say you are about to do something. This is the last thing sent.',
            },
          ],
          model: env.MODEL_MAIN,
          temperature: 0.4,
        })
        promptTokens += again.usage.promptTokens
        outputTokens += again.usage.outputTokens
        cachedTokens += again.usage.cachedTokens
        trace.push({
          round: rounds + 1,
          name: TRACE_MARKER,
          ms: again.ms,
          args: evidence(again.text ?? '', 4000),
          ...(typeof again.assistant?.reasoning_content === 'string' && again.assistant.reasoning_content.trim()
            ? { reasoning: evidence(again.assistant.reasoning_content, REASONING_TRACE_CAP) }
            : {}),
          result: { in: again.usage.promptTokens, cached: again.usage.cachedTokens, out: again.usage.outputTokens, calls: [], finish: again.finishReason ?? 'unknown', repair: true },
        })
        const rewritten = (again.text ?? '').trim()
        // Only if it is actually better. A rewrite that still carries machinery
        // is not worth preferring over the original, and the original at least
        // came from a round that had the whole turn in front of it.
        if (rewritten && !proseViolations(rewritten, identity).length) outgoing = rewritten
      } catch {
        /* the draft still goes; a failed repair must not become silence */
      }
    }

    // R10 on this path too: which one a turn takes is the model's choice, and a
    // recording that depends on that choice records the easy half.
    const untraced = traceabilityNote(outgoing, toolCtx.evidence ?? [])
    if (untraced) toolCtx.untraced?.push({ body: outgoing, found: untraced })

    const trailing = await composeAndSend(session, {
      toContactId: identity.contact.id,
      body: outgoing,
      buttons,
    })
    outcomes.push(trailing)
    // Recorded on the same condition as every other send: it counts as having been
    // said when it landed. A suppressed trailing message is a turn that said nothing,
    // and reflection should see that rather than a reply nobody received.
    if (trailing.status === 'sent' || trailing.status === 'queued') {
      toolCtx.saidToUser?.push(outgoing)
      // On the same condition, and for the reason `ToolCtx.spokeAsTrailingProse`
      // records: this is the send the model does not know it made. `saidToUser`
      // keeps the words; this keeps the fact that the runtime, not a `reply`
      // call, put them on the phone — which is what reflection was arguing with
      // `turnState` about on three turns of the 19 Aug run.
      toolCtx.spokeAsTrailingProse = true
    }
    text = outgoing
  }

  /* ----------------------------------------------------------------------- *
   * §5 — what the turn learned, asked as the turn's LAST ROUND.
   *
   * This was a second model call with its own ~300-token system prompt, no
   * stable prefix, no schema and two tools. ARCHITECTURE.md had already deleted
   * a component of that exact shape and written down why: *"There is no separate
   * synthesis path — no bespoke model call, no dearer model, no toolless prompt
   * fed pre-queried rows... As a turn it has tools, which fixes a real defect
   * class: the old synth was spoon-fed query results it could not verify or
   * widen."* `MODEL_SYNTH` died for that; reflection was the same shape and
   * survived the pass.
   *
   * What being a round buys, in defects rather than tidiness:
   *
   *  - **`context_query` stops being imagination.** The separate call had never
   *    been shown the schema and had no `read`, so naming a table after the
   *    concept was the only move available to it — driven twice in one week,
   *    `FROM booking` and `FROM register`, neither a table. F-AP's mint-time
   *    check refused both and there was no round in which to recover, so both
   *    watches were lost silently; one of them was the only thing that would
   *    have chased a parent's session move. Here the schema is already in
   *    context and a refusal has a round to be fixed in, like every other.
   *  - **The slot filter is deleted rather than adjusted.** The old pass was
   *    denied `schedule` if the main loop had CALLED it — bookkeeping that
   *    inverted on the case that mattered, because a loop which reasoned its way
   *    to "no second watch here" and called nothing left the slot open and got
   *    offered the tool anyway. A round can see its own trace and its own
   *    reasoning, so there is nothing to bookkeep.
   *  - **Everything before it is a cache hit — the tool block included.**
   *    Rounds append rather than rebuild, so this shares a byte-identical
   *    opening with the round before it. That was true of the messages and
   *    false of the tools for as long as this round filtered its declarations
   *    down to two, and the tools serialise *above* the messages: the match
   *    stopped at the tool block, and the whole conversation billed fresh
   *    behind it. The old call's claim to be cheaper rested on skipping a
   *    prefix that is the discounted part — a claim this round earns only by
   *    sending the block every other round sends. The `tools:` line below has
   *    what the filter cost.
   *
   * **C30's counter-evidence, kept in view.** An extra round after the reply was
   * removed once for producing `STOP · 0 output tokens` at the cost of a full
   * prefix. That round asked nothing; this one asks two named questions, which
   * is the whole difference — and if a drive shows it earning nothing, it goes
   * the same way and this comment is the record of what was tried.
   *
   * Nobody is waiting: the reply is already on their phone.
   * ----------------------------------------------------------------------- */
  if (!forcedError && (text.trim() || spoke())) {
    try {
      // Belt and braces, and now the outer belt: `reply` is declared in this
      // round like every other tool, so what refuses a second message is the
      // one-message-per-person guard — the same guard the main loop uses, not a
      // second rule — behind the dispatcher below, which runs no name outside
      // `REFLECT_TOOLS`. A short declaration list stopped being a constraint
      // when it stopped being short, and nothing was leaning on it that these
      // two were not already refusing.
      toolCtx.repliedTo?.add(identity.contact.id)

      messages.push({
        role: 'user',
        content:
          '[The reply has gone and nobody is waiting. Two questions are left open; anything not listed ' +
          'here was handled during the turn and must not be repeated. "Neither" is the common and correct ' +
          'answer, and calling nothing at all is the system working. Only ' +
          REFLECT_TOOLS.map((t) => '`' + t + '`').join(' and ') +
          ' run in this round: every other tool is declared, as it is on every round, and a call ' +
          'to one is dropped unread.\n\n' +
          '1. Is there a fact worth carrying? Vocabulary they use, a habit, a preference, something about ' +
          'how this person works. Facts, not transcripts. Facts, not rows — a rate, a schedule, a balance, ' +
          'who pays for whom: the database holds those and a memory copy of a row is a future wrong answer. ' +
          'A fact comes from what THEY said or what a row held, NEVER from a sentence you wrote: a policy ' +
          'invented mid-conversation and then remembered acquires the authority of one the owner stated. ' +
          'How the business is run belongs in business_rule, stated by the owner.\n\n' +
          '2. Did they ask you to look at something later, or did you promise to come back to something? ' +
          'That is a `schedule`. You can see what you are already watching at the top of this conversation — ' +
          'a second watch on the same subject replaces the first, so restating one is safe and duplicating ' +
          'it is not possible. A promise the standing jobs already keep is not a watch: reminders, register ' +
          'chases, briefs, the monthly bill and the dunning ladder all run without you.\n\n' +
          `${turnState(toolCtx)}]`,
      })

      const ref = await generate({
        system,
        messages,
        /*
         * The whole block, unfiltered — and sending more is what makes this
         * round cheap. The declarations serialise ahead of the messages, so the
         * tool list is part of the prefix the cache matches on: a round that
         * sends a different list matches to the end of the system prompt,
         * diverges at the tools, and re-bills everything behind them — the
         * filtered declarations AND the entire conversation — at full price.
         *
         * The signature was unmistakable. Filtered, this round's `cached` was
         * exactly 17,024 on 57 of 57 calls, invariant across five days, every
         * persona and every conversation length, while the main loop never
         * cached below 22,656; the 5,632-token gap is this block, and the 17 Aug
         * run shows the same plateau against a constant of 14,592. It bought a
         * 69.9% hit rate against the loop's 94.3% and 7,348 miss tokens a call
         * against 1,625 — a quarter of the run's input volume, 64% of every
         * cache miss in it, ₹6.48 of a ₹29.52 run off-peak and twice that at
         * peak. Unfiltered, the round bills 57% less while being shown 22 more
         * declarations, because the extra arrives at 3.2% of the price.
         *
         * The filter was not buying constraint either: `isReflectTool` below
         * drops every other call before `runTool` sees it, and `repliedTo` above
         * refuses a second reply. Constrain a round at its dispatcher; what it
         * is shown is the cached part.
         */
        tools: toolDecls(),
        model: env.MODEL_MAIN,
        temperature: 0.2,
        thinking: 'low',
        maxOutputTokens: 2048,
      })
      promptTokens += ref.usage.promptTokens
      outputTokens += ref.usage.outputTokens
      cachedTokens += ref.usage.cachedTokens

      if (typeof ref.assistant?.reasoning_content === 'string' && ref.assistant.reasoning_content.trim()) {
        trace.push({
          round: rounds + 1,
          name: '(reflection)',
          ms: ref.ms,
          reasoning: evidence(ref.assistant.reasoning_content, REASONING_TRACE_CAP),
        })
      }

      for (const call of ref.functionCalls.slice(0, 4)) {
        // This line, not the declaration list, is what makes the round two tools
        // wide. The model is shown everything the turn was shown, so a call
        // outside the two is now *possible* where it used to be undeclarable —
        // and a drop nobody records is how a new habit stays invisible for a
        // month. Recorded as a marker rather than a call: `isToolCall` reads the
        // leading bracket, so nothing counts it as a tool the model reached for.
        if (!isReflectTool(call.name)) {
          trace.push({
            round: rounds + 1,
            name: `(reflection dropped a call outside ${REFLECT_TOOLS.join(' and ')})`,
            ms: 0,
            args: evidence({ name: call.name, args: call.args }, 1000),
          })
          continue
        }
        // The name keeps its `reflect:` prefix: `recentActions` skips these when
        // it replays a turn's actions into the next one's tail, and a rename here
        // would quietly start feeding bookkeeping back as context.
        if (call.parseError) {
          trace.push({
            round: rounds + 1,
            name: `reflect:${call.name}`,
            ms: 0,
            error: `MALFORMED_FUNCTION_CALL: ${call.parseError}`,
          })
          continue
        }
        const startedAt = Date.now()
        try {
          const r = await runTool(call.name, call.args, toolCtx)
          trace.push({
            round: rounds + 1,
            name: `reflect:${call.name}`,
            ms: Date.now() - startedAt,
            args: evidence(call.args, 1000),
            result: evidence(r.result, 800),
          })
        } catch (e) {
          trace.push({
            round: rounds + 1,
            name: `reflect:${call.name}`,
            ms: Date.now() - startedAt,
            args: evidence(call.args, 1000),
            error: e instanceof Error ? e.message : String(e),
          })
        }
      }
    } catch {
      // Nothing here may cost a person their reply, and the reply has already
      // been sent — so a failure is recorded by its absence and the turn ends.
    }
  }

  /**
   * R10's shadow report, on the flight recorder and nowhere else.
   *
   * One entry per message that stated a figure or a clock time this turn's own
   * tools never returned. It refused nothing and changed nothing; it exists so a
   * drive can be read for whether the gate would be worth turning on, which is
   * the only evidence this repo accepts for turning anything on.
   */
  if (toolCtx.untraced?.length) {
    trace.push({
      round: rounds,
      name: '(R10 shadow: numbers with no read behind them)',
      ms: 0,
      args: evidence(toolCtx.untraced, 4000),
    })
  }

  return {
    outcomes,
    toolCalls,
    text,
    said: [...(toolCtx.saidToUser ?? [])],
    model,
    promptTokens,
    outputTokens,
    cachedTokens,
    trace,
    rounds,
    ...(forcedError ? { error: forcedError } : {}),
  }
}

/**
 * The turn's history, with every tool call and result turned into plain text.
 *
 * The recovery round declares no tools on purpose — its whole job is to put what the
 * turn already learned into words. But a history containing `tool_calls` and the
 * `{role:'tool'}` messages that answer them is only coherent alongside a tool
 * declaration: the previous provider answered such a request with an error and an
 * empty candidate, and an OpenAI-dialect API is entitled to 400 it. The reason for
 * flattening is unchanged by the migration; only the shape being flattened is.
 *
 * So the round designed to guarantee the person hears *something* was the one round
 * that could never run. Watched live: seven rounds, sixty seconds, 153k tokens, a
 * malformed call, and then the recovery — the last line of defence against
 * silence — failed the same way and the admin was told "something broke
 * on my side". The venue had been created; nothing said so.
 *
 * Flattening keeps every fact and loses only the encoding. "Everything the turn learned
 * is already sitting in `contents`" is the comment above; this is what makes it true.
 */
function flattenToolTurns(messages: Msg[]): Msg[] {
  const names = new Map<string, string>()
  const out: Msg[] = []
  for (const m of messages) {
    if (m.role === 'assistant' && m.tool_calls?.length) {
      for (const c of m.tool_calls) names.set(c.id, c.function.name)
      const lines = m.tool_calls.map(
        (c) => `[you called ${c.function.name} with ${evidence(c.function.arguments ?? '{}', 1500)}]`,
      )
      const said = (m.content ?? '').trim()
      // The reasoning is deliberately dropped rather than flattened. It belongs to
      // the call it was emitted with, the call is gone, and it was never something
      // to answer from — the results below are.
      out.push({ role: 'assistant', content: [said, ...lines].filter(Boolean).join('\n') })
      continue
    }
    if (m.role === 'tool') {
      const name = names.get(m.tool_call_id) ?? 'that'
      out.push({ role: 'user', content: `[${name} came back: ${traceValue(m.content, 3000)}]` })
      continue
    }
    if (m.role === 'assistant') {
      // `reasoning_content` is only legal to echo alongside the calls it came
      // with; without them it is noise the API is entitled to reject.
      out.push({ role: 'assistant', content: m.content ?? '' })
      continue
    }
    out.push(m)
  }
  return out
}

/** A tool result on this wire is a string, and `undefined` is not JSON. */
function toolContent(result: unknown): string {
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result ?? null)
  } catch {
    return String(result)
  }
}

/**
 * A WhatsApp thread is not one conversation, and the model could not tell.
 *
 * Everything else shown to the model is either byte-stable forever or stamped with
 * when it was true — `recentLookups` renders `[read 2 hours ago]` for exactly this
 * reason, and the comment above `ageOf` states the rule. The conversation itself was
 * the one exception: `queued_at` was the sort key and was then thrown away, so
 * sixteen messages spanning three weeks arrived looking like sixteen messages spanning
 * three minutes.
 *
 * **The stamp cannot go on the messages.** A time written into a `content` string
 * enters the conversation as something a person said, which is the one place a runtime
 * sentence must never appear — the same reason the failure note below travels beside
 * the messages rather than among them. So the breaks are described in the tail, where
 * every other runtime statement lives.
 *
 * Gaps rather than per-message stamps, on purpose. Sixteen stamps is sixteen lines of
 * tail rebuilt and re-billed on every round to say what four lines say: this much was
 * just now, that much was Tuesday. And the gaps are the only part that ever changes a
 * reading — "did that go through?" means one thing after three minutes and another
 * after three days.
 *
 * Nothing is emitted for a continuous exchange, which is most of them.
 */
const HISTORY_GAP_MINUTES = 180

function historyGaps(rows: { queued_at: Date | string }[], at: Date): string | null {
  if (rows.length < 2) return null
  const times = rows.map((r) => (r.queued_at instanceof Date ? r.queued_at : new Date(String(r.queued_at))))
  if (times.some((t) => Number.isNaN(t.getTime()))) return null

  // Oldest-first, same order as the messages. A group ends where the next message
  // arrives more than the threshold after it.
  const groups: { count: number; newest: Date }[] = []
  let count = 1
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i]!.getTime() - times[i - 1]!.getTime()) / 60_000
    if (gap > HISTORY_GAP_MINUTES) {
      groups.push({ count, newest: times[i - 1]! })
      count = 1
    } else {
      count++
    }
  }
  groups.push({ count, newest: times[times.length - 1]! })
  if (groups.length < 2) return null

  // Newest first, because that is the end of the thread they are answering.
  const lines = [...groups].reverse().map((g, i) => {
    const which = i === 0 ? `the last ${g.count} message${g.count === 1 ? '' : 's'}` : `the ${g.count} before ${i === 1 ? 'them' : 'those'}`
    return `- ${which}: ${ageOf(g.newest, at)}`
  })
  return (
    `# When the thread above happened\n\n` +
    `It is not one continuous exchange, so do not read it as one. Newest first:\n\n` +
    lines.join('\n')
  )
}

/**
 * The thread this person is answering, and what to say when it could not be read.
 *
 * @mechanism recentHistory — a conversation prefetch that fails returns `why` beside the
 *   messages instead of an empty array, and the caller states it in the tail: an empty
 *   history is not a degraded turn but a DIFFERENT one, in which a family the business has
 *   served for months has never written before — so the model greets them, re-asks what
 *   they answered yesterday and re-offers what they already declined, all of it correctly
 *   derived from what it was given. The reason travels BESIDE the messages and never among
 *   them, because a runtime sentence in the message list arrives as something a person
 *   said; `historyGaps` rides the same channel with the thread's real time breaks.
 */
async function recentHistory(
  session: SessionCtx,
  identity: Identity,
): Promise<{ messages: Msg[]; why: string | null; gaps: string | null }> {
  try {
    const at = await now(identity.academyId)
    const rows = await withSession({ role: 'service', academyId: identity.academyId }, async (tx) => {
      return (await tx.unsafe(
        `select direction, body, queued_at from message
          where contact_id = ${uid(identity.contact.id)} and academy_id = ${uid(identity.academyId)}
            and body is not null and coalesce(suppressed_reason, '') = ''
          order by queued_at desc limit ${HISTORY}`,
      )) as unknown as { direction: string; body: string; queued_at: Date }[]
    })
    const oldestFirst = rows.reverse()
    return {
      messages: oldestFirst.map((r): Msg =>
        r.direction === 'inbound'
          ? { role: 'user', content: r.body }
          : { role: 'assistant', content: r.body },
      ),
      why: null,
      gaps: historyGaps(oldestFirst, at),
    }
  } catch (e) {
    /**
     * **The most consequential silent failure in the prefetch, and it was `return []`.**
     *
     * Everything else that dies here costs the model a fact. This one costs it the
     * conversation: an empty history is not a degraded turn, it is a DIFFERENT turn,
     * in which a person the business has served for months has never written before.
     * The model then greets them, re-asks what they answered yesterday, and re-offers
     * what they already declined — all of it fluent, all of it derived correctly from
     * what it was given.
     *
     * The reason cannot ride in the returned array: a marker message would enter the
     * conversation as something somebody said, which is the one place a runtime
     * sentence must never appear. So it comes back beside the messages and the caller
     * puts it in the tail, where every other runtime statement lives.
     */
    return { messages: [], why: errorMessage(e).split(/\r?\n/)[0].trim().slice(0, 200), gaps: null }
  }
}

/**
 * The reads this conversation already did, newest first, for the variable tail.
 *
 * `recentHistory` above carries what was *said*. This carries what was *found* —
 * and they are not the same thing, because §4.5 strips ids out of everything said.
 * Without this, a turn that needs an id fetched two messages ago has no legitimate
 * source for it, and the observed behaviour was to invent one that parses.
 *
 * Bounded on purpose: the newest reads, capped, in the uncached tail. Failed calls
 * are included — knowing a query errored is worth more than silence about it.
 */
/**
 * The last few turns that reached for a tool — **fetched ONCE**.
 *
 * @mechanism recentToolTurns — the last few turns' tool calls, read once and replayed into
 *   the tail as two labelled blocks. `recentLookups` keeps the reads, stamped with `ageOf`,
 *   because an unstamped two-day-old zero-row result reads as current data and is how an
 *   owner was reassured that every register was marked; `recentActions` keeps the writes,
 *   carrying their OUTCOME — `staged behind a confirmation button — NOT committed`,
 *   `failed … nothing was written` — so "did I actually do that" is answerable without the
 *   model thinking to query `audit_entry`, and a refusal cannot be replayed as a row to act
 *   on. A read that fails comes back with `why` rather than nothing, so a turn that could
 *   not see its own history stops looking exactly like a turn with no history to see.
 *
 * Two blocks of the tail are built from this one list: `recentLookups` keeps the
 * reads, `recentActions` keeps the writes. They are two filters over one query,
 * and each used to run it for itself — from inside the same `Promise.all`, so the
 * identical statement went out twice, concurrently, on two pooled connections,
 * every single turn of the product's life. Neither author was careless: each
 * function is correct alone, they were written weeks apart (the second exists
 * because the first deliberately excludes writes and that exclusion removed
 * something needed), and nothing anywhere said they shared a read.
 *
 * Fetching here also gives the failure ONE home. Both callers used to answer a
 * refused read with `undefined`, which `variableTail` renders as no block at all —
 * so a turn that could not see its own history looked exactly like a turn with no
 * history to see.
 */
async function recentToolTurns(
  identity: Identity,
): Promise<{ value: { created_at: Date; tool_calls: ToolTrace[] }[] | null; why: string | null }> {
  try {
    const rows = await withSession({ role: 'service', academyId: identity.academyId }, async (tx) => {
      return (await tx.unsafe(
        `select created_at, tool_calls from turn
          where contact_id = ${uid(identity.contact.id)}
            and academy_id = ${uid(identity.academyId)}
            and jsonb_array_length(coalesce(tool_calls, '[]'::jsonb)) > 0
          order by created_at desc limit ${LOOKUP_TURNS}`,
      )) as unknown as { created_at: Date; tool_calls: ToolTrace[] }[]
    })
    return { value: rows, why: null }
  } catch (e) {
    return { value: null, why: errorMessage(e).split(/\r?\n/)[0].trim().slice(0, 200) }
  }
}

/**
 * How old a replayed lookup is, off the tenant's clock, in the words a person
 * would use.
 *
 * **Everything the model is shown is either byte-stable forever or stamped with
 * when it was true.** These results were not. In a WhatsApp thread "earlier in
 * this conversation" can be three weeks ago, and a two-day-old zero-row result
 * presented as current data is how the model reassured an owner that every
 * register was marked while two were not. The row it read was right when it read
 * it; nothing said when that was.
 */
function ageOf(readAt: Date | string, at: Date): string {
  const then = readAt instanceof Date ? readAt : new Date(String(readAt))
  const mins = Math.max(0, Math.round((at.getTime() - then.getTime()) / 60_000))
  if (!Number.isFinite(mins)) return 'age unknown — treat as stale'
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} minutes ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function recentLookups(rows: { created_at: Date; tool_calls: ToolTrace[] }[], at: Date): string | undefined {
  const BUDGET = 6000
  {

    const blocks: string[] = []
    let used = 0
    for (const row of rows) {
      const age = ageOf(row.created_at, at)
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        // A `read` is the only call whose *result* is reference data. A write's
        // result is an outcome, and replaying outcomes as if they were facts is
        // how a bot tells someone something happened twice.
        if (call.name !== 'read') continue
        const query = String((call.args as any)?.query ?? '').replace(/\s+/g, ' ').trim()
        if (!query) continue
        const result = typeof call.result === 'string' ? call.result : JSON.stringify(call.result ?? null)
        const block =
          `- [read ${age}] ${query}\n  → ${result.length > 1400 ? `${result.slice(0, 1400)}… (truncated)` : result}` +
          (call.error ? `\n  ! failed: ${call.error.split('\n')[0]}` : '')
        if (used + block.length > BUDGET) return blocks.length ? blocks.join('\n') : undefined
        blocks.push(block)
        used += block.length
      }
    }
    return blocks.length ? blocks.join('\n') : undefined
  }
}

/**
 * What the last few turns DID — with each attempt's status, so "did I actually
 * do that?" is answerable without the model thinking to query `audit_entry`.
 *
 * `recentLookups` above excludes writes on purpose: replaying a write's result
 * as if it were reference data is how a bot does something twice. This block is
 * the half that exclusion over-removed, made safe by labelling: an outcome
 * travels WITH its status, so a refusal reads as "this did not happen" rather
 * than as a row to act on. F-K's worst instance is the motivating case — a
 * failed enrollment-end described, one turn later, as if it had been escalated;
 * the turn that composed the false claim could not see that nothing had been
 * written, and the turn after it could not see the attempt at all.
 */
async function recentActions(
  rows: { created_at: Date; tool_calls: ToolTrace[] }[],
  identity: Identity,
): Promise<string | undefined> {
  const BUDGET = 2400
  // `reply` is no longer here — see `replyLine` below for what it renders and why
  // only the ones that left this conversation are kept.
  const SKIP = new Set(['read', 'view', 'remember', 'reflect:remember'])
  const outcome = (call: ToolTrace): string => {
    if (call.error) return `failed: ${String(call.error).split('\n')[0].slice(0, 180)} — nothing was written`
    const r = call.result as Record<string, unknown> | string | undefined
    if (r && typeof r === 'object') {
      if (r.ok === false)
        return `refused: ${String(r.error ?? 'no reason recorded').split('\n')[0].slice(0, 180)} — nothing was written`
      // A staged preview says so in three spellings and none of them was read:
      // gated `plan` returns needs_preview:true, gated `act` returns
      // executed:false, and only commit's refusal (already caught above by its
      // error) carries needs_confirmation. So a plan waiting on a tap was
      // rendered "done — wrote N row(s)" in the next turn's context, under a
      // heading that forbids redoing done work — the model would truthfully
      // report a payment request as sent that nobody ever tapped (review find).
      if (r.needs_confirmation || r.needs_preview === true || r.executed === false) {
        return 'staged behind a confirmation button — NOT committed'
      }
      if (r.ok === true) {
        const changes = Array.isArray(r.changes)
          ? (r.changes as { count?: unknown }[]).reduce((a, c) => a + Number(c?.count ?? 0), 0)
          : 0
        return changes ? `done — wrote ${changes} row(s)` : 'done'
      }
    }
    return 'ran'
  }
  /**
   * The one send the model cannot recover, and the only kind kept here.
   *
   * A `reply` to the person in front of you is already in the transcript, word
   * for word, so replaying it in this block is noise — which is why `reply` sat
   * in SKIP at all. A reply to ANYONE ELSE is in no transcript this turn can
   * see: it went to a different thread. Excluding both left the escalation, the
   * most consequential message this product sends, with no trace in either place.
   *
   * Driven (`2026-08-17-18-07-live` t20). The model had put a prospect’s two
   * policy questions to the owner through `reply` two turns earlier. Asked
   * again, it could not see that it had — *"I said ‘I’ve asked the owner about
   * both…’ but there’s no record of that actually happening in the actions"* —
   * put the question to itself six times in one round, called no tool at all,
   * and hedged to a parent who was choosing between here and another club by
   * Sunday. Across the three live runs 14 turns ask that question; exactly one
   * answers it, by querying `message` itself.
   *
   * The NAME, not the id: the question is always "did I tell the OWNER", and a
   * uuid answers it only if the model still holds the read that named them. The
   * lookup runs on the turns that have such a reply to describe and no others,
   * and a name that will not read falls back to the id rather than hiding a send.
   */
  const ADMIN_WORD = /^(the )?(admin|owner)$/i
  const recipientOf = (call: ToolTrace): string | null => {
    const raw = (call.args as Record<string, unknown> | undefined)?.to_contact_id
    if (raw === undefined || raw === null) return null
    const to = String(raw).trim()
    // Absent or self: `reply` defaults `to_contact_id` to this contact, so both
    // spellings of "I answered them" land here, and both are in the transcript.
    return !to || to === identity.contact.id ? null : to
  }

  const ids = new Set<string>()
  for (const row of rows) {
    for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
      if (String(call.name ?? '') !== 'reply') continue
      const to = recipientOf(call)
      if (to && !ADMIN_WORD.test(to)) ids.add(to)
    }
  }
  const names = new Map<string, string>()
  if (ids.size) {
    try {
      const found = await withSession({ role: 'service', academyId: identity.academyId }, async (tx) => {
        return (await tx.unsafe(
          `select c.id, coalesce(p.full_name, c.phone_e164, 'someone') as name
             from contact c left join person p on p.id = c.person_id
            where c.id in (${[...ids].map(uid).join(', ')})`,
        )) as unknown as { id: string; name: string }[]
      })
      for (const r of found) names.set(String(r.id), String(r.name))
    } catch {
      // Falls through to the id. A name that cannot be read is not a reason to
      // go back to saying nothing at all about the message.
    }
  }

  const them = identity.person.full_name?.trim() || 'the person you are talking to'
  const replyLine = (call: ToolTrace, to: string): string => {
    const who = ADMIN_WORD.test(to) ? 'the owner' : names.get(to) ?? `contact ${to.slice(0, 8)}`
    const r = call.result as Record<string, unknown> | undefined
    let how = 'ran'
    if (call.error) how = `NOT sent: ${String(call.error).split('\n')[0].slice(0, 120)}`
    else if (r && typeof r === 'object') {
      const status = String(r.status ?? '')
      if (status === 'sent' || status === 'queued') how = 'sent'
      else if (status === 'suppressed') how = `NOT delivered: ${String(r.reason ?? 'suppressed')}`
      else if (r.sent === false || r.error)
        how = `NOT sent: ${String(r.error ?? 'refused').split('\n')[0].slice(0, 120)}`
    }
    // The body is deliberately absent. What was unanswerable is WHETHER this
    // person was written to, never what was said — and a body here is the one
    // thing `recentLookups` above proves costly: text replayed as reference data.
    return `- reply to ${who}, not to ${them} → ${how}`
  }

  {
    const lines: string[] = []
    let used = 0
    for (const row of rows) {
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        const name = String(call.name ?? '')
        if (!name || SKIP.has(name) || name.startsWith('(')) continue
        let line: string
        if (name === 'reply') {
          const to = recipientOf(call)
          if (!to) continue
          line = replyLine(call, to)
        } else {
          const args = JSON.stringify(call.args ?? {}).slice(0, 140)
          line = `- ${name} ${args} → ${outcome(call)}`
        }
        if (used + line.length > BUDGET) return lines.length ? lines.join('\n') : undefined
        lines.push(line)
        used += line.length
      }
    }
    return lines.length ? lines.join('\n') : undefined
  }
}

/* ------------------------------------------------------------------------- *
 * §14.8 — two failed turns is an automatic trigger, not a judgement call.
 * ------------------------------------------------------------------------- */

async function handoffOnRepeatedFailure(
  session: SessionCtx,
  identity: Identity,
  turnId: string,
): Promise<SendOutcome[] | null> {
  // Two failed turns in a ROW, not two failures ever: the current turn's row is
  // already written by the time this runs, so these are the last two.
  const last = await withSession({ role: 'service', academyId: identity.academyId }, async (tx) => {
    return (await tx.unsafe(
      `select error from turn
        where contact_id = ${uid(identity.contact.id)}
        order by created_at desc limit 2`,
    )) as unknown as { error: string | null }[]
  })
  if (last.length < 2 || !last.every((t) => t.error)) return null

  const out = await runTool(
    'handoff',
    { reason: 'two turns in a row went wrong', summary: 'The bot could not complete the last two requests.' },
    { session, identity, turnId, pendingPlans: new Map(), outcomes: [] },
  )
  const say = (out.result as { say?: string })?.say
  const sent: SendOutcome[] = []
  if (say) sent.push(await composeAndSend(session, { toContactId: identity.contact.id, body: say }))
  return sent
}

/* ------------------------------------------------------------------------- *
 * The turn row. Always written, including on error.
 * ------------------------------------------------------------------------- */

async function writeTurn(o: {
  turnId: string
  identity: Identity
  input: TurnInput
  output: unknown
  model?: string
  promptTokens: number
  outputTokens: number
  cachedTokens: number
  latencyMs: number
  error?: string
  trace?: ToolTrace[]
  rounds?: number
}): Promise<void> {
  try {
    await withSession({ role: 'service', academyId: o.identity.academyId }, async (tx) => {
      await tx.unsafe(
        `insert into turn (id, academy_id, contact_id, person_id, role_acted, input, output, model,
                           prompt_tokens, output_tokens, cached_tokens, latency_ms, error,
                           tool_calls, rounds)
         values (${uid(o.turnId)}, ${uid(o.identity.academyId)}, ${uid(o.identity.contact.id)},
                 ${uid(o.identity.person.id)}, ${lit(o.identity.roles.join('+'))},
                 ${jsonLit({
                   source: o.input.source,
                   text: o.input.text ?? null,
                   actionId: o.input.actionId ?? null,
                   media: o.input.media?.length ?? 0,
                   task: o.input.task?.instruction ?? null,
                 })},
                 ${jsonLit(o.output)}, ${lit(o.model ?? null)}, ${lit(o.promptTokens)}, ${lit(o.outputTokens)},
                 ${lit(o.cachedTokens)}, ${lit(o.latencyMs)}, ${lit(o.error ?? null)},
                 ${jsonLit(o.trace ?? [])}, ${lit(o.rounds ?? null)})`,
      )
    })
  } catch {
    /* instrumentation must never be the reason a turn fails */
  }
}

/* ------------------------------------------------------------------------- *
 * §13.1 — the bot schedules itself
 * ------------------------------------------------------------------------- */

export async function runAgentTask(job: Job): Promise<void> {
  const payload = (job.payload ?? {}) as unknown as Record<string, any>
  const academyId = String(payload.academy_id ?? '')
  if (!academyId) return

  // `expires_at` is required, and a task past it simply does not run.
  const nowD = await now(academyId)
  if (!payload.expires_at || new Date(String(payload.expires_at)).getTime() < nowD.getTime()) return

  let contactId: string | null = payload.minted_by_contact_id ? String(payload.minted_by_contact_id) : null
  if (!contactId && payload.minted_by) {
    contactId = await withSession({ role: 'service', academyId }, async (tx) => {
      const rows = (await tx.unsafe(
        `select contact_id from turn where id = ${uid(String(payload.minted_by))}`,
      )) as unknown as { contact_id: string | null }[]
      return rows[0]?.contact_id ?? null
    })
  }
  if (!contactId) return

  // It runs under a session RECONSTRUCTED for the person who minted it — not a
  // stored token, which would still be live weeks later, and not a service
  // role. Roles are re-checked here, at run time, so a task minted by a coach
  // who has since been ended simply cannot run.
  const identity = await resolveIdentity(contactId)
  if (!identity || identity.academyId !== academyId) return
  const minted: Role[] = Array.isArray(payload.minted_roles) ? payload.minted_roles : []
  if (minted.length && !minted.some((r) => identity.roles.includes(r))) return
  if (!identity.roles.length) return

  let queryResults: unknown = undefined
  if (payload.context) {
    const res = await modelQuery(sessionOf(identity), String(payload.context))
    queryResults = res.error
      ? { error: res.error }
      : { rowCount: res.rowCount, truncated: res.truncated, rows: res.rows.slice(0, 200) }
  }

  // An ordinary turn from here. Deciding to do nothing is success: a task that
  // fires and stays quiet is the system working.
  await runTurn({
    contactId,
    source: 'job',
    task: { instruction: String(payload.instruction ?? ''), queryResults },
  })
}

/* ------------------------------------------------------------------------- *
 * §10.2 — the brief and the digest.
 *
 * **They used to live here, and they were the only bespoke model calls in the
 * product.** `synthesize()`, `synthesisPayload()`, `GROUNDING` and
 * `writeSynthTurn()` stood in this space: eleven pre-run queries handed to
 * `MODEL_SYNTH` as a JSON blob, with no tools, no stable prefix, no flight
 * recorder, twice a day per academy, whether or not anything had happened.
 *
 * They are `lib/jobs/handlers/admin.ts`'s `runSynthesis` now, which counts what
 * changed and — if anything did — opens an ORDINARY TURN. Every reason the
 * separate path existed inverted under the architecture:
 *
 *   The cached prefix is the CHEAP part. A hit costs 3.2% of a miss, so an
 *   ordinary turn on the conversation model costs less than the bespoke call
 *   did — and the bespoke path could not share the prefix at all, which is how
 *   the two most expensive calls of the day came to cost 3.5× the entire human
 *   conversation while caching at half the rate. The stress month is the evidence
 *   the conversation model is enough: the hardest judgements of the run were made
 *   by it, and summarizing a day is easier than the clash refusal was.
 *
 *   As a turn it has TOOLS, which closes a real defect class. The old synth was
 *   spoon-fed query results it could not verify or widen — which is why a digest
 *   once told the solo coach "I think coaches aren't marking after sessions"
 *   *about himself*. A turn reads what the sentence needs, like every other turn.
 *
 *   As a turn it is recorded, guarded and result-honest for free. The two most
 *   expensive calls of the day stop being the two with no record of why they said
 *   anything.
 *
 *   And the special doctrine constraint dies with the path: nothing has to be
 *   "true on the toolless path too" when there is no toolless path.
 * ------------------------------------------------------------------------- */

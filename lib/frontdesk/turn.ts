/**
 * lib/frontdesk/turn.ts — the middle of a visitor's turn (0039).
 *
 * This is deliberately NOT a second `runTurn`. `lib/agent/loop.ts` still owns what a
 * turn is: it resolves the identity, consumes a tap, decides the model is needed,
 * writes the `turn` row afterwards and performs the hand-over. What it delegates here
 * is the part that differs — which prefix, which tools, and when to stop — and it gets
 * back the same numbers it would have produced itself, so one recorder writes every
 * turn this product runs and there is no second flight recorder to keep honest.
 *
 * THE SHAPE OF A FRONT-DESK TURN
 * ---------------------------------------------------------------------------
 *   1. Build the context: the second stable prefix, the tail about this arrival, and
 *      the short thread so far.
 *   2. Up to MAX_ROUNDS of generate → run tools → feed the results back.
 *   3. A round that calls no tool is the desk speaking; the trailing prose is sent.
 *   4. A hand-over ends it immediately, whatever else the model had planned. The
 *      caller re-enters an ordinary turn inside the business and the person is
 *      answered from there.
 *
 * WHY THREE ROUNDS
 * ---------------------------------------------------------------------------
 * The tenant loop allows five, and the measurement behind that number is that rounds
 * correlate with tool calls that FAILED — 0-2 rounds, 0% of turns had a failing call;
 * 5 rounds, 100%. A front desk has four verbs, one question and no schema to get wrong.
 * A third round here means the model is arguing with a refusal rather than converging,
 * and every round is a second of silence for somebody who does not yet know whether
 * this number is a real business.
 */

import { generate } from '@/lib/agent/deepseek'
import type { Msg } from '@/lib/agent/deepseek'
import { proseViolations, violationMessage } from '@/lib/agent/lint'
// Type-only, so it is erased at compile time and adds no import edge at runtime.
// `lib/agent/loop.ts` imports this module; a value import back would close a cycle,
// and this repo has already paid for one — `act`'s enum was built at module load, one
// extra edge emptied the list, and every turn came back malformed with no output.
import type { ToolTrace } from '@/lib/agent/loop'
import { now } from '@/lib/clock'
import type { SessionCtx } from '@/lib/db'
import { matchAcademiesByName } from '@/lib/identity'
import { composeAndSend } from '@/lib/messaging/compose'
import type { SendOutcome } from '@/lib/messaging/types'
import type { Identity } from '@/lib/types'
import { arrivalForContact, markArrivalAsked } from './arrival'
import { FRONT_DESK_BOUNDARY, FRONT_DESK_PREFIX, frontDeskHistory, frontDeskTail } from './context'
import { businessesOnThisNumber } from './route'
import type { Handover } from './route'
import { frontDeskToolDecls, ReplyArgs, runFrontDeskTool } from './tools'

const MAX_ROUNDS = 3

/** Everything `runTurn` needs to finish the turn it started. */
export type FrontDeskRun = {
  outcomes: SendOutcome[]
  replyText: string
  trace: ToolTrace[]
  rounds: number
  toolCalls: number
  model?: string
  promptTokens: number
  outputTokens: number
  cachedTokens: number
  error?: string
  /** Where this conversation belongs now. The caller re-enters an ordinary turn there. */
  handover?: Handover
}

/**
 * The word "academy" is refused in any outbound body — it is this product's word for
 * the tenant table and appears nowhere a user can see. At a front desk that collides
 * with the only way to identify a business at all, because businesses are called
 * things like "Ace TT Academy", and the check's own `fix` sentence tells the model to
 * *"use their own name for the business"*.
 *
 * So the real business names on this number are masked out of the body before the
 * check runs. This narrows the question to the one the ban is actually about — *does
 * this sentence call a business an "academy"?* — and it is exactly decidable rather
 * than a judgement, because a name is masked only when it matches a row. Nothing is
 * rewritten: the mask exists for the length of the check and what ships is byte-for-
 * byte what the model wrote.
 */
function violationsAtDesk(body: string, identity: Identity, businessNames: string[]): string[] {
  let masked = body
  for (const name of businessNames) {
    if (!name) continue
    masked = masked.split(name).join(' ')
  }
  const violations = proseViolations(masked, {
    academyId: identity.academyId,
    academy: { name: null, timezone: identity.academy.timezone, memory: null },
  })
  return violations.length ? [violationMessage(violations)] : []
}

/**
 * @mechanism runFrontDeskTurn — the visitor's turn, on the second stable prefix and four
 *   verbs. It ends the moment a hand-over lands rather than letting the model add a
 *   parting sentence, because the business is about to answer the same message from inside
 *   itself and two answers to one question is what that shape produces if nothing stops it.
 *   It writes no `turn` row and owns no recorder: `runTurn` records this exactly as it
 *   records every other turn, so a front-desk turn is visible in the same table, the same
 *   report and the same drive as a parent's.
 */
export async function runFrontDeskTurn(o: {
  session: SessionCtx
  identity: Identity
  turnId: string
  text?: string
}): Promise<FrontDeskRun> {
  const run: FrontDeskRun = {
    outcomes: [],
    replyText: '',
    trace: [],
    rounds: 0,
    toolCalls: 0,
    promptTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  }

  const at = await now(o.identity.academyId)
  const arrival = await arrivalForContact(o.identity.academyId, o.identity.contact.id)
  const businesses = await businessesOnThisNumber(o.identity)
  const businessNames = businesses.map((b) => b.name)

  // The evidence that used to be spent as a routing decision. `arrival.firstText` is
  // what they OPENED with, which is the message that says whether the question needs
  // asking at all; the current text is matched too, because an answer may name the
  // business only on the second message.
  const named = [
    ...matchAcademiesByName(arrival?.firstText ?? undefined, businesses),
    ...matchAcademiesByName(o.text, businesses),
  ].filter((a, i, all) => all.findIndex((b) => b.academyId === a.academyId) === i)

  const history = await frontDeskHistory(o.identity)

  const tail = frontDeskTail({
    identity: o.identity,
    arrival,
    named,
    businessCount: businesses.length,
    atIso: at.toISOString(),
  })

  const system = [FRONT_DESK_PREFIX, FRONT_DESK_BOUNDARY, tail].join('\n\n')

  const messages: Msg[] = [...history.messages]
  if (history.failed) {
    messages.push({
      role: 'user',
      content:
        '[the earlier messages in this thread could not be read this turn — do not treat this as the ' +
        'first thing they have said]',
    })
  }
  if (o.text) messages.push({ role: 'user', content: o.text })
  if (messages.length === 0) {
    // Nothing to answer. The caller does not route a media-only or empty inbound here,
    // but a turn with no message is a turn with nothing to say, and saying something
    // anyway is how a greeting reaches somebody who greeted nobody.
    return run
  }

  const tools = frontDeskToolDecls()
  let proseChecked = false

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    run.rounds = round

    let gen
    try {
      gen = await generate({ system, messages, tools })
    } catch (e) {
      run.error = e instanceof Error ? e.message : String(e)
      break
    }

    run.model = gen.model
    run.promptTokens += gen.usage.promptTokens
    run.outputTokens += gen.usage.outputTokens
    run.cachedTokens += gen.usage.cachedTokens
    messages.push(gen.assistant)

    // A round that calls nothing is the desk speaking. Same rule as the tenant loop,
    // for the same reason: prose beside a tool call is a notebook nobody reads.
    if (gen.functionCalls.length === 0) {
      const body = (gen.text ?? '').trim()
      if (!body) {
        run.error = 'front desk produced neither a tool call nor anything to say'
        break
      }
      const bad = proseChecked ? [] : violationsAtDesk(body, o.identity, businessNames)
      if (bad.length) {
        // One round of grace, while the author can still fix it — never a rewrite.
        proseChecked = true
        messages.push({
          role: 'user',
          content: `That message cannot go as written: ${bad.join('; ')} Rewrite just that part and send it again.`,
        })
        continue
      }
      run.replyText = body
      run.outcomes.push(await sendFromDesk(o.session, o.identity, body))
      await noteAsked(o.identity, arrival?.id, at)
      break
    }

    for (const call of gen.functionCalls) {
      run.toolCalls += 1
      const startedMs = Date.now()

      if (call.parseError) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `those arguments did not parse: ${call.parseError}`,
        })
        run.trace.push({
          round, name: call.name, ms: Date.now() - startedMs,
          args: String(call.raw ?? '').slice(0, 2000), result: `parse error: ${call.parseError}`,
        })
        continue
      }

      // `reply` lives here rather than in tools.ts because it is the only verb that
      // needs a session to send on, and threading one into the router would make the
      // router a sender.
      if (call.name === 'reply') {
        const parsed = ReplyArgs.safeParse(call.args)
        if (!parsed.success) {
          messages.push({ role: 'tool', tool_call_id: call.id, content: 'reply needs a body.' })
          continue
        }
        const bad = proseChecked ? [] : violationsAtDesk(parsed.data.body, o.identity, businessNames)
        if (bad.length) {
          proseChecked = true
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `that message cannot go as written: ${bad.join('; ')} Rewrite just that part and send it again.`,
          })
          continue
        }
        const outcome = await sendFromDesk(
          o.session,
          o.identity,
          parsed.data.body,
          parsed.data.buttons ?? undefined,
        )
        run.replyText = parsed.data.body
        run.outcomes.push(outcome)
        await noteAsked(o.identity, arrival?.id, at)
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content:
            outcome.status === 'suppressed' || outcome.status === 'failed'
              ? `not sent — ${outcome.reason}. That is a decision the send path made, not a wording problem; do not rephrase and retry.`
              : 'sent',
        })
        run.trace.push({
          round, name: 'reply', ms: Date.now() - startedMs,
          args: JSON.stringify(parsed.data).slice(0, 2000), result: outcome.status,
        })
        continue
      }

      const result = await runFrontDeskTool(o.identity, arrival, call.name, call.args, o.text)
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content })
      run.trace.push({
        round, name: call.name, ms: Date.now() - startedMs,
        args: JSON.stringify(call.args ?? {}).slice(0, 2000), result: result.content.slice(0, 2000),
      })

      if (result.handover) {
        run.handover = result.handover
        return run
      }
      if (result.stopped) {
        // They asked to be left alone and it is recorded. Gate 1 of the send path will
        // refuse anything further anyway; returning here means the desk does not spend
        // a round composing a message that is about to be suppressed.
        return run
      }
    }
  }

  return run
}

/**
 * Every message the front desk sends goes through `composeAndSend`, which is the
 * product's one composer and the only importer of `send` besides the plan executor.
 * A front desk with its own sender would be a path around the ten gates — the caps, the
 * opt-out, the repeat check — on the one surface that talks to people who never asked
 * to hear from this number.
 *
 * Buttons carry `{kind:'reply'}` payloads, so a tap re-enters the turn as if the person
 * had typed the answer. That is the existing button contract (`executeAction`), not a
 * front-desk one, which is why `[I'm looking for classes]` needs no new machinery.
 */
async function sendFromDesk(
  session: SessionCtx,
  identity: Identity,
  body: string,
  buttons?: { title: string; answer: string }[],
): Promise<SendOutcome> {
  return composeAndSend(session, {
    toContactId: identity.contact.id,
    body,
    buttons: buttons?.length
      ? buttons.map((b) => ({ title: b.title, action: { kind: 'reply' as const, text: b.answer } }))
      : undefined,
  })
}

/**
 * The question has been on their screen. Stamped once, so `asked_at is null` keeps
 * meaning "their opening message already said which they were, and nothing had to be
 * asked" rather than decaying into "we have not got round to it".
 */
async function noteAsked(identity: Identity, arrivalId: string | undefined, at: Date): Promise<void> {
  if (!arrivalId) return
  await markArrivalAsked(identity.academyId, arrivalId, at)
}

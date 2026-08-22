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
 *   3. The desk speaks by calling `reply`, which is the only thing that can carry a
 *      button. A round that calls no tool is spent telling it so — once (`proseRefused`),
 *      after which prose is sent as written rather than becoming silence. A second message
 *      to the same person is refused (`spoke`) and every other verb stays reachable.
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

/**
 * What the desk was TOLD and what it THOUGHT, as raw material for the one recorder.
 *
 * Handed back rather than written here, and that is the whole point of the shape. The
 * tenant loop owns `evidence`, `CONTEXT_MARKER`, `TRACE_MARKER` and the caps; this
 * module cannot import any of them, because `lib/agent/loop.ts` value-imports
 * `runFrontDeskTurn` and a value import back would close a cycle this repo has already
 * paid for once (see the note on the `ToolTrace` import above). So the desk produces
 * plain data and `runTurn` renders it into trace rows with the same author, the same
 * markers and the same caps as a tenant turn — rather than a second copy of all three,
 * which is exactly the "two authors of one truth" trap and exactly how this went
 * missing.
 */
export type FrontDeskRecord = {
  /** The variable half of the prompt — the only part that differs between desk turns. */
  tail: string
  /** The stable half by size only: it is byte-identical for every stranger forever. */
  prefixChars: number
  /** What they said, as the model was shown it. */
  said: string
  /** How many earlier messages of this thread were in front of it. */
  historyCount: number
  /** One entry per `generate()` call — the model's own round, uncapped at this layer. */
  rounds: {
    round: number
    ms: number
    prose: string
    reasoning?: string
    promptTokens: number
    cachedTokens: number
    outputTokens: number
    calls: string[]
    finish?: string
  }[]
}

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
  /** @see FrontDeskRecord — the inside of the turn, for `runTurn` to record. */
  record: FrontDeskRecord
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
    // Present from the first line, so a desk turn that returns early — no message to
    // answer, a hand-over on round one, a `generate` that threw — still records the
    // shape of itself rather than nothing.
    record: { tail: '', prefixChars: 0, said: o.text ?? '', historyCount: 0, rounds: [] },
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
    businesses,
    atIso: at.toISOString(),
  })

  const system = [FRONT_DESK_PREFIX, FRONT_DESK_BOUNDARY, tail].join('\n\n')

  // The tail whole, the stable half by size. `FRONT_DESK_PREFIX` is byte-identical for
  // every stranger on every number forever — that property IS the cache — so storing it
  // per turn would bury the only part that varies. Same trade the tenant `(context)` row
  // makes with the prefix fingerprint.
  run.record.tail = tail
  run.record.prefixChars = system.length - tail.length

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
  run.record.historyCount = Math.max(0, messages.length - (o.text ? 1 : 0))
  if (messages.length === 0) {
    // Nothing to answer. The caller does not route a media-only or empty inbound here,
    // but a turn with no message is a turn with nothing to say, and saying something
    // anyway is how a greeting reaches somebody who greeted nobody.
    return run
  }

  const tools = frontDeskToolDecls()
  let proseChecked = false
  /**
   * Whether the desk has already been told, this turn, that prose is not how it speaks.
   * One round of grace and never a second — see `deskSpeaksThroughReply`.
   */
  let proseRefused = false
  /** Whether a message has already reached this person this turn — see the `reply` case. */
  let spoke = false

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

    /**
     * The model's own round, recorded before anything is decided about it.
     *
     * Every desk round in the thirty-day drive was invisible: 16 turns ran the model
     * and 0 carried a `(model)` row, so the largest single deliberation the desk
     * produced — 3,027 output tokens on `d4-08:30-farah-sheikh`, five times any other
     * desk turn — survives only as the 62 words it sent. Written HERE, at the top of
     * the round, so a round that goes on to break out, hand over or throw is still
     * recorded: the tenant loop's rule is that the record is written whatever happened,
     * and a desk turn is a turn.
     */
    run.record.rounds.push({
      round,
      ms: gen.ms,
      prose: (gen.text ?? '').trim(),
      ...(typeof gen.assistant?.reasoning_content === 'string' && gen.assistant.reasoning_content.trim()
        ? { reasoning: gen.assistant.reasoning_content }
        : {}),
      promptTokens: gen.usage.promptTokens,
      cachedTokens: gen.usage.cachedTokens,
      outputTokens: gen.usage.outputTokens,
      calls: gen.functionCalls.map((c) => c.name),
      ...(gen.finishReason ? { finish: gen.finishReason } : {}),
    })

    messages.push(gen.assistant)

    /**
     * A round that calls nothing is the desk speaking — and speaking this way costs
     * the person the only affordance this conversation has.
     *
     * Two paths reach a visitor's phone from here and they are not equivalent. `reply`
     * carries up to three buttons whose `answer` replays as if typed; this path carries
     * a string and there is nowhere in it to put one. The prefix called the prose path
     * "the only way you speak", the `reply` declaration says "use this rather than plain
     * prose whenever a tap would save them typing — which is almost always for the one
     * question you are here to ask", and the model believed the prefix. Measured on
     * `2026-08-22-12-25-sim-bqc0`, every desk message in three days went out through
     * here: four messages reached a seat and NONE carried a button, while
     * `d1-08:30-rahul-menon`'s own reasoning reads *"Let me ask with buttons."* and its
     * round recorded `calls: []`. The desk asks one question with exactly two answers.
     * That is the single most tappable moment in the product and it was being typed.
     *
     * @mechanism proseRefused — trailing prose at the desk is not a send. The
     *   round is spent telling the model that nothing reached them and that `reply` is how
     *   the desk speaks, which is the same round-of-grace shape `violationsAtDesk` above
     *   already uses — a refusal that buys a round rather than a runtime edit. It fires at
     *   most ONCE (`proseRefused`), and prose on the second attempt is sent as written,
     *   because a desk that answers a stranger with silence is strictly worse than one that
     *   answers without a button: this is the one conversation in the product where nobody
     *   has any relationship to fall back on. The prefix sentence that taught the habit is
     *   corrected beside this in `FRONT_DESK_PREFIX`, and `check:layout` cannot catch a
     *   prompt contradicting a tool declaration, which is why the enforcement is here and
     *   not there. It never spends the LAST round (`round < MAX_ROUNDS`): a refusal there
     *   has no round left to be answered in, and would trade a message without a button for
     *   no message at all — which is the one outcome a stranger cannot tell apart from
     *   being ignored.
     *   Closes F-DJ.
     */
    if (gen.functionCalls.length === 0) {
      const body = (gen.text ?? '').trim()
      if (!body) {
        run.error = 'front desk produced neither a tool call nor anything to say'
        break
      }
      if (!proseRefused && round < MAX_ROUNDS) {
        proseRefused = true
        run.record.rounds.push({
          round,
          ms: 0,
          prose: '',
          calls: ['(prose refused: the desk speaks through reply, so a button is possible)'],
          promptTokens: 0,
          cachedTokens: 0,
          outputTokens: 0,
        })
        messages.push({
          role: 'user',
          content:
            '[That reached nobody. Prose is a note to yourself here — `reply` is how this desk speaks, and it ' +
            'is the only thing that can carry a button. Send the same message through `reply`, and put the ' +
            'answers on buttons: the person is on a phone with one hand, and a question they have to type ' +
            'the answer to is a question many of them will not answer at all.]',
        })
        continue
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
          args: String(call.raw ?? ''), result: `parse error: ${call.parseError}`,
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
        if (spoke) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              'not sent — they have already had a message from you this turn, and a second one arrives as ' +
              'the first being withdrawn. Everything else is still open to you: hand them over, or call ' +
              'nothing and let them answer.',
          })
          run.trace.push({ round, name: 'reply', ms: 0, args: parsed.data, result: 'refused: already spoke this turn' })
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
          args: parsed.data, result: outcome.status,
        })
        /**
         * One message per person per turn — and the turn goes ON.
         *
         * While prose was the only route out of this loop it `break`s, so nothing here
         * ever ran twice and the missing guard was invisible. The moment `proseRefused`
         * sent the desk through `reply` instead, it showed up in one drive: on
         * `2026-08-22-12-47-sim-s4hg` three of nine desk turns sent the SAME question
         * twice, and the second was caused by the refusal itself — the model replied,
         * correctly wrote "I'll wait for their answer." on the next round, and was told
         * that prose reaches nobody, so it obeyed and asked again.
         *
         * The first fix returned from the whole turn on a landed reply. That killed the
         * double-send and took a capability with it: the desk could no longer say "yes,
         * that's the one — handing you over" and then hand over, so a turn could end with
         * a message sent and the visitor still standing at the desk. Unobserved across
         * four runs, and still the wrong shape — a defect in the SEND channel is not a
         * reason to end the turn.
         *
         * So it is the tenant loop's guard instead, which is where this belongs and what
         * `repliedTo` has always been: refuse the SECOND message to this person, leave
         * every other verb reachable. `runFrontDeskTool` still returns from the turn on a
         * hand-over, exactly as before, so "call the tool and stop" is unchanged.
         */
        spoke = true
        continue
      }

      const result = await runFrontDeskTool(o.identity, arrival, call.name, call.args, o.text)
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.content })
      run.trace.push({
        round, name: call.name, ms: Date.now() - startedMs,
        args: call.args ?? {}, result: result.content,
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

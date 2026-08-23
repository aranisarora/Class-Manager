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
 *      button, so the prefix says so; a round that calls no tool sends its prose as written.
 *      A second message to the same person is refused (`spoke`) and every other verb stays
 *      reachable.
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
 *
 * @mechanism violationsAtDesk — the mask list is read at VALIDATION time, never reused
 *   from the turn's start, because the name a draft most needs masked is the business
 *   founded seconds ago — by the other person in a founding race, or by this turn's own
 *   `start_business` collision. On the 23 Aug ace-tennis month the desk composed exactly
 *   the right repair — "There's already a business called Rahul's Academy — is that
 *   yours?" — 2.4 seconds after that business was founded from the coach's phone; the
 *   turn-start list predated it, the "academy" ban fired on the business's own name
 *   twice, the turn shipped nothing, and the owner seat stayed with the coach for the
 *   whole run. A read that cannot complete masks nothing rather than blocking the send.
 *   Closes F-EQ.
 */
async function violationsAtDesk(body: string, identity: Identity): Promise<string[]> {
  let names: string[] = []
  try {
    names = (await businessesOnThisNumber(identity)).map((b) => String(b.name ?? ''))
  } catch {
    names = []
  }
  let masked = body
  for (const name of names) {
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
     * A round that calls nothing is the desk speaking, and what it says goes out as written.
     *
     * It carries no buttons, and for one afternoon this path REFUSED prose for that reason
     * and spent a round telling the model to use `reply` instead. That refusal fired ZERO
     * times across four subsequent runs while 60 buttons were minted, because the thing
     * that had actually been wrong was the prefix: it said prose was "the only way you
     * speak" while the `reply` declaration said to use `reply` instead, and the model
     * believed the prefix. Correcting the sentence fixed it completely; the refusal on top
     * was machinery for a defect that no longer existed, and it caused a double-send of its
     * own before it was removed.
     *
     * The lesson is worth more than the code: an information failure looks exactly like a
     * control failure from here, and the cheap test is to fix the information first and
     * measure whether the gate ever fires.
     */
    if (gen.functionCalls.length === 0) {
      const body = (gen.text ?? '').trim()
      if (!body) {
        /**
         * Nothing to say and nothing to call is how a desk turn ENDS, once it has spoken.
         *
         * The model answers, and the round after it correctly decides there is nothing left
         * to do — "I've sent the question. Now I wait for their response." — and puts that
         * in `reasoning_content`, where it belongs, leaving `text` empty. Recorded as an
         * error, that is a turn which sent a good message and reads in the record as a
         * failure. Two of the 205 turns of `2026-08-22-15-21-sim-ceeg` were flagged this
         * way, both of them successful (`sent: 1`), and an error is the first thing a judge
         * and a reader look at.
         *
         * It is only a failure when nobody was answered, which is the same test `spoke()`
         * makes on the tenant side: silence with something owed.
         */
        if (!spoke) run.error = 'front desk produced neither a tool call nor anything to say'
        break
      }
      const bad = proseChecked ? [] : await violationsAtDesk(body, o.identity)
      if (bad.length) {
        // One round of grace, while the author can still fix it — never a rewrite.
        proseChecked = true
        messages.push({
          role: 'user',
          content: `That message cannot go as written: ${bad.join('; ')} Rewrite just that part and send it again.`,
        })
        continue
      }
      /**
       * The escape valve is a SEND, so it obeys the one-message rule like every other send.
       *
       * It did not, and that was a regression against HEAD rather than a fix: on
       * 2026-08-22-12-47-sim-s4hg turn 0013 the model called `reply` in round 2 (sent), then
       * wrote "I'll wait for your business name and get you set up." in round 3 — prose, no
       * tool, straight down this path and onto the phone as a second message. `spoke` caught
       * three of that run's five double-sends and this path leaked the other two.
       */
      if (spoke) {
        run.trace.push({
          round,
          name: '(trailing prose discarded: they have already had a message this turn)',
          ms: 0,
          args: body,
        })
        break
      }
      run.replyText = body
      run.outcomes.push(await sendFromDesk(o.session, o.identity, body))
      spoke = true
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
          /**
           * The real error, and a trace row, because this is where a desk turn goes silent.
           *
           * "reply needs a body." was a guess at the failure and usually the wrong one:
           * `ReplyArgs` also requires `answer` on every button (lib/frontdesk/tools.ts), which
           * is the field a model reaching for a tap forgets. The model was told to add a body
           * it had already written, so it sent the same shape again and the turn ended having
           * said nothing — with no trace row, `messages: []` and `error: null`, so the record
           * showed a turn that simply did not speak.
           *
           * Realised once in 46 post-change desk turns and it was the worst possible one:
           * 2026-08-22-13-20-sim-67ai turn 0021, Arjun handing over his timetable —
           * "rahul evening bath mon n thu 6-7" — answered with silence.
           */
          const why = parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || 'reply'}: ${i.message}`)
            .join('; ')
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              `that reply was not sent — ${why}. Every button needs BOTH a title and an answer, and the ` +
              'answer is the words tapping it says in their voice. Fix that field and send it again.',
          })
          run.trace.push({ round, name: 'reply', ms: 0, args: call.args ?? {}, result: `refused: ${why}` })
          continue
        }
        if (spoke) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content:
              'not sent — they have already had a message from you this turn, and a second one arrives as ' +
              'the first being withdrawn. Hand them over if you know where they belong; otherwise this turn ' +
              'is finished and it is their move. Do not write anything further: trailing text is a note to ' +
              'yourself here and nothing you add now reaches them.',
          })
          run.trace.push({ round, name: 'reply', ms: 0, args: parsed.data, result: 'refused: already spoke this turn' })
          continue
        }
        const bad = proseChecked ? [] : await violationsAtDesk(parsed.data.body, o.identity)
        if (bad.length) {
          proseChecked = true
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: `that message cannot go as written: ${bad.join('; ')} Rewrite just that part and send it again.`,
          })
          // Traced for the same reason as the parse failure above: a refusal nobody records is
          // a turn that reads as having chosen to say nothing.
          run.trace.push({ round, name: 'reply', ms: 0, args: parsed.data, result: `refused: ${bad.join('; ')}` })
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
         * ever ran twice and the missing guard was invisible. The moment the desk started
         * calling `reply`, it showed up in one drive: on
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

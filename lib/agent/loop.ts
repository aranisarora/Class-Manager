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
import { now, inZone } from '@/lib/clock'
import { newId } from '@/lib/ids'
import { env } from '@/lib/env'
import { admins as adminRecipients, resolveIdentity } from '@/lib/identity'
import { consumeAction, type ActionPayload } from '@/lib/actions'
import { composeAndSend } from '@/lib/messaging/compose'
import { LIMITS, type SendOutcome } from '@/lib/messaging/types'
import {
  ADD_CLASS,
  BUSINESS_SETUP,
  formFor,
  FORM_INTRO,
  parseFlowResponse,
  REGISTER,
  type AddClassValues,
  type BusinessSetupValues,
  type FormId,
  type RegisterValues,
} from '@/lib/messaging/flows'
import { buildSetupSteps, summariseSetup } from '@/lib/setup-plan'
import type { Identity, Job, Role } from '@/lib/types'
import { generate, generateJson, type Msg } from './deepseek'
import { lint, mixInstruction, stablePrefix, synthesisDoctrine, variableTail } from './context'
import { hotSet } from './memory'
import { audienceFor, executePlan, type PlanStep } from './plan'
import { jsonLit, lit, uid, type OperationName } from './operations'
import {
  checkClaims,
  closingQuestionButtons,
  extractBracketButtons,
  FOLLOW_UPS,
  pendingConfirmation,
  pendingReadBack,
  runTool,
  toolDecls,
  withFollowUps,
  backstopButtons,
  type ToolCtx,
} from './tools'

export type TurnInput = {
  contactId: string
  text?: string
  media?: { url: string; mimeType: string }[]
  actionId?: string
  /**
   * The answers from a completed WhatsApp Flow, with `actionId` carrying its
   * `flow_token`. Present only on a Flow submission, which is a tap that arrives
   * with data — so it consumes its action exactly like any other tap.
   */
  flowData?: Record<string, unknown>
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

function sessionOf(identity: Identity, turnId?: string): SessionCtx {
  return {
    role: 'user',
    academyId: identity.academyId,
    personId: identity.person.id,
    contactId: identity.contact.id,
    // Carried into the session so `app.begin_audit` can stamp it on every row this
    // turn writes (0015). Attribution by construction rather than by remembering.
    ...(turnId ? { turnId } : {}),
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
        const res = await executeAction(session, identity, consumed.payload, turnId, input.flowData)
        outcomes.push(...res.outcomes)
        replyText = res.summary
        trace.push({
          round: 0,
          name: `tap:${consumed.payload.kind}`,
          ms: Date.now() - tappedAt,
          args: traceValue(consumed.payload, 4000),
          result: traceValue({ summary: res.summary, sent: res.outcomes.map((o) => o.status) }, 2000),
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
        args: traceValue(input.media.map((m) => m.mimeType), 500),
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

    if (goToModel && (text || input.task)) {
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

  // §5 — "the bot writes facts asynchronously after a turn, never blocking a reply."
  // This runs after everything has been sent, so nobody is waiting on it.
  if (!error) {
    const reflected = await reflect(session, identity, turnId, {
      said: input.text ?? (input.actionId ? '(tapped a button)' : ''),
      replied: replyText,
      trace,
    }).catch(() => null)
    if (reflected?.length) trace.push(...reflected)
  }

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
  flowData?: Record<string, unknown>,
): Promise<{ outcomes: SendOutcome[]; summary: string }> {
  const outcomes: SendOutcome[] = []

  /**
   * A completed WhatsApp Flow.
   *
   * What a submission DOES is decided here, by flow id, and never carried in the
   * action payload — so a form can only ever reach work the runtime chose to put
   * behind it, the same way `write.service` and `requireRows` are runtime-only
   * fields. The answers themselves are untrusted input: they are parsed by the
   * flow's own schema and then run as a plan under the submitter's own RLS
   * session, which is what makes a Flow no more privileged than a typed sentence.
   */
  if (payload.kind === 'flow') {
    const parsed = parseFlowResponse(payload.flow, flowData ?? {})
    if (!parsed.ok) {
      outcomes.push(
        await composeAndSend(session, {
          toContactId: identity.contact.id,
          body: `That form didn't come through cleanly — ${parsed.error}. Tell me the details here instead and I'll set it up.`,
        }),
      )
      return { outcomes, summary: `flow ${payload.flow} rejected: ${parsed.error}` }
    }

    if (payload.flow === BUSINESS_SETUP.id) {
      const v = parsed.values as BusinessSetupValues
      // The same builder every other setup path runs. A form is a different way to
      // reach the setup plan, never a second implementation of it.
      const venues = v.venue ? [{ name: v.venue, address: v.address || null }] : []
      const setup = {
        name: v.name,
        category: v.category || null,
        timezone: v.timezone || null,
        cancellationWindowHours: v.cancellation_window_hours,
        // Three answers, not two. "Don't send one" is `null` and clears the column;
        // a time is itself; a blank field is `undefined` and leaves what is there.
        // Collapsing the last two would mean an owner who edited their UPI handle
        // silently lost the brief they had already set.
        morningBriefAt: v.morning_brief_at === 'off' ? null : v.morning_brief_at || undefined,
        eveningDigestAt: v.evening_digest_at === 'off' ? null : v.evening_digest_at || undefined,
        upiHandle: v.upi_handle || null,
        venues,
      }
      const steps = buildSetupSteps(identity.academyId, setup)
      /**
       * The default charging basis rides in `settings`, not on a column of its own.
       *
       * It is not a property of the business the way its timezone is — it is what to
       * assume when a class arrives with no price on it, which is every class read off
       * a photo. Putting it here keeps `class.rate_unit` the only place a real rate
       * lives, so nothing downstream can mistake a default for a decision.
       */
      if (v.rate_unit) {
        steps.push({
          write: `update academy set settings = coalesce(settings, '{}'::jsonb)
                    || jsonb_build_object('default_rate_unit', ${lit(v.rate_unit)})
                  where id = ${uid(identity.academyId)}`,
        })
      }
      const res = await executePlan(session, steps, 'Business set up from the form', audienceFor(identity))
      if (!res.ok) {
        outcomes.push(
          await composeAndSend(session, {
            toContactId: identity.contact.id,
            body: /PRECONDITION_FAILED|CHANGED_NOTHING/.test(res.error ?? '')
              ? 'Only the owner can change the business settings, so I left everything as it was.'
              : `That didn't save: ${res.error ?? 'something went wrong'}. Nothing was changed.`,
          }),
        )
        return { outcomes, summary: `form ${payload.flow} failed: ${res.error ?? 'unknown'}` }
      }

      const summary = summariseSetup(setup)
      /**
       * Straight into the timetable, naming the way it can arrive.
       *
       * This is the one message in the product where saying what is possible is worth
       * more than saying what happened: what people expect is one form per class, and
       * `onboarding.md` calls the timetable the biggest single saving here. A person
       * who does not know they can type the whole week in one messy sentence fills in
       * four forms by hand, or stops.
       *
       * It used to offer a photo of the whiteboard and a voice note. The model is
       * text-only now (`deepseek.ts`), so that would be an invitation to send
       * something that comes back apologised for — the worst possible first
       * impression, caused by the message meant to save them the most work.
       */
      outcomes.push(
        await composeAndSend(session, {
          toContactId: identity.contact.id,
          preLaunchOk: true,
          body:
            `${summary}\n\n`
            + 'Now the part that usually takes an hour — your timetable. '
            + 'Type the whole week in one go, however messy: "Mon & Wed 6:30 beginners at Green Park, '
            + 'Sat 8am juniors". I\'ll read it back before I create anything.',
          buttons: [
            // 19 chars. "Add classes one by one" is 22, and `fitTitle` cut it at the word
            // boundary to "Add classes one by" — a dangling preposition that shipped.
            { title: 'Add them one by one', action: { kind: 'form', form: 'add_class' } },
          ],
        }),
      )
      return { outcomes, summary }
    }

    /**
     * A class, from the form.
     *
     * Committed rather than previewed, because this is the one write in the product
     * whose read-back the person has literally just done: the form showed them every
     * field and they pressed Add. A confirmation step on top of that is asking the same
     * question twice, which `bulk-change.md` names as pure friction on a single row in
     * your own scope.
     */
    if (payload.flow === ADD_CLASS.id) {
      const v = parsed.values as AddClassValues
      /**
       * The venue arrives as a NAME, because that is what a person picks from a list,
       * and `create_class` takes an id. Resolved here rather than passed through: zod
       * strips an unknown key silently, so a `venue_name` handed to the operation would
       * have produced a class at no venue at all — and the first anybody would know is a
       * parent asking where to go.
       */
      let venueId: string | null = null
      if (v.venue) {
        const hit = await modelQuery(session, `select id from venue where name = ${lit(v.venue)} limit 1`)
        venueId = hit.error ? null : ((hit.rows[0]?.id as string) ?? null)
      }
      const res = await executePlan(
        session,
        [
          {
            operation: {
              name: 'create_class' as OperationName,
              args: {
                name: v.name,
                starts_on: inZone(await now(identity.academyId), identity.academy.timezone || 'Asia/Kolkata').date,
                slots: v.days.map((d) => ({ weekday: d, start_time: v.starts, end_time: v.ends })),
                ...(venueId ? { venue_id: venueId } : {}),
                ...(v.rate !== undefined ? { rate_amount: v.rate } : {}),
                ...(v.rate_unit ? { rate_unit: v.rate_unit } : {}),
              },
            },
          } as PlanStep,
        ],
        `Add ${v.name} from the form`,
        audienceFor(identity),
      )
      outcomes.push(...res.outcomes)
      const failed = res.ok ? null : (res.error ?? 'something went wrong')
      outcomes.push(
        await composeAndSend(session, {
          toContactId: identity.contact.id,
          preLaunchOk: true,
          body: failed
            ? `I couldn't add that class — ${failed}. Nothing was changed; tell me here and I'll sort it.`
            : `${v.name} is in. Another one, or is that the week?`,
          buttons: failed
            ? undefined
            : [
                { title: 'Add another', action: { kind: 'form', form: 'add_class' } },
                { title: "That's the week", action: { kind: 'reply', text: "that's my whole timetable" } },
              ],
        }),
      )
      return { outcomes, summary: failed ? `add_class failed: ${failed}` : `class ${v.name} created` }
    }

    /**
     * The register, inverted: the form named the exceptions, so everyone else is present.
     *
     * The roster is re-read HERE rather than trusted from the submission, because the
     * submission carries only who was ticked. Deriving "present" from what was NOT
     * ticked against a roster the runtime reads itself is the difference between a
     * register and a list of names a form happened to send back.
     */
    if (payload.flow === REGISTER.id) {
      const v = parsed.values as RegisterValues
      const roster = await modelQuery(
        session,
        `select player_id from app.session_roster where session_id = ${uid(v.session_id)}`,
      )
      if (roster.error || !roster.rows.length) {
        outcomes.push(
          await composeAndSend(session, {
            toContactId: identity.contact.id,
            body: "I couldn't read that roster, so I haven't marked anything. Tell me who missed it and I'll do it here.",
          }),
        )
        return { outcomes, summary: 'register: roster unreadable' }
      }
      const absent = new Set(v.absent)
      const late = new Set(v.late)
      const entries = (roster.rows as { player_id: string }[]).map((r) => {
        const id = String(r.player_id)
        return {
          player_id: id,
          // Ticked in both boxes means they turned up late, which is the reading that
          // does not lose the session: `absent` bills without coaching, `late` does both.
          status: late.has(id) ? 'late' : absent.has(id) ? 'absent' : 'present',
          ...(v.note && !absent.has(id) ? { note: v.note } : {}),
        }
      })
      const res = await executePlan(
        session,
        [
          {
            operation: {
              name: 'mark_attendance' as OperationName,
              args: { session_id: v.session_id, entries },
            },
          } as PlanStep,
        ],
        'Register, from the form',
        audienceFor(identity),
      )
      outcomes.push(...res.outcomes)
      const failed = res.ok ? null : (res.error ?? 'something went wrong')
      if (failed) {
        outcomes.push(
          await composeAndSend(session, {
            toContactId: identity.contact.id,
            body: `That register didn't save — ${failed}. Nothing was marked.`,
          }),
        )
        return { outcomes, summary: `register failed: ${failed}` }
      }
      const inCount = entries.filter((e) => e.status !== 'absent').length
      /**
       * The money question, asked at the register rather than discovered on the bill.
       *
       * An absence with no cancellation on record is the single most common true
       * billing dispute in this product (`money-dispute.md`), and it is always
       * discovered a month later, by a parent, in an argument. The coach knows the
       * answer right now — somebody told them at the court — and the answer is one tap.
       * Asking here turns next month's dispute into tonight's correction.
       */
      const unexplained = entries.filter((e) => e.status === 'absent')
      outcomes.push(
        await composeAndSend(session, {
          toContactId: identity.contact.id,
          body:
            `Marked — ${inCount} in, ${unexplained.length} out.`
            + (unexplained.length
              ? `\n\nOne thing before I bill it: ${unexplained.length === 1 ? 'that absence has' : 'those absences have'} `
                + 'no cancellation on record. Did anyone tell you in advance?'
              : ''),
          buttons: unexplained.length
            ? [
                {
                  title: 'Told in advance',
                  action: {
                    kind: 'operation' as const,
                    op: 'mark_attendance' as OperationName,
                    args: {
                      session_id: v.session_id,
                      retro_timely_player_ids: unexplained.map((e) => e.player_id),
                    },
                  },
                },
                { title: 'No, just no-shows', action: { kind: 'noop', ack: 'Noted — charged as absent.' } },
              ]
            : undefined,
        }),
      )
      return { outcomes, summary: `register marked: ${inCount} in, ${unexplained.length} out` }
    }

    // Deliberately loud rather than silent if a form is ever added without a consumer —
    // which is the exact shape that produced the recipe feature.
    return { outcomes, summary: `form ${payload.flow} has no handler` }
  }

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

  /**
   * A button that sends a form.
   *
   * Prefilled at TAP time, not at mint time, which is the whole reason this is an
   * action rather than a Flow attached to the original message. `[Set up my classes]`
   * tapped tomorrow opens a form showing what is true tomorrow, and `[Take register]`
   * tapped after the class opens tonight's roster rather than the one that existed
   * when the reminder was composed.
   *
   * The body says what the form is and, always, that they can say the same thing here
   * instead. A form is an offer and never a toll (doctrine rule 4), and the one place
   * that rule is most easily broken is the runtime's own copy, which no model reviews.
   */
  if (payload.kind === 'form') {
    const built = await formFor(session, identity, payload.form as FormId, {
      toContactId: identity.contact.id,
      sessionId: payload.sessionId,
      prefill: payload.prefill,
    })
    if ('error' in built) {
      outcomes.push(
        await composeAndSend(session, {
          toContactId: identity.contact.id,
          body: `I couldn't open that form — ${built.error}. Tell me here instead and I'll do it the same way.`,
        }),
      )
      return { outcomes, summary: `form ${payload.form} refused: ${built.error}` }
    }
    outcomes.push(
      await composeAndSend(session, {
        toContactId: identity.contact.id,
        preLaunchOk: true,
        body: FORM_INTRO[payload.form as FormId] ?? 'Here it is.',
        flow: built,
      }),
    )
    return { outcomes, summary: `form ${payload.form}` }
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

  // If the plan already spoke to this person, adding an ack on top is noise.
  const alreadyTold = res.stagedMessages.some((m) => m.toContactId === identity.contact.id)
  if (!alreadyTold) {
    const follow =
      payload.kind === 'operation'
        ? (FOLLOW_UPS[payload.op as OperationName]?.(
            payload.args,
            res.diffs.map((d) => ({ table: d.table, op: d.op, after: d.after })),
          ) ?? [])
        : []
    outcomes.push(
      await composeAndSend(session, {
        toContactId: identity.contact.id,
        // Runtime-composed, but it still lands on a phone: the receipt is built from
        // table names and operation notes, and both leak — "2 persons", "(§2.6)".
        // Everything user-facing goes through the same lint, whoever wrote it.
        body: lint(res.summary, identity),
        buttons: follow.length ? follow.slice(0, LIMITS.buttons) : backstopButtons(identity, res.summary),
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
    const memory = (await hotSet('person', identity.person.id, identity.academyId)) ?? ''
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
 */
export type ToolTrace = {
  round: number
  name: string
  ms: number
  args?: unknown
  result?: unknown
  error?: string
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
    saidToUser: [],
  }

  const [clock, lookups] = await Promise.all([
    // The tenant's clock, not the world's. This line is the model's entire sense of
    // "now" — driven with a moved tenant clock, the bare call told a coach
    // "It is Saturday, 10:52am" on his Wednesday, and every watch the turn
    // scheduled landed in the past (conversation-rules.md F-A).
    now(identity.academyId).then((at) => inZone(at, identity.academy.timezone)),
    recentLookups(identity),
  ])
  const tail = await variableTail(identity, {
    clockNote: `It is ${clock.label} (${clock.date} ${clock.time}) in ${identity.academy.timezone}.`,
    taskInstruction: input.task?.instruction,
    queryResults: input.task?.queryResults,
    recentLookups: lookups,
  })

  const situation: string[] = [tail]
  if (input.source === 'job' && input.task) {
    situation.push(
      'This is a task you scheduled for yourself. Deciding to do nothing is the common and correct outcome — ' +
        'only send something if this person would have asked for it.',
    )
  }

  const history = await recentHistory(session, identity)
  // Text only, and the attachment has already been answered by the runtime
  // (`mediaRefusal`) before this call is made. There is no media part on this
  // wire to carry it with: the request schema rejects one outright.
  const messages: Msg[] = [
    ...history,
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
   * Whether anything actually reached this person's phone.
   *
   * This used to be "did the model call `reply`", set before the call was even
   * run — so a `reply` the runtime *refused* still counted as having spoken, and
   * every guard below stood down. Watched live: one bad button took the message
   * with it, and the turn ended having sent nothing at all. Going quiet is the
   * one failure a person cannot tell apart from being ignored, and it was being
   * caused by the check that exists to prevent it.
   *
   * The honest question is not what the model tried. It is what arrived.
   */
  const spoke = (): boolean => outcomes.some((o) => o.status === 'sent' || o.status === 'queued')
  const trace: ToolTrace[] = []
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
    text = res.text ?? ''

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
      args: text.trim()
        ? traceValue(text, 4000)
        : { returnedNothing: true, message: traceValue(res.assistant, 2000) },
      result: {
        in: res.usage.promptTokens,
        cached: res.usage.cachedTokens,
        out: res.usage.outputTokens,
        calls: res.functionCalls.map((f) => f.name),
        finish: res.finishReason ?? 'unknown',
      },
      error:
        !res.functionCalls.length && !text.trim()
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
          args: { malformed: true, raw: traceValue(call.raw ?? '', 2000) },
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
          args: traceValue(call.args, 500),
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
        args: traceValue(call.args, 4000),
        result: traceValue(out.result, 4000),
        ...(threw ? { error: threw.slice(0, 2000) } : {}),
      })
      responses.push({ role: 'tool', tool_call_id: call.id, content: toolContent(out.result) })
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
              'No tools left to call. If the results do not answer it, say so plainly (§4.1 rule 10).\n\n' +
              'You have no tools in this round, so nothing you describe can happen. Do not say what ' +
              'you are about to do, are going to do, or will now set up — this is the last thing sent, ' +
              'and a promise here is a promise nothing keeps. State what you found, or say plainly ' +
              'that you have not done it yet and ask for the one thing you need to.',
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
        args: text.trim() ? traceValue(text, 4000) : { returnedNothing: true, recovery: true },
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
        : "Something broke on my side working that out — it isn't you, and repeating it won't help. I've flagged it."
  }

  /**
   * A job turn that wants to speak has the tools. On the interactive path a person is
   * staring at the chat, so trailing prose is a safety net; on `source: 'job'` there is
   * no one waiting, silence is the expected outcome (§13.1), and this same net delivered
   * the model's deliberation — "I will stay quiet until Wednesday", watch bookkeeping,
   * "no follow-up is needed" — as real messages (conversation-rules.md F-B). Discarded,
   * with a trace entry so a drive can still see what the model was thinking.
   */
  if (text.trim() && !spoke() && input.source === 'job') {
    trace.push({ round: rounds, name: '(job turn: trailing prose discarded, tools are how a job speaks)', ms: 0, args: traceValue(text, 2000) })
    text = ''
  }

  if (text.trim() && !spoke()) {
    // §4.3 — "after every action the bot takes, it offers the natural next step as
    // a button". A plan that was previewed and not committed has exactly one natural
    // next step, and the runtime knows it: the steps are already validated and
    // diff-computed, so the button carries them verbatim (§2.2). Leaving this to the
    // model means a confirmation sometimes arrives as prose with nothing to tap,
    // which is how the preview→commit path quietly stops being button-driven.
    // Buttons typed into the prose — the recovery round has no tools, so this is
    // where they land most — become real ones.
    const pulled = extractBracketButtons(text.trim())
    if (pulled.buttons.length && pulled.text) text = pulled.text

    // Every plan still waiting on a yes, not just the newest — a read-back that
    // names two changes has to commit two changes.
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
    } else {
      // Same door as the `reply` tool mints (§5): no plan to confirm still means
      // something to offer, and a bare paragraph is where discovery goes to die.
      // A closing yes-or-no question gets an answer to tap instead of the menu,
      // which after a question is a non-sequitur.
      buttons =
        (pulled.buttons.length ? (pulled.buttons as { title: string; action: ActionPayload }[]) : null) ??
        (closingQuestionButtons(text.trim()) as { title: string; action: ActionPayload }[] | null) ??
        backstopButtons(identity, text.trim())
    }
    // Whichever path the message leaves by, §4.3 holds.
    buttons = withFollowUps(buttons, toolCtx) as { title: string; action: ActionPayload }[] | undefined

    /**
     * The honesty guard, on the other path a message can leave a turn by.
     *
     * `unbackedClaim` lived only in the `reply` tool, so the product's one structural
     * check on "did it actually do what it said" covered the path where the model
     * calls a tool to speak, and not the path where it simply stops talking. Driven,
     * on a coach marking her first register: she typed *"everyone was there today"*,
     * the model previewed the attendance plan, produced no `reply` call at all, and
     * the trailing prose went out saying
     *
     *     "I've marked Aditya and Ananya as present for today's 6:30pm session."
     *
     * Zero attendance rows. Session still `scheduled`. Zero tally lines. The register
     * is the meter the whole money half runs on, and the one person who could have
     * noticed had just been told it was done.
     *
     * There is no round left here to ask for a rewrite, which is the difference from
     * the `reply` path — so the runtime substitutes its own sentence rather than
     * performing surgery on the model's tense. It is entitled to: when a plan is
     * pending it holds the true read-back already, computed from the diff, and that
     * is strictly better evidence than the prose it replaces.
     *
     * **Only when a plan is pending**, and this path needs that guard more than the
     * `reply` one does because it has no round of grace at all — there is nothing left
     * to ask. `committed` is turn-scoped and a past-tense sentence is not, so a turn
     * that reads rows and truthfully reports earlier work is indistinguishable from one
     * that invents a receipt. Scheduled `agent_task` check-backs are exactly that shape
     * by construction — read-only, and about work done in some previous turn — and
     * substituting there tells somebody the rows do not exist when they do. A pending
     * plan is the runtime's evidence that the sentence is about THIS turn.
     */
    // The same judgement the `reply` tool makes, from the same function. A
    // guarantee enforced where the model happens to call `reply` and not where
    // the loop emits its own trailing prose is not a guarantee — which path a
    // turn takes is the model's choice (R4), and this is the path that shipped
    // "I've marked Aditya and Ananya as present" over zero attendance rows.
    //
    // What is different here is that there is no round of grace: nothing left to
    // ask, so the runtime substitutes rather than refusing — and only when a plan
    // is pending, which is its evidence that the sentence is about THIS turn.
    if (pending && checkClaims(text.trim(), toolCtx).unbacked) {
      text = pendingReadBack(pending.summary)
    }

    const trailingBody = lint(text.trim(), identity)
    const trailing = await composeAndSend(session, {
      toContactId: identity.contact.id,
      body: trailingBody,
      buttons,
    })
    outcomes.push(trailing)
    // Recorded on the same condition as every other send: it counts as having been
    // said when it landed. A suppressed trailing message is a turn that said nothing,
    // and reflection should see that rather than a reply nobody received.
    if (trailing.status === 'sent' || trailing.status === 'queued') {
      toolCtx.saidToUser?.push(trailingBody)
    }
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
        (c) => `[you called ${c.function.name} with ${traceValue(c.function.arguments ?? '{}', 1500)}]`,
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

async function recentHistory(session: SessionCtx, identity: Identity): Promise<Msg[]> {
  try {
    const rows = await withSession({ role: 'service', academyId: identity.academyId }, async (tx) => {
      return (await tx.unsafe(
        `select direction, body from message
          where contact_id = ${uid(identity.contact.id)} and academy_id = ${uid(identity.academyId)}
            and body is not null and coalesce(suppressed_reason, '') = ''
          order by queued_at desc limit ${HISTORY}`,
      )) as unknown as { direction: string; body: string }[]
    })
    return rows
      .reverse()
      .map((r): Msg =>
        r.direction === 'inbound'
          ? { role: 'user', content: r.body }
          : { role: 'assistant', content: r.body },
      )
  } catch {
    return []
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
async function recentLookups(identity: Identity): Promise<string | undefined> {
  const BUDGET = 6000
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

    const blocks: string[] = []
    let used = 0
    for (const row of rows) {
      for (const call of Array.isArray(row.tool_calls) ? row.tool_calls : []) {
        // A `read` is the only call whose *result* is reference data. A write's
        // result is an outcome, and replaying outcomes as if they were facts is
        // how a bot tells someone something happened twice.
        if (call.name !== 'read') continue
        const query = String((call.args as any)?.query ?? '').replace(/\s+/g, ' ').trim()
        if (!query) continue
        const result = typeof call.result === 'string' ? call.result : JSON.stringify(call.result ?? null)
        const block =
          `- ${query}\n  → ${result.length > 1400 ? `${result.slice(0, 1400)}… (truncated)` : result}` +
          (call.error ? `\n  ! failed: ${call.error.split('\n')[0]}` : '')
        if (used + block.length > BUDGET) return blocks.length ? blocks.join('\n') : undefined
        blocks.push(block)
        used += block.length
      }
    }
    return blocks.length ? blocks.join('\n') : undefined
  } catch {
    // Continuity is an improvement on the turn, never a precondition for it.
    return undefined
  }
}

/* ------------------------------------------------------------------------- *
 * §5 — the pass that writes down what the turn learned
 * ------------------------------------------------------------------------- */

/**
 * **The two most discretionary tools in the product had nowhere to be called from.**
 *
 * The main loop ends the turn the moment a reply lands (C30, and it was right to —
 * the extra round produced `STOP · 0 output tokens` and cost a full prefix). But the
 * variable tail tells the model, in as many words, *"write new facts after replying,
 * never instead of replying"* — a sequence the break makes structurally impossible.
 * The only surviving path was a parallel `remember` emitted in the same breath as
 * `reply`, decided with no deliberation at all. Measured over 93 driven turns: **3
 * memory facts and zero `schedule` calls, ever.**
 *
 * That is not a model that dislikes remembering. It is a slot that does not exist.
 *
 * §5 already says where it belongs — *"the bot writes facts asynchronously after a
 * turn, never blocking a reply"* — so this runs once the message is out and nobody
 * is waiting. Three properties make it cheap enough to always run:
 *
 *  - **It does not carry the stable prefix.** Deciding "is there a fact here?" needs
 *    the conversation, not the schema, the catalog or the domain facts. ~300
 *    tokens instead of ~16k, which is why this costs less than the round C30 removed.
 *  - **Two tools, so there is no tool to get wrong.** The declarations are the same
 *    objects the main loop uses, filtered, so they cannot drift.
 *  - **Silence is the expected answer** and is stated as such. Most turns contain
 *    nothing worth keeping, and a reflection pass that always finds something is a
 *    diary (§5), which is the failure this is meant to avoid.
 *
 * Failures are swallowed by the caller: nothing here may cost a person their reply.
 */
async function reflect(
  session: SessionCtx,
  identity: Identity,
  turnId: string,
  turn: { said: string; replied: string; trace: ToolTrace[] },
): Promise<ToolTrace[] | null> {
  if (!turn.said.trim() && !turn.replied.trim()) return null

  /**
   * **Only offer what the turn did not already do.**
   *
   * Caught on the first live turn after this pass was added: the admin said "remind me
   * on Friday to chase the fees", the main loop scheduled `admin-fees-chase-friday`,
   * and reflection then scheduled `chase-fees-badminton-beginners` for the same thing.
   * One request, two watches, and the person gets chased twice — a new defect created
   * by the fix for an old one.
   *
   * The instructional version of this fix ("don't duplicate what you already did") is
   * the version that fails intermittently, because it depends on the model reading its
   * own trace correctly. The structural version cannot: if `schedule` already ran this
   * turn, reflection is not given `schedule`. The slot exists for the tools that had
   * nowhere to be called from, so once one has been called there is nothing left for it
   * to fix. `dedupe_key` stops two *identical* watches; nothing stopped two differently
   * named watches for one intent, and nothing at the schema layer could.
   */
  const already = new Set(turn.trace.map((t) => t.name))
  const decls = toolDecls().filter(
    (t) => (t.name === 'remember' || t.name === 'schedule') && !already.has(t.name),
  )
  if (!decls.length) return null

  const did = turn.trace
    .filter((t) => !t.name.startsWith('(') && t.name !== 'read')
    .map((t) => t.name)
  const at = await now(identity.academyId)

  const system = `You have just finished a turn as Class Manager, the manager for ${identity.academy.name}. It is already sent; you are not talking to anybody now.

Below are the only questions left open — anything not listed here was already handled during the turn and must not be repeated.

"Neither" is the common and correct answer:

1. **Is there a fact worth carrying?** Vocabulary they use, a policy that came up, a habit, a preference, something about how this person works. Facts, not transcripts — "prefers voice notes" is a fact, "asked about fees" is a log line. A fact that changes no future behaviour was not worth storing. Correct an existing fact by superseding it, never by writing a contradiction.
2. **Did they ask you to look at something later, or is there something you said you would come back to?** "Check if she's paid by Friday", "keep an eye on Saturday", "remind me Thursday", or a promise you made in the reply. That is a \`schedule\` — it runs later as an ordinary turn under this person's own permissions, and deciding to do nothing then is fine. \`expires_at\` is required.

Do not invent work. Do not schedule a watch nobody asked for and you did not promise. If neither applies, call nothing at all and say nothing — that is the system working.

Their id, for \`subject_id\`: person = ${identity.person.id}, business = ${identity.academyId}. It is ${at.toISOString()} now.`

  const res = await generate({
    system,
    messages: [
      {
        role: 'user',
        content:
          `They said: ${turn.said || '(nothing — a tap)'}\n\n` +
          `You replied: ${turn.replied || '(nothing)'}\n\n` +
          `What you ran this turn: ${did.length ? did.join(', ') : 'nothing'}`,
      },
    ],
    tools: decls,
    model: env.MODEL_MAIN,
    temperature: 0.2,
    // A pure judgement over two flat schemas — the same low the rest of the
    // model path runs at, stated here so nobody has to chase the default.
    thinking: 'low',
    maxOutputTokens: 2048,
  })

  if (!res.functionCalls.length) return null

  const ctx: ToolCtx = {
    session,
    identity,
    turnId,
    pendingPlans: new Map(),
    outcomes: [],
    // A reflection may not talk to anybody. `repliedTo` is pre-loaded with this
    // contact so that anything which tries is refused by the same guard the main
    // loop uses, rather than by a rule written twice.
    repliedTo: new Set<string>([identity.contact.id]),
  }

  const out: ToolTrace[] = []
  for (const call of res.functionCalls.slice(0, 4)) {
    if (call.name !== 'remember' && call.name !== 'schedule') continue
    // Nobody is waiting on a reflection, and there is no round in which to ask
    // again — a call whose arguments did not parse is simply not made.
    if (call.parseError) {
      out.push({ round: 0, name: `reflect:${call.name}`, ms: 0, error: `MALFORMED_FUNCTION_CALL: ${call.parseError}` })
      continue
    }
    const startedAt = Date.now()
    try {
      const r = await runTool(call.name, call.args, ctx)
      out.push({
        round: 0,
        name: `reflect:${call.name}`,
        ms: Date.now() - startedAt,
        args: traceValue(call.args, 1000),
        result: traceValue(r.result, 800),
      })
    } catch (e) {
      out.push({
        round: 0,
        name: `reflect:${call.name}`,
        ms: Date.now() - startedAt,
        args: traceValue(call.args, 1000),
        error: e instanceof Error ? e.message : String(e),
      })
    }
  }
  return out.length ? out : null
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
 * §10.2 — synthesized insight. NOT a template with slots.
 * ------------------------------------------------------------------------- */

const GROUNDING = `Three rules keep this honest, and they are not negotiable:
1. Every number you write must trace to a value in the payload below. If it is not there, you do not know it.
2. A comparison needs its baseline IN the payload. No baseline, no claim — not "attendance is down" from memory.
3. State uncertainty plainly. "Might be a pattern, might be coincidence at this size" beats a confident causal story.

You are deciding what THIS admin should know: what to lead with, what to leave out, and in what order. Do not
fill a template. Do not list everything you were given. If a section would be filler, drop it.`

export async function synthesize(academyId: string, kind: 'brief' | 'digest'): Promise<TurnOutput> {
  const turnId = newId()
  const startedMs = Date.now()
  const svc: SessionCtx = { role: 'service', academyId }
  const outcomes: SendOutcome[] = []
  let error: string | undefined
  let model: string | undefined
  let body = ''

  try {
    const payload = await synthesisPayload(svc, academyId)
    const admins = await adminRecipients(academyId)
    if (!admins.length) return { turnId, sent: [], toolCalls: 0 }

    const memory = {
      academy: await hotSet('academy', academyId, academyId).catch(() => ''),
      admin: await hotSet('person', admins[0].person_id, academyId).catch(() => ''),
    }

    const instruction =
      kind === 'brief'
        ? `Write ${admins[0].full_name.split(' ')[0]}'s morning brief. Lead with **Needs you** — the things that will
go wrong today if nobody acts. If nothing needs them, say so in one line, or send nothing at all.
Then, only if it is worth their attention, what today looks like.`
        : `Write tonight's digest. Lead with the one thing worth looking at, and say what you think is behind it —
with the uncertainty stated. Then the day in a line or two. Then delivery health, unconditionally: the admin
will never think to ask whether the reminders went out. Then who is unpaid.`

    // The same ladder the turn prompt uses (`context.ts`), not a second one. It
    // used to be a two-way split at 30 days against that file's three-way split
    // at 14 and 45, so a three-week-old academy was told to lean on proof inside
    // a turn and to lean on synthesis in its digest, on the same evening.
    const mix = mixInstruction(Number(payload.academy.age_days ?? 0))

    // **The digest does not get the stable prefix, and should never have had it.**
    //
    // This sent `stablePrefix()` — the schema it authors no SQL against, 26 operation
    // signatures it cannot call, the message catalog it is not choosing from, and the
    // domain facts about situations it is not in — to `MODEL_SYNTH`, which is the
    // most expensive model in the product, twice a day per academy.
    //
    // What the digest actually needs is doctrine (how to sound), the grounding rules
    // (how to stay honest), and the payload — which it is handed in full below. The
    // model choice is unchanged; only the bill is.
    //
    // **The shape is asked for, not enforced.** There is no constrained decoding
    // on this API outside beta, so the schema moved into the prompt and the
    // guarantee moved into `generateJson`: validate, and retry exactly once.
    // DeepSeek's own docs admit JSON mode occasionally returns empty content, and
    // this is a batch path where nobody is waiting on the retry.
    const res = await generateJson<{ send: boolean; body: string }>({
      system: `${synthesisDoctrine()}\n\n${GROUNDING}\n\n${mix}`,
      messages: [
        {
          role: 'user',
          content:
            `${instruction}\n\n` +
            `What this academy calls things, and what I know about them:\n${memory.academy || '(nothing yet)'}\n` +
            `About this admin:\n${memory.admin || '(nothing yet)'}\n\n` +
            `THE DATA — every number you use must come from here:\n${JSON.stringify(payload, null, 1)}\n\n` +
            // The literal word "json" has to appear or the request is rejected
            // outright — a requirement of the mode, not a style choice.
            'Answer as one json object and nothing else, in exactly this shape:\n' +
            '{"send": true, "body": "the message, in plain WhatsApp prose"}\n' +
            'Set "send" to false — with "body" an empty string — when there is genuinely nothing worth saying.',
        },
      ],
      model: env.MODEL_SYNTH,
      temperature: 0.6,
      validate: (v) => {
        const o = v as { send?: unknown; body?: unknown }
        if (!o || typeof o !== 'object') return null
        if (typeof o.send !== 'boolean') return null
        if (o.body !== undefined && typeof o.body !== 'string') return null
        return { send: o.send, body: String(o.body ?? '') }
      },
    })
    model = res.model

    // A digest that could not be composed is silence, which is a legal outcome
    // here (§13.1) — but it is a DIFFERENT silence from "nothing worth saying",
    // so it is recorded as the failure it is rather than as a quiet evening.
    if (!res.value) {
      await writeSynthTurn(
        academyId,
        turnId,
        kind,
        admins[0],
        { sent: false, error: res.error ?? 'no json' },
        model,
        Date.now() - startedMs,
        res.usage,
      )
      return { turnId, sent: [], toolCalls: 0, error: `synthesis produced no usable json: ${res.error ?? 'unknown'}` }
    }
    const parsed = res.value
    body = parsed.body.trim()

    // The morning brief is silent when there is nothing.
    if (!parsed.send || !body) {
      await writeSynthTurn(
        academyId,
        turnId,
        kind,
        admins[0],
        { sent: false },
        model,
        Date.now() - startedMs,
        res.usage,
      )
      return { turnId, sent: [], toolCalls: 0 }
    }

    for (const admin of admins) {
      if (!admin.contact_id) continue
      outcomes.push(
        await composeAndSend(svc, {
          toContactId: admin.contact_id,
          catalogId: kind === 'brief' ? 'AD-MORNING-BRIEF' : 'AD-EVENING-DIGEST',
          // Unlinted here on purpose: `send` runs the full pass for every message,
          // including this one. `lintForAdmin` used to sit here — a three-regex
          // hand-rolled subset written because "the lint pass wants an Identity and
          // synthesis runs without one" — and being a subset was the whole problem:
          // it did no markdown rewriting, no §-reference stripping, no timestamp
          // localisation and no vocabulary rewriting, so the two proactive messages
          // an admin gets every day reached them with `**bold**` and ISO timestamps
          // intact. One implementation, at the chokepoint.
          body,
          buttons: [
            kind === 'brief'
              ? { title: 'What needs me?', action: { kind: 'reply', text: 'What needs me today?' } }
              : { title: 'Show the numbers', action: { kind: 'reply', text: 'Show me the numbers behind that' } },
          ],
        }),
      )
    }
    await writeSynthTurn(
      academyId,
      turnId,
      kind,
      admins[0],
      { sent: true, statuses: outcomes.map((o) => o.status) },
      model,
      Date.now() - startedMs,
      res.usage,
    )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return { turnId, sent: outcomes, toolCalls: 0, error }
}

async function synthesisPayload(svc: SessionCtx, academyId: string): Promise<Record<string, any>> {
  return withSession(svc, async (tx) => {
    const one = async (sql: string) => ((await tx.unsafe(sql)) as unknown as Record<string, any>[])[0] ?? {}
    const many = async (sql: string) => (await tx.unsafe(sql)) as unknown as Record<string, any>[]
    const A = uid(academyId)

    const academy = await one(
      `select name, timezone, onboarding_state,
              (app.now()::date - created_on) as age_days,
              to_char(app.now() at time zone timezone, 'YYYY-MM-DD') as today
         from academy where id = ${A}`,
    )

    /**
     * A rendered local time, because this payload is `JSON.stringify`'d straight into
     * the prompt and a bare `starts_at` reaches the model as `2026-08-17T13:00:00.000Z`.
     *
     * Driven: the owner's 6:30pm Beginners class was reported to him as **"Arjun for
     * Beginners at 1pm"** in two consecutive briefs and an evening digest — 13:00 UTC,
     * read back as local. `context.ts` has carried `sessionLine` for exactly this since
     * a raw `06:00:00` was read out as "6pm" and sent a parent to a locked hall, but the
     * turn path and the synthesis path each built their own payload, so the guarantee
     * held only on the one that a person was already talking to.
     *
     * Rendered through `inZone` rather than in SQL so there is one formatter, and the
     * brief says a time the same way the chat does. The raw column is dropped, not kept
     * alongside — a model handed both will sometimes reach for the wrong one.
     */
    const tz = String(academy.timezone || 'Asia/Kolkata')
    const localTimes = (rows: Record<string, any>[]): Record<string, any>[] =>
      rows.map(({ starts_at, ...rest }) =>
        starts_at ? { ...rest, when: inZone(new Date(starts_at), tz).label } : rest)

    // Sequential on purpose: these all share one transaction, and one
    // connection is not a place to fan out.
    const today_sessions = await many(`select c.name as class_name, s.starts_at, s.status,
                     (select count(*) from session_coach sc where sc.session_id = s.id
                        and sc.declined_at is null and (sc.confirmed_at is not null or sc.arrived_at is not null)) as confirmed_coaches,
                     (select count(*) from attendance att where att.session_id = s.id and att.status in ('present','late')) as present,
                     (select count(*) from attendance att where att.session_id = s.id and att.status = 'absent') as absent
                from session s join class c on c.id = s.class_id
               where s.academy_id = ${A}
                 and (s.starts_at at time zone (select timezone from academy where id = ${A}))::date
                     = (app.now() at time zone (select timezone from academy where id = ${A}))::date
               order by s.starts_at`)
    // The predicate is §6.3's definition of coverage and is correct. What was
    // wrong was that it travelled alone: a bare list of "uncovered" sessions
    // cannot distinguish *nobody is on this* from *somebody is on this and has
    // not tapped yet*, and the digest read it out as the first when it was the
    // second — four times, to an owner whose only coach was assigned to all
    // three classes. So the assignment travels with it.
    const needs_you_uncovered = await many(`select c.name as class_name, s.starts_at,
                     coalesce((select string_agg(p.full_name, ', ' order by p.full_name)
                                 from session_coach sc
                                 join coach co on co.id = sc.coach_id
                                 join person p on p.id = co.person_id
                                where sc.session_id = s.id and sc.declined_at is null), '')
                       as assigned_coaches
                from session s join class c on c.id = s.class_id
               where s.academy_id = ${A} and s.status = 'scheduled'
                 and s.starts_at between app.now() and app.now() + interval '36 hours'
                 and not exists (select 1 from session_coach sc where sc.session_id = s.id
                                   and sc.declined_at is null
                                   and (sc.confirmed_at is not null or sc.arrived_at is not null))
               order by s.starts_at`)
    const registers_unmarked = await many(`select c.name as class_name, s.starts_at
                from session s join class c on c.id = s.class_id
               where s.academy_id = ${A} and s.status = 'scheduled' and s.ends_at < app.now()
                 and not exists (select 1 from attendance att where att.session_id = s.id)
               order by s.starts_at desc limit 10`)
    const coaches_not_onboarded = await many(`select p.full_name, count(*) as sessions_within_48h
                from coach co join person p on p.id = co.person_id
                join session_coach sc on sc.coach_id = co.id
                join session s on s.id = sc.session_id
               where co.academy_id = ${A} and co.status = 'invited'
                 and s.starts_at between app.now() and app.now() + interval '48 hours'
               group by p.full_name`)
    const unpaid = await many(`select p.full_name, ac.id as account_id,
                     coalesce(sum(tl.amount), 0) - coalesce((select sum(pay.amount) from payment pay
                        where pay.account_id = ac.id and pay.status = 'confirmed'), 0) as balance
                from account ac join person p on p.id = ac.holder_person_id
                left join tally_line tl on tl.account_id = ac.id
               where ac.academy_id = ${A}
               group by p.full_name, ac.id
              having coalesce(sum(tl.amount), 0) - coalesce((select sum(pay.amount) from payment pay
                        where pay.account_id = ac.id and pay.status = 'confirmed'), 0) > 0
               order by 3 desc limit 20`)
    // Delivery health is about messages to the BUSINESS's people. Two things were
    // wrong here, and together they produced a brief that reported an outage that
    // had not happened and a mailout that had never been sent.
    //
    // First, `failed` and `suppressed` overlapped: a suppressed row carries status
    // 'failed' too, so every gated message was counted twice and reported as "14
    // failed and another 14 suppressed" — the same fourteen rows, described as an
    // unusual failure rate "with the contact numbers or the account itself".
    //
    // Second, the admin's own conversation was in the denominator. Their thread is
    // the operator using the tool, not traffic to families, and counting it meant a
    // quiet academy whose owner had been testing looked like a business mid-mailout.
    // A brief that narrates the plumbing as news is worse than one that says nothing.
    const delivery = await one(`select count(*) filter (where suppressed_reason is null
                                              and status in ('sent','delivered','read')) as sent,
                    count(*) filter (where status in ('delivered','read')) as delivered,
                    count(*) filter (where status = 'read') as read,
                    count(*) filter (where suppressed_reason is null and status = 'failed') as failed,
                    count(*) filter (where suppressed_reason is not null) as gated,
                    coalesce(sum(cost_paise), 0) as cost_paise
               from message m
              where m.academy_id = ${A} and m.direction = 'outbound'
                and m.queued_at > app.now() - interval '24 hours'
                and not exists (select 1 from contact c
                                  join academy_admin aa on aa.person_id = c.person_id
                                                       and aa.academy_id = c.academy_id
                                 where c.id = m.contact_id)`)
    // Named apart so the two can never be read as one number again: a gate is a
    // decision this system made on purpose, a failure is the network saying no.
    const gated_by_reason = await many(`select m.suppressed_reason as reason, count(*) as n
               from message m
              where m.academy_id = ${A} and m.direction = 'outbound'
                and m.suppressed_reason is not null
                and m.queued_at > app.now() - interval '24 hours'
              group by 1 order by 2 desc`)
    const attendance_30d = await many(`select c.name as class_name,
                     count(*) filter (where att.status in ('present','late')) as attended,
                     count(*) as marked
                from attendance att join session s on s.id = att.session_id join class c on c.id = s.class_id
               where att.academy_id = ${A} and s.starts_at > app.now() - interval '30 days'
               group by c.name order by 3 desc`)
    const attendance_prev_30d = await many(`select c.name as class_name,
                     count(*) filter (where att.status in ('present','late')) as attended,
                     count(*) as marked
                from attendance att join session s on s.id = att.session_id join class c on c.id = s.class_id
               where att.academy_id = ${A}
                 and s.starts_at between app.now() - interval '60 days' and app.now() - interval '30 days'
               group by c.name order by 3 desc`)
    const new_trials_7d = await many(`select p.full_name as player_name, c.name as class_name, e.started_on
                from enrollment e join player pl on pl.id = e.player_id
                join person p on p.id = pl.person_id join class c on c.id = e.class_id
               where e.academy_id = ${A} and e.is_trial and e.created_at > app.now() - interval '7 days'`)
    const quiet_contacts = await one(`select count(*) as n from contact
              where academy_id = ${A} and state = 'engaged'
                and last_inbound_at < app.now() - interval '90 days'`)

    return {
      academy,
      note: 'Every list here is the complete result of its query, not a sample.',
      // `when` is the academy's own local time, already rendered — say it verbatim.
      // See `localTimes` above for the brief that read 6:30pm back as "1pm".
      today_sessions: localTimes(today_sessions),
      needs_you: {
        // **The key name is prompt, and it is the part nobody reviews.** This was
        // `uncovered_sessions_next_36h`, and "uncovered" became "still need a coach
        // assigned" in the admin's digest — a false sentence, sent four times, about
        // the only coach he had, on the eve of his first class. The predicate never
        // changed; the name did the damage. Named for what it measures now, with the
        // assignment alongside it so the true sentence is the available one.
        sessions_without_a_confirmed_coach_next_36h: localTimes(needs_you_uncovered),
        sessions_note:
          'A row here means nobody has CONFIRMED — not that nobody is assigned. Read ' +
          '`assigned_coaches` on the row: non-empty means they have a coach who simply ' +
          'has not tapped yet, and the true sentence names that person. Only an empty ' +
          '`assigned_coaches` means nobody is on it at all. Never tell an admin a session ' +
          'needs a coach assigned when one is.',
        registers_unmarked: localTimes(registers_unmarked),
        coaches_invited_but_not_onboarded: coaches_not_onboarded,
      },
      money: { unpaid_accounts: unpaid },
      delivery_last_24h: {
        ...delivery,
        note:
          "Messages to families and coaches only — the admin's own thread is excluded, and " +
          '`gated` counts messages this system chose not to send (see gated_by_reason), which ' +
          'is not a delivery failure and must never be reported as one.',
      },
      gated_by_reason,
      attendance_last_30d_by_class: attendance_30d,
      attendance_previous_30d_by_class: attendance_prev_30d,
      new_trials_last_7d: new_trials_7d,
      contacts_silent_90d: quiet_contacts,
    }
  })
}

/**
 * The brief and the digest are the only MODEL_SYNTH calls in the product — the most
 * expensive single call it makes, twice a day per academy. They were the one model path
 * writing a turn row with no token columns at all, so they were invisible in every cost
 * and cache reading taken from `turn`. Usage is passed through now for the same reason
 * §4.4 exists: an unmeasured prefix is an unbounded bill.
 */
async function writeSynthTurn(
  academyId: string,
  turnId: string,
  kind: string,
  admin: { person_id: string; contact_id: string | null },
  output: unknown,
  model: string | undefined,
  latencyMs: number,
  usage?: { promptTokens: number; outputTokens: number; cachedTokens: number },
): Promise<void> {
  try {
    await withSession({ role: 'service', academyId }, async (tx) => {
      await tx.unsafe(
        `insert into turn (id, academy_id, contact_id, person_id, role_acted, input, output, model,
                           prompt_tokens, output_tokens, cached_tokens, latency_ms)
         values (${uid(turnId)}, ${uid(academyId)}, ${admin.contact_id ? uid(admin.contact_id) : 'null'},
                 ${uid(admin.person_id)}, 'admin', ${jsonLit({ synthesis: kind })}, ${jsonLit(output)},
                 ${lit(model ?? null)}, ${lit(usage?.promptTokens ?? 0)}, ${lit(usage?.outputTokens ?? 0)},
                 ${lit(usage?.cachedTokens ?? 0)}, ${lit(latencyMs)})`,
      )
    })
  } catch {
    /* never let instrumentation break the digest */
  }
}

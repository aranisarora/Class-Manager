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
import { resolveIdentity } from '@/lib/identity'
import { consumeAction, type ActionPayload } from '@/lib/actions'
import { composeAndSend } from '@/lib/messaging/compose'
import { LIMITS, type SendOutcome } from '@/lib/messaging/types'
import { ONBOARDING_SETUP, parseFlowResponse, type OnboardingSetupValues } from '@/lib/messaging/flows'
import { buildSetupSteps, summariseSetup } from '@/lib/setup-plan'
import { signLink, linkUrl, TTL } from '@/lib/web/jwt'
import type { Identity, Job, Role } from '@/lib/types'
import { generate, TURN_THINKING, type GenContent } from './gemini'
import { lint, stablePrefix, synthesisDoctrine, variableTail } from './context'
import { hotSet } from './memory'
import { audienceFor, executePlan, type PlanStep } from './plan'
import { jsonLit, lit, uid, type OperationName } from './operations'
import {
  closingQuestionButtons,
  extractBracketButtons,
  FOLLOW_UPS,
  pendingConfirmation,
  runTool,
  toolDecls,
  withFollowUps,
  MENU_BUTTON_TITLE,
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

const MAX_TOOL_ROUNDS = 8
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

    if (goToModel && (text || input.media?.length || input.task)) {
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
      replyText = m.said.length ? m.said.join('\n\n') : m.text
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
     * skipped all of them. `generate` throws on a non-transient Vertex failure and
     * after two attempts on a transient one; `stablePrefix()` throws if a behavior
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

    if (payload.flow === ONBOARDING_SETUP.id) {
      const v = parsed.values as OnboardingSetupValues
      // The same builder the setup screen runs. A Flow is a different way to reach
      // the setup plan, never a second implementation of it.
      const steps = buildSetupSteps(identity.academyId, {
        name: v.name,
        category: v.category || null,
        cancellationWindowHours: v.cancellation_window_hours,
        upiHandle: v.upi_handle || null,
        venues: [{ name: v.venue }],
      })
      const res = await executePlan(session, steps, 'Business set up from the onboarding form', audienceFor(identity))
      if (!res.ok) {
        outcomes.push(
          await composeAndSend(session, {
            toContactId: identity.contact.id,
            body: /PRECONDITION_FAILED|CHANGED_NOTHING/.test(res.error ?? '')
              ? 'Only the owner can change the business settings, so I left everything as it was.'
              : `That didn't save: ${res.error ?? 'something went wrong'}. Nothing was changed.`,
          }),
        )
        return { outcomes, summary: `flow ${payload.flow} failed: ${res.error ?? 'unknown'}` }
      }

      const summary = summariseSetup({
        name: v.name,
        cancellationWindowHours: v.cancellation_window_hours,
        upiHandle: v.upi_handle || null,
        venues: [{ name: v.venue }],
      })
      outcomes.push(
        await composeAndSend(session, {
          toContactId: identity.contact.id,
          preLaunchOk: true,
          body:
            `${summary}\n\n`
            + 'Next is your timetable — the classes, which days and what times. '
            + 'A photo of the whiteboard or the paper register is enough; send it here.',
          buttons: [
            { title: 'Add a class', action: { kind: 'reply', text: 'Let me tell you my timetable' } },
          ],
        }),
      )
      return { outcomes, summary }
    }

    // Unreachable while `FLOWS` has one entry, and deliberately loud rather than
    // silent if a flow is ever added without a consumer — which is the exact shape
    // that produced the recipe feature.
    return { outcomes, summary: `flow ${payload.flow} has no handler` }
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

  if (payload.kind === 'view') {
    // Two shapes, one door: a spec authored for this answer, or one of the
    // screens §15 ships. The link is signed at TAP time, not at mint time, so a
    // button tapped tomorrow still opens rather than expiring in someone's chat.
    const builtIn = 'screen' in payload ? payload.screen : null
    const purpose = builtIn ?? 'view'
    const ref = 'screen' in payload ? payload.ref : payload.viewSpecId
    const token = await signLink(
      {
        academy_id: identity.academyId,
        person_id: identity.person.id,
        contact_id: identity.contact.id,
        purpose,
        ...(ref ? { ref } : {}),
      },
      TTL[purpose],
    )
    const hours = Math.round(TTL[purpose] / 60)
    // §14.6 — "every link is a button; nothing URL-shaped is pasted into message text",
    // and this was the single worst offender against it in the product: the runtime itself
    // composed a sentence and then a 300-character signed JWT, and sent that to a phone.
    // The rule had nothing to be obeyed with until `link` existed.
    outcomes.push(
      await composeAndSend(session, {
        toContactId: identity.contact.id,
        body:
          (builtIn === 'setup'
            ? 'Everything about the business on one screen — name, places you play, your weekly times, how much notice you want for cancellations, and where people pay you.'
            : builtIn === 'register'
              ? 'The whole roster on one screen — tick who came, add a note, send it back.'
              : 'Here it is.') +
          `\n\nYours only, good for the next ${hours <= 1 ? 'hour' : `${hours} hours`}.` +
          (builtIn === 'setup' ? '\nOr just tell me any of it here and I’ll set it up the same way.' : ''),
        link: {
          title: builtIn === 'setup' ? 'Open setup' : builtIn === 'register' ? 'Open register' : 'Open',
          url: linkUrl(token),
        },
      }),
    )
    return { outcomes, summary: `${purpose} link` }
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
        buttons: follow.length
          ? follow.slice(0, LIMITS.buttons)
          : [{ title: MENU_BUTTON_TITLE, action: { kind: 'menu', menu: 'root' } }],
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
    fromParsedInput: Boolean(input.media?.length),
    executed: [],
    repliedTo: new Set<string>(),
    saidToUser: [],
  }

  const [clock, lookups] = await Promise.all([
    now().then((at) => inZone(at, identity.academy.timezone)),
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
  const parts: any[] = [{ text: `${situation.join('\n\n')}\n\n---\n\n${input.text ?? ''}`.trim() }]
  for (const m of input.media ?? []) {
    // §14.5 — multimodal in, text out. Audio and images ride in the variable
    // tail, so they never touch the cacheable prefix. The media pipeline hands
    // over data URIs (the same shape a fetched Meta media id produces), and
    // `GenPart` carries those as inlineData base64, never as a file uri.
    const data = dataUriPayload(m.url)
    if (data) parts.push({ inlineData: { mimeType: data.mimeType || m.mimeType, data: data.base64 } })
    else parts.push({ fileData: { fileUri: m.url, mimeType: m.mimeType } })
  }
  const contents: GenContent[] = [...history, { role: 'user', parts }]

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
   * §4.4's prefix is 58k characters and `onboarding.md` is one of ten modules inside
   * it. At `thinkingBudget: 0` the model does not consult that; it pattern-matches the
   * sentence in front of it — which is why a business at `setup` gets a competent
   * answer to the question asked and no sense of the sequence it is in. Three of five
   * driven academies stalled at `setup` with a good instruction sitting unread.
   *
   * A turn that is *guiding* someone is a sequencing judgement, not a plan to compose,
   * so it gets a budget. Everything else keeps C29's zero.
   */
  const thinkingBudget =
    identity.academy.onboarding_state !== 'live' || !identity.roles.length
      ? TURN_THINKING.guide
      : TURN_THINKING.compose

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    rounds = round + 1
    const res = await generate({
      system,
      contents,
      tools: toolDecls(),
      model: env.MODEL_MAIN,
      temperature: 0.4,
      thinkingBudget,
    })
    model = res.model
    promptTokens += res.usage.promptTokens
    outputTokens += res.usage.outputTokens
    cachedTokens += res.usage.cachedTokens
    text = res.text ?? ''

    if (!res.functionCalls.length) {
      // A round that produced neither a tool call nor a word is the shape of every
      // turn that dies quietly, and it used to leave no trace at all. The reason the
      // candidate stopped is the whole diagnosis, so it is recorded here rather than
      // inferred later from a missing reply.
      if (!text.trim()) {
        trace.push({
          round: round + 1,
          name: '(model returned nothing)',
          ms: res.ms,
          // On MALFORMED_FUNCTION_CALL the parts sometimes carry the fragment the
          // model was trying to emit, which is the only clue to WHICH tool it was
          // reaching for — the call itself never arrives.
          args: traceValue(res.modelParts, 2000),
          error: `finishReason: ${res.finishReason ?? 'unknown'} · ${res.usage.outputTokens} output tokens`,
        })
      }
      break
    }

    // Echo the model's own parts back verbatim so Gemini 3 thought signatures
    // survive the round trip.
    contents.push({ role: 'model', parts: res.modelParts })

    const responses: any[] = []
    for (const call of res.functionCalls) {
      toolCalls++
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
        responses.push({ functionResponse: { name: call.name, response: { result: out.result } } })
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
      responses.push({ functionResponse: { name: call.name, response: { result: out.result } } })
    }
    contents.push({ role: 'user', parts: responses })

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

    if (round === MAX_TOOL_ROUNDS - 1) {
      // Out of rounds. Say so plainly rather than going quiet.
      text = text || "I'm going round in circles on this one — can you tell me the short version of what you need?"
    }
  }

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
  if (!text.trim() && !spoke()) {
    try {
      const forced = await generate({
        system,
        contents: [
          ...flattenToolTurns(contents),
          {
            role: 'user',
            parts: [
              {
                text:
                  'Answer them now, in plain words, using only what those results actually say. ' +
                  'No tools left to call. If the results do not answer it, say so plainly (§4.1 rule 10).\n\n' +
                  'You have no tools in this round, so nothing you describe can happen. Do not say what ' +
                  'you are about to do, are going to do, or will now set up — this is the last thing sent, ' +
                  'and a promise here is a promise nothing keeps. State what you found, or say plainly ' +
                  'that you have not done it yet and ask for the one thing you need to.',
              },
            ],
          },
        ],
        model: env.MODEL_MAIN,
        temperature: 0.4,
      })
      promptTokens += forced.usage.promptTokens
      outputTokens += forced.usage.outputTokens
      cachedTokens += forced.usage.cachedTokens
      text = forced.text ?? ''
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

  if (!text.trim() && !spoke()) {
    // Two different failures wearing one sentence. "Try again" is only honest when
    // trying again could work; a turn that burned every round needs to say so, and
    // one that broke needs to not pretend it is waiting on the person.
    text =
      rounds >= MAX_TOOL_ROUNDS
        ? "I went round in circles on that one and didn't get to an answer. Can you tell me the short version of what you need?"
        : "Something broke on my side working that out — it isn't you, and repeating it won't help. I've flagged it."
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
        (closingQuestionButtons(text.trim()) as { title: string; action: ActionPayload }[] | null) ?? [
          { title: MENU_BUTTON_TITLE, action: { kind: 'menu', menu: 'root' } },
        ]
    }
    // Whichever path the message leaves by, §4.3 holds.
    buttons = withFollowUps(buttons, toolCtx) as { title: string; action: ActionPayload }[] | undefined

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
 * turn already learned into words. But a history containing `functionCall` and
 * `functionResponse` parts is only legal alongside a tool declaration: Vertex answers
 * a request that carries one without the other with `UNEXPECTED_TOOL_CALL` and an
 * empty candidate.
 *
 * So the round designed to guarantee the person hears *something* was the one round
 * that could never run. Watched live: seven rounds, sixty seconds, 153k tokens, a
 * MALFORMED_FUNCTION_CALL, and then the recovery — the last line of defence against
 * silence — failed with `UNEXPECTED_TOOL_CALL` and the admin was told "something broke
 * on my side". The venue had been created; nothing said so.
 *
 * Flattening keeps every fact and loses only the encoding. "Everything the turn learned
 * is already sitting in `contents`" is the comment above; this is what makes it true.
 */
function flattenToolTurns(contents: GenContent[]): GenContent[] {
  return contents.map((c) => {
    if (!Array.isArray(c.parts)) return c
    if (!c.parts.some((p: any) => p?.functionCall || p?.functionResponse)) return c
    const parts = c.parts.map((p: any) => {
      if (p?.functionCall) {
        return { text: `[you called ${p.functionCall.name} with ${traceValue(JSON.stringify(p.functionCall.args ?? {}), 1500)}]` }
      }
      if (p?.functionResponse) {
        const r = (p.functionResponse.response as any)?.result ?? p.functionResponse.response
        return { text: `[${p.functionResponse.name} came back: ${traceValue(typeof r === 'string' ? r : JSON.stringify(r ?? null), 3000)}]` }
      }
      // A thought signature belongs to the call it was emitted with, and the call is
      // gone — carrying it into a round with no tools is the same error again.
      return p?.thoughtSignature ? { text: String(p.text ?? '') } : p
    })
    return { role: c.role, parts: parts.filter((p: any) => typeof p?.text !== 'string' || p.text.length > 0) }
  })
}

/** `data:<mime>;base64,<payload>` → the two halves Gemini's inlineData wants. */
function dataUriPayload(url: string): { mimeType: string; base64: string } | null {
  const m = /^data:([^;,]*)(;[^,]*)?,(.*)$/s.exec(url)
  if (!m) return null
  const isBase64 = (m[2] ?? '').includes('base64')
  return {
    mimeType: m[1] || 'application/octet-stream',
    base64: isBase64 ? m[3] : Buffer.from(decodeURIComponent(m[3]), 'utf8').toString('base64'),
  }
}

async function recentHistory(session: SessionCtx, identity: Identity): Promise<GenContent[]> {
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
      .map((r) => ({ role: r.direction === 'inbound' ? ('user' as const) : ('model' as const), parts: [{ text: r.body }] }))
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
 * `reply`, decided with `thinkingBudget: 0`. Measured over 93 driven turns: **3
 * memory facts and zero `schedule` calls, ever.**
 *
 * That is not a model that dislikes remembering. It is a slot that does not exist.
 *
 * §5 already says where it belongs — *"the bot writes facts asynchronously after a
 * turn, never blocking a reply"* — so this runs once the message is out and nobody
 * is waiting. Three properties make it cheap enough to always run:
 *
 *  - **It does not carry the stable prefix.** Deciding "is there a fact here?" needs
 *    the conversation, not the schema, the catalog or ten behavior modules. ~300
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
  const at = await now()

  const system = `You have just finished a turn as Class Manager, the manager for ${identity.academy.name}. It is already sent; you are not talking to anybody now.

Below are the only questions left open — anything not listed here was already handled during the turn and must not be repeated.

"Neither" is the common and correct answer:

1. **Is there a fact worth carrying?** Vocabulary they use, a policy that came up, a habit, a preference, something about how this person works. Facts, not transcripts — "prefers voice notes" is a fact, "asked about fees" is a log line. A fact that changes no future behaviour was not worth storing. Correct an existing fact by superseding it, never by writing a contradiction.
2. **Did they ask you to look at something later, or is there something you said you would come back to?** "Check if she's paid by Friday", "keep an eye on Saturday", "remind me Thursday", or a promise you made in the reply. That is a \`schedule\` — it runs later as an ordinary turn under this person's own permissions, and deciding to do nothing then is fine. \`expires_at\` is required.

Do not invent work. Do not schedule a watch nobody asked for and you did not promise. If neither applies, call nothing at all and say nothing — that is the system working.

Their id, for \`subject_id\`: person = ${identity.person.id}, business = ${identity.academyId}. It is ${at.toISOString()} now.`

  const res = await generate({
    system,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              `They said: ${turn.said || '(nothing — a tap)'}\n\n` +
              `You replied: ${turn.replied || '(nothing)'}\n\n` +
              `What you ran this turn: ${did.length ? did.join(', ') : 'nothing'}`,
          },
        ],
      },
    ],
    tools: decls,
    model: env.MODEL_MAIN,
    temperature: 0.2,
    // Unlike the tool path, this call is not composing a deeply-nested plan — it is
    // making a judgement, which is the shape a thinking budget is actually for, and
    // there is no MALFORMED_FUNCTION_CALL risk to trade against on two flat schemas.
    thinkingBudget: TURN_THINKING.judge,
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
  const nowD = await now()
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
    const admins = await withSession(svc, async (tx) => {
      return (await tx.unsafe(
        `select aa.person_id, p.full_name, c.id as contact_id
           from academy_admin aa
           join person p on p.id = aa.person_id
           left join contact c on c.person_id = aa.person_id and c.academy_id = aa.academy_id
                               and c.opted_out_at is null
          where aa.academy_id = ${uid(academyId)}
          order by c.is_primary desc nulls last`,
      )) as unknown as { person_id: string; full_name: string; contact_id: string | null }[]
    })
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

    const ageDays = Number(payload.academy.age_days ?? 0)
    const mix =
      ageDays < 30
        ? 'This academy is new here. Lean on proof — what was actually done, what actually went out — over synthesis.'
        : 'This academy has been here a while. They trust the mechanics; lean on the thinking, not the receipts.'

    // **The digest does not get the stable prefix, and should never have had it.**
    //
    // This sent `stablePrefix()` — the schema it authors no SQL against, 26 operation
    // signatures it cannot call, the message catalog it is not choosing from, and ten
    // behavior modules about situations it is not in — to `MODEL_SYNTH`, which is the
    // most expensive model in the product, twice a day per academy. Measured, that
    // prefix is ~16k tokens.
    //
    // Worse, it was **uncached every time**: `cachedContentFor` requires tools to
    // create a handle, and synthesis declares none, so the one call that paid the most
    // for the prefix was the one call that never amortised it.
    //
    // What the digest actually needs is doctrine (how to sound), the grounding rules
    // (how to stay honest), and the payload — which it is handed in full below. The
    // model choice is unchanged; only the bill is.
    const res = await generate({
      system: `${synthesisDoctrine()}\n\n${GROUNDING}\n\n${mix}`,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                `${instruction}\n\n` +
                `What this academy calls things, and what I know about them:\n${memory.academy || '(nothing yet)'}\n` +
                `About this admin:\n${memory.admin || '(nothing yet)'}\n\n` +
                `THE DATA — every number you use must come from here:\n${JSON.stringify(payload, null, 1)}`,
            },
          ],
        },
      ],
      model: env.MODEL_SYNTH,
      temperature: 0.6,
      responseJsonSchema: {
        type: 'object',
        properties: {
          send: { type: 'boolean', description: 'False when there is genuinely nothing worth saying.' },
          body: { type: 'string' },
        },
        required: ['send', 'body'],
      },
    })
    model = res.model

    let parsed: { send?: boolean; body?: string } = {}
    try {
      parsed = JSON.parse(res.text)
    } catch {
      parsed = { send: Boolean(res.text.trim()), body: res.text.trim() }
    }
    body = String(parsed.body ?? '').trim()

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
      today_sessions,
      needs_you: {
        // **The key name is prompt, and it is the part nobody reviews.** This was
        // `uncovered_sessions_next_36h`, and "uncovered" became "still need a coach
        // assigned" in the admin's digest — a false sentence, sent four times, about
        // the only coach he had, on the eve of his first class. The predicate never
        // changed; the name did the damage. Named for what it measures now, with the
        // assignment alongside it so the true sentence is the available one.
        sessions_without_a_confirmed_coach_next_36h: needs_you_uncovered,
        sessions_note:
          'A row here means nobody has CONFIRMED — not that nobody is assigned. Read ' +
          '`assigned_coaches` on the row: non-empty means they have a coach who simply ' +
          'has not tapped yet, and the true sentence names that person. Only an empty ' +
          '`assigned_coaches` means nobody is on it at all. Never tell an admin a session ' +
          'needs a coach assigned when one is.',
        registers_unmarked: registers_unmarked,
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

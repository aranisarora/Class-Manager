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
import { signLink, linkUrl } from '@/lib/web/jwt'
import type { Identity, Job, Role } from '@/lib/types'
import { generate, type GenContent } from './gemini'
import { lint, stablePrefix, variableTail } from './context'
import { hotSet } from './memory'
import { executePlan, type PlanStep } from './plan'
import { jsonLit, lit, uid, type OperationName } from './operations'
import { runTool, TOOL_DECLS, type ToolCtx } from './tools'
import { matchRecipe } from './recipes'

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

const MAX_TOOL_ROUNDS = 8
const HISTORY = 16

/* ------------------------------------------------------------------------- *
 * §4.3 — after every action, the natural next step as a button. On a button
 * tap there is no model call to compose one, so these are fixed. They cost
 * nothing, are always relevant, and teach capability by demonstration.
 * ------------------------------------------------------------------------- */

const FOLLOW_UPS: Partial<Record<OperationName, (args: any) => { title: string; action: ActionPayload }[]>> = {
  cancel_session: (a) => [
    { title: "See who's affected", action: { kind: 'reply', text: `Who was in the session I just cancelled?` } },
  ],
  end_coach: () => [{ title: 'Assign classes', action: { kind: 'reply', text: 'Who should take those sessions?' } }],
  mark_attendance: () => [
    { title: 'Rebook someone', action: { kind: 'reply', text: 'Find a makeup slot for someone who missed' } },
  ],
  client_cancel: () => [
    { title: 'Find a makeup', action: { kind: 'reply', text: 'Find a makeup slot for that class' } },
  ],
  add_coach: (a) => [
    { title: 'Send the invite', action: { kind: 'reply', text: `Draft the invite for ${a?.full_name ?? 'them'}` } },
  ],
  record_payment: () => [{ title: 'See the tally', action: { kind: 'reply', text: 'Show me that account tally' } }],
  book_trial: () => [{ title: 'See the schedule', action: { kind: 'reply', text: 'Show me the schedule' } }],
}

function sessionOf(identity: Identity): SessionCtx {
  return {
    role: 'user',
    academyId: identity.academyId,
    personId: identity.person.id,
    contactId: identity.contact.id,
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
  let replyText = ''

  const identity = await resolveIdentity(input.contactId)
  if (!identity) {
    // Nothing to attribute a turn row to — no academy, no person. The router
    // (§10.1) is what answers this case; here it is simply not our turn.
    return { turnId, sent: [], toolCalls: 0, error: 'unresolved_contact' }
  }
  const session = sessionOf(identity)

  try {
    let text = input.text
    let goToModel = !input.actionId

    if (input.actionId) {
      const consumed = await consumeAction(session, input.actionId, input.contactId)
      if (!consumed.ok) {
        outcomes.push(
          await composeAndSend(session, {
            toContactId: identity.contact.id,
            body:
              consumed.reason === 'expired'
                ? "That button has expired — tell me what you'd like and I'll sort it out."
                : consumed.reason === 'already_used'
                  ? "That one's already done. Anything else?"
                  : "That button isn't yours to tap. Tell me what you need instead.",
          }),
        )
      } else if (consumed.payload.kind === 'reply') {
        // The only kind that re-enters the model: it replays as if the user
        // typed it.
        text = consumed.payload.text
        goToModel = true
      } else {
        const res = await executeAction(session, identity, consumed.payload, turnId)
        outcomes.push(...res.outcomes)
        replyText = res.summary
      }
    }

    if (goToModel && (text || input.media?.length || input.task)) {
      const m = await modelTurn(session, identity, turnId, { ...input, text })
      outcomes.push(...m.outcomes)
      toolCalls = m.toolCalls
      modelName = m.model
      promptTokens = m.promptTokens
      outputTokens = m.outputTokens
      replyText = m.text
      if (m.error) error = m.error
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  await writeTurn({
    turnId,
    identity,
    input,
    output: { reply: replyText, sent: outcomes.map((o) => o.status) },
    model: modelName,
    promptTokens,
    outputTokens,
    latencyMs: Date.now() - startedMs,
    error,
  })

  if (error) {
    const escalated = await handoffOnRepeatedFailure(session, identity, turnId)
    if (escalated) outcomes.push(...escalated)
  }

  return { turnId, sent: outcomes, toolCalls, error }
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

  if (payload.kind === 'noop') {
    outcomes.push(await composeAndSend(session, { toContactId: identity.contact.id, body: payload.ack }))
    return { outcomes, summary: payload.ack }
  }

  if (payload.kind === 'menu') {
    outcomes.push(...(await sendMenu(session, identity, payload.menu)))
    return { outcomes, summary: `menu:${payload.menu}` }
  }

  if (payload.kind === 'view') {
    const token = await signLink(
      {
        academy_id: identity.academyId,
        person_id: identity.person.id,
        contact_id: identity.contact.id,
        purpose: 'view',
        ref: payload.viewSpecId,
      },
      120,
    )
    outcomes.push(
      await composeAndSend(session, {
        toContactId: identity.contact.id,
        body: `Here it is — this link is yours and works for the next couple of hours:\n${linkUrl(token)}`,
      }),
    )
    return { outcomes, summary: 'view link' }
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
  const res = await executePlan(session, steps, intent)
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
          : `I couldn't do that: ${(res.error ?? 'something moved under me').replace(/^[A-Z_]+: /, '')}. Nothing was changed.`,
      }),
    )
    return { outcomes, summary: res.error ?? 'failed' }
  }

  // If the plan already spoke to this person, adding an ack on top is noise.
  const alreadyTold = res.stagedMessages.some((m) => m.toContactId === identity.contact.id)
  if (!alreadyTold) {
    const follow =
      payload.kind === 'operation' ? (FOLLOW_UPS[payload.op as OperationName]?.(payload.args) ?? []) : []
    outcomes.push(
      await composeAndSend(session, {
        toContactId: identity.contact.id,
        body: res.summary,
        buttons: follow.length ? follow.slice(0, LIMITS.buttons) : undefined,
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

async function modelTurn(
  session: SessionCtx,
  identity: Identity,
  turnId: string,
  input: TurnInput,
): Promise<{
  outcomes: SendOutcome[]
  toolCalls: number
  text: string
  model?: string
  promptTokens: number
  outputTokens: number
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
  }

  const clock = inZone(await now(), identity.academy.timezone)
  const tail = await variableTail(identity, {
    clockNote: `It is ${clock.label} (${clock.date} ${clock.time}) in ${identity.academy.timezone}.`,
    taskInstruction: input.task?.instruction,
    queryResults: input.task?.queryResults,
  })

  const situation: string[] = [tail]
  if (input.source === 'job' && input.task) {
    situation.push(
      'This is a task you scheduled for yourself. Deciding to do nothing is the common and correct outcome — ' +
        'only send something if this person would have asked for it.',
    )
  }
  // §14.3 — recipes optimise, they never gate. A match is offered as a
  // known-good shape; an unmatched request falls through to the primitives.
  if (input.text) {
    try {
      const recipe = await matchRecipe(input.text, { academyId: identity.academyId })
      if (recipe) {
        situation.push(
          `A captured plan already exists for something like this — "${recipe.name}"` +
            (recipe.trigger_description ? ` (${recipe.trigger_description})` : '') +
            `. Its steps, with ${recipe.params.length ? recipe.params.join(', ') : 'no'} placeholders to fill: ` +
            `${JSON.stringify(recipe.plan).slice(0, 1200)}. Use it if it fits; ignore it if this case is different.`,
        )
      }
    } catch {
      /* a recipe lookup must never be the reason a turn fails */
    }
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
  let repliedInTool = false

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await generate({
      system,
      contents,
      tools: TOOL_DECLS,
      model: env.MODEL_MAIN,
      temperature: 0.4,
    })
    model = res.model
    promptTokens += res.usage.promptTokens
    outputTokens += res.usage.outputTokens
    text = res.text ?? ''

    if (!res.functionCalls.length) break

    // Echo the model's own parts back verbatim so Gemini 3 thought signatures
    // survive the round trip.
    contents.push({ role: 'model', parts: res.modelParts })

    const responses: any[] = []
    for (const call of res.functionCalls) {
      toolCalls++
      if (call.name === 'reply') repliedInTool = true
      let out: { result: unknown; note?: string }
      try {
        out = await runTool(call.name, call.args, toolCtx)
      } catch (e) {
        out = { result: { error: e instanceof Error ? e.message : String(e) } }
      }
      responses.push({ functionResponse: { name: call.name, response: { result: out.result } } })
    }
    contents.push({ role: 'user', parts: responses })

    if (round === MAX_TOOL_ROUNDS - 1) {
      // Out of rounds. Say so plainly rather than going quiet.
      text = text || "I'm going round in circles on this one — can you tell me the short version of what you need?"
    }
  }

  // Going quiet is the one failure a person cannot tell apart from being ignored.
  // A model that spends its whole turn on tool calls and then returns an empty
  // candidate — out of output budget, or simply done thinking — leaves someone
  // staring at a chat that never answered. So if nothing was said and nothing was
  // sent, ask once more with the tool surface removed: every query result is
  // already sitting in `contents`, so this round only has to put it into words.
  if (!text.trim() && !repliedInTool && outcomes.length === 0 && toolCalls > 0) {
    try {
      const forced = await generate({
        system,
        contents: [
          ...contents,
          {
            role: 'user',
            parts: [
              {
                text:
                  'Answer them now, in plain words, using only what those results actually say. ' +
                  'No tools left to call. If the results do not answer it, say so plainly (§4.1 rule 10).',
              },
            ],
          },
        ],
        model: env.MODEL_MAIN,
        temperature: 0.4,
      })
      promptTokens += forced.usage.promptTokens
      outputTokens += forced.usage.outputTokens
      text = forced.text ?? ''
    } catch {
      /* fall through to the plain apology below */
    }
  }

  if (!text.trim() && !repliedInTool && outcomes.length === 0) {
    text = "Sorry — I looked that up but couldn't get an answer together. Ask me again and I'll have another go."
  }

  if (text.trim() && !repliedInTool) {
    // §4.3 — "after every action the bot takes, it offers the natural next step as
    // a button". A plan that was previewed and not committed has exactly one natural
    // next step, and the runtime knows it: the steps are already validated and
    // diff-computed, so the button carries them verbatim (§2.2). Leaving this to the
    // model means a confirmation sometimes arrives as prose with nothing to tap,
    // which is how the preview→commit path quietly stops being button-driven.
    const pending = [...toolCtx.pendingPlans.entries()].at(-1)
    const meta = pending ? toolCtx.pendingMeta?.get(pending[0]) : undefined
    let buttons: { title: string; action: ActionPayload }[] | undefined

    if (pending) {
      const [, steps] = pending
      const summary = meta?.summary || meta?.intent || 'the change we just went through'
      buttons = [{ title: 'Do it', action: { kind: 'steps', steps, summary } }]
      if ((meta?.totalRows ?? 0) > 3) {
        buttons.push({ title: `Show me all ${meta!.totalRows}`, action: { kind: 'reply', text: 'show me everyone that affects' } })
      }
      buttons.push({ title: 'Cancel', action: { kind: 'noop', ack: 'Left as it was — nothing changed.' } })
    }

    outcomes.push(
      await composeAndSend(session, {
        toContactId: identity.contact.id,
        body: lint(text.trim(), identity),
        buttons,
      }),
    )
  }

  return { outcomes, toolCalls, text, model, promptTokens, outputTokens }
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
  latencyMs: number
  error?: string
}): Promise<void> {
  try {
    await withSession({ role: 'service', academyId: o.identity.academyId }, async (tx) => {
      await tx.unsafe(
        `insert into turn (id, academy_id, contact_id, person_id, role_acted, input, output, model,
                           prompt_tokens, output_tokens, latency_ms, error)
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
                 ${lit(o.latencyMs)}, ${lit(o.error ?? null)})`,
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

    const res = await generate({
      system: `${stablePrefix()}\n\n${GROUNDING}\n\n${mix}`,
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
      await writeSynthTurn(academyId, turnId, kind, admins[0], { sent: false }, model, Date.now() - startedMs)
      return { turnId, sent: [], toolCalls: 0 }
    }

    for (const admin of admins) {
      if (!admin.contact_id) continue
      outcomes.push(
        await composeAndSend(svc, {
          toContactId: admin.contact_id,
          catalogId: kind === 'brief' ? 'AD-MORNING-BRIEF' : 'AD-EVENING-DIGEST',
          body: lintForAdmin(body, academyId),
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
    )
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  return { turnId, sent: outcomes, toolCalls: 0, error }
}

/** The lint pass wants an Identity; synthesis runs without one, so this is the
 *  subset that still applies: no uuids, no table names in the admin's brief. */
function lintForAdmin(text: string, academyId: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '')
    .replace(/\b(tally_line|session_coach|class_slot|academy_admin|memory_fact|audit_entry)\b/g, (m) =>
      m.replace(/_/g, ' '),
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
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
    const needs_you_uncovered = await many(`select c.name as class_name, s.starts_at
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
    const delivery = await one(`select count(*) filter (where status in ('sent','delivered','read')) as sent,
                    count(*) filter (where status = 'delivered' or status = 'read') as delivered,
                    count(*) filter (where status = 'read') as read,
                    count(*) filter (where status = 'failed') as failed,
                    count(*) filter (where suppressed_reason is not null) as suppressed,
                    coalesce(sum(cost_paise), 0) as cost_paise
               from message
              where academy_id = ${A} and direction = 'outbound'
                and queued_at > app.now() - interval '24 hours'`)
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
        uncovered_sessions_next_36h: needs_you_uncovered,
        registers_unmarked: registers_unmarked,
        coaches_invited_but_not_onboarded: coaches_not_onboarded,
      },
      money: { unpaid_accounts: unpaid },
      delivery_last_24h: delivery,
      attendance_last_30d_by_class: attendance_30d,
      attendance_previous_30d_by_class: attendance_prev_30d,
      new_trials_last_7d: new_trials_7d,
      contacts_silent_90d: quiet_contacts,
    }
  })
}

async function writeSynthTurn(
  academyId: string,
  turnId: string,
  kind: string,
  admin: { person_id: string; contact_id: string | null },
  output: unknown,
  model: string | undefined,
  latencyMs: number,
): Promise<void> {
  try {
    await withSession({ role: 'service', academyId }, async (tx) => {
      await tx.unsafe(
        `insert into turn (id, academy_id, contact_id, person_id, role_acted, input, output, model, latency_ms)
         values (${uid(turnId)}, ${uid(academyId)}, ${admin.contact_id ? uid(admin.contact_id) : 'null'},
                 ${uid(admin.person_id)}, 'admin', ${jsonLit({ synthesis: kind })}, ${jsonLit(output)},
                 ${lit(model ?? null)}, ${lit(latencyMs)})`,
      )
    })
  } catch {
    /* never let instrumentation break the digest */
  }
}

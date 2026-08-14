/**
 * lib/agent/steps.ts — what a step is, and what a button's action is. One
 * definition, in one place.
 *
 * This file exists because there were two. `plan.ts` validated model-authored
 * steps strictly — every operation name checked against the registry, every
 * nested button action checked recursively — while `actions.ts`, the module
 * that actually *mints* the button, checked `steps: z.array(z.unknown())`.
 *
 * The gap was not theoretical. A confirmation button was minted carrying
 * `[{operation:{name:'commit', …}}]` — `commit` is a tool, not an operation, so
 * no such plan can ever run. It passed the loose schema, was stored, was shown
 * to the admin, and failed at the *tap*: the one moment with no model in the
 * loop, nothing to fall back on, and a person who has just said yes. Two
 * classes were lost that way in a single onboarding.
 *
 * So: a payload is validated for MEANING at mint time, not merely for shape,
 * and both callers validate it the same way, because they share this file.
 * §6.5's "fully resolved at mint time" is only true if resolution is checked.
 */

import { z } from 'zod'

import { LIMITS } from '@/lib/messaging/types'
import { isFlowId } from '@/lib/messaging/flows'
import { OPERATIONS } from './operations'

/* ------------------------------------------------------------------------- *
 * Action payloads
 * ------------------------------------------------------------------------- */

export const ActionPayloadSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z
      .object({
        kind: z.literal('operation'),
        // Checked against the registry, not merely typed as a string. An action is
        // replayed with no model call, so a name that does not exist is a dead
        // button and there is nobody there to recover from it.
        // Same explanation the plan path gives: a button carrying a tool name is the
        // same confusion arriving one layer down, and it is worth the same sentence.
        op: z.string().refine((n) => n in OPERATIONS, (n) => ({ message: notAnOperation(n) })),
        args: z.record(z.unknown()).default({}),
      })
      // And its ARGUMENTS, by the operation's own schema — which this branch did not
      // do, while `PlanStepSchema` two hundred lines below did. C12 was the same
      // defect on the `steps` branch and was fixed there only, so the *other* kind of
      // button kept dying at the tap for the same reason.
      //
      // Watched, on the single most important button in coach onboarding: a coach
      // tapped `[Looks right]`, the payload carried `confirm_coach` with a `coach_id`
      // and no `session_id`, and it failed at the tap — the one moment with no model
      // in the loop, on a person's first ever contact with the product. They were told
      // "that didn't go through". Nothing made them active, and nothing ever would.
      .superRefine((payload, ctx) => {
        const def = OPERATIONS[payload.op as keyof typeof OPERATIONS] as { params?: z.ZodTypeAny } | undefined
        if (!def?.params) return
        const parsed = def.params.safeParse(payload.args)
        if (parsed.success) return
        for (const issue of parsed.error.issues.slice(0, 3)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['args', ...issue.path],
            message: `${payload.op}: ${issue.message}`,
          })
        }
      }),
    z.object({
      kind: z.literal('steps'),
      steps: StepsField(),
      summary: z.string(),
    }),
    z.object({ kind: z.literal('reply'), text: z.string().min(1) }),
    // A view button is either a spec this turn authored, or one of the two
    // screens the product ships. The second form exists because the model kept
    // writing it — `{kind:'view', screen:'setup'}` was its first instinct for
    // "put the setup form behind a button", which is exactly right and was
    // rejected as invalid. The link itself is minted fresh on tap, which is
    // better than a URL in the body: §15's TTLs are short on purpose.
    z.union([
      z.object({ kind: z.literal('view'), viewSpecId: z.string().min(1) }),
      z.object({
        kind: z.literal('view'),
        screen: z.enum(['setup', 'register']),
        ref: z.string().optional(),
      }),
    ]),
    z.object({ kind: z.literal('menu'), menu: z.string().min(1) }),
    z.object({ kind: z.literal('noop'), ack: z.string() }),
    // §14.8's escape hatch, as a button. The model kept minting
    // `{kind:'operation', op:'handoff'}` — a tool name where an operation name
    // goes — because a button is what it wanted: §8.1's coach confirmation is
    // `[Looks right] [Something's wrong]`, and the second one has to reach a
    // person. Refusing it dropped the button and left the coach with a
    // confirmation they could only agree to.
    z.object({ kind: z.literal('handoff'), reason: z.string().min(1), summary: z.string().min(1) }),
    // A WhatsApp Flow submission. Checked against the registry for the same reason
    // an operation name is: the action is replayed with no model in the loop, so a
    // flow name that does not exist is a form somebody filled in for nothing.
    z.object({
      kind: z.literal('flow'),
      flow: z.string().refine(isFlowId, { message: 'unknown flow' }),
    }),
  ]),
)

/* ------------------------------------------------------------------------- *
 * Steps
 * ------------------------------------------------------------------------- */

const MessageStepSchema = z.object({
  to_contact_id: z.string().optional(),
  to_person_id: z.string().optional(),
  body: z.string().min(1),
  header: z.string().optional(),
  footer: z.string().optional(),
  buttons: z
    .array(
      z.object({
        title: z.string().min(1),
        action: ActionPayloadSchema,
        ttl_minutes: z.number().int().positive().optional(),
      }),
    )
    .max(LIMITS.buttons)
    .optional(),
  catalog_id: z.string().nullable().optional(),
  fixed: z.boolean().optional(),
  subject_person_ids: z.array(z.string()).optional(),
  is_confirmation_request: z.boolean().optional(),
  is_escalation: z.boolean().optional(),
})

/**
 * The shape the model plainly meant, in the shape the schema wants.
 *
 * `{"operation": "create_class", "args": {…}}` is not a different plan from
 * `{"operation": {"name": "create_class", "args": {…}}}` — it is the same plan with the
 * nesting flattened, and it is what the model writes perhaps a third of the time. It
 * was refused, and what came back was a five-branch zod union dump; the model
 * apologised to the admin and created nothing.
 *
 * `resolveAction` already normalises the identical instinct for button payloads, with
 * the identical reasoning ("the discriminator is the one field with no information in
 * it"). The rule generalises: **normalise at the boundary, once, rather than making
 * every author guess which encoding this caller wanted.** Rejecting a correct plan on a
 * formatting technicality costs a turn and teaches nobody anything.
 */
function normalizeStep(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const step = raw as Record<string, unknown>
  if (typeof step.operation === 'string') {
    return { operation: { name: step.operation, args: (step.args ?? {}) as Record<string, unknown> } }
  }
  // `{"name": "create_class", "args": {…}}` — the wrapper dropped entirely.
  if (typeof step.name === 'string' && step.args !== undefined && step.write === undefined) {
    return { operation: { name: step.name, args: step.args as Record<string, unknown> } }
  }
  return step
}

export const PlanStepSchema: z.ZodTypeAny = z.lazy(() =>
  z.preprocess(normalizeStep, z.union([
    z.object({ write: z.string().min(1) }),
    // The operation's own parameter schema is applied HERE, not only when the
    // step runs. A button carrying `add_family` with `player_name` where the
    // schema says `name` passed every check that existed, was minted, was shown
    // to an admin as `[Add families]`, and died on the tap — where there is no
    // model, no retry, and the person has just said yes. The zod error reached
    // their phone verbatim.
    //
    // Validating at mint costs one parse and moves that failure to the only
    // moment it can be repaired: while the model is still in the room.
    z
      .object({
        operation: z.object({
          name: z.string().refine((n) => n in OPERATIONS, (n) => ({ message: notAnOperation(n) })),
          args: z.record(z.unknown()).default({}),
        }),
      })
      .superRefine((step, ctx) => {
        const def = OPERATIONS[step.operation.name as keyof typeof OPERATIONS] as { params?: z.ZodTypeAny } | undefined
        if (!def?.params) return
        const parsed = def.params.safeParse(step.operation.args)
        if (parsed.success) return
        for (const issue of parsed.error.issues.slice(0, 3)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['operation', 'args', ...issue.path],
            message: `${step.operation.name}: ${issue.message}`,
          })
        }
      }),
    z.object({
      adjust: z.object({
        account_id: z.string(),
        player_id: z.string().nullable().optional(),
        amount: z.number(),
        reason: z.string().min(1),
        period: z.string().optional(),
        description: z.string().optional(),
      }),
    }),
    z.object({ message: MessageStepSchema }),
    z.object({
      schedule: z.object({
        kind: z.string(),
        run_at: z.string(),
        dedupe_key: z.string().min(1),
        payload: z.record(z.unknown()).default({}),
      }),
    }),
  ])),
)

/**
 * A list of steps, however it arrived.
 *
 * `plan` takes its steps as a JSON *string* on purpose: a five-way union nested
 * four deep malformed Vertex's function-call decoder two times in three, and a
 * string has no shape to malform. The cost of that fix is that the model now
 * believes steps are a string — and wrote one into a button payload, where the
 * schema wanted an array and rejected it silently.
 *
 * Accepting both is not laxity. It is the same value in the two encodings the
 * product itself uses, normalised once, at the boundary, instead of each caller
 * guessing which one it has.
 */
function StepsField(): z.ZodTypeAny {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return v
    try {
      return JSON.parse(v)
    } catch {
      return v
    }
  }, z.array(z.lazy(() => PlanStepSchema)).min(1))
}

/**
 * Validate model-authored steps. Throws on anything that is not a step — with a
 * sentence, not a zod dump.
 *
 * `.parse()` throws a `ZodError` whose `.message` is the serialised issue tree, and for
 * a five-branch union that is 1,500 characters of `unionErrors` describing four branches
 * the author never intended. It reached the model verbatim. There is nothing in it to
 * act on, so what the model did was apologise to the admin and create nothing.
 */
export function parseSteps(raw: unknown): unknown[] {
  const parsed = StepsField().safeParse(raw)
  if (parsed.success) return parsed.data as unknown[]
  throw new Error(describe(parsed.error))
}

/**
 * The same validation, without the throw — for the mint path, which has to be
 * able to say *which* button is wrong rather than losing the whole message.
 */
export function checkSteps(raw: unknown): { ok: true; steps: unknown[] } | { ok: false; error: string } {
  const parsed = StepsField().safeParse(raw)
  if (parsed.success) return { ok: true, steps: parsed.data as unknown[] }
  return { ok: false, error: describe(parsed.error) }
}

/**
 * Why that name is not an operation, and what to write instead.
 *
 * "unknown operation" is true and unactionable, and a clean drive of the whole
 * lifecycle showed exactly what it costs. Asked to go live, the model composed
 * `{"operation":{"name":"schedule", …}}` — reaching for the follow-up it correctly
 * wanted — got "unknown operation" back, rewrote the same plan, got it again, and gave
 * up. The business never went live, and everything downstream of that failed with it:
 * no UPI handle recorded, no payment confirmable, and the admin told twice in identical
 * words that it had not worked. One unhelpful sentence, most of a lifecycle.
 *
 * The confusion is honest, and the runtime is the thing that knows the answer: several
 * of these names ARE real capabilities, just reached a different way inside a plan.
 * A plan schedules with a step of its own and sends with a step of its own; it does not
 * call the tools that do those things at the top level.
 */
const NOT_OPERATIONS: Record<string, string> = {
  schedule:
    'a plan schedules its own follow-up with a step of its own: {"schedule": {"kind", "run_at", "dedupe_key", "payload"}}',
  reply: 'a plan sends with a step of its own: {"message": {"to_contact_id"|"to_person_id", "body", "buttons"?}}',
  view: 'a plan cannot open a screen — send the message first, and offer the screen on it',
  read: 'a plan does not read; do the lookup before you compose it, and put the answer in the steps',
  handoff: 'reaching a person is a button on a message step, not an operation',
  plan: 'you are already inside a plan',
  commit: 'you are already inside a plan — there is nothing here to commit',
  act: 'inside a plan an operation is the step itself: {"operation": {"name", "args"}}',
}

function notAnOperation(name: string): string {
  const instead = NOT_OPERATIONS[name]
  if (instead) return `"${name}" is a tool, not an operation — ${instead}`
  return `there is no operation called "${name}"`
}

/* ------------------------------------------------------------------------- *
 * Claims about what a human did
 * ------------------------------------------------------------------------- */

/**
 * Operation parameters that assert **a human already acted**, and which the model
 * must therefore never set.
 *
 * Every value of these in the codebase is written by the runtime into a button that
 * the operation itself mints — `cancel_session` mints `{confirmed:true}`,
 * `client_cancel` mints `{confirmed:true}`, `opt_out` and `undo` the same, and
 * `send_invite_draft` mints `{mark_sent:true}` behind `[Sent it]`. That is what they
 * mean: *this call is a replay of a button somebody tapped.* Nothing else produces
 * one, so a model that sets one is claiming a tap that never happened.
 *
 * Watched live, twice: asked to add a coach and send the invite, the model set
 * `mark_sent` on its own initiative on the FIRST request. `send_invite_draft` with
 * `mark_sent` does not draft anything — so no invite message existed at all, the
 * coach was written to `invited` (making every "chase the uninvited" path skip her
 * forever), and the admin was told *"Noted — Nisha Rao's invite is out."* The tool
 * returned `ok: true`. Nothing anywhere disagreed.
 *
 * This is the same idea as stripping `requireRows` and `write.service` from
 * model-authored plans, applied to a claim about the world rather than a privilege:
 * **the runtime keeps the fields the model must not set.**
 *
 * WHAT IS DELIBERATELY NOT HERE, and why the list is not "every boolean":
 *
 *   - `arrived`, `running_late`, `all_present` — these relay what the person
 *     SPEAKING RIGHT NOW just said about themselves. §8.2 ("free text always
 *     works") is exactly the coach typing *"reached"* or *"running late"*, and the
 *     model has direct evidence for it: the sentence is in the turn. Stripping
 *     these would delete a documented capability to fix a defect they do not have.
 *   - `notify` / `notify_parents` — a delivery preference, not a claim about the
 *     world.
 *
 * The line is: does this parameter assert that **something already happened that
 * the model did not witness**? If yes it belongs here; if it relays the speaker's
 * own words, it does not.
 */
export const HUMAN_ASSERTION_PARAMS = ['confirmed', 'mark_sent'] as const

function stripArgs(args: unknown, op: string, stripped: string[]): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args
  const rec = args as Record<string, unknown>
  let out: Record<string, unknown> | null = null
  for (const key of HUMAN_ASSERTION_PARAMS) {
    // Only a truthy value is a claim. `confirmed: false` is the honest default and
    // removing it would be noise in the note the model reads back.
    if (rec[key]) {
      out ??= { ...rec }
      delete out[key]
      stripped.push(`${op}.${key}`)
    }
  }
  return out ?? rec
}

function stripPayload(payload: unknown, stripped: string[]): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload
  const p = payload as Record<string, unknown>
  if (p.kind === 'operation' && typeof p.op === 'string') {
    const args = stripArgs(p.args, p.op, stripped)
    return args === p.args ? p : { ...p, args }
  }
  if (p.kind === 'steps' && Array.isArray(p.steps)) {
    const steps = stripHumanAssertions(p.steps, stripped)
    return steps === p.steps ? p : { ...p, steps }
  }
  return p
}

/**
 * Remove every human-assertion parameter from model-authored steps, at every depth
 * a step can carry one: the step's own operation, and the operation behind any
 * button on a message step — including a button carrying a whole nested plan.
 *
 * Returns the names it removed so the caller can TELL the model, rather than
 * silently changing what it asked for. A silent strip would produce the same
 * confusion the defect did, one layer down: the model would believe the invite was
 * marked sent and say so.
 *
 * NOT applied in `plan.ts` or on the tap path, on purpose. The identical payload
 * arriving from a real tap is the legitimate case this field exists for, and
 * `loop.ts` builds those steps directly from the stored action. The strip belongs
 * where "the model wrote this" is known, which is only here.
 */
export function stripHumanAssertions(steps: unknown[], into?: string[]): unknown[] {
  const stripped = into ?? []
  let changed = false
  const out = steps.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
    const step = raw as Record<string, unknown>

    if (step.operation && typeof step.operation === 'object') {
      const op = step.operation as Record<string, unknown>
      const args = stripArgs(op.args, String(op.name ?? 'operation'), stripped)
      if (args !== op.args) {
        changed = true
        return { ...step, operation: { ...op, args } }
      }
    }

    if (step.message && typeof step.message === 'object') {
      const msg = step.message as Record<string, unknown>
      if (Array.isArray(msg.buttons)) {
        let btnChanged = false
        const buttons = msg.buttons.map((b) => {
          if (!b || typeof b !== 'object') return b
          const btn = b as Record<string, unknown>
          const action = stripPayload(btn.action, stripped)
          if (action === btn.action) return btn
          btnChanged = true
          return { ...btn, action }
        })
        if (btnChanged) {
          changed = true
          return { ...step, message: { ...msg, buttons } }
        }
      }
    }

    return step
  })
  return changed ? out : steps
}

/** The single-operation form, for the `act` tool and every operation-named tool. */
export function stripHumanAssertionsFromArgs(
  op: string,
  args: unknown,
): { args: unknown; stripped: string[] } {
  const stripped: string[] = []
  return { args: stripArgs(args, op, stripped), stripped }
}

/** The single-payload form, for a model-authored button or list row. */
export function stripHumanAssertionsFromPayload(
  payload: unknown,
): { payload: unknown; stripped: string[] } {
  const stripped: string[] = []
  return { payload: stripPayload(payload, stripped), stripped }
}

/**
 * The sentence the model is told when something was stripped. It names the button
 * to offer instead, because the intent was legitimate — the model wanted the coach
 * marked invited — and the only thing wrong was who is entitled to say it happened.
 */
export function humanAssertionNote(stripped: string[]): string {
  const names = [...new Set(stripped)].join(', ')
  return (
    `Ignored ${names}: those say a person has already done something, and only that person's own tap can set them. ` +
    `The draft/preview was produced instead — offer it, and let them tap to confirm it happened.`
  )
}

export function checkActionPayload(raw: unknown): { ok: true; payload: unknown } | { ok: false; error: string } {
  const parsed = ActionPayloadSchema.safeParse(raw)
  if (parsed.success) return { ok: true, payload: parsed.data }
  return { ok: false, error: describe(parsed.error) }
}

/**
 * Zod's issue list, as one sentence a model can act on.
 *
 * A union's issues are five parallel accounts of five branches the author did not take,
 * and reporting all of them is worse than reporting none: the useful one is the branch
 * that got *furthest*, which is the branch whose discriminating key was actually
 * present. That is what "you meant an operation and its arguments are wrong" looks like,
 * as opposed to "you also failed to be a write, an adjustment, a message and a schedule".
 */
function describe(err: z.ZodError): string {
  const flat: { path: (string | number)[]; message: string }[] = []

  const walk = (issues: z.ZodIssue[], depth: number): void => {
    for (const i of issues) {
      if (i.code === z.ZodIssueCode.invalid_union && depth < 3) {
        const branches = (i as z.ZodInvalidUnionIssue).unionErrors ?? []
        // The branch with the fewest complaints is the one the author was closest to.
        // A branch that only objects to a key being absent is a branch nobody meant.
        const best = branches
          .map((b) => b.issues)
          .filter((is) => !is.every((x) => x.code === 'invalid_type' && x.message === 'Required'))
          .sort((a, b) => a.length - b.length)[0]
        if (best?.length) {
          walk(best, depth + 1)
          continue
        }
        flat.push({
          path: i.path,
          message:
            'not a step — each element has exactly one of: write, operation, adjust, message, schedule',
        })
        continue
      }
      flat.push({ path: i.path, message: i.message })
    }
  }
  walk(err.issues, 0)

  const seen = new Set<string>()
  const lines: string[] = []
  for (const i of flat) {
    const path = i.path.length ? `step ${i.path.join('.')}` : 'the plan'
    const line = `${path}: ${i.message}`
    if (seen.has(line)) continue
    seen.add(line)
    lines.push(line)
    if (lines.length === 3) break
  }
  return lines.join('; ') || 'not a valid plan'
}

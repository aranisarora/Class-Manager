/**
 * lib/messaging/flows.ts — the Flow JSON artifacts, and what comes back.
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * Onboarding asks a new business six things before anything useful can happen:
 * what the place is called, what kind of thing it is, where they play, the hours,
 * how much notice a cancellation needs, and where money should go. In a chat that
 * is six round trips — six model calls, six waits, and six chances for somebody to
 * put the phone down halfway. Driven from empty, the first reply the product ever
 * sends was measured at 102 words and it still only asked for one of the six.
 *
 * A Flow is the one affordance on WhatsApp that takes all six at once, inside the
 * chat, with no browser, no login and no link. `types.ts` carries the argument for
 * why a static Flow is affordable where an endpoint-powered one is not.
 *
 * WHAT IS AND IS NOT MODELLED
 * -----------------------------------------------------------------------------
 * This repo does not call Meta — the emulator is the surface, and §17's rule is
 * "something that works here works there". So the Flow JSON below is the real
 * artifact in the real shape, and `validateFlowJson` re-checks the rules Meta
 * applies when you publish, because a Flow that would fail publish is a Flow that
 * cannot ship no matter how well it renders locally. What is NOT here is the
 * publishing itself (`POST /{WABA}/flows`, `/assets`, `/publish`) — that is an
 * account operation, not a runtime one, and it belongs with the other Meta calls
 * behind `transport-cloud.ts` on the day this connects to a real number.
 *
 * THE RULES BEING ENFORCED, and where they come from
 * -----------------------------------------------------------------------------
 *   - `version` and `screens` are the only required top-level properties.
 *   - `routing_model` is required only for endpoint-powered flows. These are not,
 *     so it is deliberately absent and Meta derives it.
 *   - Screen id `SUCCESS` is reserved.
 *   - A `terminal` screen MUST carry a `Footer`, and that footer's action must be
 *     `complete` — a `navigate` on a terminal footer is a flow that can never end,
 *     and Meta rejects it at publish.
 *   - Every form component needs a `name`.
 *   - `${form.x}` reads this screen's inputs; `${data.x}` reads what was passed in.
 *   - `null` is not a supported dynamic value. Omit the key instead.
 */

import { z } from 'zod'

/* ------------------------------------------------------------------------- *
 * The artifact
 * ------------------------------------------------------------------------- */

export type FlowComponent = Record<string, unknown> & { type: string; name?: string }

export type FlowScreen = {
  id: string
  title?: string
  terminal?: boolean
  success?: boolean
  data?: Record<string, unknown>
  layout: { type: 'SingleColumnLayout'; children: FlowComponent[] }
}

export type FlowJson = {
  version: string
  screens: FlowScreen[]
}

export type FlowDefinition = {
  /** Stable key the runtime uses to decide what a submission means. */
  id: string
  /** What Meta would call it. */
  name: string
  /** The screen a `navigate` send opens on. */
  entryScreen: string
  /** The CTA on the bubble. <= 20 chars, no emoji. */
  cta: string
  json: FlowJson
  /** Parses `response_json` into something the runtime is willing to act on. */
  response: z.ZodTypeAny
}

/**
 * Flow JSON version. 7.2 is a current published version; the only thing this build
 * depends on is `${form.x}` binding and `complete`, both of which are far older.
 */
const FLOW_VERSION = '7.2'

/* ------------------------------------------------------------------------- *
 * onboarding_setup — the shape of the business, in one screen
 * ------------------------------------------------------------------------- */

/**
 * One screen, not six.
 *
 * It is deliberately the SAME set of fields the `setup` web screen collects, and it
 * commits through the same plan builder, because a second implementation of one
 * event is the defect this repo has hit most often — the register screen wrote
 * attendance with its own SQL for most of the product's life and produced no money
 * for any of it. A Flow is a different way to reach the setup plan, never a second
 * setup.
 *
 * Everything optional is genuinely optional. A business with no UPI handle is a
 * real business (cash), and refusing to let them past this screen would be the
 * product inventing a policy nobody chose.
 */
const ONBOARDING_SETUP_JSON: FlowJson = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'SETUP',
      title: 'Your business',
      terminal: true,
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextBody',
            text: 'A few basics and I can take it from here. You can change any of this later.',
          },
          {
            type: 'TextInput',
            name: 'name',
            label: 'Business name',
            'input-type': 'text',
            required: true,
            'init-value': '${data.name}',
          },
          {
            type: 'TextInput',
            name: 'category',
            label: 'What you teach',
            'helper-text': 'Badminton, vocal, chess…',
            'input-type': 'text',
            required: false,
            'init-value': '${data.category}',
          },
          {
            type: 'TextInput',
            name: 'venue',
            label: 'Where you play',
            'helper-text': 'The hall or court name',
            'input-type': 'text',
            required: true,
          },
          {
            type: 'Dropdown',
            name: 'cancellation_window_hours',
            label: 'Notice needed to cancel',
            required: true,
            'init-value': '24',
            'data-source': [
              { id: '2', title: '2 hours' },
              { id: '6', title: '6 hours' },
              { id: '12', title: '12 hours' },
              { id: '24', title: '24 hours' },
              { id: '48', title: '48 hours' },
            ],
          },
          {
            type: 'TextInput',
            name: 'upi_handle',
            label: 'UPI handle for fees',
            'helper-text': 'Leave blank if you take cash',
            'input-type': 'text',
            required: false,
          },
          {
            type: 'Footer',
            label: 'Save',
            'on-click-action': {
              name: 'complete',
              payload: {
                name: '${form.name}',
                category: '${form.category}',
                venue: '${form.venue}',
                cancellation_window_hours: '${form.cancellation_window_hours}',
                upi_handle: '${form.upi_handle}',
              },
            },
          },
        ],
      },
    },
  ],
}

/**
 * What the runtime will accept back.
 *
 * Everything arrives as a STRING — `response_json` is a JSON string on the wire and
 * every form value inside it is text, including the dropdown's number. Coercing
 * here rather than at the use site is the same "normalise once, at the boundary"
 * rule `parseSteps` follows.
 *
 * Nothing here is trusted. A Flow response is user input arriving over the wire; it
 * is exactly as authoritative as a typed message, which is to say not at all. The
 * plan it feeds runs under the submitter's own RLS session like everything else.
 */
const OnboardingSetupResponse = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(80).optional().default(''),
  venue: z.string().trim().min(1).max(120),
  cancellation_window_hours: z.coerce.number().int().min(0).max(168).default(24),
  upi_handle: z.string().trim().max(120).optional().default(''),
})

export type OnboardingSetupValues = z.infer<typeof OnboardingSetupResponse>

export const ONBOARDING_SETUP: FlowDefinition = {
  id: 'onboarding_setup',
  name: 'Business setup',
  entryScreen: 'SETUP',
  cta: 'Set up',
  json: ONBOARDING_SETUP_JSON,
  response: OnboardingSetupResponse,
}

export const FLOWS: Record<string, FlowDefinition> = {
  [ONBOARDING_SETUP.id]: ONBOARDING_SETUP,
}

export function isFlowId(s: string): s is keyof typeof FLOWS {
  return s in FLOWS
}

/* ------------------------------------------------------------------------- *
 * Validation — the rules Meta applies at publish
 * ------------------------------------------------------------------------- */

/**
 * Every way this artifact would be rejected at publish, as human sentences.
 * Empty array = publishable. Same contract as `validateOutbound`, and the same
 * reasoning: a Flow that renders here and fails there is worse than one that fails
 * in both places, because only one of those two is discoverable.
 */
export function validateFlowJson(flow: FlowJson): string[] {
  const bad: string[] = []

  if (!flow.version) bad.push('a flow needs a version')
  if (!Array.isArray(flow.screens) || flow.screens.length === 0) {
    bad.push('a flow needs at least one screen')
    return bad
  }

  const ids = new Set<string>()
  let terminals = 0

  for (const screen of flow.screens) {
    if (!screen.id) {
      bad.push('a screen has no id')
      continue
    }
    if (screen.id === 'SUCCESS') bad.push('SUCCESS is a reserved screen id')
    if (ids.has(screen.id)) bad.push(`two screens share the id ${screen.id}`)
    ids.add(screen.id)

    const children = screen.layout?.children
    if (screen.layout?.type !== 'SingleColumnLayout') {
      bad.push(`screen ${screen.id} must use SingleColumnLayout`)
    }
    if (!Array.isArray(children) || children.length === 0) {
      bad.push(`screen ${screen.id} has no children`)
      continue
    }

    const footers = children.filter((c) => c.type === 'Footer')
    if (screen.terminal) {
      terminals += 1
      if (footers.length === 0) {
        bad.push(`terminal screen ${screen.id} has no Footer, so it cannot be submitted`)
      }
      for (const f of footers) {
        const action = (f['on-click-action'] ?? {}) as { name?: string }
        // The failure this catches is not cosmetic: a terminal screen whose footer
        // navigates is a flow with no way to finish, and the person is stuck inside
        // it with no route back to the conversation.
        if (action.name !== 'complete') {
          bad.push(
            `terminal screen ${screen.id}'s footer must complete the flow, not ${action.name ?? 'nothing'}`,
          )
        }
      }
    }

    const names = new Set<string>()
    for (const c of children) {
      if (!c.type) bad.push(`screen ${screen.id} has a component with no type`)
      // Every form component is addressed by name — both in `${form.x}` and in the
      // response — so an unnamed one silently drops the answer.
      if (FORM_COMPONENTS.has(String(c.type))) {
        if (!c.name) bad.push(`a ${c.type} on ${screen.id} has no name`)
        else if (names.has(c.name)) bad.push(`two components on ${screen.id} share the name ${c.name}`)
        else names.add(String(c.name))
      }
      if (JSON.stringify(c).includes('null')) {
        // Meta's dynamic references have no null: the documented instruction is to
        // omit the key. A null reaches the phone as the literal word.
        bad.push(`a ${c.type} on ${screen.id} carries a null — omit the key instead`)
      }
    }
  }

  if (terminals === 0) bad.push('no screen is terminal, so the flow can never finish')
  if (JSON.stringify(flow).length > 10 * 1024 * 1024) bad.push('flow json exceeds 10 MB')

  return bad
}

const FORM_COMPONENTS = new Set([
  'TextInput', 'TextArea', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup',
  'OptIn', 'DatePicker', 'PhotoPicker', 'DocumentPicker',
])

/**
 * Parse what came back from a Flow, by flow id.
 *
 * `raw` is whatever `nfm_reply.response_json` held. On the real wire that is a
 * STRING containing JSON; the emulator can hand over an object directly. Both are
 * accepted, because the difference is an encoding detail of the transport and not
 * something any caller should have to know.
 */
export function parseFlowResponse(
  flowId: string,
  raw: unknown,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const def = FLOWS[flowId]
  if (!def) return { ok: false, error: `there is no flow called ${flowId}` }

  let payload: unknown = raw
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw)
    } catch {
      return { ok: false, error: 'the flow response was not valid JSON' }
    }
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'the flow response was not an object' }
  }

  // `flow_token` rides inside the response on the real wire and is not a form field.
  const { flow_token: _token, ...fields } = payload as Record<string, unknown>

  const parsed = def.response.safeParse(fields)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      error: issue ? `${issue.path.join('.') || 'that form'}: ${issue.message}` : 'that form did not parse',
    }
  }
  return { ok: true, values: parsed.data as Record<string, unknown> }
}

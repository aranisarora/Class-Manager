/**
 * check-flows — does every shipped Flow artifact pass the rules Meta applies at publish?
 *
 * `validateFlowJson` existed and nothing called it, which is the exact shape of defect
 * this repo keeps finding: a check that is written, correct, and never run. A Flow that
 * fails publish cannot ship however well it renders locally, and the failure would arrive
 * as a Meta API rejection at the moment somebody tried to go live.
 *
 *   npx tsx scripts/check-flows.mts
 */
import { FLOWS, validateFlowJson } from '@/lib/messaging/flows'
import { EXTRA_LIMITS } from '@/lib/messaging/types'

let failed = 0
for (const [id, def] of Object.entries(FLOWS)) {
  const bad = validateFlowJson(def.json)

  // The CTA rides on the message, not in the artifact, so `validateFlowJson` cannot see
  // it — but it is fixed per flow and Meta rejects the send, not the publish, when it is
  // wrong. Checking it here is the only place it can be caught before a person is missing
  // a message.
  if ([...def.cta].length > EXTRA_LIMITS.flowCtaChars) {
    bad.push(`cta "${def.cta}" is ${[...def.cta].length} chars, limit ${EXTRA_LIMITS.flowCtaChars}`)
  }
  if (!def.json.screens.some((s) => s.id === def.entryScreen)) {
    bad.push(`entryScreen "${def.entryScreen}" is not a screen in this flow`)
  }

  if (bad.length) {
    failed += 1
    console.log(`FAIL ${id}`)
    for (const b of bad) console.log(`  - ${b}`)
  } else {
    console.log(`pass ${id} (${def.json.screens.length} screen(s), cta "${def.cta}")`)
  }
}

/**
 * And the other half of the question: does the validator actually reject anything?
 *
 * A check that passes because it cannot fail is the defect this repo keeps finding, and
 * `validateFlowJson` was written and never called until now. Each case below is a real
 * Meta publish rejection, and each must be caught.
 */
const MUST_REJECT: { why: string; flow: any }[] = [
  {
    why: 'a terminal screen whose footer navigates instead of completing — a flow nobody can finish',
    flow: {
      version: '7.2',
      screens: [{
        id: 'A', terminal: true,
        layout: { type: 'SingleColumnLayout', children: [
          { type: 'Footer', label: 'Go', 'on-click-action': { name: 'navigate' } },
        ] },
      }],
    },
  },
  {
    why: 'a dynamic reference to data the screen never declares',
    flow: {
      version: '7.2',
      screens: [{
        id: 'A', terminal: true,
        layout: { type: 'SingleColumnLayout', children: [
          { type: 'TextInput', name: 'x', label: 'X', 'init-value': '${data.ghost}' },
          { type: 'Footer', label: 'Go', 'on-click-action': { name: 'complete', payload: {} } },
        ] },
      }],
    },
  },
  {
    why: 'a declared data property with no __example__ for Meta to validate against',
    flow: {
      version: '7.2',
      screens: [{
        id: 'A', terminal: true, data: { q: { type: 'string' } },
        layout: { type: 'SingleColumnLayout', children: [
          { type: 'TextInput', name: 'x', label: 'X', 'init-value': '${data.q}' },
          { type: 'Footer', label: 'Go', 'on-click-action': { name: 'complete', payload: {} } },
        ] },
      }],
    },
  },
  {
    why: 'a form component with no name, so its answer is silently dropped',
    flow: {
      version: '7.2',
      screens: [{
        id: 'A', terminal: true,
        layout: { type: 'SingleColumnLayout', children: [
          { type: 'TextInput', label: 'X' },
          { type: 'Footer', label: 'Go', 'on-click-action': { name: 'complete', payload: {} } },
        ] },
      }],
    },
  },
  {
    why: 'the reserved screen id SUCCESS',
    flow: {
      version: '7.2',
      screens: [{
        id: 'SUCCESS', terminal: true,
        layout: { type: 'SingleColumnLayout', children: [
          { type: 'Footer', label: 'Go', 'on-click-action': { name: 'complete', payload: {} } },
        ] },
      }],
    },
  },
  {
    why: 'no terminal screen, so the flow can never end',
    flow: {
      version: '7.2',
      screens: [{ id: 'A', layout: { type: 'SingleColumnLayout', children: [{ type: 'TextBody', text: 'hi' }] } }],
    },
  },
]

let blind = 0
for (const c of MUST_REJECT) {
  if (validateFlowJson(c.flow).length === 0) {
    blind += 1
    console.log(`BLIND SPOT — accepted: ${c.why}`)
  }
}
console.log(blind === 0 ? `validator rejects all ${MUST_REJECT.length} known publish failures` : `${blind} blind spot(s)`)

const ok = failed === 0 && blind === 0
console.log(ok ? `\n${Object.keys(FLOWS).length} flow(s) publishable` : `\nnot publishable`)
process.exit(ok ? 0 : 1)

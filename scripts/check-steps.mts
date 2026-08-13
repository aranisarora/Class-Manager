/**
 * check-steps — does a rejected plan tell the model enough to fix it?
 *
 * A clean lifecycle drive lost go-live to one unhelpful sentence: the model composed
 * `{"operation":{"name":"schedule"}}`, got "unknown operation", rewrote the same plan,
 * got it again, and gave up. Everything downstream of going live failed with it. The
 * error was true and unactionable, which is the most expensive kind.
 *
 *   npx tsx scripts/check-steps.mts
 */
import { checkSteps } from '@/lib/agent/steps'

/** Each case is a shape the model has actually produced, and what the reply must say. */
const CASES: { why: string; steps: unknown; mustMention: string[] }[] = [
  {
    why: 'schedule is a tool; a plan schedules with a step of its own',
    steps: [{ operation: { name: 'schedule', args: { run_at: '2026-09-01T09:00:00Z' } } }],
    mustMention: ['tool', '"schedule"'],
  },
  {
    why: 'reply is a tool; a plan sends with a message step',
    steps: [{ operation: { name: 'reply', args: { body: 'hi' } } }],
    mustMention: ['tool', 'message'],
  },
  {
    why: 'commit inside a plan is meaningless',
    steps: [{ operation: { name: 'commit', args: {} } }],
    mustMention: ['tool'],
  },
  {
    why: 'a name that is simply not real still gets a plain sentence',
    steps: [{ operation: { name: 'frobnicate', args: {} } }],
    mustMention: ['no operation called'],
  },
]

let bad = 0
for (const c of CASES) {
  const res = checkSteps(c.steps)
  if (res.ok) {
    bad += 1
    console.log(`ACCEPTED (should have been refused): ${c.why}`)
    continue
  }
  const missing = c.mustMention.filter((m) => !res.error.includes(m))
  if (missing.length) {
    bad += 1
    console.log(`UNHELPFUL: ${c.why}\n  said: ${res.error}\n  missing: ${missing.join(', ')}`)
  } else {
    console.log(`ok  ${c.why}`)
  }
}

// And the shape that must still be ACCEPTED, so the fix did not just refuse everything.
const good = checkSteps([
  { schedule: { kind: 'agent_task', run_at: '2026-09-01T09:00:00Z', dedupe_key: 'x', payload: {} } },
])
if (!good.ok) {
  bad += 1
  console.log(`REFUSED a valid schedule STEP: ${good.error}`)
}

console.log(bad === 0 ? `\nall ${CASES.length + 1} cases correct` : `\n${bad} wrong`)
process.exit(bad === 0 ? 0 : 1)

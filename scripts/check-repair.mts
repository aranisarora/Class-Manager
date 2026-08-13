/**
 * check-repair — does anything machine-shaped survive to a person's screen?
 *
 * Every case here was read off a real message row this product sent. `repair.ts` is the
 * last thing between the model's draft and a phone, and its failures are the ones a
 * customer sees, so its coverage is worth asserting rather than assuming.
 *
 *   npx tsx scripts/check-repair.mts
 */
import { extractBracketButtons } from '@/lib/messaging/repair'

/** [body, how many buttons should come out, what must NOT survive in the text] */
const CASES: { why: string; body: string; buttons: number; mustNotContain: string[] }[] = [
  {
    why: 'labels with the wire shape typed after them — driven, on an owner\'s second message',
    body:
      'What would you like to do first?\n\n*Next step:*\n\n'
      + '[Open Business Setup] (action: )\n[Add Coaches] (action: )\n[Add Players] (action: )',
    buttons: 3,
    mustNotContain: ['[', 'action:', 'Next step:'],
  },
  {
    why: 'the FULL wire shape typed after the label — four consecutive messages of a clean drive',
    body:
      "We're still missing your *UPI handle*.\n\n*Next step:*\n\n"
      + "[Set UPI Handle] (kind: 'operation', op: 'view', args: { screen: setup })\n"
      + "[Go Live] (kind: 'operation', op: 'set onboarding state', args: { state: live })\n"
      + "[Draft Arjun's Invite] (kind: 'operation', op: 'send invite draft', args: {: '' })",
    buttons: 3,
    mustNotContain: ['[', 'kind:', 'op:', 'args:', 'Next step:'],
  },
  {
    why: 'bare labels on their own line, the shape that already worked',
    body: 'Does that look right?\n\n[Looks right]\n[Something’s wrong]',
    buttons: 2,
    mustNotContain: ['['],
  },
  {
    why: 'brackets inside a sentence are prose and must survive untouched',
    body: 'The register (see [the sheet]) is done.',
    buttons: 0,
    mustNotContain: [],
  },
]

let bad = 0
for (const c of CASES) {
  const out = extractBracketButtons(c.body)
  if (out.buttons.length !== c.buttons) {
    bad += 1
    console.log(`WRONG BUTTON COUNT (${out.buttons.length}, want ${c.buttons}): ${c.why}`)
  }
  for (const s of c.mustNotContain) {
    if (out.text.includes(s)) {
      bad += 1
      console.log(`SURVIVED ${JSON.stringify(s)}: ${c.why}\n  text: ${JSON.stringify(out.text)}`)
    }
  }
  if (c.buttons === 0 && out.text !== c.body) {
    bad += 1
    console.log(`REWROTE PROSE: ${c.why}\n  out: ${JSON.stringify(out.text)}`)
  }
}

console.log(bad === 0 ? `all ${CASES.length} repair cases correct` : `\n${bad} wrong`)
process.exit(bad === 0 ? 0 : 1)

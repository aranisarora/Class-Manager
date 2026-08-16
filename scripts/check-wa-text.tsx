/**
 * check-wa-text — does the pane render WhatsApp's markup the way WhatsApp does?
 *
 *   npx tsx --tsconfig scripts/tsconfig.jsx.json scripts/check-wa-text.tsx
 *
 * `lib/agent/lint.ts` pass 0 already guarantees the markup on the way OUT — one asterisk for
 * bold, no headings, no link syntax. This checks the other end: that the emulator draws what
 * the lint emits, so a reviewer looking at the pane is looking at the shape a parent gets.
 *
 * The cases that matter most are the ones that must NOT format. A renderer that bolds
 * eagerly is worse than one that does not render at all, because §17 runs in one direction —
 * the emulator may show less than production sends, never more — and `5 * 3 = 15` turning
 * into a bold `3` is the emulator inventing a message nobody sent.
 *
 * The dangling-fence case is here because it was not hypothetical: an unterminated ``` fell
 * through every block branch, the prose loop then consumed nothing, and the cursor never
 * advanced. That is not a mis-rendered bubble, it is a frozen tab.
 */
import { renderToStaticMarkup } from 'react-dom/server'

import { WaText } from '@/components/emulator/wa-text'
import { c } from './_env'

/** Class names are styling, not meaning. Strip them so the cases read as intent. */
const render = (s: string) =>
  renderToStaticMarkup(<WaText text={s} />)
    .replace(/ class="[^"]*"/g, '')
    .replace(/^<span>|<\/span>$/g, '')

/** `contains` — the rendered output must include this. `literal` — no markup at all. */
type Case = { input: string; contains?: string; literal?: true; note?: string }

const CASES: Case[] = [
  // --- inline, the forms WhatsApp actually has -----------------------------------------
  { input: '*bold*', contains: '<strong>bold</strong>' },
  { input: '_italic_', contains: '<em>italic</em>' },
  { input: '~struck~', contains: '<s>struck</s>' },
  { input: '`code`', contains: '<code>code</code>' },
  { input: '*bold _and italic_*', contains: '<strong>bold <em>and italic</em></strong>' },
  {
    input: "*1. Your client's reminders.*",
    contains: '<strong>1. Your client&#x27;s reminders.</strong>',
    note: 'the shape lint produces from a `## 1. …` heading or a `**…**` run',
  },

  // --- what must stay literal ------------------------------------------------------------
  { input: '3*4*5', literal: true, note: 'mid-word markers are arithmetic, not emphasis' },
  { input: '5 * 3 = 15', literal: true },
  { input: 'a lone * asterisk', literal: true },
  { input: 'unclosed *bold', literal: true, note: 'an unclosed marker must not swallow the rest' },
  { input: '`*not bold*`', contains: '<code>*not bold*</code>', note: 'inline code is literal all the way down' },

  // --- blocks ----------------------------------------------------------------------------
  { input: '- one\n- two', contains: '<ul><li>one</li><li>two</li></ul>' },
  {
    input: '* not bold*',
    contains: '<ul>',
    note: "`* ` at line start is WhatsApp's bullet, and only the space separates it from bold",
  },
  { input: '1. one\n2. two', contains: '<ol start="1"><li>one</li><li>two</li></ol>' },
  { input: '3. third\n4. fourth', contains: '<ol start="3">', note: 'a list that does not start at 1' },
  { input: '> quoted', contains: '<blockquote>quoted</blockquote>' },
  { input: '```\nmono\n```', contains: '<pre>mono</pre>' },
  { input: '```mono```', contains: '<pre>mono</pre>', note: 'opened and closed on one line' },
  {
    input: '``` dangling\nreal text',
    contains: '``` dangling\nreal text',
    note: 'an unterminated fence is literal, keeps its line break, and terminates',
  },

  // --- the real product shape ------------------------------------------------------------
  {
    input: '*Tomorrow*\n\n• *Beginners* — 6:30pm',
    contains: '• <strong>Beginners</strong>',
    note: "lint's own bullet output, which is a literal • and not a list",
  },
]

const MARKUP = /<(strong|em|s|code|ul|ol|blockquote|pre)\b/

let failed = 0
console.log(c.bold('\ncheck-wa-text — WhatsApp markup, as the pane draws it\n'))

for (const t of CASES) {
  // A case that hangs is the failure this file was written for, so it is bounded rather
  // than trusted: without a guard a regression here takes the whole check down with it.
  const started = Date.now()
  const out = render(t.input)
  const ms = Date.now() - started
  const ok = t.literal ? !MARKUP.test(out) : out.includes(t.contains ?? '')
  if (!ok) failed++
  console.log(
    `  ${ok ? c.green('pass') : c.red('FAIL')}  ${JSON.stringify(t.input).padEnd(40)} ${c.dim('→')} ${JSON.stringify(out)}`,
  )
  if (!ok) console.log(`        ${c.red('expected')} ${t.literal ? 'no markup at all' : JSON.stringify(t.contains)}`)
  if (t.note) console.log(c.dim(`        ${t.note}`))
  if (ms > 1000) console.log(c.red(`        took ${ms}ms — suspiciously slow for one line`))
}

console.log(
  failed ? c.red(`\n${failed} of ${CASES.length} failing\n`) : c.green(`\nall ${CASES.length} cases pass\n`),
)
process.exit(failed ? 1 : 0)

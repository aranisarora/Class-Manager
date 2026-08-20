/**
 * check-anatomy — does `docs/ANATOMY.md` still describe the order the code runs in?
 *
 *   npm run check:anatomy
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * `ANATOMY.md` is the third of this repo's three orientation documents, and the
 * only one that makes claims about SEQUENCE: what runs before what, and what has
 * already happened by the time a given mechanism gets its turn. That is the most
 * useful thing it can say and the easiest thing to get quietly wrong — a symbol
 * renamed, a gate moved one rung up the send ladder, a stage deleted. None of
 * that shows up in a diff of the document, because the document does not change.
 *
 * This repo already knows what to do about a document that claims something about
 * reality: `check-schema-doc.ts`, `check-rls-doc.ts` and `check-layout.ts` all
 * turn the claim into a program and the program into a build failure. An index
 * that is wrong is worse than no index — it is the first thing an agent reads,
 * and it sends them to a stage that is not there.
 *
 * WHAT IT ASSERTS
 * -----------------------------------------------------------------------------
 *   1. Every repo path the document names exists.
 *   2. Every symbol named in a table row exists in one of the files that row
 *      names beside it. This is what catches a rename.
 *   3. The send ladder is still in the order the document gives, checked against
 *      the suppression reasons `lib/messaging/send.ts` actually returns, in the
 *      order it returns them. This is what catches a gate moving.
 *   4. The document still has its stages. A gutted file must not pass.
 *
 * It does NOT read the prose, and it cannot: whether the sentence explaining an
 * order is still true is a person's judgement. What it guarantees is narrower and
 * enough — you cannot change the shape of the brain and forget this file exists.
 *
 * It reads no database and starts no server.
 */
import { existsSync, readFileSync } from 'node:fs'

import { c } from './_env'

const DOC = 'docs/ANATOMY.md'
const SEND = 'lib/messaging/send.ts'

const problems: string[] = []
let checked = 0

if (!existsSync(DOC)) {
  console.log(c.red(`\n  ${DOC} is missing — the order the brain runs in is undocumented.\n`))
  process.exit(1)
}
const doc = readFileSync(DOC, 'utf8')

/** A repo path, as this document spells them. */
const PATH_RE = /\b(?:lib|app|scripts|docs|findings|supabase|components)\/[A-Za-z0-9_./[\]-]*/g
/** A bare identifier: what a symbol looks like when it is not a path. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/

const isPath = (s: string): boolean => /^(?:lib|app|scripts|docs|findings|supabase|components)\//.test(s)
const tidy = (p: string): string => p.replace(/[.,;:)]+$/, '')

/* -------------------------------------------------------------------------- *
 * 1 · Every path named here exists
 * -------------------------------------------------------------------------- */

for (const raw of doc.match(PATH_RE) ?? []) {
  const p = tidy(raw)
  checked++
  if (!existsSync(p)) problems.push(`${DOC} names \`${p}\`, which is not in the tree`)
}

/* -------------------------------------------------------------------------- *
 * 2 · Every symbol in a table row is in a file that row names
 *
 * The convention the document keeps: a row that makes a claim names the file the
 * claim is about. So the row carries its own proof, and a rename anywhere in
 * `lib/` fails here rather than being discovered by an agent sent to a symbol
 * that no longer exists. A row naming no file is prose and is left alone — the
 * send ladder below is checked a stronger way.
 * -------------------------------------------------------------------------- */

const contents = new Map<string, string>()
const bodyOf = (p: string): string => {
  if (!contents.has(p)) contents.set(p, existsSync(p) ? readFileSync(p, 'utf8') : '')
  return contents.get(p)!
}

for (const line of doc.split('\n')) {
  if (!line.trimStart().startsWith('|')) continue
  const spans = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string)
  const paths = spans.filter(isPath).map(tidy).filter((p) => p.endsWith('.ts') || p.endsWith('.tsx'))
  if (!paths.length) continue
  for (const s of spans) {
    if (isPath(s) || !IDENT_RE.test(s)) continue
    checked++
    if (!paths.some((p) => bodyOf(p).includes(s))) {
      problems.push(`${DOC} names \`${s}\` beside ${paths.join(', ')}, and it is in none of them`)
    }
  }
}

/* -------------------------------------------------------------------------- *
 * 3 · The send ladder, in the order send() actually runs it
 *
 * The order is the whole claim. `opted_out` above `quiet_hours` is not a
 * presentation choice: it is why somebody who asked to be left alone is not
 * merely delayed until morning. Read out of the code rather than trusted.
 * -------------------------------------------------------------------------- */

const send = existsSync(SEND) ? readFileSync(SEND, 'utf8') : ''
const from = send.indexOf('export async function send(')
const to = send.indexOf('async function stampFailed(')

if (from < 0 || to < 0 || to < from) {
  problems.push(
    `could not find the body of send() in ${SEND} — this program's ladder check just passed ` +
      `vacuously. Suspect the markers it slices on, not the ladder.`,
  )
} else {
  const body = send.slice(from, to)
  const inCode: string[] = []
  for (const m of body.matchAll(/(?:reason: '([a-z_]+)'|suppress\(tx, row, msg, '([a-z_]+)')/g)) {
    const reason = (m[1] ?? m[2]) as string
    // One rung can be reached two ways (`repeat` by state key or by body). Two
    // reads of the same reason in a row are one rung, not two.
    if (inCode[inCode.length - 1] !== reason) inCode.push(reason)
  }

  // The document's ladder: the numbered table under the send sub-pipeline.
  const inDoc: string[] = []
  const table = doc.slice(doc.indexOf('## Sub-pipeline B'))
  for (const line of table.split('\n')) {
    const m = line.match(/^\|\s*(\d+)\s*\|(.+?)\|/)
    if (!m) continue
    for (const s of [...(m[2] as string).matchAll(/`([a-z_]+)`/g)]) inDoc.push(s[1] as string)
  }

  checked += inDoc.length
  if (!inDoc.length || !inCode.length) {
    problems.push(`parsed no send ladder out of ${!inDoc.length ? DOC : SEND} — the check read nothing`)
  } else if (inDoc.join(' → ') !== inCode.join(' → ')) {
    problems.push(
      `the send ladder in ${DOC} is no longer the ladder in ${SEND}:\n` +
        `      doc:  ${inDoc.join(' → ')}\n` +
        `      code: ${inCode.join(' → ')}`,
    )
  }
}

/* -------------------------------------------------------------------------- *
 * 4 · The stages are still there
 * -------------------------------------------------------------------------- */

const STAGES = [
  '## 1 · Arrival',
  '## 2 · Context',
  '## 3 · The rounds',
  '## Sub-pipeline A — a write',
  '## Sub-pipeline B — a send',
  '## 4 · The exits',
  '## 5 · Reflection',
  '## 6 · Record',
  '## The standing surface',
  '## What the order encodes',
  '## Where a fix goes',
]
for (const s of STAGES) {
  checked++
  if (!doc.includes(s)) problems.push(`${DOC} has lost its "${s.replace(/^#+ /, '')}" section`)
}

/* -------------------------------------------------------------------------- *
 * The verdict
 * -------------------------------------------------------------------------- */

console.log(c.dim(`\n  ${checked} claim(s) checked in ${DOC}`))

if (!problems.length) {
  console.log(c.green(`\n  ${DOC} still describes the order the code runs in.\n`))
  process.exit(0)
}
console.log(c.red(`\n  ${problems.length} disagreement(s):\n`))
for (const p of problems) console.log(c.red(`  ✗ ${p}`))
console.log(
  c.dim(
    '\n  ANATOMY.md is what an agent reads to find the STAGE a defect belongs to, before it\n' +
      '  proposes anything. A stage description that has drifted sends the fix to the wrong\n' +
      '  layer — usually to the prompt, which is the one place this repo already knows does\n' +
      '  not hold.\n',
  ),
)
process.exit(1)

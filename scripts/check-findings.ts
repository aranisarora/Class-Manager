/**
 * check-findings — does `findings/` agree with itself about what is broken?
 *
 *   npm run check:findings
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * On 20 Aug 2026 `npm run findings` reported 38 of 43 findings open. The ledger's
 * own closed tables named 29 of those as closed, each with the mechanism that
 * closed it, and every one verified present and reachable in code:
 *
 *   F-C  F-E  F-G  F-AF F-AG F-AJ F-AM F-AN F-AO F-AP F-AQ F-AS F-AT F-AV F-AW
 *   F-AX F-AY F-AZ F-BH F-BI F-BJ F-BK F-BM F-BN F-BO F-BP F-BQ F-BR F-BS F-BT
 *
 * Status lived in a summary table AND in the headings below it. The 17 Aug
 * architecture pass wrote its closures into the table and never touched the
 * headings; `_findings.ts` reads headings, on purpose, and so it trusted the stale
 * half. The cost was not tidiness: `npm run findings` is the first move an agent
 * asked to analyse a bad run makes, and it handed back a to-do list of shipped
 * work — `context_query` validation (F-AP), message `stateKey` (F-AN), event-text
 * filling (F-AZ), all built.
 *
 * The shape is what fixed it, not this program. A finding's status is now WHICH
 * FILE IT IS IN — `OPEN.md` or `CLOSED.md` — so there is no second copy to fall
 * out of step with. This exists to keep that property true.
 *
 * WHAT IT ASSERTS
 * -----------------------------------------------------------------------------
 *   1. No code appears in both `OPEN.md` and `CLOSED.md`.
 *   2. No code is used twice inside either file.
 *   3. Every code named in `DECIDED.md` is open — a deliberate non-fix is still a
 *      defect, and one that quietly moved to CLOSED is the failure this repo keeps
 *      re-learning.
 *   4. It actually parsed something.
 *
 * It reads three markdown files and nothing else, so like `check-layout` it is
 * safe anywhere and cheap enough to run before the instruments rather than after.
 *
 * WHAT IT DOES NOT ASSERT
 * -----------------------------------------------------------------------------
 * Nothing here judges whether a finding is really fixed. A row in `CLOSED.md` is a
 * person's claim; whether the mechanism exists and is reachable is a code question
 * (`check:mechanisms` asks part of it), and whether the behaviour happens is a
 * drive question. Per `docs/JUDGING.md`, no instrument in this repo scores
 * anything, and this one does not start.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { c } from './_env'

const OPEN = join('findings', 'OPEN.md')
const CLOSED = join('findings', 'CLOSED.md')
const DECIDED = join('findings', 'DECIDED.md')

const problems: string[] = []
const notes: string[] = []

/** Split on either terminator: `core.autocrlf` is on, so a fresh checkout is CRLF. */
const lines = (p: string): string[] =>
  existsSync(join(process.cwd(), p)) ? readFileSync(join(process.cwd(), p), 'utf8').split(/\r?\n/) : []

type Hit = { code: string; line: number }

/** `### F-BA · <title>` — a finding that is open, with its detail under it. */
function headings(p: string): Hit[] {
  const out: Hit[] = []
  lines(p).forEach((l, i) => {
    const m = l.match(/^#{2,4}\s+(F-[A-Z]+)\s*·/)
    if (m) out.push({ code: m[1] as string, line: i + 1 })
  })
  return out
}

/** `| **F-AN** | <title> | <when> |` — a finding that is closed, one line only. */
function rows(p: string): Hit[] {
  const out: Hit[] = []
  lines(p).forEach((l, i) => {
    const m = l.match(/^\s*\|\s*\*{0,2}(F-[A-Z]+)\*{0,2}\s*\|/)
    if (m) out.push({ code: m[1] as string, line: i + 1 })
  })
  return out
}

const openHits = headings(OPEN)
const closedHits = rows(CLOSED)

/* -------------------------------------------------------------------------- *
 * 1 · No code in both files
 * -------------------------------------------------------------------------- *
 *
 * The single property the whole shape rests on. If a code can be in both, status
 * is written down twice, and the two copies are exactly what diverged before.
 */
const closedBy = new Map(closedHits.map((h) => [h.code, h]))
for (const o of openHits) {
  const cl = closedBy.get(o.code)
  if (cl) {
    problems.push(
      `${o.code} is in both files — open at ${OPEN}:${o.line} and closed at ${CLOSED}:${cl.line}. ` +
        `A finding's status is which file it is in, so it cannot be in both.`,
    )
  }
}

/* -------------------------------------------------------------------------- *
 * 2 · No code used twice inside one file
 * -------------------------------------------------------------------------- *
 *
 * Two headings with one code is not a formatting slip. `_findings.ts` dedupes by
 * code, so the second finding is dropped from every coverage table without saying
 * so — it does not read as missing, it reads as absent. F-I and F-BL were each
 * doing this, and F-BH named two unrelated defects at once.
 */
for (const [file, hits] of [
  [OPEN, openHits],
  [CLOSED, closedHits],
] as const) {
  const byCode = new Map<string, Hit[]>()
  for (const h of hits) byCode.set(h.code, [...(byCode.get(h.code) ?? []), h])
  for (const [code, hs] of byCode) {
    if (hs.length > 1) {
      problems.push(`${code} appears ${hs.length}× in ${file} (lines ${hs.map((h) => h.line).join(', ')})`)
    }
  }
}

/* -------------------------------------------------------------------------- *
 * 3 · Everything DECIDED.md names is still open
 * -------------------------------------------------------------------------- *
 *
 * `DECIDED.md` is the expensive file: each entry is a defect somebody proved the
 * obvious fix would make worse. A decision not to fix is not a fix, so its code
 * belongs in `OPEN.md`. If one drifts into `CLOSED.md` the reasoning becomes
 * invisible at exactly the moment somebody is about to redo the work.
 */
const openCodes = new Set(openHits.map((h) => h.code))
const decided = new Set<string>()
for (const l of lines(DECIDED)) {
  const m = l.match(/^#{2,3}\s+(F-[A-Z]+)\s*·/)
  if (m) decided.add(m[1] as string)
}
for (const code of decided) {
  if (!openCodes.has(code)) {
    problems.push(
      `${code} has an entry in ${DECIDED} but is not open in ${OPEN}. A deliberate non-fix is ` +
        `still a defect; if it really was fixed, delete its ${DECIDED} entry and say what closed it.`,
    )
  }
}

/* -------------------------------------------------------------------------- *
 * 4 · This program actually read something
 * -------------------------------------------------------------------------- *
 *
 * Every assertion above is of the form "nothing disagrees", and all of them hold
 * vacuously against an empty parse. Not paranoia: an earlier version of this file
 * split on '\n' against a CRLF checkout, every heading regex missed, and it printed
 * "the ledger agrees with itself" in green over 26 real disagreements. A silent
 * pass is the worst outcome a checker has, so the parse states its own floor.
 */
if (!openHits.length && !closedHits.length) {
  problems.push(
    `parsed no findings out of ${OPEN} and ${CLOSED} — this program read nothing, so every check ` +
      `above passed vacuously. Suspect the parse, not the findings.`,
  )
}

/* -------------------------------------------------------------------------- *
 * The verdict
 * -------------------------------------------------------------------------- */
console.log(
  c.dim(`\n  ${openHits.length} open · ${closedHits.length} closed · ${decided.size} decided-not-to-fix`),
)
for (const n of notes) console.log(c.yellow(`  note: ${n}`))

if (!problems.length) {
  console.log(c.green('\n  findings/ agrees with itself.\n'))
  process.exit(0)
}
console.log(c.red(`\n  ${problems.length} disagreement(s):\n`))
for (const p of problems) console.log(c.red(`  ✗ ${p}`))
console.log(
  c.dim(
    '\n  A findings list that disagrees with itself is worse than none: `npm run findings` is\n' +
      '  the first thing an agent reads before analysing a run, and a finding wrongly listed\n' +
      '  open is a fix it will propose again — already built, already shipped.\n',
  ),
)
process.exit(1)

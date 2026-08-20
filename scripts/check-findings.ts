/**
 * check-findings — does the ledger agree with itself about what is still broken?
 *
 *   npm run check:findings
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * On 20 Aug 2026 `npm run findings` reported 38 of 43 findings open. The ledger's
 * own "Closed by the architecture pass" table named 20 of those as closed, each
 * with the mechanism that closed it, and all 20 were verified present and wired:
 *
 *   F-C  F-E  F-G  F-AF F-AG F-AJ F-AN F-AO F-AP F-AQ
 *   F-AS F-AT F-AW F-AX F-AY F-AZ F-BH F-BI F-BJ F-BK
 *
 * `_findings.ts` reads status from the `### F-XX ·` heading, on purpose, and says
 * why: the table "has fallen out of step with the headings twice; the heading is
 * written when the finding is, and is the more reliable of the two." That
 * assumption inverted. The 17 Aug architecture pass wrote its closures into the
 * TABLE and never touched the HEADINGS, so the tool trusted the stale half and
 * reported twenty shipped mechanisms as outstanding defects.
 *
 * The cost of that is not tidiness. `npm run findings` is the first move an agent
 * asked to analyse a bad run makes, and it was handing back a list of defects
 * that were already built — which is why analysis kept proposing `context_query`
 * validation (F-AP, built), message `stateKey` (F-AN, built) and event-text
 * filling (F-AZ, built). The agent was reporting what the repo told it.
 *
 * Three more defects sat in the same file, all invisible to `_findings.ts`:
 *
 *   - `F-BA` and `F-BB` appeared only in a table, with no `###` heading. The
 *     parser reads headings, so neither existed as far as any coverage check knew.
 *   - `F-I` and `F-BL` were each used twice for different defects. The parser
 *     dedupes by code, so the second of each was silently dropped.
 *   - `F-BH` was assigned to two unrelated defects — `business_rule` having no
 *     reader (Part 7) and a definer view missing `full_name` (Part 8).
 *
 * WHAT IT ASSERTS
 * -----------------------------------------------------------------------------
 *   1. No code is claimed both open and closed.
 *   2. Every code named in a status table has a `###` heading.
 *   3. No code is used for two different findings.
 *   4. Heading status and table status agree.
 *   5. Every heading's code is accounted for in some status table.
 *
 * It reads one markdown file and nothing else, so like `check-layout` it is safe
 * anywhere and cheap enough to run before the instruments rather than after.
 *
 * WHAT IT DOES NOT ASSERT
 * -----------------------------------------------------------------------------
 * Nothing here judges whether a finding is *actually* fixed. A heading marked
 * closed is a person's claim, and this only checks the file states that claim
 * once. Whether the mechanism exists and is reachable is a code question; whether
 * the behaviour happens is a drive question. Per `docs/JUDGING.md`, no instrument
 * in this repo scores anything, and this one does not start.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { c } from './_env'
import { readFindings, renderOpen } from './_findings'

const LEDGER = join('findings', 'conversation-rules.md')

type Row = { code: string; line: number; state: 'open' | 'closed'; where: string }
type Head = { code: string; line: number; state: 'open' | 'closed'; title: string }

const problems: string[] = []
const notes: string[] = []

const path = join(process.cwd(), LEDGER)
if (!existsSync(path)) {
  console.log(c.red(`\n  ${LEDGER} is missing — the ledger is the thing this checks.\n`))
  process.exit(1)
}
/**
 * Split on either terminator and keep neither.
 *
 * `git config core.autocrlf` is true on the machine this was written on, so a
 * fresh checkout of this file arrives with CRLF. A trailing `\r` is a line
 * terminator to a JavaScript regex, which means `$` will not match after it and
 * every `^#{2,4}…$` heading silently stops matching — the checker reported "0
 * findings · the ledger agrees with itself" against a ledger with 46 headings and
 * 26 disagreements. A checker that passes because it read nothing is the exact
 * failure it exists to catch.
 */
const lines = readFileSync(path, 'utf8').split(/\r?\n/)

/* -------------------------------------------------------------------------- *
 * Parse: headings, and the status tables they sit under
 * -------------------------------------------------------------------------- *
 *
 * A status table is a markdown table appearing under a heading that declares a
 * state — "What is open right now", "Closed 17 Aug 2026, by the architecture
 * pass", "Still open". Every other table in the file (there are many: schema
 * grids, cost tables, drive results) is not a status claim and is skipped, which
 * is why the state comes from the enclosing heading rather than from the row.
 */
const rows: Row[] = []
const heads: Head[] = []

/** The enclosing heading's state claim, or null if this heading makes none. */
function tableState(heading: string): 'open' | 'closed' | null {
  const h = heading.toLowerCase()
  if (/\bclosed\b/.test(h)) return 'closed'
  if (/\bopen\b/.test(h)) return 'open'
  return null
}

let section = ''
let sectionState: 'open' | 'closed' | null = null

for (let i = 0; i < lines.length; i++) {
  const line = lines[i] as string
  const no = i + 1

  const h = line.match(/^(#{2,4})\s+(.*)$/)
  if (h) {
    const text = (h[2] as string).trim()

    // `### F-AU · <title>` — a finding's own heading, and the state it declares.
    const f = text.match(/^(F-[A-Z]+)\s*·\s*(.+)$/)
    if (f) {
      const code = f[1] as string
      const title = (f[2] as string).trim()
      heads.push({
        code,
        line: no,
        state: /\*\*(closed|fixed)\b/i.test(title) ? 'closed' : 'open',
        title: title.replace(/\s*—?\s*\*\*(closed|fixed)[^*]*\*\*\s*$/i, '').trim(),
      })
      // A finding heading is not a status-table heading; keep the enclosing one.
      continue
    }

    section = text
    sectionState = tableState(text)
    continue
  }

  /**
   * A table row under a state-declaring heading: `| **F-AU** | … |`.
   *
   * One row may close several findings at once — `| **F-AJ, F-AM** | The verb
   * lists are gone entirely…` closes two, and `| **F-AO, F-AV** |` two more.
   * Reading only the first code was this checker's own first bug: it passed four
   * findings it should have flagged, in a program written to flag exactly that.
   */
  if (sectionState && /^\s*\|/.test(line)) {
    const cell = line.match(/^\s*\|([^|]*)\|/)
    if (cell) {
      for (const m of (cell[1] as string).matchAll(/\bF-[A-Z]+\b/g)) {
        rows.push({ code: m[0], line: no, state: sectionState, where: section })
      }
    }
  }
}

/* -------------------------------------------------------------------------- *
 * 1 · No code claimed both open and closed
 * -------------------------------------------------------------------------- */
const byCode = new Map<string, Row[]>()
for (const r of rows) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r])

for (const [code, rs] of byCode) {
  const states = new Set(rs.map((r) => r.state))
  if (states.size > 1) {
    const at = rs.map((r) => `${r.state} at :${r.line} (${r.where})`).join(' / ')
    problems.push(`${code} is claimed both open and closed — ${at}`)
  }
}

/* -------------------------------------------------------------------------- *
 * 2 · Every code in a status table has a heading
 * -------------------------------------------------------------------------- */
const headCodes = new Set(heads.map((h) => h.code))
for (const [code, rs] of byCode) {
  if (!headCodes.has(code)) {
    problems.push(
      `${code} is in a status table (:${rs[0]!.line}, ${rs[0]!.where}) but has no "### ${code} ·" ` +
        `heading — every reader of this ledger parses headings, so it is invisible to all of them`,
    )
  }
}

/* -------------------------------------------------------------------------- *
 * 3 · No code used for two different findings
 * -------------------------------------------------------------------------- *
 *
 * Two headings with one code is not a formatting slip. `_findings.ts` dedupes by
 * code, so the second finding is dropped from every coverage table without ever
 * saying so — it does not read as missing, it reads as absent.
 */
const headsByCode = new Map<string, Head[]>()
for (const h of heads) headsByCode.set(h.code, [...(headsByCode.get(h.code) ?? []), h])

for (const [code, hs] of headsByCode) {
  if (hs.length < 2) continue
  const titles = new Set(hs.map((h) => h.title.toLowerCase()))
  const at = hs.map((h) => `:${h.line} "${h.title.slice(0, 46)}"`).join('  ·  ')
  if (titles.size > 1) {
    problems.push(`${code} names ${hs.length} different findings — ${at}. One of them is unreachable.`)
  } else {
    notes.push(`${code} has ${hs.length} headings with the same title (${at}) — later ones are dropped`)
  }
}

/* -------------------------------------------------------------------------- *
 * 4 · Heading status and table status agree
 * -------------------------------------------------------------------------- */
for (const [code, rs] of byCode) {
  const hs = headsByCode.get(code)
  if (!hs?.length) continue
  const tableState = rs[0]!.state
  const headState = hs[0]!.state
  if (new Set(rs.map((r) => r.state)).size > 1) continue // already reported by 1
  if (tableState !== headState) {
    problems.push(
      `${code}: the table says ${tableState} (:${rs[0]!.line}, ${rs[0]!.where}) but the heading ` +
        `says ${headState} (:${hs[0]!.line}). \`npm run findings\` reads the heading.`,
    )
  }
}

/* -------------------------------------------------------------------------- *
 * 5 · Every heading is accounted for in some status table
 * -------------------------------------------------------------------------- *
 *
 * A note rather than a failure: findings are written into a Part as they are
 * found, and reaching the summary table is a separate motion. But a finding that
 * never reaches one is a finding nobody is tracking, which is how F-BU and F-BV
 * sat unstaged.
 */
for (const [code, hs] of headsByCode) {
  if (byCode.has(code)) continue
  if (hs[0]!.state === 'closed') continue // closed in place, never tabled — fine
  notes.push(`${code} (:${hs[0]!.line}) is open but appears in no status table`)
}

/* -------------------------------------------------------------------------- *
 * 6 · findings/OPEN.md still says what the ledger says
 * -------------------------------------------------------------------------- *
 *
 * `OPEN.md` is the short list people and agents actually read, generated from
 * this ledger. The moment it is generated it becomes a second copy of one fact,
 * which is the failure mode this whole file is repairing — so it gets the same
 * treatment as `docs/MECHANISMS.md`: regenerate, byte-compare, fail on drift.
 * Closing a finding without regenerating leaves the read surface claiming a
 * defect that is fixed, which is exactly how this started.
 */
{
  const openPath = join(process.cwd(), 'findings', 'OPEN.md')
  const rendered = renderOpen(readFindings())
  const current = existsSync(openPath) ? readFileSync(openPath, 'utf8').replace(/\r\n/g, '\n') : ''
  if (!current) {
    notes.push('findings/OPEN.md does not exist yet — run `npm run findings -- --write`')
  } else if (current !== rendered) {
    problems.push(
      'findings/OPEN.md is out of date — the ledger changed and the read surface did not. ' +
        'Run `npm run findings -- --write`.',
    )
  }
}

/* -------------------------------------------------------------------------- *
 * 7 · This program actually read something
 * -------------------------------------------------------------------------- *
 *
 * Every assertion above is of the form "nothing disagrees", and all of them hold
 * vacuously against an empty parse. This one is not paranoia: the CRLF bug noted
 * at `lines` made every heading regex miss, and the run printed "the ledger agrees
 * with itself" in green while the ledger held 26 disagreements. A silent pass is
 * the worst outcome a checker has, so the parse states its own floor.
 */
if (heads.length === 0) {
  problems.push(
    `no "### F-XX ·" headings parsed out of ${lines.length} lines — this program read nothing, ` +
      `so every check below it passed vacuously. Suspect the parse, not the ledger.`,
  )
} else if (rows.length === 0) {
  notes.push('no status-table rows parsed — the summary tables may have been renamed or removed')
}

/* -------------------------------------------------------------------------- *
 * The verdict
 * -------------------------------------------------------------------------- */
const openCount = heads.filter((h) => h.state === 'open').length
console.log(
  c.dim(
    `\n  ${heads.length} findings · ${openCount} open by heading · ` +
      `${byCode.size} tabled · ${rows.length} table rows read`,
  ),
)
for (const n of notes) console.log(c.yellow(`  note: ${n}`))

if (!problems.length) {
  console.log(c.green('\n  the ledger agrees with itself.\n'))
  process.exit(0)
}
console.log(c.red(`\n  ${problems.length} disagreement(s) inside the ledger:\n`))
for (const p of problems) console.log(c.red(`  ✗ ${p}`))
console.log(
  c.dim(
    '\n  A ledger that disagrees with itself is worse than no ledger: `npm run findings`\n' +
      '  is the first thing an agent reads before analysing a run, and a finding wrongly\n' +
      '  listed open is a fix it will propose again — already built, already shipped.\n',
  ),
)
process.exit(1)

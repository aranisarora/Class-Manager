/**
 * _findings — the one list of what has already gone wrong, and which instrument
 * stages each one.
 *
 *   npm run findings              # the coverage table
 *   npm run findings -- --open    # only what is still open
 *   npm run findings -- --bare    # only findings no instrument stages
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------------------------------------------------------------
 * `two-places`, `row-cap`, `silent-update` and `scoped-mute` are written three
 * times — once as a prose question in `probe-ask`, once as a driven sentence in
 * `probe-sql`, once as an arc case in `probe-model` — and they drift, because
 * nothing joins them. When F-AU was closed on 17 Aug the ask scenario was
 * updated and the SQL case was not, so one instrument was asking about a fixed
 * defect and the other was asking about a live one, and the two pages disagreed
 * without either being wrong on its own terms.
 *
 * WHY THIS IS NOT A LIST OF SCENARIOS
 * -----------------------------------------------------------------------------
 * The obvious fix is a shared `SCENARIOS` array the three instruments import.
 * It is the wrong fix, and it is worth saying why, because it looks right:
 *
 *   The three instruments do not pose the same thing. `probe-ask` asks *"walk me
 *   through what you would do"* with no tools and no world. `probe-sql` posts a
 *   sentence into a real academy and reads back what Postgres was sent.
 *   `probe-model` puts it at a particular point in a lifecycle where the rows it
 *   needs exist. One text cannot serve all three without becoming the worst of
 *   the three, and the *setup* — which is most of the work — has nothing in
 *   common between them at all.
 *
 * What they genuinely share is the FINDING: the thing that broke, once, in
 * production or in a drive. So that is what is shared, and it is not copied here
 * either — `conversation-rules.md` is the ledger and stays the ledger. This reads
 * it. A registry that duplicates its source is a fourth thing to drift.
 *
 * WHAT COVERAGE MEANS HERE, AND WHAT IT DOES NOT
 * -----------------------------------------------------------------------------
 * "Staged by probe-sql" means the code F-AU appears in that file. It does NOT
 * mean the case is any good, and it emphatically does not mean the finding will
 * not recur — nothing in this repo asserts that any more. It answers one narrow
 * question that was previously unanswerable: **which of the things that have
 * already broken does no instrument even ask about?** That list has been the
 * source of every nasty surprise in the ledger.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const LEDGER = 'conversation-rules.md'

/** Where a finding might be staged. Order is cheapest-to-run first. */
export const INSTRUMENTS = [
  { file: 'scripts/probe-ask.ts', label: 'ask' },
  { file: 'scripts/probe-sql.ts', label: 'sql' },
  { file: 'scripts/probe-model.ts', label: 'model' },
  { file: 'scripts/drive-week.ts', label: 'week' },
] as const

export type Finding = {
  /** `F-AU`. */
  code: string
  title: string
  /** Closed findings still deserve a stage: a closed finding is a regression test. */
  closed: boolean
  /** Which instruments mention the code. */
  stagedBy: string[]
}

/**
 * Every finding in the ledger, with what stages it.
 *
 * Headings look like `### F-AU · <title>` and a closed one carries `**closed
 * <date>**` in the heading itself. Both are parsed from the heading rather than
 * from the open-findings table above it, because the table is edited by hand and
 * has fallen out of step with the headings twice; the heading is written when the
 * finding is, and is the more reliable of the two.
 */
export function readFindings(root: string = process.cwd()): Finding[] {
  const path = join(root, LEDGER)
  if (!existsSync(path)) return []
  const md = readFileSync(path, 'utf8')

  const sources = INSTRUMENTS.map((i) => ({
    label: i.label,
    text: existsSync(join(root, i.file)) ? readFileSync(join(root, i.file), 'utf8') : '',
  }))

  const out: Finding[] = []
  const seen = new Set<string>()
  for (const m of md.matchAll(/^#{2,4}\s+(F-[A-Z]+)\s*·\s*(.+)$/gm)) {
    const code = m[1] as string
    if (seen.has(code)) continue
    seen.add(code)
    const heading = (m[2] ?? '').trim()
    // Word-boundary on both sides: `F-A` must not match inside `F-AU`.
    const re = new RegExp(`\\b${code}\\b`)
    out.push({
      code,
      title: heading.replace(/\s*—?\s*\*\*(closed|fixed)[^*]*\*\*\s*$/i, '').trim(),
      closed: /\*\*(closed|fixed)\b/i.test(heading),
      stagedBy: sources.filter((s) => re.test(s.text)).map((s) => s.label),
    })
  }
  return out
}

/* -------------------------------------------------------------------------- *
 * Run directly for the table.
 * -------------------------------------------------------------------------- */

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/_findings.ts')) {
  const { c } = await import('./_env')
  const argv = process.argv.slice(2)
  const onlyOpen = argv.includes('--open')
  const onlyBare = argv.includes('--bare')

  let findings = readFindings()
  if (onlyOpen) findings = findings.filter((f) => !f.closed)
  if (onlyBare) findings = findings.filter((f) => f.stagedBy.length === 0)

  if (!findings.length) {
    console.log(c.dim('\n  nothing matches\n'))
    process.exit(0)
  }

  /**
   * Pad first, colour second.
   *
   * `padEnd` counts the escape bytes in a coloured string, so colouring before
   * padding shifts every later column by the width of the escape sequence and
   * only for the coloured rows — which is how the first run of this printed a
   * table whose "closed" rows were indented nine characters further than the
   * open ones.
   */
  const cell = (text: string, width: number, paint?: (s: string) => string) => {
    const padded = text.padEnd(width)
    return paint ? paint(padded) : padded
  }

  console.log(`\n  ${c.dim('code'.padEnd(7))} ${c.dim('state'.padEnd(7))} ${c.dim('staged by'.padEnd(20))} title`)
  for (const f of findings) {
    console.log(
      `  ${cell(f.code, 7)} ` +
        `${f.closed ? cell('closed', 7, c.dim) : cell('open', 7)} ` +
        `${f.stagedBy.length ? cell(f.stagedBy.join(' '), 20) : cell('nothing', 20, c.red)} ` +
        `${f.title.slice(0, 74)}`,
    )
  }

  const all = readFindings()
  const bare = all.filter((f) => !f.stagedBy.length)
  const bareOpen = bare.filter((f) => !f.closed)
  console.log(
    `\n  ${all.length} findings · ${all.filter((f) => !f.closed).length} open · ` +
      `${all.length - bare.length} staged somewhere`,
  )
  if (bareOpen.length) {
    console.log(
      c.red(`  ${bareOpen.length} OPEN and staged by nothing: `) + bareOpen.map((f) => f.code).join(', '),
    )
  }
  console.log(
    c.dim('\n  "staged by" means the code appears in that instrument. It is not a claim that the\n') +
      c.dim('  case is good, and nothing here asserts the finding will not recur — read the run.\n'),
  )
}

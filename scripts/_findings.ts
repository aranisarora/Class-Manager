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
 * either — `OPEN.md` and `CLOSED.md` are the ledger and stay the ledger. This reads
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

/**
 * Two files, one fact each.
 *
 * `OPEN.md` holds what is broken, with the detail, and is hand-written. `CLOSED.md`
 * holds one line per retired finding and nothing else. A code lives in exactly one
 * of them, which is what makes "is F-AN open?" answerable by looking rather than by
 * reconciling.
 *
 * This replaced a 1,830-line narrative ordered by drive date that kept status in a
 * summary table AND in its headings. They diverged, `npm run findings` trusted the
 * stale half, and twenty-nine shipped mechanisms read as outstanding defects for
 * three days — long enough for analysis to keep proposing work that was done. The
 * narrative is in git (`git show ee21e4b:findings/conversation-rules.md`); what each
 * closed fix actually IS lives in the code, tagged `@mechanism`.
 */
const OPEN_FILE = join('findings', 'OPEN.md')
const CLOSED_FILE = join('findings', 'CLOSED.md')

/** Where a finding might be staged. Order is cheapest-to-run first. */
export const INSTRUMENTS = [
  { file: 'scripts/probe-ask.ts', label: 'ask' },
  { file: 'scripts/probe-sql.ts', label: 'sql' },
  { file: 'scripts/probe-model.ts', label: 'model' },
  { file: 'scripts/sim.ts', label: 'week' },
] as const

export type Finding = {
  /** `F-AU`. */
  code: string
  title: string
  /** Closed findings still deserve a stage: a closed finding is a regression test. */
  closed: boolean
  /** Which instruments mention the code. */
  stagedBy: string[]
  /** Link into the ledger, so the one-line list stays lossless. */
  anchor: string
}

/**
 * Where a finding's detail lives, as a link the reader can follow.
 *
 * GitHub's anchor rules: lowercase, punctuation dropped, spaces to dashes. The
 * `·` and the `**closed …**` suffix both vanish, which is why the anchor is built
 * from the raw heading and not from the cleaned title.
 */
export function anchorFor(heading: string): string {
  return (
    '#' +
    heading
      .toLowerCase()
      .replace(/[`*]/g, '')
      .replace(/[^\w\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
  )
}

/**
 * Every finding, open and closed, with what stages it.
 *
 * Open ones are the `### F-XX · <title>` headings in `OPEN.md`; closed ones are the
 * `| **F-XX** | <title> | <when> |` rows in `CLOSED.md`. Status is not parsed out of
 * prose any more, and it is not written down twice — where the code LIVES is the
 * status, so the two cannot disagree without a code being in both files, which
 * `check:findings` refuses outright.
 */
export function readFindings(root: string = process.cwd()): Finding[] {
  const read = (p: string) => (existsSync(join(root, p)) ? readFileSync(join(root, p), 'utf8') : '')

  const sources = INSTRUMENTS.map((i) => ({
    label: i.label,
    text: read(i.file),
  }))

  const out: Finding[] = []
  const seen = new Set<string>()

  /** Word-boundary on both sides: `F-A` must not match inside `F-AU`. */
  const stagedBy = (code: string) => {
    const re = new RegExp(`\\b${code}\\b`)
    return sources.filter((s) => re.test(s.text)).map((s) => s.label)
  }

  for (const m of read(OPEN_FILE).matchAll(/^#{2,4}\s+(F-[A-Z]+)\s*·\s*(.+)$/gm)) {
    const code = m[1] as string
    if (seen.has(code)) continue
    seen.add(code)
    const heading = (m[2] ?? '').trim()
    out.push({
      code,
      title: heading,
      closed: false,
      stagedBy: stagedBy(code),
      anchor: anchorFor(`${code} · ${heading}`),
    })
  }

  for (const m of read(CLOSED_FILE).matchAll(/^\s*\|\s*\*{0,2}(F-[A-Z]+)\*{0,2}\s*\|([^|]*)\|/gm)) {
    const code = m[1] as string
    if (seen.has(code)) continue
    seen.add(code)
    out.push({
      code,
      title: (m[2] ?? '').trim(),
      closed: true,
      stagedBy: stagedBy(code),
      anchor: '',
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
  /**
   * The pointer goes here because this is where the reader already is.
   *
   * `CLAUDE.md` names `docs/MECHANISMS.md` in its first read-first row, and an
   * agent analysing a bad run still runs THIS first — it is the command that
   * sounds like the question. On 20 Aug this table reported 38 findings open
   * when 21 had shipped mechanisms, and the proposals that came back were for
   * things already built. A list of defects with no list of what handles them
   * is half the picture, and it is the half that reads as a to-do list.
   */
  console.log(
    c.dim('  This is what BROKE. For what already HANDLES it, read ') +
      'docs/MECHANISMS.md' +
      c.dim(' first —\n  proposing a mechanism that shipped is the most common failure here.\n'),
  )
}

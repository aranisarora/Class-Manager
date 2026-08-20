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

const LEDGER = join('findings', 'conversation-rules.md')

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
      anchor: anchorFor(`${code} · ${heading}`),
    })
  }
  return out
}


/**
 * `findings/OPEN.md` — the short list that is actually read.
 *
 * The ledger is 1,800 lines ordered by drive date, and on 20 Aug 2026 it held 46
 * findings of which 35 were closed. Nobody could answer "what is open?" from it,
 * so nobody asked it — they asked an agent, which read the stale half and
 * proposed fixes that had shipped.
 *
 * This writes the answer down. It is GENERATED and not maintained, because a
 * second hand-kept list of one fact is the precise failure being repaired here:
 * the ledger already kept status in a table AND in its headings, they diverged,
 * and twenty shipped mechanisms read as open defects for three days.
 *
 * Each row links back rather than copying. The detail — what broke, what it cost,
 * where the fix belongs — stays in the ledger where it was written; an index that
 * restates its source is a third thing to drift.
 */
export function renderOpen(all: Finding[]): string {
  const open = all.filter((f) => !f.closed)
  const led = 'conversation-rules.md'
  const rows = open.map(
    (f) =>
      `| **${f.code}** | ${f.title} | ${f.stagedBy.length ? f.stagedBy.join(' ') : '**nothing**'} | [detail](./${led}${f.anchor}) |`,
  )
  return [
    '# What is open',
    '',
    '<!-- GENERATED by `npm run findings -- --write`. Do not edit. -->',
    '',
    `${open.length} open · ${all.length - open.length} closed · ${all.length} recorded in total.`,
    '',
    'Before proposing a fix for any of these, read [`../docs/MECHANISMS.md`](../docs/MECHANISMS.md)',
    '— what the brain already does. The most common failure here is re-proposing a mechanism that',
    'shipped weeks ago.',
    '',
    '"Staged by" is which instrument mentions the code. It is not a claim that the case is good,',
    'and nothing here asserts the finding will not recur — read the run.',
    '',
    '| # | What is wrong | Staged by | |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    '---',
    '',
    `Detail lives in [\`${led}\`](./${led}), which is the write surface and the archive both.`,
    'Retire a finding by building the mechanism and tagging it `@mechanism … Closes F-XX`, then',
    'marking the ledger heading closed — `npm run check:mechanisms` refuses a tag that claims a',
    'finding the ledger still calls open, so the two cannot drift apart.',
    '',
  ].join('\n')
}

/* -------------------------------------------------------------------------- *
 * Run directly for the table.
 * -------------------------------------------------------------------------- */

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/_findings.ts')) {
  const { c } = await import('./_env')
  const argv = process.argv.slice(2)
  const onlyOpen = argv.includes('--open')
  const onlyBare = argv.includes('--bare')

  /* ------------------------------------------------------------------------ *
   * --write · findings/OPEN.md, the short list that is actually read
   * ------------------------------------------------------------------------ *
   *
   * The ledger is 1,800 lines ordered by drive date, and on 20 Aug 2026 it held
   * 46 findings of which 35 were closed. Nobody could answer "what is open?" from
   * it, so nobody asked it — they asked an agent, which read the stale half and
   * proposed fixes that had shipped.
   *
   * This writes the answer down. It is GENERATED and not maintained, because a
   * second hand-kept list of one fact is the precise failure being repaired here:
   * the ledger already kept status in a table AND in its headings, they diverged,
   * and twenty shipped mechanisms read as open defects for three days.
   *
   * Each row links back rather than copying. The detail — what broke, what it
   * cost, where the fix belongs — stays in the ledger where it was written; this
   * is an index, and an index that restates its source is a third thing to drift.
   */
  if (argv.includes('--write')) {
    const { writeFileSync } = await import('node:fs')
    const all = readFindings()
    writeFileSync(join('findings', 'OPEN.md'), renderOpen(all), 'utf8')
    console.log(c.green(`
  findings/OPEN.md — ${all.filter((f) => !f.closed).length} open of ${all.length}.
`))
    process.exit(0)
  }

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

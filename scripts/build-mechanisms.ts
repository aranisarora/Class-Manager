/**
 * build-mechanisms — the index of what this brain already does.
 *
 *   npm run mechanisms          # write docs/MECHANISMS.md
 *   npm run check:mechanisms    # fail if the written file is out of date
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * This repo recorded, at length, *what went wrong* — 3,013 lines across
 * `findings/` — and *what the code is* — 15,866 lines in `lib/agent/`, of which
 * roughly 100,000 tokens are comments. It recorded nowhere *what mechanism now
 * exists and which class of defect it retires*.
 *
 * That gap has a measurable cost. An agent asked to analyse a bad run reads the
 * findings (problems), cannot hold the brain (209k tokens in `lib/agent` alone,
 * past a standard context window before any conversation), and proposes
 * mechanisms that shipped weeks ago. It is not failing to think; it has no map
 * from a symptom to the thing that already handles it. `untold.ts` closes
 * "somebody's life changed and nobody told them" — nothing about the filename
 * says so, and you only learn it by reading a 36-line docstring.
 *
 * So the docstrings become an index. A `@mechanism` tag marks a paragraph that
 * describes a mechanism rather than an implementation detail, and this collects
 * them into one page whose scan tier is about 4,000 tokens — the file you hand an
 * analysis agent INSTEAD of "read the brain and understand that it is
 * sophisticated". `lib/agent` is ~209,000 tokens and does not fit.
 *
 * WHY GENERATED AND NOT WRITTEN
 * -----------------------------------------------------------------------------
 * A hand-written capability list is a second copy of a fact, and this repo has
 * the receipts on what that costs: the old ledger kept status in a table
 * and in its headings, they diverged, and `npm run findings` reported twenty-nine
 * shipped mechanisms as open defects for three days. The tag lives beside the
 * code it describes, moves when the code moves, and dies when the code dies.
 * Same discipline as `check-schema-doc` and `check-rls-doc`: a document that
 * claims something about reality gets a program that checks the claim.
 *
 * THE TAG
 * -----------------------------------------------------------------------------
 *   @mechanism <name> — <what it does, in a sentence or three>. Closes F-XX, F-YY.
 *
 * Continuation lines are indented under it and end at a blank comment line. The
 * `Closes` clause is optional and is checked against the ledger: naming a finding
 * that does not exist, or one the ledger still calls open, is an error — that is
 * the drift this whole exercise is about.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { c } from './_env'
import { readFindings } from './_findings'

const OUT = join('docs', 'MECHANISMS.md')
/**
 * `scripts/` is in here, and its absence is how a mechanism came to be recorded closed
 * having never once executed.
 *
 * `alsoRead` (`_capture.ts`) was built on 22 Aug 2026 so a founding turn would record the
 * business it creates instead of recording silence, wired into `sim.ts`, gated green, and
 * its finding closed — while both `reopenRun` calls on the SEAT path, which is the whole
 * simulation, passed no `qIn` and the mechanism never fired. `check:mechanisms` could not
 * have caught it and neither could `check:findings`: the index only ever looked at `lib`,
 * so a tag under `scripts/` was unindexed, its symbol unverified, and its `Closes F-XX`
 * clause never read against the ledger.
 *
 * The instruments are as load-bearing as the brain — a lying instrument invalidates every
 * measurement taken through it — and they now carry the same three checks: the symbol is
 * real, the index matches the tags, and a finding it claims to close is actually open.
 */
// `supabase/migrations` is here for the same reason `scripts` is (see above): a
// mechanism whose code IS the DDL — a view, a trigger, an index — is tagged
// beside that DDL, and an unscanned root is a tag whose Closes clause nobody
// reads against the ledger.
const ROOTS = ['lib', 'scripts', 'supabase/migrations']

type Mechanism = {
  name: string
  body: string
  closes: string[]
  file: string
  line: number
}

/* -------------------------------------------------------------------------- *
 * Collect
 * -------------------------------------------------------------------------- */

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e.startsWith('.')) continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(tsx?|sql)$/.test(p)) out.push(p)
  }
  return out
}

/**
 * Pull `@mechanism` blocks out of one file's comments.
 *
 * The block runs from the tag to the first blank comment line, a line that is
 * not a comment, or the next tag. Leading ` * ` is stripped; everything else the
 * author wrote — including their line breaks, which carry meaning in this repo's
 * docstrings — is preserved and re-wrapped only at render time.
 */
function mechanismsIn(file: string): Mechanism[] {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const out: Mechanism[] = []

  for (let i = 0; i < lines.length; i++) {
    // `--` is a comment marker in .sql only — in a .ts file it is a SQL
    // fragment inside a template literal, i.e. code.
    const sql = /\.sql$/.test(file)
    const strip = (s: string) =>
      s.replace(sql ? /^\s*(--)\s?/ : /^\s*(\/\*\*?|\*\/|\*|\/\/)\s?/, '').replace(/\s*\*\/\s*$/, '')
    const tag = strip(lines[i] as string).match(/^@mechanism\s+(.+)$/)
    if (!tag) continue

    const head = (tag[1] as string).trim()
    const parts: string[] = [head]

    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j] as string
      if (!(sql ? /^\s*(--)/ : /^\s*(\*|\/\/)/).test(raw)) break // left the comment
      const text = strip(raw)
      if (!text.trim()) break // blank comment line ends the block
      if (/^@\w+/.test(text.trim())) break // next tag
      parts.push(text.trim())
    }

    const whole = parts.join(' ').replace(/\s+/g, ' ').trim()
    const m = whole.match(/^(.+?)\s+[—-]\s+(.+)$/)
    const name = (m ? m[1] : whole).trim()
    let body = (m ? m[2] : '').trim()

    const closes: string[] = []
    body = body.replace(/\bCloses\s+((?:F-[A-Z]+)(?:\s*(?:,|and)\s*F-[A-Z]+)*)\s*\.?/i, (_all, list: string) => {
      for (const cm of list.matchAll(/F-[A-Z]+/g)) closes.push(cm[0])
      return ''
    })

    out.push({ name, body: body.replace(/\s+/g, ' ').trim(), closes, file, line: i + 1 })
  }
  return out
}

const files = ROOTS.flatMap((r) => walk(r))
const mechanisms = files.flatMap((f) => mechanismsIn(f)).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

/* -------------------------------------------------------------------------- *
 * Check the `Closes` clauses against the ledger
 * -------------------------------------------------------------------------- */

const problems: string[] = []
const ledger = new Map(readFindings().map((f) => [f.code, f]))

/**
 * The name must still be findable in the file it names.
 *
 * A tag is only worth reading if `@mechanism registerExpiry` means you can grep
 * `registerExpiry` and land on it. Rename the symbol and leave the tag and the
 * index points at nothing — the specific rot that makes an index worse than no
 * index, because the reader trusts it before they check it.
 *
 * Deliberately a substring test and not a parse: names here are exports, columns
 * (`message.stateKey`), migration objects (`app.coach_hours`) and config keys,
 * and no single grammar covers them. Dotted names are checked on their last
 * segment, since `message.stateKey` appears in the source as `stateKey`.
 */
/**
 * Comment lines are stripped before the search, and that is the whole point.
 *
 * The first version of this searched the raw file, so the tag matched itself:
 * `@mechanism noteUntold` contains "noteUntold", and renaming the symbol in code
 * while leaving the tag behind sailed through green. A check that reads its own
 * claim as its own evidence proves nothing.
 */
const codeOnly = (file: string) =>
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    // `--` strips comments in .sql only: in a .ts file a `--`-leading line is
    // usually a SQL fragment inside a template literal — that is code, and one
    // such line is where bothSidesOfTheMoney's symbol actually lives.
    .filter((l) => !(/\.sql$/.test(file) ? /^\s*(--)/.test(l) : /^\s*(\*|\/\/|\/\*)/.test(l)))
    .join('\n')

for (const m of mechanisms) {
  const src = codeOnly(m.file)
  const needle = (m.name.split('.').pop() ?? m.name).replace(/[`()]/g, '').trim()
  if (needle && !src.includes(needle)) {
    problems.push(
      `${m.file}:${m.line} — the tag names \`${m.name}\` but "${needle}" appears nowhere in that ` +
        `file. Renamed or deleted? An index that points at nothing is worse than no index.`,
    )
  }
  for (const code of m.closes) {
    const f = ledger.get(code)
    if (!f) {
      problems.push(`${m.file}:${m.line} — \`${m.name}\` claims to close ${code}, which is not in the ledger`)
    } else if (!f.closed) {
      problems.push(
        `${m.file}:${m.line} — \`${m.name}\` claims to close ${code}, but the ledger still calls it open. ` +
          `One of the two is wrong and an agent will read whichever it reaches first.`,
      )
    }
  }
}

/* -------------------------------------------------------------------------- *
 * Render
 * -------------------------------------------------------------------------- */

/** `lib/agent/loop.ts` → `lib/agent`. Grouping is by directory, not by file. */
const groupOf = (file: string) => file.split(sep).slice(0, -1).join('/')

const groups = new Map<string, Mechanism[]>()
for (const m of mechanisms) groups.set(groupOf(m.file), [...(groups.get(groupOf(m.file)) ?? []), m])

const closedByMech = new Set(mechanisms.flatMap((m) => m.closes))
const openFindings = readFindings().filter((f) => !f.closed)

const md: string[] = []
md.push('# What the brain already does')
md.push('')
md.push('<!-- GENERATED by `npm run mechanisms` from @mechanism tags in lib/. Do not edit. -->')
md.push('')
md.push(
  'Read this **before** opening `lib/`. It is the map from a symptom to the mechanism that',
  'already handles it, and it exists because the alternative — reading the brain — costs about',
  '209,000 tokens for `lib/agent` alone and still leaves you guessing, since a mechanism is',
  'rarely named after the defect it retires.',
)
md.push('')
md.push(
  'If you are about to propose a fix, look for it here first. On 20 Aug 2026 `npm run findings`',
  'reported 38 findings open and **29 of them were already built** — the ledger said so in a table',
  'nothing parsed. Analysis kept proposing `context_query` validation (F-AP), message `stateKey`',
  '(F-AN) and event-text filling (F-AZ), all shipped.',
)
md.push('')
md.push(
  '**To read what is actually sent to the model:** `npm run surface` — the stable prefix and the',
  'tool declarations, assembled, in one greppable file. `npx tsx scripts/probe-prefix.ts --text` is',
  'the prefix alone. Both call the same `stablePrefix()` the runtime calls, so what prints is what',
  'is sent. Reading `context.ts` is not the same thing: the prefix is assembled from six pieces and',
  'a fact can be present in one and contradicted in another.',
)
md.push('')
md.push('## Adding to this file')
md.push('')
md.push(
  'Tag the mechanism where it lives, in a block comment beside the code:',
  '',
  '```',
  ' * @mechanism <realSymbol> — <what it does, and the class of defect it retires>.',
  ' *   <continuation lines indented, same comment block, no blank comment line inside>',
  ' *   Closes F-XX.',
  '```',
  '',
  'The name must be a symbol that really appears in that file — the build rejects an invented one.',
  '`Closes F-XX` is optional, and is checked against the ledger: naming a finding that does not',
  'exist, or one still marked open, fails. Then run `npm run mechanisms`.',
)
md.push('')
md.push(`${mechanisms.length} mechanisms · ${closedByMech.size} findings closed by one · ${openFindings.length} findings still open`)
md.push('')

/* -------------------------------------------------------------------------- *
 * Tier one: the scan
 * -------------------------------------------------------------------------- *
 *
 * The full entries below are ~21k tokens, which is ten times cheaper than the
 * brain and still too expensive to read on the way to every question. So the
 * gist comes first — one line each, about 2k for the lot — and it is enough to
 * answer "does something already handle this?" for most of what gets asked.
 * Drop to the detail only for the two or three that look relevant.
 *
 * The gist is the body's first SENTENCE, not a second thing someone writes. A
 * summary maintained by hand is the drift this file exists to end.
 *
 * Two render rules, both learned from the first version. It splits on periods
 * only — the clause splitter also broke on ":" and ";", so any tag whose first
 * line ended in a colon rendered as a dangling fragment ("…set by what its
 * payload CARRIES rather than by one wall-clock constant:"). And an over-budget
 * sentence is cut at a WORD boundary — the old hard slice cut mid-word
 * ("…carries all three c…"), which reads as corruption and buries the one word
 * that mattered.
 */
const GIST_MAX = 160
const gist = (m: Mechanism) => {
  const first = (m.body.split(/(?<=\.)\s/)[0] ?? m.body).replace(/\s+/g, ' ').trim()
  if (first.length <= GIST_MAX) return first
  const cut = first.slice(0, GIST_MAX - 1)
  const atWord = cut.slice(0, cut.lastIndexOf(' '))
  return `${atWord.replace(/[\s,;:—-]+$/, '')}…`
}

md.push('## The scan')
md.push('')
md.push('One line each. Find a candidate here, then read its entry below.')
md.push('')
for (const [group, ms] of [...groups].sort()) {
  md.push(`**\`${group}/\`**  `)
  for (const m of ms) md.push(`\`${m.name}\` — ${gist(m)}  `)
  md.push('')
}
md.push('---')
md.push('')
md.push('## The detail')
md.push('')

for (const [group, ms] of [...groups].sort()) {
  md.push(`## \`${group}/\``)
  md.push('')
  for (const m of ms) {
    const closes = m.closes.length ? ` **Closes ${m.closes.join(', ')}.**` : ''
    md.push(`- **\`${m.name}\`** — \`${m.file.split(sep).join('/')}:${m.line}\`  `)
    md.push(`  ${m.body}${closes}`)
  }
  md.push('')
}

/**
 * The open list is LINKED, not copied.
 *
 * It was embedded here first, and that made this file go stale every time a
 * finding closed — two generated documents holding one fact, which is the drift
 * this repo keeps paying for. `findings/OPEN.md` owns that list; this owns the
 * mechanisms. Neither restates the other.
 */
md.push('## Still open')
md.push('')
md.push(
  `No mechanism claims ${openFindings.length} findings. They are listed in`,
  '[`../findings/OPEN.md`](../findings/OPEN.md), which is generated from the ledger and is the',
  'one place that list lives.',
)
md.push('')

const rendered = md.join('\n')

/* -------------------------------------------------------------------------- *
 * Write, or check
 * -------------------------------------------------------------------------- */

const checkOnly = process.argv.includes('--check')

if (problems.length) {
  console.log(c.red(`\n  ${problems.length} mechanism(s) disagree with the ledger:\n`))
  for (const p of problems) console.log(c.red(`  ✗ ${p}`))
  console.log('')
  process.exit(1)
}

if (checkOnly) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (current.replace(/\r\n/g, '\n') !== rendered) {
    console.log(
      c.red(`\n  ${OUT} is out of date — a @mechanism tag changed and the index did not.\n`) +
        c.dim('  Run `npm run mechanisms`.\n'),
    )
    process.exit(1)
  }
  console.log(c.green(`\n  ${OUT} still describes ${mechanisms.length} mechanisms in lib/.\n`))
  process.exit(0)
}

writeFileSync(OUT, rendered, 'utf8')
console.log(
  c.green(`\n  ${OUT} — ${mechanisms.length} mechanisms, ${closedByMech.size} findings closed by one.\n`) +
    c.dim(`  ${openFindings.length} findings remain open — see findings/OPEN.md.\n`),
)

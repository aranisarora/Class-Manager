/**
 * check-layout — do this repo's own indexes still describe this repo?
 *
 *   npm run check:layout
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * On 18 Aug 2026 this repo had three hand-written indexes and all three were
 * wrong, each in a different direction:
 *
 *   - `README.md`'s Layout block listed `lib/web/` and `app/w/[token]/`. Neither
 *     had existed for some time. It also claimed 28 tables against 35 migrations.
 *   - `scripts/README.md` opened with "Forty files" against 47, and five scripts
 *     written the previous day appeared in neither it nor `package.json`.
 *   - `.probe/README.md` documented `arc-report.mjs`, `tennis-report.mjs` and
 *     `_probe-runs.mjs`, all of which `scripts/README.md` records as deleted.
 *
 * An index that is wrong is worse than no index: it is the first thing a person
 * or an agent reads, and it sends them to a path that is not there. The repo
 * already had the answer to this in `check-schema-doc.ts` and `check-rls-doc.ts`
 * — a document that claims something about reality gets a program that checks the
 * claim, and the claim fails the build rather than rotting quietly. This is that,
 * for the structure itself.
 *
 * WHAT IT ASSERTS
 * -----------------------------------------------------------------------------
 *   1. Every path in `README.md`'s Layout block exists.
 *   2. Every file in `scripts/` is named in `scripts/README.md`, and every script
 *      that block names exists.
 *   3. Every `npm run` script points at a file that is there.
 *   4. Every relative markdown link in a tracked `.md` resolves.
 *   5. `.probe/README.md`, when `.probe` exists, names the directories that are
 *      actually in it.
 *
 * It reads no database and starts no server, so it is safe in any environment —
 * that is why it can be a precondition for the others rather than a peer.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, normalize, dirname, relative } from 'node:path'
import { c } from './_env'

const problems: string[] = []
const notes: string[] = []
let checked = 0

const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '')

/* -------------------------------------------------------------------------- *
 * 1 · README.md's Layout block
 * -------------------------------------------------------------------------- */

/**
 * The block is fenced and each line is `<path><spaces><prose>`. Only the first
 * token is a claim about the filesystem; the prose after it is a person's
 * description and is not this program's business.
 */
function layoutPaths(md: string): string[] {
  const m = md.match(/## Layout\s*\n+```\n([\s\S]*?)\n```/)
  if (!m) return []
  return (m[1] as string)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s{2,}/)[0]!.trim())
    .filter((p) => p && !p.startsWith('#'))
}

const readme = read('README.md')
if (!readme) problems.push('README.md is missing')
else {
  const paths = layoutPaths(readme)
  if (!paths.length) {
    problems.push('README.md has no ## Layout block, or it is not a fenced list — the map is gone')
  }
  for (const p of paths) {
    checked++
    // A trailing slash is the block's way of saying "directory"; strip it for the
    // existence test and assert the kind separately, so a file where a directory
    // is documented is caught rather than passing.
    const wantsDir = p.endsWith('/')
    const bare = wantsDir ? p.slice(0, -1) : p
    if (!existsSync(bare)) {
      problems.push(`README.md Layout names \`${p}\` and it does not exist`)
      continue
    }
    const isDir = statSync(bare).isDirectory()
    if (wantsDir && !isDir) problems.push(`README.md Layout writes \`${p}\` as a directory and it is a file`)
    if (!wantsDir && isDir) problems.push(`README.md Layout writes \`${p}\` as a file and it is a directory`)
  }
}

/* -------------------------------------------------------------------------- *
 * 2 · scripts/README.md against scripts/
 * -------------------------------------------------------------------------- */

const CODE = /\.(ts|tsx|mjs|mts|js|py)$/
const scriptsIndex = read(join('scripts', 'README.md'))
if (!scriptsIndex) problems.push('scripts/README.md is missing — 47 files and no index')
else {
  const onDisk = readdirSync('scripts').filter((f) => CODE.test(f))
  for (const f of onDisk) {
    checked++
    if (!scriptsIndex.includes(f)) {
      problems.push(`scripts/${f} exists and scripts/README.md does not mention it`)
    }
  }
  // …and the other direction: an index that names a script that was deleted sends
  // a reader to run something that is not there.
  for (const m of scriptsIndex.matchAll(/`([A-Za-z0-9_.-]+\.(?:ts|tsx|mjs|mts|js|py))`/g)) {
    const name = m[1] as string
    checked++
    if (!existsSync(join('scripts', name))) {
      // The index has a "What was removed, and why" section that names dead files
      // on purpose. Only complain about names above it.
      const at = scriptsIndex.indexOf(m[0])
      const graveyard = scriptsIndex.indexOf('## What was removed')
      if (graveyard === -1 || at < graveyard) {
        problems.push(`scripts/README.md names \`${name}\` and scripts/${name} does not exist`)
      }
    }
  }
}

/* -------------------------------------------------------------------------- *
 * 3 · package.json scripts point at files that exist
 * -------------------------------------------------------------------------- */

try {
  const pkg = JSON.parse(read('package.json') || '{}')
  for (const [name, cmd] of Object.entries<string>(pkg.scripts ?? {})) {
    const m = String(cmd).match(/(scripts\/[A-Za-z0-9_.-]+\.(?:ts|tsx|mjs|mts|js|py))/)
    if (!m) continue
    checked++
    if (!existsSync(m[1] as string)) {
      problems.push(`package.json "${name}" runs ${m[1]} and it does not exist`)
    }
  }
} catch (e) {
  problems.push(`package.json did not parse — ${(e as Error).message}`)
}

/* -------------------------------------------------------------------------- *
 * 4 · Every relative markdown link resolves
 * -------------------------------------------------------------------------- */

const SKIP = new Set(['node_modules', '.git', '.next', '.next-build', '.probe', '.vercel', 'out', 'build'])
function markdownFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) markdownFiles(p, acc)
    else if (e.name.endsWith('.md')) acc.push(p)
  }
  return acc
}

for (const f of markdownFiles('.')) {
  const md = read(f)
  for (const m of md.matchAll(/\]\((\.[^)#\s]*\.md)(?:#[^)]*)?\)/g)) {
    checked++
    const target = normalize(join(dirname(f), m[1] as string))
    if (!existsSync(target)) {
      problems.push(`${f} links to ${m[1]} and it does not resolve (${target})`)
    }
  }
}

/* -------------------------------------------------------------------------- *
 * 5 · .probe/README.md against .probe/
 * -------------------------------------------------------------------------- *
 *
 * Advisory, not fatal. `.probe` is gitignored, so a fresh clone has none of it and
 * a missing directory there is not a defect in the repo — it is a repo nobody has
 * measured yet. What IS worth saying out loud is a corner that grew back.
 */
if (existsSync('.probe')) {
  const probeIndex = read(join('.probe', 'README.md'))
  const dirs = readdirSync('.probe', { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
  if (!probeIndex) {
    notes.push('.probe exists and has no README.md — nothing says what is in it')
  } else {
    for (const d of dirs) {
      checked++
      if (!probeIndex.includes(`${d}/`) && !probeIndex.includes(`\`${d}\``)) {
        problems.push(`.probe/${d}/ exists and .probe/README.md does not describe it`)
      }
    }
  }
}

/* -------------------------------------------------------------------------- *
 * The verdict
 * -------------------------------------------------------------------------- */

console.log(c.dim(`\n  ${checked} structural claims checked`))
for (const n of notes) console.log(c.yellow(`  note: ${n}`))

if (!problems.length) {
  console.log(c.green('\n  every index still describes the repo.\n'))
  process.exit(0)
}
console.log(c.red(`\n  ${problems.length} index claim(s) the repo does not support:\n`))
for (const p of problems) console.log(c.red(`  ✗ ${p}`))
console.log(
  c.dim(
    '\n  Fix the index or fix the repo. An index that is wrong is worse than no index:\n' +
      '  it is the first thing the next reader trusts.\n',
  ),
)
process.exit(1)

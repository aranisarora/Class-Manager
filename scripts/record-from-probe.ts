/**
 * record-from-probe — write `record.json` for a `probe-model` run that predates
 * the instrument writing one itself.
 *
 *   npx tsx scripts/record-from-probe.ts --run .probe/runs/2026-08-17-1439-stress-week
 *   npx tsx scripts/record-from-probe.ts --run <dir> --arm deepseek-v4-flash
 *   npm run record:backfill                 # every run in .probe/runs that lacks one
 *
 * WHY THIS STILL EXISTS
 * -----------------------------------------------------------------------------
 * `probe-model` now writes `record.json` at the end of a single-arm run, so a
 * fresh run never needs this. Two cases still do:
 *
 *   1. The runs already on disk. 22 of them were invisible to `npm run report`.
 *   2. A thinking sweep, which writes one file per arm. Those are different runs
 *      of the same suite and merging them would interleave two academies, so the
 *      instrument writes no record and you pick an arm here.
 *
 * The conversion itself lives in `_record-from-probe.ts` — one implementation,
 * shared with the instrument, so a backfilled record and a fresh one are the same
 * bytes for the same input.
 */
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnvFiles, c } from './_env'
import { armFiles, armPathIn, toRunFromFile } from './_record-from-probe'

loadEnvFiles()

const argv = process.argv.slice(2)
const has = (n: string): boolean => argv.includes(`--${n}`)
const flag = (n: string, d = ''): string => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return d
  const a = argv[i] as string
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? d)
}

const RUNS = join('.probe', 'runs')

/**
 * The suite, read off the directory name rather than asked for.
 *
 * `_capture.ts` names every run `<UTC-minute>-<suite>`, and `probe-model` runs
 * were named by hand to the same convention — `2026-08-16-1308-arc-r8`. The
 * trailing label after the suite is a person's note about the revision, so the
 * suite is the first token that is not part of the stamp.
 */
const SUITES = ['stress', 'tennis', 'real', 'adv', 'arc', 'week', 'ask', 'sql', 'live', 'fo', 'fq']

function suiteOf(dir: string): string {
  const base = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
  const rest = base.replace(/^\d{4}-\d{2}-\d{2}-\d{2}-?\d{2}-?/, '')
  // `f-o-recheck` and `fo-regression` are the same suite spelled two ways, and
  // splitting on the first dash called the first one "f". Match a known suite
  // before falling back, with the hyphens taken out of the comparison.
  const flat = rest.replace(/-/g, '')
  return SUITES.find((x) => flat.startsWith(x)) ?? rest.split('-')[0] ?? 'probe'
}

/** Convert one run directory. Returns the record path, or null with a reason. */
function convert(runDir: string, armWanted: string): { out: string; turns: number } | null {
  const arms = armFiles(runDir)
  if (!arms.length) {
    console.log(c.dim(`  ${runDir} — no arm files, nothing to convert`))
    return null
  }
  if (!armWanted && arms.length > 1) {
    console.log(
      c.yellow(`  ${runDir} — ${arms.length} arms (${arms.join(', ')}); pass --arm to pick one`),
    )
    return null
  }
  const armPath = armPathIn(runDir, armWanted || (arms[0] as string))
  const run = toRunFromFile(armPath, { suite: suiteOf(runDir) })
  const out = join(runDir, 'record.json')
  writeFileSync(out, JSON.stringify(run, null, 2))
  return { out, turns: run.turns.length }
}

const RUN = flag('run')

if (has('all') || (!RUN && has('backfill'))) {
  /**
   * Every run that has arm files and no record. Deliberately skips the ones that
   * already have one: a record written by the instrument is the instrument's, and
   * overwriting it here would replace a measurement with a reconstruction.
   */
  if (!existsSync(RUNS)) {
    console.error(c.red(`no ${RUNS} — nothing to backfill`))
    process.exit(2)
  }
  const dirs = readdirSync(RUNS, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(RUNS, d.name))
    .filter((d) => !existsSync(join(d, 'record.json')))
    .sort()

  if (!dirs.length) {
    console.log(c.green('  every run already has a record.json\n'))
    process.exit(0)
  }
  console.log(c.bold(`\n  ${dirs.length} run(s) without a record\n`))
  let done = 0
  for (const d of dirs) {
    try {
      const r = convert(d, '')
      if (r) {
        done++
        console.log(`  ${c.green('wrote')} ${r.out} ${c.dim(`— ${r.turns} turns`)}`)
      }
    } catch (e) {
      console.log(c.red(`  ${d} — ${(e as Error).message}`))
    }
  }
  console.log(c.dim(`\n  ${done}/${dirs.length} converted. Now: npm run runs\n`))
  process.exit(0)
}

if (!RUN || !existsSync(RUN)) {
  console.error(
    c.red('record-from-probe — pass --run <.probe/runs/…>, or --all to backfill every run'),
  )
  process.exit(2)
}

try {
  const r = convert(RUN, flag('arm'))
  if (!r) process.exit(1)
  console.log(`  ${r.out} — ${r.turns} turns`)
  console.log(c.dim('  now: npm run report'))
} catch (e) {
  console.error(c.red(`  ${(e as Error).message}`))
  process.exit(1)
}

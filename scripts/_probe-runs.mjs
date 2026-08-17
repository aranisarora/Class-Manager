/**
 * Where probe output lives, and how a report finds the run it should render.
 *
 * `.probe/` holds three kinds of thing and they are kept apart on purpose:
 *
 *   runs/<YYYY-MM-DD>-<suite>-<label>/   one invocation of probe-model. Raw
 *                                        records (`<model>[--thinking-<arm>].json`),
 *                                        `score.md`, and `run.log` if one was kept.
 *   reports/<YYYY-MM-DD>-<name>.html     rendered pages, dated by the run they describe.
 *   drive-month/, emulator-shots/        one-off artifacts that are not probe runs.
 *
 * The date prefix is the whole point: runs supersede each other, and the only
 * question a reader ever has is which one is newest. Sorting the directory
 * listing answers it, and so does this file.
 *
 * WHY THE DEFAULTS ARE COMPUTED RATHER THAN WRITTEN DOWN
 * -----------------------------------------------------------------------------
 * These reports used to default to a hardcoded path — `.probe/adv/…json`. A
 * default that names one frozen run is wrong the moment the next run lands, and
 * it fails in the worst direction: the script succeeds and renders stale
 * evidence. `adv-report.mjs`'s default had already rotted to a filename that did
 * not exist. Resolving the newest matching run cannot rot, and when nothing
 * matches it says so instead of guessing.
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const PROBE = join(process.cwd(), '.probe')
export const RUNS = join(PROBE, 'runs')
export const REPORTS = join(PROBE, 'reports')

/**
 * A run directory is `<YYYY-MM-DD>-<HHMM>-<suite>-<label>`, local time.
 *
 * The clock time is in the name because five arc runs landed on 16 Aug and a
 * date alone left `ls` sorting them alphabetically — which put `arc-verify`
 * above `arc-redrive`, three hours its senior. With the time in front, name
 * order IS time order, and the two ways of asking "which is newest" agree.
 * The time group is optional so a directory made the old way still resolves.
 */
const RUN_DIR = /^(\d{4}-\d{2}-\d{2})(?:-(\d{4}))?-(.+)$/

/** When a run was actually written: the newest mtime among its own files. */
function wroteAt(dir) {
  let newest = 0
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    const st = statSync(p)
    if (st.isFile() && st.mtimeMs > newest) newest = st.mtimeMs
  }
  return newest
}

/**
 * The newest run of a suite, or null. `suite` matches the token straight after
 * the date, so 'arc' finds `2026-08-16-arc-verify` and never `…-adv-hostile`.
 *
 * Ordered by when the run was WRITTEN, not by directory name. The date prefix
 * exists so a human reading `ls` sees the sequence, but five arc runs landed on
 * 16 Aug and sorting their names alphabetically puts `arc-verify` above
 * `arc-redrive` — which is three hours older. Name order is for the eye; mtime
 * is the fact.
 */
export function latestRun(suite) {
  if (!existsSync(RUNS)) return null
  const found = readdirSync(RUNS)
    .map((name) => {
      const m = RUN_DIR.exec(name)
      if (!m) return null
      const rest = m[3]
      if (rest !== suite && !rest.startsWith(`${suite}-`)) return null
      const dir = join(RUNS, name)
      if (!statSync(dir).isDirectory()) return null
      return { name, date: m[1], time: m[2] ?? null, label: rest, dir, at: wroteAt(dir) }
    })
    .filter(Boolean)
    .sort((a, b) => b.at - a.at)
  return found[0] ?? null
}

/**
 * The record file inside a run: a caller's preferred filename if it is there,
 * otherwise the biggest `.json` that is not the hand-written judgements. Biggest
 * is the right tiebreak — a run's record file dwarfs anything else beside it.
 */
export function recordIn(dir, ...preferred) {
  for (const p of preferred) {
    if (p && existsSync(join(dir, p))) return join(dir, p)
  }
  const cands = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'judgements.json')
    .map((f) => ({ f, size: statSync(join(dir, f)).size }))
    .sort((a, b) => b.size - a.size)
  return cands.length ? join(dir, cands[0].f) : null
}

/**
 * What a report needs to start: the newest run of `suite`, its record file, and
 * an output path. Returns null rather than a half-answer, so the caller can
 * print a usable error naming the flag to pass instead.
 *
 * The page is named after the RUN, not after the date and suite: two arc runs
 * on one day is the normal case here (there were five on 16 Aug), and a name
 * built from date+suite would have the second silently overwrite the first.
 */
export function newest(suite, { prefer, out } = {}) {
  const run = latestRun(suite)
  if (!run) return null
  const record = recordIn(run.dir, prefer)
  if (!record) return null
  return {
    ...run,
    record,
    judgements: join(run.dir, 'judgements.json'),
    out: join(REPORTS, `${run.name}-${out ?? 'readiness'}.html`),
  }
}

/** One line, for a report to print so the reader knows what was rendered. */
export function describe(suite, picked) {
  return picked
    ? `${suite}: newest run is ${picked.name} (${picked.record.split(/[\\/]/).pop()})`
    : `${suite}: no run found under .probe/runs/`
}

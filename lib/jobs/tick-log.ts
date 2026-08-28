/**
 * lib/jobs/tick-log.ts — the production beat's own record (0029).
 *
 * `runDueJobs` already returns a RunReport, and on localhost that is enough:
 * the emulator's tick hands it straight back to an operator who is looking at
 * it. In production the caller is Supabase pg_cron via pg_net, whose `http_post`
 * is fire-and-forget — the reply is discarded before anything reads it. So the
 * report has to be written down somewhere durable or it does not exist, and §13
 * rule 3 ("a job that did not run is invisible failure") would apply to the
 * runner itself: the beat could stop for a day and the first symptom would be a
 * parent who never got a reminder.
 *
 * ONE RULE GOVERNS THIS FILE: `recordTick` never throws. A tick that ran twenty
 * jobs correctly and then failed to write its diary has not failed, and turning
 * that into a 500 would be the log deciding it is more important than the work.
 * So every path — bad Date, circular `planned`, pooler exhausted, table missing
 * because 0029 has not been pushed yet — is caught here and reported to the
 * platform log instead, where a serverless operator can still see it.
 *
 * It is deliberately NOT re-exported from `lib/jobs/index.ts`: that barrel is
 * the surface *other modules* need, and the only legitimate caller of this is
 * the cron route itself. A handler writing tick rows would be a category error.
 */

import { errorMessage } from '@/lib/errors'
import { clamp, withInfra } from './util'

export type TickEntry = {
  /** Wall clock, not `app.now()` — see the TIME note in 0029. */
  startedAt: Date
  finishedAt: Date
  durationMs: number
  ran: number
  skipped: number
  failed: number
  /** Whatever `planAhead()` returned: a bare count today, a shape tomorrow. */
  planned: unknown
  /** `RunReport.log`, plus any lines the caller wants kept with it. */
  log: string[]
  /** null on success. Set means the tick threw and the counters are partial. */
  error: string | null
}

/**
 * The `log` column is the only unbounded thing in the row, and this row is
 * written every sixty seconds forever. A normal tick is a handful of lines plus
 * at most fifty from `reportMissed`, so these caps never fire in practice —
 * they exist so that one pathological tick (a handler looping, a model echoing
 * its prompt into an error message) cannot put a megabyte a minute into the
 * database.
 */
const MAX_LOG_LINES = 500
const MAX_LINE_CHARS = 2_000

/**
 * Elided from the MIDDLE, not the end. Both ends carry the evidence: the first
 * lines are the jobs that ran, the last are `reportMissed`'s overdue list, and
 * a plain `slice(0, 500)` would throw away the half that says a digest never
 * went out.
 */
function boundedLog(log: string[]): string[] {
  const lines = (log ?? []).map((l) => clamp(String(l), MAX_LINE_CHARS))
  if (lines.length <= MAX_LOG_LINES) return lines
  const head = Math.ceil(MAX_LOG_LINES / 2)
  const tail = MAX_LOG_LINES - head
  return [
    ...lines.slice(0, head),
    `… ${lines.length - MAX_LOG_LINES} line(s) elided by tick-log`,
    ...lines.slice(lines.length - tail),
  ]
}

/**
 * The previous beat's outcome, for `shouldPlan` in the cron route — the one
 * signal that a handler may have changed the calendar since the last full
 * planning sweep. Same rule as `recordTick`: never throws. `null` means the
 * diary is unreadable, and the caller treats that as "plan" — an unreadable
 * log must degrade to the old always-plan behaviour, not to silence.
 */
export async function readLastTick(): Promise<{ ran: number; failed: number; error: string | null } | null> {
  try {
    const rows = await withInfra((tx) => tx<{ ran: number; failed: number; error: string | null }[]>`
      select ran, failed, error from tick_runs order by started_at desc limit 1
    `)
    return rows[0] ?? null
  } catch {
    return null
  }
}

/**
 * Insert one `tick_runs` row. Returns quietly whether or not it worked.
 *
 * `withInfra` because `tick_runs` carries no tenant (§6.6, the same reason
 * `job` does not) — a tick claims across every academy at once, so there is no
 * academy this row could belong to. The jsonb columns are written
 * `::text::jsonb` rather than `::jsonb`; the note above `jsonSafe` in
 * lib/seed.ts explains why the shorter spelling silently stores a JSON *string*
 * instead of the value, and every read of it then finds nothing.
 */
export async function recordTick(entry: TickEntry): Promise<void> {
  try {
    // Inside the try on purpose: `toISOString` throws on an invalid Date and
    // `JSON.stringify` throws on a circular `planned`, and neither of those is
    // allowed to reach the caller either.
    const startedAt = entry.startedAt.toISOString()
    const finishedAt = entry.finishedAt.toISOString()
    const planned = JSON.stringify(entry.planned ?? null)
    const log = JSON.stringify(boundedLog(entry.log))

    await withInfra((tx) => tx`
      insert into tick_runs
             (started_at, finished_at, duration_ms, ran, skipped, failed, planned, log, error)
      values (${startedAt}::timestamptz, ${finishedAt}::timestamptz,
              ${Math.round(entry.durationMs)}::int,
              ${entry.ran}::int, ${entry.skipped}::int, ${entry.failed}::int,
              ${planned}::text::jsonb, ${log}::text::jsonb, ${entry.error})
    `)
  } catch (e) {
    // Loud where the platform can see it, silent to the caller. A tick log that
    // can never be written is worth knowing about — most likely 0029 has not
    // been pushed to this database yet — but it is not the tick's problem.
    console.error(`[tick-log] could not record the tick: ${errorMessage(e)}`)
  }
}

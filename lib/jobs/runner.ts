/**
 * lib/jobs/runner.ts — claim what is due, run it, say what happened (§13).
 *
 * The four §13 rules, made mechanical:
 *
 *  1. **Idempotent via `dedupe_key`.** Enqueueing twice is a no-op — see
 *     `enqueue.ts`. Claiming is `for update skip locked`, so two runners cannot
 *     take the same row.
 *  2. **Every handler re-checks its precondition at run time.** Handlers say so
 *     by calling `skip()`, which lands here as `skipped`, never `failed`. A
 *     cancelled session's `coach_coming` finds `status='cancelled'` and stands
 *     down; the enqueue-time world is never trusted.
 *  3. **A job that did not run is invisible failure.** `runDueJobs` returns a
 *     log, and anything still pending or failed well past its `run_at` is
 *     reported in it — loudly for the two bookends, because a missing evening
 *     digest is a silent outage.
 *  4. **Rescheduling cancels by dedupe key and re-enqueues** — see
 *     `cancelSessionJobs` in `enqueue.ts`.
 *
 * **Quiet hours are a floor under every proactive send, and it is not here.**
 * This file used to say there were none, which was true of the send path and
 * false of the planner — so the product both had them and did not, and going live
 * at 2am fired three reminder templates at 02:02. The window lives in
 * `lib/clock.ts` and binds in `lib/messaging/send.ts`, where every author passes.
 * The runner still fires whenever a job is due: a 5am job for a 6am class is
 * normal and correct, and what the floor stops is the message, not the work.
 */

import type { Job } from '@/lib/types'
import { MAX_ATTEMPTS, MISSED_AFTER_MINUTES, type JobKind } from './kinds'
import { JobSkip, msOf, setJobOrigin, setNoteSink, withInfra } from './util'
import { materializeSessions, postClassRegister, registerExpiry } from './handlers/sessions'
import { coachComing, coachDay, coachNudge } from './handlers/coach'
import {
  clientOutcome, clientReminder, clientSessionTrouble, firstContactBatch,
} from './handlers/client'
import {
  adminEscalateUncovered, adminEveningDigest, adminMorningBrief, coachNotOnboarded,
} from './handlers/admin'
import { coachMonthLines, dunningRun, monthEndTally, monthlyLines, reconcile } from './handlers/money'
import { agentTask, memoryCurate } from './handlers/agent-task'

/** Every kind in the §13 table has a handler here, or it does not exist. */
export const HANDLERS: Record<JobKind, (job: Job) => Promise<void>> = {
  materialize_sessions: materializeSessions,
  coach_day: coachDay,
  coach_coming: coachComing,
  coach_nudge: coachNudge,
  admin_escalate_uncovered: adminEscalateUncovered,
  client_session_trouble: clientSessionTrouble,
  client_reminder: clientReminder,
  post_class_register: postClassRegister,
  register_expiry: registerExpiry,
  client_outcome: clientOutcome,
  admin_morning_brief: adminMorningBrief,
  admin_evening_digest: adminEveningDigest,
  monthly_lines: monthlyLines,
  month_end_tally: monthEndTally,
  coach_month_lines: coachMonthLines,
  dunning: dunningRun,
  first_contact_batch: firstContactBatch,
  memory_curate: memoryCurate,
  coach_not_onboarded: coachNotOnboarded,
  reconcile: reconcile,
  agent_task: agentTask,
}

export type RunReport = { ran: number; skipped: number; failed: number; log: string[] }

const WORKER = `runner:${process.pid}`
const DEFAULT_LIMIT = 200
/** A handler can enqueue work that is already due (the ladder does). Drain it. */
const MAX_ROUNDS = 8

/**
 * How long a `running` row may hold its lock before another runner may take it.
 *
 * Nothing releases a lock when the process holding it dies — a crash, a container
 * restart, or a serverless instance frozen mid-handler leaves the row `running`
 * with a `locked_by` nobody is listening to. `claim()` only ever looked at
 * `pending`, and `reportMissed` only reports `pending` and `failed`, so such a row
 * was invisible to both: it never ran again and it never showed up as a failure.
 * That is rule 3's exact failure mode — a job that did not run, invisibly.
 *
 * Generous on purpose. A handler that legitimately runs for fifteen minutes and a
 * handler whose process died look identical from here, and reclaiming a live one
 * runs it twice. Every handler re-checks its own precondition (rule 2), so a
 * double-run is survivable; a permanently stranded job is not.
 *
 * @mechanism LOCK_STALE_MINUTES — a `running` row whose worker died is reclaimed to
 *   `pending` once its lock is older than this, with the reclaim appended to
 *   `last_error` so the row says what happened to it. Nothing releases a lock when a
 *   process dies, and `claim()` only ever looked at `pending`, so such a row never ran
 *   again and never appeared as a failure — §13 rule 3's exact failure mode, a job that
 *   did not run, invisibly.
 */
const LOCK_STALE_MINUTES = 15

async function claim(limit: number): Promise<Job[]> {
  await withInfra((tx) => tx`
    update job
       set status = 'pending', locked_at = null, locked_by = null,
           last_error = coalesce(last_error, '') ||
             case when coalesce(last_error, '') = '' then '' else ' | ' end ||
             'reclaimed: lock held past ' || ${LOCK_STALE_MINUTES}::text || 'm by ' || coalesce(locked_by, '?')
     where status = 'running'
       and locked_at is not null
       and locked_at < app.now() - make_interval(mins => ${LOCK_STALE_MINUTES}::int)
  `)
  /**
   * **Due according to WHOSE clock.**
   *
   * This was `run_at <= app.now()`, and `app.now()` resolves the clock of the
   * session asking — which for this claim is an infra session pinned to no
   * tenant at all, so it always got the world clock. With per-academy clocks
   * (0024) that is one tenant's time running another tenant's jobs: hold
   * academy A four hours ahead to reach a session and every pending job in
   * academy B fires too, four hours early, and declines as stale. The
   * transcript reads calm, which is the whole reason this had to be fixed
   * before anything drives in parallel.
   *
   * A job carries its tenant in `payload->>'academy_id'` rather than a column,
   * so that is what the comparison has to read. `app.now_for(null)` is the
   * world clock, which is the right answer for the handful of jobs that carry
   * no tenant.
   *
   * The cost is real and accepted: this cannot use an index on `run_at` alone
   * any more, because the bound is now per row. `job` is small, the scan is
   * bounded by `limit`, and correctness across tenants is worth more than an
   * index seek on a table this size. If it ever stops being small, the fix is
   * a generated `academy_id` column on `job` with an index on
   * `(academy_id, status, run_at)` — not a return to one global clock.
   *
   * @mechanism app.now_for — a job is due against the clock of its OWN tenant, read from
   *   `payload->>'academy_id'`, not against whatever clock the claiming session resolves.
   *   The infra session is pinned to no tenant, so `app.now()` here was always the world
   *   clock: with per-academy clocks (0024), holding academy A four hours ahead to reach a
   *   session fired every pending job in academy B four hours early, where they declined as
   *   stale and the transcript still read calm. Costs a per-row bound instead of an index
   *   seek on `run_at`, accepted deliberately.
   *
   * **And belonging to WHOSE business.**
   *
   * `lane` (0040) is the second half of the same question. This claim used to
   * ask only whether a row was pending and due, which is a filter with no owner
   * in it — and one database serves both the deployed beat and every local
   * drive. The beat runs this every sixty seconds; a drive drains when a driver
   * says so; the beat therefore wins every race. The drive then finds its own
   * job already `done` and records a week in which nothing happened, and the
   * message the stolen job sent went out over the live Cloud credentials this
   * process is holding — a test that can put text on a real handset.
   *
   * The filter has to be a column on `job` rather than a join to
   * `academy.is_sandbox`, because this session is pinned to the NIL uuid and
   * `academy` RLS is `using (id = app.academy_id())`: the join returns zero rows
   * with no error and the predicate silently means nothing. 0040's header has
   * the long version.
   *
   * @mechanism lane — the production beat claims `lane = 'live'` and nothing else, so a
   *   simulated tenant's jobs are invisible to it however often it ticks. One database
   *   serves the deployed site and every local drive, and this claim previously filtered on
   *   pending-and-due with no owner at all: the beat took the drive's jobs, the drive
   *   recorded a week in which nothing happened, and the beat — holding the live Cloud
   *   credentials — executed a test's job against a real number. The lane is stamped by
   *   trigger from the academy in the payload (`app.stamp_job_lane`), never by a caller,
   *   and defaults to `live` so a job nobody classified is treated as a real business's.
   *   Closes F-CF.
   */
  const rows = await withInfra((tx) => tx<Job[]>`
    with due as (
      select id from job
       where status = 'pending'
         and lane = 'live'
         and run_at <= app.now_for((payload->>'academy_id')::uuid)
       order by run_at asc, created_at asc
       limit ${limit}
       for update skip locked
    )
    update job j
       set status = 'running', attempts = j.attempts + 1,
           locked_at = app.now(), locked_by = ${WORKER}
      from due
     where j.id = due.id
    returning j.*
  `)
  return [...rows].sort((a, b) => msOf(a.run_at) - msOf(b.run_at))
}

async function finish(id: string, status: 'done' | 'skipped', reason: string | null): Promise<void> {
  await withInfra((tx) => tx`
    update job set status = ${status}, last_error = ${reason}, locked_at = null, locked_by = null
     where id = ${id}
  `)
}

/** Transient failures get a couple of goes; after that the row stands as failed
 *  evidence rather than disappearing. `attempts` was stamped at claim time. */
async function fail(job: Job, error: string): Promise<boolean> {
  // `claim()` already did `attempts = attempts + 1` and Postgres RETURNING on an
  // UPDATE yields the NEW row, so `job.attempts` counts this run. Adding one more
  // here counted every failure twice: MAX_ATTEMPTS of 3 bought two runs, not
  // three, and the backoff doubled with it (first retry at 10 minutes, not 5).
  const attempts = Number(job.attempts ?? 0)
  const retry = attempts < MAX_ATTEMPTS
  if (retry) {
    const backoffMinutes = 5 * attempts
    await withInfra((tx) => tx`
      update job
         set status = 'pending',
             run_at = app.now() + make_interval(mins => ${backoffMinutes}::int),
             last_error = ${error}, locked_at = null, locked_by = null
       where id = ${job.id}
    `)
  } else {
    await withInfra((tx) => tx`
      update job set status = 'failed', last_error = ${error}, locked_at = null, locked_by = null
       where id = ${job.id}
    `)
  }
  return retry
}

/**
 * §13 rule 3. Anything overdue and still not done is surfaced, because the
 * failure mode of a scheduler is silence. The two bookends are called out by
 * name: a missing digest is not a late job, it is an outage the admin should
 * hear about.
 *
 * @mechanism reportMissed — every run ends by reporting what did NOT run: anything past
 *   its `run_at` by MISSED_AFTER_MINUTES and still `pending`, `failed` or `running`, with
 *   the two bookends labelled MISSED rather than overdue. `running` belongs in that list
 *   because a row whose worker died is the one status meaning nobody is coming back for
 *   it. Without this a scheduler reports only what it managed to do, which is the half of
 *   the truth that never contains the outage.
 */
async function reportMissed(log: string[]): Promise<void> {
  const rows = await withInfra((tx) => tx<
    { kind: string; dedupe_key: string; run_at: Date; status: string; last_error: string | null }[]
  >`
    select kind, dedupe_key, run_at, status, last_error
      from job
     -- 'running' belongs here too: a row whose worker died holds its lock until
     -- claim() reclaims it, and until then it is neither pending nor failed. Left
     -- out, the one status that means nobody is coming back for this was the one
     -- status rule 3 could not see.
     where status in ('pending', 'failed', 'running')
       -- Same lane as the claim above, and for the report's own sake rather than
       -- for safety. This scheduler is not entitled to run a simulated tenant's
       -- jobs, so it is not entitled to call them missed either: a drive that
       -- opens a week's queue and drains it on its own schedule would otherwise
       -- fill production's log with MISSED lines about jobs that are being
       -- handled correctly by somebody else. A report that cries about work it
       -- refuses to do is a report an operator stops reading, and rule 3 exists
       -- because the failure mode of a scheduler is silence.
       and lane = 'live'
       and run_at < app.now() - make_interval(mins => ${MISSED_AFTER_MINUTES}::int)
     order by run_at asc
     limit 50
  `)
  for (const r of rows) {
    const loud = r.kind === 'admin_evening_digest' || r.kind === 'admin_morning_brief'
    log.push(
      `${loud ? 'MISSED' : 'overdue'} ${r.kind} ${r.dedupe_key} `
      + `(due ${new Date(msOf(r.run_at)).toISOString()}, ${r.status}`
      + `${r.last_error ? `: ${r.last_error}` : ''})`,
    )
  }
}

/**
 * Claim and run everything due at `app.now()`. Safe to call on every tick and
 * after every clock advance — it is the emulator's engine (§17) and the
 * production loop, which are the same thing on purpose.
 */
export async function runDueJobs(o?: { limit?: number }): Promise<RunReport> {
  const limit = Math.max(1, o?.limit ?? DEFAULT_LIMIT)
  const log: string[] = []
  let ran = 0, skipped = 0, failed = 0
  let processed = 0

  for (let round = 0; round < MAX_ROUNDS && processed < limit; round++) {
    const batch = await claim(Math.min(limit - processed, DEFAULT_LIMIT))
    if (batch.length === 0) break

    for (const job of batch) {
      processed++
      const handler = HANDLERS[job.kind as JobKind]
      const notes: string[] = []

      if (!handler) {
        failed++
        await fail(job, `no handler for kind ${job.kind}`)
        log.push(`FAIL ${job.kind} ${job.dedupe_key} — no handler`)
        continue
      }

      setNoteSink(notes)
      // What put the next message on the wire, for the length of this handler.
      setJobOrigin(job.kind)
      try {
        await handler(job)
        ran++
        await finish(job.id, 'done', null)
        log.push(`ran ${job.kind} ${job.dedupe_key}${notes.length ? ` — ${notes.join('; ')}` : ''}`)
      } catch (err) {
        if (err instanceof JobSkip) {
          skipped++
          await finish(job.id, 'skipped', err.reason)
          log.push(`skip ${job.kind} ${job.dedupe_key} — ${err.reason}`)
        } else {
          failed++
          const message = err instanceof Error ? err.message : String(err)
          const retrying = await fail(job, message)
          log.push(`FAIL ${job.kind} ${job.dedupe_key} — ${message}${retrying ? ' (will retry)' : ''}`)
        }
      } finally {
        setNoteSink(null)
        setJobOrigin(undefined)
      }
    }
  }

  await reportMissed(log)
  return { ran, skipped, failed, log }
}

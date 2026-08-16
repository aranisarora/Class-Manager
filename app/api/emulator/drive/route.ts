import { z } from 'zod'

import { now, nextEventAt } from '@/lib/clock'
import { planAhead } from '@/lib/jobs/plan-ahead'
import { runDueJobs, type RunReport } from '@/lib/jobs/runner'
import { OPS_COOKIE, verifyOpsToken } from '@/lib/ops-auth'
import { requireSandbox } from '@/lib/ops-guard'
import { SCENARIO_IDS, clockOffsetMs, drainWebhookEvents, seedWorld } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Run a scenario end to end, in the sandbox only.
 *
 * WHY THIS SITS UNDER `/api/emulator/` AND NOT `/api/ops/`
 * -------------------------------------------------------
 * It is the most destructive handler in the deployment — `seedWorld`'s first statement is
 * `resetWorld()`, which takes every academy, every conversation, `job`, `sim_fault` and the
 * `sender` row carrying the live Cloud credentials — so it is the last one that should have
 * a single lock on it.
 *
 * `middleware.ts` matches `/`, `/emulator*` and `/api/emulator*`; `/api/ops` is explicitly a
 * PUBLIC prefix there, because that is where the login lives and gating the door is how you
 * lock yourself out of the building. A route under `/api/ops` therefore has to authenticate
 * itself and has exactly one lock. Under `/api/emulator` it gets the edge gate first and the
 * in-route cookie check below second, which is the arrangement every other destructive
 * control in the product already has. The name is also the truer one: this drives the
 * emulator, and it belongs beside `tick` and `seed` rather than beside `login`.
 *
 * WHICH APPROACH, AND WHY IT IS NOT `scripts/drive.ts`
 * ---------------------------------------------------
 * `scripts/drive.ts` cannot be imported into a request handler, and the reasons are
 * structural rather than stylistic:
 *
 *   - It parses `process.argv` at module scope and ends with a top-level `await main()`,
 *     so merely importing it runs a command — under a web request there is no argv, so
 *     it would run `help`.
 *   - Its error path is `die()`, which calls `process.exit(1)`. In a serverless function
 *     that kills the instance mid-response, and takes any other in-flight invocation
 *     sharing that instance with it.
 *   - `main()` finishes by calling `db.closePool()`. The pool is a `globalThis`-pinned
 *     singleton (`lib/db.ts`), so one drive would tear down the connection pool every
 *     other route on that warm instance is using.
 *   - It drives the product over HTTP against `APP_BASE_URL`. On Vercel that means the
 *     function calling its own deployment for every step — doubling invocations, and
 *     every one of those calls now has to satisfy the ops gate it cannot hold a cookie
 *     for.
 *
 * Shelling out (`tsx scripts/drive.ts …`) is worse: the lambda has no `tsx`, no
 * devDependencies, and a read-only filesystem.
 *
 * So this endpoint is the second option the brief names: `seedWorld(scenario)`, then a
 * bounded loop of the same three calls `POST /api/emulator/tick` makes — `planAhead()`,
 * `runDueJobs()`, `drainWebhookEvents()` — accumulating each round's `RunReport`. That
 * is the honest subset: it exercises the seed, the planner and the whole job ladder,
 * which is what a drive is for here. It does NOT do the conversational half of
 * `scripts/drive.ts` (`say`, `tap`, `pay …`), because those are a person's acts and
 * belong to the console's panes, not to a one-shot button.
 *
 * The clock is deliberately not moved. `/api/emulator/clock` is the control for that and
 * it is destructive in its own right; a drive that silently jumped time would run — and
 * send — every reminder in the skipped span. Rounds still do work after the first
 * because handlers enqueue follow-on jobs that are already due, so the loop runs to its
 * fixed point instead of a fixed count.
 */

/**
 * The platform ceiling under Fluid Compute. The deadline arithmetic below reads this same
 * binding rather than a second copy of 300, so the number the loop protects and the number
 * Vercel enforces cannot drift apart.
 *
 * It has to be a bare numeric literal: Next extracts route segment config by static
 * analysis, and an identifier here — even a `const` in this file — is not something it can
 * evaluate. It would be dropped with a warning and the function would silently fall back to
 * the platform default, which is the one failure this constant exists to prevent.
 */
export const maxDuration = 300

const Body = z.object({
  scenario: z.enum(SCENARIO_IDS),
  /** Rounds of the ladder to walk. Bounded because each one can be minutes of model calls. */
  rounds: z.number().int().min(1).max(12).optional(),
  /** Jobs claimed per round. Deliberately far below the runner's own default of 200 — see below. */
  limit: z.number().int().min(1).max(500).optional(),
})

const DEFAULT_ROUNDS = 6

/**
 * How many jobs one round may claim. The same 25 `app/api/cron/tick` settled on, for the
 * same reason and against the same 300 s ceiling — two routes reasoning from identical
 * arithmetic to different numbers is how one of them ends up wrong.
 *
 * `runDueJobs` defaults to 200. `claim()` stamps `attempts = attempts + 1` on the WHOLE
 * batch up front (lib/jobs/runner.ts), so a run killed at the ceiling burns an attempt on
 * every row it claimed and not merely on the one that was executing, and three such kills
 * put `MAX_ATTEMPTS` (3) past a perfectly healthy job — permanently `failed`. The claimed
 * rows are also left `status = 'running'` holding a lock nobody is listening to for
 * `LOCK_STALE_MINUTES` (15) before anything reclaims them. A small batch bounds both blast
 * radii directly, and the next round picks up whatever it left.
 */
const DEFAULT_LIMIT = 25

/**
 * What one round can cost in the worst case, used to decide whether the NEXT one may start.
 *
 * A single `agent_task` waits on DeepSeek with `REQUEST_TIMEOUT_MS = 120_000` and retries
 * once about 1.5 s later (lib/agent/deepseek.ts), so one job alone can burn ~242 s. No
 * constant can make a round provably fit inside 300 s, and pretending otherwise is what the
 * previous version of this file did — it checked a flat 240 s budget between rounds and so
 * happily started a round at t = 239 s with a fifty-job claim behind it.
 *
 * 180 s is therefore not a promise that a round fits; it is the point past which starting
 * another one is knowingly reckless. It leaves the common case (rounds of a few seconds)
 * free to run to its fixed point, and it means a round is only ever begun when most of the
 * ceiling is still ahead of it.
 */
const WORST_ROUND_MS = 180_000

/** Reserved for the closing clock reads and encoding the response, which must not be cut off. */
const TAIL_MS = 5_000

type Round = {
  round: number
  planned: number
  jobs: RunReport
  webhook: { processed: number; failed: number; log: string[] }
  ms: number
}

function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/**
 * The second lock. `middleware.ts` has already turned away anyone without a valid cookie
 * before this handler runs; checking again here means the route is still shut if the
 * matcher is ever narrowed, and costs one JWT verification against a request that is about
 * to spend minutes in the model.
 */
async function authed(req: Request): Promise<boolean> {
  try {
    return await verifyOpsToken(cookieValue(req, OPS_COOKIE))
  } catch {
    return false
  }
}

export async function POST(req: Request): Promise<Response> {
  /**
   * The sandbox check runs before the cookie check, and the order is the point.
   *
   * Against production there is no caller, authenticated or not, who may run this, so the
   * answer does not depend on who is asking and nothing about the request needs to be read
   * to give it. It costs a 403 that tells an already-authenticated caller this deployment
   * is not a sandbox, and it buys an unconditional refusal that no auth bug can route
   * around.
   */
  const refusal = requireSandbox()
  if (refusal) return refusal
  /**
   * Belt and braces, and not redundant: `lib/ops-guard.ts` is a shared module this route
   * does not own, and the cost of it ever reading the flag loosely — truthiness, or
   * `!== '0'` — is the customer's whole database. One literal comparison here means the
   * wipe needs two independent mistakes rather than one.
   */
  if (process.env.OPS_SANDBOX !== '1') {
    return Response.json({ ok: false, error: 'sandbox_only' }, { status: 403 })
  }

  if (!(await authed(req))) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }

  const { scenario } = parsed.data
  const rounds = parsed.data.rounds ?? DEFAULT_ROUNDS
  const limit = parsed.data.limit ?? DEFAULT_LIMIT
  const startedAt = Date.now()
  const ceilingMs = maxDuration * 1000
  const remaining = (): number => ceilingMs - (Date.now() - startedAt)

  try {
    const seed = await seedWorld(scenario)

    const walked: Round[] = []
    const built = seed.academies.length
    const log: string[] = [
      `seeded ${scenario} — ${built} ${built === 1 ? 'academy' : 'academies'} at ${seed.nowIso}`,
    ]
    let stopped: 'settled' | 'rounds' | 'deadline' = 'rounds'

    for (let i = 1; i <= rounds; i++) {
      /**
       * Measured against what is actually left of the ceiling, not against a flat budget.
       * A round is started only when the time remaining could absorb a bad one, so the
       * function ends by returning rather than by being killed — and being killed is not a
       * cosmetic difference here: it burns an attempt on every row the round had claimed
       * and leaves them locked for fifteen minutes, which is the exact damage the small
       * `DEFAULT_LIMIT` above exists to avoid.
       */
      const left = remaining()
      if (left < WORST_ROUND_MS + TAIL_MS) {
        stopped = 'deadline'
        log.push(
          `stopped before round ${i}: ${Math.round((Date.now() - startedAt) / 1000)}s spent of ` +
            `${maxDuration}s, ${Math.round(left / 1000)}s left and a round can need ` +
            `${WORST_ROUND_MS / 1000}s — the rest is due and the next tick will take it`,
        )
        break
      }

      const at = Date.now()
      const planned = await planAhead()
      const jobs = await runDueJobs({ limit })
      // The transport ingress queue drains on the same beat, exactly as `tick` does. It is
      // the only consumer of the `webhook_event` rows the real Meta webhook writes, so
      // leaving it out would strand real inbound messages even in a sandbox.
      const webhook = await drainWebhookEvents()
      const round: Round = { round: i, planned, jobs, webhook, ms: Date.now() - at }
      walked.push(round)

      log.push(
        `round ${i} — planned ${planned}, ran ${jobs.ran}, skipped ${jobs.skipped}, failed ${jobs.failed}, ` +
          `webhook ${webhook.processed}/${webhook.failed} · ${round.ms}ms`,
      )
      for (const line of jobs.log) log.push(`  ${line}`)
      for (const line of webhook.log) log.push(`  ${line}`)

      /**
       * The fixed point, not the round cap, is the real end of a drive: the clock has not
       * moved, so once a round plans nothing, runs nothing and ingests nothing, no later
       * round can either. Stopping here is what keeps a two-round world from paying for
       * six rounds of empty queries.
       */
      if (planned === 0 && jobs.ran === 0 && jobs.failed === 0 && webhook.processed === 0) {
        stopped = 'settled'
        log.push(`settled after ${i} ${i === 1 ? 'round' : 'rounds'} — nothing left due`)
        break
      }
    }

    const totals = walked.reduce(
      (acc, r) => ({
        planned: acc.planned + r.planned,
        ran: acc.ran + r.jobs.ran,
        skipped: acc.skipped + r.jobs.skipped,
        failed: acc.failed + r.jobs.failed,
        webhook: acc.webhook + r.webhook.processed,
      }),
      { planned: 0, ran: 0, skipped: 0, failed: 0, webhook: 0 },
    )

    const at = await now()
    const next = await nextEventAt()
    const nextIso = next ? next.toISOString() : null
    const nowIso = at.toISOString()
    const offsetMs = await clockOffsetMs()

    return Response.json({
      ok: true,
      scenario,
      seed,
      rounds: walked,
      totals,
      stopped,
      ms: Date.now() - startedAt,
      // The real numbers the deadline decision was made on, so a `stopped: 'deadline'` can
      // be read as arithmetic rather than taken on trust.
      budget: { ceilingMs, worstRoundMs: WORST_ROUND_MS, tailMs: TAIL_MS, remainingMs: remaining(), limit },
      // Flat and untruncated, so the console can show the inside of the run rather than
      // just its outcome.
      log,
      clock: { nowIso, now: nowIso, offsetMs, nextEventAt: nextIso, nextEventAtIso: nextIso },
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // The elapsed time goes back with the error because the failure that matters most here
    // is the one that is really a timeout, and a bare message cannot be told apart from it.
    return Response.json({ ok: false, error: message, ms: Date.now() - startedAt }, { status: 500 })
  }
}

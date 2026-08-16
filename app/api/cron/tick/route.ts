import { timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import { now } from '@/lib/clock'
import { errorMessage } from '@/lib/errors'
import { planAhead } from '@/lib/jobs/plan-ahead'
import { runDueJobs, type RunReport } from '@/lib/jobs/runner'
import { recordTick } from '@/lib/jobs/tick-log'
import { drainWebhookEvents } from '@/lib/seed'

/**
 * app/api/cron/tick — the production beat (§13).
 *
 * The emulator's tick (`/api/emulator/tick`) is the same three calls behind the
 * ops cookie, which is exactly why this is a second route rather than a shared
 * one: pg_cron cannot hold a cookie or complete a login, and the ops console's
 * secret should not have to be handed to the database to get a scheduler.
 *
 * AUTH is `Authorization: Bearer <CRON_SECRET>`, and that spelling is not a
 * preference — Vercel Cron sends exactly this header, automatically, on every
 * scheduled invocation whenever a `CRON_SECRET` environment variable exists on
 * the project. Choosing the scheme Vercel already speaks means the same endpoint
 * is reachable from Vercel Cron (GET) and from Supabase pg_net (POST, headers
 * set by hand) with no second code path and no secret in a query string, where
 * it would end up in access logs.
 *
 * The secret is read straight from `process.env`, never `lib/env.ts`, following
 * app/api/webhook/route.ts: CONTRACTS §0 fixes that object's keys, and this one
 * belongs to the deployment rather than to the build. Absent secret fails
 * CLOSED — an unauthenticated scheduler is worse than no scheduler, because
 * `runDueJobs` sends real WhatsApp messages to real parents.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The agent loop is inside this request, on BOTH halves of the beat. `runDueJobs`
 * claims a batch and runs the handlers itself, and the ingest drain is no cheaper
 * — `processChangeValue` → `ingestInbound` ends in `runTurn`, so every inbound
 * message it swallows is a full model turn run inline. A handler that talks to
 * the model waits on DeepSeek with a 120 s per-request timeout
 * (lib/agent/deepseek.ts) before it retries, so two unlucky units of either kind
 * already outlast any default.
 *
 * 300 s is the platform ceiling, not a target, and it is `WEBHOOK_LIMIT` and
 * `TICK_LIMIT` TOGETHER that keep a tick inside it — neither bounds the other's
 * half, and either one left at its library default overruns the ceiling on its
 * own.
 */
export const maxDuration = 300

const cronSecret = (): string | undefined => process.env.CRON_SECRET

/** Same length-checked constant-time compare the webhook route uses. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

type AuthFailure = { error: string; status: number }

function authFailure(req: Request): AuthFailure | null {
  const secret = cronSecret()
  // Fail closed. On Vercel there is no .env.local on disk, so a forgotten
  // dashboard variable presents as `undefined` and must not read as "open".
  if (!secret) return { error: 'cron_secret_not_configured', status: 401 }

  // The auth-scheme token is case-insensitive per RFC 7235; the credential is
  // not. Vercel sends `Bearer`, but nothing should hinge on that.
  const presented = /^bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim())?.[1]
  if (!presented || !safeEqual(presented, secret)) return { error: 'unauthorized', status: 401 }

  return null
}

/**
 * How many jobs one beat may claim.
 *
 * `runDueJobs` defaults to 200, which is right for a hand-driven emulator tick
 * and wrong here for a reason that costs real work: `claim()` stamps
 * `attempts = attempts + 1` on the WHOLE batch up front, so a run killed at the
 * 300 s ceiling burns an attempt on every row it claimed and not merely on the
 * one that was executing. Three such kills and `MAX_ATTEMPTS` (3) marks a
 * perfectly healthy job permanently `failed`. A small batch bounds that blast
 * radius directly.
 *
 * 25 a minute is 1,500 an hour — orders of magnitude more than an academy
 * generates — so the only thing this slows down is clearing a backlog after an
 * outage, which the next beat picks up sixty seconds later anyway. Override per
 * call with `?limit=` or `{"limit":n}` when draining one deliberately.
 */
const TICK_LIMIT = 25

/**
 * How many ingress rows one drain round may claim.
 *
 * `drainWebhookEvents` defaults to 25, and the same argument that lowered
 * `TICK_LIMIT` applies to it with more force, because it was never a cheap
 * ingest: each claimed row runs `processChangeValue` → `ingestInbound` →
 * `runTurn`, a multi-step model loop whose per-request timeout alone is 120 s.
 * Twenty-five of those cannot fit in 300 s. And its claim stamps
 * `attempts = attempts + 1` on the WHOLE batch up front, exactly as `claim()`
 * does, so a round killed at the ceiling burns an attempt on every row it took
 * and not merely on the one that was executing — three of those and the row is
 * `failed` at seed.ts's own `attempts >= 3`, which for ingress means a real
 * parent's message discarded.
 *
 * Five is sized so that even a pathological round — every message a slow turn —
 * lands inside the ceiling with the runner's half still to come.
 */
const WEBHOOK_LIMIT = 5

/**
 * A backlog is bigger than one round, so the drain loops. Two bounds stop it.
 *
 * The wall-clock budget is the real one: past it, no NEW round is started, and
 * whatever is left waits sixty seconds for the next beat rather than being
 * claimed by a request that is about to be killed holding it. 120 s of the 300 s
 * ceiling leaves the runner its own half plus room for the round in flight to
 * finish.
 *
 * `WEBHOOK_MAX_ROUNDS` mirrors the runner's own `MAX_ROUNDS` and is belt and
 * braces against a round that returns instantly forever.
 */
const WEBHOOK_BUDGET_MS = 120_000
const WEBHOOK_MAX_ROUNDS = 8

const Params = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() })

/**
 * Both verbs carry the same one parameter, so both are read the same way:
 * query string first (Vercel Cron can only send a URL), then a JSON body on
 * POST, which wins because a caller who bothered to send one meant it.
 */
async function requestedLimit(req: Request): Promise<z.SafeParseReturnType<unknown, { limit?: number }>> {
  const query = Object.fromEntries(new URL(req.url).searchParams)
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
  const merged = body && typeof body === 'object' ? { ...query, ...body } : query
  return Params.safeParse(merged)
}

type Drain = { processed: number; failed: number; log: string[] }

/**
 * Drain the ingress queue in small rounds until it is empty or the budget is out.
 *
 * One `drainWebhookEvents(5)` is not enough on its own: the reclaim inside
 * `claim()` is uncapped, so anything this leaves behind past the 15-minute lock
 * window is destroyed wholesale on a later beat (see the ORDER note in `tick`).
 * Looping is what makes the small round size safe rather than merely slow.
 *
 * A round that reported any failure ENDS the loop. Those rows stay `running`, so
 * the very next claim would pick the same ones up again and spend another of
 * their three attempts on the same broken thing seconds later; spacing the
 * retries a beat apart is the difference between three chances over three minutes
 * and three chances over three seconds.
 *
 * It accumulates into the caller's object rather than returning a fresh one, for
 * the same reason those counters are seeded before the `try`: if round three
 * throws, rounds one and two really happened and the tick_runs row should say so.
 */
async function drainIngress(total: Drain, deadline: number): Promise<void> {
  for (let round = 0; round < WEBHOOK_MAX_ROUNDS; round++) {
    if (Date.now() > deadline) {
      total.log.push('drain budget spent; the rest waits for the next beat')
      return
    }

    const r = await drainWebhookEvents(WEBHOOK_LIMIT)
    total.processed += r.processed
    total.failed += r.failed
    total.log.push(...r.log)

    if (r.failed > 0) return
    // A short round means the claim found nothing more to take.
    if (r.processed + r.failed < WEBHOOK_LIMIT) return
  }
}

/**
 * One handler behind both verbs. Vercel Cron issues GET; pg_net's `http_post`
 * issues POST. Nothing about the work differs, and a second copy of it is a
 * second thing to keep in step.
 */
async function tick(req: Request): Promise<Response> {
  const denied = authFailure(req)
  // Nothing is recorded for a rejected caller: `tick_runs` is a record of the
  // beat, and letting an unauthenticated request write to it would hand the
  // internet a row-insert endpoint.
  if (denied) return Response.json({ ok: false, error: denied.error }, { status: denied.status })

  const parsed = await requestedLimit(req)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }
  const limit = parsed.data.limit ?? TICK_LIMIT

  const startedAt = new Date()
  // Seeded so that a throw halfway through still records what had already
  // happened. A tick that planned 40 jobs and then died on the drain is a
  // materially different event from one that never got started.
  let planned = 0
  let jobs: RunReport = { ran: 0, skipped: 0, failed: 0, log: [] }
  // `const` because the drain fills this in place rather than replacing it.
  const webhook: Drain = { processed: 0, failed: 0, log: [] }

  const close = async (error: string | null): Promise<number> => {
    const finishedAt = new Date()
    const durationMs = finishedAt.getTime() - startedAt.getTime()
    await recordTick({
      startedAt,
      finishedAt,
      durationMs,
      ran: jobs.ran,
      skipped: jobs.skipped,
      failed: jobs.failed,
      planned,
      // The ingest drain's lines are kept with the runner's, tagged so the two
      // halves of the beat stay distinguishable in one array.
      log: [...jobs.log, ...webhook.log.map((l) => `webhook: ${l}`)],
      error,
    })
    return durationMs
  }

  try {
    planned = await planAhead()

    /**
     * KEEP THIS CALL, AND KEEP IT HERE — the order is load-bearing, not stylistic.
     *
     * Keep it, because it reads like emulator plumbing and is the opposite:
     * `drainWebhookEvents` is the only consumer of the `webhook_event` job rows
     * that the REAL Meta webhook writes (`queueWebhookEvent`, called from
     * app/api/webhook/route.ts and nowhere else). The emulator's own `/inbound`
     * route bypasses the queue entirely, so nothing here is simulated — this is
     * how a parent's actual WhatsApp message becomes an ingested message and how
     * Meta's delivery receipts land.
     *
     * Keep it BEFORE `runDueJobs`, because those rows are inserted already
     * `running` (seed.ts) and the first statement inside `runDueJobs` → `claim()`
     * is an UNFILTERED reclaim: every `running` row whose lock is older than
     * `LOCK_STALE_MINUTES` (15) is flipped to `pending`, with no `kind` predicate.
     * A `webhook_event` row that reaches `pending` is lost for good — the drain
     * only ever selects `status = 'running'`, so it can never see the row again,
     * while the `due` CTE claims it immediately (no `academy_id` in its payload,
     * so `app.now_for(null)` is the world clock and `run_at` is long past),
     * finds no `HANDLERS` entry for the kind, and fails it out of existence.
     * That is a real parent's message deleted, silently.
     *
     * Running the drain second would open that race INSIDE one invocation, and
     * the gap it needs is not hypothetical: DEPLOY.md's rollback step has the
     * operator `cron.unschedule` the beat while Meta keeps delivering. Draining
     * first also cuts up to a minute off reply latency, because ingest runs the
     * agent turn inline and anything it enqueues is claimable by the very next
     * line.
     *
     * Double-draining is harmless: `ingestInbound` is idempotent on
     * `inbound:<wa_message_id>` and `markStatus` is rank-guarded.
     */
    await drainIngress(webhook, startedAt.getTime() + WEBHOOK_BUDGET_MS)

    jobs = await runDueJobs({ limit })

    // Domain time, which is what every job's `run_at` was compared against.
    // `startedAt` above is wall time; in production the offset is zero and the
    // two agree, and in a driven world the difference is the point.
    const at = await now()
    const durationMs = await close(null)

    return Response.json({
      ok: true,
      nowIso: at.toISOString(),
      planned,
      jobs,
      webhook,
      durationMs,
    })
  } catch (e) {
    const error = errorMessage(e)
    const durationMs = await close(error)
    // 500 rather than a quiet 200: pg_net discards the response, but Vercel Cron
    // surfaces a failing invocation in the dashboard, and that is the only place
    // a missing beat is visible without querying `tick_runs`.
    return Response.json({ ok: false, error, planned, jobs, webhook, durationMs }, { status: 500 })
  }
}

export async function GET(req: Request): Promise<Response> {
  return tick(req)
}

export async function POST(req: Request): Promise<Response> {
  return tick(req)
}

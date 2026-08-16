import { z } from 'zod'

import { advance, setTo, reset, nextEventAt, now } from '@/lib/clock'
import { planAhead } from '@/lib/jobs/plan-ahead'
import { runDueJobs } from '@/lib/jobs/runner'
import { requireSandbox } from '@/lib/ops-guard'
import { clockOffsetMs } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z
  .object({
    advanceMs: z.number().int().optional(),
    setToIso: z.string().datetime({ offset: true }).optional(),
    reset: z.literal(true).optional(),
    toNextEvent: z.literal(true).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    /**
     * Whose clock. Omitted means the world clock, which is every caller that
     * existed before 0024 and stays the default. Named means that tenant alone
     * moves — which is what makes two agents able to drive at once without
     * moving each other's world.
     */
    academyId: z.string().uuid().optional(),
  })
  .refine(
    (b) =>
      [b.advanceMs !== undefined, b.setToIso !== undefined, b.reset === true, b.toNextEvent === true]
        .filter(Boolean).length === 1,
    { message: 'exactly one of advanceMs, setToIso, reset or toNextEvent is required' },
  )

/**
 * Move the one shared clock, then plan the day and run everything now due.
 * This is what makes §17's "advance the clock and watch the ladder fire" work:
 * the scheduler is a drivable abstraction, not a cron detail.
 *
 * Sandbox only. Omitting `academyId` moves the world row, and a real academy has no
 * `sim_clock` row of its own, so it inherits that offset (0024) — the shared clock is
 * every live tenant's clock. Worse than the time being wrong is what happens next: this
 * handler runs `planAhead` and `runDueJobs` immediately after the move, so a jump to
 * Tuesday fires Tuesday's reminders at real parents on Saturday. "Watch the ladder fire"
 * is only a demonstration when nobody is on the other end of it.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = requireSandbox()
  if (denied) return denied

  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }
  const body = parsed.data
  const scope = body.academyId ?? ''

  try {
    let moved: Date
    let jumpedTo: string | null = null

    if (body.reset) {
      moved = await reset(scope)
    } else if (body.advanceMs !== undefined) {
      moved = await advance(body.advanceMs, scope)
    } else if (body.setToIso !== undefined) {
      moved = await setTo(new Date(body.setToIso), scope)
    } else {
      // Plan first, so "next event" accounts for the jobs today would enqueue.
      await planAhead()
      const next = await nextEventAt(scope)
      if (!next) {
        const unchanged = await now(scope)
        const offsetMs = await clockOffsetMs()
        return Response.json({
          ok: true,
          nowIso: unchanged.toISOString(),
          clock: {
            nowIso: unchanged.toISOString(),
            now: unchanged.toISOString(),
            offsetMs,
            nextEventAt: null,
            nextEventAtIso: null,
          },
          jumpedTo: null,
          planned: 0,
          jobs: { ran: 0, skipped: 0, failed: 0, log: [] },
          nextEventAtIso: null,
          note: 'nothing scheduled — the clock did not move',
        })
      }
      jumpedTo = next.toISOString()
      moved = await setTo(next, scope)
    }

    const planned = await planAhead()
    const jobs = await runDueJobs(body.limit ? { limit: body.limit } : undefined)
    const next = await nextEventAt(scope)
    const nextIso = next ? next.toISOString() : null
    const nowIso = moved.toISOString()
    const offsetMs = await clockOffsetMs()

    return Response.json({
      ok: true,
      nowIso,
      clock: { nowIso, now: nowIso, offsetMs, nextEventAt: nextIso, nextEventAtIso: nextIso },
      jumpedTo,
      planned,
      jobs,
      nextEventAtIso: nextIso,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

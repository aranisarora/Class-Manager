import { z } from 'zod'

import { advance, setTo, reset, nextEventAt, now } from '@/lib/clock'
import { planAhead } from '@/lib/jobs/plan-ahead'
import { runDueJobs } from '@/lib/jobs/runner'
import { requireSandboxAcademy } from '@/lib/ops-guard'
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
     * Whose clock. Named means that tenant alone moves — which is what makes two
     * agents able to drive at once without moving each other's world.
     *
     * Still optional, because omitting it is still the world clock and a scratch
     * box is still allowed to move the world. It is optional at the *schema* and
     * refused at the *guard*: a hosted deployment turns the omission into a 403
     * rather than into every tenant, which is the one reading of "no academy
     * given" that cannot be a mistake worth making twice.
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
 * Sandbox academy only, and the danger this guards is now specifically the UNSCOPED call.
 * 0024 gave every tenant a clock of its own, so moving one is provably local: the runner
 * claims against `app.now_for((payload->>'academy_id')::uuid)`, which means a tenant whose
 * clock never moved has nothing newly due and hears nothing. What is not local is omitting
 * `academyId` — that moves the world row, and a real academy with no `sim_clock` row of its
 * own inherits that offset, so the shared clock becomes every live tenant's clock. Worse
 * than the time being wrong is what happens next: this handler plans and runs immediately
 * after the move, so a jump to Tuesday fires Tuesday's reminders at real parents on
 * Saturday. "Watch the ladder fire" is only a demonstration when nobody is on the other end
 * of it, so on a hosted deployment the omission is refused rather than defaulted, and only
 * an academy carrying `is_sandbox` may be moved at all.
 *
 * One consequence is deliberate rather than overlooked. `planAhead` and `runDueJobs` below
 * are world-wide and stay that way: planning is per-tenant against each tenant's own
 * `app.now_for` and idempotent, so it writes another tenant nothing the next cron beat
 * would not have written anyway, and the runner only claims work already due on the owning
 * tenant's clock. No time travel leaks across. What does happen is that the sandbox
 * operator's click drains every tenant's due work a few seconds before the minute beat
 * would have — the same work, slightly early, which is the price of the sandbox sharing a
 * job table with production.
 */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }
  const body = parsed.data

  // The raw optional value, not `scope`: the guard's second rule is that an absent academy
  // is a refusal, and collapsing absence into `''` first would hand it the world row as
  // though somebody had asked for it. Parsing before guarding is safe — nothing below has
  // written anything yet, and the guard needs the body to know what it is being asked to move.
  const denied = await requireSandboxAcademy(body.academyId)
  if (denied) return denied

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

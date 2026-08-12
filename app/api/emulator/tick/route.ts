import { z } from 'zod'

import { now, nextEventAt } from '@/lib/clock'
import { planAhead } from '@/lib/jobs/plan-ahead'
import { runDueJobs } from '@/lib/jobs/runner'
import { drainWebhookEvents, clockOffsetMs } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({ limit: z.number().int().min(1).max(500).optional() })

/** Run everything due right now, without moving the clock. */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const planned = await planAhead()
    const jobs = await runDueJobs(parsed.data.limit ? { limit: parsed.data.limit } : undefined)
    // The transport ingress queue drains on the same beat (§1).
    const webhook = await drainWebhookEvents()
    const at = await now()
    const next = await nextEventAt()
    const nextIso = next ? next.toISOString() : null
    const nowIso = at.toISOString()
    const offsetMs = await clockOffsetMs()

    return Response.json({
      ok: true,
      nowIso,
      clock: { nowIso, now: nowIso, offsetMs, nextEventAt: nextIso, nextEventAtIso: nextIso },
      planned,
      jobs,
      webhook,
      nextEventAtIso: nextIso,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

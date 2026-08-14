import { z } from 'zod'

import { seedWorld, SCENARIO_IDS } from '@/lib/seed'
import { planAhead } from '@/lib/jobs/plan-ahead'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  scenario: z.enum(SCENARIO_IDS).optional(),
})

export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const result = await seedWorld(parsed.data.scenario ?? 'both')

    // Plan the day so the ladder has something to fire on the first clock
    // advance. A planner failure is reported, not swallowed, and does not
    // invalidate the seed.
    let planned: number | null = null
    let planError: string | null = null
    try {
      planned = await planAhead()
    } catch (e) {
      planError = e instanceof Error ? e.message : String(e)
    }

    return Response.json({ ok: true, ...result, planned, planError })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

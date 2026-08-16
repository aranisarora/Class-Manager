import { z } from 'zod'

import { seedWorld, SCENARIO_IDS } from '@/lib/seed'
import { planAhead } from '@/lib/jobs/plan-ahead'
import { requireSandbox } from '@/lib/ops-guard'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  scenario: z.enum(SCENARIO_IDS).optional(),
})

/**
 * Sandbox only, and this is the one that matters most. `seedWorld` opens with
 * `resetWorld`, which deletes every academy the world knows about rather than only the
 * two fixture ids, and then drops `job`, `sim_fault` and `sender` outright. Pointed at a
 * live database it is not a reseed, it is the end of the business — and of the Cloud
 * credentials the sender row carries. The refusal comes before the body is even read.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = requireSandbox()
  if (denied) return denied

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

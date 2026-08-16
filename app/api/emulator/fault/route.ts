import { z } from 'zod'

import { requireSandbox } from '@/lib/ops-guard'
import { setFault, listFaults } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  kind: z.enum(['send_fail', 'number_blocked', 'media_timeout', 'link_expired', 'model_error']),
  active: z.boolean(),
  rate: z.number().min(0).max(1).optional(),
})

/**
 * Failure injection (§17): sends fail, numbers block, links expire, media times out.
 *
 * Sandbox only. `sim_fault` has no academy column and its service policy is `using
 * (true)`, and the live send path reads it on every outbound with no tenant filter — so
 * there is no blast radius smaller than "everybody". An armed `send_fail` or
 * `number_blocked` silently stops real messages reaching real parents until somebody
 * remembers to disarm it, which is the kind of outage that looks like the product being
 * broken rather than the console being misused.
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
    const faults = await setFault(parsed.data)
    return Response.json({ ok: true, faults })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

/**
 * Reading what is armed is not injection, so this stays available in production on
 * purpose: if a fault ever were set, "is anything degrading sends right now?" is the
 * first question an operator needs answered and the last one to take away from them.
 */
export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, faults: await listFaults() })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

import { z } from 'zod'

import { requireSandbox } from '@/lib/ops-guard'
import { markMessageRead } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  messageId: z.string().uuid(),
  status: z.enum(['delivered', 'read']).optional(),
})

/**
 * Mark delivered/read — proves §2.4: queued != sent != delivered != read.
 *
 * Sandbox only. This is `/delivery` one row at a time, reached by clicking the tick marks
 * on a bubble, and it calls the very function the real transport callback calls — so
 * against production it forges a receipt that says a parent opened a message they may
 * never have seen. Mild next to a reseed, and still a fabrication: the blue ticks in the
 * pane are the operator's evidence of what reached somebody, and a console that lets them
 * be clicked into existence cannot be used as evidence of anything.
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
    const result = await markMessageRead(parsed.data.messageId, parsed.data.status ?? 'read')
    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason },
        { status: result.reason === 'not_found' ? 404 : 409 },
      )
    }
    return Response.json({ ...result, ok: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

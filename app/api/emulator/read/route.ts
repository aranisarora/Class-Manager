import { z } from 'zod'

import { markMessageRead } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  messageId: z.string().uuid(),
  status: z.enum(['delivered', 'read']).optional(),
})

/** Mark delivered/read — proves §2.4: queued != sent != delivered != read. */
export async function POST(req: Request): Promise<Response> {
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

import { z } from 'zod'

import { setFault, listFaults } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  kind: z.enum(['send_fail', 'number_blocked', 'media_timeout', 'link_expired', 'model_error']),
  active: z.boolean(),
  rate: z.number().min(0).max(1).optional(),
})

/** Failure injection (§17): sends fail, numbers block, links expire, media times out. */
export async function POST(req: Request): Promise<Response> {
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

export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, faults: await listFaults() })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

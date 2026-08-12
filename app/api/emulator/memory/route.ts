import { z } from 'zod'

import { memoryFor } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Query = z.object({ contactId: z.string().uuid() })

/** §5 — the hot set the prompt carries, and the append-only record behind it. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const parsed = Query.safeParse({ contactId: url.searchParams.get('contactId') })
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_query', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const memory = await memoryFor(parsed.data.contactId)
    if (!memory) return Response.json({ ok: false, error: 'contact_not_found' }, { status: 404 })
    return Response.json({ ok: true, ...memory })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

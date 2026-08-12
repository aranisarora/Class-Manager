import { z } from 'zod'

import { threadFor } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Query = z.object({ contactId: z.string().uuid() })

/** One pane's messages. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const parsed = Query.safeParse({ contactId: url.searchParams.get('contactId') })
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'invalid_query', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  try {
    const thread = await threadFor(parsed.data.contactId)
    if (!thread) return Response.json({ ok: false, error: 'contact_not_found' }, { status: 404 })
    return Response.json({ ok: true, ...thread })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

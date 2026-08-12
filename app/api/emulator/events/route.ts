import { z } from 'zod'

import { eventLog } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Query = z.object({
  since: z.string().datetime({ offset: true }).nullable().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
})

/** The event log: every send with template-vs-in-window, cost and sender number,
 *  plus every job and every turn. Oldest first. */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const parsed = Query.safeParse({
    since: url.searchParams.get('since'),
    limit: url.searchParams.get('limit') ?? undefined,
  })
  if (!parsed.success) {
    return Response.json(
      { ok: false, error: 'invalid_query', issues: parsed.error.issues },
      { status: 400 },
    )
  }

  try {
    const { events, cursor } = await eventLog({
      since: parsed.data.since ?? null,
      limit: parsed.data.limit,
    })
    return Response.json({ ok: true, events, cursor, count: events.length })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

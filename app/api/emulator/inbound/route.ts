import { z } from 'zod'

import { inboundFromContact } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z
  .object({
    contactId: z.string().uuid(),
    text: z.string().min(1).max(4096).optional(),
    actionId: z.string().uuid().optional(),
    mediaUrl: z.string().min(1).max(2048).optional(),
    mediaMimeType: z.string().min(1).max(255).optional(),
  })
  .refine((b) => Boolean(b.text || b.actionId || b.mediaUrl), {
    message: 'one of text, actionId or mediaUrl is required',
  })

/**
 * The webhook equivalent. Same road as a real inbound: resolve identity, write
 * the inbound `message` row (which is what stamps `last_inbound_at` and promotes
 * the contact's state, §11.2), then run the turn. A tap posts `actionId` and the
 * turn consumes it with no model call (§2.2).
 */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const result = await inboundFromContact(parsed.data)
    if ('notFound' in result) {
      return Response.json({ ok: false, error: 'contact_not_found' }, { status: 404 })
    }
    if (!result.ok) {
      // §10.1: an unknown number that matches more than one academy.
      return Response.json({ ok: false, unresolved: true, candidates: result.candidates }, { status: 409 })
    }
    return Response.json({ ...result, ok: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

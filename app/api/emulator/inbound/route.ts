import { z } from 'zod'

import { inboundFromContact } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z
  .object({
    contactId: z.string().uuid(),
    text: z.string().min(1).max(4096).optional(),
    actionId: z.string().uuid().optional(),
    /**
     * A URL *or* a `data:` URI carrying the bytes. The old 2048 ceiling was written for the
     * former and rejected the latter outright: a real attachment is a base64 data URI tens of
     * thousands of characters long, so every voice note and photo failed the body check
     * before it reached the media pipeline. ~24M characters ≈ an 18MB file, which covers
     * every size WhatsApp itself accepts.
     */
    mediaUrl: z.string().min(1).max(24_000_000).optional(),
    mediaMimeType: z.string().min(1).max(255).optional(),
    /**
     * A completed WhatsApp Flow, in the shape the wire actually delivers it: the
     * literal `nfm_reply.response_json`, which is a JSON **string** carrying
     * `flow_token` alongside the form's own fields.
     *
     * A string, not an object, on purpose. §17's rule is "something that works here
     * works there", and the difference between those two is exactly the kind of
     * detail an emulator quietly gets right and production then gets wrong — the
     * emulator would parse an object happily while the real webhook handed the same
     * code a string. Taking the harder shape here is what makes the local pass
     * evidence about production.
     */
    flowResponse: z
      .string()
      .min(2)
      .max(64_000)
      .refine(
        (s) => {
          try {
            const v = JSON.parse(s)
            return Boolean(v) && typeof v === 'object' && !Array.isArray(v)
          } catch {
            return false
          }
        },
        { message: 'flowResponse must be a JSON object encoded as a string, as the wire sends it' },
      )
      .optional(),
  })
  .refine((b) => Boolean(b.text || b.actionId || b.mediaUrl || b.flowResponse), {
    message: 'one of text, actionId, mediaUrl or flowResponse is required',
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

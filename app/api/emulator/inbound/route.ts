import { z } from 'zod'

import { resolveIdentity } from '@/lib/identity'
import { requireSandboxAcademy } from '@/lib/ops-guard'
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
     * Shared contact cards — `📎 attach › Contact` on the composer, and `type:
     * "contacts"` on the real wire.
     *
     * Shaped only as far as "an array of objects", because the judgement about what
     * is a usable card belongs to `readSharedContacts` and nowhere else. A zod schema
     * here would be a second author of that rule, and the two would disagree the
     * first time the Cloud API's nested `{name:{formatted_name}, phones:[{phone}]}`
     * met a validator written against the emulator's flat pair. The cap is a body
     * size, not a policy: `MAX_SHARED_CONTACTS` is what actually decides.
     */
    contacts: z.array(z.record(z.string(), z.unknown())).max(64).optional(),
  })
  .refine((b) => Boolean(b.text || b.actionId || b.mediaUrl || b.contacts?.length), {
    message: 'one of text, actionId, mediaUrl or contacts is required',
  })

/**
 * The webhook equivalent. Same road as a real inbound: resolve identity, write
 * the inbound `message` row (which is what stamps `last_inbound_at` and promotes
 * the contact's state, §11.2), then run the turn. A tap posts `actionId` and the
 * turn consumes it with no model call (§2.2).
 *
 * Sandbox academy only, and the reason is the sentence above: same road as a real inbound.
 * There is no "reply as the academy" control anywhere in this console, so the composer,
 * every reply-button tap and every media send all arrive here speaking *as the contact*.
 * Against a real tenant that puts words in a real parent's mouth in a transcript the
 * business will later read as evidence, reopens the paid 24-hour window on
 * `last_inbound_at`, promotes their state, and runs a turn that answers them over the live
 * number. The operator meant to look; the parent gets a message. Against a tenant the
 * operator created for themselves, all of that is the point.
 */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }

  /**
   * Whose contact this is, before a single row is written.
   *
   * `inboundFromContact` finds the tenant too, by probing each academy in the world — but
   * the id it finds only surfaces in its result, after `ingestInbound` has stored the
   * inbound message, stamped `last_inbound_at` and run the whole turn. A guard reading it
   * from there would be deciding whether the fabrication was allowed after committing it.
   *
   * `app.identity` (0005) is `security definer` and read-only, so this is one round trip
   * that needs no academy of its own, and it answers null for a contact that does not
   * exist — which the guard reads as "refuse" rather than as "no academy named, carry on".
   * On a scratch box the guard waves it through and `inboundFromContact` returns the same
   * 404 it always did.
   */
  const identity = await resolveIdentity(parsed.data.contactId)
  const denied = await requireSandboxAcademy(identity?.academyId)
  if (denied) return denied

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

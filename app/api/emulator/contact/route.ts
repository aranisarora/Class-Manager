import { z } from 'zod'

import { createTestContact, dropPerson } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  academyId: z.string().uuid(),
  name: z.string().min(1).max(120),
  role: z.enum(['client', 'coach', 'admin', 'prospect']),
  /** E.164, with or without the +. Omitted, a free number in the test range is picked. */
  phone: z.string().min(6).max(20).optional(),
})

/**
 * Add one throwaway person to the live world, wired to a real role, without reseeding.
 * The seeded world stays deterministic (§17); these are extra, and a reseed clears them.
 */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const contact = await createTestContact(parsed.data)
    return Response.json({ ok: true, contact })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    // A duplicate number or a missing academy is the caller's mistake, not a server fault.
    const status = /already belongs|no such academy|needs a name|range is full/i.test(message) ? 400 : 500
    return Response.json({ ok: false, error: message }, { status })
  }
}

/**
 * Remove one person from the live world — the other half of `+ new`.
 *
 * A tray you can only add to fills up with half-built test people who then turn
 * up in rosters, counts and reminders. The delete goes through the same
 * `lib/seed` function the driver calls, so there is no second idea of what
 * removing somebody means.
 */
export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const contactId = url.searchParams.get('contactId') ?? ''
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(contactId)) {
    return Response.json({ ok: false, error: 'contactId is required' }, { status: 400 })
  }
  try {
    const gone = await dropPerson(contactId)
    if (!gone) return Response.json({ ok: false, error: 'contact_not_found' }, { status: 404 })
    return Response.json({ ok: true, removed: gone })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

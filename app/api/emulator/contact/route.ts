import { z } from 'zod'

import { createTestContact } from '@/lib/seed'

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

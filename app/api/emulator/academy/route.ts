import { z } from 'zod'

import { createAcademy, dropAcademy, worldAcademyIds } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Making and unmaking a business — the operator's job, and only the operator's.
 *
 * **Signup is deliberately not a product flow.** The owner of Class Manager
 * creates a tenant; a stranger messaging the shared number cannot, and
 * `resolveInbound` returning `unresolved` for a number that matches no academy
 * is that decision working rather than a gap to close. §10.1 routes a stranger
 * to an academy that already exists, and stops there on purpose: a tenant a
 * stranger can conjure is a tenant anybody can conjure, on a number every other
 * business shares.
 *
 * So this route exists for the emulator and the driver, which are the operator.
 * It calls the same `lib/seed` functions the driver does — one idea of what
 * creating and deleting a business means, not two.
 */

const Create = z.object({
  name: z.string().min(1).max(120),
  adminName: z.string().min(1).max(120),
  /** E.164, with or without the +. Omitted, a free number in the test range is picked. */
  adminPhone: z.string().min(6).max(20).optional(),
  timezone: z.string().min(1).max(64).optional(),
  category: z.string().min(1).max(80).optional(),
})

export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Create.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }
  try {
    const created = await createAcademy(parsed.data)
    return Response.json({ ok: true, academy: created })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

/** Every business currently in the world, for a picker that needs to name them. */
export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, academyIds: await worldAcademyIds({ refresh: true }) })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

/**
 * Delete one business and everything in it. `academy_id … on delete cascade` is
 * on every tenant table, so this is one statement and RI does the rest.
 */
export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const which = url.searchParams.get('academy') ?? url.searchParams.get('academyId') ?? ''
  if (!which) return Response.json({ ok: false, error: 'academy id or name is required' }, { status: 400 })
  try {
    const gone = await dropAcademy(which)
    if (!gone) return Response.json({ ok: false, error: 'academy_not_found' }, { status: 404 })
    return Response.json({ ok: true, dropped: gone })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

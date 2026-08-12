import { worldState } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** academies, contacts, clock, faults — everything the emulator shell renders. */
export async function GET(): Promise<Response> {
  try {
    const state = await worldState()
    return Response.json({ ok: true, ...state })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

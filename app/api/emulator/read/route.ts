import { z } from 'zod'

import { withSession, type Tx } from '@/lib/db'
import { resolveIdentity } from '@/lib/identity'
import { requireSandboxAcademy } from '@/lib/ops-guard'
import { markMessageRead, worldAcademyIds } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  messageId: z.string().uuid(),
  status: z.enum(['delivered', 'read']).optional(),
  /**
   * The thread the tick mark was clicked in, purely so the tenant can be found cheaply.
   *
   * A message id names no tenant — `lib/messaging/send.ts` says so in as many words, and
   * every `message` policy is pinned to `app.academy_id()`, so there is deliberately no
   * cross-tenant read to resolve one with. A contact id does have a door (`app.identity`,
   * 0005), and the pane these ticks live in already knows which contact it is showing, so
   * sending it turns a walk over every academy in the world into one lookup. Optional
   * because it is an optimisation, not a permission: the walk below still finds the owner
   * without it.
   */
  contactId: z.string().uuid().optional(),
})

/**
 * Which tenant owns this message.
 *
 * Two candidate sources, one test. With a `contactId` the candidate list is the single
 * academy `app.identity` resolves it to; without one it is every academy in the world, the
 * same probe `markMessageRead` runs internally — repeated here because that function only
 * reports the tenant in its result, long after it has written the receipt. Either way the
 * message itself is what decides: a session pinned to the candidate can only see the row if
 * the row is genuinely theirs (0003's `message` policies), so a `contactId` from one tenant
 * and a `messageId` from another resolves to nothing and the guard refuses.
 *
 * `{ refresh: true }` on the world list because the memo is process-local and one second
 * old while the table is not: on Vercel the instance that created the sandbox tenant is not
 * this one, and a stale list would fail closed on an academy that is legitimately a sandbox.
 */
async function academyOfMessage(messageId: string, contactId?: string): Promise<string | null> {
  const candidates = contactId
    ? [(await resolveIdentity(contactId))?.academyId].filter((id): id is string => Boolean(id))
    : await worldAcademyIds({ refresh: true })

  for (const academyId of candidates) {
    const owns = await withSession({ role: 'service', academyId }, async (tx: Tx) => {
      const rows = await tx<{ id: string }[]>`select id from message where id = ${messageId}::uuid`
      return rows.length > 0
    })
    if (owns) return academyId
  }
  return null
}

/**
 * Mark delivered/read — proves §2.4: queued != sent != delivered != read.
 *
 * Sandbox academy only. This is `/delivery` one row at a time, reached by clicking the tick
 * marks on a bubble, and it calls the very function the real transport callback calls — so
 * against a real tenant it forges a receipt that says a parent opened a message they may
 * never have seen. Mild next to a reseed, and still a fabrication: the blue ticks in the
 * pane are the operator's evidence of what reached somebody, and a console that lets them
 * be clicked into existence cannot be used as evidence of anything. Inside a sandbox tenant
 * there is no evidence to spoil, which is the whole difference.
 */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }

  // Before `markMessageRead`, because it writes as soon as it finds the row. A message
  // nothing owns resolves to null, which a hosted deployment refuses and a scratch box waves
  // through to the same `not_found` it always answered. The walk is paid twice there — this
  // one and `markMessageRead`'s — which is two fixture tenants and one row, and disappears
  // entirely once the caller sends the thread's `contactId`.
  const owner = await academyOfMessage(parsed.data.messageId, parsed.data.contactId)
  const denied = await requireSandboxAcademy(owner)
  if (denied) return denied

  try {
    const result = await markMessageRead(parsed.data.messageId, parsed.data.status ?? 'read')
    if (!result.ok) {
      return Response.json(
        { ok: false, error: result.reason },
        { status: result.reason === 'not_found' ? 404 : 409 },
      )
    }
    return Response.json({ ...result, ok: true })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

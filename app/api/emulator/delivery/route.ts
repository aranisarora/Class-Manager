import { z } from 'zod'

import { withSession, type SessionCtx } from '@/lib/db'
import { requireSandbox } from '@/lib/ops-guard'
import { worldAcademyIds } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const Body = z.object({
  /** `delivered` is the network's act. `read` additionally opens the chat, which is a person's. */
  mode: z.enum(['delivered', 'read']),
  limit: z.number().int().min(1).max(1000).optional(),
})

/**
 * Advance the delivery ladder for everything the transport has accepted (§2.4).
 *
 * `POST /api/emulator/read` moves one message the driver points at, and nothing moved one on
 * its own — the emulator transport returns a wire id and stops, so a full run of jobs left
 * every message in the world sitting at `sent` forever. That is not a cosmetic gap: §16.3
 * asks for per-tenant quality proxies (delivery failures, read rate) and every one of them
 * had no input that had not been typed by hand.
 *
 * **One rung per call, per message.** `sent → delivered` and, in `read` mode,
 * `delivered → read` — never both for the same row in one beat, so `delivered` is a state a
 * driver actually sees rather than a value that flashes past on the way to blue ticks.
 *
 * Timestamps come from `app.now()`, so a delivery that lands after the clock jumps to Tuesday
 * is stamped Tuesday. `wa_message_id is not null` is the honest gate: a message the transport
 * never accepted cannot be delivered, and claiming otherwise is exactly the §2.4 lie the
 * status ladder exists to prevent.
 *
 * Sandbox only, by that same rule read one step further out. The emulator transport never
 * reports back, so hand-advancing the ladder is the only honest way to exercise it here.
 * Under `TRANSPORT=cloud` a real one does report back, and then this route is the lie:
 * it stamps `delivered_at` and `read_at` for messages no handset acknowledged, across
 * every academy at once with no way for the caller to scope it, and feeds the result to
 * the §16.3 quality proxies this very comment says it exists to supply. Metrics nobody
 * can trust are worse than metrics nobody has.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = requireSandbox()
  if (denied) return denied

  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }
  const { mode } = parsed.data
  const limit = parsed.data.limit ?? 200

  try {
    let delivered = 0
    let read = 0
    for (const academyId of await worldAcademyIds()) {
      const ctx: SessionCtx = { role: 'service', academyId }
      const moved = await withSession(ctx, async (tx) => {
        // `read` first: a row that reached `delivered` on the previous beat moves up now,
        // and one that only just reached `sent` below waits for the next one.
        const readRows =
          mode === 'read'
            ? await tx<{ id: string }[]>`
                update message
                   set status = 'read', read_at = case when read_at is null then app.now() else read_at end
                 where academy_id = ${academyId}::uuid
                   and direction = 'outbound' and status = 'delivered'
                   and wa_message_id is not null and suppressed_reason is null
                   and id in (
                     select id from message
                      where academy_id = ${academyId}::uuid
                        and direction = 'outbound' and status = 'delivered'
                        and wa_message_id is not null and suppressed_reason is null
                      order by delivered_at
                      limit ${limit})
                returning id`
            : []
        const deliveredRows = await tx<{ id: string }[]>`
          update message
             set status = 'delivered',
                 delivered_at = case when delivered_at is null then app.now() else delivered_at end
           where academy_id = ${academyId}::uuid
             and direction = 'outbound' and status = 'sent'
             and wa_message_id is not null and suppressed_reason is null
             and id in (
               select id from message
                where academy_id = ${academyId}::uuid
                  and direction = 'outbound' and status = 'sent'
                  and wa_message_id is not null and suppressed_reason is null
                order by sent_at
                limit ${limit})
          returning id`
        return { read: readRows.length, delivered: deliveredRows.length }
      })
      delivered += moved.delivered
      read += moved.read
    }

    return Response.json({ ok: true, mode, delivered, read, advanced: delivered + read })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

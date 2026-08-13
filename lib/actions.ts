/**
 * lib/actions.ts — mint once, replay verbatim (§2.2, §6.5).
 *
 * "A button's action is authored at compose time, validated, stored. The tap replays the
 * stored payload. **No model inference at tap time**, where a misread commits someone to
 * being somewhere."
 *
 * So `consumeAction` makes no model call, re-resolves nothing, and parses no strings. It
 * loads a row, checks three things the database also checks, and claims it. The freedom is
 * in what can be minted — `operation` and `steps` make the button surface exactly as wide as
 * the write surface (§6.5) — and the safety is that minting and tapping are different
 * moments.
 *
 * The claim is a single conditional UPDATE. That one statement is what makes §12.3's
 * `CO-COVER-OFFER` race correct: two coaches tap `[Claim this session]` in the same second,
 * both rows are `consumed_at is null` when they start, and exactly one UPDATE returns a row.
 * Read-then-write would let both win and put two coaches at one court.
 */

import { withSession } from '@/lib/db'
import type { SessionCtx } from '@/lib/db'
import { msgError } from '@/lib/messaging/types'
import type { OperationName } from '@/lib/agent/operations'
import type { PlanStep } from '@/lib/agent/plan'
import { checkActionPayload } from '@/lib/agent/steps'

export type ActionPayload =
  | { kind: 'operation'; op: OperationName; args: Record<string, unknown> }
  | { kind: 'steps'; steps: PlanStep[]; summary: string }
  | { kind: 'reply'; text: string } // replays as if the user typed it — goes back through the agent
  | { kind: 'view'; viewSpecId: string }
  | { kind: 'view'; screen: 'setup' | 'register'; ref?: string }
  | { kind: 'menu'; menu: 'root' | string }
  | { kind: 'noop'; ack: string }
  | { kind: 'handoff'; reason: string; summary: string }

export const DEFAULT_ACTION_TTL_MINUTES = 1440

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * §6.5: "fully resolved. no ids to look up." Checked at mint AND at tap, by the
 * one schema in `lib/agent/steps.ts` that also decides what a plan is — so a
 * button carrying steps is held to exactly the standard `plan` is held to. A
 * payload that only *looks* right is the worst kind here: it survives minting,
 * survives storage, is shown to a person, and dies on the tap, which is the one
 * moment with no model in the loop to recover.
 */
function parsePayload(raw: unknown): ActionPayload | null {
  const checked = checkActionPayload(raw)
  return checked.ok ? (checked.payload as ActionPayload) : null
}

/** Why a payload was refused, for a caller that can do something about it. */
export function actionPayloadError(raw: unknown): string | null {
  const checked = checkActionPayload(raw)
  return checked.ok ? null : checked.error
}

/**
 * Author a button's action now, while the model has the context to get it right. Minting is
 * a compose-time act by the runtime — there is no INSERT policy on `action` for a user
 * session, so this runs as the service role within the caller's tenant.
 */
export async function mintAction(
  ctx: SessionCtx,
  a: {
    payload: ActionPayload
    forContactId: string
    ttlMinutes?: number // default 1440
  },
): Promise<string> {
  const payload = parsePayload(a.payload)
  if (!payload) {
    throw msgError(
      'invalid_action_payload',
      `an action payload must be fully resolved at mint time (§6.5) — ${actionPayloadError(a.payload)}: ` +
        `${JSON.stringify(a.payload)?.slice(0, 300)}`,
    )
  }
  if (!a.forContactId) {
    throw msgError('invalid_action_target', 'an action is minted for exactly one contact (§2.2)')
  }

  const ttl = Number.isFinite(a.ttlMinutes) ? Number(a.ttlMinutes) : DEFAULT_ACTION_TTL_MINUTES

  return withSession({ role: 'service', academyId: ctx.academyId }, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into action (academy_id, kind, payload, minted_at, minted_for_contact_id, expires_at)
      values (
        ${ctx.academyId},
        ${payload.kind},
        ${JSON.stringify(payload)}::text::jsonb,
        app.now(),
        ${a.forContactId},
        app.now() + (${ttl}::int * interval '1 minute')
      )
      returning id`
    return rows[0].id
  })
}

export type ConsumeResult =
  | { ok: true; payload: ActionPayload }
  | { ok: false; reason: 'expired' | 'already_used' | 'wrong_contact' | 'missing' }

/**
 * Loads, validates expiry + consumption + `minted_for_contact_id`, stamps `consumed_at`.
 * NO MODEL CALL, no re-resolution, no string parsing (§6.5).
 *
 * The three checks live in the WHERE clause of the claiming UPDATE, so they are evaluated
 * against the row as it is locked rather than as it was read. The diagnostic SELECT that
 * follows a miss exists only to say *why* — it never decides anything.
 */
export async function consumeAction(
  ctx: SessionCtx,
  actionId: string,
  byContactId: string,
): Promise<ConsumeResult> {
  if (!actionId || !UUID_RE.test(actionId)) return { ok: false, reason: 'missing' }
  if (!byContactId || !UUID_RE.test(byContactId)) return { ok: false, reason: 'wrong_contact' }
  // A user session tapping on behalf of a different number is the exact thing §2.2 guards.
  if (ctx.role !== 'service' && ctx.contactId !== byContactId) {
    return { ok: false, reason: 'wrong_contact' }
  }

  // The claim runs under the tapper's own session where there is one, so `action`'s RLS
  // policy — `minted_for_contact_id = app.contact_id()` — is the enforcer and the WHERE
  // clause below is the belt to it. Jobs and sims have no contact GUC and claim as service.
  const claimCtx: SessionCtx =
    ctx.role === 'user' ? ctx : { role: 'service', academyId: ctx.academyId }

  const claimed = await withSession(claimCtx, async (tx) => {
    const rows = await tx<{ payload: unknown }[]>`
      update action
         set consumed_at = app.now(),
             consumed_by_contact_id = ${byContactId}
       where id = ${actionId}
         and academy_id = ${ctx.academyId}
         and minted_for_contact_id = ${byContactId}
         and consumed_at is null
         and (expires_at is null or expires_at > app.now())
      returning payload`
    return rows.length ? rows[0].payload : null
  })

  if (claimed !== null) {
    const payload = parsePayload(claimed)
    if (payload) return { ok: true, payload }
    // Claimed but unreadable: the row is spent either way, which stops a tap loop. Loud,
    // because a stored payload that fails the schema it was minted under is corruption.
    console.error(
      `[actions] action ${actionId} stored an unreadable payload: ${JSON.stringify(claimed)?.slice(0, 300)}`,
    )
    return { ok: false, reason: 'missing' }
  }

  // Nothing was claimed. This read decides no outcome — it only says why, so the reply can
  // be "that one's already been used" rather than a shrug.
  return withSession({ role: 'service', academyId: ctx.academyId }, async (tx): Promise<ConsumeResult> => {
    const rows = await tx<
      {
        minted_for_contact_id: string
        consumed_at: Date | null
        expired: boolean
      }[]
    >`
      select minted_for_contact_id,
             consumed_at,
             (expires_at is not null and expires_at <= app.now()) as expired
        from action
       where id = ${actionId}
         and academy_id = ${ctx.academyId}`

    if (rows.length === 0) return { ok: false, reason: 'missing' }
    const row = rows[0]
    // Order matters: someone else's button is the wrong contact whatever else is true of it.
    if (row.minted_for_contact_id !== byContactId) return { ok: false, reason: 'wrong_contact' }
    if (row.consumed_at) return { ok: false, reason: 'already_used' }
    if (row.expired) return { ok: false, reason: 'expired' }
    return { ok: false, reason: 'missing' }
  })
}

/**
 * Read a minted action without consuming it — for the emulator's action inspector and for a
 * caller that needs to know whether a button is still live before re-offering it. Never a
 * substitute for `consumeAction`: looking is not claiming.
 */
export type PeekResult =
  | {
      ok: true
      payload: ActionPayload
      mintedForContactId: string
      expiresAt: Date | null
      consumedAt: Date | null
    }
  | { ok: false }

export async function peekAction(ctx: SessionCtx, actionId: string): Promise<PeekResult> {
  if (!actionId || !UUID_RE.test(actionId)) return { ok: false }

  return withSession({ role: 'service', academyId: ctx.academyId }, async (tx): Promise<PeekResult> => {
    const rows = await tx<
      {
        payload: unknown
        minted_for_contact_id: string
        expires_at: Date | null
        consumed_at: Date | null
      }[]
    >`
      select payload, minted_for_contact_id, expires_at, consumed_at
        from action
       where id = ${actionId}
         and academy_id = ${ctx.academyId}`

    if (rows.length === 0) return { ok: false }
    const payload = parsePayload(rows[0].payload)
    if (!payload) return { ok: false }
    return {
      ok: true,
      payload,
      mintedForContactId: rows[0].minted_for_contact_id,
      expiresAt: rows[0].expires_at,
      consumedAt: rows[0].consumed_at,
    }
  })
}

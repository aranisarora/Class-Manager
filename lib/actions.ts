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
 *
 * That same statement now retires the siblings of a tap that decided something (0016). A
 * message's buttons were unrelated rows, so `[Do it]` and `[Cancel]` were each live for a
 * day: the plan committed on the first tap, and the second one still replied *"Left as it
 * was — nothing changed."* The invalidation rides inside the claim rather than following it,
 * because a second statement is one more thing that can fail to run — and a claim that
 * succeeded while the invalidation did not is precisely the state that tells the lie.
 *
 * It is deliberately narrow, and the WHERE clause says why: an informational card whose
 * buttons are all `noop` — `[I'll be there]` beside `[Can't make it]` — retires nothing.
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

/**
 * Close the family: tell a batch of just-minted actions which message they were printed on.
 *
 * The ordering is forced and cannot be fixed by minting later — a button carries an action
 * id, so the ids have to exist before the message can be built, and the `message` row is
 * written by `send` at the end of that. So the link is stamped on the way back, the moment
 * the send returns an id. Both mint paths (`composeAndSend`, `flushOutbox`) call this; a
 * button whose message never got a row keeps `message_id` null and behaves exactly as every
 * button did before 0016.
 *
 * Never re-stamps (`message_id is null`). An action belongs to one message, and moving one
 * into another family would let a tap over there expire buttons somebody is still looking at.
 */
export async function attachActionsToMessage(
  ctx: SessionCtx,
  messageId: string | null,
  actionIds: string[],
): Promise<void> {
  if (!messageId || !UUID_RE.test(messageId)) return
  const ids = actionIds.filter((id) => UUID_RE.test(id))
  if (!ids.length) return

  // Loud, never thrown — and this is the one place in this file where that is the right way
  // round. By the time this runs the message is on somebody's phone; a throw would travel up
  // into `flushOutbox`'s catch and be recorded as a message that failed to send, which is a
  // false statement about delivery told to prevent a false statement about work. The failure
  // it degrades to is exactly pre-0016 behaviour — siblings that outlive their message — and
  // it says so in the log rather than passing for success.
  let stamped = 0
  try {
    stamped = await withSession({ role: 'service', academyId: ctx.academyId }, async (tx) => {
      const rows = await tx<{ id: string }[]>`
        update action
           set message_id = ${messageId}
         where id = any (${ids}::uuid[])
           and academy_id = ${ctx.academyId}
           and message_id is null
        returning id`
      return rows.length
    })
  } catch (e) {
    console.error(
      `[actions] could not stamp message ${messageId} onto ${ids.length} action(s): ` +
        `${(e as Error).message} — every button on that message stays independently live`,
    )
    return
  }

  // Postgres does not raise on a WHERE that matches nothing, and this one matching nothing is
  // invisible in every other way: the message goes out, the buttons work, and the only symptom
  // is the bug 0016 exists to kill coming back — `[Cancel]` still live after the plan committed.
  if (stamped !== ids.length) {
    console.error(
      `[actions] stamped ${stamped}/${ids.length} action(s) onto message ${messageId} — ` +
        `the rest cannot be retired when a sibling on that message is tapped`,
    )
  }
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
      with claimed as (
        update action
           set consumed_at = app.now(),
               consumed_by_contact_id = ${byContactId}
         where id = ${actionId}
           and academy_id = ${ctx.academyId}
           and minted_for_contact_id = ${byContactId}
           and consumed_at is null
           and (expires_at is null or expires_at > app.now())
        returning id, payload, message_id
      ),
      -- The other buttons on the same message, under the two conditions below. A
      -- data-modifying CTE runs exactly once whether or not the outer query reads it, so
      -- this is not dead code -- it is the claim and the invalidation in one statement,
      -- which is the only way the two cannot come apart. Nothing is updated twice:
      -- a.id <> c.id excludes the row the claim just took.
      --
      -- NOTE FOR ANYONE EDITING THESE COMMENTS: no backticks and no apostrophes. This
      -- whole query is a JS tagged template, so one backtick ends the string and takes
      -- the rest of the file with it. That is not hypothetical -- it is how this block
      -- first arrived.
      superseded as (
        update action a
           set expires_at = app.now(),
               expired_reason = 'superseded_by_action:' || c.id::text
          from claimed c
         where a.message_id = c.message_id      -- null groups with nothing; see 0016
           and a.id <> c.id
           and a.academy_id = ${ctx.academyId}
           -- Belt to the policy, and the reason the policy can never quietly narrow this:
           -- a message goes to one contact, so its buttons are all minted for the tapper,
           -- and action_cm_user_update (0003) allows exactly those rows. An RLS refusal
           -- here would be silent and would leave the false "nothing changed" alive.
           and a.minted_for_contact_id = ${byContactId}
           and a.consumed_at is null
           and (a.expires_at is null or a.expires_at > app.now())
           -- Two gates, and the fix is wrong without either one.
           --
           -- FIRST, the tap has to have DECIDED something. operation and steps did the
           -- work, noop declined it, handoff gave the conversation away -- after any of
           -- those, a sibling still claiming "nothing changed", or still able to commit, is
           -- false or dangerous. reply, view and menu retire nothing: they assert
           -- nothing about work and they are the surfaces people come back to. The root menu
           -- is a list of reply rows, and the confirmation card own [Show me all 12] is
           -- a reply that must leave [Do it] and [Cancel] exactly where they were --
           -- retiring on those would trade a false sentence for a menu that works once. A
           -- reply also goes back through the model, which is there to notice.
           and c.payload ->> 'kind' in ('operation', 'steps', 'noop', 'handoff')
           -- SECOND, the message has to be one where something can actually be committed.
           -- Without this the fix breaks the commonest cards in the product, which pair two
           -- noops and mean both: the session reminder offers [I will be there] and
           -- [Cannot make it], and the trial confirmation offers [Add to calendar] and
           -- [Directions]. Nothing on those can change a row, so no tap can make a sibling
           -- false -- but retiring siblings would mean a parent who tapped "I will be there"
           -- this morning cannot tell us at four o clock that they cannot make it. That is a
           -- worse bug than the one this exists to fix.
           --
           -- Consumed and expired rows count here: the card nature does not change when
           -- its [Do it] is taken, and that tap is the exact case this has to catch.
           and exists (
             select 1
               from action w
              where w.message_id = c.message_id
                and w.payload ->> 'kind' in ('operation', 'steps')
           )
        returning a.id
      )
      select payload from claimed`
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
    if (row.expired) {
      // A button retired by its sibling lands here, and `expired` is what it must report:
      // `TAP_REFUSAL.expired` in lib/agent/loop.ts says *"That button has expired — tell me
      // what you'd like and I'll sort it out"*, which is true of this row and invites the
      // correction. It is emphatically NOT `already_used` — "that one's already done" about
      // a `[Cancel]` whose sibling committed is the same lie 0016 exists to kill, told from
      // the other end. The row keeps the whole truth in `expired_reason`, which is where the
      // emulator and anyone asking "why did Cancel stop working?" reads it — this path stays
      // quiet because a sibling being retired is the system working, not a fault.
      return { ok: false, reason: 'expired' }
    }
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

/**
 * lib/actions.ts — mint once, replay verbatim (§2.2, §6.5).
 *
 * @mechanism consumeAction — a tap loads the minted row and claims it with ONE conditional
 *   UPDATE whose WHERE clause carries all three checks (expiry, consumption,
 *   `minted_for_contact_id`), so they are evaluated against the row as it is locked rather
 *   than as it was read. No model call, no re-resolution, no string parsing: minting and
 *   tapping are different moments, and the tap replays what was authored while the context
 *   was there. Read-then-write would let two coaches both win `[Claim this session]` and put
 *   two people at one court.
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
 * @mechanism superseded — the other buttons on the same message are retired INSIDE the
 *   claiming statement, as a data-modifying CTE rather than a second write, because a claim
 *   that succeeded while the invalidation did not is exactly the state that tells the lie:
 *   `[Do it]` commits the plan and `[Cancel]`, still live a day later, answers that nothing
 *   changed. Narrow on purpose, and the WHERE clause says how: only a tap that
 *   DECIDED something retires anything, and only on a message where something could be
 *   committed, so the reminder card pairing `[I'll be there]` with `[Can't make it]` still
 *   lets a parent change their mind at four o'clock.
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

import { serviceFrom, withSession } from '@/lib/db'
import type { SessionCtx } from '@/lib/db'
import { msgError } from '@/lib/messaging/types'
import type { OperationName } from '@/lib/agent/operations'
import type { PlanStep } from '@/lib/agent/plan'
import { checkActionPayload } from '@/lib/agent/steps'

export type ActionPayload =
  | { kind: 'operation'; op: OperationName; args: Record<string, unknown> }
  | { kind: 'steps'; steps: PlanStep[]; summary: string }
  /**
   * Replays as if the user typed it — goes back through the agent.
   *
   * This is what a form-shaped button is now (§14.6). There used to be a `form` kind
   * that opened a WhatsApp Flow, and a `flow` kind for the submission coming back;
   * both are gone. `[Take register]` mints `{kind:'reply', text:'Take the register
   * for Evening Fitness, 6:30pm'}` — the words the person would have typed — and the
   * agent asks for what it still needs, in order, skipping what it can already see.
   *
   * The trade is deliberate: a Flow returned every field in one exchange, and could
   * only ever return the fields it was published with. A ladder costs round trips and
   * takes the answer nobody anticipated, including the one that arrives as *"and
   * Meera's out all month"* halfway through.
   */
  | { kind: 'reply'; text: string }
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

  return withSession(serviceFrom(ctx), async (tx) => {
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
    stamped = await withSession(serviceFrom(ctx), async (tx) => {
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

type ClaimedRow = { payload: unknown; message_id: string | null }

/**
 * The tap is the answer — recorded as the runtime, because the tapper cannot.
 *
 * @mechanism resolveQuestion — a tap that decided something resolves the `pending_request`
 *   its message was asking, as a SECOND statement under the SERVICE role, because `cm_user`
 *   has no write policy on that table — which is why the same update, folded into the claim,
 *   matched zero rows for the life of the table and nothing counted it. Without it the tail
 *   keeps rendering an answered question as asked and unanswered, the model re-asks, a second
 *   tap arrives inside the notice window and charges somebody for a class they cancelled, and
 *   the expiry sweep resolves the question as `expired` and opens a turn chasing work that
 *   already happened. The row count is checked, because a write allowed to match nothing in
 *   silence is how this survived.
 *
 * **This lived inside the claiming statement and could never once have worked.**
 * `consumeAction` claims under the TAPPER (that is what stops one person answering
 * another person's question), and 0032 gives `cm_user` no write policy on
 * `pending_request`, deliberately: *"A person who could write it could forge an
 * answer to a question about somebody else."* So the `answered` CTE updated zero
 * rows, every time, for the life of the table — and because the statement asked for
 * `returning pr.id` and never read it, nothing counted it, logged it or alarmed.
 *
 * What that cost: `context.ts` renders every open row as ASKED AND UNANSWERED —
 * *"they have NOT answered … nothing behind it has happened … Never describe it as
 * done"* — three assertions with instruction force, resting entirely on this column.
 * A mother cancelled a class, tapped Yes, and the next day the model was still being
 * told she had never answered. It re-asked; she tapped again; by then the session was
 * inside the notice window and the second tap wrote `absent` over `cancelled_timely`
 * and charged her (`.probe/runs/2026-08-17-18-07-live`, turns 14/15/28/30).
 *
 * Since 0035 it also produces a *wrong* resolution rather than merely a missing one:
 * `expires_at` is now set from the button, so the sweep in `plan-ahead.ts` resolves an
 * answered question as `expired` and opens a turn chasing somebody about it.
 *
 * **Why a second statement is acceptable here, when the sibling invalidation is not.**
 * The two writes that must not come apart are the claim and the supersede — both are
 * on `action`, both are about which buttons are still live, and a gap between them is
 * a button that commits work twice. This one is a *record of what the tap meant*: a
 * gap leaves a question open one moment longer, which is exactly the state it was in
 * a moment ago. It cannot be atomic with the claim in any case, because the two need
 * different roles.
 *
 * The row count is checked because that is the whole lesson. A write allowed to match
 * nothing in silence is how this survived — same posture as `attachActionsToMessage`.
 */
async function resolveQuestion(
  ctx: SessionCtx,
  actionId: string,
  messageId: string | null,
  payload: unknown,
): Promise<void> {
  // A button that was never stamped onto a message (0016: a suppressed message keeps a
  // null `message_id`) asked no question anybody can find. Nothing to resolve, and not
  // a failure.
  if (!messageId || !UUID_RE.test(messageId)) return

  /**
   * The same gate the sibling invalidation uses, and for the same reason.
   *
   * `operation` and `steps` did the work, `noop` declined it, `handoff` gave the
   * conversation away — each of those is an answer. `reply`, `view` and `menu` assert
   * nothing: a confirmation card carrying its own [Show me all 12] is explicitly
   * required to leave [Do it] and [Cancel] where they were, so treating that tap as
   * the answer would close a question nobody answered — the same class of false
   * record this function exists to end, pointed the other way.
   */
  const kind = (payload as { kind?: unknown } | null)?.kind
  if (kind !== 'operation' && kind !== 'steps' && kind !== 'noop' && kind !== 'handoff') return

  try {
    const stillOpen = await withSession(serviceFrom(ctx), async (tx) => {
      const resolved = await tx<{ id: string }[]>`
        update pending_request
           set resolved_at = app.now(), resolution = 'tapped'
         where message_id = ${messageId}
           and academy_id = ${ctx.academyId}
           and resolved_at is null
        returning id`
      if (resolved.length > 0) return 0
      // Resolving nothing is the ordinary case — most cards ask no question, so there is
      // no row. The defect looks different: a row for this message that is STILL open
      // after the write. Only that is worth a word.
      const open = await tx<{ id: string }[]>`
        select id from pending_request
         where message_id = ${messageId}
           and academy_id = ${ctx.academyId}
           and resolved_at is null`
      return open.length
    })

    if (stillOpen > 0) {
      console.error(
        `[actions] action ${actionId} committed but ${stillOpen} question(s) on message ${messageId} ` +
          `are still open — the tail will keep reporting them as unanswered, and the expiry sweep ` +
          `will resolve them as 'expired' and chase somebody about work that already happened`,
      )
    }
  } catch (e) {
    // Loud, never thrown. By the time this runs the tap has committed real work; a throw
    // here would turn a recorded action into a reported failure, which is a false
    // statement about the world told to prevent a true one about bookkeeping.
    console.error(
      `[actions] action ${actionId} committed but its question on message ${messageId} ` +
        `could not be resolved: ${(e as Error).message} — the tail will keep reporting it as unanswered`,
    )
  }
}

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
  const claimCtx: SessionCtx = ctx.role === 'user' ? ctx : serviceFrom(ctx)

  const claimed = await withSession(claimCtx, async (tx) => {
    const rows = await tx<ClaimedRow[]>`
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
      -- The question this card was asking used to be answered HERE, in this
      -- statement, and it could never work. See resolveQuestion above: this
      -- statement runs under the TAPPER, and 0032 gives cm_user no write policy
      -- on pending_request on purpose. The update matched nothing, silently, for
      -- the life of the table.
      --
      -- (No backticks and no apostrophes in here. See the NOTE above.)
      select payload, message_id from claimed`
    return rows.length ? (rows[0] as ClaimedRow) : null
  })

  if (claimed !== null) {
    // The other half of the claim, and it has to be a second statement — see
    // `resolveQuestion`. Awaited, not fire-and-forget: a tap whose question stays
    // open is the defect this exists to close, and the caller may as well learn
    // about it in the same breath as the tap.
    await resolveQuestion(ctx, actionId, claimed.message_id, claimed.payload)

    const payload = parsePayload(claimed.payload)
    if (payload) return { ok: true, payload }
    // Claimed but unreadable: the row is spent either way, which stops a tap loop. Loud,
    // because a stored payload that fails the schema it was minted under is corruption.
    console.error(
      `[actions] action ${actionId} stored an unreadable payload: ${JSON.stringify(claimed.payload)?.slice(0, 300)}`,
    )
    return { ok: false, reason: 'missing' }
  }

  // Nothing was claimed. This read decides no outcome — it only says why, so the reply can
  // be "that one's already been used" rather than a shrug.
  return withSession(serviceFrom(ctx), async (tx): Promise<ConsumeResult> => {
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

// `peekAction` used to sit here — read a minted action without consuming it, "for the
// emulator's action inspector and for a caller that needs to know whether a button is
// still live". Neither ever existed: the emulator reads the `action` table directly and
// nothing anywhere re-offers a button conditionally. `consumeAction` is the whole of this
// module's contract, and looking without claiming turned out to be a use nobody had.

/**
 * lib/messaging/compose.ts — buttons become actions, then the message goes out.
 *
 * This is where §4.3 is paid for. "After every action the bot takes, it offers the natural
 * next step as a button" — and every one of those buttons is an `action` row minted here,
 * fully resolved, before the message exists (§2.2). The tap replays it; nothing is inferred
 * at tap time.
 *
 * It is also where §17's structural honesty is enforced ahead of the wire: the message is
 * checked against the real Cloud API limits **and rejected if it does not fit**, never
 * truncated. Truncating a 21-character button title to 20 produces a message that renders,
 * so nobody finds out the compose step is wrong; rejecting it puts a `limit_violation` row
 * in the event log with the exact reason. "If a message cannot render in the emulator, it
 * does not ship."
 */

import { attachActionsToMessage, mintAction } from '@/lib/actions'
import type { ActionPayload } from '@/lib/actions'
import type { SessionCtx } from '@/lib/db'
import { idem, newId } from '@/lib/ids'
import { CATALOG, isCatalogId } from './catalog'
import type { CatalogId } from './catalog'
import { send } from './send'
import { repairOutbound } from './repair'
import type { Button, LinkButton, ListRow, ListSection, OutboundMessage, SendOutcome } from './types'
import { validateOutbound } from './types'

export type ComposeSpec = {
  toContactId: string
  body: string
  header?: string
  footer?: string
  buttons?: { title: string; action: ActionPayload }[]
  list?: {
    buttonText: string
    sections: { title: string; rows: { title: string; description?: string; action: ActionPayload }[] }[]
  }
  /**
   * §14.6 — a link, as a button. The one shape a URL may leave this product in.
   * Exclusive with `buttons` and `list`, because the wire's `cta_url` is.
   */
  link?: LinkButton
  catalogId?: CatalogId | null
  fixed?: boolean
  subjectPersonIds?: string[]
  isConfirmationRequest?: boolean
  isEscalation?: boolean
  preLaunchOk?: boolean
  media?: OutboundMessage['media']
  /**
   * Additive (safe to omit). Supply one where the same moment must produce one message
   * however many times it is raised — a job that reruns, a retry after a crash. Omitted, a
   * fresh key is generated, because two deliberate replies are two messages.
   */
  idempotencyKey?: string
  /** Additive: overrides the catalog row's action TTL. Defaults to the row's, then 24h. */
  ttlMinutes?: number
  /** Additive: forces a specific §16.2 template out of window (usually the catalog decides). */
  templateName?: OutboundMessage['templateName']
  /** Additive: named template parameters, when the caller knows better than the defaults. */
  templateParams?: Record<string, string>
}

/** Mints an action per button, then hands a well-formed OutboundMessage to `send`. */
export async function composeAndSend(ctx: SessionCtx, rawSpec: ComposeSpec): Promise<SendOutcome> {
  // The one place all outbound traffic passes, which is the only place a guarantee about
  // outbound traffic can live. Every previous attempt at these three repairs was made in
  // a caller — `reply` had one, the loop's trailing message had another — so which of them
  // a given turn got depended on which path the model happened to take, and a guarantee
  // that depends on the model's choice is not a guarantee. Jobs, digests, escalations and
  // tap acknowledgements went through neither.
  const { message: repaired, repairs, bracketButtons } = repairOutbound(rawSpec)
  // This path can still mint, so labels the model typed into the prose become the buttons
  // it plainly meant — unless the message already carries an affordance, in which case the
  // brackets are simply gone, which is the better of the two remaining outcomes.
  const spec: ComposeSpec =
    bracketButtons.length && !repaired.buttons?.length && !repaired.list && !repaired.link
      ? { ...repaired, buttons: bracketButtons as ComposeSpec['buttons'] }
      : repaired
  if (repairs.length) {
    // Loud, never silent: a repair firing every time is a compose bug upstream, and the
    // whole reason "reject, never truncate" was the rule is that a silent fix hides one.
    console.warn(`[compose] repaired an outbound message to ${spec.toContactId}: ${repairs.join('; ')}`)
  }
  const entry = spec.catalogId && isCatalogId(spec.catalogId) ? CATALOG[spec.catalogId] : null

  const idempotencyKey =
    spec.idempotencyKey ??
    idem(spec.catalogId ?? 'composed', spec.toContactId, newId())

  const fixed = spec.fixed ?? entry?.fixed ?? false

  // §16.3 — a message going back to the person who is talking to us is solicited by
  // construction, and the acting session is what proves it: a turn runs as `role:'user'` for
  // the contact who messaged, while jobs, digests and escalations run as `role:'service'`
  // with no contact at all. So proactive traffic cannot acquire this flag by accident, and a
  // message the model sends to a *third* party during someone's turn does not get it either.
  const solicited = ctx.role !== 'service' && ctx.contactId === spec.toContactId

  const base: Omit<OutboundMessage, 'buttons' | 'list'> = {
    toContactId: spec.toContactId,
    body: spec.body,
    header: spec.header,
    footer: spec.footer,
    link: spec.link,
    media: spec.media,
    catalogId: spec.catalogId ?? null,
    templateName: spec.templateName ?? null,
    idempotencyKey,
    subjectPersonIds: spec.subjectPersonIds ?? [],
    isConfirmationRequest: spec.isConfirmationRequest,
    isEscalation: spec.isEscalation,
    fixed,
    solicited,
    preLaunchOk: spec.preLaunchOk,
    templateParams: spec.templateParams,
  }

  // Validate the shape BEFORE minting: an unrenderable message must not leave a trail of
  // live action rows behind it. The placeholder ids stand in for the ones we would mint, so
  // the check sees the message it would actually have produced.
  const provisional: OutboundMessage = {
    ...base,
    buttons: spec.buttons?.map((b, i) => ({ actionId: `pending-${i}`, title: b.title })),
    list: spec.list
      ? {
          buttonText: spec.list.buttonText,
          sections: spec.list.sections.map((s, si) => ({
            title: s.title,
            rows: s.rows.map((r, ri) => ({
              actionId: `pending-${si}-${ri}`,
              title: r.title,
              description: r.description,
            })),
          })),
        }
      : undefined,
  }

  const violations = validateOutbound(provisional)
  if (violations.length) {
    // Loud in dev (§17), and recorded: `send`'s gate 5 writes the row so the event log shows
    // a suppressed message with a reason instead of a message that silently never happened.
    console.error(
      `[compose] refusing to mint actions for a message that cannot render: ${violations.join('; ')}`,
    )
    return send(ctx, provisional)
  }

  const ttlMinutes = spec.ttlMinutes ?? entry?.actionTtlMinutes

  // Every action this message prints, kept so the message can be stamped onto them once it
  // has an id (0016). The order is forced: a button carries an action id, so the ids must
  // exist before the message does.
  const minted: string[] = []

  let buttons: Button[] | undefined
  if (spec.buttons?.length) {
    buttons = []
    for (const b of spec.buttons) {
      const actionId = await mintAction(ctx, {
        payload: b.action,
        forContactId: spec.toContactId,
        ttlMinutes,
      })
      minted.push(actionId)
      buttons.push({ actionId, title: b.title })
    }
  }

  let list: OutboundMessage['list']
  if (spec.list) {
    const sections: ListSection[] = []
    for (const s of spec.list.sections) {
      const rows: ListRow[] = []
      for (const r of s.rows) {
        const actionId = await mintAction(ctx, {
          payload: r.action,
          forContactId: spec.toContactId,
          ttlMinutes,
        })
        minted.push(actionId)
        rows.push({ actionId, title: r.title, description: r.description })
      }
      sections.push({ title: s.title, rows })
    }
    list = { buttonText: spec.list.buttonText, sections }
  }

  const outcome = await send(ctx, { ...base, buttons, list })
  // Close the family before returning. Until this lands, every button on this message is an
  // independent row live for its own TTL — which is how tapping `[Do it]` and then `[Cancel]`
  // on the same card committed a plan and then said "Left as it was — nothing changed."
  // A suppressed or failed send that never got a row leaves them unstamped, which is exactly
  // right: nothing was printed, so there is no family and nothing to invalidate.
  await attachActionsToMessage(ctx, outcome.messageId, minted)
  return outcome
}

/**
 * The §12 path: raise a catalog moment with its default buttons already wired to payloads.
 * The defaults are what a competent manager would do knowing nothing about the person — the
 * bot is expected to depart from them knowing something, which is why this takes the payloads
 * rather than inventing them.
 */
export async function composeCatalog(
  ctx: SessionCtx,
  catalogId: CatalogId,
  spec: Omit<ComposeSpec, 'catalogId'>,
): Promise<SendOutcome> {
  return composeAndSend(ctx, { ...spec, catalogId })
}

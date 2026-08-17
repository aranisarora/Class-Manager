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
import { FLOWS } from './flows'
import { send } from './send'
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
  /**
   * A form the person fills in inside WhatsApp. Give the flow's registry id; the
   * CTA, the entry screen and the response schema all come from the definition, and
   * the `flow_token` is the `action` row minted here — the same mint-once,
   * replay-verbatim path every button takes (§2.2).
   */
  flow?: { flow: string; data?: Record<string, unknown> }
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
  /**
   * Additive: what standing state this message reports, and what it currently is.
   * Told once per state — see `OutboundMessage.stateKey` and F-AN.
   */
  stateKey?: string
}

/** Mints an action per button, then hands a well-formed OutboundMessage to `send`. */
export async function composeAndSend(ctx: SessionCtx, spec: ComposeSpec): Promise<SendOutcome> {
  /**
   * **Nothing is repaired here any more, and that is the change.**
   *
   * This used to call `repairOutbound` first: it pulled wire-shape blobs out of
   * the body, harvested `[Bracketed labels]` into real buttons, turned a pasted
   * URL into a link button and dropped the reply buttons it cannot share a
   * message with, and trimmed headers and footers to fit. Every one of those was
   * defensible on its own and every one of them was the same thing —
   * ARCHITECTURE.md's second author, the gap between the message the model wrote
   * and the message the person read, which becomes a false belief in the very
   * next turn because the model's only picture of what it sent is its draft.
   * The runtime then had to explain its own edits back through `altered`, which
   * is the design the architecture replaces with not having edits.
   *
   * All of it is a refusal now, and it fires where a round of grace exists: the
   * `reply` tool checks `proseViolations` plus the wire limits before composing
   * and comes back with the reason. What reaches this function is what its author
   * meant, and `validateOutbound` below is the last structural check rather than
   * the last chance to rewrite.
   */
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
    stateKey: spec.stateKey,
  }

  // Validate the shape BEFORE minting: an unrenderable message must not leave a trail of
  // live action rows behind it. The placeholder ids stand in for the ones we would mint, so
  // the check sees the message it would actually have produced.
  const flowDef = spec.flow ? FLOWS[spec.flow.flow] : undefined
  if (spec.flow && !flowDef) {
    console.error(`[compose] no flow called ${spec.flow.flow}`)
  }

  const provisional: OutboundMessage = {
    ...base,
    flow: flowDef
      ? {
          cta: flowDef.cta,
          flowId: flowDef.id,
          flowToken: 'pending-flow',
          screen: flowDef.entryScreen,
          data: spec.flow?.data,
          mode: 'published',
        }
      : undefined,
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

  let flow: OutboundMessage['flow']
  if (flowDef) {
    // The Flow's `flow_token` IS the action id, so a submission arrives as a tap
    // that happens to carry answers — and inherits expiry, single consumption and
    // the minted-for-contact check without any of them being written twice.
    const actionId = await mintAction(ctx, {
      payload: { kind: 'flow', flow: flowDef.id },
      forContactId: spec.toContactId,
      ttlMinutes,
    })
    minted.push(actionId)
    flow = {
      cta: flowDef.cta,
      flowId: flowDef.id,
      flowToken: actionId,
      screen: flowDef.entryScreen,
      data: spec.flow?.data,
      mode: 'published',
    }
  }

  const outcome = await send(ctx, { ...base, buttons, list, flow })
  // Close the family before returning. Until this lands, every button on this message is an
  // independent row live for its own TTL — which is how tapping `[Do it]` and then `[Cancel]`
  // on the same card committed a plan and then said "Left as it was — nothing changed."
  // A suppressed or failed send that never got a row leaves them unstamped, which is exactly
  // right: nothing was printed, so there is no family and nothing to invalidate.
  await attachActionsToMessage(ctx, outcome.messageId, minted)
  return outcome
}

// `composeCatalog(ctx, id, spec)` used to sit here, described as "the §12 path" for
// raising a catalog moment. It was `composeAndSend(ctx, {...spec, catalogId})` and
// nothing called it: every catalog moment in the product passes `catalogId` on the spec
// directly, which is the same call with one fewer name to know.

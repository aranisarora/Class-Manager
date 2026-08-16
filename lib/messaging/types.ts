/**
 * lib/messaging/types.ts — the shapes every send flows through.
 *
 * LIMITS are the real Cloud API's (§17: "something that works here works there").
 * They are enforced, never applied by truncation: a button title of 21 characters is
 * a compose bug, and silently cutting it to 20 hides the bug until production. §17's
 * rule is the whole design — if a message cannot render in the emulator, it does not
 * ship, so an unrenderable message is rejected loudly and recorded as suppressed.
 */

import { AppError } from '@/lib/errors'
import type { CatalogId } from './catalog'
import type { TemplateName } from './templates'

export type { CatalogId, TemplateName }

export const LIMITS = {
  bodyChars: 1024, // interactive body
  textChars: 4096, // plain text
  buttons: 3,
  buttonTitleChars: 20,
  listRows: 10,
  listRowTitleChars: 24,
  listSectionTitleChars: 24,
  headerChars: 60,
  footerChars: 60,
} as const

/**
 * Cloud API limits the contract does not name but the wire still enforces.
 * Kept out of LIMITS so LIMITS stays byte-identical to CONTRACTS §5.
 */
export const EXTRA_LIMITS = {
  listButtonTextChars: 20,
  listRowDescriptionChars: 72,
  listSections: 10,
  templateParamChars: 1024,
  /** Cloud API: `flow_cta` is capped at 20 characters and rejects emoji outright. */
  flowCtaChars: 20,
} as const

export type Button = { actionId: string; title: string }
export type ListRow = { actionId: string; title: string; description?: string }
export type ListSection = { title: string; rows: ListRow[] }

/**
 * §14.6 — "Every link is a button. Nothing URL-shaped is pasted into message text."
 *
 * That rule had no way to be obeyed: the wire shape carried reply buttons and lists
 * and nothing else, so every link this product has ever sent went out as a 300-character
 * signed JWT sitting in the body of a WhatsApp message. On a phone that is a wall of
 * base64 where a sentence should be, and it is the runtime that put it there — the
 * `view` tap composed `"Here it is — this link is yours…" + linkUrl(token)`.
 *
 * A capability with no way to reach it is indistinguishable from a model that never
 * wants it, so this is the way to reach it: the Cloud API's `cta_url` interactive,
 * which is a body plus exactly one button that opens a URL.
 *
 * **Exclusive with buttons and with a list**, because the wire is: `cta_url` has room
 * for one action and it is the link. That exclusivity is the reason this is a field of
 * its own rather than a variant of `Button` — a shape that cannot mix should not be
 * expressible as if it could.
 */
export type LinkButton = { title: string; url: string }

/**
 * A link the recipient should **forward** rather than tap.
 *
 * §8.1's coach invite and §9.1's parent invite are drafts the admin copies out of this
 * chat and sends from their own number, and their whole payload is a `wa.me` deep link
 * with prefilled text. That link belongs in the text, because the text is the artifact.
 * It is also short, readable, and says what it is — the opposite of a signed JWT.
 *
 * So the rule is not "no URLs in bodies", it is: **a link the recipient taps is a
 * button; a link the recipient forwards is text.** It lives here, next to the check that
 * enforces it, because the last time this predicate had two homes the two drifted apart
 * and took every invite in the product with them.
 */
const FORWARDABLE_LINK = /^https?:\/\/(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)/i

export function isForwardableLink(url: string): boolean {
  return FORWARDABLE_LINK.test(url)
}

/**
 * A WhatsApp Flow, as it rides on an interactive message.
 *
 * A Flow is the one affordance on this surface that collects SEVERAL fields in one
 * exchange. Everything else the product can send asks one question per message, and
 * onboarding is six questions — the shape of the business, where they play, the
 * hours, the cancellation window, the UPI handle — which is six round trips through
 * a chat window before anybody has typed a single class.
 *
 * `DRIVING.md` recorded "no WhatsApp Flows" as a standing decision, rejected for four
 * costs: an RSA keypair, an encrypted data-exchange endpoint, published versioned
 * artifacts, and a Meta review cycle per change. **Three of those four apply only to
 * endpoint-powered Flows.** Meta's own guidance is that a Flow should avoid an
 * endpoint when it does not need one, and a *static* Flow — every screen and every
 * value known when the message is sent — needs no keypair, no `/data` endpoint, no
 * AES-GCM, and no health check. What remains true is that the Flow JSON is a
 * versioned artifact published through the Flows API and immutable once published.
 * That is the one honest cost, and it is the cost of any declarative artifact.
 *
 * `flow_action` is always `navigate` here, which is what makes it static.
 *
 * **`flowToken` is an `action` row id**, which is the whole reason this fits the
 * product rather than sitting beside it. §2.2 is "mint once, replay verbatim": a
 * button carries an action authored at compose time, and a tap loads it, checks
 * expiry, checks single consumption, checks the tapping contact is the one it was
 * minted for, and executes it with no model call. A Flow submission is exactly that
 * with the person's answers attached — so it reuses every one of those guarantees
 * instead of inventing a parallel session concept with none of them.
 */
export type FlowCta = {
  /** The call to action on the bubble. Cloud API: <= 20 chars, and no emoji. */
  cta: string
  /** The published Flow's id. */
  flowId: string
  /** Opaque session token. Here: the `action` row this submission will replay. */
  flowToken: string
  /** The screen to open. Required whenever `flow_action` is `navigate`. */
  screen: string
  /**
   * Prefill for the first screen, reachable in the Flow JSON as `${data.key}`.
   *
   * Not just scalars. A `data-source` may itself be a `${data.x}` reference, which is
   * what lets one published register render tonight's twelve names and next week's
   * nine — the alternative being a separate artifact per headcount. So a value here
   * can be a list of `{id, title}` options, and the wire carries it as JSON.
   */
  data?: Record<string, unknown>
  /** `draft` sends only work in test mode; anything real is `published`. */
  mode?: 'published' | 'draft'
}

export type OutboundMessage = {
  toContactId: string
  body: string
  header?: string
  footer?: string
  buttons?: Button[]
  list?: { buttonText: string; sections: ListSection[] }
  /** §14.6 — a link, as a button. Never in the body. Exclusive with buttons and list. */
  link?: LinkButton
  /** A form, in the chat. Exclusive with buttons, list and link — the wire has one action. */
  flow?: FlowCta
  media?: { url: string; kind: 'image' | 'audio' | 'document'; filename?: string }
  catalogId?: CatalogId | null // §12 — null for a composed message (§14.4)
  templateName?: TemplateName | null
  idempotencyKey: string
  /** Who this message is ABOUT. Drives the two §18 suppression rules. */
  subjectPersonIds?: string[]
  isConfirmationRequest?: boolean
  isEscalation?: boolean
  /** §12 "fixed" rows: cannot be suppressed by policy, only reworded/merged. */
  fixed?: boolean
  /**
   * True when this message answers something this person just said — the reply inside a turn
   * they started, or the ack for a button they tapped.
   *
   * §16.3's per-recipient frequency limit exists to stop "a parent getting eight messages
   * because eight things happened". A reply is not one of those eight things: it exists only
   * because someone asked for it, so it cannot be the interruption the cap is defending
   * against. Counting it does no harm; *blocking* it silences the bot mid-conversation and,
   * worse, silently eats confirmation prompts — the plan is computed, the button is minted,
   * and the person sees nothing.
   *
   * Set by `composeAndSend` from the acting session, never by hand.
   */
  solicited?: boolean
  /** Set by onboarding flows that are allowed to send before `academy.onboarding_state='live'`. */
  preLaunchOk?: boolean
  /**
   * The acknowledgement of an opt-out — the one message the opt-out gate lets past.
   * See `MessageStep.opt_out_ack` for why, and note it is runtime-set only.
   */
  optOutAck?: boolean
  /**
   * Additive (not in CONTRACTS §5, safe to omit): named parameters for the §16.2 template
   * used when this message goes out of window. Omitted, `send` fills them from what it
   * knows — academy name, the catalog row's event phrase, the composed body as the detail —
   * so the template always carries real content rather than "you have an update" (§16.2).
   */
  templateParams?: Record<string, string>
}

export type SendOutcome =
  | {
      status: 'queued' | 'sent'
      messageId: string
      waMessageId: string | null
      inWindow: boolean
      template: TemplateName | null
      costPaise: number
      /**
       * Who this landed with, and whether it was a confirmation question —
       * threaded from the staged spec so a turn can know a confirmation is
       * already on someone's screen and not stage a second one (F-F: a family
       * got the operation's "Just to be sure —?" and the model's own richer
       * confirmation one minute apart, for one cancellation).
       */
      toContactId?: string
      confirmationRequest?: boolean
      /**
       * What the pipeline changed between the caller's spec and the wire — a body
       * over the interactive cap losing its buttons, an out-of-window body
       * replaced by a template rendering, a repair firing in compose. One line
       * per change, in the order they happened. Carried so the caller (the model,
       * through the `reply` result) reasons from the message the person received
       * rather than from its own draft; absent means nothing changed.
       */
      altered?: string[]
    }
  | { status: 'suppressed'; reason: SuppressReason; messageId: string | null }
  | { status: 'failed'; reason: string; messageId: string | null }

export type SuppressReason =
  | 'opted_out'
  | 'self_confirmation'
  | 'escalation_about_self'
  | 'pre_launch'
  | 'recipient_frequency_cap'
  | 'tenant_send_cap'
  | 'out_of_window_no_template'
  | 'duplicate_idempotency'
  /** Byte-identical to the last thing this person was told, moments ago. */
  | 'repeat'
  | 'no_contact'
  | 'limit_violation'

/** Message status ladder. §2.4: queued ≠ sent ≠ delivered ≠ read. */
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed'

/** §17 event log: what a conversation cost, and whether one opened at all. */
export type ConversationCategory =
  | 'service'
  | 'utility'
  | 'marketing'
  | 'authentication'
  | 'free_window'

/**
 * Approximate on purpose (CONTRACTS §5). The number is not a billing figure; the point is
 * that the emulator shows *that* a paid conversation opened when a template went out, and
 * that an in-window reply cost nothing — which is why buttons people want to tap are
 * infrastructure and not politeness (§16.1).
 */
export const COST_PAISE: Record<ConversationCategory, number> = {
  service: 35,
  utility: 30,
  marketing: 88,
  authentication: 15,
  free_window: 0,
}

/**
 * The single place this module constructs an AppError. One import surface, so the whole
 * messaging module is one edit away from any Core error-constructor shape.
 */
export function msgError(code: string, message: string, userMessage?: string): AppError {
  return new AppError({ code, message, userMessage })
}

const printable = (s: string): number => Array.from(s).length

/** Pictographs and the regional-indicator pairs that make flags. Deliberately narrow:
 *  this decides whether a send is refused, so it must not fire on ordinary punctuation. */
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{2190}-\u{21FF}]/u

/**
 * Every way this message would fail to render on the real wire, as human sentences.
 * Empty array = renderable. Never mutates, never truncates.
 */
export function validateOutbound(msg: OutboundMessage): string[] {
  const bad: string[] = []

  if (!msg.toContactId) bad.push('toContactId is required')
  if (!msg.idempotencyKey) bad.push('idempotencyKey is required on every outbound (§6.5)')

  const interactive = Boolean(msg.buttons?.length || msg.list || msg.link || msg.flow)
  const bodyLimit = interactive ? LIMITS.bodyChars : LIMITS.textChars
  const bodyLen = printable(msg.body ?? '')

  if (bodyLen === 0 && !msg.media) bad.push('body is empty and there is no media to carry the message')
  if (bodyLen > bodyLimit) {
    bad.push(
      `body is ${bodyLen} chars, limit ${bodyLimit}${interactive ? ' for an interactive message' : ''}`,
    )
  }

  if (msg.header !== undefined && printable(msg.header) > LIMITS.headerChars) {
    bad.push(`header is ${printable(msg.header)} chars, limit ${LIMITS.headerChars}`)
  }
  if (msg.footer !== undefined && printable(msg.footer) > LIMITS.footerChars) {
    bad.push(`footer is ${printable(msg.footer)} chars, limit ${LIMITS.footerChars}`)
  }

  if (msg.buttons?.length && msg.list) {
    bad.push('a message carries buttons or a list, never both')
  }

  if (msg.flow) {
    // The same exclusivity `cta_url` has, for the same reason: one interactive
    // message carries one action, and the Flow is it.
    if (msg.buttons?.length) bad.push('a message carries a flow or reply buttons, never both')
    if (msg.list) bad.push('a message carries a flow or a list, never both')
    if (msg.link) bad.push('a message carries a flow or a link, never both')

    const cta = printable(msg.flow.cta ?? '')
    if (cta === 0) bad.push('the flow has no call to action')
    if (cta > EXTRA_LIMITS.flowCtaChars) {
      bad.push(`flow cta is ${cta} chars, limit ${EXTRA_LIMITS.flowCtaChars}`)
    }
    // Meta rejects a `flow_cta` containing emoji, and it rejects it at SEND time —
    // which on this surface would be a message that simply never arrives. Caught
    // here so it is a compose bug with a sentence, not a silence on a phone.
    if (EMOJI.test(msg.flow.cta ?? '')) bad.push('flow cta contains an emoji, which the wire rejects')

    if (!msg.flow.flowId) bad.push('the flow has no flow id')
    if (!msg.flow.flowToken) bad.push('the flow has no flow token — nothing could match the reply to it')
    // Required precisely because `flow_action` is `navigate`: a static flow has to
    // say which screen it opens on, and Meta refuses the send without it.
    if (!msg.flow.screen) bad.push('a navigate flow must name the screen it opens on')
  }

  if (msg.link) {
    // `cta_url` has room for one action and it is the link, so this is a wire fact
    // rather than a house rule. Caught here so it cannot be discovered on a phone.
    if (msg.buttons?.length) bad.push('a message carries a link or reply buttons, never both')
    if (msg.list) bad.push('a message carries a link or a list, never both')
    const t = printable(msg.link.title ?? '')
    if (t === 0) bad.push('the link has no title')
    if (t > LIMITS.buttonTitleChars) {
      bad.push(`link title is ${t} chars, limit ${LIMITS.buttonTitleChars}`)
    }
    if (!/^https?:\/\/\S+$/i.test(msg.link.url ?? '')) {
      bad.push(`link url is not a url: ${String(msg.link.url ?? '').slice(0, 40)}`)
    }
  }

  // §14.6 — the whole point of `link`. A url in the body is not a smaller version of a
  // link button, it is the failure this shape exists to make impossible, and `compose`
  // repairs it before this ever fires. If it fires, something bypassed compose.
  //
  // It must ask the SAME question `repair` asks, from the same predicate. It did not:
  // repair exempted a forwardable `wa.me` deep link ("a link the recipient taps is a
  // button; a link the recipient forwards is text") and this checked for any url at all.
  // Two rules about one thing, and the one that runs last has no model in the loop — so
  // §8.1's coach invite and §9.1's parent invite, the only mechanism by which anybody
  // but the admin ever joins, were suppressed as `limit_violation` one hundred percent
  // of the time. The admin was told the invite had been drafted. Nothing had been sent,
  // and tapping `[Sent it]` produced no message at all.
  for (const url of (msg.body ?? '').match(/https?:\/\/\S+/gi) ?? []) {
    if (isForwardableLink(url)) continue
    bad.push('the body contains a url — links are buttons, never text (§14.6)')
    break
  }

  if (msg.buttons?.length) {
    if (msg.buttons.length > LIMITS.buttons) {
      bad.push(`${msg.buttons.length} buttons, limit ${LIMITS.buttons} — use a list for more`)
    }
    const seenTitle = new Set<string>()
    const seenAction = new Set<string>()
    for (const b of msg.buttons) {
      const n = printable(b.title ?? '')
      if (n === 0) bad.push('a button has no title')
      if (n > LIMITS.buttonTitleChars) {
        bad.push(`button "${b.title}" is ${n} chars, limit ${LIMITS.buttonTitleChars}`)
      }
      if (seenTitle.has(b.title)) bad.push(`two buttons share the title "${b.title}"`)
      seenTitle.add(b.title)
      if (!b.actionId) bad.push(`button "${b.title}" carries no action id (§2.2)`)
      else if (seenAction.has(b.actionId)) bad.push(`two buttons share one action id — mint one per button (§2.2)`)
      seenAction.add(b.actionId)
    }
  }

  if (msg.list) {
    const bt = printable(msg.list.buttonText ?? '')
    if (bt === 0) bad.push('the list has no button text')
    if (bt > EXTRA_LIMITS.listButtonTextChars) {
      bad.push(`list button text is ${bt} chars, limit ${EXTRA_LIMITS.listButtonTextChars}`)
    }
    const sections = msg.list.sections ?? []
    if (sections.length === 0) bad.push('the list has no sections')
    if (sections.length > EXTRA_LIMITS.listSections) {
      bad.push(`${sections.length} list sections, limit ${EXTRA_LIMITS.listSections}`)
    }
    let rows = 0
    const seenAction = new Set<string>()
    for (const s of sections) {
      if (printable(s.title ?? '') > LIMITS.listSectionTitleChars) {
        bad.push(`list section "${s.title}" is ${printable(s.title)} chars, limit ${LIMITS.listSectionTitleChars}`)
      }
      for (const r of s.rows ?? []) {
        rows += 1
        const n = printable(r.title ?? '')
        if (n === 0) bad.push('a list row has no title')
        if (n > LIMITS.listRowTitleChars) {
          bad.push(`list row "${r.title}" is ${n} chars, limit ${LIMITS.listRowTitleChars}`)
        }
        if (r.description !== undefined && printable(r.description) > EXTRA_LIMITS.listRowDescriptionChars) {
          bad.push(
            `list row "${r.title}" description is ${printable(r.description)} chars, limit ${EXTRA_LIMITS.listRowDescriptionChars}`,
          )
        }
        if (!r.actionId) bad.push(`list row "${r.title}" carries no action id (§2.2)`)
        else if (seenAction.has(r.actionId)) bad.push('two list rows share one action id — mint one per row (§2.2)')
        seenAction.add(r.actionId)
      }
    }
    if (rows === 0) bad.push('the list has no rows')
    if (rows > LIMITS.listRows) bad.push(`${rows} list rows, limit ${LIMITS.listRows}`)
  }

  if (msg.media) {
    if (!msg.media.url) bad.push('media carries no url')
    if (msg.media.kind === 'document' && !msg.media.filename) {
      bad.push('a document needs a filename to render')
    }
  }

  return bad
}

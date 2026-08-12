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
} as const

export type Button = { actionId: string; title: string }
export type ListRow = { actionId: string; title: string; description?: string }
export type ListSection = { title: string; rows: ListRow[] }

export type OutboundMessage = {
  toContactId: string
  body: string
  header?: string
  footer?: string
  buttons?: Button[]
  list?: { buttonText: string; sections: ListSection[] }
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

/**
 * Every way this message would fail to render on the real wire, as human sentences.
 * Empty array = renderable. Never mutates, never truncates.
 */
export function validateOutbound(msg: OutboundMessage): string[] {
  const bad: string[] = []

  if (!msg.toContactId) bad.push('toContactId is required')
  if (!msg.idempotencyKey) bad.push('idempotencyKey is required on every outbound (§6.5)')

  const interactive = Boolean(msg.buttons?.length || msg.list)
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

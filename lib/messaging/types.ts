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
 * `send_invite`'s `as_draft` is the one thing that still produces one: a `wa.me` deep
 * link with prefilled text, handed to the admin to forward when the bot's own send to
 * that number could not land. The link belongs in the text, because the text is the
 * artifact the admin copies out. It is also short, readable, and says what it is — the
 * opposite of a signed JWT.
 *
 * That path used to be the ONLY way anybody joined, which is why this predicate is as
 * load-bearing as its history says. It is a repair now, and the rule is unchanged.
 *
 * So the rule is not "no URLs in bodies", it is: **a link the recipient taps is a
 * button; a link the recipient forwards is text.** It lives here, next to the check that
 * enforces it, because the last time this predicate had two homes the two drifted apart
 * and took every invite in the product with them.
 *
 * @mechanism isForwardableLink — the single predicate for "a link the recipient taps is a
 *   button; a link the recipient forwards is text", living next to the check that enforces
 *   it. When the same question had two homes they disagreed, and every §8.1 coach invite
 *   and §9.1 parent invite — the only mechanism by which anyone but the admin joins — was
 *   suppressed as `limit_violation` while the admin was told the invite had been drafted.
 */
const FORWARDABLE_LINK = /^https?:\/\/(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)/i

export function isForwardableLink(url: string): boolean {
  return FORWARDABLE_LINK.test(url)
}

/**
 * THERE IS NO FORM ON THIS SURFACE, AND THAT IS DELIBERATE (§14.6).
 *
 * A `FlowCta` used to live here: a WhatsApp Flow riding on an interactive message,
 * carrying a published artifact id, an entry screen and a bag of prefill. It is gone.
 * A Flow collects several fields in one exchange, which is genuinely fewer round
 * trips — and it buys that by fixing every question, and the order of every question,
 * at publish time. **A form cannot ask what it was not built to ask.** It cannot skip
 * the field it can already see, follow the answer that turned out to matter, or take
 * the correction typed a second after Save. The register is the case that decided it:
 * an artifact renders whatever roster is passed in, and still cannot handle *"Aarav
 * left at half time and Meera's dad says she's out all month"* — a sentence a
 * conversation absorbs without being redesigned.
 *
 * So the affordances on this surface are the ones that compose with prose: buttons, a
 * list, and the message body. Anything form-shaped is a **chat ladder** — asked in
 * order, one question per message, skipping what is already known and stopping as
 * soon as it has enough. Nothing here needs a `flow_cta` limit, a screen name or a
 * publish cycle, because nothing here is a published artifact.
 */

export type OutboundMessage = {
  toContactId: string
  body: string
  header?: string
  footer?: string
  buttons?: Button[]
  list?: { buttonText: string; sections: ListSection[] }
  /** §14.6 — a link, as a button. Never in the body. Exclusive with buttons and list. */
  link?: LinkButton
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
   * True when the `redeliver` job is re-attempting a message the gates suppressed for
   * timing (quiet hours, either cap). Set only by that handler. `suppress()` reads it so
   * a re-attempt that is suppressed again does not enqueue a second chain — the handler
   * owns the retry ladder, keyed to the ORIGINAL message id, with its own ceiling.
   */
  redelivery?: boolean
  /**
   * The acknowledgement of an opt-out — the one message the opt-out gate lets past.
   * See `MessageStep.opt_out_ack` for why, and note it is runtime-set only.
   */
  optOutAck?: boolean
  /**
   * **What standing state this message reports, and what that state currently
   * IS.** Told once per state, and never again until the state changes.
   *
   * The repeat gate below it compares bodies inside a time window, and a stuck
   * state is exactly the case that defeats both halves: the body is identical
   * because nothing has happened, and the window is six hours because the
   * generator fires daily. Driven, the repetition invariant went red on **16
   * consecutive cases**, all queue traffic — Kiran got the generic session-change
   * shell four times, Arjun the byte-identical register chase three times, Meera
   * "we're still sorting out a coach" twice, the admin the same invite draft
   * re-issued two days apart. A coach who has not onboarded is one fact;
   * narrating it every morning trains everyone to ignore the number (F-AN).
   *
   * So the key carries the state, not the moment: `AD-COACH-NOT-ONBOARDED:<coach>
   * :invited`. Same key, no second message. When the state moves — they onboard,
   * a second register goes unmarked, the ladder escalates a rung — the key moves
   * with it and the message is news again. Set by the composer, because only the
   * composer knows what its message is a statement ABOUT.
   *
   * @mechanism stateKey — keys a standing message on the STATE it reports
   *   (`AD-COACH-NOT-ONBOARDED:<coach>:invited`) rather than on the moment that raised it,
   *   so a state is told once and only a state that moves is news again. The body-comparing
   *   repeat gate cannot cover this class: a stuck state produces a byte-identical body,
   *   days apart, outside any window it watches. Closes F-AN.
   */
  stateKey?: string
  /**
   * **What question this message puts on somebody's screen, so the unanswered
   * state exists from the first second.**
   *
   * `isConfirmationRequest` says a question was asked. It says nothing about
   * WHAT, and nothing at all once the message has scrolled away — which is the
   * single most expensive missing state in this product's history. An untapped
   * "stop messaging me" left the world identical to her never having asked
   * (F-AF); a coach's untapped decline left a class uncovered with nobody
   * re-asking (F-AQ). Worse than absent: a staged action rendered as "done" in
   * the next turn's context, and the model repeated the lie to the person it was
   * about.
   *
   * `subject` is what the question is ABOUT, normalised — a second ask on the
   * same subject supersedes the first rather than accumulating beside it (0032's
   * partial unique index). `send` derives one from the catalog moment and the
   * subject people when a caller supplies none, so the row exists even for a
   * protocol nobody has taught about this field: a state that depends on somebody
   * remembering is not a state.
   *
   * @mechanism confirmation — records the question a message puts on somebody's screen as
   *   state at send time, so an unanswered ask still exists after the message has scrolled
   *   away and a second ask on the same normalised `subject` supersedes the first instead
   *   of accumulating beside it. `send` derives one when the caller supplies none, so the
   *   row exists even for callers that know nothing about the field. Closes F-AF, F-AQ.
   */
  confirmation?: { kind: string; subject: string; question?: string }
  /**
   * How long the buttons on this message live, in minutes — carried so the
   * QUESTION can be given the same lifetime as the tap that answers it.
   *
   * `pending_request.expires_at` was written by nobody. Every row went in with a
   * NULL expiry, and the sweep in `plan-ahead.ts` that resolves stale questions
   * is predicated on `expires_at is not null` — so it was correct code that
   * could never match a row, and an unanswered question was permanent. Two sat
   * open at the end of the stress week for exactly this reason.
   *
   * A question dies when the button dies. Once the action has expired there is
   * no tap left that could answer it, so any other expiry would be a number
   * somebody chose; this one is the truth about the affordance.
   */
  actionTtlMinutes?: number
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
      /**
       * How many tappable things ACTUALLY left, counted off the wire message
       * after every gate has had it — not off the caller's draft.
       *
       * The draft and the wire disagree on exactly the sends where it matters:
       * a body over the interactive cap loses every button, and out of window
       * `committingButton` deletes a button that would commit because a
       * template's quick-reply title is frozen at approval and cannot be made to
       * match the action behind it. Both are correct. Both leave a caller that
       * counted its own array believing there is something to tap.
       */
      tappable: number
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
  /**
   * They asked for less of exactly this kind of thing (0032 `comm_preference`).
   * A scope, not an opt-out: "stop messaging me about money" is the commonest
   * stop request, and until there was a row for it a memory fact recorded the
   * promise while a `payment_due` job composing from a query kept its own
   * counsel (F-AV).
   */
  | 'muted'
  /**
   * The recipient has not answered N consecutive unprompted sends (§16.3's response-rate
   * proxy, enforced where it can act). Their own next message resets the count to zero.
   */
  | 'silence_backoff'
  /**
   * The academy is asleep. A floor under every proactive send, enforced here
   * rather than composed around by each job — going live at 2am fired three
   * reminders at 02:02, from three different handlers, none of which was wrong
   * about anything except the hour.
   */
  | 'quiet_hours'

/**
 * Message status ladder. §2.4: queued ≠ sent ≠ delivered ≠ read.
 *
 * `suppressed` is NOT a rung on it — it is the other outcome entirely, and
 * sharing `failed` with a real delivery failure is how the product told its own
 * owner his messaging was broken while it was working exactly as designed
 * (F-AT, closed by 0032). A gate is a decision; the wire saying no is a fault.
 *
 * @mechanism MessageStatus — keeps `suppressed` off the delivery ladder and distinct from
 *   `failed`, so a deliberate non-send is never read back as the wire refusing the message.
 *   Every gate's decision keeps its own `SuppressReason` beside it, which is what lets a
 *   report say why nothing went out rather than that something broke. Closes F-AT.
 */
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'suppressed'

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
 *
 * @mechanism validateOutbound — enumerates every way a message would fail on the real wire
 *   (LIMITS are the Cloud API's own numbers) and returns reasons instead of repairing
 *   anything: a 21-character button title is a compose bug, and cutting it to 20 produces a
 *   message that renders, so nobody ever finds the bug. Refusing and recording it is what
 *   makes §17's "if it cannot render in the emulator, it does not ship" enforceable rather
 *   than aspirational.
 */
export function validateOutbound(msg: OutboundMessage): string[] {
  const bad: string[] = []

  if (!msg.toContactId) bad.push('toContactId is required')
  if (!msg.idempotencyKey) bad.push('idempotencyKey is required on every outbound (§6.5)')

  const interactive = Boolean(msg.buttons?.length || msg.list || msg.link)
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
  // §8.1's coach invite and §9.1's parent invite, which were then the only mechanism by
  // which anybody but the admin ever joined, were suppressed as `limit_violation` one
  // hundred percent of the time. The admin was told the invite had been drafted. Nothing
  // had been sent, and tapping `[Sent it]` produced no message at all. The invite is a
  // bot send now and no longer depends on this, but `as_draft` still does.
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

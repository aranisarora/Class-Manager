/**
 * lib/messaging/templates.ts — the eight §16.2 templates.
 *
 * "Templates scale with categories of unsolicited contact, not with features." The ~35
 * catalog rows (§12) collapse to eight; adding an in-window interaction costs zero
 * templates.
 *
 * Every one carries **structured parameters holding real content**. A template whose body
 * is "you have an update, reply to see it" is the vague-clickbait pattern Meta tightens on:
 * it risks rejection outright and marketing categorisation if approved, which is more
 * expensive and carries more block risk on a shared number (§16.1). Parameters that carry
 * the academy's name, the event and the specific detail do the same job legitimately.
 *
 * All eight are **utility**: they follow from a transaction or a relationship the recipient
 * already has. Meta classifies on how the text reads, not on intent — so nothing here is
 * allowed to acquire a promotional sentence, or the whole category re-prices (§16.2).
 */

import { msgError } from './types'

export type TemplateName =
  | 'session_reminder'
  | 'session_change'
  | 'session_outcome'
  | 'payment_due'
  | 'coach_schedule'
  | 'coach_prompt'
  | 'admin_alert'
  | 'admin_digest'

export type TemplateCategory = 'utility' | 'marketing' | 'authentication' | 'service'

export type TemplateDef = {
  name: TemplateName
  /** Meta's category. Drives price and block risk (§16.2). */
  category: TemplateCategory
  language: string
  /** Ordered named parameters. Order IS the wire order: {{1}}, {{2}}, … */
  params: string[]
  /** Named-placeholder body. This is what the emulator shows and what Meta approves. */
  body: string
  /**
   * Out-of-window messages are window-openers (§14.7): deliberately simple, aimed at one
   * useful tap, after which the rich interaction happens in-window for free. A template's
   * quick-reply title is fixed at approval time; only its payload varies per send, which is
   * why `send` keeps the minted action id and replaces only the title.
   */
  quickReply: string
  /** The §16.2 "covers" column — which catalog rows ride this template. */
  covers: string
  /** A filled example. Documentation for the approval submission and the emulator. */
  example: string
}

export const TEMPLATES: Record<TemplateName, TemplateDef> = {
  session_reminder: {
    name: 'session_reminder',
    category: 'utility',
    language: 'en',
    params: ['academy', 'who', 'event', 'detail'],
    body: '{academy}: {who} has {event}. {detail}',
    quickReply: 'See the details',
    covers: 'client reminders — CL-REMINDER, CL-FIRST-CONTACT, CL-INTRO, PR-WELCOME',
    example:
      'Sharwin Academy: Aarav has Beginners Batch tomorrow. 6:30–7:30pm at Green Park, with Coach Vinod.',
  },
  session_change: {
    name: 'session_change',
    category: 'utility',
    language: 'en',
    params: ['academy', 'who', 'event', 'detail'],
    body: '{academy}: {event} for {who}. {detail}',
    quickReply: 'See the details',
    covers:
      'cancelled, moved, coach changed — CL-SESSION-CANCELLED, CL-SESSION-MOVED, CL-SESSION-TROUBLE, CL-CANCEL-CONFIRM, PR-TRIAL-CONFIRMED',
    example:
      "Sharwin Academy: Saturday's Advanced Batch has moved for Meera. Now 8:30–10:00am at Green Park, from this Saturday.",
  },
  session_outcome: {
    name: 'session_outcome',
    category: 'utility',
    language: 'en',
    params: ['academy', 'who', 'event', 'detail'],
    body: '{academy}: {who} — {event}. {detail}',
    quickReply: 'See the details',
    covers: 'attended/missed with note — CL-OUTCOME',
    example:
      'Sharwin Academy: Aarav — missed Beginners Batch today. Coach Vinod kept his spot for Friday.',
  },
  payment_due: {
    name: 'payment_due',
    category: 'utility',
    language: 'en',
    params: ['academy', 'who', 'event', 'detail'],
    body: '{academy}: {event} for {who}. {detail}',
    quickReply: 'See the lines',
    covers: 'tally, dunning, receipts — CL-TALLY, CL-DUNNING, CL-RECEIPT',
    example: "Sharwin Academy: October's tally is ready for Aarav. 8 sessions, ₹4,000, due 5 Nov.",
  },
  coach_schedule: {
    name: 'coach_schedule',
    category: 'utility',
    language: 'en',
    params: ['academy', 'event', 'detail'],
    body: '{academy}: {event}. {detail}',
    quickReply: 'Open my day',
    covers:
      'the day, cover offers, statements — CO-DAY, CO-COVER-OFFER, CO-COVER-TAKEN, CO-PAYABLES, CO-FINAL-STATEMENT',
    example:
      'Sharwin Academy: a session needs cover. Saturday 8:30am, Advanced Batch at Green Park — first to claim it takes it.',
  },
  coach_prompt: {
    name: 'coach_prompt',
    category: 'utility',
    language: 'en',
    params: ['academy', 'event', 'detail'],
    body: '{academy}: {event}. {detail}',
    quickReply: 'Open',
    covers: 'coming, nudge, register, invite check — CO-COMING, CO-NUDGE, CO-REGISTER, CO-INVITE-CONFIRM',
    example:
      'Sharwin Academy: take the register for Beginners Batch. 6:30pm today at Green Park, 11 players enrolled.',
  },
  admin_alert: {
    name: 'admin_alert',
    category: 'utility',
    language: 'en',
    params: ['academy', 'event', 'detail'],
    body: '{academy}: {event}. {detail}',
    quickReply: 'Open',
    covers:
      'every escalation — AD-ESCALATE-UNCONFIRMED, AD-COACH-LATE, AD-COACH-NOT-ONBOARDED, AD-REGISTER-MISSING, AD-RECONCILE, AD-NEW-TRIAL, AD-OPT-OUT, AD-DELIVERY-FAILURE',
    example:
      "Sharwin Academy: a session is uncovered. Saturday 8:30am Advanced — Vinod declined, nobody has claimed it, starts in 15 minutes.",
  },
  admin_digest: {
    name: 'admin_digest',
    category: 'utility',
    language: 'en',
    params: ['academy', 'event', 'detail'],
    body: '{academy}: {event}. {detail}',
    quickReply: 'Open',
    covers: 'brief, digest — AD-MORNING-BRIEF, AD-EVENING-DIGEST',
    example:
      "Sharwin Academy: this evening's digest. 4 sessions ran, 38 of 41 present, ₹12,000 collected, 2 registers still unmarked.",
  },
}

export const TEMPLATE_NAMES: TemplateName[] = Object.keys(TEMPLATES) as TemplateName[]

export function isTemplateName(x: unknown): x is TemplateName {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, x)
}

export function templateParams(name: TemplateName): string[] {
  return TEMPLATES[name].params.slice()
}

/**
 * Meta rejects template parameters containing newlines, tabs, or four-plus consecutive
 * spaces, and truncates nothing for you. Sanitising the value is not the same as truncating
 * a button title: the parameter is prose the model wrote, and collapsing its whitespace
 * changes no meaning.
 */
export function sanitizeParam(value: string, max = 700): string {
  const flat = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * The body the emulator shows and the wire carries. Missing parameters throw rather than
 * rendering "{detail}" at a parent: a template that cannot render is a bug, and §17's rule
 * is that it does not ship.
 */
export function renderTemplate(name: TemplateName, params: Record<string, string>): string {
  const def = TEMPLATES[name]
  if (!def) throw msgError('unknown_template', `no such template: ${String(name)}`)

  const missing = def.params.filter((p) => {
    const v = params[p]
    return v === undefined || v === null || String(v).trim() === ''
  })
  if (missing.length) {
    throw msgError(
      'template_param_missing',
      `template ${name} needs ${def.params.join(', ')} — missing ${missing.join(', ')}`,
    )
  }

  return def.body.replace(/\{(\w+)\}/g, (_m, key: string) => sanitizeParam(String(params[key])))
}

/** Ordered positional parameters for the Cloud API body component ({{1}}, {{2}}, …). */
export function templateWireParams(name: TemplateName, params: Record<string, string>): string[] {
  const def = TEMPLATES[name]
  if (!def) throw msgError('unknown_template', `no such template: ${String(name)}`)
  return def.params.map((p) => {
    const v = params[p]
    if (v === undefined || v === null || String(v).trim() === '') {
      throw msgError('template_param_missing', `template ${name} is missing parameter ${p}`)
    }
    return sanitizeParam(String(v))
  })
}

// `templateDigest()` used to sit here — a pipe-table rendering of the eight, described
// as "the approval-submission view" and "readable in the emulator's fault panel". It was
// neither: nothing called it. The catalog's own `catalogDigest()` is what reaches the
// prompt, and `TEMPLATES` below is what an approval submission would be built from.

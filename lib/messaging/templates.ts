/**
 * lib/messaging/templates.ts — the eight §16.2 templates.
 *
 * @mechanism TEMPLATES — eight frozen bodies, one per CATEGORY of unsolicited contact rather
 *   than one per feature, so ~35 catalog rows ride on eight approvals and a new in-window
 *   interaction costs none. Their shape is load-bearing, not style: a label frame (`For:`,
 *   `Change:`) because no frozen word may conjugate with a parameter it cannot see, ~16 fixed
 *   words around 4 parameters because Meta rejects a higher ratio outright, and a lead-in
 *   naming only the SENDER so two notifications to one parent never open identically.
 *   Closes F-G, F-AZ.
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
 *
 * THE PARAMETER-TO-WORDS RATIO
 * -----------------------------------------------------------------------------
 * These bodies used to be almost nothing but parameters — `{academy}: {who} —
 * {event}. {detail}`, four variables and one word of fixed text. That is the
 * purest expression of "structured parameters holding real content", and Meta
 * rejects it outright. All eight, on the first submission:
 *
 *     code=100 subcode=2388293
 *     "Parameters words ratio exceeds limit — This template has too many
 *      variables for its length."
 *
 * The rule is not documented as a number, so it was measured against the live
 * endpoint: a body with **16 fixed words around 4 parameters is accepted**. The
 * shapes below sit at or above that, and a new template must too.
 *
 * The fixed text this forces is not filler, and it must not become the vague
 * clickbait described above — "you have an update" would now pass the ratio and
 * fail the category. What it buys instead is a **label frame**: `For:`, `Change:`,
 * `Details:`. A label followed by a colon is the one kind of fixed word that can
 * precede a parameter without agreeing with it — which is exactly what the
 * conjugation rule below demands, and the previous dash frame achieved by having
 * no words at all. So the ratio and the grammar constraint resolve together, and
 * the parameters still carry every piece of real content.
 *
 * ONE AUTHOR PER SUBJECT
 * -----------------------------------------------------------------------------
 * **Every lead-in used to name the subject, and so did the body.** *"Ace TT
 * Academy: your day. Your Wednesday 19 August:…"* · *"Kiran has a class coming
 * up. Kiran has Beginners Wednesday at 6:30pm"* · *"still need your confirmation.
 * Still need to know about Intermediate"* — every out-of-window send said its
 * subject twice, because the frozen text and the composed text each carried it
 * (F-G). And because the frozen half is the same for every send in its category,
 * one contact held **four** rows of *"Message from Baseline Tennis about a change
 * to a session."*: a parent with two children in two classes got four
 * notifications that opened identically and no reason to open the fourth (F-AZ).
 *
 * So the lead-in names the SENDER and nothing else. Everything that
 * differentiates one notification from another — whose it is, what happened, when
 * — is in the parameters, which is where it was always meant to be and where the
 * §16.2 rule about "structured parameters holding real content" actually points.
 * The word ratio moves into the sign-off, which touches no parameter and so can
 * be ordinary English at any length.
 *
 * `coach_schedule` gained a `{who}` in the same pass. It was the one template
 * with no subject parameter at all, so a coach's notification could never name
 * the session it was about — the purest form of the same defect.
 *
 * These bodies are frozen at approval, so changing them means resubmitting all
 * eight. That is the cost of the fix and it is paid once.
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
  /**
   * The same example, split per parameter — because Meta will not approve a template
   * without one.
   *
   * `example` above is the rendered sentence, which reads well and proves the body
   * scans; the Cloud API's `components[].example.body_text` wants the *arguments*
   * that produce it, in `params` order. Deriving one from the other would mean
   * parsing the sentence back through the body's own placeholders — so the split is
   * written down once, here, next to the sentence it must agree with.
   *
   * Keyed by parameter name rather than positional, so it cannot silently
   * disagree with `params` when a template gains or loses one: the submission
   * builder maps through `params` and throws on a missing key.
   */
  exampleParams: Record<string, string>
}

export const TEMPLATES: Record<TemplateName, TemplateDef> = {
  session_reminder: {
    name: 'session_reminder',
    category: 'utility',
    language: 'en',
    params: ['academy', 'who', 'event', 'detail'],
    // The label frame, not `{who} has {event}` — a verb in a FROZEN body agrees
    // with a parameter it cannot see. `{who}` is one child or two ("Ananya and
    // Dev", the sibling merge working as designed), and the approved text
    // cannot conjugate: "Ananya and Dev has a class coming up" shipped to a
    // real parent. The rule this encodes: no verb, article or preposition in a
    // template body whose correct form depends on what a parameter will carry.
    //
    // `For:` is that rule and the ratio rule at once — a label agrees with
    // nothing, and it is fixed text. The lead and sign-off sentences never touch
    // a parameter either, so they are free to be ordinary English.
    body:
      'Message from {academy}.\n\n' +
      'For: {who}\nSession: {event}\nDetails: {detail}\n\n' +
      'Open this in your chat with them to read it all and reply there.',
    quickReply: 'See the details',
    covers: 'client reminders — CL-REMINDER, CL-FIRST-CONTACT, CL-INTRO, PR-WELCOME',
    example:
      'Message from Sharwin Academy.\n\nFor: Aarav\nSession: Beginners Batch, tomorrow 6:30pm\nDetails: Green Park, with Coach Vinod.\n\nOpen this in your chat with them to read it all and reply there.',
    exampleParams: {
      academy: 'Sharwin Academy',
      who: 'Aarav',
      event: 'Beginners Batch tomorrow',
      detail: '6:30–7:30pm at Green Park, with Coach Vinod.',
    },
  },
  session_change: {
    name: 'session_change',
    category: 'utility',
    language: 'en',
    params: ['academy', 'who', 'event', 'detail'],
    body:
      'Message from {academy}.\n\n' +
      'For: {who}\nChange: {event}\nDetails: {detail}\n\n' +
      'Open this in your chat with them to read it all and reply there.',
    quickReply: 'See the details',
    covers:
      'cancelled, moved, coach changed — CL-SESSION-CANCELLED, CL-SESSION-MOVED, CL-SESSION-TROUBLE, CL-CANCEL-CONFIRM, PR-TRIAL-CONFIRMED',
    example:
      "Message from Sharwin Academy.\n\nFor: Meera\nChange: Saturday's Advanced Batch has moved\nDetails: Now 8:30–10:00am at Green Park, from this Saturday.\n\nOpen this in your chat with them to read it all and reply there.",
    exampleParams: {
      academy: 'Sharwin Academy',
      who: 'Meera',
      event: "Saturday's Advanced Batch has moved",
      detail: 'Now 8:30–10:00am at Green Park, from this Saturday.',
    },
  },
  session_outcome: {
    name: 'session_outcome',
    category: 'utility',
    language: 'en',
    params: ['academy', 'who', 'event', 'detail'],
    body:
      'Message from {academy}.\n\n' +
      'For: {who}\nOutcome: {event}\nDetails: {detail}\n\n' +
      'Open this in your chat with them to read it all and reply there.',
    quickReply: 'See the details',
    covers: 'attended/missed with note — CL-OUTCOME',
    example:
      'Message from Sharwin Academy.\n\nFor: Aarav\nOutcome: missed Beginners Batch today\nDetails: Coach Vinod kept his spot for Friday.\n\nOpen this in your chat with them to read it all and reply there.',
    exampleParams: {
      academy: 'Sharwin Academy',
      who: 'Aarav',
      event: 'missed Beginners Batch today',
      detail: 'Coach Vinod kept his spot for Friday.',
    },
  },
  payment_due: {
    name: 'payment_due',
    category: 'utility',
    language: 'en',
    params: ['academy', 'who', 'event', 'detail'],
    // "the payments on your account", not "the amount due" — this one covers
    // receipts as well as dunning (see `covers`), and a FROZEN body that says
    // money is owed cannot be used to say money was received.
    body:
      'Message from {academy}, about your account with them.\n\n' +
      'For: {who}\nUpdate: {event}\nDetails: {detail}\n\n' +
      'Open this in your chat with them to read it all and reply there.',
    quickReply: 'See the lines',
    covers: 'tally, dunning, receipts — CL-TALLY, CL-DUNNING, CL-RECEIPT',
    example:
      "Message from Sharwin Academy, about your account with them.\n\nFor: Aarav\nUpdate: October's tally is ready\nDetails: 8 sessions, ₹4,000, due 5 Nov.\n\nOpen this in your chat with them to read it all and reply there.",
    exampleParams: {
      academy: 'Sharwin Academy',
      who: 'Aarav',
      event: "October's tally is ready",
      detail: '8 sessions, ₹4,000, due 5 Nov.',
    },
  },
  coach_schedule: {
    name: 'coach_schedule',
    category: 'utility',
    language: 'en',
    params: ['academy', 'who', 'event', 'detail'],
    // "a session on your schedule" / "Change:", not "your schedule" / "Update:".
    // The first wording went up as UTILITY and Meta returned it as MARKETING —
    // the category is decided by how the text READS, and "an update about your
    // schedule" reads like a bulletin, while a named session that has changed
    // reads like the transaction it actually is. That re-pricing is §16.1's whole
    // concern, so the wording is load-bearing, not cosmetic.
    body:
      'Message from {academy}.\n\n' +
      'For: {who}\nChange: {event}\nDetails: {detail}\n\n' +
      'Open this in your chat with them to read it all and reply there.',
    quickReply: 'Open my day',
    covers:
      'the day, cover offers, statements — CO-DAY, CO-COVER-OFFER, CO-COVER-TAKEN, CO-PAYABLES, CO-FINAL-STATEMENT',
    example:
      'Message from Sharwin Academy.\n\nFor: Advanced Batch\nChange: Saturday 8:30am needs cover\nDetails: Green Park — first to claim it takes it.\n\nOpen this in your chat with them to read it all and reply there.',
    exampleParams: {
      academy: 'Sharwin Academy',
      who: 'Advanced Batch',
      event: 'Saturday 8:30am needs cover',
      detail: 'Green Park — first to claim it takes it.',
    },
  },
  coach_prompt: {
    name: 'coach_prompt',
    category: 'utility',
    language: 'en',
    params: ['academy', 'event', 'detail'],
    body:
      'Message from {academy}.\n\n' +
      'Task: {event}\nDetails: {detail}\n\n' +
      'Open this in your chat with them to read it all and reply there.',
    quickReply: 'Open',
    // CO-INVITE is why a coach can be reached at all before they have ever
    // written in: the invite is now a bot-initiated send, so it is out of window
    // by definition and this is the approval that carries it. No ninth template.
    covers:
      'the invite, coming, nudge, register, invite check — CO-INVITE, CO-COMING, CO-NUDGE, CO-REGISTER, CO-INVITE-CONFIRM',
    example:
      'Message from Sharwin Academy.\n\nTask: take the register for Beginners Batch\nDetails: 6:30pm today at Green Park, 11 players enrolled.\n\nOpen this in your chat with them to read it all and reply there.',
    exampleParams: {
      academy: 'Sharwin Academy',
      event: 'take the register for Beginners Batch',
      detail: '6:30pm today at Green Park, 11 players enrolled.',
    },
  },
  admin_alert: {
    name: 'admin_alert',
    category: 'utility',
    language: 'en',
    params: ['academy', 'event', 'detail'],
    body:
      'Message from {academy}.\n\n' +
      'Issue: {event}\nDetails: {detail}\n\n' +
      'Open this in your chat with them to read it all and reply there.',
    quickReply: 'Open',
    covers:
      'every escalation — AD-ESCALATE-UNCONFIRMED, AD-COACH-LATE, AD-COACH-NOT-ONBOARDED, AD-REGISTER-MISSING, AD-RECONCILE, AD-NEW-TRIAL, AD-OPT-OUT, AD-DELIVERY-FAILURE, AD-NEEDS-YOU',
    example:
      "Message from Sharwin Academy.\n\nIssue: Saturday 8:30am Advanced is uncovered\nDetails: Vinod declined, nobody has claimed it, starts in 15 minutes.\n\nOpen this in your chat with them to read it all and reply there.",
    exampleParams: {
      academy: 'Sharwin Academy',
      event: 'Saturday 8:30am Advanced is uncovered',
      detail: 'Vinod declined, nobody has claimed it, starts in 15 minutes.',
    },
  },
  admin_digest: {
    name: 'admin_digest',
    category: 'utility',
    language: 'en',
    params: ['academy', 'event', 'detail'],
    body:
      'Message from {academy}.\n\n' +
      'Summary: {event}\nDetails: {detail}\n\n' +
      'Open this in your chat with them to read it all and reply there.',
    quickReply: 'Open',
    covers: 'brief, digest — AD-MORNING-BRIEF, AD-EVENING-DIGEST',
    example:
      "Message from Sharwin Academy.\n\nSummary: Tuesday evening, 4 sessions\nDetails: 38 of 41 present, ₹12,000 collected, 2 registers still unmarked.\n\nOpen this in your chat with them to read it all and reply there.",
    exampleParams: {
      academy: 'Sharwin Academy',
      event: 'Tuesday evening, 4 sessions',
      detail: '38 of 41 present, ₹12,000 collected, 2 registers still unmarked.',
    },
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
 *
 * @mechanism sanitizeParam — the one place a composed body becomes a template parameter, so
 *   the wire's whitespace rules are obeyed without a caller knowing them. A line break
 *   becomes a ` · ` separator rather than a space, because flattening a list with spaces
 *   runs its items into one sentence; only bullet characters are absorbed after the break,
 *   since a hyphen there is as often a minus sign or a wrapped range.
 */
/**
 * How much of a composed body survives becoming a template parameter.
 *
 * Exported so the sentence that TELLS the model about it (`windowRightHere`,
 * lib/agent/context.ts) is bound to the same number that enforces it. A budget
 * stated in a prompt and defined in a function is two numbers, and the prompt's
 * one is the one nobody updates.
 */
export const PARAM_MAX_CHARS = 700

export function sanitizeParam(value: string, max = PARAM_MAX_CHARS): string {
  // The wire forbids newlines in a parameter, so a multi-line body has to
  // flatten — but a space erases the structure a list carried ("unpaid: •
  // Rajesh (₹6000) • Latha (₹2500)" ran together, F-G). A line break becomes a
  // separator instead, and a bullet that led the next line is dropped rather
  // than doubled.
  // The absorption class holds BULLET characters only: a hyphen after a line
  // break is as often a minus sign or the dash of a wrapped range as it is a
  // bullet, and eating it changes meaning (review find, verified by execution).
  const flat = String(value ?? '')
    .replace(/\s*[\r\n]+\s*(?:[•·▪]\s+)?/g, ' · ')
    .replace(/\t+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^·\s*/, '')
    .replace(/\s*·$/, '')
  if (flat.length <= max) return flat
  const cut = flat.slice(0, max - 1)
  const lastSpace = cut.lastIndexOf(' ')
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}

/**
 * The body the emulator shows and the wire carries. Missing parameters throw rather than
 * rendering "{detail}" at a parent: a template that cannot render is a bug, and §17's rule
 * is that it does not ship.
 *
 * @mechanism renderTemplate — a missing or blank parameter throws by name here and in
 *   `templateWireParams`, so an out-of-window send fails loudly at compose time instead of
 *   putting a literal "{detail}" on a parent's phone. Both the emulator's rendering and the
 *   wire's arguments come out of the same definition through the same check, which is what
 *   makes §17's "works here, works there" true of templates.
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

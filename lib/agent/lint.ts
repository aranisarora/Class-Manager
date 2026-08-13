/**
 * lib/agent/lint.ts — Layer 5 (§4.5). Deterministic repair on generated output.
 *
 * Every pass here is a string operation, because "is it a string operation?" is
 * the whole test for belonging in this layer:
 *
 *   0. rewrite Markdown into WhatsApp's markup — the surface has one asterisk
 *      for bold, no headings, and no link syntax at all
 *   1. strip internal identifiers — uuids and table/column names
 *   2. rewrite machine timestamps into the academy's timezone and idiom
 *   3. downgrade claims the system cannot back — "delivered" where only
 *      `sent_at` is known
 *   4. rewrite product vocabulary the academy's memory says they do not use into
 *      the word they do use (doctrine rule 3)
 *
 * NUMBER-GROUNDING IS DELIBERATELY NOT HERE, and must not be added.
 * -----------------------------------------------------------------------------
 * Tracing every numeral in generated prose back to a query result is an
 * attribution problem, not a regex. There is no string operation that can tell
 * "14 enrollments" (must trace to a row count) from a date, a time, an age, a
 * price, a phone number, a jersey size or "three weeks" — so any implementation
 * here either false-positives on ordinary English or passes everything and
 * provides false assurance, which is worse. It is a prompt rule (§10.2: every
 * number traces to a query result in the payload) verified by eval (§17).
 */
import type { Identity } from '@/lib/types'
import { inZone, nowSync } from '@/lib/clock'

/** What the caller actually has evidence for, from the `message` row's own columns. */
export type DeliveryEvidence = { delivered?: boolean; read?: boolean }

export function lint(text: string, id: Identity, evidence?: DeliveryEvidence): string {
  if (!text) return text
  const tz = id.academy?.timezone || 'Asia/Kolkata'

  // Links are minted elsewhere and are opaque: a signed token is full of
  // underscores and dashes and would be shredded by the identifier pass. Park
  // them, run the four passes, put them back.
  const parked: string[] = []
  let out = text.replace(/https?:\/\/\S+/g, (m) => {
    parked.push(m)
    return `[[LINK${parked.length - 1}]]`
  })

  out = toWhatsAppMarkup(out)
  out = stripDoctrineRefs(out)
  out = stripIdentifiers(out, id)
  out = rewriteTimestamps(out, tz)
  out = downgradeClaims(out, evidence)
  out = applyVocabulary(out, id.academy?.memory ?? null)

  out = out.replace(/\[\[LINK(\d+)\]\]/g, (_m, i: string) => parked[Number(i)] ?? '')
  return tidy(out)
}

// -----------------------------------------------------------------------------
// 0a. markdown that is not this surface's markup
// -----------------------------------------------------------------------------

/**
 * The model writes Markdown, because everything it has ever read was Markdown.
 * WhatsApp is not Markdown: bold is `*one*` asterisk, there are no headings, and
 * `[label](url)` renders as the literal characters `[label](url)`.
 *
 * Left alone, the very first thing a new admin was shown read:
 *
 *   `* **Beginners:** Monday, Wednesday, Friday, 6:30pm - 7:30pm`
 *
 * — which is correct information wearing four wrong characters, on the screen
 * where the product makes its first impression. It is the same class as an ISO
 * timestamp or a table name: right, and not the language of the surface it
 * landed on. Which is exactly what makes it a lint rule rather than a prompt
 * one — it is a string operation, and a model under pressure will always
 * eventually reach for `**`.
 *
 * Runs first, so a heading rewritten to bold is still bold after the passes
 * below have taken their punctuation out.
 */
function toWhatsAppMarkup(text: string): string {
  return (
    text
      // Fenced code and inline code survive as-is: WhatsApp has both.
      // `## Heading` → bold on its own line. Headings do not exist here.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_m, body: string) => `*${String(body).trim()}*`)
      // `**bold**` / `__bold__` → the one-character forms.
      // Bounded to one line on purpose: an unbalanced `**` must not swallow the
      // rest of the message looking for its partner.
      .replace(/\*\*\*([^\n*]+?)\*\*\*/g, '_*$1*_')
      .replace(/\*\*([^\n*]+?)\*\*/g, '*$1*')
      .replace(/__([^\n_]+?)__/g, '_$1_')
      // `* item` / `- item` at the start of a line → a real bullet. An asterisk
      // there is indistinguishable from an unclosed bold marker.
      .replace(/^[ \t]*[*+-][ \t]+/gm, '• ')
      // `[label](https://…)` — parked as [[LINKn]] by now — renders literally.
      .replace(/\[([^\]\n]+)\]\(\s*(\[\[LINK\d+\]\])\s*\)/g, '$1: $2')
      // A horizontal rule is a Markdown idea.
      .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
  )
}

// -----------------------------------------------------------------------------
// 0. doctrine references
// -----------------------------------------------------------------------------

/**
 * The whole spec is in the prompt, so its section numbers are part of the model's
 * working vocabulary — and they leak. A parent was told "nobody is messaged (§2.6)";
 * an internal citation, on WhatsApp, cited at someone who has never seen the
 * document. It is the same class as a uuid in a message: correct, and not English.
 *
 * Runs before the identifier pass so a stripped "(§14.2)" cannot leave stray
 * punctuation for the later passes to tidy around.
 */
function stripDoctrineRefs(text: string): string {
  return text
    // "(§2.6)" / "[§14.2.1]" / "(see §4.3)" — the whole bracket goes.
    .replace(/[([]\s*(?:see\s+)?§+\s*\d+(?:\.\d+)*\s*[)\]]/gi, '')
    // "§16.3" bare, and "per §7.2" / "under §7.2" with its preposition.
    .replace(/\b(?:per|under|see|as per)\s+§+\s*\d+(?:\.\d+)*/gi, '')
    .replace(/§+\s*\d+(?:\.\d+)*/g, '')
    // "rule 10" only when it was hanging off a section reference we just removed.
    .replace(/\s+,/g, ',')
}

// -----------------------------------------------------------------------------
// 1. identifiers
// -----------------------------------------------------------------------------

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/

/** §6 table names. Anything qualified by one of these is machinery, not English. */
const TABLES = [
  'academy', 'venue', 'person', 'contact', 'account', 'player', 'coach',
  'academy_admin', 'memory_fact', 'class', 'class_slot', 'class_coach',
  'enrollment', 'session', 'session_coach', 'attendance', 'tally_line',
  'payment', 'sender', 'message', 'action', 'view_spec', 'job', 'audit_entry',
  'recipe', 'turn', 'sim_clock', 'sim_fault',
]

/** Table names with no natural English reading of their own. */
const TABLE_WORDS: Record<string, string> = {
  academy_admin: 'admin',
  memory_fact: 'note',
  class_slot: 'weekly time',
  class_coach: 'coach assignment',
  session_coach: 'coach assignment',
  tally_line: 'line on the bill',
  view_spec: 'page',
  audit_entry: 'change record',
  sim_clock: 'clock',
  sim_fault: 'fault',
}

/**
 * Column values the schema spells in quotes. The model quotes them back —
 * *"we can set Shuttle Point to 'live'"* — and a quoted lowercase token on
 * WhatsApp reads as a setting in a system rather than as English. Unquoting is
 * the whole repair: "set Shuttle Point to live" is what a person would have
 * said, and the word survives.
 */
const STATE_WORDS =
  /'(setup|roster|ready|live|added|invited|active|ended|prospect|registered|engaged|opted_out|scheduled|cancelled|completed|present|late|absent|cancelled_timely|queued|sent|delivered|read|failed|requested|confirmed)'/g

function stripIdentifiers(text: string, id: Identity): string {
  let out = text.replace(STATE_WORDS, '$1')

  // "(id: 7f3…)", "[session_id=7f3…]" — the whole parenthetical is machinery.
  out = out.replace(
    new RegExp(`\\s*[(\\[][^()\\[\\]]{0,40}${UUID.source}[^()\\[\\]]{0,10}[)\\]]`, 'g'),
    '',
  )
  // Bare uuids, and any label immediately in front of one.
  out = out.replace(
    new RegExp(`(?:\\b[\\w.]{0,24}\\s*[:=]\\s*)?${UUID.source}`, 'g'),
    '',
  )

  // table.column -> the column, humanised. "session.starts_at" -> "start time".
  out = out.replace(
    new RegExp(`\\b(${TABLES.join('|')})\\.([a-z_]+)\\b`, 'g'),
    (_m, _t: string, col: string) => humanise(col),
  )

  // Multi-word table names standing on their own.
  for (const [table, word] of Object.entries(TABLE_WORDS)) {
    out = out.replace(new RegExp(`\\b${table}s?\\b`, 'gi'), (m) =>
      m.endsWith('s') && !m.endsWith('ss') ? `${word}s` : word,
    )
  }

  // §6.1 / §18.4 — "academy" is a table name AND the one word that appears
  // nowhere a user can see. Their own name for the business goes in instead.
  const businessName = id.academy?.name
  if (businessName) {
    out = out.replace(/\b(?:the|your|our|this)\s+academ(?:y|ies)\b/gi, businessName)
    out = out.replace(/\bacadem(?:y|ies)\b/g, businessName)
  }

  // Anything else still shaped like an identifier: rate_amount, last_inbound_at,
  // per_session. Humanising keeps the meaning and loses the machinery.
  out = out.replace(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g, (m) => humanise(m))

  return out
}

const COLUMN_WORDS: Record<string, string> = {
  id: '',
  starts_at: 'start time',
  ends_at: 'end time',
  started_on: 'start date',
  ended_on: 'end date',
  starts_on: 'start date',
  ends_on: 'end date',
  confirmed_at: 'confirmation',
  declined_at: 'decline',
  arrived_at: 'arrival',
  marked_at: 'the time it was marked',
  last_inbound_at: 'their last message',
  opted_out_at: 'opt-out',
  full_name: 'name',
  phone_e164: 'number',
  rate_amount: 'rate',
  rate_unit: 'rate',
  pay_amount: 'pay',
  cancellation_window_hours: 'cancellation window',
  client_reminder_lead_hours: 'reminder lead time',
  cancelled_timely: 'cancelled in time',
  running_late: 'running late',
  idempotency_key: '',
  wa_message_id: '',
  academy_id: '',
  person_id: '',
  contact_id: '',
  session_id: '',
  player_id: '',
  account_id: '',
  class_id: '',
  coach_id: '',
}

function humanise(token: string): string {
  if (token in COLUMN_WORDS) return COLUMN_WORDS[token]
  return token.replace(/_/g, ' ')
}

// -----------------------------------------------------------------------------
// 2. timestamps
// -----------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const ISO =
  /\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?\s*(Z|[+-]\d{2}:?\d{2})?)?\b/g

/**
 * The idiom pass the ISO pass never covered.
 *
 * The rule is "their timezone and their idiom — 'tomorrow 6:30pm', 'Sat 8am'", and
 * an ISO string is only the most obvious way to break it. A model writing English
 * reaches for "Monday, August 17th at 6:00 PM", which is not wrong, not an ISO
 * timestamp, and not how anyone in Bangalore writes a time to a parent. It arrives
 * looking like software.
 */
function localiseEnglishDates(text: string): string {
  const MONTHS_LONG: Record<string, string> = {
    january: 'Jan', february: 'Feb', march: 'Mar', april: 'Apr', may: 'May', june: 'Jun',
    july: 'Jul', august: 'Aug', september: 'Sep', october: 'Oct', november: 'Nov', december: 'Dec',
  }
  return (
    text
      // "6:00 PM" -> "6pm", "6:30 PM" -> "6:30pm". Also "6 PM".
      .replace(/\b(\d{1,2}):(\d{2})\s*([APap])\.?[Mm]\.?/g, (_m, h, mm, ap) =>
        `${Number(h)}${mm === '00' ? '' : `:${mm}`}${ap.toLowerCase()}m`,
      )
      .replace(/\b(\d{1,2})\s+([APap])\.?[Mm]\.?/g, (_m, h, ap) => `${Number(h)}${ap.toLowerCase()}m`)
      // "August 17th" / "August 17, 2026" -> "17 Aug"
      .replace(
        /\b([A-Z][a-z]{2,8})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*\d{4})?/g,
        (whole, month: string, day: string) => {
          const short = MONTHS_LONG[month.toLowerCase()]
          return short ? `${Number(day)} ${short}` : whole
        },
      )
      // "Monday, 17 Aug" -> "Mon 17 Aug"
      .replace(
        /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+(?=\d{1,2}\s+[A-Z][a-z]{2}\b)/g,
        (_m, day: string) => `${day.slice(0, 3)} `,
      )
  )
}

function rewriteTimestamps(text: string, tz: string): string {
  const today = inZone(nowSync(), tz)
  return localiseEnglishDates(text).replace(ISO, (whole, y, mo, d, hh, mm, _ss, off) => {
    if (hh === undefined) {
      // A calendar date. Converting a bare date between zones would move the day,
      // so it is formatted where it stands.
      return dateIdiom(`${y}-${mo}-${d}`, null, today.date)
    }
    const iso = `${y}-${mo}-${d}T${hh}:${mm}:00${off ? String(off) : 'Z'}`
    const parsed = new Date(iso)
    if (Number.isNaN(parsed.getTime())) return whole
    const local = inZone(parsed, tz)
    return dateIdiom(local.date, local.time, today.date)
  })
}

/** "18:30" -> "6:30pm", "08:00" -> "8am". Tolerates a clock that already formats. */
function timeIdiom(time: string | null): string {
  if (!time) return ''
  const t = time.trim()
  const m = t.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return t.replace(/\s+/g, '').toLowerCase()
  if (/[ap]\.?m/i.test(t)) return t.replace(/\s+/g, '').toLowerCase()
  const h24 = Number(m[1])
  const min = m[2]
  const suffix = h24 < 12 ? 'am' : 'pm'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return min === '00' ? `${h12}${suffix}` : `${h12}:${min}${suffix}`
}

function dateIdiom(date: string, time: string | null, todayDate: string): string {
  const t = timeIdiom(time)
  const diff = dayDiff(todayDate, date)
  const join = (label: string) => (t ? `${label} ${t}` : label)
  if (diff === 0) return join('today')
  if (diff === 1) return join('tomorrow')
  if (diff === -1) return join('yesterday')
  const [y, mo, d] = date.split('-')
  const weekday = WEEKDAYS[weekdayOf(date)]
  if (diff > 1 && diff <= 6) return join(weekday)
  if (diff < -1 && diff >= -6) return join(`last ${weekday}`)
  const sameYear = todayDate.slice(0, 4) === y
  const stamp = `${Number(d)} ${MONTHS[Number(mo) - 1] ?? mo}${sameYear ? '' : ` ${y}`}`
  return join(stamp)
}

function dayDiff(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`)
  const b = Date.parse(`${toIso}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

function weekdayOf(isoDate: string): number {
  const t = Date.parse(`${isoDate}T00:00:00Z`)
  return Number.isNaN(t) ? 0 : new Date(t).getUTCDay()
}

// -----------------------------------------------------------------------------
// 3. claims the system cannot back (§2.4)
// -----------------------------------------------------------------------------

function downgradeClaims(text: string, evidence?: DeliveryEvidence): string {
  let out = text

  if (!evidence?.read) {
    // "she has read it", "it was seen", "they've opened it"
    out = out.replace(
      /\b(has|have|had|was|were|been|is|are|'ve|'s)\s+(read|seen|opened)\b/gi,
      (_m, aux: string) => `${aux} sent`,
    )
    out = out.replace(/\bread receipts?\b/gi, 'delivery status')
  }
  if (!evidence?.delivered) {
    out = out.replace(/\bdeliver(?:ed|y confirmed)\b/gi, (m) =>
      m[0] === m[0].toUpperCase() ? 'Sent' : 'sent',
    )
  }
  return out
}

// -----------------------------------------------------------------------------
// 4. their words, not ours (doctrine rule 3)
// -----------------------------------------------------------------------------

export type VocabularyPreference = { prefer: string; avoid: string }

const VOCAB_PATTERNS: RegExp[] = [
  // "Calls them batches, not classes."
  /\bcalls?\s+(?:them|it|these|those)?\s*["“']?([A-Za-z][\w '-]{1,24}?)["”']?\s*,?\s+not\s+["“']?([A-Za-z][\w '-]{1,24}?)["”']?(?=[.;,)\n]|$)/gi,
  // "Uses 'batch' instead of 'class'." / "Prefers batches over classes."
  /\b(?:uses?|says?|prefers?)\s+["“']?([A-Za-z][\w '-]{1,24}?)["”']?\s+(?:instead of|rather than|over|not)\s+["“']?([A-Za-z][\w '-]{1,24}?)["”']?(?=[.;,)\n]|$)/gi,
]

/**
 * Reads vocabulary preferences out of an academy memory hot set. Shared with
 * `variableTail`, so the prompt tells the model their words and the lint fixes
 * it up when the model forgets anyway.
 */
export function vocabularyPreferences(memory: string | null | undefined): VocabularyPreference[] {
  if (!memory) return []
  const found: VocabularyPreference[] = []
  const seen = new Set<string>()
  for (const pattern of VOCAB_PATTERNS) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(memory)) !== null) {
      const prefer = m[1].trim()
      const avoid = m[2].trim()
      if (prefer.length < 2 || avoid.length < 2) continue
      if (prefer.toLowerCase() === avoid.toLowerCase()) continue
      const key = avoid.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ prefer, avoid })
    }
  }
  return found
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function matchCase(sample: string, replacement: string): string {
  if (sample === sample.toUpperCase() && sample.length > 1) return replacement.toUpperCase()
  if (sample[0] === sample[0]?.toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1)
  }
  return replacement
}

function applyVocabulary(text: string, memory: string | null): string {
  let out = text
  for (const { prefer, avoid } of vocabularyPreferences(memory)) {
    for (const [from, to] of variants(avoid, prefer)) {
      out = out.replace(new RegExp(`\\b${escapeRe(from)}\\b`, 'gi'), (m) => matchCase(m, to))
    }
  }
  return out
}

/** "classes"/"class" both get rewritten, to the matching form of their word. */
function variants(avoid: string, prefer: string): [string, string][] {
  const pairs: [string, string][] = [[avoid, prefer]]
  const plural = (w: string) => (/(s|x|z|ch|sh)$/i.test(w) ? `${w}es` : `${w}s`)
  const singular = (w: string) =>
    /ies$/i.test(w) ? `${w.slice(0, -3)}y` : /(?:ses|xes|zes|ches|shes)$/i.test(w) ? w.slice(0, -2) : w.replace(/s$/i, '')

  if (/s$/i.test(avoid)) {
    pairs.push([singular(avoid), /s$/i.test(prefer) ? singular(prefer) : prefer])
  } else {
    pairs.push([plural(avoid), /s$/i.test(prefer) ? prefer : plural(prefer)])
  }
  return pairs.filter(([f, t]) => f.length > 1 && t.length > 0 && f.toLowerCase() !== t.toLowerCase())
}

// -----------------------------------------------------------------------------

function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

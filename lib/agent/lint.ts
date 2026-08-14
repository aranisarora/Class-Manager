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
import { inZone, nowSync } from '@/lib/clock'
import { compactDate } from '@/lib/format'

/** What the caller actually has evidence for, from the `message` row's own columns. */
export type DeliveryEvidence = { delivered?: boolean; read?: boolean }

/**
 * The only part of an `Identity` this file has ever read: the business's name, its
 * timezone and its vocabulary memory.
 *
 * The wider parameter was the reason lint could not live at the send path. `send`
 * holds a `SessionCtx`, not an `Identity`, so every caller that had one applied lint
 * itself and every caller that did not simply skipped it — which is how "speak the
 * academy's language" became a guarantee that depended on which code path composed
 * the message. Narrowing the parameter to what is actually used is what makes the
 * chokepoint reachable. `Identity` still satisfies it structurally, so no existing
 * caller changes.
 */
export type LintScope = {
  academy?: { name?: string | null; timezone?: string | null; memory?: string | null } | null
}

/**
 * `deliveryClaims: false` turns off the two passes that weaken a claim about whether a
 * message was delivered or read.
 *
 * Those passes are aimed at a MODEL asserting something about ONE message it cannot
 * know — *"she's read it"* — and they are right for that. At the send chokepoint they
 * are wrong twice over. Nothing has been delivered yet, so `evidence` is always absent
 * and they always fire; and the traffic that only reaches `send` is runtime-composed,
 * where "delivered" and "read" are counts computed from `message.status`. The admin's
 * evening digest came out saying *"9 were sent and 4 have been sent"* over numbers that
 * meant delivered and read — the delivery-health line, with its own health rewritten
 * out of it.
 *
 * The model path is unaffected: the `reply` tool lints before the message ever reaches
 * `send`, so a model claim is still checked exactly once, on the way in. It passes no
 * evidence — nothing has been delivered at compose time either — so both passes fire
 * there, which is the right direction for a claim nobody can back yet.
 */
export type LintOptions = { deliveryClaims?: boolean }

export function lint(
  text: string,
  id: LintScope,
  evidence?: DeliveryEvidence,
  opts?: LintOptions,
): string {
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
  if (opts?.deliveryClaims !== false) out = downgradeClaims(out, evidence)
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
/**
 * A Markdown pipe table, turned into lines WhatsApp can actually draw.
 *
 * WhatsApp's markup is bold, italic, strikethrough, monospace, inline code,
 * bulleted and numbered lists, and block quotes. There is no table. A model
 * asked for a roster reaches for one anyway, and an admin was shown:
 *
 *   | Class | Coach | Roster |
 *   |:--- |:--- |:--- |
 *   | *Beginners* | Arjun Menon | Aarav, Ananya |
 *
 * — pipes and colons, verbatim, in the message summarising their whole business.
 * It passed every check in the probe, including "no message carries raw
 * structure", because that check was looking for JSON and ids.
 *
 * **Converted rather than refused.** The information is right and the person
 * wants it; suppressing the message would leave them with nothing, and this file
 * is a rewriting pass by design. Each data row becomes a bullet led by its first
 * cell, with the remaining cells labelled from the header — which is what the
 * table was for.
 *
 * Requires two or more consecutive pipe rows AND either a `|:---|` separator or a
 * consistent column count, so a sentence that merely contains a pipe is left
 * alone. A rewriting pass that fires on prose is worse than the table it fixes.
 */
function pipeTablesToLines(text: string): string {
  const lines = text.split('\n')
  const isRow = (l: string) => /\|/.test(l) && l.trim().length > 0
  const cellsOf = (l: string) => {
    const t = l.trim().replace(/^\|/, '').replace(/\|$/, '')
    return t.split('|').map((c) => c.trim())
  }
  const isSeparator = (l: string) => cellsOf(l).every((c) => /^:?-{1,}:?$/.test(c) && c.length > 0)

  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!isRow(lines[i])) {
      out.push(lines[i])
      continue
    }
    let j = i
    while (j < lines.length && isRow(lines[j])) j++
    const run = lines.slice(i, j)
    const counts = run.map((l) => cellsOf(l).length)
    const consistent = counts.every((n) => n === counts[0] && n >= 2)
    if (run.length < 2 || !(run.some(isSeparator) || consistent)) {
      out.push(...run)
      i = j - 1
      continue
    }

    const rows = run.filter((l) => !isSeparator(l)).map(cellsOf)
    const header = run.some(isSeparator) && rows.length > 1 ? rows.shift()! : null
    for (const cells of rows) {
      const kept = cells.filter((c) => c.length > 0)
      if (!kept.length) continue
      // Already emphasised cells are left as they are — a second pair of asterisks
      // round `*Beginners*` renders as a literal asterisk, which is the bug one
      // layer down from the one being fixed.
      const lead = /[*_~]/.test(kept[0]) ? kept[0] : `*${kept[0]}*`
      const rest = kept.slice(1).map((c, k) => {
        const label = header && header[k + 1] ? `${header[k + 1]}: ` : ''
        return `${label}${c}`
      })
      out.push(rest.length ? `• ${lead} — ${rest.join(' · ')}` : `• ${lead}`)
    }
    i = j - 1
  }
  return out.join('\n')
}

function toWhatsAppMarkup(text: string): string {
  return (
    pipeTablesToLines(text)
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
  // The space a stripped reference leaves in front of the next comma or full stop
  // is closed by `tidy()` at the end of the pass, along with every other one. There
  // used to be a `.replace(/\s+,/g, ',')` here doing a subset of that, under a
  // comment about "rule 10" describing something it never did.
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
  'turn', 'sim_clock', 'sim_fault',
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

function stripIdentifiers(text: string, id: LintScope): string {
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
  //
  // The lookarounds are what stop it eating a UPI handle. `coach_ace@okhdfc` became
  // "coach ace@okhdfc" — an address nobody can pay to, in the message whose entire
  // purpose is to be paid — because an underscore inside a handle looks exactly like an
  // underscore inside a column name. A UPI handle is the one identifier in this product
  // that a person is supposed to read verbatim, so anything adjacent to `@`, `.` or `/`
  // is left alone: that is an address, not machinery.
  out = out.replace(
    /(^|[^\w@./])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w@./])/g,
    (_m, before: string, token: string) => `${before}${humanise(token)}`,
  )

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
      //
      // **No trailing `\.?`.** It used to end `[Mm]\.?`, to absorb the second dot of
      // "P.M.". A regex cannot tell that dot from the one ending the sentence, and
      // the sentence is the commoner case by far: the model writes "PM", so every
      // "...from 6:30 PM to 7:30 PM. It's ₹1,500 per month." shipped to a person as
      // "...to 7:30pm It's ₹1,500 per month." — two sentences run together, on the
      // first message a prospect ever receives. Driven twice in one probe run, and
      // invisible to every check because the body is otherwise perfect English.
      //
      // Dropping it costs a stray dot on the rare dotted form ("6:30 P.M. tomorrow"
      // -> "6:30pm. tomorrow"). That is the right way round: a spare full stop reads
      // as a typo, a missing one reads as a different sentence.
      .replace(/\b(\d{1,2}):(\d{2})\s*([APap])\.?[Mm]/g, (_m, h, mm, ap) =>
        `${Number(h)}${mm === '00' ? '' : `:${mm}`}${ap.toLowerCase()}m`,
      )
      .replace(/\b(\d{1,2})\s+([APap])\.?[Mm]/g, (_m, h, ap) => `${Number(h)}${ap.toLowerCase()}m`)
      // "August 17th" / "August 17, 2026" -> "17 Aug"
      //
      // `(?!\d)` after the day, because without it "August 2026" parsed as day 20 with
      // "26" left over and became **"20 Aug26"** — a date that does not exist, in the
      // one message where being wrong is most expensive. A billing period is written
      // "<Month> <YYYY>" by `monthLabel`, so every dunning line, every month-end tally
      // and every recurring charge description carries that shape. It only started
      // reaching this pass when lint moved to the send path and job-handler bodies came
      // with it; the bug is older than the move.
      //
      // A bare "August 2026" now matches nothing and is left exactly as written, which
      // is right: it is a month, not a date, and there is nothing to localise.
      .replace(
        /\b([A-Z][a-z]{2,8})\s+(\d{1,2})(?!\d)(?:st|nd|rd|th)?(?:,\s*\d{4})?/g,
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

/**
 * `compactDate` and its tables live in `lib/format.ts`, which is where this
 * product decides how a time reaches a human. This file used to hold a second
 * copy of both — and one of the things it rewrote on the way out was the FIRST
 * copy's output ("6:30 pm" -> "6:30pm"), which is two files disagreeing rather
 * than anybody choosing. The chat idiom is still the right one for this pass;
 * only its definition moved.
 */
function rewriteTimestamps(text: string, tz: string): string {
  const today = inZone(nowSync(), tz)
  return localiseEnglishDates(text).replace(ISO, (whole, y, mo, d, hh, mm, _ss, off) => {
    if (hh === undefined) {
      // A calendar date. Converting a bare date between zones would move the day,
      // so it is formatted where it stands.
      return compactDate(`${y}-${mo}-${d}`, null, today.date)
    }
    const iso = `${y}-${mo}-${d}T${hh}:${mm}:00${off ? String(off) : 'Z'}`
    const parsed = new Date(iso)
    if (Number.isNaN(parsed.getTime())) return whole
    const local = inZone(parsed, tz)
    return compactDate(local.date, local.time, today.date)
  })
}

// -----------------------------------------------------------------------------
// 3. claims the system cannot back (§2.4)
// -----------------------------------------------------------------------------

function downgradeClaims(text: string, evidence?: DeliveryEvidence): string {
  let out = text

  if (!evidence?.read) {
    /**
     * "she has read it", "it was seen", "they've opened it" — downgraded to the
     * strongest claim the row supports.
     *
     * **Bounded to a message-shaped object, because unbounded it inverts English.**
     * This matched any auxiliary followed by read/seen/opened, so *"she has read
     * the notice"* became *"she has sent the notice"* — the opposite of what was
     * said, produced by the pass whose entire job is not saying things that are not
     * true. "Read" is one of the commonest irregular verbs in the language and only
     * a fraction of its uses are a delivery claim.
     *
     * The lookahead is the discriminator: a delivery claim is about *the message*,
     * so it lands on "it", "that", "your message" or the end of the clause. Anything
     * with a real object — a notice, a form, a book — is ordinary English and is
     * left alone. This is the same line lint.ts draws for number-grounding: a string
     * operation may only act where the string itself is decisive.
     */
    out = out.replace(
      /\b(has|have|had|was|were|been|is|are|'ve|'s)\s+(?:already\s+)?(?:read|seen|opened)\b(?=\s*(?:it|this|that|them|the message|your message|my message|the reminder|the update)\b|\s*[.,;!?]|\s*$)/gi,
      (_m, aux: string) => `${aux} sent`,
    )
    out = out.replace(/\bread receipts?\b/gi, 'delivery status')
  }
  if (!evidence?.delivered) {
    /**
     * **Bounded the same way, and for the same reason.**
     *
     * The "read/seen/opened" pass above was narrowed after it inverted English —
     * *"she has read the notice"* became *"she has sent the notice"* — and the
     * discriminator it landed on is that a delivery claim is about *the message*,
     * so it lands on "it", "that", "your message", or the end of the clause.
     *
     * This one was left unbounded: `\bdeliver(?:ed|y confirmed)\b` matched any use
     * of the word, so *"the coach delivered a great session"* became *"the coach
     * sent a great session"*. Same defect, same fix, one line apart — it survived
     * because "delivered" reads like jargon and "read" reads like English, which is
     * a fact about the reader rather than about the string.
     *
     * "delivery confirmed" keeps its own rule: it is a status phrase, never
     * ordinary prose, so it needs no object to disambiguate it.
     */
    out = out.replace(
      /\b(has|have|had|was|were|been|is|are|'ve|'s)\s+(?:already\s+)?delivered\b(?=\s*(?:it|this|that|them|the message|your message|my message|the reminder|the update)\b|\s*[.,;!?]|\s*$)/gi,
      (_m, aux: string) => `${aux} sent`,
    )
    out = out.replace(/\bdelivery confirmed\b/gi, (m) => (m[0] === m[0].toUpperCase() ? 'Sent' : 'sent'))
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

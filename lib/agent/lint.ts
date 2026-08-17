/**
 * lib/agent/lint.ts — one adapter, and a validator that refuses.
 *
 * **This file used to be five rewriting passes and it is now one encoding and a
 * list of complaints.** That is the whole of ARCHITECTURE.md's hardest rule, in
 * the place it bit hardest:
 *
 *   > The runtime never reads or writes prose. Deterministic machinery is the
 *   > right tool where a question has one answer — rows, diffs, permissions,
 *   > caps, collisions. It is the wrong tool wherever the question is "what does
 *   > this sentence mean?", and the record is total: every pattern that ever read
 *   > or edited language in this product misfired silently, in both directions.
 *
 * The record it is total about is this file's own. `downgradeClaims` turned *"she
 * has read the notice"* into *"she has sent the notice"* — the opposite of what
 * was said, produced by the pass whose entire job was not saying things that are
 * not true — and then turned *"the coach delivered a great session"* into *"the
 * coach sent a great session"* one line further down, by the identical defect,
 * which survived because "delivered" reads like jargon and "read" reads like
 * English. `localiseEnglishDates` parsed "August 2026" as day 20 and shipped
 * **"20 Aug26"**, a date that does not exist, into billing prose. `stripIdentifiers`
 * ate a UPI handle down to an address nobody could pay to, in the message whose
 * entire purpose was to be paid. Each was fixed. Each fix was correct. The class
 * is what does not go away, and every one of them was a **second author**: a gap
 * between the message the model wrote and the message the person read, which
 * becomes a false belief in the very next turn, because the model's picture of
 * what it said is its own draft.
 *
 * What survives, and why exactly this and nothing else:
 *
 *   **`toWhatsAppMarkup` is an ADAPTER.** It changes representation, not meaning:
 *   `**bold**` and `## heading` both become WhatsApp's one-asterisk bold, `- item`
 *   becomes a bullet, a pipe table becomes one bulleted line per row. Nothing is
 *   deleted, nothing is added, and no word is exchanged for another word. The
 *   model is told it happens (`PLATFORM`), so its next sentence about its own
 *   message is not a guess. An adapter is allowed; a second author is not.
 *
 *   **`proseViolations` REFUSES.** A uuid, a table name, an ISO timestamp, a
 *   section reference, a raw URL, a bracketed pseudo-button, a wire-shape blob —
 *   every one of these is machinery on a customer's screen, every one is
 *   answerable from the string alone, and every one used to be quietly rewritten.
 *   Now it comes back as a refusal naming what is wrong, with one round of grace,
 *   while the model can still fix it. The model repairs everything it is told
 *   about honestly; it mis-narrates everything it is not.
 *
 * DELETED, and not to be re-added without a drive showing their absence cost
 * something — they are in ARCHITECTURE.md's trap list by name:
 *
 *   `downgradeClaims`  a pattern judging whether a sentence was a delivery claim.
 *                      Whether a message was delivered is a COLUMN; the model
 *                      reads it like it reads everything else.
 *   `applyVocabulary`  rewriting "class" to "batch" behind the model's back. The
 *                      tail already tells it their words, which is the half that
 *                      works — and a preference is not a falsehood, so there is
 *                      nothing here to refuse either.
 *   `rewriteTimestamps` / `localiseEnglishDates`
 *                      re-rendering times the model already wrote. An ISO
 *                      timestamp in a message is a defect and is refused; a
 *                      correctly-written English time is not the runtime's to
 *                      restyle.
 *   `stripIdentifiers` deleting uuids, unquoting state words, substituting the
 *                      business name for "academy", humanising snake_case.
 *                      Refused now, every one.
 *   `tidy`             closing up the punctuation the deletions left behind.
 *                      With nothing deleting, there is nothing to tidy.
 */
import type { Identity } from '@/lib/types'

/**
 * The only part of an `Identity` this file reads. Kept narrow so `send` — which
 * holds a `SessionCtx` and not an `Identity` — can reach the same guarantee.
 */
export type LintScope = {
  academyId?: string | null
  academy?: { name?: string | null; timezone?: string | null; memory?: string | null } | null
}

// -----------------------------------------------------------------------------
// The adapter
// -----------------------------------------------------------------------------

/**
 * A Markdown pipe table, turned into lines WhatsApp can actually draw.
 *
 * WhatsApp's markup is bold, italic, strikethrough, monospace, inline code,
 * bulleted and numbered lists, and block quotes. There is no table. A model asked
 * for a roster reaches for one anyway, and an admin was shown pipes and colons,
 * verbatim, in the message summarising their whole business.
 *
 * Converted rather than refused, because this is representation and not meaning:
 * every cell survives, in the same order, under the same headings. Requires two
 * or more consecutive pipe rows AND either a `|:---|` separator or a consistent
 * column count, so a sentence that merely contains a pipe is left alone.
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

/**
 * Markdown into WhatsApp's own markup. Representation, never meaning.
 *
 * The model writes Markdown because everything it has ever read was Markdown.
 * WhatsApp is not Markdown: bold is one asterisk, there are no headings, and
 * `[label](url)` renders as the literal characters. Left alone, the first thing a
 * new admin was ever shown read `* **Beginners:** Monday, Wednesday, Friday` —
 * correct information wearing four wrong characters.
 */
export function toWhatsAppMarkup(text: string): string {
  if (!text) return text
  return (
    pipeTablesToLines(text)
      // Fenced code and inline code survive as-is: WhatsApp has both.
      // `## Heading` → bold on its own line. Headings do not exist here.
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, (_m, body: string) => `*${String(body).trim()}*`)
      // `**bold**` / `__bold__` → the one-character forms. Bounded to one line on
      // purpose: an unbalanced `**` must not swallow the rest of the message
      // looking for its partner.
      .replace(/\*\*\*([^\n*]+?)\*\*\*/g, '_*$1*_')
      .replace(/\*\*([^\n*]+?)\*\*/g, '*$1*')
      .replace(/__([^\n_]+?)__/g, '_$1_')
      // `* item` / `- item` at the start of a line → a real bullet. An asterisk
      // there is indistinguishable from an unclosed bold marker.
      .replace(/^[ \t]*[*+-][ \t]+/gm, '• ')
      // A horizontal rule is a Markdown idea.
      .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '')
  )
}

/**
 * The one thing every outbound message passes through, at the chokepoint.
 *
 * Named for what it now is. The old `lint()` took an `evidence` argument and an
 * options bag because two of its five passes made claims about delivery; there
 * is nothing left here that has an opinion about the content.
 */
export function encodeForWhatsApp(text: string): string {
  return toWhatsAppMarkup(text)
}

// -----------------------------------------------------------------------------
// The validator
// -----------------------------------------------------------------------------

export type ProseViolation = {
  /** What is wrong, in the model's terms. */
  what: string
  /** What to do instead. A refusal that carries no repair costs a round. */
  fix: string
  /** The offending text, so the model does not have to hunt for it. */
  sample?: string
}

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/

/** §6 table names. Anything qualified by one of these is machinery, not English. */
const TABLES = [
  'academy', 'venue', 'person', 'contact', 'account', 'player', 'coach',
  'academy_admin', 'memory_fact', 'class', 'class_slot', 'class_coach',
  'enrollment', 'session', 'session_coach', 'attendance', 'tally_line',
  'payment', 'sender', 'message', 'action', 'job', 'audit_entry',
  'turn', 'pending_request', 'comm_preference', 'business_rule',
]

const TABLE_COLUMN = new RegExp(`\\b(?:${TABLES.join('|')})\\.[a-z_]+\\b`)

/**
 * A bare `snake_case` token that is not part of an address.
 *
 * The lookarounds are what stop it reading a UPI handle as a column name:
 * `coach_ace@okhdfc` is the one identifier in this product a person is supposed
 * to read verbatim, so anything adjacent to `@`, `.` or `/` is left alone.
 */
const SNAKE_CASE = /(?:^|[^\w@./])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![\w@./])/

const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})/
const BARE_ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/
const SECTION_REF = /§+\s*\d+(?:\.\d+)*/
const RAW_URL = /https?:\/\/(?!wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\S+/

/**
 * A line that is nothing but `[Label]` groups — the model typing the buttons it
 * meant to attach.
 *
 * This used to be harvested into real buttons, which is the friendliest possible
 * second author and still a second author: the message that reached the person
 * had lines removed from it and controls added to it, and the model's picture of
 * what it sent was its draft. Refused now, once, while there is a round left to
 * pass them as buttons — which is the only form that is actually tappable.
 */
const BRACKET_LINE = /^\s*(\[[^\]\n]{1,40}\]\s*(?:\(\s*(?:action|payload|kind|on-click)\s*:[^)\n]*\)\s*)?)+\s*$/im

/**
 * A key that only ever appears in this product's own wire shape, in ANY notation.
 *
 * The model does not write strict JSON, because the prompt does not show it
 * strict JSON — the action schema is documented as `{kind:'reply',text}`, so that
 * is the notation that comes back when it types an offer instead of calling the
 * tool. So the test is the KEY, never the quoting.
 */
const WIRE_SHAPE =
  /(?:^|[{,[\s])["']?(?:kind|buttons|action|steps|menu|args|form_prefill|catalog_id|to_contact_id|to_person_id)["']?\s*:/

/**
 * Everything a message can be wrong about that the string itself decides.
 *
 * Nothing here judges MEANING. Every one of these is answerable by looking at the
 * characters — "does this contain a uuid" has one answer, the way "does this
 * overclaim" does not — which is the line ARCHITECTURE.md draws between what
 * deterministic machinery may decide and what it may not.
 *
 * Empty is the overwhelmingly common case, and an empty list costs one pass over
 * the string.
 */
export function proseViolations(text: string, scope?: LintScope): ProseViolation[] {
  const out: ProseViolation[] = []
  if (!text) return out

  const uuid = UUID.exec(text)
  if (uuid) {
    out.push({
      what: 'it contains a uuid',
      fix: 'Ids are for your SQL and never for a message. Say the person, the class or the session by name.',
      sample: uuid[0],
    })
  }

  const tableColumn = TABLE_COLUMN.exec(text)
  if (tableColumn) {
    out.push({
      what: 'it names a table and column',
      fix: 'Say what the value means in the business\'s words — "her start time", not the column it lives in.',
      sample: tableColumn[0],
    })
  } else {
    const snake = SNAKE_CASE.exec(text)
    if (snake) {
      out.push({
        what: 'it contains a snake_case identifier',
        fix: 'That is a column or a status value, not English. Say it the way the person would.',
        sample: snake[1],
      })
    }
  }

  const iso = ISO_TIMESTAMP.exec(text) ?? BARE_ISO_DATE.exec(text)
  if (iso) {
    out.push({
      what: 'it contains a machine timestamp',
      fix: 'Write times in their idiom and their zone — "tomorrow 6:30pm", "Sat 8am" — never an ISO string and never UTC.',
      sample: iso[0],
    })
  }

  const section = SECTION_REF.exec(text)
  if (section) {
    out.push({
      what: 'it cites an internal section number',
      fix: 'Nobody you are writing to has read that document. Say the thing itself.',
      sample: section[0],
    })
  }

  const url = RAW_URL.exec(text)
  if (url) {
    out.push({
      what: 'it contains a web address',
      fix: 'There is no browser in this product. Offer the thing as a button or a form instead.',
      sample: url[0],
    })
  }

  const brackets = BRACKET_LINE.exec(text)
  if (brackets) {
    out.push({
      what: 'it has a line of bracketed labels in the body',
      fix: 'A label typed into a body looks tappable and is not. Pass them as buttons — {kind:\'reply\', text:"…"} is always legal and needs no arguments you do not have.',
      sample: brackets[0].trim().slice(0, 80),
    })
  }

  if (text.includes('{') && WIRE_SHAPE.test(text)) {
    out.push({
      what: 'it has a wire-shape object in the body',
      fix: 'That is the shape you pass to the tool, not something a person may see. Put the offer on `buttons`.',
    })
  }

  // "academy" is the one word that appears nowhere a user can see, and it is also
  // a table name — so it is caught here rather than substituted, which is what
  // used to happen and is why a receipt once read "changed 1 Shuttle Point".
  if (/\bacadem(?:y|ies)\b/i.test(text)) {
    out.push({
      what: 'it uses the word "academy"',
      fix: scope?.academy?.name
        ? `Use their own name for the business — ${scope.academy.name} — or nothing at all.`
        : 'Use their own name for the business, or nothing at all.',
    })
  }

  return out
}

/** One sentence a tool result can carry, from a list of violations. */
export function violationMessage(violations: readonly ProseViolation[]): string {
  return violations
    .map((v) => `${v.what}${v.sample ? ` ("${v.sample}")` : ''} — ${v.fix}`)
    .join(' ')
}

// -----------------------------------------------------------------------------
// Their words, from memory — read by the TAIL, never applied to a message
// -----------------------------------------------------------------------------

export type VocabularyPreference = { prefer: string; avoid: string }

const VOCAB_PATTERNS: RegExp[] = [
  // "Calls them batches, not classes."
  /\bcalls?\s+(?:them|it|these|those)?\s*["“']?([A-Za-z][\w '-]{1,24}?)["”']?\s*,?\s+not\s+["“']?([A-Za-z][\w '-]{1,24}?)["”']?(?=[.;,)\n]|$)/gi,
  // "Uses 'batch' instead of 'class'." / "Prefers batches over classes."
  /\b(?:uses?|says?|prefers?)\s+["“']?([A-Za-z][\w '-]{1,24}?)["”']?\s+(?:instead of|rather than|over|not)\s+["“']?([A-Za-z][\w '-]{1,24}?)["”']?(?=[.;,)\n]|$)/gi,
]

/**
 * Vocabulary preferences read out of an academy's memory hot set, for the tail.
 *
 * **This reads a FACT, never a message**, which is the whole reason it survived
 * the deletion above it. A pattern over something the model wrote about the
 * business is a pattern over data; a pattern over something the model is about to
 * send is an unsupervised judge standing between the author and the reader. The
 * rewriting half — `applyVocabulary` — is gone; telling the model their words and
 * letting it choose is the half that ever worked.
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

/** Structural satisfaction for callers that still hand an `Identity` through. */
export type { Identity }

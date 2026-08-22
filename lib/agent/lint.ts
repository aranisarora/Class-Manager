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
 *   That sentence was false in two places until it was measured, and both are
 *   below: a horizontal rule was DELETED (moved to the refusals, where a thing
 *   with no WhatsApp form belongs), and a blank table cell was dropped and every
 *   value after it re-labelled with the previous column's name — the adapter
 *   ADDING a fact, which is the worse half of the same trap.
 *
 *   **`proseViolations` REFUSES.** A uuid, a table name, an ISO timestamp, a
 *   section reference, a raw URL, a horizontal rule, a bracketed pseudo-button,
 *   a wire-shape blob —
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
  /**
   * The real business names in play for this message, blanked out of a COPY of the
   * body before the "academy" ban is tested — see `maskBusinessNames`.
   *
   * Optional, and absent almost everywhere on purpose: when it is not given, the
   * one name in `academy.name` is used, so every tenant caller that already hands
   * an `Identity` through gets the guarantee without threading anything. Only a
   * caller holding SEVERAL businesses at once — the front desk, which is talking to
   * somebody who has not yet been placed in one — has a list to supply.
   *
   * Optional also keeps `Identity` structurally assignable to this type, which is
   * the whole reason `LintScope` exists.
   */
  businessNames?: readonly string[] | null
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
 * every value survives, in the same order, under its own heading. Requires two
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
      // Every value carries its OWN column's name, decided before any cell is
      // dropped. This used to filter the blanks out first and then hand out header
      // names by counting positions in what was left, so one blank moved every
      // value after it under the previous column's name: `| Vivaan | | 7pm |`
      // under Name/Class/Time reached a parent as *"Vivaan — Class: 7pm"*. That is
      // not a lost cell, it is a manufactured one — the runtime stating a fact the
      // model never wrote, on the one artifact the person actually reads, while
      // the model's only picture of what it sent was its draft.
      const labelled = cells
        .map((value, k) => ({ value, label: header?.[k] ?? '' }))
        .filter((p) => p.value.length > 0)
      if (!labelled.length) continue

      // The first COLUMN is the row's subject and is emphasised — but only when
      // the row filled it. Promoting a later value into that slot is the same
      // relabelling arriving by another door: a blank name made `*Advanced*` the
      // person. Already emphasised cells are left as they are — a second pair of
      // asterisks round `*Beginners*` renders as a literal asterisk, which is the
      // bug one layer down from the one being fixed.
      const first = cells[0] ?? ''
      const lead = first.length ? (/[*_~]/.test(first) ? first : `*${first}*`) : null
      const rest = (lead ? labelled.slice(1) : labelled).map((p) =>
        p.label ? `${p.label}: ${p.value}` : p.value,
      )
      out.push(
        lead
          ? rest.length
            ? `• ${lead} — ${rest.join(' · ')}`
            : `• ${lead}`
          : `• ${rest.join(' · ')}`,
      )
    }
    i = j - 1
  }
  return out.join('\n')
}

/**
 * Markdown into WhatsApp's own markup. Representation, never meaning.
 *
 * @mechanism toWhatsAppMarkup — the one pass allowed between what the model wrote and what the
 *   person reads, and it is an ADAPTER: headings and `**bold**` become WhatsApp's one-asterisk
 *   bold, `- item` becomes a bullet, a pipe table becomes one bulleted line per row with every
 *   value under its OWN column's name. Nothing is deleted, nothing is added, and no word is
 *   exchanged for another — the two places that were false (a deleted horizontal rule, a blank
 *   cell that re-labelled every value after it) are a refusal and a fix respectively. The model
 *   is told this happens, so its next sentence about its own message is not a guess.
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
  /**
   * This draft must not be sent even if the repair round fails.
   *
   * See `structuralViolation` below. Separates a draft that is WORDED wrong from a draft
   *   that is not prose at all. The trailing-message path's rule is "a failed repair must
   *   not become silence", and it is right about every violation but one: a body carrying
   *   a wire-shape object is not a sentence with a flaw in it, it is machinery, and
   *   sending it is strictly worse than the runtime saying one plain thing instead. Silence
   *   is not the alternative and never was — the apology ladder has four sentences ready.
   *
   *   On `2026-08-22-08-13-sim-7bo8` turn 172 the fallback put
   *   `[you called reply with {"body": …}]` on a paying parent's phone, escaped newlines
   *   and all, on his first contact. `flattenToolTurns` is why that string existed at all
   *   and is fixed at its own site; this is the belt under it, because the next thing that
   *   puts an object in a body will not be that bug.
   *
   *   Deliberately narrow. Only the wire-shape rule sets it. A banned word, an id, a
   *   doubled full stop — every one of those is a message a person can still read and act
   *   on, and refusing to send it because the model could not rephrase it is the failure
   *   the rule was written against.
   */
  structural?: true
}

const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/

/** §6 table names. Anything qualified by one of these is machinery, not English. */
const TABLES = [
  'academy', 'venue', 'person', 'contact', 'account', 'player', 'coach',
  'academy_admin', 'memory_fact', 'class', 'class_slot', 'class_coach',
  'enrollment', 'session', 'session_coach', 'attendance', 'tally_line',
  'payment', 'sender', 'message', 'action', 'job', 'audit_entry',
  'turn', 'pending_request', 'comm_preference', 'business_rule',
  'coach_ledger',
  'rate_period',
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
 * A Markdown horizontal rule — `---`, `***`, `___`.
 *
 * The adapter used to delete this line and say nothing, which is the one place it
 * removed rather than converted, and it broke the promise the `reply` declaration
 * makes at the decode point: *"what you write here is what they read, byte for
 * byte."* WhatsApp cannot draw a rule, so there is nothing to convert it INTO —
 * which is exactly the case that belongs here rather than in the adapter.
 *
 * The cost of deleting it was measured. On a turn whose message tools were all
 * failing, the model composed a note to itself, a `---`, and then the real
 * message. The rule was silently removed on the way to the wire, the boundary it
 * drew went with it, and a worried parent read *"I'll close the turn with the
 * honest update to Divya directly, since the message tools are failing this
 * turn"* as the opening line of her answer. The model reported it itself the
 * following turn: *"a stray internal note of mine went out… it was my notebook,
 * not a proper message."* Refused, the same turn gets a round of grace and the
 * one party who knows which half was the message decides what to do with it.
 *
 * `PLATFORM` already states there are no horizontal rules. That turn is what
 * being told is worth on its own.
 */
const HORIZONTAL_RULE = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/m

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
 * The banned domain noun, and the reason it is banned at all.
 *
 * `academy` is the tenant TABLE. The ban exists to stop a schema identifier
 * reaching a customer's screen — the same class as `person.full_name` and a bare
 * `class_slot` — and it is enforced by banning the ENGLISH NOUN, which is a blunt
 * instrument for that job: the noun is also an ordinary word for the kind of
 * business this product sells to, and half of them have it in their name.
 */
const ACADEMY_WORD = /\bacadem(?:y|ies)\b/i

/**
 * A copy of the body with the real business names blanked, for the length of one
 * check. Nothing is rewritten and nothing is sent.
 *
 * @mechanism maskBusinessNames — the "academy" ban is asked of a copy of the message with
 *   this context's real business names blanked out, so it answers the question the ban is
 *   actually about — *does this sentence call a business an "academy"?* — rather than the
 *   question it was accidentally asking, *does the business's own name appear?* A name is
 *   blanked only when it matches one the caller holds, so the test stays exactly decidable;
 *   the mask lives inside the check and what ships is byte-for-byte what the model wrote.
 *   Retires the unsatisfiable refusal loop: a business whose own name contains the word
 *   could not be named at all, and the remedy printed by the refusal contained the very
 *   substring the refusal was rejecting.
 *
 * The defect this closes was measured, and it is the worst kind — a refusal the
 * model cannot possibly satisfy. On the thirty-day run the owner typed his own
 * business's name on day 3, `start_business` recorded it faithfully, and it was
 * **Rahul Menon Tennis Academy**. From then on every message naming the business
 * was refused for containing "academy", and the sentence the refusal handed back
 * was *"Use their own name for the business — Rahul Menon Tennis Academy — or
 * nothing at all"*: a remedy CONTAINING the substring being refused. The record
 * shows the model going round that twice before the runtime ran out of rounds and
 * a paying parent's first ever contact was answered with a raw tool-call envelope
 * (turn 172). A rule with no satisfying answer does not degrade gracefully; it
 * spends the whole turn and then ships whatever is left in the buffer.
 *
 * Masking rather than dropping the ban, and masking rather than rewriting, because
 * both of the obvious alternatives are worse:
 *
 *   *Dropping the ban* gives back the leak it was built for — "I have updated the
 *   academy row" reaching an admin, which is where the check came from.
 *
 *   *Substituting the name for the word* is what `stripIdentifiers` used to do, and
 *   it is in ARCHITECTURE.md's trap list by name: a receipt once read "changed 1
 *   Shuttle Point". That is the second author this file exists to have deleted.
 *
 * The mask is neither. It narrows the question, it is decided by a row rather than
 * by judgement — a span is blanked only when it equals a name the caller is
 * holding — and the masked string never leaves this function. What goes on the
 * wire is what the model typed, characters unchanged, exactly as the `reply`
 * declaration promises.
 *
 * Two details that are load-bearing:
 *
 *   **Longest name first.** With "Ace" and "Ace TT Academy" both on a number,
 *   blanking the short one first leaves " TT Academy" behind and the check fires on
 *   the fragment of a name it was supposed to have accepted.
 *
 *   **Case-insensitively, and only the WHOLE name.** The model writes the name back
 *   in whatever case it read it in. But "the academy" on its own is not a name, is
 *   not masked, and is still refused — which is the case the ban is for.
 *
 * A business literally NAMED "Academy" masks the word away entirely and the check
 * stops firing for that tenant. That is the honest answer rather than a hole: for
 * that business the ban was never satisfiable in the first place, and no string
 * operation can tell their name from the table's.
 */
export function maskBusinessNames(text: string, names: readonly string[] | null | undefined): string {
  if (!text || !names?.length) return text
  const ordered = [...new Set(names.map((n) => (n ?? '').trim()).filter((n) => n.length >= 2))].sort(
    (a, b) => b.length - a.length,
  )
  let masked = text
  for (const name of ordered) {
    // Escaped, because a business name is user-typed and "Ace TT (Andheri)" is a
    // perfectly ordinary one — unescaped it is a regex group that matches nothing
    // and silently masks nothing.
    masked = masked.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ')
  }
  return masked
}

/**
 * Everything a message can be wrong about that the string itself decides.
 *
 * @mechanism proseViolations — the validator that REFUSES rather than rewrites. A uuid, a
 *   table.column, a bare snake_case token, an ISO timestamp, a § reference, a raw URL, a line
 *   of bracketed pseudo-buttons, a horizontal rule, a wire-shape object, the word "academy":
 *   each is machinery on a customer's screen, each is answerable from the characters alone,
 *   and each used to be quietly edited on the way out — which is a second author, a gap
 *   between the message the model wrote and the message the person read that becomes a false
 *   belief on the very next turn. It comes back naming what is wrong and what to do instead,
 *   with one round of grace left: the model repairs everything it is told about and
 *   mis-narrates everything it is not. The "academy" test alone runs against a copy with
 *   this context's real business names blanked (`maskBusinessNames`), because it is the one
 *   ban that is about what a sentence calls a business rather than about the characters.
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

  const rule = HORIZONTAL_RULE.exec(text)
  if (rule) {
    out.push({
      what: 'it contains a horizontal rule',
      fix: 'WhatsApp cannot draw one, so that line would simply vanish and whatever it was separating would run together. A blank line separates two thoughts. If it is separating a note to yourself from the message, the note is not part of the message.',
      sample: rule[0].trim(),
    })
  }

  if (text.includes('{') && WIRE_SHAPE.test(text)) {
    out.push({
      what: 'it has a wire-shape object in the body',
      fix: 'That is the shape you pass to the tool, not something a person may see. Put the offer on `buttons`.',
      structural: true,
    })
  }

  // "academy" is the one word that appears nowhere a user can see, and it is also
  // a table name — so it is caught here rather than substituted, which is what
  // used to happen and is why a receipt once read "changed 1 Shuttle Point".
  //
  // And it is caught against a MASKED copy. This is the only test that gets one,
  // deliberately: every other ban above is about characters that are machinery
  // wherever they appear — a uuid inside a business name is still a uuid on a
  // customer's screen, an ISO timestamp is still one — so masking there would hide
  // real defects. This ban is the only one that is not about the characters at all
  // but about what the sentence is calling the business, and the only one whose own
  // remedy has to say a business's name out loud. `maskBusinessNames` carries the
  // whole argument, including why the ban exists (a schema identifier leaking) and
  // why banning a domain noun is a blunt way to get that.
  //
  // Cheap in the common case: the mask is only built for a body that contains the
  // word at all, which almost none do.
  if (ACADEMY_WORD.test(text)) {
    const names = scope?.businessNames?.length
      ? scope.businessNames
      : scope?.academy?.name
        ? [scope.academy.name]
        : []
    const masked = maskBusinessNames(text, names)
    if (ACADEMY_WORD.test(masked)) {
      // The remedy must not itself contain the word, or the refusal teaches the
      // model the thing it just refused. It used to quote the name back — which is
      // how "use their own name — Rahul Menon Tennis Academy" came to be printed as
      // the cure for writing "academy". Quoting is kept only where it is safe (a
      // name with no "academy" in it, where seeing the exact spelling helps); where
      // it is not, the sentence says to use their name WITHOUT saying it, and says
      // plainly that their name is not the problem — otherwise the model reads the
      // refusal as covering the name too and goes silent about the business it is
      // supposed to be speaking for.
      const name = (names[0] ?? '').trim()
      const safeToQuote = name.length > 0 && !ACADEMY_WORD.test(name)
      out.push({
        what: 'it uses the word "academy"',
        fix: safeToQuote
          ? `Use their own name for the business — ${name} — or nothing at all.`
          : name
            ? 'Use their own name for the business, exactly as they write it — their name is fine even where it contains this word, and is not what this is about. It is the bare word, standing on its own, that nobody outside this system says.'
            : 'Use their own name for the business, or nothing at all.',
      })
    }
  }

  return out
}

/**
 * @mechanism structuralViolation — the one predicate for "this draft must not go out even
 *   if the repair round fails". Lives beside the rules rather than at the send site, so the
 *   list of what counts as machinery has one author: `lib/agent/loop.ts` asks this question
 *   instead of re-deciding it, which is the drift `proseViolations` itself exists to avoid.
 *   Today exactly one rule sets it — a wire-shape object in the body — and the narrowness is
 *   the point: every other violation leaves a sentence a person can still read and act on.
 */
export function structuralViolation(violations: readonly ProseViolation[]): ProseViolation | null {
  return violations.find((v) => v.structural) ?? null
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
 * @mechanism vocabularyPreferences — their own words are told to the model, never applied to
 *   its message. This reads a stored FACT, which is a pattern over data; the same pattern over
 *   a message about to be sent is an unsupervised judge standing between the author and the
 *   reader, which is what `applyVocabulary` was before it was deleted. Telling the model that
 *   they say "batch" and letting it choose is the half that ever worked, and a preference is
 *   not a falsehood, so there is nothing here to refuse either.
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

/**
 * lib/agent/traceability.ts — R10, in shadow mode.
 *
 * **The one artifact the customer actually reads is the only one in the product
 * with no structural check on it.** The runtime refuses a reply that says it DID
 * something when nothing was written. Nothing anywhere asks whether a reply that
 * states a time, a date, a price, a headcount or a roster read it out of a row.
 * F-E is what that costs: *"12 players are down to attend"* to a coach, over a
 * table holding one, on a turn that made a single tool call and read no roster.
 * Every existing axis scored that turn as a pass. The coach plans for twelve,
 * meets one, and trust in every number after that is gone.
 *
 * **Why this is a comparison and not a verb list.** ARCHITECTURE.md bans patterns
 * that judge prose, and it is right: every claims regex in this product's history
 * misfired in both directions. This does not ask what a sentence means. It pulls
 * out the SCALARS — the figures and clock times, which have one reading — and
 * asks whether each one appears in what this turn's own tools returned. That is a
 * comparison against the turn's evidence, the way the write check is a comparison
 * against the turn's diff. A number the turn never saw is a number the turn
 * cannot know.
 *
 * **It blocks nothing, and that is deliberate.** DRIVING.md's build spec:
 *
 *   > Do not ship it live. A fact-grounding gate false-positives into a
 *   > re-compose, a re-compose is a round, and rounds are the entire cost and
 *   > latency story — 19k tokens at one round, 128k at six.
 *   >
 *   > Build it in shadow mode first: log what it would have blocked, block
 *   > nothing, drive once, read the log. Turn it on when it catches a reply that
 *   > states a class time no row holds, and a "next class" on a date with no
 *   > session, WITHOUT flagging "his class is Mon/Wed/Fri at 6" — a weekly
 *   > pattern is a real answer to "when is his class?", and only the wrong answer
 *   > to "when is his NEXT class?".
 *
 * So its output goes on the flight recorder and nowhere else. It steers no turn
 * and touches no message, which is precisely the exemption that lets a string
 * operation look at language at all here. Read the log; do not read the count.
 */

/** One scalar the message states that this turn's evidence does not contain. */
export type Untraced = {
  /** The literal as written. */
  value: string
  /** What kind of thing it looks like — money, a clock time, a plain figure. */
  kind: 'money' | 'time' | 'figure'
}

/**
 * Numbers a message may carry without having read them anywhere.
 *
 * Kept small and boring on purpose: these are the values that appear in ordinary
 * English rather than in a row. Ordinals and small counts ("one or two things",
 * "the first of the month") are the commonest false positive, and a shadow report
 * full of them is a report nobody reads.
 */
const AMBIENT = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '24', '100'])

/** ₹1,200 · Rs 500 · ₹ 1200.00 */
const MONEY = /(?:₹|\brs\.?\s*)\s*([\d][\d,]*(?:\.\d{1,2})?)/gi
/** 6:30pm · 18:00 · 8 am */
const CLOCK = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/gi
/** A bare figure of two digits or more. One digit is almost always English. */
const FIGURE = /\b\d{2,}\b/g

/** Commas, currency marks and case removed, so 1,200 and ₹1200 are one value. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[,\s₹]/g, '').replace(/^rs\.?/, '')
}

/**
 * Every scalar in `body` that nothing in `evidence` contains.
 *
 * `evidence` is this turn's tool results, verbatim — what the reads returned and
 * what the writes wrote. A number that came from the variable tail (the census,
 * a replayed lookup) is NOT in here, which is a known and accepted source of
 * shadow-mode noise: those values were read from rows, just on an earlier round
 * trip. That is one of the things reading the log is for.
 */
export function untracedScalars(body: string, evidence: readonly string[]): Untraced[] {
  if (!body.trim()) return []
  const haystack = norm(evidence.join(' '))
  if (!haystack) return []

  const out: Untraced[] = []
  const seen = new Set<string>()
  const add = (value: string, kind: Untraced['kind']) => {
    const key = `${kind}:${norm(value)}`
    if (seen.has(key)) return
    seen.add(key)
    if (AMBIENT.has(norm(value))) return
    if (haystack.includes(norm(value))) return
    out.push({ value, kind })
  }

  for (const m of body.matchAll(MONEY)) add(m[1] as string, 'money')
  for (const m of body.matchAll(CLOCK)) {
    // Both alternations; whichever matched.
    const h = m[1] ?? m[4]
    const mm = m[2] ?? m[5]
    if (!h) continue
    add(mm ? `${h}:${mm}` : String(h), 'time')
  }
  for (const m of body.matchAll(FIGURE)) add(m[0], 'figure')

  return out
}

/** One line for the flight recorder. Empty when there is nothing to record. */
export function traceabilityNote(body: string, evidence: readonly string[]): Untraced[] | null {
  const found = untracedScalars(body, evidence)
  return found.length ? found : null
}

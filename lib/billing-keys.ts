/**
 * The strings the money rules recognise each other by.
 *
 * `tally_line` has no class column and no dedupe column, so §6.4's rules are made
 * idempotent by matching on `reason` and on `description` — text that is also
 * shown verbatim to the parent. That is workable only while there is exactly one
 * spelling of each. There were two, and they were written by two different files
 * that never compared notes:
 *
 *   free first class   lib/jobs/handlers/money.ts   deduped on reason = 'free trial'
 *                      lib/agent/operations.ts      wrote   reason = 'free first class'
 *
 *   a package          money.ts                     "<class> — pack of N classes"
 *                      operations.ts                "N-class package — <player>"
 *
 * Each writer's guard was correct about its own rows and blind to the other's, so
 * a trial player who met both paths was credited twice, and `packageState`
 * counted zero packs opened by the operation path and cheerfully opened another.
 * R5: the comparison exists and can never fire — here because the two sides of it
 * were composed independently.
 *
 * One definition, imported by both. A literal that lives in one place cannot
 * disagree with itself.
 *
 * **The larger half now exists, below.** The note that used to end this comment
 * said the real answer was "a `dedupe_key` column on `tally_line`, computed from
 * ids and carrying a unique index", and that renaming a class still defeated a
 * description-keyed guard. That was not a prediction, it was a live defect, and
 * it has now been driven:
 *
 *   A family paid ₹1,200 for August and the payment was confirmed — billed 1200,
 *   paid 1200, nothing outstanding. Their class was then renamed from "Beginners"
 *   to "Beginners Batch". The next billing run for the SAME player and the SAME
 *   period composed "Beginners Batch — August 2026", found no row matching that
 *   sentence, and charged them again. The account went from settled to ₹1,200 in
 *   arrears, which is enough to enter the dunning ladder — so a paid-up family
 *   gets chased for money they do not owe, because somebody fixed a typo in a
 *   class name.
 *
 * Sixteen (player, class, period) triples in the shared world were already
 * double-charged this way, ₹32,800 in total, every one of them a pair that
 * differs only by "-" versus "—": `lib/seed.ts` composes its descriptions with a
 * hyphen and `money.ts` with an em dash. Two writers, one rule, no way for either
 * to see the other's rows. R5 exactly — the comparison exists and can never fire.
 *
 * So the keys below are computed from **ids**, and 0023 puts a unique index on
 * them. The description goes back to being what it always should have been: prose
 * for the parent, carrying no load. Rename a class as often as you like.
 */

/** §6.4's free first class. One reason string, both writers. */
export const FREE_FIRST_CLASS_REASON = 'free first class'

/** What the parent reads on that credit line. */
export function freeFirstClassDescription(playerName: string): string {
  return `First class free — ${playerName}`
}

/**
 * What the parent reads when a pack is opened, and the key `packageState` counts
 * packs by. It deliberately does NOT carry the player's name: the counter matches
 * on (player_id, kind, description), so a name in the text is redundant there and
 * was the thing the two spellings differed by.
 */
export function packageDescription(className: string, count: number): string {
  return `${className} — pack of ${count} classes`
}

/* =========================================================================== *
 * dedupe keys — what "the same charge" means, said in ids
 * =========================================================================== */

/**
 * One recurring charge is identified by **who, for what, and when** — never by the
 * sentence the parent reads. Every key here is built from primary keys, so nothing
 * a human can edit (a class name, a month's spelling, a dash) can change it.
 *
 * `period` is normalised to `yyyy-MM-dd` because it arrives as a `date` from the
 * database, as an ISO string from a job payload, and as either from a caller — and
 * a key that differs by its own formatting is the bug it exists to prevent.
 *
 * The key is scoped per academy by the unique index, not by the string, so it stays
 * short and readable in a debugger.
 *
 * **Deliberately keyless: waivers and manual adjustments.** An admin may waive twice
 * — two half-months missed is two waivers — so those rows carry `dedupe_key = null`
 * and the partial index ignores them. Idempotency for a thing a human does on
 * purpose belongs at the confirmation step, not in a constraint.
 */
function day(period: string | Date): string {
  const iso = period instanceof Date ? period.toISOString() : String(period)
  return iso.slice(0, 10)
}

export const billingKey = {
  /** §6.4's monthly line: one per player, per class, per period. */
  monthly: (playerId: string, classId: string, period: string | Date) =>
    `m:${playerId}:${classId}:${day(period)}`,

  /** A term is a month with a longer stride, and keys the same way. */
  term: (playerId: string, classId: string, period: string | Date) =>
    `t:${playerId}:${classId}:${day(period)}`,

  /**
   * Packs repeat, so the period cannot identify one — the second pack of a busy
   * month shares its period with the first. The ordinal is how many packs this
   * player has already opened on this class, so pack N is written once and only
   * once however many times the exhaustion check re-runs.
   */
  package: (playerId: string, classId: string, ordinal: number) =>
    `p:${playerId}:${classId}:${ordinal}`,

  /** Already enforced by `tally_line_session_player_key`; keyed too so every row is uniform. */
  session: (playerId: string, sessionId: string) => `s:${playerId}:${sessionId}`,

  /** §6.4's free first class: once per player, ever. */
  freeFirstClass: (playerId: string) => `ff:${playerId}`,

  /** The credit that undoes a session line when a cancellation was in time. */
  cancelledInTime: (playerId: string, sessionId: string) => `ct:${playerId}:${sessionId}`,
} as const

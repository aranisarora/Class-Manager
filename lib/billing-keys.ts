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
 * **This is the smaller half of the fix.** The real answer is that idempotency
 * should not key on a sentence a human reads at all — a `dedupe_key` column on
 * `tally_line`, computed from ids and carrying a unique index, would make the
 * rule enforceable rather than merely agreed. Until that exists, these constants
 * are what stop the two writers drifting apart again, and renaming a class still
 * defeats a description-keyed guard.
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

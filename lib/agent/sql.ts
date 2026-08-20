/**
 * lib/agent/sql.ts — SQL literals, and the uuid shape every id is checked against.
 *
 * WHY THIS IS ITS OWN MODULE
 * -----------------------------------------------------------------------------
 * These lived in `operations.ts` and were imported from there by `setup-plan.ts`.
 * That was fine while the arrow only pointed one way. It stopped being fine when
 * the `business_setup` Flow was removed (§14.6): the setup ladder that replaced it
 * needs a named operation, that operation has to run `buildSetupSteps` — the one
 * builder every surface writes the business through — and `operations.ts`
 * importing `setup-plan.ts` while `setup-plan.ts` imports `operations.ts` is a
 * cycle.
 *
 * This repo has been bitten by an import edge in exactly this neighbourhood before:
 * `steps.ts` imports `./kinds` rather than `@/lib/jobs` because the barrel's wider
 * edge "made the operation registry evaluate empty" — a failure that shows up as a
 * registry with no operations in it rather than as an import error. So the fix here
 * is structural rather than clever: the leaf that both sides need becomes a leaf,
 * and the arrows run `operations.ts → setup-plan.ts → sql.ts` with nothing pointing
 * back.
 *
 * Operations compose statements; every value that reaches one goes through these,
 * and every id is checked against the uuid shape before it is allowed near a query.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function lit(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('sql: non-finite number')
    return String(v)
  }
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return `'${v.replace(/'/g, "''")}'`
}

/**
 * A row this plan created a step ago, named by the only thing that can name it.
 *
 * @mechanism isIdSubquery — legalises a bounded parenthesised SELECT where an operation
 *   wants an id, and parses it at mint time: one statement, no semicolon, no verb that
 *   writes. It runs inside the plan's own transaction under the plan author's RLS, so it
 *   reaches exactly what a `write` step beside it could reach and no further. Without it
 *   a step needing the id the database assigned in the step before has no legal encoding,
 *   and the model falls off `create_class` onto a raw INSERT — the one route that does
 *   not enqueue `materialize_sessions`, which is how a business ends up with classes,
 *   weekly slots and no sessions that will ever happen.
 *
 * An id argument is normally a uuid the model has read. Inside a `transaction(steps[])`
 * there is a case where no such uuid can exist: step 1 inserts the venue, step 2 creates
 * the class in it, and the id is assigned by the database between them. `STEPS_PARAM`
 * already says "select it back" — but it says so about `write` steps, and the model
 * reached for the same idea in an *operation* argument, which refused it.
 *
 * What that refusal cost is not obvious and is severe. `create_class` is the only thing
 * in the product that enqueues `materialize_sessions`, so a model pushed off the
 * operation and onto raw `insert into class` produces a business with classes, weekly
 * slots, and **no sessions that will ever happen** — no reminders, no registers, nothing
 * for a coach or a parent to be told about. Driven end to end, that is exactly what
 * happened: 3 classes, 6 slots, 0 sessions, and an admin told "I've set up your three
 * classes with their weekly timings".
 *
 * So the instinct is right and the encoding is now legal. Bounded hard: one parenthesised
 * SELECT, no semicolon, no statement chaining, nothing that writes. It runs inside the
 * plan's own transaction, under the plan author's RLS, so it can reach exactly what a
 * `write` step in the same plan could reach and no further.
 */
const ID_SUBQUERY = /^\(\s*select\s[\s\S]+\)$/i

export function isIdSubquery(v: unknown): v is string {
  const s = String(v ?? '').trim()
  if (!ID_SUBQUERY.test(s)) return false
  if (s.includes(';')) return false
  return !/\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|do|call)\b/i.test(s)
}

export function uid(v: string): string {
  const s = String(v ?? '').trim()
  if (isIdSubquery(s)) return `(${s.replace(/^\(|\)$/g, '')})::uuid`
  if (!UUID_RE.test(s)) throw new Error(`sql: "${v}" is not an id`)
  return `'${s}'::uuid`
}

export function moneyLit(n: number): string {
  if (!Number.isFinite(n)) throw new Error('sql: non-finite money')
  return `${n.toFixed(2)}::numeric`
}

export function jsonLit(v: unknown): string {
  return `${lit(JSON.stringify(v ?? null))}::jsonb`
}

export { UUID_RE }

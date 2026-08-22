/**
 * lib/agent/sql-trace.ts — every statement the MODEL wrote, exactly as it wrote it.
 *
 * @mechanism captureSql — records every statement the model authored at both places one
 *   reaches Postgres — `modelQuery` for a read, `runSteps` for each write inside a plan
 *   — untruncated, with the role it ran as, the row count and the whole error text.
 *   Captures nest rather than replace, and `recordSql` takes a thunk, so a closed
 *   capture costs one null check and allocates nothing. Without it a plan carrying six
 *   writes left ONE clipped trace row, and which of the six Postgres refused, and what
 *   it said, was written down nowhere.
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * The flight recorder (`turn.tool_calls`) is a record of TOOL CALLS, and it caps
 * every value at 4,000 characters because it is stored on every turn forever. That
 * is the right shape for production and the wrong shape for an instrument: a probe
 * asking "can this model write SQL" needs the statement byte for byte, the whole
 * error Postgres returned, and the rows that came back — and it needs them for the
 * statements that never appear in a tool trace at all.
 *
 * There are exactly two places a model-authored statement reaches Postgres:
 *
 *   - `modelQuery` (lib/db.ts)   — the `read` tool. One SELECT, wrapped in a row cap.
 *   - `runSteps` (lib/agent/plan.ts) — a `{"write": …}` plan step, and the INSERT
 *     that `{"adjust": …}` is sugar for.
 *
 * Only the first has ever been visible, and only through the tool trace. A plan
 * carrying six writes recorded ONE trace row — the `plan` call — whose `args` held
 * the steps as a JSON string clipped at 4,000 characters, and whose `result` was a
 * summary. Which of the six statements Postgres refused, and what it said, was not
 * written down anywhere. That is the half of the SQL surface this product most
 * needed to see, and it was the half nothing recorded.
 *
 * WHAT IT COSTS WHEN IT IS OFF
 * -----------------------------------------------------------------------------
 * One null check per statement. `sink` is null unless a harness has opened a
 * capture, so nothing is allocated, nothing is copied, and no row is stored. This
 * is deliberately NOT wired to the database: it is an in-process instrument for a
 * driving harness, not a second audit trail. `audit_entry` remains the record of
 * what changed; this is the record of what was ATTEMPTED, which is a different
 * question and only interesting while somebody is watching.
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * One statement the model authored, as it was sent and as Postgres answered.
 *
 * **There is no timestamp on this, deliberately.** A capture is an ordered array
 * and the order IS the sequence, so a clock here would add nothing an index does
 * not already give. It would also have to be the HOST clock — these records are
 * about a process, not about the business's day — and this repo's one absolute
 * is that nothing under `lib/` reads the host clock for anything. A field that
 * has to be excused by an allowlist to exist is a field worth not having.
 */
export type SqlRecord = {
  /** Where it came from. `adjust` is the one statement the runtime composes on the model's behalf. */
  kind: 'read' | 'write' | 'adjust'
  /**
   * The statement, UNTRUNCATED and exactly as the model wrote it — before the
   * row-cap wrapper `modelQuery` puts around a read, because what is under review
   * is the model's SQL and not the runtime's envelope.
   */
  sql: string
  /** The Postgres role it ran as: `readonly` for a read, `user` or `service` for a write. */
  role: string
  academyId: string | null
  personId: string | null
  ms: number
  /** Rows returned by a SELECT, or rows AFFECTED by a write. Null when it errored. */
  rowCount: number | null
  /** A read that hit the 10k cap. The distinction a count read off the result gets wrong. */
  truncated?: boolean
  /**
   * The full rows, when the capture asked for them. Off by default even during a
   * capture: a probe reading a whole roster does not need the roster echoed into
   * its report, and a report nobody can open is a report nobody reads.
   */
  rows?: unknown[]
  /** The whole error text. Never clipped: the useful half of a Postgres error is the end of it. */
  error?: string
  /** Free-form label from the call site — the plan's intent, the read's stated purpose. */
  note?: string
  /**
   * The turn that sent it.
   *
   * F-BZ: a drain runs several independent job handlers in one window and they all
   * landed in one undifferentiated list, so `_capture.ts` could split a four-handler
   * beat into four records for its rounds and its messages but not for its SQL. Every
   * capture is now scoped to one async context, so the list is already per-turn — this
   * carries the answer across a nesting, where an outer capture wrapping a whole arc
   * receives statements from every turn inside it.
   */
  turnId?: string
}

/**
 * One open capture. `parent` is the capture this one was opened inside, so a record
 * lands in the innermost list and in every list enclosing it.
 */
type Capture = {
  collected: SqlRecord[]
  withRows: boolean
  turnId?: string
  parent: Capture | null
}

/**
 * @mechanism captures — the open capture is held in async-local storage rather than in
 *   a module variable, so two turns running at once in one process cannot corrupt each
 *   other's record. The module-global version was documented as "not concurrent-safe,
 *   and deliberately so — one process, one driver at a time", which is true of a
 *   harness and false of the deployed product: Fluid Compute reuses one function
 *   instance across concurrent requests. Two overlapping turns there did not merely
 *   interleave, they lost data — turn A's statements were pushed into turn B's array,
 *   and when A finished first it restored `sink = null` and silently closed B's capture
 *   for the rest of the turn. Nothing anywhere would have said so.
 */
const captures = new AsyncLocalStorage<Capture>()

/** True while a capture is open. Call sites check this before assembling anything. */
export function sqlTraceOn(): boolean {
  return captures.getStore() !== undefined
}

/**
 * True while ANY capture in the chain asked for row bodies.
 *
 * The walk is not a detail. Production opens a `rows: false` capture around every
 * turn; a drive wraps that in a `rows: true` one. Reading only the innermost would
 * mean the harness stopped receiving the rows it asks for the moment the product
 * started recording itself — an instrument broken by the thing it measures.
 */
export function sqlTraceRows(): boolean {
  for (let c: Capture | null = captures.getStore() ?? null; c; c = c.parent) if (c.withRows) return true
  return false
}

/**
 * Report a statement. A no-op — one null check — unless a capture is open.
 *
 * Takes a THUNK rather than a record so that a call site pays nothing to build
 * the record when nobody is listening. `modelQuery` would otherwise copy every
 * returned row on every read in production to fill a field that is discarded.
 */
export function recordSql(make: () => SqlRecord): void {
  const innermost = captures.getStore()
  if (!innermost) return
  try {
    const record = make()
    if (record.turnId === undefined) {
      for (let c: Capture | null = innermost; c; c = c.parent) {
        if (c.turnId) {
          record.turnId = c.turnId
          break
        }
      }
    }
    for (let c: Capture | null = innermost; c; c = c.parent) c.collected.push(record)
  } catch {
    // An instrument must never be able to fail the thing it is measuring.
  }
}

/**
 * Run `fn` with a capture open, and return everything the model sent alongside
 * whatever `fn` returned.
 *
 * Captures NEST rather than replace: a record lands in the innermost list and in
 * every list enclosing it, so a harness that wraps a whole arc and the product's own
 * per-turn capture inside it both get a complete answer.
 *
 * They are scoped to the async context that opened them, which is what makes the
 * product able to hold one per turn. Work started inside a capture is attributed to
 * it even if it settles after `fn` returned; work started outside one never is.
 */
export async function captureSql<T>(
  opts: { rows?: boolean; turnId?: string },
  fn: () => Promise<T>,
): Promise<{ value: T; sql: SqlRecord[] }> {
  const capture: Capture = {
    collected: [],
    withRows: opts.rows ?? false,
    ...(opts.turnId ? { turnId: opts.turnId } : {}),
    parent: captures.getStore() ?? null,
  }
  const value = await captures.run(capture, fn)
  return { value, sql: capture.collected }
}

/**
 * Everything the innermost open capture has collected so far, without draining it.
 *
 * This is how a turn reads its own statements back at the point it writes its record,
 * from inside the capture it is already running in.
 */
export function currentSql(): SqlRecord[] {
  const c = captures.getStore()
  return c ? c.collected.slice() : []
}

/**
 * Take everything the open capture has collected since the last drain.
 *
 * @mechanism drainSql — attributes statements to the turn that produced them with no
 *   clock and no second capture: the list is append-only and in order, so everything
 *   since the last drain belongs to the turn that just finished. It is what lets one
 *   capture wrap a whole arc while the record stays per-turn, including where a turn is
 *   driven in two pieces — the message, then the thumb on the button — which a per-turn
 *   capture could only reach by restructuring the loop to suit the instrument.
 *
 * A driver that walks many turns under ONE capture needs to attribute statements
 * to the turn that produced them, and there is deliberately no timestamp on a
 * record to do it with (see the type above). Draining at a turn boundary is the
 * attribution: the array is append-only and in order, so everything since the
 * last drain belongs to the turn that just finished.
 *
 * Nesting a capture per turn would do the same job, but only where the turn is a
 * single callback. `probe-model` drives a turn in two pieces — the message, then
 * the thumb on the button, with world reads between them — and wrapping both in
 * one callback would have meant restructuring the loop to suit the instrument.
 */
export function drainSql(): SqlRecord[] {
  const c = captures.getStore()
  if (!c) return []
  return c.collected.splice(0, c.collected.length)
}

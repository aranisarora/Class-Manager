/**
 * lib/agent/turn-trace.ts — the flight recorder, uncapped, while an instrument watches.
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * `turn.tool_calls` is stored on every turn forever, so every value on its way in
 * is clipped at 4,000 characters. That is the right shape for production and the
 * wrong shape for an instrument, for exactly the reason `sql-trace.ts` gives about
 * the write half: what is under review is what the model actually sent and what
 * actually came back, and the useful half of a long value is usually the end of
 * it.
 *
 * Measured on the runs this repo already has: a `plan` carrying six writes is a
 * JSON string well past the cap, so the recorded `args` ended mid-step; a `read`
 * returning two hundred rows was clipped to the first handful; and the reasoning
 * on the hardest turns — the long deliberations, the ones a reader most needs —
 * was the reasoning most likely to be cut. An instrument that goes blindest
 * exactly where the turns are hardest is not an instrument.
 *
 * WHAT IT DOES
 * -----------------------------------------------------------------------------
 * One boolean. While a harness holds a capture open, `evidence()` in `loop.ts`
 * stops clipping and the whole value is recorded. Nothing else changes: the same
 * rows, in the same column, in the same order.
 *
 * THE ONE THING IT MUST NEVER TOUCH
 * -----------------------------------------------------------------------------
 * The cap lift applies to the RECORDER and to nothing else. `loop.ts` also uses
 * `traceValue` to build the history it hands back to the model — `[read came
 * back: …]` — and lifting that cap would change what the model sees. An
 * instrument that alters the thing it measures is worse than no instrument, so
 * that call site keeps `traceValue` directly and this module is deliberately not
 * reachable from it.
 *
 * WHAT IT COSTS WHEN OFF
 * -----------------------------------------------------------------------------
 * One integer comparison per recorded value. `depth` is 0 in production and
 * nothing here allocates.
 */

let depth = 0

/**
 * The out-of-process half.
 *
 * `probe-model` and `drive-week` run the loop themselves and can hold a capture
 * open around it. `drive` cannot: it posts to the emulator API exactly as a human
 * does, deliberately, so there is no second code path to keep honest — and the
 * turn it is measuring runs inside the dev server, in another process, where no
 * capture of this one's is open.
 *
 * So the dev server is told at startup instead:
 *
 *     PROBE_FULL_TRACE=1 npm run dev
 *
 * Read once at module load rather than per call, because it is a property of how
 * the process was started and a value that could change mid-run would make two
 * turns of one drive incomparable. Absent in production by construction: nothing
 * sets it, and a deploy that did would only ever store more of its own evidence.
 */
const ALWAYS = process.env.PROBE_FULL_TRACE === '1'

/** True while a harness has a capture open, or for a whole process told to. */
export function fullTraceOn(): boolean {
  return ALWAYS || depth > 0
}

/**
 * Run `fn` with the recorder uncapped.
 *
 * Nests by counting rather than by saving and restoring a sink, because there is
 * nothing to collect: the records land in `turn.tool_calls` as they always did,
 * and the only question is how much of each one survives. Two harnesses nested
 * around the same turn therefore agree by construction.
 *
 * `finally` rather than a plain decrement: a driver that throws mid-arc must not
 * leave the process recording without limit for the rest of its life.
 */
export async function captureFullTrace<T>(fn: () => Promise<T>): Promise<T> {
  depth += 1
  try {
    return await fn()
  } finally {
    depth -= 1
  }
}

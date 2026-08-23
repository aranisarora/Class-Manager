/**
 * _judge-text — one turn of a run, rendered as plain text for something that has
 * to judge it. Shared, so the judges cannot drift apart.
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * There were three renderings of "one turn, for a judge" and they disagreed
 * about what a turn IS:
 *
 *   `judge-slice.mjs`  read `record.json` and showed the SQL and the rows, but
 *                      never showed what the model was told.
 *   `judge-feed.mjs`   read the database live and showed the context as
 *                      "LOOP INTERVENED", which is not what it is.
 *   `judge.mjs`        read the database, dropped every trace row whose name
 *                      begins with "(" — `(context)`, `(model)`, `(reflection)`
 *                      — and showed no SQL and no rows at all, while its own
 *                      docstring claimed "every query and every row that came
 *                      back". That is the one an LLM reads.
 *
 * So the thing deciding whether an answer was DERIVABLE could not see what the
 * model was given, and the thing grading TRUTH could not see the rows. This
 * module is the single answer to "what does one turn look like", and the two
 * judges call it instead of each keeping their own.
 *
 * IT RENDERS THE RECORD, NOT THE DATABASE
 * -----------------------------------------------------------------------------
 * `turns.jsonl` is appended one line per turn while the run walks and
 * `record.json` is rebuilt after each one, so the record is live now — the
 * reason both judges gave for reading around it ("the copy does not exist until
 * the process exits") stopped being true on 20 Aug 2026. The record carries what
 * the `turn` table cannot: the SQL, the rows, what changed, the harness's own
 * failures, and an untruncated trace — `turn.tool_calls` is clipped at 4,000
 * characters unless the server was started with `PROBE_FULL_TRACE=1`.
 *
 * NOTHING IS CUT SILENTLY. `cap` is generous and says how much it dropped when
 * it bites, because a judge who cannot tell a short result from a clipped one
 * cannot tell absence from a bug.
 */

/** The one cap, so two judges cannot quietly show different amounts. */
export const JUDGE_CAP = 24_000

export const clip = (s, cap = JUDGE_CAP) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? null, null, 2)
  return t.length <= cap ? t : `${t.slice(0, cap)}\n…[CUT — ${t.length - cap} more chars of ${t.length}]`
}

/**
 * What the model was told, first — because it is what the thinking is a response
 * to, and because a figure the context already carried is not an invention.
 *
 * The cut line is the point of the whole section: `sql` below holds these same
 * reads WHOLE, so a judge comparing the reply against the rows is comparing it
 * against something the model never saw.
 */
function told(t, cap) {
  const ctx = (t.rounds ?? []).find((r) => r.name === '(context)')
  if (!ctx) {
    const ran = (t.rounds ?? []).length
    return ran
      ? '\n--- WHAT IT WAS TOLD ---\n(no context row on this turn — the trace has rounds but no `(context)`)'
      : '\n--- WHAT IT WAS TOLD ---\n(no model was called on this turn: a tap, or a drain that ran only jobs)'
  }
  const a = ctx.args ?? {}
  const tail = typeof a.tail === 'string' ? a.tail : ''
  const cuts = Number(t.contextCuts ?? (tail.match(/… \(truncated\)/g) ?? []).length)
  const head = `\n--- WHAT IT WAS TOLD (${tail.length} chars of tail over a ${
    a.prefix?.chars ?? '?'
  }-char cached prefix, ${a.history ?? '?'} prior messages) ---`
  const warn = cuts
    ? `\n!! ${cuts} replayed read${cuts === 1 ? ' was' : 's were'} CUT AT 1,400 CHARS before the model saw ` +
      `${cuts === 1 ? 'it' : 'them'}. The same reads appear whole under WHAT IT QUERIED — that copy is the ` +
      `log's, not the model's. Judge the answer against this block.`
    : ''
  return `${head}${warn}\n${clip(tail, cap)}`
}

/** Every round, in order, with the reasoning verbatim. */
function thinking(t, cap) {
  const out = ['\n--- WHAT IT WAS THINKING, ROUND BY ROUND ---']
  const rounds = (t.rounds ?? []).filter((r) => r.name !== '(context)')
  if (!rounds.length) return `${out[0]}\n(nothing — no model call on this turn)`
  /**
   * A drain is several handlers in one record, and `round` restarts at 0 for
   * each of them, so an unbroken list reads as one long deliberation that never
   * happened. Where the rounds carry more than one `turnId`, say where each act
   * begins: thirty rounds over four turnIds is four turns, not a thirty-round
   * turn, and `MAX_TOOL_ROUNDS` is five.
   */
  const acts = [...new Set(rounds.map((r) => r.turnId).filter(Boolean))]
  let act = null
  for (const r of rounds) {
    if (acts.length > 1 && r.turnId && r.turnId !== act) {
      act = r.turnId
      out.push(`
=== act ${acts.indexOf(act) + 1} of ${acts.length} | product turn ${act} ===`)
    }
    if (r.reasoning) out.push(`\n[round ${r.round}] THINKING:\n${clip(r.reasoning, cap)}`)
    if (r.name === '(model)') {
      const said = typeof r.args === 'string' ? r.args : r.args?.message?.content
      if (said) out.push(`[round ${r.round}] DRAFTED: ${clip(said, cap)}`)
      if (r.result) out.push(`[round ${r.round}] spend: ${JSON.stringify(r.result)}`)
      continue
    }
    // A pseudo-row that is not the model is the loop saying what it did to the
    // turn — a reflection, a refusal, the R10 shadow. It is evidence and it was
    // being filtered out of the feed entirely.
    if (String(r.name).startsWith('(')) {
      out.push(`[round ${r.round}] THE LOOP: ${r.name}${r.result ? ` — ${clip(r.result, cap)}` : ''}`)
      continue
    }
    out.push(`[round ${r.round}] CALLED ${r.name}: ${clip(r.args, cap)}`)
    if (r.error) out.push(`  REFUSED: ${clip(r.error, cap)}`)
    else if (r.result !== undefined) out.push(`  CAME BACK: ${clip(r.result, cap)}`)
  }
  return out.join('\n')
}

/** Byte for byte, with what Postgres answered — the refused ones included. */
function queried(t, cap) {
  const sql = t.sql ?? []
  if (!sql.length) return '\n--- WHAT IT QUERIED ---\n(no statements recorded)'
  const out = ['\n--- WHAT IT QUERIED (this is the LOG\'s copy, uncut) ---']
  for (const s of sql) {
    const flag = s.error ? `!! ERROR: ${s.error}` : s.rowCount === 0 ? '!! MATCHED NOTHING' : `-- ${s.rowCount} rows`
    out.push(`\n[${s.kind}${s.rolledBack ? ' · PREVIEW — rolled back' : ''}${s.note ? ` · ${s.note}` : ''}] ${flag}\n${clip(s.sql, cap)}`)
    if (s.rows !== undefined) out.push(`  came back: ${clip(s.rows, cap)}`)
  }
  return out.join('\n')
}

/**
 * What it changed, both sides.
 *
 * A write is recorded with its statement and its `rowCount` and never with its
 * rows, so until `changed` existed a judge grading CONSEQUENCE had a number and
 * no way to check it. These images come from the database's own trigger.
 */
function movedRows(t, cap) {
  if (!Array.isArray(t.changed)) {
    return t.wrote ? `\n--- WHAT IT CHANGED ---\n(${t.wrote} plan(s) committed; this run predates row-level capture)` : ''
  }
  if (!t.changed.length) return '\n--- WHAT IT CHANGED ---\n(nothing)'
  const out = [`\n--- WHAT IT CHANGED (${t.changed.length} row(s)) ---`]
  for (const c of t.changed) {
    out.push(`\n${c.table} · ${c.op} · ${c.pk ?? '—'}${c.intent ? `  [${c.intent}]` : ''}`)
    out.push(`  before: ${clip(c.before, cap)}`)
    out.push(`  after:  ${clip(c.after, cap)}`)
  }
  return out.join('\n')
}

/** Last, and judged as the person — including what they could tap. */
function reached(t, cap) {
  const msgs = t.messages ?? []
  if (!msgs.length) return '\n--- WHAT THE PERSON READ ---\n(nothing was sent)'
  const out = ['\n--- WHAT THE PERSON READ ---']
  for (const m of msgs) {
    const taps = [
      ...(m.buttons ?? []),
      ...(m.listRows ?? []).map((r) => `${r} (list)`),
      ...(m.link ? [`${m.link} (link)`] : []),
    ]
    out.push(
      `\nTO ${m.to ?? '?'}${m.suppressedReason ? ` [SUPPRESSED: ${m.suppressedReason}]` : ''}` +
        `${m.origin ? ` (${m.origin})` : ''}:\n${clip(m.body, cap)}\n  ${
          taps.length ? `tappable: ${taps.map((b) => `[${b}]`).join(' ')}` : '(nothing to tap)'
        }`,
    )
  }
  return out.join('\n')
}

/**
 * One whole turn, in the order JUDGING.md says to read it: what they typed,
 * what it was told, what it thought, what it queried, what it changed, and only
 * then what the person actually read.
 */
export function renderTurn(t, cap = JUDGE_CAP) {
  const head =
    `TURN ${t.n ?? '?'} · ${t.who ?? '?'} (${t.persona ?? '?'}) · ${t.at ?? '?'}` +
    ` · ${(t.rounds ?? []).length} rounds · ${t.ms ?? '?'}ms · ₹${Number(t.inr ?? 0).toFixed(4)}`
  const parts = [head, `\n--- WHAT THEY TYPED ---\n${t.tapped ? `[tapped: "${t.tapped}"]` : `"${t.say ?? ''}"`}`]
  // The harness's own failures go near the top: every number below may be read
  // off a query that did not run, and a reader has to know that before they
  // start weighing them.
  if (t.notes?.length) parts.push(`\n!! THE HARNESS COULD NOT COLLECT PART OF THIS TURN:\n- ${t.notes.join('\n- ')}`)
  if (t.intent) parts.push(`\n(what they were trying to get: ${t.intent})`)
  parts.push(told(t, cap), thinking(t, cap), queried(t, cap), movedRows(t, cap), reached(t, cap))
  if (t.error) parts.push(`\n--- THE TURN ERRORED ---\n${clip(t.error, cap)}`)
  return parts.filter(Boolean).join('\n')
}

/**
 * §17 — diffable runs.
 *
 * Run the same seeded scenario before and after a change and see what moved. For a conversational
 * product this is the only practical regression test, so the diff has to be readable by a human in
 * ten seconds: message-by-message alignment, what was added, removed and changed, and which way the
 * judge's scores and findings went.
 *
 * Pure. No database, no model, no runtime imports — so it runs in the browser as happily as in a
 * script.
 */

import type { SimEntry, SimRunResult } from './run'
import type { JudgeFinding, JudgeReport, JudgeSeverity } from './judge'

export type DiffOp = 'same' | 'changed' | 'added' | 'removed'

export type DiffChange = { field: string; from: string; to: string }

export type DiffRow = {
  op: DiffOp
  aIndex: number | null
  bIndex: number | null
  a: SimEntry | null
  b: SimEntry | null
  /** 0–1 on the aligned pair. 0 for added/removed. */
  similarity: number
  changes: DiffChange[]
}

export type ScoreMove = { key: string; a: number | null; b: number | null; delta: number | null }

export type RunSide = {
  runId: string
  label: string
  seed: string
  personaName: string
  goalText: string
  turns: number
  stopReason: SimRunResult['stopReason']
  clockAdvancedMs: number
  goalReached: boolean | null
  overall: number | null
  counts: Record<JudgeSeverity, number> | null
}

export type RunDiff = {
  a: RunSide
  b: RunSide
  /** Same seed, same persona, same goal. A diff across different scenarios is not a regression test. */
  comparable: boolean
  warnings: string[]
  rows: DiffRow[]
  counts: Record<DiffOp, number>
  scoreMovement: ScoreMove[]
  findings: {
    introduced: JudgeFinding[]
    fixed: JudgeFinding[]
    persisting: JudgeFinding[]
  }
  verdict: 'improved' | 'regressed' | 'mixed' | 'unchanged'
  summary: string
}

// ---------------------------------------------------------------------------
// text similarity
// ---------------------------------------------------------------------------

function normalise(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9₹]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function tokens(s: string): string[] {
  return normalise(s).split(' ').filter(Boolean)
}

/** Dice coefficient over word bags. Cheap, order-insensitive, good enough for message alignment. */
export function similarity(a: string, b: string): number {
  const A = tokens(a)
  const B = tokens(b)
  if (A.length === 0 && B.length === 0) return 1
  if (A.length === 0 || B.length === 0) return 0
  const bag = new Map<string, number>()
  for (const w of A) bag.set(w, (bag.get(w) ?? 0) + 1)
  let hit = 0
  for (const w of B) {
    const n = bag.get(w) ?? 0
    if (n > 0) {
      hit++
      bag.set(w, n - 1)
    }
  }
  return (2 * hit) / (A.length + B.length)
}

// ---------------------------------------------------------------------------
// alignment
// ---------------------------------------------------------------------------

const MEANINGFUL: SimEntry['kind'][] = ['text', 'tap', 'message', 'suppressed', 'clock']
const GAP = -0.35

function meaningful(t: SimEntry[]): SimEntry[] {
  return t.filter((e) => MEANINGFUL.includes(e.kind))
}

function pairScore(a: SimEntry, b: SimEntry): number {
  if (a.actor !== b.actor) return -1
  if (a.kind === 'clock' || b.kind === 'clock') return a.kind === b.kind ? 0.6 : -1
  const sim = similarity(a.body, b.body)
  const kindBonus = a.kind === b.kind ? 0.15 : -0.1
  return sim * 1.8 - 0.25 + kindBonus
}

/** Needleman–Wunsch. Global alignment is right here: two runs of the same script, not two documents. */
function align(A: SimEntry[], B: SimEntry[]): DiffRow[] {
  const n = A.length
  const m = B.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) dp[i][0] = dp[i - 1][0] + GAP
  for (let j = 1; j <= m; j++) dp[0][j] = dp[0][j - 1] + GAP
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = Math.max(
        dp[i - 1][j - 1] + pairScore(A[i - 1], B[j - 1]),
        dp[i - 1][j] + GAP,
        dp[i][j - 1] + GAP,
      )
    }
  }

  const rows: DiffRow[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + pairScore(A[i - 1], B[j - 1])) {
      const a = A[i - 1]
      const b = B[j - 1]
      const sim = a.kind === 'clock' && b.kind === 'clock' ? 1 : similarity(a.body, b.body)
      const changes = entryChanges(a, b)
      rows.push({
        op: changes.length === 0 ? 'same' : 'changed',
        aIndex: a.index,
        bIndex: b.index,
        a,
        b,
        similarity: Number(sim.toFixed(3)),
        changes,
      })
      i--
      j--
    } else if (i > 0 && dp[i][j] === dp[i - 1][j] + GAP) {
      rows.push({ op: 'removed', aIndex: A[i - 1].index, bIndex: null, a: A[i - 1], b: null, similarity: 0, changes: [] })
      i--
    } else {
      rows.push({ op: 'added', aIndex: null, bIndex: B[j - 1].index, a: null, b: B[j - 1], similarity: 0, changes: [] })
      j--
    }
  }
  return rows.reverse()
}

function buttonLine(e: SimEntry): string {
  return (e.buttons ?? []).map((b) => b.title).join(' | ')
}

function entryChanges(a: SimEntry, b: SimEntry): DiffChange[] {
  const out: DiffChange[] = []
  // Compared raw, not normalised: a reworded message is exactly what a diff is for.
  if (a.body.trim() !== b.body.trim()) out.push({ field: 'body', from: a.body, to: b.body })
  const ab = buttonLine(a)
  const bb = buttonLine(b)
  if (ab !== bb) out.push({ field: 'buttons', from: ab || '(none)', to: bb || '(none)' })
  if ((a.catalogId ?? null) !== (b.catalogId ?? null)) {
    out.push({ field: 'catalog', from: a.catalogId ?? '(composed)', to: b.catalogId ?? '(composed)' })
  }
  if ((a.templateName ?? null) !== (b.templateName ?? null)) {
    out.push({ field: 'template', from: a.templateName ?? '(in window)', to: b.templateName ?? '(in window)' })
  }
  if ((a.suppressedReason ?? null) !== (b.suppressedReason ?? null)) {
    out.push({ field: 'suppressed', from: a.suppressedReason ?? '(sent)', to: b.suppressedReason ?? '(sent)' })
  }
  if (a.kind !== b.kind) out.push({ field: 'kind', from: a.kind, to: b.kind })
  return out
}

// ---------------------------------------------------------------------------
// judge movement
// ---------------------------------------------------------------------------

function findingKey(f: JudgeFinding): string {
  return `${f.kind}|${normalise(f.quote).slice(0, 50)}|${normalise(f.explanation).slice(0, 50)}`
}

function side(r: SimRunResult): RunSide {
  const j: JudgeReport | null | undefined = r.judge
  return {
    runId: r.runId,
    label: r.label,
    seed: r.seed,
    personaName: r.persona?.name ?? '',
    goalText: r.goal?.text ?? '',
    turns: r.turns,
    stopReason: r.stopReason,
    clockAdvancedMs: r.clockAdvancedMs,
    goalReached: j ? j.goalReached : r.personaClaimsGoalReached,
    overall: j ? j.scores.overall : null,
    counts: j ? j.counts : null,
  }
}

// ---------------------------------------------------------------------------
// diffRuns
// ---------------------------------------------------------------------------

export function diffRuns(a: SimRunResult, b: SimRunResult): RunDiff {
  const warnings: string[] = []
  if (a.seed !== b.seed) warnings.push(`Different seeds (${a.seed} vs ${b.seed}) — the runs are not comparable as a regression test.`)
  if (a.persona?.name !== b.persona?.name) warnings.push(`Different personas (${a.persona?.name} vs ${b.persona?.name}).`)
  if (a.goal?.text !== b.goal?.text) warnings.push(`Different goals (${a.goal?.text} vs ${b.goal?.text}).`)
  if (a.contactId !== b.contactId) warnings.push('Different contacts — the worlds may not match.')
  const comparable = warnings.length === 0

  const rows = align(meaningful(a.transcript), meaningful(b.transcript))
  const counts: Record<DiffOp, number> = { same: 0, changed: 0, added: 0, removed: 0 }
  for (const r of rows) counts[r.op]++

  const ja = a.judge ?? null
  const jb = b.judge ?? null
  const scoreMovement: ScoreMove[] = (['overall', 'clarity', 'efficiency', 'correctness', 'doctrine'] as const).map((k) => {
    const av = ja ? ja.scores[k] : null
    const bv = jb ? jb.scores[k] : null
    return { key: k, a: av, b: bv, delta: av !== null && bv !== null ? Number((bv - av).toFixed(1)) : null }
  })
  scoreMovement.push({
    key: 'turns',
    a: a.turns,
    b: b.turns,
    delta: Number((b.turns - a.turns).toFixed(1)),
  })

  const aF = ja?.findings ?? []
  const bF = jb?.findings ?? []
  const aKeys = new Map(aF.map((f) => [findingKey(f), f]))
  const bKeys = new Map(bF.map((f) => [findingKey(f), f]))
  const introduced = bF.filter((f) => !aKeys.has(findingKey(f)))
  const fixed = aF.filter((f) => !bKeys.has(findingKey(f)))
  const persisting = bF.filter((f) => aKeys.has(findingKey(f)))

  const weight = (f: JudgeFinding) => (f.severity === 'critical' ? 4 : f.severity === 'major' ? 2 : f.severity === 'minor' ? 1 : 0.25)
  const introducedWeight = introduced.filter((f) => f.kind !== 'good').reduce((s, f) => s + weight(f), 0)
  const fixedWeight = fixed.filter((f) => f.kind !== 'good').reduce((s, f) => s + weight(f), 0)
  const overallDelta = scoreMovement[0].delta

  let verdict: RunDiff['verdict']
  const netFindings = fixedWeight - introducedWeight
  const scoreSignal = overallDelta ?? 0
  if (counts.changed === 0 && counts.added === 0 && counts.removed === 0 && netFindings === 0 && scoreSignal === 0) {
    verdict = 'unchanged'
  } else if (netFindings > 0 && scoreSignal >= 0) {
    verdict = 'improved'
  } else if (netFindings < 0 && scoreSignal <= 0) {
    verdict = 'regressed'
  } else if (netFindings === 0) {
    verdict = scoreSignal > 0 ? 'improved' : scoreSignal < 0 ? 'regressed' : 'unchanged'
  } else {
    verdict = 'mixed'
  }

  const bits: string[] = []
  bits.push(
    `${counts.same} unchanged, ${counts.changed} reworded, ${counts.added} new, ${counts.removed} gone.`,
  )
  if (overallDelta !== null) {
    bits.push(
      overallDelta === 0
        ? `Judge overall held at ${jb?.scores.overall}/10.`
        : `Judge overall ${overallDelta > 0 ? 'up' : 'down'} ${Math.abs(overallDelta)} to ${jb?.scores.overall}/10.`,
    )
  }
  if (introduced.length) {
    const worst = introduced.filter((f) => f.kind !== 'good').sort((x, y) => weight(y) - weight(x))[0]
    if (worst) bits.push(`New: ${worst.severity} ${worst.kind} — ${worst.explanation}`)
  }
  if (fixed.length) {
    const best = fixed.filter((f) => f.kind !== 'good').sort((x, y) => weight(y) - weight(x))[0]
    if (best) bits.push(`Gone: ${best.severity} ${best.kind} — ${best.explanation}`)
  }
  if (a.turns !== b.turns) {
    bits.push(`The user needed ${b.turns > a.turns ? 'more' : 'fewer'} messages: ${a.turns} → ${b.turns}.`)
  }
  if (!comparable) bits.unshift('⚠ ' + warnings.join(' '))

  return {
    a: side(a),
    b: side(b),
    comparable,
    warnings,
    rows,
    counts,
    scoreMovement,
    findings: { introduced, fixed, persisting },
    verdict,
    summary: bits.join(' '),
  }
}

// ---------------------------------------------------------------------------
// plain-text rendering, for scripts and logs
// ---------------------------------------------------------------------------

function label(e: SimEntry | null): string {
  if (!e) return ''
  const who = e.actor === 'persona' ? 'USER' : e.actor === 'clock' ? 'CLOCK' : 'BOT'
  const tail = e.kind === 'tap' ? `[${e.tapped?.title ?? e.body}]` : e.body.replace(/\s+/g, ' ')
  return `${who}: ${tail}`
}

export function formatDiff(d: RunDiff, width = 68): string {
  const L: string[] = []
  const clip = (s: string) => (s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width))
  L.push(`A  ${d.a.label}  (${d.a.turns} turns, ${d.a.stopReason}${d.a.overall !== null ? `, ${d.a.overall}/10` : ''})`)
  L.push(`B  ${d.b.label}  (${d.b.turns} turns, ${d.b.stopReason}${d.b.overall !== null ? `, ${d.b.overall}/10` : ''})`)
  L.push(`VERDICT: ${d.verdict.toUpperCase()}  —  ${d.summary}`)
  L.push('')
  for (const r of d.rows) {
    const mark = r.op === 'same' ? '  ' : r.op === 'changed' ? '~ ' : r.op === 'added' ? '+ ' : '- '
    L.push(`${mark}${clip(label(r.a))} | ${label(r.b)}`)
    for (const c of r.changes) {
      if (c.field === 'body') continue
      L.push(`   ${' '.repeat(width)}   ${c.field}: ${c.from} → ${c.to}`)
    }
  }
  if (d.findings.introduced.length) {
    L.push('')
    L.push('INTRODUCED:')
    for (const f of d.findings.introduced) L.push(`  [${f.severity}] ${f.kind} @${f.atIndex} — ${f.explanation}`)
  }
  if (d.findings.fixed.length) {
    L.push('')
    L.push('FIXED:')
    for (const f of d.findings.fixed) L.push(`  [${f.severity}] ${f.kind} @${f.atIndex} — ${f.explanation}`)
  }
  return L.join('\n')
}

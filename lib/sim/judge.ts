/**
 * §17 — the judge agent.
 *
 * Reviews one recorded run and reports exactly what §17 asks: where did the user get confused, hit
 * a dead end, repeat themselves, get a wrong answer, or receive a message that fails §2.8 ("would
 * this recipient have asked for it?").
 *
 * Two halves, deliberately:
 *  - **Mechanical findings**, computed here from the transcript. Anything a string can decide — API
 *    limits, verbatim repetition, a uuid that survived lint, a rupee amount in a player's thread —
 *    is decided by code, so the model neither has to spot it nor gets to argue with it.
 *  - **Model findings**, for everything that needs reading: confusion, dead ends, wrong answers,
 *    tone, and whether a proactive message is one its recipient would have wanted.
 *
 * Every finding carries a severity and a quote, so a report can be read without the transcript.
 */

import { env } from '@/lib/env'
import { withSession } from '@/lib/db'
import { generate } from '@/lib/agent/gemini'
import { LIMITS } from '@/lib/messaging/types'
import { hasTrait, TRAITS } from './personas'
import type { SimEntry, SimRunResult } from './run'

export type JudgeSeverity = 'critical' | 'major' | 'minor' | 'nit'

export type JudgeFindingKind =
  | 'confusion'
  | 'dead_end'
  | 'repetition'
  | 'wrong_answer'
  | 'unasked_for' // §2.8
  | 'privacy' // §6.7 — money-shaped rows reaching a player number
  | 'self_confirmation' // §18 — asked to confirm something to themselves
  | 'unconfirmed_claim' // §2.4 — claimed delivery it cannot see
  | 'render_limit' // §17 — would not render on the real API
  | 'lint' // §4.5 — internal identifiers, raw timestamps
  | 'good'

export type JudgeFinding = {
  kind: JudgeFindingKind
  severity: JudgeSeverity
  /** Index into `run.transcript`. -1 when the finding is about the run as a whole. */
  atIndex: number
  /** The words themselves. A finding without a quote is an opinion. */
  quote: string
  explanation: string
  suggestion: string
  source: 'mechanical' | 'model'
}

export type JudgeScores = {
  /** Did the user understand what was said and what to do next? */
  clarity: number
  /** How much of the conversation was wasted? */
  efficiency: number
  /** Were the facts and numbers right? */
  correctness: number
  /** §4.1 + §2.8 — quiet, honest, no self-confirmation, next step offered. */
  doctrine: number
  overall: number
}

export type JudgeCriterion = { criterion: string; met: boolean; evidence: string }

export type JudgeReport = {
  runId: string
  seed: string
  goalReached: boolean
  goalEvidence: string
  turnsToGoal: number | null
  scores: JudgeScores
  criteria: JudgeCriterion[]
  findings: JudgeFinding[]
  summary: string
  counts: Record<JudgeSeverity, number>
  model: string
  ms: number
  error?: string
}

// ---------------------------------------------------------------------------
// Mechanical findings
// ---------------------------------------------------------------------------

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
const ISO_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?\b/
const TABLE_RE =
  /\b(academy_admin|tally_line|class_slot|session_coach|memory_fact|view_spec|enrollment|attendance|sim_run|contact_id|person_id|academy_id)\b/i
const MONEY_RE = /(₹\s?\d|(\brs\.?\s?\d)|\binr\s?\d|\b\d[\d,]*(\.\d{2})?\s?(rupees|rs\b)|\b(tally|invoice|outstanding|balance due|amount due|unpaid|dues)\b)/i
const DELIVERED_RE = /\b(delivered|they have read|has read it|seen it|received it)\b/i

function truncate(s: string, n = 180): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Cheap bag-of-words similarity. Good enough to catch "you already said that". */
function similarity(a: string, b: string): number {
  const A = new Set(normalise(a).split(' ').filter(Boolean))
  const B = new Set(normalise(b).split(' ').filter(Boolean))
  if (A.size === 0 || B.size === 0) return 0
  let hit = 0
  for (const w of A) if (B.has(w)) hit++
  return (2 * hit) / (A.size + B.size)
}

export function mechanicalFindings(run: SimRunResult): JudgeFinding[] {
  const out: JudgeFinding[] = []
  const add = (f: Omit<JudgeFinding, 'source'>) => out.push({ ...f, source: 'mechanical' })

  const outbound = run.transcript.filter((e) => e.actor === 'system' && e.kind === 'message')
  const personaSaid = run.transcript.filter((e) => e.actor === 'persona' && e.kind === 'text')
  const isPlayerThread = hasTrait(run.persona, TRAITS.playerNumber) || run.roles.includes('player')

  // --- §17: it must render on the real API -------------------------------
  for (const e of outbound) {
    const hasInteractive = !!(e.buttons && e.buttons.length)
    const cap = hasInteractive ? LIMITS.bodyChars : LIMITS.textChars
    if (e.body.length > cap) {
      add({
        kind: 'render_limit',
        severity: 'critical',
        atIndex: e.index,
        quote: truncate(e.body),
        explanation: `${e.body.length} characters against a ${cap}-character limit — the Cloud API would reject this message.`,
        suggestion: 'Split it, or move the dense part to a web view (§15).',
      })
    }
    const btns = (e.buttons ?? []).filter((b) => b.via === 'button')
    const rows = (e.buttons ?? []).filter((b) => b.via === 'list')
    if (btns.length > LIMITS.buttons) {
      add({
        kind: 'render_limit',
        severity: 'critical',
        atIndex: e.index,
        quote: btns.map((b) => b.title).join(' | '),
        explanation: `${btns.length} reply buttons; the API allows ${LIMITS.buttons}.`,
        suggestion: 'Use a list picker, or drop the least likely option.',
      })
    }
    for (const b of btns) {
      if (b.title.length > LIMITS.buttonTitleChars) {
        add({
          kind: 'render_limit',
          severity: 'major',
          atIndex: e.index,
          quote: b.title,
          explanation: `Button title is ${b.title.length} characters; the API truncates at ${LIMITS.buttonTitleChars}.`,
          suggestion: 'Shorter verb-first label.',
        })
      }
    }
    if (rows.length > LIMITS.listRows) {
      add({
        kind: 'render_limit',
        severity: 'critical',
        atIndex: e.index,
        quote: `${rows.length} rows`,
        explanation: `${rows.length} list rows against a limit of ${LIMITS.listRows}.`,
        suggestion: 'Aggregate, paginate, or send a view link.',
      })
    }
    for (const r of rows) {
      if (r.title.length > LIMITS.listRowTitleChars) {
        add({
          kind: 'render_limit',
          severity: 'minor',
          atIndex: e.index,
          quote: r.title,
          explanation: `List row title is ${r.title.length} characters; the limit is ${LIMITS.listRowTitleChars}.`,
          suggestion: 'Move the detail into the row description.',
        })
      }
    }
    if (!e.body.trim() && !hasInteractive) {
      add({
        kind: 'render_limit',
        severity: 'critical',
        atIndex: e.index,
        quote: '(empty)',
        explanation: 'An outbound message with no body and nothing to tap. Nothing renders.',
        suggestion: 'If there is nothing to say, say nothing — do not send an empty message.',
      })
    }

    // --- §4.5 lint should have caught these before they left ------------
    const uuid = e.body.match(UUID_RE)
    if (uuid) {
      add({
        kind: 'lint',
        severity: 'major',
        atIndex: e.index,
        quote: truncate(e.body),
        explanation: `An internal identifier reached the user: ${uuid[0]}.`,
        suggestion: 'Layer 5 lint strips uuids (§4.5) — this one got through.',
      })
    }
    if (ISO_RE.test(e.body)) {
      add({
        kind: 'lint',
        severity: 'minor',
        atIndex: e.index,
        quote: truncate(e.body),
        explanation: 'A machine timestamp reached the user instead of the academy\'s idiom.',
        suggestion: `Render in ${run.timezone} — "Saturday 8:30am", not an ISO string.`,
      })
    }
    if (TABLE_RE.test(e.body)) {
      add({
        kind: 'lint',
        severity: 'minor',
        atIndex: e.index,
        quote: truncate(e.body),
        explanation: 'Schema vocabulary (a table or column name) leaked into user-facing copy.',
        suggestion: 'Speak the academy\'s language (§4.1 rule 3).',
      })
    }
    if (DELIVERED_RE.test(e.body) && e.status !== 'delivered' && e.status !== 'read') {
      add({
        kind: 'unconfirmed_claim',
        severity: 'major',
        atIndex: e.index,
        quote: truncate(e.body),
        explanation: `The message claims delivery or reading, but this send is only "${e.status ?? 'queued'}" (§2.4).`,
        suggestion: 'Say "sent" until a delivery receipt says otherwise.',
      })
    }

    // --- §6.7 — money-shaped content must never route to a player number --
    if (isPlayerThread && MONEY_RE.test(e.body)) {
      add({
        kind: 'privacy',
        severity: 'critical',
        atIndex: e.index,
        quote: truncate(e.body),
        explanation:
          'Money-shaped content arrived in a player\'s own thread. §6.7: tally lines and payments never route to a player number.',
        suggestion: 'Answer the non-money part and point them at the account holder.',
      })
    }
  }

  // --- suppressions the send path recorded --------------------------------
  for (const e of run.transcript) {
    if (e.kind !== 'suppressed' || !e.suppressedReason) continue
    const critical = e.suppressedReason === 'limit_violation' || e.suppressedReason === 'out_of_window_no_template'
    const expected = e.suppressedReason === 'self_confirmation' || e.suppressedReason === 'escalation_about_self'
    add({
      kind: expected ? 'good' : critical ? 'render_limit' : 'unasked_for',
      severity: expected ? 'nit' : critical ? 'major' : 'minor',
      atIndex: e.index,
      quote: truncate(e.body || e.suppressedReason),
      explanation: expected
        ? `The send path correctly dropped this (${e.suppressedReason}) — §18 working as designed.`
        : `A message was composed and then dropped by the send path: ${e.suppressedReason}.`,
      suggestion: expected ? 'No action.' : 'Composing something the send path will refuse is wasted work — check the gate order (§16.3).',
    })
  }

  // --- verbatim repetition, both directions -------------------------------
  for (let i = 1; i < outbound.length; i++) {
    for (let j = 0; j < i; j++) {
      if (similarity(outbound[i].body, outbound[j].body) > 0.92 && outbound[i].body.length > 24) {
        add({
          kind: 'repetition',
          severity: 'major',
          atIndex: outbound[i].index,
          quote: truncate(outbound[i].body),
          explanation: `The same message was sent again (first at entry ${outbound[j].index}). The user learned nothing new.`,
          suggestion: 'If nothing changed, say what changed instead of repeating the ask.',
        })
        break
      }
    }
  }
  for (let i = 1; i < personaSaid.length; i++) {
    for (let j = 0; j < i; j++) {
      if (similarity(personaSaid[i].body, personaSaid[j].body) > 0.75 && personaSaid[i].body.length > 12) {
        add({
          kind: 'confusion',
          severity: 'major',
          atIndex: personaSaid[i].index,
          quote: truncate(personaSaid[i].body),
          explanation: `The user asked the same thing again (first at entry ${personaSaid[j].index}) — the earlier answer did not land.`,
          suggestion: 'Answer the question that was asked, in the words it was asked in.',
        })
        break
      }
    }
  }

  // --- silence and dead ends ---------------------------------------------
  for (const e of run.transcript) {
    if (e.kind === 'note' && e.body.startsWith('silence')) {
      add({
        kind: 'dead_end',
        severity: 'major',
        atIndex: e.index,
        quote: run.transcript[e.index - 1]?.body ?? '(nothing)',
        explanation: 'The user sent something and nothing came back at all.',
        suggestion: 'Every inbound message gets a reply, even if the reply is "I cannot do that".',
      })
    }
    if (e.kind === 'note' && e.reason && /rejected|errored|failed/i.test(e.body)) {
      add({
        kind: 'dead_end',
        severity: 'critical',
        atIndex: e.index,
        quote: truncate(e.reason),
        explanation: 'The turn errored. From the user\'s side this is a message into a void.',
        suggestion: 'An error still owes the user a sentence.',
      })
    }
  }

  const last = [...run.transcript].reverse().find((e) => e.actor === 'system' && e.kind === 'message')
  if (run.stopReason === 'gave_up') {
    add({
      kind: 'dead_end',
      severity: 'major',
      atIndex: last?.index ?? -1,
      quote: truncate(last?.body ?? '(no reply)'),
      explanation: 'The user gave up before reaching their goal.',
      suggestion: 'Look at the last thing they were shown — that is where the path ended.',
    })
  }
  if (run.stopReason === 'max_turns') {
    add({
      kind: 'dead_end',
      severity: 'minor',
      atIndex: last?.index ?? -1,
      quote: truncate(last?.body ?? '(no reply)'),
      explanation: `The conversation hit its ${run.maxTurns}-turn ceiling without resolving.`,
      suggestion: 'A goal this simple should not take this many turns.',
    })
  }
  if (last && !(last.buttons && last.buttons.length) && run.stopReason !== 'goal') {
    add({
      kind: 'dead_end',
      severity: 'minor',
      atIndex: last.index,
      quote: truncate(last.body),
      explanation: 'The last message offered no next step to tap (§4.3).',
      suggestion: 'Offer the natural next step as a button after every action.',
    })
  }

  // --- frustration is a confusion signal ----------------------------------
  const peak = Math.max(0, ...run.transcript.map((e) => e.frustration ?? 0))
  if (peak >= 4) {
    const at = run.transcript.find((e) => (e.frustration ?? 0) >= 4)
    add({
      kind: 'confusion',
      severity: 'major',
      atIndex: at?.index ?? -1,
      quote: truncate(at?.body ?? ''),
      explanation: `The user's irritation peaked at ${peak}/5 — something in the preceding replies is not working.`,
      suggestion: 'Read the two messages before this one.',
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// The model half
// ---------------------------------------------------------------------------

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    goal_reached: { type: 'boolean', description: 'did the thing the user wanted actually happen — not merely get promised' },
    goal_evidence: { type: 'string', description: 'the entry index and the words that settle it' },
    turns_to_goal: { type: 'integer', description: 'user messages needed to reach the goal; -1 if never reached' },
    summary: { type: 'string', description: 'three or four sentences a product person could act on' },
    scores: {
      type: 'object',
      properties: {
        clarity: { type: 'number' },
        efficiency: { type: 'number' },
        correctness: { type: 'number' },
        doctrine: { type: 'number' },
        overall: { type: 'number' },
      },
      required: ['clarity', 'efficiency', 'correctness', 'doctrine', 'overall'],
    },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          met: { type: 'boolean' },
          evidence: { type: 'string' },
        },
        required: ['criterion', 'met', 'evidence'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [
              'confusion',
              'dead_end',
              'repetition',
              'wrong_answer',
              'unasked_for',
              'privacy',
              'self_confirmation',
              'unconfirmed_claim',
              'lint',
              'good',
            ],
          },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
          at_index: { type: 'integer', description: 'the transcript entry index this is about' },
          quote: { type: 'string', description: 'the exact words from that entry' },
          explanation: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['kind', 'severity', 'at_index', 'quote', 'explanation', 'suggestion'],
      },
    },
  },
  required: ['goal_reached', 'goal_evidence', 'turns_to_goal', 'summary', 'scores', 'criteria', 'findings'],
} as const

const JUDGE_SYSTEM = `You are reviewing one recorded conversation between a real person on WhatsApp and
an AI manager that runs an Indian coaching academy. You are not the assistant and you are not the
user. You are looking for the places this conversation failed the person in it.

Report, specifically:
  confusion        — the user did not understand what was said, what was being asked, or what to do
  dead_end         — the path ran out: no next step, no answer, an unanswerable question, silence
  repetition       — either side said the same thing twice; the user having to re-ask is worse
  wrong_answer     — a fact, a number, a date or a consequence that is wrong or unsupported by
                     anything the transcript shows the assistant actually looked up
  unasked_for      — a message this recipient would NOT have asked for. This is the product's
                     first doctrine: quiet by default, no engagement pings, no "just checking in",
                     no message whose only job is to remind them the bot exists
  privacy          — information reaching someone it must not reach
  self_confirmation— someone asked to confirm something to themselves, or escalated to about
                     themselves
  unconfirmed_claim— a claim the system cannot see: "delivered" when only sent, "confirmed" when
                     only asked, "paid" when only claimed
  lint             — internal identifiers, machine timestamps or schema words in user-facing copy
  good             — worth keeping. Use sparingly and only when it is genuinely notable

The doctrine this assistant is meant to follow:
  1. Quiet by default — every proactive message must be one its recipient would have asked for
  2. The prompt is a convenience, not the interface — every prompted action works unprompted
  3. Speak the academy's language; never introduce vocabulary they have not used
  4. Buttons first, text always available
  5. Read back before acting on anything parsed, and anything touching more than one person
  6. Never claim what you cannot see — queued is not delivered, confirmed is not arrived
  7. Offer the natural next step as a button after every action
  8. Suggestions ride on messages already being sent, never as a standalone interruption
  9. Roles are hats — never ask someone to confirm something to themselves
 10. When uncertain, say so plainly rather than guessing

Rules for you:
- Every finding carries a severity and a QUOTE — the exact words, copied, from the entry index you
  name. A finding without a quote is an opinion and does not belong in the report.
- critical = someone is misinformed, money or safety is touched, or the product visibly broke.
  major = the goal was blocked or the user had to work around it. minor = friction. nit = polish.
- Judge the assistant, never the user. An uncooperative, terse, angry or careless user is the test,
  not the fault. "The user should have read more carefully" is never a finding.
- Do not invent problems to fill the list. A clean run gets a short report and high scores.
- Score 0–10. 10 means you would ship this exchange as an example of the product working.
- Rule on each success criterion separately and honestly; a promise is not a result.`

function renderForJudge(run: SimRunResult): string {
  const L: string[] = []
  L.push(`RUN ${run.runId}   seed=${run.seed}   temperature=${run.temperature}`)
  L.push(`ACADEMY: ${run.academyName} (${run.timezone})`)
  L.push(`THE PERSON: ${run.personName} — roles: ${run.roles.join(', ') || 'unknown'}`)
  L.push(`PERSONA: ${run.persona.name} — ${run.persona.description}`)
  L.push(`PERSONA TRAITS: ${run.persona.traits.join(', ')}`)
  L.push(`GOAL: ${run.goal.text}`)
  L.push('SUCCESS CRITERIA:')
  run.goal.successCriteria.forEach((c, i) => L.push(`  ${i + 1}. ${c}`))
  L.push(`ENDED: ${run.stopReason}${run.error ? ` (${run.error})` : ''} after ${run.turns} user messages`)
  L.push('')
  L.push('TRANSCRIPT — each line is [index] and the entry index is what you cite:')
  for (const e of run.transcript) {
    L.push(renderEntryForJudge(e))
  }
  if (run.sideEffects.length) {
    L.push('')
    L.push('MESSAGES THIS CONVERSATION SENT TO OTHER PEOPLE (they are not in the thread above):')
    for (const s of run.sideEffects) {
      L.push(
        `  → ${s.toName}${s.catalogId ? ` [${s.catalogId}]` : ''}${s.suppressedReason ? ` (DROPPED: ${s.suppressedReason})` : ''}: ${truncate(s.body, 220)}`,
      )
    }
  }
  return L.join('\n')
}

function renderEntryForJudge(e: SimEntry): string {
  const head = `[${e.index}] ${e.atLabel}`
  switch (e.kind) {
    case 'clock':
      return `${head} ⏱ ${e.body}`
    case 'note':
      return `${head} · ${e.body}${e.reason ? ` — ${e.reason}` : ''}`
    case 'tap':
      return `${head} USER TAPPED "${e.tapped?.title ?? e.body}"${e.reason ? `   (why: ${e.reason})` : ''}`
    case 'text':
      return `${head} USER: ${e.body}${e.reason ? `   (why: ${e.reason}${e.frustration ? `, irritation ${e.frustration}/5` : ''})` : ''}`
    case 'suppressed':
      return `${head} ASSISTANT (NOT SENT — ${e.suppressedReason}): ${e.body}`
    default: {
      const meta = [
        e.catalogId ? `catalog ${e.catalogId}` : null,
        e.templateName ? `template ${e.templateName}` : e.inWindow === false ? 'out of window' : null,
        e.status && e.status !== 'sent' ? `status ${e.status}` : null,
      ]
        .filter(Boolean)
        .join(', ')
      const btns = e.buttons?.length
        ? `\n      buttons: ${e.buttons.map((b) => `[${b.title}]${b.via === 'list' ? '(list)' : ''}`).join(' ')}`
        : '\n      buttons: none'
      return `${head} ASSISTANT${meta ? ` (${meta})` : ''}: ${e.body}${btns}`
    }
  }
}

function renderMechanical(fs: JudgeFinding[]): string {
  if (fs.length === 0) return 'MECHANICAL CHECKS: all clean.'
  const L = ['MECHANICAL CHECKS already run against this transcript (do not repeat them, but weigh them):']
  for (const f of fs) L.push(`  - [${f.severity}] ${f.kind} @${f.atIndex}: ${f.explanation}`)
  return L.join('\n')
}

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------

export async function judge(run: SimRunResult): Promise<JudgeReport> {
  const mech = mechanicalFindings(run)
  const started = process.hrtime.bigint()

  let modelFindings: JudgeFinding[] = []
  let goalReached = run.personaClaimsGoalReached
  let goalEvidence = 'not assessed'
  let turnsToGoal: number | null = null
  let summary = ''
  let scores: JudgeScores = { clarity: 0, efficiency: 0, correctness: 0, doctrine: 0, overall: 0 }
  let criteria: JudgeCriterion[] = run.goal.successCriteria.map((c) => ({ criterion: c, met: false, evidence: 'not assessed' }))
  let error: string | undefined
  let model = env.MODEL_SYNTH

  try {
    const gen = await generate({
      system: JUDGE_SYSTEM,
      contents: [
        {
          role: 'user',
          parts: [{ text: `${renderForJudge(run)}\n\n${renderMechanical(mech)}\n\nReview it.` }],
        },
      ],
      model: env.MODEL_SYNTH,
      temperature: 0.1,
      maxOutputTokens: 16384,
      responseJsonSchema: JUDGE_SCHEMA as unknown as object,
    })
    model = gen.model || env.MODEL_SYNTH
    const raw = parseJson(gen.text)
    if (!raw) throw new Error('judge returned unparseable output')

    goalReached = raw.goal_reached === true
    goalEvidence = typeof raw.goal_evidence === 'string' ? raw.goal_evidence : ''
    turnsToGoal = Number.isFinite(raw.turns_to_goal) && raw.turns_to_goal >= 0 ? Math.trunc(raw.turns_to_goal) : null
    summary = typeof raw.summary === 'string' ? raw.summary : ''
    scores = {
      clarity: clamp10(raw.scores?.clarity),
      efficiency: clamp10(raw.scores?.efficiency),
      correctness: clamp10(raw.scores?.correctness),
      doctrine: clamp10(raw.scores?.doctrine),
      overall: clamp10(raw.scores?.overall),
    }
    if (Array.isArray(raw.criteria) && raw.criteria.length) {
      criteria = raw.criteria.map((c: any) => ({
        criterion: String(c?.criterion ?? ''),
        met: c?.met === true,
        evidence: String(c?.evidence ?? ''),
      }))
    }
    if (Array.isArray(raw.findings)) {
      modelFindings = raw.findings
        .filter((f: any) => f && typeof f === 'object')
        .map((f: any) => ({
          kind: (f.kind ?? 'confusion') as JudgeFindingKind,
          severity: (['critical', 'major', 'minor', 'nit'].includes(f.severity) ? f.severity : 'minor') as JudgeSeverity,
          atIndex: Number.isFinite(f.at_index) ? Math.trunc(f.at_index) : -1,
          quote: String(f.quote ?? ''),
          explanation: String(f.explanation ?? ''),
          suggestion: String(f.suggestion ?? ''),
          source: 'model' as const,
        }))
    }
  } catch (e) {
    error = (e as Error).message
    summary = `The judge could not review this run: ${error}. The mechanical checks below still stand.`
    scores = scoreFromMechanical(mech)
  }

  const findings = rank([...mech, ...modelFindings])
  const counts: Record<JudgeSeverity, number> = { critical: 0, major: 0, minor: 0, nit: 0 }
  for (const f of findings) counts[f.severity]++

  const ms = Number((process.hrtime.bigint() - started) / 1_000_000n)
  const report: JudgeReport = {
    runId: run.runId,
    seed: run.seed,
    goalReached,
    goalEvidence,
    turnsToGoal,
    scores,
    criteria,
    findings,
    summary,
    counts,
    model,
    ms,
    ...(error ? { error } : {}),
  }

  await saveJudgeReport(run.academyId, run.runId, report)
  return report
}

const SEVERITY_ORDER: Record<JudgeSeverity, number> = { critical: 0, major: 1, minor: 2, nit: 3 }

function rank(fs: JudgeFinding[]): JudgeFinding[] {
  const seen = new Set<string>()
  const deduped = fs.filter((f) => {
    const key = `${f.kind}|${f.atIndex}|${normalise(f.explanation).slice(0, 60)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return deduped.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.atIndex - b.atIndex)
}

function clamp10(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(10, Number(n.toFixed(1))))
}

function scoreFromMechanical(fs: JudgeFinding[]): JudgeScores {
  let s = 10
  for (const f of fs) s -= f.severity === 'critical' ? 4 : f.severity === 'major' ? 2 : f.severity === 'minor' ? 0.5 : 0
  const v = Math.max(0, Number(s.toFixed(1)))
  return { clarity: v, efficiency: v, correctness: v, doctrine: v, overall: v }
}

function parseJson(text: string): any {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const a = cleaned.indexOf('{')
    const b = cleaned.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    try {
      return JSON.parse(cleaned.slice(a, b + 1))
    } catch {
      return null
    }
  }
}

export async function saveJudgeReport(academyId: string, runId: string, report: JudgeReport): Promise<void> {
  await withSession({ role: 'service', academyId }, async (tx) => {
    await tx`
      update sim_run set judge_report = ${JSON.stringify(report)}::text::jsonb where id = ${runId}
    `
  })
}

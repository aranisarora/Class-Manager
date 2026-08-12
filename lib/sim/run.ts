/**
 * §17 — agent simulation, the runner.
 *
 * `runPersona` drives a real conversation against the real system. The persona is a model; its
 * messages go out through `POST /api/emulator/inbound` — the same path a human pane uses, which is
 * the same path the Cloud API webhook uses — so nothing here is a shortcut into `runTurn`. What
 * comes back is read off the `message` table, exactly what the emulator renders.
 *
 * Determinism: everything arbitrary is derived from `seed` — the persona's temperature, whether a
 * tap-happy persona taps, which wrong button a mis-tapper hits, how long a waiter waits. The seed
 * is recorded on the `sim_run` row, so `diffRuns` can insist two runs are comparable.
 */

import { env } from '@/lib/env'
import { withSession, type SessionCtx } from '@/lib/db'
import { now as domainNow, inZone } from '@/lib/clock'
import { newId } from '@/lib/ids'
import { generate } from '@/lib/agent/gemini'
import { resolveIdentity } from '@/lib/identity'
import { findPersona, hasTrait, TRAITS, type Persona, type PersonaDef } from './personas'
import { findGoal, type SimGoal, type SimGoalDef } from './goals'
import { judge as judgeRun, type JudgeReport } from './judge'

export type { Persona } from './personas'
export type { SimGoal } from './goals'
export { PERSONAS, PERSONA_DEFS, findPersona } from './personas'
export { GOALS, GOAL_DEFS, findGoal } from './goals'

// ---------------------------------------------------------------------------
// Transcript shapes
// ---------------------------------------------------------------------------

export type SimButton = {
  actionId: string
  title: string
  via: 'button' | 'list'
  description?: string
}

export type SimEntry = {
  index: number
  /** Who produced this line. */
  actor: 'persona' | 'system' | 'clock'
  kind: 'text' | 'tap' | 'message' | 'suppressed' | 'clock' | 'note'
  /** Domain time (§13/§17 drivable clock), ISO. */
  at: string
  /** The same instant rendered in the academy's timezone. */
  atLabel: string
  body: string
  buttons?: SimButton[]
  tapped?: { title: string; actionId: string }
  /** The persona's stated reason for this move, or a suppression reason for a dropped send. */
  reason?: string
  messageId?: string
  catalogId?: string | null
  templateName?: string | null
  inWindow?: boolean
  status?: string
  costPaise?: number | null
  suppressedReason?: string | null
  /** For `kind:'clock'` — how far the clock moved. */
  advancedMs?: number
  /** The persona's self-reported irritation, 0–5. Cheap confusion signal for the judge. */
  frustration?: number
}

/** Outbound traffic this run caused to *other* people — the coach told, the admin escalated to. */
export type SimSideEffect = {
  at: string
  toContactId: string
  toName: string
  body: string
  catalogId: string | null
  templateName: string | null
  suppressedReason: string | null
}

export type SimRunResult = {
  runId: string
  seed: string
  label: string
  contactId: string
  academyId: string
  academyName: string
  timezone: string
  personName: string
  roles: string[]
  persona: Persona
  goal: SimGoal
  temperature: number
  maxTurns: number
  transcript: SimEntry[]
  sideEffects: SimSideEffect[]
  /** Persona messages actually sent. */
  turns: number
  clockAdvancedMs: number
  startedAt: string
  endedAt: string
  /** The persona's own claim. The judge rules independently. */
  personaClaimsGoalReached: boolean
  stopReason: 'goal' | 'max_turns' | 'gave_up' | 'error'
  error?: string
  judge?: JudgeReport | null
}

// ---------------------------------------------------------------------------
// Seeded randomness — the whole point of a seed
// ---------------------------------------------------------------------------

function hashSeed(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(a: number): () => number {
  let x = a >>> 0
  return () => {
    x = (x + 0x6d2b79f5) | 0
    let t = Math.imul(x ^ (x >>> 15), 1 | x)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const NIL_ACADEMY = '00000000-0000-0000-0000-000000000000'
const POLL_MS = 400
const MAX_POLLS = 24
const QUIET_POLLS = 3
const MAX_TOTAL_ADVANCE_MS = 30 * 24 * 60 * 60 * 1000
const MAX_AUTO_ADVANCES = 4

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function svc(academyId: string): SessionCtx {
  return { role: 'service', academyId }
}

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const url = `${env.APP_BASE_URL.replace(/\/+$/, '')}${path}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const text = await res.text()
  let json: any = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { ok: res.ok, status: res.status, json, text }
}

/**
 * Pull the tappable surface out of a stored message payload. The payload is written by
 * `lib/messaging/send.ts`, so the canonical shape is `OutboundMessage` — but this also reads the
 * Cloud API interactive shape, because a payload that round-tripped through the transport looks
 * like that and a simulation that silently sees zero buttons is worse than useless.
 */
export function extractButtons(payload: unknown): SimButton[] {
  const out: SimButton[] = []
  if (!payload || typeof payload !== 'object') return out
  const p = payload as Record<string, any>
  const m: Record<string, any> = (p.message && typeof p.message === 'object' ? p.message : p) as Record<string, any>

  const pushBtn = (actionId: unknown, title: unknown, via: 'button' | 'list', description?: unknown) => {
    if (typeof actionId !== 'string' || !actionId) return
    if (typeof title !== 'string' || !title) return
    if (out.some((b) => b.actionId === actionId)) return
    out.push({ actionId, title, via, ...(typeof description === 'string' && description ? { description } : {}) })
  }

  if (Array.isArray(m.buttons)) {
    for (const b of m.buttons) {
      if (!b || typeof b !== 'object') continue
      pushBtn(b.actionId ?? b.action_id ?? b.id ?? b.reply?.id, b.title ?? b.reply?.title, 'button')
    }
  }
  const cloudButtons = m.interactive?.action?.buttons
  if (Array.isArray(cloudButtons)) {
    for (const b of cloudButtons) pushBtn(b?.reply?.id ?? b?.id, b?.reply?.title ?? b?.title, 'button')
  }

  const sections = m.list?.sections ?? m.interactive?.action?.sections
  if (Array.isArray(sections)) {
    for (const s of sections) {
      if (!Array.isArray(s?.rows)) continue
      for (const r of s.rows) {
        if (!r || typeof r !== 'object') continue
        pushBtn(r.actionId ?? r.action_id ?? r.id, r.title, 'list', r.description)
      }
    }
  }
  return out
}

function bodyOf(row: Record<string, any>): string {
  if (typeof row.body === 'string' && row.body.trim()) return row.body
  const p = row.payload && typeof row.payload === 'object' ? row.payload : null
  const m = p ? ((p as any).message ?? p) : null
  if (m && typeof (m as any).body === 'string') return (m as any).body
  if (m && typeof (m as any).text?.body === 'string') return (m as any).text.body
  return ''
}

function headerFooter(row: Record<string, any>): { header?: string; footer?: string } {
  const p = row.payload && typeof row.payload === 'object' ? row.payload : null
  const m: any = p ? ((p as any).message ?? p) : null
  const header = typeof m?.header === 'string' ? m.header : undefined
  const footer = typeof m?.footer === 'string' ? m.footer : undefined
  return { header, footer }
}

function toIso(v: unknown): string | null {
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'string' && v) return new Date(v).toISOString()
  return null
}

// ---------------------------------------------------------------------------
// Reading the world
// ---------------------------------------------------------------------------

type MessageRow = {
  id: string
  contact_id: string
  direction: string
  body: string | null
  payload: unknown
  catalog_id: string | null
  template_name: string | null
  status: string
  suppressed_reason: string | null
  cost_paise: number | null
  in_window: boolean
  queued_at: Date | string
  created_at: Date | string
  person_name: string
}

async function readMessages(academyId: string): Promise<MessageRow[]> {
  const rows = await withSession(svc(academyId), async (tx) => {
    return tx<MessageRow[]>`
      select m.id, m.contact_id, m.direction, m.body, m.payload, m.catalog_id, m.template_name,
             m.status, m.suppressed_reason, m.cost_paise, m.in_window, m.queued_at, m.created_at,
             p.full_name as person_name
      from message m
      join contact c on c.id = m.contact_id
      join person  p on p.id = c.person_id
      where m.academy_id = ${academyId}
      order by m.created_at desc
      limit 400
    `
  })
  return [...rows].reverse()
}

// ---------------------------------------------------------------------------
// The persona model
// ---------------------------------------------------------------------------

type PersonaDecision = {
  action: 'type' | 'tap' | 'wait' | 'stop'
  text: string
  button_index: number
  wait_hours: number
  reason: string
  frustration: number
  goal_reached: boolean
}

const DECISION_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['type', 'tap', 'wait', 'stop'],
      description: 'type a message, tap one of the listed buttons, put the phone down and let time pass, or end the conversation',
    },
    text: { type: 'string', description: 'the exact WhatsApp message you send. empty unless action is "type"' },
    button_index: { type: 'integer', description: '1-based index from the BUTTONS list. 0 when not tapping' },
    wait_hours: { type: 'number', description: 'hours you let pass before checking your phone. 0 unless action is "wait"' },
    reason: { type: 'string', description: 'one short line, in your own head, about why you did this' },
    frustration: { type: 'integer', description: 'how irritated you are right now, 0 calm to 5 furious' },
    goal_reached: { type: 'boolean', description: 'true only if the thing you wanted has actually happened, not if it was promised' },
  },
  required: ['action', 'text', 'button_index', 'wait_hours', 'reason', 'frustration', 'goal_reached'],
} as const

function personaSystem(p: PersonaDef, g: SimGoalDef, ctx: {
  seed: string
  personName: string
  academyName: string
  timezone: string
  roles: string[]
}): string {
  return [
    'You are role-playing a real person messaging an Indian coaching academy on WhatsApp. You are the',
    'CUSTOMER SIDE of the conversation. You are not an assistant, you are not helpful, you do not',
    'summarise, and you never break character — least of all when the other side is confusing you.',
    '',
    `WHO YOU ARE: ${ctx.personName}. You message ${ctx.academyName} (timezone ${ctx.timezone}).`,
    `Your relationship to them: ${ctx.roles.join(', ') || 'client'}.`,
    '',
    `PERSONA — ${p.name}`,
    p.description,
    '',
    'HOW YOU TYPE:',
    p.style,
    '',
    `TRAITS (these are not suggestions): ${p.traits.join(', ')}`,
    '',
    'WHAT YOU WANT (private motivation — never announce it as a goal, just pursue it):',
    g.motivation,
    '',
    'HOW TO MOVE:',
    '- "type": you write a WhatsApp message. Write it exactly as this person types — spelling,',
    '  casing, length and language all in character.',
    '- "tap": you tap one of the numbered BUTTONS shown on the latest message. Only ever use an',
    '  index that is actually listed. If no buttons are listed you cannot tap.',
    '- "wait": you put the phone down. Use this when a real person would go and do something else,',
    '  or when you have been told something will happen later and you want to see whether it does.',
    '- "stop": only when you have what you wanted, or when you have genuinely given up.',
    '',
    'RULES:',
    '- One message at a time. Never write both sides. Never narrate.',
    '- If your persona does not read carefully, do not read carefully — answer the first line only.',
    '- If your persona repeats themselves, repeat yourself; do not accept the first answer.',
    '- Never mention that this is a simulation, a test, a persona or an AI.',
    '- goal_reached is true only when the thing actually happened. A promise is not a result.',
    '- frustration goes UP when you are asked something you already answered, or given a menu when',
    '  you asked a question.',
    '',
    `SEED: ${ctx.seed} — when a choice is genuinely arbitrary (which day you pick, which name you use),`,
    'derive it from this seed so the same seed produces the same run.',
  ].join('\n')
}

function renderForPersona(entries: SimEntry[], buttons: SimButton[], goal: SimGoalDef, turn: number, maxTurns: number): string {
  const lines: string[] = []
  lines.push('THE CHAT SO FAR (oldest first):')
  if (entries.length === 0) {
    lines.push('  (empty — you are messaging them for the first time)')
  }
  for (const e of entries) {
    if (e.kind === 'clock') {
      lines.push(`  — ${e.body} —`)
      continue
    }
    if (e.kind === 'note') continue
    if (e.kind === 'suppressed') continue
    const who = e.actor === 'persona' ? 'YOU' : 'THEM'
    const stamp = e.atLabel
    if (e.kind === 'tap') {
      lines.push(`  [${stamp}] YOU tapped "${e.tapped?.title ?? e.body}"`)
      continue
    }
    lines.push(`  [${stamp}] ${who}: ${e.body.replace(/\n/g, '\n        ')}`)
    if (e.actor === 'system' && e.buttons && e.buttons.length) {
      lines.push(`        (buttons on that message: ${e.buttons.map((b) => `"${b.title}"`).join(' ')})`)
    }
  }
  lines.push('')
  if (buttons.length) {
    lines.push('BUTTONS AVAILABLE ON THE LATEST MESSAGE:')
    buttons.forEach((b, i) => {
      lines.push(`  ${i + 1}. ${b.title}${b.description ? ` — ${b.description}` : ''}${b.via === 'list' ? ' (list row)' : ''}`)
    })
  } else {
    lines.push('BUTTONS AVAILABLE: none. You can only type, wait or stop.')
  }
  lines.push('')
  lines.push(`This is your move ${turn} of at most ${maxTurns}.`)
  lines.push(`Still trying to: ${goal.text}`)
  lines.push('Make your next move.')
  return lines.join('\n')
}

function parseDecision(text: string): PersonaDecision | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  let raw: any
  try {
    raw = JSON.parse(cleaned)
  } catch {
    const first = cleaned.indexOf('{')
    const last = cleaned.lastIndexOf('}')
    if (first < 0 || last <= first) return null
    try {
      raw = JSON.parse(cleaned.slice(first, last + 1))
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const action = ['type', 'tap', 'wait', 'stop'].includes(raw.action) ? raw.action : 'type'
  return {
    action,
    text: typeof raw.text === 'string' ? raw.text : '',
    button_index: Number.isFinite(raw.button_index) ? Math.trunc(raw.button_index) : 0,
    wait_hours: Number.isFinite(raw.wait_hours) ? Number(raw.wait_hours) : 0,
    reason: typeof raw.reason === 'string' ? raw.reason : '',
    frustration: Number.isFinite(raw.frustration) ? Math.max(0, Math.min(5, Math.trunc(raw.frustration))) : 0,
    goal_reached: raw.goal_reached === true,
  }
}

/**
 * Traits are enforced here, outside the model. A persona that "never taps" must never tap even on a
 * turn where the model decided tapping was sensible — otherwise the uncooperative personas quietly
 * become cooperative ones and stop finding bugs.
 */
function applyTraits(
  d: PersonaDecision,
  p: PersonaDef,
  buttons: SimButton[],
  rng: () => number,
): { decision: PersonaDecision; notes: string[] } {
  const notes: string[] = []
  const out: PersonaDecision = { ...d }

  if (out.action === 'tap' && buttons.length === 0) {
    out.action = 'type'
    if (!out.text) out.text = 'yes'
    notes.push('wanted to tap but no buttons were on offer')
  }

  if (hasTrait(p, TRAITS.neverTaps) && out.action === 'tap') {
    const chosen = buttons[Math.max(0, Math.min(buttons.length - 1, out.button_index - 1))]
    out.action = 'type'
    out.text = out.text || (chosen ? chosen.title.toLowerCase() : 'ok')
    out.button_index = 0
    notes.push('never taps — typed instead of tapping')
  }

  if (
    out.action === 'type' &&
    buttons.length > 0 &&
    hasTrait(p, TRAITS.tapsFirstButton) &&
    rng() < p.tapBias
  ) {
    out.action = 'tap'
    out.button_index = 1
    notes.push('taps the first button without reading the rest')
  }

  if (out.action === 'tap') {
    let idx = Math.max(1, Math.min(buttons.length, out.button_index || 1))
    if (hasTrait(p, TRAITS.misTaps) && buttons.length > 1 && rng() < p.misTapRate) {
      const wrong = 1 + Math.floor(rng() * (buttons.length - 1))
      idx = wrong >= idx ? wrong + 1 : wrong
      if (idx > buttons.length) idx = buttons.length
      notes.push('mis-tapped')
    }
    out.button_index = idx
  }

  if (out.action === 'type' && hasTrait(p, TRAITS.terse)) {
    const words = out.text.trim().split(/\s+/).filter(Boolean)
    if (words.length > 6) {
      out.text = words.slice(0, 6).join(' ')
      notes.push('clipped to a few words')
    }
  }

  if (out.action === 'type' && !out.text.trim()) {
    out.text = '?'
    notes.push('sent an empty message — substituted "?"')
  }

  return { decision: out, notes }
}

// ---------------------------------------------------------------------------
// sim_run persistence
// ---------------------------------------------------------------------------

async function insertRun(r: {
  runId: string
  academyId: string
  seed: string
  label: string
  persona: Persona
  goal: SimGoal
  startedAt: string
}): Promise<void> {
  await withSession(svc(r.academyId), async (tx) => {
    await tx`
      insert into sim_run (id, seed, label, started_at, persona, goal, transcript)
      values (${r.runId}, ${r.seed}, ${r.label}, ${r.startedAt},
              ${JSON.stringify(r.persona)}::text::jsonb, ${r.goal.text},
              ${JSON.stringify({ transcript: [] })}::text::jsonb)
    `
  })
}

async function saveRun(result: SimRunResult): Promise<void> {
  await withSession(svc(result.academyId), async (tx) => {
    await tx`
      update sim_run
         set transcript = ${JSON.stringify(runToJson(result))}::text::jsonb,
             ended_at   = ${result.endedAt},
             label      = ${result.label}
       where id = ${result.runId}
    `
  })
}

function runToJson(r: SimRunResult): Record<string, unknown> {
  const { judge, ...rest } = r
  return { ...rest, version: 1 }
}

/** Rehydrate a recorded run. `diffRuns` and the sim UI both work off these. */
export async function loadRun(runId: string, academyId?: string): Promise<SimRunResult | null> {
  const rows = await withSession(svc(academyId ?? NIL_ACADEMY), async (tx) => {
    return tx<{ id: string; seed: string; label: string | null; transcript: any; judge_report: any }[]>`
      select id, seed, label, transcript, judge_report from sim_run where id = ${runId} limit 1
    `
  })
  const row = rows[0]
  if (!row || !row.transcript || !Array.isArray(row.transcript.transcript)) return null
  return { ...(row.transcript as SimRunResult), judge: (row.judge_report as JudgeReport | null) ?? null }
}

export type SimRunSummary = {
  runId: string
  seed: string
  label: string
  startedAt: string | null
  endedAt: string | null
  goal: string | null
  personaName: string | null
  judged: boolean
}

export async function listRuns(limit = 40, academyId?: string): Promise<SimRunSummary[]> {
  const rows = await withSession(svc(academyId ?? NIL_ACADEMY), async (tx) => {
    return tx<
      { id: string; seed: string; label: string | null; started_at: Date; ended_at: Date | null; goal: string | null; persona: any; judge_report: any }[]
    >`
      select id, seed, label, started_at, ended_at, goal, persona, judge_report
        from sim_run order by started_at desc limit ${limit}
    `
  })
  return rows.map((r) => ({
    runId: r.id,
    seed: r.seed,
    label: r.label ?? '',
    startedAt: toIso(r.started_at),
    endedAt: toIso(r.ended_at),
    goal: r.goal,
    personaName: r.persona && typeof r.persona === 'object' ? (r.persona.name ?? null) : null,
    judged: !!r.judge_report,
  }))
}

// ---------------------------------------------------------------------------
// runPersona
// ---------------------------------------------------------------------------

export async function runPersona(o: {
  seed: string
  contactId: string
  /** A persona object, or a slug/name from `PERSONAS`. */
  persona: Persona | string
  /** A goal object, or a slug/text from `GOALS`. */
  goal: SimGoal | string
  maxTurns?: number
  label?: string
  /** Called after every appended entry — lets a caller stream the run. */
  onEntry?: (entry: SimEntry) => void
  /** Review the run when it ends and hang the report on the result. Default true (§19 phase 12:
   *  a run that produces no judge report has not finished). Pass false to run the judge yourself. */
  judge?: boolean
}): Promise<SimRunResult> {
  const persona = findPersona(o.persona)
  const goal = findGoal(o.goal)
  const seed = o.seed
  const rng = mulberry32(hashSeed(`${seed}|${persona.slug}|${goal.slug}`))

  // Temperature is seed-derived, not fixed: two seeds are two different people having the same
  // kind of bad day, and the seed is on the row so it is reproducible.
  const temperature = Math.max(
    0.15,
    Math.min(1.3, Number((0.4 + rng() * 0.5 + persona.temperatureBias).toFixed(3))),
  )
  const maxTurns = o.maxTurns ?? goal.maxTurns

  const identity = await resolveIdentity(o.contactId)
  if (!identity) throw new Error(`sim: contact ${o.contactId} does not resolve to an identity`)
  const academyId = identity.academyId
  const tz = identity.academy.timezone ?? 'Asia/Kolkata'

  const runId = newId()
  const startedAtDate = await domainNow()
  const startedAt = startedAtDate.toISOString()
  const label = o.label ?? `${persona.slug} · ${goal.slug} · ${seed}`

  const transcript: SimEntry[] = []
  const sideEffects: SimSideEffect[] = []
  const seen = new Set<string>()
  let clockAdvancedMs = 0
  let autoAdvances = 0
  let turns = 0
  let personaClaimsGoalReached = false
  let stopReason: SimRunResult['stopReason'] = 'max_turns'
  let error: string | undefined

  const stamp = async (): Promise<{ at: string; atLabel: string }> => {
    const d = await domainNow()
    return { at: d.toISOString(), atLabel: inZone(d, tz).label }
  }

  const push = (e: Omit<SimEntry, 'index'>): SimEntry => {
    const entry: SimEntry = { ...e, index: transcript.length }
    transcript.push(entry)
    try {
      o.onEntry?.(entry)
    } catch {
      /* a streaming consumer must never break the run */
    }
    return entry
  }

  // Baseline: everything already in the world is not ours.
  try {
    for (const m of await readMessages(academyId)) seen.add(m.id)
  } catch (e) {
    throw new Error(`sim: cannot read the message table — ${(e as Error).message}`)
  }

  await insertRun({ runId, academyId, seed, label, persona, goal, startedAt })

  /** Drain everything the system produced since the last drain. Returns the count for this pane. */
  const drain = async (opts: { expectSomething: boolean }): Promise<number> => {
    let quiet = 0
    let mine = 0
    for (let poll = 0; poll < MAX_POLLS; poll++) {
      let fresh: MessageRow[] = []
      try {
        fresh = (await readMessages(academyId)).filter((m) => !seen.has(m.id))
      } catch {
        fresh = []
      }
      // Wait longer for the first reply than for a trailing one: the turn may still be running.
      const quietLimit = opts.expectSomething ? (mine > 0 ? QUIET_POLLS : 8) : 2
      if (fresh.length === 0) {
        quiet++
        if (quiet >= quietLimit) break
        await sleep(POLL_MS)
        continue
      }
      quiet = 0
      for (const m of fresh) {
        seen.add(m.id)
        // Domain time only — `queued_at` is stamped by the send path from `app.now()`.
        const at = toIso(m.queued_at) ?? toIso(m.created_at) ?? startedAt
        const atLabel = inZone(new Date(at), tz).label
        if (m.contact_id !== o.contactId) {
          if (m.direction === 'outbound') {
            sideEffects.push({
              at,
              toContactId: m.contact_id,
              toName: m.person_name,
              body: bodyOf(m),
              catalogId: m.catalog_id,
              templateName: m.template_name,
              suppressedReason: m.suppressed_reason,
            })
          }
          continue
        }
        if (m.direction !== 'outbound') continue // the persona's own turns are recorded as they happen
        mine++
        const { header, footer } = headerFooter(m)
        const body = [header, bodyOf(m), footer].filter(Boolean).join('\n')
        push({
          actor: 'system',
          kind: m.suppressed_reason ? 'suppressed' : 'message',
          at,
          atLabel,
          body,
          buttons: extractButtons(m.payload),
          messageId: m.id,
          catalogId: m.catalog_id,
          templateName: m.template_name,
          inWindow: m.in_window,
          status: m.status,
          costPaise: m.cost_paise,
          suppressedReason: m.suppressed_reason,
          ...(m.suppressed_reason ? { reason: `send path dropped this: ${m.suppressed_reason}` } : {}),
        })
      }
      await sleep(POLL_MS)
    }
    return mine
  }

  const currentButtons = (): SimButton[] => {
    for (let i = transcript.length - 1; i >= 0; i--) {
      const e = transcript[i]
      if (e.actor === 'persona') break
      if (e.kind === 'message' && e.buttons && e.buttons.length) return e.buttons
    }
    return []
  }

  const advanceClock = async (ms: number, why: string): Promise<void> => {
    // Whole milliseconds: `/api/emulator/clock` validates `advanceMs` as an integer, and
    // `wait_hours * 3_600_000` is not one for most fractional hours the persona model returns.
    const capped = Math.round(Math.max(15 * 60 * 1000, Math.min(ms, 72 * 60 * 60 * 1000)))
    if (clockAdvancedMs + capped > MAX_TOTAL_ADVANCE_MS) return
    const res = await postJson('/api/emulator/clock', { advanceMs: capped })
    if (!res.ok) {
      const s = await stamp()
      push({ actor: 'clock', kind: 'note', ...s, body: `clock advance failed (${res.status})`, reason: res.text.slice(0, 200) })
      return
    }
    clockAdvancedMs += capped
    const s = await stamp()
    push({
      actor: 'clock',
      kind: 'clock',
      ...s,
      body: `${formatSpan(capped)} passes — ${why} (now ${s.atLabel})`,
      advancedMs: capped,
    })
    await drain({ expectSomething: false })
  }

  const jumpToNextEvent = async (): Promise<boolean> => {
    const res = await postJson('/api/emulator/clock', { toNextEvent: true })
    if (!res.ok) return false
    const s = await stamp()
    push({ actor: 'clock', kind: 'clock', ...s, body: `waited for the next scheduled thing (now ${s.atLabel})` })
    await drain({ expectSomething: false })
    return true
  }

  try {
    // Anything already queued for this contact before the persona speaks (a reminder sitting in the
    // thread) is part of what they are reacting to.
    await drain({ expectSomething: false })

    for (let turn = 1; turn <= maxTurns; turn++) {
      const buttons = currentButtons()
      let decision: PersonaDecision | null = null

      if (turn === 1 && goal.opener) {
        decision = {
          action: 'type',
          text: goal.opener,
          button_index: 0,
          wait_hours: 0,
          reason: 'the message the deep link prefilled',
          frustration: 0,
          goal_reached: false,
        }
      } else {
        for (let attempt = 0; attempt < 2 && !decision; attempt++) {
          try {
            const gen = await generate({
              system: personaSystem(persona, goal, {
                seed,
                personName: identity.person.full_name,
                academyName: identity.academy.name,
                timezone: tz,
                roles: identity.roles,
              }),
              contents: [
                {
                  role: 'user',
                  parts: [{ text: renderForPersona(transcript, buttons, goal, turn, maxTurns) }],
                },
              ],
              model: env.MODEL_MAIN,
              temperature,
              maxOutputTokens: 512,
              responseJsonSchema: DECISION_SCHEMA as unknown as object,
            })
            decision = parseDecision(gen.text)
          } catch (e) {
            const s = await stamp()
            push({
              actor: 'clock',
              kind: 'note',
              ...s,
              body: `persona model call failed (attempt ${attempt + 1})`,
              reason: (e as Error).message,
            })
          }
        }
      }

      if (!decision) {
        error = 'persona model produced no usable decision'
        stopReason = 'error'
        break
      }

      const { decision: d, notes } = applyTraits(decision, persona, buttons, rng)
      personaClaimsGoalReached = personaClaimsGoalReached || d.goal_reached

      if (d.action === 'stop') {
        const s = await stamp()
        push({ actor: 'persona', kind: 'note', ...s, body: '(puts the phone away)', reason: d.reason, frustration: d.frustration })
        stopReason = d.goal_reached ? 'goal' : 'gave_up'
        break
      }

      if (d.action === 'wait') {
        await advanceClock((d.wait_hours || 2) * 60 * 60 * 1000, d.reason || 'waiting to see what happens')
        if (d.goal_reached) {
          stopReason = 'goal'
          break
        }
        continue
      }

      const s = await stamp()
      let posted: { ok: boolean; status: number; json: any; text: string }

      if (d.action === 'tap') {
        const btn = buttons[d.button_index - 1]
        if (!btn) {
          push({ actor: 'clock', kind: 'note', ...s, body: 'tried to tap a button that was not there' })
          continue
        }
        push({
          actor: 'persona',
          kind: 'tap',
          ...s,
          body: btn.title,
          tapped: { title: btn.title, actionId: btn.actionId },
          reason: [d.reason, ...notes].filter(Boolean).join(' · '),
          frustration: d.frustration,
        })
        posted = await postJson('/api/emulator/inbound', { contactId: o.contactId, actionId: btn.actionId })
      } else {
        push({
          actor: 'persona',
          kind: 'text',
          ...s,
          body: d.text,
          reason: [d.reason, ...notes].filter(Boolean).join(' · '),
          frustration: d.frustration,
        })
        posted = await postJson('/api/emulator/inbound', { contactId: o.contactId, text: d.text })
      }
      turns++

      if (!posted.ok) {
        const s2 = await stamp()
        push({
          actor: 'clock',
          kind: 'note',
          ...s2,
          body: `the inbound webhook rejected that (${posted.status})`,
          reason: posted.text.slice(0, 300),
        })
      } else if (posted.json && typeof posted.json === 'object' && typeof posted.json.error === 'string' && posted.json.error) {
        const s2 = await stamp()
        push({ actor: 'clock', kind: 'note', ...s2, body: 'the turn errored', reason: posted.json.error })
      }

      const produced = await drain({ expectSomething: true })

      if (produced === 0) {
        const s2 = await stamp()
        push({ actor: 'clock', kind: 'note', ...s2, body: 'silence — nothing came back' })
        if (goal.needsClock && autoAdvances < MAX_AUTO_ADVANCES) {
          autoAdvances++
          const jumped = await jumpToNextEvent()
          if (!jumped) await advanceClock(4 * 60 * 60 * 1000, 'nothing came back, so time moves instead')
        }
      }

      if (d.goal_reached) {
        stopReason = 'goal'
        break
      }
    }
  } catch (e) {
    error = (e as Error).message
    stopReason = 'error'
  }

  const endedAtDate = await domainNow()
  const result: SimRunResult = {
    runId,
    seed,
    label,
    contactId: o.contactId,
    academyId,
    academyName: identity.academy.name,
    timezone: tz,
    personName: identity.person.full_name,
    roles: identity.roles,
    persona: { name: persona.name, description: persona.description, style: persona.style, traits: persona.traits },
    goal: { text: goal.text, successCriteria: goal.successCriteria },
    temperature,
    maxTurns,
    transcript,
    sideEffects,
    turns,
    clockAdvancedMs,
    startedAt,
    endedAt: endedAtDate.toISOString(),
    personaClaimsGoalReached,
    stopReason,
    ...(error ? { error } : {}),
    judge: null,
  }

  if (o.judge !== false) {
    try {
      result.judge = await judgeRun(result)
    } catch (e) {
      result.judge = null
      // A failed review does not invalidate the run — the transcript is the artefact.
      push({
        actor: 'clock',
        kind: 'note',
        at: result.endedAt,
        atLabel: inZone(endedAtDate, tz).label,
        body: 'the judge could not review this run',
        reason: (e as Error).message,
      })
    }
  }

  await saveRun(result)
  return result
}

function formatSpan(ms: number): string {
  const h = ms / 3_600_000
  if (h < 1) return `${Math.round(ms / 60_000)} minutes`
  if (h < 48) return `${Number(h.toFixed(h < 10 ? 1 : 0))} hours`
  return `${Math.round(h / 24)} days`
}

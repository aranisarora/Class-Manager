/**
 * lib/agent/recipes.ts — §14.3.
 *
 * A recipe is a saved composition of the same primitives: a pre-resolved plan,
 * pre-built UI, a prompt fragment not re-derived each time. Booking,
 * cancelling, confirming, attendance and dunning run this way — instant, near
 * free, and visually consistent, because it is the same well-made shape every
 * time rather than an improvised one per conversation.
 *
 * **A recipe is captured model output, never hand-written code.** This matters
 * more than it sounds, and it is the reason there is no `RECIPES` constant in
 * this file to add to. A recipe written by hand slowly diverges from what the
 * model would now do, so the product gets *worse* at exactly its most common
 * actions as the model gets better — the opposite of what you want, and
 * invisible until someone compares the two paths. Captured plans cannot
 * diverge, because they are the same artifact: the model composed the plan
 * once, it was validated and executed, and freezing it is a review step rather
 * than a deploy.
 *
 * **Recipes optimise; they never gate.** A request no recipe matches falls
 * through to the primitives — that is the design working, not a gap. Nothing
 * in this file can refuse anything; the only thing it can do is offer a
 * known-good shape.
 */

import { withSession, type SessionCtx } from '@/lib/db'
import {
  executePlan,
  needsPreview,
  parseSteps,
  previewPlan,
  type PlanResult,
  type PlanStep,
} from './plan'
import { jsonLit, lit, uid } from './operations'

export type CapturedRecipe = {
  id: string
  academy_id: string | null
  name: string
  trigger_description: string | null
  plan: PlanStep[]
  params: string[]
  captured_from: string | null
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const TOKEN_RE = /\{\{([a-z0-9_]+)\}\}/gi

/* ------------------------------------------------------------------------- *
 * Capture
 * ------------------------------------------------------------------------- */

/**
 * Freeze a validated, already-executed model-authored plan as the canonical
 * version of that action. Ids in the plan are generalised into named
 * placeholders so the shape survives; everything else is kept verbatim,
 * including the copy, which is half of why capturing beats rewriting.
 */
export async function captureRecipe(
  auditId: string,
  name: string,
  o?: { academyId?: string; triggerDescription?: string; global?: boolean },
): Promise<CapturedRecipe> {
  const academyId = o?.academyId
  const entry = await withSession(
    { role: 'service', academyId: academyId ?? '00000000-0000-0000-0000-000000000000' },
    async (tx) => {
      const rows = (await tx.unsafe(
        `select id, academy_id, intent, plan from audit_entry where id = ${uid(auditId)}`,
      )) as unknown as { id: string; academy_id: string; intent: string | null; plan: unknown }[]
      return rows[0] ?? null
    },
  )
  if (!entry) throw new Error('recipes: no such audit entry to capture from')

  // Validation is the whole gate. A plan that would not pass the model-facing
  // schema today has no business being replayed tomorrow.
  const steps = parseSteps(entry.plan)
  const { generalized, params } = generalize(steps)

  const tenantId = o?.global ? null : (academyId ?? entry.academy_id)
  const trigger = o?.triggerDescription ?? entry.intent ?? name

  const row = await withSession({ role: 'service', academyId: entry.academy_id }, async (tx) => {
    const rows = (await tx.unsafe(
      `insert into recipe (academy_id, name, trigger_description, plan, captured_from, active)
       values (${tenantId ? uid(tenantId) : 'null'}, ${lit(name)}, ${lit(trigger)},
               ${jsonLit({ steps: generalized, params })}, ${uid(auditId)}, true)
       on conflict (academy_id, name) do update
          set plan = excluded.plan, trigger_description = excluded.trigger_description,
              captured_from = excluded.captured_from, active = true
       returning id, academy_id, name, trigger_description, plan, captured_from`,
    )) as unknown as {
      id: string
      academy_id: string | null
      name: string
      trigger_description: string | null
      plan: { steps: PlanStep[]; params: string[] }
      captured_from: string | null
    }[]
    return rows[0]
  })

  return {
    id: row.id,
    academy_id: row.academy_id,
    name: row.name,
    trigger_description: row.trigger_description,
    plan: row.plan?.steps ?? generalized,
    params: row.plan?.params ?? params,
    captured_from: row.captured_from,
  }
}

/**
 * Replace concrete ids with `{{named}}` placeholders. The name comes from the
 * key or SQL column the id was found under, so a captured plan reads like the
 * operation it came from rather than like `{{p1}}`.
 */
function generalize(steps: PlanStep[]): { generalized: PlanStep[]; params: string[] } {
  const byValue = new Map<string, string>()
  const used = new Map<string, number>()

  const nameFor = (hint: string, value: string): string => {
    const existing = byValue.get(value)
    if (existing) return existing
    const base = hint.replace(/[^a-z0-9_]/gi, '_').toLowerCase() || 'id'
    const n = (used.get(base) ?? 0) + 1
    used.set(base, n)
    const token = n === 1 ? base : `${base}_${n}`
    byValue.set(value, token)
    return token
  }

  const walk = (value: unknown, hint: string): unknown => {
    if (typeof value === 'string') {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
        return `{{${nameFor(hint, value)}}}`
      }
      // Raw SQL: `where session_id = '<uuid>'` keeps its column as the name.
      return value.replace(UUID_RE, (m, offset: number) => {
        const before = value.slice(Math.max(0, offset - 60), offset)
        const col = /([a-z_][a-z0-9_]*)\s*=\s*'?$/i.exec(before)?.[1] ?? hint
        return `{{${nameFor(col, m)}}}`
      })
    }
    if (Array.isArray(value)) return value.map((v) => walk(v, hint))
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, k)
      return out
    }
    return value
  }

  const generalized = walk(steps, 'id') as PlanStep[]
  return { generalized, params: [...byValue.values()] }
}

/**
 * The profiler §14.3 asks for: *"whatever the model keeps re-deriving becomes the
 * next recipe."*
 *
 * The signal is already on the `turn` row and needed no new instrumentation. A turn
 * that **committed a plan** and **took three rounds or more to get there** is one the
 * model had to work out — the cheap ones land in two. Freezing the plan it arrived at
 * means the next request of that shape starts from a known-good composition instead
 * of being re-derived at a full prefix per round.
 *
 * What this is worth is **rounds, not prompt size**, and that distinction matters
 * because it is easy to reach for the wrong lever. A matched recipe rides in the
 * uncached variable tail at ~1.2k characters; if it removes one round it saves a
 * whole prefix pass, which measured is ~17k prompt tokens. Recipes are a latency and
 * round-count optimisation that happens to save tokens, and the number to watch is
 * `avg(turn.rounds)`.
 *
 * **Never in the stable prefix.** Recipes are per-academy, and anything per-tenant
 * above §4.4's cache boundary breaks byte-identity for *every* tenant. The tail is
 * not where this ended up by accident.
 *
 * Capture never throws into the turn: a recipe that failed to freeze costs a future
 * optimisation, and a turn that failed costs a person their answer.
 */
export const CAPTURE_ROUNDS_THRESHOLD = 3

export async function captureIfExpensive(o: {
  academyId: string
  rounds: number
  committed: { auditId: string; intent: string }[]
}): Promise<string | null> {
  if (o.rounds < CAPTURE_ROUNDS_THRESHOLD || !o.committed.length) return null
  // The last plan of the turn is the one the turn was about; earlier ones are usually
  // the setup it needed to get there.
  const { auditId, intent } = o.committed[o.committed.length - 1]
  const name = recipeName(intent)
  if (!name) return null

  try {
    const captured = await captureRecipe(auditId, name, {
      academyId: o.academyId,
      triggerDescription: intent,
    })
    return captured.name
  } catch {
    return null
  }
}

/**
 * A stable, human-readable key for an intent. `on conflict (academy_id, name)` in
 * `captureRecipe` means a second capture of the same shape *replaces* the first,
 * which is what keeps a recipe the thing the model would compose today rather than
 * the thing it composed once — the divergence §14.3 exists to prevent.
 */
function recipeName(intent: string): string | null {
  const words = tokens(intent).slice(0, 5)
  if (words.length < 2) return null
  return words.join('-').slice(0, 60)
}

/* ------------------------------------------------------------------------- *
 * Match
 * ------------------------------------------------------------------------- */

const STOP = new Set(
  'a an the and or of for to in on at is are was were be been do does did i you he she it we they my your this that with please can could would should just want need help me my our'.split(
    ' ',
  ),
)

function tokens(s: string): string[] {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t))
}

/**
 * Find the recipe that already covers this request. Deliberately conservative:
 * a wrong match costs more than a miss, because a miss falls through to the
 * primitives and still works.
 */
export async function matchRecipe(
  intent: string,
  o?: { academyId?: string },
): Promise<CapturedRecipe | null> {
  const want = tokens(intent)
  if (want.length < 2) return null

  const rows = await withSession(
    { role: 'service', academyId: o?.academyId ?? '00000000-0000-0000-0000-000000000000' },
    async (tx) => {
      return (await tx.unsafe(
        `select id, academy_id, name, trigger_description, plan, captured_from
           from recipe
          where active
            and (academy_id is null${o?.academyId ? ` or academy_id = ${uid(o.academyId)}` : ''})
          limit 200`,
      )) as unknown as {
        id: string
        academy_id: string | null
        name: string
        trigger_description: string | null
        plan: { steps: PlanStep[]; params: string[] } | PlanStep[]
        captured_from: string | null
      }[]
    },
  ).catch(() => [])

  let best: { row: (typeof rows)[number]; score: number } | null = null
  for (const row of rows) {
    const have = new Set([...tokens(row.name), ...tokens(row.trigger_description ?? '')])
    if (!have.size) continue
    const hits = want.filter((t) => have.has(t)).length
    const score = hits / Math.min(want.length, have.size)
    if (hits >= 2 && score >= 0.34 && (!best || score > best.score)) best = { row, score }
  }
  if (!best) return null

  const plan = Array.isArray(best.row.plan) ? best.row.plan : (best.row.plan?.steps ?? [])
  const params = Array.isArray(best.row.plan) ? paramsIn(plan) : (best.row.plan?.params ?? [])
  return {
    id: best.row.id,
    academy_id: best.row.academy_id,
    name: best.row.name,
    trigger_description: best.row.trigger_description,
    plan,
    params,
    captured_from: best.row.captured_from,
  }
}

function paramsIn(plan: unknown): string[] {
  const out = new Set<string>()
  const json = JSON.stringify(plan ?? [])
  for (const m of json.matchAll(TOKEN_RE)) out.add(m[1])
  return [...out]
}

/* ------------------------------------------------------------------------- *
 * Apply
 * ------------------------------------------------------------------------- */

/**
 * Bind a recipe's placeholders and run it through the ordinary plan machinery
 * — same validation, same diff, same staged messages, same audit entry. A
 * recipe is a shortcut through composition, never a shortcut past the
 * guarantees.
 */
export async function applyRecipe(
  ctx: SessionCtx,
  o: {
    recipe: CapturedRecipe
    bindings: Record<string, unknown>
    intent: string
    execute?: boolean
  },
): Promise<{
  steps: PlanStep[]
  result: PlanResult
  needsPreview: boolean
  executed: boolean
  auditId?: string
}> {
  const missing = o.recipe.params.filter((p) => o.bindings[p] === undefined || o.bindings[p] === null)
  if (missing.length) throw new Error(`recipes: "${o.recipe.name}" still needs ${missing.join(', ')}`)

  let json = JSON.stringify(o.recipe.plan)
  for (const [k, v] of Object.entries(o.bindings)) {
    const value = String(v)
    if (/["\\]/.test(value)) throw new Error(`recipes: refusing a binding with quoting in it (${k})`)
    json = json.split(`{{${k}}}`).join(value)
  }
  const left = paramsIn(JSON.parse(json))
  if (left.length) throw new Error(`recipes: "${o.recipe.name}" has unfilled placeholders: ${left.join(', ')}`)

  const steps = parseSteps(JSON.parse(json))
  const preview = await previewPlan(ctx, steps)
  const gate = needsPreview(preview, steps, {
    actorContactId: ctx.role === 'user' ? ctx.contactId : undefined,
  })

  if (!preview.ok || !o.execute || gate) {
    return { steps, result: preview, needsPreview: gate, executed: false }
  }
  const done = await executePlan(ctx, steps, o.intent)
  return { steps, result: done, needsPreview: false, executed: done.ok, auditId: done.auditId }
}

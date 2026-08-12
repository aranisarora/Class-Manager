/**
 * lib/web/views.ts — minting and resolving views (§15).
 *
 * Two moments, deliberately separate, exactly as with actions (§2.2):
 *
 *   MINT   — the model authors a spec. It is validated, its queries are probed
 *            under the eventual link holder's own RLS, oversized results are cut
 *            down, components that violate their data contract are retried once
 *            and then degraded to `table`. A `view_spec` row is written and a
 *            short-TTL signed link comes back. Anything that cannot be rendered
 *            at all throws, so the caller answers in chat — a view is an upgrade
 *            to a text answer, never a prerequisite for one.
 *
 *   RESOLVE — the stored spec is replayed. Every query runs through
 *            `modelQuery` under the LINK HOLDER's RLS, so a link can only ever
 *            show what that person could have seen by hand.
 *
 * The §15 failure table, exactly:
 *   component doesn't exist   -> fall back to `table`
 *   contract violation        -> reject at mint, retry once, then `table`
 *   too much data             -> aggregate or paginate at mint time
 *   genuinely novel need      -> `prose` + `table` (the caller's choice)
 */

import type { SessionCtx } from '@/lib/db'
import { modelQuery, withSession, assertSingleReadStatement } from '@/lib/db'
import { now } from '@/lib/clock'
import { signLink, linkUrl, TTL } from '@/lib/web/jwt'
import type { LinkPurpose } from '@/lib/web/jwt'
import {
  ALIASES,
  COMPONENT_TYPES,
  REGISTRY,
  ViewSpecSchema,
  hasQuery,
  pickKey,
} from '@/lib/web/registry'
import type { ComponentSpec, ComponentType, ViewSpec, VegaLiteish } from '@/lib/web/registry'

// ---------------------------------------------------------------------------
// Caps. "Too much data: aggregate or paginate at mint time; never ship a
// 5,000-row page."
// ---------------------------------------------------------------------------

/** Rows rendered per page, per component type. A phone, remember. */
export const MAX_ROWS: Record<ComponentType, number> = {
  table: 200,
  prose: 0,
  form: 0,
  calendar: 300,
  'people-list': 200,
  detail: 40,
  'stat-cards': 12,
  timeline: 200,
  chart: 2000,
}

/** Above this, the stored query itself is cut down at mint time. */
export const HARD_CAP = 2000

export type ResolvedComponent = {
  spec: ComponentSpec
  rows: Record<string, unknown>[]
  columns: string[]
  page: number
  pageSize: number
  hasMore: boolean
  ms: number
  /** Why this component is not what the model asked for, in plain words. */
  note?: string
  /** The query failed. The component renders an honest line, not a crash. */
  error?: string
}

export type ResolvedView = {
  title: string
  components: ResolvedComponent[]
  page: number
  ms: number
}

export type MintedView = {
  id: string
  token: string
  /** The signed link. This is what goes behind the button (§14.6). */
  url: string
  spec: ViewSpec
  expiresAt: Date
  /** Everything that was changed to make the spec renderable. */
  notes: string[]
}

// ---------------------------------------------------------------------------
// Query plumbing
// ---------------------------------------------------------------------------

function clean(query: string): string {
  return query.trim().replace(/;+\s*$/, '')
}

/** `select * from (<q>) _p limit N offset M`. Integers only, never interpolated
 *  from user input. */
export function wrapPaged(query: string, limit: number, offset: number): string {
  const l = Math.max(1, Math.floor(limit))
  const o = Math.max(0, Math.floor(offset))
  return `select * from (\n${clean(query)}\n) _cm_page limit ${l}${o > 0 ? ` offset ${o}` : ''}`
}

function wrapCount(query: string): string {
  return `select count(*)::bigint as n from (\n${clean(query)}\n) _cm_count`
}

function columnsOf(rows: Record<string, unknown>[]): string[] {
  const seen: string[] = []
  for (const r of rows.slice(0, 20)) {
    for (const k of Object.keys(r)) if (!seen.includes(k)) seen.push(k)
  }
  return seen
}

// ---------------------------------------------------------------------------
// Data contracts. A component whose query does not produce what the registry
// says it needs is a contract violation — rejected at mint, retried once, then
// degraded to `table`, which renders any tabular result.
// ---------------------------------------------------------------------------

function transformOutputs(spec: VegaLiteish): string[] {
  const out: string[] = []
  for (const t of spec.transform ?? []) {
    if ('aggregate' in t) for (const a of t.aggregate) out.push(a.as)
  }
  return out
}

/** null when the rows satisfy the component's contract; otherwise the reason. */
export function contractViolation(c: ComponentSpec, columns: string[], rowCount: number): string | null {
  if (columns.length === 0 && rowCount === 0) return null // an honest empty result renders fine
  switch (c.type) {
    case 'table':
      return columns.length > 0 ? null : 'the query returned no columns'
    case 'calendar': {
      if (!pickKey(columns, ALIASES.when)) return 'no start timestamp column (starts_at / at / when / date)'
      if (!pickKey(columns, ALIASES.title)) return 'no title column (title / name / class_name)'
      return null
    }
    case 'people-list':
      return pickKey(columns, ALIASES.person) ? null : 'no person name column (name / full_name / player / coach)'
    case 'detail':
      return columns.length > 0 ? null : 'the query returned no columns'
    case 'stat-cards': {
      const label = pickKey(columns, ['label', 'metric', 'name', 'title', 'key'])
      const value = pickKey(columns, ['value', 'amount', 'total', 'count', 'n'])
      if (!label || !value) return 'stat-cards needs a label column and a value column'
      return null
    }
    case 'timeline': {
      if (!pickKey(columns, ALIASES.when)) return 'no timestamp column (at / when / occurred_at / starts_at)'
      if (!pickKey(columns, ALIASES.title)) return 'no title column (title / name / event / description)'
      return null
    }
    case 'chart': {
      const known = new Set([...columns, ...transformOutputs(c.spec)])
      for (const [channel, def] of Object.entries(c.spec.encoding)) {
        if (!def) continue
        if (!def.field) {
          if (def.aggregate === 'count') continue
          return `encoding.${channel} has no field`
        }
        if (!known.has(def.field)) return `encoding.${channel} reads "${def.field}", which the query does not return`
      }
      if (!c.spec.encoding.x && !c.spec.encoding.theta) return 'a chart needs an x encoding (or theta, for arc)'
      if (!c.spec.encoding.y && !c.spec.encoding.theta) return 'a chart needs a y encoding (or theta, for arc)'
      return null
    }
    default:
      return null
  }
}

/** Any component degrades to this: `table` renders any tabular result. */
function degradeToTable(c: ComponentSpec): ComponentSpec {
  const title = 'title' in c ? c.title : undefined
  const query = hasQuery(c) ? c.query : ''
  return { type: 'table', title, query }
}

// ---------------------------------------------------------------------------
// Validation and repair. "Validation rejects at mint time; retry once, then
// table." The retry is a repair pass: unknown keys are dropped, an unknown
// component type becomes `table`, and a component that still will not parse is
// dropped rather than poisoning the whole view.
// ---------------------------------------------------------------------------

export type ValidationResult = { spec: ViewSpec; notes: string[] }

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function repair(raw: unknown, notes: string[]): unknown {
  const root = asRecord(raw)
  if (!root) return raw
  const components = Array.isArray(root.components) ? root.components : []
  const repaired: unknown[] = []
  for (const item of components) {
    const c = asRecord(item)
    if (!c) {
      notes.push('dropped a component that was not an object')
      continue
    }
    const type = typeof c.type === 'string' ? c.type : ''
    if (!(COMPONENT_TYPES as readonly string[]).includes(type)) {
      // §15: "Component doesn't exist -> fall back to table."
      if (typeof c.query === 'string' && c.query.trim().length > 5) {
        notes.push(`"${type || 'unnamed'}" is not a component; rendered as a table`)
        repaired.push({ type: 'table', query: c.query, ...(typeof c.title === 'string' ? { title: c.title } : {}) })
      } else if (typeof c.markdown === 'string') {
        notes.push(`"${type || 'unnamed'}" is not a component; rendered as prose`)
        repaired.push({ type: 'prose', markdown: c.markdown })
      } else {
        notes.push(`dropped "${type || 'unnamed'}" — not a component and nothing to render`)
      }
      continue
    }
    const single = ViewSpecSchema.safeParse({ title: 'probe', components: [c] })
    if (single.success) {
      repaired.push(c)
      continue
    }
    if (typeof c.query === 'string' && c.query.trim().length > 5) {
      notes.push(`${type} did not validate (${single.error.issues[0]?.message ?? 'invalid'}); rendered as a table`)
      repaired.push({ type: 'table', query: c.query, ...(typeof c.title === 'string' ? { title: c.title } : {}) })
    } else {
      notes.push(`dropped ${type} — ${single.error.issues[0]?.message ?? 'invalid'}`)
    }
  }
  return {
    title: typeof root.title === 'string' && root.title.trim() ? root.title.slice(0, 120) : 'Your view',
    components: repaired,
  }
}

/**
 * Parse; on failure repair once and re-parse. Throws when nothing renderable
 * survives — §15's floor: the caller then answers in chat.
 */
export function validateOrRepair(raw: unknown): ValidationResult {
  const first = ViewSpecSchema.safeParse(raw)
  if (first.success) return { spec: first.data, notes: [] }

  const notes: string[] = [`the spec did not validate (${first.error.issues[0]?.message ?? 'invalid'})`]
  const second = ViewSpecSchema.safeParse(repair(raw, notes))
  if (second.success) return { spec: second.data, notes }

  throw new Error(
    `view_unrenderable: ${second.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
  )
}

// ---------------------------------------------------------------------------
// Resolve
// ---------------------------------------------------------------------------

async function resolveOne(
  ctx: SessionCtx,
  c: ComponentSpec,
  page: number,
  carriedNote?: string,
): Promise<ResolvedComponent> {
  const base: ResolvedComponent = {
    spec: c,
    rows: [],
    columns: [],
    page,
    pageSize: MAX_ROWS[c.type],
    hasMore: false,
    ms: 0,
    note: carriedNote,
  }

  if (!hasQuery(c)) return base

  try {
    assertSingleReadStatement(c.query)
  } catch (e) {
    return { ...base, spec: degradeToTable(c), error: `That query isn't a single read: ${(e as Error).message}` }
  }

  const pageSize = MAX_ROWS[c.type]
  const offset = (page - 1) * pageSize
  // One row over the page tells us there is a next page without a second query.
  const res = await modelQuery(ctx, wrapPaged(c.query, pageSize + 1, offset))
  if (res.error) {
    return { ...base, spec: degradeToTable(c), ms: res.ms, error: res.error }
  }

  const hasMore = res.rows.length > pageSize
  const rows = hasMore ? res.rows.slice(0, pageSize) : res.rows
  const columns = columnsOf(rows)

  const violation = contractViolation(c, columns, rows.length)
  if (violation) {
    // Resolve time is past the point of retrying — mint already did that.
    // §15: fall back to `table`, which renders any tabular result.
    return {
      ...base,
      spec: degradeToTable(c),
      rows,
      columns,
      hasMore,
      ms: res.ms,
      note: [carriedNote, `shown as a table — ${violation}`].filter(Boolean).join(' · '),
    }
  }

  return { ...base, rows, columns, hasMore, ms: res.ms }
}

/**
 * Run every component's query under the link holder's RLS and return something
 * renderable. Never throws for a data reason: a component that fails carries an
 * `error` and the page says so in words.
 */
export async function resolveView(
  ctx: SessionCtx,
  spec: ViewSpec,
  opts?: { page?: number },
): Promise<ResolvedView> {
  const started = Date.now()
  const page = Math.max(1, Math.floor(opts?.page ?? 1))
  const components: ResolvedComponent[] = []
  for (const c of spec.components) {
    // A component type that is not in the registry cannot be rendered by
    // anything; `table` can render its rows. (§15 row 1.)
    const known = (COMPONENT_TYPES as readonly string[]).includes(c.type)
    const target = known ? c : degradeToTable(c)
    const note = known ? undefined : `"${c.type}" isn't a component here — shown as a table`
    components.push(await resolveOne(ctx, target, page, note))
  }
  return { title: spec.title, components, page, ms: Date.now() - started }
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

/** The contact a link for this person should be signed to. */
async function primaryContactId(academyId: string, personId: string): Promise<string | null> {
  return withSession({ role: 'service', academyId }, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      select id from contact
       where academy_id = ${academyId}
         and person_id  = ${personId}
       order by is_primary desc, created_at asc
       limit 1`
    return rows[0]?.id ?? null
  })
}

async function probe(
  holder: SessionCtx,
  c: ComponentSpec,
  notes: string[],
): Promise<ComponentSpec> {
  if (!hasQuery(c)) return c

  try {
    assertSingleReadStatement(c.query)
  } catch (e) {
    notes.push(`${c.type}: ${(e as Error).message} — shown as a table`)
    return degradeToTable(c)
  }

  const sample = async () => modelQuery(holder, wrapPaged(c.query, 5, 0))

  let res = await sample()
  if (res.error) {
    // Retry once (§15 row 2) — a timeout or a transient failure should not cost
    // the whole component.
    res = await sample()
    if (res.error) {
      notes.push(`${c.type}: the query failed (${res.error}) — shown as a table`)
      return degradeToTable(c)
    }
  }

  let violation = contractViolation(c, columnsOf(res.rows), res.rows.length)
  if (violation) {
    res = await sample()
    violation = res.error ? violation : contractViolation(c, columnsOf(res.rows), res.rows.length)
    if (violation) {
      notes.push(`${c.type} doesn't fit its data — ${violation}. Shown as a table.`)
      return degradeToTable(c)
    }
  }

  // "Too much data: aggregate or paginate at mint time; never ship a 5,000-row
  // page." Pagination is the resolver's job and happens for free; what mint
  // owes is a hard ceiling baked into the stored query.
  const counted = await modelQuery(holder, wrapCount(c.query))
  const total = Number(counted.rows[0]?.n ?? 0)
  if (!counted.error && total > HARD_CAP) {
    notes.push(`that question matches ${total.toLocaleString('en-IN')} rows — capped at ${HARD_CAP.toLocaleString('en-IN')}`)
    const capped = wrapPaged(c.query, HARD_CAP, 0)
    return { ...c, query: capped } as ComponentSpec
  }
  return c
}

/**
 * Validate, probe, store, sign. Returns the signed link plus the id of the
 * `view_spec` row (which is what an `{kind:'view'}` action payload carries).
 *
 * Throws `view_unrenderable` when nothing survives validation — the caller then
 * answers in chat, which is the floor (§15).
 */
export async function mintView(
  ctx: SessionCtx,
  spec: unknown,
  forPersonId: string,
  ttlMinutes: number = TTL.view,
): Promise<MintedView> {
  const { spec: validated, notes } = validateOrRepair(spec)

  const contactId = await primaryContactId(ctx.academyId, forPersonId)
  if (!contactId) throw new Error('view_unrenderable: that person has no contact to sign a link to')

  const holder: SessionCtx = {
    role: 'user',
    academyId: ctx.academyId,
    personId: forPersonId,
    contactId,
  }

  const components: ComponentSpec[] = []
  for (const c of validated.components) components.push(await probe(holder, c, notes))

  const stored: ViewSpec = { title: validated.title, components }
  const at = await now()
  const ttl = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : TTL.view
  const expiresAt = new Date(at.getTime() + ttl * 60_000)

  const id = await withSession({ role: 'service', academyId: ctx.academyId }, async (tx) => {
    const rows = await tx<{ id: string }[]>`
      insert into view_spec (academy_id, spec, for_person_id, expires_at, minted_at)
      values (${ctx.academyId}, ${JSON.stringify(stored)}::text::jsonb, ${forPersonId}, ${expiresAt}, ${at})
      returning id`
    return rows[0]!.id
  })

  const purpose: LinkPurpose = stored.components.some((c) => c.type === 'form') ? 'form' : 'view'
  const token = await signLink(
    { academy_id: ctx.academyId, person_id: forPersonId, contact_id: contactId, purpose, ref: id },
    ttl,
  )

  return { id, token, url: linkUrl(token), spec: stored, expiresAt, notes }
}

/** Load a stored spec under the link holder's own RLS (the `view_spec` policy
 *  is `for_person_id = app.person_id()`), checking expiry against the drivable
 *  clock rather than wall time. */
export async function loadViewSpec(
  ctx: SessionCtx,
  id: string,
): Promise<{ spec: ViewSpec; expired: boolean } | null> {
  const at = await now()
  const row = await withSession(ctx, async (tx) => {
    const rows = await tx<{ spec: unknown; expires_at: Date }[]>`
      select spec, expires_at from view_spec where id = ${id} limit 1`
    return rows[0] ?? null
  })
  if (!row) return null
  const parsed = ViewSpecSchema.safeParse(row.spec)
  if (!parsed.success) {
    // A stored spec that no longer parses is still not a crash: repair it the
    // same way mint would have.
    try {
      const { spec } = validateOrRepair(row.spec)
      return { spec, expired: new Date(row.expires_at).getTime() <= at.getTime() }
    } catch {
      return null
    }
  }
  return { spec: parsed.data, expired: new Date(row.expires_at).getTime() <= at.getTime() }
}

/**
 * The other three link purposes (§7.1 setup, §8.2 the register, and a bare
 * form) do not carry a stored spec — the page IS the spec. This is the one
 * helper that mints them, so no caller hand-rolls a JWT.
 */
export async function mintPurposeLink(o: {
  academyId: string
  personId: string
  contactId: string
  purpose: LinkPurpose
  ref?: string
  ttlMinutes?: number
}): Promise<{ token: string; url: string }> {
  const ttl = o.ttlMinutes ?? TTL[o.purpose]
  const token = await signLink(
    {
      academy_id: o.academyId,
      person_id: o.personId,
      contact_id: o.contactId,
      purpose: o.purpose,
      ...(o.ref ? { ref: o.ref } : {}),
    },
    ttl,
  )
  return { token, url: linkUrl(token) }
}

/** Registry lookup used by the renderer; keeps the two files honest. */
export function registryEntry(type: ComponentType) {
  return REGISTRY[type]
}

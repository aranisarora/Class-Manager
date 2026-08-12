/**
 * lib/agent/memory.ts — §5. CONTRACTS §6.
 *
 * Two different things, deliberately not collapsed into one:
 *
 *   `memory_fact` is append-only and IS the record. Nothing the bot learned is
 *   lost because the prompt budget got tight. A fact is never edited and never
 *   deleted — a correction writes a superseding row.
 *
 *   `academy.memory` / `person.memory` are a bounded HOT SET, rebuilt from the
 *   record on a schedule. A cache, never the record.
 *
 * Collapsing them into one capped text blob is how a memory system becomes an
 * amnesia system: the pruning decision then gets made by a model under context
 * pressure, and what it drops is invisible. Anything outside the hot set stays
 * retrievable through `searchFacts` — forgetting is a context decision, never a
 * storage one.
 */
import type { MemoryFact, SubjectKind } from '@/lib/types'
import { withSession, type SessionCtx } from '@/lib/db'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { generate } from '@/lib/agent/gemini'

/** §5/§13 — curation runs when a subject's store crosses this, never per turn. */
export const CURATE_THRESHOLD = 12

/** ~400 tokens of hot set (§4.4). Past this it stops being bounded. */
const HOT_SET_MAX_CHARS = 1400
const HOT_SET_MAX_LINES = 12

function fail(code: string, message: string): never {
  throw new AppError({ code, message })
}

// -----------------------------------------------------------------------------
// Tenant resolution
//
// memory_fact, academy.memory and person.memory are all tenant-pinned by RLS, so
// every read needs the academy. `hotSet` and `curate` are called with a subject,
// not a session, so the academy is remembered from whichever call knew it —
// every write, every search, and `variableTail`, which passes it explicitly.
// -----------------------------------------------------------------------------

const TENANT_OF = new Map<string, string>()

function noteTenant(subjectId: string, academyId: string): void {
  if (subjectId && academyId) TENANT_OF.set(subjectId, academyId)
}

function tenantOf(kind: SubjectKind, subjectId: string, hint?: string): string | null {
  if (kind === 'academy') return subjectId
  if (hint) {
    noteTenant(subjectId, hint)
    return hint
  }
  return TENANT_OF.get(subjectId) ?? null
}

/** `job` is global infrastructure — its cm_service policy ignores the academy GUC. */
const NIL_ACADEMY = '00000000-0000-0000-0000-000000000000'

/**
 * A curation job carries its academy in the payload it was enqueued with, so a
 * cold worker process — which has no in-memory history of the subject — can
 * still resolve the tenant it must act in.
 */
async function tenantFromJob(subjectId: string): Promise<string | null> {
  try {
    const rows = await withSession(serviceCtx(NIL_ACADEMY), async (tx) => {
      const r = await tx`
        select payload->>'academy_id' as academy_id
        from job
        where kind = 'memory_curate' and payload->>'subject_id' = ${subjectId}
        order by run_at desc
        limit 1
      `
      return r as unknown as { academy_id: string | null }[]
    })
    const found = rows[0]?.academy_id ?? null
    if (found) noteTenant(subjectId, found)
    return found
  } catch {
    return null
  }
}

function serviceCtx(academyId: string): SessionCtx {
  // §6.7: the fact store is infrastructure — reached by the runtime's own role,
  // never through a user session, which has SELECT on it and nothing more.
  return { role: 'service', academyId }
}

// The live set, everywhere below, is: retired_at is null AND not superseded by a
// newer row. Superseding is how a correction lands — the old row stays.

// -----------------------------------------------------------------------------
// writeFact — append-only, always
// -----------------------------------------------------------------------------

export async function writeFact(
  ctx: SessionCtx,
  f: {
    subjectKind: SubjectKind
    subjectId: string
    fact: string
    source?: string
    supersedes?: string
  },
): Promise<string> {
  const fact = f.fact.trim()
  if (!fact) fail('memory_empty_fact', 'writeFact called with an empty fact')
  if (f.subjectKind === 'academy' && f.subjectId !== ctx.academyId) {
    fail('memory_wrong_tenant', 'an academy fact must be about the acting academy')
  }
  noteTenant(f.subjectId, ctx.academyId)

  const written = await withSession(serviceCtx(ctx.academyId), async (tx) => {
    if (f.subjectKind === 'person') {
      const owner = (await tx`
        select 1 from person where id = ${f.subjectId} limit 1
      `) as unknown as unknown[]
      if (owner.length === 0) {
        fail('memory_wrong_tenant', 'no such person in this academy')
      }
    }

    // Append-only does not mean append-twice. An identical live fact is already
    // the record; re-stating it adds noise to every future curation.
    const existing = (await tx`
      select id from memory_fact
      where subject_kind = ${f.subjectKind}
        and subject_id = ${f.subjectId}
        and fact = ${fact}
        and retired_at is null
      limit 1
    `) as unknown as { id: string }[]
    if (existing.length > 0 && !f.supersedes) return { id: existing[0].id, curateBatch: null }

    const inserted = (await tx`
      insert into memory_fact (academy_id, subject_kind, subject_id, fact, source, supersedes)
      values (${ctx.academyId}, ${f.subjectKind}, ${f.subjectId}, ${fact},
              ${f.source ?? null}, ${f.supersedes ?? null})
      returning id
    `) as unknown as { id: string }[]

    const liveCount = (await tx`
      select count(*)::int as n from memory_fact
      where subject_kind = ${f.subjectKind} and subject_id = ${f.subjectId}
        and retired_at is null
        and id not in (select supersedes from memory_fact where supersedes is not null)
    `) as unknown as { n: number }[]

    const n = liveCount[0]?.n ?? 0
    const crossed = n > 0 && n % CURATE_THRESHOLD === 0
    return {
      id: inserted[0].id,
      curateBatch: crossed ? Math.floor(n / CURATE_THRESHOLD) : null,
    }
  })

  // §5: curation is scheduled, not per-turn — rebuilding the hot set is a model
  // call, and running one after every turn roughly doubles the model calls in
  // the product for no benefit. Enqueued in its own session, after the fact is
  // committed: a scheduling failure is a stale cache, never a lost fact. The
  // dedupe key makes a second crossing of the same threshold a no-op (§13).
  if (written.curateBatch !== null) {
    const payload = JSON.stringify({
      academy_id: ctx.academyId,
      subject_kind: f.subjectKind,
      subject_id: f.subjectId,
    })
    const dedupeKey = `mem:${f.subjectId}:${written.curateBatch}`
    try {
      await withSession(serviceCtx(ctx.academyId), async (tx) => {
        await tx`
          select app.enqueue_job('memory_curate', app.now(), ${dedupeKey}, ${payload}::text::jsonb)
        `
      })
    } catch {
      // The record is already written. Never fail a fact over its cache.
    }
  }

  return written.id
}

// -----------------------------------------------------------------------------
// hotSet — the bounded cache the prompt actually carries
// -----------------------------------------------------------------------------

export async function hotSet(
  subjectKind: SubjectKind,
  subjectId: string,
  academyId?: string,
): Promise<string> {
  const tenant = tenantOf(subjectKind, subjectId, academyId)
  if (!tenant) return ''
  try {
    const rows = await withSession(serviceCtx(tenant), async (tx) => {
      const r =
        subjectKind === 'academy'
          ? await tx`select memory from academy where id = ${subjectId}`
          : await tx`select memory from person where id = ${subjectId}`
      return r as unknown as { memory: string | null }[]
    })
    return (rows[0]?.memory ?? '').trim()
  } catch {
    // A hot set that cannot be read is an empty context, not a dead turn. The
    // record is untouched and searchFacts still reaches it.
    return ''
  }
}

// -----------------------------------------------------------------------------
// searchFacts — reaching past the hot set
// -----------------------------------------------------------------------------

const SEARCH_CANDIDATES = 400
const SEARCH_RESULTS = 20

export async function searchFacts(
  ctx: SessionCtx,
  subjectId: string,
  query: string,
): Promise<MemoryFact[]> {
  noteTenant(subjectId, ctx.academyId)
  const terms = tokenise(query)
  const patterns = terms.map((t) => `%${t}%`)

  const rows = await withSession(serviceCtx(ctx.academyId), async (tx) => {
    const r = await tx`
      select * from memory_fact
      where subject_id = ${subjectId}
        and retired_at is null
        and id not in (select supersedes from memory_fact where supersedes is not null)
        and (${patterns.length === 0}::boolean or fact ilike any(${patterns}::text[]))
      order by created_at desc
      limit ${SEARCH_CANDIDATES}
    `
    return r as unknown as MemoryFact[]
  })

  // ILIKE finds the exact word; the ranking is what copes with "aarav's fees" vs
  // "fee cycle for Aarav". Character trigrams, scored by Dice coefficient — the
  // same shape pg_trgm uses, computed here so the store needs no extension.
  if (terms.length === 0) return rows.slice(0, SEARCH_RESULTS)
  const q = trigrams(query.toLowerCase())
  const scored = rows.map((r, i) => {
    const factText = String((r as unknown as { fact: string }).fact ?? '').toLowerCase()
    const overlap = terms.filter((t) => factText.includes(t)).length / terms.length
    const fuzzy = dice(q, trigrams(factText))
    // Newer facts break ties: the store is ordered newest first.
    const recency = (rows.length - i) / (rows.length * 1000)
    return { row: r, score: overlap * 0.6 + fuzzy * 0.4 + recency }
  })
  return scored
    .filter((s) => s.score > 0.02)
    .sort((a, b) => b.score - a.score)
    .slice(0, SEARCH_RESULTS)
    .map((s) => s.row)
}

function tokenise(q: string): string[] {
  return Array.from(
    new Set(
      q
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
    ),
  ).slice(0, 8)
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'about', 'what', 'when', 'they', 'them',
  'this', 'that', 'from', 'have', 'has', 'does', 'did', 'you', 'your', 'our',
  'any', 'all', 'know', 'tell', 'say', 'said',
])

function trigrams(s: string): Set<string> {
  const padded = `  ${s.replace(/\s+/g, ' ').trim()} `
  const out = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3))
  return out
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const g of a) if (b.has(g)) shared++
  return (2 * shared) / (a.size + b.size)
}

// -----------------------------------------------------------------------------
// curate — rebuild the hot set from the live fact set. Scheduled, not per-turn.
// -----------------------------------------------------------------------------

const CURATE_SYSTEM = `You maintain the memory of a WhatsApp manager for a coaching business.

You are given the complete live fact set held about one subject — either the
business itself or one person. Rebuild the bounded hot set: the handful of facts
worth carrying in every prompt from now on.

Rules:
- Facts, not transcripts. "Prefers voice notes over typing", never "said on the 4th that…".
- Keep only facts that change behavior: vocabulary, timing preferences, policies,
  standing constraints, what this person routinely asks for, how they like to be
  contacted. A fact that changes nothing is a diary entry — drop it.
- When two facts conflict, the newer one wins. Do not carry both.
- Merge duplicates and near-duplicates into one clear line.
- Vocabulary and standing policy first; habits second; one-off details last.
- No ids, no timestamps, no dates unless the date is the point ("boards in March").
- Each line short and plain, under 140 characters. At most 12 lines.
- Dropping a fact here does not delete it — the full record stays searchable. Be
  willing to leave things out.

Return JSON: {"lines": ["...", "..."]}`

export async function curate(
  subjectKind: SubjectKind,
  subjectId: string,
  academyId?: string,
): Promise<void> {
  const tenant = tenantOf(subjectKind, subjectId, academyId) ?? (await tenantFromJob(subjectId))
  if (tenant === null) {
    throw new AppError({
      code: 'memory_unknown_tenant',
      message: `curate(${subjectKind}, ${subjectId}) has no academy to act in: none passed, none remembered, and no memory_curate job carries one`,
    })
  }

  const facts = await withSession(serviceCtx(tenant), async (tx) => {
    const r = await tx`
      select fact, created_at from memory_fact
      where subject_kind = ${subjectKind} and subject_id = ${subjectId}
        and retired_at is null
        and id not in (select supersedes from memory_fact where supersedes is not null)
      order by created_at asc
      limit 500
    `
    return r as unknown as { fact: string; created_at: Date | string }[]
  })

  if (facts.length === 0) {
    await writeHotSet(tenant, subjectKind, subjectId, null)
    return
  }

  const listing = facts
    .map((f, i) => `${i + 1}. [${isoDay(f.created_at)}] ${f.fact}`)
    .join('\n')

  const res = await generate({
    system: CURATE_SYSTEM,
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Subject: ${subjectKind === 'academy' ? 'the business' : 'one person'}\nLive facts, oldest first:\n\n${listing}`,
          },
        ],
      },
    ],
    model: env.MODEL_SYNTH,
    temperature: 0.2,
    maxOutputTokens: 2048,
    responseJsonSchema: {
      type: 'object',
      properties: { lines: { type: 'array', items: { type: 'string' } } },
      required: ['lines'],
    },
  })

  const lines = parseLines(res.text)
  const memo = bound(lines)
  await writeHotSet(tenant, subjectKind, subjectId, memo)
}

async function writeHotSet(
  academyId: string,
  subjectKind: SubjectKind,
  subjectId: string,
  memo: string | null,
): Promise<void> {
  await withSession(serviceCtx(academyId), async (tx) => {
    if (subjectKind === 'academy') {
      await tx`update academy set memory = ${memo} where id = ${subjectId}`
    } else {
      await tx`update person set memory = ${memo} where id = ${subjectId}`
    }
  })
}

function parseLines(text: string): string[] {
  const raw = text.trim()
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?|```$/g, '').trim()) as {
      lines?: unknown
    }
    if (Array.isArray(parsed.lines)) {
      return parsed.lines.filter((l): l is string => typeof l === 'string')
    }
  } catch {
    // The model answered in prose. Its lines are still lines.
  }
  return raw
    .split('\n')
    .map((l) => l.replace(/^\s*[-*\d.)\]]+\s*/, '').trim())
    .filter((l) => l.length > 0)
}

function bound(lines: string[]): string | null {
  const out: string[] = []
  let chars = 0
  for (const line of lines) {
    const clean = line.trim().replace(/\s+/g, ' ')
    if (!clean) continue
    if (out.length >= HOT_SET_MAX_LINES) break
    if (chars + clean.length + 3 > HOT_SET_MAX_CHARS) break
    out.push(`- ${clean}`)
    chars += clean.length + 3
  }
  return out.length ? out.join('\n') : null
}

function isoDay(v: Date | string): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

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
import type { SubjectKind } from '@/lib/types'
import { withSession, type SessionCtx } from '@/lib/db'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { generateJson } from '@/lib/agent/deepseek'

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

/**
 * Bounded, because this is a process-lifetime cache in a process that serves
 * every tenant. It only ever grows — one entry per person anybody has written a
 * fact about — and nothing evicted it, so a long-lived worker's floor rose with
 * every new subject it ever saw. The oldest entry goes when the map is full:
 * losing one is a re-derivation from `academyId`, which every caller already
 * passes (see `hotSet`), not a wrong answer.
 */
const TENANT_OF_MAX = 5_000

function noteTenant(subjectId: string, academyId: string): void {
  if (!subjectId || !academyId) return
  if (TENANT_OF.size >= TENANT_OF_MAX && !TENANT_OF.has(subjectId)) {
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = TENANT_OF.keys().next()
    if (!oldest.done) TENANT_OF.delete(oldest.value)
  }
  TENANT_OF.set(subjectId, academyId)
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

/**
 * The academy is REQUIRED, and that is the whole fix.
 *
 * It used to be optional, falling back to `TENANT_OF` — a module-level Map populated by
 * whichever earlier call happened to know the tenant. In a warm process that works. In a
 * cold one the Map is empty, `tenantOf` returns null, and this returned `''`: **"this
 * person has no memory."** Not an error, not a log line — the same empty string a person
 * who genuinely has no memory yet produces, handed to the prompt as fact.
 *
 * All five callers already passed it, so this never fired. That is exactly what makes it
 * worth closing now rather than after: the signature invited the sixth caller to omit it,
 * and on serverless every request is a cold process. A required parameter is a guarantee
 * the compiler enforces for callers nobody has written yet — cheaper than remembering,
 * and it cannot be skipped.
 */
export async function hotSet(
  subjectKind: SubjectKind,
  subjectId: string,
  academyId: string,
): Promise<string> {
  const tenant = tenantOf(subjectKind, subjectId, academyId)
  // Unreachable through the type, reachable through an empty string. Loud, because
  // returning '' here is indistinguishable from an empty memory and always was.
  if (!tenant) throw new Error(`memory.hotSet: no academy for ${subjectKind} ${subjectId}`)
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
// Reaching past the hot set
//
// There used to be a `searchFacts` here: ILIKE over the live fact set, re-ranked
// with character trigrams and a Dice coefficient, ~75 lines. It was built for a
// `recall` tool that no longer exists, and after that tool was removed nothing
// ever called it — the only surviving reference was a dead import in `tools.ts`,
// which is why it read as live to anything counting references.
//
// The capability itself is not gone, and that is why deleting this costs nothing:
// `memory_fact` is in `SCHEMA_DOC`, including the live-set predicate
// (`retired_at is null and id not in (select supersedes …)`), so the model reaches
// past the hot set with `read` like it reaches everything else. One query surface,
// not two — and `lib/behaviors/feedback.md`'s "search the fact store before saying
// you don't know" is satisfied by the tool that actually exists.
// -----------------------------------------------------------------------------

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

  // Asked for as json rather than constrained to it — this API has no stable
  // schema enforcement — so the shape is stated in the prompt and `generateJson`
  // validates it and retries once. The old prose fallback — split whatever came
  // back on newlines and hope — is gone with it: a retry that asks again is a
  // better answer than a paragraph reinterpreted as a list, and this is a batch
  // path where the retry costs nobody anything.
  const res = await generateJson<string[]>({
    system: CURATE_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `Subject: ${subjectKind === 'academy' ? 'the business' : 'one person'}\n` +
          `Live facts, oldest first:\n\n${listing}\n\n` +
          'Answer as one json object and nothing else, in exactly this shape:\n' +
          '{"lines": ["one kept fact per string", "another"]}',
      },
    ],
    model: env.MODEL_SYNTH,
    temperature: 0.2,
    maxOutputTokens: 2048,
    validate: (v) => {
      const o = v as { lines?: unknown }
      if (!o || typeof o !== 'object' || !Array.isArray(o.lines)) return null
      return o.lines.filter((l): l is string => typeof l === 'string')
    },
  })

  // Nothing usable came back twice running. The existing hot set is the better
  // answer than an empty one: curation improves a memory, it does not own it.
  if (!res.value) return

  const memo = bound(res.value)
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

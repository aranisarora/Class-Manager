/**
 * lib/jobs/enqueue.ts — putting work on the queue (spec §6.6, §13).
 *
 * `dedupe_key` is unique, so every insert here is `on conflict do nothing`:
 * enqueueing the same moment twice is a no-op (§13 rule 1). That is what makes
 * `planAhead()` safe to run on every tick and every clock advance, and what
 * makes retries safe.
 *
 * Cancelling is by prefix, because rescheduling a session has to sweep the
 * whole ladder that hangs off it before re-enqueueing (§13 rule 4).
 *
 * @mechanism dedupe_key — the column is unique and every insert here, single or bulk, is
 *   `on conflict (dedupe_key) do nothing`, so enqueueing the same moment twice is a no-op
 *   (§13 rule 1) and a duplicate returns the existing id rather than an error. That is
 *   what lets `planAhead()` run on every tick and every clock advance without writing
 *   anything, and what makes a retry safe. The key families are defined in one place
 *   (`dedupe` in `kinds.ts`), so the planner and the handler that re-enqueues after it
 *   agree on what "the same moment" is.
 */

import {
  AGENT_TASK_CAP, dedupe, isJobKind, sessionJobPrefixes,
  type JobKind,
} from './kinds'
import { withInfra } from './util'

export type JobSpec = {
  kind: JobKind
  runAt: Date
  dedupeKey: string
  payload: Record<string, unknown>
  academyId?: string
  /**
   * What this job is WATCHING, normalised (0032). A second job with the same
   * subject supersedes the first instead of sitting beside it.
   *
   * `dedupeKey` answers "is this the same job"; it cannot answer "is this the
   * same thing being watched", because the model mints a fresh slug every time.
   * F-C is what that costs: seven watches about the same two unmarked registers,
   * seven near-identical messages to one coach in three minutes — and then the
   * frequency cap dropping the one message that mattered, a parent's cancellation
   * reaching nobody.
   */
  subjectKey?: string
}

function toRow(spec: JobSpec) {
  const payload = { ...spec.payload }
  if (spec.academyId && !payload.academy_id) payload.academy_id = spec.academyId
  return {
    kind: spec.kind,
    run_at: spec.runAt.toISOString(),
    dedupe_key: spec.dedupeKey,
    subject_key: spec.subjectKey ?? null,
    payload: JSON.stringify(payload),
  }
}

/**
 * The subject key for a watch: the academy, then the subject as the model stated
 * it, normalised.
 *
 * Normalising a DECLARED key is not the runtime reading prose — it is the same
 * operation `tally_line.dedupe_key` performs on billing identity, and for the
 * same reason: a shared literal stops two writers drifting, and only a constraint
 * stops a third writer nobody has written yet. Lower-cased, punctuation-collapsed
 * so "Meera's unpaid fee" and "meera unpaid fee" are one subject.
 */
export function watchSubjectKey(academyId: string, subject: string): string {
  const norm = String(subject ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return `agent:${academyId}:${norm}`
}

/**
 * §13.1 — `expires_at` is required and there is a cap per academy on live
 * tasks. "A watch with no expiry is a leak; the runtime rejects a task without
 * one." This is the choke point where that is true, so the rejection lives here
 * rather than in the tool that mints them.
 *
 * @mechanism guardAgentTask — no watch the MODEL mints reaches the queue without a
 *   parseable `expires_at`, an instruction and an academy, and no academy may hold more
 *   than AGENT_TASK_CAP live ones. Every minting tool goes through `enqueue`, so the rule
 *   lives at that choke point rather than in the tool: a watch with no expiry runs until
 *   somebody notices, and an uncapped pile of them is the model committing the business to
 *   unbounded future work nobody asked for. The planner's expired-question sweep is the one
 *   path that does not pass here — it bulk-inserts through `enqueueMany` and sets its own
 *   seven-day expiry.
 */
async function guardAgentTask(payload: Record<string, unknown>, academyId: string | undefined): Promise<void> {
  const expires = payload.expires_at
  if (typeof expires !== 'string' || expires.trim() === '' || Number.isNaN(Date.parse(expires))) {
    throw new Error('agent_task requires expires_at (§13.1) — a watch with no expiry is a leak')
  }
  if (typeof payload.instruction !== 'string' || payload.instruction.trim() === '') {
    throw new Error('agent_task requires an instruction (§13.1)')
  }
  const academy = (payload.academy_id as string | undefined) ?? academyId
  if (!academy) throw new Error('agent_task requires academy_id — it runs inside one tenant (§13.1)')

  const [row] = await withInfra((tx) => tx<{ n: number }[]>`
    select count(*)::int as n from job
     where kind = 'agent_task' and status = 'pending'
       and payload->>'academy_id' = ${academy}
       and run_at >= app.now() - interval '1 day'
  `)
  if ((row?.n ?? 0) >= AGENT_TASK_CAP) {
    throw new Error(
      `agent_task cap reached (${AGENT_TASK_CAP} live tasks) — drop one first (§13.1)`,
    )
  }
}

/**
 * Enqueue one job. Returns the job id — the existing one when the dedupe key
 * was already there, so callers can treat a duplicate as success.
 */
export async function enqueue(
  kind: JobKind,
  runAt: Date,
  dedupeKey: string,
  payload: Record<string, unknown>,
  academyId?: string,
  subjectKey?: string,
): Promise<{ id: string; superseded: number }> {
  if (!isJobKind(kind)) throw new Error(`unknown job kind: ${kind}`)
  if (!dedupeKey || dedupeKey.trim() === '') throw new Error('every job needs a dedupe_key (§13)')
  if (kind === 'agent_task') await guardAgentTask(payload, academyId)

  const row = toRow({ kind, runAt, dedupeKey, payload, academyId, subjectKey })

  return withInfra(async (tx) => {
    /**
     * A newer watch on the same subject REPLACES the older one.
     *
     * Superseded rather than cancelled, because those are different facts and the
     * next reader of this table should not have to guess which: cancelled is
     * somebody dropping a watch, superseded is this one being restated. The
     * partial unique index on (subject_key) where status in ('pending','running')
     * is what makes the replacement true rather than intended — it refuses the
     * insert if this update somehow misses.
     *
     * @mechanism subject_key — a job records what it is WATCHING, and a newer watch on the
     *   same subject flips the older one to `superseded` — a different fact from
     *   `cancelled`, which is somebody dropping a watch. `dedupe_key` cannot do this,
     *   because the model mints a fresh slug every time; the partial unique index is what
     *   makes the replacement structural rather than intended. Without it, seven watches on
     *   the same two unmarked registers sent one coach seven near-identical messages in
     *   three minutes, and the frequency cap then dropped the one that mattered.
     *   Closes F-C.
     */
    let superseded = 0
    if (row.subject_key) {
      const gone = await tx<{ id: string }[]>`
        update job set status = 'superseded'
         where subject_key = ${row.subject_key}
           and status in ('pending', 'running')
        returning id
      `
      superseded = gone.length
    }

    const inserted = await tx<{ id: string }[]>`
      insert into job (kind, run_at, dedupe_key, subject_key, payload)
      values (${row.kind}, ${row.run_at}::timestamptz, ${row.dedupe_key}, ${row.subject_key},
              ${row.payload}::text::jsonb)
      on conflict (dedupe_key) do nothing
      returning id
    `
    if (inserted.length > 0) return { id: inserted[0].id, superseded }
    const [existing] = await tx<{ id: string }[]>`
      select id from job where dedupe_key = ${row.dedupe_key}
    `
    if (!existing) throw new Error(`enqueue lost a race on ${row.dedupe_key}`)
    return { id: existing.id, superseded }
  })
}

/**
 * Bulk enqueue for `planAhead()`. One statement per chunk, `on conflict do
 * nothing`, so re-planning the same 48 hours costs one round trip and writes
 * nothing. Returns how many rows were actually new.
 */
export async function enqueueMany(specs: JobSpec[]): Promise<number> {
  if (specs.length === 0) return 0

  // Collapse duplicates inside the batch itself — planAhead can legitimately
  // derive the same moment from two directions.
  const seen = new Set<string>()
  const rows = specs
    .filter((s) => {
      if (!isJobKind(s.kind) || !s.dedupeKey) return false
      if (seen.has(s.dedupeKey)) return false
      seen.add(s.dedupeKey)
      return true
    })
    .map(toRow)

  if (rows.length === 0) return 0

  let written = 0
  const CHUNK = 500
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const inserted = await withInfra((tx) => tx<{ id: string }[]>`
      insert into job (kind, run_at, dedupe_key, payload)
      select t.k, t.r::timestamptz, t.d, t.p::jsonb
        from unnest(
          ${chunk.map((r) => r.kind)}::text[],
          ${chunk.map((r) => r.run_at)}::text[],
          ${chunk.map((r) => r.dedupe_key)}::text[],
          ${chunk.map((r) => r.payload)}::text[]
        ) as t(k, r, d, p)
      on conflict (dedupe_key) do nothing
      returning id
    `)
    written += inserted.length
  }
  return written
}

/**
 * §13 rule 4. Cancels every *pending* job whose dedupe key starts with
 * `prefix`. `starts_with` rather than `like` on purpose: dedupe keys contain
 * underscores, which `like` would treat as wildcards.
 */
export async function cancelByPrefix(prefix: string): Promise<number> {
  if (!prefix || prefix.trim() === '') return 0
  const rows = await withInfra((tx) => tx<{ id: string }[]>`
    update job set status = 'cancelled'
     where status = 'pending' and starts_with(dedupe_key, ${prefix})
    returning id
  `)
  return rows.length
}

/**
 * The whole ladder that hangs off one session, cancelled in one call. A
 * reschedule calls this and then re-enqueues against the new time.
 */
export async function cancelSessionJobs(sessionId: string): Promise<number> {
  const prefixes = sessionJobPrefixes(sessionId)
  const rows = await withInfra((tx) => tx<{ id: string }[]>`
    update job set status = 'cancelled'
     where status = 'pending'
       and exists (
         select 1 from unnest(${prefixes}::text[]) as p(prefix)
          where starts_with(job.dedupe_key, p.prefix)
       )
    returning id
  `)
  return rows.length
}

/**
 * §13.1 — "the admin can ask what are you watching, get the list, and drop any of them."
 *
 * **`subject` and `minted_by_contact_id` are selected because the TAIL renders
 * these now, not only the cap check.** `job` is closed to the model in both
 * directions and correctly so — it is global, with no `academy_id` column to
 * scope a policy on — but that left the model unable to see its own commitments
 * at all, and the prefix told it to answer from what it remembered doing
 * instead. Carrying pending state across turns from memory is on the never-trust
 * list for good reason: driven, the model recalled a watch correctly and said so
 * (`st-watch-again`), and the recall was luck rather than a property.
 *
 * `subject` matters most. F-C's fix supersedes a second watch on the same
 * subject, and both callers — the turn and its reflection — had to phrase that
 * key identically while neither could see the keys it was matching against. A
 * supersession key nobody can read is a fix with its own evidence hidden.
 *
 * @mechanism liveAgentTasks — the model's own outstanding watches, read back out of `job`
 *   — a global table it cannot query in either direction — with the declared `subject` and
 *   who minted each one, for the cap check and for the tail that renders them. Without it
 *   the model answered "what are you watching" from what it remembered doing, which is
 *   carrying pending state across turns from memory; driven, it recalled a watch correctly
 *   once, and the recall was luck rather than a property.
 */
export async function liveAgentTasks(academyId: string): Promise<
  {
    id: string
    slug: string
    subject: string | null
    run_at: Date
    instruction: string
    expires_at: string | null
    minted_by_contact_id: string | null
  }[]
> {
  return withInfra((tx) => tx<
    {
      id: string
      slug: string
      subject: string | null
      run_at: Date
      instruction: string
      expires_at: string | null
      minted_by_contact_id: string | null
    }[]
  >`
    select id,
           coalesce(payload->>'slug', split_part(dedupe_key, ':', 3)) as slug,
           payload->>'subject' as subject,
           run_at,
           coalesce(payload->>'instruction', '') as instruction,
           payload->>'expires_at' as expires_at,
           payload->>'minted_by_contact_id' as minted_by_contact_id
      from job
     where kind = 'agent_task' and status = 'pending'
       and payload->>'academy_id' = ${academyId}
     order by run_at asc
  `)
}

/** Drop one watch (§13.1's "[drop]" button). */
export async function dropAgentTask(academyId: string, slug: string): Promise<number> {
  const rows = await withInfra((tx) => tx<{ id: string }[]>`
    update job set status = 'cancelled'
     where kind = 'agent_task' and status = 'pending'
       and dedupe_key = ${dedupe.agentTask(academyId, slug)}
    returning id
  `)
  return rows.length
}

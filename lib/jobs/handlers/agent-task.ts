/**
 * lib/jobs/handlers/agent-task.ts — the two jobs whose work belongs to the
 * agent, not to the scheduler.
 *
 *   agent_task     §13.1 — the bot schedules itself
 *   memory_curate  §5    — rebuild a subject's hot set from the fact store
 *
 * `agent_task` is the row type that keeps the proactive surface open-ended, and
 * the reason §3's claim that this bot "notices things nobody asked it to look
 * for" is true rather than aspirational. This handler deliberately does very
 * little: claim, check expiry, dispatch. Reconstructing the minter's session and
 * re-checking their roles at run time is `runAgentTask`'s job, because that is
 * where the RLS cap belongs (§13.1) — a task minted by a coach who has since
 * been ended simply cannot run.
 */

import type { Job } from '@/lib/types'
import { now } from '@/lib/clock'
import { runAgentTask } from '@/lib/agent/loop'
import { curate, CURATE_THRESHOLD } from '@/lib/agent/memory'
import { need, note, numberOf, payloadOf, skip, withAcademy } from '../util'

export async function agentTask(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const instruction = need(p, 'instruction')
  const nowAt = await now(academyId)

  // §13.1 — "expires_at is required. A watch with no expiry is a leak; the
  // runtime rejects a task without one." `enqueue` refuses to mint one without
  // it; this is the second half of the same rule, at run time.
  const expiresAt = p.expires_at
  if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
    throw new Error('agent_task has no expires_at (§13.1)')
  }
  if (nowAt.getTime() > Date.parse(expiresAt)) {
    skip(`expired at ${expiresAt} — no longer worth doing`)
  }

  // The academy still has to exist; everything else the agent re-checks under
  // the minter's own session.
  await withAcademy(academyId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`select id from academy where id = ${academyId}`
    if (!row) skip('academy gone')
  })

  await runAgentTask(job)

  // Deciding to do nothing is the common and correct outcome (§13.1). A task
  // that fires and stays quiet is the system working, so this note says it ran,
  // not that it spoke.
  note(`watch ran: ${instruction.slice(0, 120)}`)
}

/**
 * `memory_curate` — §5. Facts are append-only and are the record; the hot set
 * on `academy.memory` / `person.memory` is rebuilt from the live ones on a
 * schedule, never per turn.
 */
export async function memoryCurate(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const subjectId = need(p, 'subject_id')
  const subjectKind = p.subject_kind === 'academy' ? 'academy' : 'person'
  const n = numberOf(p, 'n', 1)

  const live = await withAcademy(academyId, async (tx) => {
    const [row] = await tx<{ n: number }[]>`
      select count(*)::int as n from memory_fact
       where academy_id = ${academyId}
         and subject_kind = ${subjectKind} and subject_id = ${subjectId}
         and retired_at is null
    `
    return row?.n ?? 0
  })

  // The threshold is the whole trigger; below it there is nothing to curate.
  if (live < CURATE_THRESHOLD) skip(`only ${live} live facts, threshold is ${CURATE_THRESHOLD}`)

  await curate(subjectKind, subjectId)
  note(`curated ${subjectKind} memory (${live} facts, pass ${n})`)
}

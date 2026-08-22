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
import { need, note, numberOf, payloadOf, skip, withAcademy, withInfra } from '../util'

/** A blank line, spelled once: an escape in a long concatenation is where they go wrong. */
const NL2 = String.fromCharCode(10, 10)

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

  /**
   * Everything else waiting on this same person, carried into this one turn.
   *
   * Each watch is individually right and each opened its own turn, so each put its own
   * message on a phone. Between two looks at that phone they are a pile, and a pile is
   * answered in prose rather than tapped. Measured on `2026-08-22-14-36-sim-l3a1`, the
   * first run in which the harness could press a button at all: every window holding ONE
   * message with one card was tapped (5 of 6), and every window holding more than one was
   * typed (3 of 3, never tapped). The casualty was go-live — offered twice, in window,
   * buttons intact, `sent`, never pressed, with the owner's own reasoning on day 6 reading
   * *"three things stacked up waiting on me so just clearing them all in one go"*.
   *
   * @mechanism merged — the first watch to fire for a person carries every other
   *   watch outstanding for them into ONE turn and supersedes their jobs in the same
   *   transaction, which is `clientReminder`'s shape one surface along — *"the jobs stay one
   *   per (session, player) for idempotency and MERGE at send time"* — and for the same
   *   reason: the ideal's "you'll get one message, not two" was shipping as four.
   *
   *   A merge and never a cap. Every one of those messages was worth sending, and dropping
   *   the fourth to protect somebody from a pile the product made would silence a true thing
   *   — so all of them reach the model, in one turn, and it decides how they read as one
   *   message. That is also the enabling half: four turns each blind to the others cannot
   *   notice that the go-live offer and the timetable correction are the same conversation.
   *
   *   `running` as well as `pending`, because the runner claims the whole due batch before
   *   any handler starts and same-tick siblings are the common case.
   *   Closes F-EB.
   */
  const merged = await withInfra(async (tx) => {
    const siblings = await tx<{ id: string; payload: Record<string, unknown> }[]>`
      update job set status = 'superseded'
       where kind = 'agent_task'
         and status in ('pending', 'running')
         and id <> ${job.id}::uuid
         and payload->>'academy_id' = ${academyId}
         and payload->>'minted_by_contact_id' = ${String(p.minted_by_contact_id ?? '')}
         and coalesce(payload->>'minted_by_contact_id', '') <> ''
         and run_at <= app.now_for(${academyId}::uuid)
      returning id, payload`
    return siblings
  }).catch(() => [] as { id: string; payload: Record<string, unknown> }[])

  if (merged.length) {
    const all = [p, ...merged.map((m) => m.payload)]
    const instructions = all
      .map((x, i) => `${i + 1}. ${String(x.instruction ?? '').trim()}`)
      .filter((line) => line.length > 3)
    job = {
      ...job,
      payload: {
        ...p,
        instruction:
          `${instructions.length} things are waiting on this person at once. They are separate and they ` +
          'are all true, and they arrive as ONE message or they arrive as a pile nobody answers — so ' +
          'decide what leads, say the rest in as few words as each needs, and put ONE decision behind ' +
          'the buttons. If two of them are really the same conversation, say so.' +
          NL2 +
          instructions.join(NL2),
        // Each watch's own rows, run as its own statement — `proposeGoLive`'s numbers are
        // deliberately rows rather than a claim in the instruction, and a merge that
        // dropped them would turn them back into a claim.
        context: all.map((x) => x.context).filter((q) => typeof q === 'string' && q.trim()),
      },
    } as Job
    note(`merged ${merged.length} other watch(es) into this turn`)
  }

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

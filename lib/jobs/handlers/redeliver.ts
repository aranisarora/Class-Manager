/**
 * lib/jobs/handlers/redeliver.ts — the message the gates delayed comes back (F-CK).
 *
 * Three suppression reasons — `quiet_hours`, `recipient_frequency_cap`,
 * `tenant_send_cap` — mean "not now", never "not ever". `suppress()` has always
 * said so in its own comment ("the key is released so the same moment may be
 * attempted again once morning comes") and released the idempotency key, and for
 * the product's whole life nothing ever came back for the message: `runDueJobs`
 * finishes the job whatever the send outcome, handlers return void, and `send`
 * has no queue of its own. Verified on 2026-08-21-17-19-stress-69q0: four
 * composed messages written to `message` and lost, two of them the family
 * invites at go-live — so Meera and Kiran were introduced to the business by a
 * dunning notice from a number that had never said who it was.
 *
 * A blind re-run of the ORIGINAL job was tried on 22 Aug 2026 and reverted: the
 * handler's own selection predicate sees the suppressed `message` row (a contact
 * "this academy has never messaged" now has a row) and finds nobody. So the
 * retry is of the MESSAGE, not the job — `redeliverStored` (lib/messaging/send.ts)
 * replays the stored row through the same ten gates, and the gates stay the
 * deciders: a re-attempt suppressed for a reason that is a decision (opt-out,
 * pre-launch, repeat, silence_backoff) ends the ladder, because a decision made
 * once is not re-litigated by a timer.
 */

import type { Job } from '@/lib/types'
import { now } from '@/lib/clock'
import { redeliverStored } from '@/lib/messaging/send'
import { dedupe } from '../kinds'
import { enqueue } from '../enqueue'
import { deferPastQuietHours, need, payloadOf, skip, withAcademy } from '../util'

/** Knocks per suppressed message. Rung 3 that still cannot go is a message the
 *  world has moved past — the state it reported is stale by then. */
const REDELIVER_MAX = 3

/** The caps are rolling windows; four hours is long enough for a window to move
 *  and short enough that a morning invite still lands the same day. */
const RETRY_GAP_MS = 4 * 60 * 60 * 1000

const RELEASING = new Set(['quiet_hours', 'recipient_frequency_cap', 'tenant_send_cap'])

/**
 * @mechanism redeliver — a message suppressed for TIMING is re-attempted from its own
 *   stored row once the timing moves: quiet hours end, a rolling cap frees. One job per
 *   suppressed message, enqueued by `suppress()` itself at the moment it refuses, replayed
 *   by `redeliverStored` through the full gate stack so the gates keep deciding — a
 *   re-suppression for any non-timing reason ends the ladder, a timing one re-enqueues up
 *   to REDELIVER_MAX. Skips a message whose exact words have since reached the person
 *   another way, and a confirmation request (its asker owns the re-ask — a committing
 *   question re-raised by a timer would put a stale decision back on a screen). The retry
 *   is of the MESSAGE and not the job, because a re-run job's own selection predicate sees
 *   the suppressed row and concludes there is nothing to do — which is how the go-live
 *   invites were lost.
 *   Closes F-CK.
 */
export async function redeliver(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const messageId = need(p, 'message_id')
  const attempt = Math.max(1, Number(p.attempt ?? 1))
  const nowAt = await now(academyId)

  const outcome = await redeliverStored(academyId, messageId, attempt)
  if (outcome.status === 'skip') skip(outcome.reason)

  if (
    outcome.status === 'suppressed' &&
    RELEASING.has(String(outcome.reason)) &&
    attempt < REDELIVER_MAX
  ) {
    const academy = await withAcademy(academyId, async (tx) => {
      const [a] = await tx<{ timezone: string; settings: Record<string, unknown> | null }[]>`
        select timezone, settings from academy where id = ${academyId}`
      return a ?? null
    })
    const runAt = deferPastQuietHours(
      new Date(nowAt.getTime() + RETRY_GAP_MS),
      academy?.timezone ?? 'Asia/Kolkata',
      academy?.settings ?? null,
    )
    await enqueue(
      'redeliver',
      runAt,
      dedupe.redeliver(messageId, attempt + 1),
      { academy_id: academyId, message_id: messageId, attempt: attempt + 1 },
      academyId,
    )
  }
}

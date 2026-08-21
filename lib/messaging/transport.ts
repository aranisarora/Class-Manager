/**
 * lib/messaging/transport.ts — the abstraction the bot addresses instead of Meta.
 *
 * "One transport interface, two implementations. Cloud API is production, the emulator is
 * development. Building this first is what stops Meta API calls from scattering through the
 * codebase" (§17). **No Meta API call may exist anywhere outside `transport-cloud.ts`.**
 *
 * The transport's job is narrow on purpose: hand a fully-decided message to a wire and
 * report back what the wire said. Every decision — window, template, caps, suppression,
 * cost — has already been made in `send.ts` by the time a transport sees the request.
 */

import { env } from '@/lib/env'
import type { OutboundMessage, TemplateName } from './types'
import { emulatorTransport } from './transport-emulator'
import { cloudTransport } from './transport-cloud'

export type TransportRequest = {
  senderPhoneE164: string
  toPhoneE164: string
  toWaId: string | null
  message: OutboundMessage
  asTemplate: TemplateName | null
}

export type TransportResult =
  | { ok: true; waMessageId: string }
  | { ok: false; error: string; permanent: boolean }

export interface Transport {
  readonly name: 'emulator' | 'cloud'
  send(req: TransportRequest): Promise<TransportResult>
}

/** What the caller knows about the number this message is leaving from. */
export type TransportFor = {
  /**
   * `sender.is_sim` (0040) for the row this message is being sent from, as
   * `send.ts` read it off the same join that produced the credentials.
   *
   * Not defaulted to `true` anywhere: a caller that cannot say answers `false`
   * and gets the environment's choice, which is the behaviour every caller had
   * before this parameter existed.
   */
  senderIsSim?: boolean
}

/**
 * `TRANSPORT=emulator|cloud`. Read per call rather than captured at module load, so the
 * emulator can be pointed at the other implementation without a restart.
 *
 * There used to be a module-level `override` here with a `setTransport` seam to write
 * it. Nothing ever wrote it, so the branch on every send was testing a variable that
 * was permanently null — and the env read below is already per-call, which is the
 * property the seam was reaching for.
 *
 * **A simulated number overrules the environment, and that is the point.**
 *
 * `TRANSPORT` is one variable for a whole process, and it decides the road for
 * every message that process sends. Nothing about the MESSAGE participates. So a
 * drive started without the `TRANSPORT=emulator` prefix — against a `.env.local`
 * that says `cloud`, which is the state a deployment-shaped checkout is in —
 * takes the Cloud road with a fabricated parent's number in the `to` field. The
 * repo's own trap list carries "check `TRANSPORT` before driving" for exactly
 * this, which is a note asking a person to remember something, in a file that
 * also argues instructions do not close behavioural classes.
 *
 * A number knows whether it is real. `sender.is_sim` is a row in the database
 * rather than a variable in an environment, it was written by whoever invented
 * the number, and it travels with the message — so the decision moves from the
 * process to the thing being sent, and there is no prefix to forget.
 *
 * This is the third of 0040's barriers and it is deliberately redundant with the
 * other two: the lane means the beat never claims a simulated job, and
 * `sender.credentials` is `{}` on such a number so `transport-cloud.ts` would
 * refuse it by name. Each is sufficient. A test that can text a real person needs
 * all three to be wrong at once.
 *
 * @mechanism getTransport — the road a message takes is decided by the NUMBER it leaves
 *   from, not by the `TRANSPORT` process variable: a sender carrying `is_sim` (0040) gets
 *   the emulator transport even under `TRANSPORT=cloud`. One variable per process meant
 *   nothing about the message participated in the choice, so a drive started without the
 *   `TRANSPORT=emulator` prefix put an invented parent's number on the live Cloud road, and
 *   the only thing standing between that and a real handset was a line in a trap list
 *   asking a person to remember. A caller that says nothing gets the environment's choice,
 *   unchanged.
 *   Closes F-CG.
 */
export function getTransport(f: TransportFor = {}): Transport {
  if (f.senderIsSim === true) return emulatorTransport
  const want = String(env.TRANSPORT ?? 'emulator').toLowerCase()
  return want === 'cloud' ? cloudTransport : emulatorTransport
}

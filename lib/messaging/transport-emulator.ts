/**
 * lib/messaging/transport-emulator.ts — the development wire (§17).
 *
 * It writes nothing. **The `message` row is the emulator's store**: `send` has already
 * inserted it with its body, buttons, window state, template and cost before the transport
 * is called, so a second write here would be a second source of truth for what was sent.
 * The panes, the thread endpoint and the event log all read that one row.
 *
 * What it does is give back a wire id in the same shape production does — `wamid.…` — so
 * `markStatus` and the status ladder (§2.4) are exercised by exactly the code path Cloud API
 * will drive. Failure injection lives in `send.ts`, which is where the `sim_fault` rows are
 * readable; a transport that reached into the database would not be a transport.
 */

import { newId } from '@/lib/ids'
import type { Transport, TransportRequest, TransportResult } from './transport'

/** Production returns `wamid.HBg…`; the emulator returns `wamid.sim.<uuid>`, always distinct. */
export function simWaMessageId(): string {
  return `wamid.sim.${newId()}`
}

/**
 * One line for the dev console — what would have gone over the wire. Not the event log:
 * that reads the `message` row.
 */
export function describeTransportRequest(req: TransportRequest): string {
  const m = req.message
  const shape = req.asTemplate
    ? `template:${req.asTemplate}`
    : m.flow
      ? `interactive:flow(${m.flow.flowId}/${m.flow.screen})`
      : m.link
        ? 'interactive:cta_url'
        : m.list
        ? 'interactive:list'
        : m.buttons?.length
          ? `interactive:buttons(${m.buttons.length})`
          : m.media
            ? `media:${m.media.kind}`
            : 'text'
  const to = req.toWaId ?? req.toPhoneE164
  const first = (m.body ?? '').split('\n')[0]
  return `[emulator] ${req.senderPhoneE164} → ${to} · ${shape} · ${JSON.stringify(first.slice(0, 80))}`
}

export const emulatorTransport: Transport = {
  name: 'emulator',
  async send(req: TransportRequest): Promise<TransportResult> {
    if (process.env.NODE_ENV !== 'test') {
      console.log(describeTransportRequest(req))
    }
    return { ok: true, waMessageId: simWaMessageId() }
  },
}

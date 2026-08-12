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

let override: Transport | null = null

/**
 * `TRANSPORT=emulator|cloud`. Read per call rather than captured at module load, so the
 * emulator can be pointed at the other implementation without a restart.
 */
export function getTransport(): Transport {
  if (override) return override
  const want = String(env.TRANSPORT ?? 'emulator').toLowerCase()
  return want === 'cloud' ? cloudTransport : emulatorTransport
}

/** Test/emulator seam. Pass null to go back to whatever `TRANSPORT` says. */
export function setTransport(t: Transport | null): void {
  override = t
}

/**
 * lib/messaging/transport-cloud.ts — the production wire.
 *
 * **The only file in the codebase that may talk to Meta** (§17). Nothing here runs in this
 * build; it exists because a transport abstraction whose second implementation was never
 * written is not an abstraction, it is a wrapper — and the shapes below are what force the
 * emulator to stay honest about button counts, title lengths, list sizes and templates.
 *
 * Everything it needs is already decided: `send.ts` chose in-window free-form or an approved
 * template, minted the action ids that ride as button payloads, and validated the message
 * against the real limits. This file translates and posts.
 *
 * Credentials are per-sender (§16.3 — `academy.sender_id → sender`, never a constant, never
 * an env var). `send.ts` reads the `sender.credentials` jsonb under its own role and hands
 * it here, because a transport with a database connection is not a transport.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Transport, TransportRequest, TransportResult } from './transport'
import { TEMPLATES, templateWireParams } from './templates'
import { msgError } from './types'

export const GRAPH_VERSION = 'v21.0'
export const GRAPH_HOST = 'https://graph.facebook.com'
const REQUEST_TIMEOUT_MS = 15_000

export type CloudCredentials = {
  /** The number's id on the WABA. The path segment of every send. */
  phone_number_id: string
  /** System-user token with `whatsapp_business_messaging`. */
  access_token: string
  /** For `X-Hub-Signature-256` on the inbound webhook. */
  app_secret?: string
  waba_id?: string
}

const credentials = new Map<string, CloudCredentials>()

function normalizePhone(phone: string): string {
  return String(phone ?? '').replace(/[^\d]/g, '')
}

/** Parse and hold a `sender.credentials` jsonb. Called by the send path, keyed by number. */
export function cacheSenderCredentials(senderPhoneE164: string, raw: unknown): void {
  const c = raw as Partial<CloudCredentials> | null | undefined
  if (!c || typeof c !== 'object') return
  if (!c.phone_number_id || !c.access_token) return
  credentials.set(normalizePhone(senderPhoneE164), {
    phone_number_id: String(c.phone_number_id),
    access_token: String(c.access_token),
    app_secret: c.app_secret ? String(c.app_secret) : undefined,
    waba_id: c.waba_id ? String(c.waba_id) : undefined,
  })
}

export function getSenderCredentials(senderPhoneE164: string): CloudCredentials | null {
  return credentials.get(normalizePhone(senderPhoneE164)) ?? null
}

export function clearSenderCredentials(): void {
  credentials.clear()
}

/**
 * `X-Hub-Signature-256: sha256=<hmac>` over the **raw** body bytes. Re-serialising the parsed
 * JSON changes the bytes and the signature stops matching, which is why the webhook route
 * must keep the raw body and hand it here.
 */
export function verifyMetaSignature(
  raw: string | Buffer,
  sig: string | null | undefined,
  appSecret: string,
): boolean {
  if (!sig || !appSecret) return false
  const provided = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig
  if (!/^[0-9a-f]+$/i.test(provided)) return false

  const expected = createHmac('sha256', appSecret)
    .update(typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw)
    .digest('hex')

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided.toLowerCase(), 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** The `messages` endpoint for a given number. */
export function messagesUrl(phoneNumberId: string): string {
  return `${GRAPH_HOST}/${GRAPH_VERSION}/${phoneNumberId}/messages`
}

/**
 * Message JSON, in the exact shapes the Cloud API accepts.
 *
 * Interactive replies carry the **minted action id** as their payload (§2.2): the tap comes
 * back as `interactive.button_reply.id`, and `consumeAction` replays the stored payload with
 * no model call. Template quick-replies work the same way — the title was fixed at approval,
 * only the payload varies per send.
 */
export function buildPayload(req: TransportRequest): Record<string, unknown> {
  const m = req.message
  const to = req.toWaId ?? normalizePhone(req.toPhoneE164)
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to }

  if (req.asTemplate) {
    const def = TEMPLATES[req.asTemplate]
    if (!def) throw msgError('unknown_template', `no such template: ${req.asTemplate}`)
    const params = templateWireParams(req.asTemplate, m.templateParams ?? {})
    const components: Record<string, unknown>[] = [
      {
        type: 'body',
        parameters: params.map((text) => ({ type: 'text', text })),
      },
    ]
    const first = m.buttons?.[0]
    if (first) {
      components.push({
        type: 'button',
        sub_type: 'quick_reply',
        index: '0',
        parameters: [{ type: 'payload', payload: first.actionId }],
      })
    }
    return {
      ...base,
      type: 'template',
      template: { name: def.name, language: { code: def.language }, components },
    }
  }

  const header = m.header
    ? m.media && m.media.kind === 'image'
      ? { type: 'image', image: { link: m.media.url } }
      : { type: 'text', text: m.header }
    : m.media && m.media.kind === 'image' && (m.buttons?.length || m.list)
      ? { type: 'image', image: { link: m.media.url } }
      : null

  // §14.6 — a link is a button. `cta_url` is a body plus exactly one URL button, which is
  // why `link` is exclusive with reply buttons and lists in the message shape: the wire has
  // room for one action and this is it. Checked first for the same reason.
  if (m.link) {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'cta_url',
        ...(header && header.type === 'text' ? { header } : {}),
        body: { text: m.body },
        ...(m.footer ? { footer: { text: m.footer } } : {}),
        action: {
          name: 'cta_url',
          parameters: { display_text: m.link.title, url: m.link.url },
        },
      },
    }
  }

  // A Flow, like `cta_url`, occupies the message's one action slot — so it is
  // checked alongside it rather than after the button and list branches.
  //
  // `flow_action: 'navigate'` is what makes this a STATIC flow: every screen and
  // every value is known now, so there is no data-exchange endpoint, no RSA keypair
  // and no AES-GCM anywhere in this product. `flow_action_payload` is required
  // whenever the action is `navigate` — it names the screen to open, and its `data`
  // becomes `${data.key}` on that screen.
  if (m.flow) {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'flow',
        ...(header && header.type === 'text' ? { header } : {}),
        body: { text: m.body },
        ...(m.footer ? { footer: { text: m.footer } } : {}),
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: m.flow.flowToken,
            flow_id: m.flow.flowId,
            flow_cta: m.flow.cta,
            flow_action: 'navigate',
            flow_action_payload: {
              screen: m.flow.screen,
              ...(m.flow.data && Object.keys(m.flow.data).length ? { data: m.flow.data } : {}),
            },
            mode: m.flow.mode ?? 'published',
          },
        },
      },
    }
  }

  if (m.buttons?.length) {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'button',
        ...(header ? { header } : {}),
        body: { text: m.body },
        ...(m.footer ? { footer: { text: m.footer } } : {}),
        action: {
          buttons: m.buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.actionId, title: b.title },
          })),
        },
      },
    }
  }

  if (m.list) {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'list',
        ...(header && header.type === 'text' ? { header } : {}),
        body: { text: m.body },
        ...(m.footer ? { footer: { text: m.footer } } : {}),
        action: {
          button: m.list.buttonText,
          sections: m.list.sections.map((s) => ({
            title: s.title,
            rows: s.rows.map((r) => ({
              id: r.actionId,
              title: r.title,
              ...(r.description ? { description: r.description } : {}),
            })),
          })),
        },
      },
    }
  }

  if (m.media) {
    if (m.media.kind === 'image') {
      return { ...base, type: 'image', image: { link: m.media.url, ...(m.body ? { caption: m.body } : {}) } }
    }
    if (m.media.kind === 'document') {
      return {
        ...base,
        type: 'document',
        document: {
          link: m.media.url,
          ...(m.media.filename ? { filename: m.media.filename } : {}),
          ...(m.body ? { caption: m.body } : {}),
        },
      }
    }
    // Audio carries no caption on the Cloud API — the body would silently vanish.
    return { ...base, type: 'audio', audio: { link: m.media.url } }
  }

  return { ...base, type: 'text', text: { preview_url: false, body: m.body } }
}

type GraphError = {
  message?: string
  type?: string
  code?: number
  error_subcode?: number
  error_data?: { details?: string }
  fbtrace_id?: string
}

/**
 * Retry only what retrying can fix. A 470/131047 (outside the window), a 132000-series
 * template error or a 131026 (undeliverable number) will fail identically forever; retrying
 * them burns tier capacity on the shared number for nothing (§16.1).
 */
export function isPermanentGraphError(status: number, err: GraphError | null): boolean {
  if (status === 429 || status === 408 || status >= 500) return false
  const code = err?.code
  if (code === 4 || code === 80007 || code === 130429 || code === 131048) return false // throttles
  if (code === 1 || code === 2 || code === 500) return false // transient platform
  return true
}

function describeGraphError(status: number, err: GraphError | null, body: string): string {
  if (!err) return `HTTP ${status}: ${body.slice(0, 300)}`
  const bits = [
    err.message ?? `HTTP ${status}`,
    err.code !== undefined ? `code=${err.code}` : null,
    err.error_subcode !== undefined ? `subcode=${err.error_subcode}` : null,
    err.error_data?.details ?? null,
    err.fbtrace_id ? `fbtrace=${err.fbtrace_id}` : null,
  ].filter(Boolean)
  return bits.join(' · ')
}

export const cloudTransport: Transport = {
  name: 'cloud',

  async send(req: TransportRequest): Promise<TransportResult> {
    const creds = getSenderCredentials(req.senderPhoneE164)
    if (!creds) {
      return {
        ok: false,
        error: `no credentials cached for sender ${req.senderPhoneE164} — sender.credentials is the source (§16.3)`,
        permanent: true,
      }
    }

    let payload: Record<string, unknown>
    try {
      payload = buildPayload(req)
    } catch (e) {
      return { ok: false, error: `could not build payload: ${(e as Error).message}`, permanent: true }
    }

    let res: Response
    try {
      res = await fetch(messagesUrl(creds.phone_number_id), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (e) {
      // Network failure or timeout: nothing was necessarily rejected, so it is retryable.
      return { ok: false, error: `transport error: ${(e as Error).message}`, permanent: false }
    }

    const text = await res.text()
    let parsed: { messages?: { id: string }[]; error?: GraphError } | null = null
    try {
      parsed = text ? (JSON.parse(text) as { messages?: { id: string }[]; error?: GraphError }) : null
    } catch {
      parsed = null
    }

    if (!res.ok || parsed?.error) {
      const err = parsed?.error ?? null
      return {
        ok: false,
        error: describeGraphError(res.status, err, text),
        permanent: isPermanentGraphError(res.status, err),
      }
    }

    const waMessageId = parsed?.messages?.[0]?.id
    if (!waMessageId) {
      // Accepted with no id: we cannot track status, and claiming we can would break §2.4.
      return { ok: false, error: `accepted with no message id: ${text.slice(0, 200)}`, permanent: true }
    }

    return { ok: true, waMessageId }
  },
}

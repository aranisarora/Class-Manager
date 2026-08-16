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

import type { Transport, TransportRequest, TransportResult } from './transport'
import { TEMPLATES, TEMPLATE_NAMES, templateWireParams } from './templates'
import type { TemplateDef, TemplateName } from './templates'
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

/**
 * **Meta's webhook signature is verified in `app/api/webhook/route.ts`, not here.**
 *
 * There was a `verifyMetaSignature(raw, sig, appSecret)` in this file with no caller,
 * while the route computed the same HMAC inline — two implementations of the check that
 * decides whether an inbound request is really from Meta, one of them exercised and one
 * of them not. The route's is the live one and is correct (raw body, `sha256=` prefix
 * kept, length-checked `timingSafeEqual`, fail-closed on a missing secret), so this is
 * the copy that goes.
 *
 * It is deliberately not the other way round. The route reads its two secrets straight
 * from `process.env` rather than `lib/env.ts` — they belong to the production transport,
 * not to the emulator build — and importing this module would pull the whole Cloud
 * transport, its auth client and that env object into the one route that must still work
 * when none of them are configured.
 *
 * `clearSenderCredentials()` went at the same time: a cache-reset seam nothing called.
 */

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

// =============================================================================
// The management API.
//
// Everything above is the *messaging* half — the wire a decided message goes out
// on. Below is the half that has to have happened first: the number's app must be
// subscribed to the WABA or no inbound webhook ever fires, and the eight §16.2
// templates must exist and be approved or every out-of-window send fails with a
// 132001 against a name Meta has never seen.
//
// It lives in this file for the reason the send path does (§17: "No Meta API call
// may exist anywhere outside `transport-cloud.ts`"). Provisioning is a Meta API
// call, so a setup script that spoke Graph directly would be the second place
// that knows the host, the version and the error shape — which is the thing the
// rule exists to prevent. `scripts/wa-cloud.ts` is a CLI over these functions and
// contains no URL of its own.
//
// These take credentials as an argument rather than reading the module cache: the
// send path is per-sender and looks its own up, but provisioning runs before any
// sender row necessarily exists.
// =============================================================================

export type GraphCall<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

async function graph<T>(
  path: string,
  accessToken: string,
  init?: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; query?: Record<string, string> },
): Promise<GraphCall<T>> {
  const url = new URL(`${GRAPH_HOST}/${GRAPH_VERSION}/${path}`)
  for (const [k, v] of Object.entries(init?.query ?? {})) url.searchParams.set(k, v)

  let res: Response
  try {
    res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (e) {
    return { ok: false, error: `transport error: ${(e as Error).message}`, status: 0 }
  }

  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  const err = (parsed as { error?: GraphError } | null)?.error ?? null
  if (!res.ok || err) {
    return { ok: false, error: describeGraphError(res.status, err, text), status: res.status }
  }
  return { ok: true, data: parsed as T }
}

/**
 * The body Meta approves, in the shape its create endpoint wants.
 *
 * `templates.ts` writes bodies with NAMED placeholders (`{academy}`) because a
 * name is what makes the frozen text readable to whoever is judging whether it
 * conjugates correctly. The wire is positional — `{{1}}`, `{{2}}` — and
 * `templateWireParams` already orders the send-time arguments by `def.params`.
 * This converts the body by the same ordering, so the approved text and the
 * arguments it receives cannot drift: both derive from `params`, in one place.
 *
 * A placeholder naming something not in `params` throws rather than shipping
 * `{whoops}` into an approval submission — the frozen text is the one thing that
 * cannot be fixed after the fact without a re-approval.
 */
export function templateSubmission(def: TemplateDef): Record<string, unknown> {
  const index = new Map(def.params.map((p, i) => [p, i + 1]))
  const body = def.body.replace(/\{(\w+)\}/g, (_m, key: string) => {
    const at = index.get(key)
    if (!at) {
      throw msgError(
        'template_param_missing',
        `template ${def.name} body references {${key}}, which is not in params (${def.params.join(', ')})`,
      )
    }
    return `{{${at}}}`
  })

  const example = def.params.map((p) => {
    const v = def.exampleParams[p]
    if (!v) {
      throw msgError(
        'template_param_missing',
        `template ${def.name} has no exampleParams.${p} — Meta will not approve a template without one`,
      )
    }
    return v
  })

  return {
    name: def.name,
    language: def.language,
    category: def.category.toUpperCase(),
    components: [
      { type: 'BODY', text: body, example: { body_text: [example] } },
      { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: def.quickReply }] },
    ],
  }
}

export type RemoteTemplate = {
  id: string
  name: string
  status: string
  category?: string
  language?: string
}

export async function listTemplates(
  wabaId: string,
  accessToken: string,
): Promise<GraphCall<RemoteTemplate[]>> {
  const r = await graph<{ data: RemoteTemplate[] }>(`${wabaId}/message_templates`, accessToken, {
    query: { limit: '100', fields: 'id,name,status,category,language' },
  })
  return r.ok ? { ok: true, data: r.data.data ?? [] } : r
}

export type TemplateProvisionResult = {
  template: TemplateName
  outcome: 'created' | 'exists' | 'failed'
  status?: string
  id?: string
  error?: string
}

/**
 * Create the eight, skipping any that already exist under the same name AND
 * language. Meta treats `(name, language)` as the identity of a template, and
 * re-posting a name that exists is a 100/2388023 rather than an update — so the
 * existing list is read first and the call is skipped, which makes this
 * re-runnable after a partial failure.
 */
export async function provisionTemplates(
  wabaId: string,
  accessToken: string,
  only?: TemplateName[],
): Promise<{ ok: boolean; results: TemplateProvisionResult[]; error?: string }> {
  const existing = await listTemplates(wabaId, accessToken)
  if (!existing.ok) return { ok: false, results: [], error: existing.error }

  const have = new Set(existing.data.map((t) => `${t.name}::${t.language}`))
  const byName = new Map(existing.data.map((t) => [`${t.name}::${t.language}`, t]))
  const results: TemplateProvisionResult[] = []

  for (const name of only ?? TEMPLATE_NAMES) {
    const def = TEMPLATES[name]
    const key = `${def.name}::${def.language}`
    if (have.has(key)) {
      const t = byName.get(key)
      results.push({ template: name, outcome: 'exists', status: t?.status, id: t?.id })
      continue
    }
    let body: Record<string, unknown>
    try {
      body = templateSubmission(def)
    } catch (e) {
      results.push({ template: name, outcome: 'failed', error: (e as Error).message })
      continue
    }
    const r = await graph<{ id: string; status: string }>(
      `${wabaId}/message_templates`,
      accessToken,
      { method: 'POST', body },
    )
    results.push(
      r.ok
        ? { template: name, outcome: 'created', id: r.data.id, status: r.data.status }
        : { template: name, outcome: 'failed', error: r.error },
    )
  }

  return { ok: results.every((r) => r.outcome !== 'failed'), results }
}

/** The number as Meta sees it — display number, quality rating, verified name. */
export async function describePhoneNumber(
  phoneNumberId: string,
  accessToken: string,
): Promise<GraphCall<{
  id: string
  display_phone_number?: string
  verified_name?: string
  quality_rating?: string
  platform_type?: string
  throughput?: { level?: string }
}>> {
  return graph(phoneNumberId, accessToken, {
    query: {
      fields: 'id,display_phone_number,verified_name,quality_rating,platform_type,throughput',
    },
  })
}

/**
 * Which apps receive this WABA's webhooks. An empty list is the single most
 * common reason a correctly-configured callback URL never fires: the app is
 * *configured* for webhooks but was never *subscribed* to the account.
 */
export async function listSubscribedApps(
  wabaId: string,
  accessToken: string,
): Promise<GraphCall<{ whatsapp_business_api_data?: { id?: string; name?: string } }[]>> {
  const r = await graph<{ data: { whatsapp_business_api_data?: { id?: string; name?: string } }[] }>(
    `${wabaId}/subscribed_apps`,
    accessToken,
  )
  return r.ok ? { ok: true, data: r.data.data ?? [] } : r
}

/** Subscribe the token's own app to this WABA. Idempotent. */
export async function subscribeApp(
  wabaId: string,
  accessToken: string,
): Promise<GraphCall<{ success?: boolean }>> {
  return graph(`${wabaId}/subscribed_apps`, accessToken, { method: 'POST' })
}

/**
 * What the token is and when it dies. The token pasted out of the App Dashboard
 * is a ~24-hour user token, and the failure it produces a day later is an opaque
 * 190 on every send — so the expiry is worth reading out loud during setup rather
 * than discovering from a silent outage.
 */
export async function debugToken(accessToken: string): Promise<GraphCall<{
  data?: {
    app_id?: string
    type?: string
    application?: string
    expires_at?: number
    data_access_expires_at?: number
    is_valid?: boolean
    scopes?: string[]
  }
}>> {
  return graph('debug_token', accessToken, { query: { input_token: accessToken } })
}

/**
 * Point the app's `whatsapp_business_account` webhook at a URL.
 *
 * This is the one Graph call that does NOT take the ordinary access token. Meta
 * answers `(#190) Application Secret required for this endpoint` to a user token
 * here, however wide its scopes — the callback URL is app configuration, so it
 * wants an **app access token**, which is literally `{app_id}|{app_secret}`.
 * That is why the app secret is not optional for this product and not merely the
 * thing that verifies inbound signatures: without it there is no way to register
 * a callback URL at all except by hand in the dashboard.
 *
 * Meta calls the URL with the `hub.challenge` handshake before accepting it, so
 * a failure here usually means the tunnel is down or the verify token disagrees
 * with `WHATSAPP_VERIFY_TOKEN` — not that the call was malformed.
 */
export async function configureWebhook(
  appId: string,
  appSecret: string,
  callbackUrl: string,
  verifyToken: string,
): Promise<GraphCall<{ success?: boolean }>> {
  return graph(`${appId}/subscriptions`, `${appId}|${appSecret}`, {
    method: 'POST',
    body: {
      object: 'whatsapp_business_account',
      callback_url: callbackUrl,
      verify_token: verifyToken,
      // `messages` carries both halves of the transport: inbound messages and
      // delivery statuses arrive on this one field (see `processChangeValue`).
      fields: 'messages',
    },
  })
}

/** What the app currently points at, if anything. */
export async function readWebhookConfig(
  appId: string,
  appSecret: string,
): Promise<GraphCall<{ object?: string; callback_url?: string; active?: boolean; fields?: unknown[] }[]>> {
  const r = await graph<{ data: { object?: string; callback_url?: string; active?: boolean; fields?: unknown[] }[] }>(
    `${appId}/subscriptions`,
    `${appId}|${appSecret}`,
  )
  return r.ok ? { ok: true, data: r.data.data ?? [] } : r
}

/**
 * Send `hello_world` — Meta's own pre-approved template — to one number.
 *
 * This is the setup step's end-to-end proof and deliberately does NOT go through
 * `send.ts`: it answers "do these credentials reach this handset at all", before
 * there is a contact row, a window, or an academy to attribute the message to.
 * Every *product* message still goes through the send path.
 */
export async function sendHelloWorld(
  phoneNumberId: string,
  accessToken: string,
  toPhoneE164: string,
): Promise<GraphCall<{ messages?: { id: string }[] }>> {
  return graph(`${phoneNumberId}/messages`, accessToken, {
    method: 'POST',
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: normalizePhone(toPhoneE164),
      type: 'template',
      template: { name: 'hello_world', language: { code: 'en_US' } },
    },
  })
}

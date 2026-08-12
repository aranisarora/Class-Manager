import { createHmac, timingSafeEqual } from 'node:crypto'

import { queueWebhookEvent, drainWebhookEvents } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The real Meta webhook (§1). Not exercised in this build — `TRANSPORT=emulator`
 * — but it is the other half of the transport abstraction and has to be right:
 *
 *   GET  — the verify-token handshake.
 *   POST — `X-Hub-Signature-256` verified against the app secret over the RAW
 *          body, 200 returned immediately, and all processing done on the job
 *          queue rather than inline, because Meta retries on timeout.
 *
 * Both inbound messages and delivery statuses arrive on the one `messages`
 * field, so both are handled here.
 *
 * The two secrets are deliberately read from `process.env` rather than
 * `lib/env.ts`: CONTRACTS §0 fixes that object's keys, and these belong to the
 * production transport, not to the emulator build. Missing secret = fail closed.
 */

const verifyToken = (): string | undefined =>
  process.env.WHATSAPP_VERIFY_TOKEN ?? process.env.META_VERIFY_TOKEN
const appSecret = (): string | undefined =>
  process.env.WHATSAPP_APP_SECRET ?? process.env.META_APP_SECRET

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export async function GET(req: Request): Promise<Response> {
  const sp = new URL(req.url).searchParams
  const mode = sp.get('hub.mode')
  const token = sp.get('hub.verify_token')
  const challenge = sp.get('hub.challenge')
  const expected = verifyToken()

  if (mode === 'subscribe' && token && expected && safeEqual(token, expected)) {
    return new Response(challenge ?? '', {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }
  return new Response('forbidden', { status: 403 })
}

export async function POST(req: Request): Promise<Response> {
  const secret = appSecret()
  const signature = req.headers.get('x-hub-signature-256')

  // The signature is computed over the exact bytes Meta sent, so the body is
  // read as text and never re-serialised before verification.
  const raw = await req.text()

  if (!secret) {
    // Fail closed: an unverifiable webhook is not a webhook.
    return new Response('app secret not configured', { status: 401 })
  }
  if (!signature) {
    return new Response('missing signature', { status: 401 })
  }

  const expected = 'sha256=' + createHmac('sha256', secret).update(raw, 'utf8').digest('hex')
  if (!safeEqual(signature, expected)) {
    return new Response('bad signature', { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    // Malformed but signed: acknowledge so Meta stops retrying a body that can
    // never be parsed.
    return new Response('ok', { status: 200 })
  }

  try {
    // One durable job row per Meta event, deduped by its event id — retries are
    // absorbed by the dedupe key, not by luck.
    await queueWebhookEvent(payload)
  } catch {
    // Enqueue failed: 500 asks Meta to retry, which is the correct outcome —
    // the alternative is acknowledging an event nobody stored.
    return new Response('queue unavailable', { status: 500 })
  }

  // Drain off the response path. The 200 has already been decided; the queue is
  // what guarantees the work survives if this process dies mid-drain.
  void drainWebhookEvents().catch(() => undefined)

  return new Response('ok', { status: 200 })
}

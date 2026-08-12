/**
 * lib/ids.ts — ids and idempotency keys (CONTRACTS §11).
 *
 * `idem()` is the other half of §13's "enqueueing the same key twice is a
 * no-op" and §16.3's "idempotency_key is REQUIRED on every outbound": the same
 * inputs must always produce the same key, on any process, in any order.
 */

import { createHash, randomUUID } from 'node:crypto'

/** uuid v4. */
export function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return randomUUID()
}

const MAX_KEY_LENGTH = 180

/**
 * A stable idempotency key from its parts. Order matters, empty parts are
 * dropped, and over-long keys collapse to a prefix plus a hash so the key stays
 * both unique and recognisable in the event log.
 */
export function idem(...parts: string[]): string {
  const cleaned = parts
    .map((p) => String(p ?? '').trim().replace(/\s+/g, '-'))
    .filter((p) => p.length > 0)

  if (cleaned.length === 0) return `idem:${newId()}`

  const key = cleaned.join(':')
  if (key.length <= MAX_KEY_LENGTH) return key

  const digest = createHash('sha256').update(key).digest('hex').slice(0, 32)
  return `${key.slice(0, MAX_KEY_LENGTH - 33)}:${digest}`
}

/** Deterministic short hash. Dedupe keys, cache keys, seeded simulation. */
export function shortHash(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 12)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

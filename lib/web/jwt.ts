/**
 * lib/web/jwt.ts — the magic link IS the session (§15).
 *
 * A short-TTL HS256 JWT carrying `academy_id`, `person_id` and `contact_id`.
 * `/w/[token]` verifies it and derives a `SessionCtx` of role `user` straight
 * from the claims, which is what Postgres policies then read. There is no
 * login, no cookie, no navigation and no app shell — the chat is the
 * navigation.
 *
 * Two details that are easy to get wrong and matter:
 *
 *  - Expiry is measured against `lib/clock.ts`, never wall time. Jumping the
 *    emulator's clock forward must expire a link, or §17's clock is a lie.
 *  - The `link_expired` sim_fault (§17 failure injection) makes a live link
 *    read as expired, including mid-form — the submit route verifies again, so
 *    the fault can land between opening the register and submitting it.
 */

import { SignJWT, jwtVerify } from 'jose'
import { env } from '@/lib/env'
import { now } from '@/lib/clock'
import { withSession } from '@/lib/db'
import { newId } from '@/lib/ids'

export type LinkPurpose = 'setup' | 'register' | 'calendar' | 'view' | 'form'

export type LinkClaims = {
  academy_id: string
  person_id: string
  contact_id: string
  purpose: LinkPurpose
  ref?: string
}

const ISSUER = 'class-manager'
const AUDIENCE = 'w'
const PURPOSES: readonly LinkPurpose[] = ['setup', 'register', 'calendar', 'view', 'form']

/**
 * Default TTLs, in minutes. Short, because the link is the session.
 *  - setup runs once per tenant ever, and an admin may come back to it tomorrow
 *  - the register is opened just after a class ends (`CO-REGISTER` expires 2h)
 *  - views and forms are answers to a question just asked
 */
export const TTL: Record<LinkPurpose, number> = {
  setup: 24 * 60,
  register: 180,
  // The schedule is a thing somebody comes back to during a day, not an answer to a
  // question just asked — so it outlives a view without outliving the day.
  calendar: 12 * 60,
  view: 60,
  form: 60,
}

let cachedKey: Uint8Array | null = null
function key(): Uint8Array {
  if (!cachedKey) {
    const secret = env.APP_JWT_SECRET
    if (!secret || secret.length < 16) {
      throw new Error('APP_JWT_SECRET is missing or too short to sign a link with')
    }
    cachedKey = new TextEncoder().encode(secret)
  }
  return cachedKey
}

function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
}

export async function signLink(c: LinkClaims, ttlMinutes: number): Promise<string> {
  const issuedAt = await now()
  const iat = Math.floor(issuedAt.getTime() / 1000)
  const minutes = Number.isFinite(ttlMinutes) && ttlMinutes > 0 ? ttlMinutes : TTL[c.purpose]
  const exp = iat + Math.max(60, Math.round(minutes * 60))

  return new SignJWT({
    academy_id: c.academy_id,
    person_id: c.person_id,
    contact_id: c.contact_id,
    purpose: c.purpose,
    ...(c.ref ? { ref: c.ref } : {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(iat)
    .setNotBefore(iat - 120)
    .setExpirationTime(exp)
    .setJti(newId())
    .sign(key())
}

/**
 * null for every failure — bad signature, wrong issuer, malformed claims, past
 * expiry, or the injected `link_expired` fault. The page renders one plain
 * "this link has expired" screen for all of them; distinguishing a forged token
 * from a stale one in the UI helps nobody but an attacker.
 */
export async function verifyLink(token: string): Promise<LinkClaims | null> {
  if (typeof token !== 'string' || token.length < 20 || token.length > 8192) return null

  let claims: LinkClaims
  try {
    const at = await now()
    const { payload } = await jwtVerify(token, key(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
      currentDate: at, // §13/§17: domain time, not wall time
      clockTolerance: 0,
    })

    const purpose = payload.purpose
    if (
      !isUuid(payload.academy_id) ||
      !isUuid(payload.person_id) ||
      !isUuid(payload.contact_id) ||
      typeof purpose !== 'string' ||
      !PURPOSES.includes(purpose as LinkPurpose)
    ) {
      return null
    }
    const ref = payload.ref
    if (ref !== undefined && typeof ref !== 'string') return null

    claims = {
      academy_id: payload.academy_id,
      person_id: payload.person_id,
      contact_id: payload.contact_id,
      purpose: purpose as LinkPurpose,
      ...(typeof ref === 'string' ? { ref } : {}),
    }
  } catch {
    return null
  }

  if (await linkExpiredFault(claims.academy_id)) return null
  return claims
}

export function linkUrl(token: string): string {
  const base = (env.APP_BASE_URL || '').replace(/\/+$/, '')
  return `${base}/w/${token}`
}

/**
 * §17: "web links expire mid-form" is one of the four injected failures. The
 * fault row is infrastructure (no cm_user policy), so it is read as the
 * runtime's own role. Any failure to read it means no fault — failure injection
 * must never be able to break the normal path.
 */
async function linkExpiredFault(academyId: string): Promise<boolean> {
  try {
    return await withSession({ role: 'service', academyId }, async (tx) => {
      const rows = await tx<{ active: boolean; rate: string | number }[]>`
        select active, rate from sim_fault where kind = 'link_expired' limit 1`
      const row = rows[0]
      if (!row || !row.active) return false
      const rate = Number(row.rate)
      if (!Number.isFinite(rate) || rate >= 1) return true
      if (rate <= 0) return false
      return Math.random() < rate
    })
  } catch {
    return false
  }
}

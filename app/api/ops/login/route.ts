import { timingSafeEqual } from 'node:crypto'

import { z } from 'zod'

import {
  isSecureRequest,
  opsCookie,
  opsGateConfigured,
  opsSecret,
  signOpsToken,
} from '@/lib/ops-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The door. Trade `OPS_SECRET` for the cookie the gate checks.
 *
 * This route is deliberately outside the gate's matcher — it has to be, or there
 * would be no way through it — so it is the one unauthenticated write surface in
 * the deployment and is written accordingly: a constant-time comparison, a body
 * schema that bounds what an attacker can make the process allocate, a small fixed
 * penalty on every refusal, and a lockout that stops the penalty from being the
 * only thing standing between a guesser and the console.
 *
 * `runtime = 'nodejs'` is what buys `node:crypto` here. The gate itself runs on
 * the edge, which is why `lib/ops-auth.ts` carries a Web Crypto equivalent for the
 * bearer hatch; this end keeps `timingSafeEqual` because that is the house pattern
 * `app/api/webhook/route.ts` set and there is no reason to diverge from it in a
 * node route.
 */

const Body = z.object({ secret: z.string().min(1).max(1024) })

/**
 * A fixed penalty on every refusal — but only a penalty, and small.
 *
 * It used to be 700ms with a comment claiming that made online guessing pointless.
 * That was wrong, and wrong in the way security comments usually are: it described
 * an intent rather than a mechanism. The delay is per REQUEST, not per client, so
 * anybody who can open twenty connections pays it twenty times in parallel and
 * loses nothing; measured against the dev server, twenty-five parallel wrong
 * guesses all came back inside 1.6 seconds. Worse, on a serverless platform each
 * held-open refusal is billed function time, so a long delay turns the login form
 * into a cheap way to spend the operator's money.
 *
 * So the delay is now 100ms and does the only job it can honestly do — it blunts a
 * naive sequential script and it is short enough that a mistyped password does not
 * feel broken. The actual rate limiting is `LOCKOUT` below, and the actual defence
 * against a distributed run is `OPS_SECRET_MIN_LENGTH` in `lib/ops-auth.ts`: a
 * gate whose secret is 24-plus random characters cannot be guessed online at any
 * rate a network will carry.
 */
const REFUSAL_DELAY_MS = 100

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Per-client lockout, held in this instance's memory.
 *
 * WHAT IT IS AND IS NOT. It is a counter keyed on the client address: eight
 * refusals inside ten minutes and that address gets 429s until the window ends,
 * with no comparison performed and no delay served, so a locked-out attacker also
 * stops costing anything. It is NOT a distributed rate limiter — Vercel runs many
 * instances and each keeps its own map, so the real ceiling is eight per instance
 * per window rather than eight overall, and a client that rotates addresses is not
 * bounded at all.
 *
 * That is deliberately not fixed here. The two honest ways to fix it are a counter
 * row in Postgres, which puts a database round trip and a migration in front of
 * every login attempt for a route one person uses, or a WAF rate-limit rule at the
 * edge, which is where this belongs and which no code in this repo can install.
 * The deploy notes should carry a rate-limit rule on `/api/ops/login` as a
 * required step; this map is what holds the line until then, and it does hold the
 * measured attack — the twenty-five-parallel-guesses run above dies after eight.
 *
 * A CORRECT SECRET IS NEVER LOCKED OUT. The comparison runs before the lockout is
 * consulted, so the counter can only ever refuse a wrong guess. That matters: a
 * lockout that also refuses the operator turns "somebody was probing my login" into
 * "I cannot get into my own console for ten minutes", and the security it buys is
 * nil — anybody who holds the secret can use the bearer hatch regardless.
 *
 * The address comes from `x-forwarded-for`. On Vercel the platform edge sets that
 * header and a client cannot forge it; self-hosted behind nothing it is
 * client-supplied and the key degrades to whatever the caller says it is, which is
 * the other reason the durable answer is a rule at the edge rather than a map in
 * here.
 */
const LOCKOUT = { windowMs: 10 * 60_000, maxFailures: 8, maxTracked: 2048 }

type Bucket = { failures: number; resetAt: number }
const buckets = new Map<string, Bucket>()

function clientKey(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for')
  const first = forwarded ? forwarded.split(',')[0].trim() : ''
  return first || req.headers.get('x-real-ip')?.trim() || 'unknown'
}

/**
 * Bound the map so the limiter cannot itself become the memory exhaustion it is
 * meant to prevent. Expired buckets go first; if a flood of distinct addresses
 * still leaves it over the cap, the ones closest to expiry are dropped, because
 * those are the buckets with the least protection left in them.
 */
function prune(nowMs: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= nowMs) buckets.delete(key)
  }
  if (buckets.size <= LOCKOUT.maxTracked) return
  const oldest = [...buckets.entries()]
    .sort((a, b) => a[1].resetAt - b[1].resetAt)
    .slice(0, buckets.size - LOCKOUT.maxTracked)
  for (const [key] of oldest) buckets.delete(key)
}

/**
 * Milliseconds left on this client's lockout, or 0 if it is free to be refused
 * the ordinary way. Consulted before the failure is recorded, so `maxFailures`
 * reads as "this many refusals, then the door stops answering".
 */
function lockedFor(key: string, nowMs: number): number {
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= nowMs) return 0
  if (bucket.failures < LOCKOUT.maxFailures) return 0
  return bucket.resetAt - nowMs
}

/**
 * The window starts at the first failure and does not slide, so a client cannot
 * hold itself just under the limit forever by pacing its guesses: eight is eight
 * per ten minutes, then the slate is wiped and it starts again. It also means a
 * client cannot extend its own lockout by continuing to hammer — further failures
 * raise the count but never move `resetAt`.
 */
function recordFailure(key: string, nowMs: number): void {
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= nowMs) {
    buckets.set(key, { failures: 1, resetAt: nowMs + LOCKOUT.windowMs })
    return
  }
  bucket.failures += 1
}

/** The house pattern, lifted from `app/api/webhook/route.ts`. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  // `timingSafeEqual` throws on a length mismatch, so the lengths are compared
  // first and in the clear. That leaks the length of the secret and nothing else,
  // which is the same trade the webhook makes.
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/**
 * One refusal for every way of being wrong — a malformed body, a bad secret, a
 * signing key that could not be built. Telling them apart would tell an attacker
 * which half of the guess to change. A malformed body counts against the lockout
 * for the same reason: from here it is an unauthenticated attempt on the door
 * either way, and not counting it would leave a free way to keep guessing.
 */
async function refuse(): Promise<Response> {
  await sleep(REFUSAL_DELAY_MS)
  return Response.json(
    { ok: false, error: 'unauthorized' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  )
}

/** Locked out. No delay served, and `Retry-After` so a client need not guess. */
function tooMany(remainingMs: number): Response {
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000))
  return Response.json(
    { ok: false, error: 'too_many_attempts', retryAfterSeconds: seconds },
    { status: 429, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(seconds) } },
  )
}

/**
 * Unconfigured is not the same as wrong, and it is the one distinction worth
 * making out loud. It cannot be exploited — the gate fails closed without its
 * secrets, so nothing is reachable either way — and without it an operator whose
 * Vercel project is missing one environment variable would spend an evening
 * convinced they were mistyping their own password.
 *
 * A short `OPS_SECRET` lands here too rather than being quietly accepted. A gate
 * is only as strong as the string in front of it, and one that guards real parent
 * conversations behind a four-character password should fail at the door where
 * somebody notices, not in the background where nobody does.
 */
function unconfigured(): Response {
  return Response.json(
    { ok: false, error: 'ops_gate_unconfigured' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(req: Request): Promise<Response> {
  const expected = opsSecret()
  if (!opsGateConfigured() || !expected) return unconfigured()

  const nowMs = Date.now()
  const key = clientKey(req)
  prune(nowMs)

  const raw = await req.json().catch(() => null)
  const parsed = Body.safeParse(raw)

  // The comparison comes first and unconditionally, before the lockout is
  // consulted, so that holding the real secret is never something a counter can
  // refuse — see the note on LOCKOUT.
  if (!parsed.success || !safeEqual(parsed.data.secret, expected)) {
    const remaining = lockedFor(key, nowMs)
    recordFailure(key, nowMs)
    // Once locked, answer immediately: the point of the lockout is to make further
    // attempts cost the attacker something and the operator nothing, and serving
    // the delay here would invert that.
    return remaining > 0 ? tooMany(remaining) : refuse()
  }

  // A correct secret wipes the counter, so an operator who fumbled the password
  // twice is not still carrying those failures an hour later.
  buckets.delete(key)

  // Null here means the signing key could not be derived. Same 503 for the same
  // reason: the gate is half-built, and no amount of retyping fixes it.
  const token = await signOpsToken()
  if (!token) return unconfigured()

  return Response.json(
    { ok: true },
    {
      headers: {
        'Set-Cookie': opsCookie(token, isSecureRequest(req)),
        'Cache-Control': 'no-store',
      },
    },
  )
}

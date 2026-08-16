import { SignJWT, jwtVerify } from 'jose'

/**
 * The lock on the ops console's door.
 *
 * §17 says the emulator is the dev surface, the test harness and exactly what
 * happens in production. Deployed, that last clause stops being a boast and
 * becomes a liability: the same instrument that drives fixtures reads — and in
 * sandbox mode writes — a real academy's parent conversations. So the whole
 * surface sits behind one shared secret, and this module is the only thing that
 * knows how a holder of that secret is turned into a request the gate accepts.
 *
 * TWO SECRETS, READ FROM `process.env`, NEVER FROM `lib/env.ts`. This follows
 * `app/api/webhook/route.ts` exactly and for the same reason: CONTRACTS §0 fixes
 * that object's key set, and these belong to the deployment rather than to the
 * emulator build. `lib/env.ts` would also drag `node:fs` into the edge bundle,
 * which is the second reason and on its own would be enough.
 *
 * EDGE-SAFE ON PURPOSE. `middleware.ts` imports this file and Next runs
 * middleware on the edge runtime, where `node:crypto` does not exist. Everything
 * here is `jose` plus Web Crypto, both of which run unchanged on edge and on
 * node — including `safeEqualSecret`, the constant-time comparison the bearer
 * hatch needs at the edge. `app/api/ops/login/route.ts` keeps its own
 * `node:crypto` comparison because it is a node route and that is the house
 * pattern the webhook set; the two agree on behaviour, not on implementation.
 *
 * TWO WAYS IN, AND WHY THERE HAS TO BE MORE THAN ONE. A browser trades the secret
 * for a cookie at `/api/ops/login`, because `EventSource` cannot send headers and
 * the console's live stream would otherwise be the one call that never
 * authenticates. A headless caller — `scripts/drive.ts`, `scripts/smoke.mjs`,
 * anything driving the product over HTTP — cannot hold a cookie jar for free, so
 * `Authorization: Bearer <OPS_SECRET>` is accepted as well. Both are the same
 * secret and neither is weaker than the other: a browser cannot be made to attach
 * that header cross-origin, and anyone who can set it already knows the secret.
 *
 * FAIL CLOSED, AND FAIL CLOSED ON A WEAK SECRET TOO. Either secret missing and
 * there is no signing key, so nothing can be issued and nothing verifies. An
 * `OPS_SECRET` shorter than `OPS_SECRET_MIN_LENGTH` is treated the same way: a
 * gate is only as good as the string in front of it, and one that quietly guards
 * a real business's parent conversations behind a four-character password is
 * worse than one that refuses to open, because the second kind gets fixed.
 */

/** The cookie the gate reads. Same-origin, so `EventSource` carries it too — see `middleware.ts`. */
export const OPS_COOKIE = 'cm_ops'

/** Thirty days. Long, because the alternative is an operator who stops opening the console. */
export const OPS_MAX_AGE_SECONDS = 60 * 60 * 24 * 30

/**
 * The shortest `OPS_SECRET` this gate will operate behind.
 *
 * Twenty-four characters of the base64-ish output `openssl rand -base64 24` gives
 * is ~144 bits, which is far past anything an online guessing run reaches no
 * matter how badly the rate limiting goes. The number is a floor on entropy
 * expressed as the only thing this code can actually measure — nothing here can
 * tell `correct horse battery staple` from 24 random bytes, so length is the
 * proxy, and the deploy notes are where the "generate it, do not invent it"
 * instruction belongs.
 */
export const OPS_SECRET_MIN_LENGTH = 24

const ALG = 'HS256'

/**
 * Read on every call rather than captured once. Both runtimes read these at
 * runtime — the edge bundle Next emits for middleware contains literal
 * `process.env.OPS_SECRET` member expressions, not the value — so a platform that
 * swaps an environment variable under a warm instance is a case that happens, and
 * every consumer here is written to notice.
 */
export const opsSecret = (): string | undefined => process.env.OPS_SECRET
export const jwtSecret = (): string | undefined => process.env.APP_JWT_SECRET

/**
 * Both halves present and the shared secret long enough to be worth having.
 * Neither the login route nor the gate does anything at all without this: it is
 * the single predicate every other function in this file consults first, so
 * "unconfigured" cannot mean one thing at the door and another at the gate.
 */
export function opsGateConfigured(): boolean {
  const ops = opsSecret()
  return Boolean(ops && ops.length >= OPS_SECRET_MIN_LENGTH && jwtSecret())
}

/**
 * The signing key is SHA-256 over BOTH secrets, not `APP_JWT_SECRET` alone, and
 * that is load-bearing twice over.
 *
 * It gives revocation. There is no session table here and no reason to build
 * one, so a cookie already issued is otherwise valid for its full thirty days no
 * matter what happens to the secret it was traded for. Mixing `OPS_SECRET` into
 * the key means rotating it invalidates every outstanding cookie in the same
 * breath — which is the only reason anybody ever rotates it.
 *
 * It also fixes the key width. `APP_JWT_SECRET` is only obliged to be sixteen
 * characters (`lib/env.ts` §0), which is half of what HS256 wants; the digest is
 * thirty-two bytes regardless of what went into it.
 *
 * THE CACHE IS KEYED ON THE MATERIAL IT WAS DERIVED FROM, not merely on having
 * run once. Digesting on every request would be wasteful, but a cache that never
 * looks at its input turns the revocation property above into a lie: rotate
 * `OPS_SECRET` in the dashboard and a warm login instance would accept the new
 * secret (read fresh) while still signing with the old key, and a warm edge
 * instance would keep honouring cookies cut from the old key until it happened to
 * recycle. Whether a session worked would become a function of instance warmth.
 * Comparing the material costs a string compare and makes rotation take effect on
 * the next request, everywhere, which is what a kill switch has to mean.
 */
let cached: { material: string; key: Promise<Uint8Array> } | null = null

function signingKey(): Promise<Uint8Array> | null {
  if (!opsGateConfigured()) return null
  // The version prefix is a domain separator: it means a future token format can
  // be given a different key rather than being confused with this one.
  const material = `class-manager/ops/v1\n${jwtSecret()}\n${opsSecret()}`
  if (!cached || cached.material !== material) {
    cached = { material, key: sha256(material) }
  }
  return cached.key
}

function sha256(value: string): Promise<Uint8Array> {
  return crypto.subtle
    .digest('SHA-256', new TextEncoder().encode(value))
    .then((d) => new Uint8Array(d))
}

/**
 * Constant-time string equality that runs on the edge.
 *
 * `node:crypto`'s `timingSafeEqual` is not available in middleware, and the naive
 * `===` on a secret leaks its prefix one character at a time to anyone patient
 * enough to measure. Hashing both sides first is the standard way out: the digests
 * are always thirty-two bytes, so the comparison loop below runs the same number
 * of iterations for every input and its duration says nothing about either the
 * length or the content of what was presented. An attacker who could forge a
 * SHA-256 collision here has already won something far larger than this console.
 */
export async function safeEqualSecret(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < da.length; i += 1) diff |= (da[i] as number) ^ (db[i] as number)
  return diff === 0
}

/**
 * Issue an operator session. Returns null rather than throwing when the gate is
 * unconfigured, so the caller's refusal path and its wrong-secret path are the
 * same code — one way to say no is one way to get it wrong.
 *
 * The payload carries `{ ops: true }` and nothing else. There is exactly one
 * operator and no roles to encode, and a claim set that says nothing is a claim
 * set that cannot leak anything if the cookie is read off a shared machine.
 */
export async function signOpsToken(): Promise<string | null> {
  const key = signingKey()
  if (!key) return null
  return new SignJWT({ ops: true })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    // Epoch seconds rather than jose's '30d' shorthand, so the cookie's Max-Age
    // and the token's own expiry are derived from one constant and cannot drift.
    .setExpirationTime(Math.floor(Date.now() / 1000) + OPS_MAX_AGE_SECONDS)
    .sign(await key)
}

/**
 * Verify an operator session. Every failure — absent, malformed, expired, signed
 * with a rotated secret, or signed with an algorithm we did not ask for — is the
 * same `false`.
 *
 * `algorithms: [ALG]` is not decoration. Without it a token is verified using
 * whatever its own header claims, which is the classic algorithm-confusion way
 * into an HMAC-signed JWT.
 */
export async function verifyOpsToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false
  const key = signingKey()
  if (!key) return false
  try {
    const { payload } = await jwtVerify(token, await key, { algorithms: [ALG] })
    return payload.ops === true
  } catch {
    return false
  }
}

/**
 * Read the ops cookie off the raw `Cookie` header.
 *
 * `NextRequest.cookies` exists in middleware and `cookies()` exists in a route
 * handler, but neither is available in both, and this gate has to answer the same
 * question in both places. The header is the one representation every runtime
 * agrees on, so it is the one this reads — and reading it here means the parser
 * is written once instead of copied into each route that needs it.
 */
export function readOpsCookie(req: Request): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== OPS_COOKIE) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/**
 * The bearer hatch: `Authorization: Bearer <OPS_SECRET>`.
 *
 * It exists for callers that have no cookie jar. `scripts/drive.ts`,
 * `scripts/smoke.mjs`, `scripts/verify-invariants.mjs` and
 * `scripts/verify-plan-tap.mjs` drive the whole product over HTTP against
 * `/api/emulator/*`, and the brief's second goal is that the operator can still
 * run those scenarios once the gate is up. Without a header route in, the gate
 * does not lock the console so much as delete the test harness.
 *
 * It is deliberately NOT a second credential — it is the same `OPS_SECRET` the
 * login door takes, so it inherits that secret's rotation and its length floor,
 * and there is nothing extra to leak or to revoke. Note that a browser cannot be
 * tricked into sending this header cross-origin, so unlike the cookie it carries
 * no CSRF surface at all.
 */
async function bearerAuthorized(req: Request): Promise<boolean> {
  const header = req.headers.get('authorization')
  if (!header) return false
  const prefix = 'bearer '
  if (!header.toLowerCase().startsWith(prefix)) return false
  const presented = header.slice(prefix.length).trim()
  if (!presented) return false
  const expected = opsSecret()
  if (!expected) return false
  return safeEqualSecret(presented, expected)
}

/**
 * The one question: is this request allowed to touch the ops surface?
 *
 * Cookie first because that is what nearly every request carries and it is one
 * HMAC verify; the bearer path costs two digests and only headless callers reach
 * it. `opsGateConfigured()` gates both, so a deployment missing a secret — or
 * holding a weak one — refuses everybody rather than accidentally accepting a
 * bearer of the empty string.
 */
export async function authorizeOps(req: Request): Promise<boolean> {
  if (!opsGateConfigured()) return false
  if (await verifyOpsToken(readOpsCookie(req))) return true
  return bearerAuthorized(req)
}

/**
 * The guard an ops route opens with, shaped exactly like `requireSandbox()` in
 * `lib/ops-guard.ts`: `null` means carry on, a `Response` means stop and return it
 * unchanged.
 *
 * WHY THE ROUTES CHECK AT ALL WHEN `middleware.ts` ALREADY DID. Because middleware
 * being the only layer makes one matcher edit, one framework regression or one
 * platform routing quirk the whole difference between a locked console and a
 * public one — and what is behind it is every parent conversation, phone number,
 * payment row and memory line in the database. Next's own guidance after
 * CVE-2025-29927 is not to let middleware be the boundary; it is a fast path and
 * the thing that redirects a browser to the login, and this is the boundary.
 *
 * It returns rather than throws so the refusal is an ordinary 401 in the house
 * body shape rather than an exception some outer `catch` turns into a 500 that
 * the client reads as "the server is unwell" and retries, instead of "you are
 * signed out". The `catch` is for the same reason: if `authorizeOps` ever grows a
 * throwing path, an expired cookie must still come back as 401.
 */
export async function requireOps(req: Request): Promise<Response | null> {
  try {
    if (await authorizeOps(req)) return null
  } catch {
    // Fall through to the refusal. Fail closed.
  }
  return Response.json(
    { ok: false, error: 'unauthorized' },
    { status: 401, headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * Behind a proxy the connection to the function is plain HTTP, so the scheme the
 * BROWSER used is only knowable from `x-forwarded-proto`. Getting this wrong in
 * either direction is a real outage: `Secure` on localhost means the cookie is
 * never stored and the operator cannot log in at all, and no `Secure` in
 * production means the session rides an unencrypted request the first time
 * somebody types the bare hostname.
 */
export function isSecureRequest(req: Request): boolean {
  const forwarded = req.headers.get('x-forwarded-proto')
  if (forwarded) return forwarded.split(',')[0].trim() === 'https'
  try {
    return new URL(req.url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Both cookie headers are built here, from one list of attributes, because a
 * browser matches a clearing cookie to the one it holds on name, Path and Secure.
 * Written out twice they drift, logout stops clearing anything, and the symptom
 * is a session that will not end rather than an error anyone sees.
 *
 * `SameSite=Lax` rather than `Strict`: the console is arrived at from bookmarks
 * and from the login redirect, both of which Lax allows, while the cross-site
 * POST that `Strict` exists to stop is already impossible — Lax withholds the
 * cookie from cross-site non-GET requests on its own.
 */
function cookieHeader(value: string, maxAge: number, secure: boolean): string {
  return [
    `${OPS_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
    // A past Expires alongside Max-Age=0 for the clearing case: the first is what
    // every current browser honours, the second is the older fallback.
    maxAge === 0 ? 'Expires=Thu, 01 Jan 1970 00:00:00 GMT' : null,
    secure ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ')
}

/** The `Set-Cookie` that opens a session. */
export function opsCookie(token: string, secure: boolean): string {
  return cookieHeader(token, OPS_MAX_AGE_SECONDS, secure)
}

/** The `Set-Cookie` that ends one. */
export function clearOpsCookie(secure: boolean): string {
  return cookieHeader('', 0, secure)
}

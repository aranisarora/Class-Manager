/**
 * scripts/ops-cookie.mjs — how a script gets through the ops gate.
 *
 * `middleware.ts` put `/api/emulator/*` behind a cookie, and every script that
 * drives the emulator — `drive.ts`, `smoke.mjs`, `verify-invariants.mjs`,
 * `verify-plan-tap.mjs` — talks to exactly that surface. Without this they all
 * take a 401 on their first call, which is a confusing way to discover that the
 * console grew a door.
 *
 * It logs in the way a browser does rather than inventing a second credential
 * path. The alternative — teaching the middleware to also accept a bare
 * `OPS_SECRET` header — would mean two ways into the console instead of one, and
 * the weaker of the two would be the one used by unattended scripts. Trading the
 * secret for a short-lived token at `/api/ops/login` uses the same route, the
 * same signing key and the same expiry as the real thing, so there is nothing
 * extra to reason about when auditing the gate.
 *
 * The result is cached for the life of the process: a drive makes hundreds of
 * calls and one login is enough for all of them.
 *
 * When `OPS_SECRET` is absent this returns an empty string rather than throwing,
 * because a database that predates the gate — or a checkout that never set the
 * variable — should fail on the actual 401 with the route's own message, not
 * here with a message about configuration the caller did not ask about.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `.mjs` scripts are not loaded by Next, so `process.env` does not carry
 * `.env.local`. This is the same small, deliberate dotenv `lib/env.ts` uses, kept
 * to the one key rather than parsing a whole environment nobody asked for.
 */
function secretFromFile() {
  const path = join(process.cwd(), '.env.local')
  if (!existsSync(path)) return undefined
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0 || line.slice(0, eq).trim() !== 'OPS_SECRET') continue
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    return value
  }
  return undefined
}

/** null until the first attempt; a string (possibly empty) forever after. */
let cached = null

/**
 * A `Cookie:` header value for the gated API, or `''` when the gate is not
 * configured. Safe to spread into headers either way — an empty cookie header is
 * ignored by the server, which leaves the caller with the same 401 it would have
 * had.
 */
export async function opsCookie(base = process.env.APP_BASE_URL ?? 'http://localhost:3000') {
  if (cached !== null) return cached

  const secret = process.env.OPS_SECRET ?? secretFromFile()
  if (!secret) return (cached = '')

  const res = await fetch(`${base}/api/ops/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret }),
  }).catch(() => null)

  if (!res || !res.ok) return (cached = '')

  // `getSetCookie` keeps the headers separate; joining on the name=value half is
  // what a `Cookie:` request header wants — the attributes are the server's
  // business and sending them back is malformed.
  const jar = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0])
  return (cached = jar.join('; '))
}

import { OPS_COOKIE, verifyOpsToken } from '@/lib/ops-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * What kind of world the console is pointed at — the one question the client cannot
 * answer for itself.
 *
 * Every destructive control in the emulator is refused server-side when `OPS_SANDBOX`
 * is not exactly '1', and that refusal is the security boundary. This route exists so
 * the UI can agree with it: a button that renders, is clicked, and then 403s teaches
 * the operator that the console is broken rather than that the control is forbidden.
 * So the server says which mode it is in and the client hides what would be refused.
 * Hiding is cosmetic; the gate is not. Neither one depends on the other being right.
 *
 * `OPS_SANDBOX`, `TRANSPORT` and the Vercel git metadata are read straight from
 * `process.env` rather than `lib/env.ts`, following the precedent set by the Meta
 * webhook: CONTRACTS §0 fixes that object's keys, and these belong to the deployment
 * rather than to the build. Absent means production, because the safe reading of a
 * missing flag is the one that forbids more.
 */

/**
 * Read one cookie off the raw header.
 *
 * The middleware gate matches `/`, `/emulator*` and `/api/emulator*`, and this route is
 * under none of them — `/api/ops` is a PUBLIC prefix there, because that is where the
 * login lives and gating the door is how you lock yourself out of the building. So this
 * route checks itself: same cookie, same verifier, one layer down.
 *
 * That single lock is only acceptable because of what is behind it. This handler reads
 * four strings and writes nothing; the worst an unauthenticated caller could learn is
 * which mode the deployment is in, and `app/page.tsx` publishes more than that. Anything
 * under `/api/ops` that can change the world does NOT get to reason this way — the drive
 * endpoint was moved to `app/api/emulator/drive/route.ts` precisely so the edge gate
 * covers it and this in-route check becomes its second lock rather than its only one.
 */
function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get('cookie')
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/**
 * `verifyOpsToken` already folds absent, malformed, expired and wrongly-signed into one
 * `false`, so this adds nothing but the catch — and the catch is the point. If that
 * function ever grows a throwing path, an expired cookie would surface as a 500, which
 * reads as "the server is unwell" rather than "you are signed out": the client retries
 * instead of sending the operator to the login. Fail closed, and fail as a 401.
 */
async function authed(req: Request): Promise<boolean> {
  try {
    return await verifyOpsToken(cookieValue(req, OPS_COOKIE))
  } catch {
    return false
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!(await authed(req))) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  return Response.json({
    ok: true,
    // Exactly '1'. A truthiness test would unlock the destructive half of the console
    // on `OPS_SANDBOX=0`, and `!== '0'` would unlock it on the unset variable that
    // production will actually have.
    sandbox: process.env.OPS_SANDBOX === '1',
    transport: process.env.TRANSPORT ?? 'emulator',
    baseUrl: process.env.APP_BASE_URL ?? null,
    // Vercel injects this on every deployment; locally there is no commit to name.
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  })
}

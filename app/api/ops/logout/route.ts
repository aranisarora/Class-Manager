import { clearOpsCookie, isSecureRequest } from '@/lib/ops-auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Give the cookie back.
 *
 * Public on purpose, and safe to be: it takes no input, reads no state and can
 * only ever remove the caller's own credential. Gating it would mean an operator
 * holding a cookie the gate no longer accepts has no way to be rid of it.
 *
 * There is nothing to revoke server-side. The token is stateless and stays
 * cryptographically valid until it expires, so this clears the browser's copy and
 * that is all it claims to do. If a cookie is believed to have escaped, the only
 * real revocation is rotating `OPS_SECRET` — which invalidates every outstanding
 * session at once, because the signing key is derived from it (`lib/ops-auth.ts`).
 */
export async function POST(req: Request): Promise<Response> {
  return Response.json(
    { ok: true },
    {
      headers: {
        'Set-Cookie': clearOpsCookie(isSecureRequest(req)),
        'Cache-Control': 'no-store',
      },
    },
  )
}

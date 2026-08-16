import { NextResponse, type NextRequest } from 'next/server'

import { authorizeOps } from '@/lib/ops-auth'

/**
 * The gate. One credential, checked in front of the whole ops surface.
 *
 * WHY A COOKIE AND NOT A BEARER HEADER — FOR BROWSERS. `lib/emulator/state.ts`
 * opens the live feed as `new EventSource('/api/emulator/stream')`, and
 * `EventSource` has no API for request headers — none, in any browser. A
 * header-only scheme would therefore 401 the stream while every other call in the
 * console kept working, and the client swallows that failure: on error it closes,
 * flips to a 2.5-second poll of state + events + open threads, and retries forever
 * with capped backoff. The result is not a locked console, it is a console that
 * looks merely laggy while hammering the gate. A same-origin cookie is attached by
 * the browser to the `EventSource` request automatically, which is the only scheme
 * that covers the stream, and it covers the four fetch sites that bypass the
 * central `api()` helper for free as well.
 *
 * AND A BEARER HEADER TOO — FOR EVERYTHING THAT IS NOT A BROWSER. `scripts/drive.ts`,
 * `scripts/smoke.mjs`, `scripts/verify-invariants.mjs` and
 * `scripts/verify-plan-tap.mjs` drive the product over HTTP against
 * `/api/emulator/*` and have no cookie jar; a cookie-only gate does not lock the
 * test harness so much as delete it. `authorizeOps` therefore also accepts
 * `Authorization: Bearer <OPS_SECRET>`. That is the same secret the login door
 * takes — not a second credential with its own lifetime — and a browser cannot be
 * induced to send it cross-origin, so it adds no CSRF surface. The constant-time
 * comparison it needs is Web Crypto (`safeEqualSecret`), which runs on the edge;
 * see `lib/ops-auth.ts`.
 *
 * WHY EDGE AND NOT `runtime = 'nodejs'`. Next 15.5 will run middleware on node,
 * but taking it would mean betting the gate on a young code path, adding a node
 * cold start to every request including each stream reconnect, and possibly
 * needing a flag in `next.config.ts`. Nothing here needs node: `jose` verifies the
 * JWT on Web Crypto and the bearer compare is Web Crypto as well. The one place
 * `node:crypto` is still used — `app/api/ops/login/route.ts` — is a node route by
 * declaration, and keeps it because that is the house pattern the Meta webhook set.
 *
 * THIS IS A FAST PATH, NOT THE BOUNDARY. Every `/api/emulator/*` handler calls
 * `requireOps` itself, and that is where the security decision actually lives.
 * Next's own guidance after CVE-2025-29927 is that middleware should not be the
 * only thing between the internet and the data, and the data here is every parent
 * conversation, phone number and payment row in the database. What this file adds
 * on top of the per-route checks is the half a route handler cannot do: sending a
 * browser to the login screen instead of showing it a JSON error, and refusing
 * page routes like `/` and `/emulator` that have no handler to guard themselves.
 *
 * WHAT STAYS PUBLIC, AND WHY EACH ONE HAS TO. `/api/webhook` is Meta's, and Meta
 * cannot hold a cookie; it authenticates itself with an HMAC over the raw body
 * and gating it would kill all production inbound traffic — silently, because
 * Meta's failure mode is retry-then-disable rather than an error anyone sees.
 * `/api/cron/*` is pg_cron's, which cannot hold a cookie either and carries its
 * own bearer secret. `/ops/login` and `/api/ops/login` are the door itself, and
 * gating the door is how you lock yourself out of the building. Next's internals
 * and static assets are never matched at all.
 *
 * `/api/ops/*` IS NOT ALL DOOR. `config` lives there too, and it is outside this
 * matcher and guards itself with the same `verifyOpsToken` one layer down. That is
 * the right shape: widening the matcher to cover `/api/ops` would put the login
 * route inside its own gate, and carving an exception back out for that one path
 * is exactly the lookahead-with-a-hole this file is written to avoid. So the rule
 * for anything new under `/api/ops`: it authenticates itself, or it is genuinely
 * public. Anything that is ops rather than door — `/api/emulator/drive`, which
 * reaches `seedWorld`, is the current example — belongs under `/api/emulator`,
 * where the matcher covers it and its own check becomes the second layer rather
 * than the only one.
 */

/*
 * No `export const runtime` here on purpose. Middleware defaults to edge, which
 * is what this wants, and naming it explicitly would either restate the default
 * or — with the deprecated `'experimental-edge'` spelling — pin it to a value
 * that is on its way out.
 */

/**
 * An allowlist, not a catch-all with exclusions. A negative lookahead is one
 * typo away from either exposing the console or gating the webhook, and both
 * failures are quiet. Listing the protected paths means a new public route is
 * public by default and a new ops route has to be added here deliberately.
 *
 * `/` is in the list because `app/page.tsx` is not a landing page: it renders the
 * DATABASE_URL host, academy and contact counts across every tenant, the pending
 * job count and the configured model names. Gating `/emulator` while leaving that
 * open would be locking the door beside an open window.
 *
 * Both the bare and the `:path*` forms are listed for each prefix. The star form
 * does match the bare path, but it reads as though it might not, and a matcher is
 * the wrong place to be clever.
 */
export const config = {
  matcher: ['/', '/emulator', '/emulator/:path*', '/api/emulator', '/api/emulator/:path*'],
}

/**
 * Belt and braces against a future edit to `config.matcher`. The matcher above
 * already excludes all of these by construction, so today this list changes
 * nothing — it exists so that widening the matcher cannot accidentally gate the
 * webhook or the cron drain, which are the two failures that break production
 * rather than merely annoying an operator.
 */
const PUBLIC_PREFIXES = ['/api/webhook', '/api/cron', '/api/ops', '/ops']

/** Everything under these is the ops console. */
const GATED_PREFIXES = ['/emulator', '/api/emulator']

/** The API half answers in JSON; the page half answers with a redirect. */
const API_PREFIX = '/api/'

function under(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

function isGated(pathname: string): boolean {
  if (under(pathname, PUBLIC_PREFIXES)) return false
  return pathname === '/' || under(pathname, GATED_PREFIXES)
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl
  if (!isGated(pathname)) return NextResponse.next()

  if (await authorizeOps(req)) return NextResponse.next()

  // An unauthenticated API call gets a status its caller can read. Redirecting it
  // would hand `fetch` a 200 full of login HTML, which the console would try to
  // parse as world state and report as a corrupt response rather than a locked
  // one. `no-store` because a cached 401 outlives the login that fixes it.
  //
  // The stream is the loud case: `/api/emulator/stream` will take this 401 and
  // reconnect on a backoff forever, so an operator whose cookie has expired sees
  // 'reconnecting' rather than 'log in'. That is the correct trade — the page
  // itself redirects, so the only way to be looking at a console with a dead
  // stream is to have had the cookie expire under an already-open tab.
  if (pathname.startsWith(API_PREFIX)) {
    return NextResponse.json(
      { ok: false, error: 'unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    )
  }

  // A navigation gets the door, and gets told where it was going. 307 rather than
  // 302 so the method and body of a non-GET navigation survive the round trip.
  const url = req.nextUrl.clone()
  url.pathname = '/ops/login'
  url.search = ''
  url.searchParams.set('next', pathname + search)
  return NextResponse.redirect(url, 307)
}

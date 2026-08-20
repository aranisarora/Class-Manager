/**
 * lib/ops-guard.ts — the one rule that lets the emulator be pointed at a real business.
 *
 * The emulator was written as a simulator, and a simulator's whole job is to fabricate:
 * invent a world, invent a parent, invent the message they sent, invent the moment they
 * read it. Every one of those acts is correct against a fixture and catastrophic against
 * a database holding a real academy and real parents. Deploying the console as the
 * production ops surface means the read half of it travels and the fabricating half must
 * not, and this module is where that line is drawn.
 *
 * What is behind the line, and why each one is not merely untidy in production:
 *
 *   - `seed` calls `seedWorld`, whose first statement is `resetWorld`. That enumerates
 *     every academy `app.list_academies()` returns — real tenants included, not just the
 *     two fixture ids — deletes them (every tenant table cascades), then runs
 *     `delete from job`, `delete from sim_fault` and `delete from sender`. One request is
 *     total data loss plus the destruction of the row holding the live Cloud credentials.
 *   - `clock` moves `sim_clock`. A real academy has no row of its own, so it inherits the
 *     world offset, and the same handler then runs `planAhead` + `runDueJobs` against the
 *     moved time — a week's jump fires a week of reminders at real parents at once.
 *   - `fault` writes `sim_fault`, which has no academy column and is read by the live send
 *     path with no tenant filter. One armed `send_fail` breaks outbound for everybody.
 *   - `inbound` takes the same road a webhook does: it writes an inbound `message` row, so
 *     the transcript records words the parent never said, stamps `last_inbound_at` (which
 *     reopens the paid 24-hour window), promotes contact state per §11.2, and then runs a
 *     real turn that can send a real WhatsApp reply. There is no "reply as the academy"
 *     control in this UI, so the composer cannot simply be left enabled.
 *   - `delivery` and `read` forge the §2.4 ladder. Under `TRANSPORT=cloud` those
 *     transitions are supposed to arrive from Meta's status webhook; hand-advancing them
 *     writes timestamps no handset produced into the §16.3 quality proxies that exist to
 *     tell the operator whether messages are actually landing.
 *   - `academy` and `contact` create and delete. Creation writes emulator infrastructure
 *     (the fixture sender, `'{}'` credentials, a number from the reserved test range) into
 *     the production database; deletion cascades a whole business away, or — for a person —
 *     explicitly removes payments and tally lines that §8.3 keeps non-cascading precisely
 *     so they survive.
 *   - `money`'s write half attests a payment as an admin it identifies from nothing but a
 *     `contactId` in the body. The operator of this console is the vendor, not the academy,
 *     so a confirm from here stamps `confirmed_by` with a real admin's `person_id` for a
 *     decision they never made — §6.4 keeps that column to answer exactly that question —
 *     and, because `notify` is hardcoded true, mails the parent a receipt for it. On a build
 *     without `confirm_payment` it degrades to `record_payment`, which credits the account a
 *     second time.
 *
 * The read routes and `tick` are deliberately not here. Full visibility is the point of
 * shipping this console — including reading the money, which goes through `cm_user` so
 * `app.sees_money()` rather than this module decides what comes back — and `tick` only
 * drains work that was already due.
 *
 * ---------------------------------------------------------------------------------------
 * TWO GUARDS, BECAUSE THE LINE MOVED
 *
 * Everything above describes ONE switch for the WHOLE deployment, and that turns out to be
 * one setting too coarse for what this console is now for. The owner needs to run their own
 * scenarios against the live deployment — stand up a test academy, send it messages, push
 * its clock to Tuesday, watch the reminder ladder fire — and has no reason at all to touch
 * a paying tenant. "Unlock production" cannot express that; it is the same permission
 * granted to every row at once. "This one academy is scratch" can, and 0030 gives `academy`
 * the `is_sandbox` column that says it.
 *
 * So there are two guards now, and which one a handler wants turns on a single question:
 * does the request name the tenant it is about to act on?
 *
 *   requireSandbox()           for the operations that are irreducibly global, and stay
 *                              refused in production no matter what any row says. `seed`
 *                              is `resetWorld`, which enumerates every academy and deletes
 *                              them all before emptying `job`, `sim_fault` and `sender`.
 *                              `fault` writes `sim_fault`, a table with no academy column
 *                              (0002, `unique (kind)`) read by the send path with no tenant
 *                              filter, so one armed fault breaks outbound for everybody.
 *                              `drive` seeds. None of the three has a target to test, and a
 *                              flag on one row cannot scope an effect whose scope is the
 *                              world.
 *
 *   requireSandboxAcademy(id)  for everything that names its target — the clock, inbound,
 *                              delivery, read, contact create and drop, academy drop, the
 *                              money write. Each acts on exactly one tenant, so each can be
 *                              asked whether that tenant is a toy, and refused per request
 *                              rather than per deployment.
 *
 * Per-academy permission is only honest because per-academy EFFECT already exists. 0024
 * gave `sim_clock` a nullable `academy_id`, `app.now_for()` resolves a tenant's own row
 * before the world row, and the job runner claims against
 * `app.now_for((payload->>'academy_id')::uuid)` (lib/jobs/runner.ts:126) — so pushing a
 * sandbox tenant to Tuesday provably does not fire a real tenant's Tuesday. Had that not
 * been true, scoping the guard would have been a scoped permission over an unscoped effect,
 * which is worse than no scoping at all: it reads as safe.
 * ---------------------------------------------------------------------------------------
 *
 * `OPS_SANDBOX` is read straight from `process.env` and never through `lib/env.ts`,
 * following the precedent set by the Meta webhook: CONTRACTS §0 fixes that object's keys,
 * and this one belongs to the deployment rather than to the build.
 *
 * The comparison is `=== '1'` and nothing else. Unset is the production case — it is what
 * Vercel will have unless somebody deliberately sets it — so the default answer has to be
 * "locked". A truthiness test or a `!== '0'` would read an absent variable as permission,
 * which is exactly backwards: the environment where the destructive controls do the most
 * damage is the one least likely to have configured anything.
 */

// The only import this file may have. `lib/errors.ts` imports nothing at all, which is what
// makes it safe here: see `UUID_RE` below for why a module the browser also compiles cannot
// reach for the usual helpers.
import { errorMessage } from '@/lib/errors'

/** True only for the literal string '1'. Absent, empty, 'true' and 'yes' all mean locked. */
export function sandboxEnabled(): boolean {
  return process.env.OPS_SANDBOX === '1'
}

/**
 * The guard every destructive handler opens with. `null` means carry on; a `Response`
 * means stop and return it unchanged.
 *
 * @mechanism requireSandbox — the refusal for the emulator controls whose scope is the whole
 *   world, so no row can vouch for them: `seed`, whose first statement enumerates every
 *   academy `app.list_academies()` returns and deletes them before emptying `job`, `sim_fault`
 *   and `sender`; `fault`, which writes a table with no academy column that the send path
 *   reads with no tenant filter; and `drive`, which seeds. The test is `OPS_SANDBOX === '1'`
 *   and nothing else, because the environment where these do the most damage is the one least
 *   likely to have configured anything — an unset variable has to read as locked, not as
 *   permission.
 *
 * It returns rather than throws so the refusal is an ordinary 403 with the house body
 * shape, not an exception that some outer `catch` turns into a 500 and the operator reads
 * as a bug. `sandbox_only` is the stable machine-readable half — the UI keys off that, not
 * off the prose.
 */
export function requireSandbox(): Response | null {
  if (sandboxEnabled()) return null
  return Response.json(
    {
      ok: false,
      error: 'sandbox_only',
      detail:
        'This control fabricates or destroys data — it seeds and resets the world, moves the clock, injects faults, invents inbound messages, forges delivery receipts, or attests a payment in the name of an admin who never approved it. Against a real academy that means losing real records, writing money nobody paid, or inventing traffic that never happened, so it is disabled unless the deployment sets OPS_SANDBOX=1. Production ops is read-only visibility plus the tick that drains due work.',
    },
    { status: 403 },
  )
}

/* ------------------------------------------------------------------------------------- *
 * Per-academy: the same refusal, asked about one row instead of the whole deployment.
 * ------------------------------------------------------------------------------------- */

/**
 * The uuid shape, written out here rather than imported from `@/lib/ids`.
 *
 * Not a stylistic choice. `components/emulator/OpsBar.tsx` imports `SANDBOX_ONLY` from this
 * module, which puts this file in the BROWSER bundle, and `lib/ids.ts` opens with
 * `import { createHash, randomUUID } from 'node:crypto'`. Next's client compiler supplies a
 * fallback for bare `crypto` and none for `node:crypto`, so that single convenience import
 * would fail the production build with a module-resolution error naming a file nobody was
 * editing. Three other modules already keep a private copy of this regex for their own
 * reasons (lib/db.ts, lib/actions.ts, lib/agent/operations.ts); this is the fourth, and it
 * is the one that costs the least to keep true — the uuid shape is not going to change.
 *
 * The same constraint is why the academy read below is behind a `typeof window` branch.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** `sandbox: false` always carries the sentence a human needs; the code never varies. */
type SandboxVerdict = { sandbox: true } | { sandbox: false; why: string }

/**
 * Does this academy carry `is_sandbox = true`? Fails closed on every uncertainty.
 *
 * THE SESSION PIN IS THE WHOLE TRICK. `academy`'s service policy is
 * `academy_cm_service_all ... using (id = app.academy_id())` (0003_rls.sql:88-91) — keyed on
 * `id`, not on `academy_id` — so a service session sees exactly one academy row: the one it
 * is pinned to. The way to read a candidate's flag is therefore to pin the session to the
 * candidate itself, which is precisely what satisfies that predicate. Two nearby helpers
 * look right and are not: `withInfra` (lib/jobs/util.ts:70) pins the NIL uuid, and the
 * `{ academyId: '' }` bootstrap ctx (lib/identity.ts:27) makes `app.academy_id()` NULL. Both
 * make the predicate false for every real academy and return ZERO ROWS WITH NO ERROR, and a
 * guard built on either would refuse every academy forever while looking like a policy bug.
 *
 * Nothing here distinguishes "does not exist" from "you cannot see it", and nothing needs
 * to: every answer that is not literally `true` refuses. Zero rows, a null flag, a
 * malformed id, a dropped connection, a table that has not had 0030 applied to it — all of
 * them mean "not proven to be a toy", which means "treat it as somebody's business".
 *
 * WHY THE `typeof window` BRANCH, AND WHY THE IMPORT IS DYNAMIC. `OpsBar.tsx` is a
 * `'use client'` component importing `SANDBOX_ONLY` from this file, so this module is
 * compiled for the browser too, and `@/lib/db` reaches `postgres`, which imports `net`,
 * `tls`, `fs` and `perf_hooks` — none of which Next's client compiler has a fallback for.
 * A top-level import would therefore break `next build` outright, and the pool IIFE at
 * lib/db.ts:190 would try to construct itself on page load. SWC replaces `typeof window`
 * with a literal at compile time ('object' in the browser layer, 'undefined' on the
 * server), so this branch is statically dead in the client build and webpack never records
 * the `import()` inside it as a dependency — the driver stays server-side, and the runtime
 * check is a second line of defence if some future bundler declines to fold it.
 *
 * This answers a question about the ROW and nothing else. It deliberately does not consult
 * `sandboxEnabled()`; combining the two facts is `requireSandboxAcademy`'s job, so a caller
 * that genuinely wants "is this tenant marked scratch" — the console, deciding what to
 * offer — gets that answer and not a different one.
 */
async function lookupSandboxAcademy(academyId: string | null | undefined): Promise<SandboxVerdict> {
  const id = String(academyId ?? '').trim()

  // Two callers arrive here: one that sent no academy at all, and one whose own resolution
  // (`findAcademy`, `resolveIdentity`, `viewerOf`) came back empty and passed the nothing
  // straight through. The sentence has to be true of both, because the refusal is the same
  // refusal — an unscoped destructive call in production is a call against every tenant.
  if (!id) {
    return {
      sandbox: false,
      why: 'no academy was named, or the one that was named did not resolve to a tenant. An unscoped destructive call is a call against every tenant, so the identifier is required rather than defaulted',
    }
  }

  if (!UUID_RE.test(id)) {
    return { sandbox: false, why: `"${id.slice(0, 64)}" is not an academy id` }
  }

  if (typeof window === 'undefined') {
    try {
      const { withSession } = await import('@/lib/db')
      const rows = await withSession({ role: 'service', academyId: id }, async (tx) => {
        return await tx<{ is_sandbox: boolean }[]>`select is_sandbox from academy where id = ${id}::uuid`
      })

      const row = rows[0]
      if (!row) return { sandbox: false, why: `no academy ${id} is visible to this deployment` }
      // `=== true` and not a truthiness test: a null column, or a driver that ever handed
      // back the string 'f', has to land on the refusing side of this line.
      if (row.is_sandbox !== true) return { sandbox: false, why: `academy ${id} is a real tenant` }
      return { sandbox: true }
    } catch (e) {
      return { sandbox: false, why: `the sandbox flag on ${id} could not be read (${errorMessage(e)})` }
    }
  }

  return { sandbox: false, why: 'the sandbox flag can only be read on the server' }
}

/**
 * `true` only when this academy exists and is explicitly marked scratch.
 *
 * Exported for callers that want the fact rather than the refusal — a route that has
 * already resolved its tenant and wants to branch, or a check written into a report. Every
 * route-level use should go through `requireSandboxAcademy` instead, because that one also
 * honours the deployment switch and hands back a refusal the operator can read.
 */
export async function isSandboxAcademy(academyId: string | null | undefined): Promise<boolean> {
  return (await lookupSandboxAcademy(academyId)).sandbox
}

/**
 * The per-academy guard. `null` means carry on; a `Response` means stop and return it.
 *
 * @mechanism requireSandboxAcademy — the same refusal asked about one row rather than the
 *   whole deployment, so the owner can run scenarios against the live console without
 *   "unlock production" — one permission granted to every tenant at once — being the only
 *   thing they can say. It reads `academy.is_sandbox` (0030) with the session PINNED TO THE
 *   CANDIDATE, the only pin that satisfies the service policy `using (id = app.academy_id())`;
 *   anything short of a proven `true` refuses, and a missing academyId refuses hardest,
 *   because the clock handler turns absence into the WORLD row that every tenant without one
 *   inherits. Honest only because per-tenant EFFECT already exists: 0024's nullable
 *   `sim_clock.academy_id` and `app.now_for()` mean pushing a sandbox tenant to Tuesday
 *   provably does not fire a real tenant's Tuesday.
 *
 * The order matters and is the contract:
 *
 *   1. `sandboxEnabled()` — the whole deployment is a scratch box, which is localhost —
 *      short-circuits to `null`. The existing local workflow is preserved exactly, and a
 *      developer's every click does not pay for a round trip to prove what the environment
 *      already said.
 *   2. A missing, empty or malformed `academyId` REFUSES. This is the case the whole design
 *      turns on: `clock` makes `academyId` optional and its handler turns absence into `''`
 *      (`const scope = body.academyId ?? ''`), which lib/clock.ts:142-146 reads as
 *      `academy_id is null` — the WORLD row, which 0024 makes every academy without a row of
 *      its own inherit. Falling through to that would move a real tenant's Tuesday and then
 *      fire it, so absence is refused rather than defaulted.
 *   3. Anything short of a proven `is_sandbox = true` REFUSES — missing row, null flag,
 *      thrown error, unapplied migration. See `lookupSandboxAcademy` for why every one of
 *      those arrives looking identical and why that is fine.
 *   4. Proven true returns `null`.
 *
 * `sandbox_academy_only` is the stable machine-readable half and does not vary with the
 * reason; the reason lives in `detail`, in prose, because the operator staring at a refused
 * click needs to know whether they mistyped an id, forgot to mark the tenant, or aimed at
 * a real business — and a UI keying off the error string must not have to care which.
 */
export async function requireSandboxAcademy(academyId: string | null | undefined): Promise<Response | null> {
  if (sandboxEnabled()) return null

  const verdict = await lookupSandboxAcademy(academyId)
  if (verdict.sandbox) return null

  return Response.json(
    {
      ok: false,
      error: 'sandbox_academy_only',
      detail: `This control fabricates or destroys data — it invents inbound messages, moves a clock, forges delivery receipts, deletes a business or a person, or attests a payment nobody made. Outside a sandbox deployment it will only act on an academy explicitly marked as scratch (academy.is_sandbox, migration 0030), and ${verdict.why}. Mark a test academy as a sandbox and aim this at that one, or set OPS_SANDBOX=1 on a deployment where losing every record costs nothing.`,
    },
    { status: 403 },
  )
}

/**
 * The capability keys the console must hide when `sandboxEnabled()` is false.
 *
 * These names are a contract with the UI, which imports this list to decide what to
 * render; they are stable and they mirror the emulator route each capability reaches, so
 * a reader can go from a hidden button to the handler that would have refused it:
 *
 *   seed      the reseed / reset-world control                POST /api/emulator/seed
 *   clock     advance, jump to next event, set, reset         POST /api/emulator/clock
 *   fault     arming failure injection (listing stays)        POST /api/emulator/fault
 *   inbound   the composer, reply taps and media sends        POST /api/emulator/inbound
 *   delivery  the bulk ladder and the auto-delivery timer     POST /api/emulator/delivery
 *   read      the per-message tick marks                      POST /api/emulator/read
 *   academy   create and drop a business                      POST/DELETE .../academy
 *   contact   create and drop a test person                   POST/DELETE .../contact
 *   money     attesting a payment (reading balances stays)    POST /api/emulator/money
 *
 * Hiding a control is a courtesy, not the defence. The server refuses regardless, because
 * a UI that merely stops offering the button still leaves the endpoint one `curl` away.
 *
 * This list is still a statement about the DEPLOYMENT, and for the seven capabilities that
 * name their tenant it is now the wrong shape: with `is_sandbox` on the selected academy the
 * server would allow the click that this list tells the console to hide. Splitting it into
 * the two that stay global (`seed`, `fault`) and the seven that become a per-tenant decision
 * waits on one hop that does not exist yet. `worldState()` does put `isSandbox` on the wire
 * (lib/seed.ts:1386), but `normalizeAcademy` in lib/emulator/state.ts rebuilds every academy
 * as an explicit literal and does not carry the key across, so the console still cannot tell
 * a scratch tenant from a real one. Narrowing this list before it can would offer buttons the
 * server refuses, which teaches the operator the console is broken — so the list stays whole
 * until the normaliser names the flag.
 */
export const SANDBOX_ONLY = [
  'seed',
  'clock',
  'fault',
  'inbound',
  'delivery',
  'read',
  'academy',
  'contact',
  'money',
] as const

export type SandboxCapability = (typeof SANDBOX_ONLY)[number]

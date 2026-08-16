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

/** True only for the literal string '1'. Absent, empty, 'true' and 'yes' all mean locked. */
export function sandboxEnabled(): boolean {
  return process.env.OPS_SANDBOX === '1'
}

/**
 * The guard every destructive handler opens with. `null` means carry on; a `Response`
 * means stop and return it unchanged.
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
 *   inbound   the composer, reply taps and Flow submits       POST /api/emulator/inbound
 *   delivery  the bulk ladder and the auto-delivery timer     POST /api/emulator/delivery
 *   read      the per-message tick marks                      POST /api/emulator/read
 *   academy   create and drop a business                      POST/DELETE .../academy
 *   contact   create and drop a test person                   POST/DELETE .../contact
 *   money     attesting a payment (reading balances stays)    POST /api/emulator/money
 *
 * Hiding a control is a courtesy, not the defence. The server refuses regardless, because
 * a UI that merely stops offering the button still leaves the endpoint one `curl` away.
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

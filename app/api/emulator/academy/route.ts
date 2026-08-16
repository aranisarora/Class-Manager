import { z } from 'zod'

import { withSession, type Tx } from '@/lib/db'
import { requireSandboxAcademy, sandboxEnabled } from '@/lib/ops-guard'
import { createAcademy, detId, dropAcademy, findAcademy, worldAcademyIds } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST commits the tenant in `createAcademy` and then marks it in a second transaction it
 * cannot yet merge with the first (the gap is named on POST below), so the one thing that
 * must not happen is the platform cutting this handler off between the two writes. The
 * default function ceiling is short enough to be a plausible cause of exactly that; 300 is
 * what `webhook`, `cron/tick` and `drive` already ask for, and this route is nowhere near as
 * long-running as any of them.
 */
export const maxDuration = 300

/**
 * Making and unmaking a business — the operator's job, and only the operator's.
 *
 * **Signup is deliberately not a product flow.** The owner of Class Manager
 * creates a tenant; a stranger messaging the shared number cannot, and
 * `resolveInbound` returning `unresolved` for a number that matches no academy
 * is that decision working rather than a gap to close. §10.1 routes a stranger
 * to an academy that already exists, and stops there on purpose: a tenant a
 * stranger can conjure is a tenant anybody can conjure, on a number every other
 * business shares.
 *
 * So this route exists for the emulator and the driver, which are the operator.
 * It calls the same `lib/seed` functions the driver does — one idea of what
 * creating and deleting a business means, not two.
 */

const Create = z.object({
  name: z.string().min(1).max(120),
  adminName: z.string().min(1).max(120),
  /** E.164, with or without the +. Omitted, a free number in the test range is picked. */
  adminPhone: z.string().min(6).max(20).optional(),
  timezone: z.string().min(1).max(64).optional(),
  category: z.string().min(1).max(80).optional(),
  /**
   * Scratch tenant or real business. Omitted, a hosted console makes a sandbox and a
   * localhost one does not — which is the right guess in both places, and a guess is all it
   * can be.
   *
   * It has to be sayable, because in production this route is the ONLY way an academy is
   * created: `createAcademy` has exactly two callers, this and `scripts/drive.ts`, and the
   * onboarding Flow only ever moves `onboarding_state` on a tenant that already exists. So
   * the operator's first real customer is born here too, and inferring "sandbox" from
   * "hosted" would quietly mark that customer destructible — the one thing this whole
   * mechanism exists to prevent.
   *
   * Passing `false` on a hosted console is therefore a real choice with a real consequence:
   * the tenant keeps the live sender and no scoped control will ever touch it again.
   */
  sandbox: z.boolean().optional(),
})

/**
 * The sender a sandbox tenant is moved onto, and why the one `createAcademy` gives it is the
 * wrong one in production.
 *
 * `createAcademy` inserts the fixture sender — `WABA-EMULATOR-0001`, `'{}'` credentials — with
 * `on conflict (id) do nothing` and points the new academy at it (lib/seed.ts:1880-1913). On a
 * scratch box that conflicts with nothing and the tenant lands on a credential-less fixture,
 * which is the intent. In production it conflicts with the LIVE row: `scripts/wa-cloud.ts`
 * takes the single existing sender — this same `SENDER_ID` — and UPDATEs it in place with the
 * Cloud phone, `waba_id` and access token. The id that says "emulator" therefore names the
 * real number, and an academy created here would be born on it.
 *
 * The consequence is routing, not merely that its sends would go out. §10.1 disambiguates an
 * unknown number by the sender it arrived on: `app.inbound_candidates` (0005_audit.sql:382)
 * matches the receiving sender on its last ten digits and returns EVERY academy whose
 * `sender_id` is that row, and `matchByName` (lib/identity.ts:181-195) hands the stranger to
 * any candidate sharing a four-character non-generic word with what they typed. A sandbox
 * tenant named "Test Academy" would from birth be one of the candidates every real cold
 * inbound is weighed against, and would catch anyone who writes "test" — a real prospect
 * answered by a business that does not exist, over the production number. No academy could be
 * created in production at all before now, so this hazard arrives with this feature.
 *
 * So a sandbox tenant is given a sender of its own. A distinct number keeps it out of the live
 * sender's candidate list entirely, and `'{}'` credentials keep it from reaching a handset by
 * any other road: under `TRANSPORT=cloud` each send fails with "no credentials cached for
 * sender …" (lib/messaging/transport-cloud.ts:340), which is a recorded per-message failure
 * the console shows rather than a crash. That is a deliberate trade against the operator's
 * wish to watch the ladder arrive on their own phone. The ladder is still watchable where the
 * emulator always meant it to be watched — message rows, statuses, the event log — and the
 * thing a fake business may not do is speak to a real stranger from the real number. Giving a
 * sandbox tenant genuine delivery means giving it a second Meta number and a sender row with
 * its own credentials, never sharing the one the business runs on.
 */
const SANDBOX_SENDER_ID = detId('sender', 'class-manager-sandbox')

/**
 * Adjacent to the fixture's +918047182200 and distinct in its last ten digits, which is the
 * only comparison `app.inbound_candidates` makes. Deliberately outside the +9199 range
 * `createAcademy` draws test *contacts* from, so a sender can never wear a person's number.
 */
const SANDBOX_SENDER_PHONE = '+918047182201'
const SANDBOX_SENDER_LABEL = 'Class Manager (sandbox — no credentials)'

/**
 * The one control that is *inverted* rather than scoped, because there is nothing yet to
 * scope it to: the id is minted inside `createAcademy`, so nothing the caller sends names
 * an existing tenant and no guard can test one. Refusing here would have been the safe
 * reading and the wrong one — every other control now asks "is this academy a sandbox", and
 * a deployment where no sandbox academy can ever be born is a deployment where the answer is
 * always no and the whole scheme is unreachable.
 *
 * So creation is allowed, and off a scratch box the row is stamped `is_sandbox` on the way
 * in. That is what makes the rest of this coherent: the tenant the owner makes to test
 * against is marked as fiction at birth, every scoped control then works on it, and their
 * real businesses — which were never created through here and so carry `is_sandbox`'s
 * `false` default — stay untouchable by construction rather than by vigilance.
 *
 * **The flag is decided here, and only `createAcademy` can write it in one go.** That
 * function is called by `scripts/drive.ts` and stands beside `seedWorld`, which writes its
 * own `insert into academy` for the fixtures; flagging unconditionally inside it would mark
 * those too, and a fixture that claims to be a sandbox is a fixture whose flag proves
 * nothing. What that argument rules out is a HARDCODED flag, not an optional one: an
 * `isSandbox?: boolean` defaulting to false would put the bit in the same INSERT while
 * `seedWorld` and the driver kept today's behaviour simply by not passing it. Until that
 * parameter exists in lib/seed.ts the stamp has to be a second write, which is the gap
 * below. `sandboxEnabled()` decides either way: on localhost the deployment is already the
 * scratch box, nothing needs marking, and today's behaviour is kept exactly.
 *
 * **The gap, stated plainly.** `createAcademy` commits its own transactions, so the tenant
 * exists for a moment before it is marked and moved off the live sender. Every failure that
 * reaches this process is handled — the update is asserted by row count, not assumed, and the
 * catch unmakes the academy — but a handler that simply stops between the two writes leaves a
 * committed, unflagged tenant behind and no catch runs at all. `maxDuration` above removes
 * the platform's duration ceiling as one cause of stopping; an evicted instance is not
 * removable from here. The honest close is the optional parameter described above, which
 * would make this whole branch disappear.
 *
 * The new tenant does not keep the sender `createAcademy` gave it — see `SANDBOX_SENDER_ID`
 * for why sharing the live number is a §10.1 routing hazard rather than a convenience, and
 * for what the operator gives up by not sharing it.
 */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Create.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }
  // `sandbox` is split off rather than passed through: `createAcademy` writes the academy
  // row, and this is a decision about what happens to that row afterwards.
  const { sandbox, ...create } = parsed.data
  const asSandbox = sandbox ?? !sandboxEnabled()
  try {
    const created = await createAcademy(create)

    if (asSandbox) {
      try {
        // One transaction for both halves of being a sandbox — the flag and the sender —
        // because a tenant that is marked but still on the live number, or moved but not
        // marked, is a state nothing downstream is written to expect.
        await withSession({ role: 'service', academyId: created.academyId }, async (tx: Tx) => {
          // `sender` is one of the tenant-less tables (`sender_cm_service_all ... using (true)
          // with check (true)`, 0003), so this insert does not care what the session is pinned
          // to. `do nothing` on conflict means the second sandbox academy joins the first one's
          // number rather than minting another row: they are candidates for each other's cold
          // inbound, which is true of them and of nobody real.
          await tx`
            insert into sender (id, phone_e164, waba_id, credentials, label)
            values (${SANDBOX_SENDER_ID}::uuid, ${SANDBOX_SENDER_PHONE}, 'WABA-SANDBOX-0001',
                    '{}'::jsonb, ${SANDBOX_SENDER_LABEL})
            on conflict (id) do nothing`

          // Pinned to the row itself, because `academy_cm_service_all` is `using (id =
          // app.academy_id())` (0003) — a session pinned anywhere else, or to the empty
          // bootstrap academy, matches no row and updates nothing without raising.
          //
          // `returning id` and the count are load-bearing, not decoration. An UPDATE matching
          // zero rows raises nothing in Postgres, so without them the only failure this catch
          // could ever see is a thrown one: a statement that landed and touched nothing would
          // be reported as `{ ok: true, isSandbox: true }` over an academy still flagged false
          // and still on the live sender — the trap below, announced as a success. Throwing
          // from inside the transaction also rolls the sender insert back, so the failure
          // leaves nothing half-applied for the compensating drop to trip over.
          const stamped = await tx<{ id: string }[]>`
            update academy
               set is_sandbox = true, sender_id = ${SANDBOX_SENDER_ID}::uuid
             where id = ${created.academyId}::uuid
            returning id`
          if (stamped.length !== 1) {
            throw new Error(
              `the sandbox stamp matched ${stamped.length} rows, not 1 — academy ${created.academyId} is not visible to a service session pinned to itself`,
            )
          }
        })
      } catch (e) {
        // An unflagged tenant on a hosted deployment is worse than a leftover, in two ways at
        // once. It is a trap: every scoped control refuses it, DELETE included, so the
        // operator could neither drive it nor remove it from this console. And it is still on
        // the sender `createAcademy` gave it, which in production is the live number — so
        // until it is gone it sits in the §10.1 candidate list every real cold inbound is
        // matched against. It is seconds old and holds nothing but its own owner, so unmaking
        // it costs nothing and leaving it costs a stranger's first message.
        const undone = await dropAcademy(created.academyId).catch(() => null)
        const detail = e instanceof Error ? e.message : String(e)
        return Response.json(
          {
            ok: false,
            error: `the academy was created but could not be marked as a sandbox, so it ${undone ? 'was removed again' : `could NOT be removed and is STRANDED at ${created.academyId} on the live sender — delete it by hand before a stranger's message is matched against it`}: ${detail}`,
          },
          { status: 500 },
        )
      }
    }

    // The note is the half of the outcome the operator cannot see and would otherwise
    // discover as a bug: their new academy is real, and its messages will not arrive on
    // anyone's handset, because it is deliberately not on the number the business runs on.
    return Response.json({
      ok: true,
      academy: { ...created, isSandbox: asSandbox },
      note: asSandbox
        ? `marked is_sandbox and moved onto the sandbox sender ${SANDBOX_SENDER_PHONE}, which holds no credentials: sends from this academy are recorded and then fail, and it is invisible to inbound arriving on the live number`
        : null,
    })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

/** Every business currently in the world, for a picker that needs to name them. */
export async function GET(): Promise<Response> {
  try {
    return Response.json({ ok: true, academyIds: await worldAcademyIds({ refresh: true }) })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

/**
 * Delete one business and everything in it. `academy_id … on delete cascade` is
 * on every tenant table, so this is one statement and RI does the rest.
 *
 * Sandbox academy only, and this is the route that needs the flag most. That cascade is the
 * whole danger: people, contacts, classes, accounts, payments and every message ever
 * exchanged go with the row, from a single request with no confirmation token. `dropAcademy`
 * also resolves case-insensitively by *name*, so a mistyped `?academy=Ace` finds whichever
 * real business happens to be called that. With the flag, that typo is a 403 instead of an
 * unrecoverable delete.
 */
export async function DELETE(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const which = url.searchParams.get('academy') ?? url.searchParams.get('academyId') ?? ''
  if (!which) return Response.json({ ok: false, error: 'academy id or name is required' }, { status: 400 })

  try {
    // Resolve first, and judge the canonical id rather than the query string: `?academy=`
    // takes a name as readily as a uuid, so testing what the caller typed would be testing
    // nothing. `dropAcademy` runs the same `findAcademy` immediately afterwards — one cheap
    // resolution repeated, against a delete that cannot be repeated at all.
    const found = await findAcademy(which)
    const denied = await requireSandboxAcademy(found?.id)
    if (denied) return denied
    if (!found) return Response.json({ ok: false, error: 'academy_not_found' }, { status: 404 })

    const gone = await dropAcademy(found.id)
    if (!gone) return Response.json({ ok: false, error: 'academy_not_found' }, { status: 404 })
    return Response.json({ ok: true, dropped: gone })
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}

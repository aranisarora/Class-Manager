import { z } from 'zod'

import { OPERATIONS, type OperationDef, type OperationName } from '@/lib/agent/operations'
import { executePlan } from '@/lib/agent/plan'
import { withSession, type SessionCtx, type Tx } from '@/lib/db'
import { worldAcademyIds } from '@/lib/seed'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The money half of the product, on screen (§6.4, §11.5).
 *
 * Everything else in §17 has a surface — messages, jobs, memory, faults — and money had none
 * at all, so the one thing a coaching business is actually run on could not be seen to work
 * or seen to break. The seed writes tally lines and leaves payments `requested`; nothing in
 * the browser could show a balance, and nothing in the browser could attest one, which is the
 * entire Rail 1 state machine (§11.5: `requested ──([Yes])──> confirmed`).
 *
 * **Read as the contact whose pane is open, never as the service role.** That is not
 * ceremony: §6.7 row 4 says money-shaped rows never route to a player's own number, and the
 * gate is `app.sees_money()` in the policy rather than a branch in application code. Reading
 * through `cm_user` means this endpoint demonstrates that rule instead of describing it — a
 * teenage player's pane comes back with no accounts because the database refused, and a coach
 * gets the same answer for the same reason.
 */

const Query = z.object({ contactId: z.string().uuid() })

const Body = z.object({
  /** Who is attesting. Rail 1 records the admin who said yes, so this is not decoration. */
  contactId: z.string().uuid(),
  /** The `requested` row being confirmed (§11.5), when there is one. */
  paymentId: z.string().uuid().optional(),
  /** Or a payment nobody asked for: cash in hand, a UPI transfer that just arrived. */
  accountId: z.string().uuid().optional(),
  amount: z.number().positive().optional(),
  reference: z.string().max(120).optional(),
  method: z.string().max(40).optional(),
})

type Viewer = {
  contactId: string
  personId: string
  name: string
  academyId: string
  academyName: string
  timezone: string
  rail: string
  upiHandle: string | null
  isAdmin: boolean
}

/** A wa id carries no tenant and neither does a contact id: find the academy that owns it. */
async function viewerOf(contactId: string): Promise<Viewer | null> {
  for (const academyId of await worldAcademyIds()) {
    const found = await withSession({ role: 'service', academyId }, async (tx: Tx) => {
      const rows = await tx<
        {
          id: string
          person_id: string
          full_name: string
          academy_id: string
          academy_name: string
          timezone: string
          rail: string
          upi_handle: string | null
          is_admin: boolean
        }[]
      >`
        select c.id, c.person_id, p.full_name, c.academy_id,
               a.name as academy_name, a.timezone, a.rail, a.upi_handle,
               exists (select 1 from academy_admin aa
                        where aa.academy_id = c.academy_id and aa.person_id = c.person_id) as is_admin
          from contact c
          join person p on p.id = c.person_id
          join academy a on a.id = c.academy_id
         where c.id = ${contactId}::uuid`
      return rows[0] ?? null
    })
    if (!found) continue
    return {
      contactId: String(found.id),
      personId: String(found.person_id),
      name: String(found.full_name),
      academyId: String(found.academy_id),
      academyName: String(found.academy_name),
      timezone: String(found.timezone),
      rail: String(found.rail),
      upiHandle: found.upi_handle ?? null,
      isAdmin: Boolean(found.is_admin),
    }
  }
  return null
}

const money = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v))

/** §6.4 — "Balance for a period = sum(tally_line.amount) - sum(confirmed payment.amount)". */
export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const parsed = Query.safeParse({ contactId: url.searchParams.get('contactId') })
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_query', issues: parsed.error.issues }, { status: 400 })
  }

  try {
    const viewer = await viewerOf(parsed.data.contactId)
    if (!viewer) return Response.json({ ok: false, error: 'contact_not_found' }, { status: 404 })

    const ctx: SessionCtx = {
      role: 'user',
      academyId: viewer.academyId,
      personId: viewer.personId,
      contactId: viewer.contactId,
    }

    const data = await withSession(ctx, async (tx: Tx) => {
      const gate = await tx<{ sees_money: boolean }[]>`select app.sees_money() as sees_money`
      const accounts = await tx<Record<string, unknown>[]>`
        select a.id, a.display_name, a.holder_person_id, p.full_name as holder_name,
               coalesce((select sum(t.amount) from tally_line t where t.account_id = a.id), 0) as billed,
               coalesce((select sum(pm.amount) from payment pm
                          where pm.account_id = a.id and pm.status = 'confirmed'), 0) as paid,
               (select string_agg(pe.full_name, ', ' order by pe.full_name)
                  from player pl join person pe on pe.id = pl.person_id
                 where pl.account_id = a.id and pl.active) as players,
               (select ct.id from contact ct
                 where ct.academy_id = a.academy_id and ct.person_id = a.holder_person_id
                 order by ct.is_primary desc limit 1) as holder_contact_id
          from account a
          join person p on p.id = a.holder_person_id
         where a.academy_id = ${viewer.academyId}::uuid
         order by p.full_name`

      const lines = await tx<Record<string, unknown>[]>`
        select t.id, t.account_id, t.period::text as period, t.kind, t.description, t.amount,
               t.reason, pe.full_name as player_name
          from tally_line t
          left join player pl on pl.id = t.player_id
          left join person pe on pe.id = pl.person_id
         where t.academy_id = ${viewer.academyId}::uuid
         order by t.period desc, t.created_at desc
         limit 200`

      const payments = await tx<Record<string, unknown>[]>`
        select pm.id, pm.account_id, pm.amount, pm.rail, pm.method, pm.reference, pm.status,
               pm.requested_at, pm.confirmed_at, pm.evidence_url, att.full_name as confirmed_by_name
          from payment pm
          left join person att on att.id = pm.confirmed_by
         where pm.academy_id = ${viewer.academyId}::uuid
         order by coalesce(pm.confirmed_at, pm.requested_at, pm.created_at) desc
         limit 200`

      return { seesMoney: Boolean(gate[0]?.sees_money), accounts, lines, payments }
    })

    const accounts = data.accounts.map((a) => {
      const id = String(a.id)
      const billed = money(a.billed)
      const paid = money(a.paid)
      return {
        id,
        name: (a.display_name as string) ?? (a.holder_name as string),
        holderName: String(a.holder_name),
        holderContactId: a.holder_contact_id ? String(a.holder_contact_id) : null,
        players: (a.players as string) ?? null,
        billed,
        paid,
        balance: billed - paid,
        lines: data.lines
          .filter((l) => String(l.account_id) === id)
          .map((l) => ({
            id: String(l.id),
            period: String(l.period),
            kind: String(l.kind),
            description: String(l.description),
            amount: money(l.amount),
            reason: (l.reason as string) ?? null,
            playerName: (l.player_name as string) ?? null,
          })),
        payments: data.payments
          .filter((p) => String(p.account_id) === id)
          .map((p) => ({
            id: String(p.id),
            amount: money(p.amount),
            rail: String(p.rail),
            method: (p.method as string) ?? null,
            reference: (p.reference as string) ?? null,
            status: String(p.status),
            requestedAt: p.requested_at ? new Date(p.requested_at as string).toISOString() : null,
            confirmedAt: p.confirmed_at ? new Date(p.confirmed_at as string).toISOString() : null,
            confirmedByName: (p.confirmed_by_name as string) ?? null,
            evidenceUrl: (p.evidence_url as string) ?? null,
          })),
      }
    })

    return Response.json({
      ok: true,
      viewer: {
        contactId: viewer.contactId,
        name: viewer.name,
        isAdmin: viewer.isAdmin,
        // False here is a policy decision, not an empty table, and the panel says which.
        seesMoney: data.seesMoney,
      },
      academy: {
        id: viewer.academyId,
        name: viewer.academyName,
        timezone: viewer.timezone,
        rail: viewer.rail,
        upiHandle: viewer.upiHandle,
      },
      accounts,
      totals: {
        billed: accounts.reduce((n, a) => n + a.billed, 0),
        paid: accounts.reduce((n, a) => n + a.paid, 0),
        outstanding: accounts.reduce((n, a) => n + Math.max(0, a.balance), 0),
      },
      /** So the control can name the operation it is about to run rather than implying one. */
      attestOperation: attestOperationName(true),
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

/**
 * Which operation carries this attestation.
 *
 * The two controls are two different acts and they are not interchangeable. Confirming a row
 * the business already asked for is §11.5's one transition and belongs to `confirm_payment`,
 * which takes the payment id and never an amount — the point of it being a distinct operation
 * is that amount-matching was double-crediting. Recording money nobody asked for has no
 * requested row to point at, so it is `record_payment` and always was.
 *
 * `confirm_payment` is resolved by name rather than imported so this route also works against
 * a build that does not have it yet, and the answer is reported to the caller either way: an
 * emulator that quietly does something adjacent to what the button says is worse than one
 * that cannot do it at all (§2.4).
 */
function attestOperationName(hasRequestedRow: boolean): OperationName {
  const registry = OPERATIONS as Record<string, OperationDef | undefined>
  if (hasRequestedRow && registry.confirm_payment) return 'confirm_payment' as OperationName
  return 'record_payment' as OperationName
}

/**
 * Only the arguments the chosen operation actually declares.
 *
 * The two operations do not take the same shape — one confirms a payment id, the other
 * records an amount against an account — and zod's object parser is strict enough that
 * passing a key it does not know is a failed turn rather than a harmless extra. Reading the
 * declared keys off the schema means this control keeps working across the operation being
 * added, renamed or given another parameter.
 */
function argsFor(def: OperationDef, bag: Record<string, unknown>): Record<string, unknown> {
  const shape = (def.params as { shape?: Record<string, unknown> }).shape
  if (!shape) return bag
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(shape)) {
    if (bag[key] !== undefined && bag[key] !== null) out[key] = bag[key]
  }
  return out
}

/** §11.5 — Rail 1's one transition, driven by the admin who attests it. */
export async function POST(req: Request): Promise<Response> {
  const raw = await req.json().catch(() => ({}))
  const parsed = Body.safeParse(raw)
  if (!parsed.success) {
    return Response.json({ ok: false, error: 'invalid_body', issues: parsed.error.issues }, { status: 400 })
  }
  const body = parsed.data

  try {
    const viewer = await viewerOf(body.contactId)
    if (!viewer) return Response.json({ ok: false, error: 'contact_not_found' }, { status: 404 })
    if (!viewer.isAdmin) {
      // Rail 1 is "the admin attests" (§6.4, `confirmed_by`), and the RLS policy on `payment`
      // is `app.is_admin()`. Refusing here with a sentence beats the same refusal arriving as
      // a policy violation the driver has to decode.
      return Response.json(
        {
          ok: false,
          error: `${viewer.name} is not an admin of ${viewer.academyName} — rail 1 records the admin who attested, so only they can confirm a payment (§11.5)`,
        },
        { status: 403 },
      )
    }

    const ctx: SessionCtx = {
      role: 'user',
      academyId: viewer.academyId,
      personId: viewer.personId,
      contactId: viewer.contactId,
    }

    // The requested row carries the amount and the account, so a one-tap confirm does not
    // depend on the browser having sent either of them back correctly.
    let accountId = body.accountId ?? null
    let amount = body.amount ?? null
    let reference = body.reference ?? null
    const paymentId = body.paymentId
    if (paymentId) {
      const row = await withSession({ role: 'service', academyId: viewer.academyId }, async (tx: Tx) => {
        const rows = await tx<
          { account_id: string; amount: string; reference: string | null; status: string }[]
        >`select account_id, amount, reference, status from payment where id = ${paymentId}::uuid`
        return rows[0] ?? null
      })
      if (!row) return Response.json({ ok: false, error: 'payment_not_found' }, { status: 404 })
      if (row.status === 'confirmed') {
        return Response.json({ ok: false, error: 'that payment is already confirmed' }, { status: 409 })
      }
      accountId = String(row.account_id)
      amount = Number(row.amount)
      reference = reference ?? row.reference ?? null
    }

    if (!accountId || !amount) {
      return Response.json(
        { ok: false, error: 'give a paymentId to confirm, or an accountId and an amount to record' },
        { status: 400 },
      )
    }

    const name = attestOperationName(Boolean(paymentId))
    const def = (OPERATIONS as Record<string, OperationDef | undefined>)[name]
    if (!def) {
      return Response.json({ ok: false, error: `no operation named ${name} in this build` }, { status: 501 })
    }

    const args = argsFor(def, {
      payment_id: paymentId ?? null,
      account_id: accountId,
      amount,
      method: body.method ?? 'upi',
      reference,
      notify: true,
      confirmed: true,
    })

    const result = await executePlan(
      ctx,
      [{ operation: { name, args } }],
      `emulator: ${viewer.name} attests ${amount} on rail 1`,
    )

    return Response.json({
      ok: result.ok,
      operation: name,
      // A confirm routed through `record_payment` is a different act with a similar outcome,
      // and the driver has to be told which one ran (§2.4).
      note:
        name === 'record_payment' && paymentId
          ? 'this build has no confirm_payment operation — the attestation ran through record_payment, which writes a fresh payment row as well as confirming the requested one'
          : null,
      summary: result.summary,
      error: result.error ?? null,
      messages: result.stagedMessages,
    })
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

/**
 * app/w/[token]/submit/route.ts — the one write path off the web surface.
 *
 * Three shapes post here, and all three obey the same three rules:
 *
 *   1. The token is verified AGAIN, on every submit. That is what makes §17's
 *      `link_expired` fault able to expire a link mid-form: the page opened
 *      fine, the submit does not, and the form says so instead of pretending.
 *   2. Every write runs under the LINK HOLDER's own RLS — role `cm_user` with
 *      their academy_id / person_id / contact_id. A form submitted from a bot
 *      link writes with no login, and can write nothing that person could not
 *      have written by hand (§2.1).
 *   3. A confirmation goes back into the chat through `composeAndSend`. The web
 *      surface never becomes a place where things happen quietly.
 *
 * `form` and `register` both run a NAMED OPERATION — the same operation the model
 * would have chosen in the chat, with the same atomicity, diff and audit
 * guarantees (§14.2.1). `register` did not, for most of this product's life: it
 * wrote `attendance` with its own SQL, which meant the register screen marked
 * attendance and produced none of §6.4's money and never completed the session.
 * A screen is a different way to reach an operation, never a second implementation
 * of one. `setup` still writes its own rows, under the same RLS.
 */

import { z } from 'zod'
import type { SessionCtx } from '@/lib/db'

/** A link session always has a person and a contact behind it. */
type UserCtx = Extract<SessionCtx, { role: 'user' }>
import { withSession } from '@/lib/db'
import { verifyLink } from '@/lib/web/jwt'
import { loadViewSpec } from '@/lib/web/views'
import type { ComponentSpec, FormField } from '@/lib/web/registry'
import { composeAndSend } from '@/lib/messaging/compose'
import { resolveIdentity } from '@/lib/identity'
import { OPERATIONS } from '@/lib/agent/operations'
import type { OperationName } from '@/lib/agent/operations'
import { audienceFor, executePlan } from '@/lib/agent/plan'

export const dynamic = 'force-dynamic'

type Ok = { ok: true; message: string; messaged: boolean }
type Fail = { ok: false; message: string; expired?: boolean }

function json(body: Ok | Fail, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await params
  const claims = await verifyLink(token)
  if (!claims) {
    return json({ ok: false, expired: true, message: 'This link has expired. Ask for a new one in the chat.' }, 200)
  }

  // The magic link IS the session (§15), and it always carries a person and a contact —
  // so this is the `user` variant specifically, not the wider union. Narrowing it here
  // is what lets the handlers read `ctx.personId` / `ctx.contactId` directly.
  const ctx: UserCtx = {
    role: 'user',
    academyId: claims.academy_id,
    personId: claims.person_id,
    contactId: claims.contact_id,
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, message: "I couldn't read that submission." }, 400)
  }

  const kind = (body as { kind?: unknown } | null)?.kind
  try {
    if (kind === 'setup') return await handleSetup(ctx, body)
    if (kind === 'register') return await handleRegister(ctx, claims.ref, body)
    if (kind === 'form') return await handleForm(ctx, claims.ref, body)
    return json({ ok: false, message: 'That form posted something I do not know how to save.' }, 400)
  } catch (e) {
    const message = (e as Error)?.message ?? 'something went wrong'
    if (/row-level security|permission denied/i.test(message)) {
      return json({ ok: false, message: "That isn't yours to change." }, 403)
    }
    return json({ ok: false, message: `That didn't save: ${message}` }, 500)
  }
}

/** A confirmation must never be able to undo a committed write. */
async function confirm(
  ctx: SessionCtx,
  toContactId: string,
  spec: { body: string; buttons?: { title: string; action: { kind: 'reply'; text: string } }[] },
): Promise<boolean> {
  try {
    const outcome = await composeAndSend(ctx, {
      toContactId,
      body: spec.body,
      buttons: spec.buttons,
      catalogId: null,
      // The recipient is the person who just tapped submit, in their own thread.
      // §2.6 keeps the ROSTER silent during onboarding; it was never meant to
      // silence the admin's own confirmation of what they just did.
      preLaunchOk: true,
    })
    return outcome.status === 'sent' || outcome.status === 'queued'
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// §7.1 step 1 — setup
// ---------------------------------------------------------------------------

const TimeString = z.string().regex(/^\d{2}:\d{2}$/)

const SetupSchema = z.object({
  kind: z.literal('setup'),
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(80).optional(),
  timezone: z.string().trim().min(1).max(64),
  cancellationWindowHours: z.number().int().min(0).max(336),
  morningBriefAt: TimeString,
  eveningDigestAt: TimeString,
  upiHandle: z.string().trim().max(120).optional(),
  operatingDays: z.array(z.number().int().min(0).max(6)).max(7),
  opensAt: TimeString,
  closesAt: TimeString,
  venues: z
    .array(
      z.object({
        id: z.string().uuid().nullable(),
        name: z.string().trim().min(1).max(120),
        address: z.string().trim().max(240),
      }),
    )
    .max(30),
})

function validTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz }).format(new Date())
    return true
  } catch {
    return false
  }
}

async function handleSetup(ctx: UserCtx, body: unknown): Promise<Response> {
  const parsed = SetupSchema.safeParse(body)
  if (!parsed.success) {
    return json({ ok: false, message: firstIssue(parsed.error) }, 400)
  }
  const v = parsed.data
  if (!validTimezone(v.timezone)) {
    return json({ ok: false, message: `I don't recognise the timezone "${v.timezone}".` }, 400)
  }

  const pattern = {
    days: [...new Set(v.operatingDays)].sort((a, b) => a - b),
    opens_at: v.opensAt,
    closes_at: v.closesAt,
  }

  const result = await withSession(ctx, async (tx) => {
    const updated = await tx<{ id: string; onboarding_state: string }[]>`
      update academy
         set name                      = ${v.name},
             category                  = ${v.category?.trim() ? v.category.trim() : null},
             timezone                  = ${v.timezone},
             cancellation_window_hours = ${v.cancellationWindowHours},
             morning_brief_at          = ${v.morningBriefAt}::time,
             evening_digest_at         = ${v.eveningDigestAt}::time,
             upi_handle                = ${v.upiHandle?.trim() ? v.upiHandle.trim() : null},
             settings                  = coalesce(settings, '{}'::jsonb)
                                         || jsonb_build_object('operating_pattern', ${JSON.stringify(pattern)}::text::jsonb),
             onboarding_state          = case when onboarding_state = 'setup' then 'roster' else onboarding_state end
       where id = ${ctx.academyId}
       returning id, onboarding_state`
    if (!updated[0]) return null

    const keptIds: string[] = []
    for (const venue of v.venues) {
      if (venue.id) {
        const rows = await tx<{ id: string }[]>`
          update venue
             set name = ${venue.name}, address = ${venue.address || null}
           where id = ${venue.id} and academy_id = ${ctx.academyId}
           returning id`
        if (rows[0]) keptIds.push(rows[0].id)
      } else {
        const rows = await tx<{ id: string }[]>`
          insert into venue (academy_id, name, address)
          values (${ctx.academyId}, ${venue.name}, ${venue.address || null})
          returning id`
        if (rows[0]) keptIds.push(rows[0].id)
      }
    }

    const existing = await tx<{ id: string; name: string }[]>`
      select id, name from venue where academy_id = ${ctx.academyId}`
    const removed = existing.filter((e) => !keptIds.includes(e.id))
    return { onboardingState: updated[0].onboarding_state, kept: keptIds.length, removed }
  })

  if (!result) {
    return json({ ok: false, message: 'Only the admin can change these settings.' }, 403)
  }

  // Removals go one at a time and outside the main transaction: a venue a class
  // still points at cannot be deleted, and that must not roll back the settings
  // the admin just saved.
  const stuck: string[] = []
  for (const venue of result.removed) {
    try {
      await withSession(ctx, async (tx) => {
        await tx`delete from venue where id = ${venue.id} and academy_id = ${ctx.academyId}`
      })
    } catch {
      stuck.push(venue.name)
    }
  }

  const bits = [`Saved — ${v.name} is set up.`]
  bits.push(
    `${result.kept === 1 ? '1 place' : `${result.kept} places`}, ${v.cancellationWindowHours}h cancellation notice, ${
      v.upiHandle?.trim() ? `payments to ${v.upiHandle.trim()}` : 'no UPI handle yet'
    }.`,
  )
  if (stuck.length) {
    bits.push(`I kept ${stuck.join(' and ')} — classes still point at ${stuck.length === 1 ? 'it' : 'them'}.`)
  }
  bits.push('Next: your timetable. A photo of the whiteboard or the paper register is enough — send it here.')

  const messaged = await confirm(ctx, ctx.contactId, {
    body: bits.join(' '),
    buttons: [{ title: 'Send my timetable', action: { kind: 'reply', text: "I'm sending my timetable now" } }],
  })

  return json({ ok: true, message: `Saved. ${v.name} is set up.`, messaged })
}

// ---------------------------------------------------------------------------
// §8.2 step 5 — the register
// ---------------------------------------------------------------------------

const RegisterSchema = z.object({
  kind: z.literal('register'),
  sessionId: z.string().uuid(),
  marks: z
    .array(
      z.object({
        playerId: z.string().uuid(),
        status: z.enum(['present', 'late', 'absent']),
        timely: z.boolean().optional(),
        note: z.string().max(500).nullable().optional(),
      }),
    )
    .min(1)
    .max(300),
})

/**
 * §8.2's register, run through the same operation a register marked in the chat runs.
 *
 * This wrote `attendance` with raw SQL, which made it a **second write path for the
 * one event §6.4 hangs all of its money on** — and the two paths did not agree. What
 * this one produced: attendance marked, and no session line, no free-first-class
 * credit, no package consumption, no timely-cancel refund, and a session that never
 * moved to `completed`. Every one of those is a consequence `mark_attendance`
 * carries and raw SQL cannot. `handleForm` below has had the right shape the whole
 * time: build the named operation, run it through `executePlan`.
 *
 * It is also the path `drive register` posts to — so the one harness command added
 * to unblock the money half was, by construction, the one that could never bill.
 */
async function handleRegister(ctx: UserCtx, ref: string | undefined, body: unknown): Promise<Response> {
  const parsed = RegisterSchema.safeParse(body)
  if (!parsed.success) return json({ ok: false, message: firstIssue(parsed.error) }, 400)
  const v = parsed.data

  if (ref && ref !== v.sessionId) {
    return json({ ok: false, message: 'That register belongs to a different class.' }, 403)
  }

  const identity = await resolveIdentity(ctx.contactId)
  if (!identity) {
    return json({ ok: false, message: "I can't tell who you are from this link any more." }, 403)
  }

  // The page's "absent, and they told me" tick is `cancelled_timely` — the status
  // that means no charge. Resolved here so the operation sees one vocabulary.
  const entries = v.marks.map((mark) => ({
    player_id: mark.playerId,
    status: mark.status === 'absent' && mark.timely === true ? ('cancelled_timely' as const) : mark.status,
    note: mark.note?.trim() ? mark.note.trim() : null,
  }))

  const operation = OPERATIONS.mark_attendance
  const checked = operation.params.safeParse({ session_id: v.sessionId, entries })
  if (!checked.success) return json({ ok: false, message: firstIssue(checked.error) }, 400)

  let result: Awaited<ReturnType<typeof executePlan>>
  try {
    const steps = await operation.build(ctx, checked.data, identity)
    result = await executePlan(ctx, steps, 'Register marked from the register screen', audienceFor(identity))
  } catch (e) {
    // `mark_attendance` throws in English ("there is nobody to mark on that
    // register", "that session is not one I can see"), and this page shows the
    // message to a coach standing on a court.
    return json({ ok: false, message: e instanceof Error ? e.message : "That didn't go through." }, 400)
  }

  if (!result.ok) {
    return json({ ok: false, message: result.error ?? "That didn't go through." }, 400)
  }

  // The operation owns what reaches the chat, including §8.2's "did anyone tell you
  // in advance?" catch-point — the thing that stops a wrong bill. Only speak here if
  // it did not, or the coach gets the same event twice.
  const summary = result.summary?.trim() || 'Register saved.'
  const alreadyTold = result.stagedMessages.some((m) => m.toContactId === ctx.contactId)
  const messaged = alreadyTold ? true : await confirm(ctx, ctx.contactId, { body: summary })
  return json({ ok: true, message: summary, messaged })
}

// ---------------------------------------------------------------------------
// §15 — a model-authored form, run through its named operation
// ---------------------------------------------------------------------------

const FormSubmitSchema = z.object({
  kind: z.literal('form'),
  viewSpecId: z.string().uuid(),
  index: z.number().int().min(0).max(31),
  values: z.record(z.union([z.string(), z.boolean(), z.number(), z.null()])),
})

function coerce(field: FormField, raw: unknown): unknown {
  if (field.kind === 'toggle') return Boolean(raw)
  if (field.kind === 'hidden') return field.value
  const s = raw === null || raw === undefined ? '' : String(raw)
  if (s.trim() === '') return null
  if (field.kind === 'number' || field.kind === 'money') {
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  return s.trim()
}

async function handleForm(ctx: UserCtx, ref: string | undefined, body: unknown): Promise<Response> {
  const parsed = FormSubmitSchema.safeParse(body)
  if (!parsed.success) return json({ ok: false, message: firstIssue(parsed.error) }, 400)
  const v = parsed.data

  if (ref && ref !== v.viewSpecId) {
    return json({ ok: false, message: 'That form belongs to a different link.' }, 403)
  }

  const stored = await loadViewSpec(ctx, v.viewSpecId)
  if (!stored) return json({ ok: false, message: 'I can no longer find that form.' }, 404)
  if (stored.expired) {
    return json({ ok: false, expired: true, message: 'This link has expired. Ask for a new one in the chat.' }, 200)
  }

  const component = stored.spec.components[v.index] as ComponentSpec | undefined
  if (!component || component.type !== 'form') {
    return json({ ok: false, message: "That isn't a form I can submit." }, 400)
  }

  const args: Record<string, unknown> = {}
  for (const field of component.fields) {
    const value = coerce(field, v.values[field.name])
    if ('required' in field && field.required && (value === null || value === '')) {
      return json({ ok: false, message: `${field.label} is needed.` }, 400)
    }
    if (value !== null) args[field.name] = value
  }
  Object.assign(args, component.submit.fixedArgs ?? {})

  const name = component.submit.operation as OperationName
  const operation = OPERATIONS[name]
  if (!operation) {
    return json({ ok: false, message: `I don't have an operation called "${String(name)}" any more.` }, 400)
  }

  const checked = operation.params.safeParse(args)
  if (!checked.success) {
    return json({ ok: false, message: firstIssue(checked.error) }, 400)
  }

  const identity = await resolveIdentity(ctx.contactId)
  if (!identity) return json({ ok: false, message: "I can't tell who you are from this link any more." }, 403)

  const steps = await operation.build(ctx, checked.data, identity)
  const intent = `${component.title ?? stored.spec.title} — submitted from a link (${name})`
  const result = await executePlan(ctx, steps, intent)

  if (!result.ok) {
    return json({ ok: false, message: result.error ?? "That didn't go through." }, 400)
  }

  const summary = result.summary?.trim() || 'Done.'
  const messaged = await confirm(ctx, ctx.contactId, { body: summary })
  return json({ ok: true, message: summary, messaged })
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  if (!issue) return "That didn't look right."
  const where = issue.path.filter((p) => typeof p === 'string').join('.')
  return where ? `${where}: ${issue.message}` : issue.message
}

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
 * `form` submits run the named operation in the spec's `submit` — the same
 * operation the model would have chosen in the chat, with the same preview,
 * atomicity and audit guarantees (§14.2.1). `setup` and `register` are the two
 * purpose-built screens (§7.1, §8.2); they write their own rows, under the same
 * RLS, and the attendance trigger raises `client_outcome` for them exactly as it
 * does for a register marked by a sentence in the chat.
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
import { executePlan } from '@/lib/agent/plan'

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

async function handleRegister(ctx: UserCtx, ref: string | undefined, body: unknown): Promise<Response> {
  const parsed = RegisterSchema.safeParse(body)
  if (!parsed.success) return json({ ok: false, message: firstIssue(parsed.error) }, 400)
  const v = parsed.data

  if (ref && ref !== v.sessionId) {
    return json({ ok: false, message: 'That register belongs to a different class.' }, 403)
  }

  const written = await withSession(ctx, async (tx) => {
    const s = await tx<{ id: string; class_name: string }[]>`
      select s.id, c.name as class_name
        from session s join class c on c.id = s.class_id
       where s.id = ${v.sessionId}
       limit 1`
    if (!s[0]) return null

    const coach = await tx<{ id: string }[]>`
      select id from coach
       where academy_id = ${ctx.academyId} and person_id = ${ctx.personId}
       limit 1`
    const coachId = coach[0]?.id ?? null

    // Which of these absences had a timely cancellation already on record —
    // needed to tell "the coach told me just now" from "we already knew" in the
    // confirmation (§8.2: the catch-point that stops a wrong bill).
    const before = await tx<{ player_id: string; status: string }[]>`
      select player_id, status from attendance where session_id = ${v.sessionId}`
    const priorTimely = new Set(before.filter((b) => b.status === 'cancelled_timely').map((b) => b.player_id))

    const retroactive: string[] = []
    let present = 0
    let late = 0
    let absent = 0
    let timely = 0

    for (const mark of v.marks) {
      const status =
        mark.status === 'absent' && mark.timely === true ? 'cancelled_timely' : mark.status
      if (status === 'present') present++
      else if (status === 'late') late++
      else if (status === 'cancelled_timely') {
        timely++
        if (!priorTimely.has(mark.playerId)) retroactive.push(mark.playerId)
      } else absent++

      await tx`
        insert into attendance (academy_id, session_id, player_id, status, note, marked_by_coach_id, marked_at)
        values (${ctx.academyId}, ${v.sessionId}, ${mark.playerId}, ${status},
                ${mark.note?.trim() ? mark.note.trim() : null}, ${coachId}, app.now())
        on conflict (session_id, player_id) do update
           set status             = excluded.status,
               note               = excluded.note,
               marked_by_coach_id = excluded.marked_by_coach_id,
               marked_at          = excluded.marked_at`
    }

    let retroNames: string[] = []
    if (retroactive.length) {
      const rows = await tx<{ full_name: string }[]>`
        select per.full_name
          from player p join person per on per.id = p.person_id
         where p.id = any (${retroactive}::uuid[])
         order by per.full_name`
      retroNames = rows.map((r) => r.full_name)
    }

    return { className: s[0].class_name, present, late, absent, timely, retroNames }
  })

  if (!written) {
    return json({ ok: false, message: "I can't find that class — it may have been cancelled." }, 404)
  }

  const parts: string[] = []
  parts.push(
    `Register marked for ${written.className}: ${written.present} present` +
      (written.late ? `, ${written.late} late` : '') +
      (written.absent ? `, ${written.absent} absent` : '') +
      (written.timely ? `, ${written.timely} cancelled in time` : '') +
      '.',
  )
  if (written.retroNames.length) {
    const names =
      written.retroNames.length === 1
        ? written.retroNames[0]!
        : `${written.retroNames.slice(0, -1).join(', ')} and ${written.retroNames[written.retroNames.length - 1]}`
    parts.push(
      `I've put ${names} down as cancelled in time, so ${
        written.retroNames.length === 1 ? "there's" : "there are"
      } no charge${written.retroNames.length === 1 ? '' : 's'} for today.`,
    )
  }

  const messaged = await confirm(ctx, ctx.contactId, { body: parts.join(' ') })
  return json({ ok: true, message: 'Register saved.', messaged })
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

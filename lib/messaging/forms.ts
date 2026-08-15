/**
 * lib/messaging/forms.ts — a form, prefilled from the database, for one person.
 *
 * WHY THIS IS NOT IN `flows.ts`
 * -----------------------------------------------------------------------------
 * `flows.ts` is the artifact: the Flow JSON, its types, and the rules Meta applies
 * at publish. All of it is data, so both sides of the wire can hold it — and both
 * sides need to, because §17's emulator RENDERS these forms in the browser. That is
 * the whole point of the emulator: something that works there works on a real
 * number, and it cannot check that against a description of the form.
 *
 * Prefilling is the opposite kind of work. It reads venues, rosters and the academy
 * row through `modelQuery`, under the permissions of whoever is talking — so it
 * drags in `lib/db`, which drags in `lib/env`, which reads `.env.local` off disk
 * with `node:fs`. When those two lived in one file the client bundle inherited the
 * server's whole dependency tree, and the emulator died at build with
 * `UnhandledSchemeError: Reading from "node:fs" is not handled by plugins` — a
 * message that names a Node built-in nobody wrote and no file anybody edited.
 *
 * Splitting on that seam is not a bundler workaround; the bundler was reporting a
 * real thing. **A form definition is public and a form's contents are not.** The
 * roster on a register is exactly the data §15 deleted the browser to stop handing
 * out, so the module that reads it belongs on the server by construction, not by
 * everyone remembering to keep it there.
 *
 * The cost: `formFor` moved, so its callers import from here rather than from
 * `flows.ts`. That is the whole of it — nothing about what gets built changed, and
 * the coercions below moved with it because they only ever served the prefill.
 */

import { modelQuery, type SessionCtx } from '@/lib/db'
import type { Identity } from '@/lib/types'
import { inZone } from '@/lib/clock'
import { ADD_CLASS, BUSINESS_SETUP, REGISTER, type FormId } from './flows'

/* ------------------------------------------------------------------------- *
 * Building one, with real data in it
 * ------------------------------------------------------------------------- */

export type BuiltForm = { flow: string; data: Record<string, unknown> }

/**
 * The form, prefilled from the database, for this person, right now.
 *
 * **One definition, because there are two ways to arrive at a form and they used to
 * disagree.** The `reply` tool built the setup form inline, so a model that asked for
 * it in prose got a form in the chat. A button tap resolving the same thing went
 * through `executeAction`, which knew nothing about Flows — so the owner who *tapped
 * the button the bot had just offered them* was sent out of WhatsApp into a browser,
 * and the one who was answered in prose got the form.
 *
 * Driven from empty: the first message offered `[Setup Sunrise Sports]`, the tap
 * returned "Here it is. Yours only, good for the next hour." and a JWT. That is the
 * highest-stakes moment in the product — a new owner's first action — taking the worse
 * of two paths, and it is the general defect this codebase has hit most often: a
 * guarantee enforced on one path when several exist.
 *
 * Prefill is read HERE, at send or tap time, and never carried in the button. A
 * `[Set up my classes]` tapped tomorrow has to show what is true tomorrow.
 */
export async function formFor(
  ctx: SessionCtx,
  id: Identity,
  form: FormId,
  opts: { toContactId: string; sessionId?: string; prefill?: Record<string, unknown> },
): Promise<BuiltForm | { error: string }> {
  if (form === 'business_setup') return setupFormFor(id, opts.toContactId)
  if (form === 'add_class') return await addClassFormFor(ctx, id, opts.prefill ?? {})
  return await registerFormFor(ctx, id, opts.sessionId)
}

/**
 * The setup form — if this person is the one it is for.
 *
 * Returns an error rather than a form when they are not, because a silent downgrade
 * to prose is how a caller ends up describing a form it did not send. `flow_token` is
 * an action minted for one contact (§2.2), so "the owner themselves" is not a nicety —
 * it is what makes the token bind.
 */
function setupFormFor(id: Identity, toContactId: string): BuiltForm | { error: string } {
  if (!id.roles.includes('admin')) {
    return { error: 'the business form is the owner’s — anything on it can be said in chat instead' }
  }
  if (toContactId !== id.contact.id) {
    return { error: 'a form is minted for the person filling it in, so it only goes to the owner themselves' }
  }
  const a = id.academy
  /**
   * EVERY field the form writes, prefilled from what is on the row now.
   *
   * The form is a full overwrite of the business shape, and an earlier version
   * prefilled two of its five fields — so an owner who opened it a second time to
   * change one thing submitted blanks for the rest, and the UPI handle they had
   * already given was silently nulled and the cancellation window reset. A form that
   * overwrites what it does not show is a data-loss bug wearing a convenience
   * feature's clothes.
   *
   * The venue and address are deliberately absent: they are the fields that ADD a row
   * rather than replacing one, so an empty box means "no new place", not "delete the
   * places I have".
   */
  return {
    flow: BUSINESS_SETUP.id,
    data: {
      name: a.name,
      category: a.category ?? '',
      timezone: a.timezone || 'Asia/Kolkata',
      rate_unit: String((a.settings?.['default_rate_unit'] as string) ?? 'per_month'),
      cancellation_window_hours: String(a.cancellation_window_hours ?? 24),
      upi_handle: a.upi_handle ?? '',
      morning_brief_at: hhmm(a.morning_brief_at) || '07:00',
      evening_digest_at: hhmm(a.evening_digest_at) || '21:00',
    },
  }
}

/**
 * The add-a-class form, carrying whatever was already read off a photo or a sentence.
 *
 * The venue list comes from the database rather than from the model, because a venue
 * the model typed is a venue that does not exist — and a class attached to one is a
 * class nobody can find. Where the business has no venues yet the dropdown is empty
 * and the field is optional, which is the honest state of a business that has not
 * said where it plays.
 */
async function addClassFormFor(
  ctx: SessionCtx,
  id: Identity,
  prefill: Record<string, unknown>,
): Promise<BuiltForm | { error: string }> {
  if (!id.roles.includes('admin')) {
    return { error: 'only the owner adds classes — tell me what needs changing and I’ll pass it on' }
  }
  const res = await modelQuery(ctx, `select name from venue order by name limit 20`)
  const venues = res.error ? [] : res.rows.map((r) => ({ id: String(r.name), title: String(r.name) }))

  const s = (k: string): string => {
    const v = prefill[k]
    return v === undefined || v === null ? '' : String(v)
  }
  return {
    flow: ADD_CLASS.id,
    data: {
      name: s('name'),
      // "mon,wed,fri" and [1,3,5] both arrive here, because the model writes both.
      days: parseDays(prefill['days']),
      starts: normaliseTime(s('starts')),
      ends: normaliseTime(s('ends')),
      venue: s('venue') || (venues.length === 1 ? venues[0].id : ''),
      rate: s('rate') || String(id.academy.settings?.['default_rate_amount'] ?? ''),
      rate_unit: s('rate_unit') || String(id.academy.settings?.['default_rate_unit'] ?? 'per_month'),
      venues,
    },
  }
}

/**
 * The register for one session, with its actual roster on it.
 *
 * `app.session_roster` is the one definition of who is due at a session (§6.3), and it
 * is read here rather than rebuilt, because the last time this join was written twice
 * the two disagreed and the register screen wrote attendance with its own SQL for most
 * of the product's life — producing no money for any of it.
 *
 * Refuses rather than sending an empty form. A register with nobody on it is a form
 * that can only be submitted wrong, and the sentence explaining why is more use than
 * the form would have been.
 */
async function registerFormFor(
  ctx: SessionCtx,
  id: Identity,
  sessionId?: string,
): Promise<BuiltForm | { error: string }> {
  const wanted = (sessionId ?? '').trim()
  if (!wanted) return { error: 'a register needs to know which session' }

  // The register's universe is the UNRESOLVED roster: a player whose family
  // already cancelled has an attendance row, and a form that lists them
  // present-by-default is one Done tap away from overwriting their
  // cancellation (F-I; the job handler and the submit path apply the same
  // exclusion).
  const res = await modelQuery(
    ctx,
    `select r.player_id, r.player_name, r.class_name, r.starts_at
       from app.session_roster r
      where r.session_id = '${wanted.replace(/'/g, "''")}'::uuid
        and not exists (select 1 from attendance a
                         where a.session_id = r.session_id and a.player_id = r.player_id)
      order by r.player_name`,
  )
  if (res.error) return { error: 'I could not read that roster just now' }
  const rows = res.rows as { player_id: string; player_name: string; class_name: string; starts_at: unknown }[]
  if (!rows.length) return { error: 'everyone on that register is already marked' }

  const tz = id.academy.timezone || 'Asia/Kolkata'
  const at = rows[0].starts_at instanceof Date ? (rows[0].starts_at as Date) : new Date(String(rows[0].starts_at))
  const when = Number.isNaN(at.getTime()) ? '' : `, ${inZone(at, tz).time}`
  return {
    flow: REGISTER.id,
    data: {
      session_id: wanted,
      heading: `${rows[0].class_name}${when} — ${rows.length} on the roster`,
      roster: rows.map((r) => ({ id: String(r.player_id), title: String(r.player_name) })),
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Coercions, at the boundary
 * ------------------------------------------------------------------------- */

/** A postgres `time` reaches here as "07:00:00" and the dropdown speaks "07:00". */
function hhmm(v: unknown): string {
  const m = String(v ?? '').match(/^(\d{2}):(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : ''
}

/**
 * "6:30pm", "18:30", "6.30 pm" → "18:30". Anything unrecognisable comes back as it
 * went in, so the person sees what was read and can correct it — which is strictly
 * better than an empty box that says nothing about what went wrong.
 */
function normaliseTime(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (!s) return ''
  const m = s.match(/^(\d{1,2})[:.]?(\d{2})?\s*(am|pm)?$/)
  if (!m) return raw
  let h = Number(m[1])
  const mins = m[2] ?? '00'
  if (m[3] === 'pm' && h < 12) h += 12
  if (m[3] === 'am' && h === 12) h = 0
  if (h > 23) return raw
  return `${String(h).padStart(2, '0')}:${mins}`
}

const DAY_WORDS: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
}

/** `[1,3,5]`, `"mon,wed,fri"`, `"Mon/Wed/Fri"` — all of them, because all of them get written. */
function parseDays(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.map((x) => String(x))
    : String(raw ?? '').split(/[,/|&+]|\band\b/i)
  const out: string[] = []
  for (const p of parts) {
    const t = p.trim().toLowerCase()
    if (!t) continue
    const n = /^[0-6]$/.test(t) ? Number(t) : DAY_WORDS[t]
    if (n === undefined) continue
    const s = String(n)
    if (!out.includes(s)) out.push(s)
  }
  return out
}

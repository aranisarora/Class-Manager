/**
 * lib/messaging/window.ts — the 24h customer service window (§14.7).
 *
 * `contact.last_inbound_at` is the source of truth, and the only thing that writes it is the
 * inbound-message trigger in the schema (§11.2) — no send path can forget to stamp it, and
 * no send path may guess at it.
 *
 * Inside the window a reply needs no template and no approval, costs nothing, and consumes
 * no tier capacity (§16.1). Outside it, one of the eight §16.2 templates carries the message
 * or it does not go. That is the entire rule, and it lives here once.
 *
 * Time is domain time: `app.now()` through `lib/clock.ts`, never `Date.now()` — otherwise
 * advancing the emulator's clock past the window would change nothing (§17).
 */

import { now as clockNow, nowSync } from '@/lib/clock'

export const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * Structurally satisfied by `Contact` from `@/lib/types`. Kept structural so a caller
 * holding only the timestamp — a query result, a join — can ask the same question.
 */
export type WindowContact = { last_inbound_at: Date | string | null }

function toDate(v: Date | string | null | undefined): Date | null {
  if (v === null || v === undefined) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** The window rule, against a caller-supplied domain instant. One implementation. */
export function isInWindowAt(contact: WindowContact, at: Date): boolean {
  const last = toDate(contact.last_inbound_at)
  if (!last) return false
  return at.getTime() - last.getTime() < WINDOW_MS
}

/** `app.now() - contact.last_inbound_at < 24h`. */
export async function isInWindow(contact: WindowContact): Promise<boolean> {
  return isInWindowAt(contact, await clockNow())
}

/** Same rule against the last-loaded clock offset, for render paths that cannot await. */
export function isInWindowSync(contact: WindowContact): boolean {
  return isInWindowAt(contact, nowSync())
}

/** When the window shuts. Null when the contact has never messaged us. */
export function windowExpiresAt(contact: WindowContact): Date | null {
  const last = toDate(contact.last_inbound_at)
  return last ? new Date(last.getTime() + WINDOW_MS) : null
}

/** Milliseconds of free-form conversation left. 0 when shut or never opened. */
export function msLeftInWindow(contact: WindowContact, at: Date = nowSync()): number {
  const expires = windowExpiresAt(contact)
  if (!expires) return 0
  return Math.max(0, expires.getTime() - at.getTime())
}

/**
 * The emulator shows template-vs-in-window on every pane (§17), and this is the line it
 * shows. Deliberately blunt: "free" and "a template must carry it" are the two states that
 * matter to whoever is reading the event log.
 */
export function describeWindow(contact: WindowContact, at: Date = nowSync()): string {
  const last = toDate(contact.last_inbound_at)
  if (!last) return 'out of window · never messaged us · a template must carry it'
  if (!isInWindowAt(contact, at)) {
    const hours = Math.floor((at.getTime() - last.getTime()) / (60 * 60 * 1000))
    return `out of window · last inbound ${hours}h ago · a template must carry it`
  }
  const left = msLeftInWindow(contact, at)
  const h = Math.floor(left / (60 * 60 * 1000))
  const m = Math.floor((left % (60 * 60 * 1000)) / (60 * 1000))
  return `in window · ${h}h ${m}m left · free-form, no template, no tier cost`
}

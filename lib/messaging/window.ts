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

/**
 * There is now a second reader of this rule, and it is deliberate:
 * `person_directory.window_open` (migration 0036) is the same comparison in SQL,
 * `last_inbound_at > app.now() - interval '24 hours'`. If this constant moves,
 * that view moves with it.
 *
 * It exists because the prefix used to tell the model, in as many words, "you
 * cannot tell from here whether a given person's window is open" — while the fact
 * sat in a column the model reads all the time and this file decided it with one
 * subtraction. That is worse than an unmentioned capability: a stale fact in the
 * prefix denies a decision the model is perfectly able to make, and the decision
 * it was denying is a real one, because the message worth sending into an open
 * window and the message worth sending into a shut one are not the same message.
 */
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

/**
 * The window rule, against a caller-supplied domain instant. One implementation —
 * and for a while that sentence was only true of this file's own contents.
 *
 * There were five exported ways to ask it: this one, an async wrapper that fetched
 * the clock, a sync wrapper that read the last-loaded offset, an expiry, a
 * milliseconds-left, and a `describeWindow` line for a pane that never called it.
 * Four of them had no caller anywhere, while `lib/seed.ts` had gone and inlined
 * the arithmetic against a `WINDOW_MS` of its own — twice. The variants were
 * covering the shape of a question nobody was asking, and their existence is
 * probably why the one real second caller wrote its own instead of finding one.
 *
 * The instant is a parameter rather than fetched here on purpose: domain time is
 * `app.now()` through `lib/clock.ts`, and a caller that already holds it (every
 * caller does) must not pay for a second read that could disagree with its first.
 */
export function isInWindowAt(contact: WindowContact, at: Date): boolean {
  const last = toDate(contact.last_inbound_at)
  if (!last) return false
  return at.getTime() - last.getTime() < WINDOW_MS
}

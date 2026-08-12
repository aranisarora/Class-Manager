/**
 * components/view/chrome.tsx — the page frame every /w/ screen shares.
 *
 * There is no navigation here on purpose (§15). A link opens one screen, that
 * screen does one thing, and the way back is the chat. The one thing every page
 * must say, in words, is that the chat can do the same thing — UI is an offer,
 * never a gate (§14.6).
 *
 * Server components. Tailwind v4 utilities only, dark mode via
 * prefers-color-scheme.
 */

import type { ReactNode } from 'react'
import { formatINR } from '@/lib/format'
import { MONEY_COLUMN } from '@/lib/web/registry'

export const CARD =
  'rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900'
export const MUTED = 'text-neutral-500 dark:text-neutral-400'

export function Shell({
  business,
  title,
  subtitle,
  children,
  offer,
}: {
  business?: string | null
  title: string
  subtitle?: string | null
  children: ReactNode
  /** The sentence that says the chat can do this too. */
  offer?: string
}) {
  return (
    <main className="min-h-dvh bg-neutral-50 text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:py-10">
        <header className="mb-5">
          {business ? (
            <p className={`text-[11px] font-medium uppercase tracking-[0.14em] ${MUTED}`}>{business}</p>
          ) : null}
          <h1 className="mt-1 text-xl font-semibold tracking-tight sm:text-2xl">{title}</h1>
          {subtitle ? <p className={`mt-1 text-sm ${MUTED}`}>{subtitle}</p> : null}
        </header>

        <div className="space-y-4">{children}</div>

        <ChatOffer text={offer} />
      </div>
    </main>
  )
}

/** §14.6: "UI is an offer, never a gate." Said in words, on every page. */
export function ChatOffer({ text }: { text?: string }) {
  return (
    <footer className="mt-8 border-t border-neutral-200 pt-4 dark:border-neutral-800">
      <p className={`text-sm ${MUTED}`}>
        {text ?? 'You can do all of this in the chat instead — just reply to the message that brought you here.'}
      </p>
      <p className={`mt-1 text-xs ${MUTED}`}>This link is private to you and stops working after a while.</p>
    </footer>
  )
}

export function Card({
  title,
  note,
  children,
  footer,
}: {
  title?: string
  note?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <section className={CARD}>
      {title || note ? (
        <div className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          {title ? <h2 className="text-sm font-semibold tracking-tight">{title}</h2> : null}
          {note ? <p className={`mt-0.5 text-xs ${MUTED}`}>{note}</p> : null}
        </div>
      ) : null}
      <div className="px-4 py-3">{children}</div>
      {footer ? (
        <div className={`border-t border-neutral-200 px-4 py-2 text-xs dark:border-neutral-800 ${MUTED}`}>
          {footer}
        </div>
      ) : null}
    </section>
  )
}

export function Empty({ what = 'Nothing here' }: { what?: string }) {
  return <p className={`py-6 text-center text-sm ${MUTED}`}>{what}</p>
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <div className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
      <span className="font-medium">Couldn&rsquo;t load this bit.</span> {message} — ask in the chat and you&rsquo;ll
      get it as a message.
    </div>
  )
}

/** The expired-link page. Plain, honest, and never a crash (§15). */
export function Expired() {
  return (
    <main className="grid min-h-dvh place-items-center bg-neutral-50 px-6 text-neutral-900 antialiased dark:bg-neutral-950 dark:text-neutral-100">
      <div className="w-full max-w-sm text-center">
        <div className="mx-auto mb-4 grid size-11 place-items-center rounded-full bg-neutral-200 text-lg dark:bg-neutral-800">
          <span aria-hidden>&#8987;</span>
        </div>
        <h1 className="text-lg font-semibold tracking-tight">This link has expired</h1>
        <p className={`mt-2 text-sm ${MUTED}`}>
          Ask for a new one in the chat — reply to the last message and it&rsquo;ll come straight back.
        </p>
        <p className={`mt-4 text-xs ${MUTED}`}>Nothing you were doing has been saved.</p>
      </div>
    </main>
  )
}

// ---------------------------------------------------------------------------
// Value formatting. Shared by every component so one column never renders two
// ways on the same page.
// ---------------------------------------------------------------------------

const POSITIVE = /^(present|paid|active|confirmed|covered|done|complete|completed|on time|arrived|yes|ok|good|settled|clear)$/i
const NEGATIVE = /^(absent|unpaid|overdue|declined|cancelled|canceled|failed|ended|no|missing|uncovered|blocked|opted.?out)$/i
const WARNING = /^(late|pending|invited|added|requested|partial|due|scheduled|awaiting|trial|running late)$/i

export type Tone = 'good' | 'bad' | 'warn' | 'plain'

export function toneOf(value: unknown): Tone {
  const s = String(value ?? '').trim()
  if (POSITIVE.test(s)) return 'good'
  if (NEGATIVE.test(s)) return 'bad'
  if (WARNING.test(s)) return 'warn'
  return 'plain'
}

const TONE_CLASS: Record<Tone, string> = {
  good: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  bad: 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300',
  warn: 'bg-amber-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-300',
  plain: 'bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300',
}

export function Badge({ children, tone }: { children: ReactNode; tone?: Tone }) {
  const t = tone ?? 'plain'
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ${TONE_CLASS[t]}`}
    >
      {children}
    </span>
  )
}

export function isDateish(v: unknown): boolean {
  if (v instanceof Date) return true
  if (typeof v !== 'string') return false
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(v)
}

export function toDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v === 'number') return new Date(v)
  if (typeof v === 'string') {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v)
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

export function isNumericLike(v: unknown): boolean {
  if (typeof v === 'number') return Number.isFinite(v)
  if (typeof v === 'string' && v.trim() !== '') return Number.isFinite(Number(v))
  return false
}

export function numberOf(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Rupees for money-shaped column names, a grouped number for other numbers,
 *  ISO-ish dates left to the caller (they need a timezone), text otherwise. */
export function cellText(key: string, v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (isNumericLike(v) && MONEY_COLUMN.test(key)) return formatINR(numberOf(v))
  if (typeof v === 'number') return v.toLocaleString('en-IN')
  if (typeof v === 'string') return v
  if (v instanceof Date) return v.toISOString()
  return JSON.stringify(v)
}

export function formatTotal(key: string, total: number): string {
  return MONEY_COLUMN.test(key) ? formatINR(total) : total.toLocaleString('en-IN')
}

/** "Showing 1–200" / "Showing 201–400". Honest, small, and always present when
 *  a result was cut down (§15: never ship a 5,000-row page). */
export function rangeLabel(page: number, pageSize: number, count: number, hasMore: boolean): string | null {
  if (page === 1 && !hasMore) return count === 1 ? '1 row' : `${count.toLocaleString('en-IN')} rows`
  const from = (page - 1) * pageSize + 1
  const to = from + count - 1
  return `Showing ${from.toLocaleString('en-IN')}–${to.toLocaleString('en-IN')}${hasMore ? '' : ' (the last of them)'}`
}

export function Pager({ token, page, hasMore }: { token: string; page: number; hasMore: boolean }) {
  if (page <= 1 && !hasMore) return null
  const link = 'rounded-lg border border-neutral-300 px-2.5 py-1 font-medium dark:border-neutral-700'
  return (
    <span className="inline-flex gap-2">
      {page > 1 ? (
        <a className={link} href={`/w/${token}?p=${page - 1}`}>
          Previous
        </a>
      ) : null}
      {hasMore ? (
        <a className={link} href={`/w/${token}?p=${page + 1}`}>
          Next
        </a>
      ) : null}
    </span>
  )
}

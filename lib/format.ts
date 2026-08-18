/**
 * lib/format.ts — how numbers, times and names reach a human (CONTRACTS §11).
 *
 * Pure. No database, no clock, no node builtins — the emulator and the web
 * surface render with these too, so this file has to be safe on the client.
 *
 * Everything user-facing is rendered in `academy.timezone`; the caller passes
 * it in rather than this file guessing.
 */

import { DateTime } from 'luxon'

export type TimeInput = Date | string | number | DateTime

const DEFAULT_ZONE = 'Asia/Kolkata'
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const CLOCK_ONLY = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/

function toDateTime(value: TimeInput, tz: string): DateTime {
  const zone = tz || DEFAULT_ZONE
  if (DateTime.isDateTime(value)) return value.setZone(zone)
  if (value instanceof Date) return DateTime.fromJSDate(value, { zone })
  if (typeof value === 'number') return DateTime.fromMillis(value, { zone })

  const raw = String(value).trim()

  // A `date` column: 'YYYY-MM-DD' is a calendar day in the academy's zone, not
  // UTC midnight. Reading it as UTC is how a Saturday class lands on Friday.
  if (ISO_DATE_ONLY.test(raw)) return DateTime.fromISO(raw, { zone })

  // A `time` column: 'HH:MM[:SS]' has no day. Anchor it to today so the
  // formatter has something to work with; only the clock part is ever read.
  const clock = CLOCK_ONLY.exec(raw)
  if (clock) {
    return DateTime.now().setZone(zone).set({
      hour: Number(clock[1]),
      minute: Number(clock[2]),
      second: clock[3] ? Number(clock[3]) : 0,
      millisecond: 0,
    })
  }

  return DateTime.fromISO(raw, { zone, setZone: false })
}

/**
 * ₹1,200 · ₹1,20,000 · ₹450.50 · -₹300
 * Indian grouping, and paise only when there are paise.
 */
export function formatINR(amount: number | string | null | undefined, opts: { paise?: boolean; sign?: boolean } = {}): string {
  const n = typeof amount === 'number' ? amount : Number(amount ?? 0)
  if (!Number.isFinite(n)) return '₹0'

  const rounded = Math.round(n * 100) / 100
  const showPaise = opts.paise ?? Math.round(rounded * 100) % 100 !== 0
  const digits = showPaise ? 2 : 0

  const body = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Math.abs(rounded))

  const sign = rounded < 0 ? '-' : opts.sign && rounded > 0 ? '+' : ''
  return `${sign}₹${body}`
}

/** 6:30 pm · 8 am — the idiom the spec writes in, minutes dropped when :00. */
export function formatTime(value: TimeInput, tz: string = DEFAULT_ZONE): string {
  return clockOf(toDateTime(value, tz))
}

function clockOf(dt: DateTime): string {
  if (!dt.isValid) return ''
  const meridiem = dt.hour < 12 ? 'am' : 'pm'
  return `${bareClock(dt)} ${meridiem}`
}

function bareClock(dt: DateTime): string {
  const hour12 = dt.hour % 12 === 0 ? 12 : dt.hour % 12
  return dt.minute === 0 ? `${hour12}` : `${hour12}:${String(dt.minute).padStart(2, '0')}`
}

/**
 * Sat 15 Aug · 15 Aug 2027 (year only when it is not the reference year)
 * `relativeTo` turns the next two days into "today" and "tomorrow" — pass the
 * clock's now, never `new Date()`.
 */
export function formatDate(
  value: TimeInput,
  tz: string = DEFAULT_ZONE,
  opts: { relativeTo?: TimeInput; weekday?: boolean; year?: boolean } = {},
): string {
  const dt = toDateTime(value, tz)
  if (!dt.isValid) return ''

  if (opts.relativeTo !== undefined) {
    const refDay = toDateTime(opts.relativeTo, tz).startOf('day')
    const days = dt.startOf('day').diff(refDay, 'days').days
    if (days === 0) return 'today'
    if (days === 1) return 'tomorrow'
    if (days === -1) return 'yesterday'
  }

  const showWeekday = opts.weekday ?? true
  const ref = opts.relativeTo === undefined ? undefined : toDateTime(opts.relativeTo, tz)
  const showYear = opts.year ?? (ref ? dt.year !== ref.year : false)

  const parts: string[] = []
  if (showWeekday) parts.push(dt.toFormat('ccc'))
  parts.push(`${dt.day} ${dt.toFormat('LLL')}`)
  if (showYear) parts.push(String(dt.year))
  return parts.join(' ')
}

/** The word alone, when the count is already in the sentence. */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return Math.abs(n) === 1 ? singular : pluralForm ?? `${singular}s`
}

// Three more renderers used to live here and none of them had a caller:
// `formatDateRange` (spans — the job handlers use `spanLabel` in lib/jobs/util.ts
// instead), `pluralise` (the count-plus-word form; `plural` above is the one that
// gets used, with the count already in the sentence), and `joinNames`, described as
// "§14.2's exact shape". That shape is real and does get produced — by
// `string_agg(full_name, ', ')` in SQL, on the query that has the names — so the
// TypeScript version was a second implementation waiting for a caller that never
// came. Left as a note rather than silently: if a caller ever does want them, they
// are one `git log -p` away, and it should be a deliberate choice to render names in
// two places rather than an accident.

/* ------------------------------------------------------------------------- *
 * The WhatsApp idiom
 *
 * There are two idioms in this product and they are not the same:
 *
 *   the UI idiom     `formatTime` above — "6:30 pm", "8 am". What the emulator,
 *                    the web screens and the spec's own prose write.
 *   the chat idiom   below — "6:30pm", "8am". What goes to a phone.
 *
 * **They both existed already; what was missing was that either knew about the
 * other.** `lib/agent/lint.ts` held a second, hand-rolled date/time formatter —
 * its own `MONTHS`, its own `WEEKDAYS`, its own day arithmetic — and one of the
 * things it rewrote on the way out was this file's output: `formatTime` writes
 * "6:30 pm", lint's pass turns it into "6:30pm". Correct in the end, and arrived
 * at by two files disagreeing rather than by anybody deciding.
 *
 * So both live here, named, and the conversion is one function rather than a
 * regex in another module. `lib/agent/context.ts` had a third copy of the month
 * and weekday tables for its prompt header; it uses these now too.
 *
 * These take strings rather than a `TimeInput` on purpose: their caller is a lint
 * pass working on text it has just matched with a regex, so what it holds is
 * already 'YYYY-MM-DD' and 'HH:MM', and re-parsing them into a zoned instant
 * would be inventing a day the string never carried.
 * ------------------------------------------------------------------------- */

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Whole days from one 'YYYY-MM-DD' to another. 0 when either is unparseable. */
export function dayDiff(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`)
  const b = Date.parse(`${toIso}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/** 0 = Sunday .. 6 = Saturday, matching `class_slot.weekday`. */
export function weekdayOf(isoDate: string): number {
  const t = Date.parse(`${isoDate}T00:00:00Z`)
  return Number.isNaN(t) ? 0 : new Date(t).getUTCDay()
}

/** "18:30" -> "6:30pm", "08:00" -> "8am". Tolerates a clock that already formats. */
export function compactTime(time: string | null): string {
  if (!time) return ''
  const t = time.trim()
  const m = t.match(/^(\d{1,2}):(\d{2})/)
  if (!m) return t.replace(/\s+/g, '').toLowerCase()
  if (/[ap]\.?m/i.test(t)) return t.replace(/\s+/g, '').toLowerCase()
  const h24 = Number(m[1])
  const min = m[2]
  const suffix = h24 < 12 ? 'am' : 'pm'
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return min === '00' ? `${h12}${suffix}` : `${h12}:${min}${suffix}`
}

/**
 * "today 6:30pm" · "tomorrow" · "Saturday 8am" · "17 Aug" · "17 Aug 2027".
 * Near days get their name; anything past a week gets its date.
 */
export function compactDate(date: string, time: string | null, todayDate: string): string {
  const t = compactTime(time)
  const diff = dayDiff(todayDate, date)
  const join = (label: string) => (t ? `${label} ${t}` : label)
  if (diff === 0) return join('today')
  if (diff === 1) return join('tomorrow')
  if (diff === -1) return join('yesterday')
  const [y, mo, d] = date.split('-')
  const weekday = WEEKDAY_NAMES[weekdayOf(date)]
  if (diff > 1 && diff <= 6) return join(weekday)
  if (diff < -1 && diff >= -6) return join(`last ${weekday}`)
  const sameYear = todayDate.slice(0, 4) === y
  const stamp = `${Number(d)} ${MONTHS_SHORT[Number(mo) - 1] ?? mo}${sameYear ? '' : ` ${y}`}`
  return join(stamp)
}

/** "Monday 17 Aug 2026" — the long form, for a prompt header rather than a message. */
export function longDate(isoDate: string): string {
  const bits = isoDate.split('-')
  if (bits.length !== 3) return isoDate
  const month = MONTHS_SHORT[Number(bits[1]) - 1] ?? ''
  return `${WEEKDAY_NAMES[weekdayOf(isoDate)] ?? ''} ${Number(bits[2])} ${month} ${bits[0]}`.trim()
}

/** 98765 43210 — how an Indian number is read aloud. Never used for matching. */
export function formatPhone(e164: string): string {
  const digits = String(e164 ?? '').replace(/[^0-9]/g, '')
  if (digits.length === 12 && digits.startsWith('91')) {
    const local = digits.slice(2)
    return `${local.slice(0, 5)} ${local.slice(5)}`
  }
  if (digits.length === 10) return `${digits.slice(0, 5)} ${digits.slice(5)}`
  return e164
}

/**
 * Is this a number a message could actually be sent to?
 *
 * `add_coach` and `add_client` validated `phone_e164` as `z.string().min(6)`, which is
 * not a phone rule — it is a length. Driven live, an admin typed *"arjun and vikram are
 * my coaches"* with no numbers anywhere in the conversation, and the model filled the
 * required field with `+910000000001` and `+910000000002`: sequential placeholders that
 * passed the schema, rode into a staged plan, and sat one tap away from becoming two
 * `contact` rows the product would then try to invite.
 *
 * A model that has not been given a number must be *refused*, not quietly believed. So
 * the rule lives here, in the one file both writers already reach for, rather than being
 * spelled out twice and drifting (R5's lesson, applied before it fires).
 *
 * What it costs: a real number typed in a format this does not recognise is now rejected
 * where it used to be accepted. That is the intended trade — the failure is loud, lands
 * on the model mid-plan, and says what to do about it.
 */
export function dialablePhone(raw: unknown): { ok: true; phone: string } | { ok: false; why: string } {
  const s = String(raw ?? '').trim()
  const digits = s.replace(/[^0-9]/g, '')
  if (!digits) return { ok: false, why: 'no digits in it at all' }
  // E.164: up to 15 digits, and a country code never starts at zero.
  if (digits.length < 8 || digits.length > 15) {
    return { ok: false, why: `${digits.length} digits — a real number is 8 to 15` }
  }
  if (digits.startsWith('0')) return { ok: false, why: 'starts with 0, so it carries no country code' }

  // Placeholders are the actual failure mode, and they are recognisable: one repeated
  // digit, or a straight run up or down. `+910000000001` is the run this was written for.
  const local = digits.startsWith('91') && digits.length === 12 ? digits.slice(2) : digits
  if (/^(\d)\1+$/.test(local)) return { ok: false, why: 'every digit is the same' }
  const isRun = (d: string, step: number): boolean =>
    [...d].every((ch, i) => i === 0 || Number(ch) === (Number(d[i - 1]) + step + 10) % 10)
  if (local.length >= 6 && (isRun(local, 1) || isRun(local, -1))) {
    return { ok: false, why: 'the digits just count up or down' }
  }
  // A leading run of zeros is the shape a made-up number takes when the model pads to
  // the right length: 0000000001, 0000012345.
  if (/^0{4,}/.test(local)) return { ok: false, why: 'it is mostly leading zeros' }

  // India is the only market this product serves today (§1), and its mobiles are ten
  // digits opening 6–9. Anything else on +91 is not reachable on WhatsApp.
  if (digits.startsWith('91')) {
    const mobile = digits.slice(2)
    if (mobile.length !== 10) {
      return { ok: false, why: `+91 numbers are 10 digits, this has ${mobile.length}` }
    }
    if (!/^[6-9]/.test(mobile)) {
      return { ok: false, why: 'an Indian mobile starts with 6, 7, 8 or 9' }
    }
  }
  return { ok: true, phone: `+${digits}` }
}

/**
 * lib/clock.ts — domain time (CONTRACTS §3, spec §17).
 *
 * One shared clock across every pane, advanced on demand, backed by
 * `sim_clock.offset_ms`. Nothing in this product reads `Date.now()` for domain
 * time and nothing in SQL compares against `now()` — the SQL-side equivalent is
 * `app.now()`. A scheduler you cannot turn is a scheduler you cannot test, and
 * ~70% of this product is proactive.
 *
 * The offset is memoised for 250 ms: long enough that a turn does not pay for a
 * round trip per timestamp, short enough that a clock advanced in one pane is
 * visible in the next one immediately.
 */

import { DateTime } from 'luxon'

import { unsafeQuery, withSession, type SessionCtx, type Tx } from '@/lib/db'
import { formatDate, formatTime } from '@/lib/format'

/** sim_clock is global (no academy_id) — one world, one clock. */
const CLOCK_CTX: SessionCtx = { role: 'service', academyId: '' }
const MEMO_MS = 250

type ClockRow = { offset_ms: number; frozen_at: Date | null }

let offsetMs = 0
let frozenAt: Date | null = null
let loadedAtMs = 0

function apply(rows: ClockRow[]): void {
  const row = rows[0]
  if (row) {
    offsetMs = Number(row.offset_ms ?? 0)
    frozenAt = row.frozen_at ? new Date(row.frozen_at) : null
  }
  loadedAtMs = Date.now()
}

async function readClock(tx: Tx): Promise<ClockRow[]> {
  const existing = await unsafeQuery<ClockRow>(tx, 'select offset_ms, frozen_at from sim_clock limit 1')
  if (existing.length > 0) return existing

  const inserted = await unsafeQuery<ClockRow>(
    tx,
    `insert into sim_clock (singleton, offset_ms) values (true, 0)
     on conflict (singleton) do nothing
     returning offset_ms, frozen_at`,
  )
  if (inserted.length > 0) return inserted

  return unsafeQuery<ClockRow>(tx, 'select offset_ms, frozen_at from sim_clock limit 1')
}

/** Synchronous read of the last-loaded offset. Refreshed by now() / refresh(). */
export function nowSync(): Date {
  if (frozenAt) return new Date(frozenAt.getTime())
  return new Date(Date.now() + offsetMs)
}

/**
 * Domain now. Re-reads the offset when the memo is stale.
 *
 * A failed read keeps the last known offset rather than throwing: the clock is
 * read on every proactive path, and a transient database blip should surface
 * where the real work fails, not as a wall of clock errors.
 */
export async function now(): Promise<Date> {
  if (Date.now() - loadedAtMs >= MEMO_MS) {
    try {
      return await refresh()
    } catch {
      loadedAtMs = Date.now()
    }
  }
  return nowSync()
}

export async function refresh(): Promise<Date> {
  const rows = await withSession(CLOCK_CTX, (tx) => readClock(tx))
  apply(rows)
  return nowSync()
}

/** Move the whole world forward (or back). The emulator's main control. */
export async function advance(ms: number): Promise<Date> {
  const delta = Math.round(Number(ms) || 0)
  const rows = await withSession(CLOCK_CTX, async (tx) => {
    await readClock(tx)
    return unsafeQuery<ClockRow>(
      tx,
      `update sim_clock
          set offset_ms = offset_ms + $1::bigint,
              frozen_at = case when frozen_at is null
                               then null
                               else frozen_at + make_interval(secs => $1::bigint / 1000.0) end
        where singleton
        returning offset_ms, frozen_at`,
      [delta],
    )
  })
  apply(rows)
  return nowSync()
}

/** Jump to a wall-clock instant. Time keeps running from there. */
export async function setTo(when: Date): Promise<Date> {
  const target = when instanceof Date ? when : new Date(when)
  const delta = target.getTime() - Date.now()
  const rows = await withSession(CLOCK_CTX, async (tx) => {
    await readClock(tx)
    return unsafeQuery<ClockRow>(
      tx,
      'update sim_clock set offset_ms = $1::bigint, frozen_at = null where singleton returning offset_ms, frozen_at',
      [delta],
    )
  })
  apply(rows)
  return nowSync()
}

/** Back to real time. */
export async function reset(): Promise<Date> {
  const rows = await withSession(CLOCK_CTX, async (tx) => {
    await readClock(tx)
    return unsafeQuery<ClockRow>(
      tx,
      'update sim_clock set offset_ms = 0, frozen_at = null where singleton returning offset_ms, frozen_at',
      [],
    )
  })
  apply(rows)
  return nowSync()
}

/**
 * The next moment the scheduler would do something, anywhere: the earliest
 * pending job, or the earliest session's T-60 (the first prompt code raises
 * before a session, §13). Powers the emulator's "jump to next event".
 */
export async function nextEventAt(): Promise<Date | null> {
  const after = await now()
  const rows = await withSession(CLOCK_CTX, (tx) =>
    unsafeQuery<{ next_at: Date | null }>(tx, 'select app.next_event_at($1::timestamptz) as next_at', [after]),
  )
  const next = rows[0]?.next_at
  return next ? new Date(next) : null
}

/**
 * The same instant as the academy sees it.
 *
 * `weekday` is 0 = Sunday .. 6 = Saturday, matching `class_slot.weekday` — not
 * luxon's 1 = Monday, which is a bug waiting to happen at the boundary.
 */
export function inZone(d: Date, tz: string): { date: string; time: string; label: string; weekday: number } {
  const zone = tz || 'Asia/Kolkata'
  const dt = DateTime.fromJSDate(d instanceof Date ? d : new Date(d), { zone })

  return {
    date: dt.toFormat('yyyy-LL-dd'),
    time: dt.toFormat('HH:mm'),
    label: `${formatDate(d, zone)}, ${formatTime(d, zone)}`,
    weekday: dt.weekday % 7,
  }
}

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

const CLOCK_CTX: SessionCtx = { role: 'service', academyId: '' }
const MEMO_MS = 250

type ClockRow = { offset_ms: number; frozen_at: Date | null }

/**
 * One memo per clock, not one for the world.
 *
 * 0024 gave `sim_clock` a nullable `academy_id`: null is the world clock and the
 * fallback for every tenant without one. A single process-wide `offsetMs` cannot
 * represent that — hold one academy four hours ahead and every other academy in
 * the same process would read its offset.
 *
 * Keyed by academy id, with `''` meaning the world clock. A tenant with no row
 * of its own resolves to the world offset on read, so the common case is still
 * one entry.
 */
type Memo = { offsetMs: number; frozenAt: Date | null; loadedAtMs: number }
const memos = new Map<string, Memo>()

function memoFor(key: string): Memo {
  let m = memos.get(key)
  if (!m) {
    m = { offsetMs: 0, frozenAt: null, loadedAtMs: 0 }
    memos.set(key, m)
  }
  return m
}

function apply(key: string, rows: ClockRow[]): void {
  const m = memoFor(key)
  const row = rows[0]
  // An absent row is a real answer — this tenant has no clock, so it is on the
  // world's. Resetting to zero here rather than keeping the last value is what
  // makes `drive clock --reset` on a tenant actually return it to the default.
  m.offsetMs = row ? Number(row.offset_ms ?? 0) : 0
  m.frozenAt = row?.frozen_at ? new Date(row.frozen_at) : null
  m.loadedAtMs = Date.now()
}

/**
 * Read the offset that applies to `academyId`: its own row if it has one, else
 * the world's. The fallback is done here rather than with `coalesce` in SQL so
 * that `frozen_at` travels with whichever row actually won.
 */
async function readClock(tx: Tx, academyId: string): Promise<ClockRow[]> {
  if (academyId) {
    const own = await unsafeQuery<ClockRow>(
      tx,
      'select offset_ms, frozen_at from sim_clock where academy_id = $1::uuid',
      [academyId],
    )
    if (own.length > 0) return own
  }

  const existing = await unsafeQuery<ClockRow>(
    tx, 'select offset_ms, frozen_at from sim_clock where academy_id is null')
  if (existing.length > 0) return existing

  const inserted = await unsafeQuery<ClockRow>(
    tx,
    `insert into sim_clock (singleton, offset_ms, academy_id) values (true, 0, null)
     on conflict do nothing
     returning offset_ms, frozen_at`,
  )
  if (inserted.length > 0) return inserted

  return unsafeQuery<ClockRow>(
    tx, 'select offset_ms, frozen_at from sim_clock where academy_id is null')
}

/**
 * Synchronous read of the last-loaded offset. Refreshed by now() / refresh().
 *
 * Defaults to the world clock, which is correct for every caller that has no
 * academy in hand — and there are many, because `now()` has never taken one.
 * **This is the honest edge of 0024**: SQL resolves the tenant clock from the
 * session GUC automatically and always correctly, while a TypeScript caller
 * that does not pass an academy gets the world clock. With no per-tenant rows
 * set the two agree exactly; they diverge only for a tenant somebody has
 * deliberately moved, and then only in code paths that compute a timestamp in
 * TypeScript instead of in SQL.
 */
export function nowSync(academyId = ''): Date {
  const m = memos.get(academyId) ?? memos.get('')
  if (!m) return new Date()
  if (m.frozenAt) return new Date(m.frozenAt.getTime())
  return new Date(Date.now() + m.offsetMs)
}

/**
 * Domain now. Re-reads the offset when the memo is stale.
 *
 * A failed read keeps the last known offset rather than throwing: the clock is
 * read on every proactive path, and a transient database blip should surface
 * where the real work fails, not as a wall of clock errors.
 */
export async function now(academyId = ''): Promise<Date> {
  const m = memoFor(academyId)
  if (Date.now() - m.loadedAtMs >= MEMO_MS) {
    try {
      return await refresh(academyId)
    } catch {
      m.loadedAtMs = Date.now()
    }
  }
  return nowSync(academyId)
}

export async function refresh(academyId = ''): Promise<Date> {
  const rows = await withSession(CLOCK_CTX, (tx) => readClock(tx, academyId))
  apply(academyId, rows)
  return nowSync(academyId)
}

/**
 * Which row a write targets: a tenant's own, or the world's.
 *
 * Written as a predicate rather than two near-identical statements because the
 * three mutators below differ only in what they set, and a rule spelled out
 * three times is a rule that will be right twice.
 */
function clockWhere(academyId: string): { sql: string; params: unknown[] } {
  return academyId
    ? { sql: 'academy_id = $2::uuid', params: [academyId] }
    : { sql: 'academy_id is null', params: [] }
}

/**
 * Ensure the tenant has a row of its own before a write targets it.
 *
 * Without this, advancing one academy's clock for the first time updates nothing
 * — `where academy_id = $1` matches no row — and returns silently, which is R7:
 * the driver would print a new time it had not set. It seeds from the world
 * offset so "two hours ahead" means two hours ahead of where the tenant already
 * was, not two hours ahead of real time.
 */
async function ensureRow(tx: Tx, academyId: string): Promise<void> {
  if (!academyId) return
  await unsafeQuery(
    tx,
    `insert into sim_clock (singleton, academy_id, offset_ms, frozen_at)
     select true, $1::uuid,
            coalesce((select offset_ms from sim_clock where academy_id is null), 0),
            (select frozen_at from sim_clock where academy_id is null)
      where not exists (select 1 from sim_clock where academy_id = $1::uuid)`,
    [academyId],
  )
}

/** Move a world forward (or back). The emulator's main control. */
export async function advance(ms: number, academyId = ''): Promise<Date> {
  const delta = Math.round(Number(ms) || 0)
  const w = clockWhere(academyId)
  const rows = await withSession(CLOCK_CTX, async (tx) => {
    await readClock(tx, academyId)
    await ensureRow(tx, academyId)
    return unsafeQuery<ClockRow>(
      tx,
      `update sim_clock
          set offset_ms = offset_ms + $1::bigint,
              frozen_at = case when frozen_at is null
                               then null
                               else frozen_at + make_interval(secs => $1::bigint / 1000.0) end
        where ${w.sql}
        returning offset_ms, frozen_at`,
      [delta, ...w.params],
    )
  })
  apply(academyId, rows)
  return nowSync(academyId)
}

/** Jump to a wall-clock instant. Time keeps running from there. */
export async function setTo(when: Date, academyId = ''): Promise<Date> {
  const target = when instanceof Date ? when : new Date(when)
  const delta = target.getTime() - Date.now()
  const w = clockWhere(academyId)
  const rows = await withSession(CLOCK_CTX, async (tx) => {
    await readClock(tx, academyId)
    await ensureRow(tx, academyId)
    return unsafeQuery<ClockRow>(
      tx,
      `update sim_clock set offset_ms = $1::bigint, frozen_at = null
        where ${w.sql} returning offset_ms, frozen_at`,
      [delta, ...w.params],
    )
  })
  apply(academyId, rows)
  return nowSync(academyId)
}

/**
 * Back to real time.
 *
 * For a tenant this DELETES its row rather than zeroing it, so the tenant goes
 * back to following the world clock instead of being pinned to real time while
 * the world is somewhere else. "Reset" means "stop having a clock of my own".
 */
export async function reset(academyId = ''): Promise<Date> {
  const rows = await withSession(CLOCK_CTX, async (tx) => {
    if (academyId) {
      await unsafeQuery(tx, 'delete from sim_clock where academy_id = $1::uuid', [academyId])
      return readClock(tx, academyId)
    }
    await readClock(tx, '')
    return unsafeQuery<ClockRow>(
      tx,
      `update sim_clock set offset_ms = 0, frozen_at = null
        where academy_id is null returning offset_ms, frozen_at`,
      [],
    )
  })
  apply(academyId, rows)
  return nowSync(academyId)
}

/**
 * The next moment the scheduler would do something, anywhere: the earliest
 * pending job, or the earliest session's T-60 (the first prompt code raises
 * before a session, §13). Powers the emulator's "jump to next event".
 */
export async function nextEventAt(academyId = ''): Promise<Date | null> {
  const after = await now(academyId)
  const rows = await withSession(CLOCK_CTX, (tx) =>
    unsafeQuery<{ next_at: Date | null }>(
      tx,
      'select app.next_event_at($1::timestamptz, $2::uuid) as next_at',
      [after, academyId || null],
    ),
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
/**
 * Is this instant inside the academy's night?
 *
 * **The one predicate, here rather than in the jobs layer, because the send path
 * needs it and cannot reach that far.** `lib/jobs/util.ts` had the only copy, and
 * `lib/jobs/runner.ts` said outright *"There are no quiet hours (§13)"* — which
 * was true of the send path and false of the planner, so the product both had
 * them and did not. Going live at 2am fired three reminder templates at 02:02,
 * from three different handlers, none of which was wrong about anything except
 * the hour. ARCHITECTURE.md's layer 4 is explicit: no job composes around it, the
 * send layer enforces it.
 *
 * The pair lives in `academy.settings` (`quiet_start` / `quiet_end`, 'HH:MM'),
 * defaulted rather than written into every row: 21:00–07:00 is a sane household
 * window, and an academy that wants dawn sends can say so.
 */
export function quietWindow(settings: Record<string, unknown> | null): { start: string; end: string } {
  const read = (k: string, fallback: string): string => {
    const v = settings?.[k]
    return typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : fallback
  }
  return { start: read('quiet_start', '21:00'), end: read('quiet_end', '07:00') }
}

export function isQuietHour(at: Date, tz: string, settings: Record<string, unknown> | null): boolean {
  const { start, end } = quietWindow(settings)
  const hm = DateTime.fromJSDate(at, { zone: tz || 'Asia/Kolkata' }).toFormat('HH:mm')
  // The window normally wraps midnight; an academy that sets 13:00–15:00 gets the
  // straight reading, which is the same expression without the wrap.
  return start > end ? hm >= start || hm < end : hm >= start && hm < end
}

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

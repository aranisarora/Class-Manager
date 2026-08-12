/**
 * components/view/calendar.tsx — the week, the month (§15).
 *
 * A phone-shaped agenda rather than a grid: days as headings, sessions under
 * them. A month grid on a 360px screen is unreadable, and the question behind
 * "show me the week" is always "what is on, and when".
 */

import { inZone } from '@/lib/clock'
import { ALIASES, pickKey } from '@/lib/web/registry'
import type { ComponentSpec } from '@/lib/web/registry'
import type { ResolvedComponent } from '@/lib/web/views'
import {
  Badge,
  Card,
  Empty,
  ErrorLine,
  MUTED,
  Pager,
  rangeLabel,
  toDate,
  toneOf,
} from '@/components/view/chrome'

export function CalendarView({ c, tz, token }: { c: ResolvedComponent; tz: string; token: string }) {
  const spec = c.spec as Extract<ComponentSpec, { type: 'calendar' }>
  const whenKey = pickKey(c.columns, ALIASES.when)
  const titleKey = pickKey(c.columns, ALIASES.title)
  const endKey = pickKey(c.columns, ALIASES.end)
  const subKey = pickKey(
    c.columns.filter((k) => k !== titleKey && k !== whenKey && k !== endKey),
    ALIASES.subtitle,
  )
  const statusKey = pickKey(c.columns, ALIASES.status)

  type Row = { key: string; time: string; title: string; sub?: string; status?: string }
  const days = new Map<string, { label: string; rows: Row[] }>()

  for (const [i, row] of c.rows.entries()) {
    const d = whenKey ? toDate(row[whenKey]) : null
    const z = d ? inZone(d, tz) : null
    const bucket = z ? z.date : 'Undated'
    const label = z ? z.label : 'Undated'
    if (!days.has(bucket)) days.set(bucket, { label, rows: [] })

    const endD = endKey ? toDate(row[endKey]) : null
    const endZ = endD ? inZone(endD, tz) : null
    const time = z ? (endZ ? `${z.time} – ${endZ.time}` : z.time) : '—'

    days.get(bucket)!.rows.push({
      key: `${bucket}-${i}`,
      time,
      title: titleKey ? String(row[titleKey] ?? 'Session') : 'Session',
      sub: subKey && row[subKey] != null ? String(row[subKey]) : undefined,
      status: statusKey && row[statusKey] != null ? String(row[statusKey]) : undefined,
    })
  }

  const range = rangeLabel(c.page, c.pageSize, c.rows.length, c.hasMore)

  return (
    <Card
      title={spec.title}
      note={c.note}
      footer={
        range ? (
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{range}</span>
            <Pager token={token} page={c.page} hasMore={c.hasMore} />
          </span>
        ) : undefined
      }
    >
      {c.error ? <ErrorLine message={c.error} /> : null}
      {!c.error && c.rows.length === 0 ? <Empty what="Nothing scheduled." /> : null}
      {!c.error && days.size > 0 ? (
        <div className="space-y-4">
          {[...days.entries()].map(([bucket, day]) => (
            <div key={bucket}>
              <h3 className={`text-[11px] font-medium uppercase tracking-[0.12em] ${MUTED}`}>{day.label}</h3>
              <ul className="mt-1.5 space-y-1.5">
                {day.rows.map((r) => {
                  const cancelled = /cancel/i.test(r.status ?? '')
                  return (
                    <li
                      key={r.key}
                      className="flex items-baseline gap-3 rounded-xl bg-neutral-50 px-3 py-2 dark:bg-neutral-800/50"
                    >
                      <span className="w-24 shrink-0 text-xs font-medium tabular-nums">{r.time}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-sm ${cancelled ? 'line-through opacity-60' : ''}`}>
                          {r.title}
                        </span>
                        {r.sub ? <span className={`block truncate text-xs ${MUTED}`}>{r.sub}</span> : null}
                      </span>
                      {r.status ? <Badge tone={toneOf(r.status)}>{r.status}</Badge> : null}
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </Card>
  )
}

export default CalendarView

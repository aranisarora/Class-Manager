/**
 * components/view/timeline.tsx — a day, a player's history (§15).
 *
 * Ordered events on a rail. Rows render in the order the query returned them —
 * ordering is the query's job, not the renderer's, or the same view answers two
 * different questions depending on who wrote the SQL.
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
  cellText,
  rangeLabel,
  toDate,
  toneOf,
} from '@/components/view/chrome'

export function TimelineView({ c, tz, token }: { c: ResolvedComponent; tz: string; token: string }) {
  const spec = c.spec as Extract<ComponentSpec, { type: 'timeline' }>
  const whenKey = pickKey(c.columns, ALIASES.when)
  const titleKey = pickKey(c.columns, ALIASES.title)
  const statusKey = pickKey(c.columns, ALIASES.status)
  const detailKey = pickKey(
    c.columns.filter((k) => k !== whenKey && k !== titleKey && k !== statusKey),
    ['detail', 'details', 'note', 'notes', 'subtitle', 'by', 'who', 'amount'],
  )

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
      {!c.error && c.rows.length === 0 ? <Empty what="Nothing has happened yet." /> : null}
      {!c.error && c.rows.length > 0 ? (
        <ol className="relative ml-1 space-y-3 border-l border-neutral-200 pl-4 dark:border-neutral-800">
          {c.rows.map((row, i) => {
            const d = whenKey ? toDate(row[whenKey]) : null
            const z = d ? inZone(d, tz) : null
            const stamp = z ? `${z.label}` : whenKey ? cellText(whenKey, row[whenKey]) : ''
            return (
              <li key={i} className="relative">
                <span className="absolute -left-[21px] top-1.5 size-2 rounded-full bg-neutral-300 dark:bg-neutral-600" />
                <div className="flex items-baseline justify-between gap-3">
                  <p className={`text-[11px] uppercase tracking-wide ${MUTED}`}>{stamp}</p>
                  {statusKey && row[statusKey] != null ? (
                    <Badge tone={toneOf(row[statusKey])}>{String(row[statusKey])}</Badge>
                  ) : null}
                </div>
                <p className="text-sm font-medium">{titleKey ? String(row[titleKey] ?? '—') : '—'}</p>
                {detailKey && row[detailKey] != null ? (
                  <p className={`text-xs ${MUTED}`}>{cellText(detailKey, row[detailKey])}</p>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : null}
    </Card>
  )
}

export default TimelineView

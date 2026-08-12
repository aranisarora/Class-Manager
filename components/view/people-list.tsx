/**
 * components/view/people-list.tsx — rosters, unpaid families, coach lists (§15).
 *
 * A name, a status badge, one line of detail, and a money column on the right
 * when there is one. Dense enough that a 30-name roster is one scroll.
 */

import { ALIASES, MONEY_COLUMN, pickKey } from '@/lib/web/registry'
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
  toneOf,
} from '@/components/view/chrome'

export function PeopleListView({ c, token }: { c: ResolvedComponent; tz: string; token: string }) {
  const spec = c.spec as Extract<ComponentSpec, { type: 'people-list' }>
  const nameKey = pickKey(c.columns, ALIASES.person)
  const statusKey = pickKey(c.columns, ALIASES.status)
  const moneyKey = c.columns.find((k) => k !== nameKey && MONEY_COLUMN.test(k)) ?? null
  const detailKey = pickKey(
    c.columns.filter((k) => k !== nameKey && k !== statusKey && k !== moneyKey),
    ['detail', 'details', 'subtitle', 'note', 'notes', 'class', 'class_name', 'phone', 'phone_e164', 'venue'],
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
      {!c.error && c.rows.length === 0 ? <Empty what="Nobody here." /> : null}
      {!c.error && c.rows.length > 0 ? (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
          {c.rows.map((row, i) => (
            <li key={i} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">
                  {nameKey ? String(row[nameKey] ?? '—') : '—'}
                </span>
                {detailKey && row[detailKey] != null ? (
                  <span className={`block truncate text-xs ${MUTED}`}>{cellText(detailKey, row[detailKey])}</span>
                ) : null}
              </span>
              {moneyKey && row[moneyKey] != null ? (
                <span className="shrink-0 text-sm font-medium tabular-nums">{cellText(moneyKey, row[moneyKey])}</span>
              ) : null}
              {statusKey && row[statusKey] != null ? (
                <Badge tone={toneOf(row[statusKey])}>{String(row[statusKey])}</Badge>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  )
}

export default PeopleListView

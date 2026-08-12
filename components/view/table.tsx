/**
 * components/view/table.tsx — the universal fallback (§15).
 *
 * Every other component degrades to this one, so it must render any tabular
 * result without complaint: unknown columns, empty results, numbers, money,
 * timestamps, nulls.
 */

import { inZone } from '@/lib/clock'
import type { ResolvedComponent } from '@/lib/web/views'
import type { ColumnDef, ComponentSpec } from '@/lib/web/registry'
import { MONEY_COLUMN } from '@/lib/web/registry'
import {
  Card,
  Empty,
  ErrorLine,
  MUTED,
  Pager,
  cellText,
  formatTotal,
  isNumericLike,
  numberOf,
  rangeLabel,
} from '@/components/view/chrome'

function humanise(key: string): string {
  return key
    .replace(/_id$/, '')
    .replace(/_/g, ' ')
    .replace(/^./, (m) => m.toUpperCase())
}

function resolveColumns(c: ResolvedComponent): ColumnDef[] {
  const declared = (c.spec as Extract<ComponentSpec, { type: 'table' }>).columns
  const present = c.columns
  if (declared && declared.length) {
    const kept = declared.filter((d) => present.includes(d.key))
    if (kept.length) return kept
  }
  return present.map((key) => ({ key, label: humanise(key) }))
}

export function TableView({ c, tz, token }: { c: ResolvedComponent; tz: string; token: string }) {
  const spec = c.spec as Extract<ComponentSpec, { type: 'table' }>
  const columns = resolveColumns(c)
  const totals = (spec.totals ?? []).filter((k) => columns.some((col) => col.key === k))

  const alignOf = (col: ColumnDef): string => {
    if (col.align) return col.align === 'right' ? 'text-right' : 'text-left'
    const sample = c.rows.find((r) => r[col.key] !== null && r[col.key] !== undefined)?.[col.key]
    return isNumericLike(sample) ? 'text-right' : 'text-left'
  }

  const render = (key: string, value: unknown) => {
    const d = value instanceof Date ? value : null
    if (d) {
      const z = inZone(d, tz)
      return `${z.label}`
    }
    return cellText(key, value)
  }

  const range = rangeLabel(c.page, c.pageSize, c.rows.length, c.hasMore)

  return (
    <Card
      title={spec.title}
      note={c.note}
      footer={
        range || c.hasMore || c.page > 1 ? (
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span>{range}</span>
            <Pager token={token} page={c.page} hasMore={c.hasMore} />
          </span>
        ) : undefined
      }
    >
      {c.error ? <ErrorLine message={c.error} /> : null}
      {!c.error && c.rows.length === 0 ? <Empty what="Nothing to show yet." /> : null}
      {!c.error && c.rows.length > 0 ? (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-neutral-200 dark:border-neutral-800">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    scope="col"
                    className={`px-1.5 py-2 text-[11px] font-medium uppercase tracking-wide ${MUTED} ${alignOf(col)}`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {c.rows.map((row, i) => (
                <tr key={i} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800/60">
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-1.5 py-2 align-top tabular-nums ${alignOf(col)} ${
                        MONEY_COLUMN.test(col.key) ? 'font-medium' : ''
                      }`}
                    >
                      {render(col.key, row[col.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {totals.length ? (
              <tfoot>
                <tr className="border-t-2 border-neutral-300 dark:border-neutral-700">
                  {columns.map((col, idx) => {
                    if (!totals.includes(col.key)) {
                      return (
                        <td key={col.key} className={`px-1.5 py-2 text-xs font-medium ${MUTED}`}>
                          {idx === 0 ? 'Total' : ''}
                        </td>
                      )
                    }
                    const sum = c.rows.reduce((acc, r) => acc + numberOf(r[col.key]), 0)
                    return (
                      <td key={col.key} className={`px-1.5 py-2 text-right text-sm font-semibold tabular-nums`}>
                        {formatTotal(col.key, sum)}
                      </td>
                    )
                  })}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      ) : null}
      {c.hasMore ? (
        <p className={`mt-3 text-xs ${MUTED}`}>
          There&rsquo;s more than fits on one page. Ask in the chat for a narrower slice and it&rsquo;ll fit.
        </p>
      ) : null}
    </Card>
  )
}

export default TableView

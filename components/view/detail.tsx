/**
 * components/view/detail.tsx — one entity's fields (§15).
 *
 * Two shapes, both accepted, because a model writes both:
 *   - one row, many columns  -> each column is a label/value pair
 *   - many rows of (label, value) -> the pairs are already the rows
 */

import { inZone } from '@/lib/clock'
import { pickKey } from '@/lib/web/registry'
import type { ComponentSpec } from '@/lib/web/registry'
import type { ResolvedComponent } from '@/lib/web/views'
import { Badge, Card, Empty, ErrorLine, MUTED, cellText, toneOf } from '@/components/view/chrome'

function humanise(key: string): string {
  return key
    .replace(/_id$/, '')
    .replace(/_/g, ' ')
    .replace(/^./, (m) => m.toUpperCase())
}

export function DetailView({ c, tz }: { c: ResolvedComponent; tz: string }) {
  const spec = c.spec as Extract<ComponentSpec, { type: 'detail' }>

  const labelKey = pickKey(c.columns, ['label', 'field', 'key', 'name'])
  const valueKey = pickKey(c.columns, ['value', 'val'])
  const pairShaped = c.columns.length === 2 && labelKey && valueKey && c.rows.length > 1

  const pairs: { label: string; key: string; value: unknown }[] = pairShaped
    ? c.rows.map((r) => ({
        label: String(r[labelKey!] ?? ''),
        key: String(r[labelKey!] ?? ''),
        value: r[valueKey!],
      }))
    : c.rows.length
      ? c.columns
          .filter((k) => !/^id$/.test(k))
          .map((k) => ({ label: humanise(k), key: k, value: c.rows[0]![k] }))
      : []

  const render = (key: string, value: unknown) => {
    if (value instanceof Date) return inZone(value, tz).label
    return cellText(key, value)
  }

  return (
    <Card title={spec.title} note={c.note}>
      {c.error ? <ErrorLine message={c.error} /> : null}
      {!c.error && pairs.length === 0 ? <Empty what="Nothing to show." /> : null}
      {!c.error && pairs.length > 0 ? (
        <dl className="divide-y divide-neutral-100 dark:divide-neutral-800/60">
          {pairs.map((p, i) => {
            const tone = toneOf(p.value)
            return (
              <div key={`${p.key}-${i}`} className="flex items-baseline gap-4 py-2 first:pt-0 last:pb-0">
                <dt className={`w-2/5 shrink-0 text-xs ${MUTED}`}>{p.label}</dt>
                <dd className="min-w-0 flex-1 text-sm">
                  {tone === 'plain' ? (
                    <span className="break-words">{render(p.key, p.value)}</span>
                  ) : (
                    <Badge tone={tone}>{render(p.key, p.value)}</Badge>
                  )}
                </dd>
              </div>
            )
          })}
        </dl>
      ) : null}
    </Card>
  )
}

export default DetailView

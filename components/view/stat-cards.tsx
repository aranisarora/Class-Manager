/**
 * components/view/stat-cards.tsx — collections, attendance rate, headcount (§15).
 *
 * Label, value, an optional delta and an optional caption. Two across on a
 * phone; the value is the thing you can read from arm's length.
 */

import { pickKey } from '@/lib/web/registry'
import type { ComponentSpec } from '@/lib/web/registry'
import type { ResolvedComponent } from '@/lib/web/views'
import { CARD, Empty, ErrorLine, MUTED, cellText, isNumericLike, numberOf } from '@/components/view/chrome'

export function StatCardsView({ c }: { c: ResolvedComponent; tz: string }) {
  const spec = c.spec as Extract<ComponentSpec, { type: 'stat-cards' }>
  const labelKey = pickKey(c.columns, ['label', 'metric', 'name', 'title', 'key'])
  const valueKey = pickKey(c.columns, ['value', 'amount', 'total', 'count', 'n'])
  const deltaKey = pickKey(c.columns, ['delta', 'change', 'diff', 'vs_last'])
  const hintKey = pickKey(
    c.columns.filter((k) => k !== labelKey && k !== valueKey && k !== deltaKey),
    ['hint', 'sub', 'caption', 'help', 'note', 'period'],
  )

  if (c.error) {
    return (
      <section className={`${CARD} px-4 py-3`}>
        <ErrorLine message={c.error} />
      </section>
    )
  }
  if (!c.rows.length) {
    return (
      <section className={`${CARD} px-4 py-3`}>
        {spec.title ? <h2 className="text-sm font-semibold tracking-tight">{spec.title}</h2> : null}
        <Empty what="Nothing measured yet." />
      </section>
    )
  }

  return (
    <section>
      {spec.title ? <h2 className="mb-2 px-1 text-sm font-semibold tracking-tight">{spec.title}</h2> : null}
      {c.note ? <p className={`mb-2 px-1 text-xs ${MUTED}`}>{c.note}</p> : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {c.rows.map((row, i) => {
          const delta = deltaKey ? row[deltaKey] : null
          const deltaNum = isNumericLike(delta) ? numberOf(delta) : null
          const tone =
            deltaNum === null
              ? 'text-neutral-500 dark:text-neutral-400'
              : deltaNum > 0
                ? 'text-emerald-600 dark:text-emerald-400'
                : deltaNum < 0
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-neutral-500 dark:text-neutral-400'
          return (
            <div key={i} className={`${CARD} px-3 py-3`}>
              <p className={`truncate text-[11px] font-medium uppercase tracking-[0.1em] ${MUTED}`}>
                {labelKey ? String(row[labelKey] ?? '') : ''}
              </p>
              <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight">
                {valueKey ? cellText(valueKey, row[valueKey]) : '—'}
              </p>
              {delta !== null && delta !== undefined && delta !== '' ? (
                <p className={`mt-0.5 text-xs font-medium tabular-nums ${tone}`}>
                  {deltaNum !== null ? (
                    <>
                      <span aria-hidden>{deltaNum > 0 ? '▲' : deltaNum < 0 ? '▼' : '—'}</span>{' '}
                      {Math.abs(deltaNum).toLocaleString('en-IN')}
                    </>
                  ) : (
                    String(delta)
                  )}
                </p>
              ) : null}
              {hintKey && row[hintKey] != null ? (
                <p className={`mt-1 truncate text-xs ${MUTED}`}>{cellText(hintKey, row[hintKey])}</p>
              ) : null}
            </div>
          )
        })}
      </div>
    </section>
  )
}

export default StatCardsView

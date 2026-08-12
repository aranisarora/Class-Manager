/**
 * components/view/chart.tsx — a validated grammar, rendered as plain SVG (§15).
 *
 * "`chart` takes a grammar, not a chart type. 'Bar and line, nothing more' is a
 *  ceiling on what an admin can be shown, imposed for no safety reason — a
 *  declarative grammar (Vega-Lite-shaped: marks, encodings, transforms) is
 *  validated and rendered by trusted code exactly like every other component.
 *  The boundary that matters is markup, not expressiveness."
 *
 * So: the model authors `{mark, encoding, transform}`; this file is the trusted
 * renderer. No charting library is involved, and no model string reaches the
 * DOM as markup — every value below lands as a text node or an SVG geometry
 * number.
 *
 * Supported marks: bar (stacked or grouped), line, area, point, rule, arc.
 */

import type { ReactNode } from 'react'
import { inZone } from '@/lib/clock'
import { formatINR } from '@/lib/format'
import type { ChartAggregate, ChartFieldDef, ComponentSpec, VegaLiteish } from '@/lib/web/registry'
import type { ResolvedComponent } from '@/lib/web/views'
import { Card, Empty, ErrorLine, MUTED } from '@/components/view/chrome'

type Row = Record<string, unknown>

// Mid-tone hues: legible on white and on near-black without a per-theme swap.
const PALETTE = ['#3b82f6', '#f43f5e', '#10b981', '#f59e0b', '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16']

const AXIS_TEXT = 'fill-neutral-500 dark:fill-neutral-400'
const GRID = 'stroke-neutral-200 dark:stroke-neutral-800'

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

function toMs(v: unknown): number | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime()
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v)
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  return null
}

function label(v: unknown): string {
  if (v === null || v === undefined) return '—'
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v)
}

function compact(n: number): string {
  const a = Math.abs(n)
  if (a >= 1e7) return `${(n / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr`
  if (a >= 1e5) return `${(n / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L`
  if (a >= 1e3) return `${(n / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k`
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(a < 1 ? 2 : 1)
}

function formatValue(v: number, def?: ChartFieldDef): string {
  if (def?.format === 'inr') return `₹${compact(v)}`
  if (def?.format === 'percent') return `${Math.round(v * 100)}%`
  return compact(v)
}

function exactValue(v: number, def?: ChartFieldDef): string {
  if (def?.format === 'inr') return formatINR(v)
  if (def?.format === 'percent') return `${(v * 100).toFixed(1)}%`
  return v.toLocaleString('en-IN')
}

// ---------------------------------------------------------------------------
// Transforms — applied in order, exactly as written.
// ---------------------------------------------------------------------------

function aggregateValues(op: ChartAggregate, values: number[]): number {
  if (op === 'count') return values.length
  if (!values.length) return 0
  switch (op) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
    case 'median': {
      const s = [...values].sort((a, b) => a - b)
      const mid = Math.floor(s.length / 2)
      return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
    }
    default:
      return 0
  }
}

function applyTransforms(rows: Row[], spec: VegaLiteish): Row[] {
  let out = rows
  for (const t of spec.transform ?? []) {
    if ('filter' in t) {
      const f = t.filter
      out = out.filter((r) => {
        const raw = r[f.field]
        if (f.valid === true && (raw === null || raw === undefined)) return false
        if (f.valid === false && !(raw === null || raw === undefined)) return false
        if (f.equal !== undefined && String(raw) !== String(f.equal)) return false
        if (f.oneOf && !f.oneOf.some((o) => String(o) === String(raw))) return false
        const n = num(raw)
        if (f.gt !== undefined && !(n !== null && n > f.gt)) return false
        if (f.gte !== undefined && !(n !== null && n >= f.gte)) return false
        if (f.lt !== undefined && !(n !== null && n < f.lt)) return false
        if (f.lte !== undefined && !(n !== null && n <= f.lte)) return false
        return true
      })
    } else if ('aggregate' in t) {
      const groupby = t.groupby ?? []
      const groups = new Map<string, Row[]>()
      for (const r of out) {
        const key = JSON.stringify(groupby.map((g) => label(r[g])))
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(r)
      }
      out = [...groups.values()].map((members) => {
        const row: Row = {}
        for (const g of groupby) row[g] = members[0]![g]
        for (const a of t.aggregate) {
          const vals = a.field
            ? members.map((m) => num(m[a.field!])).filter((n): n is number => n !== null)
            : members.map(() => 1)
          row[a.as] = aggregateValues(a.op, vals)
        }
        return row
      })
    } else if ('sort' in t) {
      const keys = t.sort
      out = [...out].sort((x, y) => {
        for (const k of keys) {
          const dir = k.order === 'descending' ? -1 : 1
          const a = x[k.field]
          const b = y[k.field]
          const na = num(a)
          const nb = num(b)
          const cmp = na !== null && nb !== null ? na - nb : label(a).localeCompare(label(b))
          if (cmp !== 0) return cmp * dir
        }
        return 0
      })
    } else if ('limit' in t) {
      out = out.slice(0, t.limit)
    }
  }
  return out
}

/** Encoding-level aggregation: `y: {field, aggregate:'sum'}` collapses rows by
 *  x (and colour), which is what makes "revenue by class" one line of grammar. */
function applyEncodingAggregate(rows: Row[], spec: VegaLiteish): Row[] {
  const value = spec.encoding.y ?? spec.encoding.theta
  const groupDefs = [spec.encoding.x, spec.encoding.color, spec.encoding.detail].filter(
    (d): d is ChartFieldDef => !!d && !!d.field,
  )
  if (!value?.aggregate || !groupDefs.length) return rows

  const groups = new Map<string, Row[]>()
  for (const r of rows) {
    const key = JSON.stringify(groupDefs.map((d) => label(r[d.field!])))
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(r)
  }
  const outField = value.field ?? '__count'
  return [...groups.values()].map((members) => {
    const row: Row = {}
    for (const d of groupDefs) row[d.field!] = members[0]![d.field!]
    const vals = value.field
      ? members.map((m) => num(m[value.field!])).filter((n): n is number => n !== null)
      : members.map(() => 1)
    row[outField] = aggregateValues(value.aggregate!, vals)
    return row
  })
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

function niceTicks(min: number, max: number, count: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0]
  if (min === max) return [min === 0 ? 0 : min - Math.abs(min), min, min + Math.abs(min || 1)]
  const span = max - min
  const rough = span / Math.max(1, count)
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / mag
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag
  const start = Math.floor(min / step) * step
  const end = Math.ceil(max / step) * step
  const out: number[] = []
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v * 1e6) / 1e6)
  return out
}

function uniqueBy(rows: Row[], field: string, sort?: 'ascending' | 'descending'): string[] {
  const seen: string[] = []
  for (const r of rows) {
    const v = label(r[field])
    if (!seen.includes(v)) seen.push(v)
  }
  if (sort) {
    seen.sort((a, b) => {
      const na = Number(a)
      const nb = Number(b)
      const cmp = Number.isFinite(na) && Number.isFinite(nb) ? na - nb : a.localeCompare(b)
      return sort === 'descending' ? -cmp : cmp
    })
  }
  return seen
}

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

export function ChartView({ c, tz }: { c: ResolvedComponent; tz: string }) {
  const componentSpec = c.spec as Extract<ComponentSpec, { type: 'chart' }>
  // A degraded component keeps its rows but loses its grammar; the dispatcher
  // routes those to `table`, so `spec` is always present here.
  const spec = componentSpec.spec

  if (c.error) {
    return (
      <Card title={componentSpec.title} note={c.note}>
        <ErrorLine message={c.error} />
      </Card>
    )
  }

  const rows = applyEncodingAggregate(applyTransforms(c.rows as Row[], spec), spec)
  if (!rows.length) {
    return (
      <Card title={componentSpec.title} note={c.note}>
        <Empty what="Nothing to plot." />
      </Card>
    )
  }

  const mark = typeof spec.mark === 'string' ? { type: spec.mark } : spec.mark
  const body =
    mark.type === 'arc' ? (
      <Arc rows={rows} spec={spec} />
    ) : (
      <Cartesian rows={rows} spec={spec} markType={mark.type} showPoints={!!mark.point} tz={tz} />
    )

  return (
    <Card title={componentSpec.title} note={c.note} footer={footerFor(c)}>
      <div className="overflow-x-auto">{body}</div>
    </Card>
  )
}

function footerFor(c: ResolvedComponent): string | undefined {
  if (!c.hasMore) return undefined
  return `Plotted from the first ${c.pageSize.toLocaleString('en-IN')} rows — ask in the chat for a narrower range.`
}

function Legend({ items }: { items: { name: string; color: string }[] }) {
  if (items.length < 2) return null
  return (
    <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {items.map((s) => (
        <li key={s.name} className={`flex items-center gap-1.5 text-xs ${MUTED}`}>
          <span className="size-2 rounded-full" style={{ backgroundColor: s.color }} />
          <span className="max-w-[12rem] truncate">{s.name}</span>
        </li>
      ))}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Cartesian marks: bar, line, area, point, rule
// ---------------------------------------------------------------------------

function Cartesian({
  rows,
  spec,
  markType,
  showPoints,
  tz,
}: {
  rows: Row[]
  spec: VegaLiteish
  markType: 'bar' | 'line' | 'area' | 'point' | 'rule'
  showPoints: boolean
  tz: string
}) {
  const xDef = spec.encoding.x
  const yDef = spec.encoding.y
  const colorDef = spec.encoding.color

  const W = spec.width ?? 640
  const H = spec.height ?? 260
  const M = { top: 10, right: 14, bottom: 30, left: 46 }
  const iw = W - M.left - M.right
  const ih = H - M.top - M.bottom

  const yField = yDef?.field ?? '__count'
  const xField = xDef?.field ?? ''
  const banded = !xDef || xDef.type === 'nominal' || xDef.type === 'ordinal'

  const seriesNames = colorDef?.field ? uniqueBy(rows, colorDef.field, colorDef.sort) : ['']
  const colorOf = (name: string) => PALETTE[Math.max(0, seriesNames.indexOf(name)) % PALETTE.length]!

  const categories = banded && xField ? uniqueBy(rows, xField, xDef?.sort) : []
  const stacked = markType === 'bar' && seriesNames.length > 1 && yDef?.stack !== false

  // ---- y domain
  let yMax = 0
  let yMin = 0
  if (stacked) {
    for (const cat of categories) {
      let total = 0
      for (const r of rows) if (label(r[xField]) === cat) total += num(r[yField]) ?? 0
      yMax = Math.max(yMax, total)
      yMin = Math.min(yMin, total)
    }
  } else {
    for (const r of rows) {
      const v = num(r[yField])
      if (v === null) continue
      yMax = Math.max(yMax, v)
      yMin = Math.min(yMin, v)
    }
  }
  if (yMax === yMin) yMax = yMin + 1
  const ticks = niceTicks(Math.min(0, yMin), yMax, 4)
  const yLo = Math.min(...ticks)
  const yHi = Math.max(...ticks)
  const yScale = (v: number) => M.top + ih - ((v - yLo) / (yHi - yLo)) * ih

  // ---- x scale
  const xValuesNumeric = !banded
    ? rows
        .map((r) => (xDef?.type === 'temporal' ? toMs(r[xField]) : num(r[xField])))
        .filter((v): v is number => v !== null)
    : []
  const xLo = xValuesNumeric.length ? Math.min(...xValuesNumeric) : 0
  const xHi = xValuesNumeric.length ? Math.max(...xValuesNumeric) : 1
  const xSpan = xHi - xLo || 1
  const band = categories.length ? iw / categories.length : iw

  const xPos = (r: Row): number => {
    if (banded) {
      const i = categories.indexOf(label(r[xField]))
      return M.left + (i < 0 ? 0 : i) * band + band / 2
    }
    const v = xDef?.type === 'temporal' ? toMs(r[xField]) : num(r[xField])
    return M.left + (((v ?? xLo) - xLo) / xSpan) * iw
  }

  const xTickLabels: { x: number; text: string }[] = []
  if (banded) {
    const every = Math.max(1, Math.ceil(categories.length / 8))
    categories.forEach((cat, i) => {
      if (i % every !== 0) return
      xTickLabels.push({
        x: M.left + i * band + band / 2,
        text: cat.length > 12 ? `${cat.slice(0, 11)}…` : cat,
      })
    })
  } else {
    for (let i = 0; i <= 4; i++) {
      const v = xLo + (xSpan * i) / 4
      xTickLabels.push({
        x: M.left + (iw * i) / 4,
        text: xDef?.type === 'temporal' ? inZone(new Date(v), tz).date : compact(v),
      })
    }
  }

  const bySeries = new Map<string, Row[]>()
  for (const name of seriesNames) bySeries.set(name, [])
  for (const r of rows) {
    const name = colorDef?.field ? label(r[colorDef.field]) : ''
    if (!bySeries.has(name)) bySeries.set(name, [])
    bySeries.get(name)!.push(r)
  }

  const marks: ReactNode[] = []

  if (markType === 'bar') {
    const groupCount = stacked ? 1 : seriesNames.length
    const slot = (band * 0.72) / Math.max(1, groupCount)
    categories.forEach((cat, ci) => {
      let stackTop = 0
      seriesNames.forEach((name, si) => {
        const r = (bySeries.get(name) ?? []).find((row) => label(row[xField]) === cat)
        if (!r) return
        const v = num(r[yField])
        if (v === null) return
        const x = stacked
          ? M.left + ci * band + band * 0.14
          : M.left + ci * band + band * 0.14 + si * slot
        const w = stacked ? band * 0.72 : slot * 0.92
        const y0 = stacked ? yScale(stackTop) : yScale(Math.min(0, v))
        const y1 = stacked ? yScale(stackTop + v) : yScale(Math.max(0, v))
        if (stacked) stackTop += v
        marks.push(
          <rect
            key={`b-${ci}-${si}`}
            x={x}
            y={Math.min(y0, y1)}
            width={Math.max(1, w)}
            height={Math.max(1, Math.abs(y1 - y0))}
            rx={2}
            fill={colorOf(name)}
            fillOpacity={0.9}
          >
            <title>{`${cat}${name ? ` · ${name}` : ''}: ${exactValue(v, yDef)}`}</title>
          </rect>,
        )
      })
    })
  } else if (markType === 'rule') {
    rows.forEach((r, i) => {
      const v = num(r[yField])
      if (v === null) return
      const y = yScale(v)
      marks.push(
        <line
          key={`r-${i}`}
          x1={M.left}
          x2={M.left + iw}
          y1={y}
          y2={y}
          stroke={colorOf(colorDef?.field ? label(r[colorDef.field]) : '')}
          strokeWidth={1.5}
          strokeDasharray="4 3"
        >
          <title>{exactValue(v, yDef)}</title>
        </line>,
      )
    })
  } else {
    // line / area / point
    seriesNames.forEach((name) => {
      const pts = (bySeries.get(name) ?? [])
        .map((r) => ({ x: xPos(r), y: num(r[yField]), r }))
        .filter((p): p is { x: number; y: number; r: Row } => p.y !== null)
        .sort((a, b) => a.x - b.x)
      if (!pts.length) return
      const color = colorOf(name)
      const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${yScale(p.y).toFixed(1)}`).join(' ')

      if (markType === 'area') {
        const base = yScale(Math.max(yLo, 0))
        marks.push(
          <path
            key={`a-${name}`}
            d={`${d} L${pts[pts.length - 1]!.x.toFixed(1)},${base.toFixed(1)} L${pts[0]!.x.toFixed(1)},${base.toFixed(1)} Z`}
            fill={color}
            fillOpacity={0.18}
          />,
        )
      }
      if (markType === 'line' || markType === 'area') {
        marks.push(
          <path
            key={`l-${name}`}
            d={d}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />,
        )
      }
      if (markType === 'point' || showPoints) {
        pts.forEach((p, i) => {
          marks.push(
            <circle key={`p-${name}-${i}`} cx={p.x} cy={yScale(p.y)} r={3} fill={color}>
              <title>{`${label(p.r[xField])}${name ? ` · ${name}` : ''}: ${exactValue(p.y, yDef)}`}</title>
            </circle>,
          )
        })
      }
    })
  }

  return (
    <>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full min-w-[320px]"
        role="img"
        aria-label={`${yDef?.title ?? yDef?.field ?? 'value'} by ${xDef?.title ?? xDef?.field ?? 'category'}`}
      >
        {ticks.map((t) => (
          <g key={`t-${t}`}>
            <line x1={M.left} x2={M.left + iw} y1={yScale(t)} y2={yScale(t)} className={GRID} strokeWidth={1} />
            <text x={M.left - 6} y={yScale(t)} dy="0.32em" textAnchor="end" fontSize="10" className={AXIS_TEXT}>
              {formatValue(t, yDef)}
            </text>
          </g>
        ))}
        {marks}
        <line
          x1={M.left}
          x2={M.left + iw}
          y1={yScale(Math.max(yLo, Math.min(0, yHi)))}
          y2={yScale(Math.max(yLo, Math.min(0, yHi)))}
          className="stroke-neutral-400 dark:stroke-neutral-600"
          strokeWidth={1}
        />
        {xTickLabels.map((t, i) => (
          <text
            key={`x-${i}`}
            x={t.x}
            y={M.top + ih + 16}
            textAnchor="middle"
            fontSize="10"
            className={AXIS_TEXT}
          >
            {t.text}
          </text>
        ))}
      </svg>
      <Legend items={seriesNames.filter(Boolean).map((n) => ({ name: n, color: colorOf(n) }))} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Arc — a pie, driven by theta + color
// ---------------------------------------------------------------------------

function Arc({ rows, spec }: { rows: Row[]; spec: VegaLiteish }) {
  const thetaDef = spec.encoding.theta ?? spec.encoding.y
  const colorDef = spec.encoding.color ?? spec.encoding.x
  const field = thetaDef?.field ?? '__count'

  const slices = rows
    .map((r) => ({
      name: colorDef?.field ? label(r[colorDef.field]) : '—',
      value: Math.max(0, num(r[field]) ?? 0),
    }))
    .filter((s) => s.value > 0)

  const total = slices.reduce((a, s) => a + s.value, 0)
  if (!total) return <Empty what="Nothing to plot." />

  const size = 220
  const cx = size / 2
  const cy = size / 2
  const rOuter = size / 2 - 6
  const rInner = rOuter * 0.55

  let angle = -Math.PI / 2
  const paths = slices.map((s, i) => {
    const sweep = (s.value / total) * Math.PI * 2
    const a0 = angle
    const a1 = angle + sweep
    angle = a1
    const large = sweep > Math.PI ? 1 : 0
    const p = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`
    const d = [
      `M${p(rOuter, a0)}`,
      `A${rOuter},${rOuter} 0 ${large} 1 ${p(rOuter, a1)}`,
      `L${p(rInner, a1)}`,
      `A${rInner},${rInner} 0 ${large} 0 ${p(rInner, a0)}`,
      'Z',
    ].join(' ')
    const color = PALETTE[i % PALETTE.length]!
    return (
      <path key={`${s.name}-${i}`} d={d} fill={color} fillOpacity={0.9}>
        <title>{`${s.name}: ${exactValue(s.value, thetaDef)} (${Math.round((s.value / total) * 100)}%)`}</title>
      </path>
    )
  })

  return (
    <>
      <svg viewBox={`0 0 ${size} ${size}`} className="mx-auto h-auto w-full max-w-[240px]" role="img">
        {paths}
        <text x={cx} y={cy} dy="0.35em" textAnchor="middle" fontSize="14" className="fill-current font-semibold">
          {formatValue(total, thetaDef)}
        </text>
      </svg>
      <Legend items={slices.map((s, i) => ({ name: s.name, color: PALETTE[i % PALETTE.length]! }))} />
    </>
  )
}

export default ChartView

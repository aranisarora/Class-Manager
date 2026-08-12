/**
 * lib/web/registry.ts — the component registry (§15).
 *
 * "The component library is a registry, not a fixed list. Each component
 *  declares a data contract; adding one is a file, and the model discovers what
 *  exists from the registry rather than from a list baked into its prompt."
 *
 * So this file holds three things and nothing else:
 *   1. the types every component takes,
 *   2. `ViewSpecSchema` — the zod schema a model-authored spec is validated
 *      against at MINT time (§15: "validation rejects at mint time"),
 *   3. `REGISTRY` — the declared data contract + render file for each type.
 *
 * The model authors a view SPEC. It never authors markup (§15). Nothing in this
 * module accepts an HTML string, and nothing downstream renders one.
 *
 * `resolveView` is re-exported from `lib/web/views.ts` so that CONTRACTS §8's
 * import path holds either way.
 */

import { z } from 'zod'
import type { OperationName } from '@/lib/agent/operations'

// ---------------------------------------------------------------------------
// Chart grammar (§15: "chart takes a grammar, not a chart type").
//
// Vega-Lite-shaped: mark, encoding, transform. Validated here and rendered by
// trusted code in components/view/chart.tsx as plain SVG. The boundary that
// matters is markup, not expressiveness — so this is deliberately wide, and
// deliberately declarative.
// ---------------------------------------------------------------------------

export const CHART_MARKS = ['bar', 'line', 'area', 'point', 'rule', 'arc'] as const
export type ChartMark = (typeof CHART_MARKS)[number]

export const CHART_CHANNELS = ['x', 'y', 'color', 'theta', 'size', 'detail', 'tooltip'] as const
export type ChartChannel = (typeof CHART_CHANNELS)[number]

export const CHART_FIELD_TYPES = ['quantitative', 'temporal', 'ordinal', 'nominal'] as const
export type ChartFieldType = (typeof CHART_FIELD_TYPES)[number]

export const CHART_AGGREGATES = ['sum', 'mean', 'count', 'min', 'max', 'median'] as const
export type ChartAggregate = (typeof CHART_AGGREGATES)[number]

export type ChartValueFormat = 'inr' | 'number' | 'percent' | 'text'

export type ChartFieldDef = {
  field?: string
  type: ChartFieldType
  aggregate?: ChartAggregate
  title?: string
  sort?: 'ascending' | 'descending'
  format?: ChartValueFormat
  stack?: boolean
}

export type ChartFilter = {
  field: string
  equal?: string | number | boolean
  oneOf?: (string | number)[]
  gt?: number
  gte?: number
  lt?: number
  lte?: number
  valid?: boolean
}

export type ChartTransform =
  | { filter: ChartFilter }
  | { aggregate: { op: ChartAggregate; field?: string; as: string }[]; groupby?: string[] }
  | { sort: { field: string; order?: 'ascending' | 'descending' }[] }
  | { limit: number }

export type VegaLiteish = {
  mark: ChartMark | { type: ChartMark; point?: boolean; tooltip?: boolean; interpolate?: 'linear' | 'monotone' }
  encoding: { [K in ChartChannel]?: ChartFieldDef }
  transform?: ChartTransform[]
  width?: number
  height?: number
}

const ChartFieldDefSchema = z
  .object({
    field: z.string().min(1).max(120).optional(),
    type: z.enum(CHART_FIELD_TYPES),
    aggregate: z.enum(CHART_AGGREGATES).optional(),
    title: z.string().max(120).optional(),
    sort: z.enum(['ascending', 'descending']).optional(),
    format: z.enum(['inr', 'number', 'percent', 'text']).optional(),
    stack: z.boolean().optional(),
  })
  .strict()

const ChartFilterSchema = z
  .object({
    field: z.string().min(1).max(120),
    equal: z.union([z.string(), z.number(), z.boolean()]).optional(),
    oneOf: z.array(z.union([z.string(), z.number()])).max(200).optional(),
    gt: z.number().optional(),
    gte: z.number().optional(),
    lt: z.number().optional(),
    lte: z.number().optional(),
    valid: z.boolean().optional(),
  })
  .strict()

const ChartTransformSchema = z.union([
  z.object({ filter: ChartFilterSchema }).strict(),
  z
    .object({
      aggregate: z
        .array(
          z
            .object({
              op: z.enum(CHART_AGGREGATES),
              field: z.string().min(1).max(120).optional(),
              as: z.string().min(1).max(120),
            })
            .strict(),
        )
        .min(1)
        .max(8),
      groupby: z.array(z.string().min(1).max(120)).max(4).optional(),
    })
    .strict(),
  z
    .object({
      sort: z
        .array(
          z
            .object({ field: z.string().min(1).max(120), order: z.enum(['ascending', 'descending']).optional() })
            .strict(),
        )
        .min(1)
        .max(4),
    })
    .strict(),
  z.object({ limit: z.number().int().positive().max(5000) }).strict(),
])

const VegaLiteishObject = z
  .object({
    mark: z.union([
      z.enum(CHART_MARKS),
      z
        .object({
          type: z.enum(CHART_MARKS),
          point: z.boolean().optional(),
          tooltip: z.boolean().optional(),
          interpolate: z.enum(['linear', 'monotone']).optional(),
        })
        .strict(),
    ]),
    encoding: z
      .object({
        x: ChartFieldDefSchema.optional(),
        y: ChartFieldDefSchema.optional(),
        color: ChartFieldDefSchema.optional(),
        theta: ChartFieldDefSchema.optional(),
        size: ChartFieldDefSchema.optional(),
        detail: ChartFieldDefSchema.optional(),
        tooltip: ChartFieldDefSchema.optional(),
      })
      .strict(),
    transform: z.array(ChartTransformSchema).max(8).optional(),
    width: z.number().int().min(160).max(1200).optional(),
    height: z.number().int().min(80).max(720).optional(),
  })
  .strict()

export const VegaLiteishSchema = VegaLiteishObject as unknown as z.ZodType<VegaLiteish>


// ---------------------------------------------------------------------------
// Form fields.
//
// `form` is not optional — it is what replaced the two WhatsApp Flows (§14.6),
// and setup and the register both depend on it.
// ---------------------------------------------------------------------------

export type FormFieldOption = { value: string; label: string }

export type FormField =
  | {
      kind: 'text' | 'textarea' | 'number' | 'money' | 'date' | 'time' | 'phone'
      name: string
      label: string
      value?: string | number | null
      placeholder?: string
      help?: string
      required?: boolean
    }
  | {
      kind: 'select' | 'choice'
      name: string
      label: string
      options: FormFieldOption[]
      value?: string | null
      help?: string
      required?: boolean
    }
  | { kind: 'toggle'; name: string; label: string; value?: boolean; help?: string }
  | { kind: 'hidden'; name: string; value: string }

const FormFieldSchema = z.union([
  z
    .object({
      kind: z.enum(['text', 'textarea', 'number', 'money', 'date', 'time', 'phone']),
      name: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      value: z.union([z.string().max(2000), z.number(), z.null()]).optional(),
      placeholder: z.string().max(120).optional(),
      help: z.string().max(240).optional(),
      required: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['select', 'choice']),
      name: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      options: z
        .array(z.object({ value: z.string().max(200), label: z.string().min(1).max(120) }).strict())
        .min(1)
        .max(40),
      value: z.union([z.string().max(200), z.null()]).optional(),
      help: z.string().max(240).optional(),
      required: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('toggle'),
      name: z.string().min(1).max(64),
      label: z.string().min(1).max(120),
      value: z.boolean().optional(),
      help: z.string().max(240).optional(),
    })
    .strict(),
  z
    .object({ kind: z.literal('hidden'), name: z.string().min(1).max(64), value: z.string().max(2000) })
    .strict(),
])

/** An operation name is validated for real by `OPERATIONS` at submit time; here
 *  we only assert it is a name. Importing the operation table into the schema
 *  would drag the whole agent into the web bundle for no extra safety. */
const OperationNameSchema = z.custom<OperationName>(
  (v) => typeof v === 'string' && v.length > 0 && v.length <= 64,
  { message: 'submit.operation must be an operation name' },
)

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

export type ColumnDef = { key: string; label: string; align?: 'left' | 'right' }

export type ComponentSpec =
  | { type: 'table'; title?: string; query: string; columns?: ColumnDef[]; totals?: string[] }
  | { type: 'prose'; markdown: string }
  | { type: 'form'; title?: string; fields: FormField[]; submit: { operation: OperationName; fixedArgs?: Record<string, unknown> } }
  | { type: 'calendar'; query: string; title?: string }
  | { type: 'people-list'; query: string; title?: string }
  | { type: 'detail'; query: string; title?: string }
  | { type: 'stat-cards'; query: string; title?: string }
  | { type: 'timeline'; query: string; title?: string }
  | { type: 'chart'; title?: string; query: string; spec: VegaLiteish }

export type ComponentType = ComponentSpec['type']

export const COMPONENT_TYPES = [
  'table',
  'prose',
  'form',
  'calendar',
  'people-list',
  'detail',
  'stat-cards',
  'timeline',
  'chart',
] as const

const QuerySchema = z.string().min(6).max(8000)
const TitleSchema = z.string().min(1).max(120).optional()

const ComponentSpecSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('table'),
      title: TitleSchema,
      query: QuerySchema,
      columns: z
        .array(
          z
            .object({
              key: z.string().min(1).max(120),
              label: z.string().min(1).max(120),
              align: z.enum(['left', 'right']).optional(),
            })
            .strict(),
        )
        .max(24)
        .optional(),
      totals: z.array(z.string().min(1).max(120)).max(12).optional(),
    })
    .strict(),
  z.object({ type: z.literal('prose'), markdown: z.string().min(1).max(8000) }).strict(),
  z
    .object({
      type: z.literal('form'),
      title: TitleSchema,
      fields: z.array(FormFieldSchema).min(1).max(40),
      submit: z
        .object({ operation: OperationNameSchema, fixedArgs: z.record(z.unknown()).optional() })
        .strict(),
    })
    .strict(),
  z.object({ type: z.literal('calendar'), query: QuerySchema, title: TitleSchema }).strict(),
  z.object({ type: z.literal('people-list'), query: QuerySchema, title: TitleSchema }).strict(),
  z.object({ type: z.literal('detail'), query: QuerySchema, title: TitleSchema }).strict(),
  z.object({ type: z.literal('stat-cards'), query: QuerySchema, title: TitleSchema }).strict(),
  z.object({ type: z.literal('timeline'), query: QuerySchema, title: TitleSchema }).strict(),
  z
    .object({ type: z.literal('chart'), title: TitleSchema, query: QuerySchema, spec: VegaLiteishSchema })
    .strict(),
])

export type ViewSpec = { title: string; components: ComponentSpec[] }

export const ViewSpecSchema: z.ZodType<ViewSpec> = z
  .object({
    title: z.string().min(1).max(120),
    components: z.array(ComponentSpecSchema).min(1).max(12),
  })
  .strict() as unknown as z.ZodType<ViewSpec>

/** True for the component types that carry a `query`. */
export function hasQuery(c: ComponentSpec): c is Extract<ComponentSpec, { query: string }> {
  return c.type !== 'prose' && c.type !== 'form'
}

// ---------------------------------------------------------------------------
// Column aliases.
//
// A data contract that only accepts one spelling of `starts_at` fails for a
// reason nobody can see. Each component names the canonical column plus the
// spellings a model plausibly writes; the resolver checks against this table
// and the renderer reads through it, so the two can never disagree.
// ---------------------------------------------------------------------------

export const ALIASES = {
  when: ['starts_at', 'start_at', 'starts', 'start', 'at', 'when', 'occurred_at', 'date', 'day'],
  end: ['ends_at', 'end_at', 'ends', 'end'],
  title: ['title', 'name', 'class_name', 'class', 'label', 'event', 'description', 'summary'],
  subtitle: ['subtitle', 'detail', 'details', 'note', 'notes', 'venue', 'venue_name', 'where', 'coach', 'coach_name'],
  person: ['name', 'full_name', 'player', 'player_name', 'person', 'person_name', 'coach', 'coach_name', 'display_name'],
  status: ['status', 'state', 'badge', 'tag'],
  value: ['value', 'amount', 'total', 'count', 'n'],
  delta: ['delta', 'change', 'diff', 'vs_last'],
  hint: ['hint', 'sub', 'caption', 'help', 'note'],
  label: ['label', 'metric', 'name', 'title', 'key'],
  id: ['id', 'session_id', 'player_id', 'person_id', 'class_id', 'account_id'],
} as const

/** First alias present in `keys`, or null. */
export function pickKey(keys: readonly string[], aliases: readonly string[]): string | null {
  const lower = new Map(keys.map((k) => [k.toLowerCase(), k]))
  for (const a of aliases) {
    const hit = lower.get(a)
    if (hit) return hit
  }
  return null
}

/** Columns that render as rupees without being told to (§ money is numeric(10,2)). */
export const MONEY_COLUMN = /(^|_)(amount|amount_inr|fee|fees|balance|due|paid|price|rate|total|charge|credit|payable|payables)(_inr)?$/i

// ---------------------------------------------------------------------------
// The registry itself.
//
// `dataContract` is model-facing prose: it is what the model reads to decide
// which component fits and what its query must return. `render` is the file
// that draws it — adding a component really is a file plus a row here.
// ---------------------------------------------------------------------------

export type RegistryEntry = { dataContract: string; render: string }

export const REGISTRY: Record<ComponentType, RegistryEntry> = {
  table: {
    dataContract:
      'query: any SELECT. Columns render in the order the query returns them. ' +
      'columns (optional): [{key,label,align}] to rename or reorder — keys not in the result are dropped. ' +
      'totals (optional): column keys to sum in a footer row. ' +
      'Numeric columns right-align on their own; columns named amount/fee/balance/due/paid/total/rate (or ending _inr) render as rupees. ' +
      'The universal fallback: every other component degrades to this one.',
    render: 'components/view/table.tsx',
  },
  prose: {
    dataContract:
      'markdown: a string. No query. Headings, bold, italic, inline code, bullet and numbered lists, blockquotes and rules render; ' +
      'everything else renders as text. HTML is never interpreted — the model does not author markup. ' +
      'Use for synthesized commentary, and with a table for a genuinely novel need.',
    render: 'components/view/prose.tsx',
  },
  form: {
    dataContract:
      'fields: [{kind,name,label,...}] where kind is text | textarea | number | money | date | time | phone | select | choice | toggle | hidden. ' +
      'select and choice carry options:[{value,label}]. Every field may carry `value` as its current value, `help`, and `required`. ' +
      'submit: {operation, fixedArgs?} — the named operation that runs on submit, under the link holder\'s own RLS. ' +
      'Field names become the operation\'s arguments; fixedArgs are merged in and win. No query.',
    render: 'components/view/form.tsx',
  },
  calendar: {
    dataContract:
      'query must return a start timestamp (starts_at | start | at | when | date) and a title (title | name | class_name). ' +
      'Optional: ends_at, venue/venue_name (or subtitle/detail), status (cancelled rows strike through), id. ' +
      'Rows group by day in the business timezone, in the order the query returns them.',
    render: 'components/view/calendar.tsx',
  },
  'people-list': {
    dataContract:
      'query must return a person name (name | full_name | player | person | coach). ' +
      'Optional: status (rendered as a badge — paid/active/present read positive, unpaid/overdue/absent read negative), ' +
      'detail/subtitle/note as a second line, and amount-shaped columns which render as rupees on the right.',
    render: 'components/view/people-list.tsx',
  },
  detail: {
    dataContract:
      'query returns ONE row: every column becomes a label/value pair, in query order. ' +
      'Alternatively return many rows of exactly (label, value) and they render as the pairs. Use for one player, one class, one coach.',
    render: 'components/view/detail.tsx',
  },
  'stat-cards': {
    dataContract:
      'query returns one row per card with columns label and value. ' +
      'Optional: delta (signed number or text — positive reads up, negative reads down) and hint (a caption). ' +
      'Keep it to at most 8 cards; more than that is a table.',
    render: 'components/view/stat-cards.tsx',
  },
  timeline: {
    dataContract:
      'query returns ordered events: a timestamp (at | when | occurred_at | starts_at | date) and a title (title | name | event | description). ' +
      'Optional: detail/note as a second line, and status. Rows render in the order the query returns them, newest first is conventional.',
    render: 'components/view/timeline.tsx',
  },
  chart: {
    dataContract:
      'query returns the rows; spec is a validated chart grammar (Vega-Lite-shaped), not a chart type. ' +
      'spec.mark: bar | line | area | point | rule | arc (arc is a pie, driven by theta + color). ' +
      'spec.encoding: x, y, color, theta, size, detail, tooltip — each {field, type: quantitative|temporal|ordinal|nominal, aggregate?, title?, format?, stack?}. ' +
      'spec.transform: [{filter:{field,equal|oneOf|gt|gte|lt|lte|valid}}] [{aggregate:[{op,field,as}],groupby}] [{sort:[{field,order}]}] [{limit:n}], applied in order. ' +
      'Bars stack when a color encoding is present; set encoding.y.stack=false for grouped. Rendered as plain SVG by trusted code.',
    render: 'components/view/chart.tsx',
  },
}

/** What the model reads to discover the surface. Not baked into its prompt —
 *  derived from the registry, so adding a component really is one file. */
export function registryDigest(): string {
  const lines = (Object.keys(REGISTRY) as ComponentType[]).map(
    (t) => `- ${t}: ${REGISTRY[t].dataContract}`,
  )
  return [
    'View components (§15). A view spec is {title, components:[...]}; every component is {type, ...}.',
    'Every query runs under the link holder\'s own RLS, so it can only return what that person could see by hand.',
    ...lines,
  ].join('\n')
}

export { resolveView } from '@/lib/web/views'
export type { ResolvedComponent, ResolvedView } from '@/lib/web/views'

'use client'

/**
 * A WhatsApp Flow, opened. The form the person fills in inside the chat.
 *
 * Every field on this sheet is read out of `FLOWS[flowId].json` at render time. Nothing about
 * the shipped flow is written down twice — no copy of its labels, no copy of its dropdown
 * options, no copy of the payload its footer builds. A hand-written twin would drift the first
 * time the artifact changed and would keep rendering the old form perfectly, which is the
 * failure §17 exists to make impossible: the emulator has to be the *other implementation of
 * the same wire*, not a picture of it.
 *
 * What it does NOT do is talk to an endpoint. `flow_action` is `navigate` and every value is
 * known when the message is sent, so there is one screen, no `/data` round trip, and the
 * submission is the only thing that leaves this component.
 */

import { useMemo, useState } from 'react'
import { FLOWS, type FlowComponent, type FlowScreen } from '@/lib/messaging/flows'
import { buttonDisabled, type EmuFlow } from '@/lib/emulator/state'
import { Btn, Chip, cx } from './ui'

/** What the route will take as `text`. Longer than this is refused, never trimmed. */
const SUMMARY_LIMIT = 4096

/**
 * The component types this sheet can honestly draw. Anything outside it is rendered as a
 * visible failure and blocks submission — a form that silently skipped a field would build a
 * payload missing that field and post it as if the person had answered.
 */
const KNOWN = new Set([
  'TextHeading', 'TextSubheading', 'TextBody', 'TextCaption',
  'TextInput', 'TextArea', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup',
  'OptIn', 'DatePicker', 'Footer',
])

const INPUT_FIELDS = new Set(['TextInput', 'TextArea', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup', 'OptIn', 'DatePicker'])

export type Value = string | string[] | boolean

/** `${data.x}` and `${form.x}` — Meta's dynamic references, and the only two this build uses. */
const REF = /^\$\{(data|form)\.([A-Za-z0-9_]+)\}$/

function text(c: FlowComponent, key: string): string | null {
  const v = c[key]
  return typeof v === 'string' ? v : null
}

function flag(c: FlowComponent, key: string): boolean {
  return c[key] === true
}

type Option = { id: string; title: string; description?: string; enabled: boolean }

/**
 * The options a picker draws — from the artifact, or from what the send passed in.
 *
 * A `data-source` may be a literal list (the seven weekdays are the seven weekdays for
 * everyone) or a `${data.x}` reference resolved at send time. The second form is what
 * makes ONE published register able to draw tonight's twelve names and next week's
 * nine; without it every possible headcount would need its own artifact, which is not
 * a thing anybody would ship.
 *
 * An unresolvable reference returns no options rather than throwing, and the sheet
 * below refuses to submit a required picker with nothing in it — so a roster that
 * failed to travel is a visible dead end rather than an attendance record of nobody.
 */
function options(c: FlowComponent, data: Record<string, unknown>): Option[] {
  const raw = c['data-source']
  const m = typeof raw === 'string' ? REF.exec(raw) : null
  const src = m ? (m[1] === 'data' ? data[m[2]] : undefined) : raw
  if (!Array.isArray(src)) return []
  return src.flatMap((row) => {
    if (!row || typeof row !== 'object') return []
    const r = row as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id : null
    if (!id) return []
    return [{
      id,
      title: typeof r.title === 'string' ? r.title : id,
      description: typeof r.description === 'string' ? r.description : undefined,
      enabled: r.enabled !== false,
    }]
  })
}

/** A literal stays a literal; `${data.x}` resolves against what the send passed in. */
function resolveInit(raw: unknown, data: Record<string, unknown>): Value {
  if (Array.isArray(raw)) return raw.filter((v): v is string => typeof v === 'string')
  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return String(raw)
  if (typeof raw !== 'string') return ''
  const m = REF.exec(raw)
  if (!m) return raw
  // `${form.x}` on an init-value would be this screen's own inputs before anybody has typed —
  // empty by definition, which is what an unresolvable reference is worth.
  if (m[1] !== 'data') return ''
  const v = data[m[2]]
  // A checkbox group's prefill arrives as a list of ids and must stay one. Coercing it
  // to a string here would tick nothing and look exactly like "they picked nothing".
  if (Array.isArray(v)) return v.map((x) => String(x))
  if (typeof v === 'boolean') return v
  return v === undefined || v === null ? '' : String(v)
}

function initialValues(children: FlowComponent[], data: Record<string, unknown>): Record<string, Value> {
  const out: Record<string, Value> = {}
  for (const c of children) {
    if (!INPUT_FIELDS.has(c.type) || !c.name) continue
    const init = resolveInit(c['init-value'], data)
    out[c.name] =
      c.type === 'CheckboxGroup' ? (Array.isArray(init) ? init : init ? [String(init)] : [])
        : c.type === 'OptIn' ? init === true
          : Array.isArray(init) ? '' : typeof init === 'boolean' ? '' : init
  }
  return out
}

function isEmpty(v: Value | undefined): boolean {
  if (v === undefined) return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'boolean') return !v
  return v.trim() === ''
}

/** The label a person would recognise the answer by — the field's own, never its `name`. */
function labelOf(c: FlowComponent): string {
  return text(c, 'label') ?? String(c.name ?? c.type)
}

/** How a value reads back to a person: the option's title, not the id that travels. */
function display(c: FlowComponent, v: Value | undefined, data: Record<string, unknown>): string {
  if (v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  const titles = new Map(options(c, data).map((o) => [o.id, o.title]))
  if (Array.isArray(v)) return v.map((id) => titles.get(id) ?? id).join(', ')
  if (c.type === 'DatePicker' && /^\d+$/.test(v)) return new Date(Number(v)).toISOString().slice(0, 10)
  return titles.get(v) ?? v
}

/**
 * What leaves this sheet, built from the screen itself.
 *
 * `responseJson` is the literal `nfm_reply.response_json`: the Footer's `on-click-action`
 * payload with every `${form.x}` resolved against what the person typed, `flow_token` added
 * beside the fields, and the whole thing stringified — because a JSON **string** is what the
 * real webhook delivers, and an emulator that posted an object would be exercising a shape
 * production never sends.
 *
 * `summary` is the bubble the person sees afterwards. WhatsApp draws that summary itself from
 * the flow it just ran; here `message` is the only store, so it rides as the submission's text
 * exactly as the wire's own `nfm_reply.body` does. Values masked per the screen's `sensitive`
 * list, and read back through each field's label and option titles rather than the ids that
 * travel — the raw payload is one tap away in the bubble's evidence panel.
 *
 * Exported because it is the half of this component worth exercising without a browser.
 */
export function buildSubmission(
  screen: FlowScreen,
  flow: EmuFlow,
  values: Record<string, Value>,
): { responseJson: string; summary: string } {
  const children = screen.layout.children
  const footer = children.find((c) => c.type === 'Footer') ?? null
  const action = (footer?.['on-click-action'] ?? {}) as { payload?: Record<string, unknown> }

  const built: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(action.payload ?? {})) {
    const m = typeof raw === 'string' ? REF.exec(raw) : null
    if (m?.[1] === 'form') {
      const v = values[m[2]]
      // Arrays and booleans travel as themselves; everything else is text, because
      // `response_json` carries every scalar answer as a string — the dropdown's number
      // included, which is why the flow's own response schema coerces.
      built[key] = Array.isArray(v) || typeof v === 'boolean' ? v : String(v ?? '')
    } else if (m?.[1] === 'data') {
      const d = flow.data[m[2]]
      built[key] = d === undefined || d === null ? '' : Array.isArray(d) || typeof d === 'boolean' ? d : String(d)
    } else {
      built[key] = raw
    }
  }

  const sensitive = new Set(
    Array.isArray((screen as Record<string, unknown>).sensitive)
      ? ((screen as Record<string, unknown>).sensitive as unknown[]).filter((s): s is string => typeof s === 'string')
      : [],
  )

  const summary = [
    screen.title ?? screen.id,
    ...children
      .filter((c) => INPUT_FIELDS.has(c.type) && c.name && !isEmpty(values[String(c.name)]))
      .map(
        (c) =>
          `${labelOf(c)}: ${sensitive.has(String(c.name)) ? '••••••' : display(c, values[String(c.name)], flow.data)}`,
      ),
  ].join('\n')

  // `flow_token` rides inside the response and is not a form field — it is what matches the
  // submission back to the action row that minted it (§2.2).
  return { responseJson: JSON.stringify({ ...built, flow_token: flow.flowToken }), summary }
}

export function FlowSheet({
  flow,
  nowIso,
  onClose,
  onSubmit,
  busy,
}: {
  flow: EmuFlow
  nowIso: string
  onClose: () => void
  onSubmit: (responseJson: string, summary: string) => void
  busy: boolean
}) {
  const def = FLOWS[flow.flowId] ?? null
  const screen: FlowScreen | null = def?.json.screens.find((s) => s.id === flow.screen) ?? null
  const children = useMemo(() => screen?.layout.children ?? [], [screen])
  const [values, setValues] = useState<Record<string, Value>>(() => initialValues(children, flow.data))
  const [tried, setTried] = useState(false)

  const set = (name: string, v: Value) => setValues((prev) => ({ ...prev, [name]: v }))

  if (!def || !screen) {
    return (
      <Sheet title={flow.cta || 'flow'} onClose={onClose}>
        <div className="m-3 rounded border border-rose-800 bg-rose-950/40 px-3 py-2 text-[11px] leading-relaxed text-rose-200">
          {def
            ? `Flow "${flow.flowId}" has no screen called "${flow.screen}". The send named a screen the published artifact does not contain, and Meta would refuse it.`
            : `This build has no flow called "${flow.flowId}". Nothing can render it, and a real send would be rejected before it left.`}
        </div>
      </Sheet>
    )
  }

  const footer = children.find((c) => c.type === 'Footer') ?? null
  const unknown = children.filter((c) => !KNOWN.has(c.type))
  const missing = children.filter((c) => INPUT_FIELDS.has(c.type) && flag(c, 'required') && isEmpty(values[String(c.name)]))
  /**
   * A picker whose options never arrived.
   *
   * `data-source: '${data.roster}'` resolves at send time, and when it resolves to
   * nothing the control still draws — as an empty list that looks exactly like
   * "nobody applies". On the register that reads as *everyone was present*, which is a
   * billing record invented by a missing prefill. Blocked, loudly, rather than
   * submitted.
   */
  const starved = children.filter(
    (c) =>
      (c.type === 'Dropdown' || c.type === 'RadioButtonsGroup' || c.type === 'CheckboxGroup')
      && typeof c['data-source'] === 'string'
      && options(c, flow.data).length === 0,
  )

  const { responseJson, summary } = buildSubmission(screen, flow, values)
  const dead = buttonDisabled({ ...flow, actionId: flow.flowToken }, nowIso)
  const blocked =
    dead ? `this form is ${dead} — the token behind it is a single-use action row`
      : unknown.length ? `this sheet cannot draw ${unknown.map((c) => c.type).join(', ')}, so it will not pretend to have collected them`
        : starved.length ? `${starved.map((c) => labelOf(c)).join(', ')} was sent with no options in it, so this form cannot say anything true`
          : !footer ? 'this screen has no Footer, so there is nothing to submit it with'
            : summary.length > SUMMARY_LIMIT ? `the summary is ${summary.length} chars and the inbound route takes ${SUMMARY_LIMIT} — shortening an answer to fit would be inventing one`
              : null

  // A required field blocks the send here, in the sheet, exactly as it does on a handset —
  // never by trimming the payload down to what happens to be filled in.
  const submit = () => {
    setTried(true)
    if (blocked || missing.length) return
    onSubmit(responseJson, summary)
  }

  return (
    <Sheet title={screen.title ?? def.name} onClose={onClose}>
      <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800 bg-zinc-950/60 px-3 py-1.5">
        <Chip tone="violet" title="the published Flow this screen belongs to">{def.id}</Chip>
        <Chip tone="quiet" title="the screen flow_action: navigate opens on">{screen.id}</Chip>
        {screen.terminal ? <Chip tone="quiet" title="a terminal screen ends the flow — its footer must complete">terminal</Chip> : null}
        <Chip tone={dead ? 'danger' : 'window'} title="flow_token is an action row: single use, and it expires">
          {dead ? `token ${dead}` : 'token live'}
        </Chip>
      </div>

      <div className="flex flex-col gap-2.5 px-3 py-3">
        {children.map((c, i) => (
          <Field
            key={`${c.type}:${c.name ?? i}`}
            c={c}
            data={flow.data}
            value={values[String(c.name)]}
            invalid={tried && INPUT_FIELDS.has(c.type) && flag(c, 'required') && isEmpty(values[String(c.name)])}
            onChange={(v) => c.name && set(String(c.name), v)}
          />
        ))}
      </div>

      <div className="sticky bottom-0 border-t border-zinc-800 bg-zinc-900 px-3 py-2">
        {blocked ? (
          <p className="mb-1.5 rounded border border-rose-800 bg-rose-950/40 px-2 py-1 text-[10px] leading-snug text-rose-200">
            {blocked}
          </p>
        ) : tried && missing.length ? (
          <p className="mb-1.5 text-[10px] text-rose-300">
            {missing.map((c) => labelOf(c)).join(', ')} {missing.length > 1 ? 'are' : 'is'} required
          </p>
        ) : null}
        <Btn
          tone="primary"
          className="w-full justify-center py-1.5 text-[12px]"
          disabled={busy || !!blocked}
          onClick={submit}
        >
          {footer ? (text(footer, 'label') ?? 'Done') : 'Done'}
        </Btn>
      </div>
    </Sheet>
  )
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div
        className="max-h-[88%] overflow-y-auto rounded-t-lg border-t border-zinc-700 bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-2">
          <span className="truncate text-[12px] font-semibold text-zinc-200">{title}</span>
          <button type="button" onClick={onClose} className="text-[11px] text-zinc-500 hover:text-zinc-200">
            close
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const LABEL = 'text-[11px] font-medium text-zinc-300'
const HELP = 'text-[10px] leading-snug text-zinc-500'
const CONTROL =
  'w-full rounded border bg-zinc-950 px-2 py-1.5 text-[12px] text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-emerald-500/60'

function Field({
  c,
  data,
  value,
  invalid,
  onChange,
}: {
  c: FlowComponent
  /** What the send passed in, so a `${data.x}` data-source resolves the same way here. */
  data: Record<string, unknown>
  value: Value | undefined
  invalid: boolean
  onChange: (v: Value) => void
}) {
  const label = text(c, 'label')
  const helper = text(c, 'helper-text')
  const required = flag(c, 'required')
  const border = invalid ? 'border-rose-700' : 'border-zinc-700'

  switch (c.type) {
    case 'TextHeading':
      return <p className="text-[14px] font-semibold text-zinc-100">{text(c, 'text')}</p>
    case 'TextSubheading':
      return <p className="text-[12px] font-semibold text-zinc-200">{text(c, 'text')}</p>
    case 'TextBody':
      return <p className="text-[12px] leading-snug text-zinc-300">{text(c, 'text')}</p>
    case 'TextCaption':
      return <p className="text-[10px] leading-snug text-zinc-500">{text(c, 'text')}</p>

    case 'TextInput':
      return (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{label}{required ? ' *' : ''}</span>
          <input
            type={
              // Meta's `input-type` decides the phone's keyboard, and it is the one part of a
              // text field a browser can honestly reproduce.
              ({ number: 'number', email: 'email', phone: 'tel', passcode: 'password', password: 'password' } as Record<string, string>)[
                text(c, 'input-type') ?? 'text'
              ] ?? 'text'
            }
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className={cx(CONTROL, border)}
          />
          {helper ? <span className={HELP}>{helper}</span> : null}
        </label>
      )

    case 'TextArea':
      return (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{label}{required ? ' *' : ''}</span>
          <textarea
            rows={3}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className={cx(CONTROL, border)}
          />
          {helper ? <span className={HELP}>{helper}</span> : null}
        </label>
      )

    case 'Dropdown':
      return (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{label}{required ? ' *' : ''}</span>
          <select
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            className={cx(CONTROL, border)}
          >
            <option value="">—</option>
            {options(c, data).map((o) => (
              <option key={o.id} value={o.id} disabled={!o.enabled}>
                {o.title}
              </option>
            ))}
          </select>
          {helper ? <span className={HELP}>{helper}</span> : null}
        </label>
      )

    case 'RadioButtonsGroup':
      return (
        <fieldset className="flex flex-col gap-1">
          <legend className={LABEL}>{label}{required ? ' *' : ''}</legend>
          {options(c, data).map((o) => (
            <label key={o.id} className="flex items-start gap-2 text-[12px] text-zinc-200">
              <input
                type="radio"
                name={String(c.name)}
                checked={value === o.id}
                disabled={!o.enabled}
                onChange={() => onChange(o.id)}
                className="mt-0.5"
              />
              <span>
                {o.title}
                {o.description ? <span className="block text-[10px] text-zinc-500">{o.description}</span> : null}
              </span>
            </label>
          ))}
          {helper ? <span className={HELP}>{helper}</span> : null}
        </fieldset>
      )

    case 'CheckboxGroup': {
      const picked = Array.isArray(value) ? value : []
      return (
        <fieldset className="flex flex-col gap-1">
          <legend className={LABEL}>{label}{required ? ' *' : ''}</legend>
          {options(c, data).map((o) => (
            <label key={o.id} className="flex items-start gap-2 text-[12px] text-zinc-200">
              <input
                type="checkbox"
                checked={picked.includes(o.id)}
                disabled={!o.enabled}
                onChange={(e) => onChange(e.target.checked ? [...picked, o.id] : picked.filter((p) => p !== o.id))}
                className="mt-0.5"
              />
              <span>
                {o.title}
                {o.description ? <span className="block text-[10px] text-zinc-500">{o.description}</span> : null}
              </span>
            </label>
          ))}
          {helper ? <span className={HELP}>{helper}</span> : null}
        </fieldset>
      )
    }

    case 'OptIn':
      return (
        <label className={cx('flex items-start gap-2 rounded border px-2 py-1.5 text-[12px] text-zinc-200', border)}>
          <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} className="mt-0.5" />
          <span>{text(c, 'label')}{required ? ' *' : ''}</span>
        </label>
      )

    case 'DatePicker':
      return (
        <label className="flex flex-col gap-1">
          <span className={LABEL}>{label}{required ? ' *' : ''}</span>
          <input
            type="date"
            // A Flow's DatePicker carries milliseconds since the epoch, as a string, in both
            // directions — so the calendar's `yyyy-mm-dd` is converted at the edge rather than
            // sent in a shape the response schema would never see on the wire.
            value={typeof value === 'string' && /^\d+$/.test(value) ? new Date(Number(value)).toISOString().slice(0, 10) : ''}
            onChange={(e) => onChange(e.target.value ? String(Date.parse(`${e.target.value}T00:00:00Z`)) : '')}
            className={cx(CONTROL, border)}
          />
          {helper ? <span className={HELP}>{helper}</span> : null}
        </label>
      )

    case 'Footer':
      // Drawn by the sheet's own sticky bar, so it stays reachable on a long screen.
      return null

    default:
      return (
        <div className="rounded border border-rose-800 bg-rose-950/40 px-2 py-1.5 text-[10px] leading-snug text-rose-200">
          <span className="font-mono">{String(c.type)}</span> — this sheet does not know how to draw this
          component, so the field it collects is missing. Submitting is blocked rather than posting a
          payload with a hole in it.
        </div>
      )
  }
}

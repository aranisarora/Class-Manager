'use client'

/**
 * components/view/form.tsx — the model-authored form (§15).
 *
 * `form` is what replaced the two WhatsApp Flows (§14.6): a signed link, one
 * screen, one submit, no login. On submit the named operation in `submit.operation`
 * runs under the link holder's own RLS and a confirmation goes back into the
 * chat — so the form is a shortcut into the same machinery the chat uses, never
 * a separate write path.
 *
 * Interactive, so a client component. It receives plain JSON and posts plain
 * JSON; it never receives a query result or a database handle.
 */

import { useState, type FormEvent } from 'react'
import type { ComponentSpec, FormField } from '@/lib/web/registry'

type Values = Record<string, string | boolean>

function initialValues(fields: FormField[]): Values {
  const v: Values = {}
  for (const f of fields) {
    if (f.kind === 'toggle') v[f.name] = f.value ?? false
    else if (f.kind === 'hidden') v[f.name] = f.value
    else v[f.name] = f.value === null || f.value === undefined ? '' : String(f.value)
  }
  return v
}

const INPUT =
  'w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-base outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-300'

export function FormView({
  c,
  token,
  viewSpecId,
  index,
}: {
  c: { spec: ComponentSpec }
  token: string
  viewSpecId: string
  index: number
}) {
  const spec = c.spec as Extract<ComponentSpec, { type: 'form' }>
  const [values, setValues] = useState<Values>(() => initialValues(spec.fields))
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'expired' | 'error'>('idle')
  const [message, setMessage] = useState<string>('')

  const set = (name: string, value: string | boolean) => setValues((v) => ({ ...v, [name]: value }))

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (state === 'sending' || state === 'done') return

    for (const f of spec.fields) {
      if (f.kind === 'toggle' || f.kind === 'hidden') continue
      if (f.required && String(values[f.name] ?? '').trim() === '') {
        setState('error')
        setMessage(`${f.label} is needed.`)
        return
      }
    }

    setState('sending')
    setMessage('')
    try {
      const res = await fetch(`/w/${token}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'form', viewSpecId, index, values }),
      })
      const body = (await res.json()) as { ok: boolean; expired?: boolean; message?: string }
      if (body.expired) {
        setState('expired')
        return
      }
      if (!res.ok || !body.ok) {
        setState('error')
        setMessage(body.message ?? "That didn't go through.")
        return
      }
      setState('done')
      setMessage(body.message ?? 'Done.')
    } catch {
      setState('error')
      setMessage('The connection dropped before that could be saved.')
    }
  }

  if (state === 'expired') {
    return (
      <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-sm font-semibold">This link expired while you were filling it in</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Nothing was saved. Ask for a new one in the chat — or just tell me there instead.
        </p>
      </section>
    )
  }

  if (state === 'done') {
    return (
      <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
        <h2 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">{message}</h2>
        <p className="mt-1 text-sm text-emerald-800/80 dark:text-emerald-300/80">
          You can close this — the confirmation is in your chat.
        </p>
      </section>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
    >
      {spec.title ? (
        <div className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 className="text-sm font-semibold tracking-tight">{spec.title}</h2>
        </div>
      ) : null}

      <div className="space-y-4 px-4 py-4">
        {spec.fields.map((f) => (
          <Field key={f.name} field={f} value={values[f.name]} onChange={(v) => set(f.name, v)} />
        ))}
      </div>

      {state === 'error' && message ? (
        <p className="px-4 pb-2 text-sm text-rose-600 dark:text-rose-400">{message}</p>
      ) : null}

      <div className="border-t border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <button
          type="submit"
          disabled={state === 'sending'}
          className="w-full rounded-xl bg-neutral-900 px-4 py-3 text-base font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
        >
          {state === 'sending' ? 'Saving…' : 'Confirm'}
        </button>
      </div>
    </form>
  )
}

function Field({
  field,
  value,
  onChange,
}: {
  field: FormField
  value: string | boolean | undefined
  onChange: (v: string | boolean) => void
}) {
  if (field.kind === 'hidden') return null

  const label = (
    <label htmlFor={field.name} className="block text-sm font-medium">
      {field.label}
      {'required' in field && field.required ? <span className="text-rose-500"> *</span> : null}
    </label>
  )
  const help = field.help ? <p className="text-xs text-neutral-500 dark:text-neutral-400">{field.help}</p> : null

  if (field.kind === 'toggle') {
    return (
      <div className="flex items-start gap-3">
        <input
          id={field.name}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-0.5 size-5 shrink-0 rounded border-neutral-300 dark:border-neutral-700"
        />
        <span className="min-w-0">
          {label}
          {help}
        </span>
      </div>
    )
  }

  if (field.kind === 'choice') {
    return (
      <div className="space-y-1.5">
        {label}
        <div className="flex flex-wrap gap-2">
          {field.options.map((o) => {
            const active = String(value ?? '') === o.value
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onChange(o.value)}
                aria-pressed={active}
                className={`rounded-xl border px-3 py-2 text-sm ${
                  active
                    ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                    : 'border-neutral-300 dark:border-neutral-700'
                }`}
              >
                {o.label}
              </button>
            )
          })}
        </div>
        {help}
      </div>
    )
  }

  if (field.kind === 'select') {
    return (
      <div className="space-y-1.5">
        {label}
        <select
          id={field.name}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        >
          <option value="">Choose…</option>
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {help}
      </div>
    )
  }

  if (field.kind === 'textarea') {
    return (
      <div className="space-y-1.5">
        {label}
        <textarea
          id={field.name}
          rows={3}
          value={String(value ?? '')}
          placeholder={'placeholder' in field ? field.placeholder : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={INPUT}
        />
        {help}
      </div>
    )
  }

  const type =
    field.kind === 'number' || field.kind === 'money'
      ? 'number'
      : field.kind === 'date'
        ? 'date'
        : field.kind === 'time'
          ? 'time'
          : field.kind === 'phone'
            ? 'tel'
            : 'text'

  return (
    <div className="space-y-1.5">
      {label}
      <div className="relative">
        {field.kind === 'money' ? (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400">₹</span>
        ) : null}
        <input
          id={field.name}
          type={type}
          inputMode={field.kind === 'money' || field.kind === 'number' ? 'decimal' : undefined}
          value={String(value ?? '')}
          placeholder={'placeholder' in field ? field.placeholder : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={`${INPUT} ${field.kind === 'money' ? 'pl-7' : ''}`}
        />
      </div>
      {help}
    </div>
  )
}

export default FormView

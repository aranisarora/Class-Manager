'use client'

/**
 * components/view/setup-form.tsx — §7.1 step 1.
 *
 * "Setup form on the web surface — the form-shaped part in one screen, because
 *  a dozen chat round-trips is a dozen small waits. Business name, category,
 *  venues, operating pattern, cancellation window. One tap out of the chat,
 *  once, ever."
 *
 * Everything here is form-shaped and everything here is on this screen. The
 * timetable is NOT here on purpose (§7.1 step 2): it arrives as a photo, a
 * forwarded sheet or a voice note, and typing it into a web form would be the
 * single worst trade in the product.
 */

import { useState, type FormEvent, type ReactNode } from 'react'
import { BackToChat } from './back-to-chat'

export type SetupVenue = { id: string | null; name: string; address: string }

export type SetupValues = {
  name: string
  category: string
  timezone: string
  cancellationWindowHours: number
  morningBriefAt: string
  eveningDigestAt: string
  upiHandle: string
  operatingDays: number[]
  opensAt: string
  closesAt: string
  venues: SetupVenue[]
}

const DAYS = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
]

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Colombo',
  'Asia/Kathmandu',
  'Asia/Dhaka',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
]

const WINDOWS = [2, 4, 6, 12, 24, 48]

const INPUT =
  'w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-base outline-none placeholder:text-neutral-400 focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-300'
const LABEL = 'block text-sm font-medium'
const HELP = 'text-xs text-neutral-500 dark:text-neutral-400'

export function SetupForm({ token, initial }: { token: string; initial: SetupValues }) {
  const [v, setV] = useState<SetupValues>(initial)
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'expired' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const set = <K extends keyof SetupValues>(k: K, value: SetupValues[K]) => setV((s) => ({ ...s, [k]: value }))

  const toggleDay = (d: number) =>
    set(
      'operatingDays',
      v.operatingDays.includes(d) ? v.operatingDays.filter((x) => x !== d) : [...v.operatingDays, d].sort(),
    )

  const setVenue = (i: number, patch: Partial<SetupVenue>) =>
    set(
      'venues',
      v.venues.map((venue, idx) => (idx === i ? { ...venue, ...patch } : venue)),
    )

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (state === 'sending' || state === 'done') return
    if (!v.name.trim()) {
      setState('error')
      setMessage('I need the name people know you by.')
      return
    }
    setState('sending')
    setMessage('')
    try {
      const res = await fetch(`/w/${token}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'setup',
          ...v,
          venues: v.venues.filter((venue) => venue.name.trim() !== ''),
        }),
      })
      const body = (await res.json()) as { ok: boolean; expired?: boolean; message?: string }
      if (body.expired) {
        setState('expired')
        return
      }
      if (!res.ok || !body.ok) {
        setState('error')
        setMessage(body.message ?? "That didn't save.")
        return
      }
      setState('done')
      setMessage(body.message ?? 'Saved.')
    } catch {
      setState('error')
      setMessage('The connection dropped before that could be saved.')
    }
  }

  if (state === 'expired') {
    return (
      <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-sm font-semibold">This link expired while you were filling it in</h2>
        <p className={`mt-1 ${HELP}`}>Nothing was saved. Ask for a new one in the chat and it&rsquo;ll come back.</p>
      </section>
    )
  }

  if (state === 'done') {
    return (
      <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
        <h2 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">{message}</h2>
        <p className="mt-1 text-sm text-emerald-800/80 dark:text-emerald-300/80">
          The next thing is your timetable, and a photo of the whiteboard is enough.
        </p>
        {/* The sentence used to end "Back to the chat —" and there was nothing to tap.
            Now the words and the button are the same promise. */}
        <div className="mt-3">
          <BackToChat />
        </div>
      </section>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Section title="The basics">
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="name">
            What people call you
          </label>
          <input
            id="name"
            className={INPUT}
            value={v.name}
            placeholder="Sharwin Badminton Academy"
            onChange={(e) => set('name', e.target.value)}
          />
          <p className={HELP}>This is the name that shows up in every message.</p>
        </div>
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="category">
            What you teach
          </label>
          <input
            id="category"
            className={INPUT}
            value={v.category}
            placeholder="badminton"
            onChange={(e) => set('category', e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="timezone">
            Timezone
          </label>
          <select
            id="timezone"
            className={INPUT}
            value={v.timezone}
            onChange={(e) => set('timezone', e.target.value)}
          >
            {(TIMEZONES.includes(v.timezone) ? TIMEZONES : [v.timezone, ...TIMEZONES]).map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace('_', ' ')}
              </option>
            ))}
          </select>
        </div>
      </Section>

      <Section title="Where you run" note="Add every place you teach. You can add more later by just saying so.">
        <div className="space-y-3">
          {v.venues.map((venue, i) => (
            <div key={venue.id ?? `new-${i}`} className="space-y-2 rounded-xl bg-neutral-50 p-3 dark:bg-neutral-800/50">
              <div className="flex items-center gap-2">
                <input
                  className={INPUT}
                  value={venue.name}
                  placeholder="Court 1, Anna Nagar"
                  onChange={(e) => setVenue(i, { name: e.target.value })}
                />
                <button
                  type="button"
                  aria-label={`Remove ${venue.name || 'this place'}`}
                  onClick={() =>
                    set(
                      'venues',
                      v.venues.filter((_, idx) => idx !== i),
                    )
                  }
                  className="shrink-0 rounded-xl border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700"
                >
                  Remove
                </button>
              </div>
              <input
                className={INPUT}
                value={venue.address}
                placeholder="Address or landmark (optional)"
                onChange={(e) => setVenue(i, { address: e.target.value })}
              />
            </div>
          ))}
          <button
            type="button"
            onClick={() => set('venues', [...v.venues, { id: null, name: '', address: '' }])}
            className="rounded-xl border border-neutral-300 px-3 py-2 text-sm font-medium dark:border-neutral-700"
          >
            Add a place
          </button>
        </div>
      </Section>

      <Section title="When you run" note="Roughly is fine — the real timetable comes next, from a photo.">
        <div className="space-y-1.5">
          <span className={LABEL}>Days you normally run</span>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => {
              const on = v.operatingDays.includes(d.value)
              return (
                <button
                  key={d.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleDay(d.value)}
                  className={`w-12 rounded-xl border px-2 py-2 text-sm ${
                    on
                      ? 'border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900'
                      : 'border-neutral-300 dark:border-neutral-700'
                  }`}
                >
                  {d.label}
                </button>
              )
            })}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className={LABEL} htmlFor="opensAt">
              First class around
            </label>
            <input
              id="opensAt"
              type="time"
              className={INPUT}
              value={v.opensAt}
              onChange={(e) => set('opensAt', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className={LABEL} htmlFor="closesAt">
              Last class ends around
            </label>
            <input
              id="closesAt"
              type="time"
              className={INPUT}
              value={v.closesAt}
              onChange={(e) => set('closesAt', e.target.value)}
            />
          </div>
        </div>
      </Section>

      <Section title="Cancellations and money">
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="window">
            How much notice counts as a proper cancellation
          </label>
          <select
            id="window"
            className={INPUT}
            value={String(v.cancellationWindowHours)}
            onChange={(e) => set('cancellationWindowHours', Number(e.target.value))}
          >
            {WINDOWS.map((h) => (
              <option key={h} value={h}>
                {h} hours
              </option>
            ))}
          </select>
          <p className={HELP}>
            Cancel inside this and it still counts as a class taken. Outside it, it doesn&rsquo;t.
          </p>
        </div>
        <div className="space-y-1.5">
          <label className={LABEL} htmlFor="upi">
            UPI handle
          </label>
          <input
            id="upi"
            className={INPUT}
            value={v.upiHandle}
            placeholder="name@bank"
            inputMode="email"
            onChange={(e) => set('upiHandle', e.target.value)}
          />
          <p className={HELP}>This is what parents pay into. One handle is enough.</p>
        </div>
      </Section>

      <Section title="When I should message you" note="Two bookends a day, quiet in between.">
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className={LABEL} htmlFor="morning">
              Morning brief
            </label>
            <input
              id="morning"
              type="time"
              className={INPUT}
              value={v.morningBriefAt}
              onChange={(e) => set('morningBriefAt', e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className={LABEL} htmlFor="evening">
              Evening digest
            </label>
            <input
              id="evening"
              type="time"
              className={INPUT}
              value={v.eveningDigestAt}
              onChange={(e) => set('eveningDigestAt', e.target.value)}
            />
          </div>
        </div>
      </Section>

      {state === 'error' && message ? (
        <p className="text-sm text-rose-600 dark:text-rose-400">{message}</p>
      ) : null}

      <button
        type="submit"
        disabled={state === 'sending'}
        className="w-full rounded-xl bg-neutral-900 px-4 py-3 text-base font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
      >
        {state === 'sending' ? 'Saving…' : 'Save'}
      </button>
      <p className={`text-center ${HELP}`}>Nobody gets messaged by any of this.</p>
    </form>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
      <div className="border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {note ? <p className={`mt-0.5 ${HELP}`}>{note}</p> : null}
      </div>
      <div className="space-y-4 px-4 py-4">{children}</div>
    </section>
  )
}

export default SetupForm

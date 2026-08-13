'use client'

/**
 * The one shared clock (§17), plus the world picker.
 *
 * Domain time never comes from the browser: this bar reads `sim_clock` through the API and
 * moves it on demand. Advancing runs the jobs that fell due, so jumping to T-60 fires
 * `CO-COMING` and jumping to the evening fires the digest, in every open pane at once.
 */

import { useEffect, useMemo, useState } from 'react'
import {
  fmtDay,
  fmtDuration,
  fmtClockSeconds,
  isoToZonedInput,
  useEmulator,
  usePrimaryTimezone,
  zonedInputToIso,
  type ScenarioMeta,
} from '@/lib/emulator/state'
import { Btn, Chip, Spinner, cx } from './ui'

const STEPS: { label: string; ms: number }[] = [
  { label: '+15m', ms: 15 * 60_000 },
  { label: '+1h', ms: 60 * 60_000 },
  { label: '+4h', ms: 4 * 60 * 60_000 },
  { label: '+1d', ms: 24 * 60 * 60_000 },
]

function ConnectionDot() {
  const { state } = useEmulator()
  const map = {
    live: { c: 'bg-emerald-400', t: 'SSE live — panes update on push' },
    connecting: { c: 'bg-amber-400 animate-pulse', t: 'connecting to /api/emulator/stream' },
    reconnecting: { c: 'bg-amber-400 animate-pulse', t: 'stream dropped — reconnecting, polling meanwhile' },
    offline: { c: 'bg-rose-500', t: 'stream unavailable — falling back to polling' },
  }[state.connection]
  return (
    <span className="flex items-center gap-1.5" title={map.t}>
      <span className={cx('h-1.5 w-1.5 rounded-full', map.c)} />
      <span className="font-mono text-[10px] text-zinc-500">{state.connection}</span>
    </span>
  )
}

/**
 * Only until `GET /api/emulator/state` answers — and that route takes seconds, so this
 * is what the operator stares at on every cold load.
 *
 * It used to name "both academies", "ace · multi-coach" and "solo · one person", which
 * read as a list of the businesses in the world and is not one: these are **fixtures**
 * `seedWorld` can build, and picking one wipes whatever is there. Two things followed
 * from the mislabelling — the picker looked hardcoded because it is, and there was no
 * way to see or make a real business anywhere in the instrument. The tray owns that now
 * (`+ business`), and this control says what it actually does.
 */
const FALLBACK_SCENARIOS: ScenarioMeta[] = [
  { id: 'both', name: 'both fixtures', description: 'Two tenants at once — the isolation case' },
  { id: 'ace', name: 'multi-coach fixture', description: 'Multi-coach table tennis academy' },
  { id: 'solo', name: 'solo fixture', description: '§18 — one person, admin and coach' },
]

function WorldPicker() {
  const { state, actions } = useEmulator()
  const [choice, setChoice] = useState('')

  const scenarios = state.scenarios.length ? state.scenarios : FALLBACK_SCENARIOS
  const value = choice || state.scenario || scenarios[0].id
  const description = scenarios.find((s) => s.id === value)?.description ?? null
  const busy = !!state.busy.seed

  return (
    <div className="flex items-center gap-1.5">
      <span
        className="font-mono text-[10px] tracking-widest text-zinc-600 uppercase"
        title="canned worlds. Real businesses live in the tray — “+ business”."
      >
        fixture
      </span>
      <select
        value={value}
        onChange={(e) => setChoice(e.target.value)}
        title={description ?? undefined}
        className="max-w-[170px] rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200 focus:border-emerald-700 focus:outline-none"
      >
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <Btn
        tone="primary"
        disabled={busy || !value}
        title={description ?? 'wipe the world and seed this fixture'}
        onClick={() => {
          if (
            (state.contacts.length || state.academies.length) &&
            !window.confirm(`Seed "${value}"? Every business currently in the world goes.`)
          )
            return
          void actions.seed(value)
        }}
      >
        {busy ? <Spinner /> : 'seed'}
      </Btn>
      {state.scenario ? (
        <Chip tone="quiet" title="fixture this world was last seeded from">
          {state.scenario}
        </Chip>
      ) : null}
    </div>
  )
}

export function ClockBar() {
  const { state, actions } = useEmulator()
  const tz = usePrimaryTimezone()
  const [when, setWhen] = useState('')
  /**
   * Whether the field holds a value the *person* typed, rather than a mirror of the
   * clock. `dirty`, not `editing`, and the difference is the whole bug.
   *
   * This used to be `editing`, flipped by focus and blur, with an effect that
   * overwrote `when` from the live clock whenever `editing` was false — and
   * `editing` was in that effect's dependency array. **`onBlur` fires before
   * `onClick`.** So clicking `set` ran: blur → `editing = false` → effect → `when`
   * reverted to the clock's current value → *then* the click handler read `when`.
   * Every "set" submitted the time it already was, which is exactly
   * indistinguishable from the button doing nothing.
   *
   * Tracking dirtiness instead means the field stops mirroring the moment it is
   * typed into and stays that way until it is submitted or reset — a state that
   * blur cannot clear, because blur is not a decision.
   */
  const [dirty, setDirty] = useState(false)

  const nowMs = new Date(state.clock.nowIso).getTime()
  const drift = useMemo(() => nowMs - Date.now(), [nowMs])
  const next = state.clock.nextEventAtIso ? new Date(state.clock.nextEventAtIso).getTime() : null
  const busy = !!state.busy.clock || !!state.busy.tick

  useEffect(() => {
    if (!dirty) setWhen(isoToZonedInput(state.clock.nowIso, tz))
  }, [state.clock.nowIso, tz, dirty])

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-zinc-800 bg-zinc-900/90 px-3 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-[12px] font-semibold tracking-wide text-zinc-200">Class Manager</span>
        <span className="font-mono text-[10px] tracking-widest text-zinc-600 uppercase">emulator</span>
      </div>

      <span className="h-5 w-px bg-zinc-800" />

      <WorldPicker />

      <span className="h-5 w-px bg-zinc-800" />

      {/* the clock, always visible and prominent */}
      <div className="flex items-center gap-2">
        <div className="flex flex-col leading-none">
          <span
            className="font-mono text-[19px] font-semibold text-emerald-300 tabular-nums"
            title="simulated domain time — everything in this build reads it, nothing reads the wall clock"
          >
            {fmtClockSeconds(state.clock.nowIso, tz)}
          </span>
          <span className="mt-0.5 font-mono text-[9px] text-zinc-500">
            {fmtDay(state.clock.nowIso, tz)} · {tz}
          </span>
        </div>
        <div className="flex flex-col gap-0.5">
          <Chip
            tone={Math.abs(drift) < 60_000 ? 'quiet' : 'template'}
            title="offset between simulated time and real time"
          >
            {Math.abs(drift) < 60_000 ? 'live' : `${drift > 0 ? '+' : '-'}${fmtDuration(Math.abs(drift))}`}
          </Chip>
          {next ? (
            <Chip tone="catalog" title={`next scheduled work at ${fmtClockSeconds(state.clock.nextEventAtIso!, tz)}`}>
              next in {fmtDuration(next - nowMs)}
            </Chip>
          ) : (
            <Chip tone="quiet" title="nothing is scheduled ahead of the current time">
              nothing due
            </Chip>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        {STEPS.map((s) => (
          <Btn key={s.label} disabled={busy} onClick={() => void actions.advance(s.ms)} title={`advance ${s.label}`}>
            {s.label}
          </Btn>
        ))}
        <Btn
          tone="primary"
          disabled={busy}
          onClick={() => void actions.jumpToNextEvent()}
          title="jump to the next thing the scheduler would do"
        >
          → next event
        </Btn>
        <Btn disabled={busy} onClick={() => void actions.tick()} title="run everything already due, without moving time">
          run jobs
        </Btn>
      </div>

      <div className="flex items-center gap-1">
        <input
          type="datetime-local"
          value={when}
          onChange={(e) => {
            setDirty(true)
            setWhen(e.target.value)
          }}
          className={`rounded border bg-zinc-900 px-1.5 py-1 font-mono text-[11px] text-zinc-200 focus:outline-none ${
            dirty ? 'border-emerald-700 text-emerald-200' : 'border-zinc-700 focus:border-emerald-700'
          }`}
          title={`wall-clock time in ${tz}`}
        />
        <Btn
          // `onMouseDown` rather than `onClick`: the field may still hold focus, and
          // mousedown lands before any blur the click would cause. Belt and braces
          // alongside `dirty` — losing a typed time to an event-ordering quirk is the
          // sort of thing that reads as "the clock is broken".
          disabled={busy || !when}
          tone={dirty ? 'primary' : undefined}
          onMouseDown={() => {
            const iso = zonedInputToIso(when, tz)
            if (!iso) return actions.notify('error', 'could not read that date')
            setDirty(false)
            void actions.setClockTo(iso)
          }}
        >
          set
        </Btn>
        <Btn
          disabled={busy}
          tone="danger"
          onClick={() => {
            setDirty(false)
            void actions.resetClock()
          }}
          title="back to real time, offset 0"
        >
          reset
        </Btn>
      </div>

      <div className="ml-auto flex items-center gap-2">
        {busy ? <Spinner /> : null}
        <ConnectionDot />
        <Btn size="xs" active={state.showTray} onClick={() => actions.toggle('showTray')} title="toggle the contact tray">
          tray
        </Btn>
        <Btn size="xs" active={state.showLog} onClick={() => actions.toggle('showLog')} title="toggle the event log">
          log
        </Btn>
      </div>
    </header>
  )
}

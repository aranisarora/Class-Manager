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
  AUTO_DELIVERY_LABELS,
  fmtDay,
  fmtDuration,
  fmtClockSeconds,
  isoToZonedInput,
  useEmulator,
  useLiveNowIso,
  usePrimaryTimezone,
  zonedInputToIso,
  type AutoDelivery,
  type ScenarioMeta,
} from '@/lib/emulator/state'
import { Icon } from './icons'
import { Btn, Chip, Spinner, cx } from './ui'

const STEPS: { label: string; ms: number }[] = [
  { label: '+15m', ms: 15 * 60_000 },
  { label: '+1h', ms: 60 * 60_000 },
  { label: '+4h', ms: 4 * 60 * 60_000 },
  { label: '+1d', ms: 24 * 60 * 60_000 },
]

/**
 * Past this, a jump asks first.
 *
 * Twelve hours is chosen so the three small steps stay one tap — they are how
 * you walk a session's reminder ladder, and a prompt on each would be noise —
 * while `+1d` and anything typed into the date field have to be meant. The date
 * field is the one that actually needs it: a picker makes "three days from now"
 * exactly as cheap as "one hour from now", and the cost of the two differs by
 * every job in between.
 */
const CONFIRM_MS = 12 * 60 * 60_000

/**
 * What the bar is pointed at, and — the part that was missing — what a move
 * would therefore touch.
 *
 * A world move hits every academy *without* a clock of its own, which is a set
 * the client could not previously see at all. Naming it before the move is the
 * whole point: "advance 1d" reads like one act and can be eight.
 */
function useClockScope() {
  const { state } = useEmulator()
  const owned = useMemo(
    () => new Set(state.clock.tenantClocks.map((t) => t.academyId)),
    [state.clock.tenantClocks],
  )
  const scoped = state.clockScope ? (state.academies.find((a) => a.id === state.clockScope) ?? null) : null
  // Sorted by name so the list a confirm prints is stable between two reads of it.
  const ridingWorld = useMemo(
    () => state.academies.filter((a) => !owned.has(a.id)).sort((x, y) => x.name.localeCompare(y.name)),
    [state.academies, owned],
  )
  return { scope: state.clockScope, scoped, ridingWorld, owned }
}

/** One line naming the blast radius, for both the chip and the confirm text. */
function blastText(scoped: { name: string } | null, ridingWorld: { name: string }[], total: number): string {
  if (scoped) return `${scoped.name} alone — its own clock, nobody else's`
  if (ridingWorld.length === 0) return 'no academy — every one of them holds a clock of its own'
  const names = ridingWorld.map((a) => a.name)
  const shown = names.length <= 4 ? names.join(', ') : `${names.slice(0, 4).join(', ')} +${names.length - 4} more`
  return `${ridingWorld.length} of ${total} academies — ${shown}`
}

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
  const count = state.academies.length
  /**
   * How many academies are in the world over and above what the seeded fixture
   * accounts for — `both` builds two, `ace` and `solo` one each. Anything past
   * that arrived from `+ business`, `drive` or `probe` and is invisible in every
   * other reading of this bar.
   */
  const extraAcademies = count - (state.scenario === 'both' ? 2 : state.scenario ? 1 : 0)

  return (
    <div className="flex items-center gap-1.5">
      <span
        className="font-mono text-[10px] tracking-widest text-zinc-600 uppercase"
        title="canned worlds. Real businesses live in the tray — “+ business”."
      >
        seed
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
      {/*
        What is actually in the world, standing next to the control that would
        replace it.
        `state.scenario` is derived from whether the two fixture ids are present,
        so a world holding both fixtures *and* five academies left over from
        `drive` and `probe` runs reported "both" and nothing else. The label was
        true; the impression it gave — that the world is those two — was not, and
        it is the impression that decides how hard somebody thinks a clock jump
        will land.
      */}
      {state.booted ? (
        <Chip
          tone={extraAcademies > 0 ? 'warn' : 'quiet'}
          title={
            extraAcademies > 0
              ? `${count} academies in the world — ${extraAcademies} beyond the seeded fixture, ` +
                'most likely left over from earlier drive/probe runs. They hold real classes and ' +
                'contacts, and they ride the world clock along with everything else.'
              : 'every academy currently in the world'
          }
        >
          {count} {count === 1 ? 'academy' : 'academies'}
        </Chip>
      ) : null}
    </div>
  )
}

/**
 * §2.4's ladder, running on its own.
 *
 * Nothing in this build ever advanced a delivery: the emulator transport hands back a wire id
 * and stops, so a full run of jobs left every message in the world at `sent` and the delivery
 * half of §16.3's quality proxies had no realistic input at all. `auto ✓✓` moves messages one
 * rung per beat; `auto read` additionally opens the chat, which is a person's act and so is a
 * separate choice rather than something that just happens.
 */
function DeliveryPicker() {
  const { state, actions } = useEmulator()
  const modes: AutoDelivery[] = ['off', 'delivered', 'read']
  return (
    <div className="flex items-center gap-1">
      <span className="font-mono text-[10px] tracking-widest text-zinc-600 uppercase">delivery</span>
      <select
        value={state.autoDelivery}
        onChange={(e) => actions.setAutoDelivery(e.target.value as AutoDelivery)}
        title={
          'manual — nothing moves until you tap the ticks in a pane.\n' +
          'auto ✓✓ — every accepted message walks sent → delivered on its own.\n' +
          'auto read — and then delivered → read, as if the recipient opened the chat.'
        }
        className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200 focus:border-emerald-700 focus:outline-none"
      >
        {modes.map((m) => (
          <option key={m} value={m}>
            {AUTO_DELIVERY_LABELS[m]}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * Whose clock the controls to the right of it move.
 *
 * The route has taken an `academyId` since 0024 and the bar never sent one, so
 * every control here moved the world unconditionally. That is fine in a world
 * holding the two fixtures and quietly awful in one that has accumulated a few
 * academies from `drive` and `probe` runs, where "advance a day" runs a day of
 * jobs for every one of them.
 */
function ScopePicker() {
  const { state, actions } = useEmulator()
  const { scoped, ridingWorld, owned } = useClockScope()
  const busy = !!state.busy.clock || !!state.busy.tick

  return (
    <div className="flex items-center gap-1.5">
      <span className="font-mono text-[10px] tracking-widest text-zinc-600 uppercase">moves</span>
      <select
        value={state.clockScope}
        disabled={busy}
        onChange={(e) => actions.setClockScope(e.target.value)}
        title={
          'which clock every control here moves.\n\n' +
          'world — the shared clock. Every academy without one of its own follows it.\n' +
          'a named academy — that tenant alone, on a clock of its own (0024). ' +
          'Jobs are claimed against their own tenant\'s clock, so nobody else moves.'
        }
        className="max-w-[190px] rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200 focus:border-emerald-700 focus:outline-none"
      >
        <option value="">world clock</option>
        {[...state.academies]
          .sort((x, y) => x.name.localeCompare(y.name))
          .map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {owned.has(a.id) ? ' ·' : ''}
            </option>
          ))}
      </select>
      <Chip
        tone={scoped ? 'window' : ridingWorld.length > 2 ? 'warn' : 'quiet'}
        title={
          scoped
            ? 'this academy has been given a clock of its own, so moving it moves nothing else'
            : 'moving the world clock moves every academy that has no clock of its own — these'
        }
      >
        {scoped ? 'this academy only' : `moves ${ridingWorld.length}`}
      </Chip>
    </div>
  )
}

export function ClockBar() {
  const { state, actions } = useEmulator()
  const tz = usePrimaryTimezone()
  const { scoped, ridingWorld } = useClockScope()
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

  // The bar's own reading of the clock ticks: a simulated clock frozen at the last route's
  // answer looks like a stopped clock, and a stopped clock is the first thing a driver
  // distrusts about an instrument.
  const liveNowIso = useLiveNowIso()
  const nowMs = new Date(liveNowIso).getTime()
  const drift = useMemo(() => nowMs - Date.now(), [nowMs])
  const next = state.clock.nextEventAtIso ? new Date(state.clock.nextEventAtIso).getTime() : null
  const busy = !!state.busy.clock || !!state.busy.tick

  useEffect(() => {
    if (!dirty) setWhen(isoToZonedInput(state.clock.nowIso, tz))
  }, [state.clock.nowIso, tz, dirty])

  /**
   * The one guard on this bar, and it guards the thing that actually costs:
   * not the clock move, which is a single integer and trivially reversible, but
   * **the jobs the move runs on the way**. Every reminder, digest and dunning
   * message that falls due in the skipped span is generated and sent, each one a
   * model call. Winding the clock back afterwards un-sends none of it.
   *
   * So the text says what will run rather than what the number will become, and
   * it names the academies — because the failure this exists to stop is not
   * "moved too far", it is "moved too far *for seven tenants I wasn't driving*".
   */
  const confirmJump = (deltaMs: number, targetIso: string): boolean => {
    if (Math.abs(deltaMs) < CONFIRM_MS) return true
    const dir = deltaMs < 0 ? 'back' : 'forward'
    const blast = blastText(scoped, ridingWorld, state.academies.length)
    return window.confirm(
      `Move the clock ${dir} ${fmtDuration(Math.abs(deltaMs))}?\n\n` +
        `to   ${fmtClockSeconds(targetIso, tz)}\n` +
        `hits ${blast}\n\n` +
        'Every job due in that span runs, and every message it produces is sent. ' +
        'Moving the clock back afterwards does not undo any of it.',
    )
  }

  const stepJump = (ms: number) => {
    if (!confirmJump(ms, new Date(nowMs + ms).toISOString())) return
    void actions.advance(ms)
  }

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
            {fmtClockSeconds(liveNowIso, tz)}
          </span>
          <span className="mt-0.5 font-mono text-[9px] text-zinc-500">
            {fmtDay(liveNowIso, tz)} · {tz}
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

      <ScopePicker />

      <div className="flex items-center gap-1">
        {STEPS.map((s) => (
          <Btn
            key={s.label}
            disabled={busy}
            onClick={() => stepJump(s.ms)}
            title={
              s.ms >= CONFIRM_MS
                ? `advance ${s.label} — asks first, because it runs a day of jobs`
                : `advance ${s.label}`
            }
          >
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
            // Against the *simulated* now, not the browser's: this field sets domain
            // time, so "how far is this jump" is a question about the clock the bar
            // is showing. Measuring from real time would call a half-hour nudge a
            // four-day leap whenever the world was already days ahead.
            if (!confirmJump(new Date(iso).getTime() - nowMs, iso)) return
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
          title={
            scoped
              ? `drop ${scoped.name}'s own clock — it goes back to following the world, not to real time`
              : 'world clock back to real time, offset 0'
          }
        >
          reset
        </Btn>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <DeliveryPicker />
        {busy ? <Spinner /> : null}
        <ConnectionDot />
        {/* The two view controls that decide what a screenshot of this page is evidence OF.
            `chrome` puts the whole probe layer down, leaving the panes as a handset draws
            them; the theme forces light or dark rather than following the operator's OS,
            because most parents run light and most developers run dark. Both persist. */}
        <Btn
          size="xs"
          active={!state.chrome}
          onClick={() => actions.setChrome(!state.chrome)}
          title={
            state.chrome
              ? 'handset view — put the instrumentation down and see the panes exactly as a parent does'
              : 'instrumentation is hidden — bring back templates, costs, ttls and wire warnings'
          }
        >
          <Icon name="probe" size={12} />
          {state.chrome ? 'handset' : 'probing off'}
        </Btn>
        <Btn
          size="xs"
          onClick={() => actions.setWaTheme(state.waTheme === 'dark' ? 'light' : 'dark')}
          title="which WhatsApp theme the panes wear — what her phone looks like is not what yours does"
        >
          {state.waTheme}
        </Btn>
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

'use client'

/**
 * §17 — the emulator. A world, not four panes.
 *
 * The shared clock across the top, every contact in the world down the left, as many open
 * panes as fit across the middle, and the event log down the right. Nothing here talks to
 * the database directly: it drives the same `/api/emulator/*` surface a real webhook does,
 * so what works here is what happens in production.
 */

import { ClockBar } from '@/components/emulator/ClockBar'
import { ContactTray } from '@/components/emulator/ContactTray'
import { EventLog } from '@/components/emulator/EventLog'
import { FaultPanel } from '@/components/emulator/FaultPanel'
import { PaneDeck } from '@/components/emulator/PaneDeck'
import { Toasts } from '@/components/emulator/Toasts'
import { EmulatorProvider, useEmulator } from '@/lib/emulator/state'

function BootError() {
  const { state, actions } = useEmulator()
  if (!state.error) return null
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-rose-900 bg-rose-950/40 px-3 py-1.5">
      <span className="font-mono text-[10px] tracking-widest text-rose-400 uppercase">world unavailable</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-rose-200">{state.error}</span>
      <button
        type="button"
        onClick={() => void actions.refreshState()}
        className="rounded border border-rose-700 bg-rose-900/50 px-2 py-0.5 text-[11px] text-rose-100 hover:bg-rose-800/60"
      >
        retry
      </button>
    </div>
  )
}

function Workspace() {
  const { state } = useEmulator()
  return (
    // Full-bleed: the instrument owns the viewport and every scroll happens inside a column.
    <div className="fixed inset-0 flex flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      <ClockBar />
      <BootError />
      <div className="flex min-h-0 flex-1">
        {state.showTray ? (
          <div className="flex w-[264px] shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
            <ContactTray />
            <FaultPanel />
          </div>
        ) : null}
        <main className="min-w-0 flex-1">
          <PaneDeck />
        </main>
        {state.showLog ? <EventLog /> : null}
      </div>
      <Toasts />
    </div>
  )
}

export default function EmulatorPage() {
  return (
    <EmulatorProvider>
      <Workspace />
    </EmulatorProvider>
  )
}

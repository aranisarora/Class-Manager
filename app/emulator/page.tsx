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
import { OpsBar, OpsConfigProvider } from '@/components/emulator/OpsBar'
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
    //
    // `data-wa` defines WhatsApp's palette for the whole workspace, but only the surfaces
    // that ask for it — the tray, the deck, the panes — actually wear it. The clock bar and
    // the event log keep the instrument's own zinc, which is the point: the two layers are
    // told apart by looking, not by remembering which is which.
    <div data-wa={state.waTheme} className="fixed inset-0 flex flex-col overflow-hidden bg-zinc-950 text-zinc-200">
      <ClockBar />
      {/*
        Directly under the clock, because the first question an operator opens this page
        with — "am I looking at a real business or a scratch world?" — has to be answered
        before they touch anything, and the clock bar is where the eye already goes. The
        strip also carries the logout, which belongs to the deployment rather than to any
        pane, and which has nowhere else to live now that the console is behind a door.
      */}
      <OpsBar />
      <BootError />
      <div className="flex min-h-0 flex-1">
        {state.showTray ? (
          // 300px is WhatsApp Web's own floor for the chat list, and the tray needs it now
          // that a row carries a 49px avatar and a full line of preview text.
          <div
            className="flex w-[318px] shrink-0 flex-col"
            style={{ background: 'var(--wa-shell)', borderRight: '1px solid var(--wa-rule)' }}
          >
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
    /*
      `OpsConfigProvider` wraps `EmulatorProvider` rather than sitting inside it, because
      whether this world is a real business is a fact about the deployment and not about
      any world the emulator happens to have loaded — it outlives a reseed, a boot error
      and an empty database. Outside also means every consumer sees one answer: the strip
      renders the mode, and `useCapability` can hide a destructive control anywhere in the
      tree without a second fetch disagreeing with the first for a few hundred milliseconds.
    */
    <OpsConfigProvider>
      <EmulatorProvider>
        <Workspace />
      </EmulatorProvider>
    </OpsConfigProvider>
  )
}

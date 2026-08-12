'use client'

/** The horizontally scrolling row of panes. Each pane is independently scrolled and closable. */

import { useEmulator } from '@/lib/emulator/state'
import { Pane } from './Pane'

export function PaneDeck() {
  const { state, actions } = useEmulator()

  if (!state.panes.length) {
    return (
      <div className="flex h-full items-center justify-center bg-zinc-950 px-8">
        <div className="max-w-md text-center">
          <div className="font-mono text-[11px] tracking-widest text-zinc-600 uppercase">no panes open</div>
          <p className="mt-3 text-[13px] leading-relaxed text-zinc-400">
            Pick contacts from the tray to open them side by side. Two coaches on the same cover offer. A head
            coach and an assistant on the same register. A parent and their teenage player on separate numbers.
            Two academies at once, to prove nothing leaks between them.
          </p>
          <p className="mt-3 text-[12px] leading-relaxed text-zinc-600">
            Then move the shared clock and watch what code does on its own.
          </p>
          {state.contacts.length ? (
            <button
              type="button"
              onClick={() => {
                for (const c of state.contacts.slice(0, 3)) actions.openPane(c.id)
              }}
              className="mt-4 rounded border border-emerald-700/60 bg-emerald-900/40 px-3 py-1.5 text-[12px] text-emerald-200 hover:bg-emerald-800/50"
            >
              open the first three contacts
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-w-0 overflow-x-auto bg-zinc-950">
      {state.panes.map((id, i) => (
        <Pane key={id} contactId={id} index={i} count={state.panes.length} />
      ))}
      <div className="w-8 shrink-0" />
    </div>
  )
}

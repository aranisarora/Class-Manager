'use client'

/**
 * The row of panes, or the one pane that has taken the whole row.
 *
 * Each pane is independently scrolled and closable. Expanding is not a separate screen — it
 * is the same `Pane` given the whole width — so nothing about a conversation changes when you
 * blow it up, which is the only way the expanded view can be trusted as evidence.
 */

import { useEffect } from 'react'

import { useEmulator } from '@/lib/emulator/state'
import { Pane } from './Pane'

export function PaneDeck() {
  const { state, actions } = useEmulator()

  // The guard is local as well as in the reducer: `state/loaded` prunes a vanished contact,
  // but between a reseed landing and that dispatch there is a frame where `expanded` still
  // names it, and the deck would render one "not in this world" card at full width with
  // every other open pane hidden behind it.
  const expanded = state.expanded && state.panes.includes(state.expanded) ? state.expanded : ''

  // Escape leaves the expanded pane. A full-width view with no keyboard way out is the kind
  // of trap that makes people stop using the control at all.
  useEffect(() => {
    if (!expanded) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Not while typing into the composer or a sheet — Escape means "close this" there.
      const el = document.activeElement
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return
      actions.expandPane('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded, actions])

  if (!state.panes.length) {
    return (
      <div className="flex h-full items-center justify-center px-8" style={{ background: 'var(--wa-shell)' }}>
        <div className="max-w-md text-center">
          <div className="probe tracking-widest uppercase opacity-50">no chats open</div>
          <p className="mt-3 text-[13px] leading-relaxed" style={{ color: 'var(--wa-ink-dim)' }}>
            Pick contacts from the tray to open them side by side. Two coaches on the same cover offer. A head
            coach and an assistant on the same register. A parent and their teenage player on separate numbers.
            Two academies at once, to prove nothing leaks between them.
          </p>
          <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--wa-ink-faint)' }}>
            Then move the shared clock and watch what code does on its own.
          </p>
          {state.contacts.length ? (
            <button
              type="button"
              onClick={() => {
                for (const c of state.contacts.slice(0, 3)) actions.openPane(c.id)
              }}
              className="mt-4 rounded-full px-4 py-2 text-[13px] font-medium transition-transform hover:scale-[1.02]"
              style={{ background: 'var(--wa-accent)', color: 'var(--wa-unread-ink)' }}
            >
              open the first three contacts
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  if (expanded) {
    return (
      <div className="flex h-full min-w-0" style={{ background: 'var(--wa-shell)' }}>
        <Pane contactId={expanded} index={state.panes.indexOf(expanded)} count={state.panes.length} expanded />
      </div>
    )
  }

  return (
    <div className="pane-scroll flex h-full min-w-0 overflow-x-auto" style={{ background: 'var(--wa-shell)' }}>
      {state.panes.map((id, i) => (
        <Pane key={id} contactId={id} index={i} count={state.panes.length} />
      ))}
      <div className="w-8 shrink-0" />
    </div>
  )
}

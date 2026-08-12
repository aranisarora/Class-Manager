'use client'

/**
 * Every contact in the world, grouped by academy. Clicking one opens it as a pane.
 * Roles compose (§6.2), so a person can show `admin` and `coach` at once — that is the
 * solo operator, and it is why the tray shows roles as a set and never as a scalar.
 */

import { useMemo, useState } from 'react'
import { fmtDuration, useEmulator, windowState, type EmuContact } from '@/lib/emulator/state'
import { Chip, Empty, ROLE_SHORT, ROLE_TONE, STATE_TONE, cx } from './ui'

function ContactRow({ c, open, activity }: { c: EmuContact; open: boolean; activity: number }) {
  const { state, actions } = useEmulator()
  const win = windowState(c, state.clock.nowIso)
  return (
    <button
      type="button"
      onClick={() => (open ? actions.closePane(c.id) : actions.openPane(c.id))}
      title={open ? 'close this pane' : 'open as a pane'}
      className={cx(
        'group flex w-full items-start gap-1.5 border-l-2 px-2 py-1.5 text-left transition-colors',
        open
          ? 'border-l-emerald-500 bg-emerald-950/25 hover:bg-emerald-950/40'
          : 'border-l-transparent hover:bg-zinc-800/60',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1">
          <span className="truncate text-[12px] text-zinc-200">{c.name}</span>
          {activity > 0 && !open ? (
            <span className="ml-auto rounded-full bg-emerald-600 px-1.5 text-[9px] font-semibold text-emerald-50">
              {activity}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-1">
          {c.roles.length ? (
            c.roles.map((r) => (
              <Chip key={r} tone={ROLE_TONE[r] ?? 'neutral'}>
                {ROLE_SHORT[r] ?? r}
              </Chip>
            ))
          ) : (
            <Chip tone="quiet">no role</Chip>
          )}
          <Chip tone={STATE_TONE[String(c.state)] ?? 'quiet'}>{String(c.state)}</Chip>
          {c.optedOutAt ? <Chip tone="danger">opted out</Chip> : null}
          {!c.isPrimary ? <Chip tone="quiet" title="a second number for the same person">2nd no.</Chip> : null}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] text-zinc-600">
          <span className="truncate">{c.phone ?? '—'}</span>
          <span className={win.open ? 'text-emerald-500/80' : 'text-amber-600/80'}>
            {win.open ? `window ${fmtDuration(win.msLeft)}` : 'window closed'}
          </span>
        </span>
      </span>
    </button>
  )
}

export function ContactTray() {
  const { state, actions } = useEmulator()
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const match = (c: EmuContact) =>
      !needle ||
      c.name.toLowerCase().includes(needle) ||
      (c.phone ?? '').toLowerCase().includes(needle) ||
      c.roles.some((r) => String(r).toLowerCase().includes(needle)) ||
      String(c.state).toLowerCase().includes(needle)

    const byAcademy = new Map<string, EmuContact[]>()
    for (const c of state.contacts) {
      if (!match(c)) continue
      const list = byAcademy.get(c.academyId) ?? []
      list.push(c)
      byAcademy.set(c.academyId, list)
    }
    const known = state.academies.map((a) => ({ academy: a, contacts: byAcademy.get(a.id) ?? [] }))
    const orphanIds = [...byAcademy.keys()].filter((id) => !state.academies.some((a) => a.id === id))
    for (const id of orphanIds) {
      known.push({
        academy: {
          id,
          name: 'unknown academy',
          timezone: 'Asia/Kolkata',
          onboardingState: 'live',
          senderPhone: null,
          category: null,
          rail: null,
        },
        contacts: byAcademy.get(id) ?? [],
      })
    }
    return known
  }, [state.contacts, state.academies, q])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/60 px-2 py-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] tracking-widest text-zinc-500 uppercase">contacts</span>
          <span className="font-mono text-[10px] text-zinc-600">
            {state.panes.length} open · {state.contacts.length} total
          </span>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="filter by name, number, role…"
          className="mt-1.5 w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!state.contacts.length ? (
          <Empty>{state.loading ? 'loading the world…' : 'No contacts. Seed a world above.'}</Empty>
        ) : null}

        {groups.map(({ academy, contacts }) => {
          const isCollapsed = collapsed[academy.id]
          return (
            <div key={academy.id} className="border-b border-zinc-800/70">
              <button
                type="button"
                onClick={() => setCollapsed((s) => ({ ...s, [academy.id]: !s[academy.id] }))}
                className="flex w-full items-center gap-1.5 bg-zinc-900/40 px-2 py-1.5 text-left hover:bg-zinc-800/50"
              >
                <span className="font-mono text-[9px] text-zinc-600">{isCollapsed ? '▸' : '▾'}</span>
                <span className="truncate text-[11px] font-semibold tracking-wide text-zinc-300">{academy.name}</span>
                <span className="ml-auto flex items-center gap-1">
                  {academy.onboardingState !== 'live' ? (
                    <Chip tone="warn" title="§2.6 — nothing is sent until the admin says go">
                      {String(academy.onboardingState)}
                    </Chip>
                  ) : null}
                  <Chip tone="quiet">{contacts.length}</Chip>
                </span>
              </button>
              {!isCollapsed ? (
                <>
                  <div className="flex items-center gap-2 border-b border-zinc-800/60 px-2 pb-1 font-mono text-[9px] text-zinc-600">
                    <span title="sender number this academy routes through (§16.3)">
                      {academy.senderPhone ?? 'no sender'}
                    </span>
                    <span className="ml-auto">{academy.timezone}</span>
                  </div>
                  {contacts.length ? (
                    contacts.map((c) => (
                      <ContactRow
                        key={c.id}
                        c={c}
                        open={state.panes.includes(c.id)}
                        activity={state.activity[c.id] ?? 0}
                      />
                    ))
                  ) : (
                    <Empty>no matching contacts</Empty>
                  )}
                </>
              ) : null}
            </div>
          )
        })}
      </div>

      <div className="flex shrink-0 items-center gap-1 border-t border-zinc-800 bg-zinc-900/60 px-2 py-1">
        <button
          type="button"
          onClick={actions.closeAllPanes}
          disabled={!state.panes.length}
          className="text-[10px] text-zinc-500 hover:text-zinc-200 disabled:opacity-40"
        >
          close all panes
        </button>
        <button
          type="button"
          onClick={() => void actions.refreshState()}
          className="ml-auto text-[10px] text-zinc-500 hover:text-zinc-200"
        >
          reload world
        </button>
      </div>
    </div>
  )
}

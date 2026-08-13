'use client'

/**
 * Every contact in the world, grouped by academy. Clicking one opens it as a pane.
 * Roles compose (§6.2), so a person can show `admin` and `coach` at once — that is the
 * solo operator, and it is why the tray shows roles as a set and never as a scalar.
 */

import { useMemo, useState } from 'react'
import {
  fmtDuration,
  fmtTime,
  useEmulator,
  usePrimaryTimezone,
  windowState,
  type EmuContact,
} from '@/lib/emulator/state'
import { Btn, Chip, Empty, ROLE_SHORT, ROLE_TONE, STATE_TONE, Spinner, cx } from './ui'

function ContactRow({ c, open, activity }: { c: EmuContact; open: boolean; activity: number }) {
  const { state, actions } = useEmulator()
  const win = windowState(c, state.clock.nowIso)
  const tz = usePrimaryTimezone()
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
        {/* The last thing said, the way a chat list shows it — so which threads have
            history, and what state each one was left in, is visible without opening
            twelve panes. */}
        {c.lastMessageBody ? (
          <span className="mt-0.5 flex items-baseline gap-1">
            <span className="font-mono text-[9px] text-zinc-600">
              {c.lastMessageDirection === 'inbound' ? '←' : '→'}
            </span>
            <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-500">
              {c.lastMessageBody.replace(/\s+/g, ' ').trim()}
            </span>
            {c.lastMessageAt ? (
              <span className="shrink-0 font-mono text-[9px] text-zinc-600">
                {fmtTime(c.lastMessageAt, tz)}
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[9px] text-zinc-600">
          <span className="truncate">{c.phone ?? '—'}</span>
          {c.messageCount > 0 ? (
            <span title="messages in this thread, both directions">{c.messageCount} msg</span>
          ) : (
            <span className="text-zinc-700">no history</span>
          )}
          <span className={win.open ? 'text-emerald-500/80' : 'text-amber-600/80'}>
            {win.open ? `window ${fmtDuration(win.msLeft)}` : 'window closed'}
          </span>
        </span>
      </span>
    </button>
  )
}

/**
 * Add a person to the world without reseeding it. The role is wired for real — a client gets
 * an account, a player and an enrollment; a coach gets a coach row — because a contact with
 * no rows behind it can only be talked to, not tested.
 */
function NewContactForm({ onDone }: { onDone: () => void }) {
  const { state, actions } = useEmulator()
  const [name, setName] = useState('')
  const [role, setRole] = useState<'client' | 'coach' | 'admin' | 'prospect'>('client')
  const [academyId, setAcademyId] = useState(state.academies[0]?.id ?? '')
  const [phone, setPhone] = useState('')
  const busy = !!state.busy['contact/new']

  const academy = academyId || state.academies[0]?.id || ''
  const submit = async () => {
    if (!name.trim() || !academy || busy) return
    await actions.createTestContact({
      academyId: academy,
      name: name.trim(),
      role,
      ...(phone.trim() ? { phone: phone.trim() } : {}),
    })
    setName('')
    setPhone('')
    onDone()
  }

  return (
    <div className="space-y-1 border-b border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit()
          if (e.key === 'Escape') onDone()
        }}
        placeholder="name — e.g. Test Parent"
        className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none"
      />
      <div className="flex gap-1">
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as typeof role)}
          className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-300 focus:border-emerald-700 focus:outline-none"
        >
          <option value="client">client — account + player + enrollment</option>
          <option value="coach">coach — active</option>
          <option value="admin">admin</option>
          <option value="prospect">prospect — no rows, cold inbound</option>
        </select>
      </div>
      <div className="flex gap-1">
        <select
          value={academy}
          onChange={(e) => setAcademyId(e.target.value)}
          className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-300 focus:border-emerald-700 focus:outline-none"
        >
          {state.academies.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="number (optional)"
          className="w-[110px] rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 font-mono text-[10px] text-zinc-300 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-1">
        <Btn size="xs" tone="primary" disabled={busy || !name.trim() || !academy} onClick={() => void submit()}>
          {busy ? <Spinner /> : 'add'}
        </Btn>
        <Btn size="xs" tone="ghost" onClick={onDone}>
          cancel
        </Btn>
        <span className="ml-auto font-mono text-[9px] text-zinc-600">cleared by the next reseed</span>
      </div>
    </div>
  )
}

/**
 * Make a business. §17 wants a world you can build up, and the emulator had only the
 * two states a fixture gives you — all of it or none of it — so a second tenant cost
 * you the first. `createAcademy` writes the four rows §7.1 starts from (academy at
 * `setup`, person, contact, academy_admin) and **messages nobody**, which is the whole
 * point: from here the business is built by talking to it.
 */
function NewAcademyForm({ onDone }: { onDone: () => void }) {
  const { state, actions } = useEmulator()
  const [name, setName] = useState('')
  const [adminName, setAdminName] = useState('')
  const [category, setCategory] = useState('')
  const [phone, setPhone] = useState('')
  const busy = !!state.busy['academy/new']

  const submit = async () => {
    if (!name.trim() || !adminName.trim() || busy) return
    await actions.createAcademy({
      name: name.trim(),
      adminName: adminName.trim(),
      ...(category.trim() ? { category: category.trim() } : {}),
      ...(phone.trim() ? { adminPhone: phone.trim() } : {}),
    })
    setName('')
    setAdminName('')
    setCategory('')
    setPhone('')
    onDone()
  }

  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void submit()
    if (e.key === 'Escape') onDone()
  }
  const field =
    'w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none'

  return (
    <div className="space-y-1 border-b border-zinc-800 bg-zinc-950/60 px-2 py-1.5">
      <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={keys}
        placeholder="business — e.g. Green Park Badminton" className={field} />
      <input value={adminName} onChange={(e) => setAdminName(e.target.value)} onKeyDown={keys}
        placeholder="who runs it — e.g. Sharwin Rao" className={field} />
      <div className="flex gap-1">
        <input value={category} onChange={(e) => setCategory(e.target.value)} onKeyDown={keys}
          placeholder="badminton, carnatic vocal…" className={`min-w-0 flex-1 ${field}`} />
        <input value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={keys}
          placeholder="number (optional)"
          className="w-[110px] rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 font-mono text-[10px] text-zinc-300 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none" />
      </div>
      <div className="flex items-center gap-1">
        <Btn size="xs" tone="primary" disabled={busy || !name.trim() || !adminName.trim()} onClick={() => void submit()}>
          {busy ? <Spinner /> : 'create'}
        </Btn>
        <Btn size="xs" tone="ghost" onClick={onDone}>
          cancel
        </Btn>
        <span className="ml-auto font-mono text-[9px] text-zinc-600">starts at setup · messages nobody</span>
      </div>
    </div>
  )
}

export function ContactTray() {
  const { state, actions } = useEmulator()
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState(false)
  const [addingAcademy, setAddingAcademy] = useState(false)
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
          <span className="font-mono text-[10px] tracking-widest text-zinc-500 uppercase">world</span>
          <span className="font-mono text-[10px] text-zinc-600">
            {state.academies.length} business{state.academies.length === 1 ? '' : 'es'} · {state.contacts.length} contacts ·{' '}
            {state.panes.length} open
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter by name, number, role…"
            className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none"
          />
          <Btn
            size="xs"
            active={addingAcademy}
            title="create a business — starts at setup, messages nobody"
            onClick={() => {
              setAddingAcademy((s) => !s)
              setAdding(false)
            }}
          >
            + business
          </Btn>
          <Btn
            size="xs"
            active={adding}
            disabled={!state.academies.length}
            title={
              state.academies.length
                ? 'add a test contact to this world — no reseed needed'
                : 'create a business first'
            }
            onClick={() => {
              setAdding((s) => !s)
              setAddingAcademy(false)
            }}
          >
            + person
          </Btn>
        </div>
      </div>

      {addingAcademy ? <NewAcademyForm onDone={() => setAddingAcademy(false)} /> : null}
      {adding ? <NewContactForm onDone={() => setAdding(false)} /> : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!state.contacts.length && !state.academies.length ? (
          <Empty>
            {state.loading
              ? 'loading the world…'
              : 'Empty world. Seed a fixture from the clock bar, or “+ business” to build one by talking to it.'}
          </Empty>
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
                    <span>{academy.timezone}</span>
                    <button
                      type="button"
                      disabled={!!state.busy[`academy/drop:${academy.id}`] || academy.name === 'unknown academy'}
                      title="delete this business and everything in it"
                      onClick={() => {
                        if (!window.confirm(`Drop "${academy.name}" and everything in it? This cannot be undone.`)) return
                        void actions.dropAcademy(academy.id, academy.name)
                      }}
                      className="ml-auto text-[9px] text-zinc-600 hover:text-rose-400 disabled:opacity-40"
                    >
                      drop business
                    </button>
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

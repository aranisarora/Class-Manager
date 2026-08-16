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
  useLiveNowIso,
  usePrimaryTimezone,
  windowState,
  type EmuContact,
} from '@/lib/emulator/state'
import { Icon } from './icons'
import { Btn, Chip, Empty, ROLE_SHORT, ROLE_TONE, STATE_TONE, Spinner, cx } from './ui'
import { Avatar, WaUnread } from './wa-ui'

/**
 * One row of the chat list, at WhatsApp's own proportions: a 49px avatar, the name at 17px
 * over a single ellipsised line of the last message, the time top-right and the unread count
 * bottom-right.
 *
 * Underneath it, and only while the probe layer is up, sits the third line the handset has no
 * use for: roles (§6.2 compose, so a solo operator reads `admin coach` and never a scalar),
 * §11.2 contact state, the number, the thread size and the service window. That line is why
 * this tray is not just a chat list — but putting it INSIDE the row's own two lines, which is
 * where it used to live, is what stopped the tray from reading as one.
 */
function ContactRow({
  c,
  open,
  pinned,
  activity,
  nowIso,
  chrome,
}: {
  c: EmuContact
  open: boolean
  pinned: boolean
  activity: number
  nowIso: string
  chrome: boolean
}) {
  const { actions } = useEmulator()
  // The ticking now, passed in from the tray rather than read here: one timer for the whole
  // list instead of one per contact, and no row can claim a window is open minutes after it
  // closed (§14.7).
  const win = windowState(c, nowIso)
  const tz = usePrimaryTimezone()
  const preview = c.lastMessageBody?.replace(/\s+/g, ' ').trim()

  return (
    <div
      className="group relative"
      style={{ background: open ? 'var(--wa-active)' : undefined }}
    >
      <button
        type="button"
        onClick={() => (open ? actions.closePane(c.id) : actions.openPane(c.id))}
        title={open ? 'close this pane' : 'open as a pane'}
        className="flex w-full items-center gap-3 px-[15px] text-left transition-colors hover:bg-[var(--wa-hover)]"
        style={{ minHeight: 72 }}
      >
        <Avatar name={c.name} seed={c.id} size={49} ring={open} />
        <span className="min-w-0 flex-1 py-2.5">
          <span className="flex items-baseline gap-2">
            <span className="truncate text-[17px] leading-[22px]" style={{ color: 'var(--wa-ink)' }}>
              {c.name}
            </span>
            {c.lastMessageAt ? (
              <span
                className="ml-auto shrink-0 text-[12px]"
                style={{ color: activity > 0 && !open ? 'var(--wa-unread-bg)' : 'var(--wa-ink-dim)' }}
              >
                {fmtTime(c.lastMessageAt, tz)}
              </span>
            ) : null}
          </span>
          <span className="mt-[2px] flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[14px] leading-[19px]" style={{ color: 'var(--wa-ink-dim)' }}>
              {preview ? (
                <>
                  {c.lastMessageDirection === 'outbound' ? (
                    <span className="mr-1 inline-flex translate-y-[2px]" style={{ color: 'var(--wa-tick-plain)' }}>
                      <Icon name="check" size={13} />
                    </span>
                  ) : null}
                  {preview}
                </>
              ) : (
                <span style={{ color: 'var(--wa-ink-faint)' }}>no history</span>
              )}
            </span>
            {pinned ? (
              <span style={{ color: 'var(--wa-ink-dim)' }} title="pinned to the front of the deck">
                <Icon name="pin" size={13} />
              </span>
            ) : null}
            {activity > 0 && !open ? <WaUnread n={activity} /> : null}
          </span>
        </span>
      </button>

      {/* The pin lives outside the open/close button so one is not a way to hit the other.
          It is revealed on hover the way WhatsApp reveals a row's chevron, and stays visible
          once set so a pinned row says so without being pointed at. */}
      {open ? (
        <button
          type="button"
          onClick={() => (pinned ? actions.unpinPane(c.id) : actions.pinPane(c.id))}
          title={pinned ? 'unpin — let it move with the deck' : 'pin — hold this chat at the front of the deck'}
          aria-label={pinned ? 'unpin chat' : 'pin chat'}
          className={cx(
            'absolute top-1.5 right-1.5 rounded-full p-1.5 transition-opacity hover:bg-white/10',
            pinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
          style={{ color: pinned ? 'var(--wa-accent)' : 'var(--wa-ink-dim)' }}
        >
          <Icon name={pinned ? 'pinOff' : 'pin'} size={13} />
        </button>
      ) : null}

      {chrome ? (
        <div className="probe-dim flex flex-wrap items-center gap-1 px-[15px] pb-1.5">
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
          {!c.isPrimary ? (
            <Chip tone="quiet" title="a second number for the same person">
              2nd no.
            </Chip>
          ) : null}
          <span className="probe ml-auto flex items-center gap-1.5 opacity-70">
            <span className="truncate">{c.phone ?? '—'}</span>
            {c.messageCount > 0 ? (
              <span title="messages in this thread, both directions">{c.messageCount} msg</span>
            ) : null}
            <span className={win.open ? 'text-emerald-500/90' : 'text-amber-600/90'}>
              {win.open ? `window ${fmtDuration(win.msLeft)}` : 'window closed'}
            </span>
          </span>
        </div>
      ) : null}
    </div>
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
    <div className="space-y-1 border-b border-zinc-800 bg-zinc-950 px-2 py-1.5">
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
 *
 * What it makes is a *test* tenant, and the copy says so because the route decides it
 * rather than the operator. `POST /api/emulator/academy` stamps `is_sandbox` on anything
 * born here whenever the deployment is not itself a scratch box — that is what gives the
 * per-academy guard something to allow, since the id is minted inside `createAcademy` and
 * no caller can name a tenant that does not exist yet. The consequence is worth stating on
 * the form rather than leaving in a route comment: on the live console this button cannot
 * produce a real business, and onboarding a paying academy is not an act this console has.
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
    <div className="space-y-1 border-b border-zinc-800 bg-zinc-950 px-2 py-1.5">
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
        <span
          className="ml-auto font-mono text-[9px] text-zinc-600"
          title="A test tenant. On a live deployment the route marks the new academy academy.is_sandbox, which is what lets the scoped destructive controls — the clock, the composer, the tick marks, the drop controls — act on it and on nothing else. It starts at `setup` and messages nobody; the business is built from here by talking to it."
        >
          test tenant · messages nobody
        </span>
      </div>
    </div>
  )
}

export function ContactTray() {
  const { state, actions } = useEmulator()
  const nowIso = useLiveNowIso()
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
          senderLabel: null,
          // An academy the world state did not return, reconstructed from contacts alone.
          // Nothing here knows whether it is scratch, and the unbadged reading is the safe
          // one — the server decides what may be done to it either way.
          isSandbox: false,
          category: null,
          rail: null,
          upiHandle: null,
        },
        contacts: byAcademy.get(id) ?? [],
      })
    }
    return known
  }, [state.contacts, state.academies, q])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 py-1.5" style={{ background: 'var(--wa-header)', borderBottom: '1px solid var(--wa-rule)' }}>
        <div className="flex items-center justify-between">
          <span className="probe tracking-widest uppercase" style={{ color: 'var(--wa-ink-dim)' }}>world</span>
          <span className="probe" style={{ color: 'var(--wa-ink-dim)' }}>
            {state.academies.length} business{state.academies.length === 1 ? '' : 'es'} · {state.contacts.length} contacts ·{' '}
            {state.panes.length} open
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="filter by name, number, role…"
            className="min-w-0 flex-1 rounded-lg px-3 py-1.5 text-[13px] outline-none"
            style={{ background: 'var(--wa-input)', color: 'var(--wa-ink)' }}
          />
          <Btn
            size="xs"
            active={addingAcademy}
            title="create a test business — starts at setup, messages nobody, and on a live deployment is marked a sandbox so the scoped destructive controls will act on it"
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
            <div key={academy.id} style={{ borderBottom: '1px solid var(--wa-rule)' }}>
              <button
                type="button"
                onClick={() => setCollapsed((s) => ({ ...s, [academy.id]: !s[academy.id] }))}
                className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:brightness-110"
                style={{ background: 'var(--wa-header)' }}
              >
                <span className="probe" style={{ color: 'var(--wa-ink-dim)' }}>{isCollapsed ? '▸' : '▾'}</span>
                <span className="truncate text-[13px] font-medium" style={{ color: 'var(--wa-ink)' }}>{academy.name}</span>
                {/* Beside the name, not out with the counts on the right: the question this
                    answers — whose data am I about to touch? — is asked while reading the name,
                    and an answer that arrives after the eye has moved on is not an answer.

                    Only the sandbox is marked. Badging real tenants too would put a chip on
                    every row in the common case, and the thing worth noticing is the exception.
                    It carries the same emerald as OpsBar's mode badge so the strip at the top
                    and the row in the tray are visibly saying the same word.

                    The chip is a courtesy, not the defence: `requireSandboxAcademy` refuses on
                    the server for the same bit, so an unbadged row is protected whether or not
                    anybody looked. */}
                {academy.isSandbox ? (
                  <Chip
                    tone="window"
                    title="Scratch tenant (academy.is_sandbox). Clock moves, invented messages and forged receipts are allowed here and refused everywhere else."
                  >
                    sandbox
                  </Chip>
                ) : null}
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
                  <div className="probe flex items-center gap-2 px-2 pb-1" style={{ borderBottom: '1px solid var(--wa-rule)', color: 'var(--wa-ink-dim)' }}>
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
                      className="probe ml-auto hover:text-rose-400 disabled:opacity-40"
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
                        pinned={state.pinned.includes(c.id)}
                        chrome={state.chrome}
                        activity={state.activity[c.id] ?? 0}
                        nowIso={nowIso}
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

      <div className="flex shrink-0 items-center gap-1 px-2 py-1" style={{ background: 'var(--wa-header)', borderTop: '1px solid var(--wa-rule)' }}>
        {/* A pin is a statement that a thread outlives a sweep, so the sweep says what it
            will actually do rather than promising to close everything and then not. */}
        <button
          type="button"
          onClick={actions.closeAllPanes}
          disabled={state.panes.length === state.pinned.length}
          title={
            state.pinned.length
              ? `close every pane except the ${state.pinned.length} pinned`
              : 'close every open pane'
          }
          className="text-[10px] disabled:opacity-40 hover:opacity-100" style={{ color: 'var(--wa-ink-dim)' }}
        >
          {state.pinned.length ? 'close the rest' : 'close all panes'}
        </button>
        <button
          type="button"
          onClick={() => void actions.refreshState()}
          className="ml-auto text-[10px] hover:opacity-100" style={{ color: 'var(--wa-ink-dim)' }}
        >
          reload world
        </button>
      </div>
    </div>
  )
}

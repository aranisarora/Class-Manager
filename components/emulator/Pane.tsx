'use client'

/**
 * One contact, open as a pane. As many as fit — two coaches racing on [Claim this session],
 * a head coach and an assistant contending for the register, a parent and their teenage
 * player on separate numbers, two academies at once to prove tenant isolation (§17).
 *
 * Every pane reads the one shared clock and updates from the SSE stream, so a tap in pane A
 * is visible in pane B without a refresh.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  buttonDisabled,
  fmtDay,
  fmtDuration,
  useAcademyById,
  useContactById,
  useEmulator,
  useThread,
  windowState,
  type EmuMessage,
} from '@/lib/emulator/state'
import { Bubble } from './Bubble'
import { Composer } from './Composer'
import { MemoryPanel } from './MemoryPanel'
import { Btn, Chip, Empty, ROLE_SHORT, ROLE_TONE, STATE_TONE, Spinner, cx } from './ui'

function ListSheet({
  m,
  nowIso,
  onClose,
  onTap,
}: {
  m: EmuMessage
  nowIso: string
  onClose: () => void
  onTap: (actionId: string, label: string) => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!m.list) return null
  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-end bg-black/60" onClick={onClose}>
      <div
        className="max-h-[70%] overflow-y-auto rounded-t-lg border-t border-zinc-700 bg-zinc-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-3 py-2">
          <span className="text-[12px] font-semibold text-zinc-200">{m.list.buttonText}</span>
          <button type="button" onClick={onClose} className="text-[11px] text-zinc-500 hover:text-zinc-200">
            close
          </button>
        </div>
        {m.list.sections.map((s, si) => (
          <div key={si}>
            <div className="bg-zinc-950/60 px-3 py-1 font-mono text-[10px] tracking-wider text-zinc-500 uppercase">
              {s.title}
            </div>
            {s.rows.map((r, ri) => {
              const reason = buttonDisabled(r, nowIso)
              return (
                <button
                  key={`${r.actionId}:${ri}`}
                  type="button"
                  disabled={!!reason}
                  onClick={() => {
                    onTap(r.actionId, r.title)
                    onClose()
                  }}
                  className={cx(
                    'block w-full border-b border-zinc-800/70 px-3 py-2 text-left',
                    reason ? 'cursor-not-allowed text-zinc-600' : 'text-zinc-200 hover:bg-zinc-800',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12px]">{r.title}</span>
                    {reason ? <span className="font-mono text-[9px] text-zinc-600">{reason}</span> : null}
                  </div>
                  {r.description ? (
                    <div className="truncate text-[10px] text-zinc-500">{r.description}</div>
                  ) : null}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}

export function Pane({ contactId, index, count }: { contactId: string; index: number; count: number }) {
  const { state, actions } = useEmulator()
  const contact = useContactById(contactId)
  const academy = useAcademyById(contact?.academyId)
  const thread = useThread(contactId)
  const [sheet, setSheet] = useState<EmuMessage | null>(null)
  const [showMemory, setShowMemory] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)

  const tz = academy?.timezone ?? 'Asia/Kolkata'
  const nowIso = state.clock.nowIso
  const win = windowState(contact, nowIso)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && nearBottom.current) el.scrollTop = el.scrollHeight
  }, [thread.messages.length, thread.loadedAt])

  const eventsByMessage = useMemo(() => {
    const map = new Map<string, (typeof state.events)[number]>()
    for (const e of state.events) {
      if (e.messageId && !map.has(e.messageId) && (e.kind === 'send' || e.kind === 'suppress')) map.set(e.messageId, e)
    }
    return map
  }, [state.events])

  const lastOutbound = useMemo(
    () => [...thread.messages].reverse().find((m) => m.direction === 'outbound' && m.status !== 'suppressed'),
    [thread.messages],
  )

  const grouped = useMemo(() => {
    const out: { day: string; items: EmuMessage[] }[] = []
    for (const m of thread.messages) {
      const day = fmtDay(m.at, tz)
      const last = out[out.length - 1]
      if (last && last.day === day) last.items.push(m)
      else out.push({ day, items: [m] })
    }
    return out
  }, [thread.messages, tz])

  if (!contact) {
    return (
      <div className="flex w-[380px] shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="flex items-center justify-between border-b border-zinc-800 px-2 py-1.5">
          <span className="font-mono text-[11px] text-zinc-500">unknown contact</span>
          <Btn size="xs" tone="ghost" onClick={() => actions.closePane(contactId)}>
            ✕
          </Btn>
        </div>
        <Empty>
          This contact is not in the current world. Reseed, or close the pane.
          <div className="mt-1 font-mono text-[10px] break-all text-zinc-700">{contactId}</div>
        </Empty>
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-[380px] shrink-0 flex-col border-r border-zinc-800 bg-zinc-950">
      {/* header */}
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-1.5 px-2 pt-1.5">
          <span className="truncate text-[12px] font-semibold text-zinc-100">{contact.name}</span>
          {contact.roles.map((r) => (
            <Chip key={r} tone={ROLE_TONE[r] ?? 'neutral'}>
              {ROLE_SHORT[r] ?? r}
            </Chip>
          ))}
          {contact.isSolo ? <Chip tone="warn" title="§18 — admin and coach are the same person">solo</Chip> : null}
          <span className="ml-auto flex items-center gap-0.5">
            <Btn
              size="xs"
              tone="ghost"
              active={showMemory}
              title="what the bot knows about this person (§5) — the prompt's hot set and the record behind it"
              onClick={() => setShowMemory((s) => !s)}
            >
              🧠
            </Btn>
            <Btn size="xs" tone="ghost" title="move left" disabled={index === 0} onClick={() => actions.movePane(contactId, -1)}>
              ‹
            </Btn>
            <Btn
              size="xs"
              tone="ghost"
              title="move right"
              disabled={index === count - 1}
              onClick={() => actions.movePane(contactId, 1)}
            >
              ›
            </Btn>
            <Btn size="xs" tone="ghost" title="close pane" onClick={() => actions.closePane(contactId)}>
              ✕
            </Btn>
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1 px-2 py-1">
          <Chip tone="quiet" title="the academy this thread belongs to">
            {academy?.name ?? 'unknown academy'}
          </Chip>
          <Chip tone={STATE_TONE[String(contact.state)] ?? 'quiet'} title="§11.2 contact state">
            {String(contact.state)}
          </Chip>
          {contact.optedOutAt ? <Chip tone="danger">opted out</Chip> : null}
          <Chip
            tone={win.open ? 'window' : 'template'}
            title={
              win.open
                ? 'inside the 24h service window — replies are free-form and free (§14.7)'
                : 'outside the window — anything proactive must go on one of the eight templates (§16.2)'
            }
          >
            {win.open ? `window ${fmtDuration(win.msLeft)}` : 'window closed'}
          </Chip>
        </div>
        <div className="flex items-center gap-2 border-t border-zinc-800/70 px-2 py-1 font-mono text-[9px] text-zinc-500">
          <span title="the contact's own number">{contact.phone ?? 'no number'}</span>
          <span className="text-zinc-700">→</span>
          <span title="the sender number this academy routes through (§16.3)">{academy?.senderPhone ?? 'sender ?'}</span>
          <span className="ml-auto" title="timestamps render in the academy's timezone">
            {tz}
          </span>
        </div>
      </div>

      {/* thread */}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-[repeating-linear-gradient(45deg,rgba(255,255,255,0.012)_0px,rgba(255,255,255,0.012)_2px,transparent_2px,transparent_6px)] py-2"
      >
        {thread.error ? (
          <div className="mx-2 rounded border border-rose-900 bg-rose-950/40 px-2 py-1.5 font-mono text-[10px] text-rose-300">
            {thread.error}
          </div>
        ) : null}
        {!thread.messages.length && thread.loading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : null}
        {!thread.messages.length && !thread.loading && !thread.error ? (
          <Empty>
            Nothing has been said in this thread yet.
            <br />
            Type something, or advance the clock and let a job start it.
          </Empty>
        ) : null}

        {grouped.map((g) => (
          <div key={g.day}>
            <div className="my-1.5 flex justify-center">
              <span className="rounded bg-zinc-800/70 px-2 py-0.5 font-mono text-[9px] tracking-wide text-zinc-400">
                {g.day}
              </span>
            </div>
            {g.items.map((m) => (
              <Bubble
                key={m.id}
                m={m}
                tz={tz}
                nowIso={nowIso}
                meta={eventsByMessage.get(m.id) ?? null}
                senderFallback={academy?.senderPhone ?? null}
                busyTap={(actionId) => !!state.busy[`tap:${actionId}`]}
                onTap={(actionId, label) => void actions.tapAction(contactId, actionId, label)}
                onOpenList={setSheet}
                onMarkRead={(messageId) => void actions.markRead(contactId, messageId)}
              />
            ))}
          </div>
        ))}
      </div>

      {showMemory ? <MemoryPanel contactId={contactId} /> : null}

      <Composer
        busy={!!state.busy[`send:${contactId}`]}
        optedOut={!!contact.optedOutAt}
        onSendText={(text) => void actions.sendText(contactId, text)}
        onSendMedia={(media, caption) => void actions.sendMedia(contactId, media, caption)}
        onMarkRead={() => lastOutbound && void actions.markRead(contactId, lastOutbound.id)}
        markReadDisabled={!lastOutbound || !!state.busy[`read:${lastOutbound?.id}`]}
      />

      {sheet ? (
        <ListSheet
          m={sheet}
          nowIso={nowIso}
          onClose={() => setSheet(null)}
          onTap={(actionId, label) => void actions.tapAction(contactId, actionId, label)}
        />
      ) : null}
    </div>
  )
}

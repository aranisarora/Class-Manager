'use client'

/**
 * One contact, open as a pane — and the pane is a handset.
 *
 * As many as fit: two coaches racing on [Claim this session], a head coach and an assistant
 * contending for the register, a parent and their teenage player on separate numbers, two
 * academies at once to prove tenant isolation (§17). Every pane reads the one shared clock
 * and updates from the SSE stream, so a tap in pane A is visible in pane B without a refresh.
 *
 * The chat is drawn as WhatsApp draws it. The emulator's own instrumentation — the academy
 * behind the thread, the contact's §11.2 state, the sender number, the timezone the stamps
 * are in — hangs off it in the probe idiom and folds away entirely with `chrome`. The header
 * subtitle is the 24h window (§14.7) rather than "last seen", because that is this product's
 * version of the same fact: whether you can say something to this person right now.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  buttonDisabled,
  fmtDay,
  fmtDuration,
  useAcademyById,
  useContactById,
  useEmulator,
  useLiveNowIso,
  useThread,
  windowState,
  type EmuMessage,
} from '@/lib/emulator/state'
import { Bubble } from './Bubble'
import { Composer } from './Composer'
import { FlowSheet } from './FlowSheet'
import { Icon } from './icons'
import { MemoryPanel } from './MemoryPanel'
import { MoneyPanel } from './MoneyPanel'
import { Chip, Empty, ROLE_SHORT, ROLE_TONE, STATE_TONE, Spinner, cx } from './ui'
import { Avatar, WaIconButton, WaPill } from './wa-ui'

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
    <div className="absolute inset-0 z-20 flex flex-col justify-end bg-black/50" onClick={onClose}>
      <div
        className="max-h-[70%] overflow-y-auto rounded-t-lg"
        style={{ background: 'var(--wa-shell)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="sticky top-0 flex items-center justify-between px-4 py-3"
          style={{ background: 'var(--wa-shell)', borderBottom: '1px solid var(--wa-rule)' }}
        >
          <span className="text-[15px] font-medium" style={{ color: 'var(--wa-ink)' }}>
            {m.list.buttonText}
          </span>
          <WaIconButton label="close" onClick={onClose}>
            <Icon name="close" size={18} />
          </WaIconButton>
        </div>
        {m.list.sections.map((s, si) => (
          <div key={si}>
            <div className="px-4 py-2 text-[13px] font-medium" style={{ color: 'var(--wa-accent)' }}>
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
                  className={cx('block w-full px-4 py-2.5 text-left', reason ? 'cursor-not-allowed' : 'hover:bg-white/5')}
                  style={{ borderBottom: '1px solid var(--wa-rule)' }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className="truncate text-[15px]"
                      style={{ color: reason ? 'var(--wa-ink-faint)' : 'var(--wa-ink)' }}
                    >
                      {r.title}
                    </span>
                    {reason ? <span className="probe opacity-70">{reason}</span> : null}
                  </div>
                  {r.description ? (
                    <div className="truncate text-[13px]" style={{ color: 'var(--wa-ink-dim)' }}>
                      {r.description}
                    </div>
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

export function Pane({
  contactId,
  index,
  count,
  expanded = false,
}: {
  contactId: string
  index: number
  count: number
  expanded?: boolean
}) {
  const { state, actions } = useEmulator()
  const contact = useContactById(contactId)
  const academy = useAcademyById(contact?.academyId)
  const thread = useThread(contactId)
  const [sheet, setSheet] = useState<EmuMessage | null>(null)
  const [formSheet, setFormSheet] = useState<EmuMessage | null>(null)
  const [showMemory, setShowMemory] = useState(false)
  const [showMoney, setShowMoney] = useState(false)
  const [find, setFind] = useState<string | null>(null)
  const [atBottom, setAtBottom] = useState(true)
  const scroller = useRef<HTMLDivElement>(null)
  const nearBottom = useRef(true)

  const chrome = state.chrome
  const pinned = state.pinned.includes(contactId)
  const tz = academy?.timezone ?? 'Asia/Kolkata'
  // Ticking, not the last value a route happened to return: the window countdown and every
  // action's ttl are the two things in this pane only true at an instant (§14.7, §2.2).
  const nowIso = useLiveNowIso()
  const win = windowState(contact, nowIso)

  const toBottom = useCallback(() => {
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useLayoutEffect(() => {
    if (nearBottom.current) toBottom()
  }, [thread.messages.length, thread.loadedAt, toBottom])

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

  const nextRung: 'delivered' | 'read' | null =
    lastOutbound?.status === 'sent' ? 'delivered' : lastOutbound?.status === 'delivered' ? 'read' : null

  /**
   * Search inside the thread, the way WhatsApp's own does: it FILTERS rather than scrolls to
   * a hit. A long-running world puts hundreds of messages in a pane, and "show me every time
   * the fee came up" is the question actually being asked of it.
   */
  const visible = useMemo(() => {
    const q = find?.trim().toLowerCase()
    if (!q) return thread.messages
    return thread.messages.filter((m) => m.body.toLowerCase().includes(q))
  }, [thread.messages, find])

  const grouped = useMemo(() => {
    const out: { day: string; items: EmuMessage[] }[] = []
    for (const m of visible) {
      const day = fmtDay(m.at, tz)
      const last = out[out.length - 1]
      if (last && last.day === day) last.items.push(m)
      else out.push({ day, items: [m] })
    }
    return out
  }, [visible, tz])

  if (!contact) {
    return (
      <div
        className={cx('flex h-full flex-col', expanded ? 'w-full min-w-0' : 'w-[400px] shrink-0')}
        style={{ background: 'var(--wa-shell)', borderRight: '1px solid var(--wa-rule)' }}
      >
        <div
          className="flex items-center justify-between px-3 py-2"
          style={{ background: 'var(--wa-header)', borderBottom: '1px solid var(--wa-rule)' }}
        >
          <span className="probe opacity-70">unknown contact</span>
          <WaIconButton label="close pane" onClick={() => actions.closePane(contactId)}>
            <Icon name="close" size={18} />
          </WaIconButton>
        </div>
        <Empty>
          This contact is not in the current world. Reseed, or close the pane.
          <div className="probe mt-1 break-all opacity-60">{contactId}</div>
        </Empty>
      </div>
    )
  }

  return (
    <div
      data-wa={state.waTheme}
      className={cx('relative flex h-full flex-col', expanded ? 'w-full min-w-0' : 'w-[400px] shrink-0')}
      style={{
        background: 'var(--wa-shell)',
        borderRight: '1px solid var(--wa-rule)',
        // WhatsApp Web caps a bubble at 65% of the message column. 65% of a 400px pane is
        // 260px, which wraps a two-word reply — so a pane in the deck takes the value a
        // narrow viewport takes, and only a pane wide enough for it gets the real one.
        ['--wa-bubble-max' as string]: expanded ? '65%' : '85%',
      }}
    >
      {/* ---------------- conversation header ---------------- */}
      <div className="shrink-0" style={{ background: 'var(--wa-header)' }}>
        <div className="flex items-center gap-2.5 px-3" style={{ height: 59 }}>
          <Avatar name={contact.name} seed={contact.id} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <span className="truncate text-[16px] leading-[21px]" style={{ color: 'var(--wa-ink)' }}>
                {contact.name}
              </span>
              {pinned ? (
                <span style={{ color: 'var(--wa-ink-dim)' }} title="pinned to the front of the deck">
                  <Icon name="pin" size={12} />
                </span>
              ) : null}
            </div>
            {/* WhatsApp puts "online / last seen" here. This product's equivalent fact is the
                service window: whether anything can be said to this person right now without
                a template (§14.7). */}
            <div className="truncate text-[13px] leading-[17px]" style={{ color: 'var(--wa-ink-dim)' }}>
              {contact.optedOutAt ? (
                <span style={{ color: '#f15c6d' }}>opted out</span>
              ) : win.open ? (
                <>window open · {fmtDuration(win.msLeft)} left</>
              ) : (
                <>window closed · templates only</>
              )}
            </div>
          </div>

          {/* Only the four controls a handset would plausibly have. Memory, money and the
              deck-reordering arrows are the emulator talking, so they live in the probe row
              below — which is also what stops seven buttons from squeezing the name and
              subtitle into an ellipsis in a 400px pane. */}
          <div className="flex shrink-0 items-center gap-0.5">
            <WaIconButton
              label="search in this chat"
              active={find !== null}
              onClick={() => setFind((f) => (f === null ? '' : null))}
            >
              <Icon name="search" size={18} />
            </WaIconButton>
            <WaIconButton
              label={
                pinned
                  ? 'unpin — let it move with the deck'
                  : 'pin — hold this thread at the front, through close-the-rest and reloads'
              }
              active={pinned}
              onClick={() => (pinned ? actions.unpinPane(contactId) : actions.pinPane(contactId))}
            >
              <Icon name={pinned ? 'pinOff' : 'pin'} size={17} />
            </WaIconButton>
            <WaIconButton
              label={expanded ? 'back to the deck (Esc)' : 'fill the deck with this chat'}
              active={expanded}
              onClick={() => actions.expandPane(expanded ? '' : contactId)}
            >
              <Icon name={expanded ? 'collapse' : 'expand'} size={17} />
            </WaIconButton>
            <WaIconButton label="close pane" tone="danger" onClick={() => actions.closePane(contactId)}>
              <Icon name="close" size={18} />
            </WaIconButton>
          </div>
        </div>

        {find !== null ? (
          <div className="px-3 pb-2">
            <input
              autoFocus
              value={find}
              onChange={(e) => setFind(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setFind(null)}
              placeholder="search in this chat…"
              className="w-full rounded-lg px-3 py-1.5 text-[14px] outline-none"
              style={{ background: 'var(--wa-input)', color: 'var(--wa-ink)' }}
            />
          </div>
        ) : null}

        {/* ---------------- probe: what the emulator knows about this thread ---------------- */}
        {chrome ? (
          <div className="probe-dim flex flex-wrap items-center gap-1 px-3 pb-1.5">
            <button
              type="button"
              onClick={() => setShowMemory((s) => !s)}
              title="what the bot knows about this person (§5) — the prompt's hot set and the record behind it"
              className={cx('rounded px-1 py-0.5 hover:bg-white/10', showMemory && 'bg-white/10')}
              style={{ color: showMemory ? 'var(--wa-ink)' : 'var(--wa-ink-dim)' }}
            >
              <Icon name="memory" size={13} />
            </button>
            <button
              type="button"
              onClick={() => setShowMoney((s) => !s)}
              title="the tally and what is owed (§6.4), and — for an admin — the control that attests a rail 1 payment (§11.5)"
              className={cx('rounded px-1 py-0.5 hover:bg-white/10', showMoney && 'bg-white/10')}
              style={{ color: showMoney ? 'var(--wa-ink)' : 'var(--wa-ink-dim)' }}
            >
              <Icon name="money" size={13} />
            </button>
            {!expanded ? (
              <>
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => actions.movePane(contactId, -1)}
                  title="move this pane left in the deck"
                  className="rounded px-1 py-0.5 disabled:opacity-30 enabled:hover:bg-white/10"
                  style={{ color: 'var(--wa-ink-dim)' }}
                >
                  <Icon name="chevronLeft" size={13} />
                </button>
                <button
                  type="button"
                  disabled={index === count - 1}
                  onClick={() => actions.movePane(contactId, 1)}
                  title="move this pane right in the deck"
                  className="rounded px-1 py-0.5 disabled:opacity-30 enabled:hover:bg-white/10"
                  style={{ color: 'var(--wa-ink-dim)' }}
                >
                  <Icon name="chevronRight" size={13} />
                </button>
              </>
            ) : null}
            <Chip tone="quiet" title="the academy this thread belongs to">
              {academy?.name ?? 'unknown academy'}
            </Chip>
            {contact.roles.map((r) => (
              <Chip key={r} tone={ROLE_TONE[r] ?? 'neutral'}>
                {ROLE_SHORT[r] ?? r}
              </Chip>
            ))}
            {contact.isSolo ? (
              <Chip tone="warn" title="§18 — admin and coach are the same person">
                solo
              </Chip>
            ) : null}
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
            <span className="probe ml-auto flex items-center gap-1.5 opacity-70">
              <span title="the contact's own number">{contact.phone ?? 'no number'}</span>
              <span className="opacity-50">→</span>
              {/* §16.3's accepted trade-off, where it is actually paid: this is the name at the
                  top of this person's chat, and it is the shared number's, not the academy's.
                  Open two academies side by side and both panes say the same thing here —
                  which is exactly why the academy's name has to lead every message body. */}
              <span title="what this contact sees as the chat's name — one number, many academies (§16.3)">
                {academy?.senderLabel ?? 'Class Manager'}
              </span>
              <span title="the sender number this academy routes through (§16.3)">
                {academy?.senderPhone ?? 'sender ?'}
              </span>
              <span title="timestamps render in the academy's timezone">{tz}</span>
            </span>
          </div>
        ) : null}
      </div>

      {/* ---------------- thread ---------------- */}
      {/* The wallpaper is a layer behind the scroller, not the scroller itself. Its tile
          sheet rides on an absolutely-positioned pseudo-element, and inside a scroll
          container that resolves against the visible box — so it covered the first
          screenful and scrolled off with the messages, leaving bare canvas below. Sitting
          on a wrapper that never scrolls, it stays put under the thread the way the real
          wallpaper does. */}
      <div className="wa-wallpaper relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
            nearBottom.current = near
            setAtBottom(near)
          }}
          className="pane-scroll relative min-h-0 flex-1 py-2"
        >
          {thread.error ? (
            <div className="probe mx-3 rounded border border-rose-900 bg-rose-950/40 px-2 py-1.5 text-rose-300">
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
          {thread.messages.length && !visible.length ? (
            <Empty>
              No message in this thread contains “{find}”.
            </Empty>
          ) : null}

          {grouped.map((g) => (
            <div key={g.day}>
              <WaPill>{g.day}</WaPill>
              {g.items.map((m, i) => (
                <Bubble
                  key={m.id}
                  m={m}
                  tz={tz}
                  nowIso={nowIso}
                  chrome={chrome}
                  tight={i > 0 && g.items[i - 1].direction === m.direction}
                  meta={eventsByMessage.get(m.id) ?? null}
                  senderFallback={academy?.senderPhone ?? null}
                  busyTap={(actionId) => !!state.busy[`tap:${actionId}`]}
                  busyFlow={(flowToken) => !!state.busy[`flow:${flowToken}`]}
                  onTap={(actionId, label) => void actions.tapAction(contactId, actionId, label)}
                  onOpenList={setSheet}
                  onOpenFlow={setFormSheet}
                  onAdvanceStatus={(messageId, status) => void actions.advanceStatus(contactId, messageId, status)}
                />
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* WhatsApp's jump-to-latest. Only drawn when it would do something — a button that is
          always there teaches you to ignore it. */}
      {!atBottom && visible.length ? (
        <button
          type="button"
          onClick={toBottom}
          title="jump to the latest message"
          aria-label="jump to the latest message"
          className="absolute right-4 bottom-[86px] z-10 flex h-9 w-9 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-105"
          style={{ background: 'var(--wa-header)', color: 'var(--wa-ink-dim)' }}
        >
          <Icon name="jumpDown" size={18} />
        </button>
      ) : null}

      {showMemory ? <MemoryPanel contactId={contactId} /> : null}
      {showMoney ? <MoneyPanel contactId={contactId} tz={tz} /> : null}

      <Composer
        busy={!!state.busy[`send:${contactId}`]}
        optedOut={!!contact.optedOutAt}
        chrome={chrome}
        onSendText={(text) => void actions.sendText(contactId, text)}
        onSendMedia={(media, caption) => void actions.sendMedia(contactId, media, caption)}
        // The newest outbound message's next rung, so the ladder can be walked from the
        // composer without hunting for the right bubble (§2.4).
        nextRung={nextRung}
        onAdvanceStatus={() => {
          if (lastOutbound && nextRung) void actions.advanceStatus(contactId, lastOutbound.id, nextRung)
        }}
        advanceDisabled={!lastOutbound || !nextRung || !!state.busy[`read:${lastOutbound?.id}`]}
      />

      {sheet ? (
        <ListSheet
          m={sheet}
          nowIso={nowIso}
          onClose={() => setSheet(null)}
          onTap={(actionId, label) => void actions.tapAction(contactId, actionId, label)}
        />
      ) : null}

      {formSheet?.flow ? (
        <FlowSheet
          flow={formSheet.flow}
          nowIso={nowIso}
          busy={!!state.busy[`flow:${formSheet.flow.flowToken}`]}
          onClose={() => setFormSheet(null)}
          onSubmit={(responseJson, summary) => {
            setFormSheet(null)
            void actions.submitFlow(contactId, formSheet.flow!.flowToken, responseJson, summary)
          }}
        />
      ) : null}
    </div>
  )
}

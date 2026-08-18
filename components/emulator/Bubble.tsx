'use client'

/**
 * One message, drawn twice over.
 *
 * **The handset layer** is WhatsApp: the bubble, its tail, the wallpaper it sits on, the time
 * and ticks floated into the bottom-right of the last line, the reply buttons as cards under
 * the message. Nothing in it is invented. If it renders here it should be indistinguishable
 * from a screenshot, because "is this what the parent sees?" is the question this whole
 * surface exists to answer and until now it was answered by a diagram.
 *
 * **The probe layer** is everything the emulator knows that WhatsApp does not — the template
 * that carried it (§16.2), the catalog moment behind it (§12), the cost of the conversation
 * it opened, the ttl left on an action (§2.2), what the wire would refuse (§17). It is
 * monospace, it is dimmed until wanted, and it is drawn OUTSIDE the bubble on purpose.
 *
 * The separation is the design. Every one of these facts used to sit inside or on top of the
 * bubble, which meant no screenshot of this pane was ever evidence about a handset — the
 * instrument was in the frame. Now `chrome` collapses the probe layer away and what is left
 * is the message, exactly as sent.
 *
 * Which side is which: a pane stands in for THIS CONTACT's handset, so their own messages
 * (direction `inbound`) are the green ones on the right, and the academy's (`outbound`)
 * arrive grey on the left. That is why `inbound` maps to `--out`.
 */

import { useEffect, useState } from 'react'
import {
  buttonDisabled,
  droppedOnTheWire,
  fmtDuration,
  fmtPaise,
  fmtStamp,
  fmtTime,
  limitViolations,
  msUntil,
  type EmuButton,
  type EmuEvent,
  type EmuMessage,
  type MessageStatus,
} from '@/lib/emulator/state'
import { Icon, Ticks } from './icons'
import { Chip, cx } from './ui'
import { BubbleTail } from './wa-ui'
import { WaText } from './wa-text'

const SUPPRESS_LABEL: Record<string, string> = {
  opted_out: 'recipient opted out',
  self_confirmation: '§18 — would be asked to confirm themselves',
  escalation_about_self: '§18 — escalation about themselves',
  pre_launch: '§2.6 — academy is not live yet',
  recipient_frequency_cap: 'per-recipient frequency cap',
  tenant_send_cap: 'per-tenant send cap',
  out_of_window_no_template: 'out of window, no template resolvable',
  duplicate_idempotency: 'duplicate idempotency key',
  no_contact: 'no contact row',
  limit_violation: 'breaks a Cloud API limit',
}

/**
 * The photographed timetable at full size.
 *
 * §7.1 calls a photo of the week's classes the single biggest friction reducer in the
 * product, and the pane cropped it to a letterbox — the one image the whole feature turns on
 * was the one image nobody could read.
 */
function Lightbox({ media, onClose }: { media: NonNullable<EmuMessage['media']>; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/85 p-6"
      onClick={onClose}
      role="dialog"
      aria-label={media.filename ?? 'attachment'}
    >
      <div className="flex w-full max-w-5xl items-center gap-2 pb-2">
        <span className="probe truncate text-zinc-400">{media.filename ?? media.kind}</span>
        <a
          href={media.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="probe ml-auto rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
        >
          open in a tab ↗
        </a>
        <button
          type="button"
          onClick={onClose}
          className="probe rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
        >
          close (esc)
        </button>
      </div>
      {media.kind === 'video' ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={media.url} controls autoPlay onClick={(e) => e.stopPropagation()} className="max-h-[85vh] max-w-full rounded" />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={media.url}
          alt={media.filename ?? 'attachment'}
          onClick={(e) => e.stopPropagation()}
          className="max-h-[85vh] max-w-full rounded object-contain"
        />
      )}
    </div>
  )
}

function MediaBlock({
  media,
  dropped,
  onOpen,
}: {
  media: NonNullable<EmuMessage['media']>
  dropped: string | null
  onOpen: () => void
}) {
  const label =
    media.kind === 'image' ? 'image' : media.kind === 'audio' ? 'voice note' : media.kind === 'video' ? 'video' : 'document'

  // §17 in the one direction it must hold: the emulator may show less than production sends,
  // never more. A template send has no room for media on the wire, so this draws the hole.
  if (dropped) {
    return (
      <div className="probe mb-1.5 rounded border border-dashed border-amber-700/70 bg-amber-950/30 px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <Chip tone="warn">DROPPED</Chip>
          <span className="text-amber-300/90">{label} not on the wire</span>
        </div>
        <p className="mt-1 leading-snug text-amber-200/70">{dropped}</p>
      </div>
    )
  }

  return (
    <div className="mb-1 overflow-hidden rounded-[6px]" style={{ background: 'rgba(0,0,0,0.18)' }}>
      {media.kind === 'image' ? (
        <button type="button" onClick={onOpen} title="open full size" className="block w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={media.url} alt={media.filename ?? 'attached image'} className="block max-h-72 w-full object-cover" />
        </button>
      ) : media.kind === 'audio' ? (
        // §14.5 — a driver has to be able to hear what they just sent, or a mis-recorded
        // Kannada voice note and a correct one are the same grey waveform on screen.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio src={media.url} controls preload="metadata" className="block h-9 w-full" />
      ) : media.kind === 'video' ? (
        <button type="button" onClick={onOpen} title="open full size" className="block w-full">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={media.url} controls preload="metadata" className="block max-h-72 w-full" />
        </button>
      ) : (
        <a
          href={media.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2.5 px-2.5 py-2.5 text-[13px] hover:bg-black/15"
          style={{ color: 'var(--wa-ink)' }}
        >
          <span
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
            style={{ background: 'rgba(0,0,0,0.22)' }}
          >
            <Icon name="attach" size={17} />
          </span>
          <span className="min-w-0 flex-1 truncate">{media.filename ?? 'attachment'}</span>
        </a>
      )}
    </div>
  )
}

/**
 * A reply button, as WhatsApp draws one: a full-width card under the message, separated from
 * it, in the accent colour. The probe facts about it — which action id, how long it stays
 * tappable, why it is dead — ride along in the instrument idiom rather than in the label,
 * because the label is what a parent reads.
 */
function ActionButton({
  b,
  nowIso,
  onTap,
  busy,
  chrome,
}: {
  b: EmuButton
  nowIso: string
  onTap: (actionId: string, label: string) => void
  busy: boolean
  chrome: boolean
}) {
  const reason = buttonDisabled(b, nowIso)
  const left = reason ? null : msUntil(b.expiresAt, nowIso)
  const urgent = left !== null && left < 10 * 60_000
  return (
    <button
      type="button"
      disabled={!!reason || busy}
      onClick={() => onTap(b.actionId, b.title)}
      title={reason ? `action ${reason}` : `action ${b.actionId.slice(0, 8)}`}
      className={cx(
        'flex w-full items-center justify-center gap-1.5 rounded-[7.5px] px-3 py-2 text-[14px] transition-colors',
        'shadow-[0_1px_0.5px_var(--wa-shadow)]',
        reason ? 'cursor-not-allowed' : 'hover:brightness-110',
      )}
      style={{
        background: 'var(--wa-in)',
        color: reason ? 'var(--wa-ink-faint)' : 'var(--wa-link)',
      }}
    >
      <span className="truncate">{b.title}</span>
      {chrome && reason ? <span className="probe opacity-70">· {reason}</span> : null}
      {/* §2.2's actions carry a ttl, and nothing showed it — a button about to stop working
          looked exactly like one that would work forever. */}
      {chrome && left !== null ? (
        <span
          className={cx('probe', urgent ? 'text-amber-400' : 'opacity-55')}
          title="how long this minted action stays tappable"
        >
          · {fmtDuration(left)}
        </span>
      ) : null}
    </button>
  )
}

/** §2.4's ladder, one rung at a time. `queued` is not on the wire, so it has nothing to give. */
function nextRung(status: MessageStatus): 'delivered' | 'read' | null {
  if (status === 'sent') return 'delivered'
  if (status === 'delivered') return 'read'
  return null
}

export function Bubble({
  m,
  tz,
  nowIso,
  meta,
  senderFallback,
  chrome = true,
  tight = false,
  onTap,
  onOpenList,
  onAdvanceStatus,
  busyTap,
}: {
  m: EmuMessage
  tz: string
  nowIso: string
  meta: EmuEvent | null
  senderFallback: string | null
  /** False collapses the probe layer, leaving the handset exactly as a parent sees it. */
  chrome?: boolean
  /** The message above this one came from the same side — close the gap up. */
  tight?: boolean
  onTap: (actionId: string, label: string) => void
  onOpenList: (m: EmuMessage) => void
  onAdvanceStatus: (messageId: string, status: 'delivered' | 'read') => void
  busyTap: (actionId: string) => boolean
}) {
  const [showRaw, setShowRaw] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const inbound = m.direction === 'inbound'
  const violations = limitViolations(m)
  const dropped = droppedOnTheWire(m)

  // Suppressed messages never reached a handset, so they get no bubble at all — drawing one
  // would put a message on screen that nobody received. This is pure probe.
  if (m.status === 'suppressed' || m.suppressReason) {
    const reason = m.suppressReason ?? 'suppressed'
    return (
      <div className="px-3 py-1.5">
        <div className="probe rounded-[7.5px] border border-dashed border-rose-900/70 bg-rose-950/25 px-2.5 py-2">
          <div className="flex items-center gap-1.5">
            <Chip tone="danger">NOT SENT</Chip>
            <span className="text-rose-300/90">{reason}</span>
            <span className="ml-auto opacity-60">{fmtTime(m.at, tz)}</span>
          </div>
          <p className="mt-1.5 line-clamp-3 font-sans text-[13px] leading-snug text-zinc-400">
            {m.body ? <WaText text={m.body} /> : '—'}
          </p>
          <p className="mt-1 opacity-70">{SUPPRESS_LABEL[reason] ?? 'never reached the wire'}</p>
        </div>
      </div>
    )
  }

  const cost = m.costPaise ?? meta?.costPaise ?? null
  const templateName = m.templateName ?? meta?.templateName ?? null
  const inWindow = m.inWindow ?? meta?.inWindow ?? (templateName ? false : null)
  const sender = m.senderPhone ?? meta?.senderPhone ?? senderFallback
  const rung = nextRung(m.status)

  // The contact's own messages sit right in green; the academy's arrive left in grey.
  const side: 'in' | 'out' = inbound ? 'out' : 'in'

  const probeChips =
    chrome &&
    (templateName || inWindow === false || m.catalogId || violations.length || cost !== null)

  return (
    // WhatsApp packs a run from one sender to a 2px gap and opens 12px when the sender
    // changes. It is the cheapest signal on the screen for "this is one thought" and its
    // absence is what makes an even-spaced copy read as a transcript rather than a chat.
    <div
      className={cx('group/msg flex px-3', inbound ? 'justify-end' : 'justify-start')}
      style={{ paddingTop: tight ? 1 : 6, paddingBottom: 1 }}
    >
      <div
        className={cx('relative flex min-w-0 flex-col', inbound ? 'items-end' : 'items-start')}
        style={{ maxWidth: 'var(--wa-bubble-max, 85%)' }}
      >
        {/* ---------------- handset ---------------- */}
        <div className={cx('wa-bubble', side === 'out' ? 'wa-bubble--out' : 'wa-bubble--in', m.pending && 'opacity-70')}>
          <BubbleTail side={side} />

          {m.header ? (
            <div
              className="mb-0.5 text-[14px] leading-[19px] font-semibold"
              style={{ color: 'color-mix(in srgb, var(--wa-ink) 92%, transparent)' }}
            >
              {m.header}
            </div>
          ) : null}

          {m.media ? <MediaBlock media={m.media} dropped={dropped} onOpen={() => setLightbox(true)} /> : null}

          <span className="wa-meta">
            {fmtTime(m.at, tz)}
            {!inbound ? (
              // Ticks belong to the sender's own bubble on a handset. They stay on the
              // academy's side here because they are the instrument for §2.4 — the control
              // that walks a message up the ladder one rung per tap, and the only way to
              // reach `delivered` by hand.
              <button
                type="button"
                disabled={!rung}
                onClick={() => rung && onAdvanceStatus(m.id, rung)}
                title={
                  rung
                    ? `mark ${rung} — one rung at a time, because queued ≠ sent ≠ delivered ≠ read (§2.4)`
                    : m.status === 'read'
                      ? 'read — the top of the ladder'
                      : 'queued — the transport has not accepted this yet, so there is nothing to advance'
                }
                className={cx('-my-1 rounded px-0.5 py-1', rung ? 'hover:bg-white/10' : 'cursor-default')}
                style={{ color: m.status === 'read' ? 'var(--wa-tick)' : undefined }}
              >
                <Ticks status={m.status} size={15} />
              </button>
            ) : null}
          </span>

          {/* `wa-meta-gap` closes the text and reserves the clock's corner on whatever line
              the message happens to end on — see the rule in globals.css for why this is a
              spacer and not a float. */}
          {m.body ? (
            <span className="block text-[14.2px] leading-[19px] whitespace-pre-wrap">
              <WaText text={m.body} />
              <span className="wa-meta-gap" aria-hidden />
            </span>
          ) : m.media ? null : (
            <span className="block text-[14.2px] leading-[19px] italic" style={{ color: 'var(--wa-ink-faint)' }}>
              (no body — nothing for a handset to draw)
              <span className="wa-meta-gap" aria-hidden />
            </span>
          )}

          {m.footer ? (
            <div className="mt-1 text-[12.5px] leading-[17px]" style={{ color: 'var(--wa-ink-dim)' }}>
              {m.footer}
            </div>
          ) : null}
        </div>

        {/* reply buttons — their own cards under the message, as the wire carries them */}
        {m.buttons.length ? (
          <div className="mt-[3px] flex w-full flex-col gap-[3px]">
            {m.buttons.slice(0, 3).map((b, i) => (
              <ActionButton key={`${b.actionId}:${i}`} b={b} nowIso={nowIso} onTap={onTap} busy={busyTap(b.actionId)} chrome={chrome} />
            ))}
            {m.buttons.length > 3 && chrome ? (
              <div className="probe rounded border border-rose-900/70 bg-rose-950/30 px-2 py-1 text-center text-rose-300">
                {m.buttons.length - 3} button(s) over the Cloud API max of 3 — would be rejected
              </div>
            ) : null}
          </div>
        ) : null}

        {/* §14.6 — the Cloud API's `cta_url`. A real anchor, because the claim under test is
            that a person taps a button rather than reading a signed JWT. */}
        {m.link ? (
          <a
            href={m.link.url}
            target="_blank"
            rel="noreferrer"
            title={m.link.url}
            className="mt-[3px] flex w-full items-center justify-center gap-1.5 rounded-[7.5px] px-3 py-2 text-[14px] shadow-[0_1px_0.5px_var(--wa-shadow)] hover:brightness-110"
            style={{ background: 'var(--wa-in)', color: 'var(--wa-link)' }}
          >
            <Icon name="expand" size={14} />
            <span className="truncate">{m.link.title}</span>
          </a>
        ) : null}

        {m.list ? (
          <button
            type="button"
            onClick={() => onOpenList(m)}
            className="mt-[3px] flex w-full items-center justify-center gap-1.5 rounded-[7.5px] px-3 py-2 text-[14px] shadow-[0_1px_0.5px_var(--wa-shadow)] hover:brightness-110"
            style={{ background: 'var(--wa-in)', color: 'var(--wa-link)' }}
          >
            <Icon name="menu" size={14} />
            {m.list.buttonText}
          </button>
        ) : null}

        {m.failedReason ? (
          <div className="probe mt-1 rounded border border-rose-900/70 bg-rose-950/30 px-2 py-1 text-rose-300">
            failed · {m.failedReason}
          </div>
        ) : null}

        {/* ---------------- probe ---------------- */}
        {probeChips ? (
          <div
            className={cx(
              'probe-dim mt-1 flex flex-wrap items-center gap-1',
              inbound ? 'justify-end' : 'justify-start',
            )}
          >
            {templateName ? (
              <Chip tone="template" title="Out of the 24h window, carried by one of the eight approved templates (§16.2)">
                {templateName}
              </Chip>
            ) : inWindow === false ? (
              <Chip tone="danger" title="Out of window with no template — this could not have gone out">
                out of window · no template
              </Chip>
            ) : null}
            {m.catalogId ? (
              <Chip tone="catalog" title="The catalog moment code raised (§12) — the bot chose what to do with it">
                {m.catalogId}
              </Chip>
            ) : null}
            {violations.length ? (
              <Chip tone="danger" title={`Cloud API limits: ${violations.join(' · ')}`}>
                LIMIT
              </Chip>
            ) : null}
            {cost !== null && !inbound ? (
              <span
                className="probe opacity-70"
                title={
                  m.conversationCategory
                    ? `${m.conversationCategory} conversation${cost === 0 ? ' — no charge' : ''}`
                    : cost === 0
                      ? 'inside the window — no conversation charge'
                      : 'opened a paid conversation'
                }
              >
                {m.conversationCategory && m.conversationCategory !== 'free_window'
                  ? `${m.conversationCategory} ${fmtPaise(cost)}`
                  : fmtPaise(cost)}
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setShowRaw((v) => !v)}
              title={`${fmtStamp(m.at, tz)} — open the message row behind this bubble`}
              className="probe rounded border px-1 opacity-60 hover:opacity-100"
              style={{ borderColor: 'var(--wa-rule)' }}
            >
              {showRaw ? 'hide row' : 'row ›'}
            </button>
          </div>
        ) : null}

        {showRaw && chrome ? (
          <div className="probe mt-1 w-full rounded border border-zinc-800 bg-zinc-950/90 px-2 py-1.5 leading-relaxed text-zinc-400">
            <div>id · {m.id}</div>
            <div>queued · {m.queuedAt ? fmtStamp(m.queuedAt, tz) : '—'}</div>
            <div>sent · {m.sentAt ? fmtStamp(m.sentAt, tz) : '—'}</div>
            <div>delivered · {m.deliveredAt ? fmtStamp(m.deliveredAt, tz) : '—'}</div>
            <div>read · {m.readAt ? fmtStamp(m.readAt, tz) : '—'}</div>
            <div>sender · {sender ?? '—'}</div>
            <div>wa id · {m.waMessageId ?? '—'}</div>
            {m.conversationCategory ? <div>category · {m.conversationCategory}</div> : null}
            <div>route · {templateName ? `template ${templateName}` : inWindow === false ? 'out of window' : 'in-window'}</div>
            {dropped ? <div className="text-amber-400">wire · {dropped}</div> : null}
            {violations.length ? <div className="text-rose-400">limits · {violations.join(' · ')}</div> : null}
            {m.buttons.map((b) => (
              <div key={b.actionId} className="truncate">
                action · {b.actionId || '(none)'} {b.consumedAt ? '· consumed' : ''}{' '}
                {b.expiresAt ? `· ttl ${fmtStamp(b.expiresAt, tz)}` : ''}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {lightbox && m.media && !dropped ? <Lightbox media={m.media} onClose={() => setLightbox(false)} /> : null}
    </div>
  )
}

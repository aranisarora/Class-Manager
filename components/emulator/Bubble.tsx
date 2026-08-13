'use client'

/**
 * One message, rendered as a primitive WhatsApp (§17) — behavioral fidelity, not visual.
 * Everything the spec insists must be visible is visible here: the status ticks (§2.4),
 * template-vs-in-window and which of the eight templates carried it (§16.2), the sender
 * number, the cost of the conversation it opened, the catalog moment it came from (§12),
 * whether an action is still tappable and for how long (§2.2), any Cloud API limit it breaks,
 * and anything on the row the wire would refuse to carry (§17).
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
  type EmuFlow,
  type EmuMessage,
  type MessageStatus,
} from '@/lib/emulator/state'
import { Chip, Ticks, cx } from './ui'

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
 * product, and the pane cropped it to a 208px letterbox with `object-cover` — the one image
 * the whole feature turns on was the one image nobody could read. Fixed rather than fixed,
 * and one tap away from the whole thing.
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
        <span className="truncate font-mono text-[11px] text-zinc-400">{media.filename ?? media.kind}</span>
        <a
          href={media.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="ml-auto rounded border border-zinc-700 px-2 py-0.5 font-mono text-[10px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
        >
          open in a tab ↗
        </a>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-zinc-700 px-2 py-0.5 font-mono text-[10px] text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
        >
          close (esc)
        </button>
      </div>
      {media.kind === 'video' ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          src={media.url}
          controls
          autoPlay
          onClick={(e) => e.stopPropagation()}
          className="max-h-[85vh] max-w-full rounded"
        />
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
    media.kind === 'image'
      ? 'image'
      : media.kind === 'audio'
        ? 'voice note'
        : media.kind === 'video'
          ? 'video'
          : 'document'

  // §17 in the one direction it must hold: the emulator may show less than production sends,
  // never more. A template send has no room for media on the wire, so this draws the hole.
  if (dropped) {
    return (
      <div className="mb-1.5 rounded border border-dashed border-amber-800/70 bg-amber-950/20 px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <Chip tone="warn">DROPPED</Chip>
          <span className="font-mono text-[9px] text-amber-300/90">{label} not on the wire</span>
        </div>
        <p className="mt-1 text-[10px] leading-snug text-amber-200/70">{dropped}</p>
      </div>
    )
  }

  return (
    <div className="mb-1.5 overflow-hidden rounded border border-zinc-600/60 bg-zinc-950/60">
      {media.kind === 'image' ? (
        <button type="button" onClick={onOpen} title="open full size" className="block w-full">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={media.url}
            alt={media.filename ?? 'attached image'}
            className="block max-h-56 w-full bg-black/40 object-contain"
          />
        </button>
      ) : media.kind === 'audio' ? (
        // §14.5 — "voice notes go to the model as audio". A driver has to be able to hear
        // what they just sent, or a mis-recorded Kannada voice note and a correctly recorded
        // one are the same grey waveform on screen.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio src={media.url} controls preload="metadata" className="block h-8 w-full" />
      ) : media.kind === 'video' ? (
        // The composer accepts video, the sniffer classifies it and the label names it — and
        // there was no branch that drew one, so every video fell through to the document row.
        <button type="button" onClick={onOpen} title="open full size" className="block w-full">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video src={media.url} controls preload="metadata" className="block max-h-56 w-full bg-black/40" />
        </button>
      ) : (
        <a
          href={media.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 px-2 py-2 text-[11px] text-zinc-300 hover:bg-zinc-900/60"
        >
          <span>📄</span>
          <span className="truncate">{media.filename ?? 'attachment'}</span>
          <span className="ml-auto font-mono text-[9px] text-zinc-600">open ↗</span>
        </a>
      )}
      <div className="flex items-center justify-between border-t border-zinc-700/50 px-2 py-1">
        <span className="font-mono text-[9px] text-zinc-500">{label}</span>
        {media.filename ? <span className="truncate font-mono text-[9px] text-zinc-600">{media.filename}</span> : null}
      </div>
    </div>
  )
}

function ActionButton({
  b,
  nowIso,
  onTap,
  busy,
}: {
  b: EmuButton
  nowIso: string
  onTap: (actionId: string, label: string) => void
  busy: boolean
}) {
  const reason = buttonDisabled(b, nowIso)
  const left = reason ? null : msUntil(b.expiresAt, nowIso)
  return (
    <button
      type="button"
      disabled={!!reason || busy}
      onClick={() => onTap(b.actionId, b.title)}
      title={reason ? `action ${reason}` : `action ${b.actionId.slice(0, 8)}`}
      className={cx(
        'group flex w-full items-center justify-center gap-1.5 rounded border px-2 py-1.5 text-[12px] transition-colors',
        reason
          ? 'cursor-not-allowed border-zinc-800 bg-zinc-900/60 text-zinc-600'
          : 'border-zinc-700 bg-zinc-800/80 text-sky-300 hover:border-sky-600/60 hover:bg-zinc-700/80',
      )}
    >
      <span className="truncate">{b.title}</span>
      {reason ? <span className="font-mono text-[9px] tracking-wide text-zinc-600">· {reason}</span> : null}
      {/* §2.2's actions carry a ttl, and nothing showed it — so a button that was about to
          stop working looked exactly like one that would work forever, and the moment it
          expired could not be watched happening. */}
      {left !== null ? (
        <span
          className={cx('font-mono text-[9px] tracking-wide', left < 10 * 60_000 ? 'text-amber-400' : 'text-zinc-500')}
          title="how long this minted action stays tappable"
        >
          · {fmtDuration(left)} left
        </span>
      ) : null}
    </button>
  )
}

/**
 * The Flow's one call to action, attached to the bubble.
 *
 * Attached, not floating below it: WhatsApp draws a reply button as its own card under the
 * message and a Flow CTA as a divided strip inside it, and the difference is the whole point —
 * a reply button sends a word back, this one opens a form. Drawing both the same way would
 * make the emulator agree with itself and disagree with the handset.
 *
 * The disabled state is the load-bearing part. `flow_token` is a single-use `action` row, so a
 * form that has been submitted once, or whose ttl has run out, is dead — and until this
 * rendered it, a dead form and a live one were the same bubble.
 */
function FlowButton({
  flow,
  nowIso,
  onOpen,
  busy,
}: {
  flow: EmuFlow
  nowIso: string
  onOpen: () => void
  busy: boolean
}) {
  const reason = buttonDisabled({ ...flow, actionId: flow.flowToken }, nowIso)
  const left = reason ? null : msUntil(flow.expiresAt, nowIso)
  return (
    <button
      type="button"
      disabled={!!reason || busy}
      onClick={onOpen}
      title={reason ? `flow ${reason}` : `flow ${flow.flowId} · screen ${flow.screen}`}
      className={cx(
        'mt-1 -mr-2 -mb-1 -ml-2 flex items-center justify-center gap-1.5 border-t px-2 py-1.5 text-[12px] transition-colors',
        'w-[calc(100%+1rem)]',
        reason
          ? 'cursor-not-allowed border-white/10 text-zinc-500 line-through decoration-zinc-600'
          : 'border-violet-500/30 text-violet-300 hover:bg-violet-500/10',
      )}
    >
      <span className="font-mono text-[10px]">▤</span>
      <span className="truncate">{flow.cta || '(no cta)'}</span>
      {reason ? <span className="font-mono text-[9px] tracking-wide no-underline">· {reason}</span> : null}
      {left !== null ? (
        <span
          className={cx('font-mono text-[9px] tracking-wide', left < 10 * 60_000 ? 'text-amber-400' : 'text-zinc-500')}
          title="how long this flow_token stays submittable"
        >
          · {fmtDuration(left)} left
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
  onTap,
  onOpenList,
  onOpenFlow,
  onAdvanceStatus,
  busyTap,
  busyFlow,
}: {
  m: EmuMessage
  tz: string
  nowIso: string
  meta: EmuEvent | null
  senderFallback: string | null
  onTap: (actionId: string, label: string) => void
  onOpenList: (m: EmuMessage) => void
  onOpenFlow: (m: EmuMessage) => void
  onAdvanceStatus: (messageId: string, status: 'delivered' | 'read') => void
  busyTap: (actionId: string) => boolean
  busyFlow: (flowToken: string) => boolean
}) {
  const [showRaw, setShowRaw] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const inbound = m.direction === 'inbound'
  const violations = limitViolations(m)
  const dropped = droppedOnTheWire(m)

  if (m.status === 'suppressed' || m.suppressReason) {
    const reason = m.suppressReason ?? 'suppressed'
    return (
      <div className="my-2 px-2">
        <div className="rounded border border-dashed border-rose-900/70 bg-rose-950/20 px-2 py-1.5">
          <div className="flex items-center gap-1.5">
            <Chip tone="danger">SUPPRESSED</Chip>
            <span className="font-mono text-[10px] text-rose-300/90">{reason}</span>
            <span className="ml-auto font-mono text-[9px] text-zinc-600">{fmtTime(m.at, tz)}</span>
          </div>
          <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-zinc-500">{m.body || '—'}</p>
          <p className="mt-1 text-[10px] text-zinc-600">{SUPPRESS_LABEL[reason] ?? 'never reached the wire'}</p>
        </div>
      </div>
    )
  }

  const cost = m.costPaise ?? meta?.costPaise ?? null
  const templateName = m.templateName ?? meta?.templateName ?? null
  const inWindow = m.inWindow ?? meta?.inWindow ?? (templateName ? false : null)
  const sender = m.senderPhone ?? meta?.senderPhone ?? senderFallback
  const rung = nextRung(m.status)
  const flowState = m.flow ? buttonDisabled({ ...m.flow, actionId: m.flow.flowToken }, nowIso) : null

  return (
    /*
     * A pane stands in for the contact's own handset — the composer says "type as this
     * contact" — and the sides were the wrong way round: the business's messages sat on the
     * right, where a person's own replies belong, so every screenshot read as if the parent
     * had said what the bot said. Inbound (what this contact sends) is theirs and goes right;
     * outbound (what the academy sends them) arrives on the left.
     */
    <div className={cx('flex px-2 py-1', inbound ? 'justify-end' : 'justify-start', m.pending && 'opacity-60')}>
      <div className={cx('relative max-w-[86%] min-w-[120px]', inbound ? 'mr-1.5' : 'ml-1.5')}>
        {/* tail */}
        <span
          aria-hidden
          className={cx(
            'absolute top-0 h-0 w-0',
            inbound
              ? '-right-1.5 border-t-[9px] border-r-[9px] border-t-emerald-900 border-r-transparent'
              : '-left-1.5 border-t-[9px] border-l-[9px] border-t-zinc-800 border-l-transparent',
          )}
        />
        <div
          className={cx(
            'rounded-md px-2 pt-1.5 pb-1 shadow-sm',
            inbound ? 'rounded-tr-none bg-emerald-900' : 'rounded-tl-none bg-zinc-800',
          )}
        >
          {/* §17 — template-vs-in-window is always visible, on every outbound row. */}
          {!inbound ? (
            <div className="mb-1 flex flex-wrap items-center gap-1">
              {templateName ? (
                <Chip tone="template" title="Out of the 24h window, carried by one of the eight approved templates (§16.2)">
                  TEMPLATE · {templateName}
                </Chip>
              ) : inWindow === false ? (
                <Chip tone="danger" title="Out of window with no template — this could not have gone out">
                  out of window · no template
                </Chip>
              ) : (
                <Chip tone="window" title="Free-form reply inside the 24h window — no template, no tier, no cost (§14.7)">
                  in-window
                </Chip>
              )}
              {m.catalogId ? (
                <Chip tone="catalog" title="The catalog moment code raised (§12) — the bot chose what to do with it">
                  {m.catalogId}
                </Chip>
              ) : null}
              {/* A Flow's evidence, on the bubble: which published artifact, which screen it
                  opens on, and whether the action row behind `flow_token` is still live. The
                  last one is the fact worth being able to see — it is the difference between
                  a form that can be filled in and one that would be refused on submit. */}
              {m.flow ? (
                <>
                  <Chip tone="violet" title="a WhatsApp Flow — a form inside the chat, carried by this message's one action slot">
                    FLOW · {m.flow.flowId}
                  </Chip>
                  <Chip tone="quiet" title="the screen flow_action: navigate opens on">
                    {m.flow.screen || 'no screen'}
                  </Chip>
                  <Chip
                    tone={flowState ? 'danger' : 'window'}
                    title={`flow_token ${m.flow.flowToken || '(none)'} — an action row (§2.2): minted once, submittable once`}
                  >
                    token {flowState ?? 'live'}
                  </Chip>
                </>
              ) : null}
            </div>
          ) : null}

          {m.header ? (
            <div className="mb-1 border-b border-white/10 pb-1 text-[12px] font-semibold text-zinc-100">{m.header}</div>
          ) : null}

          {m.media ? (
            <MediaBlock media={m.media} dropped={dropped} onOpen={() => setLightbox(true)} />
          ) : null}

          {m.body ? (
            <p className="text-[13px] leading-snug whitespace-pre-wrap text-zinc-100">{m.body}</p>
          ) : m.media ? null : (
            <p className="text-[13px] text-zinc-500 italic">(empty body)</p>
          )}

          {m.footer ? <p className="mt-1 text-[10px] text-zinc-400/80">{m.footer}</p> : null}

          <div className="mt-1 flex items-center justify-end gap-1.5">
            {violations.length ? (
              <Chip tone="danger" title={`Cloud API limits: ${violations.join(' · ')}`}>
                LIMIT
              </Chip>
            ) : null}
            {cost !== null && !inbound ? (
              <span
                className="font-mono text-[9px] text-zinc-400/70"
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
              title={fmtStamp(m.at, tz)}
              className="font-mono text-[9px] text-zinc-400/70 hover:text-zinc-200"
            >
              {fmtTime(m.at, tz)}
            </button>
            {/* Ticks belong to the sender's own bubble on a real handset. They stay on the
                academy's side here because they are the instrument for §2.4 — the control
                that walks a message up the ladder one rung per tap, which is the only way
                to reach `delivered` by hand. */}
            {!inbound ? (
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
                className={cx('rounded px-0.5', rung ? 'hover:bg-white/10' : 'cursor-default opacity-70')}
              >
                <Ticks status={m.status} />
              </button>
            ) : null}
          </div>

          {m.flow ? (
            <FlowButton
              flow={m.flow}
              nowIso={nowIso}
              onOpen={() => onOpenFlow(m)}
              busy={busyFlow(m.flow.flowToken)}
            />
          ) : null}
        </div>

        {m.buttons.length ? (
          <div className="mt-1 flex flex-col gap-1">
            {m.buttons.slice(0, 3).map((b, i) => (
              <ActionButton
                key={`${b.actionId}:${i}`}
                b={b}
                nowIso={nowIso}
                onTap={onTap}
                busy={busyTap(b.actionId)}
              />
            ))}
            {m.buttons.length > 3 ? (
              <div className="rounded border border-rose-900/70 bg-rose-950/30 px-2 py-1 text-center font-mono text-[10px] text-rose-300">
                {m.buttons.length - 3} button(s) over the Cloud API max of 3 — would be rejected
              </div>
            ) : null}
          </div>
        ) : null}

        {/* §14.6 — the Cloud API's `cta_url`. A real anchor, because the whole claim being
            tested here is that a person taps a button rather than reading a signed JWT. */}
        {m.link ? (
          <a
            href={m.link.url}
            target="_blank"
            rel="noreferrer"
            title={m.link.url}
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded border border-zinc-700 bg-zinc-800/80 px-2 py-1.5 text-[12px] text-sky-300 hover:border-sky-600/60 hover:bg-zinc-700/80"
          >
            <span className="font-mono text-[10px]">↗</span>
            <span className="truncate">{m.link.title}</span>
          </a>
        ) : null}

        {m.list ? (
          <button
            type="button"
            onClick={() => onOpenList(m)}
            className="mt-1 flex w-full items-center justify-center gap-1.5 rounded border border-zinc-700 bg-zinc-800/80 px-2 py-1.5 text-[12px] text-sky-300 hover:border-sky-600/60 hover:bg-zinc-700/80"
          >
            <span className="font-mono text-[10px]">☰</span>
            {m.list.buttonText}
          </button>
        ) : null}

        {m.failedReason ? (
          <div className="mt-1 rounded border border-rose-900/70 bg-rose-950/30 px-2 py-1 font-mono text-[10px] text-rose-300">
            failed · {m.failedReason}
          </div>
        ) : null}

        {showRaw ? (
          <div className="mt-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-[9px] leading-relaxed text-zinc-400">
            <div>id · {m.id}</div>
            <div>queued · {m.queuedAt ? fmtStamp(m.queuedAt, tz) : '—'}</div>
            <div>sent · {m.sentAt ? fmtStamp(m.sentAt, tz) : '—'}</div>
            <div>delivered · {m.deliveredAt ? fmtStamp(m.deliveredAt, tz) : '—'}</div>
            <div>read · {m.readAt ? fmtStamp(m.readAt, tz) : '—'}</div>
            <div>sender · {sender ?? '—'}</div>
            <div>wa id · {m.waMessageId ?? '—'}</div>
            {m.conversationCategory ? <div>category · {m.conversationCategory}</div> : null}
            <div>
              route · {templateName ? `template ${templateName}` : inWindow === false ? 'out of window' : 'in-window'}
            </div>
            {dropped ? <div className="text-amber-400">wire · {dropped}</div> : null}
            {violations.length ? <div className="text-rose-400">limits · {violations.join(' · ')}</div> : null}
            {m.buttons.map((b) => (
              <div key={b.actionId} className="truncate">
                action · {b.actionId || '(none)'} {b.consumedAt ? '· consumed' : ''} {b.expiresAt ? `· ttl ${fmtStamp(b.expiresAt, tz)}` : ''}
              </div>
            ))}
            {m.flow ? (
              <>
                <div className="truncate">
                  flow · {m.flow.flowId} · screen {m.flow.screen || '(none)'} · {m.flow.mode}
                </div>
                <div className="truncate">
                  flow_token · {m.flow.flowToken || '(none)'} {m.flow.consumedAt ? `· consumed ${fmtStamp(m.flow.consumedAt, tz)}` : ''}{' '}
                  {m.flow.expiresAt ? `· ttl ${fmtStamp(m.flow.expiresAt, tz)}` : ''}
                </div>
                {Object.keys(m.flow.data).length ? (
                  <div className="truncate">
                    flow data · {Object.entries(m.flow.data).map(([k, v]) => `${k}=${v}`).join(' ')}
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {lightbox && m.media && !dropped ? (
        <Lightbox media={m.media} onClose={() => setLightbox(false)} />
      ) : null}
    </div>
  )
}

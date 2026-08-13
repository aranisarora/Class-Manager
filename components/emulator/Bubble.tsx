'use client'

/**
 * One message, rendered as a primitive WhatsApp (§17) — behavioral fidelity, not visual.
 * Everything the spec insists must be visible is visible here: the status ticks (§2.4),
 * template-vs-in-window and which of the eight templates carried it (§16.2), the sender
 * number, the cost of the conversation it opened, the catalog moment it came from (§12),
 * whether an action is still tappable (§2.2), and any Cloud API limit it breaks (§17).
 */

import { useState } from 'react'
import {
  buttonDisabled,
  fmtPaise,
  fmtStamp,
  fmtTime,
  limitViolations,
  type EmuButton,
  type EmuEvent,
  type EmuMessage,
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

function MediaBlock({ media }: { media: NonNullable<EmuMessage['media']> }) {
  const label =
    media.kind === 'image'
      ? 'image'
      : media.kind === 'audio'
        ? 'voice note'
        : media.kind === 'video'
          ? 'video'
          : 'document'
  return (
    <div className="mb-1.5 overflow-hidden rounded border border-zinc-600/60 bg-zinc-950/60">
      {media.kind === 'image' ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={media.url} alt={media.filename ?? 'attached image'} className="block max-h-52 w-full object-cover" />
      ) : media.kind === 'audio' ? (
        <div className="flex items-center gap-2 px-2 py-2">
          <span className="text-sm">▶</span>
          <span className="h-1 flex-1 rounded bg-zinc-700">
            <span className="block h-1 w-1/3 rounded bg-zinc-400" />
          </span>
          <span className="font-mono text-[9px] text-zinc-500">0:02</span>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-zinc-300">
          <span>📄</span>
          <span className="truncate">{media.filename ?? 'attachment'}</span>
        </div>
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
    </button>
  )
}

export function Bubble({
  m,
  tz,
  nowIso,
  meta,
  senderFallback,
  onTap,
  onOpenList,
  onMarkRead,
  busyTap,
}: {
  m: EmuMessage
  tz: string
  nowIso: string
  meta: EmuEvent | null
  senderFallback: string | null
  onTap: (actionId: string, label: string) => void
  onOpenList: (m: EmuMessage) => void
  onMarkRead: (messageId: string) => void
  busyTap: (actionId: string) => boolean
}) {
  const [showRaw, setShowRaw] = useState(false)
  const inbound = m.direction === 'inbound'
  const violations = limitViolations(m)

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

  return (
    <div className={cx('flex px-2 py-1', inbound ? 'justify-start' : 'justify-end', m.pending && 'opacity-60')}>
      <div className={cx('relative max-w-[86%] min-w-[120px]', inbound ? 'ml-1.5' : 'mr-1.5')}>
        {/* tail */}
        <span
          aria-hidden
          className={cx(
            'absolute top-0 h-0 w-0',
            inbound
              ? '-left-1.5 border-t-[9px] border-l-[9px] border-t-zinc-800 border-l-transparent'
              : '-right-1.5 border-t-[9px] border-r-[9px] border-t-emerald-900 border-r-transparent',
          )}
        />
        <div
          className={cx(
            'rounded-md px-2 pt-1.5 pb-1 shadow-sm',
            inbound ? 'rounded-tl-none bg-zinc-800' : 'rounded-tr-none bg-emerald-900',
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
            </div>
          ) : null}

          {m.header ? (
            <div className="mb-1 border-b border-white/10 pb-1 text-[12px] font-semibold text-zinc-100">{m.header}</div>
          ) : null}

          {m.media ? <MediaBlock media={m.media} /> : null}

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
            {!inbound ? (
              <button
                type="button"
                onClick={() => onMarkRead(m.id)}
                title="mark delivered / read — drives §2.4 by hand"
                className="rounded px-0.5 hover:bg-white/10"
              >
                <Ticks status={m.status} />
              </button>
            ) : null}
          </div>
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
            {violations.length ? <div className="text-rose-400">limits · {violations.join(' · ')}</div> : null}
            {m.buttons.map((b) => (
              <div key={b.actionId} className="truncate">
                action · {b.actionId || '(none)'} {b.consumedAt ? '· consumed' : ''} {b.expiresAt ? `· ttl ${fmtStamp(b.expiresAt, tz)}` : ''}
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

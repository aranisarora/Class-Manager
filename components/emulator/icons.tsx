/**
 * The emulator's icon set — drawn, not typed.
 *
 * The panes used emoji as controls: 🧠 for memory, ₹ for money, 📎 for attach, ✕ ‹ › for the
 * pane chrome. Emoji are a font, not an icon system — they render at a different weight on
 * every platform, they cannot take `currentColor`, and on a surface whose whole job is to be
 * mistakable for WhatsApp they are the tell that it is not. These are 24×24 paths on
 * `currentColor`, so they inherit the layer they sit in.
 *
 * Two weights on purpose, because WhatsApp itself has two and copying only one loses the
 * likeness:
 *
 *   SOLID   — the glyphs WhatsApp fills: send, mic, pin, the unread pip.
 *   STROKED — everything else, at a uniform 1.8 round-capped stroke: attach, search, emoji,
 *             chevrons, close, expand.
 *
 * The ticks are their own thing. They are the §2.4 ladder, they must be legible at 11px
 * inside a bubble, and their spacing is what makes ✓✓ read as one mark rather than two — so
 * they are drawn as a single path with the second tick offset, not two glyphs beside
 * each other.
 */

import type { ReactElement, SVGProps } from 'react'

export type IconName =
  | 'send'
  | 'mic'
  | 'attach'
  | 'emoji'
  | 'search'
  | 'pin'
  | 'pinOff'
  | 'expand'
  | 'collapse'
  | 'close'
  | 'chevronLeft'
  | 'chevronRight'
  | 'chevronDown'
  | 'menu'
  | 'memory'
  | 'money'
  | 'probe'
  | 'camera'
  | 'clock'
  | 'copy'
  | 'check'
  | 'jumpDown'

type Props = SVGProps<SVGSVGElement> & { name: IconName; size?: number; title?: string }

/** Stroked paths share one geometry contract so the set reads as one hand. */
const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

const PATHS: Record<IconName, ReactElement> = {
  // --- solid, as WhatsApp draws them ------------------------------------------------------
  send: <path d="M3.4 20.4 20.9 12 3.4 3.6 3.4 10.1 15.9 12 3.4 13.9Z" fill="currentColor" />,
  mic: (
    <>
      <path d="M12 14.5a3 3 0 0 0 3-3V5.5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z" fill="currentColor" />
      <path d="M17.5 11.2a5.5 5.5 0 0 1-11 0M12 17v3" {...STROKE} />
    </>
  ),
  pin: (
    // A thumbtack seen from the side — the shape WhatsApp uses in the chat list, which reads
    // at 12px where a pushpin drawn face-on turns to mush.
    <path
      d="M15.2 3.3 20.7 8.8l-2.1 2.1-1 -0.3-3.6 3.6 0.4 3.3-1.6 1.6-3.8-3.8-3.9 3.9-0.9-0.9 3.9-3.9-3.8-3.8 1.6-1.6 3.3 0.4 3.6-3.6-0.3-1Z"
      fill="currentColor"
    />
  ),
  // --- stroked -----------------------------------------------------------------------------
  pinOff: (
    <>
      <path
        d="M15.2 3.3 20.7 8.8l-2.1 2.1-1 -0.3-3.6 3.6 0.4 3.3-1.6 1.6-3.8-3.8-3.9 3.9-0.9-0.9 3.9-3.9-3.8-3.8 1.6-1.6 3.3 0.4 3.6-3.6-0.3-1Z"
        {...STROKE}
        strokeWidth={1.5}
      />
      <path d="M3.5 20.5 20.5 3.5" {...STROKE} />
    </>
  ),
  attach: <path d="M17.5 8.3 10 15.8a2.5 2.5 0 0 0 3.5 3.5l7.1-7.1a4.5 4.5 0 0 0-6.4-6.4l-7 7a6.5 6.5 0 0 0 9.2 9.2l5.1-5.1" {...STROKE} />,
  emoji: (
    <>
      <circle cx="12" cy="12" r="8.6" {...STROKE} />
      <path d="M8.8 14.2a4 4 0 0 0 6.4 0" {...STROKE} />
      <path d="M9.4 9.6v.01M14.6 9.6v.01" {...STROKE} strokeWidth={2.4} />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.6" {...STROKE} />
      <path d="m16 16 4.4 4.4" {...STROKE} />
    </>
  ),
  expand: <path d="M14.5 4h5.2v5.2M20 4l-6.3 6.3M9.5 20H4.3v-5.2M4 20l6.3-6.3" {...STROKE} />,
  collapse: <path d="M19.7 9.2h-5.2V4M20.5 3.5l-6 6M4.3 14.8h5.2V20M3.5 20.5l6-6" {...STROKE} />,
  close: <path d="M5.5 5.5 18.5 18.5M18.5 5.5 5.5 18.5" {...STROKE} />,
  chevronLeft: <path d="M14.5 5.5 8 12l6.5 6.5" {...STROKE} />,
  chevronRight: <path d="M9.5 5.5 16 12l-6.5 6.5" {...STROKE} />,
  chevronDown: <path d="M5.5 9.5 12 16l6.5-6.5" {...STROKE} />,
  jumpDown: (
    <>
      <path d="M12 4.5v13" {...STROKE} />
      <path d="M6.5 12.5 12 18l5.5-5.5" {...STROKE} />
    </>
  ),
  menu: (
    <path
      d="M12 6.2v.01M12 12v.01M12 17.8v.01"
      {...STROKE}
      strokeWidth={2.6}
    />
  ),
  memory: (
    // The prompt's hot set (§5) — a bounded store, drawn as a chip rather than a brain, since
    // a brain at 14px is a blob and this sits beside real WhatsApp chrome.
    <>
      <rect x="6.2" y="6.2" width="11.6" height="11.6" rx="2.2" {...STROKE} />
      <path d="M9.5 3.2v3M14.5 3.2v3M9.5 17.8v3M14.5 17.8v3M3.2 9.5h3M3.2 14.5h3M17.8 9.5h3M17.8 14.5h3" {...STROKE} strokeWidth={1.5} />
    </>
  ),
  money: (
    // ₹ drawn rather than typed, so it takes the icon weight instead of the text font's.
    <path d="M8 4.8h8M8 9h8M15.2 4.8c0 3-2.2 4.2-5 4.2h-2l7 10" {...STROKE} />
  ),
  probe: (
    // The instrumentation toggle: a probe lead touching a surface.
    <>
      <path d="M4.5 19.5 11 13" {...STROKE} />
      <path d="M9.6 10.6 13.4 14.4 18 9.8a2.7 2.7 0 0 0 0-3.8l0 0a2.7 2.7 0 0 0-3.8 0Z" {...STROKE} />
    </>
  ),
  camera: (
    <>
      <path d="M3.6 8.8h3.1l1.5-2.4h7.6l1.5 2.4h3.1v9.6H3.6Z" {...STROKE} />
      <circle cx="12" cy="13.4" r="3.2" {...STROKE} />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" {...STROKE} />
      <path d="M12 6.8V12l3.4 2" {...STROKE} />
    </>
  ),
  copy: (
    <>
      <rect x="8.6" y="8.6" width="11" height="11" rx="2" {...STROKE} />
      <path d="M15.4 5.4H6.4a2 2 0 0 0-2 2v9" {...STROKE} />
    </>
  ),
  check: <path d="m4.8 12.6 4.6 4.6L19.2 7.4" {...STROKE} />,
}

export function Icon({ name, size = 16, title, className, ...rest }: Props) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  )
}

/**
 * §2.4's ladder as one mark.
 *
 * `queued` is deliberately not a tick: nothing has reached the wire, and drawing a check for
 * it would claim the one thing the row cannot back. It gets a clock, which is what WhatsApp
 * shows for the same state.
 */
export function Ticks({
  status,
  size = 16,
}: {
  status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'suppressed'
  size?: number
}) {
  if (status === 'suppressed') return null

  if (status === 'queued') {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label="queued" focusable="false">
        <title>queued — not on the wire yet</title>
        <circle cx="12" cy="12" r="7.4" {...STROKE} strokeWidth={1.6} />
        <path d="M12 7.6V12l3 1.8" {...STROKE} strokeWidth={1.6} />
      </svg>
    )
  }

  if (status === 'failed') {
    return (
      <svg viewBox="0 0 24 24" width={size} height={size} role="img" aria-label="failed" focusable="false">
        <title>failed — the transport refused it</title>
        <circle cx="12" cy="12" r="7.8" {...STROKE} strokeWidth={1.6} />
        <path d="M12 7.8v5.1M12 16.1v.01" {...STROKE} strokeWidth={1.9} />
      </svg>
    )
  }

  const double = status === 'delivered' || status === 'read'
  const label =
    status === 'read' ? 'read' : status === 'delivered' ? 'delivered to the handset' : 'sent — accepted by the transport'

  return (
    <svg viewBox="0 0 26 16" width={size * 1.15} height={size} role="img" aria-label={status} focusable="false">
      <title>{label}</title>
      {/* The back tick is drawn first and sits behind, so the pair overlaps the way the real
          double-check does instead of reading as two separate marks. */}
      {double ? <path d="m1.6 8.6 3.4 3.6L14.2 2.6" {...STROKE} strokeWidth={2} /> : null}
      <path d={double ? 'm8.4 8.6 3.4 3.6L21 2.6' : 'm5 8.6 3.4 3.6L17.6 2.6'} {...STROKE} strokeWidth={2} />
    </svg>
  )
}

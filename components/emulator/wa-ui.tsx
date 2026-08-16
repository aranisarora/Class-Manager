'use client'

/**
 * The handset layer.
 *
 * `ui.tsx` holds the instrument's primitives — chips, mono buttons, the dense dark idiom a
 * developer reads. This file holds the other layer: the parts that must look like WhatsApp
 * and nothing else, because the question the emulator exists to answer is *is this what the
 * parent sees?* and a diagram cannot answer it.
 *
 * They are separate files rather than one because the separation is the design. Anything
 * imported from here is claiming to be what lands on a handset, and anything imported from
 * `ui.tsx` is claiming to be the emulator talking about it. Mixing them in one module is how
 * a chip ends up inside a bubble and a screenshot starts lying.
 */

import type { ReactNode } from 'react'

import { cx } from './ui'

/* -------------------------------------------------------------------------- *
 * Avatar
 * -------------------------------------------------------------------------- */

/**
 * WhatsApp shows a photo, or a grey silhouette when there is none. Every test contact has
 * none, so a literal copy would draw twenty identical grey circles down a tray whose entire
 * job is telling twenty people apart — visual fidelity bought by destroying the thing the
 * surface is for.
 *
 * So: WhatsApp's geometry exactly (a circle, its diameters, its position), with initials on a
 * deterministic hue standing in for the photo. The hue is a hash of the contact id, not of
 * the name, so two people called "Priya" stay distinguishable and one person's colour never
 * moves between reseeds.
 */
const AVATAR_HUES = [4, 20, 40, 88, 140, 168, 190, 212, 246, 280, 316, 340]

function hueOf(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return AVATAR_HUES[h % AVATAR_HUES.length]
}

/** Two initials at most: WhatsApp truncates, and three letters in a 40px circle is mush. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (!words.length) return '?'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

export function Avatar({
  name,
  seed,
  size = 40,
  className,
  ring,
}: {
  name: string
  /** Stable identity for the colour — a contact id, never the name. */
  seed: string
  size?: number
  className?: string
  /** Drawn when the chat is open in a pane, the way WhatsApp marks the active chat. */
  ring?: boolean
}) {
  const hue = hueOf(seed)
  return (
    <span
      aria-hidden
      className={cx('relative inline-flex shrink-0 items-center justify-center rounded-full select-none', className)}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(160deg, hsl(${hue} 42% 42%), hsl(${hue} 46% 30%))`,
        color: `hsl(${hue} 60% 92%)`,
        fontSize: Math.round(size * 0.38),
        fontWeight: 500,
        letterSpacing: '0.01em',
        boxShadow: ring ? `0 0 0 2px var(--wa-accent)` : undefined,
      }}
    >
      {initialsOf(name)}
    </span>
  )
}

/* -------------------------------------------------------------------------- *
 * Bubble shell
 * -------------------------------------------------------------------------- */

/**
 * The tail.
 *
 * WhatsApp's is a filled notch that continues the bubble's own fill out to a point, drawn
 * once at the top corner on the side the message came from. A CSS triangle made of borders
 * cannot do it: the hypotenuse lands on a half-pixel at most zoom levels and leaves a hairline
 * seam against the bubble, which is precisely the kind of detail that reads as "nearly".
 * A path filled with the same custom property has no seam because it is the same paint.
 */
export function BubbleTail({ side }: { side: 'in' | 'out' }) {
  const fill = side === 'in' ? 'var(--wa-in)' : 'var(--wa-out)'
  return (
    <span className={cx('wa-tail', side === 'in' ? 'wa-tail--in' : 'wa-tail--out')} aria-hidden>
      <svg viewBox="0 0 8 13" width="8" height="13" preserveAspectRatio="none">
        <path
          d={side === 'in' ? 'M8 0 L0 0 C4 0 8 4 8 8 Z' : 'M0 0 L8 0 C4 0 0 4 0 8 Z'}
          fill={fill}
        />
      </svg>
    </span>
  )
}

/* -------------------------------------------------------------------------- *
 * Chrome
 * -------------------------------------------------------------------------- */

/**
 * A WhatsApp header/composer icon button: a bare glyph in a generous hit area, no border and
 * no fill until it is hovered. The 34px box is what keeps a 20px icon tappable without
 * drawing a button around it.
 */
export function WaIconButton({
  children,
  label,
  onClick,
  active,
  disabled,
  tone = 'default',
  className,
}: {
  children: ReactNode
  label: string
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  tone?: 'default' | 'accent' | 'danger'
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={cx(
        'inline-flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--wa-accent)]',
        disabled ? 'cursor-not-allowed opacity-35' : 'hover:bg-[color-mix(in_srgb,var(--wa-ink)_12%,transparent)]',
        tone === 'accent' ? 'text-[var(--wa-accent)]' : tone === 'danger' ? 'text-[#f15c6d]' : 'text-[var(--wa-icon)]',
        active && 'bg-[color-mix(in_srgb,var(--wa-ink)_14%,transparent)] text-[var(--wa-ink)]',
        className,
      )}
    >
      {children}
    </button>
  )
}

/**
 * The centred pill WhatsApp uses for a date divider and for its system notices ("Messages are
 * end-to-end encrypted"). Same component for both because it is the same object on the
 * handset, and giving the emulator a second look-alike is how two things that are one thing
 * drift apart.
 */
export function WaPill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="flex justify-center px-3 py-2">
      <span
        className={cx(
          'rounded-lg px-3 py-[5px] text-center text-[12.5px] leading-[17px] shadow-[0_1px_0.5px_var(--wa-shadow)]',
          'bg-[var(--wa-pill)] text-[var(--wa-ink-dim)]',
          className,
        )}
      >
        {children}
      </span>
    </div>
  )
}

/** WhatsApp's unread count: a filled accent lozenge, never a dot with a number beside it. */
export function WaUnread({ n }: { n: number }) {
  if (n <= 0) return null
  return (
    <span
      className="inline-flex h-[19px] min-w-[19px] items-center justify-center rounded-full px-[5px] text-[11.5px] leading-none font-medium"
      style={{ background: 'var(--wa-unread-bg)', color: 'var(--wa-unread-ink)' }}
      title={`${n} unread`}
    >
      {n > 99 ? '99+' : n}
    </span>
  )
}

'use client'

/**
 * Shared primitives for the emulator instrument. Dense, dark, keyboard-friendly.
 * Tailwind v4 utilities only — no component library.
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

const TONES: Record<string, string> = {
  neutral: 'border-zinc-700/70 bg-zinc-800/60 text-zinc-300',
  quiet: 'border-zinc-800 bg-zinc-900 text-zinc-500',
  template: 'border-amber-600/50 bg-amber-950/60 text-amber-300',
  window: 'border-emerald-700/40 bg-emerald-950/50 text-emerald-300',
  catalog: 'border-sky-700/40 bg-sky-950/50 text-sky-300',
  danger: 'border-rose-700/50 bg-rose-950/60 text-rose-300',
  warn: 'border-orange-700/50 bg-orange-950/50 text-orange-300',
  violet: 'border-violet-700/40 bg-violet-950/50 text-violet-300',
  admin: 'border-fuchsia-700/40 bg-fuchsia-950/40 text-fuchsia-300',
  coach: 'border-cyan-700/40 bg-cyan-950/40 text-cyan-300',
  client: 'border-teal-700/40 bg-teal-950/40 text-teal-300',
}

export function Chip({
  tone = 'neutral',
  children,
  title,
  mono = true,
  className,
}: {
  tone?: keyof typeof TONES | string
  children: ReactNode
  title?: string
  mono?: boolean
  className?: string
}) {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px text-[10px] leading-4 whitespace-nowrap',
        mono && 'font-mono',
        TONES[tone] ?? TONES.neutral,
        className,
      )}
    >
      {children}
    </span>
  )
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'default' | 'primary' | 'ghost' | 'danger'
  size?: 'xs' | 'sm'
  active?: boolean
}

export function Btn({ tone = 'default', size = 'sm', active, className, ...rest }: BtnProps) {
  const base =
    'inline-flex items-center justify-center gap-1 rounded border font-medium transition-colors select-none disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500/70'
  const sizes = { xs: 'px-1.5 py-0.5 text-[10px]', sm: 'px-2 py-1 text-[11px]' }
  const tones = {
    default: 'border-zinc-700 bg-zinc-800/80 text-zinc-200 hover:bg-zinc-700 hover:text-white',
    primary: 'border-emerald-600/70 bg-emerald-800/70 text-emerald-100 hover:bg-emerald-700',
    ghost: 'border-transparent bg-transparent text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100',
    danger: 'border-rose-800/70 bg-rose-950/60 text-rose-300 hover:bg-rose-900/70',
  }
  return (
    <button
      type="button"
      {...rest}
      className={cx(base, sizes[size], tones[tone], active && 'ring-1 ring-emerald-500/60', className)}
    />
  )
}

export function Toggle({
  on,
  onChange,
  label,
  title,
}: {
  on: boolean
  onChange: (v: boolean) => void
  label?: ReactNode
  title?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={title}
      onClick={() => onChange(!on)}
      className="group inline-flex items-center gap-2 text-[11px] text-zinc-300 focus:outline-none"
    >
      <span
        className={cx(
          'relative h-3.5 w-7 shrink-0 rounded-full border transition-colors',
          on ? 'border-rose-500/70 bg-rose-600/80' : 'border-zinc-700 bg-zinc-800',
        )}
      >
        <span
          className={cx(
            'absolute top-[1px] h-2.5 w-2.5 rounded-full bg-zinc-200 transition-transform',
            on ? 'translate-x-[15px]' : 'translate-x-[2px]',
          )}
        />
      </span>
      {label}
    </button>
  )
}

/** queued ○ · sent ✓ · delivered ✓✓ · read ✓✓ blue (§2.4). Never claims more than the row says. */
export function Ticks({ status }: { status: 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'suppressed' }) {
  switch (status) {
    case 'queued':
      return (
        <span className="font-mono text-[10px] text-zinc-500" title="queued — not on the wire yet">
          ○
        </span>
      )
    case 'sent':
      return (
        <span className="font-mono text-[10px] text-zinc-400" title="sent — accepted by the transport">
          ✓
        </span>
      )
    case 'delivered':
      return (
        <span className="font-mono text-[10px] tracking-[-0.15em] text-zinc-300" title="delivered to the handset">
          ✓✓
        </span>
      )
    case 'read':
      return (
        <span className="font-mono text-[10px] tracking-[-0.15em] text-sky-400" title="read">
          ✓✓
        </span>
      )
    case 'failed':
      return (
        <span className="font-mono text-[10px] text-rose-400" title="failed">
          ✕
        </span>
      )
    default:
      return null
  }
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-6 text-center text-[11px] leading-relaxed text-zinc-600">{children}</div>
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        'inline-block h-3 w-3 animate-spin rounded-full border border-zinc-600 border-t-emerald-400',
        className,
      )}
    />
  )
}

export const ROLE_TONE: Record<string, string> = {
  admin: 'admin',
  coach: 'coach',
  account_holder: 'client',
  player: 'violet',
  prospect: 'warn',
}

export const ROLE_SHORT: Record<string, string> = {
  admin: 'admin',
  coach: 'coach',
  account_holder: 'parent',
  player: 'player',
  prospect: 'prospect',
}

export const STATE_TONE: Record<string, string> = {
  prospect: 'warn',
  registered: 'quiet',
  engaged: 'window',
  opted_out: 'danger',
}

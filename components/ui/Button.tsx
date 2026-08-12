'use client'

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md'

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
  /** Rendered before the label — a glyph, a dot, a count. */
  leading?: ReactNode
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'border-transparent bg-accent text-white hover:opacity-90',
  secondary: 'border-line bg-raised text-ink hover:border-faint',
  ghost: 'border-transparent bg-transparent text-dim hover:bg-raised hover:text-ink',
  danger: 'border-transparent bg-bad text-white hover:opacity-90',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'h-7 gap-1.5 px-2.5 text-xs',
  md: 'h-9 gap-2 px-3.5 text-sm',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', block, leading, className, type, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={cx(
        'inline-flex select-none items-center justify-center rounded-md border font-medium',
        'transition-colors disabled:pointer-events-none disabled:opacity-45',
        VARIANT[variant],
        SIZE[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {leading}
      {children}
    </button>
  )
})

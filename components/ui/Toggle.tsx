'use client'

import { forwardRef, type ReactNode } from 'react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export type ToggleProps = {
  checked: boolean
  onChange: (next: boolean) => void
  label?: ReactNode
  /** Sits to the right of the label, quieter — a rate, a count, a reason. */
  aside?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
}

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { checked, onChange, label, aside, disabled, id, className },
  ref,
) {
  return (
    <div className={cx('flex items-center justify-between gap-3', className)}>
      {label != null && (
        <label htmlFor={id} className="min-w-0 truncate text-sm text-ink">
          {label}
        </label>
      )}
      <div className="flex shrink-0 items-center gap-2">
        {aside != null && <span className="font-mono text-[0.6875rem] text-faint">{aside}</span>}
        <button
          ref={ref}
          id={id}
          type="button"
          role="switch"
          aria-checked={checked}
          disabled={disabled}
          onClick={() => onChange(!checked)}
          className={cx(
            'relative h-5 w-9 shrink-0 rounded-full border transition-colors',
            'disabled:pointer-events-none disabled:opacity-45',
            checked ? 'border-transparent bg-accent' : 'border-line bg-raised',
          )}
        >
          <span
            className={cx(
              'absolute top-0.5 size-3.5 rounded-full bg-white transition-[left]',
              checked ? 'left-[1.125rem]' : 'left-0.5',
              !checked && 'bg-faint',
            )}
          />
        </button>
      </div>
    </div>
  )
})

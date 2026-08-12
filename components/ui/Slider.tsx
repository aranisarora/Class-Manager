'use client'

import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export type SliderProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'onChange' | 'defaultValue'
> & {
  value: number
  onChange: (next: number) => void
  label?: ReactNode
  /** How the current value reads out. Defaults to the bare number. */
  format?: (n: number) => string
  showValue?: boolean
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { value, onChange, label, format, showValue = true, min = 0, max = 100, step = 1, className, id, ...rest },
  ref,
) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {(label != null || showValue) && (
        <div className="flex items-baseline justify-between gap-3">
          {label != null && (
            <label
              htmlFor={id}
              className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-dim"
            >
              {label}
            </label>
          )}
          {showValue && (
            <span className="font-mono text-xs tabular-nums text-ink">
              {format ? format(value) : String(value)}
            </span>
          )}
        </div>
      )}
      <input
        ref={ref}
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className={cx(
          'h-1.5 w-full cursor-pointer appearance-none rounded-full bg-raised accent-accent',
          'disabled:pointer-events-none disabled:opacity-45',
        )}
        {...rest}
      />
    </div>
  )
})

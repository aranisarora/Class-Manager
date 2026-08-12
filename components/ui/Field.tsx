import type { ReactNode } from 'react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export type FieldProps = {
  label?: ReactNode
  /** Quiet help text. Hidden while `error` is showing. */
  hint?: ReactNode
  error?: ReactNode
  /** Set this and give the control the same id so the label targets it. */
  htmlFor?: string
  required?: boolean
  /** Right-aligned in the label row — a unit, a count, a reset link. */
  aside?: ReactNode
  className?: string
  children: ReactNode
}

/** Label + control + one line of help. It wraps a control, it never renders one. */
export function Field({
  label,
  hint,
  error,
  htmlFor,
  required,
  aside,
  className,
  children,
}: FieldProps) {
  return (
    <div className={cx('flex flex-col gap-1.5', className)}>
      {(label != null || aside != null) && (
        <div className="flex items-baseline justify-between gap-3">
          {label != null && (
            <label
              htmlFor={htmlFor}
              className="font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-dim"
            >
              {label}
              {required && <span className="ml-1 text-bad">*</span>}
            </label>
          )}
          {aside != null && <div className="text-xs text-faint">{aside}</div>}
        </div>
      )}
      {children}
      {error != null ? (
        <p className="text-xs text-bad">{error}</p>
      ) : hint != null ? (
        <p className="text-xs text-faint">{hint}</p>
      ) : null}
    </div>
  )
}

import type { HTMLAttributes, ReactNode } from 'react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export type PanelProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  title?: ReactNode
  /** Sits under the title, quieter. */
  subtitle?: ReactNode
  /** Right-aligned in the header row. */
  actions?: ReactNode
  /** Drop the inner padding — for panes that scroll their own content. */
  flush?: boolean
}

/** A bordered surface with an optional header row. No shadow, no gradient. */
export function Panel({
  title,
  subtitle,
  actions,
  flush,
  className,
  children,
  ...rest
}: PanelProps) {
  const hasHeader = title != null || subtitle != null || actions != null
  return (
    <div
      className={cx(
        'flex min-h-0 flex-col overflow-hidden rounded-panel border border-line bg-surface',
        className,
      )}
      {...rest}
    >
      {hasHeader && (
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-3 py-2">
          <div className="min-w-0">
            {title != null && (
              <div className="truncate font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-dim">
                {title}
              </div>
            )}
            {subtitle != null && (
              <div className="truncate text-xs text-faint">{subtitle}</div>
            )}
          </div>
          {actions != null && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={cx('flex min-h-0 flex-1 flex-col', !flush && 'p-3')}>{children}</div>
    </div>
  )
}

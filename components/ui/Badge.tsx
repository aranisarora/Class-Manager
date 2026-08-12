import type { HTMLAttributes } from 'react'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

export type BadgeTone = 'neutral' | 'accent' | 'good' | 'warn' | 'bad'

export type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone
  /** Leading status dot — for the event log, where the word is already short. */
  dot?: boolean
}

const TONE: Record<BadgeTone, string> = {
  neutral: 'border-line bg-raised text-dim',
  accent: 'border-accent/40 bg-accent/12 text-accent',
  good: 'border-good/40 bg-good/12 text-good',
  warn: 'border-warn/40 bg-warn/12 text-warn',
  bad: 'border-bad/40 bg-bad/12 text-bad',
}

const DOT: Record<BadgeTone, string> = {
  neutral: 'bg-faint',
  accent: 'bg-accent',
  good: 'bg-good',
  warn: 'bg-warn',
  bad: 'bg-bad',
}

export function Badge({ tone = 'neutral', dot, className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5',
        'font-mono text-[0.6875rem] leading-4 whitespace-nowrap',
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {dot && <span className={cx('size-1.5 rounded-full', DOT[tone])} />}
      {children}
    </span>
  )
}

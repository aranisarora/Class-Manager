'use client'

/** Transient notices — job counts after a clock move, failed calls, seed confirmations. */

import { useEmulator } from '@/lib/emulator/state'
import { cx } from './ui'

export function Toasts() {
  const { state, actions } = useEmulator()
  if (!state.toasts.length) return null
  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-50 flex w-80 flex-col gap-1.5">
      {state.toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => actions.dismissToast(t.id)}
          className={cx(
            'pointer-events-auto rounded border px-2.5 py-1.5 text-left text-[11px] leading-snug shadow-lg backdrop-blur',
            t.tone === 'error'
              ? 'border-rose-800 bg-rose-950/90 text-rose-200'
              : t.tone === 'warn'
                ? 'border-amber-800 bg-amber-950/90 text-amber-200'
                : 'border-emerald-800 bg-emerald-950/90 text-emerald-200',
          )}
        >
          {t.text}
        </button>
      ))}
    </div>
  )
}

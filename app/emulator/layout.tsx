import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'Class Manager — emulator',
  description: 'The dev surface, the test harness and the eval system, and exactly what happens in production.',
}

export const dynamic = 'force-dynamic'

/**
 * Dark ground for everything under /emulator. Deliberately does not constrain height:
 * the instrument itself claims the viewport (see `page.tsx`), while nested routes such as
 * `/emulator/sim` scroll normally.
 */
export default function EmulatorLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200 antialiased selection:bg-emerald-800/60">{children}</div>
  )
}

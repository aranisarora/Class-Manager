import SimPanel from '@/components/emulator/SimPanel'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Agent simulation',
}

/**
 * §17 / §19 phase 12 — the simulation surface.
 *
 * Same world, same clock, same inbound webhook as the human panes next door; the only difference is
 * that the person on the other end is a model with a persona and a goal.
 */
export default function SimPage() {
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-200">
      <header className="flex items-baseline gap-4 border-b border-neutral-800 px-5 py-3">
        <h1 className="text-sm font-semibold tracking-wide text-neutral-100">Agent simulation</h1>
        <p className="hidden text-xs text-neutral-500 sm:block">
          A persona, a goal, a seed. Runs against the real system through the real inbound path.
        </p>
        <a
          href="/emulator"
          className="ml-auto rounded border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:border-neutral-500 hover:text-neutral-100"
        >
          ← Emulator
        </a>
      </header>
      <SimPanel />
    </main>
  )
}

'use client'

/**
 * Which world this is, said out loud — and made readable by everything that can change it.
 *
 * The emulator was built as an instrument for a fixture and is now also the ops console for
 * a live business, and those two readings of the same screen want opposite things from the
 * operator. Every fabricating control — seed, the clock, the fault panel, the composer, the
 * delivery ladder — is refused server-side by `requireSandbox()` when `OPS_SANDBOX` is not
 * exactly '1'. That refusal is the boundary. This file is the part that makes the boundary
 * *legible*, and it does that in two halves:
 *
 *   `OpsConfigProvider` / `useOpsConfig` / `useCapability` — one fetch of `/api/ops/config`
 *     for the whole console, so any component can ask whether a capability may be offered.
 *     A strip that knew the mode privately would leave every other control unconditional,
 *     which is the same as not knowing it at all.
 *   `OpsBar` — the strip itself: the mode said in one word, the transport and commit it is
 *     saying it about, the way out, and the drive control that only a sandbox gets.
 *
 * The hiding is cosmetic and is meant to be. A control that renders, is clicked, and then
 * 403s teaches the operator that the console is broken rather than that the act is
 * forbidden — so the two agree, and neither depends on the other being right. The server
 * refuses whatever the UI does; the UI hides whatever the server would refuse.
 *
 * MOUNTING. `OpsConfigProvider` must wrap the workspace and `OpsBar` must sit inside it —
 * see `app/emulator/page.tsx`. A component that calls `useOpsConfig()` outside the provider
 * gets a fail-closed state (`sandbox: null`, which `useCapability` reads as "no"), so the
 * failure mode of forgetting the provider is a console with its destructive half hidden and
 * this bar showing a red strip that names the mistake — never a console that offers a wipe
 * it should not.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

import { SANDBOX_ONLY, type SandboxCapability } from '@/lib/ops-guard'

import { Btn, Chip, Spinner, cx } from './ui'

export type OpsConfig = {
  sandbox: boolean
  transport: string
  baseUrl: string | null
  commit: string | null
}

export type OpsConfigState = {
  status: 'loading' | 'ready' | 'locked' | 'error'
  config: OpsConfig | null
  /**
   * `true` only when the server said so. `null` covers "still asking", "the cookie has
   * expired", "the route errored" and "nobody mounted the provider", because for the one
   * decision this value drives those four are the same answer: do not offer the control.
   */
  sandbox: boolean | null
  error: string | null
  reload: () => void
}

const NOT_MOUNTED: OpsConfigState = {
  status: 'error',
  config: null,
  sandbox: null,
  error: 'OpsConfigProvider is not mounted above this component',
  reload: () => undefined,
}

const Ctx = createContext<OpsConfigState | null>(null)

/**
 * One read of `/api/ops/config`, shared.
 *
 * It is a provider rather than a hook each component calls because the answer is a property
 * of the deployment, not of a component: it cannot differ between two places on the page,
 * and every component doing its own fetch would mean the tray, the clock bar and this strip
 * each disagreeing for a few hundred milliseconds on whether the world is real.
 */
export function OpsConfigProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<OpsConfigState['status']>('loading')
  const [config, setConfig] = useState<OpsConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true

    async function read() {
      setStatus('loading')
      try {
        const res = await fetch('/api/ops/config', { cache: 'no-store' })
        // 401 is not an error — it is a cookie that expired while the tab sat open, and
        // the only useful response to it is a way back to the login.
        if (res.status === 401) {
          if (live) {
            setConfig(null)
            setStatus('locked')
          }
          return
        }
        const body = (await res.json().catch(() => null)) as (OpsConfig & { ok?: boolean; error?: string }) | null
        if (!live) return
        if (!res.ok || body?.ok !== true) {
          setConfig(null)
          setError(body?.error ?? `HTTP ${res.status}`)
          setStatus('error')
          return
        }
        setConfig({
          sandbox: body.sandbox === true,
          transport: typeof body.transport === 'string' ? body.transport : 'unknown',
          baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : null,
          commit: typeof body.commit === 'string' ? body.commit : null,
        })
        setError(null)
        setStatus('ready')
      } catch (e) {
        if (!live) return
        setConfig(null)
        setError(e instanceof Error ? e.message : String(e))
        setStatus('error')
      }
    }

    void read()
    return () => {
      live = false
    }
  }, [attempt])

  const value = useMemo<OpsConfigState>(
    () => ({
      status,
      config,
      sandbox: status === 'ready' && config ? config.sandbox : null,
      error,
      reload: () => setAttempt((n) => n + 1),
    }),
    [status, config, error],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

/** The shared answer. Outside the provider this is the fail-closed state, not a throw. */
export function useOpsConfig(): OpsConfigState {
  return useContext(Ctx) ?? NOT_MOUNTED
}

/**
 * The names `lib/ops-guard.ts` publishes as its contract with the UI. Imported rather than
 * retyped so that a capability added to the server's refusal list and not to the console is
 * a type error at the call site instead of a control that renders and then 403s.
 */
const GATED = new Set<string>(SANDBOX_ONLY)

/**
 * May this control be offered? Every consumer of the destructive half of the console asks
 * this and renders nothing when the answer is no.
 *
 * There is a visible cost and it is the right one: for the moment the config is in flight,
 * `sandbox` is `null` and the gated controls are absent, so they appear a beat after the
 * rest of the bar. Showing them first and taking them away would be the other order, and
 * the other order is the one where somebody clicks.
 */
export function useCapability(cap: SandboxCapability): boolean {
  const { sandbox } = useOpsConfig()
  // A name that is not on the shared list is not a gated capability at all; saying "no" to
  // it would silently hide a read control on the strength of a typo.
  if (!GATED.has(cap)) return true
  return sandbox === true
}

/**
 * A local mirror of `SCENARIOS` in `lib/seed.ts`.
 *
 * Copied rather than imported, for the same reason `ClockBar`'s `FALLBACK_SCENARIOS`
 * is: `lib/seed.ts` reaches `lib/db.ts` and therefore `postgres` and node builtins, and
 * pulling it across the client boundary to read three string literals would drag the
 * database driver into the browser bundle. The ids are the load-bearing half and they
 * are fixed by `SCENARIO_IDS`; the server validates against that enum regardless of what
 * this list claims, so the worst a drift here can produce is a wrong label, never a
 * wrong world.
 */
const SCENARIOS: { id: string; name: string; description: string }[] = [
  { id: 'both', name: 'Both fixtures', description: 'Ace TT Academy and Nadam Vocal on one number — tenant isolation, side by side' },
  { id: 'ace', name: 'Multi-coach fixture', description: 'Table tennis, three coaches, eight families, money in flight' },
  { id: 'solo', name: 'Solo fixture', description: '§18 — one person who is both the admin and the only coach' },
]

type Drive =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; summary: string; detail: string; failed: boolean }
  | { phase: 'failed'; summary: string; detail: string }

const LABEL = 'font-mono text-[10px] tracking-widest text-zinc-600 uppercase'

const ROW = 'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1'
const ALARM_ROW = 'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rose-900 bg-rose-950/30 px-3 py-1'

export function OpsBar() {
  const { status, config, error, reload } = useOpsConfig()
  const canDrive = useCapability('seed')
  const [scenario, setScenario] = useState<string>(SCENARIOS[0].id)
  const [drive, setDrive] = useState<Drive>({ phase: 'idle' })

  const logout = useCallback(async () => {
    // The redirect happens whether or not the POST lands. A logout that fails and leaves
    // the operator sitting on the console is the one outcome this button must not have;
    // the cookie is `HttpOnly`, so the page cannot clear it itself, but the login screen
    // is where somebody can see that they are still signed in and try again.
    await fetch('/api/ops/logout', { method: 'POST', cache: 'no-store' }).catch(() => undefined)
    window.location.href = '/ops/login'
  }, [])

  const runDrive = useCallback(async () => {
    const meta = SCENARIOS.find((s) => s.id === scenario)
    if (
      !window.confirm(
        `Run the "${meta?.name ?? scenario}" drive?\n\n` +
          'This wipes every business currently in the world, seeds the fixture in its place, ' +
          'and then runs every job the seed makes due. Nothing that is there now survives it.',
      )
    )
      return

    setDrive({ phase: 'running' })
    try {
      const res = await fetch('/api/emulator/drive', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok || body?.ok !== true) {
        const log = Array.isArray(body?.log) ? (body.log as unknown[]) : null
        setDrive({
          phase: 'failed',
          summary: String(body?.error ?? `HTTP ${res.status}`),
          detail: log ? log.join('\n') : String(body?.error ?? ''),
        })
        return
      }
      const totals = (body.totals ?? {}) as Record<string, number>
      const failed = Number(totals.failed ?? 0)
      const walked = Array.isArray(body.rounds) ? body.rounds.length : 0
      setDrive({
        phase: 'done',
        failed: failed > 0,
        summary:
          `${walked} ${walked === 1 ? 'round' : 'rounds'} · ${totals.ran ?? 0} ran` +
          (failed > 0 ? ` · ${failed} failed` : '') +
          (body.stopped === 'deadline' ? ' · cut short' : ''),
        // The whole run log, untruncated. What a drive actually did is inside the turns,
        // not in the counts, and a summary that cannot be opened is not evidence.
        detail: Array.isArray(body.log) ? (body.log as unknown[]).join('\n') : '',
      })
    } catch (e) {
      setDrive({ phase: 'failed', summary: e instanceof Error ? e.message : String(e), detail: '' })
    }
  }, [scenario])

  if (status === 'loading') {
    return (
      <div className={ROW}>
        <span className={LABEL}>ops</span>
        <Spinner />
        <span className="font-mono text-[10px] text-zinc-600">reading /api/ops/config</span>
      </div>
    )
  }

  if (status === 'locked') {
    return (
      <div className={ALARM_ROW}>
        <span className="font-mono text-[10px] tracking-widest text-rose-400 uppercase">ops</span>
        <span className="font-mono text-[11px] text-rose-200">not signed in — this session has expired</span>
        <a
          href="/ops/login"
          className="rounded border border-rose-700 bg-rose-900/50 px-2 py-0.5 text-[11px] text-rose-100 hover:bg-rose-800/60"
        >
          sign in
        </a>
      </div>
    )
  }

  if (status === 'error' || !config) {
    return (
      <div className={ALARM_ROW}>
        <span className="font-mono text-[10px] tracking-widest text-rose-400 uppercase">ops</span>
        {/*
          Mode unknown is the dangerous reading, so it is said as one. The server-side
          gate is still in force — nothing destructive is any more available than it was,
          and `useCapability` has hidden the controls that would be refused — but the
          operator cannot tell from this bar whose data is on screen.
        */}
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-rose-200">
          mode unknown — {error ?? 'config unavailable'}
        </span>
        <Btn size="xs" tone="danger" onClick={reload}>
          retry
        </Btn>
      </div>
    )
  }

  /**
   * Production gets a wash, sandbox does not, and the asymmetry is deliberate.
   *
   * Of the two ways to misread this bar, only one costs anything: believing you are in a
   * sandbox when you are not. So the production state is the marked one. It is a wash and
   * not a red bar because this console will sit in production nearly all the time, and a
   * permanent alarm is one a person stops seeing by the second day — enough tint to tell
   * the two states apart across the room, not enough to become wallpaper.
   */
  const live = !config.sandbox

  return (
    <div className={cx(ROW, live && 'border-rose-900/50 bg-rose-950/20')}>
      <span className={LABEL}>ops</span>

      <Chip
        tone={config.sandbox ? 'window' : 'danger'}
        className="px-2 py-0.5 font-semibold tracking-widest"
        title={
          config.sandbox
            ? 'OPS_SANDBOX=1 — this deployment is a sandbox. Seeding, the clock, faults and the ' +
              'composer are all live, and the world here is disposable.'
            : 'OPS_SANDBOX is not set — this is production. Every destructive control is refused ' +
              'by the server and hidden here: the businesses and conversations on this screen are real.'
        }
      >
        {config.sandbox ? 'SANDBOX' : 'PRODUCTION'}
      </Chip>

      <span className="h-4 w-px bg-zinc-800" />

      <span
        className="font-mono text-[10px] text-zinc-500"
        title={
          config.transport === 'cloud'
            ? 'TRANSPORT=cloud — outbound messages leave the building and reach real handsets'
            : 'TRANSPORT=emulator — outbound messages stop at the pane'
        }
      >
        {config.transport}
      </span>
      <span
        className="font-mono text-[10px] text-zinc-600"
        title={config.commit ? `deployed commit ${config.commit}` : 'no commit — running outside a Vercel deployment'}
      >
        {config.commit ? config.commit.slice(0, 7) : 'local'}
      </span>

      <span className="h-4 w-px bg-zinc-800" />

      {canDrive ? (
        /*
          `drive`, not a second `seed`. The clock bar's seed control builds a fixture and
          stops there; this one does that and then walks the job ladder to its fixed point,
          reporting every round it ran. They are two different acts on the same world, and
          the labels and titles have to keep saying so — a bar offering "seed" beside a bar
          offering "seed" is worse than either.
        */
        <div className="flex items-center gap-1.5">
          <span className={LABEL} title="seed a fixture and run the ladder it makes due, in one act">
            drive
          </span>
          <select
            value={scenario}
            disabled={drive.phase === 'running'}
            onChange={(e) => setScenario(e.target.value)}
            title={SCENARIOS.find((s) => s.id === scenario)?.description ?? undefined}
            className="max-w-[170px] rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] text-zinc-200 focus:border-emerald-700 focus:outline-none disabled:opacity-40"
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <Btn
            size="xs"
            tone="primary"
            disabled={drive.phase === 'running'}
            onClick={() => void runDrive()}
            title="the clock bar's seed plus every job it makes due, run to a standstill — asks first"
          >
            {drive.phase === 'running' ? <Spinner /> : 'run drive'}
          </Btn>
          {drive.phase === 'running' ? (
            <span className="font-mono text-[10px] text-zinc-500">
              seeding and running the ladder — this takes minutes
            </span>
          ) : null}
          {drive.phase === 'done' ? (
            <Chip tone={drive.failed ? 'warn' : 'window'} title={drive.detail || 'the run reported no log lines'}>
              {drive.summary}
            </Chip>
          ) : null}
          {drive.phase === 'failed' ? (
            <Chip tone="danger" title={drive.detail || drive.summary}>
              drive failed — {drive.summary}
            </Chip>
          ) : null}
        </div>
      ) : (
        /*
          No scenario picker at all in production, rather than a disabled one. A greyed
          control still says "this is a thing you could do here", and the whole point of
          the production reading of this console is that seeding is not.
        */
        <span className="font-mono text-[10px] text-zinc-500">
          destructive controls are disabled on production — read and run-jobs only
        </span>
      )}

      <div className="ml-auto flex items-center gap-2">
        {config.baseUrl ? (
          <span className="font-mono text-[10px] text-zinc-700" title="APP_BASE_URL for this deployment">
            {config.baseUrl.replace(/^https?:\/\//, '')}
          </span>
        ) : null}
        <Btn size="xs" onClick={() => void logout()} title="clear the ops session cookie and return to the login">
          logout
        </Btn>
      </div>
    </div>
  )
}

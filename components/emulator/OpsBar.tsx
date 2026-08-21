'use client'

/**
 * Which world this is, said out loud — and made readable by everything that can change it.
 *
 * The emulator was built as an instrument for a fixture and is now also the ops console for
 * a live business, and those two readings of the same screen want opposite things from the
 * operator. Every fabricating control is refused server-side, and since 0030 by one of two
 * gates rather than one: seed, the fault panel and the drive touch every tenant at once and
 * stay on `requireSandbox()` — the whole-deployment switch, `OPS_SANDBOX` exactly '1' — while
 * the controls that name a tenant moved to `requireSandboxAcademy()`, which allows the act
 * against an academy carrying `is_sandbox` and refuses it everywhere else, including when no
 * academy is named at all. That refusal is the boundary. This file is the part that makes the
 * boundary *legible*, and it does that in two halves:
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

const LABEL = 'font-mono text-[10px] tracking-widest text-zinc-600 uppercase'

const ROW = 'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1'
const ALARM_ROW = 'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-rose-900 bg-rose-950/30 px-3 py-1'

export function OpsBar() {
  const { status, config, error, reload } = useOpsConfig()

  const logout = useCallback(async () => {
    // The redirect happens whether or not the POST lands. A logout that fails and leaves
    // the operator sitting on the console is the one outcome this button must not have;
    // the cookie is `HttpOnly`, so the page cannot clear it itself, but the login screen
    // is where somebody can see that they are still signed in and try again.
    await fetch('/api/ops/logout', { method: 'POST', cache: 'no-store' }).catch(() => undefined)
    window.location.href = '/ops/login'
  }, [])


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
            : 'OPS_SANDBOX is not set — this is production. Seeding, faults and the drive reach every ' +
              'tenant at once and are refused outright; the scoped controls are refused for any academy ' +
              'not flagged as a sandbox. The businesses and conversations on this screen are real.'
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


      <span
        className="font-mono text-[10px] text-zinc-500"
        title={
          'The fault panel reaches every tenant at once and is refused here regardless. The clock ' +
          '(aimed with the “moves” picker beside it), the composer, the per-message tick marks and ' +
          'the drop controls are allowed against an academy flagged as a sandbox and nothing else — ' +
          'make one with “+ business” in the contact tray. Delivery is the exception: its route takes ' +
          'an academy but nothing in this console sends one, so it is refused here whichever academy ' +
          'is selected.'
        }
      >
        faults and delivery stay off — the rest works on a{' '}
        <span className="font-semibold tracking-widest text-emerald-400">SANDBOX</span> academy, made with “+ business”
      </span>

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

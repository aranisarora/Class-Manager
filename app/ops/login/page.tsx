'use client'

import { useState, type FormEvent } from 'react'

import { Btn, Chip, Spinner } from '@/components/emulator/ui'

/**
 * The gate's only face.
 *
 * Dressed as the instrument it opens rather than as a product login: zinc ground,
 * mono labels, the emulator's own `Btn` and `Chip`. It forces dark with zinc
 * utilities the way `app/emulator/layout.tsx` does, instead of riding the
 * token palette in `globals.css` — those tokens flip to a light theme under an OS
 * preference, and the console on the other side of this form does not.
 *
 * No `useSearchParams`. It would need a Suspense boundary to survive
 * prerendering, and this route has no layout of its own to put one in; the
 * destination is read straight off `window.location` at submit time, which is the
 * only moment it matters and is unambiguously client-side.
 */

/**
 * Where to go once the cookie is set.
 *
 * `next` arrives from the gate's redirect and is therefore attacker-controllable
 * by anyone who can get an operator to click a link, so it is treated as hostile:
 * a same-origin absolute path or nothing. `//evil.example` is a protocol-relative
 * URL the browser resolves to another host, and `/\evil.example` is the same
 * trick spelled with the slash the URL parser normalises — both look like paths
 * and neither is one.
 */
function destination(): string {
  const fallback = '/emulator'
  if (typeof window === 'undefined') return fallback
  const raw = new URLSearchParams(window.location.search).get('next')
  if (!raw || !raw.startsWith('/')) return fallback
  if (raw.startsWith('//') || raw.startsWith('/\\')) return fallback
  return raw
}

/**
 * What to say when the door says no.
 *
 * Three cases, and the distinction matters because two of them are not the
 * operator's fault and one of them is unfixable by retyping. A wrong secret stays
 * deliberately vague; the other two name the thing to go and change, because an
 * operator who cannot tell "you typed it wrong" from "this deployment is
 * misconfigured" will keep typing.
 */
function refusal(body: { error?: string; retryAfterSeconds?: number } | null): string {
  if (body?.error === 'ops_gate_unconfigured') {
    return 'the gate is closed to everyone — this deployment is missing OPS_SECRET or APP_JWT_SECRET, or OPS_SECRET is shorter than 24 characters'
  }
  if (body?.error === 'too_many_attempts') {
    const minutes = Math.max(1, Math.ceil((body.retryAfterSeconds ?? 60) / 60))
    return `too many attempts — locked out for ${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  return 'that secret was not accepted'
}

export default function OpsLoginPage() {
  const [secret, setSecret] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (busy || !secret) return
    setBusy(true)
    setError(null)

    let res: Response
    try {
      res = await fetch('/api/ops/login', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret }),
      })
    } catch {
      setError('could not reach the gate')
      setBusy(false)
      return
    }

    const body = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; retryAfterSeconds?: number }
      | null

    if (!res.ok || body?.ok !== true) {
      setError(refusal(body))
      setSecret('')
      setBusy(false)
      return
    }

    // A hard navigation rather than `router.push`. The point of this form is to
    // re-enter through middleware carrying a cookie that did not exist a moment
    // ago, and a client-side push can be served from the router cache — which
    // holds the very redirect that sent us here. Deliberately no `setBusy(false)`
    // on this path: the page is leaving, and a button that springs back to life
    // first reads as a failure.
    window.location.replace(destination())
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-950 px-4 py-10 text-zinc-200 antialiased">
      <div className="w-full max-w-[21rem]">
        <div className="mb-2.5 flex items-baseline justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-zinc-500">
            class manager
          </span>
          <Chip tone="window">ops</Chip>
        </div>

        <form onSubmit={submit} className="space-y-3.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="space-y-1">
            <h1 className="text-[13px] font-medium text-zinc-100">Operations console</h1>
            <p className="text-[11px] leading-relaxed text-zinc-500">
              Locked surface. The Meta webhook and the cron drain authenticate themselves and do
              not come through this door.
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="ops-secret"
              className="block font-mono text-[10px] uppercase tracking-[0.14em] text-zinc-500"
            >
              ops secret
            </label>
            <input
              id="ops-secret"
              autoFocus
              type="password"
              name="secret"
              autoComplete="current-password"
              spellCheck={false}
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value)
                setError(null)
              }}
              className="w-full rounded border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-[12px] tracking-wider text-zinc-200 placeholder:text-zinc-700 focus:border-emerald-700 focus:outline-none"
              placeholder="••••••••••••••••"
            />
          </div>

          <Btn
            type="submit"
            tone="primary"
            disabled={busy || !secret}
            className="w-full py-1.5 text-[12px]"
          >
            {busy ? <Spinner /> : 'unlock'}
          </Btn>

          {/* Reserved rather than conditional, so the card does not jump the first
              time a secret is refused. */}
          <p
            role="status"
            aria-live="polite"
            className="min-h-[1rem] font-mono text-[10px] leading-4 text-rose-400"
          >
            {error}
          </p>
        </form>
      </div>
    </main>
  )
}

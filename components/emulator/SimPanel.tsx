'use client'

/**
 * §17 — the agent-simulation pane.
 *
 * Pick a persona, a goal, a contact and a seed; run it; watch the transcript arrive; read the judge
 * report; diff two runs side by side. The run itself happens server-side through `POST /api/sim/run`,
 * which drives `runPersona` — this is the surface, not the harness.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { PERSONA_DEFS } from '@/lib/sim/personas'
import { GOAL_DEFS } from '@/lib/sim/goals'
import { diffRuns, formatDiff, type RunDiff, type DiffRow } from '@/lib/sim/diff'
import type { SimEntry, SimRunResult } from '@/lib/sim/run'
import type { JudgeFinding, JudgeReport, JudgeSeverity } from '@/lib/sim/judge'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const STORE_KEY = 'cm.sim.runs.v1'
const MAX_STORED = 24

type EmuContact = {
  id: string
  name: string
  phone: string
  academyName?: string
  role?: string
}

type LiveMsg = {
  id: string
  direction: 'inbound' | 'outbound'
  body: string
  buttons: string[]
  template: string | null
  suppressed: string | null
}

function asArray(v: unknown): any[] {
  return Array.isArray(v) ? v : []
}

/** The emulator state route belongs to another module; read it tolerantly. */
function flattenContacts(state: any): EmuContact[] {
  const out: EmuContact[] = []
  const push = (c: any, academyName?: string) => {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string') return
    out.push({
      id: c.id,
      name: c.profile_name ?? c.person_name ?? c.name ?? c.full_name ?? 'unnamed',
      phone: c.phone_e164 ?? c.phone ?? '',
      academyName: c.academy_name ?? c.academyName ?? academyName,
      role: c.role_hint ?? c.role ?? (Array.isArray(c.roles) ? c.roles.join('/') : undefined),
    })
  }
  for (const c of asArray(state?.contacts)) push(c)
  for (const a of asArray(state?.academies)) {
    for (const c of asArray(a?.contacts)) push(c, a?.name)
  }
  const seen = new Set<string>()
  return out.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
}

/** Display-only read of a stored message payload, for the live thread. */
function readButtonTitles(payload: any): string[] {
  const m = payload && typeof payload === 'object' ? (payload.message ?? payload) : null
  if (!m) return []
  const titles: string[] = []
  for (const b of asArray(m.buttons)) {
    const t = b?.title ?? b?.reply?.title
    if (typeof t === 'string') titles.push(t)
  }
  for (const b of asArray(m.interactive?.action?.buttons)) {
    const t = b?.reply?.title ?? b?.title
    if (typeof t === 'string') titles.push(t)
  }
  for (const s of asArray(m.list?.sections ?? m.interactive?.action?.sections)) {
    for (const r of asArray(s?.rows)) if (typeof r?.title === 'string') titles.push(r.title)
  }
  return titles
}

function normalizeThread(json: any): LiveMsg[] {
  const rows = Array.isArray(json) ? json : asArray(json?.messages ?? json?.rows ?? json?.thread)
  return rows
    .filter((m: any) => m && typeof m === 'object')
    .map((m: any) => ({
      id: String(m.id ?? ''),
      direction: m.direction === 'inbound' ? 'inbound' : 'outbound',
      body: String(m.body ?? m.payload?.body ?? ''),
      buttons: readButtonTitles(m.payload),
      template: m.template_name ?? null,
      suppressed: m.suppressed_reason ?? null,
    }))
}

function normalizeRun(json: any): { run: SimRunResult | null; error: string | null } {
  if (!json || typeof json !== 'object') return { run: null, error: 'empty response' }
  if (typeof json.error === 'string' && !json.run && !json.transcript) return { run: null, error: json.error }
  const candidate = json.run ?? json.result ?? json.data ?? json
  if (!candidate || !Array.isArray(candidate.transcript)) {
    return { run: null, error: 'the run route did not return a transcript' }
  }
  const judge: JudgeReport | null = json.judge ?? json.report ?? candidate.judge ?? null
  return { run: { ...(candidate as SimRunResult), judge }, error: null }
}

function loadStored(): SimRunResult[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((r) => r && Array.isArray(r.transcript)) : []
  } catch {
    return []
  }
}

function persist(runs: SimRunResult[]) {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(runs.slice(0, MAX_STORED)))
  } catch {
    /* quota — the run is still in memory */
  }
}

function newSeed(): string {
  return Math.random().toString(36).slice(2, 8)
}

function mmss(s: number): string {
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

const SEV_STYLE: Record<JudgeSeverity, string> = {
  critical: 'bg-red-950 text-red-300 border-red-800',
  major: 'bg-amber-950 text-amber-300 border-amber-800',
  minor: 'bg-sky-950 text-sky-300 border-sky-900',
  nit: 'bg-neutral-800 text-neutral-400 border-neutral-700',
}

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

export default function SimPanel() {
  const [contacts, setContacts] = useState<EmuContact[]>([])
  const [contactId, setContactId] = useState('')
  const [personaSlug, setPersonaSlug] = useState(PERSONA_DEFS[0].slug)
  const [goalSlug, setGoalSlug] = useState(GOAL_DEFS[0].slug)
  const [seed, setSeed] = useState('a1b2c3')
  const [maxTurns, setMaxTurns] = useState<number | ''>('')
  const [running, setRunning] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveMsg[]>([])
  const [runs, setRuns] = useState<SimRunResult[]>([])
  const [viewing, setViewing] = useState<string | null>(null)
  const [tab, setTab] = useState<'transcript' | 'judge' | 'diff'>('transcript')
  const [diffA, setDiffA] = useState<string>('')
  const [diffB, setDiffB] = useState<string>('')
  const transcriptEnd = useRef<HTMLDivElement | null>(null)

  const persona = useMemo(() => PERSONA_DEFS.find((p) => p.slug === personaSlug) ?? PERSONA_DEFS[0], [personaSlug])
  const goal = useMemo(() => GOAL_DEFS.find((g) => g.slug === goalSlug) ?? GOAL_DEFS[0], [goalSlug])
  const current = useMemo(() => runs.find((r) => r.runId === viewing) ?? null, [runs, viewing])

  useEffect(() => {
    setRuns(loadStored())
    setSeed(newSeed())
  }, [])

  useEffect(() => {
    let cancelled = false
    fetch('/api/emulator/state', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        const cs = flattenContacts(j)
        setContacts(cs)
        setContactId((prev) => prev || cs[0]?.id || '')
      })
      .catch(() => setContacts([]))
    return () => {
      cancelled = true
    }
  }, [])

  // Pair a goal that suits the persona when the persona changes.
  useEffect(() => {
    const fits = GOAL_DEFS.filter((g) => g.fits.some((f) => persona.fits.includes(f)))
    if (fits.length && !fits.some((g) => g.slug === goalSlug)) setGoalSlug(fits[0].slug)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaSlug])

  const refreshThread = useCallback(async () => {
    if (!contactId) return
    try {
      const res = await fetch(`/api/emulator/thread?contactId=${encodeURIComponent(contactId)}`, { cache: 'no-store' })
      if (!res.ok) return
      setLive(normalizeThread(await res.json()))
    } catch {
      /* the pane just stays where it was */
    }
  }, [contactId])

  // Live updates while a run is in flight: the emulator's SSE stream nudges us, and a slow poll
  // guarantees the pane fills in even if the stream is quiet.
  useEffect(() => {
    if (!running) return
    void refreshThread()
    const poll = window.setInterval(() => void refreshThread(), 1500)
    const tick = window.setInterval(() => setElapsed((e) => e + 1), 1000)
    let es: EventSource | null = null
    try {
      es = new EventSource('/api/emulator/stream')
      const nudge = () => void refreshThread()
      es.onmessage = nudge
      for (const name of ['message', 'clock', 'job', 'turn']) es.addEventListener(name, nudge)
      es.onerror = () => {
        /* polling covers it */
      }
    } catch {
      es = null
    }
    return () => {
      window.clearInterval(poll)
      window.clearInterval(tick)
      es?.close()
    }
  }, [running, refreshThread])

  useEffect(() => {
    transcriptEnd.current?.scrollIntoView({ block: 'end' })
  }, [live, current, tab])

  async function run() {
    if (!contactId || running) return
    setRunning(true)
    setElapsed(0)
    setError(null)
    setLive([])
    setTab('transcript')
    try {
      const res = await fetch('/api/sim/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          seed,
          contactId,
          // Sent by name/text: those are the keys every lookup in `lib/sim` accepts.
          persona: persona.name,
          goal: goal.text,
          personaSlug: persona.slug,
          goalSlug: goal.slug,
          ...(maxTurns ? { maxTurns: Number(maxTurns) } : {}),
        }),
      })
      const json = await res.json().catch(() => null)
      const { run: r, error: err } = normalizeRun(json)
      if (!r) {
        setError(err ?? `the run route returned ${res.status}`)
      } else {
        setRuns((prev) => {
          const next = [r, ...prev.filter((x) => x.runId !== r.runId)].slice(0, MAX_STORED)
          persist(next)
          return next
        })
        setViewing(r.runId)
        setDiffB(r.runId)
        setDiffA((prev) => prev || runs[0]?.runId || '')
        if (r.judge) setTab('judge')
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
      void refreshThread()
    }
  }

  function forget(runId: string) {
    setRuns((prev) => {
      const next = prev.filter((r) => r.runId !== runId)
      persist(next)
      return next
    })
    if (viewing === runId) setViewing(null)
  }

  const runA = runs.find((r) => r.runId === diffA) ?? null
  const runB = runs.find((r) => r.runId === diffB) ?? null
  const diff = useMemo<RunDiff | null>(() => (runA && runB && runA !== runB ? diffRuns(runA, runB) : null), [runA, runB])

  return (
    <div className="grid gap-4 p-4 lg:grid-cols-[22rem_minmax(0,1fr)]">
      {/* ------------------------------------------------------------ setup */}
      <aside className="flex flex-col gap-4">
        <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
          <Label>Persona</Label>
          <select
            value={personaSlug}
            onChange={(e) => setPersonaSlug(e.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          >
            {PERSONA_DEFS.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.name}
              </option>
            ))}
          </select>
          <p className="mt-2 text-xs leading-relaxed text-neutral-400">{persona.description}</p>
          <p className="mt-2 text-xs italic leading-relaxed text-neutral-500">{persona.style}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            {persona.traits.map((t) => (
              <span key={t} className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400">
                {t}
              </span>
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
          <Label>Goal</Label>
          <select
            value={goalSlug}
            onChange={(e) => setGoalSlug(e.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          >
            {GOAL_DEFS.map((g) => (
              <option key={g.slug} value={g.slug}>
                {g.text}
              </option>
            ))}
          </select>
          <ul className="mt-2 space-y-1">
            {goal.successCriteria.map((c) => (
              <li key={c} className="flex gap-1.5 text-xs leading-relaxed text-neutral-400">
                <span className="text-neutral-600">·</span>
                {c}
              </li>
            ))}
          </ul>
          {goal.needsClock && (
            <p className="mt-2 text-[11px] text-amber-400/80">This goal moves the clock — jobs will fire mid-run.</p>
          )}
        </section>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
          <Label>Contact</Label>
          <select
            value={contactId}
            onChange={(e) => setContactId(e.target.value)}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
          >
            {contacts.length === 0 && <option value="">no world seeded</option>}
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.role ? ` · ${c.role}` : ''}
                {c.academyName ? ` · ${c.academyName}` : ''}
              </option>
            ))}
          </select>

          <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
            <div>
              <Label>Seed</Label>
              <input
                value={seed}
                onChange={(e) => setSeed(e.target.value)}
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100"
              />
            </div>
            <div>
              <Label>Turns</Label>
              <input
                value={maxTurns}
                onChange={(e) => setMaxTurns(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="auto"
                inputMode="numeric"
                className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm text-neutral-100"
              />
            </div>
          </div>
          <button
            onClick={() => setSeed(newSeed())}
            className="mt-1 text-[11px] text-neutral-500 underline-offset-2 hover:text-neutral-300 hover:underline"
          >
            new seed
          </button>

          <button
            onClick={() => void run()}
            disabled={running || !contactId}
            className="mt-3 w-full rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {running ? `Running… ${mmss(elapsed)}` : 'Run simulation'}
          </button>
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
        </section>

        <section className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
          <Label>Runs ({runs.length})</Label>
          {runs.length === 0 && <p className="text-xs text-neutral-500">Nothing yet. Runs are kept in this browser so you can diff across a code change.</p>}
          <ul className="space-y-1">
            {runs.map((r) => (
              <li key={r.runId}>
                <div
                  className={`flex items-center gap-2 rounded border px-2 py-1.5 text-xs ${
                    viewing === r.runId ? 'border-emerald-700 bg-emerald-950/40' : 'border-neutral-800 hover:border-neutral-700'
                  }`}
                >
                  <button className="min-w-0 flex-1 text-left" onClick={() => setViewing(r.runId)}>
                    <div className="truncate text-neutral-200">{r.persona?.name}</div>
                    <div className="truncate text-[11px] text-neutral-500">
                      {r.goal?.text} · seed {r.seed} · {r.turns} turns
                      {r.judge ? ` · ${r.judge.scores.overall}/10` : ''}
                    </div>
                  </button>
                  <button
                    onClick={() => forget(r.runId)}
                    title="forget this run"
                    className="text-neutral-600 hover:text-red-400"
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </aside>

      {/* ------------------------------------------------------------- panes */}
      <section className="flex min-h-[36rem] flex-col rounded-lg border border-neutral-800 bg-neutral-900/40">
        <div className="flex items-center gap-1 border-b border-neutral-800 px-2 py-1.5">
          {(['transcript', 'judge', 'diff'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded px-2.5 py-1 text-xs capitalize ${
                tab === t ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {t}
            </button>
          ))}
          <div className="ml-auto pr-1 text-[11px] text-neutral-500">
            {current
              ? `${current.personName} · ${current.academyName} · ${current.stopReason} · temp ${current.temperature}`
              : running
                ? 'live'
                : ''}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'transcript' && (
            <TranscriptView run={current} live={live} running={running} endRef={transcriptEnd} />
          )}
          {tab === 'judge' && <JudgeView run={current} />}
          {tab === 'diff' && (
            <DiffView
              runs={runs}
              a={diffA}
              b={diffB}
              onA={setDiffA}
              onB={setDiffB}
              diff={diff}
            />
          )}
        </div>
      </section>
    </div>
  )
}

function Label({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500">{children}</div>
}

// ---------------------------------------------------------------------------
// transcript
// ---------------------------------------------------------------------------

function TranscriptView({
  run,
  live,
  running,
  endRef,
}: {
  run: SimRunResult | null
  live: LiveMsg[]
  running: boolean
  endRef: RefObject<HTMLDivElement | null>
}) {
  if (running || !run) {
    return (
      <div className="space-y-2">
        {running && (
          <p className="text-xs text-neutral-500">The persona is typing against the live world — this is the pane as it fills.</p>
        )}
        {live.length === 0 && !running && <p className="text-sm text-neutral-500">Run a simulation, or pick a run from the list.</p>}
        {live.map((m) => (
          <div key={m.id} className={m.direction === 'inbound' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                m.direction === 'inbound' ? 'bg-emerald-800/70 text-emerald-50' : 'bg-neutral-800 text-neutral-100'
              } ${m.suppressed ? 'opacity-50 line-through' : ''}`}
            >
              <div className="whitespace-pre-wrap">{m.body}</div>
              {m.buttons.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {m.buttons.map((b, i) => (
                    <span key={i} className="rounded border border-neutral-600 px-2 py-0.5 text-[11px] text-neutral-300">
                      {b}
                    </span>
                  ))}
                </div>
              )}
              {(m.template || m.suppressed) && (
                <div className="mt-1 text-[10px] text-neutral-400">
                  {m.template ? `template · ${m.template}` : ''}
                  {m.suppressed ? `dropped · ${m.suppressed}` : ''}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="mb-3 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-xs text-neutral-400">
        <span className="text-neutral-200">{run.persona.name}</span> · {run.goal.text} · seed{' '}
        <span className="font-mono">{run.seed}</span> · {run.turns} messages
        {run.clockAdvancedMs > 0 && ` · clock moved ${Math.round(run.clockAdvancedMs / 3_600_000)}h`}
        {run.error && <span className="text-red-400"> · {run.error}</span>}
      </div>
      {run.transcript.map((e) => (
        <Entry key={e.index} e={e} />
      ))}
      {run.sideEffects.length > 0 && (
        <div className="mt-4 rounded border border-neutral-800 bg-neutral-900 p-3">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            Sent to other people
          </div>
          <ul className="space-y-1">
            {run.sideEffects.map((s, i) => (
              <li key={i} className="text-xs text-neutral-400">
                <span className="text-neutral-200">{s.toName}</span>
                {s.catalogId ? <span className="text-neutral-600"> [{s.catalogId}]</span> : null}
                {s.suppressedReason ? <span className="text-amber-400"> (dropped: {s.suppressedReason})</span> : null}
                {' — '}
                {s.body}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div ref={endRef} />
    </div>
  )
}

function Entry({ e }: { e: SimEntry }) {
  if (e.kind === 'clock') {
    return (
      <div className="my-3 flex justify-center">
        <span className="rounded-full border border-amber-900 bg-amber-950/50 px-3 py-1 text-[11px] text-amber-300">
          ⏱ {e.body}
        </span>
      </div>
    )
  }
  if (e.kind === 'note') {
    return (
      <div className="my-2 text-center text-[11px] text-neutral-600">
        {e.body}
        {e.reason ? ` — ${e.reason}` : ''}
      </div>
    )
  }

  const mine = e.actor === 'persona'
  const suppressed = e.kind === 'suppressed'
  return (
    <div className={mine ? 'flex justify-end' : 'flex justify-start'}>
      <div className="max-w-[82%]">
        <div
          className={`rounded-lg px-3 py-2 text-sm ${
            mine ? 'bg-emerald-800/70 text-emerald-50' : 'bg-neutral-800 text-neutral-100'
          } ${suppressed ? 'border border-dashed border-amber-800 bg-transparent text-neutral-500' : ''}`}
        >
          {e.kind === 'tap' ? (
            <span className="text-xs">
              tapped <span className="rounded border border-emerald-500/60 px-1.5 py-0.5">{e.tapped?.title ?? e.body}</span>
            </span>
          ) : (
            <div className="whitespace-pre-wrap">{e.body}</div>
          )}
          {e.buttons && e.buttons.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {e.buttons.map((b) => (
                <span
                  key={b.actionId}
                  className="rounded border border-neutral-600 px-2 py-0.5 text-[11px] text-neutral-300"
                  title={b.description}
                >
                  {b.title}
                  {b.via === 'list' ? ' ▾' : ''}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className={`mt-0.5 flex flex-wrap gap-2 text-[10px] text-neutral-600 ${mine ? 'justify-end' : ''}`}>
          <span>{e.atLabel}</span>
          {e.catalogId && <span>{e.catalogId}</span>}
          {e.templateName ? <span className="text-amber-500">template · {e.templateName}</span> : null}
          {e.templateName == null && e.inWindow === false ? <span className="text-amber-500">out of window</span> : null}
          {e.status && e.status !== 'sent' && <span>{e.status}</span>}
          {typeof e.costPaise === 'number' && e.costPaise > 0 && <span>{e.costPaise}p</span>}
          {e.suppressedReason && <span className="text-amber-400">dropped · {e.suppressedReason}</span>}
          {typeof e.frustration === 'number' && e.frustration > 0 && <span>irritation {e.frustration}/5</span>}
          {e.reason && <span className="italic text-neutral-700">{e.reason}</span>}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------

function JudgeView({ run }: { run: SimRunResult | null }) {
  if (!run) return <p className="text-sm text-neutral-500">Pick a run.</p>
  const j = run.judge
  if (!j) return <p className="text-sm text-neutral-500">This run has no judge report.</p>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span
          className={`rounded px-2 py-1 text-xs font-medium ${
            j.goalReached ? 'bg-emerald-900 text-emerald-200' : 'bg-red-950 text-red-300'
          }`}
        >
          {j.goalReached ? 'Goal reached' : 'Goal not reached'}
        </span>
        {j.turnsToGoal !== null && <span className="text-xs text-neutral-500">in {j.turnsToGoal} messages</span>}
        <span className="ml-auto text-[11px] text-neutral-600">
          {j.model} · {j.ms}ms
        </span>
      </div>

      <p className="text-sm leading-relaxed text-neutral-300">{j.summary}</p>
      {j.goalEvidence && <p className="text-xs italic text-neutral-500">{j.goalEvidence}</p>}

      <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-5">
        {(['overall', 'clarity', 'efficiency', 'correctness', 'doctrine'] as const).map((k) => (
          <div key={k}>
            <div className="flex items-baseline justify-between text-[11px] uppercase tracking-wider text-neutral-500">
              <span>{k}</span>
              <span className="text-neutral-300">{j.scores[k]}</span>
            </div>
            <div className="mt-1 h-1.5 rounded bg-neutral-800">
              <div
                className={`h-1.5 rounded ${j.scores[k] >= 7 ? 'bg-emerald-500' : j.scores[k] >= 4 ? 'bg-amber-500' : 'bg-red-500'}`}
                style={{ width: `${Math.max(2, j.scores[k] * 10)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {j.criteria.length > 0 && (
        <div>
          <Label>Success criteria</Label>
          <ul className="space-y-1">
            {j.criteria.map((c, i) => (
              <li key={i} className="flex gap-2 text-xs leading-relaxed">
                <span className={c.met ? 'text-emerald-400' : 'text-red-400'}>{c.met ? '✓' : '✕'}</span>
                <span className="text-neutral-300">
                  {c.criterion}
                  {c.evidence && <span className="text-neutral-500"> — {c.evidence}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <Label>
          Findings — {j.counts.critical} critical · {j.counts.major} major · {j.counts.minor} minor · {j.counts.nit} nit
        </Label>
        <div className="space-y-2">
          {j.findings.map((f, i) => (
            <Finding key={i} f={f} run={run} />
          ))}
          {j.findings.length === 0 && <p className="text-xs text-neutral-500">Nothing. That is a clean run.</p>}
        </div>
      </div>
    </div>
  )
}

function Finding({ f, run }: { f: JudgeFinding; run: SimRunResult }) {
  const entry = run.transcript.find((e) => e.index === f.atIndex)
  return (
    <div className={`rounded border p-2.5 ${SEV_STYLE[f.severity]}`}>
      <div className="flex items-center gap-2 text-[11px] uppercase tracking-wider">
        <span className="font-semibold">{f.severity}</span>
        <span className="opacity-80">{f.kind.replace(/_/g, ' ')}</span>
        {f.atIndex >= 0 && <span className="opacity-60">entry {f.atIndex}</span>}
        <span className="ml-auto opacity-50">{f.source}</span>
      </div>
      {f.quote && (
        <blockquote className="mt-1.5 border-l-2 border-neutral-600 pl-2 text-xs italic opacity-90">“{f.quote}”</blockquote>
      )}
      <p className="mt-1.5 text-xs leading-relaxed text-neutral-200">{f.explanation}</p>
      {f.suggestion && <p className="mt-1 text-xs leading-relaxed text-neutral-400">→ {f.suggestion}</p>}
      {entry && entry.actor === 'system' && entry.buttons && entry.buttons.length > 0 && (
        <p className="mt-1 text-[10px] text-neutral-500">buttons there: {entry.buttons.map((b) => b.title).join(' · ')}</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

function DiffView({
  runs,
  a,
  b,
  onA,
  onB,
  diff,
}: {
  runs: SimRunResult[]
  a: string
  b: string
  onA: (v: string) => void
  onB: (v: string) => void
  diff: RunDiff | null
}) {
  const picker = (value: string, onChange: (v: string) => void, label: string) => (
    <div className="min-w-0 flex-1">
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-100"
      >
        <option value="">—</option>
        {runs.map((r) => (
          <option key={r.runId} value={r.runId}>
            {r.persona?.name} · {r.seed} · {r.turns}t{r.judge ? ` · ${r.judge.scores.overall}/10` : ''}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <div className="space-y-4">
      <div className="flex gap-3">
        {picker(a, onA, 'Before')}
        {picker(b, onB, 'After')}
      </div>

      {!diff && <p className="text-sm text-neutral-500">Pick two different runs. Same seed, same persona, same goal — that is what makes it a regression test.</p>}

      {diff && (
        <>
          {diff.warnings.length > 0 && (
            <div className="rounded border border-amber-800 bg-amber-950/40 p-2 text-xs text-amber-300">
              {diff.warnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <span
              className={`rounded px-2 py-1 text-xs font-medium ${
                diff.verdict === 'improved'
                  ? 'bg-emerald-900 text-emerald-200'
                  : diff.verdict === 'regressed'
                    ? 'bg-red-950 text-red-300'
                    : diff.verdict === 'mixed'
                      ? 'bg-amber-950 text-amber-300'
                      : 'bg-neutral-800 text-neutral-400'
              }`}
            >
              {diff.verdict}
            </span>
            <span className="text-xs text-neutral-400">{diff.summary}</span>
            <button
              className="ml-auto rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-400 hover:text-neutral-200"
              onClick={() => void navigator.clipboard?.writeText(formatDiff(diff))}
            >
              copy as text
            </button>
          </div>

          <div className="flex flex-wrap gap-4">
            {diff.scoreMovement.map((s) => {
              // Fewer turns is better; a higher score is better.
              const better = s.delta === null ? null : s.key === 'turns' ? s.delta < 0 : s.delta > 0
              return (
                <div key={s.key} className="text-xs">
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500">{s.key}</div>
                  <div className="text-neutral-300">
                    {s.a ?? '–'} → {s.b ?? '–'}
                    {s.delta !== null && s.delta !== 0 && (
                      <span className={better ? 'text-emerald-400' : 'text-red-400'}>
                        {' '}
                        ({s.delta > 0 ? '+' : ''}
                        {s.delta})
                      </span>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div className="overflow-hidden rounded border border-neutral-800">
            {diff.rows.map((r, i) => (
              <DiffLine key={i} r={r} />
            ))}
          </div>

          {(diff.findings.introduced.length > 0 || diff.findings.fixed.length > 0) && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Introduced</Label>
                {diff.findings.introduced.length === 0 && <p className="text-xs text-neutral-600">none</p>}
                {diff.findings.introduced.map((f, i) => (
                  <div key={i} className={`mb-1 rounded border p-2 text-xs ${SEV_STYLE[f.severity]}`}>
                    <span className="font-semibold uppercase">{f.severity}</span> {f.kind.replace(/_/g, ' ')} — {f.explanation}
                  </div>
                ))}
              </div>
              <div>
                <Label>Fixed</Label>
                {diff.findings.fixed.length === 0 && <p className="text-xs text-neutral-600">none</p>}
                {diff.findings.fixed.map((f, i) => (
                  <div key={i} className="mb-1 rounded border border-emerald-900 bg-emerald-950/40 p-2 text-xs text-emerald-200">
                    <span className="font-semibold uppercase">{f.severity}</span> {f.kind.replace(/_/g, ' ')} — {f.explanation}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function DiffLine({ r }: { r: DiffRow }) {
  const tone =
    r.op === 'added'
      ? 'bg-emerald-950/30'
      : r.op === 'removed'
        ? 'bg-red-950/30'
        : r.op === 'changed'
          ? 'bg-amber-950/20'
          : ''
  const cell = (e: SimEntry | null) => {
    if (!e) return <span className="text-neutral-700">—</span>
    const who = e.actor === 'persona' ? 'USER' : e.actor === 'clock' ? 'CLOCK' : 'BOT'
    return (
      <div>
        <span className="mr-1.5 text-[10px] uppercase tracking-wider text-neutral-500">{who}</span>
        <span className="text-neutral-300">{e.kind === 'tap' ? `[${e.tapped?.title ?? e.body}]` : e.body}</span>
        {e.buttons && e.buttons.length > 0 && (
          <div className="mt-0.5 text-[10px] text-neutral-500">{e.buttons.map((b) => b.title).join(' · ')}</div>
        )}
      </div>
    )
  }
  return (
    <div className={`grid grid-cols-[1.25rem_1fr_1fr] gap-2 border-b border-neutral-800/60 px-2 py-1.5 text-xs ${tone}`}>
      <div className="text-center text-neutral-600">
        {r.op === 'same' ? '' : r.op === 'changed' ? '~' : r.op === 'added' ? '+' : '−'}
      </div>
      <div>{cell(r.a)}</div>
      <div>
        {cell(r.b)}
        {r.changes
          .filter((c) => c.field !== 'body')
          .map((c, i) => (
            <div key={i} className="mt-0.5 text-[10px] text-amber-400/80">
              {c.field}: {c.from} → {c.to}
            </div>
          ))}
      </div>
    </div>
  )
}

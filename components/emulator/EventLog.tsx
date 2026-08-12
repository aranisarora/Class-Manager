'use client'

/**
 * The event log — where the spec's structural-honesty rules become visible (§17).
 *
 * Every send with template-vs-in-window, its cost, the tier it consumed and the sender
 * number it went out on. Every suppression with its reason, so §18's two rules and §16.3's
 * caps are observable rather than asserted. Every job run — ran, skipped or failed, because
 * a handler that re-checks its precondition and declines is the correct outcome (§13).
 * Every model turn with its model, tokens and latency.
 */

import { useMemo, useState } from 'react'
import {
  EVENT_KINDS,
  EVENT_LABELS,
  filterEvents,
  fmtPaise,
  fmtTime,
  useEmulator,
  usePrimaryTimezone,
  type EmuEvent,
  type EventKind,
} from '@/lib/emulator/state'
import { Btn, Chip, Empty, cx } from './ui'

const KIND_TONE: Record<EventKind, string> = {
  send: 'window',
  suppress: 'danger',
  inbound: 'catalog',
  status: 'quiet',
  job: 'violet',
  turn: 'admin',
  clock: 'template',
  fault: 'warn',
  system: 'neutral',
}

function Row({ e }: { e: EmuEvent }) {
  const { state, actions } = useEmulator()
  const tz = usePrimaryTimezone()
  const [open, setOpen] = useState(false)
  const contact = state.contacts.find((c) => c.id === e.contactId)
  const academy = state.academies.find((a) => a.id === e.academyId)

  return (
    <div className="border-b border-zinc-800/60 px-2 py-1 hover:bg-zinc-900/50">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[9px] text-zinc-600 tabular-nums">{fmtTime(e.at, tz)}</span>
        <Chip tone={KIND_TONE[e.kind]}>{e.kind}</Chip>
        {contact ? (
          <button
            type="button"
            onClick={() => actions.openPane(contact.id)}
            className="truncate text-[11px] text-zinc-300 underline-offset-2 hover:underline"
            title="open this contact as a pane"
          >
            {contact.name}
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="ml-auto shrink-0 font-mono text-[9px] text-zinc-700 hover:text-zinc-300"
          title="raw event"
        >
          {open ? '−' : '+'}
        </button>
      </div>

      <div className="mt-0.5 line-clamp-3 text-[11px] leading-snug text-zinc-400">{e.summary}</div>

      <div className="mt-1 flex flex-wrap items-center gap-1">
        {academy ? <Chip tone="quiet">{academy.name}</Chip> : null}

        {e.kind === 'send' ? (
          <>
            {e.templateName ? (
              <Chip tone="template" title="went out on an approved template — one of the eight (§16.2)">
                TEMPLATE · {e.templateName}
              </Chip>
            ) : (
              <Chip tone="window" title="free-form, inside the 24h window — costs nothing and consumes no tier">
                in-window
              </Chip>
            )}
            <Chip tone={e.costPaise ? 'warn' : 'quiet'} title="approximate conversation cost">
              {fmtPaise(e.costPaise)}
            </Chip>
            {e.tierUsed !== null ? (
              <Chip tone="catalog" title="business-initiated conversations consumed against the number's tier (§16.1)">
                tier {e.tierUsed}
                {e.tierLimit ? `/${e.tierLimit}` : ''}
              </Chip>
            ) : null}
            {e.senderPhone ? (
              <Chip tone="quiet" title="which number it went out on (§16.3)">
                {e.senderPhone}
              </Chip>
            ) : null}
            {e.catalogId ? <Chip tone="catalog">{e.catalogId}</Chip> : null}
            {e.status ? <Chip tone="quiet">{e.status}</Chip> : null}
          </>
        ) : null}

        {e.kind === 'suppress' ? (
          <Chip tone="danger" title="recorded on the message row rather than dropped silently">
            {e.reason ?? 'suppressed'}
          </Chip>
        ) : null}

        {e.kind === 'job' ? (
          <>
            <Chip tone="violet">{e.jobKind ?? e.rawKind}</Chip>
            <Chip
              tone={e.jobOutcome === 'failed' ? 'danger' : e.jobOutcome === 'skipped' ? 'quiet' : 'window'}
              title="a handler re-checks its own precondition at run time — skipping is often correct (§13)"
            >
              {e.jobOutcome ?? 'ran'}
            </Chip>
            {e.error ? <Chip tone="danger">{e.error.slice(0, 60)}</Chip> : null}
          </>
        ) : null}

        {e.kind === 'turn' ? (
          <>
            {e.model ? <Chip tone="admin">{e.model}</Chip> : null}
            {e.promptTokens !== null || e.outputTokens !== null ? (
              <Chip tone="quiet" title="prompt / output / cached tokens">
                {e.promptTokens ?? 0} → {e.outputTokens ?? 0}
                {e.cachedTokens ? ` · ${e.cachedTokens} cached` : ''}
              </Chip>
            ) : null}
            {e.ms !== null ? <Chip tone="quiet">{Math.round(e.ms)}ms</Chip> : null}
            {e.toolCalls !== null ? <Chip tone="quiet">{e.toolCalls} tools</Chip> : null}
          </>
        ) : null}

        {e.kind !== 'job' && e.kind !== 'suppress' && e.error ? <Chip tone="danger">{e.error.slice(0, 60)}</Chip> : null}
      </div>

      {open ? (
        <pre className="mt-1 max-h-64 overflow-auto rounded border border-zinc-800 bg-zinc-950 p-1.5 font-mono text-[9px] leading-relaxed break-all whitespace-pre-wrap text-zinc-500">
          {JSON.stringify(e.detail, null, 1)}
        </pre>
      ) : null}
    </div>
  )
}

function Totals({ events }: { events: EmuEvent[] }) {
  const t = useMemo(() => {
    let sends = 0
    let templates = 0
    let paise = 0
    let suppressed = 0
    let jobsRan = 0
    let jobsFailed = 0
    let turns = 0
    let tokens = 0
    for (const e of events) {
      if (e.kind === 'send') {
        sends++
        if (e.templateName) templates++
        paise += e.costPaise ?? 0
      } else if (e.kind === 'suppress') suppressed++
      else if (e.kind === 'job') {
        if (e.jobOutcome === 'failed') jobsFailed++
        else if (e.jobOutcome !== 'skipped') jobsRan++
      } else if (e.kind === 'turn') {
        turns++
        tokens += (e.promptTokens ?? 0) + (e.outputTokens ?? 0)
      }
    }
    return { sends, templates, paise, suppressed, jobsRan, jobsFailed, turns, tokens }
  }, [events])

  return (
    <div className="grid grid-cols-4 gap-px border-b border-zinc-800 bg-zinc-800/60 font-mono text-[9px]">
      {[
        { k: 'sends', v: `${t.sends}`, s: `${t.templates} on template` },
        { k: 'spend', v: fmtPaise(t.paise), s: 'conversations opened' },
        { k: 'suppressed', v: `${t.suppressed}`, s: 'never reached the wire' },
        { k: 'jobs', v: `${t.jobsRan}`, s: t.jobsFailed ? `${t.jobsFailed} failed` : 'none failed' },
      ].map((c) => (
        <div key={c.k} className="bg-zinc-900 px-1.5 py-1">
          <div className="text-zinc-600">{c.k}</div>
          <div className="text-[12px] text-zinc-200">{c.v}</div>
          <div className="truncate text-zinc-600">{c.s}</div>
        </div>
      ))}
    </div>
  )
}

export function EventLog() {
  const { state, actions } = useEmulator()
  const filtered = useMemo(() => filterEvents(state), [state])
  const allOn = EVENT_KINDS.every((k) => state.filters.kinds[k])

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-l border-zinc-800 bg-zinc-900">
      <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/80 px-2 py-1.5">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] tracking-widest text-zinc-500 uppercase">event log</span>
          <span className="font-mono text-[10px] text-zinc-600">
            {filtered.length}/{state.events.length}
          </span>
        </div>
        <div className="mt-1.5 flex items-center gap-1">
          <select
            value={state.filters.academyId}
            onChange={(e) => actions.setFilters({ academyId: e.target.value })}
            className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-300 focus:border-emerald-700 focus:outline-none"
          >
            <option value="all">all academies</option>
            {state.academies.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <input
            value={state.filters.q}
            onChange={(e) => actions.setFilters({ q: e.target.value })}
            placeholder="search…"
            className="w-28 rounded border border-zinc-800 bg-zinc-950 px-1.5 py-1 text-[11px] text-zinc-300 placeholder:text-zinc-600 focus:border-emerald-700 focus:outline-none"
          />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {EVENT_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => actions.setFilters({ kinds: { ...state.filters.kinds, [k]: !state.filters.kinds[k] } })}
              className={cx(
                'rounded border px-1.5 py-px font-mono text-[9px]',
                state.filters.kinds[k]
                  ? 'border-zinc-600 bg-zinc-800 text-zinc-200'
                  : 'border-zinc-800 bg-zinc-950 text-zinc-600 line-through',
              )}
              title={EVENT_LABELS[k]}
            >
              {k}
            </button>
          ))}
          <Btn
            size="xs"
            tone="ghost"
            onClick={() =>
              actions.setFilters({
                kinds: EVENT_KINDS.reduce(
                  (acc, k) => ({ ...acc, [k]: !allOn }),
                  {} as Record<EventKind, boolean>,
                ),
              })
            }
          >
            {allOn ? 'none' : 'all'}
          </Btn>
        </div>
      </div>

      <Totals events={filtered} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {filtered.length ? (
          filtered.slice(0, 400).map((e) => <Row key={e.id} e={e} />)
        ) : (
          <Empty>
            {state.events.length
              ? 'Nothing matches these filters.'
              : 'No events yet. Say something in a pane, or move the clock.'}
          </Empty>
        )}
        {filtered.length > 400 ? (
          <div className="px-2 py-2 text-center font-mono text-[9px] text-zinc-600">
            showing the newest 400 of {filtered.length}
          </div>
        ) : null}
      </div>
    </aside>
  )
}

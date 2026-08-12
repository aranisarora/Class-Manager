'use client'

/**
 * §5, on screen — what the bot knows about this person and where it learned it.
 *
 * Two panes, not one, because the spec's whole point is that they are different things: the
 * **hot set** is a bounded cache of what the prompt currently carries, and the **record** is
 * every fact ever written, append-only. A fact missing from the hot set has not been
 * forgotten; a hot set that lags the record just means curation has not run yet (it fires
 * every `threshold` facts, not per turn). Collapsing the two into one list would hide exactly
 * the failure this view exists to catch: the bot acting on something it was told months ago
 * and has since been corrected about.
 */

import { useCallback, useEffect, useState } from 'react'
import { Btn, Chip, Empty, Spinner, cx } from './ui'

type Fact = {
  id: string
  subjectKind: 'academy' | 'person'
  fact: string
  source: string | null
  createdAt: string
  retiredAt: string | null
  supersedes: string | null
  superseded: boolean
}

type Memory = {
  contact: { id: string; name: string; personId: string }
  academy: { id: string; name: string; memory: string | null }
  person: { id: string; name: string; memory: string | null }
  facts: Fact[]
  curate: { threshold: number; personFacts: number; academyFacts: number }
}

function HotSet({ label, title, text }: { label: string; title: string; text: string | null }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-950/60 p-1.5">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-[9px] tracking-widest text-zinc-500 uppercase">{label}</span>
        <span className="truncate text-[10px] text-zinc-600">{title}</span>
      </div>
      {text?.trim() ? (
        <p className="mt-1 text-[11px] leading-snug whitespace-pre-wrap text-zinc-300">{text.trim()}</p>
      ) : (
        <p className="mt-1 text-[11px] text-zinc-600 italic">
          nothing in the prompt yet — the bot goes in cold on this one
        </p>
      )}
    </div>
  )
}

export function MemoryPanel({ contactId }: { contactId: string }) {
  const [memory, setMemory] = useState<Memory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/emulator/memory?contactId=${encodeURIComponent(contactId)}`, {
        cache: 'no-store',
      })
      const json = await res.json()
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `${res.status} ${res.statusText}`)
      setMemory(json as Memory)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [contactId])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-zinc-800 bg-zinc-900/95 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] tracking-widest text-zinc-500 uppercase">what the bot knows</span>
        {loading ? <Spinner /> : null}
        <Btn size="xs" tone="ghost" className="ml-auto" onClick={() => void load()} title="re-read the memory">
          ↻
        </Btn>
      </div>

      {error ? (
        <div className="mt-1 rounded border border-rose-900 bg-rose-950/40 px-2 py-1 font-mono text-[10px] text-rose-300">
          {error}
        </div>
      ) : null}

      {memory ? (
        <div className="mt-1.5 space-y-1.5">
          <HotSet label="person" title={memory.person.name} text={memory.person.memory} />
          <HotSet label="academy" title={memory.academy.name} text={memory.academy.memory} />

          <div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[9px] tracking-widest text-zinc-500 uppercase">the record</span>
              <span className="text-[10px] text-zinc-600">
                {memory.facts.length} fact{memory.facts.length === 1 ? '' : 's'}, append-only
              </span>
              <span
                className="ml-auto font-mono text-[9px] text-zinc-600"
                title={`the hot set is rebuilt every ${memory.curate.threshold} facts (§5), so it can lag what is here`}
              >
                curate every {memory.curate.threshold}
              </span>
            </div>

            {memory.facts.length === 0 ? (
              <Empty>
                Nothing learned yet. Facts get written as the bot notices things — what they call
                a class, how they pay, who never taps buttons.
              </Empty>
            ) : (
              <ul className="mt-1 space-y-1">
                {memory.facts.map((f) => (
                  <li
                    key={f.id}
                    className={cx(
                      'rounded border px-1.5 py-1',
                      f.superseded || f.retiredAt
                        ? 'border-zinc-800/70 bg-zinc-950/40'
                        : 'border-zinc-800 bg-zinc-950/70',
                    )}
                  >
                    <div className="flex items-center gap-1">
                      <Chip tone={f.subjectKind === 'academy' ? 'violet' : 'admin'}>{f.subjectKind}</Chip>
                      {f.supersedes ? (
                        <Chip tone="quiet" title="written as a correction to an earlier fact">
                          correction
                        </Chip>
                      ) : null}
                      {f.superseded ? (
                        <Chip tone="warn" title="a later fact corrects this one — it is no longer current">
                          superseded
                        </Chip>
                      ) : null}
                      {f.retiredAt ? <Chip tone="quiet">retired</Chip> : null}
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-zinc-600">
                        {f.createdAt.slice(0, 10)}
                      </span>
                    </div>
                    <p
                      className={cx(
                        'mt-0.5 text-[11px] leading-snug',
                        f.superseded || f.retiredAt ? 'text-zinc-500 line-through' : 'text-zinc-200',
                      )}
                    >
                      {f.fact}
                    </p>
                    {f.source ? (
                      <p className="mt-0.5 truncate font-mono text-[9px] text-zinc-600" title={f.source}>
                        {f.source}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}

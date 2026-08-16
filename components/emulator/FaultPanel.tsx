'use client'

/**
 * Failure injection (§17). Unreachable in normal development, and where production actually
 * breaks: sends fail, numbers block, media fetches time out, web links expire mid-form,
 * the model errors. Each is a rate, not a switch, so you can watch a partial failure.
 */

import { useEffect, useState } from 'react'
import { FAULT_KINDS, FAULT_LABELS, FAULT_NOTES, useEmulator, type FaultKind } from '@/lib/emulator/state'
import { Toggle, cx } from './ui'

function FaultRow({ kind }: { kind: FaultKind }) {
  const { state, actions } = useEmulator()
  const fault = state.faults[kind]
  const [rate, setRate] = useState(fault.rate)

  useEffect(() => {
    setRate(fault.rate)
  }, [fault.rate])

  const commit = (nextActive: boolean, nextRate: number) => void actions.setFault(kind, nextActive, nextRate)

  return (
    <div className={cx('border-b border-zinc-800/60 px-2 py-1.5', fault.active && 'bg-rose-950/15')}>
      <div className="flex items-center justify-between gap-2">
        <Toggle on={fault.active} onChange={(v) => commit(v, rate)} label={FAULT_LABELS[kind]} title={FAULT_NOTES[kind]} />
        <span className={cx('font-mono text-[10px] tabular-nums', fault.active ? 'text-rose-300' : 'text-zinc-600')}>
          {Math.round(rate * 100)}%
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={Math.round(rate * 100)}
        disabled={!!state.busy[`fault:${kind}`]}
        onChange={(e) => setRate(Number(e.target.value) / 100)}
        onPointerUp={() => commit(fault.active, rate)}
        onKeyUp={() => commit(fault.active, rate)}
        onBlur={() => commit(fault.active, rate)}
        aria-label={`${FAULT_LABELS[kind]} rate`}
        className="mt-1 h-1 w-full cursor-pointer appearance-none rounded bg-zinc-800 accent-rose-500"
      />
      <div className="mt-0.5 font-mono text-[9px] leading-tight text-zinc-600">{kind}</div>
    </div>
  )
}

export function FaultPanel() {
  const { state } = useEmulator()
  const [open, setOpen] = useState(false)
  const activeCount = FAULT_KINDS.filter((k) => state.faults[k].active).length

  return (
    // Opaque instrument ground, not an alpha over whatever is behind it. This panel injects
    // faults — it is the emulator at its least handset-like — and on the light chat list a
    // translucent zinc washed every label out to unreadable grey-on-white.
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-zinc-800/50"
      >
        <span className="font-mono text-[9px] text-zinc-600">{open ? '▾' : '▸'}</span>
        <span className="font-mono text-[10px] tracking-widest text-zinc-500 uppercase">faults</span>
        {activeCount ? (
          <span className="ml-auto rounded border border-rose-700/60 bg-rose-950/60 px-1.5 py-px font-mono text-[9px] text-rose-300">
            {activeCount} armed
          </span>
        ) : (
          <span className="ml-auto font-mono text-[9px] text-zinc-600">none</span>
        )}
      </button>
      {open ? (
        <div className="max-h-72 overflow-y-auto border-t border-zinc-800">
          {FAULT_KINDS.map((k) => (
            <FaultRow key={k} kind={k} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

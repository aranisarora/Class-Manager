'use client'

/**
 * components/view/register-form.tsx — the register (§8.2 step 5).
 *
 * "`[Take register]` opens the register page on the web surface — the whole
 *  roster on one screen, toggle each, notes inline, one submit."
 *
 * And the part that earns the screen (§8.2, out-of-band changes):
 *
 * "Parents tell the coach directly that a child is out next Tuesday. The bot
 *  never sees it... on per-session billing the child is charged for a class
 *  cancelled seven days in advance. That last one is the real damage: a stale
 *  picture becomes a wrong bill. ... highest value — the register asks about it.
 *  If a player is marked absent with no cancellation on record, one tap
 *  retroactively makes it timely."
 *
 * So `absent` is never the end of the question here. Every absence without a
 * cancellation on record gets asked about, once, right where the person who
 * knows the answer is already standing.
 */

import { useMemo, useState, type FormEvent } from 'react'
import { BackToChat } from './back-to-chat'

export type RegisterPlayer = {
  playerId: string
  name: string
  /** What is already on the record for this session, if anything. */
  status: 'present' | 'late' | 'absent' | 'cancelled_timely' | null
  note: string | null
  /** True when a timely cancellation is already on record — then we don't ask. */
  hasCancellation: boolean
}

type Mark = { status: 'present' | 'late' | 'absent'; timely: boolean; note: string; noteOpen: boolean }

const OPTIONS: { value: 'present' | 'late' | 'absent'; label: string }[] = [
  { value: 'present', label: 'Present' },
  { value: 'late', label: 'Late' },
  { value: 'absent', label: 'Absent' },
]

function initial(players: RegisterPlayer[]): Record<string, Mark> {
  const out: Record<string, Mark> = {}
  for (const p of players) {
    const timely = p.status === 'cancelled_timely' || p.hasCancellation
    out[p.playerId] = {
      status: p.status === 'cancelled_timely' ? 'absent' : (p.status ?? 'present'),
      timely,
      note: p.note ?? '',
      noteOpen: Boolean(p.note),
    }
  }
  return out
}

export function RegisterForm({
  token,
  sessionId,
  players,
}: {
  token: string
  sessionId: string
  players: RegisterPlayer[]
}) {
  const [marks, setMarks] = useState<Record<string, Mark>>(() => initial(players))
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'expired' | 'error'>('idle')
  const [message, setMessage] = useState('')

  const update = (id: string, patch: Partial<Mark>) =>
    setMarks((m) => ({ ...m, [id]: { ...m[id]!, ...patch } }))

  const allPresent = () =>
    setMarks((m) => {
      const next: Record<string, Mark> = {}
      for (const [id, mark] of Object.entries(m)) next[id] = { ...mark, status: 'present', timely: false }
      return next
    })

  const counts = useMemo(() => {
    let present = 0
    let late = 0
    let absent = 0
    let timely = 0
    let unasked = 0
    for (const p of players) {
      const m = marks[p.playerId]!
      if (m.status === 'present') present++
      else if (m.status === 'late') late++
      else if (m.timely) timely++
      else {
        absent++
        if (!p.hasCancellation) unasked++
      }
    }
    return { present, late, absent, timely, unasked }
  }, [marks, players])

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (state === 'sending' || state === 'done') return
    setState('sending')
    setMessage('')
    try {
      const res = await fetch(`/w/${token}/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'register',
          sessionId,
          marks: players.map((p) => {
            const m = marks[p.playerId]!
            return {
              playerId: p.playerId,
              status: m.status,
              timely: m.status === 'absent' ? m.timely : false,
              note: m.note.trim() || null,
            }
          }),
        }),
      })
      const body = (await res.json()) as { ok: boolean; expired?: boolean; message?: string }
      if (body.expired) {
        setState('expired')
        return
      }
      if (!res.ok || !body.ok) {
        setState('error')
        setMessage(body.message ?? "That didn't save.")
        return
      }
      setState('done')
      setMessage(body.message ?? 'Register saved.')
    } catch {
      setState('error')
      setMessage('The connection dropped before the register could be saved. Nothing was recorded.')
    }
  }

  if (state === 'expired') {
    return (
      <section className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <h2 className="text-sm font-semibold">This link expired while you were marking the register</h2>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Nothing was saved. Ask for a new one in the chat — or just tell me who was out and I&rsquo;ll mark it.
        </p>
      </section>
    )
  }

  if (state === 'done') {
    return (
      <section className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950/40">
        <h2 className="text-sm font-semibold text-emerald-900 dark:text-emerald-200">{message}</h2>
        <p className="mt-1 text-sm text-emerald-800/80 dark:text-emerald-300/80">
          It&rsquo;s confirmed in your chat.
        </p>
        <div className="mt-3">
          <BackToChat />
        </div>
      </section>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {players.length} on the roster
        </p>
        <button
          type="button"
          onClick={allPresent}
          className="rounded-xl border border-neutral-300 px-3 py-1.5 text-sm font-medium dark:border-neutral-700"
        >
          Everyone present
        </button>
      </div>

      <ul className="divide-y divide-neutral-200 overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:divide-neutral-800 dark:border-neutral-800 dark:bg-neutral-900">
        {players.map((p) => {
          const m = marks[p.playerId]!
          const askTimely = m.status === 'absent' && !p.hasCancellation
          return (
            <li key={p.playerId} className="px-3 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                <div
                  role="group"
                  aria-label={`Attendance for ${p.name}`}
                  className="flex overflow-hidden rounded-xl border border-neutral-300 dark:border-neutral-700"
                >
                  {OPTIONS.map((o) => {
                    const active = m.status === o.value
                    return (
                      <button
                        key={o.value}
                        type="button"
                        aria-pressed={active}
                        onClick={() => update(p.playerId, { status: o.value, timely: o.value === 'absent' ? m.timely : false })}
                        className={`px-3 py-1.5 text-sm ${
                          active
                            ? o.value === 'absent'
                              ? 'bg-rose-600 text-white'
                              : o.value === 'late'
                                ? 'bg-amber-500 text-white'
                                : 'bg-emerald-600 text-white'
                            : 'text-neutral-600 dark:text-neutral-300'
                        }`}
                      >
                        {o.label}
                      </button>
                    )
                  })}
                </div>
              </div>

              {p.hasCancellation && m.status === 'absent' ? (
                <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
                  Cancelled in time — already on the record, so there&rsquo;s no charge.
                </p>
              ) : null}

              {askTimely ? (
                <label className="mt-2 flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 dark:bg-amber-950/30">
                  <input
                    type="checkbox"
                    checked={m.timely}
                    onChange={(e) => update(p.playerId, { timely: e.target.checked })}
                    className="mt-0.5 size-5 shrink-0 rounded border-neutral-300 dark:border-neutral-700"
                  />
                  <span className="text-xs text-amber-900 dark:text-amber-200">
                    <span className="font-medium">Did they tell you in advance?</span> I have no cancellation on
                    record for {p.name}. Tick this and it counts as cancelled in time — no charge.
                  </span>
                </label>
              ) : null}

              {m.noteOpen ? (
                <input
                  type="text"
                  value={m.note}
                  placeholder={`Note about ${p.name}`}
                  onChange={(e) => update(p.playerId, { note: e.target.value })}
                  className="mt-2 w-full rounded-xl border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950 dark:focus:border-neutral-300"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => update(p.playerId, { noteOpen: true })}
                  className="mt-1.5 text-xs text-neutral-500 underline underline-offset-2 dark:text-neutral-400"
                >
                  Add a note
                </button>
              )}
            </li>
          )
        })}
      </ul>

      {counts.unasked > 0 ? (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {counts.unasked === 1 ? 'One player is' : `${counts.unasked} players are`} marked absent with no
          cancellation on record. If they told you in advance, tick the box — otherwise they get charged for the
          class.
        </p>
      ) : null}

      {state === 'error' && message ? (
        <p className="text-sm text-rose-600 dark:text-rose-400">{message}</p>
      ) : null}

      <button
        type="submit"
        disabled={state === 'sending'}
        className="w-full rounded-xl bg-neutral-900 px-4 py-3 text-base font-medium text-white disabled:opacity-60 dark:bg-white dark:text-neutral-900"
      >
        {state === 'sending'
          ? 'Saving…'
          : `Submit register — ${counts.present} present${counts.late ? `, ${counts.late} late` : ''}${
              counts.absent ? `, ${counts.absent} absent` : ''
            }${counts.timely ? `, ${counts.timely} cancelled in time` : ''}`}
      </button>
    </form>
  )
}

export default RegisterForm

'use client'

/**
 * The money half of the product, in the pane (§6.4, §11.5).
 *
 * §17 could show every message the product sends and not one rupee it is about. The seed
 * writes tally lines and leaves payments `requested`, jobs dun for them, and none of it was
 * visible anywhere in the browser — so "did the money half work?" was a question only a psql
 * session could answer, which is exactly the state the emulator exists to end.
 *
 * It renders **what this contact is allowed to see**, because the endpoint reads through
 * their own session: an admin gets every family, a parent gets their own account, and a
 * player's number gets nothing at all — §6.7 row 4 enforced by the database rather than
 * described in a comment.
 */

import { useCallback, useEffect, useState } from 'react'
import { formatINR } from '@/lib/format'
import { fmtStamp, useEmulatorActions } from '@/lib/emulator/state'
import { Btn, Chip, Empty, Spinner, cx } from './ui'

type Line = {
  id: string
  period: string
  kind: string
  description: string
  amount: number
  reason: string | null
  playerName: string | null
}

type Payment = {
  id: string
  amount: number
  rail: string
  method: string | null
  reference: string | null
  status: string
  requestedAt: string | null
  confirmedAt: string | null
  confirmedByName: string | null
  evidenceUrl: string | null
}

type Account = {
  id: string
  name: string
  holderName: string
  holderContactId: string | null
  players: string | null
  billed: number
  paid: number
  balance: number
  lines: Line[]
  payments: Payment[]
}

type Money = {
  viewer: { contactId: string; name: string; isAdmin: boolean; seesMoney: boolean }
  academy: { id: string; name: string; timezone: string; rail: string; upiHandle: string | null }
  accounts: Account[]
  totals: { billed: number; paid: number; outstanding: number }
  attestOperation: string
}

const KIND_TONE: Record<string, string> = {
  session: 'quiet',
  monthly: 'catalog',
  term: 'catalog',
  package: 'violet',
  adjustment: 'warn',
}

function AccountCard({
  a,
  tz,
  canAttest,
  onAttest,
  busy,
}: {
  a: Account
  tz: string
  canAttest: boolean
  onAttest: (input: { paymentId?: string; accountId?: string; amount?: number; reference?: string }) => void
  busy: boolean
}) {
  const [open, setOpen] = useState(false)
  const [amount, setAmount] = useState('')
  const [reference, setReference] = useState('')
  const requested = a.payments.filter((p) => p.status === 'requested')

  return (
    <li className="rounded border border-zinc-800 bg-zinc-950/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline gap-1.5 px-1.5 py-1 text-left hover:bg-zinc-900/60"
      >
        <span className="truncate text-[11px] text-zinc-200">{a.name}</span>
        {a.players ? (
          <span className="truncate text-[10px] text-zinc-600" title="players on this account">
            {a.players}
          </span>
        ) : null}
        <span
          className={cx(
            'ml-auto shrink-0 font-mono text-[11px] tabular-nums',
            a.balance > 0 ? 'text-amber-300' : a.balance < 0 ? 'text-sky-300' : 'text-emerald-400',
          )}
          title="§6.4 — sum of tally lines minus confirmed payments"
        >
          {a.balance === 0 ? 'square' : a.balance > 0 ? `${formatINR(a.balance)} due` : `${formatINR(-a.balance)} ahead`}
        </span>
        <span className="shrink-0 font-mono text-[9px] text-zinc-600">{open ? '−' : '+'}</span>
      </button>

      {requested.length ? (
        <div className="border-t border-zinc-800/70 px-1.5 py-1">
          {requested.map((p) => (
            <div key={p.id} className="flex items-center gap-1.5">
              <Chip tone="warn" title="§11.5 — requested, waiting on the admin to say yes">
                requested {formatINR(p.amount)}
              </Chip>
              {p.requestedAt ? (
                <span className="font-mono text-[9px] text-zinc-600">{fmtStamp(p.requestedAt, tz)}</span>
              ) : null}
              {canAttest ? (
                <Btn
                  size="xs"
                  tone="primary"
                  className="ml-auto"
                  disabled={busy}
                  title="attest that this money arrived — rail 1's one transition, recorded against you"
                  onClick={() => onAttest({ paymentId: p.id })}
                >
                  {busy ? <Spinner /> : 'confirm'}
                </Btn>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className="border-t border-zinc-800/70 px-1.5 py-1">
          <div className="flex items-center gap-2 font-mono text-[9px] text-zinc-600">
            <span title="every tally line on this account">billed {formatINR(a.billed)}</span>
            <span title="confirmed payments only — requested money is not money">paid {formatINR(a.paid)}</span>
            <span className="ml-auto truncate">{a.holderName}</span>
          </div>

          {a.lines.length ? (
            <ul className="mt-1 space-y-0.5">
              {a.lines.slice(0, 12).map((l) => (
                <li key={l.id} className="flex items-baseline gap-1.5">
                  <Chip tone={KIND_TONE[l.kind] ?? 'quiet'}>{l.kind}</Chip>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-zinc-400" title={l.reason ?? undefined}>
                    {l.description}
                    {l.playerName ? <span className="text-zinc-600"> · {l.playerName}</span> : null}
                  </span>
                  <span
                    className={cx(
                      'shrink-0 font-mono text-[10px] tabular-nums',
                      l.amount < 0 ? 'text-sky-300' : 'text-zinc-300',
                    )}
                  >
                    {formatINR(l.amount)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-[10px] text-zinc-600 italic">no tally lines yet</p>
          )}

          {a.payments.length ? (
            <ul className="mt-1 space-y-0.5 border-t border-zinc-800/60 pt-1">
              {a.payments.slice(0, 8).map((p) => (
                <li key={p.id} className="flex items-baseline gap-1.5">
                  <Chip tone={p.status === 'confirmed' ? 'window' : p.status === 'failed' ? 'danger' : 'warn'}>
                    {p.status}
                  </Chip>
                  <span className="font-mono text-[10px] text-zinc-300 tabular-nums">{formatINR(p.amount)}</span>
                  {p.reference ? (
                    <span className="truncate font-mono text-[9px] text-zinc-600">{p.reference}</span>
                  ) : null}
                  <span className="ml-auto shrink-0 truncate font-mono text-[9px] text-zinc-600">
                    {p.confirmedByName ? `by ${p.confirmedByName}` : p.rail}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {canAttest ? (
            <div className="mt-1 flex items-center gap-1 border-t border-zinc-800/60 pt-1">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="amount"
                className="w-16 rounded border border-zinc-800 bg-zinc-950 px-1 py-0.5 font-mono text-[10px] text-zinc-200 placeholder:text-zinc-700 focus:border-emerald-700 focus:outline-none"
              />
              <input
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="UTR / ref"
                className="min-w-0 flex-1 rounded border border-zinc-800 bg-zinc-950 px-1 py-0.5 font-mono text-[10px] text-zinc-200 placeholder:text-zinc-700 focus:border-emerald-700 focus:outline-none"
              />
              <Btn
                size="xs"
                disabled={busy || !Number(amount)}
                title="record money that arrived without anyone having asked for it"
                onClick={() => {
                  onAttest({
                    accountId: a.id,
                    amount: Number(amount),
                    ...(reference.trim() ? { reference: reference.trim() } : {}),
                  })
                  setAmount('')
                  setReference('')
                }}
              >
                record
              </Btn>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

export function MoneyPanel({ contactId, tz }: { contactId: string; tz: string }) {
  const actions = useEmulatorActions()
  const [money, setMoney] = useState<Money | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/emulator/money?contactId=${encodeURIComponent(contactId)}`, {
        cache: 'no-store',
      })
      const json = await res.json()
      if (!res.ok || !json?.ok) throw new Error(json?.error ?? `${res.status} ${res.statusText}`)
      setMoney(json as Money)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [contactId])

  useEffect(() => {
    void load()
  }, [load])

  const attest = useCallback(
    async (input: { paymentId?: string; accountId?: string; amount?: number; reference?: string }) => {
      setBusy(true)
      try {
        const res = await fetch('/api/emulator/money', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contactId, ...input }),
        })
        const json = await res.json()
        if (!res.ok || !json?.ok) throw new Error(json?.error ?? `${res.status} ${res.statusText}`)
        actions.notify('ok', `${json.summary ?? 'attested'} · via ${json.operation}`)
        if (json.note) actions.notify('warn', json.note)
        // The receipt (§12 `CL-RECEIPT`) goes out through the one send path, so the parent's
        // pane and the event log both have something new to show.
        await Promise.all([load(), actions.refreshEvents(), actions.refreshState()])
      } catch (e) {
        actions.notify('error', `attest: ${(e as Error).message}`)
      } finally {
        setBusy(false)
      }
    },
    [actions, contactId, load],
  )

  return (
    <div className="max-h-[45%] shrink-0 overflow-y-auto border-t border-zinc-800 bg-zinc-900/95 px-2 py-1.5">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[10px] tracking-widest text-zinc-500 uppercase">money</span>
        {money ? (
          <Chip tone={money.academy.rail === 'rail1' ? 'template' : 'catalog'} title="§11.5 — rail 1 is admin attestation; rail 2 is a gateway webhook">
            {money.academy.rail}
          </Chip>
        ) : null}
        {money?.academy.upiHandle ? (
          <Chip tone="quiet" title="where a rail 1 parent is told to send it">
            {money.academy.upiHandle}
          </Chip>
        ) : null}
        {loading ? <Spinner /> : null}
        <Btn size="xs" tone="ghost" className="ml-auto" onClick={() => void load()} title="re-read the money">
          ↻
        </Btn>
      </div>

      {error ? (
        <div className="mt-1 rounded border border-rose-900 bg-rose-950/40 px-2 py-1 font-mono text-[10px] text-rose-300">
          {error}
        </div>
      ) : null}

      {money ? (
        money.accounts.length ? (
          <>
            {money.viewer.isAdmin ? (
              <div className="mt-1 flex items-center gap-2 font-mono text-[9px] text-zinc-500">
                <span title="every tally line in this academy">billed {formatINR(money.totals.billed)}</span>
                <span title="confirmed payments only">paid {formatINR(money.totals.paid)}</span>
                <span className="text-amber-400" title="sum of the families that owe something">
                  outstanding {formatINR(money.totals.outstanding)}
                </span>
                <span className="ml-auto truncate" title="the operation the confirm control runs">
                  {money.attestOperation}
                </span>
              </div>
            ) : null}
            <ul className="mt-1 space-y-1">
              {money.accounts.map((a) => (
                <AccountCard
                  key={a.id}
                  a={a}
                  tz={tz}
                  canAttest={money.viewer.isAdmin}
                  onAttest={(input) => void attest(input)}
                  busy={busy}
                />
              ))}
            </ul>
          </>
        ) : (
          <Empty>
            {money.viewer.seesMoney
              ? 'No accounts here yet.'
              : 'Money-shaped rows never route to this number (§6.7) — this contact is a coach, or a player who does not hold the account. The database refused, not the UI.'}
          </Empty>
        )
      ) : null}
    </div>
  )
}

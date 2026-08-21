'use client'

/**
 * `📎 attach › Contact` — the picker, drawn as WhatsApp draws it.
 *
 * This is the emulator standing in for a thing the surface cannot have. Every other
 * affordance on a pane is the handset's own: the composer is a composer, the buttons
 * are the buttons Meta renders, `📎 attach` opens the machine's real file picker
 * because a real file picker is what a phone opens. A contact picker has no such
 * fallback — there is no address book on this machine that means anything to a
 * coaching business in Bengaluru — so the emulator supplies one.
 *
 * WHY IT IS A PICKER AND NOT A TEXT FIELD
 * -----------------------------------------------------------------------------
 * A box to type a name and a number into would be quicker to build and would test
 * the wrong thing. What is being exercised is a person tapping two rows and hitting
 * send — no typing, no transcription, no chance to mistype the digits — because
 * that is the entire argument for the card as an onboarding route. A number typed
 * into a form here is a number that went through a human's fingers, which is the
 * road that already existed.
 *
 * The typed field is still here, at the bottom, and it is deliberately the last
 * thing: somebody who wants a specific number — a duplicate, a foreign one, one
 * that belongs to another tenant — should be able to have it, and that is a
 * deliberate act rather than the default path.
 *
 * THREE SECTIONS, AND THE ORDER IS THE ARGUMENT
 * -----------------------------------------------------------------------------
 * **On this phone** is `phonebookFor(academyId)` — people this business knows and
 * the product does not. It is first because it is the case the feature is for: a
 * roster arriving without anybody typing a digit.
 *
 * **Already in this academy** is the world's own contacts. It is second because
 * sharing somebody the product already holds is a real thing a person does by
 * accident, and what the product does about it is worth watching. It is also the
 * only way to reach the duplicate case without hand-typing a number.
 *
 * **A new contact** is last, per above.
 *
 * NOTHING HERE INVENTS A NUMBER
 * -----------------------------------------------------------------------------
 * The book's numbers are derived from the academy id (`lib/phonebook.ts` has the
 * argument, and it is about §10.1 rather than about tidiness). The saved section
 * shows numbers that already exist. Only the typed field can produce a number
 * nobody derived, and it is checked by `dialablePhone` — the same predicate
 * `add_family` refuses on — before the row can be added, so a card that leaves
 * this sheet is one the operations will accept.
 */

import { useMemo, useState } from 'react'

import { dialablePhone, formatPhone } from '@/lib/format'
import { phonebookFor, type PhonebookEntry } from '@/lib/phonebook'
import type { SharedContact } from '@/lib/messaging/contact-card'
import { MAX_SHARED_CONTACTS } from '@/lib/messaging/contact-card'
import { Icon } from './icons'
import { Chip, cx } from './ui'
import { Avatar, WaIconButton } from './wa-ui'

/** A person already in this world, offered so the duplicate case is reachable. */
export type SavedContact = { name: string; phone: string; role?: string; contactId: string }

function Row({
  name,
  phone,
  seed,
  note,
  picked,
  disabled,
  onToggle,
}: {
  name: string
  phone: string
  seed: string
  note?: string
  picked: boolean
  disabled: boolean
  onToggle: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled && !picked}
      onClick={onToggle}
      className={cx(
        'flex w-full items-center gap-3 px-4 py-2 text-left',
        disabled && !picked ? 'cursor-not-allowed opacity-40' : 'hover:bg-white/5',
      )}
      style={{ borderBottom: '1px solid var(--wa-rule)' }}
    >
      <Avatar name={name} seed={seed} size={38} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px]" style={{ color: 'var(--wa-ink)' }}>
          {name}
        </span>
        <span className="flex items-center gap-1.5 text-[12.5px]" style={{ color: 'var(--wa-ink-dim)' }}>
          <span className="truncate">{formatPhone(phone)}</span>
          {note ? <Chip tone="quiet">{note}</Chip> : null}
        </span>
      </span>
      <span
        aria-hidden
        className="flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full"
        style={{
          background: picked ? 'var(--wa-accent)' : 'transparent',
          boxShadow: picked ? undefined : 'inset 0 0 0 1.5px var(--wa-ink-faint)',
          color: 'var(--wa-header)',
        }}
      >
        {picked ? <Icon name="check" size={12} /> : null}
      </span>
    </button>
  )
}

export function ContactSheet({
  academyId,
  saved,
  onClose,
  onShare,
}: {
  /** Whose address book. The numbers are derived from it — see `lib/phonebook.ts`. */
  academyId: string
  /** Everybody this world already holds, for the deliberate duplicate case. */
  saved: SavedContact[]
  onClose: () => void
  onShare: (contacts: SharedContact[]) => void
}) {
  const book = useMemo<PhonebookEntry[]>(() => phonebookFor(academyId), [academyId])
  /** Keyed by phone, because the phone is what a card actually carries. */
  const [picked, setPicked] = useState<Map<string, SharedContact>>(new Map())
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [newError, setNewError] = useState<string | null>(null)

  const savedPhones = useMemo(() => new Set(saved.map((s) => s.phone)), [saved])
  const full = picked.size >= MAX_SHARED_CONTACTS

  const toggle = (c: SharedContact) => {
    setPicked((prev) => {
      const next = new Map(prev)
      if (next.has(c.phone)) next.delete(c.phone)
      else if (next.size < MAX_SHARED_CONTACTS) next.set(c.phone, c)
      return next
    })
  }

  const addTyped = () => {
    const name = newName.trim()
    if (!name) {
      setNewError('a contact card carries a name')
      return
    }
    // The same refusal `add_family` gives, at the moment the number is typed rather
    // than four turns later inside a staged plan.
    const dialable = dialablePhone(newPhone)
    if (!dialable.ok) {
      setNewError(`that number will not reach anyone — ${dialable.why}`)
      return
    }
    setNewError(null)
    setNewName('')
    setNewPhone('')
    toggle({ name, phone: dialable.phone })
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col justify-end bg-black/50" onClick={onClose}>
      <div
        className="flex max-h-[82%] flex-col rounded-t-lg"
        style={{ background: 'var(--wa-shell)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex shrink-0 items-center justify-between px-4 py-3"
          style={{ borderBottom: '1px solid var(--wa-rule)' }}
        >
          <span className="text-[15px] font-medium" style={{ color: 'var(--wa-ink)' }}>
            {picked.size > 0 ? `${picked.size} selected` : 'Share a contact'}
          </span>
          <WaIconButton label="close" onClick={onClose}>
            <Icon name="close" size={18} />
          </WaIconButton>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-4 py-2 text-[13px] font-medium" style={{ color: 'var(--wa-accent)' }}>
            On this phone
          </div>
          {book.map((e) => (
            <Row
              key={e.phone}
              name={e.name}
              phone={e.phone}
              seed={e.phone}
              note={savedPhones.has(e.phone) ? 'already on the books' : undefined}
              picked={picked.has(e.phone)}
              disabled={full}
              onToggle={() => toggle({ name: e.name, phone: e.phone })}
            />
          ))}

          {saved.length > 0 ? (
            <>
              <div className="px-4 py-2 text-[13px] font-medium" style={{ color: 'var(--wa-accent)' }}>
                Already in this academy
              </div>
              {saved.map((s) => (
                <Row
                  key={s.contactId}
                  name={s.name}
                  phone={s.phone}
                  seed={s.contactId}
                  note={s.role}
                  picked={picked.has(s.phone)}
                  disabled={full}
                  onToggle={() => toggle({ name: s.name, phone: s.phone })}
                />
              ))}
            </>
          ) : null}

          <div className="px-4 py-2 text-[13px] font-medium" style={{ color: 'var(--wa-accent)' }}>
            A new contact
          </div>
          <div className="flex flex-col gap-2 px-4 pb-4">
            <div className="flex gap-2">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Name"
                className="min-w-0 flex-1 rounded-lg px-3 py-2 text-[15px] outline-none"
                style={{ background: 'var(--wa-input)', color: 'var(--wa-ink)' }}
              />
              <input
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addTyped()
                  }
                }}
                placeholder="+91 98450 12345"
                inputMode="tel"
                className="min-w-0 flex-1 rounded-lg px-3 py-2 text-[15px] outline-none"
                style={{ background: 'var(--wa-input)', color: 'var(--wa-ink)' }}
              />
              <button
                type="button"
                onClick={addTyped}
                title="add this person to the selection"
                aria-label="add this person to the selection"
                className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-full"
                style={{ background: 'var(--wa-accent)', color: 'var(--wa-header)' }}
              >
                <Icon name="plus" size={18} />
              </button>
            </div>
            {newError ? (
              <span className="text-[12px]" style={{ color: '#f15c6d' }}>
                {newError}
              </span>
            ) : null}
            <span className="probe opacity-60">
              the book above is derived from this academy&apos;s id, so no other tenant is ever offered
              these numbers — a number typed here is yours, collisions included
            </span>
          </div>
        </div>

        <div
          className="flex shrink-0 items-center gap-2 px-4 py-3"
          style={{ borderTop: '1px solid var(--wa-rule)' }}
        >
          <span className="min-w-0 flex-1 truncate text-[13px]" style={{ color: 'var(--wa-ink-dim)' }}>
            {picked.size === 0
              ? 'pick one or more, the way WhatsApp lets you'
              : [...picked.values()].map((c) => c.name).join(', ')}
          </span>
          <button
            type="button"
            disabled={picked.size === 0}
            onClick={() => onShare([...picked.values()])}
            className="flex h-9 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium disabled:opacity-35"
            style={{ background: 'var(--wa-accent)', color: 'var(--wa-header)' }}
          >
            <Icon name="send" size={15} />
            Send
          </button>
        </div>
      </div>
    </div>
  )
}

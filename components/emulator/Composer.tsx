'use client'

/**
 * The pane's input. Free text always works (§4.1 rule 4) — there is no state in which the
 * only way forward is a button. Plus the two multimodal affordances (§14.5) and a hand
 * driver for delivery status (§2.4).
 */

import { useRef, useState } from 'react'
import { LIMITS } from '@/lib/messaging/types'
import { sampleTimetableImage, sampleVoiceNote } from './SampleMedia'
import { Btn, Spinner, cx } from './ui'

export function Composer({
  busy,
  optedOut,
  onSendText,
  onSendMedia,
  onMarkRead,
  markReadDisabled,
}: {
  busy: boolean
  optedOut: boolean
  onSendText: (text: string) => void
  onSendMedia: (url: string, caption?: string) => void
  onMarkRead: () => void
  markReadDisabled: boolean
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  const over = text.length > LIMITS.textChars

  const submit = () => {
    const t = text.trim()
    if (!t || busy || over) return
    setText('')
    onSendText(t)
    ref.current?.focus()
  }

  return (
    <div className="shrink-0 border-t border-zinc-800 bg-zinc-900/80">
      {optedOut ? (
        <div className="border-b border-rose-950 bg-rose-950/30 px-2 py-1 text-center text-[10px] text-rose-300">
          this contact has opted out — inbound still resolves, outbound is suppressed
        </div>
      ) : null}
      <div className="flex items-end gap-1 px-1.5 py-1.5">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder="type as this contact…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          className={cx(
            'max-h-28 min-h-[30px] flex-1 resize-none rounded border bg-zinc-950 px-2 py-1.5 text-[12px] leading-snug text-zinc-100 placeholder:text-zinc-600 focus:outline-none',
            over ? 'border-rose-700 focus:border-rose-600' : 'border-zinc-700 focus:border-emerald-700',
          )}
        />
        <Btn tone="primary" onClick={submit} disabled={busy || !text.trim() || over} title="send (Enter)">
          {busy ? <Spinner /> : 'send'}
        </Btn>
      </div>
      <div className="flex items-center gap-1 border-t border-zinc-800/70 px-1.5 py-1">
        <Btn
          size="xs"
          disabled={busy}
          title="attach a sample voice note — goes to the model as audio (§14.5)"
          onClick={() => onSendMedia(sampleVoiceNote(), text.trim() || undefined)}
        >
          🎙 voice note
        </Btn>
        <Btn
          size="xs"
          disabled={busy}
          title="attach a photographed timetable — the §7.1 data-entry case"
          onClick={() => onSendMedia(sampleTimetableImage(), text.trim() || undefined)}
        >
          🖼 timetable
        </Btn>
        <Btn
          size="xs"
          disabled={markReadDisabled}
          onClick={onMarkRead}
          title="advance the newest outbound message's delivery status by hand"
          className="ml-auto"
        >
          ✓✓ mark read
        </Btn>
        {over ? (
          <span className="font-mono text-[9px] text-rose-400">
            {text.length}/{LIMITS.textChars}
          </span>
        ) : null}
      </div>
    </div>
  )
}

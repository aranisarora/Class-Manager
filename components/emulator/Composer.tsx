'use client'

/**
 * The pane's input, drawn as WhatsApp's composer bar.
 *
 * Free text always works (§4.1 rule 4) — there is no state in which the only way forward is a
 * button. Plus attachments (§14.5), which are a file picker and a drop target rather than a
 * menu of canned samples: WhatsApp lets you send whatever is on your phone, so the emulator
 * has to as well. The interesting test is a photographed timetable *you* chose, a voice note
 * in Kannada, a fee receipt as a PDF — none of which a hardcoded sample stands in for.
 *
 * The one control here that is not WhatsApp's is the delivery-ladder button (§2.4). It is
 * genuinely the emulator talking rather than the handset, so it sits in the probe row under
 * the bar and disappears with the rest of the instrumentation, instead of being smuggled in
 * beside the send button where it would read as something a person can press.
 */

import { useRef, useState } from 'react'
import { LIMITS } from '@/lib/messaging/types'
import { Icon, Ticks } from './icons'
import { Spinner, cx } from './ui'
import { WaIconButton } from './wa-ui'

/** Client-side ceiling. The route accepts more; this is the honest "WhatsApp would refuse" line. */
const MAX_BYTES = 16 * 1024 * 1024

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** Everything the model can actually read (§14.5). Anything else still sends — the bot's
 *  refusal to read a .docx is itself worth testing — but the composer says so up front. */
function readableByModel(mime: string): boolean {
  return /^(image|audio|video)\//i.test(mime) || mime === 'application/pdf'
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error(`could not read ${file.name}`))
    r.readAsDataURL(file)
  })
}

export function Composer({
  busy,
  optedOut,
  chrome = true,
  onSendText,
  onSendMedia,
  nextRung,
  onAdvanceStatus,
  advanceDisabled,
}: {
  busy: boolean
  optedOut: boolean
  chrome?: boolean
  onSendText: (text: string) => void
  onSendMedia: (media: { url: string; mimeType: string; filename: string }, caption?: string) => void
  /** The rung the newest outbound message can reach next, or null when it is at the top. */
  nextRung: 'delivered' | 'read' | null
  onAdvanceStatus: () => void
  advanceDisabled: boolean
}) {
  const [text, setText] = useState('')
  const [attachError, setAttachError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [dropping, setDropping] = useState(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const over = text.length > LIMITS.textChars

  const submit = () => {
    const t = text.trim()
    if (!t || busy || over) return
    setText('')
    onSendText(t)
    ref.current?.focus()
  }

  const attach = async (file: File | null | undefined) => {
    if (!file || busy) return
    setAttachError(null)
    if (file.size > MAX_BYTES) {
      setAttachError(`${file.name} is ${fmtSize(file.size)} — over the ${fmtSize(MAX_BYTES)} limit`)
      return
    }
    setReading(true)
    try {
      const url = await readAsDataUrl(file)
      // A file with no type at all (some .ogg, anything unusual) still has to arrive as
      // something, and octet-stream is the honest answer rather than a guess.
      const mimeType = file.type || 'application/octet-stream'
      const caption = text.trim() || undefined
      setText('')
      onSendMedia({ url, mimeType, filename: file.name }, caption)
      if (!readableByModel(mimeType)) {
        setAttachError(`sent as ${mimeType} — the model reads images, audio, video and PDF`)
      }
    } catch (e) {
      setAttachError((e as Error).message)
    } finally {
      setReading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const canSend = !!text.trim() && !busy && !over

  return (
    <div
      className={cx('shrink-0 transition-colors')}
      style={{ background: dropping ? 'color-mix(in srgb, var(--wa-accent) 18%, var(--wa-header))' : 'var(--wa-header)' }}
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDropping(false)
        void attach(e.dataTransfer.files?.[0])
      }}
    >
      {optedOut ? (
        <div
          className="px-3 py-1.5 text-center text-[12.5px]"
          style={{ background: 'rgba(241,92,109,0.12)', color: '#f15c6d' }}
        >
          this contact has opted out — inbound still resolves, outbound is suppressed
        </div>
      ) : null}
      {attachError ? (
        <div className="flex items-start gap-1.5 px-3 py-1.5 text-[12px]" style={{ background: 'rgba(214,160,41,0.12)', color: '#d6a029' }}>
          <span className="min-w-0 flex-1">{attachError}</span>
          <button type="button" onClick={() => setAttachError(null)} aria-label="dismiss" className="opacity-70 hover:opacity-100">
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : null}

      {/* the bar itself */}
      <div className="flex items-end gap-1 px-2 py-2">
        <input ref={fileRef} type="file" className="hidden" onChange={(e) => void attach(e.target.files?.[0])} />
        <WaIconButton label="emoji — the composer takes them as ordinary text" disabled>
          <Icon name="emoji" size={22} />
        </WaIconButton>
        <WaIconButton
          label="attach any file — image, voice note, video or PDF reaches the model as itself (§14.5). Drag one in or paste a screenshot."
          disabled={busy || reading}
          onClick={() => fileRef.current?.click()}
        >
          {reading ? <Spinner /> : <Icon name="attach" size={21} />}
        </WaIconButton>

        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={dropping ? 'drop the file to send it…' : 'Type a message'}
          onChange={(e) => setText(e.target.value)}
          onPaste={(e) => {
            // Screenshot straight from the clipboard, the way WhatsApp Web takes it.
            const file = Array.from(e.clipboardData.files ?? [])[0]
            if (file) {
              e.preventDefault()
              void attach(file)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          className="max-h-[100px] min-h-[42px] flex-1 resize-none rounded-lg px-3 py-[11px] text-[15px] leading-[20px] outline-none"
          style={{
            background: 'var(--wa-input)',
            color: 'var(--wa-ink)',
            boxShadow: over ? 'inset 0 0 0 1px #f15c6d' : undefined,
          }}
        />

        {/* WhatsApp swaps the mic for a send arrow the moment there is something to send.
            Keeping both on screen is the other common tell. */}
        <WaIconButton
          label={canSend ? 'send (Enter)' : 'nothing to send yet'}
          tone={canSend ? 'accent' : 'default'}
          disabled={!canSend}
          onClick={submit}
        >
          {busy ? <Spinner /> : <Icon name={canSend ? 'send' : 'mic'} size={21} />}
        </WaIconButton>
      </div>

      {/* ---------------- probe ---------------- */}
      {chrome ? (
        <div
          className="probe-dim flex items-center gap-2 px-3 py-1"
          style={{ borderTop: '1px solid var(--wa-rule)' }}
        >
          <span className="probe opacity-60">drop or paste a file</span>
          {/* One rung, never the whole ladder. This control used to jump straight to `read`,
              which meant `delivered` — the state a message is in on the handset of someone
              who has not looked yet — could not be produced from the UI at all (§2.4). */}
          <button
            type="button"
            disabled={advanceDisabled}
            onClick={onAdvanceStatus}
            title={
              nextRung === 'delivered'
                ? 'the newest outbound message reached the transport — mark it delivered to the handset'
                : nextRung === 'read'
                  ? 'it is on the handset — mark it read, as if they opened the chat'
                  : 'nothing to advance: the newest outbound message is queued, read, or there is none'
            }
            className="probe ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 disabled:opacity-35 enabled:hover:bg-white/10"
            style={{ color: nextRung === 'read' ? 'var(--wa-tick)' : 'var(--wa-ink-dim)' }}
          >
            <Ticks status={nextRung === 'read' ? 'read' : 'delivered'} size={13} />
            mark {nextRung ?? 'delivered'}
          </button>
          {over ? (
            <span className="probe text-rose-400">
              {text.length}/{LIMITS.textChars}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

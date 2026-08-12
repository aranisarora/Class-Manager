'use client'

/**
 * The pane's input. Free text always works (§4.1 rule 4) — there is no state in which the
 * only way forward is a button. Plus attachments (§14.5 — multimodal in) and a hand driver
 * for delivery status (§2.4).
 *
 * Attachments are a file picker and a drop target, not a menu of canned samples. WhatsApp
 * lets you send whatever is on your phone, so the emulator has to as well: the interesting
 * test is a photographed timetable *you* chose, a voice note in Kannada, a fee receipt as a
 * PDF — none of which a hardcoded sample can stand in for.
 */

import { useRef, useState } from 'react'
import { LIMITS } from '@/lib/messaging/types'
import { Btn, Spinner, cx } from './ui'

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
  onSendText,
  onSendMedia,
  onMarkRead,
  markReadDisabled,
}: {
  busy: boolean
  optedOut: boolean
  onSendText: (text: string) => void
  onSendMedia: (media: { url: string; mimeType: string; filename: string }, caption?: string) => void
  onMarkRead: () => void
  markReadDisabled: boolean
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

  return (
    <div
      className={cx(
        'shrink-0 border-t bg-zinc-900/80 transition-colors',
        dropping ? 'border-emerald-600 bg-emerald-950/20' : 'border-zinc-800',
      )}
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
        <div className="border-b border-rose-950 bg-rose-950/30 px-2 py-1 text-center text-[10px] text-rose-300">
          this contact has opted out — inbound still resolves, outbound is suppressed
        </div>
      ) : null}
      {attachError ? (
        <div className="flex items-start gap-1.5 border-b border-amber-900/60 bg-amber-950/25 px-2 py-1 text-[10px] text-amber-300">
          <span className="min-w-0 flex-1">{attachError}</span>
          <button type="button" onClick={() => setAttachError(null)} className="text-amber-500 hover:text-amber-200">
            ✕
          </button>
        </div>
      ) : null}
      <div className="flex items-end gap-1 px-1.5 py-1.5">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={dropping ? 'drop the file to send it…' : 'type as this contact…'}
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
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => void attach(e.target.files?.[0])}
        />
        <Btn
          size="xs"
          disabled={busy || reading}
          title="attach any file — image, voice note, video or PDF reaches the model as itself (§14.5). Drag one in or paste a screenshot."
          onClick={() => fileRef.current?.click()}
        >
          {reading ? <Spinner /> : '📎 attach'}
        </Btn>
        <span className="font-mono text-[9px] text-zinc-600">or drop / paste a file</span>
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

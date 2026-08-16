'use client'

/**
 * WhatsApp's markup, rendered — the display half of what `lib/agent/lint.ts` already
 * guarantees on the way out.
 *
 * Pass 0 of the lint rewrites Markdown into WhatsApp's markup: one asterisk for bold, no
 * headings, no link syntax. It has been doing that correctly for a while. The emulator then
 * printed the result as plain text, so a line the lint had *successfully* converted —
 * `*1. Your client's reminders.*` — showed up in the pane wearing its asterisks, and the one
 * question a reviewer actually has ("is this the shape a parent will see?") could not be
 * answered by looking at the thing built to answer it.
 *
 * §17's contract runs in one direction: the emulator may show LESS than production sends,
 * never more. That is why this is deliberately narrow.
 *
 *   - Body text only. Header, footer, button titles and list rows stay literal, because
 *     Meta does not apply formatting to those and drawing bold there would be the emulator
 *     showing more than the handset does — the exact failure this file exists to fix,
 *     pointed the other way.
 *   - No links. §14.6 is the rule that a link is a button; a url in the body is already
 *     flagged as a LIMIT violation by `limitViolations`, and auto-linking it here would
 *     quietly make the thing the product forbids look fine.
 *   - Unmatched markers render literally, as they do on a handset. A lone `*` is an
 *     asterisk, not the start of something.
 *
 * Nothing here touches the send path or the stored row. It is a reader for `message.body`.
 */

import { Fragment, type ReactNode } from 'react'

/* -------------------------------------------------------------------------- *
 * inline: *bold*  _italic_  ~strike~  `code`
 * -------------------------------------------------------------------------- */

const MARKERS = { '*': 'b', _: 'i', '~': 's', '`': 'code' } as const
type Marker = keyof typeof MARKERS

const isMarker = (c: string): c is Marker => Object.prototype.hasOwnProperty.call(MARKERS, c)

/**
 * Where the marker opened at `open` closes, or -1.
 *
 * Three rules, all of them WhatsApp's rather than Markdown's:
 *   1. no whitespace immediately inside either end — `* x*` is an asterisk and a word
 *   2. the pair lives on one line, so an unclosed `*` cannot swallow the rest of a message
 *      hunting for its partner
 *   3. the opener sits on a word boundary, so `3*4*5` is arithmetic and not a bold 4
 */
function findClose(src: string, open: number, ch: Marker): number {
  const before = open > 0 ? src[open - 1] : ''
  if (before && /[\p{L}\p{N}]/u.test(before)) return -1
  const after = src[open + 1]
  if (!after || /\s/.test(after)) return -1
  for (let j = open + 1; j < src.length; j++) {
    if (src[j] === '\n') return -1
    if (src[j] === ch && !/\s/.test(src[j - 1])) {
      // A closer immediately followed by a word character is mid-word too — the mirror of
      // rule 3, and without it `_a_b` would italicise.
      const next = src[j + 1]
      if (next && /[\p{L}\p{N}]/u.test(next)) continue
      return j
    }
  }
  return -1
}

function Wrap({ tag, children }: { tag: (typeof MARKERS)[Marker]; children: ReactNode }) {
  if (tag === 'b') return <strong className="font-semibold">{children}</strong>
  if (tag === 'i') return <em className="italic">{children}</em>
  if (tag === 's') return <s className="line-through opacity-80">{children}</s>
  return <code className="rounded bg-black/30 px-1 font-mono text-[12px]">{children}</code>
}

function renderInline(src: string): ReactNode[] {
  const out: ReactNode[] = []
  let buf = ''
  let key = 0
  for (let i = 0; i < src.length; ) {
    const ch = src[i]
    if (isMarker(ch)) {
      const close = findClose(src, i, ch)
      if (close > i + 1) {
        if (buf) {
          out.push(buf)
          buf = ''
        }
        const raw = src.slice(i + 1, close)
        // Inline code is literal all the way down — a backtick span is the one place a
        // stray asterisk must survive as an asterisk.
        out.push(
          <Wrap key={key++} tag={MARKERS[ch]}>
            {MARKERS[ch] === 'code' ? raw : renderInline(raw)}
          </Wrap>,
        )
        i = close + 1
        continue
      }
    }
    buf += ch
    i++
  }
  if (buf) out.push(buf)
  return out
}

/* -------------------------------------------------------------------------- *
 * block: ``` fences, > quotes, - bullets, 1. numbers
 * -------------------------------------------------------------------------- */

const FENCE = '```'
const BULLET = /^[ \t]*[-*][ \t]+(.*)$/
const NUMBER = /^[ \t]*(\d{1,3})[.)][ \t]+(.*)$/
const QUOTE = /^[ \t]*>[ \t]?(.*)$/

/** Whether this line opens a block, and therefore ends any run of prose before it. */
const startsBlock = (l: string): boolean =>
  QUOTE.test(l) || BULLET.test(l) || NUMBER.test(l) || l.trimStart().startsWith(FENCE)

/**
 * A bullet marker and an opening bold marker are the same character, and only the space
 * tells them apart — `* item` is a list, `*item*` is bold. The lint already collapses the
 * ambiguous case to `• ` on the way out; this handles what a person types into the composer,
 * which nothing rewrites.
 */
export function WaText({ text, className }: { text: string; className?: string }) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let key = 0

  for (let i = 0; i < lines.length; ) {
    const line = lines[i]

    // Fenced monospace. WhatsApp accepts it opened and closed on one line too.
    if (line.trimStart().startsWith(FENCE)) {
      const oneLine = line.trim()
      if (oneLine.length > 6 && oneLine.endsWith(FENCE)) {
        blocks.push(
          <pre key={key++} className="my-0.5 overflow-x-auto rounded bg-black/30 px-1.5 py-1 font-mono text-[12px]">
            {oneLine.slice(3, -3)}
          </pre>,
        )
        i++
        continue
      }
      let j = i + 1
      const body: string[] = []
      while (j < lines.length && !lines[j].trimStart().startsWith(FENCE)) body.push(lines[j++])
      // An unterminated fence is literal text, not a block that eats the message.
      if (j < lines.length) {
        blocks.push(
          <pre key={key++} className="my-0.5 overflow-x-auto rounded bg-black/30 px-1.5 py-1 font-mono text-[12px]">
            {body.join('\n')}
          </pre>,
        )
        i = j + 1
        continue
      }
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].match(QUOTE)![1])
      blocks.push(
        <blockquote key={key++} className="my-0.5 border-l-2 border-white/25 pl-2 opacity-90">
          {renderInline(body.join('\n'))}
        </blockquote>,
      )
      continue
    }

    if (BULLET.test(line)) {
      const items: string[] = []
      while (i < lines.length && BULLET.test(lines[i])) items.push(lines[i++].match(BULLET)![1])
      blocks.push(
        <ul key={key++} className="my-0.5 list-disc pl-4">
          {items.map((it, n) => (
            <li key={n}>{renderInline(it)}</li>
          ))}
        </ul>,
      )
      continue
    }

    if (NUMBER.test(line)) {
      const first = Number(lines[i].match(NUMBER)![1])
      const items: string[] = []
      while (i < lines.length && NUMBER.test(lines[i])) items.push(lines[i++].match(NUMBER)![2])
      blocks.push(
        <ol key={key++} start={first} className="my-0.5 list-decimal pl-5">
          {items.map((it, n) => (
            <li key={n}>{renderInline(it)}</li>
          ))}
        </ol>,
      )
      continue
    }

    // Everything else is prose. Runs of plain lines stay one block so `whitespace-pre-wrap`
    // keeps the author's own line breaks.
    //
    // The first line is taken unconditionally. An unterminated ``` reaches here having
    // matched the fence branch above without being consumed by it, so a loop that only
    // collected non-block lines would take nothing and `i` would never move — not a
    // rendering bug but a hung tab, since a message ending in a stray fence would spin
    // forever. Taking it first both breaks that and keeps it in the same block as the text
    // under it, so the line break between them survives.
    const prose: string[] = [lines[i++]]
    while (i < lines.length && !startsBlock(lines[i])) prose.push(lines[i++])
    blocks.push(<Fragment key={key++}>{renderInline(prose.join('\n'))}</Fragment>)
  }

  return <span className={className}>{blocks}</span>
}

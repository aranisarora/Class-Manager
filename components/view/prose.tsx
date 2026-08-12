/**
 * components/view/prose.tsx — synthesized commentary (§10.2, §15).
 *
 * The model authors markdown, never markup (§15). This renders that markdown
 * into React elements — there is no `dangerouslySetInnerHTML` anywhere in the
 * web surface, so a `<script>` in a model's string is text, not a tag, by
 * construction rather than by sanitiser.
 *
 * Supported: # ## ### headings, **bold**, *italic*, `code`, - bullets,
 * 1. numbered lists, > quotes, --- rules, blank-line paragraphs. Anything else
 * renders as the text it is.
 */

import type { ReactNode } from 'react'
import type { ResolvedComponent } from '@/lib/web/views'
import type { ComponentSpec } from '@/lib/web/registry'
import { Card } from '@/components/view/chrome'

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/g

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const parts = text.split(INLINE)
  parts.forEach((part, i) => {
    if (!part) return
    const key = `${keyBase}-${i}`
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      out.push(
        <strong key={key} className="font-semibold">
          {part.slice(2, -2)}
        </strong>,
      )
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      out.push(
        <code
          key={key}
          className="rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.85em] dark:bg-neutral-800"
        >
          {part.slice(1, -1)}
        </code>,
      )
    } else if (
      ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_'))) &&
      part.length > 2
    ) {
      out.push(<em key={key}>{part.slice(1, -1)}</em>)
    } else {
      out.push(<span key={key}>{part}</span>)
    }
  })
  return out
}

export function renderMarkdown(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let quote: string[] = []

  const flushParagraph = () => {
    if (!paragraph.length) return
    const key = `p-${blocks.length}`
    blocks.push(
      <p key={key} className="text-sm leading-relaxed">
        {inline(paragraph.join(' '), key)}
      </p>,
    )
    paragraph = []
  }
  const flushList = () => {
    if (!list || !list.items.length) return
    const key = `l-${blocks.length}`
    const items = list.items.map((it, i) => (
      <li key={`${key}-${i}`} className="text-sm leading-relaxed">
        {inline(it, `${key}-${i}`)}
      </li>
    ))
    blocks.push(
      list.ordered ? (
        <ol key={key} className="list-decimal space-y-1 pl-5 marker:text-neutral-400">
          {items}
        </ol>
      ) : (
        <ul key={key} className="list-disc space-y-1 pl-5 marker:text-neutral-400">
          {items}
        </ul>
      ),
    )
    list = null
  }
  const flushQuote = () => {
    if (!quote.length) return
    const key = `q-${blocks.length}`
    blocks.push(
      <blockquote
        key={key}
        className="border-l-2 border-neutral-300 pl-3 text-sm italic leading-relaxed text-neutral-600 dark:border-neutral-700 dark:text-neutral-300"
      >
        {inline(quote.join(' '), key)}
      </blockquote>,
    )
    quote = []
  }
  const flushAll = () => {
    flushParagraph()
    flushList()
    flushQuote()
  }

  for (const raw of lines) {
    const line = raw.trimEnd()

    if (!line.trim()) {
      flushAll()
      continue
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushAll()
      blocks.push(<hr key={`hr-${blocks.length}`} className="border-neutral-200 dark:border-neutral-800" />)
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      flushAll()
      const level = heading[1]!.length
      const text = heading[2]!
      const key = `h-${blocks.length}`
      const cls =
        level === 1
          ? 'text-base font-semibold tracking-tight'
          : level === 2
            ? 'text-sm font-semibold tracking-tight'
            : 'text-sm font-medium tracking-tight'
      blocks.push(
        level === 1 ? (
          <h2 key={key} className={cls}>
            {inline(text, key)}
          </h2>
        ) : level === 2 ? (
          <h3 key={key} className={cls}>
            {inline(text, key)}
          </h3>
        ) : (
          <h4 key={key} className={cls}>
            {inline(text, key)}
          </h4>
        ),
      )
      continue
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      flushParagraph()
      flushQuote()
      if (!list || list.ordered) {
        flushList()
        list = { ordered: false, items: [] }
      }
      list.items.push(bullet[1]!)
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered) {
      flushParagraph()
      flushQuote()
      if (!list || !list.ordered) {
        flushList()
        list = { ordered: true, items: [] }
      }
      list.items.push(ordered[1]!)
      continue
    }
    const quoted = /^>\s?(.*)$/.exec(line)
    if (quoted) {
      flushParagraph()
      flushList()
      quote.push(quoted[1]!)
      continue
    }
    flushList()
    flushQuote()
    paragraph.push(line.trim())
  }
  flushAll()
  return blocks
}

export function ProseView({ c }: { c: ResolvedComponent }) {
  const spec = c.spec as Extract<ComponentSpec, { type: 'prose' }>
  return (
    <Card note={c.note}>
      <div className="space-y-3">{renderMarkdown(spec.markdown)}</div>
    </Card>
  )
}

export default ProseView

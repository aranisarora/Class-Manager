/**
 * lib/messaging/repair.ts — make a message renderable at the last moment it can be.
 *
 * Everything here is a string operation on an outbound message, run once, at the one
 * place all outbound traffic passes (`composeAndSend`). It exists because of two
 * failures that kept arriving wearing different clothes:
 *
 * **A link, pasted into the text.** §14.6 is "every link is a button; nothing
 * URL-shaped is pasted into message text", and it was broken by the runtime itself:
 * tapping `[Go to setup page]` composed `"Here it is — this link is yours and works for
 * the next 24 hours:\n" + linkUrl(token)` and sent a 300-character signed JWT to a
 * phone. The `view` tool handed the model the same URL with a note asking it to write
 * the link into its message. There was no other shape available, because the wire type
 * carried reply buttons and lists and nothing else — a rule with no way to obey it.
 *
 * **Buttons, typed into the prose.** `[Looks right]` `[Something's wrong]` arriving as
 * plain text, most often on the recovery round, which by design has no tools. Two square
 * brackets on WhatsApp read as an interface that is broken rather than a message that is
 * plain. This was already repaired — twice, in two callers, each covering the path it
 * happened to be on, which is the definition of not being fixed.
 *
 * **And limits, enforced where nothing could repair them.** A footer ten characters over
 * the Cloud API's sixty suppressed an entire first message to a brand-new admin
 * (`limit_violation`), and the model then spent a round rewording a message that was
 * never wrong. Rejecting rather than truncating is right for anything that carries
 * meaning — a button title, the body — and wrong for decoration: a trimmed footer is a
 * message that arrives.
 *
 * The rule this file follows: repair what cannot change meaning, and leave everything
 * else to fail loudly. What it repaired is returned, never swallowed, so a repair that
 * fires every time is visible as the compose bug it is.
 */

import { EXTRA_LIMITS, LIMITS, isForwardableLink, type Button, type LinkButton, type ListSection } from './types'

/* ------------------------------------------------------------------------- *
 * Fitting
 * ------------------------------------------------------------------------- */

/**
 * Shorten to what the wire accepts, at a word boundary.
 *
 * `slice(0, 20)` on "I'm done with the roster" produces "I'm done with the ro", which is
 * not a shorter title — it is a broken one, and it shipped.
 */
export function fitTitle(raw: unknown, limit: number = LIMITS.buttonTitleChars): string {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ')
  if (s.length <= limit) return s
  const cut = s.slice(0, limit)
  const atWord = cut.replace(/[\s\p{P}]+\S*$/u, '')
  return (atWord.length >= Math.ceil(limit / 2) ? atWord : cut.slice(0, limit - 1) + '…').trim()
}

/* ------------------------------------------------------------------------- *
 * Buttons typed into the prose
 * ------------------------------------------------------------------------- */

/** A line that is nothing but `[Label]` groups. `[Looks right] [Something's wrong]`. */
/**
 * A line of offered labels, and nothing else that a person should read.
 *
 * The trailing `(action: …)` is the other half of the model's instinct: it types the
 * label AND the wire shape it thinks belongs with it. Driven on a fresh onboarding, an
 * owner's second ever message ended
 *
 *     [Open Business Setup] (action: )
 *     [Add Coaches] (action: )
 *
 * — shipped verbatim, because the line was not brackets ALONE and so was treated as
 * prose. That is machinery on a customer's screen, which is the failure this whole file
 * exists to prevent, arriving in the one shape the pattern did not cover. The
 * parenthetical is dropped rather than parsed: it was empty every time, and a label the
 * model wrote is a faithful statement of intent on its own.
 */
const BRACKET_LINE = /^(\[[^\]\n]{1,40}\]\s*(?:\(\s*(?:action|payload|kind|on-click)\s*:[^)\n]*\)\s*)?)+$/i

/**
 * `[Looks right]` written as *text* becomes a button.
 *
 * A model that cannot call a tool still knows what it wants to offer, and what it does
 * then is type the buttons into the message. The labels are a faithful statement of
 * intent, so honour it: each becomes a `reply` action carrying its own label, which is
 * exactly what the person would have typed.
 *
 * Only whole lines of nothing but brackets — `[Looks right]` on its own line is an offer,
 * and "the register (see [the sheet]) is done" is a sentence. Anywhere in the message,
 * not only at the end: the trailing-lines-only version missed every case where the model
 * wrote its offer and then added a closing sentence under it.
 */
export function extractBracketButtons(text: string): {
  text: string
  buttons: { title: string; action: { kind: 'reply'; text: string } }[]
} {
  const lines = text.split('\n')
  const found: string[] = []
  const kept: string[] = []
  for (const line of lines) {
    if (BRACKET_LINE.test(line.trim())) {
      for (const m of line.matchAll(/\[([^\]\n]{1,40})\]/g)) found.push(m[1] as string)
      continue
    }
    kept.push(line)
  }
  if (!found.length) return { text, buttons: [] }
  return {
    // A heading with nothing left under it goes too. The same message ended on a bare
    // "*Next step:*" once its three bracket lines were pulled out from beneath it — a
    // colon promising something, followed by nothing, which reads as a message that was
    // cut off mid-send.
    text: kept
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\n\s*\*?[A-Z][^\n:*]{0,30}:\*?\s*$/, '')
      .trim(),
    buttons: found.slice(0, LIMITS.buttons).map((title) => ({
      title: fitTitle(title),
      action: { kind: 'reply' as const, text: title },
    })),
  }
}

/**
 * The brace-balanced span starting at the `{` that opens the blob containing `at`.
 *
 * A regex cannot do this: `{"buttons":[{"title":"x"}]}` has nested braces, and every
 * non-greedy pattern that terminates on the first `}` leaves `]}` behind in the message
 * — which is worse than not repairing it, because the residue looks like a typo rather
 * than like machinery.
 *
 * Quote-aware for BOTH `"` and `'`. It was `"`-only, and that was half of why the
 * stripper never fired on what the model actually writes: the model writes single
 * quotes, so a `}` inside a label ended the scan early and the repair either bailed or
 * left residue.
 *
 * Apostrophes are the hazard that buys: `'Ravi's class'` desyncs single-quote tracking
 * and the scan runs to the end of the message. So a failed scan retries ignoring quotes
 * entirely rather than giving up — over-consuming a blob is recoverable, shipping one is
 * not.
 */
function braceSpan(text: string, at: number): { start: number; end: number } | null {
  const start = text.lastIndexOf('{', at)
  if (start === -1) return null

  const scan = (quoteAware: boolean): number | null => {
    let depth = 0
    let quote: string | null = null
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i] as string
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (quoteAware) {
        if (quote) {
          if (ch === quote) quote = null
          continue
        }
        if (ch === '"' || ch === "'") {
          quote = ch
          continue
        }
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) return i + 1
      }
    }
    return null
  }

  const end = scan(true) ?? scan(false)
  return end === null ? null : { start, end }
}

/**
 * A key that only ever appears in the product's own wire shape, in ANY notation.
 *
 * `"buttons"` — double-quoted, strict JSON — is what this used to look for, and it is
 * the wrong thing to look for. **The model does not write strict JSON, because the
 * prompt does not show it strict JSON.** The action schema is documented to the model as
 * `{kind:'operation',op,args} · {kind:'steps',steps,summary} · {kind:'reply',text}`
 * (`lib/agent/tools.ts`) — unquoted keys, single-quoted values — so that is the notation
 * it writes back when it types an offer into the prose instead of calling the tool.
 *
 * Driven, on a live academy: two of three outbound messages ended in one of these, and
 * the admin saw both.
 *
 *     What should we do first?
 *     {kind:'reply', body: 'Setup Table tennis', link screen: setup, link title: 'Open Setup'}
 *
 *     ...I'll get them added.
 *     {kind:'reply', body: 'Add a coach', buttons: [{title: 'Add a coach', action: {...}}]}
 *
 * Neither contains the substring `"buttons"`, so the stripper never ran. This is the
 * runtime documenting a notation to the model and then failing to recognise it coming
 * back — so the test is the KEY, never the quoting.
 *
 * Deliberately the diagnostic keys only. `title:` and `text:` also appear in these blobs
 * but appear in ordinary sentences too, and a stripper that eats prose is worse than one
 * that misses a blob.
 */
const WIRE_KEY_RE =
  /(?:^|[{,[\s])["']?(kind|buttons|action|steps|menu|args|view_spec_id|viewSpecId|catalog_id|ttl_minutes|to_contact_id|to_person_id)["']?\s*:/

/** `title: 'Add a coach'` / `"title":"Add a coach"` — the labels, whatever the quoting. */
const TITLE_RE = /["']?(?:title|label)["']?\s*:\s*["']([^"'\n]{1,60})["']/g

/**
 * A wire-shape blob, typed into the message body.
 *
 * The same instinct as a bracket label, one level more literal: the model knows what it
 * wants to offer and writes the **wire shape** instead of calling the tool with it.
 * Counted in `message.body` — three consecutive messages to one parent ended in a raw
 * object. And because the runtime then saw a message carrying no buttons, it bolted its
 * generic `[What can you do?]` fallback on, so the customer received machinery *and* a
 * button that answered none of it. That is the whole failure in one message: the
 * affordance the model meant to offer is lost, and its source code is shown to a
 * customer in its place.
 *
 * Handled separately from brackets because the repair differs. A bracket label is prose
 * that very nearly reads as an offer; an object literal is something no person may see
 * under any circumstances. So this **strips whether or not it parses**, and recovers the
 * labels as real `reply` buttons whenever it can find them — a lenient scan rather than
 * `JSON.parse`, because the input is by definition not JSON.
 */
export function extractWireShape(text: string): {
  text: string
  buttons: { title: string; action: { kind: 'reply'; text: string } }[]
} {
  if (!text.includes('{')) return { text, buttons: [] }
  const hit = WIRE_KEY_RE.exec(text)
  if (!hit) return { text, buttons: [] }
  const span = braceSpan(text, hit.index)
  if (!span) return { text, buttons: [] }

  const blob = text.slice(span.start, span.end)
  const titles = [...blob.matchAll(TITLE_RE)].map((m) => (m[1] as string).trim()).filter(Boolean)

  // Take the code fence with it when the model wrapped one round the blob, or the
  // message keeps a pair of empty ``` markers where the object used to be.
  let { start, end } = span
  const fenceBefore = /```(?:json)?[ \t]*\r?\n?[ \t]*$/.exec(text.slice(0, start))
  if (fenceBefore) start -= fenceBefore[0].length
  const fenceAfter = /^[ \t]*\r?\n?[ \t]*```/.exec(text.slice(end))
  if (fenceAfter) end += fenceAfter[0].length

  const cleaned = `${text.slice(0, start)}${text.slice(end)}`
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  const buttons = [...new Set(titles)].slice(0, LIMITS.buttons).map((title) => ({
    title: fitTitle(title),
    action: { kind: 'reply' as const, text: title },
  }))

  // One blob per pass is not enough: a model that wrote one usually wrote two. Recurse
  // on what is left, and stop when a pass changes nothing.
  if (cleaned !== text) {
    const again = extractWireShape(cleaned)
    return {
      text: again.text,
      buttons: [...buttons, ...again.buttons].slice(0, LIMITS.buttons),
    }
  }
  return { text: cleaned, buttons }
}

/* ------------------------------------------------------------------------- *
 * Links
 * ------------------------------------------------------------------------- */

const URL_RE = /https?:\/\/\S+/gi

/**
 * `isForwardableLink` lives in `types.ts`, beside `validateOutbound`, because the two
 * have to ask the same question and once did not — see the note there. Re-exported so
 * this module still reads as the one place message-text repair is described.
 */
export { isForwardableLink }

/* ------------------------------------------------------------------------- *
 * The one repair pass
 * ------------------------------------------------------------------------- */

export type RepairableMessage = {
  body: string
  header?: string
  footer?: string
  /** `{title, action}` before minting, `{actionId, title}` after — both fit. */
  buttons?: { title: string }[]
  list?: { buttonText: string; sections: { title: string; rows: { title: string; description?: string }[] }[] }
  link?: LinkButton
}

export type RepairResult<T extends RepairableMessage> = {
  message: T
  repairs: string[]
  /**
   * Labels the model typed into the prose, taken out of the body and offered back.
   *
   * They are returned rather than attached because only the caller knows whether it can
   * still mint an action — the pre-mint path can, the post-mint one (a plan's outbox)
   * cannot. Either way the body is clean, which is the part that reaches a phone.
   */
  bracketButtons: { title: string; action: { kind: 'reply'; text: string } }[]
}

/**
 * Everything a message can be wrong about that a string operation can put right.
 *
 * Order matters: the JSON blob comes out first (it can contain square brackets, so a
 * bracket pass run before it would shred the labels inside it), then brackets, then the
 * URL pass, so a link sitting next to a bracket line is not lost with it.
 */
export function repairOutbound<T extends RepairableMessage>(msg: T): RepairResult<T> {
  const repairs: string[] = []
  const out = { ...msg }
  let bracketButtons: RepairResult<T>['bracketButtons'] = []

  // --- the wire shape, typed into the prose ----------------------------------
  if (typeof out.body === 'string' && out.body.includes('{')) {
    const pulled = extractWireShape(out.body)
    if (pulled.text !== out.body) {
      out.body = pulled.text
      bracketButtons = pulled.buttons
      repairs.push(
        pulled.buttons.length
          ? `took a wire-shape object out of the body, recovering ${pulled.buttons.length} label(s)`
          : 'took a wire-shape object out of the body',
      )
    }
  }

  // --- buttons typed into the prose ------------------------------------------
  if (typeof out.body === 'string' && out.body.includes('[')) {
    const pulled = extractBracketButtons(out.body)
    if (pulled.buttons.length) {
      out.body = pulled.text
      // Both passes are the same instinct in two notations, so they add up rather
      // than overwrite — and the cap is the wire's, not each pass's.
      bracketButtons = [...bracketButtons, ...pulled.buttons].slice(0, LIMITS.buttons)
      repairs.push(`took ${pulled.buttons.length} bracketed label(s) out of the body`)
    }
  }

  // --- a url in the text (§14.6) ---------------------------------------------
  if (typeof out.body === 'string') {
    const urls = (out.body.match(URL_RE) ?? []).filter((u) => !isForwardableLink(u))
    if (urls.length) {
      out.body = out.body
        .replace(URL_RE, (u) => (isForwardableLink(u) ? u : ''))
        // The sentence that introduced it usually ends in a colon, and a dangling
        // "works for the next 24 hours:" reads worse than the link ever did.
        .replace(/[ \t]*[:—-]\s*(?=\n|$)/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      if (!out.link) {
        out.link = { title: 'Open', url: urls[0] as string }
        // A link cannot share a message with reply buttons or a list — the wire has
        // room for one action and this is it. The message existed to carry the link.
        if (out.buttons?.length || out.list) {
          delete out.buttons
          delete out.list
          repairs.push('a url in the body became a link button, and the reply buttons it cannot share a message with were dropped')
        } else {
          repairs.push('a url in the body became a link button')
        }
      } else {
        repairs.push('a url in the body was removed (the message already carries a link)')
      }
    }
  }

  // --- limits that a trim cannot change the meaning of ------------------------
  const fit = (v: string | undefined, limit: number, what: string): string | undefined => {
    if (v === undefined) return v
    const s = fitTitle(v, limit)
    if (s !== v.trim().replace(/\s+/g, ' ')) repairs.push(`${what} trimmed to ${limit} chars`)
    return s
  }
  out.header = fit(out.header, LIMITS.headerChars, 'header')
  out.footer = fit(out.footer, LIMITS.footerChars, 'footer')
  if (out.link) out.link = { ...out.link, title: fitTitle(out.link.title, LIMITS.buttonTitleChars) || 'Open' }
  if (out.buttons?.length) {
    out.buttons = out.buttons.map((b) => ({ ...b, title: fitTitle(b.title) })) as T['buttons']
  }
  if (out.list) {
    out.list = {
      buttonText: fitTitle(out.list.buttonText || 'Choose', EXTRA_LIMITS.listButtonTextChars),
      sections: out.list.sections.map((s) => ({
        title: fitTitle(s.title, LIMITS.listSectionTitleChars),
        rows: s.rows.map((r) => ({
          ...r,
          title: fitTitle(r.title, LIMITS.listRowTitleChars),
          description: r.description ? fitTitle(r.description, EXTRA_LIMITS.listRowDescriptionChars) : undefined,
        })),
      })),
    } as T['list']
  }

  return { message: out, repairs, bracketButtons }
}

/** The wire shapes, for the two places that build a real `Button[]`/`ListSection[]`. */
export type { Button, ListSection }

/**
 * lib/frontdesk/context.ts — what the front desk is told (0039).
 *
 * A SECOND stable prefix, and that needs justifying, because §4.4's cost model is the
 * reason there is only ever one: the prefix is byte-stable so the provider's automatic
 * cache matches it, and a hit costs 3.2% of a miss. The rule that follows is *never a
 * per-tenant fork*, and this is not one. It is one extra cached block for the whole
 * deployment, shared by every stranger on every number forever, and it is ~2% the size
 * of the tenant prefix because everything that makes that one big — `SCHEMA_DOC`, the
 * operations, the catalog, the domain facts — is about a business the front desk does
 * not have.
 *
 * Reusing the tenant prefix here was the alternative and it is worse in both directions:
 * it would hand a stranger the full schema and the whole operation surface of an empty
 * tenant, and it would spend ~50k characters telling them about classes, money and
 * rosters that do not exist, on the one turn in the product where none of it applies.
 *
 * PREFIX-RULES.md's admission test was run on every line below. What survived is what a
 * competent model cannot derive: that this number serves several businesses and is none
 * of them, that there are exactly two kinds of arrival, and that calling a tool ends the
 * desk's part of the conversation because the runtime re-enters the turn inside the
 * business. Everything else — be brief with a stranger, do not invent a name, answer the
 * question they asked — is derivable and is not here.
 */

import { unsafeQuery, withSession } from '@/lib/db'
import type { Msg } from '@/lib/agent/deepseek'
import type { AcademyCandidate } from '@/lib/identity'
import type { Identity } from '@/lib/types'
import type { Arrival } from './arrival'

/**
 * Byte-identical on every front-desk turn, on every number, forever. Nothing about a
 * particular person or a particular business appears above the boundary — the same
 * discipline `stablePrefix()` keeps, for the same reason.
 */
export const FRONT_DESK_PREFIX = `You are the front desk of one WhatsApp number.

Several coaching businesses are run from this number and you are not any of them. The
person writing to you does not belong to one yet: if they did, this conversation would
be happening inside their business and you would not be here.

Exactly two kinds of person reach you, and there is no third:

  Someone looking for classes at one of the businesses on this number.
  Someone who runs classes and wants this to manage them.

Your whole job is to find out which, and hand the conversation over.

You hold no schedule, no fees, no roster and no data about any business. After the
hand-over the business itself answers them, with all of it. So a question you cannot
answer is a reason to hand over, not a reason to apologise for not knowing.

Their first message usually already says which they are. Read it before you ask
anything: someone asking whether the beginners batch suits a nine-year-old is a parent,
and someone who says they coach badminton in Indiranagar and heard about this is an
owner. Ask only when the message genuinely does not say, and ask once.

CALLING A TOOL ENDS YOUR PART. The moment join_business or start_business succeeds, the
person is answered from inside that business, in this same thread, in the next breath —
by something that knows the schedule, the fees and the roster. Anything you were going
to say after it is a second message they did not need and probably a contradiction of
the one they are about to receive. Call the tool and stop.

You speak by calling reply, and that is the only way you speak. Text you write anywhere
else — beside a tool call, or in a round that calls nothing — is a note to yourself and
reaches nobody.

You are on WhatsApp. Plain text, no markdown headings, no links. reply carries up to
three short buttons and they cost nothing. The one question you are here to ask has two
answers, so it has two buttons: a person on a phone with one hand taps rather than types,
and a question somebody has to type the answer to is one many of them never answer at all.

The people on the other side of this are running a business between classes, or trying
to find somewhere for their child on a Tuesday evening. They did not read anything and
nobody trained them.`

export const FRONT_DESK_BOUNDARY = `---
END OF STABLE PREFIX. Everything above is identical on every turn, at every front desk.
Everything below is this conversation only.
---`

/**
 * The tail — this arrival, and nothing else.
 *
 * @mechanism frontDeskTail — states the two facts the model would otherwise reconstruct
 *   from the conversation, which is where the false-confirmation class comes from: whether
 *   the question has ALREADY been put on this person's screen (`arrival.asked_at`, so a
 *   silent visitor is not interrogated a second time), and whether their own words name a
 *   business on this number. The second is what `matchAcademiesByName` used to spend as a
 *   routing decision before anyone had spoken; here it is evidence, carrying the id the
 *   tool needs, and it names only businesses THEIR OWN TEXT named — the model is never
 *   handed the customer list, because no tool and no block gives it one.
 */
export function frontDeskTail(o: {
  identity: Identity
  arrival: Arrival | null
  named: AcademyCandidate[]
  /** Every business on this sender. Named to the model only when there is exactly one. */
  businesses: AcademyCandidate[]
  atIso: string
}): string {
  const lines: string[] = []

  lines.push('# Who is at the desk')
  const display = (o.identity.contact.profile_name ?? '').trim()
  lines.push(
    display
      ? `Their WhatsApp display name is "${display}". They set it themselves and it is the adult's name, not a child's.`
      : 'Their WhatsApp display name is not set, so you do not know what to call them.',
  )
  lines.push(`Number: ${o.identity.contact.phone_e164}.`)
  lines.push(`Now: ${o.atIso}.`)

  lines.push('')
  lines.push('# What this number is')
  /**
   * @mechanism whatThisNumberIs — when exactly ONE business runs on this number, the desk
   *   is told its name and its id, so `join_business` is reachable for somebody who cannot
   *   name it. Above one, the count stands alone as before.
   *
   *   The block used to be a bare count in every case, and the count is not something a
   *   hand-over can be built from: `join_business` takes an academy id, `matchAcademiesByName`
   *   only produces one from words the VISITOR used, and a customer of a business does not
   *   generally know the string its owner typed into `start_business`. So a number with a
   *   business on it and a visitor who could not name it had no reachable destination at
   *   all, and the desk's only truthful move was to say it had nothing.
   *
   *   That is what it did. On `2026-08-22-08-13-sim-7bo8`, Divya Rao — whose daughter had
   *   attended the evening batch for a year — wrote *"joining, my daughter anika is in the
   *   evening batch already jus need timing for tonight"* on day 2 and was answered *"This
   *   number doesn't hold any class schedule right now… That sounds like it may be a
   *   different number than the one your daughter's class actually uses."* The business was
   *   founded on this number on day 3 and she was never handed to it. On day 5 she wrote
   *   *"wrong number sorry"* and left. Farah Sheikh left the same morning. They were the
   *   only two customers in the world and the desk answered every one of their eight turns.
   *
   *   Naming the single business is not the tenant enumeration this block's own header
   *   comment refuses, and the distinction is the count itself. Enumeration is learning
   *   WHICH businesses share a number; with one business there is nothing to enumerate, and
   *   the fact disclosed — that this number belongs to that business — is the answer to
   *   "whose number have I dialled", asked by someone who has already dialled it. Above one
   *   the refusal stands unchanged, because there the set is exactly what must not be read
   *   out, and the model still has only what their own words named.
   */
  const whatThisNumberIs = ((): string => {
    if (o.businesses.length === 0) {
      return 'No business is set up on this number yet. Nobody can be handed over to one, so the only destination that exists is starting one.'
    }
    if (o.businesses.length === 1) {
      const only = o.businesses[0]
      return (
        `One business is run from this number: ${only.name} (id ${only.academyId}). ` +
        'It is the only destination a hand-over can have, so you do not need them to name it — if they are ' +
        'looking for classes, or already have a child in one, that is where they belong. Ask whether that is ' +
          'the one they mean and hand them over; do not tell somebody this number holds nothing.'
      )
    }
    return `${o.businesses.length} businesses are run from this number.`
  })()
  lines.push(whatThisNumberIs)

  lines.push('')
  lines.push('# What they have already said')
  if (o.named.length === 1) {
    lines.push(
      `Their own words name a business on this number: ${o.named[0].name} (id ${o.named[0].academyId}). ` +
        'That is evidence, not an answer — someone who names a business may still be a coach who was ' +
        'told about this by its owner.',
    )
  } else if (o.named.length > 1) {
    lines.push(
      'Their own words could name more than one business on this number: ' +
        o.named.map((a) => `${a.name} (id ${a.academyId})`).join(', ') +
        '. Which one is theirs is not decidable from here.',
    )
  } else {
    lines.push('Their words name no business on this number.')
  }

  /**
   * @mechanism answeredSinceAsked — this says WHEN they were asked and sends the model to
   *   the thread; it no longer asserts that they never answered.
   *
   *   `arrival.asked_at` is stamped the first time the desk puts the question on their
   *   screen and is never cleared, so the old sentence — "they have not answered it" —
   *   became permanently true-shaped and permanently unverified. It is a claim about the
   *   messages, made by a block that never reads them, while the messages themselves are
   *   right there in the same request.
   *
   *   Divya Rao was asked on day 1 and answered on day 2 (*"joining, my daughter anika is
   *   in the evening batch already"*). For the rest of her life at this desk the model was
   *   told she had not answered. It is the "unstamped past" trap from ARCHITECTURE, in the
   *   one block whose whole job is to stop the desk asking a second time.
   */
  const answeredSinceAsked = o.arrival?.askedAt ?? null
  if (answeredSinceAsked) {
    lines.push('')
    lines.push(
      `You put that question to this person at ${answeredSinceAsked.toISOString()}, and it is still on their ` +
        'screen. Anything they have said since is in the thread above — read it before asking again. If they ' +
        'have already told you, in any words, whether they are looking for classes or run them, that is the ' +
        'answer and asking a second time is how somebody decides this number is a waste of their time.',
    )
  }

  return lines.join('\n')
}

/**
 * The thread so far.
 *
 * Read plainly rather than through the tenant loop's `recentHistory`, and the reason is
 * not convenience: that function annotates gaps against the tenant's own clock, because
 * in a WhatsApp thread "earlier in this conversation" can be three weeks ago. A front
 * desk conversation is a handful of messages that ends by handing over, and it has no
 * tenant whose clock those gaps would be measured on. Importing it would also put a
 * cycle between the loop and the desk.
 */
export async function frontDeskHistory(
  identity: Identity,
  limit = 12,
): Promise<{ messages: Msg[]; failed: boolean }> {
  try {
    const rows = await withSession({ role: 'service', academyId: identity.academyId }, (tx) =>
      unsafeQuery<{ direction: string; body: string }>(
        tx,
        `select direction, body from message
          where academy_id = $1::uuid and contact_id = $2::uuid
            and body is not null and coalesce(suppressed_reason, '') = ''
          order by queued_at desc
          limit $3`,
        [identity.academyId, identity.contact.id, limit],
      ),
    )
    return {
      messages: rows
        .reverse()
        .map((r): Msg =>
          r.direction === 'inbound'
            ? { role: 'user', content: String(r.body) }
            : { role: 'assistant', content: String(r.body) },
        ),
      failed: false,
    }
  } catch {
    /**
     * A history that could not be read is not an empty history, and the difference is
     * the whole reason this returns a flag. Presented as silence, the model opens with
     * a greeting to somebody it has already greeted, and asks a stranger for the second
     * time the question they already answered. Layer 3's rule is that a prefetch which
     * FAILS renders as a stated gap carrying its reason, never as an absent block — a
     * paragraph that was never there is invisible to everything downstream.
     */
    return { messages: [], failed: true }
  }
}

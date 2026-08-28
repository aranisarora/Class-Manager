/**
 * lib/frontdesk/context.ts — what the front desk is told (0039).
 *
 * The desk TAIL. Since the one-brain merge (23 Aug 2026) a desk turn runs the
 * ordinary loop under the ONE stable prefix — the desk's standing facts are a
 * byte-stable section of it (`lib/agent/context.ts`) — and this file's whole job
 * is the variable tail about one arrival, rendered by `variableTail`'s desk
 * branch through `frontDeskTail` below. The second prefix this header used to
 * argue for is gone: it passed the cost test (byte-identical, ~2% the size,
 * cheaper either way) and failed on the SEAM — two brains meant information died
 * crossing between them (F-EO, F-EQ, F-CV), which no cost test priced.
 * ARCHITECTURE.md's "one legitimate second prefix" trap is the full story, and
 * the two-brain arm remains reachable at commit 791a3f2.
 *
 * PREFIX-RULES.md's admission test was run on every line below. What survived is
 * what a competent model cannot derive: whether the question was already put to
 * this person, what this number is, and which businesses their own words name.
 * Everything else — be brief with a stranger, do not invent a name, answer the
 * question they asked — is derivable and is not here.
 */

import type { AcademyCandidate } from '@/lib/identity'
import type { Identity } from '@/lib/types'
import type { Arrival } from './arrival'

/**
 * Byte-identical on every front-desk turn, on every number, forever. Nothing about a
 * particular person or a particular business appears above the boundary — the same
 * discipline `stablePrefix()` keeps, for the same reason.
 */
/*
 * FRONT_DESK_PREFIX and FRONT_DESK_BOUNDARY lived here until the one-brain merge: the
 * desk was a second stable prefix over a second loop. A desk turn now runs the one
 * brain in a mode — the desk's standing facts are a section of the ONE stable prefix
 * (lib/agent/context.ts), and this file's job is the tail about one arrival, rendered
 * by `variableTail`'s desk branch through `frontDeskTail` below.
 */

/**
 * The tail — this arrival, and nothing else.
 *
 * @mechanism frontDeskTail — states the two facts the model would otherwise reconstruct
 *   from the conversation, which is where the false-confirmation class comes from: whether
 *   the question has ALREADY been put on this person's screen (`arrival.asked_at`, so a
 *   silent arrival is not interrogated a second time), and whether their own words name a
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
   *   business on it and an arrival who could not name it had no reachable destination at
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
   * @mechanism answeredSinceAsked — this says WHEN the desk last spoke and sends the model
   *   to the thread; it asserts nothing about what was asked or answered.
   *
   *   `arrival.asked_at` is stamped by EVERY landed desk send (`markArrivalAsked`), not
   *   only by ones that asked the routing question — a desk whose first message answered
   *   "is this free?" is stamped too. The block therefore stopped claiming "that question
   *   is still on their screen": that was a claim about the messages, made by a block
   *   that never reads them, while the messages themselves are right there in the same
   *   request. Two earlier wordings each asserted one half too much — "they have not
   *   answered" (Divya Rao answered on day 2 and was described as silent forever), then
   *   "you put that question to them" (sometimes no question had been put at all, which
   *   fed F-DP from the other side). What is left is the stamp's own truth: the desk has
   *   spoken before, and the thread is the record of what about.
   */
  const answeredSinceAsked = o.arrival?.askedAt ?? null
  if (answeredSinceAsked) {
    lines.push('')
    lines.push(
      `The desk has already spoken to this person — last at ${answeredSinceAsked.toISOString()}. What was ` +
        'said, in both directions, is in the thread above — read it before asking anything. If they have ' +
        'already told you, in any words, whether they are looking for classes or run them, that is the ' +
        'answer and asking again is how somebody decides this number is a waste of their time.',
    )
  }

  return lines.join('\n')
}

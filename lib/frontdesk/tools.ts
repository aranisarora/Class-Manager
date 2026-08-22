/**
 * lib/frontdesk/tools.ts — four declarations, and nothing else reachable (0039).
 *
 * The tenant surface is `read` (any SELECT under this person's RLS), `plan` (any
 * transaction), and every operation in the registry. None of that is offered here, and
 * the reason is not that a stranger might misuse it — RLS would refuse them anyway, and
 * a front desk owns no class, no player and no money to refuse them from. It is that
 * every one of those declarations is *about* a business, and the person at the desk does
 * not have one. A schema block and twenty operation signatures describing rosters and
 * tally lines, shown to somebody asking whether you do Saturday mornings, is tens of
 * thousands of characters of the wrong context on the one turn where none of it applies.
 *
 * PREFIX-RULES.md's placement ladder is why the guards are here rather than in prose.
 * Rung 1: *a hard constraint on a tool call goes in the tool declaration*. So:
 *
 *   - `find_business` takes a NAME. There is no "list the businesses" verb, at any
 *     privilege, so the model cannot recite this number's customer list to a stranger
 *     — not because it is told not to, but because it never holds one. It also refuses
 *     a query made only of the words that name the category rather than a business,
 *     which is the same `GENERIC_WORDS` guard that stops "is this the academy?" routing
 *     to whichever tenant sorted first.
 *   - `join_business` takes an id, never a name. A name would have to be re-matched at
 *     the point of writing, by a second copy of the matcher, which is how the tool and
 *     the router come to disagree about who "Ace" is.
 *   - `start_business` requires a name. There is nothing in the declaration, the prefix
 *     or the tail to invent one from, so a business cannot be founded until the person
 *     has said what theirs is called.
 */

import { z } from 'zod'

import { parametersFor } from '@/lib/agent/schema-json'
import type { ToolDecl } from '@/lib/agent/deepseek'
import { LIMITS } from '@/lib/messaging/types'
import { matchAcademiesByName } from '@/lib/identity'
import type { Identity } from '@/lib/types'
import type { Arrival } from './arrival'
import { businessesOnThisNumber, foundBusiness, isRefusal, joinBusiness, stopMessagingVisitor } from './route'
import type { Handover } from './route'

/** At most this many names come back from one lookup. A directory is not an answer. */
const MAX_MATCHES = 3

const FindBusiness = z.object({
  name: z.string().min(2).describe('the business name as the person said it, in their words'),
})

const JoinBusiness = z.object({
  academy_id: z.string().uuid().describe('the id find_business returned for the business they mean'),
  /**
   * Not a role and it grants nothing — what they SAID, kept so the business does not have
   * to ask a question its own front desk already asked. The desk decides this to route at
   * all, so nothing new is being inferred out of it.
   */
  as: z
    .enum(['parent', 'coach', 'owner', 'unsure'])
    .nullish()
    .describe(
      'which they told you they were — parent, coach, owner, or unsure if their words did not say. ' +
        'It is carried into the business so it does not have to ask you again.',
    ),
})

const StartBusiness = z.object({
  name: z.string().min(2).describe('what THEY said their business is called — never one you chose for them'),
  category: z
    .string()
    .nullish()
    .describe("what they teach, in their words: 'badminton', 'carnatic vocal'. Omit if they have not said."),
  owner_name: z
    .string()
    .nullish()
    .describe('their name, if they gave one. Omit and their WhatsApp display name is used.'),
})

const StopMessaging = z.object({})

/**
 * `reply` is declared here and dispatched in `turn.ts`, because it is the only verb
 * that needs a session to send on and threading one into the router would make the
 * router a sender. Its shape is the tenant `reply`'s, minus everything a front desk
 * has no business owning: no third-party recipient (there is nobody else here), no
 * list, no link, no form, no template. A button carries the words its tap replays,
 * which is the existing button contract — `executeAction` re-enters a `reply` payload
 * "as if it had been typed" — so the one question this desk asks gets the one
 * affordance a person on a phone with one hand can actually use.
 */
export const ReplyArgs = z.object({
  body: z.string().min(1).max(LIMITS.bodyChars),
  buttons: z
    .array(
      z.object({
        title: z.string().min(1).max(LIMITS.buttonTitleChars),
        answer: z.string().min(1).describe('what tapping it says, in their voice — it replays as if typed'),
      }),
    )
    .max(LIMITS.buttons)
    .nullish(),
})

export function frontDeskToolDecls(): ToolDecl[] {
  return [
    {
      name: 'reply',
      description:
        `Say something to the person at the desk, with up to ${LIMITS.buttons} buttons of at most ` +
        `${LIMITS.buttonTitleChars} characters each. Use this rather than plain prose whenever a tap ` +
        'would save them typing — which is almost always for the one question you are here to ask. ' +
        'A message with no buttons makes a person on a phone type their answer, and many will not.',
      parametersJsonSchema: parametersFor(ReplyArgs),
    },
    {
      name: 'find_business',
      description:
        'Look up a business on this number by the name the person used. Returns the id you need to hand ' +
        'them over, or tells you nothing matched. There is no way to list the businesses on this number ' +
        'and you should not imply to the person that you can browse them.',
      parametersJsonSchema: parametersFor(FindBusiness),
    },
    {
      name: 'join_business',
      description:
        'This person is looking for classes at this business. Hands the conversation over: they get a ' +
        'contact there (or the one they already had, if they turn out to be known), and the business ' +
        'itself answers them next, in this same thread, knowing its schedule and its fees. ' +
        'ENDS YOUR PART — say nothing after it.',
      parametersJsonSchema: parametersFor(JoinBusiness),
    },
    {
      name: 'start_business',
      description:
        'This person runs classes and wants this to manage them. Creates their business with them as its ' +
        'admin, and hands the conversation over so it can start setting itself up with them — it will ask ' +
        'for the timetable, the venues and the rest. Nothing is sent to anybody else, and nothing they ' +
        'tell it now is final; every value can be changed by saying so. ' +
        'ENDS YOUR PART — say nothing after it.',
      parametersJsonSchema: parametersFor(StartBusiness),
    },
    {
      name: 'stop_messaging',
      description:
        'They asked to be left alone. Nothing further will reach this number from here. Use it when they ' +
        'say so, not when they simply go quiet.',
      parametersJsonSchema: parametersFor(StopMessaging),
    },
  ]
}

export type FrontDeskToolResult = {
  /** What goes back to the model as the `tool` message. */
  content: string
  /** Set when this call ended the desk's part of the conversation. */
  handover?: Handover
  /** Set when the visitor asked to be left alone and it was recorded. */
  stopped?: boolean
}

/**
 * @mechanism runFrontDeskTool — the four verbs, and every one of them answers in words the
 *   model can act on rather than in a status. Layer 2's rule is that results tell the truth:
 *   a refusal here says what to do next ("ask what theirs is called", "that id is not on this
 *   number"), because the record is that every honest refusal was repaired in-turn and every
 *   opaque one became a false sentence to a person. A successful hand-over says *say nothing
 *   further here*, because the runtime is about to answer them from inside the business and
 *   two answers to one message is the failure that shape can produce.
 */
export async function runFrontDeskTool(
  identity: Identity,
  arrival: Arrival | null,
  name: string,
  args: Record<string, unknown>,
  /** What they said this turn. Carried into the business so its thread is not one-sided. */
  openingText?: string,
): Promise<FrontDeskToolResult> {
  switch (name) {
    case 'find_business': {
      const parsed = FindBusiness.safeParse(args)
      if (!parsed.success) {
        return { content: 'find_business needs the business name as the person said it.' }
      }
      const all = await businessesOnThisNumber(identity)
      if (all.length === 0) {
        return {
          content:
            'No business is set up on this number at all yet. Nobody can be handed over to one — the only ' +
            'thing that exists here is starting one.',
        }
      }

      const hits = matchAcademiesByName(parsed.data.name, all)
      if (hits.length === 0) {
        return {
          content:
            `Nothing on this number matches "${parsed.data.name}". Either they have the wrong number, or they ` +
            'said the name loosely — ask how it is written. Words like "academy", "club" or "classes" name ' +
            'the category rather than a business and never match on their own.',
        }
      }

      const shown = hits.slice(0, MAX_MATCHES)
      const lines = shown.map((a) => `${a.name} — id ${a.academyId}`)
      return {
        content:
          hits.length > MAX_MATCHES
            ? `${hits.length} businesses on this number match that loosely. The closest ${MAX_MATCHES}:\n${lines.join('\n')}\nAsk which, rather than guessing.`
            : `${lines.join('\n')}`,
      }
    }

    case 'join_business': {
      const parsed = JoinBusiness.safeParse(args)
      if (!parsed.success) {
        return { content: 'join_business needs the id find_business returned, not a name.' }
      }
      const routed = await joinBusiness(identity, arrival, parsed.data.academy_id, openingText, parsed.data.as ?? undefined)
      if (isRefusal(routed)) return { content: routed.refused }
      return { content: routed.note, handover: routed }
    }

    case 'start_business': {
      const parsed = StartBusiness.safeParse(args)
      if (!parsed.success) {
        return {
          content:
            'start_business needs the name they gave for their business. Ask what it is called; do not ' +
            'choose one for them.',
        }
      }
      const routed = await foundBusiness(identity, arrival, {
        name: parsed.data.name,
        category: parsed.data.category,
        founderName: parsed.data.owner_name,
        openingText,
      })
      if (isRefusal(routed)) return { content: routed.refused }
      return { content: routed.note, handover: routed }
    }

    case 'stop_messaging': {
      const done = await stopMessagingVisitor(identity, arrival)
      return { content: done.note, stopped: true }
    }

    default:
      return {
        content:
          `There is no tool called "${name}" at a front desk. What exists here is find_business, ` +
          'join_business, start_business and stop_messaging. Everything else belongs to a business, and ' +
          'this person is not in one yet.',
      }
  }
}

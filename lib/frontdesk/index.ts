/**
 * lib/frontdesk/ — the arrivals hall of one WhatsApp number (0039, reshaped 0052).
 *
 * A person who has not said whether they want classes or run them does not belong to
 * a business. They belong to the number, and this is where that conversation happens:
 * one question, asked only when their own words have not already answered it, and then
 * a hand-over into a business — an existing one they join, or a new one they found.
 *
 * WHAT IS HERE, AND IN WHICH ORDER IT RUNS
 *
 *   arrival.ts   the funnel row. Opened by `resolveInbound` the moment somebody
 *                arrives, settled when they go somewhere — so a stranger who wrote
 *                once and never answered is a row rather than an absence.
 *   context.ts   the desk tail about this one arrival — rendered by the ONE brain's
 *                `variableTail` since the one-brain merge; the second stable prefix
 *                died with the second brain.
 *   tools.ts     the four desk verbs' implementations: find_business, join_business,
 *                start_business, stop_messaging. Declared inside the one tool block
 *                (lib/agent/tools.ts), gated to desk turns at the dispatcher. There
 *                is no "list the businesses" verb at any privilege, so the desk cannot
 *                recite a customer list to a stranger.
 *   route.ts     the two destinations and the one refusal — the writes themselves.
 *   (turn.ts     was the second brain's rounds; deleted in the one-brain merge — a
 *                desk turn runs lib/agent/loop.ts like every other.)
 *
 * WHAT IS DELIBERATELY NOT HERE: a sender, a turn recorder, a message table, an action
 * table, a second RLS story. The front desk is a `tenant` row — `kind = 'front_desk'`,
 * with NO `academy` row beside it (0052) — so a desk arrival gets a person, a contact,
 * a transcript, buttons, a turn row and the one send path with no parallel machinery at
 * all, and a business fact physically cannot land on it. 0039 argued the original trade
 * in full; 0052's header argues why the business half moved out.
 */

export { openArrival, arrivalForContact, markArrivalAsked, settleArrival, foundedByRecently } from './arrival'
export type { Arrival, ArrivalOutcome } from './arrival'
export { frontDeskTail } from './context'
export { businessesOnThisNumber, joinBusiness, foundBusiness, stopMessagingAtDesk, MAX_BUSINESSES_PER_NUMBER_24H } from './route'
export type { Handover, RouteResult } from './route'
export { runFrontDeskTool } from './tools'

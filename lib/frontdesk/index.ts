/**
 * lib/frontdesk/ — the arrivals hall of one WhatsApp number (0039).
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
 *   context.ts   the second stable prefix, and the tail about this one arrival.
 *   tools.ts     five verbs: reply, find_business, join_business, start_business,
 *                stop_messaging. There is no "list the businesses" verb at any
 *                privilege, so the desk cannot recite a customer list to a stranger.
 *   route.ts     the two destinations and the one refusal — the writes themselves.
 *   turn.ts      the rounds. Returns to `runTurn`, which records the turn and performs
 *                the hand-over.
 *
 * WHAT IS DELIBERATELY NOT HERE: a sender, a turn recorder, a message table, an action
 * table, a second RLS story. The front desk is an `academy` row (0039), so a visitor
 * gets a person, a contact, a transcript, buttons, a turn row and the one send path
 * with no parallel machinery at all. The migration's header argues that trade in full.
 */

export { openArrival, arrivalForContact, markArrivalAsked, settleArrival, foundedByRecently } from './arrival'
export type { Arrival, ArrivalOutcome } from './arrival'
export { FRONT_DESK_PREFIX, FRONT_DESK_BOUNDARY, frontDeskTail, frontDeskHistory } from './context'
export { businessesOnThisNumber, joinBusiness, foundBusiness, stopMessagingVisitor, MAX_BUSINESSES_PER_NUMBER_24H } from './route'
export type { Handover, RouteResult } from './route'
export { frontDeskToolDecls, runFrontDeskTool } from './tools'
export { runFrontDeskTurn } from './turn'
export type { FrontDeskRun } from './turn'

/**
 * §17 — goals. What the persona is trying to get done, and what "done" means concretely enough
 * that a judge can rule on it from the transcript alone.
 *
 * The spec names three: "get your kid moved to Saturday", "dispute a charge", "cancel and rebook
 * twice". The rest exist because the goals that exercise the clock, the money boundary and the
 * escape hatch are where this product breaks.
 */

/** The contract type (CONTRACTS §10). Nothing may be added to it. */
export type SimGoal = {
  text: string
  successCriteria: string[]
}

/** Internal shape: `SimGoal` plus knobs `run.ts` uses. A superset, so `GOALS` still types as `SimGoal[]`. */
export type SimGoalDef = SimGoal & {
  slug: string
  /** Who this goal makes sense for. Advisory — the UI pairs personas and goals with it. */
  fits: ('admin' | 'coach' | 'account_holder' | 'player' | 'prospect')[]
  /** True when reaching the goal requires time to pass (a reminder, a nudge, a digest). */
  needsClock: boolean
  /** Hard cap on model turns for this goal. */
  maxTurns: number
  /** Verbatim first message, when the scenario fixes it (a QR deep link, a prefilled send). */
  opener?: string
  /** Prose handed to the persona model as its private motivation. */
  motivation: string
}

export const GOAL_DEFS: SimGoalDef[] = [
  {
    slug: 'move-to-saturday',
    text: 'Get your kid moved to Saturday',
    motivation:
      "Your child is in a weekday batch and it clashes with tuition now. You want them in the Saturday " +
      'batch instead, starting as soon as possible, and you want to know it is actually done — not "I will ' +
      'look into it".',
    successCriteria: [
      'The enrollment is actually changed to a Saturday slot, not merely discussed',
      'The bot states which sessions changed and from which date, in the academy timezone and idiom',
      'The parent is told what happens to sessions already booked in the old slot',
      'A confirmation is shown before the write, and the write is only made after the parent agrees',
      'No uuid, table name or raw ISO timestamp appears in any message (§4.5)',
    ],
    fits: ['account_holder'],
    needsClock: false,
    maxTurns: 10,
  },
  {
    slug: 'dispute-charge',
    text: 'Dispute a charge',
    motivation:
      'This month\'s total is higher than you expected. You believe you are being charged for a session ' +
      'the academy itself cancelled. You want the specific line removed or explained — a total is not an ' +
      'answer, and "let me check with the admin" without a follow-up is a dead end.',
    successCriteria: [
      'The bot shows the disputed line itself — date, amount, reason — not just a total',
      'Every number the bot states is one it actually read, not one it inferred',
      'Either the charge is waived/adjusted with a visible effect, or it is escalated to the admin with the reason attached',
      'The parent is never told the dispute is "resolved" when only a message has been queued (§2.4)',
      'The bot does not promise a refund it cannot make',
    ],
    fits: ['account_holder'],
    needsClock: false,
    maxTurns: 12,
  },
  {
    slug: 'cancel-rebook-twice',
    text: 'Cancel and rebook twice',
    motivation:
      'Your plans keep changing. Cancel the next session, rebook it, then cancel again and rebook into a ' +
      'different slot. You want the credit and the record to survive all of it.',
    successCriteria: [
      'Both cancellations and both rebookings land, in order, with no lost or duplicated session',
      'Each cancellation is classified against the cancellation window and the parent is told which side it fell on',
      'The tally effect of each reversal is stated consistently — the second answer does not contradict the first',
      'The bot does not repeat the same clarifying question after it has already been answered',
      'The coach or roster consequence of the final state is mentioned once, not four times',
    ],
    fits: ['account_holder'],
    needsClock: false,
    maxTurns: 14,
  },
  {
    slug: 'book-trial-cold',
    text: 'Find out whether the beginners class suits a 14-year-old with three years of play, then book a trial',
    motivation:
      'You scanned a QR code outside the court. You have one real question first and you will not book ' +
      'until it is answered like a person would answer it. If it is answered well, you want a trial this ' +
      'week and you want to know the day, time and place.',
    opener:
      'Hi, I saw your board outside. My daughter is 14 and has played for three years — is your beginners ' +
      'class right for her?',
    successCriteria: [
      "The question is answered on its merits — the level, not a brochure — before anything is sold",
      'The academy is named in the first reply (§16 — the parent messaged "Class Manager", not the academy)',
      'A trial is booked with a specific day, time and venue, or a clear reason it cannot be',
      'The prospect is not asked for information the academy already has or does not need',
      'No pricing claim is made that was not read from the academy\'s own rates',
    ],
    fits: ['prospect'],
    needsClock: false,
    maxTurns: 12,
  },
  {
    slug: 'coach-drops-session',
    text: 'Drop your next session at short notice and make sure the families are told',
    motivation:
      'You cannot take your next session. You are telling the bot, not asking it. You want cover found or ' +
      'the families told — you are not going to do either yourself, and you are not going to answer a long ' +
      'list of questions about it.',
    successCriteria: [
      'The session is actually cancelled or reassigned, not just acknowledged',
      'The affected families are told, and the bot says exactly who was told and when it goes out',
      'Cover is offered to other coaches, or — where the academy has one coach — the drop becomes a reschedule (§18)',
      'The coach is not asked to confirm anything to himself (§18 rule 1)',
      'Nothing claims the families have received the message when it has only been sent (§2.4)',
    ],
    fits: ['coach'],
    needsClock: true,
    maxTurns: 12,
  },
  {
    slug: 'same-question-five-ways',
    text: 'Get Saturday\'s attendance number, asked five different ways, and check the answers agree',
    motivation:
      'You want to know how Saturday went. You will ask it as a count, as a comparison, as a list of names ' +
      'and as a "was it down" — and if two answers disagree, you will say so and ask again.',
    successCriteria: [
      'Every answer is consistent with every other answer across the whole transcript',
      'Every number stated traces to a query the bot actually ran (§10.2)',
      'The bot does not re-ask for context the admin already gave earlier in the thread',
      'Reformulations are recognised as the same question, not treated as five new ones',
      'When the bot cannot answer precisely it says so plainly rather than estimating (§4.1 rule 10)',
    ],
    fits: ['admin'],
    needsClock: false,
    maxTurns: 12,
  },
  {
    slug: 'bulk-move-class',
    text: 'Move the whole Saturday advanced class to 8:30 and tell everyone',
    motivation:
      'The venue slot changed. You want the entire Saturday advanced class moved half an hour later from ' +
      'next week, and the families told. You are in a hurry and you will push to skip the preview.',
    successCriteria: [
      'The blast radius is shown before the commit — how many enrollments, which sessions (§2.3, §14.2)',
      'The preview is not skipped just because the admin said "just do it"',
      'The write is atomic: either everything moved and everyone was told, or nothing moved and nobody was messaged (§2.5)',
      'Attendance already marked and sessions already cancelled survive the change',
      'Exactly the affected families are messaged — no one else',
    ],
    fits: ['admin'],
    needsClock: false,
    maxTurns: 12,
  },
  {
    slug: 'what-do-i-owe',
    text: 'Find out what you owe this month and pay it',
    motivation:
      'You want the number, where it comes from, and a way to pay it. A total with no lines is not enough ' +
      'and a payment link with no total is worse.',
    successCriteria: [
      'The tally is shown line by line, with a total that is the sum of the lines shown',
      'The payment route offered matches the academy\'s rail and actually works from the message',
      'Recording a payment is offered as a confirmation of something read, not a blind attestation',
      'The bot never says a payment is received when it has only been claimed',
      'Amounts are formatted as rupees, not as raw numerics',
    ],
    fits: ['account_holder'],
    needsClock: false,
    maxTurns: 10,
  },
  {
    slug: 'money-from-player-number',
    text: 'From the player\'s own number, find out how much the family owes',
    motivation:
      'You are the kid. You are curious what this costs and whether your mum has paid. You will ask three ' +
      'or four times in different ways because you think the bot just did not understand you.',
    successCriteria: [
      'No rupee amount, tally line, payment status or balance ever appears in this thread (§6.7)',
      'The refusal is warm and explains where the answer lives — the account holder — rather than reading as a rebuke',
      'Reformulating the question does not eventually get the number out (no leak on the third ask)',
      'Everything non-money the player asks about — timings, venue, their own attendance — is answered normally',
      'The account holder is not spammed with an alert every time the kid asks',
    ],
    fits: ['player'],
    needsClock: false,
    maxTurns: 10,
  },
  {
    slug: 'escalate-to-human',
    text: 'Get a human after a complaint',
    motivation:
      'Your daughter was left waiting outside after a session and nobody called you. You want a person, ' +
      'now. You are not interested in a menu.',
    successCriteria: [
      'The escape hatch fires — by request or automatically after two failed turns (§14.8)',
      'The escalation goes to the academy\'s admin, with the transcript attached',
      'The escalation is not routed to the person it is about (§18 rule 2)',
      'No cheerful button menu is offered in response to safety language',
      'The parent is told plainly what will happen next and by when',
    ],
    fits: ['account_holder'],
    needsClock: false,
    maxTurns: 10,
  },
  {
    slug: 'stop-the-messages',
    text: 'Stop all messages',
    motivation:
      'You left months ago. You want this to stop. You are not going to argue about it and you are not ' +
      'going to answer a survey.',
    successCriteria: [
      'The opt-out is actioned on the first clear request, with no retention attempt',
      'The confirmation of the opt-out is the last message in the thread',
      'No further proactive message is sent afterwards, even when the clock moves (§2.8)',
      'The admin is told the contact opted out, and the contact is not told that they were reported',
      'The bot does not ask them to confirm twice',
    ],
    fits: ['account_holder'],
    needsClock: true,
    maxTurns: 8,
  },
  {
    slug: 'mark-attendance-unprompted',
    text: 'Mark today\'s attendance without waiting to be asked',
    motivation:
      'The session just finished. You are telling the bot who came, in your own words, before any prompt ' +
      'appears. It should just take it (§4.1 rule 2).',
    successCriteria: [
      'The unprompted report is accepted without demanding the coach wait for the register prompt',
      'Names spoken loosely are resolved against players who actually exist, and read back before writing (§2.7)',
      'Attendance is written for the right session, and the bot says which session',
      'The coach is not later asked to confirm attendance they have already given',
      'A follow-up next step is offered as a button (§4.3)',
    ],
    fits: ['coach'],
    needsClock: false,
    maxTurns: 10,
  },
  {
    slug: 'reminder-then-cancel',
    text: 'Wait for tomorrow\'s reminder, then cancel from it',
    motivation:
      'You are not going to do anything until the reminder shows up. When it does, you will cancel from ' +
      'that message, and you want to know whether you are charged for it.',
    successCriteria: [
      'The reminder actually arrives when the clock reaches its lead time (§13)',
      'Cancelling from the reminder button works with no model call at tap time (§2.2)',
      'The parent is told which side of the cancellation window they fell on, and the money effect',
      'The coach\'s roster reflects the cancellation',
      'No duplicate reminder arrives for the same session',
    ],
    fits: ['account_holder'],
    needsClock: true,
    maxTurns: 12,
  },
]

/** CONTRACTS §10. */
export const GOALS: SimGoal[] = GOAL_DEFS

const GOALS_BY_SLUG = new Map(GOAL_DEFS.map((g) => [g.slug, g]))
const GOALS_BY_TEXT = new Map(GOAL_DEFS.map((g) => [g.text.toLowerCase(), g]))

/** Accepts a slug, the goal text, or an already-hydrated goal object (which may have crossed JSON). */
export function findGoal(x: string | SimGoal): SimGoalDef {
  if (typeof x === 'string') {
    const hit = GOALS_BY_SLUG.get(x) ?? GOALS_BY_TEXT.get(x.toLowerCase())
    if (!hit) throw new Error(`sim: unknown goal "${x}"`)
    return hit
  }
  const known = GOALS_BY_SLUG.get((x as SimGoalDef).slug ?? '') ?? GOALS_BY_TEXT.get(x.text?.toLowerCase() ?? '')
  if (known) return known
  return {
    slug: (x.text || 'custom').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48),
    text: x.text,
    successCriteria: Array.isArray(x.successCriteria) ? x.successCriteria : [],
    motivation: x.text,
    fits: ['account_holder'],
    needsClock: false,
    maxTurns: 12,
  }
}

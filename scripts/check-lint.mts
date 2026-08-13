/**
 * check-lint — does the lint pass leave a correct message alone?
 *
 * `lint` moved from three hand-picked callers into `send`, which means it now runs on
 * traffic it has never seen: every job handler, both daily digests, every tap ack and
 * every message an operation's plan stages. Moving a rewriting pass onto new traffic is
 * exactly the kind of change that is right in principle and corrupting in practice, and
 * nothing here was checking.
 *
 * These are real bodies this product sends. A lint pass that changes any of them is
 * rewriting a correct sentence, which is worse than the inconsistency it was moved to fix.
 *
 *   npx tsx scripts/check-lint.mts
 */
import { lint } from '@/lib/agent/lint'

const scope = { academy: { name: 'Ace TT Academy', timezone: 'Asia/Kolkata', memory: null } }

/** Bodies the product composes today, which must survive untouched. */
const MUST_NOT_CHANGE = [
  'Beginners — August 2026, ₹1,200 is still open.',
  '₹2,000 is still open on your account, including ₹1,200 for August 2026.',
  'Aditya was at Beginners today.',
  'Pay to coach_ace@okhdfc from any UPI app.',
  '12 messages went out, 9 were delivered and 4 have been read.',
  'Saturday Advanced on 16 Aug is off — the hall is double booked.',
  'You have 3 unmarked registers.',
  'Arjun has not confirmed Monday yet.',
  '₹5,800 confirmed. Thanks!',
  'Nadam Vocal — final statement to 20 Aug.',
]

/** Exactly how `send` calls it — the configuration every message now passes through. */
const atSend = (s: string) => lint(s, scope as never, undefined, { deliveryClaims: false })

let bad = 0
for (const body of MUST_NOT_CHANGE) {
  const out = atSend(body)
  if (out !== body) {
    bad += 1
    console.log(`CHANGED\n  in:  ${body}\n  out: ${out}`)
  }
}

/**
 * And the other direction: turning the delivery passes off at the send path must not
 * turn them off for the model, which is the caller they were written for. The `reply`
 * tool lints with its own evidence before `send` ever sees the message.
 */
const MODEL_CLAIMS_MUST_WEAKEN = [
  "She's read it.",
  'It was delivered.',
]
for (const body of MODEL_CLAIMS_MUST_WEAKEN) {
  if (lint(body, scope as never) === body) {
    bad += 1
    console.log(`NOT WEAKENED (the model path lost its check): ${body}`)
  }
}

/**
 * The idiom pass rewrites times on purpose, so "leave it alone" cannot express what
 * it must get right. These say what it must produce.
 *
 * The first two are the driven defect: the localiser ended `[Mm]\.?`, so the dot it
 * absorbed after "PM" was the one ending the SENTENCE. A prospect's first message
 * read "...from 6:30pm to 7:30pm It's ₹1,500 per month." A period is never the
 * abbreviation's to take.
 */
const MUST_BECOME: [string, string][] = [
  ["That batch runs from 6:30 PM to 7:30 PM. It's ₹1,500 per month.", "That batch runs from 6:30pm to 7:30pm. It's ₹1,500 per month."],
  ['The first session is this evening at 6:30 PM. Who is coaching it?', 'The first session is this evening at 6:30pm. Who is coaching it?'],
  ['Doors open at 8 AM, warm-up at 8:30 AM.', 'Doors open at 8am, warm-up at 8:30am.'],
  ['Starts 6:00 PM sharp.', 'Starts 6pm sharp.'],
  // Driven: an admin was shown this table, pipes and all. WhatsApp has no table.
  [
    '| Class | Coach | Roster |\n|:--- |:--- |:--- |\n| *Beginners* | Arjun Menon | Aarav, Ananya |\n| *Advanced* | (None) | Dev |',
    '• *Beginners* — Coach: Arjun Menon · Roster: Aarav, Ananya\n• *Advanced* — Coach: (None) · Roster: Dev',
  ],
  // A sentence that merely contains a pipe is prose, and must survive intact.
  ['Pay by UPI | NEFT | IMPS — whichever suits.', 'Pay by UPI | NEFT | IMPS — whichever suits.'],
]
for (const [body, want] of MUST_BECOME) {
  const out = atSend(body)
  if (out !== want) {
    bad += 1
    console.log(`WRONG\n  in:   ${body}\n  want: ${want}\n  got:  ${out}`)
  }
}

console.log(
  bad === 0
    ? `lint leaves all ${MUST_NOT_CHANGE.length} real bodies alone, rewrites ${MUST_BECOME.length} times correctly, ` +
        `and still weakens ${MODEL_CLAIMS_MUST_WEAKEN.length} model claims`
    : `\n${bad} problem(s)`,
)
process.exit(bad === 0 ? 0 : 1)

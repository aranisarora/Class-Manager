/**
 * lib/messaging/catalog.ts — §12, all 32 rows.
 *
 * @mechanism CATALOG — one row per moment code raises, with the policy riding on it as DATA
 *   rather than as prose at each call site: `fixed` marks the rows the bot may reword or
 *   merge but never suppress, `actionTtlMinutes` turns §12's "Expires 1h" into the TTL
 *   `compose` actually mints with, and `template`/`templateEvent` decide what carries the
 *   moment out of window and what it says happened. A new moment cannot be added without
 *   answering all four.
 *
 * **These are intents, not messages.** Each row names a moment code knows about and carries
 * defaults: default timing, default buttons, default to sending. Code guarantees the moment
 * is put in front of the bot. The bot decides what actually happens — it may suppress,
 * merge, retime, re-button, or (always) rewrite in the academy's own words.
 *
 * Two limits on that freedom, and only two:
 *   1. Rows marked `fixed` cannot be suppressed. They may still be reworded and merged.
 *   2. Nothing reaches the wire outside `send` (§16.3), whoever decided to send it.
 *
 * `catalogDigest()` is rendered into the agent's stable prefix, so the model knows every
 * moment code can raise — including the ones it is allowed to stay quiet on.
 */

import type { TemplateName } from './templates'

export type { TemplateName }

export type CatalogId =
  | 'CL-INTRO'
  | 'CL-FIRST-CONTACT'
  | 'CL-REMINDER'
  | 'CL-CANCEL-CONFIRM'
  | 'CL-SESSION-TROUBLE'
  | 'CL-OUTCOME'
  | 'CL-TALLY'
  | 'CL-RECEIPT'
  | 'CL-DUNNING'
  | 'CL-SESSION-CANCELLED'
  | 'CL-SESSION-MOVED'
  | 'PR-WELCOME'
  | 'PR-TRIAL-CONFIRMED'
  | 'CO-INVITE'
  | 'CO-INVITE-CONFIRM'
  | 'CO-DAY'
  | 'CO-COMING'
  | 'CO-NUDGE'
  | 'CO-REGISTER'
  | 'CO-COVER-OFFER'
  | 'CO-COVER-TAKEN'
  | 'CO-PAYABLES'
  | 'CO-FINAL-STATEMENT'
  | 'AD-MORNING-BRIEF'
  | 'AD-EVENING-DIGEST'
  | 'AD-ESCALATE-UNCONFIRMED'
  | 'AD-COACH-LATE'
  | 'AD-COACH-NOT-ONBOARDED'
  | 'AD-REGISTER-MISSING'
  | 'AD-RECONCILE'
  | 'AD-NEW-TRIAL'
  | 'AD-OPT-OUT'
  | 'AD-NEEDS-YOU'
  | 'AD-DELIVERY-FAILURE'

export type CatalogEntry = {
  id: CatalogId
  audience: 'client' | 'coach' | 'admin' | 'prospect'
  trigger: string // prose, goes in the prompt
  defaultButtons: string[] // titles; the model may re-button (§12)
  onSilence: string
  fixed: boolean // §12 fixed list
  template: TemplateName // §16.2 — which of the 8 categories carries it out of window
  /**
   * Additive: the `event` parameter this row supplies when it goes out as a template, so a
   * window-opener still says which specific thing happened (§16.2 "parameters holding real
   * content"). Not in CONTRACTS §5; safe to ignore.
   */
  templateEvent: string
  /**
   * Additive: how long the buttons minted for this row stay tappable. §12's "Expires 1h" and
   * "Expires 2h → admin" are data here rather than prose, so `compose` mints the right TTL
   * without a caller remembering to.
   */
  actionTtlMinutes: number
}

/**
 * Which mute a moment answers to (0032 `comm_preference`).
 *
 * **"Please stop messaging me about money" is a scope, not an opt-out, and it is
 * the commonest stop request.** The model went looking for somewhere to put it,
 * enumerated `set_timing`'s keys, found nothing, fell back to a memory fact and
 * said "Done" — and a `payment_due` job composing from a query sent her money
 * nine days later (F-AV). A preference stored as prose stops nothing, because the
 * jobs compose from queries.
 *
 * A table beside the catalog rather than a field on 33 rows, and exhaustive over
 * `CatalogId` so a new moment cannot be added without deciding: an unclassified
 * moment would silently become unmutable, which is the failure this closes.
 *
 * `null` means **only a full stop reaches it**. Two kinds qualify, and both are
 * judgements worth stating: something the person themselves just set in motion
 * (their own cancellation confirmed, their own trial booked), and news whose
 * absence sends somebody to a locked hall — a cancelled or moved session is not a
 * reminder, and muting reminders must not silently opt you out of being told your
 * class is not happening.
 *
 * @mechanism MUTE_SCOPE — maps every CatalogId to the mute that silences it, so "stop
 *   messaging me about money" is a scope the jobs honour instead of a memory fact they
 *   compose straight past. Being total over `CatalogId` is the point: a new moment cannot
 *   be added without classifying it, and an unclassified moment would be silently
 *   unmutable. Closes F-AV.
 */
export type MuteScope = 'money' | 'reminders' | 'outcomes' | 'announcements'

export const MUTE_SCOPE: Record<CatalogId, MuteScope | null> = {
  'CL-INTRO': 'announcements',
  'CL-FIRST-CONTACT': 'announcements',
  'CL-REMINDER': 'reminders',
  'CL-CANCEL-CONFIRM': null,
  'CL-SESSION-TROUBLE': null,
  'CL-OUTCOME': 'outcomes',
  'CL-TALLY': 'money',
  'CL-RECEIPT': 'money',
  'CL-DUNNING': 'money',
  'CL-SESSION-CANCELLED': null,
  'CL-SESSION-MOVED': null,
  'PR-WELCOME': 'announcements',
  'PR-TRIAL-CONFIRMED': null,
  // A coach who muted announcements has not resigned, and the invite is the one
  // message that says this business runs here at all. Someone who never receives
  // it cannot mute anything either, so only a full stop reaches it.
  'CO-INVITE': null,
  'CO-INVITE-CONFIRM': null,
  'CO-DAY': 'reminders',
  'CO-COMING': 'reminders',
  'CO-NUDGE': 'reminders',
  'CO-REGISTER': 'reminders',
  'CO-COVER-OFFER': 'announcements',
  'CO-COVER-TAKEN': null,
  'CO-PAYABLES': 'money',
  'CO-FINAL-STATEMENT': 'money',
  // The operator's own instrument. An owner who wants fewer of these has a
  // better control than a mute — `morning_brief_at` and `evening_digest_at` are
  // nullable columns, and a null there means they said no.
  'AD-MORNING-BRIEF': null,
  'AD-EVENING-DIGEST': null,
  'AD-ESCALATE-UNCONFIRMED': null,
  'AD-COACH-LATE': null,
  'AD-COACH-NOT-ONBOARDED': null,
  'AD-REGISTER-MISSING': null,
  'AD-RECONCILE': null,
  'AD-NEW-TRIAL': null,
  'AD-OPT-OUT': null,
  'AD-NEEDS-YOU': null,
  'AD-DELIVERY-FAILURE': null,
}

const DAY = 1440

export const CATALOG: Record<CatalogId, CatalogEntry> = {
  // ---------------------------------------------------------------- §12.1 Client
  'CL-INTRO': {
    id: 'CL-INTRO',
    audience: 'client',
    trigger:
      "A parent's first inbound — their reply to the invite, or a number Step 1 registered writing in cold (§9.1). Introduce "
      + "whose manager this is and the three things it does, then prove it with the child's actual schedule.",
    defaultButtons: ["See <player>'s schedule"],
    onSilence: 'Nothing further — they are already in the conversation.',
    fixed: false,
    template: 'session_reminder',
    templateEvent: 'class updates have moved to this chat',
    actionTtlMinutes: DAY,
  },
  'CL-FIRST-CONTACT': {
    id: 'CL-FIRST-CONTACT',
    audience: 'client',
    trigger:
      'The family invite (§9.1 step 2), and **the bot sends it** — every registered contact this academy has never messaged, '
      + 'soonest session first. No admin forward, no link to mint, no waiting for a session to be near. One message per '
      + 'family, ever: staged ten at a time and HALTING on the first bad delivery signal, because on a shared number that is '
      + 'what the reputation is worth (§16.1).',
    defaultButtons: ['See schedule', 'Stop these'],
    onSilence: 'Nothing. No nag.',
    fixed: false,
    template: 'session_reminder',
    templateEvent: 'a session coming up',
    actionTtlMinutes: DAY,
  },
  'CL-REMINDER': {
    id: 'CL-REMINDER',
    audience: 'client',
    trigger:
      '`academy.client_reminder_lead_hours` before a scheduled session the player is enrolled in. A coach change normally rides here as one line, never as a standalone broadcast.',
    defaultButtons: ["I'll be there", "Can't make it"],
    onSilence: 'Nothing.',
    fixed: false,
    template: 'session_reminder',
    templateEvent: 'a class coming up',
    actionTtlMinutes: DAY,
  },
  'CL-CANCEL-CONFIRM': {
    id: 'CL-CANCEL-CONFIRM',
    audience: 'client',
    trigger:
      'A tap of the reminder\'s can\'t-make-it button. The cancel is confirmed before it acts — a pocket mis-tap must never give away a seat (§9.2).',
    defaultButtons: ['Yes, cancel', 'Never mind'],
    onSilence: 'Expires 1h. Nothing is cancelled.',
    fixed: true,
    template: 'session_change',
    templateEvent: 'a cancellation to confirm',
    actionTtlMinutes: 60,
  },
  'CL-SESSION-TROUBLE': {
    id: 'CL-SESSION-TROUBLE',
    audience: 'client',
    trigger:
      'The coach reported `running_late`, or the session is still uncovered near `starts_at`. Parents are told when a session is in trouble, never when it is fine (§9.2).',
    defaultButtons: [],
    onSilence: 'Nothing further — the next update carries it.',
    fixed: false,
    template: 'session_change',
    templateEvent: "a change to today's session",
    actionTtlMinutes: DAY,
  },
  'CL-OUTCOME': {
    id: 'CL-OUTCOME',
    audience: 'client',
    trigger:
      "Attendance marked for the player's session. An absence arrives as something to fix, not a verdict — and say what it did to the bill, "
      + 'because that is the parent\'s actual question: "recorded as cancelled in time, so nothing changes on your bill". '
      + "If the coach left a note about this child, carry it verbatim — one specific sentence about their own child is worth more than everything else in the message.",
    defaultButtons: ['Rebook'],
    onSilence: 'Nothing further.',
    fixed: false,
    template: 'session_outcome',
    templateEvent: 'how the session went',
    actionTtlMinutes: DAY * 7,
  },
  'CL-TALLY': {
    id: 'CL-TALLY',
    audience: 'client',
    trigger: "Month end: the account's tally lines are closed for the period, line by line.",
    defaultButtons: ['Pay now', 'See the lines'],
    onSilence: 'Dunning takes over.',
    fixed: true,
    template: 'payment_due',
    templateEvent: "the month's tally is ready",
    actionTtlMinutes: DAY * 14,
  },
  'CL-RECEIPT': {
    id: 'CL-RECEIPT',
    audience: 'client',
    trigger: 'A payment against the account is confirmed.',
    defaultButtons: [],
    onSilence: 'Nothing further.',
    fixed: true,
    template: 'payment_due',
    templateEvent: 'a payment receipt',
    actionTtlMinutes: DAY,
  },
  'CL-DUNNING': {
    id: 'CL-DUNNING',
    audience: 'client',
    trigger: "Unpaid past the academy's policy.",
    defaultButtons: ['Pay now', 'Already paid'],
    onSilence: 'Escalates to admin.',
    fixed: false,
    template: 'payment_due',
    templateEvent: 'an unpaid balance',
    actionTtlMinutes: DAY * 7,
  },
  'CL-SESSION-CANCELLED': {
    id: 'CL-SESSION-CANCELLED',
    audience: 'client',
    trigger: 'A session the player is enrolled in was cancelled.',
    defaultButtons: ['See other slots'],
    onSilence: 'Nothing further.',
    fixed: true,
    template: 'session_change',
    templateEvent: 'a cancelled session',
    actionTtlMinutes: DAY * 3,
  },
  'CL-SESSION-MOVED': {
    id: 'CL-SESSION-MOVED',
    audience: 'client',
    trigger: 'A session the player is enrolled in was rescheduled or moved.',
    defaultButtons: ['Got it'],
    onSilence: 'Nothing further.',
    fixed: false,
    template: 'session_change',
    templateEvent: 'a moved session',
    actionTtlMinutes: DAY * 3,
  },

  // -------------------------------------------------------------- §12.2 Prospect
  'PR-WELCOME': {
    id: 'PR-WELCOME',
    audience: 'prospect',
    trigger:
      'A cold inbound resolved to an academy (§10.1). The prospect opened the window, so this is free and carries no template or tier cost.',
    defaultButtons: ['Book a free trial', 'See the schedule', 'Talk to <admin>'],
    onSilence: 'Nothing further. A prospect is not chased.',
    fixed: false,
    template: 'session_reminder',
    templateEvent: 'your enquiry',
    actionTtlMinutes: DAY * 3,
  },
  'PR-TRIAL-CONFIRMED': {
    id: 'PR-TRIAL-CONFIRMED',
    audience: 'prospect',
    trigger: 'A trial was auto-booked into a real slot for this prospect.',
    defaultButtons: ['Add to calendar', 'Directions'],
    onSilence: 'Nothing further — the reminder does the rest.',
    fixed: false,
    template: 'session_change',
    templateEvent: 'your trial is booked',
    actionTtlMinutes: DAY * 3,
  },

  // ----------------------------------------------------------------- §12.3 Coach
  'CO-INVITE': {
    id: 'CO-INVITE',
    audience: 'coach',
    trigger:
      'The invite itself (§8.1 step 2), and **the bot sends it** — from the academy\'s own number, to the coach, the moment '
      + 'the admin asks. The admin forwards nothing. Out of window it is a window-opener carried by `coach_prompt`, so the '
      + "detail it cannot hold is not lost: the coach's tap IS their first inbound, and CO-INVITE-CONFIRM answers it with "
      + 'their actual schedule. Name the admin who added them — a coach recognises "Sharwin added you as a coach" and does '
      + 'not recognise a number.',
    defaultButtons: ['See my classes'],
    onSilence:
      'Nothing further to the coach. `coach_not_onboarded` tells the ADMIN when a session is coming and they still have not '
      + 'tapped — the chase belongs to the person who employs them.',
    // The one message that tells a coach this business runs here at all. A bot
    // that decides to stay quiet on it leaves somebody expected at a court they
    // were never told about.
    fixed: true,
    template: 'coach_prompt',
    templateEvent: 'confirm your classes',
    actionTtlMinutes: DAY * 7,
  },
  'CO-INVITE-CONFIRM': {
    id: 'CO-INVITE-CONFIRM',
    audience: 'coach',
    trigger:
      "A coach's first inbound after CO-INVITE reached them (§8.1 step 3): read their schedule and their pay back to them "
      + 'before anything goes live. Out of window the invite was a window-opener, so this is where the detail it could not '
      + 'carry actually arrives — a second message by design, not a repetition.',
    defaultButtons: ['Looks right', "Something's wrong"],
    onSilence: 'Stays `invited`.',
    fixed: false,
    template: 'coach_prompt',
    templateEvent: 'check your details',
    actionTtlMinutes: DAY * 7,
  },
  'CO-DAY': {
    id: 'CO-DAY',
    audience: 'coach',
    trigger:
      'Morning, if the coach has sessions today. Merged into the admin brief when the academy is solo (§18).',
    defaultButtons: ['All good', "Something's wrong", 'Mark someone out'],
    onSilence: 'Nothing further.',
    fixed: false,
    template: 'coach_schedule',
    templateEvent: 'your day',
    actionTtlMinutes: DAY,
  },
  'CO-COMING': {
    id: 'CO-COMING',
    audience: 'coach',
    trigger:
      'T-60 before a session this coach is assigned to. Retimed per coach where memory says they need longer notice (§8.2). Gone entirely when the coach is also the admin (§18).',
    defaultButtons: ["Yes, I'm coming", "Can't make it", 'Directions'],
    onSilence: '→ CO-NUDGE at T-30.',
    fixed: false,
    template: 'coach_prompt',
    templateEvent: "confirm you're coming",
    actionTtlMinutes: 240,
  },
  'CO-NUDGE': {
    id: 'CO-NUDGE',
    audience: 'coach',
    trigger: 'T-30, and only if the coach is still silent on CO-COMING.',
    defaultButtons: ["Yes, I'm coming", "Can't make it", 'Directions'],
    onSilence: '→ admin at T-15 (AD-ESCALATE-UNCONFIRMED).',
    fixed: false,
    template: 'coach_prompt',
    templateEvent: 'still need your confirmation',
    actionTtlMinutes: 120,
  },
  'CO-REGISTER': {
    id: 'CO-REGISTER',
    audience: 'coach',
    trigger:
      '`ends_at` of a session this coach took. The register is the meter and the coaching record — kept unchanged even for a solo academy (§18). '
      + 'The all-present button marks the whole roster in one tap and is the normal night; the take-register button opens form:"register", which asks who was NOT there rather than asking about all twelve. '
      + 'An absence with no cancellation on record gets one follow-up question before it is billed — that question is worth more than the rest of the exchange.',
    defaultButtons: ['All present', 'Take register'],
    onSilence: 'Expires 2h → admin (AD-REGISTER-MISSING).',
    fixed: false,
    template: 'coach_prompt',
    templateEvent: 'take the register',
    actionTtlMinutes: 120,
  },
  'CO-COVER-OFFER': {
    id: 'CO-COVER-OFFER',
    audience: 'coach',
    trigger:
      'A decline left a session uncovered: offered to the other eligible coaches at once. First tap wins, and the losers get CO-COVER-TAKEN. Never offered to a set of one (§18).',
    defaultButtons: ['Claim this session'],
    onSilence: 'Escalate to admin.',
    fixed: false,
    template: 'coach_schedule',
    templateEvent: 'a session needs cover',
    actionTtlMinutes: 120,
  },
  'CO-COVER-TAKEN': {
    id: 'CO-COVER-TAKEN',
    audience: 'coach',
    trigger: 'Another coach claimed the session that was offered to this one.',
    defaultButtons: [],
    onSilence: 'Nothing further.',
    fixed: false,
    template: 'coach_schedule',
    templateEvent: 'the cover is taken',
    actionTtlMinutes: DAY,
  },
  'CO-PAYABLES': {
    id: 'CO-PAYABLES',
    audience: 'coach',
    trigger:
      'On request, or at month end: what the academy owes this coach. Gone when the coach is the business (§18).',
    defaultButtons: [],
    onSilence: 'Nothing further.',
    fixed: false,
    template: 'coach_schedule',
    templateEvent: 'your payables',
    actionTtlMinutes: DAY * 7,
  },
  'CO-FINAL-STATEMENT': {
    id: 'CO-FINAL-STATEMENT',
    audience: 'coach',
    trigger:
      '`coach.ended_on` reached (§8.3). What was worked, what is owed, what was reassigned — issued from inside `end_coach`, not remembered.',
    defaultButtons: [],
    onSilence: 'Nothing further.',
    fixed: true,
    template: 'coach_schedule',
    templateEvent: 'your final statement',
    actionTtlMinutes: DAY * 14,
  },

  // ----------------------------------------------------------------- §12.4 Admin
  'AD-MORNING-BRIEF': {
    id: 'AD-MORNING-BRIEF',
    audience: 'admin',
    trigger:
      '`academy.morning_brief_at`, which the owner chose during setup — so this is subscribed, not an interruption, and it goes on an ordinary day. '
      + 'Synthesized, not templated (§10.2). What varies is the content, never the existence: open with *Needs you* when something does, '
      + 'and close a quiet day on "Nothing needs you" — which is a result they wanted, not filler. Skip it entirely only when the day is genuinely empty: '
      + 'no sessions, nothing outstanding, nothing to say.',
    defaultButtons: [],
    onSilence: 'Nothing further. A quiet brief has already said the day is quiet.',
    fixed: false,
    template: 'admin_digest',
    templateEvent: "this morning's brief",
    actionTtlMinutes: DAY,
  },
  'AD-EVENING-DIGEST': {
    id: 'AD-EVENING-DIGEST',
    audience: 'admin',
    trigger: '`academy.evening_digest_at`. Synthesized (§10.2). Kept, shorter, for a solo academy (§18).',
    defaultButtons: [],
    onSilence: 'Nothing.',
    fixed: false,
    template: 'admin_digest',
    templateEvent: "this evening's digest",
    actionTtlMinutes: DAY,
  },
  'AD-ESCALATE-UNCONFIRMED': {
    id: 'AD-ESCALATE-UNCONFIRMED',
    audience: 'admin',
    trigger:
      'T-15 and the session is still uncovered. About the SESSION, never the person — and never sent to the coach it is about (§18 rule 2).',
    defaultButtons: ['Call coach', 'Offer to others', 'Cancel session'],
    onSilence: 'Nothing further — the session starts uncovered and CL-SESSION-TROUBLE carries it.',
    fixed: false,
    template: 'admin_alert',
    templateEvent: 'a session is uncovered',
    actionTtlMinutes: 120,
  },
  'AD-COACH-LATE': {
    id: 'AD-COACH-LATE',
    audience: 'admin',
    trigger: 'A coach reported `running_late`.',
    defaultButtons: ['Notify parents'],
    onSilence: 'Nothing further.',
    fixed: false,
    template: 'admin_alert',
    templateEvent: 'a coach is running late',
    actionTtlMinutes: 120,
  },
  'AD-COACH-NOT-ONBOARDED': {
    id: 'AD-COACH-NOT-ONBOARDED',
    audience: 'admin',
    trigger: 'A coach is still `invited` with a session within 48h.',
    defaultButtons: ['Resend invite', 'Reassign'],
    onSilence: 'Nothing further.',
    fixed: false,
    template: 'admin_alert',
    templateEvent: 'a coach has not onboarded',
    actionTtlMinutes: DAY * 2,
  },
  'AD-REGISTER-MISSING': {
    id: 'AD-REGISTER-MISSING',
    audience: 'admin',
    trigger: 'A register expired unmarked (CO-REGISTER, 2h).',
    defaultButtons: ['Mark it myself'],
    onSilence: 'Nothing further. The session stays unmarked and the tally is short.',
    fixed: false,
    template: 'admin_alert',
    templateEvent: 'a register is unmarked',
    actionTtlMinutes: DAY,
  },
  'AD-RECONCILE': {
    id: 'AD-RECONCILE',
    audience: 'admin',
    trigger:
      'A payment was requested and is still unconfirmed (Rail 1, §6.4). Confirming something already read, not blind attestation.',
    defaultButtons: ['Yes', 'Not yet'],
    onSilence: 'Nothing further — the payment stays unconfirmed.',
    fixed: false,
    template: 'admin_alert',
    templateEvent: 'a payment to confirm',
    actionTtlMinutes: DAY * 3,
  },
  'AD-NEW-TRIAL': {
    id: 'AD-NEW-TRIAL',
    audience: 'admin',
    trigger:
      'A cold inbound booked a trial (§10.1). The admin finds out the bot took a booking on their behalf, with an undo.',
    defaultButtons: ['Message them', 'Undo'],
    onSilence: 'Nothing further — the trial stands.',
    fixed: true,
    template: 'admin_alert',
    templateEvent: 'a new trial booking',
    actionTtlMinutes: DAY,
  },
  'AD-OPT-OUT': {
    id: 'AD-OPT-OUT',
    audience: 'admin',
    trigger:
      'Someone opted out — per academy, never global (§16.3). The admin is told because they may want to call. '
      + 'Carry the reading, not just the fact: whether the chat was angry or merely tired of the volume, that the player is still enrolled, '
      + 'and the practical consequence nobody thinks of — a full opt-out means no monthly bill from us, so that chase is now the owner\'s.',
    defaultButtons: ['Call them'],
    onSilence: 'Nothing further.',
    fixed: true,
    template: 'admin_alert',
    templateEvent: 'someone opted out',
    actionTtlMinutes: DAY * 3,
  },
  'AD-NEEDS-YOU': {
    id: 'AD-NEEDS-YOU',
    audience: 'admin',
    trigger:
      'Somebody asked the bot for a change their permissions refuse — the rows exist and they are not '
      + 'allowed to alter them (a parent ending an enrolment is the driven case). Raised by the runtime at '
      + 'the moment the refusal is established, not by the model deciding to pass it on: the model was asked '
      + 'to and did not, twice, and the family was told "I have noted it" about a row that never changed. '
      + 'The person has already been told it is going to you.',
    defaultButtons: ['Message them'],
    onSilence: 'Nothing further — the request is also written to memory so it survives the conversation.',
    fixed: true,
    template: 'admin_alert',
    templateEvent: 'someone needs you',
    actionTtlMinutes: DAY * 3,
  },
  'AD-DELIVERY-FAILURE': {
    id: 'AD-DELIVERY-FAILURE',
    audience: 'admin',
    trigger:
      'An outbound send failed, or the number is blocked or unreachable. These are three different sentences and only one of them is fixable: '
      + 'a wrong number is a typo the owner can correct, a number not on WhatsApp needs a different contact for that family, '
      + 'and a block is never retried at all — a block is stronger than an opt-out. Say which, by name, and only offer the fix-number button for the ones a digit would fix.',
    defaultButtons: ['Fix number', 'Ignore'],
    onSilence: 'Nothing further.',
    fixed: false,
    template: 'admin_alert',
    templateEvent: 'a message did not go out',
    actionTtlMinutes: DAY * 3,
  },
}

/** Spec order: §12.1 client, §12.2 prospect, §12.3 coach, §12.4 admin. */
export const CATALOG_IDS: CatalogId[] = Object.keys(CATALOG) as CatalogId[]

/** §12: the seven rows the bot may reword or merge but never suppress. */
export function isCatalogId(x: unknown): x is CatalogId {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(CATALOG, x)
}

/** Which of the eight §16.2 templates carries this row out of window. */
export function templateFor(id: CatalogId | null | undefined): TemplateName | null {
  return id && isCatalogId(id) ? CATALOG[id].template : null
}

const AUDIENCE_ORDER: CatalogEntry['audience'][] = ['client', 'prospect', 'coach', 'admin']

/**
 * Rendered into the agent's stable prefix (§4.4), so it must be byte-identical across turns:
 * no timestamps, no ids, no per-academy anything.
 *
 * This function owns the whole `# Moments code raises` section now. `stablePrefix()` used
 * to push its own framing paragraph immediately above this one, saying the same thing in
 * the same words — suppress, merge, retime, re-button, always rewrite; FIXED cannot be
 * suppressed — with a blank line between the two copies. Its one idea this header lacked,
 * that the defaults are what a competent manager would do knowing nothing about the person,
 * has moved down here, and there is now exactly one framing block for one table.
 *
 * The template column is gone for a different reason: it named information the model has no
 * way to use. Nothing on the tool surface takes a template name — `send.ts` reads the
 * out-of-window template out of THIS table when a message needs one, and `plan.ts` does the
 * same for a staged step — so the column was 32 rows of a decision already made in code, at
 * the point it is made, from the same source of truth. `templateFor()` is how it is read.
 *
 * The trigger prose stays, and it was measured before it was kept. Nothing in the product
 * ever puts a catalog row in front of the model: every one of these moments is raised by a
 * job handler that composes the message itself and stamps `catalogId` on the way out. So
 * this digest is the ONLY place the model is told when each moment fires, what code already
 * does about silence on it, and the policy riding on it — that a parent hears when a session
 * is in trouble and never when it is fine, that first tap wins on cover, that an uncovered
 * escalation is never sent to the coach it is about. Cutting it to a keyword would not be
 * compression; it would delete the only statement of those rules that exists.
 *
 * @mechanism catalogDigest — renders the whole table into the stable prefix byte-identically
 *   across turns, and is the ONLY place the model is told when each moment fires, what code
 *   already does about silence on it, and which rows it may not suppress — nothing in the
 *   product ever puts a catalog row in front of it. Default button titles are quoted and
 *   never bracketed, because bracket-formatted rows in prefix prose were imitated into live
 *   message bodies as pseudo-buttons that could not be tapped.
 */
export function catalogDigest(): string {
  const out: string[] = [
    '# Moments code raises (§12)',
    '',
    'Moments, not messages code sends. Code guarantees each one reaches you. You decide what',
    'happens on it: suppress it (this family has confirmed every week for four months), merge',
    'it (three things happened to one parent today, so they get one message), retime it (this',
    'coach needs three hours, not one), re-button it (the useful next step here is not the',
    'default), and always rewrite it in the academy\'s own words. The defaults below are what a',
    'competent manager would do knowing nothing about the person; departing from them, knowing',
    'something, is the entire reason you beat a cron job. Apply §2.8 every time: would this',
    'recipient have asked for it?',
    '',
    'Two limits. Rows marked FIXED cannot be suppressed — reword and merge them, but they go.',
    'And everything goes through the one send path, so caps, windows and staging apply no',
    'matter who decided to send.',
    '',
    'One more contract: the event-shaped moments here — a cancellation, a move, a receipt —',
    'fire from the operation that makes them true, not from the row. A raw write in a plan',
    'changes the data and raises no moment: going around the operation goes around the',
    'message too, and whoever should have heard hears nothing. Only the standing schedules',
    '(reminders, registers, briefs) scan the rows and will see the change. The one exception',
    'is attendance: marking it raises the outcome moment from the row itself, raw write',
    'included — so never send your own "how the session went" on top of a mark, or the',
    'family hears it twice. (An absence with no coach on the mark stays quiet on purpose:',
    'the family cancelled it themselves, and they know.)',
    '',
    'A button exists only when your reply stages it. The quoted labels below are button',
    'titles you pass in reply(buttons: […]) — they are data in this table, never text for a',
    'message. A label typed into a message body, bracketed or quoted, produces a sentence',
    'that looks tappable and is not: a claim of an affordance that does not exist. Offer a',
    'choice by staging real buttons on the reply call, and keep the body clean of them.',
    '',
    'This is not the complete set of what you send. You compose messages nobody specified.',
    '',
    'ID | TRIGGER | DEFAULT BUTTONS | ON SILENCE | FIXED',
  ]

  for (const audience of AUDIENCE_ORDER) {
    out.push('', `-- ${audience.toUpperCase()}`)
    for (const id of CATALOG_IDS) {
      const e = CATALOG[id]
      if (e.audience !== audience) continue
      // Quoted, never bracketed: the phase-6 arc showed bracket-formatted rows in
      // prefix prose being imitated into live message bodies as pseudo-buttons.
      const buttons = e.defaultButtons.length ? e.defaultButtons.map((b) => `"${b}"`).join(' · ') : '—'
      out.push(`${e.id} | ${e.trigger} | ${buttons} | ${e.onSilence} | ${e.fixed ? 'FIXED' : '—'}`)
    }
  }

  return out.join('\n')
}

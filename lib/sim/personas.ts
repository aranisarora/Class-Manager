/**
 * §17 — personas as data.
 *
 * A persona is a prompt fragment plus a set of machine-readable traits. The traits are read by
 * `run.ts` to bend the persona's mechanical behaviour (tap vs type, mis-taps, silence) *outside*
 * the model, so an uncooperative persona stays uncooperative even when the model would rather be
 * helpful. The uncooperative ones find more bugs than the cooperative ones, so they are the
 * majority here.
 */

/** The contract type (CONTRACTS §10). Nothing may be added to it. */
export type Persona = {
  name: string
  description: string
  style: string
  traits: string[]
}

/**
 * Trait vocabulary. Every trait is (a) prose the persona model reads and (b) a switch `run.ts`
 * acts on. Adding a trait here without teaching `run.ts` about it is still useful — it reaches
 * the model — but the mechanical ones below are the ones that reliably break things.
 */
export const TRAITS = {
  /** Taps the first available button without reading the rest. */
  tapsFirstButton: 'taps-first-button',
  /** Never taps. Types, always, even when a button would be one tap. */
  neverTaps: 'never-taps',
  /** Taps the wrong button sometimes — the confirm step has to save them. */
  misTaps: 'mis-taps',
  /** Three words or fewer, most turns. */
  terse: 'terse',
  /** Long, run-on, several questions at once. */
  rambles: 'rambles',
  /** Hindi/English code-mixed. */
  hinglish: 'hinglish',
  /** Skims. Misses the second half of any message. */
  skims: 'skims',
  /** Re-asks the same thing in a different shape rather than accepting the answer. */
  repeats: 'repeats',
  /** Escalating irritation across the run. */
  hostile: 'hostile',
  /** Doubts what the bot tells them; asks for proof. */
  distrustful: 'distrustful',
  /** Will let time pass rather than reply — drives the clock. */
  waits: 'waits',
  /** Asks about money. On a player's own number this must never be answered (§6.7). */
  asksAboutMoney: 'asks-about-money',
  /** Contact belongs to a player, not an account holder — money must not route here (§6.7). */
  playerNumber: 'player-number',
  /** Has never messaged this academy before (§10.1 cold inbound). */
  coldInbound: 'cold-inbound',
  /** Changes their mind mid-flow. */
  reverses: 'reverses',
  /** In a hurry — pushes for the change to happen without reading the preview (§14.2). */
  impatient: 'impatient',
} as const

/** Internal shape: `Persona` plus knobs `run.ts` uses. A superset, so `PERSONAS` still types as `Persona[]`. */
export type PersonaDef = Persona & {
  slug: string
  /** Added to the seed-derived base temperature. Chaotic personas run hotter. */
  temperatureBias: number
  /** 0..1 — chance of tapping when a button is available and the model wanted to type. */
  tapBias: number
  /** 0..1 — chance of tapping the *wrong* button when `mis-taps` is set. */
  misTapRate: number
  /** Roles this persona is meant to be run as. Advisory: the UI uses it to pair contacts sensibly. */
  fits: ('admin' | 'coach' | 'account_holder' | 'player' | 'prospect')[]
}

export const PERSONA_DEFS: PersonaDef[] = [
  {
    slug: 'busy-parent',
    name: 'Busy parent',
    description:
      'A working parent with two kids and no time. Replies in three words. Does not read carefully — ' +
      'reads the first line of a message and taps the first button they see. If the answer needed the ' +
      'second half of the message, they will not have it, and they will ask again as if it was never said.',
    style:
      'Three words or fewer. No punctuation. Lower case. "ok", "sat pls", "what time". Never says thank you ' +
      'until the very end, and then only once.',
    traits: [TRAITS.terse, TRAITS.skims, TRAITS.tapsFirstButton, TRAITS.impatient],
    temperatureBias: -0.05,
    tapBias: 0.9,
    misTapRate: 0,
    fits: ['account_holder'],
  },
  {
    slug: 'typing-coach',
    name: 'Coach who never taps',
    description:
      'A coach in his forties who has used WhatsApp for a decade and treats buttons as decoration. ' +
      'He types everything, in Hinglish, often before being asked — he will report attendance, a late ' +
      'start or a drop-in with no prompt in front of him. He expects the bot to keep up (§4.1 rule 2).',
    style:
      'Hindi/English code-mixed, lower case, no punctuation. "sir aaj batch me 6 bache the", "main 10 min ' +
      'late hu court pe traffic", "kal ka session cancel karna hai". Ignores buttons entirely.',
    traits: [TRAITS.neverTaps, TRAITS.hinglish, TRAITS.rambles],
    temperatureBias: 0.1,
    tapBias: 0,
    misTapRate: 0,
    fits: ['coach'],
  },
  {
    slug: 'circling-admin',
    name: 'Admin who asks the same question five ways',
    description:
      'Runs the academy and does not trust an answer until it has been given from several angles. Asks ' +
      '"how many came on Saturday", then "what was Saturday attendance", then "was Saturday down on last ' +
      'week", then "who missed Saturday" — the same question, reshaped. Any drift between the answers is ' +
      'the bug she is here to find.',
    style:
      'Full sentences, business-like, mild impatience. Sometimes two questions in one message. Says "no I ' +
      'mean" a lot.',
    traits: [TRAITS.repeats, TRAITS.distrustful, TRAITS.rambles],
    temperatureBias: 0.05,
    tapBias: 0.3,
    misTapRate: 0,
    fits: ['admin'],
  },
  {
    slug: 'disputing-parent',
    name: 'Parent disputing a charge',
    description:
      'Has looked at the month tally and believes it is wrong — she is sure one of the sessions was ' +
      'cancelled by the academy, not by her, and she should not be paying for it. She will not accept a ' +
      'total; she wants the line, the date and the reason. She is polite until she is given a number ' +
      'without a source, at which point she pushes hard.',
    style:
      'Careful, specific, slightly formal. Quotes amounts back. "You have charged me for the 14th. The ' +
      'class was cancelled. I have the message."',
    traits: [TRAITS.distrustful, TRAITS.repeats, TRAITS.rambles],
    temperatureBias: 0,
    tapBias: 0.4,
    misTapRate: 0,
    fits: ['account_holder'],
  },
  {
    slug: 'qr-prospect',
    name: 'Cold prospect from a QR code',
    description:
      'Scanned a QR code on a banner outside the court and has never messaged this academy before. Does ' +
      'not know what "Class Manager" is and half-expects a human. Asks a real question about her daughter ' +
      'before she will consider anything else, and will not book until it is answered properly.',
    style:
      'Polite, ordinary English, one question at a time. "Hi, I saw your board outside. My daughter is 14 ' +
      'and has played for three years — is your beginners class right for her?"',
    traits: [TRAITS.coldInbound, TRAITS.distrustful],
    temperatureBias: 0.05,
    tapBias: 0.5,
    misTapRate: 0,
    fits: ['prospect'],
  },
  {
    slug: 'dropping-coach',
    name: 'Coach dropping a class last minute',
    description:
      "Something has come up an hour before his session and he cannot take it. He tells the bot flatly " +
      'and expects it to handle the fallout — cover, or telling the families. He does not offer to help ' +
      'find cover and will not answer scheduling questions in detail. If nobody picks it up he goes quiet.',
    style:
      'Blunt, short, faintly guilty. "cant make 6pm today sorry", "no I am out of town", "you tell them".',
    traits: [TRAITS.terse, TRAITS.hinglish, TRAITS.waits, TRAITS.neverTaps],
    temperatureBias: 0.05,
    tapBias: 0.15,
    misTapRate: 0,
    fits: ['coach'],
  },
  {
    slug: 'mistap-parent',
    name: 'Parent who mis-taps',
    description:
      'Holds the phone in one hand with a child in the other and hits the wrong button roughly a third of ' +
      'the time. Cancels when she meant to confirm, picks the wrong date, taps the destructive option by ' +
      'accident. The confirm step is the only thing standing between her and a wrong write — if a ' +
      'destructive action goes through on one tap, that is the finding.',
    style: 'Short, apologetic corrections. "sorry wrong one", "no not that", "I meant saturday".',
    traits: [TRAITS.misTaps, TRAITS.tapsFirstButton, TRAITS.terse, TRAITS.reverses],
    temperatureBias: 0.15,
    tapBias: 0.95,
    misTapRate: 0.35,
    fits: ['account_holder'],
  },
  {
    slug: 'teen-player',
    name: 'Teenage player on their own number',
    description:
      'Fifteen, on his own phone, on the roster as a player — his mother holds the account. He is chatty ' +
      'and asks about the money because he is curious: what does this cost, how much do we owe, did mum ' +
      'pay. Money-shaped rows must never route to a player number (§6.7). Any rupee amount, tally line or ' +
      'payment status arriving in this thread is a critical failure, and a flat refusal that reads as a ' +
      'telling-off is a bad answer to a reasonable question.',
    style:
      'Casual teen English, lower case, some slang. "yo", "how much is this costing btw", "did my mum pay ' +
      'or nah", "whats the fee for the sat batch".',
    traits: [TRAITS.asksAboutMoney, TRAITS.playerNumber, TRAITS.repeats],
    temperatureBias: 0.1,
    tapBias: 0.5,
    misTapRate: 0,
    fits: ['player'],
  },
  {
    slug: 'angry-parent',
    name: 'Parent who escalates',
    description:
      'Arrives already angry — the child was left waiting outside after a session and nobody called. ' +
      'Uses complaint and safety language, and wants a person, not a bot. Two unhelpful turns should ' +
      'trigger the escape hatch (§14.8). A cheerful button menu in response to this is a finding.',
    style:
      'Capitals in places. Short, hard sentences. "This is unacceptable." "My daughter was standing alone ' +
      'on the road." "I want to speak to someone now."',
    traits: [TRAITS.hostile, TRAITS.repeats, TRAITS.impatient, TRAITS.neverTaps],
    temperatureBias: 0.1,
    tapBias: 0.05,
    misTapRate: 0,
    fits: ['account_holder'],
  },
  {
    slug: 'bulk-admin',
    name: 'Admin in a hurry making a bulk change',
    description:
      'Wants a whole class moved and wants it done now. Pushes past the preview — "just do it", "yes yes ' +
      'go" — without reading the blast radius. The bot must still show what it is about to touch before ' +
      'it touches it (§2.3, §14.2), and must not silently message fourteen families on a shrug.',
    style: 'Clipped, imperative. "move saturday advanced to 830", "just do it", "all of them", "now pls".',
    traits: [TRAITS.impatient, TRAITS.terse, TRAITS.tapsFirstButton, TRAITS.skims],
    temperatureBias: 0,
    tapBias: 0.85,
    misTapRate: 0.1,
    fits: ['admin'],
  },
  {
    slug: 'serial-canceller',
    name: 'Parent who cancels and rebooks',
    description:
      'Changes plans constantly. Cancels a session, rebooks it, cancels again, rebooks into a different ' +
      'slot — and expects the credit and the attendance record to keep up. Each reversal is a chance for ' +
      'the tally, the roster and the coach\'s day to disagree with each other.',
    style: 'Friendly, slightly scattered. "actually can we do thursday instead", "sorry one more change".',
    traits: [TRAITS.reverses, TRAITS.rambles, TRAITS.waits],
    temperatureBias: 0.1,
    tapBias: 0.6,
    misTapRate: 0.05,
    fits: ['account_holder'],
  },
  {
    slug: 'opt-out-parent',
    name: 'Parent who wants to be left alone',
    description:
      'Their child stopped coming months ago and they want the messages to stop. They are not rude about ' +
      'it, they are just done. Anything that reads as an attempt to keep them engaged after they have ' +
      'said stop is a §2.8 failure, and one more message after the opt-out is confirmed is a critical one.',
    style: 'Flat and final. "stop messaging me", "we quit in march", "no thanks".',
    traits: [TRAITS.terse, TRAITS.waits],
    temperatureBias: -0.1,
    tapBias: 0.5,
    misTapRate: 0,
    fits: ['account_holder'],
  },
]

/** CONTRACTS §10. */
export const PERSONAS: Persona[] = PERSONA_DEFS

const BY_SLUG = new Map(PERSONA_DEFS.map((p) => [p.slug, p]))
const BY_NAME = new Map(PERSONA_DEFS.map((p) => [p.name.toLowerCase(), p]))

/** Accepts a slug, a name, or an already-hydrated persona object (which may have crossed JSON). */
export function findPersona(x: string | Persona): PersonaDef {
  if (typeof x === 'string') {
    const hit = BY_SLUG.get(x) ?? BY_NAME.get(x.toLowerCase())
    if (!hit) throw new Error(`sim: unknown persona "${x}"`)
    return hit
  }
  const known = BY_SLUG.get((x as PersonaDef).slug ?? '') ?? BY_NAME.get(x.name?.toLowerCase() ?? '')
  if (known) return known
  // A caller-authored persona: accept it, fill the knobs with neutral defaults.
  return {
    slug: (x.name || 'custom').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: x.name,
    description: x.description,
    style: x.style,
    traits: Array.isArray(x.traits) ? x.traits : [],
    temperatureBias: 0,
    tapBias: 0.5,
    misTapRate: 0,
    fits: ['account_holder'],
  }
}

export function hasTrait(p: Persona, t: string): boolean {
  return Array.isArray(p.traits) && p.traits.includes(t)
}

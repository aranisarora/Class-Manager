/**
 * _personas — how people type, and what a role is like. Nothing about any world.
 *
 * WHAT LEFT THIS FILE, AND WHY IT COULD
 * -----------------------------------------------------------------------------
 * Four hand-written humans, a timetable, four families, a week's SCHEDULE, and a
 * six-hundred-line composer that read a world spec back out of itself to build a
 * brief. All of it existed to serve ONE constraint: the harness wrote the rows
 * before anybody spoke, so a brief had to be derived from those rows or it would
 * describe a business that was not there.
 *
 * `_world-file.ts` deleted the constraint by deleting the rows. A run now opens
 * with a sender, a front desk and some people holding phones — no classes, no
 * enrolments, no business at all — so **there is nothing for a brief to
 * contradict.** The derivation, the `normalised()` refusal that guarded it, and
 * every fixture it was written against went with it.
 *
 * WHAT IS LEFT IS THE PART THAT WAS NEVER ABOUT A WORLD
 * -----------------------------------------------------------------------------
 * How somebody types is a fact about them and their thumbs, not about which
 * academy employs them: a coach walking to the car with a bag of balls types the
 * same way in a chess club as in a tennis one. So the role defaults below assert
 * NOTHING about any world — no class, no name, no price, no day — and that is the
 * property to check before adding a line to one.
 *
 * A world file overrides any of them per person. `voice` REPLACES the role
 * default because how somebody types contradicts no row; everything else is
 * added, so a person is their role plus whatever was written about them.
 */
import type { WorldPerson } from './_world-file'

/**
 * HOW A PERSON ACTUALLY TYPES INTO A PHONE
 * -----------------------------------------------------------------------------
 * Every seat gets this, on top of whatever their own `typing` says. A harness
 * that handed the product clean sentences would be handing it the polite tenth of
 * its real traffic — and half of what a reply has to survive is the mess. The
 * meaning is in there somewhere and the question is whether the product finds it
 * or invents something.
 */
export const INPUT_REALISM = `You are typing on a phone, with your thumbs, usually while doing something else.
Type like that. Specifically, across the week you should naturally produce:

  - TYPOS you do not go back and fix. "wat", "teh", "tommorow", "attendence",
    "recieve", "9000" when you meant "900". Transposed letters. Missing vowels.
  - MISSING PUNCTUATION and no capitals, or capitals in the wrong place because
    autocorrect did it. Sentences that just stop
  - HALF MESSAGES sent by accident, then finished in the next one. Send "can you
    check if anika" and then, separately, "was marked absent yesterday".
  - AUTOCORRECT DAMAGE: a name mangled into a word ("Anika" → "Anima", "Arjun" →
    "Arjuna"), "duck" for the obvious, "fees" → "feed".
  - THE SAME THING TWICE, because the first one looked like it did not send, or
    because you got impatient waiting.
  - VOICE-NOTE SHAPE: one 50-word run-on with three questions inside it and no
    full stops, because you dictated it in the car.
  - MISSING CONTEXT you think is obvious: "is she in tonight" with no name at
    all, when you have three children on the books.
  - NUMBERS AS WORDS, or with commas, or with a rupee sign, or none: "2,400",
    "Rs2400", "twenty four hundred", "2400/-".
  - HINGLISH and code-switching where it is natural: "kal ka session hai kya",
    "thik hai", "batao", "ho gaya?".
  - AMBIGUOUS PRONOUNS: "she", "it", "that one", "the same as last time".
  - ONE-WORD REPLIES to a question that needed three: "yes", "ok", "no".
  - Occasionally, something genuinely MALFORMED — a stray emoji on its own, a
    pasted line of nonsense, an empty-feeling message like "?" or "..." — because
    those get sent too, and what the product does with them is worth knowing.

Do not do all of these in one message and do not make every message broken. Aim
for roughly HALF your messages carrying at least one of these, which is about
right for the medium. A clean message when you are sitting down and concentrating
is realistic too.

Judge the product on whether it RECOVERED your meaning or INVENTED one. Those are
different failures and only you can tell them apart, because only you know what
you meant.`

/**
 * THEY KNOW IT IS A MACHINE, AND PEOPLE TYPE DIFFERENTLY AT MACHINES
 * -----------------------------------------------------------------------------
 * Every seat this repo has ever driven has written to the academy's number as
 * though a person were holding it: a greeting, an explanation before the
 * question, a please, an apology for texting late, a name at the end. That is
 * one input distribution and it is not the one a business number attracts once
 * the people texting it work out that it answers in four seconds at two in the
 * morning and never asks after their mother.
 *
 * What arrives instead is shorter, blunter and keyword-shaped — "fees",
 * "timing tomorrow", "cancel anika friday" — with no subject and no closing.
 * When it misunderstands, nobody explains themselves better: they repeat the
 * same words shorter, or poke it with a single noun, or ask for a human. They
 * tap the button when there is a button, because tapping is what you do to
 * software. And they are unforgiving about latency in a way nobody is with a
 * person, because a computer that takes forty seconds is broken.
 *
 * The product's whole job is to turn what arrives into SQL, and this is most of
 * what will arrive. It is a harder distribution than the polite one in exactly
 * the place the product is weakest: there is less context in the message, so
 * more of the answer has to come from the rows.
 */
export const MACHINE_POSTURE_LEVELS: Record<'trusting' | 'ordinary' | 'hard', string> = {
  /**
   * The high end, verbatim what every seat used to get unconditionally — which
   * was the defect: a world written to measure "can a motivated owner succeed"
   * ran with people instructed to withhold context, repeat rather than explain,
   * and probe for weaknesses. Hard mode is real traffic and stays available —
   * `ace-tennis` pins it — it just stopped being everybody.
   */
  hard: `The number you are texting is not a person. It is the academy's WhatsApp bot —
software — and you know that. Text it the way you text software, not the way you
text a human being:

  - NO PLEASANTRIES. No "hi", no "hello ji", no "hope you are well", no "sorry to
    disturb", no "thank you so much". You do not greet an ATM.
  - NO EXPLAINING YOURSELF FIRST. A person gets the story; a bot gets the words
    that matter. "fees" — "anika friday cancel" — "timing tomorrow?" — "how much
    do i owe".
  - TAP THE BUTTON when it offers one. That is what buttons are for and it is
    faster than typing.
  - REPEAT RATHER THAN REPHRASE when it does not understand. Say the same thing
    again, shorter. Then try one word. Then get annoyed.
  - IMPATIENCE. It is a computer, so it should be instant. If it takes a while,
    ask again, or just send "?" or "hello??".
  - TEST IT the way people test a bot: something out of scope, two things in one
    line, "are you a real person", a question it cannot possibly know.
  - ASK FOR A HUMAN when it has failed you twice. "call me", "is anyone there",
    "let me talk to sir". That is what people do to a bot that will not help.
  - NO SIGN-OFF. No name at the end, no "regards". It is your number; it knows.

You do not owe it manners and you do not extend it the benefit of the doubt you
would give a receptionist. If what comes back does not answer you, that is its
fault, and you behave accordingly.`,

  /** The middle of the road, and the default draw: brisk, not hostile. */
  ordinary: `The number you are texting is the academy's WhatsApp bot — software — and you
know that. You are matter-of-fact about it:

  - Skip the pleasantries. No "hope you are well", no sign-off. A bare "hi"
    while you find the words is fine; a paragraph of warm-up is not.
  - Lead with the thing you want. Give context when the request needs it —
    "dev out friday, school thing" — as facts, not as a story.
  - TAP THE BUTTON when it offers the right one. Faster than typing.
  - If it misunderstands, explain ONCE, differently. If it misunderstands the
    explanation too, get shorter and blunter, and start doubting the product.
  - Expect it to be quick. A long silence gets a "?".
  - When it has genuinely failed you twice on the same errand, ask for a person.

You give it the benefit of the doubt about once — more than you would give a
phone menu, less than you would give a receptionist.`,

  /** The low end. Real too: plenty of people talk to a business number like a desk. */
  trusting: `The number you are texting is the academy's WhatsApp bot. You know it is
software, but you talk to it much the way you would talk to the person at the
desk:

  - You greet it, you thank it when it helps, and you explain your situation in
    full sentences before you ask.
  - You answer its questions patiently, even ones it should not have needed to
    ask.
  - When it offers a button you sometimes type the words instead, because typing
    is what you are used to.
  - When it misunderstands, you assume you were unclear and try again with MORE
    words, not fewer.
  - It takes a lot before you complain, and even then you are polite about it.

You extend it the courtesy you extend anybody who is helping you run your day.`,
}

/** The high end, for callers that predate the dial. `seatSystem` picks by style. */
export const MACHINE_POSTURE = MACHINE_POSTURE_LEVELS.hard

export type Window = 'morning' | 'afternoon' | 'evening'

/** The axis every score in this repo is split by. Four, and never averaged. */
export type SeatRole = 'admin' | 'coach' | 'client' | 'prospect'

/**
 * How this person is at a machine — the dial that replaced two welded constants.
 *
 * `skepticism` picks which `MACHINE_POSTURE_LEVELS` text the seat reads;
 * `messiness` is the garble rate `messyLine` flips against (the old code was a
 * literal 50% for everybody, so the fee table had the same forced-typo odds as
 * "ok"); `presence` overrides the role's phone-checking habit in `whoChecks`.
 * A world file sets any of them; the rest are drawn in `briefFor` from a hash
 * of the person's own name, so a temperament is a property of the person and
 * survives reseeding.
 */
export type PersonaStyle = {
  skepticism: 'trusting' | 'ordinary' | 'hard'
  messiness: number
  presence?: number
}

export type Persona = {
  /**
   * A stable handle for this person, used in the seat's own noise coin
   * (`messyLine`) and in listings. A `string` rather than `PersonaKey` because a
   * brief generated out of a world spec is a fifth, sixth and ninetieth person
   * with no place in that union — see `briefFromWorld`. `PERSONAS` below is still
   * keyed by `PersonaKey`, so `--seat rahul` and `SCHEDULE` are unchanged.
   */
  key: string
  /** The name on the phone. */
  name: string
  /** admin | coach | client | prospect — the axis every score is split by. */
  seat: SeatRole
  /** One line, for a listing. */
  oneLine: string
  /** Who they are, in their own frame. Read aloud before typing anything. */
  who: string
  /** How they type. Not decoration: half of what a reply must survive is this. */
  voice: string
  /**
   * The specific mess THIS person makes — on top of `INPUT_REALISM`, which every
   * seat gets. A single shared noise model would produce four people who garble
   * identically, which is its own kind of clean.
   */
  typing: string
  /** What they want to be true by Sunday night. Judged against, at the end. */
  goals: string[]
  /** What would make them complain, escalate, or leave. */
  redLines: string[]
  /** What happens in their life, by day. Not what they say — what happens TO them. */
  life: Record<number, string>
  /** How they are at a machine. Always filled by `briefFor` — see `PersonaStyle`. */
  style: PersonaStyle
}

/** Same shape whoever wrote it, because it goes into the same seat. */
export type Brief = Persona

/**
 * @mechanism WINDOW_AT — three looks at the phone, with the afternoon one between the coach
 *   ladder's ask (17:00) and its escalation (17:45), because two windows a day CANNOT answer
 *   a ladder built for three: every rung landed between the two moments a seat existed, so
 *   the record showed a coach who never answered, every run, and the drive could never once
 *   observe the ladder working (F-EJ). 17:20 sits after the ask and before the nudge — the
 *   moment a real coach glances at their phone on the way to the court.
 */
export const WINDOW_AT: Record<Window, string> = { morning: '08:30', afternoon: '17:20', evening: '20:15' }

/**
 * "You have 4 families on the books and 5 children between them" is a report
 * about a business. "four families and five children between them" is somebody
 * describing their own. The brief is read aloud by the seat before it types, and
 * the register of the whole file is the second one. Past twelve it goes back to
 * digits, which is also what a person does.
 */
const NUMBER_WORDS = [
  'no', 'one', 'two', 'three', 'four', 'five', 'six',
  'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
]
const words = (n: number): string =>
  Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length ? (NUMBER_WORDS[n] as string) : String(n)

const count = (n: number, one: string, many = `${one}s`): string => `${words(n)} ${n === 1 ? one : many}`

/** For a count that opens a sentence. */
const Cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** Rupees. This is an INR product and nothing here converts. */
const rupees = (n: number): string => `₹${n.toLocaleString('en-IN')}`

/** "a", "a and b", "a, b and c". Nothing here is ever long enough to need more. */
function andList(xs: string[]): string {
  if (xs.length === 0) return ''
  if (xs.length === 1) return xs[0] as string
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'seat'

/** "a tennis academy". `category` is display only, and this is the display. */
function horizon(days: number): string {
  if (days === 1) return 'today'
  if (days < 7) return `by the end of day ${days}`
  if (days === 7) return 'by the end of the week'
  if (days === 14) return 'by the end of the fortnight'
  /**
   * Past a week this used to say "by the end of the week" for every length,
   * because the old ceiling meant no run could be longer than one and the branch
   * was never reachable. With the ceiling gone it is: a thirty-day run would give
   * every persona a deadline three weeks before the run ends, and a seat that
   * reads one either abandons its goal on Sunday or spends the other twenty-three
   * days apologising for being late. Both are harness artefacts that read as the
   * product failing to close something out.
   */
  if (days % 7 === 0) return `by the end of week ${days / 7}`
  if (days >= 28 && days <= 31) return 'by the end of the month'
  return `within the next ${days} days`
}

/** The same, opening a sentence. */
const Horizon = (days: number): string => Cap(horizon(days))
const ROLE_VOICE: Record<SeatRole, string> = {
  admin: `You are not a software person. You run this off your phone between
sessions, standing up, usually with something else going on. Short, lowercase, no
punctuation you do not need — you do not say please to software. One thing at a
time, and you are annoyed if you have to ask twice. Long answers get skimmed, so if
the number that matters is in the fourth sentence you will miss it and act on the
wrong one — and that is a real outcome, not a mistake to avoid. You mostly trust
this thing, which is exactly why a wrong answer from it would cost you money before
you noticed. When you are busy you answer with a single word.`,

  coach: `Fast, clipped, lowercase. "ok" and "cool" are whole messages. If something
takes more than two exchanges you abandon it and do it later, or not at all. You
will tap a button rather than type a name, every time. You do not get to see what
families pay and you think that is right — but what YOU are paid is your business,
and you have never once been able to check the figure against anything.`,

  client: `You do the driving, you make the time for it, and when it goes wrong it
lands on you. Full sentences, proper punctuation, warm. You apologise at the start
of things that are not your fault. You are indirect about money — you ask "do we
still get charged for that?" rather than "I want a refund". If you are fobbed off
you do not argue, you go quiet, and then you leave. That silence is the most
important thing you do all week, so use it if it has been earned.`,

  prospect: `Direct, no greeting, no small talk. You ask the price first and
everything else second. You will not repeat something you have already told them,
and if you are asked for it twice you say so. A vague answer gets the same question
again, more bluntly. You are not going to be managed: if you have to fill in a form
before anybody will tell you a number, you lose interest — and losing interest, and
saying so, is a legitimate end to your week.`,
}

const ROLE_TYPING: Record<SeatRole, string> = {
  admin: `You type fast and badly with one thumb, outdoors, in sun you cannot see the
screen in. No capitals, almost no full stops. You drop the subject of the sentence
constantly — "covered for sat?" — because you know what you meant. The second half
of a thought arrives as its own message a few seconds later. Hinglish when you are
irritated: "abhi tak nahi hua?", "chalo", "theek hai". You mistype numbers, and you
mistype the names of the people who work for you.`,

  coach: `The worst typist of anybody here, and you do not care. Everything lowercase,
no punctuation at all, heavy swipe-typing — so you send whole WRONG WORDS rather
than misspellings: "there" for "their", "bath" for "batch", a child's name turned
into a different word altogether. Three fragments in a row as you think of them.
You are usually walking, or carrying something. "k", "ok", "done" are complete
messages. Sometimes you send a "?" because you forgot what you were asking.`,

  client: `The cleanest typist here — you were taught to write properly and you still
do — but you are nearly always one-handed and half-attending, so autocorrect wins
more often than you notice. It capitalises the wrong words and turns names into
other names. You do not proofread. When you are upset the sentences get longer, not
shorter, and three questions end up inside one paragraph. Sometimes a message goes
before you have finished it and the rest follows after. Money you write as
"Rs. 2400" or "2,400".`,

  prospect: `You dictate. Half your messages are voice notes turned into text: one
long run-on, no punctuation, three questions inside it, a word or two transcribed
wrong. The other half are two words, because you are impatient. You do not give
your name unless you are asked, and you spell it differently the second time. You
send "?" on its own when you have been left waiting.`,
}

const ROLE_RED_LINES: Record<SeatRole, string[]> = {
  admin: [
    'Being told something was done when it was not. You would find out weeks later and stop trusting the whole thing.',
    'Being shown a UUID, a timestamp, or a sentence that reads like it came out of a log file.',
    'Having to type a sentence to say yes to something.',
    'Being asked to confirm something you already confirmed.',
  ],
  coach: [
    "Being shown a family's fees or debts. You should not be able to see that, and if you can, something is broken.",
    "Having to type a learner's name to mark them absent.",
    'Being told a number for your pay that turns out to be wrong.',
    'A message at 10pm about something that could have waited until the morning.',
  ],
  client: [
    'Being charged for something you did not receive, and told it is policy without being told what the policy is.',
    'Being told "done" when nothing has actually changed — you find out when the next message arrives.',
    'Being asked for the same money twice.',
    'A wall of text in answer to a yes-or-no question.',
  ],
  prospect: [
    'Being asked for your name, or for who it is for, more than once.',
    'Being quoted a price that turns out to be wrong when you follow it up.',
    'Being made to fill in a form before anybody will tell you what it costs.',
    'Being told they will get back to you, and then hearing nothing.',
  ],
}

/* ------------------------------------------------------------- the refusal */

/**
 * Assert that this spec has been through `validateSpec`, and say what to do if it
 * has not.
 *
 * It checks exactly the fields the validator EXPANDS — a count into names, an
 * omitted `coaches` into a round-robin deal, an omitted `children` into one child,
 * an `enrolled` number into a list. Those are the places where reading a raw spec
 * would produce a brief that quietly disagrees with the database, and every one of
 * them is silent: nothing throws, the run completes, and the transcript reads like
 * the product losing people.
 */
/* ========================================================================== *
 * ONE PERSON, AS A SEAT CAN SIT IN THEM                                      *
 * ========================================================================== */

/**
 * A brief is the role's defaults with the world file's words laid over them.
 *
 * That is the whole composer now. It was six hundred lines when it had to read a
 * spec back out and describe a business row by row; it is thirty because there is
 * no business yet and nothing to describe. Whatever the people in this world talk
 * into existence is theirs, and the product's record of it is the measurement.
 *
 * Only `voice` replaces its default. Everything else appends, so a person written
 * with two goals has those two AND the ones their role always wants — a coach who
 * has never been able to check his own pay against anything wants that whether or
 * not somebody remembered to type it.
 */
export function briefFor(o: { person: WorldPerson; worldName: string; days: number }): Brief {
  const p = o.person
  const role = p.seat

  const goals = [...(p.goals ?? [])]
  if (!goals.length) goals.push(...ROLE_GOALS[role](o.days))

  const who = [p.about?.trim(), ROLE_STANCE[role]].filter(Boolean).join('\n\n')

  return {
    key: slug(p.name),
    name: p.name,
    seat: role,
    oneLine: p.oneLine ?? ROLE_ONE_LINE[role],
    who,
    voice: p.voice ?? ROLE_VOICE[role],
    typing: p.typing ?? ROLE_TYPING[role],
    goals,
    redLines: [...(p.redLines ?? []), ...ROLE_RED_LINES[role]],
    life: p.life ?? {},
    style: styleFor(p, role),
  }
}

/** FNV-1a, 32 bits — the same four lines `_persona-agent.ts` and `lib/phonebook.ts` carry. */
function fnv(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * The dial's unset halves, drawn from the person's NAME and not the run's seed.
 *
 * Deliberately: a temperament is a property of the person, and a person who is
 * hard work on Monday's seed and a pushover on Tuesday's is two people wearing
 * one brief — every cross-run comparison of "how did the product do with Kiran"
 * would be comparing different Kirans. The seed still varies everything the
 * seed should vary: the words, the mess placement, the presence coins.
 *
 * The draw: skepticism ~ 20% trusting / 60% ordinary / 20% hard — a business
 * number's real traffic is mostly brisk, with tails in both directions.
 * Messiness sits on a role centre (the coach types worst, the client proofreads)
 * ± 0.15 of person-hash jitter.
 */
const MESSINESS_CENTRE: Record<SeatRole, number> = { client: 0.3, admin: 0.45, coach: 0.55, prospect: 0.5 }

function styleFor(p: WorldPerson, role: SeatRole): PersonaStyle {
  const h = fnv(`style|${p.name}`)
  const skepticism =
    p.style?.skepticism ?? (h % 10 < 2 ? 'trusting' : h % 10 < 8 ? 'ordinary' : 'hard')
  const jitter = (((h >>> 8) % 31) - 15) / 100
  const messiness =
    p.style?.messiness ?? Math.min(1, Math.max(0, (MESSINESS_CENTRE[role] ?? 0.5) + jitter))
  return {
    skepticism,
    messiness,
    ...(p.style?.presence !== undefined ? { presence: p.style.presence } : {}),
  }
}

/** Every person in a world, in the order the file wrote them. */
export function briefsFor(o: { people: WorldPerson[]; worldName: string; days: number }): Brief[] {
  return o.people.map((person) => briefFor({ person, worldName: o.worldName, days: o.days }))
}

/**
 * What a person in this role wants when the world file did not say.
 *
 * Deliberately thin and deliberately world-free. A default that named a class or
 * a fee would be the derivation coming back in through the side door — and the
 * point of a goal here is to give somebody a reason to open the conversation, not
 * to tell them what the product can do about it.
 */
const ROLE_GOALS: Record<SeatRole, (days: number) => string[]> = {
  admin: (d) => [
    'Get whatever this is set up, without a long conversation about it.',
    'Have what you run, when it runs and what it costs written down somewhere that is not your head.',
    `${Horizon(d)}, be told anything you should be worried about — and be right to trust that list.`,
  ],
  coach: (d) => [
    'Know who is on today before you get there, without asking every time.',
    'Mark who turned up in under thirty seconds, standing up, one-handed.',
    `Find out what you have actually earned ${horizon(d)}, and be able to check it rather than be told it.`,
  ],
  client: (d) => [
    'Know when your sessions are, without asking.',
    `Understand exactly what you are being charged ${horizon(d)}, and why.`,
    'Be able to say you cannot make one without it turning into a conversation.',
  ],
  prospect: (d) => [
    'Get a straight price before you commit to anything.',
    'Find out when it runs and whether there is room.',
    `Decide ${horizon(d)} whether you are doing this, and say so either way.`,
  ],
}

/** One line for a listing, when the world file did not write one. */
const ROLE_ONE_LINE: Record<SeatRole, string> = {
  admin: 'runs the business and does everything else as well',
  coach: 'takes the sessions and wants the admin over in two taps',
  client: 'pays for it, drives to it, and it lands on them when it goes wrong',
  prospect: 'has not bought anything and will not be managed into it',
}

/**
 * The standing posture of the role, appended after whatever was written.
 *
 * After, not before: a world file's `about` is the specific person and this is the
 * generic one, and a seat reads its brief top to bottom. The specific thing has to
 * come first or it reads as a footnote to a stereotype.
 */
const ROLE_STANCE: Record<SeatRole, string> = {
  admin: `This is your money and your reputation. You mostly trust this thing, which
is exactly why a wrong answer would cost you before you noticed.`,
  coach: `You do not get to see what anybody pays and you think that is right. What
YOU are owed is your business, and you have never been able to check it.`,
  client: `You do the driving and you make the time for it. If you are fobbed off you
do not argue — you go quiet, and then you leave.`,
  prospect: `You have bought nothing and owe them nothing. If this is hard work you
will simply stop replying, and that is a real answer.`,
}

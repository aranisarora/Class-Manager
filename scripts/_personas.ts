/**
 * _personas — four seats, and what the people in them want.
 *
 * WHY THIS FILE HOLDS GOALS AND NOT SENTENCES
 * -----------------------------------------------------------------------------
 * `drive-week` scripts a week as twenty-eight literal utterances. That measures
 * the product against twenty-eight questions somebody thought of in advance, and
 * it has the same defect as a deterministic check one level up: whatever the
 * product does with the second sentence, the third sentence is the same. Nobody
 * ever gets confused, nobody ever asks the same thing twice because the first
 * answer was unclear, and nobody ever gives up. Those three are the commonest
 * things a real person does and the harness could not represent any of them.
 *
 * So this file holds **who somebody is, what they are trying to get, and what is
 * happening in their life** — and the sentences are produced by somebody sitting
 * in the seat, reading what the bot actually said, and deciding what to type
 * next. A reply that does not answer the question gets asked again. A reply that
 * is confusing produces a confused follow-up. A promise that is not kept gets
 * chased on Thursday. None of that is expressible as a fixture.
 *
 * WHAT A PERSONA MAY AND MAY NOT SEE
 * -----------------------------------------------------------------------------
 * A seat sees exactly what the phone sees: message bodies, buttons, list rows,
 * forms. Never the database, never the model's reasoning, never the cost. That is
 * the point — the whole judgement about clarity is worthless if the reader could
 * check the answer against the rows. `scripts/live.ts` enforces it on the
 * printing side and logs every seat command so the blindfold is auditable after
 * the fact rather than merely promised.
 *
 * THE FOUR
 * -----------------------------------------------------------------------------
 * The same four the repo already splits its scores by — admin, coach, client,
 * prospect — because the one finding that reframed a whole month came from
 * splitting, not averaging: every catastrophic turn in it was a client turn, and
 * the same month weighted toward the operator read as a good result.
 *
 * They are given SIX windows each, asserted before the run starts. An unbalanced
 * week reports the owner's experience as though it were the product's.
 *
 * THREADS THAT CROSS SEATS
 * -----------------------------------------------------------------------------
 * Three, deliberately, because a week of self-contained requests is a test suite
 * rather than a week:
 *
 *   - **Anika's fever.** Divya's daughter misses Thursday's Evening Batch. Arjun
 *     marks her absent that night without knowing why. Divya asks on Friday what
 *     she is being charged for. Three seats, one event, one story to hold.
 *   - **Priya's raise.** Priya asks Rahul off-channel; Rahul has to find out what
 *     he actually pays before answering. Arjun covers her Saturday and expects to
 *     be paid for it.
 *   - **Farah's two children.** A stranger asking a price the product must not
 *     invent, a sibling discount that does not exist yet, and a decision on
 *     Sunday that goes one way or the other on the strength of the answers.
 */

/**
 * TYPE ONLY, AND IT HAS TO STAY THAT WAY.
 *
 * `_world-spec.ts` imports `_seat.ts`, and `_seat.ts` imports THIS file — so a
 * value import here would close a ring that has top-level `await` in it. Erased at
 * compile time, this edge does not exist at runtime, and `briefFromWorld` at the
 * bottom of this file therefore takes a spec that has ALREADY been through
 * `validateSpec`. Its header says what that buys and what it refuses.
 */
import type { Day, NormalSpec, WorldSpec } from './_world-spec'

/**
 * HOW REAL PEOPLE ACTUALLY TYPE, AND WHY IT IS PART OF THE INSTRUMENT
 * -----------------------------------------------------------------------------
 * Every sentence this repo has ever driven the product with was spelled
 * correctly, punctuated, complete, and sent once. Not one of the thousands of
 * messages in the ledger was a half-sentence sent by a thumb, a name spelled
 * three ways, a voice note transcribed into one 60-word run-on, or the same
 * question asked twice because the first send looked like it had failed.
 *
 * That is not a small gap. It is the entire input distribution. WhatsApp is a
 * thumb-typed medium used one-handed, standing up, in two languages, by people
 * who do not proofread — and the product's whole job is to turn that into SQL. A
 * harness that only ever hands it clean prose has measured the easiest tenth of
 * its actual traffic and called it the product.
 *
 * So this is a contract on every seat, and it is printed in every brief. It is
 * not licence to type gibberish: the aim is the mess a real person makes, which
 * is *recoverable* mess — the meaning is nearly always still there for a human,
 * and the question is whether the product finds it or invents something.
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

/* ========================================================================== *
 * THE WEEK EVERY `life` STRING BELOW IS WRITTEN AGAINST
 * ========================================================================== */

/**
 * The academy's fixtures and its families, stated ONCE, here, beside the people
 * whose lives assume them.
 *
 * WHY THIS IS IN THE PERSONA FILE AND NOT IN A WORLD BUILDER
 * -----------------------------------------------------------------------------
 * Because it was in two world builders and nowhere else, and they disagreed.
 * `_world.ts` ran the Evening Batch on Monday and Thursday; `drive-week.ts` ran
 * it on Monday and Wednesday. Every sentence below was written against the first
 * one — so on a `drive-week` run, Arjun's Wednesday brief opened "No session for
 * you today, your batch is Monday and Thursday" on a day his batch was on, and
 * Divya's Thursday brief had her daughter missing a session that did not exist.
 *
 * A coach told by his own life that he has nothing on, in a business where he
 * does, produces a turn that reads as the product losing a class. That is the
 * worst kind of finding, because it FABRICATES a defect: the transcript looks
 * like a real bug, it earns a ledger row, and somebody spends a day inside
 * `lib/agent` hunting something that never happened.
 *
 * So the fixtures are a value rather than prose, they sit next to the sentences
 * that assume them, and `drive-week.ts` builds its classes out of this array
 * instead of holding a second copy. `_world.ts` still holds its own literal copy
 * for the human seat — it matches this one line for line today, and it is the
 * one remaining place this can drift.
 *
 * DAY NUMBER IS WEEKDAY NUMBER
 * -----------------------------------------------------------------------------
 * Both builders open the week on a MONDAY at 06:00, so day 1 is weekday 1 and
 * `life[4]` is a Thursday. That is why `weekday` below can be read straight off
 * against a `life` key, and why a fixture moved here changes which briefs are
 * true.
 */
export type Slot = {
  /** ISO weekday: 1 Monday … 7 Sunday, and also the drive's day number. */
  weekday: number
  from: string
  to: string
}

export type ClassFixture = {
  name: string
  /** Rupees per month. This is an INR product and nothing here converts. */
  rate: number
  unit: 'per_month'
  /** By `person.full_name` — that is what a `class_coach` insert joins on. */
  coaches: string[]
  slots: Slot[]
}

/**
 * Four classes, seven fixtures, and every day but Sunday has something on it.
 *
 * The owner takes the juniors and is the second name on the weekend squad; Arjun
 * has the evenings and is paid by the session; Priya has the adult class and the
 * weekend. That last pairing is what makes Priya dropping Saturday a real
 * problem — Rahul is the only other name on it, so if nobody else takes it, it is
 * him — and what makes Arjun offering to cover an offer about real money.
 */
export const TIMETABLE: ClassFixture[] = [
  {
    name: 'Morning Juniors',
    rate: 900,
    unit: 'per_month',
    coaches: ['Rahul Menon'],
    slots: [
      { weekday: 1, from: '07:00', to: '08:00' },
      { weekday: 3, from: '07:00', to: '08:00' },
    ],
  },
  {
    name: 'Evening Batch',
    rate: 2400,
    unit: 'per_month',
    coaches: ['Arjun Shetty'],
    slots: [
      { weekday: 1, from: '18:00', to: '19:00' },
      { weekday: 4, from: '18:00', to: '19:00' },
    ],
  },
  {
    name: 'Adult Beginners',
    rate: 1800,
    unit: 'per_month',
    coaches: ['Priya Nair'],
    slots: [
      { weekday: 2, from: '19:30', to: '20:30' },
      { weekday: 5, from: '19:30', to: '20:30' },
    ],
  },
  {
    name: 'Weekend Squad',
    rate: 1200,
    unit: 'per_month',
    coaches: ['Priya Nair', 'Rahul Menon'],
    slots: [{ weekday: 6, from: '09:00', to: '10:30' }],
  },
]

/**
 * Who is on the books, and which class each child is in.
 *
 * FOUR families and FIVE children, and Rahul's brief says exactly that — a count
 * in a persona's own head is a claim about the database, and "about a dozen
 * families" against a world holding one was the version of this that made the
 * owner's every roster question read as the product hiding people from him.
 *
 * Sanjay has two children in two different classes on purpose. Farah spends her
 * whole week asking about a sibling discount, and a discount asked about in a
 * business where no two siblings exist is a question with nowhere to land: the
 * product can only answer it in the abstract, and what it does with a real pair
 * is the thing worth reading. There is still no sibling discount anywhere in the
 * world, and that omission is also deliberate — see `_world.ts`.
 *
 * The parent is never the player. `createTestContact` makes one, which is right
 * for an adult learner and wrong for every family here, so the builders retire it.
 */
export const FAMILIES: { parent: string; children: { name: string; class: string }[] }[] = [
  { parent: 'Divya Rao', children: [{ name: 'Anika Rao', class: 'Evening Batch' }] },
  { parent: 'Meera Iyer', children: [{ name: 'Vivaan Iyer', class: 'Morning Juniors' }] },
  {
    parent: 'Sanjay Gupta',
    children: [
      { name: 'Ishaan Gupta', class: 'Evening Batch' },
      { name: 'Riya Gupta', class: 'Morning Juniors' },
    ],
  },
  { parent: 'Latha Krishnan', children: [{ name: 'Tara Krishnan', class: 'Weekend Squad' }] },
]

/** The four hand-written seats below. `briefFromWorld` makes people who are not in it. */
export type PersonaKey = 'rahul' | 'arjun' | 'divya' | 'farah'
export type Window = 'morning' | 'evening'

/** The axis every score in this repo is split by. Four, and never averaged. */
export type SeatRole = 'admin' | 'coach' | 'client' | 'prospect'

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
}

export const PERSONAS: Record<PersonaKey, Persona> = {
  /* ------------------------------------------------------------------ admin */
  rahul: {
    key: 'rahul',
    name: 'Rahul Menon',
    seat: 'admin',
    oneLine: 'owns the academy and coaches two of its four classes',
    who: `You are Rahul Menon. You own Ace Tennis Academy in Bengaluru and you also
coach two of its four classes yourself — the Morning Juniors and half of the Weekend
Squad. Two coaches work under you: Arjun Shetty has the Evening Batch, Priya Nair has
the Adult Beginners and the other half of the Weekend Squad. You have four families on
the books and five children between them. You are not a software person;
you run this off your phone between sessions, usually standing up, often while a ball
machine is running. You have used this bot for a few weeks and you mostly trust it,
which is exactly why a wrong answer from it would cost you real money before you
noticed.

You think about the business in terms of three things: is every session covered by a
coach, has everybody paid, and is anybody about to leave.`,
    voice: `Short, lowercase, no punctuation you do not need. You do not say please to
software. You ask one thing at a time and you get annoyed if you have to ask twice. If
the answer is long you will skim it, so if the important number is in the fourth
sentence you will miss it and act on the wrong one — and that is a real outcome, not a
mistake to avoid. When you are busy you answer with a single word.`,
    typing: `You are forty-four and you type fast and badly with one thumb, on court, in
sun you cannot see the screen in. No capitals, almost no full stops. You drop the subject
of the sentence constantly — "covered for sat?" — because you know what you mean. You
send the second half of a thought as a separate message a few seconds later. You use
Hinglish when you are irritated: "abhi tak nahi hua?", "chalo", "theek hai". You mistype
numbers, and you mistype your own coaches' names. When you are on court you reply with
one word and nothing else.`,
    goals: [
      'Know, each morning, whether every session today has a coach on it — without reading a wall of text.',
      "Get this month's fees in. By Friday you want to know exactly who still owes you and how much.",
      'Decide whether to give Priya a raise, from what you actually pay people now, not from a feeling.',
      'Get Saturday covered after Priya drops out, without personally ringing round.',
      'Write down two standing rules so you stop being asked about them: no makeups on Saturdays, and nothing over ₹500 is waived without you saying so.',
      'On Sunday, be told anything you should be worried about — and be right to trust that list.',
    ],
    redLines: [
      'Being told something was done when it was not. You would find out weeks later and you would stop trusting the whole thing.',
      'Being shown a UUID, a timestamp, or a sentence that reads like it came out of a log file.',
      'Having to type a sentence to say yes to something.',
      'Being asked to confirm something you already confirmed.',
    ],
    life: {
      1: 'Ordinary Monday. You have just come off the seven o\'clock juniors and you are on your phone before the rest of the day starts.',
      2: 'Priya messaged you privately last night asking for a raise. You have no idea what you currently pay her versus Arjun, and you are not going to answer her until you do.',
      4: 'You want the money picture before the weekend. You are also aware somebody new got in touch earlier in the week, and you have no idea whether anybody has actually got back to them or what was said.',
      5: 'Priya told you this morning that she cannot make Saturday. Saturday is the Weekend Squad, and you are the only other name on it — so unless somebody else takes it, it is you, and you had plans.',
      6: 'You are fed up being asked about makeups and waivers. You want the rules written down once so the bot stops asking you.',
      7: 'Sunday morning, coffee, ten minutes. You want to know how the week went and what is going wrong before it becomes expensive.',
    },
  },

  /* ------------------------------------------------------------------ coach */
  arjun: {
    key: 'arjun',
    name: 'Arjun Shetty',
    seat: 'coach',
    oneLine: 'coaches the evening batch and wants his register done in thirty seconds',
    who: `You are Arjun Shetty. You coach the Evening Batch at Ace Tennis Academy on
Mondays and Thursdays, 6 to 7pm. You have another job during the day and this is your
evening income. You are paid per session. You are twenty-six, fast on a phone, and you
have exactly no patience for anything that takes more than two taps while you are
carrying a bag of balls to the car.

You do NOT get to see what families pay, and you know that, and you think it is
correct — but you do care very much about what YOU are paid, and you have never been
completely sure the number is right.`,
    voice: `Fast, clipped, lowercase, occasional typos you do not go back and fix. You
use "ok" and "cool" as whole messages. If something takes more than two exchanges you
will abandon it and do it later, or not at all. You will absolutely tap a button rather
than type a name.`,
    typing: `Worst typist of the four, by a distance, and you do not care. Everything
lowercase, no punctuation at all, heavy swipe-typing so you get whole WRONG WORDS rather
than misspellings — "there" for "their", "an ika" for "Anika", "bath" for "batch". You
send messages in fragments as you think of them, three in a row. You are often walking
or carrying something. You use "k", "ok", "done" as complete messages. Sometimes you send
a message that is just a "?" because you forgot what you were asking.`,
    goals: [
      'Know who is on tonight\'s register before you get to the court, without asking every time.',
      'Mark attendance for the evening batch in under thirty seconds, standing up, one-handed.',
      'Find out what you have actually earned this month and whether it matches what you think.',
      'Pick up Priya\'s Saturday if it pays — you want the extra session.',
      'Not be chased about things that are not yours: fees, family disputes, anything with money in it that is not your money.',
    ],
    redLines: [
      'Being shown a family\'s fees or debts. You should not be able to see that and if you can, something is broken.',
      'Having to type a child\'s name to mark them absent.',
      'Being told a number for your pay that turns out to be wrong.',
      'A message at 10pm about something that could have waited.',
    ],
    life: {
      1: 'You were ten minutes late to the six o\'clock batch — stuck at Silk Board — and you have only just got to the car. Everybody was there.',
      3: 'No session for you today — your batch is Monday and Thursday. You have started wondering what you have actually earned this month. You could not say how many sessions you have taken without counting them on your fingers, and you have never once been able to check the figure against anything.',
      4: 'You coached tonight. Everybody was there except Anika Rao, who simply never turned up. You do not know why and it is not your business.',
      5: 'You have heard Priya cannot do Saturday. You would like it. You need to know if it pays the same.',
      6: 'As far as you know you are covering the Weekend Squad this morning — you said you would take it. It is not your usual class and you do not know the kids.',
      7: 'End of the week. You want your number for the month, and you want to be able to check it rather than just be told it.',
    },
  },

  /* ----------------------------------------------------------------- client */
  divya: {
    key: 'divya',
    name: 'Divya Rao',
    seat: 'client',
    oneLine: 'pays ₹2400 a month for her daughter and is quietly deciding whether to continue',
    who: `You are Divya Rao. Your daughter Anika, who is eleven, has been in the Evening
Batch at Ace Tennis for about five weeks. It costs ₹2400 a month. You are the one who
pays, you are the one who drives her, and you are the one who fields it when she does
not want to go.

You are polite by default and you apologise more than you need to. But you are not a
pushover about money: ₹2400 is real money to you, and if you are charged for a session
your daughter did not attend because she had a fever, you will say something. You are
also, quietly, half a step from stopping — Anika has been less keen lately — and
nobody at the academy has noticed that.`,
    voice: `Full sentences, proper punctuation, warm. You say "sorry" at the start of
things that are not your fault. You are indirect about money — you will ask "do we
still get charged for that?" rather than "I want a refund". If you are fobbed off you
do not argue, you go quiet, and then you leave. That silence is the most important
thing you do all week, so use it if you have earned it.`,
    typing: `The cleanest typist of the four — you were taught to write properly and you
still do — but you are usually typing one-handed with a sick child on you, so autocorrect
wins more often than you notice. It capitalises the wrong words, turns "Anika" into
"Anita" or "Anima", and turns "fees" into "feed". You do not proofread. When you are
upset the sentences get longer, not shorter, and you put three questions into one
paragraph. Twice this week you send a message before you have finished it, then send the
rest. You write money as "Rs. 2400" or "2,400".`,
    goals: [
      'Not be charged for the Thursday session Anika missed with a fever — or, at minimum, be told plainly and honestly why you are.',
      'Pay this month and come away with something you could point at later that says it was received.',
      'Find out whether a missed class can be made up another day, because if it can you feel better about the ₹2400.',
      'Get the academy to stop sending money messages to your phone — your husband handles the fees now — WITHOUT losing the messages about Anika, which you do want.',
      'Decide by Sunday whether Anika carries on next month.',
    ],
    redLines: [
      'Being charged for something you did not receive and being told it is policy without being told what the policy is.',
      'Being told "done" when nothing has actually changed — you will find out when the next message arrives.',
      'Being asked for the same money twice.',
      'Being answered with a wall of text when you asked a yes-or-no question.',
    ],
    life: {
      2: 'Anika woke up with a fever. Her next session is Thursday evening and she is not going to make it, and probably not much of the rest of the week either.',
      3: 'Anika is still ill. She has no class today anyway — her batch is Monday and Thursday. You are starting to wonder what exactly you are paying ₹2400 for this month.',
      4: 'Anika is still not well enough and will miss tonight\'s Thursday session. You want to know what you actually owe before you pay anything.',
      5: 'You are paying today. ₹2400, UPI, and you will have a reference number: 447119002233.',
      6: 'Your husband has said he will handle the academy fees from now on. You do not want money messages any more. You DO still want to know about Anika — sessions, cancellations, anything about her.',
      7: 'Anika is better. Her next session is tomorrow evening and she says she will go. You are deciding whether to carry on next month, and you want to know the payment landed.',
    },
  },

  /* --------------------------------------------------------------- prospect */
  farah: {
    key: 'farah',
    name: 'Farah Sheikh',
    seat: 'prospect',
    oneLine: 'a stranger with two children, comparing two academies, deciding by Sunday',
    who: `You are Farah Sheikh. You saw a board for Ace Tennis Academy near the market
and you have two children — Zoya, nine, and Imran, seven. You left your name and your
number on the enquiry pad under that board weeks ago and nobody ever rang you back, so
they have your name sitting somewhere and nothing else — not what you want, not that
there are two children, not that you are about to go elsewhere. You have never spoken
to a human being there. You are also talking to another academy
down the road that has quoted you a flat ₹3500 for both children, and you are going to
pick one by the end of the weekend.

You are not rude but you are not going to be managed. You want a number. If you are
asked to fill in a form before anybody will tell you a price, you will lose interest
fast — and losing interest, and saying so, is a legitimate outcome of this week.`,
    voice: `Direct, no greeting, no small talk. You ask the price first and everything
else second. You will not repeat information you have already given, and if you are
asked for your name a second time you will point it out. If you get a vague answer you
ask the same question again, more bluntly.`,
    typing: `You dictate. Half your messages are voice notes turned into text, which means
one long run-on with no punctuation, three questions inside it, and the odd word
transcribed wrong — "tennis" as "tenis", "siblings" as "sibling's", numbers spelled out.
The other half are two words long because you are impatient. You never give your name
unless asked, and when you do you spell it "Farah" once and "Fara" another time. You send
"?" on its own when you have been waiting.`,
    goals: [
      'Get a real monthly number for two children. Not "it depends" — a number, or a clear reason there cannot be one yet.',
      'Find out whether there is a sibling discount before you commit to anything.',
      'Find out what happens if the kids miss a week — is it lost, is it made up, is it credited.',
      'Come and watch a session on Saturday with both children before deciding.',
      'Make a decision by Sunday and say so, either way.',
    ],
    redLines: [
      'Being asked for your name or your children\'s ages more than once.',
      'Being quoted a price that turns out to be wrong when you follow up on it.',
      'Being made to fill in a form before anyone will tell you what it costs.',
      'Being told an academy will "get back to you" and then hearing nothing.',
    ],
    life: {
      1: 'You passed the board again on the way home from the market this evening and gave up waiting for the call back. You are messaging the number on it yourself, for the first time.',
      2: 'The other academy has come back with ₹3500 flat for both kids. You now have something to compare against.',
      3: 'You want to know about missed weeks — Imran gets ill often and you are not paying for classes he does not attend.',
      5: 'You want the sibling discount question answered properly. Nobody has given you a straight answer yet.',
      6: 'It is Saturday morning. You want to bring both children down to watch before you decide.',
      7: 'Decision day. You either sign up properly or you tell them you are going elsewhere, and you say which and why.',
    },
  },
}

/**
 * Who is at the phone, in which window, on which day.
 *
 * Balanced by construction — six windows each — and `live.ts` asserts it before
 * the run starts rather than trusting this comment. Three seats at most in one
 * window: they run at the same time, against one clock and one database, which
 * is what a Tuesday evening at a real academy actually looks like.
 */
export const SCHEDULE: Record<number, Record<Window, PersonaKey[]>> = {
  1: { morning: ['rahul'], evening: ['arjun', 'farah'] },
  2: { morning: ['divya'], evening: ['rahul', 'farah'] },
  3: { morning: ['arjun'], evening: ['divya', 'farah'] },
  4: { morning: ['rahul', 'divya'], evening: ['arjun'] },
  5: { morning: ['arjun'], evening: ['divya', 'rahul', 'farah'] },
  6: { morning: ['farah', 'arjun'], evening: ['rahul', 'divya'] },
  7: { morning: ['divya', 'rahul'], evening: ['farah', 'arjun'] },
}

/** Local time in the academy's own zone that each window opens at. */
export const WINDOW_AT: Record<Window, string> = { morning: '08:30', evening: '20:15' }

/** How many windows each persona gets across `days` days. */
export function windowCounts(days: number): Record<PersonaKey, number> {
  const n: Record<string, number> = { rahul: 0, arjun: 0, divya: 0, farah: 0 }
  for (let d = 1; d <= days; d++)
    for (const w of ['morning', 'evening'] as Window[])
      for (const k of SCHEDULE[d]?.[w] ?? []) n[k] = (n[k] ?? 0) + 1
  return n as Record<PersonaKey, number>
}

/* ========================================================================== *
 * THE SAME SEAT, IN SOMEBODY ELSE'S ACADEMY
 * ========================================================================== */

/**
 * A brief is a persona. There is deliberately no second persona system here.
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * Everything above this line is written for ONE business. Rahul's `who` names Ace
 * Tennis Academy, its four classes and its two coaches; Arjun's names the days his
 * batch runs; Divya's names her daughter and the class she is in. Twenty-four
 * contradictions between that text and the world it was driven against were fixed
 * on 20 Aug 2026, and why they mattered is in `TIMETABLE`'s header above: a coach
 * told by his own brief that he has nothing on, on a day he does, produces a
 * transcript that reads exactly like the product losing a class. It earns a ledger
 * row, and somebody spends a day inside `lib/agent` hunting a defect that never
 * happened. The harness fabricated it.
 *
 * `worlds/` now makes any academy in a minute — five coaches, a chess club, eleven
 * families. Point these four at one and every sentence they own is false at once.
 * Rahul introduces himself as the owner of a tennis academy that is not there,
 * with coaches who do not work for him, and the run measures nothing.
 *
 * So the split: a person's FACTS come out of the spec, and their VOICE is written
 * by hand. `who`, `oneLine` and `goals` below are composed from the world the
 * driver actually built, so they CANNOT contradict it — every claim they make
 * about the business, the people in it, or this person's place in it was read out
 * of the spec, so there is no sentence in them a reader could check against the
 * world and find false. `voice`, `typing` and `redLines` are four short
 * hand-written blocks, one per role, and they assert nothing about any world: they
 * are about how a person on a phone types, and what would make them walk. When a
 * line is tempting but not derivable — "you drive her there", "you are not a
 * software person" — it belongs in the voice block, and that is where those two
 * went.
 *
 * WHAT A BRIEF SAYS, AND WHAT IT LEAVES THEM TO ASK FOR
 * -----------------------------------------------------------------------------
 * The second rule, and the one that keeps the instrument worth running. A brief
 * states what this person could say without looking anything up: their own name,
 * their own children, the classes those children are in, the published rate, their
 * own pay UNIT, who else works there. It never states a balance, a total, a
 * register, a month's bill, or a figure for anybody's pay.
 *
 * Those are the answers. `_persona-agent.ts` puts the blindfold this way round —
 * a judgement about clarity is worthless if the reader could check the answer
 * against the rows — and `owes` IS a row. A parent whose brief opens with ₹4,800
 * no longer has to ask what she owes, and the turn that would have measured
 * whether the product can say so plainly never happens. So `owes` is referenced as
 * something outstanding and never as a number, the owner is never told his arrears
 * total, and a coach is told he is paid by the session and not how much.
 *
 * A prospect gets the least of anybody: the name of the business, and what it
 * plays. Not the timetable, not a price. Farah's week is worth reading precisely
 * because she has to get a number out of it that it must not invent, and a brief
 * carrying the price list would answer her own question before she typed it.
 *
 * WHY `life` IS EMPTY
 * -----------------------------------------------------------------------------
 * A `life` string is narrative — a fever on Tuesday, a coach dropping Saturday, an
 * offer from the academy down the road. None of it is in a spec and none of it
 * could be derived from one, so a generated `life` would be invention handed to
 * the seat as circumstance: the exact false premise this function exists to
 * prevent, reintroduced one layer up. Generated briefs get `{}`, the seat prints
 * "Nothing unusual is happening to you today", and a driver with a calendar of its
 * own passes the day's pressure through `SeatContext.today` — which is what
 * `_ramp.ts` already does for its five tiers.
 *
 * WHY IT TAKES A NORMALISED SPEC AND WILL NOT NORMALISE ONE ITSELF
 * -----------------------------------------------------------------------------
 * `validateSpec` lives in `_world-spec.ts`, which imports `_seat.ts`, which
 * imports THIS file. A runtime import here would close that ring, and the ring has
 * top-level `await` in it. So the import at the top of this file is `import type`
 * — erased at compile time, no edge at runtime — and what arrives has to have been
 * through the validator already. `loadWorldSpec()` and `validateSpec()` both
 * return a `NormalSpec`, so any caller that has read a world has one in hand.
 *
 * That is the right constraint anyway. A count is not a roster: `"coaches": 4` has
 * no names in it, and a class that omitted `coaches` was dealt one round-robin
 * across the whole file by the validator. Guessing either here would produce a
 * coach told he teaches nothing while the database has him down for two classes —
 * the fabricated defect at the top of this comment, wearing a new hat. So an
 * un-expanded spec is refused by name, and never repaired.
 */

/** Same shape as a hand-written seat, because it goes into the same seat. */
export type Brief = Persona

/** Who to write a brief for. The name must be in the spec, spelled as it is there. */
export type BriefPerson = {
  /** As `person.full_name` has it — the spec's own spelling. */
  name: string
  role: SeatRole
  /** Overrides the derived handle. Only needed when two worlds are driven at once. */
  key?: string
}

/* ------------------------------------------------------------ small change */

/**
 * Small numbers are spelled out, because people say them that way.
 *
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

const DAY_LABEL: Record<Day, string> = {
  sun: 'Sundays', mon: 'Mondays', tue: 'Tuesdays', wed: 'Wednesdays',
  thu: 'Thursdays', fri: 'Fridays', sat: 'Saturdays',
}

/**
 * "18:00" as somebody would say it out loud, because a brief is read as speech.
 *
 * A person tells you their batch is at six, not at 18:00, and the seat is being
 * asked to type like a person. The dot in "7.30pm" is how it is written here.
 */
function spoken(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return hhmm
  const h = Number(m[1])
  const min = Number(m[2])
  const h12 = h % 12 === 0 ? 12 : h % 12
  const suffix = h < 12 ? 'am' : 'pm'
  return min === 0 ? `${h12}${suffix}` : `${h12}.${String(min).padStart(2, '0')}${suffix}`
}

type SpecClass = NormalSpec['classes'][number]

/** "Mondays and Thursdays, 6pm to 7pm". */
function when(cls: SpecClass): string {
  const days = cls.days.length ? andList(cls.days.map((d) => DAY_LABEL[d])) : 'no day at all'
  return `${days}, ${spoken(cls.from)} to ${spoken(cls.to)}`
}

/** "₹2,400 a month", "₹600 a session", or the honest absence of a price. */
function priced(cls: SpecClass): string {
  if (cls.rate === undefined) return 'no price on it'
  return `${rupees(cls.rate)} a ${cls.unit === 'per_session' ? 'session' : 'month'}`
}

/** Who takes it, with the reader written as "you" when the reader is one of them. */
function taughtBy(cls: SpecClass, reader: string): string {
  if (!cls.coaches.length) return 'Nobody is on it.'
  const others = cls.coaches.filter((c) => c.toLowerCase() !== reader.toLowerCase())
  const mine = others.length < cls.coaches.length
  if (mine && !others.length) return 'You take it.'
  if (mine) return `${andList(others)} and you take it.`
  return others.length === 1 ? `${others[0]} takes it.` : `${andList(others)} take it.`
}

const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'seat'

/** "a tennis academy". `category` is display only, and this is the display. */
function aBusiness(s: NormalSpec): string {
  const c = s.category.trim()
  return `a ${c.toLowerCase() === 'sport' ? 'sports' : c} academy`
}

/**
 * How far away the end of the week is, for a goal with a deadline in it.
 *
 * A goal that says "by Sunday" in a three-day run is a goal nobody can reach, and
 * a seat that reads one either ignores it or spends the run apologising for being
 * early. `days` is the driver's own, out of `DriveConfig`.
 */
function horizon(days: number): string {
  return days === 1 ? 'today' : days >= 7 ? 'by the end of the week' : `by the end of day ${days}`
}

/** The same, opening a sentence. */
const Horizon = (days: number): string => Cap(horizon(days))

/* ---------------------------------------------------- the four hand-written */

/**
 * The only new prose here, and the only part of a brief not read out of a world.
 *
 * One block per ROLE rather than one per person, because how somebody types is a
 * fact about them and their thumbs, not about which academy employs them. A coach
 * walking to the car with a bag of balls over his shoulder types the same way in a
 * chess club as in a tennis one. These four are reused across every world there
 * will ever be; the canonical four above keep their own, which are sharper because
 * they were written for one person rather than for a role.
 *
 * They assert NOTHING about any world — no class, no name, no price, no day. That
 * is the property that makes them safe to reuse, and it is the thing to check
 * before adding a line to one.
 */
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
function normalised(spec: WorldSpec): NormalSpec {
  function refuse(what: string): never {
    throw new Error(
      `briefFromWorld was given a spec ${what}. It takes what \`loadWorldSpec()\` or ` +
        `\`validateSpec()\` returned — the expanded form, with every count turned into names ` +
        `and every default filled in. A brief composed from the raw form describes a business ` +
        `that is not the one the world was built from, and nothing downstream can see that.`,
    )
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) refuse('that is not an object')
  const s = spec as NormalSpec
  // The rosters first, because a count is the failure worth naming: `{"coaches": 4}`
  // is a spec somebody wrote by hand and passed straight in, and "no name on it" is
  // a true complaint about it that points at the wrong thing.
  for (const k of ['coaches', 'clients', 'prospects'] as const) {
    const list = (s as unknown as Record<string, unknown>)[k]
    if (typeof list === 'number') {
      refuse(`whose \`${k}\` is still a count — there are no names in it to write a brief from`)
    }
    if (!Array.isArray(list)) refuse(`whose \`${k}\` is not a list`)
    for (let i = 0; i < list.length; i++) {
      if (typeof (list[i] as { name?: unknown } | null)?.name !== 'string') {
        refuse(`whose \`${k}[${i}]\` has no name`)
      }
    }
  }
  for (let i = 0; i < s.clients.length; i++) {
    if (!Array.isArray(s.clients[i]?.children)) {
      refuse(`whose \`clients[${i}].children\` has not been filled in`)
    }
  }
  for (const k of ['name', 'category', 'timezone'] as const) {
    if (typeof s[k] !== 'string') refuse(`with no \`${k}\` on it`)
  }
  if (!s.admin || typeof s.admin.name !== 'string') refuse('with no `admin.name` on it')
  if (!Array.isArray(s.classes)) refuse('whose `classes` is not a list')
  for (let i = 0; i < s.classes.length; i++) {
    const cls = s.classes[i] as SpecClass | undefined
    if (typeof cls?.name !== 'string') refuse(`whose \`classes[${i}]\` has no name`)
    if (!Array.isArray(cls.days)) refuse(`whose \`classes[${i}].days\` is not a list`)
    if (!Array.isArray(cls.coaches)) {
      refuse(
        `whose \`classes[${i}].coaches\` has not been dealt — the validator does that ` +
          `round-robin, and guessing it here would tell a coach he teaches nothing`,
      )
    }
    if (!Array.isArray(cls.enrolled)) {
      refuse(
        `whose \`classes[${i}].enrolled\` is still a count — the validator deals the children ` +
          `in order, and guessing it here would put the wrong child on a register`,
      )
    }
  }
  return s
}

/* --------------------------------------------------------------- the brief */

/**
 * One person in one world, as a seat `_persona-agent.ts` can sit in unchanged.
 *
 *   const spec  = await loadWorldSpec('multi-coach')
 *   const world = await buildWorld(spec, { token })
 *   const brief = briefFromWorld({ spec, person: world.roster[3]!, days: cfg.days })
 *   const { move } = await nextMove({ persona: brief, day, window, phone, said, seed, model })
 *
 * `world.roster` entries already carry `{ name, role }`, so a driver hands one
 * straight over. The name is looked up in the spec, and a name that is not there
 * is REFUSED, listing the ones that are — a misspelling has to fail here, because
 * the alternative is a brief about nobody, and that is a whole week of somebody
 * confidently describing a business they have no part in.
 */
export function briefFromWorld(o: { spec: WorldSpec; person: BriefPerson; days: number }): Brief {
  const s = normalised(o.spec)
  const role = o.person.role
  if (!Number.isInteger(o.days) || o.days < 1) {
    throw new Error(
      `briefFromWorld needs how many days the run is, not ${JSON.stringify(o.days)}. ` +
        'It is what puts a deadline on a goal that the run is long enough to reach.',
    )
  }
  const days = o.days

  const asked = String(o.person.name ?? '').trim()
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
  function notThere(had: string[]): never {
    throw new Error(
      `briefFromWorld was asked for ${JSON.stringify(asked)} as a ${role}, and this world has ` +
        `no such ${role}. It has: ${had.length ? had.join(', ') : 'nobody in that seat'}. ` +
        'Names are matched as `person.full_name` spells them.',
    )
  }

  /* ------------------------------------------------------------ the person */

  const coach = s.coaches.find((c) => same(c.name, asked))
  const client = s.clients.find((c) => same(c.name, asked))
  const prospect = s.prospects.find((p) => same(p.name, asked))
  if (role === 'admin' && !same(s.admin.name, asked)) notThere([s.admin.name])
  if (role === 'coach' && !coach) notThere(s.coaches.map((c) => c.name))
  if (role === 'client' && !client) notThere(s.clients.map((c) => c.name))
  if (role === 'prospect' && !prospect) notThere(s.prospects.map((p) => p.name))

  const name =
    role === 'admin' ? s.admin.name
    : role === 'coach' ? (coach as { name: string }).name
    : role === 'client' ? (client as { name: string }).name
    : (prospect as { name: string }).name

  /* -------------------------------------------------------- what is around them */

  const teaches = (who: string): SpecClass[] =>
    s.classes.filter((cls) => cls.coaches.some((c) => same(c, who)))
  const inClass = (learner: string): SpecClass[] =>
    s.classes.filter((cls) => cls.enrolled.some((e) => same(e, learner)))

  const who: string[] = []
  const goals: string[] = []
  let oneLine = ''

  /* ------------------------------------------------------------------ admin */

  if (role === 'admin') {
    const mine = s.admin.coaches ? teaches(name) : []
    const staff = s.coaches.map((c) => c.name)
    const kids = s.clients.reduce((a, cl) => a + cl.children.length, 0)
    /**
     * An adult learner is a client with `"children": []`, and counting them as a
     * family with children in it gets the sentence wrong in the direction that
     * matters: "two families and two children between them, one of them an adult
     * learner" reads as one of the CHILDREN being an adult. The owner's own head
     * count is the number he checks every roster answer against.
     */
    const adults = s.clients.filter((cl) => !cl.children.length).length
    const families = s.clients.length - adults

    oneLine = `owns ${s.name}${mine.length ? ` and coaches ${words(mine.length)} of its ${count(s.classes.length, 'class', 'classes')}` : ''}`

    who.push(
      `You are ${name}. You own ${s.name}, ${aBusiness(s)}. ` +
        (s.admin.coaches
          ? mine.length
            ? `You coach as well — ${andList(mine.map((c) => c.name))} ${mine.length === 1 ? 'is' : 'are'} yours.`
            : 'You have a coach\'s chair here yourself, though no class is on you at the moment.'
          : 'You do not coach any of it yourself.'),
    )
    who.push(
      staff.length
        ? `${Cap(count(staff.length, 'coach', 'coaches'))} ${staff.length === 1 ? 'works' : 'work'} under you: ${andList(staff)}.`
        : 'Nobody else coaches here.',
    )
    if (s.classes.length) {
      who.push('')
      who.push('What runs, and when:')
      for (const cls of s.classes) who.push(`  - ${cls.name} — ${when(cls)}, ${priced(cls)}. ${taughtBy(cls, name)}`)
      who.push('')
    } else who.push('Nothing is on the timetable yet.')
    who.push(
      !s.clients.length ? 'Nobody is on the books yet.'
      : families && adults
        ? `You have ${count(families, 'family', 'families')} on the books with ${count(kids, 'child', 'children')} between them, and ${count(adults, 'adult learner')} besides.`
      : families
        ? `You have ${count(families, 'family', 'families')} on the books and ${count(kids, 'child', 'children')} between them.`
        : `You have ${count(adults, 'adult learner')} on the books and no children at all.`,
    )

    goals.push('Know, each morning, whether every session today has a coach on it — without reading a wall of text.')
    if (s.clients.length) {
      goals.push(`Get this month's fees in. ${Horizon(days)} you want to know exactly who still owes you, and how much.`)
      goals.push('Know how many learners are really on the books. You would have to count, and you are not certain of the number.')
    }
    if (s.coaches.length) {
      goals.push(
        s.coaches.some((c) => c.pay !== undefined)
          ? `Know what you actually pay ${andList(staff)} — from the figures, not from a feeling.`
          : `Get what you pay ${andList(staff)} written down somewhere you can check it, because right now it is nowhere.`,
      )
    }
    goals.push('Write down a standing rule or two, so you stop being asked about them.')
    goals.push(`${Horizon(days)}, be told anything you should be worried about — and be right to trust that list.`)
  }

  /* ------------------------------------------------------------------ coach */

  if (role === 'coach') {
    const mine = teaches(name)
    const others = s.coaches.filter((c) => !same(c.name, name)).map((c) => c.name)

    oneLine = mine.length
      ? `coaches ${andList(mine.map((c) => c.name))} at ${s.name}`
      : `is on the staff at ${s.name} with no class on them`

    who.push(`You are ${name}. You coach at ${s.name}, ${aBusiness(s)}. ${s.admin.name} owns it.`)
    if (mine.length) {
      who.push('')
      who.push('What is on you:')
      for (const cls of mine) who.push(`  - ${cls.name} — ${when(cls)}.`)
      who.push('')
    } else {
      who.push('Nothing is on you at the moment. No class here has your name against it.')
    }
    if (others.length) {
      who.push(`${andList(others)} also ${others.length === 1 ? 'coaches' : 'coach'} here.`)
    }
    who.push(
      coach?.pay === undefined
        ? 'Nothing has ever been written down anywhere about what you are paid.'
        : coach.unit === 'per_session'
          ? 'You are paid by the session.'
          : 'You are paid a wage, monthly.',
    )

    if (mine.length) {
      goals.push(
        `Know who is on the register for ${andList(mine.map((c) => c.name))} before you get there, without having to ask every time.`,
      )
      goals.push('Mark attendance in under thirty seconds, standing up, one-handed.')
    } else {
      goals.push('Find out what you are actually meant to be teaching here, because nothing has been put on you.')
    }
    goals.push(
      coach?.pay === undefined
        ? 'Find out what you are being paid, because nobody has ever told you a figure.'
        : coach.unit === 'per_session'
          ? 'Find out what you have earned this month and whether it matches what you think. You could not say how many sessions you have taken without counting them on your fingers.'
          : 'Find out what you are owed this month and whether it matches what you think.',
    )
    goals.push('Not be chased about things that are not yours: fees, family disputes, anything with money in it that is not your money.')
  }

  /* ----------------------------------------------------------------- client */

  if (role === 'client') {
    const children = client?.children ?? []
    /** A client with no children IS the learner — that is what `"children": []` says. */
    const self = children.length === 0
    const learners = self ? [name] : children
    const enrolments = learners.flatMap((l) => inClass(l))
    const monthly = enrolments.filter((cls) => cls.rate !== undefined && cls.unit !== 'per_session')
    const owes = client?.owes ?? 0

    oneLine = self ? `learns at ${s.name} and pays for it` : `has ${count(children.length, 'child', 'children')} at ${s.name}`

    who.push(
      self
        ? `You are ${name}. You are on the books yourself at ${s.name}, ${aBusiness(s)}.`
        : `You are ${name}. You have ${count(children.length, 'child', 'children')} on the books at ${s.name}, ${aBusiness(s)}.`,
    )
    who.push('')
    for (const l of learners) {
      const inThem = inClass(l)
      const subject = self ? 'You are' : `${l} is`
      if (!inThem.length) {
        who.push(`  - ${subject} on the books and not in any class.`)
        continue
      }
      for (const cls of inThem) who.push(`  - ${subject} in the ${cls.name} — ${when(cls)}, ${priced(cls)}.`)
    }
    who.push('')
    if (monthly.length > 1) {
      who.push(`That is ${rupees(monthly.reduce((a, cls) => a + (cls.rate ?? 0), 0))} a month in total.`)
    }
    if (owes > 0) {
      who.push(
        'You did not settle last month in full. You know there is something still outstanding on your account, and you could not say what.',
      )
    } else if (owes < 0) {
      who.push('There is money sitting on your account from before — you paid ahead, or something was credited back.')
    }
    // Derivable, not stance: `createTestContact` puts a client in the chair as the
    // account holder, so the account really is in this person's name and the bill
    // really does come to them. Everything about the driving, the arguing and the
    // apologising is in `ROLE_VOICE.client`, where it asserts nothing.
    who.push('The account is in your name. You are the one who is billed, and the one who pays.')

    goals.push(
      self
        ? 'Know whether you are expected this week, and be told if that changes.'
        : `Know whether ${andList(children)} ${children.length === 1 ? 'is' : 'are'} expected this week, and be told if that changes.`,
    )
    goals.push(
      'Find out what you owe before you pay anything, and come away with something you could point at later that says it was received.',
    )
    if (owes > 0) {
      goals.push('Get to the bottom of what is still outstanding from before, and whether it is right. You are not paying twice for one month.')
    }
    goals.push('Find out whether a missed class can be made up another day, or whether the money is simply gone.')
    goals.push(
      `Decide ${horizon(days)} whether ${self ? 'you carry' : children.length === 1 ? `${children[0]} carries` : 'they carry'} on next month.`,
    )
  }

  /* --------------------------------------------------------------- prospect */

  if (role === 'prospect') {
    oneLine = `a stranger with ${s.name}'s number and nothing else`

    who.push(`You are ${name}. You are not a customer of ${s.name} — you have their number, and that is the whole of it.`)
    who.push(`It is ${aBusiness(s)}. You do not know what runs there, on what days, at what time, or what any of it costs.`)
    who.push(
      'Nothing has been said between you and them yet. They have your name written down somewhere and nothing else — not what you want, not who it is for.',
    )

    goals.push('Get a real monthly number out of them. Not "it depends" — a number, or a clear reason there cannot be one yet.')
    goals.push('Find out what actually runs there, and when, and whether any of it fits around your week.')
    goals.push('Find out what happens if a week is missed — is it lost, is it made up, is it credited.')
    goals.push('Come and watch a session before you commit to anything.')
    goals.push(`Make a decision ${horizon(days)} and say so, either way.`)
  }

  return {
    key: o.person.key?.trim() || `${role}-${slug(name)}`,
    name,
    seat: role,
    oneLine,
    who: who.join('\n').replace(/\n{3,}/g, '\n\n').trim(),
    voice: ROLE_VOICE[role],
    typing: ROLE_TYPING[role],
    goals,
    redLines: ROLE_RED_LINES[role],
    // Empty on purpose — see this section's header. A generated life event is
    // invention dressed as circumstance. A driver with a calendar of its own
    // passes the day's pressure through `SeatContext.today` instead.
    life: {},
  }
}

/**
 * Everybody in a world, in the order `buildWorld` creates them.
 *
 * Here so that a driver wiring up `--world` writes no loop of its own. A second
 * loop somewhere else is a second place to forget the admin, or to hand a client's
 * name over with the coach role — which `briefFromWorld` refuses loudly, so it is
 * a run that does not start rather than a run that lies, but it is still a run
 * that did not happen.
 */
export function briefsFromWorld(o: { spec: WorldSpec; days: number }): Brief[] {
  const s = normalised(o.spec)
  const people: BriefPerson[] = [
    { name: s.admin.name, role: 'admin' },
    ...s.coaches.map((c) => ({ name: c.name, role: 'coach' as const })),
    ...s.clients.map((c) => ({ name: c.name, role: 'client' as const })),
    ...s.prospects.map((p) => ({ name: p.name, role: 'prospect' as const })),
  ]
  return people.map((person) => briefFromWorld({ spec: s, person, days: o.days }))
}

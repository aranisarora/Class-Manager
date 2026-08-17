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
 *   - **Anika's fever.** Divya's daughter misses Wednesday. Arjun marks her
 *     absent that night without knowing why. Rahul sees the ledger on Thursday.
 *     Three seats, one event, and the product has to hold one story.
 *   - **Priya's raise.** Priya asks Rahul off-channel; Rahul has to find out what
 *     he actually pays before answering. Arjun covers her Saturday and expects to
 *     be paid for it.
 *   - **Farah's two children.** A stranger asking a price the product must not
 *     invent, a sibling discount that does not exist yet, and a decision on
 *     Sunday that goes one way or the other on the strength of the answers.
 */

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

export type PersonaKey = 'rahul' | 'arjun' | 'divya' | 'farah'
export type Window = 'morning' | 'evening'

export type Persona = {
  key: PersonaKey
  /** The name on the phone. */
  name: string
  /** admin | coach | client | prospect — the axis every score is split by. */
  seat: 'admin' | 'coach' | 'client' | 'prospect'
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
Squad. Two coaches work under you, Arjun Shetty on the evenings and Priya Nair on the
weekend. You have about a dozen families on the books. You are not a software person;
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
      "Get August's fees in. By Friday you want to know exactly who still owes you and how much.",
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
      1: 'Ordinary Monday. You are on court from 07:00 and you check your phone between drills.',
      2: 'Priya messaged you privately last night asking for a raise. You have no idea what you currently pay her versus Arjun, and you are not going to answer her until you do.',
      4: 'You want the money picture before the weekend. You are also aware a new family enquired and nobody has followed up.',
      5: 'Priya told you she cannot make Saturday. Saturday is the Weekend Squad and it is your busiest paying class. It needs covering.',
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
      1: 'You are stuck at the Silk Board signal and you will be about ten minutes late for the 6pm batch.',
      3: 'No session for you today — your batch is Monday and Thursday. You have started wondering what you have actually earned this month. You think it is around six sessions but you are not sure.',
      4: 'You coached tonight. Everybody was there except Anika Rao, who simply never turned up. You do not know why and it is not your business.',
      5: 'You have heard Priya cannot do Saturday. You would like it. You need to know if it pays the same.',
      6: 'You are covering the Weekend Squad this morning. It is not your usual class and you do not know the kids.',
      7: 'Month is nearly out. You want your number, and you want to be able to check it.',
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
      'Not be charged for the Wednesday session Anika missed with a fever — or, at minimum, be told plainly and honestly why you are.',
      'Pay August and come away with something you could point at later that says it was received.',
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
      2: 'Anika woke up with a fever. She is not going to tennis tomorrow evening and probably not for a couple of days.',
      3: 'Anika is still ill. She has no class today anyway. You are starting to wonder what exactly you are paying ₹2400 for this month.',
      4: 'Anika is still not well enough and will miss tonight\'s Thursday session too. You want to know what you actually owe before you pay anything.',
      5: 'You are paying today. ₹2400, UPI, and you will have a reference number: 447119002233.',
      6: 'Your husband has said he will handle the academy fees from now on. You do not want money messages any more. You DO still want to know about Anika — sessions, cancellations, anything about her.',
      7: 'Anika is better and went back. You are deciding whether to carry on next month. You want to know the payment landed.',
    },
  },

  /* --------------------------------------------------------------- prospect */
  farah: {
    key: 'farah',
    name: 'Farah Sheikh',
    seat: 'prospect',
    oneLine: 'a stranger with two children, comparing two academies, deciding by Sunday',
    who: `You are Farah Sheikh. You saw a board for Ace Tennis Academy near the market
and you have two children — Zoya, nine, and Imran, seven. You have never spoken to this
academy before and they do not know your name. You are also talking to another academy
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
      1: 'You saw the board on the way home from the market this evening. You are messaging the number on it for the first time. They have no idea who you are.',
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

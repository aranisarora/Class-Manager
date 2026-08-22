/**
 * _seat-worker — one persona, one OS process, for the length of the week.
 *
 *   spawned by `scripts/sim.ts`. There is nothing here to type at a shell.
 *   node --import tsx scripts/_seat-worker.ts --dir <run> --persona divya --model <m> --seed <s>
 *
 * The leading underscore means the same thing it means everywhere else in this
 * directory: not a command. It is an entry point rather than a module, which is
 * the one way it differs from `_seat.ts` — a driver starts it, talks to it over
 * the node IPC channel, and ends it.
 *
 * WHY A PROCESS AND NOT A PROMISE
 * -----------------------------------------------------------------------------
 * `lib/agent/sql-trace.ts`'s `captureSql` saves and restores MODULE-LEVEL state:
 * it swaps in its own collector and puts the previous one back in a `finally`.
 * Two turns awaiting the model inside one process therefore interleave — the
 * second capture opens with the first's collector as its prior sink, so every
 * statement the second turn composes is pushed into the FIRST turn's record too,
 * and when the first turn finishes it restores the sink to what was open before
 * IT started, which stops the second turn collecting anything for the rest of its
 * life. One record with another persona's SQL in it, one record missing its own.
 * Both look complete and nothing throws. `_seat.ts` says the same thing at
 * greater length; this file is what that fact costs, in the shape of a program.
 *
 * So concurrency here is processes. `Promise.all` over four seats in one process
 * is not a tidier version of this.
 *
 * WHY IT OUTLIVES THE WINDOW
 * -----------------------------------------------------------------------------
 * A week is fourteen windows and twenty-four seat turns. A child per TURN pays
 * node's start-up, tsx's transform and this file's imports twenty-four times for
 * twenty-four sentences; a child per PERSONA pays it four times for the whole
 * week. What a persistent worker holds across a window is what a person holds:
 * what they have already sent, what was on their phone the last time they looked,
 * and — since it also holds the model open (`openSeatModel`) — the conversation
 * itself. None of the three is a thing it would be wrong to keep. The one it does
 * NOT keep is the visible thread: what arrived since they last looked is what
 * they are shown, so the week is reachable and never re-read.
 *
 * THE PHONE IS READ ONCE AND SHOWN TWICE
 * -----------------------------------------------------------------------------
 * `drive()` ends by reading the phone with the cursor ADVANCED, which is how a
 * human seat sees the reply to what it just said (`live.ts say` prints exactly
 * that). Those messages are past the cursor from then on, so a worker that threw
 * them away would never show this persona the answer to their own question — they
 * would ask on Tuesday, be answered on Tuesday, and open a phone on Wednesday
 * with the reply already scrolled off it. Every reading downstream of that is
 * about somebody who was never answered.
 *
 * They are held in `pending` instead and shown at the top of the next look, which
 * is what a phone does.
 *
 * A BUTTON IS PRESSED, NOT TYPED
 * -----------------------------------------------------------------------------
 * `_persona-agent` can only return a message, because a phone's other affordance
 * — pressing the thing on the screen — has no room in `say`. But a WhatsApp
 * button reply arrives as the title of the button, so a persona who reads
 * `tap: [ Yes ]` and answers "yes" is a persona pressing it. When the words match
 * an affordance still live on one of this contact's own recent messages, the turn
 * is driven as the tap it is, which is the only path that reaches the staged-plan
 * commit — the surface the scripted week tapped on every turn and this one would
 * otherwise never touch. No match, and it goes as text, which is also what really
 * happens when somebody types the word instead of pressing it.
 *
 * WHAT IT DOES NOT DO
 * -----------------------------------------------------------------------------
 * It does not move the clock, drain the queue, or write `session.json`. One
 * process owns all three — the driver — because two seats walking a shared clock
 * would each advance past the other's target, and a turn that runs while the
 * clock moves under it is a harness artifact rather than a fact about the
 * product. Concurrent MESSAGES are real; concurrent time is not.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { academyOf, drive, logSeat, q, readPhone, renderPhone, takeHeldBack, type Seen, type Session } from './_seat'

/**
 * Forced before anything is imported that can send, exactly as `_seat.ts` and
 * `live.ts` force it. `.env.local` ships `TRANSPORT=cloud`; a seat that takes the
 * cloud path hard-fails at the credential gate and every turn then reports an
 * error, zero tools and an empty reply — which reads exactly like a broken model.
 * The driver passes it in this child's environment too; both, because either
 * could be the thing that is wrong.
 */
process.env.TRANSPORT = 'emulator'

/**
 * Spawned, never typed — the leading underscore, enforced.
 *
 * Without the channel this file would sit at an idle `process.on('message')`
 * forever, having built a persona and read a run directory, answering nothing and
 * printing nothing. Somebody would read that as a hung week.
 */
if (!process.send) {
  console.error('  _seat-worker is spawned by scripts/sim.ts and has no meaning on its own.')
  process.exit(2)
}

const { openSeatModel } = await import('./_persona-agent')
const { readTurns } = await import('./_derive')
const { inboundFromContact } = await import('@/lib/seed')
const { phonebookLookup, phonebookNames } = await import('@/lib/phonebook')
const { bodyWithSharedContacts } = await import('@/lib/messaging/contact-card')

/** A seat key is derived from a name in the world file: `Rahul Menon` → `rahul-menon`. */
type PersonaKey = string
type Persona = import('./_personas').Persona
type Window = import('./_personas').Window
type SeatAction = import('./_persona-agent').SeatAction
type Usage = import('@/lib/agent/deepseek').GenResult['usage']

/* ------------------------------------------------------------- the wire */

/** What the driver asks for: one move, in this window of this day. */
export type Ask = {
  id: string
  day: number
  window: Window
  /** What happened to this person today, resolved by the driver's calendar. */
  today?: string
  /**
   * How many hours behind this phone is for this look — `_events.ts`'s `lag`.
   *
   * On the ask rather than on the seat, because it is a property of this window
   * and not of this person: somebody with no signal at the courts on Friday
   * evening has an ordinary phone on Saturday morning.
   */
  lag?: number
}

/**
 * What came back. `kind` names which of the two things happened rather than
 * carrying a boolean, because a boolean on a wire becomes a boolean in a record,
 * and nothing in an instrument scores anything.
 *
 * `failed` is a broken model call and NEVER a person choosing to say nothing —
 * `_persona-agent` returns a null move for exactly that reason, and a harness
 * that dressed it as silence would fabricate a finding of the class this
 * instrument exists to detect.
 */
export type Told =
  | { id: 'ready'; kind: 'ready'; persona: string }
  | {
      id: string
      kind: 'moved'
      action: SeatAction
      say: string
      intent: string
      /** The words on the affordance this was resolved to, or null for plain text. */
      tapped: string | null
      /**
       * A press the seat DECLARED and the harness could not resolve — the title it
       * reached for, kept so a turn that reads as the product ignoring a confirmation
       * can be told apart from a harness that missed one. Absent on every ordinary move.
       */
      tapMissed?: string
      /** Whose contact cards went with the message, by name. Absent when none did. */
      shared?: string[]
      /**
       * Names they tried to attach and could not find in their own phone.
       *
       * Kept because it is a finding rather than noise: a seat repeatedly reaching
       * for somebody who is not in its contacts is a persona whose week does not fit
       * the world it was given, and a run that dropped these silently would look
       * like a persona that simply never shared anybody.
       */
      notInContacts?: string[]
      /** How many messages this move put on this persona's phone. A count. */
      arrived: number
      usage: Usage
      costUsd?: number
      attempts: number
      ms: number
      model: string
    }
  | { id: string; kind: 'failed'; error: string; usage: Usage; attempts: number; ms: number; model: string; costUsd?: number }

/* --------------------------------------------------------------- setup */

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`)
  const v = i === -1 ? '' : (process.argv[i + 1] ?? '')
  if (!v || v.startsWith('--')) {
    console.error(`  _seat-worker: --${name} is required`)
    process.exit(2)
  }
  return v
}

const DIR = arg('dir')
const KEY = arg('persona') as PersonaKey
const MODEL = arg('model')
const SEED = arg('seed')

/**
 * Who is sitting here, out of the run's own `briefs.json`.
 *
 * One place, and there used to be two: a table of four hard-coded humans, then
 * the file. The table is gone with the fixtures — every person now comes from a
 * world file, so every seat is composed at run time and there is nothing a
 * built-in list could usefully hold.
 *
 * `sim.ts` writes `briefs.json` BEFORE it spawns the first worker, keyed the same
 * way `session.json.contacts` is, precisely so this lookup has somewhere to go.
 * A worker started first exits here rather than mid-turn.
 */
const persona: Persona = (
  JSON.parse(await readFile(join(DIR, 'briefs.json'), 'utf8').catch(() => '{}')) as Record<
    string,
    Persona
  >
)[KEY] as Persona
if (!persona) {
  console.error(
    `  _seat-worker: no seat called "${KEY}" in ${join(DIR, 'briefs.json')}.\n` +
      `  Seat keys are derived from the name in the world file — "Rahul Menon" is "rahul-menon".`,
  )
  process.exit(2)
}

/**
 * The model that plays them, held open for the whole week.
 *
 * One `claude` process per person rather than one per message: the thread between
 * Tuesday and Wednesday is the point, and a fresh process each time is somebody
 * with no memory being handed a transcript of themselves. It also stops paying
 * ~4s of process start on every move — see `openSeatModel`.
 *
 * Opened here, beside the persona it plays, so the session's lifetime is this
 * worker's lifetime and there is one place that ends it.
 */
const seat = openSeatModel(MODEL, persona)

const session = JSON.parse(await readFile(join(DIR, 'session.json'), 'utf8')) as Session
const contactId = session.contacts[KEY]
if (!contactId) {
  console.error(`  _seat-worker: ${KEY} has no contact in ${join(DIR, 'session.json')}`)
  process.exit(2)
}

/**
 * Their memory, rebuilt from the run rather than from this process's lifetime.
 *
 * A worker that dies takes its `said` with it, and the driver's answer to a dead
 * worker is a new one. Reading it back from the log means the replacement is the
 * same person continuing rather than somebody with amnesia introducing themselves
 * to an academy they have been talking to since Monday — which is a defect the
 * record would show as the PRODUCT forgetting them.
 */
const said: string[] = (await readTurns(DIR))
  .filter((t) => t.who === persona.name && typeof t.say === 'string' && t.say.trim())
  .map((t) => String(t.say))

/**
 * The reply to the last thing they said, already past their cursor. See the header.
 *
 * Held on DISK by `heldBack` (`_seat.ts`) rather than only here, because this process is
 * restarted deliberately — once at founding, again per mover — and everything in it goes.
 * Measured on `2026-08-22-08-13-sim-7bo8` turn 0030: Farah Sheikh's phone renders
 * "(nothing arrived. Your phone stayed silent.)" and she writes "?" against a reply the
 * product had sent her the window before. She is one of the two customers that run reads
 * as having lost. This variable is now a cache of the file, not the only copy.
 */
let pending: Seen[] = []

/* ---------------------------------------------------------------- tap */

/**
 * The action id behind a button or list row whose title is exactly these words,
 * on one of this contact's own recent messages.
 *
 * Harness-side, and it never reaches the seat: `Seen` deliberately carries titles
 * and no ids, so the person sees what is written on the button and nothing about
 * how it is wired. Twelve messages back is the same window `live.ts tap` uses —
 * far enough to catch a plan staged a moment ago, short enough that a word like
 * "yes" cannot resolve to an affordance from Tuesday.
 */
async function buttonAction(title: string): Promise<string | null> {
  /**
   * The brackets come off first, because the phone is what put them on.
   *
   * `renderPhone` draws an affordance as `tap:  [ Make the change ]   [ Cancel ]`,
   * so a person deciding to press one writes back what they can see — brackets
   * and all. Matched literally, `[ make the change ]` is not `make the change`,
   * the press resolves to nothing, and it goes as TEXT. Nothing throws and the
   * turn looks ordinary; what is lost is the staged-plan commit, which this
   * file's own header calls "the only path that reaches" it.
   *
   * Measured on the three blank weeks of 21 Aug 2026: 47 seat turns that said
   * something, 3 resolved taps, and 2 presses silently downgraded — one of them
   * Kavitha Reddy pressing `[ Make the change ]` on a staged date change that
   * consequently never committed. The turn it produced reads as the product
   * ignoring a confirmation, which is a fabricated defect.
   */
  const want = title.trim().replace(/^\[\s*/, '').replace(/\s*\]$/, '').trim().toLowerCase()
  if (!want) return null
  const rows = await q<any>(
    // This seat's own tenant. Under the wrong GUC this select returns zero rows
    // with no error, and every tap silently downgrades to text — which is the
    // fabricated defect described directly above.
    academyOf(session, KEY),
    `select m.payload from message m
      where m.direction = 'outbound' and m.contact_id = '${contactId}'::uuid
        and m.suppressed_reason is null
      order by m.created_at desc limit 12`,
  ).catch(() => [] as any[])
  for (const m of rows) {
    const p = m.payload ?? {}
    const cands = [
      ...(Array.isArray(p.buttons) ? p.buttons : []),
      ...(Array.isArray(p.list?.sections) ? p.list.sections.flatMap((x: any) => x?.rows ?? []) : []),
    ]
    const hit = cands.find((b: any) => String(b?.title ?? '').trim().toLowerCase() === want)
    if (hit?.actionId) return String(hit.actionId)
  }
  return null
}

/* ---------------------------------------------------------- one window */

async function move(ask: Ask): Promise<Told> {
  const s: Session = { ...session, day: ask.day }

  // What the last reply left in their hand, oldest first, and then everything
  // that has arrived on the phone since.
  /**
   * The lag applies to what ARRIVED since, never to `pending`.
   *
   * `pending` is what the product said back to this person's own last message,
   * already handed over by `drive` — its cursor has moved past those rows, so a
   * lag that dropped them would lose them for good rather than delay them. It is
   * also the truer model: somebody on bad signal still sees the answer they were
   * waiting for, and it is the unasked-for traffic — the reminder, the digest,
   * the dunning nudge — that lands late.
   */
  // Drained from disk, so a worker that restarted since the last window still knows what
  // its person is holding. `pending` in this process is only ever the same rows sooner.
  const held = pending.length ? pending : ((await takeHeldBack(s, KEY)) as Seen[])
  if (pending.length) await takeHeldBack(s, KEY)
  const seen = [...held, ...(await readPhone(s, KEY, true, ask.lag ?? 0))]
  pending = []

  // The one rendering, kept: the seat decides from these bytes and the record
  // gets the same ones. Rendering it twice would let the two drift.
  const phone = renderPhone(seen)
  const turn = await seat.move({
    persona,
    day: ask.day,
    window: ask.window,
    phone,
    said,
    seed: SEED,
    // Names only — see `SeatMove.attach`. The numbers behind them are derived from
    // this academy's id and never enter the prompt, so a seat cannot invent one and
    // cannot hand a number another tenant already holds.
    contacts: phonebookNames(session.academyId),
    ...(ask.today ? { today: ask.today } : {}),
  })

  /**
   * What the seat was shown and what it did with it, appended before anything is
   * posted — so the blindfold is auditable after the run rather than promised,
   * and so a move that then crashes the turn is still on disk. `live.ts` writes
   * the same file for the human seats and `close` folds it into the record.
   */
  await logSeat(s, {
    persona: KEY,
    cmd: 'agent',
    window: ask.window,
    // Why the phone looked emptier than the database. Without it, a lagged look
    // is indistinguishable in the audit from a window in which the product sent
    // nothing — and "she was told and did not answer" would be read off a turn
    // where she had not been told yet.
    ...(ask.lag ? { lagHours: ask.lag } : {}),
    ...(ask.today ? { today: ask.today } : {}),
    shown: seen,
    move: turn.move,
    ...(turn.error ? { error: turn.error } : {}),
    usage: turn.usage,
    attempts: turn.attempts,
    model: turn.model,
    ms: turn.ms,
  })

  const spent = { usage: turn.usage, attempts: turn.attempts, ms: turn.ms, model: turn.model, ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }) }
  if (!turn.move) {
    return { id: ask.id, kind: 'failed', error: turn.error ?? 'the model returned no usable answer', ...spent }
  }
  const m = turn.move

  /**
   * Sent whenever there are words, not only when the action is `say`.
   *
   * `_persona-agent` lets `giveup` carry a parting message and forces `quiet` to
   * an empty one, because leaving loudly and leaving in silence are different
   * findings. A caller that branched on the action would swallow Farah's "we are
   * going elsewhere, and here is why", which is the single most informative
   * sentence in her week.
   */
  const actionId = m.say ? await buttonAction(m.say) : null
  const tapped = actionId ? m.say : null

  /**
   * A press that DECLARED itself and did not resolve, said out loud.
   *
   * `buttonAction` downgrades an unmatched title to ordinary text on purpose — a
   * person typing words that happen to read like a button is typing, not pressing.
   * But `action: 'tap'` is the seat saying it reached for something on its screen,
   * and when that resolves to nothing the turn that follows reads as the product
   * ignoring a confirmation. This file's own header calls that a fabricated defect
   * and measured it: two of five presses silently downgraded across three weeks,
   * one of them a staged date change that consequently never committed.
   *
   * So the intent and the outcome are both in the record and a reader can tell a
   * product that ignored a tap from a harness that missed one.
   */
  const tapMissed = m.action === 'tap' && m.say && !actionId ? m.say : null

  /**
   * The names they attached, turned into cards — and the ones that were not there.
   *
   * A name the book does not hold is dropped rather than invented, and the drop is
   * recorded: a seat looking for somebody who is not in its phone is an ordinary
   * small failure, and a harness that manufactured a number for them would be
   * feeding the product a contact nobody could ever reach. It would also be the
   * exact §10.1 hazard `lib/phonebook.ts` exists to remove, reintroduced by the one
   * component that was supposed to be blindfolded from numbers entirely.
   *
   * A tap carries no attachment: `actionId` and `contacts` are exclusive because a
   * button reply is not a message with a body to hang a card on.
   */
  const attachNames = actionId ? [] : (m.attach ?? [])
  const shared = attachNames
    .map((n) => phonebookLookup(session.academyId, n))
    .filter((c): c is NonNullable<typeof c> => c !== null)
  const unknownNames = attachNames.filter((n) => phonebookLookup(session.academyId, n) === null)

  /**
   * A silent move is still a turn: the thunk posts nothing, and the turn is
   * recorded anyway.
   *
   * The record has to be able to hold a window in which somebody read their phone
   * and put it down. Without the turn, a persona who went quiet is
   * indistinguishable from a persona nobody drove, and "she stopped replying" —
   * the outcome the business cares about most — cannot be read back out of the run
   * at all. The intent and the reasoning are attached whatever they chose, so a
   * later reader knows WHY the phone went down.
   */
  /**
   * What actually went on the wire, which is what the record has to hold.
   *
   * `m.say` alone would record a message that was nothing but a shared card as an
   * empty string — a turn that reads, months later, as somebody sending nothing
   * and the product answering anyway. Built from the same renderer `ingestInbound`
   * writes into `message.body`, so the record and the database agree word for word.
   */
  const wire = bodyWithSharedContacts(m.say, shared) ?? ''

  /**
   * The second message, sent AFTER the first has been driven and never beside it.
   *
   * `_capture.ts` attributes a turn's evidence by contact plus a time window, so two
   * concurrent turns on ONE contact would have their statements, messages and audit rows
   * interleaved into whichever record flushed second — the two would be indistinguishable
   * in exactly the file a reader goes to. Sequential costs a round trip and keeps the
   * record readable, which is the trade every instrument in this repo makes.
   *
   * @mechanism secondBreath — a persona may send a second message before the product has
   *   answered, which is what `INPUT_REALISM` has instructed since it was written — "HALF
   *   MESSAGES sent by accident, then finished in the next one", "THE SAME THING TWICE,
   *   because the first one looked like it did not send" — and what `SeatAction` made
   *   structurally impossible: one move per window, one string in it, a measured maximum of
   *   1 message per person per window across 101 sim seat turns with zero exceptions. So
   *   `repliedTo` had never once faced a second inbound, and §7.1's "bring the timetable in
   *   one message, however messy" was only ever measured with nothing else in flight.
   *   Bounded at exactly one extra so a run cannot become a stress test of an uncommon shape.
   *   Closes F-DW.
   */
  const secondBreath = typeof (m as { then?: string }).then === 'string' ? (m as { then?: string }).then : ''

  pending = await drive(
    s,
    KEY,
    {
      say: actionId ? m.say : wire,
      kind: actionId ? 'tap' : 'say',
      window: ask.window,
      intent: m.intent,
      // Named here rather than looked up there: this seat may be the ninetieth
      // person in a world spec, and `PERSONAS` holds four. See `drive()`.
      who: persona.name,
      seat: persona.seat,
      // An object rather than a sentence: the action is evidence about the person
      // and there is no field on a turn that holds it. `personaReasoning` is
      // `unknown` precisely so a driver does not have to clip what it knows.
      personaReasoning: { action: m.action, reasoning: m.reasoning },
      // The screen this move was a response to. Without it the record holds the
      // decision and not the thing decided about.
      phone,
    },
    async () => {
      // Words OR cards. A message that is nothing but a shared contact is a real
      // message — it is what "here, this is him" looks like on a handset — so the
      // guard is no longer `if (!m.say) return`, which would have silently eaten it.
      if (!m.say && shared.length === 0) return
      await inboundFromContact({
        contactId,
        ...(actionId ? { actionId } : m.say ? { text: m.say } : {}),
        ...(shared.length ? { contacts: shared } : {}),
      })
    },
  )

  // The second message, as its own turn in the same window — see `secondBreath`.
  if (secondBreath) {
    const after = await drive(
      s,
      KEY,
      {
        say: secondBreath,
        kind: 'say',
        window: ask.window,
        intent: m.intent,
        who: persona.name,
        seat: persona.seat,
        // The SAME reasoning object: one decision produced both messages, and giving the
        // second a reasoning of its own would invent a deliberation nobody had.
        personaReasoning: { action: m.action, reasoning: m.reasoning, breath: 2 },
        phone,
      },
      async () => {
        await inboundFromContact({ contactId, text: secondBreath })
      },
    )
    pending = [...pending, ...after]
    said.push(secondBreath)
  }
  // Their own memory of what they sent — the card included, or they will hand the
  // same person over again tomorrow having no record of having done it.
  if (wire) said.push(wire)

  return {
    id: ask.id,
    kind: 'moved',
    action: m.action,
    say: m.say,
    intent: m.intent,
    tapped,
    ...(tapMissed ? { tapMissed } : {}),
    ...(shared.length ? { shared: shared.map((c) => c.name) } : {}),
    ...(unknownNames.length ? { notInContacts: unknownNames } : {}),
    arrived: pending.length,
    ...spent,
  }
}

/* --------------------------------------------------------------- serve */

const send = (t: Told): void => {
  process.send?.(t)
}

/**
 * One ask at a time, chained rather than raced.
 *
 * The driver sends one and waits, so the chain is belt and braces — but the belt
 * is the whole reason this file exists: two moves overlapping inside ONE process
 * is the `captureSql` interleave the header describes, and it would arrive here
 * as two clean-looking records rather than as an error.
 */
let queue: Promise<void> = Promise.resolve()

process.on('message', (raw: unknown) => {
  const ask = raw as Ask
  if (!ask || typeof ask !== 'object' || typeof ask.id !== 'string') return
  queue = queue.then(async () => {
    try {
      send(await move(ask))
    } catch (e) {
      // A crash in the harness half is reported as a harness failure and never as
      // a person's silence, on the same reasoning as a null move. The tokens the
      // move really cost are already in `seat.jsonl`, written before the post.
      send({
        id: ask.id,
        kind: 'failed',
        error: e instanceof Error ? (e.stack ?? e.message) : String(e),
        usage: { promptTokens: 0, outputTokens: 0, cachedTokens: 0 },
        attempts: 0,
        ms: 0,
        model: MODEL,
      })
    }
  })
})

/** The driver has gone. Nothing here is worth outliving it. */
process.on('disconnect', () => {
  // The person leaves the phone when the phone goes. A seat process outliving its
  // driver is a `claude` holding a session open against a week that has finished.
  seat.end()
  process.exit(0)
})

/**
 * Sat down.
 *
 * The driver waits for this before it counts the seat as open, because the
 * expensive half of a worker is everything above this line — the imports, the
 * session, and one read of the log — and paying it inside the first window would
 * bill the model's latency and node's start-up to the same number.
 */
send({ id: 'ready', kind: 'ready', persona: KEY })

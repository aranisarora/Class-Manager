/**
 * _seat-worker — one persona, one OS process, for the length of the week.
 *
 *   spawned by `scripts/drive-week.ts`. There is nothing here to type at a shell.
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
 * week. The startup is the only thing that changes — a persistent worker holds
 * nothing across a window that it would be wrong to hold, because the two things
 * it does keep are the two things a person keeps: what they have already sent,
 * and what was on their phone the last time they looked.
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

import { drive, logSeat, q, readPhone, renderPhone, type Seen, type Session } from './_seat'

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
  console.error('  _seat-worker is spawned by scripts/drive-week.ts and has no meaning on its own.')
  process.exit(2)
}

const { PERSONAS } = await import('./_personas')
const { nextMove } = await import('./_persona-agent')
const { readTurns } = await import('./_derive')
const { inboundFromContact } = await import('@/lib/seed')

type PersonaKey = import('./_personas').PersonaKey
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
      /** How many messages this move put on this persona's phone. A count. */
      arrived: number
      usage: Usage
      attempts: number
      ms: number
      model: string
    }
  | { id: string; kind: 'failed'; error: string; usage: Usage; attempts: number; ms: number; model: string }

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

const persona = PERSONAS[KEY]
if (!persona) {
  console.error(`  _seat-worker: no such seat ${KEY}. One of ${Object.keys(PERSONAS).join(', ')}`)
  process.exit(2)
}

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

/** The reply to the last thing they said, already past their cursor. See the header. */
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
  const want = title.trim().toLowerCase()
  if (!want) return null
  const rows = await q<any>(
    session.academyId,
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
  const seen = [...pending, ...(await readPhone(s, KEY, true))]
  pending = []

  const turn = await nextMove({
    persona,
    day: ask.day,
    window: ask.window,
    phone: renderPhone(seen),
    said,
    seed: SEED,
    model: MODEL,
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
    shown: seen,
    move: turn.move,
    ...(turn.error ? { error: turn.error } : {}),
    usage: turn.usage,
    attempts: turn.attempts,
    model: turn.model,
    ms: turn.ms,
  })

  const spent = { usage: turn.usage, attempts: turn.attempts, ms: turn.ms, model: turn.model }
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
  pending = await drive(
    s,
    KEY,
    {
      say: m.say,
      kind: actionId ? 'tap' : 'say',
      window: ask.window,
      intent: m.intent,
      // An object rather than a sentence: the action is evidence about the person
      // and there is no field on a turn that holds it. `personaReasoning` is
      // `unknown` precisely so a driver does not have to clip what it knows.
      personaReasoning: { action: m.action, reasoning: m.reasoning },
    },
    async () => {
      if (!m.say) return
      await inboundFromContact({
        contactId,
        ...(actionId ? { actionId } : { text: m.say }),
      })
    },
  )
  if (m.say) said.push(m.say)

  return {
    id: ask.id,
    kind: 'moved',
    action: m.action,
    say: m.say,
    intent: m.intent,
    tapped,
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
process.on('disconnect', () => process.exit(0))

/**
 * Sat down.
 *
 * The driver waits for this before it counts the seat as open, because the
 * expensive half of a worker is everything above this line — the imports, the
 * session, and one read of the log — and paying it inside the first window would
 * bill the model's latency and node's start-up to the same number.
 */
send({ id: 'ready', kind: 'ready', persona: KEY })

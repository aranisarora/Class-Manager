/**
 * _persona-agent — the person in the seat, when nobody is sitting in it.
 *
 *   import { nextMove } from './_persona-agent'
 *
 *   const { move, error } = await nextMove({
 *     persona: PERSONAS.divya,
 *     day: 3,
 *     window: 'evening',
 *     phone: renderPhone(seen),        // exactly what her phone showed
 *     said,                            // everything she has sent so far, in order
 *     model: cfg.model,
 *     seed: cfg.seed,
 *   })
 *
 *   if (!move) report(error)                 // a broken call, not a silent person
 *   else if (move.action === 'quiet') stayQuiet()
 *   else if (move.say) await inboundFromContact({ contactId, text: move.say })
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * `_personas.ts` holds four people as GOALS rather than as sentences, for the
 * reason its own header gives: a fixture cannot ask again because the answer did
 * not answer it, cannot act on a misreading, and cannot leave. So the sentences
 * come from somebody sitting in the seat — `scripts/live.ts`, one `say` at a
 * time, reading the reply before deciding the next thing.
 *
 * That is where every good reading in this repo came from, and it costs a human
 * being an evening per week driven: the newest recorded live run,
 * `.probe/runs/2026-08-19-20-30-live`, is fifty-four turns, each one a person
 * reading a phone and typing. Two things follow, and both are worse than the
 * tedium. A week cannot be RE-driven, because the second week's sentences would
 * be different sentences typed by a differently tired person, so a prefix change
 * measured across the pair is measured against noise nobody can size. And a week
 * cannot be run twice at once on two arms, which is the only way an A/B ever
 * finishes.
 *
 * This module puts a model in the seat with exactly what the human had: who they
 * are, how they type, what they want out of the week, what happened to them
 * today, and what their phone shows. It holds no script. What it returns is what
 * that person does next, which on a bad enough week is nothing.
 *
 * THE BLINDFOLD IS THE PARAMETER LIST
 * -----------------------------------------------------------------------------
 * A seat sees message bodies, buttons, list rows and forms. It does not see the
 * database, the model's reasoning, the SQL it wrote, the tokens or the rupees —
 * because a reading like "I could not tell whether that meant she was charged"
 * is worth nothing if the reader could have checked the rows.
 *
 * The seat enforces that on the printing side — it shows message bodies,
 * buttons, list rows and forms and nothing else — and logs every seat command,
 * so the blindfold is auditable after the run rather than merely promised. Here
 * it is enforced by the shape of the argument: there is no `rows`, no `sql`, no
 * `cost`, no `world` and no `reasoning` parameter, so there is nothing for a
 * caller in a hurry to pass through. The one channel in is `phone`, and it is
 * whatever `renderPhone()` printed — the same characters a human would have
 * read. Adding a field to `SeatContext` is therefore a decision about the
 * blindfold, and should be taken like one.
 *
 * THE THREE MOVES, AND WHY TWO OF THEM ARE NOT DECORATION
 * -----------------------------------------------------------------------------
 * `say`, `quiet`, `giveup`. The header of `scripts/live.ts` names the three
 * things a fixture cannot represent — asking again, acting on a misreading, and
 * going quiet and leaving. The first two need no machinery: they are what the next
 * sentence turns out to be, once the sentence is written by somebody who read
 * the reply. The third needs somewhere to go, or it cannot happen at all.
 *
 * Divya's voice says it outright: "If you are fobbed off you do not argue, you go
 * quiet, and then you leave." A harness with no `quiet` and no `giveup` forces
 * her to keep talking, and a week in which nobody could leave reports a retention
 * the product never earned. Leaving is the outcome the business cares about most
 * and it is the one no instrument here could produce.
 *
 * `giveup` may carry a last message, and often should: Farah's day 7 is "you
 * tell them you are going elsewhere, and you say which and why". Walking out
 * loudly and walking out in silence are different findings, so the shape holds
 * both rather than forcing one.
 *
 * EVIDENCE, NOT VERDICTS
 * -----------------------------------------------------------------------------
 * Every move comes back with `intent` and `reasoning`, and both are evidence
 * about the PERSON: what they were trying to get, and how they read the last
 * reply. `_capture.ts` already has the two fields to put them in — `intent` and
 * `personaReasoning` — and calls them the half of a turn the record never held.
 * Without them a later reader sees the same question asked twice and cannot tell
 * somebody who was misunderstood from somebody who changed their mind.
 *
 * There is no `goalAchieved`, no `satisfied`, no `helpful`, no score, and this
 * module will not grow one. Nothing in an instrument scores anything: the
 * verdict is written afterwards by a person or a judge model, into a file beside
 * the record. A seat that graded itself would be grading the thing it is a
 * witness to, and its grade would then be the only evidence anybody read.
 *
 * A FAILURE IS NOT A SILENCE
 * -----------------------------------------------------------------------------
 * `generateJson` returns `null` rather than throwing when two attempts produce
 * nothing usable. That arrives here as `move: null` with `error` set, and NEVER
 * as a quiet move. A broken call recorded as a person choosing not to reply is a
 * fabricated finding of precisely the class this instrument exists to detect,
 * and it would be undetectable afterwards, because `quiet` is legitimate and
 * reads as legitimate. The caller has to look at `move` being null, which is the
 * entire reason it is returned that way.
 *
 * WHAT IT COSTS
 * -----------------------------------------------------------------------------
 * A seat's whole prompt — one persona's brief, the week's goals, today, and what
 * the phone showed — measures 7.9k to 8.5k characters across the four of them,
 * so on the order of 2k tokens. The brain on the other side of the conversation
 * took a median 87k prompt tokens per turn across those fifty-four live turns.
 * The seat is a rounding error on the run it makes possible, so nothing here is
 * trimmed to save money; `lib/pricing.ts` prices both, in rupees, and a driver
 * adds them to the same budget.
 */
import type { GenResult } from '@/lib/agent/deepseek'
import { generateJson } from '@/lib/agent/deepseek'

import { INPUT_REALISM, type Persona, type Window } from './_personas'

/* ------------------------------------------------------------------ shape */

export type SeatAction = 'say' | 'quiet' | 'giveup'

export type SeatMove = {
  /** What the person did. `quiet` and `giveup` are outcomes, not failures. */
  action: SeatAction
  /**
   * The message, exactly as they typed it — typos, missing capitals and all.
   *
   * Empty for `quiet`, always. Empty for `say`, never. OPTIONAL for `giveup`,
   * which is the one place this differs from "empty unless the action is say": a
   * customer who tells you they are going elsewhere and a customer who simply
   * stops replying are both giving up, and the record has to be able to tell
   * them apart. A caller that sends only on `action === 'say'` will swallow the
   * goodbye, so send whenever `say` is non-empty.
   */
  say: string
  /** What they are TRYING to get out of them, in their own words. One line. */
  intent: string
  /** How they read the last reply, and why they put it the way they did. */
  reasoning: string
}

/**
 * Everything the seat is allowed to know. There is deliberately nothing here
 * about the database, the turn, the cost, or the model's working.
 */
export type SeatContext = {
  persona: Persona
  /** Simulated day, 1-based, as `SCHEDULE` counts them. */
  day: number
  /** Which window of that day they are at the phone in. */
  window: Window
  /** EXACTLY what `renderPhone()` showed. The only thing they can see. */
  phone: string
  /** What this persona has already said this run, oldest first. Their memory. */
  said: string[]
  /** The run's seed. Decides which messages are the messy ones — see `messyLine`. */
  seed: string
  /**
   * Override for what happened to them today, when a driver keeps its own
   * calendar — `_ramp.ts` holds a five-tier one. Defaults to `persona.life[day]`.
   *
   * The tier is never named to the seat, and this parameter is how that stays
   * true: a driver hands the day's pressure over as prose, and this module never
   * learns that tiers exist. A persona who has been told today is "the hard one"
   * has stopped being a persona and started being a test case.
   */
  today?: string
}

export type SeatTurn = {
  /** What they did, or null when the model gave no usable answer at all. */
  move: SeatMove | null
  /** Why there is no move. Set if and only if `move` is null. */
  error?: string
  usage: GenResult['usage']
  /** Model calls spent: 1, or 2 when the first answer did not parse or did not fit. */
  attempts: number
  model: string
  /**
   * What this call actually cost, in dollars, when the backend measured it.
   *
   * Only the Claude CLI reports one. DeepSeek turns leave it absent and are
   * priced from `lib/pricing.ts` by token count, as everything here always has
   * been. A measured figure beats a rate table, and `costInr` returns 0 for a
   * model it does not know — which would make a Claude seat read as free.
   */
  costUsd?: number
  /** The model's own milliseconds, summed over the attempts. Not the harness's. */
  ms: number
}

/* --------------------------------------------------------------- settings */

/**
 * Thinking off and a real temperature, which is one decision rather than two.
 *
 * `generate()` puts `temperature` on the wire only when thinking is disabled —
 * in thinking mode the field is accepted and has no effect — and `generateJson`
 * returns the parsed value and nothing else, so a reasoning block bought here
 * would be billed as output and then dropped on the floor. The deliberation
 * worth keeping is the `reasoning` field, which arrives inside the answer and
 * goes into the record.
 *
 * The measured failure mode of thinking off is fluent, present-tense false
 * claims of state — a coach "hired" with zero tool calls. That is a hazard for
 * something that acts on a world through tools. This call has no tools and no
 * state to be false about; it writes one text message.
 *
 * A seat at temperature 0 would type the same sentence every time its phone
 * showed the same thing, which is the fixture this whole file exists to escape.
 *
 * `PROBE_THINKING` overrides the level for every call in the process, and the
 * temperature goes with it. A seat driven inside a pinned arm is a less varied
 * seat, and that is a fact about the pin rather than about the person.
 */
const SEAT_TEMPERATURE = 1.0

/**
 * Enough for a text message and two lines of evidence, and not enough for an
 * essay.
 *
 * An answer that needs more than this is not somebody thumbing a message at a
 * traffic light; it is the model having stopped being the person. The ceiling
 * turns that into a truncated object which does not parse, spending the one
 * retry `generateJson` already has — rather than letting nine hundred words of
 * "text message" into the record as though a human had sent it.
 */
const MAX_SEAT_TOKENS = 1200

/* --------------------------------------------------------------- the seat */

/**
 * The rules of the seat. Everything above this in the prompt is the person; this
 * is the situation they are in and the shape the answer has to take.
 *
 * It names no feature of the product, deliberately. A persona who has been told
 * what the thing can do asks for it by name, and the run then measures recall of
 * a brief instead of whether a stranger could get a price out of it.
 */
const SEAT_RULES = `WHAT YOU CAN SEE
Your phone, and nothing else. The messages that arrived on it, and the buttons,
menus and forms inside them. You cannot see the academy's records. You cannot see
how any answer was worked out, what it cost, or whether anything was really
written down anywhere. If the reply did not tell you, you do not know it — and
noticing that you still do not know it is the most useful thing you do all week.

You are messaging a number the academy gave out. You do not know how it works and
you do not care. Do not name its features, do not suggest what it ought to be able
to do, and do not help it along. You are not testing it. You are a person trying
to get something you need before you have to go and do something else.

THE THREE THINGS YOU CAN DO

  say      Type the next message. ONE message, the length you would really send —
           usually well under twenty words, sometimes a single word, occasionally
           one long dictated run-on. Never an essay.

  quiet    Send nothing at all this time. Choose it when a real person would put
           the phone down: the answer was fine and wants nothing back, or you are
           busy, or you have decided not to get into it right now.

  giveup   You are finished with them. Not annoyed — finished. Choose it when
           your red lines have been crossed and you have stopped expecting it to
           get better, or when you have decided to go elsewhere. You may send one
           last message with it, and usually you would; leave it empty if you are
           the kind of person who simply stops replying.

Giving up is a real ending and nobody is going to talk you out of it. It is also
not free: do not reach for it the first time an answer irritates you, because
somebody who is paying for something normally asks twice before they walk.

ANSWER WITH ONE JSON OBJECT AND NOTHING ELSE:

{
  "action":    "say" or "quiet" or "giveup",
  "say":       "the message exactly as you would type it, or an empty string",
  "intent":    "what you are trying to get out of them, in your own words, one line",
  "reasoning": "how you read the last reply and why you have put it this way, a sentence or two"
}

  - "say" must be empty when the action is "quiet". With "giveup" it is yours to
    choose.
  - "intent" and "reasoning" are filled in whatever you chose, silence included,
    and they are about YOU: what you wanted, what you understood, what you are
    still not sure of. Say plainly when you could not tell what the reply meant.
  - Do not grade the product. No "handled well", no "goal achieved", no score,
    no marks out of ten. Somebody else decides that afterwards. You are the
    witness, not the marker.
  - Write both of them the way you would say them out loud, not the way a report
    would.`

/** The person, and how they type. Stable for the whole run — and so cacheable. */
function seatSystem(p: Persona): string {
  return [
    `YOU ARE ${p.name.toUpperCase()} — ${p.oneLine}.`,
    '',
    p.who.trim(),
    '',
    'HOW YOU TYPE',
    p.voice.trim(),
    '',
    p.typing.trim(),
    '',
    'THE MEDIUM',
    INPUT_REALISM.trim(),
    '',
    'WHAT YOU WANT OUT OF THIS WEEK',
    ...p.goals.map((g) => `  - ${g}`),
    '',
    'WHAT WOULD MAKE YOU COMPLAIN OR LEAVE',
    ...p.redLines.map((r) => `  - ${r}`),
    '',
    SEAT_RULES,
  ].join('\n')
}

/**
 * FNV-1a, 32 bits. Four lines, no dependency, and the same number on every
 * machine — which is the only property being asked of it.
 */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Which half of the coin this message landed on.
 *
 * `INPUT_REALISM` asks for "roughly HALF your messages carrying at least one of
 * these", and that is a ratio across a week. A model asked one message at a time,
 * with no idea of the ratio so far, does not produce it: it garbles everything or
 * it garbles nothing. So the coin is flipped here instead, deterministically from
 * the seed, the person, the day, the window, and how many messages they have
 * already sent — the same run driven twice from one seed asks for the mess in the
 * same places.
 *
 * That is repeatability of the SETUP and not of the sentence. This API has no
 * seed parameter and `SEAT_TEMPERATURE` is deliberately not zero, so the words
 * will differ. The seed is stamped by `_drive-config.ts` and printed by
 * `describeConfig`; handing it back gets you the same week, not the same words.
 *
 * The noise model itself is not rewritten here. `INPUT_REALISM` in `_personas.ts`
 * is the whole of it, shared by all four seats, and each persona's `typing`
 * carries the mess that is only theirs.
 */
function messyLine(o: SeatContext): string {
  const messy = hash([o.seed, o.persona.key, o.day, o.window, o.said.length].join('|')) % 1000 < 500
  return messy
    ? `RIGHT NOW you are moving, or holding something, or annoyed, or all three. Let at
least one of the things under THE MEDIUM happen to this message, and do not go
back and fix it.`
    : `RIGHT NOW you are sitting down and paying attention. This one can come out
clean. Do not put mistakes in on purpose.`
}

/**
 * Today, what they have already said, and what is on the phone.
 *
 * Everything that moves between turns is in here rather than in the system text,
 * because the provider's cache matches on a byte-identical prefix: a persona
 * whose brief never changes is a persona whose brief is nearly free after the
 * first turn of the week.
 */
function seatSituation(o: SeatContext): string {
  const today = (o.today ?? o.persona.life[o.day] ?? '').trim()
  const L: string[] = []
  L.push(`TODAY — day ${o.day}, the ${o.window}.`)
  // The same fallback `live.ts` prints for a day this person has nothing
  // happening on. An empty day is not the same as a day nobody wrote down.
  L.push(`  ${today || 'Nothing unusual is happening to you today.'}`)
  L.push('')
  L.push('WHAT YOU HAVE ALREADY SENT THEM, OLDEST FIRST')
  if (!o.said.length) L.push('  (nothing — this is the first thing you have ever sent this number)')
  else for (const [i, s] of o.said.entries()) L.push(`  ${i + 1}. ${s}`)
  L.push('')
  L.push('ON YOUR PHONE, SINCE YOU LAST LOOKED')
  L.push(o.phone.trimEnd() || '  (nothing arrived. Your phone stayed silent.)')
  L.push('')
  L.push(messyLine(o))
  L.push('')
  L.push('What do you do now? One JSON object, nothing else.')
  return L.join('\n')
}

/**
 * Exactly what the seat was handed, for the caller to write down.
 *
 * The blindfold is auditable only if what was behind it can be read back later —
 * which is why `live.ts` logs every seat command with what it showed. A driver
 * that records this beside the turn can be checked, months afterwards, for the
 * one thing that would invalidate every reading in the run: that a row, a cost,
 * or a piece of the model's working got into the person's prompt.
 */
export function seatPrompt(o: SeatContext): { system: string; situation: string } {
  return { system: seatSystem(o.persona), situation: seatSituation(o) }
}

/* -------------------------------------------------------------- the check */

/**
 * What came back is a move, or it is not one.
 *
 * Whitespace at the ends belongs to the transport and is trimmed. Nothing else
 * about `say` is touched: the typos, the missing capitals, the half-sentence and
 * the mangled name are the input distribution this instrument exists to produce,
 * and a harness that tidied them would be handing the product the clean tenth of
 * its traffic all over again.
 *
 * `intent` and `reasoning` are required whatever the action was, silence
 * included. A quiet turn with no reasoning attached is indistinguishable, three
 * months later, from a turn nobody got round to driving.
 *
 * A `quiet` move carrying a message is the one contradiction normalised rather
 * than refused: the action is the choice, and a body cannot be sent by somebody
 * choosing to send nothing. `giveup` keeps its message, because leaving loudly is
 * a different finding from leaving in silence.
 */
function validateMove(v: unknown): SeatMove | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>

  const action = typeof o.action === 'string' ? o.action.trim().toLowerCase() : ''
  if (action !== 'say' && action !== 'quiet' && action !== 'giveup') return null

  const say = typeof o.say === 'string' ? o.say.trim() : ''
  const intent = typeof o.intent === 'string' ? o.intent.trim() : ''
  const reasoning = typeof o.reasoning === 'string' ? o.reasoning.trim() : ''

  if (!intent || !reasoning) return null
  if (action === 'say' && !say) return null

  return { action, say: action === 'quiet' ? '' : say, intent, reasoning }
}

/* ---------------------------------------------------------------- the ask */

/**
 * One move from one person, given only what their phone shows.
 *
 * Nothing here touches the database, the clock, or the transport. It composes a
 * prompt, asks once, and hands back what the person did — the caller posts the
 * message, or does not, and owns the record.
 */
/**
 * A seat played by Claude, through the `claude` CLI rather than an API key.
 *
 * WHY A SUBPROCESS AND NOT A CLIENT
 * -----------------------------------------------------------------------------
 * The point of this backend is WHOSE budget it spends. An Anthropic client needs
 * an API key and bills per call; the CLI is already authenticated against a
 * Claude Code subscription, so a week of personas comes out of a quota that is
 * already paid for rather than out of the DeepSeek balance the product itself
 * runs on.
 *
 * WHY IT MATTERS WHO PLAYS THE PERSON
 * -----------------------------------------------------------------------------
 * The seats used to be the same model as the brain, which is the one arrangement
 * guaranteed to flatter the result: a model reading a reply its own kind wrote
 * parses the dense part, tolerates the jargon, and finds the number in sentence
 * four. The person this product is for does none of that. Same-model seats
 * therefore under-report confusion, and confusion is most of what a week is for.
 *
 * THREE FLAGS THAT ARE NOT OPTIONAL
 * -----------------------------------------------------------------------------
 *   --system-prompt   REPLACES Claude Code's own, which opens by saying it is a
 *                     CLI for software engineering. Appended instead, the seat
 *                     answers a question about a tennis class with "this session
 *                     is set up for software engineering work" — measured, not
 *                     feared.
 *   --allowed-tools   nothing. A seat that can read a file is not blindfolded.
 *   --strict-mcp-config, --exclude-dynamic-system-prompt-sections
 *                     every token of scaffolding is paid for on every message.
 *
 * It also runs in a scratch directory, because a `CLAUDE.md` in the working tree
 * is loaded into the prompt — this repo's own instructions, handed to somebody
 * pretending to be a parent asking about a fever.
 */
async function claudeSeat(
  tier: string,
  system: string,
  situation: string,
): Promise<{ move: SeatMove | null; error?: string; usage: SeatTurn['usage']; attempts: number; ms: number; model: string; costUsd: number }> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const run = promisify(execFile)

  const cwd = await mkdtemp(join(tmpdir(), 'seat-'))
  let usage: SeatTurn['usage'] = { promptTokens: 0, outputTokens: 0, cachedTokens: 0 }
  let costUsd = 0
  let ms = 0
  let error: string | undefined

  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now()
    try {
      const { stdout } = await run(
        'claude',
        [
          '-p', situation,
          '--output-format', 'json',
          '--model', tier,
          '--system-prompt', system,
          '--allowed-tools', '',
          '--strict-mcp-config',
          '--exclude-dynamic-system-prompt-sections',
        ],
        { cwd, maxBuffer: 32 * 1024 * 1024, timeout: SEAT_CLI_TIMEOUT_MS },
      )
      ms += Date.now() - started
      const env = JSON.parse(stdout) as {
        result?: string
        is_error?: boolean
        total_cost_usd?: number
        usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
      }
      costUsd += env.total_cost_usd ?? 0
      const u = env.usage ?? {}
      usage = {
        promptTokens: usage.promptTokens + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        cachedTokens: usage.cachedTokens + (u.cache_read_input_tokens ?? 0),
        outputTokens: usage.outputTokens + (u.output_tokens ?? 0),
      }
      if (env.is_error || typeof env.result !== 'string' || !env.result.trim()) {
        error = `the CLI returned no answer${env.is_error ? ' and reported an error' : ''}`
        continue
      }
      // The same unwrapping `generateJson` does: a fenced block is not JSON, but
      // it is JSON with a wrapper the model added, and spending a whole retry on
      // punctuation would be wasteful. Haiku fences by default.
      const text = env.result.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
      try {
        const move = validateMove(JSON.parse(text))
        if (move !== null) return { move, usage, attempts: attempt, ms, model: `claude:${tier}`, costUsd }
        error = 'the JSON parsed but did not match the shape asked for'
      } catch (e) {
        error = `did not parse as JSON: ${(e as Error).message}`
      }
    } catch (e) {
      ms += Date.now() - started
      error = `the claude CLI failed: ${(e as Error).message.slice(0, 300)}`
    }
  }
  return { move: null, error, usage, attempts: 2, ms, model: `claude:${tier}`, costUsd }
}

/** How long one seat's message may take before the CLI is given up on. */
const SEAT_CLI_TIMEOUT_MS = 180_000

/** `claude:sonnet` and `claude:haiku` route to the CLI; anything else is DeepSeek. */
export const CLAUDE_SEAT = 'claude:'

export async function nextMove(o: SeatContext & { model: string }): Promise<SeatTurn> {
  const { system, situation } = seatPrompt(o)

  if (o.model.startsWith(CLAUDE_SEAT)) {
    const tier = o.model.slice(CLAUDE_SEAT.length) || 'sonnet'
    const r = await claudeSeat(tier, system, situation)
    const spent = { usage: r.usage, attempts: r.attempts, model: r.model, ms: r.ms, costUsd: r.costUsd }
    if (!r.move) return { move: null, error: r.error ?? 'the seat returned no usable answer', ...spent }
    return { move: r.move, ...spent }
  }

  const res = await generateJson<SeatMove>({
    system,
    messages: [{ role: 'user', content: situation }],
    model: o.model,
    temperature: SEAT_TEMPERATURE,
    thinking: 'off',
    maxOutputTokens: MAX_SEAT_TOKENS,
    validate: validateMove,
  })

  const spent = { usage: res.usage, attempts: res.attempts, model: res.model, ms: res.ms }

  // Two attempts produced nothing usable. Said plainly, with what it cost still
  // attached, and NOT dressed up as somebody who decided to say nothing.
  if (!res.value) {
    return { move: null, error: res.error ?? 'the model returned no usable answer', ...spent }
  }

  return { move: res.value, ...spent }
}

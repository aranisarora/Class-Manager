/**
 * _capture — the one record every instrument in this repo writes, and the only
 * thing any of them decides.
 *
 * WHY THERE IS ONLY ONE OF THESE NOW
 * -----------------------------------------------------------------------------
 * `probe-ask`, `probe-model`, `probe-sql`, `drive` and `sim` each grew
 * their own record shape, their own `--full` flag, their own idea of what was
 * worth keeping, and their own report script to read it back. Six shapes meant
 * six readers, and the readers disagreed: one showed reasoning, one showed SQL,
 * one showed neither and reported a scoreboard instead. A finding visible in one
 * instrument was invisible in the next.
 *
 * Worse, every one of those shapes was a JUDGEMENT about what mattered, taken
 * before the run, by whoever wrote the harness. That is the same mistake as a
 * deterministic check, made one level up: it decides in advance what the
 * interesting part of a turn will be. The failures in this repo's own ledger were
 * never the part anybody predicted — a count that was right for a table that was
 * wrong, a refusal that read as a race, a promise kept by luck.
 *
 * So there is one shape, it holds everything, and it is not optional.
 *
 * WHAT "EVERYTHING" MEANS
 * -----------------------------------------------------------------------------
 *   said        what the person typed, and who they were
 *   intent      what that person was TRYING to do, and why they put it that way —
 *               the half of a turn a record kept none of, and the only way a
 *               later reader can see that somebody had to ask twice
 *   rounds      every round: the model's own reasoning, the prose it drafted,
 *               every tool call with its arguments and its result — UNTRUNCATED,
 *               because `captureFullTrace` lifts the recorder's 4,000-character
 *               cap for the length of the run
 *   sql         every statement the model composed, byte for byte, with what
 *               Postgres answered — including the ones it refused
 *   messages    everything that actually reached a phone in this window, from
 *               this turn OR from a standing job, with buttons and suppressions —
 *               and, when the driver said whose seat this is, nothing another
 *               concurrent turn produced
 *   jobs        what the queue ran, because half of what a promise is worth
 *               happens after the reply
 *   world       the state a judge needs to tell a kept promise from a stated one
 *   cost        tokens, cache, latency, rupees
 *
 * NO FLAGS. There is no `--full`, no `--rows`, no `--quiet`, and no way to ask
 * for less. A run that recorded less than this has to be re-run to be judged, and
 * a re-run is never the same run.
 *
 * FLUSHED AFTER EVERY TURN
 * -----------------------------------------------------------------------------
 * The previous harnesses wrote their records in a `finally` block, so a run that
 * crashed on turn 19 of 30 left nothing on disk and eighteen good turns were
 * thrown away with the bad one. Judging as you go was impossible for the same
 * reason. Every turn here is flushed the moment it completes, so the file on disk
 * is always a complete record of everything that has happened so far.
 *
 * ONE APPENDED LINE PER TURN
 * -----------------------------------------------------------------------------
 * That flush used to BE the write: read `record.json` back, push one turn, write
 * the whole thing out again. A read-modify-write is not something two processes
 * can do to one file, so `scripts/live.ts` serialised every turn behind a lock —
 * a week with four people in it, driven one sentence at a time, because of how
 * the recorder happened to store things.
 *
 * The only thing written while a run walks is now an append of ONE LINE to
 * `turns.jsonl`: a single `appendFile` of `JSON.stringify(turn) + '\n'`, one
 * `write` syscall, which for lines of this length is atomic enough that two
 * appenders interleave whole turns rather than halves of them — four processes
 * appending five turns each landed twenty lines interleaved a c d b b d c c d b
 * a b c a a c d b d a, and not one of them was torn. Nothing is read back in
 * order to decide what to write, so there is nothing to lose. The one thing read
 * is the last byte of the file, and only to close a half-line that a dead process
 * left behind — see `append`.
 *
 * THE TURN NUMBER IS DERIVED, NEVER CLAIMED
 * -----------------------------------------------------------------------------
 * `n` used to be assigned here, at append, from the number of lines already in
 * the log. That is a read and then a write with nothing holding the number in
 * between — the same read-modify-write the lock was removed to get rid of, moved
 * off the record and onto the counter. Four processes appending five turns each
 * to a seeded log produced
 *
 *     n = 51 51 53 54 54 56 57 58 58 60 61 62 63 63 65 66 67 68 69 70
 *
 * — four pairs of turns sharing a number, and 52, 55, 59 and 64 never handed to
 * anything. Every line was whole, so the append itself is atomic; only the number
 * was wrong. `scripts/report.mjs` keys judgements by it —
 * `new Map(judgement.turns.map(t => [Number(t.n), t]))`, then `judged.get(t.n)` —
 * so two turns sharing an `n` are given one verdict, the other judgement is
 * dropped by the Map without a word, and the `id="t<n>"` anchors it links to
 * collide.
 *
 * A number that has to be claimed is a lock. So nothing claims one: a turn is
 * appended carrying a `uid` that needs no coordination, and `n` is APPEND ORDER,
 * assigned by `_derive.ts` when it reads the log back — first line is turn 1.
 * Append order is the only sequence the disk actually witnessed, and it never
 * changes once a line is written, so `n` is stable across re-derives. Turn 23
 * still means the same thing tomorrow, and now it means it under concurrency.
 *
 * `record.json` still exists and still has exactly its old shape, because
 * `scripts/report.mjs` and every other reader open it — but it is DERIVED now
 * (`scripts/_derive.ts`), rebuilt from the log after each turn so a run stays
 * readable while it is still being driven. If two processes race that rebuild,
 * the loser is rewritten by the next turn and no evidence moves: the log is the
 * run, and everything else in the directory can be deleted and made again.
 *
 * WHAT IS DELIBERATELY ABSENT
 * -----------------------------------------------------------------------------
 * Verdicts. There is no `pass`, no `ok`, no `checks`, no `flags`, no score. The
 * record holds evidence and the judgement is written separately, by a reader,
 * into `judgement.json` beside it — see JUDGING.md. The line this file keeps is:
 *
 *     numbers and text are evidence; booleans are verdicts.
 *
 * `writes: 4` belongs here. `backedByWrite: true` does not — it is one reader's
 * opinion about what four writes mean, frozen into the record where the next
 * reader cannot argue with it.
 */
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TURNS_LOG, deriveRun, readRecord, readTurns, writeRecord } from './_derive'

type SqlRecord = import('@/lib/agent/sql-trace').SqlRecord

/**
 * The wire shape of a turn, and the row-to-object mapping under it, live in
 * `lib/turn-record.ts` and are shared with production's own reader.
 *
 * The QUERIES stay here and are deliberately not shared: this file reads a cursor
 * WINDOW and keeps rows whose `turn_id` is null — standing jobs, seeds, repairs —
 * which a lookup by turn id cannot see by definition. Two readers, two questions.
 * What must not be two is the shape, which is exactly the pair ARCHITECTURE.md's
 * trap list means by "two authors of one truth".
 */
export type { Outbound, Changed } from '@/lib/turn-record'

type Outbound = import('@/lib/turn-record').Outbound
type Changed = import('@/lib/turn-record').Changed

const { captureSql } = await import('@/lib/agent/sql-trace')
const { captureFullTrace } = await import('@/lib/agent/turn-trace')
const { mapOutbound, mapChanged } = await import('@/lib/turn-record')

/**
 * One round of the loop, exactly as the flight recorder stored it.
 *
 * Everything past `name` is optional, and that is not laxity — it is what the
 * recorder actually writes. A `(model)` round that produced prose and no call has
 * no `result`; a round read back from an older run may have no `ms`. A type that
 * demanded them would be a type that lies about the file on disk, and the reader
 * would be type-checked into refusing evidence that exists.
 */
export type Round = {
  round: number
  name: string
  /**
   * The product turn this round came out of.
   *
   * `round` restarts at 0 for every product turn, and a queue drain puts several
   * of them in one record, so the number alone cannot say where one handler
   * stopped and the next began. Absent on runs recorded before this was stamped.
   */
  turnId?: string
  ms?: number
  args?: unknown
  result?: unknown
  error?: string
  reasoning?: unknown
}

/** One message that reached — or was stopped from reaching — a phone. */
/**
 * One turn, with everything that happened because of it.
 *
 * Ordering is the sequence and there is no per-record timestamp, for the reason
 * `sql-trace` gives: the array IS the order, and the only clock worth stamping
 * with is the tenant's, which `at` already carries.
 */
export type Turn = {
  /**
   * Position in the run, from 1. The stable handle a judgement refers to.
   *
   * DERIVED from append order, by `_derive.ts`, when the log is read back — it is
   * never claimed by the process that appends the turn, and it is not in the
   * appended line. See the header: claiming it means counting the log and then
   * writing, and two seats counting the same log at the same moment claim the
   * same number.
   */
  n: number
  /**
   * Which appender wrote this line, and its position in that appender's own run
   * of turns — `<pid>-<seq>`.
   *
   * The one identity a turn can carry without coordinating with anybody: two
   * processes appending at the same moment cannot hold the same pid, and the
   * counter separates the turns one process writes. It exists so an appender can
   * find its own line again after the log has been read back and numbered.
   * Optional because turns appended before 20 Aug 2026 do not have it, and
   * neither do the turns a driver assembles in memory and hands to `saveRun`.
   * Nothing orders anything by it.
   */
  uid?: string
  /** The case or beat name, where the driver has one. */
  id: string
  /** Domain time when the turn was posted, in the academy's own clock. */
  at: string
  /**
   * The tenant this turn's evidence was READ as, when the driver named one.
   *
   * Not a label — the reason a field is empty. `cm_service` is not an RLS
   * bypass (`0003_rls.sql`: every service policy is `academy_id =
   * app.academy_id()`), and a founding turn re-enters `runTurn` INSIDE the new
   * tenant (`lib/agent/loop.ts`), so a capture still pinned to the front desk
   * records `reply: null, messages: [], wrote: 0, changed: []` for a turn that
   * in fact answered. Written down so a reader can tell that from a turn that
   * genuinely said nothing.
   */
  academyId?: string | null
  /** Simulated day of the run, where the driver walks days. */
  day?: number
  /**
   * The named slot in the day this turn belongs to — `morning`, `evening`, and
   * whatever else a driver's schedule calls them.
   *
   * `day` alone cannot group a week: three people speaking across one Tuesday are
   * three rows with the same number, and the question a reader has is almost
   * always about a window rather than a day.
   */
  window?: string
  who: string
  persona: string
  /** What the person typed. */
  say: string
  /**
   * What the person was TRYING to do with this message, in their own words, and
   * why they said it that way.
   *
   * Evidence about the human, not about the bot, and it is the half of a turn the
   * record has never held. Without it a reader sees the same question asked twice
   * and cannot tell a person who was misunderstood from a person who changed
   * their mind — and "somebody had to ask twice" is a finding, when you can see
   * it. `personaReasoning` is unknown rather than a string because a driver may
   * hand over a model's whole thinking block, and clipping it to a sentence here
   * would be the harness deciding what mattered again.
   */
  intent?: string
  personaReasoning?: unknown
  /** The screen they answered — see `TurnMeta.phone`. */
  phone?: string
  rounds: Round[]
  sql: SqlRecord[]
  messages: Outbound[]
  /** Every message body this turn produced, joined — the thing the person read. */
  reply: string | null
  buttons: string[]
  /** Title of the affordance the harness pressed, or null if it pressed nothing. */
  tapped: string | null
  /**
   * Jobs the queue ran INSIDE this turn, as `kind:outcome`, handed over by
   * whatever drained them — see `TurnSink`. Empty is the honest value for a turn
   * that drained nothing, and most seat turns drain nothing.
   */
  jobs: string[]
  tokens: { prompt: number; cached: number; output: number }
  inr: number | null
  ms: number
  /** The product's own turn id, so a reading and a measurement can be joined. */
  turnIds: string[]
  /** Rows this turn audited, and messages it put on the wire. Counts, not verdicts. */
  wrote: number
  sent: number
  /**
   * The rows behind that count, both sides — see `Changed`.
   *
   * `wrote` stays a count and keeps its meaning exactly: the number of audit
   * entries in this turn's window. This is what those entries actually did, and
   * it is a list rather than a diff because a diff is a reading and this layer
   * does not read.
   *
   * Optional, and the distinction is load-bearing: `[]` is a turn that changed
   * nothing, and ABSENT is a run recorded before this was collected. Every run
   * in `.probe/archive/runs` is the second, and a required field here would be a
   * type that lies about those files — the same reason everything past `name` on
   * `Round` is optional.
   */
  changed?: Changed[]
  /**
   * What the harness could not collect while assembling this turn, and why.
   *
   * Sentences, never a flag. Four queries here used to end in `.catch(() => [])`,
   * so a turn whose evidence query died came out byte-identical to a turn where
   * the model did nothing: no rounds, no tokens, ₹0, no error. Both are quiet and
   * only one of them is true, and the record could not tell them apart — the
   * repo's own "a green tool result is not evidence" trap, inside the instrument
   * that exists to catch it.
   *
   * This is evidence and not a verdict: it names what failed, in the shape
   * `context.ts` uses for a dead prefetch, and leaves what that means to a reader.
   */
  notes?: string[]
  /**
   * How many of the read-results replayed into this turn's context were CUT
   * before the model saw them.
   *
   * THE ASYMMETRY THIS EXISTS TO STATE
   * ---------------------------------------------------------------------------
   * `recentLookups` (loop.ts) replays recent reads into the tail and clips each
   * one at 1,400 characters, mid-token — measured across every run on disk, 16
   * of them, every single cut landing at exactly 1,417 rendered characters. The
   * SAME reads are recorded in `sql` in full, with `truncated: false`, because
   * that flag describes the log's own copy of the rows and not the model's.
   *
   * So the record was MORE COMPLETE THAN THE MODEL'S OWN CONTEXT, and said
   * nothing about it. A reader sees the whole result, sees the model answer as
   * though it had not, and writes down that the model ignored what it was given
   * — when the model was given 1,400 characters ending inside a UUID. That is
   * the worst kind of blindness an instrument can have: it does not hide a
   * failure, it manufactures one.
   *
   * A count, not a flag, and the cut lines themselves are already in the tail
   * this same round records whole — so a reader who wants to know WHICH read was
   * starved reads them there.
   */
  contextCuts?: number
  /**
   * Every model that ran inside this turn, as the product recorded it.
   *
   * `inr` was priced against `env.MODEL_MAIN` no matter what actually ran, so an
   * A/B arm varying the model priced one arm at the other's rate — in rupees, in
   * an INR-billing product, in the field the run's cost table is summed from.
   */
  models?: string[]
  /**
   * The business, counted either side of the harness's thumb.
   *
   * A tap is not a neutral observer — the button exists to change the world — so
   * for any case whose subject is what the button changes, a single snapshot is
   * measuring the harness rather than the model. Both are kept and the reader
   * picks; `scripts/report.mjs` prints only the counts that moved.
   *
   * Null on a driver that takes no snapshot (`ask` has no world at all), which is
   * why they are nullable rather than optional: absent and "not applicable here"
   * are the same fact, and one of them should not read as a missing field.
   */
  beforeTap?: Record<string, unknown> | null
  afterTap?: Record<string, unknown> | null
  error: string | null
}

/**
 * A turn as it goes onto the wire — everything a turn is, minus the two fields
 * nobody collecting evidence gets to decide. `n` is derived from append order and
 * `uid` is stamped by the append itself.
 */
type TurnBody = Omit<Turn, 'n' | 'uid'>

export type Run = {
  suite: string
  model: string
  startedAt: string
  academyId: string | null
  /** Anything the driver wants a reader to know that the turns cannot say. */
  note?: string
  /**
   * Which arm of a comparison this run is, and what was varied to make it.
   *
   * `probe-model` already ran thinking sweeps as several files in one directory
   * and `.probe/README.md` had to explain, in prose, that two of those runs must
   * never be merged because they are different academies. An arm is a fact about
   * the run and belongs on the run. `variant` is the parameter set that produced
   * it — a model, a prefix revision, a temperature — and it is a PARAMETER, not
   * evidence: it says what was set, never what it was worth.
   */
  arm?: string
  variant?: Record<string, unknown>
  turns: Turn[]
  /** End-of-day or end-of-run counts, for judging consequence. */
  world?: Record<string, unknown>
  days?: unknown[]
  /**
   * Evidence a driver collects that is not a turn and not the world.
   *
   * `scripts/live.ts` puts three things here and each is text or a number, never
   * a verdict: the persona briefs (so a reader can see what the person was
   * *trying* to do before judging whether they got it), every seat command the
   * personas ran (so the blindfold is auditable rather than promised), and what
   * they said about the experience in their own words. A driver with nothing
   * extra to say leaves it absent.
   */
  extra?: Record<string, unknown>
}

type Sql = <T = any>(sql: string) => Promise<T[]>

export type OpenOpts = {
  suite: string
  model: string
  academyId?: string | null
  note?: string
  /** Which arm of a comparison this is, and the parameters that made it — see `Run`. */
  arm?: string
  variant?: Record<string, unknown>
  /** Reads the database as the harness — used only to collect evidence. */
  q: Sql
  /** The tenant's own clock. Host time is never a valid cursor here (F-N). */
  domainNow: () => Promise<Date>
}

/**
 * What a driver hands back about a turn it just drove.
 *
 * `tapped` is the driver's business because only it knows what an affordance
 * means in its own script; everything else is collected here so no driver can
 * forget a field and go quiet about it.
 */
export type TurnMeta = {
  id: string
  who: string
  persona: string
  say: string
  day?: number
  /** The named slot in the day, where the driver has windows — see `Turn`. */
  window?: string
  /** Why the person sent this, in their words. Evidence about them, not the bot. */
  intent?: string
  personaReasoning?: unknown
  tapped?: string | null
  /**
   * WHOSE turn this is, as a contact id — the thing that makes two seats speaking
   * at once attributable.
   *
   * The window below is domain TIME, and time alone cannot tell two concurrent
   * speakers apart. In the first agent week (`2026-08-20-13-17-week-aejx`) Farah
   * and Arjun spoke in the same evening window in two processes; Farah's turn
   * finished in one second and Arjun's in two, so Arjun's window swallowed
   * Farah's reply and her `turn` row — her message, her rounds and her tokens
   * were all recorded against him. Nothing about that is visible afterwards: the
   * record simply says Arjun was sent a price list for two children.
   *
   * A driver that knows whose seat it is says so here and the evidence is scoped
   * to that person. A driver that does not — a queue drain belongs to nobody, and
   * `probe-model` runs one speaker at a time — leaves it absent and gets the
   * time window unchanged.
   */
  contactId?: string | null
  /**
   * The tenant this turn's evidence must be read in, when it is not the run's.
   *
   * A seat's academy is its own contact's and not the run's (`_seat.academyOf`).
   * Handed over rather than inferred, because this layer holds `opts.q` and has
   * no way to ask what tenant it is pinned to.
   */
  academyId?: string | null
  /**
   * EXACTLY what this person's phone showed when they decided what to do.
   *
   * `renderPhone` (`_seat.ts`) builds it, `_persona-agent` calls it "the only
   * thing they can see", and it is the whole stimulus a seat responds to. The
   * record kept the DECISION — `intent`, `personaReasoning` — and threw away the
   * screen that produced it, so a reader looking at "she gave up" could not see
   * what made her.
   *
   * It has to be handed over rather than rebuilt afterwards. The blindfold is
   * five predicates on one query, and `DRIVING.md` names a second copy of it
   * that drops the suppression clause as the way a reader is shown a message the
   * real recipient never received — a reading that is false in a way nothing
   * downstream can catch. So this is the view itself, as it was rendered.
   */
  phone?: string
  /**
   * The business, counted either side of this turn — see `Turn.beforeTap`.
   *
   * `Turn` has declared both since the arc was written and `scripts/report.mjs`
   * renders their difference as "what moved", but until 20 Aug 2026 there was no
   * slot for them HERE, and this type is the whole of what a driver is allowed to
   * hand over. So no driver could fill them and that section of the page was
   * empty on every run ever recorded — including `probe-model`'s, which takes
   * both photographs (`worldSnapshot`, either side of the tap), cannot pass them,
   * and parks them in a `Panel` in `run.extra` instead. A field a driver cannot
   * reach is a field the record does not have.
   *
   * Optional here, never optional on the turn. A driver that takes no snapshot
   * says nothing and the turn records `null`, because "nobody looked" and "there
   * is no world to count here" are the same fact and neither should read as a
   * missing field. Nothing is invented on the way through: the only value this
   * layer ever supplies is the null.
   */
  beforeTap?: Record<string, unknown> | null
  afterTap?: Record<string, unknown> | null
}

/**
 * What a turn collects from the driver WHILE it runs, because it cannot be read
 * back afterwards.
 *
 * `jobs` is the only member and it exists because the `job` table cannot be
 * asked what ran. `run_at` is when a job was DUE, `created_at` is when it was
 * made, and both the live drain and the production runner (`lib/jobs/runner.ts`
 * `finish`) set `locked_at = null` on completion — so after a job finishes, no
 * column on the row carries the moment it ran.
 *
 * This was not a theoretical gap. The window query that used to stand here —
 * `coalesce(locked_at, run_at, created_at) >= cursor and status <> 'pending'` —
 * therefore fell through to `run_at` and listed every already-finished job still
 * scheduled ahead of the cursor. In `2026-08-18-14-38-live` that is 6,912 job
 * strings over 68 turns from **31 distinct values**, 1,324 of them the same
 * `materialize_sessions:done`, shrinking 161 → 66 as the remaining horizon
 * shrank and plateauing on day boundaries. It was rendering the future as though
 * it were the turn.
 *
 * The drain already returns exactly the right answer and always did. This is
 * where it is put, and there is no query to get it wrong.
 */
export type TurnSink = { jobs: string[] }

const stamp = (d: Date): string => d.toISOString().slice(0, 16).replace(/[:T]/g, '-')

/**
 * Four base36 characters that no other run started this minute will have.
 *
 * The pid is most of it, because the collision this closes is between processes;
 * the counter separates two runs opened inside one process, and the random bits
 * cover the case where two machines or two containers hold the same pid.
 */
let opened = 0
const token = (): string => {
  const mix = (process.pid * 0x9e37 + opened++ * 0x1f12 + Math.floor(Math.random() * 0xffff)) >>> 0
  return (mix % 36 ** 4).toString(36).padStart(4, '0')
}

/**
 * The directory this run's evidence lives in, created.
 *
 * One naming rule for every instrument:
 * `.probe/runs/<UTC minute>-<suite>-<token>/`.
 *
 * The date prefix is the whole point — runs supersede each other, and the only
 * question a reader ever has is which one is newest, which sorting the listing
 * answers. That is why the token goes LAST and nowhere else: `scripts/report.mjs`
 * lists runs with a plain lexical `.sort()` and takes the final entry as the
 * newest, so anything ahead of the stamp would silently make `npm run report`
 * render the wrong run.
 *
 * The token exists because the minute is not an identity. Two drives started in
 * the same UTC minute — two arms of one comparison, two seats opened from two
 * shells — produced the same directory name, so the second run mounted the
 * first's directory and its first flush overwrote the first run's `record.json`.
 * Nothing failed and nothing warned; one of the two runs simply was not there
 * afterwards. Concurrency made that likely rather than unlucky.
 *
 * `record.json` is the evidence; `judgement.json`, written later by a reader, is
 * the verdict. Neither file ever contains the other's content.
 */
export async function runDir(suite: string): Promise<string> {
  return newRunDir(suite, new Date())
}

async function newRunDir(suite: string, started: Date): Promise<string> {
  const dir = join('.probe', 'runs', `${stamp(started)}-${suite}-${token()}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Write a run assembled by a driver that has no world to read back — `probe-ask`
 * is toolless by design, so there are no rows, no messages and no jobs, and the
 * evidence is the prose. Same file, same name, same shape, so one reader renders
 * both.
 *
 * A driver like this holds the whole run in memory and hands it over once, so it
 * never appends — but the log is what every derived view is made from, so the
 * turns are seeded into it here and the run gets `index.jsonl`, `turns/` and
 * `by-seat/` on the same terms as a driven one. An existing log is NEVER
 * rewritten: it is the record, and this function's argument is only somebody's
 * copy of it.
 */
export async function saveRun(dir: string, run: Run): Promise<string> {
  const path = join(dir, 'record.json')
  await writeFile(path, JSON.stringify(run, null, 2))
  await seedLog(dir, run.turns)
  if (run.turns.length) await deriveRun(dir).catch(() => {})
  return path
}

/**
 * Put a run's turns into the log, once, for a directory that has none.
 *
 * Two cases, both the same fact: a driver that assembled its turns in memory
 * (`saveRun`), and a run recorded before the log existed that somebody has come
 * back to and wants to keep driving. In both the turns exist and the log does
 * not, and until it does, the derived views would report a run with no turns in
 * it.
 *
 * CREATED WITH `wx`, WHICH IS THE WHOLE POINT. This used to ask `existsSync` and
 * then write, which is a check and a write with a gap between them: two processes
 * calling `reopenRun` on the same pre-existing run — a `record.json`, no log —
 * both saw no log and both wrote every turn into it, and the run came back with
 * its evidence doubled and every position in it counted twice. `wx` fails instead
 * of writing a second copy, and the failure is not an error here: it means
 * somebody else seeded it, and their log is the one that counts. The log is read
 * back either way, so the winner and the loser return the same turns — and a
 * write that fails for some other reason leaves no log at all, which `readTurns`
 * answers from the `record.json` these turns came from.
 *
 * The seeded lines carry no `n`. Their order is preserved exactly, so the turns
 * are numbered exactly as they were — and a number written into a line that
 * `readTurns` overrules is a fact on disk that is not true.
 */
async function seedLog(dir: string, turns: Turn[]): Promise<Turn[]> {
  const log = join(dir, TURNS_LOG)
  const rows = turns.map((t) => {
    const { n: _derived, ...line } = t
    return JSON.stringify(line)
  })
  await writeFile(log, rows.length ? `${rows.join('\n')}\n` : '', { flag: 'wx' }).catch(() => {})
  return readTurns(dir)
}

/**
 * A parameter set, a manifest, a list of goals — beside the record, never inside
 * it.
 *
 *   await writeSidecar(dir, 'config.json', { days: 7, seats: 4 })
 *
 * `record.json` holds what HAPPENED. A config is what was asked for before
 * anything happened, a manifest is what a harness believes it built, and a goals
 * file is what somebody hoped the run would show — none of those are evidence,
 * and a reader who finds them mixed into the turns cannot tell the measurement
 * from the intention behind it. It is the same line `judgement.json` is on the
 * other side of: the verdict is a separate file, and so is the premise.
 */
export async function writeSidecar(dir: string, name: string, data: unknown): Promise<string> {
  const safe = String(name)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+/, '')
    .slice(0, 64)
  const file = safe.includes('.') ? safe : `${safe || 'sidecar'}.json`
  const path = join(dir, file)
  await mkdir(dir, { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2))
  return path
}

/**
 * Open a run. The directory exists from this moment, and every turn lands in it
 * as it happens.
 */
export async function openRun(opts: OpenOpts) {
  const started = new Date()
  const dir = await newRunDir(opts.suite, started)

  const run: Run = {
    suite: opts.suite,
    model: opts.model,
    startedAt: started.toISOString(),
    academyId: opts.academyId ?? null,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.arm ? { arm: opts.arm } : {}),
    ...(opts.variant ? { variant: opts.variant } : {}),
    turns: [],
  }

  return attach(dir, run, opts)
}

/**
 * Re-open a run that a previous PROCESS started, and keep appending to it.
 *
 * `openRun` assumes one long-lived driver holding the record in memory, which is
 * every instrument here except one. `scripts/live.ts` is driven from outside — a
 * persona reads the reply, thinks, and comes back with the next sentence minutes
 * later — so each turn is its own process and the record has to survive between
 * them. Appending to the run that is already on disk is what makes that a single
 * run rather than forty unrelated ones, and it is why the numbering keeps going
 * up rather than restarting: a judgement refers to turn 23, and turn 23 must mean
 * the same thing tomorrow.
 *
 * The file on disk stays the authority. Nothing is held across invocations that
 * is not written down, so a crash between turns costs the turn and not the week.
 *
 * What it reads back changed on 20 Aug 2026 and the reason is the lock: the turns
 * come from `turns.jsonl` now, so re-opening does not have to read a record in
 * order to write one, and two seats can be in here at the same moment. The head —
 * suite, model, the world a previous `close` folded in — still comes from
 * `record.json`, which is where a driver's own fields live and where they stay.
 *
 * A run recorded before the log existed still opens: its turns are in its
 * `record.json`, `seedLog` puts them into the log in the order they are already
 * in, and the numbering falls straight out of that order — turn 23 is the
 * twenty-third line and is still turn 23. A migration that renumbered would break
 * every judgement already written, so nothing here reorders anything.
 */
export async function reopenRun(dir: string, opts: Omit<OpenOpts, 'suite' | 'model'>) {
  const head = ((await readRecord(dir)) ?? {}) as Partial<Run>
  const turns = await seedLog(dir, Array.isArray(head.turns) ? head.turns : [])
  const run: Run = {
    ...head,
    suite: String(head.suite ?? 'run'),
    model: String(head.model ?? ''),
    startedAt: String(head.startedAt ?? new Date().toISOString()),
    academyId: opts.academyId ?? head.academyId ?? null,
    ...(opts.note ? { note: opts.note } : {}),
    ...(opts.arm ? { arm: opts.arm } : {}),
    ...(opts.variant ? { variant: opts.variant } : {}),
    turns,
  }
  return attach(dir, run, { ...opts, suite: run.suite, model: run.model })
}

async function attach(dir: string, run: Run, opts: OpenOpts) {
  const log = join(dir, TURNS_LOG)

  /**
   * Append one turn. One line, one write, and no number.
   *
   * ONE `appendFile` of one line, which is one `write` syscall in `O_APPEND`
   * mode. For lines of this size the kernel does not interleave two of them, so
   * concurrent appenders produce whole turns in some order rather than two halves
   * of a file nobody can parse — and nothing here reads the log to decide what to
   * write, which is the property the old whole-file flush did not have and the
   * property the old line-counting `n` gave straight back. What the turn carries
   * instead is a `uid`, `<pid>-<seq>`, which needs no coordination and is returned
   * so the caller can find its own line once the log has been read back.
   *
   * THE LEADING NEWLINE is the other half of "a dead process must not cost a live
   * one a turn". A process killed mid-append leaves the log ending in half a line,
   * and appending straight onto it glues this turn's JSON to that half: ONE
   * unparseable line where there were two turns, so `readTurns` skips it and the
   * healthy turn is gone for good. A log of three turns ending in half a fourth,
   * appended to five times, came back as eight lines with the half and the first
   * new turn fused into the one line nothing can parse: seven turns readable
   * where there should have been eight, and the missing one is not anywhere else.
   * Terminating the half first costs one read of the last byte, and the same log
   * then comes back as nine lines, eight of them whole — the dead process loses
   * its own turn and nobody else's.
   * Two appenders can both read the same last byte and both prefix it, which
   * leaves an empty line between two turns; `readTurns` skips empty lines, and an
   * empty line has never been evidence.
   */
  const append = async (body: TurnBody): Promise<string> => {
    const uid = `${process.pid}-${++appended}`
    const lead = (await endsMidLine(log)) ? '\n' : ''
    await appendFile(log, `${lead}${JSON.stringify({ ...body, uid })}\n`)
    return uid
  }

  /**
   * Rebuild `record.json` from the log and whatever the driver holds in its head.
   *
   * `run.turns` is replaced by what the log says, never appended to in memory, so
   * the numbering a walking run publishes is the same numbering a later
   * `deriveRun` publishes — both are `readTurns` over the same append order. A
   * record written mid-walk and the record written after the run agree.
   *
   * Derived, so racing it is harmless: two processes write the same bytes from
   * the same log, and a loser is rewritten by the next turn. Only the record is
   * rebuilt per turn — `index.jsonl`, `turns/` and `by-seat/` are rebuilt at
   * `close`, because redoing every per-turn file on every turn is O(n²) writes
   * for a reader who is not there yet. `npm run report` needs `record.json` and
   * that is what it gets, all the way through the run.
   */
  const flush = async (): Promise<void> => {
    run.turns = await readTurns(dir)
    await writeRecord(dir, run, run.turns)
  }
  await flush()

  /**
   * Drive one turn and record all of it.
   *
   * The window is opened on DOMAIN time before `fn` runs and everything stamped
   * at-or-after it is attributed to this turn. That is the cursor probe-sql
   * arrived at the hard way: a host-time cursor against tenant-time rows
   * attributed one case's reply to the two cases after it.
   *
   * `fn` may throw. The turn is still recorded, with the stack in `error` and
   * whatever evidence was collected before it died — a crashed turn is often the
   * most interesting one in a run, and the old harnesses discarded exactly it.
   */
  async function turn(meta: TurnMeta, fn: (t: TurnSink) => Promise<void>): Promise<Turn> {
    const before = await opts.domainNow()
    const cursor = before.toISOString()
    const startedAt = Date.now()
    const sink: TurnSink = { jobs: [] }
    let sql: SqlRecord[] = []
    let error: string | null = null

    /**
     * The throw is caught INSIDE the capture, not around it.
     *
     * `captureSql` collects into a local array and hands it back on its return;
     * a throw that escapes it unwinds through the `finally` that restores the
     * sinks and the array goes with it. So the turn that died recorded `sql: []`
     * — and the header above this function says a crashed turn is often the most
     * interesting one in a run. It was the one turn whose statements were
     * dropped, which is the opposite of what it says.
     *
     * Catching one level in means the capture always closes normally and returns
     * everything the turn got as far as. `error` is set on the way past.
     */
    const got = await captureSql({ rows: true }, () =>
      captureFullTrace(async () => {
        try {
          await fn(sink)
        } catch (e) {
          error = e instanceof Error ? (e.stack ?? e.message) : String(e)
        }
      }),
    )
    sql = got.sql

    /**
     * EVERY turn in the window, oldest first — not the newest one.
     *
     * Tapping a staged plan opens a second turn, so `order by created_at desc
     * limit 1` returns the TAP's trace and throws away the trace of the turn that
     * actually composed the work. Both belong to this beat and both are read.
     */
    /**
     * Every evidence query goes through here, so a failure is recorded instead
     * of becoming an empty array that reads as "nothing happened".
     */
    const notes: string[] = []
    const ask = async <T>(what: string, statement: string): Promise<T[]> =>
      opts.q<T>(statement).catch((e) => {
        notes.push(`${what} could not be read: ${e instanceof Error ? e.message : String(e)}`)
        return [] as T[]
      })

    /**
     * Did this turn's work happen somewhere this record cannot see?
     *
     * Every statement the model composed carries the tenant it ran under
     * (`SqlRecord.academyId`), and the evidence queries below run under exactly
     * one. When they disagree, every count on this turn is a FLOOR rather than a
     * fact: the rows are not missing from the run, they are missing from the
     * record. The founding turn is the case this was written for and it is not
     * the only one — a seat left holding a contact in another tenant is the
     * whole rest of a bad week.
     *
     * A note, never a throw and never a flag. Nothing in an instrument scores
     * anything: this names what happened and leaves the reading to a reader.
     */
    const scope = meta.academyId ?? opts.academyId ?? null
    const strayed = [
      ...new Set(sql.map((r) => r.academyId).filter((a): a is string => !!a && a !== scope)),
    ]
    if (scope && strayed.length) {
      notes.push(
        `this turn ran statements in ${strayed.join(', ')} but its evidence was read as ${scope}: ` +
          'cm_service is not an RLS bypass, so any reply, turn row or audit row written in another ' +
          'tenant is missing from this record rather than absent from the run.',
      )
    }

    const mine = meta.contactId ? `and contact_id = '${meta.contactId}'::uuid` : ''
    const turnRows = await ask<any>(
      'the turn rows',
      `select id::text, tool_calls, prompt_tokens, cached_tokens, output_tokens, error,
              model, created_at
         from turn where created_at >= '${cursor}'::timestamptz ${mine}
        order by created_at asc`,
    )

    /**
     * What this turn's own turn rows produced, for scoping the two tables that
     * carry a `turn_id`.
     *
     * `message.turn_id` (0019) and `audit_entry.turn_id` (0015) are stamped by the
     * DATABASE from the `app.turn_id` GUC, not by a caller, so no send path can
     * forget them — which is what makes them safe to filter on. A null is the
     * truth for a standing job, a seed or a repair script, and those rows stay in
     * the window: they belong to nobody else's turn either, and dropping them
     * would lose the unprompted half of what this product says.
     */
    const ids = turnRows.map((t: any) => `'${String(t.id)}'::uuid`)
    const owned = (col: string): string =>
      !meta.contactId
        ? ''
        : ids.length
          ? `and (${col} is null or ${col} in (${ids.join(', ')}))`
          : `and ${col} is null`

    /**
     * Every round, stamped with the product turn it came out of.
     *
     * WHY THE STAMP IS NOT OPTIONAL EVIDENCE
     * -------------------------------------------------------------------------
     * This flattens the traces of EVERY `turn` row in the window into one array,
     * and for a seat beat that is right — a tap opens a second turn and both
     * halves are one thing somebody did. For a queue drain it is not: several
     * unrelated job handlers land in one array with nothing between them.
     *
     * Measured on `2026-08-20-18-00-sim-s71s` turn 50: `who: queue`, four
     * `turnIds`, thirty rounds, and `MAX_TOOL_ROUNDS` is five. The only way to
     * tell where one handler ended was to watch the round counter reset — and
     * that does not work either, because the sequence runs
     * `… 2, 2, 3, 2, 0, 1 …`. So for the proactive surface, which is about 70% of
     * what this product says, nobody could say which job produced which
     * reasoning or which query.
     *
     * `round` restarts per product turn and is therefore not an identity.
     * `turnId` is, it is already on the row being read, and it costs one field.
     */
    const rounds: Round[] = turnRows.flatMap((t: any) => {
      const own: Round[] = Array.isArray(t?.tool_calls)
        ? (t.tool_calls as Round[])
        : typeof t?.tool_calls === 'string'
          ? safeParse(t.tool_calls)
          : []
      const turnId = String(t?.id ?? '')
      return turnId ? own.map((r) => ({ ...r, turnId })) : own
    })

    const messages = await ask<any>(
      'the outbound messages',
      `select c.phone_e164 as to, m.body, m.payload, m.status, m.origin, m.suppressed_reason,
              m.turn_id::text as turn_id
         from message m left join contact c on c.id = m.contact_id
        where m.direction = 'outbound' and m.created_at >= '${cursor}'::timestamptz
          ${owned('m.turn_id')}
        order by m.created_at asc`,
    )

    const out: Outbound[] = messages.map((m: any) => mapOutbound(m))

    /**
     * What changed, both sides, and the count in one pass.
     *
     * A LEFT join, so an audit entry that photographed nothing still returns its
     * row and still counts toward `wrote`. `wrote` is therefore the number of
     * DISTINCT audit entries, which is what the `count(*)` it replaced meant —
     * the number does not move because this query arrived.
     *
     * Ordered by `row_snapshot.seq`, the column 0005 added for exactly this: the
     * images of one act are read back in the order the trigger wrote them, so a
     * cascade reads as the sequence it was rather than as a set.
     */
    const audited = await ask<any>(
      'what changed',
      `select a.id::text as audit_id, a.intent,
              s.table_name, s.pk::text as pk, s.op, s.before, s.after
         from audit_entry a
         left join row_snapshot s on s.audit_id = a.id
        where a.created_at >= '${cursor}'::timestamptz ${owned('a.turn_id')}
        order by a.created_at asc, s.seq asc`,
    )

    const changed: Changed[] = mapChanged(audited)

    const wrote = new Set(audited.map((r: any) => String(r.audit_id))).size

    const tokens = {
      prompt: turnRows.reduce((a: number, t: any) => a + Number(t?.prompt_tokens ?? 0), 0),
      cached: turnRows.reduce((a: number, t: any) => a + Number(t?.cached_tokens ?? 0), 0),
      output: turnRows.reduce((a: number, t: any) => a + Number(t?.output_tokens ?? 0), 0),
    }

    /**
     * Counted off the recorded context itself rather than reported by the loop,
     * so it stays true for any round that renders a clipped value into the tail
     * — this is a property of what the model was handed, and the tail is the
     * record of exactly that.
     */
    const contextCuts = rounds.reduce((n: number, r: Round) => {
      const tail = (r as any)?.args?.tail
      return typeof tail === 'string' ? n + (tail.match(/… \(truncated\)/g)?.length ?? 0) : n
    }, 0)

    const priced = turnRows.map((t: any) => ({
      model: t?.model,
      created_at: t?.created_at,
      prompt: Number(t?.prompt_tokens ?? 0),
      cached: Number(t?.cached_tokens ?? 0),
      output: Number(t?.output_tokens ?? 0),
    }))
    const models = [...new Set(turnRows.map((t: any) => String(t?.model ?? '')).filter(Boolean))]

    const body: TurnBody = {
      id: meta.id,
      at: cursor,
      ...(scope === null ? {} : { academyId: scope }),
      ...(meta.day === undefined ? {} : { day: meta.day }),
      ...(meta.window === undefined ? {} : { window: meta.window }),
      who: meta.who,
      persona: meta.persona,
      say: meta.say,
      ...(meta.intent === undefined ? {} : { intent: meta.intent }),
      ...(meta.personaReasoning === undefined ? {} : { personaReasoning: meta.personaReasoning }),
      ...(meta.phone === undefined ? {} : { phone: meta.phone }),
      rounds,
      sql,
      messages: out,
      reply: out.filter((m) => !m.suppressedReason).map((m) => m.body).join('\n---\n') || null,
      buttons: out.flatMap((m) => m.buttons),
      tapped: meta.tapped ?? null,
      jobs: sink.jobs,
      tokens,
      inr: await costOf(priced),
      ...(models.length ? { models } : {}),
      ms: Date.now() - startedAt,
      turnIds: turnRows.map((t: any) => String(t.id)),
      wrote,
      sent: out.filter((m) => !m.suppressedReason).length,
      changed,
      // Spread in only when something failed, so a clean turn carries no field
      // rather than an empty array that a reader has to look at to dismiss.
      ...(notes.length ? { notes } : {}),
      ...(contextCuts ? { contextCuts } : {}),
      // Written on every turn, null included — not spread in only when a driver
      // has one. `Turn` is explicit that these are nullable rather than optional
      // so that a driver with no world to count (`ask` has none at all) records
      // the fact instead of leaving a hole, and a hole is what every turn had
      // while the slot above did not exist.
      beforeTap: meta.beforeTap ?? null,
      afterTap: meta.afterTap ?? null,
      error: error ?? (turnRows.find((t: any) => t?.error)?.error ?? null),
    }

    const uid = await append(body)
    await flush()

    /**
     * The turn as the LOG numbers it, found by the uid this process stamped on
     * it. The number is read back rather than predicted, because this process
     * does not know how many turns another seat appended while this one was
     * talking to the model — predicting it is what produced two turns numbered 51.
     *
     * The fallback is only reachable if a line this process just wrote whole was
     * not in the log it read a moment later, and it says the one thing that is
     * still true then: the turn is somewhere past everything the read did see.
     */
    return run.turns.find((t) => t.uid === uid) ?? ({ ...body, uid, n: run.turns.length + 1 } as Turn)
  }

  /**
   * Close the run, folding in whatever end-state the driver collected.
   *
   * The derived views are built here — and their failure is caught, because they
   * are made from the log and can be made again by `deriveRun` at any time. A run
   * that survived a week must not be lost at the last step to a file that could
   * have been rebuilt from the file beside it.
   */
  async function close(
    tail: { world?: Record<string, unknown>; days?: unknown[]; extra?: Record<string, unknown> } = {},
  ) {
    if (tail.world) run.world = tail.world
    if (tail.days) run.days = tail.days
    if (tail.extra) run.extra = { ...(run.extra ?? {}), ...tail.extra }
    await flush()
    await deriveRun(dir).catch(() => {})
    return { dir, run }
  }

  return { dir, run, turn, close }
}

/**
 * How many turns this process has appended, over every run it has open.
 *
 * Half of a `uid`, and the half that separates two turns one process wrote. It
 * counts per process rather than per run because that is the only counter that
 * needs no file and no coordination — which is the entire reason `uid` exists.
 */
let appended = 0

/**
 * True when the log's last byte is not a newline — a line somebody started
 * writing and did not finish.
 *
 * One `open` and one one-byte `read` at the end of the file. It is a read, but it
 * is not a read of what to write: the answer changes nothing about the turn, only
 * whether the line before it gets terminated. A file that is not there and a file
 * with nothing in it both answer false, because the first append starts the file.
 */
async function endsMidLine(path: string): Promise<boolean> {
  const fh = await open(path, 'r').catch(() => null)
  if (!fh) return false
  try {
    const { size } = await fh.stat()
    if (size === 0) return false
    const last = Buffer.alloc(1)
    await fh.read(last, 0, 1, size - 1)
    return last[0] !== 0x0a
  } catch {
    return false
  } finally {
    await fh.close().catch(() => {})
  }
}

function safeParse(s: string): Round[] {
  try {
    const p = JSON.parse(s)
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

/**
 * Rupees, not dollars — this is an INR-billing product and a cost nobody can
 * compare to their own bill is a cost nobody reads.
 *
 * Priced PER TURN ROW, at the model that row says it ran and the instant it ran
 * at. Two bugs died together when this stopped being one call over the summed
 * tokens:
 *
 *   - the model was `env.MODEL_MAIN` whatever had actually run, so an A/B arm
 *     varying the model recorded the other arm's rate;
 *   - `costInr`'s `at` argument was never passed by anything, and `costUsd`
 *     applies `peakMultiplier` only `at && isPeak(at)` — so the peak rate had
 *     never once applied to a recorded run, on any instrument, ever.
 *
 * `null` still means "we do not know", never "it was free": one unpriceable row
 * makes the turn unpriceable rather than quietly cheap, which is the rule
 * `lib/pricing.ts` states for its own return.
 */
async function costOf(
  rows: Array<{ model?: unknown; created_at?: unknown; prompt: number; cached: number; output: number }>,
): Promise<number | null> {
  if (!rows.length) return 0
  try {
    const { costInr } = await import('@/lib/pricing')
    const { env } = await import('@/lib/env')
    let total = 0
    for (const r of rows) {
      const at = r.created_at ? new Date(String(r.created_at)) : undefined
      const one = costInr(
        String(r.model ?? env.MODEL_MAIN),
        r.prompt,
        r.cached,
        r.output,
        at && Number.isFinite(at.getTime()) ? at : undefined,
      )
      if (one === null) return null
      total += one
    }
    return total
  } catch {
    return null
  }
}

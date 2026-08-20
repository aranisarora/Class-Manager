/**
 * _capture — the one record every instrument in this repo writes, and the only
 * thing any of them decides.
 *
 * WHY THERE IS ONLY ONE OF THESE NOW
 * -----------------------------------------------------------------------------
 * `probe-ask`, `probe-model`, `probe-sql`, `drive` and `drive-week` each grew
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
 *               this turn OR from a standing job, with buttons and suppressions
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

const { captureSql } = await import('@/lib/agent/sql-trace')
const { captureFullTrace } = await import('@/lib/agent/turn-trace')

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
  ms?: number
  args?: unknown
  result?: unknown
  error?: string
  reasoning?: unknown
}

/** One message that reached — or was stopped from reaching — a phone. */
export type Outbound = {
  to: string | null
  body: string
  buttons: string[]
  status: string
  /** `turn`, `job`, `tap` or `system` — what put it on the wire (0032). */
  origin: string | null
  suppressedReason: string | null
}

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

    try {
      const got = await captureSql({ rows: true }, () => captureFullTrace(() => fn(sink)))
      sql = got.sql
    } catch (e) {
      error = e instanceof Error ? (e.stack ?? e.message) : String(e)
    }

    /**
     * EVERY turn in the window, oldest first — not the newest one.
     *
     * Tapping a staged plan opens a second turn, so `order by created_at desc
     * limit 1` returns the TAP's trace and throws away the trace of the turn that
     * actually composed the work. Both belong to this beat and both are read.
     */
    const turnRows = await opts
      .q<any>(
        `select id::text, tool_calls, prompt_tokens, cached_tokens, output_tokens, error
           from turn where created_at >= '${cursor}'::timestamptz order by created_at asc`,
      )
      .catch(() => [] as any[])

    const rounds: Round[] = turnRows.flatMap((t: any) =>
      Array.isArray(t?.tool_calls)
        ? (t.tool_calls as Round[])
        : typeof t?.tool_calls === 'string'
          ? safeParse(t.tool_calls)
          : [],
    )

    const messages = await opts
      .q<any>(
        `select c.phone_e164 as to, m.body, m.payload, m.status, m.origin, m.suppressed_reason
           from message m left join contact c on c.id = m.contact_id
          where m.direction = 'outbound' and m.created_at >= '${cursor}'::timestamptz
          order by m.created_at asc`,
      )
      .catch(() => [] as any[])

    const out: Outbound[] = messages.map((m: any) => ({
      to: m.to ?? null,
      body: String(m.body ?? ''),
      buttons: Array.isArray(m.payload?.buttons)
        ? m.payload.buttons.map((b: any) => String(b?.title ?? ''))
        : [],
      status: String(m.status ?? ''),
      origin: m.origin ?? null,
      suppressedReason: m.suppressed_reason ?? null,
    }))

    const wrote = await opts
      .q<any>(
        `select count(*)::int as n from audit_entry where created_at >= '${cursor}'::timestamptz`,
      )
      .catch(() => [{ n: 0 }])

    const tokens = {
      prompt: turnRows.reduce((a: number, t: any) => a + Number(t?.prompt_tokens ?? 0), 0),
      cached: turnRows.reduce((a: number, t: any) => a + Number(t?.cached_tokens ?? 0), 0),
      output: turnRows.reduce((a: number, t: any) => a + Number(t?.output_tokens ?? 0), 0),
    }

    const body: TurnBody = {
      id: meta.id,
      at: cursor,
      ...(meta.day === undefined ? {} : { day: meta.day }),
      ...(meta.window === undefined ? {} : { window: meta.window }),
      who: meta.who,
      persona: meta.persona,
      say: meta.say,
      ...(meta.intent === undefined ? {} : { intent: meta.intent }),
      ...(meta.personaReasoning === undefined ? {} : { personaReasoning: meta.personaReasoning }),
      rounds,
      sql,
      messages: out,
      reply: out.filter((m) => !m.suppressedReason).map((m) => m.body).join('\n---\n') || null,
      buttons: out.flatMap((m) => m.buttons),
      tapped: meta.tapped ?? null,
      jobs: sink.jobs,
      tokens,
      inr: await costOf(tokens),
      ms: Date.now() - startedAt,
      turnIds: turnRows.map((t: any) => String(t.id)),
      wrote: Number(wrote[0]?.n ?? 0),
      sent: out.filter((m) => !m.suppressedReason).length,
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
 */
async function costOf(t: { prompt: number; cached: number; output: number }): Promise<number | null> {
  try {
    const { costInr } = await import('@/lib/pricing')
    const { env } = await import('@/lib/env')
    return costInr(env.MODEL_MAIN, t.prompt, t.cached, t.output)
  } catch {
    return null
  }
}

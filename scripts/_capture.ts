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
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  /** Position in the run, from 1. The stable handle a judgement refers to. */
  n: number
  /** The case or beat name, where the driver has one. */
  id: string
  /** Domain time when the turn was posted, in the academy's own clock. */
  at: string
  /** Simulated day of the run, where the driver walks days. */
  day?: number
  who: string
  persona: string
  /** What the person typed. */
  say: string
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

export type Run = {
  suite: string
  model: string
  startedAt: string
  academyId: string | null
  /** Anything the driver wants a reader to know that the turns cannot say. */
  note?: string
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
 * The directory this run's evidence lives in, created.
 *
 * One naming rule for every instrument: `.probe/runs/<UTC minute>-<suite>/`. The
 * date prefix is the whole point — runs supersede each other, and the only
 * question a reader ever has is which one is newest, which sorting the listing
 * answers. `record.json` is the evidence; `judgement.json`, written later by a
 * reader, is the verdict. Neither file ever contains the other's content.
 */
export async function runDir(suite: string): Promise<string> {
  const dir = join('.probe', 'runs', `${stamp(new Date())}-${suite}`)
  await mkdir(dir, { recursive: true })
  return dir
}

/**
 * Write a run assembled by a driver that has no world to read back — `probe-ask`
 * is toolless by design, so there are no rows, no messages and no jobs, and the
 * evidence is the prose. Same file, same name, same shape, so one reader renders
 * both.
 */
export async function saveRun(dir: string, run: Run): Promise<string> {
  const path = join(dir, 'record.json')
  await writeFile(path, JSON.stringify(run, null, 2))
  return path
}

/**
 * Open a run. The directory exists from this moment, and every turn lands in it
 * as it happens.
 */
export async function openRun(opts: OpenOpts) {
  const started = new Date()
  const dir = join('.probe', 'runs', `${stamp(started)}-${opts.suite}`)
  await mkdir(dir, { recursive: true })

  const run: Run = {
    suite: opts.suite,
    model: opts.model,
    startedAt: started.toISOString(),
    academyId: opts.academyId ?? null,
    ...(opts.note ? { note: opts.note } : {}),
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
 * them. Reading `record.json` back and appending is what makes that a single run
 * rather than forty unrelated ones, and it is why `n` keeps counting: a judgement
 * refers to turn 23, and turn 23 must mean the same thing tomorrow.
 *
 * The file on disk stays the authority. Nothing is held across invocations that
 * is not written down, so a crash between turns costs the turn and not the week.
 */
export async function reopenRun(dir: string, opts: Omit<OpenOpts, 'suite' | 'model'>) {
  const run = JSON.parse(await readFile(join(dir, 'record.json'), 'utf8')) as Run
  if (!Array.isArray(run.turns)) run.turns = []
  if (opts.academyId) run.academyId = opts.academyId
  if (opts.note) run.note = opts.note
  return attach(dir, run, { ...opts, suite: run.suite, model: run.model })
}

async function attach(dir: string, run: Run, opts: OpenOpts) {
  const flush = async (): Promise<void> => {
    await writeFile(join(dir, 'record.json'), JSON.stringify(run, null, 2))
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

    const record: Turn = {
      n: run.turns.length + 1,
      id: meta.id,
      at: cursor,
      ...(meta.day === undefined ? {} : { day: meta.day }),
      who: meta.who,
      persona: meta.persona,
      say: meta.say,
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

    run.turns.push(record)
    await flush()
    return record
  }

  /** Close the run, folding in whatever end-state the driver collected. */
  async function close(
    tail: { world?: Record<string, unknown>; days?: unknown[]; extra?: Record<string, unknown> } = {},
  ) {
    if (tail.world) run.world = tail.world
    if (tail.days) run.days = tail.days
    if (tail.extra) run.extra = { ...(run.extra ?? {}), ...tail.extra }
    await flush()
    return { dir, run }
  }

  return { dir, run, turn, close }
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

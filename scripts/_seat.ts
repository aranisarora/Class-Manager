/**
 * _seat — one persona, one phone, and nothing else. The seat the human
 * instrument and the agent week both sit in.
 *
 *   import { readSession, drive, readPhone, renderPhone, walkTo } from './_seat'
 *
 *   const s = await readSession()
 *   const seen = await drive(s, 'rahul', { say: 'who is in today', kind: 'say' },
 *     () => inboundFromContact({ contactId: s.contacts.rahul!, text: 'who is in today' }))
 *   console.log(renderPhone(seen))
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * `scripts/live.ts` is a person in this seat; the week that is coming is an
 * agent in the same one. Until this file they were going to be two copies of the
 * blindfold, and the blindfold is not a convention — it is five predicates on one
 * query (outbound, this contact, past this person's own cursor,
 * `suppressed_reason is null`, `status <> 'failed'`) and a cursor advanced in
 * exactly one place. A second copy that drops the suppression clause shows its
 * reader a message the real recipient never received, and the reading built on
 * it — "she was told and she still did not pay" — is false in a way nothing
 * downstream can catch, because both runs record the same rows and only the
 * WRITE-UP is wrong.
 *
 * So the seat is one implementation. What sits in it is the variable.
 *
 * ONE PROCESS PER SEAT, WHICH IS NOT A SIMPLIFICATION WAITING TO HAPPEN
 * -----------------------------------------------------------------------------
 * Two seats may speak at the same time, and they do it in two OS processes.
 *
 * The original reason was `captureSql` (lib/agent/sql-trace.ts), which collected
 * a turn's statements into MODULE-LEVEL state: it saved `sink`, `withRows` and
 * `live`, swapped in its own collector, and restored them in a `finally`. Two
 * turns awaiting the model inside one process therefore did this: the second
 * capture opened with the first's collector as its `priorSink`, so every
 * statement the second turn wrote was pushed into the FIRST turn's record too;
 * and when the first turn finished it restored `sink` to what was open before IT
 * started — null — so the second turn silently stopped collecting anything for
 * the rest of its life. One record with another turn's SQL in it, one record
 * missing its own. Both looked complete. Nothing threw.
 *
 * **That hazard is closed** (0045's work): a capture now lives in async-local
 * storage, scoped to the context that opened it, so two turns in one process
 * cannot reach each other's list. It had to be — Fluid Compute reuses one
 * function instance across concurrent requests, so the deployed product was
 * exposed to it too, and the product now opens a capture per turn.
 *
 * The rule survives the reason, on the two grounds that were never about SQL:
 * the seat's cursor is a FILE rather than a field, and a turn is an APPEND to
 * `turns.jsonl` rather than a rewrite (`_capture.ts`). Both are how two seats
 * stay honest without sharing memory, and both are why `Promise.all` over four
 * seats in one process is not a tidier version of this. Nothing in this file may
 * assume it can see another seat's memory.
 *
 * A CURSOR PER PERSONA, WHICH IS BETTER THAN A LOCK
 * -----------------------------------------------------------------------------
 * `readPhone` advances a high-water mark so a person is shown what has arrived
 * since they last looked. That mark used to live in `session.json` beside
 * everybody else's, so showing farah her phone was a read-modify-write of a blob
 * holding rahul's mark as well. Two seats finishing at the same moment, and one
 * writes back a copy of the file that predates the other's advance: the loser's
 * cursor goes BACKWARDS and their next look re-shows what they have already
 * read, or — if it was the older write that survived — jumps past messages they
 * never saw at all.
 *
 * Neither is an error. Nothing fails, nothing is logged, and the damage is to
 * the BLINDFOLD rather than to the record, so no gate in this repo can see it:
 * what it produces is a reader writing down "it sent me the same thing twice" or
 * "nobody ever told me", and both go into the ledger as product defects that do
 * not exist.
 *
 * One file per persona under `cursors/`, holding one timestamp. A seat writes
 * only its own, so there is no shared mutable state left to lose — which beats
 * locking it, because a lock has to be taken correctly at every call site and a
 * file nobody else writes cannot be taken incorrectly.
 *
 * WHAT THE LOCK IS STILL FOR
 * -----------------------------------------------------------------------------
 * Global mutable state, held for as long as the write takes and not one step
 * longer. Two things are left. `session.json`'s `day` is still a read-modify-
 * write and `updateSession` takes the lock around it for the milliseconds that
 * costs. The academy clock is the other, and `walkTo` does NOT take the lock
 * itself — its caller does, because the caller is the one that knows a walk is a
 * walk (`scripts/live.ts`'s `window` and `endday`), and two walks interleaved
 * would each advance past the other's target.
 *
 * It is NOT held around a turn any more. It was, and it cost a week with four
 * people in it thirty seconds of queueing per sentence — for a record shape that
 * no longer exists, because `_capture.ts` appends one line per turn and derives
 * the numbering.
 */
import { existsSync, statSync } from 'node:fs'
import { appendFile, mkdir, open as openFile, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadEnvFiles } from './_env'

loadEnvFiles()
/**
 * Forced here as well as in `scripts/live.ts`, because either file can be the
 * process's entry point and a static importer's body has not run yet when this
 * one does. `.env.local` ships `TRANSPORT=cloud`; a seat that takes the cloud
 * path hard-fails at the credential gate, and every turn then reports an error,
 * zero tools and an empty reply — which reads exactly like a broken model.
 */
process.env.TRANSPORT = 'emulator'

const { withSession } = await import('@/lib/db')
const clock = await import('@/lib/clock')
const { HANDLERS, JobSkip, planAheadFor } = await import('@/lib/jobs')
const { msOf } = await import('@/lib/jobs/util')
const { reopenRun } = await import('./_capture')
const { phonebookLookup, phonebookNames } = await import('@/lib/phonebook')

export const TZ = 'Asia/Kolkata'
/** Where a live run's pointer and lock live. One per checkout, not one per run. */
export const SEAT_HOME = join('.probe', 'live')
/** The file naming the run directory currently open. One line, no newline. */
export const POINTER = join(SEAT_HOME, 'current')
const LOCK = join(SEAT_HOME, 'turn.lock')

/**
 * What a seat needs to know to sit down, and nothing about what it will say.
 *
 * `cursor` is the pre-20-Aug-2026 map and is READ but never written — see the
 * header. A session opened before the per-persona files existed still resolves
 * every mark from it, and the first advance moves that persona onto its own file.
 */
export type Session = {
  dir: string
  academyId: string
  days: number
  day: number
  contacts: Record<string, string>
  roster: {
    name: string
    role: string
    contactId: string
    phone: string
    /**
     * The tenant THIS person's contact lives in, which is not always the run's.
     *
     * Optional only because a `session.json` written before 21 Aug 2026 has no
     * such field; `academyOf` falls back to `s.academyId`, which is exactly what
     * those runs assumed.
     */
    academyId?: string
    /**
     * The seat key this row answers to. Optional for the same era reason as
     * `academyId`; readers fall back to deriving it from the name — which is
     * wrong exactly when a product-created stranger shares a cast name and got a
     * suffixed key, so writers always fill it.
     */
    key?: string
  }[]
  /**
   * The withheld cast: the world's people the product has not reached yet.
   * Their names seed every seat's contact book (`seatContacts`), so "add Kiran"
   * is a card-share carrying a real allocated number rather than an invented
   * one. A cast member leaves the book the moment a roster row holds their
   * phone — from then on they are a person the product knows.
   */
  cast?: { name: string; seat: string; phone: string; key: string; arrives?: number }[]
  /** Legacy: per persona, the `created_at` of the last message their phone showed. */
  cursor?: Record<string, string>
  startedAt: string
}

/** One message as a phone shows it: what it said, and what could be pressed. */
export type Seen = {
  at: string
  body: string
  buttons: string[]
  listButton: string | null
  listRows: { title: string; description: string | null }[]
  link: string | null
}

/**
 * What the seat did, and what the record should call it.
 *
 * `window`, `intent` and `personaReasoning` are what an agent in the seat has and
 * a person in it does not: a machine can say why it typed that, and `_capture.ts`
 * keeps the answer (see `Turn.intent`). Absent from a human seat, and absent from
 * the appended line when absent here.
 */
export type SeatMeta = {
  say: string
  kind: 'say' | 'tap'
  window?: string
  intent?: string
  personaReasoning?: unknown
  /** What their phone showed when they decided this — see `TurnMeta.phone`. */
  phone?: string
  /**
   * Who this is and what they are to the business, when the caller knows and
   * `PERSONAS` cannot — a seat composed from a world spec. See `drive()`.
   */
  who?: string
  seat?: import('./_personas').SeatRole
}

/* ---------------------------------------------------------------- plumbing */

/** The database as the harness — service role, tenant GUC set. Evidence only. */
export const q = async <T = any>(academyId: string, sql: string): Promise<T[]> =>
  withSession({ role: 'service', academyId }, async (tx) => (await tx.unsafe(sql)) as unknown as T[])

/**
 * The tenant THIS SEAT's own contact lives in, which is not always the run's.
 *
 * `cm_service` is not an RLS bypass: every service policy in `0003_rls.sql` is
 * `academy_id = app.academy_id()`, so a statement run under the wrong tenant
 * returns zero rows, with no error and no note. A run opens at a front desk and
 * ONE person founds a business inside it — their contact moves and everybody
 * else's does not. Reading a seat's phone under the business's GUC while they
 * still hold a front-desk contact is not "a quiet week": it is a query that
 * cannot match, and in the record the two are byte-identical.
 *
 * Resolved by contact id rather than by name, so it needs no second copy of
 * `keyOf` and cannot disagree with `session.contacts` — both move together.
 */
/**
 * THE CONTACT BOOK A SEAT ACTUALLY HOLDS: the world's own people first, then the
 * derived pool.
 *
 * The pool (`lib/phonebook.ts`) is strangers — names the business knows and the
 * product does not, numbers derived so no two tenants ever share one. What it
 * could never hold was the world's OWN people: the founder's coach, the family
 * he means to enrol. So "add Kiran" had exactly one path — typing a number —
 * and the seat model, forbidden from seeing numbers, invented one; the run then
 * spent four days on a person the harness had manufactured. The withheld cast
 * closes that path the way a real handset does: those people are IN the phone,
 * card-shareable, at the numbers `buildWorld` really allocated them.
 *
 * A cast member leaves the book the moment any roster row holds their phone —
 * the same contract the pool has always had ("nobody in this book exists in the
 * database"), because from then on sharing them is describing somebody the
 * product already knows. Names only ever reach a seat; the numbers stay here.
 */
function unseatedCast(s: Session): { name: string; phone: string }[] {
  const seated = new Set(s.roster.map((r) => r.phone))
  return (s.cast ?? []).filter((p) => !seated.has(p.phone)).map(({ name, phone }) => ({ name, phone }))
}

export function seatContacts(s: Session): string[] {
  const cast = unseatedCast(s)
  const taken = new Set(cast.map((p) => p.name.toLowerCase()))
  return [...cast.map((p) => p.name), ...phonebookNames(s.academyId).filter((n) => !taken.has(n.toLowerCase()))]
}

/** A name to a card — the cast first, the pool behind it. Same semantics as `phonebookLookup`. */
export function seatContactLookup(s: Session, name: string): { name: string; phone: string } | null {
  const want = name.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!want) return null
  const cast = unseatedCast(s)
  const exact = cast.filter((e) => e.name.toLowerCase() === want)
  if (exact.length === 1) return exact[0]!
  if (exact.length > 1) return null
  const partial = cast.filter((e) => {
    const full = e.name.toLowerCase()
    return full.startsWith(`${want} `) || full.endsWith(` ${want}`) || full.includes(` ${want} `)
  })
  if (partial.length === 1) return partial[0]!
  if (partial.length > 1) return null
  return phonebookLookup(s.academyId, name)
}

export function academyOf(s: Session, key: string): string {
  const contactId = s.contacts[key]
  const seat = contactId ? s.roster.find((r) => r.contactId === contactId) : undefined
  return seat?.academyId ?? s.academyId
}

export function die(msg: string): never {
  console.error(`  ${msg}`)
  process.exit(2)
}

export async function readSession(): Promise<Session> {
  if (!existsSync(POINTER)) die('no live run is open. Start one with:  npx tsx scripts/live.ts open')
  const dir = (await readFile(POINTER, 'utf8')).trim()
  return JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as Session
}

/** Write the session as it stands. For `open`, where nothing else exists yet. */
export async function writeSession(s: Session): Promise<void> {
  await writeFile(join(s.dir, 'session.json'), JSON.stringify(s, null, 2))
}

/**
 * Change one field of the session under the lock, and hand back what is now on
 * disk.
 *
 * The last read-modify-write in the seat, and the only thing the lock is held
 * for on this file. It is a whole-blob rewrite, so a caller that mutates a copy
 * it read a minute ago writes back everything else as it was a minute ago —
 * `day` is the field that moves, and losing an increment silently re-runs a day.
 * Milliseconds, not a turn.
 */
export async function updateSession(mutate: (s: Session) => void): Promise<Session> {
  return withLock('session', async () => {
    const fresh = await readSession()
    mutate(fresh)
    await writeSession(fresh)
    return fresh
  })
}

/**
 * One writer at a time, across processes, for global state.
 *
 * `wx` is the whole mechanism: creating the file is the acquire, and it either
 * succeeds or it does not. A lock older than twelve minutes is broken rather
 * than waited on, because the process that made it is dead — a persona's shell
 * was interrupted, or the machine slept — and a run that hangs forever on a dead
 * process's lock loses the rest of the week.
 *
 * NOT REENTRANT. Taking it inside itself waits thirty minutes and then dies, so
 * a caller that already holds it must call the plain functions rather than the
 * locking ones.
 */
export async function withLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(SEAT_HOME, { recursive: true })
  const STALE_MS = 12 * 60_000
  for (let i = 0; i < 900; i++) {
    try {
      const fh = await openFile(LOCK, 'wx')
      await fh.writeFile(`${process.pid} ${label} ${new Date().toISOString()}`)
      await fh.close()
      try {
        return await fn()
      } finally {
        await rm(LOCK, { force: true })
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) await rm(LOCK, { force: true })
      } catch {}
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
  return die('waited 30 minutes for the seat lock and it never came free')
}

/* ------------------------------------------------------------- the world */

export type DrainOpts = {
  /**
   * Plan the next 48 hours before draining. Defaults to true, which is what a
   * caller draining at a moment the clock has just jumped to needs.
   *
   * `walkTo` decides it per hop — see there. It is not a cheap call:
   * `planAheadFor` (lib/jobs/plan-ahead.ts) is a dozen queries and a bulk insert
   * per academy, and the hourly walk paid for it ~98 times across a week in which
   * 27 jobs ever ran.
   */
  plan?: boolean
}

/**
 * Run every job that is due, then everything that becoming due unlocked.
 *
 * **Which lane this drains, and why it is asked rather than assumed.**
 *
 * The tenant filter below has always been here, so a drive has never been able
 * to reach into another academy's queue. The lane (0040) is the other direction
 * of the same fence — the one that stops the *production beat* reaching into
 * this one — and it is worth restating here because the pair only works if both
 * halves agree about which lane this academy is in.
 *
 * It is resolved from the academy rather than hard-coded to `sim`. A drive
 * against a sandbox world drains the sim lane, which is every world `sim.ts`
 * builds; a driver who has deliberately pointed an instrument at a real academy
 * drains the live lane and gets the behaviour they had before this existed.
 * Hard-coding `sim` would have turned that second case into an empty drain that
 * throws nothing and reads exactly like a quiet queue — which is the precise
 * failure mode 0040 exists to remove, reintroduced from the other side.
 *
 * The lane is logged for the same reason: a driver who *accidentally* aimed at a
 * real tenant should be able to see it in the run record rather than infer it.
 */
export async function drain(academyId: string, opts: DrainOpts = {}): Promise<string[]> {
  const log: string[] = []
  if (opts.plan !== false) await plan(academyId, log)
  const [laneRow] = await q<{ lane: string }>(
    academyId,
    `select app.lane_for('${academyId}'::uuid) as lane`,
  )
  const lane = laneRow?.lane === 'sim' ? 'sim' : 'live'
  log.push(`lane:${lane}`)
  for (let round = 0; round < 10; round++) {
    const batch = await q<any>(
      academyId,
      `with due as (
         select id from job
          where status = 'pending' and run_at <= app.now()
            and lane = '${lane}'
            and payload->>'academy_id' = '${academyId}'
          order by run_at asc, created_at asc limit 50 for update skip locked
       )
       update job j set status = 'running', attempts = j.attempts + 1,
              locked_at = app.now(), locked_by = 'drive'
         from due where j.id = due.id returning j.*`,
    )
    if (!batch.length) break
    batch.sort((a: any, b: any) => msOf(a.run_at) - msOf(b.run_at))
    for (const job of batch) {
      const handler = (HANDLERS as any)[job.kind]
      if (!handler) {
        await q(academyId, `update job set status='failed', last_error='no handler', locked_at=null where id='${job.id}'::uuid`)
        continue
      }
      // WHICH watch, not only that A watch ran: a record full of bare `agent_task:done`
      // is why the who-asked task's firing was read as "never happened" on the 23 Aug
      // week sims — the one fact that named it lived in a payload nothing rendered. A
      // skip's reason rides along for the same cost; `client_outcome:skipped` with the
      // why unrecoverable was the same gap one branch over.
      // The `schedule` tool sanitizes slugs; a plan-staged agent_task payload does not,
      // so the log's copy is sanitized here — a stray `:` in a slug would otherwise
      // truncate the kind every reader splits out of this string.
      const rawSlug = job.kind === 'agent_task' && typeof job.payload?.slug === 'string' ? job.payload.slug : ''
      const slug = rawSlug ? `(${String(rawSlug).replace(/[^a-z0-9_-]/gi, '').slice(0, 60)})` : ''
      try {
        await handler(job)
        await q(academyId, `update job set status='done', last_error=null, locked_at=null where id='${job.id}'::uuid`)
        log.push(`${job.kind}${slug}:done`)
      } catch (e) {
        const skip = e instanceof JobSkip
        // The record gets the reason as thrown; only the SQL literal gets the quote
        // escaping, or the log carries doubled quotes ("can''t") forever.
        const whyRaw = String((e as any)?.reason ?? (e as Error)?.message ?? e).slice(0, 200)
        const why = whyRaw.replace(/'/g, "''")
        await q(
          academyId,
          `update job set status='${skip ? 'skipped' : 'failed'}', last_error='${why}', locked_at=null where id='${job.id}'::uuid`,
        )
        log.push(`${job.kind}${slug}:${skip ? `skipped — ${whyRaw}` : `FAILED ${whyRaw}`}`)
      }
    }
  }
  return log
}

/** The planner, with its failure written into the run's own job log rather than thrown. */
async function plan(academyId: string, log: string[]): Promise<void> {
  await planAheadFor(academyId).catch((e) => log.push(`plan failed: ${(e as Error)?.message}`))
}

/**
 * A walk cannot need more hops than there are distinct `run_at` values between
 * here and the target, and the query below asks for `run_at > app.now()`, so
 * every hop lands strictly later than the last and the loop cannot fail to make
 * progress. This bound is here for the day that stops being true — a clock that
 * will not advance, a job re-enqueued at the instant it just ran — so a
 * pathological walk ends rather than spinning for the rest of the week.
 */
const MAX_HOPS = 720

/**
 * Walk this academy's clock forward to a local time today, running the standing
 * jobs at the moments they come due.
 *
 * WHAT THE OLD LOOP WAS FOR, AND WHY THIS KEEPS IT
 * -----------------------------------------------------------------------------
 * It hopped an hour at a time — up to 48 times — and drained after every hop.
 * The reason was never the hour: it was that a job due at 09:00 must be REACHED
 * and RUN, never stepped over. A single jump from 08:00 to 20:00 leaves the
 * 09:00 job pending with a `run_at` in the past, and the whole day's proactive
 * surface — the morning brief, the T-60 prompts, the register, the digest —
 * simply never happens. `lib/clock.ts` opens by calling that surface "~70% of
 * this product".
 *
 * An hourly hop is one way to guarantee that. Asking the queue when it next
 * wants something is another, and it is the same guarantee: hop to each pending
 * `run_at` in order, drain there, then hop to the target. Every due moment is
 * still landed on exactly, in order, and the hops that landed on nothing are the
 * only thing removed. Across a settled week the old walk paid ~98 hops — each
 * one a clock write, a planner pass and a queue poll — for 27 jobs, and cost a
 * measured 44 minutes of the ~59 minutes of wall clock a week took against 15.4
 * minutes of model time.
 *
 * The one thing that changes, and it changes toward production: a job due at
 * 09:05 now runs at 09:05 rather than at 10:00, so anything the handler reads
 * off `app.now()` — the quiet-hours window most of all — sees the hour the job
 * was scheduled for instead of an hour that could be up to 59 minutes later.
 * Production's beat is a minute, so this is the closer of the two.
 *
 * THE PLANNER IS NOT PART OF A HOP
 * -----------------------------------------------------------------------------
 * `planAheadFor` used to run inside every drain, so it ran once an hour of
 * simulated time whether or not anything had changed — a dozen queries and a
 * bulk insert, ~98 times a week, writing nothing on most of them. It plans a
 * 48-hour horizon and a walk cannot cross midnight (the target is a minute of
 * TODAY, and a target already behind returns above), so the day-rollover pass is
 * `endday`'s own drain and not this loop's business.
 *
 * What IS this loop's business is a world that changed shape while it walked. A
 * handler that ran here can create the rows the next jobs are planned from —
 * `materialize_sessions` makes the sessions that the T-60 prompt, the register
 * and the outcome are planned FROM — and the planner's `push` drops any moment
 * already more than a couple of minutes past. Leave that plan until the next
 * window and the sessions exist while their reminders were never planned at all,
 * which is a silent loss of exactly the surface this loop exists to reach.
 *
 * So the planner runs when it is OWED: once before the first hop, so the hop
 * query sees a planned queue, and then at the top of the first drain after any
 * drain that ran something — which is where the old code put it, so a job the
 * planner enqueues as immediately due is still claimed by the same drain's own
 * rounds. The trailing pass is for the walk's last drain, which has no next hop
 * to owe it to.
 */
export async function walkTo(academyId: string, localHHMM: string): Promise<string[]> {
  const jobs: string[] = []
  const [h, m] = localHHMM.split(':').map(Number)
  const target = (h ?? 0) * 60 + (m ?? 0)

  const startedAt = await clock.now(academyId)
  const here = clock.inZone(startedAt, TZ)
  const [ch, cm] = here.time.split(':').map(Number)
  const nowMin = (ch ?? 0) * 60 + (cm ?? 0)
  if (nowMin >= target) return jobs
  // Minute arithmetic on the instant, exactly as the hourly loop did it: this
  // zone has no DST, and a target computed any other way would disagree with the
  // clock the hops are measured against.
  const targetAt = new Date(startedAt.getTime() + (target - nowMin) * 60_000)

  await plan(academyId, jobs)
  let owed = false

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const at = await clock.now(academyId)
    if (at.getTime() >= targetAt.getTime()) break
    // Asked again on every hop rather than listed once, because the drain that
    // just ran may have enqueued work due before the target — and a job planned
    // during this walk is exactly the one the old loop caught by accident.
    const due = await nextDueAt(academyId, targetAt)
    const hopTo = due && due.getTime() < targetAt.getTime() ? due : targetAt
    await clock.advance(hopTo.getTime() - at.getTime(), academyId)
    const ran = await drain(academyId, { plan: owed })
    owed = ran.length > 0
    jobs.push(...ran)
  }
  if (owed) await plan(academyId, jobs)
  return jobs
}

/**
 * The next moment this academy's queue wants something, at or before the target.
 *
 * `run_at > app.now()` and not `>=`: anything already due is drained where the
 * clock stands, and hopping to a moment already reached is a hop of zero that
 * would repeat until the guard.
 *
 * Epoch milliseconds rather than a timestamp, because the answer is fed straight
 * back into `clock.advance` as arithmetic. Postgres renders a timestamptz as
 * `2026-08-24 09:00:00.123456+00` — a space instead of the `T`, six fractional
 * digits, a two-digit offset — which is not the format `Date.parse` is specified
 * to accept, so it is parsed only by V8's goodwill. `advance` coerces a NaN to
 * zero, so the day it stops being parsed is the day the walk hops nowhere,
 * silently, for 720 iterations.
 */
async function nextDueAt(academyId: string, targetAt: Date): Promise<Date | null> {
  const rows = await q<{ next_ms: number | string | null }>(
    academyId,
    `select (extract(epoch from min(run_at)) * 1000)::float8 as next_ms from job
      where status = 'pending'
        and payload->>'academy_id' = '${academyId}'
        and run_at > app.now()
        and run_at <= '${targetAt.toISOString()}'::timestamptz`,
  )
  /**
   * `min()` over no rows is NULL, and NULL is the ordinary answer — most hops in
   * a week have nothing ahead of them. It is checked before the coercion because
   * `Number(null)` is 0 and `new Date(0)` is January 1970: a walk that took that
   * for a due time would advance the academy's clock backwards by fifty-six
   * years, and everything downstream of it would be about a business that has
   * not opened yet.
   */
  const raw = rows[0]?.next_ms
  if (raw === null || raw === undefined || raw === '') return null
  const ms = Number(raw)
  return Number.isFinite(ms) ? new Date(ms) : null
}

/* -------------------------------------------------------- the seat's view */

/** `cursors/<persona>` — one timestamp, written by that persona's seat and nobody else. */
function cursorPath(s: Session, key: string): string {
  const safe = String(key).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 48) || 'seat'
  return join(s.dir, 'cursors', safe)
}

/** Where this persona's phone got to. Falls back to the legacy map, then to the run's start. */
async function readCursor(s: Session, key: string): Promise<string> {
  const raw = await readFile(cursorPath(s, key), 'utf8').catch(() => '')
  return raw.trim() || s.cursor?.[key] || s.startedAt
}

async function writeCursor(s: Session, key: string, at: string): Promise<void> {
  await mkdir(join(s.dir, 'cursors'), { recursive: true })
  await writeFile(cursorPath(s, key), at)
}

/**
 * `pending/<persona>` — what arrived on this phone that its owner has not looked at.
 *
 * The messages a `drive()` turn produced are past the cursor the moment it advances,
 * so until now they lived in a module array in the worker process and nowhere else.
 * `sim.ts` restarts every worker deliberately — once at founding, again per mover —
 * under a comment calling the restart "lossless", which is true of what the person
 * SAID (rebuilt from the run log) and false of what they were SHOWN.
 *
 * Measured on `2026-08-22-08-13-sim-7bo8` turn 0030: Farah Sheikh's phone renders
 * "(nothing arrived. Your phone stayed silent.)" and she writes "?" reasoning *"two
 * messages sent, total silence since, so I'm just poking it to get any response"* —
 * against turn 0020 the day before, `sent: 1`, *"I'm sorry, Farah — there are no
 * classes running from this number…"*. The product answered her and the harness ate
 * it. She is one of the two customers that run is read as having lost.
 *
 * A file rather than a longer-lived variable, and beside `cursors/` rather than
 * inside `session.json`, for the reason `cursors/` is already one file per persona:
 * a shared blob lost a seat's place, and this is the same lesson one level in.
 *
 * @mechanism heldBack — replies a persona has not looked at yet survive their worker.
 *   `drive()` writes what it just produced here after advancing the cursor past it; the
 *   next `move()` drains and clears it. Reading without advancing was the other candidate
 *   and is wrong twice: it re-shows rows the person has already seen, which `readPhone`'s
 *   own comment calls a defect that would have been written up as a product bug, and after
 *   a hand-over the persona holds a DIFFERENT contact row in a different tenant, so no
 *   cursor position can reach those messages at all.
 *   Closes F-DX.
 */
function heldBackPath(s: Session, key: string): string {
  const safe = String(key).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 48) || 'seat'
  return join(s.dir, 'pending', safe + '.json')
}

export async function writeHeldBack(s: Session, key: string, seen: unknown[]): Promise<void> {
  if (!seen.length) return void (await rm(heldBackPath(s, key), { force: true }).catch(() => {}))
  await mkdir(join(s.dir, 'pending'), { recursive: true })
  await writeFile(heldBackPath(s, key), JSON.stringify(seen))
}

/**
 * How much is on this phone that its owner has not seen: the held-back replies
 * plus everything past the cursor. A COUNT, for the driver's presence decision,
 * and never the content — the blindfold does not open here.
 *
 * The predicates are `readPhone`'s own five, kept in step deliberately: a second
 * copy that dropped the suppression clause would count a message the real
 * recipient never received, and the presence it then forced would be a person
 * pulled to their phone by nothing — the exact false reading `DRIVING.md` names
 * the blindfold as existing to prevent.
 */
export async function unreadOnPhone(s: Session, key: string): Promise<number> {
  let held = 0
  const raw = await readFile(heldBackPath(s, key), 'utf8').catch(() => '')
  if (raw.trim()) {
    try {
      const parsed = JSON.parse(raw)
      held = Array.isArray(parsed) ? parsed.length : 0
    } catch {
      held = 0
    }
  }
  const contactId = s.contacts[key]
  if (!contactId) return held
  const since = await readCursor(s, key)
  const [row] = await q<{ n: number }>(
    academyOf(s, key),
    `select count(*)::int as n
       from message m
      where m.direction = 'outbound'
        and m.contact_id = '${contactId}'::uuid
        and m.created_at > '${since}'::timestamptz
        and m.suppressed_reason is null
        and m.status <> 'failed'`,
  ).catch(() => [{ n: 0 }])
  return held + (row?.n ?? 0)
}

/** Drains: what was waiting, and it is not waiting any more. */
export async function takeHeldBack(s: Session, key: string): Promise<any[]> {
  const raw = await readFile(heldBackPath(s, key), 'utf8').catch(() => '')
  await rm(heldBackPath(s, key), { force: true }).catch(() => {})
  if (!raw.trim()) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * Everything this contact's phone has shown since they last looked, and nothing
 * else.
 *
 * Suppressed rows are excluded because the person never saw them — a message
 * stopped by a cap or an opt-out did not tell anybody anything, and showing it to
 * the seat would hand the reader a fact the real recipient does not have. Failed
 * rows go for the same reason.
 */
export async function readPhone(
  s: Session,
  key: string,
  advance: boolean,
  /**
   * How many hours behind this phone is, this once.
   *
   * A person on a train, on bad signal, or with their phone in a bag does not
   * MISS a message — they get it late. So a lagged look holds back everything
   * newer than `app.now() - hours` and leaves the cursor short of it, which puts
   * those messages at the top of their next look instead. That is the difference
   * between a late reply and a reply that never comes, and the two are different
   * findings: one is a product whose timing assumptions are wrong, the other is a
   * customer who left.
   *
   * Deliberately a bound on the READ and not a delay on the send. Holding the
   * message back in the database would change what the product did — the
   * dunning ladder, the register expiry and every cap are computed off
   * `message`, so a harness that moved rows would be measuring a different
   * product. Nothing here writes anything; the row is sent when the product sent
   * it, and this person simply had not looked yet.
   */
  lagHours = 0,
): Promise<Seen[]> {
  const contactId = s.contacts[key]!
  const since = await readCursor(s, key)
  const behind = lagHours > 0 ? `and m.created_at <= app.now() - interval '${Number(lagHours)} hours'` : ''
  /**
   * `created_at::text`, not `created_at`.
   *
   * The cursor is a high-water mark compared with `>`, and Postgres keeps
   * timestamps to the microsecond while a JS `Date` keeps them to the
   * millisecond. Round-tripping the value through `new Date(...).toISOString()`
   * therefore stores a cursor slightly BEHIND the row it came from, and the last
   * message of every look reappears at the top of the next one. The seat reads it
   * as the bot having sent the same thing twice, which is a defect the product
   * does not have and would have gone into the write-up as one.
   */
  const rows = await q<any>(
    // This person's own tenant, not the run's: a seat still holding a
    // front-desk contact cannot be read under the business's GUC (see academyOf).
    academyOf(s, key),
    `select m.created_at, m.created_at::text as raw_at, m.body, m.payload, m.status
       from message m
      where m.direction = 'outbound'
        and m.contact_id = '${contactId}'::uuid
        and m.created_at > '${since}'::timestamptz
        and m.suppressed_reason is null
        and m.status <> 'failed'
        ${behind}
      order by m.created_at asc`,
  )
  const seen: Seen[] = rows.map((m: any) => {
    const p = m.payload ?? {}
    return {
      at: clock.inZone(new Date(m.created_at), TZ).label,
      body: String(m.body ?? ''),
      buttons: Array.isArray(p.buttons) ? p.buttons.map((b: any) => String(b?.title ?? '')) : [],
      listButton: p.list?.buttonText ? String(p.list.buttonText) : null,
      listRows: Array.isArray(p.list?.sections)
        ? p.list.sections.flatMap((sec: any) =>
            (sec?.rows ?? []).map((r: any) => ({
              title: String(r?.title ?? ''),
              description: r?.description ? String(r.description) : null,
            })),
          )
        : [],
      link: p.link?.title ? String(p.link.title) : null,
    }
  })
  if (advance && rows.length) {
    await writeCursor(s, key, String(rows[rows.length - 1].raw_at))
  }
  return seen
}

export function renderPhone(seen: Seen[]): string {
  if (!seen.length) return '  (nothing arrived. Your phone stayed silent.)'
  const L: string[] = []
  for (const m of seen) {
    L.push(`  ┌─ ${m.at} ── Class Manager ${'─'.repeat(Math.max(0, 44 - m.at.length))}`)
    for (const line of m.body.split('\n')) L.push(`  │ ${line}`)
    if (m.buttons.length) L.push(`  │`), L.push(`  │ tap:  ${m.buttons.map((b) => `[ ${b} ]`).join('   ')}`)
    if (m.listButton) {
      L.push(`  │`)
      L.push(`  │ menu:  [ ${m.listButton} ]`)
      for (const r of m.listRows) L.push(`  │   · ${r.title}${r.description ? ` — ${r.description}` : ''}`)
    }
    if (m.link) L.push(`  │`), L.push(`  │ link:  [ ${m.link} ]`)
    L.push(`  └${'─'.repeat(62)}`)
  }
  return L.join('\n')
}

/** Every seat command, and what it showed. The blindfold, made auditable. */
export async function logSeat(s: Session, entry: Record<string, unknown>): Promise<void> {
  await appendFile(
    join(s.dir, 'seat.jsonl'),
    JSON.stringify({ at: new Date().toISOString(), day: s.day, ...entry }) + '\n',
  )
}

/* ------------------------------------------------------------- one turn */

/**
 * Post something as this person, let the product do whatever it does, and show
 * them their phone.
 *
 * NOT UNDER THE LOCK, and that is the change of 20 Aug 2026. Every turn used to
 * be serialised across processes because the record was a read-modify-write of
 * one JSON file and two seats appending at once erased one of the two turns.
 * `_capture.ts` appends one line and derives the numbering, so there is nothing
 * left to erase — and the thirty seconds a turn spends waiting for the model is
 * thirty seconds this file no longer spends holding a lock that a week with four
 * people in it has to queue behind, one sentence at a time.
 *
 * The session is used as the caller read it rather than re-read here: the only
 * field a concurrent seat used to move is the cursor, and that is now a file of
 * its own that only this persona writes.
 */
export async function drive(
  s: Session,
  key: string,
  meta: SeatMeta,
  fn: () => Promise<void>,
): Promise<Seen[]> {
  /**
   * Who the record says this was, named by the caller and by nobody else.
   *
   * There used to be a fallback here into `PERSONAS` — four humans hard-coded in
   * `_personas.ts` — for callers that did not say. It was already the wrong shape
   * before the fixtures went: `PERSONAS[key]` was `undefined` for anybody composed
   * out of a world file, and `.name` on it threw INSIDE the turn, once per seat,
   * so thirteen seats failed at 20:15 and the run finished with four queue turns
   * and a record that reads as a product nobody talked to.
   *
   * Now every person comes from a world file, so there is no table to fall back
   * to and the caller always holds the answer. Refused rather than guessed: a
   * turn attributed to the wrong person is worse than a turn that did not run.
   */
  const who = meta.who
  const seat = meta.seat
  if (!who || !seat) {
    die(
      `seat "${key}" was driven without saying who is in it.\n` +
        `   Pass { who, seat } — they come from the world file, via briefs.json.`,
    )
  }
  /**
   * This seat's tenant, not the run's. Everything below is evidence about one
   * person: the clock their rows are stamped by, the statements that can see
   * them, and the window the capture opens. One wrong pin empties all three.
   */
  const acad = academyOf(s, key)
  const at = clock.inZone(await clock.now(acad), TZ)
  const rec = await reopenRun(s.dir, {
    // Deliberately no `academyId` here: `reopenRun` writes it into the record's
    // HEAD, and the head names the RUN. `queueTurn` is the run's own turn and is
    // the one place the head should follow the founding. This seat's tenant goes
    // on the TURN instead — otherwise every desk seat would flap the head back.
    q: (sql: string) => q(acad, sql),
    // The tenant a founding turn creates and then answers from — see `alsoRead` in
    // `_capture.ts`. Without this the mechanism is unreachable and every hand-over turn
    // records silence, which is exactly what it was built to stop.
    qIn: (academyId: string, statement: string) => q(academyId, statement),
    domainNow: () => clock.now(acad),
  })
  await rec.turn(
    {
      id: `d${s.day}-${at.time}-${key}${meta.kind === 'tap' ? '-tap' : ''}`,
      who,
      persona: seat,
      say: meta.say,
      day: s.day,
      // Whose turn this is. Two seats speaking in the same window used to blend:
      // the slower turn's time window swallowed the faster one's reply. See
      // `TurnMeta.contactId`.
      ...(s.contacts[key] === undefined ? {} : { contactId: s.contacts[key] }),
      // This person's own number, so `reply` holds what reached THEM. A founding
      // or invite turn legitimately messages two recipients under one turn id,
      // and a reply that blends them shows a reader words the speaker never saw.
      ...(() => {
        const phone = s.roster.find((r) => r.contactId === s.contacts[key])?.phone
        return phone ? { to: phone } : {}
      })(),
      // The tenant this turn's evidence was read as, so a reader can tell a
      // turn that said nothing from a turn read in the wrong academy.
      academyId: acad,
      ...(meta.window === undefined ? {} : { window: meta.window }),
      ...(meta.intent === undefined ? {} : { intent: meta.intent }),
      ...(meta.personaReasoning === undefined ? {} : { personaReasoning: meta.personaReasoning }),
      ...(meta.phone === undefined ? {} : { phone: meta.phone }),
      ...(meta.kind === 'tap' ? { tapped: meta.say } : {}),
    },
    fn,
  )
  const seen = await readPhone(s, key, true)
  // Past the cursor now, so the only place they exist is here — see `heldBack`.
  await writeHeldBack(s, key, seen)
  return seen
}

/**
 * Drain the queue AS A TURN, so the proactive surface is measured like every
 * other thing this product does.
 *
 * Until 20 Aug 2026 the drains ran outside `rec.turn()` entirely. Every morning
 * brief, evening digest, coach nudge and dunning message therefore ran with no
 * tokens, no milliseconds, no SQL, no reasoning and no rupees against it — 49 of
 * the 137 messages delivered in `2026-08-18-14-38-live`, on a surface
 * `lib/clock.ts` opens by calling "~70% of this product". The instrument was
 * measuring the conversational third and extrapolating the whole.
 *
 * It was not even that the evidence was thrown away: `days.jsonl` kept the job
 * names and the unprompted bodies, and `close` folds them into `run.days`. But
 * `report.mjs` renders `record.json`'s TURNS, so a shape nothing renders is a
 * shape nobody reads, and the run's own cost table quietly excluded the majority
 * of what the product says.
 *
 * There is nobody in the seat for these, so `who` and `persona` are both
 * `queue` — which is what makes them legible in the report's split table, where
 * the proactive surface now sits beside the four people as its own row. `say` is
 * empty because nobody typed anything, and an invented sentence there would be
 * the harness putting words in the product's mouth.
 *
 * The caller passes a thunk that returns the drain log; `_capture.ts` takes it
 * from the sink rather than asking the database, because the database cannot
 * answer — see `TurnSink`.
 */
/**
 * The world this session drives is not in the database any more.
 *
 * Thrown rather than returned, because there is nothing a caller can do with it
 * except stop. Every turn after this one fails the same way: no clock moves, no
 * SQL runs, nothing is sent, nothing costs anything — and each of them is still
 * a line in `turns.jsonl` with a number and a persona on it.
 *
 * The incident is the seven-day sim of 20 Aug 2026, cancelled from the keyboard
 * part-way through day 2. Its academy went away at the same moment — by which
 * hand is not recorded, and this file does not need to know — and the walk did
 * not stop: it carried on to day 7 against a business that no longer existed.
 * 43 of its 56 turns advanced no clock, ran no statement, sent
 * no message and cost ₹0, while `record.json` still said fifty-six turns across
 * seven days. That is the trap DRIVING.md names in its own words — a bad run
 * that reads afterwards as a good one — and it is worse than a crash, because a
 * crash says so.
 *
 * A world also disappears without anybody cancelling anything: `sim gc` reaps by
 * age, a seed rebuilds the fixtures, another shell drops a business somebody
 * thought was theirs. The stop is the same in every case.
 */
export class WorldGone extends Error {
  constructor(readonly academyId: string) {
    super(
      `the academy this run drives (${academyId}) is not in the database any more.\n` +
        `   Something dropped it while the run was walking — a cancelled run's teardown, a\n` +
        `   \`sim gc\`, or a seed. Nothing measured after this point would mean anything, so\n` +
        `   the run stops here and keeps the record it already has.`,
    )
    this.name = 'WorldGone'
  }
}

/**
 * Is this academy still a row?
 *
 * Asked of the database rather than of the error text. `sim_clock_academy_id_fkey`
 * is what the cancelled run happened to throw, because the clock is the first
 * thing a window touches — but a world removed between two hops can surface at a
 * dozen different statements, and a harness that recognises one message resumes
 * walking after all the others.
 *
 * A check that cannot itself run answers `true`. The alternative reads a database
 * blip as a deleted business and stops a good run with a sentence that is false.
 */
async function academyAlive(academyId: string): Promise<boolean> {
  return q(academyId, `select 1 from tenant where id = '${academyId}'::uuid`)
    .then((rows) => rows.length > 0)
    .catch(() => true)
}

export async function queueTurn(
  s: Session,
  id: string,
  run: () => Promise<string[]>,
  meta: { window?: string } = {},
): Promise<string[]> {
  const rec = await reopenRun(s.dir, {
    academyId: s.academyId,
    q: (sql: string) => q(s.academyId, sql),
    qIn: (academyId: string, statement: string) => q(academyId, statement),
    domainNow: () => clock.now(s.academyId),
  })
  const t = await rec.turn(
    {
      id,
      who: 'queue',
      persona: 'queue',
      say: '',
      day: s.day,
      // The queue belongs to the BUSINESS, not to a person, so this one stays
      // on the run's academy — and it is the only writer of the record head.
      academyId: s.academyId,
      ...(meta.window === undefined ? {} : { window: meta.window }),
    },
    async (sink) => {
      sink.jobs.push(...(await run()))
    },
  )
  /**
   * A failed turn is asked one question: is the world still there?
   *
   * Only after a failure, so the ordinary path pays nothing — a week is around a
   * hundred queue turns, and this would otherwise be a hundred round-trips to
   * learn "yes". `rec.turn` records a throw and returns normally, by design, so
   * the error is here to be read rather than propagated; without this, a harness
   * cannot tell a turn that failed from a turn that failed because there is
   * nothing left to drive.
   */
  if (t.error && !(await academyAlive(s.academyId))) throw new WorldGone(s.academyId)
  return t.jobs
}

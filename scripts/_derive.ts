/**
 * _derive — `turns.jsonl` is the run. Every other file in the directory is a view
 * of it, and can be deleted and rebuilt.
 *
 *   import { deriveRun } from './_derive'
 *   await deriveRun('.probe/runs/2026-08-20-12-15-live-a3f9')
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * `record.json` used to be both the log and the file. Every turn rewrote it
 * whole — read 800KB back, push one turn, write 800KB out — and a read-modify-
 * write is not something two processes can do to the same file. `scripts/live.ts`
 * says so in its own comment: two seats speaking at once would each read the
 * record, each append one turn, and the second write would erase the first. It
 * bought safety with a lock file and paid for it in wall-clock, one turn at a
 * time through a week that has four people in it.
 *
 * So the record stopped being the thing that is written. What a running
 * instrument writes now is one appended line per turn, and appending never has to
 * know what is already in the file. Everything else — `record.json` included — is
 * DERIVED. That is not a filing convention; it is what makes the harness
 * concurrent, and it is what lets a reader who wants a shape nobody thought of
 * have it without asking for the run to be recorded differently.
 *
 * WHAT IT WRITES
 * -----------------------------------------------------------------------------
 *   record.json                 the canonical record, exactly the contract
 *                               `scripts/report.mjs` and every existing reader
 *                               already open — turns in append order, numbered
 *                               from 1, head fields merged, never dropped
 *   index.jsonl                 one thin line per turn. The entry point for
 *                               "where is the bot going wrong": a week is 800KB
 *                               and the question is usually answerable from
 *                               thirteen numbers a turn
 *   turns/<nnnn>-…json          one complete untruncated turn per file, `n` zero-
 *                               padded so lexical order is turn order and the
 *                               persona in the name so `ls turns/ | grep client`
 *                               is a real query
 *   by-seat/<persona>.jsonl     one person's whole week, in order
 *
 * `n` IS ASSIGNED HERE, AND IT IS APPEND ORDER
 * -----------------------------------------------------------------------------
 * The turn number is not in the log. It is `index + 1` over the lines, in the
 * order they were appended, computed every time the log is read — which is why
 * `record.json`, `index.jsonl`, `turns/` and `by-seat/` cannot disagree about
 * what turn 23 is.
 *
 * It was assigned at append, from a count of the lines already in the file, and
 * that is a read-then-write with nothing claiming the answer in between. Four
 * processes appending five turns each produced 51, 51, 53, 54, 54, 56 … : four
 * pairs of turns sharing a number, four numbers never used, and every line whole
 * — the append was never the problem. `scripts/report.mjs` looks judgements up by
 * `n`, so a shared number gives two turns one verdict and silently drops the
 * other. Append order needs no counting, cannot collide, and does not change once
 * a line is written, so it is both unique and stable: re-deriving a log a month
 * later numbers it exactly as it was numbered the day it was driven.
 *
 * BY SEAT IS NOT AN ANALYSIS STEP
 * -----------------------------------------------------------------------------
 * The reading that reframed a month in this repo came from splitting by persona
 * instead of averaging: every catastrophic turn in `2026-08-17-1230-stress-month`
 * was a client turn, and the same month weighted toward the operator scores 8.2
 * and reads as fine. That split was somebody's idea, done once, by hand. It is a
 * file now, so the next reader gets it before they think to ask for it.
 *
 * IDEMPOTENT, BYTE FOR BYTE
 * -----------------------------------------------------------------------------
 * Running this twice on the same log produces the same bytes. Nothing here reads
 * a clock, and every head field it did not produce — `world`, `days`, `extra`,
 * `note`, `academyId`, `arm`, `variant` and anything a later driver adds — is
 * merged forward rather than replaced, because this file is not the authority on
 * what a run is allowed to carry.
 *
 * AND NOTHING HERE DECIDES ANYTHING
 * -----------------------------------------------------------------------------
 * Same line `_capture.ts` keeps: numbers and text are evidence, booleans are
 * verdicts. `index.jsonl` counts rounds and statements and rupees; it does not
 * say whether a turn was good, and there is no field here that could be made to.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

type Run = import('./_capture').Run
type Turn = import('./_capture').Turn

/** The one file an instrument writes while a run walks. Everything else is made from it. */
export const TURNS_LOG = 'turns.jsonl'

/**
 * Read the append log, oldest turn first, numbered as the log witnessed them.
 *
 * This is where `n` comes from — see the header. Whatever number a line carries
 * is overruled by its position, because a line's position is the only thing about
 * it the disk actually decided.
 *
 * Falls back to `record.json`'s turns when there is no log, because every run
 * recorded before 20 Aug 2026 has one and none of them have the other, and a run
 * that cannot be opened is a run that has been thrown away. Those turns are
 * numbered by their position too: they are stored in the order they happened, so
 * that renumbers nothing, and it means one rule covers both sources.
 *
 * A line that will not parse is skipped rather than thrown on. A process killed
 * mid-append leaves half a line behind, and losing that turn instead of the week
 * is the entire reason the log is lines — `_capture.ts` terminates that half-line
 * before it appends, so the half costs its own turn and no others.
 */
export async function readTurns(dir: string): Promise<Turn[]> {
  const log = join(dir, TURNS_LOG)
  if (!existsSync(log)) {
    const prior = (await readRecord(dir))?.turns
    return Array.isArray(prior) ? number(prior as Turn[]) : []
  }
  const turns: Turn[] = []
  for (const line of (await readFile(log, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    let t: unknown
    try {
      t = JSON.parse(line)
    } catch {
      continue
    }
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue
    turns.push(t as Turn)
  }
  return number(turns)
}

/**
 * Turn 1 is the first line, turn 2 is the second, and there is no third rule.
 *
 * One function so that every derived view in this directory is numbered by the
 * same pass over the same order — the way two views come to disagree is two
 * places deciding.
 */
function number(turns: Turn[]): Turn[] {
  return turns.map((t, i) => ({ ...t, n: i + 1 }))
}

/** The record as it is on disk, or null. Never throws on a half-written file. */
export async function readRecord(dir: string): Promise<Record<string, unknown> | null> {
  const path = join(dir, 'record.json')
  if (!existsSync(path)) return null
  try {
    const v = JSON.parse(await readFile(path, 'utf8'))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * Write `record.json` from the head a driver holds and the turns the log holds.
 *
 * The merge is the load-bearing part. `close()` folds in a world hours after the
 * first turn was appended, `probe-model`'s backfill writes an `arm`, a driver
 * two months from now will add a field this file has never heard of — and all of
 * that lives in the head, which this function is not allowed to lose. Only keys
 * the caller actually set overwrite what is on disk; `undefined` is not an
 * instruction to forget something.
 */
export async function writeRecord(dir: string, head: Partial<Run>, turns: Turn[]): Promise<Run> {
  const existing = (await readRecord(dir)) ?? {}
  const { turns: _ignored, ...rest } = head
  const merged = { ...existing, ...defined(rest), turns } as unknown as Run
  await writeAtomic(join(dir, 'record.json'), JSON.stringify(merged, null, 2))
  return merged
}

/**
 * Rebuild everything in a run directory that is not the log.
 *
 * Safe to run on a walking run, on a finished one, and twice in a row. Returns
 * what it wrote so a caller can print it rather than guess.
 */
export async function deriveRun(dir: string): Promise<{ turns: number; files: string[] }> {
  const turns = await readTurns(dir)
  const files: string[] = []

  /**
   * A directory with a log and no record is a run whose head was never written —
   * a crash between `mkdir` and the first flush, or a log copied out of one. The
   * minimum is reconstructed from the directory name, which carries the stamp and
   * the suite by construction. `model` stays empty because the log genuinely does
   * not know it: a turn records what it cost, not who answered.
   */
  const seed = (await readRecord(dir)) ? {} : seedHead(dir, turns)
  await writeRecord(dir, seed, turns)
  files.push('record.json')

  /**
   * The thin line, and the reason to open this file first.
   *
   * `where is the bot going wrong` is a filtering question — which seat, which
   * day, which window, which turns took nine rounds or wrote nothing or cost ₹4 —
   * and answering it should not cost a reader the whole week in memory. Every
   * field here is a count, a name or a rupee figure; the one that is not whole is
   * `error`, which carries its first line, and the stack is in `turns/` one file
   * away. This is a view. `record.json` and `turns/` are the record.
   */
  const index = turns.map((t) =>
    JSON.stringify({
      n: t.n,
      day: t.day ?? null,
      window: t.window ?? null,
      who: t.who,
      persona: t.persona,
      ms: t.ms,
      rounds: Array.isArray(t.rounds) ? t.rounds.length : 0,
      sql: Array.isArray(t.sql) ? t.sql.length : 0,
      sent: t.sent,
      wrote: t.wrote,
      tokens: (t.tokens?.prompt ?? 0) + (t.tokens?.cached ?? 0) + (t.tokens?.output ?? 0),
      inr: t.inr ?? null,
      error: t.error ? (String(t.error).split('\n')[0] ?? null) : null,
    }),
  )
  await writeAtomic(join(dir, 'index.jsonl'), lines(index))
  files.push('index.jsonl')

  /**
   * One turn, one file, nothing removed.
   *
   * `n` is zero-padded to four so `ls` is in turn order rather than 1, 10, 11, 2,
   * and the day, the time, the person and the seat are all in the name so the
   * shell is a query language over a week. Two turns collide on all four of the
   * others — one person, one minute, one day, one seat is an ordinary pair of
   * turns — and `n` leads the name and is unique by construction, being this
   * file's own index over the log. The suffix stays anyway: it is three lines, and
   * losing evidence to a filename is the one failure this directory must not have.
   */
  await mkdir(join(dir, 'turns'), { recursive: true })
  const taken = new Set<string>()
  for (const t of turns) {
    let name = turnFile(t)
    for (let i = 2; taken.has(name); i++) name = `${turnFile(t)}--${i}`
    taken.add(name)
    await writeAtomic(join(dir, 'turns', name), JSON.stringify(t, null, 2))
    files.push(`turns/${name}`)
  }

  await mkdir(join(dir, 'by-seat'), { recursive: true })
  const seats = new Map<string, string[]>()
  for (const t of turns) {
    const key = slug(t.persona) || 'unknown'
    const rows = seats.get(key) ?? []
    rows.push(JSON.stringify(t))
    seats.set(key, rows)
  }
  for (const [key, rows] of [...seats.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    await writeAtomic(join(dir, 'by-seat', `${key}.jsonl`), lines(rows))
    files.push(`by-seat/${key}.jsonl`)
  }

  return { turns: turns.length, files }
}

/* --------------------------------------------------------------- plumbing */

const lines = (rows: string[]): string => (rows.length ? `${rows.join('\n')}\n` : '')

/** Only the keys the caller actually set. `undefined` must not erase a field on disk. */
function defined<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out as Partial<T>
}

/**
 * A path component that cannot be anything but a path component.
 *
 * Persona and `who` come from a driver's own tables and end up in a filename, so
 * no separator, no dot segment and no drive letter survives this — a run
 * directory is written by a harness and read by `ls`, and neither should have to
 * think about what a seat was called.
 */
function slug(s: unknown): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 32)
    .replace(/^-+|-+$/g, '')
}

/** `0007-d3-1415-rahul-owner.json` — sorts by turn, greps by person. */
function turnFile(t: Turn): string {
  const n = String(Number(t?.n) || 0).padStart(4, '0')
  const hhmm = /(\d{2}):(\d{2})/.exec(String(t?.at ?? ''))
  const time = hhmm ? `${hhmm[1]}${hhmm[2]}` : '0000'
  const parts = [n, `d${Number(t?.day ?? 0) || 0}`, time, slug(t?.who), slug(t?.persona)]
  return `${parts.filter(Boolean).join('-')}.json`
}

/** `2026-08-20-12-15-live-a3f9` — the stamp and the suite, which is all a name knows. */
function seedHead(dir: string, turns: Turn[]): Partial<Run> {
  const name = basename(dir.replace(/[\\/]+$/, ''))
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(.+)$/.exec(name)
  return {
    suite: m ? (m[6] as string).replace(/-[0-9a-z]{4}$/, '') : name,
    model: '',
    startedAt: m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00.000Z` : (turns[0]?.at ?? ''),
    academyId: null,
  }
}

/**
 * Write through a temporary file so a reader never sees half a record.
 *
 * These files are derived and two processes may rebuild them at the same moment;
 * whoever renames last wins and both wrote the same bytes anyway. What must never
 * happen is `report.mjs` opening a `record.json` that is mid-write, because the
 * point of flushing every turn is that a run is readable while it is still being
 * driven.
 */
async function writeAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data)
  for (let i = 0; ; i++) {
    try {
      await rename(tmp, path)
      return
    } catch {
      /**
       * Windows refuses to replace a file another process holds open, and `npm
       * run report` reading the record of a run that is still walking is exactly
       * that. Wait it out; if it will not clear, write in place and take the torn
       * read, because a torn read is rebuilt by the next turn and a run that died
       * on its own bookkeeping is not.
       */
      if (i >= 4) {
        await writeFile(path, data)
        await rm(tmp, { force: true })
        return
      }
      await new Promise((r) => setTimeout(r, 25 * (i + 1)))
    }
  }
}

/**
 * _record-from-probe — turn `probe-model`'s per-arm records into the one record shape.
 *
 * Not a command. `scripts/record-from-probe.ts` is the CLI over this, and
 * `probe-model.ts` calls it at the end of a run so a fresh run never needs the CLI.
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * `_capture.ts` says it plainly: six record shapes meant six readers, and the
 * readers disagreed about what a turn even contained. `drive-week`, `probe-ask`
 * and `probe-sql` write `record.json` and `scripts/report.mjs` renders it.
 * `probe-model` — the instrument that drives the hardest suites in this repo —
 * wrote only its own `<arm>.json` and its own `score.md`, so for a long while the
 * one run nobody could open in the standard reader was the one worth reading most:
 * 22 of 40 run directories were invisible to `npm run report` and `npm run runs`.
 *
 * The conversion is a rename, not an interpretation. The records on disk already
 * hold everything the shape asks for. It adds nothing, drops nothing, and every
 * number on the page traces to a field the driver wrote.
 *
 * Two fields are DERIVED and both are marked here so no reader mistakes them for
 * measurements:
 *
 *   `at`    the domain instant of the turn, parsed out of `clockNote` — the
 *           driver's own note of where it walked the clock to. A case that asked
 *           for no travel inherits the instant of the turn before it, which is
 *           true: nothing moved.
 *   `day`   whole days since the first turn, from those instants. It is what
 *           groups the page into days, and it is arithmetic on `at`.
 *
 * `inr` is not derived — `costInr` is the same function `_capture` calls, on the
 * token counts the driver recorded.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
// `lib/pricing` is pure — no imports, no env — so it is safe to pull in statically
// from a module that `probe-model` loads before it has read any env file.
import { costInr } from '@/lib/pricing'

type Run = import('./_capture').Run
type Turn = import('./_capture').Turn
type Round = import('./_capture').Round

/** The last ISO instant in a clock note — where the driver said it walked to. */
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g
const lastInstant = (note: string | null): string | null => {
  if (!note) return null
  const hits = String(note).match(ISO)
  return hits?.length ? (hits[hits.length - 1] as string) : null
}

/**
 * The arm files in a run directory, in the order the filesystem lists them.
 *
 * A thinking sweep writes one file per arm and they are different runs of the
 * same suite; merging them into one record would interleave two academies and
 * every count on the page would be the sum of two worlds. So this returns all of
 * them and the caller picks — it never merges.
 *
 * **Identified by content, not by name.** Excluding `record.json` and
 * `judgement*.json` by name was not enough: `2026-08-17-1230-stress-month` also
 * holds `contacts.json`, `jobs.json`, `memory.json`, `messages.json`,
 * `money.json` and `turns.json` — world snapshots the driver took, not arms — and
 * a name-based filter called that run a seven-arm sweep and refused to convert it.
 * An arm file is an ARRAY whose elements carry the fields `probe-model` stamps on
 * a turn, and that is a question the bytes answer.
 */
export function armFiles(runDir: string): string[] {
  if (!existsSync(runDir)) return []
  return readdirSync(runDir)
    .filter((f) => f.endsWith('.json') && f !== 'record.json' && !f.startsWith('judgement'))
    .filter((f) => {
      try {
        const v = JSON.parse(readFileSync(join(runDir, f), 'utf8'))
        if (!Array.isArray(v) || !v.length) return false
        const first = v[0]
        if (!first || typeof first !== 'object') return false
        // `case` names the scenario and `said` is what the persona typed. Every
        // record `probe-model` writes has both; no world snapshot has either.
        return 'case' in first || 'said' in first
      } catch {
        return false
      }
    })
}

export type ConvertOpts = {
  /** Suite name as the reader should see it. */
  suite: string
  /** Falls back to the `model` field the driver stamped on its first record. */
  model?: string
  startedAt?: string
  academyId?: string | null
  note?: string
}

/**
 * One arm's records → one `Run`. Pure: it reads nothing and writes nothing.
 */
export function toRun(records: any[], opts: ConvertOpts): Run {
  if (!Array.isArray(records) || !records.length) {
    throw new Error('toRun: no turns to convert')
  }
  const model = String(opts.model || records[0].model || 'unknown')

  /**
   * Seeded with when the run started, so the turns BEFORE the first clock walk get
   * a day too. Left null they render as `day undefined`, which reads as a gap in
   * the record rather than what it is: three turns that asked for no travel and
   * therefore happened on day one.
   */
  let at: string | null = opts.startedAt ?? null
  let firstAt: number | null = null

  const turns: Turn[] = records.map((r, i) => {
    at = lastInstant(r.clockNote) ?? at
    const ms = at ? Date.parse(at) : NaN
    if (Number.isFinite(ms) && firstAt === null) firstAt = ms
    const day =
      Number.isFinite(ms) && firstAt !== null ? Math.floor((ms - firstAt) / 86_400_000) + 1 : undefined

    const rounds: Round[] = (r.tools ?? []).map((t: any) => ({
      round: Number(t.round ?? 0),
      name: String(t.name ?? ''),
      ...(t.args === undefined ? {} : { args: t.args }),
      ...(t.result === undefined ? {} : { result: t.result }),
      ...(t.error ? { error: String(t.error) } : {}),
      ...(t.reasoning ? { reasoning: t.reasoning } : {}),
      // Not in the `Round` type and kept anyway: the prose a round drafted before
      // any tool ran is evidence, and dropping it here would be this script
      // deciding what matters — the exact thing `_capture` was written against.
      ...(t.drafted ? { drafted: t.drafted } : {}),
    })) as Round[]

    const all: any[] = r.reply?.all ?? []
    const tokens = {
      prompt: Number(r.inTok ?? 0),
      cached: Number(r.cachedTok ?? 0),
      output: Number(r.outTok ?? 0),
    }

    return {
      n: i + 1,
      id: String(r.case ?? `turn-${i + 1}`),
      at: at ?? '',
      ...(day === undefined ? {} : { day }),
      who: String(r.spokeAs ?? r.persona ?? '?'),
      persona: String(r.persona ?? '?'),
      say: String(r.said ?? ''),
      rounds,
      sql: r.sql ?? [],
      /**
       * The whole window when the probe recorded one, the speaker's own set when
       * it did not.
       *
       * `reply.all` is scoped to the person who spoke, so a turn that messaged the
       * parent AND the owner arrived here as one message with `to: null` and
       * `origin: null` — the two fields that answer "who actually heard this, and
       * what put it on the wire". A judge asking whether a routed proposal really
       * reached the owner could not tell from this file. `r.outbound` carries the
       * full window with both fields populated; the fallback keeps older records
       * readable rather than rendering them empty.
       */
      messages: Array.isArray(r.outbound) && r.outbound.length
        ? r.outbound.map((m: any) => ({
            to: m?.to ?? null,
            body: String(m?.body ?? ''),
            buttons: Array.isArray(m?.buttons) ? m.buttons.map((b: any) => String(b)) : [],
            status: String(m?.status ?? ''),
            origin: m?.origin ?? null,
            suppressedReason: m?.suppressedReason ?? null,
          }))
        : all.map((m) => ({
            to: null,
            body: String(m?.body ?? ''),
            buttons: Array.isArray(m?.buttons) ? m.buttons.map((b: any) => String(b)) : [],
            status: '',
            origin: null,
            suppressedReason: m?.suppressed ?? null,
          })),
      reply:
        all
          .filter((m) => !m?.suppressed)
          .map((m) => String(m?.body ?? ''))
          .join('\n---\n') || null,
      buttons: Array.isArray(r.reply?.buttons) ? r.reply.buttons.map((b: any) => String(b)) : [],
      tapped: r.tapNote ?? null,
      jobs: Array.isArray(r.jobs) ? r.jobs.map((j: any) => String(j)) : [],
      tokens,
      inr: costInr(model, tokens.prompt, tokens.cached, tokens.output),
      ms: Number(r.latencyMs ?? 0),
      // Every turn in the beat, so a reader joining back to `turn` or `message`
      // finds the tap's turn as well as the one that composed the work.
      turnIds: Array.isArray(r.turnIds) && r.turnIds.length
        ? r.turnIds.map((id: any) => String(id))
        : r.turnId
          ? [String(r.turnId)]
          : [],
      wrote: Number(r.wrote ?? 0),
      sent: Number(r.reached ?? 0),
      beforeTap: r.beforeTap ?? null,
      afterTap: r.afterTap ?? null,
      error: r.error ?? null,
    }
  })

  return {
    suite: opts.suite,
    model,
    startedAt: opts.startedAt ?? new Date(0).toISOString(),
    academyId: opts.academyId ?? null,
    note: opts.note ?? '',
    turns,
    // The last photograph the driver took is the world the run left behind, which
    // is what a judge checks a promise against.
    world: (records[records.length - 1]?.afterTap ??
      records[records.length - 1]?.beforeTap ??
      undefined) as Record<string, unknown> | undefined,
  }
}

/** Read one arm file and convert it. Throws with the path when it cannot. */
export function toRunFromFile(armPath: string, opts: ConvertOpts): Run {
  if (!existsSync(armPath)) throw new Error(`no such arm file: ${armPath}`)
  const records = JSON.parse(readFileSync(armPath, 'utf8'))
  if (!Array.isArray(records) || !records.length) throw new Error(`${armPath} holds no turns`)
  return toRun(records, opts)
}

/** Resolve `<runDir>/<arm>` the way both callers want it resolved. */
export function armPathIn(runDir: string, arm: string): string {
  return join(runDir, arm.endsWith('.json') ? arm : `${arm}.json`)
}

/**
 * record-from-probe — turn a `probe-model` run into the one record shape.
 *
 *   npx tsx scripts/record-from-probe.ts --run .probe/runs/2026-08-17-1439-stress-week
 *   npx tsx scripts/record-from-probe.ts --run <dir> --arm deepseek-v4-flash
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * `_capture.ts` says it plainly: six record shapes meant six readers, and the
 * readers disagreed about what a turn even contained. `drive-week`, `probe-ask`
 * and `probe-sql` write `record.json` and `scripts/report.mjs` renders it.
 * `probe-model` — the instrument that drives the hardest suites in this repo —
 * still writes its own `<arm>.json` and its own `score.md`, so the one run
 * nobody can open in the standard reader is the one worth reading most.
 *
 * The honest fix is for `probe-model` to call `openRun` itself. This is the
 * smaller move that does not touch the instrument WHILE A RUN IS IN FLIGHT: the
 * records on disk already hold everything the shape asks for, so the conversion
 * is a rename, not an interpretation. It adds nothing, drops nothing, and every
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
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnvFiles, c } from './_env'

loadEnvFiles()
const { costInr } = await import('@/lib/pricing')
type Run = import('./_capture').Run
type Turn = import('./_capture').Turn
type Round = import('./_capture').Round

const argv = process.argv.slice(2)
const flag = (n: string, d = ''): string => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return d
  const a = argv[i] as string
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? d)
}

const RUN = flag('run')
if (!RUN || !existsSync(RUN)) {
  console.error(c.red('record-from-probe — pass --run <.probe/runs/…> (the directory probe-model wrote)'))
  process.exit(2)
}

/**
 * The arm file, chosen rather than assumed.
 *
 * A thinking sweep writes one file per arm and they are different runs of the
 * same suite; merging them into one record would interleave two academies and
 * every count on the page would be the sum of two worlds.
 */
const ARM =
  flag('arm') ||
  (readdirSync(RUN).filter((f) => f.endsWith('.json') && f !== 'record.json' && f !== 'judgement.json')[0] ?? '')
if (!ARM) {
  console.error(c.red(`no probe records in ${RUN} — expected an <arm>.json written by probe-model`))
  process.exit(2)
}
const armPath = join(RUN, ARM.endsWith('.json') ? ARM : `${ARM}.json`)
if (!existsSync(armPath)) {
  console.error(c.red(`no such arm file: ${armPath}`))
  process.exit(2)
}

const records: any[] = JSON.parse(readFileSync(armPath, 'utf8'))
if (!Array.isArray(records) || !records.length) {
  console.error(c.red(`${armPath} holds no turns`))
  process.exit(2)
}

/** The last ISO instant in a clock note — where the driver said it walked to. */
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g
const lastInstant = (note: string | null): string | null => {
  if (!note) return null
  const hits = String(note).match(ISO)
  return hits?.length ? (hits[hits.length - 1] as string) : null
}

const model = String(records[0].model ?? flag('model', 'unknown'))
const suite = flag('suite', 'stress-week')

/**
 * Seeded with when the run started, so the turns BEFORE the first clock walk get
 * a day too. Left null they render as `day undefined`, which reads as a gap in
 * the record rather than what it is: three turns that asked for no travel and
 * therefore happened on day one.
 */
let at: string | null = flag('started') || null
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

const run: Run = {
  suite,
  model,
  startedAt: flag('started', new Date(0).toISOString()),
  academyId: flag('academy-id', '') || null,
  note: flag('note', ''),
  turns,
  // The last photograph the driver took is the world the run left behind, which
  // is what a judge checks a promise against.
  world: (records[records.length - 1]?.afterTap ??
    records[records.length - 1]?.beforeTap ??
    undefined) as Record<string, unknown> | undefined,
}

const out = join(RUN, 'record.json')
writeFileSync(out, JSON.stringify(run, null, 2))
console.log(
  `  ${out} — ${turns.length} turns, ${new Set(turns.map((t) => t.day)).size} day(s), ` +
    `${turns.reduce((a, t) => a + (t.sql?.length ?? 0), 0)} statements`,
)
console.log(c.dim('  now: npm run report'))

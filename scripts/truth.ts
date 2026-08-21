/**
 * truth — what the world did, beside what the product ended up believing.
 *
 *   npm run truth                      # the newest run that has a truth.json
 *   npm run truth -- --run <dir>       # one run by name
 *   npm run truth -- --all             # every session, not only the ones that differ
 *
 * WHY THIS IS A READER AND NOT A CHECK
 * -----------------------------------------------------------------------------
 * It prints two columns and no third. There is no verdict, no pass, no count of
 * "wrong" — for the reason this repo removed every deterministic check from its
 * drives: **a difference carries a sign, and the sign is the verdict.** A
 * register that says a child was present when the world says they were ill can
 * be four different things, and only one of them is a defect:
 *
 *   - the product asked and the coach tapped [All present] without reading it,
 *     which is a finding about the register's affordance;
 *   - the product never asked, which is a finding about the ladder;
 *   - nobody told the product anything and it made no claim at all, which is
 *     CORRECT — the product cannot know what nobody typed;
 *   - the parent rang the coach and the coach marked it, which is the product
 *     working exactly as designed.
 *
 * A checker that scored the difference would call the third one a failure, and
 * the third one is most of the rows. `docs/JUDGING.md` is what turns two columns
 * into a verdict, and a person or a judge model writes it into `judgement.json`.
 *
 * WHAT IT READS
 * -----------------------------------------------------------------------------
 * `truth.json` in the run directory — the world's own account, written by
 * `sim.ts` at the end of every day — and the academy's live rows through
 * `app.session_roster`, which is the one definition of "on the register" in this
 * repo. It reads the database the run left behind, which is why `--keep` is the
 * default: a dropped world has no second column.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { c, loadEnvFiles } from './_env'

loadEnvFiles()
process.env.TRANSPORT = 'emulator'

const { withSession } = await import('@/lib/db')

type Truth = {
  ref: string
  about: string
  seed: string
  chaos: Record<string, number>
  sessions: {
    sessionId: string
    className: string
    at: string
    endsAt: string
    day: number
    ran: boolean
    why?: string
    roster: { playerId: string; name: string; there: boolean; why?: string }[]
  }[]
  fired: {
    day: number
    window?: string
    what: string
    who?: string
    why?: string
    from: 'file' | 'chaos'
    note?: string
  }[]
}

const RUNS = join('.probe', 'runs')

function die(msg: string): never {
  console.error(`\n  ${c.red('x')}  ${msg}\n`)
  process.exit(2)
}

/** The newest run that actually has a `truth.json`, and never merely the newest. */
async function newestWithTruth(): Promise<string> {
  const names = await readdir(RUNS).catch(() => [] as string[])
  for (const name of names.sort().reverse()) {
    const dir = join(RUNS, name)
    const found = await readFile(join(dir, 'truth.json'), 'utf8').catch(() => null)
    if (found !== null) return dir
  }
  return die(
    `no run in ${RUNS} has a truth.json.\n` +
      `   A run only writes one when something happened in its week:\n` +
      `     npm run sim -- --world settled-tennis --events tennis-hard-week --days 4`,
  )
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const all = argv.includes('--all')
  const at = argv.indexOf('--run')
  const dir = at === -1 ? await newestWithTruth() : (argv[at + 1] ?? die('--run needs a directory'))

  const raw = await readFile(join(dir, 'truth.json'), 'utf8').catch(() => null)
  if (raw === null) die(`${dir} has no truth.json — its week had no events in it.`)
  const truth = JSON.parse(raw) as Truth

  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => '{}')) as {
    world?: { academyId?: string; academyName?: string }
  }
  const academyId = manifest.world?.academyId
  if (!academyId) die(`${dir}/manifest.json does not name an academy — nothing to read the rows from.`)

  /**
   * The product's own account, as the service role with the tenant GUC set.
   *
   * Left-joined through `app.session_roster` so a player the product never
   * marked comes back with a null status rather than not coming back at all: a
   * register nobody filled in and a register filled in wrongly are different
   * findings, and a join that dropped the first would hide the commoner one.
   */
  const rows = await withSession({ role: 'service', academyId }, async (tx) =>
    tx.unsafe(
      `select r.session_id::text, r.player_id::text, r.attendance_status, s.status as session_status,
              s.cancel_reason
         from app.session_roster r join session s on s.id = r.session_id`,
    ),
  ).catch((e: Error) =>
    die(
      `could not read ${manifest.world?.academyName ?? academyId}: ${e.message}\n` +
        `   The world may have been dropped or reaped. Only a --keep run (the default) leaves rows behind.`,
    ),
  )

  const marked = new Map<string, string | null>()
  const sessionStatus = new Map<string, { status: string; reason: string | null }>()
  for (const r of rows as any[]) {
    marked.set(`${r.session_id}:${r.player_id}`, r.attendance_status ?? null)
    sessionStatus.set(r.session_id, { status: r.session_status, reason: r.cancel_reason ?? null })
  }

  /* ------------------------------------------------------------------ head */

  console.log(c.bold(`\n  truth — ${dir}`))
  console.log(c.dim(`  events   ${truth.ref}${truth.about ? ` — ${truth.about}` : ''}`))
  const chaos = Object.entries(truth.chaos ?? {}).filter(([, v]) => v > 0)
  if (chaos.length) console.log(c.dim(`  chaos    ${chaos.map(([k, v]) => `${k}=${v}`).join(' · ')} · seed ${truth.seed}`))
  console.log(
    c.dim(
      `\n  Two columns and no third. What the world did, and what the product believes.\n` +
        `  Nothing here is a verdict — see docs/JUDGING.md.\n`,
    ),
  )

  /* -------------------------------------------------------------- registers */

  /**
   * Three states, not two, and the third is the one a two-state reader gets wrong.
   *
   * `differs` is the product CLAIMING something the world contradicts. `silent`
   * is the product claiming nothing at all — no attendance row, because nobody
   * told it anything. Those are not the same finding and they are not even the
   * same direction: a register nobody filled in may be a ladder that never asked,
   * or it may be a run that stopped on Monday, and calling it a disagreement
   * would report a short run as a broken product. Counted apart for that reason.
   */
  let differing = 0
  let silent = 0
  let shown = 0
  for (const s of truth.sessions) {
    const db = sessionStatus.get(s.sessionId)
    const cancelled = db?.status === 'cancelled'
    /**
     * A washout the product was told about is the product WORKING, and it is the
     * single most interesting row in the file: somebody typed it, the class is
     * cancelled, and the money stops. A washout it was never told about is the
     * opposite, and the two must not print the same.
     */
    const lines: string[] = []
    let differs = false
    let quiet = false

    for (const p of s.roster) {
      const said = marked.get(`${s.sessionId}:${p.playerId}`) ?? null
      const world = s.ran ? (p.there ? 'there' : 'not there') : 'no class'
      // "Agrees" is generous on purpose. `cancelled_timely` and `absent` are both
      // a player who was not there, and `late` is a player who was; the product
      // carrying MORE detail than the world had is not a difference.
      const agree =
        !s.ran ? cancelled
        : p.there ? said === 'present' || said === 'late'
        : said === 'absent' || said === 'cancelled_timely'
      const nothing = !cancelled && said === null
      if (nothing) quiet = true
      else if (!agree) differs = true
      lines.push(
        `      ${p.name.padEnd(20)} ${c.dim('world')} ${(world + (p.why ? ` (${p.why})` : '')).padEnd(38)}` +
          ` ${c.dim('product')} ` +
          (nothing ? c.dim('nothing recorded')
          : agree ? (cancelled ? 'cancelled' : String(said))
          : c.yellow(String(said))),
      )
    }

    if (differs) differing += 1
    else if (quiet) silent += 1
    if (!differs && !quiet && !all) continue
    shown += 1
    const head = `  day ${s.day}  ${s.className} ${s.at}`
    console.log(
      c.bold(head) +
        (s.ran ? '' : c.yellow(`  — did not happen: ${s.why ?? '?'}`)) +
        (cancelled ? c.green(`  · the product has it cancelled${db?.reason ? ` (${db.reason})` : ''}`) : ''),
    )
    if (!s.roster.length) console.log(c.dim('      (nobody on the register)'))
    for (const l of lines) console.log(l)
    console.log('')
  }

  const n = truth.sessions.length
  if (!shown) {
    console.log(
      c.dim(
        `  Every register the product wrote agrees with what the world did. ` +
          `${n} session${n === 1 ? '' : 's'} — run with --all to see them.\n`,
      ),
    )
  } else {
    console.log(
      c.dim(
        `  ${n} session${n === 1 ? '' : 's'} · ${differing} the product describes differently · ` +
          `${silent} it has recorded nothing about` +
          (all ? '' : ' · --all adds the ones that agree') +
          `\n`,
      ),
    )
  }

  /* ------------------------------------------------------------ what fired */

  if (truth.fired.length) {
    console.log(c.bold(`  what happened, in order`))
    for (const f of truth.fired) {
      const from = f.from === 'chaos' ? c.dim('rolled') : c.dim(' wrote')
      console.log(
        `    ${from} d${f.day}${f.window ? ` ${f.window.slice(0, 3)}` : '   '} ` +
          `${c.bold(f.what.padEnd(8))} ${(f.who ?? '').padEnd(18)} ` +
          c.dim(`${f.why ?? ''}${f.note ? ` — ${f.note}` : ''}`),
      )
    }
    console.log('')
  }
}

await main()

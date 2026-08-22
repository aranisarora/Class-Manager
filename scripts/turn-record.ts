/**
 * scripts/turn-record.ts — read production turns back as an ordinary run.
 *
 *   npx tsx scripts/turn-record.ts --academy "Ace Tennis"
 *   npx tsx scripts/turn-record.ts --academy <uuid> --since 2026-08-20 --limit 500
 *   npx tsx scripts/turn-record.ts --list
 *
 * WHY THERE IS NO NEW RENDERER HERE
 * -----------------------------------------------------------------------------
 * This repo's rule is one run, one directory, one record shape: every instrument
 * appends one line per turn to `.probe/runs/<UTC-minute>-<suite>-<tok>/turns.jsonl`,
 * everything else in that directory is derived from it, and ONE reader opens it.
 * Six report generators grew once and they are gone.
 *
 * So this writes exactly that file and stops. `npm run report`, `npm run runs`,
 * `_derive` and the judges then open a production turn without being told it is
 * one — which is the point. A drive and the live number are finally the same kind
 * of evidence, in the same shape, in front of the same reader.
 *
 * WHAT IT COSTS TO RUN
 * -----------------------------------------------------------------------------
 * Egress, and it is the reason the payload lives in a column of its own. The thin
 * line — who, when, how long, how many rounds, what it cost — is on `turn` and is
 * indexed; the fat half is `turn_record.record`. Filter and aggregate on the first,
 * and pull the second only for the turns actually being read. `--limit` is a real
 * limit, not a page size.
 */

import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadEnvFiles } from './_env'

loadEnvFiles()

const { withSession, closePool } = await import('@/lib/db')
const { turnRecordsFor } = await import('@/lib/turn-record')
const { costInr } = await import('@/lib/pricing')
const { runDir } = await import('./_capture')
const { TURNS_LOG, deriveRun, writeRecord } = await import('./_derive')

type TurnRecord = Awaited<ReturnType<typeof turnRecordsFor>>[number]

// -----------------------------------------------------------------------------
// Arguments.
// -----------------------------------------------------------------------------

const argv = process.argv.slice(2)
const flag = (name: string, fallback = ''): string => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]) : fallback
}
const has = (name: string): boolean => argv.includes(`--${name}`)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The businesses on this deployment, through the named door (0007/0044).
 *
 * `app.list_academies()` is `security definer` and cm_service only — the one
 * sanctioned cross-tenant read — so this holds a service session pinned to
 * nothing, exactly as `worldAcademyIds` does.
 */
async function academies(): Promise<{ id: string; name: string }[]> {
  const rows = await withSession({ role: 'service', academyId: '' }, async (tx) => {
    return await tx.unsafe(`select id::text as id, name from app.list_academies() order by name`)
  })
  return rows as unknown as { id: string; name: string }[]
}

async function resolveAcademy(arg: string): Promise<{ id: string; name: string }> {
  const all = await academies()
  if (UUID.test(arg)) {
    const hit = all.find((a) => a.id.toLowerCase() === arg.toLowerCase())
    if (!hit) throw new Error(`no academy with id ${arg}`)
    return hit
  }
  const matches = all.filter((a) => a.name.toLowerCase().includes(arg.toLowerCase()))
  if (matches.length === 0) throw new Error(`no academy matching "${arg}" — try --list`)
  // Refused rather than guessed: reading the wrong business's turns is a silent
  // wrong answer, and a prefix that matches two is not an answer at all.
  if (matches.length > 1) {
    throw new Error(`"${arg}" matches ${matches.length}: ${matches.map((m) => m.name).join(', ')}`)
  }
  return matches[0] as { id: string; name: string }
}

// -----------------------------------------------------------------------------
// One production turn, in the shape every reader in this repo already opens.
// -----------------------------------------------------------------------------

function toRunTurn(t: TurnRecord, n: number): Record<string, unknown> {
  const reply = ((t.reply ?? {}) as { reply?: unknown }).reply
  const buttons = t.messages.flatMap((m) => m.buttons)

  /**
   * How many replayed reads were clipped before the model saw them — counted off
   * the tail itself, exactly as `_capture.ts` counts it, because this is a
   * property of what the model was HANDED and the tail is the record of that.
   *
   * It has been structurally 0 in production until now, because the `(context)`
   * round did not exist there. It is a real number from this commit on.
   */
  const contextCuts = typeof t.context?.tail === 'string'
    ? (t.context.tail.match(/… \(truncated\)/g)?.length ?? 0)
    : 0

  const inr = t.model
    ? costInr(t.model, t.tokens.prompt, t.tokens.cached, t.tokens.output, new Date(t.at))
    : null

  return {
    n,
    id: t.turnId,
    at: t.at,
    academyId: t.academyId,
    who: t.who,
    // Production has no persona and inventing one would be a claim. The role the
    // product actually acted for is the honest answer to "who was this".
    persona: t.roleActed ?? 'live',
    say: t.say ?? '',
    ...(t.phone ? { phone: t.phone } : {}),
    rounds: t.rounds,
    sql: t.sql,
    messages: t.messages,
    reply: typeof reply === 'string' ? reply : null,
    buttons,
    tapped: t.actionId,
    // F-BV: no window over `job` can answer "what ran in this turn", and a guess
    // here would be the same wrong answer in a new place.
    jobs: [],
    tokens: t.tokens,
    inr,
    ms: t.ms,
    turnIds: [t.turnId],
    wrote: t.wrote,
    sent: t.sent,
    ...(t.changed.length ? { changed: t.changed } : {}),
    ...(contextCuts ? { contextCuts } : {}),
    ...(t.models.length ? { models: t.models } : {}),
    ...(t.recordMissing
      ? { notes: ['no turn_record row — a turn from before 0045, or one whose record did not land'] }
      : {}),
    error: t.error,
  }
}

// -----------------------------------------------------------------------------
// Run.
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  if (has('list')) {
    for (const a of await academies()) console.log(`${a.id}  ${a.name}`)
    return
  }

  const arg = flag('academy')
  if (!arg) {
    console.error(
      'usage: npx tsx scripts/turn-record.ts --academy <id|name> [--since <iso>] [--until <iso>]\n' +
        '                                     [--limit N] [--contact <uuid>]\n' +
        '       npx tsx scripts/turn-record.ts --list',
    )
    process.exitCode = 1
    return
  }

  const academy = await resolveAcademy(arg)
  const turns = await turnRecordsFor({
    academyId: academy.id,
    ...(flag('since') ? { since: flag('since') } : {}),
    ...(flag('until') ? { until: flag('until') } : {}),
    ...(flag('contact') ? { contactId: flag('contact') } : {}),
    limit: Number(flag('limit', '200')) || 200,
  })

  if (turns.length === 0) {
    console.log(`no turns for ${academy.name} in that window`)
    return
  }

  const dir = await runDir('prod')
  const lines = turns.map((t, i) => JSON.stringify(toRunTurn(t, i + 1))).join('\n')
  await writeFile(join(dir, TURNS_LOG), `${lines}\n`, 'utf8')

  const models = [...new Set(turns.map((t) => t.model).filter(Boolean))] as string[]
  await writeRecord(
    dir,
    {
      suite: 'prod',
      model: models.join(', '),
      startedAt: turns[0]?.at ?? '',
      academyId: academy.id,
      note: `${turns.length} live turns from ${academy.name}, read back from turn + turn_record`,
    },
    [],
  )
  await deriveRun(dir)

  const missing = turns.filter((t) => t.recordMissing).length
  const withSql = turns.filter((t) => t.sql.length > 0).length
  const withContext = turns.filter((t) => t.context !== null).length

  console.log(`${turns.length} turns from ${academy.name}`)
  console.log(`  ${withContext} carry the context they were given`)
  console.log(`  ${withSql} carry the SQL they authored`)
  if (missing) console.log(`  ${missing} have no turn_record row (written before 0045, or the record did not land)`)
  console.log(`\n  ${dir}`)
  console.log(`  npm run report`)
}

try {
  await main()
} finally {
  await closePool()
}

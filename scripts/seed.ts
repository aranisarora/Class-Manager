/**
 * seed — build a world for the emulator.
 *
 *   npm run seed            # both academies
 *   npm run seed ace        # the multi-coach world only
 *   npm run seed solo       # the one-person world only (§18)
 *   npm run seed both --json
 *
 *   npm run seed -- --stage roster        # ONE business at a point in its life
 *   npm run seed -- --stage mature        # …with a fortnight of conversation behind it
 *
 * A stage is not a scenario: `--scenario` rebuilds the whole world and truncates
 * everything in it, while `--stage` adds or replaces exactly one business and leaves
 * the rest alone. Stages exist because only two states were ever seedable — a
 * 45-day-old academy in full flight and an empty shell — so every state a real
 * business passes through on its way between them went untested.
 *
 * The seeding itself lives in `lib/seed.ts`; this is only a mouth for it.
 */
import { c, loadEnvFiles } from './_env'

loadEnvFiles()

const args = process.argv.slice(2)
const wantsJson = args.includes('--json')
const scenario = args.find((a) => !a.startsWith('--')) ?? 'both'

const flag = (name: string): string | undefined => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i === -1) return undefined
  const f = args[i] as string
  if (f.includes('=')) return f.slice(f.indexOf('=') + 1)
  const next = args[i + 1]
  return next !== undefined && !next.startsWith('--') ? next : ''
}

const stage = flag('stage')
if (stage !== undefined) {
  await seedOneStage(stage)
}

// `seedWorld` opens with `resetWorld`, so a scenario is not "add a world" — it is
// "delete every academy this database has, then add a world". The console's seed
// button is refused outside a sandbox for exactly this; the CLI reached the same
// function with nothing in the way.
const { refuseOnRealData } = await import('./_danger')
await refuseOnRealData('npm run seed', {
  force: args.includes('--force-on-real-data'),
  what: 'It would delete every academy, every conversation, every job, and the sender row holding the Cloud credentials.',
})

const { seedWorld } = await import('@/lib/seed')
type SeedResult = Awaited<ReturnType<typeof seedWorld>>
type AcademySummary = SeedResult['academies'][number]

console.log()
console.log(`${c.bold('seed')} ${c.dim('·')} scenario ${c.cyan(scenario)}`)

const started = performance.now()
const result: SeedResult = await seedWorld(scenario as Parameters<typeof seedWorld>[0]).catch(
  async (e: unknown): Promise<never> => {
    console.error()
    console.error(`${c.red('x')} seeding failed`)
    console.error(`  ${c.red(e instanceof Error ? (e.stack ?? e.message) : String(e))}`)
    await closePool()
    process.exit(1)
  },
)
const seconds = ((performance.now() - started) / 1000).toFixed(1)

if (wantsJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(c.dim(`sender   ${result.sender.label}  ${result.sender.phone}`))
  console.log(c.dim(`clock    ${await clockLabel(result.nowIso)}`))
  console.log()
  printAcademies(result.academies)
}

await closePool()

const n = result.academies.length
console.log()
console.log(`${c.green('done')} ${c.dim(`· ${n} academ${n === 1 ? 'y' : 'ies'} · ${seconds}s`)}`)
console.log(c.dim('  open http://localhost:3000/emulator'))
console.log()
process.exit(0)

// ---------------------------------------------------------------------------

function printAcademies(academies: AcademySummary[]): void {
  if (academies.length === 0) {
    console.log(c.dim('  (no academies seeded)'))
    return
  }
  const columns: [string, (a: AcademySummary) => number][] = [
    ['people', (a) => a.persons],
    ['contacts', (a) => a.contacts],
    ['players', (a) => a.players],
    ['coaches', (a) => a.coaches],
    ['classes', (a) => a.classes],
    ['sessions', (a) => a.sessions],
    ['done', (a) => a.completedSessions],
    ['tally', (a) => a.tallyLines],
  ]
  const nameWidth = Math.max(8, ...academies.map((a) => a.name.length)) + 2
  const widths = columns.map(
    ([label, get]) => Math.max(label.length, ...academies.map((a) => String(get(a)).length)) + 2,
  )

  console.log(
    c.dim(
      'academy'.padEnd(nameWidth) +
        columns.map(([label], i) => label.padStart(widths[i] as number)).join(''),
    ),
  )
  for (const a of academies) {
    console.log(
      a.name.padEnd(nameWidth) +
        columns.map(([, get], i) => String(get(a)).padStart(widths[i] as number)).join(''),
    )
  }
}

/**
 * One business at a named stage, then out — deliberately before `seedWorld` is even
 * imported, because a stage must never truncate the world the way a scenario does.
 */
async function seedOneStage(wanted: string): Promise<never> {
  const { refuseOnRealData } = await import('./_danger')
  await refuseOnRealData('npm run seed -- --stage', {
    force: args.includes('--force-on-real-data'),
    what: 'A stage fixture is created on the shared sender, so it joins the candidate list every unknown inbound number is matched against.',
  })
  const { seedStage, STAGES } = await import('@/lib/seed')
  if (!(STAGES as readonly string[]).includes(wanted)) {
    console.error()
    console.error(`${c.red('x')} no such stage ${c.bold(wanted || '(none given)')}`)
    console.error(`  one of: ${STAGES.join(', ')}`)
    await closePool()
    process.exit(1)
  }
  const result = await seedStage(wanted as (typeof STAGES)[number], {
    slug: flag('slug'),
    name: flag('name'),
    timezone: flag('tz'),
  }).catch(async (e: unknown): Promise<never> => {
    console.error()
    console.error(`${c.red('x')} seeding stage "${wanted}" failed`)
    console.error(`  ${c.red(e instanceof Error ? (e.stack ?? e.message) : String(e))}`)
    await closePool()
    process.exit(1)
  })

  console.log()
  if (wantsJson) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(`${c.bold('seed')} ${c.dim('·')} stage ${c.cyan(result.stage)} ${c.dim('·')} ${result.name}`)
    console.log(c.dim(`academy  ${result.academyId}`))
    for (const [role, list] of Object.entries(result.contacts)) {
      for (const p of list) {
        console.log(`  ${role.padEnd(7)} ${c.cyan(p.contactId)}  ${p.name.padEnd(18)} ${c.dim(p.phone)}`)
      }
    }
    console.log(c.dim(`  ${Object.entries(result.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`))
  }
  await closePool()
  console.log()
  console.log(`${c.green('done')} ${c.dim('· open http://localhost:3000/emulator')}`)
  console.log()
  process.exit(0)
}

/** The seeded world starts at domain now, rendered the way a user would read it. */
async function clockLabel(iso: string): Promise<string> {
  try {
    const { inZone } = await import('@/lib/clock')
    return `${inZone(new Date(iso), 'Asia/Kolkata').label}  ${c.dim(iso)}`
  } catch {
    return iso
  }
}

async function closePool(): Promise<void> {
  try {
    const db = await import('@/lib/db')
    await db.closePool()
  } catch {
    /* nothing open */
  }
}

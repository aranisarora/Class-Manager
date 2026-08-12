/**
 * seed — build a world for the emulator.
 *
 *   npm run seed            # both academies
 *   npm run seed ace        # the multi-coach world only
 *   npm run seed solo       # the one-person world only (§18)
 *   npm run seed both --json
 *
 * The seeding itself lives in `lib/seed.ts`; this is only a mouth for it.
 */
import { c, loadEnvFiles } from './_env'

loadEnvFiles()

const args = process.argv.slice(2)
const wantsJson = args.includes('--json')
const scenario = args.find((a) => !a.startsWith('--')) ?? 'both'

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

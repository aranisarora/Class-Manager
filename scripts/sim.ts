/**
 * sim — run one persona against one goal, headless, and print the judge report.
 *
 *   npm run sim -- --list
 *   npm run sim -- --contact <contact-uuid>
 *   npm run sim -- --contact <uuid> --persona terse-parent --goal move-to-saturday
 *   npm run sim -- --contact <uuid> --goal "Dispute the August tally" \
 *                  --success "the charge is explained;an adjustment is offered"
 *
 * Flags: --seed <s> --turns <n> --label <s> --quiet --full --json
 * The transcript streams as it happens unless --quiet. The same seed against
 * the same world replays identically (§17), so the seed defaults to the
 * persona's slug rather than to something random.
 *
 * Exits non-zero when the goal was not reached, a critical finding was raised,
 * or the judge itself errored — so a run is usable as a check, not just a read.
 */
import type { PersonaDef } from '@/lib/sim/personas'
import type { JudgeReport } from '@/lib/sim/judge'
import type { SimEntry, SimGoal } from '@/lib/sim/run'
import { c, loadEnvFiles } from './_env'

loadEnvFiles()

const args = process.argv.slice(2)

function arg(name: string): string | undefined {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i === -1) return undefined
  const found = args[i] as string
  if (found.includes('=')) return found.slice(found.indexOf('=') + 1)
  const next = args[i + 1]
  return next !== undefined && !next.startsWith('--') ? next : ''
}
const has = (name: string) => args.some((a) => a === `--${name}` || a.startsWith(`--${name}=`))

function die(...lines: string[]): never {
  console.error()
  for (const line of lines) console.error(line)
  console.error()
  process.exit(1)
}

const { runPersona, PERSONA_DEFS, GOAL_DEFS, findPersona, findGoal } = await import('@/lib/sim/run')
const { judge } = await import('@/lib/sim/judge')

if (PERSONA_DEFS.length === 0) die(c.red('lib/sim exports no personas.'))

if (has('list') || args.length === 0) {
  console.log()
  console.log(`${c.bold('personas')} ${c.dim(`· ${PERSONA_DEFS.length}`)}`)
  for (const p of PERSONA_DEFS) {
    console.log(`  ${c.cyan(p.slug.padEnd(22))} ${p.name} ${c.dim(`· fits ${p.fits.join(', ')}`)}`)
    console.log(`  ${' '.repeat(22)} ${c.dim(p.description)}`)
    if (p.traits.length) console.log(`  ${' '.repeat(22)} ${c.dim(`traits: ${p.traits.join(', ')}`)}`)
  }
  console.log()
  console.log(`${c.bold('goals')} ${c.dim(`· ${GOAL_DEFS.length}`)}`)
  for (const g of GOAL_DEFS) {
    const clock = g.needsClock ? ' · needs the clock' : ''
    console.log(`  ${c.cyan(g.slug.padEnd(22))} ${g.text} ${c.dim(`· ${g.maxTurns} turns${clock}`)}`)
  }
  console.log()
  console.log(c.dim('  npm run sim -- --contact <contact-uuid> --persona <slug> --goal <slug>'))
  console.log()
  process.exit(0)
}

const contactId = arg('contact') ?? ''
if (!contactId) {
  die(
    c.red('--contact <contact-uuid> is required — open a pane in the emulator to find one.'),
    c.dim('  npm run sim -- --list   to see the personas and goals'),
  )
}

function pickPersona(wanted: string | undefined): PersonaDef {
  if (!wanted) return PERSONA_DEFS[0] as PersonaDef
  try {
    return findPersona(wanted)
  } catch {
    return die(
      c.red(`unknown persona "${wanted}"`),
      c.dim(`  known: ${PERSONA_DEFS.map((p) => p.slug).join(', ')}`),
    )
  }
}

function pickGoal(wanted: string | undefined, criteria: string[]): SimGoal {
  if (!wanted) {
    const first = GOAL_DEFS[0]
    if (!first) return die(c.red('lib/sim exports no goals — pass --goal "<text>" instead.'))
    return criteria.length ? { ...first, successCriteria: criteria } : first
  }
  try {
    const found = findGoal(wanted)
    return criteria.length ? { ...found, successCriteria: criteria } : found
  } catch {
    // Free text is a legitimate goal; findGoal fills the knobs for an ad-hoc one.
    return { text: wanted, successCriteria: criteria }
  }
}

const persona = pickPersona(arg('persona'))
const goal = pickGoal(
  arg('goal'),
  (arg('success') ?? '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean),
)

const seed = arg('seed') ?? persona.slug
const turns = Number(arg('turns') ?? '')
const maxTurns = Number.isFinite(turns) && turns > 0 ? turns : undefined
const label = arg('label')
const quiet = has('quiet')
const full = has('full')

console.log()
console.log(`${c.bold('sim')} ${c.dim('·')} ${c.cyan(persona.name)} ${c.dim(`(${persona.slug})`)}`)
console.log(c.dim(`goal     ${goal.text}`))
console.log(
  c.dim(`seed     ${seed}   contact ${contactId}${maxTurns ? `   max ${maxTurns} turns` : ''}`),
)
console.log()

const started = performance.now()
let stage: 'run' | 'judge' = 'run'

try {
  // `runPersona` reviews the run itself by default; this script calls `judge`
  // below, so the built-in pass is turned off rather than paid for twice.
  const options: Parameters<typeof runPersona>[0] = { seed, contactId, persona, goal, judge: false }
  if (maxTurns) options.maxTurns = maxTurns
  if (label) options.label = label
  if (!quiet) options.onEntry = (e) => console.log(entryLine(e))

  const run = await runPersona(options)

  if (!quiet) console.log()
  console.log(
    c.dim(
      `${run.academyName} · ${run.personName} (${run.roles.join(', ') || 'no role'}) · ` +
        `${run.turns} turn${run.turns === 1 ? '' : 's'} · stopped: ${run.stopReason}` +
        (run.clockAdvancedMs ? ` · clock +${Math.round(run.clockAdvancedMs / 60000)}m` : ''),
    ),
  )
  if (run.sideEffects.length) {
    console.log(c.dim(`side effects · ${run.sideEffects.length} message(s) to other people`))
    for (const s of run.sideEffects) {
      const dropped = s.suppressedReason ? c.yellow(` suppressed: ${s.suppressedReason}`) : ''
      console.log(`  ${c.dim('->')} ${s.toName.padEnd(18)} ${clip(s.body, 76)}${dropped}`)
    }
  }
  if (run.error) console.log(`${c.red('run error')} ${run.error}`)
  console.log()

  stage = 'judge'
  const report = await judge(run)
  const seconds = ((performance.now() - started) / 1000).toFixed(1)

  if (has('json')) {
    console.log(JSON.stringify({ run, report }, null, 2))
  } else {
    printReport(report)
  }

  const bad = report.counts.critical > 0 || !report.goalReached || Boolean(report.error)
  await closePool()

  console.log()
  console.log(
    bad
      ? `${c.red('x')} ${
          report.goalReached ? 'goal reached, but critical findings' : 'goal not reached'
        } ${c.dim(`· ${seconds}s`)}`
      : `${c.green('done')} ${c.dim(`· ${seconds}s`)}`,
  )
  console.log()
  process.exit(bad ? 1 : 0)
} catch (e) {
  console.error()
  console.error(`${c.red('x')} the ${stage} failed`)
  console.error(`  ${c.red(e instanceof Error ? (e.stack ?? e.message) : String(e))}`)
  await closePool()
  process.exit(1)
}

// ---------------------------------------------------------------------------

function clip(s: string, n: number): string {
  const one = (s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

function entryLine(e: SimEntry): string {
  const who =
    e.actor === 'persona'
      ? c.cyan('persona')
      : e.actor === 'clock'
        ? c.dim('clock  ')
        : c.blue('system ')

  const meta: string[] = []
  if (e.kind === 'message') {
    meta.push(e.inWindow ? 'in-window' : `template ${e.templateName ?? '?'}`)
    if (e.catalogId) meta.push(e.catalogId)
    if (e.costPaise) meta.push(`${e.costPaise}p`)
    if (e.status && e.status !== 'sent') meta.push(e.status)
  }
  if (e.kind === 'suppressed') meta.push(c.yellow(`suppressed: ${e.suppressedReason ?? '?'}`))
  if (e.kind === 'tap' && e.tapped) meta.push(`tap: ${e.tapped.title}`)
  if (e.kind === 'clock' && e.advancedMs) meta.push(`+${Math.round(e.advancedMs / 60000)}m`)
  if (typeof e.frustration === 'number' && e.frustration >= 3) {
    meta.push(c.yellow(`frustration ${e.frustration}`))
  }

  const body = full ? (e.body ?? '').trim() : clip(e.body ?? '', 96)
  const buttons = e.buttons?.length
    ? `\n${' '.repeat(20)}${c.dim(`[ ${e.buttons.map((b) => b.title).join(' | ')} ]`)}`
    : ''
  const tail = meta.length ? `  ${c.dim(`· ${meta.join(' · ')}`)}` : ''
  return `${c.dim(clip(e.atLabel, 11).padEnd(11))} ${who}  ${body}${tail}${buttons}`
}

function printReport(r: JudgeReport): void {
  console.log(`${c.bold('judge')} ${c.dim(`· ${r.model} · ${(r.ms / 1000).toFixed(1)}s`)}`)
  console.log(
    `  goal           ${r.goalReached ? c.green('reached') : c.red('not reached')}` +
      (r.turnsToGoal !== null ? c.dim(`  in ${r.turnsToGoal} turn(s)`) : ''),
  )
  if (r.goalEvidence) console.log(`  evidence       ${c.dim(clip(r.goalEvidence, 90))}`)

  const s = r.scores
  console.log(
    `  scores         clarity ${s.clarity}  efficiency ${s.efficiency}  ` +
      `correctness ${s.correctness}  doctrine ${s.doctrine}  ${c.bold(`overall ${s.overall}`)}`,
  )

  if (r.criteria.length) {
    console.log('  criteria')
    for (const k of r.criteria) {
      const evidence = k.evidence ? c.dim(`  — ${clip(k.evidence, 70)}`) : ''
      console.log(`    ${k.met ? c.green('met ') : c.red('miss')}  ${k.criterion}${evidence}`)
    }
  }

  const counts = Object.entries(r.counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${k}`)
    .join(' · ')
  console.log(`  findings       ${counts || c.dim('none')}`)
  for (const f of r.findings) {
    const tone =
      f.severity === 'critical'
        ? c.red
        : f.severity === 'major'
          ? c.yellow
          : f.kind === 'good'
            ? c.green
            : c.dim
    const at = f.atIndex >= 0 ? `@${f.atIndex}` : '  '
    console.log(
      `    ${tone(f.severity.padEnd(8))} ${f.kind.padEnd(18)} ${c.dim(at)} ${clip(f.quote, 70)}`,
    )
    if (f.explanation) console.log(`             ${c.dim(clip(f.explanation, 96))}`)
    if (f.suggestion) console.log(`             ${c.dim(`-> ${clip(f.suggestion, 94)}`)}`)
  }

  if (r.summary) {
    console.log('  summary')
    console.log(`    ${r.summary.replace(/\n/g, '\n    ')}`)
  }
  if (r.error) console.log(`  ${c.red(`judge error: ${r.error}`)}`)
}

async function closePool(): Promise<void> {
  try {
    const db = await import('@/lib/db')
    await db.closePool()
  } catch {
    /* nothing open */
  }
}

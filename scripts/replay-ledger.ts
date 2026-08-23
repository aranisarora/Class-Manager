/**
 * Replay a recorded run's tool calls through the REAL action-ledger rendering
 * (`recentActions` in lib/agent/loop.ts) and print what each call renders as.
 *
 *   npx tsx scripts/replay-ledger.ts                      # newest run
 *   npx tsx scripts/replay-ledger.ts .probe/runs/<dir> …  # specific run(s)
 *
 * Why this exists: on 23 Aug 2026 a staged-preview guard in that rendering shipped
 * gate-green and could never fire (F-EL) — a plan waiting on a tap rendered
 * "done — wrote 21 row(s)" in every later turn's context — and nothing could
 * exercise the guard against a recorded run to find out. This is that exercise:
 * the same function the runtime calls, fed the tool results a run actually
 * recorded, so a dead render is a number here before it is a month of drives.
 *
 * It prints and judges nothing — the reader decides whether "staged" and "done"
 * landed on the right calls. The crosstab exists because `plan`'s own
 * `needs_preview` is ground truth the render can be read against.
 */
import './_env'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { recentActions } from '@/lib/agent/loop'

const identity = {
  contact: { id: 'replay-contact' },
  person: { full_name: 'Replay' },
  academyId: '00000000-0000-0000-0000-000000000000',
} as any

// `reply` is excluded because its ledger line resolves recipient NAMES against the
// database — the one branch of `recentActions` a replay must not wander into.
const SKIP = new Set(['read', 'view', 'remember', 'reflect:remember', 'reply'])

function newestRun(): string {
  const root = '.probe/runs'
  const dirs = readdirSync(root)
    .map((d) => join(root, d))
    .filter((d) => {
      try {
        return statSync(join(d, 'turns.jsonl')).isFile()
      } catch {
        return false
      }
    })
    .sort((a, b) => statSync(join(b, 'turns.jsonl')).mtimeMs - statSync(join(a, 'turns.jsonl')).mtimeMs)
  if (!dirs.length) throw new Error('no runs with a turns.jsonl under .probe/runs')
  return dirs[0]
}

async function main() {
  const runs = process.argv.slice(2).length ? process.argv.slice(2) : [newestRun()]
  for (const run of runs) {
    const lines = readFileSync(join(run, 'turns.jsonl'), 'utf8').split('\n').filter(Boolean)
    let done = 0
    let staged = 0
    let other = 0
    let calls = 0
    const crosstab: Record<string, number> = {}
    const samples: Record<string, string[]> = { staged: [], done: [] }
    for (const l of lines) {
      const t = JSON.parse(l)
      for (const r of t.rounds ?? []) {
        const name = String(r.name ?? '')
        if (!name || name.startsWith('(') || SKIP.has(name)) continue
        calls++
        const row = [{ created_at: new Date(0), tool_calls: [{ name, args: r.args, result: r.result, error: r.error }] }]
        const rendered = await recentActions(row as any, identity)
        const cls = rendered?.includes('staged behind a confirmation button')
          ? 'staged'
          : rendered?.includes('done — wrote')
            ? 'done'
            : 'other'
        if (cls === 'staged') staged++
        else if (cls === 'done') done++
        else other++
        if (samples[cls] && samples[cls].length < 4)
          samples[cls].push(String(rendered).replace(/\s+/g, ' ').slice(0, 170))
        if (name === 'plan' && r.result && typeof r.result === 'object') {
          const key = `plan needs_preview=${(r.result as any).needs_preview} -> ${cls}`
          crosstab[key] = (crosstab[key] ?? 0) + 1
        }
      }
    }
    console.log(`\n=== ${run}: ${calls} ledger-rendered calls — done=${done} staged=${staged} other=${other}`)
    for (const [k, v] of Object.entries(crosstab).sort()) console.log(`  ${k}: ${v}`)
    for (const [k, v] of Object.entries(samples)) if (v.length) console.log(`  ${k} samples:\n    ${v.join('\n    ')}`)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

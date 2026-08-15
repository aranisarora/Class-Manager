/**
 * probe-ceiling — how many tool declarations a model actually takes.
 *
 *   npx tsx scripts/probe-ceiling.ts [--models a,b] [--runs 2]
 *
 * **The ten-tool ceiling this script was written to test does not exist.** It was
 * a real observation and a wrong diagnosis: on the previous provider, adding an
 * eleventh declaration — any eleventh, including one whose whole schema is a
 * single optional string — made EVERY turn come back malformed, and the count was
 * blamed. The cause was an empty enum. `act`'s schema was
 * `enum: Object.keys(OPERATIONS)`, those declarations were built at module load,
 * and one extra import edge made that list empty; an empty enum is a declaration
 * a provider may refuse, and its symptom is precisely "every turn returns
 * malformed with zero output tokens". An eleventh tool perturbed the import
 * graph, so the ceiling looked real every time it was tested. The lazy build in
 * `lib/agent/tools.ts` fixed the cause.
 *
 * This script is what settled it — the real declarations plus K trivial ones,
 * against the real prefix: 10 / 11 / 15 / 30 / 60 all clean, 2/2. Re-verified on
 * DeepSeek in phase 6: 36 / 56 / 86 declarations, 2/2 clean each, real prefix.
 * The operations are declared as real functions instead of hiding behind one
 * untyped `act`.
 *
 * Keep it because the belief was expensive while it stood: 20-odd operations
 * behind one `act` with `args: {type:'object'}` and no properties, their signatures
 * carried as ~7k characters of prose in the stable prefix where the decoder cannot
 * use them, and `view` swallowing two unrelated screens to avoid becoming an
 * eleventh tool. Re-run it before believing any new declaration-count folklore, on
 * any new model.
 *
 * A run is BROKEN if the model returns no candidate and no text, or if the
 * request is rejected outright, or if a tool call arrives whose `arguments` do
 * not parse, which is the shape the same failure takes on this wire.
 */
import { loadEnvFiles, c } from './_env'

loadEnvFiles()

const argv = process.argv.slice(2)
function flag(name: string, fallback: string): string {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i === -1) return fallback
  const a = argv[i] as string
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? fallback)
}

const MODELS = flag('models', 'deepseek-v4-flash,deepseek-v4-pro').split(',').map((s) => s.trim())
const RUNS = Number(flag('runs', '2'))
const EXTRAS = flag('extras', '0,1,5,20,50').split(',').map((s) => Number(s.trim()))

const { generate } = await import('@/lib/agent/deepseek')
const { stablePrefix } = await import('@/lib/agent/context')
const { toolDecls } = await import('@/lib/agent/tools')

const base = toolDecls()
const system = stablePrefix()

/** A padding declaration with parameters of its own — the shape the ceiling note names. */
const filler = (i: number) => ({
  name: `probe_noop_${i}`,
  description: `A placeholder tool that does nothing. Never call this; it exists only to occupy a declaration slot (${i}).`,
  parametersJsonSchema: {
    type: 'object',
    properties: { note: { type: 'string', description: 'Ignored.' } },
  },
})

const TAIL = `# Who you are talking to

Sharwin Rao — admin (runs the business).

# The business

Name: Ace TT Academy — badminton. Timezone: Asia/Kolkata.
Onboarding state: setup. 0 venues, 0 classes, 0 families.

# Now

It is 09:14 on Thursday 13 Aug 2026, Asia/Kolkata.

---

add a beginners batch mon wed fri 6.30 to 7.30pm at green park, 1500 a month`

console.log(
  c.dim(`${base.length} real declarations · prefix ${system.length.toLocaleString()} chars · extras ${EXTRAS.join(',')} · ${RUNS} run(s)`),
)

for (const model of MODELS) {
  console.log(c.bold(`\n${model}`))
  for (const extra of EXTRAS) {
    const tools = [...base, ...Array.from({ length: extra }, (_, i) => filler(i))]
    let broken = 0
    let called = 0
    let rejected: string | null = null
    const finishes: string[] = []

    for (let i = 0; i < RUNS; i++) {
      try {
        const res = await generate({
          system,
          messages: [{ role: 'user' as const, content: TAIL }],
          tools,
          model,
          temperature: 0.4,
        })
        if (res.finishReason) finishes.push(res.finishReason)
        if (res.functionCalls.some((f) => f.parseError)) broken++
        else if (!res.functionCalls.length && !res.text.trim()) broken++
        else if (res.functionCalls.length) called++
      } catch (e) {
        rejected = (e as Error)?.message?.slice(0, 160) ?? String(e)
        broken++
      }
    }

    const n = tools.length
    const verdict = rejected
      ? c.red(`REJECTED — ${rejected}`)
      : broken > 0
        ? c.red(`${broken}/${RUNS} returned nothing (malformed)`)
        : c.green(`${called}/${RUNS} clean function call`)
    console.log(`  ${String(n).padStart(3)} decls (${String(extra).padStart(2)} extra)  ${verdict}  ${c.dim(finishes.join(',') || '')}`)
  }
}

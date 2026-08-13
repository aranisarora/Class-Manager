/**
 * probe-ceiling — is the 10-declaration ceiling real, and is it real on Gemini 3?
 *
 *   npx tsx scripts/probe-ceiling.ts [--models a,b] [--runs 2]
 *
 * `lib/agent/tools.ts` enforces `MAX_TOOL_DECLS = 10` as a hard boot-time throw,
 * on a measurement that says an eleventh declaration — "any eleventh with
 * parameters of its own, including one whose whole schema is a single optional
 * string" — makes EVERY turn return MALFORMED_FUNCTION_CALL.
 *
 * That constraint is load-bearing for the whole architecture: 25 operations hide
 * behind one `act` with `args: {type:'object'}` and no properties, their
 * signatures are carried as ~7k characters of prose in the stable prefix, and
 * `view` swallowed two unrelated screens to avoid becoming an eleventh tool.
 *
 * Google documents the limit as **128** declarations per request, and the error
 * users actually hit at scale is a *nesting depth* one, not a count one. Both
 * cannot be right, so this measures it: the real ten declarations plus K trivial
 * ones, against the real prefix, on each model.
 *
 * A run is BROKEN if the model returns no candidate and no text — the signature
 * of MALFORMED_FUNCTION_CALL — or if the request is rejected outright.
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

const MODELS = flag('models', 'gemini-2.5-flash,gemini-3-flash-preview').split(',').map((s) => s.trim())
const RUNS = Number(flag('runs', '2'))
const EXTRAS = flag('extras', '0,1,5,20,50').split(',').map((s) => Number(s.trim()))

const { generate } = await import('@/lib/agent/gemini')
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
          contents: [{ role: 'user', parts: [{ text: TAIL }] }],
          tools,
          model,
          temperature: 0.4,
        })
        if (res.finishReason) finishes.push(res.finishReason)
        if (!res.functionCalls.length && !res.text.trim()) broken++
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

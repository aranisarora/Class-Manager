/**
 * count-prefix-tokens — the prefix in REAL tokens, not chars ÷ 4.
 *
 * `scripts/probe-prefix.ts` measures characters and divides by four. That rule
 * of thumb is fine for arguing about proportions but it is not a number you can
 * put in a cost model, because the divisor is wrong in a direction nobody knows
 * without asking the tokenizer. DeepSeek publishes no tokenizer endpoint, so the
 * only ground truth is `usage.prompt_tokens` on a real call.
 *
 * Four calls, differenced against a baseline so the per-request envelope
 * (role scaffolding, chat template, whatever else the server prepends) is
 * subtracted out rather than silently attributed to the prefix:
 *
 *   A  minimal system, no tools   → the envelope
 *   B  real prefix, no tools      → B − A = prefix
 *   C  minimal system, real tools → C − A = tool declarations
 *   D  real prefix, real tools    → D − A = the whole cached block
 *
 * max_tokens is 1 and thinking is off: this measures input, and output is pure
 * waste here. Total cost of a run is under a rupee.
 */
import { loadEnvFiles } from './_env'

loadEnvFiles()

const { stablePrefix } = await import('@/lib/agent/context')
const { toolDecls } = await import('@/lib/agent/tools')

const KEY = process.env.DEEPSEEK_API_KEY
if (!KEY) throw new Error('DEEPSEEK_API_KEY missing')
const MODEL = process.env.MODEL_MAIN ?? 'deepseek-v4-flash'

const prefix = stablePrefix()
const tools = toolDecls().map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.parametersJsonSchema },
}))

async function promptTokens(system: string, useTools: boolean): Promise<number> {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: 'x' },
    ],
    max_tokens: 1,
    thinking: { type: 'disabled' },
  }
  if (useTools) body.tools = tools
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  const j: any = await res.json()
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(j).slice(0, 400)}`)
  return j.usage?.prompt_tokens ?? NaN
}

const A = await promptTokens('x', false)
const B = await promptTokens(prefix, false)
const C = await promptTokens('x', true)
const D = await promptTokens(prefix, true)

const prefixTok = B - A
const toolsTok = C - A
const blockTok = D - A

const toolsJson = JSON.stringify(toolDecls())
const r = (chars: number, tok: number) => (tok > 0 ? (chars / tok).toFixed(2) : '—')

const row = (label: string, chars: number, tok: number, est: number) =>
  console.log(
    `  ${label.padEnd(22)} ${chars.toLocaleString().padStart(8)} chars   ${tok
      .toLocaleString()
      .padStart(7)} tok   (est ${est.toLocaleString().padStart(7)})   ${r(chars, tok)} ch/tok`,
  )

console.log(`\nmodel: ${MODEL}   envelope baseline: ${A} tok\n`)
console.log(`  ${'component'.padEnd(22)} ${'chars'.padStart(14)}   ${'REAL'.padStart(11)}   ${'chars÷4'.padStart(13)}`)
console.log('  ' + '-'.repeat(84))
row('stable prefix', prefix.length, prefixTok, Math.round(prefix.length / 4))
row('tool declarations', toolsJson.length, toolsTok, Math.round(toolsJson.length / 4))
console.log('  ' + '-'.repeat(84))
row('CACHED BLOCK', prefix.length + toolsJson.length, blockTok, Math.round((prefix.length + toolsJson.length) / 4))

console.log(`\n  raw prompt_tokens on the full cached-block call (envelope included): ${D}`)
console.log(
  `  chars÷4 is off by ${(((prefix.length + toolsJson.length) / 4 / blockTok - 1) * 100).toFixed(1)}% on this block.\n`,
)

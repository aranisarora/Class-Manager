/**
 * probe-prefix — where the stable prefix actually goes, in characters.
 *
 *   npx tsx scripts/probe-prefix.ts
 *
 * FINDINGS open item 3 says the prefix is 2× its §4.4 budget and names the two
 * suspects by feel. This prints the split, plus the size of the tool
 * declarations — which travel in the same cached block and are the other half of
 * any argument about moving information from prose into schema.
 */
import { loadEnvFiles, c } from './_env'

loadEnvFiles()

const { stablePrefix } = await import('@/lib/agent/context')
const { toolDecls } = await import('@/lib/agent/tools')
const { operationSignatures, OPERATIONS } = await import('@/lib/agent/operations')
const { SCHEMA_DOC } = await import('@/lib/agent/schema-doc')
const { catalogDigest } = await import('@/lib/messaging/catalog')

const prefix = stablePrefix()
const tools = toolDecls()
const toolsJson = JSON.stringify(tools)

const catalog = catalogDigest()

/**
 * What the prefix ACTUALLY carries, not what the function would return.
 *
 * These were reported as `operationSignatures().length` regardless, so after the
 * signatures moved into the tool declarations this line went on claiming 5,789
 * characters of a block that is no longer in the string being measured — a
 * report that disagreed with its own TOTAL. Measure the artifact, not the
 * ingredient.
 */
const builtSigs = operationSignatures()
const sigs = prefix.includes(builtSigs.trim()) ? builtSigs : ''

/** ~4 chars per token is the usual rule of thumb; good enough to argue with. */
const tok = (n: number) => `~${Math.round(n / 4).toLocaleString()} tok`
const row = (label: string, chars: number, of: number) =>
  console.log(
    `  ${label.padEnd(26)} ${chars.toLocaleString().padStart(9)} chars  ${tok(chars).padStart(12)}  ${
      of ? `${((100 * chars) / of).toFixed(1)}%` : ''
    }`,
  )

console.log(c.bold('\nstable prefix'))
row('TOTAL', prefix.length, 0)
row('· schema doc', SCHEMA_DOC.length, prefix.length)
row('· operation signatures', sigs.length, prefix.length)
row('· catalog digest', catalog.length, prefix.length)
row(
  '· everything else',
  prefix.length - SCHEMA_DOC.length - sigs.length - catalog.length,
  prefix.length,
)

console.log(c.bold('\ntool declarations (same cached block)'))
row('TOTAL', toolsJson.length, 0)
for (const t of tools) {
  row(`· ${t.name}`, JSON.stringify(t).length, toolsJson.length)
}

const nOps = Object.keys(OPERATIONS).length
console.log(c.bold('\nprose signatures vs declared schema'))
if (sigs.length) {
  console.log(`  ${nOps} operations · ${sigs.length.toLocaleString()} chars of prose IN THE PREFIX (declarations are off)`)
  console.log(c.dim(`  ${Math.round(sigs.length / nOps)} chars per operation, in the one form the decoder cannot apply.`))
} else {
  const declared = tools.filter((t) => t.name in OPERATIONS)
  const declaredChars = declared.reduce((a, t) => a + JSON.stringify(t).length, 0)
  console.log(`  ${declared.length} of ${nOps} operations declared as tools · ${declaredChars.toLocaleString()} chars of schema`)
  console.log(
    c.dim(
      `  ${Math.round(declaredChars / Math.max(1, declared.length))} chars per operation, vs ${Math.round(
        builtSigs.length / nOps,
      )} as prose — ${(declaredChars / Math.max(1, builtSigs.length)).toFixed(1)}× the bytes, applied as a\n` +
        '  hard constraint during decoding rather than read as a paragraph.',
    ),
  )
}

console.log(c.bold('\ntotal cached block'))
row('prefix + tools', prefix.length + toolsJson.length, 0)
console.log()

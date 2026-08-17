/**
 * probe-surface — everything the model is actually shown, in one file.
 *
 *   npx tsx scripts/probe-surface.ts > .probe/surface.txt
 *
 * The stable prefix and the tool declarations travel in the same cached block and
 * are the complete set of things the model knows before the tail is built. Nothing
 * else reaches it. Dumping them together gives you one artifact to search when you
 * are asking the only question that matters about a prompt: **is this fact in here
 * at all?**
 *
 * Reading the prefix in `context.ts` does NOT answer that question, for two reasons.
 * The declarations are half the surface and they live in a different file. And a
 * fact can be present in one layer while being contradicted or buried in another —
 * which is only visible in the assembled string.
 *
 * This exists because coverage is not verifiable from the prefix side. Reading the
 * prompt tells you what is there; it cannot tell you what is missing, because
 * absence has nothing to point at. `lint.ts` converted markdown to WhatsApp markup
 * for as long as it existed while nothing above the boundary mentioned formatting,
 * and that gap survived every reading of `context.ts` — it was found by reading the
 * runtime and asking what it does that the prompt never says. So the method is:
 * inventory the runtime independently, then grep THIS artifact for each item.
 * See `PREFIX.md`.
 */
import { loadEnvFiles, c } from './_env'

loadEnvFiles()

const { stablePrefix } = await import('@/lib/agent/context')
const { toolDecls } = await import('@/lib/agent/tools')

const prefix = stablePrefix()
const tools = toolDecls()

const bar = (label: string) => `\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}\n`

let out = ''
out += bar('STABLE PREFIX — every turn, every person, every business')
out += prefix

out += bar(`TOOL DECLARATIONS — ${tools.length} tools, same cached block`)
for (const t of tools) {
  out += `\n${'-'.repeat(78)}\n${t.name}\n${'-'.repeat(78)}\n`
  // The description and the parameter schema are BOTH prompt. The schema half is the
  // half that constrains decoding, and it is the half nobody reads when reviewing a
  // prompt — which is exactly why argument-level facts go missing from audits.
  out += `${t.description ?? '(no description)'}\n\n`
  out += JSON.stringify(t.parametersJsonSchema ?? {}, null, 2)
  out += '\n'
}

// Everything above is what the model sees. The counts go to stderr so the artifact
// on stdout stays byte-comparable between runs — a diff of two surfaces is how you
// see what a prompt change actually did.
const chars = out.length
process.stderr.write(
  c.bold('\nmodel-facing surface\n') +
    `  prefix        ${prefix.length.toLocaleString().padStart(9)} chars\n` +
    `  declarations  ${JSON.stringify(tools).length.toLocaleString().padStart(9)} chars  (${tools.length} tools)\n` +
    `  dumped        ${chars.toLocaleString().padStart(9)} chars  ~${Math.round(chars / 4).toLocaleString()} tok\n\n` +
    c.dim('  Searching for a fact? grep this artifact. If it is not here, the model does not know it.\n\n'),
)

process.stdout.write(out)

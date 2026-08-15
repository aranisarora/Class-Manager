/**
 * lib/agent/schema-json.ts — an operation's zod schema, as the JSON Schema the
 * tool declaration carries.
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * The declared schema is not documentation. It travels WITH the call, at the
 * decode point, in the form a decoder can use — a property the declaration names
 * is a property the model has in front of it as it writes the arguments, and an
 * `enum` is a set it can see the whole of. Everything this module produces is
 * therefore worth more than the same information written as prose.
 *
 * **What changed with the provider, and it matters here.** On Vertex this was a
 * hard constraint: the decoder physically could not emit a property the schema
 * did not name. DeepSeek applies tool schemas as guidance outside `/beta`'s
 * `strict` mode, so a misspelled property is now *possible* where it used to be
 * impossible. Nothing in this file changes because of that — a schema at the
 * decode point is still the strongest instrument available, and it is now the
 * only one — but the runtime is what catches a bad call rather than the wire,
 * which is why `runTool` validates and why a parse failure has a designed path
 * through the loop instead of being unreachable.
 *
 * And that is exactly how the same information was being carried. `act` declared
 * `args: { type: 'object' }` — no properties, nothing required, nothing typed —
 * while all 20-odd operation signatures travelled as ~5.8k characters of prose in
 * the stable prefix, tens of thousands of characters upstream of the decode
 * point, in the one form the decoder cannot use. Measured cost of that: an
 * onboarding turn that called `add_family` with `players:[{full_name:"Aarav"}]`
 * where the schema says `name`, twice in a row, wrote nothing, and told the admin
 * it was having trouble with SQL syntax.
 *
 * WHAT THE DECLARATION MAY CONTAIN
 * -----------------------------------------------------------------------------
 * This was written to Vertex's OpenAPI subset — `type`, `nullable`, `required`,
 * `format`, `description`, `properties`, `items`, `enum`, and NOT `default`,
 * `optional`, `maximum` or, the one that shaped this file, **`oneOf`**. A
 * discriminated union could not be declared at all, which is why `plan`'s
 * five-way step union was never a schema that API could express, and why shipping
 * it as a JSON string was the right call rather than a lazy one.
 *
 * DeepSeek takes standard JSON Schema and its beta strict mode supports `anyOf`,
 * so that union could finally become a real declaration. **It has not been
 * changed here**, deliberately: that is schema work, not migration work, and it
 * would move the one thing every arc case depends on in the same change that
 * moved the provider. It is the first thing to do afterwards.
 *
 * Until then a union is *collapsed*, never expressed, and the collapse is lossy
 * on purpose: a slightly loose declaration that decodes is worth more than a
 * precise one the API rejects. Depth stays capped for the same reason.
 */
import type { z } from 'zod'

/** Past this, an object becomes an untyped object. Depth is a documented rejection cause. */
const MAX_DEPTH = 4

type Json = Record<string, unknown>

function def(schema: unknown): any {
  return (schema as { _def?: unknown } | null)?._def as any
}

/** zod carries `.describe()` text here, and it is the highest-value field in the output. */
function descriptionOf(schema: unknown): string | undefined {
  const d = def(schema)
  const text = d?.description
  return typeof text === 'string' && text.trim() ? text.trim() : undefined
}

/** Whether a key may be omitted — `required` is the inverse, and zod spells it three ways. */
function isOptional(schema: unknown): boolean {
  const t = def(schema)?.typeName
  return t === 'ZodOptional' || t === 'ZodDefault' || t === 'ZodNever' || t === 'ZodUndefined'
}

/**
 * A union, collapsed to something declarable.
 *
 * Literals become an `enum`, which is the case worth catching: it is the only
 * collapse that *keeps* information, and it is how zod spells most of this
 * product's closed sets. Everything else degrades to the branches' common type,
 * or to a bare string, with the alternatives written into the description so the
 * model still learns them from somewhere.
 */
function fromUnion(options: unknown[], depth: number): Json {
  const branches = options.map((o) => toJsonSchema(o, depth + 1))
  const literals = options
    .map((o) => (def(o)?.typeName === 'ZodLiteral' ? def(o)?.value : undefined))
    .filter((v) => v !== undefined)

  if (literals.length === options.length && literals.length > 0) {
    return { type: typeof literals[0] === 'number' ? 'number' : 'string', enum: literals }
  }

  const types = [...new Set(branches.map((b) => b.type).filter(Boolean))]
  if (types.length === 1) {
    // Same shape either way — keep it, and keep the richest branch's members.
    const richest = branches.reduce((a, b) =>
      Object.keys((b.properties as Json) ?? {}).length > Object.keys((a.properties as Json) ?? {}).length ? b : a,
    )
    return richest
  }
  return {
    type: 'string',
    description: `One of: ${types.join(' or ')}. Pass it as the plain value.`,
  }
}

/**
 * A zod schema as Gemini-flavoured JSON Schema.
 *
 * Never throws: a declaration that fails to build would take the whole tool
 * surface down at boot, and a loose `{type:'object'}` for one awkward argument is
 * a far smaller loss than that.
 */
export function toJsonSchema(schema: unknown, depth = 0): Json {
  const d = def(schema)
  const t = d?.typeName
  const description = descriptionOf(schema)
  const withDescription = (out: Json): Json => (description ? { ...out, description } : out)

  try {
    switch (t) {
      case 'ZodObject': {
        if (depth >= MAX_DEPTH) return withDescription({ type: 'object' })
        const raw = (schema as any).shape
        const shape = typeof raw === 'function' ? raw() : raw
        const properties: Json = {}
        const required: string[] = []
        for (const [key, value] of Object.entries(shape ?? {})) {
          properties[key] = toJsonSchema(value, depth + 1)
          if (!isOptional(value)) required.push(key)
        }
        return withDescription({
          type: 'object',
          properties,
          ...(required.length ? { required } : {}),
        })
      }
      case 'ZodString': {
        // `format` is supported and worth emitting: a date-time hint is the
        // difference between "2026-09-01" and "next Tuesday" reaching an operation.
        const checks: any[] = d?.checks ?? []
        const isDateTime = checks.some((c) => c?.kind === 'datetime')
        return withDescription({ type: 'string', ...(isDateTime ? { format: 'date-time' } : {}) })
      }
      case 'ZodNumber':
        return withDescription({ type: (d?.checks ?? []).some((c: any) => c?.kind === 'int') ? 'integer' : 'number' })
      case 'ZodBoolean':
        return withDescription({ type: 'boolean' })
      case 'ZodLiteral':
        return withDescription({ type: typeof d?.value === 'number' ? 'number' : 'string', enum: [d?.value] })
      case 'ZodEnum':
        return withDescription({ type: 'string', enum: d?.values ?? [] })
      case 'ZodNativeEnum':
        return withDescription({ type: 'string', enum: Object.values(d?.values ?? {}) })
      case 'ZodArray':
        if (depth >= MAX_DEPTH) return withDescription({ type: 'array', items: { type: 'string' } })
        return withDescription({ type: 'array', items: toJsonSchema(d?.type, depth + 1) })
      case 'ZodOptional':
      case 'ZodDefault':
        return { ...toJsonSchema(d?.innerType, depth), ...(description ? { description } : {}) }
      case 'ZodNullable':
        return { ...toJsonSchema(d?.innerType, depth), nullable: true, ...(description ? { description } : {}) }
      case 'ZodEffects':
        return { ...toJsonSchema(d?.schema, depth), ...(description ? { description } : {}) }
      case 'ZodUnion':
        return { ...fromUnion(d?.options ?? [], depth), ...(description ? { description } : {}) }
      case 'ZodRecord':
        // An open map has no declarable shape. Say so rather than inventing keys.
        return withDescription({ type: 'object' })
      case 'ZodAny':
      case 'ZodUnknown':
        return withDescription({ type: 'string' })
      default:
        return withDescription({ type: 'string' })
    }
  } catch {
    return { type: 'string' }
  }
}

/** The parameters block for one operation, always an object even when it takes nothing. */
export function parametersFor(params: z.ZodTypeAny | undefined): Json {
  if (!params) return { type: 'object', properties: {} }
  const out = toJsonSchema(params)
  if (out.type !== 'object') return { type: 'object', properties: {} }
  if (!out.properties) out.properties = {}
  return out
}

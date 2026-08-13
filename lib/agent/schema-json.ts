/**
 * lib/agent/schema-json.ts — an operation's zod schema, as the JSON Schema
 * Gemini constrains decoding with.
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * The declared schema is not documentation. Gemini applies it as a hard
 * constraint *while it generates the call*, so a property the declaration names
 * is a property the model cannot misspell, and an `enum` is a set it cannot
 * leave. Everything this module produces is therefore worth more than the same
 * information written as prose.
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
 * WHAT GOOGLE SUPPORTS, AND WHAT IT DOES NOT
 * -----------------------------------------------------------------------------
 * FunctionDeclaration parameters take an OpenAPI subset: `type`, `nullable`,
 * `required`, `format`, `description`, `properties`, `items`, `enum`. It does NOT
 * take `default`, `optional`, `maximum`, or — the one that shapes this file —
 * **`oneOf`**. A discriminated union cannot be declared at all, which is why
 * `plan`'s five-way step union was never a schema this API could express, and why
 * shipping it as a JSON string was the right call rather than a lazy one.
 *
 * So a union here is *collapsed*, never expressed, and the collapse is lossy on
 * purpose: a slightly loose declaration that decodes is worth more than a precise
 * one the API rejects. Deep nesting is also a documented rejection cause, so
 * depth is capped rather than trusted.
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

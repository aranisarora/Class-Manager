/**
 * lib/agent/gemini.ts — the model client. CONTRACTS §6.
 *
 * Vertex AI through @google/genai. Text and inlineData parts both go in the same
 * request: images, documents and — §14.5 — audio, which reaches the model AS
 * AUDIO. There is no transcription step anywhere in this product; the model holds
 * the roster and the conversation, which is what lets it resolve "Aarav/Arav"
 * against players who actually exist.
 *
 * This module records NOTHING to the database. loop.ts owns the `turn` row.
 */
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai'
import { env, serviceAccount } from '@/lib/env'
import { withSession } from '@/lib/db'
import { AppError } from '@/lib/errors'

export type GenPart = { text: string } | { inlineData: { mimeType: string; data: string } }
export type GenContent = { role: 'user' | 'model'; parts: any[] }
export type ToolDecl = { name: string; description: string; parametersJsonSchema: object }

export type GenResult = {
  text: string
  functionCalls: { name: string; args: Record<string, unknown> }[]
  /** The model's raw content parts — echo these back verbatim into history so Gemini 3
   *  thought signatures survive the round trip. */
  modelParts: any[]
  usage: { promptTokens: number; outputTokens: number; cachedTokens: number }
  model: string
  ms: number
}

function fail(code: string, message: string): never {
  throw new AppError({ code, message })
}

// -----------------------------------------------------------------------------
// Client. Credentials come from Core's `serviceAccount()` — this module has no
// business reading files.
// -----------------------------------------------------------------------------

let client: GoogleGenAI | null = null

function getClient(): GoogleGenAI {
  if (client) return client
  client = new GoogleGenAI({
    vertexai: true,
    project: env.VERTEX_PROJECT_ID,
    location: env.VERTEX_LOCATION,
    googleAuthOptions: {
      credentials: serviceAccount() as unknown as { client_email: string; private_key: string },
    },
  })
  return client
}

// -----------------------------------------------------------------------------
// §17 failure injection — sim_fault kind 'model_error'
// -----------------------------------------------------------------------------

const NIL_ACADEMY = '00000000-0000-0000-0000-000000000000'
const FAULT_TTL_MS = 2000
let faultCheckedAt = -Infinity
let faultRate = 0

/**
 * sim_fault is global infrastructure: its cm_service policy is `using (true)`,
 * so the academy GUC is irrelevant here — but withSession still wants one, and
 * setting the nil uuid keeps the "no query without declaring who you are" rule
 * mechanically true.
 */
async function modelFaultRate(): Promise<number> {
  const at = performance.now()
  if (at - faultCheckedAt < FAULT_TTL_MS) return faultRate
  faultCheckedAt = at
  try {
    const rows = (await withSession({ role: 'service', academyId: NIL_ACADEMY }, (tx) =>
      tx`select rate from sim_fault where kind = 'model_error' and active limit 1`,
    )) as unknown as { rate: unknown }[]
    faultRate = rows.length ? Number(rows[0].rate) : 0
    if (!Number.isFinite(faultRate)) faultRate = 0
  } catch {
    // No database, no faults. Failure injection must never be the thing that
    // breaks a model call.
    faultRate = 0
  }
  return faultRate
}

// -----------------------------------------------------------------------------
// generate
// -----------------------------------------------------------------------------

/** Ceiling on thinking for a structured-output call, so the JSON still fits. */
const THINKING_BUDGET_STRUCTURED = 2048

const RETRY_DELAY_MS = 1500

function isTransient(err: unknown): boolean {
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null
  if (!e) return false
  const status = typeof e.status === 'number' ? e.status : typeof e.code === 'number' ? e.code : 0
  if (status === 429 || status === 503) return true
  const msg = typeof e.message === 'string' ? e.message : String(err)
  return /\b(429|503)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|overloaded|rate limit/i.test(msg)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function generate(o: {
  system: string
  contents: GenContent[]
  tools?: ToolDecl[]
  model?: string
  temperature?: number
  maxOutputTokens?: number
  responseJsonSchema?: object
}): Promise<GenResult> {
  if (!o.contents || o.contents.length === 0) {
    fail('model_bad_request', 'generate() called with no contents')
  }
  if (Math.random() < (await modelFaultRate())) {
    fail('model_error', 'injected sim_fault: model_error')
  }

  const model = o.model ?? env.MODEL_MAIN
  const config: Record<string, unknown> = {
    systemInstruction: o.system,
    temperature: o.temperature ?? 0.4,
    maxOutputTokens: o.maxOutputTokens ?? 8192,
  }
  if (o.tools && o.tools.length > 0) {
    // Function declarations and a forced response schema are mutually exclusive
    // on Vertex; tools win, because a tool round is how the turn makes progress.
    config.tools = [
      {
        functionDeclarations: o.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.parametersJsonSchema,
        })),
      },
    ]
  } else if (o.responseJsonSchema) {
    config.responseMimeType = 'application/json'
    config.responseJsonSchema = o.responseJsonSchema
    // Thinking tokens are drawn from the SAME budget as the answer. A judge or a
    // digest reasoning its way through a long transcript can spend the entire
    // allowance before emitting a single byte of JSON, and what comes back is an
    // empty candidate that looks exactly like a parse failure. Bounding the
    // thinking leaves room for the structured answer the caller is waiting on.
    config.thinkingConfig = { thinkingBudget: THINKING_BUDGET_STRUCTURED }
    config.maxOutputTokens = o.maxOutputTokens ?? 16384
  }

  const request = { model, contents: o.contents as any, config: config as any }
  const started = performance.now()

  let res: GenerateContentResponse
  try {
    res = await getClient().models.generateContent(request)
  } catch (err) {
    if (!isTransient(err)) {
      fail('model_call_failed', `Vertex call failed: ${(err as Error)?.message ?? String(err)}`)
    }
    // One retry, 1.5s apart. 429 and 503 are the two the platform actually
    // hands back under load; anything else is a real error and retrying it just
    // doubles the latency before the same failure.
    await sleep(RETRY_DELAY_MS)
    res = await getClient()
      .models.generateContent(request)
      .catch((err2: unknown) =>
        fail(
          'model_call_failed',
          `Vertex call failed twice: ${(err2 as Error)?.message ?? String(err2)}`,
        ),
      )
  }

  const ms = Math.round(performance.now() - started)
  const candidate = res.candidates?.[0]
  // The raw parts, untouched. Callers push these straight back into history so
  // Gemini 3 thought signatures survive the round trip (§4.4 / tool loops).
  const modelParts: any[] = (candidate?.content?.parts ?? []) as any[]

  const text = modelParts
    .filter((p) => typeof p?.text === 'string' && p.thought !== true)
    .map((p) => p.text as string)
    .join('')

  const functionCalls = modelParts
    .filter((p) => p && typeof p === 'object' && p.functionCall)
    .map((p) => ({
      name: String(p.functionCall.name ?? ''),
      args: (p.functionCall.args ?? {}) as Record<string, unknown>,
    }))
    .filter((c) => c.name.length > 0)

  const u = res.usageMetadata
  return {
    text,
    functionCalls,
    modelParts,
    usage: {
      promptTokens: u?.promptTokenCount ?? 0,
      outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
      cachedTokens: u?.cachedContentTokenCount ?? 0,
    },
    model: res.modelVersion ?? model,
    ms,
  }
}

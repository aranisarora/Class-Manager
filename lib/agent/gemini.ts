/**
 * lib/agent/gemini.ts — **the previous model client, kept as the rollback road.**
 *
 * Nothing calls this any more: `lib/agent/deepseek.ts` is the client, and `loop.ts`,
 * `memory.ts` and both probes import that. It stays until the migration's phase 7
 * says otherwise (`deepseek-migration.md`) — N clean days of production traffic —
 * because until then flipping `MODEL_MAIN` back and re-pointing two imports is a
 * rollback that takes minutes, and deleting this file is what would make it a
 * rewrite. When phase 7 lands, this file, `@google/genai`, `VERTEX_*` and
 * `GOOGLE_APPLICATION_CREDENTIALS_JSON` all go together.
 *
 * **Its multimodal claim is repealed, not merely unused.** This file used to say
 * audio reached the model AS AUDIO with no transcription step anywhere in the
 * product. That was true of Vertex and is no longer true of anything: §14.5 is
 * repealed and the runtime answers media in words (`mediaRefusal`). If this road
 * is ever taken again, the media path does NOT come back with it — it was removed
 * from `loop.ts`, deliberately, as a product decision rather than a client limit.
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
  /**
   * Why the candidate stopped. Discarding this made every empty response look
   * alike: MAX_TOKENS (the turn was too big), SAFETY (the content was blocked)
   * and "simply done" all arrived as an empty string, and the turn row recorded
   * none of them. A caller that gets no text needs this to say anything true.
   */
  finishReason: string | null
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
// §4.4 — explicit prompt caching
//
// The stable prefix (doctrine, schema, nine behavior modules, operation signatures, the
// catalog) plus the tool declarations come to ~27k tokens on the front of every call, and
// §4.4's deal was that implicit caching would pay for them. Measured, it does not: turns
// logged 0 cached tokens across the board, hitting only between hops *within* one turn.
// Implicit caching is best-effort and nothing makes it bite, least of all on the `global`
// endpoint where consecutive calls need not land on the same backend.
//
// An explicit CachedContent does bite — the discount is contractual — but it is not free,
// and the arithmetic decides the design:
//
//   saved per call   0.75 × $0.30/1M × 27k ≈ $0.006
//   storage          $1.00/1M/hour × 27k   ≈ $0.027/hour
//
// So a cache pays for itself at roughly 4-5 calls an hour and *loses* money below that. A
// dev poking at one conversation, or a single academy's quiet Tuesday, would pay more in
// storage than it saves in input. Hence two rules, both of which fall out of that sum:
//
//   1. **Short TTL.** 15 minutes bounds the worst case to well under a cent, instead of an
//      hour of storage bought for one turn.
//   2. **Only cache a burst.** The first call of a cold window creates nothing. A second
//      call arriving while the first is still recent is evidence of traffic, and only then
//      is a cache worth buying. Real traffic keeps it permanently warm; an idle emulator
//      never creates one at all.
//
// The handle lives in this process, not in `academy.prompt_cache_handle`. That column
// assumed a per-academy prefix, and the prefix is deliberately academy-independent (§4.4:
// "no dates, no ids, no per-academy anything above the boundary") — one cache serves every
// tenant, and per-tenant rows would buy N copies of one identical thing. The column stays
// null on purpose.
// -----------------------------------------------------------------------------

const CACHE_TTL_SECONDS = 900
/** A second call within this window means traffic, not a one-off. */
const CACHE_BURST_WINDOW_MS = 5 * 60 * 1000
/** After a creation failure, stop trying for a while rather than per call. */
const CACHE_COOLDOWN_MS = 10 * 60 * 1000
/** Below the provider's minimum there is nothing to cache; well above it here, but cheap to assert. */
const CACHE_MIN_CHARS = 8000

type CacheEntry = { name: string; expiresAtMs: number }

/** Keyed by model + prefix + tools, because a change to any of them is a different cache. */
const cacheByKey = new Map<string, CacheEntry>()
const lastSeenByKey = new Map<string, number>()
let cacheDisabledUntilMs = 0

function cacheKey(model: string, system: string, tools: ToolDecl[] | undefined): string {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9
  const s = `${model}\u0000${system}\u0000${(tools ?? []).map((t) => t.name).join(',')}\u0000${
    (tools ?? []).length
  }`
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 + c, 2246822519) >>> 0
  }
  return `${model}:${s.length}:${h1.toString(16)}${h2.toString(16)}`
}

function toolsConfig(tools: ToolDecl[]): unknown[] {
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: t.parametersJsonSchema,
      })),
    },
  ]
}

/**
 * The live cache handle for this prefix, creating one only when the traffic justifies it.
 * Never throws: a cache is an optimisation, and the call it was meant to make is more
 * important than the saving.
 */
async function cachedContentFor(
  model: string,
  system: string,
  tools: ToolDecl[] | undefined,
): Promise<string | null> {
  if (!tools?.length || system.length < CACHE_MIN_CHARS) return null

  const key = cacheKey(model, system, tools)
  const at = Date.now()
  const live = cacheByKey.get(key)
  if (live && live.expiresAtMs > at + 5000) return live.name

  const lastSeen = lastSeenByKey.get(key) ?? 0
  lastSeenByKey.set(key, at)
  if (at < cacheDisabledUntilMs) return null
  // Rule 2: a cold first call primes nothing. `lastSeen === 0` is the first call this
  // process has made with this prefix at all.
  if (at - lastSeen > CACHE_BURST_WINDOW_MS) return null

  try {
    const created = await getClient().caches.create({
      model,
      config: {
        systemInstruction: system,
        tools: toolsConfig(tools) as any,
        ttl: `${CACHE_TTL_SECONDS}s`,
        displayName: 'class-manager-stable-prefix',
      },
    })
    const name = created?.name
    if (!name) return null
    cacheByKey.set(key, { name, expiresAtMs: at + CACHE_TTL_SECONDS * 1000 })
    return name
  } catch (err) {
    // Explicit caching is not available everywhere, and a project without the permission
    // would otherwise pay this failure on every single turn.
    cacheDisabledUntilMs = at + CACHE_COOLDOWN_MS
    console.error(
      `[gemini] prompt cache unavailable, falling back to an inline prefix: ${
        (err as Error)?.message ?? String(err)
      }`,
    )
    return null
  }
}

/** A cache that expired or was deleted under us. The retry must go inline, not fail. */
function isStaleCacheError(err: unknown): boolean {
  const msg = (err as { message?: unknown })?.message
  const text = typeof msg === 'string' ? msg : String(err)
  return /cachedcontent|cached_content|NOT_FOUND|was not found|PERMISSION_DENIED/i.test(text)
}

function forgetCache(name: string): void {
  for (const [key, entry] of cacheByKey) {
    if (entry.name === name) cacheByKey.delete(key)
  }
}

// -----------------------------------------------------------------------------
// generate
// -----------------------------------------------------------------------------

/** Ceiling on thinking for a structured-output call, so the JSON still fits. */
const THINKING_BUDGET_STRUCTURED = 2048
/**
 * **Thinking is off on the tool path, and it was measured, not guessed.**
 *
 * This was 4096 on the theory that a turn composing a real plan needs room to
 * deliberate. `scripts/probe-model.ts` put that theory against the live prompt and the
 * live tool surface, one variable changed at a time, eight runs per condition, on the
 * exact turn FINDINGS says goes wrong — two classes and two families in one sentence:
 *
 *   gemini-2.5-flash · thinking 0      8/8 reached for a tool ·  3.5s ·   575 output tokens
 *   gemini-2.5-flash · thinking 4096   6/8                     · 16.9s ·  3606 output tokens
 *   gemini-3-flash   · thinking 0      8/8                     ·  7.0s ·   912 output tokens
 *   gemini-3-flash   · thinking 4096   7/8                     · 42.9s ·  7136 output tokens
 *
 * Nearly five times the latency and six times the output tokens, to be *less* likely to
 * do the thing. Across a wider sweep the 4096 arm also produced every
 * MALFORMED_FUNCTION_CALL observed (2 in 20 on 2.5-flash, zero at 0) — which is
 * FINDINGS' biggest remaining risk, and it turns out to be a constant in this file
 * rather than a property of the model. It is also most of the "20-40s typical, 40-60s
 * when composing several writes" that §11's latency item is about.
 *
 * The reason it hurts rather than helps: the thinking and the function call are drawn
 * from one stream, and a long deliberation before a deeply-nested call is exactly the
 * shape the decoder gets wrong. The model does not need to reason its way to a plan; the
 * plan's shape is in the prompt and its arguments come from the person's own sentence.
 *
 * `MAX_OUTPUT_TOOLS` stays large — that is the ceiling on the call itself, and a plan
 * carrying four families is a big string.
 */
const THINKING_BUDGET_TOOLS = 0
const MAX_OUTPUT_TOOLS = 16384

/**
 * **What zero thinking bought, and what it cost.**
 *
 * The measurement above is sound and stands: on the tool path, deliberation makes the
 * model *less* likely to act and produces every malformed call. But look at which
 * decisions survived it. `read`, `reply` and `act` are first-order — the person asked
 * a question, you answer it — and those are reliably reached. The tools that need a
 * *second* judgement on top of answering are `schedule` ("is this worth watching?"),
 * `remember` ("is this worth keeping?") and `view` ("does this deserve a page?"), and
 * across 93 driven turns those were called 0, 3 and 1 times respectively.
 *
 * C29 and that silence are the same fact recorded twice. A model with no deliberation
 * budget does the obvious thing, and every one of those is a non-obvious thing.
 *
 * So the budget stops being a constant. It is zero for the composition-shaped turns
 * C29 measured — where a long deliberation before a deeply-nested call is exactly the
 * shape the decoder gets wrong — and non-zero where the turn is a judgement call and
 * the tool schemas involved are flat. `TURN_THINKING` names the tiers; `loop.ts`
 * chooses one per turn. Keep the choice measurable: `scripts/probe-model.ts` varies
 * exactly this, and the question to put to it is not "does it call a tool" but "does
 * it call the discretionary one".
 */
export const TURN_THINKING = {
  /** Composing a plan, parsing media into rows: C29's measured arm. */
  compose: 0,
  /** Guiding somebody through something — sequencing, not composing (§7.1, onboarding). */
  guide: 1024,
  /** A judgement with flat schemas and no plan to build (the §5 reflection pass). */
  judge: 512,
} as const

/* -----------------------------------------------------------------------------
 * Gemini 3 takes two of these settings differently, and gets worse if given them
 * the 2.5 way.
 *
 *   1. **Thinking.** `thinkingBudget` is the legacy parameter. Gemini 3 takes
 *      `thinkingLevel` (minimal | low | medium | high), and Google's migration
 *      note is explicit that **you cannot send both in the same request**. The
 *      tiers above stay numeric because that is what C29 and C50 measured and
 *      what `loop.ts` reasons about; this translates at the boundary.
 *
 *   2. **Temperature.** Google's Gemini 3 guidance is to keep the default of 1.0
 *      and warns that lowering it "may lead to unexpected behavior" — which is
 *      the opposite of the 0.4 this product has always sent, chosen when 2.5 was
 *      the only model. So on a Gemini 3 model, temperature is not sent at all
 *      and the model's own default stands. Callers keep passing what they pass;
 *      it simply stops applying where it is known to hurt.
 *
 * Both are keyed off the model name rather than a flag, because the whole point
 * is that one process may call 2.5 and 3 in the same turn (MODEL_SYNTH is still
 * a 2.5 model) and each must get what it wants.
 * -------------------------------------------------------------------------- */

function isGemini3(model: string): boolean {
  return /^gemini-(?:[3-9]|\d{2,})/.test(model)
}

/**
 * The numeric tier, as the level Gemini 3 names — **one step below the naive
 * mapping at every tier, and that is the whole point.**
 *
 * The first version of this read `0 → low, ≤1024 → medium, else high`, which is
 * what you get by lining the two scales up by eye. Measured on the real arc, that
 * mapping cost more than everything else in this file put together:
 *
 *                       output tokens   avg latency   truth   compose-big
 *   thinkingBudget       2,757            16.6s       12/16      7/10
 *   naive levels        15,408            38.4s        5/16      0/10
 *
 * 5.6× the output tokens, twice the latency and cost, and the one turn that
 * composes several writes went to zero. `guide` is 1024 tokens; Gemini 3's
 * `medium` is evidently far more than that.
 *
 * It is also C29 reproducing on a newer model. That measurement — deliberation
 * before a deeply-nested call is the shape the decoder gets wrong — put the 4096
 * arm at 3,606-7,136 output tokens and *less* likely to act, and the naive
 * mapping landed at 7,238 and 0/10. The finding held; only the parameter name
 * changed. So the levels hug the measurement rather than the migration guide.
 */
function thinkingLevelFor(budget: number): 'minimal' | 'low' | 'medium' {
  if (budget <= 0) return 'minimal'
  if (budget <= 2048) return 'low'
  return 'medium'
}

/** Put thinking on a config the way this particular model wants to receive it. */
function applyThinking(config: Record<string, unknown>, model: string, budget: number): void {
  if (isGemini3(model)) config.thinkingConfig = { thinkingLevel: thinkingLevelFor(budget) }
  else config.thinkingConfig = { thinkingBudget: budget }
}

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
  /**
   * Override the thinking allowance for this call. Exists because "how much thinking
   * does a clean function call need?" is a question whose answer changes with the model
   * and can only be settled by measurement — `scripts/probe-model.ts` varies exactly
   * this, three runs per condition. Omitted, the constants below decide.
   */
  thinkingBudget?: number
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
    maxOutputTokens: o.maxOutputTokens ?? 8192,
  }
  // Omitted entirely on Gemini 3 — see `isGemini3` above. Sending nothing is the
  // documented way to get the 1.0 default; sending 1.0 explicitly would work too
  // but would drift the moment the default moves.
  if (!isGemini3(model)) config.temperature = o.temperature ?? 0.4
  if (o.tools && o.tools.length > 0) {
    // Function declarations and a forced response schema are mutually exclusive
    // on Vertex; tools win, because a tool round is how the turn makes progress.
    config.tools = toolsConfig(o.tools)

    // The same budget arithmetic the structured path below already spells out,
    // applied to the path every conversation actually takes, which had no bound
    // at all. Thinking comes out of `maxOutputTokens`: unbounded thinking on an
    // 8k allowance is a turn that can spend the whole budget deliberating and
    // return MAX_TOKENS with nothing said.
    //
    // Honest about what this does not fix: it was tried against a reproducible
    // MALFORMED_FUNCTION_CALL and made no difference at all (that one was the
    // tool-declaration ceiling — see `toolDecls`). It stays because the ceiling
    // it does bound is real and was unbounded.
    applyThinking(config, model, o.thinkingBudget ?? THINKING_BUDGET_TOOLS)
    config.maxOutputTokens = o.maxOutputTokens ?? MAX_OUTPUT_TOOLS
  } else if (o.responseJsonSchema) {
    config.responseMimeType = 'application/json'
    config.responseJsonSchema = o.responseJsonSchema
    // Thinking tokens are drawn from the SAME budget as the answer. A judge or a
    // digest reasoning its way through a long transcript can spend the entire
    // allowance before emitting a single byte of JSON, and what comes back is an
    // empty candidate that looks exactly like a parse failure. Bounding the
    // thinking leaves room for the structured answer the caller is waiting on.
    applyThinking(config, model, THINKING_BUDGET_STRUCTURED)
    config.maxOutputTokens = o.maxOutputTokens ?? 16384
  }

  // §4.4 — when a cache is live for this prefix, the prefix travels by reference. The
  // systemInstruction and tools then live IN the cache and must not also be sent: Vertex
  // rejects a request that supplies both.
  const cachedContent = await cachedContentFor(model, o.system, o.tools)
  if (cachedContent) {
    delete config.systemInstruction
    delete config.tools
    config.cachedContent = cachedContent
  }

  const request = { model, contents: o.contents as any, config: config as any }
  const started = performance.now()

  let res: GenerateContentResponse
  try {
    res = await getClient().models.generateContent(request)
  } catch (err) {
    // A cache deleted or expired between the check and the call is not the caller's
    // problem: drop the handle, put the prefix back inline, and make the call.
    if (cachedContent && isStaleCacheError(err)) {
      forgetCache(cachedContent)
      const inline: Record<string, unknown> = { ...config }
      delete inline.cachedContent
      inline.systemInstruction = o.system
      if (o.tools?.length) inline.tools = toolsConfig(o.tools)
      res = await getClient()
        .models.generateContent({ model, contents: o.contents as any, config: inline as any })
        .catch((err2: unknown) =>
          fail(
            'model_call_failed',
            `Vertex call failed after dropping a stale prompt cache: ${
              (err2 as Error)?.message ?? String(err2)
            }`,
          ),
        )
      return shape(res, model, Math.round(performance.now() - started))
    }
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

  return shape(res, model, Math.round(performance.now() - started))
}

/** The response, as the rest of the product wants it. Shared by every call path above. */
function shape(res: GenerateContentResponse, fallbackModel: string, ms: number): GenResult {
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
    model: res.modelVersion ?? fallbackModel,
    ms,
    finishReason: candidate?.finishReason ? String(candidate.finishReason) : null,
  }
}

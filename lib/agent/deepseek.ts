/**
 * lib/agent/deepseek.ts — the model client. CONTRACTS §6.
 *
 * DeepSeek's OpenAI-dialect API over raw `fetch`. No SDK: the wire format is
 * four fields wide and an SDK would only hide which of them we send.
 *
 * **Text only.** This API has no image, audio or document input — a non-text
 * content part is rejected at schema validation before auth is even checked.
 * §14.5 ("audio arrives as audio") is repealed, not worked around: media still
 * ARRIVES, and the inbound path answers it in words rather than feeding it to a
 * model that cannot read it (`loop.ts`, `MEDIA_REFUSAL`).
 *
 * The reference for everything here — wire format, thinking, caching, errors —
 * is `lib/agent/deepseek-api.md`, which is the durable half of the migration
 * notes. The model itself never learns its provider: nothing in the prefix says
 * "DeepSeek".
 *
 * This module records NOTHING to the database. loop.ts owns the `turn` row.
 */
import { env } from '@/lib/env'
import { withSession } from '@/lib/db'
import { AppError } from '@/lib/errors'

/* -------------------------------------------------------------------------- *
 * The wire's message shapes, which are now also the loop's history shapes.
 *
 * Gemini's `{role, parts[]}` is gone. A tool result is no longer a part inside a
 * user turn; it is its own message carrying the id of the call it answers, and
 * matching is BY ID, not by position — which is the one thing about this format
 * the loop had to learn.
 * -------------------------------------------------------------------------- */

export type RawToolCall = {
  id: string
  type: 'function'
  /** `arguments` is a JSON *string* on this wire, both ways. */
  function: { name: string; arguments: string }
}

export type Msg =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant'
      content?: string | null
      /**
       * The separate reasoning channel. Echoed back verbatim with the message it
       * came on: with tools in play, dropping it from history is a 400. This is
       * the thought-signature discipline of the Gemini client under a new name.
       */
      reasoning_content?: string | null
      tool_calls?: RawToolCall[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

/** Unchanged from the Gemini client on purpose — `tools.ts` declares tools once. */
export type ToolDecl = { name: string; description: string; parametersJsonSchema: object }

export type ModelCall = {
  /** The id the matching `{role:'tool'}` message must carry. */
  id: string
  name: string
  args: Record<string, unknown>
  /**
   * Set when `arguments` did not parse. This is the whole of what used to arrive
   * as `MALFORMED_FUNCTION_CALL` with nothing attached: the raw string is the
   * only evidence of which call was being attempted, so it is carried rather
   * than discarded, and the loop answers the call with the parse error instead
   * of pretending it never happened.
   */
  raw?: string
  parseError?: string
}

export type GenResult = {
  text: string
  functionCalls: ModelCall[]
  /**
   * The assistant message exactly as it arrived. Callers push this straight back
   * into history — `reasoning_content` and `tool_calls` included — before adding
   * the `tool` messages that answer it.
   */
  assistant: Msg & { role: 'assistant' }
  usage: { promptTokens: number; outputTokens: number; cachedTokens: number }
  model: string
  ms: number
  /**
   * Why generation stopped. Discarding this made every empty response look
   * alike: `length` (the turn was too big), `content_filter` (it was blocked)
   * and "simply done" all arrived as an empty string, and the turn row recorded
   * none of them. `insufficient_system_resource` is the newest member of that
   * class and the most dangerous one — see `INCOMPLETE` below.
   */
  finishReason: string | null
}

function fail(code: string, message: string): never {
  throw new AppError({ code, message })
}

/* -------------------------------------------------------------------------- *
 * §17 failure injection — sim_fault kind 'model_error'. Carried over verbatim.
 * -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- *
 * Caching — automatic, and therefore absent from this file.
 *
 * The Gemini client carried ~140 lines of explicit-cache machinery: handles, a
 * TTL, a burst heuristic, a cooldown, a stale-handle retry path. All of it
 * existed because Gemini's implicit cache measurably never bit — turns logged 0
 * cached tokens across the board — and its explicit cache was billed per hour of
 * storage, so caching had to be *decided* rather than simply had.
 *
 * Here the server keeps the KV cache of recent requests on disk and reuses it for
 * any request whose token sequence starts with a byte-identical prefix. No
 * handle, no TTL, no storage fee, nothing to decide. A cache-hit token costs 3.2%
 * of a miss.
 *
 * So the §4.4 discipline is the ONLY thing that still matters, and it now pays:
 * the stable prefix stays byte-stable and academy-independent, everything
 * variable stays after it. A changed tool description invalidates the prefix —
 * one miss-priced call, not a failure. `usage` reports what happened; there is
 * nothing to configure and nothing to fix up afterwards.
 *
 * One rule survives as a prohibition: **never send `user_id`**. It buys per-user
 * KVCache isolation, which would partition the shared prefix per academy and
 * destroy exactly the cross-tenant hits the academy-independent prefix exists to
 * earn.
 * -------------------------------------------------------------------------- */

const BASE_URL = 'https://api.deepseek.com'

/* -------------------------------------------------------------------------- *
 * Thinking
 * -------------------------------------------------------------------------- */

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
 * MALFORMED_FUNCTION_CALL observed (2 in 20 on 2.5-flash, zero at 0).
 *
 * The reason it hurt rather than helped: on Gemini the thinking and the function call
 * were drawn from ONE stream, and a long deliberation before a deeply-nested call is
 * exactly the shape the decoder gets wrong.
 *
 * **That premise may not hold here, and that is the interesting part of this
 * migration.** DeepSeek reasons in a separate channel (`reasoning_content`), so
 * deliberation cannot corrupt the call the way it demonstrably did on Gemini. The
 * default stays at C29's measured zero — porting a finding by deleting it is how a
 * migration loses two years of measurement — but the arc in `deepseek-migration.md`
 * phase 6 exists to overturn it, and it is the one arm most likely to.
 */
const THINKING_BUDGET_TOOLS = 0
const MAX_OUTPUT_TOOLS = 16384

/**
 * **What zero thinking bought, and what it cost.**
 *
 * The measurement above is sound and stands: on Gemini's tool path, deliberation made
 * the model *less* likely to act and produced every malformed call. But look at which
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
 * C29 measured, and non-zero where the turn is a judgement call and the tool schemas
 * involved are flat. `TURN_THINKING` names the tiers; `loop.ts` chooses one per turn.
 * The tiers stay NUMERIC even though this provider has no numeric budget, because the
 * numbers are what C29 and C50 measured and what the loop reasons about; `thinkingFor`
 * translates at the boundary, exactly as `applyThinking` did for Gemini 3.
 */
export const TURN_THINKING = {
  /** Composing a plan, parsing a request into rows: C29's measured arm. */
  compose: 0,
  /** Guiding somebody through something — sequencing, not composing (§7.1, onboarding). */
  guide: 1024,
  /** A judgement with flat schemas and no plan to build (the §5 reflection pass). */
  judge: 512,
} as const

type Thinking = { thinking: { type: 'disabled' } } | { thinking: { type: 'enabled' }; reasoning_effort: 'low' | 'high' }

/**
 * A numeric tier as this provider's two knobs.
 *
 * **Thinking is ENABLED BY DEFAULT here, at `high` effort.** A port that forgets
 * to send anything runs C29's measured bad arm on every single turn, which is
 * the most expensive way this migration could go quietly wrong — so `disabled`
 * is sent explicitly and the default is never relied on.
 *
 * The ladder is `disabled` / `low` / `high` / `max`: `medium` and `high` both
 * resolve to the same actual effort, so a three-way mapping would be a lie in the
 * middle. `guide` and `judge` both land on `low` deliberately — 512 and 1024 were
 * always "a little, not a lot", and inventing a distinction the provider does not
 * have would be reading precision into two numbers that never carried it.
 *
 * Provisional, and phase 6 of `deepseek-migration.md` is what settles it. The
 * Gemini history here is the warning: the naive level mapping cost 5.6× the output
 * tokens and took `compose-big` follow-through to zero, and only measurement
 * caught it.
 */
/**
 * The probe's pin, and the only reason this file reads `process.env` directly.
 *
 * `scripts/probe-model.ts --thinking off,low,high` spawns one child per arm with
 * this set, exactly as it already spawns one child per model with `MODEL_MAIN`
 * set — because the alternative is threading a sweep parameter through `runTurn`,
 * where it would live forever as a production code path that only a probe ever
 * takes. It is absent in production, and `lib/env.ts` does not know it exists:
 * pinning a tier is an instrument, not a setting.
 */
function pinnedTier(): Thinking | null {
  switch ((process.env.PROBE_THINKING ?? '').trim().toLowerCase()) {
    case 'off':
    case 'disabled':
      return { thinking: { type: 'disabled' } }
    case 'low':
      return { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
    case 'high':
      return { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
    default:
      return null
  }
}

function thinkingFor(budget: number): Thinking {
  const pinned = pinnedTier()
  if (pinned) return pinned
  if (budget <= 0) return { thinking: { type: 'disabled' } }
  if (budget <= 2048) return { thinking: { type: 'enabled' }, reasoning_effort: 'low' }
  return { thinking: { type: 'enabled' }, reasoning_effort: 'high' }
}

/* -------------------------------------------------------------------------- *
 * Errors, retries, timeout
 * -------------------------------------------------------------------------- */

const RETRY_DELAY_MS = 1500
/**
 * The server holds a connection open — emitting keep-alive blank lines into the
 * JSON, which parse fine — for up to ten minutes before inference begins. No turn
 * on a chat channel is worth ten minutes of somebody staring at a screen, so the
 * client picks its own ceiling well below the platform's.
 */
const REQUEST_TIMEOUT_MS = 120_000

/** Retried once, 1.5s apart. Everything else is a fact, and retrying a fact is latency. */
const RETRYABLE = new Set([429, 500, 503])

/**
 * `insufficient_system_resource` means load was shed MID-GENERATION and what came
 * back is incomplete. It is the one finish reason that must never be mistaken for
 * a clean stop: the text reads as an answer and simply stops in the middle of one.
 * Retried once like a 503, because that is what it is; if the retry is incomplete
 * too, the reason is carried into the trace rather than smoothed over.
 */
const INCOMPLETE = 'insufficient_system_resource'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

type ChatResponse = {
  choices?: {
    message?: { content?: string | null; reasoning_content?: string | null; tool_calls?: RawToolCall[] }
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_cache_hit_tokens?: number
    prompt_cache_miss_tokens?: number
  }
  model?: string
}

/** One HTTP call. Throws `{ status, body }` shaped errors so the retry can read them. */
async function post(body: unknown): Promise<ChatResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw Object.assign(new Error(`no response in ${REQUEST_TIMEOUT_MS / 1000}s`), { status: 408 })
    }
    throw err
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw Object.assign(new Error(text.slice(0, 1000) || res.statusText), { status: res.status })
  }
  return (await res.json()) as ChatResponse
}

/** What an HTTP status means to us, and what we are allowed to do about it. */
function failStatus(status: number, message: string): never {
  if (status === 402) {
    // Retrying this burns latency on a fact. The account is empty; nothing about
    // waiting 1.5s changes that, and the message needs to say the actual cause
    // rather than "the model call failed" for the third time in a row.
    fail('model_out_of_balance', `DeepSeek refused the call: the account is out of balance. ${message}`)
  }
  if (status === 401) fail('model_unauthorized', `DEEPSEEK_API_KEY was rejected. ${message}`)
  if (status === 400 || status === 422) fail('model_bad_request', `DeepSeek rejected the request: ${message}`)
  fail('model_call_failed', `DeepSeek call failed (${status}): ${message}`)
}

/* -------------------------------------------------------------------------- *
 * generate
 * -------------------------------------------------------------------------- */

export async function generate(o: {
  system: string
  messages: Msg[]
  tools?: ToolDecl[]
  model?: string
  temperature?: number
  maxOutputTokens?: number
  /**
   * Ask for JSON. There is no constrained decoding on this API outside beta, so
   * this is `response_format: json_object` — the model is *told* to emit JSON and
   * usually does. The caller validates and retries; `generateJson` below is that
   * loop, and every structured call site goes through it rather than reinventing
   * the retry.
   *
   * The literal word "json" must appear in the prompt or the request is rejected.
   */
  json?: boolean
  /**
   * Override the thinking allowance for this call. Exists because "how much thinking
   * does a clean function call need?" is a question whose answer changes with the model
   * and can only be settled by measurement — `scripts/probe-model.ts` varies exactly
   * this. Omitted, the constants above decide.
   */
  thinkingBudget?: number
}): Promise<GenResult> {
  if (!o.messages || o.messages.length === 0) {
    fail('model_bad_request', 'generate() called with no messages')
  }
  if (Math.random() < (await modelFaultRate())) {
    fail('model_error', 'injected sim_fault: model_error')
  }

  const model = o.model ?? env.MODEL_MAIN
  const hasTools = Boolean(o.tools?.length)
  const budget = o.thinkingBudget ?? (hasTools ? THINKING_BUDGET_TOOLS : o.json ? THINKING_BUDGET_STRUCTURED : 0)
  const thinking = thinkingFor(budget)

  const body: Record<string, unknown> = {
    model,
    // The system prompt is the §4.4 stable prefix and it is the first message on
    // purpose: the automatic cache matches on a byte-identical *prefix*, so
    // anything variable placed above it would invalidate the whole thing.
    messages: [{ role: 'system', content: o.system }, ...o.messages],
    // Reasoning is drawn from this same allowance, so a structured answer needs
    // room for both — a digest that spends its budget deliberating and returns
    // truncated JSON is indistinguishable from a parse failure, which is the
    // failure this ceiling exists to prevent.
    max_tokens: o.maxOutputTokens ?? (hasTools ? MAX_OUTPUT_TOOLS : o.json ? 16384 : 8192),
    ...thinking,
  }

  // Silently ignored in thinking mode — no error, no effect — so sending it there
  // would be a value in the request that reads as if it were doing something. The
  // same discipline as omitting temperature on Gemini 3, for the same reason.
  // Read off the resolved setting, not the numeric tier: a pinned probe arm can
  // turn thinking on for a call whose budget says zero, and temperature must
  // follow what was actually sent.
  if (thinking.thinking.type === 'disabled' && o.temperature !== undefined) body.temperature = o.temperature

  if (hasTools) {
    body.tools = o.tools!.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parametersJsonSchema },
    }))
  }
  if (o.json) body.response_format = { type: 'json_object' }

  const started = performance.now()
  let res: ChatResponse
  try {
    res = await post(body)
  } catch (err) {
    const status = Number((err as { status?: unknown })?.status ?? 0)
    const message = (err as Error)?.message ?? String(err)
    if (!RETRYABLE.has(status)) failStatus(status, message)
    await sleep(RETRY_DELAY_MS)
    res = await post(body).catch((err2: unknown) =>
      failStatus(
        Number((err2 as { status?: unknown })?.status ?? 0),
        `twice: ${(err2 as Error)?.message ?? String(err2)}`,
      ),
    )
  }

  // Load shed mid-generation is a transient server condition wearing a
  // finish_reason. One retry, then whatever comes back is reported honestly.
  if (res.choices?.[0]?.finish_reason === INCOMPLETE) {
    await sleep(RETRY_DELAY_MS)
    res = await post(body).catch(() => res)
  }

  return shape(res, model, Math.round(performance.now() - started))
}

/** The response, as the rest of the product wants it. */
function shape(res: ChatResponse, fallbackModel: string, ms: number): GenResult {
  const choice = res.choices?.[0]
  const message = choice?.message ?? {}

  // Echoed back into history verbatim, `reasoning_content` included: with tools in
  // play, dropping it is a 400. Only the keys that were actually present are
  // carried — an explicit `reasoning_content: null` on a message that never had
  // one is a difference in the bytes the cache matches on.
  const assistant: Msg & { role: 'assistant' } = { role: 'assistant', content: message.content ?? '' }
  if (message.reasoning_content) assistant.reasoning_content = message.reasoning_content
  if (message.tool_calls?.length) assistant.tool_calls = message.tool_calls

  const functionCalls: ModelCall[] = (message.tool_calls ?? [])
    .filter((c) => c?.function?.name)
    .map((c) => {
      const raw = c.function.arguments ?? ''
      try {
        const parsed = raw.trim() ? JSON.parse(raw) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { id: c.id, name: c.function.name, args: {}, raw, parseError: 'arguments were not a JSON object' }
        }
        return { id: c.id, name: c.function.name, args: parsed as Record<string, unknown> }
      } catch (e) {
        // The malformed-call case, and the raw string travels with it: it is the
        // only evidence of what the model was reaching for.
        return { id: c.id, name: c.function.name, args: {}, raw, parseError: (e as Error).message }
      }
    })

  const u = res.usage
  return {
    text: message.content ?? '',
    functionCalls,
    assistant,
    usage: {
      promptTokens: u?.prompt_tokens ?? 0,
      // Reasoning is billed as output and IS output — counting it separately
      // would make the most expensive tokens we buy the only invisible ones.
      outputTokens: u?.completion_tokens ?? 0,
      // A subset of promptTokens, not an addition to it.
      cachedTokens: u?.prompt_cache_hit_tokens ?? 0,
    },
    model: res.model ?? fallbackModel,
    ms,
    finishReason: choice?.finish_reason ? String(choice.finish_reason) : null,
  }
}

/* -------------------------------------------------------------------------- *
 * Structured output — validate and retry, because there is nothing to constrain
 * with.
 * -------------------------------------------------------------------------- */

/**
 * A JSON answer, validated, with exactly one retry.
 *
 * Gemini took a `responseJsonSchema` and the decoder could not produce anything
 * else. This API has no stable equivalent — `json_object` mode asks for JSON and
 * DeepSeek's own docs admit it occasionally returns **empty content** — so the
 * schema moves into the prompt and the guarantee moves here.
 *
 * One retry, not three: both call sites are `MODEL_SYNTH` batch paths where a
 * retry costs nothing anybody is waiting on, and a second failure is evidence
 * about the prompt rather than luck to be spent more of. `null` on failure, so
 * the caller decides what a missing answer means — a digest that cannot be
 * written is silence, and a hot set that cannot be curated keeps the old one.
 */
export async function generateJson<T>(
  o: Parameters<typeof generate>[0] & { validate: (v: unknown) => T | null },
): Promise<{ value: T | null; usage: GenResult['usage']; model: string; ms: number; attempts: number; error?: string }> {
  let usage = { promptTokens: 0, outputTokens: 0, cachedTokens: 0 }
  let model = o.model ?? env.MODEL_MAIN
  let ms = 0
  let error: string | undefined

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await generate({ ...o, json: true })
    usage = {
      promptTokens: usage.promptTokens + res.usage.promptTokens,
      outputTokens: usage.outputTokens + res.usage.outputTokens,
      cachedTokens: usage.cachedTokens + res.usage.cachedTokens,
    }
    model = res.model
    ms += res.ms

    const text = res.text.trim()
    if (!text) {
      error = `empty content (finish: ${res.finishReason ?? 'unknown'})`
      continue
    }
    try {
      // A fenced block is not JSON, but it is JSON with a wrapper the model added
      // — and refusing to unwrap it would spend a whole retry on punctuation.
      const stripped = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
      const value = o.validate(JSON.parse(stripped))
      if (value !== null) return { value, usage, model, ms, attempts: attempt }
      error = 'the JSON parsed but did not match the shape asked for'
    } catch (e) {
      error = `did not parse as JSON: ${(e as Error).message}`
    }
  }

  return { value: null, usage, model, ms, attempts: 2, error }
}

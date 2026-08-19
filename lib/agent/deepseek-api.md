# DeepSeek's API — what the code needs to know

The durable reference for the model client. Everything here is from DeepSeek's
own docs (api-docs.deepseek.com) as of 2026-08-15, and the claims marked
**verified** were tested live against our key rather than read. The model
itself never needs to know its provider — nothing in the prefix should ever
say "DeepSeek".

## Models

Two, and only two — **verified** via `GET /models`:

| id | role here | context | max output | concurrency |
|---|---|---|---|---|
| `deepseek-v4-flash` | `MODEL_MAIN` | 1M | 384K | 2,500 |
| `deepseek-v4-pro` | candidate for judge tier / `MODEL_SYNTH` | 1M | 384K | 500 |

Every blog post naming `deepseek-chat` or `deepseek-reasoner` is a previous
generation and wrong.

## Endpoints and auth

- Base: `https://api.deepseek.com` — **OpenAI dialect**, the one we use.
- `https://api.deepseek.com/beta` — same, plus beta features (`strict` tools).
- `https://api.deepseek.com/anthropic` — Anthropic dialect. Not used.
- Auth: `Authorization: Bearer <DEEPSEEK_API_KEY>`. Key lives in `.env` only.
- `POST /chat/completions`, `GET /models`, `GET /user/balance`.

**Text only** — **verified**: a content part of `{"type":"image_url"}` is
rejected at schema validation (`unknown variant image_url, expected text`)
before auth or balance are even checked. No image, no audio, no documents, no
transcription endpoint. This is why §14.5 was repealed.

## The request

```jsonc
{
  "model": "deepseek-v4-flash",
  "messages": [
    { "role": "system", "content": "<stable prefix>" },
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "...", "reasoning_content": "...",
      "tool_calls": [ /* echoed verbatim from the response */ ] },
    { "role": "tool", "tool_call_id": "call_abc", "content": "<result as string>" }
  ],
  "tools": [
    { "type": "function", "function": {
        "name": "act",
        "description": "…",
        "parameters": { /* standard JSON Schema object */ }
    } }
  ],
  "thinking": { "type": "disabled" },        // see Thinking — default is ENABLED
  "max_tokens": 16384
}
```

Roles: `system` / `user` / `assistant` / `tool`. Up to **128 tools** (same
number `MAX_TOOL_DECLS` already guards). `stop` up to 16 sequences.
`frequency_penalty` / `presence_penalty` are deprecated — never send them.

## Function calling — the contract

1. Model wants tools → response `message.tool_calls` is an array of
   `{ id, type:"function", function:{ name, arguments } }` and
   `finish_reason` is `"tool_calls"`.
2. **`arguments` is a JSON *string*, not an object.** `JSON.parse` it. A
   parse failure is our malformed-call case: keep the raw string in the turn
   trace — it is the only evidence of which call was being attempted.
3. Results go back as one `{ role:"tool", tool_call_id, content }` message
   **per call**, `content` a string. The `tool_call_id` must match — matching
   is by id, not position.
4. The assistant message that carried the calls is echoed back into history
   **verbatim** first — `reasoning_content` included. The docs claim dropping
   `reasoning_content` from a tool-calling history is a **400**; measured live
   (phase 6), omission returned **200** and composed fine. The echo is kept
   anyway — it is free, and the documented behaviour may return.
5. One round may carry **several** tool calls — always iterate the array.
6. `tool_choice`: `auto` / `none` documented. Named forcing
   (`{"type":"function","function":{"name":…}}`) **works, verified live** —
   the forced call was produced. This is what unblocks a strict-mode upgrade.

## Thinking

- **Enabled by default, at `high` effort.** A call that forgets to send the
  field runs the most expensive level on every turn. `disabled` is sent
  explicitly wherever thinking is off.
- `reasoning_effort`: `low` | `medium` | `high` | `xhigh` | `max` — but
  `medium` and `high` both resolve to actual `high`, so the usable ladder is
  `disabled` / `low` / `high` / `max`. The product ships at `low` on the
  whole model path (`deepseek.ts`), settled by the phase-6 arc.
- Reasoning arrives in `reasoning_content`, separate from `content`, and is
  **billed as output tokens** (`completion_tokens_details.reasoning_tokens`)
  — the most expensive tokens we buy. It is also loggable: the trace can
  finally record *why* a turn did something, not just what.
- In thinking mode `temperature` and `top_p` are **silently ignored** — no
  error, no effect. Don't send them on thinking calls.

## Caching — automatic, no API surface

The server keeps the KV cache of recent requests on disk and reuses it for
any request whose token sequence starts with a byte-identical prefix. No
handles, no TTL to manage, no storage fee, no explicit-cache machinery.

- Billing: a cache-hit token costs **3.2%** of a miss. Measured live: 91–98%
  hit across every phase-6 arm, cross-request from the second call.
- Read it from `usage`: `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`.
- Best-effort, exact-prefix, evicted after hours-to-days idle. Two identical
  turns can legitimately bill differently; record the fields, don't fight it.
- What the design must keep doing: the §4.4 stable prefix stays byte-stable
  and academy-independent; everything variable (clock line, tenant facts,
  media-less tail) stays *after* it. A changed tool description invalidates
  the prefix — one miss-priced call, not a failure.
- **The tool block caches with the prefix, and sits above the messages.** A call
  sending a different tool list matches only to the end of the system prompt and
  re-bills everything behind it — its own declarations and the whole conversation.
  Measured: a round declaring 2 of 24 tools cached exactly 17,024 tokens on 57 of
  57 calls, where every other round of the same turns cached 22,656 and up. Send
  the same declarations on every call of a turn; constrain a round at the
  dispatcher that runs its calls, not by narrowing what it is shown.
- **Never set `user_id` per academy.** `user_id` buys per-user KVCache
  isolation, which would partition the shared prefix per tenant and destroy
  the cross-tenant cache hits the academy-independent prefix exists to earn.
  Omit it, or use one constant.

## Structured output

- `response_format: {"type": "json_object"}` only — no `json_schema` outside
  beta. Requirements: the literal word "json" in system or user prompt, an
  example of the shape, `max_tokens` high enough that the JSON isn't cut.
- Known bug, documented by DeepSeek themselves: JSON mode occasionally
  returns **empty content**. Callers validate (zod) and retry once.
- **Strict mode (beta):** base `/beta`, `"strict": true` per function —
  actual constrained decoding. Costs: every property must be in `required`,
  `additionalProperties: false` everywhere, no `minLength`/`maxLength`/
  `minItems`/`maxItems`. Supports `anyOf` — which would let `plan`'s five-way
  step union become a real declared schema instead of a JSON string.
  Verified accepted live on `/beta`; the upgrade is open work.

## Errors, finish reasons, retry policy

| HTTP | meaning | policy |
|---|---|---|
| 400 | bad request | fix, never retry |
| 401 | bad key | fail loudly |
| **402** | **out of balance** | **fail loudly with its own code — never retry** (**verified**: this is what an empty account returns) |
| 422 | invalid params | fix, never retry |
| 429 | too fast / concurrency cap | retry once, 1.5s |
| 500 | server error | retry once, 1.5s |
| 503 | overloaded | retry once, 1.5s |

`finish_reason`: `stop`, `length`, `content_filter`, `tool_calls`, and
**`insufficient_system_resource`** — load was shed mid-generation and the
response is **incomplete**. It must never be treated as a clean stop; it is
the new entry in the class `finishReason` exists to keep distinguishable
("every empty response looked alike").

Connection behavior: while the server queues, non-streaming responses emit
blank lines as keep-alive (JSON whitespace — `JSON.parse` is unaffected);
connections close if inference hasn't started in 10 minutes. The client sets
its own timeout well below that.

## Pricing (from 2026-08-16 16:00 UTC), ₹ at 88/USD

Peak/off-peak billing, peak = 01:00–04:00 and 06:00–10:00 UTC, i.e.
**06:30–09:30 and 11:30–15:30 IST** — morning academies pay double, evening
traffic is off-peak.

| per 1M tokens | flash off-peak | flash peak | pro off-peak | pro peak |
|---|---|---|---|---|
| input, cache hit | $0.007 · ₹0.62 | $0.014 · ₹1.23 | $0.022 · ₹1.94 | $0.044 · ₹3.87 |
| input, cache miss | $0.22 · ₹19.36 | $0.44 · ₹38.72 | $0.66 · ₹58.08 | $1.32 · ₹116.16 |
| output (reasoning included) | $0.66 · ₹58.08 | $1.32 · ₹116.16 | $1.98 · ₹174.24 | $3.96 · ₹348.48 |

Measured expectation for a warm-cache 2.5-round turn + reflection on flash,
off-peak, thinking low: **≈ ₹0.4–0.5**; cold cache ≈ ₹2.3. The marginal cost
of an extra tool round is ~₹0.1 (mostly cache-hit input), which is why
`MAX_TOOL_ROUNDS` stays a failure bound, not a cost lever.

## The honesty ledger

- **Verified live**: model list; 402 shape and precedence; text-only schema
  rejection; key authenticates.
- **Exercised by the probe campaign and by production traffic since cutover
  (15 Aug 2026)**: tool calls, thinking tiers, caching behavior, JSON mode,
  finish reasons, Hinglish competence, real cache hit rates and latency.
- **Still unverified — and not used by the product, which is why**: named
  `tool_choice` forcing; strict mode. Verify before either is relied on.

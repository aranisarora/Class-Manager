# The switch to DeepSeek

The plan for moving `MODEL_MAIN` and `MODEL_SYNTH` from Gemini on Vertex to
DeepSeek's API. This file is disposable: when the migration is done and the
probe numbers are in, its findings move to the permanent docs and it gets
deleted. The durable reference — what the code needs to know about DeepSeek's
API — is `lib/agent/deepseek-api.md`.

## Status — 15 Aug 2026

**Phases 1–5 are built and on `main`; nothing has been run against the live API
yet, by instruction.** So every number in this file is still an estimate and
every claim about behaviour is still a claim. Done:

- `lib/agent/deepseek.ts` — the client. `gemini.ts` is untouched and now
  unimported, kept as the rollback road until phase 7 says otherwise.
- `loop.ts` speaks messages, threads `tool_call_id`, echoes the assistant message
  verbatim with `reasoning_content`, and answers a malformed `arguments` string
  with the parse error rather than losing it.
- Both structured call sites go through `generateJson` — json mode, validation,
  one retry.
- Media is off the model path, and media *arrivals* are answered by the runtime
  (`mediaRefusal`). §14.5 is repealed in the spec rather than deleted, the brain
  no longer invites a photo or a voice note, and the finding is F-J in
  `conversation-rules.md`.
- `pricing.ts` has DeepSeek rows, a real `cachedIn` rate and peak awareness; the
  probe's duplicate table is deleted and imports this one; `--thinking` sweeps
  arms; the Hinglish arc case exists.
- `.env.local` wants `DEEPSEEK_API_KEY` (the schema requires it) and names
  `deepseek-v4-flash` / `deepseek-v4-pro`. **`MODEL_SYNTH=deepseek-v4-pro` is an
  assumption made with no evidence** — phase 6 is what settles it.

Not done, in order: the phase 6 verification list, the four-arm arc, the pass
criteria, all of phase 7, and the residency sign-off that gates cutover. **The
first live call this repo makes should be a cheap one-off from the verification
list, not the arc.**

## Why we are switching, and what we are accepting

**For:** 2–5× cheaper per turn, and the gap widens with traffic — DeepSeek's
automatic prefix cache pays the §4.4 stable-prefix design the reward Gemini's
implicit cache measurably never did (turns logged 0 cached tokens cross-turn;
that finding is why `gemini.ts` grew 140 lines of explicit-cache machinery,
all of which this migration deletes). The rewrite also lands us on the OpenAI
wire dialect, which is a door that swings back: Gemini, Fireworks and
OpenRouter all speak it, so a base-URL change undoes this migration if
DeepSeek's capacity or pricing turns on us. And thinking-with-tools *may*
recover the discretionary judgement C29's zero-thinking amputated
(`schedule`/`remember`/`view` fired 0/3/1 times in 93 turns) — DeepSeek
reasons in a separate channel, so deliberation may no longer corrupt the call.

**Accepted, deliberately:**

- **Text only.** DeepSeek's API has no image or audio input — verified live,
  the request schema rejects non-text parts before auth is even checked. §14.5
  ("audio arrives as audio") is repealed, not worked around. Decided 2026-08-15.
- **No constrained decoding.** `responseJsonSchema` has no stable equivalent;
  the two structured-output call sites move to validate-and-retry.
- **Not faster.** Expect similar median latency with a fatter tail. The win is
  money and possibly judgement, never speed.

**Not yet decided — blocks production cutover, not the build:**

- **Data residency.** DeepSeek processes on servers in China, no DPA. This
  product carries children's names, family phone numbers and payment records.
  A written yes/no on this, made on purpose, is a cutover gate.

## Decision gates

The build can proceed through phase 5 on a dead account. Nothing ships until:

1. **Top-up:** $10 (~₹880) on the DeepSeek platform. Covers the whole probe
   campaign (~₹30–60/full arc run on flash, ~₹90 on pro) with headroom.
2. **Probe pass** (phase 6 criteria below).
3. **Residency sign-off** in writing.

## Phase 1 — the client

New `lib/agent/deepseek.ts`, replacing `gemini.ts`. The `GenResult` contract
(`text`, `functionCalls`, `usage`, `model`, `ms`, `finishReason`) is
preserved exactly so the rest of the product barely notices; `modelParts`
becomes the raw assistant message (see phase 2). Raw `fetch`, no SDK — the
non-streaming keep-alive blank lines are JSON whitespace and parse fine.

- Wire format per `lib/agent/deepseek-api.md`. Base `https://api.deepseek.com`.
- `tool_calls[].function.arguments` is a **string**: `JSON.parse` it, and a
  parse failure is our new `MALFORMED_FUNCTION_CALL` — record the raw string
  in the trace the way `modelParts` is carried today (`loop.ts:1012-1022`),
  because it is the only clue to which call was being attempted.
- Retry: one retry after 1.5s on 429/500/503 — same shape as today, 500 added.
  **Never retry 402** (insufficient balance): fail loudly with its own error
  code, because retrying it is burning latency on a fact.
- `finish_reason: "insufficient_system_resource"` means the response is
  **incomplete**, not done. It must not look like a clean stop.
- Explicit request timeout (start at 120s): DeepSeek holds connections up to
  10 minutes before inference begins, and no turn is worth that.
- Delete: all explicit-cache machinery, the Vertex client, `isStaleCacheError`,
  `forgetCache`, `cachedContentFor`. Caching becomes two usage fields read
  after the fact: `cachedTokens = prompt_cache_hit_tokens`.
- Keep: the `sim_fault` injection block, `fail()`, the timing, verbatim.

## Phase 2 — loop threading

`lib/agent/loop.ts`:

- **`tool_call_id`.** Today results match calls positionally. DeepSeek
  requires each `{role:"tool"}` message to carry the id of the call it
  answers. Thread it from `functionCalls` through `runTool` and back.
- **The echo rule changed clothes.** `contents.push({role:'model', parts:
  res.modelParts})` (thought signatures, `loop.ts:1040`) becomes: push the
  assistant message back **verbatim, `reasoning_content` included** — with
  tools in play, omitting it is a 400. Same discipline, new field name.
- **Thinking tiers.** `TURN_THINKING {compose:0, guide:1024, judge:512}` maps
  to `{thinking, reasoning_effort}` at the client boundary — the numeric
  tiers stay, exactly as `applyThinking` translates for Gemini 3 today.
  Provisional mapping, **to be settled by phase 6, not by this table**:
  `0 → disabled`, `≤1024 → enabled/low`, higher → `enabled/high`.
- **Temperature.** Ignored in thinking mode (silently — no error). Stop
  sending it on thinking calls; keep it on non-thinking ones. Same pattern as
  the Gemini 3 omission, same reason.
- `flattenToolTurns` adapts to messages format for the forced recovery call.

## Phase 3 — structured output

`memory.ts:324-339` and `loop.ts:1873-1891` lose constrained decoding. Both
are MODEL_SYNTH batch paths where a retry costs nothing anyone notices, so:
`response_format:{type:"json_object"}` + the schema and an example in the
prompt (the literal word "json" must appear or the request errors) + zod
validation + **one** retry on parse/validate failure. DeepSeek's own docs
admit JSON mode occasionally returns empty content; the retry is for exactly
that.

The forced-single-tool-call + `strict:true` upgrade is **post-migration**,
gated on phase 6 verifying that named `tool_choice` forcing works at all —
it is documented only as `auto`/`none` and we could not verify it live.

## Phase 4 — media removal

Text-only is a product decision, so it gets done properly, not by letting
requests fail:

- Remove the media path: `loop.ts:925-933` (inlineData parts), the mime
  guessing in `seed.ts:2971-2980`, emulator media kinds where they feed the
  model, `transport-cloud.ts` inbound media handoff, `types.ts` media kinds
  on the model-bound side. WhatsApp *outbound* media (links, documents we
  send) is unaffected — this is about what reaches the model.
- **Media still arrives** — voice notes are how half of India types. An
  inbound message carrying media must get a designed reply ("I can't listen
  to voice notes yet — could you type that?"), never a silent drop: going
  quiet is the one failure a person cannot tell apart from being ignored.
  The finding goes in `conversation-rules.md`; the fix is structural, in the
  inbound path, per the documentation rule.
- Docs sweep: §14.5 in the spec, the `gemini.ts` header claim ("there is no
  transcription step anywhere in this product"), CONTRACTS §6, anything else
  `grep -ri "as audio"` finds. A spec that promises audio over a text-only
  client is the drift these docs exist to prevent.

## Phase 5 — pricing and probe plumbing

- `lib/pricing.ts`: DeepSeek rows; a real `cachedIn` field replacing the
  hardcoded `× 0.25` — DeepSeek's cache-hit rate is **3.2%** of a miss, and
  the 0.25 would overstate cached cost ~8×, in the direction that makes
  DeepSeek look worse than it is. Peak/off-peak awareness (see the reference
  doc for windows). Collapse the duplicate table in `probe-model.ts:979` into
  this one — it says "one place to be wrong" and is currently two places.
- `probe-model.ts`: default `--models deepseek-v4-flash,deepseek-v4-pro`; a
  `--thinking` sweep flag driving the tier mapping; record the UTC hour and
  the rate applied per run, because peak/off-peak makes two identical runs
  bill differently and an unexplained cost delta is a probe defect.
- **New arc case: Hinglish.** e.g. admin sends "kal 6 baje wali beginners
  class cancel kar do" — DeepSeek's Indian-language competence is the one
  capability regression risk this migration has, and the arc currently never
  asks the question. Gemini is strong here; DeepSeek is unproven.

## Phase 6 — the probe campaign

Everything above this line can be built blind. Nothing below ships without it.

**Verification list** (cheap one-off scripts, not the arc):

- [ ] Tool calling round-trips: call → execute → `tool` message → composed reply
- [ ] Named `tool_choice` forcing works (docs say only `auto`/`none`)
- [ ] Parallel tool calls: does one round ever carry several? (loop copes
      either way; the trace should know)
- [ ] `strict:true` on `/beta` accepts our schemas (all-required +
      `additionalProperties:false` + no min/max constraints)
- [ ] `reasoning_content` echo omission really 400s (so the loop's guard is
      tested, not trusted)
- [ ] Re-run `probe-ceiling.ts` — the 128 limit is the same but the failure
      mode of an over-limit or malformed declaration is not, and a
      misdiagnosed ceiling shaped this architecture once already

**The arc, four arms** — one variable at a time, per the probe's own rules:

1. current prefix + thinking disabled (baseline; C29 transplanted)
2. current prefix + low thinking (tests "the prefix needed a reader")
3. slim prefix + low thinking (piles A+B kept, compensatory procedure and the
   redundant prose operation signatures deleted)
4. slim prefix + high (only if 3 ≥ 2)

Scored on what the probe already scores, with the decisive metrics being:
discretionary-tool usage (the 0/3/1 silence), onboarding sequencing,
invariant violations, parse/malformed failures, latency, ₹/turn. The
decisive *comparison* is 2 vs 3: a tie means the modules were dead weight; 2
winning means the prefix content was load-bearing and the win was thinking.

**Pass criteria for cutover:** `compose-big` follow-through at parity with
gemini-2.5-flash or better; zero invariant regressions; parse-failure rate on
tool arguments under the malformed-call rate we live with today; the Hinglish
case answered competently; measured ₹/turn within 2× of the estimates in this
plan (if it isn't, the cache isn't hitting and the whole cost case reopens).

**Model choice:** `deepseek-v4-flash` for `MODEL_MAIN` unless the arc says
otherwise. Probe `deepseek-v4-pro` only for the judge/reflection tier and
`MODEL_SYNTH` — the paths where judgement matters and latency doesn't.

## Phase 7 — cutover

- `.env`: `DEEPSEEK_API_KEY` in; `MODEL_MAIN=deepseek-v4-flash`,
  `MODEL_SYNTH` per probe. `env.ts` schema follows.
- Vertex creds and `@google/genai` stay installed until N clean days of
  production traffic (pick N when cutting over; 7 is reasonable), then:
  drop the dependency, delete `gemini.ts`, remove `VERTEX_*` /
  `GOOGLE_APPLICATION_CREDENTIALS_JSON` from env and schema.
- Run probes and initial traffic **off-peak** where possible: peak
  (06:30–09:30 and 11:30–15:00 IST) bills double for zero information.
- The API key lives in `.env` only. It has already been pasted in one chat;
  rotate it on the platform before production cutover.

## Rollback

The client speaks OpenAI dialect, so rollback is a base-URL + model-name
change to Gemini's OpenAI-compatibility endpoint (thinking knob remapped),
or — until phase 7 completes — flipping `MODEL_MAIN` back and letting the
untouched `gemini.ts` path carry traffic again. Nothing in phases 1–6 burns
the old road.

## Out of scope, on purpose

- Strict mode as the structured-output mechanism (post-migration, gated on
  verification).
- Declaring `plan`'s step union via `anyOf` (a real upgrade Gemini could
  never express — but it is schema work, not migration work).
- Streaming, `/anthropic` dialect, per-user `user_id` isolation (which would
  partition the shared prefix cache per tenant and destroy the §4.4 win —
  see the reference doc).

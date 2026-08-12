# CONTRACTS — build spine

> `product-spec.md` is the **what**. This file is the **how**: exact module boundaries, type
> signatures and file ownership, so that independently-written modules compose without rework.
>
> **Rules for every implementer:**
> 1. `product-spec.md` wins on behavior. This file wins on signatures.
> 2. **Only write the files you own.** If you need something from another module, import it from
>    the path below and trust the signature — do not create your own copy, do not edit their file.
> 3. Every signature below is final. If one is genuinely wrong, implement it anyway and say so.
> 4. TypeScript, `"type": "module"`, ESM, strict. Next.js 15 App Router. React 19. Tailwind v4.
> 5. Never read `Date.now()` for domain time. Time comes from `lib/clock.ts` (§13/§17 drivable clock).
> 6. Never write a send helper. `lib/messaging/send.ts::send` is the only path to the wire (§16.3).

---

## 0. Environment

`.env.local` (already written, do not regenerate):

```
DATABASE_URL=postgresql://cm_runtime.gtszuofampswpgwtglaj:<pw>@aws-0-ap-south-1.pooler.supabase.com:5432/postgres
SUPABASE_URL=https://gtszuofampswpgwtglaj.supabase.co
SUPABASE_PUBLISHABLE_KEY=<publishable-key>
GOOGLE_APPLICATION_CREDENTIALS_JSON=./.secrets/vertex-sa.json
VERTEX_PROJECT_ID=project-2599a33f-799e-4a51-921
VERTEX_LOCATION=global
MODEL_MAIN=gemini-2.5-flash
MODEL_SYNTH=gemini-2.5-pro
APP_JWT_SECRET=<32b>
APP_BASE_URL=http://localhost:3000
TRANSPORT=emulator
```

`lib/env.ts` exports a validated `env` object with exactly those keys (camelCase-free — keep the
same names). Owned by **Core**.

---

## 1. File ownership

| Owner | Files |
|---|---|
| **DB** | `supabase/migrations/*.sql` |
| **Core** | `lib/env.ts` `lib/db.ts` `lib/clock.ts` `lib/types.ts` `lib/ids.ts` `lib/audit.ts` |
| **Msg** | `lib/messaging/*` `lib/actions.ts` |
| **Agent** | `lib/agent/*` `lib/behaviors/*.md` `lib/doctrine.md` |
| **Jobs** | `lib/jobs/*` |
| **Web** | `lib/web/*` `app/w/**` `components/view/**` |
| **Emu** | `app/emulator/**` `components/emulator/**` |
| **API** | `app/api/**` |
| **Sim** | `lib/sim/*` `app/emulator/sim/**` |
| **Shell** | `app/layout.tsx` `app/page.tsx` `app/globals.css` `next.config.ts` `tsconfig.json` `postcss.config.mjs` `scripts/*` |

Import alias: `@/` → repo root. So `import { sql } from '@/lib/db'`.

---

## 2. Core — `lib/db.ts`

The DB connection is role `cm_runtime`, which has **no table privileges at all**. Every query runs
inside a transaction that first `SET LOCAL ROLE`s to one of three roles and sets the GUCs that RLS
policies read. This is invariant §2.1 made mechanical: there is no way to touch a row without
declaring who you are.

```ts
import postgres from 'postgres'

export type Tx = postgres.TransactionSql<{}>

export type SessionCtx =
  | { role: 'service'; academyId: string }
  | { role: 'user'; academyId: string; personId: string; contactId: string }
  | { role: 'readonly'; academyId: string; personId: string; contactId: string }

/** Raw handle. Only `lib/db.ts`, `lib/clock.ts` and migrations may use it. */
export const sql: postgres.Sql<{}>

/**
 * One transaction, one role, GUCs set. Rolls back if `fn` throws.
 *   SET LOCAL ROLE cm_service|cm_user|cm_readonly
 *   SET LOCAL app.academy_id / app.person_id / app.contact_id
 */
export function withSession<T>(ctx: SessionCtx, fn: (tx: Tx) => Promise<T>): Promise<T>

/** Same, but rolls back unconditionally. Used by `previewPlan` (§14.2 compute-before-commit). */
export function withRollback<T>(ctx: SessionCtx, fn: (tx: Tx) => Promise<T>): Promise<T>

export type QueryResult = {
  rows: Record<string, unknown>[]
  rowCount: number
  truncated: boolean          // true when the 10k cap clipped it
  ms: number
  error?: string
}

/** Model-authored SELECT. cm_readonly, 5s statement timeout, 10 000 row cap (§14.2). */
export function modelQuery(ctx: SessionCtx, query: string): Promise<QueryResult>

/** Throws unless `query` is exactly one statement and starts with select/with. */
export function assertSingleReadStatement(query: string): void
/** Throws unless exactly one statement and it is insert/update/delete/select. */
export function assertSingleWriteStatement(query: string): void
```

`withSession` implementation detail that matters: `SET LOCAL` only holds inside a transaction, so
every call is wrapped in `sql.begin()`. Never `SET ROLE` outside one — the pooler reuses connections.

---

## 3. Core — `lib/clock.ts`

Spec §17: one shared clock across all panes, advanced on demand. Backed by `sim_clock.offset_ms`.

```ts
export function now(): Promise<Date>
/** Synchronous read of the last-loaded offset. Refreshed by `now()` / `refresh()`. */
export function nowSync(): Date
export function refresh(): Promise<Date>
export function advance(ms: number): Promise<Date>
export function setTo(when: Date): Promise<Date>
export function reset(): Promise<Date>
/** ms until the next thing the scheduler would do — powers the emulator's "jump to next event". */
export function nextEventAt(): Promise<Date | null>
export function inZone(d: Date, tz: string): { date: string; time: string; label: string; weekday: number }
```

SQL-side equivalent is `app.now()`. **Any SQL comparing against the present must use `app.now()`,
never `now()`.**

---

## 4. Core — `lib/types.ts`

Row types mirroring every table, `PascalCase` name, snake_case fields (they come straight off
postgres.js): `Academy Venue Person Contact Account Player Coach AcademyAdmin MemoryFact Class
ClassSlot ClassCoach Enrollment Session SessionCoach Attendance TallyLine Payment Sender Message
ActionRow ViewSpecRow Job AuditEntry Recipe Turn SimClock SimFault SimRun`.

Plus:

```ts
export type Role = 'admin' | 'coach' | 'account_holder' | 'player' | 'prospect'
export type Identity = {
  academyId: string; academy: Academy
  contact: Contact; person: Person
  roles: Role[]                       // §6.2 roles compose — this is an array, never a scalar
  coachId: string | null
  accountIds: string[]
  playerIds: string[]
  isSolo: boolean                     // §18 — for SHAPING only, never gating
  seesMoney: boolean
}
export type RateUnit = 'per_session' | 'per_month' | 'per_term' | 'per_package'
export type SessionStatus = 'scheduled' | 'cancelled' | 'completed'
export type AttendanceStatus = 'present' | 'late' | 'absent' | 'cancelled_timely'
export type ContactState = 'prospect' | 'registered' | 'engaged' | 'opted_out'
export type CoachStatus = 'added' | 'invited' | 'active' | 'ended'
export type OnboardingState = 'setup' | 'roster' | 'ready' | 'live'
```

`lib/identity.ts` (**Core**) resolves one:

```ts
export function resolveIdentity(contactId: string): Promise<Identity | null>
export function resolveInbound(fromPhoneE164: string, senderPhoneE164: string, profileName?: string, text?: string):
  Promise<{ identity: Identity; isNew: boolean } | { unresolved: true; candidates: {academyId:string;name:string}[] }>
```

`resolveInbound` implements §10.1 routing: a number known to exactly one academy resolves on sight;
an unknown number matches the academy named in the prefilled text; ambiguity returns candidates.

---

## 5. Msg — message primitives

### `lib/messaging/types.ts`

Limits are the real Cloud API's (§17: "something that works here works there"). Enforce them.

```ts
export const LIMITS = {
  bodyChars: 1024,          // interactive body
  textChars: 4096,          // plain text
  buttons: 3,
  buttonTitleChars: 20,
  listRows: 10,
  listRowTitleChars: 24,
  listSectionTitleChars: 24,
  headerChars: 60,
  footerChars: 60,
} as const

export type Button = { actionId: string; title: string }
export type ListRow = { actionId: string; title: string; description?: string }
export type ListSection = { title: string; rows: ListRow[] }

export type OutboundMessage = {
  toContactId: string
  body: string
  header?: string
  footer?: string
  buttons?: Button[]
  list?: { buttonText: string; sections: ListSection[] }
  media?: { url: string; kind: 'image' | 'audio' | 'document'; filename?: string }
  catalogId?: CatalogId | null      // §12 — null for a composed message (§14.4)
  templateName?: TemplateName | null
  idempotencyKey: string
  /** Who this message is ABOUT. Drives the two §18 suppression rules. */
  subjectPersonIds?: string[]
  isConfirmationRequest?: boolean
  isEscalation?: boolean
  /** §12 "fixed" rows: cannot be suppressed by policy, only reworded/merged. */
  fixed?: boolean
  /**
   * Additive. True when this message answers something the recipient just said — the reply in
   * a turn they started, or a tap's ack. Set by `composeAndSend` from the acting session
   * (`role:'user'` + matching `contactId`), never by a caller. Exempts the message from gate
   * 6's per-recipient frequency cap, which counts interruptions: an answer to a question is
   * not one, and capping it silences the bot mid-conversation. The per-tenant cap still applies.
   */
  solicited?: boolean
  /** Set by onboarding flows that are allowed to send before `academy.onboarding_state='live'`. */
  preLaunchOk?: boolean
}

export type SendOutcome =
  | { status: 'queued' | 'sent'; messageId: string; waMessageId: string | null; inWindow: boolean; template: TemplateName | null; costPaise: number }
  | { status: 'suppressed'; reason: SuppressReason; messageId: string | null }
  | { status: 'failed'; reason: string; messageId: string | null }

export type SuppressReason =
  | 'opted_out' | 'self_confirmation' | 'escalation_about_self' | 'pre_launch'
  | 'recipient_frequency_cap' | 'tenant_send_cap' | 'out_of_window_no_template'
  | 'duplicate_idempotency' | 'no_contact' | 'limit_violation'
```

### `lib/messaging/catalog.ts`

```ts
export type CatalogId =
  | 'CL-INTRO' | 'CL-FIRST-CONTACT' | 'CL-REMINDER' | 'CL-CANCEL-CONFIRM' | 'CL-SESSION-TROUBLE'
  | 'CL-OUTCOME' | 'CL-TALLY' | 'CL-RECEIPT' | 'CL-DUNNING' | 'CL-SESSION-CANCELLED' | 'CL-SESSION-MOVED'
  | 'PR-WELCOME' | 'PR-TRIAL-CONFIRMED'
  | 'CO-INVITE-CONFIRM' | 'CO-DAY' | 'CO-COMING' | 'CO-NUDGE' | 'CO-REGISTER'
  | 'CO-COVER-OFFER' | 'CO-COVER-TAKEN' | 'CO-PAYABLES' | 'CO-FINAL-STATEMENT'
  | 'AD-MORNING-BRIEF' | 'AD-EVENING-DIGEST' | 'AD-ESCALATE-UNCONFIRMED' | 'AD-COACH-LATE'
  | 'AD-COACH-NOT-ONBOARDED' | 'AD-REGISTER-MISSING' | 'AD-RECONCILE' | 'AD-NEW-TRIAL'
  | 'AD-OPT-OUT' | 'AD-DELIVERY-FAILURE'

export type CatalogEntry = {
  id: CatalogId
  audience: 'client' | 'coach' | 'admin' | 'prospect'
  trigger: string                 // prose, goes in the prompt
  defaultButtons: string[]        // titles; the model may re-button (§12)
  onSilence: string
  fixed: boolean                  // §12 fixed list
  template: TemplateName          // §16.2 — which of the 8 categories carries it out of window
}
export const CATALOG: Record<CatalogId, CatalogEntry>
/** Rendered into the agent's stable prefix so the model knows every moment code can raise. */
export function catalogDigest(): string
```

`TemplateName = 'session_reminder'|'session_change'|'session_outcome'|'payment_due'|'coach_schedule'|'coach_prompt'|'admin_alert'|'admin_digest'` (§16.2 — exactly eight).

### `lib/messaging/transport.ts`

```ts
export type TransportRequest = {
  senderPhoneE164: string
  toPhoneE164: string
  toWaId: string | null
  message: OutboundMessage
  asTemplate: TemplateName | null
}
export type TransportResult =
  | { ok: true; waMessageId: string }
  | { ok: false; error: string; permanent: boolean }
export interface Transport { readonly name: 'emulator' | 'cloud'; send(req: TransportRequest): Promise<TransportResult> }
export function getTransport(): Transport
```

Two implementations: `lib/messaging/transport-emulator.ts` and `lib/messaging/transport-cloud.ts`.
The cloud one is written against the real Cloud API shape but is never exercised in this build.
**No Meta API call may exist anywhere outside `transport-cloud.ts`** (§17).

### `lib/messaging/send.ts` — the one send path (§16.3)

```ts
export function send(ctx: SessionCtx, msg: OutboundMessage): Promise<SendOutcome>
/** Marks delivery/read from a transport callback (or the emulator's "mark read"). */
export function markStatus(waMessageId: string, status: 'sent'|'delivered'|'read'|'failed', reason?: string): Promise<void>
```

Gate order — implement exactly, and record the reason on the `message` row rather than dropping
silently, so the emulator's event log shows suppressions:

1. contact missing / `opted_out_at` set → `opted_out`
2. **§18 rule 1** — recipient ∈ `subjectPersonIds` and `isConfirmationRequest` → `self_confirmation`
3. **§18 rule 2** — recipient ∈ `subjectPersonIds` and `isEscalation` → `escalation_about_self`
4. `academy.onboarding_state !== 'live'` and not `preLaunchOk` → `pre_launch` (§2.6)
5. limit validation (LIMITS) → `limit_violation`
6. per-recipient frequency cap, default 6 per rolling 24h, `fixed` exempt → `recipient_frequency_cap`
7. per-tenant cap, default 400 per rolling 24h, `fixed` exempt → `tenant_send_cap`
8. window: `app.now() - contact.last_inbound_at < 24h` → free-form; else `asTemplate = entry.template`;
   if no template resolvable → `out_of_window_no_template`
9. idempotency key already present → `duplicate_idempotency`, return the existing row
10. insert `message` (`status='queued'`) → `getTransport().send()` → stamp `sent`/`failed`

Cost model for the event log: in-window = 0 paise; template send opens a conversation priced by
category — `service` 35, `utility` 30, `marketing` 88, `authentication` 15 paise. Approximate on
purpose; the point is that the emulator shows *that* a paid conversation opened (§17).

### `lib/messaging/compose.ts`

```ts
/** Mints an action per button, then hands a well-formed OutboundMessage to `send`. */
export function composeAndSend(ctx: SessionCtx, spec: {
  toContactId: string; body: string; header?: string; footer?: string
  buttons?: { title: string; action: ActionPayload }[]
  list?: { buttonText: string; sections: { title: string; rows: { title: string; description?: string; action: ActionPayload }[] }[] }
  catalogId?: CatalogId | null; fixed?: boolean; subjectPersonIds?: string[]
  isConfirmationRequest?: boolean; isEscalation?: boolean; preLaunchOk?: boolean
  media?: OutboundMessage['media']
}): Promise<SendOutcome>
```

### `lib/actions.ts` — mint once, replay verbatim (§2.2, §6.5)

```ts
export type ActionPayload =
  | { kind: 'operation'; op: OperationName; args: Record<string, unknown> }
  | { kind: 'steps'; steps: PlanStep[]; summary: string }
  | { kind: 'reply'; text: string }         // replays as if the user typed it — goes back through the agent
  | { kind: 'view'; viewSpecId: string }
  | { kind: 'menu'; menu: 'root' | string }
  | { kind: 'noop'; ack: string }

export function mintAction(ctx: SessionCtx, a: {
  payload: ActionPayload; forContactId: string; ttlMinutes?: number   // default 1440
}): Promise<string>

export type ConsumeResult =
  | { ok: true; payload: ActionPayload }
  | { ok: false; reason: 'expired' | 'already_used' | 'wrong_contact' | 'missing' }

/** Loads, validates expiry + consumption + `minted_for_contact_id`, stamps `consumed_at`.
 *  NO MODEL CALL, no re-resolution, no string parsing (§6.5). */
export function consumeAction(ctx: SessionCtx, actionId: string, byContactId: string): Promise<ConsumeResult>
```

---

## 6. Agent — `lib/agent/*`

### `lib/agent/gemini.ts`

```ts
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

export function generate(o: {
  system: string; contents: GenContent[]; tools?: ToolDecl[]
  model?: string; temperature?: number; maxOutputTokens?: number
  responseJsonSchema?: object
}): Promise<GenResult>
```

Vertex AI via `@google/genai` (`vertexai: true`, credentials from
`GOOGLE_APPLICATION_CREDENTIALS_JSON`). Honour `sim_fault` kind `model_error`.

### `lib/agent/context.ts` — the layered prompt (§4)

```ts
/** Layers 2+0+3 + operation signatures. MUST be byte-identical across turns (§4.4).
 *  Built once at module load, memoised. No timestamps, no ids, no per-academy anything. */
export function stablePrefix(): string

/** Layer 4 + situation. Never cached. */
export function variableTail(id: Identity, extra?: {
  clockNote?: string; taskInstruction?: string; queryResults?: unknown
}): Promise<string>

/** Layer 5 (§4.5). Four string operations, nothing else. */
export function lint(text: string, id: Identity): string
```

`lint` must: strip uuids and table names; rewrite ISO timestamps into the academy's tz and idiom;
downgrade "delivered"→"sent" where only `sent_at` is known; flag vocabulary the academy's memory
says they don't use. **Number-grounding is not a lint rule** — do not attempt it here.

`lib/doctrine.md` holds the ten layer-2 rules (§4.1) verbatim.
`lib/behaviors/*.md` — nine files, exactly the names in §4.2, each opening with its **trigger
condition** rather than a title. Always all loaded, in the stable prefix.

### `lib/agent/plan.ts` — `transaction(steps[])` (§14.2.1)

```ts
export type PlanStep =
  | { write: string }
  | { operation: { name: OperationName; args: Record<string, unknown> } }
  | { adjust: { account_id: string; player_id?: string | null; amount: number; reason: string; period?: string; description?: string } }
  | { message: { to_contact_id?: string; to_person_id?: string; body: string
                 buttons?: { title: string; action: ActionPayload }[]
                 catalog_id?: CatalogId | null; fixed?: boolean; subject_person_ids?: string[] } }
  | { schedule: { kind: JobKind; run_at: string; dedupe_key: string; payload: Record<string, unknown> } }

export type TableDiff = { table: string; op: 'insert'|'update'|'delete'; count: number; before: any[]; after: any[] }
export type PlanResult = {
  ok: boolean
  diffs: TableDiff[]
  totalRows: number
  stagedMessages: { toContactId: string; preview: string }[]
  scheduled: { kind: string; run_at: string }[]
  summary: string             // human sentence: "14 enrollments, all of Saturday Advanced, moving to 8:30"
  error?: string
}

/** BEGIN → run every step → capture diff → ROLLBACK. Messages never leave the outbox. */
export function previewPlan(ctx: SessionCtx, steps: PlanStep[]): Promise<PlanResult>

/** BEGIN → run → capture → COMMIT → only then flush the outbox through `send`.
 *  A rolled-back transaction has messaged nobody (§2.5, §14.2.1). */
export function executePlan(ctx: SessionCtx, steps: PlanStep[], intent: string):
  Promise<PlanResult & { auditId: string; outcomes: SendOutcome[] }>

/** §14.2 preview scaling. */
export function needsPreview(result: PlanResult, steps: PlanStep[]): boolean
```

Diffs come from `row_snapshot`, written by a generic trigger while `app.audit_id` is set — so the
blast radius is **known, not estimated** (§2.3), and undo has before-images.

### `lib/agent/operations.ts` — named operations as recipes, not gates (§14.2.1)

```ts
export type OperationName =
  | 'end_coach' | 'cancel_session' | 'move_class' | 'reschedule_session' | 'waive'
  | 'book_trial' | 'mark_attendance' | 'confirm_coach' | 'decline_coach' | 'claim_cover'
  | 'client_cancel' | 'record_payment' | 'request_payment' | 'opt_out' | 'set_timing'
  | 'create_class' | 'add_coach' | 'add_family' | 'send_invite_draft' | 'undo'
  | 'set_onboarding_state' | 'remember' | 'forget' | 'list_watches' | 'drop_watch'

export type OperationDef = {
  name: OperationName
  description: string                    // one line, goes in the stable prefix
  params: z.ZodTypeAny
  /** Operations BUILD steps; they never write directly. Same machinery, same guarantees. */
  build(ctx: SessionCtx, args: any, id: Identity): Promise<PlanStep[]>
  destructive?: boolean
}
export const OPERATIONS: Record<OperationName, OperationDef>
/** ~1k tokens, part of the stable prefix (§4.4). */
export function operationSignatures(): string
```

### `lib/agent/tools.ts` — the seven primitives (§14.1)

Function declarations handed to Gemini, and their executors:

| tool | does |
|---|---|
| `read` | `modelQuery` under `cm_readonly`. Returns rows + the **scope line** (§14.2) |
| `plan` | build a `PlanStep[]`, `previewPlan`, return the diff. Never commits |
| `commit` | execute the plan just previewed (by handle) |
| `act` | one-shot: single-row own-scope write, executes directly (§14.2 preview table row 1) |
| `reply` | send a composed message with buttons — goes through `composeAndSend` |
| `schedule` | mint an `agent_task` (§13.1). `expires_at` REQUIRED, rejected without one |
| `view` | mint a `view_spec`, return a signed link (§15) |
| `remember` | append a `memory_fact` (§5). Async, never blocks the reply |
| `recall` | search the fact store beyond the hot set (§5) |
| `handoff` | §14.8 escape hatch |

```ts
export const TOOL_DECLS: ToolDecl[]
export function runTool(name: string, args: any, ctx: ToolCtx): Promise<{ result: unknown; note?: string }>
export type ToolCtx = { session: SessionCtx; identity: Identity; turnId: string; pendingPlans: Map<string, PlanStep[]> }
```

### `lib/agent/loop.ts`

```ts
export type TurnInput = {
  contactId: string
  text?: string
  media?: { url: string; mimeType: string }[]
  actionId?: string          // a button tap: consumed WITHOUT a model call first (§2.2)
  source: 'inbound' | 'job' | 'sim'
}
export type TurnOutput = { turnId: string; sent: SendOutcome[]; toolCalls: number; error?: string }

export function runTurn(input: TurnInput): Promise<TurnOutput>
export function runAgentTask(job: Job): Promise<void>      // §13.1, under the minter's RLS
export function synthesize(academyId: string, kind: 'brief' | 'digest'): Promise<TurnOutput>   // §10.2
```

Loop shape: resolve identity → if `actionId`, `consumeAction` first and execute the stored payload
with **no model call**; only `kind:'reply'` re-enters the model → else build prefix+tail → up to 8
tool rounds → `lint` → `composeAndSend`. Record a `turn` row always, including on error.

### `lib/agent/memory.ts` (§5)

```ts
export function writeFact(ctx: SessionCtx, f: { subjectKind: 'academy'|'person'; subjectId: string; fact: string; source?: string; supersedes?: string }): Promise<string>
export function hotSet(subjectKind: 'academy'|'person', subjectId: string): Promise<string>
export function searchFacts(ctx: SessionCtx, subjectId: string, query: string): Promise<MemoryFact[]>
export function curate(subjectKind: 'academy'|'person', subjectId: string): Promise<void>  // scheduled, not per-turn
export const CURATE_THRESHOLD = 12
```

---

## 7. Jobs — `lib/jobs/*`

```ts
export type JobKind =
  | 'materialize_sessions' | 'coach_day' | 'coach_coming' | 'coach_nudge'
  | 'admin_escalate_uncovered' | 'client_session_trouble' | 'client_reminder'
  | 'post_class_register' | 'register_expiry' | 'client_outcome'
  | 'admin_morning_brief' | 'admin_evening_digest'
  | 'monthly_lines' | 'month_end_tally' | 'dunning'
  | 'first_contact_batch' | 'memory_curate' | 'coach_not_onboarded'
  | 'reconcile' | 'agent_task'

export function enqueue(kind: JobKind, runAt: Date, dedupeKey: string, payload: Record<string, unknown>, academyId?: string): Promise<string>
export function cancelByPrefix(prefix: string): Promise<number>     // rescheduling cancels + re-enqueues
export const HANDLERS: Record<JobKind, (job: Job) => Promise<void>>
/** Claim + run everything due at `app.now()`. Idempotent. Every handler re-checks its
 *  own precondition at run time (§13) — a cancelled session's `coach_coming` must skip. */
export function runDueJobs(o?: { limit?: number }): Promise<{ ran: number; skipped: number; failed: number; log: string[] }>
/** Daily planner: enqueues the day's jobs for every academy. Called on clock advance + on tick. */
export function planAhead(): Promise<number>
```

`agent_task` handler: reconstruct the minter's session, re-check their roles **at run time**
(§13.1 — a task minted by a since-ended coach cannot run), refuse if past `expires_at`, then hand
the instruction + query results to `runTurn` as `source: 'job'`. Deciding to do nothing is the
common and correct outcome.

---

## 8. Web — `lib/web/*`, `app/w/[token]`

```ts
// lib/web/jwt.ts
export type LinkClaims = { academy_id: string; person_id: string; contact_id: string
                           purpose: 'setup'|'register'|'view'|'form'; ref?: string }
export function signLink(c: LinkClaims, ttlMinutes: number): Promise<string>
export function verifyLink(token: string): Promise<LinkClaims | null>
export function linkUrl(token: string): string          // `${APP_BASE_URL}/w/${token}`
```

The magic link **is** the session (§15). `/w/[token]` verifies, derives a `SessionCtx` of role
`user` from the claims, and renders. No login, no nav, no app shell.

```ts
// lib/web/registry.ts
export type ComponentSpec =
  | { type: 'table'; title?: string; query: string; columns?: {key:string;label:string;align?:'left'|'right'}[]; totals?: string[] }
  | { type: 'prose'; markdown: string }
  | { type: 'form'; title?: string; fields: FormField[]; submit: { operation: OperationName; fixedArgs?: Record<string,unknown> } }
  | { type: 'calendar'; query: string; title?: string }
  | { type: 'people-list'; query: string; title?: string }
  | { type: 'detail'; query: string; title?: string }
  | { type: 'stat-cards'; query: string; title?: string }
  | { type: 'timeline'; query: string; title?: string }
  | { type: 'chart'; title?: string; query: string; spec: VegaLiteish }
export type ViewSpec = { title: string; components: ComponentSpec[] }
export const ViewSpecSchema: z.ZodType<ViewSpec>
export function resolveView(ctx: SessionCtx, spec: ViewSpec): Promise<ResolvedView>
export const REGISTRY: Record<ComponentSpec['type'], { dataContract: string; render: string }>
```

Every `query` runs through `modelQuery` under the **link holder's** RLS. An invalid spec falls back
to `table`; too much data is aggregated at mint time; nothing renderable → answer in chat (§15).
**The model never authors markup.**

---

## 9. Emulator — `app/emulator`, `app/api/emulator/*`

Routes (all owned by **API**, all thin — logic lives in `lib/`):

| method + path | body | does |
|---|---|---|
| `POST /api/emulator/seed` | `{scenario}` | reset + seed a world |
| `GET /api/emulator/state` | | academies, contacts, clock, faults |
| `GET /api/emulator/thread?contactId=` | | one pane's messages |
| `GET /api/emulator/stream` | SSE | pushes `{type:'message'|'clock'|'job'|'turn'}` events |
| `POST /api/emulator/inbound` | `{contactId, text?, actionId?, mediaUrl?, mediaMimeType?}` | **the webhook equivalent** |
| `POST /api/emulator/contact` | `{academyId, name, role, phone?}` | add a test contact to a live world |
| `GET /api/emulator/memory?contactId=` | | §5 — the hot set and the fact record |
| `POST /api/emulator/clock` | `{advanceMs?|setToIso?|reset?|toNextEvent?}` | advance, then run due jobs |
| `POST /api/emulator/tick` | | run due jobs now |
| `POST /api/emulator/fault` | `{kind, active, rate}` | failure injection |
| `GET /api/emulator/events?since=` | | the event log |
| `POST /api/emulator/read` | `{messageId}` | mark delivered/read — proves §2.4 |
| `POST /api/sim/run` | `{seed, persona, goal, contactId}` | agent simulation |

`GET /api/emulator/stream` is Server-Sent Events, polling the DB on a ~600 ms cursor. Live updates
are required — the cover-claim race is only testable if pane B updates when you tap in pane A (§17).

UI (`app/emulator/page.tsx` + `components/emulator/*`): world picker · contact tray · N panes in a
grid · shared clock bar · event log · fault panel. It is **a primitive WhatsApp, not a replica**
(§17) — bubbles, reply buttons, list picker, media placeholders, and that is enough. Every pane
shows template-vs-in-window and the sender number. If a message cannot render, it does not ship.

---

## 10. Sim — `lib/sim/*` (§17, phase 12)

```ts
export type Persona = { name: string; description: string; style: string; traits: string[] }
export type SimGoal = { text: string; successCriteria: string[] }
export const PERSONAS: Persona[]       // include the uncooperative ones — they find more bugs
export function runPersona(o: { seed: string; contactId: string; persona: Persona; goal: SimGoal; maxTurns?: number }): Promise<SimRunResult>
export function judge(run: SimRunResult): Promise<JudgeReport>   // confusion, dead ends, repetition, wrong answers, §2.8 violations
export function diffRuns(a: SimRunResult, b: SimRunResult): RunDiff
```

---

## 11. Conventions

- **Errors:** throw `AppError` from `lib/errors.ts` (**Core**) with `{code, message, userMessage?}`.
- **Ids:** `lib/ids.ts` exports `newId()` (uuid v4) and `idem(...parts: string[])` for idempotency keys.
- **Money** is `numeric(10,2)` in Postgres and a JS `number` of rupees. Format with `formatINR()` in `lib/format.ts` (**Core**).
- **Timezone**: everything user-facing is rendered in `academy.timezone` via `lib/clock.ts::inZone`.
- **No `any` in exported signatures** except where written above.
- **Do not** add `"use client"` to anything under `lib/`.
- Tailwind v4: `@import "tailwindcss";` in `app/globals.css`. No `tailwind.config.js`.

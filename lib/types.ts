/**
 * lib/types.ts — the row types (CONTRACTS §4), one per table in spec §6.
 *
 * Names are PascalCase, fields are snake_case, because these come straight off
 * postgres.js with no transform. Three conventions the pool in `lib/db.ts`
 * makes true, so these types are not aspirational:
 *
 *   numeric  -> number   money is rupees as a JS number (CONTRACTS §11)
 *   int8     -> number   sim_clock.offset_ms is milliseconds, not a bigint string
 *   date     -> string   'YYYY-MM-DD'. A calendar day is not an instant, and
 *                        turning `2026-08-31` into a Date is how a Saturday
 *                        class lands on a Friday in the wrong zone.
 *
 * timestamptz stays a JS Date.
 */

// -----------------------------------------------------------------------------
// Unions (CONTRACTS §4)
// -----------------------------------------------------------------------------

export type Role = 'admin' | 'coach' | 'account_holder' | 'player' | 'prospect'
export type RateUnit = 'per_session' | 'per_month' | 'per_term' | 'per_package'
export type SessionStatus = 'scheduled' | 'cancelled' | 'completed'
export type AttendanceStatus = 'present' | 'late' | 'absent' | 'cancelled_timely'
export type ContactState = 'prospect' | 'registered' | 'engaged' | 'opted_out'
export type CoachStatus = 'added' | 'invited' | 'active' | 'ended'
export type OnboardingState = 'setup' | 'roster' | 'ready' | 'live'

export type PayUnit = 'per_session' | 'per_hour' | 'per_month'
export type Rail = 'rail1' | 'rail2'
export type MessageDirection = 'inbound' | 'outbound'
export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed'
export type ConversationCategory = 'service' | 'utility' | 'marketing' | 'authentication' | 'free_window'
export type TallyKind = 'session' | 'monthly' | 'term' | 'package' | 'adjustment'
export type PaymentStatus = 'requested' | 'confirmed' | 'failed'
export type SubjectKind = 'academy' | 'person'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped' | 'cancelled'
export type SnapshotOp = 'insert' | 'update' | 'delete'
export type FaultKind = 'send_fail' | 'number_blocked' | 'media_timeout' | 'link_expired' | 'model_error'

/** 'YYYY-MM-DD'. */
export type DateString = string
/** 'HH:MM:SS'. */
export type TimeString = string
export type Json = Record<string, unknown>

// -----------------------------------------------------------------------------
// §6.1 Tenancy and place
// -----------------------------------------------------------------------------

export type Academy = {
  id: string
  created_at: Date
  name: string
  category: string | null
  timezone: string
  cancellation_window_hours: number
  client_reminder_lead_hours: number
  morning_brief_at: TimeString
  evening_digest_at: TimeString
  rail: Rail
  upi_handle: string | null
  sender_id: string
  memory: string | null
  prompt_cache_handle: string | null
  settings: Json
  created_on: DateString
  onboarding_state: OnboardingState
}

export type Venue = {
  id: string
  created_at: Date
  academy_id: string
  name: string
  address: string | null
  notes: string | null
}

// -----------------------------------------------------------------------------
// §6.2 People
// -----------------------------------------------------------------------------

export type Person = {
  id: string
  created_at: Date
  academy_id: string
  full_name: string
  notes: string | null
  memory: string | null
  settings: Json
}

export type Contact = {
  id: string
  created_at: Date
  academy_id: string
  person_id: string
  phone_e164: string
  wa_id: string | null
  profile_name: string | null
  is_primary: boolean
  state: ContactState
  opted_out_at: Date | null
  last_inbound_at: Date | null
  role_hint: string | null
  tier_state: Json
}

export type Account = {
  id: string
  created_at: Date
  academy_id: string
  holder_person_id: string
  display_name: string | null
}

export type Player = {
  id: string
  created_at: Date
  academy_id: string
  account_id: string
  person_id: string
  active: boolean
}

export type Coach = {
  id: string
  created_at: Date
  academy_id: string
  person_id: string
  pay_amount: number | null
  pay_unit: PayUnit | null
  status: CoachStatus
  invited_at: Date | null
  onboarded_at: Date | null
  ended_on: DateString | null
}

export type AcademyAdmin = {
  id: string
  created_at: Date
  academy_id: string
  person_id: string
}

export type MemoryFact = {
  id: string
  created_at: Date
  academy_id: string
  subject_kind: SubjectKind
  subject_id: string
  fact: string
  source: string | null
  supersedes: string | null
  retired_at: Date | null
}

// -----------------------------------------------------------------------------
// §6.3 Classes and sessions
// -----------------------------------------------------------------------------

export type Class = {
  id: string
  created_at: Date
  academy_id: string
  name: string
  venue_id: string | null
  rate_amount: number | null
  rate_unit: RateUnit | null
  rate_count: number | null
  starts_on: DateString
  ends_on: DateString | null
  active: boolean
}

export type ClassSlot = {
  id: string
  created_at: Date
  academy_id: string
  class_id: string
  /** 0 = Sunday .. 6 = Saturday. */
  weekday: number
  start_time: TimeString
  end_time: TimeString
}

export type ClassCoach = {
  id: string
  created_at: Date
  academy_id: string
  class_id: string
  coach_id: string
}

export type Enrollment = {
  id: string
  created_at: Date
  academy_id: string
  class_id: string
  player_id: string
  rate_amount: number | null
  rate_unit: RateUnit | null
  rate_count: number | null
  is_trial: boolean
  started_on: DateString
  ended_on: DateString | null
}

export type Session = {
  id: string
  created_at: Date
  academy_id: string
  class_id: string
  venue_id: string | null
  starts_at: Date
  ends_at: Date
  status: SessionStatus
  cancel_reason: string | null
}

export type SessionCoach = {
  id: string
  created_at: Date
  academy_id: string
  session_id: string
  coach_id: string
  confirmed_at: Date | null
  declined_at: Date | null
  arrived_at: Date | null
  running_late: boolean
}

export type Attendance = {
  id: string
  created_at: Date
  academy_id: string
  session_id: string
  player_id: string
  status: AttendanceStatus
  note: string | null
  marked_by_coach_id: string | null
  marked_at: Date
}

// -----------------------------------------------------------------------------
// §6.4 Money
// -----------------------------------------------------------------------------

export type TallyLine = {
  id: string
  created_at: Date
  academy_id: string
  account_id: string
  player_id: string | null
  /** First day of the billing month. */
  period: DateString
  kind: TallyKind
  description: string
  /** Rupees. Negative for credits and waivers. */
  amount: number
  session_id: string | null
  reason: string | null
  approved_by: string | null
}

export type Payment = {
  id: string
  created_at: Date
  academy_id: string
  account_id: string
  amount: number
  rail: Rail
  method: string | null
  reference: string | null
  status: PaymentStatus
  requested_at: Date | null
  confirmed_at: Date | null
  confirmed_by: string | null
  evidence_url: string | null
}

// -----------------------------------------------------------------------------
// §6.5 Messaging, actions, views
// -----------------------------------------------------------------------------

/** The one global table. Never reachable through a user session (§6.5). */
export type Sender = {
  id: string
  created_at: Date
  phone_e164: string
  waba_id: string
  credentials: Json
  label: string | null
}

export type Message = {
  id: string
  created_at: Date
  academy_id: string
  contact_id: string
  sender_id: string
  direction: MessageDirection
  catalog_id: string | null
  wa_message_id: string | null
  template_name: string | null
  body: string | null
  payload: Json | null
  media_url: string | null
  status: MessageStatus
  queued_at: Date
  sent_at: Date | null
  delivered_at: Date | null
  read_at: Date | null
  failed_reason: string | null
  suppressed_reason: string | null
  cost_paise: number | null
  conversation_category: ConversationCategory | null
  in_window: boolean
  reply_to_action_id: string | null
  idempotency_key: string | null
}

/** The `action` table. Named ActionRow so `ActionPayload` (Msg) stays free. */
export type ActionRow = {
  id: string
  created_at: Date
  academy_id: string
  /** operation | steps | reply | view | menu | noop — deliberately not a fixed list (§6.5). */
  kind: string
  payload: Json
  minted_at: Date
  minted_for_contact_id: string
  expires_at: Date | null
  consumed_at: Date | null
  consumed_by_contact_id: string | null
}

/** The `view_spec` table. Named ViewSpecRow so `ViewSpec` (Web) stays free. */
export type ViewSpecRow = {
  id: string
  created_at: Date
  academy_id: string
  spec: Json
  for_person_id: string
  expires_at: Date
  minted_at: Date
}

// -----------------------------------------------------------------------------
// §6.6 Jobs, and the rest of the runtime's own tables
// -----------------------------------------------------------------------------

export type Job = {
  id: string
  created_at: Date
  /** A JobKind (lib/jobs). Kept as string here so Core stays leaf-level. */
  kind: string
  run_at: Date
  dedupe_key: string
  status: JobStatus
  attempts: number
  last_error: string | null
  payload: Json
  locked_at: Date | null
  locked_by: string | null
}

export type AuditEntry = {
  id: string
  created_at: Date
  academy_id: string
  actor_person_id: string | null
  intent: string | null
  plan: Json | null
  diff: Json | null
  undone_at: Date | null
  undo_of: string | null
}

/** Before/after images written by app.snapshot_row() (migration 0005). */
export type RowSnapshot = {
  id: string
  seq: number
  audit_id: string
  academy_id: string | null
  table_name: string
  pk: string | null
  op: SnapshotOp
  before: Json | null
  after: Json | null
  at: Date
}

// `Recipe` lived here. The feature was removed (see 0017_drop_recipe.sql): capture
// froze a plan nothing could bind, and a captured plan's only test of "good" was
// that it was expensive and did not crash.

export type Turn = {
  id: string
  created_at: Date
  academy_id: string
  contact_id: string | null
  person_id: string | null
  role_acted: string | null
  input: Json | null
  output: Json | null
  model: string | null
  prompt_tokens: number | null
  output_tokens: number | null
  latency_ms: number | null
  error: string | null
}

// -----------------------------------------------------------------------------
// §17 The emulator's substrate
// -----------------------------------------------------------------------------

export type SimClock = {
  id: string
  created_at: Date
  singleton: boolean
  offset_ms: number
  frozen_at: Date | null
}

export type SimFault = {
  id: string
  created_at: Date
  kind: FaultKind
  active: boolean
  rate: number
}

// `SimRun` used to sit here, mirroring a `sim_run` table that migration 0011 dropped.
// A row type for a table that does not exist is worse than no type: it type-checks.

// -----------------------------------------------------------------------------
// Identity (CONTRACTS §4) — resolved by lib/identity.ts
// -----------------------------------------------------------------------------

export type Identity = {
  academyId: string
  academy: Academy
  contact: Contact
  person: Person
  /** §6.2 roles compose — an array, never a scalar. */
  roles: Role[]
  coachId: string | null
  accountIds: string[]
  playerIds: string[]
  /** §18 — for SHAPING only, never gating. */
  isSolo: boolean
  /** §6.7 — a player who is not their account's holder sees no money. */
  seesMoney: boolean
}

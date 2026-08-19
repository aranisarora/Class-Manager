/**
 * lib/jobs/kinds.ts — the job vocabulary (spec §13).
 *
 * Every kind in the §13 table, plus the two moments §12.4 names that the table
 * left implicit: `coach_not_onboarded` (AD-COACH-NOT-ONBOARDED, §8.1 "if a coach
 * never onboards and has a session within 48h, the ADMIN is told") and
 * `reconcile` (AD-RECONCILE, a requested payment nobody confirmed).
 *
 * The dedupe key builders below are the §13 table verbatim. They are the whole
 * idempotency story: `job.dedupe_key` is unique, so enqueueing the same moment
 * twice is a no-op (§13 rule 1), and rescheduling cancels by prefix and
 * re-enqueues (§13 rule 4).
 */

export type JobKind =
  | 'materialize_sessions' | 'coach_day' | 'coach_coming' | 'coach_nudge'
  | 'admin_escalate_uncovered' | 'client_session_trouble' | 'client_reminder'
  | 'post_class_register' | 'register_expiry' | 'client_outcome'
  | 'admin_morning_brief' | 'admin_evening_digest'
  | 'monthly_lines' | 'month_end_tally' | 'coach_month_lines' | 'dunning'
  | 'first_contact_batch' | 'memory_curate' | 'coach_not_onboarded'
  | 'reconcile' | 'agent_task'

export const JOB_KINDS: readonly JobKind[] = [
  'materialize_sessions', 'coach_day', 'coach_coming', 'coach_nudge',
  'admin_escalate_uncovered', 'client_session_trouble', 'client_reminder',
  'post_class_register', 'register_expiry', 'client_outcome',
  'admin_morning_brief', 'admin_evening_digest',
  'monthly_lines', 'month_end_tally', 'coach_month_lines', 'dunning',
  'first_contact_batch', 'memory_curate', 'coach_not_onboarded',
  'reconcile', 'agent_task',
] as const

export function isJobKind(s: string): s is JobKind {
  return (JOB_KINDS as readonly string[]).includes(s)
}

/** §13 dedupe keys, exactly as the table writes them. */
export const dedupe = {
  materializeSessions: (classId: string, date: string) => `materialize:${classId}:${date}`,
  coachDay: (coachId: string, date: string) => `co_day:${coachId}:${date}`,
  coachComing: (sessionId: string, coachId: string) => `co_coming:${sessionId}:${coachId}`,
  coachNudge: (sessionId: string, coachId: string) => `co_nudge:${sessionId}:${coachId}`,
  adminEscalateUncovered: (sessionId: string) => `ad_uncov:${sessionId}`,
  clientSessionTrouble: (sessionId: string) => `trouble:${sessionId}`,
  clientReminder: (sessionId: string, playerId: string) => `cl_rem:${sessionId}:${playerId}`,
  postClassRegister: (sessionId: string) => `register:${sessionId}`,
  registerExpiry: (sessionId: string) => `reg_exp:${sessionId}`,
  clientOutcome: (sessionId: string, playerId: string) => `outcome:${sessionId}:${playerId}`,
  adminMorningBrief: (academyId: string, date: string) => `ad_brief:${academyId}:${date}`,
  adminEveningDigest: (academyId: string, date: string) => `ad_digest:${academyId}:${date}`,
  monthlyLines: (enrollmentId: string, period: string) => `monthly:${enrollmentId}:${period}`,
  monthEndTally: (accountId: string, period: string) => `tally:${accountId}:${period}`,
  /** The coach side of `monthlyLines`: one close per coach per month, ever. */
  coachMonthLines: (coachId: string, period: string) => `co_month:${coachId}:${period}`,
  dunning: (accountId: string, period: string, n: number) => `dun:${accountId}:${period}:${n}`,
  firstContactBatch: (academyId: string, batchN: number) => `fc:${academyId}:${batchN}`,
  memoryCurate: (subjectId: string, n: number) => `mem:${subjectId}:${n}`,
  agentTask: (academyId: string, slug: string) => `agent:${academyId}:${slug}`,
  // Not in the §13 table; §12.4 rows that still need a moment behind them.
  coachNotOnboarded: (coachId: string, date: string) => `ad_notonb:${coachId}:${date}`,
  reconcile: (paymentId: string, n: number) => `recon:${paymentId}:${n}`,
} as const

/**
 * The jobs that only make sense BEFORE a session happens: chasing the coach,
 * reminding the family, warning the admin that nobody is covering it, and
 * asking for the register. Once the session is over, every one of these is
 * either moot or actively wrong.
 */
function preSessionPrefixes(sessionId: string): string[] {
  return [
    `co_coming:${sessionId}:`,
    `co_nudge:${sessionId}:`,
    `ad_uncov:${sessionId}`,
    `trouble:${sessionId}`,
    `cl_rem:${sessionId}:`,
    `register:${sessionId}`,
    `reg_exp:${sessionId}`,
  ]
}

/**
 * §13 rule 4 — "rescheduling a session cancels its pending jobs by dedupe key
 * and re-enqueues". Every key family that hangs off one session, as prefixes
 * for `cancelByPrefix`.
 *
 * `scope` exists because the two reasons to sweep a session's ladder want
 * different answers, and conflating them cost the product every outcome message
 * it has ever tried to send:
 *
 *   - `'all'` — the session is not going to happen as planned (cancelled, moved,
 *     retimed). Nothing that hangs off it should fire, the outcome included.
 *   - `'pre-session'` — the session HAPPENED and the register has just been
 *     marked. `mark_attendance` schedules the CL-OUTCOME jobs and then sweeps the
 *     ladder in the same plan; with `outcome:` in the sweep, the same transaction
 *     inserted those jobs and immediately flipped them to `cancelled`, so no
 *     family has ever been told how their child's session went. The outcome is
 *     the one job whose moment is *after* the session, so it is the one job a
 *     completion must not cancel.
 */
export function sessionJobPrefixes(
  sessionId: string,
  scope: 'all' | 'pre-session' = 'all',
): string[] {
  const pre = preSessionPrefixes(sessionId)
  return scope === 'pre-session' ? pre : [...pre, `outcome:${sessionId}:`]
}

/**
 * §8.2 — "the timings are defaults, not constants." These are the academy-wide
 * fallbacks; `person.settings` overrides them per human, and `academy.settings`
 * sits in between. Read with `leadFor()` in util.ts, never inlined.
 */
export const TIMING_DEFAULTS = {
  coachComingLeadMinutes: 60,   // T-60 "Coming?"
  coachNudgeLeadMinutes: 30,    // T-30 one nudge, only if still silent
  adminEscalateLeadMinutes: 15, // T-15 the admin is told; the coach is not chased further
  clientReminderLeadHours: 14,  // academy.client_reminder_lead_hours is the real default
  registerExpiryHours: 2,       // CO-REGISTER expires 2h -> AD-REGISTER-MISSING
} as const

/** The `settings` jsonb keys those overrides live under (person first, then academy). */
export const TIMING_KEYS = {
  coachComingLeadMinutes: 'coach_coming_lead_minutes',
  coachNudgeLeadMinutes: 'coach_nudge_lead_minutes',
  adminEscalateLeadMinutes: 'admin_escalate_lead_minutes',
  clientReminderLeadHours: 'client_reminder_lead_hours',
  registerExpiryHours: 'register_expiry_hours',
  // The partial cuts the opt-out conversation offers ("just the bill", "stop
  // the recaps") had no structural home: the choice went into memory, the
  // scheduler read enrollments, and the promise was broken by the next
  // planned reminder (driven, month drive: "bill only is fine" → "Done…
  // I won't ask again" → nothing anywhere would have stopped the asking).
  // A truthy value on the holder person's settings mutes the category; the
  // bill and dunning are deliberately not mutable this way.
  // **These two are gone, and their absence is the fix.** They were the only
  // scoped mutes the product had: jsonb keys on `person.settings`, invented by
  // `set_timing`, readable by exactly two job handlers and by nothing the model
  // could query. So "stop messaging me about money" had nowhere to go at all,
  // and "stop reminding me" had a home only the scheduler knew about. 0032
  // migrated both to `comm_preference` rows and dropped the keys, and the send
  // path reads them for every category — which is what makes a mute a thing that
  // holds rather than a thing two handlers remember.
} as const

export type TimingName = keyof typeof TIMING_DEFAULTS

/** Rolling horizon for `materialize_sessions` (§13: "~3-week horizon"). */
export const HORIZON_DAYS = 21

/** How far ahead `planAhead()` reaches. */
export const PLAN_HORIZON_HOURS = 48

/** §9.1 rule 6 — "10, check delivery, read and block signals, then the rest in batches". */
export const FIRST_CONTACT_BATCH_SIZE = 10
export const FIRST_CONTACT_GAP_MINUTES = 45

/** §12.1 CL-DUNNING — "escalates to admin" once the ladder is spent. */
export const DUNNING_MAX = 3
export const DUNNING_INTERVAL_DAYS = 3

/** §12.4 AD-RECONCILE — a requested payment nobody confirmed. */
export const RECONCILE_MAX = 3
export const RECONCILE_INTERVAL_HOURS = 24

/** §13.1 — "a cap per academy on live tasks, and they are visible." */
export const AGENT_TASK_CAP = 25

/** Runner retry budget. `attempts` is stamped at claim time. */
export const MAX_ATTEMPTS = 3

/** A job whose run_at is this far in the past and still pending is reported (§13 rule 3). */
export const MISSED_AFTER_MINUTES = 60

/** Payload shapes. Every payload carries `academy_id` — `job` is global (§6.6). */
export type JobPayloadMap = {
  materialize_sessions: { academy_id: string; class_id: string; date: string }
  coach_day: { academy_id: string; coach_id: string; date: string }
  coach_coming: { academy_id: string; session_id: string; coach_id: string }
  coach_nudge: { academy_id: string; session_id: string; coach_id: string }
  admin_escalate_uncovered: { academy_id: string; session_id: string }
  client_session_trouble: { academy_id: string; session_id: string }
  client_reminder: { academy_id: string; session_id: string; player_id: string }
  post_class_register: { academy_id: string; session_id: string }
  register_expiry: { academy_id: string; session_id: string }
  client_outcome: { academy_id: string; session_id: string; player_id: string }
  admin_morning_brief: { academy_id: string; date: string }
  admin_evening_digest: { academy_id: string; date: string }
  monthly_lines: { academy_id: string; enrollment_id: string; period: string }
  month_end_tally: { academy_id: string; account_id: string; period: string }
  coach_month_lines: { academy_id: string; coach_id: string; period: string }
  dunning: { academy_id: string; account_id: string; period: string; n: number }
  first_contact_batch: { academy_id: string; batch_n: number }
  memory_curate: { academy_id: string; subject_kind: 'academy' | 'person'; subject_id: string; n: number }
  coach_not_onboarded: { academy_id: string; coach_id: string; date: string }
  reconcile: { academy_id: string; payment_id: string; n: number }
  agent_task: {
    academy_id: string
    instruction: string
    context?: string
    minted_by?: string
    minted_by_person_id?: string
    minted_by_contact_id?: string
    /** Roles held when the task was minted; `runAgentTask` re-checks against them (§13.1). */
    minted_roles?: string[]
    expires_at: string
    slug?: string
  }
}

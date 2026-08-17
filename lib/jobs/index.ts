/**
 * lib/jobs — scheduled work (spec §13).
 *
 * The whole surface other modules need:
 *
 *   enqueue / enqueueMany     put a moment on the queue, idempotently
 *   cancelByPrefix            §13 rule 4, rescheduling sweeps the old ladder
 *   cancelSessionJobs         the same, for one session's whole ladder
 *   runDueJobs                claim + run everything due at `app.now()`
 *   planAhead                 enqueue the next 48h for every academy
 *   liveAgentTasks / drop     §13.1, "what are you watching?"
 *   dedupe.*                  the §13 dedupe keys, so nobody re-invents one
 */

export {
  JOB_KINDS, isJobKind, dedupe, sessionJobPrefixes,
  TIMING_DEFAULTS, TIMING_KEYS, HORIZON_DAYS, PLAN_HORIZON_HOURS,
  FIRST_CONTACT_BATCH_SIZE, DUNNING_MAX, RECONCILE_MAX, AGENT_TASK_CAP,
  type JobKind, type JobPayloadMap, type TimingName,
} from './kinds'

export {
  enqueue, enqueueMany, cancelByPrefix, cancelSessionJobs,
  liveAgentTasks, dropAgentTask, watchSubjectKey, type JobSpec,
} from './enqueue'

export { HANDLERS, runDueJobs, type RunReport } from './runner'
export { planAhead, planAheadFor, listAcademyIds } from './plan-ahead'
export { JobSkip, skip } from './util'

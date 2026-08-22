/**
 * probe-sql — can this model author correct SQL against this schema?
 *
 *   npx tsx scripts/probe-sql.ts                      # the whole ladder
 *   npx tsx scripts/probe-sql.ts --tier 1,2           # only these tiers
 *   npx tsx scripts/probe-sql.ts --only roster-tonight
 *   npx tsx scripts/probe-sql.ts --keep               # leave the academy behind
 *   npx tsx scripts/probe-sql.ts --rows               # put returned rows in the report too
 *
 * WHAT THIS MEASURES, AND WHY THE OTHER PROBES CANNOT
 * -----------------------------------------------------------------------------
 * `probe-ask` asks the model what it understood, with no tools and no database —
 * it measures the ceiling, in prose. `probe-model` drives a lifecycle arc and
 * judges what the PERSON got. Neither one can answer the question this repo now
 * depends on: thirteen wrapper operations were deleted on 17 Aug 2026, and from
 * that commit onwards nearly every write in the product is SQL the model wrote
 * itself. Nothing measured whether it can.
 *
 * So this is narrow on purpose. Every case is chosen because the SQL is the hard
 * part, and what is recorded is the statements themselves plus the business
 * counted either side of the turn — not a reading of the reply.
 *
 * NOTHING HERE PASSES OR FAILS ANY MORE
 * -----------------------------------------------------------------------------
 * 25 `check` closures stood here, one per case, and this probe's own two runs on
 * 17 Aug 2026 are the argument against them:
 *
 *   The 13:09 run scored **21/25**, and one of the four failures was a grader
 *   artifact. `two-places` counted `class_coach` rows a PREVIOUS case had created
 *   and failed a turn that had written nothing and asked a good clarifying
 *   question. The fix landed three minutes after the run — so the page anybody
 *   opened reported a defect that did not exist.
 *
 *   The 13:16 run scored **12/25** having barely happened. It died at case 9 when
 *   the provider stopped answering; sixteen cases after it executed no SQL at
 *   all, and five of them PASSED — `two-places`, `ambiguous-name`,
 *   `withheld-not-absent`, `duplicate-class` — because their checks are negative
 *   and a model that does nothing satisfies them.
 *
 * A scoreboard that can fail a correct turn and pass a dead one is not a weak
 * instrument, it is a misleading one. Read the run instead: JUDGING.md.
 *
 * THE LADDER
 * -----------------------------------------------------------------------------
 * Tiers run easy to hard, and the tier is a claim about what fails first:
 *
 *   1  reads    — can it find a row at all: the FK graph, the roster view, app.now()
 *   2  reads    — aggregates, money, coverage, the academy's own timezone
 *   3  writes   — one statement: academy_id, the text-enum literals, NOT NULL columns
 *   4  writes   — several statements in one plan: ids it does not have yet, triggers
 *   5  traps    — the failures the schema doc warns about, posed so they can happen
 *
 * A tier-5 case is not "harder SQL". It is a case where the OBVIOUS SQL is wrong
 * in a way Postgres does not complain about: an UPDATE the policy silently drops,
 * a zero-row read that is a refusal rather than an absence, a count off a
 * truncated result, a second class with a name that is already taken.
 *
 * FULL VISIBILITY IS THE POINT
 * -----------------------------------------------------------------------------
 * The report records, untruncated: every statement the model sent (including the
 * ones refused before Postgres saw them), the role it ran as, rows affected, the
 * whole error text, the model's reasoning on every round, its prose, the tool
 * calls with their arguments, and the message the person actually received.
 * `lib/agent/sql-trace.ts` is what makes the write half visible — a plan carrying
 * six statements used to be one clipped line in the flight recorder.
 *
 * A case that reached the right answer over four refused statements is not the
 * same event as one that reached it in a single read, and no verdict can carry
 * that difference. The statements are the finding.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { loadEnvFiles, c } from './_env'

loadEnvFiles()

// Everything here drives the emulator. The cloud transport hard-fails at the
// credential gate (and, worse, a half-configured one sends), so a probe that
// silently took the cloud path would measure nothing and might message somebody.
process.env.TRANSPORT = 'emulator'

const { createAcademy, createTestContact, dropAcademy, inboundFromContact, worldAcademyIds } =
  await import('@/lib/seed')
const { withSession } = await import('@/lib/db')
const { HANDLERS, JobSkip, planAheadFor } = await import('@/lib/jobs')
const { msOf } = await import('@/lib/jobs/util')
const { captureSql } = await import('@/lib/agent/sql-trace')
const { captureFullTrace } = await import('@/lib/agent/turn-trace')
const { runDir, saveRun } = await import('./_capture')
type SqlRecord = import('@/lib/agent/sql-trace').SqlRecord
const { costInr } = await import('@/lib/pricing')
const { env } = await import('@/lib/env')

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i === -1) return undefined
  const f = argv[i] as string
  if (f.includes('=')) return f.slice(f.indexOf('=') + 1)
  const next = argv[i + 1]
  return next !== undefined && !next.startsWith('--') ? next : ''
}
const has = (name: string) => argv.includes(`--${name}`)

const KEEP = has('keep')
const WANT_ROWS = has('rows')
const ONLY = (flag('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const TIERS = (flag('tier') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0)

/* ------------------------------------------------------------------------- *
 * The world these cases run in
 * ------------------------------------------------------------------------- */

/**
 * A solo owner who also coaches, plus two coaches under him.
 *
 * This is the shape the product is actually sold into and the shape every
 * interesting permission question lives in: the admin sees the whole business,
 * a coach sees their own sessions and almost nothing else, and the owner is BOTH
 * — one person holding an `academy_admin` row and a `coach` row at once, which
 * is the case a schema modelling roles as a column cannot express and the case
 * this one gets wrong most often.
 */
const WORLD = {
  name: 'SQL Probe Academy',
  adminName: 'Rahul Menon',
  category: 'tennis',
  timezone: 'Asia/Kolkata',
}

type Persona = 'admin' | 'coach' | 'client'

type Case = {
  id: string
  tier: 1 | 2 | 3 | 4 | 5 | 6
  persona: Persona
  /** What the person types. */
  text: string
  /** What this case is really testing — printed in the report above the verdict. */
  probes: string
  /**
   * Rows that must exist before the case can be posed at all. Service role,
   * outside the turn, so a setup failure is a harness failure and never a finding.
   */
  setup?: string[]
  /**
   * Tap the button the plan came back on.
   *
   * A plan touching money, or anyone else, or more than one existing row, does
   * NOT run — it returns a preview with a handle, and the person's tap is the
   * commit. The statements still execute, inside a transaction that is rolled
   * back to compute the diff, so `sql-trace` records perfectly good SQL for a
   * row that was never written. The first run of `dedupe-key` failed on exactly
   * that: the model composed the charge correctly, with a dedupe key, and the
   * case reported "nobody was charged".
   *
   * Set on cases whose subject is what LANDS. Left off where the refusal or the
   * routing is the thing under test, so tapping would measure the wrong half.
   */
  tap?: boolean
  /** The finding this case re-stages, from `scripts/_findings.ts`. */
  finding?: string
}

type Q = <T = any>(sql: string) => Promise<T[]>

/* ------------------------------------------------------------------------- *
 * The ladder
 * ------------------------------------------------------------------------- */

const one = async (q: Q, sql: string): Promise<any> => (await q(sql))[0] ?? null
const num = async (q: Q, sql: string): Promise<number> => Number((await one(q, sql))?.n ?? 0)

const CASES: Case[] = [
  /* --- tier 1: can it find a row at all -------------------------------- */
  {
    id: 'classes-count',
    tier: 1,
    persona: 'admin',
    text: 'how many classes do we have running right now?',
    probes: 'the simplest possible read. `class` is one table; the only trap is counting ended ones.',
  },
  {
    id: 'roster-tonight',
    tier: 1,
    persona: 'admin',
    text: "who's due at the evening batch tonight?",
    probes:
      'app.session_roster exists precisely so this join is not rebuilt. The hand-written version is four tables ' +
      'and a date predicate, and the commonest mistake is `enrollment.active`, which does not exist.',
  },
  {
    id: 'coach-list',
    tier: 1,
    persona: 'admin',
    text: 'list my coaches and what I pay them',
    probes:
      "`select full_name from coach` is the error this schema invites — the name is on `person`. " +
      'A failure here is the one that ended with an admin being asked for a uuid over WhatsApp.',
  },

  /* --- tier 2: aggregates, money, coverage, time ------------------------ */
  {
    id: 'uncovered-week',
    tier: 2,
    persona: 'admin',
    text: 'anything next week without a coach on it?',
    probes:
      'coverage is derived, never stored, and `session_detail.coverage` already states it ' +
      "(`where coverage <> 'confirmed'`). " +
      'Rebuilt by hand the usual error is treating a declined row as coverage.',
  },
  {
    id: 'what-she-owes',
    tier: 2,
    persona: 'admin',
    text: 'what does Divya owe me?',
    probes:
      'balance = sum(tally_line) - sum(CONFIRMED payment). Counting a requested payment as money in is ' +
      'the error, and app.account_balance() exists so it need not be written at all.',
    setup: [
      // A charge and a payment that has been REQUESTED and not confirmed, so the
      // two answers differ and a wrong one is visible rather than coincidental.
      `insert into tally_line (id, academy_id, account_id, period, kind, description, amount)
         select gen_random_uuid(), a.academy_id, a.id, date_trunc('month', app.now())::date, 'monthly', 'August fees', 2400
           from account a join person p on p.id = a.holder_person_id where p.full_name = 'Divya Rao'`,
      `insert into payment (id, academy_id, account_id, amount, rail, status, requested_at)
         select gen_random_uuid(), a.academy_id, a.id, 2400, 'rail1', 'requested', app.now()
           from account a join person p on p.id = a.holder_person_id where p.full_name = 'Divya Rao'`,
    ],
  },
  {
    id: 'attendance-rate',
    tier: 2,
    persona: 'admin',
    text: 'how has attendance been this month? give me the numbers',
    probes:
      'an aggregate with a denominator. Counting rows client-side is what the row cap silently breaks; ' +
      'count()/sum() in SQL is what the read declaration asks for.',
  },
  {
    id: 'clock-discipline',
    tier: 2,
    persona: 'admin',
    text: "what's on tomorrow?",
    probes:
      'app.now() is the only clock. now()/current_date read the host and are wrong in test and subtly ' +
      'wrong in production, and nothing fails when they are used.',
  },

  /* --- tier 3: one statement -------------------------------------------- */
  {
    id: 'add-venue',
    tier: 3,
    persona: 'admin',
    text: 'we have a new court — add Green Park as a venue',
    probes:
      'the smallest write there is, and it fails without `academy_id = app.academy_id()` with an error ' +
      'that reads like a permissions problem.',
  },
  {
    id: 'add-coach',
    tier: 3,
    persona: 'admin',
    text: 'add a coach — Priya Nair, 600 a session',
    probes:
      'two rows, not one: a `person` and a `coach` pointing at it, in one transaction, with the second ' +
      "selecting back the first's id. Plus a text-enum literal for pay_unit and status.",
  },
  {
    id: 'business-rule',
    tier: 3,
    persona: 'admin',
    text: 'write this down as policy: no makeup classes on saturdays',
    probes:
      '`business_rule`, not a memory fact — and provenance owner_stated, because the owner said it. ' +
      'The `remember` tool is the wrong home and its declaration says so.',
  },

  /* --- tier 4: several statements, ids it does not have ----------------- */
  {
    id: 'create-class',
    tier: 4,
    persona: 'admin',
    text: 'new class: Morning Juniors, Mondays and Wednesdays 7 to 8am at Green Park, 900 a month, I will coach it',
    probes:
      'the deepest ordinary write in the product: a class, TWO class_slot rows, a class_coach row, each ' +
      'linking to ids that do not exist until the statement before it runs. The slots imply the sessions ' +
      'by trigger, so a model that schedules sessions by hand has misread the schema.',
    setup: [`insert into venue (id, academy_id, name) select gen_random_uuid(), id, 'Green Park' from academy on conflict do nothing`],
  },
  {
    id: 'enroll-family',
    tier: 4,
    persona: 'admin',
    text: 'new family joining the evening batch — mum is Kavita Shah on 9876500011, her son Aryan is the one playing',
    probes:
      'the longest chain in the schema: person, contact, account, person again for the child, player, ' +
      'enrollment. The parent pays and the child plays, and collapsing them into one person is the ' +
      'modelling error this table split exists to prevent.',
  },

  /* --- tier 5: the failures Postgres does not report -------------------- */
  {
    id: 'silent-update',
    finding: 'F-AX',
    tier: 5,
    persona: 'coach',
    text: 'can you change my pay to 900 a session please',
    probes:
      'THE case. A coach has no UPDATE on their own `coach` row, so the statement matches nothing and ' +
      'raises nothing. A model that reads "no error" as "it worked" tells them it is done and it is not. ' +
      'The right answer is to notice the zero rows and route it to the admin.',
  },
  {
    id: 'withheld-not-absent',
    finding: 'F-AS',
    tier: 5,
    persona: 'coach',
    text: 'what is everyone at the academy paying in fees this month?',
    probes:
      'a coach reading money gets zero rows by policy, not by absence. "Nobody owes anything" is the ' +
      'wrong sentence and it is the one an empty result invites.',
  },
  {
    id: 'duplicate-class',
    tier: 5,
    persona: 'admin',
    text: 'set up a class called Evening Batch, tuesdays 6pm, 700 a month',
    probes:
      'a class name is unique while the class is open, so this is refused rather than created. ' +
      'The failure mode is not the refusal — it is narrowing the lookup with `limit 1` until the ' +
      'duplicate is invisible, which is how one academy prompted a coach twice for a fortnight.',
  },
  {
    id: 'cancel-and-credit',
    tier: 5,
    persona: 'admin',
    // "Tonight" was the wrong noun: the class runs Mon/Wed/Fri and the first run
    // of this case landed on a Tuesday, so the model correctly answered that
    // there was no session to cancel and the case recorded a failure for it.
    // A case whose premise depends on the day it is run measures the calendar.
    text: 'court flooded — cancel the next Evening Batch session and make sure nobody pays for it',
    probes:
      'a session is never deleted; cancelled is a status with a reason. And what was billed for it is ' +
      'credited back with an offsetting tally_line, or the family pays for a session that did not happen.',
  },
  {
    id: 'end-not-delete',
    tier: 5,
    persona: 'admin',
    text: 'Anika is stopping at the end of the month — sort that out',
    probes:
      'ending is a date, never a delete. `ended_on` stops the billing from that date and keeps every ' +
      'past row attributed; a DELETE takes the history with it.',
  },

  /* --- tier 6: SQL that is hard, not merely unfamiliar ------------------- */
  {
    id: 'anti-join',
    tier: 6,
    persona: 'admin',
    text: 'which of my players have never had their attendance marked at all?',
    probes:
      'an anti-join. The natural inner join answers the opposite question and returns rows that look ' +
      'plausible, so this is wrong without being empty — the hardest kind of wrong to notice.',
  },
  {
    id: 'row-cap',
    tier: 6,
    persona: 'admin',
    text: 'how many messages have we ever sent from this business?',
    probes:
      'there are more rows than the 10,000 cap. A `select ... from message` comes back as a complete-looking ' +
      '10,000 with truncated:true, and a count read off it is simply wrong. count() in SQL is the only right answer.',
    setup: [
      /**
       * Comfortably past the cap — and dated MONTHS AGO, which is the whole
       * difference between a fixture and a contaminant.
       *
       * Stamped with `app.now()`, these 10,600 rows landed inside the 24-hour
       * send ceiling on the shared number, and the ceiling is per business. So
       * this case silently spent every later case's send budget: `scoped-mute`
       * two cases on could not deliver its confirmation, correctly reported that
       * the row was therefore unwritten, and was recorded as a model failure for
       * behaving perfectly. `two-places` then opened its reply with
       * "10,627 messages have gone out from this business" — the fixture
       * narrating itself to the admin.
       *
       * An instrument that manufactures findings is the failure this repo has
       * already written down once (see F6). Backdating costs nothing and keeps
       * the case honest: the row cap is about how many rows a SELECT returns,
       * which does not care when they were queued.
       */
      `insert into message (id, academy_id, contact_id, sender_id, direction, body, status, queued_at, sent_at, created_at)
         select gen_random_uuid(), a.id, c.id, a.sender_id, 'outbound', 'filler ' || g, 'sent',
                app.now() - interval '200 days', app.now() - interval '200 days', app.now() - interval '200 days'
           from academy a, contact c, generate_series(1, 10600) g
          where c.academy_id = a.id
          limit 10600`,
    ],
  },
  {
    id: 'sibling-discount',
    tier: 6,
    persona: 'admin',
    text: 'Anika gets a sibling discount — 1800 a month for her instead of the usual',
    probes:
      'the effective rate lives on the ENROLLMENT and defaults from the class. Changing class.rate_amount ' +
      'silently re-prices every other family, and nothing complains.',
  },
  {
    id: 'scoped-mute',
    finding: 'F-AV',
    tier: 6,
    persona: 'client',
    text: 'please stop messaging me about money, the rest is fine',
    probes:
      'a scope, not an opt-out. `comm_preference` with scope=money is what actually stops the 9am payment ' +
      'reminder; setting contact.opted_out_at instead silences the session reminders she just said were fine.',
  },
  {
    id: 'two-places',
    finding: 'F-AU',
    tier: 6,
    persona: 'admin',
    text: 'put Arjun on the Morning Juniors class as well — it is Mondays and Wednesdays 6 to 7pm',
    probes:
      'Morning Juniors would overlap Evening Batch, which Arjun already coaches, on the same weekdays at the ' +
      'same hour. The plan result names anyone put in two places at once; the question is whether the model reads it.',
    setup: [
      `insert into class (id, academy_id, name, rate_amount, rate_unit, starts_on, active)
         select gen_random_uuid(), id, 'Morning Juniors', 900, 'per_month', (app.now() - interval '1 day')::date, true
           from academy on conflict do nothing`,
    ],
  },
  {
    id: 'dedupe-key',
    tier: 6,
    persona: 'admin',
    text: 'we ran an extra session last saturday — charge everyone in the evening batch 400 for it',
    probes:
      'a recurring charge needs a dedupe_key, which is billing identity: without one a retry double-charges ' +
      'and nothing detects it. Null is for a waiver, where doing it twice is a decision.',
  },
  {
    id: 'ambiguous-name',
    tier: 6,
    persona: 'admin',
    text: 'mark Rao absent for the next session',
    probes:
      '"Rao" matches two people in this world — Divya Rao and Anika Rao. Picking one with `limit 1` is the ' +
      'failure: it is silent, it is wrong half the time, and only one of them is a player at all.',
  },
  {
    id: 'month-boundary',
    tier: 6,
    persona: 'admin',
    text: 'compare what I billed this month against last month',
    probes:
      "two periods in one answer, in the ACADEMY's timezone. `date_trunc('month', app.now())` is right; " +
      'anything reading the host clock or UTC puts the boundary in the wrong place for Asia/Kolkata.',
    setup: [
      `insert into tally_line (id, academy_id, account_id, period, kind, description, amount)
         select gen_random_uuid(), a.academy_id, a.id,
                (date_trunc('month', app.now()) - interval '1 month')::date, 'monthly', 'July fees', 2400
           from account a limit 1`,
    ],
  },

  /* --- tier 6: a rate has a date now (0043) ----------------------------- */
  {
    id: 'rate-as-of',
    finding: 'F-CJ',
    tier: 6,
    persona: 'admin',
    text: 'that one-to-one I put up last month — what was it costing before I raised it?',
    probes:
      'the whole point of app.rate_on(enrollment_id, date). The hand-written version is a lateral ' +
      'over rate_period ordered by effective_from with a date predicate, TWICE — enrolment then ' +
      'class — because amount, unit and count each fall back independently. Reading ' +
      'enrollment.rate_amount answers today and is the defect F-CJ is: it told the owner one number ' +
      'and the parent who pays the other, four minutes apart.',
    setup: [
      `insert into class (academy_id, name, rate_amount, rate_unit, starts_on)
         select (select id from academy limit 1), 'Anika one-to-one', 900, 'per_session',
                (app.now() at time zone 'Asia/Kolkata')::date - 30
          where not exists (select 1 from class where name = 'Anika one-to-one')`,
      `insert into enrollment (academy_id, class_id, player_id, started_on)
         select cl.academy_id, cl.id, (select id from player limit 1),
                (app.now() at time zone 'Asia/Kolkata')::date - 30
           from class cl
          where cl.name = 'Anika one-to-one'
            and not exists (select 1 from enrollment e where e.class_id = cl.id)`,
      `insert into session (academy_id, class_id, starts_at, ends_at, status)
         select cl.academy_id, cl.id, app.now() - interval '7 days',
                app.now() - interval '7 days' + interval '1 hour', 'scheduled'
           from class cl
          where cl.name = 'Anika one-to-one'
            and not exists (select 1 from session s where s.class_id = cl.id)`,
      // The raise. The trigger turns this ordinary update into the second period,
      // which is the whole thing the case is asking the model to find.
      `update class set rate_amount = 1100 where name = 'Anika one-to-one'`,
    ],
  },
  {
    id: 'pay-for-a-closed-month',
    finding: 'F-CL',
    tier: 6,
    persona: 'admin',
    text: 'what did I actually owe the coach for last month?',
    probes:
      'coach_ledger if the month has closed, and coach_pay.amount_then if it has not — never ' +
      'amount_for_session, which multiplies by the rate they are on NOW. A raise typed mid-month ' +
      'used to reprice everything already worked, so the two columns are deliberately both there ' +
      'and deliberately named apart.',
    setup: [
      // The coach has been on 500 for a quarter. Written directly because the
      // world was made this morning and a trigger can only date a change from
      // when it happens — in a real business this row is months old.
      `insert into rate_period (academy_id, coach_id, amount, unit, effective_from)
         select c.academy_id, c.id, 500, 'per_session',
                (app.now() at time zone 'Asia/Kolkata')::date - 90
           from coach c
          where c.pay_amount is null
            and not exists (select 1 from rate_period rp where rp.coach_id = c.id)
          limit 1
         on conflict do nothing`,
      `insert into session (academy_id, class_id, starts_at, ends_at, status)
         select cl.academy_id, cl.id, app.now() - interval '35 days',
                app.now() - interval '35 days' + interval '1 hour', 'scheduled'
           from class cl limit 1`,
      `insert into session_coach (academy_id, session_id, coach_id, confirmed_at)
         select s.academy_id, s.id, (select coach_id from rate_period where coach_id is not null limit 1),
                s.starts_at - interval '1 day'
           from session s
          where s.starts_at < app.now() - interval '30 days'
            and not exists (select 1 from session_coach sc where sc.session_id = s.id)
          limit 1`,
      // And the raise, typed today, long after that session was worked.
      `update coach set pay_amount = 800, pay_unit = 'per_session'
         where id = (select coach_id from rate_period where coach_id is not null limit 1)`,
    ],
  },
  {
    id: 'pack-remaining-after-a-resize',
    finding: 'F-CM',
    tier: 6,
    persona: 'admin',
    text: 'how many classes has she got left on her pack?',
    probes:
      "the size is on the tally_line that OPENED the pack — that pack's own rate_count — not on the " +
      'class, which may have been restructured since. Reading class.rate_count silently resizes ' +
      'every pack already sold, in whichever direction the owner moved it.',
    setup: [
      `insert into class (academy_id, name, rate_amount, rate_unit, rate_count, starts_on)
         select (select id from academy limit 1), 'Ten-class pack', 8000, 'per_package', 10,
                (app.now() at time zone 'Asia/Kolkata')::date - 60
          where not exists (select 1 from class where name = 'Ten-class pack')`,
      `insert into enrollment (academy_id, class_id, player_id, started_on)
         select cl.academy_id, cl.id, (select id from player limit 1),
                (app.now() at time zone 'Asia/Kolkata')::date - 60
           from class cl
          where cl.name = 'Ten-class pack'
            and not exists (select 1 from enrollment e where e.class_id = cl.id)`,
      // The line that OPENED the pack, carrying the size it was sold at.
      `insert into tally_line (academy_id, account_id, player_id, class_id, period, kind,
                               description, amount, rate_amount, rate_unit, rate_count)
         select cl.academy_id, (select account_id from player where account_id is not null limit 1),
                (select id from player limit 1), cl.id,
                date_trunc('month', app.now() at time zone 'Asia/Kolkata')::date, 'package',
                'Ten-class pack', 8000, 8000, 'per_package', 10
           from class cl
          where cl.name = 'Ten-class pack'
            and not exists (select 1 from tally_line t where t.class_id = cl.id and t.kind = 'package')`,
      // The restructure, after the pack was sold. Four now, ten then.
      `update class set rate_count = 4 where name = 'Ten-class pack'`,
    ],
  },
]

/* ------------------------------------------------------------------------- *
 * The world, photographed
 *
 * 25 hand-written `check` closures stood here, one per case, each deciding
 * pass/fail from a query written by whoever wrote the case. They are gone for the
 * reason the rest of the instrument's checks are gone, and this probe's own
 * report is the clearest evidence for it:
 *
 *   The 17 Aug ladder run scored 21/25. One of the four failures — `two-places` —
 *   was a grader artifact: the check counted `class_coach` rows a PREVIOUS case
 *   had created, and failed a turn that had written nothing and asked a good
 *   clarifying question. It was fixed three minutes after the run, which means
 *   the page anybody opened showed a defect that did not exist.
 *
 *   And the run in the other direction is worse. A later run collapsed at case 9
 *   — the provider stopped answering and sixteen cases executed no SQL at all —
 *   and it scored **12/25**, because five checks are negative and a model that
 *   does nothing passes them. `two-places`, `ambiguous-name`,
 *   `withheld-not-absent` and `duplicate-class` all passed a turn that never
 *   happened.
 *
 * A scoreboard that can fail a correct turn and pass a dead one is not a weak
 * instrument. What replaces it is the whole business, counted either side of
 * every case, and the statements underneath.
 * ------------------------------------------------------------------------- */

const lit = (s: string) => `'${String(s).replace(/'/g, "''")}'`

/**
 * Every count worth having, in one round trip.
 *
 * Deliberately the same shape `probe-model` takes, so a reader moving between the
 * two reads the same numbers in the same order — and so `scripts/report.mjs` can
 * diff either without knowing which instrument produced it.
 */
async function worldSnapshot(q: Q): Promise<Record<string, unknown>> {
  const rows = await q(`select
      (select count(*)::int from venue)                                          as venues,
      (select count(*)::int from class where active)                             as classes,
      (select count(*)::int from class_slot)                                     as slots,
      (select count(*)::int from coach)                                          as coaches,
      (select count(*)::int from coach where status = 'active')                  as coaches_active,
      (select count(*)::int from person)                                         as people,
      (select count(*)::int from account)                                        as accounts,
      (select count(*)::int from player where active)                            as players,
      (select count(*)::int from enrollment where ended_on is null)              as enrolled,
      (select count(*)::int from session)                                        as sessions,
      (select count(*)::int from session where status = 'cancelled')             as cancelled,
      (select count(*)::int from attendance)                                     as attendance,
      (select count(*)::int from tally_line)                                     as tally_lines,
      (select coalesce(sum(amount), 0)::text from tally_line)                    as billed,
      (select count(*)::int from payment)                                        as payments,
      (select count(*)::int from business_rule)                                  as rules,
      (select count(*)::int from comm_preference where released_at is null)      as mutes,
      (select count(*)::int from contact where opted_out_at is not null)         as opted_out,
      (select count(*)::int from pending_request where resolved_at is null)      as pending,
      (select count(*)::int from job where status = 'pending')                   as jobs_pending,
      (select count(*)::int from message where direction = 'outbound'
         and suppressed_reason is null)                                          as sent,
      (select count(*)::int from message where suppressed_reason is not null)    as suppressed`)
  return (rows[0] ?? {}) as Record<string, unknown>
}

/** Which counts moved. Only those — an unchanged number is not evidence of anything. */
function worldDiff(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  if (!before || !after) return []
  const out: string[] = []
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (String(before[k] ?? '') === String(after[k] ?? '')) continue
    out.push(`${k} ${before[k] ?? '—'} → ${after[k] ?? '—'}`)
  }
  return out
}

/* ------------------------------------------------------------------------- *
 * Run
 * ------------------------------------------------------------------------- */

type Result = {
  id: string
  tier: number
  persona: Persona
  text: string
  probes: string
  /** Null when the case ran. A stack when the harness or the turn died. */
  error: string | null
  finding?: string
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  sql: SqlRecord[]
  rounds: Round[]
  reply: string | null
  buttons: string[]
  tokens: { prompt: number; cached: number; output: number }
  ms: number
}

type Round = { round: number; name: string; args?: unknown; result?: unknown; error?: string; reasoning?: string }

async function main(): Promise<void> {
  const picked = CASES.filter((k) => (ONLY.length ? ONLY.includes(k.id) : true)).filter((k) =>
    TIERS.length ? TIERS.includes(k.tier) : true,
  )
  if (!picked.length) {
    console.error('no cases matched')
    process.exit(2)
  }

  console.log(
    c.bold(`\n  probe-sql — ${picked.length} case${picked.length === 1 ? '' : 's'} on ${env.MODEL_MAIN}\n`),
  )

  const made = await createAcademy({ ...WORLD })
  const q: Q = async <T = any>(sql: string) =>
    withSession({ role: 'service', academyId: made.academyId }, async (tx) => (await tx.unsafe(sql)) as unknown as T[])

  await worldAcademyIds({ refresh: true })

  /**
   * The world every case runs against, built by the HARNESS rather than by the
   * model. A ladder whose tier-4 case depends on tier-3 having worked is a ladder
   * that reports one failure five times, and the whole point of a tier is to say
   * which rung broke.
   */
  /**
   * Explicit numbers, from a block nothing else uses.
   *
   * `createTestContact` picks a free number by scanning ITS OWN academy for the
   * `+9199…` range, while every tenant shares one sender and §10.1 resolves an
   * inbound by the pair (from, sender). In a business one second old that scan
   * sees no contacts and hands out `+919900000001` — which a dev academy on this
   * database already owns. Both contacts then match, the inbound resolves to
   * neither, and the case records an empty reply as though the model had gone
   * quiet. Derived from the academy id so two probe runs never collide either.
   */
  const digits = made.academyId.replace(/\D/g, '').padEnd(9, '0')
  const phone = (n: number) => `+9194${digits.slice(0, 7)}${n}`

  const coach = await createTestContact({
    academyId: made.academyId, name: 'Arjun Shetty', role: 'coach', phone: phone(1),
  })
  const client = await createTestContact({
    academyId: made.academyId, name: 'Divya Rao', role: 'client', phone: phone(2),
  })
  await worldAcademyIds({ refresh: true })

  // The number must be free across the WHOLE world, not just this academy — that
  // is the failure above, and it deserves to stop the run rather than be reported
  // as a quiet model twelve cases later.
  for (const p of [phone(1), phone(2)]) {
    const [clash] = await withSession({ role: 'service', academyId: made.academyId }, async (tx) =>
      (await tx`select count(*)::int as n from contact where phone_e164 = ${p}`) as unknown as { n: number }[],
    )
    if ((clash?.n ?? 0) > 1) {
      await dropAcademy(made.academyId).catch(() => {})
      console.error(c.red(`\n  ${p} resolves to more than one contact — refusing to drive.\n`))
      process.exit(3)
    }
  }

  // A running business: one class, its weekly slot, a coach on it, one child
  // enrolled. The slot materialises the sessions by trigger (0033), so nothing
  // here schedules a session by hand either.
  await q(`insert into venue (id, academy_id, name) values (gen_random_uuid(), '${made.academyId}'::uuid, 'Central Court')`)
  await q(`
    insert into class (id, academy_id, name, venue_id, rate_amount, rate_unit, starts_on, active)
    select gen_random_uuid(), '${made.academyId}'::uuid, 'Evening Batch', v.id, 2400, 'per_month',
           (app.now() - interval '30 days')::date, true
      from venue v where v.name = 'Central Court'`)
  await q(`
    insert into class_slot (id, academy_id, class_id, weekday, start_time, end_time)
    select gen_random_uuid(), '${made.academyId}'::uuid, c.id, w.d, time '18:00', time '19:00'
      from class c, (values (1),(3),(5)) as w(d) where c.name = 'Evening Batch'`)
  await q(`
    insert into class_coach (academy_id, class_id, coach_id)
    select '${made.academyId}'::uuid, c.id, co.id
      from class c, coach co join person p on p.id = co.person_id
     where c.name = 'Evening Batch' and p.full_name = 'Arjun Shetty'
    on conflict do nothing`)
  // The child plays, the mother pays — the split the schema exists for.
  await q(`
    insert into person (id, academy_id, full_name) values (gen_random_uuid(), '${made.academyId}'::uuid, 'Anika Rao')`)
  await q(`
    insert into player (id, academy_id, account_id, person_id, active)
    select gen_random_uuid(), '${made.academyId}'::uuid, a.id, kid.id, true
      from account a join person mum on mum.id = a.holder_person_id,
           person kid
     where mum.full_name = 'Divya Rao' and kid.full_name = 'Anika Rao'`)
  await q(`
    insert into enrollment (id, academy_id, class_id, player_id, started_on)
    select gen_random_uuid(), '${made.academyId}'::uuid, c.id, pl.id, (app.now() - interval '30 days')::date
      from class c, player pl join person p on p.id = pl.person_id
     where c.name = 'Evening Batch' and p.full_name = 'Anika Rao'`)
  await q(`update academy set onboarding_state = 'live' where id = '${made.academyId}'::uuid`)

  /**
   * Run what is due FOR THIS ACADEMY, and nothing else.
   *
   * A slot does not create sessions inline — 0033's trigger enqueues
   * `materialize_sessions` and the handler does the work — so a harness that
   * never drains has a class with weekly times and no sessions, and every case
   * about a roster, coverage or tonight is then posed against an empty world.
   * The first run of this probe did exactly that and the roster case passed by
   * answering "nothing on the books", which was true and measured nothing.
   *
   * `runDueJobs` claims globally (`job` has no tenant column), so calling it here
   * would run every other business's queue from inside this probe. This is the
   * runner's own claim with §6.6's tenant predicate added.
   */
  async function drainOwnJobs(): Promise<string[]> {
    const log: string[] = []
    await planAheadFor(made.academyId).catch((e) => log.push(`plan failed: ${(e as Error)?.message}`))
    for (let round = 0; round < 8; round++) {
      const batch = await q<any>(`
        with due as (
          select id from job
           where status = 'pending' and run_at <= app.now()
             and payload->>'academy_id' = '${made.academyId}'
           order by run_at asc, created_at asc
           limit 50
           for update skip locked
        )
        update job j
           set status = 'running', attempts = j.attempts + 1, locked_at = app.now(), locked_by = 'probe-sql'
          from due
         where j.id = due.id
        returning j.*`)
      if (batch.length === 0) break
      batch.sort((a: any, b: any) => msOf(a.run_at) - msOf(b.run_at))
      for (const job of batch) {
        const handler = (HANDLERS as any)[job.kind]
        if (!handler) {
          await q(`update job set status = 'failed', last_error = 'no handler', locked_at = null where id = '${job.id}'::uuid`)
          log.push(`FAIL ${job.kind} — no handler`)
          continue
        }
        try {
          await handler(job)
          await q(`update job set status = 'done', last_error = null, locked_at = null where id = '${job.id}'::uuid`)
          log.push(`ran ${job.kind}`)
        } catch (e) {
          const skipped = e instanceof JobSkip
          const reason = String((e as any)?.reason ?? (e as Error)?.message ?? e).slice(0, 200).replace(/'/g, "''")
          await q(
            `update job set status = '${skipped ? 'skipped' : 'failed'}', last_error = '${reason}', locked_at = null
              where id = '${job.id}'::uuid`,
          )
          log.push(`${skipped ? 'skip' : 'FAIL'} ${job.kind} — ${reason}`)
        }
      }
    }
    return log
  }

  /** The tenant's own clock, which is the clock every `created_at` is stamped on. */
  const domainNow = async (): Promise<string> => {
    const row = await one(q, `select app.now()::text as at`)
    return row?.at ? new Date(String(row.at)).toISOString() : new Date().toISOString()
  }

  /**
   * Tap whatever the turn left waiting, exactly as the person would.
   *
   * A gated plan is minted as an action carrying its own steps, and only a tap
   * commits it — no call the model can make will. Finding it by kind rather than
   * by button title keeps this working when the wording changes, which it does
   * every run.
   */
  async function tapStagedPlan(contactId: string): Promise<string | null> {
    const rows = await q<{ id: string }>(`
      select a.id::text as id from action a
       where a.minted_for_contact_id = '${contactId}'::uuid
         and a.consumed_at is null
         and a.kind in ('steps', 'operation')
         and (a.expires_at is null or a.expires_at > app.now())
       order by a.minted_at desc limit 1`)
    const id = rows[0]?.id
    if (!id) return null
    try {
      await inboundFromContact({ contactId, actionId: id })
      return id
    } catch {
      return null
    }
  }

  await drainOwnJobs()

  const contacts: Record<Persona, string> = {
    admin: made.adminContactId,
    coach: coach.contactId,
    client: client.contactId,
  }
  const sessions = await num(q, `select count(*) n from session`)
  console.log(
    c.dim(
      `  world: ${made.academyId}  ·  1 class, ${sessions} sessions, 2 coaches (owner + Arjun), 1 family\n`,
    ),
  )

  const results: Result[] = []

  for (const kase of picked) {
    process.stdout.write(`  ${c.dim(`t${kase.tier}`)} ${kase.id.padEnd(22)} `)
    const startedAt = Date.now()

    for (const s of kase.setup ?? []) {
      try {
        await q(s)
      } catch (e) {
        console.log(c.red(`setup failed: ${(e as Error).message}`))
      }
    }

    /**
     * The cursor is DOMAIN time, not host time.
     *
     * `created_at` defaults to the tenant's own clock (0027), which a driven
     * world moves independently of the wall clock. A host-time cursor against
     * domain-time stamps selects the wrong window in both directions — the first
     * run of this probe attributed one case's reply to the two cases after it,
     * so `scoped-mute` was graded on the anti-join case's answer.
     */
    const before = await domainNow()
    /**
     * The world as the SETUP left it, not as the previous case left it.
     *
     * Taken after `setup` runs, so a case that plants ten thousand filler messages
     * to test the row cap does not report them as something the model did. The old
     * `two-places` check failed exactly this way in the other direction — it
     * counted rows a previous case had created and failed a turn that wrote
     * nothing.
     */
    const worldBefore = await worldSnapshot(q).catch(() => null)
    let captured: SqlRecord[] = []
    let threw: string | null = null
    try {
      const { sql } = await captureSql({ rows: true }, () =>
        captureFullTrace(async () => {
        await inboundFromContact({ contactId: contacts[kase.persona], text: kase.text })
        // Tapped by DEFAULT, because a person does. Where the model correctly
        // refused, or routed to somebody else, or asked a question, there is
        // nothing minted for this contact and this is a no-op — so the cases
        // testing a refusal need no opt-out, and a case where the model staged
        // something it should not have is caught rather than excused.
        if (kase.tap !== false) await tapStagedPlan(contacts[kase.persona])
        }),
      )
      captured = sql
    } catch (e) {
      threw = e instanceof Error ? (e.stack ?? e.message) : String(e)
    }
    /**
     * EVERY turn in the window, oldest first — not the newest one.
     *
     * Tapping a staged plan opens a second turn, so `order by created_at desc
     * limit 1` returned the TAP's trace and threw away the trace of the turn
     * that actually composed the SQL. The report then showed one round called
     * `tap:steps` and no reasoning at all, for a case whose whole interest is
     * how the model got there. Full visibility means both turns.
     */
    const turnRows = await q<any>(
      `select tool_calls, prompt_tokens, cached_tokens, output_tokens, error
         from turn where created_at >= ${lit(before)}::timestamptz order by created_at asc`,
    )
    const rounds: Round[] = turnRows.flatMap((t) =>
      Array.isArray(t?.tool_calls)
        ? (t.tool_calls as Round[])
        : typeof t?.tool_calls === 'string'
          ? safeParse(t.tool_calls)
          : [],
    )
    const turn = {
      prompt_tokens: turnRows.reduce((a, t) => a + Number(t?.prompt_tokens ?? 0), 0),
      cached_tokens: turnRows.reduce((a, t) => a + Number(t?.cached_tokens ?? 0), 0),
      output_tokens: turnRows.reduce((a, t) => a + Number(t?.output_tokens ?? 0), 0),
    }

    const outbound = await q<{ body: string; payload: any }>(
      `select body, payload from message
        where direction = 'outbound' and created_at >= ${lit(before)}::timestamptz
        order by created_at asc`,
    )
    const buttons = outbound.flatMap((m) =>
      Array.isArray(m.payload?.buttons) ? m.payload.buttons.map((b: any) => String(b?.title ?? '')) : [],
    )

    /**
     * Drained AFTER the reply is collected and BEFORE the check.
     *
     * After, because the standing jobs send their own messages and folding those
     * into `reply` would credit the model with sentences it did not write.
     * Before, because a check asking whether the sessions materialised is asking
     * about work the trigger enqueued and the handler does — and a plan is not
     * finished until its consequences have run.
     */
    await drainOwnJobs().catch(() => [])

    const after = await worldSnapshot(q).catch(() => null)

    results.push({
      id: kase.id,
      tier: kase.tier,
      persona: kase.persona,
      text: kase.text,
      probes: kase.probes,
      error: threw,
      ...(kase.finding ? { finding: kase.finding } : {}),
      before: worldBefore,
      after,
      sql: captured,
      rounds,
      reply: outbound.map((m) => m.body).join('\n---\n') || null,
      buttons,
      tokens: {
        prompt: Number(turn?.prompt_tokens ?? 0),
        cached: Number(turn?.cached_tokens ?? 0),
        output: Number(turn?.output_tokens ?? 0),
      },
      ms: Date.now() - startedAt,
    })

    const reads = captured.filter((r) => r.kind === 'read').length
    const writes = captured.filter((r) => r.kind !== 'read').length
    const errs = captured.filter((r) => r.error).length
    const moved = worldDiff(worldBefore, after)
    console.log(
      `      ${c.dim(`${reads}r ${writes}w ${errs ? c.red(`${errs} sql err`) : '0 err'} · ${Math.round((Date.now() - startedAt) / 1000)}s`)}` +
        (moved.length ? `  ${c.dim(moved.join(', '))}` : c.dim('  nothing moved')),
    )
    if (threw) console.log(`       ${c.red(threw.split('\n')[0] ?? '')}`)
  }

  await report(results, made.academyId)

  if (!KEEP) await dropAcademy(made.academyId).catch(() => {})
  else console.log(c.dim(`\n  kept: ${made.academyId}`))

  const allSql = results.flatMap((r) => r.sql)
  const errored = results.filter((r) => r.error)
  console.log(
    `\n  ${c.bold(`${results.length} cases`)} · ${allSql.length} statements ` +
      `(${allSql.filter((x) => x.kind === 'read').length}r ${allSql.filter((x) => x.kind !== 'read').length}w, ` +
      `${allSql.filter((x) => x.error).length} refused)` +
      (errored.length ? c.red(`  ·  ${errored.length} case(s) died: ${errored.map((f) => f.id).join(', ')}`) : ''),
  )
  console.log(c.dim('  Nothing above is a verdict. Read the run, then write one — JUDGING.md\n'))
  process.exit(0)
}

function safeParse(s: string): Round[] {
  try {
    const p = JSON.parse(s)
    return Array.isArray(p) ? p : []
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------------- *
 * The report — everything, untruncated
 * ------------------------------------------------------------------------- */

async function report(results: Result[], academyId: string): Promise<void> {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')

  /**
   * One run, one directory — the ladder included.
   *
   * `.probe/sql/` used to be this probe's own corner, dated by its own stamp, so a
   * ladder and the record of the same run sorted into two different places and
   * nothing said they were the same run. The corner is gone; `ladder.json` and
   * `ladder.md` are written INSIDE the run directory, which is the only thing that
   * carries a run's identity.
   */
  const dir = await runDir('sql')
  const jsonPath = join(dir, 'ladder.json')
  const mdPath = join(dir, 'ladder.md')

  await writeFile(jsonPath, JSON.stringify({ model: env.MODEL_MAIN, academyId, results }, null, 2))

  /**
   * The same record every other instrument writes, so the one reader can open it.
   * `scripts/report.mjs` finds a run by sorting `.probe/runs/`, and this record is
   * what it opens. The ladder files above sit beside it because the per-case ladder
   * is genuinely this probe's own question — but they are the same run, so they are
   * in the same directory.
   *
   * **This probe still carries per-case `check` closures, and they are the last
   * deterministic verdicts left in the instrument.** They are deliberately NOT
   * copied into the record: the record holds evidence, and a verdict written into
   * it is a verdict the next reader cannot argue with. Judge it from JUDGING.md
   * like anything else, and read `verdict`/`why` in `ladder.json` as one earlier
   * reader's opinion rather than as a result.
   */
  await saveRun(dir, {
    suite: 'sql',
    model: env.MODEL_MAIN,
    startedAt: new Date().toISOString(),
    academyId,
    note:
      'The SQL ladder. Since the wrapper operations were deleted, nearly every write in this ' +
      'product is SQL the model composed itself; this drives one sentence per case and records ' +
      'every statement byte for byte, the refused ones included.',
    turns: results.map((r, i) => ({
      n: i + 1,
      id: r.id,
      at: new Date().toISOString(),
      who: r.persona,
      persona: r.persona,
      say: r.text,
      rounds: r.rounds ?? [],
      sql: r.sql ?? [],
      messages: [],
      reply: r.reply,
      buttons: r.buttons ?? [],
      tapped: null,
      jobs: [],
      tokens: { prompt: r.tokens?.prompt ?? 0, cached: r.tokens?.cached ?? 0, output: r.tokens?.output ?? 0 },
      inr: costInr(env.MODEL_MAIN, r.tokens?.prompt ?? 0, r.tokens?.cached ?? 0, r.tokens?.output ?? 0),
      ms: r.ms,
      turnIds: [],
      wrote: (r.sql ?? []).filter((x) => x.kind !== 'read' && (x.rowCount ?? 0) > 0).length,
      sent: r.reply ? 1 : 0,
      /**
       * Empty, and correctly so rather than for want of looking. The snapshot
       * trigger (0005) fires only while `app.audit_id` is set, which is what
       * `beginAudit` does around a PLAN. This suite runs model-authored SQL
       * directly, outside a plan, so no audit entry opens and no image is taken.
       * The world either side is what this suite records instead — `beforeTap`
       * and `afterTap` below, which no other instrument fills.
       */
      changed: [],
      error: r.error,
      beforeTap: r.before,
      afterTap: r.after,
    })),
    world: (results[results.length - 1]?.after ?? {}) as Record<string, unknown>,
  })
  console.log(`\n  record: ${dir}/record.json`)

  const L: string[] = []
  L.push(`# probe-sql — ${stamp}`)
  L.push('')
  L.push(`Model \`${env.MODEL_MAIN}\`. Academy \`${academyId}\`.`)
  L.push('')
  L.push(
    'Every statement below is what the MODEL sent, byte for byte, including the ones refused before ' +
      'Postgres saw them. `rows` is rows returned for a read and rows AFFECTED for a write — and a write ' +
      'affecting zero rows raised nothing, which is the failure this product cares about most.',
  )
  L.push('')

  L.push('## The ladder')
  L.push('')
  L.push('| case | tier | who | reads | writes | refused | what moved |')
  L.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const reads = r.sql.filter((s) => s.kind === 'read').length
    const writes = r.sql.filter((s) => s.kind !== 'read').length
    const errs = r.sql.filter((s) => s.error).length
    const moved = worldDiff(r.before, r.after)
    const last = r.error ? String(r.error).split('\n')[0] : ''
    L.push(
      `| ${r.id} | ${r.tier} | ${r.persona} | ${reads} | ${writes} | ${errs} | ` +
        `${r.error ? `**died:** ${last}` : moved.join(', ') || 'nothing'} |`,
    )
  }
  L.push('')

  for (const r of results) {
    L.push('---')
    L.push('')
    L.push(`## ${r.id} · tier ${r.tier} · ${r.persona}`)
    L.push('')
    L.push(`**They said:** ${r.text}`)
    L.push('')
    L.push(`**What this probes:** ${r.probes}`)
    L.push('')
    const movedHere = worldDiff(r.before, r.after)
    L.push(`**What moved in the database:** ${movedHere.length ? movedHere.join(', ') : 'nothing'}`)
    L.push('')
    if (r.error) {
      L.push(`**This case died:** \`${String(r.error).split('\n')[0]}\``)
      L.push('')
    }
    L.push(
      `${Math.round(r.ms / 1000)}s · ${r.tokens.prompt} prompt (${r.tokens.cached} cached) · ` +
        `${r.tokens.output} output · ₹${(costInr(env.MODEL_MAIN, r.tokens.prompt, r.tokens.cached, r.tokens.output) ?? 0).toFixed(3)}`,
    )
    L.push('')

    L.push(`### SQL the model wrote (${r.sql.length})`)
    L.push('')
    if (!r.sql.length) L.push('_None. It wrote no SQL at all on this turn._')
    for (const [i, s] of r.sql.entries()) {
      const head =
        s.error
          ? `**${i + 1}. ${s.kind}** — ❌ refused, as \`${s.role}\``
          : `**${i + 1}. ${s.kind}** — ${s.rowCount} row${s.rowCount === 1 ? '' : 's'}${s.truncated ? ' **(TRUNCATED at the cap)**' : ''}, as \`${s.role}\`, ${s.ms}ms`
      L.push(head + (s.kind !== 'read' && s.rowCount === 0 ? ' — **matched nothing and raised nothing**' : ''))
      L.push('')
      L.push('```sql')
      L.push(s.sql)
      L.push('```')
      if (s.error) {
        L.push('')
        L.push('```')
        L.push(s.error)
        L.push('```')
      }
      if (s.rows?.length) {
        L.push('')
        L.push('```json')
        L.push(JSON.stringify(s.rows, null, 2))
        L.push('```')
      }
      L.push('')
    }

    L.push('### The turn, round by round')
    L.push('')
    if (!r.rounds.length) L.push('_No trace recorded._')
    for (const t of r.rounds) {
      L.push(`**round ${t.round} · \`${t.name}\`**`)
      L.push('')
      if (t.reasoning) {
        L.push('<details><summary>reasoning</summary>')
        L.push('')
        L.push('```')
        L.push(String(t.reasoning))
        L.push('```')
        L.push('')
        L.push('</details>')
        L.push('')
      }
      if (t.args !== undefined) {
        L.push('```json')
        L.push(typeof t.args === 'string' ? t.args : JSON.stringify(t.args, null, 2))
        L.push('```')
        L.push('')
      }
      if (t.error) {
        L.push(`error: \`${t.error}\``)
        L.push('')
      }
      if (t.result !== undefined) {
        L.push('<details><summary>result</summary>')
        L.push('')
        L.push('```json')
        L.push(typeof t.result === 'string' ? t.result : JSON.stringify(t.result, null, 2))
        L.push('```')
        L.push('')
        L.push('</details>')
        L.push('')
      }
    }

    L.push('### What the person got')
    L.push('')
    L.push(r.reply ? '```\n' + r.reply + '\n```' : '_Nothing was sent._')
    if (r.buttons.length) {
      L.push('')
      L.push(`Buttons: ${r.buttons.map((b) => `\`[${b}]\``).join(' ')}`)
    }
    L.push('')
  }

  await writeFile(mdPath, L.join('\n'))
  console.log(c.dim(`\n  ${mdPath}\n  ${jsonPath}`))
}

await main()

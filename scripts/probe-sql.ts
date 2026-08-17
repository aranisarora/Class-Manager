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
 * part, the checks are SQL against the real rows rather than a reading of the
 * reply, and a case fails on what is TRUE IN THE DATABASE afterwards — not on
 * whether the sentence sounded right.
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
 * A case that passes its check while the model wrote four wrong statements first
 * is a case that PASSED AND SHOULD BE READ. The verdict is not the finding; the
 * statements are.
 */
import { mkdir, writeFile } from 'node:fs/promises'
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
  /**
   * The verdict. Runs as the service role AFTER the turn and decides on what is
   * true in the database. Return `null` to pass, or the sentence that is wrong.
   */
  check: (q: Q) => Promise<string | null>
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
    check: async (q) => {
      const reads = await modelReads(q)
      if (!reads.some((r) => /\bfrom\s+class\b/i.test(r))) return 'never read the class table'
      return null
    },
  },
  {
    id: 'roster-tonight',
    tier: 1,
    persona: 'admin',
    text: "who's due at the evening batch tonight?",
    probes:
      'app.session_roster exists precisely so this join is not rebuilt. The hand-written version is four tables ' +
      'and a date predicate, and the commonest mistake is `enrollment.active`, which does not exist.',
    check: async (q) => {
      const reads = await modelReads(q)
      if (reads.some((r) => /enrollment\s*\.\s*active|\ba\.active\b/i.test(r)))
        return 'referenced enrollment.active, which is not a column'
      /**
       * Only demanded when there IS a session tonight.
       *
       * The class runs Mon/Wed/Fri, so on a Tuesday the correct answer — given
       * in full, with the next session named — needs no roster at all, and the
       * model was marked down for not fetching one. Same defect as the
       * cancel-and-credit case: a premise that depends on the day the probe runs
       * measures the calendar. So the roster is required only once the world
       * says there is something to be on.
       */
      const tonight = await num(
        q,
        `select count(*) n from session s join class c on c.id = s.class_id
          where c.name ilike 'evening batch'
            and (s.starts_at at time zone 'Asia/Kolkata')::date = (app.now() at time zone 'Asia/Kolkata')::date`,
      )
      if (tonight === 0) return null
      if (!reads.some((r) => /session_roster/i.test(r)))
        return 'rebuilt the roster join by hand instead of using app.session_roster'
      return null
    },
  },
  {
    id: 'coach-list',
    tier: 1,
    persona: 'admin',
    text: 'list my coaches and what I pay them',
    probes:
      "`select full_name from coach` is the error this schema invites — the name is on `person`. " +
      'A failure here is the one that ended with an admin being asked for a uuid over WhatsApp.',
    check: async (q) => {
      const reads = await modelReads(q)
      const badJoin = reads.some((r) => /from\s+coach\b/i.test(r) && !/join\s+person|person\s+p/i.test(r) && /full_name/i.test(r))
      if (badJoin) return 'selected full_name from coach without joining person'
      const errs = await sqlErrors(q)
      if (errs.some((e) => /column .*full_name.* does not exist/i.test(e))) return 'hit "full_name does not exist" on coach'
      return null
    },
  },

  /* --- tier 2: aggregates, money, coverage, time ------------------------ */
  {
    id: 'uncovered-week',
    tier: 2,
    persona: 'admin',
    text: 'anything next week without a coach on it?',
    probes:
      'coverage is derived, never stored, and `uncovered_session` already computes it. ' +
      'Rebuilt by hand the usual error is treating a declined row as coverage.',
    check: async (q) => {
      const reads = await modelReads(q)
      const usedView = reads.some((r) => /uncovered_session|session_coverage|session_is_covered/i.test(r))
      const handRolled = reads.some((r) => /session_coach/i.test(r) && !/declined_at/i.test(r))
      if (!usedView && handRolled) return 'hand-rolled coverage and ignored declined_at'
      return null
    },
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
    check: async (q) => {
      const reads = await modelReads(q)
      const touchedPayment = reads.some((r) => /\bpayment\b/i.test(r))
      const usedHelper = reads.some((r) => /account_balance/i.test(r))
      if (!touchedPayment && !usedHelper) return 'never looked at payment, so any balance it stated was a charge total'
      const naive = reads.some(
        (r) => /\bpayment\b/i.test(r) && !/confirmed/i.test(r) && !/account_balance/i.test(r),
      )
      if (naive) return "summed payment without filtering status='confirmed'"
      return null
    },
  },
  {
    id: 'attendance-rate',
    tier: 2,
    persona: 'admin',
    text: 'how has attendance been this month? give me the numbers',
    probes:
      'an aggregate with a denominator. Counting rows client-side is what the row cap silently breaks; ' +
      'count()/sum() in SQL is what the read declaration asks for.',
    check: async (q) => {
      const reads = await modelReads(q)
      if (!reads.some((r) => /count\s*\(|sum\s*\(|avg\s*\(/i.test(r)))
        return 'never aggregated in SQL — counted rows itself'
      return null
    },
  },
  {
    id: 'clock-discipline',
    tier: 2,
    persona: 'admin',
    text: "what's on tomorrow?",
    probes:
      'app.now() is the only clock. now()/current_date read the host and are wrong in test and subtly ' +
      'wrong in production, and nothing fails when they are used.',
    check: async (q) => {
      const reads = await modelReads(q)
      const wallClock = reads.filter((r) => /\bnow\s*\(\s*\)/i.test(r.replace(/app\s*\.\s*now\s*\(\s*\)/gi, '')) || /current_date|current_timestamp/i.test(r))
      if (wallClock.length) return `used the wall clock instead of app.now(): ${wallClock[0]?.slice(0, 160)}`
      return null
    },
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
    check: async (q) => {
      const n = await num(q, `select count(*) n from venue where name ilike '%green park%'`)
      if (n === 0) return 'no venue row was written'
      return null
    },
  },
  {
    id: 'add-coach',
    tier: 3,
    persona: 'admin',
    text: 'add a coach — Priya Nair, 600 a session',
    probes:
      'two rows, not one: a `person` and a `coach` pointing at it, in one transaction, with the second ' +
      "selecting back the first's id. Plus a text-enum literal for pay_unit and status.",
    check: async (q) => {
      const row = await one(
        q,
        `select c.status, c.pay_amount, c.pay_unit from coach c join person p on p.id = c.person_id
          where p.full_name ilike '%priya%'`,
      )
      if (!row) return 'no coach row for Priya'
      if (Number(row.pay_amount) !== 600) return `pay_amount is ${row.pay_amount}, not 600`
      if (row.pay_unit !== 'per_session') return `pay_unit is '${row.pay_unit}', not 'per_session'`
      return null
    },
  },
  {
    id: 'business-rule',
    tier: 3,
    persona: 'admin',
    text: 'write this down as policy: no makeup classes on saturdays',
    probes:
      '`business_rule`, not a memory fact — and provenance owner_stated, because the owner said it. ' +
      'The `remember` tool is the wrong home and its declaration says so.',
    check: async (q) => {
      const row = await one(q, `select provenance, statement from business_rule where statement ilike '%saturday%'`)
      if (!row) return 'no business_rule row was written'
      if (row.provenance !== 'owner_stated') return `provenance is '${row.provenance}', not 'owner_stated'`
      return null
    },
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
    check: async (q) => {
      const cls = await one(q, `select id, rate_amount, rate_unit from class where name ilike '%morning junior%'`)
      if (!cls) return 'no class row'
      if (Number(cls.rate_amount) !== 900) return `rate_amount is ${cls.rate_amount}, not 900`
      if (cls.rate_unit !== 'per_month') return `rate_unit is '${cls.rate_unit}', not 'per_month'`
      const slots = await q<{ weekday: number; start_time: string }>(
        `select weekday, start_time::text from class_slot where class_id = '${cls.id}'::uuid order by weekday`,
      )
      if (slots.length !== 2) return `${slots.length} class_slot rows, expected 2 (Mon and Wed)`
      const days = slots.map((s) => Number(s.weekday)).sort()
      if (days[0] !== 1 || days[1] !== 3) return `weekdays are ${days.join(',')}, expected 1,3 (Mon,Wed)`
      const coaches = await num(q, `select count(*) n from class_coach where class_id = '${cls.id}'::uuid`)
      if (coaches === 0) return 'nobody assigned to coach it'
      const sessions = await num(q, `select count(*) n from session where class_id = '${cls.id}'::uuid`)
      if (sessions === 0) return 'the slots did not materialise sessions — the trigger did not fire'
      return null
    },
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
    check: async (q) => {
      const mum = await one(q, `select id from person where full_name ilike '%kavita%'`)
      if (!mum) return 'no person row for the mother'
      const kid = await one(q, `select id from person where full_name ilike '%aryan%'`)
      if (!kid) return 'no person row for the child'
      if (mum.id === kid.id) return 'the mother and the child are the same person row'
      const acct = await one(q, `select id from account where holder_person_id = '${mum.id}'::uuid`)
      if (!acct) return 'no account held by the mother'
      const player = await one(q, `select id, account_id from player where person_id = '${kid.id}'::uuid`)
      if (!player) return 'no player row for the child'
      if (player.account_id !== acct.id) return "the child's player row is not billed to the mother's account"
      const enr = await num(q, `select count(*) n from enrollment where player_id = '${player.id}'::uuid`)
      if (enr === 0) return 'the child was not enrolled in anything'
      const contact = await num(q, `select count(*) n from contact where phone_e164 like '%9876500011%'`)
      if (contact === 0) return 'her number was not recorded as a contact'
      return null
    },
  },

  /* --- tier 5: the failures Postgres does not report -------------------- */
  {
    id: 'silent-update',
    tier: 5,
    persona: 'coach',
    text: 'can you change my pay to 900 a session please',
    probes:
      'THE case. A coach has no UPDATE on their own `coach` row, so the statement matches nothing and ' +
      'raises nothing. A model that reads "no error" as "it worked" tells them it is done and it is not. ' +
      'The right answer is to notice the zero rows and route it to the admin.',
    check: async (q) => {
      const row = await one(
        q,
        `select c.pay_amount from coach c join person p on p.id = c.person_id where p.full_name ilike '%arjun%'`,
      )
      if (row && Number(row.pay_amount) === 900) return null // if the policy let it through, that is a real answer
      /**
       * Graded on the ROUTE, not on the wording.
       *
       * The first version of this check grepped the coach's reply for "done" and
       * failed a turn that had behaved perfectly — the sentence was "I'll let you
       * know once it's done", which is a promise about the future and the exact
       * opposite of a false claim. A tripwire that cannot tell those apart is
       * measuring English, so this measures what the product can actually see:
       * a write that did not land must reach the person who can make it land.
       */
      const toAdmin = await num(
        q,
        `select count(*) n from message m
           join contact ct on ct.id = m.contact_id
           join academy_admin aa on aa.person_id = ct.person_id
          where m.direction = 'outbound' and m.body ilike '%900%'`,
      )
      if (toAdmin === 0)
        return `pay is still ${row?.pay_amount ?? 'unset'} and nothing was routed to the admin — the change died silently`
      return null
    },
  },
  {
    id: 'withheld-not-absent',
    tier: 5,
    persona: 'coach',
    text: 'what is everyone at the academy paying in fees this month?',
    probes:
      'a coach reading money gets zero rows by policy, not by absence. "Nobody owes anything" is the ' +
      'wrong sentence and it is the one an empty result invites.',
    check: async (q) => {
      const said = (await lastReplyTo(q, 'Arjun Shetty')) ?? ''
      if (/\b(no (one|body) (owes|is paying)|nothing is owed|there are no fees|no fees)\b/i.test(said))
        return `reported a policy refusal as an absence: "${said.slice(0, 200)}"`
      return null
    },
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
    check: async (q) => {
      const n = await num(
        q,
        `select count(*) n from class where name ilike 'evening batch' and active and ends_on is null`,
      )
      if (n > 1) return `${n} open classes named "Evening Batch" — the unique index did not hold`
      return null
    },
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
    check: async (q) => {
      const deleted = await num(q, `select count(*) n from session where status = 'cancelled'`)
      if (deleted === 0) return 'no session was cancelled'
      const gone = await num(
        q,
        `select count(*) n from session s join class c on c.id = s.class_id where c.name ilike '%evening batch%'`,
      )
      if (gone === 0) return 'the sessions were deleted rather than cancelled'
      return null
    },
  },
  {
    id: 'end-not-delete',
    tier: 5,
    persona: 'admin',
    text: 'Anika is stopping at the end of the month — sort that out',
    probes:
      'ending is a date, never a delete. `ended_on` stops the billing from that date and keeps every ' +
      'past row attributed; a DELETE takes the history with it.',
    check: async (q) => {
      const kid = await one(q, `select id from person where full_name ilike '%anika%'`)
      if (!kid) return 'harness: no Anika in this world'
      const player = await one(q, `select id, active from player where person_id = '${kid.id}'::uuid`)
      if (!player) return 'the player row was deleted rather than ended'
      const enr = await one(
        q,
        `select ended_on from enrollment where player_id = '${player.id}'::uuid order by created_at desc limit 1`,
      )
      if (!enr) return 'the enrollment row was deleted rather than ended'
      if (!enr.ended_on) return 'nothing was ended — ended_on is still null'
      return null
    },
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
    check: async (q) => {
      const reads = await modelReads(q)
      /**
       * Three spellings, all correct, and the first version of this check only
       * accepted two. `left join attendance … group by … count(a.id)` returns 0
       * for a player with no marks and is a perfectly good anti-join — arguably
       * the better answer, because it also says who has FEW marks rather than
       * only who has none. What is actually being tested is whether the rows
       * with no match survive the join, so the check asks for that.
       */
      const antiJoin = reads.some(
        (r) =>
          /not\s+exists/i.test(r) ||
          /not\s+in\s*\(/i.test(r) ||
          (/left\s+(outer\s+)?join/i.test(r) && /(is\s+null|count\s*\()/i.test(r)) ||
          // A correlated scalar subquery — `(select count(*) from attendance a
          // where a.player_id = pl.id)` — is the fourth correct spelling and the
          // one this check rejected twice. It is arguably the cleanest of them:
          // rows with no match come back as 0 rather than as NULL.
          /\(\s*select\s+count\s*\([^)]*\)\s*from[\s\S]{0,120}?where[\s\S]{0,120}?=/i.test(r),
      )
      if (!antiJoin) return 'no anti-join anywhere — an inner join answers the opposite question'
      return null
    },
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
    check: async (q) => {
      const truncated = CURRENT.filter((r) => r.truncated)
      const aggregated = (await modelReads(q)).some((r) => /count\s*\(/i.test(r))
      if (!aggregated) return 'never used count() — any number it stated came off a capped result'
      const said = (await lastReplyTo(q, 'Rahul Menon')) ?? ''
      if (/\b10,?000\b/.test(said) && truncated.length)
        return `stated 10,000 — the row cap read back as a fact: "${said.slice(0, 160)}"`
      return null
    },
  },
  {
    id: 'sibling-discount',
    tier: 6,
    persona: 'admin',
    text: 'Anika gets a sibling discount — 1800 a month for her instead of the usual',
    probes:
      'the effective rate lives on the ENROLLMENT and defaults from the class. Changing class.rate_amount ' +
      'silently re-prices every other family, and nothing complains.',
    check: async (q) => {
      const cls = await one(q, `select rate_amount from class where name ilike 'evening batch'`)
      if (Number(cls?.rate_amount) !== 2400)
        return `changed the CLASS rate to ${cls?.rate_amount} — every family in the batch was re-priced`
      const enr = await one(
        q,
        `select e.rate_amount from enrollment e
           join player pl on pl.id = e.player_id join person p on p.id = pl.person_id
          where p.full_name ilike '%anika%' order by e.created_at desc limit 1`,
      )
      if (Number(enr?.rate_amount) !== 1800) return `the enrollment rate is ${enr?.rate_amount}, not 1800`
      return null
    },
  },
  {
    id: 'scoped-mute',
    tier: 6,
    persona: 'client',
    text: 'please stop messaging me about money, the rest is fine',
    probes:
      'a scope, not an opt-out. `comm_preference` with scope=money is what actually stops the 9am payment ' +
      'reminder; setting contact.opted_out_at instead silences the session reminders she just said were fine.',
    check: async (q) => {
      const optedOut = await num(q, `select count(*) n from contact where opted_out_at is not null`)
      if (optedOut > 0) return 'opted her out of the whole channel — she asked for one scope'
      const pref = await one(q, `select scope from comm_preference where released_at is null`)
      if (!pref) return 'no comm_preference row — nothing will actually stop'
      if (pref.scope !== 'money') return `scope is '${pref.scope}', not 'money'`
      return null
    },
  },
  {
    id: 'two-places',
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
    check: async (q) => {
      const said = (await lastReplyTo(q, 'Rahul Menon')) ?? ''
      /**
       * Graded on what THIS turn wrote, not on what exists.
       *
       * The earlier `create-class` case builds Morning Juniors with the owner
       * coaching it, so `class_coach` for that class is already non-empty before
       * this case is posed. The first version counted those rows and demanded the
       * reply explain a clash the model had not caused — failing a turn that had
       * refused to act and explained, correctly, that the only Arjun on the books
       * is a coach with no player record and that enrolling him would start a
       * charge on his own account. A check confounded by a previous case's state
       * is a check that reports the arc rather than the turn.
       */
      const addedNow = CURRENT.some(
        (s) => s.kind !== 'read' && (s.rowCount ?? 0) > 0 && /insert\s+into\s+class_coach/i.test(s.sql),
      )
      if (!addedNow) return null // refusing, or asking first, are both defensible
      // Having done it, the one thing that is not defensible is doing it silently.
      if (!/(clash|same time|overlap|two places|double|conflict|already)/i.test(said))
        return `put him in two places at once and said nothing about it: "${said.slice(0, 200)}"`
      return null
    },
  },
  {
    id: 'dedupe-key',
    tier: 6,
    persona: 'admin',
    text: 'we ran an extra session last saturday — charge everyone in the evening batch 400 for it',
    probes:
      'a recurring charge needs a dedupe_key, which is billing identity: without one a retry double-charges ' +
      'and nothing detects it. Null is for a waiver, where doing it twice is a decision.',
    check: async (q) => {
      const lines = await q<{ dedupe_key: string | null; amount: string }>(
        `select dedupe_key, amount from tally_line where amount = 400`,
      )
      if (!lines.length) return 'nobody was charged'
      if (lines.every((l) => !l.dedupe_key)) return 'charged with no dedupe_key — a retry double-charges'
      return null
    },
  },
  {
    id: 'ambiguous-name',
    tier: 6,
    persona: 'admin',
    text: 'mark Rao absent for the next session',
    probes:
      '"Rao" matches two people in this world — Divya Rao and Anika Rao. Picking one with `limit 1` is the ' +
      'failure: it is silent, it is wrong half the time, and only one of them is a player at all.',
    check: async (q) => {
      const marked = await q<{ status: string }>(`select status from attendance`)
      const said = (await lastReplyTo(q, 'Rahul Menon')) ?? ''
      if (marked.length > 0 && !/which|Anika|clarif|two|both/i.test(said))
        return `marked attendance off an ambiguous name without asking: "${said.slice(0, 200)}"`
      return null
    },
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
    check: async (q) => {
      const reads = await modelReads(q)
      if (!reads.some((r) => /tally_line/i.test(r))) return 'never read tally_line'
      const naive = reads.some(
        (r) => /tally_line/i.test(r) && /\bnow\s*\(\s*\)/i.test(r.replace(/app\s*\.\s*now\s*\(\s*\)/gi, '')),
      )
      if (naive) return 'used the wall clock for the month boundary'
      return null
    },
  },
]

/* ------------------------------------------------------------------------- *
 * What the model actually sent — read back per case
 * ------------------------------------------------------------------------- */

let CURRENT: SqlRecord[] = []

const modelReads = async (_q: Q): Promise<string[]> =>
  CURRENT.filter((r) => r.kind === 'read').map((r) => r.sql)
const modelWrites = (): string[] => CURRENT.filter((r) => r.kind === 'write').map((r) => r.sql)
const sqlErrors = async (_q: Q): Promise<string[]> =>
  CURRENT.filter((r) => r.error).map((r) => String(r.error))

async function lastReplyTo(q: Q, name: string): Promise<string | null> {
  const rows = await q<{ body: string }>(
    `select m.body from message m
       join contact ct on ct.id = m.contact_id
       join person p on p.id = ct.person_id
      where m.direction = 'outbound' and p.full_name ilike ${lit(`%${name}%`)}
      order by m.created_at desc limit 1`,
  )
  return rows[0]?.body ?? null
}

const lit = (s: string) => `'${String(s).replace(/'/g, "''")}'`

/* ------------------------------------------------------------------------- *
 * Run
 * ------------------------------------------------------------------------- */

type Result = {
  id: string
  tier: number
  persona: Persona
  text: string
  probes: string
  verdict: 'pass' | 'fail' | 'error'
  why: string | null
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
    let captured: SqlRecord[] = []
    let threw: string | null = null
    try {
      const { sql } = await captureSql({ rows: WANT_ROWS }, async () => {
        await inboundFromContact({ contactId: contacts[kase.persona], text: kase.text })
        // Tapped by DEFAULT, because a person does. Where the model correctly
        // refused, or routed to somebody else, or asked a question, there is
        // nothing minted for this contact and this is a no-op — so the cases
        // testing a refusal need no opt-out, and a case where the model staged
        // something it should not have is caught rather than excused.
        if (kase.tap !== false) await tapStagedPlan(contacts[kase.persona])
      })
      captured = sql
    } catch (e) {
      threw = e instanceof Error ? (e.stack ?? e.message) : String(e)
    }
    CURRENT = captured

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

    let why: string | null = null
    let verdict: Result['verdict'] = 'pass'
    if (threw) {
      verdict = 'error'
      why = threw
    } else {
      try {
        why = await kase.check(q)
        verdict = why ? 'fail' : 'pass'
      } catch (e) {
        verdict = 'error'
        why = `check threw: ${(e as Error).message}`
      }
    }

    results.push({
      id: kase.id,
      tier: kase.tier,
      persona: kase.persona,
      text: kase.text,
      probes: kase.probes,
      verdict,
      why,
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
    const mark =
      verdict === 'pass' ? c.green('pass') : verdict === 'fail' ? c.red('FAIL') : c.yellow('err ')
    console.log(
      `${mark}  ${c.dim(`${reads}r ${writes}w ${errs ? c.red(`${errs} sql err`) : '0 err'} · ${Math.round((Date.now() - startedAt) / 1000)}s`)}`,
    )
    if (why) console.log(`       ${c.red(why.split('\n')[0] ?? '')}`)
  }

  await report(results, made.academyId)

  if (!KEEP) await dropAcademy(made.academyId).catch(() => {})
  else console.log(c.dim(`\n  kept: ${made.academyId}`))

  const failed = results.filter((r) => r.verdict !== 'pass')
  console.log(
    `\n  ${c.bold(`${results.length - failed.length}/${results.length} pass`)}` +
      (failed.length ? c.red(`  ·  ${failed.map((f) => f.id).join(', ')}`) : ''),
  )
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
  await mkdir('.probe/sql', { recursive: true })
  const jsonPath = `.probe/sql/${stamp}.json`
  const mdPath = `.probe/sql/${stamp}.md`

  await writeFile(jsonPath, JSON.stringify({ model: env.MODEL_MAIN, academyId, results }, null, 2))

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

  const pass = results.filter((r) => r.verdict === 'pass').length
  L.push(`## Verdict: ${pass}/${results.length}`)
  L.push('')
  L.push('| | case | tier | who | reads | writes | sql errors | verdict |')
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const r of results) {
    const reads = r.sql.filter((s) => s.kind === 'read').length
    const writes = r.sql.filter((s) => s.kind !== 'read').length
    const errs = r.sql.filter((s) => s.error).length
    const mark = r.verdict === 'pass' ? '✅' : r.verdict === 'fail' ? '❌' : '⚠️'
    L.push(`| ${mark} | ${r.id} | ${r.tier} | ${r.persona} | ${reads} | ${writes} | ${errs} | ${r.why ?? 'ok'} |`)
  }
  L.push('')

  for (const r of results) {
    L.push('---')
    L.push('')
    L.push(`## ${r.verdict === 'pass' ? '✅' : r.verdict === 'fail' ? '❌' : '⚠️'} ${r.id} · tier ${r.tier} · ${r.persona}`)
    L.push('')
    L.push(`**They said:** ${r.text}`)
    L.push('')
    L.push(`**What this probes:** ${r.probes}`)
    L.push('')
    L.push(`**Verdict:** ${r.verdict === 'pass' ? 'pass' : `**${r.why}**`}`)
    L.push('')
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

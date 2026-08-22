/**
 * check-rate-history — does money get priced at the rate in force when it was earned?
 *
 *   npx tsx scripts/check-rate-history.ts
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * F-CJ, F-CL and F-CM are one defect wearing three hats: a mutable money term
 * read at BILLING time instead of at the time it was earned. Raising a price
 * today reaches backwards.
 *
 *   F-CJ  an unmarked register bills at today's rate, not the one the session
 *         ran at. `unmarked_billable_session` answered 1100.00 for a class that
 *         ran at 900.
 *   F-CL  `coachMonthLines` freezes a closed month reading `coach.pay_amount` at
 *         CLOSE time, so a raise typed mid-month reprices the whole month.
 *   F-CM  `packRemaining` sizes a pack already sold by the class's CURRENT
 *         rate_count, so restructuring packs resizes them retroactively.
 *
 * The probe cannot reproduce any of this cheaply: its cases accumulate state, so
 * `--case st-price-raise` runs against an academy nobody built, and a full suite
 * re-run is a fresh stochastic sample at ~Rs 9 that stopped at 24 of 32 last
 * time. This asserts the shape instead, deterministically, in a couple of
 * seconds, for nothing.
 *
 * It is written to FAIL on main and pass on the fix. Block 0 exists so that
 * failure reads as named missing machinery rather than as a crash on the first
 * select.
 *
 * THE BOUNDARIES IT CROSSES ON PURPOSE
 * -----------------------------------------------------------------------------
 * Block B works a session in the PREVIOUS month and closes it in this one, and
 * block E bills a per_term period a quarter back. Those two are the month and
 * quarter marks — the moments money is actually asked for, and the ones a
 * seven-day drive can never reach.
 *
 * WHAT IT DOES TO THE DATABASE
 * -----------------------------------------------------------------------------
 * Builds its own scratch tenant, writes into it, and deletes it in a `finally`.
 * It touches no other academy, sends nothing, and runs no model.
 */
import { loadEnvFiles } from './_env'

loadEnvFiles()

const { withSession } = await import('@/lib/db')
const { newId } = await import('@/lib/ids')

let failures = 0
function assert(label: string, ok: boolean, detail?: unknown): void {
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) {
    failures++
    if (detail !== undefined) console.log(`        got: ${JSON.stringify(detail)}`)
  }
}
function section(title: string): void {
  console.log(`\n  ${title}`)
}

const academyId = newId()
const ctx = { role: 'service', academyId } as const
const A = `'${academyId}'::uuid`
const TODAY = `(app.now() at time zone 'Asia/Kolkata')::date`

/** Whichever sender this database actually has (check-attendance-bills.ts:50). */
const SENDER = await withSession({ role: 'service', academyId: null as unknown as string }, async (tx) =>
  String(((await tx.unsafe(`select id from sender order by created_at limit 1`)) as unknown as any[])[0]?.id ?? ''),
).catch(() => '')
if (!SENDER) {
  console.error('  no sender row in this database — seed one before running this check')
  process.exit(2)
}

const rows = async (sql: string): Promise<Record<string, any>[]> =>
  withSession(ctx, async (tx) => (await tx.unsafe(sql)) as unknown as Record<string, any>[])
const one = async (sql: string): Promise<Record<string, any>> => (await rows(sql))[0] ?? {}
const exec = async (sql: string): Promise<void> => {
  await withSession(ctx, async (tx) => {
    await tx.unsafe(sql)
  })
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

try {
  /* ======================================================================= *
   * BLOCK 0 — the mechanism is present
   *
   * On main every one of these is absent, and without this block the first
   * `select` from rate_period throws and the run reports one crash instead of
   * six named gaps.
   * ======================================================================= */
  section('0 · the mechanism')
  const m = await one(`
    select to_regclass('public.rate_period')            as tbl,
           to_regclass('public.rate_history')           as hist,
           to_regprocedure('app.rate_on(uuid,date)')    as rate_on,
           to_regprocedure('app.pay_on(uuid,date)')     as pay_on,
           to_regprocedure('app.today(uuid)')           as today,
           (select count(*) from information_schema.columns
             where table_name = 'tally_line'
               and column_name in ('rate_amount','rate_unit','rate_count'))::int as tally_cols,
           (select count(*) from information_schema.columns
             where table_name = 'coach_pay' and column_name = 'amount_then')::int as coach_then,
           (select count(*) from information_schema.columns
             where table_name = 'class_roster' and column_name = 'next_rate_from')::int as roster_next`)
  assert('rate_period exists', m.tbl !== null, m.tbl)
  assert('rate_history exists', m.hist !== null, m.hist)
  assert('app.rate_on(uuid,date) exists', m.rate_on !== null, m.rate_on)
  assert('app.pay_on(uuid,date) exists', m.pay_on !== null, m.pay_on)
  assert('app.today(uuid) exists', m.today !== null, m.today)
  assert('tally_line carries the three rate columns', Number(m.tally_cols) === 3, m.tally_cols)
  assert('coach_pay carries amount_then', Number(m.coach_then) === 1, m.coach_then)
  assert('class_roster carries next_rate_from', Number(m.roster_next) === 1, m.roster_next)
  if (m.tbl === null) {
    console.log('\n  rate_period is absent — the rest of this check has nothing to ask.')
    process.exit(1)
  }

  /* -- the world ----------------------------------------------------------- */
  await exec(`insert into academy (id, name, sender_id, onboarding_state, timezone)
              values (${A}, 'Rate History Scratch', '${SENDER}'::uuid, 'live', 'Asia/Kolkata')`)
  const ravi = await one(`insert into person (academy_id, full_name) values (${A}, 'Ravi Menon') returning id`)
  await exec(`insert into academy_admin (academy_id, person_id) values (${A}, '${ravi.id}'::uuid)`)
  await exec(`insert into contact (academy_id, person_id, phone_e164)
              values (${A}, '${ravi.id}'::uuid, '+919999000041')`)
  // Created sixty days ago on purpose: block B works a session thirty-five days
  // back, and a coach who did not exist then has no rate in force then either.
  // The trigger dates an opening rate from the subject's own beginning.
  const coach = await one(`insert into coach (academy_id, person_id, status, pay_amount, pay_unit, created_at)
                           values (${A}, '${ravi.id}'::uuid, 'active', 500, 'per_session',
                                   app.now() - interval '60 days') returning id`)
  const venue = await one(`insert into venue (academy_id, name) values (${A}, 'Lake Club') returning id`)

  const meera = await one(`insert into person (academy_id, full_name) values (${A}, 'Meera Iyer') returning id`)
  const account = await one(`insert into account (academy_id, holder_person_id)
                             values (${A}, '${meera.id}'::uuid) returning id`)
  const aarav = await one(`insert into person (academy_id, full_name) values (${A}, 'Aarav Iyer') returning id`)
  const player = await one(`insert into player (academy_id, person_id, account_id, active)
                            values (${A}, '${aarav.id}'::uuid, '${account.id}'::uuid, true) returning id`)

  // Per SESSION at 900, started 30 days ago — the F-CJ shape exactly.
  const cls = await one(`insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on)
                         values (${A}, 'Aarav one-to-one', '${venue.id}'::uuid, 900, 'per_session',
                                 ${TODAY} - 30) returning id`)
  await exec(`insert into class_coach (academy_id, class_id, coach_id)
              values (${A}, '${cls.id}'::uuid, '${coach.id}'::uuid)`)
  const enr = await one(`insert into enrollment (academy_id, class_id, player_id, started_on)
                         values (${A}, '${cls.id}'::uuid, '${player.id}'::uuid, ${TODAY} - 30) returning id`)
  // Over, and it happened. Seven days ago, so it is unambiguously before the raise.
  const s1 = await one(`insert into session (academy_id, class_id, starts_at, ends_at, status)
                        values (${A}, '${cls.id}'::uuid, app.now() - interval '7 days',
                                app.now() - interval '7 days' + interval '1 hour', 'scheduled') returning id`)

  /* ======================================================================= *
   * BLOCK A — F-CJ. A session bills at the rate it RAN at.
   * ======================================================================= */
  section('A · the family rate (F-CJ)')

  const backfilled = await one(`select count(*)::int as n from rate_period where class_id = '${cls.id}'::uuid`)
  assert('creating the class recorded its opening rate', Number(backfilled.n) === 1, backfilled)

  // The raise. This is the ordinary write — the one the model composes itself —
  // and the trigger is what turns it into history.
  await exec(`update class set rate_amount = 1100 where id = '${cls.id}'::uuid`)

  const periods = await one(`select count(*)::int as n from rate_period where class_id = '${cls.id}'::uuid`)
  assert('the raise wrote a second period, from an ordinary UPDATE', Number(periods.n) === 2, periods)

  const asOf = await one(`
    select (app.rate_on('${enr.id}'::uuid, ${TODAY} - 7)).amount as then_amount,
           (app.rate_on('${enr.id}'::uuid, ${TODAY})).amount     as now_amount`)
  assert('the rate seven days ago is still 900', num(asOf.then_amount) === 900, asOf)
  assert('the rate today is 1100', num(asOf.now_amount) === 1100, asOf)

  const owed = await one(`select unbilled_amount::text as amount
                            from unmarked_billable_session where session_id = '${s1.id}'::uuid`)
  assert(
    'unmarked_billable_session prices the unmarked register at 900, not 1100',
    num(owed.amount) === 900,
    owed,
  )

  // The real write path: build mark_attendance's plan and run its steps, which
  // is what a coach marking the register actually executes.
  const { OPERATIONS } = await import('@/lib/agent/operations')
  const steps = await OPERATIONS.mark_attendance.build(
    ctx as any,
    { session_id: s1.id, entries: [{ player_id: player.id, status: 'present' }], retro_timely_player_ids: [] },
    { coachId: coach.id } as any,
  )
  for (const step of steps as any[]) {
    if (typeof step.write === 'string') await exec(step.write)
  }

  const line = await one(`select amount::text as amount, rate_amount::text as rate_amount, rate_unit
                            from tally_line where session_id = '${s1.id}'::uuid`)
  assert('marking the register bills 900 — the rate it ran at', num(line.amount) === 900, line)
  assert('and the line froze the rate it was computed at', num(line.rate_amount) === 900, line)
  assert('and the unit with it', line.rate_unit === 'per_session', line)

  await exec(`update class set rate_amount = 1300 where id = '${cls.id}'::uuid`)
  const frozen = await one(`select amount::text as amount from tally_line where session_id = '${s1.id}'::uuid`)
  assert('a later raise cannot reprice a written line', num(frozen.amount) === 900, frozen)

  // The two-level fallback, with a date under BOTH sides. A resolver written
  // one-level passes everything above this and fails here.
  await exec(`update enrollment set rate_amount = 750 where id = '${enr.id}'::uuid`)
  const twoLevel = await one(`
    select (app.rate_on('${enr.id}'::uuid, ${TODAY} - 7)).amount as then_amount,
           (app.rate_on('${enr.id}'::uuid, ${TODAY})).amount     as now_amount`)
  assert(
    'before the enrolment stated its own rate, the class still answers 900',
    num(twoLevel.then_amount) === 900,
    twoLevel,
  )
  assert('today the enrolment overrides at 750', num(twoLevel.now_amount) === 750, twoLevel)

  /* ======================================================================= *
   * BLOCK B - F-CL. A closed month pays the rate in force while it was being
   * worked, not the rate on the morning it closed. The session is worked in the
   * PREVIOUS month and closed in this one, which is the boundary a seven-day
   * drive can never reach.
   * ======================================================================= */
  section('B - coach pay across a month boundary (F-CL)')

  const worked = await one(`insert into session (academy_id, class_id, starts_at, ends_at, status)
                            values (${A}, '${cls.id}'::uuid, app.now() - interval '35 days',
                                    app.now() - interval '35 days' + interval '1 hour', 'scheduled')
                            returning id`)
  await exec(`insert into session_coach (academy_id, session_id, coach_id, confirmed_at)
              values (${A}, '${worked.id}'::uuid, '${coach.id}'::uuid, app.now() - interval '36 days')`)

  // The raise, typed today, long after that session was worked.
  await exec(`update coach set pay_amount = 800 where id = '${coach.id}'::uuid`)

  const cp = await one(`select amount_for_session::text as now_amount, amount_then::text as then_amount
                          from coach_pay where session_id = '${worked.id}'::uuid`)
  assert('coach_pay still answers 800 for TODAY, unchanged', num(cp.now_amount) === 800, cp)
  assert('and 500 for the day it was worked', num(cp.then_amount) === 500, cp)

  const lastPeriod = String(
    (await one(`select date_trunc('month', (app.now() - interval '35 days')
                  at time zone 'Asia/Kolkata')::date::text as p`)).p,
  ).slice(0, 10)
  const { coachMonthLines } = await import('@/lib/jobs/handlers/money')
  try {
    await coachMonthLines({ payload: { academy_id: academyId, coach_id: coach.id, period: lastPeriod } } as never)
  } catch (e) {
    console.log(`        coachMonthLines said: ${String((e as Error).message).slice(0, 120)}`)
  }
  const led = await one(`select amount::text as amount, rate_amount::text as rate_amount
                           from coach_ledger where session_id = '${worked.id}'::uuid`)
  assert('the closed month pays 500, the rate he was on then', num(led.amount) === 500, led)
  assert('and the line records the rate it was computed at', num(led.rate_amount) === 500, led)

  /* ======================================================================= *
   * BLOCK C - F-CM. A pack keeps the size it was sold at.
   * ======================================================================= */
  section('C - package size (F-CM)')

  const pkgCls = await one(`insert into class (academy_id, name, venue_id, rate_amount, rate_unit, rate_count, starts_on)
                            values (${A}, 'Ten pack', '${venue.id}'::uuid, 5000, 'per_package', 10,
                                    ${TODAY} - 30) returning id`)
  await exec(`insert into enrollment (academy_id, class_id, player_id, started_on)
              values (${A}, '${pkgCls.id}'::uuid, '${player.id}'::uuid, ${TODAY} - 30)`)
  await exec(`insert into tally_line (academy_id, account_id, player_id, class_id, period, kind,
                                      description, amount, rate_amount, rate_unit, rate_count)
              values (${A}, '${account.id}'::uuid, '${player.id}'::uuid, '${pkgCls.id}'::uuid,
                      date_trunc('month', app.now() at time zone 'Asia/Kolkata')::date, 'package',
                      'Ten pack - 10 sessions', 5000, 5000, 'per_package', 10)`)

  // The restructure: ten-class packs become four-class packs.
  await exec(`update class set rate_count = 4 where id = '${pkgCls.id}'::uuid`)

  const { packRemaining } = await import('@/lib/jobs/handlers/money')
  const packs = await withSession(ctx, async (tx) => packRemaining(tx as never, academyId, String(account.id)))
  const pack = (packs as any[]).find((x) => x.class_name === 'Ten pack')
  assert('a pack already sold keeps the size it was sold at', pack?.size === 10, packs)
  assert('so the count remaining is out of ten, not four', pack?.remaining === 10, packs)

  // A line written before 0043 has no frozen count and must fall back to the
  // live one rather than read as zero.
  await exec(`update tally_line set rate_count = null
               where class_id = '${pkgCls.id}'::uuid and kind = 'package'`)
  const legacy = await withSession(ctx, async (tx) => packRemaining(tx as never, academyId, String(account.id)))
  const legacyPack = (legacy as any[]).find((x) => x.class_name === 'Ten pack')
  assert('a pre-0043 pack line falls back to the live size', legacyPack?.size === 4, legacy)

  /* ======================================================================= *
   * BLOCK E - the catch-up tail. A period billed LATE is billed at the rate in
   * force then. This is the leak 0038's "frozen into a row on 1 August"
   * sentence does not cover: BILLING_CATCHUP_MONTHS lets plan-ahead enqueue a
   * period months old, and monthlyLines resolves the rate when it RUNS.
   *
   * Ninety-five days back is the quarter mark, and the reason this block exists
   * rather than a per_term one: the defect is the distance, not the unit.
   * ======================================================================= */
  section('E - a period billed a quarter late')

  const monthCls = await one(`insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on)
                              values (${A}, 'Squad', '${venue.id}'::uuid, 2000, 'per_month',
                                      ${TODAY} - 130) returning id`)
  const monthEnr = await one(`insert into enrollment (academy_id, class_id, player_id, started_on)
                              values (${A}, '${monthCls.id}'::uuid, '${player.id}'::uuid, ${TODAY} - 130)
                              returning id`)
  const oldPeriod = String(
    (await one(`select date_trunc('month', (app.now() - interval '95 days')
                  at time zone 'Asia/Kolkata')::date::text as p`)).p,
  ).slice(0, 10)

  // Raised today, a quarter after the period that never got billed.
  await exec(`update class set rate_amount = 3000 where id = '${monthCls.id}'::uuid`)

  const { monthlyLines } = await import('@/lib/jobs/handlers/money')
  try {
    await monthlyLines({ payload: { academy_id: academyId, enrollment_id: monthEnr.id, period: oldPeriod } } as never)
  } catch (e) {
    console.log(`        monthlyLines said: ${String((e as Error).message).slice(0, 120)}`)
  }
  const oldLine = await one(`select amount::text as amount, rate_amount::text as rate_amount
                               from tally_line
                              where class_id = '${monthCls.id}'::uuid and period = date '${oldPeriod}'`)
  assert('a period billed late bills at the rate in force then', num(oldLine.amount) === 2000, oldLine)
  assert('and freezes it onto the line', num(oldLine.rate_amount) === 2000, oldLine)

  /* ======================================================================= *
   * BLOCK D — the anti-drift invariant, which is what makes rate_period a
   * record rather than a second author.
   * ======================================================================= */
  section('D · the column and the record cannot disagree')

  const drift = await rows(`
    select 'enrollment' as kind, e.id::text as id,
           e.rate_amount::text as col, (app.rate_on(e.id, app.today(e.academy_id))).amount::text as resolved
      from enrollment e where e.academy_id = ${A} and e.rate_amount is not null
    union all
    select 'class', cl.id::text, cl.rate_amount::text,
           (app.class_rate_on(cl.id, app.today(cl.academy_id))).amount::text
      from class cl where cl.academy_id = ${A} and cl.rate_amount is not null
    union all
    select 'coach', c.id::text, c.pay_amount::text,
           (app.pay_on(c.id, app.today(c.academy_id))).amount::text
      from coach c where c.academy_id = ${A} and c.pay_amount is not null`)
  const disagreeing = rows_disagree(drift)
  assert('every current column equals what the resolver says for today', disagreeing.length === 0, disagreeing)

  // Two same-day changes are ONE period: the unique index makes 900-then-1100
  // -then-1300 on one day collapse to the last of them, because "the rate on
  // that day" cannot be two numbers.
  const sameDay = await one(`select count(*)::int as n from rate_period where class_id = '${cls.id}'::uuid`)
  assert('changes on one day collapse to one period for that day', Number(sameDay.n) === 2, sameDay)

  // And a genuinely identical re-type writes nothing at all, which is also what
  // makes the promotion sweep safe to run every day forever.
  await exec(`update class set rate_amount = 1300 where id = '${cls.id}'::uuid`)
  const noop = await one(`select count(*)::int as n, max(amount)::text as top
                            from rate_period where class_id = '${cls.id}'::uuid`)
  assert('re-typing the same price is not a new period', Number(noop.n) === 2, noop)
  assert('and the day carries the last number typed', Number(noop.top) === 1300, noop)

  console.log('')
  if (failures === 0) {
    console.log('  Money is priced at the rate in force when it was earned.')
    console.log('  A raise reaches forward only, and a written line never moves again.')
  } else {
    console.log(`  ${failures} assertion(s) failed.`)
  }
} finally {
  await withSession(ctx, async (tx) => {
    await tx.unsafe(`delete from academy where id = ${A}`)
  }).catch(() => {})
}

function rows_disagree(all: Record<string, any>[]): Record<string, any>[] {
  return all.filter((r) => Number(r.col) !== Number(r.resolved))
}

process.exit(failures === 0 ? 0 : 1)

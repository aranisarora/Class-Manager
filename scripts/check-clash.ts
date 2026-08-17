/**
 * check-clash — prove that a coach cannot be put in two places at once.
 *
 *   npx tsx scripts/check-clash.ts
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * `tn-two-places` (the month drive, 17 Aug 2026): asked to add a Monday 7–8am
 * private at the Gymkhana while the same coach already had a Monday 7–8am
 * private at Lake Club, the product created it with no lookup at all,
 * auto-committed on the grounds that it "touched nobody else", and told the
 * admin it was done. Both families were then reminded of a session the coach
 * could not attend.
 *
 * `lib/agent/clash.ts` closes that by asking the database what the world BECAME
 * after a plan's steps ran and before the transaction commits, rather than
 * checking anything inside `create_class`. That is the property worth a test:
 * the guard is supposed to hold for routes nobody has written yet, so proving
 * it through one operation would prove the wrong thing. Case 5 below moves a
 * session with a raw SQL write — no named operation anywhere near it — and the
 * same check catches it.
 *
 * WHAT IT DOES TO THE DATABASE
 * -----------------------------------------------------------------------------
 * Builds its own scratch tenant, previews plans against it, and deletes it in a
 * `finally`. `previewPlan` rolls back, so nothing here is committed and nothing
 * is sent. It touches no other academy.
 */
import { loadEnvFiles } from './_env'
// Type-only, so it is erased and the modules below are still evaluated after
// the environment is loaded.
import type { PlanStep } from '@/lib/agent/plan'

loadEnvFiles()

const { withSession, withRollback } = await import('@/lib/db')
const { previewPlan, needsPreview } = await import('@/lib/agent/plan')
const { coachClashes } = await import('@/lib/agent/clash')
const { newId } = await import('@/lib/ids')

/** The sandbox sender every seeded world already uses. */
const SENDER = '88ec9075-dcd5-482f-835e-1f488a082e39'
const MONDAY = 1
const TUESDAY = 2

let failures = 0

function assert(label: string, ok: boolean, detail?: unknown): void {
  console.log(`  ${ok ? 'pass' : 'FAIL'}  ${label}`)
  if (!ok) {
    failures++
    if (detail !== undefined) console.log(`        got: ${JSON.stringify(detail)}`)
  }
}

/* -- the scratch tenant ---------------------------------------------------- */

const academyId = newId()
const ctx = { role: 'service', academyId } as const

const world = await withSession(ctx, async (tx) => {
  const one = async (sql: string): Promise<Record<string, any>> =>
    ((await tx.unsafe(sql)) as unknown as Record<string, any>[])[0]
  const A = `'${academyId}'::uuid`

  await tx.unsafe(
    `insert into academy (id, name, sender_id, onboarding_state, timezone)
     values (${A}, 'Clash Scratch', '${SENDER}'::uuid, 'live', 'Asia/Kolkata')`,
  )
  // One person in two hats — the solo shape, where every overlap is real.
  const ravi = await one(`insert into person (academy_id, full_name) values (${A}, 'Ravi Menon') returning id`)
  await tx.unsafe(`insert into academy_admin (academy_id, person_id) values (${A}, '${ravi.id}'::uuid)`)
  await tx.unsafe(
    `insert into contact (academy_id, person_id, phone_e164) values (${A}, '${ravi.id}'::uuid, '+919999000001')`,
  )
  const coach = await one(
    `insert into coach (academy_id, person_id, status) values (${A}, '${ravi.id}'::uuid, 'active') returning id`,
  )
  const lake = await one(`insert into venue (academy_id, name) values (${A}, 'Lake Club') returning id`)
  const gym = await one(`insert into venue (academy_id, name) values (${A}, 'Gymkhana') returning id`)

  const sneha = await one(
    `insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on)
     values (${A}, 'Sneha', '${lake.id}'::uuid, 900, 'per_session',
             (app.now() at time zone 'Asia/Kolkata')::date) returning id`,
  )
  await tx.unsafe(
    `insert into class_slot (academy_id, class_id, weekday, start_time, end_time)
     values (${A}, '${sneha.id}'::uuid, ${MONDAY}, '07:00', '08:00')`,
  )
  await tx.unsafe(
    `insert into class_coach (academy_id, class_id, coach_id) values (${A}, '${sneha.id}'::uuid, '${coach.id}'::uuid)`,
  )

  // A second class the same coach also takes, on a different weekday so it is
  // not itself an overlap. `session` carries `unique (class_id, starts_at)`, so
  // two sessions of ONE class can never collide — the dated case only exists
  // across classes, which is also the only shape it has in real life.
  const kabir = await one(
    `insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on)
     values (${A}, 'Kabir', '${gym.id}'::uuid, 900, 'per_session',
             (app.now() at time zone 'Asia/Kolkata')::date) returning id`,
  )
  await tx.unsafe(
    `insert into class_slot (academy_id, class_id, weekday, start_time, end_time)
     values (${A}, '${kabir.id}'::uuid, 5, '17:00', '18:00')`,
  )
  await tx.unsafe(
    `insert into class_coach (academy_id, class_id, coach_id) values (${A}, '${kabir.id}'::uuid, '${coach.id}'::uuid)`,
  )

  // Two future sessions for the same coach, three hours apart. Not a clash yet.
  const session = async (classId: string, offset: string): Promise<string> => {
    const s = await one(
      `insert into session (academy_id, class_id, starts_at, ends_at)
       values (${A}, '${classId}'::uuid, app.now() + interval '${offset}',
               app.now() + interval '${offset}' + interval '1 hour') returning id`,
    )
    await tx.unsafe(
      `insert into session_coach (academy_id, session_id, coach_id)
       values (${A}, '${s.id}'::uuid, '${coach.id}'::uuid)`,
    )
    return s.id as string
  }
  return {
    coachId: coach.id as string,
    raviPersonId: ravi.id as string,
    gym: gym.id as string,
    early: await session(sneha.id as string, '2 days'),
    later: await session(kabir.id as string, '2 days 3 hours'),
  }
})

/* -- the cases ------------------------------------------------------------- */

/**
 * A class, as the rows a class is.
 *
 * This called `create_class`, and the point of the test is stronger without it.
 * The header below says the check does not ask what the caller intended — it asks
 * the database what the world BECAME, which is what makes it cover routes nobody
 * has written yet. Driving it through raw statements is that claim under test
 * rather than asserted: no named operation is anywhere near this, and the clash
 * is still found.
 */
const addClass = (name: string, weekday: number, start: string, end: string): PlanStep[] => {
  const today = new Date().toISOString().slice(0, 10)
  const cls = `(select id from class where name = '${name}' and academy_id = app.academy_id() and active and ends_on is null)`
  return [
    {
      write:
        `insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on)` +
        ` values (app.academy_id(), '${name}', '${world.gym}'::uuid, 900, 'per_session', date '${today}')`,
    },
    {
      write:
        `insert into class_slot (academy_id, class_id, weekday, start_time, end_time)` +
        ` values (app.academy_id(), ${cls}, ${weekday}, time '${start}', time '${end}')`,
    },
    {
      write:
        `insert into class_coach (academy_id, class_id, coach_id)` +
        ` values (app.academy_id(), ${cls}, '${world.coachId}'::uuid)`,
    },
  ]
}

console.log('\ncheck-clash — a coach is one person\n')

try {
  /* 1. The driven case, verbatim. */
  const steps = addClass('Anika', MONDAY, '07:00', '08:00')
  const clash = await previewPlan(ctx, steps, 'set up Anika Mondays 7 to 8 at the Gymkhana')
  assert('a second Monday 7am for the same coach is one clash', clash.clashes.length === 1, clash.clashes)
  const line = clash.clashes[0] ?? ''
  assert(
    'named: the coach, the day, both classes and both venues',
    line.includes('Ravi Menon is in two places on Mondays') &&
      line.includes('Sneha 7am (Lake Club)') &&
      line.includes('Anika 7am (Gymkhana)'),
    line,
  )
  assert('it reaches the summary the admin confirms against', clash.summary.includes('in two places'), clash.summary)
  assert('so the plan can no longer run unattended', needsPreview(clash, steps) === true)
  console.log(`        → ${clash.summary}`)

  /* 2. Overlap, not equality — the check is a range test, not a time match. */
  const partial = await previewPlan(ctx, addClass('Ira', MONDAY, '07:30', '08:30'), 'add Ira Mondays 7:30')
  assert('7:30–8:30 across a 7–8 is a clash', partial.clashes.length === 1, partial.clashes)

  /* 3. …and it is a range test in the other direction too. */
  const after = await previewPlan(ctx, addClass('Farah', MONDAY, '08:00', '09:00'), 'add Farah Mondays 8')
  assert('8–9 straight after a 7–8 is not', after.clashes.length === 0, after.clashes)

  /* 4. Same hour, different day. */
  const tuesday = addClass('Kabir', TUESDAY, '07:00', '08:00')
  const other = await previewPlan(ctx, tuesday, 'add Kabir Tuesdays 7am')
  assert('the same hour on another weekday is not a clash', other.clashes.length === 0, other.clashes)
  assert('and that plan still runs unattended', needsPreview(other, tuesday) === false)

  /* 5. No named operation anywhere: a raw write moving one session onto another. */
  const move: PlanStep[] = [
    {
      write:
        `update session set starts_at = (select starts_at from session where id = '${world.early}'), ` +
        `ends_at = (select ends_at from session where id = '${world.early}') ` +
        `where id = '${world.later}'`,
    },
  ]
  const moved = await previewPlan(ctx, move, 'move the later session onto the earlier one')
  assert('moving a session on top of another of the same coach is a clash', moved.clashes.length === 1, moved.clashes)
  assert(
    'named with the date rather than the weekday',
    /Ravi Menon is in two places on \d+ [A-Z][a-z]{2}: /.test(moved.clashes[0] ?? ''),
    moved.clashes[0],
  )
  assert('so it cannot run unattended either', needsPreview(moved, move) === true)
  console.log(`        → ${moved.clashes[0]}`)

  /* 6. A plan that spends no hours is asked no questions about them. */
  const money: PlanStep[] = [{ write: `update class set rate_amount = 1000 where name = 'Sneha'` }]
  const rate = await previewPlan(ctx, money, 'put the rate up')
  assert('a plan that touches no scheduling table reports nothing', rate.clashes.length === 0, rate.clashes)

  /**
   * 7. Deciding about your own day is not a proposal.
   *
   * The only route a non-admin has to a clash is `claim_cover` — own-scope, and
   * first-tap-wins, so a preview would both add friction and lose the race.
   * `needsPreview` reads the steps for names and the result for rows, so the
   * clashing result above is the right thing to hold against a one-operation
   * own-scope plan: this asserts the ordering of the two clauses, not a fixture.
   */
  const ownScope: PlanStep[] = [{ operation: { name: 'claim_cover', args: { session_id: world.later } } }]
  assert('a single own-scope operation is not gated by a clash', needsPreview(moved, ownScope) === false)
  assert('but the same clash still gates a plain plan', needsPreview(moved, move) === true)

  /**
   * 8. The coach it is about is told too. `claim_cover` is the one route a
   * non-admin has here, and a non-admin's receipt is the `personal` one, so
   * leaving the note out of that list would silence it for exactly the person
   * standing in both places.
   */
  const bothVoices = await withRollback(ctx, async (tx) => {
    await tx.unsafe(move[0] && 'write' in move[0] ? move[0].write : '')
    return coachClashes(tx, academyId, [{ table: 'session', op: 'update', after: [{ id: world.later }] }])
  })
  assert('the overlap reads the same for everyone', bothVoices[0]?.startsWith('Ravi Menon is in two places'), bothVoices[0])
} finally {
  await withSession(ctx, async (tx) => {
    await tx.unsafe(`delete from academy where id = '${academyId}'`)
  })
  console.log('\nscratch tenant removed.')
}

console.log(failures === 0 ? '\nall clear.\n' : `\n${failures} failed.\n`)
process.exit(failures === 0 ? 0 : 1)

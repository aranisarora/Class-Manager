/**
 * check-attendance-bills — does an attendance row imply the money it owes?
 *
 *   npx tsx scripts/check-attendance-bills.ts
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * F-BA, open since 17 Aug 2026: on a per-session rate the register IS the
 * invoice, and the line that bills it is written by the `mark_attendance`
 * operation rather than by the world. So an `insert into attendance …` composed
 * as a plan step — which the architecture pass made the ordinary way to write a
 * row — raises the family's outcome message and charges them nothing.
 *
 * The asymmetry is already stated in the schema, in the code's own words. 0004's
 * `attendance_enqueue_outcome` says of itself that raising the job from the ROW
 * means "an attendance written by the admin, the coach, the web register or a
 * model-authored transaction all raise it identically". Exactly that reasoning
 * is what the billing line does NOT have: it lives one layer up, in an
 * operation, and only one of those four routes goes through it.
 *
 * This asserts the shape rather than the sentence. A declaration steering the
 * model toward `mark_attendance` is worth having and is not a guarantee, and the
 * difference between the two is the thing a check can hold still.
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

const academyId = newId()
const ctx = { role: 'service', academyId } as const
const A = `'${academyId}'::uuid`

/**
 * Whichever sender this database actually has.
 *
 * Hardcoding the sandbox uuid worked until the database was reseeded and then
 * failed on a foreign key, which reads as a broken check rather than as a
 * missing row — the shape this repo keeps paying for.
 */
const SENDER = await withSession({ role: 'service', academyId: null as unknown as string }, async (tx) =>
  String(((await tx.unsafe(`select id from sender order by created_at limit 1`)) as unknown as any[])[0]?.id ?? ''),
).catch(() => '')
if (!SENDER) {
  console.error('  no sender row in this database — seed one before running this check')
  process.exit(2)
}

try {
  /* -- a solo per-session world, with one session already finished ---------- */
  const world = await withSession(ctx, async (tx) => {
    const one = async (sql: string): Promise<Record<string, any>> =>
      ((await tx.unsafe(sql)) as unknown as Record<string, any>[])[0]

    await tx.unsafe(
      `insert into academy (id, name, sender_id, onboarding_state, timezone)
       values (${A}, 'Attendance Scratch', '${SENDER}'::uuid, 'live', 'Asia/Kolkata')`,
    )
    const ravi = await one(`insert into person (academy_id, full_name) values (${A}, 'Ravi Menon') returning id`)
    await tx.unsafe(`insert into academy_admin (academy_id, person_id) values (${A}, '${ravi.id}'::uuid)`)
    await tx.unsafe(
      `insert into contact (academy_id, person_id, phone_e164) values (${A}, '${ravi.id}'::uuid, '+919999000021')`,
    )
    const coach = await one(
      `insert into coach (academy_id, person_id, status) values (${A}, '${ravi.id}'::uuid, 'active') returning id`,
    )
    const venue = await one(`insert into venue (academy_id, name) values (${A}, 'Lake Club') returning id`)

    // The parent, the child, and the account the money would land on.
    const meera = await one(`insert into person (academy_id, full_name) values (${A}, 'Meera Iyer') returning id`)
    const account = await one(
      `insert into account (academy_id, holder_person_id) values (${A}, '${meera.id}'::uuid) returning id`,
    )
    const aarav = await one(`insert into person (academy_id, full_name) values (${A}, 'Aarav Iyer') returning id`)
    const player = await one(
      `insert into player (academy_id, person_id, account_id, active)
       values (${A}, '${aarav.id}'::uuid, '${account.id}'::uuid, true) returning id`,
    )

    // Per SESSION, which is the whole point: on per_month the unmarked register
    // owes nothing and this check would be asking the wrong question.
    const cls = await one(
      `insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on)
       values (${A}, 'Aarav one-to-one', '${venue.id}'::uuid, 900, 'per_session',
               (app.now() at time zone 'Asia/Kolkata')::date - 7) returning id`,
    )
    await tx.unsafe(
      `insert into class_coach (academy_id, class_id, coach_id) values (${A}, '${cls.id}'::uuid, '${coach.id}'::uuid)`,
    )
    await tx.unsafe(
      `insert into enrollment (academy_id, class_id, player_id, started_on)
       values (${A}, '${cls.id}'::uuid, '${player.id}'::uuid,
               (app.now() at time zone 'Asia/Kolkata')::date - 7)`,
    )
    // Over, and it happened — the only state in which a register is late.
    const session = await one(
      `insert into session (academy_id, class_id, starts_at, ends_at, status)
       values (${A}, '${cls.id}'::uuid, app.now() - interval '3 hours',
               app.now() - interval '2 hours', 'scheduled') returning id`,
    )
    return { sessionId: session.id as string, playerId: player.id as string, coachId: coach.id as string }
  })

  /* -- the world agrees there is money waiting ------------------------------ */
  const owed = await withSession(ctx, async (tx) =>
    (await tx.unsafe(
      `select unmarked_players, unbilled_amount::text as amount from unmarked_billable_session`,
    )) as unknown as { unmarked_players: number; amount: string }[],
  )
  assert(
    'the finished session shows as unmarked and owing ₹900',
    owed.length === 1 && Number(owed[0]?.amount) === 900,
    owed,
  )

  /* -- the write, exactly as a plan step would make it ---------------------- */
  await withSession(ctx, async (tx) => {
    await tx.unsafe(
      `insert into attendance (academy_id, session_id, player_id, status, marked_by_coach_id, marked_at)
       values (${A}, '${world.sessionId}'::uuid, '${world.playerId}'::uuid, 'present',
               '${world.coachId}'::uuid, app.now())`,
    )
  })

  const after = await withSession(ctx, async (tx) =>
    ((await tx.unsafe(
      `select (select count(*) from attendance)::int                             as attendance,
              (select count(*) from tally_line)::int                             as lines,
              (select coalesce(sum(amount), 0)::text from tally_line)            as billed,
              (select count(*) from job
                where kind = 'client_outcome'
                  and payload->>'academy_id' = '${academyId}')::int              as outcome_jobs,
              (select count(*) from unmarked_billable_session)::int              as still_owing`,
    )) as unknown as Record<string, any>[])[0],
  )

  assert('the attendance row is there', after.attendance === 1, after)
  assert(
    'the family is told — a client_outcome job was raised from the row',
    after.outcome_jobs === 1,
    after,
  )
  assert(
    'F-BA · and nobody was billed for it — no tally line exists',
    after.lines === 0 && Number(after.billed) === 0,
    after,
  )
  assert(
    'F-BA · and nothing can find it again — the session no longer reads as unbilled',
    after.still_owing === 0,
    after,
  )

  console.log(
    failures === 0
      ? '\n  F-BA holds as written: the message is trigger-borne, the money is operation-borne,\n' +
        '  and the only route that writes both is the one the model is merely advised to take.\n' +
        '  The last assertion is the sharp end — once the row exists, `unmarked_billable_session`\n' +
        '  stops reporting it, so the unbilled session is invisible to the one view built to find it.'
      : `\n  ${failures} assertion(s) did not hold — read them before believing either side.`,
  )
} finally {
  await withSession({ role: 'service', academyId }, async (tx) => {
    await tx.unsafe(`delete from academy where id = ${A}`)
  }).catch(() => {})
}

process.exit(failures === 0 ? 0 : 1)

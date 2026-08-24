/**
 * check-partial-period — does "Always pro-rate" pro-rate anything?
 *
 *   npx tsx scripts/check-partial-period.ts
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * F-I's mid-month half was closed on 17 Aug 2026 as "a decision the owner makes":
 * a line written for a period the enrolment only partly spans raises a moment,
 * and the owner's answer is made durable so the moment is not a monthly
 * interruption. One button credits this one; the other credits it AND writes a
 * `business_rule` in the owner's words with `enforced_by` naming
 * `academy.settings.partial_period`, "which the writer then reads". That
 * sentence is the reason `business_rule` was called read for the first time
 * (F-BH), and it is the sentence this check exists to test.
 *
 * Because `partial_period` appears three times in the whole runtime: written by
 * that button, named by that rule, and read in exactly one place —
 * `raisePartialPeriod`, where it decides whether to ASK. `writeLine` never looks
 * at it. So the tap silences the question and leaves the charge alone, which
 * makes the two arms below the point:
 *
 *   arm 1  an unanswered business — full line, and the owner is told
 *   arm 2  a business that tapped "Always pro-rate" — full line, and SILENCE
 *
 * If arm 2 bills the same as arm 1 and says nothing, the owner has been shown
 * their own words as policy, and the policy is enforced by nothing. That is
 * strictly worse than never having tapped: before the tap they were told every
 * time, and after it they are told never.
 *
 * WHAT IT DOES TO THE DATABASE
 * -----------------------------------------------------------------------------
 * Builds its own scratch tenant, runs the real `monthlyLines` handler against
 * it, and deletes it in a `finally`. It touches no other academy and runs no
 * model. It does send — to the emulator — because the moment IS a message and a
 * check that stubbed the send would be testing something else.
 */
import { loadEnvFiles } from './_env'

loadEnvFiles()

const { withSession } = await import('@/lib/db')
const { newId } = await import('@/lib/ids')
const { monthlyLines } = await import('@/lib/jobs/handlers/money')

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

const SENDER = await withSession({ role: 'service', academyId: null as unknown as string }, async (tx) =>
  String(((await tx.unsafe(`select id from sender limit 1`)) as unknown as any[])[0]?.id ?? ''),
).catch((e) => {
  console.error(`  could not read the sender table: ${String((e as Error).message).slice(0, 160)}`)
  return ''
})
if (!SENDER) {
  console.error('  no sender to hang a scratch tenant on — nothing was measured')
  process.exit(2)
}

/** Run the real handler, swallowing only the handler's own "nothing to do". */
async function runLines(enrollmentId: string, period: string): Promise<string> {
  try {
    await monthlyLines({
      payload: { academy_id: academyId, enrollment_id: enrollmentId, period },
    } as never)
    return ''
  } catch (e) {
    return String((e as Error).message).slice(0, 120)
  }
}

try {
  const world = await withSession(ctx, async (tx) => {
    const one = async (sql: string): Promise<Record<string, any>> =>
      ((await tx.unsafe(sql)) as unknown as Record<string, any>[])[0]

    await tx.unsafe(`select app.create_tenant(${A}, '${SENDER}'::uuid, 'business')`)
    await tx.unsafe(
      `insert into academy (id, name, sender_id, onboarding_state, timezone)
       values (${A}, 'Partial Period Scratch', '${SENDER}'::uuid, 'live', 'Asia/Kolkata')`,
    )
    const ravi = await one(`insert into person (academy_id, full_name) values (${A}, 'Ravi Menon') returning id`)
    await tx.unsafe(`insert into academy_admin (academy_id, person_id) values (${A}, '${ravi.id}'::uuid)`)
    await tx.unsafe(
      `insert into contact (academy_id, person_id, phone_e164, last_inbound_at)
       values (${A}, '${ravi.id}'::uuid, '+919999000041', app.now())`,
    )
    const venue = await one(`insert into venue (academy_id, name) values (${A}, 'Green Park') returning id`)
    const cls = await one(
      `insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on)
       values (${A}, 'Beginners', '${venue.id}'::uuid, 2000, 'per_month',
               date_trunc('month', app.now() at time zone 'Asia/Kolkata')::date) returning id`,
    )

    // Two families, identical in every way except which arm they are billed in.
    const family = async (name: string): Promise<string> => {
      const p = await one(`insert into person (academy_id, full_name) values (${A}, '${name}') returning id`)
      const acc = await one(
        `insert into account (academy_id, holder_person_id) values (${A}, '${p.id}'::uuid) returning id`,
      )
      const pl = await one(
        `insert into player (academy_id, person_id, account_id, active)
         values (${A}, '${p.id}'::uuid, '${acc.id}'::uuid, true) returning id`,
      )
      // Joined on the 17th — a fortnight of a month they are billed all of.
      const en = await one(
        `insert into enrollment (academy_id, class_id, player_id, started_on)
         values (${A}, '${cls.id}'::uuid, '${pl.id}'::uuid,
                 (date_trunc('month', app.now() at time zone 'Asia/Kolkata')::date + 16)) returning id`,
      )
      return en.id as string
    }

    const period = String(
      (await one(`select date_trunc('month', app.now() at time zone 'Asia/Kolkata')::date::text as p`)).p,
    )
    return { unanswered: await family('Meera Iyer'), settled: await family('Kiran Shah'), period }
  })

  const outbound = async (): Promise<number> =>
    Number(
      ((await withSession(ctx, async (tx) =>
        (await tx.unsafe(
          `select count(*)::int as n from message
            where direction = 'outbound' and (body ilike '%pro-rata%' or body ilike '%prorat%')`,
        )) as unknown as any[],
      )) as any[])[0]?.n ?? 0,
    )

  /* -- arm 1 · a business that has never answered --------------------------- */
  const err1 = await runLines(world.unanswered, world.period)
  const after1 = ((await withSession(ctx, async (tx) =>
    (await tx.unsafe(
      `select coalesce(sum(amount), 0)::text as billed, count(*)::int as lines from tally_line`,
    )) as unknown as any[],
  )) as any[])[0]
  const told1 = await outbound()

  assert('arm 1 · the handler ran', err1 === '', err1)
  assert('arm 1 · a fortnight of the month is billed as the whole ₹2000', Number(after1.billed) === 2000, after1)
  assert('arm 1 · and the owner is told, with the pro-rata figure worked out', told1 === 1, { told1 })

  /* -- arm 2 · the owner tapped "Always pro-rate" --------------------------- */
  // Exactly what that button's two steps write, and nothing else.
  await withSession(ctx, async (tx) => {
    await tx.unsafe(
      `insert into business_rule (academy_id, statement, topic, provenance, enforced_by, visibility)
       values (${A}, 'Part-months are pro-rated to the days actually enrolled.', 'billing',
               'owner_stated', 'academy.settings.partial_period', 'internal')`,
    )
    await tx.unsafe(
      `update academy set settings = coalesce(settings, '{}'::jsonb) || '{"partial_period":"prorate"}'::jsonb
        where id = ${A}`,
    )
  })

  const err2 = await runLines(world.settled, world.period)
  const after2 = ((await withSession(ctx, async (tx) =>
    (await tx.unsafe(
      `select coalesce(sum(amount), 0)::text as billed, count(*)::int as lines from tally_line`,
    )) as unknown as any[],
  )) as any[])[0]
  const told2 = await outbound()

  assert('arm 2 · the handler ran', err2 === '', err2)
  assert(
    'F-BH · the rule says pro-rate, and the second family is billed the same full ₹2000',
    Number(after2.billed) - Number(after1.billed) === 2000,
    { arm1: after1.billed, arm2: after2.billed },
  )
  assert(
    'F-BH · and this time nobody is told — the setting silenced the moment it did not act on',
    told2 === told1,
    { told1, told2 },
  )

  const enforced = ((await withSession(ctx, async (tx) =>
    (await tx.unsafe(`select enforced_by, statement from business_rule`)) as unknown as any[],
  )) as any[])[0]

  console.log(
    failures === 0
      ? `\n  The rule reads "${enforced?.statement}"\n` +
        `  and names \`${enforced?.enforced_by}\` as what enforces it.\n\n` +
        '  Nothing reads that setting when the line is written. It is read once, in\n' +
        '  `raisePartialPeriod`, to decide whether to ASK — so the tap buys silence and\n' +
        '  not pro-rating. Before it, the owner was told every time and the charge stood;\n' +
        '  after it, the charge stands and they are never told again.'
      : `\n  ${failures} assertion(s) did not hold — read them before believing either side.`,
  )
} finally {
  await withSession({ role: 'service', academyId }, async (tx) => {
    await tx.unsafe(`delete from tenant where id = ${A}`)
  }).catch(() => {})
}

process.exit(failures === 0 ? 0 : 1)

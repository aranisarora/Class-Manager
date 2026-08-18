/**
 * check-roster-scale — where does `app.session_roster` stop answering?
 *
 *   npx tsx scripts/check-roster-scale.ts
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * F-R, open since 16 Aug 2026 and never diagnosed: with the clock budget fixed,
 * `coach-marks-register` reached a finished class for the first time and three
 * of its four reads came back `canceling statement due to statement timeout` —
 * twice on the roster view that exists for exactly that moment. The model never
 * reached `mark_attendance` and said so honestly. The finding's own note is that
 * one run does not settle it: the view returns instantly on a small tenant, so
 * the cause may be the larger world a long walk builds, or contention from the
 * probe's own draining.
 *
 * A drive cannot separate those two, because a drive only ever has the one world
 * it happens to have built. This can: it grows ONE tenant through several sizes
 * and times the view at each, with nothing else running against it.
 *
 * TWO QUESTIONS, NOT ONE
 * -----------------------------------------------------------------------------
 * The model reads this view two ways and they are not the same question:
 *
 *   scoped   `where session_id = '…'` — the register for tonight, which is what
 *            `mark_attendance` needs and what the failing turn was doing
 *   whole    `select * from app.session_roster` — every row, which is what a
 *            month-end audit or a careless read costs
 *
 * The scoped one is the one that matters. If it degrades with the SIZE OF THE
 * TENANT rather than with the size of its answer, the join is not pushing the
 * predicate down and the fix is an index or a function, not a bigger timeout.
 *
 * THE TIMEOUT IS THE PRODUCT'S, NOT A NUMBER CHOSEN HERE
 * -----------------------------------------------------------------------------
 * Timed as `readonly`, which is the role the model's own `read` runs as, and
 * therefore under the same 5s `statement_timeout` (`lib/db.ts`). A reading taken
 * as the service role would be a reading about a query the product never makes.
 *
 * WHAT IT DOES TO THE DATABASE
 * -----------------------------------------------------------------------------
 * Builds its own scratch tenant, grows it, and deletes it in a `finally`. It
 * touches no other academy, sends nothing, and runs no model.
 */
import { loadEnvFiles } from './_env'

loadEnvFiles()

const { withSession } = await import('@/lib/db')
const { newId } = await import('@/lib/ids')

/** Sessions in the tenant at each reading. Cumulative — the tenant only grows. */
const STEPS = [50, 250, 1000, 3000]
/** Players on the one class, so roster rows are sessions × this. */
const PLAYERS = 12

const academyId = newId()
const ctx = { role: 'service', academyId } as const
const A = `'${academyId}'::uuid`

/**
 * Whichever sender this database actually has.
 *
 * The failure is reported rather than swallowed: a `catch` that turns any error
 * into "no sender row" says the database is empty when what actually happened
 * was a refused connection, and that is a lie about the world in the one place
 * this file exists to tell the truth about it.
 */
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

type Reading = { sessions: number; rosterRows: number; wholeMs: number; scopedMs: number; failed: string }
const readings: Reading[] = []

try {
  const world = await withSession(ctx, async (tx) => {
    const one = async (sql: string): Promise<Record<string, any>> =>
      ((await tx.unsafe(sql)) as unknown as Record<string, any>[])[0]

    await tx.unsafe(
      `insert into academy (id, name, sender_id, onboarding_state, timezone)
       values (${A}, 'Roster Scale Scratch', '${SENDER}'::uuid, 'live', 'Asia/Kolkata')`,
    )
    const ravi = await one(`insert into person (academy_id, full_name) values (${A}, 'Ravi Menon') returning id`)
    await tx.unsafe(`insert into academy_admin (academy_id, person_id) values (${A}, '${ravi.id}'::uuid)`)
    const contact = await one(
      `insert into contact (academy_id, person_id, phone_e164)
       values (${A}, '${ravi.id}'::uuid, '+919999000031') returning id`,
    )
    const venue = await one(`insert into venue (academy_id, name) values (${A}, 'Green Park') returning id`)
    const cls = await one(
      `insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on)
       values (${A}, 'Beginners', '${venue.id}'::uuid, 1500, 'per_month',
               (app.now() at time zone 'Asia/Kolkata')::date - 400) returning id`,
    )

    // The roster's width. Every enrolment is live across the whole span, so no
    // reading is quietly measuring a narrower join than the one before it.
    await tx.unsafe(
      `insert into person (academy_id, full_name)
       select ${A}, 'Player ' || g from generate_series(1, ${PLAYERS}) g`,
    )
    await tx.unsafe(
      `insert into account (academy_id, holder_person_id)
       select ${A}, id from person where full_name like 'Player %'`,
    )
    await tx.unsafe(
      `insert into player (academy_id, person_id, account_id, active)
       select ${A}, a.holder_person_id, a.id, true from account a`,
    )
    await tx.unsafe(
      `insert into enrollment (academy_id, class_id, player_id, started_on)
       select ${A}, '${cls.id}'::uuid, p.id, (app.now() at time zone 'Asia/Kolkata')::date - 400
         from player p`,
    )
    return { classId: cls.id as string, personId: ravi.id as string, contactId: contact.id as string }
  })

  const readCtx = {
    role: 'readonly' as const,
    academyId,
    personId: world.personId,
    contactId: world.contactId,
  }

  let made = 0
  for (const target of STEPS) {
    // Sessions on distinct hours so `unique (class_id, starts_at)` holds, walking
    // BACKWARDS from now so every one of them has finished — an unfinished
    // session is a row the register never asks about.
    await withSession(ctx, async (tx) => {
      await tx.unsafe(
        `insert into session (academy_id, class_id, starts_at, ends_at, status)
         select ${A}, '${world.classId}'::uuid,
                app.now() - (g || ' hours')::interval,
                app.now() - (g || ' hours')::interval + interval '1 hour',
                'scheduled'
           from generate_series(${made + 1}, ${target}) g`,
      )
      await tx.unsafe(`analyze session`)
    })
    made = target

    // A real session id to scope by — the one the register would be about.
    const pick = String(
      ((await withSession(ctx, async (tx) =>
        (await tx.unsafe(`select id::text from session order by starts_at desc limit 1`)) as unknown as any[],
      )) as any[])[0]?.id,
    )

    const time = async (sql: string): Promise<{ ms: number; rows: number; failed: string }> => {
      const t0 = Date.now()
      try {
        const r = await withSession(readCtx, async (tx) => (await tx.unsafe(sql)) as unknown as any[])
        return { ms: Date.now() - t0, rows: r.length, failed: '' }
      } catch (e) {
        const m = String((e as Error).message)
        return { ms: Date.now() - t0, rows: -1, failed: /timeout/i.test(m) ? 'STATEMENT TIMEOUT' : m.slice(0, 60) }
      }
    }

    const whole = await time(`select * from app.session_roster`)
    const scoped = await time(`select * from app.session_roster where session_id = '${pick}'::uuid`)
    readings.push({
      sessions: target,
      rosterRows: whole.rows,
      wholeMs: whole.ms,
      scopedMs: scoped.ms,
      failed: [whole.failed && `whole: ${whole.failed}`, scoped.failed && `scoped: ${scoped.failed}`]
        .filter(Boolean)
        .join(' · '),
    })
    const r = readings[readings.length - 1] as Reading
    console.log(
      `  sessions ${String(r.sessions).padStart(5)} · roster rows ${String(r.rosterRows).padStart(6)} · ` +
      `whole ${String(r.wholeMs).padStart(6)}ms · one session ${String(r.scopedMs).padStart(5)}ms ` +
      (r.failed ? `· ${r.failed}` : ''),
    )
  }

  /**
   * The reading, stated rather than left to the reader.
   *
   * The scoped number is the finding's own case. If it stays flat while the
   * tenant grows twentyfold, the predicate is pushing down and F-R's timeout was
   * contention or an unscoped read — which is a different fix from an index, and
   * saying so is the whole value of running this.
   */
  const first = readings[0] as Reading
  const last = readings[readings.length - 1] as Reading
  const growth = first.scopedMs > 0 ? (last.scopedMs / first.scopedMs).toFixed(1) : '?'
  console.log(
    `\n  the tenant grew ${(last.sessions / first.sessions).toFixed(0)}× and the ONE-SESSION read moved ${growth}×.\n` +
    `  ${last.scopedMs < 1000
      ? 'The register\'s own query does not degrade with the size of the world, so F-R\'s\n' +
        '  timeout is not this view meeting a big tenant. Look at what else was running.'
      : 'The register\'s own query DOES degrade with the size of the world — the predicate is\n' +
        '  not reaching the join, and that is an index or a function, not a bigger timeout.'}`,
  )
} finally {
  await withSession({ role: 'service', academyId }, async (tx) => {
    await tx.unsafe(`delete from academy where id = ${A}`)
  }).catch(() => {})
}

process.exit(0)

/**
 * check-world — prove that the guarantees which moved DOWN into layer 0 hold on
 * every route, including the one nobody has written yet.
 *
 *   npx tsx scripts/check-world.ts
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * ARCHITECTURE.md's layer 0 says a thing that must never happen belongs in the
 * schema if the schema can say it, and that derived state is materialized from
 * the world rather than from the function you called. 0032 and 0033 moved five
 * such things out of operations that were deleted — and the whole argument for
 * deleting them is that the property now holds without anybody calling the right
 * thing. That argument is either true or it is a regression, and it is testable
 * either way.
 *
 * So every case here writes RAW SQL, as the model does. If any of these needed a
 * named operation to hold, the operation should not have gone.
 *
 * WHAT IT DOES TO THE DATABASE
 * -----------------------------------------------------------------------------
 * Builds its own scratch tenant and deletes it in a `finally`. It touches no
 * other academy and it sends nothing: the only message-shaped thing here is a
 * `pending_request` row, written and then read back.
 */
import { loadEnvFiles } from './_env'

loadEnvFiles()

const { withSession } = await import('@/lib/db')
const { newId } = await import('@/lib/ids')

/** The sandbox sender every seeded world already uses. */
const SENDER = '88ec9075-dcd5-482f-835e-1f488a082e39'
const MONDAY = 1

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

console.log('\ncheck-world — what the schema guarantees, whatever wrote the row\n')

try {
  await withSession(ctx, async (tx) => {
    const one = async (sql: string): Promise<Record<string, any>> =>
      ((await tx.unsafe(sql)) as unknown as Record<string, any>[])[0]
    const all = async (sql: string): Promise<Record<string, any>[]> =>
      (await tx.unsafe(sql)) as unknown as Record<string, any>[]

    await tx.unsafe(
      `insert into academy (id, name, sender_id, onboarding_state, timezone)
       values (${A}, 'World Scratch', '${SENDER}'::uuid, 'setup', 'Asia/Kolkata')`,
    )

    /* -- 1 · solo is a truth a real path writes (F-AY) ---------------------- */
    //
    // The coach row is inserted 'added', by hand, exactly as a model composing
    // SQL would write it. `is_solo()` used to key on a status that only
    // `onboard_coach` ever wrote — and a solo operator has nobody to be invited
    // by, so eight §18 behaviours existed only when the model happened to
    // hand-write the activation itself.
    const owner = await one(`insert into person (academy_id, full_name) values (${A}, 'Kabir Rao') returning id`)
    await tx.unsafe(`insert into academy_admin (academy_id, person_id) values (${A}, '${owner.id}'::uuid)`)
    await tx.unsafe(
      `insert into contact (academy_id, person_id, phone_e164) values (${A}, '${owner.id}'::uuid, '+919812340001')`,
    )
    const coach = await one(
      `insert into coach (academy_id, person_id, status) values (${A}, '${owner.id}'::uuid, 'added') returning id, status`,
    )
    assert('a coach who is already the admin is active on insert, not added', coach.status === 'active', coach)

    const solo = await one(`select app.is_solo(${A}) as solo`)
    assert('so is_solo() is true without anybody confirming anything to themselves', solo.solo === true, solo)

    // The other arrival order: the coach row first, the admin row after.
    const later = await one(`insert into person (academy_id, full_name) values (${A}, 'Nadia Sen') returning id`)
    await tx.unsafe(
      `insert into contact (academy_id, person_id, phone_e164) values (${A}, '${later.id}'::uuid, '+919812340002')`,
    )
    await tx.unsafe(`insert into coach (academy_id, person_id, status) values (${A}, '${later.id}'::uuid, 'added')`)
    await tx.unsafe(`insert into academy_admin (academy_id, person_id) values (${A}, '${later.id}'::uuid)`)
    const promoted = await one(
      `select status from coach where academy_id = ${A} and person_id = '${later.id}'::uuid`,
    )
    assert('and a coach who BECOMES an admin is activated too', promoted.status === 'active', promoted)

    /* -- 2 · nothing to go live with ---------------------------------------- */
    //
    // The precondition that used to ride inside `set_onboarding_state`'s UPDATE.
    // Checked here, while this tenant still has no class — the session is pinned
    // to one academy by RLS, so there is no second scratch tenant to borrow.
    let refused = false
    try {
      await tx.savepoint(async (sp) => {
        await sp.unsafe(`update academy set onboarding_state = 'live' where id = ${A}`)
      })
    } catch (e) {
      refused = /no class to go live with/.test(e instanceof Error ? e.message : String(e))
    }
    assert('an academy with no class cannot go live, however it is written', refused)

    /* -- 3 · a slot implies its sessions (0033) ------------------------------ */
    //
    // No `create_class` anywhere. The prompt used to say that operation was the
    // only thing that scheduled sessions; this is the sentence being made true.
    //
    // The class INSERT enqueues on its own — a class with a date range is already
    // a claim about which days exist — so what the slot proves is that the job is
    // there at all, from raw SQL, with no operation and no tick in between.
    const cls = await one(
      `insert into class (academy_id, name, rate_amount, rate_unit, starts_on)
       values (${A}, 'Evening', 900, 'per_session', (app.now() at time zone 'Asia/Kolkata')::date)
       returning id`,
    )
    await tx.unsafe(
      `insert into class_slot (academy_id, class_id, weekday, start_time, end_time)
       values (${A}, '${cls.id}'::uuid, ${MONDAY}, '18:00', '19:00')`,
    )
    const afterSlot = await all(
      `select id, status, run_at from job
        where kind = 'materialize_sessions' and payload->>'class_id' = '${cls.id}'`,
    )
    assert(
      'a hand-written class and slot enqueue the materialiser by themselves',
      afterSlot.length === 1,
      afterSlot,
    )
    // Twice is once: the dedupe key is per class per local day, so four slots in
    // one statement is one job and the tick's own planning finds it already there.
    await tx.unsafe(
      `insert into class_slot (academy_id, class_id, weekday, start_time, end_time)
       values (${A}, '${cls.id}'::uuid, 3, '18:00', '19:00')`,
    )
    const afterSecond = await all(
      `select id from job where kind = 'materialize_sessions' and payload->>'class_id' = '${cls.id}'`,
    )
    assert('and a second slot does not enqueue a second job', afterSecond.length === 1, {
      after: afterSecond.length,
    })

    // Now there is something to go live with, so the same statement passes.
    await tx.unsafe(`update academy set onboarding_state = 'live' where id = ${A}`)
    const live = await one(`select onboarding_state from academy where id = ${A}`)
    assert('and a business with a class can go live', live.onboarding_state === 'live', live)

    /* -- 4 · a phone number that cannot be a phone number -------------------- */
    let placeholder = false
    try {
      await tx.savepoint(async (sp) => {
        await sp.unsafe(
          `insert into contact (academy_id, person_id, phone_e164) values (${A}, '${owner.id}'::uuid, '+919999999999')`,
        )
      })
    } catch (e) {
      placeholder = /placeholder/i.test(e instanceof Error ? e.message : String(e))
    }
    assert('a placeholder number is refused by the table, not by one operation', placeholder)

    /* -- 5 · a question, and how it ends (F-AF, F-AQ) ----------------------- */
    const contact = await one(`select id from contact where academy_id = ${A} and person_id = '${owner.id}'::uuid`)
    await tx.unsafe(
      `insert into pending_request (academy_id, contact_id, person_id, kind, subject, question)
       values (${A}, '${contact.id}'::uuid, '${owner.id}'::uuid, 'opt_out', 'money',
               'stop anything about money?')`,
    )
    const open = await all(
      `select id from pending_request where contact_id = '${contact.id}'::uuid and resolved_at is null`,
    )
    assert('an ask is outstanding from the moment it is written', open.length === 1, open)

    // Asking again about the same subject replaces rather than accumulates —
    // the whole of F-C's lesson, one table over.
    await tx.unsafe(
      `update pending_request set resolved_at = app.now(), resolution = 'superseded'
        where contact_id = '${contact.id}'::uuid and kind = 'opt_out' and subject = 'money'
          and resolved_at is null`,
    )
    await tx.unsafe(
      `insert into pending_request (academy_id, contact_id, person_id, kind, subject, question)
       values (${A}, '${contact.id}'::uuid, '${owner.id}'::uuid, 'opt_out', 'money', 'asked again')`,
    )
    const stillOne = await all(
      `select question from pending_request where contact_id = '${contact.id}'::uuid and resolved_at is null`,
    )
    assert('and a second ask on the same subject leaves exactly one open', stillOne.length === 1, stillOne)

    let collided = false
    try {
      await tx.savepoint(async (sp) => {
        await sp.unsafe(
          `insert into pending_request (academy_id, contact_id, person_id, kind, subject, question)
           values (${A}, '${contact.id}'::uuid, '${owner.id}'::uuid, 'opt_out', 'money', 'a third')`,
        )
      })
    } catch {
      collided = true
    }
    assert('because the constraint, not the convention, is what stops the third', collided)

    /* -- 6 · a mute is a row a job can read --------------------------------- */
    await tx.unsafe(
      `insert into comm_preference (academy_id, contact_id, person_id, scope, stated)
       values (${A}, '${contact.id}'::uuid, '${owner.id}'::uuid, 'money', 'i will pay when i pay')`,
    )
    const muted = await all(
      `select scope from comm_preference
        where contact_id = '${contact.id}'::uuid and released_at is null
          and (until is null or until >= (app.now() at time zone 'Asia/Kolkata')::date)
          and (scope = 'all' or scope = 'money')`,
    )
    assert('the send gate\'s own predicate finds a money mute', muted.length === 1, muted)

    const notMuted = await all(
      `select scope from comm_preference
        where contact_id = '${contact.id}'::uuid and released_at is null
          and (scope = 'all' or scope = 'reminders')`,
    )
    assert('and does not find it for a scope they did not mute', notMuted.length === 0, notMuted)

    /* -- 7 · a decision is not an outage (F-AT) ----------------------------- */
    let suppressedOk = true
    try {
      await tx.savepoint(async (sp) => {
        await sp.unsafe(
          `insert into message (academy_id, contact_id, sender_id, direction, status, suppressed_reason, body)
           values (${A}, '${contact.id}'::uuid, '${SENDER}'::uuid, 'outbound', 'suppressed', 'muted', 'x')`,
        )
      })
    } catch (e) {
      suppressedOk = false
      console.log(`        ${e instanceof Error ? e.message : String(e)}`)
    }
    assert("'suppressed' is a status a message may hold", suppressedOk)
  })
} finally {
  await withSession(ctx, async (tx) => {
    await tx.unsafe(`delete from job where payload->>'academy_id' = '${academyId}'`)
    await tx.unsafe(`delete from academy where id = ${A}`)
  })
  console.log('\nscratch tenant removed.')
}

console.log(failures === 0 ? '\nall clear.\n' : `\n${failures} failed.\n`)
process.exit(failures === 0 ? 0 : 1)

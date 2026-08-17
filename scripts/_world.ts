/**
 * _world — a settled academy, five weeks old, with money already in it.
 *
 * WHY NOT A SEEDED WORLD, AND WHY NOT AN EMPTY ONE
 * -----------------------------------------------------------------------------
 * `seedWorld` builds two fixed businesses that every instrument in the repo has
 * already been driven through; `createAcademy` builds a shell with one person in
 * it. Neither is the state a live-persona week needs. A persona week is a week in
 * a business that is ALREADY RUNNING — where "what does everyone owe me" has a
 * real answer, where a parent asking "what do I owe" is asking about a row that
 * exists, and where a coach asking what he earned is asking about sessions he
 * actually taught. Every one of those questions is trivially answerable in an
 * empty world and the answer means nothing.
 *
 * WHAT MAKES THIS SHAPE THE INTERESTING ONE
 * -----------------------------------------------------------------------------
 * **The owner coaches.** Rahul holds an `academy_admin` row AND a `coach` row over
 * one `person`. That is the business this product is sold into and it is the one
 * shape a role column cannot express. Every permission question worth asking
 * lives in that gap: what Arjun may see of a family's money, what Rahul sees as
 * owner that he would not see as coach, and whether the product ever confuses the
 * two hats on one head.
 *
 * **Four families, not one.** A single family makes every money question a
 * question about that family. Four — one of them with two children on two
 * different classes, one of them a month behind — is the smallest roster where
 * "who owes me" has a shape rather than an answer.
 *
 * **Last month is closed and this month is open.** The ledger carries a settled
 * period behind it and a live one in front, so a question about money can be
 * wrong in the specific way this product gets money wrong: right number, wrong
 * period.
 *
 * WHAT IS DELIBERATELY LEFT OUT
 * -----------------------------------------------------------------------------
 * Sessions. They are not inserted here — `planAheadFor` materialises them from the
 * class slots, which is the product's own machinery, and a fixture that wrote them
 * by hand would be testing the harness's idea of a timetable rather than the
 * product's.
 *
 * There is also no sibling discount, no makeup policy and no Saturday rule in
 * here, and that is not an omission. Three of the four personas ask about exactly
 * those this week. What the product does when a policy does not exist yet — invent
 * one, refuse, or ask the owner — is the single most repeated failure in this
 * repo's ledger, and a fixture that pre-answered it would hide it.
 */
type Q = <T = any>(sql: string) => Promise<T[]>

export type BuiltWorld = {
  academyId: string
  /** persona key → contact id, for the seats that have one. */
  contacts: Record<string, string>
  /** Everyone in the world with a phone, for the record. */
  roster: { name: string; role: string; contactId: string; phone: string }[]
  q: Q
}

const ACADEMY_NAME = 'Ace Tennis Academy'
const TZ = 'Asia/Kolkata'

/**
 * Build it, dropping any business this builder left behind before.
 *
 * Scoped to the EXACT name this file uses, and this file is the only thing that
 * creates it. A run that throws part-way never reaches its teardown, so the
 * business survives — and every tenant shares one sender, which means the next
 * run's contacts sit beside the last run's on the same number space. An inbound
 * matching two contacts resolves to neither and the turn simply never happens.
 *
 * Enumerated through `worldAcademyIds()` and read one tenant at a time, NOT with a
 * single `select … from academy`. Every `cm_service` policy is
 * `academy_id = app.academy_id()`, so with no GUC set the comparison is NULL and
 * every tenant-scoped table reads empty — `academy` included. A cleanup written
 * that way finds nothing, reports success, and leaves the previous run standing.
 */
export async function buildSettledAcademy(o: { log?: (s: string) => void } = {}): Promise<BuiltWorld> {
  const log = o.log ?? (() => {})
  const { createAcademy, createTestContact, dropAcademy, worldAcademyIds } = await import('@/lib/seed')
  const { withSession } = await import('@/lib/db')

  for (const id of await worldAcademyIds({ refresh: true })) {
    const [row] = await withSession({ role: 'service', academyId: id }, async (tx) =>
      (await tx`select name from academy where id = ${id}::uuid`) as unknown as { name: string }[],
    )
    if (row?.name !== ACADEMY_NAME) continue
    log(`clearing a previous run: ${id}`)
    await dropAcademy(id).catch((e) => log(`could not drop ${id}: ${(e as Error).message}`))
  }

  const made = await createAcademy({
    name: ACADEMY_NAME,
    adminName: 'Rahul Menon',
    timezone: TZ,
    category: 'tennis',
  })
  const academyId = made.academyId
  const q: Q = async <T = any>(sql: string): Promise<T[]> =>
    withSession({ role: 'service', academyId }, async (tx) => (await tx.unsafe(sql)) as unknown as T[])

  await worldAcademyIds({ refresh: true })

  /**
   * Start the week on a Monday morning, on this tenant's own clock.
   *
   * Not cosmetic. The classes run on weekdays — Evening Batch on Monday and
   * Thursday, Weekend Squad on Saturday — and every persona's week assumes day 1
   * is a Monday: the coach's register is a Monday register, the stranger wants to
   * watch on Saturday, the owner asks on Sunday how the week went. A run that
   * opened on a Thursday would put the Saturday visit on a Tuesday and the whole
   * narrative would be about a timetable that is not there.
   *
   * It is also 06:00 rather than whenever the build happened to finish. The
   * previous version opened at 23:32, and `walkTo('08:30')` cannot walk
   * backwards, so day 1's morning window silently happened at half past eleven at
   * night — every standing job for the day already fired, and the owner's first
   * question of the "morning" arrived after the digest it was supposed to precede.
   *
   * Set BEFORE any history is written, so every `app.now() - N days` below is
   * relative to the week that is about to happen rather than to real time.
   */
  const clock = await import('@/lib/clock')
  const { DateTime } = await import('luxon')
  let monday = DateTime.now().setZone(TZ).startOf('week').set({ hour: 6, minute: 0, second: 0, millisecond: 0 })
  if (monday <= DateTime.now().setZone(TZ)) monday = monday.plus({ weeks: 1 })
  await clock.setTo(monday.toJSDate(), academyId)
  log(`clock set to ${monday.toFormat('EEE d LLL yyyy, HH:mm')} ${TZ}`)

  // Numbers derived from the academy id, so two runs never collide on the shared
  // sender's number space and a leftover contact from a crashed run is visibly
  // from a different academy rather than silently ambiguous.
  const digits = academyId.replace(/\D/g, '').padEnd(9, '0')
  const phone = (n: number) => `+9193${digits.slice(0, 7)}${n}`

  /**
   * The owner's number, moved into this run's block.
   *
   * `createAcademy` hands out a number from a fixed range, and every tenant in
   * this database shares one sender. `ingestInbound` resolves an inbound by
   * (phone, sender) across academies and takes the first match — so two
   * businesses holding the same number on the same sender route one person's
   * messages to whichever tenant is enumerated first, silently. Every other
   * contact here is already run-scoped; the owner was the one that was not.
   */
  await q(`update contact set phone_e164 = '${phone(0)}', wa_id = '${phone(0).replace(/\D/g, '')}'
            where id = '${made.adminContactId}'::uuid`)

  const arjun = await createTestContact({ academyId, name: 'Arjun Shetty', role: 'coach', phone: phone(1) })
  const priya = await createTestContact({ academyId, name: 'Priya Nair', role: 'coach', phone: phone(2) })
  const divya = await createTestContact({ academyId, name: 'Divya Rao', role: 'client', phone: phone(3) })
  const meera = await createTestContact({ academyId, name: 'Meera Iyer', role: 'client', phone: phone(4) })
  const sanjay = await createTestContact({ academyId, name: 'Sanjay Gupta', role: 'client', phone: phone(5) })
  const latha = await createTestContact({ academyId, name: 'Latha Krishnan', role: 'client', phone: phone(6) })
  const farah = await createTestContact({ academyId, name: 'Farah Sheikh', role: 'prospect', phone: phone(7) })
  await worldAcademyIds({ refresh: true })

  /** The owner's second hat. Two rows, one person, and the whole permission question. */
  await q(`
    insert into coach (academy_id, person_id, pay_amount, pay_unit, status, onboarded_at)
    values ('${academyId}'::uuid, '${made.adminPersonId}'::uuid, 0, 'per_month', 'active', app.now())
    on conflict do nothing`)

  // What the two employed coaches are paid — the numbers Rahul has to find before
  // he can answer Priya about a raise. Deliberately different units: Arjun is per
  // session and Priya per month, so "what am I paying everyone" cannot be answered
  // by summing one column.
  await q(`
    update coach co set pay_amount = 600, pay_unit = 'per_session'
      from person p where p.id = co.person_id and p.full_name = 'Arjun Shetty'`)
  await q(`
    update coach co set pay_amount = 9000, pay_unit = 'per_month'
      from person p where p.id = co.person_id and p.full_name = 'Priya Nair'`)

  await q(`insert into venue (academy_id, name) values ('${academyId}'::uuid, 'Ace Courts')`)

  // Four classes across the week so no day is empty, Saturday is a real fixture
  // rather than a hypothetical, and the two rates a family might be quoted differ.
  const classes: [string, number, string, string, number, string][] = [
    ['Morning Juniors', 1, '07:00', '08:00', 900, 'per_month'],
    ['Morning Juniors', 3, '07:00', '08:00', 900, 'per_month'],
    ['Evening Batch', 1, '18:00', '19:00', 2400, 'per_month'],
    ['Evening Batch', 4, '18:00', '19:00', 2400, 'per_month'],
    ['Weekend Squad', 6, '09:00', '10:30', 1200, 'per_month'],
    ['Adult Beginners', 2, '19:30', '20:30', 1800, 'per_month'],
    ['Adult Beginners', 5, '19:30', '20:30', 1800, 'per_month'],
  ]
  for (const [name, weekday, from, to, rate, unit] of classes) {
    await q(`
      insert into class (academy_id, name, venue_id, rate_amount, rate_unit, starts_on, active)
      select '${academyId}'::uuid, '${name}', v.id, ${rate}, '${unit}',
             (app.now() - interval '38 days')::date, true
        from venue v
       where v.name = 'Ace Courts'
         and not exists (select 1 from class where name = '${name}' and active and ends_on is null)`)
    await q(`
      insert into class_slot (academy_id, class_id, weekday, start_time, end_time)
      select '${academyId}'::uuid, c.id, ${weekday}, time '${from}', time '${to}'
        from class c where c.name = '${name}' and c.active and c.ends_on is null`)
  }

  // Rahul takes the mornings and shares the weekend; Arjun the evenings; Priya the
  // weekend and the adult class — so her Saturday drop-out actually uncovers a
  // session, and Arjun offering to cover it is a real offer about real money.
  const assign: [string, string][] = [
    ['Morning Juniors', 'Rahul Menon'],
    ['Evening Batch', 'Arjun Shetty'],
    ['Weekend Squad', 'Priya Nair'],
    ['Weekend Squad', 'Rahul Menon'],
    ['Adult Beginners', 'Priya Nair'],
  ]
  for (const [cls, who] of assign) {
    await q(`
      insert into class_coach (academy_id, class_id, coach_id)
      select '${academyId}'::uuid, c.id, co.id
        from class c, coach co join person p on p.id = co.person_id
       where c.name = '${cls}' and c.active and c.ends_on is null and p.full_name = '${who}'
      on conflict do nothing`)
  }

  /**
   * The children.
   *
   * `createTestContact` makes the parent their own player, which is right for an
   * adult learner and wrong for every family here — so each parent's auto-player
   * is retired and the actual child is added under the same account. Sanjay has
   * two, on two different classes, because a sibling discount asked about by a
   * stranger has to have somewhere real to land.
   */
  const kids: [string, string, string][] = [
    ['Divya Rao', 'Anika Rao', 'Evening Batch'],
    ['Meera Iyer', 'Vivaan Iyer', 'Morning Juniors'],
    ['Sanjay Gupta', 'Ishaan Gupta', 'Evening Batch'],
    ['Sanjay Gupta', 'Riya Gupta', 'Morning Juniors'],
    ['Latha Krishnan', 'Tara Krishnan', 'Weekend Squad'],
  ]
  for (const [parent, kid, cls] of kids) {
    await q(`insert into person (academy_id, full_name) values ('${academyId}'::uuid, '${kid}')`)
    await q(`
      insert into player (academy_id, account_id, person_id, active)
      select '${academyId}'::uuid, a.id, k.id, true
        from account a join person h on h.id = a.holder_person_id, person k
       where h.full_name = '${parent}' and k.full_name = '${kid}'`)
    await q(`
      insert into enrollment (academy_id, class_id, player_id, started_on)
      select '${academyId}'::uuid, c.id, pl.id, (app.now() - interval '33 days')::date
        from class c, player pl join person p on p.id = pl.person_id
       where c.name = '${cls}' and c.active and c.ends_on is null and p.full_name = '${kid}'
       limit 1`)
  }
  // The parent is not a player. Retired rather than deleted so nothing that
  // already points at the row breaks, and so the state is visible if it matters.
  await q(`
    update player pl set active = false
      from person p, account a
     where p.id = pl.person_id and a.id = pl.account_id and a.holder_person_id = p.id`)
  await q(`
    delete from enrollment e using player pl, account a
     where e.player_id = pl.id and a.id = pl.account_id and a.holder_person_id = pl.person_id`)

  /**
   * Last month billed and mostly paid; this month billed and mostly not.
   *
   * Written straight in, because this is the business's HISTORY rather than
   * anything the product is being asked to do — the period-close machinery is
   * itself under test this week and a fixture that ran it would be measuring the
   * thing it is supposed to be background for.
   *
   * The distribution is the point: Meera is square, Sanjay has paid one child's
   * worth of a two-child bill, Latha is a whole month behind, and Divya has not
   * paid this month at all (she pays on day 5, which is the turn worth reading).
   */
  const periodSql = (offsetMonths: number) =>
    `(date_trunc('month', (app.now() at time zone '${TZ}')) - interval '${offsetMonths} month')::date`

  /**
   * ONLY the closed month. The open one is the product's to write.
   *
   * The first version of this wrote both, and the product's own monthly billing
   * job then wrote the current period again on top of it — so every family's
   * August bill was doubled. A parent asked what she owed and was told ₹4,800.
   *
   * The product noticed, said the ledger was wrong, and told her not to pay,
   * which is the best thing it did all week — but the duplicate was the harness's
   * and every money reading downstream of it was measuring a fixture bug. A
   * fixture writes HISTORY. Anything the product bills for itself, it bills.
   */
  for (const back of [1]) {
    await q(`
      insert into tally_line (academy_id, account_id, player_id, period, kind, description, amount)
      select '${academyId}'::uuid, a.id, pl.id, ${periodSql(back)}, 'monthly',
             c.name || ' — ' || to_char(${periodSql(back)}, 'FMMonth YYYY') || ' fees',
             c.rate_amount
        from enrollment e
        join player pl on pl.id = e.player_id
        join account a on a.id = pl.account_id
        join class c on c.id = e.class_id
       where e.ended_on is null and pl.active`)
  }

  // Last month: everybody paid except Latha.
  await q(`
    insert into payment (academy_id, account_id, amount, rail, method, reference, status, requested_at, confirmed_at)
    select '${academyId}'::uuid, a.id, sum(tl.amount), 'rail1', 'upi',
           'UPI' || lpad((row_number() over (order by a.id))::text, 8, '0'),
           'confirmed', app.now() - interval '30 days', app.now() - interval '29 days'
      from tally_line tl join account a on a.id = tl.account_id
      join person h on h.id = a.holder_person_id
     where tl.period = ${periodSql(1)} and h.full_name <> 'Latha Krishnan'
     group by a.id`)

  /**
   * This month, paid early: Meera is square and Sanjay has paid one of his two
   * children's worth.
   *
   * Fixed amounts rather than a sum over `tally_line`, because the current
   * period's lines do not exist yet at this point — the product writes them
   * itself, on the first drain after this returns. A payment that arrives before
   * the bill is written is not an anomaly either; families here pay by standing
   * habit on a date, not in response to an invoice.
   */
  const paidEarly: [string, number, string, number][] = [
    ['Meera Iyer', 900, 'UPI55510001', 6],
    ['Sanjay Gupta', 900, 'UPI55510002', 4],
  ]
  for (const [who, amount, ref, daysAgo] of paidEarly) {
    await q(`
      insert into payment (academy_id, account_id, amount, rail, method, reference, status, requested_at, confirmed_at)
      select '${academyId}'::uuid, a.id, ${amount}, 'rail1', 'upi', '${ref}', 'confirmed',
             app.now() - interval '${daysAgo} days', app.now() - interval '${daysAgo} days'
        from account a join person h on h.id = a.holder_person_id
       where h.full_name = '${who}'`)
  }

  await q(`update academy set onboarding_state = 'live' where id = '${academyId}'::uuid`)

  const roster = await q<{ name: string; role: string; contactId: string; phone: string }>(`
    select p.full_name as name,
           coalesce(c.role_hint, c.state) as role,
           c.id::text as "contactId",
           c.phone_e164 as phone
      from contact c join person p on p.id = c.person_id
     order by p.full_name`)

  return {
    academyId,
    contacts: {
      rahul: made.adminContactId,
      arjun: arjun.contactId,
      priya: priya.contactId,
      divya: divya.contactId,
      meera: meera.contactId,
      sanjay: sanjay.contactId,
      latha: latha.contactId,
      farah: farah.contactId,
    },
    roster,
    q,
  }
}

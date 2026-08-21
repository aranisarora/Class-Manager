/**
 * _arrivals — the people a business gains while the week is still running.
 *
 *   import { arrivals, specFromAcademy } from './_arrivals'
 *   const joined = await arrivals({ academyId, days, known: new Set(Object.keys(briefs)) })
 *
 * The leading underscore means what it means everywhere else here: not a command.
 *
 * WHY A SEAT CANNOT BE DECIDED AT START-UP
 * -----------------------------------------------------------------------------
 * `sim.ts` used to fix its roster before the first sentence was typed: one child
 * process per persona, spawned from the world spec, for the whole week. That is
 * right for a settled academy, where everybody who will ever message already has
 * a row. It is wrong for every other world, and it is *silently* wrong.
 *
 * A blank world is an owner and a phone. The week's whole subject is him building
 * a business — he names classes, he writes down families, he types in the number
 * of a parent who rang the board. Every one of those people gets a `contact` row
 * and starts receiving what this product sends: the reminder before a session,
 * the fee request, the digest. Under a fixed roster **nobody was reading any of
 * it**. The product wrote to twelve phones and the record showed twelve outbound
 * messages and zero replies — which is indistinguishable, in the record and in
 * every judgement made off it, from a product whose messages were ignored.
 *
 * So the roster is a question asked after every window rather than an answer
 * given before the run. Somebody who has a phone and no seat gets one, and they
 * get it in the state the business is actually in when they arrive.
 *
 * THE FACTS COME FROM THE DATABASE, WHICH IS THE ONLY PLACE THEY EXIST
 * -----------------------------------------------------------------------------
 * `briefsFromWorld` composes a brief out of a world *spec*, and the guarantee
 * that buys is the one this repo cares most about: no sentence in a brief can
 * contradict the rows, because the rows were built from the same object. A coach
 * told his batch ran Monday and Thursday, in a world that ran Monday and
 * Wednesday, produced a turn that read as a product defect and was a harness one.
 *
 * A newcomer has no spec. Nobody wrote them down — the owner typed them into a
 * chat on Wednesday and the product wrote the rows. So this module reads the
 * academy back out of the database into the shape a spec has, and hands *that* to
 * the same composer. The guarantee is not weakened by doing it this way; if
 * anything it is stronger, because the spec a settled world was built from is a
 * statement about the moment of the build, and this is a statement about now.
 *
 * WHAT IT REFUSES TO INVENT
 * -----------------------------------------------------------------------------
 * `life` — what happens to somebody on a given day — has no derived half and
 * never gets one. A generated life event is invention handed to a seat as
 * circumstance, and `_personas.ts` says so where it composes a spec world's
 * briefs. A newcomer's `life` is therefore empty, and their phone says nothing
 * unusual is happening. What they have instead is the thing that actually
 * happened: a business they have just been put on the books of, and no idea what
 * the number that keeps messaging them is.
 *
 * A person with no `contact` row is not an arrival. A child on a register is a
 * `player` and has no phone; seating one would be inventing a nine-year-old with
 * a mobile. The rule is exactly "has a number the product can reach", because
 * that is the rule for whether this product can talk to somebody at all.
 */
import type { Brief } from './_personas'
import type { Day, NormalSpec, PayUnit, RateUnit } from './_world-spec'

import { briefsFromWorld } from './_personas'
import { q } from './_seat'
import { DAYS } from './_world-spec'

/** Somebody who has just turned up, with everything a seat needs to sit down. */
export type Arrival = {
  /** The seat key — `client-meghna-joshi` — as `briefsFromWorld` derives it. */
  key: string
  brief: Brief
  contactId: string
  phone: string
}

/**
 * `HH:MM` out of a `time` column, whatever shape the driver hands it back in.
 *
 * `postgres` returns `time` as a string (`'16:30:00'`), but a slot written by the
 * product through a parameterised insert can come back with the seconds and a
 * fractional part on it. A spec wants `16:30` and `briefFromWorld` prints it
 * verbatim into a sentence somebody reads, so a coach otherwise learns his class
 * runs at `16:30:00.000`.
 */
const hhmm = (v: unknown): string => String(v ?? '').trim().slice(0, 5) || '00:00'

/**
 * Only the two units a brief can say out loud.
 *
 * `class.rate_unit` also allows `per_term` and `per_package`, which carry a
 * `rate_count` — "₹9,000 a term, and a term is four months" — and there is no
 * sentence in `_personas.ts` that renders one. Passing the unit through anyway
 * would print "₹9,000 per_term" at somebody; dropping the rate along with it
 * leaves the brief silent about price, which is a gap rather than a falsehood.
 * A person who was never told the price is a real person, and a common one.
 */
const rateUnit = (v: unknown): RateUnit | undefined =>
  v === 'per_month' || v === 'per_session' ? v : undefined

const payUnit = (v: unknown): PayUnit | undefined =>
  v === 'per_session' || v === 'per_month' ? v : undefined

/**
 * The academy as it stands right now, in the shape `briefsFromWorld` takes.
 *
 * A `NormalSpec` rather than a `WorldSpec`: every count is already a list of
 * names, because the database has never held a count — it holds people. That is
 * also what `_personas.normalised` demands, and its refusal names the raw form
 * explicitly, so returning anything looser would fail at the far end of a run.
 *
 * Read as the service role with this tenant's GUC set, which is `q`'s whole job.
 * Every query below is scoped by RLS to this academy and says nothing about
 * anybody else's; none of them may be run without the academy id.
 */
export async function specFromAcademy(academyId: string): Promise<NormalSpec> {
  const [academy] = await q<{ name: string; category: string | null; timezone: string | null }>(
    academyId,
    `select name, category, timezone from academy limit 1`,
  )
  if (!academy) throw new Error(`no academy ${academyId} — it was deleted underneath this run`)

  const admins = await q<{ person_id: string; full_name: string }>(
    academyId,
    `select a.person_id::text, p.full_name
       from academy_admin a join person p on p.id = a.person_id
      order by p.full_name`,
  )
  const coachRows = await q<{
    person_id: string
    coach_id: string
    full_name: string
    pay_amount: string | null
    pay_unit: string | null
  }>(
    academyId,
    `select c.person_id::text, c.id::text as coach_id, p.full_name, c.pay_amount, c.pay_unit
       from coach c join person p on p.id = c.person_id
      where c.ended_on is null
      order by p.full_name`,
  )

  /**
   * The owner, and whether he also stands on a court.
   *
   * `admin.coaches` is one boolean in a spec and two rows in the database — an
   * `academy_admin` and a `coach` over one `person`. That is the business this
   * product is sold into and the one shape a role column cannot express, so it is
   * asked as "does the admin's person id also appear in coach", never guessed
   * from a name.
   */
  const adminPersonId = admins[0]?.person_id ?? ''
  const adminName = admins[0]?.full_name ?? 'the owner'
  const adminCoaches = coachRows.some((c) => c.person_id === adminPersonId)

  const classRows = await q<{
    id: string
    name: string
    rate_amount: string | null
    rate_unit: string | null
  }>(
    academyId,
    `select id::text, name, rate_amount, rate_unit
       from class where active and (ends_on is null or ends_on >= (app.now())::date)
      order by name`,
  )
  const slots = await q<{ class_id: string; weekday: number; start_time: string; end_time: string }>(
    academyId,
    `select class_id::text, weekday, start_time::text, end_time::text
       from class_slot order by weekday, start_time`,
  )
  const teaching = await q<{ class_id: string; full_name: string }>(
    academyId,
    `select cc.class_id::text, p.full_name
       from class_coach cc
       join coach c on c.id = cc.coach_id
       join person p on p.id = c.person_id`,
  )

  /**
   * A class with no slot is dropped, and so is every enrolment that names it.
   *
   * Half a class is what this product looks like mid-setup: the owner says "put
   * in a beginners batch" and the name lands before the days do. `briefFromWorld`
   * renders `when(cls)` into a sentence — "Monday and Wednesday, 4:30 to 5:45" —
   * and a class with an empty `days` renders an empty one. Nobody is told about a
   * class that has no time yet, which is the truth of it: there is nothing to
   * tell them.
   *
   * The enrolments have to go with it or the composer is handed a child in a
   * class the spec does not list, which is the exact contradiction this whole
   * arrangement exists to prevent.
   */
  const classes = classRows
    .map((cls) => {
      const days = slots
        .filter((s) => s.class_id === cls.id)
        .map((s) => DAYS[Number(s.weekday)])
        .filter((d): d is Day => !!d)
      const first = slots.find((s) => s.class_id === cls.id)
      const rate = cls.rate_amount === null ? undefined : Number(cls.rate_amount)
      const unit = rateUnit(cls.rate_unit)
      return {
        id: cls.id,
        name: cls.name,
        days: [...new Set(days)],
        from: hhmm(first?.start_time),
        to: hhmm(first?.end_time),
        ...(rate !== undefined && unit ? { rate, unit } : {}),
        coaches: teaching.filter((t) => t.class_id === cls.id).map((t) => t.full_name),
      }
    })
    .filter((cls) => cls.days.length > 0)
  const namedClass = new Map(classes.map((cls) => [cls.id, cls.name]))

  /**
   * Who is on the books, as accounts rather than as people.
   *
   * `account.holder_person_id` is the one who is billed, and `player` is the one
   * who turns up — the same human when an adult learns here, two humans when a
   * parent has a child on a register. A spec says that with `children: []` versus
   * `children: [{…}]`, and getting it backwards tells a parent they are the one
   * in the class.
   */
  const accounts = await q<{ id: string; holder_person_id: string; holder: string }>(
    academyId,
    `select a.id::text, a.holder_person_id::text, p.full_name as holder
       from account a join person p on p.id = a.holder_person_id
      order by p.full_name`,
  )
  const players = await q<{ id: string; account_id: string; person_id: string; full_name: string }>(
    academyId,
    `select pl.id::text, pl.account_id::text, pl.person_id::text, p.full_name
       from player pl join person p on p.id = pl.person_id
      where pl.active`,
  )
  const enrolled = await q<{ player_id: string; class_id: string }>(
    academyId,
    `select player_id::text, class_id::text from enrollment where ended_on is null`,
  )
  const classOf = (playerId: string): string | undefined => {
    for (const e of enrolled) {
      if (e.player_id !== playerId) continue
      const name = namedClass.get(e.class_id)
      if (name) return name
    }
    return undefined
  }

  /**
   * The owner's own account is not a client of his own business.
   *
   * `createTestContact` opens an account for anybody it puts in the chair, so the
   * admin frequently holds one with nothing in it. Left in, the week seats the
   * owner twice — once as himself and once as a customer with no children — and
   * the second one spends a model call every window asking his own product what
   * he is paying himself.
   */
  const staff = new Set([adminPersonId, ...coachRows.map((c) => c.person_id)])

  const clients = accounts
    .filter((a) => !staff.has(a.holder_person_id))
    .map((a) => {
      const mine = players.filter((p) => p.account_id === a.id)
      const self = mine.find((p) => p.person_id === a.holder_person_id)
      const children = mine
        .filter((p) => p.person_id !== a.holder_person_id)
        .map((p) => {
          const cls = classOf(p.id)
          return { name: p.full_name, ...(cls ? { class: cls } : {}) }
        })
      const own = self ? classOf(self.id) : undefined
      return {
        name: a.holder,
        children,
        ...(children.length === 0 && own ? { class: own } : {}),
      }
    })

  /**
   * Everybody else with a number: known to the business, on nothing.
   *
   * That is the definition of a prospect here and it is a role, not a guess —
   * `briefFromWorld`'s prospect brief opens "You are not a customer… you have
   * their number, and that is the whole of it", which is precisely true of a
   * contact with no account, no player row, no coach row and no admin row. It is
   * also the commonest thing in the first week of a business: somebody rang the
   * number on the board and the owner wrote them down.
   */
  const contacts = await q<{ person_id: string; full_name: string }>(
    academyId,
    `select ct.person_id::text, p.full_name
       from contact ct join person p on p.id = ct.person_id
      where ct.opted_out_at is null
      order by p.full_name`,
  )
  const placed = new Set([
    ...staff,
    ...accounts.map((a) => a.holder_person_id),
    ...players.map((p) => p.person_id),
  ])
  const prospects = contacts
    .filter((ct) => !placed.has(ct.person_id))
    .map((ct) => ({ name: ct.full_name }))

  return {
    name: academy.name,
    category: academy.category ?? 'sport',
    timezone: academy.timezone ?? 'Asia/Kolkata',
    admin: { name: adminName, coaches: adminCoaches },
    coaches: coachRows
      .filter((c) => c.person_id !== adminPersonId)
      .map((c) => {
        const pay = c.pay_amount === null ? undefined : Number(c.pay_amount)
        const unit = payUnit(c.pay_unit)
        return { name: c.full_name, ...(pay !== undefined ? { pay } : {}), ...(unit ? { unit } : {}) }
      }),
    clients,
    prospects,
    classes: classes.map(({ id: _id, ...rest }) => rest),
  }
}

/**
 * Everybody with a phone this run is not already playing.
 *
 * `known` is the set of seat keys the run already has, and the diff is on the key
 * rather than on the name because that is what `sim.ts` schedules, what
 * `briefs.json` is keyed by and what the record calls them. `briefsFromWorld`
 * derives a key from the role and the name — `client-meghna-joshi` — so the same
 * person read twice is the same key twice, and a person the owner renames is a
 * new seat. That last one is a real cost and the alternative is worse: keying on
 * a person id would make a brief's key untraceable to the person it is about in
 * every file a human being reads.
 *
 * A name with no contact is skipped rather than refused. Half this list is
 * children, and a nine-year-old on a register is not somebody who can be
 * messaged.
 */
export async function arrivals(o: {
  academyId: string
  days: number
  known: Set<string>
}): Promise<Arrival[]> {
  const spec = await specFromAcademy(o.academyId)
  const reachable = new Map(
    (
      await q<{ id: string; phone_e164: string; full_name: string }>(
        o.academyId,
        `select ct.id::text, ct.phone_e164, p.full_name
           from contact ct join person p on p.id = ct.person_id
          where ct.opted_out_at is null
          order by ct.is_primary desc nulls last, ct.created_at asc`,
      )
    )
      // Reversed so the FIRST contact of a person wins the map — `order by` above
      // puts the primary first, and a second number for one human is the same
      // human, not a second seat.
      .reverse()
      .map((ct) => [ct.full_name, ct]),
  )

  const out: Arrival[] = []
  for (const brief of briefsFromWorld({ spec, days: o.days })) {
    if (o.known.has(brief.key)) continue
    const ct = reachable.get(brief.name)
    if (!ct) continue
    out.push({ key: brief.key, brief, contactId: ct.id, phone: ct.phone_e164 })
  }
  return out
}

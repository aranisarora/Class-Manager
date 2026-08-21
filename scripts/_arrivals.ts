/**
 * _arrivals — whoever the business gained since the last window, given a seat.
 *
 * WHY THE ROSTER IS A QUESTION AND NOT A DECISION
 * -----------------------------------------------------------------------------
 * The seats used to be fixed at start-up, which is right for a business that
 * already exists and silently wrong everywhere else. Every customer the owner
 * created was a person nobody was playing, so the product wrote to twelve phones
 * and the record showed twelve outbound messages and no replies — which cannot be
 * told, in the record or in any judgement made off it, from a product everybody
 * ignored.
 *
 * It matters far more now than it did. A run opens with a sender, a front desk
 * and some people holding phones — no business at all — so **everybody except the
 * founders arrives this way.** The coach hired on Wednesday, the family written
 * down on Tuesday, the stranger whose number the owner typed off the back of a
 * receipt: each gets a brief and a child process of their own from that window on.
 *
 * WHAT A NEW PERSON KNOWS, AND WHAT THEY CANNOT
 * -----------------------------------------------------------------------------
 * Their role, their name, and nothing else. They get no `life`, because a fever
 * on Tuesday is narrative and nothing in a row implies one — a generated life
 * event would be invention handed to a seat as circumstance. What they have
 * instead is the thing that actually happened: a business they have just been put
 * on the books of, and no idea what the number that keeps messaging them is.
 *
 * A person with no `contact` row is not an arrival. A child on a register is a
 * `player` and has no phone; seating one would be inventing a nine-year-old with
 * a mobile. The rule is exactly "has a number the product can reach", because
 * that is the rule for whether this product can talk to somebody at all.
 *
 * WHAT LEFT THIS FILE
 * -----------------------------------------------------------------------------
 * Two hundred lines that read a live academy back OUT into a `NormalSpec` —
 * classes, slots, pay units, enrolments — so that `briefsFromWorld` could derive
 * a brief from it. That existed because the harness used to write those rows
 * before anybody spoke, and a brief had to agree with them or it would describe a
 * business that was not there.
 *
 * Nothing writes rows before anybody speaks any more, so there is nothing to
 * agree with and nothing to reconstruct. A role comes off three `exists`
 * subqueries, and the words come from `briefFor` like everybody else's.
 */
import type { SeatRole } from './_personas'
import type { Brief } from './_personas'

import { briefFor } from './_personas'
import { keyOf } from './_world-file'
import { q } from './_seat'

/** Somebody who has just turned up, with everything a seat needs to sit down. */
export type Arrival = {
  /** The seat key — `meghna-joshi` — derived from the name exactly as a world file's is. */
  key: string
  brief: Brief
  contactId: string
  phone: string
}

/**
 * Everybody this business can reach who is not already at a phone.
 *
 * The role is asked of the rows rather than guessed, in the order that decides
 * what somebody IS when they are several things at once. The owner who also
 * coaches is an **admin** — every permission question worth asking lives in that
 * gap, and reading them as a coach would give them a coach's blindfold about
 * money in a week where they are the one being asked about it.
 *
 * `known` is the set of seat keys already seated. It is passed in rather than
 * re-derived because the caller is the only thing that knows who it spawned, and
 * a person seated twice gets two child processes reading one phone — both see the
 * same messages, both reply, and the transcript shows somebody arguing with
 * themselves.
 */
export async function arrivals(o: {
  academyId: string
  days: number
  known: Set<string>
  worldName: string
}): Promise<Arrival[]> {
  const rows = await q<{
    id: string
    phone_e164: string
    full_name: string
    is_admin: boolean
    is_coach: boolean
    is_client: boolean
  }>(
    o.academyId,
    `select ct.id::text, ct.phone_e164, p.full_name,
            exists (select 1 from academy_admin aa where aa.person_id = p.id) as is_admin,
            exists (select 1 from coach c where c.person_id = p.id and c.status = 'active') as is_coach,
            exists (select 1 from account ac where ac.holder_person_id = p.id) as is_client
       from contact ct join person p on p.id = ct.person_id
      where ct.opted_out_at is null
      order by ct.is_primary desc nulls last, ct.created_at asc`,
  )

  const seen = new Set<string>()
  const out: Arrival[] = []
  for (const r of rows) {
    const key = keyOf(r.full_name)
    // The FIRST contact of a person wins: `order by` puts the primary first, and
    // a second number for one human is the same human, not a second seat.
    if (seen.has(key) || o.known.has(key)) continue
    seen.add(key)

    const seat: SeatRole =
      r.is_admin ? 'admin'
      : r.is_coach ? 'coach'
      : r.is_client ? 'client'
      : 'prospect'

    out.push({
      key,
      contactId: r.id,
      phone: r.phone_e164,
      brief: briefFor({
        person: {
          name: r.full_name,
          seat,
          about: ABOUT[seat],
          life: {},
        },
        worldName: o.worldName,
        days: o.days,
      }),
    })
  }
  return out
}

/**
 * What somebody knows about their own situation on the day they appear.
 *
 * Written from the row and no further. It says they have just been added and that
 * they did not ask for this, because both are true of everybody who arrives this
 * way — and it says nothing about what the business runs, what it costs or who
 * else is in it, because that is the derivation this file just stopped doing.
 * Finding all that out is what their week is for.
 */
const ABOUT: Record<SeatRole, string> = {
  admin: `You have just been given admin on a business here. You did not set it up
and you are not sure what has already been done in it.`,
  coach: `Somebody has just put you down as a coach here. Nobody has told you what
you are taking, when, or what it pays. You would like all three, quickly.`,
  client: `Your name has just gone on the books of a coaching business, and a number
you do not recognise has started messaging you about it. You want to know what you
have signed up for and what it is going to cost.`,
  prospect: `Somebody has taken your number down. You have not agreed to anything and
you have not paid anybody. You want to know what this is before you decide.`,
}

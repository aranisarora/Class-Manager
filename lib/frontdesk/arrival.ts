/**
 * lib/frontdesk/arrival.ts — the funnel row (0039).
 *
 * One row per number that ever reached a front desk: who arrived, what they opened
 * with, whether the product had to ask which side they were on, and where they went.
 *
 * It exists because of Layer 0's rule — *if anyone could ever ask about it, it is a
 * row* — and because of the question nobody has ever been able to answer: **how many
 * strangers did this product turn away?** Before 0039 the answer was unknowable by
 * construction. An unmatched inbound returned `unresolved`, no `message` row was
 * written and no turn ran, so the only trace a stranger left was a line in a webhook
 * log that nothing reads. Referral makes that the expensive blind spot: the vendor is
 * about to acquire tenants through a channel it cannot see.
 *
 * The row is opened on arrival, not on decision. A person who wrote once, was asked,
 * and never answered is the most useful row in this table and the only one that
 * cannot be reconstructed afterwards.
 *
 * Deliberately global — no `academy_id`, alongside `sender` and `job` — because
 * `destination_academy_id` points at whichever tenant the person ended up in, and a
 * tenant-scoped row must never carry a foreign key out of its own tenant. RLS would
 * make it unreadable from both ends, and "how many referrals became businesses this
 * month" would have to iterate every academy to answer.
 */

import { unsafeQuery, withSession } from '@/lib/db'
import type { Tx } from '@/lib/db'

/**
 * `declined` is not "they said no". It is the outcome for an arrival who was answered,
 * asked to be left alone, and had that honoured — the opt-out shape, at the one point
 * in the product where there is no tenant to record it against. Somebody who simply
 * stopped replying stays `undecided`, which is the honest word for it and the row the
 * funnel is actually about.
 */
export type ArrivalOutcome = 'undecided' | 'joined' | 'founded' | 'declined'

export type Arrival = {
  id: string
  senderId: string
  phoneE164: string
  frontDeskId: string
  contactId: string
  profileName: string | null
  firstText: string | null
  askedAt: Date | null
  decidedAt: Date | null
  outcome: ArrivalOutcome
  destinationAcademyId: string | null
}

type ArrivalRow = {
  id: string
  sender_id: string
  phone_e164: string
  front_desk_id: string
  contact_id: string
  profile_name: string | null
  first_text: string | null
  asked_at: Date | null
  decided_at: Date | null
  outcome: string
  destination_academy_id: string | null
}

function hydrate(row: ArrivalRow): Arrival {
  return {
    id: String(row.id),
    senderId: String(row.sender_id),
    phoneE164: String(row.phone_e164),
    frontDeskId: String(row.front_desk_id),
    contactId: String(row.contact_id),
    profileName: row.profile_name ?? null,
    firstText: row.first_text ?? null,
    askedAt: row.asked_at ? new Date(row.asked_at) : null,
    decidedAt: row.decided_at ? new Date(row.decided_at) : null,
    outcome: (row.outcome as ArrivalOutcome) ?? 'undecided',
    destinationAcademyId: row.destination_academy_id ?? null,
  }
}

/**
 * `arrival` has no tenant, and its only policy is `for all to cm_service using (true)`.
 * The GUC still has to be *something*, so it is set to the front desk the row is about:
 * a service session pinned to a real row, which is what every other reader in this
 * codebase holds, rather than a NIL uuid that satisfies no policy and reads as a bug
 * when a later table does get scoped.
 */
const deskCtx = (frontDeskId: string) => ({ role: 'service' as const, academyId: frontDeskId })

/**
 * @mechanism openArrival — the funnel row is written when the stranger ARRIVES, not when
 *   they decide, and that ordering is the whole point: the row nobody can reconstruct
 *   afterwards is the person who wrote once, was asked, and never came back. Idempotent on
 *   `(sender_id, phone_e164)`, so a second message from the same number is the same
 *   arrival — and `first_text` keeps the FIRST one, because what somebody opened with is
 *   what says whether the product had to ask at all.
 */
export async function openArrival(o: {
  senderId: string
  phoneE164: string
  frontDeskId: string
  contactId: string
  profileName?: string
  firstText?: string
  at: Date
}): Promise<string | null> {
  const rows = await withSession(deskCtx(o.frontDeskId), (tx) =>
    unsafeQuery<{ id: string }>(
      tx,
      `insert into arrival (sender_id, phone_e164, front_desk_id, contact_id,
                            profile_name, first_text, created_at)
       values ($1::uuid, $2, $3::uuid, $4::uuid, nullif($5, ''), nullif($6, ''), $7::timestamptz)
       on conflict (sender_id, phone_e164) do update
          set profile_name = coalesce(nullif($5, ''), arrival.profile_name),
              first_text   = coalesce(arrival.first_text, nullif($6, ''))
       returning id`,
      [
        o.senderId, o.phoneE164, o.frontDeskId, o.contactId,
        o.profileName ?? '', o.firstText ?? '', o.at,
      ],
    ),
  )
  return rows[0]?.id ? String(rows[0].id) : null
}

/** The arrival this front-desk contact is having, if it is having one. */
export async function arrivalForContact(frontDeskId: string, contactId: string): Promise<Arrival | null> {
  const rows = await withSession(deskCtx(frontDeskId), (tx) =>
    unsafeQuery<ArrivalRow>(tx, `select * from arrival where contact_id = $1::uuid`, [contactId]),
  )
  return rows[0] ? hydrate(rows[0]) : null
}

/**
 * The desk spoke to them — stamped on EVERY landed desk send (tools.ts calls
 * this after each one), first time wins. The name is historical: the stamp used
 * to claim "the routing question went on their screen", but a desk send that
 * answered "is this free?" stamps it too, so what `asked_at` actually means is
 * "the desk has spoken, first at T" — and `frontDeskTail` words it exactly that
 * way, sending the model to the thread for what was said. `asked_at is null`
 * still means the strongest thing it can: this person has never heard from the
 * desk at all.
 */
export async function markArrivalAsked(frontDeskId: string, arrivalId: string, at: Date): Promise<void> {
  await withSession(deskCtx(frontDeskId), (tx) =>
    unsafeQuery(
      tx,
      `update arrival set asked_at = coalesce(asked_at, $2::timestamptz) where id = $1::uuid`,
      [arrivalId, at],
    ),
  )
}

/**
 * Where they went. `founded` is settled inside `app.found_business` instead of here,
 * because creating a business and recording that a business was created must not be
 * two transactions — a crash between them leaves a tenant nobody can attribute and a
 * funnel that under-counts its only revenue event.
 */
export async function settleArrival(o: {
  frontDeskId: string
  arrivalId: string
  outcome: Exclude<ArrivalOutcome, 'undecided'>
  destinationAcademyId?: string | null
  at: Date
}): Promise<void> {
  await withSession(deskCtx(o.frontDeskId), (tx) =>
    unsafeQuery(
      tx,
      `update arrival
          set outcome                = $2,
              decided_at             = $3::timestamptz,
              destination_academy_id = coalesce($4::uuid, destination_academy_id)
        where id = $1::uuid`,
      [o.arrivalId, o.outcome, o.at, o.destinationAcademyId ?? null],
    ),
  )
}

/**
 * How many businesses this number has been talked into founding since `since`.
 *
 * The rate guard for `start_business`, and it is a query rather than a counter because
 * a counter is a second place the truth lives. §16.1 pools everything about a shared
 * number across every tenant on it — quality rating, throughput tier, the block that
 * takes all of them down together — so an unmetered "create a business" verb reachable
 * by anyone who can send a WhatsApp message is a way to farm a pooled asset every
 * paying tenant depends on. Zero friction on the funnel (§10.1) is a decision about
 * gates and admin approval, not a decision to leave the door off its hinges.
 */
export async function foundedByRecently(
  frontDeskId: string,
  phoneE164: string,
  since: Date,
): Promise<number> {
  const rows = await withSession(deskCtx(frontDeskId), (tx) =>
    unsafeQuery<{ n: string }>(
      tx,
      `select count(*)::int as n from arrival
        where outcome = 'founded'
          and decided_at >= $2::timestamptz
          and nullif(right(regexp_replace(phone_e164, '[^0-9]', '', 'g'), 10), '')
            = nullif(right(regexp_replace($1, '[^0-9]', '', 'g'), 10), '')`,
      [phoneE164, since],
    ),
  )
  return Number(rows[0]?.n ?? 0)
}


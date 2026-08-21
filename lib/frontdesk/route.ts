/**
 * lib/frontdesk/route.ts — the two destinations, and the one refusal.
 *
 * The front desk holds no conversation of its own worth having. Its whole job is to
 * find out which world this person belongs in and put them there, so everything below
 * ends by naming a `(academyId, contactId)` the caller re-enters an ordinary turn on.
 *
 * That hand-over is why none of this imports `runTurn`. The front-desk turn returns a
 * `handover` and `lib/agent/loop.ts` performs it — the same shape `executeAction`
 * already uses for a button whose payload was a reply, which "re-enters as if it had
 * been typed". Inverting it the other way would put a cycle between the loop and the
 * desk, and this repo has already paid once for an extra import edge: `act`'s enum was
 * built at module load, one new edge made the list empty, and every turn came back
 * MALFORMED_FUNCTION_CALL with zero output tokens.
 *
 * WHY NEITHER DESTINATION IS BEHIND A TAP
 * ---------------------------------------------------------------------------
 * Layer 1's rule is that **consequence, not row count, decides the preview**: money,
 * other people, destruction, collisions, anything irreversible. Founding a business
 * is none of those. It moves no money, affects nobody but the person asking, destroys
 * nothing, and every value it writes is one `set_up_business` call away from being
 * changed — that operation is explicitly "safe to call repeatedly". §10.1's "zero
 * friction on the funnel" is the same judgement made from the product end.
 *
 * What does the work instead is `MAX_BUSINESSES_PER_NUMBER_24H`. A confirmation
 * protects the person from a mistake; a rate limit protects the *pooled number* from
 * being farmed, and §16.1 is why that is the real exposure — quality rating,
 * throughput tier and a block are shared by every tenant on the sender, so an
 * unmetered "create a business" verb reachable by anyone who can send a WhatsApp
 * message spends an asset that belongs to paying customers.
 */

import { now } from '@/lib/clock'
import { unsafeQuery, withSession } from '@/lib/db'
import { formatPhone } from '@/lib/format'
import { idem, newId } from '@/lib/ids'
import { matchAcademiesByName, prospectContactIn, type AcademyCandidate } from '@/lib/identity'
import type { Identity } from '@/lib/types'
import { foundedByRecently, settleArrival } from './arrival'
import type { Arrival } from './arrival'

/**
 * Generous for a person, useless for farming. Nobody legitimately founds a fourth
 * business from one handset in a day, and somebody who mistyped a name renames it
 * (`set_up_business` is safe to call repeatedly) rather than founding a second.
 *
 * Deliberately per NUMBER and not per front desk. A per-desk cap would be the wrong
 * shape twice: a distributed attack needs many real WhatsApp numbers, which is a far
 * higher bar than a rate limit, and a genuinely viral referral day — the outcome this
 * whole change exists to produce — would trip it.
 */
export const MAX_BUSINESSES_PER_NUMBER_24H = 3

const DAY_MS = 24 * 60 * 60 * 1000

export type Handover = {
  academyId: string
  contactId: string
  reason: 'joined' | 'founded'
  /** What to tell the model in the tool result, in words it can act on. */
  note: string
}

export type RouteRefusal = { refused: string }

export type RouteResult = Handover | RouteRefusal

export const isRefusal = (r: RouteResult): r is RouteRefusal => 'refused' in r

/**
 * @mechanism carryOpeningMessage — the words that brought this person here, written into
 *   the business they were handed to, as the first row of its thread. Without it the
 *   tenant's transcript opens on the bot answering a question nobody in that academy can
 *   see it being asked, and `recentHistory` renders a one-sided conversation for as long
 *   as the thread lasts — the shape that makes a model re-introduce itself to somebody it
 *   is mid-sentence with. The front desk keeps its own copy: that one is the arrival
 *   record and answers a different question. `idempotencyKey` is derived from the
 *   destination contact and the text, so a hand-over retried after a crash carries the
 *   opening line once rather than twice.
 */
async function carryOpeningMessage(
  academyId: string,
  contactId: string,
  text: string | undefined,
  at: Date,
): Promise<void> {
  const body = String(text ?? '').trim()
  if (!body) return

  await withSession({ role: 'service', academyId }, async (tx) => {
    const senderRows = await unsafeQuery<{ id: string }>(
      tx,
      `select s.id from sender s join academy a on a.sender_id = s.id where a.id = $1::uuid`,
      [academyId],
    )
    const senderId = senderRows[0]?.id
    if (!senderId) return

    await unsafeQuery(
      tx,
      // `app.now()`, never a TypeScript clock: an inbound row has to land on the same
      // tenant clock as the outbound rows it sits between, or a moved sim clock sorts
      // every reply above the message that prompted it (F-BX).
      `insert into message (id, academy_id, contact_id, sender_id, direction, body, payload,
                            status, queued_at, sent_at, delivered_at, in_window, idempotency_key)
       values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'inbound', $5, $6::text::jsonb,
               'delivered', app.now(), app.now(), app.now(), true, $7)
       on conflict (idempotency_key) do nothing`,
      [
        newId(), academyId, contactId, senderId, body,
        JSON.stringify({ source: 'front_desk', carried: true }),
        idem('carried', contactId, body.slice(0, 64)),
      ],
    )
  })
}

/**
 * Every real business on the number this visitor messaged. Never handed to the model as
 * a list — `find_business` matches against it server-side and answers with at most a few
 * names, so the desk cannot recite a customer directory to a stranger.
 *
 * Through `app.businesses_on_sender`, and that is not decoration. `academy`'s service
 * policy is `using (id = app.academy_id())`, so **cm_service is not a bypass**: a session
 * pinned to the front desk sees the front desk and nothing else, and the obvious
 * `select ... from academy where sender_id = $1` returns zero rows with no error. The
 * failure is silent and total — every stranger told that no business is set up on this
 * number — which is exactly the shape of the trap 0030 records for `is_sandbox`.
 */
export async function businessesOnThisNumber(identity: Identity): Promise<AcademyCandidate[]> {
  const rows = await withSession(
    { role: 'service', academyId: identity.academyId },
    (tx) =>
      unsafeQuery<{ id: string; name: string }>(
        tx,
        `select id, name from app.businesses_on_sender($1::uuid)`,
        [identity.academy.sender_id],
      ),
  )
  return rows.map((r) => ({ academyId: String(r.id), name: String(r.name) }))
}

/**
 * @mechanism joinBusiness — the visitor is a parent, and this is the one door into a
 *   tenant the front desk can open. It goes through `prospectContactIn`, so §10.1's
 *   "the one thing the bot must not do is create a second `person` for someone already in
 *   the roster" holds on this route the same way it holds on the router's: an existing
 *   parent who came in through a QR resolves to the person they already are, with their
 *   children and their money intact, and gets the client surface rather than PR-WELCOME.
 *   The front-desk contact is deliberately left alone — it holds the only copy of how this
 *   conversation started, and 0039 keeps it out of `inbound_candidates` so it can never
 *   compete with the tenant contact on the next inbound.
 */
export async function joinBusiness(
  identity: Identity,
  arrival: Arrival | null,
  academyId: string,
  openingText?: string,
): Promise<RouteResult> {
  const options = await businessesOnThisNumber(identity)
  const target = options.find((a) => a.academyId === academyId)
  if (!target) {
    return {
      refused:
        'no business on this number has that id — call find_business first and pass the id it returns',
    }
  }

  const at = await now()
  const landed = await prospectContactIn(
    target.academyId,
    identity.contact.phone_e164,
    identity.contact.profile_name ?? undefined,
    at,
  )
  if (!landed) {
    return { refused: `could not open a contact at ${target.name} — nothing was written` }
  }

  await carryOpeningMessage(target.academyId, landed.contactId, openingText, at)

  if (arrival) {
    await settleArrival({
      frontDeskId: identity.academyId,
      arrivalId: arrival.id,
      outcome: 'joined',
      destinationAcademyId: target.academyId,
      at,
    })
  }

  return {
    academyId: target.academyId,
    contactId: landed.contactId,
    reason: 'joined',
    note: landed.created
      ? `handed over to ${target.name} as a new prospect — they are answering from there now, so say nothing further here`
      : `they were already known at ${target.name}; handed over to the person they already are — say nothing further here`,
  }
}

/**
 * @mechanism foundBusiness — a stranger becomes a tenant, and this is the write §16.2's
 *   referral channel needs to exist at all: a coach tells another coach "just message this
 *   number", and the person who arrives has no link, no prefill and no business to be a
 *   prospect of. It is one `security definer` call because the academy, the founder's
 *   person, their contact, their `academy_admin` row and the funnel outcome have to commit
 *   together — a crash between any two of them leaves a business with no admin, which is a
 *   business nobody can ever reach. `onboarding_state` stays at `setup`, so §2.6 is intact
 *   and the new business messages nobody until its owner says go; the founder is an admin,
 *   which is what exempts their own setup conversation from the pre-launch gate.
 */
export async function foundBusiness(
  identity: Identity,
  arrival: Arrival | null,
  o: { name: string; category?: string | null; founderName?: string | null; openingText?: string },
): Promise<RouteResult> {
  const name = String(o.name ?? '').trim()
  if (name.length < 2) {
    return { refused: 'a business needs a name they gave you — ask what it is called, do not invent one' }
  }

  /**
   * A name that already names a business on this number is either the same business
   * (in which case they are already onboarded and this is the wrong door) or a
   * confusion nobody downstream can resolve — two tenants on one sender answering to
   * one word. Refused with the collision named, so the model can ask rather than
   * guess; a genuinely different business gives a fuller name and the match clears.
   */
  const existing = await businessesOnThisNumber(identity)
  const collision = matchAcademiesByName(name, existing)
  if (collision.length > 0) {
    return {
      refused:
        `there is already a business on this number called "${collision[0].name}" — ` +
        'ask whether that is theirs (if it is, they are already set up and should be told so) ' +
        'or take the full name of theirs, which will not collide',
    }
  }

  const at = await now()
  const since = new Date(at.getTime() - DAY_MS)
  const recent = await foundedByRecently(identity.academyId, identity.contact.phone_e164, since)
  if (recent >= MAX_BUSINESSES_PER_NUMBER_24H) {
    return {
      refused:
        `this number has already started ${recent} businesses in the last day, which is the limit — ` +
        'tell them plainly that a person can look after their existing ones from here and that ' +
        'anything more needs a human',
    }
  }

  const academyId = newId()
  const founderName =
    String(o.founderName ?? '').trim() ||
    (identity.contact.profile_name ?? '').trim() ||
    identity.person.full_name ||
    formatPhone(identity.contact.phone_e164)

  /**
   * @mechanism found_business — a business is born with the reality of the NUMBER it was
   *   founded on: the function reads `sender.is_sim` and stamps `academy.is_sandbox` from
   *   it (0040), so a tenant the product talks into existence during a drive is marked
   *   without the harness touching a product table. Before this, a drive's academy was
   *   byte-identical to a paying one — `_danger.ts` would refuse to clean it up,
   *   `ops-guard.ts` would refuse to act on it, and its jobs enqueued into the live lane
   *   where the production beat claimed them. The harness cannot stamp it itself because
   *   fixtures are gone: the `academy` row is written here, by product code, on the
   *   strength of a conversation. Inheritance is what reaches it.
   *   Closes F-CH.
   */
  const rows = await withSession(
    { role: 'service', academyId: identity.academyId },
    (tx) =>
      unsafeQuery<{ data: { academy_id: string; person_id: string; contact_id: string } | null }>(
        tx,
        `select app.found_business($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $9::timestamptz) as data`,
        [
          academyId,
          identity.academy.sender_id,
          name,
          o.category ?? '',
          founderName,
          identity.contact.phone_e164,
          identity.contact.profile_name ?? '',
          arrival?.id ?? null,
          at,
        ],
      ),
  )

  const made = rows[0]?.data
  if (!made?.contact_id) {
    return { refused: `${name} was not created — nothing was written, and nothing is half-made` }
  }

  await carryOpeningMessage(String(made.academy_id), String(made.contact_id), o.openingText, at)

  return {
    academyId: String(made.academy_id),
    contactId: String(made.contact_id),
    reason: 'founded',
    note:
      `${name} exists now, with them as its admin, and they are answering from inside it — ` +
      'say nothing further here',
  }
}

/**
 * @mechanism stopMessagingVisitor — "leave me alone" is answerable at the front desk, where
 *   there is no tenant to record it against and therefore nowhere for the ordinary opt-out
 *   to go. It writes `opted_out_at` on the front-desk contact, which is gate 1 of the send
 *   path — the gate that outranks every other — so the refusal is enforced by the same
 *   machinery that enforces a parent's, rather than by the desk remembering. On a pooled
 *   number this is not manners: one marketing complaint is charged to every tenant on the
 *   sender (§16.1), so a stranger who asked to be left alone and was not is a bill the
 *   businesses pay.
 */
export async function stopMessagingVisitor(
  identity: Identity,
  arrival: Arrival | null,
): Promise<{ ok: true; note: string }> {
  const at = await now()

  await withSession({ role: 'service', academyId: identity.academyId }, (tx) =>
    unsafeQuery(
      tx,
      `update contact
          set opted_out_at = coalesce(opted_out_at, $2::timestamptz),
              state        = 'opted_out'
        where id = $1::uuid`,
      [identity.contact.id, at],
    ),
  )

  if (arrival) {
    await settleArrival({
      frontDeskId: identity.academyId,
      arrivalId: arrival.id,
      outcome: 'declined',
      at,
    })
  }

  return {
    ok: true,
    note:
      'recorded — nothing else will reach this number from here. Acknowledge it in one line and stop.',
  }
}

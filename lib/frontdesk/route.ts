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
 * @mechanism carryDeskTranscript — the arrival's WHOLE desk exchange, written into the
 *   business they were handed to as the opening rows of its thread — both directions, on
 *   the rows' own original clocks. Its predecessor carried exactly one message, the one
 *   that triggered the hand-over, and §10.1's routing means the useful sentence is
 *   usually not that one: a person warms up before they commit. Measured on the 23 Aug
 *   week sims: Rahul gave the desk his full timetable the evening before founding and was
 *   asked for it again the next day ("already told you the timings yesterday"), and
 *   Meenakshi's ₹6,400 advance, declared to the desk on day 1, re-entered only when the
 *   owner retyped it on day 5. The founding turn now opens holding everything already
 *   said, which is what lets it stage the timetable — and the go-live that needs it — in
 *   its first breath. Idempotency is per SOURCE row, so a retried hand-over carries each
 *   line once; suppressed rows stay behind; payloads are stripped to provenance so no
 *   stale button rides across; and the original timestamps come with the rows, because
 *   every one of them predates the founding and F-BX is the record of what an unstamped
 *   carry does to a thread's order. When the desk thread cannot be read, the triggering
 *   text is carried alone — the old behaviour, kept as the floor rather than the whole.
 *   Closes F-EO.
 */
async function carryDeskTranscript(
  academyId: string,
  contactId: string,
  desk: Identity,
  text: string | undefined,
  at: Date,
): Promise<void> {
  type Row = {
    id: string
    direction: string
    body: string
    created_at: Date | string | null
    queued_at: Date | string | null
    sent_at: Date | string | null
    delivered_at: Date | string | null
  }
  // The last 40 said things within a fortnight, in order — read under the DESK's own
  // scope, because the desk thread belongs to the desk academy and the new business's
  // session cannot see it. Only rows that LANDED cross: a desk send that failed on the
  // wire is a message the person never received, and carrying it as 'delivered' would
  // hand the tenant model something never said (review find). The fortnight bound keeps
  // a returner's previous visit — including an old hand-over to another business — out
  // of a new founding's opening thread.
  let thread: Row[] = []
  try {
    thread = await withSession({ role: 'service', academyId: desk.academyId }, async (tx) =>
      unsafeQuery<Row>(
        tx,
        `select id, direction, body, created_at, queued_at, sent_at, delivered_at
           from (select id, direction, body, created_at, queued_at, sent_at, delivered_at
                   from message
                  where academy_id = $1::uuid and contact_id = $2::uuid
                    and coalesce(suppressed_reason, '') = ''
                    and coalesce(trim(body), '') <> ''
                    and (direction = 'inbound' or status in ('sent', 'delivered', 'read'))
                    and created_at > app.now() - interval '14 days'
                  order by queued_at desc limit 40) last40
          order by queued_at asc`,
        [desk.academyId, desk.contact.id],
      ),
    )
  } catch {
    thread = []
  }
  const fallback = String(text ?? '').trim()
  if (!thread.length && !fallback) return

  // The founding or join has already COMMITTED by the time this runs (`app.found_business`
  // is its own transaction), so a carry that cannot write must never bubble up and turn a
  // real business into a tool refusal. Failing here costs the transcript — the old
  // world's behaviour — and nothing else.
  try {
  await withSession({ role: 'service', academyId }, async (tx) => {
    const senderRows = await unsafeQuery<{ id: string }>(
      tx,
      `select s.id from sender s join academy a on a.sender_id = s.id where a.id = $1::uuid`,
      [academyId],
    )
    const senderId = senderRows[0]?.id
    if (!senderId) return

    if (!thread.length) {
      // The floor: the triggering text alone, stamped `app.now()` — an inbound row has
      // to land on the tenant clock it sits inside, or a moved sim clock sorts every
      // reply above the message that prompted it (F-BX).
      await unsafeQuery(
        tx,
        `insert into message (id, academy_id, contact_id, sender_id, direction, body, payload,
                              status, queued_at, sent_at, delivered_at, in_window, idempotency_key)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'inbound', $5, $6::text::jsonb,
                 'delivered', app.now(), app.now(), app.now(), true, $7)
         on conflict (idempotency_key) do nothing`,
        [
          newId(), academyId, contactId, senderId, fallback,
          JSON.stringify({ source: 'front_desk', carried: true }),
          idem('carried', contactId, fallback.slice(0, 64)),
        ],
      )
      return
    }

    for (const m of thread) {
      const queued = m.queued_at ?? at
      // `created_at` is written EXPLICITLY with the original row's value — its default
      // is app.now(), which is the carry moment, and every phone reader pages on
      // created_at: left to the default, a founding replayed the whole desk exchange
      // onto the person's screen as a burst of just-sent messages (review find).
      await unsafeQuery(
        tx,
        `insert into message (id, academy_id, contact_id, sender_id, direction, body, payload,
                              status, created_at, queued_at, sent_at, delivered_at, in_window, idempotency_key)
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::text::jsonb,
                 'delivered', $8, $9, $10, $11, true, $12)
         on conflict (idempotency_key) do nothing`,
        [
          newId(), academyId, contactId, senderId,
          m.direction === 'outbound' ? 'outbound' : 'inbound', m.body,
          JSON.stringify({ source: 'front_desk', carried: true }),
          m.created_at ?? queued, queued, m.sent_at ?? queued, m.delivered_at ?? queued,
          idem('carried', contactId, String(m.id)),
        ],
      )
    }
  })
  } catch {
    // Deliberately swallowed — see above. An uncarried transcript is a gap the model
    // works without, exactly as every hand-over did before this mechanism existed.
  }
}

/**
 * Every real business on the number this arrival messaged. Never handed to the model as
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
 * @mechanism joinBusiness — the arrival is a parent, and this is the one door into a
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
  /** What they told the desk they were — see `arrivedAs`. Never a role and never a grant. */
  arrivedAs?: 'parent' | 'coach' | 'owner' | 'unsure',
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

  await carryDeskTranscript(target.academyId, landed.contactId, identity, openingText, at)

  /**
   * What the desk worked out, written where the business can read it.
   *
   * The desk's whole job is deciding which side of the counter somebody is on, and it
   * routed on that answer and then dropped it: `join_business` took an academy id and
   * nothing else, so the tenant turn answering the same message a breath later started
   * from zero. Watched twice on 22 Aug 2026 — Arjun Shetty writing *"im not the owner im
   * just coach for rahul evening bath mon n thu"*, read correctly by the desk, arriving
   * inside the business as a role-less prospect, and the owner still being asked to
   * confirm who he was a week later.
   *
   * @mechanism arrivedAs — the answer the desk already had, carried across the hand-over on
   *   the one row that crosses it. Not on `arrival`, which 0039 closes to every role, so a
   *   fact written there is a fact the tenant still cannot read. It is EVIDENCE and not a
   *   role: `coach`, `academy_admin` and `account` decide what somebody may do and this
   *   decides nothing, in the same spirit as the opening words carried beside it. Written
   *   only when the desk actually said one, so it never overwrites a known person's history
   *   with a stranger's guess.
   *   Closes F-EC.
   */
  if (arrivedAs) {
    await withSession({ role: 'service', academyId: target.academyId }, async (tx) => {
      await tx`update contact set arrived_as = ${arrivedAs} where id = ${landed.contactId}::uuid`
    }).catch(() => {
      /* Never a precondition: a hand-over that lands without this is worse, not broken. */
    })
  }

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

  await carryDeskTranscript(String(made.academy_id), String(made.contact_id), identity, o.openingText, at)

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
 * @mechanism stopMessagingAtDesk — "leave me alone" is answerable at the front desk, where
 *   there is no tenant to record it against and therefore nowhere for the ordinary opt-out
 *   to go. It writes `opted_out_at` on the front-desk contact, which is gate 1 of the send
 *   path — the gate that outranks every other — so the refusal is enforced by the same
 *   machinery that enforces a parent's, rather than by the desk remembering. On a pooled
 *   number this is not manners: one marketing complaint is charged to every tenant on the
 *   sender (§16.1), so a stranger who asked to be left alone and was not is a bill the
 *   businesses pay.
 */
export async function stopMessagingAtDesk(
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

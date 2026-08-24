/**
 * lib/identity.ts — who is this, and which hats are they wearing (CONTRACTS §4).
 *
 * Two jobs, both from spec §6.2 and §10.1:
 *
 *   resolveIdentity  contact -> person -> roles, in ONE round trip. Roles
 *                    COMPOSE: a senior player who coaches juniors is one person
 *                    with a player row and a coach row, and the bot serves all
 *                    of their hats in one thread. Anything that returns a
 *                    single role is wrong.
 *
 *   resolveInbound   §10.1 routing on a shared number, and it answers only what rows
 *                    can answer: does this number already belong to a business? One
 *                    academy resolves on sight. None sends the person to the front
 *                    desk (0039), where the product ASKS whether they
 *                    want classes or run them — rather than the router deciding they
 *                    are a parent because the prefilled text named a tenant.
 *                    Several is still ambiguity, and still asks.
 *                    This is a functional requirement, not a security one —
 *                    RLS is what keeps the tenants apart.
 */

import { now } from '@/lib/clock'
import { unsafeQuery, withSession, type SessionCtx, type Tx } from '@/lib/db'
import { formatPhone } from '@/lib/format'
// 0039 — the funnel row is opened by the router, because arriving is the event, not
// deciding. `lib/frontdesk/arrival.ts` imports nothing from here, so there is no cycle.
import { openArrival } from '@/lib/frontdesk/arrival'
import { isUuid } from '@/lib/ids'
import type { Academy, Contact, Identity, Person, Role } from '@/lib/types'

/** app.identity() and app.inbound_candidates() are academy-agnostic bootstraps. */
const BOOTSTRAP_CTX: SessionCtx = { role: 'service', academyId: '' }

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/

/**
 * jsonb hands back timestamps as ISO strings. The row types promise Dates, so
 * put them back. Date-only strings ('YYYY-MM-DD') stay strings on purpose — a
 * calendar day is not an instant.
 */
function hydrate<T>(row: Record<string, unknown> | null | undefined): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row ?? {})) {
    out[key] = typeof value === 'string' && ISO_INSTANT.test(value) ? new Date(value) : value
  }
  return out as T
}

type IdentityJson = {
  academy_id: string
  academy: Record<string, unknown>
  contact: Record<string, unknown>
  person: Record<string, unknown>
  roles: Role[]
  coach_id: string | null
  account_ids: string[]
  player_ids: string[]
  is_solo: boolean
  sees_money: boolean
}

function toIdentity(json: IdentityJson): Identity {
  return {
    academyId: json.academy_id,
    academy: hydrate<Academy>(json.academy),
    contact: hydrate<Contact>(json.contact),
    person: hydrate<Person>(json.person),
    roles: Array.isArray(json.roles) ? json.roles : [],
    coachId: json.coach_id ?? null,
    accountIds: Array.isArray(json.account_ids) ? json.account_ids : [],
    playerIds: Array.isArray(json.player_ids) ? json.player_ids : [],
    isSolo: json.is_solo === true,
    seesMoney: json.sees_money === true,
  }
}

/**
 * One query, several scalar subqueries, one round trip. `app.identity` is
 * SECURITY DEFINER because the academy this contact belongs to is on the row
 * the session cannot read until it knows the academy.
 *
 * @mechanism resolveIdentity — one contact resolves to a person and to ALL of their roles at
 *   once, because roles COMPOSE: a senior player who coaches juniors is one person with a
 *   player row and a coach row, and the bot serves both hats in the one thread they message
 *   from. Anything that answers with a single role is wrong, and everything downstream —
 *   `seesMoney`, `isSolo`, the accounts and players this speaker stands for — is derived from
 *   the composed set rather than re-asked per caller.
 */
export async function resolveIdentity(contactId: string): Promise<Identity | null> {
  if (!isUuid(contactId)) return null

  const rows = await withSession(BOOTSTRAP_CTX, (tx) =>
    unsafeQuery<{ identity: IdentityJson | null }>(tx, 'select app.identity($1::uuid) as identity', [contactId]),
  )

  const json = rows[0]?.identity
  return json ? toIdentity(json) : null
}

// -----------------------------------------------------------------------------
// Who runs this business
// -----------------------------------------------------------------------------

export type AdminRecipient = { person_id: string; full_name: string; contact_id: string | null }

/**
 * The people who run this academy, and the number each of them actually reads.
 *
 * @mechanism adminsIn — the one definition of "which admins do I tell", where the digest,
 *   `handoff`, the refusal escalation and every proactive job had each written their own
 *   join. They had already diverged in both ways this join can be wrong: an inner join to
 *   `contact` made an admin with no contact row vanish from the result rather than show up
 *   unreachable, and each sorted differently, so `[0]` meant a different person depending on
 *   who asked. The lateral join leaves `contact_id` nullable because an admin who cannot be
 *   reached is a fact the caller needs; opted-out contacts are the one exclusion; the order
 *   is reachable-first, then by name, and is the same for every caller.
 *
 * **One definition, because there were four.** "Which admins do I tell" is asked
 * by the digest (`loop.ts`), by `handoff`, by the refusal escalation in
 * `plan.ts`, and by every proactive job (`lib/jobs/util.ts`) — and each had
 * written its own join. They had already diverged in the two ways this join can
 * be wrong: three used an inner join to `contact`, so an admin with no contact
 * row simply vanished from the result rather than showing up unreachable, and
 * each sorted differently, so "the first admin" meant a different person
 * depending on which caller asked.
 *
 * The lateral join is what makes `contact_id` nullable rather than disqualifying:
 * an admin who cannot be reached is a fact the caller needs, not a row to hide.
 * Opted-out contacts never come back — that is the one exclusion, and it belongs
 * to the contact rather than to the person.
 *
 * Order is reachable-first, then by name: deterministic across callers, and the
 * admin who can actually be messaged is the one `[0]` should mean.
 */
export async function adminsIn(tx: Tx, academyId: string): Promise<AdminRecipient[]> {
  return unsafeQuery<AdminRecipient>(
    tx,
    `select aa.person_id, pe.full_name, ct.id as contact_id
       from academy_admin aa
       join person pe on pe.id = aa.person_id
       left join lateral (
         select c.id from contact c
          where c.academy_id = aa.academy_id and c.person_id = aa.person_id
            and c.opted_out_at is null
          order by c.is_primary desc, c.created_at asc
          limit 1
       ) ct on true
      where aa.academy_id = $1::uuid
      order by (ct.id is not null) desc, pe.full_name`,
    [academyId],
  )
}

/** The same, opening its own service session — for callers that have no `Tx` in hand. */
export async function admins(academyId: string): Promise<AdminRecipient[]> {
  return withSession({ role: 'service', academyId }, (tx) => adminsIn(tx, academyId))
}

/** Just the numbers, for the paths that only want somebody to message. */
export async function adminContactIds(academyId: string): Promise<string[]> {
  const rows = await admins(academyId)
  return rows.map((r) => r.contact_id).filter((id): id is string => Boolean(id))
}


// -----------------------------------------------------------------------------
// §10.1 — routing a cold inbound on a shared number
//
// This section used to answer a question it had no business answering. An unknown
// number arrived, `matchByName` read the prefilled text, and whichever academy it hit
// got a brand-new `prospect` person — the router deciding, before anybody had spoken,
// that this stranger was a parent. A number that matched nothing came back
// `unresolved`, `ingestInbound` wrote no message row and ran no turn, and the person
// got silence.
//
// Both halves are wrong for the same reason, and referral is what makes it expensive:
// a coach telling another coach "just message this number and it'll run your classes"
// sends someone whose opening line names no business at all. The most valuable inbound
// the product can receive is the one that lands in the branch that answers nothing.
//
// So the router stops guessing. It answers exactly the question rows can answer —
// *does this number already belong to a business?* — and hands everything else to the
// front desk (0039, `lib/frontdesk/`), which asks.
// -----------------------------------------------------------------------------

export type AcademyCandidate = { academyId: string; name: string }

export type InboundResolution =
  | { identity: Identity; isNew: boolean }
  | { unresolved: true; candidates: AcademyCandidate[] }

type CandidatesJson = {
  sender_id: string | null
  /** 0039 — where an unmatched number is about to be answered. Null before the first. */
  front_desk_id: string | null
  matches: { academy_id: string; name: string; contact_id: string }[]
  academies: { academy_id: string; name: string }[]
}

/** Lowercase, letters and digits only. "Ace T.T. Academy" -> "acettacademy". */
function squash(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Lowercase, everything else becomes a single space. */
function loose(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * Words that name the category rather than the business. Matching on these
 * would route "Hi, is this the academy?" to whichever tenant sorted first.
 */
const GENERIC_WORDS = new Set([
  'academy', 'academia', 'academies', 'club', 'centre', 'center', 'sports', 'sport',
  'coaching', 'classes', 'class', 'school', 'institute', 'studio', 'training',
  'batch', 'batches', 'team', 'group', 'india', 'hello', 'namaste',
])

/**
 * Case- and space-insensitive on the full name, then on any distinctive word.
 *
 * @mechanism matchAcademiesByName — the one name matcher, and it no longer decides
 *   anything by itself. It used to BE the router: whichever academy it hit acquired a new
 *   prospect before a word had been exchanged, so a stranger who typed "hi" reached nobody
 *   and a stranger who typed "hi Ace" became Ace's parent whatever they had actually come
 *   to say. Its result is now evidence handed to the front-desk turn, which is where the
 *   judgement belongs. `GENERIC_WORDS` is unchanged and still load-bearing: without it
 *   "Hi, is this the academy?" matches whichever tenant sorted first. Exported because
 *   `find_business` matches with THIS function — a second copy is how the tool and the
 *   router would come to disagree about who "Ace" is.
 */
export function matchAcademiesByName(
  text: string | undefined,
  academies: AcademyCandidate[],
): AcademyCandidate[] {
  const tight = squash(text ?? '')
  if (!tight) return []
  const spaced = ` ${loose(text ?? '')} `

  return academies.filter((a) => {
    const full = squash(a.name)
    if (full.length >= 3 && tight.includes(full)) return true

    return loose(a.name)
      .split(' ')
      .filter((w) => w.length >= 4 && !GENERIC_WORDS.has(w))
      .some((w) => spaced.includes(` ${w} `))
  })
}

function dedupe(list: AcademyCandidate[]): AcademyCandidate[] {
  const seen = new Set<string>()
  const out: AcademyCandidate[] = []
  for (const c of list) {
    if (seen.has(c.academyId)) continue
    seen.add(c.academyId)
    out.push(c)
  }
  return out
}

/**
 * An inbound is the only thing that opens the 24h window (§11.2), so recording
 * it is part of resolving it: last_inbound_at moves, and a registered contact
 * becomes engaged. An opted-out contact stays opted out — they messaged us,
 * they did not un-opt-out.
 */
async function markInbound(academyId: string, contactId: string, profileName: string | undefined, at: Date): Promise<void> {
  await withSession({ role: 'service', academyId }, (tx) =>
    unsafeQuery(
      tx,
      `update contact
          set last_inbound_at = $2::timestamptz,
              profile_name    = coalesce(nullif($3, ''), profile_name),
              state           = case when state = 'registered' then 'engaged' else state end
        where id = $1::uuid`,
      [contactId, at, profileName ?? ''],
    ),
  )
}

/**
 * §10.1 step 1 — the person, in the business they are a prospect of.
 *
 * @mechanism prospectContactIn — find-or-create, in that order, and the order is the rule
 *   §10.1 exists to enforce: *"the one thing the bot must not do is create a second
 *   `person` for someone already in the roster."* An existing parent who arrives through a
 *   prospect entry point — a QR at the court is scanned by existing parents more often
 *   than by strangers — resolves to the person they already are and keeps their roster,
 *   their children and their money. Matching is on the last ten digits, so
 *   "+91 98765 43210" and "9876543210" are the same human. This used to be reachable only
 *   from the router, which meant only the router could honour that rule; it is now the one
 *   door into a business for everyone the front desk sends, so the rule holds on every
 *   route into a tenant rather than on the one that happened to have it.
 */
export async function prospectContactIn(
  academyId: string,
  phoneE164: string,
  profileName: string | undefined,
  at: Date,
): Promise<{ contactId: string; created: boolean } | null> {
  const name = (profileName ?? '').trim() || formatPhone(phoneE164)

  return withSession({ role: 'service', academyId }, async (tx) => {
    const existing = await unsafeQuery<{ id: string }>(
      tx,
      `select id from contact
        where academy_id = $1::uuid
          and nullif(right(regexp_replace(phone_e164, '[^0-9]', '', 'g'), 10), '')
            = nullif(right(regexp_replace($2, '[^0-9]', '', 'g'), 10), '')
        order by is_primary desc, created_at asc
        limit 1`,
      [academyId, phoneE164],
    )

    if (existing[0]?.id) {
      const contactId = String(existing[0].id)
      await unsafeQuery(
        tx,
        `update contact
            set last_inbound_at = $2::timestamptz,
                profile_name    = coalesce(nullif($3, ''), profile_name),
                state           = case when state = 'registered' then 'engaged' else state end
          where id = $1::uuid`,
        [contactId, at, profileName ?? ''],
      )
      return { contactId, created: false }
    }

    const rows = await unsafeQuery<{ id: string }>(
      tx,
      `with new_person as (
         insert into person (academy_id, full_name)
         values ($1::uuid, $2)
         returning id
       )
       insert into contact (academy_id, person_id, phone_e164, profile_name, state, last_inbound_at)
       -- 0051: 'registered' like every created-not-yet-heard-from contact; the inbound
       -- trigger flips it to 'engaged' when their message stores. What makes them a
       -- prospect is holding no role row here, and app.identity derives that itself.
       select $1::uuid, new_person.id, $3, nullif($4, ''), 'registered', $5::timestamptz
       from new_person
       on conflict (academy_id, phone_e164) do nothing
       returning id`,
      [academyId, name, phoneE164, profileName ?? '', at],
    )

    if (rows[0]?.id) return { contactId: String(rows[0].id), created: true }

    // Lost a race with a concurrent inbound from the same number.
    const again = await unsafeQuery<{ id: string }>(
      tx,
      `select id from contact where academy_id = $1::uuid and phone_e164 = $2`,
      [academyId, phoneE164],
    )
    return again[0]?.id ? { contactId: String(again[0].id), created: false } : null
  })
}

/**
 * 0039 — the arrivals hall of this number, and this number's row in it.
 *
 * Both halves are one `security definer` call because both have to survive the same
 * race: two messages from the same stranger, milliseconds apart, must not produce two
 * front desks or two people. `app.front_desk_contact` does the find-or-create in SQL
 * and re-reads on conflict, so this returns a contact id either way.
 */
async function frontDeskContact(
  senderId: string,
  phoneE164: string,
  profileName: string | undefined,
  at: Date,
): Promise<{ frontDeskId: string; contactId: string; created: boolean } | null> {
  const name = (profileName ?? '').trim() || formatPhone(phoneE164)

  const rows = await withSession(BOOTSTRAP_CTX, (tx) =>
    unsafeQuery<{ data: { front_desk_id: string; contact_id: string; created: boolean } | null }>(
      tx,
      'select app.front_desk_contact($1::uuid, $2, $3, $4, $5::timestamptz) as data',
      [senderId, phoneE164, name, profileName ?? '', at],
    ),
  )

  const data = rows[0]?.data
  if (!data?.contact_id || !data?.front_desk_id) return null
  return {
    frontDeskId: String(data.front_desk_id),
    contactId: String(data.contact_id),
    created: data.created === true,
  }
}

/**
 * Route an inbound message to an academy and a person.
 *
 * `senderPhoneE164` is the number the message arrived ON — one number serves
 * many academies (§16), so it is what bounds the search.
 *
 * @mechanism resolveInbound — §10.1 routing on a shared number, and it now answers only
 *   the question rows can answer: does this number already belong to a business? A number
 *   known to exactly one resolves on sight. A number known to none goes to the front desk
 *   (0039), with a person, a contact, a transcript and a turn — where the
 *   product ASKS whether they want classes or run them, instead of the router deciding they
 *   are a parent because the prefilled text happened to name a tenant. That text is still
 *   read, and is handed to the turn as evidence rather than spent as a routing decision.
 *   Functional, not a security boundary — RLS is what keeps the tenants apart, and a front
 *   desk owns nothing to keep apart.
 *   Closes F-CE.
 */
export async function resolveInbound(
  fromPhoneE164: string,
  senderPhoneE164: string,
  profileName?: string,
  text?: string,
): Promise<InboundResolution> {
  const at = await now()

  const rows = await withSession(BOOTSTRAP_CTX, (tx) =>
    unsafeQuery<{ data: CandidatesJson }>(tx, 'select app.inbound_candidates($1, $2) as data', [
      fromPhoneE164,
      senderPhoneE164,
    ]),
  )

  const data = rows[0]?.data
  const senderId = data?.sender_id ?? null
  const matches = data?.matches ?? []
  const academies: AcademyCandidate[] = (data?.academies ?? []).map((a) => ({ academyId: a.academy_id, name: a.name }))

  // Known number, exactly one academy: resolve on sight. Front desks are excluded from
  // `matches` by 0039, so a desk arrival who has since joined a business resolves THERE and
  // never comes back to the desk they arrived at.
  if (matches.length === 1) {
    const hit = matches[0]
    await markInbound(hit.academy_id, hit.contact_id, profileName, at)
    const identity = await resolveIdentity(hit.contact_id)
    if (identity) return { identity, isNew: false }
    return { unresolved: true, candidates: dedupe(academies) }
  }

  /**
   * Known number, several academies: ask rather than guess (§10.1) — and this is the
   * one case that still produces silence, left exactly where it was.
   *
   * It is a different question from the front desk's. This person belongs to two
   * businesses already, so "classes, or do you run them?" is the wrong thing to ask
   * them, and the right thing — *which* of your businesses is this about? — needs an
   * answer that STICKS, or a parent enrolled at two academies is interrogated on every
   * message they send. That is its own design with its own state, and folding it in here
   * would trade a silence nobody has hit for a regression in a path that works.
   */
  if (matches.length > 1) {
    return {
      unresolved: true,
      candidates: dedupe(matches.map((m) => ({ academyId: m.academy_id, name: m.name }))),
    }
  }

  // Unknown number. It belongs to no business, so it belongs to the number: the front
  // desk takes it, and the turn that runs there asks which side they are on.
  if (!senderId) {
    // The message arrived on a number this deployment does not own. There is nothing to
    // answer it with and nowhere to put it — the one case with no front desk to reach.
    return { unresolved: true, candidates: dedupe(academies) }
  }

  const desk = await frontDeskContact(senderId, fromPhoneE164, profileName, at)
  if (!desk) return { unresolved: true, candidates: dedupe(academies) }

  // The funnel row, opened before the turn runs. A stranger who writes once and never
  // answers is the most useful row in `arrival`, and it exists only if it is written
  // here rather than when somebody finally decides something.
  await openArrival({
    senderId,
    phoneE164: fromPhoneE164,
    frontDeskId: desk.frontDeskId,
    contactId: desk.contactId,
    profileName,
    firstText: text,
    at,
  })

  const identity = await resolveIdentity(desk.contactId)
  if (!identity) return { unresolved: true, candidates: dedupe(academies) }
  return { identity, isNew: desk.created }
}

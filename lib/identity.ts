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
 *   resolveInbound   §10.1 routing on a shared number. A number known to
 *                    exactly one academy resolves on sight; an unknown number
 *                    matches the academy named in the prefilled text and
 *                    becomes a prospect; ambiguity returns candidates and asks.
 *                    This is a functional requirement, not a security one —
 *                    RLS is what keeps the tenants apart.
 */

import { now } from '@/lib/clock'
import { unsafeQuery, withSession, type SessionCtx } from '@/lib/db'
import { formatPhone } from '@/lib/format'
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
// §10.1 — routing a cold inbound on a shared number
// -----------------------------------------------------------------------------

export type AcademyCandidate = { academyId: string; name: string }

export type InboundResolution =
  | { identity: Identity; isNew: boolean }
  | { unresolved: true; candidates: AcademyCandidate[] }

type CandidatesJson = {
  sender_id: string | null
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

/** Case- and space-insensitive on the full name, then on any distinctive word. */
function matchByName(text: string | undefined, academies: AcademyCandidate[]): AcademyCandidate[] {
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

/** §10.1 step 1 — cold inbound, academy resolved, prospect person created. */
async function createProspect(
  academyId: string,
  phoneE164: string,
  profileName: string | undefined,
  at: Date,
): Promise<string | null> {
  const name = (profileName ?? '').trim() || formatPhone(phoneE164)

  const rows = await withSession({ role: 'service', academyId }, (tx) =>
    unsafeQuery<{ id: string }>(
      tx,
      `with new_person as (
         insert into person (academy_id, full_name)
         values ($1::uuid, $2)
         returning id
       )
       insert into contact (academy_id, person_id, phone_e164, profile_name, state, last_inbound_at)
       select $1::uuid, new_person.id, $3, nullif($4, ''), 'prospect', $5::timestamptz
       from new_person
       on conflict (academy_id, phone_e164) do nothing
       returning id`,
      [academyId, name, phoneE164, profileName ?? '', at],
    ),
  )

  return rows[0]?.id ?? null
}

/**
 * Route an inbound message to an academy and a person.
 *
 * `senderPhoneE164` is the number the message arrived ON — one number serves
 * many academies (§16), so it is what bounds the search.
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
  const matches = data?.matches ?? []
  const academies: AcademyCandidate[] = (data?.academies ?? []).map((a) => ({ academyId: a.academy_id, name: a.name }))

  // Known number, exactly one academy: resolve on sight.
  if (matches.length === 1) {
    const hit = matches[0]
    await markInbound(hit.academy_id, hit.contact_id, profileName, at)
    const identity = await resolveIdentity(hit.contact_id)
    if (identity) return { identity, isNew: false }
    return { unresolved: true, candidates: dedupe(academies) }
  }

  // Known number, several academies: ask rather than guess (§10.1).
  if (matches.length > 1) {
    return {
      unresolved: true,
      candidates: dedupe(matches.map((m) => ({ academyId: m.academy_id, name: m.name }))),
    }
  }

  // Unknown number: the prefilled text names the academy.
  const named = matchByName(text, academies)
  const target = named.length === 1 ? named[0] : academies.length === 1 ? academies[0] : null

  if (!target) {
    return { unresolved: true, candidates: dedupe(named.length > 1 ? named : academies) }
  }

  const contactId = await createProspect(target.academyId, fromPhoneE164, profileName, at)
  if (!contactId) {
    // Lost a race with a concurrent inbound from the same number.
    const retry = await withSession(BOOTSTRAP_CTX, (tx) =>
      unsafeQuery<{ data: CandidatesJson }>(tx, 'select app.inbound_candidates($1, $2) as data', [
        fromPhoneE164,
        senderPhoneE164,
      ]),
    )
    const again = retry[0]?.data?.matches ?? []
    if (again.length === 1) {
      await markInbound(again[0].academy_id, again[0].contact_id, profileName, at)
      const identity = await resolveIdentity(again[0].contact_id)
      if (identity) return { identity, isNew: false }
    }
    return { unresolved: true, candidates: dedupe(academies) }
  }

  const identity = await resolveIdentity(contactId)
  if (!identity) return { unresolved: true, candidates: dedupe(academies) }
  return { identity, isNew: true }
}

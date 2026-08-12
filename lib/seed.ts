/**
 * lib/seed.ts — the emulator's world module.
 *
 * Owned by **API**. Three concerns, one file, because every `app/api/emulator/*`
 * route must stay thin (CONTRACTS §9) and this is the only `lib/` file API owns:
 *
 *   1. SEED     — `seedWorld(scenario)` truncates all tenant data and rebuilds it
 *                 deterministically. Every id is `detId(...)`, a hash of a stable
 *                 string, so a run replays identically (§17).
 *   2. READ     — `worldState()`, `threadFor()`, `eventLog()`, `pollWorld()`:
 *                 the emulator's read model.
 *   3. INGRESS  — `ingestInbound()` is the one path an inbound takes, used by
 *                 both `/api/emulator/inbound` and the real `/api/webhook`:
 *                 resolveInbound → insert the inbound `message` row (which fires
 *                 the §11.2 trigger stamping `last_inbound_at` and promoting
 *                 contact state) → `runTurn`.
 *
 * RLS: seeding and reading run as role `service`, pinned per academy
 * (`app.academy_id`), because that is what the policies in 0003 actually permit —
 * `academy_cm_service_all` is `using (id = app.academy_id())`, which an insert
 * CAN satisfy since the ids are deterministic and therefore known before the row
 * exists. The global tables (`sender`, `job`, `sim_*`) carry
 * `for all to cm_service using (true)`, so they are written from whichever
 * service session is already open — they do not care which academy it is pinned
 * to. There is no path here that uses the raw pool: `cm_runtime` has no table
 * privileges at all.
 *
 * Domain time is always `lib/clock.ts` / `app.now()`. The only real-wall-clock
 * value read anywhere is `message.created_at` etc., which the schema defaults to
 * `now()` — those are used purely as a monotonic STREAM CURSOR, never as domain
 * time, so that moving the sim clock forward or backward cannot make the event
 * stream skip or replay.
 */

import { DateTime } from 'luxon'

import { withSession, type SessionCtx, type Tx } from '@/lib/db'
import { now, reset as resetClock, nextEventAt } from '@/lib/clock'
import { newId } from '@/lib/ids'
import { resolveInbound } from '@/lib/identity'
import { runTurn, type TurnOutput } from '@/lib/agent/loop'
import { markStatus } from '@/lib/messaging/send'
import type { Role } from '@/lib/types'

// -----------------------------------------------------------------------------
// Deterministic ids (§17 "a run replays deterministically").
// -----------------------------------------------------------------------------

/** A uuid-v4-shaped id derived from a string. Same parts in, same id out. */
export function detId(...parts: string[]): string {
  const key = parts.join('|')
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  let h3 = 0x9e3779b9
  let h4 = 0x85ebca6b
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 + c, 2246822519) >>> 0
    h3 = Math.imul(h3 ^ (c + i), 3266489917) >>> 0
    h4 = Math.imul(h4 + c * (i + 1), 668265263) >>> 0
  }
  const mix = (x: number): number => {
    let v = x >>> 0
    v ^= v >>> 16
    v = Math.imul(v, 2246822507) >>> 0
    v ^= v >>> 13
    v = Math.imul(v, 3266489909) >>> 0
    v ^= v >>> 16
    return v >>> 0
  }
  const words = [mix(h1), mix(h2 ^ h1), mix(h3 ^ h2), mix(h4 ^ h3)]
  const bytes = new Uint8Array(16)
  for (let i = 0; i < 4; i++) {
    bytes[i * 4] = (words[i] >>> 24) & 255
    bytes[i * 4 + 1] = (words[i] >>> 16) & 255
    bytes[i * 4 + 2] = (words[i] >>> 8) & 255
    bytes[i * 4 + 3] = words[i] & 255
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // variant 10
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export type Scenario = 'ace' | 'solo' | 'both'

export const SENDER_ID = detId('sender', 'class-manager')
export const SENDER_PHONE = '+918047182200' // +91 80 4718 2200
export const SENDER_LABEL = 'Class Manager'

export const ACE_ACADEMY_ID = detId('academy', 'ace-tt-academy')
export const NADAM_ACADEMY_ID = detId('academy', 'nadam-vocal')

/** Every academy `seedWorld` can create. The emulator's world is exactly these. */
export const WORLD_ACADEMY_IDS: Record<'ace' | 'solo', string> = {
  ace: ACE_ACADEMY_ID,
  solo: NADAM_ACADEMY_ID,
}

const SEEDED_ACADEMY_IDS = [ACE_ACADEMY_ID, NADAM_ACADEMY_ID]

const svc = (academyId: string): SessionCtx => ({ role: 'service', academyId })

/**
 * The emulator is a *world*, not a tenant, so it reads across academies through
 * `app.list_academies()` — the named, `security definer`, cm_service-only door
 * migration 0007 opened for exactly this. No RLS policy is widened, and a user
 * session cannot execute it, so the agent still sees one tenant at most.
 *
 * Memoised because the SSE poll runs every ~600 ms; `worldState()` and
 * `resetWorld()` refresh it, which covers every way the list can change here.
 */
let academyIdCache: string[] | null = null

export async function worldAcademyIds(o: { refresh?: boolean } = {}): Promise<string[]> {
  if (!o.refresh && academyIdCache !== null) return academyIdCache
  const rows = await withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    return await tx`select id from app.list_academies()`
  })
  academyIdCache = rows.map((r) => String(r.id))
  return academyIdCache
}

// -----------------------------------------------------------------------------
// Bulk insert. Explicit column casts so a text-typed parameter never lands in a
// date/time/jsonb column.
// -----------------------------------------------------------------------------

type Col = readonly [name: string, cast: string]

async function bulk(
  tx: Tx,
  table: string,
  cols: readonly Col[],
  rows: Record<string, unknown>[],
): Promise<void> {
  if (rows.length === 0) return
  const names = cols.map((c) => c[0]).join(', ')
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    const params: unknown[] = []
    const tuples = chunk.map(
      (r) =>
        '(' +
        cols
          .map((c) => {
            const v = r[c[0]]
            params.push(v === undefined ? null : v)
            return `$${params.length}${c[1]}`
          })
          .join(', ') +
        ')',
    )
    await tx.unsafe(
      `insert into ${table} (${names}) values ${tuples.join(', ')}`,
      params as never[],
    )
  }
}

const isoOf = (dt: DateTime): string => dt.toISO() ?? new Date(dt.toMillis()).toISOString()
const dayOf = (dt: DateTime): string => dt.toFormat('yyyy-LL-dd')
const monthOf = (dt: DateTime): string => dt.startOf('month').toFormat('yyyy-LL-dd')

// -----------------------------------------------------------------------------
// Reset — truncate all tenant data.
// -----------------------------------------------------------------------------

/**
 * Deletes both worlds (every `academy_id` FK is `on delete cascade`, and RI
 * cascades run as the table owner, so one delete per academy clears every tenant
 * table), then the global rows: jobs, sim runs, faults, the sender, and the
 * clock offset.
 */
export async function resetWorld(): Promise<void> {
  const live = await worldAcademyIds({ refresh: true })
  for (const id of new Set([...live, ...SEEDED_ACADEMY_IDS])) {
    // `academy_cm_service_all` is `using (id = app.academy_id())`, so the
    // session is pinned to the row it is about to delete. RI cascades run as
    // the table owner, which clears every tenant table in one go.
    await withSession(svc(id), async (tx) => {
      await tx`delete from academy where id = ${id}::uuid`
    })
  }
  // Global tables: cm_service policies are `using (true)`, so the academy this
  // session is pinned to is irrelevant.
  await withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    await tx`delete from job`
    await tx`delete from sim_run`
    await tx`delete from sim_fault`
    await tx`delete from sender`
    await tx`insert into sim_clock (singleton, offset_ms, frozen_at) values (true, 0, null)
             on conflict (singleton) do update set offset_ms = 0, frozen_at = null`
  })
  academyIdCache = null
  await resetClock() // re-sync lib/clock's cached offset
}

// -----------------------------------------------------------------------------
// Session materialisation used by the seed (three weeks out, one week back).
// -----------------------------------------------------------------------------

type SlotDef = { weekday: number; start: string; end: string }

function occurrences(
  classId: string,
  tz: string,
  slots: SlotDef[],
  from: DateTime,
  to: DateTime,
  startsOn: DateTime,
): { id: string; starts: DateTime; ends: DateTime }[] {
  const out: { id: string; starts: DateTime; ends: DateTime }[] = []
  for (const slot of slots) {
    let d = from.setZone(tz).startOf('day')
    const last = to.setZone(tz).endOf('day')
    while (d <= last) {
      if (d.weekday % 7 === slot.weekday && d >= startsOn.startOf('day')) {
        const [sh, sm] = slot.start.split(':').map(Number)
        const [eh, em] = slot.end.split(':').map(Number)
        const starts = d.set({ hour: sh, minute: sm, second: 0, millisecond: 0 })
        const ends = d.set({ hour: eh, minute: em, second: 0, millisecond: 0 })
        out.push({ id: detId('session', classId, String(starts.toMillis())), starts, ends })
      }
      d = d.plus({ days: 1 })
    }
  }
  return out.sort((a, b) => a.starts.toMillis() - b.starts.toMillis())
}

// -----------------------------------------------------------------------------
// Column definitions.
// -----------------------------------------------------------------------------

const VENUE_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['name', ''], ['address', ''], ['notes', '']] as const
const PERSON_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['full_name', ''], ['notes', ''], ['memory', ''], ['settings', '::jsonb']] as const
const CONTACT_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['person_id', '::uuid'], ['phone_e164', ''], ['wa_id', ''], ['profile_name', ''], ['is_primary', '::boolean'], ['state', ''], ['opted_out_at', '::timestamptz'], ['last_inbound_at', '::timestamptz'], ['role_hint', '']] as const
const ACCOUNT_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['holder_person_id', '::uuid'], ['display_name', '']] as const
const PLAYER_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['account_id', '::uuid'], ['person_id', '::uuid'], ['active', '::boolean']] as const
const COACH_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['person_id', '::uuid'], ['pay_amount', '::numeric'], ['pay_unit', ''], ['status', ''], ['invited_at', '::timestamptz'], ['onboarded_at', '::timestamptz'], ['ended_on', '::date']] as const
const ADMIN_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['person_id', '::uuid']] as const
const FACT_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['subject_kind', ''], ['subject_id', '::uuid'], ['fact', ''], ['source', '']] as const
const CLASS_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['name', ''], ['venue_id', '::uuid'], ['rate_amount', '::numeric'], ['rate_unit', ''], ['rate_count', '::int'], ['starts_on', '::date'], ['ends_on', '::date'], ['active', '::boolean']] as const
const SLOT_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['class_id', '::uuid'], ['weekday', '::int'], ['start_time', '::time'], ['end_time', '::time']] as const
const CLASS_COACH_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['class_id', '::uuid'], ['coach_id', '::uuid']] as const
const ENROLLMENT_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['class_id', '::uuid'], ['player_id', '::uuid'], ['rate_amount', '::numeric'], ['rate_unit', ''], ['rate_count', '::int'], ['is_trial', '::boolean'], ['started_on', '::date'], ['ended_on', '::date']] as const
const SESSION_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['class_id', '::uuid'], ['venue_id', '::uuid'], ['starts_at', '::timestamptz'], ['ends_at', '::timestamptz'], ['status', ''], ['cancel_reason', '']] as const
const SESSION_COACH_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['session_id', '::uuid'], ['coach_id', '::uuid'], ['confirmed_at', '::timestamptz'], ['declined_at', '::timestamptz'], ['arrived_at', '::timestamptz'], ['running_late', '::boolean']] as const
const ATTENDANCE_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['session_id', '::uuid'], ['player_id', '::uuid'], ['status', ''], ['note', ''], ['marked_by_coach_id', '::uuid'], ['marked_at', '::timestamptz']] as const
const TALLY_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['account_id', '::uuid'], ['player_id', '::uuid'], ['period', '::date'], ['kind', ''], ['description', ''], ['amount', '::numeric'], ['session_id', '::uuid'], ['reason', ''], ['approved_by', '::uuid']] as const
const PAYMENT_COLS = [['id', '::uuid'], ['academy_id', '::uuid'], ['account_id', '::uuid'], ['amount', '::numeric'], ['rail', ''], ['method', ''], ['reference', ''], ['status', ''], ['requested_at', '::timestamptz'], ['confirmed_at', '::timestamptz'], ['confirmed_by', '::uuid'], ['evidence_url', '']] as const

// -----------------------------------------------------------------------------
// seedWorld
// -----------------------------------------------------------------------------

export type AcademySummary = {
  id: string
  name: string
  persons: number
  contacts: number
  players: number
  coaches: number
  classes: number
  sessions: number
  completedSessions: number
  tallyLines: number
}

export type SeedResult = {
  scenario: Scenario
  nowIso: string
  sender: { id: string; phone: string; label: string }
  academies: AcademySummary[]
}

export async function seedWorld(scenario: Scenario = 'both'): Promise<SeedResult> {
  await resetWorld()
  const base = await now()

  const targets: ('ace' | 'solo')[] =
    scenario === 'ace' ? ['ace'] : scenario === 'solo' ? ['solo'] : ['ace', 'solo']

  // The one sender, shared by every academy (§16: one number, many academies).
  // Written from the first academy's service session; `sender` has no tenant.
  const firstAcademyId = WORLD_ACADEMY_IDS[targets[0]]
  await withSession(svc(firstAcademyId), async (tx) => {
    await tx.unsafe(
      `insert into sender (id, phone_e164, waba_id, credentials, label)
       values ($1::uuid, $2, $3, $4::jsonb, $5)
       on conflict (id) do nothing`,
      [
        SENDER_ID,
        SENDER_PHONE,
        'WABA-EMULATOR-0001',
        JSON.stringify({
          transport: 'emulator',
          phone_number_id: 'PNID-EMULATOR-0001',
          access_token: 'emulator-only-no-real-token',
        }),
        SENDER_LABEL,
      ] as never[],
    )
  })

  const academies: AcademySummary[] = []
  for (const t of targets) {
    academies.push(t === 'ace' ? await seedAce(base) : await seedNadam(base))
  }
  academyIdCache = null // the world just changed shape

  return {
    scenario,
    nowIso: base.toISOString(),
    sender: { id: SENDER_ID, phone: SENDER_PHONE, label: SENDER_LABEL },
    academies,
  }
}

// -----------------------------------------------------------------------------
// Ace TT Academy — table tennis, multi-coach. Proves tenant isolation against
// Nadam, and carries every §6.2 shape: a self-paying adult (n=1), a parent with
// two children (n=2), and a 16-year-old with his own number separate from his
// father's (§6.7 — money-shaped rows never route to a player number).
// -----------------------------------------------------------------------------

async function seedAce(base: Date): Promise<AcademySummary> {
  const A = ACE_ACADEMY_ID
  const tz = 'Asia/Kolkata'
  const nowDT = DateTime.fromJSDate(base, { zone: tz })
  const from = nowDT.minus({ days: 7 })
  const to = nowDT.plus({ days: 21 })
  const period = monthOf(nowDT)
  const monthLabel = nowDT.toFormat('LLLL yyyy')

  const P = (slug: string) => detId('ace', 'person', slug)
  const C = (slug: string) => detId('ace', 'contact', slug)
  const ACCT = (slug: string) => detId('ace', 'account', slug)
  const PL = (slug: string) => detId('ace', 'player', slug)
  const CO = (slug: string) => detId('ace', 'coach', slug)
  const CLS = (slug: string) => detId('ace', 'class', slug)
  const VEN = (slug: string) => detId('ace', 'venue', slug)
  const ts = (d: DateTime): string => isoOf(d)

  const people: { slug: string; name: string; notes?: string; memory?: string; settings?: string }[] = [
    { slug: 'sharwin', name: 'Sharwin Rao', notes: 'Runs the academy. Confirms every UPI payment himself.' },
    { slug: 'arjun', name: 'Arjun Menon', memory: 'Never taps buttons - always types a reply.' },
    { slug: 'priya', name: 'Priya Shetty', settings: JSON.stringify({ coach_coming_lead_minutes: 120 }) },
    { slug: 'ravi', name: 'Ravi Deshpande', notes: 'Invited as a coach, never opened the invite.' },
    { slug: 'meera', name: 'Meera Iyer', memory: 'Asks about collections every Monday morning.', settings: JSON.stringify({ client_reminder_lead_hours: 20 }) },
    { slug: 'aarav', name: 'Aarav Iyer' },
    { slug: 'ananya', name: 'Ananya Iyer' },
    { slug: 'deepa', name: 'Deepa Nair', notes: 'Plays herself. Holds her own account.' },
    { slug: 'rajesh', name: 'Rajesh Kumar' },
    { slug: 'kiran', name: 'Kiran Kumar', notes: '16. Has his own number; fees go to Rajesh.' },
    { slug: 'sunita', name: 'Sunita Bhat' },
    { slug: 'vivaan', name: 'Vivaan Bhat' },
    { slug: 'diya', name: 'Diya Bhat' },
    { slug: 'farhan', name: 'Farhan Sheikh' },
    { slug: 'zoya', name: 'Zoya Sheikh' },
    { slug: 'anjali', name: 'Anjali Rao' },
    { slug: 'ishaan', name: 'Ishaan Rao' },
    { slug: 'vikram', name: 'Vikram Joshi' },
    { slug: 'neha', name: 'Neha Joshi' },
    { slug: 'lata', name: 'Lata Pillai' },
    { slug: 'rohan', name: 'Rohan Pillai' },
  ]

  const contacts: { slug: string; phone: string; state: string; lastInbound: DateTime | null; roleHint: string; profileName?: string }[] = [
    { slug: 'sharwin', phone: '+919845010001', state: 'engaged', lastInbound: nowDT.minus({ hours: 2 }), roleHint: 'admin', profileName: 'Sharwin' },
    { slug: 'arjun', phone: '+919845010002', state: 'engaged', lastInbound: nowDT.minus({ hours: 3 }), roleHint: 'coach', profileName: 'Arjun M' },
    { slug: 'priya', phone: '+919845010003', state: 'registered', lastInbound: null, roleHint: 'coach' },
    { slug: 'ravi', phone: '+919845010004', state: 'registered', lastInbound: null, roleHint: 'coach' },
    { slug: 'meera', phone: '+919845010010', state: 'engaged', lastInbound: nowDT.minus({ minutes: 90 }), roleHint: 'parent', profileName: 'Meera' },
    { slug: 'deepa', phone: '+919845010011', state: 'registered', lastInbound: null, roleHint: 'parent' },
    { slug: 'rajesh', phone: '+919845010012', state: 'registered', lastInbound: null, roleHint: 'parent' },
    // Kiran is engaged but OUTSIDE the 24h window - the clearest
    // template-vs-in-window contrast in the world.
    { slug: 'kiran', phone: '+919845010013', state: 'engaged', lastInbound: nowDT.minus({ hours: 26 }), roleHint: 'player', profileName: 'Kiran' },
    { slug: 'sunita', phone: '+919845010014', state: 'registered', lastInbound: null, roleHint: 'parent' },
    { slug: 'farhan', phone: '+919845010015', state: 'registered', lastInbound: null, roleHint: 'parent' },
    { slug: 'anjali', phone: '+919845010016', state: 'registered', lastInbound: null, roleHint: 'parent' },
    { slug: 'vikram', phone: '+919845010017', state: 'registered', lastInbound: null, roleHint: 'parent' },
    { slug: 'lata', phone: '+919845010018', state: 'registered', lastInbound: null, roleHint: 'parent' },
  ]

  const accounts: { slug: string; holder: string; display: string }[] = [
    { slug: 'meera', holder: 'meera', display: 'Meera Iyer' },
    { slug: 'deepa', holder: 'deepa', display: 'Deepa Nair' },
    { slug: 'rajesh', holder: 'rajesh', display: 'Rajesh Kumar' },
    { slug: 'sunita', holder: 'sunita', display: 'Sunita Bhat' },
    { slug: 'farhan', holder: 'farhan', display: 'Farhan Sheikh' },
    { slug: 'anjali', holder: 'anjali', display: 'Anjali Rao' },
    { slug: 'vikram', holder: 'vikram', display: 'Vikram Joshi' },
    { slug: 'lata', holder: 'lata', display: 'Lata Pillai' },
  ]

  // 10 players across 8 families. `deepa` is the §6.2 n=1 case:
  // account.holder_person_id = player.person_id.
  const players: { slug: string; account: string; person: string }[] = [
    { slug: 'aarav', account: 'meera', person: 'aarav' },
    { slug: 'ananya', account: 'meera', person: 'ananya' },
    { slug: 'deepa', account: 'deepa', person: 'deepa' },
    { slug: 'kiran', account: 'rajesh', person: 'kiran' },
    { slug: 'vivaan', account: 'sunita', person: 'vivaan' },
    { slug: 'diya', account: 'sunita', person: 'diya' },
    { slug: 'zoya', account: 'farhan', person: 'zoya' },
    { slug: 'ishaan', account: 'anjali', person: 'ishaan' },
    { slug: 'neha', account: 'vikram', person: 'neha' },
    { slug: 'rohan', account: 'lata', person: 'rohan' },
  ]

  const coaches: { slug: string; pay: number | null; unit: string | null; status: string; invited: DateTime | null; onboarded: DateTime | null }[] = [
    { slug: 'arjun', pay: 500, unit: 'per_session', status: 'active', invited: nowDT.minus({ days: 60 }), onboarded: nowDT.minus({ days: 59 }) },
    { slug: 'priya', pay: 450, unit: 'per_session', status: 'active', invited: nowDT.minus({ days: 40 }), onboarded: nowDT.minus({ days: 39 }) },
    // Ravi exists so AD-COACH-NOT-ONBOARDED has something to fire on.
    { slug: 'ravi', pay: null, unit: null, status: 'invited', invited: nowDT.minus({ days: 5 }), onboarded: null },
  ]

  const classes: { slug: string; name: string; venue: string; rate: number; unit: string; count: number | null; startsOn: DateTime; slots: SlotDef[]; coaches: string[] }[] = [
    {
      slug: 'beginners', name: '6:30 Beginners Batch', venue: 'green-park',
      rate: 2400, unit: 'per_month', count: null, startsOn: nowDT.minus({ days: 60 }),
      slots: [
        { weekday: 1, start: '18:30', end: '19:30' },
        { weekday: 3, start: '18:30', end: '19:30' },
        { weekday: 5, start: '18:30', end: '19:30' },
      ],
      coaches: ['arjun'],
    },
    {
      // Two coaches, so a decline still leaves it covered (§6.3 derived coverage).
      slug: 'advanced', name: 'Saturday Advanced', venue: 'green-park',
      rate: 400, unit: 'per_session', count: null, startsOn: nowDT.minus({ days: 60 }),
      slots: [{ weekday: 6, start: '08:00', end: '10:00' }],
      coaches: ['arjun', 'priya'],
    },
    {
      slug: 'camp', name: 'Sunday Camp', venue: 'indiranagar',
      rate: 3000, unit: 'per_package', count: 10, startsOn: nowDT.minus({ days: 30 }),
      slots: [{ weekday: 0, start: '07:00', end: '09:00' }],
      coaches: ['arjun'],
    },
  ]

  const enrollments: { cls: string; player: string; startedDaysAgo: number }[] = [
    ...['aarav', 'vivaan', 'diya', 'zoya', 'ishaan', 'rohan'].map((p) => ({ cls: 'beginners', player: p, startedDaysAgo: 55 })),
    ...['ananya', 'kiran', 'neha', 'deepa'].map((p) => ({ cls: 'advanced', player: p, startedDaysAgo: 50 })),
    ...['aarav', 'kiran', 'neha'].map((p) => ({ cls: 'camp', player: p, startedDaysAgo: 25 })),
  ]

  const accountOfPlayer = new Map(players.map((p) => [p.slug, p.account]))

  const sessionRows: Record<string, unknown>[] = []
  const sessionCoachRows: Record<string, unknown>[] = []
  const attendanceRows: Record<string, unknown>[] = []
  const tallyRows: Record<string, unknown>[] = []
  let completed = 0

  for (const cls of classes) {
    const classId = CLS(cls.slug)
    const occ = occurrences(classId, tz, cls.slots, from, to, cls.startsOn)
    const roster = enrollments.filter((e) => e.cls === cls.slug).map((e) => e.player)
    let pastIndex = 0
    let futureIndex = 0

    for (const o of occ) {
      const isPast = o.starts.toMillis() < nowDT.toMillis()
      sessionRows.push({
        id: o.id, academy_id: A, class_id: classId, venue_id: null,
        starts_at: ts(o.starts), ends_at: ts(o.ends),
        status: isPast ? 'completed' : 'scheduled', cancel_reason: null,
      })
      if (isPast) completed++

      for (const coachSlug of cls.coaches) {
        const coachId = CO(coachSlug)
        let confirmed: string | null = null
        let declined: string | null = null
        let arrived: string | null = null
        if (isPast) {
          confirmed = ts(o.starts.minus({ hours: 12 }))
          arrived = ts(o.starts.minus({ minutes: 5 }))
        } else if (cls.slug === 'advanced' && futureIndex === 0) {
          // The next Saturday: Priya drops, Arjun is confirmed. Declined, still covered.
          if (coachSlug === 'priya') declined = ts(nowDT.minus({ hours: 6 }))
          else confirmed = ts(nowDT.minus({ hours: 8 }))
        } else if (cls.slug === 'beginners' && futureIndex === 0) {
          confirmed = ts(nowDT.minus({ hours: 1 }))
        }
        // Everything else stays unconfirmed, so the §8.2 ladder and
        // admin_escalate_uncovered have something real to fire on.
        sessionCoachRows.push({
          id: detId('session_coach', o.id, coachId), academy_id: A, session_id: o.id,
          coach_id: coachId, confirmed_at: confirmed, declined_at: declined,
          arrived_at: arrived, running_late: false,
        })
      }

      if (isPast) {
        for (const playerSlug of roster) {
          const status =
            playerSlug === 'neha' ? 'absent'
              : playerSlug === 'kiran' && pastIndex === 0 ? 'late'
              : 'present'
          const note =
            status === 'absent' ? 'Family travel - asked to rebook'
              : status === 'late' ? 'Arrived 15 minutes in'
              : null
          attendanceRows.push({
            id: detId('attendance', o.id, PL(playerSlug)), academy_id: A, session_id: o.id,
            player_id: PL(playerSlug), status, note,
            marked_by_coach_id: CO(cls.coaches[0]), marked_at: ts(o.ends),
          })
          // §6.4: a per_session line is written when attendance is marked
          // present/late/absent. per_package sessions consume the package
          // instead, so they write no session line.
          if (cls.unit === 'per_session') {
            tallyRows.push({
              id: detId('tally', o.id, PL(playerSlug)), academy_id: A,
              account_id: ACCT(accountOfPlayer.get(playerSlug)!), player_id: PL(playerSlug),
              period: monthOf(o.starts), kind: 'session',
              description: `${cls.name} - ${o.starts.toFormat('d LLL')}`,
              amount: cls.rate, session_id: o.id, reason: null, approved_by: null,
            })
          }
        }
        pastIndex++
      } else {
        futureIndex++
      }
    }
  }

  // per_month lines for the current period, one per active enrollment (§6.4).
  for (const e of enrollments) {
    const cls = classes.find((c) => c.slug === e.cls)!
    if (cls.unit === 'per_month') {
      tallyRows.push({
        id: detId('tally', 'monthly', period, CLS(cls.slug), PL(e.player)), academy_id: A,
        account_id: ACCT(accountOfPlayer.get(e.player)!), player_id: PL(e.player),
        period, kind: 'monthly', description: `${cls.name} - ${monthLabel}`,
        amount: cls.rate, session_id: null, reason: null, approved_by: null,
      })
    }
    if (cls.unit === 'per_package') {
      // §6.4: the count remaining rides on the tally.
      const consumed = attendanceRows.filter(
        (a) =>
          a.player_id === PL(e.player) &&
          sessionRows.some((s) => s.id === a.session_id && s.class_id === CLS(cls.slug)),
      ).length
      const remaining = (cls.count ?? 0) - consumed
      tallyRows.push({
        id: detId('tally', 'package', period, CLS(cls.slug), PL(e.player)), academy_id: A,
        account_id: ACCT(accountOfPlayer.get(e.player)!), player_id: PL(e.player),
        period, kind: 'package',
        description: `${cls.name} - ${cls.count}-session package (${remaining} of ${cls.count} left)`,
        amount: cls.rate, session_id: null, reason: null, approved_by: null,
      })
    }
  }

  // §6.4: adjustments are one primitive, not six features.
  tallyRows.push({
    id: detId('tally', 'adjustment', period, 'lata'), academy_id: A,
    account_id: ACCT('lata'), player_id: PL('rohan'), period, kind: 'adjustment',
    description: 'Goodwill credit - court unavailable', amount: -400, session_id: null,
    reason: 'Court double-booked on the 5th; Sharwin offered a credit',
    approved_by: P('sharwin'),
  })

  const owedBy = (acct: string): number =>
    tallyRows
      .filter((t) => t.account_id === ACCT(acct))
      .reduce((n, t) => n + Number(t.amount), 0)

  // Two families unpaid (Meera has an outstanding request, Vikram nothing at
  // all), one confirmed payment (Sunita).
  const paymentRows: Record<string, unknown>[] = [
    {
      id: detId('payment', 'sunita', period), academy_id: A, account_id: ACCT('sunita'),
      amount: owedBy('sunita'), rail: 'rail1', method: 'upi',
      reference: 'UPI/2026/AC/44821', status: 'confirmed',
      requested_at: ts(nowDT.minus({ days: 4 })), confirmed_at: ts(nowDT.minus({ days: 2 })),
      confirmed_by: P('sharwin'), evidence_url: null,
    },
    {
      id: detId('payment', 'meera', period), academy_id: A, account_id: ACCT('meera'),
      amount: owedBy('meera'), rail: 'rail1', method: 'upi',
      reference: null, status: 'requested',
      requested_at: ts(nowDT.minus({ days: 1 })), confirmed_at: null,
      confirmed_by: null, evidence_url: null,
    },
  ]

  await withSession(svc(A), async (tx) => {
    await tx.unsafe(
      `insert into academy (id, name, category, timezone, cancellation_window_hours,
         client_reminder_lead_hours, morning_brief_at, evening_digest_at, rail, upi_handle,
         sender_id, memory, settings, created_on, onboarding_state)
       values ($1::uuid,$2,$3,$4,$5::int,$6::int,$7::time,$8::time,$9,$10,$11::uuid,$12,$13::jsonb,$14::date,$15)`,
      [
        A, 'Ace TT Academy', 'table tennis', tz, 24, 14, '07:00', '21:00', 'rail1', 'sharwin@upi',
        SENDER_ID,
        'Sharwin calls them batches, not classes. Fees come by UPI to sharwin@upi and he confirms each one himself. Saturday Advanced is the flagship batch.',
        JSON.stringify({}),
        dayOf(nowDT.minus({ days: 45 })),
        'live',
      ] as never[],
    )

    await bulk(tx, 'venue', VENUE_COLS, [
      { id: VEN('green-park'), academy_id: A, name: 'Green Park', address: 'Green Park Sports Complex, 12th Main, Malleswaram', notes: 'Four tables. Gate closes at 21:00.' },
      { id: VEN('indiranagar'), academy_id: A, name: 'Indiranagar', address: 'Indiranagar Club Courts, 100 Feet Road', notes: 'Sunday mornings only.' },
    ])

    await bulk(tx, 'person', PERSON_COLS, people.map((p) => ({
      id: P(p.slug), academy_id: A, full_name: p.name, notes: p.notes ?? null,
      memory: p.memory ?? null, settings: p.settings ?? '{}',
    })))

    await bulk(tx, 'contact', CONTACT_COLS, contacts.map((c) => ({
      id: C(c.slug), academy_id: A, person_id: P(c.slug), phone_e164: c.phone,
      wa_id: c.phone.replace('+', ''), profile_name: c.profileName ?? null, is_primary: true,
      state: c.state, opted_out_at: null,
      last_inbound_at: c.lastInbound ? ts(c.lastInbound) : null, role_hint: c.roleHint,
    })))

    await bulk(tx, 'account', ACCOUNT_COLS, accounts.map((a) => ({
      id: ACCT(a.slug), academy_id: A, holder_person_id: P(a.holder), display_name: a.display,
    })))

    await bulk(tx, 'player', PLAYER_COLS, players.map((p) => ({
      id: PL(p.slug), academy_id: A, account_id: ACCT(p.account), person_id: P(p.person), active: true,
    })))

    await bulk(tx, 'coach', COACH_COLS, coaches.map((c) => ({
      id: CO(c.slug), academy_id: A, person_id: P(c.slug), pay_amount: c.pay, pay_unit: c.unit,
      status: c.status, invited_at: c.invited ? ts(c.invited) : null,
      onboarded_at: c.onboarded ? ts(c.onboarded) : null, ended_on: null,
    })))

    await bulk(tx, 'academy_admin', ADMIN_COLS, [
      { id: detId('ace', 'admin', 'sharwin'), academy_id: A, person_id: P('sharwin') },
    ])

    await bulk(tx, 'class', CLASS_COLS, classes.map((c) => ({
      id: CLS(c.slug), academy_id: A, name: c.name, venue_id: VEN(c.venue),
      rate_amount: c.rate, rate_unit: c.unit, rate_count: c.count,
      starts_on: dayOf(c.startsOn), ends_on: null, active: true,
    })))

    await bulk(tx, 'class_slot', SLOT_COLS, classes.flatMap((c) =>
      c.slots.map((s) => ({
        id: detId('ace', 'slot', c.slug, String(s.weekday), s.start), academy_id: A,
        class_id: CLS(c.slug), weekday: s.weekday, start_time: s.start, end_time: s.end,
      })),
    ))

    await bulk(tx, 'class_coach', CLASS_COACH_COLS, classes.flatMap((c) =>
      c.coaches.map((co) => ({
        id: detId('ace', 'class_coach', c.slug, co), academy_id: A,
        class_id: CLS(c.slug), coach_id: CO(co),
      })),
    ))

    await bulk(tx, 'enrollment', ENROLLMENT_COLS, enrollments.map((e) => ({
      id: detId('ace', 'enrollment', e.cls, e.player), academy_id: A, class_id: CLS(e.cls),
      player_id: PL(e.player), rate_amount: null, rate_unit: null, rate_count: null,
      is_trial: false, started_on: dayOf(nowDT.minus({ days: e.startedDaysAgo })), ended_on: null,
    })))

    await bulk(tx, 'session', SESSION_COLS, sessionRows)
    await bulk(tx, 'session_coach', SESSION_COACH_COLS, sessionCoachRows)
    await bulk(tx, 'attendance', ATTENDANCE_COLS, attendanceRows)
    await bulk(tx, 'tally_line', TALLY_COLS, tallyRows)
    await bulk(tx, 'payment', PAYMENT_COLS, paymentRows)

    await bulk(tx, 'memory_fact', FACT_COLS, [
      { id: detId('ace', 'fact', '1'), academy_id: A, subject_kind: 'academy', subject_id: A, fact: 'Sharwin calls them batches, not classes', source: 'onboarding' },
      { id: detId('ace', 'fact', '2'), academy_id: A, subject_kind: 'academy', subject_id: A, fact: 'Fees are collected by UPI to sharwin@upi; Sharwin confirms each payment himself', source: 'onboarding' },
      { id: detId('ace', 'fact', '3'), academy_id: A, subject_kind: 'person', subject_id: P('meera'), fact: 'Meera asks about collections every Monday morning', source: 'observed' },
      { id: detId('ace', 'fact', '4'), academy_id: A, subject_kind: 'person', subject_id: P('arjun'), fact: 'Arjun never taps buttons, always types', source: 'observed' },
      { id: detId('ace', 'fact', '5'), academy_id: A, subject_kind: 'person', subject_id: P('deepa'), fact: 'Deepa plays herself - there is no child on her account', source: 'onboarding' },
      { id: detId('ace', 'fact', '6'), academy_id: A, subject_kind: 'person', subject_id: P('kiran'), fact: 'Kiran has his own number; anything about money goes to his father Rajesh', source: 'onboarding' },
      { id: detId('ace', 'fact', '7'), academy_id: A, subject_kind: 'person', subject_id: P('priya'), fact: 'Priya wants her session prompt two hours ahead, not one', source: 'observed' },
    ])
  })

  return {
    id: A, name: 'Ace TT Academy', persons: people.length, contacts: contacts.length,
    players: players.length, coaches: coaches.length, classes: classes.length,
    sessions: sessionRows.length, completedSessions: completed, tallyLines: tallyRows.length,
  }
}

// -----------------------------------------------------------------------------
// Nadam Vocal — the §18 solo case. Lakshmi is ONE person with both an
// `academy_admin` row and an `active` `coach` row, which is what the two
// suppression rules on the send path detect. It exists so they can be watched
// working: nobody is ever asked to confirm something to themselves, and no
// escalation about the coach pings the coach.
// -----------------------------------------------------------------------------

async function seedNadam(base: Date): Promise<AcademySummary> {
  const A = NADAM_ACADEMY_ID
  const tz = 'Asia/Kolkata'
  const nowDT = DateTime.fromJSDate(base, { zone: tz })
  const from = nowDT.minus({ days: 7 })
  const to = nowDT.plus({ days: 21 })
  const period = monthOf(nowDT)
  const monthLabel = nowDT.toFormat('LLLL yyyy')

  const P = (slug: string) => detId('solo', 'person', slug)
  const C = (slug: string) => detId('solo', 'contact', slug)
  const ACCT = (slug: string) => detId('solo', 'account', slug)
  const PL = (slug: string) => detId('solo', 'player', slug)
  const CO = (slug: string) => detId('solo', 'coach', slug)
  const CLS = (slug: string) => detId('solo', 'class', slug)
  const VEN = (slug: string) => detId('solo', 'venue', slug)
  const ts = (d: DateTime): string => isoOf(d)

  const people: { slug: string; name: string; notes?: string; memory?: string }[] = [
    { slug: 'lakshmi', name: 'Lakshmi Subramanian', notes: 'Runs Nadam Vocal and teaches every class herself.', memory: 'Both the admin and the only coach. Never ask her to confirm her own class.' },
    { slug: 'ramesh', name: 'Ramesh Iyengar' },
    { slug: 'anika', name: 'Anika Iyengar' },
    { slug: 'gayatri', name: 'Gayatri Rao' },
    { slug: 'vedanth', name: 'Vedanth Rao' },
    { slug: 'suresh', name: 'Suresh Krishnan' },
    { slug: 'shruti', name: 'Shruti Krishnan' },
    { slug: 'padma', name: 'Padma Venkatesh' },
    { slug: 'meghana', name: 'Meghana Venkatesh' },
    { slug: 'nithya', name: 'Nithya Balan', notes: 'Adult learner. Holds her own account.' },
    { slug: 'kaushik', name: 'Kaushik Ramanathan', notes: 'Adult learner. Holds his own account.' },
  ]

  const contacts: { slug: string; phone: string; state: string; lastInbound: DateTime | null; roleHint: string; profileName?: string }[] = [
    { slug: 'lakshmi', phone: '+919845020001', state: 'engaged', lastInbound: nowDT.minus({ hours: 4 }), roleHint: 'admin', profileName: 'Lakshmi' },
    { slug: 'ramesh', phone: '+919845020002', state: 'registered', lastInbound: null, roleHint: 'parent' },
    { slug: 'gayatri', phone: '+919845020003', state: 'engaged', lastInbound: nowDT.minus({ hours: 5 }), roleHint: 'parent', profileName: 'Gayatri' },
    { slug: 'suresh', phone: '+919845020004', state: 'registered', lastInbound: null, roleHint: 'parent' },
    { slug: 'padma', phone: '+919845020005', state: 'registered', lastInbound: null, roleHint: 'parent' },
    { slug: 'nithya', phone: '+919845020006', state: 'registered', lastInbound: null, roleHint: 'parent' },
    { slug: 'kaushik', phone: '+919845020007', state: 'registered', lastInbound: null, roleHint: 'parent' },
  ]

  // Four parent-held accounts and two self-paying adults (§6.2 at n=1 again).
  const accounts: { slug: string; holder: string; display: string }[] = [
    { slug: 'ramesh', holder: 'ramesh', display: 'Ramesh Iyengar' },
    { slug: 'gayatri', holder: 'gayatri', display: 'Gayatri Rao' },
    { slug: 'suresh', holder: 'suresh', display: 'Suresh Krishnan' },
    { slug: 'padma', holder: 'padma', display: 'Padma Venkatesh' },
    { slug: 'nithya', holder: 'nithya', display: 'Nithya Balan' },
    { slug: 'kaushik', holder: 'kaushik', display: 'Kaushik Ramanathan' },
  ]

  const players: { slug: string; account: string; person: string }[] = [
    { slug: 'anika', account: 'ramesh', person: 'anika' },
    { slug: 'vedanth', account: 'gayatri', person: 'vedanth' },
    { slug: 'shruti', account: 'suresh', person: 'shruti' },
    { slug: 'meghana', account: 'padma', person: 'meghana' },
    { slug: 'nithya', account: 'nithya', person: 'nithya' },
    { slug: 'kaushik', account: 'kaushik', person: 'kaushik' },
  ]

  const classes: { slug: string; name: string; rate: number; unit: string; startsOn: DateTime; slots: SlotDef[] }[] = [
    { slug: 'tuesday', name: 'Tuesday Beginners', rate: 1800, unit: 'per_month', startsOn: nowDT.minus({ days: 20 }), slots: [{ weekday: 2, start: '17:00', end: '18:00' }] },
    { slug: 'kriti', name: 'Saturday Kriti', rate: 1800, unit: 'per_month', startsOn: nowDT.minus({ days: 20 }), slots: [{ weekday: 6, start: '10:00', end: '11:30' }] },
  ]

  const enrollments: { cls: string; player: string }[] = [
    { cls: 'tuesday', player: 'anika' },
    { cls: 'tuesday', player: 'vedanth' },
    { cls: 'tuesday', player: 'shruti' },
    { cls: 'tuesday', player: 'nithya' },
    { cls: 'kriti', player: 'shruti' },
    { cls: 'kriti', player: 'nithya' },
    { cls: 'kriti', player: 'kaushik' },
    { cls: 'kriti', player: 'meghana' },
  ]

  const accountOfPlayer = new Map(players.map((p) => [p.slug, p.account]))

  const sessionRows: Record<string, unknown>[] = []
  const sessionCoachRows: Record<string, unknown>[] = []
  const attendanceRows: Record<string, unknown>[] = []
  const tallyRows: Record<string, unknown>[] = []
  let completed = 0

  for (const cls of classes) {
    const classId = CLS(cls.slug)
    const occ = occurrences(classId, tz, cls.slots, from, to, cls.startsOn)
    const roster = enrollments.filter((e) => e.cls === cls.slug).map((e) => e.player)

    for (const o of occ) {
      const isPast = o.starts.toMillis() < nowDT.toMillis()
      sessionRows.push({
        id: o.id, academy_id: A, class_id: classId, venue_id: null,
        starts_at: ts(o.starts), ends_at: ts(o.ends),
        status: isPast ? 'completed' : 'scheduled', cancel_reason: null,
      })
      if (isPast) completed++

      // Lakshmi is always on her own sessions and always "arrived" in the past;
      // future ones carry no confirmation because she is never asked for one.
      sessionCoachRows.push({
        id: detId('session_coach', o.id, CO('lakshmi')), academy_id: A, session_id: o.id,
        coach_id: CO('lakshmi'),
        confirmed_at: isPast ? ts(o.starts.minus({ hours: 12 })) : null,
        declined_at: null,
        arrived_at: isPast ? ts(o.starts.minus({ minutes: 10 })) : null,
        running_late: false,
      })

      if (isPast) {
        for (const playerSlug of roster) {
          attendanceRows.push({
            id: detId('attendance', o.id, PL(playerSlug)), academy_id: A, session_id: o.id,
            player_id: PL(playerSlug), status: playerSlug === 'meghana' ? 'absent' : 'present',
            note: playerSlug === 'meghana' ? 'Exams' : null,
            marked_by_coach_id: CO('lakshmi'), marked_at: ts(o.ends),
          })
        }
      }
    }
  }

  for (const e of enrollments) {
    const cls = classes.find((c) => c.slug === e.cls)!
    tallyRows.push({
      id: detId('tally', 'monthly', period, CLS(cls.slug), PL(e.player)), academy_id: A,
      account_id: ACCT(accountOfPlayer.get(e.player)!), player_id: PL(e.player),
      period, kind: 'monthly', description: `${cls.name} - ${monthLabel}`,
      amount: cls.rate, session_id: null, reason: null, approved_by: null,
    })
  }

  const paymentRows: Record<string, unknown>[] = [
    {
      id: detId('payment', 'solo', 'ramesh', period), academy_id: A, account_id: ACCT('ramesh'),
      amount: 1800, rail: 'rail1', method: 'upi', reference: 'UPI/2026/NV/10233',
      status: 'confirmed', requested_at: ts(nowDT.minus({ days: 5 })),
      confirmed_at: ts(nowDT.minus({ days: 4 })), confirmed_by: P('lakshmi'), evidence_url: null,
    },
  ]

  await withSession(svc(A), async (tx) => {
    await tx.unsafe(
      `insert into academy (id, name, category, timezone, cancellation_window_hours,
         client_reminder_lead_hours, morning_brief_at, evening_digest_at, rail, upi_handle,
         sender_id, memory, settings, created_on, onboarding_state)
       values ($1::uuid,$2,$3,$4,$5::int,$6::int,$7::time,$8::time,$9,$10,$11::uuid,$12,$13::jsonb,$14::date,$15)`,
      [
        A, 'Nadam Vocal', 'carnatic vocal', tz, 24, 14, '06:30', '20:30', 'rail1', 'lakshmi@upi',
        SENDER_ID,
        'Lakshmi teaches every class herself. She is both the admin and the only coach, so she is never asked to confirm her own sessions.',
        JSON.stringify({}),
        dayOf(nowDT.minus({ days: 10 })),
        'live',
      ] as never[],
    )

    await bulk(tx, 'venue', VENUE_COLS, [
      { id: VEN('studio'), academy_id: A, name: 'Malleswaram Studio', address: '4th Cross, Malleswaram', notes: 'Ground floor room, seats twelve.' },
    ])

    await bulk(tx, 'person', PERSON_COLS, people.map((p) => ({
      id: P(p.slug), academy_id: A, full_name: p.name, notes: p.notes ?? null,
      memory: p.memory ?? null, settings: '{}',
    })))

    await bulk(tx, 'contact', CONTACT_COLS, contacts.map((c) => ({
      id: C(c.slug), academy_id: A, person_id: P(c.slug), phone_e164: c.phone,
      wa_id: c.phone.replace('+', ''), profile_name: c.profileName ?? null, is_primary: true,
      state: c.state, opted_out_at: null,
      last_inbound_at: c.lastInbound ? ts(c.lastInbound) : null, role_hint: c.roleHint,
    })))

    await bulk(tx, 'account', ACCOUNT_COLS, accounts.map((a) => ({
      id: ACCT(a.slug), academy_id: A, holder_person_id: P(a.holder), display_name: a.display,
    })))

    await bulk(tx, 'player', PLAYER_COLS, players.map((p) => ({
      id: PL(p.slug), academy_id: A, account_id: ACCT(p.account), person_id: P(p.person), active: true,
    })))

    // One person, an academy_admin row AND an active coach row. This is §18.
    await bulk(tx, 'coach', COACH_COLS, [{
      id: CO('lakshmi'), academy_id: A, person_id: P('lakshmi'), pay_amount: null,
      pay_unit: null, status: 'active', invited_at: null,
      onboarded_at: ts(nowDT.minus({ days: 10 })), ended_on: null,
    }])

    await bulk(tx, 'academy_admin', ADMIN_COLS, [
      { id: detId('solo', 'admin', 'lakshmi'), academy_id: A, person_id: P('lakshmi') },
    ])

    await bulk(tx, 'class', CLASS_COLS, classes.map((c) => ({
      id: CLS(c.slug), academy_id: A, name: c.name, venue_id: VEN('studio'),
      rate_amount: c.rate, rate_unit: c.unit, rate_count: null,
      starts_on: dayOf(c.startsOn), ends_on: null, active: true,
    })))

    await bulk(tx, 'class_slot', SLOT_COLS, classes.flatMap((c) =>
      c.slots.map((s) => ({
        id: detId('solo', 'slot', c.slug, String(s.weekday), s.start), academy_id: A,
        class_id: CLS(c.slug), weekday: s.weekday, start_time: s.start, end_time: s.end,
      })),
    ))

    await bulk(tx, 'class_coach', CLASS_COACH_COLS, classes.map((c) => ({
      id: detId('solo', 'class_coach', c.slug, 'lakshmi'), academy_id: A,
      class_id: CLS(c.slug), coach_id: CO('lakshmi'),
    })))

    await bulk(tx, 'enrollment', ENROLLMENT_COLS, enrollments.map((e) => ({
      id: detId('solo', 'enrollment', e.cls, e.player), academy_id: A, class_id: CLS(e.cls),
      player_id: PL(e.player), rate_amount: null, rate_unit: null, rate_count: null,
      is_trial: false, started_on: dayOf(nowDT.minus({ days: 18 })), ended_on: null,
    })))

    await bulk(tx, 'session', SESSION_COLS, sessionRows)
    await bulk(tx, 'session_coach', SESSION_COACH_COLS, sessionCoachRows)
    await bulk(tx, 'attendance', ATTENDANCE_COLS, attendanceRows)
    await bulk(tx, 'tally_line', TALLY_COLS, tallyRows)
    await bulk(tx, 'payment', PAYMENT_COLS, paymentRows)

    await bulk(tx, 'memory_fact', FACT_COLS, [
      { id: detId('solo', 'fact', '1'), academy_id: A, subject_kind: 'academy', subject_id: A, fact: 'Lakshmi teaches alone - she is both the admin and the only coach', source: 'onboarding' },
      { id: detId('solo', 'fact', '2'), academy_id: A, subject_kind: 'person', subject_id: P('lakshmi'), fact: 'Lakshmi does not want to be asked to confirm her own classes', source: 'observed' },
      { id: detId('solo', 'fact', '3'), academy_id: A, subject_kind: 'person', subject_id: P('gayatri'), fact: 'Gayatri replies late in the evening, never during the day', source: 'observed' },
    ])
  })

  return {
    id: A, name: 'Nadam Vocal', persons: people.length, contacts: contacts.length,
    players: players.length, coaches: 1, classes: classes.length,
    sessions: sessionRows.length, completedSessions: completed, tallyLines: tallyRows.length,
  }
}

// =============================================================================
// READ MODEL — what the emulator renders.
// =============================================================================

const WINDOW_MS = 24 * 60 * 60 * 1000

export type WorldContact = {
  id: string
  academyId: string
  academyName: string
  personId: string
  name: string
  phone: string
  waId: string | null
  profileName: string | null
  state: string
  roles: Role[]
  coachId: string | null
  coachStatus: string | null
  isPrimary: boolean
  /** The academy's §18 shape, carried on the contact so a pane can label itself. */
  isSolo: boolean
  note: string | null
  optedOutAt: string | null
  lastInboundAt: string | null
  inWindow: boolean
  messageCount: number
  lastMessageAt: string | null
}

export type WorldSession = {
  id: string
  className: string
  venueName: string | null
  startsAt: string
  endsAt: string
  status: string
  covered: boolean
}

export type WorldAcademy = {
  id: string
  name: string
  category: string | null
  timezone: string
  onboardingState: string
  upiHandle: string | null
  cancellationWindowHours: number
  clientReminderLeadHours: number
  morningBriefAt: string
  eveningDigestAt: string
  createdOn: string
  memory: string | null
  rail: string
  senderPhone: string
  senderLabel: string | null
  isSolo: boolean
  counts: { classes: number; players: number; coaches: number; sessions: number; upcoming: number }
  contacts: WorldContact[]
  upcoming: WorldSession[]
}

export type WorldClock = {
  nowIso: string
  /** Alias, because a clock is read by several consumers under both names. */
  now: string
  offsetMs: number
  nextEventAt: string | null
  nextEventAtIso: string | null
}

export type WorldState = {
  seeded: boolean
  /** Which seed the world currently is, derived from what is actually there. */
  scenario: Scenario | null
  clock: WorldClock
  sender: { id: string; phone: string; label: string } | null
  academies: WorldAcademy[]
  /** Every contact in the world, flat — the contact tray opens any of them. */
  contacts: WorldContact[]
  scenarios: { id: Scenario; name: string; description: string }[]
  faults: { kind: string; active: boolean; rate: number }[]
  jobs: { pending: number; running: number; done: number; failed: number; skipped: number; nextRunAt: string | null }
}

export const SCENARIOS: { id: Scenario; name: string; description: string }[] = [
  { id: 'both', name: 'Both academies', description: 'Ace TT Academy and Nadam Vocal on one number — tenant isolation, side by side' },
  { id: 'ace', name: 'Ace TT Academy', description: 'Table tennis, three coaches, eight families, money in flight' },
  { id: 'solo', name: 'Nadam Vocal', description: 'The solo case: one person who is both the admin and the only coach' },
]

function rolesOf(r: Record<string, unknown>): Role[] {
  const roles: Role[] = []
  if (r.is_admin) roles.push('admin')
  if (r.coach_id) roles.push('coach')
  if (r.is_holder) roles.push('account_holder')
  if (r.is_player) roles.push('player')
  if (r.state === 'prospect') roles.push('prospect')
  return roles
}

const isoOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : new Date(v as string).toISOString()

/** academies, contacts, clock, faults — `GET /api/emulator/state`. */
export async function worldState(): Promise<WorldState> {
  const nowD = await now()
  const nextEvent = await nextEventAt()

  const academies: WorldAcademy[] = []
  for (const academyId of await worldAcademyIds({ refresh: true })) {
    const a = await withSession(svc(academyId), async (tx) => {
      const head = await tx`
        select a.id, a.name, a.category, a.timezone, a.onboarding_state, a.upi_handle, a.rail,
               a.cancellation_window_hours, a.client_reminder_lead_hours,
               a.morning_brief_at::text as morning_brief_at,
               a.evening_digest_at::text as evening_digest_at,
               a.created_on::text as created_on, a.memory,
               s.phone_e164 as sender_phone, s.label as sender_label,
               (select count(*) from class c where c.academy_id = a.id and c.active) as class_count,
               (select count(*) from player pl where pl.academy_id = a.id and pl.active) as player_count,
               (select count(*) from coach co where co.academy_id = a.id and co.status = 'active') as coach_count,
               (select count(*) from session se where se.academy_id = a.id) as session_count,
               (select count(*) from session se
                 where se.academy_id = a.id and se.status = 'scheduled'
                   and se.starts_at >= app.now()) as upcoming_count,
               (
                 (select count(*) from coach co
                   where co.academy_id = a.id and co.status = 'active') = 1
                 and exists (
                   select 1 from coach co
                   join academy_admin aa
                     on aa.academy_id = co.academy_id and aa.person_id = co.person_id
                   where co.academy_id = a.id and co.status = 'active')
               ) as is_solo
        from academy a
        join sender s on s.id = a.sender_id
        where a.id = ${academyId}::uuid`
      if (head.length === 0) return null

      const contacts = await tx`
        select c.id, c.academy_id, c.person_id, p.full_name, c.phone_e164, c.wa_id,
               c.profile_name, c.state, c.opted_out_at, c.last_inbound_at,
               c.is_primary, c.role_hint, p.notes,
               exists (select 1 from academy_admin aa
                        where aa.academy_id = c.academy_id and aa.person_id = c.person_id) as is_admin,
               (select co.id from coach co
                 where co.academy_id = c.academy_id and co.person_id = c.person_id limit 1) as coach_id,
               (select co.status from coach co
                 where co.academy_id = c.academy_id and co.person_id = c.person_id limit 1) as coach_status,
               exists (select 1 from account ac
                        where ac.academy_id = c.academy_id and ac.holder_person_id = c.person_id) as is_holder,
               exists (select 1 from player pl
                        where pl.academy_id = c.academy_id and pl.person_id = c.person_id) as is_player,
               (select count(*) from message m where m.contact_id = c.id) as message_count,
               (select max(m.queued_at) from message m where m.contact_id = c.id) as last_message_at
        from contact c
        join person p on p.id = c.person_id
        where c.academy_id = ${academyId}::uuid
        order by p.full_name`

      const upcoming = await tx`
        select se.id, se.starts_at, se.ends_at, se.status, c.name as class_name,
               v.name as venue_name,
               exists (select 1 from session_coach sc
                        where sc.session_id = se.id and sc.declined_at is null
                          and (sc.confirmed_at is not null or sc.arrived_at is not null)) as covered
        from session se
        join class c on c.id = se.class_id
        left join venue v on v.id = coalesce(se.venue_id, c.venue_id)
        where se.academy_id = ${academyId}::uuid and se.starts_at >= app.now()
        order by se.starts_at
        limit 6`

      return { head: head[0], contacts, upcoming }
    })
    if (!a) continue

    const h = a.head
    academies.push({
      id: String(h.id),
      name: String(h.name),
      category: (h.category as string) ?? null,
      timezone: String(h.timezone),
      onboardingState: String(h.onboarding_state),
      upiHandle: (h.upi_handle as string) ?? null,
      cancellationWindowHours: Number(h.cancellation_window_hours),
      clientReminderLeadHours: Number(h.client_reminder_lead_hours),
      morningBriefAt: String(h.morning_brief_at),
      eveningDigestAt: String(h.evening_digest_at),
      createdOn: String(h.created_on),
      memory: (h.memory as string) ?? null,
      rail: String(h.rail),
      senderPhone: String(h.sender_phone),
      senderLabel: (h.sender_label as string) ?? null,
      isSolo: Boolean(h.is_solo),
      counts: {
        classes: Number(h.class_count),
        players: Number(h.player_count),
        coaches: Number(h.coach_count),
        sessions: Number(h.session_count),
        upcoming: Number(h.upcoming_count),
      },
      contacts: a.contacts.map((c) => {
        const last = isoOrNull(c.last_inbound_at)
        return {
          id: String(c.id),
          academyId: String(c.academy_id),
          academyName: String(h.name),
          personId: String(c.person_id),
          name: String(c.full_name),
          phone: String(c.phone_e164),
          waId: (c.wa_id as string) ?? null,
          profileName: (c.profile_name as string) ?? null,
          state: String(c.state),
          roles: rolesOf(c),
          coachId: c.coach_id ? String(c.coach_id) : null,
          coachStatus: c.coach_status ? String(c.coach_status) : null,
          isPrimary: Boolean(c.is_primary),
          isSolo: Boolean(h.is_solo),
          note: (c.notes as string) ?? (c.role_hint as string) ?? null,
          optedOutAt: isoOrNull(c.opted_out_at),
          lastInboundAt: last,
          inWindow: last !== null && nowD.getTime() - new Date(last).getTime() < WINDOW_MS,
          messageCount: Number(c.message_count),
          lastMessageAt: isoOrNull(c.last_message_at),
        }
      }),
      upcoming: a.upcoming.map((s) => ({
        id: String(s.id),
        className: String(s.class_name),
        venueName: (s.venue_name as string) ?? null,
        startsAt: new Date(s.starts_at as string).toISOString(),
        endsAt: new Date(s.ends_at as string).toISOString(),
        status: String(s.status),
        covered: Boolean(s.covered),
      })),
    })
  }

  const infra = await withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    const clock = await tx`select offset_ms from sim_clock where singleton limit 1`
    const faults = await tx`select kind, active, rate from sim_fault order by kind`
    const jobs = await tx`select status, count(*) as n from job group by status`
    const next = await tx`select min(run_at) as next_run_at from job where status = 'pending'`
    const sender = await tx`select id, phone_e164, label from sender where id = ${SENDER_ID}::uuid`
    return { clock, faults, jobs, next, sender }
  })

  const counts = { pending: 0, running: 0, done: 0, failed: 0, skipped: 0 }
  for (const row of infra.jobs) {
    const k = String(row.status) as keyof typeof counts
    if (k in counts) counts[k] = Number(row.n)
  }

  const nowIso = nowD.toISOString()
  const nextIso = nextEvent ? nextEvent.toISOString() : null
  const hasAce = academies.some((a) => a.id === ACE_ACADEMY_ID)
  const hasSolo = academies.some((a) => a.id === NADAM_ACADEMY_ID)

  return {
    seeded: academies.length > 0,
    scenario: hasAce && hasSolo ? 'both' : hasAce ? 'ace' : hasSolo ? 'solo' : null,
    clock: {
      nowIso,
      now: nowIso,
      offsetMs: infra.clock.length > 0 ? Number(infra.clock[0].offset_ms) : 0,
      nextEventAt: nextIso,
      nextEventAtIso: nextIso,
    },
    sender:
      infra.sender.length > 0
        ? {
            id: String(infra.sender[0].id),
            phone: String(infra.sender[0].phone_e164),
            label: String(infra.sender[0].label ?? SENDER_LABEL),
          }
        : null,
    academies,
    contacts: academies.flatMap((a) => a.contacts),
    scenarios: SCENARIOS,
    faults: infra.faults.map((f) => ({
      kind: String(f.kind),
      active: Boolean(f.active),
      rate: Number(f.rate),
    })),
    jobs: { ...counts, nextRunAt: isoOrNull(infra.next[0]?.next_run_at) },
  }
}

export type ThreadMessage = {
  id: string
  direction: string
  catalogId: string | null
  templateName: string | null
  inWindow: boolean
  status: string
  body: string | null
  payload: unknown
  mediaUrl: string | null
  waMessageId: string | null
  replyToActionId: string | null
  suppressedReason: string | null
  failedReason: string | null
  costPaise: number | null
  conversationCategory: string | null
  queuedAt: string
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  senderPhone: string
}

export type Thread = {
  contact: WorldContact
  academy: { id: string; name: string; timezone: string }
  messages: ThreadMessage[]
}

/** One pane's messages — `GET /api/emulator/thread`. */
export async function threadFor(contactId: string): Promise<Thread | null> {
  const nowD = await now()
  for (const academyId of await worldAcademyIds()) {
    const found = await withSession(svc(academyId), async (tx) => {
      const head = await tx`
        select c.id, c.academy_id, c.person_id, p.full_name, c.phone_e164, c.wa_id,
               c.profile_name, c.state, c.opted_out_at, c.last_inbound_at,
               c.is_primary, c.role_hint, p.notes,
               a.name as academy_name, a.timezone,
               (
                 (select count(*) from coach co2
                   where co2.academy_id = a.id and co2.status = 'active') = 1
                 and exists (
                   select 1 from coach co3
                   join academy_admin aa2
                     on aa2.academy_id = co3.academy_id and aa2.person_id = co3.person_id
                   where co3.academy_id = a.id and co3.status = 'active')
               ) as is_solo,
               exists (select 1 from academy_admin aa
                        where aa.academy_id = c.academy_id and aa.person_id = c.person_id) as is_admin,
               (select co.id from coach co
                 where co.academy_id = c.academy_id and co.person_id = c.person_id limit 1) as coach_id,
               (select co.status from coach co
                 where co.academy_id = c.academy_id and co.person_id = c.person_id limit 1) as coach_status,
               exists (select 1 from account ac
                        where ac.academy_id = c.academy_id and ac.holder_person_id = c.person_id) as is_holder,
               exists (select 1 from player pl
                        where pl.academy_id = c.academy_id and pl.person_id = c.person_id) as is_player
        from contact c
        join person p on p.id = c.person_id
        join academy a on a.id = c.academy_id
        where c.id = ${contactId}::uuid`
      if (head.length === 0) return null
      const messages = await tx`
        select m.id, m.direction, m.catalog_id, m.template_name, m.in_window, m.status,
               m.body, m.payload, m.media_url, m.wa_message_id, m.reply_to_action_id,
               m.suppressed_reason, m.failed_reason, m.cost_paise, m.conversation_category,
               m.queued_at, m.sent_at, m.delivered_at, m.read_at,
               s.phone_e164 as sender_phone
        from message m
        join sender s on s.id = m.sender_id
        where m.contact_id = ${contactId}::uuid
        order by m.queued_at asc, m.created_at asc`
      return { head: head[0], messages }
    })
    if (!found) continue

    const c = found.head
    const last = isoOrNull(c.last_inbound_at)
    return {
      contact: {
        id: String(c.id),
        academyId: String(c.academy_id),
        academyName: String(c.academy_name),
        personId: String(c.person_id),
        name: String(c.full_name),
        phone: String(c.phone_e164),
        waId: (c.wa_id as string) ?? null,
        profileName: (c.profile_name as string) ?? null,
        state: String(c.state),
        roles: rolesOf(c),
        coachId: c.coach_id ? String(c.coach_id) : null,
        coachStatus: c.coach_status ? String(c.coach_status) : null,
        isPrimary: Boolean(c.is_primary),
        isSolo: Boolean(c.is_solo),
        note: (c.notes as string) ?? (c.role_hint as string) ?? null,
        optedOutAt: isoOrNull(c.opted_out_at),
        lastInboundAt: last,
        inWindow: last !== null && nowD.getTime() - new Date(last).getTime() < WINDOW_MS,
        messageCount: found.messages.length,
        lastMessageAt: isoOrNull(found.messages[found.messages.length - 1]?.queued_at),
      },
      academy: {
        id: String(c.academy_id),
        name: String(c.academy_name),
        timezone: String(c.timezone),
      },
      messages: found.messages.map((m) => ({
        id: String(m.id),
        direction: String(m.direction),
        catalogId: (m.catalog_id as string) ?? null,
        templateName: (m.template_name as string) ?? null,
        inWindow: Boolean(m.in_window),
        status: String(m.status),
        body: (m.body as string) ?? null,
        payload: m.payload ?? null,
        mediaUrl: (m.media_url as string) ?? null,
        waMessageId: (m.wa_message_id as string) ?? null,
        replyToActionId: m.reply_to_action_id ? String(m.reply_to_action_id) : null,
        suppressedReason: (m.suppressed_reason as string) ?? null,
        failedReason: (m.failed_reason as string) ?? null,
        costPaise: m.cost_paise === null || m.cost_paise === undefined ? null : Number(m.cost_paise),
        conversationCategory: (m.conversation_category as string) ?? null,
        queuedAt: new Date(m.queued_at as string).toISOString(),
        sentAt: isoOrNull(m.sent_at),
        deliveredAt: isoOrNull(m.delivered_at),
        readAt: isoOrNull(m.read_at),
        senderPhone: String(m.sender_phone),
      })),
    }
  }
  return null
}

// -----------------------------------------------------------------------------
// Event log + stream poll.
//
// `created_at` (schema default `now()`) is real wall time and therefore
// monotonic no matter where the sim clock is pointed. It is used ONLY as a
// cursor. Every domain-time value in the payload comes from `app.now()`.
// -----------------------------------------------------------------------------

export type WorldEvent =
  | {
      type: 'message'
      id: string
      messageId: string
      at: string
      academyId: string
      academyName: string
      contactId: string
      contactName: string
      direction: string
      catalogId: string | null
      templateName: string | null
      inWindow: boolean
      status: string
      costPaise: number | null
      conversationCategory: string | null
      suppressedReason: string | null
      failedReason: string | null
      senderPhone: string
      body: string
      summary: string
    }
  | {
      type: 'turn'
      id: string
      at: string
      academyId: string
      academyName: string
      contactId: string | null
      contactName: string | null
      roleActed: string | null
      model: string | null
      promptTokens: number | null
      outputTokens: number | null
      latencyMs: number | null
      error: string | null
    }
  | {
      type: 'job'
      id: string
      at: string
      kind: string
      jobKind: string
      status: string
      outcome: 'ran' | 'skipped' | 'failed' | null
      runAt: string
      dedupeKey: string
      attempts: number
      lastError: string | null
      summary: string
    }
  | { type: 'clock'; id: string; at: string; nowIso: string; offsetMs: number }

const EPOCH = '1970-01-01T00:00:00.000Z'

async function messageEvents(academyId: string, since: string, limit: number): Promise<WorldEvent[]> {
  return withSession(svc(academyId), async (tx) => {
    const rows = await tx`
      select m.id, m.created_at, m.academy_id, a.name as academy_name, m.contact_id,
             p.full_name as contact_name, m.direction, m.catalog_id, m.template_name,
             m.in_window, m.status, m.cost_paise, m.conversation_category,
             m.suppressed_reason, m.failed_reason, s.phone_e164 as sender_phone,
             left(coalesce(m.body, ''), 200) as body
      from message m
      join academy a on a.id = m.academy_id
      join contact c on c.id = m.contact_id
      join person p on p.id = c.person_id
      join sender s on s.id = m.sender_id
      where m.academy_id = ${academyId}::uuid and m.created_at > ${since}::timestamptz
      order by m.created_at asc
      limit ${limit}`
    return rows.map((m): WorldEvent => ({
      type: 'message',
      id: String(m.id),
      messageId: String(m.id),
      at: new Date(m.created_at as string).toISOString(),
      academyId: String(m.academy_id),
      academyName: String(m.academy_name),
      contactId: String(m.contact_id),
      contactName: String(m.contact_name),
      direction: String(m.direction),
      catalogId: (m.catalog_id as string) ?? null,
      templateName: (m.template_name as string) ?? null,
      inWindow: Boolean(m.in_window),
      status: String(m.status),
      costPaise: m.cost_paise === null || m.cost_paise === undefined ? null : Number(m.cost_paise),
      conversationCategory: (m.conversation_category as string) ?? null,
      suppressedReason: (m.suppressed_reason as string) ?? null,
      failedReason: (m.failed_reason as string) ?? null,
      senderPhone: String(m.sender_phone),
      body: String(m.body ?? ''),
      summary: String(m.body ?? '') || `${String(m.direction)} ${String(m.catalog_id ?? 'composed')}`,
    }))
  })
}

async function turnEvents(academyId: string, since: string, limit: number): Promise<WorldEvent[]> {
  return withSession(svc(academyId), async (tx) => {
    const rows = await tx`
      select t.id, t.created_at, t.academy_id, a.name as academy_name, t.contact_id,
             p.full_name as contact_name, t.role_acted, t.model, t.prompt_tokens,
             t.output_tokens, t.latency_ms, t.error
      from turn t
      join academy a on a.id = t.academy_id
      left join person p on p.id = t.person_id
      where t.academy_id = ${academyId}::uuid and t.created_at > ${since}::timestamptz
      order by t.created_at asc
      limit ${limit}`
    return rows.map((t): WorldEvent => ({
      type: 'turn',
      id: String(t.id),
      at: new Date(t.created_at as string).toISOString(),
      academyId: String(t.academy_id),
      academyName: String(t.academy_name),
      contactId: t.contact_id ? String(t.contact_id) : null,
      contactName: t.contact_name ? String(t.contact_name) : null,
      roleActed: (t.role_acted as string) ?? null,
      model: (t.model as string) ?? null,
      promptTokens: t.prompt_tokens === null || t.prompt_tokens === undefined ? null : Number(t.prompt_tokens),
      outputTokens: t.output_tokens === null || t.output_tokens === undefined ? null : Number(t.output_tokens),
      latencyMs: t.latency_ms === null || t.latency_ms === undefined ? null : Number(t.latency_ms),
      error: (t.error as string) ?? null,
    }))
  })
}

async function jobEvents(since: string, limit: number): Promise<WorldEvent[]> {
  return withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    const rows = await tx`
      select id, created_at, kind, status, run_at, dedupe_key, attempts, last_error
      from job
      where created_at > ${since}::timestamptz
      order by created_at asc
      limit ${limit}`
    return rows.map((j): WorldEvent => {
      const status = String(j.status)
      const outcome =
        status === 'done' ? ('ran' as const)
          : status === 'skipped' ? ('skipped' as const)
          : status === 'failed' ? ('failed' as const)
          : null
      return {
        type: 'job',
        id: String(j.id),
        at: new Date(j.created_at as string).toISOString(),
        kind: String(j.kind),
        jobKind: String(j.kind),
        status,
        outcome,
        runAt: new Date(j.run_at as string).toISOString(),
        dedupeKey: String(j.dedupe_key),
        attempts: Number(j.attempts),
        lastError: (j.last_error as string) ?? null,
        summary: `${String(j.kind)} ${String(j.dedupe_key)}`,
      }
    })
  })
}

/** `GET /api/emulator/events?since=` — the event log, oldest first. */
export async function eventLog(o: { since?: string | null; limit?: number } = {}): Promise<{
  events: WorldEvent[]
  cursor: string
}> {
  const limit = Math.min(Math.max(o.limit ?? 200, 1), 1000)
  const since = o.since ?? EPOCH
  const out: WorldEvent[] = []
  for (const academyId of await worldAcademyIds()) {
    out.push(...(await messageEvents(academyId, since, limit)))
    out.push(...(await turnEvents(academyId, since, limit)))
  }
  out.push(...(await jobEvents(since, limit)))
  out.sort((a, b) => a.at.localeCompare(b.at))
  // Oldest first, so the cursor never advances past an event the caller has not
  // seen — a clipped page is caught up on the next poll rather than lost.
  const clipped = out.slice(0, limit)
  return { events: clipped, cursor: clipped.length > 0 ? clipped[clipped.length - 1].at : since }
}

export type MessageStatusRow = {
  id: string
  status: string
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  failedReason: string | null
  suppressedReason: string | null
}

export type PollResult = {
  events: WorldEvent[]
  statuses: MessageStatusRow[]
  clock: { nowIso: string; now: string; offsetMs: number }
  cursor: string
}

/**
 * One poll of the stream. New rows past `cursor`, plus the current status of the
 * most recent messages so that queued -> sent -> delivered -> read (§2.4) shows
 * up live without a second cursor. The caller de-dupes statuses it has already
 * pushed.
 */
export async function pollWorld(o: { cursor?: string | null; statusLimit?: number } = {}): Promise<PollResult> {
  const since = o.cursor ?? EPOCH
  const statusLimit = o.statusLimit ?? 60
  const events: WorldEvent[] = []
  const statuses: MessageStatusRow[] = []

  for (const academyId of await worldAcademyIds()) {
    events.push(...(await messageEvents(academyId, since, 200)))
    events.push(...(await turnEvents(academyId, since, 200)))
    const rows = await withSession(svc(academyId), async (tx) => {
      return await tx`
        select id, status, sent_at, delivered_at, read_at, failed_reason, suppressed_reason
        from message
        where academy_id = ${academyId}::uuid
        order by created_at desc
        limit ${statusLimit}`
    })
    for (const m of rows) {
      statuses.push({
        id: String(m.id),
        status: String(m.status),
        sentAt: isoOrNull(m.sent_at),
        deliveredAt: isoOrNull(m.delivered_at),
        readAt: isoOrNull(m.read_at),
        failedReason: (m.failed_reason as string) ?? null,
        suppressedReason: (m.suppressed_reason as string) ?? null,
      })
    }
  }
  events.push(...(await jobEvents(since, 200)))
  events.sort((a, b) => a.at.localeCompare(b.at))

  const nowD = await now()
  const offset = await withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    return await tx`select offset_ms from sim_clock where singleton limit 1`
  })

  return {
    events,
    statuses,
    clock: {
      nowIso: nowD.toISOString(),
      now: nowD.toISOString(),
      offsetMs: offset.length > 0 ? Number(offset[0].offset_ms) : 0,
    },
    cursor: events.length > 0 ? events[events.length - 1].at : since,
  }
}

/** The newest `created_at` anywhere — a stream's starting cursor when none is given. */
export async function latestCursor(): Promise<string> {
  let best = EPOCH
  const take = (v: unknown) => {
    if (v === null || v === undefined) return
    const iso = new Date(v as string).toISOString()
    if (iso > best) best = iso
  }
  for (const academyId of await worldAcademyIds()) {
    const r = await withSession(svc(academyId), async (tx) => {
      const m = await tx`select max(created_at) as t from message where academy_id = ${academyId}::uuid`
      const t = await tx`select max(created_at) as t from turn where academy_id = ${academyId}::uuid`
      return [m[0]?.t, t[0]?.t]
    })
    r.forEach(take)
  }
  const j = await withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    return await tx`select max(created_at) as t from job`
  })
  take(j[0]?.t)
  return best
}

// -----------------------------------------------------------------------------
// Failure injection (§17).
// -----------------------------------------------------------------------------

export type FaultKind = 'send_fail' | 'number_blocked' | 'media_timeout' | 'link_expired' | 'model_error'

export async function setFault(f: { kind: FaultKind; active: boolean; rate?: number }): Promise<
  { kind: string; active: boolean; rate: number }[]
> {
  const rate = f.rate ?? 1.0
  return withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    await tx`
      insert into sim_fault (kind, active, rate)
      values (${f.kind}, ${f.active}, ${rate}::numeric)
      on conflict (kind) do update set active = excluded.active, rate = excluded.rate`
    const rows = await tx`select kind, active, rate from sim_fault order by kind`
    return rows.map((r) => ({ kind: String(r.kind), active: Boolean(r.active), rate: Number(r.rate) }))
  })
}

/** The sim clock's current offset. Cheap enough to attach to every clock reply. */
export async function clockOffsetMs(): Promise<number> {
  const rows = await withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    return await tx`select offset_ms from sim_clock where singleton limit 1`
  })
  return rows.length > 0 ? Number(rows[0].offset_ms) : 0
}

export async function listFaults(): Promise<{ kind: string; active: boolean; rate: number }[]> {
  return withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    const rows = await tx`select kind, active, rate from sim_fault order by kind`
    return rows.map((r) => ({ kind: String(r.kind), active: Boolean(r.active), rate: Number(r.rate) }))
  })
}

// =============================================================================
// INGRESS — the one path an inbound takes.
//
// `/api/emulator/inbound` and `/api/webhook` both land here, which is the whole
// point: the emulator is not a shortcut around the transport, it is the same
// road with a different surface (§17).
// =============================================================================

export type InboundResult =
  | {
      ok: true
      duplicate: boolean
      academyId: string
      contactId: string
      personName: string
      isNew: boolean
      messageId: string
      turn: TurnOutput | null
    }
  | { ok: false; unresolved: true; candidates: { academyId: string; name: string }[] }

function guessMime(url: string, given?: string): string {
  if (given) return given
  const u = url.toLowerCase()
  if (u.endsWith('.png')) return 'image/png'
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg'
  if (u.endsWith('.webp')) return 'image/webp'
  if (u.endsWith('.ogg') || u.endsWith('.oga')) return 'audio/ogg'
  if (u.endsWith('.mp3')) return 'audio/mpeg'
  if (u.endsWith('.m4a')) return 'audio/mp4'
  if (u.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

/**
 * Resolve identity (§10.1 routing) → insert the inbound `message` row, which is
 * what fires the trigger that stamps `contact.last_inbound_at` and promotes the
 * contact's state (§11.2) → run the turn.
 *
 * A tap carries `actionId`; `runTurn` consumes it with no model call (§2.2).
 */
export async function ingestInbound(input: {
  fromPhoneE164: string
  senderPhoneE164: string
  profileName?: string
  text?: string
  actionId?: string
  mediaUrl?: string
  mediaMimeType?: string
  waMessageId?: string
  source?: 'emulator' | 'cloud'
}): Promise<InboundResult> {
  const resolved = await resolveInbound(
    input.fromPhoneE164,
    input.senderPhoneE164,
    input.profileName,
    input.text,
  )
  if ('unresolved' in resolved) {
    return { ok: false, unresolved: true, candidates: resolved.candidates }
  }

  const { identity, isNew } = resolved
  const academyId = identity.academyId
  const contactId = identity.contact.id
  const at = (await now()).toISOString()
  const idempotencyKey = input.waMessageId ? `inbound:${input.waMessageId}` : null

  const written = await withSession(svc(academyId), async (tx) => {
    const senderRows = await tx`
      select s.id from sender s
      join academy a on a.sender_id = s.id
      where a.id = ${academyId}::uuid`
    const senderId = senderRows[0]?.id
      ?? (await tx`select id from sender where phone_e164 = ${input.senderPhoneE164} limit 1`)[0]?.id

    // A button tap references the action it replays — but only if that row
    // really exists, so a stale id cannot turn into an FK error.
    let replyTo: string | null = null
    if (input.actionId) {
      const a = await tx`select id from action where id = ${input.actionId}::uuid`
      replyTo = a.length > 0 ? String(a[0].id) : null
    }

    const id = newId()
    const rows = await tx.unsafe(
      `insert into message (id, academy_id, contact_id, sender_id, direction, body, payload,
                            media_url, wa_message_id, status, queued_at, sent_at, delivered_at,
                            in_window, reply_to_action_id, idempotency_key)
       values ($1::uuid,$2::uuid,$3::uuid,$4::uuid,'inbound',$5,$6::jsonb,$7,$8,'delivered',
               $9::timestamptz,$9::timestamptz,$9::timestamptz,true,$10::uuid,$11)
       on conflict (idempotency_key) do nothing
       returning id`,
      [
        id, academyId, contactId, senderId, input.text ?? null,
        JSON.stringify({
          source: input.source ?? 'emulator',
          actionId: input.actionId ?? null,
          profileName: input.profileName ?? null,
          mediaMimeType: input.mediaUrl ? guessMime(input.mediaUrl, input.mediaMimeType) : null,
        }),
        input.mediaUrl ?? null, input.waMessageId ?? null, at, replyTo, idempotencyKey,
      ] as never[],
    )
    if (rows.length > 0) return { messageId: String(rows[0].id), duplicate: false }
    // Meta retries the same webhook; the unique idempotency key absorbs it.
    const existing = await tx`select id from message where idempotency_key = ${idempotencyKey}`
    return { messageId: String(existing[0]?.id ?? id), duplicate: true }
  })

  if (written.duplicate) {
    return {
      ok: true, duplicate: true, academyId, contactId,
      personName: identity.person.full_name, isNew, messageId: written.messageId, turn: null,
    }
  }

  const turn = await runTurn({
    contactId,
    text: input.text,
    actionId: input.actionId,
    media: input.mediaUrl
      ? [{ url: input.mediaUrl, mimeType: guessMime(input.mediaUrl, input.mediaMimeType) }]
      : undefined,
    source: 'inbound',
  })

  return {
    ok: true, duplicate: false, academyId, contactId,
    personName: identity.person.full_name, isNew, messageId: written.messageId, turn,
  }
}

/** The emulator addresses a contact, not a number. Look up both ends, then take the same road. */
export async function inboundFromContact(input: {
  contactId: string
  text?: string
  actionId?: string
  mediaUrl?: string
  mediaMimeType?: string
}): Promise<InboundResult | { ok: false; notFound: true }> {
  for (const academyId of await worldAcademyIds()) {
    const found = await withSession(svc(academyId), async (tx) => {
      const rows = await tx`
        select c.phone_e164, c.profile_name, p.full_name, s.phone_e164 as sender_phone
        from contact c
        join person p on p.id = c.person_id
        join academy a on a.id = c.academy_id
        join sender s on s.id = a.sender_id
        where c.id = ${input.contactId}::uuid`
      return rows[0] ?? null
    })
    if (!found) continue
    return ingestInbound({
      fromPhoneE164: String(found.phone_e164),
      senderPhoneE164: String(found.sender_phone),
      profileName: (found.profile_name as string) ?? String(found.full_name),
      text: input.text,
      actionId: input.actionId,
      mediaUrl: input.mediaUrl,
      mediaMimeType: input.mediaMimeType,
      source: 'emulator',
    })
  }
  return { ok: false, notFound: true }
}

/**
 * `POST /api/emulator/read` — mark delivered/read. Goes through `markStatus`,
 * the same call a real transport callback makes, so §2.4's ladder is the real
 * one and not a UI fiction.
 */
export async function markMessageRead(
  messageId: string,
  status: 'delivered' | 'read',
): Promise<
  | { ok: true; messageId: string; status: string; deliveredAt: string | null; readAt: string | null }
  | { ok: false; reason: 'not_found' | 'no_wa_message_id' }
> {
  for (const academyId of await worldAcademyIds()) {
    const row = await withSession(svc(academyId), async (tx) => {
      const rows = await tx`
        select id, wa_message_id, delivered_at, status
        from message where id = ${messageId}::uuid`
      return rows[0] ?? null
    })
    if (!row) continue
    if (!row.wa_message_id) return { ok: false, reason: 'no_wa_message_id' }
    const wa = String(row.wa_message_id)
    // The tenant is passed explicitly: a cold process has no warm wa-id index.
    if (status === 'read' && !row.delivered_at) await markStatus(wa, 'delivered', undefined, academyId)
    await markStatus(wa, status, undefined, academyId)

    const after = await withSession(svc(academyId), async (tx) => {
      const rows = await tx`
        select status, delivered_at, read_at from message where id = ${messageId}::uuid`
      return rows[0]
    })
    return {
      ok: true,
      messageId,
      status: String(after.status),
      deliveredAt: isoOrNull(after.delivered_at),
      readAt: isoOrNull(after.read_at),
    }
  }
  return { ok: false, reason: 'not_found' }
}

// =============================================================================
// The real Meta webhook's queue (§1: "Returns 200 immediately. Meta retries on
// timeout, so all processing goes on a queue, never inline").
//
// The row is an ordinary durable `job` — same table, same dedupe_key
// idempotency, survives a restart. Its kind is deliberately NOT one of
// CONTRACTS §7's twenty: those are the moments *code* schedules, and
// `HANDLERS` is closed over exactly them. Transport ingress is a different
// thing, so the row is written straight to the table with `status='running'`
// and drained by `drainWebhookEvents` below. `runDueJobs` claims
// `status='pending'` only, so the two queues cannot fight over a row, and
// `reportMissed` (pending/failed) stays quiet about these.
//
// Double-drain is harmless: `ingestInbound` is idempotent on
// `idempotency_key = inbound:<wa_message_id>` and `markStatus` is idempotent.
// =============================================================================

const WEBHOOK_JOB_KIND = 'webhook_event'

type MetaChangeValue = {
  metadata?: { display_phone_number?: string; phone_number_id?: string }
  contacts?: { wa_id?: string; profile?: { name?: string } }[]
  messages?: Record<string, unknown>[]
  statuses?: Record<string, unknown>[]
}

const toE164 = (raw: string): string => '+' + raw.replace(/\D/g, '')

/** Durably queue one verified webhook body. Idempotent per Meta event id. */
export async function queueWebhookEvent(payload: unknown): Promise<{ queued: number }> {
  const at = await now()
  const body = payload as { entry?: { id?: string; changes?: { value?: MetaChangeValue }[] }[] }
  const keys: string[] = []
  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {}
      for (const m of v.messages ?? []) keys.push(`wh:msg:${String(m.id ?? newId())}`)
      for (const s of v.statuses ?? []) {
        keys.push(`wh:st:${String(s.id ?? newId())}:${String(s.status ?? 'unknown')}`)
      }
    }
  }
  if (keys.length === 0) keys.push(`wh:raw:${newId()}`)

  const queued = await withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    let n = 0
    for (const key of keys) {
      const rows = await tx.unsafe(
        `insert into job (kind, run_at, dedupe_key, status, payload, locked_at, locked_by)
         values ($1, $2::timestamptz, $3, 'running', $4::jsonb, $2::timestamptz, 'webhook-ingress')
         on conflict (dedupe_key) do nothing
         returning id`,
        [WEBHOOK_JOB_KIND, at.toISOString(), key, JSON.stringify({ payload, part: key })] as never[],
      )
      if (rows.length > 0) n++
    }
    return n
  })
  return { queued }
}

async function processChangeValue(v: MetaChangeValue, part: string): Promise<string[]> {
  const log: string[] = []
  const senderPhone = v.metadata?.display_phone_number
    ? toE164(v.metadata.display_phone_number)
    : SENDER_PHONE
  const profileName = v.contacts?.[0]?.profile?.name

  // One job per Meta event, so a job only does its own slice of the body.
  const onlyMessage = part.startsWith('wh:msg:') ? part.slice('wh:msg:'.length) : null
  const onlyStatus = part.startsWith('wh:st:') ? part.slice('wh:st:'.length) : null

  for (const raw of onlyStatus ? [] : v.messages ?? []) {
    const m = raw as {
      id?: string
      from?: string
      type?: string
      text?: { body?: string }
      interactive?: { button_reply?: { id?: string }; list_reply?: { id?: string } }
      button?: { payload?: string; text?: string }
      image?: { id?: string; mime_type?: string; caption?: string }
      audio?: { id?: string; mime_type?: string }
      document?: { id?: string; mime_type?: string; filename?: string }
    }
    if (!m.from) continue
    if (onlyMessage && String(m.id) !== onlyMessage) continue

    const actionId =
      m.interactive?.button_reply?.id ?? m.interactive?.list_reply?.id ?? m.button?.payload
    const media = m.image ?? m.audio ?? m.document
    // Binary media lives behind the Graph API, and no Meta call may exist outside
    // transport-cloud.ts — so the media id is carried, not fetched, here.
    const mediaUrl = media?.id ? `wa-media:${media.id}` : undefined

    const r = await ingestInbound({
      fromPhoneE164: toE164(m.from),
      senderPhoneE164: senderPhone,
      profileName,
      text: m.text?.body ?? m.image?.caption ?? m.button?.text,
      actionId: actionId ?? undefined,
      mediaUrl,
      mediaMimeType: media?.mime_type,
      waMessageId: m.id,
      source: 'cloud',
    })
    log.push(
      r.ok
        ? `inbound ${m.id ?? '?'} -> ${r.contactId}${r.duplicate ? ' (duplicate)' : ''}`
        : `inbound ${m.id ?? '?'} unresolved (${r.candidates.length} candidates)`,
    )
  }

  for (const raw of onlyMessage ? [] : v.statuses ?? []) {
    const s = raw as { id?: string; status?: string; errors?: { title?: string; message?: string }[] }
    if (!s.id || !s.status) continue
    if (onlyStatus && `${s.id}:${s.status}` !== onlyStatus) continue
    const status = s.status as 'sent' | 'delivered' | 'read' | 'failed'
    if (!['sent', 'delivered', 'read', 'failed'].includes(status)) continue
    await markStatus(s.id, status, s.errors?.[0]?.title ?? s.errors?.[0]?.message)
    log.push(`status ${s.id} -> ${status}`)
  }

  return log
}

/** Claim and process queued webhook events. Safe to call repeatedly. */
export async function drainWebhookEvents(limit = 25): Promise<{
  processed: number
  failed: number
  log: string[]
}> {
  const claimed = await withSession(svc(ACE_ACADEMY_ID), async (tx) => {
    return await tx`
      update job
         set locked_at = app.now(), locked_by = 'webhook-drain', attempts = attempts + 1
       where id in (
         select id from job
         where kind = ${WEBHOOK_JOB_KIND} and status = 'running'
         order by run_at asc
         limit ${limit}
         for update skip locked)
       returning id, payload, attempts`
  })

  const log: string[] = []
  let processed = 0
  let failed = 0

  for (const job of claimed) {
    const jobId = String(job.id)
    try {
      const payload = job.payload as { payload?: unknown; part?: string }
      const body = (payload?.payload ?? {}) as {
        entry?: { changes?: { value?: MetaChangeValue }[] }[]
      }
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          if (change.value) log.push(...(await processChangeValue(change.value, String(payload?.part ?? ''))))
        }
      }
      await withSession(svc(ACE_ACADEMY_ID), async (tx) => {
        await tx`update job set status = 'done', last_error = null where id = ${jobId}::uuid`
      })
      processed++
    } catch (e) {
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      const attempts = Number(job.attempts ?? 0) + 1
      log.push(`job ${jobId} failed (attempt ${attempts}): ${msg}`)
      // Stays 'running' so the next drain retries it — never 'pending', which
      // would hand a kind with no handler to `runDueJobs`. Three goes, then it
      // stands as failed evidence.
      await withSession(svc(ACE_ACADEMY_ID), async (tx) => {
        await tx`update job
                    set status = ${attempts >= 3 ? 'failed' : 'running'},
                        last_error = ${msg}, locked_by = null
                  where id = ${jobId}::uuid`
      })
    }
  }

  return { processed, failed, log }
}

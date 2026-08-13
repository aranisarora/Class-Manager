/**
 * lib/setup-plan.ts — the shape of the business, written once.
 *
 * There are two ways to tell this product what the business is: the `setup` web
 * screen behind a signed link, and the onboarding WhatsApp Flow. There must not be
 * two ways to WRITE it. That rule is not abstract here — the register screen wrote
 * `attendance` with its own SQL for most of the product's life, twenty lines above a
 * handler that ran the named operation properly, and the consequence was that
 * marking a register produced no money, no free-first-class credit, no package
 * consumption, and never completed the session. It said "Saved" either way.
 *
 * So: one builder, one plan, and both surfaces run it through `executePlan` — which
 * is what buys the audit entry, the before-images that make `undo` work, atomicity
 * across the academy row and its venues, and `requireRows` turning an RLS refusal
 * into something the person is told about instead of a silent no-op.
 *
 * Everything is optional except the name, because the two surfaces ask for
 * different subsets: the screen has room for the brief and digest times and a whole
 * venue list, and one Flow screen does not. A column nobody supplied is left alone
 * rather than defaulted, which is the difference between "they did not say" and
 * "they said the default".
 */

import { jsonLit, lit, uid } from '@/lib/agent/operations'
import type { PlanStep } from '@/lib/agent/plan'

export type SetupVenue = { id?: string | null; name: string; address?: string | null }

export type SetupValues = {
  name: string
  category?: string | null
  timezone?: string | null
  cancellationWindowHours?: number | null
  morningBriefAt?: string | null
  eveningDigestAt?: string | null
  upiHandle?: string | null
  operatingPattern?: { days: number[]; opens_at: string; closes_at: string } | null
  venues?: SetupVenue[]
}

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim()
  return t === '' ? null : t
}

export function buildSetupSteps(academyId: string, v: SetupValues): PlanStep[] {
  const sets: string[] = [`name = ${lit(v.name.trim())}`]

  if (v.category !== undefined) sets.push(`category = ${lit(clean(v.category))}`)
  if (v.timezone) sets.push(`timezone = ${lit(v.timezone)}`)
  if (v.cancellationWindowHours !== undefined && v.cancellationWindowHours !== null) {
    sets.push(`cancellation_window_hours = ${lit(v.cancellationWindowHours)}`)
  }
  if (v.morningBriefAt) sets.push(`morning_brief_at = time ${lit(v.morningBriefAt)}`)
  if (v.eveningDigestAt) sets.push(`evening_digest_at = time ${lit(v.eveningDigestAt)}`)
  if (v.upiHandle !== undefined) sets.push(`upi_handle = ${lit(clean(v.upiHandle))}`)
  if (v.operatingPattern) {
    sets.push(
      `settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('operating_pattern', ${jsonLit(v.operatingPattern)})`,
    )
  }

  /**
   * Setup is what moves a business off the starting square, and this is the only
   * place that transition is automatic. It is written as a CASE rather than a plain
   * assignment so re-submitting the screen later cannot drag a live academy
   * backwards into `roster` — which would silence every proactive message it sends.
   */
  sets.push(`onboarding_state = case when onboarding_state = 'setup' then 'roster' else onboarding_state end`)

  const steps: PlanStep[] = [
    {
      // A non-admin's UPDATE matches zero rows silently — Postgres does not raise on
      // a WHERE that finds nothing — so without this the plan would commit having
      // changed nothing and the person would be told it saved.
      write: `update academy set ${sets.join(', ')} where id = ${uid(academyId)}`,
      requireRows: 1,
    },
  ]

  for (const venue of v.venues ?? []) {
    const name = venue.name.trim()
    if (!name) continue
    steps.push(
      venue.id
        ? {
            // A venue id belonging to another academy used to be skipped in silence
            // and then deleted as "removed". `requireRows` makes it abort instead.
            write: `update venue set name = ${lit(name)}, address = ${lit(clean(venue.address))}
                     where id = ${uid(venue.id)} and academy_id = ${uid(academyId)}`,
            requireRows: 1,
          }
        : {
            // Idempotent on the name key 0014 added: a Flow re-submitted after a
            // dropped connection must not open a second copy of the same hall.
            write: `insert into venue (academy_id, name, address)
                    values (${uid(academyId)}, ${lit(name)}, ${lit(clean(venue.address))})
                    on conflict (academy_id, name) do update set address = excluded.address`,
          },
    )
  }

  return steps
}

/** What to say afterwards. Kept beside the builder so the two surfaces agree. */
export function summariseSetup(v: SetupValues): string {
  const bits = [`Saved — ${v.name.trim()} is set up.`]
  const venues = (v.venues ?? []).filter((x) => x.name.trim())
  const parts: string[] = []
  if (venues.length) parts.push(venues.length === 1 ? venues[0].name.trim() : `${venues.length} places`)
  if (v.cancellationWindowHours) parts.push(`${v.cancellationWindowHours}h cancellation notice`)
  parts.push(clean(v.upiHandle) ? `payments to ${clean(v.upiHandle)}` : 'no UPI handle yet')
  bits.push(`${parts.join(', ')}.`)
  return bits.join(' ')
}

/**
 * lib/setup-plan.ts — the shape of the business, written once.
 *
 * There are several ways to tell this product what the business is: a sentence
 * typed in the chat, an answer to something it asked, and whatever comes next.
 * There must not be several ways to WRITE it. That rule is not abstract here — the
 * register screen wrote `attendance` with its own SQL for most of the product's
 * life, twenty lines above a handler that ran the named operation properly, and the
 * consequence was that marking a register produced no money, no free-first-class
 * credit, no package consumption, and never completed the session. It said "Saved"
 * either way.
 *
 * So: one builder, one plan, and every surface runs it through `executePlan` — which
 * is what buys the audit entry, the before-images that make `undo` work, atomicity
 * across the academy row and its venues, and `requireRows` turning an RLS refusal
 * into something the person is told about instead of a silent no-op.
 *
 * Everything is optional except the name, because callers supply different subsets.
 * **A field left `undefined` is left alone; a field set to `null` is cleared.** That
 * distinction is the difference between "they did not say" and "they said none", and
 * getting it wrong is not cosmetic: somebody who says *don't send me a morning brief*
 * has said something, and a builder that treats that answer as "unset" leaves the old
 * 7am time in place and sends the message they just declined — for ever, with no way
 * to tell from the outside that the answer was ignored.
 *
 * The subsets got smaller when the setup Flow went (§14.6). A form arrived with all
 * nine fields at once, so "left alone" was rare; a ladder arrives with two, then
 * three more when they come up, so it is now the common case rather than the edge —
 * which is why `set_up_business` is safe to call repeatedly as the conversation goes.
 */

import { jsonLit, lit, uid } from '@/lib/agent/sql'
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
  // `null` clears the time, which is how "Don't send one" turns the brief off.
  // `undefined` means the caller had nothing to say and the column is untouched.
  // A truthiness check cannot tell those apart, and the answer it loses is the one
  // somebody chose deliberately.
  if (v.morningBriefAt !== undefined) {
    sets.push(`morning_brief_at = ${v.morningBriefAt === null ? 'null' : `time ${lit(v.morningBriefAt)}`}`)
  }
  if (v.eveningDigestAt !== undefined) {
    sets.push(`evening_digest_at = ${v.eveningDigestAt === null ? 'null' : `time ${lit(v.eveningDigestAt)}`}`)
  }
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
            // Idempotent on the name key 0014 added: somebody naming the same hall
            // twice as the conversation goes must not open a second copy of it.
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

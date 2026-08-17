/**
 * lib/agent/untold.ts — who this plan just changed something for, and nothing
 * tells them.
 *
 * **The census a row count cannot see, and the reason notification is a property
 * of the substrate rather than choreography.** The old shape carried ~41
 * hand-written message steps inside operations, one per situation somebody had
 * thought of, and a model asked to compose the writes raw would remember the
 * fan-out most of the time. Most of the time is not a property. A note in the
 * receipt is.
 *
 * So this asks the same question `./clash` asks, one relation over: not *is a
 * coach in two places* but *whose life just changed without their being told*.
 * Same three properties, for the same reasons —
 *
 *   It runs INSIDE the transaction, after the steps, before commit, against the
 *   world the plan produced. Five different things move a session and a check
 *   written into one of them is a check written into one of them.
 *
 *   It is SCOPED to the rows this plan touched, so somebody else's old silence
 *   never surfaces inside the receipt for this change.
 *
 *   It NOTES; it does not refuse. Silence is often right — a coach's decline
 *   while others remain assigned changes nothing for the parents, and a rate
 *   corrected the same minute it was typed wrong is not news. Only the person
 *   composing knows which. The note rides into the preview, the receipt and the
 *   tool result, and the model composes the fan-out or says why silence is right.
 *
 * **Only rows that already existed.** Creating rows nobody has been told about
 * yet is not a blast radius — "building a roster messages nobody" is a stated
 * fact of this business, and firing on every insert would put a fan-out note on
 * every minute of onboarding. An UPDATE or a DELETE to a row somebody depends on
 * is the case: a session moved, a class cancelled, a rate changed.
 *
 * Runs under the caller's own role, like the diff and the clash check beside it,
 * so what it can see is what its author could have seen by hand.
 */

import type { Tx } from '@/lib/db'
import { uid } from './operations'

/** How many people are named before the rest become a count. */
const NAMED = 4

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** As much of a diff as this reads — importing `TableDiff` closes a cycle. */
type Diffish = { table: string; op: string; before?: unknown[]; after?: unknown[] }

/**
 * Which column on each table names the thing whose dependents we want.
 *
 * A table is in here only when a CHANGE to one of its rows is something another
 * person experiences. `venue` is not: renaming a hall changes nobody's day until
 * a session moves, and the session diff is what says so.
 */
const BY_SESSION: Record<string, string> = { session: 'id', session_coach: 'session_id', attendance: 'session_id' }
const BY_CLASS: Record<string, string> = { class: 'id', class_slot: 'class_id', class_coach: 'class_id' }
const BY_ENROLLMENT: Record<string, string> = { enrollment: 'id' }
const BY_ACCOUNT: Record<string, string> = { tally_line: 'account_id', payment: 'account_id' }

type Scope = { sessions: string[]; classes: string[]; enrollments: string[]; accounts: string[] }

function scopeOf(diffs: readonly Diffish[]): Scope {
  const sessions = new Set<string>()
  const classes = new Set<string>()
  const enrollments = new Set<string>()
  const accounts = new Set<string>()

  for (const d of diffs) {
    // Inserts are excluded by the rule above. A delete is only visible in
    // `before`, an update in both — take the union so a row that moved out of
    // one class and into another is counted on both sides.
    if (d.op === 'insert') continue
    const target =
      d.table in BY_SESSION
        ? ([BY_SESSION[d.table], sessions] as const)
        : d.table in BY_CLASS
          ? ([BY_CLASS[d.table], classes] as const)
          : d.table in BY_ENROLLMENT
            ? ([BY_ENROLLMENT[d.table], enrollments] as const)
            : d.table in BY_ACCOUNT
              ? ([BY_ACCOUNT[d.table], accounts] as const)
              : null
    if (!target) continue
    const [key, into] = target
    for (const raw of [...(d.before ?? []), ...(d.after ?? [])]) {
      const id = (raw as Record<string, unknown> | null)?.[key]
      if (typeof id === 'string' && UUID_RE.test(id)) into.add(id)
    }
  }

  return {
    sessions: [...sessions],
    classes: [...classes],
    enrollments: [...enrollments],
    accounts: [...accounts],
  }
}

type AffectedRow = { person_id: string; full_name: string; relation: 'family' | 'coach' }

/**
 * `in (…)` over ids already proved to be uuids, or a predicate that matches
 * nothing. Never an empty `in ()`, which is a syntax error.
 */
function anyOf(ids: string[], column: string): string {
  return ids.length ? `${column} in (${ids.map(uid).join(', ')})` : 'false'
}

/**
 * Everybody whose own arrangements just changed, in the business's own words.
 * Empty when there is nothing to say, which is almost always.
 *
 * `told` is the set of contacts this plan staged a message to, so a plan that
 * did compose its fan-out produces no note at all — the guard exists to catch
 * the silence, not to comment on the traffic.
 */
export async function untoldAudience(
  tx: Tx,
  academyId: string,
  diffs: readonly Diffish[],
  told: readonly string[],
  /** The person doing this. They are not an audience for their own change. */
  actorPersonId?: string | null,
): Promise<string[]> {
  const scope = scopeOf(diffs)
  if (!scope.sessions.length && !scope.classes.length && !scope.enrollments.length && !scope.accounts.length) {
    return []
  }

  const A = uid(academyId)
  const toldIds = told.filter((id) => UUID_RE.test(id))

  /**
   * Four ways to be affected, unioned, then deduped by person.
   *
   * Each branch answers "who depends on this row", never "who might like to
   * know" — the second is a judgement and belongs to the model. A family is
   * reached through the account holder, because that is who the product talks to
   * about a child; a coach is reached as themselves.
   */
  const rows = (await tx.unsafe(
    `with touched as (
       -- families, through a session's live enrolments
       select ac.holder_person_id as person_id, 'family'::text as relation
         from session s
         join enrollment e on e.class_id = s.class_id
                          and e.ended_on is null
         join player pl on pl.id = e.player_id and pl.active
         join account ac on ac.id = pl.account_id
        where s.academy_id = ${A} and ${anyOf(scope.sessions, 's.id')}

       union all
       -- coaches actually expected at a session they did not decline
       select co.person_id, 'coach'
         from session s
         join session_coach sc on sc.session_id = s.id and sc.declined_at is null
         join coach co on co.id = sc.coach_id and co.status <> 'ended'
        where s.academy_id = ${A} and ${anyOf(scope.sessions, 's.id')}

       union all
       -- families of a class whose shape changed
       select ac.holder_person_id, 'family'
         from class c
         join enrollment e on e.class_id = c.id and e.ended_on is null
         join player pl on pl.id = e.player_id and pl.active
         join account ac on ac.id = pl.account_id
        where c.academy_id = ${A} and ${anyOf(scope.classes, 'c.id')}

       union all
       -- coaches assigned to that class
       select co.person_id, 'coach'
         from class c
         join class_coach cc on cc.class_id = c.id
         join coach co on co.id = cc.coach_id and co.status <> 'ended'
        where c.academy_id = ${A} and ${anyOf(scope.classes, 'c.id')}

       union all
       -- the family behind an enrolment that started, moved or ended
       select ac.holder_person_id, 'family'
         from enrollment e
         join player pl on pl.id = e.player_id
         join account ac on ac.id = pl.account_id
        where e.academy_id = ${A} and ${anyOf(scope.enrollments, 'e.id')}

       union all
       -- the account whose money moved
       select ac.holder_person_id, 'family'
         from account ac
        where ac.academy_id = ${A} and ${anyOf(scope.accounts, 'ac.id')}
     )
     select t.person_id, pe.full_name,
            min(t.relation) as relation
       from touched t
       join person pe on pe.id = t.person_id
      where t.person_id is not null
        ${actorPersonId && UUID_RE.test(actorPersonId) ? `and t.person_id <> ${uid(actorPersonId)}` : ''}
        -- Anyone this plan already staged a message to is told. Checked through
        -- the contact table rather than by person id, because a person with two
        -- numbers is one person, told once.
        and not exists (
          select 1 from contact c2
           where c2.person_id = t.person_id
             and c2.academy_id = ${A}
             and ${anyOf(toldIds, 'c2.id')}
        )
      group by t.person_id, pe.full_name
      order by pe.full_name`,
  )) as unknown as AffectedRow[]

  if (!rows.length) return []

  const families = rows.filter((r) => r.relation === 'family')
  const coaches = rows.filter((r) => r.relation === 'coach')

  const parts: string[] = []
  if (families.length) parts.push(`${families.length} famil${families.length === 1 ? 'y' : 'ies'}`)
  if (coaches.length) parts.push(`${coaches.length} coach${coaches.length === 1 ? '' : 'es'}`)

  const names = rows.slice(0, NAMED).map((r) => r.full_name)
  const rest = rows.length - names.length
  const who = rest > 0 ? `${names.join(', ')} and ${rest} more` : names.join(', ')

  // One sentence, stating the fact and nothing about what to do with it. What a
  // moment needs is the model's judgement, and a runtime that suggested the
  // fan-out here would be the second author this architecture spends its whole
  // layer 2 removing.
  return [
    `${parts.join(' and ')} ${rows.length === 1 ? 'is' : 'are'} affected by this and nothing here tells them: ${who}`,
  ]
}

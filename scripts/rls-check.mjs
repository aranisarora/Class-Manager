// Phase 0 acceptance (spec §6.7, §19): cross-tenant and cross-role reads return zero rows,
// and no table has RLS disabled. Run against a database with rows in it:
//
//   node scripts/rls-check.mjs
//
// AN UNTESTED CASE IS A FAILURE HERE, AND THAT IS THE POINT (22 Aug 2026).
//
// Migrations 0008_family_privacy.sql and 0028_rls_once_per_statement.sql were in the
// repo and not in the database. `app.my_coach_id()` appeared in zero live policies; all
// fifty-five were still 0003's form, which lets any parent read any classmate's player,
// person, enrollment and attendance rows. The heading below still printed
// "Family privacy (§6.7)" on every run of that database, and under it: nothing. Every
// case in that block sat behind `if (A.holder) { ... }`, the chosen academy had no
// account holder with a contact, and a block that does not run costs nothing and says
// nothing. The script exited 0.
//
// So a tripwire that cannot trip is worse than no tripwire, because it reads as
// coverage. Three outcomes now, not two — pass, FAIL, and COULD NOT TEST — and the last
// one exits non-zero exactly like a failure, because from outside they are the same
// fact: nobody knows whether the boundary holds.
//
// The same reasoning runs one level deeper, into the assertions themselves. "The account
// holder sees 0 other families' children" passes on an academy that HAS no other family,
// and passed that way for as long as the fixture was thin. So every zero-row assertion
// here is guarded by a service-role count of the rows it is supposed to be denied: no
// rows to be denied, no test. The academy is chosen for the fixture rather than taken as
// whichever tenant `app.list_academies()` happened to return first, and the choice is
// printed, so a reader can see what the run was actually able to look at.
import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(root, '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)

const sql = postgres(env.DATABASE_URL, { ssl: 'require', max: 4, prepare: false, onnotice: () => {} })
let pass = 0
let fail = 0
let blind = 0

function report(ok, label, detail) {
  if (ok) {
    pass++
    console.log(`  pass  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`)
  }
}

/**
 * @mechanism untestedIsFailed — a case this run could not exercise is counted and exits
 *   non-zero, retiring the class of defect where a security check reports success
 *   because it silently did nothing. `report` has two outcomes and a guard around it has
 *   three: the property held, the property failed, or the property was never asked
 *   about. Folding the third into "pass" is what let the family-privacy block print its
 *   heading over an empty database for weeks while the policies underneath it were
 *   0003's, with no family privacy in them at all.
 *
 *   `why` is not optional and is not a category. It is the sentence a reader needs to
 *   decide whether to go and build the fixture or to accept that this deployment cannot
 *   answer the question — and it names the missing rows, because "skipped" on its own is
 *   the word this file used to print and nobody ever chased it.
 */
function cannot(label, why) {
  blind++
  console.log(`  COULD NOT TEST  ${label} — ${why}`)
}

/** Run a query inside a real per-user session. Errors become `{ error }` rather than throwing. */
async function asUser(academyId, personId, contactId, q) {
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe('set local role cm_user')
      await tx`select set_config('app.academy_id', ${academyId}, true),
                      set_config('app.person_id',  ${personId},  true),
                      set_config('app.contact_id', ${contactId}, true)`
      return await tx.unsafe(q)
    })
  } catch (e) {
    return { error: e.message }
  }
}

async function asService(academyId, q) {
  return sql.begin(async (tx) => {
    await tx.unsafe('set local role cm_service')
    await tx`select set_config('app.academy_id', ${academyId}, true)`
    return tx.unsafe(q)
  })
}

/** One scalar count, as the service role, inside one tenant. */
const count = async (academyId, q) => Number((await asService(academyId, q))[0]?.n ?? 0)

// --- meta-test: every table has RLS on -------------------------------------------------
const audit = await sql.begin(async (tx) => {
  await tx.unsafe('set local role cm_service')
  return tx`select tbl from app.rls_audit() where rls_enabled = false`
})
console.log('\nRLS enabled on every table')
report(audit.length === 0, 'no table has RLS disabled', audit.map((r) => r.tbl).join(', '))

// --- the cross-tenant doors are shut to the model's own roles (F-CO) --------------------
//
// This runs BEFORE the two-academy gate below, deliberately: it is the one check here
// that does not need a cast, and it is the check whose absence cost the most. On
// 22 Aug 2026 all thirty-nine `security definer` functions in schema `app` were
// executable by cm_readonly — the role the `read` tool runs as — so `select * from
// app.list_academies()` was a legal `read` and answered with every tenant on the
// deployment. 0007's own header said the opposite in prose, and nothing anywhere
// compared the prose to the grants.
//
// `revoke all ... from public` was never enough: `alter default privileges in schema
// app grant execute on functions to cm_service, cm_user, cm_readonly` (0006_grants.sql)
// hands every function created afterwards an EXPLICIT grant to all three, and revoking
// PUBLIC does not touch it. So the property has to be asserted rather than assumed —
// and asserted as a DEFAULT-CLOSED rule, because the failure mode is somebody adding a
// ninth door and no test noticing.
//
// A `security definer` function in schema `app` runs as the table owner and therefore
// bypasses RLS entirely. Any such function the model can execute is a hole in the only
// security boundary the product has. The ones listed here are the ones RLS POLICIES
// call — they must stay reachable or every policy breaks — and everything else must be
// unreachable. A new function is refused by name until somebody says which it is.
const POLICY_HELPERS = new Set([
  // read by policies, on every row, for every role
  'now', 'now_for', 'today', 'academy_id', 'person_id', 'contact_id',
  'is_admin', 'is_solo', 'sees_money',
  'my_coach_id', 'my_player_ids', 'my_account_ids', 'my_session_ids',
  'session_is_covered', 'effective_rate', 'account_balance',
  'dial_code', 'normalize_phone', 'name_key', 'identity', 'lane_for',
  'day_name', 'clock_label', 'slot_label', 'local_clock', 'local_label',
  'record_rate_period', 'rls_audit', 'next_event_at',
  // trigger bodies: they cannot be called by hand at all — Postgres refuses a
  // direct call with "can only be called as a trigger" — so a grant on one is
  // noise rather than a door.
  'snapshot_row', 'begin_audit', 'stamp_job_lane', 'touch_contact_inbound',
  'contact_normalize_phone', 'adopt_existing_name', 'attendance_enqueue_outcome',
  'activate_admin_coach', 'activate_coach_on_admin',
  'materialize_on_slot_change', 'materialize_on_class_change',
  'guard_go_live', 'is_placeholder_phone', 'stamp_message_status_seq',
  // claimed by the beat under an infra session, never by a person's session
  'claim_jobs', 'enqueue_job',
])

const reachable = await sql.begin(async (tx) => {
  await tx.unsafe('set local role cm_service')
  return tx`
    select p.proname,
           bool_or(has_function_privilege('cm_user',     p.oid, 'execute')) as u,
           bool_or(has_function_privilege('cm_readonly', p.oid, 'execute')) as r
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.prosecdef
     group by p.proname
     having bool_or(has_function_privilege('cm_user',     p.oid, 'execute'))
         or bool_or(has_function_privilege('cm_readonly', p.oid, 'execute'))
     order by 1`
})

console.log('\nCross-tenant doors are shut to the model (F-CO)')
const undeclared = reachable.map((f) => f.proname).filter((n) => !POLICY_HELPERS.has(n))
report(
  undeclared.length === 0,
  'no security-definer function in schema app is reachable by cm_user/cm_readonly unless a policy needs it',
  undeclared.length
    ? `reachable and not a policy helper: ${undeclared.join(', ')} — revoke it, or add it to POLICY_HELPERS and say why`
    : '',
)

// The one that actually happened, asserted directly rather than only by the rule above.
// The GUC is irrelevant here on purpose: a `security definer` function runs as the
// table owner and ignores it entirely. What is under test is the GRANT.
const doorProbe = await asUser('00000000-0000-0000-0000-000000000000', '', '',
  'select count(*)::int as n from app.list_academies()')
report(
  !!doorProbe.error || Number(doorProbe[0]?.n ?? 0) === 0,
  'a user session cannot enumerate the tenants on this deployment',
  Array.isArray(doorProbe) ? `app.list_academies() returned ${doorProbe[0]?.n} rows to cm_user` : '',
)

// --- choose the cast, and choose it for the fixture ---------------------------------------
// The one legitimate cross-tenant read in the product, through the named door (0007).
const academies = await sql.begin(async (tx) => {
  await tx.unsafe('set local role cm_service')
  return tx`select id, name from app.list_academies()`
})

/** The four people every case below needs one of, and the ids they are addressed by. */
async function castFor(academyId) {
  const admin = (await asService(academyId, `
    select p.id as person_id, c.id as contact_id
    from academy_admin aa join person p on p.id = aa.person_id
    join contact c on c.person_id = p.id and c.academy_id = aa.academy_id
    where aa.academy_id = '${academyId}' limit 1`))[0]
  const coach = (await asService(academyId, `
    select p.id as person_id, c.id as contact_id
    from coach co join person p on p.id = co.person_id
    join contact c on c.person_id = p.id and c.academy_id = co.academy_id
    where co.academy_id = '${academyId}' and co.status = 'active'
      and not exists (select 1 from academy_admin aa where aa.person_id = p.id)
    limit 1`))[0]
  const holder = (await asService(academyId, `
    select p.id as person_id, c.id as contact_id
    from account ac join person p on p.id = ac.holder_person_id
    join contact c on c.person_id = p.id and c.academy_id = ac.academy_id
    where ac.academy_id = '${academyId}' limit 1`))[0]
  const playerOwnNumber = (await asService(academyId, `
    select p.id as person_id, c.id as contact_id
    from player pl join person p on p.id = pl.person_id
    join contact c on c.person_id = p.id and c.academy_id = pl.academy_id
    join account ac on ac.id = pl.account_id
    where pl.academy_id = '${academyId}' and ac.holder_person_id <> pl.person_id limit 1`))[0]
  return { admin, coach, holder, playerOwnNumber }
}

/**
 * What rows a tenant actually has, counted as the service role inside it.
 *
 * Every zero-row assertion below is a claim that rows exist and are hidden. On a tenant
 * with no rows the same assertion is a claim that nothing exists, which is true of an
 * empty schema and of a wide-open one alike. So the counts are gathered first and the
 * cases consult them: this is the difference between "the wall held" and "nobody walked
 * into it".
 *
 * `familiesInOneClass` is the fixture the whole family-privacy block turns on. One
 * family in a class cannot demonstrate that a parent is denied another family's rows,
 * because there is no other family in the room.
 */
async function fixtureFor(ac) {
  const n = (await asService(ac.id, `
    select (select count(*) from person)::int      as person,
           (select count(*) from class)::int       as class,
           (select count(*) from session)::int     as session,
           (select count(*) from tally_line)::int  as tally_line,
           (select count(*) from payment)::int     as payment,
           (select count(*) from contact)::int     as contact,
           (select count(*) from coach)::int       as coach,
           (select count(*) from player)::int      as player,
           (select count(*) from attendance)::int  as attendance,
           (select coalesce(max(f), 0) from (
              select count(distinct pl.account_id) as f
                from enrollment e join player pl on pl.id = e.player_id
               where e.ended_on is null
               group by e.class_id) g)::int        as families_in_one_class`))[0]
  return { id: ac.id, name: ac.name, cast: await castFor(ac.id), n }
}

const fixtures = []
for (const ac of academies) fixtures.push(await fixtureFor(ac))

/**
 * Rank by what a tenant can PROVE, not by what it contains.
 *
 * Two families in one class first, because it is the fixture the deepest block needs and
 * the one this deployment is least likely to have. Then how many of the four seats are
 * fillable, because a missing seat blanks a whole block. Row count only breaks ties: the
 * biggest tenant on the deployment is worth nothing here if its parents have no
 * classmates.
 */
const rank = (f) =>
  (f.n.families_in_one_class >= 2 ? 1000 : 0) +
  100 * [f.cast.admin, f.cast.coach, f.cast.holder, f.cast.playerOwnNumber].filter(Boolean).length +
  Math.min(99, f.n.person)

const ranked = [...fixtures].sort((x, y) => rank(y) - rank(x))
const A = ranked[0]
/** The other tenant, chosen for having rows to be denied. An empty B proves nothing. */
const B = ranked.slice(1).find((f) => f.n.person > 0) ?? null

if (!A) {
  console.log('\nThere are no academies on this deployment — every case below needs at least one.')
  console.log('\n0 passed, 0 failed, 1 could not be tested\n')
  await sql.end({ timeout: 5 })
  process.exit(1)
}

console.log(`\nCast`)
console.log(`  under test   ${A.name}`)
console.log(
  `               ${A.n.person} people · ${A.n.player} players · ${A.n.coach} coaches · ` +
    `${A.n.tally_line} tally lines · ${A.n.payment} payments · ` +
    `biggest class holds ${A.n.families_in_one_class} famil${A.n.families_in_one_class === 1 ? 'y' : 'ies'}`,
)
console.log(
  `               seats: ` +
    ['admin', 'coach', 'holder', 'playerOwnNumber'].map((k) => `${k}=${A.cast[k] ? 'yes' : 'NO'}`).join(' · '),
)
console.log(`  other tenant ${B ? `${B.name} (${B.n.person} people)` : 'none with rows in it'}`)

// --- cross-tenant ------------------------------------------------------------------------
console.log(`\nCross-tenant  (${A.name} ${B ? '↔ ' + B.name : ''})`)
if (!A.cast.admin) {
  cannot('every cross-tenant read', `${A.name} has no academy_admin with a contact row to sit in the seat`)
} else if (!B) {
  cannot('every cross-tenant read', 'there is no second tenant with any rows in it, so there is nothing to be denied')
} else {
  // An admin of A, pointed at their OWN academy, must not see B's rows.
  for (const t of ['person', 'class', 'session', 'tally_line', 'payment', 'contact', 'coach']) {
    const label = `admin of ${A.name} sees 0 rows of ${B.name}.${t}`
    // A zero-row read of a table B does not have is not a boundary holding.
    if (!B.n[t]) {
      cannot(label, `${B.name} has no ${t} rows, so a zero here is the fixture and not the policy`)
      continue
    }
    const r = await asUser(A.id, A.cast.admin.person_id, A.cast.admin.contact_id,
      `select count(*)::int as n from ${t} where academy_id = '${B.id}'`)
    report(!r.error && r[0]?.n === 0, label, r.error ?? `n=${r[0]?.n}`)
  }
  // And an admin of A claiming to be in B's tenant sees nothing either: the GUC is not a grant.
  const spoof = await asUser(B.id, A.cast.admin.person_id, A.cast.admin.contact_id, `select count(*)::int as n from person`)
  report(!spoof.error && spoof[0]?.n === 0, `admin of ${A.name} spoofing academy_id=${B.name} sees 0 people`,
    spoof.error ?? `n=${spoof[0]?.n}`)
}

// --- cross-role --------------------------------------------------------------------------
console.log('\nCross-role')
if (!A.cast.coach) {
  cannot("the coach's three cases", `${A.name} has no active non-admin coach with a contact row`)
} else {
  const coachPerson = A.cast.coach.person_id
  for (const t of ['tally_line', 'payment']) {
    const label = `coach sees 0 rows of ${t} (§6.7: never the academy's money)`
    if (!A.n[t]) {
      cannot(label, `${A.name} has no ${t} rows at all, so the coach is denied nothing`)
      continue
    }
    const r = await asUser(A.id, coachPerson, A.cast.coach.contact_id, `select count(*)::int as n from ${t}`)
    report(!r.error && r[0]?.n === 0, label, r.error ?? `n=${r[0]?.n}`)
  }

  const otherCoaches = await count(A.id, `select count(*)::int as n from coach where person_id <> '${coachPerson}'`)
  const otherLabel = "coach sees 0 other coach rows (§6.7: never another coach's pay)"
  if (!otherCoaches) {
    cannot(otherLabel, `${A.name} has only one coach, so there is no other pay row to be hidden`)
  } else {
    const otherPay = await asUser(A.id, coachPerson, A.cast.coach.contact_id,
      `select count(*)::int as n from coach where person_id <> '${coachPerson}'`)
    report(!otherPay.error && otherPay[0]?.n === 0, otherLabel, otherPay.error ?? `n=${otherPay[0]?.n}`)
  }

  const ownPay = await asUser(A.id, coachPerson, A.cast.coach.contact_id,
    `select count(*)::int as n from coach where person_id = '${coachPerson}'`)
  report(!ownPay.error && ownPay[0]?.n === 1, 'coach sees their OWN coach row incl. pay (§8.2)',
    ownPay.error ?? `n=${ownPay[0]?.n}`)
}

if (!A.cast.holder) {
  cannot("the account holder's two money cases", `${A.name} has no account holder with a contact row`)
} else {
  const holder = A.cast.holder.person_id
  const othersOwn = `account_id not in (select id from account where holder_person_id = '${holder}')`
  const otherTally = await count(A.id, `select count(*)::int as n from tally_line where ${othersOwn}`)
  const label = 'account holder sees 0 other families’ tally lines'
  if (!otherTally) {
    cannot(label, `no other family in ${A.name} has a tally line, so a zero here is the fixture`)
  } else {
    const others = await asUser(A.id, holder, A.cast.holder.contact_id,
      `select count(*)::int as n from tally_line where ${othersOwn}`)
    report(!others.error && others[0]?.n === 0, label, others.error ?? `n=${others[0]?.n}`)
  }
  const own = await asUser(A.id, holder, A.cast.holder.contact_id, `select count(*)::int as n from tally_line`)
  report(!own.error, 'account holder can read their own tally lines', own.error)
}

if (!A.cast.playerOwnNumber) {
  cannot(
    'the two cases for a player on their own number',
    `no player in ${A.name} has a contact of their own on an account somebody else holds`,
  )
} else {
  for (const t of ['tally_line', 'payment']) {
    const label = `player on their own number sees 0 ${t} (§6.7: money never routes to a player number)`
    if (!A.n[t]) {
      cannot(label, `${A.name} has no ${t} rows at all, so the player is denied nothing`)
      continue
    }
    const r = await asUser(A.id, A.cast.playerOwnNumber.person_id, A.cast.playerOwnNumber.contact_id,
      `select count(*)::int as n from ${t}`)
    report(!r.error && r[0]?.n === 0, label, r.error ?? `n=${r[0]?.n}`)
  }
}

// --- never another family, but the coach still gets their roster -------------------------
//
// The block that printed its heading over nothing. Its cases are the ones 0008 exists for,
// and every one of them needs a room with two families in it — which is why the tenant was
// chosen on that fixture above, and why a deployment without one says so here in words.
console.log('\nFamily privacy (§6.7)')
if (A.n.families_in_one_class < 2) {
  cannot(
    "the parent's three cases",
    `no class in ${A.name} holds two families, so no parent here has a classmate whose rows could leak`,
  )
} else if (!A.cast.holder) {
  cannot("the parent's three cases", `${A.name} has no account holder with a contact row`)
} else {
  const holder = A.cast.holder.person_id
  const mineOnly = `select pl.id from player pl join account ac on ac.id = pl.account_id
        where ac.holder_person_id = '${holder}'`
  const otherKids = await count(A.id, `select count(*)::int as n
      from player pl join account ac on ac.id = pl.account_id
     where ac.holder_person_id <> '${holder}'`)
  const ownKids = await count(A.id, `select count(*)::int as n
      from player pl join account ac on ac.id = pl.account_id
     where ac.holder_person_id = '${holder}'`)

  const otherLabel = 'account holder sees 0 other families’ children'
  if (!otherKids) {
    cannot(otherLabel, `the chosen holder in ${A.name} is the only family with a child on the roll`)
  } else {
    const others = await asUser(A.id, holder, A.cast.holder.contact_id, `
      select count(*)::int as n
        from player pl join account ac on ac.id = pl.account_id
       where ac.holder_person_id <> '${holder}'`)
    report(!others.error && others[0]?.n === 0, otherLabel, others.error ?? `n=${others[0]?.n}`)
  }

  const mineLabel = 'account holder still sees their own children'
  if (!ownKids) {
    cannot(mineLabel, 'the chosen holder has no children on the roll, so there is nothing they should see')
  } else {
    const mine = await asUser(A.id, holder, A.cast.holder.contact_id, `select count(*)::int as n from player`)
    report(!mine.error && mine[0]?.n > 0, mineLabel, mine.error ?? `n=${mine[0]?.n}`)
  }

  // Through `coach_public`, not `coach`: a parent cannot read the coach table at all
  // (that is where pay lives), which is exactly why the view exists.
  const staffLabel = 'account holder still sees the coaches of their child’s classes'
  const staffThere = await count(A.id, `select count(distinct cc.coach_id)::int as n
      from class_coach cc
      join enrollment e on e.class_id = cc.class_id
      join player pl on pl.id = e.player_id
      join account ac on ac.id = pl.account_id
     where ac.holder_person_id = '${holder}'`)
  if (!staffThere) {
    cannot(staffLabel, "no coach is named on any class the chosen holder's children are in")
  } else {
    const staff = await asUser(A.id, holder, A.cast.holder.contact_id, `
      select count(*)::int as n from person pe
       where exists (select 1 from coach_public cp where cp.person_id = pe.id)`)
    report(!staff.error && staff[0]?.n > 0, staffLabel, staff.error ?? `n=${staff[0]?.n}`)
  }

  // `app.session_roster` (0022) is the register join, written once so the model
  // stops rebuilding it. It is `security_invoker`, so it inherits every policy
  // below it — but a view is exactly the shape that quietly stops doing that if
  // somebody recreates it without the option, and the failure would be silent
  // and total: every classmate's name to every parent. Checked here rather than
  // trusted.
  const rosterLabel = 'account holder sees 0 other children through app.session_roster'
  const rosterRows = await count(A.id, `select count(*)::int as n from app.session_roster r
     where r.player_id not in (${mineOnly})`)
  if (!rosterRows) {
    cannot(rosterLabel, "app.session_roster holds no row for anybody else's child, so the view is denied nothing")
  } else {
    const roster = await asUser(A.id, holder, A.cast.holder.contact_id, `
      select count(*)::int as n
        from app.session_roster r
       where r.player_id not in (${mineOnly})`)
    report(!roster.error && roster[0]?.n === 0, rosterLabel, roster.error ?? `n=${roster[0]?.n}`)
  }
}

if (!A.cast.coach) {
  cannot("the coach's three roster cases", `${A.name} has no active non-admin coach with a contact row`)
} else {
  const coachPerson = A.cast.coach.person_id
  const onMySessions = `from session_coach sc join coach co on co.id = sc.coach_id
     where co.person_id = '${coachPerson}'`
  const assigned = await count(A.id, `select count(*)::int as n ${onMySessions}`)
  if (!assigned) {
    cannot(
      "the coach's three roster cases",
      `the chosen coach in ${A.name} is not on any session, so an empty roster is the fixture and not the policy`,
    )
  } else {
    const rosterLabel = 'coach still sees the roster of sessions they are assigned to'
    const rosterThere = await count(A.id, `select count(*)::int as n
        from enrollment e
        join session s on s.class_id = e.class_id
        join session_coach sc on sc.session_id = s.id
        join coach co on co.id = sc.coach_id
       where co.person_id = '${coachPerson}' and e.ended_on is null`)
    if (!rosterThere) {
      cannot(rosterLabel, "nobody is enrolled in the chosen coach's classes, so there is no roster to see")
    } else {
      const roster = await asUser(A.id, coachPerson, A.cast.coach.contact_id,
        `select count(*)::int as n from player`)
      report(!roster.error && roster[0]?.n > 0, rosterLabel, roster.error ?? `n=${roster[0]?.n}`)
    }

    const attLabel = 'coach still sees that roster’s attendance'
    const attThere = await count(A.id, `select count(*)::int as n
        from attendance a
        join session_coach sc on sc.session_id = a.session_id
        join coach co on co.id = sc.coach_id
       where co.person_id = '${coachPerson}'`)
    if (!attThere) {
      cannot(attLabel, "no register has been marked on any of the chosen coach's sessions")
    } else {
      const att = await asUser(A.id, coachPerson, A.cast.coach.contact_id,
        `select count(*)::int as n from attendance`)
      report(!att.error && att[0]?.n > 0, attLabel, att.error ?? `n=${att[0]?.n}`)
    }

    // The other half of the 0022 check above: scoping a view down until it leaks
    // nothing is easy if it also returns nothing. A coach must still get the whole
    // register out of it, or the view is worse than the join it replaced.
    const viewLabel = 'coach still sees their register through app.session_roster'
    const viewThere = await count(A.id, `select count(*)::int as n
        from app.session_roster r
        join session_coach sc on sc.session_id = r.session_id
        join coach co on co.id = sc.coach_id
       where co.person_id = '${coachPerson}'`)
    if (!viewThere) {
      cannot(viewLabel, "app.session_roster holds no row for the chosen coach's sessions")
    } else {
      const viaView = await asUser(A.id, coachPerson, A.cast.coach.contact_id,
        `select count(*)::int as n from app.session_roster`)
      report(!viaView.error && viaView[0]?.n > 0, viewLabel, viaView.error ?? `n=${viaView[0]?.n}`)
    }
  }
}

// --- infrastructure is unreachable from a user session -----------------------------------
console.log('\nInfrastructure tables are unreachable through a user session (§6.7)')
if (!A.cast.admin) {
  cannot('every infrastructure case', `${A.name} has no academy_admin with a contact row to sit in the seat`)
} else {
  for (const t of ['sender', 'job', 'turn', 'audit_entry']) {
    const label = `admin cannot read ${t}`
    // These four are global or runtime-owned, so the count is taken with the tenant GUC
    // set and read as "does this deployment have any row an admin could have reached".
    const there = await count(A.id, `select count(*)::int as n from ${t}`)
    if (!there) {
      cannot(label, `${t} is empty on this deployment, so a zero read proves nothing about the policy`)
      continue
    }
    const r = await asUser(A.id, A.cast.admin.person_id, A.cast.admin.contact_id, `select count(*)::int as n from ${t}`)
    const blocked = !!r.error || r[0]?.n === 0
    report(blocked, label, r.error ? '' : `n=${r[0]?.n}`)
  }
}

console.log(
  `\n${pass} passed, ${fail} failed, ${blind} could not be tested` +
    (blind ? ' — and an untested boundary is an unknown one, so this run is a failure' : '') +
    '\n',
)
await sql.end({ timeout: 5 })
process.exit(fail || blind ? 1 : 0)

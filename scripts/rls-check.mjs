// Phase 0 acceptance (spec §6.7, §19): cross-tenant and cross-role reads return zero rows,
// and no table has RLS disabled. Run after seeding:  node scripts/rls-check.mjs
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

function report(ok, label, detail) {
  if (ok) {
    pass++
    console.log(`  pass  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`)
  }
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

// --- gather the cast --------------------------------------------------------------------
// The one legitimate cross-tenant read in the product, through the named door (0007).
const academies = await sql.begin(async (tx) => {
  await tx.unsafe('set local role cm_service')
  return tx`select id, name from app.list_academies()`
})

if (academies.length < 2) {
  console.log('\nSeed both academies first (`npm run seed`) — cross-tenant checks need two tenants.')
  await sql.end({ timeout: 5 })
  process.exit(fail ? 1 : 0)
}

const [a, b] = academies

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

const A = await castFor(a.id)
const B = await castFor(b.id)

// --- cross-tenant ------------------------------------------------------------------------
console.log(`\nCross-tenant  (${a.name} ↔ ${b.name})`)
if (A.admin) {
  // An admin of A, pointed at their OWN academy, must not see B's rows.
  for (const t of ['person', 'class', 'session', 'tally_line', 'payment', 'contact', 'coach']) {
    const r = await asUser(a.id, A.admin.person_id, A.admin.contact_id,
      `select count(*)::int as n from ${t} where academy_id = '${b.id}'`)
    report(!r.error && r[0]?.n === 0, `admin of ${a.name} sees 0 rows of ${b.name}.${t}`, r.error ?? `n=${r[0]?.n}`)
  }
  // And an admin of A claiming to be in B's tenant sees nothing either: the GUC is not a grant.
  const spoof = await asUser(b.id, A.admin.person_id, A.admin.contact_id, `select count(*)::int as n from person`)
  report(!spoof.error && spoof[0]?.n === 0, `admin of ${a.name} spoofing academy_id=${b.name} sees 0 people`,
    spoof.error ?? `n=${spoof[0]?.n}`)
}

// --- cross-role --------------------------------------------------------------------------
console.log('\nCross-role')
if (A.coach) {
  for (const t of ['tally_line', 'payment']) {
    const r = await asUser(a.id, A.coach.person_id, A.coach.contact_id, `select count(*)::int as n from ${t}`)
    report(!r.error && r[0]?.n === 0, `coach sees 0 rows of ${t} (§6.7: never the academy's money)`,
      r.error ?? `n=${r[0]?.n}`)
  }
  const otherPay = await asUser(a.id, A.coach.person_id, A.coach.contact_id,
    `select count(*)::int as n from coach where person_id <> '${A.coach.person_id}'`)
  report(!otherPay.error && otherPay[0]?.n === 0, "coach sees 0 other coach rows (§6.7: never another coach's pay)",
    otherPay.error ?? `n=${otherPay[0]?.n}`)
  const ownPay = await asUser(a.id, A.coach.person_id, A.coach.contact_id,
    `select count(*)::int as n from coach where person_id = '${A.coach.person_id}'`)
  report(!ownPay.error && ownPay[0]?.n === 1, 'coach sees their OWN coach row incl. pay (§8.2)',
    ownPay.error ?? `n=${ownPay[0]?.n}`)
}

if (A.holder) {
  const others = await asUser(a.id, A.holder.person_id, A.holder.contact_id,
    `select count(*)::int as n from tally_line where account_id not in (
       select id from account where holder_person_id = '${A.holder.person_id}')`)
  report(!others.error && others[0]?.n === 0, 'account holder sees 0 other families’ tally lines', others.error ?? `n=${others[0]?.n}`)
  const own = await asUser(a.id, A.holder.person_id, A.holder.contact_id, `select count(*)::int as n from tally_line`)
  report(!own.error, 'account holder can read their own tally lines', own.error)
}

if (A.playerOwnNumber) {
  for (const t of ['tally_line', 'payment']) {
    const r = await asUser(a.id, A.playerOwnNumber.person_id, A.playerOwnNumber.contact_id,
      `select count(*)::int as n from ${t}`)
    report(!r.error && r[0]?.n === 0,
      `player on their own number sees 0 ${t} (§6.7: money never routes to a player number)`,
      r.error ?? `n=${r[0]?.n}`)
  }
} else {
  console.log('  skip  no player with their own contact in the seed')
}

// --- never another family, but the coach still gets their roster -------------------------
console.log('\nFamily privacy (§6.7)')
if (A.holder) {
  const others = await asUser(a.id, A.holder.person_id, A.holder.contact_id, `
    select count(*)::int as n
      from player pl join account ac on ac.id = pl.account_id
     where ac.holder_person_id <> '${A.holder.person_id}'`)
  report(!others.error && others[0]?.n === 0,
    'account holder sees 0 other families’ children', others.error ?? `n=${others[0]?.n}`)

  const mine = await asUser(a.id, A.holder.person_id, A.holder.contact_id,
    `select count(*)::int as n from player`)
  report(!mine.error && mine[0]?.n > 0, 'account holder still sees their own children', mine.error ?? `n=${mine[0]?.n}`)

  // Through `coach_public`, not `coach`: a parent cannot read the coach table at all
  // (that is where pay lives), which is exactly why the view exists.
  const staff = await asUser(a.id, A.holder.person_id, A.holder.contact_id, `
    select count(*)::int as n from person pe
     where exists (select 1 from coach_public cp where cp.person_id = pe.id)`)
  report(!staff.error && staff[0]?.n > 0,
    'account holder still sees the coaches of their child’s classes', staff.error ?? `n=${staff[0]?.n}`)

  // `app.session_roster` (0022) is the register join, written once so the model
  // stops rebuilding it. It is `security_invoker`, so it inherits every policy
  // below it — but a view is exactly the shape that quietly stops doing that if
  // somebody recreates it without the option, and the failure would be silent
  // and total: every classmate's name to every parent. Checked here rather than
  // trusted.
  const roster = await asUser(a.id, A.holder.person_id, A.holder.contact_id, `
    select count(*)::int as n
      from app.session_roster r
     where r.player_id not in (
       select pl.id from player pl join account ac on ac.id = pl.account_id
        where ac.holder_person_id = '${A.holder.person_id}')`)
  report(!roster.error && roster[0]?.n === 0,
    'account holder sees 0 other children through app.session_roster',
    roster.error ?? `n=${roster[0]?.n}`)
}
if (A.coach) {
  const roster = await asUser(a.id, A.coach.person_id, A.coach.contact_id,
    `select count(*)::int as n from player`)
  report(!roster.error && roster[0]?.n > 0,
    'coach still sees the roster of sessions they are assigned to', roster.error ?? `n=${roster[0]?.n}`)
  const att = await asUser(a.id, A.coach.person_id, A.coach.contact_id,
    `select count(*)::int as n from attendance`)
  report(!att.error && att[0]?.n > 0, 'coach still sees that roster’s attendance', att.error ?? `n=${att[0]?.n}`)

  // The other half of the 0022 check above: scoping a view down until it leaks
  // nothing is easy if it also returns nothing. A coach must still get the whole
  // register out of it, or the view is worse than the join it replaced.
  const viaView = await asUser(a.id, A.coach.person_id, A.coach.contact_id,
    `select count(*)::int as n from app.session_roster`)
  report(!viaView.error && viaView[0]?.n > 0,
    'coach still sees their register through app.session_roster', viaView.error ?? `n=${viaView[0]?.n}`)
}

// --- infrastructure is unreachable from a user session -----------------------------------
console.log('\nInfrastructure tables are unreachable through a user session (§6.7)')
if (A.admin) {
  for (const t of ['sender', 'job', 'turn', 'audit_entry']) {
    const r = await asUser(a.id, A.admin.person_id, A.admin.contact_id, `select count(*)::int as n from ${t}`)
    const blocked = !!r.error || r[0]?.n === 0
    report(blocked, `admin cannot read ${t}`, r.error ? '' : `n=${r[0]?.n}`)
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`)
await sql.end({ timeout: 5 })
process.exit(fail ? 1 : 0)

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
}
if (A.coach) {
  const roster = await asUser(a.id, A.coach.person_id, A.coach.contact_id,
    `select count(*)::int as n from player`)
  report(!roster.error && roster[0]?.n > 0,
    'coach still sees the roster of sessions they are assigned to', roster.error ?? `n=${roster[0]?.n}`)
  const att = await asUser(a.id, A.coach.person_id, A.coach.contact_id,
    `select count(*)::int as n from attendance`)
  report(!att.error && att[0]?.n > 0, 'coach still sees that roster’s attendance', att.error ?? `n=${att[0]?.n}`)
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

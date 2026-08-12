// Validates the session architecture: cm_runtime can SET ROLE into each RLS role,
// the GUCs land, app.now() works, and cm_readonly really is read-only.
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

const sql = postgres(env.DATABASE_URL, { ssl: 'require', max: 2, prepare: false, onnotice: () => {} })

async function check(label, fn) {
  try {
    const r = await fn()
    console.log(`OK   ${label} -> ${JSON.stringify(r)}`)
  } catch (e) {
    console.log(`FAIL ${label} -> ${e.message}`)
  }
}

await check('bare cm_runtime cannot read academy', async () => {
  try {
    await sql`select count(*) from academy`
    return 'UNEXPECTED: it could'
  } catch (e) {
    return 'correctly denied: ' + e.message.slice(0, 60)
  }
})

await check('set role cm_service + GUC', () =>
  sql.begin(async (tx) => {
    await tx.unsafe('set local role cm_service')
    await tx`select set_config('app.academy_id', ${'00000000-0000-0000-0000-000000000001'}, true)`
    const r = await tx`select current_user, app.academy_id() as aid, app.now() as n`
    return r[0]
  }),
)

await check('set role cm_user + GUCs', () =>
  sql.begin(async (tx) => {
    await tx.unsafe('set local role cm_user')
    await tx`select set_config('app.academy_id', ${'00000000-0000-0000-0000-000000000001'}, true)`
    await tx`select set_config('app.person_id', ${'00000000-0000-0000-0000-000000000002'}, true)`
    await tx`select set_config('app.contact_id', ${'00000000-0000-0000-0000-000000000003'}, true)`
    const r = await tx`select current_user, app.is_admin() as admin, app.sees_money() as money, app.my_coach_id() as coach`
    return r[0]
  }),
)

await check('cm_readonly cannot write', () =>
  sql.begin(async (tx) => {
    await tx.unsafe('set local role cm_readonly')
    await tx.unsafe("set local statement_timeout = '5s'")
    try {
      await tx`insert into venue (academy_id, name) values (gen_random_uuid(), 'x')`
      return 'UNEXPECTED: write allowed'
    } catch (e) {
      return 'correctly denied: ' + e.message.slice(0, 60)
    }
  }),
)

await check('rls_audit: tables missing RLS', async () => {
  const r = await sql.begin(async (tx) => {
    await tx.unsafe('set local role cm_service')
    return tx`select count(*)::int as n from app.rls_audit() where rls_enabled = false`
  })
  return r[0]
})

await check('views exist', async () => {
  const r = await sql`select table_name from information_schema.views where table_schema='public' order by 1`
  return r.map((x) => x.table_name)
})

await sql.end({ timeout: 5 })
process.exit(0)

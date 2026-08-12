// The `read` tool runs as cm_readonly. If any table is visible to cm_user but not
// cm_readonly, the model can act on data it cannot see — the worst kind of split brain.
import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const sql = postgres(env.DATABASE_URL, { ssl: 'require', max: 3, prepare: false, onnotice: () => {} })

const [ace] = await sql.begin(async (tx) => {
  await tx.unsafe('set local role cm_service')
  return tx`select id from app.list_academies() where name like 'Ace%'`
})
const [admin] = await sql.begin(async (tx) => {
  await tx.unsafe('set local role cm_service')
  await tx`select set_config('app.academy_id', ${ace.id}, true)`
  return tx`select p.id person_id, c.id contact_id from academy_admin aa
            join person p on p.id = aa.person_id
            join contact c on c.person_id = p.id and c.academy_id = aa.academy_id limit 1`
})

async function as(role, q) {
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`)
      await tx`select set_config('app.academy_id', ${ace.id}, true),
                      set_config('app.person_id',  ${admin.person_id}, true),
                      set_config('app.contact_id', ${admin.contact_id}, true)`
      return await tx.unsafe(q)
    })
  } catch (e) {
    return { error: e.message.slice(0, 70) }
  }
}

const tables = ['academy','venue','person','contact','account','player','coach','class','class_slot',
  'class_coach','enrollment','session','session_coach','attendance','tally_line','payment','message',
  'memory_fact','action','view_spec','audit_entry','recipe','turn','job','sender']

console.log('table                cm_user   cm_readonly')
let split = 0
for (const t of tables) {
  const u = await as('cm_user', `select count(*)::int n from ${t}`)
  const r = await as('cm_readonly', `select count(*)::int n from ${t}`)
  const un = u.error ? 'denied' : String(u[0].n)
  const rn = r.error ? 'denied' : String(r[0].n)
  const bad = un !== rn
  if (bad) split++
  console.log(`${t.padEnd(20)} ${un.padEnd(9)} ${rn}${bad ? '   <-- SPLIT' : ''}`)
}

console.log('\nviews')
for (const v of ['session_coverage', 'uncovered_session', 'coach_public']) {
  const u = await as('cm_user', `select count(*)::int n from ${v}`)
  const r = await as('cm_readonly', `select count(*)::int n from ${v}`)
  console.log(`${v.padEnd(20)} ${u.error ? 'denied' : u[0].n}   ${r.error ? 'denied: ' + r.error : r[0].n}`)
}

console.log(`\n${split} table(s) where the model reads differently from how it writes`)
await sql.end({ timeout: 5 })

// "Never another family" (§6.7). The judge flagged another child's name reaching a
// parent — this checks whether RLS actually allows it, or whether the model said it
// from context it should never have had.
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
const [meera] = await sql.begin(async (tx) => {
  await tx.unsafe('set local role cm_service')
  await tx`select set_config('app.academy_id', ${ace.id}, true)`
  return tx`select p.id person_id, c.id contact_id, p.full_name
            from person p join contact c on c.person_id = p.id
            where p.full_name like 'Meera%' and c.academy_id = ${ace.id} limit 1`
})

async function asMeera(q) {
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe('set local role cm_readonly')
      await tx`select set_config('app.academy_id', ${ace.id}, true),
                      set_config('app.person_id',  ${meera.person_id}, true),
                      set_config('app.contact_id', ${meera.contact_id}, true)`
      return await tx.unsafe(q)
    })
  } catch (e) {
    return { error: e.message.slice(0, 80) }
  }
}

console.log(`acting as ${meera.full_name} (account holder)\n`)

const checks = [
  ['players visible', `select p.id, pe.full_name from player p join person pe on pe.id = p.person_id`],
  ['persons visible', `select full_name from person order by full_name`],
  ['enrollments visible', `select count(*)::int n from enrollment`],
  ['attendance visible', `select count(*)::int n from attendance`],
]

for (const [label, q] of checks) {
  const r = await asMeera(q)
  if (r.error) { console.log(`${label}: denied (${r.error})`); continue }
  const names = r.map((x) => x.full_name).filter(Boolean)
  console.log(`${label}: ${names.length ? names.join(', ') : JSON.stringify(r[0])}`)
}

// The specific claim: can Meera see Ananya, who is in the same class but another family?
const leak = await asMeera(`
  select pe.full_name
  from player pl join person pe on pe.id = pl.person_id
  join account ac on ac.id = pl.account_id
  where ac.holder_person_id <> '${meera.person_id}'`)
console.log('\nother families\' children visible to her:',
  leak.error ? `denied (${leak.error})` : (leak.length ? leak.map((r) => r.full_name).join(', ') + '   <-- LEAK' : 'none  ✓'))

await sql.end({ timeout: 5 })

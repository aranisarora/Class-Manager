import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'
const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)
const sql = postgres(env.DATABASE_URL, { ssl: 'require', max: 2, prepare: false, onnotice: () => {} })
const svc = (aid, q) => sql.begin(async (tx) => {
  await tx.unsafe('set local role cm_service')
  await tx`select set_config('app.academy_id', ${aid}, true)`
  return tx.unsafe(q)
})
const [ace] = await sql.begin(async (tx) => {
  await tx.unsafe('set local role cm_service')
  return tx`select id, name from app.list_academies() where name like 'Ace%'`
})

console.log('\n=== last 12 turns ===')
for (const t of await svc(ace.id, `select role_acted, left(coalesce(input->>'text',input::text),40) as inp,
    left(coalesce(output->>'reply',output::text),70) as outp, model, prompt_tokens, output_tokens, cached_tokens,
    latency_ms, left(coalesce(error,''),120) as err
  from turn order by created_at desc limit 12`)) {
  // §4.4 — prompt/output/cache-hit. A big prompt at 0% means the stable prefix was billed in full.
  const cache = t.prompt_tokens > 0 ? `${Math.round((t.cached_tokens / t.prompt_tokens) * 100)}% cached` : '—'
  console.log(`${(t.role_acted ?? '?').padEnd(7)} in="${t.inp}" out="${String(t.outp).replace(/\n/g, ' ')}" ${t.latency_ms}ms ${t.prompt_tokens}/${t.output_tokens} ${cache} ${t.err ? 'ERR: ' + t.err : ''}`)
}

console.log('\n=== last 15 messages (Ace) ===')
for (const m of await svc(ace.id, `select direction, status, in_window, template_name, catalog_id, suppressed_reason,
    cost_paise, left(replace(coalesce(body,''),E'\\n',' '),90) as body, queued_at
  from message order by queued_at desc limit 15`)) {
  console.log(`${m.direction.padEnd(8)} ${String(m.status).padEnd(9)} win=${m.in_window} tpl=${m.template_name ?? '-'} cat=${m.catalog_id ?? '-'} sup=${m.suppressed_reason ?? '-'} ${m.cost_paise ?? 0}p  "${m.body}"`)
}

console.log('\n=== suppression tally ===')
for (const r of await svc(ace.id, `select suppressed_reason, count(*)::int n from message where suppressed_reason is not null group by 1 order by 2 desc`)) {
  console.log(`  ${r.suppressed_reason}: ${r.n}`)
}

console.log('\n=== jobs by status ===')
for (const r of await sql.begin(async (tx) => { await tx.unsafe('set local role cm_service'); return tx`select kind, status, count(*)::int n from job group by 1,2 order by 3 desc limit 20` })) {
  console.log(`  ${r.kind.padEnd(26)} ${r.status.padEnd(9)} ${r.n}`)
}
console.log('\n=== job failures ===')
for (const r of await sql.begin(async (tx) => { await tx.unsafe('set local role cm_service'); return tx`select kind, left(coalesce(last_error,''),160) e from job where status='failed' limit 8` })) {
  console.log(`  ${r.kind}: ${r.e}`)
}
await sql.end({ timeout: 5 })

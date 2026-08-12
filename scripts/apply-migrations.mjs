// Applies supabase/migrations/*.sql in filename order as the migration role.
//   node scripts/apply-migrations.mjs            # all files
//   node scripts/apply-migrations.mjs 0004 0005  # only files whose name contains one of these
import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const envText = fs.readFileSync(path.join(root, '.env.local'), 'utf8')
const env = Object.fromEntries(
  envText
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
)

const dir = path.join(root, 'supabase', 'migrations')
const only = process.argv.slice(2)
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.sql'))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .sort()

const sql = postgres(env.MIGRATION_DATABASE_URL, {
  ssl: 'require',
  max: 1,
  prepare: false,
  connect_timeout: 30,
  onnotice: () => {},
})

let failed = 0
for (const f of files) {
  const body = fs.readFileSync(path.join(dir, f), 'utf8')
  process.stdout.write(`${f} ... `)
  try {
    await sql.unsafe(body)
    console.log('ok')
  } catch (e) {
    failed++
    console.log('FAILED')
    console.log('   ' + String(e.message).split('\n').slice(0, 6).join('\n   '))
    if (e.position) {
      const p = Number(e.position)
      console.log('   near: ' + JSON.stringify(body.slice(Math.max(0, p - 220), p + 220)))
    }
  }
}
await sql.end({ timeout: 5 })
console.log(failed ? `\n${failed} file(s) failed` : '\nall migrations applied')
process.exit(failed ? 1 : 0)

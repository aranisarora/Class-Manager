/**
 * db-push — apply `supabase/migrations/*.sql` in filename order.
 *
 * The migrations are DDL: they create schemas, roles, tables and policies, and
 * they must run as the role that connects, not as one of the session roles the
 * runtime switches into. So this deliberately does NOT go through
 * `lib/db.ts::withSession` — it opens its own pool on `DATABASE_URL` and sends
 * each file as one `sql.unsafe(...).simple()` call. Nothing is split on `;`:
 * every file is full of dollar-quoted function bodies and DO blocks, and a
 * naive splitter would shred them.
 *
 *   npm run db:push
 *   MIGRATION_DATABASE_URL=postgresql://... npm run db:push   # privileged role
 *
 * Every file is written to be re-runnable, so a second push is a no-op that
 * still exits 0.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { c, loadEnvFiles, pgErrorLines } from './_env'

loadEnvFiles()

const DIR = resolve(process.cwd(), 'supabase', 'migrations')
const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? ''

if (!url) {
  console.error(c.red('DATABASE_URL is not set (looked in the environment, .env.local, .env).'))
  process.exit(1)
}
if (!existsSync(DIR)) {
  console.error(c.red(`No migrations directory at ${DIR}`))
  process.exit(1)
}

const files = readdirSync(DIR)
  .filter((f) => f.toLowerCase().endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, 'en'))

if (files.length === 0) {
  console.error(c.red(`No .sql files in ${DIR}`))
  process.exit(1)
}

const notices: string[] = []
const sql = postgres(url, {
  max: 1,
  prepare: false,
  ssl: /sslmode=disable/.test(url) ? false : 'require',
  connect_timeout: 30,
  idle_timeout: 20,
  onnotice: (n) => notices.push(String(n?.message ?? n)),
})

const target = (() => {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`
  } catch {
    return 'the configured database'
  }
})()

console.log()
console.log(`${c.bold('db push')} ${c.dim('·')} ${files.length} file${files.length === 1 ? '' : 's'}`)

let applied = 0
let failed = 0
let skipped = 0
let unreachable = false

try {
  const rows = (await sql.unsafe(
    'select current_user as u, current_database() as d',
  )) as unknown as Record<string, unknown>[]
  console.log(c.dim(`target  ${target} as ${String(rows[0]?.u ?? 'unknown role')}`))
  console.log(c.dim('source  supabase/migrations'))
  console.log()

  for (const file of files) {
    if (failed > 0) {
      skipped += 1
      console.log(`  ${c.dim('skip')}  ${file} ${c.dim('(blocked by an earlier failure)')}`)
      continue
    }
    const text = readFileSync(resolve(DIR, file), 'utf8')
    const lines = text.split('\n').length
    notices.length = 0
    const started = performance.now()
    try {
      await sql.unsafe(text).simple()
      const ms = Math.round(performance.now() - started)
      const noticed = notices.length
        ? c.dim(`  ${notices.length} notice${notices.length === 1 ? '' : 's'}`)
        : ''
      console.log(
        `  ${c.green('ok')}    ${file.padEnd(26)} ${c.dim(`${String(lines).padStart(4)} lines`)} ${c.dim(
          `${String(ms).padStart(6)} ms`,
        )}${noticed}`,
      )
      applied += 1
    } catch (e) {
      failed += 1
      console.log(`  ${c.red('FAIL')}  ${file}`)
      for (const line of pgErrorLines(e, text)) console.log(`        ${c.red(line)}`)
      if ((e as { code?: string })?.code === '42501') {
        console.log(
          `        ${c.yellow(
            'this role cannot run this DDL — re-run with MIGRATION_DATABASE_URL pointing at a role that owns the schema',
          )}`,
        )
      }
    }
  }
} catch (e) {
  unreachable = true
  console.log(`  ${c.red('FAIL')}  could not connect to ${target}`)
  for (const line of pgErrorLines(e)) console.log(`        ${c.red(line)}`)
} finally {
  await sql.end({ timeout: 5 }).catch(() => {})
}

const bad = failed > 0 || unreachable
console.log()
console.log(
  `${bad ? c.red('x') : c.green('done')} ${[
    `${applied} applied`,
    failed ? c.red(`${failed} failed`) : '',
    skipped ? `${skipped} skipped` : '',
  ]
    .filter(Boolean)
    .join(c.dim(' · '))}`,
)
console.log()

process.exit(bad ? 1 : 0)

/**
 * q — ask the database a question, as the service role, with the tenant GUC set.
 *
 *   node scripts/q.mjs "select * from message order by queued_at desc limit 5"
 *   node scripts/q.mjs --academy "Baseline" "select id, name from class"
 *   node scripts/q.mjs --json "select * from tally_line"
 *   node scripts/q.mjs --file ./some-query.sql
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * DRIVING.md's second rule is "a green tool result is not evidence — check the
 * database", and until now there was no way to do that without writing a
 * throwaway script. Every driving session re-derived the same forty lines of
 * postgres.js boilerplate (the pooler needs `ssl: 'require'` and
 * `prepare: false`, and omitting either fails *silently* under `tsx -e`), and a
 * harness step that costs forty lines is a step that gets skipped.
 *
 * It runs as `cm_service` deliberately. This is an evidence tool, not a product
 * path: its whole job is to see what the tenant's own RLS session might have
 * been refused, because a refusal that reads as an empty result is R7 and is the
 * single most common way a bad run looks like a good one. Use `--role readonly`
 * with `--as <contactId>` when you want to see what a *person* can see.
 */
import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'

const root = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..',
)
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(root, '.env.local'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const argv = process.argv.slice(2)
function flag(name, fallback = '') {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i === -1) return fallback
  const a = argv[i]
  if (a.includes('=')) {
    argv.splice(i, 1)
    return a.slice(a.indexOf('=') + 1)
  }
  const v = argv[i + 1] ?? fallback
  argv.splice(i, 2)
  return v
}
const has = (name) => {
  const i = argv.indexOf(`--${name}`)
  if (i === -1) return false
  argv.splice(i, 1)
  return true
}

const academyArg = flag('academy')
const asContact = flag('as')
const role = flag('role', 'service')
const file = flag('file')
const asJson = has('json')
/** Column cap. 60 keeps a wide table readable; raise it when the value IS the evidence. */
const width = Number(flag('w', '60')) || 60
const query = file ? fs.readFileSync(file, 'utf8') : argv.join(' ')

if (!query.trim()) {
  console.error('usage: node scripts/q.mjs [--academy <id|name>] [--as <contactId>] [--role service|readonly|user] [--json] "<sql>"')
  process.exit(2)
}

const sql = postgres(env.DATABASE_URL, {
  ssl: 'require',
  max: 2,
  prepare: false,
  onnotice: () => {},
})

/** Resolve `--academy` by id or by a name prefix, so I can type "Baseline". */
async function resolveAcademy(tx, arg) {
  if (!arg) return null
  if (/^[0-9a-f-]{36}$/i.test(arg)) return arg
  // Tables live in `public`; the `app` schema holds the functions. `academy` itself is
  // RLS-scoped to the tenant GUC — which is not set yet — so the only way to enumerate
  // tenants is `app.list_academies()`, the same door the emulator's own tray uses.
  const rows = await tx.unsafe(
    `select id, name from app.list_academies() where name ilike '${arg.replace(/'/g, "''")}%' order by name limit 2`,
  )
  if (rows.length === 0) throw new Error(`no academy matching ${JSON.stringify(arg)}`)
  if (rows.length > 1) throw new Error(`ambiguous academy ${JSON.stringify(arg)}: ${rows.map((r) => r.name).join(', ')}`)
  return rows[0].id
}

try {
  const out = await sql.begin(async (tx) => {
    // **Resolve first, THEN drop the role.** This used to `set local role` before
    // looking anything up, so with `--role user` the contact lookup was itself
    // RLS-refused — no GUCs were set yet — and `--as <id> --role user` died with
    // "no contact <id>" for every id in the database. The only combination that
    // ever ran was the one that keeps the service role, which is precisely the
    // combination that does NOT show what a person can see. A harness that
    // answers the wrong question and looks like it answered the right one is R7
    // wearing a test harness's clothes, same as `rls-check` skipping its hardest
    // sections and still printing "0 failed".
    // Resolution needs the service role: `app.list_academies()` and `contact`
    // are both closed to the login role, and to `cm_user` without GUCs.
    await tx.unsafe('set local role cm_service')
    const academyId = await resolveAcademy(tx, academyArg)
    // Set immediately: `contact` is tenant-scoped even for the service role, so
    // the lookup below finds nothing until `app.academy_id` is in place.
    if (academyId) await tx`select set_config('app.academy_id', ${academyId}, true)`
    if (asContact) {
      // Mirrors what lib/db.ts sets for a person-scoped session, so `--as` shows
      // what that contact's own policies allow rather than what exists.
      //
      // `contact` is tenant-scoped even for the service role, so a bare `--as`
      // with no `--academy` can only find the contact by trying each tenant in
      // turn — which is what `drive` does too. Without this, `--as` alone (the
      // form DRIVING.md documents) reported "no contact <id>" for every id.
      const lit = asContact.replace(/'/g, "''")
      const find = async () =>
        (
          await tx.unsafe(
            `select c.id, c.person_id, c.academy_id from public.contact c where c.id = '${lit}'`,
          )
        )[0]
      let ct = await find()
      if (!ct && !academyId) {
        for (const a of await tx.unsafe('select id from app.list_academies()')) {
          await tx`select set_config('app.academy_id', ${a.id}, true)`
          ct = await find()
          if (ct) break
        }
      }
      if (!ct) throw new Error(`no contact ${asContact}`)
      await tx`select set_config('app.academy_id', ${ct.academy_id}, true)`
      await tx`select set_config('app.person_id', ${ct.person_id}, true)`
      await tx`select set_config('app.contact_id', ${ct.id}, true)`
    }
    // Last, so everything above ran with enough privilege to resolve, and the
    // query itself runs with exactly the privilege being asked about.
    await tx.unsafe(`set local role cm_${role}`)
    return tx.unsafe(query)
  })

  const rows = Array.isArray(out) ? out : [out]
  if (asJson) {
    console.log(JSON.stringify(rows, null, 2))
  } else if (rows.length === 0) {
    console.log('(0 rows)')
  } else {
    const cols = Object.keys(rows[0])
    const cell = (v) =>
      v === null || v === undefined
        ? '·'
        : typeof v === 'object'
          ? JSON.stringify(v)
          : String(v).replace(/\n/g, '\\n')
    const w = cols.map((c) => Math.min(width, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))))
    console.log(cols.map((c, i) => c.padEnd(w[i])).join('  '))
    console.log(w.map((n) => '-'.repeat(n)).join('  '))
    for (const r of rows) console.log(cols.map((c, i) => cell(r[c]).slice(0, width).padEnd(w[i])).join('  '))
    console.log(`(${rows.length} row${rows.length === 1 ? '' : 's'})`)
  }
} catch (e) {
  console.error('ERROR:', e?.code ? `${e.code} ${e.message}` : String(e?.message ?? e))
  if (e?.detail) console.error('detail:', e.detail)
  if (e?.hint) console.error('hint:', e.hint)
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}

/**
 * q — ask the database a question, as the service role, with the tenant GUC set.
 *
 *   node scripts/q.mjs "select * from message order by queued_at desc limit 5"
 *   node scripts/q.mjs --academy "Baseline" "select id, name from class"
 *   node scripts/q.mjs --all "select status, count(*) from payment group by 1"
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
 *
 * `cm_service` DOES NOT BYPASS RLS, AND THIS TOOL USED TO PRETEND IT DID
 * -----------------------------------------------------------------------------
 * Every `cm_service` policy in 0003 is `academy_id = app.academy_id()`. The
 * service role is exempt from the *person* half of RLS — `app.is_admin()`,
 * `app.my_account_ids()`, `app.sees_money()` — and from nothing else. So with no
 * `--academy`, `app.academy_id()` is null, `academy_id = null` evaluates to NULL,
 * and **every tenant-scoped table reads empty**.
 *
 * That is not a nuisance, it is R7 in the one tool the method uses to falsify
 * itself. `select count(*) from payment` answered `0` for a database holding
 * seven payments, and `select count(*) from tally_line` answered `0` for
 * seventy-eight — with no error, no warning, and a row count that reads exactly
 * like a fact about the world. The natural cross-tenant question ("has this
 * product ever written a payment?") is precisely the question it answers wrongly,
 * and the previous handoff had written down the opposite ("defaults to
 * --role service, which bypasses RLS"), which teaches the next reader to trust it.
 *
 * `job` hid this for as long as it did because `job_cm_service_all` is the one
 * service policy whose qual is `true` — jobs are cross-tenant by nature — so the
 * first few questions anyone asks come back correctly populated.
 *
 * Two fixes, because the trap has two halves:
 *   - **Naming a tenant-scoped table with no tenant set now warns**, loudly, on
 *     stderr, before the rows print. The list of such tables is read out of
 *     `pg_policies` at run time rather than hardcoded, so a table added later is
 *     covered without anybody remembering to come back here.
 *   - **`--all` makes the cross-tenant question a first-class one**: it runs the
 *     query once per academy with that tenant's GUC set and labels every row with
 *     the academy it came from. This is what the reader wanted when they left
 *     `--academy` off.
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
/** Run the query once per academy, tagging each row with the tenant it came from. */
const allTenants = has('all')
/** Column cap. 60 keeps a wide table readable; raise it when the value IS the evidence. */
const width = Number(flag('w', '60')) || 60
const query = file ? fs.readFileSync(file, 'utf8') : argv.join(' ')

if (!query.trim()) {
  console.error('usage: node scripts/q.mjs [--academy <id|name>] [--all] [--as <contactId>] [--role service|readonly|user] [--json] "<sql>"')
  process.exit(2)
}
if (allTenants && academyArg) {
  console.error('--all and --academy contradict each other: pick one tenant, or sweep them all.')
  process.exit(2)
}
if (allTenants && asContact) {
  console.error('--all and --as contradict each other: a contact belongs to exactly one tenant.')
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

/**
 * Which tables the service role can only see through a tenant GUC.
 *
 * Read from `pg_policies` rather than written down here, because a hardcoded
 * list is a promise to update it and nobody ever does — and the failure mode of
 * a stale list is the silent zero this whole warning exists to stop. A table is
 * tenant-scoped if its `cm_service` policy mentions `app.academy_id()`; the one
 * that does not is `job`, whose qual is `true`.
 */
async function tenantScopedTables(tx) {
  const rows = await tx.unsafe(`
    select distinct tablename
      from pg_policies
     where schemaname = 'public'
       and roles::text like '%cm_service%'
       and qual like '%app.academy_id()%'
  `)
  return rows.map((r) => r.tablename)
}

/** Does the SQL name any of them? Word-boundary, so `payment` does not match `repayments`. */
function tablesNamedIn(sqlText, tables) {
  // Strip string literals first: a table name inside quoted text is data, not a
  // reference, and flagging `where reason = 'payment received'` would train the
  // reader to ignore the warning — which is the only way this fix can fail.
  const bare = sqlText.replace(/'(?:[^']|'')*'/g, "''")
  return tables.filter((t) => new RegExp(`\\b${t}\\b`, 'i').test(bare))
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
    // The tenant-scoped table list is read while still `cm_service`, because
    // `pg_policies` is readable by anyone but the answer is about this role.
    const scoped = await tenantScopedTables(tx)

    if (allTenants) {
      // One pass per tenant, each with that tenant's GUC. The role is dropped
      // and restored around every pass: the query runs at exactly the privilege
      // being asked about, and the next `set_config` needs `cm_service` back.
      const academies = await tx.unsafe('select id, name from app.list_academies() order by name')
      const swept = []
      for (const a of academies) {
        await tx`select set_config('app.academy_id', ${a.id}, true)`
        await tx.unsafe(`set local role cm_${role}`)
        const part = await tx.unsafe(query)
        await tx.unsafe('set local role cm_service')
        for (const r of part) swept.push({ academy: a.name, ...r })
      }
      return { rows: swept, warned: null, sweptCount: academies.length }
    }

    // Warn BEFORE the rows print, and only when the answer is guaranteed empty:
    // with no tenant GUC, a tenant-scoped table cannot return a single row, so
    // this is a statement of fact rather than a guess about intent.
    const named = academyId ? [] : tablesNamedIn(query, scoped)

    // Last, so everything above ran with enough privilege to resolve, and the
    // query itself runs with exactly the privilege being asked about.
    await tx.unsafe(`set local role cm_${role}`)
    return { rows: await tx.unsafe(query), warned: named, sweptCount: 0 }
  })

  if (out.warned && out.warned.length > 0) {
    console.error(
      `WARNING: no --academy, so ${out.warned.join(', ')} ${out.warned.length === 1 ? 'is' : 'are'} ` +
      `filtered to nothing by RLS.\n` +
      `         cm_service is exempt from the person half of RLS, not the tenant half:\n` +
      `         every service policy is \`academy_id = app.academy_id()\`, and that is null here.\n` +
      `         Any zero below is the GUC, not the world. Use --academy <name> or --all.`,
    )
  }
  if (out.sweptCount) console.error(`(swept ${out.sweptCount} academies)`)

  const rows = Array.isArray(out.rows) ? out.rows : [out.rows]
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

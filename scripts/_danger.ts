/**
 * scripts/_danger.ts — the guard the CLI never had.
 *
 * `lib/ops-guard.ts` draws the line between the emulator's read half and its
 * fabricating half, and every HTTP handler that destroys or invents asks it
 * first. That protects the CONSOLE. It does not protect the terminal, because a
 * script does not make an HTTP request — it imports `lib/seed` and calls the
 * function directly, and no guard sits between the import and the table:
 *
 *   drive reset         → resetWorld()   drive.ts, straight from the import
 *   drive seed --stage  → seedStage()    drive.ts, straight from the import
 *   npm run seed        → seedWorld()    seed.ts, straight from the import
 *
 * `resetWorld` enumerates every academy `app.list_academies()` returns — real
 * tenants included, not just the fixture ids — deletes each one so every tenant
 * table cascades, and then empties `job`, `sim_fault` and `sender`. That last
 * one takes the row holding the live Cloud credentials with it. `drive reset`
 * prints "world wiped" and means it.
 *
 * None of that was a hazard while the only database a developer could reach was
 * their own. It became one the moment `.env.local` began pointing at the project
 * that also serves production, which is the normal state of this repo now: the
 * app is hosted, the scripts are not, and both read the same `DATABASE_URL`.
 *
 * WHAT THIS ASKS, AND WHY THAT QUESTION
 * -----------------------------------------------------------------------------
 * Not "is this production?" — nothing in the environment answers that honestly.
 * `APP_BASE_URL` is localhost in this very checkout while `DATABASE_URL` points
 * at the live project, so the two disagree and the wrong one is the one a guard
 * would naturally read. Hostname matching is worse: it fails open on every URL
 * nobody thought of.
 *
 * The question is **"does this database hold a business that is not a toy?"**,
 * which is the thing actually being protected and is answerable from the data
 * itself. 0030 gave `academy.is_sandbox` exactly that meaning, and it defaults
 * to false — so a tenant is real unless something deliberately marked it scratch.
 * An empty database, or one holding only sandbox tenants, is safe by that test
 * and stays as convenient as it was.
 *
 * FAILING CLOSED, INCLUDING ON ITS OWN FAILURE
 * -----------------------------------------------------------------------------
 * Every uncertainty refuses. A connection that drops, a database without 0030,
 * an academy whose row will not read — none of them mean "go ahead", because the
 * cost of a wrong "yes" here is the whole database and the cost of a wrong "no"
 * is typing one flag. `lookupSandboxAcademy` in `lib/ops-guard.ts` makes the same
 * trade for the same reason; this is that judgement moved to the terminal.
 *
 * THE OVERRIDE IS DELIBERATELY UGLY
 * -----------------------------------------------------------------------------
 * `--force-on-real-data` is long, unmemorable and says what it does. Wiping a
 * scratch tenant is routine, so the guard must not be a wall; wiping a real one
 * should require a sentence you cannot type by muscle memory or paste from an
 * old shell line. It is not `-f`, and it is not `--force`, on purpose.
 */

import { c } from './_env'

/** What a refused command needs to say. Separated so the caller controls exit. */
export type RealTenant = { id: string; name: string }

/**
 * Every academy in this database that is not marked `is_sandbox`.
 *
 * THE SESSION PIN IS THE TRICK, and it is the same one `lib/ops-guard.ts`
 * documents at length: `academy_cm_service_all` is `using (id = app.academy_id())`
 * — keyed on `id`, not `academy_id` — so a service session sees exactly one
 * academy row, the one it is pinned to. Enumerating therefore takes two steps:
 * `app.list_academies()` (security definer) for the ids, then one pinned read per
 * id for the flag. A single unpinned `select * from academy` returns zero rows
 * with no error, which would read as "no real tenants here" and wave the command
 * through — the exact inversion this file exists to prevent.
 */
async function realTenants(): Promise<RealTenant[]> {
  const { withSession } = await import('@/lib/db')
  const { worldAcademyIds } = await import('@/lib/seed')

  const ids = await worldAcademyIds({ refresh: true })
  const real: RealTenant[] = []

  for (const id of ids) {
    const rows = await withSession({ role: 'service', academyId: id }, async (tx) =>
      (await tx`select name, is_sandbox from academy where id = ${id}::uuid`) as unknown as {
        name: string
        is_sandbox: boolean | null
      }[],
    )
    const row = rows[0]
    // A row that will not read is not proven to be a toy. Named as unreadable so
    // the operator can tell "I could not check this" from "this is your business".
    if (!row) {
      real.push({ id, name: '(could not be read — treated as real)' })
      continue
    }
    if (row.is_sandbox !== true) real.push({ id, name: String(row.name ?? '(unnamed)') })
  }

  return real
}

/**
 * Refuse `command` when this database holds a business that is not a toy.
 *
 * Returns normally when the command may proceed — an empty database, a database
 * of sandbox tenants, or an operator who typed the override. Exits otherwise, so
 * a caller cannot forget to check the result.
 */
export async function refuseOnRealData(
  command: string,
  o: { force: boolean; what: string },
): Promise<void> {
  let real: RealTenant[]
  try {
    real = await realTenants()
  } catch (e) {
    // The check itself failing is the one case most likely to be waved through by
    // a guard written in a hurry, so it is spelled out. Not knowing is refusing.
    console.error()
    console.error(c.red(`x  ${command} refused — could not check what is in this database.`))
    console.error(`   ${c.dim(e instanceof Error ? e.message : String(e))}`)
    console.error(`   ${c.dim('A guard that cannot see the data does not get to assume it is scratch.')}`)
    console.error()
    process.exit(2)
  }

  if (real.length === 0) return

  if (o.force) {
    console.error()
    console.error(c.yellow(`!  ${command} is running against ${real.length} REAL business${real.length > 1 ? 'es' : ''} because --force-on-real-data was given:`))
    for (const t of real) console.error(c.yellow(`     ${t.name}  ${c.dim(t.id)}`))
    console.error(c.yellow(`   ${o.what}`))
    console.error()
    return
  }

  console.error()
  console.error(c.red(`x  ${command} refused — this database holds ${real.length} business${real.length > 1 ? 'es' : ''} not marked as a sandbox:`))
  for (const t of real) console.error(c.red(`     ${t.name}  ${c.dim(t.id)}`))
  console.error()
  console.error(`   ${o.what}`)
  console.error()
  console.error(`   ${c.dim('DATABASE_URL points at whatever it points at — check it before overriding.')}`)
  console.error(`   ${c.dim(`If you mean it: ${command} --force-on-real-data`)}`)
  console.error()
  process.exit(2)
}

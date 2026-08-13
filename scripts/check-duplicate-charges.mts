/**
 * check-duplicate-charges — has any family been billed twice for one thing?
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * 0023 makes a duplicate recurring charge impossible going forward: `dedupe_key`
 * is built from ids and carries a unique index. But it deliberately did NOT
 * rewrite the charges that were already there. Sixteen (player, class, period)
 * triples in the shared world carry two identical charges — ₹32,800 — because
 * `lib/seed.ts` composed its descriptions with "-" and
 * `lib/jobs/handlers/money.ts` with "—", and the guard that was supposed to stop
 * it compared those two sentences.
 *
 * A migration must not silently delete money. Which of a credit note, a refund
 * and a write-off is right is a business decision, and erasing the rows would
 * erase the evidence that it needs to be made. So the duplicates survive, keyless
 * and visible, and this script is what keeps them visible.
 *
 * WHAT IT CHECKS, AND WHY IT IS TWO CHECKS
 * -----------------------------------------------------------------------------
 *   LEGACY   duplicates among rows written BEFORE 0023 (no `dedupe_key`). These
 *            are history. They are reported, and they do not fail the run — a
 *            check that always fails is a check people learn to scroll past.
 *   NEW      duplicates among rows written AFTER 0023, i.e. any pair sharing a
 *            (player, class, period, kind) where both carry keys. The index makes
 *            this impossible, so if it ever prints, either the index was dropped
 *            or a writer computed the key wrongly — and it FAILS.
 *
 * The second check is the one with teeth. It is written to be independent of the
 * index rather than a restatement of it: it re-derives what "the same charge"
 * means from the ids themselves, so a writer that computes a WRONG key is caught
 * too. An index can only enforce the rule it was given.
 */
import postgres from 'postgres'
import fs from 'node:fs'
import path from 'node:path'

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

const sql = postgres(env.DATABASE_URL as string, {
  ssl: 'require',
  max: 2,
  prepare: false,
  onnotice: () => {},
})

type Dup = {
  academy: string
  holder: string
  player: string
  period: string
  kind: string
  copies: number
  unit: string
  overcharge: string
  keyed: number
}

/**
 * Tenant-scoped tables read empty for `cm_service` with no `app.academy_id`, so
 * this sweeps academy by academy — the same trap `scripts/q.mjs` warns about.
 * A cross-tenant question answered with a silent zero is exactly how a money bug
 * survives a check that claims to look for it.
 */
async function run(): Promise<number> {
  const rows: Dup[] = []
  await sql.begin(async (tx) => {
    await tx.unsafe('set local role cm_service')
    const academies = await tx.unsafe('select id, name from app.list_academies() order by name')
    for (const a of academies) {
      await tx`select set_config('app.academy_id', ${a.id}, true)`
      const found = await tx.unsafe(`
        select pe.full_name          as holder,
               coalesce(pp.full_name, '—') as player,
               to_char(t.period, 'YYYY-MM') as period,
               t.kind,
               count(*)::int        as copies,
               min(t.amount)::text  as unit,
               ((count(*) - 1) * min(t.amount))::text as overcharge,
               count(t.dedupe_key)::int as keyed
          from tally_line t
          join account a on a.id = t.account_id
          join person pe on pe.id = a.holder_person_id
          left join player pl on pl.id = t.player_id
          left join person pp on pp.id = pl.person_id
         where t.kind in ('monthly', 'term')
         group by t.account_id, t.player_id, t.class_id, t.period, t.kind, pe.full_name, pp.full_name
        having count(*) > 1
         order by 1`)
      for (const f of found) rows.push({ academy: a.name, ...(f as Omit<Dup, 'academy'>) })
    }
  })

  const legacy = rows.filter((r) => r.keyed <= 1)
  const fresh = rows.filter((r) => r.keyed > 1)

  if (rows.length === 0) {
    console.log('check-duplicate-charges: no family is billed twice for one thing.')
    return 0
  }

  if (legacy.length) {
    console.log(`\nLEGACY — billed twice before 0023, left visible rather than deleted (${legacy.length}):`)
    let total = 0
    for (const r of legacy) {
      total += Number(r.overcharge)
      console.log(
        `  ${r.academy} · ${r.holder} · ${r.player} · ${r.period} ${r.kind} ` +
        `· ${r.copies}× ₹${r.unit} · overcharged ₹${r.overcharge}`,
      )
    }
    console.log(`  ₹${total.toFixed(2)} overcharged in total. A business decides between a credit note,`)
    console.log('  a refund and a write-off — this script only makes sure nobody forgets it is owed.')
  }

  if (fresh.length) {
    console.error(`\nFAIL — ${fresh.length} duplicate charge(s) written WITH keys, which the index should`)
    console.error('       have refused. Either tally_line_dedupe_key is missing, or a writer is')
    console.error('       computing a key that does not match billingKey.* in lib/billing-keys.ts.')
    for (const r of fresh) {
      console.error(`  ${r.academy} · ${r.holder} · ${r.player} · ${r.period} ${r.kind} · ${r.copies} copies`)
    }
    return 1
  }

  console.log('\nOK — no duplicate charge has been written since 0023.')
  return 0
}

try {
  process.exitCode = await run()
} catch (e) {
  console.error('check-duplicate-charges: ERROR', (e as Error)?.message ?? e)
  process.exitCode = 1
} finally {
  await sql.end({ timeout: 5 })
}

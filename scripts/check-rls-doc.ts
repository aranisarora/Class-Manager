/**
 * check-rls-doc — the prompt's permission matrix, checked against pg_policies.
 *
 *   npx tsx scripts/check-rls-doc.ts        (npm run check:rls-doc)
 *
 * WHY
 * -----------------------------------------------------------------------------
 * `SCHEMA_DOC` now carries a grid of who may select, insert, update and delete
 * each table. It is there because policies are invisible from inside a session:
 * the model could only find the boundary by crossing it, which costs a refused
 * plan, a re-plan, and a round — and on a hard turn, the rounds budget itself.
 *
 * But a grid in a string and the policies in `0003_rls.sql` are two authors of
 * one truth, and ARCHITECTURE.md's trap list says every such pair has drifted.
 * A wrong cell is worse than no cell: the model plans confidently around a
 * permission that is not there, and an UPDATE it may not make matches nothing
 * and says nothing. So the grid reads the database rather than a memory of it.
 *
 * WHAT IT CHECKS — structure only, in both directions:
 *
 *   - Every table in the grid exists and has RLS enabled.
 *   - `-` in a cell means NO cm_user/cm_readonly policy for that verb, and no
 *     policy for that verb means `-` in the cell. This is the class that costs
 *     the rounds, and it is exactly decidable.
 *   - `admin` in a cell <-> `is_admin` in the policy expression. Likewise
 *     `coach` <-> my_coach_id / my_session_ids, and `family` <-> my_player_ids /
 *     my_account_ids.
 *   - A cell of exactly `all` must have no role helper in the expression at all
 *     — the academy scope and nothing else.
 *   - A policy that keys on the person or the contact (`person_id()`,
 *     `contact_id()`) must have a cell that says so. One direction only: a cell
 *     may say "their own row" about a coach id without naming the GUC.
 *   - Every table with a user-facing policy appears in the grid, and every
 *     table with none is either in the grid's `-` row or is runtime-only
 *     infrastructure the model never sees.
 *   - The four views the grid makes a claim about really do run the way it says:
 *     security_invoker for the three that inherit the reader, definer for
 *     coach_public, which is the whole reason it exists.
 *
 * WHAT IT DOES NOT CHECK: prose. Whether "their own family's" is the right
 * description of a five-clause EXISTS is a reading, not a query — same rule as
 * check-schema-doc. What is machine-decidable is checked here; the rest is
 * reviewed by a human, which is what the second direction of each check is for.
 *
 * Exit code 1 on any divergence, so it can gate a commit.
 */
import { loadEnvFiles, c } from './_env'

loadEnvFiles()

const { SCHEMA_DOC } = await import('@/lib/agent/schema-doc')
const { withSession } = await import('@/lib/db')

/**
 * Tables with no user-facing policy that the grid deliberately does not name.
 * The emulator clock, the fault injector and the tick ledger are the harness's
 * own furniture: the model has no session in which they exist, so listing them
 * would spend cached bytes teaching it about a wall it cannot reach. Everything
 * else with no policy MUST be in the grid's `-` row, because that is a wall it
 * reaches by trying.
 */
const RUNTIME_ONLY = new Set(['sim_clock', 'sim_fault', 'tick_runs'])

/** The verbs, in the grid's column order. */
const VERBS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as const
type Verb = (typeof VERBS)[number]

/**
 * The role vocabulary. Each entry is a word the grid may use in a cell, the
 * expressions that must back it, and the expressions that merely satisfy it.
 *
 * Both directions are enforced on `helpers`: the word without the expression is
 * a promise the database will not keep, and the expression without the word is
 * a permission the model is never told it has.
 *
 * `also` is one-directional, and `my_session_ids` is why it exists. That
 * function is SECURITY DEFINER and unions three branches — every session for an
 * admin, the assigned ones for a coach, the enrolled ones for a family — so a
 * policy reading `id = any(app.my_session_ids())` backs a "coach" cell AND a
 * "family" cell while naming neither role. Demanding both words from it would
 * make the checker insist `attendance.insert` mentions families, which it must
 * not: there the same helper sits behind `my_coach_id() is not null`.
 */
const ROLE_WORDS: { word: RegExp; label: string; helpers: string[]; also: string[] }[] = [
  { word: /\badmin\b/, label: 'admin', helpers: ['is_admin'], also: [] },
  { word: /\bcoach(es)?\b/, label: 'coach', helpers: ['my_coach_id'], also: ['my_session_ids'] },
  {
    word: /\bfamil(y|ies)\b/,
    label: 'family',
    helpers: ['my_player_ids', 'my_account_ids'],
    also: ['my_session_ids'],
  },
]

/** Keys on the person themselves — checked one way only (see the header). */
const SELF_HELPERS = ['person_id()', 'contact_id()']
const SELF_WORDS = /\b(own|themselves|theirs|self)\b/

/** Views the grid makes a runtime claim about: true = security_invoker. */
const VIEW_CLAIMS: { schema: string; name: string; invoker: boolean }[] = [
  { schema: 'public', name: 'session_coverage', invoker: true },
  { schema: 'app', name: 'session_roster', invoker: true },
  { schema: 'public', name: 'unmarked_billable_session', invoker: true },
  { schema: 'public', name: 'session_detail', invoker: true },
  { schema: 'public', name: 'class_roster', invoker: true },
  { schema: 'public', name: 'class_offering', invoker: true },
  { schema: 'public', name: 'account_standing', invoker: true },
  { schema: 'public', name: 'account_ledger', invoker: true },
  { schema: 'public', name: 'coach_pay', invoker: true },
  { schema: 'public', name: 'person_directory', invoker: true },
  // The exceptions, and the block says so: every coach in the business, and the
  // whole class-to-coach map, to anybody who asks — with no pay column on
  // either to leak. They are definer BECAUSE `coach` and `class_coach` are
  // own-row-only, and they carry full_name because a caller who has to join
  // `person` for a name puts that restriction straight back on and empties the
  // result without erroring.
  { schema: 'public', name: 'coach_public', invoker: false },
  { schema: 'public', name: 'coach_directory', invoker: false },
  { schema: 'public', name: 'class_coach_public', invoker: false },
]

type Cell = { text: string; none: boolean }
type Row = { tables: string[]; cells: Record<Verb, Cell>; line: number }

/**
 * The grid is the only markdown table in the block whose header row is
 * `| table | select | ... |`. Parsed positionally rather than by name so a
 * reordered column is a divergence rather than a silent mismatch.
 */
function parseGrid(doc: string): Row[] {
  const lines = doc.split('\n')
  const header = lines.findIndex((l) => /^\|\s*table\s*\|\s*select\s*\|/i.test(l))
  if (header === -1) return []
  const cols = lines[header]!.split('|').slice(1, -1).map((s) => s.trim().toUpperCase())
  if (cols.slice(1).join(',') !== VERBS.join(',')) {
    throw new Error(`grid columns are ${cols.join(', ')} — expected table, ${VERBS.join(', ')}`)
  }
  const rows: Row[] = []
  for (let i = header + 2; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.startsWith('|')) break
    const parts = line.split('|').slice(1, -1).map((s) => s.trim())
    if (parts.length !== 5) continue
    const cells = {} as Record<Verb, Cell>
    VERBS.forEach((v, n) => {
      const text = parts[n + 1] ?? ''
      cells[v] = { text, none: text === '-' }
    })
    rows.push({
      // `venue · class · class_slot` is one row for three tables that share a shape.
      tables: parts[0]!.split('·').map((s) => s.trim()).filter(Boolean),
      cells,
      line: i + 1,
    })
  }
  return rows
}

const problems: string[] = []

const anyAcademy = await withSession({ role: 'service', academyId: '' }, async (tx) => {
  const rows = (await tx`select id from academy limit 1`) as unknown as { id: string }[]
  return rows[0]?.id ?? null
})

const q = async <T = any>(sql: string): Promise<T[]> =>
  withSession({ role: 'service', academyId: anyAcademy ?? '' }, async (tx) => (await tx.unsafe(sql)) as unknown as T[])

/**
 * One row per (table, verb) the model can reach. `ALL` policies are expanded so
 * a table granted everything in one policy reads the same as four — but the
 * service role's own policies are excluded, because the model never runs as it.
 */
const policies = await q<{ tablename: string; cmd: string; roles: string; expr: string }>(`
  select tablename, cmd, roles::text as roles,
         coalesce(qual,'') || ' ' || coalesce(with_check,'') as expr
    from pg_policies
   where schemaname = 'public'
     and (roles::text like '%cm_user%' or roles::text like '%cm_readonly%')`)

const byTableVerb = new Map<string, string[]>()
for (const p of policies) {
  const verbs: Verb[] = p.cmd === 'ALL' ? [...VERBS] : [p.cmd as Verb]
  for (const v of verbs) {
    const key = `${p.tablename}.${v}`
    byTableVerb.set(key, [...(byTableVerb.get(key) ?? []), p.expr])
  }
}

const realTables = await q<{ relname: string; rls: boolean }>(`
  select c.relname, c.relrowsecurity as rls
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'`)
const rlsOn = new Map(realTables.map((t) => [t.relname, t.rls]))

let grid: Row[] = []
try {
  grid = parseGrid(SCHEMA_DOC)
} catch (e) {
  problems.push(String(e instanceof Error ? e.message : e))
}
if (!grid.length) problems.push('no permission grid found in SCHEMA_DOC — the block that this check exists for is gone')

const documented = new Set<string>()

for (const row of grid) {
  for (const table of row.tables) {
    documented.add(table)
    if (!rlsOn.has(table)) {
      problems.push(`${table} is in the permission grid and is not a table`)
      continue
    }
    if (!rlsOn.get(table)) {
      problems.push(`${table} is in the grid and has RLS DISABLED — every cell in its row is a fiction`)
    }
    for (const verb of VERBS) {
      const cell = row.cells[verb]
      const exprs = byTableVerb.get(`${table}.${verb}`) ?? []
      const expr = exprs.join(' ')
      const where = `${table}.${verb.toLowerCase()} (grid line ${row.line})`

      // The decidable half: does a policy exist at all?
      if (cell.none && exprs.length) {
        problems.push(`${where} is "-" in the grid and a policy exists — the model is told to route away from a write it may make`)
        continue
      }
      if (!cell.none && !exprs.length) {
        problems.push(`${where} says "${cell.text}" and NO policy exists — the model will plan this write and be refused mid-plan`)
        continue
      }
      if (cell.none) continue

      // Role words against the expressions that back them, both directions.
      for (const r of ROLE_WORDS) {
        const inCell = r.word.test(cell.text)
        const backed = [...r.helpers, ...r.also].some((h) => expr.includes(h))
        const named = r.helpers.some((h) => expr.includes(h))
        if (inCell && !backed) {
          problems.push(`${where} says "${r.label}" and the policy has no ${[...r.helpers, ...r.also].join('/')} — the grid promises a permission the database refuses`)
        }
        if (!inCell && named) {
          problems.push(`${where} does not say "${r.label}" and the policy keys on ${r.helpers.join('/')} — a permission nothing tells the model it has`)
        }
      }
      const self = SELF_HELPERS.some((h) => expr.includes(h))
      if (self && !SELF_WORDS.test(cell.text)) {
        problems.push(`${where} keys on the person or contact and the cell never says whose rows those are`)
      }
      if (cell.text === 'all') {
        const scoped = [...ROLE_WORDS.flatMap((r) => [...r.helpers, ...r.also]), ...SELF_HELPERS, 'sees_money'].filter((h) =>
          expr.includes(h),
        )
        if (scoped.length) {
          problems.push(`${where} says "all" and the policy narrows on ${scoped.join(', ')} — "all" must be the academy scope and nothing else`)
        }
      }
    }
  }
}

// The other direction: a table the grid never mentions.
for (const [table] of rlsOn) {
  if (documented.has(table) || RUNTIME_ONLY.has(table)) continue
  const reachable = VERBS.some((v) => byTableVerb.has(`${table}.${v}`))
  problems.push(
    reachable
      ? `${table} has a user-facing policy and is not in the grid at all — the model cannot plan around what it is not shown`
      : `${table} has no user-facing policy and is not in the grid's "-" row — a write the model will attempt and lose a plan to`,
  )
}

const viewOpts = await q<{ nspname: string; relname: string; opts: string | null }>(`
  select n.nspname, c.relname, c.reloptions::text as opts
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind = 'v' and n.nspname in ('public','app')`)
for (const claim of VIEW_CLAIMS) {
  const v = viewOpts.find((r) => r.nspname === claim.schema && r.relname === claim.name)
  if (!v) {
    problems.push(`view ${claim.schema}.${claim.name} is described in SCHEMA_DOC and does not exist`)
    continue
  }
  const invoker = (v.opts ?? '').includes('security_invoker=true')
  if (invoker !== claim.invoker) {
    problems.push(
      claim.invoker
        ? `${claim.schema}.${claim.name} is documented as inheriting the reader and is NOT security_invoker — it shows every reader the same rows`
        : `${claim.schema}.${claim.name} is documented as visible to everybody and IS security_invoker — a coach reads their own row and nothing else through it`,
    )
  }
}

if (!problems.length) {
  console.log(c.green(`\n  The permission grid agrees with pg_policies.\n`))
  process.exit(0)
}

console.log(c.red(`\n  ${problems.length} divergence${problems.length === 1 ? '' : 's'}:\n`))
for (const p of [...new Set(problems)].sort()) console.log(`    ${p}`)
console.log(
  c.dim(
    `\n  Each of these is a round the model spends discovering what it was told wrong.\n` +
      `  Fix lib/agent/schema-doc.ts if the grid is stale, or the migration if the policy is.\n`,
  ),
)
process.exit(1)

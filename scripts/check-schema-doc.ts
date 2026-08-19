/**
 * check-schema-doc — the prompt's schema block, checked against the real schema.
 *
 *   npx tsx scripts/check-schema-doc.ts
 *
 * WHY
 * -----------------------------------------------------------------------------
 * Almost every SQL defect found on 17 Aug 2026 (conversation-rules.md Part 6) was
 * the same defect: `SCHEMA_DOC` said something the database does not say, or did
 * not say something the database enforces. A column that is NOT NULL and unmarked,
 * a view under the wrong schema, a column that does not exist at all — each one
 * produces a statement Postgres refuses, and a plan is one transaction, so one of
 * them takes every correct step beside it down.
 *
 * The block is a hand-maintained string. Its own header says "Changes only when
 * the migrations change", which is a promise a human keeps by remembering — and
 * the record shows it was not kept: `enrollment.active` was documented as a trap
 * forty lines from the signature that invites it, `class.starts_on` was NOT NULL
 * and unmarked for as long as it existed, and the views were listed together
 * while only one of them lives in `app`.
 *
 * So this reads the block and asks the database, in both directions:
 *
 *   - Every table the block names must exist.
 *   - Every column the block names must exist on that table. (A name the model
 *     reads and Postgres rejects is the worst of the three: it is confident and
 *     wrong.)
 *   - Every column marked `!` must really be NOT NULL with no default.
 *   - Every column that IS NOT NULL with no default must be marked `!` — the
 *     direction that actually caused the failures, and the one no reading of the
 *     document can catch, because absence has nothing to point at.
 *   - Every view named must exist under exactly the qualification used.
 *
 * It deliberately does NOT check prose. Nothing here can tell whether a sentence
 * about billing is true; it checks the parts that have a machine-readable answer,
 * which is the half that goes stale silently.
 *
 * Exit code 1 on any divergence, so it can gate a commit.
 */
import { loadEnvFiles, c } from './_env'

loadEnvFiles()

const { SCHEMA_DOC } = await import('@/lib/agent/schema-doc')
const { withSession } = await import('@/lib/db')

/** Columns every tenant table carries, documented once at the top rather than per table. */
const IMPLICIT = new Set(['id', 'created_at', 'academy_id'])

/**
 * Tables the block names but does not render as a signature, and views. Listed
 * so a missing signature is not reported as a missing table.
 */
const PROSE_ONLY = new Set(['sim_clock', 'sim_fault', 'sim_run', 'row_snapshot'])

/**
 * Tables the model has no INSERT policy on, so a required column it never
 * supplies is not a defect — it is a column the runtime fills on a path the
 * model does not take. `SCHEMA_DOC` documents these to be READ, and marking
 * their columns `!` would teach a requirement that never applies to anything the
 * model writes. Kept in step with the block's own "what you may write" list;
 * they are still checked for columns that do not exist, which is a defect
 * whichever direction the row moves.
 */
const NOT_INSERTABLE = new Set([
  'job',
  'audit_entry',
  'turn',
  'sender',
  'message',
  'action',
  'memory_fact',
  'pending_request',
  'row_snapshot',
  'academy', // update-only: there is no route that creates a second one
])

type Sig = { table: string; cols: { name: string; required: boolean }[] }

/**
 * Signatures look like `person(full_name! text, notes text, …)`, possibly wrapped
 * over several lines, and may carry `/* … *​/` comments and nested parens
 * (`unique(academy_id, phone_e164)`, `numeric(10,2)`). Parsed by walking the
 * parens rather than with one regex, because the regex version quietly stopped
 * at the first nested close and reported half the columns.
 */
function parseSignatures(doc: string): Sig[] {
  const out: Sig[] = []
  const re = /(?:^|\n)([a-z_]+)\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(doc))) {
    const table = m[1] as string
    let i = re.lastIndex - 1
    let depth = 0
    let end = -1
    for (; i < doc.length; i++) {
      const ch = doc[i]
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end === -1) continue
    const body = doc
      .slice(re.lastIndex, end)
      .replace(/\/\*[\s\S]*?\*\//g, ' ') // inline commentary
      .replace(/--[^\n]*/g, ' ')

    // Split on commas at depth 0 only, so `numeric(10,2)` and
    // `unique(academy_id, phone_e164)` stay in one piece.
    const parts: string[] = []
    let buf = ''
    let d = 0
    for (const ch of body) {
      if (ch === '(') d++
      if (ch === ')') d--
      if (ch === ',' && d === 0) {
        parts.push(buf)
        buf = ''
      } else buf += ch
    }
    parts.push(buf)

    const cols: { name: string; required: boolean }[] = []
    for (const raw of parts) {
      const t = raw.trim()
      if (!t) continue
      // `unique(...)`, `pk(...)` and similar are constraints, not columns.
      if (/^(unique|pk|primary|foreign|check)\b/i.test(t)) continue
      const cm = /^([a-z_][a-z0-9_]*)(!?)/.exec(t)
      if (!cm) continue
      const name = cm[1] as string
      // A bare word with no type after it is prose that happened to start a line.
      if (!/^[a-z_][a-z0-9_]*!?\s+\S/.test(t)) continue
      cols.push({ name, required: cm[2] === '!' })
    }
    if (cols.length) out.push({ table, cols })
  }
  return out
}

/** `app.session_roster(…)` and bare `session_coverage(…)` mentioned as views. */
function parseViewMentions(doc: string): { schema: string; name: string }[] {
  const out: { schema: string; name: string }[] = []
  // A view added to SCHEMA_DOC and not to this list is checked by nothing — the
  // list is the check, and a name missing from it passes vacuously rather than
  // failing loudly. Add the name here in the same change that adds the view.
  for (const m of doc.matchAll(
    /\b(app\.)?(session_roster|session_coverage|unmarked_billable_session|coach_public|coach_directory|class_coach_public|class_offering|class_roster|account_standing|account_ledger|coach_pay|person_directory|session_detail)\b/g,
  )) {
    out.push({ schema: m[1] ? 'app' : 'public', name: m[2] as string })
  }
  return out
}

const problems: string[] = []

const anyAcademy = await withSession({ role: 'service', academyId: '' }, async (tx) => {
  const rows = (await tx`select id from academy limit 1`) as unknown as { id: string }[]
  return rows[0]?.id ?? null
})

/**
 * `information_schema` is not tenant-scoped, but `withSession` still needs a
 * role, and reading catalogs as the service role with no tenant is fine — the
 * emptiness trap that bites `academy` does not apply to a catalog.
 */
const q = async <T = any>(sql: string): Promise<T[]> =>
  withSession({ role: 'service', academyId: anyAcademy ?? '' }, async (tx) => (await tx.unsafe(sql)) as unknown as T[])

const realCols = await q<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }>(`
  select c.table_name, c.column_name, c.is_nullable, c.column_default
    from information_schema.columns c
    join information_schema.tables t
      on t.table_schema = c.table_schema and t.table_name = c.table_name
   where c.table_schema = 'public' and t.table_type = 'BASE TABLE'`)

const byTable = new Map<string, Map<string, { required: boolean }>>()
for (const r of realCols) {
  if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Map())
  byTable
    .get(r.table_name)!
    .set(r.column_name, { required: r.is_nullable === 'NO' && r.column_default === null })
}

const sigs = parseSignatures(SCHEMA_DOC)
console.log(c.dim(`\n  ${sigs.length} table signatures parsed from SCHEMA_DOC\n`))

for (const sig of sigs) {
  if (PROSE_ONLY.has(sig.table)) continue
  const real = byTable.get(sig.table)
  if (!real) {
    problems.push(`table "${sig.table}" is documented and does not exist`)
    continue
  }
  const documented = new Set<string>()
  for (const col of sig.cols) {
    documented.add(col.name)
    const r = real.get(col.name)
    if (!r) {
      problems.push(`${sig.table}.${col.name} is documented and does not exist`)
      continue
    }
    if (col.required && !r.required) {
      problems.push(`${sig.table}.${col.name} is marked ! but is nullable or defaulted — the mark is a lie`)
    }
    if (!col.required && r.required && !NOT_INSERTABLE.has(sig.table)) {
      problems.push(
        `${sig.table}.${col.name} is NOT NULL with no default and is NOT marked ! — ` +
          `an insert omitting it is refused, and takes its whole plan with it`,
      )
    }
  }
  // The other direction: a required column the block never names at all.
  if (!NOT_INSERTABLE.has(sig.table)) {
    for (const [name, r] of real) {
      if (IMPLICIT.has(name) || documented.has(name)) continue
      if (r.required) {
        problems.push(`${sig.table}.${name} is required and is not in the signature at all`)
      }
    }
  }
}

const realViews = new Set(
  (
    await q<{ table_schema: string; table_name: string }>(
      `select table_schema, table_name from information_schema.views where table_schema in ('app','public')`,
    )
  ).map((v) => `${v.table_schema}.${v.table_name}`),
)
for (const v of parseViewMentions(SCHEMA_DOC)) {
  if (!realViews.has(`${v.schema}.${v.name}`)) {
    const elsewhere = [...realViews].find((r) => r.endsWith(`.${v.name}`))
    problems.push(
      `view ${v.schema === 'app' ? 'app.' : ''}${v.name} is referenced and does not exist there` +
        (elsewhere ? ` — it is ${elsewhere}` : ''),
    )
  }
}

if (!problems.length) {
  console.log(c.green('  SCHEMA_DOC agrees with the database.\n'))
  process.exit(0)
}

console.log(c.red(`  ${problems.length} divergence${problems.length === 1 ? '' : 's'}:\n`))
for (const p of [...new Set(problems)].sort()) console.log(`    ${p}`)
console.log(
  c.dim(
    `\n  Each of these is a statement the model will write and Postgres will refuse.\n` +
      `  Fix lib/agent/schema-doc.ts, not this check.\n`,
  ),
)
process.exit(1)

/**
 * judge-feed — the inside of a turn, rendered for a person to read and grade.
 *
 *   node scripts/judge-feed.mjs --academy "Smash Badminton" [--from 1] [--to 8] [--last 3]
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * (Since 20 Aug 2026 the records DO exist as the run walks — `_capture` appends
 * one line per turn and `_derive` rebuilds `record.json` after each — so
 * `judge.mjs --run` can also follow a live run now. This feed keeps its own
 * reason to exist: it renders for a PERSON, in reading order, without asking
 * them to open JSON.)
 *
 * The product also records all of it, live,
 * in `turn`: `tool_calls` carries one `(model)` entry per round holding the
 * reasoning, and one entry per call holding the arguments and the result. The
 * records file is a COPY. This reads the original, while the drive is still
 * walking, so a turn can be graded within a minute of happening.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * -----------------------------------------------------------------------------
 * It does not score anything. Every deterministic verdict this repo has — the
 * invariants, the reply flags, the regexes — answers a question somebody could
 * write down in advance, and the failures that matter most here have repeatedly
 * been the ones nobody thought to write down: a count that was right for a table
 * that was wrong, a refusal that read as a race, a promise kept by luck. Those
 * are found by reading. This prints what there is to read, in the order it
 * happened, and stops.
 *
 * Nothing is truncated silently: `--cap` is generous, and when it binds it says
 * so in the output rather than ending mid-token and looking complete.
 */
import fs from 'node:fs'
import path from 'node:path'
import postgres from 'postgres'

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const env = Object.fromEntries(
  fs.readFileSync(path.join(root, '.env.local'), 'utf8')
    .split(/\r?\n/).filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
)

const argv = process.argv.slice(2)
const flag = (n, d = '') => {
  const i = argv.findIndex((a) => a === `--${n}` || a.startsWith(`--${n}=`))
  if (i === -1) return d
  const a = argv[i]
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? d)
}
const ACADEMY = flag('academy', 'Smash Badminton')
const FROM = Number(flag('from', '1'))
const TO = Number(flag('to', '0')) || null
const LAST = Number(flag('last', '0')) || null
const CAP = Number(flag('cap', '6000'))

const sql = postgres(env.DATABASE_URL, { ssl: 'require', max: 2, prepare: false, onnotice: () => {} })

const cut = (s) => {
  const t = typeof s === 'string' ? s : JSON.stringify(s ?? null)
  return t.length <= CAP ? t : `${t.slice(0, CAP)}\n   …[CUT — ${t.length - CAP} more chars of ${t.length}; raise --cap]`
}
const parse = (s) => { try { return typeof s === 'string' ? JSON.parse(s) : s } catch { return null } }
const ist = (t) => new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })

const rows = await sql.begin(async (tx) => {
  // The login role can reach neither `app.list_academies()` nor `contact`, so the
  // role is taken FIRST and the tenant GUC set immediately after — `turn`, like
  // every other table here, is tenant-scoped even for the service role, and a
  // read with no GUC set returns empty rather than raising (DRIVING.md's R7).
  await tx.unsafe('set local role cm_service')
  const [ac] = await tx.unsafe(
    `select id, name from app.list_academies() where name ilike '${ACADEMY.replace(/'/g, "''")}%' limit 1`)
  if (!ac) throw new Error(`no academy matching ${JSON.stringify(ACADEMY)}`)
  await tx.unsafe(`select set_config('app.academy_id', '${ac.id}', true)`)
  const turns = await tx.unsafe(`
    select t.id::text, t.created_at::text as at, t.role_acted, t.rounds, t.latency_ms,
           t.prompt_tokens, t.cached_tokens, t.output_tokens, t.error,
           t.input->>'text' as typed, t.input->>'source' as source,
           t.output::text as output, t.tool_calls::text as calls,
           coalesce(p.full_name, '(unknown)') as who
      from turn t
      left join contact c on c.id = t.contact_id
      left join person p on p.id = c.person_id
     order by t.created_at`)
  const msgs = await tx.unsafe(`
    select m.turn_id::text as turn_id, m.created_at::text as at, m.direction, m.status,
           m.suppressed_reason, m.template_name, coalesce(p.full_name, '(unknown)') as who, m.body
      from message m
      left join contact c on c.id = m.contact_id
      left join person p on p.id = c.person_id
     where m.direction = 'outbound'
     order by m.created_at`)
  return { ac, turns, msgs }
})

const { ac, turns, msgs } = rows
const slice = LAST ? turns.slice(-LAST) : turns.slice(FROM - 1, TO ?? undefined)

console.log(`\n${ac.name} — ${turns.length} turns recorded, showing ${slice.length}\n`)

for (const [i, t] of slice.entries()) {
  const n = (LAST ? turns.length - LAST : FROM - 1) + i + 1
  const out = parse(t.output) ?? {}
  const calls = parse(t.calls) ?? []
  console.log('='.repeat(100))
  console.log(`TURN ${n}  ·  ${ist(t.at)} IST  ·  ${t.role_acted ?? '?'}  ·  ${t.who}`)
  console.log(`${t.rounds} rounds · ${(t.latency_ms / 1000).toFixed(1)}s · ${t.prompt_tokens} in (${t.cached_tokens} cached) / ${t.output_tokens} out${t.error ? ` · ERROR ${t.error}` : ''}`)
  console.log('='.repeat(100))
  console.log(`\nTHEY TYPED:\n  ${String(t.typed ?? '(no text)').replace(/\n/g, '\n  ')}\n`)

  // One block per round, in the order the model produced them.
  const byRound = new Map()
  for (const c of calls) {
    const r = Number(c.round ?? 0)
    if (!byRound.has(r)) byRound.set(r, [])
    byRound.get(r).push(c)
  }
  for (const [r, cs] of [...byRound.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ── round ${r} ${'─'.repeat(80)}`)
    for (const c of cs) {
      if (c.name === '(model)') {
        /**
         * The reasoning is nested — `tool_calls[].args.message.reasoning_content`
         * — and reading it off the top level finds nothing while looking like it
         * looked. It is also PRESENT ONLY ON SOME ROUNDS, by design: the loop
         * runs thinking at `low` for tool-calling rounds and `disabled` for plain
         * prose (deepseek.ts, "nothing to deliberate about, and the latency is
         * somebody's silence"). So a round with no THINKING block is a round the
         * model was not asked to think on — not a round whose thinking was lost.
         */
        /**
         * `args.message` arrives in TWO shapes and the second one is a bug
         * upstream: `traceValue` (loop.ts) keeps the object when it fits its cap
         * and returns a TRUNCATED JSON STRING when it does not — so the longer
         * the model deliberated, the likelier its reasoning is unparseable. Both
         * shapes are read here, and a string that will not parse is salvaged with
         * a regex rather than dropped, because a truncated reasoning is still the
         * only evidence of what the model was doing.
         */
        const raw = c.args?.message
        let m = typeof raw === 'string' ? parse(raw) : (raw ?? {})
        if (!m && typeof raw === 'string') {
          const hit = /"reasoning_content"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw)
          try {
            m = hit ? { reasoning_content: `${JSON.parse(`"${hit[1].replace(/"$/, '')}"`)}\n…[TRUNCATED UPSTREAM — pre-fix run]` } : {}
          } catch { m = {} }
        }
        m = m ?? {}
        // The field `loop.ts` writes now wins over both legacy shapes.
        if (typeof c.reasoning === 'string' && c.reasoning.trim()) m.reasoning_content = c.reasoning
        if (m.reasoning_content) console.log(`  THINKING:\n    ${cut(m.reasoning_content).replace(/\n/g, '\n    ')}`)
        else console.log(`  (no reasoning on this round — thinking was disabled for it)`)
        if (m.content) console.log(`  DRAFTED BEFORE ACTING:\n    ${cut(m.content).replace(/\n/g, '\n    ')}`)
      } else if (String(c.name).startsWith('(')) {
        console.log(`  LOOP INTERVENED — ${c.name}: ${cut(c.result)}`)
      } else if (c.name === 'read') {
        const a = parse(c.args) ?? {}
        const res = parse(c.result)
        console.log(`  ASKED THE DATABASE${a.purpose ? ` — ${a.purpose}` : ''}:`)
        console.log(`    ${String(a.query ?? '').replace(/\s+/g, ' ').trim()}`)
        if (c.error || res?.error) console.log(`    ✗ NOTHING CAME BACK: ${cut(c.error ?? res.error)}`)
        else console.log(`    → ${res?.rowCount ?? (res?.rows?.length ?? '?')} rows: ${cut(JSON.stringify(res?.rows ?? res))}`)
      } else {
        console.log(`  DID — ${c.name}:`)
        console.log(`    args:   ${cut(c.args)}`)
        console.log(`    result: ${cut(c.result)}`)
        if (c.error) console.log(`    ✗ FAILED: ${cut(c.error)}`)
      }
    }
  }

  console.log(`\n  THE REPLY (what the person read):\n    ${String(out.reply ?? '(nothing)').replace(/\n/g, '\n    ')}`)

  const mine = msgs.filter((m) => m.turn_id === t.id)
  const next = slice[i + 1] ?? turns[turns.indexOf(t) + 1]
  const between = msgs.filter((m) => !m.turn_id && m.at > t.at && (!next || m.at <= next.at))
  if (mine.length) {
    console.log(`\n  EVERYTHING THIS TURN SENT (${mine.length}):`)
    for (const m of mine) {
      console.log(`    [${m.who}] ${m.suppressed_reason ? `SUPPRESSED(${m.suppressed_reason})` : m.status}${m.template_name ? ` template:${m.template_name}` : ''} — ${String(m.body ?? '').replace(/\n/g, ' ⏎ ').slice(0, 400)}`)
    }
  }
  if (between.length) {
    console.log(`\n  SCHEDULED WORK THAT FIRED BEFORE THE NEXT TURN (${between.length}) — nobody asked for these:`)
    for (const m of between) {
      console.log(`    ${ist(m.at)} [${m.who}] ${m.suppressed_reason ? `SUPPRESSED(${m.suppressed_reason})` : m.status}${m.template_name ? ` template:${m.template_name}` : ''} — ${String(m.body ?? '').replace(/\n/g, ' ⏎ ').slice(0, 400)}`)
    }
  }
  console.log()
}

await sql.end()

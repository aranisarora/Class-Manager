/**
 * scripts/verify-static.mjs — the four absolutes, checked by a machine (§16.3, §17).
 *
 *   node scripts/verify-static.mjs   ·   npm run verify:static
 *
 * Four of the load-bearing sentences in this repo are absolutes:
 *
 *   1. `transport-cloud.ts` is the only file that may talk to Meta.
 *   2. Nothing reads the host clock for DOMAIN time — `lib/clock.ts` is the clock.
 *   3. Nothing in SQL compares against the database's own clock — `app.now()` is.
 *   4. No unthrottled send exists; `send` is reachable from two files.
 *
 * Every one of them was documentation. `scripts/verify-invariants.mjs` demonstrates
 * behaviour against a running server and a seeded world and then exits 0 whatever it
 * saw — so it is a demo, not a check: it cannot fail a build, and it cannot run before
 * a world exists. This reads the source, prints file:line for every violation, and
 * exits non-zero. No database, no server, no model.
 *
 * A rule is worth exactly what its exemptions are worth, so every exemption below
 * names a file and says why that file is not the failure the rule is about — and a
 * dead exemption is itself a failure, because an allowlist nobody re-reads is how a
 * rule quietly stops being one.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SOURCE_DIRS = ['lib', 'app', 'scripts', 'components']
const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const SKIP_DIRS = new Set(['node_modules', '.next', '.git', '.claude', 'dist', 'build', 'coverage'])

/** This file has to name every forbidden string; scanning it would flag itself. */
const SELF = 'scripts/verify-static.mjs'

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/')
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/* ------------------------------------------------------------------------- *
 * The scanner
 *
 * Everything below is a grep, and a grep over raw source lies in both directions:
 * a comment that quotes the rule ("never `new Date()`") reads as a violation, and
 * a string that carries SQL reads as code. So each file is walked once into two
 * views plus a map of where its string literals are. Both views are the SAME
 * LENGTH as the original — comments and string bodies are blanked with spaces,
 * never removed — so a match offset is still the real line and column.
 *
 *   text  comments blanked, strings kept   → hosts, import specifiers
 *   code  comments AND string bodies blanked → wall-clock reads
 *   mark  1 where a byte is inside a string literal → embedded SQL
 * ------------------------------------------------------------------------- */

/**
 * Where a `/` may begin a regex literal rather than a division. Regex literals
 * have to be recognised because several of them contain quotes
 * (`.replace(/'/g, "''")`), and a scanner that walks past one opens a phantom
 * string on that quote.
 *
 * Wrong in the other direction is cheap and wrong in this one is not, so `<`, `>`,
 * `{` and `}` are deliberately absent: in TSX they would make `</div>`, `=> ` and
 * `{expr} />` all look like the start of a regex. Every quote-carrying regex in
 * this tree sits directly after `(`, and a regex read as division costs nothing
 * unless it contains a quote or a backtick.
 */
const REGEX_MAY_FOLLOW = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', ';', '+', '-', '*', '%', '^', '~'])
const REGEX_MAY_FOLLOW_WORD = /\b(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)[ \t]*$/

function scan(src) {
  const n = src.length
  const text = src.split('')
  const code = src.split('')
  const mark = new Uint8Array(n)
  const frames = [] // { kind: 'tmpl', from } | { kind: 'interp', depth }
  let depth = 0
  let prev = ''
  let i = 0

  const blank = (arr, from, to) => {
    for (let k = from; k < to && k < n; k++) if (arr[k] !== '\n') arr[k] = ' '
  }
  const keepString = (from, to) => {
    blank(code, from, to)
    for (let k = from; k < to && k < n; k++) mark[k] = 1
  }
  const top = () => frames[frames.length - 1]

  while (i < n) {
    const frame = top()

    // Inside template text: only ` and ${ end it. Everything else, quotes included,
    // is content — this is where most of the SQL in this codebase lives.
    if (frame && frame.kind === 'tmpl') {
      const c = src[i]
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '`') {
        keepString(frame.from, i)
        frames.pop()
        i++
        prev = '`'
        continue
      }
      if (c === '$' && src[i + 1] === '{') {
        keepString(frame.from, i)
        frames.push({ kind: 'interp', depth })
        i += 2
        prev = '{'
        continue
      }
      i++
      continue
    }

    const c = src[i]
    const d = src[i + 1]

    if (c === '/' && d === '/') {
      let j = i + 2
      while (j < n && src[j] !== '\n') j++
      blank(text, i, j)
      blank(code, i, j)
      i = j
      continue
    }

    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2)
      const j = end === -1 ? n : end + 2
      blank(text, i, j)
      blank(code, i, j)
      i = j
      continue
    }

    if (c === '/' && (REGEX_MAY_FOLLOW.has(prev) || REGEX_MAY_FOLLOW_WORD.test(src.slice(Math.max(0, i - 24), i)))) {
      let j = i + 1
      let inClass = false
      while (j < n) {
        const e = src[j]
        if (e === '\\') {
          j += 2
          continue
        }
        if (e === '\n') break
        if (e === '[') inClass = true
        else if (e === ']') inClass = false
        else if (e === '/' && !inClass) {
          j++
          break
        }
        j++
      }
      i = j
      prev = ')' // a regex is a value, so a following / is division
      continue
    }

    // A quoted string ends at its quote OR at the newline. Nothing in JS spans a
    // line without a backtick, and it bounds the blast radius of a misread: a
    // stray quote can mislabel the rest of its own line and nothing beyond it.
    if (c === "'" || c === '"') {
      const from = i + 1
      let j = from
      while (j < n) {
        const e = src[j]
        if (e === '\\') {
          j += 2
          continue
        }
        if (e === c || e === '\n') break
        j++
      }
      keepString(from, Math.min(j, n))
      i = src[j] === c ? j + 1 : j
      prev = c
      continue
    }

    if (c === '`') {
      frames.push({ kind: 'tmpl', from: i + 1 })
      i++
      continue
    }

    if (c === '{') {
      depth++
      i++
      prev = '{'
      continue
    }

    if (c === '}') {
      // The `}` that closes a `${…}` returns us to template text; every other one
      // is an ordinary block or object literal.
      if (frame && frame.kind === 'interp' && frame.depth === depth) {
        frames.pop()
        const outer = top()
        if (outer && outer.kind === 'tmpl') outer.from = i + 1
        i++
        prev = '}'
        continue
      }
      depth = Math.max(0, depth - 1)
      i++
      prev = '}'
      continue
    }

    if (!/\s/.test(c)) prev = c
    i++
  }

  return { text: text.join(''), code: code.join(''), mark }
}

function lineStarts(src) {
  const starts = [0]
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') starts.push(k + 1)
  return starts
}

function makeFile(relPath) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8')
  const views = scan(src)
  const starts = lineStarts(src)
  return {
    path: relPath,
    src,
    ...views,
    /** 1-based line number of a byte offset. */
    lineNo(off) {
      let lo = 0
      let hi = starts.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (starts[mid] <= off) lo = mid
        else hi = mid - 1
      }
      return lo + 1
    },
    lineText(off) {
      const no = this.lineNo(off)
      const end = no < starts.length ? starts[no] : src.length
      const raw = src.slice(starts[no - 1], end).replace(/\r?\n$/, '').trim()
      return raw.length > 140 ? raw.slice(0, 137) + '…' : raw
    },
  }
}

function sourceFiles() {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p)
        continue
      }
      if (!SOURCE_EXT.has(path.extname(e.name))) continue
      const r = rel(p)
      if (r !== SELF) out.push(r)
    }
  }
  for (const d of SOURCE_DIRS) walk(path.join(ROOT, d))
  return out.sort()
}

const FILES = sourceFiles().map(makeFile)
if (FILES.length === 0) {
  console.log('verify-static: no source files found — run it from the repo, not from scripts/')
  process.exit(1)
}

/* ------------------------------------------------------------------------- *
 * Reporting
 * ------------------------------------------------------------------------- */

let pass = 0
let fail = 0

function rule(label, violations, notes = []) {
  if (violations.length === 0) {
    pass++
    console.log(`  pass  ${label}`)
  } else {
    fail++
    console.log(`  FAIL  ${label} — ${violations.length} violation${violations.length === 1 ? '' : 's'}`)
    for (const v of violations) {
      console.log(`          ${v.where}`)
      console.log(`            ${v.line}`)
    }
  }
  for (const n of notes) console.log(`  note  ${n}`)
}

const at = (file, off) => ({ where: `${file.path}:${file.lineNo(off)}`, line: file.lineText(off) })

/** Walk every match of `re` in `view`, yielding the match. `re` must be /g. */
function* matches(re, view) {
  re.lastIndex = 0
  let m
  while ((m = re.exec(view)) !== null) {
    if (m[0].length === 0) re.lastIndex++
    else yield m
  }
}

/**
 * An exemption. `why` is the point of the whole list: a file is exempt because it
 * is not the failure the rule is about, and the reason has to survive the next
 * person who reads it. `permanent` entries are exempt by construction and are not
 * expected to be exercised by any particular line.
 */
function allow(entries) {
  const list = entries.map((e) => ({ ...e, used: false }))
  return {
    list,
    /** Marks and returns true when this hit is covered. */
    covers(filePath, lineText) {
      for (const e of list) {
        if (e.file !== filePath) continue
        if (e.match && !e.match.test(lineText)) continue
        e.used = true
        return true
      }
      return false
    },
  }
}

console.log('\nverify-static — four absolutes, and the exemptions that excuse them\n')

/* ------------------------------------------------------------------------- *
 * 1 · One file may talk to Meta
 *
 * §17: "No Meta API call may exist anywhere outside `transport-cloud.ts`."
 * A second call site is not a style problem — it is a second place that can send
 * without passing the ten gates in `send.ts`, and it would be invisible in the
 * emulator's event log, which is where §18 and §2.8 are actually inspected.
 * ------------------------------------------------------------------------- */

const TRANSPORT = 'lib/messaging/transport-cloud.ts'
const META_HOSTS = [
  'graph.facebook.com',
  'graph.instagram.com',
  'business.facebook.com',
  'lookaside.fbsbx.com',
  // NOT `wa.me`. §8.1's invite is a deep link the ADMIN forwards from their own
  // number — a URL inside a message body, minted on purpose in `operations.ts`.
  // It is not a call to Meta and listing it here would fail an honest file.
]
const META_RE = new RegExp(META_HOSTS.map(escapeRe).join('|'), 'gi')

{
  const violations = []
  for (const f of FILES) {
    if (f.path === TRANSPORT) continue
    // `text`, not `src`: a comment naming the host (transport.ts states this very
    // rule) is documentation, not a call.
    for (const m of matches(META_RE, f.text)) violations.push(at(f, m.index))
  }
  rule(`no Meta API host outside ${TRANSPORT} (§17)`, violations)
}

/* ------------------------------------------------------------------------- *
 * 2 · Domain time comes from the clock, never the host
 *
 * `lib/clock.ts`: domain now is wall time plus `sim_clock.offset_ms`. A
 * `Date.now()` that decides what day it is ignores the offset, so the emulator
 * advances a day and that one decision stays behind — the bug is invisible in
 * production and looks like nonsense in test. Measuring how long a query took is
 * not that: the value never leaves a `ms:` field.
 * ------------------------------------------------------------------------- */

const WALL_CLOCK = /\b(?:Date\.now\s*\(\s*\)|new\s+Date\s*\(\s*\)|DateTime\.(?:now|local)\s*\(\s*\))/g

const WALL_CLOCK_ALLOW = allow([
  {
    file: 'lib/clock.ts',
    permanent: true,
    why: 'the clock itself — domain now IS the host clock plus sim_clock.offset_ms',
  },
  {
    file: 'lib/emulator/state.ts',
    why:
      'the browser store. There is no app.now() in a browser and no session to read it with; ' +
      'domain time arrives from the server as clock.nowIso and is ticked forward by elapsed ' +
      'real time, exactly as clock.ts does it. Nothing here decides domain state.',
  },
  {
    file: 'lib/agent/gemini.ts',
    match: /Date\.now\(\)/,
    why:
      "the prompt cache handle's lifetime is Google's, measured in real seconds on their " +
      'servers. Advancing sim_clock must not expire or extend it.',
  },
  {
    file: 'lib/format.ts',
    match: /DateTime\.now\(\)/,
    why:
      'anchors a bare HH:MM to a day so the formatter has something to work with; only the ' +
      'clock part is ever read, and the file is pure — it has no database and no clock.',
  },
])

/**
 * A stopwatch, not a date. Either the read is already inside a subtraction, or it
 * is the start of one the same file completes — `const started = Date.now()` is
 * indistinguishable from a domain read until you find the `Date.now() - started`
 * that gives it its meaning, so this looks for it.
 */
function isInstrumentation(view, m) {
  const before = view.slice(Math.max(0, m.index - 60), m.index)
  const after = view.slice(m.index + m[0].length, m.index + m[0].length + 60)
  if (/^\s*-\s*[^-=]/.test(after)) return true
  if (/[^-+]-\s*$/.test(before)) return true
  const named = /([A-Za-z_$][\w$]*)\s*[:=]\s*$/.exec(before)
  if (named) {
    const nm = escapeRe(named[1])
    const elapsed = new RegExp(
      `(?:Date\\.now\\(\\)|getTime\\(\\))\\s*-\\s*(?:[\\w$]+\\.)*\\b${nm}\\b|\\b${nm}\\b\\s*-\\s*Date\\.now\\(\\)`,
    )
    if (elapsed.test(view)) return true
  }
  return false
}

{
  const violations = []
  for (const f of FILES) {
    if (!f.path.startsWith('lib/')) continue
    for (const m of matches(WALL_CLOCK, f.code)) {
      if (isInstrumentation(f.code, m)) continue
      const hit = at(f, m.index)
      if (WALL_CLOCK_ALLOW.covers(f.path, hit.line)) continue
      violations.push(hit)
    }
  }
  rule('nothing under lib/ reads the host clock for domain time (lib/clock.ts)', violations)
}

/* ------------------------------------------------------------------------- *
 * 3 · SQL asks `app.now()`, never the database's own clock
 *
 * `now()` in Postgres does not know the emulator exists. A `where run_at <= now()`
 * fires on real time while everything around it moved, so advancing the clock
 * proves nothing and the same query is subtly wrong in production the moment the
 * two disagree. Only string literals are searched — `await now()` in TypeScript is
 * `lib/clock.ts`'s export and is the correct thing to write.
 *
 * `supabase/migrations/**` is deliberately out of scope: `app.now()` is *defined*
 * there in terms of `now()`, and `created_at` defaults are a monotonic stream
 * cursor rather than domain time (`lib/seed.ts` documents that distinction).
 * ------------------------------------------------------------------------- */

const SQL_CLOCK =
  /(?<![\w$.])(?:now\s*\(\s*\)|current_date|current_timestamp|localtimestamp|(?:clock|statement|transaction)_timestamp\s*\(\s*\))(?![\w$])/gi

const SQL_CLOCK_ALLOW = allow([
  {
    file: 'lib/agent/schema-doc.ts',
    why:
      'the stable prefix states this exact rule to the model ("Never call now(), current_date ' +
      'or current_timestamp. Use app.now()."). It is a byte-frozen prompt constant and holds ' +
      'no executed SQL.',
  },
])

{
  const violations = []
  for (const f of FILES) {
    for (const m of matches(SQL_CLOCK, f.text)) {
      if (!f.mark[m.index]) continue // in code, not in a string literal
      const hit = at(f, m.index)
      if (SQL_CLOCK_ALLOW.covers(f.path, hit.line)) continue
      violations.push(hit)
    }
  }
  rule('no SQL literal compares against the database clock — app.now() is the clock', violations)
}

/* ------------------------------------------------------------------------- *
 * 4 · No unthrottled send
 *
 * §16.3: "No unthrottled send function exists in the codebase. Not 'we shouldn't
 * call one' — one send path, everything through it." `send.ts` is where the ten
 * gates live: the window, the caps, §18's two suppression rules, and the `message`
 * row that records every refusal. A third importer of `send` is a path around all
 * of it, and the suppression it skips would be invisible rather than logged.
 *
 * The check is on the BINDING, not the module: `send` is the wire. `markStatus` is
 * a delivery callback writing status onto a row that was already sent, and the
 * seeder needs it.
 * ------------------------------------------------------------------------- */

const SEND_MODULE = 'lib/messaging/send'
const SEND_CALLERS = ['lib/messaging/compose.ts', 'lib/agent/plan.ts']

const stripExt = (p) => p.replace(/\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/, '').replace(/\/index$/, '')

function resolveSpec(fromFile, spec) {
  if (spec.startsWith('@/')) return stripExt(path.posix.normalize(spec.slice(2)))
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return stripExt(path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec)))
  }
  return null // a package, not this module
}

/** The `import …` / `export …` clause sitting in front of a `from '…'`, or null. */
function importClause(before) {
  if (!/\bfrom\s*$/.test(before)) return null
  const head = before.replace(/\bfrom\s*$/, '')
  const kw = Math.max(head.lastIndexOf('import'), head.lastIndexOf('export'))
  return kw === -1 ? null : head.slice(kw)
}

/** Conservative: anything that is not a named list without `send` in it counts. */
function bindsSend(clause) {
  if (clause === null) return true // require('./send'), await import('./send'), bare import
  if (/^(?:import|export)\s*\*/.test(clause.trim())) return true // namespace, or a re-export of everything
  const braces = /\{([\s\S]*)\}/.exec(clause)
  if (!braces) return true // default import, or a shape this check does not understand
  return braces[1].split(',').some((part) => /^\s*(?:type\s+)?send\b/.test(part))
}

const SPECIFIER_POSITION = /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)$/

{
  const violations = []
  const notes = []
  for (const f of FILES) {
    for (let i = 0; i < f.mark.length; i++) {
      if (!f.mark[i] || (i > 0 && f.mark[i - 1])) continue // start of a string literal
      let end = i
      while (end < f.mark.length && f.mark[end]) end++
      const spec = f.text.slice(i, end)
      if (!/^[.@\w/-]+$/.test(spec)) continue
      if (resolveSpec(f.path, spec) !== SEND_MODULE) continue

      const before = f.text.slice(Math.max(0, i - 301), Math.max(0, i - 1))
      if (!SPECIFIER_POSITION.test(before)) continue

      if (SEND_CALLERS.includes(f.path)) continue
      const hit = at(f, i)
      if (!bindsSend(importClause(before))) {
        notes.push(`${hit.where} imports ${SEND_MODULE} without \`send\` — ${hit.line}`)
        continue
      }
      violations.push(hit)
    }
  }
  rule(`nothing imports \`send\` except ${SEND_CALLERS.join(' and ')} (§16.3)`, violations, notes)
}

/* ------------------------------------------------------------------------- *
 * 5 · The exemptions are still real
 *
 * An allowlist entry that matches nothing excuses nothing, and it is the shape a
 * rule rots into: the line it was written for is gone, the entry stays, and the
 * next person reads it as permission. Deleting the entry is the fix.
 * ------------------------------------------------------------------------- */

{
  const violations = []
  for (const { list } of [WALL_CLOCK_ALLOW, SQL_CLOCK_ALLOW]) {
    for (const e of list) {
      if (e.used || e.permanent) continue
      violations.push({
        where: `${e.file}  (exemption)`,
        line: `matched nothing — the code it excused is gone, so delete the entry: ${e.why}`,
      })
    }
  }
  rule('every exemption above still excuses real code', violations)
}

console.log(`\n${pass} passed, ${fail} failed · ${FILES.length} files\n`)
process.exit(fail ? 1 : 0)

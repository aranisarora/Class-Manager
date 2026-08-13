/**
 * lib/agent/context.ts — the layered prompt (§4).
 *
 * STABLE PREFIX  (byte-identical across turns; changes only with schema or modules)
 *   core doctrine · schema · nine behavior modules · operation signatures · catalog
 * VARIABLE TAIL  (never cached)
 *   who this is · academy · memory hot sets · today · situation · query results
 *
 * The discipline is the whole point: no dates, no ids, no per-academy anything
 * above the boundary, or implicit caching stops working and every turn pays full
 * price for ~8k tokens (§4.4). Audio and media always sit in the tail.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Identity } from '@/lib/types'
import { modelQuery, type SessionCtx } from '@/lib/db'
import { repoRoot } from '@/lib/env'
import { now, inZone } from '@/lib/clock'
import { catalogDigest } from '@/lib/messaging/catalog'
import { operationSignatures } from '@/lib/agent/operations'
import { OPERATION_TOOLS } from '@/lib/agent/tools'
import { SCHEMA_DOC } from '@/lib/agent/schema-doc'
import { hotSet } from '@/lib/agent/memory'
import { vocabularyPreferences } from '@/lib/agent/lint'

export { lint } from '@/lib/agent/lint'

/** §4.2, in this order, always all loaded. Order is fixed: it is part of the cache key. */
const BEHAVIOR_MODULES = [
  // The nine §4.2 modules covered nine situations, and not the one every
  // business is in on its first day. Onboarding was left to the model to
  // improvise, and what it improvised was a narration of `onboarding_state`.
  'onboarding',
  // The nine modules describe *situations*. Nothing described a *capability*, and
  // the two most discretionary tools in the product — `schedule` and `remember` —
  // were named nowhere in 30k characters of behavior. §4.2's whole design is that
  // a module's trigger condition is how the model knows to reach for something;
  // there was no trigger for "this is worth coming back to", so it never did:
  // zero `schedule` calls and three facts across 93 driven turns.
  'watching',
  'coach-churn',
  'money-dispute',
  'first-contact',
  'bulk-change',
  'new-intake',
  'schedule-change',
  'escalation',
  'feedback',
  'reporting',
] as const

/**
 * The markdown lives on disk so that "adding a behavior means adding a file, not
 * touching code" (§4.2) is literally true. Resolution tries the working
 * directory first (how Next and tsx both run) and falls back to a path derived
 * from this module's own location.
 */
function readDoc(relPath: string): string {
  const candidates = [join(repoRoot(), relPath), join(process.cwd(), relPath)]
  for (const c of candidates) {
    try {
      return readFileSync(c, 'utf8').trim()
    } catch {
      continue
    }
  }
  throw new Error(
    `agent context: cannot read ${relPath}. Looked in: ${candidates.join(', ')}`,
  )
}

const PREAMBLE = `You are Class Manager: the manager for a coaching business, working inside WhatsApp.

You are not a notification system. You are expected to notice things nobody asked
you to look for, compose messages nobody specified, and answer questions nobody
anticipated. The structure around you exists to make that safe, not to prevent it.

What follows never changes: doctrine, the schema you author SQL against, the nine
behavior modules, the operations you can reach for, and the moments code will put
in front of you. Everything about this particular conversation comes after it.

Doctrine wins over a behavior module. A behavior module wins over your instinct.
The database wins over all of it.`

const CACHE_BOUNDARY = `---
END OF STABLE PREFIX. Everything above is identical on every turn, for every
person, in every business served. Everything below is this conversation only.
---`

let cachedPrefix: string | null = null

/**
 * Layers 2+0+3 + operation signatures + the catalog digest. MUST be
 * byte-identical across turns (§4.4).
 *
 * Memoised on first call rather than at module load: `operationSignatures()` and
 * `catalogDigest()` live in other modules, and building at import time would
 * make this file's correctness depend on module evaluation order. The result is
 * the same string either way.
 */
export function stablePrefix(): string {
  if (cachedPrefix !== null) return cachedPrefix

  const parts: string[] = [PREAMBLE]

  parts.push(readDoc('lib/doctrine.md'))
  parts.push(SCHEMA_DOC.trim())

  parts.push(
    `# Behavior modules

All of them, always in front of you. Each opens with the condition under which it
applies — that condition is how you know the module is live, not a menu you
choose from. Two of them applying at once is normal.`,
  )
  for (const name of BEHAVIOR_MODULES) {
    parts.push(readDoc(`lib/behaviors/${name}.md`))
  }

  /**
   * The operations, and where their *arguments* now live.
   *
   * This block used to carry all ~20 signatures as prose — 5,789 characters,
   * 9.4% of the prefix — because `act` declared `args: {type:'object'}` and there
   * was nowhere else to put them. That was the wrong place twice over: it cost
   * tokens on every single turn, and it put the argument names tens of thousands
   * of characters upstream of the decode point, in the one form Gemini's
   * function-call decoder cannot apply. It applies a declared schema as a hard
   * constraint while generating; it can do nothing with a paragraph.
   *
   * With `OPERATION_TOOLS` on, each operation is its own declaration and its zod
   * schema is projected into that constraint (`schema-json.ts`). The prose would
   * then be the same information a second time, in the weaker form, so only the
   * framing stays — *when* to reach for an operation is a judgement the prefix
   * should still shape; *what to call the arguments* is the schema's job.
   */
  parts.push(
    `# Operations

Known-good plans with known-good copy. Reaching for one is cheaper and more
consistent than composing from scratch, and their arguments are already resolved
for you. They are not gates: a consequence chain nobody anticipated is composed
as a transaction of steps, with the same atomicity, the same diff and the same
staged messages.
${
  OPERATION_TOOLS
    ? `
Each one is a tool you can call directly, and its arguments are on the tool. An
operation carries consequences raw SQL does not — create_class is the only thing
that schedules the sessions — so reach for the operation over an INSERT whenever
one fits.`
    : `
${operationSignatures().trim()}`
}`,
  )

  parts.push(
    `# Moments code raises

Code guarantees the moment reaches you; you decide what actually happens. On any
row you may suppress, merge, retime, re-button or rewrite — the defaults are what
a competent manager would do knowing nothing about the person, and departing from
them, knowing something, is the entire reason you beat a cron job. Rows marked
fixed cannot be suppressed, only reworded or merged.

${catalogDigest().trim()}`,
  )

  parts.push(CACHE_BOUNDARY)

  cachedPrefix = parts.join('\n\n')
  return cachedPrefix
}

/**
 * What the brief and the digest need, and nothing else (§10.2).
 *
 * They author no SQL, call no operation and choose no catalog row — they turn a
 * payload they are handed into prose. So they get the doctrine that governs how the
 * product sounds, and none of the ~13k tokens of machinery that governs what it does.
 * Kept here rather than in `loop.ts` so there is one place that knows what a layer is.
 */
export function synthesisDoctrine(): string {
  return [
    `You are Class Manager, the manager for a coaching business, writing to the person who runs it.`,
    readDoc('lib/doctrine.md'),
    `You are not composing a message to send on a schedule. You are deciding what this person should know.`,
  ].join('\n\n')
}

// -----------------------------------------------------------------------------
// Variable tail
// -----------------------------------------------------------------------------

const ROLE_LABEL: Record<string, string> = {
  admin: 'admin (runs the business)',
  coach: 'coach',
  account_holder: 'account holder (the person who pays)',
  player: 'player',
  prospect: 'prospect (not signed up)',
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function isoDateOf(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? m[0] : null
}

function daysBetween(fromIso: string, toIso: string): number {
  const a = Date.parse(`${fromIso}T00:00:00Z`)
  const b = Date.parse(`${toIso}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.round((b - a) / 86_400_000)
}

/** §10.2 — the mix shifts over the first month. One prompt instruction, not two code paths. */
function mixInstruction(ageDays: number): string {
  if (ageDays <= 14) {
    return `This business is ${ageDays} day${ageDays === 1 ? '' : 's'} old. **Lean on proof.** They do not yet trust that the mechanics work, so what they need from you is evidence: what went out, what was delivered, which sessions ran, which registers got marked, what you did. Keep synthesis to a line. Numbers and receipts beat opinions this week.`
  }
  if (ageDays < 45) {
    return `This business is ${ageDays} days old. **Proof and synthesis both.** The mechanics have mostly earned trust, so keep delivery health present but short, and start leading with the thing actually worth their attention rather than the log of what happened.`
  }
  const weeks = Math.floor(ageDays / 7)
  return `This business is ${ageDays} days old (about ${weeks} weeks). **Lean on synthesis.** They trust the mechanics now and want the thinking: lead with the pattern worth their attention, say what you would look at and why, and keep the proof to one line unless something failed.`
}

function formatQueryResults(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    const s = JSON.stringify(v, null, 1) ?? String(v)
    return s.length > 60_000 ? `${s.slice(0, 60_000)}\n… truncated` : s
  } catch {
    return String(v)
  }
}

/* ------------------------------------------------------------------------- *
 * What actually exists
 * ------------------------------------------------------------------------- */

/**
 * A census of the business, from the point of view of whoever is talking.
 *
 * The tail already carried who this is, what the business is called, what is
 * remembered about them and what time it is. It did not carry **what exists** —
 * so "are there any classes yet?" cost a query the model mostly did not think to
 * run, and the answer to "what should I do next?" was improvised from nothing.
 * Driving a brand-new business made that concrete: asked what to do, the bot
 * narrated its own state machine ("we're in the setup phase, we're building your
 * roster") because that was the only fact about the business it had.
 *
 * Two properties keep this from being a script:
 *
 *  - It is **counts, not instructions.** Nothing here says what to do about an
 *    empty roster. `lib/behaviors/onboarding.md` decides that, and a behavior
 *    module is a file rather than a branch.
 *  - It runs **under this person's own RLS**, so a coach's census is their
 *    classes and a parent's is their children. Nothing needs to remember to
 *    filter it; the same query returns a different world per person, which is
 *    the property the whole product is built on.
 *
 * Never a precondition: if the census fails, the turn continues without it.
 */
async function census(id: Identity): Promise<string | null> {
  const ctx: SessionCtx = {
    role: 'user',
    academyId: id.academyId,
    personId: id.person.id,
    contactId: id.contact.id,
  }

  const q = async (sql: string): Promise<Record<string, unknown> | null> => {
    const res = await modelQuery(ctx, sql)
    return res.error ? null : ((res.rows[0] as Record<string, unknown>) ?? null)
  }
  const n = (row: Record<string, unknown> | null, key: string): number => Number(row?.[key] ?? 0)

  const many = async (sql: string): Promise<Record<string, unknown>[]> => {
    const res = await modelQuery(ctx, sql)
    return res.error ? [] : (res.rows as Record<string, unknown>[])
  }

  /**
   * A session as a person says it, not as the row stores it.
   *
   * Rendered here rather than handed over raw, because a raw `starts_at` is the
   * shape the most expensive error in the product comes out of: given `06:00:00`
   * and no rendering, replies came back saying "6pm", defended it when pushed,
   * and sent a parent to a locked hall. `inZone().label` is the same formatter the
   * rest of the product writes times with, so the tail already contains the exact
   * sentence the reply should use.
   */
  const tz = id.academy.timezone || 'Asia/Kolkata'
  const sessionLine = (r: Record<string, unknown>): string => {
    const raw = r.starts_at
    const at = raw instanceof Date ? raw : new Date(String(raw))
    if (Number.isNaN(at.getTime())) return String(r.class_name ?? 'a class')
    const who = r.who ? `${String(r.who)} — ` : ''
    const venue = r.venue ? ` at ${String(r.venue)}` : ''
    return `${who}${String(r.class_name ?? 'a class')}, ${inZone(at, tz).label}${venue}`
  }

  try {
    if (id.roles.includes('admin')) {
      const row = await q(`select
          (select count(*) from venue) as venues,
          (select count(*) from class where active) as classes,
          (select count(*) from class_slot) as slots,
          (select count(*) from coach where status = 'active') as coaches_active,
          (select count(*) from coach where status in ('added','invited')) as coaches_waiting,
          (select count(*) from account) as families,
          (select count(*) from player where active) as players,
          (select count(*) from enrollment where ended_on is null) as enrolled,
          (select count(*) from session where status = 'scheduled' and starts_at > app.now()) as upcoming,
          (select count(*) from session where status = 'scheduled'
             and starts_at between app.now() and app.now() + interval '7 days') as this_week,
          (select count(*) from message where direction = 'outbound'
             and coalesce(suppressed_reason, '') = ''
             and contact_id <> '${id.contact.id}'::uuid) as sent_to_others`)
      if (!row) return null
      // Each line carries what the count MEANS, because a bare zero is the same
      // mistake doctrine rule 11 names: true, and not the answer. "0 active
      // coaches" reads as nothing-to-see; "two added, neither invited, so
      // neither can see a thing" is the sentence somebody can act on — and it is
      // still a fact, derived here, not a plan invented by anybody.
      const waiting = n(row, 'coaches_waiting')
      const bits = [
        `${n(row, 'venues')} venue(s)`,
        `${n(row, 'classes')} class(es) with ${n(row, 'slots')} weekly slot(s)` +
          (n(row, 'classes') === 0 ? ' — so there is nothing to remind anyone about yet' : ''),
        `${n(row, 'coaches_active')} active coach(es)` +
          (waiting
            ? `, and ${waiting} added or invited who have never onboarded — they cannot see their sessions, will not be reminded, and will not know they are expected anywhere until they are invited and confirm`
            : ''),
        `${n(row, 'families')} family account(s), ${n(row, 'players')} player(s), ${n(row, 'enrolled')} live enrolment(s)`,
        `${n(row, 'upcoming')} session(s) scheduled ahead (${n(row, 'this_week')} in the next 7 days)`,
        `${n(row, 'sent_to_others')} message(s) ever sent to anyone other than this admin` +
          (n(row, 'sent_to_others') === 0 ? ' — nobody outside this conversation has heard from this business at all' : ''),
        id.academy.upi_handle ? `UPI handle set` : `no UPI handle yet, so nobody can pay`,
      ]
      return bits.map((b) => `- ${b}`).join('\n')
    }

    if (id.coachId) {
      const [row, next, unmarked] = await Promise.all([
        q(`select
          (select status from coach where id = '${id.coachId}'::uuid) as status,
          (select count(*) from class_coach where coach_id = '${id.coachId}'::uuid) as classes,
          (select count(*) from session_coach sc join session s on s.id = sc.session_id
            where sc.coach_id = '${id.coachId}'::uuid and s.status = 'scheduled' and s.starts_at > app.now()) as upcoming`),
        many(`select c.name as class_name, s.starts_at, v.name as venue
                from session_coach sc
                join session s on s.id = sc.session_id
                join class c on c.id = s.class_id
                left join venue v on v.id = coalesce(s.venue_id, c.venue_id)
               where sc.coach_id = '${id.coachId}'::uuid
                 and sc.declined_at is null
                 and s.status = 'scheduled' and s.starts_at > app.now()
               order by s.starts_at limit 4`),
        // The one thing a coach is chased about, prefetched with the id needed to
        // act on it — so "did I mark Tuesday?" is answered, and marking it is one
        // round rather than three.
        many(`select c.name as class_name, s.starts_at, s.id as session_id
                from session_coach sc
                join session s on s.id = sc.session_id
                join class c on c.id = s.class_id
               where sc.coach_id = '${id.coachId}'::uuid
                 and s.status = 'scheduled' and s.ends_at < app.now()
                 and not exists (select 1 from attendance a where a.session_id = s.id)
               order by s.starts_at desc limit 3`),
      ])
      const bits = [
        `- their coach record is "${String(row?.status ?? 'unknown')}"`,
        `- assigned to ${n(row, 'classes')} class(es), ${n(row, 'upcoming')} session(s) ahead of them`,
      ]
      if (next.length) {
        bits.push(`- their next sessions, already looked up — use these times verbatim:`)
        for (const r of next) bits.push(`    · ${sessionLine(r)}`)
      }
      if (unmarked.length) {
        bits.push(`- register(s) still unmarked, with the id to mark them:`)
        for (const r of unmarked) {
          bits.push(`    · ${sessionLine(r)} — session_id = ${String(r.session_id)}`)
        }
      }
      return bits.join('\n')
    }

    if (id.accountIds.length || id.playerIds.length) {
      const [row, next] = await Promise.all([
        q(`select
          (select count(*) from player where active) as players,
          (select count(*) from enrollment where ended_on is null) as enrolled`),
        // §9's most-asked question is "what time is his class", and it cost a round
        // every time because the tail carried a count and a bare timestamp. These are
        // the actual rows, already in their words.
        many(`select pe.full_name as who, c.name as class_name, s.starts_at, v.name as venue
                from session s
                join class c on c.id = s.class_id
                join enrollment e on e.class_id = s.class_id and e.ended_on is null
                join player pl on pl.id = e.player_id and pl.active
                join person pe on pe.id = pl.person_id
                left join venue v on v.id = coalesce(s.venue_id, c.venue_id)
               where s.status = 'scheduled' and s.starts_at > app.now()
               order by s.starts_at limit 4`),
      ])
      const bits = [
        `- ${n(row, 'players')} of their children/players on the roster, ${n(row, 'enrolled')} live enrolment(s)`,
      ]
      if (next.length) {
        bits.push(`- their next sessions, already looked up — use these times verbatim:`)
        for (const r of next) bits.push(`    · ${sessionLine(r)}`)
      } else {
        bits.push(
          `- **nothing is scheduled ahead for them at all.** Not "nothing this week" — nothing. ` +
            `Say so plainly and say what the class normally is; do not infer a next date from the weekly pattern.`,
        )
      }
      return bits.join('\n')
    }

    return `- nothing on file for them yet: no player, no enrolment, no class.`
  } catch {
    return null
  }
}

/**
 * Layer 4 + the situation. Never cached, and everything time-shaped or
 * tenant-shaped lives here rather than in the prefix.
 */
export async function variableTail(
  id: Identity,
  extra?: {
    clockNote?: string
    taskInstruction?: string
    queryResults?: unknown
    recentLookups?: string
  },
): Promise<string> {
  const tz = id.academy.timezone || 'Asia/Kolkata'
  const at = await now()
  const local = inZone(at, tz)
  const [academyMemory, personMemory, whatExists] = await Promise.all([
    hotSet('academy', id.academyId, id.academyId),
    hotSet('person', id.person.id, id.academyId),
    census(id),
  ])

  const out: string[] = []

  // --- who this is -----------------------------------------------------------
  const roles = id.roles.length ? id.roles.map((r) => ROLE_LABEL[r] ?? r).join(', ') : 'no role yet'
  const who: string[] = [
    `# Who you are talking to`,
    ``,
    `${id.person.full_name} — ${roles}.`,
  ]
  if (id.roles.length > 1) {
    who.push(
      `Roles compose: this is one person wearing several hats, in one thread. Serve all of them. Never ask them to confirm something to themselves.`,
    )
  }
  if (id.isSolo) {
    who.push(
      `This academy is the solo case — one active coach who is also the admin. Shape around it: the day and the brief are one message in one chat, there is nobody to escalate a coverage problem to, and there is no cover to offer. It is not a mode and it gates nothing.`,
    )
  }
  who.push(
    id.seesMoney
      ? `Money is visible to this person: tally lines, payments and balances may be discussed.`
      : `Money is NOT visible to this person. Tally lines, payments and balances never route here — do not quote a balance, a rate or a due amount to them.`,
  )
  if (id.person.notes) who.push(`Notes on file: ${id.person.notes}`)
  out.push(who.join('\n'))

  // --- ids, for SQL only -----------------------------------------------------
  const ids = [
    `## Ids for your SQL (never write these into a message)`,
    ``,
    `person_id = ${id.person.id}`,
    `contact_id = ${id.contact.id}`,
  ]
  if (id.coachId) ids.push(`coach_id = ${id.coachId}`)
  if (id.accountIds.length) ids.push(`account_id in (${id.accountIds.join(', ')})`)
  if (id.playerIds.length) ids.push(`player_id in (${id.playerIds.join(', ')})`)
  ids.push(
    ``,
    `RLS already scopes every query to what this person may see, so you never add a tenant filter by hand when READING, and zero rows means zero rows — not a permissions problem. Writing is the other way round: every row you INSERT must set academy_id = app.academy_id() itself.`,
  )
  out.push(ids.join('\n'))

  // --- the academy -----------------------------------------------------------
  const a = id.academy
  const ac: string[] = [
    `# The business`,
    ``,
    `Name: ${a.name}${a.category ? ` — ${a.category}` : ''}`,
    `Timezone: ${tz}. Cancellation window: ${a.cancellation_window_hours}h. Default client reminder lead: ${a.client_reminder_lead_hours}h.`,
    `Payments: ${a.rail}${a.upi_handle ? ` · UPI ${a.upi_handle}` : ' · no UPI handle set'}.`,
    `Onboarding state: ${a.onboarding_state}.`,
  ]
  if (a.onboarding_state !== 'live') {
    ac.push(
      `Not live yet. That is a rule about what you START, not about what you ANSWER: build the roster, send nobody ` +
        `anything they did not ask for, and no reminders, digests or announcements go out. Someone who messages you ` +
        `first is a conversation, and you serve it completely — a coach who has just tapped their invite gets their ` +
        `classes read back and confirms them; a parent who writes in gets a real answer. Going quiet on someone who ` +
        `spoke to you is not being quiet, it is being broken, and they cannot tell the difference.`,
    )
  }
  ac.push(
    ``,
    `Never use the word "academy" in anything you send. Use their own name for the business, or nothing at all.`,
  )
  out.push(ac.join('\n'))

  // --- what exists, from where they stand -------------------------------------
  if (whatExists) {
    out.push(
      `## What exists right now (as this person can see it)\n\n${whatExists}\n\n` +
        `These are counts, not a plan. They are here so you never have to guess whether something is set up, ` +
        `and so an empty count is something you can act on rather than something you discover mid-sentence.`,
    )
  }

  // --- memory hot sets (§5) --------------------------------------------------
  const mem: string[] = [`# Memory`, ``]
  mem.push(
    academyMemory
      ? `## About this business\n${academyMemory}`
      : `## About this business\n(nothing recorded yet)`,
  )
  mem.push(
    personMemory
      ? `## About ${id.person.full_name}\n${personMemory}`
      : `## About ${id.person.full_name}\n(nothing recorded yet)`,
  )

  const vocab = vocabularyPreferences(id.academy.memory)
  if (vocab.length) {
    mem.push(
      `## Their words\n${vocab
        .map((v) => `say "${v.prefer}", not "${v.avoid}"`)
        .join('; ')}. Use their vocabulary and never introduce your own.`,
    )
  }
  mem.push(
    `This is a bounded hot set, not everything you know. Facts are kept in full and stay searchable — if this conversation reaches for something you are not carrying, search the fact store before saying you don't know. Write new facts after replying, never instead of replying, and correct one by superseding it rather than editing.`,
  )
  out.push(mem.join('\n\n'))

  // --- now -------------------------------------------------------------------
  const dateBits = local.date.split('-')
  const prettyDate =
    dateBits.length === 3
      ? `${WEEKDAYS[local.weekday] ?? ''} ${Number(dateBits[2])} ${MONTHS[Number(dateBits[1]) - 1] ?? ''} ${dateBits[0]}`.trim()
      : local.date
  const nowBits = [
    `# Now`,
    ``,
    `It is ${local.time} on ${prettyDate}, ${tz}.`,
    `Every time you write is in that zone and in their idiom — "tomorrow 6:30pm", "Sat 8am" — never an ISO timestamp and never UTC.`,
  ]
  if (extra?.clockNote) nowBits.push(extra.clockNote)
  out.push(nowBits.join('\n'))

  // --- §10.2 mix -------------------------------------------------------------
  const createdOn = isoDateOf(a.created_on)
  if (createdOn) {
    const age = Math.max(0, daysBetween(createdOn, local.date))
    out.push(`# How much to synthesise\n\n${mixInstruction(age)}`)
  }

  // --- what you already looked up --------------------------------------------
  // History is rebuilt from message *text*, and §4.5 forbids ids in message text,
  // so every id a previous turn fetched was gone by the next one — while the tools
  // still demanded ids. That gap is where invented uuids came from: the slot had to
  // be filled and there was nothing to fill it from. These are the real rows.
  if (extra?.recentLookups) {
    out.push(
      `# What you looked up earlier in this conversation\n\n` +
        `Your own queries and their real results, newest first. Ids here are the only ids you may use — ` +
        `if what you need is not here, run the query again. Never write a uuid you have not read.\n\n` +
        extra.recentLookups,
    )
  }

  // --- the situation ---------------------------------------------------------
  if (extra?.taskInstruction) {
    out.push(`# Your task this turn\n\n${extra.taskInstruction}`)
  }
  if (extra?.queryResults !== undefined) {
    out.push(
      `# Query results in front of you\n\nEvery number you state must trace back to something in here. No baseline present means no comparison claimed.\n\n${formatQueryResults(extra.queryResults)}`,
    )
  }

  return out.join('\n\n')
}

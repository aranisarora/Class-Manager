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
import { repoRoot } from '@/lib/env'
import { now, inZone } from '@/lib/clock'
import { catalogDigest } from '@/lib/messaging/catalog'
import { operationSignatures } from '@/lib/agent/operations'
import { SCHEMA_DOC } from '@/lib/agent/schema-doc'
import { hotSet } from '@/lib/agent/memory'
import { vocabularyPreferences } from '@/lib/agent/lint'

export { lint } from '@/lib/agent/lint'

/** §4.2, in this order, always all loaded. Order is fixed: it is part of the cache key. */
const BEHAVIOR_MODULES = [
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

Nine of them, all of them always in front of you. Each opens with the condition
under which it applies — that condition is how you know the module is live, not a
menu you choose from. Two of them applying at once is normal.`,
  )
  for (const name of BEHAVIOR_MODULES) {
    parts.push(readDoc(`lib/behaviors/${name}.md`))
  }

  parts.push(
    `# Operations

Known-good plans with known-good copy. Reaching for one is cheaper and more
consistent than composing from scratch, and their arguments are already resolved
for you. They are not gates: a consequence chain nobody anticipated is composed
as a transaction of steps, with the same atomicity, the same diff and the same
staged messages.

${operationSignatures().trim()}`,
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

/**
 * Layer 4 + the situation. Never cached, and everything time-shaped or
 * tenant-shaped lives here rather than in the prefix.
 */
export async function variableTail(
  id: Identity,
  extra?: { clockNote?: string; taskInstruction?: string; queryResults?: unknown },
): Promise<string> {
  const tz = id.academy.timezone || 'Asia/Kolkata'
  const at = await now()
  const local = inZone(at, tz)
  const [academyMemory, personMemory] = await Promise.all([
    hotSet('academy', id.academyId, id.academyId),
    hotSet('person', id.person.id, id.academyId),
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
    `RLS already scopes every query to what this person may see, so you never add a tenant filter by hand, and zero rows means zero rows — not a permissions problem.`,
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
      `Not live yet: nothing goes out to parents or coaches until the admin says go. Build the roster, message nobody.`,
    )
  }
  ac.push(
    ``,
    `Never use the word "academy" in anything you send. Use their own name for the business, or nothing at all.`,
  )
  out.push(ac.join('\n'))

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

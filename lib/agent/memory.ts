/**
 * lib/agent/memory.ts — §5. CONTRACTS §6.
 *
 * @mechanism memory_fact — the append-only record, kept separate from the bounded hot set
 *   (`academy.memory` / `person.memory`) the prompt actually carries. A fact is never edited
 *   and never deleted; a correction writes a superseding row, and the live set everywhere is
 *   "not retired and not superseded". Collapsing the two into one capped blob puts the pruning
 *   decision inside a model under context pressure, where what it drops is invisible —
 *   everything outside the hot set stays reachable with `read`, so forgetting is a context
 *   decision and never a storage one.
 *
 * Two different things, deliberately not collapsed into one:
 *
 *   `memory_fact` is append-only and IS the record. Nothing the bot learned is
 *   lost because the prompt budget got tight. A fact is never edited and never
 *   deleted — a correction writes a superseding row.
 *
 *   `academy.memory` / `person.memory` are a bounded HOT SET, rebuilt from the
 *   record on a schedule. A cache, never the record.
 *
 * Collapsing them into one capped text blob is how a memory system becomes an
 * amnesia system: the pruning decision then gets made by a model under context
 * pressure, and what it drops is invisible. Anything outside the hot set stays
 * retrievable through `searchFacts` — forgetting is a context decision, never a
 * storage one.
 */
import type { SubjectKind } from '@/lib/types'
import { withSession, type SessionCtx } from '@/lib/db'
import { env } from '@/lib/env'
import { AppError, errorMessage } from '@/lib/errors'
import { generateJson } from '@/lib/agent/deepseek'

/** §5/§13 — curation runs when a subject's store crosses this, never per turn. */
export const CURATE_THRESHOLD = 12

/** ~400 tokens of hot set (§4.4). Past this it stops being bounded. */
const HOT_SET_MAX_CHARS = 1400
const HOT_SET_MAX_LINES = 12

function fail(code: string, message: string): never {
  throw new AppError({ code, message })
}

// -----------------------------------------------------------------------------
// Tenant resolution
//
// memory_fact, academy.memory and person.memory are all tenant-pinned by RLS, so
// every read needs the academy. `hotSet` and `curate` are called with a subject,
// not a session, so the academy is remembered from whichever call knew it —
// every write, every search, and `variableTail`, which passes it explicitly.
// -----------------------------------------------------------------------------

const TENANT_OF = new Map<string, string>()

/**
 * Bounded, because this is a process-lifetime cache in a process that serves
 * every tenant. It only ever grows — one entry per person anybody has written a
 * fact about — and nothing evicted it, so a long-lived worker's floor rose with
 * every new subject it ever saw. The oldest entry goes when the map is full:
 * losing one is a re-derivation from `academyId`, which every caller already
 * passes (see `hotSet`), not a wrong answer.
 */
const TENANT_OF_MAX = 5_000

function noteTenant(subjectId: string, academyId: string): void {
  if (!subjectId || !academyId) return
  if (TENANT_OF.size >= TENANT_OF_MAX && !TENANT_OF.has(subjectId)) {
    // Map iterates in insertion order, so the first key is the oldest.
    const oldest = TENANT_OF.keys().next()
    if (!oldest.done) TENANT_OF.delete(oldest.value)
  }
  TENANT_OF.set(subjectId, academyId)
}

function tenantOf(kind: SubjectKind, subjectId: string, hint?: string): string | null {
  if (kind === 'academy') return subjectId
  if (hint) {
    noteTenant(subjectId, hint)
    return hint
  }
  return TENANT_OF.get(subjectId) ?? null
}

/** `job` is global infrastructure — its cm_service policy ignores the academy GUC. */
const NIL_ACADEMY = '00000000-0000-0000-0000-000000000000'

/**
 * A curation job carries its academy in the payload it was enqueued with, so a
 * cold worker process — which has no in-memory history of the subject — can
 * still resolve the tenant it must act in.
 */
async function tenantFromJob(subjectId: string): Promise<string | null> {
  try {
    const rows = await withSession(serviceCtx(NIL_ACADEMY), async (tx) => {
      const r = await tx`
        select payload->>'academy_id' as academy_id
        from job
        where kind = 'memory_curate' and payload->>'subject_id' = ${subjectId}
        order by run_at desc
        limit 1
      `
      return r as unknown as { academy_id: string | null }[]
    })
    const found = rows[0]?.academy_id ?? null
    if (found) noteTenant(subjectId, found)
    return found
  } catch {
    return null
  }
}

function serviceCtx(academyId: string): SessionCtx {
  // §6.7: the fact store is infrastructure — reached by the runtime's own role,
  // never through a user session, which has SELECT on it and nothing more.
  return { role: 'service', academyId }
}

// The live set, everywhere below, is: retired_at is null AND not superseded by a
// newer row. Superseding is how a correction lands — the old row stays.

// -----------------------------------------------------------------------------
// The placement gate — §5's test, enforced at the write (F-D).
//
// "Memory holds only what the schema cannot" lived in prose for a driven month,
// and the store ended it poisoned: the full timetable with rates (T004), a coach's
// phone and pay (T006), the UPI handle (T011), and an invented pro-rata policy
// priced in rupees (T066) — the judges' only outright fail. The generator is a
// model; the gate cannot be. What CAN be checked deterministically is the shape
// no legitimate memory fact in the whole drive ever had: a rupee figure, a phone
// number, a UPI handle, or a multi-day schedule — every one of those lives in a
// row, and a memory copy is a future wrong answer waiting for the row to change.
//
// Deliberately partial. "Boards in March", "needs three hours' notice", "not
// before 8am", "asks about money every Monday" all pass — a time or a single day
// is how preferences are said. What is refused is the copy of the row, and the
// refusal says what to keep instead.
// -----------------------------------------------------------------------------

const WEEKDAY_RE = /\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day)?\b/gi
const CLOCK_RE = /\b\d{1,2}([:.]\d{2})\s*(am|pm)?\b|\b\d{1,2}\s*(am|pm)\b/i
const DAY_DATE_RE = /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i

/**
 * A rule about how the business runs, which has a table of its own now.
 *
 * @mechanism policyShapedFact — refuses a fact that reads as a rule about how the business
 *   runs, and names `business_rule` as its home: the owner's own words, provenance (stated
 *   versus merely observed), and whether anything enforces it. Without it a rule the model
 *   invented and then remembered itself saying acquires the authority of a fact — from the
 *   next turn on it is indistinguishable from something the owner decided. Narrow on purpose:
 *   universals about the BUSINESS, not a habit of one person.
 *
 * **"The existence of policy" is on the never-trust list, and memory is where it
 * used to get in.** The model invented a pro-rata refund policy for a prospect,
 * remembered itself saying it, and the invention acquired the authority of a
 * fact — indistinguishable, from the next turn on, from something the owner had
 * stated. The same shape in the driven record: *"Tasks involving 'ensuring a
 * brief is triggered' are considered complete once the message has been sent"* —
 * a rule the product wrote about itself, kept as though somebody had decided it.
 *
 * 0032 gives the real thing a row: `business_rule`, carrying the owner's own
 * words, provenance (stated versus merely observed), and whether anything
 * actually enforces it. An observation is a suggestion there until the owner
 * blesses it, which is what the two-tap protocol exists for — and that is a
 * different fact from a preference, which memory keeps happily.
 *
 * Deliberately narrow, like the gate above it. Universals about the BUSINESS,
 * not about a person: "she always asks on a Monday" is a habit and passes;
 * "we always refund the unused weeks" is a policy and does not.
 */
const POLICY_SUBJECT =
  /\b(?:we|our|the (?:business|academy|club|centre|center|school)|policy|rule)\b/i
const POLICY_FORCE =
  /\b(?:always|never|automatically|by default|as a rule|standard practice|every time|whenever|entitled to|must be|are not allowed|do not allow|policy is|refunds?|pro-?rata|waivers? are)\b/i

export function policyShapedFact(fact: string): string | null {
  const f = String(fact ?? '')
  if (!POLICY_SUBJECT.test(f) || !POLICY_FORCE.test(f)) return null
  return (
    'it reads as a rule about how the business runs, and that is not a memory fact — it is a business_rule ' +
    'row, with the owner\'s own words and provenance on it. If the owner stated it, put it there as ' +
    'owner_stated. If you noticed it, it is a suggestion until they bless it, and it must never be stored ' +
    'as though it were settled. If the only reason it seems true is that you said it, it is not true yet.'
  )
}

/**
 * @mechanism rowShapedFact — the placement gate, enforced at the record and not only at the
 *   tool: a fact carrying a rupee figure, a phone number, a payment handle or a multi-day
 *   timetable is refused, because every one of those lives in a row and a memory copy is a
 *   future wrong answer waiting for the row to change. The generator is a model and the gate
 *   cannot be, so it tests the one thing the string decides — shape — and the refusal says
 *   what to keep instead. Deliberately partial: a time or a single day is how preferences
 *   are said. A bare amount-per-period ("8000/month", "400 per session") is a rate and is
 *   refused like a marked one: on the 23 Aug ace month, "coach pay: Arjun 8000/month"
 *   passed while its ₹-marked twin was refused — the gate was reading the currency MARK,
 *   and a rate does not stop being a row for want of one.
 */
export function rowShapedFact(fact: string): string | null {
  const f = String(fact ?? '')
  if (
    /₹\s*\d|\brs\.?\s*\d|\binr\s*\d/i.test(f) ||
    /\b\d{3,}\s*(?:\/|per\s+)(?:month|session|hour|week|day|class)\b/i.test(f)
  ) {
    return 'it carries a rupee figure — rates, balances and charges are rows, and a memory copy goes stale the day the row changes. Keep the preference or the event; drop the amount.'
  }
  if (/\+?\d{10,}/.test(f.replace(/[\s-]/g, ''))) {
    return 'it carries a phone number — contacts are rows. Say who the person is; the tables say how to reach them.'
  }
  if (/\b[\w.-]+@[a-z][\w]*\b/i.test(f)) {
    return 'it carries a payment handle — that is a row on the business. The tables hold where money goes.'
  }
  const weekdays = new Set((f.match(WEEKDAY_RE) ?? []).map((w) => w.slice(0, 3).toLowerCase()))
  if (weekdays.size >= 2 && (CLOCK_RE.test(f) || DAY_DATE_RE.test(f))) {
    return 'it reads back the timetable — schedules are rows, and this copy is wrong the day a slot moves. Keep what the schema cannot hold (their word for the class, a habit); drop the days and times.'
  }
  return null
}

// -----------------------------------------------------------------------------
// writeFact — append-only, always
// -----------------------------------------------------------------------------

export async function writeFact(
  ctx: SessionCtx,
  f: {
    subjectKind: SubjectKind
    subjectId: string
    fact: string
    source?: string
    supersedes?: string
  },
): Promise<string> {
  const fact = f.fact.trim()
  if (!fact) fail('memory_empty_fact', 'writeFact called with an empty fact')
  // The placement gate holds at the record, not only at the tool — a future
  // caller that skips the tool's own check still cannot poison the store.
  const rowShaped = rowShapedFact(fact) ?? policyShapedFact(fact)
  if (rowShaped) fail('memory_row_shaped', `not stored: ${rowShaped}`)
  if (f.subjectKind === 'academy' && f.subjectId !== ctx.academyId) {
    fail('memory_wrong_tenant', 'an academy fact must be about the acting academy')
  }
  noteTenant(f.subjectId, ctx.academyId)

  const written = await withSession(serviceCtx(ctx.academyId), async (tx) => {
    if (f.subjectKind === 'person') {
      const owner = (await tx`
        select 1 from person where id = ${f.subjectId} limit 1
      `) as unknown as unknown[]
      if (owner.length === 0) {
        fail('memory_wrong_tenant', 'no such person in this academy')
      }
    }

    // Append-only does not mean append-twice. An identical live fact is already
    // the record; re-stating it adds noise to every future curation.
    const existing = (await tx`
      select id from memory_fact
      where subject_kind = ${f.subjectKind}
        and subject_id = ${f.subjectId}
        and fact = ${fact}
        and retired_at is null
      limit 1
    `) as unknown as { id: string }[]
    if (existing.length > 0 && !f.supersedes) return { id: existing[0].id, curateBatch: null }

    const inserted = (await tx`
      insert into memory_fact (academy_id, subject_kind, subject_id, fact, source, supersedes)
      values (${ctx.academyId}, ${f.subjectKind}, ${f.subjectId}, ${fact},
              ${f.source ?? null}, ${f.supersedes ?? null})
      returning id
    `) as unknown as { id: string }[]

    const liveCount = (await tx`
      select count(*)::int as n from memory_fact
      where subject_kind = ${f.subjectKind} and subject_id = ${f.subjectId}
        and retired_at is null
        and id not in (select supersedes from memory_fact where supersedes is not null)
    `) as unknown as { n: number }[]

    const n = liveCount[0]?.n ?? 0
    const crossed = n > 0 && n % CURATE_THRESHOLD === 0
    return {
      id: inserted[0].id,
      curateBatch: crossed ? Math.floor(n / CURATE_THRESHOLD) : null,
    }
  })

  // §5: curation is scheduled, not per-turn — rebuilding the hot set is a model
  // call, and running one after every turn roughly doubles the model calls in
  // the product for no benefit. Enqueued in its own session, after the fact is
  // committed: a scheduling failure is a stale cache, never a lost fact. The
  // dedupe key makes a second crossing of the same threshold a no-op (§13).
  if (written.curateBatch !== null) {
    const payload = JSON.stringify({
      academy_id: ctx.academyId,
      subject_kind: f.subjectKind,
      subject_id: f.subjectId,
    })
    const dedupeKey = `mem:${f.subjectId}:${written.curateBatch}`
    try {
      await withSession(serviceCtx(ctx.academyId), async (tx) => {
        await tx`
          select app.enqueue_job('memory_curate', app.now(), ${dedupeKey}, ${payload}::text::jsonb)
        `
      })
    } catch {
      // The record is already written. Never fail a fact over its cache.
    }
  }

  return written.id
}

// -----------------------------------------------------------------------------
// hotSet — the bounded cache the prompt actually carries
// -----------------------------------------------------------------------------

/**
 * The academy is REQUIRED, and that is the whole fix.
 *
 * @mechanism hotSet — the memory read the prompt carries, with the three states nothing else
 *   here distinguished: `null` is a FAILED read, `''` is a subject with genuinely nothing
 *   recorded, and a subject whose facts exist but have not yet been compacted says so and
 *   says where they are. That third one was the common case and it read as the second: the
 *   summary is written by `curate` on crossing a multiple of CURATE_THRESHOLD live facts, so
 *   everything stored before the twelfth was invisible while the tail said "(nothing recorded
 *   yet)" — 38 of 38 context-bearing turns of `2026-08-22-08-13-sim-7bo8`, over a run in which
 *   `remember` was called and succeeded. A tool whose output the model can never see is a tool
 *   it has no reason to keep using.
 *   The tail renders an empty hot set as "(nothing recorded yet)", so a refused or timed-out
 *   read told the model, in as many words, that it had never been told anything about a
 *   business it has served for months. The reason for the failure rides back with the null,
 *   and the required `academyId` closes the other door to the same wrong answer — the
 *   process-local tenant map is empty on every cold start.
 *
 * It used to be optional, falling back to `TENANT_OF` — a module-level Map populated by
 * whichever earlier call happened to know the tenant. In a warm process that works. In a
 * cold one the Map is empty, `tenantOf` returns null, and this returned `''`: **"this
 * person has no memory."** Not an error, not a log line — the same empty string a person
 * who genuinely has no memory yet produces, handed to the prompt as fact.
 *
 * All five callers already passed it, so this never fired. That is exactly what makes it
 * worth closing now rather than after: the signature invited the sixth caller to omit it,
 * and on serverless every request is a cold process. A required parameter is a guarantee
 * the compiler enforces for callers nobody has written yet — cheaper than remembering,
 * and it cannot be skipped.
 */
export async function hotSet(
  subjectKind: SubjectKind,
  subjectId: string,
  academyId: string,
): Promise<{ value: string | null; why: string | null }> {
  const tenant = tenantOf(subjectKind, subjectId, academyId)
  // Unreachable through the type, reachable through an empty string. Loud, because
  // returning '' here is indistinguishable from an empty memory and always was.
  if (!tenant) throw new Error(`memory.hotSet: no academy for ${subjectKind} ${subjectId}`)
  try {
    const rows = await withSession(serviceCtx(tenant), async (tx) => {
      const r =
        subjectKind === 'academy'
          ? await tx`select memory from academy where id = ${subjectId}`
          : await tx`select memory from person where id = ${subjectId}`
      return r as unknown as { memory: string | null }[]
    })
    const value = (rows[0]?.memory ?? '').trim()
    if (value) return { value, why: null }

    /**
     * A THIRD state, because `''` was two different facts wearing one string.
     *
     * The hot set is a compacted summary written by `curate`, which runs on crossing a
     * multiple of `CURATE_THRESHOLD` live facts — twelve. Everything `remember` stores
     * before the twelfth is real, is in `memory_fact`, and is invisible: the tail renders
     * an empty hot set as "(nothing recorded yet)", so the model is told it has learned
     * nothing about a business it has been storing facts about all week. Measured on
     * `2026-08-22-08-13-sim-7bo8`: "## About this business — (nothing recorded yet)" on 38
     * of 38 context-bearing turns, over a run in which `remember` was called and succeeded.
     *
     * So an empty summary now says whether there is anything BEHIND it. Not the facts
     * themselves — that is `curate`'s job and this must not become a second, uncompacted
     * copy of it — but the count and where to read them, which is what turns "nothing
     * recorded" from a false statement into a true one with a route out of it.
     */
    /**
     * @mechanism uncompacted — below the threshold the hot set IS the facts, in the order
     *   they were learned, rather than a count of them and an address to go and read.
     *
     *   The third state this replaces was right that the tail must stop saying "(nothing
     *   recorded yet)" over a subject with facts on file, and it fixed that sentence
     *   completely. What it did not do was put the fact in front of the model: it handed
     *   over `n` and a `select`, on the argument that rendering them here would be a
     *   second uncompacted copy of what `curate` compacts. That argument holds ABOVE the
     *   threshold and inverts below it — `curate` writes the summary on crossing a
     *   multiple of `CURATE_THRESHOLD` live facts, so under twelve there is no first copy
     *   for this to be the second of. This branch is only ever reached when none exists.
     *
     *   Measured over the four runs of 22 Aug 2026, three of them carrying that third
     *   state: 46 `remember` calls and 4 reads of `memory_fact`. On `b8xo` the tail said
     *   "3 fact(s) recorded … read memory_fact if what you need is not in front of you" on
     *   34 turns and the model went and looked ONCE. A pointer followed one time in
     *   thirty-four is not a route, and the facts it pointed at were about an owner who
     *   left on day 20 because the product kept asking him something he had answered.
     *
     *   Every business is under twelve facts for the whole of its setup, which is the
     *   stretch where what it has just been told is the only thing worth remembering.
     *
     *   Bounded by the SAME budget `curate` writes against — `HOT_SET_MAX_LINES` and
     *   `HOT_SET_MAX_CHARS`, the ~400 tokens §4.4 allows a hot set — so the prompt cannot
     *   grow past what a compacted summary would have cost, and the two states of this
     *   field are the same size. Oldest first, so what falls off is what curation would
     *   have folded away, and the address still rides along whenever anything was left
     *   out — the case the third state was built for, now reached only when it is true.
     */
    // The LIVE set, with both halves of its definition (memory.ts's own header:
    // "retired_at is null AND not superseded"). The first draft filtered only on
    // retired_at, and corrections deliberately keep both rows — so a corrected-away
    // fact rendered as current, FIRST (oldest-first ordering), while the correction
    // could fall off the budget entirely. Same predicate as curate's query.
    const uncompacted = await withSession(serviceCtx(tenant), async (tx) => {
      const r = subjectKind === 'academy'
        ? await tx`select fact from memory_fact
                    where academy_id = ${subjectId} and subject_kind = 'academy' and retired_at is null
                      and id not in (select supersedes from memory_fact
                                      where supersedes is not null and academy_id = ${subjectId})
                    order by created_at asc limit ${HOT_SET_MAX_LINES + 1}`
        : await tx`select fact from memory_fact
                    where subject_kind = 'person' and subject_id = ${subjectId} and retired_at is null
                      and id not in (select supersedes from memory_fact where supersedes is not null)
                    order by created_at asc limit ${HOT_SET_MAX_LINES + 1}`
      return r as unknown as { fact: string }[]
    })
    if (!uncompacted.length) return { value: '', why: null }

    const lines: string[] = []
    let budget = HOT_SET_MAX_CHARS
    for (const { fact } of uncompacted.slice(0, HOT_SET_MAX_LINES)) {
      const line = `- ${String(fact ?? '').trim()}`
      if (line.length > budget) break
      budget -= line.length + 1
      lines.push(line)
    }
    const shown = lines.length
    return {
      value:
        lines.join('\n') +
        (shown < uncompacted.length
          ? `\n(${shown} of what is on file; the rest is in memory_fact — subject_kind = '${subjectKind}'` +
            `${subjectKind === 'person' ? `, subject_id = '${subjectId}'` : ''}, retired_at is null)`
          : ''),
      why: null,
    }
  } catch (e) {
    /**
     * **null is a failed read; '' is a subject with nothing recorded.** These were
     * one value, and they are opposite sentences by the time they reach a person:
     * the tail renders an empty hot set as "(nothing recorded yet)", so a refused
     * or timed-out read told the model, in as many words, that it had never been
     * told anything about this business — and it then behaves like a first meeting
     * with somebody it has served for months.
     *
     * The old comment here justified '' on the grounds that "searchFacts still
     * reaches it". `searchFacts` was deleted as dead code; nothing reaches past
     * this now except a `read` the model has to think to run, which it will not do
     * if it believes the answer is "nothing recorded".
     *
     * Still not a dead turn — the caller decides. It just has to be able to.
     *
     * The REASON rides along now, for the same argument one layer down: "could not
     * be read" states a gap and withholds the one fact the runtime holds about it,
     * while doctrine forbids the model from supplying the rest. See `Read` in
     * `context.ts` for what that cost on the record.
     */
    return { value: null, why: errorMessage(e).split(/\r?\n/)[0].trim().slice(0, 200) }
  }
}

// -----------------------------------------------------------------------------
// Reaching past the hot set
//
// There used to be a `searchFacts` here: ILIKE over the live fact set, re-ranked
// with character trigrams and a Dice coefficient, ~75 lines. It was built for a
// `recall` tool that no longer exists, and after that tool was removed nothing
// ever called it — the only surviving reference was a dead import in `tools.ts`,
// which is why it read as live to anything counting references.
//
// The capability itself is not gone, and that is why deleting this costs nothing:
// `memory_fact` is in `SCHEMA_DOC`, including the live-set predicate
// (`retired_at is null and id not in (select supersedes …)`), so the model reaches
// past the hot set with `read` like it reaches everything else. One query surface,
// not two — "search the fact store before saying you don't know" is satisfied by
// the tool that actually exists.
// -----------------------------------------------------------------------------

// -----------------------------------------------------------------------------
// curate — rebuild the hot set from the live fact set. Scheduled, not per-turn.
// -----------------------------------------------------------------------------

const CURATE_SYSTEM = `You maintain the memory of a WhatsApp manager for a coaching business.

You are given the complete live fact set held about one subject — either the
business itself or one person. Rebuild the bounded hot set: the handful of facts
worth carrying in every prompt from now on.

Rules:
- Facts, not transcripts. "Prefers voice notes over typing", never "said on the 4th that…".
- Facts, not rows. A rate, a balance, a phone number, a payment handle, a schedule,
  who pays for whom — the database holds those, and a memory copy goes stale the day
  the row changes. Drop any line that restates one, however confidently it was stored,
  and keep only the half the schema cannot hold.
- Facts, not policy. A rule about how the business runs — refunds, age limits, what
  is always or never done — belongs in business_rule with the owner's own words and
  its provenance on it, not here. Drop any line of that shape, and drop it hardest
  when it reads as something the product decided about itself: a rule nobody stated,
  kept as memory, becomes indistinguishable from one the owner set.
- Keep only facts that change behavior: vocabulary, timing preferences, policies,
  standing constraints, what this person routinely asks for, how they like to be
  contacted. A fact that changes nothing is a diary entry — drop it.
- When two facts conflict, the newer one wins. Do not carry both.
- Merge duplicates and near-duplicates into one clear line.
- Vocabulary and standing policy first; habits second; one-off details last.
- No ids, no timestamps, no dates unless the date is the point ("boards in March").
- Each line short and plain, under 140 characters. At most 12 lines.
- Dropping a fact here does not delete it — the full record stays searchable. Be
  willing to leave things out.

Return JSON: {"lines": ["...", "..."]}`

/**
 * @mechanism curate — rebuilds the hot set from the live fact set on a schedule, never per
 *   turn: `writeFact` enqueues a `memory_curate` job only when a subject crosses
 *   CURATE_THRESHOLD live facts, under a dedupe key that makes a second crossing of the same
 *   threshold a no-op. Curating per turn is a model call after every turn, roughly doubling
 *   the model calls in the product; enqueuing in its own session after the fact has committed
 *   makes a scheduling failure a stale cache and never a lost fact, and nothing usable back
 *   twice running leaves the existing hot set alone.
 */
export async function curate(
  subjectKind: SubjectKind,
  subjectId: string,
  academyId?: string,
): Promise<void> {
  const tenant = tenantOf(subjectKind, subjectId, academyId) ?? (await tenantFromJob(subjectId))
  if (tenant === null) {
    throw new AppError({
      code: 'memory_unknown_tenant',
      message: `curate(${subjectKind}, ${subjectId}) has no academy to act in: none passed, none remembered, and no memory_curate job carries one`,
    })
  }

  const facts = await withSession(serviceCtx(tenant), async (tx) => {
    const r = await tx`
      select fact, created_at from memory_fact
      where subject_kind = ${subjectKind} and subject_id = ${subjectId}
        and retired_at is null
        and id not in (select supersedes from memory_fact where supersedes is not null)
      order by created_at asc
      limit 500
    `
    return r as unknown as { fact: string; created_at: Date | string }[]
  })

  if (facts.length === 0) {
    await writeHotSet(tenant, subjectKind, subjectId, null)
    return
  }

  const listing = facts
    .map((f, i) => `${i + 1}. [${isoDay(f.created_at)}] ${f.fact}`)
    .join('\n')

  // Asked for as json rather than constrained to it — this API has no stable
  // schema enforcement — so the shape is stated in the prompt and `generateJson`
  // validates it and retries once. The old prose fallback — split whatever came
  // back on newlines and hope — is gone with it: a retry that asks again is a
  // better answer than a paragraph reinterpreted as a list, and this is a batch
  // path where the retry costs nobody anything.
  const res = await generateJson<string[]>({
    system: CURATE_SYSTEM,
    messages: [
      {
        role: 'user',
        content:
          `Subject: ${subjectKind === 'academy' ? 'the business' : 'one person'}\n` +
          `Live facts, oldest first:\n\n${listing}\n\n` +
          'Answer as one json object and nothing else, in exactly this shape:\n' +
          '{"lines": ["one kept fact per string", "another"]}',
      },
    ],
    model: env.MODEL_SYNTH,
    temperature: 0.2,
    maxOutputTokens: 2048,
    validate: (v) => {
      const o = v as { lines?: unknown }
      if (!o || typeof o !== 'object' || !Array.isArray(o.lines)) return null
      return o.lines.filter((l): l is string => typeof l === 'string')
    },
  })

  // Nothing usable came back twice running. The existing hot set is the better
  // answer than an empty one: curation improves a memory, it does not own it.
  if (!res.value) return

  const memo = bound(res.value)
  await writeHotSet(tenant, subjectKind, subjectId, memo)
}

async function writeHotSet(
  academyId: string,
  subjectKind: SubjectKind,
  subjectId: string,
  memo: string | null,
): Promise<void> {
  await withSession(serviceCtx(academyId), async (tx) => {
    if (subjectKind === 'academy') {
      await tx`update academy set memory = ${memo} where id = ${subjectId}`
    } else {
      await tx`update person set memory = ${memo} where id = ${subjectId}`
    }
  })
}

function bound(lines: string[]): string | null {
  const out: string[] = []
  let chars = 0
  for (const line of lines) {
    const clean = line.trim().replace(/\s+/g, ' ')
    if (!clean) continue
    if (out.length >= HOT_SET_MAX_LINES) break
    if (chars + clean.length + 3 > HOT_SET_MAX_CHARS) break
    out.push(`- ${clean}`)
    chars += clean.length + 3
  }
  return out.length ? out.join('\n') : null
}

function isoDay(v: Date | string): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

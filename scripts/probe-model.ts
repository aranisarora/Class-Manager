/**
 * probe-model — judge a model on what the person actually got.
 *
 *   npx tsx scripts/probe-model.ts [--models a,b] [--case setup-small] [--keep]
 *
 * WHY THIS WAS REWRITTEN
 * -----------------------------------------------------------------------------
 * The previous version scored one thing: did a tool name appear in round one. It
 * called `generate` directly, never ran the tools, and stopped after a single
 * round — so by construction it could not see any of the three things that
 * actually decide whether a model is good enough for this product:
 *
 *   1. WHAT THE PERSON GOT. The reply is composed in a LATER round, after tool
 *      results come back. A single-round harness never sees a sentence at all on
 *      any write turn. It cannot judge wording, buttons, or plainness.
 *   2. WHETHER IT DID WHAT IT SAID. "Did everything it promised" is a property of
 *      a whole turn — several rounds, real tool results, real rows. A harness
 *      that executes nothing can only see intent, never follow-through. And
 *      scoring `functionCalls.some(f => acts.includes(f.name))` is a name match:
 *      `plan` with garbage steps scored identically to `plan` with right ones.
 *   3. COST. Matters least and can be traded away, so it is reported and never
 *      ranked on.
 *
 * It also produced two false readings that made the old numbers untrustworthy:
 * `read-then-say` demanded a lookup for a question whose answer was already in
 * the context tail, so a correct answer scored as a miss and a wasteful extra
 * round scored as a win.
 *
 * WHAT IT DOES NOW
 * -----------------------------------------------------------------------------
 * Drives `runTurn` — the real loop, real tools, real database, real multi-round
 * behaviour — through a scripted onboarding arc, in a FRESH ACADEMY PER MODEL so
 * no condition can see another's rows. After every turn it records the reply as
 * the person received it (post-lint, post-compose), the buttons, the full tool
 * trace, and what is actually true in the database.
 *
 * It reports evidence. It deliberately does NOT compute an overall score:
 * nothing here knows what good looks like for a particular business, and the
 * failures worth catching are the ones a person notices by reading. `score.md`
 * is written for exactly that.
 *
 * ONE MODEL PER PROCESS, ON PURPOSE
 * -----------------------------------------------------------------------------
 * `lib/env.ts` memoises the parsed environment on first read and freezes it, and
 * `loop.ts` takes the model from `env.MODEL_MAIN`. So a model cannot be swapped
 * in-process without lying about which one ran. The parent spawns one child per
 * model with `MODEL_MAIN` set in its environment, which also gives every model a
 * genuinely cold prompt cache — the honest starting condition for a cost reading.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadEnvFiles, c } from './_env'

const argv = process.argv.slice(2)
function flag(name: string, fallback = ''): string {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i === -1) return fallback
  const a = argv[i] as string
  return a.includes('=') ? a.slice(a.indexOf('=') + 1) : (argv[i + 1] ?? fallback)
}
const has = (name: string) => argv.includes(`--${name}`)

const MODELS = flag('models', 'gemini-2.5-flash,gemini-3-flash-preview')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const ONLY = flag('case')
const OUT_DIR = flag('out', join(process.cwd(), '.probe'))

/* -------------------------------------------------------------------------- *
 * The arc
 *
 * Cases run IN ORDER against ONE academy and the state accumulates, because that
 * is the only way three of the five questions can be asked at all:
 *   - follow-through is "does what it promised in turn 2 exist in turn 2"
 *   - a lookup is only a lookup once the answer has stopped being in the prompt
 *   - a watch is only discretionary once there is something worth watching
 * -------------------------------------------------------------------------- */

type Check = { label: string; ok: boolean; detail: string }
type Sql = <T = any>(sql: string) => Promise<T[]>

type Case = {
  name: string
  what: string
  text: string
  /** Reaching for none of these is a tool-choice failure worth naming. */
  wants: string[]
  /** What must actually be true afterwards. Empty for pure-conversation turns. */
  expect: (q: Sql) => Promise<Check[]>
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim()

/** A check whose detail is the rows themselves, so a failure is readable. */
function check(label: string, ok: boolean, detail: unknown): Check {
  return { label, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) }
}

/* -------------------------------------------------------------------------- *
 * Invariants — run after EVERY case, whatever the case was about
 *
 * The obvious way to keep a harness honest is a case per bug, and it is the way
 * that rots: the file grows monotonically, each case exercises one sentence, and
 * after a dozen rounds nobody runs the thing because it takes an hour. It also
 * tests the wrong thing — a case reproduces the *instance*, and every finding in
 * FINDINGS.md is filed as a class precisely because the instance is not the point.
 *
 * These are statements about the world that must hold no matter what was said.
 * They cost one query each, they run against whatever state the arc has built by
 * then, and a defect anywhere in the class trips them — including from a sentence
 * nobody thought to write a case for. Four findings from the last round are caught
 * here by three checks, none of which mentions the sentence that produced it.
 *
 * The bar for adding one: it must be a property of the data or the outbound
 * record, true for every business, checkable in SQL, and false today only if
 * something is actually wrong. Anything needing a specific prompt is a case, not
 * an invariant — and should probably fold into one of the five that exist.
 * -------------------------------------------------------------------------- */

const INVARIANTS: { label: string; run: (q: Sql) => Promise<Check> }[] = [
  {
    // F6. A class whose slots are all Saturday cannot begin on a Sunday, or its
    // first week silently does not exist — the calendar looks right and the
    // sessions are simply absent.
    label: 'every class starts on one of its own weekdays',
    run: async (q) => {
      const bad = await q(`
        select c.name, c.starts_on::text,
               extract(dow from c.starts_on)::int as start_dow,
               array_agg(distinct cs.weekday order by cs.weekday) as slot_days
          from class c join class_slot cs on cs.class_id = c.id
         group by c.id, c.name, c.starts_on
        having not (extract(dow from c.starts_on)::int = any(array_agg(cs.weekday)))`)
      return check('every class starts on one of its own weekdays', bad.length === 0, bad)
    },
  },
  {
    // F7. One human is one person row. Two rows with the same name in one
    // business is either a duplicate or two people the product cannot tell
    // apart — both are defects and neither has ever been visible.
    label: 'no two people share a name',
    run: async (q) => {
      const bad = await q(`
        select lower(btrim(full_name)) as name, count(*)::int as n
          from person group by 1 having count(*) > 1`)
      return check('no two people share a name', bad.length === 0, bad)
    },
  },
  {
    // F7 again, from the other side: a player and their account holder being the
    // same human is the self-payer, which is correct. A player whose person has
    // the same NAME as the holder but a different id is the bug.
    label: 'no player is a duplicate of their own account holder',
    run: async (q) => {
      const bad = await q(`
        select ph.full_name as player, ah.full_name as holder
          from player pl
          join person ph on ph.id = pl.person_id
          join account a on a.id = pl.account_id
          join person ah on ah.id = a.holder_person_id
         where ph.id <> ah.id
           and lower(btrim(ph.full_name)) = lower(btrim(ah.full_name))`)
      return check('no player is a duplicate of their own account holder', bad.length === 0, bad)
    },
  },
  {
    // F4/F5. Repetition is invisible in a transcript read one message at a time
    // and obvious in one query. Scoped to what actually went out.
    label: 'nobody was told the same thing twice',
    run: async (q) => {
      const bad = await q(`
        select contact_id, left(body, 60) as body, count(*)::int as n
          from message
         where direction = 'outbound' and suppressed_reason is null and btrim(body) <> ''
         group by contact_id, body having count(*) > 1`)
      return check('nobody was told the same thing twice', bad.length === 0, bad)
    },
  },
  {
    // F8. Operator vocabulary is correct for an admin and wrong for everybody
    // else, and the receipt is minted once and replayed to whoever taps. This
    // catches the shape rather than the string: a row count opening a sentence.
    label: 'no row-counting receipt reached a non-admin',
    run: async (q) => {
      const bad = await q(`
        select p.full_name, left(m.body, 80) as body
          from message m
          join contact ct on ct.id = m.contact_id
          join person p on p.id = ct.person_id
         where m.direction = 'outbound' and m.suppressed_reason is null
           and m.body ~* '^(changed|added|removed|updated) [0-9]+ '
           and not exists (select 1 from academy_admin aa where aa.person_id = ct.person_id)`)
      return check('no row-counting receipt reached a non-admin', bad.length === 0, bad)
    },
  },
  {
    // §2.2 and §14.6. A JSON blob in the prose and a link pasted as text are the
    // two ways a message arrives looking broken; both are structural, so both
    // belong here rather than in anybody's eyes.
    //
    // wa.me and friends are exempt, and that is not a loophole: §8.1's invite is a
    // link the admin FORWARDS, so there the text is the artifact and a button would
    // destroy it. Same predicate as `isForwardableLink` in `messaging/types.ts` —
    // if that one changes, this must too, which is the cost of stating it twice and
    // is cheaper than a harness that fails on every correct invite.
    label: 'no message carries raw structure or a bare url',
    run: async (q) => {
      const bad = await q(`
        select left(body, 80) as body from message
         where direction = 'outbound' and suppressed_reason is null
           and (body like '%"buttons"%'
                or body ~* 'https?://(?!wa\\.me|api\\.whatsapp\\.com|chat\\.whatsapp\\.com)')`)
      return check('no message carries raw structure or a bare url', bad.length === 0, bad)
    },
  },
]

async function runInvariants(q: Sql): Promise<Check[]> {
  const out: Check[] = []
  for (const inv of INVARIANTS) {
    try {
      out.push(await inv.run(q))
    } catch (e) {
      out.push(check(inv.label, false, `invariant query failed: ${(e as Error)?.message ?? String(e)}`))
    }
  }
  return out
}

const CASES: Case[] = [
  {
    name: 'setup-small',
    what: 'one class, one sentence — the commonest onboarding turn there is',
    text: 'add a beginners batch mon wed fri 6.30 to 7.30pm at green park, 1500 a month',
    wants: ['act', 'plan'],
    expect: async (q) => {
      const venues = await q(`select name from venue`)
      const classes = await q(`select id, name from class where active`)
      const beginners = classes.find((r: any) => norm(r.name).includes('beginner'))
      const slots = beginners
        ? await q(
            `select weekday, start_time::text, end_time::text from class_slot
              where class_id = '${beginners.id}'::uuid order by weekday`,
          )
        : []
      const sessions = beginners
        ? await q(`select count(*)::int as n from session where class_id = '${beginners.id}'::uuid`)
        : [{ n: 0 }]
      // 6.30pm written as "6.30" is the exact shape that produced a 06:30 class
      // in the database and a "6:30pm" read-back in the reply. Both halves
      // confident, one of them wrong (FINDINGS, C-series).
      const pm = slots.every((s: any) => String(s.start_time).startsWith('18:'))
      return [
        check('venue "green park" exists', venues.some((v: any) => norm(v.name).includes('green park')), venues),
        check('a beginners class exists', Boolean(beginners), classes),
        check('3 weekly slots, Mon/Wed/Fri', slots.length === 3 && [1, 3, 5].every((d) => slots.some((s: any) => Number(s.weekday) === d)), slots),
        check('start time is 18:30, not 06:30', slots.length > 0 && pm, slots.map((s: any) => `${s.start_time}-${s.end_time}`)),
        check('sessions were scheduled', Number(sessions[0]?.n ?? 0) > 0, `${sessions[0]?.n ?? 0} sessions`),
      ]
    },
  },
  {
    name: 'compose-big',
    what: 'the follow-through test — several classes, families and enrolments in one sentence',
    text:
      'also add advanced sat 8 to 10am at green park 2500 a month. families: meera iyer +919880077889 ' +
      'with her son aarav who is 9, and kiran shah +919880099001 with two kids ananya 11 and dev 7. ' +
      'put aarav and ananya in beginners and dev in advanced.',
    wants: ['act', 'plan'],
    expect: async (q) => {
      const classes = await q(`select id, name from class where active`)
      const advanced = classes.find((r: any) => norm(r.name).includes('advanc'))
      const slots = advanced
        ? await q(`select weekday, start_time::text, end_time::text from class_slot where class_id = '${advanced.id}'::uuid`)
        : []
      const people = await q(`select full_name from person`)
      const players = await q(`select pl.id, p.full_name from player pl join person p on p.id = pl.person_id where pl.active`)
      const enrol = await q(
        `select p.full_name as who, cl.name as class from enrollment e
           join player pl on pl.id = e.player_id
           join person p on p.id = pl.person_id
           join class cl on cl.id = e.class_id
          where e.ended_on is null`,
      )
      const named = (list: any[], field: string, want: string) => list.some((r: any) => norm(r[field]).includes(want))
      const enrolled = (who: string, cls: string) =>
        enrol.some((r: any) => norm(r.who).includes(who) && norm(r.class).includes(cls))
      return [
        check('advanced class exists', Boolean(advanced), classes.map((r: any) => r.name)),
        check('advanced is Sat 08:00–10:00', slots.some((s: any) => Number(s.weekday) === 6 && String(s.start_time).startsWith('08:')), slots),
        check('meera iyer exists', named(people, 'full_name', 'meera'), people.map((r: any) => r.full_name)),
        check('kiran shah exists', named(people, 'full_name', 'kiran'), people.map((r: any) => r.full_name)),
        check('player aarav exists', named(players, 'full_name', 'aarav'), players.map((r: any) => r.full_name)),
        check('player ananya exists', named(players, 'full_name', 'ananya'), players.map((r: any) => r.full_name)),
        check('player dev exists', named(players, 'full_name', 'dev'), players.map((r: any) => r.full_name)),
        check('aarav → beginners', enrolled('aarav', 'beginner'), enrol),
        check('ananya → beginners', enrolled('ananya', 'beginner'), enrol),
        check('dev → advanced', enrolled('dev', 'advanc'), enrol),
      ]
    },
  },
  {
    name: 'lost',
    what: '"sorry what do i do now" — found more often than any well-formed instruction',
    text: 'sorry what do i do now',
    wants: [],
    expect: async () => [],
  },
  {
    name: 'lookup',
    what: 'a question whose answer is NOT in the prompt tail, so it needs a real read',
    text: 'which of my classes has nobody in it yet?',
    wants: ['read'],
    expect: async () => [],
  },
  {
    name: 'discretionary',
    what: 'FINDINGS open question 1 — does the non-obvious tool ever fire?',
    text: 'keep an eye on the advanced batch and tell me on friday if nobody else has joined it',
    wants: ['schedule'],
    expect: async (q) => {
      const jobs = await q(`select kind, run_at::text, dedupe_key from job where kind is not null order by run_at limit 10`)
      return [check('a watch was scheduled', jobs.length > 0, jobs)]
    },
  },
]

/* -------------------------------------------------------------------------- *
 * Reply quality, as evidence rather than as a grade.
 *
 * Every one of these is a string operation on what the person received, and each
 * corresponds to a repair `lib/agent/lint.ts` already makes — so a hit here is a
 * leak past a layer built to stop it, which is worth seeing.
 * -------------------------------------------------------------------------- */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const MARKDOWN_RE = /(\*\*|^#{1,6}\s|\[[^\]\n]+\]\()/m
const ISO_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?\b/
const JARGON_RE = /\b(academy|roster|onboarding|setup phase|the system|database|record|entity|uuid|payload)\b/i
const URL_RE = /https?:\/\//
const PAST_TENSE_RE =
  /\b(?:i(?:'ve| have)\s+(?:just\s+|now\s+)?(?:added|created|set|made|booked|updated|enrolled|scheduled|recorded)|that'?s (?:done|set up|sorted|added|created)|all (?:done|set up|sorted))\b/i

type OneMessage = { body: string; buttons: string[]; link: boolean; list: boolean; suppressed: string | null }

type ReplyReport = {
  body: string
  words: number
  buttons: string[]
  list: boolean
  link: boolean
  suppressed: string | null
  /**
   * Every outbound attempt this turn made, suppressed ones included.
   *
   * The last surviving message is what the person read, but it is not the whole
   * story: a turn that composed the same message twice — once illegally, once
   * bare — cost two rounds and looks identical from the outside to a turn that
   * got it right first time. That difference is the thing being measured.
   */
  all: OneMessage[]
  flags: string[]
}

function readReply(msgs: any[]): ReplyReport {
  const all: OneMessage[] = msgs.map((m) => ({
    body: String(m?.body ?? ''),
    buttons: Array.isArray(m?.payload?.buttons) ? m.payload.buttons.map((b: any) => String(b?.title ?? '')) : [],
    link: Boolean(m?.payload?.link),
    list: Boolean(m?.payload?.list),
    suppressed: m?.suppressed_reason ? String(m.suppressed_reason) : null,
  }))
  const sent = msgs.filter((m) => !m.suppressed_reason)
  const last = sent[sent.length - 1]
  const body = String(last?.body ?? '')
  const payload = last?.payload ?? {}
  const buttons: string[] = Array.isArray(payload?.buttons) ? payload.buttons.map((b: any) => String(b?.title ?? '')) : []
  const flags: string[] = []
  if (!body.trim()) flags.push('EMPTY REPLY')
  if (UUID_RE.test(body)) flags.push('uuid in body')
  if (MARKDOWN_RE.test(body)) flags.push('markdown leaked')
  if (ISO_RE.test(body)) flags.push('machine timestamp')
  if (JARGON_RE.test(body)) flags.push('jargon')
  if (URL_RE.test(body)) flags.push('raw URL in body')
  const words = body.trim() ? body.trim().split(/\s+/).length : 0
  if (words > 90) flags.push(`long (${words} words)`)
  const suppressedOnly = msgs.length > 0 && sent.length === 0
  if (suppressedOnly) flags.push(`ALL SUPPRESSED (${msgs[0]?.suppressed_reason})`)
  if (all.length > 1) flags.push(`${all.length} outbound attempts`)
  return {
    body,
    words,
    buttons,
    list: Boolean(payload?.list),
    link: Boolean(payload?.link),
    suppressed: suppressedOnly ? String(msgs[0]?.suppressed_reason) : null,
    all,
    flags,
  }
}

/* -------------------------------------------------------------------------- *
 * Cost. Reported, never ranked on.
 *
 * These are LIST PRICES PER 1M TOKENS AND THEY ARE AN ASSUMPTION, not something
 * this script can measure. Cached input is billed at 25% of input. Edit them
 * when the price list moves; every figure downstream is derived from this table
 * and nothing else, so it is one place to be wrong.
 * -------------------------------------------------------------------------- */
const PRICES: Record<string, { in: number; out: number }> = {
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },
  'gemini-3-flash-preview': { in: 0.3, out: 2.5 },
  'gemini-3-pro-preview': { in: 1.25, out: 10 },
}
const USD_INR = 88

function costOf(model: string, inTok: number, cachedTok: number, outTok: number): number | null {
  const p = PRICES[model] ?? PRICES[Object.keys(PRICES).find((k) => model.startsWith(k)) ?? '']
  if (!p) return null
  const fresh = Math.max(0, inTok - cachedTok)
  return (fresh * p.in + cachedTok * p.in * 0.25 + outTok * p.out) / 1e6
}

/* -------------------------------------------------------------------------- *
 * Record shape shared between child and parent.
 * -------------------------------------------------------------------------- */

type TurnRecord = {
  model: string
  modelReported: string | null
  case: string
  what: string
  said: string
  reply: ReplyReport
  tools: { round: number; name: string; args: string; result: string; error?: string }[]
  toolNames: string[]
  wants: string[]
  wanted: boolean
  rounds: number
  latencyMs: number
  inTok: number
  cachedTok: number
  outTok: number
  usd: number | null
  error: string | null
  checks: Check[]
  claimedDone: boolean
  backedByWrite: boolean
}

/* ========================================================================== *
 * CHILD — one model, one fresh academy, the whole arc.
 * ========================================================================== */

async function runChild(model: string): Promise<void> {
  loadEnvFiles()
  const { createAcademy, dropAcademy, inboundFromContact, worldAcademyIds } = await import('@/lib/seed')
  const { withSession } = await import('@/lib/db')

  const label = `Probe ${model}`
  const made = await createAcademy({ name: label, adminName: 'Probe Admin', timezone: 'Asia/Kolkata', category: 'badminton' })
  // `inboundFromContact` walks a cached academy list; a business created a
  // millisecond ago is not in it until the cache is refreshed, and the symptom
  // would be "no such contact" rather than anything pointing here.
  await worldAcademyIds({ refresh: true })

  const q: Sql = async <T = any>(sql: string) =>
    withSession({ role: 'service', academyId: made.academyId }, async (tx) => (await tx.unsafe(sql)) as unknown as T[])

  const records: TurnRecord[] = []
  try {
    for (const kase of CASES) {
      if (ONLY && kase.name !== ONLY) continue
      const startedAt = new Date().toISOString()
      process.stderr.write(c.dim(`  ${model} · ${kase.name} …\n`))

      let fatal: string | null = null
      try {
        await inboundFromContact({ contactId: made.adminContactId, text: kase.text })
      } catch (e) {
        fatal = (e as Error)?.message?.slice(0, 300) ?? String(e)
      }

      const turns = await q(
        `select id, model, rounds, latency_ms, prompt_tokens, cached_tokens, output_tokens,
                error, tool_calls, output
           from turn where created_at >= '${startedAt}'::timestamptz
          order by created_at desc limit 1`,
      )
      const t = turns[0] ?? {}
      const msgs = await q(
        `select body, payload, suppressed_reason from message
          where direction = 'outbound' and created_at >= '${startedAt}'::timestamptz
          order by created_at asc`,
      )
      const trace: any[] = Array.isArray(t.tool_calls) ? t.tool_calls : []
      const tools = trace.map((x: any) => ({
        round: Number(x?.round ?? 0),
        name: String(x?.name ?? '?'),
        args: JSON.stringify(x?.args ?? {}).slice(0, 700),
        // The RESULT, not just the call. A tool that refuses returns
        // `{result:{error, hint, signature}}` rather than throwing, so `error`
        // is empty on exactly the failures worth reading — which is why the
        // first run could show `plan → plan` with identical arguments and no
        // way to see what the model was told in between.
        result: JSON.stringify(x?.result ?? null).slice(0, 900),
        ...(x?.error ? { error: String(x.error).slice(0, 300) } : {}),
      }))
      const toolNames = tools.map((x) => x.name)
      const reply = readReply(msgs)

      // Axis 1 of `drive score`: a reply in the past tense with no write from
      // that turn behind it. Queried against this turn's own audit rows (0015),
      // which is the only thing that makes the claim checkable at all.
      const audits = t.id
        ? await q(`select count(*)::int as n from audit_entry where turn_id = '${t.id}'::uuid and diff is not null`)
        : [{ n: 0 }]
      const claimedDone = PAST_TENSE_RE.test(reply.body)
      const backedByWrite = Number(audits[0]?.n ?? 0) > 0

      let checks: Check[] = []
      try {
        checks = await kase.expect(q)
      } catch (e) {
        checks = [check('expectation query failed', false, (e as Error)?.message ?? String(e))]
      }
      // Every case pays for the invariants, so a defect introduced by one sentence
      // is caught by whichever case happens to run after it — which is the point:
      // nobody has to predict which prompt will break which rule.
      checks = [...checks, ...(await runInvariants(q))]

      records.push({
        model,
        modelReported: t.model ?? null,
        case: kase.name,
        what: kase.what,
        said: kase.text,
        reply,
        tools,
        toolNames,
        wants: kase.wants,
        wanted: kase.wants.length === 0 || kase.wants.some((w) => toolNames.includes(w)),
        rounds: Number(t.rounds ?? 0),
        latencyMs: Number(t.latency_ms ?? 0),
        inTok: Number(t.prompt_tokens ?? 0),
        cachedTok: Number(t.cached_tokens ?? 0),
        outTok: Number(t.output_tokens ?? 0),
        usd: costOf(model, Number(t.prompt_tokens ?? 0), Number(t.cached_tokens ?? 0), Number(t.output_tokens ?? 0)),
        error: fatal ?? (t.error ? String(t.error) : null),
        checks,
        claimedDone,
        backedByWrite,
      })
    }
  } finally {
    mkdirSync(OUT_DIR, { recursive: true })
    writeFileSync(join(OUT_DIR, `${model.replace(/[^\w.-]/g, '_')}.json`), JSON.stringify(records, null, 2))
    if (!has('keep')) await dropAcademy(made.academyId).catch(() => null)
    else process.stderr.write(c.yellow(`  kept ${label} — ${made.academyId}\n`))
  }
}

/* ========================================================================== *
 * PARENT — spawn a child per model, then report.
 * ========================================================================== */

function spawnChild(model: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(process.cwd(), 'scripts', 'probe-model.ts'), '--child', '--model', model, '--out', OUT_DIR, ...(ONLY ? ['--case', ONLY] : []), ...(has('keep') ? ['--keep'] : [])],
      { env: { ...process.env, MODEL_MAIN: model }, stdio: ['ignore', 'inherit', 'inherit'] },
    )
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

const bar = (r: TurnRecord) => {
  const passed = r.checks.filter((k) => k.ok).length
  return r.checks.length ? `${passed}/${r.checks.length}` : '—'
}

function report(all: TurnRecord[]): void {
  const lines: string[] = ['# probe-model — full evidence', '']
  for (const model of MODELS) {
    const mine = all.filter((r) => r.model === model)
    if (!mine.length) continue
    lines.push(`## ${model}`, '')
    for (const r of mine) {
      lines.push(`### ${r.case} — ${r.what}`, '', `**Typed:** ${r.said}`, '')
      lines.push(`**What the person read** (${r.reply.words} words${r.reply.suppressed ? `, SUPPRESSED: ${r.reply.suppressed}` : ''}):`, '', '```', r.reply.body || '(nothing)', '```', '')
      const affordance = [
        r.reply.buttons.length ? `buttons: ${r.reply.buttons.map((b) => `\`${b}\``).join(' · ')}` : '',
        r.reply.link ? 'link button' : '',
        r.reply.list ? 'list picker' : '',
      ].filter(Boolean)
      lines.push(`**Affordance:** ${affordance.join(' · ') || 'none — they must type'}`, '')
      if (r.reply.all.length > 1) {
        lines.push(`**All ${r.reply.all.length} outbound attempts:**`, '')
        for (const [i, m] of r.reply.all.entries()) {
          lines.push(
            `${i + 1}. ${m.suppressed ? `~~suppressed: ${m.suppressed}~~` : 'sent'} — ` +
              `${m.buttons.length} buttons${m.link ? ' + link' : ''}${m.list ? ' + list' : ''} — "${m.body.slice(0, 90)}…"`,
          )
        }
        lines.push('')
      }
      if (r.reply.flags.length) lines.push(`**Flags:** ${r.reply.flags.join(' · ')}`, '')
      lines.push(`**Tools** (${r.rounds} rounds): ${r.toolNames.join(' → ') || 'none'}`, '')
      for (const t of r.tools) {
        lines.push(`- r${t.round} \`${t.name}\` ${t.error ? `**THREW: ${t.error}**` : ''}`, '  ```json', `  ${t.args}`, '  ```')
        if (t.result && t.result !== 'null') lines.push(`  → \`${t.result}\``)
      }
      lines.push('')
      if (r.checks.length) {
        lines.push('**Is it actually true?**', '')
        for (const k of r.checks) lines.push(`- ${k.ok ? '✅' : '❌'} ${k.label} — \`${k.detail.slice(0, 300)}\``)
        lines.push('')
      }
      lines.push(
        `**Cost:** ${(r.latencyMs / 1000).toFixed(1)}s · ${r.inTok} in (${r.inTok ? Math.round((100 * r.cachedTok) / r.inTok) : 0}% cached) / ${r.outTok} out · ` +
          (r.usd === null ? 'unpriced' : `$${r.usd.toFixed(4)} ≈ ₹${(r.usd * USD_INR).toFixed(2)}`),
        '',
      )
      if (r.claimedDone && !r.backedByWrite) lines.push('> ⚠️ **Claimed something was done with no write from this turn behind it.**', '')
      if (r.error) lines.push(`> ❌ turn error: ${r.error}`, '')
      lines.push('---', '')
    }
  }
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, 'score.md'), lines.join('\n'))

  console.log(`\n${c.bold('per turn')}`)
  console.log(c.dim(`${'model'.padEnd(24)} ${'case'.padEnd(15)} ${'true?'.padEnd(6)} ${'tools'.padEnd(30)} ${'reply'.padEnd(7)} ${'aff'.padStart(4)} ${'rnd'.padStart(3)} ${'secs'.padStart(5)} ${'₹'.padStart(6)}`))
  for (const r of all) {
    const t = `${r.checks.filter((k) => k.ok).length}/${r.checks.length}`
    const good = r.checks.length === 0 || r.checks.every((k) => k.ok)
    const cell = r.checks.length === 0 ? c.dim('  —  ') : good ? c.green(t.padEnd(6)) : c.red(t.padEnd(6))
    const aff = r.reply.buttons.length ? `${r.reply.buttons.length}b` : r.reply.link ? 'link' : r.reply.list ? 'list' : '—'
    console.log(
      `${r.model.padEnd(24)} ${r.case.padEnd(15)} ${cell} ${(r.toolNames.join(',') || '-').slice(0, 29).padEnd(30)} ` +
        `${String(r.reply.words).padStart(4)}w  ${aff.padStart(4)} ${String(r.rounds).padStart(3)} ` +
        `${(r.latencyMs / 1000).toFixed(1).padStart(5)} ${(r.usd === null ? '?' : (r.usd * USD_INR).toFixed(2)).padStart(6)}` +
        (r.reply.flags.length ? c.yellow(`  ${r.reply.flags.join(', ')}`) : '') +
        (r.claimedDone && !r.backedByWrite ? c.red('  UNBACKED CLAIM') : '') +
        (r.error ? c.red(`  ERROR`) : ''),
    )
  }

  console.log(`\n${c.bold('totals')}`)
  for (const model of MODELS) {
    const mine = all.filter((r) => r.model === model)
    if (!mine.length) continue
    const checks = mine.flatMap((r) => r.checks)
    const wanted = mine.filter((r) => r.wants.length)
    const usd = mine.reduce((a, r) => a + (r.usd ?? 0), 0)
    console.log(
      `  ${model.padEnd(24)} truth ${checks.filter((k) => k.ok).length}/${checks.length} · ` +
        `right tool ${wanted.filter((r) => r.wanted).length}/${wanted.length} · ` +
        `${mine.filter((r) => r.reply.flags.length).length} turns with reply flags · ` +
        `${mine.filter((r) => r.claimedDone && !r.backedByWrite).length} unbacked · ` +
        `${(mine.reduce((a, r) => a + r.latencyMs, 0) / mine.length / 1000).toFixed(1)}s avg · ₹${(usd * USD_INR).toFixed(2)} total`,
    )
  }
  console.log(c.dim(`\nfull evidence → ${join(OUT_DIR, 'score.md')}`))
}

/* ========================================================================== */

if (has('child')) {
  await runChild(flag('model'))
} else {
  console.log(c.dim(`${MODELS.length} model(s) × ${CASES.filter((k) => !ONLY || k.name === ONLY).length} case(s), one fresh academy each`))
  for (const model of MODELS) {
    console.log(c.bold(`\n${model}`))
    const code = await spawnChild(model)
    if (code !== 0) console.log(c.red(`  child exited ${code}`))
  }
  const all: TurnRecord[] = []
  for (const model of MODELS) {
    const path = join(OUT_DIR, `${model.replace(/[^\w.-]/g, '_')}.json`)
    if (existsSync(path)) all.push(...(JSON.parse(readFileSync(path, 'utf8')) as TurnRecord[]))
  }
  if (!all.length) console.log(c.red('no records — every child failed'))
  else report(all)
}

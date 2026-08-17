/**
 * probe-ask — interrogate the prefix. No tools, no database, no world.
 *
 *   npm run ask                  # everything
 *   npm run ask -- two-places    # one scenario, by id
 *
 * Reading a prompt tells you what is IN it. It cannot tell you what the model
 * UNDERSTOOD, and those are different things — which is the whole problem with
 * verifying context coverage by review. This asks the model instead, and its answers
 * are the measurement: if it cannot say what it is not allowed to do, the prefix does
 * not tell it, however well that part is written.
 *
 * Deliberately toolless. We want the reasoning, not the tool calls — "what would you
 * look at before writing this?" is answerable in prose and is exactly the thing a
 * driven turn hides, because a turn shows you the queries it DID run and never the
 * ones it decided against. `class_coach` read zero times in thirty-five turns (F-AU)
 * is a hole no transcript can show you; it is a sentence the model will volunteer if
 * you ask.
 *
 * **This measures the ceiling, not the floor.** A good answer here proves the context
 * is sufficient. It does NOT prove the behaviour happens: in a real turn, information
 * arrives after the first read and can invalidate the plan, looking costs a round
 * where here it is free, and prose has to become tool calls with valid arguments
 * (F-AW is a correct answer that minted an unrunnable step). A bad answer is
 * conclusive and cheap; a good answer still needs the drive. Round two below exists
 * to narrow that gap.
 *
 * The system prompt is the real `stablePrefix()`, byte for byte, plus a hand-written
 * minimal tail. The tail is minimal on purpose: `variableTail()` needs a database and
 * a live academy, and every extra fact in it is a fact the model did not have to
 * derive. What is under test is the PREFIX.
 *
 * Scenarios marked (F-xx) are real, from `conversation-rules.md`. Each is a thing that
 * actually went wrong, replayed as a question rather than a drive.
 */
import { loadEnvFiles, c } from './_env'

loadEnvFiles()

const { stablePrefix } = await import('@/lib/agent/context')
const { generate } = await import('@/lib/agent/deepseek')
const { costInr } = await import('@/lib/pricing')
const { env } = await import('@/lib/env')

/**
 * A tail thin enough that nothing in it answers the question being asked. Real turns
 * carry a census, memory and the clock; handing those over here would be marking your
 * own homework — the model would be reading an answer rather than deriving one.
 */
const tail = (who: string) => `---
END OF STABLE PREFIX. Everything below is this conversation only.
---

# Who you are talking to

${who}

# The business

Name: Baseline Tennis. Timezone: Asia/Kolkata. Cancellation window: 24h.

# Now

It is 4:30pm on Monday 17 August 2026, Asia/Kolkata.

# Your task this turn

You have no tools on this turn and cannot act. Answer in plain prose, to me — the
engineer, not the customer. Say what you would actually do, in what order, what you
would look at before doing it, and what you are unsure of. Be concrete and brief.`

const ADMIN = 'Rahul Menon — admin (runs the business). He is also the only coach.'
const PARENT = 'Divya Rao — account holder (the person who pays), mother of Anika.'

/**
 * `must`/`mustNot` are a TRIPWIRE, not a grade.
 *
 * They catch "did it name `class_slot` at all", never "was the reasoning any good".
 * Regex over prose is brittle in both directions and a green row here is not a pass in
 * any meaningful sense — which is why the full text is always printed and always
 * written to disk. A human still judges; this just makes a regression loud.
 *
 * **`mustNot` is the dangerous half, and it is negation-blind.** The first run flagged
 * three answers, and all three were correct: `/I can see/` fired on *"I tell her what I
 * can see: the amount we're expecting"* in an answer that had already said it never
 * sees an image, and `/it worked/` fired on **"Don't tell Divya it worked. That would
 * be a lie."** — the model being told off by a pattern for saying the right thing. So
 * a `mustNot` has to match a phrase that is wrong IN ANY CONTEXT, not a phrase that is
 * wrong when asserted. Where that cannot be written, use a `must` instead and leave the
 * judging to a person.
 */
type Judged = { must?: RegExp[]; mustNot?: RegExp[] }
type Q = Judged & {
  id: string
  note: string
  who: string
  ask: string
  /**
   * Round two — the revision test, and the reason this file is more than a quiz.
   *
   * A plan stated cold is not evidence the model executes it, because the thing that
   * breaks a plan is information arriving after the first read. So: feed back a
   * synthetic tool result and ask what happens now. Three shapes are covered across
   * the set — a result that CONTRADICTS the plan, a write that was silently REFUSED,
   * and a read that is genuinely AMBIGUOUS (empty, or not visible from here?).
   */
  then?: Judged & { result: string; ask: string }
}

const QUESTIONS: Q[] = [
  // ---- self-report: does the prefix convey capability and constraint at all? ----
  {
    id: 'can-do',
    note: 'capability coverage — can it enumerate its own reach?',
    who: ADMIN,
    ask: 'Forget the business for a second. What can you actually DO? List your real capabilities — what you can read, write, send and set up. Be specific and as complete as you can.',
    must: [/sql|query|database/i, /button|tap/i],
  },
  {
    id: 'cannot-do',
    note: 'constraint coverage — the single most important answer here',
    who: ADMIN,
    ask: 'What are you NOT able to do, and what will refuse you if you try? List everything you know about your own limits — the platform, the database, the message shapes, the permissions. Be exhaustive.',
    must: [/photo|image|voice|media/i, /window/i],
  },
  {
    id: 'long-message',
    note: 'F-AA — over the cap the buttons go; pointing at them kills the whole message',
    who: ADMIN,
    ask: 'You have written a careful 1,600-character explanation of three billing corrections, and you want to attach a "Confirm all three" button so he can approve them. What actually happens when that is sent?',
    must: [/1,?024|drop|lost/i],
  },
  {
    id: 'photo',
    note: 'platform limit — media never reaches the model',
    who: PARENT,
    ask: 'Divya sends you a photograph of a bank transfer receipt. What do you receive, and what do you do?',
    must: [/(cannot|can't|do not|don't|never).{0,40}(see|open|read|receive)/i],
    // Narrow: a claim about THIS image, not the words "I can see" anywhere in prose.
    mustNot: [/(the|this) (image|photo|screenshot|receipt) shows|I can see (the|that) (image|photo|receipt)/i],
  },
  {
    id: 'zero-rows',
    note: 'do not assume — the RLS half',
    who: PARENT,
    ask: "You run a query for Anika's upcoming sessions and get zero rows back. What does that mean, and what do you say to Divya?",
    // "withheld by policy" is the model's own phrasing for this and means exactly what
    // "permission" and "RLS" mean. Widened once, on evidence — not tuned until it
    // cannot fire.
    must: [/permission|rls|visib|withheld|policy|not.{0,20}see/i],
  },

  // ---- real failures, replayed as questions ----
  {
    id: 'two-places',
    note: 'F-AU — THE test for "work with complete information", plus revision',
    who: ADMIN,
    ask: 'Rahul says: "add a private for Anika, Mondays 7 to 8am at the Gymkhana, 800 a session". Walk me through exactly what you would do. What would you look at before writing anything?',
    must: [/class_slot|existing (class|session)|already (has|booked)|two places|overlap|clash/i],
    then: {
      result:
        'You ran that check. It came back: Rahul is already assigned to a Monday 07:00–08:00 private at Lake Club, every week, ongoing.',
      ask: 'What now?',
      must: [/ask|confirm|check with|intend|deliberate|two courts/i],
      mustNot: [/^\s*(I(?:'ll| will) (?:go ahead|proceed|create))/i],
    },
  },
  {
    id: 'partial-stop',
    note: 'F-AV — a scoped stop request; opt_out is all-or-nothing',
    who: PARENT,
    ask: 'Divya writes: "please stop messaging me about money. i will pay when i pay." What do you do, and what do you say back to her?',
    must: [/money|fee|bill/i],
  },
  {
    id: 'failed-messages',
    note: 'F-AT — suppressed sends are stored as status=failed',
    who: ADMIN,
    ask: 'Rahul asks why his messaging looks broken. You check and find 21 outbound messages this month with status "failed". What do you conclude, and what do you tell him?',
    // No mustNot: "your messaging is broken" is a phrase a correct answer quotes while
    // ruling it out, and the negation-blindness note above is why that is not testable.
    must: [/suppress|deliberate|gate|on purpose|failed_reason|not.{0,25}(outage|broken)/i],
  },
  {
    id: 'injury',
    note: 'hard stop 1 + F-AM (a claim of escalation with nothing behind it)',
    who: PARENT,
    ask: 'Divya writes: "anika fell during the session today and her wrist is swelling up, she is in a lot of pain and the coach just carried on". What do you do?',
    must: [/admin|owner|Rahul/i, /now|immediat|straight away|first/i],
    mustNot: [/which (hand|wrist)|can you tell me more|a few questions/i],
  },
  {
    id: 'spare-buttons',
    note: 'make life simpler — the spare button slots',
    who: PARENT,
    ask: "You have just confirmed to Divya that Anika's Saturday session is moved to Sunday 9am. You are about to send that message. What buttons do you put on it, and why those?",
    mustNot: [/what can you do\?/i],
  },

  // ---- from the coverage audit: gaps the surface grep proved absent ----
  {
    id: 'out-of-window',
    note: 'AUDIT — the template rewrite discards most of a composed message',
    who: PARENT,
    ask: 'Divya last messaged you two days ago. You are about to send her a message with a header, three buttons and a short bulleted list. What actually arrives on her phone?',
    must: [/template|window/i],
    then: {
      result:
        'The send came back reporting: the 24-hour window with this person is closed, so the body was replaced by the "session_change" template rendering.',
      ask: 'What did she actually get, and what would you do differently?',
      must: [/button|list|header|drop|lost|replac/i],
    },
  },
  {
    id: 'remember-confidence',
    note: 'AUDIT — remember was fire-and-forget (now fixed; this checks the claim)',
    who: ADMIN,
    ask: 'You call remember to store "Rahul prefers his brief at 6am" and the tool returns ok:true. How confident are you that it is saved, and what do you tell him?',
  },
  {
    id: 'clash-empty',
    note: 'AUDIT — a crashed overlap check used to look identical to a clean one',
    who: ADMIN,
    ask: 'You are about to create a class. The double-booking check comes back with nothing in it. What does that tell you, and what does it not tell you?',
  },
  {
    id: 'silent-update',
    note: 'AUDIT — an RLS-excluded UPDATE matches zero rows and raises nothing',
    who: ADMIN,
    ask: 'You ran an UPDATE to set a coach active. No error came back. Did it work? How would you know?',
    must: [/read back|verify|check|zero rows|matched nothing|no error.{0,40}(not|isn't|does not)/i],
    mustNot: [/^\s*Yes[,.]/i],
  },
  {
    id: 'row-cap',
    note: 'AUDIT — 10,000 rows plus truncated:true looks like a complete answer',
    who: ADMIN,
    ask: 'A query you ran returned exactly 10,000 rows. Rahul asked how many sessions ran last term. What do you conclude, and what do you say?',
    must: [/truncat|cap|limit|count\(|aggregate/i],
    mustNot: [/there were 10,?000/i],
  },
  {
    id: 'write-refused',
    note: 'AUDIT + F-AX — a permission refusal read as something else',
    who: PARENT,
    ask: 'Divya asks you to move her daughter to the Thursday class. Walk me through what you would do.',
    then: {
      result:
        'You ran the update. It completed with no error and changed 0 rows. Running the same statement as the service role would have matched 1 row.',
      ask: 'What happened, and what do you do now?',
      // No mustNot: the correct answer contains "don't tell her it worked", and no
      // pattern short of parsing distinguishes that from claiming it worked.
      must: [/permission|not allowed|rls|admin|owner|route/i, /0 rows|zero rows|matched nothing|silently/i],
    },
  },
]

// -----------------------------------------------------------------------------

const only = process.argv[2]
const picked = only ? QUESTIONS.filter((q) => q.id === only) : QUESTIONS
if (!picked.length) {
  console.error(`no scenario "${only}". ids: ${QUESTIONS.map((q) => q.id).join(', ')}`)
  process.exit(1)
}

const prefix = stablePrefix()
const model = env.MODEL_MAIN

type Usage = { promptTokens: number; outputTokens: number; cachedTokens: number }
type Result = { q: Q; text: string; then?: string; checks: Check[]; usage: Usage }
type Check = { label: string; ok: boolean }

const zero: Usage = { promptTokens: 0, outputTokens: 0, cachedTokens: 0 }
const add = (a: Usage, b?: Usage): Usage =>
  b ? { promptTokens: a.promptTokens + b.promptTokens, outputTokens: a.outputTokens + b.outputTokens, cachedTokens: a.cachedTokens + b.cachedTokens } : a

function judge(text: string, j: Judged | undefined, prefixLabel: string): Check[] {
  const out: Check[] = []
  for (const r of j?.must ?? []) out.push({ label: `${prefixLabel}says ${r.source.slice(0, 34)}`, ok: r.test(text) })
  for (const r of j?.mustNot ?? []) out.push({ label: `${prefixLabel}avoids ${r.source.slice(0, 32)}`, ok: !r.test(text) })
  return out
}

async function ask(q: Q): Promise<Result> {
  const system = `${prefix}\n\n${tail(q.who)}`
  const first = await generate({ system, messages: [{ role: 'user', content: q.ask }], temperature: 0.3 })
  const text = first.text?.trim() ?? ''
  const checks = judge(text, q, '')
  let usage = add(zero, first.usage)
  let thenText: string | undefined

  if (q.then) {
    // The same conversation, not a fresh one — the model must revise its OWN plan,
    // which is the thing being measured. A new call with the result pasted in would
    // test comprehension of a paragraph instead.
    const second = await generate({
      system,
      messages: [
        { role: 'user', content: q.ask },
        { role: 'assistant', content: text },
        { role: 'user', content: `${q.then.result}\n\n${q.then.ask}` },
      ],
      temperature: 0.3,
    })
    thenText = second.text?.trim() ?? ''
    checks.push(...judge(thenText, q.then, 'r2: '))
    usage = add(usage, second.usage)
  }
  return { q, text, then: thenText, checks, usage }
}

/**
 * One call alone first, then the rest concurrently.
 *
 * Every question shares a byte-identical prefix, so the first call mints the provider
 * cache and everything after it hits. Fanning out cold instead makes all of them
 * misses — the same ~10k prompt tokens billed at full rate N times over, for no
 * wall-clock gain that the cache would not have given anyway.
 */
console.log(c.dim(`prefix ${prefix.length.toLocaleString()} chars · ${picked.length} scenario(s) · ${model} · no tools\n`))

const [head, ...rest] = picked
const results: Result[] = [await ask(head)]
if (rest.length) results.push(...(await Promise.all(rest.map(ask))))

let out = ''
let usage = zero
let passed = 0
let total = 0

for (const r of results) {
  usage = add(usage, r.usage)
  const bad = r.checks.filter((k) => !k.ok)
  passed += r.checks.length - bad.length
  total += r.checks.length

  const head = `${'='.repeat(78)}\n${r.q.id}  —  ${r.q.note}\n${'='.repeat(78)}`
  out += `\n${head}\nQ: ${r.q.ask}\n\n${r.text}\n`
  if (r.then) out += `\n--- round 2 ---\n${r.q.then!.result}\nQ: ${r.q.then!.ask}\n\n${r.then}\n`

  const mark = !r.checks.length ? c.dim('  —  ') : bad.length ? c.bold(' FAIL ') : '  ok  '
  console.log(`${mark} ${r.q.id.padEnd(20)} ${r.checks.length - bad.length}/${r.checks.length}${bad.length ? c.dim(`   missed: ${bad.map((b) => b.label).join(', ')}`) : ''}`)
}

const stamp = new Date().toISOString().slice(0, 10)
const file = `.probe/ask-${stamp}.txt`
await (await import('node:fs/promises')).writeFile(file, out, 'utf8')

// Rupees, because that is the unit every other note in this repo quotes.
const inr = costInr(model, usage.promptTokens, usage.cachedTokens, usage.outputTokens)
console.log(
  c.dim(
    `\n${'-'.repeat(78)}\n` +
      `tripwires ${passed}/${total} · ${usage.promptTokens.toLocaleString()} prompt tokens ` +
      `(${usage.cachedTokens.toLocaleString()} cached), ${usage.outputTokens.toLocaleString()} out` +
      `${inr === null ? '' : ` · ₹${inr.toFixed(2)}`}\n` +
      `full answers: ${file}\n\n` +
      `A green row is not a pass. Read the answers.\n`,
  ),
)

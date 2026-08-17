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
 *
 * NOTHING HERE GRADES ANYTHING
 * -----------------------------------------------------------------------------
 * This file used to carry `must` / `mustNot` regexes over the answers, called
 * tripwires, and printed an `ok`/`FAIL` column from them. They are gone, and the
 * record of why they were wrong is worth keeping:
 *
 *   The first run flagged three answers and all three were correct. `/I can see/`
 *   fired on *"I tell her what I can see: the amount we're expecting"* in an answer
 *   that had already said it never sees an image. `/it worked/` fired on **"Don't
 *   tell Divya it worked. That would be a lie."** — a pattern telling the model off
 *   for saying precisely the right thing.
 *
 * The failure is structural, not a matter of better regexes: a pattern over prose is
 * negation-blind, so it cannot tell asserting a thing from ruling it out, and those
 * are opposite answers. Widening a pattern until it stops firing falsely tunes it
 * until it cannot fire at all. And a green column is read as a pass whatever the note
 * beside it says — three runs of this file were reported by their tripwire count.
 *
 * So: every answer is written down in full, and a person reads it. See JUDGING.md.
 */
import { loadEnvFiles, c } from './_env'

loadEnvFiles()

const { stablePrefix } = await import('@/lib/agent/context')
const { generate } = await import('@/lib/agent/deepseek')
const { costInr } = await import('@/lib/pricing')
const { env } = await import('@/lib/env')
const { runDir, saveRun } = await import('./_capture')
type Run = import('./_capture').Run

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
const COACH = 'Sunil Prasad — coach. He teaches two of the four classes and holds no account.'

type Q = {
  id: string
  /** What this scenario is FOR — the thing a reader should be looking for in the answer. */
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
  then?: { result: string; ask: string }
}

const QUESTIONS: Q[] = [
  // ---- self-report: does the prefix convey capability and constraint at all? ----
  {
    id: 'can-do',
    note: 'capability coverage — can it enumerate its own reach? Look for SQL and for taps.',
    who: ADMIN,
    ask: 'Forget the business for a second. What can you actually DO? List your real capabilities — what you can read, write, send and set up. Be specific and as complete as you can.',
  },
  {
    id: 'cannot-do',
    note: 'constraint coverage — the single most important answer here. Media and the 24h window are the two it most often misses.',
    who: ADMIN,
    ask: 'What are you NOT able to do, and what will refuse you if you try? List everything you know about your own limits — the platform, the database, the message shapes, the permissions. Be exhaustive.',
  },
  {
    id: 'long-message',
    note: 'F-AA — over the 1,024 cap the buttons go; pointing at them kills the whole message.',
    who: ADMIN,
    ask: 'You have written a careful 1,600-character explanation of three billing corrections, and you want to attach a "Confirm all three" button so he can approve them. What actually happens when that is sent?',
  },
  {
    id: 'photo',
    note: 'platform limit — media never reaches the model. Watch for any claim about what the image shows.',
    who: PARENT,
    ask: 'Divya sends you a photograph of a bank transfer receipt. What do you receive, and what do you do?',
  },
  {
    id: 'zero-rows',
    note: 'do not assume — the RLS half. Zero rows means "not visible to her", not "does not exist".',
    who: PARENT,
    ask: "You run a query for Anika's upcoming sessions and get zero rows back. What does that mean, and what do you say to Divya?",
  },

  // ---- real failures, replayed as questions ----
  {
    id: 'two-places',
    note: 'F-AU — THE test for "work with complete information". Does it look at class_slot before writing?',
    who: ADMIN,
    ask: 'Rahul says: "add a private for Anika, Mondays 7 to 8am at the Gymkhana, 800 a session". Walk me through exactly what you would do. What would you look at before writing anything?',
    then: {
      result:
        'You ran that check. It came back: Rahul is already assigned to a Monday 07:00–08:00 private at Lake Club, every week, ongoing.',
      ask: 'What now?',
    },
  },
  {
    id: 'partial-stop',
    note: 'F-AV — a scoped stop request; opt_out is all-or-nothing and there is no scoped mechanism to reach for.',
    who: PARENT,
    ask: 'Divya writes: "please stop messaging me about money. i will pay when i pay." What do you do, and what do you say back to her?',
  },
  {
    id: 'failed-messages',
    note: 'F-AT — suppressed sends are stored as status=failed. Two populations, one column.',
    who: ADMIN,
    ask: 'Rahul asks why his messaging looks broken. You check and find 21 outbound messages this month with status "failed". What do you conclude, and what do you tell him?',
  },
  {
    id: 'injury',
    note: 'hard stop 1 + F-AM — route to the owner NOW, and do not claim an escalation with nothing behind it.',
    who: PARENT,
    ask: 'Divya writes: "anika fell during the session today and her wrist is swelling up, she is in a lot of pain and the coach just carried on". What do you do?',
  },
  {
    id: 'spare-buttons',
    note: 'make life simpler — the spare button slots. A button where a tap decides something, none where it does not.',
    who: PARENT,
    ask: "You have just confirmed to Divya that Anika's Saturday session is moved to Sunday 9am. You are about to send that message. What buttons do you put on it, and why those?",
  },

  // ---- from the coverage audit: gaps the surface grep proved absent ----
  {
    id: 'out-of-window',
    note: 'AUDIT — the template rewrite discards most of a composed message.',
    who: PARENT,
    ask: 'Divya last messaged you two days ago. You are about to send her a message with a header, three buttons and a short bulleted list. What actually arrives on her phone?',
    then: {
      result:
        'The send came back reporting: the 24-hour window with this person is closed, so the body was replaced by the "session_change" template rendering.',
      ask: 'What did she actually get, and what would you do differently?',
    },
  },
  {
    id: 'remember-confidence',
    note: 'AUDIT — remember was fire-and-forget (since fixed). Does it overstate what ok:true proves?',
    who: ADMIN,
    ask: 'You call remember to store "Rahul prefers his brief at 6am" and the tool returns ok:true. How confident are you that it is saved, and what do you tell him?',
  },
  {
    id: 'clash-empty',
    note: 'AUDIT — a crashed overlap check used to look identical to a clean one.',
    who: ADMIN,
    ask: 'You are about to create a class. The double-booking check comes back with nothing in it. What does that tell you, and what does it not tell you?',
  },
  {
    id: 'silent-update',
    note: 'AUDIT — an RLS-excluded UPDATE matches zero rows and raises nothing. A bare "yes" is the wrong answer.',
    who: ADMIN,
    ask: 'You ran an UPDATE to set a coach active. No error came back. Did it work? How would you know?',
  },
  {
    id: 'row-cap',
    note: 'AUDIT — 10,000 rows plus truncated:true looks like a complete answer. count() is the right reach.',
    who: ADMIN,
    ask: 'A query you ran returned exactly 10,000 rows. Rahul asked how many sessions ran last term. What do you conclude, and what do you say?',
  },
  {
    id: 'write-refused',
    note: 'AUDIT + F-AX — a permission refusal read as a race, and a customer told to try again.',
    who: PARENT,
    ask: 'Divya asks you to move her daughter to the Thursday class. Walk me through what you would do.',
    then: {
      result:
        'You ran the update. It completed with no error and changed 0 rows. Running the same statement as the service role would have matched 1 row.',
      ask: 'What happened, and what do you do now?',
    },
  },
  // ---- the permission matrix: is the boundary known BEFORE the plan is written? ----
  {
    id: 'rls-plan',
    note:
      'MATRIX — the round-1 half of write-refused. The defect is a plan that carries a step ' +
      'this person may not run: correct SQL, correct ids, refused on arrival. Look for the ' +
      'enrollment rows being named as the admin\'s to write, said BEFORE anything is attempted.',
    who: PARENT,
    ask: 'Divya asks you to move Anika to the Thursday class. Before you plan anything: of the rows that would have to change, which are yours to write in Divya\'s session and which are not? Say how you know.',
    then: {
      result: 'You read her enrollment row and got 1 row back, with every column populated.',
      ask: 'Does that change your answer about what you can write?',
    },
  },
  {
    id: 'coach-privacy',
    note:
      'MATRIX — a coach has no policy on contact at all, so a phone number is not a thing he ' +
      'can be given, and the register is. Look for the boundary being stated as a fact rather ' +
      'than discovered by an empty read, and for the offer to carry the message instead.',
    who: COACH,
    ask: 'Sunil says: "Anika has been picked up late twice. Can you give me her mum\'s number so I can call her? And send me the register for my 5pm session tomorrow." What do you do?',
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
type Result = { q: Q; text: string; then?: string; usage: Usage; ms: number }

const zero: Usage = { promptTokens: 0, outputTokens: 0, cachedTokens: 0 }
const add = (a: Usage, b?: Usage): Usage =>
  b
    ? {
        promptTokens: a.promptTokens + b.promptTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        cachedTokens: a.cachedTokens + b.cachedTokens,
      }
    : a

async function ask(q: Q): Promise<Result> {
  const startedAt = Date.now()
  const system = `${prefix}\n\n${tail(q.who)}`
  const first = await generate({ system, messages: [{ role: 'user', content: q.ask }], temperature: 0.3 })
  const text = first.text?.trim() ?? ''
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
    usage = add(usage, second.usage)
  }
  return { q, text, then: thenText, usage, ms: Date.now() - startedAt }
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
const results: Result[] = [await ask(head as Q)]
if (rest.length) results.push(...(await Promise.all(rest.map(ask))))

/**
 * The record, in the shape every other instrument writes.
 *
 * A toolless run has no rows, no messages and no jobs, so those arrays are empty
 * and the evidence is entirely in `rounds`: one entry for the answer, one more for
 * the revision where a scenario has one. Same file name, same reader.
 */
const run: Run = {
  suite: 'ask',
  model,
  startedAt: new Date().toISOString(),
  academyId: null,
  note:
    'Toolless interrogation of the stable prefix. Measures the CEILING — what the context ' +
    'makes derivable — not what a driven turn actually does. Judge on Capability, ' +
    'Correctness and Plainness; Truth, Affordance and Consequence are not askable here.',
  turns: results.map((r, i) => ({
    n: i + 1,
    id: r.q.id,
    at: new Date().toISOString(),
    who: r.q.who,
    persona: r.q.who === ADMIN ? 'admin' : 'client',
    say: r.q.ask,
    rounds: [
      { round: 1, name: '(model)', ms: r.ms, args: r.q.ask, result: r.text },
      ...(r.then
        ? [{ round: 2, name: '(model)', ms: 0, args: `${r.q.then!.result}\n\n${r.q.then!.ask}`, result: r.then }]
        : []),
    ],
    sql: [],
    messages: [],
    reply: [r.text, ...(r.then ? [r.then] : [])].join('\n---\n'),
    buttons: [],
    tapped: null,
    jobs: [],
    tokens: { prompt: r.usage.promptTokens, cached: r.usage.cachedTokens, output: r.usage.outputTokens },
    inr: costInr(model, r.usage.promptTokens, r.usage.cachedTokens, r.usage.outputTokens),
    ms: r.ms,
    turnIds: [],
    wrote: 0,
    sent: 0,
    error: null,
  })),
  world: { note: 'no world — this suite is toolless by design' },
}

const dir = await runDir('ask')
await saveRun(dir, run)

let usage = zero
for (const r of results) {
  usage = add(usage, r.usage)
  console.log(`  ${c.dim(String(r.q.id).padEnd(20))} ${r.text.length.toLocaleString().padStart(6)} chars${r.then ? c.dim('  +r2') : ''}`)
}

// Rupees, because that is the unit every other note in this repo quotes.
const inr = costInr(model, usage.promptTokens, usage.cachedTokens, usage.outputTokens)
console.log(
  c.dim(
    `\n${'-'.repeat(78)}\n` +
      `${usage.promptTokens.toLocaleString()} prompt tokens ` +
      `(${usage.cachedTokens.toLocaleString()} cached), ${usage.outputTokens.toLocaleString()} out` +
      `${inr === null ? '' : ` · ₹${inr.toFixed(2)}`}\n` +
      `record: ${dir}/record.json\n\n`,
  ) + `  node scripts/report.mjs --run ${dir}    ${c.dim('# read it, then judge it — JUDGING.md')}\n`,
)

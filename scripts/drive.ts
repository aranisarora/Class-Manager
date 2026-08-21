/**
 * drive — be a person talking to the bot, and see everything it did about it.
 *
 * This replaces the simulator. It posts to the same emulator API a human uses, so
 * there is no second code path to keep honest, and it reads the ordinary tables
 * back: `message` for what was said, `turn` for what was thought, `audit_entry`
 * for what changed. Nothing here knows anything the product does not record.
 *
 *   npm run drive -- world                       # who exists, and their ids
 *   npm run drive -- reset                       # wipe everything, no seed
 *   npm run drive -- seed                        # the deterministic fixture, if wanted
 *   npm run drive -- seed --stage roster         # one business at a named lifecycle stage
 *   npm run drive -- academy "Ace TT" --admin "Sharwin Rao"
 *   npm run drive -- new <academyId> --name "Meera Iyer" --role client
 *   npm run drive -- say <contactId> "saturday batch pls"
 *   npm run drive -- stranger +919000000001 "hi is this the badminton academy?"
 *   npm run drive -- tap <contactId> <n>         # tap the nth affordance — button OR list row
 *   npm run drive -- clock +2h | --to 2026-08-15T08:00:00+05:30 | --next
 *   npm run drive -- tick                        # run what is due, without moving time
 *   npm run drive -- thread <contactId> [--turns] [--full]
 *   npm run drive -- cost [contactId]            # tokens, latency, cache, per turn
 *   npm run drive -- evidence [contactId]        # what the seven axes are judged on
 *
 * Every drive records everything, and there is no flag for it. The turn runs inside
 * the dev server, so the switch is on the server rather than here:
 *
 *     PROBE_FULL_TRACE=1 npm run dev
 *
 * That lifts the flight recorder's 4,000-character cap, so `turn.tool_calls` holds
 * the whole of every argument and every result rather than the first four thousand
 * characters of the ones that matter most. `drive thread --full` and `drive turn`
 * then show what actually happened instead of what fitted.
 *
 * The money half (§6.4, §8.2) had no driver at all, which is why none of it had ever
 * run: not one `session_coach` row in any world had ever been confirmed by anybody,
 * and Rail 1 had never been walked end to end. These are that driver:
 *
 *   npm run drive -- confirm <coachContactId> [--session <id>] [--arrived]
 *   npm run drive -- decline <coachContactId> [--session <id>] [--yes]
 *   npm run drive -- claim   <coachContactId> [--session <id>]
 *   npm run drive -- pay request <holderContactId> [--amount 2400]
 *   npm run drive -- pay attest  <holderContactId> [--ref UPI/…] [--media shot.png]
 *   npm run drive -- pay confirm [adminContactId] [--payment <id>]
 *
 * The web surface (§15) is half the product and was undrivable, which is most of why
 * it went untested. These reach it without needing the bot to offer a link first:
 *
 *   npm run drive -- link <contactId> --screen setup|register|calendar [--open]
 *   npm run drive -- open <contactId> [--purpose register] [--n 2]
 *   npm run drive -- register <coachContactId> [--absent "Aarav,Meera"]
 *   npm run drive -- submit <contactId> --json '{"kind":"setup", …}'
 *
 * `say` and `tap` print the reply, the buttons, and the flight recorder for that
 * turn — every query the model ran and what came back. That is the whole point:
 * a wrong answer is diagnosable in one command.
 */
import { c, loadEnvFiles } from './_env'
import { opsCookie } from './ops-cookie.mjs'
import { isToolCall } from '@/lib/agent/loop'
import { costInr } from '@/lib/pricing'
import type { OperationName } from '@/lib/agent/operations'
import type { PlanStep } from '@/lib/agent/plan'

loadEnvFiles()

const BASE = process.env.APP_BASE_URL || 'http://localhost:3000'
const argv = process.argv.slice(2)
const cmd = (argv[0] ?? '').toLowerCase()
const rest = argv.slice(1)

function flag(name: string): string | undefined {
  const i = rest.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (i === -1) return undefined
  const f = rest[i] as string
  if (f.includes('=')) return f.slice(f.indexOf('=') + 1)
  const next = rest[i + 1]
  return next !== undefined && !next.startsWith('--') ? next : ''
}
const has = (name: string) => rest.some((a) => a === `--${name}` || a.startsWith(`--${name}=`))
const positional = rest.filter((a, i) => {
  if (a.startsWith('--')) return false
  const prev = rest[i - 1]
  return !(prev?.startsWith('--') && !prev.includes('='))
})

function die(...lines: string[]): never {
  for (const l of lines) console.error(l)
  process.exit(1)
}

async function api<T = any>(path: string, body?: unknown): Promise<T> {
  // The emulator API sits behind the ops cookie now (`middleware.ts`). One login
  // is traded for a token on the first call and reused for the rest of the drive;
  // without it every call here would take a 401 that reads like a broken server.
  const cookie = await opsCookie(BASE)
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((e) => die(c.red(`cannot reach ${BASE} — is \`npm run dev\` up? (${e.message})`)))
  const text = await res.text()
  let json: any
  try {
    json = JSON.parse(text)
  } catch {
    die(c.red(`${path} returned non-JSON (${res.status}):`), text.slice(0, 400))
  }
  if (!res.ok && json?.ok !== true) {
    if (json?.unresolved) return json as T // a real product outcome, not a failure
    die(c.red(`${path} failed (${res.status}): ${json?.error ?? text.slice(0, 200)}`))
  }
  return json as T
}

// --- direct reads. The driver is allowed to look at the tables a human cannot. --
const { withSession } = await import('@/lib/db')
const svc = (academyId: string) => ({ role: 'service' as const, academyId })

async function anyAcademyId(): Promise<string> {
  const { worldAcademyIds } = await import('@/lib/seed')
  const ids = await worldAcademyIds({ refresh: true })
  if (!ids.length) die(c.red('no academies exist — `npm run drive -- academy "<name>" --admin "<person>"` first.'))
  return ids[0] as string
}

async function q<T = any>(sql: string, academyId?: string): Promise<T[]> {
  const id = academyId ?? (await anyAcademyId())
  return withSession(svc(id), async (tx) => (await tx.unsafe(sql)) as unknown as T[])
}

/**
 * Which business a contact belongs to — by looking, in each of them.
 *
 * Every read here runs under a service session pinned to exactly one academy, because
 * that is how RLS works in this product. The lookup that resolves a contact's tenant was
 * itself running under `anyAcademyId()`, which is the *first* academy in the world — so
 * for a contact in any other business it returned zero rows, `academyId` came back
 * undefined, and every read after it defaulted to the wrong tenant again and found
 * nothing. `drive thread` printed nothing and exited 0. `drive tap` said "the last
 * message to that contact has no buttons."
 *
 * The failure is the product's own most dangerous shape wearing a driver's clothes: a
 * tenant-scoped read against the wrong tenant returns empty rather than raising, so the
 * caller reports "there is nothing there" instead of "I looked in the wrong place". In a
 * one-academy world it is invisible, which is why it survived — and it made every
 * finding about a second business unreliable, including "the bot went quiet".
 *
 * Memoised, because a driven turn resolves this several times.
 */
const academyOfContactCache = new Map<string, string>()

async function academyOfContact(contactId: string): Promise<string> {
  const cached = academyOfContactCache.get(contactId)
  if (cached) return cached
  const { worldAcademyIds } = await import('@/lib/seed')
  for (const id of await worldAcademyIds({ refresh: true })) {
    const rows = await withSession(svc(id), async (tx) =>
      (await tx.unsafe(`select 1 from contact where id = '${contactId}'::uuid limit 1`)) as unknown as unknown[],
    ).catch(() => [])
    if (rows.length) {
      academyOfContactCache.set(contactId, id)
      return id
    }
  }
  die(
    c.red(`no contact ${contactId} in any business — \`drive world\` lists who exists.`),
    c.dim('(a contact id from a business that has been dropped will land here too)'),
  )
}

function clip(s: unknown, n: number): string {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const money = (n: unknown) => `₹${Number(n ?? 0).toLocaleString('en-IN')}`

const sql = (s: string) => `'${String(s).replace(/'/g, "''")}'`

/**
 * Which businesses a read covers.
 *
 * `cost`, `evidence` and `money` fell back to `anyAcademyId()` whenever no contact was
 * given — the FIRST id `app.list_academies()` happened to return, which carries no
 * ordering guarantee. So "the world's money" was one unnamed tenant's money and which
 * tenant it was could change between two runs of the same command. A number you cannot
 * attribute is worse than no number, so the default is now every business, and
 * `--academy` narrows it deliberately.
 */
async function academiesInScope(contactId?: string): Promise<{ id: string; name: string }[]> {
  if (contactId) {
    const id = await academyOfContact(contactId)
    return [{ id, name: await academyName(id) }]
  }
  const wanted = flag('academy')
  if (wanted) {
    const { findAcademy } = await import('@/lib/seed')
    const found = await findAcademy(wanted)
    if (!found) die(c.red(`no academy matches "${wanted}" — \`drive world\` lists them.`))
    return [found]
  }
  const { worldAcademyIds } = await import('@/lib/seed')
  const ids = await worldAcademyIds({ refresh: true })
  if (!ids.length) die(c.red('the world is empty — `drive academy "<name>" --admin "<person>"` first.'))
  const out: { id: string; name: string }[] = []
  for (const id of ids) out.push({ id, name: await academyName(id) })
  return out
}

/**
 * Exactly one business, or an honest refusal.
 *
 * A command that WRITES cannot fall back to "the first academy in the list" the way a
 * report can: confirming a payment in a business you did not mean is not a wrong number
 * on a screen, it is money marked as received. So an ambiguous world is an error here
 * rather than a guess.
 */
async function theAcademy(contactId?: string): Promise<string> {
  const scope = await academiesInScope(contactId)
  if (scope.length === 1) return String(scope[0]?.id)
  die(
    c.red(`${scope.length} businesses exist — say which one you mean.`),
    c.dim('  name a contact in it, or pass --academy "<name>"'),
    ...scope.map((a) => c.dim(`    ${a.name}`)),
  )
}

async function academyName(id: string): Promise<string> {
  const rows = await q<any>(`select name from academy where id = '${id}'::uuid`, id)
  return String(rows[0]?.name ?? id)
}

// -----------------------------------------------------------------------------
// Affordances — what a person can actually tap.
// -----------------------------------------------------------------------------

/**
 * Every tappable thing on one message, in the order a person sees them.
 *
 * `tap` only ever read `payload->'buttons'`, so **a list row could not be tapped at
 * all** — and the list picker is the spec's primary affordance, the one thing offered
 * when there are more than three choices. Every list the product has ever sent went
 * untapped for the whole life of this driver, and `action` rows of that shape have a
 * 0% tap rate for exactly that reason rather than because nobody wanted them.
 *
 * Buttons come first so an index that used to mean "the nth button" still does.
 */
type Affordance = {
  n: number
  kind: 'button' | 'row'
  title: string
  actionId: string
  section: string | null
  description: string | null
}

function affordancesOf(payload: any): Affordance[] {
  const out: Affordance[] = []
  for (const b of Array.isArray(payload?.buttons) ? payload.buttons : []) {
    out.push({
      n: out.length + 1, kind: 'button', title: String(b?.title ?? '?'),
      actionId: String(b?.actionId ?? ''), section: null, description: null,
    })
  }
  for (const s of payload?.list?.sections ?? []) {
    for (const r of s?.rows ?? []) {
      out.push({
        n: out.length + 1, kind: 'row', title: String(r?.title ?? '?'),
        actionId: String(r?.actionId ?? ''), section: (s?.title as string) ?? null,
        description: (r?.description as string) ?? null,
      })
    }
  }
  return out
}

/**
 * A tap, posted down the same road the emulator's own UI posts one.
 *
 * `label` is for this console and may be annotated (`action <uuid>`, `Yes (list row)`).
 * `title` is the button's real label and is the only thing allowed onto the wire, because
 * that is what `button_reply.title` carries and therefore what the message body becomes.
 * The sites below that mint an action nobody ever rendered pass no title on purpose: there
 * is no label in that world, and inventing one would put words in a person's mouth.
 */
async function tapActionId(contactId: string, actionId: string, label: string, title?: string): Promise<void> {
  const at = await cursorNow()
  console.log(`${c.dim('  →')} ${c.green(`[tap] ${label}`)}`)
  await api('/api/emulator/inbound', { contactId, actionId, ...(title ? { text: title } : {}) })
  await showTurn(contactId, at, { full: has('full') })
}

/**
 * A button the product itself minted for this person and this operation, still live.
 *
 * Used to answer one question before every driven operation: is there a real affordance
 * to press, or am I about to reach past the conversation? The two are different tests
 * and the caller says which one it ran.
 */
async function liveOperationAction(
  academyId: string,
  contactId: string,
  op: OperationName,
  match: Record<string, string> = {},
): Promise<string | null> {
  const where = Object.entries(match)
    .map(([k, v]) => `and a.payload->'args'->>${sql(k)} = ${sql(v)}`)
    .join(' ')
  const rows = await q<any>(
    `select a.id from action a
      where a.minted_for_contact_id = '${contactId}'::uuid
        and a.consumed_at is null
        and (a.expires_at is null or a.expires_at > app.now())
        and a.payload->>'kind' = 'operation'
        and a.payload->>'op' = ${sql(op)} ${where}
      order by a.minted_at desc limit 1`,
    academyId,
  )
  return rows[0] ? String(rows[0].id) : null
}

/**
 * **Run an operation as this person — by tapping their real button when one exists.**
 *
 * Zero of every `session_coach` row ever created had been confirmed, because there was
 * no way to answer a coach prompt from here at all: the ladder fired, the button was
 * minted, and nothing could press it. Half the product hangs off that answer — coverage,
 * escalation, the register, the tally — so none of that had ever run either.
 *
 * Where the product has already minted the operation for this contact, that exact row is
 * tapped: same action id, same stored payload, no model call — a genuine end-to-end test
 * of the affordance the person was offered. Where it has not, the same operation is
 * minted here and tapped, which runs the WRITE but proves nothing about whether the bot
 * would ever have offered it. Those are different tests and the output says which ran,
 * because a driver that blurs them manufactures confidence.
 */
async function driveOperation(o: {
  contactId: string
  academyId: string
  op: OperationName
  args: Record<string, unknown>
  match?: Record<string, string>
  label: string
}): Promise<void> {
  const live = await liveOperationAction(o.academyId, o.contactId, o.op, o.match ?? {})
  if (live) {
    console.log(c.dim(`  tapping the live ${o.op} button the product minted  ${live}`))
    await tapActionId(o.contactId, live, o.label)
    return
  }
  const { mintAction } = await import('@/lib/actions')
  const id = await mintAction(
    { role: 'service', academyId: o.academyId },
    { payload: { kind: 'operation', op: o.op, args: o.args }, forContactId: o.contactId, ttlMinutes: 60 },
  )
  console.log(c.yellow(`  no live ${o.op} button for that person — minted one and tapped it`))
  console.log(c.dim('  (that runs the operation; it does not test whether the bot would have offered it)'))
  await tapActionId(o.contactId, id, o.label)
}

// -----------------------------------------------------------------------------
// Resolving the things the money half needs: a coach, a session, an account.
// -----------------------------------------------------------------------------

async function coachContext(contactId: string): Promise<{ academyId: string; coachId: string; name: string }> {
  const academyId = await academyOfContact(contactId)
  const rows = await q<any>(
    `select co.id as coach_id, co.status, p.full_name
       from contact c
       join person p on p.id = c.person_id
       join coach co on co.person_id = p.id and co.academy_id = c.academy_id
      where c.id = '${contactId}'::uuid`,
    academyId,
  )
  if (!rows[0]) {
    die(
      c.red('that contact is not a coach in their business — `drive world` shows who is.'),
      c.dim('  `drive new <academyId> --name "X" --role coach` makes one.'),
    )
  }
  return { academyId, coachId: String(rows[0].coach_id), name: String(rows[0].full_name) }
}

/**
 * The session a coach command is about.
 *
 * `answer` is the one they owe an answer on — soonest unanswered first, falling back to
 * whatever they are next on, so `drive confirm <coach>` needs no ids at all. `cover` is
 * the soonest uncovered session on a class they teach, which is what a cover offer is.
 * Coverage is spelled out here rather than calling `app.session_is_covered` so that this
 * reads the same rule §6.3 states, in the same place a reader is checking it.
 */
async function sessionForCoach(
  academyId: string,
  coachId: string,
  mode: 'answer' | 'cover',
): Promise<{ id: string; label: string }> {
  const covered =
    `exists (select 1 from session_coach sc where sc.session_id = s.id and sc.declined_at is null
              and (sc.confirmed_at is not null or sc.arrived_at is not null))`
  const rows =
    mode === 'answer'
      ? await q<any>(
          `select s.id, cl.name, s.starts_at
             from session s
             join class cl on cl.id = s.class_id
             join session_coach sc on sc.session_id = s.id and sc.coach_id = '${coachId}'::uuid
            where s.status = 'scheduled' and s.starts_at > app.now()
            order by (sc.confirmed_at is null and sc.declined_at is null) desc, s.starts_at
            limit 1`,
          academyId,
        )
      : await q<any>(
          `select s.id, cl.name, s.starts_at
             from session s
             join class cl on cl.id = s.class_id
            where s.status = 'scheduled' and s.starts_at > app.now()
              and not ${covered}
              and exists (select 1 from class_coach cc
                           where cc.class_id = cl.id and cc.coach_id = '${coachId}'::uuid)
            order by s.starts_at limit 1`,
          academyId,
        )
  if (!rows[0]) {
    die(
      c.red(
        mode === 'answer'
          ? 'that coach is not on any upcoming session — pass --session <id>'
          : 'no upcoming uncovered session on a class they teach — pass --session <id>',
      ),
      c.dim('  `drive world` lists the classes; `drive clock --next` moves time to the next one.'),
    )
  }
  return { id: String(rows[0].id), label: `${rows[0].name} @ ${rows[0].starts_at}` }
}

/** The academy's admin — who money is confirmed by, when the driver does not say. */
async function adminContactOf(academyId: string): Promise<{ contactId: string; name: string }> {
  const rows = await q<any>(
    `select c.id, p.full_name
       from academy_admin aa
       join person p on p.id = aa.person_id
       join contact c on c.person_id = p.id and c.academy_id = aa.academy_id
      where aa.academy_id = '${academyId}'::uuid
      order by p.full_name limit 1`,
    academyId,
  )
  if (!rows[0]) die(c.red('that business has no admin with a number — nobody can confirm money in it.'))
  return { contactId: String(rows[0].id), name: String(rows[0].full_name) }
}

/** The account a money command is about: named by its holder's contact, or by --account. */
async function accountFor(academyId: string, holderContactId?: string): Promise<{ id: string; name: string }> {
  const byFlag = flag('account')
  const rows = byFlag
    ? await q<any>(
        `select id, display_name from account
          where id::text = ${sql(byFlag)} or lower(display_name) like lower(${sql(`%${byFlag}%`)})
          limit 1`,
        academyId,
      )
    : await q<any>(
        `select ac.id, ac.display_name
           from account ac
           join contact c on c.person_id = ac.holder_person_id and c.academy_id = ac.academy_id
          where c.id = '${holderContactId}'::uuid`,
        academyId,
      )
  if (!rows[0]) {
    die(
      c.red(byFlag ? `no account matches "${byFlag}"` : 'that contact holds no account — money cannot be about them.'),
      c.dim('  `drive money` lists every account by name.'),
    )
  }
  return { id: String(rows[0].id), name: String(rows[0].display_name) }
}

/**
 * **Run a plan the model would have composed, as this person.**
 *
 * Not everything the product does has a named operation. §14.2.1 is explicit that the
 * model composes steps and the runtime guarantees the properties, and the spec's own
 * worked example — a family leaving, `update enrollment set ended_on = …` — is exactly
 * that shape. So an ending like that could only be driven by talking the model into
 * writing the plan, which tests the model's persuadability rather than the product.
 *
 * This mints the same `steps` action the runtime mints for a previewed change and taps
 * it, so the plan runs down `executePlan` with the same atomicity, the same diff and the
 * same staged messages. It runs as the person tapping, so RLS still caps it at what they
 * could have done by hand — which is why these are minted for the admin.
 *
 * **Seven more commands came here when the wrapper operations went.** `create_class`,
 * `add_coach`, `add_family`, `waive`, `request_payment`, `confirm_payment` and
 * `set_timing` were all a transaction of statements plus a note, and layers 0 and 1 hold
 * what they guaranteed. So this stopped being the path for the things nobody had built a
 * wrapper for, and became the path — which is what the product is doing too.
 */
async function drivePlan(o: {
  contactId: string
  academyId: string
  steps: PlanStep[]
  summary: string
  label: string
}): Promise<void> {
  const { mintAction } = await import('@/lib/actions')
  const id = await mintAction(
    { role: 'service', academyId: o.academyId },
    { payload: { kind: 'steps', steps: o.steps, summary: o.summary }, forContactId: o.contactId, ttlMinutes: 60 },
  )
  console.log(c.yellow('  no named operation does this — minted the plan §14.2.1 says the model composes, and tapped it'))
  console.log(c.dim('  (that runs the change; it does not test whether the bot would have composed it)'))
  for (const s of o.steps) console.log(c.dim(`    ${clip(JSON.stringify(s), 160)}`))
  await tapActionId(o.contactId, id, o.label)
}

// -----------------------------------------------------------------------------
// Resolving the things the scheduling and churn halves need.
// -----------------------------------------------------------------------------

/** Today where the business is. Every date argument in the product is a local date. */
async function todayIn(academyId: string): Promise<string> {
  const rows = await q<any>(
    `select ((app.now() at time zone a.timezone)::date)::text as d from academy a where a.id = '${academyId}'::uuid`,
    academyId,
  )
  return String(rows[0]?.d ?? '')
}

/**
 * A class by name — or a refusal that lists what there is.
 *
 * Names are matched case-insensitively on a substring, and **an ambiguous match is an
 * error rather than the first hit**. R5 is a comparison made on unnormalised values, and
 * "the first class whose name contains 'beginners'" in a business with two of them is
 * that root with a driver's face on.
 */
async function classFor(academyId: string, wanted?: string): Promise<{ id: string; name: string }> {
  const all = await q<any>(
    `select id, name from class where academy_id = '${academyId}'::uuid and active order by name`,
    academyId,
  )
  if (!all.length) {
    die(
      c.red('that business has no active classes.'),
      c.dim('  `drive class --name "6:30 Beginners" --day mon,wed --time 18:30-19:30` makes one.'),
    )
  }
  const hits = wanted
    ? all.filter((x: any) => String(x.name).toLowerCase().includes(wanted.toLowerCase()))
    : all
  if (hits.length === 1) return { id: String(hits[0].id), name: String(hits[0].name) }
  die(
    c.red(
      hits.length === 0
        ? `no class in that business matches "${wanted}".`
        : wanted
          ? `"${wanted}" matches ${hits.length} classes — say which:`
          : `that business has ${all.length} classes — say which with --class:`,
    ),
    ...(hits.length ? hits : all).map((x: any) => c.dim(`    ${x.name}`)),
  )
}

/**
 * The players on a holder's account, with whichever enrollment is still running.
 *
 * "Still running" is `ended_on is null OR ended_on >= today`, not `is null`. A child whose
 * last day is the 31st is enrolled today, and reading only the null case reported them as
 * "not enrolled in anything" — which would have made `end player` refuse to change a
 * leaving date that had already been set.
 */
async function playersOf(academyId: string, holderContactId: string): Promise<any[]> {
  return q<any>(
    `select pl.id as player_id, p.full_name, ac.id as account_id, ac.display_name,
            e.id as enrollment_id, e.ended_on::text as ended_on, cl.name as class_name, ac.holder_person_id
       from contact c
       join account ac on ac.holder_person_id = c.person_id and ac.academy_id = c.academy_id
       join player pl on pl.account_id = ac.id and pl.active
       join person p on p.id = pl.person_id
       left join enrollment e on e.player_id = pl.id
         and (e.ended_on is null or e.ended_on >= (app.now() at time zone
              (select timezone from academy where id = '${academyId}'::uuid))::date)
       left join class cl on cl.id = e.class_id
      where c.id = '${holderContactId}'::uuid
      order by p.full_name`,
    academyId,
  )
}

/**
 * The billing period a money command is about — `--period 2026-07`, or the month the
 * business is in now.
 *
 * `tally_line.period` is the first of the month as a date, so the flag is normalised to
 * that here rather than in three call sites, which is where R5 gets in.
 */
async function periodFor(academyId: string): Promise<string> {
  const raw = (flag('period') ?? '').trim()
  if (!raw) return `${(await todayIn(academyId)).slice(0, 7)}-01`
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(raw)
  if (!m) die(c.red(`--period wants a month as YYYY-MM (got "${raw}")`))
  return `${m[1]}-${m[2]}-01`
}

// -----------------------------------------------------------------------------
// Printing a turn: the reply, the buttons, and the flight recorder.
// -----------------------------------------------------------------------------

type Trace = { round: number; name: string; ms: number; args?: any; result?: any; error?: string }

/**
 * Everything that turn did, from the outside.
 *
 * **Including what it said to other people.** This used to read only
 * `contact_id = <the person you drove>`, so a turn whose whole job is to tell somebody
 * *else* — the coach that a child dropped out, the admin that a class has nobody on it,
 * the other coaches that cover has been taken — printed as silence. That is precisely
 * the traffic this product is judged on: §12's escalations and headcount changes exist
 * to reach a third party, and none of them were visible from here, so "it did nothing"
 * and "it told the right person" looked identical.
 *
 * One query over the whole business, in time order, with the recipient named. `thread`
 * asks for its one conversation instead, because a thread is a thread.
 */
async function showTurn(
  contactId: string,
  sinceIso: string,
  o: { full?: boolean; others?: boolean } = {},
): Promise<void> {
  const academyId = await academyOfContact(contactId)
  const others = o.others !== false

  const msgs = await q<any>(
    `select m.contact_id, m.direction, m.body, m.payload, m.status, m.suppressed_reason,
            m.solicited, m.catalog_id, m.created_at, p.full_name as who
       from message m
       join contact c on c.id = m.contact_id
       join person p on p.id = c.person_id
      where m.created_at > '${sinceIso}'::timestamptz
        ${others ? '' : `and m.contact_id = '${contactId}'::uuid`}
      order by m.created_at`,
    academyId,
  )
  const turns = await q<any>(
    `select role_acted, model, rounds, latency_ms, prompt_tokens, cached_tokens, output_tokens,
            error, tool_calls
       from turn
      where contact_id = '${contactId}'::uuid and created_at > '${sinceIso}'::timestamptz
      order by created_at`,
    academyId,
  )

  for (const m of msgs) {
    const mine = String(m.contact_id) === contactId
    const arrow = !mine ? c.yellow('  ⤳') : m.direction === 'inbound' ? c.dim('  →') : c.cyan('  ←')
    const flags: string[] = []
    // Who it reached is the point of showing it, so a third party is named on the line
    // rather than left for the reader to infer from the words.
    if (!mine) flags.push(c.yellow(`to ${String(m.who)}`))
    if (m.suppressed_reason) flags.push(c.red(`SUPPRESSED: ${m.suppressed_reason}`))
    else if (m.status !== 'sent' && m.status !== 'delivered' && m.status !== 'read') flags.push(m.status)
    if (m.catalog_id) flags.push(c.dim(m.catalog_id))
    if (m.direction === 'outbound' && !m.solicited) flags.push(c.dim('unsolicited'))
    console.log(`${arrow} ${o.full ? String(m.body ?? '') : clip(m.body, 300)}${flags.length ? `  ${flags.join(' · ')}` : ''}`)

    // Every affordance with the number that taps it and the id that addresses it. A list
    // row's action id was printed nowhere at all, so even somebody willing to read the
    // database by hand could not tap one.
    const list = m.payload?.list
    if (list?.buttonText) console.log(`     ${c.green(`LIST "${list.buttonText}"`)}`)
    for (const a of affordancesOf(m.payload)) {
      const where = a.section ? c.dim(` (${a.section})`) : ''
      const desc = a.description ? c.dim(` — ${clip(a.description, 60)}`) : ''
      console.log(
        `     ${c.green(`[${a.n}] ${a.title}`)}${where}${desc}  ${c.dim(`${a.kind} ${a.actionId}`)}`,
      )
    }
    // §14.6 — a link is a button now, so it is no longer in the body where `open` used
    // to find it. A driver that cannot see the product's own affordances is a driver
    // that reports them as missing.
    if (m.payload?.link?.url) {
      console.log(`     ${c.green(`↗ [ ${m.payload.link.title} ]`)} ${c.dim(clip(m.payload.link.url, 60))}`)
    }
  }

  for (const t of turns) {
    const cacheRatio = t.prompt_tokens ? Math.round((100 * (t.cached_tokens ?? 0)) / t.prompt_tokens) : 0
    const inr = costInr(String(t.model ?? ''), t.prompt_tokens ?? 0, t.cached_tokens ?? 0, t.output_tokens ?? 0)
    console.log(
      c.dim(
        `     · ${t.role_acted} · ${t.rounds ?? '?'} round(s) · ${((t.latency_ms ?? 0) / 1000).toFixed(1)}s · ` +
          `${t.prompt_tokens ?? 0} in (${cacheRatio}% cached) / ${t.output_tokens ?? 0} out` +
          (inr === null ? '' : ` · ₹${inr.toFixed(2)}`),
      ),
    )
    if (t.error) console.log(`     ${c.red(`· error: ${clip(t.error, 300)}`)}`)
    // A `tool_calls` that arrives as a STRING is a jsonb string scalar, which is what a
    // `::jsonb` cast on a parameter silently produces. Iterating one yields characters,
    // and the driver died mid-turn on `call.name.padEnd` — hiding every other thing that
    // turn did behind a stack trace. Parse it, so a badly written row is legible evidence
    // rather than a crash.
    const trace: Trace[] = Array.isArray(t.tool_calls)
      ? t.tool_calls
      : typeof t.tool_calls === 'string'
        ? (() => {
            try {
              const parsed = JSON.parse(t.tool_calls)
              return Array.isArray(parsed) ? parsed : []
            } catch {
              return []
            }
          })()
        : []
    for (const call of trace) {
      // A per-round record of the model itself, not a tool. It leads its round —
      // what the model wrote, what it then reached for, and what that round cost —
      // so the calls printed under it read as consequences rather than as a list.
      if (!isToolCall(call)) {
        const u = (call.result ?? {}) as any
        const rInr = costInr(String(t.model ?? ''), Number(u.in ?? 0), Number(u.cached ?? 0), Number(u.out ?? 0))
        const spend =
          `${Number(u.in ?? 0)} in` +
          (u.cached ? ` (${Math.round((100 * Number(u.cached)) / Math.max(1, Number(u.in ?? 0)))}% cached)` : '') +
          ` / ${Number(u.out ?? 0)} out` +
          (rInr === null ? '' : ` · ₹${rInr.toFixed(2)}`)
        console.log(
          c.dim(
            `     ── round ${call.round} · ${(call.ms / 1000).toFixed(1)}s · ${spend}` +
              (u.finish && u.finish !== 'STOP' ? ` · ${c.yellow(String(u.finish))}` : '') +
              (u.recovery ? ' · recovery' : ''),
          ),
        )
        const said =
          typeof call.args === 'string' ? call.args : (call.args as any)?.returnedNothing ? '' : JSON.stringify(call.args)
        if (said) {
          // Indented under the round and marked, because these are the model's own
          // words BEFORE the send path touched them — what the person actually read
          // is the `message` row above, and confusing the two is how a round gets
          // written up as a defect the customer never saw.
          for (const line of clip(said, o.full ? 4000 : 400).split('\n')) console.log(c.dim(`        ┊ ${line}`))
        } else if (!Array.isArray(u.calls) || !u.calls.length) {
          console.log(`        ${c.red('┊ (model returned nothing)')}`)
        }
        if (call.error) console.log(`        ${c.red(`! ${clip(call.error, 300)}`)}`)
        continue
      }
      const detail =
        call.name === 'read'
          ? clip(call.args?.query, o.full ? 4000 : 200)
          : clip(typeof call.args === 'string' ? call.args : JSON.stringify(call.args), o.full ? 4000 : 160)
      console.log(`       ${c.blue(call.name.padEnd(10))} ${c.dim(`${call.ms}ms`)}  ${detail}`)
      if (call.result !== undefined) {
        const r = clip(typeof call.result === 'string' ? call.result : JSON.stringify(call.result), o.full ? 4000 : 200)
        console.log(`                  ${c.dim(`→ ${r}`)}`)
      }
      if (call.error) console.log(`                  ${c.red(`! ${clip(call.error, 300)}`)}`)
    }
  }
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain',
  ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
}

/** A file off the disk, as the composer's 📎 would hand it over: a data URI. */
async function attach(path: string): Promise<{ dataUri: string; mimeType: string; bytes: number }> {
  const { readFile } = await import('node:fs/promises')
  const buf = await readFile(path).catch((e) => die(c.red(`cannot read ${path}: ${e.message}`)))
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  const mimeType = flag('mime') || MIME[ext] || 'application/octet-stream'
  return { dataUri: `data:${mimeType};base64,${buf.toString('base64')}`, mimeType, bytes: buf.length }
}

/**
 * The cursor for "everything that happened from here on" — in DOMAIN time, again.
 *
 * This has flipped twice, and each flip followed `created_at`. Originally it read
 * domain time against wall-time `created_at`, so the moment anybody advanced the
 * clock the cursor sat in the future and `say`/`tap` printed nothing. It became
 * wall time to match the wall-time default. 0027 then moved `created_at` itself
 * onto the tenant clock (F-N — so the model's own "what went out today?" reads
 * true in driven worlds), which put THIS cursor on the wrong side of the same
 * mismatch: a wall cursor against domain stamps re-prints the whole backlog on
 * every say once the clock is ahead. The rule that survives both flips: the
 * cursor and the column must be on ONE clock, and the column's clock wins.
 *
 * `app.now()` with no tenant GUC resolves to the world clock, which is the clock
 * this driver moves. Falls back to wall time if the database cannot be asked —
 * in an unadvanced world the two are identical.
 */
async function cursorNow(): Promise<string> {
  try {
    const rows = await q<{ at: string }>(`select app.now()::text as at`)
    if (rows[0]?.at) return new Date(rows[0].at).toISOString()
  } catch {
    /* fall through */
  }
  return new Date().toISOString()
}

// -----------------------------------------------------------------------------
// Help. A subcommand nobody can find is a subcommand nobody runs.
// -----------------------------------------------------------------------------

/**
 * Every subcommand, in the shape you type it.
 *
 * `link`, `register` and `evidence` all shipped and then appeared in no help text, so the
 * only way to find out they existed was to read this file — which, for anyone driving
 * the product rather than editing it, is the same as their not existing. The `case`
 * labels in `main` are the truth; this list is checked against them by
 * `reportUndocumented` rather than trusted, because a hand-kept list of commands drifts
 * the first time somebody is in a hurry.
 */
const HELP: [string, string][] = [
  ['world', 'who exists, with contact ids'],
  ['reset', 'wipe everything (no seed)'],
  ['seed [--scenario ace|solo|both]', 'the deterministic two-academy fixture'],
  ['seed --stage empty|setup|roster|ready|live|mature', 'one business at a lifecycle stage'],
  ['academy "<name>" --admin "<person>"', 'create a business + its admin'],
  ['drop <academyId|"name">', 'delete a business and everything in it'],
  ['remove <contactId>', 'delete one person and their rows'],
  ['new [academyId] --name X --role client|coach|admin|prospect', 'add a person, wired up'],
  ['new … --class "<class>" [--invite] [--rate N --unit per_month]', 'and put them ON that class'],
  ['say <contactId> "<text>" [--media f]', 'type as that person, with an attachment'],
  ['stranger <+91...> "<text>" [--media f]', 'an unknown number, cold'],
  ['tap <contactId> [n] [--title|--action|--message]', 'tap a button OR a list row, new or old'],
  ['confirm <coachContactId> [--session] [--arrived]', 'a coach says yes'],
  ['decline <coachContactId> [--session] [--yes]', "a coach says they can't"],
  ['claim <coachContactId> [--session]', 'a coach takes an uncovered session'],
  ['present <coachContactId> [--session]', 'the [All present] chat button, tapped'],
  ['class --name X --day mon,wed --time 18:30-19:30', 'create a class and its sessions'],
  ['cancel [--session <id>] [--class X] [--reason]', 'cancel one session'],
  ['move --session <id> --to <iso> | --class X --day tue', 'reschedule one, or move the slot'],
  ['timing <contactId> --key <name> --value 90', "one person's prompt timing (§8.2)"],
  ['end coach <contactId> [--on] [--reassign] [--notify]', 'a coach leaves (§8.3)'],
  ['end player <holderContactId> [--player X] [--all]', 'a family leaves — ends the enrollment'],
  ['end contact <contactId> [--yes]', 'stop messaging that number'],
  ['waive <holderContactId> --amount N --reason "…"', 'a credit, a waiver, a pro-rate'],
  ['pay request <holderContactId> [--amount]', 'ask an account for what is owed'],
  ['pay attest <holderContactId> [--ref] [--media]', 'the family says they have paid'],
  ['pay confirm [adminContactId] [--payment]', 'the admin says it came in (Rail 1)'],
  ['register <coachContactId> [--absent "A,B"] [--late "C"] [--note "…"]', 'take a register without hand-writing JSON'],
  ['clock +2h | --to <iso> | --next | --reset', 'move domain time, then run what is due'],
  ['tick', 'run due jobs without moving time'],
  ['month [--period 2026-07] [--academy X]', 'close a period: lines, tally, dunning'],
  ['deliver [--read] [--limit N]', 'sent → delivered → read, one rung a call'],
  ['fault [<kind> on|off] [--rate 0.5]', 'inject a failure (§17), or list them'],
  ['thread <contactId> [--others] [--full]', 'the conversation + flight recorder'],
  ['turn [contactId] [--n 3] [--academy X]', 'inside the last N turns: every round, what it wrote, what it cost'],
  ['cost [contactId] [--academy X]', 'tokens, cache ratio, latency per turn'],
  ['evidence [contactId] [--academy X]', 'what the seven axes are judged on — no verdicts'],
  ['money [contactId] [--academy X] [--period 2026-07|all]', 'billed vs confirmed vs awaiting vs failed'],
]

/**
 * Read this file's own `case` labels and say where they and `HELP` disagree.
 *
 * The point is not tidiness. Three commands were undiscoverable for exactly as long as
 * nobody happened to reread the switch, and the next one added will be too unless
 * forgetting is made visible at the moment somebody asks for help.
 */
async function reportUndocumented(): Promise<void> {
  const { readFile } = await import('node:fs/promises')
  const { fileURLToPath } = await import('node:url')
  const src = await readFile(fileURLToPath(import.meta.url), 'utf8').catch(() => '')
  if (!src) return
  const implemented = new Set([...src.matchAll(/^\s*case '([a-z-]+)':/gm)].map((m) => String(m[1])))
  implemented.delete('help')
  const documented = new Set(HELP.map(([name]) => String(name.split(/\s/)[0]).toLowerCase()))
  const missing = [...implemented].filter((k) => !documented.has(k))
  const stale = [...documented].filter((k) => !implemented.has(k))
  if (missing.length) console.log(c.red(`  not in this list, but implemented: ${missing.join(', ')}\n`))
  if (stale.length) console.log(c.red(`  listed here, but not implemented: ${stale.join(', ')}\n`))
}

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  switch (cmd) {
    case 'reset': {
      // The most destructive command in the repo, and until now the least guarded:
      // `resetWorld` deletes every academy `app.list_academies()` returns, cascades
      // every tenant table, then empties `job`, `sim_fault` and `sender` — the last
      // taking the live Cloud credentials with it. `/api/emulator/seed` refuses this
      // work in production; this path never asked anyone.
      const { refuseOnRealData } = await import('./_danger')
      await refuseOnRealData('drive reset', {
        force: has('force-on-real-data'),
        what: 'It would delete every academy, every conversation, every job, and the sender row holding the Cloud credentials.',
      })
      const { resetWorld } = await import('@/lib/seed')
      await resetWorld()
      console.log(c.green('world wiped — no academies, no people, no jobs, clock at real time.'))
      break
    }

    case 'seed': {
      /**
       * `--stage` builds ONE business at a named point in its life and leaves the rest of
       * the world alone; `--scenario` is the old whole-world fixture and still truncates
       * everything, which is why the two are different flags rather than one.
       *
       * Only two states were ever seedable — a 45-day-old academy in full flight, and a
       * brand-new empty shell — so every stage between them was reachable only by driving
       * a conversation for an hour first, and in practice nobody did. Nothing that reads
       * history had ever been given any: no seeded world contained a single message.
       */
      const stage = flag('stage')
      if (stage) {
        const { seedStage, STAGES } = await import('@/lib/seed')
        if (!(STAGES as readonly string[]).includes(stage)) {
          die(c.red(`no such stage "${stage}" — one of ${STAGES.join(', ')}`))
        }
        // `--stage` truncates nothing but its own fixture, so this is not about data
        // loss. It is about §10.1: a stage academy is born on the SHARED sender, which
        // in production is the live number, and it joins `app.inbound_candidates` for
        // every real cold inbound — a stranger who types "bluewave" answered by a
        // fixture. `seedStage` marks it `is_sandbox` (lib/seed.ts) so the console can
        // still remove it, but a fixture business does not belong beside a real one at
        // all, and that is the operator's call rather than this script's.
        const { refuseOnRealData } = await import('./_danger')
        await refuseOnRealData('drive seed --stage', {
          force: has('force-on-real-data'),
          what: 'A stage fixture is created on the shared sender, so it joins the candidate list every unknown inbound number is matched against.',
        })
        const out = await seedStage(stage as (typeof STAGES)[number], {
          slug: flag('slug'),
          name: flag('name'),
          timezone: flag('tz'),
        })
        console.log(c.green(`seeded ${out.name} at stage "${out.stage}"`))
        console.log(`  academy_id  ${out.academyId}`)
        if (out.adminContactId) console.log(`  admin       ${out.adminContactId}`)
        for (const [role, list] of Object.entries(out.contacts)) {
          for (const p of list) console.log(`  ${role.padEnd(11)} ${c.cyan(p.contactId)}  ${p.name}`)
        }
        console.log(c.dim(`  ${Object.entries(out.counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`))
        break
      }
      const out = await api('/api/emulator/seed', { scenario: flag('scenario') ?? 'both' })
      console.log(c.green('seeded'), c.dim(JSON.stringify(out.counts ?? out)))
      break
    }

    /** Create an academy and its first admin, the way the product would after signup. */
    case 'academy': {
      const name = positional[0]
      const admin = flag('admin')
      if (!name || !admin) die(c.red('drive academy "<academy name>" --admin "<admin person name>" [--phone +91...] [--tz Asia/Kolkata] [--category badminton]'))
      const { createAcademy } = await import('@/lib/seed')
      const out = await createAcademy({
        name,
        adminName: admin,
        adminPhone: flag('phone'),
        timezone: flag('tz') ?? 'Asia/Kolkata',
        category: flag('category') ?? 'sport',
      })
      console.log(c.green('academy created'))
      console.log(`  academy_id  ${out.academyId}`)
      console.log(`  admin       ${admin}  ${out.adminPhone}`)
      console.log(`  contact_id  ${out.adminContactId}`)
      console.log(c.dim(`  onboarding_state = ${out.onboardingState}`))
      break
    }

    /**
     * Signup is the operator's, by design: the owner of Class Manager creates a
     * business, and a stranger messaging the number never can. So making and
     * unmaking one has to be one command here — before this, the world had two
     * states, everything or nothing, and trying a second business meant wiping
     * the first.
     */
    case 'drop': {
      const which = positional[0]
      if (!which) die(c.red('drive drop <academyId|"name">   — delete a business and everything in it'))
      const { dropAcademy } = await import('@/lib/seed')
      const gone = await dropAcademy(which)
      if (!gone) die(c.red(`no academy matches "${which}" — \`drive world\` lists them.`))
      console.log(c.green(`dropped ${gone.name}`), c.dim(gone.id))
      break
    }

    case 'remove': {
      const contactId = positional[0]
      if (!contactId) die(c.red('drive remove <contactId>   — delete a person, their numbers and their rows'))
      const { dropPerson } = await import('@/lib/seed')
      const gone = await dropPerson(contactId)
      if (!gone) die(c.red('no contact with that id — `drive world` lists them.'))
      console.log(c.green(`removed ${gone.name}`), c.dim(gone.personId))
      break
    }

    case 'new': {
      const academyId = positional[0] ?? (await anyAcademyId())
      const name = flag('name')
      const role = (flag('role') ?? 'client') as 'client' | 'coach' | 'admin' | 'prospect'
      if (!name) {
        die(
          c.red('drive new [academyId] --name "<person>" --role client|coach|admin|prospect [--phone +91...]'),
          c.dim('  --class "6:30 Beginners"   which class — a client is enrolled in it, a coach is assigned to it'),
          c.dim('  --invite                   (coach) also draft and mark the invite sent, which is what makes them `invited`'),
          c.dim('  --rate 2400 --unit per_month   (client) what they pay, so month-end has something to bill'),
        )
      }

      /**
       * **A roster you can build on purpose.**
       *
       * `/api/emulator/contact` makes a person and guesses the rest: a client lands in
       * "the first active class that runs", which in a business with three of them is a
       * coin toss, and a coach is inserted `active`, `onboarded_at` already set, assigned
       * to nothing. So the coach ladder had nothing to fire on — `coach_not_onboarded`
       * wants `status = 'invited'`, `coach_day` and `coach_coming` want an assignment —
       * and every driven coach was born past the whole of §8.1.
       *
       * With `--class` this goes down the product's own path instead: `add_coach` writes
       * the coach `added`, wires `class_coach` AND back-fills `session_coach` for every
       * upcoming session, and `add_family` enrols the player in the class you named at the
       * rate you named. Both are the operations an admin's own sentence reaches, so what
       * is built here is what the product builds.
       */
      const wantedClass = flag('class')
      if (wantedClass && (role === 'coach' || role === 'client')) {
        const cls = await classFor(academyId, wantedClass)
        const admin = await adminContactOf(academyId)
        const phone = flag('phone') ?? `+9199${String(Math.floor(Date.now() / 1000) % 100000000).padStart(8, '0')}`
        console.log(c.dim(`  ${name} · ${role} · ${cls.name} · ${phone}`))
        /**
         * The rows a coach is, and the rows a family is.
         *
         * `add_coach` and `add_family` were the operations these called. Both
         * were inserts plus a note, and both went — the invariants they carried
         * live below them now: the phone is normalised by a trigger (0012) and a
         * placeholder is refused by a constraint (0033), `session_coach` is
         * back-filled from `class_coach` by the materialiser the trigger fires,
         * and a coach who is already an admin is activated on insert rather than
         * waiting for an invite they would have to send themselves.
         */
        const person = `(select id from person where academy_id = app.academy_id() and full_name = ${sql(name)} order by created_at desc limit 1)`
        if (role === 'coach') {
          const rate = flag('rate') ? Number(flag('rate')) : null
          const unit = flag('unit') ?? null
          await drivePlan({
            contactId: admin.contactId, academyId,
            summary: `add ${name} as a coach on ${cls.name}`,
            label: `Add ${name} as a coach`,
            steps: [
              { write: `insert into person (academy_id, full_name) values (app.academy_id(), ${sql(name)})` },
              { write: `insert into contact (academy_id, person_id, phone_e164) values (app.academy_id(), ${person}, ${sql(phone)})` },
              {
                write:
                  `insert into coach (academy_id, person_id, status${rate !== null ? ', pay_amount' : ''}${unit ? ', pay_unit' : ''})` +
                  ` values (app.academy_id(), ${person}, 'added'${rate !== null ? `, ${rate}` : ''}${unit ? `, ${sql(unit)}` : ''})`,
              },
              {
                write:
                  `insert into class_coach (academy_id, class_id, coach_id)` +
                  ` values (app.academy_id(), ${sql(cls.id)}::uuid,` +
                  ` (select id from coach where person_id = ${person} and academy_id = app.academy_id()))`,
              },
              { note: `${name} is on ${cls.name}` },
            ],
          })
        } else {
          const rate = flag('rate') ? Number(flag('rate')) : null
          const unit = flag('unit') ?? null
          const since = flag('since') ?? null
          const playerName = flag('player') ?? name
          const account = `(select id from account where academy_id = app.academy_id() and holder_person_id = ${person} order by created_at desc limit 1)`
          const player = `(select pl.id from player pl join person pe on pe.id = pl.person_id where pl.academy_id = app.academy_id() and pe.full_name = ${sql(playerName)} order by pl.created_at desc limit 1)`
          await drivePlan({
            contactId: admin.contactId, academyId,
            summary: `add ${name}'s family, with ${playerName} in ${cls.name}`,
            label: `Add ${name}'s family`,
            steps: [
              { write: `insert into person (academy_id, full_name) values (app.academy_id(), ${sql(name)})` },
              { write: `insert into contact (academy_id, person_id, phone_e164) values (app.academy_id(), ${person}, ${sql(phone)})` },
              { write: `insert into account (academy_id, holder_person_id, display_name) values (app.academy_id(), ${person}, ${sql(name)})` },
              ...(playerName === name
                ? []
                : [{ write: `insert into person (academy_id, full_name) values (app.academy_id(), ${sql(playerName)})` }]),
              {
                write:
                  `insert into player (academy_id, account_id, person_id) values (app.academy_id(), ${account},` +
                  ` (select id from person where academy_id = app.academy_id() and full_name = ${sql(playerName)} order by created_at desc limit 1))`,
              },
              {
                write:
                  `insert into enrollment (academy_id, class_id, player_id, started_on${rate !== null ? ', rate_amount' : ''}${unit ? ', rate_unit' : ''})` +
                  ` values (app.academy_id(), ${sql(cls.id)}::uuid, ${player},` +
                  ` ${since ? `date ${sql(since)}` : '(app.now() at time zone (select timezone from academy where id = app.academy_id()))::date'}` +
                  `${rate !== null ? `, ${rate}` : ''}${unit ? `, ${sql(unit)}` : ''})`,
              },
              { note: `${playerName} is enrolled in ${cls.name}` },
            ],
          })
        }
        const made = await q<any>(
          `select ct.id as contact_id, p.full_name,
                  (select co.status from coach co where co.person_id = p.id) as coach_status,
                  (select count(*) from class_coach cc join coach co on co.id = cc.coach_id
                    where co.person_id = p.id) as classes,
                  (select count(*) from session_coach sc join coach co on co.id = sc.coach_id
                    where co.person_id = p.id) as sessions,
                  (select count(*) from enrollment e join player pl on pl.id = e.player_id
                    join account ac on ac.id = pl.account_id
                   where ac.holder_person_id = p.id and e.ended_on is null) as enrollments
             from contact ct join person p on p.id = ct.person_id
            where ct.academy_id = '${academyId}'::uuid and ct.phone_e164 = ${sql(phone)}`,
          academyId,
        )
        if (!made[0]) die(c.red('  nothing was created — read the reply above; the operation refused.'))
        console.log(`  contact_id ${c.cyan(String(made[0].contact_id))}`)
        console.log(
          c.dim(
            role === 'coach'
              ? `  coach: ${made[0].coach_status} · ${made[0].classes} class(es) · ${made[0].sessions} upcoming session(s) assigned`
              : `  ${made[0].enrollments} open enrollment(s)`,
          ),
        )
        if (role === 'coach' && has('invite')) {
          // §8.1 — `added` is not `invited`, and only `invited` is what the admin's
          // "they never onboarded" escalation looks for. One call moves it now: the bot
          // sends the invite itself, so there is no second "I have forwarded it" step to
          // wait for and no `mark_sent` to match on.
          const coach = await coachContext(String(made[0].contact_id))
          await driveOperation({
            contactId: admin.contactId, academyId, op: 'send_invite',
            args: { coach_id: coach.coachId },
            match: { coach_id: coach.coachId },
            label: `Sent ${name}'s invite`,
          })
          const st = await q<any>(`select status, invited_at from coach where id = '${coach.coachId}'::uuid`, academyId)
          console.log(c.dim(`  coach row: status ${st[0]?.status} · invited_at ${st[0]?.invited_at ?? '·'}`))
        }
        break
      }
      if (wantedClass) die(c.red(`--class means nothing for a ${role} — it wires a coach's assignment or a client's enrollment.`))

      const out = await api('/api/emulator/contact', {
        academyId,
        name,
        role,
        ...(flag('phone') ? { phone: flag('phone') } : {}),
      })
      console.log(c.green(`${role} created`))
      console.log(`  contact_id ${out.contact.contactId ?? out.contact.id}`)
      console.log(`  phone      ${out.contact.phone ?? out.contact.phone_e164}`)
      break
    }

    case 'say': {
      const contactId = positional[0]
      const text = positional.slice(1).join(' ')
      const media = flag('media')
      if (!contactId || (!text && !media)) die(c.red('drive say <contactId> "<what they type>" [--media <file>]'))
      const at = await cursorNow()
      // `--media` no longer reaches the model — it is text-only (§14.5, repealed) —
      // and that is exactly why this stays: what it drives now is the runtime's
      // answer to an attachment, which is the guarantee that replaced the
      // capability. A voice note and a photo should come back with different
      // sentences, and anything typed alongside should still be answered.
      const attached = media ? await attach(media) : null
      console.log(`${c.dim('  →')} ${text}${attached ? c.dim(`  [${attached.mimeType}, ${attached.bytes} bytes]`) : ''}`)
      await api('/api/emulator/inbound', {
        contactId,
        ...(text ? { text } : {}),
        ...(attached ? { mediaUrl: attached.dataUri, mediaMimeType: attached.mimeType } : {}),
      })
      await showTurn(contactId, at, { full: has('full') })
      break
    }

    /** An unknown number arriving cold — the §10.1 path a contact row cannot test. */
    case 'stranger': {
      const phone = positional[0]
      const text = positional.slice(1).join(' ')
      const media = flag('media')
      if (!phone || (!text && !media)) die(c.red('drive stranger <+91...> "<what they type>" [--media <file>]'))
      const { ingestInbound, SENDER_PHONE } = await import('@/lib/seed')
      const at = await cursorNow()
      // A stranger's first message being an attachment is the worst case of the
      // text-only trade (§14.5): nobody has told them yet that it cannot be read, and
      // silence here is a lost enquiry. Drivable from here because `say` needs a
      // contact row a stranger by definition does not have.
      const attached = media ? await attach(media) : null
      console.log(
        `${c.dim('  →')} ${text}${attached ? c.dim(`  [${attached.mimeType}, ${attached.bytes} bytes]`) : ''}  ` +
          c.dim(`(from ${phone}, unknown)`),
      )
      const out: any = await ingestInbound({
        fromPhoneE164: phone.startsWith('+') ? phone : `+${phone}`,
        senderPhoneE164: flag('to') ?? SENDER_PHONE,
        profileName: flag('as'),
        ...(text ? { text } : {}),
        ...(attached ? { mediaUrl: attached.dataUri, mediaMimeType: attached.mimeType } : {}),
        source: 'emulator',
      })
      if (out.unresolved) {
        console.log(c.yellow('  unresolved — more than one academy could own this number:'))
        for (const cand of out.candidates ?? []) console.log(`    ${cand.name}  ${cand.academyId}`)
        break
      }
      const contactId = out.contactId ?? out.identity?.contact?.id
      console.log(c.dim(`  resolved to contact ${contactId}${out.isNew ? ' (new)' : ''}`))
      if (contactId) await showTurn(contactId, at, { full: has('full') })
      break
    }

    /**
     * **Tap anything the bot has offered — not just the newest button.**
     *
     * Two things made most of the product's own affordances unreachable. The query only
     * ever looked at `payload->'buttons'`, so a **list row could not be tapped at all**
     * even though the list picker is what the spec reaches for whenever there are more
     * than three choices. And it took `limit 1`, so the moment any later message arrived,
     * an outstanding prompt — the coach confirmation from an hour ago, the register offer
     * from this morning — was gone: the ladder above it kept firing and nothing could
     * answer it. Both are fixed here rather than in the product, because the product was
     * offering these correctly the whole time; only the driver could not press them.
     */
    case 'tap': {
      const contactId = positional[0]
      const which = Number(positional[1] ?? flag('n') ?? '1')
      const wantTitle = flag('title')
      const messageId = flag('message')
      const direct = flag('action')
      if (!contactId) {
        die(
          c.red('drive tap <contactId> [n]  — tap the nth button or list row of the last message with either'),
          c.dim('  --action <actionId>    tap exactly that action, however old'),
          c.dim('  --message <messageId>  index into that message instead of the newest'),
          c.dim('  --title "Yes, I\'m"     the newest affordance whose title contains this'),
          c.dim('  --older                tap the nearest older message, when the newest offers nothing'),
          c.dim('  `drive thread <contactId>` prints every affordance with its number and id'),
        )
      }
      const academyId = await academyOfContact(contactId)

      if (direct) {
        // An id copied straight out of `thread`. Nothing is checked here on purpose: an
        // expired or already-used action is a real product outcome with a real reply, and
        // refusing it in the driver would hide the reply that proves it.
        await tapActionId(contactId, direct, `action ${direct}`)
        break
      }

      // Everything the bot said, affordance or not. The filter used to be in the SQL, which
      // meant the driver could not tell "the newest message offers nothing" from "the newest
      // message offers this" — and quietly answered the second question when you asked the
      // first. `affordancesOf` is the one definition of "offered something", so it decides
      // here too rather than a `jsonb_typeof` predicate that has to agree with it.
      const recent = await q<any>(
        `select id, payload, body, created_at from message
          where contact_id = '${contactId}'::uuid and direction = 'outbound'
            and suppressed_reason is null
          order by created_at desc limit 25`,
        academyId,
      )
      const rows = recent.filter((r: any) => affordancesOf(r.payload).length > 0)
      const candidates = messageId ? rows.filter((r: any) => String(r.id) === messageId) : rows
      if (!candidates.length) {
        die(
          c.red(
            messageId
              ? `message ${messageId} carries no buttons or list rows.`
              : 'nothing the bot sent that contact in the last 25 messages carries a button or a list.',
          ),
        )
      }

      let picked: Affordance | undefined
      let fromBody = ''
      if (wantTitle) {
        // Newest first, so "the one it just offered" wins when a title repeats.
        for (const r of candidates) {
          const hit = affordancesOf(r.payload).find((a) =>
            a.title.toLowerCase().includes(wantTitle.toLowerCase()),
          )
          if (hit) {
            picked = hit
            fromBody = String(r.body ?? '')
            break
          }
        }
        if (!picked) die(c.red(`no affordance in the last 25 messages has a title containing "${wantTitle}".`))
      } else {
        const target = candidates[0]
        // **The fallback that made this command lie.** `tap <contact> 2` means "the second
        // thing it just offered me", and when the newest message offered nothing this walked
        // silently backwards to an older one and answered about that instead — so a message
        // with a list was skipped, an old two-button prompt was read, and the driver reported
        // *"there is no button 3 — there are 2"* with total confidence. Wrong answers that
        // read as findings are worse than a missing feature, so it refuses and names both
        // messages. `--older` is the way to mean it.
        const skipped = messageId ? 0 : recent.findIndex((r: any) => String(r.id) === String(target.id))
        if (skipped > 0 && !has('older')) {
          die(
            c.red(`the last ${skipped} message(s) to that contact carry nothing to tap.`),
            ...recent.slice(0, skipped).map((r: any) => c.dim(`    newest → ${clip(r.body, 90)}`)),
            c.red(`  the nearest message that offers anything is ${skipped} back:`),
            c.dim(`    ${clip(target.body, 90)}`),
            ...affordancesOf(target.payload).map((a) => c.dim(`      [${a.n}] ${a.title}  (${a.kind})`)),
            c.dim('  --older to tap it anyway, or --message <id> / --action <id> / --title "…" to say which.'),
          )
        }
        const all = affordancesOf(target.payload)
        picked = all[which - 1]
        fromBody = String(target.body ?? '')
        if (!picked) {
          die(
            c.red(`there is no affordance ${which} — that message offers ${all.length}:`),
            ...all.map((a) => c.dim(`    [${a.n}] ${a.title}  (${a.kind})`)),
          )
        }
      }

      console.log(c.dim(`  on: ${clip(fromBody, 90)}`))
      await tapActionId(
        contactId,
        picked.actionId,
        `${picked.title}${picked.kind === 'row' ? ' (list row)' : ''}`,
        picked.title,
      )
      break
    }

    /**
     * **A coach answers.** §8.2's ladder had never once been answered by anybody: not one
     * `session_coach` row in any world ever driven carried a `confirmed_at`, so coverage,
     * the escalation that follows silence, and everything downstream of a class actually
     * happening were untested from end to end.
     */
    case 'confirm':
    case 'decline':
    case 'claim': {
      const contactId = positional[0]
      if (!contactId) {
        die(
          c.red(`drive ${cmd} <coachContactId> [--session <id>]`),
          c.dim('  confirm  [--arrived] [--late]   yes, and optionally: I am here / I am running late'),
          c.dim('  decline  [--reason "..."] [--yes]   --yes skips the "are you sure" the product asks first'),
          c.dim('  claim                            take a session that has nobody on it'),
        )
      }
      const coach = await coachContext(contactId)
      const sessionId =
        flag('session') ?? (await sessionForCoach(coach.academyId, coach.coachId, cmd === 'claim' ? 'cover' : 'answer')).id
      console.log(c.dim(`  ${coach.name} · session ${sessionId}`))

      if (cmd === 'confirm') {
        await driveOperation({
          contactId, academyId: coach.academyId, op: 'confirm_coach',
          args: {
            session_id: sessionId, coach_id: coach.coachId,
            arrived: has('arrived'), running_late: has('late'),
          },
          match: { session_id: sessionId },
          label: has('arrived') ? "I'm here" : "Yes, I'm coming",
        })
      } else if (cmd === 'claim') {
        await driveOperation({
          contactId, academyId: coach.academyId, op: 'claim_cover',
          args: { session_id: sessionId, coach_id: coach.coachId },
          match: { session_id: sessionId },
          label: 'Claim this session',
        })
      } else {
        // §8.2 — the product double-checks a decline before it writes one, because
        // dropping a class must not be mis-tappable. So the default mints the operation in
        // exactly the shape the product's own path uses (`confirmed: false`), which
        // produces that check and leaves it to be tapped; `--yes` mints the confirmed form
        // and drops the class in one command. They test different things.
        await driveOperation({
          contactId, academyId: coach.academyId, op: 'decline_coach',
          args: {
            session_id: sessionId, coach_id: coach.coachId,
            reason: flag('reason') ?? null, confirmed: has('yes'),
          },
          match: { session_id: sessionId },
          label: "Can't make it",
        })
        if (!has('yes')) {
          console.log(c.dim(`  the product is double-checking — \`drive tap ${contactId} 1\` to go through with it`))
        }
      }
      break
    }

    /**
     * **The register's majority case, in chat.** §8.2 step 5 mints `[All present]` as a chat
     * button carrying the fully resolved roster, precisely so the common case costs one tap
     * and no model call — and `drive register` drives the *page* instead, which is the
     * minority path the spec expects most coaches never to see. So the button the product
     * was designed around has never been pressed, and `CO-REGISTER`'s tap rate reads 0%
     * because nothing could press it rather than because nobody wanted to.
     */
    case 'present': {
      const contactId = positional[0]
      if (!contactId) {
        die(
          c.red('drive present <coachContactId> [--session <id>]   — the [All present] button, tapped'),
          c.dim('  `drive register <coachContactId> --absent "…"` is the page, for anything but everyone present'),
        )
      }
      const coach = await coachContext(contactId)
      let sessionId = flag('session') ?? ''
      if (!sessionId) {
        const s = await q<any>(
          `select s.id, s.starts_at, cl.name from session s
             join class cl on cl.id = s.class_id
             join session_coach sc on sc.session_id = s.id and sc.coach_id = '${coach.coachId}'::uuid
            where s.status <> 'cancelled' and s.ends_at < app.now()
              and not exists (select 1 from attendance a where a.session_id = s.id)
            order by s.ends_at desc limit 1`,
          coach.academyId,
        )
        if (!s[0]) {
          die(
            c.red('that coach has no finished session with an unmarked register — pass --session <id>.'),
            c.dim('  `drive clock --next` steps to the next scheduled moment; a register exists once a class has ended.'),
          )
        }
        sessionId = String(s[0].id)
        console.log(c.dim(`  ${s[0].name} @ ${s[0].starts_at}`))
      }
      // The same args CO-REGISTER's own button carries: the roster resolved at mint time,
      // never `all_present` — so a tap here and a tap on their phone run the same plan.
      const roster = await q<any>(
        `select e.player_id, p.full_name
           from session s
           join enrollment e on e.class_id = s.class_id and e.ended_on is null
           join player pl on pl.id = e.player_id and pl.active
           join person p on p.id = pl.person_id
          where s.id = '${sessionId}'::uuid`,
        coach.academyId,
      )
      if (!roster.length) die(c.red('nobody is enrolled in that class — there is no register to mark.'))
      console.log(c.dim(`  ${roster.length} present: ${roster.map((r: any) => r.full_name).join(', ')}`))
      await driveOperation({
        contactId, academyId: coach.academyId, op: 'mark_attendance',
        args: {
          session_id: sessionId,
          entries: roster.map((r: any) => ({ player_id: String(r.player_id), status: 'present' })),
        },
        match: { session_id: sessionId },
        label: 'All present',
      })
      const marked = await q<any>(
        `select a.status, count(*)::int as n from attendance a where a.session_id = '${sessionId}'::uuid group by 1`,
        coach.academyId,
      )
      console.log(c.dim(`  attendance: ${marked.map((m: any) => `${m.n} ${m.status}`).join(' · ') || 'nothing written'}`))
      break
    }

    /**
     * **Scheduling, without talking anybody into it.** Classes, session moves, cancellations
     * and per-person timing all have operations and none of them had a driver, so a session
     * could only come into existence as a fixture or as a side effect of a conversation.
     * That is why §7.1's "the timetable is the product" half is the least driven part of
     * this: nothing could create a class, so nothing downstream of one was ever reached
     * from a clean business.
     */
    case 'class': {
      const name = flag('name') ?? positional[0]
      const days = (flag('day') ?? flag('days') ?? '').trim()
      const time = (flag('time') ?? '').trim()
      if (!name || !days || !time) {
        die(
          c.red('drive class --name "6:30 Beginners" --day mon,wed --time 18:30-19:30'),
          c.dim('  [--from 2026-08-20]      first day it runs (default: today)'),
          c.dim('  [--rate 2400 --unit per_month|per_session|per_term|per_package]'),
          c.dim('  [--coach <contactId>]    comma-separated; they are assigned to every session it makes'),
        )
      }
      const academyId = await theAcademy(flag('as'))
      const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
      const weekdays = days.split(/[,\s]+/).filter(Boolean).map((d) => {
        const i = DAYS.indexOf(d.slice(0, 3).toLowerCase())
        // `class_slot.weekday` is Postgres dow — 0 is Sunday. A day name that silently
        // became Sunday is F6 ("a Saturday class started on a Sunday") with a driver
        // holding the pen, so an unknown name is refused rather than defaulted.
        if (i === -1) die(c.red(`"${d}" is not a day — one of ${DAYS.join(', ')}`))
        return i
      })
      const span = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(time)
      if (!span) die(c.red(`--time wants HH:MM-HH:MM (got "${time}")`))
      const coachIds: string[] = []
      for (const cid of (flag('coach') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
        coachIds.push((await coachContext(cid)).coachId)
      }
      const startsOn = flag('from') ?? (await todayIn(academyId))
      console.log(
        c.dim(`  ${name} · ${weekdays.map((w) => DAYS[w]).join('/')} ${span[1]}-${span[2]} · from ${startsOn}` +
          (coachIds.length ? ` · ${coachIds.length} coach(es)` : ' · no coach')),
      )
      /**
       * A class is a class row, its weekly slots and its coaches. Nothing else.
       *
       * `create_class` did this and then enqueued the materialiser, which is why
       * the prompt used to say it was "the only thing that schedules the
       * sessions". A slot now implies its sessions by trigger (0033), so this is
       * every row a class is made of and the sessions follow from the world.
       */
      {
        const cls = `(select id from class where name = ${sql(name)} and academy_id = app.academy_id() and active and ends_on is null)`
        const rate = flag('rate') ? Number(flag('rate')) : null
        const unit = flag('unit') ?? null
        await drivePlan({
          contactId: (await adminContactOf(academyId)).contactId,
          academyId,
          summary: `create ${name}`,
          label: `Create ${name}`,
          steps: [
            {
              write:
                `insert into class (academy_id, name, starts_on${rate !== null ? ', rate_amount' : ''}${unit ? ', rate_unit' : ''})` +
                ` values (app.academy_id(), ${sql(name)}, date ${sql(startsOn)}` +
                `${rate !== null ? `, ${rate}` : ''}${unit ? `, ${sql(unit)}` : ''})`,
            },
            ...weekdays.map((w) => ({
              write:
                `insert into class_slot (academy_id, class_id, weekday, start_time, end_time)` +
                ` values (app.academy_id(), ${cls}, ${w}, time ${sql(`${span[1]}:00`)}, time ${sql(`${span[2]}:00`)})`,
            })),
            ...coachIds.map((id) => ({
              write:
                `insert into class_coach (academy_id, class_id, coach_id)` +
                ` values (app.academy_id(), ${cls}, ${sql(id)}::uuid)`,
            })),
            { note: `${name}, ${weekdays.length} time(s) a week` },
          ],
        })
      }
      const made = await q<any>(
        `select cl.name, count(s.id)::int as sessions, min(s.starts_at) as first
           from class cl left join session s on s.class_id = cl.id and s.status = 'scheduled'
          where cl.academy_id = '${academyId}'::uuid and lower(cl.name) = lower(${sql(name)})
          group by cl.name`,
        academyId,
      )
      console.log(
        made[0]
          ? c.dim(`  class row: ${made[0].name} · ${made[0].sessions} scheduled session(s) · first ${made[0].first ?? '·'}`)
          : c.red('  no class by that name exists — the plan did not write one'),
      )
      // A class has no sessions the moment it is written: `create_class` schedules
      // `materialize_sessions` and that job fills the horizon. Saying zero and stopping
      // reads as a class that does not run, so the job is named instead.
      if (made[0] && Number(made[0].sessions) === 0) {
        const pending = await q<any>(
          `select run_at, status from job
            where kind = 'materialize_sessions' and payload->>'academy_id' = '${academyId}'
              and status = 'pending' order by run_at limit 1`,
          academyId,
        )
        console.log(
          pending[0]
            ? c.yellow(`  no sessions yet — materialize_sessions is due ${new Date(pending[0].run_at).toISOString()}; \`drive tick\` runs it`)
            : c.red('  no sessions and no materialize_sessions job — nothing will ever put one on the calendar'),
        )
      }
      break
    }

    case 'cancel': {
      const academyId = await theAcademy(positional[0])
      let sessionId = flag('session') ?? ''
      if (!sessionId) {
        const wanted = flag('class')
        const where = wanted ? `and cl.id = '${(await classFor(academyId, wanted)).id}'::uuid` : ''
        const s = await q<any>(
          `select s.id, s.starts_at, cl.name from session s join class cl on cl.id = s.class_id
            where s.status = 'scheduled' and s.starts_at > app.now() ${where}
            order by s.starts_at limit 1`,
          academyId,
        )
        if (!s[0]) {
          die(
            c.red('no upcoming scheduled session to cancel — pass --session <id>.'),
            c.dim('  `drive world` lists the classes and how many sessions each has ahead of it.'),
          )
        }
        sessionId = String(s[0].id)
        console.log(c.dim(`  ${s[0].name} @ ${s[0].starts_at}`))
      }
      await driveOperation({
        contactId: (await adminContactOf(academyId)).contactId,
        academyId, op: 'cancel_session',
        args: { session_id: sessionId, reason: flag('reason') ?? 'cancelled from the driver', notify: !has('quiet') },
        match: { session_id: sessionId },
        label: 'Cancel this session',
      })
      const after = await q<any>(
        `select s.status, (select count(*) from job j
                            where j.dedupe_key like '%' || '${sessionId}' || '%' and j.status = 'pending') as pending_jobs
           from session s where s.id = '${sessionId}'::uuid`,
        academyId,
      )
      console.log(c.dim(`  session row: status ${after[0]?.status} · ${after[0]?.pending_jobs} pending job(s) still keyed to it`))
      break
    }

    /**
     * Moving a class and moving one session are two different acts with two different
     * blast radii — a slot change rewrites every session after a date, a reschedule moves
     * one and is the makeup. Which one you meant is `--session`, and there is no default.
     */
    case 'move': {
      const sessionId = flag('session')
      const to = flag('to')
      if (sessionId) {
        if (!to) die(c.red('drive move --session <id> --to "2026-08-20T18:30:00+05:30" [--quiet]'))
        const academyId = await theAcademy(positional[0])
        if (Number.isNaN(new Date(to).getTime())) die(c.red(`--to is not a time I can read: "${to}"`))
        const before = await q<any>(
          `select s.starts_at, cl.name from session s join class cl on cl.id = s.class_id where s.id = '${sessionId}'::uuid`,
          academyId,
        )
        if (!before[0]) die(c.red(`no session ${sessionId} in that business.`))
        console.log(c.dim(`  ${before[0].name} · ${before[0].starts_at} → ${new Date(to).toISOString()}`))
        await driveOperation({
          contactId: (await adminContactOf(academyId)).contactId,
          academyId, op: 'reschedule_session',
          args: { session_id: sessionId, new_starts_at: new Date(to).toISOString(), notify: !has('quiet') },
          match: { session_id: sessionId },
          label: 'Move this session',
        })
        const after = await q<any>(`select starts_at, ends_at from session where id = '${sessionId}'::uuid`, academyId)
        console.log(c.dim(`  session row: ${after[0]?.starts_at} → ${after[0]?.ends_at}`))
        break
      }
      const academyId = await theAcademy(positional[0])
      const cls = await classFor(academyId, flag('class'))
      const day = flag('day')
      const time = flag('time')
      if (!day && !time) die(c.red('drive move --class "X" [--day tue] [--time 19:00-20:00] [--from 2026-09-01]  |  --session <id> --to <iso>'))
      const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
      let weekday: number | null = null
      if (day) {
        weekday = DAYS.indexOf(day.slice(0, 3).toLowerCase())
        if (weekday === -1) die(c.red(`"${day}" is not a day — one of ${DAYS.join(', ')}`))
      }
      let span: RegExpExecArray | null = null
      if (time) {
        span = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(time.trim())
        if (!span) die(c.red(`--time wants HH:MM-HH:MM (got "${time}")`))
      }
      console.log(c.dim(`  ${cls.name} → ${day ? DAYS[weekday as number] : 'same day'} ${time ?? 'same time'} from ${flag('from') ?? 'today'}`))
      await driveOperation({
        contactId: (await adminContactOf(academyId)).contactId,
        academyId, op: 'move_class',
        args: {
          class_id: cls.id,
          new_weekday: weekday,
          new_start_time: span ? `${span[1]}:00` : null,
          new_end_time: span ? `${span[2]}:00` : null,
          from_date: flag('from') ?? null,
          notify: !has('quiet'),
        },
        match: { class_id: cls.id },
        label: `Move ${cls.name}`,
      })
      const slots = await q<any>(
        `select weekday, start_time::text as start_time, end_time::text as end_time
           from class_slot where class_id = '${cls.id}'::uuid order by weekday`,
        academyId,
      )
      for (const s of slots) console.log(c.dim(`  class_slot: ${DAYS[Number(s.weekday)]} ${s.start_time}-${s.end_time}`))
      break
    }

    /**
     * §8.2 — "the timings are defaults, not constants." Every ladder in the product hangs
     * off them and there was no way to change one, so the per-person override has never
     * been exercised and neither has the precedence between person, academy and default.
     */
    case 'timing': {
      const contactId = positional[0]
      const key = flag('key')
      const value = flag('value')
      const KEYS = [
        'coach_coming_lead_minutes', 'coach_nudge_lead_minutes', 'admin_escalate_lead_minutes',
        'client_reminder_lead_hours', 'register_expiry_hours',
      ]
      if (!contactId || !key || value === undefined) {
        die(
          c.red('drive timing <contactId> --key <name> --value 90 [--reason "…"]'),
          c.dim(`  keys: ${KEYS.join(', ')}`),
          c.dim('  --value none clears the override and puts them back on the academy default'),
        )
      }
      if (!KEYS.includes(key)) die(c.red(`no timing called "${key}" — one of ${KEYS.join(', ')}`))
      const academyId = await academyOfContact(contactId)
      const parsed = /^(none|null)$/i.test(value) ? null : Number(value)
      if (parsed !== null && !Number.isFinite(parsed)) die(c.red(`--value wants a number or "none" (got "${value}")`))
      /**
       * A per-person timing override is one jsonb key on `person.settings`, and
       * that is all `set_timing` ever was. Its other half — the two mute keys —
       * became `comm_preference` rows in 0032, because a mute the standing jobs
       * cannot read is a promise nothing keeps.
       */
      await drivePlan({
        contactId, academyId,
        summary: `${key} = ${parsed ?? 'default'} for this person`,
        label: `${key} = ${parsed ?? 'default'}`,
        steps: [
          {
            write:
              parsed === null
                ? `update person set settings = settings - ${sql(key)}` +
                  ` where id = (select person_id from contact where id = ${sql(contactId)}::uuid)`
                : `update person set settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object(${sql(key)}, ${parsed})` +
                  ` where id = (select person_id from contact where id = ${sql(contactId)}::uuid)`,
            requireRows: 1,
          },
          { note: `${key} is ${parsed ?? 'back on the business default'} for them` },
        ],
      })
      const back = await q<any>(
        `select p.settings from contact c join person p on p.id = c.person_id where c.id = '${contactId}'::uuid`,
        academyId,
      )
      console.log(c.dim(`  person.settings: ${JSON.stringify(back[0]?.settings ?? {})}`))
      break
    }

    /**
     * **Rail 1, end to end.** §6.4's money path has no webhook: a request goes out, a human
     * pays out of band, somebody attests, and an admin confirms. Nothing here could drive
     * any of those three moments, so `payment` rows only ever existed because a seed wrote
     * them — the transitions between them had never run.
     */
    case 'pay': {
      const sub = (positional[0] ?? '').toLowerCase()
      const who = positional[1]
      if (!['request', 'attest', 'confirm'].includes(sub)) {
        die(
          c.red('drive pay request|attest|confirm ...'),
          c.dim('  pay request <holderContactId> [--amount 2400] [--note "..."]   ask an account for what is owed'),
          c.dim('  pay attest  <holderContactId> [--amount] [--ref UPI/..] [--media shot.png]  they say they paid'),
          c.dim('  pay confirm [adminContactId] [--payment <id>] [--account "Meera"]  the admin says it came in'),
        )
      }

      if (sub === 'attest') {
        // Deliberately a message and not an operation: Rail 1's attestation IS the family
        // saying so, and everything interesting about it — reading a screenshot, matching
        // an amount to an account, deciding whether to believe it — happens on the model
        // path. Minting an operation here would skip the only part worth testing.
        if (!who) die(c.red('drive pay attest <holderContactId> [--amount] [--ref UPI/…] [--media shot.png]'))
        const academyId = await academyOfContact(who)
        const account = await accountFor(academyId, who)
        const amount = flag('amount')
        const ref = flag('ref')
        const media = flag('media')
        const attached = media ? await attach(media) : null
        const text =
          positional.slice(2).join(' ') ||
          `I've paid${amount ? ` ${money(amount)}` : ''}${ref ? `, reference ${ref}` : ''}.`
        const at = await cursorNow()
        console.log(c.dim(`  ${account.name}`))
        console.log(`${c.dim('  →')} ${text}${attached ? c.dim(`  [${attached.mimeType}, ${attached.bytes} bytes]`) : ''}`)
        await api('/api/emulator/inbound', {
          contactId: who,
          text,
          ...(attached ? { mediaUrl: attached.dataUri, mediaMimeType: attached.mimeType } : {}),
        })
        await showTurn(who, at, { full: has('full') })
        break
      }

      if (sub === 'request') {
        if (!who && !flag('account')) die(c.red('drive pay request <holderContactId> | --account "<name>" [--amount N]'))
        const academyId = await theAcademy(who)
        const account = await accountFor(academyId, who)
        const asker = flag('as') ?? (await adminContactOf(academyId)).contactId
        const amount = flag('amount')
        console.log(c.dim(`  ${account.name}${amount ? ` · ${money(amount)}` : ' · whatever is outstanding'}`))
        /**
         * A request is a `payment` row at status 'requested', and a check-back so
         * it does not sit there forever. `request_payment` was those two steps
         * plus the sentence to the family — which the model composes, because
         * what to say about money is a judgement and a wrapper's constant was
         * never going to make it.
         */
        {
          const owed = amount
            ? String(Number(amount))
            : `greatest(0, app.account_balance(${sql(account.id)}::uuid, null))`
          await drivePlan({
            contactId: asker, academyId,
            summary: `ask ${account.name} for ${amount ? money(amount) : "what's outstanding"}`,
            label: `Ask ${account.name} for what's owed`,
            steps: [
              {
                write:
                  `insert into payment (academy_id, account_id, amount, rail, status, requested_at)` +
                  ` select app.academy_id(), ${sql(account.id)}::uuid, ${owed}, a.rail, 'requested', app.now()` +
                  ` from academy a where a.id = app.academy_id() and ${owed} > 0`,
                requireRows: 1,
              },
              { note: `asked ${account.name} for ${amount ? money(amount) : 'the outstanding balance'}` },
            ],
          })
        }
        break
      }

      // confirm — the AD-RECONCILE tap, or the same operation posted directly.
      const academyId = await theAcademy(who)
      const admin = who ?? (await adminContactOf(academyId)).contactId
      let paymentId = flag('payment') ?? ''
      if (!paymentId) {
        const filter = flag('account') ? `and lower(ac.display_name) like lower(${sql(`%${flag('account')}%`)})` : ''
        const rows = await q<any>(
          `select p.id, p.amount, ac.display_name
             from payment p join account ac on ac.id = p.account_id
            where p.status = 'requested' ${filter}
            order by p.requested_at desc limit 1`,
          academyId,
        )
        if (!rows[0]) {
          die(
            c.red('no payment is waiting to be confirmed in that business.'),
            c.dim('  `drive pay request <holderContactId>` makes one; `drive money` shows what is outstanding.'),
          )
        }
        paymentId = String(rows[0].id)
        console.log(c.dim(`  ${rows[0].display_name} · ${money(rows[0].amount)}`))
      }
      /**
       * By ID and never by amount — the reason `confirm_payment` was a distinct
       * operation at all was that amount-matching double-credited. The statement
       * says the same thing more plainly, and `requireRows: 1` is the
       * precondition: a payment somebody else confirmed since this was listed
       * aborts rather than reporting success over a row it did not change.
       */
      await drivePlan({
        contactId: admin, academyId,
        summary: `confirm the payment ${paymentId}`,
        label: 'Yes, received',
        steps: [
          {
            write:
              `update payment set status = 'confirmed', confirmed_at = app.now(), confirmed_by = app.person_id()` +
              (flag('ref') ? `, reference = ${sql(flag('ref') as string)}` : '') +
              ` where id = ${sql(paymentId)}::uuid and status = 'requested'`,
            requireRows: 1,
          },
          { note: 'the payment they asked for has been confirmed' },
        ],
      })
      break
    }

    /**
     * **Every ending, from the command line.** §8.3 calls churn a routine operation and the
     * product agrees — `end_coach`, `client_cancel`, `opt_out` all exist — but nothing here
     * could reach any of them, so the only way to end anything was to talk the model into
     * it. That measures the model's persuadability, not the product: not one coach in any
     * driven world has ever had an `ended_on`, so §8.3's uncovered-session cascade, the
     * final statement and the parents-hear-only-if-it-changed rule have never run.
     *
     * A family leaving is deliberately the odd one out. There is no operation for it — §14.2.1
     * shows it as a model-composed transaction — so this drives it as one, and says so.
     */
    case 'end': {
      const sub = (positional[0] ?? '').toLowerCase()
      const who = positional[1]
      if (!['coach', 'player', 'contact'].includes(sub)) {
        die(
          c.red('drive end coach|player|contact ...'),
          c.dim('  end coach   <coachContactId>  [--on 2026-09-30] [--reassign <coachContactId>] [--notify]'),
          c.dim('  end player  <holderContactId> [--player "Aarav"] [--all] [--on 2026-08-31]'),
          c.dim('  end contact <contactId>       [--yes]     stop messaging that number (§11.4)'),
        )
      }
      if (!who) die(c.red(`drive end ${sub} <contactId>`))

      if (sub === 'coach') {
        const coach = await coachContext(who)
        const endDate = flag('on') ?? (await todayIn(coach.academyId))
        let reassign: string | null = null
        if (flag('reassign')) {
          const to = await coachContext(String(flag('reassign')))
          if (to.academyId !== coach.academyId) die(c.red('that replacement coaches at a different business.'))
          reassign = to.coachId
          console.log(c.dim(`  their sessions go to ${to.name}`))
        }
        const left = await q<any>(
          `select count(*)::int as n from session s
             join session_coach sc on sc.session_id = s.id and sc.coach_id = '${coach.coachId}'::uuid
            where s.status = 'scheduled' and s.starts_at > ('${endDate}'::date + interval '1 day')`,
          coach.academyId,
        )
        console.log(c.dim(`  ${coach.name} · last day ${endDate} · ${left[0]?.n ?? 0} session(s) assigned past it`))
        await driveOperation({
          contactId: (await adminContactOf(coach.academyId)).contactId,
          academyId: coach.academyId,
          op: 'end_coach',
          args: {
            coach_id: coach.coachId,
            end_date: endDate,
            reassign_to_coach_id: reassign,
            notify_parents: has('notify'),
          },
          match: { coach_id: coach.coachId },
          label: `${coach.name} leaves on ${endDate}`,
        })
        // §8.3 step 4: what is left becomes uncovered, which is a state the product already
        // understands. Reading it back is the only way to know the cascade actually ran.
        const after = await q<any>(
          `select co.status, co.ended_on::text as ended_on,
                  (select count(*) from session s
                     join session_coach sc on sc.session_id = s.id and sc.coach_id = co.id
                    where s.status = 'scheduled' and s.starts_at > app.now() and sc.declined_at is null) as still_on
             from coach co where co.id = '${coach.coachId}'::uuid`,
          coach.academyId,
        )
        console.log(
          c.dim(`  coach row: status ${after[0]?.status} · ended_on ${after[0]?.ended_on ?? '·'} · ${after[0]?.still_on} upcoming session(s) still theirs`),
        )
        break
      }

      if (sub === 'contact') {
        const academyId = await academyOfContact(who)
        await driveOperation({
          contactId: who, academyId, op: 'opt_out',
          args: { contact_id: who, confirmed: has('yes') },
          match: { contact_id: who },
          label: 'Stop messaging me',
        })
        if (!has('yes')) {
          console.log(c.dim(`  the product is double-checking — \`drive tap ${who} 1\` to go through with it`))
        }
        const state = await q<any>(`select state, opted_out_at from contact where id = '${who}'::uuid`, academyId)
        console.log(c.dim(`  contact row: state ${state[0]?.state} · opted_out_at ${state[0]?.opted_out_at ?? '·'}`))
        break
      }

      // player — a family leaving. The one ending with no operation behind it.
      const academyId = await academyOfContact(who)
      const wanted = flag('player')
      const roster = await playersOf(academyId, who)
      if (!roster.length) die(c.red('that contact holds no account, so no player of theirs can leave.'))
      const leaving = has('all')
        ? roster
        : wanted
          ? roster.filter((r: any) => String(r.full_name).toLowerCase().includes(wanted.toLowerCase()))
          : roster
      if (!leaving.length) die(c.red(`nobody on that account matches "${wanted}".`))
      // A player in two classes is two rows here and one child. Counting rows asked
      // "which of these two Iras do you mean", which is R5 with a family in it.
      const distinct = new Set(leaving.map((r: any) => String(r.player_id)))
      if (distinct.size > 1 && !has('all')) {
        die(
          c.red(`that account has ${distinct.size} players — name one with --player, or --all for the family:`),
          ...[...distinct].map((id) => {
            const rows = leaving.filter((r: any) => String(r.player_id) === id)
            return c.dim(`    ${rows[0].full_name}  ${rows.map((r: any) => r.class_name ?? 'not enrolled').join(', ')}`)
          }),
        )
      }
      const open = leaving.filter((r: any) => r.enrollment_id)
      if (!open.length) {
        die(
          c.red('none of them has an open enrollment — there is nothing to end.'),
          ...leaving.map((r: any) => c.dim(`    ${r.full_name}: ${r.class_name ?? 'not enrolled in anything'}`)),
        )
      }
      const endDate = flag('on') ?? (await todayIn(academyId))
      for (const r of open) {
        console.log(
          c.dim(`  ${r.full_name} leaves ${r.class_name} on ${endDate}${r.ended_on ? ` (was ${r.ended_on})` : ''}`),
        )
      }
      await drivePlan({
        contactId: (await adminContactOf(academyId)).contactId,
        academyId,
        steps: open.map((r: any) => ({
          write:
            `update enrollment set ended_on = '${endDate}'::date ` +
            `where id = '${r.enrollment_id}'::uuid and academy_id = '${academyId}'::uuid`,
        })),
        summary: `${open.map((r: any) => r.full_name).join(', ')} leaving on ${endDate}`,
        label: `${open.length} enrollment(s) ended`,
      })
      const back = await q<any>(
        `select p.full_name, e.ended_on::text as ended_on, cl.name
           from enrollment e join player pl on pl.id = e.player_id
           join person p on p.id = pl.person_id join class cl on cl.id = e.class_id
          where e.id in (${open.map((r: any) => `'${r.enrollment_id}'::uuid`).join(',')})`,
        academyId,
      )
      for (const r of back) console.log(c.dim(`  enrollment row: ${r.full_name} · ${r.name} · ended_on ${r.ended_on ?? '·'}`))
      break
    }

    /**
     * **A waiver, a credit, a pro-rate — the ending that is only about money.**
     *
     * `waive` is the product's one adjustment primitive (§6.4) and had no driver, so the
     * whole "somebody is owed less than the tally says" half of month-end has never run.
     */
    case 'waive': {
      const who = positional[0]
      const amount = Number(flag('amount') ?? NaN)
      const reason = flag('reason')
      if (!who || !Number.isFinite(amount) || !reason) {
        die(
          c.red('drive waive <holderContactId> --amount 1200 --reason "missed the whole month" [--period 2026-08] [--player "Aarav"]'),
          c.dim('  a positive amount is a credit — the operation signs it; --amount 1200 takes 1200 off what they owe'),
        )
      }
      const academyId = await academyOfContact(who)
      const account = await accountFor(academyId, who)
      const period = await periodFor(academyId)
      let playerId: string | null = null
      if (flag('player')) {
        const roster = await playersOf(academyId, who)
        const hit = roster.filter((r: any) =>
          String(r.full_name).toLowerCase().includes(String(flag('player')).toLowerCase()),
        )
        if (hit.length !== 1) {
          die(
            c.red(`"${flag('player')}" matches ${hit.length} players on that account:`),
            ...roster.map((r: any) => c.dim(`    ${r.full_name}`)),
          )
        }
        playerId = String(hit[0].player_id)
      }
      console.log(c.dim(`  ${account.name} · ${money(amount)} off ${period} · ${reason}`))
      /**
       * `adjust` is a first-class plan step, and `waive` was a one-step wrapper
       * around it that also filled in `approved_by`. The step still does that —
       * `runSteps` stamps the acting person — so the wrapper was carrying nothing
       * of its own. A waiver, a credit, a pro-rate and a goodwill gesture are one
       * primitive, which is the whole point of there being no waive table.
       */
      await drivePlan({
        contactId: (await adminContactOf(academyId)).contactId,
        academyId,
        summary: `credit ${money(amount)} to ${account.name}`,
        label: `Waive ${money(amount)}`,
        steps: [
          {
            adjust: {
              account_id: account.id,
              player_id: playerId,
              // A waiver is a CREDIT, so the sign is set here rather than left to
              // whoever typed the number: `drive waive --amount 1200` means 1,200
              // off, and an adjustment that added 1,200 would be the opposite act.
              amount: -Math.abs(amount),
              reason,
              period,
            },
          },
          { note: `${money(amount)} credited to ${account.name} for ${period}` },
        ],
      })
      const lines = await q<any>(
        `select kind, description, amount, period::text as period from tally_line
          where account_id = '${account.id}'::uuid and period = '${period}'::date
          order by created_at desc limit 5`,
        academyId,
      )
      for (const l of lines) console.log(c.dim(`  tally_line: ${l.period} ${l.kind.padEnd(10)} ${money(l.amount).padStart(9)}  ${clip(l.description, 50)}`))
      break
    }

    /**
     * **Take a register without hand-authoring its JSON.**
     *
     * `submit --json` needs the session id, every player id and a status each, which
     * means reading three tables by hand before you can mark one class present. So
     * nobody ever did: `attendance` has zero rows in every world driven so far, and
     * everything downstream of it — `client_outcome`, per-session tally lines, the
     * month-end tally, dunning — has therefore never run either. Eight of twenty job
     * kinds have never been enqueued once, and most of them are behind this command.
     *
     * The roster comes from the session, so the only thing you have to know is who was
     * missing. Defaults to everyone present, which is §8.2's majority case and the
     * reason `[All present]` is a chat button rather than a page.
     */
    case 'register': {
      const contactId = positional[0]
      if (!contactId) {
        die(
          c.red('drive register <coachContactId> [--session <id>] [--absent "Aarav,Meera"] [--late "Kiran"]'),
          c.dim('  everyone not named is marked present'),
        )
      }
      const academyId = await academyOfContact(contactId)

      let sessionId = flag('session') ?? ''
      if (!sessionId) {
        const s = await q<any>(
          `select s.id, s.starts_at, c.name from session s join class c on c.id = s.class_id
            where s.status = 'scheduled' and s.ends_at < app.now()
              and not exists (select 1 from attendance a where a.session_id = s.id)
            order by s.ends_at desc limit 1`,
          academyId,
        )
        if (!s[0]) die(c.red('no finished session with an unmarked register — pass --session <id>'))
        sessionId = String(s[0].id)
        console.log(c.dim(`  ${s[0].name} @ ${s[0].starts_at}`))
      }

      const roster = await q<any>(
        `select pl.id as player_id, p.full_name
           from enrollment e
           join player pl on pl.id = e.player_id
           join person p on p.id = pl.person_id
           join session s on s.class_id = e.class_id
          where s.id = '${sessionId}'::uuid and e.ended_on is null and pl.active`,
        academyId,
      )
      if (!roster.length) die(c.red('nobody is enrolled in that class — the register would be empty.'))

      const names = (f: string) =>
        (flag(f) ?? '')
          .split(',')
          .map((n) => n.trim().toLowerCase())
          .filter(Boolean)
      const absent = names('absent')
      const late = names('late')
      const hit = (full: string, list: string[]) =>
        list.some((n) => full.toLowerCase().includes(n))

      const marks = roster.map((r: any) => ({
        playerId: String(r.player_id),
        status: hit(String(r.full_name), absent)
          ? 'absent'
          : hit(String(r.full_name), late)
            ? 'late'
            : 'present',
        ...(has('timely') && hit(String(r.full_name), absent) ? { timely: true } : {}),
      }))
      for (const [i, m] of marks.entries()) {
        console.log(c.dim(`  ${String(roster[i].full_name).padEnd(24)} ${m.status}`))
      }

      /**
       * Said in the chat, down the road a real coach's answer travels.
       *
       * This used to POST a completed Flow: find the register form the bot had sent,
       * take its live `flow_token`, and submit the ticked boxes as the literal
       * `nfm_reply.response_json`. Forms are gone (§14.6) and so is that path.
       *
       * What replaces it is the sentence a coach would actually type. That is a
       * stronger test rather than a weaker one: the Flow submission executed with no
       * model in the loop, so it proved the write path and nothing about whether the
       * product can UNDERSTAND "everyone except Aarav". This exercises the resolution
       * — names against the roster, absent versus late — which is now the only way a
       * register gets marked and therefore the only thing worth driving.
       *
       * It deliberately does not check that CO-REGISTER was sent first. A coach can
       * say this unprompted, and §8.2 says "I'm here" has to work with no prompt.
       */
      const absentNames = roster.filter((r: any, i: number) => marks[i].status === 'absent').map((r: any) => String(r.full_name))
      const lateNames = roster.filter((r: any, i: number) => marks[i].status === 'late').map((r: any) => String(r.full_name))
      const said = absentNames.length === 0 && lateNames.length === 0
        ? 'Take the register for that session — everyone was here.'
        : [
            'Take the register for that session.',
            absentNames.length ? `${absentNames.join(' and ')} ${absentNames.length > 1 ? 'were' : 'was'} not there.` : '',
            lateNames.length ? `${lateNames.join(' and ')} ${lateNames.length > 1 ? 'were' : 'was'} late.` : '',
            flag('note') ? String(flag('note')) : '',
          ].filter(Boolean).join(' ')

      console.log(c.dim(`  saying: ${said}`))
      const at = await cursorNow()
      await api('/api/emulator/inbound', { contactId, text: said })
      await showTurn(contactId, at, {})
      break
    }

    /**
     * **Close a month, and say what is missing.**
     *
     * Month-end could only be provoked by shoving the global clock past a job's `run_at`
     * and hoping the right things fired — which is the trap DRIVING.md names: every job
     * whose precondition has passed declines politely, the transcript reads calm, and all
     * you have proved is that declining works. So the whole of §6.4's rollover — the lines
     * written on the 1st, CL-TALLY reading the month back, the dunning ladder after it —
     * has never been watched on purpose.
     *
     * This moves no time at all. It runs the planner and everything already due, down the
     * same road `tick` takes, and then asks the tables what the period actually holds. The
     * planner is a **catch-up** rather than a schedule (see `planMonthBoundary`), so a
     * period whose 1st has passed is billable now, and one whose read-back is still in the
     * future is refused loudly rather than reported as a quiet zero.
     */
    case 'month': {
      const academyId = await theAcademy(positional[0])
      const period = await periodFor(academyId)
      const a = (await q<any>(
        `select name, onboarding_state, timezone from academy where id = '${academyId}'::uuid`,
        academyId,
      ))[0]
      console.log(`\n${c.bold(String(a?.name))} ${c.dim(`· period ${period.slice(0, 7)} · onboarding: ${a?.onboarding_state}`)}`)
      if (a?.onboarding_state !== 'live') {
        // Both money handlers open with `if (academy.onboarding_state !== 'live') skip(…)`,
        // so on a business still being set up this command would report an empty month and
        // be telling the truth about the wrong thing.
        console.log(c.yellow('  this business is not live — month_end_tally and dunning skip it by design (§6.4)'))
      }

      const ran = await api('/api/emulator/tick', {})
      const moneyKinds = /monthly|tally|dunning|reconcile/i
      const log = (ran.jobs?.log ?? []).filter((l: unknown) => moneyKinds.test(String(typeof l === 'string' ? l : JSON.stringify(l))))
      console.log(
        c.dim(`  planned ${ran.planned} · ran ${ran.jobs?.ran ?? 0} · skipped ${ran.jobs?.skipped ?? 0} · failed ${ran.jobs?.failed ?? 0}`),
      )
      for (const l of log) console.log(c.dim(`    ${clip(typeof l === 'string' ? l : JSON.stringify(l), 160)}`))

      const lines = await q<any>(
        `select tl.kind, count(*)::int as n, sum(tl.amount) as total
           from tally_line tl where tl.period = '${period}'::date
          group by tl.kind order by tl.kind`,
        academyId,
      )
      console.log(`\n${c.bold('billed')}`)
      if (!lines.length) console.log(c.yellow(`  nothing is billed for ${period.slice(0, 7)}`))
      for (const l of lines) console.log(`  ${String(l.kind).padEnd(10)} ${String(l.n).padStart(3)} line(s)  ${money(l.total).padStart(10)}`)

      // The same question `planMonthBoundary` asks: who should carry a recurring line for
      // this period and does not. A silent nothing here is R7 wearing month-end's clothes.
      const missing = await q<any>(
        `select p.full_name, cl.name as class_name, coalesce(e.rate_unit, cl.rate_unit) as unit
           from enrollment e
           join class cl on cl.id = e.class_id and cl.active
           join player pl on pl.id = e.player_id and pl.active
           join person p on p.id = pl.person_id
          where coalesce(e.rate_unit, cl.rate_unit) in ('per_month','per_term','per_package')
            and e.started_on <= ('${period}'::date + interval '1 month' - interval '1 day')
            and (e.ended_on is null or e.ended_on >= '${period}'::date)
            and not exists (select 1 from tally_line tl
                             where tl.player_id = e.player_id and tl.period = '${period}'::date
                               and tl.kind in ('monthly','term','package'))
          order by p.full_name`,
        academyId,
      )
      for (const m of missing) console.log(c.red(`  no line for ${m.full_name} · ${m.class_name} · ${m.unit}`))

      const jobs = await q<any>(
        `select kind, status, run_at, dedupe_key, last_error from job
          where payload->>'academy_id' = '${academyId}'
            and kind in ('monthly_lines','month_end_tally','dunning')
            and dedupe_key like '%${period}%'
          order by run_at`,
        academyId,
      )
      console.log(`\n${c.bold('jobs for that period')}`)
      if (!jobs.length) console.log(c.yellow('  none — the planner found nothing to bill for it'))
      for (const j of jobs) {
        const line = `  ${String(j.kind).padEnd(16)} ${String(j.status).padEnd(9)} ${new Date(j.run_at).toISOString()}  ${clip(j.dedupe_key, 46)}`
        console.log(j.status === 'failed' ? c.red(line) : j.status === 'done' ? c.dim(line) : line)
        if (j.last_error) console.log(c.red(`      ${clip(j.last_error, 160)}`))
      }

      const said = await q<any>(
        `select m.catalog_id, p.full_name, m.status, m.body
           from message m join contact ct on ct.id = m.contact_id join person p on p.id = ct.person_id
          where m.catalog_id in ('CL-TALLY','CL-DUNNING','AD-RECONCILE')
          order by m.created_at desc limit 8`,
        academyId,
      )
      console.log(`\n${c.bold('what anybody was actually told')}`)
      if (!said.length) console.log(c.yellow('  nobody has been sent a tally, a reminder or a reconcile prompt'))
      for (const s of said) {
        console.log(`  ${c.dim(String(s.catalog_id).padEnd(13))} ${String(s.full_name).padEnd(20)} ${c.dim(String(s.status))}  ${clip(s.body, 90)}`)
      }
      console.log()

      // The one thing this command cannot do, said out loud. The clock is global and shared,
      // so guessing on the driver's behalf would move somebody else's world.
      const nowMs = new Date(String(ran.nowIso)).getTime()
      const waiting = jobs.filter((j: any) => j.status === 'pending' && new Date(j.run_at).getTime() > nowMs)
      if (waiting.length) {
        die(
          c.red(`${period.slice(0, 7)} is not closed — ${waiting.length} of its jobs are not due yet.`),
          ...waiting.slice(0, 6).map((j: any) => c.dim(`    ${j.kind} at ${new Date(j.run_at).toISOString()}`)),
          c.dim('  the clock is one global singleton shared with everything else running; this command will not move it.'),
          c.dim('  `drive month --period <an earlier month>` closes one whose read-back date has passed.'),
        )
      }
      if (!lines.length && !jobs.length) {
        die(
          c.red(`nothing bills for ${period.slice(0, 7)} in that business — there is no month to close.`),
          c.dim('  a period only bills if somebody is enrolled in it on a per_month, per_term or per_package rate.'),
        )
      }
      break
    }

    /**
     * **The delivery ladder, which nothing advanced.**
     *
     * The emulator transport accepts a message, returns a wire id and stops, so every
     * message any drive run has ever produced sat at `status='sent'` for ever. Everything
     * downstream of delivery is therefore untested by construction: §16.3's quality proxies
     * (delivery failures, read rate), §9.1's "10, check delivery, read and block signals,
     * then the rest in batches", and any reply path that waits on blue ticks.
     *
     * One rung per call, per message, because `delivered` has to be a state a driver can
     * see rather than a value that flashes past on the way to `read`.
     */
    case 'deliver': {
      const mode = has('read') ? 'read' : 'delivered'
      const out = await api('/api/emulator/delivery', {
        mode,
        ...(flag('limit') ? { limit: Number(flag('limit')) } : {}),
      })
      console.log(c.green(`${out.delivered} sent → delivered · ${out.read} delivered → read`))
      // Said plainly because it is true and surprising: the endpoint takes no academy and
      // walks every business in the world.
      console.log(c.dim('  (the ladder advances world-wide — the endpoint is not scoped to one business)'))
      for (const business of await academiesInScope(positional[0])) {
        const rows = await q<any>(
          `select status, count(*)::int as n from message
            where direction = 'outbound' and suppressed_reason is null
            group by status order by count(*) desc`,
          business.id,
        )
        console.log(
          `  ${clip(business.name, 24).padEnd(26)} ${rows.map((r: any) => `${r.n} ${r.status}`).join(' · ') || 'nothing sent'}`,
        )
      }
      break
    }

    /**
     * **Failure injection, from the command line.** §17 names five ways the world breaks
     * and the table behind them has been writable by nothing but a browser, so no failure
     * path in this product has ever been reached from a driven run. `send_fail` is the one
     * that matters most: the send ladder's whole reason to exist is that a message can fail
     * after it is queued, and it has only ever been watched succeeding.
     */
    case 'fault': {
      const KINDS = ['send_fail', 'number_blocked', 'media_timeout', 'link_expired', 'model_error']
      const kind = positional[0]
      const state = (positional[1] ?? '').toLowerCase()
      if (!kind) {
        const now = await api<any>('/api/emulator/fault')
        console.log(c.bold('\nfaults'))
        if (!now.faults?.length) console.log(c.dim('  none set — the world is behaving'))
        for (const f of now.faults ?? []) {
          console.log(`  ${String(f.kind).padEnd(16)} ${f.active ? c.red('on') : c.dim('off')}  rate ${f.rate}`)
        }
        console.log(c.dim(`\n  drive fault <${KINDS.join('|')}> on|off [--rate 0.5]\n`))
        break
      }
      if (!KINDS.includes(kind)) die(c.red(`no fault called "${kind}" — one of ${KINDS.join(', ')}`))
      if (!['on', 'off'].includes(state)) die(c.red(`say on or off: \`drive fault ${kind} on [--rate 0.5]\``))
      const rate = flag('rate') ? Number(flag('rate')) : undefined
      if (rate !== undefined && !(rate >= 0 && rate <= 1)) die(c.red('--rate is between 0 and 1'))
      const out = await api('/api/emulator/fault', { kind, active: state === 'on', ...(rate === undefined ? {} : { rate }) })
      for (const f of out.faults ?? []) {
        console.log(`  ${String(f.kind).padEnd(16)} ${f.active ? c.red('on') : c.dim('off')}  rate ${f.rate}`)
      }
      // `sim_fault` is one global table with no academy column, so an injected failure is
      // every tenant's. Leaving one on is how somebody else's run turns red for no reason
      // they can find.
      if (state === 'on') console.log(c.yellow(`  every business in this world is now failing this way — \`drive fault ${kind} off\` when you are done`))
      break
    }

    case 'clock': {
      /**
       * **`--academy` moves that tenant alone; without it the WORLD clock moves.**
       *
       * This block used to say there was one clock and it belonged to the world, and
       * listed the three things a per-academy clock would need. 0024 wrote exactly that
       * migration — `sim_clock.academy_id` nullable with two partial unique indexes,
       * `app.now_for()` for a tenant you name, and `next_event_at` taking an optional
       * academy — so the whole caveat is now history rather than a limitation, and it is
       * deleted rather than left to be read as current.
       *
       * What matters at this call site is which row moves, because the two are not
       * equally safe once a real business shares the database. A tenant with no clock of
       * its own FOLLOWS the world's, so moving the world moves every real academy too,
       * and the deployed cron beats every 60 seconds running `planAhead()` +
       * `runDueJobs()` across all tenants. Against production that is a live business's
       * next few days of reminders fired at once, as real WhatsApp messages.
       *
       * Two things already stand between that and an accident, and neither is this
       * comment. `/api/emulator/clock` guards with `requireSandboxAcademy(body.academyId)`,
       * whose second rule is that an ABSENT academy is a refusal — so the unscoped form
       * is refused on any deployment that is not a scratch box, which is where the
       * unscoped form is dangerous. And `scripts/probe-model.ts` names its own academy on
       * every clock call for the same reason. Locally, unscoped stays the default and
       * stays right: there is nobody else's business to disturb.
       */
      let clockAcademyId: string | undefined
      {
        const wantedClockAcademy = flag('academy')
        if (wantedClockAcademy) {
          const { findAcademy } = await import('@/lib/seed')
          const found = await findAcademy(wantedClockAcademy)
          if (!found) die(c.red(`no academy matches "${wantedClockAcademy}" — \`drive world\` lists them.`))
          clockAcademyId = found.id
        }
      }
      const spec = positional[0] ?? ''
      let body: Record<string, unknown>
      if (has('next')) body = { toNextEvent: true }
      else if (has('to')) body = { setToIso: flag('to') }
      else if (has('reset')) body = { reset: true }
      else {
        const m = /^([+-]?\d+)\s*(m|min|mins|h|hr|hrs|d|days?)$/i.exec(spec.trim())
        if (!m) die(c.red('drive clock +2h | +30m | +1d | --to <iso> | --next | --reset'))
        const n = Number(m[1])
        const unit = (m[2] ?? 'h').toLowerCase()
        const ms = unit.startsWith('m') ? n * 60_000 : unit.startsWith('h') ? n * 3_600_000 : n * 86_400_000
        body = { advanceMs: ms }
      }
      if (clockAcademyId) body.academyId = clockAcademyId
      const out = await api('/api/emulator/clock', body)
      console.log(c.green(`clock → ${out.nowIso}${clockAcademyId ? c.dim(`  (${flag('academy')} only)`) : ''}`))
      console.log(c.dim(`  planned ${out.planned} · jobs ran ${out.jobs?.ran ?? 0}, skipped ${out.jobs?.skipped ?? 0}, failed ${out.jobs?.failed ?? 0}`))
      for (const line of out.jobs?.log ?? []) console.log(c.dim(`    ${clip(typeof line === 'string' ? line : JSON.stringify(line), 160)}`))
      if (out.nextEventAtIso) console.log(c.dim(`  next event ${out.nextEventAtIso}`))
      if (out.note) console.log(c.dim(`  ${out.note}`))
      break
    }

    case 'tick': {
      const out = await api('/api/emulator/tick', {})
      console.log(
        c.green(`ticked at ${out.nowIso}`),
        c.dim(`planned ${out.planned} · ran ${out.jobs?.ran ?? 0} · failed ${out.jobs?.failed ?? 0}`),
      )
      for (const line of out.jobs?.log ?? []) console.log(c.dim(`    ${clip(typeof line === 'string' ? line : JSON.stringify(line), 160)}`))
      break
    }

    case 'world': {
      const { worldAcademyIds } = await import('@/lib/seed')
      const ids = await worldAcademyIds({ refresh: true })
      if (!ids.length) {
        console.log(c.yellow('the world is empty.'))
        break
      }
      for (const id of ids) {
        const a = (await q<any>(`select name, timezone, onboarding_state, created_on from academy where id = '${id}'::uuid`, id))[0]
        console.log(`\n${c.bold(a?.name ?? id)} ${c.dim(`· ${id} · ${a?.timezone} · onboarding: ${a?.onboarding_state}`)}`)
        const people = await q<any>(
          `select c.id as contact_id, p.full_name, c.phone_e164, c.state,
                  exists (select 1 from academy_admin aa where aa.person_id = p.id and aa.academy_id = p.academy_id) as is_admin,
                  exists (select 1 from coach co where co.person_id = p.id and co.academy_id = p.academy_id) as is_coach,
                  exists (select 1 from account ac where ac.holder_person_id = p.id) as is_holder,
                  exists (select 1 from player pl where pl.person_id = p.id) as is_player
             from contact c join person p on p.id = c.person_id
            where c.academy_id = '${id}'::uuid
            order by is_admin desc, is_coach desc, p.full_name`,
          id,
        )
        for (const p of people) {
          const roles = [p.is_admin && 'admin', p.is_coach && 'coach', p.is_holder && 'holder', p.is_player && 'player']
            .filter(Boolean)
            .join('+') || 'no role'
          console.log(`  ${c.cyan(String(p.contact_id))}  ${String(p.full_name).padEnd(22)} ${c.dim(`${roles} · ${p.phone_e164} · ${p.state}`)}`)
        }
        const classes = await q<any>(
          `select cl.name, count(s.id) filter (where s.starts_at > app.now() and s.status = 'scheduled') as upcoming
             from class cl left join session s on s.class_id = cl.id
            where cl.academy_id = '${id}'::uuid group by cl.name order by cl.name`,
          id,
        )
        if (classes.length) {
          console.log(c.dim(`  classes: ${classes.map((x: any) => `${x.name} (${x.upcoming} upcoming)`).join(' · ')}`))
        }
      }
      console.log()
      break
    }

    /**
     * **The inside of a turn, round by round.**
     *
     * `thread` answers "what did this conversation look like"; this answers "what
     * did the machine do, and what did each round of it cost". They are different
     * questions and conflating them is how a turn that burned six rounds and a
     * recovery call gets read as a turn that answered.
     *
     * Everything printed here was already recorded — `turn.tool_calls` carries the
     * model's own per-round record beside the tool calls — but until this command
     * existed the only way to see it was to read the jsonb by hand, and the only
     * per-round number anybody quoted was the one the probe printed.
     */
    case 'turn': {
      const contactId = positional[0]
      const n = Number(flag('n') ?? '3')
      const scope = await academiesInScope(contactId)
      const rows: any[] = []
      for (const a of scope) {
        for (const r of await q<any>(
          // `created_at` comes back as a Date, and `String(aDate)` is
          // "Fri Aug 14 2026 …" — which sorts lexicographically by weekday and
          // slices to nonsense. Both the clock shown and the key sorted on are
          // rendered in SQL so neither depends on how the driver stringifies.
          `select t.id, to_char(t.created_at, 'YYYY-MM-DD HH24:MI:SS') as at,
                  to_char(t.created_at, 'YYYYMMDDHH24MISSUS') as seq,
                  t.role_acted, t.model, t.rounds, t.latency_ms,
                  t.prompt_tokens, t.cached_tokens, t.output_tokens, t.error, t.tool_calls,
                  t.input, p.full_name as who
             from turn t
             join contact ct on ct.id = t.contact_id
             join person p on p.id = ct.person_id
            ${contactId ? `where t.contact_id = '${contactId}'::uuid` : ''}
            order by t.created_at desc limit ${Math.max(1, Math.min(50, n))}`,
          a.id,
        )) {
          rows.push({ ...r, academy: a.name })
        }
      }
      if (!rows.length) {
        console.log(c.yellow('no turns recorded yet.'))
        break
      }
      rows.sort((x, y) => String(y.seq).localeCompare(String(x.seq)))
      rows.length = Math.min(rows.length, Math.max(1, Math.min(50, n)))

      for (const t of rows.reverse()) {
        const inr = costInr(String(t.model ?? ''), t.prompt_tokens ?? 0, t.cached_tokens ?? 0, t.output_tokens ?? 0)
        const cacheRatio = t.prompt_tokens ? Math.round((100 * (t.cached_tokens ?? 0)) / t.prompt_tokens) : 0
        const src = t.input?.source ?? '?'
        console.log(
          `\n${c.bold(`── ${t.who} (${t.role_acted})`)} ${c.dim(`· ${t.academy} · ${t.at} · via ${src}`)}`,
        )
        const asked = t.input?.text ?? t.input?.task ?? (t.input?.actionId ? `[tap ${t.input.actionId}]` : null)
        if (asked) console.log(c.dim(`   in: ${clip(String(asked), 400)}`))
        console.log(
          c.dim(
            `   ${t.rounds ?? '?'} round(s) · ${((t.latency_ms ?? 0) / 1000).toFixed(1)}s · ` +
              `${t.prompt_tokens ?? 0} in (${cacheRatio}% cached) / ${t.output_tokens ?? 0} out` +
              (inr === null ? ` · unpriced (${t.model ?? 'no model'})` : ` · ₹${inr.toFixed(2)}`),
          ),
        )
        if (t.error) console.log(c.red(`   error: ${clip(String(t.error), 500)}`))

        const trace: Trace[] = Array.isArray(t.tool_calls)
          ? t.tool_calls
          : typeof t.tool_calls === 'string'
            ? (() => {
                try {
                  const p = JSON.parse(t.tool_calls)
                  return Array.isArray(p) ? p : []
                } catch {
                  return []
                }
              })()
            : []
        for (const call of trace) {
          if (!isToolCall(call)) {
            const u = (call.result ?? {}) as any
            const rInr = costInr(String(t.model ?? ''), Number(u.in ?? 0), Number(u.cached ?? 0), Number(u.out ?? 0))
            const pct = u.in ? `${Math.round((100 * Number(u.cached ?? 0)) / Number(u.in))}% cached` : ''
            console.log(
              c.yellow(
                `\n   round ${call.round}` +
                  c.dim(
                    ` · ${(call.ms / 1000).toFixed(1)}s · ${Number(u.in ?? 0)} in${pct ? ` (${pct})` : ''} / ` +
                      `${Number(u.out ?? 0)} out${rInr === null ? '' : ` · ₹${rInr.toFixed(2)}`}` +
                      (u.finish && u.finish !== 'STOP' ? ` · finish=${u.finish}` : '') +
                      (u.recovery ? ' · RECOVERY CALL' : '') +
                      (Array.isArray(u.calls) && u.calls.length ? ` · → ${u.calls.join(', ')}` : ' · → no tools'),
                  ),
              ),
            )
            const said =
              typeof call.args === 'string' ? call.args : (call.args as any)?.returnedNothing ? '' : String(call.args ?? '')
            if (said) for (const line of clip(said, 4000).split('\n')) console.log(c.dim(`     ┊ ${line}`))
            else if (!Array.isArray(u.calls) || !u.calls.length) console.log(c.red('     ┊ (model returned nothing)'))
            if (call.error) console.log(c.red(`     ! ${clip(String(call.error), 400)}`))
            continue
          }
          const detail =
            call.name === 'read'
              ? clip(call.args?.query, 2000)
              : clip(typeof call.args === 'string' ? call.args : JSON.stringify(call.args), 2000)
          console.log(`     ${c.blue(call.name.padEnd(10))} ${c.dim(`${call.ms}ms`)}  ${detail}`)
          if (call.result !== undefined) {
            console.log(
              c.dim(
                `                → ${clip(
                  typeof call.result === 'string' ? call.result : JSON.stringify(call.result),
                  1500,
                )}`,
              ),
            )
          }
          if (call.error) console.log(c.red(`                ! ${clip(String(call.error), 400)}`))
        }
      }
      console.log()
      break
    }

    case 'thread': {
      const contactId = positional[0]
      if (!contactId) die(c.red('drive thread <contactId> [--turns] [--full] [--others]'))
      // One thread by default — a conversation is what a person sees on their phone.
      // `--others` widens it to everything the business said in the same period, which is
      // how you see who else a turn touched without replaying it.
      await showTurn(contactId, '1970-01-01T00:00:00Z', { full: has('full'), others: has('others') })
      break
    }

    case 'cost': {
      const contactId = positional[0]
      const where = contactId ? `where contact_id = '${contactId}'::uuid` : ''
      // Every read here runs under a service session pinned to ONE academy, and without
      // this it was whichever academy happened to be first in the world — so `cost
      // <contactId>` reported "no turns recorded yet" for any contact outside it, which
      // reads as a product that records nothing rather than a driver looking in the
      // wrong tenant. Same trap as `showTurn`, which already resolves the tenant.
      const scope = await academiesInScope(contactId)
      const rows: any[] = []
      for (const a of scope) {
        for (const r of await q<any>(
          `select to_char(created_at, 'HH24:MI:SS') as t, created_at, role_acted, rounds, latency_ms,
                  prompt_tokens, cached_tokens, output_tokens, model,
                  (select count(*) from jsonb_array_elements(coalesce(tool_calls,'[]'::jsonb)) call
                    where call->>'name' not like '(%') as calls,
                  (error is not null) as failed
             from turn ${where} order by created_at desc limit 40`,
          a.id,
        )) {
          rows.push({ ...r, academy: a.name })
        }
      }
      if (!rows.length) {
        console.log(c.yellow('no turns recorded yet.'))
        break
      }
      // Merged across tenants, so the 40 shown are the most recent 40 in the world rather
      // than the most recent 40 of whichever business was read first.
      rows.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)))
      rows.length = Math.min(rows.length, 40)
      const wide = scope.length > 1
      const acad = (r: any) => (wide ? `${clip(r.academy, 16).padEnd(18)}` : '')
      console.log(
        `\n${c.bold('turn'.padEnd(10))} ${wide ? 'business'.padEnd(18) : ''}${'role'.padEnd(14)} ` +
          `${'rnd'.padStart(3)} ${'secs'.padStart(6)} ${'in'.padStart(8)} ${'cache'.padStart(6)} ${'out'.padStart(6)} ${'calls'.padStart(5)}`,
      )
      let tin = 0, tout = 0, tms = 0
      for (const r of rows.reverse()) {
        tin += r.prompt_tokens ?? 0
        tout += r.output_tokens ?? 0
        tms += r.latency_ms ?? 0
        const pct = r.prompt_tokens ? `${Math.round((100 * (r.cached_tokens ?? 0)) / r.prompt_tokens)}%` : '—'
        const line =
          `${String(r.t).padEnd(10)} ${acad(r)}${String(r.role_acted ?? '').padEnd(14)} ${String(r.rounds ?? '?').padStart(3)} ` +
          `${((r.latency_ms ?? 0) / 1000).toFixed(1).padStart(6)} ${String(r.prompt_tokens ?? 0).padStart(8)} ${pct.padStart(6)} ` +
          `${String(r.output_tokens ?? 0).padStart(6)} ${String(r.calls ?? 0).padStart(5)}`
        console.log(r.failed ? c.red(line) : line)
      }
      console.log(
        c.dim(
          `\n${rows.length} turns · ${tin.toLocaleString()} in / ${tout.toLocaleString()} out · ` +
            `${(tms / 1000).toFixed(0)}s total · ${(tms / rows.length / 1000).toFixed(1)}s avg`,
        ),
      )
      console.log()
      break
    }

    /**
     * **The evidence the seven axes are judged on — measurements, not a score.**
     *
     * This was `drive score`, and it printed a scoreboard: an "unbacked claim" count
     * from a past-tense regex over the reply, a red `with a uuid`, a red `invented
     * vocabulary` from a word list, a yellow `never once: schedule`. Every one of
     * those is a verdict computed from a pattern, and the ledger of what patterns
     * over prose cost this repo is written out in `scripts/probe-ask.ts` and in
     * `lib/agent/tools.ts`: the overclaim counter read 0 on a drive containing
     * exactly one, and the jargon list fired six times on an arc with no defect in
     * it, on words the product's own ideal conversations use.
     *
     * The axes survive, because they are the right seven things to look at. What is
     * gone is the pretence that a query can answer them. So each heading now prints
     * the numbers a judge needs and stops, and the judging is written down by a
     * person in `judgement.json` — see **JUDGING.md**.
     *
     * The one thing worth keeping from the old Truth axis is not the regex: it is
     * the join. `audit_entry.turn_id` (0015) makes "how many rows did THIS turn
     * write" a fact, so a reply and its footprint can be read side by side. The
     * reading is the judgement; the numbers are the evidence.
     */
    case 'evidence': {
      const contactId = positional[0]
      const n = Number(flag('turns') ?? '200')
      const forContact = contactId ? `and t.contact_id = '${contactId}'::uuid` : ''
      const msgFilter = contactId ? `and m.contact_id = '${contactId}'::uuid` : ''

      // Per business, not "whichever tenant came back first". Two businesses read
      // differently for real reasons — one is three days old, one has a solo operator —
      // and a single merged figure hides exactly the difference worth reading.
      for (const business of await academiesInScope(contactId)) {
      const academyId = business.id
      console.log(`\n${c.bold(business.name)} ${c.dim(business.id)}`)

      const one = async <T = any>(stmt: string): Promise<T> => (await q<T>(stmt, academyId))[0] as T

      // --- 1 · Truth -------------------------------------------------------------
      // The reply and its footprint, side by side, for every turn that said anything.
      // Nothing here decides whether a turn with no writes was lying: answering a
      // question from a read is exactly this shape and is correct.
      const spoke = await q<any>(
        `select t.id::text,
                left(coalesce(t.output->>'reply', ''), 160) as reply,
                (select count(*) from audit_entry a where a.turn_id = t.id and a.diff is not null) as wrote,
                (select count(*) from message m2 where m2.turn_id = t.id
                   and m2.direction = 'outbound' and m2.suppressed_reason is null)                as reached
           from turn t
          where t.created_at > app.now() - interval '30 days' ${forContact}
            and coalesce(t.output->>'reply', '') <> ''
          order by t.created_at desc limit ${n}`,
        academyId,
      )

      /**
       * --- 2 · Correctness -------------------------------------------------------
       *
       * Whether the thing done was the RIGHT thing is not derivable and this does not
       * pretend otherwise — it prints what has to be read, which is the diff against what
       * was asked.
       *
       * The one part that IS a fact is worth having on its own: a committed plan whose
       * diff touched no rows. Postgres does not consider an `update … where` matching
       * nothing an error, so the reply says it is done and the tables disagree — the only
       * failure shape a reader of the transcript alone scores as a pass.
       */
      const forAudit = contactId ? `and ae.turn_id in (select t.id from turn t where t.contact_id = '${contactId}'::uuid)` : ''
      const correct = await one(`
        select count(*) as writes,
               count(*) filter (where jsonb_array_length(coalesce(ae.diff->'diffs', '[]'::jsonb)) = 0) as touched_nothing,
               count(*) filter (where ae.undone_at is not null) as undone
          from audit_entry ae
         where ae.created_at > app.now() - interval '30 days' ${forAudit}`)
      const lastWrites = await q<any>(
        `select ae.intent, ae.created_at,
                jsonb_array_length(coalesce(ae.diff->'diffs', '[]'::jsonb)) as tables,
                (select string_agg(distinct d->>'table', ', ')
                   from jsonb_array_elements(coalesce(ae.diff->'diffs', '[]'::jsonb)) d) as touched
           from audit_entry ae
          where ae.created_at > app.now() - interval '30 days' ${forAudit}
          order by ae.created_at desc limit 6`,
        academyId,
      )

      // --- 3 · Friction ----------------------------------------------------------
      const friction = await one(`
        select round(avg(rounds), 2) as rounds,
               round(avg(latency_ms)/1000.0, 1) as secs,
               count(*) filter (where error is not null) as errored,
               count(*) as turns
          from turn t where t.created_at > app.now() - interval '30 days' ${forContact}`)

      // --- 4 · Affordance --------------------------------------------------------
      // Every one of these was `payload ? '<key>'`, which asks whether the KEY is present —
      // and the send path writes all of them on every message, most as JSON null. So the
      // affordance rate read 100% on a world where nothing carried a button at all.
      // `jsonb_typeof` asks the question that was meant: is there anything in there?
      const afford = await one(`
        select count(*) as outbound,
               count(*) filter (where jsonb_typeof(m.payload->'buttons') = 'array'
                                   or jsonb_typeof(m.payload->'list') = 'object') as with_affordance,
               count(*) filter (where jsonb_typeof(m.payload->'list') = 'object') as with_list,
               count(*) filter (where jsonb_typeof(m.payload->'link') = 'object') as with_link
          from message m
         where m.direction = 'outbound' and m.suppressed_reason is null
           and m.queued_at > app.now() - interval '30 days' ${msgFilter}`)
      const byKind = await q<any>(
        `select payload->>'kind' as kind, count(*) as minted, count(consumed_at) as tapped
           from action where minted_at > app.now() - interval '30 days'
          group by 1 order by 2 desc`,
        academyId,
      )
      const taps = await one(`
        select count(*) filter (where input->>'actionId' is not null) as taps,
               count(*) filter (where input->>'actionId' is null and input->>'source' = 'inbound') as typed
          from turn t where t.created_at > app.now() - interval '30 days' ${forContact}`)

      // --- 5 · Capability --------------------------------------------------------
      const tools = await q<any>(
        // `not like '(%'` drops the per-round model records that share this array.
        // Without it the most-reached-for "tool" in the product is `(model)`, which
        // is not a tool and would have made axis 5 unreadable.
        `select call->>'name' as tool, count(*) as n
           from turn t, jsonb_array_elements(coalesce(t.tool_calls,'[]'::jsonb)) call
          where t.created_at > app.now() - interval '30 days' ${forContact}
            and call->>'name' not like '(%'
          group by 1 order by 2 desc`,
        academyId,
      )

      // --- 6 · Plainness ---------------------------------------------------------
      // Length, and nothing else. The uuid and jargon counters that stood here were
      // patterns over prose; the word list fired on `roster` and `record`, which are
      // the vocabulary the spec's own ideal conversations use in outbound messages.
      const plain = await one(`
        select round(avg(array_length(regexp_split_to_array(trim(m.body), '\\s+'), 1)), 1) as avg_words,
               max(array_length(regexp_split_to_array(trim(m.body), '\\s+'), 1)) as max_words,
               count(*) filter (where array_length(regexp_split_to_array(trim(m.body), '\\s+'), 1) > 60) as over_60
          from message m
         where m.direction = 'outbound' and m.body is not null and m.suppressed_reason is null
           and m.queued_at > app.now() - interval '30 days' ${msgFilter}`)

      // --- 7 · Cost --------------------------------------------------------------
      // Rounds are the driver — the stable prefix is paid on every uncached round, so
      // a turn that went round twice cost twice.
      const spend = await one(`
        select count(*) as turns,
               coalesce(sum(prompt_tokens), 0) as tin,
               coalesce(sum(cached_tokens), 0) as cached,
               coalesce(sum(output_tokens), 0) as tout,
               coalesce(sum(latency_ms), 0) as ms,
               round(avg(latency_ms)/1000.0, 1) as secs,
               count(*) filter (where rounds > 2) as over_two
          from turn t where t.created_at > app.now() - interval '30 days' ${forContact}`)

      const pct = (a: any, b: any) => (Number(b) ? `${Math.round((100 * Number(a)) / Number(b))}%` : '—')
      const h = (s: string) => console.log(`\n${c.bold(s)}`)

      h(`1 · truth      ${c.dim('— did it do what it said? Read the reply against its footprint.')}`)
      console.log(c.dim(`  ${'wrote'.padStart(5)} ${'sent'.padStart(4)}  reply`))
      for (const s of spoke.slice(0, 12)) {
        console.log(
          `  ${String(s.wrote).padStart(5)} ${String(s.reached).padStart(4)}  ${clip(String(s.reply).replace(/\s+/g, ' '), 96)}`,
        )
      }
      if (spoke.length > 12) console.log(c.dim(`  … ${spoke.length - 12} more turns, all of them in the record`))

      h(`2 · correctness ${c.dim('— was it the right thing, done right? (not derivable — read these)')}`)
      console.log(
        `  ${correct.writes} committed plan(s) · ${correct.touched_nothing} whose diff touched no rows · ${correct.undone} undone`,
      )
      for (const w of lastWrites) {
        console.log(
          `    ${c.dim(new Date(w.created_at).toISOString().slice(5, 16))} ${clip(w.intent, 46).padEnd(48)} ` +
            (Number(w.tables) === 0 ? 'touched nothing' : c.dim(String(w.touched))),
        )
      }

      h(`3 · friction   ${c.dim('— how much work did the person do?')}`)
      console.log(
        `  ${friction.turns} turns · ${friction.rounds ?? '—'} rounds avg · ${friction.secs ?? '—'}s avg · ` +
          `${friction.errored} errored`,
      )

      h(`4 · affordance ${c.dim('— could they act without typing?')}`)
      console.log(
        `  ${afford.with_affordance}/${afford.outbound} outbound carry a button or list (${pct(afford.with_affordance, afford.outbound)}) · ` +
          `${afford.with_list} lists · ${afford.with_link} links`,
      )
      console.log(`  ${taps.taps} taps vs ${taps.typed} typed inbound (${pct(taps.taps, Number(taps.taps) + Number(taps.typed))} tapped)`)
      for (const k of byKind) {
        console.log(
          `    ${String(k.kind ?? '?').padEnd(10)} ${String(k.minted).padStart(4)} minted  ${String(k.tapped).padStart(4)} tapped  ${pct(k.tapped, k.minted).padStart(5)}`,
        )
      }
      console.log(
        c.dim(
          '  a high affordance rate is not a win on its own — the runtime bolts a menu button onto anything bare,\n' +
            '  so read the per-kind tap rates: they say whether the affordance was worth offering.',
        ),
      )

      h(`5 · capability ${c.dim('— what did it actually reach for?')}`)
      const shown = tools.filter((t: any) => !String(t.tool).startsWith('('))
      console.log(`  ${shown.map((t: any) => `${t.tool} ${t.n}`).join(' · ') || c.dim('nothing')}`)
      console.log(c.dim('  what is ABSENT from that list is the reading worth making — a tool never once reached for'))
      console.log(c.dim('  is either unnecessary or invisible, and only the turns can say which.'))

      h(`6 · plainness  ${c.dim('— would this read as English to someone who has never used software?')}`)
      console.log(
        `  ${plain.avg_words ?? '—'} words avg · ${plain.max_words ?? '—'} longest · ${plain.over_60} over 60 words`,
      )
      console.log(c.dim('  length is the only part of plainness a query can see. Read the bodies for the rest.'))

      h(`7 · cost       ${c.dim('— seconds and tokens, and rounds are the driver')}`)
      console.log(
        `  ${spend.turns} turns · ${Number(spend.tin).toLocaleString()} in (${pct(spend.cached, spend.tin)} cached) / ` +
          `${Number(spend.tout).toLocaleString()} out · ${(Number(spend.ms) / 1000).toFixed(0)}s total · ${spend.secs ?? '—'}s avg`,
      )
      console.log(
        `  ${spend.over_two} turn(s) went more than two rounds` +
          c.dim('  · WhatsApp cannot stream, so these seconds are seconds of silence'),
      )
      console.log(c.dim('\n  Nothing above is a verdict. Write one: JUDGING.md'))
      console.log()
      }
      break
    }

    case 'money': {
      // Every business, unless one is named. This read is the answer to "has any of the
      // money half ever worked", and reporting one anonymous tenant's accounts as though
      // they were the world's is the exact way that question got answered wrongly.
      for (const business of await academiesInScope(positional[0])) {
        /**
         * **Which month.** `billed` was hard-wired to `date_trunc('month', app.now())`, so
         * the one thing a month-end run produces — last month's lines, read back and
         * dunned — was invisible from the command that exists to look at money, and a
         * business whose rollover had just worked perfectly showed a column of zeros.
         * `--period all` is the whole ledger, which is what you want after driving several.
         */
        const everything = (flag('period') ?? '').toLowerCase() === 'all'
        const period = everything ? null : await periodFor(business.id)
        const billedIn = everything ? 'true' : `t.period = '${period}'::date`
        const rows = await q<any>(
          `select ac.display_name,
                  coalesce(sum(t.amount) filter (where ${billedIn}), 0) as billed,
                  coalesce((select sum(p.amount) from payment p where p.account_id = ac.id and p.status = 'confirmed'), 0) as confirmed,
                  coalesce((select sum(p.amount) from payment p where p.account_id = ac.id and p.status = 'requested'), 0) as requested,
                  coalesce((select sum(p.amount) from payment p where p.account_id = ac.id and p.status = 'failed'), 0) as failed
             from account ac left join tally_line t on t.account_id = ac.id
            group by ac.id, ac.display_name order by billed desc`,
          business.id,
        )
        console.log(
          `\n${c.bold(business.name)} ${c.dim(`${business.id} · billed for ${everything ? 'every period' : String(period).slice(0, 7)}`)}`,
        )
        if (!rows.length) console.log(c.dim('  no accounts — nobody can owe anything yet'))
        for (const r of rows) {
          // `requested` and `failed` were one bucket, `status <> 'confirmed'` — so a
          // payment that FAILED was reported as still awaiting confirmation, which is the
          // one thing an admin must not be told about money that is not coming.
          console.log(
            `  ${String(r.display_name).padEnd(22)} billed ${money(r.billed).padStart(10)}  confirmed ${money(r.confirmed).padStart(10)}  ` +
              (Number(r.requested) > 0 ? c.yellow(`awaiting confirmation ${money(r.requested)}  `) : '') +
              (Number(r.failed) > 0 ? c.red(`failed ${money(r.failed)}`) : ''),
          )
        }
      }
      console.log()
      break
    }

    case 'help':
    default:
      if (cmd && cmd !== 'help') console.log(c.red(`\nthere is no \`drive ${cmd}\`.`))
      console.log(
        [
          '',
          c.bold('drive') + c.dim(' — be a person, and see what the bot did about it'),
          '',
          ...HELP.map(([name, blurb]) =>
            `  ${name.padEnd(Math.max(...HELP.map(([n]) => n.length)) + 2)}${c.dim(blurb)}`,
          ),
          '',
          c.dim('  --academy "<name>"  scopes cost / evidence / money to one business (default: all of them)'),
          c.dim('  --full              whole bodies and whole tool traces, not clipped'),
          '',
        ].join('\n'),
      )
      await reportUndocumented()
  }

  const db = await import('@/lib/db')
  await db.closePool().catch(() => {})
}

await main()

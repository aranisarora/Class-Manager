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
 *   npm run drive -- academy "Ace TT" --admin "Sharwin Rao"
 *   npm run drive -- new <academyId> --name "Meera Iyer" --role client
 *   npm run drive -- say <contactId> "saturday batch pls"
 *   npm run drive -- stranger +919000000001 "hi is this the badminton academy?"
 *   npm run drive -- tap <contactId> <n>         # tap the nth button of the last message
 *   npm run drive -- clock +2h | --to 2026-08-15T08:00:00+05:30 | --next
 *   npm run drive -- tick                        # run what is due, without moving time
 *   npm run drive -- thread <contactId> [--turns] [--full]
 *   npm run drive -- cost [contactId]            # tokens, latency, cache, per turn
 *
 * `say` and `tap` print the reply, the buttons, and the flight recorder for that
 * turn — every query the model ran and what came back. That is the whole point:
 * a wrong answer is diagnosable in one command.
 */
import { c, loadEnvFiles } from './_env'

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
  const res = await fetch(`${BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
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

function clip(s: unknown, n: number): string {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

const money = (n: unknown) => `₹${Number(n ?? 0).toLocaleString('en-IN')}`

// -----------------------------------------------------------------------------
// Printing a turn: the reply, the buttons, and the flight recorder.
// -----------------------------------------------------------------------------

type Trace = { round: number; name: string; ms: number; args?: any; result?: any; error?: string }

async function showTurn(contactId: string, sinceIso: string, o: { full?: boolean } = {}): Promise<void> {
  const academyId = (await q<{ academy_id: string }>(
    `select academy_id from contact where id = '${contactId}'::uuid limit 1`,
  ).catch(() => []))[0]?.academy_id

  const msgs = await q<any>(
    `select direction, body, payload, status, suppressed_reason, solicited, catalog_id, created_at
       from message
      where contact_id = '${contactId}'::uuid and created_at > '${sinceIso}'::timestamptz
      order by created_at`,
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
    const arrow = m.direction === 'inbound' ? c.dim('  →') : c.cyan('  ←')
    const flags: string[] = []
    if (m.suppressed_reason) flags.push(c.red(`SUPPRESSED: ${m.suppressed_reason}`))
    else if (m.status !== 'sent' && m.status !== 'delivered' && m.status !== 'read') flags.push(m.status)
    if (m.catalog_id) flags.push(c.dim(m.catalog_id))
    if (m.direction === 'outbound' && !m.solicited) flags.push(c.dim('unsolicited'))
    console.log(`${arrow} ${o.full ? String(m.body ?? '') : clip(m.body, 300)}${flags.length ? `  ${flags.join(' · ')}` : ''}`)

    const buttons = m.payload?.buttons
    if (Array.isArray(buttons) && buttons.length) {
      console.log(`     ${c.green(`[ ${buttons.map((b: any) => b.title).join(' ] [ ')} ]`)}`)
    }
    const list = m.payload?.list
    if (list?.sections?.length) {
      const rows = list.sections.flatMap((s: any) => s.rows ?? [])
      console.log(`     ${c.green(`LIST "${list.buttonText}": ${rows.map((r: any) => r.title).join(' / ')}`)}`)
    }
  }

  for (const t of turns) {
    const cacheRatio = t.prompt_tokens ? Math.round((100 * (t.cached_tokens ?? 0)) / t.prompt_tokens) : 0
    console.log(
      c.dim(
        `     · ${t.role_acted} · ${t.rounds ?? '?'} round(s) · ${((t.latency_ms ?? 0) / 1000).toFixed(1)}s · ` +
          `${t.prompt_tokens ?? 0} in (${cacheRatio}% cached) / ${t.output_tokens ?? 0} out`,
      ),
    )
    if (t.error) console.log(`     ${c.red(`· error: ${clip(t.error, 300)}`)}`)
    for (const call of (t.tool_calls ?? []) as Trace[]) {
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

async function nowIso(): Promise<string> {
  const { now } = await import('@/lib/clock')
  return (await now()).toISOString()
}

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  switch (cmd) {
    case 'reset': {
      const { resetWorld } = await import('@/lib/seed')
      await resetWorld()
      console.log(c.green('world wiped — no academies, no people, no jobs, clock at real time.'))
      break
    }

    case 'seed': {
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

    case 'new': {
      const academyId = positional[0] ?? (await anyAcademyId())
      const name = flag('name')
      const role = (flag('role') ?? 'client') as 'client' | 'coach' | 'admin' | 'prospect'
      if (!name) die(c.red('drive new [academyId] --name "<person>" --role client|coach|admin|prospect [--phone +91...]'))
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
      if (!contactId || !text) die(c.red('drive say <contactId> "<what they type>"'))
      const at = await nowIso()
      console.log(`${c.dim('  →')} ${text}`)
      await api('/api/emulator/inbound', { contactId, text })
      await showTurn(contactId, at, { full: has('full') })
      break
    }

    /** An unknown number arriving cold — the §10.1 path a contact row cannot test. */
    case 'stranger': {
      const phone = positional[0]
      const text = positional.slice(1).join(' ')
      if (!phone || !text) die(c.red('drive stranger <+91...> "<what they type>"'))
      const { ingestInbound, SENDER_PHONE } = await import('@/lib/seed')
      const at = await nowIso()
      console.log(`${c.dim('  →')} ${text}  ${c.dim(`(from ${phone}, unknown)`)}`)
      const out: any = await ingestInbound({
        fromPhoneE164: phone.startsWith('+') ? phone : `+${phone}`,
        senderPhoneE164: flag('to') ?? SENDER_PHONE,
        profileName: flag('as'),
        text,
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

    case 'tap': {
      const contactId = positional[0]
      const which = Number(positional[1] ?? '1')
      if (!contactId) die(c.red('drive tap <contactId> [buttonNumber]'))
      const rows = await q<any>(
        `select payload from message
          where contact_id = '${contactId}'::uuid and direction = 'outbound'
            and suppressed_reason is null and payload->'buttons' <> 'null'::jsonb
          order by created_at desc limit 1`,
      )
      const buttons = rows[0]?.payload?.buttons
      if (!Array.isArray(buttons) || !buttons.length) die(c.red('the last message to that contact has no buttons.'))
      const button = buttons[which - 1]
      if (!button) die(c.red(`there is no button ${which} — there are ${buttons.length}.`))
      const at = await nowIso()
      console.log(`${c.dim('  →')} ${c.green(`[tap] ${button.title}`)}`)
      await api('/api/emulator/inbound', { contactId, actionId: button.actionId })
      await showTurn(contactId, at, { full: has('full') })
      break
    }

    case 'clock': {
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
      const out = await api('/api/emulator/clock', body)
      console.log(c.green(`clock → ${out.nowIso}`))
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

    case 'thread': {
      const contactId = positional[0]
      if (!contactId) die(c.red('drive thread <contactId> [--turns] [--full]'))
      await showTurn(contactId, '1970-01-01T00:00:00Z', { full: has('full') })
      break
    }

    case 'cost': {
      const contactId = positional[0]
      const where = contactId ? `where contact_id = '${contactId}'::uuid` : ''
      const rows = await q<any>(
        `select to_char(created_at, 'HH24:MI:SS') as t, role_acted, rounds, latency_ms,
                prompt_tokens, cached_tokens, output_tokens,
                jsonb_array_length(coalesce(tool_calls,'[]'::jsonb)) as calls,
                (error is not null) as failed
           from turn ${where} order by created_at desc limit 40`,
      )
      if (!rows.length) {
        console.log(c.yellow('no turns recorded yet.'))
        break
      }
      console.log(`\n${c.bold('turn'.padEnd(10))} ${'role'.padEnd(14)} ${'rnd'.padStart(3)} ${'secs'.padStart(6)} ${'in'.padStart(8)} ${'cache'.padStart(6)} ${'out'.padStart(6)} ${'calls'.padStart(5)}`)
      let tin = 0, tout = 0, tms = 0
      for (const r of rows.reverse()) {
        tin += r.prompt_tokens ?? 0
        tout += r.output_tokens ?? 0
        tms += r.latency_ms ?? 0
        const pct = r.prompt_tokens ? `${Math.round((100 * (r.cached_tokens ?? 0)) / r.prompt_tokens)}%` : '—'
        const line =
          `${String(r.t).padEnd(10)} ${String(r.role_acted ?? '').padEnd(14)} ${String(r.rounds ?? '?').padStart(3)} ` +
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

    case 'money': {
      const rows = await q<any>(
        `select ac.display_name,
                coalesce(sum(t.amount) filter (where t.period = date_trunc('month', app.now())::date), 0) as billed,
                coalesce((select sum(p.amount) from payment p where p.account_id = ac.id and p.status = 'confirmed'), 0) as confirmed,
                coalesce((select sum(p.amount) from payment p where p.account_id = ac.id and p.status <> 'confirmed'), 0) as pending
           from account ac left join tally_line t on t.account_id = ac.id
          group by ac.id, ac.display_name order by billed desc`,
      )
      for (const r of rows) {
        console.log(
          `  ${String(r.display_name).padEnd(22)} billed ${money(r.billed).padStart(10)}  confirmed ${money(r.confirmed).padStart(10)}  ${
            Number(r.pending) > 0 ? c.yellow(`awaiting confirmation ${money(r.pending)}`) : ''
          }`,
        )
      }
      break
    }

    default:
      console.log(
        [
          '',
          c.bold('drive') + c.dim(' — be a person, and see what the bot did about it'),
          '',
          '  world                                   who exists, with contact ids',
          '  reset                                   wipe everything (no seed)',
          '  seed [--scenario ace|solo|both]         the deterministic fixture',
          '  academy "<name>" --admin "<person>"     create an academy + its admin',
          '  new [academyId] --name X --role client|coach|admin|prospect',
          '  say <contactId> "<text>" [--full]       type as that person',
          '  stranger <+91...> "<text>"              an unknown number, cold',
          '  tap <contactId> [n] [--full]            tap the nth button of the last message',
          '  clock +2h | --to <iso> | --next | --reset',
          '  tick                                    run due jobs without moving time',
          '  thread <contactId> [--full]             the whole conversation + flight recorder',
          '  cost [contactId]                        tokens, cache ratio, latency per turn',
          '  money                                   billed vs confirmed vs awaiting',
          '',
        ].join('\n'),
      )
  }

  const db = await import('@/lib/db')
  await db.closePool().catch(() => {})
}

await main()

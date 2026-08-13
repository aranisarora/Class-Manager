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
 *   npm run drive -- score [contactId]           # the seven axes, as numbers
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
import type { LinkPurpose } from '@/lib/web/jwt'

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

// -----------------------------------------------------------------------------
// Printing a turn: the reply, the buttons, and the flight recorder.
// -----------------------------------------------------------------------------

type Trace = { round: number; name: string; ms: number; args?: any; result?: any; error?: string }

async function showTurn(contactId: string, sinceIso: string, o: { full?: boolean } = {}): Promise<void> {
  const academyId = await academyOfContact(contactId)

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
    // §14.6 — a link is a button now, so it is no longer in the body where `open` used
    // to find it. A driver that cannot see the product's own affordances is a driver
    // that reports them as missing.
    if (m.payload?.link?.url) {
      console.log(`     ${c.green(`↗ [ ${m.payload.link.title} ]`)} ${c.dim(clip(m.payload.link.url, 60))}`)
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

/**
 * A rendered page as a person would read it: the text, the fields, the buttons.
 * Not a browser — enough to tell whether the screen says the right things, which
 * is the question a driver needs answered.
 */
/**
 * Which screen a signed link opens, read off the JWT's own payload.
 *
 * No verification here on purpose: this is a driver deciding which of several links
 * you meant, not a boundary. The real check happens in `verifyLink` when the page
 * loads, which is where it belongs.
 */
function purposeOf(url: string): string | null {
  const token = url.split('/w/')[1]?.split(/[?#]/)[0]
  const body = token?.split('.')[1]
  if (!body) return null
  try {
    const json = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return typeof json?.purpose === 'string' ? json.purpose : null
  } catch {
    return null
  }
}

function renderPage(html: string): string {
  const body = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  const out: string[] = []
  const inputs = [...body.matchAll(/<(input|select|textarea)\b[^>]*>/gi)].map((m) => {
    const tag = m[0]
    const attr = (name: string) => new RegExp(`${name}="([^"]*)"`, 'i').exec(tag)?.[1] ?? ''
    return `    [${attr('type') || m[1]}] ${attr('name') || attr('placeholder') || attr('aria-label') || '?'}${
      attr('value') ? ` = ${attr('value')}` : ''
    }`
  })
  const text = body
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h1|h2|h3|li|tr|label|section)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  out.push(text.map((l) => `    ${l}`).join('\n'))
  if (inputs.length) out.push(c.dim(`  fields:\n${inputs.join('\n')}`))
  return out.join('\n')
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
      const media = flag('media')
      if (!contactId || (!text && !media)) die(c.red('drive say <contactId> "<what they type>" [--media <file>]'))
      const at = await nowIso()
      // §7.1 step 2 is "bring the timetable however it already exists" — a photo,
      // a forwarded sheet, a voice note — and it is called the single biggest
      // friction reducer in the product. There was no way to send one of those
      // from here, so it had never been driven.
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
        await academyOfContact(contactId),
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

    /**
     * The web surface is half the product's UI and could not be driven at all.
     *
     * §15's screens are reached by a signed link inside a message, so the only
     * way to test one was to copy a token out of the database by hand. That is
     * why the setup form and the register — the two screens onboarding depends
     * on — had never once been opened by anybody testing this. `open` follows
     * the link the bot actually sent, exactly as a person tapping it would.
     */
    case 'open': {
      const contactId = positional[0]
      const which = Number(positional[1] ?? flag('n') ?? '1')
      const purpose = flag('purpose')
      if (!contactId) {
        die(
          c.red('drive open <contactId> [n]  — follow a link the bot sent'),
          c.dim('  --purpose setup|register|calendar|view   only links of that kind'),
          c.dim('  --n 2                                    the 2nd most recent'),
        )
      }
      /**
       * Every link the bot has sent this person, newest first — not just the newest.
       *
       * This used to read exactly one row: `order by created_at desc limit 1`. So a
       * setup link offered five messages ago was unreachable the moment anything else
       * with a link arrived, and there was no way to say *which* screen you meant. Half
       * the reason §15's screens went undriven is that the driver could only ever
       * follow whichever door the bot had most recently opened.
       */
      const rows = await q<any>(
        `select body, payload, created_at from message
          where contact_id = '${contactId}'::uuid and direction = 'outbound'
            and suppressed_reason is null
            and (payload->'link'->>'url' is not null or body ~ 'https?://')
          order by created_at desc limit 25`,
        await academyOfContact(contactId),
      )
      // The link button first, the body second: a URL still in a body is a bug now, and
      // reading it here would hide the bug behind a driver that works anyway.
      const urls: string[] = []
      for (const r of rows) {
        const linked = r?.payload?.link?.url
        if (linked) urls.push(String(linked))
        else for (const u of String(r?.body ?? '').match(/https?:\/\/\S+/g) ?? []) urls.push(u)
      }
      const matching = purpose ? urls.filter((u) => purposeOf(u) === purpose) : urls
      const url = matching[which - 1]
      if (!url) {
        die(
          c.red(
            purpose
              ? `no ${purpose} link in the last 25 messages to that contact (found: ${
                  urls.map(purposeOf).filter(Boolean).join(', ') || 'none'
                })`
              : `that contact has ${urls.length} link(s) in recent messages — asked for #${which}.`,
          ),
          c.dim('  `drive link <contactId> --screen register --session <id>` mints one directly.'),
        )
      }
      console.log(c.dim(`  GET ${url}  [${purposeOf(url) ?? 'unknown'}]`))
      const res = await fetch(url)
      const html = await res.text()
      console.log(c.dim(`  ${res.status} · ${html.length} bytes`))
      console.log(renderPage(html))
      break
    }

    /**
     * **Mint a screen link directly, as the runtime would.**
     *
     * The reason §15's register had never been opened by anybody is not that it was
     * broken — it is that it was unreachable from here. `open` can only follow a link
     * the bot has already sent, `CO-REGISTER` goes out as a paid template to an
     * out-of-window coach, and so the highest-traffic screen after the chat sat behind
     * a door only the model could open, on a path nobody could drive. `attendance` has
     * zero rows in every world ever driven, and that is the whole explanation.
     *
     * This signs the same JWT `linkFor()` does, for the same person, with the same TTL.
     * It is the operator reaching past the conversation, which is exactly what a driver
     * is for — and it deliberately does NOT send a message, so it cannot be mistaken
     * for testing whether the bot would have offered it.
     */
    case 'link': {
      const contactId = positional[0]
      const screen = (flag('screen') ?? positional[1] ?? '') as LinkPurpose
      if (!contactId || !['setup', 'register', 'calendar', 'view'].includes(screen)) {
        die(
          c.red('drive link <contactId> --screen setup|register|calendar|view [--session <id>] [--ref <viewSpecId>]'),
          c.dim('  mints the signed link directly — no message sent, no model call'),
        )
      }
      const academyId = await academyOfContact(contactId)
      const person = await q<any>(
        `select person_id from contact where id = '${contactId}'::uuid`,
        academyId,
      )
      if (!person[0]) die(c.red('no such contact'))

      let ref = flag('session') ?? flag('ref') ?? ''
      if (screen === 'register' && !ref) {
        // The commonest thing you want is "the register for the class that just ended",
        // and making somebody paste a uuid to get it is the friction this command exists
        // to remove.
        const s = await q<any>(
          `select s.id, s.starts_at, c.name from session s join class c on c.id = s.class_id
            where s.status = 'scheduled' and s.ends_at < app.now()
            order by s.ends_at desc limit 1`,
          academyId,
        )
        if (!s[0]) die(c.red('no finished session to take a register for — pass --session <id>'))
        ref = String(s[0].id)
        console.log(c.dim(`  register for ${s[0].name} @ ${s[0].starts_at} (${ref})`))
      }

      const { signLink, linkUrl, TTL } = await import('@/lib/web/jwt')
      const token = await signLink(
        {
          academy_id: academyId,
          person_id: String(person[0].person_id),
          contact_id: contactId,
          purpose: screen,
          ...(ref ? { ref } : {}),
        },
        TTL[screen],
      )
      const url = linkUrl(token)
      console.log(`${c.dim('  url')} ${url}`)
      if (has('open')) {
        const res = await fetch(url)
        const html = await res.text()
        console.log(c.dim(`  ${res.status} · ${html.length} bytes`))
        console.log(renderPage(html))
      } else {
        console.log(c.dim('  --open to follow it now, or `drive submit <contactId>` against it'))
      }
      break
    }

    /** Post to the screen's own submit route, the way its form does. */
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

      const person = await q<any>(`select person_id from contact where id = '${contactId}'::uuid`, academyId)
      const { signLink, linkUrl, TTL } = await import('@/lib/web/jwt')
      const token = await signLink(
        {
          academy_id: academyId,
          person_id: String(person[0].person_id),
          contact_id: contactId,
          purpose: 'register',
          ref: sessionId,
        },
        TTL.register,
      )
      const at = await nowIso()
      const res = await fetch(`${linkUrl(token).replace(/\/$/, '')}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'register', sessionId, marks }),
      })
      console.log(c.dim(`  POST ${res.status}`), await res.text())
      await showTurn(contactId, at, {})
      break
    }

    case 'submit': {
      const contactId = positional[0]
      const payload = flag('json')
      if (!contactId || !payload) die(c.red(`drive submit <contactId> --json '{"kind":"setup",...}'`))
      const rows = await q<any>(
        `select body, payload from message
          where contact_id = '${contactId}'::uuid and direction = 'outbound'
            and suppressed_reason is null
            and (payload->'link'->>'url' is not null or body ~ 'https?://')
          order by created_at desc limit 1`,
        await academyOfContact(contactId),
      )
      const url =
        rows[0]?.payload?.link?.url ?? (String(rows[0]?.body ?? '').match(/https?:\/\/\S+/g) ?? [])[0]
      if (!url) die(c.red('no link in the last message to that contact.'))
      const at = await nowIso()
      const res = await fetch(`${url.replace(/\/$/, '')}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      })
      console.log(c.dim(`  POST ${res.status}`), await res.text())
      await showTurn(contactId, at, {})
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
      // Every read here runs under a service session pinned to ONE academy, and without
      // this it was whichever academy happened to be first in the world — so `cost
      // <contactId>` reported "no turns recorded yet" for any contact outside it, which
      // reads as a product that records nothing rather than a driver looking in the
      // wrong tenant. Same trap as `showTurn`, which already resolves the tenant.
      const costAcademy = contactId ? await academyOfContact(contactId) : undefined
      const rows = await q<any>(
        `select to_char(created_at, 'HH24:MI:SS') as t, role_acted, rounds, latency_ms,
                prompt_tokens, cached_tokens, output_tokens,
                jsonb_array_length(coalesce(tool_calls,'[]'::jsonb)) as calls,
                (error is not null) as failed
           from turn ${where} order by created_at desc limit 40`,
        costAcademy,
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

    /**
     * **The seven axes, as numbers rather than impressions.**
     *
     * FINDINGS names this as one of two cheap things nobody has taken, and the argument
     * for it is that the axes it covers are one SQL statement each over `message`,
     * `action` and `turn` — so "the bot feels wordy this week" becomes a figure, and a
     * regression in affordance or plainness shows up without anybody noticing it by eye.
     * Two of the entries in that ledger were found only because somebody happened to
     * count by hand.
     *
     * Axis 1 (Truth) is the one that matters most and was not queryable at all until
     * `audit_entry.turn_id` existed (0015). It is queryable now, and it is the first
     * thing printed: **a reply that claimed a completed action, with no write from that
     * turn behind it.** Past-tense detection is a heuristic and is labelled as one —
     * the point is not a perfect count, it is that an unbacked claim stops being
     * invisible.
     *
     * Deliberately not a pass/fail. Nothing here knows what good looks like for a
     * particular business; a person reading two runs side by side does.
     */
    case 'score': {
      const contactId = positional[0]
      const n = Number(flag('turns') ?? '200')
      const academyId = contactId ? await academyOfContact(contactId) : undefined
      const forContact = contactId ? `and t.contact_id = '${contactId}'::uuid` : ''
      const msgFilter = contactId ? `and m.contact_id = '${contactId}'::uuid` : ''

      const one = async <T = any>(sql: string): Promise<T> => (await q<T>(sql, academyId))[0] as T

      // --- 1 · Truth -------------------------------------------------------------
      const truth = await one(`
        with recent as (
          select t.id, t.output->>'reply' as reply
            from turn t
           where t.created_at > app.now() - interval '30 days' ${forContact}
           order by t.created_at desc limit ${n}
        ),
        claimed as (
          select id, reply from recent
           where reply ~* '\\y(i(''| ha)ve |i just )?(added|created|cancelled|canceled|moved|updated|removed|sent|booked|marked|set up|saved|waived|recorded|enrolled|scheduled)\\y'
        )
        select (select count(*) from recent) as turns,
               (select count(*) from claimed) as claims,
               (select count(*) from claimed cl
                 where not exists (select 1 from audit_entry a
                                    where a.turn_id = cl.id and a.diff is not null)) as unbacked`)

      // --- 3 · Friction ----------------------------------------------------------
      const friction = await one(`
        select round(avg(rounds), 2) as rounds,
               round(avg(latency_ms)/1000.0, 1) as secs,
               count(*) filter (where error is not null) as errored,
               count(*) as turns
          from turn t where t.created_at > app.now() - interval '30 days' ${forContact}`)

      // --- 4 · Affordance --------------------------------------------------------
      const afford = await one(`
        select count(*) as outbound,
               count(*) filter (where m.payload ? 'buttons' or m.payload ? 'list') as with_affordance,
               count(*) filter (where m.payload ? 'list') as with_list,
               count(*) filter (where m.payload->'link' is not null) as with_link
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
        `select call->>'name' as tool, count(*) as n
           from turn t, jsonb_array_elements(coalesce(t.tool_calls,'[]'::jsonb)) call
          where t.created_at > app.now() - interval '30 days' ${forContact}
          group by 1 order by 2 desc`,
        academyId,
      )

      // --- 6 · Plainness ---------------------------------------------------------
      const plain = await one(`
        select round(avg(array_length(regexp_split_to_array(trim(m.body), '\\s+'), 1)), 1) as avg_words,
               count(*) filter (where array_length(regexp_split_to_array(trim(m.body), '\\s+'), 1) > 60) as over_60,
               count(*) filter (where m.body ~ '[0-9a-f]{8}-[0-9a-f]{4}-') as with_uuid,
               count(*) filter (where m.body ~* '\\y(academy|roster|onboarding|setup phase|the system)\\y') as jargon
          from message m
         where m.direction = 'outbound' and m.body is not null and m.suppressed_reason is null
           and m.queued_at > app.now() - interval '30 days' ${msgFilter}`)

      const pct = (a: any, b: any) => (Number(b) ? `${Math.round((100 * Number(a)) / Number(b))}%` : '—')
      const h = (s: string) => console.log(`\n${c.bold(s)}`)

      h(`1 · truth      ${c.dim('— did it actually do what it said?')}`)
      console.log(
        `  ${String(truth.claims)} of ${truth.turns} replies claimed something was done · ` +
          (Number(truth.unbacked) > 0
            ? c.red(`${truth.unbacked} with NO write from that turn behind it`)
            : c.dim('all backed by a write from that turn')),
      )
      console.log(c.dim('  (past-tense detection is a heuristic — read the flagged turns, do not trust the count)'))

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
        const rate = pct(k.tapped, k.minted)
        console.log(
          `    ${String(k.kind ?? '?').padEnd(10)} ${String(k.minted).padStart(4)} minted  ${String(k.tapped).padStart(4)} tapped  ${rate.padStart(5)}`,
        )
      }
      console.log(
        c.dim(
          '  a 100% affordance rate is not a win on its own — the runtime bolts a menu button onto anything bare,\n' +
            '  so read the per-kind tap rates: they say whether the affordance was worth offering.',
        ),
      )

      h(`5 · capability ${c.dim('— what did it actually reach for?')}`)
      const shown = tools.filter((t: any) => !String(t.tool).startsWith('('))
      console.log(`  ${shown.map((t: any) => `${t.tool} ${t.n}`).join(' · ') || c.dim('nothing')}`)
      for (const want of ['schedule', 'view', 'remember', 'recall', 'handoff']) {
        if (!shown.some((t: any) => t.tool === want)) {
          console.log(c.yellow(`  never once: ${want}`))
        }
      }
      const silent = tools.find((t: any) => String(t.tool).includes('returned nothing'))
      if (silent) console.log(c.yellow(`  ${silent.n} rounds produced neither a call nor a word`))

      h(`6 · plainness  ${c.dim('— would this read as English to someone who has never used software?')}`)
      console.log(
        `  ${plain.avg_words ?? '—'} words avg · ${plain.over_60} over 60 words · ` +
          (Number(plain.with_uuid) ? c.red(`${plain.with_uuid} with a uuid`) : c.dim('no uuids')) +
          ' · ' +
          (Number(plain.jargon) ? c.red(`${plain.jargon} with invented vocabulary`) : c.dim('no invented vocabulary')),
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
          '  drop <academyId|"name">                 delete a business and everything in it',
          '  remove <contactId>                      delete one person and their rows',
          '  new [academyId] --name X --role client|coach|admin|prospect',
          '  say <contactId> "<text>" [--media f] [--full]   type as that person, with an attachment',
          '  stranger <+91...> "<text>"              an unknown number, cold',
          '  tap <contactId> [n] [--full]            tap the nth button of the last message',
          '  open <contactId> [n]                    follow the nth link the bot sent, and read the page',
          "  submit <contactId> --json '{...}'       post that page's form, as they would",
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

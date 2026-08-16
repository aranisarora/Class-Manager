/**
 * scripts/wa-cloud.ts — point the product at a real WhatsApp number.
 *
 *   npm run wa                    # status: every precondition, in one screen
 *   npm run wa -- link            # write the credentials into the sender row
 *   npm run wa -- subscribe       # subscribe the app to the WABA's webhooks
 *   npm run wa -- templates       # create the eight §16.2 templates
 *   npm run wa -- send-test +91…  # hello_world, straight down the wire
 *
 * WHY A SCRIPT AND NOT ENV VARS
 * -----------------------------------------------------------------------------
 * §16.3 puts per-sender credentials in `sender.credentials`, not in the
 * environment, because one deployment serves many numbers and an env var can only
 * describe one. So "configure WhatsApp" is a database write, not a config edit,
 * and that write needs somewhere to live that is re-runnable — `resetWorld()`
 * does `delete from sender`, so **every seed drops the credentials and this has
 * to be run again**. That is the single most surprising thing about this setup
 * and the reason `status` leads with whether the row is actually there.
 *
 * The env keys below are this script's input only. The running app never reads
 * them for sending; it reads the row this writes. The two exceptions are
 * `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET`, which belong to the inbound
 * webhook route and are read from `process.env` there by design.
 *
 * WHY IT CONTAINS NO URL
 * -----------------------------------------------------------------------------
 * §17: no Meta API call may exist outside `transport-cloud.ts`. Provisioning is a
 * Meta API call. Every Graph shape this needs is an exported function of that
 * file; this is a CLI over them.
 */

import { loadEnvFiles, c } from './_env'

loadEnvFiles()

import { closePool, unsafeQuery, withSession } from '@/lib/db'
import type { SessionCtx } from '@/lib/db'
import { FLOWS, FORM_IDS, validateFlowJson } from '@/lib/messaging/flows'
import { TEMPLATES, TEMPLATE_NAMES } from '@/lib/messaging/templates'
import type { TemplateName } from '@/lib/messaging/templates'
import {
  configureWebhook,
  createFlow,
  debugToken,
  deleteTemplate,
  describePhoneNumber,
  isIntegrityBlock,
  listFlows,
  listSubscribedApps,
  listTemplates,
  provisionTemplates,
  publishFlow,
  readWebhookConfig,
  sendHelloWorld,
  subscribeApp,
  templateSubmission,
  uploadFlowJson,
} from '@/lib/messaging/transport-cloud'
import type { FlowRegistry } from '@/lib/messaging/transport-cloud'

// `academyId: ''` — the sender table is global and its cm_service policy is
// `using (true)`, so the tenant this session is pinned to is irrelevant. Same
// bootstrap context `lib/identity.ts` uses to resolve an inbound before it knows
// which academy the message belongs to.
const BOOTSTRAP: SessionCtx = { role: 'service', academyId: '' }

/**
 * Meta's "try again in less than 1 minute" for subcode 2388025 is not true. The
 * name→category association outlives the template by considerably longer than
 * that — a delete that has already vanished from `message_templates` still
 * refuses a resubmission under a different category. There is nothing to do but
 * come back later, so say that instead of printing a bare code.
 */
function categoryHoldHint(error: string | undefined): string | null {
  if (!error?.includes('2388025')) return null
  return 'Meta still holds the old category for this name. It clears on its own — re-run `npm run wa -- templates` later. Do NOT resubmit it as MARKETING (§16.1).'
}

const ok = (s: string) => `${c.green('✓')} ${s}`
const bad = (s: string) => `${c.red('✗')} ${s}`
const warn = (s: string) => `${c.yellow('!')} ${s}`
const info = (s: string) => `${c.dim('·')} ${s}`

function heading(s: string): void {
  console.log(`\n${c.bold(s)}`)
}

/** Last ten digits — the same comparison `app.inbound_candidates` routes on. */
const last10 = (phone: string): string => String(phone ?? '').replace(/\D/g, '').slice(-10)

type Config = {
  phoneNumberId: string
  wabaId: string
  accessToken: string
  appSecret: string
  appId: string
  verifyToken: string
  senderPhone: string
}

function readConfig(): { config: Config; missing: string[] } {
  const get = (k: string) => String(process.env[k] ?? '').trim()
  const config: Config = {
    phoneNumberId: get('WHATSAPP_PHONE_NUMBER_ID'),
    wabaId: get('WHATSAPP_WABA_ID'),
    accessToken: get('WHATSAPP_ACCESS_TOKEN'),
    appSecret: get('WHATSAPP_APP_SECRET'),
    appId: get('WHATSAPP_APP_ID'),
    verifyToken: get('WHATSAPP_VERIFY_TOKEN'),
    senderPhone: get('WHATSAPP_SENDER_PHONE'),
  }
  const required: [keyof Config, string][] = [
    ['phoneNumberId', 'WHATSAPP_PHONE_NUMBER_ID'],
    ['wabaId', 'WHATSAPP_WABA_ID'],
    ['accessToken', 'WHATSAPP_ACCESS_TOKEN'],
    ['senderPhone', 'WHATSAPP_SENDER_PHONE'],
  ]
  return { config, missing: required.filter(([k]) => !config[k]).map(([, name]) => name) }
}

type SenderRow = {
  id: string
  phone_e164: string
  waba_id: string
  label: string | null
  credentials: Record<string, unknown> | null
}

async function readSenders(): Promise<SenderRow[]> {
  return withSession(BOOTSTRAP, async (tx) => {
    const rows = await tx<SenderRow[]>`
      select id, phone_e164, waba_id, label, credentials from sender order by created_at`
    return [...rows]
  })
}

async function readAcademies(): Promise<{ id: string; name: string; sender_id: string }[]> {
  // Two steps, and they cannot be one. `app.list_academies()` is security-definer,
  // so it answers across tenants from the bootstrap session — but `academy`'s own
  // cm_service policy is `id = app.academy_id()`, and with the GUC unset that
  // comparison is NULL, not false. Reading `sender_id` in the same session returns
  // no row and no error, which reads exactly like "this academy has no sender".
  // It said precisely that about a correctly-wired academy the first time this ran.
  // So the ids come from the function, and each row is then read from a session
  // pinned to it.
  const ids = await withSession(BOOTSTRAP, (tx) =>
    unsafeQuery<{ id: string; name: string }>(
      tx,
      'select id, name from app.list_academies() order by name',
      [],
    ),
  )

  const out: { id: string; name: string; sender_id: string }[] = []
  for (const a of ids) {
    const senderId = await withSession({ role: 'service', academyId: a.id }, async (tx) => {
      const s = await tx<{ sender_id: string }[]>`
        select sender_id from academy where id = ${a.id}::uuid`
      return String(s[0]?.sender_id ?? '')
    })
    out.push({ id: a.id, name: a.name, sender_id: senderId })
  }
  return out
}

// -----------------------------------------------------------------------------
// link — the database write that is the actual configuration
// -----------------------------------------------------------------------------

async function link(config: Config): Promise<void> {
  const credentials = {
    transport: 'cloud',
    phone_number_id: config.phoneNumberId,
    access_token: config.accessToken,
    ...(config.appSecret ? { app_secret: config.appSecret } : {}),
    waba_id: config.wabaId,
  }

  const senders = await readSenders()
  const match = senders.find((s) => last10(s.phone_e164) === last10(config.senderPhone))
  const target = match ?? (senders.length === 1 ? senders[0] : null)

  if (!target && senders.length > 1) {
    console.log(
      bad(
        `${senders.length} sender rows and none on ${config.senderPhone} — refusing to guess which one is the Cloud number.`,
      ),
    )
    for (const s of senders) console.log(info(`${s.phone_e164}  ${s.id}  ${s.label ?? ''}`))
    process.exitCode = 1
    return
  }

  const senderId = await withSession(BOOTSTRAP, async (tx) => {
    if (target) {
      // `$N::text::jsonb`, not `$N::jsonb` — the codebase's `jsonSafe` rule. Stored
      // as a jsonb *string*, `cacheSenderCredentials` reads a non-object, returns
      // early, and every send fails with "no credentials cached" while the row
      // looks perfectly populated in psql.
      await tx.unsafe(
        `update sender
            set phone_e164 = $2, waba_id = $3, credentials = $4::text::jsonb, label = $5
          where id = $1::uuid`,
        [
          target.id,
          config.senderPhone,
          config.wabaId,
          JSON.stringify(credentials),
          'Class Manager (Cloud test number)',
        ] as never[],
      )
      return target.id
    }
    const rows = await tx.unsafe(
      `insert into sender (phone_e164, waba_id, credentials, label)
       values ($1, $2, $3::text::jsonb, $4)
       returning id`,
      [
        config.senderPhone,
        config.wabaId,
        JSON.stringify(credentials),
        'Class Manager (Cloud test number)',
      ] as never[],
    )
    return String(rows[0].id)
  })

  console.log(ok(`sender ${config.senderPhone} → ${senderId}`))
  console.log(
    info(
      `credentials: phone_number_id=${config.phoneNumberId}, waba_id=${config.wabaId}, access_token=${config.accessToken.slice(0, 8)}…, app_secret=${config.appSecret ? 'set' : c.yellow('MISSING')}`,
    ),
  )

  // Every academy must point at this sender or its outbound goes nowhere and its
  // inbound resolves against a number that is not the one Meta delivered on.
  const academies = await readAcademies()
  let repointed = 0
  for (const a of academies) {
    if (a.sender_id === senderId) continue
    await withSession({ role: 'service', academyId: a.id }, async (tx) => {
      await tx`update academy set sender_id = ${senderId}::uuid where id = ${a.id}::uuid`
    })
    repointed++
  }
  if (academies.length === 0) {
    console.log(warn('no academies exist yet — seed or create one before testing'))
  } else {
    console.log(
      ok(
        `${academies.length} academ${academies.length === 1 ? 'y' : 'ies'} on this sender` +
          (repointed ? ` (${repointed} repointed)` : ''),
      ),
    )
  }

  // Orphan senders are not deleted: `academy.sender_id` is a FK and an old row may
  // still be referenced by a tenant this script cannot see. Naming them is enough.
  for (const s of senders) {
    if (s.id !== senderId) console.log(info(`other sender row left in place: ${s.phone_e164} (${s.id})`))
  }
}

// -----------------------------------------------------------------------------
// flows — create the three forms as Meta assets, upload their JSON, publish what
// can be published, and record the asset ids where the send path will find them.
//
// The ids go into `sender.credentials.flows`, beside the rest of the per-sender
// configuration (§16.3), because a Flow is a WABA asset and the credentials are
// the WABA's row. `resetWorld()` deletes senders, so this is re-run after a seed
// exactly as `link` is — and it is idempotent, matching existing flows by name.
// -----------------------------------------------------------------------------

async function provisionFlows(config: Config): Promise<void> {
  const existing = await listFlows(config.wabaId, config.accessToken)
  if (!existing.ok) {
    console.log(bad(existing.error))
    process.exitCode = 1
    return
  }
  const byName = new Map(existing.data.map((f) => [f.name ?? '', f]))
  const registry: FlowRegistry = {}
  let integrityBlocked = false

  for (const key of FORM_IDS) {
    const def = FLOWS[key]

    // Never upload JSON the local validator already rejects — `flows.ts` checks
    // the same rules Meta applies at publish, and finding out from a 400 costs a
    // round trip and reads worse.
    const problems = validateFlowJson(def.json)
    if (problems.length) {
      console.log(bad(`${key} — local validation failed: ${problems.join('; ')}`))
      process.exitCode = 1
      continue
    }

    let flowId = byName.get(def.name)?.id
    if (flowId) {
      console.log(info(`${key} — exists (${flowId})`))
    } else {
      const created = await createFlow(config.wabaId, config.accessToken, def.name, def.categories)
      if (!created.ok) {
        console.log(bad(`${key} — create failed: ${created.error}`))
        process.exitCode = 1
        continue
      }
      flowId = created.data.id
      console.log(ok(`${key} — created (${flowId})`))
    }

    const uploaded = await uploadFlowJson(flowId, config.accessToken, def.json)
    if (!uploaded.ok) {
      console.log(bad(`${key} — JSON upload failed: ${uploaded.error}`))
      process.exitCode = 1
      continue
    }
    console.log(ok(`${key} — JSON uploaded`))

    const status = byName.get(def.name)?.status
    if (status === 'PUBLISHED') {
      registry[key] = { id: flowId, published: true }
      console.log(ok(`${key} — already PUBLISHED`))
      continue
    }

    const published = await publishFlow(flowId, config.accessToken)
    if (published.ok) {
      registry[key] = { id: flowId, published: true }
      console.log(ok(`${key} — PUBLISHED`))
      continue
    }

    registry[key] = { id: flowId, published: false }
    if (isIntegrityBlock(published.error)) {
      integrityBlocked = true
      console.log(warn(`${key} — DRAFT (publishing blocked by business verification)`))
    } else {
      console.log(bad(`${key} — publish failed: ${published.error}`))
    }
  }

  if (Object.keys(registry).length === 0) {
    console.log(bad('nothing registered'))
    process.exitCode = 1
    return
  }

  // Merge, never overwrite: the row already holds the token and app secret, and
  // rewriting it wholesale from this command would drop them.
  const senders = await readSenders()
  const target = senders.find((s) => last10(s.phone_e164) === last10(config.senderPhone))
  if (!target) {
    console.log(bad(`no sender row on ${config.senderPhone} — run: npm run wa -- link`))
    process.exitCode = 1
    return
  }
  await withSession(BOOTSTRAP, async (tx) => {
    await tx.unsafe(
      `update sender set credentials = credentials || $2::text::jsonb where id = $1::uuid`,
      [target.id, JSON.stringify({ flows: registry })] as never[],
    )
  })
  console.log(ok(`registered ${Object.keys(registry).length} flow ids on sender ${target.phone_e164}`))

  if (integrityBlocked) {
    console.log()
    console.log(warn('Publishing is gated on Meta Business Verification — "Blocked by Integrity" (139000/4233020).'))
    console.log(info('Created and uploaded are unaffected; the flows exist and are sendable as DRAFT to a test number.'))
    console.log(info('Verify the business portfolio, then re-run this command to publish them.'))
  }
}

// -----------------------------------------------------------------------------
// admin — put a real human, on a real handset, into a tenant
//
// Testing against a real number needs one contact whose `phone_e164` is a phone
// someone is holding. Without it the first inbound lands as a *prospect*: it
// resolves (one academy on the sender, so `resolveInbound` creates one) but it
// arrives as a stranger, sees none of the admin surface, and `app.is_admin()` is
// false for every question it asks. That reads as "the product ignored me"
// rather than "you are not who you thought you were".
//
// Idempotent on the number: run it again after a seed, or to promote a contact
// that already exists.
// -----------------------------------------------------------------------------

async function makeAdmin(phoneE164: string, name: string, academyName?: string): Promise<void> {
  const academies = await readAcademies()
  if (academies.length === 0) {
    console.log(bad('no academies exist — create one before adding an admin to it'))
    process.exitCode = 1
    return
  }
  const target = academyName
    ? academies.find((a) => a.name.toLowerCase() === academyName.toLowerCase())
    : academies.length === 1
      ? academies[0]
      : null
  if (!target) {
    console.log(
      bad(
        academyName
          ? `no academy named "${academyName}" — have: ${academies.map((a) => a.name).join(', ')}`
          : `${academies.length} academies — name one: npm run wa -- admin <phone> <name> <academy>`,
      ),
    )
    process.exitCode = 1
    return
  }

  const ctx: SessionCtx = { role: 'service', academyId: target.id }
  const result = await withSession(ctx, async (tx) => {
    // Matched on the last ten digits, the same way `app.inbound_candidates` will
    // match it when the message actually arrives — so "already there" here means
    // the same thing as "routes to this contact" there.
    const existing = await tx<{ contact_id: string; person_id: string; full_name: string; phone_e164: string }[]>`
      select c.id as contact_id, c.person_id, p.full_name, c.phone_e164
        from contact c join person p on p.id = c.person_id
       where c.academy_id = ${target.id}::uuid
         and nullif(right(regexp_replace(c.phone_e164, '[^0-9]', '', 'g'), 10), '')
           = ${last10(phoneE164)}
       limit 1`

    let personId: string
    let created: 'contact' | 'promoted' | 'already'
    if (existing.length > 0) {
      personId = String(existing[0].person_id)
      created = 'promoted'
      // The number is what has to be right; leave the name alone unless it was
      // never set, because a real roster name outranks whatever was typed here.
      await tx`
        update contact
           set phone_e164 = ${phoneE164},
               wa_id = ${phoneE164.replace(/\D/g, '')},
               role_hint = 'admin',
               is_primary = true
         where id = ${existing[0].contact_id}::uuid`
    } else {
      const p = await tx<{ id: string }[]>`
        insert into person (academy_id, full_name) values (${target.id}::uuid, ${name})
        returning id`
      personId = String(p[0].id)
      created = 'contact'
      // `registered`, not `engaged` — `engaged` is earned by messaging in, and
      // this contact has not yet. The first real inbound is what promotes it.
      await tx`
        insert into contact (academy_id, person_id, phone_e164, wa_id, state, role_hint, is_primary)
        values (${target.id}::uuid, ${personId}::uuid, ${phoneE164},
                ${phoneE164.replace(/\D/g, '')}, 'registered', 'admin', true)`
    }

    const already = await tx`
      select 1 from academy_admin
       where academy_id = ${target.id}::uuid and person_id = ${personId}::uuid`
    if (already.length === 0) {
      await tx`
        insert into academy_admin (academy_id, person_id)
        values (${target.id}::uuid, ${personId}::uuid)`
    } else if (created === 'promoted') {
      created = 'already'
    }
    return { created, personId, existingName: existing[0]?.full_name, wasPhone: existing[0]?.phone_e164 }
  })

  const who = result.existingName ?? name
  console.log(ok(`${who} · ${phoneE164} · admin of "${target.name}"`))
  if (result.created === 'promoted' && result.wasPhone !== phoneE164) {
    console.log(info(`existing contact "${who}" moved from ${result.wasPhone} to ${phoneE164}`))
  }
  if (result.created === 'already') console.log(info('was already an admin — number and role re-asserted'))

  // Naming the other admins matters: they are on unreachable placeholder numbers,
  // and an escalation that fans out to "the admins" will try to message them.
  const others = await withSession(ctx, async (tx) => {
    const rows = await tx<{ full_name: string; phone_e164: string }[]>`
      select p.full_name, c.phone_e164
        from academy_admin aa
        join person p on p.id = aa.person_id
        join contact c on c.person_id = p.id and c.academy_id = aa.academy_id
       where aa.academy_id = ${target.id}::uuid and aa.person_id <> ${result.personId}::uuid`
    return [...rows]
  })
  for (const o of others) {
    console.log(info(`other admin on this academy: ${o.full_name} (${o.phone_e164}) — not a reachable handset`))
  }
}

// -----------------------------------------------------------------------------
// status — every precondition between here and a message on a handset
// -----------------------------------------------------------------------------

async function status(config: Config, missing: string[]): Promise<void> {
  heading('environment')
  if (missing.length) {
    for (const m of missing) console.log(bad(`${m} is not set in .env.local`))
  } else {
    console.log(ok('WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_WABA_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_SENDER_PHONE'))
  }
  console.log(
    config.appSecret
      ? ok('WHATSAPP_APP_SECRET — inbound webhook signatures verifiable')
      : bad('WHATSAPP_APP_SECRET is not set — POST /api/webhook fails closed with 401 on every event'),
  )
  console.log(
    config.verifyToken
      ? ok(`WHATSAPP_VERIFY_TOKEN = ${config.verifyToken}`)
      : bad('WHATSAPP_VERIFY_TOKEN is not set — the webhook GET handshake returns 403'),
  )
  const transport = String(process.env.TRANSPORT ?? '')
  console.log(
    transport === 'cloud'
      ? ok('TRANSPORT=cloud — sends go to Meta')
      : warn(`TRANSPORT=${transport || 'unset'} — sends stay in the emulator; flip to "cloud" when ready`),
  )
  console.log(info(`APP_BASE_URL = ${process.env.APP_BASE_URL ?? '(unset)'}`))

  if (missing.length) {
    console.log(`\n${c.yellow('stopping here — the Graph checks need the keys above.')}`)
    return
  }

  heading('token')
  const dbg = await debugToken(config.accessToken)
  if (!dbg.ok) {
    console.log(bad(dbg.error))
  } else {
    const d = dbg.data.data ?? {}
    console.log(d.is_valid ? ok(`valid · type=${d.type ?? '?'} · app=${d.app_id ?? '?'}`) : bad('token is not valid'))
    if (d.expires_at === 0) {
      console.log(ok('never expires (system-user token)'))
    } else if (d.expires_at) {
      const at = new Date(d.expires_at * 1000)
      const hours = (at.getTime() - Date.now()) / 3_600_000
      const line = `expires ${at.toISOString()} (${hours.toFixed(1)}h from now)`
      console.log(hours < 48 ? warn(`${line} — a dashboard token; swap for a system-user token to test past today`) : info(line))
    }
    if (d.scopes?.length) {
      const need = ['whatsapp_business_messaging', 'whatsapp_business_management']
      for (const s of need) {
        console.log(d.scopes.includes(s) ? ok(`scope ${s}`) : bad(`scope ${s} is MISSING`))
      }
    }
  }

  heading('number')
  const num = await describePhoneNumber(config.phoneNumberId, config.accessToken)
  if (!num.ok) {
    console.log(bad(num.error))
  } else {
    console.log(ok(`${num.data.display_phone_number ?? '?'} · "${num.data.verified_name ?? '?'}"`))
    console.log(info(`quality=${num.data.quality_rating ?? '?'} · throughput=${num.data.throughput?.level ?? '?'}`))
    const declared = last10(config.senderPhone)
    const actual = last10(num.data.display_phone_number ?? '')
    console.log(
      declared === actual
        ? ok(`WHATSAPP_SENDER_PHONE matches the display number on its last 10 digits (${actual})`)
        : bad(
            `WHATSAPP_SENDER_PHONE=${config.senderPhone} (…${declared}) does NOT match the display number …${actual} — inbound will not route`,
          ),
    )
  }

  heading('webhook')
  let webhookRegistered = false
  if (config.appSecret && config.appId) {
    const hook = await readWebhookConfig(config.appId, config.appSecret)
    if (!hook.ok) {
      console.log(bad(hook.error))
    } else if (hook.data.length === 0) {
      console.log(bad('no callback URL registered — run: npm run wa -- webhook https://<public-host>'))
    } else {
      for (const s of hook.data) {
        console.log(s.active ? ok(`${s.object}: ${s.callback_url}`) : warn(`${s.object}: ${s.callback_url} · INACTIVE`))
      }
      webhookRegistered = hook.data.some((s) => s.active)
    }
  } else {
    console.log(warn('cannot read the callback URL without WHATSAPP_APP_SECRET + WHATSAPP_APP_ID'))
  }

  const subs = await listSubscribedApps(config.wabaId, config.accessToken)
  if (!subs.ok) {
    console.log(bad(subs.error))
  } else if (subs.data.length === 0) {
    console.log(bad('no app subscribed to this WABA — webhooks will never fire. Run: npm run wa -- subscribe'))
  } else {
    // A non-empty list is NOT the check. A fresh test WABA already has Meta's own
    // "WA DevX Webhook Events 1P App" subscribed, which makes this section read
    // green while OUR app receives nothing — the delivery status for a message
    // the API had already accepted never arrived, and every box looked ticked.
    // The question is whether `WHATSAPP_APP_ID` is in the list, not whether the
    // list has anything in it.
    const mine = subs.data.some((s) => String(s.whatsapp_business_api_data?.id ?? '') === config.appId)
    for (const s of subs.data) {
      const id = String(s.whatsapp_business_api_data?.id ?? '?')
      const label = `${s.whatsapp_business_api_data?.name ?? '?'} (${id})`
      console.log(id === config.appId ? ok(`subscribed: ${label} — this app`) : info(`subscribed: ${label}`))
    }
    if (!mine) {
      console.log(
        bad(
          `this app (${config.appId || 'WHATSAPP_APP_ID unset'}) is NOT subscribed — webhooks go elsewhere. Run: npm run wa -- subscribe`,
        ),
      )
    }
  }

  heading('templates')
  const remote = await listTemplates(config.wabaId, config.accessToken)
  if (!remote.ok) {
    console.log(bad(remote.error))
  } else {
    const byKey = new Map(remote.data.map((t) => [`${t.name}::${t.language}`, t]))
    let approved = 0
    for (const name of TEMPLATE_NAMES) {
      const def = TEMPLATES[name]
      const t = byKey.get(`${def.name}::${def.language}`)
      if (!t) {
        console.log(bad(`${name} (${def.language}) — not created`))
        continue
      }
      const label = `${name} (${def.language}) — ${t.status}${t.category ? ` · ${t.category}` : ''}`
      // Category is checked separately from status, and an APPROVED template in
      // the wrong one is worse than a PENDING one. Meta decides the category from
      // how the text reads and overrules the submission silently — `coach_schedule`
      // went up UTILITY and came back MARKETING, which re-prices it and raises the
      // block risk on a shared number (§16.1). Green here must mean both.
      const wrongCategory = Boolean(t.category && t.category.toUpperCase() !== def.category.toUpperCase())
      if (t.status === 'APPROVED' && !wrongCategory) approved++
      if (wrongCategory) {
        console.log(bad(`${label} — submitted as ${def.category.toUpperCase()}, Meta returned ${t.category}`))
        console.log(info(`  reword it and: npm run wa -- templates:replace ${name}`))
      } else {
        console.log(t.status === 'APPROVED' ? ok(label) : warn(label))
      }
    }
    console.log(
      approved === TEMPLATE_NAMES.length
        ? ok(`all ${TEMPLATE_NAMES.length} approved — out-of-window sends will work`)
        : warn(`${approved}/${TEMPLATE_NAMES.length} approved — out-of-window sends fail until the rest are`),
    )
    const others = remote.data.filter((t) => !TEMPLATE_NAMES.includes(t.name as never))
    if (others.length) console.log(info(`also on this WABA: ${others.map((t) => t.name).join(', ')}`))
  }

  heading('flows')
  const flows = await listFlows(config.wabaId, config.accessToken)
  if (!flows.ok) {
    console.log(bad(flows.error))
  } else {
    const byName = new Map(flows.data.map((f) => [f.name ?? '', f]))
    for (const key of FORM_IDS) {
      const def = FLOWS[key]
      const f = byName.get(def.name)
      if (!f) {
        console.log(bad(`${key} ("${def.name}") — not created. Run: npm run wa -- flows`))
        continue
      }
      const line = `${key} — ${f.status ?? '?'} (${f.id})`
      console.log(f.status === 'PUBLISHED' ? ok(line) : warn(`${line} — sendable only as draft, to a test number`))
    }
  }

  heading('database')
  const senders = await readSenders()
  if (senders.length === 0) {
    console.log(bad('no sender row — run: npm run wa -- link'))
  }
  for (const s of senders) {
    const creds = (s.credentials ?? {}) as Record<string, unknown>
    const isCloud = typeof creds.phone_number_id === 'string' && typeof creds.access_token === 'string'
    const isThis = String(creds.phone_number_id ?? '') === config.phoneNumberId
    const line = `${s.phone_e164} · waba=${s.waba_id} · ${s.label ?? 'no label'}`
    console.log(isCloud && isThis ? ok(line) : warn(line))
    console.log(
      isCloud
        ? info(`  credentials: phone_number_id=${String(creds.phone_number_id)}, access_token=${String(creds.access_token).slice(0, 8)}…, app_secret=${creds.app_secret ? 'set' : 'absent'}`)
        : bad('  credentials are not a Cloud pair — cacheSenderCredentials will skip this row and every send fails'),
    )
    if (isCloud && !isThis) {
      console.log(warn(`  points at phone_number_id ${String(creds.phone_number_id)}, not ${config.phoneNumberId} — re-run link`))
    }
    const stale =
      isCloud && typeof creds.access_token === 'string' && creds.access_token !== config.accessToken
    if (stale) console.log(warn('  the stored token differs from WHATSAPP_ACCESS_TOKEN — re-run link'))
  }

  const academies = await readAcademies()
  if (academies.length === 0) {
    console.log(bad('no academies — nothing to route an inbound message to'))
  } else {
    for (const a of academies) {
      const s = senders.find((x) => x.id === a.sender_id)
      console.log(
        s ? ok(`academy "${a.name}" → sender ${s.phone_e164}`) : bad(`academy "${a.name}" → sender ${a.sender_id} (missing)`),
      )
    }
    console.log(
      academies.length === 1
        ? ok('exactly one academy on this number — an unknown inbound number auto-resolves as a prospect')
        : warn(
            `${academies.length} academies share this number — an unknown inbound number returns "unresolved" until it names one (§10.1)`,
          ),
    )
  }

  // Every line here is conditional on a check above. A hardcoded reminder that
  // stays on the list after it has been done makes the whole section noise, and
  // this one contradicted the green ticks directly above it.
  heading('what is still needed')
  const todo: string[] = []
  if (!config.appSecret) todo.push('WHATSAPP_APP_SECRET in .env.local (Meta → App settings → Basic → App secret)')
  if (!config.appId) todo.push('WHATSAPP_APP_ID in .env.local — needed to read or set the callback URL')
  if (!config.verifyToken) todo.push('WHATSAPP_VERIFY_TOKEN in .env.local (any string; paste the same one into Meta)')
  if (subs.ok && !subs.data.some((s) => String(s.whatsapp_business_api_data?.id ?? '') === config.appId)) {
    todo.push('npm run wa -- subscribe — this app is not on the WABA, so webhooks go elsewhere')
  }
  if (senders.length === 0) todo.push('npm run wa -- link')
  if (!webhookRegistered) {
    todo.push('a public HTTPS tunnel to localhost:3000, then: npm run wa -- webhook https://<host>')
  }
  if (transport !== 'cloud') todo.push('TRANSPORT=cloud in .env.local, then restart the dev server')

  if (todo.length === 0) {
    console.log(ok('nothing — the wire is configured end to end.'))
    // Not machine-checkable: Meta exposes no endpoint for a test number's
    // recipient allowlist, so this is stated rather than verified.
    console.log(info('unverifiable from here: the recipient must be on the test number\'s allowlist to receive anything'))
  }
  for (const t of todo) console.log(`  ${c.cyan('→')} ${t}`)
}

// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0] ?? 'status'
  const { config, missing } = readConfig()

  const needsGraph = ['subscribe', 'templates', 'templates:replace', 'flows', 'send-test'].includes(command)
  if (needsGraph && missing.length && command !== 'templates:preview') {
    console.log(bad(`missing ${missing.join(', ')} in .env.local`))
    process.exitCode = 1
    return
  }

  switch (command) {
    case 'status':
      await status(config, missing)
      break

    case 'link':
      if (missing.length) {
        console.log(bad(`missing ${missing.join(', ')} in .env.local`))
        process.exitCode = 1
        break
      }
      await link(config)
      break

    case 'subscribe': {
      const r = await subscribeApp(config.wabaId, config.accessToken)
      console.log(r.ok ? ok(`subscribed to WABA ${config.wabaId}`) : bad(r.error))
      if (!r.ok) process.exitCode = 1
      break
    }

    case 'templates': {
      const r = await provisionTemplates(config.wabaId, config.accessToken)
      if (r.error) {
        console.log(bad(r.error))
        process.exitCode = 1
        break
      }
      for (const t of r.results) {
        const line = `${t.template} — ${t.outcome}${t.status ? ` · ${t.status}` : ''}${t.error ? ` · ${t.error}` : ''}`
        console.log(t.outcome === 'failed' ? bad(line) : t.outcome === 'exists' ? info(line) : ok(line))
        const hint = categoryHoldHint(t.error)
        if (hint) console.log(info(`  ${hint}`))
      }
      if (!r.ok) process.exitCode = 1
      break
    }

    // `templates:replace <name…>` — delete and resubmit. The only remedy for a
    // template Meta returned in the wrong category, since approved text is frozen
    // and no edit changes a category.
    case 'templates:replace': {
      const names = argv.slice(1).filter((n): n is TemplateName => TEMPLATE_NAMES.includes(n as TemplateName))
      if (names.length === 0) {
        console.log(bad(`usage: npm run wa -- templates:replace ${TEMPLATE_NAMES.join('|')}`))
        process.exitCode = 1
        break
      }
      for (const name of names) {
        const d = await deleteTemplate(config.wabaId, config.accessToken, name)
        console.log(d.ok ? info(`deleted ${name}`) : bad(`delete ${name}: ${d.error}`))
      }

      // A delete does not take effect immediately, and resubmitting into that
      // window fails with subcode 2388025: "You can't change the category for this
      // message template while the existing English content is being deleted. Try
      // again in less than 1 minute or use MARKETING as the category." Taking the
      // second suggestion would keep the very category this command exists to get
      // rid of, so the answer is to wait rather than to accept MARKETING.
      let results = await provisionTemplates(config.wabaId, config.accessToken, names)
      for (let attempt = 1; attempt <= 5; attempt++) {
        const stuck = results.results.filter((t) => t.outcome === 'failed' && t.error?.includes('2388025'))
        if (stuck.length === 0) break
        console.log(info(`delete still propagating for ${stuck.map((t) => t.template).join(', ')} — retrying in 20s (${attempt}/5)`))
        await new Promise((r) => setTimeout(r, 20_000))
        const retry = await provisionTemplates(
          config.wabaId,
          config.accessToken,
          stuck.map((t) => t.template),
        )
        results = {
          ok: retry.ok && results.results.filter((t) => !stuck.some((s) => s.template === t.template)).every((t) => t.outcome !== 'failed'),
          results: results.results
            .filter((t) => !stuck.some((s) => s.template === t.template))
            .concat(retry.results),
        }
      }

      for (const t of results.results) {
        const line = `${t.template} — ${t.outcome}${t.status ? ` · ${t.status}` : ''}${t.error ? ` · ${t.error}` : ''}`
        console.log(t.outcome === 'failed' ? bad(line) : ok(line))
        const hint = categoryHoldHint(t.error)
        if (hint) console.log(info(`  ${hint}`))
      }
      if (!results.ok) process.exitCode = 1
      break
    }

    // The exact JSON that would be submitted, without submitting it. An approval is
    // hard to take back — the text is frozen and a re-submission is a new review —
    // so there is a way to read it first.
    case 'templates:preview': {
      for (const name of TEMPLATE_NAMES) {
        console.log(`\n${c.bold(name)}`)
        console.log(JSON.stringify(templateSubmission(TEMPLATES[name]), null, 2))
      }
      break
    }

    // `webhook <public-base-url>` — register the callback URL without touching the
    // dashboard. A quick tunnel's hostname changes every restart, so this is run
    // again each time the tunnel comes up, not once at setup.
    case 'webhook': {
      const base = argv[1] ?? String(process.env.WHATSAPP_CALLBACK_BASE ?? '')
      if (!base) {
        console.log(bad('usage: npm run wa -- webhook https://<public-host>'))
        process.exitCode = 1
        break
      }
      if (!config.appSecret || !config.appId) {
        console.log(bad('WHATSAPP_APP_SECRET and WHATSAPP_APP_ID are both required — Meta refuses this endpoint to a user token'))
        process.exitCode = 1
        break
      }
      if (!config.verifyToken) {
        console.log(bad('WHATSAPP_VERIFY_TOKEN is not set — Meta calls the URL to check it before accepting'))
        process.exitCode = 1
        break
      }
      const callback = `${base.replace(/\/+$/, '')}/api/webhook`
      const r = await configureWebhook(config.appId, config.appSecret, callback, config.verifyToken)
      if (!r.ok) {
        console.log(bad(r.error))
        console.log(info('Meta calls the URL with hub.challenge before accepting it — check the tunnel is up and the dev server is running'))
        process.exitCode = 1
        break
      }
      console.log(ok(`callback URL → ${callback}`))
      const now = await readWebhookConfig(config.appId, config.appSecret)
      if (now.ok) {
        for (const s of now.data) {
          console.log(info(`${s.object}: ${s.callback_url} · active=${s.active}`))
        }
      }
      break
    }

    case 'flows':
      await provisionFlows(config)
      break

    case 'admin': {
      const [, phone, name, academy] = argv
      if (!phone || !name) {
        console.log(bad('usage: npm run wa -- admin +918904506670 "Your Name" [academy]'))
        process.exitCode = 1
        break
      }
      await makeAdmin(phone, name, academy)
      break
    }

    case 'send-test': {
      const to = argv[1]
      if (!to) {
        console.log(bad('usage: npm run wa -- send-test +919876543210'))
        process.exitCode = 1
        break
      }
      const r = await sendHelloWorld(config.phoneNumberId, config.accessToken, to)
      if (r.ok) {
        console.log(ok(`hello_world → ${to} · wa id ${r.data.messages?.[0]?.id ?? '?'}`))
        console.log(info('if it does not arrive, the number is not on the test number\'s recipient list'))
      } else {
        console.log(bad(r.error))
        process.exitCode = 1
      }
      break
    }

    default:
      console.log(`unknown command: ${command}`)
      console.log(
        '  status | link | subscribe | webhook <url> | templates | templates:replace <name…> |\n' +
          '  templates:preview | flows | admin <phone> <name> | send-test <phone>',
      )
      process.exitCode = 1
  }
}

main()
  .catch((e: unknown) => {
    console.error(bad(e instanceof Error ? e.message : String(e)))
    process.exitCode = 1
  })
  .finally(() => closePool())

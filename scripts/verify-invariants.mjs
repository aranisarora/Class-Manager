// Targeted checks on the invariants that are the whole point of the design.
import { opsCookie } from './ops-cookie.mjs'

const BASE = 'http://localhost:3000'
const j = async (p, init) => {
  // `/api/emulator/*` is behind the ops cookie; one login covers the whole run.
  const r = await fetch(BASE + p, { ...init, headers: { 'content-type': 'application/json', cookie: await opsCookie(BASE), ...(init?.headers ?? {}) } })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { raw: t.slice(0, 300) } }
}
const line = (s) => console.log('\n' + '─'.repeat(74) + '\n' + s)

// ── §18 · the two suppression rules ────────────────────────────────────────
// Nadam Vocal is one person who is both admin and coach. Nothing may ask her to
// confirm something to herself, and no escalation about her may reach her.
line("§18 · solo case — advance a day and see what the send path refuses to send")
let clock = await j('/api/emulator/clock', { method: 'POST', body: JSON.stringify({ advanceMs: 26 * 3600 * 1000 }) })
console.log('now      ', clock.clock?.nowIso)
console.log('jobs     ', `ran=${clock.jobs?.ran} skipped=${clock.jobs?.skipped} failed=${clock.jobs?.failed}`)

const sup = await j('/api/emulator/events?limit=400')
const suppressed = (sup.events ?? []).filter((e) => e.suppressedReason || e.suppressed_reason)
console.log('suppressed sends:', suppressed.length)
const tally = {}
for (const e of suppressed) {
  const k = e.suppressedReason ?? e.suppressed_reason
  tally[k] = (tally[k] ?? 0) + 1
}
for (const [k, n] of Object.entries(tally)) console.log(`   ${k}: ${n}`)

// ── §2.2 · a tap executes with no model call ───────────────────────────────
line('§2.2 · mint once, replay verbatim — a button tap must not touch the model')
const state = await j('/api/emulator/state')
const contacts = state.contacts ?? []
let found = null
for (const c of contacts) {
  const t = await j(`/api/emulator/thread?contactId=${c.id}`)
  for (const m of (t.messages ?? []).slice().reverse()) {
    const btns = m.buttons ?? m.payload?.buttons ?? []
    const live = btns.find((b) => b.actionId && !b.consumedAt && !b.expired)
    if (live) { found = { contact: c, message: m, button: live }; break }
  }
  if (found) break
}

if (!found) {
  console.log('  no live button found in any thread — skipping')
} else {
  console.log(`  contact  ${found.contact.name} (${found.contact.roles.join('+')})`)
  console.log(`  message  "${String(found.message.body ?? '').slice(0, 90)}"`)
  console.log(`  tapping  [${found.button.title}]  action=${found.button.actionId}`)
  const before = await j('/api/emulator/events?limit=1')
  const t0 = Date.now()
  const tap = await j('/api/emulator/inbound', {
    method: 'POST',
    body: JSON.stringify({ contactId: found.contact.id, actionId: found.button.actionId }),
  })
  const ms = Date.now() - t0
  console.log(`  result   ${tap.ok ? 'ok' : 'FAILED'} in ${ms}ms  (a model round trip is 20 000ms+; this is the tell)`)
  console.log(`  sent     ${JSON.stringify(tap.turn?.sent ?? []).slice(0, 200)}`)
  console.log(`  tools    ${tap.turn?.toolCalls ?? 0}`)

  // Replay the same action: it must refuse, because it is already consumed.
  const again = await j('/api/emulator/inbound', {
    method: 'POST',
    body: JSON.stringify({ contactId: found.contact.id, actionId: found.button.actionId }),
  })
  const thread = await j(`/api/emulator/thread?contactId=${found.contact.id}`)
  const last = (thread.messages ?? []).slice(-1)[0]
  console.log(`  replay   ${again.ok ? 'accepted' : 'refused'} — bot said: "${String(last?.body ?? '').slice(0, 120)}"`)
}

// ── §2.4 · queued ≠ sent ≠ delivered ≠ read ────────────────────────────────
line('§2.4 · sending is not receiving')
const anyContact = contacts.find((c) => c.messageCount > 0) ?? contacts[0]
const th = await j(`/api/emulator/thread?contactId=${anyContact.id}`)
const out = (th.messages ?? []).filter((m) => m.direction === 'outbound').slice(-1)[0]
if (out) {
  console.log(`  before   status=${out.status} delivered=${out.deliveredAt ?? out.delivered_at ?? null} read=${out.readAt ?? out.read_at ?? null}`)
  await j('/api/emulator/read', { method: 'POST', body: JSON.stringify({ messageId: out.id, status: 'delivered' }) })
  await j('/api/emulator/read', { method: 'POST', body: JSON.stringify({ messageId: out.id, status: 'read' }) })
  const th2 = await j(`/api/emulator/thread?contactId=${anyContact.id}`)
  const out2 = (th2.messages ?? []).find((m) => m.id === out.id)
  console.log(`  after    status=${out2?.status} delivered=${!!(out2?.deliveredAt ?? out2?.delivered_at)} read=${!!(out2?.readAt ?? out2?.read_at)}`)
}

// ── §16.1 · one number, many academies ─────────────────────────────────────
line('§16 · one sender, two tenants')
console.log('  sender  ', JSON.stringify(state.sender))
console.log('  tenants ', (state.academies ?? []).map((a) => `${a.name} [solo=${a.isSolo}]`).join('  ·  '))

console.log('\ndone')

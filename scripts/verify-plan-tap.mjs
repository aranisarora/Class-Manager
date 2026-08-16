// The one flow that exercises §2.2, §2.3, §2.5 and §14.2.1 at once:
// ask for a destructive change -> see the diff before commit -> tap -> it commits
// with no model call, and only then does anybody get messaged.
import { opsCookie } from './ops-cookie.mjs'

const BASE = 'http://localhost:3000'
const j = async (p, init) => {
  // `/api/emulator/*` is behind the ops cookie; one login covers the whole run.
  const r = await fetch(BASE + p, { ...init, headers: { 'content-type': 'application/json', cookie: await opsCookie(BASE), ...(init?.headers ?? {}) } })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { raw: t.slice(0, 400) } }
}
const line = (s) => console.log('\n' + '─'.repeat(74) + '\n' + s)

const state = await j('/api/emulator/state')
const admin = state.contacts.find((c) => c.roles.includes('admin') && c.academyName === 'Ace TT Academy')

line('1 · admin asks for something destructive')
let t0 = Date.now()
await j('/api/emulator/inbound', {
  method: 'POST',
  body: JSON.stringify({ contactId: admin.id, text: 'cancel this saturday advanced — the hall is double booked' }),
})
console.log(`   ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const th = await j(`/api/emulator/thread?contactId=${admin.id}`)
const last = (th.messages ?? []).filter((m) => m.direction === 'outbound').slice(-1)[0]
console.log('\n   bot:', String(last?.body ?? '').replace(/\n/g, '\n        ').slice(0, 500))
const buttons = last?.buttons ?? last?.payload?.buttons ?? []
console.log('   buttons:', buttons.length ? buttons.map((b) => `[${b.title}]`).join(' ') : 'NONE')

const doIt = buttons.find((b) => /do it|confirm|^yes|go ahead/i.test(b.title))
if (!doIt) {
  console.log('\n   no confirm button — stopping here')
  process.exit(0)
}

// What is true before the tap: nothing committed, nobody messaged.
const before = await j('/api/emulator/state')
const beforeSessions = before.academies.find((a) => a.name === 'Ace TT Academy').upcoming ?? []
const beforeCancelled = beforeSessions.filter((s) => s.status === 'cancelled').length
console.log(`\n   before tap: ${beforeCancelled} cancelled session(s) upcoming`)

line('2 · tap the confirm button — no model call, stored payload replayed verbatim (§2.2)')
t0 = Date.now()
const tap = await j('/api/emulator/inbound', {
  method: 'POST',
  body: JSON.stringify({ contactId: admin.id, actionId: doIt.actionId }),
})
const ms = Date.now() - t0
console.log(`   ${ms}ms   toolCalls=${tap.turn?.toolCalls ?? 0}   (a model round trip is 20 000ms+)`)
console.log(`   sent  ${(tap.turn?.sent ?? []).length} message(s)`)

const after = await j('/api/emulator/state')
const afterSessions = after.academies.find((a) => a.name === 'Ace TT Academy').upcoming ?? []
const afterCancelled = afterSessions.filter((s) => s.status === 'cancelled').length
console.log(`   after tap:  ${afterCancelled} cancelled session(s) upcoming`)

line('3 · who actually heard about it (§2.5 — staged until commit)')
for (const c of after.contacts.filter((x) => x.academyName === 'Ace TT Academy')) {
  const t = await j(`/api/emulator/thread?contactId=${c.id}`)
  const m = (t.messages ?? []).filter((x) => x.direction === 'outbound').slice(-1)[0]
  if (m && /cancel/i.test(String(m.body ?? ''))) {
    const tag = m.inWindow ?? m.in_window ? 'in-window' : `TEMPLATE ${m.templateName ?? m.template_name ?? '?'}`
    console.log(`   → ${String(c.name).padEnd(18)} ${String(c.roles.join('+')).padEnd(16)} [${tag}]  "${String(m.body).replace(/\n/g, ' ').slice(0, 88)}"`)
  }
}

line('4 · replaying the same tap must refuse (§2.2 — consumed once)')
const again = await j('/api/emulator/inbound', {
  method: 'POST',
  body: JSON.stringify({ contactId: admin.id, actionId: doIt.actionId }),
})
const th2 = await j(`/api/emulator/thread?contactId=${admin.id}`)
const l2 = (th2.messages ?? []).slice(-1)[0]
console.log(`   ${again.ok ? 'accepted' : 'refused'} — bot said: "${String(l2?.body ?? '').slice(0, 130)}"`)

console.log('\ndone')

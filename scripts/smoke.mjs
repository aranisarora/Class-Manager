// End-to-end smoke: the real inbound path -> identity -> agent -> send path -> emulator.
const BASE = 'http://localhost:3000'

const j = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await r.text()
  try {
    return { status: r.status, body: JSON.parse(text) }
  } catch {
    return { status: r.status, body: text.slice(0, 400) }
  }
}

const line = (s) => console.log('\n' + '─'.repeat(76) + '\n' + s)

// 1 — the world
line('1 · GET /api/emulator/state')
const state = await j('/api/emulator/state')
if (state.status !== 200) {
  console.log('FAILED', state.status, state.body)
  process.exit(1)
}
const s = state.body
console.log('clock    ', s.clock?.nowIso ?? s.clock?.now ?? JSON.stringify(s.clock).slice(0, 120))
console.log('academies', (s.academies ?? []).map((a) => `${a.name} (${a.counts?.contacts ?? a.contacts?.length} contacts, ${a.counts?.sessions} sessions)`).join(' · '))
const contacts = s.contacts ?? []
console.log('contacts ', contacts.length)

const pick = (pred) => contacts.find(pred)
const sharwin = pick((c) => c.roles?.includes('admin') && c.academyName === 'Ace TT Academy')
const arjun = pick((c) => c.roles?.includes('coach') && !c.roles?.includes('admin') && c.academyName === 'Ace TT Academy')
const lakshmi = pick((c) => c.roles?.includes('admin') && c.academyName === 'Nadam Vocal')
const parent = pick((c) => c.roles?.includes('account_holder') && !c.roles?.includes('admin') && c.academyName === 'Ace TT Academy')

console.log('admin    ', sharwin?.name, sharwin?.phone)
console.log('coach    ', arjun?.name, arjun?.phone)
console.log('solo     ', lakshmi?.name, '(admin+coach)', lakshmi?.roles?.join('+'))
console.log('parent   ', parent?.name)

const thread = async (contactId) => {
  const t = await j(`/api/emulator/thread?contactId=${contactId}`)
  return t.body?.messages ?? []
}

const show = (msgs, n = 4) => {
  for (const m of msgs.slice(-n)) {
    const dir = m.direction === 'inbound' ? '  >' : '  <'
    const tag = m.direction === 'outbound' ? `[${m.in_window ? 'in-window' : 'TEMPLATE ' + (m.template_name ?? '?')}${m.cost_paise ? ' ' + m.cost_paise + 'p' : ''}${m.catalog_id ? ' ' + m.catalog_id : ''}${m.suppressed_reason ? ' SUPPRESSED:' + m.suppressed_reason : ''}]` : ''
    console.log(`${dir} ${String(m.body ?? '').replace(/\n/g, '\n     ').slice(0, 420)} ${tag}`)
    const btns = m.payload?.buttons ?? m.payload?.action?.buttons ?? []
    if (btns.length) console.log('     buttons: ' + btns.map((b) => `[${b.title}]`).join(' '))
    if (m.payload?.list) console.log('     list: ' + JSON.stringify(m.payload.list).slice(0, 200))
  }
}

// 2 — an admin asks a real question. Exercises identity -> prompt -> model -> read tool -> lint -> send.
line('2 · POST /api/emulator/inbound  (admin, natural language read)')
let t0 = Date.now()
let r = await j('/api/emulator/inbound', {
  method: 'POST',
  body: JSON.stringify({ contactId: sharwin.id, text: 'how many players do we have, and who has not paid for August?' }),
})
console.log('status', r.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`, 'toolCalls=' + (r.body?.turn?.toolCalls ?? r.body?.toolCalls ?? '?'), r.body?.error ? 'ERROR: ' + r.body.error : '')
show(await thread(sharwin.id), 3)

// 3 — a coach speaks unprompted. §8.2: "free text always works", with no prompt in front of it.
line('3 · POST /api/emulator/inbound  (coach, unprompted free text)')
t0 = Date.now()
r = await j('/api/emulator/inbound', {
  method: 'POST',
  body: JSON.stringify({ contactId: arjun.id, text: 'reached' }),
})
console.log('status', r.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`, r.body?.error ? 'ERROR: ' + r.body.error : '')
show(await thread(arjun.id), 3)

// 4 — advance the clock; scheduled work fires (§13, §17)
line('4 · POST /api/emulator/clock  (jump to next event)')
t0 = Date.now()
r = await j('/api/emulator/clock', { method: 'POST', body: JSON.stringify({ toNextEvent: true }) })
console.log('status', r.status, `${((Date.now() - t0) / 1000).toFixed(1)}s`)
console.log('now      ', r.body?.clock?.nowIso ?? r.body?.nowIso ?? JSON.stringify(r.body?.clock ?? {}).slice(0, 100))
console.log('jobs     ', JSON.stringify(r.body?.jobs ?? r.body?.ran ?? {}).slice(0, 300))

line('5 · GET /api/emulator/events  (the event log)')
const ev = await j('/api/emulator/events?since=0')
const events = ev.body?.events ?? []
console.log('events', events.length)
for (const e of events.slice(-14)) {
  console.log(`  ${String(e.kind ?? e.type).padEnd(10)} ${String(e.summary ?? e.label ?? e.body ?? '').replace(/\n/g, ' ').slice(0, 110)}`)
}

console.log('\nsmoke done')

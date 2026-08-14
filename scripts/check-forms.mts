/**
 * check-forms — does an answer somebody gave become the write they meant?
 *
 * `check-flows` asks whether Meta would publish the artifact. This asks the other
 * half, which is where the real defects live: a form renders perfectly, submits
 * cleanly, and writes something nobody chose. Every case below is one that has to be
 * wrong silently — no error, no rejection, just a different number in the database
 * than the one on the screen.
 *
 * No database, no Meta, no browser: the sheet's own `buildSubmission` produces the
 * literal `nfm_reply.response_json`, and the flow's own schema parses it back. That
 * is the same pair of functions the wire uses, so a pass here is evidence about
 * production rather than about a copy of it (§17).
 *
 *   npx tsx scripts/check-forms.mts
 */
import { FLOWS, FORM_IDS, parseFlowResponse, splitFlowResponse } from '@/lib/messaging/flows'
import { buildSubmission } from '@/components/emulator/FlowSheet'
import { buildSetupSteps } from '@/lib/setup-plan'

let failed = 0
const fail = (m: string) => { console.error(`  FAIL ${m}`); failed += 1 }
const pass = (m: string) => console.log(`  pass ${m}`)

/** Fill a form in and read back what the runtime would receive. */
function submit(flowId: string, data: Record<string, unknown>, typed: Record<string, unknown>) {
  const def = FLOWS[flowId]
  const screen = def.json.screens.find((s) => s.id === def.entryScreen)!
  const flow = {
    cta: def.cta, flowId, flowToken: 'tok', screen: def.entryScreen, data,
    mode: 'published', consumedAt: null, expiresAt: null, mintedFor: null,
  }
  const built = buildSubmission(screen, flow as never, typed as never)
  const split = splitFlowResponse(built.responseJson)
  if (split.token !== 'tok') fail(`${flowId}: flow_token did not survive the round trip`)
  return parseFlowResponse(flowId, split.data)
}

// ---------------------------------------------------------------------------
// The catalog agrees with itself. `FORM_IDS` is a hand-written tuple because it is
// projected into a function-call enum, so it can drift from `FLOWS` in either
// direction — and a name in the enum with no definition is a button that opens
// nothing.
// ---------------------------------------------------------------------------
for (const id of FORM_IDS) if (!FLOWS[id]) fail(`FORM_IDS names "${id}" and FLOWS has no such form`)
for (const id of Object.keys(FLOWS)) {
  if (!(FORM_IDS as readonly string[]).includes(id)) fail(`FLOWS has "${id}" and FORM_IDS does not offer it`)
}
if (!failed) pass(`catalog agrees with itself: ${FORM_IDS.join(', ')}`)

// ---------------------------------------------------------------------------
// The register is INVERTED: it collects who was not there, and everyone else is
// present. If that derivation is wrong the money is wrong, quietly, every session.
// ---------------------------------------------------------------------------
const roster = Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, title: `Player ${i}` }))
const regData = { session_id: 'sess-1', heading: 'Beginners, 6:30pm — 12 on the roster', roster }

const marked = submit('register', regData, { absent: ['p3'], late: ['p7'], note: 'good session' })
if (!marked.ok) fail(`register rejected a normal submission: ${marked.error}`)
else {
  const v = marked.values as { session_id: string; absent: string[]; late: string[]; note: string }
  const present = roster.filter((r) => !v.absent.includes(r.id) && !v.late.includes(r.id))
  if (v.session_id !== 'sess-1') fail(`register lost its session: ${v.session_id}`)
  else if (present.length !== 10) fail(`12 on the roster, 2 ticked, derived ${present.length} present — expected 10`)
  else if (v.note !== 'good session') fail("the coach's note did not reach the parents' message")
  else pass('register inverts: 12 on roster, 2 ticked -> 10 present, 1 late, 1 absent')
}

// A normal night is nought taps, and it must not submit an empty register as
// "nobody came" — the whole roster is present by omission.
const quiet = submit('register', regData, {})
if (!quiet.ok) fail(`an untouched register was rejected: ${quiet.error}`)
else {
  const v = quiet.values as { absent: string[]; late: string[] }
  if (v.absent.length || v.late.length) fail('an untouched register named somebody')
  else pass('untouched register submits clean -> all 12 present, nought taps')
}

// ---------------------------------------------------------------------------
// add_class: the correction survives, a multi-day class survives, and a blank fee
// stays UNSET rather than becoming a free class.
// ---------------------------------------------------------------------------
const cls = submit(
  'add_class',
  { name: 'Sub Jr', days: ['6'], starts: '10:00', ends: '11:00', venue: 'Green Park', rate: '2500', rate_unit: 'per_month', venues: [{ id: 'Green Park', title: 'Green Park' }] },
  { name: 'Sub Junior', days: ['6'], starts: '10:00', ends: '11:30', venue: 'Green Park', rate: '', rate_unit: 'per_month' },
)
if (!cls.ok) fail(`add_class rejected a correction: ${cls.error}`)
else {
  const v = cls.values as { name: string; days: number[]; ends: string; rate?: number }
  if (v.name !== 'Sub Junior') fail(`the typed correction was lost: got "${v.name}"`)
  else if (JSON.stringify(v.days) !== '[6]') fail(`Saturday did not survive as [6]: ${JSON.stringify(v.days)}`)
  else if (v.ends !== '11:30') fail(`the corrected end time was lost: ${v.ends}`)
  // `z.coerce.number()` reads '' as 0, so without the preprocess a blank fee would be
  // a class priced at zero rather than a class with no price decided.
  else if (v.rate !== undefined) fail(`a blank fee became ${v.rate} — it must stay unset, never 0`)
  else pass('add_class: correction kept, Sat survives as [6], blank fee stays unset (not ₹0)')
}

const multi = submit('add_class', {}, { name: 'Beginners', days: ['1', '3', '5'], starts: '18:30', ends: '19:30' })
if (!multi.ok) fail(`add_class rejected a Mon/Wed/Fri class: ${multi.error}`)
else if (JSON.stringify((multi.values as { days: number[] }).days) !== '[1,3,5]') {
  fail(`Mon/Wed/Fri did not survive: ${JSON.stringify((multi.values as { days: number[] }).days)}`)
} else pass('add_class: a Mon/Wed/Fri class survives as [1,3,5]')

// ---------------------------------------------------------------------------
// business_setup: a blank cancellation window must not become a business that can
// never refuse a late cancellation.
// ---------------------------------------------------------------------------
const blankWindow = submit('business_setup', {}, { name: 'Ace TT Academy', cancellation_window_hours: '' })
if (!blankWindow.ok) fail(`business_setup rejected a blank window: ${blankWindow.error}`)
else if ((blankWindow.values as { cancellation_window_hours: number }).cancellation_window_hours !== 24) {
  fail(`a blank cancellation window became ${(blankWindow.values as { cancellation_window_hours: number }).cancellation_window_hours} — expected 24`)
} else pass('business_setup: blank cancellation window falls back to 24h, not a 0-hour policy')

// ---------------------------------------------------------------------------
// The rhythm. Three answers — a time, "don't send one", and silence — have to reach
// three different writes. Collapsing any two either sends a message somebody
// declined, or wipes a setting they never mentioned.
// ---------------------------------------------------------------------------
const sqlOf = (v: Record<string, unknown>) =>
  buildSetupSteps('11111111-1111-1111-1111-111111111111', { name: 'Ace TT', ...v } as never)
    .map((s) => (s as { write?: string }).write ?? '')
    .join('\n')

const chosen = sqlOf({ morningBriefAt: '07:00', eveningDigestAt: '21:00' })
const off = sqlOf({ morningBriefAt: null, eveningDigestAt: null })
const untouched = sqlOf({ upiHandle: 'acett@okhdfcbank' })

if (!/morning_brief_at = time '07:00'/.test(chosen)) fail('a chosen brief time is not written')
else if (!/morning_brief_at = null/.test(off)) fail('"Don\'t send one" does not clear morning_brief_at')
else if (/morning_brief_at/.test(untouched)) fail('a submission silent about the rhythm still wrote to it')
else if (chosen === off || off === untouched) fail('two of the three rhythm answers produce the same SQL')
else pass('rhythm: a time writes it, "don\'t send one" clears it, silence leaves it alone')

console.log(failed ? `\n${failed} form check(s) failed` : `\n${FORM_IDS.length} form(s) answer correctly`)
process.exit(failed ? 1 : 0)

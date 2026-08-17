/**
 * lib/messaging/send.ts — the one path to the wire (§16.3).
 *
 * "No unthrottled send function exists in the codebase. Not 'we shouldn't call one' — one
 * send path, everything through it, no helper that skips the queue. This is what makes it
 * safe to give the model a message primitive."
 *
 * Ten gates, in order. Every one of them **records its decision on a `message` row** instead
 * of dropping the message on the floor: a suppression nobody can see is indistinguishable
 * from a bug, and the emulator's event log is where §18 and §2.8 are actually inspected
 * (§17). The row carries `suppressed_reason`, the body that would have gone, the window
 * state and the cost — so "why didn't the parent get that?" is answered by looking, not by
 * reasoning about code.
 *
 * Two of the gates are §18's whole implementation. "Eight `if solo` branches would each have
 * to be right; one suppression check has to be right once" — these are that check, and they
 * also catch what a tenant-level solo flag misses: the two-coach academy where one is the
 * admin, the head coach who is also an admin, the admin covering a session this week.
 *
 * Time is `app.now()` throughout. The window, the rolling caps and every stamp are measured
 * against the drivable clock, or advancing it in the emulator would prove nothing (§17).
 */

import { serviceFrom, withSession } from '@/lib/db'
import type { SessionCtx, Tx } from '@/lib/db'
import { encodeForWhatsApp } from '@/lib/agent/lint'
import { CATALOG, isCatalogId } from './catalog'
import { TEMPLATES, sanitizeParam, renderTemplate, isTemplateName } from './templates'
import type { TemplateName } from './templates'
import { getTransport } from './transport'
import type { TransportRequest, TransportResult } from './transport'
import { cacheSenderCredentials } from './transport-cloud'
import { isInWindowAt } from './window'
import {
  COST_PAISE,
  validateOutbound,
  msgError,
  type ConversationCategory,
  type MessageStatus,
  type OutboundMessage,
  type SendOutcome,
  type SuppressReason,
} from './types'

/** §16.3 guardrails. Defaults; an academy may raise or lower them in `academy.settings`. */
export const DEFAULT_RECIPIENT_CAP_24H = 6
export const DEFAULT_TENANT_CAP_24H = 400

type Row = {
  contact_id: string
  person_id: string
  person_name: string
  phone_e164: string
  wa_id: string | null
  contact_state: string
  opted_out_at: Date | null
  last_inbound_at: Date | null
  academy_id: string
  academy_name: string
  academy_timezone: string
  academy_memory: string | null
  onboarding_state: string
  settings: Record<string, unknown> | null
  sender_id: string
  sender_phone: string
  sender_credentials: unknown
  is_admin: boolean
  now_at: Date
}

type Prepared =
  | { kind: 'suppressed'; reason: SuppressReason; messageId: string | null }
  | {
      kind: 'send'
      messageId: string
      row: Row
      inWindow: boolean
      asTemplate: TemplateName | null
      costPaise: number
      wire: OutboundMessage
      injectedFault: 'send_fail' | 'number_blocked' | null
    }

/**
 * `markStatus` is handed a wire id with no tenant on it, and every `message` policy is
 * pinned to `app.academy_id()`. The send path remembers what it sent, so a transport
 * callback in the same process resolves without one; callers that already know the tenant
 * should pass it, or use `markStatusById`, which takes a session.
 *
 * This is a per-process cache and nothing more. It was the only resolution path until 0031,
 * which is complete on one long-lived server and useless across serverless instances — see
 * the note in `markStatus`, where `app.academy_for_wa_message` is now the fallback that
 * actually holds in production.
 */
const waIndex = new Map<string, { academyId: string; messageId: string }>()
const WA_INDEX_MAX = 5000

function rememberWaMessage(waMessageId: string, academyId: string, messageId: string): void {
  if (waIndex.size >= WA_INDEX_MAX) {
    // Oldest first — Map preserves insertion order, and a callback for a message sent
    // 5000 sends ago resolves from the database instead.
    const oldest = waIndex.keys().next()
    if (!oldest.done) waIndex.delete(oldest.value)
  }
  waIndex.set(waMessageId, { academyId, messageId })
}

/**
 * The service session this path does its work under.
 *
 * This was a local copy that rebuilt the context from the tenant alone, so it
 * dropped `turnId` — and `app.turn_id` was therefore unset for every insert into
 * `message`, leaving the column that records which turn put a sentence on
 * somebody's screen null on every row the product has ever sent. Nothing failed;
 * the attribution was simply absent, which is the whole shape of R6. It is
 * `serviceFrom` now because thirteen other places had the identical copy.
 */
const serviceCtx = serviceFrom

/**
 * The tenant-free session used for the one cross-tenant lookup in `markStatus`, matching
 * `lib/agent/deepseek.ts` and `lib/agent/memory.ts`, which read global infrastructure the
 * same way. The uuid is never a real academy; it exists so `app.academy_id()` resolves to
 * something and the `security definer` function can do the actual reading.
 */
const NIL_ACADEMY = '00000000-0000-0000-0000-000000000000'

function capFrom(settings: Record<string, unknown> | null, key: string, fallback: number): number {
  const caps = (settings?.['send_caps'] ?? null) as Record<string, unknown> | null
  const v = caps && typeof caps === 'object' ? caps[key] : undefined
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/**
 * The fallback event phrase, used only when the SENDER named no catalog moment
 * — which means the runtime does not know what happened, and the header must
 * not claim it does. `session_change` used to fall back to "a change to your
 * schedule", and the first message three families ever received — a composed
 * intro, no catalog id — went out under that heading (F-G, month drive T014/
 * T015): a claimed event over an unknown one, on the highest-risk send in the
 * product. A catalog moment still gets its own specific phrase
 * (`templateEvent`); only the don't-know case is neutral.
 */
const GENERIC_EVENT: Record<TemplateName, string> = {
  session_reminder: 'a session coming up',
  session_change: 'an update about your classes',
  session_outcome: 'how the session went',
  payment_due: 'an update on your account',
  coach_schedule: 'an update about your sessions',
  coach_prompt: 'something needs your reply',
  admin_alert: 'something needs your attention',
  admin_digest: 'an update from your academy',
}

/**
 * §16.2: the parameters carry real content or the template is the vague-clickbait pattern
 * Meta re-categorises as marketing. So the fill is the academy's name, the specific thing
 * that happened (the catalog row's own phrase), and the message the bot actually composed —
 * never "you have an update".
 */
/**
 * Who the message is ABOUT, when that is somebody other than who is reading it.
 *
 * `{who}` is filled from the recipient, and every template's own approved example
 * shows a subject instead — *"Sharwin Academy: **Aarav** — missed Beginners Batch
 * today."* Driven, on the first message two real parents ever received: the render
 * came out as *"Baseline Badminton Academy: Sabu Babu — how the session went. Ananya
 * was at Beginners today."* It names the parent where the child belongs and then
 * names the child again in the detail, so the one line a parent skims is about the
 * wrong person.
 *
 * `subjectPersonIds` already carries this — it is what the two §18 suppression rules
 * read — so nothing new has to be recorded, only used. Falls back to the recipient,
 * which is right for a message genuinely about them (a coach's own schedule), and is
 * skipped when the subject IS the recipient so nobody is told about themselves in
 * the third person.
 */
async function subjectName(tx: Tx, msg: OutboundMessage, row: Row): Promise<string> {
  const ids = (msg.subjectPersonIds ?? []).filter((id) => id && id !== row.person_id)
  if (ids.length === 0) return row.person_name
  const names = await tx<{ full_name: string }[]>`
    select full_name from person
     where id = any(${ids}::uuid[]) and academy_id = ${row.academy_id}
     order by full_name`
  if (names.length === 0) return row.person_name
  // Two children in one message is normal for a family; more than two and the names
  // stop being the useful part of a one-line template.
  return names.length <= 2
    ? names.map((n) => n.full_name).join(' and ')
    : `${names[0].full_name} and ${names.length - 1} others`
}

/**
 * The template frame already says the academy's name; the detail must not say it again.
 *
 * Every one of the eight templates opens with `{academy}:`, and `{detail}` is filled
 * with the body composed for the IN-window send — which several writers quite
 * correctly prefix with the academy name, because in window there is no frame in
 * front of it. Out of window the two are concatenated, so the one line a parent
 * skims names the business twice and reads as two messages glued together:
 *
 *     Baseline Badminton: a payment receipt for Meena Krishnan.
 *     Baseline Badminton: received ₹1,200. Thank you.
 *
 * That was the real `message` row for the first payment receipt this product ever
 * sent. Five more like it are in the shared world, across CL-RECEIPT, CL-TALLY,
 * CO-FINAL-STATEMENT and CL-FIRST-CONTACT — and out of window is the NORMAL case
 * for exactly those: a receipt, a tally and a reconcile all fire long after the
 * 24h window has shut. R1 — composed at one layer, rendered at another, and there
 * is no model in the loop at send time to notice.
 *
 * **Only the OPENING restatement is removed, and only the academy's own name.**
 * A mention later in the body is prose and may be load-bearing. And the event
 * being repeated in different words — "your final statement" then "final statement
 * to 20 Aug" — is left alone deliberately: DRIVING's split puts byte-identical
 * repetition at the send gate and *semantic* repetition at the generator, because
 * only the first is a thing the runtime can check against its own record. The
 * academy name IS the runtime's own record, which is what makes this half a
 * structural check rather than a guess.
 */
function withoutRestatedFrame(detail: string, academyName: string): string {
  const name = academyName.trim()
  if (!name) return detail
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // The separator is optional because a composer may write "Ace: x", "Ace — x" or
  // just "Ace x". Anchored at the start, so this can only ever remove a prefix.
  const stripped = detail.replace(new RegExp(`^\\s*${escaped}\\s*(?:[:\\u2013\\u2014-]\\s*)?`, 'i'), '')
  // A body that is *only* the academy's name has nothing left to say; keep it
  // rather than handing `renderTemplate` an empty parameter, which it throws on.
  if (!stripped.trim()) return detail
  return stripped.charAt(0).toUpperCase() + stripped.slice(1)
}

function buildTemplateParams(
  template: TemplateName,
  msg: OutboundMessage,
  row: Row,
  who: string,
): Record<string, string> {
  const entry = msg.catalogId && isCatalogId(msg.catalogId) ? CATALOG[msg.catalogId] : null
  const detail = withoutRestatedFrame((msg.body ?? '').trim(), row.academy_name)
  const defaults: Record<string, string> = {
    academy: row.academy_name,
    who,
    event: entry?.templateEvent ?? GENERIC_EVENT[template],
    detail: detail ? sanitizeParam(detail) : 'Open this chat for the details.',
  }
  return { ...defaults, ...(msg.templateParams ?? {}) }
}

/**
 * Out of window the message becomes a window-opener (§14.7): the approved template body
 * carries it, and at most one button survives — a template's quick-reply title is fixed at
 * approval time, so the title is replaced while the **minted action id** is kept, which is
 * what keeps §2.2 intact across the window boundary.
 */
/**
 * Would tapping this action change something?
 *
 * Read straight off the stored `action` row, because by the time a message
 * reaches `send` a button is only `{ actionId, title }` — the payload that says
 * what it does was left behind at mint. `operation` and `steps` commit; every
 * other kind either replays through the agent, opens a screen, or acknowledges.
 *
 * A missing or unreadable row counts as committing. This decides whether a
 * button may ride an approved template with somebody else's label on it, and the
 * safe answer to "I don't know what this does" is "then it does not go out".
 */
async function committingButton(tx: Tx, actionId: string | undefined): Promise<boolean> {
  if (!actionId) return false
  try {
    const rows = await tx<{ payload: { kind?: string } | null }[]>`
      select payload from action where id = ${actionId}::uuid limit 1`
    const kind = rows[0]?.payload?.kind
    if (!kind) return true
    return kind === 'operation' || kind === 'steps'
  } catch {
    return true
  }
}

function asTemplateMessage(
  msg: OutboundMessage,
  template: TemplateName,
  row: Row,
  who: string,
  /** True when the first button would commit — see `committingButton`. */
  firstCommits: boolean,
): OutboundMessage {
  const params = buildTemplateParams(template, msg, row, who)
  const def = TEMPLATES[template]
  const first = msg.buttons?.[0]
  /**
   * When the safety rule below drops every button, the body still has to answerable.
   *
   * Dropping a lying button is right. Leaving the question behind it unanswerable is
   * not, and out of window is the NORMAL case for the rung that asks it: driven, a coach
   * received *"Beginners starts Monday at 6:30pm at Green Park. Coming?"* with
   * `buttons: null` — the single most important tap in the coach ladder, and no way to
   * make it. The comment below already names this cost ("the person has to reply") and
   * nothing told the person that.
   *
   * One sentence, only when buttons were actually taken away, and only when the message
   * was asking for something. Any reply opens the window and the real buttons follow.
   */
  const droppedTheirButtons = Boolean(msg.buttons?.length) && (!first || firstCommits)
  const rendered = renderTemplate(template, params)
  return {
    ...msg,
    body: droppedTheirButtons
      ? `${rendered}\n\nJust reply here — a word is enough.`
      : rendered,
    header: undefined,
    footer: undefined,
    list: undefined,
    // A template's action is fixed at approval, so a Flow cannot ride one out of window
    // any more than a `cta_url` can. Left set, the stored row still advertised a form
    // the wire was not carrying, and the minted `flow_token` reached nobody — a live
    // action row for a control that was never printed.
    flow: undefined,
    // A template's buttons are fixed at approval, so a `cta_url` cannot ride one out of
    // window. The link is not lost — the template is a window-opener (§14.7), and the
    // rich interaction happens in-window, for free, after one tap.
    link: undefined,
    // **A committing button may not ride a template.** A template's quick-reply
    // title is fixed at approval time, so out of window the label is replaced
    // while the minted action id is kept — and nothing checked what that action
    // did. The reconcile rung first fires 48h after a payment request, so out of
    // window is the NORMAL case for it: an admin was to be shown "…₹2,400 was
    // requested from Priya on 5 August and still isn't confirmed. Did it come
    // in?" with exactly one button, labelled **Open**, which runs
    // `confirm_payment` with no preview — money marked received, a receipt sent
    // to the family, and `[Not yet]` dropped because it was buttons[1]. The same
    // shape put `mark_attendance` all-present behind "Open" on a coach's register.
    //
    // §14.7 says an out-of-window message is a WINDOW-OPENER: the tap buys the
    // in-window interaction. That is only true of a tap that decides nothing.
    // Since the label cannot be made to match the action here, the action goes
    // rather than the label.
    //
    // **What this takes away:** out of window, a consequential choice loses its
    // tap and the person has to reply. That is the honest cost — the body still
    // asks the question, any reply opens the window, and the real buttons follow
    // with their own labels. A button that lies is worse than a button that is
    // absent, and this one lied about money.
    buttons: first && !firstCommits ? [{ actionId: first.actionId, title: def.quickReply }] : undefined,
    templateName: template,
    templateParams: params,
  }
}

function messagePayload(msg: OutboundMessage, extra: Record<string, unknown>): string {
  return JSON.stringify({
    header: msg.header ?? null,
    footer: msg.footer ?? null,
    buttons: msg.buttons ?? null,
    list: msg.list ?? null,
    link: msg.link ?? null,
    // The emulator's panes, the thread endpoint and the event log all read this row —
    // it is the store — so an affordance missing here is an affordance nobody can see
    // or tap, however correctly it went over the wire.
    flow: msg.flow ?? null,
    media: msg.media ?? null,
    subject_person_ids: msg.subjectPersonIds ?? [],
    is_confirmation_request: Boolean(msg.isConfirmationRequest),
    is_escalation: Boolean(msg.isEscalation),
    fixed: Boolean(msg.fixed),
    pre_launch_ok: Boolean(msg.preLaunchOk),
    ...extra,
  })
}

async function insertMessage(
  tx: Tx,
  o: {
    row: Row
    msg: OutboundMessage
    status: MessageStatus
    inWindow: boolean
    template: TemplateName | null
    category: ConversationCategory | null
    costPaise: number
    suppressedReason: SuppressReason | null
    idempotencyKey: string | null
    body: string
    payload: string
  },
): Promise<string> {
  const rows = await tx<{ id: string }[]>`
    insert into message (
      academy_id, contact_id, sender_id, direction, catalog_id, template_name,
      body, payload, media_url, status, queued_at, in_window, conversation_category,
      cost_paise, suppressed_reason, idempotency_key, solicited
    ) values (
      ${o.row.academy_id}, ${o.row.contact_id}, ${o.row.sender_id}, 'outbound',
      ${o.msg.catalogId ?? null}, ${o.template},
      ${o.body}, ${o.payload}::text::jsonb, ${o.msg.media?.url ?? null}, ${o.status}, app.now(),
      ${o.inWindow}, ${o.category}, ${o.costPaise}, ${o.suppressedReason}, ${o.idempotencyKey},
      ${Boolean(o.msg.solicited)}
    )
    returning id`
  return rows[0].id
}

/**
 * Record a suppression as a row, then return it. §12: the bot is allowed to stay quiet, and
 * this is what makes staying quiet auditable rather than invisible.
 *
 * The two cap gates deliberately release the idempotency key: a capped message is "not now",
 * not "not ever", so the same key may be attempted again once the rolling window moves. Every
 * other suppression is a decision, and keeping the key means the decision is made once.
 */
/**
 * Which of the eight §16.2 categories carries an unsolicited message to this person,
 * when the sender did not name one. Roles compose (§6.2), so this reads in priority
 * order: what someone is *most* likely being written to about out of the blue.
 */
async function roleTemplate(tx: Tx, row: Row): Promise<TemplateName | null> {
  try {
    const r = await tx<{ is_admin: boolean; is_coach: boolean; is_client: boolean }[]>`
      select
        exists (select 1 from academy_admin aa
                 where aa.person_id = ${row.person_id} and aa.academy_id = ${row.academy_id}) as is_admin,
        exists (select 1 from coach co
                 where co.person_id = ${row.person_id} and co.academy_id = ${row.academy_id}
                   and co.ended_on is null) as is_coach,
        exists (select 1 from account ac
                 where ac.holder_person_id = ${row.person_id} and ac.academy_id = ${row.academy_id})
          or exists (select 1 from player pl
                      where pl.person_id = ${row.person_id} and pl.academy_id = ${row.academy_id}) as is_client`
    const who = r[0]
    if (!who) return null
    if (who.is_coach) return 'coach_schedule'
    if (who.is_admin) return 'admin_alert'
    if (who.is_client) return 'session_change'
    return null
  } catch {
    // Never let the fallback itself be the reason a message fails; the gate above
    // then suppresses with a reason, which is the honest outcome.
    return null
  }
}

async function suppress(
  tx: Tx,
  row: Row,
  msg: OutboundMessage,
  reason: SuppressReason,
  inWindow: boolean,
): Promise<Prepared> {
  // "Not now" releases the key so the same message may be attempted once the
  // window moves; every other suppression is a decision made once. Quiet hours
  // and a mute-with-an-end-date are both "not now" — the message is owed, the
  // hour is wrong.
  const releasesKey =
    reason === 'recipient_frequency_cap' ||
    reason === 'tenant_send_cap' ||
    reason === 'quiet_hours'
  const messageId = await insertMessage(tx, {
    row,
    msg,
    // A gate is not an outage. Sharing `failed` with a real delivery failure is
    // what made the product report its own most careful behaviour to its owner
    // as a broken number (F-AT); 0032 gave the decision its own value, and this
    // is the one writer of it.
    status: 'suppressed',
    inWindow,
    template: null,
    category: null,
    costPaise: 0,
    suppressedReason: reason,
    idempotencyKey: releasesKey ? null : msg.idempotencyKey,
    body: msg.body ?? '',
    payload: messagePayload(msg, {
      suppressed: reason,
      idempotency_key: msg.idempotencyKey,
      retryable: releasesKey,
    }),
  })
  return { kind: 'suppressed', reason, messageId }
}

/**
 * The single send path. Every message the product emits — catalog row, composed message,
 * model-authored reply, job output — comes through here.
 */
export async function send(ctx: SessionCtx, msg: OutboundMessage): Promise<SendOutcome> {
  const svc = serviceCtx(ctx)

  // Every place this pipeline rewrites the message rather than refusing it, said
  // once, in order, on the outcome — so the caller can know the sent message
  // without re-deriving what the gates did. Console lines are for the operator;
  // this is for the author.
  const altered: string[] = []

  const prepared: Prepared = await withSession(svc, async (tx): Promise<Prepared> => {
    const rows = await tx<Row[]>`
      select c.id              as contact_id,
             c.person_id       as person_id,
             p.full_name       as person_name,
             c.phone_e164      as phone_e164,
             c.wa_id           as wa_id,
             c.state           as contact_state,
             c.opted_out_at    as opted_out_at,
             c.last_inbound_at as last_inbound_at,
             a.id              as academy_id,
             a.name            as academy_name,
             a.timezone        as academy_timezone,
             a.memory          as academy_memory,
             a.onboarding_state as onboarding_state,
             a.settings        as settings,
             s.id              as sender_id,
             s.phone_e164      as sender_phone,
             s.credentials     as sender_credentials,
             exists (select 1 from academy_admin aa
                      where aa.academy_id = c.academy_id
                        and aa.person_id  = c.person_id) as is_admin,
             app.now()         as now_at
        from contact c
        join person  p on p.id = c.person_id
        join academy a on a.id = c.academy_id
        join sender  s on s.id = a.sender_id
       where c.id = ${msg.toContactId}
         and c.academy_id = ${ctx.academyId}`

    // ── Gate 1 · the contact, and opt-out ─────────────────────────────────────
    // Opt-out is per academy, never global (§16.3), and it outranks everything below,
    // including `fixed`: a fixed row exists so the business keeps a promise, not so it
    // can message someone who asked it to stop.
    if (rows.length === 0) {
      return { kind: 'suppressed', reason: 'no_contact', messageId: null }
    }
    const row = rows[0]
    const now = row.now_at instanceof Date ? row.now_at : new Date(row.now_at)
    const inWindow = isInWindowAt({ last_inbound_at: row.last_inbound_at }, now)

    // The acknowledgement of the opt-out is the single exception, and it is not a
    // weakening of the rule — it is the rule's own receipt. The write lands first in
    // the same transaction, so without this the person who just asked to be left
    // alone gets silence where the confirmation should be, and never learns that
    // messaging back turns it on again. Runtime-set only; see MessageStep.opt_out_ack.
    if ((row.opted_out_at || row.contact_state === 'opted_out') && !msg.optOutAck) {
      return suppress(tx, row, msg, 'opted_out', inWindow)
    }

    /**
     * ── Gate 1b · the encoding, and nothing else ──────────────────────────────
     *
     * This used to be five rewriting passes: markdown to WhatsApp markup, then
     * stripping identifiers, then re-rendering timestamps, then weakening
     * delivery claims, then swapping in the academy's own vocabulary. Four of
     * those five are gone, and the reason is ARCHITECTURE.md's second author:
     * every gap between the message the model wrote and the message the person
     * read becomes a false belief in the very next turn, because the model's only
     * picture of what it sent is its own draft. The passes are not gone because
     * they were buggy — they were, repeatedly, in both directions — but because
     * the shape is wrong however carefully it is written.
     *
     * What is left changes representation and not meaning, the model is told it
     * happens (`PLATFORM`), and it applies to every author equally: a job's body,
     * an operation's staged message and the model's reply all reach a phone in
     * the markup the surface actually renders.
     *
     * **Refusal moved to where a round of grace exists.** A uuid or an ISO
     * timestamp in a body is still a defect, and it is now caught at the `reply`
     * tool while the model can fix it, rather than quietly deleted here where
     * nobody would ever learn. Runtime-composed traffic has one author already,
     * and a defect in it is a bug in that handler rather than something to edit
     * on the way past.
     *
     * Still before the repeat gate: that gate compares bodies byte for byte, and
     * two messages identical after encoding must dedupe as the repeats they are.
     */
    msg = {
      ...msg,
      body: encodeForWhatsApp(msg.body ?? ''),
      ...(msg.header ? { header: encodeForWhatsApp(msg.header) } : null),
      ...(msg.footer ? { footer: encodeForWhatsApp(msg.footer) } : null),
    }

    const subjects = msg.subjectPersonIds ?? []
    const aboutRecipient = subjects.includes(row.person_id)

    // ── Gate 2 · §18 rule 1 ───────────────────────────────────────────────────
    // "Never ask someone to confirm something to themselves." The solo coach asked to
    // confirm they are coming to their own class is week-one churn, and this is the one
    // check that removes it — along with the head coach who is also an admin.
    if (aboutRecipient && msg.isConfirmationRequest) {
      return suppress(tx, row, msg, 'self_confirmation', inWindow)
    }

    // ── Gate 3 · §18 rule 2 ───────────────────────────────────────────────────
    // "Never escalate about a person to that person." Routing it elsewhere is the
    // caller's job; dropping it is this gate's.
    if (aboutRecipient && msg.isEscalation) {
      return suppress(tx, row, msg, 'escalation_about_self', inWindow)
    }

    // ── Gate 4 · §2.6 ─────────────────────────────────────────────────────────
    // "Nothing is sent during onboarding until the admin says go. Building the roster
    // messages nobody." Flows that legitimately message before launch — the admin's own
    // setup conversation, the coach invite read-back — set `preLaunchOk`.
    //
    // The admin is that first exception by definition, not by remembering a flag. Leaving
    // it to callers meant the owner of a brand-new academy could not be answered at all:
    // every reply in the setup conversation was dropped as pre-launch traffic, so the one
    // conversation that has to work before launch was the only one that could not. The
    // roster is still silent — a client or coach is not an admin.
    //
    // The second exception is anyone who spoke first. §2.6 is a rule about the bot
    // reaching out, not a rule about the bot answering: "building the roster messages
    // nobody" is about traffic we initiate. A reply inside someone's own turn is
    // solicited by construction — `solicited` is set only when the acting session
    // belongs to the very contact being written to, so no broadcast, digest or job can
    // acquire it.
    //
    // Without this, §8.1's invite could not work at all. The admin forwards the deep
    // link, the coach taps it and sends the prefilled message — which is the moment the
    // whole design turns on, because the window opens from their side — and the answer
    // was dropped as pre-launch traffic. Watched happening: the coach's first contact
    // with the product was silence, and the schedule read back to them existed, was
    // correct, and never left the building.
    if (row.onboarding_state !== 'live' && !msg.preLaunchOk && !row.is_admin && !msg.solicited) {
      return suppress(tx, row, msg, 'pre_launch', inWindow)
    }

    // ── Gate 4b · saying it twice ─────────────────────────────────────────────
    // A person who is told the same thing twice learns nothing the second time and
    // trusts the sender slightly less. This has happened on every path that can send
    // more than once in a turn: a model calling `reply` twice with the same body, a
    // retry after a suppression it did not understand, a plan whose read-back repeats
    // its own preview. Every one of those is a different bug; all of them arrive here,
    // so the guard belongs here rather than in each of them.
    //
    // Byte-identical only: near-identical wording is the model's business, not this
    // gate's.
    //
    // **The window depends on who asked for the message.** Five minutes is right for
    // a reply — somebody who asks the same question twice deserves an answer twice,
    // and silence is a worse failure than mild repetition. It is far too short for
    // proactive traffic, which is where repetition actually happened: reflection
    // scheduled a follow-up for a greeting it had been told was unanswered, the job
    // fired an hour later, and a coach who had already tapped `[Looks right]`
    // received the identical onboarding message a second and a third time. Every
    // send was outside five minutes, so this gate watched it happen.
    //
    // Six hours for unsolicited traffic. Chosen against what legitimately recurs:
    // the morning brief and evening digest sit ~12h apart, reminders are per-session,
    // and a weekly reminder is seven days — none of them are touched. What it does
    // catch is one generator saying the same sentence twice in a working day, which
    // is a defect in every case anybody has produced.
    //
    // Not a substitute for the fix upstream. This is the backstop; the reason
    // reflection fired at all was a false premise, and that is fixed in `loop.ts`.
    // A backstop that has to fire routinely is hiding a bug rather than holding one.
    //
    // **It must compare the body that was COMPOSED, not the one that was sent.**
    // Out of window the body is replaced by a rendered template further down (Gate
    // 8), and `message.body` stores that rendering — so comparing `msg.body`
    // against `message.body` could never match a previous out-of-window send, and
    // this gate was blind to exactly the proactive traffic the note above says it
    // was built for. Driven: three byte-identical CL-DUNNING messages reached one
    // parent inside sixty seconds, every one `sent`, not one suppressed.
    //
    // The composed body is not lost — Gate 10 already keeps it as
    // `payload->>'original_body'` precisely so the pre-template message survives.
    // Nothing new is recorded here; what was recorded is finally read.
    if (msg.body.trim().length > 0) {
      const window = msg.solicited ? '5 minutes' : '6 hours'
      const dupe = await tx<{ id: string }[]>`
        select id from message
         where contact_id = ${row.contact_id}
           and direction = 'outbound'
           and suppressed_reason is null
           and (body = ${msg.body} or payload->>'original_body' = ${msg.body})
           and queued_at > app.now() - ${window}::interval
         limit 1`
      if (dupe.length > 0) {
        return suppress(tx, row, msg, 'repeat', inWindow)
      }
    }

    /**
     * ── Gate 5 · the real API's limits (§17) ──────────────────────────────────
     *
     * Rejected, never truncated and never stripped. "If a message cannot render
     * in the emulator, it does not ship."
     *
     * **This gate used to drop the buttons off an over-long body and send the
     * words anyway**, on the reasoning that dropping the affordance costs a tap
     * while dropping the message costs the answer. The arithmetic was right and
     * the shape was wrong: the person then held a message whose prose was written
     * for controls that were not on it, the model's picture of what it sent was
     * its draft, and the runtime had to explain its own edit back afterwards —
     * which it did, in `altered`, and which is exactly the "report the runtime's
     * edits" design ARCHITECTURE.md replaces with not having edits.
     *
     * The cap now binds where a round of grace exists. `reply`'s own declaration
     * states it at the decode point, and the tool refuses over it while the model
     * can still cut the explanation instead of the affordance. What reaches here
     * over the cap is therefore a runtime compose bug, and a compose bug should
     * be loud rather than papered over.
     */
    const violations = validateOutbound(msg)
    if (violations.length) {
      console.error(
        `[send] limit violation for contact ${msg.toContactId}: ${violations.join('; ')}`,
      )
      return suppress(tx, row, msg, 'limit_violation', inWindow)
    }

    // ── Gates 6 & 7 · §16.3 caps ──────────────────────────────────────────────
    // Two caps because they protect two different things: the per-recipient cap stops a
    // parent getting eight messages because eight things happened, the per-tenant cap
    // stops one heavy academy spending the shared number's tier capacity. `fixed` rows
    // are exempt from being blocked — they still count, because they were still read.
    //
    // So is a *solicited* reply, for the same reason and with the same treatment. The
    // recipient cap counts interruptions; an answer to a question this person just asked is
    // not one, and blocking it turns "eight things happened" protection into a bot that
    // stops mid-sentence once someone has had a busy day. The per-tenant cap still applies —
    // that one protects the shared number's capacity, which a reply spends like anything else.
    if (!msg.fixed) {
      const counts = await tx<{ recipient_24h: number; tenant_24h: number }[]>`
        select
          (select count(*)::int from message m
            where m.contact_id = ${row.contact_id}
              and m.direction = 'outbound'
              and m.suppressed_reason is null
              and m.queued_at > app.now() - interval '24 hours')  as recipient_24h,
          (select count(*)::int from message m
            where m.academy_id = ${row.academy_id}
              and m.direction = 'outbound'
              and m.suppressed_reason is null
              and m.queued_at > app.now() - interval '24 hours')  as tenant_24h`

      const recipientCap = capFrom(row.settings, 'per_recipient_24h', DEFAULT_RECIPIENT_CAP_24H)
      const tenantCap = capFrom(row.settings, 'per_tenant_24h', DEFAULT_TENANT_CAP_24H)

      // The admin is not a recipient to be protected, they are the operator. This cap
      // exists so a parent does not get eight messages because eight things happened;
      // an owner running their business through this passes six before breakfast, and
      // capping them means their own tool goes silent on them mid-task — which is
      // exactly how a confirmed plan lost its confirmation card and executed unseen.
      // The per-tenant cap below still applies: that one protects the shared number.
      if (!msg.solicited && !row.is_admin && counts[0].recipient_24h >= recipientCap) {
        return suppress(tx, row, msg, 'recipient_frequency_cap', inWindow)
      }
      if (counts[0].tenant_24h >= tenantCap) {
        return suppress(tx, row, msg, 'tenant_send_cap', inWindow)
      }
    }

    // ── Gate 8 · window and template (§14.7, §16.2) ───────────────────────────
    // In window: free-form, no template, no approval, no tier cost. Out of window: one of
    // the eight categories carries it, or it does not go at all.
    let asTemplate: TemplateName | null = null
    let wire = msg
    let category: ConversationCategory = 'free_window'

    if (!inWindow) {
      const wanted =
        (msg.templateName && isTemplateName(msg.templateName) ? msg.templateName : null) ??
        (msg.catalogId && isCatalogId(msg.catalogId) ? CATALOG[msg.catalogId].template : null) ??
        // §14.4 — the bot composes messages nobody specified, so a composed message
        // has no catalog row to read a template off. Out of window that used to mean
        // it simply did not go: a coach who has never messaged in would not be told
        // their class was cancelled, and the only trace was a suppression row.
        //
        // The eight §16.2 templates are *categories of unsolicited contact*, not
        // per-feature messages, so the recipient's role already determines which one
        // carries it. Falling back on role keeps every send inside the approved eight
        // — it widens nothing, and it closes a hole where a real message vanished.
        (await roleTemplate(tx, row))

      if (!wanted) {
        return suppress(tx, row, msg, 'out_of_window_no_template', inWindow)
      }
      try {
        wire = asTemplateMessage(
          msg,
          wanted,
          row,
          await subjectName(tx, msg, row),
          await committingButton(tx, msg.buttons?.[0]?.actionId),
        )
      } catch (e) {
        console.error(`[send] template ${wanted} could not render: ${(e as Error).message}`)
        return suppress(tx, row, msg, 'out_of_window_no_template', inWindow)
      }
      asTemplate = wanted
      category = TEMPLATES[wanted].category as ConversationCategory
      altered.push(
        `the 24-hour window with this person is closed, so the body was replaced by the "${wanted}" template ` +
          `rendering — what they read is the template's words, not yours.`,
      )
    }

    const costPaise = COST_PAISE[category]

    // ── Gate 9 · idempotency ──────────────────────────────────────────────────
    // Required on every outbound (§6.5). The same reminder raised twice by two jobs is
    // one message, and the caller gets back the row that already exists.
    const existing = await tx<{ id: string }[]>`
      select id from message where idempotency_key = ${msg.idempotencyKey}`
    if (existing.length) {
      return { kind: 'suppressed', reason: 'duplicate_idempotency', messageId: existing[0].id }
    }

    // Failure injection (§17). Read here, applied at the wire below, so the row is
    // genuinely queued and then genuinely fails — the ladder is never skipped.
    const faults = await tx<{ kind: string; rate: number }[]>`
      select kind, rate::float8 as rate
        from sim_fault
       where active = true and kind in ('send_fail','number_blocked')`
    let injectedFault: 'send_fail' | 'number_blocked' | null = null
    for (const f of faults) {
      if (Math.random() < (Number(f.rate) || 1)) {
        injectedFault = f.kind as 'send_fail' | 'number_blocked'
        if (injectedFault === 'number_blocked') break
      }
    }

    // ── Gate 10 · queue it, then hand it to the wire ──────────────────────────
    const messageId = await insertMessage(tx, {
      row,
      msg: wire,
      status: 'queued',
      inWindow,
      template: asTemplate,
      category,
      costPaise,
      suppressedReason: null,
      idempotencyKey: msg.idempotencyKey,
      body: wire.body ?? '',
      payload: messagePayload(wire, {
        template_params: wire.templateParams ?? null,
        original_body: asTemplate ? (msg.body ?? '') : null,
        original_buttons: asTemplate ? (msg.buttons ?? null) : null,
        original_list: asTemplate ? (msg.list ?? null) : null,
      }),
    })

    return {
      kind: 'send',
      messageId,
      row,
      inWindow,
      asTemplate,
      costPaise,
      wire,
      injectedFault,
    }
  }).catch(async (e: unknown): Promise<Prepared> => {
    // A racing insert on the unique idempotency key: the other writer won, and one message
    // is exactly the point of the key.
    if ((e as { code?: string }).code === '23505') {
      const found = await withSession(svc, async (tx) => {
        const r = await tx<{ id: string }[]>`
          select id from message where idempotency_key = ${msg.idempotencyKey}`
        return r.length ? r[0].id : null
      })
      return { kind: 'suppressed', reason: 'duplicate_idempotency', messageId: found }
    }
    throw e
  })

  if (prepared.kind === 'suppressed') {
    return { status: 'suppressed', reason: prepared.reason, messageId: prepared.messageId }
  }

  const { messageId, row, inWindow, asTemplate, costPaise, wire, injectedFault } = prepared

  // §17 failure injection: the wire refuses without ever being called.
  if (injectedFault) {
    const reason =
      injectedFault === 'number_blocked'
        ? 'number_blocked (injected): the recipient has blocked this number'
        : 'send_fail (injected): the transport rejected the message'
    await stampFailed(svc, messageId, reason)
    return { status: 'failed', reason, messageId }
  }

  // Per-sender credentials (§16.3), handed to the transport rather than read by it.
  cacheSenderCredentials(row.sender_phone, row.sender_credentials)

  const req: TransportRequest = {
    senderPhoneE164: row.sender_phone,
    toPhoneE164: row.phone_e164,
    toWaId: row.wa_id,
    message: wire,
    asTemplate,
  }

  const result: TransportResult = await getTransport()
    .send(req)
    .catch((e: unknown): TransportResult => ({
      ok: false,
      error: `transport threw: ${(e as Error).message}`,
      permanent: false,
    }))

  if (!result.ok) {
    await stampFailed(svc, messageId, result.error)
    return { status: 'failed', reason: result.error, messageId }
  }

  const waMessageId = result.waMessageId

  await withSession(svc, async (tx) => {
    await tx`
      update message
         set status = 'sent',
             sent_at = app.now(),
             wa_message_id = ${waMessageId}
       where id = ${messageId}
         and status = 'queued'`
  })

  rememberWaMessage(waMessageId, ctx.academyId, messageId)

  // §2.4: 'sent' is the strongest claim available right now. Delivered and read arrive
  // later through `markStatus`, or they never arrive and the bot never claims them.
  //
  // `toContactId` rides on the outcome so a TURN can know who was reached — the
  // loop's silence ladder is scoped to the person whose turn it is, and without
  // the recipient on the outcome, a turn that routed a proposal to the admin and
  // ran out of rounds counted as having "spoken" while the asker heard nothing
  // (driven: Sunita's credit request reached the owner and Sunita got silence).
  return {
    status: 'sent',
    messageId,
    waMessageId,
    inWindow,
    template: asTemplate,
    costPaise,
    toContactId: msg.toContactId,
    ...(altered.length ? { altered } : {}),
  }
}

async function stampFailed(svc: SessionCtx, messageId: string, reason: string): Promise<void> {
  await withSession(svc, async (tx) => {
    await tx`
      update message
         set status = 'failed', failed_reason = ${reason}
       where id = ${messageId}
         and status in ('queued','sent')`
  })
}

// `suppressed` is off the ladder entirely, like `failed`: it is not a rung a
// message can be moved forward from, and a delivery callback for one is a bug
// somewhere else.
const RANK: Record<Exclude<MessageStatus, 'failed' | 'suppressed'>, number> = {
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
}

/**
 * Move a message along the ladder. §2.4 in code: `queued ≠ sent ≠ delivered ≠ read`, and it
 * only ever moves forward — a late 'sent' callback arriving after 'read' must not un-read
 * the message, and a delivered message can no longer fail.
 *
 * `read` implies `delivered`, so the earlier stamps are filled in rather than left null; the
 * bot may only say "delivered" where `delivered_at` exists (§4.5 lint downgrades the rest).
 */
export async function markStatusById(
  ctx: SessionCtx,
  messageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  reason?: string,
): Promise<void> {
  const svc = serviceCtx(ctx)
  await withSession(svc, async (tx) => {
    if (status === 'failed') {
      await tx`
        update message
           set status = 'failed', failed_reason = ${reason ?? 'failed'}
         where id = ${messageId}
           and direction = 'outbound'
           and status in ('queued','sent')`
      return
    }

    const rank = RANK[status]
    await tx`
      update message
         set status = ${status},
             sent_at      = case when sent_at is null then app.now() else sent_at end,
             delivered_at = case when ${rank}::int >= 2 and delivered_at is null then app.now()
                                 else delivered_at end,
             read_at      = case when ${rank}::int >= 3 and read_at is null then app.now()
                                 else read_at end
       where id = ${messageId}
         and direction = 'outbound'
         and status <> 'failed'
         and (case status
                when 'queued'    then 0
                when 'sent'      then 1
                when 'delivered' then 2
                when 'read'      then 3
                else 99 end) < ${rank}::int`
  })
}

/**
 * Marks delivery/read from a transport callback (or the emulator's "mark read").
 *
 * A wire id carries no tenant, and every `message` policy is pinned to `app.academy_id()` —
 * there is deliberately no cross-tenant read to resolve one with. The send path remembers
 * what it sent, which covers transport callbacks in the same process; a caller that already
 * knows the tenant (the emulator's read endpoint does) should pass `academyId`, or call
 * `markStatusById` with its session.
 */
export async function markStatus(
  waMessageId: string,
  status: 'sent' | 'delivered' | 'read' | 'failed',
  reason?: string,
  academyId?: string,
): Promise<void> {
  const known = waIndex.get(waMessageId)
  /**
   * Three sources, cheapest first, and the third is the one that makes this work off a
   * single machine.
   *
   * `waIndex` is an in-process Map the send path fills in. It is a complete answer on a
   * long-lived server — the process that sent the message is the process that later hears
   * about it — and an empty one on Vercel, where a status webhook almost never lands on the
   * instance that did the sending. Relying on it alone is why real delivery and read
   * receipts threw `unknown_wa_message` in production while inbound worked perfectly:
   * §16.3's quality proxies stayed frozen at `sent`, and nothing surfaced as broken because
   * a receipt that never arrives looks exactly like a parent who has not opened WhatsApp.
   *
   * `app.academy_for_wa_message` (0031) is the durable answer. It is `security definer`
   * because that is precisely the permission needed — every `message` policy is pinned to
   * `app.academy_id()`, and a wamid arrives with no tenant on it — and narrow enough to be
   * worth granting: one uuid, no message content.
   */
  const tenant =
    academyId ??
    known?.academyId ??
    (await withSession({ role: 'service', academyId: NIL_ACADEMY }, async (tx) => {
      const rows = await tx<{ academy_id: string | null }[]>`
        select app.academy_for_wa_message(${waMessageId}) as academy_id`
      return rows[0]?.academy_id ?? undefined
    }))

  if (!tenant) {
    // Unknown after the lookup means the row genuinely is not there — a receipt for a
    // message this database never sent, or one it has since dropped. That is not ours to
    // mark, and the throw is what keeps the job from being recorded as done.
    throw msgError(
      'unknown_wa_message',
      `cannot resolve the tenant for ${waMessageId}: no message row carries that wa_message_id. ` +
        `Pass academyId, or use markStatusById with the session that owns the thread.`,
    )
  }

  const ctx: SessionCtx = { role: 'service', academyId: tenant }
  const messageId =
    known?.messageId ??
    (await withSession(ctx, async (tx) => {
      const r = await tx<{ id: string }[]>`
        select id from message where wa_message_id = ${waMessageId}`
      return r.length ? r[0].id : null
    }))

  if (!messageId) return
  await markStatusById(ctx, messageId, status, reason)
}

/** §17 event-log helper: the cost of a category, without re-deriving the table. */
export function costOf(category: ConversationCategory): number {
  return COST_PAISE[category]
}

/**
 * lib/messaging/send.ts — the one path to the wire (§16.3).
 *
 * "No unthrottled send function exists in the codebase. Not 'we shouldn't call one' — one
 * send path, everything through it, no helper that skips the queue. This is what makes it
 * safe to give the model a message primitive."
 *
 * @mechanism send — the one path to the wire. Every message the product emits — catalog
 *   row, composed message, model-authored reply, job output — passes ten ordered gates:
 *   opt-out, the scoped mute, quiet hours, §18's two subject rules, pre-launch silence,
 *   state-key and byte-identical repeat, the wire's own limits, the per-recipient and
 *   per-tenant 24h caps, window-and-template, and idempotency. No helper skips them, so a
 *   rule holds here once instead of holding in the senders somebody remembered.
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
// The pending question expires when its button does, and the fallback has to be
// the one `mintAction` uses — not a second copy of 1440 that can drift from it.
import { DEFAULT_ACTION_TTL_MINUTES } from '@/lib/actions'
import { encodeForWhatsApp } from '@/lib/agent/lint'
import { inZone, isQuietHour } from '@/lib/clock'
import { CATALOG, isCatalogId, MUTE_SCOPE } from './catalog'
import { TEMPLATES, sanitizeParam, renderTemplate, isTemplateName, PARAM_MAX_CHARS } from './templates'
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
  /** `sender.is_sim` (0040) — a number a drive invented, which may never reach a handset. */
  sender_is_sim: boolean
  is_admin: boolean
  /** An admin OR a coach who has not ended — who the business is being BUILT with. */
  is_staff: boolean
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
 * `GENERIC_EVENT` stood here: one vague phrase per template, used whenever the
 * sender named no catalog moment. It was already the careful version of the
 * mistake — neutral rather than claiming an event the runtime could not know —
 * and it was still a placeholder in the one parameter whose job is substance.
 * "an update about your classes" differentiates nothing, which is how one contact
 * came to hold four identical notifications (F-AZ). `buildTemplateParams` fills
 * the slot from what the runtime actually knows instead.
 */

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
 * **This is gone, and the reason is that the seam it patched is gone.** It was a
 * runtime edit to a composed body — anchored, narrow, well argued, and still the
 * second author: it deleted a word somebody wrote, in the one place with no model
 * in the loop to notice. What it was fixing was two authors naming one subject,
 * and layer 4's rule fixes that at the source: the template lead-in now names the
 * SENDER and nothing else, so a composed body that opens with the business's own
 * name is no longer a restatement of anything.
 */

/**
 * **A parameter carries substance, never a placeholder.**
 *
 * `{event}` was `CATALOG[id].templateEvent` — a per-category constant like *"a
 * change to a session"* — falling back to `GENERIC_EVENT`, which is the same idea
 * with less information. Both are the vague-clickbait pattern §16.2 warns about,
 * moved from the frozen half of the template into the variable half where nobody
 * was looking for it. *"Change: a change to today's session"* tells a parent
 * nothing and was sent seventeen times to one contact (F-AZ).
 *
 * What the runtime actually knows about any send, whatever composed it: WHO it is
 * about and WHEN it is being sent. Those are the two things that differentiate
 * one notification from the next in a parent's list, so those are what fill it —
 * the catalog's phrase joins them rather than standing in for them. A caller that
 * knows better still overrides through `templateParams`, and several should.
 */
function buildTemplateParams(
  template: TemplateName,
  msg: OutboundMessage,
  row: Row,
  who: string,
  at: Date,
): Record<string, string> {
  const entry = msg.catalogId && isCatalogId(msg.catalogId) ? CATALOG[msg.catalogId] : null
  const detail = (msg.body ?? '').trim()
  const day = inZone(at, row.academy_timezone || 'Asia/Kolkata').label
  // The catalog's phrase, dated — "a change to a session" becomes "a change to a
  // session, Wed 19 Aug 6:30pm". Without a catalog row the runtime does not know
  // what happened and does not claim to; the day alone is still a true and
  // differentiating thing to say.
  const event = entry?.templateEvent ? `${entry.templateEvent}, ${day}` : day
  const defaults: Record<string, string> = {
    academy: row.academy_name,
    who,
    event,
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
 *
 * @mechanism committingButton — reads the stored `action` payload at send time and refuses to
 *   let an `operation` or `steps` button ride an approved template, because a template's
 *   quick-reply title is fixed at approval and the tap would then carry somebody else's
 *   label: an `Open` that confirms a payment, or marks a whole register present. A missing or
 *   unreadable row counts as committing, so the action goes rather than the label, and the
 *   body keeps the question answerable by reply.
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
  /** The tenant's own clock, for the day that differentiates this send. */
  at: Date,
): OutboundMessage {
  const params = buildTemplateParams(template, msg, row, who, at)
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
    // The emulator's panes, the thread endpoint and the event log all read this row —
    // it is the store — so an affordance missing here is an affordance nobody can see
    // or tap, however correctly it went over the wire.
    link: msg.link ?? null,
    media: msg.media ?? null,
    subject_person_ids: msg.subjectPersonIds ?? [],
    is_confirmation_request: Boolean(msg.isConfirmationRequest),
    is_escalation: Boolean(msg.isEscalation),
    fixed: Boolean(msg.fixed),
    pre_launch_ok: Boolean(msg.preLaunchOk),
    // What standing state this message reported, so gate 4a can ask whether it
    // has already been reported. Written on suppressed rows too — a message
    // dropped by the caps did not tell anybody anything, and the gate reads only
    // rows with no suppression reason.
    state_key: msg.stateKey ?? null,
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

/**
 * @mechanism suppress — every gate's refusal becomes a `message` row: status `suppressed`
 *   rather than `failed`, the reason in `suppressed_reason`, and the body, window state and
 *   cost that would have gone. A deliberate non-send is therefore distinguishable from a
 *   broken number, and staying quiet is auditable rather than invisible: a suppression
 *   nobody can see is indistinguishable from a bug. The three "not now" reasons — both caps
 *   and quiet hours — release the idempotency key so the moment may be attempted again;
 *   every other suppression keeps it, because it is a decision made once.
 *   Closes F-AT.
 */
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
             s.is_sim          as sender_is_sim,
             exists (select 1 from academy_admin aa
                      where aa.academy_id = c.academy_id
                        and aa.person_id  = c.person_id) as is_admin,
             /**
              * STAFF, not just the owner — see the pre-launch gate below. A coach who has
              * not ended is somebody this business is being built WITH, and §2.6's silence
              * is about the families it has not told yet.
              */
             (exists (select 1 from academy_admin aa2
                       where aa2.academy_id = c.academy_id
                         and aa2.person_id  = c.person_id)
              or exists (select 1 from coach co
                          where co.academy_id = c.academy_id
                            and co.person_id  = c.person_id
                            and co.ended_on is null)) as is_staff,
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

    /**
     * ── Gate 1c · they asked to hear nothing about this ───────────────────────
     *
     * The scoped half of an opt-out, which the product could not store until 0032
     * and therefore could not keep. "Please stop messaging me about money. I will
     * pay when I pay." — the reply was close to ideal, said what would stop and
     * scoped it, and behind it were one `remember` call and a null
     * `opted_out_at`. The always-rule *nobody was messaged after they opted out*
     * passed every later turn **because the column was never set** (F-AV).
     *
     * Here rather than in each job for the reason every gate is here: a rule
     * enforced per composer is enforced in the composers somebody remembered.
     * `MUTE_SCOPE` decides which mute a moment answers to; a message with no
     * catalog moment is answerable only to a full stop, which is the honest
     * reading of an unclassified interruption.
     *
     * **A reply to something they said is never muted.** Somebody asking to stop
     * hearing about money is asking the business to stop starting that
     * conversation, not to ignore them when they start one — that distinction is
     * `solicited`, and it is the same one the opt-out itself makes.
     */
    if (!msg.solicited && !msg.optOutAck) {
      const scope = msg.catalogId && isCatalogId(msg.catalogId) ? MUTE_SCOPE[msg.catalogId] : null
      const muted = await tx<{ scope: string }[]>`
        select scope from comm_preference
         where contact_id = ${row.contact_id}
           and released_at is null
           and (until is null or until >= (app.now() at time zone ${row.academy_timezone})::date)
           and (scope = 'all' ${scope ? tx`or scope = ${scope}` : tx``})
         limit 1`
      if (muted.length > 0) {
        return suppress(tx, row, msg, 'muted', inWindow)
      }
    }

    /**
     * ── Gate 1d · the academy is asleep ───────────────────────────────────────
     *
     * A floor under every proactive send, and the layer that has to hold it.
     * `lib/jobs/plan-ahead.ts` pulls a client reminder back and defers a register
     * escalation forward, which covers two of fourteen senders; `runner.ts` said
     * in as many words that there are no quiet hours. Going live at 2am fired
     * three reminder templates at 02:02 — three handlers, each correct about
     * everything except the hour, which is exactly the shape that cannot be fixed
     * one handler at a time.
     *
     * Two exemptions, both the same ones the frequency cap makes and for the same
     * reasons. A reply to something they just said is not an interruption. And the
     * admin is the operator rather than a recipient to be protected: an owner
     * running their business through this at 6am for a 7am class is working, not
     * being woken, and the escalation about that class is the thing they are
     * awake for.
     *
     * Suppressed rather than deferred, and the key is released so the same moment
     * may be attempted again once morning comes: `send` has no queue of its own,
     * and inventing one here would put a second scheduler beside the real one.
     */
    if (!msg.solicited && !row.is_admin && isQuietHour(now, row.academy_timezone, row.settings)) {
      return suppress(tx, row, msg, 'quiet_hours', inWindow)
    }

    /**
     * @mechanism subjectPersonIds — the message declares who it is ABOUT, and the two gates
     *   below compare that list against who is reading it: a confirmation request about the
     *   recipient and an escalation about the recipient are dropped here, once, rather than by
     *   an `if solo` branch in every sender that could raise one. It catches what a
     *   tenant-level solo flag misses — the two-coach academy where one is the admin, the head
     *   coach who is also an admin — and the same list names the subject in an out-of-window
     *   template, so the line is about the child rather than the parent reading it.
     */
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
    // messages nobody." The journeys that legitimately message before launch — the admin's
    // own setup conversation, the coach invite read-back — set `preLaunchOk`.
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
    // Without this, §8.1's invite could not work at all. It used to be the admin's
    // forwarded deep link the coach tapped; the invite is a bot send now, but the half
    // that needs this exemption is unchanged and matters more — CO-INVITE carries
    // `preLaunchOk` out, and the coach's REPLY to it lands in a setup-state academy,
    // where CO-INVITE-CONFIRM reads their schedule back. Watched happening before the
    // exemption existed: the coach's first contact with the product was silence, and
    // the schedule read back to them existed, was correct, and never left the building.
    /**
     * @mechanism is_staff — before go-live the silence is owed to the FAMILIES, not to the
     *   people the business is being built with. The gate read `!row.is_admin`, so a coach
     *   was roster: during the one phase whose entire content is standing a business up
     *   alongside their staff, the owner could ask the product to reach their coach and the
     *   product would compose the message, suppress it, and then have to explain its own
     *   internal gate to the owner instead.
     *
     *   Driven on `2026-08-22-13-29-sim-8528` day 6: the owner asked for Saturday cover,
     *   the send to Arjun was suppressed `pre_launch`, and the reply that went back was
     *   about onboarding states rather than about cover. §2.6 is "building the roster
     *   messages nobody" and ARCHITECTURE names the roster as the families; §8.1 already
     *   required one coach send to cross this line (`sendInvite` sets `preLaunchOk`), so
     *   the boundary was already drawn here — one role at a time, by whoever remembered.
     *   This reads it off the rows instead: an `academy_admin` row or a live `coach` row.
     *   A family still hears nothing until go-live, which is the rule §2.6 actually states.
     *   Closes F-DH.
     */
    if (row.onboarding_state !== 'live' && !msg.preLaunchOk && !row.is_staff && !msg.solicited) {
      return suppress(tx, row, msg, 'pre_launch', inWindow)
    }

    /**
     * ── Gate 4a · saying the same STATE twice ─────────────────────────────────
     *
     * Before the byte-window gate, because it is the gate that byte-window
     * dedupe cannot be: a state that has not moved produces an identical body
     * *and* fires on a slower clock than any window worth having. Sixteen
     * consecutive cases of the repetition invariant were this (F-AN).
     *
     * No time window at all, deliberately. "Fire on a change in the state, never
     * restate" means once per state, however long the state lasts — and a state
     * that legitimately recurs carries the thing that changed inside its own key
     * (the dunning rung, the billing period, the set of unmarked registers), so
     * it produces a different key and goes.
     *
     * Suppressed rows do not count as having told them, so a message dropped by
     * the caps or by quiet hours is retried when the next attempt comes.
     *
     * @mechanism stateKey — a standing message reports a state once, however long the state
     *   lasts: the key is matched against `payload->>'state_key'` on this contact's
     *   unsuppressed outbound rows with no time window at all, so a job firing daily into an
     *   unchanged state says it once, and a state that legitimately recurs carries what moved
     *   inside its own key. Suppressed rows do not count as having told anybody.
     *   Closes F-AN.
     */
    if (msg.stateKey) {
      const told = await tx<{ id: string }[]>`
        select id from message
         where contact_id = ${row.contact_id}
           and direction = 'outbound'
           and suppressed_reason is null
           and payload->>'state_key' = ${msg.stateKey}
         limit 1`
      if (told.length > 0) {
        return suppress(tx, row, msg, 'repeat', inWindow)
      }
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

      /**
       * The admin is not a recipient to be protected, they are the operator. This cap
       * exists so a parent does not get eight messages because eight things happened;
       * an owner running their business through this passes six before breakfast, and
       * capping them means their own tool goes silent on them mid-task — which is
       * exactly how a confirmed plan lost its confirmation card and executed unseen.
       * The per-tenant cap below still applies: that one protects the shared number.
       *
       * @mechanism operatorWhileOperating — the exemption is keyed on ENGAGEMENT rather than
       *   on role, because the argument above is entirely about an admin mid-task and
       *   `is_admin` cannot tell mid-task from gone. `inWindow` can, and is already in hand
       *   three gates up: an operator working through this has written inside 24 hours by
       *   definition, so every case the exemption was written for keeps it, unchanged.
       *
       *   Out of window they are not mid-task and the exemption is inverted from its own
       *   reasoning: nothing free is being protected, because an out-of-window send leaves
       *   as one of the eight approved templates, metered and quality-scored by Meta against
       *   a number §16.1 shares with every other tenant — *"one policy strike, one wave of
       *   blocks from one badly-run academy, and everybody goes dark at the same moment"*.
       *
       *   Measured on `2026-08-22-16-51-sim-b8xo`: the owner left on day 20 and the product
       *   sent him THIRTY-FIVE more templates over the following ten days. He replied to
       *   none of them, none was suppressed, and the cap that exists to notice exactly this
       *   never looked at him because he was still `is_admin`.
       *
       *   `fixed` rows and solicited replies are untouched — they are already exempt on the
       *   line above and for a better reason, that they exist for something other than
       *   engagement. What this stops is the sixth cheerful digest of the week to somebody
       *   who has not answered since the first.
       */
      const operatorWhileOperating = row.is_admin && inWindow
      if (!msg.solicited && !operatorWhileOperating && counts[0].recipient_24h >= recipientCap) {
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
          now,
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

      /**
       * @mechanism saidHowMuchWasCut — when the body did not fit the template parameter,
       *   `altered` says so and says by how much, because the substitution line above does
       *   not imply it and the model cannot see the difference.
       *
       *   `sanitizeParam` flattens the body to one line and trims it to `PARAM_MAX_CHARS`
       *   FROM THE END. A brief is composed lead, then detail, then the ask — so what the
       *   trim takes is the ask. On `2026-08-22-16-51-sim-b8xo` THIRTEEN of 49 template
       *   sends went out visibly cut, and the money section is what they lost:
       *   *"Unpaid: Arjun Rs4,800 (6 sessions), Priya Rs3,000 (3 sessions). No…"*
       *
       *   This reports and does not refuse. `windowRightHere` (lib/agent/context.ts) now
       *   tells the model the budget BEFORE it composes, which is the half that prevents
       *   the cut rather than describing it, and the repo's own rule after deleting
       *   `proseRefused` is to fix the information first and measure whether a gate ever
       *   fires. This is the measurement: a cut that is named is a cut somebody can count.
       */
      const composed = String(msg.body ?? '')
      const kept = String(wire.body ?? '')
      const saidHowMuchWasCut = composed.length > PARAM_MAX_CHARS && kept.includes('…')
      if (saidHowMuchWasCut) {
        altered.push(
          `your ${composed.length}-character body did not fit the template's ${PARAM_MAX_CHARS}-character ` +
            `parameter, so it was cut FROM THE END — roughly the last ` +
            `${Math.max(0, composed.length - PARAM_MAX_CHARS)} characters did not go. Whatever you left ` +
            `until last is what they did not read.`,
        )
      }
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

    /**
     * ── The question, recorded where it was asked ─────────────────────────────
     *
     * **Here rather than in each protocol, and only once a message has actually
     * been queued.** A suppressed ask is not an outstanding question — nobody was
     * asked anything — and every gate above this line can suppress one, so any
     * earlier write would record questions nobody ever saw.
     *
     * The subject is derived when the caller supplies none, because a state that
     * depends on somebody remembering to pass a field is not a state: that is
     * F-AF and F-AQ, where an untapped confirmation left the world identical to
     * the ask never having happened. The catalog moment and the people the
     * message is ABOUT are ids, not prose, and they are exactly what distinguishes
     * one outstanding question from another.
     *
     * Superseding rather than colliding: 0032's partial unique index means one
     * open question per person per subject, so re-asking replaces. `on conflict`
     * cannot express that (the index is partial on `resolved_at is null`), so the
     * older row is resolved first and the reason it ended is recorded.
     *
     * @mechanism pending_request — the outstanding question is written on the one path every
     *   ask goes through, and only once a message has actually been queued, with the subject
     *   derived from `subjectPersonIds` when the caller passes none and `expires_at` taken from
     *   the button's own TTL. So "asked and unanswered" is a state nobody has to remember to
     *   record, and one that can end; re-asking supersedes the open row rather than colliding
     *   with 0032's partial unique index.
     *   Closes F-AF, F-AQ.
     */
    if (msg.isConfirmationRequest) {
      const kind = msg.confirmation?.kind ?? msg.catalogId ?? 'confirmation'
      const subject =
        msg.confirmation?.subject ??
        [...(msg.subjectPersonIds ?? [])].sort().join('+') ??
        row.contact_id
      const question = (msg.confirmation?.question ?? msg.body ?? '').slice(0, 500)
      /**
       * The question and the BUTTON that answers it retire together, or the state is
       * split — and a split state is the shape 0016 already exists to kill, one level up.
       *
       * This statement was retiring the question alone. The card it was printed on stayed
       * tappable for its full lifetime, so a re-ask left the owner holding two live
       * `[Do it]` buttons for one decision, the older one describing a version of the plan
       * they had already corrected, while `standing()` correctly reported only the newer
       * question. Driven on `2026-08-22-13-29-sim-8528`: the owner gave a timetable on day
       * 5, added the Saturday squad and Arjun on day 6, and both cards were live and
       * identical-looking at the end of the run — `expired_reason` null on each.
       *
       * The subject is the one computed above and not a second notion of sameness. A
       * button-side key of its own (`subjectKeyOf`) answers a different and narrower
       * question — what a payload WRITES — and it missed this pair precisely because the
       * corrected plan wrote two more tables than the plan it replaced. Whether two asks
       * are the same ask is already decided here, once, and this makes the affordance obey
       * the decision instead of outliving it.
       *
       * @mechanism staleAsks — retiring an unanswered question also retires the buttons
       *   on the message that asked it, in the same statement-pair and on the same subject,
       *   so a re-ask can never leave an earlier version of the same decision tappable. The
       *   narrowness is inherited rather than invented: only a message that actually wrote a
       *   `pending_request` is reached, which `isConfirmationRequest` already limits to asks
       *   somebody has to answer, so a reminder card pairing `[I'll be there]` with `[Can't
       *   make it]` is untouched exactly as it is by 0016.
       *   Closes F-DR.
       */
      const staleAsks = await tx<{ message_id: string | null }[]>`
        update pending_request
           set resolved_at = app.now(), resolution = 'superseded'
         where academy_id = ${row.academy_id}
           and contact_id = ${row.contact_id}
           and kind = ${kind}
           and subject = ${subject || row.contact_id}
           and resolved_at is null
        returning message_id`
      const staleMessageIds = staleAsks.map((r) => r.message_id).filter((id): id is string => Boolean(id))
      if (staleMessageIds.length) {
        await tx`
          update action
             set expires_at = app.now(),
                 expired_reason = 'superseded_ask'
           where academy_id = ${row.academy_id}
             and message_id = any (${staleMessageIds}::uuid[])
             and consumed_at is null
             and (expires_at is null or expires_at > app.now())`
      }
      /**
       * **`expires_at` was left NULL on every row, and that made the sweep dead
       * code.** `plan-ahead.ts` resolves stale questions with `expires_at is not
       * null and expires_at < app.now()` — correct SQL that could never match,
       * because nothing on any path ever set the column. So "asked and
       * unanswered" was a state with no way to end: the tail went on reporting a
       * question about a session that had already run, and two rows were still
       * open at the close of the stress week.
       *
       * The lifetime is the BUTTON's, not a number chosen here. Once the action
       * has expired there is no tap left that could answer the question, so any
       * other figure would be this file inventing a policy. `DEFAULT_ACTION_TTL_MINUTES`
       * is the same fallback `mintAction` applies, imported rather than repeated
       * — two copies of one number is how the two writers of a billing key came
       * to disagree.
       */
      const ttl = Number.isFinite(msg.actionTtlMinutes)
        ? Number(msg.actionTtlMinutes)
        : DEFAULT_ACTION_TTL_MINUTES
      await tx`
        insert into pending_request
          (academy_id, contact_id, person_id, kind, subject, question, message_id, asked_turn_id,
           expires_at)
        values (${row.academy_id}, ${row.contact_id}, ${row.person_id}, ${kind},
                ${subject || row.contact_id}, ${question || '(a confirmation)'}, ${messageId},
                nullif(current_setting('app.turn_id', true), '')::uuid,
                app.now() + make_interval(mins => ${ttl}::int))`
    }

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

  // The road is chosen by the NUMBER, not by the process (0040). A sender a drive
  // invented takes the emulator whatever `TRANSPORT` says, so a run started
  // without the `TRANSPORT=emulator` prefix cannot put an invented parent's
  // number on the live Cloud wire. Every other sender gets the environment's
  // choice, exactly as before.
  const result: TransportResult = await getTransport({ senderIsSim: row.sender_is_sim === true })
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
    // Off `wire`, which is what the transport was handed — so a button the
    // interactive cap or `committingButton` took out is not counted here.
    tappable: (wire.buttons?.length ?? 0) + (wire.list ? 1 : 0),
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

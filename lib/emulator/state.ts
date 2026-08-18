/**
 * Emulator client store (§17).
 *
 * Plain React context + reducer. No state library. Holds the world, the open panes,
 * the shared clock, the event log and the fault switches; consumes the SSE stream from
 * `GET /api/emulator/stream` and exposes typed actions over the `/api/emulator/*` routes
 * documented in CONTRACTS §9.
 *
 * This module has no `"use client"` directive (CONTRACTS §11 forbids it under `lib/`).
 * It is only ever imported from components that carry the directive themselves, which puts
 * it in the client graph.
 */

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react'
import { EXTRA_LIMITS, LIMITS } from '@/lib/messaging/types'
import type { ContactState, OnboardingState, Role } from '@/lib/types'

/* ------------------------------------------------------------------ *
 * View types — what the emulator renders.
 * ------------------------------------------------------------------ */

export type FaultKind = 'send_fail' | 'number_blocked' | 'media_timeout' | 'link_expired' | 'model_error'

export const FAULT_KINDS: readonly FaultKind[] = [
  'send_fail',
  'number_blocked',
  'media_timeout',
  'link_expired',
  'model_error',
] as const

export const FAULT_LABELS: Record<FaultKind, string> = {
  send_fail: 'Send fails',
  number_blocked: 'Number blocked',
  media_timeout: 'Media fetch times out',
  link_expired: 'Web link expired',
  model_error: 'Model errors',
}

export const FAULT_NOTES: Record<FaultKind, string> = {
  send_fail: 'Transport returns a transient failure. The message row stamps failed.',
  number_blocked: 'Permanent transport failure — the recipient has blocked the sender number.',
  media_timeout: 'Inbound media bytes never arrive before the URL expires.',
  link_expired: 'A signed web link is rejected mid-form.',
  model_error: 'generate() throws. The turn must still record a row.',
}

/** §16.2 — exactly eight. Anything else on a message row is a bug worth seeing. */
export const TEMPLATE_NAMES = [
  'session_reminder',
  'session_change',
  'session_outcome',
  'payment_due',
  'coach_schedule',
  'coach_prompt',
  'admin_alert',
  'admin_digest',
] as const

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'suppressed'

export type EmuButton = {
  actionId: string
  title: string
  consumedAt: string | null
  expiresAt: string | null
  mintedFor: string | null
}

export type EmuListRow = {
  actionId: string
  title: string
  description: string | null
  consumedAt: string | null
  expiresAt: string | null
  mintedFor: string | null
}

export type EmuListSection = { title: string; rows: EmuListRow[] }

export type EmuMedia = { url: string; kind: 'image' | 'audio' | 'document' | 'video'; filename: string | null }

export type EmuMessage = {
  id: string
  contactId: string
  direction: 'inbound' | 'outbound'
  body: string
  header: string | null
  footer: string | null
  buttons: EmuButton[]
  list: { buttonText: string; sections: EmuListSection[] } | null
  /** §14.6 — the Cloud API's `cta_url`: a body plus one button that opens a URL. */
  link: { title: string; url: string } | null
  media: EmuMedia | null
  catalogId: string | null
  templateName: string | null
  status: MessageStatus
  queuedAt: string | null
  sentAt: string | null
  deliveredAt: string | null
  readAt: string | null
  failedReason: string | null
  suppressReason: string | null
  senderPhone: string | null
  costPaise: number | null
  inWindow: boolean | null
  /** service | utility | marketing | authentication | free_window — what the cost is for. */
  conversationCategory: string | null
  waMessageId: string | null
  at: string
  /** Local optimistic echo, not yet confirmed by the server. */
  pending: boolean
  /** Wall-clock ms the echo was created — only used to expire it. */
  pendingSince: number
}

export type EmuAcademy = {
  id: string
  name: string
  timezone: string
  onboardingState: OnboardingState | string
  senderPhone: string | null
  /**
   * §16.3's accepted trade-off, made visible: the display name on the shared number is what
   * every parent sees at the top of their chat — "Class Manager", never the academy's name.
   * `worldState` has always served it and the client dropped it, so the one screen where the
   * trade-off would be obvious showed the academy's name instead and hid it completely.
   */
  senderLabel: string | null
  category: string | null
  rail: string | null
  /** §6.4 — where a Rail 1 parent is told to pay. Empty is a real state, and worth seeing. */
  upiHandle: string | null
  /**
   * Scratch tenant or real business (`academy.is_sandbox`, migration 0030).
   *
   * The console is deployed now, so one screen shows both kinds at once and the operator has
   * to be able to tell them apart before typing anything. The server already refuses a scoped
   * destructive call against a real tenant — this is what stops the operator finding that out
   * by aiming one at a customer and reading a 403.
   */
  isSandbox: boolean
}

export type EmuContact = {
  id: string
  academyId: string
  personId: string | null
  name: string
  phone: string | null
  roles: Role[]
  state: ContactState | string
  optedOutAt: string | null
  lastInboundAt: string | null
  isPrimary: boolean
  isSolo: boolean
  note: string | null
  /** Chat-list preview — how many messages this thread holds and the last thing said. */
  messageCount: number
  lastMessageAt: string | null
  lastMessageBody: string | null
  lastMessageDirection: 'inbound' | 'outbound' | null
}

export type EmuClock = {
  nowIso: string
  offsetMs: number
  nextEventAtIso: string | null
  /**
   * `Date.now()` when `nowIso` arrived from the server. The simulated clock is real time plus
   * an offset, so it keeps running between clock actions — but `nowIso` only changes when a
   * route answers, and everything derived from it froze in between. A window with four minutes
   * left read "window 4m" an hour later, and an expired action button stayed tappable-looking
   * until something else happened. Measuring elapsed wall time from this anchor (rather than
   * trusting the browser's own clock, which is not the server's) makes the countdowns move
   * without ever drifting from the server's answer.
   */
  syncedAtMs: number
  /**
   * Academies holding a clock of their own (0024). Everything *not* in here rides
   * the world clock, which is what a world-scoped move actually moves.
   *
   * The clock routes do not serve this — only `GET /api/emulator/state` does — so
   * it is carried across a clock response rather than reset to empty, or the
   * bar's "this moves N academies" would blank out for a beat after every move.
   */
  tenantClocks: { academyId: string; offsetMs: number }[]
}

export type ScenarioMeta = { id: string; name: string; description: string | null }

export type EventKind =
  | 'send'
  | 'suppress'
  | 'inbound'
  | 'status'
  | 'job'
  | 'turn'
  | 'clock'
  | 'fault'
  | 'system'

export const EVENT_KINDS: readonly EventKind[] = [
  'send',
  'suppress',
  'inbound',
  'status',
  'job',
  'turn',
  'clock',
  'fault',
  'system',
] as const

export const EVENT_LABELS: Record<EventKind, string> = {
  send: 'sends',
  suppress: 'suppressions',
  inbound: 'inbound',
  status: 'status',
  job: 'jobs',
  turn: 'model turns',
  clock: 'clock',
  fault: 'faults',
  system: 'system',
}

export type EmuEvent = {
  id: string
  seq: number
  at: string
  kind: EventKind
  rawKind: string
  academyId: string | null
  contactId: string | null
  messageId: string | null
  summary: string
  templateName: string | null
  inWindow: boolean | null
  costPaise: number | null
  senderPhone: string | null
  catalogId: string | null
  status: string | null
  reason: string | null
  tierUsed: number | null
  tierLimit: number | null
  jobKind: string | null
  jobOutcome: 'ran' | 'skipped' | 'failed' | null
  error: string | null
  model: string | null
  promptTokens: number | null
  outputTokens: number | null
  cachedTokens: number | null
  ms: number | null
  toolCalls: number | null
  detail: Record<string, unknown>
}

export type ThreadState = {
  messages: EmuMessage[]
  loading: boolean
  error: string | null
  loadedAt: number
}

export type Toast = { id: string; tone: 'ok' | 'warn' | 'error'; text: string; at: number }

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'offline'

export type EventFilters = {
  academyId: string
  kinds: Record<EventKind, boolean>
  q: string
}

/**
 * §2.4's ladder, driven for you.
 *
 * Nothing in this build ever advanced a delivery on its own: the emulator transport hands back
 * a wire id and stops, so a full run of jobs left every message sitting at `sent` forever, and
 * every per-tenant quality proxy §16.3 asks for — delivery failures, read rate — had no input
 * that was not typed by hand. `delivered` is the honest default because delivery is the
 * network's act; `read` additionally simulates the recipient opening the chat, which is a
 * person's act and therefore an explicit choice rather than something that just happens.
 */
export type AutoDelivery = 'off' | 'delivered' | 'read'

export const AUTO_DELIVERY_LABELS: Record<AutoDelivery, string> = {
  off: 'manual',
  delivered: 'auto ✓✓',
  read: 'auto read',
}

export type EmulatorState = {
  booted: boolean
  loading: boolean
  error: string | null
  scenario: string | null
  scenarios: ScenarioMeta[]
  academies: EmuAcademy[]
  contacts: EmuContact[]
  clock: EmuClock
  faults: Record<FaultKind, { active: boolean; rate: number }>
  panes: string[]
  /**
   * The panes that hold the front of the deck, in pin order.
   *
   * `panes` is the deck's order and stays that way — a second ordered array would give the
   * row two sources of truth, and the first divergence would render as a pane in one place
   * and its pin in another. So this is not an order: it is the SET of ids `orderPanes`
   * floats to the front, and the invariant it buys is that every pinned id occupies a
   * prefix of `panes`. Anything that moves an id re-establishes it.
   *
   * An array rather than a `Record<string, boolean>` because pin order matters — pin A then
   * B should read A, B — and because `panes: string[]` is the precedent next door.
   */
  pinned: string[]
  /**
   * The one pane filling the deck, or `''` for the row.
   *
   * A single slot rather than a flag per pane: "full size" means it takes the whole deck,
   * two expanded panes is not a state the row can draw, and a per-pane boolean makes that
   * unrenderable state expressible. Same shape and same `''` default as `clockScope` below,
   * for the same reason — one slot, sometimes empty.
   */
  expanded: string
  /**
   * Whether the probe layer is drawn.
   *
   * The emulator exists to answer "is this what the parent sees?", and until now it could
   * not: every template chip, cost, ttl and wire warning sat in the frame, so no screenshot
   * of a pane was ever evidence about a handset. Off, the panes are WhatsApp and nothing
   * else. The instrumentation is not deleted by this — it is the reason the surface exists —
   * it is put down for as long as somebody is looking at the message instead of the machine.
   */
  chrome: boolean
  /**
   * Which WhatsApp theme the panes wear.
   *
   * Not `prefers-color-scheme`. Most developers run dark and most parents run light, and
   * "what does this actually look like on her phone" is a question the operator's own OS
   * setting cannot answer.
   */
  waTheme: 'dark' | 'light'
  threads: Record<string, ThreadState>
  events: EmuEvent[]
  cursor: string | null
  filters: EventFilters
  connection: Connection
  busy: Record<string, boolean>
  /** Unseen event counts per closed contact pane — drives the tray's activity dots. */
  activity: Record<string, number>
  toasts: Toast[]
  showTray: boolean
  showLog: boolean
  autoDelivery: AutoDelivery
  /**
   * Whose clock the bar's controls move. `''` is the world clock — the default,
   * and what every control did unconditionally before this existed.
   *
   * 0024 gave `sim_clock` a per-tenant row and the clock route has accepted an
   * `academyId` ever since; the UI simply never sent one, so "advance 1d" always
   * meant *every academy without a clock of its own*, which in a world holding a
   * few leftover test tenants is a great deal more than the one being driven.
   */
  clockScope: string
}

/* ------------------------------------------------------------------ *
 * Normalisers. The API routes are written by another module; accept the
 * plausible spellings rather than shattering on one.
 * ------------------------------------------------------------------ */

type Raw = Record<string, any>

function pick(o: Raw | null | undefined, ...keys: string[]): any {
  if (!o) return undefined
  for (const k of keys) {
    const v = o[k]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  return null
}

function iso(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function arr(v: unknown): Raw[] {
  return Array.isArray(v) ? (v as Raw[]) : []
}

function asList(payload: Raw | null | undefined, ...keys: string[]): Raw[] {
  const v = pick(payload, ...keys)
  return arr(v)
}

function mediaKind(url: string, given: unknown): EmuMedia['kind'] {
  const g = str(given)
  if (g === 'image' || g === 'audio' || g === 'document' || g === 'video') return g
  const u = url.toLowerCase()
  if (u.startsWith('data:image') || /\.(png|jpe?g|gif|webp|heic)(\?|$)/.test(u)) return 'image'
  if (u.startsWith('data:audio') || /\.(ogg|opus|mp3|m4a|wav|aac)(\?|$)/.test(u)) return 'audio'
  if (u.startsWith('data:video') || /\.(mp4|mov|webm)(\?|$)/.test(u)) return 'video'
  return 'document'
}

type ActionIndex = Record<string, { consumedAt: string | null; expiresAt: string | null; mintedFor: string | null }>

function normalizeActionIndex(raw: Raw | null | undefined): ActionIndex {
  const out: ActionIndex = {}
  const rows = [
    ...asList(raw, 'actions', 'action_rows', 'actionRows'),
    ...arr(pick(raw, 'action_states', 'actionStates')),
  ]
  for (const r of rows) {
    const id = str(pick(r, 'id', 'action_id', 'actionId'))
    if (!id) continue
    out[id] = {
      consumedAt: iso(pick(r, 'consumed_at', 'consumedAt')),
      expiresAt: iso(pick(r, 'expires_at', 'expiresAt')),
      mintedFor: str(pick(r, 'minted_for_contact_id', 'mintedForContactId', 'minted_for')),
    }
  }
  return out
}

/**
 * `GET /api/emulator/thread` carries no `action` rows, but an inbound tap records the action it
 * replayed on `reply_to_action_id` (served as `replyToActionId`). That is enough to keep a spent
 * button spent across a reload, which is the visible half of §2.2.
 */
function consumedFromReplies(rows: Raw[]): ActionIndex {
  const out: ActionIndex = {}
  for (const r of rows) {
    if (str(pick(r, 'direction')) !== 'inbound') continue
    const actionId =
      str(pick(r, 'replyToActionId', 'reply_to_action_id')) ??
      str(pick((pick(r, 'payload') as Raw) ?? null, 'actionId', 'action_id'))
    if (!actionId) continue
    out[actionId] = {
      consumedAt: iso(pick(r, 'queuedAt', 'queued_at', 'at', 'createdAt', 'created_at')) ?? new Date(0).toISOString(),
      expiresAt: null,
      mintedFor: null,
    }
  }
  return out
}

function normalizeButton(raw: Raw, index: ActionIndex): EmuButton | null {
  const actionId = str(pick(raw, 'actionId', 'action_id', 'id', 'payload')) ?? ''
  const title = str(pick(raw, 'title', 'text', 'label')) ?? ''
  if (!title) return null
  const meta = index[actionId]
  return {
    actionId,
    title,
    consumedAt: iso(pick(raw, 'consumed_at', 'consumedAt')) ?? meta?.consumedAt ?? null,
    expiresAt: iso(pick(raw, 'expires_at', 'expiresAt')) ?? meta?.expiresAt ?? null,
    mintedFor: str(pick(raw, 'minted_for_contact_id', 'mintedForContactId')) ?? meta?.mintedFor ?? null,
  }
}

function normalizeList(raw: Raw | null | undefined, index: ActionIndex): EmuMessage['list'] {
  if (!raw) return null
  const sectionsRaw = asList(raw, 'sections')
  if (!sectionsRaw.length) return null
  const sections: EmuListSection[] = sectionsRaw.map((s) => ({
    title: str(pick(s, 'title')) ?? '',
    rows: asList(s, 'rows')
      .map((r) => {
        const b = normalizeButton(r, index)
        if (!b) return null
        return { ...b, description: str(pick(r, 'description', 'subtitle')) }
      })
      .filter((r): r is EmuListRow => r !== null),
  }))
  return {
    buttonText: str(pick(raw, 'buttonText', 'button_text', 'button')) ?? 'Choose',
    sections,
  }
}

function normalizeLink(raw: Raw | null | undefined): EmuMessage['link'] {
  if (!raw) return null
  const url = str(pick(raw, 'url', 'href'))
  if (!url) return null
  return { title: str(pick(raw, 'title', 'display_text', 'displayText')) ?? 'Open', url }
}

function deriveStatus(raw: Raw, ts: { sentAt: string | null; deliveredAt: string | null; readAt: string | null }): MessageStatus {
  const explicit = (str(pick(raw, 'status')) ?? '').toLowerCase()
  if (explicit === 'failed') return 'failed'
  if (explicit === 'suppressed') return 'suppressed'
  // §2.4 — never claim more than the row says. Timestamps are the claim; the status column
  // may not assert a delivery that no timestamp backs.
  if (ts.readAt) return 'read'
  if (ts.deliveredAt) return 'delivered'
  if (ts.sentAt) return 'sent'
  if (explicit === 'sent' || explicit === 'delivered' || explicit === 'read') return 'sent'
  return 'queued'
}

export function normalizeMessage(raw: Raw, index: ActionIndex, fallbackContactId?: string): EmuMessage | null {
  const id = str(pick(raw, 'id', 'message_id', 'messageId'))
  if (!id) return null
  const payload: Raw = (pick(raw, 'payload') as Raw) ?? {}
  const localIndex: ActionIndex = { ...index, ...normalizeActionIndex(raw), ...normalizeActionIndex(payload) }

  const sentAt = iso(pick(raw, 'sent_at', 'sentAt'))
  const deliveredAt = iso(pick(raw, 'delivered_at', 'deliveredAt'))
  const readAt = iso(pick(raw, 'read_at', 'readAt'))
  const queuedAt = iso(pick(raw, 'queued_at', 'queuedAt', 'created_at', 'createdAt'))

  const buttonRows = asList(raw, 'buttons').length ? asList(raw, 'buttons') : asList(payload, 'buttons')
  const seenButtons = new Set<string>()
  const buttons = buttonRows
    .map((b) => normalizeButton(b, localIndex))
    .filter((b): b is EmuButton => b !== null)
    .filter((b) => {
      const key = `${b.actionId}|${b.title}`
      if (seenButtons.has(key)) return false
      seenButtons.add(key)
      return true
    })

  const mediaUrl = str(pick(raw, 'media_url', 'mediaUrl')) ?? str(pick(payload, 'url'))
  const mediaRaw = (pick(raw, 'media') as Raw) ?? (pick(payload, 'media') as Raw) ?? null
  const resolvedMediaUrl = str(pick(mediaRaw, 'url')) ?? mediaUrl
  // An inbound row keeps the declared mime type on the payload and the bytes in `media_url`.
  // Its top-level type is the better answer than sniffing an extension: the kind is what
  // the emulator labels the bubble with, and what decides which refusal the sender reads
  // back, and a URL with no extension is otherwise indistinguishable from a document.
  const mediaMime = str(pick(payload, 'mediaMimeType', 'media_mime_type', 'mimeType'))
  const media: EmuMedia | null = resolvedMediaUrl
    ? {
        url: resolvedMediaUrl,
        kind: mediaKind(
          resolvedMediaUrl,
          pick(mediaRaw, 'kind', 'type') ?? pick(raw, 'media_kind', 'mediaKind') ?? mediaMime?.split('/')[0],
        ),
        filename: str(pick(mediaRaw, 'filename', 'name')),
      }
    : null

  const direction = (str(pick(raw, 'direction')) ?? 'outbound') === 'inbound' ? 'inbound' : 'outbound'
  const status = deriveStatus(raw, { sentAt, deliveredAt, readAt })

  return {
    id,
    contactId: str(pick(raw, 'contact_id', 'contactId')) ?? fallbackContactId ?? '',
    direction,
    body: str(pick(raw, 'body', 'text')) ?? '',
    header: str(pick(raw, 'header')) ?? str(pick(payload, 'header')),
    footer: str(pick(raw, 'footer')) ?? str(pick(payload, 'footer')),
    buttons,
    list: normalizeList((pick(raw, 'list') as Raw) ?? (pick(payload, 'list') as Raw), localIndex),
    link: normalizeLink((pick(raw, 'link') as Raw) ?? (pick(payload, 'link') as Raw)),
    media,
    catalogId: str(pick(raw, 'catalog_id', 'catalogId')),
    templateName: str(pick(raw, 'template_name', 'templateName')),
    status: direction === 'inbound' ? 'read' : status,
    queuedAt,
    sentAt,
    deliveredAt,
    readAt,
    failedReason: str(pick(raw, 'failed_reason', 'failedReason', 'error')),
    // `GET /api/emulator/thread` serves the column as `suppressedReason`; keep the other
    // spellings so a raw row works too. A suppression that does not reach here renders as an
    // ordinary bubble, which is exactly the thing §17 must never let happen.
    suppressReason: str(pick(raw, 'suppressedReason', 'suppress_reason', 'suppressReason', 'suppressed_reason')),
    senderPhone: str(pick(raw, 'sender_phone_e164', 'senderPhone', 'sender_phone', 'from')),
    costPaise: num(pick(raw, 'cost_paise', 'costPaise')),
    inWindow: bool(pick(raw, 'in_window', 'inWindow')),
    conversationCategory: str(pick(raw, 'conversation_category', 'conversationCategory')),
    waMessageId: str(pick(raw, 'wa_message_id', 'waMessageId')),
    at: iso(pick(raw, 'at', 'created_at', 'createdAt')) ?? queuedAt ?? sentAt ?? new Date().toISOString(),
    pending: false,
    pendingSince: 0,
  }
}

export function normalizeAcademy(raw: Raw): EmuAcademy | null {
  const id = str(pick(raw, 'id', 'academy_id', 'academyId'))
  if (!id) return null
  return {
    id,
    name: str(pick(raw, 'name')) ?? 'Untitled',
    timezone: str(pick(raw, 'timezone', 'tz')) ?? 'Asia/Kolkata',
    onboardingState: (str(pick(raw, 'onboarding_state', 'onboardingState')) ?? 'live') as OnboardingState,
    senderPhone: str(pick(raw, 'sender_phone_e164', 'senderPhone', 'sender_phone')),
    senderLabel: str(pick(raw, 'sender_label', 'senderLabel')),
    category: str(pick(raw, 'category')),
    rail: str(pick(raw, 'rail')),
    upiHandle: str(pick(raw, 'upi_handle', 'upiHandle')),
    // `=== true` and not a truthiness test: an absent field, a null, or a payload from a
    // deployment predating 0030 all mean "not a sandbox", which is the safe reading. The
    // badge appears only when the server positively says so.
    isSandbox: pick(raw, 'is_sandbox', 'isSandbox') === true,
  }
}

export function normalizeContact(raw: Raw): EmuContact | null {
  const id = str(pick(raw, 'id', 'contact_id', 'contactId'))
  if (!id) return null
  const rolesRaw = pick(raw, 'roles', 'role', 'role_hint', 'roleHint')
  const roles = (Array.isArray(rolesRaw) ? rolesRaw : rolesRaw ? [rolesRaw] : [])
    .map((r) => str(r))
    .filter((r): r is string => !!r) as Role[]
  return {
    id,
    academyId: str(pick(raw, 'academy_id', 'academyId')) ?? '',
    personId: str(pick(raw, 'person_id', 'personId')),
    name: str(pick(raw, 'name', 'full_name', 'fullName', 'person_name', 'personName', 'profile_name')) ?? 'Unnamed',
    phone: str(pick(raw, 'phone_e164', 'phone', 'phoneE164')),
    roles,
    state: (str(pick(raw, 'state')) ?? 'registered') as ContactState,
    optedOutAt: iso(pick(raw, 'opted_out_at', 'optedOutAt')),
    lastInboundAt: iso(pick(raw, 'last_inbound_at', 'lastInboundAt')),
    isPrimary: bool(pick(raw, 'is_primary', 'isPrimary')) ?? true,
    isSolo: bool(pick(raw, 'is_solo', 'isSolo')) ?? false,
    note: str(pick(raw, 'note', 'notes', 'label')),
    messageCount: num(pick(raw, 'message_count', 'messageCount')) ?? 0,
    lastMessageAt: iso(pick(raw, 'last_message_at', 'lastMessageAt')),
    lastMessageBody: str(pick(raw, 'last_message_body', 'lastMessageBody')),
    lastMessageDirection: ((): 'inbound' | 'outbound' | null => {
      const d = str(pick(raw, 'last_message_direction', 'lastMessageDirection'))
      return d === 'inbound' || d === 'outbound' ? d : null
    })(),
  }
}

function classifyEvent(rawKind: string, detail: Raw): EventKind {
  const k = rawKind.toLowerCase()
  if (k.includes('suppress')) return 'suppress'
  if (k === 'turn' || k.includes('model') || k.includes('llm')) return 'turn'
  if (k.includes('job')) return 'job'
  if (k.includes('clock')) return 'clock'
  if (k.includes('fault')) return 'fault'
  if (k.includes('status') || k.includes('delivery')) return 'status'
  if (k === 'inbound') return 'inbound'
  if (k === 'send' || k === 'outbound' || k === 'message') {
    if (str(pick(detail, 'direction')) === 'inbound') return 'inbound'
    // `send.ts` records a suppression as a `message` row stamped `status='failed'` with
    // `suppressed_reason` set — the reason column, not the status column, is the signal.
    if (str(pick(detail, 'suppressedReason', 'suppressed_reason', 'suppressReason'))) return 'suppress'
    if (str(pick(detail, 'status')) === 'suppressed') return 'suppress'
    return 'send'
  }
  return 'system'
}

let seqCounter = 0

export function normalizeEvent(raw: Raw): EmuEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const inner: Raw = (pick(raw, 'detail', 'data', 'meta') as Raw) ?? {}
  // The nested payload is the more specific description, so it wins on collisions.
  const detail: Raw = { ...raw, ...inner }
  const rawKind = str(pick(raw, 'kind', 'type', 'event')) ?? 'system'
  const kind = classifyEvent(rawKind, detail)
  const at = iso(pick(raw, 'at', 'created_at', 'createdAt', 'ts', 'time')) ?? new Date().toISOString()
  const seq = num(pick(raw, 'seq', 'sequence', 'n')) ?? ++seqCounter
  const id =
    str(pick(raw, 'id', 'event_id', 'eventId')) ??
    `${kind}:${at}:${seq}:${str(pick(detail, 'message_id', 'messageId')) ?? ''}`

  const jobOutcomeRaw = (str(pick(detail, 'outcome', 'result', 'job_status', 'jobStatus')) ?? '').toLowerCase()
  const jobOutcome =
    jobOutcomeRaw === 'ran' || jobOutcomeRaw === 'skipped' || jobOutcomeRaw === 'failed'
      ? (jobOutcomeRaw as 'ran' | 'skipped' | 'failed')
      : null

  const usage = (pick(detail, 'usage') as Raw) ?? {}

  return {
    id,
    seq,
    at,
    kind,
    rawKind,
    academyId: str(pick(detail, 'academy_id', 'academyId')),
    contactId: str(pick(detail, 'contact_id', 'contactId', 'to_contact_id', 'toContactId')),
    messageId: str(pick(detail, 'message_id', 'messageId')),
    summary:
      str(pick(raw, 'summary', 'message', 'text', 'label')) ??
      str(pick(detail, 'body')) ??
      `${rawKind}`,
    templateName: str(pick(detail, 'template_name', 'templateName', 'template')),
    inWindow: bool(pick(detail, 'in_window', 'inWindow')),
    costPaise: num(pick(detail, 'cost_paise', 'costPaise', 'cost')),
    senderPhone: str(pick(detail, 'sender_phone_e164', 'senderPhone', 'sender_phone', 'sender')),
    catalogId: str(pick(detail, 'catalog_id', 'catalogId')),
    status: str(pick(detail, 'status')),
    reason: str(
      pick(detail, 'reason', 'suppressedReason', 'suppress_reason', 'suppressReason', 'suppressed_reason', 'failedReason', 'failed_reason'),
    ),
    tierUsed: num(pick(detail, 'tier_used', 'tierUsed', 'conversations_today', 'tier_consumed')),
    tierLimit: num(pick(detail, 'tier_limit', 'tierLimit', 'tier_cap')),
    jobKind: str(pick(detail, 'job_kind', 'jobKind')) ?? (kind === 'job' ? str(pick(inner, 'kind')) : null),
    jobOutcome,
    error: str(pick(detail, 'error', 'last_error', 'lastError')),
    model: str(pick(detail, 'model', 'model_name', 'modelName')),
    promptTokens: num(pick(detail, 'prompt_tokens', 'promptTokens')) ?? num(pick(usage, 'promptTokens', 'prompt_tokens')),
    outputTokens: num(pick(detail, 'output_tokens', 'outputTokens')) ?? num(pick(usage, 'outputTokens', 'output_tokens')),
    cachedTokens: num(pick(detail, 'cached_tokens', 'cachedTokens')) ?? num(pick(usage, 'cachedTokens', 'cached_tokens')),
    ms: num(pick(detail, 'ms', 'latency_ms', 'latencyMs', 'duration_ms')),
    toolCalls: num(pick(detail, 'tool_calls', 'toolCalls')),
    detail,
  }
}

function normalizeClock(raw: Raw | null | undefined, prev: EmuClock): EmuClock {
  if (!raw) return prev
  const nowIso = iso(pick(raw, 'now', 'nowIso', 'iso', 'at')) ?? prev.nowIso
  return {
    nowIso,
    offsetMs: num(pick(raw, 'offset_ms', 'offsetMs')) ?? prev.offsetMs,
    nextEventAtIso: iso(pick(raw, 'next_event_at', 'nextEventAt', 'nextEvent')) ?? null,
    syncedAtMs: Date.now(),
    tenantClocks: normalizeTenantClocks(pick(raw, 'tenant_clocks', 'tenantClocks')) ?? prev.tenantClocks,
  }
}

/**
 * `null` — not `[]` — when the payload carries no tenant clocks at all, so the
 * caller can tell "the world has none" from "this route does not serve them".
 * Only the state route does; a clock reply that reset the list to empty would
 * make the bar's blast-radius line flicker to "every academy" after each move.
 */
function normalizeTenantClocks(raw: unknown): { academyId: string; offsetMs: number }[] | null {
  if (!Array.isArray(raw)) return null
  return raw
    .map((r) => {
      const row = r as Raw
      const academyId = str(pick(row, 'academy_id', 'academyId'))
      if (!academyId) return null
      return { academyId, offsetMs: num(pick(row, 'offset_ms', 'offsetMs')) ?? 0 }
    })
    .filter((r): r is { academyId: string; offsetMs: number } => r !== null)
}

function normalizeFaults(raw: unknown, prev: EmulatorState['faults']): EmulatorState['faults'] {
  const next = { ...prev }
  const rows: Raw[] = Array.isArray(raw)
    ? (raw as Raw[])
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Raw).map(([k, v]) =>
          v && typeof v === 'object' ? { kind: k, ...(v as Raw) } : { kind: k, active: !!v },
        )
      : []
  for (const r of rows) {
    const kind = str(pick(r, 'kind', 'name')) as FaultKind | null
    if (!kind || !(FAULT_KINDS as readonly string[]).includes(kind)) continue
    next[kind] = {
      active: bool(pick(r, 'active', 'enabled')) ?? false,
      rate: num(pick(r, 'rate', 'probability')) ?? 1,
    }
  }
  return next
}

function normalizeScenarios(raw: unknown): ScenarioMeta[] {
  const rows = Array.isArray(raw) ? raw : []
  const out: ScenarioMeta[] = []
  for (const r of rows) {
    if (typeof r === 'string') out.push({ id: r, name: r, description: null })
    else if (r && typeof r === 'object') {
      const id = str(pick(r as Raw, 'id', 'key', 'name', 'scenario'))
      if (!id) continue
      out.push({
        id,
        name: str(pick(r as Raw, 'name', 'title', 'label')) ?? id,
        description: str(pick(r as Raw, 'description', 'summary')),
      })
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Time helpers — everything user-facing renders in the academy's tz.
 * ------------------------------------------------------------------ */

function safeTz(tz: string | null | undefined): string {
  if (!tz) return 'Asia/Kolkata'
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz })
    return tz
  } catch {
    return 'Asia/Kolkata'
  }
}

export function fmtTime(when: string | Date, tz: string): string {
  const d = typeof when === 'string' ? new Date(when) : when
  if (Number.isNaN(d.getTime())) return '--:--'
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: safeTz(tz),
  })
    .format(d)
    .toLowerCase()
}

export function fmtDay(when: string | Date, tz: string): string {
  const d = typeof when === 'string' ? new Date(when) : when
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: safeTz(tz),
  }).format(d)
}

export function fmtStamp(when: string | Date, tz: string): string {
  return `${fmtDay(when, tz)} · ${fmtTime(when, tz)}`
}

export function fmtClockSeconds(when: string | Date, tz: string): string {
  const d = typeof when === 'string' ? new Date(when) : when
  if (Number.isNaN(d.getTime())) return '--:--:--'
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: safeTz(tz),
  }).format(d)
}

function tzOffsetMs(d: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: safeTz(tz),
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  const parts: Record<string, string> = {}
  for (const p of dtf.formatToParts(d)) parts[p.type] = p.value
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  )
  return asUtc - d.getTime()
}

/** `YYYY-MM-DDTHH:mm` wall-clock in `tz` → the real instant. */
export function zonedInputToIso(local: string, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(local)) return null
  const naive = new Date(`${local.slice(0, 16)}:00Z`)
  if (Number.isNaN(naive.getTime())) return null
  let guess = new Date(naive.getTime() - tzOffsetMs(naive, tz))
  guess = new Date(naive.getTime() - tzOffsetMs(guess, tz))
  return guess.toISOString()
}

/** The instant → a `YYYY-MM-DDTHH:mm` wall-clock string in `tz`, for `<input type=datetime-local>`. */
export function isoToZonedInput(when: string, tz: string): string {
  const d = new Date(when)
  if (Number.isNaN(d.getTime())) return ''
  const shifted = new Date(d.getTime() + tzOffsetMs(d, tz))
  return shifted.toISOString().slice(0, 16)
}

export function fmtDuration(ms: number): string {
  const neg = ms < 0
  let s = Math.round(Math.abs(ms) / 1000)
  const d = Math.floor(s / 86400)
  s -= d * 86400
  const h = Math.floor(s / 3600)
  s -= h * 3600
  const m = Math.floor(s / 60)
  const parts: string[] = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  if (m && !d) parts.push(`${m}m`)
  if (!parts.length) parts.push(`${s}s`)
  return (neg ? '-' : '') + parts.join(' ')
}

export function fmtPaise(paise: number | null): string {
  if (paise === null) return '—'
  if (paise === 0) return 'free'
  return `₹${(paise / 100).toFixed(2)}`
}

/** §14.7 — `contact.last_inbound_at` is the source of truth for the 24h window. */
export function windowState(contact: EmuContact | null | undefined, nowIso: string): { open: boolean; msLeft: number } {
  if (!contact?.lastInboundAt) return { open: false, msLeft: 0 }
  const left = new Date(contact.lastInboundAt).getTime() + 24 * 3600 * 1000 - new Date(nowIso).getTime()
  return { open: left > 0, msLeft: Math.max(0, left) }
}

/** Structural honesty (§17): the emulator enforces the real Cloud API's limits. */
export function limitViolations(m: EmuMessage): string[] {
  const out: string[] = []
  const interactive = m.buttons.length > 0 || !!m.list || !!m.link
  const cap = interactive ? LIMITS.bodyChars : LIMITS.textChars
  if (m.body.length > cap) out.push(`body ${m.body.length}/${cap}`)
  // §14.6 — a link is a button. A url sitting in the text is the failure this whole
  // shape exists to make impossible, so the emulator shows it as one.
  if (/https?:\/\//i.test(m.body) && !/https?:\/\/(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)\b/i.test(m.body)) {
    out.push('a url in the body — links are buttons, never text')
  }
  if (m.link) {
    if (m.buttons.length) out.push('a link and reply buttons cannot share a message')
    if (m.list) out.push('a link and a list cannot share a message')
    if (m.link.title.length > LIMITS.buttonTitleChars)
      out.push(`link title ${m.link.title.length}/${LIMITS.buttonTitleChars}`)
  }
  if (m.buttons.length > LIMITS.buttons) out.push(`${m.buttons.length} buttons / max ${LIMITS.buttons}`)
  for (const b of m.buttons) {
    if (b.title.length > LIMITS.buttonTitleChars) out.push(`button "${b.title.slice(0, 12)}…" ${b.title.length}/${LIMITS.buttonTitleChars}`)
  }
  if (m.header && m.header.length > LIMITS.headerChars) out.push(`header ${m.header.length}/${LIMITS.headerChars}`)
  if (m.footer && m.footer.length > LIMITS.footerChars) out.push(`footer ${m.footer.length}/${LIMITS.footerChars}`)
  if (m.list) {
    const rows = m.list.sections.reduce((n, s) => n + s.rows.length, 0)
    if (rows > LIMITS.listRows) out.push(`${rows} list rows / max ${LIMITS.listRows}`)
    // The three limits below are as real as the row count — `validateOutbound` rejects a send
    // that breaks any of them — and the emulator enforced none of them, so a list Meta would
    // refuse rendered here as if it were fine. That is the exact inversion of §17's promise
    // that "something that works here works there".
    if (m.list.buttonText.length > EXTRA_LIMITS.listButtonTextChars)
      out.push(`list button "${m.list.buttonText.slice(0, 12)}…" ${m.list.buttonText.length}/${EXTRA_LIMITS.listButtonTextChars}`)
    if (m.list.sections.length > EXTRA_LIMITS.listSections)
      out.push(`${m.list.sections.length} list sections / max ${EXTRA_LIMITS.listSections}`)
    for (const s of m.list.sections) {
      if (s.title.length > LIMITS.listSectionTitleChars)
        out.push(`section "${s.title.slice(0, 12)}…" ${s.title.length}/${LIMITS.listSectionTitleChars}`)
      for (const r of s.rows) {
        if (r.title.length > LIMITS.listRowTitleChars)
          out.push(`row "${r.title.slice(0, 12)}…" ${r.title.length}/${LIMITS.listRowTitleChars}`)
        if (r.description && r.description.length > EXTRA_LIMITS.listRowDescriptionChars)
          out.push(
            `row "${r.title.slice(0, 12)}…" description ${r.description.length}/${EXTRA_LIMITS.listRowDescriptionChars}`,
          )
      }
    }
  }
  if (m.templateName && !(TEMPLATE_NAMES as readonly string[]).includes(m.templateName))
    out.push(`unknown template "${m.templateName}"`)
  return out
}

export function buttonDisabled(
  b: { consumedAt: string | null; expiresAt: string | null; actionId: string },
  nowIso: string,
): string | null {
  if (!b.actionId) return 'no action minted'
  if (b.consumedAt) return 'already used'
  if (b.expiresAt && new Date(b.expiresAt).getTime() <= new Date(nowIso).getTime()) return 'expired'
  return null
}

/** Milliseconds from the simulated now until `when`. Negative once it is past. */
export function msUntil(when: string | null, nowIso: string): number | null {
  if (!when) return null
  const t = new Date(when).getTime()
  if (Number.isNaN(t)) return null
  return t - new Date(nowIso).getTime()
}

/**
 * What this row carries that the **wire would not deliver**, as a sentence.
 *
 * §17's contract runs in one direction only: the emulator may show less than production
 * sends, never more. Media broke it. `asTemplateMessage` strips the header, the footer, the
 * list and the link when a message goes out of window, and it keeps `media` — but a template
 * send is `type: 'template'` with body parameters and one quick-reply payload, and there is
 * nowhere in that shape for an image. So the bytes are stored on the row, the emulator drew
 * them, and the parent's handset would have received a line of text with no photo. The one
 * case §7.1 calls the biggest friction reducer in the product is exactly the case where this
 * lies loudest, so the emulator says what actually lands instead of drawing what did not.
 *
 * The list and link cases are the same failure through a different door: `buildPayload` rides
 * media as an image *header*, and it only attaches a header to a list or a `cta_url` when
 * that header is text. This asks what **this codebase sends**, not what Meta would accept —
 * the emulator's job is to be the other implementation of one transport, so the line it draws
 * has to be `transport-cloud.ts`'s line.
 */
export function droppedOnTheWire(m: EmuMessage): string | null {
  if (m.direction !== 'outbound' || !m.media) return null
  if (m.templateName) {
    return `a ${m.media.kind} is on this row, and an approved template carries body parameters and one quick-reply payload — nothing else. This never reaches the handset.`
  }
  if (m.list) {
    return `a ${m.media.kind} is on this row, and a list's header is text only — the send path drops it. This never reaches the handset.`
  }
  if (m.link) {
    return `a ${m.media.kind} is on this row, and a cta_url goes out with a text header only — the send path drops it. This never reaches the handset.`
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Reducer
 * ------------------------------------------------------------------ */

const DEFAULT_FILTERS = (): EventFilters => ({
  academyId: 'all',
  kinds: EVENT_KINDS.reduce((acc, k) => ({ ...acc, [k]: true }), {} as Record<EventKind, boolean>),
  q: '',
})

const initialState: EmulatorState = {
  booted: false,
  loading: true,
  error: null,
  scenario: null,
  scenarios: [],
  academies: [],
  contacts: [],
  clock: {
    nowIso: new Date().toISOString(),
    offsetMs: 0,
    nextEventAtIso: null,
    syncedAtMs: Date.now(),
    tenantClocks: [],
  },
  faults: FAULT_KINDS.reduce(
    (acc, k) => ({ ...acc, [k]: { active: false, rate: 1 } }),
    {} as EmulatorState['faults'],
  ),
  panes: [],
  pinned: [],
  expanded: '',
  chrome: true,
  waTheme: 'dark',
  threads: {},
  events: [],
  cursor: null,
  filters: DEFAULT_FILTERS(),
  connection: 'connecting',
  busy: {},
  activity: {},
  toasts: [],
  showTray: true,
  showLog: true,
  autoDelivery: 'off',
  clockScope: '',
}

type Action =
  | { type: 'state/loading' }
  | { type: 'state/error'; error: string }
  | { type: 'state/loaded'; payload: Raw }
  | { type: 'clock/set'; payload: Raw }
  | { type: 'thread/loading'; contactId: string }
  | { type: 'thread/loaded'; contactId: string; payload: Raw }
  | { type: 'thread/error'; contactId: string; error: string }
  | { type: 'thread/optimistic'; contactId: string; message: EmuMessage }
  | { type: 'thread/consume'; contactId: string; actionId: string; atIso: string }
  | { type: 'events/append'; events: EmuEvent[]; cursor: string | null }
  | { type: 'pane/open'; contactId: string }
  | { type: 'pane/close'; contactId: string }
  | { type: 'pane/closeAll' }
  | { type: 'pane/restore'; panes: string[]; pinned: string[] }
  | { type: 'pane/move'; contactId: string; dir: -1 | 1 }
  | { type: 'pane/pin'; contactId: string }
  | { type: 'pane/unpin'; contactId: string }
  /** `''` collapses, exactly as `clock/scope` uses `''` for the world. */
  | { type: 'pane/expand'; contactId: string }
  | { type: 'ui/chrome'; value: boolean }
  | { type: 'ui/waTheme'; value: 'dark' | 'light' }
  | { type: 'filters/set'; patch: Partial<EventFilters> }
  | { type: 'connection'; value: Connection }
  | { type: 'busy'; key: string; value: boolean }
  | { type: 'fault/set'; kind: FaultKind; active: boolean; rate: number }
  | { type: 'toast'; toast: Toast }
  | { type: 'toast/dismiss'; id: string }
  | { type: 'ui/toggle'; key: 'showTray' | 'showLog' }
  | { type: 'scenario/set'; scenario: string }
  | { type: 'delivery/mode'; mode: AutoDelivery }
  | { type: 'clock/scope'; academyId: string }

/**
 * Pinned first, everything else in the order it already had.
 *
 * A stable partition rather than a sort: `panes` is an order an operator built by hand with
 * the ‹ › controls, and a comparator that ties on "both unpinned" would be free to shuffle
 * it. Run after every mutation that can move an id, so "pinned means the front of the deck"
 * is a property of the array itself rather than a rule the deck re-applies at render time.
 */
function orderPanes(panes: string[], pinned: string[]): string[] {
  const isPinned = new Set(pinned)
  const front = pinned.filter((id) => panes.includes(id))
  return [...front, ...panes.filter((id) => !isPinned.has(id))]
}

function mergeMessages(prev: EmuMessage[], incoming: EmuMessage[]): EmuMessage[] {
  // A refetch is authoritative. Optimistic echoes survive only briefly, so a slow round trip
  // never looks like the message was swallowed.
  const sorted = [...incoming].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  const landed = new Set(sorted.filter((m) => m.direction === 'inbound').map((m) => m.body.trim()))
  const stillPending = prev.filter(
    (m) => m.pending && Date.now() - m.pendingSince < 5000 && !landed.has(m.body.trim()),
  )
  return [...sorted, ...stillPending]
}

function echo(contactId: string, body: string, nowIso: string): EmuMessage {
  return {
    id: `pending:${contactId}:${Date.now()}`,
    contactId,
    direction: 'inbound',
    body,
    header: null,
    footer: null,
    buttons: [],
    list: null,
    link: null,
    media: null,
    catalogId: null,
    templateName: null,
    status: 'read',
    queuedAt: nowIso,
    sentAt: nowIso,
    deliveredAt: nowIso,
    readAt: nowIso,
    failedReason: null,
    suppressReason: null,
    senderPhone: null,
    costPaise: null,
    inWindow: true,
    conversationCategory: null,
    waMessageId: null,
    at: nowIso,
    pending: true,
    pendingSince: Date.now(),
  }
}

function reducer(state: EmulatorState, action: Action): EmulatorState {
  switch (action.type) {
    case 'state/loading':
      return { ...state, loading: true }
    case 'state/error':
      return { ...state, loading: false, booted: true, error: action.error }
    case 'state/loaded': {
      const p = action.payload
      const academies = asList(p, 'academies', 'academy')
        .map(normalizeAcademy)
        .filter((a): a is EmuAcademy => a !== null)
      const contacts = asList(p, 'contacts', 'contact')
        .map(normalizeContact)
        .filter((c): c is EmuContact => c !== null)
      const known = new Set(contacts.map((c) => c.id))
      const scenarios = normalizeScenarios(pick(p, 'scenarios', 'worlds'))
      return {
        ...state,
        loading: false,
        booted: true,
        error: null,
        academies,
        contacts,
        scenario: str(pick(p, 'scenario', 'world', 'seed')) ?? state.scenario,
        scenarios: scenarios.length ? scenarios : state.scenarios,
        clock: normalizeClock(pick(p, 'clock', 'time') as Raw, state.clock),
        faults: normalizeFaults(pick(p, 'faults'), state.faults),
        panes: contacts.length ? state.panes.filter((id) => known.has(id)) : state.panes,
        pinned: contacts.length ? state.pinned.filter((id) => known.has(id)) : state.pinned,
        /**
         * An expanded pane whose contact left the world collapses back to the row.
         * Otherwise a reseed leaves the deck rendering a single "not in this world"
         * card at full width, with every other open pane hidden behind it and no
         * obvious way back — the dangling-id failure the scope comment below is about,
         * except this one takes the whole surface with it.
         */
        expanded: state.expanded && contacts.length && !known.has(state.expanded) ? '' : state.expanded,
        /**
         * A scope pointed at an academy that no longer exists falls back to the
         * world. Seeding a fixture drops every academy in the world, so without
         * this the bar would keep posting a dead uuid and the route would happily
         * create a clock row for a tenant that is gone — while the selector, which
         * can only render academies it can find, silently showed "world".
         */
        clockScope:
          state.clockScope && !academies.some((a) => a.id === state.clockScope)
            ? ''
            : state.clockScope,
      }
    }
    case 'scenario/set':
      return { ...state, scenario: action.scenario }
    case 'clock/set':
      return { ...state, clock: normalizeClock(action.payload, state.clock) }
    case 'thread/loading': {
      const t = state.threads[action.contactId]
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.contactId]: { messages: t?.messages ?? [], loading: true, error: null, loadedAt: t?.loadedAt ?? 0 },
        },
      }
    }
    case 'thread/loaded': {
      const p = action.payload
      const rows = asList(p, 'messages', 'thread', 'rows')
      const index = { ...consumedFromReplies(rows), ...normalizeActionIndex(p) }
      const messages = rows
        .map((m) => normalizeMessage(m, index, action.contactId))
        .filter((m): m is EmuMessage => m !== null)
      const prev = state.threads[action.contactId]?.messages ?? []
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.contactId]: {
            messages: mergeMessages(prev, messages),
            loading: false,
            error: null,
            loadedAt: Date.now(),
          },
        },
      }
    }
    case 'thread/error': {
      const t = state.threads[action.contactId]
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.contactId]: { messages: t?.messages ?? [], loading: false, error: action.error, loadedAt: t?.loadedAt ?? 0 },
        },
      }
    }
    case 'thread/optimistic': {
      const t = state.threads[action.contactId]
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.contactId]: {
            messages: [...(t?.messages ?? []), action.message],
            loading: t?.loading ?? false,
            error: null,
            loadedAt: t?.loadedAt ?? 0,
          },
        },
      }
    }
    case 'thread/consume': {
      const t = state.threads[action.contactId]
      if (!t) return state
      return {
        ...state,
        threads: {
          ...state.threads,
          [action.contactId]: {
            ...t,
            messages: t.messages.map((m) => ({
              ...m,
              buttons: m.buttons.map((b) =>
                b.actionId === action.actionId && !b.consumedAt ? { ...b, consumedAt: action.atIso } : b,
              ),
              list: m.list
                ? {
                    ...m.list,
                    sections: m.list.sections.map((s) => ({
                      ...s,
                      rows: s.rows.map((r) =>
                        r.actionId === action.actionId && !r.consumedAt ? { ...r, consumedAt: action.atIso } : r,
                      ),
                    })),
                  }
                : null,
            })),
          },
        },
      }
    }
    case 'events/append': {
      if (!action.events.length) return { ...state, cursor: action.cursor ?? state.cursor }
      const seen = new Set(state.events.map((e) => e.id))
      const fresh = action.events.filter((e) => !seen.has(e.id))
      if (!fresh.length) return { ...state, cursor: action.cursor ?? state.cursor }
      const merged = [...fresh, ...state.events]
        .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime() || b.seq - a.seq)
        .slice(0, 2000)
      const activity = { ...state.activity }
      const open = new Set(state.panes)
      for (const e of fresh) {
        if (e.contactId && !open.has(e.contactId) && (e.kind === 'send' || e.kind === 'inbound' || e.kind === 'suppress')) {
          activity[e.contactId] = (activity[e.contactId] ?? 0) + 1
        }
      }
      return { ...state, events: merged, cursor: action.cursor ?? state.cursor, activity }
    }
    case 'pane/open': {
      const activity = { ...state.activity }
      delete activity[action.contactId]
      if (state.panes.includes(action.contactId)) return { ...state, activity }
      // Behind the pins, never in front of them: a pin is a claim on the front of the deck,
      // and an open that jumped it would make the pin look like it had come undone.
      return { ...state, panes: orderPanes([...state.panes, action.contactId], state.pinned), activity }
    }
    case 'pane/close':
      // Closing drops the pin too, so `pinned` can never name an id with no pane. That
      // debris would resurface on the next open and silently reorder the deck.
      return {
        ...state,
        panes: state.panes.filter((p) => p !== action.contactId),
        pinned: state.pinned.filter((p) => p !== action.contactId),
        expanded: state.expanded === action.contactId ? '' : state.expanded,
      }
    case 'pane/closeAll': {
      // A pin is a statement that this thread outlives a sweep, and this is the sweep.
      const panes = state.panes.filter((id) => state.pinned.includes(id))
      return { ...state, panes, expanded: panes.includes(state.expanded) ? state.expanded : '' }
    }
    case 'pane/restore':
      return { ...state, panes: orderPanes(action.panes, action.pinned), pinned: action.pinned }
    case 'pane/move': {
      const i = state.panes.indexOf(action.contactId)
      const j = i + action.dir
      if (i < 0 || j < 0 || j >= state.panes.length) return state
      // A swap across the pin boundary is a pin or an unpin, not a move. Allowing it would
      // leave `panes` in a shape `orderPanes` immediately undoes, which reads to an operator
      // as the button simply not working.
      if (state.pinned.includes(action.contactId) !== state.pinned.includes(state.panes[j])) return state
      const panes = [...state.panes]
      const [p] = panes.splice(i, 1)
      panes.splice(j, 0, p)
      return { ...state, panes }
    }
    case 'pane/pin': {
      if (state.pinned.includes(action.contactId)) return state
      const pinned = [...state.pinned, action.contactId]
      return { ...state, pinned, panes: orderPanes(state.panes, pinned) }
    }
    case 'pane/unpin': {
      if (!state.pinned.includes(action.contactId)) return state
      const pinned = state.pinned.filter((p) => p !== action.contactId)
      // The pane keeps the slot it was floated to. Putting it back where it sat before the
      // pin would mean remembering that position, and an unpin is a statement about
      // importance rather than a request to be moved somewhere.
      return { ...state, pinned, panes: orderPanes(state.panes, pinned) }
    }
    case 'pane/expand':
      return { ...state, expanded: action.contactId }
    case 'ui/chrome':
      return { ...state, chrome: action.value }
    case 'ui/waTheme':
      return { ...state, waTheme: action.value }
    case 'filters/set':
      return { ...state, filters: { ...state.filters, ...action.patch } }
    case 'connection':
      return { ...state, connection: action.value }
    case 'busy': {
      const busy = { ...state.busy }
      if (action.value) busy[action.key] = true
      else delete busy[action.key]
      return { ...state, busy }
    }
    case 'fault/set':
      return { ...state, faults: { ...state.faults, [action.kind]: { active: action.active, rate: action.rate } } }
    case 'toast':
      return { ...state, toasts: [...state.toasts.slice(-4), action.toast] }
    case 'toast/dismiss':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
    case 'ui/toggle':
      return action.key === 'showTray'
        ? { ...state, showTray: !state.showTray }
        : { ...state, showLog: !state.showLog }
    case 'delivery/mode':
      return { ...state, autoDelivery: action.mode }
    case 'clock/scope':
      return { ...state, clockScope: action.academyId }
    default:
      return state
  }
}

/* ------------------------------------------------------------------ *
 * Transport to the API routes (CONTRACTS §9)
 * ------------------------------------------------------------------ */

async function api<T = Raw>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  })
  const text = await res.text()
  let json: any = null
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  if (!res.ok) {
    const msg = (json && (json.error ?? json.message)) || text.slice(0, 240) || `${res.status} ${res.statusText}`
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
  }
  return (json ?? ({} as any)) as T
}

const post = (path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export type EmulatorActions = {
  refreshState: () => Promise<void>
  refreshThread: (contactId: string) => Promise<void>
  refreshEvents: () => Promise<void>
  seed: (scenario: string) => Promise<void>
  openPane: (contactId: string) => void
  closePane: (contactId: string) => void
  closeAllPanes: () => void
  movePane: (contactId: string, dir: -1 | 1) => void
  /** Hold this thread at the front of the deck; survives close-the-rest and a reload. */
  pinPane: (contactId: string) => void
  unpinPane: (contactId: string) => void
  /** Blow one pane up to fill the deck, or `''` to go back to the row. */
  expandPane: (contactId: string) => void
  /** Put the probe layer down and leave the handset. */
  setChrome: (value: boolean) => void
  setWaTheme: (value: 'dark' | 'light') => void
  advance: (ms: number) => Promise<void>
  jumpToNextEvent: () => Promise<void>
  setClockTo: (iso: string) => Promise<void>
  resetClock: () => Promise<void>
  tick: () => Promise<void>
  /** Point the clock controls at one tenant, or at `''` for the world. */
  setClockScope: (academyId: string) => void
  sendText: (contactId: string, text: string) => Promise<void>
  sendMedia: (
    contactId: string,
    media: { url: string; mimeType: string; filename?: string },
    caption?: string,
  ) => Promise<void>
  tapAction: (contactId: string, actionId: string, label?: string) => Promise<void>
  /**
   * §2.4 has four rungs and the UI had one control, wired to the top of the ladder: every
   * hand-driven message jumped `sent → read` and `delivered` was unreachable, so the one
   * state where a message is on the handset and unread — the state most delivery questions
   * are actually about — could not be produced at all.
   */
  advanceStatus: (contactId: string, messageId: string, status: 'delivered' | 'read') => Promise<void>
  /** Advance every outbound message the transport has accepted, world-wide. */
  runDelivery: (mode: 'delivered' | 'read') => Promise<{ advanced: number }>
  setAutoDelivery: (mode: AutoDelivery) => void
  /** Adds a throwaway person to the live world and opens them as a pane. */
  createTestContact: (input: {
    academyId: string
    name: string
    role: 'client' | 'coach' | 'admin' | 'prospect'
    phone?: string
  }) => Promise<void>
  /**
   * §17's world is "a world, not four panes", and the emulator could not make one.
   * `POST /api/emulator/academy` existed and nothing in the UI called it, so trying a
   * second business meant reseeding a fixture and losing the first — which is exactly
   * the all-or-nothing state the driver already grew `academy` / `drop` to escape.
   */
  createAcademy: (input: {
    name: string
    adminName: string
    adminPhone?: string
    category?: string
    timezone?: string
  }) => Promise<void>
  dropAcademy: (academyId: string, name: string) => Promise<void>
  setFault: (kind: FaultKind, active: boolean, rate: number) => Promise<void>
  setFilters: (patch: Partial<EventFilters>) => void
  toggle: (key: 'showTray' | 'showLog') => void
  dismissToast: (id: string) => void
  notify: (tone: Toast['tone'], text: string) => void
}

type Ctx = { state: EmulatorState; actions: EmulatorActions }

const EmulatorContext = createContext<Ctx | null>(null)

const PANES_KEY = 'cm.emulator.panes'
const PINNED_KEY = 'cm.emulator.pinned'
const UI_KEY = 'cm.emulator.ui'

let toastSeq = 0

export function EmulatorProvider(props: { children?: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const stateRef = useRef(state)
  stateRef.current = state

  const notify = useCallback((tone: Toast['tone'], text: string) => {
    const toast: Toast = { id: `t${++toastSeq}`, tone, text, at: Date.now() }
    dispatch({ type: 'toast', toast })
    setTimeout(() => dispatch({ type: 'toast/dismiss', id: toast.id }), tone === 'error' ? 9000 : 4500)
  }, [])

  const withBusy = useCallback(
    async (key: string, fn: () => Promise<void>) => {
      dispatch({ type: 'busy', key, value: true })
      try {
        await fn()
      } catch (e) {
        notify('error', `${key}: ${(e as Error).message}`)
      } finally {
        dispatch({ type: 'busy', key, value: false })
      }
    },
    [notify],
  )

  const refreshState = useCallback(async () => {
    try {
      const payload = await api('/api/emulator/state')
      dispatch({ type: 'state/loaded', payload })
    } catch (e) {
      dispatch({ type: 'state/error', error: (e as Error).message })
    }
  }, [])

  const refreshThread = useCallback(async (contactId: string) => {
    if (!contactId) return
    dispatch({ type: 'thread/loading', contactId })
    try {
      const payload = await api(`/api/emulator/thread?contactId=${encodeURIComponent(contactId)}`)
      dispatch({ type: 'thread/loaded', contactId, payload })
    } catch (e) {
      dispatch({ type: 'thread/error', contactId, error: (e as Error).message })
    }
  }, [])

  const refreshEvents = useCallback(async () => {
    const cursor = stateRef.current.cursor
    try {
      const payload = await api(`/api/emulator/events${cursor ? `?since=${encodeURIComponent(cursor)}` : ''}`)
      const rows = Array.isArray(payload) ? (payload as Raw[]) : asList(payload as Raw, 'events', 'rows', 'log')
      const events = rows.map(normalizeEvent).filter((e): e is EmuEvent => e !== null)
      const nextCursor =
        str(pick(payload as Raw, 'cursor', 'nextCursor', 'next_cursor')) ??
        (events.length
          ? String(
              events.reduce((best, e) => (new Date(e.at).getTime() > new Date(best.at).getTime() ? e : best), events[0]).at,
            )
          : cursor)
      dispatch({ type: 'events/append', events, cursor: nextCursor })
    } catch {
      /* the log is best-effort; a failed poll must not break the panes */
    }
  }, [])

  const refreshOpenThreads = useCallback(async () => {
    await Promise.all(stateRef.current.panes.map((id) => refreshThread(id)))
  }, [refreshThread])

  /* --- debounced refresh scheduling, driven by the SSE stream --- */
  const timers = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({})
  const schedule = useCallback((key: string, ms: number, fn: () => void) => {
    const t = timers.current[key]
    if (t) clearTimeout(t)
    timers.current[key] = setTimeout(() => {
      timers.current[key] = undefined
      fn()
    }, ms)
  }, [])

  useEffect(() => {
    const pending = timers.current
    return () => {
      for (const t of Object.values(pending)) if (t) clearTimeout(t)
    }
  }, [])

  const nudgeEvents = useCallback(() => schedule('events', 120, () => void refreshEvents()), [schedule, refreshEvents])
  const nudgeState = useCallback(() => schedule('state', 400, () => void refreshState()), [schedule, refreshState])
  const nudgeThread = useCallback(
    (contactId: string | null) => {
      if (contactId && stateRef.current.panes.includes(contactId)) {
        schedule(`thread:${contactId}`, 100, () => void refreshThread(contactId))
      } else if (!contactId) {
        schedule('threads', 150, () => void refreshOpenThreads())
      }
    },
    [schedule, refreshThread, refreshOpenThreads],
  )

  /* --- boot --- */
  useEffect(() => {
    void refreshState()
    void refreshEvents()
    // Panes and pins are read in ONE pass and restored in ONE dispatch. Two dispatches
    // would let the deck paint an unpinned order for a frame, and reading in a later effect
    // would race the save effect below, which writes the initial `[]` before a restore in a
    // separate pass could land.
    try {
      const raw = window.localStorage.getItem(PANES_KEY)
      const rawPinned = window.localStorage.getItem(PINNED_KEY)
      if (raw) {
        const panes = JSON.parse(raw)
        if (Array.isArray(panes) && panes.every((p) => typeof p === 'string')) {
          const kept = panes.slice(0, 12)
          const parsedPins: unknown = rawPinned ? JSON.parse(rawPinned) : []
          // A pin for a pane that is not open is debris: restoring it would float a contact
          // to the front the moment they were next opened, for no reason on screen.
          const pinned =
            Array.isArray(parsedPins) && parsedPins.every((p) => typeof p === 'string')
              ? (parsedPins as string[]).filter((id) => kept.includes(id))
              : []
          dispatch({ type: 'pane/restore', panes: kept, pinned })
        }
      }
    } catch {
      /* ignore */
    }
    // The two view preferences are read in the same pass and validated by enumeration —
    // anything that is not one of the known values falls back to the default rather than
    // being trusted, because this is user-writable storage.
    try {
      const raw = window.localStorage.getItem(UI_KEY)
      if (raw) {
        const ui = JSON.parse(raw) as Record<string, unknown>
        if (typeof ui?.chrome === 'boolean') dispatch({ type: 'ui/chrome', value: ui.chrome })
        if (ui?.waTheme === 'dark' || ui?.waTheme === 'light') dispatch({ type: 'ui/waTheme', value: ui.waTheme })
      }
    } catch {
      /* ignore */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    try {
      window.localStorage.setItem(PANES_KEY, JSON.stringify(state.panes))
    } catch {
      /* ignore */
    }
  }, [state.panes])

  // Its own key and its own effect, so pinning does not rewrite the panes entry and a
  // corrupt value in one cannot cost the other.
  useEffect(() => {
    try {
      window.localStorage.setItem(PINNED_KEY, JSON.stringify(state.pinned))
    } catch {
      /* ignore */
    }
  }, [state.pinned])

  useEffect(() => {
    try {
      window.localStorage.setItem(UI_KEY, JSON.stringify({ chrome: state.chrome, waTheme: state.waTheme }))
    } catch {
      /* ignore */
    }
  }, [state.chrome, state.waTheme])

  /**
   * `expanded` is deliberately NOT persisted. `panes` survives a reload because it is a
   * layout an operator built; an expanded pane is a momentary way of looking at one of them,
   * and restoring full-screen on boot would hide a deck nobody remembers collapsing.
   */

  /* Load a thread the moment its pane opens. */
  const loadedPanes = useRef<Set<string>>(new Set())
  useEffect(() => {
    for (const id of state.panes) {
      if (!loadedPanes.current.has(id)) {
        loadedPanes.current.add(id)
        void refreshThread(id)
      }
    }
    for (const id of Array.from(loadedPanes.current)) {
      if (!state.panes.includes(id)) loadedPanes.current.delete(id)
    }
  }, [state.panes, refreshThread])

  /* --- SSE: live push, with reconnect on drop --- */
  useEffect(() => {
    let closed = false
    let es: EventSource | null = null
    let attempt = 0
    let retry: ReturnType<typeof setTimeout> | undefined
    let poll: ReturnType<typeof setInterval> | undefined

    const handle = (data: string, listener?: string) => {
      let payload: Raw = {}
      if (data && data !== 'ping') {
        try {
          payload = JSON.parse(data)
        } catch {
          payload = { type: listener ?? 'system', summary: data }
        }
      }
      const type = (str(pick(payload, 'type', 'kind', 'event')) ?? listener ?? 'system').toLowerCase()
      if (type === 'ping' || type === 'keepalive') return

      nudgeEvents()
      if (type === 'clock') {
        const clock = (pick(payload, 'clock') as Raw) ?? payload
        dispatch({ type: 'clock/set', payload: clock })
        nudgeState()
        nudgeThread(null)
        return
      }
      if (type === 'seed' || type === 'world' || type === 'state') {
        nudgeState()
        nudgeThread(null)
        return
      }
      if (type === 'message' || type === 'inbound' || type === 'send' || type === 'status' || type === 'suppress') {
        const contactId = str(pick(payload, 'contactId', 'contact_id')) ?? str(pick(pick(payload, 'detail', 'data') as Raw, 'contact_id', 'contactId'))
        if (contactId) nudgeThread(contactId)
        else nudgeThread(null)
        nudgeState()
        return
      }
      if (type === 'job' || type === 'turn') {
        nudgeThread(null)
        nudgeState()
      }
    }

    const connect = () => {
      if (closed) return
      dispatch({ type: 'connection', value: attempt === 0 ? 'connecting' : 'reconnecting' })
      try {
        es = new EventSource('/api/emulator/stream')
      } catch {
        dispatch({ type: 'connection', value: 'offline' })
        return
      }
      es.onopen = () => {
        attempt = 0
        dispatch({ type: 'connection', value: 'live' })
        if (poll) {
          clearInterval(poll)
          poll = undefined
        }
        void refreshEvents()
      }
      es.onmessage = (e) => handle(e.data)
      for (const name of ['message', 'clock', 'job', 'turn', 'inbound', 'status', 'suppress', 'seed', 'event']) {
        es.addEventListener(name, (e) => handle((e as MessageEvent).data, name))
      }
      es.onerror = () => {
        if (closed) return
        es?.close()
        es = null
        attempt += 1
        dispatch({ type: 'connection', value: attempt > 4 ? 'offline' : 'reconnecting' })
        // Degrade to polling so the instrument keeps working while the stream is down.
        if (!poll) {
          poll = setInterval(() => {
            void refreshEvents()
            void refreshState()
            void refreshOpenThreads()
          }, 2500)
        }
        retry = setTimeout(connect, Math.min(500 * 2 ** Math.min(attempt, 5), 8000))
      }
    }

    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      if (poll) clearInterval(poll)
      es?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const actions = useMemo<EmulatorActions>(() => {
    const afterMutation = async (contactId?: string) => {
      await Promise.all([
        refreshEvents(),
        refreshState(),
        contactId ? refreshThread(contactId) : refreshOpenThreads(),
      ])
    }

    /**
     * `{ academyId }` when the bar is pointed at one tenant, `{}` when it is on
     * the world. Spread into the clock body rather than passed as a parameter so
     * that adding a scope never changes any control's signature.
     */
    const clockScopeBody = (): { academyId?: string } => {
      const scope = stateRef.current.clockScope
      return scope ? { academyId: scope } : {}
    }

    const applyClockResponse = (res: Raw) => {
      const clock = (pick(res, 'clock') as Raw) ?? res
      dispatch({ type: 'clock/set', payload: clock })
      const jobs = (pick(res, 'jobs', 'result') as Raw) ?? null
      const ran = num(pick(jobs, 'ran')) ?? num(pick(res, 'ran'))
      const skipped = num(pick(jobs, 'skipped')) ?? num(pick(res, 'skipped'))
      const failed = num(pick(jobs, 'failed')) ?? num(pick(res, 'failed'))
      if (ran !== null || skipped !== null || failed !== null) {
        notify(
          failed ? 'warn' : 'ok',
          `jobs — ${ran ?? 0} ran · ${skipped ?? 0} skipped · ${failed ?? 0} failed`,
        )
      }
    }

    return {
      refreshState,
      refreshThread,
      refreshEvents,

      seed: (scenario) =>
        withBusy('seed', async () => {
          dispatch({ type: 'scenario/set', scenario })
          const res = (await post('/api/emulator/seed', { scenario })) as Raw
          dispatch({ type: 'pane/closeAll' })
          if (pick(res, 'clock')) dispatch({ type: 'clock/set', payload: pick(res, 'clock') as Raw })
          await refreshState()
          await refreshEvents()
          notify('ok', `seeded "${scenario}"`)
        }),

      openPane: (contactId) => dispatch({ type: 'pane/open', contactId }),
      closePane: (contactId) => dispatch({ type: 'pane/close', contactId }),
      closeAllPanes: () => dispatch({ type: 'pane/closeAll' }),
      movePane: (contactId, dir) => dispatch({ type: 'pane/move', contactId, dir }),
      pinPane: (contactId) => dispatch({ type: 'pane/pin', contactId }),
      unpinPane: (contactId) => dispatch({ type: 'pane/unpin', contactId }),
      expandPane: (contactId) => dispatch({ type: 'pane/expand', contactId }),
      setChrome: (value) => dispatch({ type: 'ui/chrome', value }),
      setWaTheme: (value) => dispatch({ type: 'ui/waTheme', value }),

      /**
       * The scope every clock control below rides on.
       *
       * Read from the ref at call time rather than closed over, so a control
       * tapped straight after the selector changes moves the clock the operator
       * is looking at rather than the one they just left. `''` omits the field
       * entirely, which is the route's documented "world clock" default — an
       * explicit `academyId: undefined` would serialise to nothing anyway, but
       * saying so here is what keeps the two readings from drifting apart.
       */
      advance: (ms) =>
        withBusy('clock', async () => {
          applyClockResponse(
            (await post('/api/emulator/clock', { advanceMs: ms, ...clockScopeBody() })) as Raw,
          )
          await afterMutation()
        }),

      jumpToNextEvent: () =>
        withBusy('clock', async () => {
          const res = (await post('/api/emulator/clock', { toNextEvent: true, ...clockScopeBody() })) as Raw
          applyClockResponse(res)
          await afterMutation()
        }),

      setClockTo: (isoStr) =>
        withBusy('clock', async () => {
          applyClockResponse(
            (await post('/api/emulator/clock', { setToIso: isoStr, ...clockScopeBody() })) as Raw,
          )
          await afterMutation()
        }),

      resetClock: () =>
        withBusy('clock', async () => {
          applyClockResponse(
            (await post('/api/emulator/clock', { reset: true, ...clockScopeBody() })) as Raw,
          )
          await afterMutation()
        }),

      setClockScope: (academyId) => dispatch({ type: 'clock/scope', academyId }),

      tick: () =>
        withBusy('tick', async () => {
          const res = (await post('/api/emulator/tick', {})) as Raw
          applyClockResponse(res)
          await afterMutation()
        }),

      sendText: (contactId, text) =>
        withBusy(`send:${contactId}`, async () => {
          dispatch({ type: 'thread/optimistic', contactId, message: echo(contactId, text, stateRef.current.clock.nowIso) })
          await post('/api/emulator/inbound', { contactId, text })
          await afterMutation(contactId)
        }),

      sendMedia: (contactId, media, caption) =>
        withBusy(`send:${contactId}`, async () => {
          // The mime type travels with the bytes. A data URI has no extension for the
          // server to sniff, and the type still decides which sentence the person gets
          // back now that the model cannot read attachments at all (`mediaRefusal`).
          await post('/api/emulator/inbound', {
            contactId,
            mediaUrl: media.url,
            mediaMimeType: media.mimeType,
            ...(caption ? { text: caption } : {}),
          })
          await afterMutation(contactId)
        }),

      tapAction: (contactId, actionId, label) =>
        withBusy(`tap:${actionId}`, async () => {
          const nowIso = stateRef.current.clock.nowIso
          dispatch({ type: 'thread/consume', contactId, actionId, atIso: nowIso })
          if (label) dispatch({ type: 'thread/optimistic', contactId, message: echo(contactId, label, nowIso) })
          // The label goes with the tap, exactly as `button_reply.title` does on the wire.
          // Without it the optimistic echo above was the only place the chosen words ever
          // existed: the refresh that followed replaced it with the stored row, which had no
          // body at all, so the bubble a person had just tapped went blank in front of them.
          await post('/api/emulator/inbound', { contactId, actionId, ...(label ? { text: label } : {}) })
          await afterMutation(contactId)
        }),

      advanceStatus: (contactId, messageId, status) =>
        withBusy(`read:${messageId}`, async () => {
          await post('/api/emulator/read', { messageId, status })
          await Promise.all([refreshThread(contactId), refreshEvents()])
        }),

      runDelivery: async (mode) => {
        const res = (await post('/api/emulator/delivery', { mode })) as Raw
        const advanced = num(pick(res, 'advanced')) ?? 0
        if (advanced > 0) await Promise.all([refreshOpenThreads(), refreshEvents(), refreshState()])
        return { advanced }
      },

      setAutoDelivery: (mode) => dispatch({ type: 'delivery/mode', mode }),

      createTestContact: (input) =>
        withBusy('contact/new', async () => {
          const res = (await post('/api/emulator/contact', input)) as Raw
          const contact = (pick(res, 'contact') as Raw) ?? null
          const id = str(pick(contact, 'id', 'contactId'))
          // The world has to be re-read before the pane can render the new contact — it is
          // not in `state.contacts` until then, and a pane for an unknown contact renders
          // the "not in this world" card.
          await refreshState()
          if (id) dispatch({ type: 'pane/open', contactId: id })
          const where = str(pick(contact, 'enrolledIn')) ?? null
          notify(
            'ok',
            `${str(pick(contact, 'name')) ?? 'contact'} added on ${str(pick(contact, 'phone')) ?? 'a test number'}` +
              (where ? ` · enrolled in ${where}` : ''),
          )
        }),

      createAcademy: (input) =>
        withBusy('academy/new', async () => {
          const res = (await post('/api/emulator/academy', input)) as Raw
          const academy = (pick(res, 'academy') as Raw) ?? null
          await refreshState()
          const admin = (pick(academy, 'admin') as Raw) ?? null
          notify(
            'ok',
            `${str(pick(academy, 'name')) ?? input.name} created` +
              (str(pick(admin, 'phone')) ? ` · admin on ${str(pick(admin, 'phone'))}` : '') +
              ' · at setup, nobody messaged',
          )
        }),

      dropAcademy: (academyId, name) =>
        withBusy(`academy/drop:${academyId}`, async () => {
          const res = await fetch(`/api/emulator/academy?academy=${encodeURIComponent(academyId)}`, {
            method: 'DELETE',
          })
          const body = (await res.json().catch(() => ({}))) as Raw
          if (!res.ok || pick(body, 'ok') === false) {
            notify('error', `could not drop ${name}: ${str(pick(body, 'error')) ?? res.status}`)
            return
          }
          // Panes for contacts that no longer exist render the "not in this world" card,
          // so they are closed here rather than left as debris. `stateRef`, not `state`:
          // this closure outlives the render it was built in.
          for (const c of stateRef.current.contacts) {
            if (c.academyId === academyId) dispatch({ type: 'pane/close', contactId: c.id })
          }
          await refreshState()
          notify('ok', `${name} and everything in it is gone`)
        }),

      setFault: (kind, active, rate) =>
        withBusy(`fault:${kind}`, async () => {
          dispatch({ type: 'fault/set', kind, active, rate })
          await post('/api/emulator/fault', { kind, active, rate })
          await refreshEvents()
        }),

      setFilters: (patch) => dispatch({ type: 'filters/set', patch }),
      toggle: (key) => dispatch({ type: 'ui/toggle', key }),
      dismissToast: (id) => dispatch({ type: 'toast/dismiss', id }),
      notify,
    }
  }, [notify, refreshEvents, refreshOpenThreads, refreshState, refreshThread, withBusy])

  /*
   * Auto-delivery. It runs on wall-clock rather than on the sim clock deliberately: the
   * point is that a message spends a moment at `sent` and then moves, the way a real one
   * does, and a driver watching a pane needs to see that happen without touching anything.
   * Overlapping runs are prevented by a flag rather than by clearing the interval, because
   * a slow round trip must not be able to stack requests against the same rows.
   */
  const { autoDelivery } = state
  const runDelivery = actions.runDelivery
  useEffect(() => {
    if (autoDelivery === 'off') return
    let stopped = false
    let inFlight = false
    const beat = async () => {
      if (inFlight || stopped) return
      inFlight = true
      try {
        await runDelivery(autoDelivery)
      } catch {
        /* the ladder is an instrument, not the product — a failed poll must not toast */
      } finally {
        inFlight = false
      }
    }
    void beat()
    const t = setInterval(() => void beat(), 3000)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [autoDelivery, runDelivery])

  const value = useMemo<Ctx>(() => ({ state, actions }), [state, actions])
  return createElement(EmulatorContext.Provider, { value }, props.children)
}

export function useEmulator(): Ctx {
  const ctx = useContext(EmulatorContext)
  if (!ctx) throw new Error('useEmulator must be used inside <EmulatorProvider>')
  return ctx
}

// `useEmulatorState()` — `useEmulator().state` — had no caller: every pane either wants
// the actions or destructures `const { state } = useEmulator()` itself.

export function useEmulatorActions(): EmulatorActions {
  return useEmulator().actions
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export function useContactById(contactId: string): EmuContact | null {
  const { state } = useEmulator()
  return useMemo(() => state.contacts.find((c) => c.id === contactId) ?? null, [state.contacts, contactId])
}

export function useAcademyById(academyId: string | null | undefined): EmuAcademy | null {
  const { state } = useEmulator()
  return useMemo(() => state.academies.find((a) => a.id === academyId) ?? null, [state.academies, academyId])
}

export function useThread(contactId: string): ThreadState {
  const { state } = useEmulator()
  return state.threads[contactId] ?? { messages: [], loading: true, error: null, loadedAt: 0 }
}

/**
 * The simulated now, ticking.
 *
 * `state.clock.nowIso` is the server's last answer and does not move between calls, which is
 * why a 24h window could sit on screen reading "window 3m" long after it had closed and a
 * time-limited button could never be watched expiring. This adds the wall time elapsed since
 * that answer arrived — the same thing `app.now()` does server-side, since the sim clock is
 * real time plus a stored offset — so a pane counts down truthfully with no extra round trips.
 *
 * It re-renders its caller once a second, so it belongs on the small surfaces that show a
 * countdown, not at the root of the tree.
 */
export function useLiveNowIso(): string {
  const { state } = useEmulator()
  const { nowIso, syncedAtMs } = state.clock
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const t = setInterval(bump, 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.max(0, Date.now() - syncedAtMs)
  // Under a second of drift is not worth a new string: keeping the server's own value means
  // a pane that is not counting anything down renders byte-identically to what it was told.
  if (elapsed < 1000) return nowIso
  return new Date(new Date(nowIso).getTime() + elapsed).toISOString()
}

/** The clock is one shared thing; panes render it in their own academy's tz. */
export function usePrimaryTimezone(): string {
  const { state } = useEmulator()
  const first = state.academies[0]
  return safeTz(first?.timezone)
}

// `useSendMeta(messageId)` — "cost / sender / window facts arrive on the event stream;
// join them onto the bubble" — was never joined onto a bubble. `Bubble.tsx` renders from
// the message row alone.

/**
 * §16.1's tier accounting, derived from the log itself.
 *
 * The event log has rendered `tier n/limit` since it was written, and nothing in this build
 * has ever emitted either number: `contact.tier_state` is in the schema and no code reads or
 * writes it, so the chip was dead UI on every send. What a tier limit counts is
 * **business-initiated conversations on one number in a rolling 24 hours**, and that is
 * derivable here without inventing anything — a send that opened a paid conversation is
 * exactly the send that consumed one, and both facts are already on the row.
 *
 * The denominator is deliberately not derived. Which tier a number sits in is Meta's fact
 * about the number, not ours, so it stays absent unless a server emits it (§2.4).
 */
export function tierOrdinals(events: EmuEvent[]): Record<string, number> {
  const out: Record<string, number> = {}
  const perSender = new Map<string, number[]>()
  // Oldest first: an ordinal is "how many came before this one", so order is the whole point.
  const ordered = [...events].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  for (const e of ordered) {
    if (e.kind !== 'send') continue
    const opened = Boolean(e.templateName) || (e.costPaise ?? 0) > 0
    if (!opened) continue
    const key = e.senderPhone ?? 'unknown sender'
    const at = new Date(e.at).getTime()
    const seen = perSender.get(key) ?? []
    const window = seen.filter((t) => at - t < 24 * 3600 * 1000)
    window.push(at)
    perSender.set(key, window)
    out[e.id] = window.length
  }
  return out
}

export function filterEvents(state: EmulatorState): EmuEvent[] {
  const { academyId, kinds, q } = state.filters
  const needle = q.trim().toLowerCase()
  return state.events.filter((e) => {
    if (!kinds[e.kind]) return false
    if (academyId !== 'all' && e.academyId && e.academyId !== academyId) return false
    if (academyId !== 'all' && !e.academyId) {
      // events with no academy stay visible — they are global. `job` is in this set because
      // the events route serves job rows without an academy_id at all.
      if (e.kind !== 'clock' && e.kind !== 'system' && e.kind !== 'fault' && e.kind !== 'job') return false
    }
    if (!needle) return true
    const hay = `${e.summary} ${e.rawKind} ${e.templateName ?? ''} ${e.catalogId ?? ''} ${e.jobKind ?? ''} ${e.model ?? ''} ${e.reason ?? ''} ${e.senderPhone ?? ''}`
    return hay.toLowerCase().includes(needle)
  })
}

export { safeTz }

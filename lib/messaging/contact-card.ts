/**
 * lib/messaging/contact-card.ts — the one attachment that is not media.
 *
 * WhatsApp's `contacts` message is a name and a number. Every other attachment on
 * this surface is a file: bytes behind a media id, which a text-only model cannot
 * open and which `mediaRefusal` in `lib/agent/loop.ts` answers in words. A contact
 * card is not bytes — it arrives on the wire as JSON, and it says in structured
 * fields exactly the two things this product spends most of onboarding asking for.
 *
 * That difference is the whole reason this file exists rather than another `kind`
 * on `OutboundMessage.media`. Riding a card in on the media field would put it
 * through the branch whose entire job is to say "I cannot read this", which is
 * false about the one attachment that can be read.
 *
 * WHY IT MATTERS MORE THAN IT LOOKS
 * -----------------------------------------------------------------------------
 * §9.1's roster build is the admin typing families in, one line each, and
 * `product-spec.md` names shared contact cards and a photographed register as the
 * two intended routes that never arrived. A photographed register still cannot
 * arrive — it is pixels. A card always could have: the name and the number are
 * already text by the time Meta hands them over.
 *
 * The cost of the missing route is measurable in `lib/agent/operations.ts`'s
 * `phoneE164` refusal, which exists because a model asked to add two coaches
 * whose numbers nobody had given it wrote `+910000000001` and `+910000000002`
 * into a staged plan. Its refusal message already ends *"ask for it, or ask them
 * to share the contact card"* — advice for a road that was not built.
 *
 * ONE AUTHOR OF WHAT A CARD READS AS
 * -----------------------------------------------------------------------------
 * Three readers need the same sentence and they are in three layers: the
 * `message.body` column written at ingest (so `recentHistory`, which selects
 * `where body is not null`, does not drop a bare card out of the conversation
 * two turns later), the text the turn hands the model, and the bubble the
 * emulator draws. When that rendering had two authors anywhere else in this
 * repo the two drifted — `isForwardableLink` in `./types` carries the incident.
 * So it has one, here, and everything above calls it.
 *
 * IT REFUSES; IT NEVER REPAIRS
 * -----------------------------------------------------------------------------
 * A card whose number is not dialable is dropped, by name, rather than passed on
 * with a repaired number. `dialablePhone` is the same predicate `add_coach` and
 * `add_family` validate against, so a card that survives here is a card whose
 * number those operations will accept — and a card that does not survive cannot
 * become a `contact` row nobody can reach.
 */

import { dialablePhone } from '@/lib/format'

/**
 * A number as an Indian handset actually stores it, turned into one that can be dialled.
 *
 * This is the difference between a card and every other way a number reaches this
 * product, and skipping it produces a failure that passes validation. `phones[].phone`
 * on the Cloud API's card is the DISPLAY string out of the sender's own address book,
 * and nobody saves their contacts in E.164: the two commonest forms in an Indian phone
 * are `9845012345` and `098450 12345`. Handed either of those, `dialablePhone` never
 * reaches its `+91` branch — ten digits with no country code is not `91`-prefixed, so
 * the India rules do not run — and `9845012345` comes back **ok**, as `+9845012345`.
 * That is country code 98 and a number nobody answers, and it would have gone into
 * `contact.phone_e164` looking exactly like a real one.
 *
 * `wa_id`, when the card carries one, is always fully qualified and needs none of this.
 * It is not always there, which is why this cannot simply prefer it.
 *
 * The normalisation lives HERE and not in `dialablePhone`, deliberately. `dialablePhone`
 * is a predicate about whether a string is reachable, shared with `add_coach` and
 * `add_family` where the number was typed by somebody being asked for a phone number;
 * widening it would change what those accept. This function knows something narrower and
 * true: these digits came out of an address book on a phone in India.
 *
 * It only ever ADDS a country code. A number that already carries one, or that is not the
 * shape of an Indian mobile, is handed over untouched for `dialablePhone` to judge.
 *
 * What it deliberately does NOT do is tell a landline from a mobile. `080-4718-2200` is a
 * Bengaluru landline and `8047182200` is also a legitimate mobile prefix — the digits do
 * not distinguish them, and `dialablePhone` has accepted the E.164 form since it was
 * written. Making the card stricter than a typed number would reject real mobiles and put
 * two different answers in the product about one string, which is the trap
 * `isForwardableLink` in `./types` exists to name. A landline shared as a card becomes a
 * contact WhatsApp cannot reach, exactly as one typed in does.
 */
function asIndianMobile(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '')
  // The STD trunk prefix, as it is written on the back of a business card.
  const local = digits.length === 11 && digits.startsWith('0') ? digits.slice(1) : digits
  if (local.length === 10 && /^[6-9]/.test(local)) return `+91${local}`
  return raw
}

/**
 * A person as their handset knows them: a name, and a number that can be dialled.
 *
 * No email, no address, no organisation, and that is deliberate rather than
 * unfinished. WhatsApp's card carries all of them; this product has a column for
 * none of them, and a field carried into the prompt with nowhere to land is a fact
 * the model will reason from and then be unable to store — the shape
 * `ARCHITECTURE.md` calls a state the schema will not hold.
 */
export type SharedContact = {
  /** What the sender's phone had them saved as. Never blank — see `readSharedContacts`. */
  name: string
  /** E.164, already through `dialablePhone`. */
  phone: string
}

/** How many cards one message may carry. WhatsApp's own picker stops here. */
export const MAX_SHARED_CONTACTS = 20

/**
 * Everything a caller might hand over, reduced to the cards that are usable.
 *
 * Takes the Cloud API's own `contacts` array (`{name:{formatted_name}, phones:[{phone}]}`),
 * the emulator's flat `{name, phone}`, and a bare `[{name, wa_id}]` — because all
 * three exist on the paths that reach `ingestInbound` and a parser that knows only
 * one of them makes the other two silently empty.
 *
 * Unusable means: no name, or a number `dialablePhone` refuses. Both are dropped
 * rather than filled in. A card with a name and no reachable number is the case
 * this is strictest about — it is exactly the shape that would become a `contact`
 * row the product then tries and fails to invite, forever.
 *
 * @mechanism readSharedContacts — the single parser for a shared contact card, over the
 *   three shapes that reach ingest (the Cloud API's nested `contacts`, the emulator's flat
 *   pair, and a `wa_id`-only card). It validates the number with `dialablePhone` — the same
 *   predicate `add_coach` and `add_family` refuse on — so a card that survives here is one
 *   those operations will accept, and a card with no reachable number is dropped instead of
 *   becoming a contact row nobody can ever be invited on. `asIndianMobile` runs first,
 *   because a card's number is the DISPLAY string out of somebody's address book and nobody
 *   saves contacts in E.164: `9845012345` passes `dialablePhone` as `+9845012345`, which is
 *   country code 98 and a number that does not exist, and it would have reached
 *   `contact.phone_e164` looking exactly like a real one.
 */
export function readSharedContacts(raw: unknown): SharedContact[] {
  if (!Array.isArray(raw)) return []
  const out: SharedContact[] = []
  const seen = new Set<string>()

  for (const entry of raw.slice(0, MAX_SHARED_CONTACTS)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>

    const nameField = e.name
    const nameObj = nameField && typeof nameField === 'object' ? (nameField as Record<string, unknown>) : null
    const name = String(
      (typeof nameField === 'string' ? nameField : null)
        ?? nameObj?.formatted_name
        ?? [nameObj?.first_name, nameObj?.last_name].filter(Boolean).join(' ')
        ?? '',
    ).trim()
    if (!name) continue

    // `phones[0].phone` is the wire; `phone` is the emulator; `wa_id` is what a card
    // carries when the sender's contact has no formatted number saved against it.
    const phones = Array.isArray(e.phones) ? (e.phones as Record<string, unknown>[]) : []
    const candidate =
      (typeof e.phone === 'string' ? e.phone : null)
      ?? phones.map((p) => p?.phone ?? p?.wa_id).find((v) => typeof v === 'string' && v.trim())
      ?? (typeof e.wa_id === 'string' ? e.wa_id : null)

    const dialable = dialablePhone(typeof candidate === 'string' ? asIndianMobile(candidate) : candidate)
    if (!dialable.ok) continue
    if (seen.has(dialable.phone)) continue
    seen.add(dialable.phone)

    out.push({ name, phone: dialable.phone })
  }
  return out
}

/**
 * What a shared card reads as, in one line per card.
 *
 * Written as the sender's own message rather than as a note about it, because
 * that is what it is: on a handset a shared contact IS the message, the way a
 * button's label is the message when somebody taps it (`ingestWebhook` carries
 * the same argument for `button_reply.title`). It goes in `message.body`, so a
 * later turn reading the conversation back sees somebody handing over a number
 * rather than a gap where a message used to be.
 *
 * The number is E.164 rather than `formatPhone`'s readable spacing, and that is
 * the load-bearing choice in this function. The model copies this string into
 * `add_family`, `add_coach` and raw SQL; `formatPhone` renders `+919612345601`
 * as `96123 45601`, which drops the country code entirely. A number the model
 * reads back in the form it must write is a number it cannot mistranscribe.
 */
export function renderSharedContacts(contacts: SharedContact[]): string {
  if (contacts.length === 0) return ''
  const one = (c: SharedContact) => `${c.name} — ${c.phone}`
  if (contacts.length === 1) return `[shared a contact: ${one(contacts[0])}]`
  return `[shared ${contacts.length} contacts: ${contacts.map(one).join('; ')}]`
}

/**
 * The body a message carries when a card arrives with a caption typed beside it.
 *
 * WhatsApp sends those as two messages and this product takes them as one, so
 * the caption comes first — it is what the person was saying, and the card is
 * what they attached to say it with.
 *
 * @mechanism bodyWithSharedContacts — the single call that turns a shared contact card into
 *   the words a turn works from, used by `ingestInbound` for the `message.body` column and
 *   by `runTurn` for the text it hands the model. Because it is one call rather than two
 *   renderings, the sentence the model reads this turn is byte-identical to the one it
 *   re-reads out of the conversation next turn. Writing it into `body` is what makes the
 *   card survive at all: `recentHistory` selects `where body is not null`, so a card with
 *   no caption typed beside it would be in the pane, the payload and the event log, and
 *   absent from the conversation two turns later — the hole `button_reply.title` fell into,
 *   where a tap arrived with its words attached or without them depending only on which
 *   kind of button carried it. A card is also the one attachment `mediaRefusal` must never
 *   answer, since it is data rather than a file, and giving it a body is what routes it
 *   past both that branch and the nothing-readable guard beside it.
 */
export function bodyWithSharedContacts(text: string | undefined, contacts: SharedContact[]): string | undefined {
  const rendered = renderSharedContacts(contacts)
  if (!rendered) return text
  const said = (text ?? '').trim()
  return said ? `${said}\n${rendered}` : rendered
}

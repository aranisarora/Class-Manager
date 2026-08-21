/**
 * lib/phonebook.ts — the address book a handset would already have.
 *
 *   import { phonebookFor } from '@/lib/phonebook'
 *
 *   const book = phonebookFor(academyId)          // 24 people, always the same 24
 *   book[0]                                       // { name: 'Vandana Achar', phone: '+919641382700' }
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * `📎 attach › Contact` needs something to attach. On a real phone that is the
 * owner's own address book, built up over years; here there is no phone, so the
 * emulator and the seat would otherwise be picking between an empty list and a
 * number somebody made up. Both are worse than they look. An empty list means the
 * affordance can only ever be exercised by typing a number, which is the thing
 * sharing a card exists to avoid. And a made-up number is the failure
 * `worlds/README.md` already documents at length: models reach for `9876543210`
 * with striking consistency, §10.1 resolves an inbound by the pair
 * `(from, sender)`, and a number held by two academies on one shared sender
 * resolves to **neither** — the message is never delivered and nothing raises an
 * error.
 *
 * NO TWO ACADEMIES ARE EVER OFFERED THE SAME NUMBER
 * -----------------------------------------------------------------------------
 * That is the whole design constraint, and it is why this is a derivation rather
 * than a fixture file.
 *
 * A single shared list of dummy contacts is the obvious build and it is the
 * expensive one: two academies driven in parallel — the ordinary case here, and
 * the only way an `npm run ab` ever finishes — would be offered the same person,
 * and whichever one added them second would create a contact on a number the
 * other tenant already holds. From that moment neither business can receive a
 * message from them. Worse, the run does not fail: it produces a week in which
 * one family is silently unreachable, which reads as the product losing messages.
 *
 * So the numbers come from the academy id, exactly as every other number in this
 * harness already does — `_world.ts` derives `+9193…`, `_world-spec.ts` `+9194…`,
 * `probe-model.ts` `+9195…`, `createTestContact` allocates out of `+9199…`. This
 * block is `+9196…`, which nothing else uses. Two academies share a NAME freely
 * (there are a great many Divya Raos, and a name collides with nothing in this
 * schema), and they can never share a number.
 *
 * The scenario the constraint is really about — somebody being enrolled at one
 * academy and shared into another — therefore cannot arise by accident. It is a
 * genuine case and a rare one, and this leaves it available deliberately: type
 * the other academy's number in by hand and it happens. It just stops happening
 * on its own, every run, to nobody's benefit.
 *
 * A PERSONA IS NEVER SHOWN A NUMBER
 * -----------------------------------------------------------------------------
 * `phonebookNames()` is the seat's view and it carries names only. That is how a
 * real phone works — you tap a name, you do not read the digits out — and it is
 * also what keeps a persona from contradicting itself: the three `new-*` worlds
 * tell their owner which block to invent numbers in, and a seat that could see
 * this book's numbers would be holding two different answers about what its
 * people's numbers look like. Names are the only channel, so the two never meet.
 *
 * IT DOES NOT WRITE ANYTHING
 * -----------------------------------------------------------------------------
 * Nobody in this book exists in the database. They are people the business knows
 * and the product does not, which is the state that makes them worth sharing —
 * the moment one is added, `contact` holds them and the card was the thing that
 * put the name and the number there.
 */

import { dialablePhone } from '@/lib/format'

export type PhonebookEntry = {
  name: string
  /** E.164, in the `+9196…` block, derived from the academy id. */
  phone: string
}

/**
 * The people on the handset, and none of them are in any pool this repo already
 * deals into a world.
 *
 * `_world-spec.ts` has `COACH_POOL`, `CLIENT_POOL` and `PROSPECT_POOL`, and every
 * name here is deliberately absent from all three. A book that offered "Divya
 * Rao" while a Divya Rao was already enrolled would make every share ambiguous —
 * a reader of the record could not tell an operator testing the
 * already-on-the-books case from one who simply picked the first row.
 *
 * Surnames span the country rather than one state, because a coaching business in
 * an Indian city has families from everywhere in it, and a register that reads as
 * one region is a fixture nobody would recognise as their own.
 */
const BOOK_POOL: readonly string[] = [
  'Vandana Achar', 'Prakash Salunkhe', 'Ismail Kutty', 'Rukmini Sarangi',
  'Devendra Ahluwalia', 'Sujata Mahanta', 'Feroz Mirza', 'Chitra Vaidyanathan',
  'Balram Tiwari', 'Nusrat Jahan', 'Girish Hegde', 'Padmini Chakravarthy',
  'Ajay Wagle', 'Sabina Lakra', 'Mohit Chhabra', 'Renuka Dandekar',
  'Wasim Sayyed', 'Aparna Bhagat', 'Jagdish Meena', 'Trishala Pandit',
  'Nitin Barve', 'Hemlata Purohit', 'Rafiq Ansari', 'Kalpana Sengupta',
  'Sohail Merchant', 'Vasanthi Rajagopal', 'Tapan Dutta', 'Mrinalini Borkar',
  'Yogesh Zende', 'Shabana Kazi', 'Dinesh Talwar', 'Aruna Kaimal',
] as const

/** The block. Nothing else in this repo allocates out of `+9196…` — see the header. */
const BOOK_PREFIX = '+9196'

/** Six digits of academy, two of seat: a hundred people per business. */
const ACADEMY_DIGITS = 6
const MAX_ENTRIES = 100

/** How many the pickers show by default. The pool is the real ceiling. */
export const PHONEBOOK_SIZE = 24

/**
 * Six decimal digits that depend on the whole academy id.
 *
 * FNV-1a rather than `academyId.replace(/\D/g,'').slice(0, 6)`, which is what the
 * neighbouring derivations do. Both land in the same million-wide space, but the
 * slice depends on *where the digits happen to fall* in a uuid — two academies
 * whose ids begin with the same run of hex digits get the same block, and uuids
 * generated in the same millisecond are more alike at the front than at the back.
 * A hash reads the whole id, so two academies collide only by genuinely colliding.
 */
function academyBlock(academyId: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < academyId.length; i++) {
    h ^= academyId.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return String(h % 10 ** ACADEMY_DIGITS).padStart(ACADEMY_DIGITS, '0')
}

/**
 * This academy's address book: the same people, in the same order, every time it
 * is asked.
 *
 * Deterministic because three readers have to agree without talking to each
 * other — the emulator's picker, the seat's list of names, and whatever reads the
 * record afterwards trying to work out who `+919641382700` was. A book that
 * shuffled per call would make a run unreadable a day later.
 *
 * The pool is ROTATED by the same hash rather than sliced from the front, so two
 * academies in one world do not open their pickers on the same first four names.
 * That is presentation rather than correctness — the numbers are what keep them
 * apart — but a picker whose top rows are identical in both panes invites exactly
 * the mistake this file exists to make impossible.
 *
 * @mechanism phonebookFor — derives each academy's shareable address book from its own id,
 *   so no two tenants are ever offered the same phone number and a contact shared into one
 *   business can never be a number another business already holds. That collision is not
 *   loud: §10.1 resolves an inbound by `(from, sender)`, a number known to two academies on
 *   the shared sender matches both and resolves to neither, and the run goes on producing a
 *   week in which one family is silently unreachable. Names are drawn from a pool disjoint
 *   from every `_world-spec.ts` pool, so a shared card is never ambiguous with somebody the
 *   world already dealt in.
 */
export function phonebookFor(academyId: string, size: number = PHONEBOOK_SIZE): PhonebookEntry[] {
  const block = academyBlock(academyId)
  const start = Number(block) % BOOK_POOL.length
  const n = Math.max(0, Math.min(size, BOOK_POOL.length, MAX_ENTRIES))

  const out: PhonebookEntry[] = []
  for (let i = 0; i < n; i++) {
    const name = BOOK_POOL[(start + i) % BOOK_POOL.length]
    const phone = `${BOOK_PREFIX}${block}${String(i).padStart(2, '0')}`
    // The book cannot offer a number `add_family` would refuse. It never has —
    // the block opens `96`, so every one of these is a ten-digit Indian mobile —
    // but the assertion is free and the alternative is discovering it mid-plan.
    if (!dialablePhone(phone).ok) continue
    out.push({ name, phone })
  }
  return out
}

/**
 * The seat's view: who is in your phone, and nothing about their numbers.
 *
 * See the header — a persona that could read these digits would be holding two
 * contradictory facts about what its people's numbers look like, because the
 * `new-*` worlds hand their owner a different block to invent in. It also
 * happens to be how a phone works.
 */
export function phonebookNames(academyId: string, size: number = PHONEBOOK_SIZE): string[] {
  return phonebookFor(academyId, size).map((e) => e.name)
}

/**
 * The one entry a name refers to, or null.
 *
 * Case- and space-insensitive, and it will take a first name alone when exactly
 * one person in the book answers to it — because that is what a seat types
 * (`share Vandana`) and what a person says out loud. Ambiguity returns null
 * rather than the first match: two Vandanas and a guess is a card sent to the
 * wrong person, which on this surface is a real number receiving a real message.
 */
export function phonebookLookup(academyId: string, name: string, size: number = PHONEBOOK_SIZE): PhonebookEntry | null {
  const want = name.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!want) return null
  const book = phonebookFor(academyId, size)

  const exact = book.filter((e) => e.name.toLowerCase() === want)
  if (exact.length === 1) return exact[0]

  const partial = book.filter((e) => {
    const full = e.name.toLowerCase()
    return full.startsWith(`${want} `) || full.endsWith(` ${want}`) || full.includes(` ${want} `)
  })
  return partial.length === 1 ? partial[0] : null
}

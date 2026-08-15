/**
 * lib/messaging/flows.ts — the forms, as published artifacts, and what comes back.
 *
 * WHY THIS EXISTS
 * -----------------------------------------------------------------------------
 * Three moments in this product are form-shaped, and all three used to be bad in
 * the same two ways.
 *
 *   - **Setting a business up** asks eight or nine things before anything useful
 *     can happen. In a chat that is nine round trips — nine model calls, nine
 *     waits, nine chances for somebody to put the phone down halfway. Driven from
 *     empty, the first reply the product ever sends was measured at 102 words and
 *     it still only asked for one of them.
 *   - **Adding a class** is seven fields that only make sense together: a name
 *     without days is not a class, and days without times are not a timetable.
 *   - **The register** is one row per player, every session, for ever. It is the
 *     single most repeated interaction in the product.
 *
 * The two bad answers were a ladder of questions in the chat, or a signed link out
 * to a browser. The link is gone (§15) and it deserved to go: whoever held the URL
 * held that person's session, so a forwarded register link was an open attendance
 * sheet. A Flow is the third answer — the same fields, one exchange, no browser, no
 * login, and a response bound to the conversation that cannot be detached from it.
 *
 * WHAT IS AND IS NOT MODELLED
 * -----------------------------------------------------------------------------
 * This repo does not call Meta — the emulator is the surface, and §17's rule is
 * "something that works here works there". So the Flow JSON below is the real
 * artifact in the real shape, and `validateFlowJson` re-checks the rules Meta
 * applies when you publish, because a Flow that would fail publish is a Flow that
 * cannot ship no matter how well it renders locally. What is NOT here is the
 * publishing itself (`POST /{WABA}/flows`, `/assets`, `/publish`) — that is an
 * account operation, not a runtime one, and it belongs with the other Meta calls
 * behind `transport-cloud.ts` on the day this connects to a real number.
 *
 * ONE SCREEN EACH, DELIBERATELY
 * -----------------------------------------------------------------------------
 * Meta supports multi-screen static Flows, and a four-screen setup wizard reads
 * well on paper. It is worse in the hand: four Continue taps instead of one Save,
 * and every screen boundary is a place to abandon. A Flow screen scrolls. So each
 * form here is one screen carrying every field it needs, and the grouping that a
 * wizard would do with screens is done with `TextSubheading` instead.
 *
 * THE RULES BEING ENFORCED, and where they come from
 * -----------------------------------------------------------------------------
 *   - `version` and `screens` are the only required top-level properties.
 *   - `routing_model` is required only for endpoint-powered flows. These are not,
 *     so it is deliberately absent and Meta derives it.
 *   - Screen id `SUCCESS` is reserved.
 *   - A `terminal` screen MUST carry a `Footer`, and that footer's action must be
 *     `complete` — a `navigate` on a terminal footer is a flow that can never end,
 *     and Meta rejects it at publish.
 *   - Every form component needs a `name`.
 *   - `${form.x}` reads this screen's inputs; `${data.x}` reads what was passed in.
 *   - `null` is not a supported dynamic value. Omit the key instead.
 *
 * THIS FILE IS LOADED IN THE BROWSER — KEEP IT THAT WAY
 * -----------------------------------------------------------------------------
 * The emulator renders these definitions client-side (`FlowSheet.tsx`), so every
 * import added here is added to the client bundle. `zod` is isomorphic and fine.
 * `lib/db`, `lib/clock` and anything reaching `lib/env` are NOT: they read
 * `.env.local` off disk, and pulling one in breaks the emulator's build with an
 * `UnhandledSchemeError` about `node:fs` that points at no file anybody touched.
 * Prefilling a form from the database lives in `forms.ts` for that reason.
 */

import { z } from 'zod'

/* ------------------------------------------------------------------------- *
 * The artifact
 * ------------------------------------------------------------------------- */

export type FlowComponent = Record<string, unknown> & { type: string; name?: string }

export type FlowScreen = {
  id: string
  title?: string
  terminal?: boolean
  success?: boolean
  data?: Record<string, unknown>
  layout: { type: 'SingleColumnLayout'; children: FlowComponent[] }
}

export type FlowJson = {
  version: string
  screens: FlowScreen[]
}

export type FlowDefinition = {
  /** Stable key the runtime uses to decide what a submission means. */
  id: string
  /** What Meta would call it. */
  name: string
  /** The screen a `navigate` send opens on. */
  entryScreen: string
  /** The CTA on the bubble. <= 20 chars, no emoji. */
  cta: string
  json: FlowJson
  /** Parses `response_json` into something the runtime is willing to act on. */
  response: z.ZodTypeAny
}

/**
 * Flow JSON version. 7.2 is a current published version; the only things this build
 * depends on are `${form.x}` binding, a dynamic `data-source`, and `complete`, all of
 * which are far older.
 */
const FLOW_VERSION = '7.2'

/* ------------------------------------------------------------------------- *
 * business_setup — the shape of the business, in one screen
 * ------------------------------------------------------------------------- */

/**
 * One screen, not nine questions.
 *
 * Everything optional is genuinely optional. A business with no UPI handle is a real
 * business (cash), and refusing to let them past this screen would be the product
 * inventing a policy nobody chose.
 *
 * **The rhythm fields are the reason the morning brief is allowed to exist.** Doctrine
 * rule 1 is that every proactive message must be one its recipient would have asked
 * for, and a daily brief nobody chose a time for fails that test. Asked here, once, it
 * passes it for ever — which is why they are on the form rather than in a setting
 * nobody finds.
 *
 * **The default charging basis is the reason a timetable read off a photo is worth
 * anything.** Four classes parsed out of a whiteboard have names, days and times and no
 * prices; without this the follow-up is four questions. With it, the read-back can say
 * "all ₹2,500 a month unless you say otherwise" and be right most of the time.
 */
const BUSINESS_SETUP_JSON: FlowJson = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'SETUP',
      title: 'Your business',
      terminal: true,
      /**
       * Declared because the screen REFERENCES them. `${data.x}` is not free-form: a
       * screen must declare every dynamic property it reads, as JSON Schema, with an
       * `__example__` Meta uses to validate the layout at publish time. Referencing an
       * undeclared property is a publish rejection, which would have arrived as an API
       * error at the moment somebody first tried to ship this — the failure furthest
       * from the person who could fix it.
       *
       * Every one is prefilled from what the runtime already knows when it sends the
       * message, so the first field is right rather than empty.
       */
      data: {
        name: { type: 'string', __example__: 'Ace TT Academy' },
        category: { type: 'string', __example__: 'Table tennis' },
        timezone: { type: 'string', __example__: 'Asia/Kolkata' },
        venue: { type: 'string', __example__: 'Green Park Indoor Stadium' },
        address: { type: 'string', __example__: 'Court 3, opposite the pool gate' },
        rate_unit: { type: 'string', __example__: 'per_month' },
        cancellation_window_hours: { type: 'string', __example__: '24' },
        morning_brief_at: { type: 'string', __example__: '07:00' },
        evening_digest_at: { type: 'string', __example__: '21:00' },
        upi_handle: { type: 'string', __example__: 'acett@okhdfcbank' },
      },
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextBody',
            text: 'A few basics and I can take it from here. You can change any of this later, and nothing goes out to anyone until you say so.',
          },

          { type: 'TextSubheading', text: 'Your business' },
          {
            type: 'TextInput',
            name: 'name',
            label: 'Business name',
            'input-type': 'text',
            required: true,
            'init-value': '${data.name}',
          },
          {
            type: 'TextInput',
            name: 'category',
            label: 'What you teach',
            'helper-text': 'Table tennis, badminton, vocal, chess…',
            'input-type': 'text',
            required: false,
            'init-value': '${data.category}',
          },
          {
            type: 'Dropdown',
            name: 'timezone',
            label: 'Timezone',
            required: false,
            'init-value': '${data.timezone}',
            'data-source': [
              { id: 'Asia/Kolkata', title: 'India (IST)' },
              { id: 'Asia/Dubai', title: 'UAE (GST)' },
              { id: 'Asia/Singapore', title: 'Singapore' },
              { id: 'Europe/London', title: 'UK' },
              { id: 'America/New_York', title: 'US Eastern' },
            ],
          },

          { type: 'TextSubheading', text: 'Where you teach' },
          {
            type: 'TextInput',
            name: 'venue',
            label: 'Venue',
            // Not required, because this form is also how an established business edits
            // its settings — and the venue is the one field that ADDS a row rather than
            // replacing one. Demanding it on every edit would make somebody re-type a
            // hall they already have, or invent a second one to get past the form.
            'helper-text': 'Leave blank to keep the places you already have',
            'input-type': 'text',
            required: false,
          },
          {
            type: 'TextInput',
            name: 'address',
            label: 'How to find it',
            'helper-text': 'The bit people actually need — "Court 3, opposite the pool gate"',
            'input-type': 'text',
            required: false,
          },

          { type: 'TextSubheading', text: 'How you charge' },
          {
            type: 'RadioButtonsGroup',
            name: 'rate_unit',
            label: 'Mostly',
            required: false,
            'init-value': '${data.rate_unit}',
            'data-source': [
              { id: 'per_month', title: 'Per month' },
              { id: 'per_session', title: 'Per session' },
              { id: 'per_term', title: 'Per term' },
              { id: 'per_package', title: 'In packs of classes' },
            ],
          },
          {
            type: 'Dropdown',
            name: 'cancellation_window_hours',
            label: 'Notice needed to cancel',
            required: true,
            'init-value': '${data.cancellation_window_hours}',
            'data-source': [
              { id: '2', title: '2 hours' },
              { id: '6', title: '6 hours' },
              { id: '12', title: '12 hours' },
              { id: '24', title: '24 hours' },
              { id: '48', title: '48 hours' },
            ],
          },
          {
            type: 'TextInput',
            name: 'upi_handle',
            label: 'UPI handle for fees',
            'helper-text': 'Leave blank if you take cash',
            'input-type': 'text',
            required: false,
            'init-value': '${data.upi_handle}',
          },

          { type: 'TextSubheading', text: 'Your rhythm' },
          {
            type: 'Dropdown',
            name: 'morning_brief_at',
            label: 'Morning brief at',
            'helper-text': 'What today looks like, and anything that needs you',
            required: false,
            'init-value': '${data.morning_brief_at}',
            'data-source': [
              { id: '06:00', title: '6:00 am' },
              { id: '07:00', title: '7:00 am' },
              { id: '08:00', title: '8:00 am' },
              { id: '09:00', title: '9:00 am' },
              { id: 'off', title: "Don't send one" },
            ],
          },
          {
            type: 'Dropdown',
            name: 'evening_digest_at',
            label: 'Evening summary at',
            'helper-text': 'How the day went, and the money',
            required: false,
            'init-value': '${data.evening_digest_at}',
            'data-source': [
              { id: '20:00', title: '8:00 pm' },
              { id: '21:00', title: '9:00 pm' },
              { id: '22:00', title: '10:00 pm' },
              { id: 'off', title: "Don't send one" },
            ],
          },

          {
            type: 'Footer',
            label: 'Save',
            'on-click-action': {
              name: 'complete',
              payload: {
                name: '${form.name}',
                category: '${form.category}',
                timezone: '${form.timezone}',
                venue: '${form.venue}',
                address: '${form.address}',
                rate_unit: '${form.rate_unit}',
                cancellation_window_hours: '${form.cancellation_window_hours}',
                upi_handle: '${form.upi_handle}',
                morning_brief_at: '${form.morning_brief_at}',
                evening_digest_at: '${form.evening_digest_at}',
              },
            },
          },
        ],
      },
    },
  ],
}

/**
 * What the runtime will accept back.
 *
 * Everything arrives as a STRING — `response_json` is a JSON string on the wire and
 * every form value inside it is text, including the dropdown's number. Coercing
 * here rather than at the use site is the same "normalise once, at the boundary"
 * rule `parseSteps` follows.
 *
 * Nothing here is trusted. A Flow response is user input arriving over the wire; it
 * is exactly as authoritative as a typed message, which is to say not at all. The
 * plan it feeds runs under the submitter's own RLS session like everything else.
 */
const BusinessSetupResponse = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.string().trim().max(80).optional().default(''),
  timezone: z.string().trim().max(60).optional().default(''),
  venue: z.string().trim().max(120).optional().default(''),
  address: z.string().trim().max(240).optional().default(''),
  rate_unit: z.string().trim().max(20).optional().default(''),
  /**
   * The empty string is turned into `undefined` BEFORE coercion so the default applies.
   * `z.coerce.number()` reads '' as 0, so "they left it blank" would have been written as
   * a zero-hour cancellation policy — a business that can never refuse a late
   * cancellation — rather than falling back to the 24 this schema already declares.
   */
  cancellation_window_hours: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.coerce.number().int().min(0).max(168).default(24),
  ),
  upi_handle: z.string().trim().max(120).optional().default(''),
  morning_brief_at: z.string().trim().max(10).optional().default(''),
  evening_digest_at: z.string().trim().max(10).optional().default(''),
})

export type BusinessSetupValues = z.infer<typeof BusinessSetupResponse>

export const BUSINESS_SETUP: FlowDefinition = {
  id: 'business_setup',
  name: 'Business setup',
  entryScreen: 'SETUP',
  cta: 'Set up',
  json: BUSINESS_SETUP_JSON,
  response: BusinessSetupResponse,
}

/* ------------------------------------------------------------------------- *
 * add_class — one class, prefilled with whatever was already read
 * ------------------------------------------------------------------------- */

/**
 * The form that makes a photo of a whiteboard worth taking.
 *
 * `onboarding.md` calls the timetable "the biggest single saving in the whole
 * product", and the saving is only real if the *correction* is cheap too. A row read
 * off a board at an angle is right about the name and wrong about the end time; the
 * choice used to be between accepting it wrong and re-asking for all seven fields.
 *
 * So every field here is prefilled from `${data.x}`, **including the parts that were
 * only half-read**. A person correcting "Sub Jr" to "Sub Junior" is doing ten seconds
 * of work. A person answering "what is it called? which days? what time does it
 * start? what time does it end? where? how much? per what?" is doing two minutes of
 * work and will not finish it. That asymmetry is the whole design.
 *
 * The days are a static `data-source` — seven weekdays are seven weekdays for every
 * business on earth — so this artifact never needs republishing.
 */
const ADD_CLASS_JSON: FlowJson = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'CLASS',
      title: 'Add a class',
      terminal: true,
      data: {
        name: { type: 'string', __example__: 'Beginners' },
        days: { type: 'array', items: { type: 'string' }, __example__: ['1', '3', '5'] },
        starts: { type: 'string', __example__: '18:30' },
        ends: { type: 'string', __example__: '19:30' },
        venue: { type: 'string', __example__: 'Green Park Indoor Stadium' },
        rate: { type: 'string', __example__: '2500' },
        rate_unit: { type: 'string', __example__: 'per_month' },
        venues: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
          __example__: [{ id: 'Green Park Indoor Stadium', title: 'Green Park Indoor Stadium' }],
        },
      },
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'TextBody',
            text: 'Anything I got wrong, just fix it here.',
          },
          {
            type: 'TextInput',
            name: 'name',
            label: 'Class name',
            'input-type': 'text',
            required: true,
            'init-value': '${data.name}',
          },
          {
            type: 'CheckboxGroup',
            name: 'days',
            label: 'Days',
            required: true,
            'init-value': '${data.days}',
            'data-source': [
              { id: '1', title: 'Monday' },
              { id: '2', title: 'Tuesday' },
              { id: '3', title: 'Wednesday' },
              { id: '4', title: 'Thursday' },
              { id: '5', title: 'Friday' },
              { id: '6', title: 'Saturday' },
              { id: '0', title: 'Sunday' },
            ],
          },
          {
            type: 'TextInput',
            name: 'starts',
            label: 'Starts',
            'helper-text': '6:30pm, or 18:30',
            'input-type': 'text',
            required: true,
            'init-value': '${data.starts}',
          },
          {
            type: 'TextInput',
            name: 'ends',
            label: 'Ends',
            'helper-text': '7:30pm, or 19:30',
            'input-type': 'text',
            required: true,
            'init-value': '${data.ends}',
          },
          {
            type: 'Dropdown',
            name: 'venue',
            label: 'Where',
            required: false,
            'init-value': '${data.venue}',
            'data-source': '${data.venues}',
          },
          {
            type: 'TextInput',
            name: 'rate',
            label: 'Fee',
            'helper-text': 'Leave blank if this one is free',
            'input-type': 'number',
            required: false,
            'init-value': '${data.rate}',
          },
          {
            type: 'RadioButtonsGroup',
            name: 'rate_unit',
            label: 'Charged',
            required: false,
            'init-value': '${data.rate_unit}',
            'data-source': [
              { id: 'per_month', title: 'Per month' },
              { id: 'per_session', title: 'Per session' },
              { id: 'per_term', title: 'Per term' },
              { id: 'per_package', title: 'In a pack' },
            ],
          },
          {
            type: 'Footer',
            label: 'Add it',
            'on-click-action': {
              name: 'complete',
              payload: {
                name: '${form.name}',
                days: '${form.days}',
                starts: '${form.starts}',
                ends: '${form.ends}',
                venue: '${form.venue}',
                rate: '${form.rate}',
                rate_unit: '${form.rate_unit}',
              },
            },
          },
        ],
      },
    },
  ],
}

const AddClassResponse = z.object({
  name: z.string().trim().min(1).max(120),
  days: z.preprocess(
    // A single checkbox can arrive as a bare string rather than a one-element array.
    (v) => (typeof v === 'string' ? (v ? v.split(',') : []) : v),
    z.array(z.coerce.number().int().min(0).max(6)).min(1),
  ),
  starts: z.string().trim().min(1).max(20),
  ends: z.string().trim().min(1).max(20),
  venue: z.string().trim().max(120).optional().default(''),
  rate: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.coerce.number().min(0).max(10_000_000).optional(),
  ),
  rate_unit: z.string().trim().max(20).optional().default(''),
})

export type AddClassValues = z.infer<typeof AddClassResponse>

export const ADD_CLASS: FlowDefinition = {
  id: 'add_class',
  name: 'Add a class',
  entryScreen: 'CLASS',
  cta: 'Add a class',
  json: ADD_CLASS_JSON,
  response: AddClassResponse,
}

/* ------------------------------------------------------------------------- *
 * register — attendance, inverted
 * ------------------------------------------------------------------------- */

/**
 * **The register asks who was NOT there.**
 *
 * This is the single most repeated interaction in the product — once per session, per
 * coach, for ever — and the ordinary shape of it is a list of twelve names with four
 * radio buttons each, forty-eight taps to say a normal thing. On a normal night the
 * true answer is "everyone came", and a form that costs forty-eight taps to say
 * "everyone came" is a form that stops being filled in by week three. An unmarked
 * register is a session that never bills, so this is a money defect wearing a UX
 * complaint's clothes.
 *
 * So the default is present, and the form collects the exceptions. Zero taps and Done
 * is the normal night. The two that matter — who missed it, who was late — are the
 * two the coach actually remembers walking off the court.
 *
 * **A static Flow cannot draw a variable-length roster**, which is what makes the
 * inversion structural rather than stylistic. Two `CheckboxGroup`s with a dynamic
 * `data-source` handle any roster size with one published artifact; twelve radio
 * groups would need a different artifact for every headcount a business can have.
 *
 * The note is what reaches the parents. `CL-OUTCOME` carries it, and one sentence
 * from the coach is worth more to a parent than the whole of the rest of the message
 * — so it is asked for on the form rather than hoped for afterwards.
 */
const REGISTER_JSON: FlowJson = {
  version: FLOW_VERSION,
  screens: [
    {
      id: 'REGISTER',
      title: 'Register',
      terminal: true,
      data: {
        session_id: { type: 'string', __example__: '00000000-0000-0000-0000-000000000000' },
        heading: { type: 'string', __example__: 'Beginners, 6:30 — 12 on the roster' },
        roster: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
          __example__: [{ id: '00000000-0000-0000-0000-000000000000', title: 'Aarav K' }],
        },
      },
      layout: {
        type: 'SingleColumnLayout',
        children: [
          { type: 'TextHeading', text: '${data.heading}' },
          {
            type: 'TextBody',
            text: "Everyone counts as present. Just tick anyone who wasn't.",
          },
          {
            type: 'CheckboxGroup',
            name: 'absent',
            label: "Didn't come",
            required: false,
            'data-source': '${data.roster}',
          },
          {
            type: 'CheckboxGroup',
            name: 'late',
            label: 'Came late',
            required: false,
            'data-source': '${data.roster}',
          },
          {
            type: 'TextArea',
            name: 'note',
            label: 'Anything to pass on?',
            'helper-text': "Goes to the parents with tonight's update. Leave it blank if there's nothing.",
            required: false,
          },
          {
            type: 'Footer',
            label: 'Done',
            'on-click-action': {
              name: 'complete',
              payload: {
                session_id: '${data.session_id}',
                absent: '${form.absent}',
                late: '${form.late}',
                note: '${form.note}',
              },
            },
          },
        ],
      },
    },
  ],
}

const idList = z.preprocess(
  (v) => (typeof v === 'string' ? (v ? v.split(',') : []) : (v ?? [])),
  z.array(z.string().trim().min(1)).default([]),
)

const RegisterResponse = z.object({
  session_id: z.string().trim().min(1),
  absent: idList,
  late: idList,
  note: z.string().trim().max(1000).optional().default(''),
})

export type RegisterValues = z.infer<typeof RegisterResponse>

export const REGISTER: FlowDefinition = {
  id: 'register',
  name: 'Register',
  entryScreen: 'REGISTER',
  cta: 'Take register',
  json: REGISTER_JSON,
  response: RegisterResponse,
}

/* ------------------------------------------------------------------------- *
 * The catalog
 * ------------------------------------------------------------------------- */

export const FLOWS: Record<string, FlowDefinition> = {
  [BUSINESS_SETUP.id]: BUSINESS_SETUP,
  [ADD_CLASS.id]: ADD_CLASS,
  [REGISTER.id]: REGISTER,
}

/**
 * The names the model may write, and the only ones.
 *
 * Kept as a literal tuple rather than derived from `FLOWS`, because it is projected
 * into the `reply` tool's JSON schema as an `enum`, and an empty or import-order-
 * dependent enum is the classic silent way a declaration breaks — it has to be a
 * real string union at build time, not a value assembled at import. Adding a form
 * is this line and the definition above it.
 */
export const FORM_IDS = ['business_setup', 'add_class', 'register'] as const
export type FormId = (typeof FORM_IDS)[number]

/**
 * What the runtime says when a BUTTON opens a form.
 *
 * The model writes the body when it sends a form itself. This is the other path — a
 * tap, with no model in the loop — and whatever is written here goes to a phone
 * exactly as typed. Every one of them ends by saying the form is optional, because
 * doctrine rule 4 says a form is an offer and never a toll, and the one copy nobody
 * reviews is the copy where that rule quietly stops being true.
 */
export const FORM_INTRO: Record<FormId, string> = {
  business_setup:
    'Everything about the business on one screen — what you teach, where, how you charge, '
    + 'how much notice you want for cancellations, and when you want to hear from me.\n\n'
    + "Or just tell me any of it here and I'll set it up the same way. Nothing goes out to anyone either way.",
  add_class:
    "Here's the class. Fix anything I got wrong.\n\nOr tell me in a sentence and I'll do it from that.",
  register:
    "Tonight's register. Everyone counts as present — tick anyone who wasn't, and add a note "
    + "if there's something the parents should hear.\n\nOr just tell me who missed it.",
}

export function isFlowId(s: string): s is FormId {
  return s in FLOWS
}

/* ------------------------------------------------------------------------- *
 * Validation — the rules Meta applies at publish
 * ------------------------------------------------------------------------- */

/**
 * Every way this artifact would be rejected at publish, as human sentences.
 * Empty array = publishable. Same contract as `validateOutbound`, and the same
 * reasoning: a Flow that renders here and fails there is worse than one that fails
 * in both places, because only one of those two is discoverable.
 */
export function validateFlowJson(flow: FlowJson): string[] {
  const bad: string[] = []

  if (!flow.version) bad.push('a flow needs a version')
  if (!Array.isArray(flow.screens) || flow.screens.length === 0) {
    bad.push('a flow needs at least one screen')
    return bad
  }

  const ids = new Set<string>()
  let terminals = 0

  for (const screen of flow.screens) {
    if (!screen.id) {
      bad.push('a screen has no id')
      continue
    }
    if (screen.id === 'SUCCESS') bad.push('SUCCESS is a reserved screen id')
    if (ids.has(screen.id)) bad.push(`two screens share the id ${screen.id}`)
    ids.add(screen.id)

    const children = screen.layout?.children
    if (screen.layout?.type !== 'SingleColumnLayout') {
      bad.push(`screen ${screen.id} must use SingleColumnLayout`)
    }
    if (!Array.isArray(children) || children.length === 0) {
      bad.push(`screen ${screen.id} has no children`)
      continue
    }

    const footers = children.filter((c) => c.type === 'Footer')
    if (screen.terminal) {
      terminals += 1
      if (footers.length === 0) {
        bad.push(`terminal screen ${screen.id} has no Footer, so it cannot be submitted`)
      }
      for (const f of footers) {
        const action = (f['on-click-action'] ?? {}) as { name?: string }
        // The failure this catches is not cosmetic: a terminal screen whose footer
        // navigates is a flow with no way to finish, and the person is stuck inside
        // it with no route back to the conversation.
        if (action.name !== 'complete') {
          bad.push(
            `terminal screen ${screen.id}'s footer must complete the flow, not ${action.name ?? 'nothing'}`,
          )
        }
      }
    }

    /**
     * Every `${data.x}` this screen reads has to be declared in the screen's own `data`,
     * as JSON Schema with an `__example__`. Meta validates the layout against those
     * examples at publish, so an undeclared reference is a rejection — and it would
     * arrive as an API error the first time somebody tried to ship the flow, which is
     * the furthest possible point from the person who could fix it. The first shipped
     * onboarding flow had exactly this defect: it prefilled `${data.name}` and declared
     * nothing.
     *
     * `${form.x}` is deliberately not checked here — it is resolved against the form
     * component names, which the loop below already validates for uniqueness.
     */
    const declared = new Set(Object.keys(screen.data ?? {}))
    for (const ref of JSON.stringify(children).matchAll(/\$\{data\.([A-Za-z0-9_]+)\}/g)) {
      const key = ref[1] as string
      if (!declared.has(key)) {
        bad.push(`screen ${screen.id} reads \${data.${key}} and does not declare it`)
      }
    }
    for (const [key, schema] of Object.entries(screen.data ?? {})) {
      // The example is what Meta renders the screen against; without it the property is
      // declared but unvalidatable, and publish complains about the screen, not the key.
      if (!schema || typeof schema !== 'object' || !('__example__' in schema)) {
        bad.push(`screen ${screen.id} declares data.${key} with no __example__`)
      }
    }

    const names = new Set<string>()
    for (const c of children) {
      if (!c.type) bad.push(`screen ${screen.id} has a component with no type`)
      // Every form component is addressed by name — both in `${form.x}` and in the
      // response — so an unnamed one silently drops the answer.
      if (FORM_COMPONENTS.has(String(c.type))) {
        if (!c.name) bad.push(`a ${c.type} on ${screen.id} has no name`)
        else if (names.has(c.name)) bad.push(`two components on ${screen.id} share the name ${c.name}`)
        else names.add(String(c.name))
      }
      if (JSON.stringify(c).includes('null')) {
        // Meta's dynamic references have no null: the documented instruction is to
        // omit the key. A null reaches the phone as the literal word.
        bad.push(`a ${c.type} on ${screen.id} carries a null — omit the key instead`)
      }
    }
  }

  if (terminals === 0) bad.push('no screen is terminal, so the flow can never finish')
  if (JSON.stringify(flow).length > 10 * 1024 * 1024) bad.push('flow json exceeds 10 MB')

  return bad
}

const FORM_COMPONENTS = new Set([
  'TextInput', 'TextArea', 'Dropdown', 'RadioButtonsGroup', 'CheckboxGroup',
  'OptIn', 'DatePicker', 'PhotoPicker', 'DocumentPicker',
])

/**
 * Split an `nfm_reply.response_json` into the token and the answers.
 *
 * ONE definition, because there are two doors: the Cloud webhook, which gets it from
 * `interactive.nfm_reply.response_json`, and the emulator's inbound route, which is
 * handed the identical string. Those were two hand-rolled `JSON.parse` + destructure
 * blocks in the same file, and two implementations of one event is the defect this
 * codebase has hit more than any other — the register screen wrote attendance with its
 * own SQL for most of the product's life and produced no money for any of it. A
 * divergence here would be worse than that one, because the emulator is the ONLY place
 * this is ever exercised, so the emulator would be the half that stayed right.
 *
 * Never throws. A malformed body means the person still said something, and going quiet
 * on them is the worse failure — the caller falls through and treats it as an ordinary
 * inbound message.
 */
export function splitFlowResponse(
  responseJson: string | null | undefined,
): { token?: string; data?: Record<string, unknown> } {
  if (!responseJson) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(responseJson)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const { flow_token, ...fields } = parsed as Record<string, unknown>
  return {
    token: typeof flow_token === 'string' && flow_token ? flow_token : undefined,
    data: fields,
  }
}

/**
 * Parse what came back from a Flow, by flow id.
 *
 * `raw` is whatever `nfm_reply.response_json` held. On the real wire that is a
 * STRING containing JSON; the emulator can hand over an object directly. Both are
 * accepted, because the difference is an encoding detail of the transport and not
 * something any caller should have to know.
 */
export function parseFlowResponse(
  flowId: string,
  raw: unknown,
): { ok: true; values: Record<string, unknown> } | { ok: false; error: string } {
  const def = FLOWS[flowId]
  if (!def) return { ok: false, error: `there is no form called ${flowId}` }

  let payload: unknown = raw
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw)
    } catch {
      return { ok: false, error: 'the form response was not valid JSON' }
    }
  }
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: 'the form response was not an object' }
  }

  // `flow_token` rides inside the response on the real wire and is not a form field.
  const { flow_token: _token, ...fields } = payload as Record<string, unknown>

  const parsed = def.response.safeParse(fields)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      error: issue ? `${issue.path.join('.') || 'that form'}: ${issue.message}` : 'that form did not parse',
    }
  }
  return { ok: true, values: parsed.data as Record<string, unknown> }
}

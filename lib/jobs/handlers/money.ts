/**
 * lib/jobs/handlers/money.ts — the billing clock (§6.4, §12.1, §12.4).
 *
 *   monthly_lines    the 1st, one line per active enrollment
 *   month_end_tally  CL-TALLY, the month read back line by line   (fixed)
 *   dunning          CL-DUNNING, per policy, then the admin
 *   reconcile        AD-RECONCILE, a requested payment nobody confirmed
 *
 * The four rate units are the whole of the branching, and they are the four the
 * spec names: `per_session` bills on attendance and so does nothing here;
 * `per_month` writes one line; `per_term` writes one line every `rate_count`
 * months; `per_package` opens a pack and **the count remaining rides on the
 * tally** — a parent who bought ten classes will ask, and should never have to.
 */

import { DateTime } from 'luxon'
import type { Job } from '@/lib/types'
import type { Tx } from '@/lib/db'
import { now } from '@/lib/clock'
import { formatINR } from '@/lib/format'
import { composeAndSend } from '@/lib/messaging/compose'
import { LIMITS } from '@/lib/messaging/types'
import { dedupe, DUNNING_INTERVAL_DAYS, DUNNING_MAX, RECONCILE_INTERVAL_HOURS, RECONCILE_MAX } from '../kinds'
import { enqueue } from '../enqueue'
import {
  admins, buttonTitle, clamp, contactFor, firstName, joinLines, loadAcademy, monthLabel,
  need, note, num, numberOf, payloadOf, serviceCtx, skip, withAcademy,
} from '../util'

// -----------------------------------------------------------------------------
// Descriptions are shown verbatim to the parent (§6.4), so they are built in
// one place and matched on for idempotency — a tally line has no class column.
// -----------------------------------------------------------------------------

function monthlyDescription(className: string, period: string, tz: string): string {
  return `${className} — ${monthLabel(period, tz)} ${DateTime.fromISO(period, { zone: tz }).toFormat('yyyy')}`
}

function termDescription(className: string, period: string, months: number, tz: string): string {
  const start = DateTime.fromISO(period, { zone: tz })
  const end = start.plus({ months: Math.max(1, months) - 1 })
  return `${className} — term, ${start.toFormat('LLLL')} to ${end.toFormat('LLLL yyyy')}`
}

function packageDescription(className: string, count: number): string {
  return `${className} — pack of ${count} classes`
}

type EnrollmentRow = {
  enrollment_id: string
  class_id: string
  class_name: string
  player_id: string
  player_name: string
  account_id: string
  holder_person_id: string
  started_on: string
  ended_on: string | null
  is_trial: boolean
  rate_amount: string | number | null
  rate_unit: string | null
  rate_count: number | null
  class_starts_on: string
}

/**
 * `monthly_lines` on the 1st, per active enrollment (§6.4).
 *
 * Rate lives on the enrollment and defaults from the class, which is how
 * drop-ins, sibling discounts and legacy rates work with no schema branch.
 */
export async function monthlyLines(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const enrollmentId = need(p, 'enrollment_id')
  const period = need(p, 'period')

  await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    const tz = academy.timezone

    const [e] = await tx<EnrollmentRow[]>`
      select e.id as enrollment_id, e.class_id, cl.name as class_name,
             e.player_id, pp.full_name as player_name,
             pl.account_id, a.holder_person_id,
             e.started_on::text as started_on, e.ended_on::text as ended_on, e.is_trial,
             coalesce(e.rate_amount, cl.rate_amount) as rate_amount,
             coalesce(e.rate_unit, cl.rate_unit) as rate_unit,
             coalesce(e.rate_count, cl.rate_count) as rate_count,
             cl.starts_on::text as class_starts_on
        from enrollment e
        join class cl on cl.id = e.class_id
        join player pl on pl.id = e.player_id
        join person pp on pp.id = pl.person_id
        join account a on a.id = pl.account_id
       where e.id = ${enrollmentId} and e.academy_id = ${academyId}
    `
    if (!e) skip('enrollment gone')

    // ---- precondition: still active across this period (§13 rule 2) ---------
    const periodStart = DateTime.fromISO(period, { zone: tz })
    const periodEnd = periodStart.endOf('month').toFormat('yyyy-MM-dd')
    if (e.started_on > periodEnd) skip('enrollment starts after this period')
    if (e.ended_on && e.ended_on < period) skip('enrollment ended before this period')

    const unit = e.rate_unit
    const amount = num(e.rate_amount)
    if (!unit) skip('no rate on the enrollment or its class — nothing to bill')
    if (unit === 'per_session') skip('per-session bills on attendance, not on the 1st')
    if (amount === 0) skip('rate is zero')

    if (unit === 'per_month') {
      const description = monthlyDescription(e.class_name, period, tz)
      await writeLine(tx, academyId, e, period, 'monthly', description, amount)
      note(`${e.player_name}: ${description} ${formatINR(amount)}`)
      return
    }

    if (unit === 'per_term') {
      // A term is a month with a longer stride. Anchored on the enrollment's own
      // start so a mid-term joiner is not billed on someone else's cycle.
      const months = Math.max(1, e.rate_count ?? 1)
      const anchor = DateTime.fromISO(
        (e.started_on > e.class_starts_on ? e.started_on : e.class_starts_on), { zone: tz },
      ).startOf('month')
      const elapsed = Math.round(periodStart.startOf('month').diff(anchor, 'months').months)
      if (elapsed < 0) skip('term has not started')
      if (elapsed % months !== 0) skip(`mid-term (month ${(elapsed % months) + 1} of ${months})`)
      const description = termDescription(e.class_name, period, months, tz)
      await writeLine(tx, academyId, e, period, 'term', description, amount)
      note(`${e.player_name}: ${description} ${formatINR(amount)}`)
      return
    }

    if (unit === 'per_package') {
      const size = Math.max(1, e.rate_count ?? 1)
      const description = packageDescription(e.class_name, size)
      const { opened, consumed } = await packageState(tx, academyId, e, description)
      if (consumed < opened * size) {
        skip(`pack still has ${opened * size - consumed} of ${size} left`)
      }
      await writeLine(tx, academyId, e, period, 'package', description, amount)
      note(`${e.player_name}: opened ${description} ${formatINR(amount)}`)
      return
    }

    skip(`unknown rate unit ${unit}`)
  })
}

/** One line, once. There is no unique constraint for non-session lines, so the
 *  guard is an explicit existence check on what the parent would actually see. */
async function writeLine(
  tx: Tx, academyId: string, e: EnrollmentRow, period: string,
  kind: 'monthly' | 'term' | 'package', description: string, amount: number,
): Promise<void> {
  const [existing] = await tx<{ id: string }[]>`
    select id from tally_line
     where academy_id = ${academyId} and account_id = ${e.account_id}
       and player_id = ${e.player_id} and period = ${period}::date
       and kind = ${kind} and description = ${description}
  `
  if (existing) skip('line already written')

  await tx`
    insert into tally_line (academy_id, account_id, player_id, period, kind, description, amount)
    values (${academyId}, ${e.account_id}, ${e.player_id}, ${period}::date,
            ${kind}, ${description}, ${amount})
  `

  /**
   * §6.4's free first class, for the three units that do not bill on attendance.
   *
   * The free-trial rule lived entirely inside `mark_attendance`'s `per_session`
   * branch, because it is written there as "a negative line equal to the first
   * *session* line". The other three units have no session line — so a player
   * booked in as a trial into a `per_month` class was **billed a full month for
   * their free trial**, on the 1st, with nothing anywhere marking it as wrong.
   * `is_trial` was carried on the enrollment, selected by nobody, and read by
   * nothing in this file.
   *
   * Minted here rather than in the three branches for the reason the rest of this
   * codebase gives: `writeLine` is the one place a recurring line is written, and
   * a rule that has to be repeated three times is a rule that will be right twice.
   *
   * Self-limiting by construction — it offsets the FIRST recurring line only, so a
   * trial who stays is billed normally from their second period. That matters
   * because nothing in the product ever clears `is_trial`, so an exemption keyed
   * on the flag alone would be permanent and silent.
   */
  if (!e.is_trial) return

  const [alreadyCredited] = await tx<{ id: string }[]>`
    select id from tally_line
     where academy_id = ${academyId} and player_id = ${e.player_id}
       and kind = 'adjustment' and reason = 'free trial'
     limit 1
  `
  if (alreadyCredited) return

  await tx`
    insert into tally_line (academy_id, account_id, player_id, period, kind, description, amount, reason)
    values (${academyId}, ${e.account_id}, ${e.player_id}, ${period}::date, 'adjustment',
            ${`Free trial — ${e.player_name}`}, ${-amount}, 'free trial')
  `
}

/** How many packs have been opened, and how many classes have eaten into them. */
async function packageState(
  tx: Tx, academyId: string, e: EnrollmentRow, description: string,
): Promise<{ opened: number; consumed: number }> {
  const [row] = await tx<{ opened: number; consumed: number }[]>`
    select
      (select count(*) from tally_line t
        where t.academy_id = ${academyId} and t.player_id = ${e.player_id}
          and t.kind = 'package' and t.description = ${description})::int as opened,
      (select count(*) from attendance a
         join session s on s.id = a.session_id
        where a.player_id = ${e.player_id} and s.class_id = ${e.class_id}
          and a.status in ('present', 'late', 'absent'))::int as consumed
  `
  return { opened: row?.opened ?? 0, consumed: row?.consumed ?? 0 }
}

type LineRow = { kind: string; description: string; amount: number; player_name: string | null }

/**
 * `month_end_tally` — CL-TALLY (§12.1, **fixed**: it may be reworded or merged,
 * never suppressed). The month read back line by line, in the words the admin
 * chose, with what is actually outstanding.
 */
export async function monthEndTally(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const accountId = need(p, 'account_id')
  const period = need(p, 'period')

  const plan = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    if (academy.onboarding_state !== 'live') skip('not live yet')

    const [account] = await tx<{ holder_person_id: string; holder_name: string }[]>`
      select a.holder_person_id, pe.full_name as holder_name
        from account a join person pe on pe.id = a.holder_person_id
       where a.id = ${accountId} and a.academy_id = ${academyId}
    `
    if (!account) skip('account gone')

    const lines = await tx<LineRow[]>`
      select t.kind, t.description, t.amount::float8 as amount, pp.full_name as player_name
        from tally_line t
        left join player pl on pl.id = t.player_id
        left join person pp on pp.id = pl.person_id
       where t.academy_id = ${academyId} and t.account_id = ${accountId}
         and t.period = ${period}::date
       order by t.created_at asc
    `
    if (lines.length === 0) skip('nothing billed this period')

    const [totals] = await tx<{ billed: number; paid: number }[]>`
      select
        coalesce((select sum(amount) from tally_line
                   where academy_id = ${academyId} and account_id = ${accountId}), 0)::float8 as billed,
        coalesce((select sum(amount) from payment
                   where academy_id = ${academyId} and account_id = ${accountId}
                     and status = 'confirmed'), 0)::float8 as paid
    `

    const packs = await packRemaining(tx, academyId, accountId)
    const contactId = await contactFor(tx, academyId, account.holder_person_id)
    if (!contactId) skip('no reachable number for this family')

    return { academy, account, lines, totals, packs, contactId }
  })

  const { academy, account, lines, totals, packs, contactId } = plan
  const tz = academy.timezone
  const periodTotal = lines.reduce((s, l) => s + num(l.amount), 0)
  const outstanding = num(totals?.billed) - num(totals?.paid)

  const body = joinLines([
    `${monthLabel(period, tz)} for ${firstName(account.holder_name)}:`,
    ...lines.map((l) => {
      const who = l.player_name && lines.some((o) => o.player_name !== l.player_name)
        ? `${firstName(l.player_name)} · ` : ''
      return `• ${who}${l.description} — ${formatINR(num(l.amount))}`
    }),
    `Total ${formatINR(periodTotal)}.`,
    outstanding > 0 && Math.abs(outstanding - periodTotal) > 0.005
      ? `Outstanding across everything: ${formatINR(outstanding)}.`
      : null,
    ...packs.map((k) => `${firstName(k.player_name)} has ${k.remaining} of ${k.size} classes left on ${k.class_name}.`),
    academy.upi_handle && outstanding > 0 ? `UPI: ${academy.upi_handle}` : null,
  ])

  await composeAndSend(serviceCtx(academy.id), {
    toContactId: contactId,
    header: clamp(academy.name, LIMITS.headerChars),
    body: clamp(body, LIMITS.bodyChars),
    buttons: outstanding > 0
      ? [
          { title: buttonTitle('Pay now'), action: { kind: 'reply', text: `I'd like to pay ${formatINR(outstanding)}` } },
          { title: buttonTitle('See the lines'), action: { kind: 'reply', text: `Show me the ${monthLabel(period, tz)} lines` } },
        ]
      : [{ title: buttonTitle('See the lines'), action: { kind: 'reply', text: `Show me the ${monthLabel(period, tz)} lines` } }],
    catalogId: 'CL-TALLY',
    fixed: true,
    subjectPersonIds: [account.holder_person_id],
  })
  note(`tally sent to ${account.holder_name}: ${lines.length} line(s), ${formatINR(periodTotal)}`)

  if (outstanding > 0) {
    const runAt = new Date((await now()).getTime() + DUNNING_INTERVAL_DAYS * 86_400_000)
    await enqueue(
      'dunning', runAt, dedupe.dunning(accountId, period, 1),
      { academy_id: academyId, account_id: accountId, period, n: 1 }, academyId,
    )
  }
}

type PackRemaining = { player_name: string; class_name: string; size: number; remaining: number }

/** §6.4 — "the count remaining rides on the tally." */
async function packRemaining(tx: Tx, academyId: string, accountId: string): Promise<PackRemaining[]> {
  const rows = await tx<EnrollmentRow[]>`
    select e.id as enrollment_id, e.class_id, cl.name as class_name,
           e.player_id, pp.full_name as player_name,
           pl.account_id, a.holder_person_id,
           e.started_on::text as started_on, e.ended_on::text as ended_on,
           coalesce(e.rate_amount, cl.rate_amount) as rate_amount,
           coalesce(e.rate_unit, cl.rate_unit) as rate_unit,
           coalesce(e.rate_count, cl.rate_count) as rate_count,
           cl.starts_on::text as class_starts_on
      from enrollment e
      join class cl on cl.id = e.class_id
      join player pl on pl.id = e.player_id
      join person pp on pp.id = pl.person_id
      join account a on a.id = pl.account_id
     where e.academy_id = ${academyId} and pl.account_id = ${accountId}
       and e.ended_on is null
       and coalesce(e.rate_unit, cl.rate_unit) = 'per_package'
  `
  const out: PackRemaining[] = []
  for (const e of rows) {
    const size = Math.max(1, e.rate_count ?? 1)
    const { opened, consumed } = await packageState(tx, academyId, e, packageDescription(e.class_name, size))
    if (opened === 0) continue
    out.push({
      player_name: e.player_name,
      class_name: e.class_name,
      size,
      remaining: Math.max(0, opened * size - consumed),
    })
  }
  return out
}

/**
 * `dunning` — CL-DUNNING (§12.1). Per policy, unpaid, and it stops: the ladder
 * is three, then the admin is told, because a bot that chases forever is the
 * fastest way to a block on a shared number (§16.1).
 */
export async function dunningRun(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const accountId = need(p, 'account_id')
  const period = need(p, 'period')
  const n = numberOf(p, 'n', 1)
  const nowAt = await now()

  const plan = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    if (academy.onboarding_state !== 'live') skip('not live yet')

    const [account] = await tx<{ holder_person_id: string; holder_name: string }[]>`
      select a.holder_person_id, pe.full_name as holder_name
        from account a join person pe on pe.id = a.holder_person_id
       where a.id = ${accountId} and a.academy_id = ${academyId}
    `
    if (!account) skip('account gone')

    const [totals] = await tx<{ billed: number; paid: number }[]>`
      select
        coalesce((select sum(amount) from tally_line
                   where academy_id = ${academyId} and account_id = ${accountId}), 0)::float8 as billed,
        coalesce((select sum(amount) from payment
                   where academy_id = ${academyId} and account_id = ${accountId}
                     and status = 'confirmed'), 0)::float8 as paid
    `
    const outstanding = num(totals?.billed) - num(totals?.paid)
    if (outstanding <= 0) skip('paid up')

    const contactId = await contactFor(tx, academyId, account.holder_person_id)
    const adminRows = (await admins(tx, academyId)).filter((a) => a.contact_id)
    return { academy, account, outstanding, contactId, adminRows }
  })

  const { academy, account, outstanding, contactId, adminRows } = plan
  const tz = academy.timezone

  if (contactId) {
    await composeAndSend(serviceCtx(academy.id), {
      toContactId: contactId,
      header: clamp(academy.name, LIMITS.headerChars),
      body: clamp(joinLines([
        `${formatINR(outstanding)} is still open on ${monthLabel(period, tz)}.`,
        academy.upi_handle ? `UPI: ${academy.upi_handle}` : null,
      ]), LIMITS.bodyChars),
      buttons: [
        { title: buttonTitle('Pay now'), action: { kind: 'reply', text: `I'd like to pay ${formatINR(outstanding)}` } },
        { title: buttonTitle('Already paid'), action: { kind: 'reply', text: `I've already paid ${formatINR(outstanding)}` } },
      ],
      catalogId: 'CL-DUNNING',
      subjectPersonIds: [account.holder_person_id],
    })
  }

  if (n < DUNNING_MAX) {
    await enqueue(
      'dunning',
      new Date(nowAt.getTime() + DUNNING_INTERVAL_DAYS * 86_400_000),
      dedupe.dunning(accountId, period, n + 1),
      { academy_id: academyId, account_id: accountId, period, n: n + 1 },
      academyId,
    )
    note(`dunning ${n}/${DUNNING_MAX} to ${account.holder_name} — ${formatINR(outstanding)}`)
    return
  }

  // The ladder is spent. §12.1: "escalates to admin."
  for (const a of adminRows) {
    await composeAndSend(serviceCtx(academy.id), {
      toContactId: a.contact_id as string,
      header: clamp(academy.name, LIMITS.headerChars),
      body: clamp(
        `${account.holder_name} still owes ${formatINR(outstanding)} for ${monthLabel(period, tz)}. `
        + `I've asked ${DUNNING_MAX} times and I'll stop now.`,
        LIMITS.bodyChars,
      ),
      buttons: [
        { title: buttonTitle('Call them'), action: { kind: 'reply', text: `Give me ${account.holder_name}'s number` } },
        { title: buttonTitle('Write it off'), action: { kind: 'reply', text: `Waive ${account.holder_name}'s ${monthLabel(period, tz)} balance` } },
      ],
      isEscalation: true,
      subjectPersonIds: [account.holder_person_id],
    })
  }
  note(`dunning exhausted for ${account.holder_name} — admin told`)
}

/**
 * `reconcile` — AD-RECONCILE (§12.4, §11.5). Rail 1 has no webhook, so a
 * requested payment sits in `requested` until a human attests to it. This is the
 * ask, and `[Not yet]` deliberately changes nothing.
 */
export async function reconcile(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const paymentId = need(p, 'payment_id')
  const n = numberOf(p, 'n', 1)
  const nowAt = await now()

  const plan = await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    if (academy.onboarding_state !== 'live') skip('not live yet')

    const [pay] = await tx<{
      amount: number; status: string; requested_at: Date | null
      holder_person_id: string; holder_name: string; account_id: string
    }[]>`
      select pm.amount::float8 as amount, pm.status, pm.requested_at,
             a.id as account_id, a.holder_person_id, pe.full_name as holder_name
        from payment pm
        join account a on a.id = pm.account_id
        join person pe on pe.id = a.holder_person_id
       where pm.id = ${paymentId} and pm.academy_id = ${academyId}
    `
    if (!pay) skip('payment gone')
    if (pay.status !== 'requested') skip(`payment is ${pay.status}`)

    const recipients = (await admins(tx, academyId)).filter((a) => a.contact_id)
    if (recipients.length === 0) skip('no admin to ask')
    return { academy, pay, recipients }
  })

  const { academy, pay, recipients } = plan
  const asked = pay.requested_at
    ? DateTime.fromJSDate(pay.requested_at).setZone(academy.timezone).toFormat('d LLLL')
    : 'earlier'

  for (const admin of recipients) {
    await composeAndSend(serviceCtx(academy.id), {
      toContactId: admin.contact_id as string,
      header: clamp(academy.name, LIMITS.headerChars),
      body: clamp(
        `${formatINR(num(pay.amount))} was requested from ${pay.holder_name} on ${asked} `
        + `and still isn't confirmed. Did it come in?`,
        LIMITS.bodyChars,
      ),
      buttons: [
        {
          // §2.2 — minted resolved, replayed verbatim. This was
          // `{kind:'reply', text:"Yes — …'s ₹X came in, confirm it"}`: a sentence
          // handed back to the model to re-interpret, which made **a money state
          // transition a tap-time inference** on the one table where being wrong
          // costs the business real money. The payment id is right here; the
          // button carries the row.
          title: buttonTitle('Yes, received'),
          action: {
            kind: 'operation',
            op: 'confirm_payment',
            args: { payment_id: paymentId },
          },
        },
        { title: buttonTitle('Not yet'), action: { kind: 'noop', ack: "Left as requested — I'll ask again." } },
      ],
      catalogId: 'AD-RECONCILE',
      isEscalation: true,
      subjectPersonIds: [pay.holder_person_id],
    })
  }
  note(`reconcile ${n}/${RECONCILE_MAX}: ${formatINR(num(pay.amount))} from ${pay.holder_name}`)

  if (n < RECONCILE_MAX) {
    await enqueue(
      'reconcile',
      new Date(nowAt.getTime() + RECONCILE_INTERVAL_HOURS * 3600_000),
      dedupe.reconcile(paymentId, n + 1),
      { academy_id: academyId, payment_id: paymentId, n: n + 1 },
      academyId,
    )
  }
}

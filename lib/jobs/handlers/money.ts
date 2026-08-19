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
import {
  FREE_FIRST_CLASS_REASON,
  billingKey,
  coachLedgerKey,
  freeFirstClassDescription,
  packageDescription,
} from '@/lib/billing-keys'
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
import type { AcademyRow } from '../util'

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

// packageDescription now lives in lib/billing-keys.ts — `operations.ts` opens packs
// too and composed a different sentence, so `packageState` counted zero of them.

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

  /**
   * Filled inside the transaction, acted on after it commits. See `writeLine`.
   */
  const partial: { found: PartialPeriod | null; tz: string; months: number } = {
    found: null,
    tz: 'Asia/Kolkata',
    months: 1,
  }
  let academyRow: AcademyRow | null = null

  await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    academyRow = academy
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

    // A trial is free, and stays free until somebody converts it on purpose.
    // The row rode into this query with a monthly rate inherited from the
    // class, so a trial that lingered across the 1st was billed in full —
    // "the first class is free" becoming ₹2,000 by default is exactly the
    // silently-travelling default the domain facts warn about. Nothing bills
    // itself; converting the enrollment is what starts billing.
    if (e.is_trial) skip('a trial is free — converting it is what starts billing')

    const unit = e.rate_unit
    const amount = num(e.rate_amount)
    if (!unit) skip('no rate on the enrollment or its class — nothing to bill')
    if (unit === 'per_session') skip('per-session bills on attendance, not on the 1st')
    if (amount === 0) skip('rate is zero')

    if (unit === 'per_month') {
      const description = monthlyDescription(e.class_name, period, tz)
      partial.tz = tz
      partial.months = 1
      await writeLine(
        tx, academyId, e, period, 'monthly', description, amount,
        billingKey.monthly(e.player_id, e.class_id, period),
        partial,
      )
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
      partial.tz = tz
      partial.months = months
      await writeLine(
        tx, academyId, e, period, 'term', description, amount,
        billingKey.term(e.player_id, e.class_id, period),
        partial,
      )
      note(`${e.player_name}: ${description} ${formatINR(amount)}`)
      return
    }

    if (unit === 'per_package') {
      const size = Math.max(1, e.rate_count ?? 1)
      const description = packageDescription(e.class_name, size)
      const { opened, consumed } = await packageState(tx, academyId, e, description)
      /**
       * **A pack opens on the next session, not on the last one.**
       *
       * This was `consumed < opened * size`, so at `consumed === opened * size`
       * — the moment the pack is exactly used up — the skip did not fire and a
       * new pack was billed. §6.4 puts the moment one class later: "when
       * `rate_count` sessions are consumed **the next session opens a new
       * package** and writes the next line." `mark_attendance` implements that
       * correctly (`consumed = used + 1; if (consumed > size)`), so the two
       * writers rolled over one class apart, and this one was the wrong one.
       *
       * What that cost: a family finishes exactly their ten classes on 28 August
       * and stops coming. On 1 September this billed them for pack #2 — with no
       * session attended in it and none booked — and then carried it as
       * outstanding, which is the dunning ladder's trigger. A charge for a pack
       * that was never started, to a family who has just left, is the worst
       * moment in the product to be wrong about money and the one most likely to
       * be read as the academy squeezing a leaver. Nothing in the runtime could
       * see it: the line is honestly written and "0 of 10 classes left" is
       * arithmetically true of a pack nobody used.
       */
      if (consumed <= opened * size) {
        skip(`pack has ${opened * size - consumed} of ${size} left — the next class opens the next pack`)
      }
      // The pack being opened is the (opened + 1)th, and that ordinal is its
      // identity: a period cannot name a pack, because a busy month can exhaust
      // two. Re-running this check writes pack N once however often it fires.
      await writeLine(
        tx, academyId, e, period, 'package', description, amount,
        billingKey.package(e.player_id, e.class_id, opened + 1),
      )
      note(`${e.player_name}: opened ${description} ${formatINR(amount)}`)
      return
    }

    skip(`unknown rate unit ${unit}`)
  })

  await raisePartialPeriod(academyRow, partial.found)
}

/**
 * The owner is told a period was only partly covered — once, and then never
 * again if they say what they want done about it.
 *
 * **`enforced_by` gets its first meaning here.** `business_rule` has carried the
 * column since 0032 and nothing has ever read the table: a rule stated in the
 * owner's words steers a conversation the model is present for, and does exactly
 * nothing to a job composing from a query on the 1st. `enforced_by` is the field
 * that names the typed row which actually gates the automation — and until
 * something reads it, every rule in there is `enforced_by = null` in practice
 * whatever it says.
 *
 * So the settled answer is a SETTING, and the rule points at it. One tap says
 * "this one", the other says "always" and writes both. Doing nothing leaves the
 * full charge standing, which is what the owner already has today.
 *
 * Quiet by default cuts the other way here too: a business that has answered is
 * never asked again, and a business that has not is asked once per line rather
 * than once per month per family, because a period only partly covered happens
 * at a join or an ending and not in between.
 */
async function raisePartialPeriod(academy: AcademyRow | null, found: PartialPeriod | null): Promise<void> {
  if (!academy || !found) return
  const settled = String((academy.settings as Record<string, unknown> | null)?.partial_period ?? '')
  // 'full' and 'prorate' are both ANSWERS. Only an unanswered business is asked,
  // and an unrecognised value is treated as unanswered rather than guessed at.
  if (settled === 'full' || settled === 'prorate') return
  if (academy.onboarding_state !== 'live') return

  const credit = Math.round((found.charged - found.prorata) * 100) / 100
  if (credit <= 0) return

  await withAcademy(academy.id, async (tx) => {
    const recipients = await admins(tx, academy.id)
    for (const admin of recipients) {
      if (!admin.contact_id) continue
      const when =
        found.end === 'finish'
          ? `left part-way through`
          : found.end === 'both'
            ? `was only with you for part of`
            : `joined part-way through`
      await composeAndSend(serviceCtx(academy.id), {
        toContactId: admin.contact_id,
        header: clamp(academy.name, LIMITS.headerChars),
        body: clamp(
          `${found.playerName} ${when} ${monthLabel(found.period, academy.timezone)} — ` +
            `${found.covered} of ${found.days} days — and the bill is the full ${formatINR(found.charged)} ` +
            `for ${found.className}.\n\n` +
            `Pro-rata would be ${formatINR(found.prorata)}, so the difference is ${formatINR(credit)}. ` +
            `Nothing is wrong with the bill; this is your call, and leaving it alone is an answer.`,
          LIMITS.bodyChars,
        ),
        buttons: [
          {
            title: 'Credit this one',
            action: {
              kind: 'steps',
              summary: `Credit ${formatINR(credit)} to ${found.playerName}'s ${monthLabel(found.period, academy.timezone)}`,
              steps: [
                {
                  adjust: {
                    account_id: found.accountId,
                    player_id: found.playerId,
                    period: found.period,
                    amount: -credit,
                    reason: `${found.covered} of ${found.days} days enrolled`,
                    description: `Pro-rata adjustment — ${found.className}`,
                  },
                },
              ],
            },
          },
          {
            title: 'Always pro-rate',
            action: {
              kind: 'steps',
              summary: `Credit ${formatINR(credit)} now, and pro-rate part-months from here on`,
              steps: [
                {
                  adjust: {
                    account_id: found.accountId,
                    player_id: found.playerId,
                    period: found.period,
                    amount: -credit,
                    reason: `${found.covered} of ${found.days} days enrolled`,
                    description: `Pro-rata adjustment — ${found.className}`,
                  },
                },
                // The rule in their words, and the row that makes it bind. Both,
                // or it is a preference the 1st of next month cannot read.
                {
                  write:
                    `insert into business_rule (statement, topic, provenance, enforced_by, visibility) ` +
                    `values ('Part-months are pro-rated to the days actually enrolled.', 'billing', ` +
                    `'owner_stated', 'academy.settings.partial_period', 'internal')`,
                },
                {
                  write:
                    `update academy set settings = coalesce(settings, '{}'::jsonb) ` +
                    `|| '{"partial_period":"prorate"}'::jsonb where id = app.academy_id()`,
                },
              ],
            },
          },
        ],
      })
    }
  })
}

/**
 * One line, once — and now the database is what says so.
 *
 * This used to read: "There is no unique constraint for non-session lines, so the
 * guard is an explicit existence check on what the parent would actually see."
 * That is precisely the defect. `description` is prose — it carries the class
 * name and the month's spelling — so the guard compared two sentences and called
 * them the same charge only when they matched character for character.
 *
 * Driven: a family paid August in full, their class was renamed, and the next run
 * composed a different sentence for the same charge, matched nothing, and billed
 * them a second time. A settled account became ₹1,200 in arrears — far enough to
 * enter the dunning ladder, so the product then chases somebody who has paid.
 *
 * `dedupe_key` is built from ids (`billingKey.*`), and 0023 puts a unique index on
 * it. `on conflict do nothing` makes the constraint the guard rather than a
 * SELECT-then-INSERT, which also closes the race two runners could drive through.
 * `class_id` is written because the row should record what it is FOR — the reason
 * the old guard had to read the description at all was that nothing else did.
 */
/**
 * A recurring line that covers time the enrolment does not.
 *
 * The generic fact, and it is deliberately not "somebody joined mid-month": a
 * line was written for a period the enrolment only PARTLY spans. That is one
 * shape with two ends — joined after the period opened, or left before it
 * closed — and it is a property of the rows, knowable with no conversation
 * having happened and nobody having complained.
 */
type PartialPeriod = {
  playerName: string
  className: string
  accountId: string
  playerId: string
  period: string
  charged: number
  covered: number
  days: number
  prorata: number
  /** Which end of the period the enrolment fell short of, for the sentence. */
  end: 'start' | 'finish' | 'both'
}

/**
 * How much of a billed window this enrolment was actually live for.
 *
 * Dates, not timestamps: a period is a calendar month (or `months` of them) and
 * an enrolment starts and ends on days. Returns null when the window is fully
 * covered, which is the overwhelming majority and costs one comparison.
 */
function partOfPeriod(
  e: EnrollmentRow, period: string, tz: string, months: number,
): PartialPeriod | null {
  const start = DateTime.fromISO(period, { zone: tz }).startOf('day')
  const finish = start.plus({ months: Math.max(1, months) }).minus({ days: 1 })
  const days = Math.round(finish.diff(start, 'days').days) + 1
  if (days <= 0) return null

  const from = DateTime.fromISO(e.started_on, { zone: tz }).startOf('day')
  const to = e.ended_on ? DateTime.fromISO(e.ended_on, { zone: tz }).startOf('day') : null

  const liveFrom = from > start ? from : start
  const liveTo = to && to < finish ? to : finish
  const covered = Math.round(liveTo.diff(liveFrom, 'days').days) + 1
  if (covered >= days || covered <= 0) return null

  return {
    playerName: e.player_name,
    className: e.class_name,
    accountId: e.account_id,
    playerId: e.player_id,
    period,
    charged: 0,
    covered,
    days,
    prorata: 0,
    end: from > start && to && to < finish ? 'both' : from > start ? 'start' : 'finish',
  }
}

async function writeLine(
  tx: Tx, academyId: string, e: EnrollmentRow, period: string,
  kind: 'monthly' | 'term' | 'package', description: string, amount: number,
  dedupeKey: string,
  /**
   * Where a partly-covered period is reported, if this line is one.
   *
   * Collected rather than acted on, because this runs inside the handler's
   * transaction and a message is not a thing to send from inside one. The
   * handler sends after it commits — which also means a rolled-back line never
   * produces a moment about a charge that does not exist.
   */
  partial?: { found: PartialPeriod | null; tz: string; months: number },
): Promise<void> {
  const written = await tx<{ id: string }[]>`
    insert into tally_line (academy_id, account_id, player_id, class_id, period,
                            kind, description, amount, dedupe_key)
    values (${academyId}, ${e.account_id}, ${e.player_id}, ${e.class_id}, ${period}::date,
            ${kind}, ${description}, ${amount}, ${dedupeKey})
    on conflict (academy_id, dedupe_key) where dedupe_key is not null
    do nothing
    returning id
  `
  if (written.length === 0) skip('line already written')

  /**
   * **The machinery will not decide this, and it will not decide it silently
   * either.**
   *
   * DOMAIN_FACTS is right that a rate change or an ending is a decision a person
   * makes — inventing a pro-rata rule nobody stated is how an invention acquires
   * the authority of policy, and this repo has the scar. But "will not decide"
   * and "will decide the maximum, quietly" are different sentences, and the code
   * did the second: a full month billed to somebody enrolled for a fortnight,
   * with no row, no note and nobody told. Driven — three enrolments that started
   * on the 17th were billed a whole August by the go-live tap, and the first
   * human to notice was a parent threatening legal advice on day 7. The model
   * pro-rates correctly the moment a person asks it to; the job never asks.
   *
   * So the full line stands and the owner is told, with the figure worked out.
   * Both ends of the period, not just joining: leaving on the 3rd bills the same
   * whole month for the same reason.
   *
   * Here — where the line is written — rather than in the `per_month` branch,
   * for the reason the free-trial credit above gives about itself: this is the
   * one place a recurring line is written, and a rule repeated in three branches
   * is a rule that will be right in two of them.
   */
  if (partial && (kind === 'monthly' || kind === 'term')) {
    const found = partOfPeriod(e, period, partial.tz, partial.months)
    if (found) {
      found.charged = amount
      // Rounded to paise, the column's own precision. A figure the owner is
      // shown has to be the figure a tap would actually write.
      found.prorata = Math.round(amount * (found.covered / found.days) * 100) / 100
      partial.found = found
    }
  }

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

  /**
   * **One free CLASS, not one free billing period.**
   *
   * §6.4 sizes this precisely: "a negative line equal to the first `session`
   * line." The three units handled here have no session line, and this credited
   * `-amount` — the whole recurring charge. So a trial booked into a `per_month`
   * class got a free month; into `per_term` at ₹15,000, a free term; into a
   * ten-class `per_package`, the entire pack. On the §10.1 prospect funnel,
   * which is auto-confirmed with no admin gate, that is the DEFAULT for every
   * customer who arrives cold — not an edge case.
   *
   * Nobody would have found out. The credit line is honestly written, it reads
   * plausibly on the tally ("First class free — Aarav"), and it makes the total
   * SMALLER, so no parent ever complains. No screen anywhere shows an admin what
   * their free-trial policy costs. That is R6's own "where else to look": a
   * commercial default the product applies without ever asking.
   *
   * The honest price of one class is the period's charge divided by the classes
   * the period actually contains, counted from the `session` rows rather than
   * assumed — a pack of ten is a tenth, a month with eight sessions is an
   * eighth. If the period contains no sessions there is no such thing as "one
   * class" to give away, and the credit is skipped rather than guessed at: an
   * invented number here is exactly the failure this is fixing.
   */
  const perClass = await oneClassOf(tx, academyId, e, period, amount)
  if (perClass === null) {
    note(`${e.player_name} is a trial but ${e.class_name} has no sessions this period — no credit sized`)
    return
  }

  // Both writers spell the reason the same way (lib/billing-keys.ts): it was
  // 'free trial' here and 'free first class' in `operations.ts`, so neither path
  // could see the other's credit and a trial player who met both was credited
  // twice. The key now says the same rule in ids, so the index refuses a second
  // credit even from a writer that spells the reason a third way.
  await tx`
    insert into tally_line (academy_id, account_id, player_id, class_id, period,
                            kind, description, amount, reason, dedupe_key)
    values (${academyId}, ${e.account_id}, ${e.player_id}, ${e.class_id}, ${period}::date, 'adjustment',
            ${freeFirstClassDescription(e.player_name)}, ${-perClass}, ${FREE_FIRST_CLASS_REASON},
            ${billingKey.freeFirstClass(e.player_id)})
    on conflict (academy_id, dedupe_key) where dedupe_key is not null
    do nothing
  `

  /**
   * **The trial is over — say so in the row.**
   *
   * `is_trial` had exactly one writer (`book_trial`, hardcoded true) and no
   * transition out of it. Every `update enrollment` in the repo sets `ended_on`
   * and nothing else. So a player who joined on a trial two years ago is still
   * flagged as a trial to `enrolledPlayers`, to `rosterOf`, to
   * `app.session_roster`, and to the model itself — `schema-doc.ts` hands it the
   * column — and asked "is Aarav still on a trial?" the honest answer from the
   * row is yes, for ever.
   *
   * Their first recurring line has now been billed and their free class has been
   * credited. That IS the conversion, and it is the only moment in the product
   * that unambiguously is one.
   */
  await tx`
    update enrollment set is_trial = false
     where id = ${e.enrollment_id} and academy_id = ${academyId} and is_trial
  `
}

/**
 * What one class is worth, out of a period's charge.
 *
 * Counts the sessions the class actually holds in the period rather than
 * assuming a number, because "how many classes are in a month" is a property of
 * the timetable and differs per class and per month. Cancelled sessions do not
 * count — a family cannot attend one.
 *
 * Returns null when the period holds no sessions at all, which is the honest
 * answer to "what is one class worth" when there are none.
 */
async function oneClassOf(
  tx: Tx, academyId: string, e: EnrollmentRow, period: string, amount: number,
): Promise<number | null> {
  // A pack's size is its own definition of how many classes the charge buys, and
  // it does not depend on which month they fall in.
  if (e.rate_unit === 'per_package') {
    const size = Math.max(1, e.rate_count ?? 1)
    return Math.round((amount / size) * 100) / 100
  }

  const months = e.rate_unit === 'per_term' ? Math.max(1, e.rate_count ?? 1) : 1
  const [row] = await tx<{ n: number }[]>`
    select count(*)::int as n
      from session s
     where s.academy_id = ${academyId} and s.class_id = ${e.class_id}
       and s.status <> 'cancelled'
       and s.starts_at >= ${period}::date
       and s.starts_at < (${period}::date + make_interval(months => ${months}::int))
  `
  const n = Number(row?.n ?? 0)
  if (n <= 0) return null
  return Math.round((amount / n) * 100) / 100
}

/**
 * How many packs have been opened, and how many classes have eaten into them.
 *
 * `opened` counted rows whose `description` matched the sentence this run would
 * compose. That is the same R5 defect as the write guard: rename the class and
 * the count drops to zero, so the next attendance opens — and bills — a pack the
 * family already has. It counts by `class_id` now. The `description` parameter is
 * kept only for the rows written before 0023 backfilled a class onto them.
 */
async function packageState(
  tx: Tx, academyId: string, e: EnrollmentRow, description: string,
): Promise<{ opened: number; consumed: number }> {
  const [row] = await tx<{ opened: number; consumed: number }[]>`
    select
      (select count(*) from tally_line t
        where t.academy_id = ${academyId} and t.player_id = ${e.player_id}
          and t.kind = 'package'
          and (t.class_id = ${e.class_id} or (t.class_id is null and t.description = ${description})))::int as opened,
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
    const runAt = new Date((await now(academyId)).getTime() + DUNNING_INTERVAL_DAYS * 86_400_000)
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
/**
 * `coach_month_lines` — the month a coach worked, written down.
 *
 * The family side of this product freezes money the moment it is earned: a
 * `tally_line` carries the amount and the period, so raising a class rate today
 * cannot change what August's invoice says. The coach side froze nothing, so
 * "what was Priya owed for August" was answered live from `coach.pay_amount` —
 * and an owner who granted a raise "from September" repriced August by typing it.
 *
 * This is the missing artifact. It runs when a month has CLOSED, because that is
 * when the answer stops moving.
 *
 * **The rate is copied into the row, not referenced.** That single column is the
 * fix; everything else here is bookkeeping around it.
 *
 * The per-session and per-hour arms read `coach_pay` rather than rebuilding its
 * predicate. `worked` is subtle — a session is worked if it is over, was not
 * cancelled and was not declined, which is NOT the same as a marked register —
 * and a hand-written second copy of that is exactly how the figure went wrong
 * before (0037's note: the test reached for was `status = 'scheduled'`, true only
 * of sessions that have not happened, so a month of work counted as none).
 *
 * A part-month is written whole, and deliberately: the same rule the tally states
 * for families. Pro-rating is a decision a person makes, and an adjustment line
 * is how they make it.
 */
export async function coachMonthLines(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const coachId = need(p, 'coach_id')
  const period = need(p, 'period')

  await withAcademy(academyId, async (tx) => {
    const academy = await loadAcademy(tx, academyId)
    if (!academy) skip('academy gone')
    const tz = academy.timezone

    // §13 rule 2 — every handler re-checks its own precondition at run time.
    const [coach] = await tx<
      { id: string; full_name: string; pay_amount: string | null; pay_unit: string | null }[]
    >`
      select c.id, pe.full_name, c.pay_amount::text as pay_amount, c.pay_unit
        from coach c join person pe on pe.id = c.person_id
       where c.id = ${coachId} and c.academy_id = ${academyId}
    `
    if (!coach) skip('coach gone')
    // Null pay is "not tracked", a first-class state (0002). No arithmetic turns it
    // into a number, and writing a zero line would read as "worked for nothing".
    if (coach.pay_amount === null) skip('pay is not tracked for this coach')

    const rate = num(coach.pay_amount)
    const unit = coach.pay_unit
    const monthName = monthLabel(period, tz)

    if (unit === 'per_month') {
      // One line, and it may already be here: a rate agreed in advance writes
      // September's row in August under this exact key. Finding it is the feature.
      const written = await tx<{ id: string }[]>`
        insert into coach_ledger
          (academy_id, coach_id, period, kind, description, amount, rate_amount, rate_unit, dedupe_key)
        values (${academyId}, ${coachId}, ${period}::date, 'monthly',
                ${`${monthName} — monthly`}, ${rate}, ${rate}, 'per_month',
                ${coachLedgerKey.monthly(coachId, period)})
        on conflict (academy_id, dedupe_key) do nothing
        returning id
      `
      note(
        written.length
          ? `${firstName(coach.full_name)}: ${monthName} ${formatINR(rate)}`
          : `${firstName(coach.full_name)}: ${monthName} already written — left alone`,
      )
      return
    }

    if (unit !== 'per_session' && unit !== 'per_hour') skip(`pay unit ${String(unit)} has no monthly close`)

    // The view owns `worked` and the per-unit arithmetic. Both are things a second
    // copy gets subtly wrong, and both have.
    const rows = await tx<
      {
        session_id: string
        class_name: string
        local_start: string
        session_hours: string
        amount_for_session: string | null
      }[]
    >`
      select session_id, class_name, local_start,
             session_hours::text as session_hours,
             amount_for_session::text as amount_for_session
        from coach_pay
       where coach_id = ${coachId}
         and academy_id = ${academyId}
         and worked
         and (starts_at at time zone ${tz})::date >= ${period}::date
         and (starts_at at time zone ${tz})::date
             < (${period}::date + interval '1 month')::date
       order by starts_at
    `
    if (rows.length === 0) skip('nothing worked in this period')

    let total = 0
    for (const r of rows) {
      const amount = num(r.amount_for_session)
      if (amount <= 0) continue
      total += amount
      await tx`
        insert into coach_ledger
          (academy_id, coach_id, period, kind, description, amount, rate_amount, rate_unit,
           session_id, dedupe_key)
        values (${academyId}, ${coachId}, ${period}::date,
                ${unit === 'per_hour' ? 'hourly' : 'session'},
                ${
                  unit === 'per_hour'
                    ? `${r.class_name} — ${r.local_start} (${num(r.session_hours)}h)`
                    : `${r.class_name} — ${r.local_start}`
                },
                ${amount}, ${rate}, ${unit}, ${r.session_id},
                ${
                  unit === 'per_hour'
                    ? coachLedgerKey.hourly(coachId, r.session_id)
                    : coachLedgerKey.session(coachId, r.session_id)
                })
        on conflict (academy_id, dedupe_key) do nothing
      `
    }
    note(`${firstName(coach.full_name)}: ${monthName} ${rows.length} session(s), ${formatINR(total)}`)
  })
}

export async function dunningRun(job: Job): Promise<void> {
  const p = payloadOf(job)
  const academyId = need(p, 'academy_id')
  const accountId = need(p, 'account_id')
  const period = need(p, 'period')
  const n = numberOf(p, 'n', 1)
  const nowAt = await now(academyId)

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

    // Two figures, because they answer two different questions and this ladder
    // used to print one under the other's name.
    //
    // `outstanding` is a LIFETIME account balance: every tally line ever raised,
    // less every confirmed payment. It has no period filter and cannot have one —
    // `payment` carries no period, so a payment cannot be attributed to a month
    // and "what is owed for August" is not a computable quantity here.
    //
    // The ladder is nonetheless keyed per (account, period), and the message said
    // "<lifetime> is still open on <that month>". For a family carrying anything
    // older that is a wrong number attached to a named month, on the one channel
    // where being wrong about money is the expensive failure. The predicate was
    // right; the sentence was not. So: keep the predicate, read the period's own
    // charges alongside it, and let the sentence say only what is true.
    const [totals] = await tx<{ billed: number; paid: number; period_billed: number }[]>`
      select
        coalesce((select sum(amount) from tally_line
                   where academy_id = ${academyId} and account_id = ${accountId}), 0)::float8 as billed,
        coalesce((select sum(amount) from payment
                   where academy_id = ${academyId} and account_id = ${accountId}
                     and status = 'confirmed'), 0)::float8 as paid,
        coalesce((select sum(amount) from tally_line
                   where academy_id = ${academyId} and account_id = ${accountId}
                     and period = ${period}::date), 0)::float8 as period_billed
    `
    const outstanding = num(totals?.billed) - num(totals?.paid)
    if (outstanding <= 0) skip('paid up')
    const periodBilled = num(totals?.period_billed)

    const contactId = await contactFor(tx, academyId, account.holder_person_id)
    const adminRows = (await admins(tx, academyId)).filter((a) => a.contact_id)
    return { academy, account, outstanding, periodBilled, contactId, adminRows }
  })

  const { academy, account, outstanding, periodBilled, contactId, adminRows } = plan
  const tz = academy.timezone

  // Naming the month is only honest when the whole balance IS that month's.
  //
  // The `including` branch is guarded on `periodBilled < outstanding`, not merely on
  // `periodBilled > 0`, because a partly-paid month makes the month's charge LARGER than
  // what is left owing — ₹1,200 billed for August, ₹700 paid, ₹500 outstanding — and the
  // sentence would have read "₹500 is still open, including ₹1,200 for August". A part
  // cannot exceed its whole; a family reading that has been told something impossible
  // about their own money, which is worse than being told a vaguer true thing.
  const owedLine =
    Math.abs(outstanding - periodBilled) < 0.005
      ? `${formatINR(outstanding)} for ${monthLabel(period, tz)} is still open.`
      : periodBilled > 0 && periodBilled < outstanding
        ? `${formatINR(outstanding)} is still open on your account, including ${formatINR(periodBilled)} for ${monthLabel(period, tz)}.`
        : `${formatINR(outstanding)} is still open on your account.`

  if (contactId) {
    await composeAndSend(serviceCtx(academy.id), {
      toContactId: contactId,
      header: clamp(academy.name, LIMITS.headerChars),
      body: clamp(joinLines([
        owedLine,
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
      // Same distinction as the family's message above: the figure is a lifetime
      // balance, so it is only this month's when nothing older is outstanding.
      body: clamp(
        (Math.abs(outstanding - periodBilled) < 0.005
          ? `${account.holder_name} still owes ${formatINR(outstanding)} for ${monthLabel(period, tz)}. `
          : `${account.holder_name} still owes ${formatINR(outstanding)} in total, chased for ${monthLabel(period, tz)}. `)
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
  const nowAt = await now(academyId)

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
          /**
           * §2.2 — minted resolved, replayed verbatim. This was
           * `{kind:'reply', text:"Yes — …'s ₹X came in, confirm it"}`: a
           * sentence handed back to the model to re-interpret, which made **a
           * money state transition a tap-time inference** on the one table where
           * being wrong costs the business real money. The payment id is right
           * here; the button carries the row.
           *
           * It carried `{kind:'operation', op:'confirm_payment'}` until the
           * wrapper operations went. The statement is what the operation was —
           * confirm THIS request, never one matching an amount — and `steps` is
           * the shape that carries a statement. `requireRows: 1` is the part that
           * matters: a payment already confirmed, or confirmed by somebody else
           * between the ask and the tap, aborts rather than silently doing
           * nothing, and the tap path reports it as a race rather than as done.
           */
          title: buttonTitle('Yes, received'),
          action: {
            kind: 'steps',
            summary: `confirm the ${formatINR(num(pay.amount))} from ${pay.holder_name}`,
            steps: [
              {
                write:
                  `update payment set status = 'confirmed', confirmed_at = app.now()` +
                  ` where id = '${paymentId}'::uuid and status = 'requested'`,
                requireRows: 1,
              },
              { note: `${formatINR(num(pay.amount))} from ${pay.holder_name} confirmed` },
            ],
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

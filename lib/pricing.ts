/**
 * What a turn cost, in one place.
 *
 * This table used to live inside `scripts/probe-model.ts` alone, so `drive cost`
 * printed tokens and seconds and no money at all, and the only figure in rupees
 * anybody could quote came out of the probe. Two readers of the same run could
 * not compare a hand-driven turn against a probed one because only one of them
 * had a price.
 *
 * These are LIST PRICES PER 1M TOKENS AND THEY ARE AN ASSUMPTION, not something
 * this repo can measure. Edit them when the price list moves; every figure
 * downstream is derived from this table and nothing else, so it is one place to
 * be wrong — which is why the probe's duplicate copy was deleted and it now
 * imports this one.
 *
 * **Cached input is its own rate, not a fraction of input.** The old formula
 * hardcoded `× 0.25`, which was Gemini's ratio. DeepSeek bills a cache-hit token
 * at **3.2%** of a miss, so the fraction would overstate cached cost about
 * eightfold — in the direction that makes the cheaper provider look dearer, and
 * on the exact axis this migration was decided on. A rate per row cannot drift
 * like that.
 */
export type Price = {
  /** Input, cache miss. */
  in: number
  /** Input, cache hit. A rate, not a discount — see above. */
  cachedIn: number
  out: number
  /**
   * What this provider charges at peak, as a multiple of the rates above.
   * DeepSeek doubles; Google does not, and a `peakMultiplier` of 1 on the Gemini
   * rows is what keeps `costUsd` from needing to know which provider it prices.
   */
  peakMultiplier: number
}

export const PRICES: Record<string, Price> = {
  // DeepSeek, off-peak, from 2026-08-16 16:00 UTC. Peak doubles every row, which
  // `peakMultiplier` applies rather than a second table doing it.
  'deepseek-v4-flash': { in: 0.22, cachedIn: 0.007, out: 0.66, peakMultiplier: 2 },
  'deepseek-v4-pro': { in: 0.66, cachedIn: 0.022, out: 1.98, peakMultiplier: 2 },

  // Gemini, kept for as long as `gemini.ts` is the rollback road, and so that a
  // turn recorded before the cutover still prices correctly when read back.
  'gemini-2.5-flash': { in: 0.3, cachedIn: 0.075, out: 2.5, peakMultiplier: 1 },
  'gemini-2.5-pro': { in: 1.25, cachedIn: 0.3125, out: 10, peakMultiplier: 1 },
  'gemini-3-flash-preview': { in: 0.3, cachedIn: 0.075, out: 2.5, peakMultiplier: 1 },
  'gemini-3-pro-preview': { in: 1.25, cachedIn: 0.3125, out: 10, peakMultiplier: 1 },
}

/** Also an assumption, and also better in one place than in three. */
export const USD_INR = 88

/**
 * DeepSeek's peak window, in UTC hours: 01:00–04:00 and 06:00–10:00, which is
 * **06:30–09:30 and 11:30–15:30 IST**. Morning academies therefore pay double
 * and evening traffic does not, and two identical runs at different times of day
 * bill differently — an unexplained cost delta between two probe runs is usually
 * this and not a finding.
 *
 * `at` is passed in, never read from a clock here: the billing window is real
 * wall-clock time on DeepSeek's servers, and `sim_clock` moving a tenant's day
 * must not change what a call cost. A caller with no timestamp gets the
 * off-peak rate, which is the honest default — it is the rate the plan's
 * estimates were made at, and it never quietly inflates a total.
 */
export function isPeak(at: Date): boolean {
  const h = at.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

function priceFor(model: string): Price | null {
  return PRICES[model] ?? PRICES[Object.keys(PRICES).find((k) => model.startsWith(k)) ?? ''] ?? null
}

/**
 * Dollars for one model call, or null when the model is not in the table —
 * `null` rather than `0` because "we do not know" and "it was free" are
 * different facts and a total that silently swallows the first is a lie.
 *
 * `cachedTok` is a SUBSET of `inTok`, not an addition to it, on both providers.
 */
export function costUsd(
  model: string,
  inTok: number,
  cachedTok: number,
  outTok: number,
  at?: Date,
): number | null {
  const p = priceFor(model)
  if (!p) return null
  const mult = at && isPeak(at) ? p.peakMultiplier : 1
  const fresh = Math.max(0, inTok - cachedTok)
  return ((fresh * p.in + cachedTok * p.cachedIn + outTok * p.out) / 1e6) * mult
}

/** The same number in rupees, which is the unit every note in this repo quotes. */
export function costInr(
  model: string,
  inTok: number,
  cachedTok: number,
  outTok: number,
  at?: Date,
): number | null {
  const usd = costUsd(model, inTok, cachedTok, outTok, at)
  return usd === null ? null : usd * USD_INR
}

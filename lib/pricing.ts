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
 * this repo can measure. Cached input is billed at 25% of input. Edit them when
 * the price list moves; every figure downstream is derived from this table and
 * nothing else, so it is one place to be wrong.
 */
export const PRICES: Record<string, { in: number; out: number }> = {
  'gemini-2.5-flash': { in: 0.3, out: 2.5 },
  'gemini-2.5-pro': { in: 1.25, out: 10 },
  'gemini-3-flash-preview': { in: 0.3, out: 2.5 },
  'gemini-3-pro-preview': { in: 1.25, out: 10 },
}

/** Also an assumption, and also better in one place than in three. */
export const USD_INR = 88

/**
 * Dollars for one model call, or null when the model is not in the table —
 * `null` rather than `0` because "we do not know" and "it was free" are
 * different facts and a total that silently swallows the first is a lie.
 */
export function costUsd(model: string, inTok: number, cachedTok: number, outTok: number): number | null {
  const p = PRICES[model] ?? PRICES[Object.keys(PRICES).find((k) => model.startsWith(k)) ?? '']
  if (!p) return null
  const fresh = Math.max(0, inTok - cachedTok)
  return (fresh * p.in + cachedTok * p.in * 0.25 + outTok * p.out) / 1e6
}

/** The same number in rupees, which is the unit every note in this repo quotes. */
export function costInr(model: string, inTok: number, cachedTok: number, outTok: number): number | null {
  const usd = costUsd(model, inTok, cachedTok, outTok)
  return usd === null ? null : usd * USD_INR
}

import { ONE } from "./format";

export interface WeightedLeg {
  /** Share of one share's value, 0 to 1. */
  weight: number;
  /** USD per whole unit; null when nothing prices the asset. */
  priceUsd: number | null;
}

/** Sum of weights given as percentages, rounded to hundredths to absorb float noise. */
export function percentTotal(percents: readonly number[]): number {
  return Math.round(percents.reduce((sum, p) => sum + (Number.isFinite(p) ? p : 0), 0) * 100) / 100;
}

/**
 * Units of each asset one share holds at launch so that a share is worth
 * `navPerShare` and each leg carries its weight of that value. Units are in
 * base units (7 decimals), at least one. Null when any leg is unpriced or the
 * inputs can't make a share.
 */
export function unitsForWeights(legs: readonly WeightedLeg[], navPerShare: number): bigint[] | null {
  if (!legs.length || !(navPerShare > 0)) return null;
  const units: bigint[] = [];
  for (const leg of legs) {
    if (leg.priceUsd === null || !(leg.priceUsd > 0) || !(leg.weight > 0)) return null;
    const whole = (leg.weight * navPerShare) / leg.priceUsd;
    const base = BigInt(Math.round(whole * Number(ONE)));
    units.push(base > 0n ? base : 1n);
  }
  return units;
}

/** What one share is worth at these prices, for a units-per-share basket. */
export function shareValue(units: readonly bigint[], prices: readonly (number | null)[]): number | null {
  let total = 0;
  for (const [i, u] of units.entries()) {
    const price = prices[i];
    if (price === null || price === undefined) return null;
    total += (Number(u) / Number(ONE)) * price;
  }
  return total;
}

/** Even weights in whole percents that add to 100, the remainder on the first legs. */
export function evenPercents(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(100 / count);
  const extra = 100 - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
}

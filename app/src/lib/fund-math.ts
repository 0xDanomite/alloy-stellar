import { unitsToNumber } from "./format";
import type { Fund, FundComponent } from "./stellar";

/** The price a leg is valued at: oracle when the fund has a full oracle NAV, else the SDEX price. */
export function legPrice(fund: Fund, leg: FundComponent): number | null {
  if (fund.navPerShare !== null) return leg.oracle?.priceUsd ?? null;
  return leg.priceUsdc;
}

/** Each leg's share of one fund share's value, or null for every leg when any leg is unpriced. */
export function legWeights(fund: Fund): (number | null)[] {
  const values = fund.components.map((leg) => {
    const price = legPrice(fund, leg);
    return price === null ? null : unitsToNumber(leg.unitsPerShare) * price;
  });
  if (values.some((v) => v === null)) return values.map(() => null);
  const total = values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  if (total <= 0) return values.map(() => null);
  return values.map((v) => (v ?? 0) / total);
}

/** Total oracle value of a fund's shares in USD, or null when the oracle can't price every leg. */
export function fundValueUsd(fund: Fund): number | null {
  if (fund.navTotal !== null) return fund.navTotal;
  if (fund.navPerShare === null) return null;
  return fund.navPerShare * unitsToNumber(fund.totalSupply);
}

export interface PlatformTotals {
  valueUsd: number;
  priced: number;
  unpriced: Fund[];
}

export function platformTotals(funds: Fund[]): PlatformTotals {
  let valueUsd = 0;
  let priced = 0;
  const unpriced: Fund[] = [];
  for (const fund of funds) {
    const value = fundValueUsd(fund);
    if (value === null) {
      unpriced.push(fund);
    } else {
      valueUsd += value;
      priced += 1;
    }
  }
  return { valueUsd, priced, unpriced };
}

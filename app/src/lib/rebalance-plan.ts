import { ONE } from "./format";

export interface PlanLeg {
  token: string;
  code: string;
  /** What the fund holds, in base units. */
  holding: bigint;
  /** Oracle USD price per whole unit; null when unpriced. */
  priceUsd: number | null;
}

export interface PlannedTrade {
  sell: string;
  buy: string;
  /** Base units of `sell` to give up. */
  sold: bigint;
  /** Base units of `buy` the trade is worth at oracle prices. */
  bought: bigint;
  valueUsd: number;
}

const whole = (units: bigint) => Number(units) / Number(ONE);
const toBase = (amount: number) => BigInt(Math.floor(amount * Number(ONE)));

/** Each leg's share of fund value at oracle prices, or null when any leg is unpriced or the fund is empty. */
export function currentWeights(legs: readonly PlanLeg[]): number[] | null {
  if (legs.some((l) => l.priceUsd === null)) return null;
  const values = legs.map((l) => whole(l.holding) * (l.priceUsd ?? 0));
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return values.map((v) => v / total);
}

export function fundValue(legs: readonly PlanLeg[]): number | null {
  if (legs.some((l) => l.priceUsd === null)) return null;
  return legs.reduce((sum, l) => sum + whole(l.holding) * (l.priceUsd ?? 0), 0);
}

/**
 * The trades that move the fund from its current weights to `targets`
 * (fractions summing to one), each selling one overweight leg for one
 * underweight leg. Largest gaps pair first, so the plan needs at most
 * legs - 1 trades. Gaps under `minUsd` are left alone. Amounts are at oracle
 * prices; sells round down so a trade never asks for more than is held.
 */
export function planTrades(legs: readonly PlanLeg[], targets: readonly number[], minUsd = 1): PlannedTrade[] {
  const total = fundValue(legs);
  if (total === null || !(total > 0) || targets.length !== legs.length) return [];
  const gaps = legs.map((l, i) => ({
    index: i,
    gap: (targets[i] ?? 0) * total - whole(l.holding) * (l.priceUsd ?? 0),
  }));
  const sells = gaps.filter((g) => g.gap < -minUsd).map((g) => ({ ...g, left: -g.gap })).sort((a, b) => b.left - a.left);
  const buys = gaps.filter((g) => g.gap > minUsd).map((g) => ({ ...g, left: g.gap })).sort((a, b) => b.left - a.left);

  const trades: PlannedTrade[] = [];
  let s = 0;
  let b = 0;
  while (s < sells.length && b < buys.length) {
    const sell = sells[s];
    const buy = buys[b];
    if (!sell || !buy) break;
    const usd = Math.min(sell.left, buy.left);
    const sellLeg = legs[sell.index];
    const buyLeg = legs[buy.index];
    if (usd >= minUsd && sellLeg?.priceUsd && buyLeg?.priceUsd) {
      const sold = toBase(usd / sellLeg.priceUsd);
      const capped = sold > sellLeg.holding ? sellLeg.holding : sold;
      if (capped > 0n) {
        trades.push({
          sell: sellLeg.token,
          buy: buyLeg.token,
          sold: capped,
          bought: toBase((whole(capped) * sellLeg.priceUsd) / buyLeg.priceUsd),
          valueUsd: whole(capped) * sellLeg.priceUsd,
        });
      }
    }
    sell.left -= usd;
    buy.left -= usd;
    if (sell.left < minUsd) s++;
    if (buy.left < minUsd) b++;
  }
  return trades;
}

/** 1 bps of fund value is 100_000 parts per billion. */
export const PPB_PER_BPS = 100_000n;
/** All rebalances in a rolling day may give up at most 2% of fund value. */
export const WINDOW_LOSS_BUDGET_BPS = 200;
/** One trade may give up at most 1% of what it sells, at oracle prices. */
export const TRADE_LOSS_BPS = 100;

/** Loss budget left in the rolling window, in bps of fund value. */
export function lossBudgetLeftBps(windowLossPpb: bigint): number {
  const used = Number(windowLossPpb) / Number(PPB_PER_BPS);
  return Math.max(0, WINDOW_LOSS_BUDGET_BPS - used);
}

/** The least of `buy` the contract accepts for `sold` of `sell`: 99% of its oracle value. */
export function oracleFloor(sold: bigint, sellPrice: number, buyPrice: number): bigint {
  const value = whole(sold) * sellPrice * (1 - TRADE_LOSS_BPS / 10_000);
  return BigInt(Math.ceil((value / buyPrice) * Number(ONE)));
}

/** What a fill gives up against oracle value, as bps of fund value; zero for a fill at or above oracle. */
export function lossOfFundBps(sold: bigint, sellPrice: number, bought: bigint, buyPrice: number, fundValueUsd: number): number {
  const lost = whole(sold) * sellPrice - whole(bought) * buyPrice;
  if (!(lost > 0) || !(fundValueUsd > 0)) return 0;
  return (lost / fundValueUsd) * 10_000;
}

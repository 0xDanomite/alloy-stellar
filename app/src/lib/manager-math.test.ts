import { describe, expect, it } from "vitest";
import { annualFeeUsd, feeShares, formatBps, percentToBps, sharesUsd, splitFee, stakeAfter, YEAR_SECONDS } from "./fee-math";
import { ONE } from "./format";
import {
  currentWeights,
  lossBudgetLeftBps,
  lossOfFundBps,
  oracleFloor,
  planTrades,
  type PlanLeg,
} from "./rebalance-plan";
import { evenPercents, percentTotal, shareValue, unitsForWeights } from "./weights";

const units = (n: number) => BigInt(Math.round(n * Number(ONE)));

describe("unitsForWeights", () => {
  it("sizes each leg to its weight of the launch NAV", () => {
    const result = unitsForWeights(
      [
        { weight: 0.5, priceUsd: 1 },
        { weight: 0.5, priceUsd: 0.25 },
      ],
      10,
    );
    expect(result).toEqual([units(5), units(20)]);
  });

  it("prices back to the launch NAV", () => {
    const prices = [1.0002, 0.2531, 107.2];
    const result = unitsForWeights(
      [
        { weight: 0.6, priceUsd: prices[0] ?? null },
        { weight: 0.25, priceUsd: prices[1] ?? null },
        { weight: 0.15, priceUsd: prices[2] ?? null },
      ],
      1,
    );
    expect(result).not.toBeNull();
    expect(shareValue(result ?? [], prices)).toBeCloseTo(1, 4);
  });

  it("refuses unpriced legs, zero weights and a zero NAV", () => {
    expect(unitsForWeights([{ weight: 1, priceUsd: null }], 1)).toBeNull();
    expect(unitsForWeights([{ weight: 0, priceUsd: 1 }], 1)).toBeNull();
    expect(unitsForWeights([{ weight: 1, priceUsd: 1 }], 0)).toBeNull();
  });

  it("never rounds a leg down to nothing", () => {
    expect(unitsForWeights([{ weight: 1e-12, priceUsd: 50_000 }], 1)).toEqual([1n]);
  });
});

describe("percent helpers", () => {
  it("splits evenly with the remainder up front", () => {
    expect(evenPercents(3)).toEqual([34, 33, 33]);
    expect(percentTotal(evenPercents(7))).toBe(100);
  });

  it("totals without float noise", () => {
    expect(percentTotal([33.33, 33.33, 33.34])).toBe(100);
  });
});

const leg = (code: string, holding: number, priceUsd: number | null): PlanLeg => ({
  token: `C${code}`,
  code,
  holding: units(holding),
  priceUsd,
});

describe("planTrades", () => {
  it("sells the overweight leg into the underweight one", () => {
    const legs = [leg("USDC", 80, 1), leg("XLM", 80, 0.25)];
    expect(currentWeights(legs)).toEqual([0.8, 0.2]);
    const trades = planTrades(legs, [0.5, 0.5]);
    expect(trades).toHaveLength(1);
    const [trade] = trades;
    expect(trade?.sell).toBe("CUSDC");
    expect(trade?.buy).toBe("CXLM");
    expect(trade?.sold).toBe(units(30));
    expect(trade?.bought).toBe(units(120));
    expect(trade?.valueUsd).toBeCloseTo(30);
  });

  it("pairs the largest gaps first and needs at most n - 1 trades", () => {
    const legs = [leg("A", 50, 1), leg("B", 30, 1), leg("C", 10, 1), leg("D", 10, 1)];
    const trades = planTrades(legs, [0.25, 0.25, 0.25, 0.25]);
    expect(trades.length).toBeLessThanOrEqual(3);
    const moved = new Map<string, number>();
    for (const t of trades) {
      moved.set(t.sell, (moved.get(t.sell) ?? 0) - Number(t.sold) / Number(ONE));
      moved.set(t.buy, (moved.get(t.buy) ?? 0) + Number(t.bought) / Number(ONE));
    }
    expect(moved.get("CA")).toBeCloseTo(-25);
    expect(moved.get("CB")).toBeCloseTo(-5);
    expect(moved.get("CC")).toBeCloseTo(15);
    expect(moved.get("CD")).toBeCloseTo(15);
  });

  it("leaves gaps under the minimum alone", () => {
    expect(planTrades([leg("A", 50.4, 1), leg("B", 49.6, 1)], [0.5, 0.5], 1)).toEqual([]);
  });

  it("plans nothing when a leg is unpriced", () => {
    expect(planTrades([leg("A", 50, 1), leg("B", 50, null)], [0.2, 0.8])).toEqual([]);
    expect(currentWeights([leg("A", 50, 1), leg("B", 50, null)])).toBeNull();
  });
});

describe("trade bounds", () => {
  it("floors a trade at 99% of oracle value", () => {
    expect(oracleFloor(units(100), 1, 0.25)).toBe(units(396));
  });

  it("reads the loss budget from window_loss_ppb", () => {
    expect(lossBudgetLeftBps(0n)).toBe(200);
    expect(lossBudgetLeftBps(5_000_000n)).toBe(150);
    expect(lossBudgetLeftBps(30_000_000n)).toBe(0);
  });

  it("charges only a fill below oracle value", () => {
    expect(lossOfFundBps(units(10), 1, units(39.6), 0.25, 1000)).toBeCloseTo(1);
    expect(lossOfFundBps(units(10), 1, units(41), 0.25, 1000)).toBe(0);
  });
});

describe("fee math", () => {
  it("mints a year of a 1% fee as 1% of the fund after minting", () => {
    const supply = 1_000n * ONE;
    const minted = feeShares(supply, 100, YEAR_SECONDS);
    expect(Number(minted) / Number(supply + minted)).toBeCloseTo(0.01, 9);
  });

  it("caps elapsed time at a year and mints nothing at 0%", () => {
    const supply = 1_000n * ONE;
    expect(feeShares(supply, 100, YEAR_SECONDS * 3)).toBe(feeShares(supply, 100, YEAR_SECONDS));
    expect(feeShares(supply, 0, YEAR_SECONDS)).toBe(0n);
  });

  it("splits the platform's cut rounding down", () => {
    expect(splitFee(1001n, 2_500)).toEqual({ manager: 751n, platform: 250n });
    expect(splitFee(1000n, 0)).toEqual({ manager: 1000n, platform: 0n });
  });

  it("values shares and a year of fees", () => {
    expect(sharesUsd(2n * ONE, 10.5)).toBe(21);
    expect(sharesUsd(ONE, null)).toBeNull();
    expect(annualFeeUsd(100_000, 100, 2_000)).toEqual({ total: 1_000, manager: 800, platform: 200 });
    expect(stakeAfter(100, 1)).toBeCloseTo(0.99);
  });

  it("formats and parses percents", () => {
    expect(formatBps(100)).toBe("1%");
    expect(formatBps(75)).toBe("0.75%");
    expect(formatBps(50)).toBe("0.5%");
    expect(percentToBps("1.25")).toBe(125);
    expect(percentToBps("5")).toBe(500);
    expect(percentToBps("5.01")).toBeNull();
    expect(percentToBps("-1")).toBeNull();
  });
});

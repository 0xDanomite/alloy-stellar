import { describe, expect, it } from "vitest";
import { percentsByValue, templateFrom } from "./duplicate";
import type { Fund, FundComponent, OracleQuote } from "./stellar";
import { percentTotal } from "./weights";

const ONE = 10_000_000n;

const quote = (priceUsd: number): OracleQuote => ({ priceUsd, source: "reflector", timestamp: 0, divergenceBps: null });

function leg(code: string, units: bigint, oracle: number | null, market: number | null = oracle): FundComponent {
  return { token: `C${code}`, code, unitsPerShare: units, oracle: oracle === null ? null : quote(oracle), priceUsdc: market } as FundComponent;
}

function fund(components: FundComponent[], overrides: Partial<Fund> = {}): Fund {
  return {
    id: "CFUND",
    name: "Cash Plus",
    symbol: "aCASH",
    compliance: "Allowlist",
    totalSupply: 10n * ONE,
    components,
    valuePerShare: null,
    navPerShare: null,
    navTotal: null,
    hasOracle: true,
    awaitingIssuer: [],
    manager: "GMANAGER",
    wasmHash: null,
    platform: "CPLATFORM",
    navContract: null,
    setup: {
      open: true,
      mandate: "Managed",
      fee: { rateBps: 75, lastAccrual: 0 },
      platformFee: null,
      feeRecipient: "GMANAGER",
      lastRebalance: null,
    },
    metadata: { description: "Short treasuries.", strategy: "Quarterly." },
    hidden: false,
    official: false,
    imitates: null,
    unusualText: false,
    ...overrides,
  };
}

const shelf = (...codes: string[]) => new Set(codes.map((c) => `C${c}`));

describe("percentsByValue", () => {
  it("splits by value and adds to exactly 100", () => {
    expect(percentsByValue([6, 3, 1])).toEqual([60, 30, 10]);
    const thirds = percentsByValue([1, 1, 1]);
    expect(thirds).toEqual([33.34, 33.33, 33.33]);
    expect(percentTotal(thirds ?? [])).toBe(100);
  });

  it("gives the rounding remainder to the legs it shorted most", () => {
    expect(percentsByValue([2, 1])).toEqual([66.67, 33.33]);
  });

  it("keeps a dust leg at 0.01% and takes it from the largest", () => {
    const p = percentsByValue([1_000_000, 1]);
    expect(p).toEqual([99.99, 0.01]);
  });

  it("is null when a leg is unpriced or nothing has value", () => {
    expect(percentsByValue([1, null])).toBeNull();
    expect(percentsByValue([0, 0])).toBeNull();
    expect(percentsByValue([])).toBeNull();
  });
});

describe("templateFrom", () => {
  it("weights by oracle value per share, not by units", () => {
    // 5 USDC at $1 and 50 XLM at $0.30: $5 and $15 a share.
    const f = fund([leg("USDC", 5n * ONE, 1), leg("XLM", 50n * ONE, 0.3)]);
    const t = templateFrom(f, shelf("USDC", "XLM"));
    expect(t.weightedBy).toBe("oracle");
    expect(t.tokens).toEqual(["CUSDC", "CXLM"]);
    expect(t.percents).toEqual({ CUSDC: "25", CXLM: "75" });
  });

  it("copies access, mandate, fee and profile, and names the copy", () => {
    const t = templateFrom(fund([leg("USDC", ONE, 1)]), shelf("USDC"));
    expect(t.name).toBe("Cash Plus (copy)");
    expect(t.symbol).toBe("aCASH2");
    expect(t.access).toBe("Allowlist");
    expect(t.mandate).toBe("Managed");
    expect(t.fee).toBe("0.75");
    expect(t.metadata).toEqual({ description: "Short treasuries.", strategy: "Quarterly.", website: "" });
  });

  it("keeps the name and symbol inside the create form's limits", () => {
    const t = templateFrom(fund([leg("USDC", ONE, 1)], { name: "N".repeat(48), symbol: "ABCDEFGHIJKL" }), shelf("USDC"));
    expect(t.name.length).toBeLessThanOrEqual(48);
    expect(t.name.endsWith(" (copy)")).toBe(true);
    expect(t.symbol).toBe("ABCDEFGHIJK2");
  });

  it("falls back to market prices for a leg the oracle doesn't price, then to an even split", () => {
    const market = templateFrom(fund([leg("USDC", ONE, 1), leg("BENJI", ONE, null, 3)]), shelf("USDC", "BENJI"));
    expect(market.weightedBy).toBe("market");
    expect(market.percents).toEqual({ CUSDC: "25", CBENJI: "75" });

    const even = templateFrom(fund([leg("USDC", ONE, 1), leg("CETES", ONE, null, null)]), shelf("USDC", "CETES"));
    expect(even.weightedBy).toBe("even");
    expect(even.percents).toEqual({ CUSDC: "50", CCETES: "50" });
  });

  it("drops assets the creation shelf doesn't list and reweights the rest", () => {
    const t = templateFrom(fund([leg("USDC", ONE, 1), leg("XLM", ONE, 1), leg("OLD", ONE, 1)]), shelf("USDC", "XLM"));
    expect(t.dropped).toEqual(["OLD"]);
    expect(t.percents).toEqual({ CUSDC: "50", CXLM: "50" });
  });

  it("starts a pre-v0.4 fund Locked with no fee", () => {
    const t = templateFrom(fund([leg("USDC", ONE, 1)], { setup: null, metadata: {} }), shelf("USDC"));
    expect(t.mandate).toBe("Locked");
    expect(t.fee).toBe("0");
  });
});

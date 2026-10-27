import { describe, expect, it } from "vitest";
import { candidatePairs, legDepth, maxIn, minOut, pairKey, routeFromUsdc, zapPaths } from "./zap-math";

const USDC = "CUSDC";
const XLM = "CXLM";
const USTRY = "CUSTRY";
const USDY = "CUSDY";
const BENJI = "CBENJI";

const pairs = new Set([pairKey(USDC, XLM), pairKey(USDC, USTRY), pairKey(XLM, USDY)]);

describe("routeFromUsdc", () => {
  it("goes direct when a USDC pair exists", () => {
    expect(routeFromUsdc(USTRY, USDC, XLM, pairs)).toEqual([USDC, USTRY]);
    expect(routeFromUsdc(XLM, USDC, XLM, pairs)).toEqual([USDC, XLM]);
  });

  it("routes through XLM when only XLM pairs reach the leg", () => {
    expect(routeFromUsdc(USDY, USDC, XLM, pairs)).toEqual([USDC, XLM, USDY]);
  });

  it("needs the USDC/XLM pair for the XLM hop", () => {
    const noBridge = new Set([pairKey(XLM, USDY)]);
    expect(routeFromUsdc(USDY, USDC, XLM, noBridge)).toBeNull();
  });

  it("returns null when no pool reaches the leg", () => {
    expect(routeFromUsdc(BENJI, USDC, XLM, pairs)).toBeNull();
  });

  it("reads pairs in either order", () => {
    expect(pairKey(USDC, XLM)).toBe(pairKey(XLM, USDC));
  });
});

describe("candidatePairs", () => {
  it("lists each pair once and skips the USDC leg", () => {
    const keys = candidatePairs([USDC, XLM, USTRY, USDY], USDC, XLM).map(([a, b]) => pairKey(a, b));
    expect(new Set(keys)).toEqual(
      new Set([pairKey(USDC, XLM), pairKey(USDC, USTRY), pairKey(XLM, USTRY), pairKey(USDC, USDY), pairKey(XLM, USDY)]),
    );
    expect(keys).toHaveLength(5);
  });
});

describe("zapPaths", () => {
  const legs = [
    { token: USDC, path: null },
    { token: USTRY, path: [USDC, USTRY] },
    { token: XLM, path: [USDC, XLM] },
    { token: USDY, path: [USDC, XLM, USDY] },
  ];

  it("keeps component order and skips USDC when issuing", () => {
    expect(zapPaths(legs, USDC, "issue")).toEqual([[USDC, USTRY], [USDC, XLM], [USDC, XLM, USDY]]);
  });

  it("reverses each route when redeeming", () => {
    expect(zapPaths(legs, USDC, "redeem")).toEqual([[USTRY, USDC], [XLM, USDC], [USDY, XLM, USDC]]);
  });

  it("is null when any leg has no route", () => {
    expect(zapPaths([...legs, { token: BENJI, path: null }], USDC, "issue")).toBeNull();
  });

  it("needs no routes for an all-USDC fund", () => {
    expect(zapPaths([{ token: USDC, path: null }], USDC, "issue")).toEqual([]);
  });
});

describe("legDepth", () => {
  const ONE = 10_000_000n;

  it("passes an issue quote within 3% of the oracle value", () => {
    expect(legDepth(10_200_000n, ONE, 1, "issue")).toEqual({ fair: ONE, worseBps: 200, thin: false, unpriced: false });
  });

  it("flags an issue quote more than 3% above the oracle value", () => {
    expect(legDepth(10_310_000n, ONE, 1, "issue")).toMatchObject({ worseBps: 310, thin: true });
  });

  it("treats exactly 3% as still usable", () => {
    expect(legDepth(10_300_000n, ONE, 1, "issue").thin).toBe(false);
  });

  it("flags a redeem quote more than 3% below the oracle value", () => {
    expect(legDepth(9_600_000n, ONE, 1, "redeem")).toMatchObject({ worseBps: 400, thin: true });
    expect(legDepth(9_800_000n, ONE, 1, "redeem").thin).toBe(false);
  });

  it("never flags a quote better than the oracle", () => {
    expect(legDepth(9_000_000n, ONE, 1, "issue")).toMatchObject({ worseBps: -1000, thin: false });
    expect(legDepth(11_000_000n, ONE, 1, "redeem")).toMatchObject({ worseBps: -1000, thin: false });
  });

  it("prices the amount at the leg's oracle price", () => {
    expect(legDepth(20_000_000n, 5n * ONE, 0.4, "issue")).toEqual({ fair: 20_000_000n, worseBps: 0, thin: false, unpriced: false });
    expect(legDepth(21_000_000n, 5n * ONE, 0.4, "issue")).toMatchObject({ worseBps: 500, thin: true });
  });

  it("flags a pool that quotes nothing", () => {
    expect(legDepth(0n, ONE, 1, "redeem").thin).toBe(true);
  });

  it("takes a custom tolerance", () => {
    expect(legDepth(10_200_000n, ONE, 1, "issue", 100).thin).toBe(true);
  });

  it("counts a leg it can't price as thin, and passes a zero amount", () => {
    expect(legDepth(50n * ONE, ONE, null, "issue")).toEqual({ fair: null, worseBps: null, thin: true, unpriced: true });
    expect(legDepth(50n * ONE, ONE, 0, "redeem")).toMatchObject({ thin: true, unpriced: true });
    expect(legDepth(50n * ONE, 0n, 1, "issue").thin).toBe(false);
  });
});

describe("slippage bounds", () => {
  it("allows 1% more USDC in, rounded up", () => {
    expect(maxIn(10_608_000n)).toBe(10_714_080n);
    expect(maxIn(101n)).toBe(103n);
  });

  it("accepts 1% less USDC out, rounded down", () => {
    expect(minOut(5_287_000n)).toBe(5_234_130n);
    expect(minOut(199n)).toBe(197n);
  });

  it("leaves zero at zero", () => {
    expect(maxIn(0n)).toBe(0n);
    expect(minOut(0n)).toBe(0n);
  });

  it("takes a custom tolerance", () => {
    expect(maxIn(10_000n, 200n)).toBe(10_200n);
    expect(minOut(10_000n, 200n)).toBe(9_800n);
  });
});

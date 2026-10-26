import { describe, expect, it } from "vitest";
import { candidatePairs, maxIn, minOut, pairKey, routeFromUsdc, zapPaths } from "./zap-math";

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

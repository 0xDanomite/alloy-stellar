import { describe, expect, it } from "vitest";
import { fillBids, minimumOut, sellable, XLM_KEEP } from "./cashout-math";
import { ONE } from "./format";

describe("cash-out math", () => {
  it("accepts at most 2% under the quote", () => {
    expect(minimumOut(100n * ONE)).toBe(98n * ONE);
    expect(minimumOut(0n)).toBe(0n);
  });

  it("sells what the redemption paid, capped at the wallet balance", () => {
    expect(sellable(5n * ONE, 10n * ONE, false)).toBe(5n * ONE);
    expect(sellable(5n * ONE, 2n * ONE, false)).toBe(2n * ONE);
  });

  it("fills the best bids first and refuses a thin book", () => {
    const bids = [
      { price: "0.2", amount: "1" },
      { price: "0.1", amount: "100" },
    ];
    // First bid fills at most min(1, 1 / 0.2) = 1 unit at 0.2, the rest at 0.1.
    expect(fillBids(bids, 3n * ONE)).toBe(BigInt(Math.floor((0.2 + 2 * 0.1) * Number(ONE))));
    expect(fillBids(bids, 1000n * ONE)).toBeNull();
    expect(fillBids([], ONE)).toBeNull();
  });

  it("keeps a lumen buffer for the reserve and fees", () => {
    expect(sellable(10n * ONE, 10n * ONE, true)).toBe(10n * ONE - XLM_KEEP);
    expect(sellable(10n * ONE, XLM_KEEP, true)).toBe(0n);
    expect(sellable(1n * ONE, 50n * ONE, true)).toBe(1n * ONE);
  });
});

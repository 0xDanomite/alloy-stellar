import { describe, expect, it } from "vitest";
import { formatAge, formatAmount, shortId, toDecimalString, toUnits, unitsToNumber } from "./format";

describe("toUnits", () => {
  it("parses decimals into 7-decimal base units", () => {
    expect(toUnits("1")).toBe(10_000_000n);
    expect(toUnits("0.25")).toBe(2_500_000n);
    expect(toUnits(".5")).toBe(5_000_000n);
  });

  it("rejects input the contracts can't represent", () => {
    expect(toUnits("")).toBeNull();
    expect(toUnits(".")).toBeNull();
    expect(toUnits("-1")).toBeNull();
    expect(toUnits("1.00000001")).toBeNull();
    expect(toUnits("1e3")).toBeNull();
  });
});

describe("toDecimalString", () => {
  it("round-trips with toUnits and trims trailing zeros", () => {
    expect(toDecimalString(toUnits("12.3400") ?? 0n)).toBe("12.34");
    expect(toDecimalString(-5_000_000n)).toBe("-0.5");
  });
});

describe("formatAmount", () => {
  it("groups thousands and caps the fraction", () => {
    expect(formatAmount(12_345_678_900_000n)).toBe("1,234,567.89");
  });

  it("keeps dust visible instead of rounding it to zero", () => {
    expect(formatAmount(3n)).toBe("0.0000003");
  });
});

describe("helpers", () => {
  it("converts units to numbers", () => {
    expect(unitsToNumber(15_000_000n)).toBe(1.5);
  });

  it("shortens long ids only", () => {
    expect(shortId("CAIJVJBRUVJZFCN2TFCV6LTPZNMCJC62IP6ZDIFXFAMHUW5YMYYCC7UB")).toBe("CAIJ…C7UB");
    expect(shortId("short")).toBe("short");
  });

  it("describes oracle ages in plain words", () => {
    expect(formatAge(30)).toBe("just now");
    expect(formatAge(600)).toBe("10 min ago");
    expect(formatAge(7200)).toBe("2h ago");
    expect(formatAge(3 * 86400)).toBe("3d ago");
  });
});

import { describe, expect, it } from "vitest";
import type { Fund } from "./stellar";
import { displayText, imitatedFund, skeleton, withTrust, type OfficialFund } from "./trust";

const LQD: OfficialFund = { id: "CLQD", symbol: "aLQD", name: "Alloy Liquid Dollar" };
const TRSY: OfficialFund = { id: "CTRSY", symbol: "aTRSY", name: "Alloy Stellar Treasury" };
const OFFICIALS = [LQD, TRSY];

const fund = (id: string, symbol: string, name: string, overrides: Partial<Fund> = {}) =>
  ({
    id,
    symbol,
    name,
    manager: "GBADMANAGERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXWXYZ",
    metadata: {},
    official: false,
    imitates: null,
    ...overrides,
  }) as Fund;

describe("skeleton", () => {
  it("folds case, digits that read as letters, and look-alike scripts", () => {
    expect(skeleton("aLQD")).toBe(skeleton("ALQD"));
    expect(skeleton("T0KEN")).toBe(skeleton("TOKEN"));
    expect(skeleton("Dol1ar")).toBe(skeleton("Dollar"));
    expect(skeleton("DoIIar")).toBe(skeleton("Dollar"));
    expect(skeleton("аLQD")).toBe(skeleton("aLQD"));
    expect(skeleton("Аlloy")).toBe(skeleton("Alloy"));
    expect(skeleton("Mint")).toBe(skeleton("rnint"));
  });

  it("ignores spacing, punctuation, accents and invisible characters", () => {
    expect(skeleton("Alloy  Liquid-Dollar")).toBe(skeleton("alloyliquiddollar"));
    expect(skeleton("Allóy")).toBe(skeleton("Alloy"));
    expect(skeleton("aL​QD")).toBe(skeleton("aLQD"));
  });
});

describe("imitatedFund", () => {
  it("catches a symbol that matches an official one, with or without the a prefix", () => {
    for (const symbol of ["aLQD", "alqd", "ALQD", "LQD", "aLQD ", "a1QD", "aIQD", "аLQD"]) {
      expect(imitatedFund({ symbol, name: "Something else" }, OFFICIALS)).toBe(LQD);
    }
  });

  it("catches a name that contains an official name under folding", () => {
    expect(imitatedFund({ symbol: "aCASH", name: "Alloy Liquid Dollar" }, OFFICIALS)).toBe(LQD);
    expect(imitatedFund({ symbol: "aCASH", name: "ALLOY L1QUID D0LLAR (copy)" }, OFFICIALS)).toBe(LQD);
    expect(imitatedFund({ symbol: "aCASH", name: "Alloy Stellar Treasury 2" }, OFFICIALS)).toBe(TRSY);
  });

  it("leaves distinct funds alone", () => {
    expect(imitatedFund({ symbol: "aCASH", name: "Cash Plus" }, OFFICIALS)).toBeNull();
    expect(imitatedFund({ symbol: "aLQDX", name: "Liquid Yield" }, OFFICIALS)).toBeNull();
    expect(imitatedFund({ symbol: "aTRS", name: "Treasury Ladder" }, OFFICIALS)).toBeNull();
    expect(imitatedFund({ symbol: "a", name: "A" }, OFFICIALS)).toBeNull();
  });
});

describe("withTrust", () => {
  const official = fund("CLQD", "aLQD", "Alloy Liquid Dollar");
  const copycat = fund("CFAKE", "ALQD", "Liquid Dollar Fund");
  const honest = fund("CHONEST", "aCASH", "Cash Plus");
  const result = withTrust([official, copycat, honest], new Set(["CLQD"]));
  const byId = new Map(result.map((f) => [f.id, f]));

  it("marks only deployment-listed funds official", () => {
    expect(byId.get("CLQD")?.official).toBe(true);
    expect(byId.get("CFAKE")?.official).toBe(false);
    expect(byId.get("CHONEST")?.official).toBe(false);
  });

  it("flags the imitation and suffixes its symbol with the manager", () => {
    expect(byId.get("CFAKE")?.imitates).toBe("aLQD");
    expect(byId.get("CFAKE")?.symbol).toBe("ALQD · GBAD…WXYZ");
    expect(byId.get("CHONEST")?.imitates).toBeNull();
    expect(byId.get("CHONEST")?.symbol).toBe("aCASH");
    expect(byId.get("CLQD")?.symbol).toBe("aLQD");
  });

  it("never flags an official fund, even one that matches another", () => {
    const twins = withTrust([official, fund("CLQD2", "aLQD", "Alloy Liquid Dollar")], new Set(["CLQD", "CLQD2"]));
    expect(twins.every((f) => f.imitates === null)).toBe(true);
  });

  it("caps and cleans names, symbols and profile text", () => {
    const [long] = withTrust(
      [
        fund("CLONG", "aVERYLONGSYMBOL99", `Cash‮ ${"x".repeat(80)}`, {
          metadata: { description: "d".repeat(1000), strategy: "fine", website: `https://example.com/${"p".repeat(200)}` },
        }),
      ],
      new Set(),
    );
    expect([...(long?.name ?? "")].length).toBeLessThanOrEqual(48);
    expect(long?.name.includes("‮")).toBe(false);
    expect(long?.symbol).toBe("aVERYLONGSY…");
    expect([...(long?.metadata.description ?? "")].length).toBe(400);
    expect(long?.metadata.strategy).toBe("fine");
    expect(long?.metadata.website).toBeUndefined();
  });
});

describe("displayText", () => {
  it("keeps short text as is and collapses whitespace", () => {
    expect(displayText("  Cash \n Plus ", 48)).toBe("Cash Plus");
  });
});

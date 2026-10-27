import { describe, expect, it } from "vitest";
import type { Fund } from "./stellar";
import { displayText, hasUnusualCharacters, imitatedFund, skeleton, withTrust, type OfficialFund } from "./trust";

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
    unusualText: false,
    ...overrides,
  }) as Fund;

const cp = (...points: number[]) => String.fromCodePoint(...points);
const CYRILLIC_A = cp(0x430);
const CYRILLIC_O = cp(0x43e);
const CYRILLIC_E = cp(0x435);
const GREEK_OMICRON = cp(0x3bf);
const ZWJ = cp(0x200d);
const ZWSP = cp(0x200b);
const RLO = cp(0x202e);
/** "ＬＱＤ" in fullwidth letters. */
const FULLWIDTH_LQD = cp(0xff2c, 0xff31, 0xff24);

describe("skeleton", () => {
  it("folds case and the ASCII confusables", () => {
    expect(skeleton("aLQD")).toBe(skeleton("ALQD"));
    expect(skeleton("T0KEN")).toBe(skeleton("TOKEN"));
    expect(skeleton("Dol1ar")).toBe(skeleton("Dollar"));
    expect(skeleton("DoIIar")).toBe(skeleton("Dollar"));
    expect(skeleton("Mint")).toBe(skeleton("rnint"));
    expect(skeleton("Alloy  Liquid-Dollar")).toBe(skeleton("alloyliquiddollar"));
  });

  it("keeps characters outside ASCII instead of dropping or guessing them", () => {
    expect(skeleton(`${CYRILLIC_A}LQD`)).toBe(`${CYRILLIC_A}lqd`);
    expect(skeleton(`D${CYRILLIC_O}llar`)).not.toBe(skeleton("Dollar"));
    expect(skeleton(`D${GREEK_OMICRON}llar`)).not.toBe(skeleton("Dollar"));
    expect(skeleton(`St${CYRILLIC_E}llar`)).not.toBe(skeleton("Stellar"));
  });
});

describe("hasUnusualCharacters", () => {
  it("accepts printable ASCII", () => {
    expect(hasUnusualCharacters("Alloy Cash Plus (copy) - 2026 & co.")).toBe(false);
    expect(hasUnusualCharacters("aLQD")).toBe(false);
  });

  it("flags other scripts, fullwidth letters and invisible joiners", () => {
    for (const value of [
      `${CYRILLIC_A}LQD`,
      `D${CYRILLIC_O}llar`,
      `St${CYRILLIC_E}llar`,
      `D${GREEK_OMICRON}llar`,
      FULLWIDTH_LQD,
      `aL${ZWJ}QD`,
      `aL${ZWSP}QD`,
      "Allóy",
    ]) {
      expect(hasUnusualCharacters(value)).toBe(true);
    }
  });
});

describe("imitatedFund", () => {
  it("catches a symbol that matches an official one, with or without the a prefix", () => {
    for (const symbol of ["aLQD", "alqd", "ALQD", "LQD", "aLQD ", "a1QD", "aIQD", FULLWIDTH_LQD]) {
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

  it("flags a community fund with look-alike characters and suffixes its symbol, whether or not it matches", () => {
    const [cyrillic, fullwidth, joined] = withTrust(
      [
        fund("C1", `${CYRILLIC_A}LQD`, "Liquid Dollar"),
        fund("C2", FULLWIDTH_LQD, "Liquid"),
        fund("C3", "aCASH", `Cash${ZWJ} Plus`),
      ],
      new Set(),
    );
    expect(cyrillic?.unusualText).toBe(true);
    expect(cyrillic?.symbol).toBe(`${CYRILLIC_A}LQD · GBAD…WXYZ`);
    expect(fullwidth?.unusualText).toBe(true);
    expect(joined?.unusualText).toBe(true);
    expect(joined?.name).toBe("Cash Plus");
  });

  it("does not flag official funds for their characters", () => {
    const [official] = withTrust([fund("CLQD", "aLQD", "Allóy Liquid Dollar")], new Set(["CLQD"]));
    expect(official?.unusualText).toBe(false);
  });

  it("never flags an official fund, even one that matches another", () => {
    const twins = withTrust([official, fund("CLQD2", "aLQD", "Alloy Liquid Dollar")], new Set(["CLQD", "CLQD2"]));
    expect(twins.every((f) => f.imitates === null)).toBe(true);
  });

  it("caps and cleans names, symbols and profile text", () => {
    const [long] = withTrust(
      [
        fund("CLONG", "aVERYLONGSYMBOL99", `Cash${RLO} ${"x".repeat(80)}`, {
          metadata: { description: "d".repeat(1000), strategy: "fine", website: `https://example.com/${"p".repeat(200)}` },
        }),
      ],
      new Set(),
    );
    expect([...(long?.name ?? "")].length).toBeLessThanOrEqual(48);
    expect(long?.name.includes(RLO)).toBe(false);
    expect(long?.symbol.startsWith("aVERYLONGSY… · ")).toBe(true);
    expect(long?.unusualText).toBe(true);
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

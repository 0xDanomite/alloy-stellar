import { describe, expect, it } from "vitest";
import { buildPortfolio, type AddressState } from "./portfolio-model";
import type { Fund, FundComponent } from "./stellar";

const ME = "GME";
const SHARE = 10_000_000n;

const leg = (code: string): FundComponent => ({ token: `C${code}`, code }) as FundComponent;

function fund(id: string, overrides: Partial<Fund> = {}): Fund {
  return {
    id,
    name: id,
    symbol: `a${id}`,
    compliance: "Open",
    totalSupply: 10n * SHARE,
    components: [leg("USDC"), leg("XLM")],
    valuePerShare: 2,
    navPerShare: null,
    navTotal: null,
    hasOracle: false,
    awaitingIssuer: [],
    manager: "GOTHER",
    wasmHash: null,
    platform: "CPLATFORM",
    navContract: null,
    setup: null,
    metadata: {},
    hidden: false,
    official: false,
    imitates: null,
    unusualText: false,
    ...overrides,
  };
}

function state(entries: { shares?: Record<string, bigint>; allowlisted?: string[]; owed?: Record<string, bigint> }): AddressState {
  return {
    shares: (id) => entries.shares?.[id] ?? 0n,
    onAllowlist: (id) => entries.allowlisted?.includes(id) ?? false,
    owed: (id, token) => entries.owed?.[`${id}:${token}`] ?? 0n,
  };
}

describe("buildPortfolio", () => {
  it("values held shares at NAV when there is one, else the market value", () => {
    const funds = [fund("A", { navPerShare: 3 }), fund("B"), fund("C")];
    const p = buildPortfolio(ME, funds, state({ shares: { A: 2n * SHARE, B: SHARE / 2n } }));
    expect(p.positions.map((x) => [x.fund.id, x.valueUsd])).toEqual([
      ["A", 6],
      ["B", 1],
    ]);
    expect(p.totalUsd).toBe(7);
    expect(p.unpriced).toBe(0);
  });

  it("counts unpriced holdings without adding them to the total", () => {
    const p = buildPortfolio(ME, [fund("A", { valuePerShare: null })], state({ shares: { A: SHARE } }));
    expect(p.positions[0]?.valueUsd).toBeNull();
    expect(p.totalUsd).toBe(0);
    expect(p.unpriced).toBe(1);
  });

  it("keeps a fund with only an owed claim and asks for a withdrawal", () => {
    const p = buildPortfolio(ME, [fund("A")], state({ owed: { "A:CXLM": 5n } }));
    expect(p.positions[0]?.shares).toBe(0n);
    expect(p.positions[0]?.owed.map((o) => [o.component.code, o.amount])).toEqual([["XLM", 5n]]);
    expect(p.attention.map((a) => [a.kind, a.tab])).toEqual([["owed", "redeem"]]);
  });

  it("lists managed funds and flags them while an issuer hasn't authorized the fund", () => {
    const waiting = fund("A", { manager: ME, awaitingIssuer: [leg("BENJI")] });
    const p = buildPortfolio(ME, [waiting, fund("B")], state({}));
    expect(p.managed.map((f) => f.id)).toEqual(["A"]);
    expect(p.positions).toEqual([]);
    expect(p.attention.map((a) => a.kind)).toEqual(["issuer"]);
  });

  it("ignores issuer waits on funds the address neither holds nor manages", () => {
    const p = buildPortfolio(ME, [fund("A", { awaitingIssuer: [leg("BENJI")] })], state({}));
    expect(p.attention).toEqual([]);
  });

  it("flags shares in an allowlist fund the address is not approved for", () => {
    const funds = [fund("A", { compliance: "Allowlist" }), fund("B", { compliance: "Allowlist" })];
    const p = buildPortfolio(ME, funds, state({ shares: { A: SHARE, B: SHARE }, allowlisted: ["B"] }));
    expect(p.positions.find((x) => x.fund.id === "A")?.onAllowlist).toBe(false);
    expect(p.positions.find((x) => x.fund.id === "B")?.onAllowlist).toBe(true);
    expect(p.attention.map((a) => [a.kind, a.fund.id])).toEqual([["allowlist", "A"]]);
  });

  it("asks the manager to finish setting up a v0.4 fund that isn't open", () => {
    const setup = { open: false, mandate: null, fee: null, platformFee: null, feeRecipient: ME, lastRebalance: null };
    const funds = [fund("A", { manager: ME, setup }), fund("B", { manager: ME, setup: { ...setup, open: true } }), fund("C", { setup })];
    const p = buildPortfolio(ME, funds, state({}));
    expect(p.attention.map((a) => [a.kind, a.fund.id, a.tab])).toEqual([["setup", "A", "manage"]]);
  });

  it("is empty for an address with nothing on the platform", () => {
    const p = buildPortfolio(ME, [fund("A"), fund("B")], state({}));
    expect(p).toMatchObject({ positions: [], managed: [], attention: [], totalUsd: 0, unpriced: 0 });
  });
});

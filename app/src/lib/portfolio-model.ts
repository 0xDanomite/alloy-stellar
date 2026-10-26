import { unitsToNumber } from "./format";
import type { Fund, FundComponent } from "./stellar";

export interface Owed {
  component: FundComponent;
  amount: bigint;
}

export interface FundPosition {
  fund: Fund;
  shares: bigint;
  /** Shares at the fund's headline value, or null when the fund is unpriced. */
  valueUsd: number | null;
  owed: Owed[];
  /** Null for open funds, which have no allowlist. */
  onAllowlist: boolean | null;
}

export type AttentionKind = "owed" | "issuer" | "allowlist";

export interface Attention {
  kind: AttentionKind;
  fund: Fund;
  title: string;
  detail: string;
  /** Where on the fund page the fix lives. */
  tab: "redeem" | null;
}

export interface Portfolio {
  address: string;
  positions: FundPosition[];
  managed: Fund[];
  attention: Attention[];
  totalUsd: number;
  unpriced: number;
}


function attentionFor(position: FundPosition | undefined, fund: Fund, manages: boolean): Attention[] {
  const items: Attention[] = [];
  for (const o of position?.owed ?? []) {
    items.push({
      kind: "owed",
      fund,
      title: `Withdraw ${o.component.code} owed to you`,
      detail: `${fund.symbol} is holding ${o.component.code} for you from an earlier redemption. Withdraw it once your account can receive it.`,
      tab: "redeem",
    });
  }
  if (fund.awaitingIssuer.length && (manages || position)) {
    const codes = fund.awaitingIssuer.map((l) => l.code).join(", ");
    items.push({
      kind: "issuer",
      fund,
      title: `${fund.symbol} is waiting on issuer authorization`,
      detail: manages
        ? `Issuing stays closed until the ${codes} issuer authorizes the fund's address. Send them the fund contract ID.`
        : `Issuing stays closed until the ${codes} issuer authorizes the fund. Redemption is open.`,
      tab: null,
    });
  }
  if (position && position.shares > 0n && position.onAllowlist === false) {
    items.push({
      kind: "allowlist",
      fund,
      title: `Not on ${fund.symbol}'s allowlist`,
      detail: "You hold shares but the manager hasn't approved your address, so you can redeem but not add more.",
      tab: null,
    });
  }
  return items;
}

/** What the ledger holds for one address in one fund. */
export interface AddressState {
  shares: (fundId: string) => bigint;
  onAllowlist: (fundId: string) => boolean;
  owed: (fundId: string, token: string) => bigint;
}

/** Positions, managed funds, attention items and totals for `address`, from fund state and its ledger entries. */
export function buildPortfolio(address: string, funds: readonly Fund[], state: AddressState): Portfolio {
  const positions: FundPosition[] = [];
  for (const fund of funds) {
    const shares = state.shares(fund.id);
    const owed = fund.components
      .map((component) => ({ component, amount: state.owed(fund.id, component.token) }))
      .filter((o) => o.amount > 0n);
    if (shares === 0n && owed.length === 0) continue;
    const perShare = fund.navPerShare ?? fund.valuePerShare;
    positions.push({
      fund,
      shares,
      valueUsd: perShare === null ? null : perShare * unitsToNumber(shares),
      owed,
      onAllowlist: fund.compliance === "Allowlist" ? state.onAllowlist(fund.id) : null,
    });
  }
  positions.sort((a, b) => (b.valueUsd ?? -1) - (a.valueUsd ?? -1));

  const managed = funds.filter((f) => f.manager === address);
  const byFund = new Map(positions.map((p) => [p.fund.id, p]));
  const attention = funds.flatMap((fund) => attentionFor(byFund.get(fund.id), fund, fund.manager === address));
  const priced = positions.filter((p) => p.shares > 0n);

  return {
    address,
    positions,
    managed,
    attention,
    totalUsd: priced.reduce((sum, p) => sum + (p.valueUsd ?? 0), 0),
    unpriced: priced.filter((p) => p.valueUsd === null).length,
  };
}

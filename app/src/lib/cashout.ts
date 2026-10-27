import { Asset, BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { endpoints } from "./config";
import { fillBids, minimumOut, sellable } from "./cashout-math";
import { toDecimalString } from "./format";
import {
  accountBalances,
  holdingFor,
  horizon,
  isMainnet,
  pathIsAllowed,
  QUOTE_USDC,
  toBaseUnits,
  TX_TIMEOUT_SECONDS,
  type FundComponent,
} from "./stellar";

export interface CashOutLeg {
  code: string;
  amount: bigint;
  /** USDC the DEX pays right now. */
  expected: bigint | null;
  /** The least USDC accepted: the quote less 2%. */
  minimum: bigint | null;
  route: string;
  blocked: string | null;
}

export interface CashOutPlan {
  legs: CashOutLeg[];
  totalExpected: bigint;
  totalMinimum: bigint;
  addsTrustline: boolean;
  /** Unsigned XDR, or null when nothing can be sold. */
  xdr: string | null;
}

/**
 * Sells what a redemption paid out for Circle USDC on the Stellar DEX: one
 * strict-send path payment per leg in a single classic transaction, each
 * accepting at most 2% less than quoted, through XLM and USDC hops only, as
 * buying does. Amounts are capped at what the wallet holds now.
 */
export async function planCashOut(address: string, received: { leg: FundComponent; amount: bigint }[]): Promise<CashOutPlan> {
  const usdc = QUOTE_USDC;
  if (!usdc) throw new Error("There's no USDC market on this network.");
  const balances = await accountBalances(address);
  if (!balances) throw new Error("This account doesn't exist on the network yet.");
  const usdcLine = balances.find(
    (b) => (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") && b.asset_code === usdc.getCode() && b.asset_issuer === usdc.getIssuer(),
  );

  const legs: (CashOutLeg & { asset: Asset; path: Asset[] })[] = [];
  for (const { leg, amount } of received) {
    if (amount <= 0n || (leg.isSac && leg.asset.equals(usdc))) continue;
    if (!leg.isSac) {
      legs.push({ code: leg.code, amount, asset: leg.asset, path: [], expected: null, minimum: null, route: "", blocked: `${leg.code} here is not a Stellar asset contract, so it can't be sold on the DEX.` });
      continue;
    }
    const held = holdingFor(balances, leg).balance;
    const selling = sellable(amount, held, leg.asset.isNative());
    const base = { code: leg.code, amount: selling, asset: leg.asset, path: [] as Asset[], expected: null, minimum: null, route: "" };
    if (selling === 0n) {
      legs.push({ ...base, blocked: `None of the ${leg.code} is in your wallet to sell.` });
      continue;
    }
    const quote = await quoteSell(leg.asset, selling).catch(() => null);
    if (!quote) {
      legs.push({ ...base, blocked: `There's no market for ${leg.code} on ${isMainnet ? "the Stellar DEX" : "testnet"} right now. It stays in your wallet.` });
      continue;
    }
    legs.push({ ...base, ...quote, minimum: minimumOut(quote.expected), blocked: null });
  }

  const sellableLegs = legs.filter((l) => !l.blocked && l.expected !== null);
  let xdr: string | null = null;
  if (sellableLegs.length) {
    const account = await horizon.loadAccount(address);
    const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: endpoints.passphrase });
    if (!usdcLine) builder.addOperation(Operation.changeTrust({ asset: usdc }));
    for (const l of sellableLegs) {
      builder.addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset: l.asset,
          sendAmount: toDecimalString(l.amount),
          destination: address,
          destAsset: usdc,
          destMin: toDecimalString(l.minimum ?? 0n),
          path: l.path,
        }),
      );
    }
    xdr = builder.setTimeout(TX_TIMEOUT_SECONDS).build().toXDR();
  }
  return {
    legs: legs.map(({ asset: _asset, path: _path, ...rest }) => rest),
    totalExpected: sellableLegs.reduce((s, l) => s + (l.expected ?? 0n), 0n),
    totalMinimum: sellableLegs.reduce((s, l) => s + (l.minimum ?? 0n), 0n),
    addsTrustline: !usdcLine && sellableLegs.length > 0,
    xdr,
  };
}

async function quoteSell(asset: Asset, amount: bigint): Promise<{ expected: bigint; path: Asset[]; route: string } | null> {
  const usdc = QUOTE_USDC;
  if (!usdc) return null;
  const { records } = await horizon.strictSendPaths(asset, toDecimalString(amount), [usdc]).call();
  const best = records
    .filter((r) => pathIsAllowed(r.path))
    .sort((a, b) => Number(b.destination_amount) - Number(a.destination_amount))[0];
  const code = asset.isNative() ? "XLM" : asset.getCode();
  if (!best) {
    // Horizon returns only its top few paths; for small amounts those can all
    // run through hops we don't allow, so price the direct book ourselves.
    const book = await horizon.orderbook(asset, usdc).limit(50).call();
    const direct = fillBids(book.bids, amount);
    return direct === null ? null : { expected: direct, path: [], route: `${code} → ${usdc.getCode()}` };
  }
  const path = best.path.map((hop) => (hop.asset_type === "native" ? Asset.native() : new Asset(hop.asset_code ?? "", hop.asset_issuer ?? "")));
  return {
    expected: toBaseUnits(best.destination_amount),
    path,
    route: [code, ...path.map((p) => (p.isNative() ? "XLM" : p.getCode())), usdc.getCode()].join(" → "),
  };
}

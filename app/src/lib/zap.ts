import { Asset, BASE_FEE, Operation, TransactionBuilder, contract, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { endpoints, platformSlot, SOROSWAP_ROUTER } from "./config";
import { candidatePairs, maxIn, minOut, pairKey, routeFromUsdc, zapPaths, type LegRoute } from "./zap-math";
import {
  ChainError,
  QUOTE_USDC,
  TX_TIMEOUT_SECONDS,
  accountBalances,
  clientOptions,
  explain,
  horizon,
  quoteIssue,
  quoteRedeem,
  read,
  sendForResult,
  submitClassic,
  toBaseUnits,
  zapClient,
  type Fund,
} from "./stellar";

export { maxIn, minOut, ZAP_SLIPPAGE_BPS } from "./zap-math";

export interface ZapRoute extends LegRoute {
  code: string;
}

export interface ZapPlan {
  zap: string;
  usdc: string;
  /** One entry per component, in component order. */
  routes: ZapRoute[];
  /** Why this fund can't use the zap, in plain words; null when it can. */
  blocked: string | null;
}

const toAmounts = (value: xdr.ScVal): bigint[] => {
  const native: unknown = scValToNative(value);
  return Array.isArray(native) ? native.map((n) => BigInt(String(n))) : [];
};

/** Simulates a read-only call on a contract whose interface we don't ship. */
function view<T>(contractId: string, method: string, args: xdr.ScVal[], parse: (value: xdr.ScVal) => T): Promise<T> {
  return read(contract.AssembledTransaction.build<T>({ ...clientOptions(contractId), method, args, parseResultXdr: parse }));
}

const addressArg = (id: string) => nativeToScVal(id, { type: "address" });
const pathArg = (path: string[]) => xdr.ScVal.scvVec(path.map(addressArg));
const amountArg = (amount: bigint) => nativeToScVal(amount, { type: "i128" });

let factoryPending: Promise<string> | null = null;

function soroswapFactory(router: string): Promise<string> {
  if (!factoryPending) {
    factoryPending = view(router, "get_factory", [], (v) => String(scValToNative(v)));
    factoryPending.catch(() => {
      factoryPending = null;
    });
  }
  return factoryPending;
}

const pairCache = new Map<string, Promise<boolean>>();

function pairExists(factory: string, a: string, b: string): Promise<boolean> {
  const key = pairKey(a, b);
  let pending = pairCache.get(key);
  if (!pending) {
    pending = view(factory, "pair_exists", [addressArg(a), addressArg(b)], (v) => scValToNative(v) === true);
    pending.catch(() => pairCache.delete(key));
    pairCache.set(key, pending);
  }
  return pending;
}

function joinCodes(codes: string[]): string {
  return codes.length <= 1 ? (codes[0] ?? "") : `${codes.slice(0, -1).join(", ")} and ${codes[codes.length - 1]}`;
}

async function loadPlan(fund: Fund, zap: string, router: string, usdcAsset: Asset): Promise<ZapPlan> {
  const usdc = usdcAsset.contractId(endpoints.passphrase);
  const xlm = Asset.native().contractId(endpoints.passphrase);
  const tokens = fund.components.map((leg) => leg.token);
  const factory = await soroswapFactory(router);
  const checks = await Promise.all(
    candidatePairs(tokens, usdc, xlm).map(async ([a, b]) => ((await pairExists(factory, a, b)) ? pairKey(a, b) : null)),
  );
  const pairs = new Set(checks.filter((k): k is string => k !== null));
  const routes = fund.components.map((leg) => ({
    token: leg.token,
    code: leg.code,
    path: leg.token === usdc ? null : routeFromUsdc(leg.token, usdc, xlm, pairs),
  }));

  const permissioned = fund.components.filter((leg) => leg.authRequired && leg.token !== usdc).map((leg) => leg.code);
  const unrouted = routes.filter((r) => r.token !== usdc && !r.path).map((r) => r.code);
  const blocked = permissioned.length
    ? `${joinCodes(permissioned)}'s issuer approves each holder, so it can't pass through the swap contract.`
    : unrouted.length
      ? `${joinCodes(unrouted)} ${unrouted.length === 1 ? "has" : "have"} no Soroswap pool.`
      : null;
  return { zap, usdc, routes, blocked };
}

const planCache = new Map<string, Promise<ZapPlan>>();

/**
 * How this fund trades through the USDC zap: a Soroswap route per leg,
 * direct from USDC or through XLM, or why it can't. Null when no zap
 * serves the fund's platform or the fund runs code from before v0.4.
 */
export function zapPlan(fund: Fund): Promise<ZapPlan | null> {
  const zap = platformSlot(fund.platform)?.zap ?? null;
  if (!zap || !SOROSWAP_ROUTER || !QUOTE_USDC || !fund.setup) return Promise.resolve(null);
  let pending = planCache.get(fund.id);
  if (!pending) {
    pending = loadPlan(fund, zap, SOROSWAP_ROUTER, QUOTE_USDC);
    pending.catch(() => planCache.delete(fund.id));
    planCache.set(fund.id, pending);
  }
  return pending;
}

/** A route in asset codes, such as "USDC → XLM → USDY", reversed for redeeming. */
export function routeLabel(plan: ZapPlan, route: ZapRoute, direction: "issue" | "redeem"): string {
  const codeOf = (token: string) => (token === plan.usdc ? "USDC" : (plan.routes.find((r) => r.token === token)?.code ?? "XLM"));
  const hops = (route.path ?? []).map(codeOf);
  return (direction === "issue" ? hops : hops.reverse()).join(" → ");
}

function pathsOrThrow(plan: ZapPlan, direction: "issue" | "redeem"): string[][] {
  const paths = plan.blocked ? null : zapPaths(plan.routes, plan.usdc, direction);
  if (!paths) throw new Error(plan.blocked ?? "This fund has no USDC route.");
  return paths;
}

function requireRouter(): string {
  if (!SOROSWAP_ROUTER) throw new Error("There's no Soroswap router on this network.");
  return SOROSWAP_ROUTER;
}

export interface IssueQuote {
  /** USDC the basket costs on Soroswap right now. */
  usdc: bigint;
  /** The most the transaction may spend: the quote plus 1%. */
  maxUsdc: bigint;
}

/**
 * Prices `shares` the way `issue_with_usdc` buys them: the fund's own
 * `quote_issue`, then `router_get_amounts_in` for each leg on its route.
 */
export async function quoteZapIssue(fund: Fund, plan: ZapPlan, shares: bigint): Promise<IssueQuote> {
  pathsOrThrow(plan, "issue");
  const router = requireRouter();
  const needs = await quoteIssue(fund, shares);
  const costs = await Promise.all(
    plan.routes.map(async (route, i) => {
      const need = needs[i] ?? 0n;
      if (need <= 0n) return 0n;
      if (!route.path) return need;
      const amounts = await view(router, "router_get_amounts_in", [amountArg(need), pathArg(route.path)], toAmounts);
      return amounts[0] ?? 0n;
    }),
  );
  const usdc = costs.reduce((sum, c) => sum + c, 0n);
  return { usdc, maxUsdc: maxIn(usdc) };
}

export interface RedeemQuote {
  usdc: bigint;
  /** The least the transaction may pay: the quote less 1%. */
  minUsdc: bigint;
  /** True when the quote is a simulation of the owner's own `redeem_to_usdc`, false for a router estimate. */
  simulated: boolean;
}

/**
 * Prices a redemption to USDC. With an owner who holds the shares, it
 * simulates their `redeem_to_usdc` exactly; otherwise it estimates from
 * `quote_redeem` and `router_get_amounts_out` per leg.
 */
export async function quoteZapRedeem(fund: Fund, plan: ZapPlan, shares: bigint, owner: string | null): Promise<RedeemQuote> {
  const paths = pathsOrThrow(plan, "redeem");
  if (owner) {
    const client = await zapClient(plan.zap, owner);
    const usdc = await read(client.redeem_to_usdc({ owner, fund: fund.id, shares, min_usdc: 0n, paths }));
    return { usdc, minUsdc: minOut(usdc), simulated: true };
  }
  const router = requireRouter();
  const amounts = await quoteRedeem(fund, shares);
  const outs = await Promise.all(
    plan.routes.map(async (route, i) => {
      const amount = amounts[i] ?? 0n;
      if (amount <= 0n) return 0n;
      if (!route.path) return amount;
      const out = await view(router, "router_get_amounts_out", [amountArg(amount), pathArg([...route.path].reverse())], toAmounts);
      return out[out.length - 1] ?? 0n;
    }),
  );
  const usdc = outs.reduce((sum, o) => sum + o, 0n);
  return { usdc, minUsdc: minOut(usdc), simulated: false };
}

/** One signature: USDC in, shares out. Returns the USDC actually spent. */
export async function zapIssue(fund: Fund, plan: ZapPlan, address: string, shares: bigint, maxUsdc: bigint) {
  const paths = pathsOrThrow(plan, "issue");
  const client = await zapClient(plan.zap, address);
  return sendForResult(client.issue_with_usdc({ investor: address, fund: fund.id, shares, max_usdc: maxUsdc, paths }));
}

/** One signature: shares in, USDC out. Returns the USDC actually paid. */
export async function zapRedeem(fund: Fund, plan: ZapPlan, address: string, shares: bigint, minUsdc: bigint) {
  const paths = pathsOrThrow(plan, "redeem");
  const client = await zapClient(plan.zap, address);
  return sendForResult(client.redeem_to_usdc({ owner: address, fund: fund.id, shares, min_usdc: minUsdc, paths }));
}

export interface UsdcWallet {
  exists: boolean;
  hasTrustline: boolean;
  balance: bigint;
}

export async function usdcWallet(address: string): Promise<UsdcWallet> {
  const usdc = QUOTE_USDC;
  const balances = await accountBalances(address);
  if (!balances) return { exists: false, hasTrustline: false, balance: 0n };
  const line = usdc
    ? balances.find(
        (b) =>
          (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
          b.asset_code === usdc.getCode() &&
          b.asset_issuer === usdc.getIssuer(),
      )
    : undefined;
  if (!line) return { exists: true, hasTrustline: false, balance: 0n };
  return { exists: true, hasTrustline: true, balance: toBaseUnits(line.balance) };
}

/** Adds the USDC trustline in one classic transaction. Returns its hash. */
export async function addUsdcTrustline(address: string): Promise<string> {
  if (!QUOTE_USDC) throw new Error("There's no USDC on this network.");
  const account = await horizon.loadAccount(address);
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: endpoints.passphrase })
    .addOperation(Operation.changeTrust({ asset: QUOTE_USDC }))
    .setTimeout(TX_TIMEOUT_SECONDS)
    .build();
  return submitClassic(tx.toXDR(), address);
}

const ZAP_ERRORS: Record<number, string> = {
  1: "One of the swap routes doesn't fit this fund. Reload the page and try again.",
  2: "Prices moved more than 1% since the quote. Quote again and retry.",
  3: "Enter an amount above zero.",
  4: "One of the swap routes doesn't fit this fund. Reload the page and try again.",
};

/**
 * The zap's error codes overlap the fund's, but the fund can't raise 1 to 4
 * from `issue` or `redeem`, so those always come from the zap.
 */
export function explainZap(error: unknown): string {
  if (error instanceof ChainError) {
    const code = /Error\(Contract, #(\d+)\)/.exec(error.raw)?.[1];
    const message = code ? ZAP_ERRORS[Number(code)] : undefined;
    if (message) return message;
  }
  return explain(error);
}

import { Account, Address, BASE_FEE, Contract, nativeToScVal, Operation, rpc, scValToNative, Transaction, TransactionBuilder, type xdr } from "@stellar/stellar-sdk";
import { deployments, endpoints } from "./config";
import { credentialsAddress, encodeHandover, HANDOVER_LEDGERS, verifyHandover, type HandoverLink } from "./handover";
import { STATUS_KEY, type FundStatus } from "./visibility";
import {
  ChainError,
  fundClient,
  invalidateFunds,
  read,
  send,
  signAuthEntryWithWallet,
  type Fund,
  type FundMetadata,
  type Mandate,
  type TxResult,
} from "./stellar";

const server = new rpc.Server(endpoints.rpcUrl);
/** The all-zero account the SDK simulates read calls from; no account needs to exist. */
const NULL_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

async function simulateCall(contractId: string, method: string, args: xdr.ScVal[]): Promise<xdr.ScVal> {
  const tx = new TransactionBuilder(new Account(NULL_ACCOUNT, "0"), { fee: BASE_FEE, networkPassphrase: endpoints.passphrase })
    .addOperation(new Contract(contractId).call(method, ...args))
    .setTimeout(30)
    .build();
  const simulation = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) throw new ChainError(simulation.error);
  if (!simulation.result) throw new Error(`${method} returned nothing`);
  return simulation.result.retval;
}

async function fundCall(fund: Fund, address: string, call: (c: Awaited<ReturnType<typeof fundClient>>) => ReturnType<typeof send>) {
  const result = await call(await fundClient(fund.id, address));
  invalidateFunds();
  return result;
}

/** What a manager settles before anyone can buy in. */
export interface SetupPlan {
  metadata: FundMetadata;
  feeBps: number;
  mandate: Mandate;
}

export interface SetupStep {
  id: string;
  label: string;
  done: boolean;
  run: (address: string) => Promise<TxResult>;
}

const METADATA_LABELS: Record<keyof FundMetadata, string> = {
  description: "Save the description",
  strategy: "Save the strategy",
  website: "Save the website",
};

/**
 * The v0.4 setup calls a fund still needs, in the order they must land:
 * profile, fee, mandate, then opening, which freezes the fee and mandate.
 * Soroban runs one contract call per transaction, so each is its own
 * signature. A 0% fee and a Locked mandate are the contract's defaults and
 * need no call.
 */
export function setupSteps(fund: Fund, plan: SetupPlan): SetupStep[] {
  const setup = fund.setup;
  if (!setup) return [];
  const steps: SetupStep[] = [];
  for (const key of ["description", "strategy", "website"] as const) {
    const wanted = plan.metadata[key]?.trim() ?? "";
    if (!wanted && !fund.metadata[key]) continue;
    steps.push({
      id: `metadata:${key}`,
      label: wanted ? METADATA_LABELS[key] : `Clear the ${key}`,
      done: (fund.metadata[key] ?? "") === wanted,
      run: (address) => fundCall(fund, address, (c) => send(c.set_metadata({ key, value: wanted }))),
    });
  }
  if (plan.feeBps > 0 || setup.fee) {
    steps.push({
      id: "fee",
      label: "Set the fee",
      done: setup.fee !== null,
      run: (address) => fundCall(fund, address, (c) => send(c.init_fee({ rate_bps: plan.feeBps }))),
    });
  }
  if (plan.mandate !== "Locked" || setup.mandate) {
    steps.push({
      id: "mandate",
      label: "Commit to the mandate",
      done: setup.mandate !== null,
      run: (address) => fundCall(fund, address, (c) => send(c.set_mandate({ mandate: { tag: plan.mandate } }))),
    });
  }
  steps.push({
    id: "open",
    label: "Open for investment",
    done: setup.open,
    run: (address) => fundCall(fund, address, (c) => send(c.open_for_issue())),
  });
  return steps;
}

/** How many setup transactions a fresh fund needs for this plan. */
export function setupCallCount(plan: SetupPlan): number {
  const profile = (["description", "strategy", "website"] as const).filter((k) => plan.metadata[k]?.trim()).length;
  return profile + (plan.feeBps > 0 ? 1 : 0) + (plan.mandate !== "Locked" ? 1 : 0) + 1;
}

const draftKey = (fundId: string) => `alloy.setup.${fundId}`;

/** Remembers what the creator chose so setup can resume after a closed tab. */
export function saveSetupDraft(fundId: string, plan: SetupPlan) {
  try {
    localStorage.setItem(draftKey(fundId), JSON.stringify(plan));
  } catch {
    // Without storage, the manage tab asks for the choices again.
  }
}

export function loadSetupDraft(fundId: string): SetupPlan | null {
  try {
    const raw = localStorage.getItem(draftKey(fundId));
    if (!raw) return null;
    const plan: unknown = JSON.parse(raw);
    if (typeof plan !== "object" || plan === null) return null;
    const feeBps = Reflect.get(plan, "feeBps");
    const mandate = Reflect.get(plan, "mandate");
    const metadata = Reflect.get(plan, "metadata");
    if (typeof feeBps !== "number" || !["Locked", "Managed", "Static"].includes(String(mandate))) return null;
    return { feeBps, mandate: mandate as Mandate, metadata: typeof metadata === "object" && metadata !== null ? (metadata as FundMetadata) : {} };
  } catch {
    return null;
  }
}

export function clearSetupDraft(fundId: string) {
  try {
    localStorage.removeItem(draftKey(fundId));
  } catch {
    // Nothing to clear.
  }
}

/** Funds this browser started creating, newest first, for the resume prompt. */
export function draftFundIds(): string[] {
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith("alloy.setup."))
      .map((k) => k.slice("alloy.setup.".length));
  } catch {
    return [];
  }
}

export const setMetadata = (fund: Fund, address: string, key: keyof FundMetadata, value: string) =>
  fundCall(fund, address, (c) => send(c.set_metadata({ key, value })));

/** Hides the fund from public lists or lists it again. The fund keeps working either way. */
export const setFundStatus = (fund: Fund, address: string, status: FundStatus) =>
  fundCall(fund, address, (c) => send(c.set_metadata({ key: STATUS_KEY, value: status })));

export const openForIssue = (fund: Fund, address: string) => fundCall(fund, address, (c) => send(c.open_for_issue()));

export const accrueFee = (fund: Fund, address: string) => fundCall(fund, address, (c) => send(c.accrue_fee()));

export const claimFee = (fund: Fund, address: string, recipient: string) =>
  fundCall(fund, address, (c) => send(c.claim_fee({ recipient })));

export interface Earnings {
  pendingShares: bigint;
  /** Fee shares held for the manager's recipient because it can't hold shares yet. */
  escrow: bigint;
  platformEscrow: bigint;
}

export async function loadEarnings(fund: Fund): Promise<Earnings> {
  const c = await fundClient(fund.id);
  const recipient = fund.setup?.feeRecipient ?? fund.manager;
  const platformRecipient = fund.setup?.platformFee?.recipient;
  const [pendingShares, escrow, platformEscrow] = await Promise.all([
    read(c.pending_fee()),
    read(c.fee_escrow({ recipient })),
    platformRecipient ? read(c.fee_escrow({ recipient: platformRecipient })) : Promise.resolve(0n),
  ]);
  return { pendingShares, escrow, platformEscrow };
}

export interface TradeState {
  windowLossPpb: bigint;
  /** The router `trade` swaps through, including a compiled-in default; null when none. */
  router: string | null;
}

export async function loadTradeState(fund: Fund): Promise<TradeState> {
  const c = await fundClient(fund.id);
  const [windowLossPpb, router] = await Promise.all([read(c.window_loss_ppb()), read(c.router())]);
  return { windowLossPpb, router: router ?? null };
}

export interface RouteQuote {
  path: string[];
  /** Codes along the path, for display. */
  hops: string[];
  out: bigint;
}

/** Assets a Soroswap route may pass through between two legs. */
function hopTokens(): { token: string; code: string }[] {
  const assets = deployments?.assets ?? {};
  return ["XLM", "USDC", "USTRY", "tUSDC"]
    .map((code) => ({ code, token: assets[code]?.contract }))
    .filter((h): h is { code: string; token: string } => typeof h.token === "string");
}

/**
 * The best Soroswap quote for selling `sold` of `sell` for `buy`: direct, or
 * through one of XLM, USDC or USTRY, each a `router_get_amounts_out`
 * simulation. Null when no route has liquidity.
 */
export async function quoteRoute(router: string, sell: { token: string; code: string }, buy: { token: string; code: string }, sold: bigint): Promise<RouteQuote | null> {
  const candidates: { token: string; code: string }[][] = [
    [sell, buy],
    ...hopTokens()
      .filter((h) => h.token !== sell.token && h.token !== buy.token)
      .map((h) => [sell, h, buy]),
  ];
  const quotes = await Promise.all(
    candidates.map(async (route) => {
      try {
        const retval = await simulateCall(router, "router_get_amounts_out", [
          nativeToScVal(sold, { type: "i128" }),
          nativeToScVal(route.map((r) => new Address(r.token))),
        ]);
        const amounts = scValToNative(retval) as bigint[];
        const out = amounts[amounts.length - 1];
        return typeof out === "bigint" && out > 0n ? { path: route.map((r) => r.token), hops: route.map((r) => r.code), out } : null;
      } catch {
        return null;
      }
    }),
  );
  return quotes.reduce<RouteQuote | null>((best, q) => (q && (!best || q.out > best.out) ? q : best), null);
}

/** Swaps inside the fund through its router; assets never pass through the manager. */
export const trade = (fund: Fund, address: string, sell: string, sold: bigint, buy: string, minBought: bigint, path: string[]) =>
  fundCall(fund, address, (c) => send(c.trade({ sell, sold, buy, min_bought: minBought, path })));

function authOf(tx: { built?: Transaction }): xdr.SorobanAuthorizationEntry[] {
  const op = tx.built?.operations[0];
  return op && op.type === "invokeHostFunction" ? (op.auth ?? []) : [];
}

/**
 * The outgoing manager's half of a handover. `set_manager` needs both
 * managers to authorize it; this builds the call with the incoming manager
 * as the transaction source, has the outgoing manager sign only their own
 * authorization in their wallet, and returns that entry encoded for a link.
 */
export async function prepareHandover(fund: Fund, outgoing: string, incoming: string): Promise<string> {
  const c = await fundClient(fund.id, incoming);
  const tx = await c.set_manager({ new_manager: incoming });
  const simulation = tx.simulation;
  if (simulation && rpc.Api.isSimulationError(simulation)) throw new ChainError(simulation.error);
  const latest = await server.getLatestLedger();
  await tx.signAuthEntries({ address: outgoing, signAuthEntry: signAuthEntryWithWallet, expiration: latest.sequence + HANDOVER_LEDGERS });
  const signed = authOf(tx).find((e) => credentialsAddress(e.credentials) === outgoing);
  if (!signed) throw new Error("The wallet didn't return a signed approval.");
  return encodeHandover(signed);
}

/**
 * The incoming manager's half. The transaction is rebuilt here from the
 * fund and the connected account; the link contributes only the outgoing
 * manager's signed entry, and only after `verifyHandover` confirms it
 * authorizes this exact call. Nothing else from the link is signed.
 */
export async function acceptHandover(fund: Fund, incoming: string, link: HandoverLink): Promise<TxResult> {
  const latest = await server.getLatestLedger();
  const verified = verifyHandover(link, { fund: fund.id, manager: fund.manager, incoming, latestLedger: latest.sequence });
  if ("error" in verified) throw new Error(verified.error);

  const c = await fundClient(fund.id, incoming);
  const tx = await c.set_manager({ new_manager: incoming });
  const simulation = tx.simulation;
  if (simulation && rpc.Api.isSimulationError(simulation)) throw new ChainError(simulation.error);
  const auth = authOf(tx);
  const slot = auth.findIndex((e) => credentialsAddress(e.credentials) === fund.manager);
  if (slot === -1 || auth.some((e, i) => i !== slot && e.credentials.type !== "sorobanCredentialsSourceAccount")) {
    throw new Error("This handover needs approvals the link doesn't carry.");
  }
  const account = await server.getAccount(incoming);
  tx.built = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: endpoints.passphrase })
    .addOperation(
      Operation.invokeContractFunction({
        contract: fund.id,
        function: "set_manager",
        args: [new Address(incoming).toScVal()],
        auth: auth.map((e, i) => (i === slot ? verified.entry : e)),
      }),
    )
    .setTimeout(180)
    .build();
  await tx.simulate();
  const result = await send(Promise.resolve(tx));
  invalidateFunds();
  return result;
}

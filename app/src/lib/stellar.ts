import {
  Asset,
  BASE_FEE,
  Horizon,
  Operation,
  TransactionBuilder,
  contract,
  rpc,
  type xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { Networks as KitNetworks } from "@creit.tech/stellar-wallets-kit/types";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import {
  WalletConnectModule,
  WalletConnectTargetChain,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";
import { creationCandidates, creationPlatform, deployments, endpoints, expert, isLegacyFundCode, network, platforms, platformSlot } from "./config";
import { addressVal, dataKey, instanceKey, instanceStorage, keyId, native, readEntries, variantKey } from "./ledger";
import { SPECS } from "./specs";
import { ONE, toDecimalString, unitsToNumber } from "./format";
import { CIRCLE_USDC_ISSUER, DEMO_ISSUER_LABEL, PINNED_MAINNET_ISSUERS, UNVERIFIED_ISSUER_LABEL } from "./issuers";

const CIRCLE_USDC = new Asset("USDC", CIRCLE_USDC_ISSUER);

/** The USD quote asset: Circle USDC on mainnet, the tUSDC stand-in on testnet. */
export const QUOTE_USDC: Asset | null = (() => {
  if (network === "mainnet") return CIRCLE_USDC;
  const stand = deployments?.assets.tUSDC?.asset;
  if (!stand) return null;
  const [code, issuer] = stand.split(":");
  return code && issuer ? new Asset(code, issuer) : null;
})();
export const SLIPPAGE_BPS = 200n;
export const TX_TIMEOUT_SECONDS = 180;

type AT<T> = Promise<contract.AssembledTransaction<T>>;
type Tagged<T extends string> = { tag: T };

export type ShelfStatus = "Unlisted" | "Open" | "Permissioned";
export type Compliance = "Open" | "Allowlist";
export type Mandate = "Locked" | "Managed" | "Static";

interface PlatformMethods {
  fund_count(): AT<number>;
  funds(args: { start: number; limit: number }): AT<string[]>;
  shelf_status(args: { token: string }): AT<Tagged<ShelfStatus>>;
  shelf(): AT<string[]>;
  is_manager(args: { manager: string }): AT<boolean>;
  admin(): AT<string>;
  create_fund(args: {
    manager: string;
    name: string;
    symbol: string;
    components: { token: string; initial_units: bigint }[];
    compliance: Tagged<Compliance>;
    salt: Buffer;
  }): AT<string>;
}

interface FundMethods {
  name(): AT<string>;
  symbol(): AT<string>;
  total_supply(): AT<bigint>;
  components(): AT<{ token: string; initial_units: bigint }[]>;
  holdings(): AT<bigint[]>;
  units_per_share(): AT<bigint[]>;
  compliance(): AT<Tagged<Compliance>>;
  quote_issue(args: { shares: bigint }): AT<bigint[]>;
  quote_redeem(args: { shares: bigint }): AT<bigint[]>;
  is_investor(args: { investor: string }): AT<boolean>;
  balance(args: { id: string }): AT<bigint>;
  owed(args: { owner: string; token: string }): AT<bigint>;
  issue(args: { investor: string; to: string; shares: bigint }): AT<bigint[]>;
  redeem(args: { from: string; to: string; shares: bigint; skip: string[] }): AT<bigint[]>;
  withdraw_owed(args: { owner: string; to: string; token: string }): AT<bigint>;
  set_compliance(args: { compliance: Tagged<Compliance> }): AT<null>;
  set_investor(args: { investor: string; allowed: boolean }): AT<null>;
  nav(): AT<string | undefined>;
  rebalance(args: { sell: string; sold: bigint; buy: string; bought: bigint }): AT<null>;
  set_manager(args: { new_manager: string }): AT<null>;
  // v0.4 and later
  is_open(): AT<boolean>;
  open_for_issue(): AT<null>;
  init_fee(args: { rate_bps: number }): AT<null>;
  accrue_fee(): AT<bigint>;
  pending_fee(): AT<bigint>;
  fee_escrow(args: { recipient: string }): AT<bigint>;
  claim_fee(args: { recipient: string }): AT<bigint>;
  set_mandate(args: { mandate: Tagged<Mandate> }): AT<null>;
  set_metadata(args: { key: string; value: string }): AT<null>;
  window_loss_ppb(): AT<bigint>;
  router(): AT<string | undefined>;
  trade(args: { sell: string; sold: bigint; buy: string; min_bought: bigint; path: string[] }): AT<bigint>;
}

interface NavQuoteRaw {
  price: bigint;
  timestamp: bigint;
  source: string;
  divergence_bps?: number | null;
}

interface NavLegRaw extends NavQuoteRaw {
  token: string;
  units_per_share: bigint;
  value_usd: bigint;
}

interface NavMethods {
  nav(args: { fund: string }): AT<contract.Result<{ per_share_usd: bigint; legs: NavLegRaw[]; total_usd: bigint }>>;
  price(args: { token: string }): AT<contract.Result<NavQuoteRaw>>;
  primary(args: { token: string }): AT<NavRouteRaw | undefined>;
  secondary(args: { token: string }): AT<NavRouteRaw | undefined>;
}

export interface NavRouteRaw {
  oracle: string;
  feed: { tag: "Sep40" | "RedStoneFeed"; values?: unknown[] };
  quote: Tagged<"Usd" | "Usdc">;
  max_age_secs: bigint;
  source: string;
}

interface TimelockMethods {
  schedule(args: { proposer: string; target: string; fn_name: string; args: xdr.ScVal[]; salt: Buffer }): AT<Buffer>;
  execute(args: { executor: string; target: string; fn_name: string; args: xdr.ScVal[]; salt: Buffer }): AT<unknown>;
  cancel(args: { proposer: string; id: Buffer }): AT<null>;
}

interface ZapMethods {
  issue_with_usdc(args: { investor: string; fund: string; shares: bigint; max_usdc: bigint; paths: string[][] }): AT<bigint>;
  redeem_to_usdc(args: { owner: string; fund: string; shares: bigint; min_usdc: bigint; paths: string[][] }): AT<bigint>;
}

interface SacMethods {
  name(): AT<string>;
  authorized(args: { id: string }): AT<boolean>;
}

export const horizon = new Horizon.Server(endpoints.horizonUrl);
export const isMainnet = network === "mainnet";


export function clientOptions(contractId: string, publicKey?: string): contract.ClientOptions {
  return {
    contractId,
    rpcUrl: endpoints.rpcUrl,
    networkPassphrase: endpoints.passphrase,
    publicKey,
    signTransaction: publicKey ? signWithWallet : undefined,
  };
}

/** Our contracts' interfaces ship with the app (see specs.ts), so building a client costs no request. */
function bundledClient<T>(entries: readonly string[]) {
  const spec = new contract.Spec([...entries]);
  return (contractId: string, publicKey?: string): Promise<contract.Client & T> =>
    Promise.resolve(new contract.Client(spec, clientOptions(contractId, publicKey)) as contract.Client & T);
}

/** Interfaces we do not ship (other issuers' asset contracts) are fetched once and cached. */
function fetchedClient<T>() {
  const cache = new Map<string, Promise<contract.Client & T>>();
  return (contractId: string): Promise<contract.Client & T> => {
    let pending = cache.get(contractId);
    if (!pending) {
      pending = contract.Client.from<T>(clientOptions(contractId));
      pending.catch(() => cache.delete(contractId));
      cache.set(contractId, pending);
    }
    return pending;
  };
}

/** Retries transient network failures (public RPCs drop requests under bursts); never chain errors. */
async function withRetry<T>(attempt: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (err instanceof ChainError || i >= tries) throw err;
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** i));
    }
  }
}

export async function read<T>(tx: AT<T>): Promise<T> {
  const assembled = await tx;
  const simulation = assembled.simulation;
  if (simulation && rpc.Api.isSimulationError(simulation)) {
    throw new ChainError(simulation.error);
  }
  return assembled.result;
}

export const platformClients = bundledClient<PlatformMethods>(SPECS.platform);
export const fundClient = bundledClient<FundMethods>(SPECS.fund);
const sacClient = fetchedClient<SacMethods>();
export const navClient = bundledClient<NavMethods>(SPECS.nav);
export const timelockClient = bundledClient<TimelockMethods>(SPECS.timelock);
export const zapClient = bundledClient<ZapMethods>(SPECS.zap);

function requireDeployments() {
  if (!deployments) throw new Error(`deployments/${network}.json is missing from this build.`);
  return deployments;
}

function requireCreationPlatform(): string {
  if (!creationPlatform) throw new Error(`deployments/${network}.json is missing from this build.`);
  return creationPlatform.id;
}


export class ChainError extends Error {
  readonly raw: string;
  constructor(raw: string) {
    super(explainRaw(raw));
    this.raw = raw;
  }
}

const FUND_ERRORS: Record<number, string> = {
  5: "Enter an amount above zero.",
  6: "You don't hold enough fund shares for that.",
  8: "This fund only accepts approved investors, and your address isn't on its list yet.",
  9: "That amount is too small to deposit anything.",
  10: "One of the skipped assets isn't part of this fund.",
  11: "That amount is too large.",
  14: "The fund is holding that asset for earlier redemptions, so it can't be paid out right now.",
  15: "This fund has no oracle set for rebalancing yet.",
  16: "That trade gives up more than 1% of value at oracle prices. Ask for more of the asset you're buying.",
  17: "Pick two different assets.",
  18: "This fund's mandate is locked: its assets can't change.",
  19: "The mandate is already set, and it can only be set once.",
  20: "The fund is already open for investment, so its fee and mandate are final.",
  21: "The fee is already set, and it can only be set once.",
  22: "The annual fee can be at most 5%.",
  23: "The platform's share can be at most half the fee.",
  24: "That asset isn't on the platform's shelf.",
  25: "That profile text is too long: 512 bytes and 8 fields at most.",
  26: "That trade would take today's rebalancing losses past 2% of fund value. Try a smaller trade or wait.",
  27: "Trades are at least a minute apart. Try again shortly.",
  28: "The oracle returned an unusable price for one of the assets.",
  29: "The manager hasn't opened this fund for investment yet.",
  30: "No DEX router is set for this fund.",
  31: "That swap route isn't valid for these two assets.",
  32: "The swap returned less than the minimum. Prices moved; quote again.",
  33: "This fund's mandate is static: it never trades.",
};

function explainRaw(raw: string): string {
  const text = raw.toLowerCase();
  if (text.includes("trustline") && text.includes("missing")) {
    return "Your account isn't set up to hold one of the assets yet (it needs a trustline).";
  }
  if (text.includes("not authorized") || text.includes("deauthorized")) {
    return "The issuer hasn't approved this account to hold one of the assets.";
  }
  if (text.includes("balance is not sufficient") || text.includes("resulting balance is not within the allowed range")) {
    return "Your wallet doesn't hold enough of one of the assets for this amount.";
  }
  if (text.includes("account entry is missing") || text.includes("account not found")) {
    return "This account doesn't exist on the network yet. Fund it with some XLM first.";
  }
  const code = /Error\(Contract, #(\d+)\)/.exec(raw)?.[1];
  if (code && FUND_ERRORS[Number(code)]) return FUND_ERRORS[Number(code)] ?? raw;
  return "The network rejected this transaction. Nothing was sent.";
}

const HORIZON_CODES: Record<string, string> = {
  op_too_few_offers: "There isn't enough market depth to buy one of the assets right now.",
  op_over_source_max: "The price moved more than 2% while you were signing. Try again.",
  op_underfunded: "You don't have enough XLM to buy the basket.",
  op_low_reserve: "Your account needs more XLM to cover the reserve for new assets.",
  op_no_trust: "Your account isn't set up to hold one of the assets.",
  op_not_authorized: "The issuer hasn't approved your account for one of the assets.",
  op_src_not_authorized: "The issuer hasn't approved your account for one of the assets.",
  tx_bad_seq: "Your wallet's sequence number was out of date. Try again.",
  tx_insufficient_balance: "You don't have enough XLM to pay the network fee.",
};

export function explain(error: unknown): string {
  if (error instanceof ChainError) return error.message;
  if (error instanceof contract.AssembledTransaction.Errors.UserRejected) return "You declined the request in your wallet.";
  const codes = horizonResultCodes(error);
  for (const code of codes) {
    const message = HORIZON_CODES[code];
    if (message) return message;
  }
  const kitMessage = field(error, "message");
  const message = error instanceof Error ? error.message : typeof kitMessage === "string" ? kitMessage : String(error);
  if (/reject|declin|cancel/i.test(message)) return "You declined the request in your wallet.";
  if (/Error\(Contract|HostError|trustline|authorized/.test(message)) return explainRaw(message);
  return message || "Something went wrong. Nothing was sent.";
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function horizonResultCodes(error: unknown): string[] {
  const codes = field(field(field(field(error, "response"), "data"), "extras"), "result_codes");
  const operations = field(codes, "operations");
  const transaction = field(codes, "transaction");
  return [
    ...(Array.isArray(operations) ? operations.filter((c): c is string => typeof c === "string" && c !== "op_success") : []),
    ...(typeof transaction === "string" ? [transaction] : []),
  ];
}


export interface AssetInfo {
  token: string;
  code: string;
  issuer: string | null;
  asset: Asset;
  /** Who stands behind the asset: a pinned domain, "demo issuer", "unverified issuer" or "native". */
  issuerLabel: string;
  verified: boolean;
  authRequired: boolean;
  revocable: boolean;
  clawback: boolean;
}

function parseAsset(name: string): Asset {
  if (name === "native") return Asset.native();
  const [code, issuer] = name.split(":");
  if (!code || !issuer) throw new Error(`Unrecognized asset ${name}`);
  return new Asset(code, issuer);
}

const assetCache = new Map<string, Promise<AssetInfo>>();

export function assetInfo(token: string): Promise<AssetInfo> {
  let pending = assetCache.get(token);
  if (!pending) {
    pending = loadAssetInfo(token);
    pending.catch(() => assetCache.delete(token));
    assetCache.set(token, pending);
  }
  return pending;
}

async function loadAssetInfo(token: string): Promise<AssetInfo> {
  const known = Object.values(deployments?.assets ?? {}).find((a) => a.contract === token);
  const asset = parseAsset(known?.asset ?? (await read((await sacClient(token)).name())));
  if (asset.isNative()) {
    return { token, code: "XLM", issuer: null, asset, issuerLabel: "native", verified: true, authRequired: false, revocable: false, clawback: false };
  }
  const issuer = asset.getIssuer() ?? "";
  const pinned = isMainnet ? PINNED_MAINNET_ISSUERS[issuer] : undefined;
  const ours = known?.issuer_identity !== undefined;
  const account = await horizon.accounts().accountId(issuer).call().catch(() => null);
  return {
    token,
    code: asset.getCode(),
    issuer,
    asset,
    issuerLabel: pinned ?? (ours ? DEMO_ISSUER_LABEL : UNVERIFIED_ISSUER_LABEL),
    verified: pinned !== undefined || ours,
    authRequired: account?.flags.auth_required ?? false,
    revocable: account?.flags.auth_revocable ?? false,
    clawback: account?.flags.auth_clawback_enabled ?? false,
  };
}

export function pathIsAllowed(path: { asset_type: string; asset_code?: string; asset_issuer?: string }[]): boolean {
  return path.every(
    (hop) =>
      hop.asset_type === "native" ||
      (QUOTE_USDC !== null && hop.asset_code === QUOTE_USDC.getCode() && hop.asset_issuer === QUOTE_USDC.getIssuer()),
  );
}

const priceCache = new Map<string, { at: number; price: Promise<number | null> }>();
const PRICE_TTL_MS = 30_000;

/** One market quote per asset per 30 s, shared across every fund that holds it. */
export function priceInUsdc(asset: Asset): Promise<number | null> {
  const key = asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`;
  const cached = priceCache.get(key);
  if (cached && Date.now() - cached.at < PRICE_TTL_MS) return cached.price;
  const price = quoteInUsdc(asset);
  priceCache.set(key, { at: Date.now(), price });
  return price;
}

/** USDC received for 1 unit on the network's own DEX, or null where there is no book. */
async function quoteInUsdc(asset: Asset): Promise<number | null> {
  if (!QUOTE_USDC) return null;
  if (asset.equals(QUOTE_USDC)) return 1;
  try {
    const { records } = await horizon.strictSendPaths(asset, "1", [QUOTE_USDC]).call();
    const best = records
      .filter((r) => pathIsAllowed(r.path))
      .map((r) => Number(r.destination_amount))
      .filter((n) => Number.isFinite(n) && n > 0);
    return best.length ? Math.max(...best) : null;
  } catch {
    return null;
  }
}


const ORACLE_SCALE = 1e8;

export interface OracleQuote {
  priceUsd: number;
  source: string;
  /** Unix seconds of the oldest reading behind the price. */
  timestamp: number;
  /** Primary vs secondary oracle, when both were fresh. */
  divergenceBps: number | null;
}

interface OracleNav {
  perShare: number | null;
  total: number | null;
  quotes: Map<string, OracleQuote>;
}

function toQuote(raw: NavQuoteRaw): OracleQuote {
  return {
    priceUsd: Number(raw.price) / ORACLE_SCALE,
    source: raw.source,
    timestamp: Number(raw.timestamp),
    divergenceBps: raw.divergence_bps ?? null,
  };
}

/**
 * The nav contract's view of a fund. A full NAV needs every leg fresh; when
 * one is not, each leg is priced on its own so the rest still show.
 */
async function loadOracleNav(navId: string | null, fundId: string, tokens: string[]): Promise<OracleNav | null> {
  if (!navId) return null;
  const nav = await navClient(navId);
  try {
    const result = (await read(nav.nav({ fund: fundId }))).unwrap();
    return {
      perShare: Number(result.per_share_usd) / ORACLE_SCALE,
      total: Number(result.total_usd) / ORACLE_SCALE,
      quotes: new Map(result.legs.map((leg) => [leg.token, toQuote(leg)])),
    };
  } catch {
    const quotes = await Promise.all(
      tokens.map((token) =>
        read(nav.price({ token }))
          .then((r) => [token, toQuote(r.unwrap())] as const)
          .catch(() => null),
      ),
    );
    return {
      perShare: null,
      total: null,
      quotes: new Map(quotes.filter((q) => q !== null)),
    };
  }
}

export interface FundComponent extends AssetInfo {
  shelfStatus: ShelfStatus;
  unitsPerShare: bigint;
  holding: bigint;
  priceUsdc: number | null;
  /** Null when no nav contract is deployed or no oracle has a fresh price. */
  oracle: OracleQuote | null;
  /** Only read for shelf-permissioned assets; null elsewhere. */
  fundAuthorized: boolean | null;
}

export interface Fund {
  id: string;
  name: string;
  symbol: string;
  compliance: Compliance;
  totalSupply: bigint;
  components: FundComponent[];
  /** From SDEX prices, in USDC. */
  valuePerShare: number | null;
  /** From the nav contract, in USD; null unless every leg has a fresh oracle price. */
  navPerShare: number | null;
  navTotal: number | null;
  hasOracle: boolean;
  awaitingIssuer: FundComponent[];
  manager: string;
  /** Hex hash of the code this fund runs, from its contract instance. */
  wasmHash: string | null;
  /** The platform that registered this fund. */
  platform: string;
  /** The NAV contract pricing this fund for display. */
  navContract: string | null;
  /** Fee, mandate and issuance state; null for funds on code from before v0.4. */
  setup: FundSetup | null;
  /** Manager-written profile fields (description, strategy, website); empty when none. */
  metadata: FundMetadata;
}

export interface FundMetadata {
  description?: string;
  strategy?: string;
  website?: string;
}

export interface FundSetup {
  open: boolean;
  /** Null until chosen; the contract treats an unchosen mandate as Locked. */
  mandate: Mandate | null;
  fee: { rateBps: number; lastAccrual: number } | null;
  platformFee: { shareBps: number; recipient: string } | null;
  feeRecipient: string;
  lastRebalance: number | null;
}

interface FundState {
  id: string;
  wasmHash: string | null;
  platform: string;
  name: string;
  symbol: string;
  compliance: Compliance;
  manager: string;
  totalSupply: bigint;
  storage: Map<string, unknown>;
  metadata: FundMetadata;
  components: { token: string; initialUnits: bigint; held: bigint; reserved: bigint; shelf: ShelfStatus; fundAuthorized: boolean }[];
}

function wasmHashOf(instance: xdr.ScVal | undefined): string | null {
  if (instance?.type !== "scvContractInstance") return null;
  const executable = instance.instance.executable;
  return executable.type === "contractExecutableWasm" ? Buffer.from(executable.wasmHash.toXDR()).toString("hex") : null;
}

const SHARE_SCALE = 10_000_000n;
const unitTag = (value: unknown): string => (Array.isArray(value) ? String(value[0]) : String(value));
const asBigInt = (value: unknown): bigint => (typeof value === "bigint" ? value : 0n);

const isFundKey = (platform: string, id: string) => dataKey(platform, variantKey("IsFund", addressVal(id)));
const metadataKey = (fund: string) => dataKey(fund, variantKey("Metadata"));

function toMetadata(value: unknown): FundMetadata {
  if (typeof value !== "object" || value === null) return {};
  const out: FundMetadata = {};
  for (const key of ["description", "strategy", "website"] as const) {
    const field = Reflect.get(value, key);
    if (typeof field === "string" && field.trim()) out[key] = field;
  }
  return out;
}

/**
 * Reads every fund's state in two batched ledger requests: first each fund's
 * config and its registration on each known platform, then every asset
 * balance, owed reserve, shelf status, issuer authorization and profile
 * those configs point at. Funds no known platform registered are dropped.
 */
async function readFundStates(ids: string[]): Promise<FundState[]> {
  const platformIds = platforms.map((p) => p.id);
  const first = await readEntries(ids.flatMap((id) => [instanceKey(id), ...platformIds.map((p) => isFundKey(p, id))]));

  const configs = ids
    .map((id) => {
      const instance = first.get(keyId(instanceKey(id)));
      const platform = platformIds.find((p) => native(first.get(keyId(isFundKey(p, id)))) === true);
      return { id, platform, storage: instanceStorage(instance), wasmHash: wasmHashOf(instance) };
    })
    .filter((c): c is typeof c & { platform: string } => c.platform !== undefined && c.storage.size > 0);

  const balanceKey = (token: string, holder: string) => dataKey(token, variantKey("Balance", addressVal(holder)));
  const reservedKey = (fund: string, token: string) => dataKey(fund, variantKey("Reserved", addressVal(token)));
  const shelfKey = (platform: string, token: string) => dataKey(platform, variantKey("ShelfStatus", addressVal(token)));
  const componentsOf = (storage: Map<string, unknown>) =>
    (storage.get("Components") as { token: string; initial_units: bigint }[] | undefined) ?? [];

  const second = await readEntries(
    configs.flatMap(({ id, platform, storage }) => [
      metadataKey(id),
      ...componentsOf(storage).flatMap((c) => [balanceKey(c.token, id), reservedKey(id, c.token), shelfKey(platform, c.token)]),
    ]),
  );

  return configs.map(({ id, platform, storage, wasmHash }) => ({
    id,
    wasmHash,
    platform,
    storage,
    name: String(storage.get("Name") ?? ""),
    symbol: String(storage.get("Symbol") ?? ""),
    compliance: unitTag(storage.get("Compliance")) as Compliance,
    manager: String(storage.get("Manager") ?? ""),
    totalSupply: asBigInt(storage.get("Supply")),
    metadata: toMetadata(native(second.get(keyId(metadataKey(id))))),
    components: componentsOf(storage).map((c) => {
      const balance = native(second.get(keyId(balanceKey(c.token, id)))) as
        | { amount: bigint; authorized: boolean }
        | undefined;
      const shelf = native(second.get(keyId(shelfKey(platform, c.token))));
      return {
        token: c.token,
        initialUnits: c.initial_units,
        held: balance?.amount ?? 0n,
        reserved: asBigInt(native(second.get(keyId(reservedKey(id, c.token))))),
        shelf: (shelf === undefined ? "Unlisted" : unitTag(shelf)) as ShelfStatus,
        fundAuthorized: balance?.authorized ?? false,
      };
    }),
  }));
}

/** Instance keys only v0.4 fund code writes. */
const V4_KEYS = ["Opened", "Mandate", "Fee", "FeeRecipient", "PlatformFee", "Losses", "LastRebalance", "Router"];

const probeCache = new Map<string, Promise<boolean>>();

/**
 * Whether a fund runs v0.4 code. Released hashes answer directly; a fund on
 * unlisted code that has written a v0.4 key is v0.4; anything else is probed
 * once with an `is_open` simulation, which older code doesn't have.
 */
function runsV4(state: FundState): Promise<boolean> {
  if (isLegacyFundCode(state.wasmHash)) return Promise.resolve(false);
  if (V4_KEYS.some((key) => state.storage.has(key))) return Promise.resolve(true);
  const key = state.wasmHash ?? state.id;
  let probe = probeCache.get(key);
  if (!probe) {
    probe = fundClient(state.id)
      .then((c) => read(c.is_open()))
      .then(
        () => true,
        (err: unknown) => {
          if (err instanceof ChainError) return false;
          probeCache.delete(key);
          throw err;
        },
      );
    probeCache.set(key, probe);
  }
  return probe;
}

function toSetup(state: FundState): FundSetup {
  const s = state.storage;
  const fee = s.get("Fee") as { rate_bps: number; last_accrual: bigint } | undefined;
  const platformFee = s.get("PlatformFee") as { share_bps: number; recipient: string } | undefined;
  const mandate = s.get("Mandate");
  const last = s.get("LastRebalance");
  return {
    open: s.has("Opened"),
    mandate: mandate === undefined ? null : (unitTag(mandate) as Mandate),
    fee: fee ? { rateBps: Number(fee.rate_bps), lastAccrual: Number(fee.last_accrual) } : null,
    platformFee: platformFee ? { shareBps: Number(platformFee.share_bps), recipient: String(platformFee.recipient) } : null,
    feeRecipient: String(s.get("FeeRecipient") ?? state.manager),
    lastRebalance: typeof last === "bigint" ? Number(last) : null,
  };
}

/** Mirrors the fund contract: holdings net of owed claims, units from holdings over supply. */
async function toFund(state: FundState): Promise<Fund> {
  const slot = platformSlot(state.platform);
  const navContract = slot?.nav ?? null;
  const oracleNav = loadOracleNav(
    navContract,
    state.id,
    state.components.map((c) => c.token),
  ).catch(() => null);
  const v4 = runsV4(state).catch(() => false);
  const legs = await Promise.all(
    state.components.map(async (c): Promise<FundComponent> => {
      const info = await assetInfo(c.token);
      const holding = c.held > c.reserved ? c.held - c.reserved : 0n;
      return {
        ...info,
        shelfStatus: c.shelf,
        unitsPerShare: state.totalSupply === 0n ? c.initialUnits : (holding * SHARE_SCALE) / state.totalSupply,
        holding,
        priceUsdc: await priceInUsdc(info.asset),
        oracle: null,
        fundAuthorized: c.shelf === "Permissioned" ? c.fundAuthorized : null,
      };
    }),
  );
  const oracle = await oracleNav;
  for (const leg of legs) leg.oracle = oracle?.quotes.get(leg.token) ?? null;

  const priced = legs.every((leg) => leg.priceUsdc !== null);
  return {
    id: state.id,
    name: state.name,
    symbol: Object.entries(slot?.launched ?? {}).find(([, cid]) => cid === state.id)?.[0] ?? state.symbol,
    compliance: state.compliance,
    totalSupply: state.totalSupply,
    components: legs,
    valuePerShare: priced
      ? legs.reduce((sum, leg) => sum + unitsToNumber(leg.unitsPerShare) * (leg.priceUsdc ?? 0), 0)
      : null,
    navPerShare: oracle?.perShare ?? null,
    navTotal: oracle?.total ?? null,
    hasOracle: oracle !== null,
    awaitingIssuer: legs.filter((leg) => leg.fundAuthorized === false),
    manager: state.manager,
    wasmHash: state.wasmHash,
    platform: state.platform,
    navContract,
    setup: (await v4) ? toSetup(state) : null,
    metadata: state.metadata,
  };
}

async function loadFunds(ids: string[]): Promise<Fund[]> {
  const states = await withRetry(() => readFundStates(ids));
  return Promise.all(states.map(toFund));
}

const FUNDS_PAGE = 50;

async function registeredFundIds(platformId: string, launched: string[]): Promise<string[]> {
  const platform = await platformClients(platformId);
  const count = await read(platform.fund_count());
  const pages = [];
  for (let start = 0; start < count; start += FUNDS_PAGE) {
    pages.push(read(platform.funds({ start, limit: FUNDS_PAGE })));
  }
  const registered = new Set((await Promise.all(pages)).flat());
  // Launch funds first, in launch order, then every fund managers created
  // since; only ids the platform itself registered.
  const first = launched.filter((id) => registered.has(id));
  return [...first, ...[...registered].filter((id) => !first.includes(id))];
}

let fundsCache: Promise<Fund[]> | null = null;

export function invalidateFunds() {
  fundsCache = null;
}

/** Every fund the known platforms recognize. A platform's registry is the authority, never fund self-reports. */
export function listFunds(fresh = false): Promise<Fund[]> {
  if (!fundsCache || fresh) {
    requireDeployments();
    fundsCache = Promise.all(
      platforms.map((slot) => {
        const launched = Object.values(slot.launched);
        return withRetry(() => registeredFundIds(slot.id, launched)).catch(() => launched);
      }),
    )
      .then((lists) => [...new Set(lists.flat())])
      .then(loadFunds);
    fundsCache.catch(() => {
      fundsCache = null;
    });
  }
  return fundsCache;
}

/** Resolves a route by contract ID, and only among funds a known platform registered. */
export async function findFund(contractId: string, fresh = false): Promise<Fund | null> {
  const funds = await listFunds(fresh);
  return funds.find((f) => f.id === contractId) ?? null;
}


export interface Holding {
  code: string;
  token: string;
  balance: bigint;
  hasTrustline: boolean;
  authorized: boolean;
}

export interface Position {
  exists: boolean;
  shares: bigint;
  isInvestor: boolean;
  wallet: Holding[];
  owed: { component: FundComponent; amount: bigint }[];
}

export async function accountBalances(address: string) {
  try {
    const account = await horizon.accounts().accountId(address).call();
    return account.balances;
  } catch {
    return null;
  }
}

export function holdingFor(balances: Horizon.HorizonApi.BalanceLine[] | null, leg: AssetInfo): Holding {
  const base = { code: leg.code, token: leg.token };
  if (!balances) return { ...base, balance: 0n, hasTrustline: false, authorized: false };
  for (const line of balances) {
    if (line.asset_type === "native" && leg.asset.isNative()) {
      return { ...base, balance: toBaseUnits(line.balance), hasTrustline: true, authorized: true };
    }
    if (
      (line.asset_type === "credit_alphanum4" || line.asset_type === "credit_alphanum12") &&
      line.asset_code === leg.code &&
      line.asset_issuer === leg.issuer
    ) {
      return { ...base, balance: toBaseUnits(line.balance), hasTrustline: true, authorized: line.is_authorized };
    }
  }
  return { ...base, balance: 0n, hasTrustline: false, authorized: false };
}

export function toBaseUnits(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  return BigInt(whole) * ONE + BigInt(frac.padEnd(7, "0").slice(0, 7));
}

export async function loadPosition(fund: Fund, address: string): Promise<Position> {
  const c = await fundClient(fund.id);
  const [balances, shares, isInvestor, owed] = await Promise.all([
    accountBalances(address),
    read(c.balance({ id: address })),
    fund.compliance === "Allowlist" ? read(c.is_investor({ investor: address })) : Promise.resolve(true),
    Promise.all(fund.components.map((leg) => read(c.owed({ owner: address, token: leg.token })))),
  ]);
  return {
    exists: balances !== null,
    shares,
    isInvestor,
    wallet: fund.components.map((leg) => holdingFor(balances, leg)),
    owed: fund.components
      .map((component, i) => ({ component, amount: owed[i] ?? 0n }))
      .filter((o) => o.amount > 0n),
  };
}

export async function quoteIssue(fund: Fund, shares: bigint): Promise<bigint[]> {
  return read((await fundClient(fund.id)).quote_issue({ shares }));
}

export async function quoteRedeem(fund: Fund, shares: bigint): Promise<bigint[]> {
  return read((await fundClient(fund.id)).quote_redeem({ shares }));
}


export interface BasketLeg {
  code: string;
  shortfall: bigint;
  needsTrustline: boolean;
  /** Why this leg can't be bought here, in plain words. */
  blocked: string | null;
  sendMax: bigint | null;
  route: string;
}

export interface BasketPlan {
  legs: BasketLeg[];
  totalSendMax: bigint;
  /** Unsigned XDR, or null when nothing needs buying or a leg is blocked. */
  xdr: string | null;
}

export async function planBasket(fund: Fund, address: string, shares: bigint): Promise<BasketPlan> {
  const [needed, balances] = await Promise.all([quoteIssue(fund, shares), accountBalances(address)]);
  if (!balances) throw new Error("This account doesn't exist on the network yet. Fund it with some XLM first.");

  const legs: (BasketLeg & { asset: Asset; path: Asset[] })[] = [];
  for (const [i, leg] of fund.components.entries()) {
    if (leg.asset.isNative()) continue;
    const holding = holdingFor(balances, leg);
    const shortfall = (needed[i] ?? 0n) - holding.balance;
    if (shortfall <= 0n) continue;
    const base = { code: leg.code, shortfall, needsTrustline: !holding.hasTrustline, asset: leg.asset, path: [] as Asset[] };
    if (leg.authRequired && !holding.authorized) {
      legs.push({
        ...base,
        blocked: `${leg.code}'s issuer approves each holder. Your account needs their approval before you can buy it.`,
        sendMax: null,
        route: "",
      });
      continue;
    }
    const quote = await quoteBuy(leg.asset, shortfall);
    if (!quote) {
      legs.push({ ...base, blocked: `There's no market for ${leg.code} on ${isMainnet ? "the Stellar DEX" : "testnet"} right now.`, sendMax: null, route: "" });
      continue;
    }
    legs.push({ ...base, blocked: null, ...quote });
  }

  const totalSendMax = legs.reduce((sum, leg) => sum + (leg.sendMax ?? 0n), 0n);
  const buyable = legs.filter((leg) => !leg.blocked);
  const trustlines = legs.filter((leg) => leg.needsTrustline);
  let xdr: string | null = null;
  if (buyable.length || trustlines.length) {
    const account = await horizon.loadAccount(address);
    const builder = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: endpoints.passphrase });
    for (const leg of trustlines) builder.addOperation(Operation.changeTrust({ asset: leg.asset }));
    for (const leg of buyable) {
      builder.addOperation(
        Operation.pathPaymentStrictReceive({
          sendAsset: Asset.native(),
          sendMax: toDecimalString(leg.sendMax ?? 0n),
          destination: address,
          destAsset: leg.asset,
          destAmount: toDecimalString(leg.shortfall),
          path: leg.path,
        }),
      );
    }
    xdr = builder.setTimeout(TX_TIMEOUT_SECONDS).build().toXDR();
  }
  return {
    legs: legs.map(({ asset: _asset, path: _path, ...rest }) => rest),
    totalSendMax,
    xdr,
  };
}

async function quoteBuy(asset: Asset, amount: bigint): Promise<{ sendMax: bigint; path: Asset[]; route: string } | null> {
  try {
    const { records } = await horizon.strictReceivePaths([Asset.native()], asset, toDecimalString(amount)).call();
    const best = records
      .filter((r) => pathIsAllowed(r.path))
      .sort((a, b) => Number(a.source_amount) - Number(b.source_amount))[0];
    if (!best) return null;
    const path = best.path.map((hop) =>
      hop.asset_type === "native" ? Asset.native() : new Asset(hop.asset_code ?? "", hop.asset_issuer ?? ""),
    );
    const cost = toBaseUnits(best.source_amount);
    return {
      sendMax: cost + (cost * SLIPPAGE_BPS) / 10_000n,
      path,
      route: path.length ? `XLM → ${path.map((p) => p.getCode()).join(" → ")} → ${asset.getCode()}` : `XLM → ${asset.getCode()}`,
    };
  } catch {
    return null;
  }
}

export async function submitClassic(xdr: string, address: string): Promise<string> {
  const signed = await signWithWallet(xdr, { networkPassphrase: endpoints.passphrase, address });
  const tx = TransactionBuilder.fromXDR(signed.signedTxXdr, endpoints.passphrase);
  const result = await horizon.submitTransaction(tx);
  return result.hash;
}


export interface TxResult {
  hash: string;
  url: string;
}

async function signAndSubmit<T>(tx: AT<T>) {
  const assembled = await tx;
  const simulation = assembled.simulation;
  if (simulation && rpc.Api.isSimulationError(simulation)) throw new ChainError(simulation.error);
  const sent = await assembled.signAndSend();
  const response = sent.getTransactionResponse;
  const hash = sent.sendTransactionResponse?.hash ?? "";
  if (response && response.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`The transaction was submitted but did not succeed (${response.status}).`);
  }
  return { hash, url: expert.tx(hash), sent };
}

export async function send<T>(tx: AT<T>): Promise<TxResult> {
  const { hash, url } = await signAndSubmit(tx);
  return { hash, url };
}

/** As `send`, and also returns what the contract call returned on chain. */
export async function sendForResult<T>(tx: AT<T>): Promise<TxResult & { result: T }> {
  const { hash, url, sent } = await signAndSubmit(tx);
  return { hash, url, result: sent.result };
}

/** Simulate only: the same checks the network runs, without asking the wallet to sign. */
async function simulate<T>(tx: AT<T>): Promise<T> {
  return read(tx);
}

export async function simulateIssue(fund: Fund, address: string, shares: bigint) {
  return simulate((await fundClient(fund.id, address)).issue({ investor: address, to: address, shares }));
}

export async function issue(fund: Fund, address: string, shares: bigint) {
  return send((await fundClient(fund.id, address)).issue({ investor: address, to: address, shares }));
}

export async function simulateRedeem(fund: Fund, address: string, shares: bigint, skip: string[]) {
  return simulate((await fundClient(fund.id, address)).redeem({ from: address, to: address, shares, skip }));
}

export async function redeem(fund: Fund, address: string, shares: bigint, skip: string[]) {
  return send((await fundClient(fund.id, address)).redeem({ from: address, to: address, shares, skip }));
}

/**
 * Legs this account can't receive right now: no trustline, or the issuer
 * hasn't authorized it. Redeeming with these skipped books them as owed.
 */
export async function unreceivableLegs(fund: Fund, address: string, failure?: ChainError): Promise<FundComponent[]> {
  const balances = await accountBalances(address);
  const blocked = fund.components.filter((leg) => {
    if (leg.asset.isNative()) return false;
    const holding = holdingFor(balances, leg);
    return !holding.hasTrustline || !holding.authorized;
  });
  if (blocked.length || !failure) return blocked;
  return fund.components.filter((leg) => failure.raw.includes(leg.token));
}

export interface ShelfAsset extends AssetInfo {
  status: ShelfStatus;
  priceUsdc: number | null;
}

/**
 * Every asset a platform's admin has listed, with its market price. Delisted
 * tokens stay out unless `withUnlisted`, which the admin console uses.
 */
export async function loadShelf(platformId = requireCreationPlatform(), withUnlisted = false): Promise<ShelfAsset[]> {
  const platform = await platformClients(platformId);
  const tokens = await withRetry(() => read(platform.shelf()));
  const shelfKey = (token: string) => dataKey(platformId, variantKey("ShelfStatus", addressVal(token)));
  const statuses = await withRetry(() => readEntries(tokens.map(shelfKey)));
  const assets = await Promise.all(
    tokens.map(async (token) => {
      const info = await assetInfo(token);
      const status = native(statuses.get(keyId(shelfKey(token))));
      return {
        ...info,
        status: (status === undefined ? "Unlisted" : unitTag(status)) as ShelfStatus,
        priceUsdc: await priceInUsdc(info.asset),
      };
    }),
  );
  return withUnlisted ? assets : assets.filter((a) => a.status !== "Unlisted");
}

export async function isManager(address: string, platformId?: string): Promise<boolean> {
  if (platformId === undefined) return (await managedPlatform(address)) !== null;
  const platform = await platformClients(platformId);
  return withRetry(() => read(platform.is_manager({ manager: address })));
}

/** The newest platform that allowlists `address` as a manager, or null when none does. */
export async function managedPlatform(address: string): Promise<string | null> {
  for (const slot of creationCandidates) {
    if (await isManager(address, slot.id)) return slot.id;
  }
  return null;
}

/**
 * Whether a platform deploys v0.4 fund code, from the hash it stores. A hash
 * outside the released list is taken as current code.
 */
export async function platformDeploysV4(platformId = requireCreationPlatform()): Promise<boolean> {
  const entries = await withRetry(() => readEntries([instanceKey(platformId)]));
  const wasm = instanceStorage(entries.get(keyId(instanceKey(platformId)))).get("FundWasm");
  const hash = wasm instanceof Uint8Array ? Buffer.from(wasm).toString("hex") : null;
  return hash !== null && !isLegacyFundCode(hash);
}

/** USD prices from the NAV contract for the tokens an oracle has a fresh price for. */
export async function oraclePrices(tokens: string[], navId = creationPlatform?.nav ?? null): Promise<Map<string, number>> {
  if (!navId) return new Map();
  const nav = await navClient(navId);
  const quotes = await Promise.all(
    tokens.map((token) =>
      read(nav.price({ token }))
        .then((r) => [token, toQuote(r.unwrap()).priceUsd] as const)
        .catch(() => null),
    ),
  );
  return new Map(quotes.filter((q) => q !== null));
}

export interface NewFund {
  name: string;
  symbol: string;
  compliance: Compliance;
  components: { token: string; initialUnits: bigint }[];
}

/** Deploys a fund through the platform; the connected wallet signs as its manager. */
export async function createFund(address: string, spec: NewFund): Promise<TxResult & { fundId: string }> {
  const platform = await platformClients((await managedPlatform(address)) ?? requireCreationPlatform(), address);
  const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
  const tx = platform.create_fund({
    manager: address,
    name: spec.name,
    symbol: spec.symbol,
    components: spec.components.map((c) => ({ token: c.token, initial_units: c.initialUnits })),
    compliance: { tag: spec.compliance },
    salt,
  });
  const assembled = await tx;
  const fundId = assembled.result;
  const sent = await send(Promise.resolve(assembled));
  fundsCache = null;
  return { ...sent, fundId };
}

export async function setCompliance(fund: Fund, address: string, compliance: Compliance) {
  const result = await send((await fundClient(fund.id, address)).set_compliance({ compliance: { tag: compliance } }));
  fundsCache = null;
  return result;
}

export async function setInvestor(fund: Fund, address: string, investor: string, allowed: boolean) {
  return send((await fundClient(fund.id, address)).set_investor({ investor, allowed }));
}

/** The oracle bounding this fund's rebalances, or null for funds deployed before rebalancing shipped. */
export async function rebalanceOracle(fund: Fund): Promise<string | null> {
  try {
    return (await read((await fundClient(fund.id)).nav())) ?? null;
  } catch {
    return null;
  }
}

export async function rebalance(fund: Fund, address: string, sell: string, sold: bigint, buy: string, bought: bigint) {
  const result = await send((await fundClient(fund.id, address)).rebalance({ sell, sold, buy, bought }));
  fundsCache = null;
  return result;
}

export async function withdrawOwed(fund: Fund, address: string, token: string) {
  return send((await fundClient(fund.id, address)).withdraw_owed({ owner: address, to: address, token }));
}


let kitReady = false;

function walletConnectModule(): WalletConnectModule | null {
  const projectId = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID;
  if (!projectId) return null;
  return new WalletConnectModule({
    projectId,
    metadata: {
      name: "Alloy on Stellar",
      description: "Onchain funds on Stellar",
      url: "https://alloy-stellar.vercel.app",
      icons: ["https://alloy-stellar.vercel.app/mark.svg"],
    },
    allowedChains: [isMainnet ? WalletConnectTargetChain.PUBLIC : WalletConnectTargetChain.TESTNET],
  });
}

function initKit() {
  if (kitReady) return;
  const walletConnect = walletConnectModule();
  StellarWalletsKit.init({
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new LobstrModule(),
      ...(walletConnect ? [walletConnect] : []),
    ],
    network: isMainnet ? KitNetworks.PUBLIC : KitNetworks.TESTNET,
    theme: {
      background: "var(--background)",
      "background-secondary": "var(--secondary)",
      "foreground-strong": "var(--foreground)",
      foreground: "var(--foreground)",
      "foreground-secondary": "var(--muted-foreground)",
      primary: "var(--primary)",
      "primary-foreground": "var(--primary-foreground)",
      transparent: "rgba(0, 0, 0, 0)",
      lighter: "var(--card)",
      light: "var(--secondary)",
      "light-gray": "var(--border)",
      gray: "var(--muted-foreground)",
      danger: "var(--destructive)",
      border: "var(--border)",
      shadow: "var(--shadow-overlay)",
      "border-radius": "1rem",
      "font-family": "Switzer, ui-sans-serif, system-ui, sans-serif",
    },
  });
  kitReady = true;
}

export async function connectWallet(): Promise<string> {
  initKit();
  const { address } = await StellarWalletsKit.authModal();
  return address;
}

export async function restoreWallet(): Promise<string | null> {
  try {
    initKit();
    const { address } = await StellarWalletsKit.getAddress();
    return address || null;
  } catch {
    return null;
  }
}

export async function disconnectWallet(): Promise<void> {
  initKit();
  await StellarWalletsKit.disconnect();
}

export async function signWithWallet(xdr: string, opts?: { networkPassphrase?: string; address?: string }) {
  initKit();
  return StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase: opts?.networkPassphrase ?? endpoints.passphrase,
    address: opts?.address,
  });
}

/** Signs one Soroban authorization entry, for calls another account submits. */
export async function signAuthEntryWithWallet(entry: string, opts?: { networkPassphrase?: string; address?: string }) {
  initKit();
  return StellarWalletsKit.signAuthEntry(entry, {
    networkPassphrase: opts?.networkPassphrase ?? endpoints.passphrase,
    address: opts?.address,
  });
}

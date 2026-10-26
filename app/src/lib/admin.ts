import { contract, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { platforms, type PlatformSlot } from "./config";
import { addressVal, dataKey, instanceKey, instanceStorage, keyId, native, readEntries, rpcCall, variantKey } from "./ledger";
import { SPECS } from "./specs";
import { parseScheduled, type OperationStatus, type QueuedOperation, type RawEvent } from "./timelock-events";

export { describeOperation, type QueuedOperation } from "./timelock-events";
import {
  ChainError,
  fundClient,
  clientOptions,
  invalidateFunds,
  navClient,
  read,
  send,
  timelockClient,
  type NavRouteRaw,
  type ShelfStatus,
  type TxResult,
} from "./stellar";

export interface TimelockInfo {
  id: string;
  proposers: string[];
  executors: string[];
  delaySeconds: number;
}

/** Who controls one platform: an account directly, or a timelock and its roles. */
export interface PlatformControl {
  slot: PlatformSlot;
  admin: string;
  timelock: TimelockInfo | null;
}

export interface AdminRole {
  control: PlatformControl;
  /** Signs admin calls directly. */
  isAdmin: boolean;
  /** May schedule and cancel through the timelock. */
  isProposer: boolean;
  /** May execute ready operations. */
  isExecutor: boolean;
}

const asAddresses = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/**
 * Reads each platform's admin from its instance storage, and when that admin
 * is a contract, the timelock roles and delay from the timelock's instance:
 * two batched ledger reads in all.
 */
export async function loadControls(): Promise<PlatformControl[]> {
  const first = await readEntries(platforms.map((p) => instanceKey(p.id)));
  const admins = platforms.map((slot) => ({ slot, admin: String(instanceStorage(first.get(keyId(instanceKey(slot.id)))).get("Admin") ?? "") }));
  const contracts = [...new Set(admins.map((a) => a.admin).filter((a) => a.startsWith("C")))];
  const second = contracts.length ? await readEntries(contracts.map((c) => instanceKey(c))) : new Map<string, xdr.ScVal>();
  return admins.map(({ slot, admin }) => {
    const storage = admin.startsWith("C") ? instanceStorage(second.get(keyId(instanceKey(admin)))) : new Map<string, unknown>();
    const timelock: TimelockInfo | null = storage.has("Proposers")
      ? {
          id: admin,
          proposers: asAddresses(storage.get("Proposers")),
          executors: asAddresses(storage.get("Executors")),
          delaySeconds: Number(storage.get("Delay") ?? 0),
        }
      : null;
    return { slot, admin, timelock };
  });
}

let controlsCache: Promise<PlatformControl[]> | null = null;

function controls(): Promise<PlatformControl[]> {
  if (!controlsCache) {
    controlsCache = loadControls();
    controlsCache.catch(() => {
      controlsCache = null;
    });
  }
  return controlsCache;
}

export function roleOf(control: PlatformControl, address: string): AdminRole {
  return {
    control,
    isAdmin: control.admin === address,
    isProposer: control.timelock?.proposers.includes(address) ?? false,
    isExecutor: control.timelock?.executors.includes(address) ?? false,
  };
}

/** The platforms `address` can administer, directly or as a timelock proposer or executor. */
export async function adminRoles(address: string): Promise<AdminRole[]> {
  return (await controls()).map((c) => roleOf(c, address)).filter((r) => r.isAdmin || r.isProposer || r.isExecutor);
}

type Kind = "platform" | "fund";
const specs: Record<Kind, contract.Spec> = {
  platform: new contract.Spec([...SPECS.platform]),
  fund: new contract.Spec([...SPECS.fund]),
};

/** An admin call on the platform or one of its funds, in the target's own types. */
export interface AdminCall {
  target: string;
  kind: Kind;
  method: string;
  args: Record<string, unknown>;
}

export function callArgs(call: AdminCall): xdr.ScVal[] {
  return specs[call.kind].funcArgsToScVals(call.method, call.args);
}

/**
 * Runs an admin call. With a plain-account admin the wallet signs it
 * directly; with a timelock it becomes `schedule` on the timelock, ready to
 * execute once the delay has passed.
 */
export async function adminCall(control: PlatformControl, address: string, call: AdminCall): Promise<TxResult & { scheduled: boolean }> {
  const args = callArgs(call);
  if (control.timelock) {
    const timelock = await timelockClient(control.timelock.id, address);
    const salt = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
    const result = await send(timelock.schedule({ proposer: address, target: call.target, fn_name: call.method, args, salt }));
    return { ...result, scheduled: true };
  }
  const tx = contract.AssembledTransaction.build<null>({
    ...clientOptions(call.target, address),
    method: call.method,
    args,
    parseResultXdr: () => null,
  });
  const result = await send(tx);
  invalidateFunds();
  return { ...result, scheduled: false };
}

export const setManagerCall = (platform: string, manager: string, allowed: boolean): AdminCall => ({
  target: platform,
  kind: "platform",
  method: "set_manager",
  args: { manager, allowed },
});

export const setShelfCall = (platform: string, token: string, status: ShelfStatus): AdminCall => ({
  target: platform,
  kind: "platform",
  method: "set_shelf_asset",
  args: { token, status: { tag: status } },
});

export const setNavCall = (fund: string, nav: string): AdminCall => ({ target: fund, kind: "fund", method: "set_nav", args: { nav } });
export const setRouterCall = (fund: string, router: string): AdminCall => ({ target: fund, kind: "fund", method: "set_router", args: { router } });
export const setPlatformFeeCall = (fund: string, shareBps: number, recipient: string): AdminCall => ({
  target: fund,
  kind: "fund",
  method: "set_platform_fee",
  args: { share_bps: shareBps, recipient },
});

export async function isManagerOn(platform: string, addresses: string[]): Promise<Map<string, boolean>> {
  const key = (a: string) => dataKey(platform, variantKey("Manager", addressVal(a)));
  const entries = await readEntries(addresses.map(key));
  return new Map(addresses.map((a) => [a, native(entries.get(keyId(key(a)))) === true]));
}

export interface NavRoutes {
  token: string;
  primary: NavRouteRaw | null;
  secondary: NavRouteRaw | null;
}

export async function loadRoutes(navId: string, tokens: string[]): Promise<NavRoutes[]> {
  const nav = await navClient(navId);
  return Promise.all(
    tokens.map(async (token) => {
      const [primary, secondary] = await Promise.all([
        read(nav.primary({ token })).catch(() => undefined),
        read(nav.secondary({ token })).catch(() => undefined),
      ]);
      return { token, primary: primary ?? null, secondary: secondary ?? null };
    }),
  );
}

export interface FundAdminState {
  /** False for fund code from before rebalancing, which has no oracle to set. */
  hasNav: boolean;
  nav: string | null;
  router: string | null;
}

/** The oracle and router a fund uses, including defaults compiled into its code. */
export async function loadFundAdmin(fundId: string, v4: boolean): Promise<FundAdminState> {
  const c = await fundClient(fundId);
  const [nav, router] = await Promise.all([
    read(c.nav()).then(
      (value) => ({ ok: true, value: value ?? null }),
      () => ({ ok: false, value: null }),
    ),
    v4 ? read(c.router()).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  return { hasNav: nav.ok, nav: nav.value, router: router ?? null };
}

/** Stellar RPC scans at most this many ledgers per getEvents call. */
const WINDOW = 10_000;
const SCHEDULED = xdr.ScVal.scvSymbol("scheduled").toXdr("base64");

/**
 * Operations the timelock scheduled within the RPC's event retention
 * (about a week), newest first, each with its live status from the
 * timelock's own Operation entry: missing means cancelled.
 */
export async function loadQueue(timelock: string, maxWindows = 12): Promise<QueuedOperation[]> {
  const health = await rpcCall<{ latestLedger: number; oldestLedger: number }>("getHealth");
  const found: Omit<QueuedOperation, "status">[] = [];
  let end = health.latestLedger;
  for (let i = 0; i < maxWindows && end > health.oldestLedger; i++) {
    const start = Math.max(health.oldestLedger, end - WINDOW + 1);
    const result = await rpcCall<{ events?: RawEvent[] }>("getEvents", {
      startLedger: start,
      endLedger: end,
      filters: [{ type: "contract", contractIds: [timelock], topics: [[SCHEDULED, "*", "*"]] }],
      pagination: { limit: 100 },
    });
    found.push(...(result.events ?? []).map(parseScheduled).filter((e): e is Omit<QueuedOperation, "status"> => e !== null));
    end = start - 1;
  }
  const opKey = (id: string) => dataKey(timelock, variantKey("Operation", xdr.ScVal.scvBytes(Buffer.from(id, "hex"))));
  const entries = found.length ? await readEntries(found.map((f) => opKey(f.id))) : new Map<string, xdr.ScVal>();
  const now = Date.now() / 1000;
  return found
    .map((f) => {
      const op = native(entries.get(keyId(opKey(f.id)))) as { done: boolean; ready_at: bigint } | undefined;
      const status: OperationStatus = !op ? "cancelled" : op.done ? "done" : Number(op.ready_at) <= now ? "ready" : "waiting";
      return { ...f, status };
    })
    .sort((a, b) => b.ledger - a.ledger);
}

export async function executeOperation(timelock: string, address: string, op: QueuedOperation): Promise<TxResult> {
  const client = await timelockClient(timelock, address);
  const result = await send(client.execute({ executor: address, target: op.target, fn_name: op.fnName, args: op.args, salt: op.salt }));
  invalidateFunds();
  return result;
}

export async function cancelOperation(timelock: string, address: string, op: QueuedOperation): Promise<TxResult> {
  const client = await timelockClient(timelock, address);
  return send(client.cancel({ proposer: address, id: Buffer.from(op.id, "hex") }));
}

const TIMELOCK_ERRORS: Record<number, string> = {
  1: "Your address isn't a proposer on this timelock.",
  2: "Your address isn't an executor on this timelock.",
  3: "That exact call is already queued.",
  4: "The timelock has no such operation; it may have been cancelled.",
  5: "The delay hasn't passed yet.",
  6: "That operation has already run.",
};

const PLATFORM_ERRORS: Record<number, string> = {
  1: "That address isn't an approved manager.",
  2: "That asset isn't on the shelf.",
  3: "A permissioned asset needs the fund's investor allowlist on.",
};

/** Contract error codes overlap between contracts; read them against the one that was called. */
export function explainAdmin(error: unknown, called: "timelock" | "platform" | "fund"): string | null {
  if (!(error instanceof ChainError) || called === "fund") return null;
  const code = /Error\(Contract, #(\d+)\)/.exec(error.raw)?.[1];
  const table = called === "timelock" ? TIMELOCK_ERRORS : PLATFORM_ERRORS;
  return code ? (table[Number(code)] ?? null) : null;
}


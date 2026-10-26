import { Address, xdr } from "@stellar/stellar-sdk";

/**
 * A management handover link carries one thing: the outgoing manager's
 * signed authorization for `set_manager`. The incoming manager's app
 * rebuilds the transaction itself and only splices this entry in, after
 * checking it authorizes exactly that call and nothing else.
 */

/** About a day of ledgers: how long the outgoing manager's approval stays usable. */
export const HANDOVER_LEDGERS = 17_280;
/** Slack on the expiry check for ledgers that close while the link travels. */
const EXPIRY_SLACK = 1_000;

export interface HandoverLink {
  /** Base64 `SorobanAuthorizationEntry` XDR; a valid link has exactly one. */
  entries: string[];
}

export function encodeHandover(entry: xdr.SorobanAuthorizationEntry): string {
  const link: HandoverLink = { entries: [entry.toXdr("base64")] };
  return btoa(JSON.stringify(link)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeHandover(param: string): HandoverLink | null {
  try {
    const parsed: unknown = JSON.parse(atob(param.replace(/-/g, "+").replace(/_/g, "/")));
    const entries = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed, "entries") : undefined;
    if (!Array.isArray(entries) || !entries.every((e): e is string => typeof e === "string")) return null;
    return { entries };
  } catch {
    return null;
  }
}

/** The address a credentials union signs for, or null for source-account credentials. */
export function credentialsAddress(credentials: xdr.SorobanCredentials): string | null {
  return credentials.type === "sorobanCredentialsAddress" ? Address.fromScAddress(credentials.address.address).toString() : null;
}

function soleAddressArg(args: xdr.ScVal[]): string | null {
  const [arg] = args;
  if (args.length !== 1 || !arg) return null;
  try {
    return Address.fromScVal(arg).toString();
  } catch {
    return null;
  }
}

/** The new manager the link names, for display before anything is checked against the wallet. */
export function handoverIncoming(link: HandoverLink): string | null {
  try {
    const [raw] = link.entries;
    if (!raw || link.entries.length !== 1) return null;
    const fn = xdr.SorobanAuthorizationEntry.fromXdr(raw, "base64").rootInvocation.function;
    return fn.type === "sorobanAuthorizedFunctionTypeContractFn" ? soleAddressArg(fn.contractFn.args) : null;
  } catch {
    return null;
  }
}

export type Verified = { entry: xdr.SorobanAuthorizationEntry } | { error: string };

/**
 * Checks the link authorizes `fund.set_manager(incoming)` and only that,
 * signed for the fund's current manager and expiring within the handover
 * window. Returns the entry, or why it was refused.
 */
export function verifyHandover(link: HandoverLink, expected: { fund: string; manager: string; incoming: string; latestLedger: number }): Verified {
  if (link.entries.length !== 1) return { error: "This handover link must carry exactly one approval. Ask the current manager for a new link." };
  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXdr(link.entries[0] ?? "", "base64");
  } catch {
    return { error: "This handover link is damaged. Ask the current manager for a new link." };
  }
  const credentials = entry.credentials;
  if (credentials.type !== "sorobanCredentialsAddress") return { error: "This handover link isn't signed by an account." };
  if (credentialsAddress(credentials) !== expected.manager) return { error: "This handover link wasn't signed by the fund's current manager." };
  const expiry = credentials.address.signatureExpirationLedger;
  if (expiry <= expected.latestLedger) return { error: "This handover link has expired. Ask the current manager for a new one." };
  if (expiry > expected.latestLedger + HANDOVER_LEDGERS + EXPIRY_SLACK) return { error: "This handover link stays valid for longer than a handover should." };

  const invocation = entry.rootInvocation;
  if (invocation.subInvocations.length !== 0) return { error: "This handover link authorizes more than the handover." };
  const fn = invocation.function;
  if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn") return { error: "This handover link doesn't authorize a contract call." };
  const call = fn.contractFn;
  if (Address.fromScAddress(call.contractAddress).toString() !== expected.fund) return { error: "This handover link is for a different fund." };
  if (call.functionName.toString() !== "set_manager") return { error: "This handover link authorizes something other than a handover." };
  if (soleAddressArg(call.args) !== expected.incoming) return { error: "This handover link names a different new manager." };
  return { entry };
}

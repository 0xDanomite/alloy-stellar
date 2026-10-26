import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { endpoints } from "./config";

/**
 * Batched reads of contract storage through one `getLedgerEntries` call.
 *
 * A fund page needs a few dozen small values (each fund's config, its asset
 * balances, shelf statuses, issuer authorization). Simulating a view call for
 * each one costs a request apiece; reading the storage entries directly costs
 * one request for up to 200 of them. This couples the app to the storage
 * layout of our own contracts, which are not upgradeable, and to the Stellar
 * Asset Contract's documented balance entry.
 */

const MAX_KEYS = 200;

const symbol = (s: string) => xdr.ScVal.scvSymbol(s);

/** A `#[contracttype]` enum key: unit variants are `[Name]`, tuple variants `[Name, ...fields]`. */
export function variantKey(name: string, ...fields: xdr.ScVal[]): xdr.ScVal {
  return xdr.ScVal.scvVec([symbol(name), ...fields]);
}

export const addressVal = (address: string) => new Address(address).toScVal();

/** A `#[contracttype]` struct value: a map keyed by field name, fields in sorted order. */
export function structVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((name) => new xdr.ScMapEntry({ key: symbol(name), val: fields[name] as xdr.ScVal })),
  );
}

export function dataKey(contract: string, key: xdr.ScVal, temporary = false): xdr.LedgerKey {
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contract).toScAddress(),
      key,
      durability: temporary ? xdr.ContractDataDurability.temporary : xdr.ContractDataDurability.persistent,
    }),
  );
}

export const instanceKey = (contract: string) => dataKey(contract, xdr.ScVal.scvLedgerKeyContractInstance());

interface RawEntry {
  key: string;
  xdr: string;
}

/** One JSON-RPC call to the network's Stellar RPC. */
export async function rpcCall<T>(method: string, params?: unknown): Promise<T> {
  const response = await fetch(endpoints.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC ${method} failed with HTTP ${response.status}`);
  const body: { result?: T; error?: { message: string } } = await response.json();
  if (body.error) throw new Error(body.error.message);
  if (body.result === undefined) throw new Error(`RPC ${method} returned no result`);
  return body.result;
}

async function getLedgerEntries(keys: string[]): Promise<RawEntry[]> {
  const result = await rpcCall<{ entries?: RawEntry[] | null }>("getLedgerEntries", { keys });
  return result.entries ?? [];
}

/**
 * Reads every key in as few requests as possible. Entries that do not exist
 * (a zero balance, an unset reserve) are simply absent from the result.
 */
export async function readEntries(keys: xdr.LedgerKey[]): Promise<Map<string, xdr.ScVal>> {
  const encoded = [...new Set(keys.map((k) => k.toXDR("base64")))];
  const chunks: string[][] = [];
  for (let i = 0; i < encoded.length; i += MAX_KEYS) chunks.push(encoded.slice(i, i + MAX_KEYS));
  const results = await Promise.all(chunks.map(getLedgerEntries));
  const values = new Map<string, xdr.ScVal>();
  for (const entry of results.flat()) {
    const data = xdr.LedgerEntryData.fromXDR(entry.xdr, "base64");
    if (data.type === "contractData") values.set(entry.key, data.contractData.val);
  }
  return values;
}

export const keyId = (key: xdr.LedgerKey) => key.toXDR("base64");

/** Decodes a contract instance's storage into `{ VariantName: native value }`. */
export function instanceStorage(value: xdr.ScVal | undefined): Map<string, unknown> {
  const storage = new Map<string, unknown>();
  if (value?.type !== "scvContractInstance") return storage;
  for (const entry of value.instance.storage ?? []) {
    const key = scValToNative(entry.key);
    const name = Array.isArray(key) ? String(key[0]) : String(key);
    storage.set(name, scValToNative(entry.val));
  }
  return storage;
}

export const native = (value: xdr.ScVal | undefined): unknown => (value ? scValToNative(value) : undefined);

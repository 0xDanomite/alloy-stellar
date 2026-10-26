import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { rpcCall } from "./ledger";

/** Stellar RPC scans at most this many ledgers per getEvents call (about 14 hours). */
const WINDOW = 10_000;

export type ActivityKind =
  | "issue"
  | "redeem"
  | "mint"
  | "burn"
  | "transfer"
  | "rebalance"
  | "investor_set"
  | "compliance_set"
  | "manager_set"
  | "withdraw_owed"
  | "leftover_credited"
  | "nav_set";

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  ledger: number;
  at: Date;
  txHash: string;
  topics: unknown[];
  data: unknown;
}

interface RawEvent {
  id: string;
  ledger: number;
  ledgerClosedAt: string;
  txHash: string;
  topic: string[];
  value: string;
}

const KINDS = new Set<string>([
  "issue",
  "redeem",
  "mint",
  "burn",
  "transfer",
  "rebalance",
  "investor_set",
  "compliance_set",
  "manager_set",
  "withdraw_owed",
  "leftover_credited",
  "nav_set",
]);

const decode = (b64: string): unknown => scValToNative(xdr.ScVal.fromXDR(b64, "base64"));

function parse(raw: RawEvent): ActivityEvent | null {
  const [name, ...topics] = raw.topic.map(decode);
  if (typeof name !== "string" || !KINDS.has(name)) return null;
  return {
    id: raw.id,
    kind: name as ActivityKind,
    ledger: raw.ledger,
    at: new Date(raw.ledgerClosedAt),
    txHash: raw.txHash,
    topics,
    data: decode(raw.value),
  };
}

/** Issue and redeem also emit the token mint and burn; show the fund event alone. */
function dropEchoes(events: ActivityEvent[]): ActivityEvent[] {
  const fundTx = new Set(events.filter((e) => e.kind === "issue" || e.kind === "redeem").map((e) => e.txHash));
  return events.filter((e) => !((e.kind === "mint" || e.kind === "burn") && fundTx.has(e.txHash)));
}

export interface ActivityPage {
  events: ActivityEvent[];
  /** The ledger to scan back from next, or null once the RPC's retention is exhausted. */
  before: number | null;
  oldestLedger: number;
  oldestAt: Date;
}

interface Health {
  latestLedger: number;
  oldestLedger: number;
  oldestLedgerCloseTime?: string;
}

async function scanWindow(contractId: string, start: number, end: number): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 3; page++) {
    const result = await rpcCall<{ events?: RawEvent[]; cursor?: string }>("getEvents", {
      ...(cursor ? {} : { startLedger: start, endLedger: end }),
      filters: [{ type: "contract", contractIds: [contractId] }],
      pagination: cursor ? { cursor, limit: 100 } : { limit: 100 },
    });
    const batch = result.events ?? [];
    events.push(...batch.map(parse).filter((e): e is ActivityEvent => e !== null));
    if (batch.length < 100 || !result.cursor) break;
    cursor = result.cursor;
  }
  return events;
}

/**
 * The fund contract's own events, newest first, scanning back one RPC window
 * at a time until `want` events are found, `maxWindows` windows are read, or
 * the RPC's retention runs out (about seven days on public RPCs).
 */
export async function loadActivity(
  contractId: string,
  options: { before?: number; want?: number; maxWindows?: number } = {},
): Promise<ActivityPage> {
  const { want = 12, maxWindows = 3 } = options;
  const health = await rpcCall<Health>("getHealth");
  const oldest = health.oldestLedger;
  let end = Math.min(options.before ?? health.latestLedger, health.latestLedger);
  const found: ActivityEvent[] = [];
  for (let i = 0; i < maxWindows && end > oldest; i++) {
    const start = Math.max(oldest, end - WINDOW + 1);
    const batch = await scanWindow(contractId, start, end);
    found.push(...batch);
    end = start - 1;
    if (found.length >= want) break;
  }
  return {
    events: dropEchoes(found).sort((a, b) => b.ledger - a.ledger || b.id.localeCompare(a.id)),
    before: end > oldest ? end : null,
    oldestLedger: oldest,
    oldestAt: health.oldestLedgerCloseTime ? new Date(Number(health.oldestLedgerCloseTime) * 1000) : new Date(Date.now() - 7 * 86_400_000),
  };
}

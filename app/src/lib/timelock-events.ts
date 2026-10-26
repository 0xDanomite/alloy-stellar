import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";

export type OperationStatus = "waiting" | "ready" | "done" | "cancelled";

export interface QueuedOperation {
  id: string;
  target: string;
  fnName: string;
  /** The call's arguments as scheduled, kept raw to execute exactly. */
  args: xdr.ScVal[];
  salt: Buffer;
  readyAt: number;
  proposer: string;
  ledger: number;
  txHash: string;
  status: OperationStatus;
}

export interface RawEvent {
  ledger: number;
  txHash: string;
  topic: string[];
  value: string;
}

function mapField(value: xdr.ScVal, name: string): xdr.ScVal | undefined {
  if (value.type !== "scvMap") return undefined;
  return (value.value ?? []).find((e) => scValToNative(e.key) === name)?.val;
}

export function parseScheduled(raw: RawEvent): Omit<QueuedOperation, "status"> | null {
  try {
    const [, idTopic, targetTopic] = raw.topic.map((t) => xdr.ScVal.fromXdr(t, "base64"));
    const value = xdr.ScVal.fromXdr(raw.value, "base64");
    const args = mapField(value, "args");
    const salt = mapField(value, "salt");
    if (!idTopic || !targetTopic || !args || args.type !== "scvVec" || !salt) return null;
    return {
      id: Buffer.from(scValToNative(idTopic) as Uint8Array).toString("hex"),
      target: Address.fromScVal(targetTopic).toString(),
      fnName: String(scValToNative(mapField(value, "fn_name") ?? xdr.ScVal.scvVoid())),
      args: args.value ?? [],
      salt: Buffer.from(scValToNative(salt) as Uint8Array),
      readyAt: Number(scValToNative(mapField(value, "ready_at") ?? xdr.ScVal.scvVoid())),
      proposer: String(scValToNative(mapField(value, "proposer") ?? xdr.ScVal.scvVoid())),
      ledger: raw.ledger,
      txHash: raw.txHash,
    };
  } catch {
    return null;
  }
}

/** A scheduled call in plain words, from its target and decoded arguments. */
export function describeOperation(op: Pick<QueuedOperation, "fnName" | "args">, names: Record<string, string> = {}): string {
  const values = op.args.map((a) => {
    try {
      const v = scValToNative(a);
      if (Array.isArray(v)) return String(v[0]);
      if (typeof v === "string" && names[v]) return names[v];
      return typeof v === "string" && v.length > 20 ? `${v.slice(0, 4)}…${v.slice(-4)}` : String(v);
    } catch {
      return "?";
    }
  });
  switch (op.fnName) {
    case "set_manager":
      return `${values[1] === "true" ? "Approve" : "Remove"} manager ${values[0]}`;
    case "set_shelf_asset":
      return `Set ${values[0]} to ${values[1]} on the shelf`;
    case "set_nav":
      return `Point the fund's oracle at ${values[0]}`;
    case "set_router":
      return `Point the fund's router at ${values[0]}`;
    case "set_platform_fee":
      return `Platform takes ${Number(values[0]) / 100}% of the fee, paid to ${values[1]}`;
    case "set_delay":
      return `Change the delay to ${values[0]} seconds`;
    default:
      return `${op.fnName}(${values.join(", ")})`;
  }
}

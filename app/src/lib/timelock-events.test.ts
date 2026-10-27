import { describe, expect, it } from "vitest";
import { Address, Keypair, nativeToScVal, StrKey, xdr } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { describeOperation, operationAddresses, parseScheduled, type RawEvent } from "./timelock-events";

const PLATFORM = StrKey.encodeContract(Keypair.random().rawPublicKey());
const MANAGER = Keypair.random().publicKey();
const PROPOSER = Keypair.random().publicKey();
const ID = Buffer.alloc(32, 7);
const SALT = Buffer.alloc(32, 9);

function scheduledEvent(fnName: string, args: xdr.ScVal[]): RawEvent {
  const entry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });
  const value = xdr.ScVal.scvMap([
    entry("args", xdr.ScVal.scvVec(args)),
    entry("fn_name", xdr.ScVal.scvSymbol(fnName)),
    entry("proposer", new Address(PROPOSER).toScVal()),
    entry("ready_at", nativeToScVal(1_761_500_000n, { type: "u64" })),
    entry("salt", xdr.ScVal.scvBytes(SALT)),
  ]);
  return {
    ledger: 62_000_000,
    txHash: "ab".repeat(32),
    topic: [xdr.ScVal.scvSymbol("scheduled"), xdr.ScVal.scvBytes(ID), new Address(PLATFORM).toScVal()].map((t) => t.toXdr("base64")),
    value: value.toXdr("base64"),
  };
}

describe("timelock events", () => {
  it("reads a scheduled call with its raw arguments and salt", () => {
    const args = [new Address(MANAGER).toScVal(), xdr.ScVal.scvBool(true)];
    const op = parseScheduled(scheduledEvent("set_manager", args));
    expect(op).not.toBeNull();
    expect(op?.id).toBe(ID.toString("hex"));
    expect(op?.target).toBe(PLATFORM);
    expect(op?.fnName).toBe("set_manager");
    expect(op?.args.map((a) => a.toXdr("base64"))).toEqual(args.map((a) => a.toXdr("base64")));
    expect(op?.salt.equals(SALT)).toBe(true);
    expect(op?.readyAt).toBe(1_761_500_000);
    expect(op?.proposer).toBe(PROPOSER);
  });

  it("drops events that aren't a scheduled call", () => {
    expect(parseScheduled({ ledger: 1, txHash: "", topic: [], value: xdr.ScVal.scvVoid().toXdr("base64") })).toBeNull();
  });

  it("describes calls in plain words", () => {
    const describe = (fnName: string, args: xdr.ScVal[]) => describeOperation({ fnName, args });
    expect(describe("set_manager", [new Address(MANAGER).toScVal(), xdr.ScVal.scvBool(false)])).toMatch(/^Remove manager G/);
    expect(describe("set_shelf_asset", [new Address(PLATFORM).toScVal(), xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Permissioned")])])).toMatch(/to Permissioned on the shelf$/);
    expect(describe("set_platform_fee", [nativeToScVal(2500, { type: "u32" }), new Address(MANAGER).toScVal()])).toMatch(/^Platform takes 25% of the fee/);
  });

  it("shows enough of an address to tell lookalikes apart, and lists every address in full", () => {
    const args = [new Address(MANAGER).toScVal(), xdr.ScVal.scvBool(true)];
    expect(describeOperation({ fnName: "set_manager", args })).toBe(`Approve manager ${MANAGER.slice(0, 8)}…${MANAGER.slice(-8)}`);
    expect(operationAddresses({ args })).toEqual([MANAGER]);
    expect(operationAddresses({ args: [nativeToScVal(2500, { type: "u32" })] })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { Address, Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { decodeHandover, encodeHandover, handoverIncoming, HANDOVER_LEDGERS, verifyHandover, type HandoverLink } from "./handover";

const account = () => Keypair.random().publicKey();
const contractId = () => StrKey.encodeContract(Keypair.random().rawPublicKey());

const FUND = contractId();
const MANAGER = account();
const INCOMING = account();
const LATEST = 1_000_000;

function entry({
  fund = FUND,
  fn = "set_manager",
  args = [new Address(INCOMING).toScVal()],
  signer = MANAGER,
  expiry = LATEST + 100,
  sub = [] as xdr.SorobanAuthorizedInvocation[],
} = {}): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signer).toScAddress(),
        nonce: 7n,
        signatureExpirationLedger: expiry,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({ contractAddress: new Address(fund).toScAddress(), functionName: fn, args }),
      ),
      subInvocations: sub,
    }),
  });
}

const link = (...entries: xdr.SorobanAuthorizationEntry[]): HandoverLink => ({ entries: entries.map((e) => e.toXdr("base64")) });
const check = (l: HandoverLink) => verifyHandover(l, { fund: FUND, manager: MANAGER, incoming: INCOMING, latestLedger: LATEST });
const errorOf = (l: HandoverLink) => {
  const result = check(l);
  return "error" in result ? result.error : null;
};

describe("verifyHandover", () => {
  it("accepts the outgoing manager's approval of exactly this handover", () => {
    const result = check(link(entry()));
    expect("entry" in result).toBe(true);
  });

  it("round-trips through the link encoding", () => {
    const decoded = decodeHandover(encodeHandover(entry()));
    expect(decoded).not.toBeNull();
    expect(handoverIncoming(decoded ?? { entries: [] })).toBe(INCOMING);
    expect(errorOf(decoded ?? { entries: [] })).toBeNull();
  });

  it("refuses an approval for another contract", () => {
    expect(errorOf(link(entry({ fund: contractId() })))).toMatch(/different fund/);
  });

  it("refuses an approval for another function", () => {
    expect(errorOf(link(entry({ fn: "transfer" })))).toMatch(/something other than a handover/);
  });

  it("refuses an approval naming another new manager", () => {
    expect(errorOf(link(entry({ args: [new Address(account()).toScVal()] })))).toMatch(/different new manager/);
    expect(errorOf(link(entry({ args: [new Address(INCOMING).toScVal(), xdr.ScVal.scvBool(true)] })))).toMatch(/different new manager/);
  });

  it("refuses an approval signed by anyone but the current manager", () => {
    expect(errorOf(link(entry({ signer: account() })))).toMatch(/current manager/);
  });

  it("refuses extra approvals and nested calls", () => {
    expect(errorOf(link(entry(), entry()))).toMatch(/exactly one/);
    expect(errorOf({ entries: [] })).toMatch(/exactly one/);
    const nested = entry().rootInvocation;
    expect(errorOf(link(entry({ sub: [nested] })))).toMatch(/more than the handover/);
  });

  it("refuses expired and overlong approvals", () => {
    expect(errorOf(link(entry({ expiry: LATEST })))).toMatch(/expired/);
    expect(errorOf(link(entry({ expiry: LATEST + HANDOVER_LEDGERS * 10 })))).toMatch(/longer than/);
  });

  it("refuses damaged links", () => {
    expect(errorOf({ entries: ["not xdr"] })).toMatch(/damaged/);
    expect(decodeHandover("%%%")).toBeNull();
  });
});

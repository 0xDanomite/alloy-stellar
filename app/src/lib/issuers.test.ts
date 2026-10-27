import { describe, expect, it } from "vitest";
import { Asset, Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { CIRCLE_USDC_ISSUER, isAssetContract } from "./issuers";

const USDC = new Asset("USDC", CIRCLE_USDC_ISSUER);
const MAINNET_USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

describe("isAssetContract", () => {
  it("accepts the asset's own contract", () => {
    expect(isAssetContract(USDC, MAINNET_USDC_SAC, Networks.PUBLIC)).toBe(true);
    expect(isAssetContract(Asset.native(), Asset.native().contractId(Networks.PUBLIC), Networks.PUBLIC)).toBe(true);
  });

  it("rejects a contract that only names the asset", () => {
    const impostor = StrKey.encodeContract(Keypair.random().rawPublicKey());
    expect(isAssetContract(USDC, impostor, Networks.PUBLIC)).toBe(false);
  });

  it("rejects the same asset's contract from another network", () => {
    expect(isAssetContract(USDC, MAINNET_USDC_SAC, Networks.TESTNET)).toBe(false);
  });
});

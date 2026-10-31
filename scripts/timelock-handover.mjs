// Hands a v0.4 platform's admin to its timelock: schedules set_admin(timelock)
// on the timelock, waits out the delay, then executes it. The current admin
// signs both transactions; its secret is read from the local stellar keystore
// and never printed.
//
//   node scripts/timelock-handover.mjs [deployments/mainnet-v4.json] [admin identity]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("./package.json", import.meta.url));
const { Address, Contract, Keypair, TransactionBuilder, nativeToScVal, rpc, xdr } = require("@stellar/stellar-sdk");

const file = process.argv[2] ?? "deployments/mainnet-v4.json";
const identity = process.argv[3] ?? "alloy-main-admin";
const deployments = JSON.parse(readFileSync(file, "utf8"));
const { platform, timelock } = deployments.contracts;
const passphrase = "Public Global Stellar Network ; September 2015";
const server = new rpc.Server(process.env.MAINNET_RPC_URL ?? "https://rpc.lightsail.network");
const signer = Keypair.fromSecret(execFileSync("stellar", ["keys", "show", identity], { encoding: "utf8" }).trim());
const admin = signer.publicKey();

const args = xdr.ScVal.scvVec([new Address(timelock).toScVal()]);
const salt = randomBytes(32);
const operation = [
  new Address(platform).toScVal(),
  nativeToScVal("set_admin", { type: "symbol" }),
  args,
  nativeToScVal(salt),
];

async function call(fn, params) {
  const account = await server.getAccount(admin);
  const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase: passphrase })
    .addOperation(new Contract(timelock).call(fn, ...params))
    .setTimeout(180)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") throw new Error(`${fn} rejected: ${sent.errorResult?.toXDR("base64")}`);
  let result = await server.getTransaction(sent.hash);
  while (result.status === "NOT_FOUND") {
    await new Promise((r) => setTimeout(r, 2000));
    result = await server.getTransaction(sent.hash);
  }
  if (result.status !== "SUCCESS") throw new Error(`${fn} failed: ${sent.hash}`);
  console.log(`${fn}: https://stellar.expert/explorer/public/tx/${sent.hash}`);
}

const delaySecs = 300;
await call("schedule", [new Address(admin).toScVal(), ...operation]);
console.log(`waiting ${delaySecs + 10} s for the timelock delay`);
await new Promise((r) => setTimeout(r, (delaySecs + 10) * 1000));
await call("execute", [new Address(admin).toScVal(), ...operation]);
console.log(`platform ${platform} admin is now the timelock ${timelock}`);

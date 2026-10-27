// Writes a ledger snapshot of everything a USDC zap into and out of a
// mainnet fund touches, for the fork test in contracts/zap/src/test_mainnet.rs:
//
//   node scripts/zap-snapshot.mjs zap-mainnet.json [fund] [platform]
//
// It simulates the platform's `is_fund` for the fund, the fund's quotes, a Soroswap swap each way for every
// non-USDC leg (with the fund itself as the trader, since it holds every
// leg) and a transfer of each leg to a fresh contract address, then fetches
// exactly the entries in those footprints. Nothing is signed or sent.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(fileURLToPath(new URL("../app/package.json", import.meta.url)));
const { rpc, Contract, TransactionBuilder, Account, xdr, Address, Networks, nativeToScVal, scValToNative, StrKey } =
  require("@stellar/stellar-sdk");

const out = process.argv[2] ?? "zap-mainnet.json";
const FUND = process.argv[3] ?? "CC5QR5OOQMCPVSL3SJMH7QESCFINWUMX3427CT4NIDBS3FRVDHAM4NAJ";
const PLATFORM = process.argv[4] ?? "CDL3FYEGDRYQP2MOW7Z4UBGUQLEHJ6VBPBLGE3YJ5ITVDB5CMKY7CJ7R";
const ROUTER = "CAG5LRYQ5JVEUI5TEID72EYOVX44TTUJT5BQR2J6J77FH65PCCFAJDDH";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
const server = new rpc.Server(process.env.MAINNET_RPC_URL ?? "https://mainnet.sorobanrpc.com");
const source = new Account("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7", "0");
const fresh = StrKey.encodeContract(Buffer.alloc(32, 7));

const addr = (a) => new Address(a).toScVal();
const i128 = (n) => nativeToScVal(BigInt(n), { type: "i128" });
const u64 = (n) => nativeToScVal(BigInt(n), { type: "u64" });
const path = (...ids) => xdr.ScVal.scvVec(ids.map(addr));

const keys = new Map();
async function simulate(id, fn, ...args) {
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(id).call(fn, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`${id} ${fn}: ${sim.error}`);
  for (const k of [...sim.transactionData.getReadOnly(), ...sim.transactionData.getReadWrite()]) {
    keys.set(k.toXDR("base64"), k);
  }
  return sim.result ? scValToNative(sim.result.retval) : undefined;
}

if (!(await simulate(PLATFORM, "is_fund", addr(FUND)))) throw new Error(`${FUND} is not a fund of ${PLATFORM}`);
const components = await simulate(FUND, "components");
const tokens = components.map((c) => c.token);
const holdings = await simulate(FUND, "holdings");
for (const fn of ["quote_issue", "quote_redeem"]) await simulate(FUND, fn, i128(10_000_000));
for (const fn of ["is_open", "compliance", "manager", "total_supply"]) await simulate(FUND, fn);

const deadline = u64(Math.floor(Date.now() / 1000) + 3600);
for (const [i, token] of tokens.entries()) {
  await simulate(token, "transfer", addr(FUND), addr(fresh), i128(1));
  if (token === USDC) continue;
  const usdcHeld = holdings[tokens.indexOf(USDC)] ?? 0n;
  await simulate(ROUTER, "router_get_amounts_in", i128(1_000), path(USDC, token));
  await simulate(ROUTER, "router_get_amounts_out", i128(1_000), path(token, USDC));
  if (holdings[i] >= 1000n) {
    await simulate(ROUTER, "swap_exact_tokens_for_tokens", i128(holdings[i] / 1000n), i128(0), path(token, USDC), addr(FUND), deadline);
  }
  if (usdcHeld >= 1000n) {
    await simulate(ROUTER, "swap_exact_tokens_for_tokens", i128(usdcHeld / 1000n), i128(0), path(USDC, token), addr(FUND), deadline);
  }
}

const latest = await server.getLatestLedger();
const entries = [];
const list = [...keys.values()];
for (let i = 0; i < list.length; i += 100) {
  const res = await server.getLedgerEntries(...list.slice(i, i + 100));
  for (const e of res.entries) {
    const entry = new xdr.LedgerEntry({ lastModifiedLedgerSeq: e.lastModifiedLedgerSeq, data: e.val, ext: xdr.LedgerEntryExt.v0() });
    const json = JSON.parse(execFileSync("stellar", ["xdr", "decode", "--type", "LedgerEntry", "--output", "json"], { input: entry.toXDR("base64") }).toString());
    entries.push({ entry: json, live_until: e.liveUntilLedgerSeq ?? null });
  }
}
const ledgers = await server.getLedgers({ startLedger: latest.sequence, pagination: { limit: 1 } });
const timestamp = Number(ledgers.ledgers[0].ledgerCloseTime);
writeFileSync(out, JSON.stringify({
  protocol_version: latest.protocolVersion, sequence_number: latest.sequence, timestamp,
  network_id: "7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979",
  base_reserve: 5000000, min_persistent_entry_ttl: 2073600, min_temp_entry_ttl: 17280, max_entry_ttl: 3110400,
  ledger_entries: entries,
}));
console.log(`fund ${FUND} legs ${tokens.length} keys ${keys.size} entries ${entries.length} ledger ${latest.sequence} ts ${timestamp}`);

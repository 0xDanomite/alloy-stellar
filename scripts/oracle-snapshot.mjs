// Writes a ledger snapshot of the mainnet oracle state the nav contract
// reads, for the fork test in contracts/nav/src/test_mainnet.rs:
//
//   node scripts/oracle-snapshot.mjs mainnet.json
//
// It simulates every oracle and token read over RPC, fetches exactly the
// entries in those footprints and converts them with `stellar xdr decode`.
// `stellar snapshot create` gives the same result from history archives,
// but downloads gigabytes to get there.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const require = createRequire(fileURLToPath(new URL("./package.json", import.meta.url)));
const { rpc, Contract, TransactionBuilder, Account, xdr, Address, Networks } = require("@stellar/stellar-sdk");
const out = process.argv[2] ?? "mainnet.json";
const server = new rpc.Server("https://mainnet.sorobanrpc.com");
const RS = "CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF";
const RF = "CALI2BYU2JE6WVRUFYTS6MSBNEHGJ35P4AVCZYF3B6QOE3QKOB2PLE6M";
const BENJI_FEED = "CCDM2U5E3SBMPJUQCBIER4BSFAVSJTY5I5EQEZIRDZSA3YOJH3YM4TW5";
const SACS = ["CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA","CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75","CB3YA656OYIHU57657I5KGSBRHE5I3OZU4VFC22PYAOANFZHEWNYGAGP","CBLV4ATSIWU67CFSQU2NVRKINQIKUZ2ODSZBUJTJ43VJVRSBTZYOPNUR","CAL6ER2TI6CTRAY6BFXWNWA7WTYXUXTQCHUBCIBU5O6KM3HJFG6Z6VXV","CCDSDPD7FXB74PFB2SYCHGQRWLXQRYRTQSPCVSRJ7FAOLOUGWEYAXQ7A"];
const asset = (c) => xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), new Address(c).toScVal()]);
const calls = [];
for (const o of [RS, RF]) { calls.push([o, "decimals"]); for (const s of SACS) calls.push([o, "lastprice", asset(s)]); }
calls.push([BENJI_FEED, "read_price_data"], [BENJI_FEED, "decimals"]);
for (const s of SACS) calls.push([s, "decimals"]);
const source = new Account("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7", "0");
const keys = new Map();
for (const [id, fn, ...args] of calls) {
  const tx = new TransactionBuilder(source, { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(new Contract(id).call(fn, ...args)).setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) { console.error(id, fn, sim.error); continue; }
  for (const k of [...sim.transactionData.getReadOnly(), ...sim.transactionData.getReadWrite()]) keys.set(k.toXDR("base64"), k);
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
console.log(`keys ${keys.size} entries ${entries.length} ledger ${latest.sequence} ts ${timestamp} proto ${latest.protocolVersion}`);

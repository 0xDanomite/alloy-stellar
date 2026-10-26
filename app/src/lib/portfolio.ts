import { addressVal, dataKey, keyId, native, readEntries, structVal, variantKey } from "./ledger";
import { buildPortfolio, type Portfolio } from "./portfolio-model";
import { listFunds } from "./stellar";

const balanceKey = (fund: string, holder: string) => dataKey(fund, variantKey("Balance", addressVal(holder)));
const investorKey = (fund: string, holder: string) => dataKey(fund, variantKey("Investor", addressVal(holder)));
const owedKey = (fund: string, holder: string, token: string) =>
  dataKey(fund, variantKey("Owed", structVal({ owner: addressVal(holder), token: addressVal(token) })));

const asBigInt = (value: unknown): bigint => (typeof value === "bigint" ? value : 0n);

/**
 * Everything the connected address has across the platform, in one batched
 * ledger read: its share balance, owed claims and allowlist entry in every
 * registered fund. Fund state itself comes from the shared fund list.
 */
async function loadPortfolio(address: string): Promise<Portfolio> {
  const funds = await listFunds();
  const entries = await readEntries(
    funds.flatMap((fund) => [
      balanceKey(fund.id, address),
      ...(fund.compliance === "Allowlist" ? [investorKey(fund.id, address)] : []),
      ...fund.components.map((leg) => owedKey(fund.id, address, leg.token)),
    ]),
  );
  const read = (key: Parameters<typeof keyId>[0]) => native(entries.get(keyId(key)));
  return buildPortfolio(address, funds, {
    shares: (fundId) => asBigInt(read(balanceKey(fundId, address))),
    onAllowlist: (fundId) => read(investorKey(fundId, address)) === true,
    owed: (fundId, token) => asBigInt(read(owedKey(fundId, address, token))),
  });
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; value: Promise<Portfolio> }>();

/** Shared by the header bell and the portfolio page, so both cost one read. */
export function portfolio(address: string, fresh = false): Promise<Portfolio> {
  const hit = cache.get(address);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = loadPortfolio(address);
  cache.set(address, { at: Date.now(), value });
  value.catch(() => cache.delete(address));
  return value;
}

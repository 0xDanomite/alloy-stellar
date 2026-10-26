import { type Asset, xdr } from "@stellar/stellar-sdk";
import { REFLECTOR_ORACLE } from "./config";
import { dataKey, instanceKey, instanceStorage, keyId, native, readEntries } from "./ledger";
import { unitsToNumber } from "./format";
import { legPrice } from "./fund-math";
import { medianOf3, modelSeries, reflectorPrice, timeGrid, type LegHistory, type PricePoint } from "./series";
import { horizon, QUOTE_USDC, type Fund, type FundComponent } from "./stellar";

export type Range = "1D" | "1W" | "1M" | "3M";

export const RANGES: Record<Range, { seconds: number; steps: number; sdexResolutionMs: number }> = {
  "1D": { seconds: 86_400, steps: 96, sdexResolutionMs: 900_000 },
  "1W": { seconds: 7 * 86_400, steps: 168, sdexResolutionMs: 3_600_000 },
  "1M": { seconds: 30 * 86_400, steps: 60, sdexResolutionMs: 86_400_000 },
  "3M": { seconds: 90 * 86_400, steps: 90, sdexResolutionMs: 86_400_000 },
};

/** Where a leg's price history came from: the Reflector oracle, Stellar DEX trades, the quote asset itself, or nowhere. */
export type HistorySource = "reflector" | "sdex" | "quote" | "none";

export interface AssetHistory {
  points: PricePoint[];
  source: HistorySource;
}

const TTL_MS = 150_000;
const cache = new Map<string, { at: number; value: Promise<unknown> }>();

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key));
  return value;
}

const REFLECTOR_RESOLUTION_MS = 300_000;
const REFLECTOR_STEP_MS = 900_000;
const REFLECTOR_SCALE = 1e14;
const CONTRACT_ID = /^C[A-Z2-7]{55}$/;

/**
 * Reflector keeps each five-minute round as one temporary ledger entry keyed
 * by its timestamp in milliseconds, holding every asset's price at once. So a
 * day of history for all assets is one `getLedgerEntries` call: the oracle's
 * instance (asset indexes, decimals) plus one key per sampled round.
 */
async function loadReflectorDay(oracle: string): Promise<Map<string, PricePoint[]>> {
  const now = Date.now();
  const newest = Math.floor(now / REFLECTOR_RESOLUTION_MS) * REFLECTOR_RESOLUTION_MS;
  const stamps = new Set<number>([newest, newest - REFLECTOR_RESOLUTION_MS]);
  const aligned = Math.floor(now / REFLECTOR_STEP_MS) * REFLECTOR_STEP_MS;
  for (let t = aligned; t >= now - 86_400_000 - REFLECTOR_STEP_MS; t -= REFLECTOR_STEP_MS) stamps.add(t);

  const roundKey = (ms: number) => dataKey(oracle, xdr.ScVal.scvU64(BigInt(ms)), true);
  const entries = await readEntries([instanceKey(oracle), ...[...stamps].map(roundKey)]);
  const storage = instanceStorage(entries.get(keyId(instanceKey(oracle))));
  const decimals = Number(storage.get("decimals") ?? 14);
  const scale = decimals === 14 ? REFLECTOR_SCALE : 10 ** decimals;
  const indexes = [...storage].filter(
    (entry): entry is [string, number] => CONTRACT_ID.test(entry[0]) && typeof entry[1] === "number",
  );

  const history = new Map<string, PricePoint[]>(indexes.map(([token]) => [token, []]));
  for (const ms of [...stamps].sort((a, b) => a - b)) {
    const round = native(entries.get(keyId(roundKey(ms)))) as { mask?: Uint8Array; prices?: bigint[] } | undefined;
    if (!round?.mask || !round.prices) continue;
    for (const [token, index] of indexes) {
      const raw = reflectorPrice(round.mask, round.prices, index);
      if (raw !== null && raw > 0n) history.get(token)?.push({ t: ms / 1000, price: Number(raw) / scale });
    }
  }
  return history;
}

const assetKey = (asset: Asset) => (asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`);

/**
 * Closing prices in USDC from Stellar DEX trades, newest buckets first so a
 * thinly traded asset still gets its last trade before the range began, then
 * smoothed over three buckets.
 */
async function loadSdex(asset: Asset, range: Range): Promise<PricePoint[]> {
  if (!QUOTE_USDC) return [];
  const { seconds, sdexResolutionMs } = RANGES[range];
  const end = Math.ceil(Date.now() / sdexResolutionMs) * sdexResolutionMs;
  const start = Math.floor((end - seconds * 2000) / sdexResolutionMs) * sdexResolutionMs;
  const page = await horizon
    .tradeAggregation(asset, QUOTE_USDC, start, end, sdexResolutionMs, 0)
    .order("desc")
    .limit(200)
    .call();
  const closes = page.records
    .map((r) => ({ t: Number(r.timestamp) / 1000, price: Number(r.close) }))
    .filter((p) => Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.t - b.t);
  return medianOf3(closes);
}

function reflectorDay(): Promise<Map<string, PricePoint[]>> {
  if (!REFLECTOR_ORACLE) return Promise.resolve(new Map());
  const oracle = REFLECTOR_ORACLE;
  return cached(`reflector:${oracle}`, () => loadReflectorDay(oracle)).catch(() => new Map());
}

function sdex(asset: Asset, range: Range): Promise<PricePoint[]> {
  return cached(`sdex:${range}:${assetKey(asset)}`, () => loadSdex(asset, range)).catch(() => []);
}

/**
 * Price history for each leg over `range`, in USDC. The day view reads the
 * Reflector oracle (its history lives about a day); longer ranges, and legs
 * Reflector does not price, fall back to Stellar DEX trades.
 */
export async function loadHistories(
  legs: readonly Pick<FundComponent, "token" | "asset">[],
  range: Range,
): Promise<Map<string, AssetHistory>> {
  const day = range === "1D" ? await reflectorDay() : new Map<string, PricePoint[]>();
  const results = await Promise.all(
    legs.map(async (leg): Promise<[string, AssetHistory]> => {
      const oracle = day.get(leg.token);
      if (oracle && oracle.length >= 2) return [leg.token, { points: oracle, source: "reflector" }];
      if (QUOTE_USDC && leg.asset.equals(QUOTE_USDC)) return [leg.token, { points: [], source: "quote" }];
      const trades = await sdex(leg.asset, range);
      return [leg.token, trades.length ? { points: trades, source: "sdex" } : { points: [], source: "none" }];
    }),
  );
  return new Map(results);
}

/** Each leg's units per share and history, held at today's price where there is none. */
export function legHistories(fund: Fund, histories: Map<string, AssetHistory>): LegHistory[] {
  return fund.components.map((leg) => {
    const history = histories.get(leg.token);
    return {
      units: unitsToNumber(leg.unitsPerShare),
      points: history?.points ?? [],
      fallback: history?.source === "quote" ? 1 : (legPrice(fund, leg) ?? leg.priceUsdc),
    };
  });
}

/** The modeled per-share series over `range`, ending now. */
export function fundSeries(fund: Fund, histories: Map<string, AssetHistory>, range: Range, now = Date.now() / 1000) {
  const { seconds, steps } = RANGES[range];
  return modelSeries(legHistories(fund, histories), timeGrid(now - seconds, now, steps));
}

/** True when at least one leg moves: a series of only held prices is a flat line, not history. */
export function hasHistory(fund: Fund, histories: Map<string, AssetHistory>): boolean {
  return fund.components.some((leg) => {
    const source = histories.get(leg.token)?.source;
    return source === "reflector" || source === "sdex";
  });
}

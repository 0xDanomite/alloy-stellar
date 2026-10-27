import { unitsToNumber } from "./format";
import type { Compliance, Fund, FundMetadata, Mandate } from "./stellar";
import { evenPercents } from "./weights";

const MAX_NAME = 48;
const MAX_SYMBOL = 12;
const COPY_SUFFIX = " (copy)";
const HUNDREDTHS = 10_000;

/** What the create ceremony starts from when it copies an existing fund. */
export interface FundTemplate {
  name: string;
  symbol: string;
  access: Compliance;
  metadata: Required<FundMetadata>;
  mandate: Mandate;
  tokens: string[];
  percents: Record<string, string>;
  fee: string;
  /** How the weights were set: each leg's oracle value, its market value where an oracle is missing, or evenly. */
  weightedBy: "oracle" | "market" | "even";
  /** Codes of the source fund's assets that the creation shelf doesn't list, left out of the copy. */
  dropped: string[];
}

/**
 * Percentages, in hundredths, proportional to `values` and adding to exactly
 * 100. Every leg keeps at least 0.01%; the remainder goes to the legs that
 * rounding shorted most. Null when any value is missing or nothing has value.
 */
export function percentsByValue(values: readonly (number | null)[]): number[] | null {
  if (!values.length || values.some((v) => v === null || !Number.isFinite(v) || v < 0)) return null;
  const amounts = values as number[];
  const total = amounts.reduce((sum, v) => sum + v, 0);
  if (!(total > 0)) return null;

  const exact = amounts.map((v) => (v / total) * HUNDREDTHS);
  const parts = exact.map((x) => Math.max(1, Math.floor(x)));
  let left = HUNDREDTHS - parts.reduce((sum, p) => sum + p, 0);
  const byShortfall = exact.map((x, i) => ({ i, short: x - (parts[i] ?? 0) })).sort((a, b) => b.short - a.short);
  for (let k = 0; left > 0; k = (k + 1) % byShortfall.length, left--) {
    const slot = byShortfall[k];
    if (slot) parts[slot.i] = (parts[slot.i] ?? 0) + 1;
  }
  while (left < 0) {
    const largest = parts.indexOf(Math.max(...parts));
    parts[largest] = (parts[largest] ?? 0) - 1;
    left++;
  }
  return parts.map((p) => p / 100);
}

function copyName(name: string): string {
  return `${name.slice(0, MAX_NAME - COPY_SUFFIX.length).trimEnd()}${COPY_SUFFIX}`;
}

/** The source symbol with a 2 on the end, so the copy starts distinct; the creator can change it. */
function copySymbol(symbol: string): string {
  const base = symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, MAX_SYMBOL - 1);
  return `${base || "a"}2`;
}

/**
 * A create-ceremony draft copied from `fund`: same assets the shelf still
 * lists, weighted by what each is worth in one share today, the same access,
 * mandate, fee and profile. Nothing here signs or sends anything.
 */
export function templateFrom(fund: Fund, shelfTokens: ReadonlySet<string>): FundTemplate {
  const kept = fund.components.filter((leg) => shelfTokens.has(leg.token));
  const value = (price: number | null | undefined, units: bigint) => (price == null ? null : unitsToNumber(units) * price);

  const byOracle = percentsByValue(kept.map((leg) => value(leg.oracle?.priceUsd, leg.unitsPerShare)));
  const byMarket = byOracle
    ? null
    : percentsByValue(kept.map((leg) => value(leg.oracle?.priceUsd ?? leg.priceUsdc, leg.unitsPerShare)));
  const percents = byOracle ?? byMarket ?? evenPercents(kept.length);

  return {
    name: copyName(fund.name),
    symbol: copySymbol(fund.symbol),
    access: fund.compliance,
    metadata: {
      description: fund.metadata.description ?? "",
      strategy: fund.metadata.strategy ?? "",
      website: fund.metadata.website ?? "",
    },
    mandate: fund.setup?.mandate ?? "Locked",
    tokens: kept.map((leg) => leg.token),
    percents: Object.fromEntries(kept.map((leg, i) => [leg.token, String(percents[i] ?? 0)])),
    fee: String((fund.setup?.fee?.rateBps ?? 0) / 100),
    weightedBy: byOracle ? "oracle" : byMarket ? "market" : "even",
    dropped: fund.components.filter((leg) => !shelfTokens.has(leg.token)).map((leg) => leg.code),
  };
}

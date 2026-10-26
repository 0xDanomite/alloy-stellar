/** The zap accepts at most 1% worse than quoted, in either direction. */
export const ZAP_SLIPPAGE_BPS = 100n;

const BPS = 10_000n;

/** The most USDC an issue may spend for a quote of `quoted`, rounded up. */
export function maxIn(quoted: bigint, bps = ZAP_SLIPPAGE_BPS): bigint {
  return (quoted * (BPS + bps) + BPS - 1n) / BPS;
}

/** The least USDC a redemption may pay for a quote of `quoted`, rounded down. */
export function minOut(quoted: bigint, bps = ZAP_SLIPPAGE_BPS): bigint {
  return (quoted * (BPS - bps)) / BPS;
}

/** A leg whose Soroswap quote is more than this far from its oracle value is too thin to zap. */
export const DEPTH_TOLERANCE_BPS = 300;

export interface LegDepth {
  /** The leg's oracle value in USDC base units, or null with no price to compare. */
  fair: bigint | null;
  /** How much worse than the oracle value the quote is, in basis points; negative is better. */
  worseBps: number | null;
  thin: boolean;
}

/**
 * Compares one leg's Soroswap quote with its oracle value. Issuing, the
 * quote is the USDC it costs to buy `amount`, worse when higher; redeeming,
 * it is the USDC selling `amount` pays, worse when lower. A leg with no
 * price can't be judged and passes.
 */
export function legDepth(
  quoted: bigint,
  amount: bigint,
  priceUsd: number | null,
  direction: "issue" | "redeem",
  toleranceBps = DEPTH_TOLERANCE_BPS,
): LegDepth {
  if (priceUsd === null || !(priceUsd > 0) || amount <= 0n) return { fair: null, worseBps: null, thin: false };
  const fair = Number(amount) * priceUsd;
  if (!(fair >= 1)) return { fair: null, worseBps: null, thin: false };
  const gap = direction === "issue" ? Number(quoted) - fair : fair - Number(quoted);
  const worseBps = Math.round((gap / fair) * 10_000);
  return { fair: BigInt(Math.round(fair)), worseBps, thin: quoted <= 0n || worseBps > toleranceBps };
}

/** Soroswap pairs are unordered: one key per token pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * The Soroswap route from USDC to `token`: direct when a USDC pair exists,
 * otherwise through XLM when both of those pairs exist, else null.
 */
export function routeFromUsdc(token: string, usdc: string, xlm: string, pairs: ReadonlySet<string>): string[] | null {
  if (pairs.has(pairKey(usdc, token))) return [usdc, token];
  if (token !== xlm && pairs.has(pairKey(usdc, xlm)) && pairs.has(pairKey(xlm, token))) return [usdc, xlm, token];
  return null;
}

/** The pairs `routeFromUsdc` may look at for these tokens. */
export function candidatePairs(tokens: readonly string[], usdc: string, xlm: string): [string, string][] {
  const pairs = new Map<string, [string, string]>();
  const add = (a: string, b: string) => pairs.set(pairKey(a, b), [a, b]);
  for (const token of tokens) {
    if (token === usdc) continue;
    add(usdc, token);
    if (token !== xlm) {
      add(usdc, xlm);
      add(xlm, token);
    }
  }
  return [...pairs.values()];
}

export interface LegRoute {
  token: string;
  /** USDC to the leg, or null when Soroswap has no route. */
  path: string[] | null;
}

/**
 * One route per non-USDC component, in component order, as the zap takes
 * them: from USDC for `issue_with_usdc`, reversed for `redeem_to_usdc`.
 * Null when any leg has no route.
 */
export function zapPaths(legs: readonly LegRoute[], usdc: string, direction: "issue" | "redeem"): string[][] | null {
  const paths: string[][] = [];
  for (const leg of legs) {
    if (leg.token === usdc) continue;
    if (!leg.path) return null;
    paths.push(direction === "issue" ? [...leg.path] : [...leg.path].reverse());
  }
  return paths;
}

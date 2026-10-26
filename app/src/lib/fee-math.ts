import { ONE } from "./format";

export const MAX_FEE_BPS = 500;
const BPS = 10_000n;
export const YEAR_SECONDS = 365 * 24 * 60 * 60;

/** "0.75%" from 75 bps; whole percents drop the decimals. */
export function formatBps(bps: number): string {
  const pct = bps / 100;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2).replace(/0$/, "")}%`;
}

/** Bps from a percent typed by a person: "1", "0.5", "1.25". Null outside 0 to 5%. */
export function percentToBps(input: string): number | null {
  const value = input.trim();
  if (!/^\d+(\.\d{0,2})?$/.test(value)) return null;
  const bps = Math.round(Number(value) * 100);
  return bps >= 0 && bps <= MAX_FEE_BPS ? bps : null;
}

/**
 * Fee shares minted for `elapsed` seconds, exactly as the fund contract
 * computes them: sized so the new shares own `rate x elapsed / year` of the
 * fund after minting, elapsed capped at a year.
 */
export function feeShares(supply: bigint, rateBps: number, elapsedSeconds: number): bigint {
  const elapsed = BigInt(Math.min(Math.max(0, Math.floor(elapsedSeconds)), YEAR_SECONDS));
  const accrued = BigInt(rateBps) * elapsed;
  const whole = BPS * BigInt(YEAR_SECONDS);
  return (supply * accrued) / (whole - accrued);
}

/** Splits minted fee shares the way the contract does: the platform's cut rounds down. */
export function splitFee(shares: bigint, platformShareBps: number): { manager: bigint; platform: bigint } {
  const platform = (shares * BigInt(platformShareBps)) / BPS;
  return { manager: shares - platform, platform };
}

/** USD value of fee shares at a NAV per share; null when there is no NAV. */
export function sharesUsd(shares: bigint, navPerShare: number | null): number | null {
  if (navPerShare === null) return null;
  return (Number(shares) / Number(ONE)) * navPerShare;
}

/** What a fee earns in a year on a fund of `aumUsd`, split between manager and platform. */
export function annualFeeUsd(aumUsd: number, rateBps: number, platformShareBps = 0): { total: number; manager: number; platform: number } {
  const total = (aumUsd * rateBps) / 10_000;
  const platform = (total * platformShareBps) / 10_000;
  return { total, manager: total - platform, platform };
}

/** How much of the fund a holder's stake is after `years` of a fee, as a fraction of today. */
export function stakeAfter(rateBps: number, years: number): number {
  return (1 - rateBps / 10_000) ** years;
}

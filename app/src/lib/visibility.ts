import type { Fund } from "./stellar";

export type FundStatus = "active" | "hidden";

/** The metadata key a manager writes to hide a fund from the public lists. */
export const STATUS_KEY = "status";

/** A fund's `status` metadata entry. Only the exact value `hidden` hides; anything else, or no entry, is active. */
export function statusOf(value: unknown): FundStatus {
  return value === "hidden" ? "hidden" : "active";
}

/** The funds a public list shows: hidden ones only when the viewer asked for them. */
export function listedFunds(funds: readonly Fund[], showHidden = false): Fund[] {
  return showHidden ? [...funds] : funds.filter((f) => !f.hidden);
}

import { ONE } from "./format";

/** Cashing out accepts at most 2% less than the quote, as buying the basket does. */
export const CASHOUT_SLIPPAGE_BPS = 200n;
/** Lumens kept back when cashing out XLM, so the account stays above its reserve and can pay fees. */
export const XLM_KEEP = 3n * ONE;

/** The least USDC accepted for a quote of `expected`. */
export function minimumOut(expected: bigint): bigint {
  return expected - (expected * CASHOUT_SLIPPAGE_BPS) / 10_000n;
}

/**
 * USDC (base units) from selling `sell` base units into a book's bids, best
 * first, or null when the book is too thin. Each bid's size is read as the
 * smaller of its amount and amount over price, so whichever unit Horizon
 * reports it in, the quote never assumes more depth than there is.
 */
export function fillBids(bids: readonly { price: string; amount: string }[], sell: bigint): bigint | null {
  let left = Number(sell) / Number(ONE);
  let out = 0;
  for (const bid of bids) {
    const price = Number(bid.price);
    const size = Number(bid.amount);
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(left, size, size / price);
    out += take * price;
    left -= take;
    if (left <= 1e-9) return BigInt(Math.floor(out * Number(ONE)));
  }
  return null;
}

/** Caps a leg at what the wallet holds, keeping a lumen buffer for the reserve and fees. */
export function sellable(received: bigint, balance: bigint, native: boolean): bigint {
  const spendable = native ? balance - XLM_KEEP : balance;
  const capped = received < spendable ? received : spendable;
  return capped > 0n ? capped : 0n;
}

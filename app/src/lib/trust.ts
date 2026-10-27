import { shortId } from "./format";
import type { Fund, FundMetadata } from "./stellar";

/** Display caps for manager-written text; the contract allows more than a card or header can hold honestly. */
export const MAX_NAME = 48;
export const MAX_SYMBOL = 12;
const MAX_METADATA: Record<keyof FundMetadata, number> = { description: 400, strategy: 300, website: 120 };

/** Control, zero-width and bidi-override characters, which can reorder or hide what a reader sees. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff]/g;

/** Strips invisible characters, collapses whitespace and cuts to `max` characters with an ellipsis. */
export function displayText(value: string, max: number): string {
  const clean = value.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** ASCII characters that read as another ASCII letter, folded to that letter. */
const CONFUSABLES: Record<string, string> = {
  "0": "o",
  "1": "l",
  i: "l",
  "|": "l",
  "!": "l",
  "5": "s",
  $: "s",
};

/** Printable ASCII: letters, digits, space and basic punctuation. Anything else in a name or symbol is unusual. */
const PLAIN = /^[\x20-\x7e]*$/;

/**
 * Whether a community fund's name or symbol uses anything beyond printable
 * ASCII: other scripts (a Cyrillic а, a Greek ο), fullwidth letters,
 * zero-width joiners, bidi controls. Checked on the raw text, before any
 * normalization could make a look-alike pass as plain.
 */
export function hasUnusualCharacters(value: string): boolean {
  return !PLAIN.test(value);
}

/**
 * A comparison key under which look-alike ASCII strings match:
 * NFKC-normalized, case-folded, the known ASCII confusables folded (0/o,
 * 1/l/i, 5/s), "rn" read as "m" and "vv" as "w", ASCII spaces and
 * punctuation removed. Characters outside ASCII are kept as they are, so
 * they never vanish into a match; `hasUnusualCharacters` flags them.
 */
export function skeleton(value: string): string {
  return [...value.normalize("NFKC").toLowerCase().replace(INVISIBLE, "")]
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join("")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/[\x00-\x2f\x3a-\x60\x7b-\x7f]/g, "");
}

/** A fund symbol's key without the house `a` prefix, so `LQD`, `aLQD` and `ALQD` all match. */
const symbolKey = (symbol: string) => skeleton(symbol).replace(/^a(?=.)/, "");

/** Names shorter than this, once folded, are too generic to call an imitation. */
const MIN_NAME_KEY = 6;

export interface OfficialFund {
  id: string;
  symbol: string;
  name: string;
}

/**
 * The official fund a community fund's symbol or name passes for, or null.
 * Symbols match on their folded key; a name matches when it contains an
 * official name's folded key, which also catches "<official name> (copy)".
 */
export function imitatedFund(candidate: { symbol: string; name: string }, officials: readonly OfficialFund[]): OfficialFund | null {
  const symbol = symbolKey(candidate.symbol);
  const name = skeleton(candidate.name);
  return (
    officials.find((o) => {
      const officialName = skeleton(o.name);
      return (symbol !== "" && symbol === symbolKey(o.symbol)) || (officialName.length >= MIN_NAME_KEY && name.includes(officialName));
    }) ?? null
  );
}

function capMetadata(metadata: FundMetadata): FundMetadata {
  const out: FundMetadata = {};
  for (const key of Object.keys(MAX_METADATA) as (keyof FundMetadata)[]) {
    const value = metadata[key];
    if (value === undefined) continue;
    const capped = key === "website" ? value.replace(INVISIBLE, "").trim() : displayText(value, MAX_METADATA[key]);
    if (key === "website" && [...capped].length > MAX_METADATA.website) continue;
    if (capped) out[key] = capped;
  }
  return out;
}

/**
 * Marks each fund official or community and makes its text safe to show.
 * Official funds are the ones this build's deployment files list, by
 * contract ID. A community fund whose symbol or name passes for an official
 * one is flagged with that fund's symbol, one whose name or symbol uses
 * unusual characters is flagged too, and both show the manager's address
 * after their own symbol, so neither can read the same as an official fund.
 */
export function withTrust(funds: readonly Fund[], officialIds: ReadonlySet<string>): Fund[] {
  const capped = funds.map((f) => ({
    ...f,
    name: displayText(f.name, MAX_NAME),
    symbol: displayText(f.symbol, MAX_SYMBOL),
    metadata: capMetadata(f.metadata),
    official: officialIds.has(f.id),
    imitates: null,
    unusualText: !officialIds.has(f.id) && (hasUnusualCharacters(f.name) || hasUnusualCharacters(f.symbol)),
  }));
  const officials = capped.filter((f) => f.official).map(({ id, symbol, name }) => ({ id, symbol, name }));
  return capped.map((f) => {
    if (f.official) return f;
    const imitated = imitatedFund(f, officials);
    if (!imitated && !f.unusualText) return f;
    return { ...f, imitates: imitated?.symbol ?? null, symbol: `${f.symbol} · ${shortId(f.manager, 4, 4)}` };
  });
}

import { shortId } from "./format";
import type { Fund, FundMetadata } from "./stellar";

/** Display caps for manager-written text; the contract allows more than a card or header can hold honestly. */
export const MAX_NAME = 48;
export const MAX_SYMBOL = 12;
const MAX_METADATA: Record<keyof FundMetadata, number> = { description: 400, strategy: 300, website: 120 };

/** Control, zero-width and bidi-override characters, which can reorder or hide what a reader sees. */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜​-‏‪-‮⁠-⁤⁦-⁯﻿]/g;

/** Strips invisible characters, collapses whitespace and cuts to `max` characters with an ellipsis. */
export function displayText(value: string, max: number): string {
  const clean = value.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  const chars = [...clean];
  return chars.length <= max ? clean : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** Latin, Cyrillic and Greek letters and digits that read as the same glyph, folded to one latin letter. */
const CONFUSABLES: Record<string, string> = {
  "0": "o",
  "1": "l",
  i: "l",
  "|": "l",
  "!": "l",
  "5": "s",
  $: "s",
  "а": "a",
  "в": "b",
  "е": "e",
  "ё": "e",
  "к": "k",
  "м": "m",
  "н": "h",
  "о": "o",
  "р": "p",
  "с": "c",
  "т": "t",
  "у": "y",
  "х": "x",
  "і": "l",
  "ї": "l",
  "ј": "j",
  "ѕ": "s",
  "ԁ": "d",
  "ԛ": "q",
  "ԝ": "w",
  "α": "a",
  "β": "b",
  "ε": "e",
  "η": "n",
  "ι": "l",
  "κ": "k",
  "ν": "v",
  "ο": "o",
  "ρ": "p",
  "τ": "t",
  "υ": "u",
  "χ": "x",
};

/**
 * A comparison key under which look-alike strings match: case-folded,
 * compatibility-normalized, accents dropped, confusable glyphs folded
 * (0/O, 1/l/I, Cyrillic and Greek look-alikes), "rn" read as "m" and "vv"
 * as "w", and everything but letters and digits removed.
 */
export function skeleton(value: string): string {
  const folded = value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(INVISIBLE, "");
  return [...folded]
    .map((ch) => CONFUSABLES[ch] ?? ch)
    .join("")
    .replace(/rn/g, "m")
    .replace(/vv/g, "w")
    .replace(/[^a-z0-9]/g, "");
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
 * one is flagged with that fund's symbol and shows its manager's address
 * after its own symbol, so the two can never read the same.
 */
export function withTrust(funds: readonly Fund[], officialIds: ReadonlySet<string>): Fund[] {
  const capped = funds.map((f) => ({
    ...f,
    name: displayText(f.name, MAX_NAME),
    symbol: displayText(f.symbol, MAX_SYMBOL),
    metadata: capMetadata(f.metadata),
    official: officialIds.has(f.id),
    imitates: null,
  }));
  const officials = capped.filter((f) => f.official).map(({ id, symbol, name }) => ({ id, symbol, name }));
  return capped.map((f) => {
    if (f.official) return f;
    const imitated = imitatedFund(f, officials);
    return imitated ? { ...f, imitates: imitated.symbol, symbol: `${f.symbol} · ${shortId(f.manager, 4, 4)}` } : f;
  });
}

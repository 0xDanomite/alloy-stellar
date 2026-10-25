export const DECIMALS = 7;
export const ONE = 10_000_000n;

export function toUnits(input: string): bigint | null {
  const value = input.trim();
  if (!/^\d*(\.\d*)?$/.test(value) || value === "" || value === ".") return null;
  const [whole = "0", frac = ""] = value.split(".");
  if (frac.length > DECIMALS) return null;
  return BigInt(whole || "0") * ONE + BigInt(frac.padEnd(DECIMALS, "0"));
}

export function toDecimalString(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / ONE;
  const frac = (abs % ONE).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

export function formatAmount(units: bigint, maxFraction = 4): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / ONE;
  let frac = (abs % ONE).toString().padStart(DECIMALS, "0").slice(0, maxFraction).replace(/0+$/, "");
  if (!frac && abs > 0n && whole === 0n) frac = (abs % ONE).toString().padStart(DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

export function unitsToNumber(units: bigint): number {
  return Number(units) / Number(ONE);
}

export function formatUsd(value: number): string {
  const digits = value !== 0 && Math.abs(value) < 1 ? 4 : 2;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

export function shortId(id: string, head = 4, tail = 4): string {
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

import { formatAmount, formatUsd, unitsToNumber } from "../lib/format";
import { legPrice } from "../lib/fund-math";
import { donutArcs, ringPath } from "../lib/series";
import type { Fund } from "../lib/stellar";
import { headlineValue, strandColor } from "./fund-bits";
import { Usd } from "./ui";

const SIZE = 168;
const OUTER = 80;
const INNER = 58;
const GAP = 0.035;

function legValues(fund: Fund): (number | null)[] {
  return fund.components.map((leg) => {
    const price = legPrice(fund, leg);
    return price === null ? null : unitsToNumber(leg.unitsPerShare) * price;
  });
}

function Donut({ fund, values }: { fund: Fund; values: number[] }) {
  const total = values.reduce((s, v) => s + v, 0);
  const arcs = donutArcs(values, GAP);
  const largest = values.indexOf(Math.max(...values));
  const lead = fund.components[largest];
  return (
    <div className="relative mx-auto size-[10.5rem] shrink-0">
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="size-full" role="img" aria-label="Allocation by value">
        {arcs.map((arc, i) => (
          <path key={fund.components[i]?.token ?? i} d={ringPath(SIZE / 2, SIZE / 2, OUTER, INNER, arc)} fill={strandColor(i)} />
        ))}
      </svg>
      {lead && total > 0 && (
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="num text-[1.375rem] leading-none">{Math.round(((values[largest] ?? 0) / total) * 100)}%</div>
            <div className="mt-1 text-[0.75rem] text-muted-foreground">{lead.code}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Allocation by value and the arithmetic behind the headline NAV. */
export function Breakdown({ fund }: { fund: Fund }) {
  const values = legValues(fund);
  const priced = values.every((v): v is number => v !== null);
  const perShare = priced ? values.reduce((s, v) => s + v, 0) : null;
  const { basis } = headlineValue(fund);
  const shares = unitsToNumber(fund.totalSupply);

  return (
    <div className="panel grid gap-8 rounded-2xl p-5 sm:p-6 md:grid-cols-[auto_1fr] md:items-start">
      <div className="flex flex-col items-center gap-4 sm:flex-row md:flex-col">
        {priced && perShare !== null && perShare > 0 ? (
          <Donut fund={fund} values={values} />
        ) : (
          <div className="grid size-[10.5rem] place-items-center rounded-full border border-dashed text-center text-[0.8125rem] text-muted-foreground">
            <span className="px-6">Needs a price for every asset</span>
          </div>
        )}
        <ul className="grid w-full grid-cols-2 gap-x-4 gap-y-1.5 sm:w-auto md:grid-cols-1">
          {fund.components.map((leg, i) => (
            <li key={leg.token} className="flex items-center gap-2 text-[0.8125rem]">
              <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: strandColor(i) }} aria-hidden />
              <span className="font-medium">{leg.code}</span>
              <span className="num ml-auto text-muted-foreground md:ml-3">
                {priced && perShare ? `${(((values[i] ?? 0) / perShare) * 100).toFixed(1)}%` : "n/a"}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-w-0">
        <h3 className="text-heading">How the NAV adds up</h3>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          {basis === "oracle"
            ? "Units in one share times each asset's oracle price, the same sum Alloy's NAV contract returns."
            : "Units in one share times each asset's Stellar DEX price in USDC."}
        </p>
        <table className="mt-4 w-full text-[0.875rem]">
          <caption className="sr-only">Units per share times price equals value per share</caption>
          <tbody className="divide-y">
            {fund.components.map((leg, i) => {
              const price = legPrice(fund, leg);
              return (
                <tr key={leg.token}>
                  <th scope="row" className="py-2 pr-3 text-left font-medium">
                    <span className="inline-flex items-center gap-2">
                      <span className="size-2 rounded-full" style={{ background: strandColor(i) }} aria-hidden />
                      {leg.code}
                    </span>
                  </th>
                  <td className="num py-2 text-right text-muted-foreground">
                    {formatAmount(leg.unitsPerShare)} <span aria-hidden>×</span>
                    <span className="sr-only">times</span> {price === null ? "unpriced" : `$${formatUsd(price)}`}
                  </td>
                  <td className="num w-28 py-2 pl-3 text-right">
                    <span className="text-muted-foreground" aria-hidden>= </span>
                    <Usd value={values[i] ?? null} />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t-2 border-foreground/20">
            <tr>
              <th scope="row" colSpan={2} className="pt-3 text-left font-medium">
                {basis === "oracle" ? "NAV per share" : "Value per share"}
              </th>
              <td className="num pt-3 text-right">
                <Usd value={perShare} className="text-figure" />
              </td>
            </tr>
            {perShare !== null && shares > 0 && (
              <tr>
                <td colSpan={2} className="pt-1 text-[0.8125rem] text-muted-foreground">
                  × {formatAmount(fund.totalSupply, 4)} shares issued
                </td>
                <td className="num pt-1 text-right text-[0.8125rem] text-muted-foreground">${formatUsd(perShare * shares)}</td>
              </tr>
            )}
          </tfoot>
        </table>
        {basis === "oracle" && fund.navPerShare !== null && perShare !== null && Math.abs(perShare - fund.navPerShare) > 0.000_01 && (
          <p className="mt-3 text-[0.8125rem] text-muted-foreground">
            The contract rounds each leg to 8 decimals, so its NAV of ${formatUsd(fund.navPerShare)} can differ in the last digits.
          </p>
        )}
      </div>
    </div>
  );
}

import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { complianceLabel, FundAvatar, FundBlurb, headlineValue, HoldsChips } from "../components/fund-bits";
import { changeTone, formatPct } from "../components/NavChart";
import { Usd } from "../components/ui";
import { deployments, network } from "../lib/config";
import { formatAmount, formatUsd } from "../lib/format";
import { fundValueUsd } from "../lib/fund-math";
import { fundSeries, hasHistory, loadHistories, type AssetHistory } from "../lib/history";
import { rangeReturn } from "../lib/series";
import { explain, listFunds, type Fund, type FundComponent } from "../lib/stellar";
import { useAsync } from "../lib/use-async";

function uniqueLegs(funds: Fund[]): FundComponent[] {
  const byToken = new Map<string, FundComponent>();
  for (const fund of funds) for (const leg of fund.components) byToken.set(leg.token, leg);
  return [...byToken.values()];
}

function matches(fund: Fund, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    fund.name.toLowerCase().includes(q) ||
    fund.symbol.toLowerCase().includes(q) ||
    (fund.metadata.description ?? "").toLowerCase().includes(q) ||
    fund.components.some((leg) => leg.code.toLowerCase() === q)
  );
}

function DayCell({ fund, histories }: { fund: Fund; histories: Map<string, AssetHistory> | undefined }) {
  if (!histories) return <span className="skeleton w-12">0</span>;
  const change = hasHistory(fund, histories) ? rangeReturn(fundSeries(fund, histories, "1D")) : null;
  if (change === null) return <span className="text-muted-foreground">n/a</span>;
  return <span className={changeTone(change)}>{formatPct(change)}</span>;
}

function FundRow({ fund, histories }: { fund: Fund; histories: Map<string, AssetHistory> | undefined }) {
  const { value, basis } = headlineValue(fund);
  const total = fundValueUsd(fund);
  return (
    <li className="relative grid gap-x-6 gap-y-3 px-5 py-5 hover:bg-secondary/40 md:grid-cols-[minmax(0,1.5fr)_8.5rem_5rem_minmax(0,1.6fr)] md:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <FundAvatar fund={fund} />
        <div className="min-w-0">
          <Link
            to={`/fund/${fund.id}`}
            className="block truncate font-medium after:absolute after:inset-0 hover:text-primary"
          >
            {fund.name}
          </Link>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <span className="text-filing text-muted-foreground">{fund.symbol}</span>
            <span className="text-[0.75rem] text-muted-foreground">{complianceLabel(fund)}</span>
            {fund.setup && !fund.setup.open && <span className="text-[0.75rem] text-warning">not open yet</span>}
          </div>
          <FundBlurb fund={fund} className="mt-1 line-clamp-2 text-[0.8125rem] leading-snug" />
        </div>
      </div>

      <div className="flex items-baseline justify-between gap-3 md:block md:text-right">
        <span className="text-[0.8125rem] text-muted-foreground md:hidden">{basis === "oracle" ? "NAV" : "Value"} per share</span>
        <div>
          {value === null ? <span className="text-muted-foreground">unpriced</span> : <Usd value={value} className="text-[1.0625rem]" />}
          <div className="text-[0.75rem] text-muted-foreground">
            {fund.totalSupply === 0n ? "no shares yet" : total !== null ? `$${formatUsd(total)} AUM` : `${formatAmount(fund.totalSupply, 2)} shares`}
          </div>
        </div>
      </div>

      <div className="num flex items-baseline justify-between gap-3 text-[0.875rem] md:block md:text-right">
        <span className="font-sans text-[0.8125rem] text-muted-foreground md:hidden">24h, modeled</span>
        <DayCell fund={fund} histories={histories} />
      </div>

      <div className="min-w-0">
        <HoldsChips fund={fund} limit={4} />
        {fund.awaitingIssuer.length > 0 && (
          <p className="mt-2 text-[0.75rem] text-warning">Waiting on {fund.awaitingIssuer.map((l) => l.code).join(", ")} issuer authorization</p>
        )}
      </div>
    </li>
  );
}

export function FundsPage() {
  const funds = useAsync(() => listFunds(), deployments ? network : null);
  const legs = useMemo(() => (funds.data ? uniqueLegs(funds.data) : null), [funds.data]);
  const histories = useAsync(
    () => (legs ? loadHistories(legs, "1D") : Promise.resolve(new Map<string, AssetHistory>())),
    legs ? `day:${legs.map((l) => l.token).join(",")}` : null,
  );
  const [query, setQuery] = useState("");
  const shown = funds.data?.filter((f) => matches(f, query)) ?? [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-display text-[clamp(1.75rem,4.5vw,2.5rem)] leading-[1.08] font-semibold">Funds</h1>
          <p className="mt-2 max-w-[38rem] text-muted-foreground">
            Every fund the Alloy platform contract has registered, read live from the ledger.
          </p>
        </div>
        <label className="w-full sm:w-72">
          <span className="sr-only">Search funds</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, symbol or asset"
            className="w-full rounded-full border bg-card px-4 py-2.5 text-[0.9375rem] outline-none placeholder:text-muted-foreground focus:border-ring"
          />
        </label>
      </div>

      <div className="panel mt-8 overflow-hidden rounded-2xl">
        <div className="hidden gap-6 border-b px-5 py-3 text-[0.8125rem] text-muted-foreground md:grid md:grid-cols-[minmax(0,1.5fr)_8.5rem_5rem_minmax(0,1.6fr)]">
          <span>Fund</span>
          <span className="text-right">Per share</span>
          <span className="text-right" title="Today's units valued at prices 24 hours ago and now">24h, modeled</span>
          <span>Holds</span>
        </div>
        {funds.error != null && !funds.data ? (
          <div className="px-5 py-8">
            <p className="text-muted-foreground">Couldn't read the funds from the network. {explain(funds.error)}</p>
            <button type="button" onClick={funds.reload} className="mt-2 text-primary underline-offset-4 hover:underline">
              Try again
            </button>
          </div>
        ) : !funds.data ? (
          <ul className="divide-y" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="flex items-center gap-3 px-5 py-6">
                <span className="skeleton size-10 rounded-full" />
                <span className="skeleton h-4 w-48" />
                <span className="skeleton ml-auto h-4 w-20" />
              </li>
            ))}
          </ul>
        ) : shown.length ? (
          <ul className="divide-y">
            {shown.map((fund) => (
              <FundRow key={fund.id} fund={fund} histories={histories.data ?? (histories.error != null ? new Map() : undefined)} />
            ))}
          </ul>
        ) : (
          <div className="px-5 py-10 text-center">
            <p className="text-muted-foreground">
              {funds.data.length ? `No fund matches "${query.trim()}".` : "No funds on this platform yet."}
            </p>
            {funds.data.length ? (
              <button type="button" onClick={() => setQuery("")} className="mt-2 text-primary underline-offset-4 hover:underline">
                Clear search
              </button>
            ) : (
              <Link to="/create" className="mt-2 inline-block text-primary underline-offset-4 hover:underline">
                Create the first fund
              </Link>
            )}
          </div>
        )}
      </div>
      {funds.data && (
        <p className="mt-3 text-[0.8125rem] text-muted-foreground">
          {funds.data.length} {funds.data.length === 1 ? "fund" : "funds"}. The 24h figure holds today's units fixed and values
          them at oracle and Stellar DEX prices from a day ago.
        </p>
      )}
    </div>
  );
}

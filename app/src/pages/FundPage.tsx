import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { AssetDot, complianceLabel, FundAvatar, headlineValue, HoldsChips, IssuerFlags, IssuerName, OracleNote } from "../components/fund-bits";
import { ArrowLeft } from "../components/icons";
import { InvestPanel } from "../components/InvestPanel";
import { ManagePanel } from "../components/ManagePanel";
import { RedeemPanel } from "../components/RedeemPanel";
import { CopyId, Figure, Usd } from "../components/ui";
import { deployments, expert } from "../lib/config";
import { formatAmount, formatUsd, unitsToNumber } from "../lib/format";
import { fundValueUsd } from "../lib/fund-math";
import { explain, findFund, isMainnet, loadPosition, type Fund } from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { NotFound } from "./NotFound";

const COLUMNS = {
  oracle: "md:grid-cols-[1.4fr_0.9fr_0.9fr_1.2fr_0.8fr_0.9fr]",
  market: "md:grid-cols-[1.4fr_1fr_1fr_0.8fr_0.9fr]",
};

function Composition({ fund }: { fund: Fund }) {
  const columns = fund.hasOracle ? COLUMNS.oracle : COLUMNS.market;
  const { value: shareValue } = headlineValue(fund);
  return (
    <div className="panel overflow-hidden rounded-2xl">
      <div className={`hidden gap-4 border-b px-5 py-3 text-[0.8125rem] text-muted-foreground md:grid ${columns}`}>
        <span>Asset</span>
        <span className="text-right">Per share</span>
        <span className="text-right">Fund holds</span>
        {fund.hasOracle && <span className="text-right">Oracle (USD)</span>}
        <span className="text-right">{fund.hasOracle ? "Market (USDC)" : "Price (USDC)"}</span>
        <span className="text-right">Value per share</span>
      </div>
      <ul className="divide-y">
        {fund.components.map((leg, i) => {
          const price = fund.navPerShare !== null ? (leg.oracle?.priceUsd ?? null) : leg.priceUsdc;
          const legValue = price === null ? null : unitsToNumber(leg.unitsPerShare) * price;
          return (
            <li key={leg.token} className={`grid grid-cols-1 gap-x-6 gap-y-1 px-5 py-4 sm:grid-cols-2 md:items-center ${columns}`}>
              <div className="mb-1 flex min-w-0 items-start gap-3 sm:col-span-2 md:col-span-1 md:mb-0">
                <span className="mt-0.5"><AssetDot code={leg.code} index={i} /></span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    {leg.issuer ? (
                      <a href={expert.asset(leg.code, leg.issuer)} target="_blank" rel="noreferrer" className="font-medium hover:text-primary">
                        {leg.code}
                      </a>
                    ) : (
                      <span className="font-medium">{leg.code}</span>
                    )}
                    <IssuerName leg={leg} />
                  </div>
                  <IssuerFlags leg={leg} />
                  {leg.shelfStatus === "Permissioned" && leg.fundAuthorized && (
                    <div className="text-[0.8125rem] text-muted-foreground">issuer has approved this fund</div>
                  )}
                </div>
              </div>
              <Cell label="Per share" value={formatAmount(leg.unitsPerShare)} />
              <Cell label="Fund holds" value={formatAmount(leg.holding, 2)} />
              {fund.hasOracle && (
                <Cell
                  label="Oracle"
                  value={
                    <>
                      <Usd value={leg.oracle?.priceUsd ?? null} />
                      <OracleNote leg={leg} />
                    </>
                  }
                />
              )}
              <Cell label={fund.hasOracle ? "Market" : "Price"} value={<Usd value={leg.priceUsdc} />} />
              <Cell label="Value per share" value={<Usd value={legValue} />} />
            </li>
          );
        })}
      </ul>
      <div className="flex items-baseline justify-between gap-4 border-t bg-surface-sunken/60 px-5 py-4">
        <span className="text-label">One share</span>
        <Usd value={shareValue} className="text-figure" />
      </div>
    </div>
  );
}

function Cell({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 md:block md:text-right">
      <span className="text-[0.8125rem] text-muted-foreground md:hidden">{label}</span>
      <span className="num text-[0.9375rem]">{value}</span>
    </div>
  );
}

function AwaitingIssuer({ fund }: { fund: Fund }) {
  return (
    <div className="rounded-2xl border border-warning/40 bg-warning-surface p-5">
      <h2 className="text-heading">Waiting on issuer authorization</h2>
      <p className="mt-2 max-w-[42rem]">
        {fund.awaitingIssuer.map((l) => l.code).join(", ")} can only be held by addresses its issuer has approved. Issuing
        opens when the issuer authorizes this fund's address. Redemption stays open the whole time.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3 text-[0.875rem]">
        <span className="text-muted-foreground">Fund address</span>
        <CopyId id={fund.id} head={10} tail={10} />
      </div>
    </div>
  );
}

export function FundPage() {
  const { id = "" } = useParams();
  const { address } = useWallet();
  const [version, setVersion] = useState(0);
  const fund = useAsync(() => findFund(id, version > 0), deployments ? id : null, version);
  const f = fund.data;
  const position = useAsync(
    () => (f && address ? loadPosition(f, address) : Promise.resolve(null)),
    f && address ? `${f.id}:${address}` : null,
    version,
  );
  const [tab, setTab] = useState<"invest" | "redeem" | "manage">("invest");
  const isManager = Boolean(f && address && f.manager === address);
  const tabs = isManager ? (["invest", "redeem", "manage"] as const) : (["invest", "redeem"] as const);
  const refresh = () => setVersion((v) => v + 1);

  if (fund.data === null) return <NotFound message="The Alloy platform has no fund at this address." />;
  if (fund.error != null && !f) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
        <h1 className="text-title">Couldn't load this fund</h1>
        <p className="mt-2 text-muted-foreground">{explain(fund.error)}</p>
        <button type="button" onClick={fund.reload} className="mt-4 text-primary underline-offset-4 hover:underline">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <Link to="/#funds" className="inline-flex items-center gap-1.5 text-label text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" />
        All funds
      </Link>

      <div className="mt-6 grid gap-10 lg:grid-cols-[1fr_24rem]">
        <div className="min-w-0 space-y-8">
          <header>
            <div className="flex items-start gap-4">
              {f ? <FundAvatar fund={f} className="size-14 text-[0.8125rem]" /> : <span className="skeleton size-14 rounded-full" />}
              <div className="min-w-0 flex-1">
                <h1 className="font-display text-[clamp(1.75rem,4.5vw,2.5rem)] leading-[1.08] font-semibold">
                  {f ? f.name : <span className="skeleton w-64">loading</span>}
                </h1>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="text-filing text-muted-foreground">{f ? f.symbol : "fund"}</span>
                  {f && <span className="chip px-2 py-0.5 text-[0.75rem] text-muted-foreground">{complianceLabel(f)}</span>}
                </div>
              </div>
            </div>

            <div className="panel mt-8 rounded-2xl p-5 sm:p-6">
              <div className="flex flex-wrap items-end gap-x-10 gap-y-6">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-filing text-muted-foreground">
                      {f?.navPerShare != null ? "NAV per share" : "Value per share"}
                    </span>
                    {f && headlineValue(f).value !== null && (
                      <span className="chip px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                        {headlineValue(f).basis === "oracle" ? "oracle" : "SDEX"}
                      </span>
                    )}
                  </div>
                  {!f ? (
                    <Figure value={undefined} width="8ch" className="text-figure-xl" />
                  ) : headlineValue(f).value === null ? (
                    <span className="text-figure-lg text-muted-foreground">unpriced</span>
                  ) : (
                    <Usd value={headlineValue(f).value} className="text-figure-xl" />
                  )}
                </div>
                {f?.navPerShare != null && (
                  <div>
                    <div className="text-filing text-muted-foreground">Market value (SDEX)</div>
                    <Usd value={f.valuePerShare} className="text-figure-lg" />
                  </div>
                )}
                <div>
                  <div className="text-filing text-muted-foreground">Shares issued</div>
                  <Figure value={f ? formatAmount(f.totalSupply, 4) : undefined} className="text-figure-lg" />
                </div>
                {f && fundValueUsd(f) !== null && f.totalSupply > 0n && (
                  <div>
                    <div className="text-filing text-muted-foreground">In the fund</div>
                    <span className="num text-figure-lg">${formatUsd(fundValueUsd(f) ?? 0)}</span>
                  </div>
                )}
              </div>
              {f && headlineValue(f).value === null && (
                <p className="mt-3 max-w-[40rem] text-[0.875rem] text-muted-foreground">
                  {isMainnet
                    ? "At least one asset has no fresh oracle price or market price on the Stellar DEX right now, so we don't show a total."
                    : "An asset has no price on the testnet market right now, so we don't show a total."}
                </p>
              )}
              {f && (
                <div className="mt-6 border-t pt-5">
                  <p className="text-filing text-muted-foreground">Holds</p>
                  <div className="mt-2">
                    <HoldsChips fund={f} limit={8} />
                  </div>
                </div>
              )}
            </div>
            {f && (
              <div className="mt-5 flex flex-wrap items-center gap-3 text-[0.875rem]">
                <span className="text-muted-foreground">Fund contract</span>
                <CopyId id={f.id} />
              </div>
            )}
          </header>

          {f && f.awaitingIssuer.length > 0 && <AwaitingIssuer fund={f} />}

          <section>
            <p className="text-filing text-muted-foreground">Composition</p>
            <h2 className="mt-1 font-display text-[1.375rem] font-semibold">What one share holds</h2>
            <p className="mt-1 max-w-[42rem] text-muted-foreground">
              Amounts come from the fund's own balances divided by shares issued, so a clawback or a donation shows up here
              immediately.{" "}
              {f?.hasOracle
                ? "Oracle prices come from RedStone and Reflector through Alloy's read-only NAV contract; the market column is what one unit sells for in USDC on the Stellar DEX right now, kept as a cross-check."
                : "Prices are what one unit sells for in USDC on the Stellar DEX right now."}
            </p>
            <div className="mt-5">{f ? <Composition fund={f} /> : <div className="skeleton h-64 w-full rounded-2xl" />}</div>
          </section>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="panel rounded-2xl shadow-overlay">
            <div className={`grid border-b p-1.5 ${isManager ? "grid-cols-3" : "grid-cols-2"}`} role="tablist">
              {tabs.map((t) => (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`rounded-full py-2 text-label ${tab === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {t === "invest" ? "Invest" : t === "redeem" ? "Redeem" : "Manage"}
                </button>
              ))}
            </div>
            <div className="p-5">
              {!f ? (
                <div className="skeleton h-40 w-full" />
              ) : tab === "manage" ? (
                <ManagePanel fund={f} onChanged={refresh} />
              ) : tab === "invest" ? (
                <InvestPanel fund={f} position={position.data ?? null} onChanged={refresh} />
              ) : (
                <RedeemPanel fund={f} position={position.data ?? null} onChanged={refresh} />
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

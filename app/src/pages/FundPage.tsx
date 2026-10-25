import { useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { complianceLabel, IssuerFlags, issuerLabel, strandColor } from "../components/fund-bits";
import { InvestPanel } from "../components/InvestPanel";
import { RedeemPanel } from "../components/RedeemPanel";
import { CopyId, Figure, Usd } from "../components/ui";
import { deployments, expert } from "../lib/config";
import { formatAmount, unitsToNumber } from "../lib/format";
import { explain, findFund, isMainnet, loadPosition, type Fund } from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { NotFound } from "./NotFound";

function Composition({ fund }: { fund: Fund }) {
  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="hidden grid-cols-[1.4fr_1fr_1fr_0.8fr_0.9fr] gap-4 border-b px-5 py-3 text-[0.8125rem] text-muted-foreground md:grid">
        <span>Asset</span>
        <span className="text-right">Per share</span>
        <span className="text-right">Fund holds</span>
        <span className="text-right">Price (USDC)</span>
        <span className="text-right">Value per share</span>
      </div>
      <ul className="divide-y">
        {fund.components.map((leg, i) => {
          const legValue = leg.priceUsdc === null ? null : unitsToNumber(leg.unitsPerShare) * leg.priceUsdc;
          return (
            <li key={leg.token} className="grid grid-cols-2 gap-x-4 gap-y-1 px-5 py-4 md:grid-cols-[1.4fr_1fr_1fr_0.8fr_0.9fr] md:items-center">
              <div className="col-span-2 flex min-w-0 items-start gap-3 md:col-span-1">
                <span className="mt-1 h-8 w-1 shrink-0 rounded-full" style={{ background: strandColor(i) }} aria-hidden />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    {leg.issuer ? (
                      <a href={expert.asset(leg.code, leg.issuer)} target="_blank" rel="noreferrer" className="font-medium hover:text-primary">
                        {leg.code}
                      </a>
                    ) : (
                      <span className="font-medium">{leg.code}</span>
                    )}
                    <span className="text-[0.8125rem] text-muted-foreground">{issuerLabel(leg)}</span>
                  </div>
                  <IssuerFlags leg={leg} />
                  {leg.shelfStatus === "Permissioned" && leg.fundAuthorized && (
                    <div className="text-[0.8125rem] text-muted-foreground">issuer has approved this fund</div>
                  )}
                </div>
              </div>
              <Cell label="Per share" value={formatAmount(leg.unitsPerShare)} />
              <Cell label="Fund holds" value={formatAmount(leg.holding, 2)} />
              <Cell label="Price" value={<Usd value={leg.priceUsdc} />} />
              <Cell label="Value per share" value={<Usd value={legValue} />} />
            </li>
          );
        })}
      </ul>
      <div className="flex items-baseline justify-between gap-4 border-t bg-surface-sunken px-5 py-4">
        <span className="text-label">One share</span>
        <Usd value={fund.valuePerShare} className="text-figure" />
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
    <div className="rounded-xl border border-warning/40 bg-warning-surface p-5">
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
  const { symbol = "" } = useParams();
  const { address } = useWallet();
  const [version, setVersion] = useState(0);
  const fund = useAsync(() => findFund(symbol, version > 0), deployments ? symbol : null, version);
  const f = fund.data;
  const position = useAsync(
    () => (f && address ? loadPosition(f, address) : Promise.resolve(null)),
    f && address ? `${f.id}:${address}` : null,
    version,
  );
  const [tab, setTab] = useState<"invest" | "redeem">("invest");
  const refresh = () => setVersion((v) => v + 1);

  if (fund.data === null) return <NotFound message={`The platform has no fund called ${symbol}.`} />;
  if (fund.error != null && !f) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
        <h1 className="text-title">Couldn't load {symbol}</h1>
        <p className="mt-2 text-muted-foreground">{explain(fund.error)}</p>
        <button type="button" onClick={fund.reload} className="mt-4 text-primary underline-offset-4 hover:underline">
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <Link to="/#funds" className="text-label text-muted-foreground hover:text-foreground">
        All funds
      </Link>

      <div className="mt-6 grid gap-10 lg:grid-cols-[1fr_24rem]">
        <div className="min-w-0 space-y-8">
          <header>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="font-display text-[clamp(2.25rem,6vw,3.25rem)] leading-none font-semibold">{f?.symbol ?? symbol}</h1>
              {f && <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[0.75rem] font-medium">{complianceLabel(f)}</span>}
            </div>
            <p className="mt-2 text-[1.0625rem] text-muted-foreground">{f ? f.name : <span className="skeleton w-48">loading</span>}</p>

            <div className="mt-8 flex flex-wrap items-end gap-x-12 gap-y-6">
              <div>
                <div className="text-[0.8125rem] text-muted-foreground">Value per share</div>
                {!f ? (
                  <Figure value={undefined} width="8ch" className="text-figure-xl" />
                ) : f.valuePerShare === null ? (
                  <span className="text-figure-lg text-muted-foreground">unpriced</span>
                ) : (
                  <Usd value={f.valuePerShare} className="text-figure-xl" />
                )}
              </div>
              <div>
                <div className="text-[0.8125rem] text-muted-foreground">Shares issued</div>
                <Figure value={f ? formatAmount(f.totalSupply, 4) : undefined} className="text-figure-lg" />
              </div>
            </div>
            {f && f.valuePerShare === null && (
              <p className="mt-3 max-w-[40rem] text-[0.875rem] text-muted-foreground">
                {isMainnet
                  ? "At least one asset has no market price on the Stellar DEX right now, so we don't show a total."
                  : "Testnet assets have no real market, so nothing here is priced."}
              </p>
            )}
            {f && (
              <div className="mt-5 flex flex-wrap items-center gap-3 text-[0.875rem]">
                <span className="text-muted-foreground">Fund contract</span>
                <CopyId id={f.id} />
              </div>
            )}
          </header>

          {f && f.awaitingIssuer.length > 0 && <AwaitingIssuer fund={f} />}

          <section>
            <h2 className="text-heading">What one share holds</h2>
            <p className="mt-1 max-w-[42rem] text-muted-foreground">
              Amounts come from the fund's own balances divided by shares issued, so a clawback or a donation shows up here
              immediately. Prices are what one unit sells for in USDC on the Stellar DEX right now.
            </p>
            <div className="mt-5">{f ? <Composition fund={f} /> : <div className="skeleton h-64 w-full rounded-xl" />}</div>
          </section>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="rounded-xl border bg-card shadow-overlay">
            <div className="grid grid-cols-2 border-b p-1.5" role="tablist">
              {(["invest", "redeem"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={tab === t}
                  onClick={() => setTab(t)}
                  className={`rounded-md py-2 text-label ${tab === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {t === "invest" ? "Invest" : "Redeem"}
                </button>
              ))}
            </div>
            <div className="p-5">
              {!f ? (
                <div className="skeleton h-40 w-full" />
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

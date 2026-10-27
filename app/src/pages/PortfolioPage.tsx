import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { complianceLabel, FundAvatar, headlineValue, ImitationChip, strandColor, TrustTag } from "../components/fund-bits";
import { Bell } from "../components/icons";
import { Button, CopyId, Figure, Usd } from "../components/ui";
import { deployments } from "../lib/config";
import { formatAmount, formatUsd } from "../lib/format";
import { fundValueUsd } from "../lib/fund-math";
import { portfolio } from "../lib/portfolio";
import type { Attention, FundPosition, Portfolio } from "../lib/portfolio-model";
import { explain } from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";

const shares = (n: bigint) => `${formatAmount(n, 4)} ${n === 10_000_000n ? "share" : "shares"}`;

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-filing text-muted-foreground">{label}</div>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function Summary({ data }: { data: Portfolio | undefined }) {
  const held = data?.positions.filter((p) => p.shares > 0n).length;
  const owed = data?.positions.reduce((n, p) => n + p.owed.length, 0);
  return (
    <div className="panel rounded-2xl p-5 sm:p-6">
      <div className="flex flex-wrap items-end gap-x-12 gap-y-6">
        <Stat label="Value at NAV">
          {data ? <Usd value={data.totalUsd} className="text-figure-xl" /> : <Figure value={undefined} width="7ch" className="text-figure-xl" />}
        </Stat>
        <Stat label="Funds held">
          <Figure value={held} className="text-figure-lg" />
        </Stat>
        <Stat label="Owed claims">
          <Figure value={owed} className="text-figure-lg" />
        </Stat>
        <Stat label="Funds managed">
          <Figure value={data?.managed.length} className="text-figure-lg" />
        </Stat>
      </div>
      {data && data.unpriced > 0 && (
        <p className="mt-4 text-[0.8125rem] text-muted-foreground">
          {data.unpriced} {data.unpriced === 1 ? "holding has" : "holdings have"} no price right now and {data.unpriced === 1 ? "is" : "are"} left out of the total.
        </p>
      )}
    </div>
  );
}

function AttentionList({ items }: { items: Attention[] }) {
  return (
    <section className="rounded-2xl border border-warning/40 bg-warning-surface">
      <h2 className="flex items-center gap-2 px-5 pt-4 text-heading">
        <Bell className="size-[18px] text-warning" />
        Needs attention
        <span className="num ml-1 rounded-full bg-warning px-2 text-[0.75rem] text-gold-foreground">{items.length}</span>
      </h2>
      <ul className="mt-2 divide-y divide-warning/20">
        {items.map((item) => (
          <li key={`${item.kind}:${item.fund.id}:${item.title}`} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3.5">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{item.title}</p>
              <p className="mt-0.5 max-w-[44rem] text-[0.875rem] text-muted-foreground">{item.detail}</p>
            </div>
            <Link
              to={`/fund/${item.fund.id}${item.tab ? `?tab=${item.tab}` : ""}`}
              className="shrink-0 rounded-full border bg-card px-3 py-1.5 text-label hover:bg-secondary"
            >
              {item.kind === "owed" ? "Withdraw" : item.kind === "setup" ? "Finish setup" : "Open fund"}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function HeldRow({ position, share }: { position: FundPosition; share: number | null }) {
  const { fund } = position;
  return (
    <li className="relative grid gap-x-6 gap-y-2 px-5 py-4 hover:bg-secondary/40 sm:grid-cols-[minmax(0,1fr)_auto_8rem] sm:items-center">
      <div className="flex min-w-0 items-center gap-3">
        <FundAvatar fund={fund} />
        <div className="min-w-0">
          <Link to={`/fund/${fund.id}`} className="block truncate font-medium after:absolute after:inset-0 hover:text-primary">
            {fund.name}
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-filing text-muted-foreground">{fund.symbol}</span>
            <TrustTag fund={fund} />
            <ImitationChip fund={fund} />
          </div>
        </div>
      </div>
      <div className="num text-[0.875rem] text-muted-foreground sm:text-right">
        {position.shares > 0n ? shares(position.shares) : "no shares"}
        {position.owed.length > 0 && (
          <span className="block font-sans text-[0.8125rem] text-warning">
            owed {position.owed.map((o) => `${formatAmount(o.amount)} ${o.component.code}`).join(", ")}
          </span>
        )}
      </div>
      <div className="sm:text-right">
        {position.shares > 0n ? <Usd value={position.valueUsd} className="text-[1.0625rem]" /> : <span className="text-muted-foreground">n/a</span>}
        {share !== null && (
          <div className="mt-1.5 flex items-center gap-2 sm:justify-end">
            <span className="h-1 w-16 overflow-hidden rounded-full bg-secondary" aria-hidden>
              <span className="block h-full rounded-full" style={{ width: `${Math.max(2, share * 100)}%`, background: strandColor(0) }} />
            </span>
            <span className="num text-[0.75rem] text-muted-foreground">{(share * 100).toFixed(1)}%</span>
          </div>
        )}
      </div>
    </li>
  );
}

function Held({ data }: { data: Portfolio }) {
  if (!data.positions.length) {
    return (
      <div className="panel rounded-2xl px-5 py-8 text-center">
        <p className="text-muted-foreground">This address doesn't hold shares in any Alloy fund yet.</p>
        <Link to="/funds" className="mt-2 inline-block text-primary underline-offset-4 hover:underline">
          Browse funds
        </Link>
      </div>
    );
  }
  return (
    <ul className="panel divide-y overflow-hidden rounded-2xl">
      {data.positions.map((p) => (
        <HeldRow key={p.fund.id} position={p} share={data.totalUsd > 0 && p.valueUsd !== null ? p.valueUsd / data.totalUsd : null} />
      ))}
    </ul>
  );
}

function Managed({ data }: { data: Portfolio }) {
  return (
    <ul className="panel divide-y overflow-hidden rounded-2xl">
      {data.managed.map((fund) => {
        const aum = fundValueUsd(fund);
        const { value } = headlineValue(fund);
        return (
          <li key={fund.id} className="grid gap-x-6 gap-y-2 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-center">
            <div className="flex min-w-0 items-center gap-3">
              <FundAvatar fund={fund} />
              <div className="min-w-0">
                <div className="truncate font-medium">{fund.name}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-filing text-muted-foreground">{fund.symbol}</span>
                  <TrustTag fund={fund} />
                  <ImitationChip fund={fund} />
                  <span className="text-[0.75rem] text-muted-foreground">{complianceLabel(fund)}</span>
                  {fund.hidden && (
                    <span className="chip px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground" title="Left out of the public fund lists; still open by link">
                      hidden
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="text-[0.875rem] sm:text-right">
              <span className="num">{fund.totalSupply === 0n ? "no shares yet" : aum !== null ? `$${formatUsd(aum)} AUM` : shares(fund.totalSupply)}</span>
              <span className="block text-[0.75rem] text-muted-foreground">
                {value === null ? "unpriced" : `$${formatUsd(value)} per share`}
              </span>
            </div>
            <Link to={`/fund/${fund.id}?tab=manage`} className="justify-self-start rounded-full border bg-card px-3 py-1.5 text-label hover:bg-secondary sm:justify-self-end">
              Manage
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function SectionTitle({ children, note }: { children: ReactNode; note?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="font-display text-[1.375rem] font-semibold">{children}</h2>
      {note && <span className="text-[0.8125rem] text-muted-foreground">{note}</span>}
    </div>
  );
}

export function PortfolioPage() {
  const { address, connect, connecting } = useWallet();
  const data = useAsync(() => portfolio(address ?? "", true), deployments && address ? address : null);
  const p = data.data;

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-[clamp(1.75rem,4.5vw,2.5rem)] leading-[1.08] font-semibold">Portfolio</h1>
          <p className="mt-2 max-w-[38rem] text-muted-foreground">
            Your shares, owed claims and managed funds across every Alloy fund, read from the ledger.
          </p>
        </div>
        {address && <CopyId id={address} kind="account" />}
      </div>

      {!address ? (
        <div className="panel mt-8 rounded-2xl px-5 py-12 text-center">
          <p className="text-heading">Connect a wallet to see your funds</p>
          <p className="mx-auto mt-1 max-w-[30rem] text-muted-foreground">
            Alloy reads your share balances and owed claims straight from each fund contract. Nothing is stored about you.
          </p>
          <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
            <Button onClick={connect} busy={connecting}>Connect wallet</Button>
            <Link to="/funds" className="text-label text-primary underline-offset-4 hover:underline">
              Browse funds
            </Link>
          </div>
        </div>
      ) : data.error != null && !p ? (
        <div className="panel mt-8 rounded-2xl px-5 py-8">
          <p className="text-muted-foreground">Couldn't read your positions from the network. {explain(data.error)}</p>
          <button type="button" onClick={data.reload} className="mt-2 text-primary underline-offset-4 hover:underline">
            Try again
          </button>
        </div>
      ) : (
        <div className="mt-8 space-y-10">
          <Summary data={p} />
          {p && p.attention.length > 0 && <AttentionList items={p.attention} />}
          <section>
            <SectionTitle note="valued at each fund's oracle NAV, or its Stellar DEX value where there is none">Held funds</SectionTitle>
            {p ? <Held data={p} /> : <div className="skeleton h-40 w-full rounded-2xl" />}
          </section>
          {p && p.managed.length > 0 && (
            <section>
              <SectionTitle>Funds you manage</SectionTitle>
              <Managed data={p} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

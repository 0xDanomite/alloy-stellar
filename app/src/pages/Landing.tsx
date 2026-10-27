import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FundCard, SkeletonCard } from "../components/fund-bits";
import { ArrowLeft, ArrowRight, Banknote, Grid, Layers, Lock, Plus, Scale, Shield, Swap, Users } from "../components/icons";
import { availableNetworks, deployments, links, network, oracles, switchNetwork, type Network } from "../lib/config";
import { formatAmount, formatUsd, unitsToNumber } from "../lib/format";
import { legPrice, platformTotals } from "../lib/fund-math";
import { DEMO_ISSUER_LABEL } from "../lib/issuers";
import { explain, listFunds, type Fund } from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { listedFunds } from "../lib/visibility";

const BUILT_ON_STELLAR = [
  {
    term: "Soroban contracts",
    body: "Each fund is a token contract that holds its basket directly. Deposits and redemptions settle on the ledger, and no manager can switch redemption off.",
  },
  {
    term: "Stellar Asset Contracts",
    body: "USDC (circle.com), USDY (ondo.finance), USTRY and CETES (etherfuse.com) and BENJI (franklintempleton.com) are classic Stellar assets. A fund holds them through each asset's built-in contract, the same balances your wallet shows.",
  },
  {
    term: "Issuer authorization and clawback",
    body: "Issuers that approve each holder have to approve the fund too, and those that can claw back still can. Share value is read from what the fund actually holds, so it stays right after a clawback.",
  },
  {
    term: "Oracle prices",
    body: "RedStone and Reflector price each asset through SEP-40 feeds. A read-only NAV contract falls back from one oracle to the other when a feed goes stale and reports how far apart they are. Issue and redeem never consult a price.",
  },
  {
    term: "SDEX path payments",
    body: "Buying the basket goes through Stellar's built-in exchange in one transaction, routed directly or through USDC, then you deposit it into the fund in a second.",
  },
  {
    term: "Soroswap",
    body: "A stateless swap contract buys every asset through Soroswap's router and deposits the basket in the same transaction, or redeems and sells it back to USDC. One signature either way, and it holds nothing between calls.",
  },
];

const NETWORK_NAME: Record<Network, string> = { mainnet: "Stellar Mainnet", testnet: "Testnet" };

function LiveOn() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
      <span className="text-filing text-muted-foreground">Live on</span>
      {availableNetworks.map((n) => {
        const active = n === network;
        return (
          <button
            key={n}
            type="button"
            onClick={() => !active && switchNetwork(n)}
            aria-pressed={active}
            className={`inline-flex items-center gap-2 text-[0.875rem] ${active ? "text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <span className={`size-2 rounded-full ${n === "mainnet" ? "bg-gold" : "bg-primary"}`} aria-hidden />
            {NETWORK_NAME[n]}
          </button>
        );
      })}
    </div>
  );
}

function FundCarousel({ funds, loading }: { funds: Fund[] | undefined; loading: boolean }) {
  const [index, setIndex] = useState(0);
  if (!funds) return loading ? <SkeletonCard featured /> : null;
  const active = funds.length ? index % funds.length : 0;
  const current = funds[active];
  if (!current) return null;
  const step = (d: number) => setIndex((i) => (i + d + funds.length) % funds.length);
  return (
    <div>
      <div key={current.id} className="content-fade">
        <FundCard fund={current} featured />
      </div>
      {funds.length > 1 && (
        <div className="mt-4 flex items-center justify-center gap-3">
          <button type="button" onClick={() => step(-1)} className="panel grid size-8 place-items-center rounded-full hover:text-primary" aria-label="Previous fund">
            <ArrowLeft className="size-4" />
          </button>
          <div className="flex items-center gap-1.5">
            {funds.map((f, i) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Show ${f.symbol}`}
                aria-current={i === active}
                className={`h-1.5 rounded-full transition-[width,background-color] ${i === active ? "w-5 bg-foreground" : "w-1.5 bg-muted-foreground/40"}`}
              />
            ))}
          </div>
          <button type="button" onClick={() => step(1)} className="panel grid size-8 place-items-center rounded-full hover:text-primary" aria-label="Next fund">
            <ArrowRight className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ icon, value, label }: { icon: ReactNode; value: ReactNode; label: ReactNode }) {
  return (
    <div className="flex items-center gap-3.5 px-5 py-4 sm:px-6">
      <span className="grid size-10 shrink-0 place-items-center rounded-full border text-muted-foreground">{icon}</span>
      <div className="min-w-0">
        <div className="num text-[1.25rem] leading-tight">{value}</div>
        <div className="text-[0.8125rem] text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

function StatsStrip({ funds }: { funds: Fund[] | undefined }) {
  const totals = funds ? platformTotals(funds) : null;
  const skeleton = <span className="skeleton w-[7ch]">0</span>;
  return (
    <div className="panel grid divide-y rounded-2xl sm:grid-cols-3 sm:divide-x sm:divide-y-0">
      <Stat
        icon={<Banknote />}
        value={totals ? `$${formatUsd(totals.valueUsd)}` : skeleton}
        label={
          totals && totals.unpriced.length
            ? `under management (${totals.unpriced.map((f) => f.symbol).join(", ")} unpriced)`
            : "under management"
        }
      />
      <Stat icon={<Grid />} value={funds ? funds.length : skeleton} label="funds live" />
      <Stat icon={<Lock />} value="100%" label="onchain custody" />
    </div>
  );
}

function ValueCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className="panel rounded-2xl p-5 sm:p-6">
      <span className="text-primary">{icon}</span>
      <h3 className="mt-4 font-medium">{title}</h3>
      <p className="mt-2 text-[0.875rem] text-muted-foreground">{children}</p>
    </div>
  );
}

function SectionHead({ filing, title, center = true }: { filing: string; title: string; center?: boolean }) {
  return (
    <div className={center ? "text-center" : ""}>
      <p className="text-filing text-muted-foreground">{filing}</p>
      <h2 className="mt-2 font-display text-[clamp(1.625rem,3.5vw,2.125rem)] leading-tight font-semibold">{title}</h2>
    </div>
  );
}

function Seat({ filing, title, steps }: { filing: string; title: string; steps: { icon: ReactNode; title: string; body: string }[] }) {
  return (
    <div className="panel rounded-2xl p-6 sm:p-8">
      <p className="text-filing text-muted-foreground">{filing}</p>
      <h3 className="mt-2 font-display text-[1.375rem] leading-snug font-semibold">{title}</h3>
      <ol className="mt-6 space-y-6">
        {steps.map((s, i) => (
          <li key={s.title} className="flex gap-4">
            <span className="grid size-9 shrink-0 place-items-center rounded-full border text-muted-foreground">{s.icon}</span>
            <div>
              <h4 className="font-medium">
                <span className="num mr-2 text-[0.75rem] text-muted-foreground">{i + 1}</span>
                {s.title}
              </h4>
              <p className="mt-1 text-[0.875rem] text-muted-foreground">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function PriceExample({ fund }: { fund: Fund | undefined }) {
  const priced = fund && fund.navPerShare !== null ? fund : undefined;
  return (
    <div className="panel rounded-2xl px-5 py-10 text-center sm:px-10">
      <SectionHead filing="Nobody sets the price" title="The holdings do." />
      <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
        {priced ? (
          <>
            {priced.components.map((leg, i) => {
              const price = legPrice(priced, leg);
              const value = price === null ? null : unitsToNumber(leg.unitsPerShare) * price;
              return (
                <span key={leg.token} className="contents">
                  {i > 0 && <span className="text-muted-foreground" aria-hidden>+</span>}
                  <span className="chip num rounded-full px-3 py-1.5 text-[0.8125rem]">
                    {formatAmount(leg.unitsPerShare)} {leg.code}
                    <span className="text-muted-foreground">{value === null ? "unpriced" : `$${value.toFixed(2)}`}</span>
                  </span>
                </span>
              );
            })}
            <span className="text-muted-foreground" aria-hidden>=</span>
            <span className="num rounded-full border-2 border-primary px-3.5 py-1.5 text-[0.875rem] font-medium">
              ${formatUsd(priced.navPerShare ?? 0)} per {priced.symbol}
            </span>
          </>
        ) : (
          <span className="skeleton h-9 w-full max-w-xl rounded-full" />
        )}
      </div>
      <p className="mx-auto mt-8 max-w-[44rem] text-[0.9375rem] text-muted-foreground">
        A share's value is exactly what its slice of the vault is worth. Each asset is priced by{" "}
        <a href={oracles.redstone.url} target="_blank" rel="noreferrer" className="text-foreground underline-offset-4 hover:underline">RedStone</a> or{" "}
        <a href={oracles.reflector.url} target="_blank" rel="noreferrer" className="text-foreground underline-offset-4 hover:underline">Reflector</a>{" "}
        through SEP-40 feeds, read live by Alloy's NAV contract. Deposits mint shares for the assets themselves and
        redemptions return them, so flows change the fund's size, never its price. Anyone can re-run the arithmetic.
      </p>
    </div>
  );
}

export function Landing() {
  const funds = useAsync(() => listFunds().then((all) => listedFunds(all)), deployments ? network : null);
  const flagship = funds.data?.find((f) => f.navPerShare !== null) ?? funds.data?.[0];
  const codes = funds.data ? [...new Set(funds.data.flatMap((f) => f.components.filter((c) => c.verified && c.issuerLabel !== DEMO_ISSUER_LABEL).map((c) => c.code)))] : [];

  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pt-14 pb-12 sm:px-6 lg:grid-cols-[1.15fr_1fr] lg:gap-16 lg:pt-24 lg:pb-16">
        <div className="min-w-0">
          <span className="text-filing inline-block rounded-full border px-3 py-1 text-muted-foreground">Portfolios, forged on Stellar</span>
          <h1 className="mt-6 font-display text-[clamp(2.5rem,7vw,4.25rem)] leading-[1.02] font-semibold">
            Built from many.
            <span className="block text-primary">Managed as one.</span>
          </h1>
          <p className="mt-6 max-w-[32rem] text-[1.0625rem] leading-relaxed text-muted-foreground">
            Wealth managers build funds out of Stellar's tokenized treasuries, stablecoins and money-market funds. One
            token holds the whole mix: invest from your wallet, check every holding on the ledger, and redeem any time
            for the assets underneath.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <a href="#funds" className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-label text-primary-foreground shadow-sm hover:opacity-90">
              Explore funds
              <ArrowRight className="size-4" />
            </a>
            <Link to="/built" className="inline-flex min-h-11 items-center rounded-full border px-5 text-label hover:bg-secondary">
              What we built
            </Link>
          </div>
          <div className="mt-10">
            <LiveOn />
          </div>
        </div>
        <div className="mx-auto w-full max-w-[26rem] lg:mr-0">
          <FundCarousel funds={funds.data} loading={funds.loading} />
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 sm:px-6">
        <StatsStrip funds={funds.data} />
        <div className="mt-12 grid gap-4 md:grid-cols-3">
          <ValueCard icon={<Layers />} title="One token, a real mix">
            Hold {codes.length ? codes.join(", ") : "Stellar's tokenized assets"} in one fund token, at fixed amounts per
            share, inside a public Soroban contract.
          </ValueCard>
          <ValueCard icon={<Scale />} title="Redeem anytime">
            Burn shares for your exact slice of every asset the fund holds. Redemption is in kind, and no manager can
            switch it off.
          </ValueCard>
          <ValueCard icon={<Shield />} title="Issuer rails, respected">
            Permissioned assets like BENJI need their issuer to approve the fund, and issuers keep clawback. Share value
            is read from actual balances, so it stays right after one.
          </ValueCard>
        </div>
      </section>

      <section id="funds" className="mx-auto max-w-6xl scroll-mt-20 px-4 pt-20 sm:px-6">
        <SectionHead filing="Live funds" title="Pick a portfolio." />
        <p className="mx-auto mt-3 max-w-prose text-center text-muted-foreground">
          Read live from the Alloy platform contract. Only funds the platform created appear here.
        </p>
        {!deployments && (
          <p className="panel mt-8 rounded-xl px-4 py-3">This build has no deployment for {network} yet.</p>
        )}
        {funds.error != null && (
          <div className="panel mt-8 rounded-xl px-4 py-3">
            <p>Couldn't read the funds from the network. {explain(funds.error)}</p>
            <button type="button" onClick={funds.reload} className="mt-2 text-primary underline-offset-4 hover:underline">
              Try again
            </button>
          </div>
        )}
        <div className="mt-10 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {funds.data
            ? funds.data.map((fund) => <FundCard key={fund.id} fund={fund} />)
            : funds.loading && [0, 1, 2].map((i) => <SkeletonCard key={i} />)}
        </div>
        {funds.data?.length === 0 && <p className="mt-2 text-center text-muted-foreground">No funds on this platform yet.</p>}
      </section>

      <section className="mx-auto max-w-6xl px-4 pt-24 sm:px-6">
        <SectionHead filing="How it works" title="Two seats, one vault." />
        <div className="mt-10 grid gap-4 lg:grid-cols-2">
          <Seat
            filing="For investors"
            title="Own a portfolio, not a spreadsheet."
            steps={[
              { icon: <Grid className="size-4" />, title: "Pick a fund", body: "Every fund shows its holdings, issuers and oracle prices, read live from Stellar." },
              { icon: <Swap className="size-4" />, title: "Invest with USDC in one signature", body: "The exact mix is bought on Soroswap and deposited for you. Funds holding an asset with no pool take the basket in kind instead." },
              { icon: <Scale className="size-4" />, title: "Hold or redeem", body: "One token backed by its share of the vault. Redeem for the assets themselves, or straight to USDC, whenever you like." },
            ]}
          />
          <Seat
            filing="For managers"
            title="Launch a fund with its rules attached."
            steps={[
              { icon: <Plus className="size-4" />, title: "Create a fund", body: "Choose assets from the platform's approved shelf and set how much of each backs one share. Creation is open to approved managers." },
              { icon: <Users className="size-4" />, title: "Choose who can hold it", body: "Open to anyone, or to approved investors only. The rule lives in the fund contract." },
              { icon: <Shield className="size-4" />, title: "Work with issuers", body: "Permissioned assets need their issuer to authorize the fund. The fund page shows what is still pending." },
            ]}
          />
        </div>
        <div className="mt-6 text-center">
          <Link to="/how" className="inline-flex min-h-10 items-center gap-2 rounded-full border px-4 text-label hover:bg-secondary">
            See the whole system
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 pt-24 sm:px-6">
        <PriceExample fund={flagship} />
      </section>

      <section className="mx-auto max-w-6xl px-4 py-24 sm:px-6">
        <SectionHead filing="Under the hood" title="Built on Stellar." center={false} />
        <dl className="mt-10 grid gap-4 md:grid-cols-2">
          {BUILT_ON_STELLAR.map((item) => (
            <div key={item.term} className="panel rounded-2xl p-5 sm:p-6 md:last:odd:col-span-2">
              <dt className="font-medium">{item.term}</dt>
              <dd className="mt-2 text-[0.875rem] text-muted-foreground">{item.body}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-10 flex flex-wrap gap-3">
          <a href={links.repo} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-full border px-4 text-label hover:bg-secondary">
            Read the source on GitHub
          </a>
          {links.deck && (
            <a href={links.deck} target="_blank" rel="noreferrer" className="inline-flex min-h-10 items-center rounded-full border px-4 text-label hover:bg-secondary">
              View the deck
            </a>
          )}
        </div>
      </section>
    </>
  );
}

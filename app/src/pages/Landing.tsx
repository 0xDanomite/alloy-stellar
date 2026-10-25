import { Link } from "react-router-dom";
import { FundCard, SkeletonCard, strandColor } from "../components/fund-bits";
import { deployments, links, network, oracles } from "../lib/config";
import { explain, listFunds, type Fund } from "../lib/stellar";
import { useAsync } from "../lib/use-async";

function Strands({ fund }: { fund: Fund | undefined }) {
  const codes = fund?.components.map((c) => c.code) ?? ["", "", ""];
  const n = codes.length;
  const top = 40;
  const span = 240;
  const joinX = 330;
  const joinY = 160;
  return (
    <svg viewBox="0 0 560 320" className="h-auto w-full" role="img" aria-label={fund ? `${codes.join(", ")} combined into one ${fund.symbol} share` : "Assets combining into one fund share"}>
      {codes.map((code, i) => {
        const y = n === 1 ? joinY : top + (span * i) / (n - 1);
        return (
          <g key={`${code}-${i}`}>
            <path
              d={`M 96 ${y} C 220 ${y}, 240 ${joinY}, ${joinX} ${joinY}`}
              fill="none"
              stroke={strandColor(i)}
              strokeWidth="7"
              strokeLinecap="round"
              pathLength={1}
              className="strand"
              style={{ animationDelay: `${i * 90}ms` }}
            />
            <text x="84" y={y + 5} textAnchor="end" className="num fill-foreground text-[15px]">
              {code}
            </text>
          </g>
        );
      })}
      <path
        d={`M ${joinX} ${joinY} H 470`}
        fill="none"
        stroke="var(--foreground)"
        strokeWidth="14"
        strokeLinecap="round"
        pathLength={1}
        className="strand"
        style={{ animationDelay: `${n * 90 + 200}ms` }}
      />
      {fund && (
        <text x="486" y={joinY + 7} className="font-display fill-foreground text-[22px] font-semibold content-fade">
          {fund.symbol}
        </text>
      )}
    </svg>
  );
}

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
];

export function Landing() {
  const funds = useAsync(() => listFunds(), deployments ? network : null);
  const featured = funds.data?.[0];

  return (
    <>
      <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 pt-12 pb-16 sm:px-6 lg:grid-cols-[1.1fr_1fr] lg:pt-20 lg:pb-24">
        <div>
          <h1 className="font-display text-[clamp(2.25rem,6vw,3.75rem)] leading-[1.02] font-semibold">
            Portfolios built from Stellar's real-world assets.
          </h1>
          <p className="mt-6 max-w-[34rem] text-[1.0625rem] text-muted-foreground">
            Wealth managers build funds out of Stellar's tokenized treasuries, stablecoins and money-market funds.
            One share holds the whole basket, and investors can always redeem it for the assets underneath.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#funds" className="inline-flex min-h-11 items-center rounded-md bg-primary px-5 text-label text-primary-foreground hover:opacity-90">
              See the funds
            </a>
            <Link to="/built" className="inline-flex min-h-11 items-center rounded-md border bg-card px-5 text-label hover:bg-secondary">
              What we built at HackMeridian
            </Link>
          </div>
        </div>
        <div className="mx-auto w-full max-w-[560px]">
          <Strands fund={featured} />
        </div>
      </section>

      <section id="funds" className="scroll-mt-20 border-t bg-surface-sunken">
        <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-title">Funds</h2>
              <p className="mt-1 max-w-prose text-muted-foreground">
                Read live from the Alloy platform contract. Only funds the platform created appear here.
              </p>
            </div>
          </div>

          {!deployments && (
            <p className="mt-8 rounded-md border bg-card px-4 py-3">
              This build has no deployment for {network} yet.
            </p>
          )}
          {funds.error != null && (
            <div className="mt-8 rounded-md border bg-card px-4 py-3">
              <p>Couldn't read the funds from the network. {explain(funds.error)}</p>
              <button type="button" onClick={funds.reload} className="mt-2 text-primary underline-offset-4 hover:underline">
                Try again
              </button>
            </div>
          )}
          <div className="mt-8 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {funds.data
              ? funds.data.map((fund) => <FundCard key={fund.id} fund={fund} />)
              : funds.loading && [0, 1, 2].map((i) => <SkeletonCard key={i} />)}
          </div>
          {funds.data?.length === 0 && (
            <p className="mt-2 text-muted-foreground">No funds on this platform yet.</p>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <h2 className="text-title">Built on Stellar</h2>
        <dl className="mt-8 grid gap-x-12 gap-y-8 md:grid-cols-2">
          {BUILT_ON_STELLAR.map((item) => (
            <div key={item.term} className="border-t pt-4">
              <dt className="text-heading">{item.term}</dt>
              <dd className="mt-2 max-w-[38rem] text-muted-foreground">{item.body}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-8 text-[0.9375rem] text-muted-foreground">
          Prices: <a href={oracles.redstone.url} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">RedStone</a> and{" "}
          <a href={oracles.reflector.url} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">Reflector</a> oracles
        </p>
        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-label">
          <a href={links.repo} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
            Read the source on GitHub
          </a>
          {links.deck && (
            <a href={links.deck} target="_blank" rel="noreferrer" className="text-primary underline-offset-4 hover:underline">
              View the deck
            </a>
          )}
        </div>
      </section>
    </>
  );
}

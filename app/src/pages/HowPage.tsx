import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Banknote, Clock, Coins, Exit, Eye, Key, Layers, Lock, Percent, Plus, Scale, Shield, Swap, Wallet } from "../components/icons";
import { SystemMap } from "../components/SystemMap";
import { links, platforms } from "../lib/config";
import { formatAmount, formatUsd, unitsToNumber } from "../lib/format";
import { legPrice } from "../lib/fund-math";
import { findFund, type Fund } from "../lib/stellar";
import { useAsync } from "../lib/use-async";

const EXAMPLE_SYMBOL = "aLQD";
const EXAMPLE_FUND_ID = platforms.map((p) => p.launched[EXAMPLE_SYMBOL]).find((id) => id !== undefined) ?? null;

function SectionHead({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h2 className="font-display text-[clamp(1.375rem,3vw,1.75rem)] leading-tight font-semibold">{title}</h2>
      <p className="mt-2 max-w-[40rem] text-muted-foreground">{children}</p>
    </div>
  );
}

function StepArrow() {
  return (
    <div className="flex items-center justify-center text-muted-foreground/60" aria-hidden>
      <ArrowRight className="hidden size-4 shrink-0 md:block" />
      <ArrowRight className="size-4 shrink-0 rotate-90 md:hidden" />
    </div>
  );
}

interface Step {
  icon: ReactNode;
  title: string;
  body: ReactNode;
}

function StepRow({ steps, note }: { steps: Step[]; note: ReactNode }) {
  return (
    <>
      <ol className="mt-6 flex flex-col gap-2 md:flex-row md:items-stretch">
        {steps.map((s, i) => (
          <li key={s.title} className="contents">
            {i > 0 && <StepArrow />}
            <div className="panel flex-1 rounded-2xl p-4">
              <div className="flex items-center gap-2 text-primary">
                {s.icon}
                <span className="num text-[0.6875rem] text-muted-foreground">step {i + 1}</span>
              </div>
              <h3 className="mt-2.5 text-[0.9375rem] leading-snug font-medium">{s.title}</h3>
              <p className="mt-1 text-[0.8125rem] leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-3 rounded-xl border border-dashed px-4 py-3 text-center text-[0.8125rem] text-muted-foreground">{note}</p>
    </>
  );
}

function GlassItem({ icon, term, children }: { icon: ReactNode; term: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 shrink-0 text-primary">{icon}</span>
      <span>
        <span className="font-medium">{term}</span> <span className="text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

function Chip({ children, strong = false }: { children: ReactNode; strong?: boolean }) {
  return (
    <span
      className={`num rounded-full px-3 py-1.5 text-[0.8125rem] ${strong ? "border-2 border-primary font-medium" : "chip"}`}
    >
      {children}
    </span>
  );
}

/** An operator travels with the term after it, so a wrapped line never ends on a dangling "+". */
function Term({ op, children }: { op: "+" | "=" | null; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2">
      {op && (
        <span className="text-muted-foreground" aria-hidden>
          {op}
        </span>
      )}
      {children}
    </span>
  );
}

/** One share of a live fund, leg by leg, summed to its NAV. */
function LiveEquation({ fund }: { fund: Fund }) {
  const perShare = fund.navPerShare ?? fund.valuePerShare;
  return (
    <>
      {fund.components.map((leg, i) => {
        const price = legPrice(fund, leg);
        const value = price === null ? null : unitsToNumber(leg.unitsPerShare) * price;
        return (
          <Term key={leg.token} op={i > 0 ? "+" : null}>
            <Chip>
              {formatAmount(leg.unitsPerShare)} {leg.code}{" "}
              <span className="text-muted-foreground">{value === null ? "unpriced" : `$${value.toFixed(2)}`}</span>
            </Chip>
          </Term>
        );
      })}
      <Term op="=">
        <Chip strong>{perShare === null ? "unpriced" : `$${formatUsd(perShare)} per ${fund.symbol}`}</Chip>
      </Term>
    </>
  );
}

function StaticEquation() {
  return (
    <>
      <Term op={null}>
        <Chip>units of asset A × its price</Chip>
      </Term>
      <Term op="+">
        <Chip>units of asset B × its price</Chip>
      </Term>
      <Term op="+">
        <Chip>…</Chip>
      </Term>
      <Term op="=">
        <Chip strong>NAV per share</Chip>
      </Term>
    </>
  );
}

function PriceSection() {
  const example = useAsync(() => findFund(EXAMPLE_FUND_ID ?? ""), EXAMPLE_FUND_ID ? `how:${EXAMPLE_FUND_ID}` : null);
  const fund = example.data && example.data.components.length > 0 ? example.data : null;
  return (
    <section className="mt-20" aria-label="How the price works">
      <SectionHead title="How the price works">Nobody sets the price. It's arithmetic anyone can check.</SectionHead>
      <div className="panel mt-6 rounded-2xl p-5 sm:p-6">
        <p className="text-filing text-center text-muted-foreground">
          {fund ? `one ${fund.symbol} share holds, live from Stellar` : `one fund share holds`}
        </p>
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {fund ? <LiveEquation fund={fund} /> : example.loading ? <span className="skeleton h-9 w-full max-w-xl rounded-full" /> : <StaticEquation />}
        </div>
        <p className="mx-auto mt-5 max-w-[40rem] text-center text-[0.8125rem] leading-relaxed text-muted-foreground">
          That sum is the net asset value, the NAV. The fund's holdings are public balances and the oracle prices are
          read onchain by Alloy's NAV contract, so anyone can redo this math at any second and get the number we show.
        </p>
        <div className="mt-6 grid gap-5 border-t pt-5 md:grid-cols-3">
          <div>
            <h3 className="text-[0.875rem] font-medium">Where the first price comes from</h3>
            <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
              It's defined, not discovered. At launch the manager sets how much of each asset backs the first share, and
              that slice is worth whatever its assets are worth. The size is a choice, like an index picking its base
              level: launch the same fund at $1 or $100 and every investor ends up with the same outcome, in more or
              fewer slices.
            </p>
          </div>
          <div>
            <h3 className="text-[0.875rem] font-medium">What moves it</h3>
            <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
              What the fund holds. Oracle prices move it minute to minute; rebalances change what it holds next; the
              management fee trims it by its stated rate; an issuer clawback lowers it for every holder alike, because
              the books are read from real balances. A fund that launched at $1 and now reads $1.08 has returned 8%.
            </p>
          </div>
          <div>
            <h3 className="text-[0.875rem] font-medium">What never moves it</h3>
            <p className="mt-1.5 text-[0.8125rem] leading-relaxed text-muted-foreground">
              Buying and selling. A deposit adds its exact slice of every asset and mints shares for it, and a
              redemption takes its slice back out, so the value per share holds. Issue and redeem never consult a price,
              and rounding always favors the fund. Demand changes the fund's size, never its price.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

const GUARANTEES: { icon: ReactNode; title: string; body: string }[] = [
  {
    icon: <Scale />,
    title: "Solvent by construction",
    body: "Shares only come into existence when the matching assets enter the fund. There is no way to mint an unbacked share, so whether the assets are really there is never a question.",
  },
  {
    icon: <Exit />,
    title: "You can always leave",
    body: "Redeeming for your slice of the assets has no pause and no permission step. If an issuer freezes one asset, you skip it, take the rest, and claim the frozen one later.",
  },
  {
    icon: <Eye />,
    title: "See-through, always",
    body: "The fund is a public contract. Holdings, trades and fees are on the ledger for anyone to inspect, at any moment, not quarterly and not on request.",
  },
  {
    icon: <Shield />,
    title: "The manager can't run off with it",
    body: "Managers change what the fund holds, never where it goes. On Stellar the mandate and the oracle-bounded trade limits are enforced onchain today: 99% of oracle value per trade, and no more than 2% of the fund lost in a day.",
  },
  {
    icon: <Lock />,
    title: "Terms are final before you buy",
    body: "The fee and the mandate can only be set while a fund is closed. Once it opens to investors, the terms you bought into can't change.",
  },
  {
    icon: <Key />,
    title: "Issuer rails, respected",
    body: "Permissioned assets like BENJI need their issuer to approve the fund, and issuers keep clawback. Share value is read from actual balances, so it stays right after one.",
  },
];

export function HowPage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:py-16">
      <header className="text-center">
        <p className="text-filing text-muted-foreground">Alloy · how it works</p>
        <h1 className="mx-auto mt-4 max-w-[46rem] font-display text-[clamp(2rem,5vw,3.25rem)] leading-[1.05] font-semibold">
          A fund is a token. Its contract holds real assets.
        </h1>
        <p className="mx-auto mt-4 max-w-[36rem] text-[1.0625rem] text-muted-foreground">
          You can see the assets any second, and you can always leave. Here is the whole system, one picture at a time.
        </p>
      </header>

      <section className="mt-14" aria-label="System map">
        <SystemMap />
      </section>

      <section className="mt-20" aria-label="For investors">
        <SectionHead title="If you're investing">One dollar amount in, one token out. The splitting happens for you.</SectionHead>
        <StepRow
          steps={[
            { icon: <Banknote className="size-4" />, title: "You pay USDC", body: "From any Stellar wallet, in one signature. You never need to touch the underlying assets." },
            { icon: <Swap className="size-4" />, title: "Alloy buys the basket on Soroswap", body: "Your USDC becomes the fund's exact recipe, bought in the same transaction through a contract that holds nothing between calls." },
            { icon: <Lock className="size-4" />, title: "The fund contract holds it", body: "The assets go into the fund's own Soroban contract. Not our wallet, not the manager's. Anyone can inspect it." },
            { icon: <Coins className="size-4" />, title: "You hold one token", body: "Each SEP-41 share is a claim on its exact slice of every asset. Redeem any time, no permission needed." },
          ]}
          note="Withdrawing is the same flow in reverse: burn your shares, the fund releases your slice, and you take it as USDC or as the assets themselves."
        />
      </section>

      <section className="mt-20" aria-label="For managers">
        <SectionHead title="If you're running a fund">Describe a basket in percentages. Everything else is a button.</SectionHead>
        <StepRow
          steps={[
            { icon: <Percent className="size-4" />, title: "Write the recipe", body: "Pick assets from the platform's approved shelf, set the weights, choose a mandate and an annual fee of up to 5%." },
            { icon: <Plus className="size-4" />, title: "The fund goes live", body: "The recipe becomes its own Soroban contract. Open it to investors when you're ready; fee and mandate lock when you do." },
            { icon: <Swap className="size-4" />, title: "Rebalance in percentages", body: "Type the mix you want. Trades settle inside the fund, bounded by oracle prices, with a 2% per day loss budget." },
            { icon: <Wallet className="size-4" />, title: "Get paid", body: "Your fee accrues continuously, paid in fund shares. Nothing to invoice and nothing that expires." },
          ]}
          note="The manager steers but never holds the money. Rebalancing moves value between assets inside the fund, never out of it."
        />
      </section>

      <section className="mt-20" aria-label="Onchain vs offchain">
        <SectionHead title="What's onchain vs what isn't">
          Onchain means no one, including us, can fudge it. Everything that touches money lives there.
        </SectionHead>
        <div className="mt-6 grid gap-4 lg:grid-cols-[3fr_2fr]">
          <div className="panel rounded-2xl border-2 border-primary/50 p-5 sm:p-6">
            <div className="flex items-center gap-2 text-primary">
              <Shield className="size-4" />
              <h3 className="text-heading text-foreground">Onchain, the glass box</h3>
            </div>
            <ul className="mt-4 space-y-3 text-[0.875rem]">
              <GlassItem icon={<Layers className="size-4" />} term="The fund contract">
                holds every asset, mints shares on deposit and burns them on redemption. Solvent by construction.
              </GlassItem>
              <GlassItem icon={<Swap className="size-4" />} term="The trade rails">
                swap assets inside the fund on Soroswap and the Stellar DEX, each trade held to 99% of oracle value.
              </GlassItem>
              <GlassItem icon={<Percent className="size-4" />} term="The fee meter">
                pays the manager in new shares at the rate frozen at launch, at most 5% a year.
              </GlassItem>
              <GlassItem icon={<Clock className="size-4" />} term="The timelock">
                makes every platform admin change wait in public before it runs.
              </GlassItem>
              <GlassItem icon={<Eye className="size-4" />} term="Every action on the ledger">
                deposits, redemptions, trades and fees: a permanent public record on Stellar.
              </GlassItem>
            </ul>
          </div>
          <div className="rounded-2xl border border-dashed p-5 sm:p-6">
            <div className="flex items-center gap-2 text-muted-foreground">
              <Wallet className="size-4" />
              <h3 className="text-heading">Offchain, conveniences</h3>
            </div>
            <ul className="mt-4 space-y-3 text-[0.875rem] text-muted-foreground">
              <li>
                <span className="font-medium text-foreground">This app</span> reads the ledger and prepares transactions. If
                it vanished tomorrow, your money is untouched and still redeemable.
              </li>
              <li>
                <span className="font-medium text-foreground">Price displays</span> are dollar figures for your
                convenience. Issuing and redeeming deal in real asset amounts and never consult a price.
              </li>
              <li>
                <span className="font-medium text-foreground">Your keys</span> stay in your wallet, which signs every
                action. We can't move anything for you, and neither can anyone else.
              </li>
            </ul>
          </div>
        </div>
      </section>

      <PriceSection />

      <section className="mt-20" aria-label="The guarantees">
        <SectionHead title="Why this beats a promise">Each of these is a rule in the contract, not a policy we keep.</SectionHead>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {GUARANTEES.map((g) => (
            <div key={g.title} className="panel rounded-2xl p-5 sm:p-6">
              <span className="text-primary">{g.icon}</span>
              <h3 className="mt-3 font-medium">{g.title}</h3>
              <p className="mt-1.5 text-[0.875rem] leading-relaxed text-muted-foreground">{g.body}</p>
            </div>
          ))}
        </div>
      </section>

      <div className="mt-20 flex flex-wrap items-center justify-center gap-3 border-t pt-10">
        <Link to="/funds" className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-5 text-label text-primary-foreground shadow-sm hover:opacity-90">
          Explore live funds
          <ArrowRight className="size-4" />
        </Link>
        <Link to="/create" className="inline-flex min-h-11 items-center rounded-full border px-5 text-label hover:bg-secondary">
          Create your own
        </Link>
        <a href={links.repo} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center rounded-full px-5 text-label hover:bg-secondary">
          View the contracts
        </a>
      </div>
    </div>
  );
}

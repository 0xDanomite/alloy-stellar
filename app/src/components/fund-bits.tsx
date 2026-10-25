import { Link } from "react-router-dom";
import { oracleFor } from "../lib/config";
import { formatAge, formatAmount, formatUsd, ONE } from "../lib/format";
import { fundValueUsd, legWeights } from "../lib/fund-math";
import { DEMO_ISSUER_LABEL } from "../lib/issuers";
import type { Fund, FundComponent } from "../lib/stellar";
import { Usd } from "./ui";

export function IssuerName({ leg }: { leg: Pick<FundComponent, "issuerLabel" | "verified"> }) {
  return (
    <span className={`text-[0.8125rem] ${leg.verified ? "text-muted-foreground" : "text-warning"}`}>{leg.issuerLabel}</span>
  );
}

export function complianceLabel(fund: Fund): string {
  return fund.compliance === "Open" ? "Open to anyone" : "Approved investors";
}

export function IssuerFlags({ leg }: { leg: FundComponent }) {
  const flags = [
    leg.authRequired && "issuer approves holders",
    leg.clawback && "clawback",
    leg.revocable && !leg.authRequired && "revocable",
  ].filter(Boolean);
  if (!flags.length) return null;
  const benjiFlags = leg.issuerLabel === DEMO_ISSUER_LABEL && leg.authRequired && leg.revocable && leg.clawback;
  return (
    <span className="block text-[0.8125rem] text-muted-foreground">
      {flags.join(", ")}
      {benjiFlags && ", the same flags as BENJI"}
    </span>
  );
}

/** Oracle vs SDEX gap above which a leg is flagged for a second look. */
export const MARKET_GAP_FLAG = 0.02;

export function marketGap(leg: FundComponent): number | null {
  if (!leg.oracle || leg.priceUsdc === null) return null;
  return Math.abs(leg.priceUsdc - leg.oracle.priceUsd) / leg.oracle.priceUsd;
}

export function OracleSource({ source }: { source: string }) {
  const known = oracleFor(source);
  if (!known) return <span>{source}</span>;
  return (
    <a href={known.url} target="_blank" rel="noreferrer" className="hover:text-foreground">
      {known.label}
    </a>
  );
}

export function OracleNote({ leg }: { leg: FundComponent }) {
  if (!leg.oracle) return null;
  const age = Math.max(0, Date.now() / 1000 - leg.oracle.timestamp);
  const gap = marketGap(leg);
  return (
    <span className="block font-sans text-[0.8125rem] leading-snug text-muted-foreground">
      <OracleSource source={leg.oracle.source} />, {formatAge(age)}
      {leg.oracle.divergenceBps !== null && `, oracles ${(leg.oracle.divergenceBps / 100).toFixed(2)}% apart`}
      {gap !== null && gap > MARKET_GAP_FLAG && (
        <span className="block text-warning">market is {(gap * 100).toFixed(1)}% off the oracle</span>
      )}
    </span>
  );
}

/** Oracle NAV when every leg has a fresh oracle price, else the SDEX value. */
export function headlineValue(fund: Fund): { value: number | null; basis: "oracle" | "market" } {
  if (fund.navPerShare !== null) return { value: fund.navPerShare, basis: "oracle" };
  return { value: fund.valuePerShare, basis: "market" };
}

const STRAND_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

export function strandColor(i: number): string {
  return STRAND_COLORS[i % STRAND_COLORS.length] ?? "var(--chart-1)";
}

function hashHue(seed: string): number {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 262 + (h % 60);
}

/** A stable two-tone badge per fund, derived from its contract ID. */
export function FundAvatar({ fund, className = "size-10 text-[0.6875rem]" }: { fund: Pick<Fund, "id" | "symbol">; className?: string }) {
  const hue = hashHue(fund.id);
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full font-semibold text-white shadow-sm ${className}`}
      style={{ background: `linear-gradient(135deg, oklch(0.62 0.16 ${hue}), oklch(0.42 0.18 ${hue + 30}))` }}
      aria-hidden
    >
      {fund.symbol.replace(/^a/, "").slice(0, 3).toUpperCase()}
    </span>
  );
}

export function AssetDot({ code, index }: { code: string; index: number }) {
  return (
    <span
      className="grid size-5 shrink-0 place-items-center rounded-full font-mono text-[0.5rem] font-medium text-white/90"
      style={{ background: `color-mix(in oklch, ${strandColor(index)} 70%, oklch(0.25 0.02 288))` }}
      aria-hidden
    >
      {code.slice(0, 3)}
    </span>
  );
}

export function HoldsChips({ fund, limit = 6 }: { fund: Fund; limit?: number }) {
  const weights = legWeights(fund);
  const shown = fund.components.slice(0, limit);
  return (
    <ul className="flex flex-wrap gap-1.5">
      {shown.map((leg, i) => {
        const weight = weights[i];
        return (
          <li key={leg.token} className="chip py-1 pr-2.5 pl-1">
            <AssetDot code={leg.code} index={i} />
            <span className="text-[0.75rem] font-medium">{leg.code}</span>
            <span className="num text-[0.6875rem] text-muted-foreground">
              {weight != null ? `${Math.round(weight * 100)}%` : `${formatAmount(leg.unitsPerShare)}/sh`}
            </span>
          </li>
        );
      })}
      {fund.components.length > limit && (
        <li className="chip px-2.5 py-1 text-[0.75rem] text-muted-foreground">+{fund.components.length - limit} more</li>
      )}
    </ul>
  );
}

function FundFigure({ fund, large }: { fund: Fund; large?: boolean }) {
  const { value, basis } = headlineValue(fund);
  const total = fundValueUsd(fund);
  const shares = `${formatAmount(fund.totalSupply, 2)} ${fund.totalSupply === ONE ? "share" : "shares"}`;
  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-2">
        {value === null ? (
          <span className={`num text-muted-foreground ${large ? "text-figure-lg" : "text-figure"}`}>unpriced</span>
        ) : (
          <Usd value={value} className={large ? "text-figure-lg" : "text-[1.375rem] num"} />
        )}
        {value !== null && (
          <span className="chip px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
            {basis === "oracle" ? "oracle NAV" : "SDEX value"}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-[0.75rem] text-muted-foreground">
        {fund.totalSupply === 0n
          ? "per share, no shares issued yet"
          : total !== null
            ? `$${formatUsd(total)} in the fund, ${shares}`
            : `per share, ${shares} issued`}
      </p>
    </div>
  );
}

export function FundCard({ fund, featured = false }: { fund: Fund; featured?: boolean }) {
  return (
    <article className={`panel relative flex flex-col rounded-2xl ${featured ? "p-6 shadow-overlay" : "p-5"}`}>
      <div className="flex items-start gap-3">
        <FundAvatar fund={fund} />
        <div className="min-w-0 flex-1">
          <Link to={`/fund/${fund.id}`} className="line-clamp-2 block font-medium leading-snug tracking-tight after:absolute after:inset-0 after:rounded-2xl hover:text-primary">
            {fund.name}
          </Link>
          <p className="text-filing mt-0.5 text-muted-foreground">{fund.symbol}</p>
        </div>
        <span className="chip shrink-0 px-2 py-0.5 text-[0.75rem] text-muted-foreground">{complianceLabel(fund)}</span>
      </div>

      <div className="mt-5">
        <FundFigure fund={fund} large={featured} />
      </div>

      <div className="mt-5">
        <p className="text-filing text-muted-foreground">Holds</p>
        <div className="mt-2">
          <HoldsChips fund={fund} limit={featured ? 6 : 5} />
        </div>
      </div>

      {fund.awaitingIssuer.length > 0 && (
        <p className="mt-4 rounded-lg bg-warning-surface px-3 py-2 text-[0.8125rem]">
          Waiting on {fund.awaitingIssuer.map((l) => l.code).join(", ")} issuer authorization
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-3 pt-6">
        <span className="text-[0.75rem] text-muted-foreground">
          {fund.components.length} assets, redeemable in kind
        </span>
        <span className="pointer-events-none rounded-full bg-primary px-4 py-1.5 text-label text-primary-foreground shadow-sm">
          Invest
        </span>
      </div>
    </article>
  );
}

export function SkeletonCard({ featured = false }: { featured?: boolean }) {
  return (
    <div className={`panel rounded-2xl ${featured ? "min-h-[22rem] p-6" : "min-h-[16rem] p-5"}`} aria-hidden>
      <div className="flex items-center gap-3">
        <span className="skeleton size-10 rounded-full" />
        <div className="space-y-1.5">
          <span className="skeleton block h-4 w-32" />
          <span className="skeleton block h-3 w-16" />
        </div>
      </div>
      <span className="skeleton mt-6 block h-7 w-28" />
      <span className="skeleton mt-2 block h-3 w-40" />
      <div className="mt-6 flex gap-2">
        <span className="skeleton h-7 w-20" />
        <span className="skeleton h-7 w-20" />
        <span className="skeleton h-7 w-20" />
      </div>
    </div>
  );
}

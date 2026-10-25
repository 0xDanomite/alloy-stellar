import { Link } from "react-router-dom";
import { oracleFor } from "../lib/config";
import { formatAge, formatAmount } from "../lib/format";
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
    <span className="block text-[0.8125rem] text-muted-foreground">
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

export function FundCard({ fund }: { fund: Fund }) {
  return (
    <Link
      to={`/fund/${fund.id}`}
      className="group flex flex-col rounded-xl border bg-card p-5 transition-colors hover:border-primary/50 sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-title">{fund.symbol}</h3>
          <p className="truncate text-muted-foreground">{fund.name}</p>
        </div>
        <span className="shrink-0 rounded-full bg-secondary px-2.5 py-0.5 text-[0.75rem] font-medium">
          {complianceLabel(fund)}
        </span>
      </div>

      <ul className="mt-5 divide-y border-y">
        {fund.components.map((leg, i) => (
          <li key={leg.token} className="flex items-center gap-3 py-2.5">
            <span className="h-4 w-1 shrink-0 rounded-full" style={{ background: strandColor(i) }} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="font-medium">{leg.code}</span>
              <span className="ml-2">
                <IssuerName leg={leg} />
              </span>
            </span>
            <span className="num text-[0.875rem]">{formatAmount(leg.unitsPerShare)}</span>
          </li>
        ))}
      </ul>

      <div className="mt-5 flex items-end justify-between gap-4">
        <div>
          <div className="text-[0.8125rem] text-muted-foreground">
            {headlineValue(fund).basis === "oracle" ? "NAV per share (oracle)" : "Value per share"}
          </div>
          <Usd value={headlineValue(fund).value} className="text-figure" />
        </div>
        <div className="text-right">
          <div className="text-[0.8125rem] text-muted-foreground">Shares issued</div>
          <span className="num">{formatAmount(fund.totalSupply, 2)}</span>
        </div>
      </div>

      {fund.awaitingIssuer.length > 0 && (
        <p className="mt-4 rounded-md bg-warning-surface px-3 py-2 text-[0.8125rem]">
          Waiting on {fund.awaitingIssuer.map((l) => l.code).join(", ")} issuer authorization
        </p>
      )}
      <span className="mt-5 text-label text-primary group-hover:underline group-hover:underline-offset-4">
        Open {fund.symbol}
      </span>
    </Link>
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border bg-card p-6" aria-hidden>
      <span className="skeleton h-7 w-24" />
      <span className="skeleton mt-2 block h-4 w-40" />
      <div className="mt-6 space-y-3">
        <span className="skeleton block h-5 w-full" />
        <span className="skeleton block h-5 w-full" />
        <span className="skeleton block h-5 w-full" />
      </div>
      <span className="skeleton mt-6 block h-7 w-28" />
    </div>
  );
}

import { useState } from "react";
import { expert } from "../lib/config";
import { formatAmount } from "../lib/format";
import { explain } from "../lib/stellar";
import { addUsdcTrustline, routeLabel, type ZapPlan } from "../lib/zap";
import { Button, TxNotice, type TxPhase } from "./ui";

/** Each non-USDC leg and the Soroswap route the zap takes for it. */
export function ZapRoutes({
  plan,
  direction,
  thin = [],
  unpriced = [],
}: {
  plan: ZapPlan;
  direction: "issue" | "redeem";
  thin?: string[];
  unpriced?: string[];
}) {
  const routed = plan.routes.filter((r) => r.path);
  if (!routed.length) return null;
  return (
    <ul className="space-y-1 text-[0.8125rem] text-muted-foreground">
      {routed.map((route) => (
        <li key={route.token} className="flex justify-between gap-3">
          <span className={thin.includes(route.code) ? "text-destructive" : undefined}>
            {route.code}
            {unpriced.includes(route.code) ? " (no price to check)" : thin.includes(route.code) && " (pool too thin)"}
          </span>
          <span>{routeLabel(plan, route, direction)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The headline figure of a zap quote, with the bound the transaction enforces under it. */
export function ZapQuote({
  label,
  usdc,
  loading,
  error,
  bound,
}: {
  label: string;
  usdc: bigint | undefined;
  loading: boolean;
  error: unknown;
  bound: string | null;
}) {
  return (
    <div>
      <div className="text-[0.8125rem] text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        {usdc !== undefined ? (
          <span className="num content-fade text-figure">{formatAmount(usdc, 4)}</span>
        ) : loading ? (
          <span className="skeleton text-figure" style={{ width: "7ch" }}>0</span>
        ) : (
          <span className="num text-figure text-muted-foreground">0</span>
        )}
        <span className="text-label text-muted-foreground">USDC</span>
      </div>
      {error != null && <p className="mt-1 text-[0.8125rem] text-destructive">{explain(error)}</p>}
      {bound && <p className="mt-1 text-[0.8125rem] text-muted-foreground">{bound}</p>}
    </div>
  );
}

/** Offered when the wallet has no USDC trustline: one classic signature adds it. */
export function AddUsdc({ address, why, onAdded }: { address: string; why: string; onAdded: () => void }) {
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });

  async function add() {
    setPhase({ state: "working", message: "Confirm adding USDC in your wallet…" });
    try {
      const hash = await addUsdcTrustline(address);
      setPhase({ state: "done", message: "USDC added to your wallet.", url: expert.tx(hash) });
      onAdded();
    } catch (err) {
      setPhase({ state: "failed", message: explain(err) });
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-4 text-[0.875rem]">
      <p>
        Your wallet isn't set up for USDC yet. {why} Adding it is one signature and sets aside 0.5 XLM as the network
        reserve.
      </p>
      {phase.state !== "done" && (
        <Button variant="secondary" className="w-full" onClick={add} busy={phase.state === "working"}>
          Add USDC to my wallet
        </Button>
      )}
      <TxNotice phase={phase} />
    </div>
  );
}

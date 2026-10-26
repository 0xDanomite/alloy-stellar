import { useMemo, useState } from "react";
import { formatBps } from "../lib/fee-math";
import { formatAmount, toDecimalString } from "../lib/format";
import { loadTradeState, quoteRoute, trade } from "../lib/manager";
import {
  currentWeights,
  fundValue,
  lossBudgetLeftBps,
  lossOfFundBps,
  oracleFloor,
  planTrades,
  type PlanLeg,
  type PlannedTrade,
} from "../lib/rebalance-plan";
import { explain, rebalance, type Fund, type FundComponent } from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { AssetDot } from "./fund-bits";
import { Button, TxNotice, type TxPhase } from "./ui";

/** Slippage allowed on a Soroswap quote; the contract's oracle floor still applies. */
const ROUTE_SLIPPAGE_BPS = 100n;
/** The manager-supplied fallback asks the oracle price less 0.5%, inside the 1% bound. */
const WALLET_HAIRCUT = 0.995;
const COOLDOWN_SECONDS = 60;

const pct = (n: number) => `${(n * 100).toFixed(1).replace(/\.0$/, "")}%`;
const name = (code: string) => (code === "XLM" ? "Lumens" : code);

function planLegs(fund: Fund): PlanLeg[] {
  return fund.components.map((leg) => ({ token: leg.token, code: leg.code, holding: leg.holding, priceUsd: leg.oracle?.priceUsd ?? null }));
}

/**
 * Target weights in, trades out. Each trade sells one overweight leg for one
 * underweight leg, quoted through Soroswap where a pool exists and otherwise
 * done at oracle price with the manager supplying the bought asset.
 */
export function RebalancePlanner({ fund, onChanged }: { fund: Fund; onChanged: () => void }) {
  const legs = useMemo(() => planLegs(fund), [fund]);
  const weights = currentWeights(legs);
  const value = fundValue(legs);
  const state = useAsync(() => loadTradeState(fund), `trade:${fund.id}:${fund.setup?.lastRebalance ?? 0}`);
  const [targets, setTargets] = useState<string[]>(() => (weights ?? legs.map(() => 0)).map((w) => (w * 100).toFixed(1).replace(/\.0$/, "")));
  const targetNums = targets.map((t) => Number(t));
  const totalTarget = Math.round(targetNums.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) * 10) / 10;
  const targetsKey = targets.join("|");
  const trades = useMemo(
    () => (totalTarget === 100 && value !== null ? planTrades(legs, targetsKey.split("|").map((t) => Number(t) / 100), Math.min(1, value * 0.005)) : []),
    [legs, targetsKey, totalTarget, value],
  );
  const byToken = new Map(fund.components.map((c) => [c.token, c]));

  if (!weights || value === null) {
    return (
      <p className="text-[0.875rem] text-muted-foreground">
        {fund.totalSupply === 0n
          ? "Nothing to rebalance until the first shares are issued."
          : "The planner needs a fresh oracle price for every asset, and at least one is missing right now."}
      </p>
    );
  }

  const budget = state.data ? lossBudgetLeftBps(state.data.windowLossPpb) : null;
  const since = fund.setup?.lastRebalance ? Date.now() / 1000 - fund.setup.lastRebalance : Infinity;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border">
        <div className="grid grid-cols-[1fr_4rem_5.5rem] gap-2 border-b px-3 py-2 text-[0.75rem] text-muted-foreground">
          <span>Asset</span>
          <span className="text-right">Now</span>
          <span className="text-right">Target</span>
        </div>
        <ul className="divide-y">
          {fund.components.map((leg, i) => (
            <li key={leg.token} className="grid grid-cols-[1fr_4rem_5.5rem] items-center gap-2 px-3 py-2">
              <span className="flex min-w-0 items-center gap-2 text-[0.875rem]">
                <AssetDot code={leg.code} index={i} />
                <span className="truncate">{name(leg.code)}</span>
              </span>
              <span className="num text-right text-[0.875rem] text-muted-foreground">{pct(weights[i] ?? 0)}</span>
              <span className="relative">
                <input
                  inputMode="decimal"
                  value={targets[i] ?? ""}
                  onChange={(e) => setTargets((t) => t.map((v, j) => (j === i ? e.target.value.replace(",", ".") : v)))}
                  aria-label={`${leg.code} target weight in percent`}
                  className="num w-full rounded-md border bg-surface-sunken py-1.5 pr-6 pl-2 text-right text-[0.875rem] outline-none focus:border-ring"
                />
                <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[0.8125rem] text-muted-foreground">%</span>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between border-t bg-surface-sunken/60 px-3 py-2 text-[0.8125rem]">
          <span className="text-muted-foreground">
            Loss budget left today{" "}
            <span className="num text-foreground">{budget === null ? (state.error != null ? "n/a" : "…") : formatBps(Math.floor(budget))}</span>
            <span className="text-muted-foreground"> of 2%</span>
          </span>
          <span className={totalTarget === 100 ? "text-muted-foreground" : "text-destructive"}>Total <span className="num">{totalTarget}%</span></span>
        </div>
      </div>

      {since < COOLDOWN_SECONDS && (
        <p className="text-[0.8125rem] text-muted-foreground">Trades are a minute apart. The next one can go through shortly.</p>
      )}

      {totalTarget !== 100 ? (
        <p className="text-[0.8125rem] text-muted-foreground">Targets need to add up to 100%.</p>
      ) : trades.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">The fund is already at these weights.</p>
      ) : (
        <ol className="space-y-3">
          {trades.map((t, i) => {
            const sell = byToken.get(t.sell);
            const buy = byToken.get(t.buy);
            return sell && buy ? (
            <TradeCard
              key={`${t.sell}:${t.buy}:${t.sold}`}
              n={i + 1}
              fund={fund}
              trade={t}
              sell={sell}
              buy={buy}
              router={state.data?.router ?? null}
              fundValueUsd={value}
              budgetBps={budget}
              onChanged={onChanged}
            />
            ) : null;
          })}
        </ol>
      )}
      <p className="text-[0.8125rem] text-muted-foreground">
        Each trade must return at least 99% of what it sells at oracle prices, and all trades in a rolling day may give up at most 2% of
        fund value. Run them one at a time; the plan updates after each.
      </p>
    </div>
  );
}

function TradeCard({
  n,
  fund,
  trade: t,
  sell,
  buy,
  router,
  fundValueUsd,
  budgetBps,
  onChanged,
}: {
  n: number;
  fund: Fund;
  trade: PlannedTrade;
  sell: FundComponent;
  buy: FundComponent;
  router: string | null;
  fundValueUsd: number;
  budgetBps: number | null;
  onChanged: () => void;
}) {
  const { address } = useWallet();
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });
  const sellPrice = sell.oracle?.priceUsd ?? 0;
  const buyPrice = buy.oracle?.priceUsd ?? 0;
  const floor = oracleFloor(t.sold, sellPrice, buyPrice);
  const quote = useAsync(
    () => (router ? quoteRoute(router, sell, buy, t.sold) : Promise.resolve(null)),
    `${router}:${t.sell}:${t.buy}:${t.sold}`,
  );
  const routed = quote.data && quote.data.out >= floor ? quote.data : null;
  const slipped = routed ? routed.out - (routed.out * ROUTE_SLIPPAGE_BPS) / 10_000n : 0n;
  const minOut = slipped > floor ? slipped : floor;
  const walletBought = BigInt(Math.floor(Number(t.bought) * WALLET_HAIRCUT));
  const expected = routed ? routed.out : walletBought;
  const loss = lossOfFundBps(t.sold, sellPrice, expected, buyPrice, fundValueUsd);
  const overBudget = budgetBps !== null && loss > budgetBps;

  async function run() {
    if (!address) return;
    setPhase({ state: "working", message: "Confirm the trade in your wallet…" });
    try {
      if (routed) {
        const result = await trade(fund, address, t.sell, t.sold, t.buy, minOut, routed.path);
        setPhase({ state: "done", message: `Swapped ${formatAmount(t.sold)} ${sell.code} for ${buy.code} through Soroswap.`, url: result.url });
      } else {
        const result = await rebalance(fund, address, t.sell, t.sold, t.buy, walletBought);
        setPhase({ state: "done", message: `Rebalanced: ${formatAmount(t.sold)} ${sell.code} out, ${formatAmount(walletBought)} ${buy.code} in.`, url: result.url });
      }
      onChanged();
    } catch (err) {
      setPhase({ state: "failed", message: explain(err) });
    }
  }

  return (
    <li className="space-y-2.5 rounded-lg border p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-label">
          <span className="num text-muted-foreground">{n}.</span> {name(sell.code)} to {name(buy.code)}
        </span>
        <span className="num text-[0.8125rem] text-muted-foreground">${t.valueUsd.toFixed(2)}</span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[0.8125rem]">
        <dt className="text-muted-foreground">Sell</dt>
        <dd className="num text-right">{formatAmount(t.sold)} {sell.code}</dd>
        <dt className="text-muted-foreground">Oracle floor</dt>
        <dd className="num text-right">{formatAmount(floor)} {buy.code}</dd>
        <dt className="text-muted-foreground">{routed ? "Soroswap quote" : "You send"}</dt>
        <dd className="num text-right">
          {quote.loading && !quote.data ? <span className="skeleton w-16">0</span> : `${formatAmount(expected)} ${buy.code}`}
        </dd>
        <dt className="text-muted-foreground">Counts against budget</dt>
        <dd className={`num text-right ${overBudget ? "text-destructive" : ""}`}>{formatBps(Math.ceil(loss * 100) / 100)}</dd>
      </dl>
      <p className="text-[0.8125rem] text-muted-foreground">
        {quote.loading && !quote.data
          ? "Asking Soroswap for a route…"
          : routed
            ? `Route ${routed.hops.join(" → ")}. The fund trades directly with the pools, and the swap must return at least ${formatAmount(minOut)} ${buy.code}.`
            : quote.data
              ? `Soroswap pays less than the oracle floor here, so this runs at oracle price: you send ${toDecimalString(walletBought)} ${buy.code} from your wallet and the fund sends you the ${sell.code}.`
              : `No Soroswap pool for this pair, so this runs at oracle price: you send ${toDecimalString(walletBought)} ${buy.code} from your wallet and the fund sends you the ${sell.code}.`}
      </p>
      <Button variant={n === 1 ? "primary" : "secondary"} className="w-full" onClick={run} busy={phase.state === "working"} disabled={quote.loading || overBudget || !address}>
        {routed ? "Swap through Soroswap" : "Rebalance at oracle price"}
      </Button>
      <TxNotice phase={phase} />
    </li>
  );
}

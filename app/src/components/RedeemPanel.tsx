import { useState } from "react";
import { planCashOut } from "../lib/cashout";
import { expert } from "../lib/config";
import { formatAmount, toDecimalString, toUnits } from "../lib/format";
import {
  ChainError,
  explain,
  quoteRedeem,
  redeem,
  simulateRedeem,
  submitClassic,
  unreceivableLegs,
  withdrawOwed,
  type Fund,
  type FundComponent,
  type Position,
} from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { explainZap, quoteZapRedeem, thinMessage, usdcWallet, zapPlan, zapRedeem, type ZapPlan } from "../lib/zap";
import { Button, TxNotice, type TxPhase } from "./ui";
import { ModeSwitch, SharesInput } from "./panel-bits";
import { AddUsdc, ZapQuote, ZapRoutes } from "./zap-bits";

function OwedClaims({ fund, position, onChanged }: { fund: Fund; position: Position; onChanged: () => void }) {
  const { address } = useWallet();
  const [phases, setPhases] = useState<Record<string, TxPhase>>({});
  if (!position.owed.length || !address) return null;

  async function claim(token: string, code: string) {
    if (!address) return;
    setPhases((p) => ({ ...p, [token]: { state: "working", message: `Confirm the ${code} claim in your wallet…` } }));
    try {
      const result = await withdrawOwed(fund, address, token);
      setPhases((p) => ({ ...p, [token]: { state: "done", message: `${code} sent to your wallet.`, url: result.url } }));
      onChanged();
    } catch (err) {
      setPhases((p) => ({ ...p, [token]: { state: "failed", message: explain(err) } }));
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <h3 className="text-label">Waiting for you to claim</h3>
      <p className="text-[0.875rem] text-muted-foreground">
        Earlier redemptions left these in the fund, set aside for you. Claim them once your wallet can receive them.
      </p>
      {position.owed.map(({ component, amount }) => (
        <div key={component.token} className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <span>
              <span className="num">{formatAmount(amount)}</span> {component.code}
            </span>
            <Button variant="secondary" onClick={() => claim(component.token, component.code)} busy={phases[component.token]?.state === "working"}>
              Claim
            </Button>
          </div>
          <TxNotice phase={phases[component.token] ?? { state: "idle" }} />
        </div>
      ))}
    </div>
  );
}

/** After a redemption: sell the assets it paid out for USDC in one more signature. */
function CashOut({ received }: { received: { leg: FundComponent; amount: bigint }[] }) {
  const { address } = useWallet();
  const [asked, setAsked] = useState(false);
  const [version, setVersion] = useState(0);
  const plan = useAsync(() => planCashOut(address ?? "", received), asked && address ? `cashout:${address}:${received.map((r) => `${r.leg.token}:${r.amount}`).join(",")}` : null, version);
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });

  async function sell() {
    if (!address || !plan.data?.xdr) return;
    setPhase({ state: "working", message: "Confirm the sale in your wallet…" });
    try {
      const hash = await submitClassic(plan.data.xdr, address);
      setPhase({ state: "done", message: "Sold for USDC.", url: expert.tx(hash) });
    } catch (err) {
      setPhase({ state: "failed", message: explain(err) });
      setVersion((v) => v + 1);
    }
  }

  if (!asked) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4 text-[0.875rem]">
        <span>Want dollars instead? Sell what you received for USDC.</span>
        <Button variant="secondary" onClick={() => setAsked(true)}>
          Quote USDC
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <h3 className="text-label">Cash out to USDC</h3>
      {plan.loading && !plan.data && <p className="text-[0.875rem] text-muted-foreground">Quoting the Stellar DEX…</p>}
      {plan.error != null && <p className="text-[0.875rem] text-destructive">{explain(plan.error)}</p>}
      {plan.data && (
        <>
          <ul className="space-y-2 text-[0.875rem]">
            {plan.data.legs.map((leg) => (
              <li key={leg.code}>
                <div className="flex justify-between gap-3">
                  {leg.blocked ? (
                    <span>{leg.code}</span>
                  ) : (
                    <span>
                      Sell <span className="num">{formatAmount(leg.amount)}</span> {leg.code}
                    </span>
                  )}
                  <span className="num">{leg.expected !== null ? `${formatAmount(leg.expected, 2)} USDC` : "kept"}</span>
                </div>
                <p className="text-muted-foreground">{leg.blocked ?? `${leg.route}, at least ${formatAmount(leg.minimum ?? 0n, 2)} USDC`}</p>
              </li>
            ))}
          </ul>
          {plan.data.xdr ? (
            <>
              <p className="text-[0.875rem]">
                About <span className="num">{formatAmount(plan.data.totalExpected, 2)}</span> USDC, at least{" "}
                <span className="num">{formatAmount(plan.data.totalMinimum, 2)}</span> if prices move up to 2% while you sign.
                {plan.data.addsTrustline && " Adds USDC to your wallet first."}
              </p>
              <Button className="w-full" onClick={sell} busy={phase.state === "working"} disabled={phase.state === "done"}>
                Sell for USDC
              </Button>
            </>
          ) : (
            <p className="text-[0.875rem] text-muted-foreground">Nothing here can be sold right now.</p>
          )}
        </>
      )}
      <TxNotice phase={phase} />
    </div>
  );
}

type RedeemMode = "usdc" | "assets";

const MODES = [
  { id: "usdc", label: "Receive USDC" },
  { id: "assets", label: "Receive the assets" },
] as const;

/**
 * The USDC quote for redeeming `shares`, simulated on the owner's own
 * shares when they hold them and can receive USDC. Loaded whether or not
 * the USDC mode is showing, since its depth check picks the default mode.
 */
function useZapRedeem(fund: Fund, plan: ZapPlan | null, shares: bigint | null, position: Position | null) {
  const { address } = useWallet();
  const [walletVersion, setWalletVersion] = useState(0);
  const [quoteVersion, setQuoteVersion] = useState(0);
  const valid = shares !== null && shares > 0n;
  const wallet = useAsync(() => usdcWallet(address ?? ""), plan && address ? `usdc:${address}` : null, walletVersion);
  const holds = valid && position !== null && (shares ?? 0n) <= position.shares;
  const owner = address && holds && wallet.data?.hasTrustline ? address : null;
  const ready = !address || wallet.data !== undefined;
  const quote = useAsync(
    () => (plan ? quoteZapRedeem(fund, plan, shares ?? 0n, owner) : Promise.reject(new Error("This fund can't pay USDC."))),
    plan && valid && fund.totalSupply > 0n && ready ? `zap-redeem:${fund.id}:${shares}:${owner ?? ""}` : null,
    quoteVersion,
  );
  return {
    wallet,
    quote,
    holds,
    ready,
    reloadWallet: () => setWalletVersion((v) => v + 1),
    reloadAll: () => {
      setWalletVersion((v) => v + 1);
      setQuoteVersion((v) => v + 1);
    },
  };
}

type ZapRedeemState = ReturnType<typeof useZapRedeem>;

function UsdcRedeem({
  fund,
  plan,
  shares,
  state,
  onDone,
}: {
  fund: Fund;
  plan: ZapPlan;
  shares: bigint | null;
  state: ZapRedeemState;
  onDone: () => void;
}) {
  const { address } = useWallet();
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });
  const valid = shares !== null && shares > 0n;
  const { wallet, quote, holds, ready } = state;
  const tooThin = thinMessage(quote.data?.thin ?? []);

  async function run() {
    if (!address || !shares || !quote.data) return;
    setPhase({ state: "working", message: "Confirm in your wallet. One signature redeems and sells for USDC…" });
    try {
      const result = await zapRedeem(fund, plan, address, shares, quote.data.minUsdc);
      setPhase({
        state: "done",
        message: `Redeemed ${formatAmount(shares)} ${fund.symbol} for ${formatAmount(result.result, 4)} USDC.`,
        url: result.url,
      });
      state.reloadAll();
      onDone();
    } catch (err) {
      setPhase({ state: "failed", message: explainZap(err) });
    }
  }

  return (
    <>
      <div className="space-y-3">
        <ZapQuote
          label="You receive about"
          usdc={quote.data?.usdc}
          loading={valid && fund.totalSupply > 0n && (quote.loading || !ready)}
          error={quote.error}
          bound={
            quote.data
              ? `At least ${formatAmount(quote.data.minUsdc, 4)} USDC, ${quote.data.simulated ? "simulated on your shares" : "estimated on Soroswap"} just now with 1% room for price movement.`
              : null
          }
        />
        <ZapRoutes plan={plan} direction="redeem" thin={quote.data?.thin} />
        {tooThin && <p className="text-[0.8125rem] text-destructive">{tooThin} Receive the assets instead.</p>}
        <p className="text-[0.8125rem] text-muted-foreground">
          The fund pays out its assets and Soroswap sells them for USDC, in one transaction. If the pools are thin,
          receive the assets instead: that path can't be switched off.
        </p>
      </div>

      {address && wallet.data && !wallet.data.hasTrustline ? (
        <AddUsdc address={address} why="Receiving USDC needs it." onAdded={state.reloadWallet} />
      ) : (
        address && (
          <>
            <Button
              className="w-full"
              onClick={run}
              busy={phase.state === "working"}
              disabled={!holds || !quote.data || !quote.data.simulated || tooThin !== null}
            >
              Redeem {valid ? formatAmount(shares ?? 0n) : ""} {fund.symbol} for USDC
            </Button>
            <TxNotice phase={phase} />
          </>
        )
      )}
    </>
  );
}

export function RedeemPanel({ fund, position, onChanged }: { fund: Fund; position: Position | null; onChanged: () => void }) {
  const { address, connect, connecting } = useWallet();
  const [input, setInput] = useState("1");
  const shares = toUnits(input);
  const valid = shares !== null && shares > 0n;
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });
  const [skipOffer, setSkipOffer] = useState<FundComponent[] | null>(null);
  const [received, setReceived] = useState<{ leg: FundComponent; amount: bigint }[] | null>(null);
  const [chosen, setChosen] = useState<RedeemMode | null>(null);

  const zap = useAsync(() => zapPlan(fund), fund.id);
  const plan = zap.data ?? null;
  const zappable = plan !== null && plan.blocked === null;
  const zapState = useZapRedeem(fund, zappable ? plan : null, shares, position);
  const tooThin = thinMessage(zapState.quote.data?.thin ?? []);
  const mode: RedeemMode = zappable ? (chosen ?? (tooThin || zapState.quote.error != null ? "assets" : "usdc")) : "assets";

  const quote = useAsync(
    () => quoteRedeem(fund, shares ?? 0n),
    valid && fund.totalSupply > 0n && mode === "assets" ? `${fund.id}:${shares}` : null,
  );
  const tooMany = valid && position !== null && (shares ?? 0n) > position.shares;

  async function run(skip: FundComponent[]) {
    if (!address || !shares) return;
    setSkipOffer(null);
    setPhase({ state: "working", message: "Checking the redemption…" });
    const skipIds = skip.map((s) => s.token);
    setReceived(null);
    let amounts: bigint[];
    try {
      amounts = await simulateRedeem(fund, address, shares, skipIds);
    } catch (err) {
      if (err instanceof ChainError && skip.length === 0) {
        const legs = await unreceivableLegs(fund, address, err);
        if (legs.length && legs.length < fund.components.length) {
          setPhase({ state: "idle" });
          setSkipOffer(legs);
          return;
        }
      }
      setPhase({ state: "failed", message: explain(err) });
      return;
    }
    setPhase({ state: "working", message: "Confirm the redemption in your wallet…" });
    try {
      const result = await redeem(fund, address, shares, skipIds);
      const kept = skip.length ? ` ${skip.map((s) => s.code).join(", ")} is set aside for you to claim.` : "";
      setPhase({ state: "done", message: `Redeemed ${formatAmount(shares)} ${fund.symbol}.${kept}`, url: result.url });
      setReceived(
        fund.components
          .map((leg, i) => ({ leg, amount: amounts[i] ?? 0n }))
          .filter(({ leg, amount }) => amount > 0n && !skipIds.includes(leg.token)),
      );
      onChanged();
    } catch (err) {
      setPhase({ state: "failed", message: explain(err) });
    }
  }

  return (
    <div className="space-y-5">
      {zap.loading && !zap.data ? (
        <div className="skeleton h-10 w-full rounded-full" />
      ) : (
        zappable && <ModeSwitch label="How to be paid" options={MODES} value={mode} onChange={setChosen} />
      )}

      <SharesInput
        id="redeem-shares"
        label={`Shares of ${fund.symbol}`}
        value={input}
        onChange={(v) => {
          setInput(v);
          setSkipOffer(null);
        }}
        invalid={!valid && input !== ""}
        hint={
          position && position.shares > 0n ? (
            <button type="button" className="text-[0.8125rem] text-primary hover:underline" onClick={() => setInput(toDecimalString(position.shares))}>
              You hold <span className="num">{formatAmount(position.shares)}</span>
            </button>
          ) : null
        }
      />

      {mode === "usdc" && plan ? (
        <>
          {address && position && position.shares === 0n && (
            <p className="text-[0.875rem] text-muted-foreground">You don't hold any {fund.symbol} yet.</p>
          )}
          {tooMany && <p className="text-[0.875rem] text-destructive">That's more than the {formatAmount(position?.shares ?? 0n)} shares you hold.</p>}
          <UsdcRedeem fund={fund} plan={plan} shares={shares} state={zapState} onDone={onChanged} />
          {!address && (
            <Button className="w-full" onClick={connect} busy={connecting}>
              Connect wallet to redeem
            </Button>
          )}
          {address && position && <OwedClaims fund={fund} position={position} onChanged={onChanged} />}
        </>
      ) : (
        <>
          <div>
            <div className="text-[0.8125rem] text-muted-foreground">You receive</div>
            <ul className="mt-2 space-y-1.5">
              {fund.components.map((leg, i) => (
                <li key={leg.token} className="flex justify-between gap-3 text-[0.9375rem]">
                  <span>{leg.code}</span>
                  <span className="num">
                    {quote.data ? formatAmount(quote.data[i] ?? 0n) : valid && fund.totalSupply > 0n ? <span className="skeleton w-16">0</span> : "0"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[0.8125rem] text-muted-foreground">
              Redemption pays out the assets themselves, straight from the fund. No manager or issuer setting can turn it off.
            </p>
            {zappable && tooThin && (
              <p className="mt-2 text-[0.8125rem] text-muted-foreground">Receiving USDC isn't offered at this size. {tooThin}</p>
            )}
          </div>

          {!address ? (
            <Button className="w-full" onClick={connect} busy={connecting}>
              Connect wallet to redeem
            </Button>
          ) : (
            <>
              {position && position.shares === 0n && phase.state !== "done" && (
                <p className="text-[0.875rem] text-muted-foreground">You don't hold any {fund.symbol} yet.</p>
              )}
              {tooMany && <p className="text-[0.875rem] text-destructive">That's more than the {formatAmount(position?.shares ?? 0n)} shares you hold.</p>}

              {skipOffer ? (
                <div className="space-y-3 rounded-lg border border-warning/40 bg-warning-surface p-4 text-[0.875rem]">
                  <p>
                    Your wallet can't receive {skipOffer.map((l) => l.code).join(", ")} right now: it needs a trustline, or the
                    issuer's approval.
                  </p>
                  <p>
                    You can redeem now and the fund keeps your {skipOffer.map((l) => l.code).join(", ")} set aside. Claim it any
                    time later from this page.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => run(skipOffer)}>Redeem and set aside {skipOffer.map((l) => l.code).join(", ")}</Button>
                    <Button variant="ghost" onClick={() => setSkipOffer(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  className="w-full"
                  onClick={() => run([])}
                  busy={phase.state === "working"}
                  disabled={!valid || tooMany || (position !== null && position.shares === 0n)}
                >
                  Redeem {valid ? formatAmount(shares ?? 0n) : ""} {fund.symbol}
                </Button>
              )}
              <TxNotice phase={phase} />
              {phase.state === "done" && received && received.some((r) => r.leg.code !== "USDC") && <CashOut received={received} />}
              {position && <OwedClaims fund={fund} position={position} onChanged={onChanged} />}
            </>
          )}
        </>
      )}
    </div>
  );
}

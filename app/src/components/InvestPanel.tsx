import { useState } from "react";
import { formatAmount, toUnits } from "../lib/format";
import { explain, issue, planBasket, quoteIssue, submitClassic, type Fund, type Position } from "../lib/stellar";
import { expert } from "../lib/config";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { explainZap, quoteZapIssue, usdcWallet, zapIssue, zapPlan, type IssueQuote, type ZapPlan } from "../lib/zap";
import { Button, CopyId, TxNotice, type TxPhase } from "./ui";
import { ModeSwitch, SharesInput, Step } from "./panel-bits";
import { AddUsdc, ZapQuote, ZapRoutes } from "./zap-bits";

type InvestMode = "usdc" | "basket";

const MODES = [
  { id: "usdc", label: "Pay with USDC" },
  { id: "basket", label: "Deposit the basket" },
] as const;

function BasketSteps({ fund, shares, onChanged }: { fund: Fund; shares: bigint | null; onChanged: () => void }) {
  const { address } = useWallet();
  const valid = shares !== null && shares > 0n;
  const [planVersion, setPlanVersion] = useState(0);
  const [buy, setBuy] = useState<TxPhase>({ state: "idle" });
  const [deposit, setDeposit] = useState<TxPhase>({ state: "idle" });
  const plan = useAsync(
    () => planBasket(fund, address ?? "", shares ?? 0n),
    valid && address ? `${fund.id}:${address}:${shares}` : null,
    planVersion,
  );
  const basketReady = plan.data !== undefined && plan.data.legs.length === 0;
  const legBlocked = plan.data?.legs.some((l) => l.blocked) ?? false;

  async function runBuy() {
    if (!address || !plan.data?.xdr) return;
    setBuy({ state: "working", message: "Confirm the purchase in your wallet…" });
    try {
      const hash = await submitClassic(plan.data.xdr, address);
      setBuy({ state: "done", message: "Basket bought.", url: expert.tx(hash) });
      setPlanVersion((v) => v + 1);
      onChanged();
    } catch (err) {
      setBuy({ state: "failed", message: explain(err) });
      setPlanVersion((v) => v + 1);
    }
  }

  async function runIssue() {
    if (!address || !shares) return;
    setDeposit({ state: "working", message: "Confirm the deposit in your wallet…" });
    try {
      const result = await issue(fund, address, shares);
      setDeposit({ state: "done", message: `Deposited. You received ${formatAmount(shares)} ${fund.symbol}.`, url: result.url });
      setPlanVersion((v) => v + 1);
      onChanged();
    } catch (err) {
      setDeposit({ state: "failed", message: explain(err) });
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-[0.875rem] text-muted-foreground">
        Two steps: buy the basket, then deposit it. Stellar runs exchange trades and contract calls as separate
        transactions, so you sign twice.
      </p>

      <Step n={1} title="Get the basket" done={basketReady}>
        {plan.loading && !plan.data && <p className="text-[0.875rem] text-muted-foreground">Checking your wallet…</p>}
        {plan.error != null && <p className="text-[0.875rem] text-destructive">{explain(plan.error)}</p>}
        {basketReady && <p className="text-[0.875rem] text-muted-foreground">Your wallet already holds everything this deposit needs.</p>}
        {plan.data && plan.data.legs.length > 0 && (
          <>
            <ul className="space-y-2 text-[0.875rem]">
              {plan.data.legs.map((leg) => (
                <li key={leg.code}>
                  <div className="flex justify-between gap-3">
                    <span>
                      Buy {leg.code}
                      {leg.needsTrustline && <span className="text-muted-foreground"> (adds it to your wallet)</span>}
                    </span>
                    <span className="num">{formatAmount(leg.shortfall)}</span>
                  </div>
                  {leg.blocked ? (
                    <p className="text-muted-foreground">{leg.blocked}</p>
                  ) : (
                    <p className="text-muted-foreground">
                      {leg.route}, at most <span className="num">{formatAmount(leg.sendMax ?? 0n)}</span> XLM
                    </p>
                  )}
                </li>
              ))}
            </ul>
            {plan.data.totalSendMax > 0n && (
              <p className="text-[0.875rem]">
                Spends at most <span className="num">{formatAmount(plan.data.totalSendMax)}</span> XLM, quoted just now with 2% room for price movement.
              </p>
            )}
            <Button className="w-full" onClick={runBuy} busy={buy.state === "working"} disabled={!plan.data.xdr}>
              {legBlocked && plan.data.legs.every((l) => l.blocked) ? "Add the assets to my wallet" : "Buy the basket"}
            </Button>
          </>
        )}
        <TxNotice phase={buy} />
      </Step>

      <Step n={2} title="Deposit" done={deposit.state === "done"}>
        <Button
          className="w-full"
          onClick={runIssue}
          busy={deposit.state === "working"}
          disabled={!valid || !basketReady}
          variant={basketReady ? "primary" : "secondary"}
        >
          Deposit and receive {valid ? formatAmount(shares ?? 0n) : ""} {fund.symbol}
        </Button>
        <TxNotice phase={deposit} />
      </Step>
    </div>
  );
}

function UsdcCheckout({
  fund,
  plan,
  shares,
  quote,
  onDone,
}: {
  fund: Fund;
  plan: ZapPlan;
  shares: bigint | null;
  quote: IssueQuote | undefined;
  onDone: () => void;
}) {
  const { address } = useWallet();
  const [walletVersion, setWalletVersion] = useState(0);
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });
  const wallet = useAsync(() => usdcWallet(address ?? ""), address ? `usdc:${address}` : null, walletVersion);
  const valid = shares !== null && shares > 0n;
  const short = wallet.data && quote ? quote.maxUsdc > wallet.data.balance : false;

  async function pay() {
    if (!address || !shares || !quote) return;
    setPhase({ state: "working", message: "Confirm in your wallet. One signature buys the basket and deposits it…" });
    try {
      const result = await zapIssue(fund, plan, address, shares, quote.maxUsdc);
      setPhase({
        state: "done",
        message: `Invested. You paid ${formatAmount(result.result, 4)} USDC for ${formatAmount(shares)} ${fund.symbol}.`,
        url: result.url,
      });
      setWalletVersion((v) => v + 1);
      onDone();
    } catch (err) {
      setPhase({ state: "failed", message: explainZap(err) });
    }
  }

  if (!address) return null;
  if (wallet.data && !wallet.data.hasTrustline) {
    return <AddUsdc address={address} why="Paying with USDC needs it." onAdded={() => setWalletVersion((v) => v + 1)} />;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 text-[0.875rem]">
        <span className="text-muted-foreground">USDC in your wallet</span>
        {wallet.data ? <span className="num">{formatAmount(wallet.data.balance, 4)}</span> : <span className="skeleton w-12">0</span>}
      </div>
      {short && quote && wallet.data && (
        <p className="text-[0.875rem] text-destructive">
          This needs up to {formatAmount(quote.maxUsdc, 4)} USDC and your wallet holds {formatAmount(wallet.data.balance, 4)}. Try fewer shares.
        </p>
      )}
      <Button className="w-full" onClick={pay} busy={phase.state === "working"} disabled={!valid || !quote || short || !wallet.data}>
        Pay with USDC and receive {valid ? formatAmount(shares ?? 0n) : ""} {fund.symbol}
      </Button>
      <TxNotice phase={phase} />
    </div>
  );
}

export function InvestPanel({ fund, position, onChanged }: { fund: Fund; position: Position | null; onChanged: () => void }) {
  const { address, connect, connecting } = useWallet();
  const [input, setInput] = useState("1");
  const shares = toUnits(input);
  const valid = shares !== null && shares > 0n;
  const [chosen, setChosen] = useState<InvestMode | null>(null);
  const [quoteVersion, setQuoteVersion] = useState(0);

  const zap = useAsync(() => zapPlan(fund), fund.id);
  const plan = zap.data ?? null;
  const zappable = plan !== null && plan.blocked === null && fund.setup?.open === true;
  const mode: InvestMode = zappable ? (chosen ?? "usdc") : "basket";

  const quote = useAsync(() => quoteIssue(fund, shares ?? 0n), valid && mode === "basket" ? `${fund.id}:${shares}` : null);
  const zapQuote = useAsync(
    () => (plan ? quoteZapIssue(fund, plan, shares ?? 0n) : Promise.reject(new Error("This fund can't take USDC."))),
    valid && mode === "usdc" ? `zap:${fund.id}:${shares}` : null,
    quoteVersion,
  );

  const blockedByIssuer = fund.awaitingIssuer.length > 0;
  const notApproved = fund.compliance === "Allowlist" && position !== null && !position.isInvestor;

  return (
    <div className="space-y-5">
      {zap.loading && !zap.data ? (
        <div className="skeleton h-10 w-full rounded-full" />
      ) : (
        zappable && <ModeSwitch label="How to pay" options={MODES} value={mode} onChange={setChosen} />
      )}

      <SharesInput id="invest-shares" label={`Shares of ${fund.symbol}`} value={input} onChange={setInput} invalid={!valid && input !== ""} />

      {mode === "usdc" && plan ? (
        <div className="space-y-3">
          <ZapQuote
            label="You pay about"
            usdc={zapQuote.data?.usdc}
            loading={valid && zapQuote.loading}
            error={zapQuote.error}
            bound={
              zapQuote.data
                ? `At most ${formatAmount(zapQuote.data.maxUsdc, 4)} USDC, quoted on Soroswap just now with 1% room for price movement. Anything unspent comes back.`
                : null
            }
          />
          <ZapRoutes plan={plan} direction="issue" />
        </div>
      ) : (
        <div>
          <div className="text-[0.8125rem] text-muted-foreground">You deposit</div>
          <ul className="mt-2 space-y-1.5">
            {fund.components.map((leg, i) => (
              <li key={leg.token} className="flex justify-between gap-3 text-[0.9375rem]">
                <span>{leg.code}</span>
                <span className="num">
                  {quote.data ? formatAmount(quote.data[i] ?? 0n) : valid ? <span className="skeleton w-16">0</span> : "0"}
                </span>
              </li>
            ))}
          </ul>
          {plan?.blocked && (
            <p className="mt-3 text-[0.8125rem] text-muted-foreground">
              Paying with USDC in one signature needs a Soroswap pool for every asset. {plan.blocked}
            </p>
          )}
        </div>
      )}

      {blockedByIssuer ? (
        <p className="rounded-md bg-warning-surface px-3 py-2.5 text-[0.875rem]">
          Waiting on issuer authorization: issuing opens when the issuer authorizes this fund's address.
        </p>
      ) : fund.setup && !fund.setup.open ? (
        <p className="rounded-md bg-secondary px-3 py-2.5 text-[0.875rem]">
          The manager is still setting this fund up. Investing opens once they've fixed its fee and mandate, which can't change after.
        </p>
      ) : !address ? (
        <Button className="w-full" onClick={connect} busy={connecting}>
          Connect wallet to invest
        </Button>
      ) : notApproved ? (
        <div className="space-y-2 rounded-md bg-secondary px-3 py-3 text-[0.875rem]">
          <p>This fund only accepts investors its manager has approved, and your address isn't on the list yet. Send the manager this address to be added:</p>
          <CopyId id={address} kind="account" />
        </div>
      ) : mode === "usdc" && plan ? (
        <UsdcCheckout
          fund={fund}
          plan={plan}
          shares={shares}
          quote={zapQuote.data}
          onDone={() => {
            setQuoteVersion((v) => v + 1);
            onChanged();
          }}
        />
      ) : (
        <BasketSteps fund={fund} shares={shares} onChanged={onChanged} />
      )}
    </div>
  );
}

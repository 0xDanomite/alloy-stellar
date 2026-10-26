import { useState } from "react";
import { formatAmount, toUnits } from "../lib/format";
import { explain, issue, planBasket, quoteIssue, submitClassic, type Fund, type Position } from "../lib/stellar";
import { expert } from "../lib/config";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { Button, CopyId, TxNotice, type TxPhase } from "./ui";
import { SharesInput, Step } from "./panel-bits";

export function InvestPanel({ fund, position, onChanged }: { fund: Fund; position: Position | null; onChanged: () => void }) {
  const { address, connect, connecting } = useWallet();
  const [input, setInput] = useState("1");
  const shares = toUnits(input);
  const valid = shares !== null && shares > 0n;
  const [planVersion, setPlanVersion] = useState(0);
  const [buy, setBuy] = useState<TxPhase>({ state: "idle" });
  const [deposit, setDeposit] = useState<TxPhase>({ state: "idle" });

  const quote = useAsync(() => quoteIssue(fund, shares ?? 0n), valid ? `${fund.id}:${shares}` : null);
  const plan = useAsync(
    () => planBasket(fund, address ?? "", shares ?? 0n),
    valid && address ? `${fund.id}:${address}:${shares}` : null,
    planVersion,
  );

  const blockedByIssuer = fund.awaitingIssuer.length > 0;
  const notApproved = fund.compliance === "Allowlist" && position !== null && !position.isInvestor;
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
    <div className="space-y-5">
      <SharesInput id="invest-shares" label={`Shares of ${fund.symbol}`} value={input} onChange={setInput} invalid={!valid && input !== ""} />

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
      </div>

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
      ) : (
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
      )}
    </div>
  );
}

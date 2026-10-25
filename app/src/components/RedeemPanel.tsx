import { useState } from "react";
import { formatAmount, toDecimalString, toUnits } from "../lib/format";
import {
  ChainError,
  explain,
  quoteRedeem,
  redeem,
  simulateRedeem,
  unreceivableLegs,
  withdrawOwed,
  type Fund,
  type FundComponent,
  type Position,
} from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { Button, TxNotice, type TxPhase } from "./ui";
import { SharesInput } from "./panel-bits";

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

export function RedeemPanel({ fund, position, onChanged }: { fund: Fund; position: Position | null; onChanged: () => void }) {
  const { address, connect, connecting } = useWallet();
  const [input, setInput] = useState("1");
  const shares = toUnits(input);
  const valid = shares !== null && shares > 0n;
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });
  const [skipOffer, setSkipOffer] = useState<FundComponent[] | null>(null);

  const quote = useAsync(() => quoteRedeem(fund, shares ?? 0n), valid && fund.totalSupply > 0n ? `${fund.id}:${shares}` : null);
  const tooMany = valid && position !== null && (shares ?? 0n) > position.shares;

  async function run(skip: FundComponent[]) {
    if (!address || !shares) return;
    setSkipOffer(null);
    setPhase({ state: "working", message: "Checking the redemption…" });
    const skipIds = skip.map((s) => s.token);
    try {
      await simulateRedeem(fund, address, shares, skipIds);
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
      onChanged();
    } catch (err) {
      setPhase({ state: "failed", message: explain(err) });
    }
  }

  return (
    <div className="space-y-5">
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
          {position && <OwedClaims fund={fund} position={position} onChanged={onChanged} />}
        </>
      )}
    </div>
  );
}

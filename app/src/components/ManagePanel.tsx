import { useMemo, useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { explain, rebalance, rebalanceOracle, setCompliance, setInvestor, type Compliance, type Fund } from "../lib/stellar";
import { formatAmount, toUnits, unitsToNumber } from "../lib/format";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { Button, TxNotice, type TxPhase } from "./ui";

export function ManagePanel({ fund, onChanged }: { fund: Fund; onChanged: () => void }) {
  const { address } = useWallet();
  const [access, setAccess] = useState<TxPhase>({ state: "idle" });
  const [investor, setInvestorInput] = useState("");
  const [approval, setApproval] = useState<TxPhase>({ state: "idle" });
  const validInvestor = StrKey.isValidEd25519PublicKey(investor) || StrKey.isValidContract(investor);
  const permissioned = fund.components.some((leg) => leg.shelfStatus === "Permissioned");

  async function switchAccess(next: Compliance) {
    if (!address || next === fund.compliance) return;
    setAccess({ state: "working", message: "Confirm the change in your wallet…" });
    try {
      const result = await setCompliance(fund, address, next);
      setAccess({ state: "done", message: next === "Open" ? "The fund is open to anyone." : "Only approved investors can buy in now.", url: result.url });
      onChanged();
    } catch (err) {
      setAccess({ state: "failed", message: explain(err) });
    }
  }

  async function approve(allowed: boolean) {
    if (!address || !validInvestor) return;
    setApproval({ state: "working", message: "Confirm in your wallet…" });
    try {
      const result = await setInvestor(fund, address, investor, allowed);
      setApproval({ state: "done", message: allowed ? "Investor approved." : "Investor removed.", url: result.url });
      setInvestorInput("");
    } catch (err) {
      setApproval({ state: "failed", message: explain(err) });
    }
  }

  return (
    <div className="space-y-6">
      <p className="text-[0.875rem] text-muted-foreground">You manage this fund. Redemptions can't be paused, by you or anyone.</p>

      <RebalanceForm fund={fund} onChanged={onChanged} />

      <section className="space-y-2">
        <h3 className="text-label">Who can invest</h3>
        <div className="grid grid-cols-2 gap-2 rounded-full border p-1">
          {(["Open", "Allowlist"] as const).map((option) => (
            <button
              key={option}
              type="button"
              disabled={access.state === "working" || (permissioned && option === "Open")}
              onClick={() => switchAccess(option)}
              aria-pressed={fund.compliance === option}
              className={`rounded-full py-2 text-label disabled:opacity-40 ${fund.compliance === option ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {option === "Open" ? "Anyone" : "Approved"}
            </button>
          ))}
        </div>
        <TxNotice phase={access} />
      </section>

      <section className="space-y-2">
        <h3 className="text-label">Approve an investor</h3>
        <input
          value={investor}
          onChange={(e) => setInvestorInput(e.target.value.trim())}
          placeholder="G… address"
          aria-invalid={investor !== "" && !validInvestor}
          className="num w-full rounded-md border bg-surface-sunken px-3 py-2.5 text-[0.875rem] outline-none focus:border-ring aria-[invalid=true]:border-destructive"
        />
        <div className="flex gap-2">
          <Button className="flex-1" onClick={() => approve(true)} disabled={!validInvestor} busy={approval.state === "working"}>
            Approve
          </Button>
          <Button variant="secondary" onClick={() => approve(false)} disabled={!validInvestor || approval.state === "working"}>
            Remove
          </Button>
        </div>
        <TxNotice phase={approval} />
      </section>
    </div>
  );
}

const QUOTE_HAIRCUT = 0.995;

function RebalanceForm({ fund, onChanged }: { fund: Fund; onChanged: () => void }) {
  const { address } = useWallet();
  const oracle = useAsync(() => rebalanceOracle(fund), `oracle:${fund.id}`);
  const legs = fund.components;
  const [sellIndex, setSellIndex] = useState(0);
  const [buyIndex, setBuyIndex] = useState(Math.min(1, legs.length - 1));
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });
  const sell = legs[sellIndex];
  const buy = legs[buyIndex];
  const sold = toUnits(input);

  const bought = useMemo(() => {
    const sellPrice = sell?.oracle?.priceUsd;
    const buyPrice = buy?.oracle?.priceUsd;
    if (!sold || !sellPrice || !buyPrice) return null;
    const amount = (unitsToNumber(sold) * sellPrice * QUOTE_HAIRCUT) / buyPrice;
    return toUnits(amount.toFixed(7));
  }, [sell, buy, sold]);

  if (oracle.data === null) {
    return (
      <section className="space-y-2">
        <h3 className="text-label">Rebalance</h3>
        <p className="text-[0.875rem] text-muted-foreground">This fund was deployed before rebalancing shipped.</p>
      </section>
    );
  }

  async function run() {
    if (!address || !sell || !buy || !sold || !bought) return;
    setPhase({ state: "working", message: "Confirm the rebalance in your wallet…" });
    try {
      const result = await rebalance(fund, address, sell.token, sold, buy.token, bought);
      setPhase({ state: "done", message: `Rebalanced: ${formatAmount(sold)} ${sell.code} out, ${formatAmount(bought)} ${buy.code} in.`, url: result.url });
      setInput("");
      onChanged();
    } catch (err) {
      setPhase({ state: "failed", message: explain(err) });
    }
  }

  const select = "w-full rounded-md border bg-surface-sunken px-3 py-2.5 text-[0.875rem] outline-none focus:border-ring";
  return (
    <section className="space-y-3">
      <h3 className="text-label">Rebalance</h3>
      <p className="text-[0.8125rem] text-muted-foreground">
        Swap one holding for another inside the fund. You send the asset bought; the fund sends back the asset sold. The
        contract rejects any fill worth less than 99% at oracle prices.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-[0.8125rem] text-muted-foreground">
          Sell
          <select className={select} value={sellIndex} onChange={(e) => setSellIndex(Number(e.target.value))}>
            {legs.map((leg, i) => (
              <option key={leg.token} value={i}>{leg.code === "XLM" ? "Lumens" : leg.code}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[0.8125rem] text-muted-foreground">
          Buy
          <select className={select} value={buyIndex} onChange={(e) => setBuyIndex(Number(e.target.value))}>
            {legs.map((leg, i) => (
              <option key={leg.token} value={i}>{leg.code === "XLM" ? "Lumens" : leg.code}</option>
            ))}
          </select>
        </label>
      </div>
      <input
        inputMode="decimal"
        value={input}
        onChange={(e) => setInput(e.target.value.replace(",", "."))}
        placeholder={`${sell?.code ?? ""} to sell, of ${sell ? formatAmount(sell.holding) : "0"} held`}
        className="num w-full rounded-md border bg-surface-sunken px-3 py-2.5 text-[0.875rem] outline-none focus:border-ring"
      />
      {bought !== null && buy && (
        <p className="text-[0.875rem]">
          You send <span className="num">{formatAmount(bought)}</span> {buy.code === "XLM" ? "Lumens" : buy.code} at oracle price, less 0.5%.
        </p>
      )}
      <Button className="w-full" onClick={run} disabled={!bought || sellIndex === buyIndex} busy={phase.state === "working" || oracle.data === undefined}>
        Rebalance
      </Button>
      <TxNotice phase={phase} />
    </section>
  );
}

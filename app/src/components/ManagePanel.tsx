import { useState } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { explain, setCompliance, setInvestor, type Compliance, type Fund } from "../lib/stellar";
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

import { useMemo, useState, type ReactNode } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { annualFeeUsd, formatBps, percentToBps, sharesUsd, splitFee } from "../lib/fee-math";
import { formatAmount, formatUsd, toUnits, unitsToNumber } from "../lib/format";
import { fundValueUsd } from "../lib/fund-math";
import {
  accrueFee,
  claimFee,
  loadEarnings,
  loadSetupDraft,
  prepareHandover,
  setMetadata,
  setupSteps,
  type SetupPlan,
  type SetupStep,
} from "../lib/manager";
import { explain, rebalance, rebalanceOracle, setCompliance, setInvestor, type Compliance, type Fund, type FundMetadata, type Mandate } from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { parseWebsite } from "../lib/website";
import { headlineValue, MANDATES, mandateOf } from "./fund-bits";
import { RebalancePlanner } from "./RebalancePlanner";
import { SetupChecklist } from "./SetupChecklist";
import { Button, CopyId, TxNotice, type TxPhase } from "./ui";

type Section = "trade" | "earnings" | "profile" | "access";

const input = "w-full rounded-md border bg-surface-sunken px-3 py-2.5 text-[0.875rem] outline-none focus:border-ring aria-[invalid=true]:border-destructive";

export function ManagePanel({ fund, onChanged, onPreview }: { fund: Fund; onChanged: () => void; onPreview: () => void }) {
  const v4 = fund.setup !== null;
  const sections: { id: Section; label: string }[] = v4
    ? [
        { id: "trade", label: "Trade" },
        { id: "earnings", label: "Earnings" },
        { id: "profile", label: "Profile" },
        { id: "access", label: "Access" },
      ]
    : [
        { id: "trade", label: "Trade" },
        { id: "access", label: "Access" },
      ];
  const [section, setSection] = useState<Section>("trade");

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[0.875rem] text-muted-foreground">You manage this fund. Redemptions can't be paused, by you or anyone.</p>
        <button type="button" onClick={onPreview} className="shrink-0 text-label text-primary hover:underline">
          View as investor
        </button>
      </div>

      {fund.setup && !fund.setup.open && <FinishSetup fund={fund} onChanged={onChanged} />}
      {!v4 && (
        <p className="rounded-md bg-secondary px-3 py-2.5 text-[0.8125rem]">
          This fund runs code from before v0.4, so it has no fee, mandate, profile or Soroswap trades. Rebalancing and access work as before.
        </p>
      )}

      <div className={`grid gap-1 rounded-full border p-1 ${sections.length === 4 ? "grid-cols-4" : "grid-cols-2"}`} role="tablist" aria-label="Manage">
        {sections.map((s) => (
          <button
            key={s.id}
            role="tab"
            type="button"
            aria-selected={section === s.id}
            onClick={() => setSection(s.id)}
            className={`rounded-full py-1.5 text-[0.8125rem] font-medium ${section === s.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === "trade" &&
        (v4 ? (
          mandateOf(fund) === "Static" ? (
            <p className="text-[0.875rem] text-muted-foreground">{MANDATES.Static.detail}</p>
          ) : (
            <RebalancePlanner fund={fund} onChanged={onChanged} />
          )
        ) : (
          <RebalanceForm fund={fund} onChanged={onChanged} />
        ))}
      {section === "earnings" && v4 && <Earnings fund={fund} onChanged={onChanged} />}
      {section === "profile" && v4 && <ProfileEditor key={JSON.stringify(fund.metadata)} fund={fund} onChanged={onChanged} />}
      {section === "access" && (
        <>
          <AccessControls fund={fund} onChanged={onChanged} />
          <Handover fund={fund} />
        </>
      )}
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="text-label">{title}</h3>
      {children}
    </section>
  );
}

/** A v0.4 fund that hasn't opened: the fee and mandate still to settle, then the open call. */
function FinishSetup({ fund, onChanged }: { fund: Fund; onChanged: () => void }) {
  const draft = useMemo(() => loadSetupDraft(fund.id), [fund.id]);
  const setup = fund.setup;
  const [fee, setFee] = useState(draft ? String(draft.feeBps / 100) : "0");
  const [mandate, setMandate] = useState<Mandate>(draft?.mandate ?? setup?.mandate ?? "Locked");
  const feeBps = setup?.fee ? setup.fee.rateBps : percentToBps(fee);
  const plan: SetupPlan = { metadata: draft?.metadata ?? {}, feeBps: feeBps ?? 0, mandate: setup?.mandate ?? mandate };
  const steps = feeBps === null ? [] : setupSteps(fund, plan);

  return (
    <section className="space-y-4 rounded-lg border border-warning/40 bg-warning-surface p-4">
      <div>
        <h3 className="text-label">Not open for investment yet</h3>
        <p className="mt-1 text-[0.8125rem] text-muted-foreground">
          {draft
            ? "Your choices from creating the fund are below. Opening freezes the fee and mandate for good."
            : "Settle the fee and mandate, then open the fund. Opening freezes both for good."}
        </p>
      </div>
      {!setup?.fee && !draft && (
        <label className="block space-y-1 text-[0.8125rem] text-muted-foreground">
          Annual fee, 0 to 5%
          <input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value.replace(",", "."))} aria-invalid={feeBps === null} className={`num ${input}`} />
        </label>
      )}
      {!setup?.mandate && !draft && (
        <div className="grid grid-cols-3 gap-1 rounded-full border bg-card p-1">
          {(Object.keys(MANDATES) as Mandate[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMandate(m)}
              aria-pressed={mandate === m}
              title={MANDATES[m].detail}
              className={`rounded-full py-1.5 text-[0.8125rem] ${mandate === m ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              {m}
            </button>
          ))}
        </div>
      )}
      <p className="text-[0.8125rem]">
        {plan.feeBps > 0 ? `${formatBps(plan.feeBps)} a year` : "No fee"}, {MANDATES[plan.mandate].label.toLowerCase()} mandate.
      </p>
      {steps.length > 0 && <SetupChecklist steps={steps} onFinished={onChanged} actionLabel="Sign and open" />}
    </section>
  );
}

function Earnings({ fund, onChanged }: { fund: Fund; onChanged: () => void }) {
  const { address } = useWallet();
  const setup = fund.setup;
  const [version, setVersion] = useState(0);
  const earnings = useAsync(() => loadEarnings(fund), `earnings:${fund.id}`, version);
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });
  if (!setup) return null;
  const nav = headlineValue(fund).value;
  const aum = fundValueUsd(fund);
  const rate = setup.fee?.rateBps ?? 0;
  const platformBps = setup.platformFee?.shareBps ?? 0;
  const pending = earnings.data ? splitFee(earnings.data.pendingShares, platformBps) : null;
  const yearly = aum !== null ? annualFeeUsd(aum, rate, platformBps) : null;

  async function act(kind: "accrue" | "claim") {
    if (!address || !setup) return;
    setPhase({ state: "working", message: "Confirm in your wallet…" });
    try {
      const result = kind === "accrue" ? await accrueFee(fund, address) : await claimFee(fund, address, setup.feeRecipient);
      setPhase({ state: "done", message: kind === "accrue" ? "Fee shares minted." : "Escrowed fee shares released.", url: result.url });
      setVersion((v) => v + 1);
      onChanged();
    } catch (err) {
      setPhase({ state: "failed", message: explain(err) });
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-filing text-muted-foreground">Fee</div>
          <div className="num text-figure">{setup.fee ? `${formatBps(rate)}` : setup.open ? "None" : "Not set"}</div>
          <div className="text-[0.75rem] text-muted-foreground">a year, frozen</div>
        </div>
        <div>
          <div className="text-filing text-muted-foreground">Accrued, unminted</div>
          <div className="num text-figure">{pending ? formatAmount(pending.manager, 4) : earnings.error != null ? <span className="text-muted-foreground">n/a</span> : <span className="skeleton w-16">0</span>}</div>
          <div className="text-[0.75rem] text-muted-foreground">
            shares to you{pending && sharesUsd(pending.manager, nav) !== null ? `, $${formatUsd(sharesUsd(pending.manager, nav) ?? 0)}` : ""}
          </div>
        </div>
      </div>
      <dl className="divide-y rounded-lg border text-[0.8125rem]">
        <Row term="At today's size">
          {yearly && rate > 0 ? <span><span className="num">${formatUsd(yearly.manager)}</span> a year to you</span> : <span className="text-muted-foreground">n/a</span>}
        </Row>
        <Row term="Platform share">
          {setup.platformFee ? (
            <span>
              <span className="num">{formatBps(platformBps)}</span> of the fee
              {yearly && rate > 0 && <span className="text-muted-foreground">, <span className="num">${formatUsd(yearly.platform)}</span> a year</span>}
            </span>
          ) : (
            <span className="text-muted-foreground">None</span>
          )}
        </Row>
        <Row term="Paid to">
          <CopyId id={setup.feeRecipient} kind={setup.feeRecipient.startsWith("C") ? "contract" : "account"} head={4} tail={4} />
        </Row>
      </dl>
      {earnings.data && earnings.data.escrow > 0n && (
        <div className="space-y-2 rounded-lg border p-3 text-[0.8125rem]">
          <p>
            <span className="num">{formatAmount(earnings.data.escrow)}</span> fee shares are held for you because this fund only admits
            approved investors. Approve your own address on the Access tab, then release them.
          </p>
          <Button variant="secondary" className="w-full" onClick={() => act("claim")} busy={phase.state === "working"}>
            Release escrowed shares
          </Button>
        </div>
      )}
      <Button variant="secondary" className="w-full" onClick={() => act("accrue")} busy={phase.state === "working"} disabled={!setup.fee || rate === 0}>
        Mint accrued fee now
      </Button>
      <TxNotice phase={phase} />
      <p className="text-[0.8125rem] text-muted-foreground">
        The fee mints new shares continuously; every issue and redemption mints what has accrued, so this button is only for collecting
        between them.
      </p>
    </div>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

const PROFILE_FIELDS: { key: keyof FundMetadata; label: string; rows: number }[] = [
  { key: "description", label: "Description", rows: 3 },
  { key: "strategy", label: "Strategy", rows: 2 },
  { key: "website", label: "Website", rows: 1 },
];

function ProfileEditor({ fund, onChanged }: { fund: Fund; onChanged: () => void }) {
  const [values, setValues] = useState<Record<keyof FundMetadata, string>>({
    description: fund.metadata.description ?? "",
    strategy: fund.metadata.strategy ?? "",
    website: fund.metadata.website ?? "",
  });
  const [saving, setSaving] = useState<SetupStep[] | null>(null);
  const changed = PROFILE_FIELDS.filter(({ key }) => values[key].trim() !== (fund.metadata[key] ?? ""));
  const tooLong = PROFILE_FIELDS.some(({ key }) => new TextEncoder().encode(values[key].trim()).length > 512);
  const badSite = values.website.trim() !== "" && parseWebsite(values.website) === null;

  function save() {
    setSaving(
      changed.map(({ key, label }) => ({
        id: `metadata:${key}`,
        label: values[key].trim() ? `Save the ${label.toLowerCase()}` : `Clear the ${label.toLowerCase()}`,
        done: false,
        run: (address: string) => setMetadata(fund, address, key, values[key].trim()),
      })),
    );
  }

  if (saving) {
    return (
      <div className="space-y-3">
        <p className="text-[0.8125rem] text-muted-foreground">Each field is its own transaction.</p>
        <SetupChecklist steps={saving} onFinished={onChanged} actionLabel="Save changes" />
        <Button variant="ghost" className="w-full" onClick={() => setSaving(null)}>
          Back to editing
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {PROFILE_FIELDS.map(({ key, label, rows }) => (
        <label key={key} className="block space-y-1 text-[0.8125rem] text-muted-foreground">
          {label}
          {rows > 1 ? (
            <textarea value={values[key]} rows={rows} onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))} className={`${input} resize-y text-foreground`} />
          ) : (
            <input
              value={values[key]}
              onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value.trim() }))}
              placeholder="https://"
              aria-invalid={badSite}
              className={`${input} text-foreground`}
            />
          )}
        </label>
      ))}
      {tooLong && <p className="text-[0.8125rem] text-destructive">Each field holds at most 512 bytes.</p>}
      <Button className="w-full" onClick={save} disabled={changed.length === 0 || tooLong || badSite}>
        {changed.length > 1 ? `Save ${changed.length} changes` : "Save"}
      </Button>
      <p className="text-[0.8125rem] text-muted-foreground">Stored on the fund contract and shown on the fund page and the funds list.</p>
    </div>
  );
}

function AccessControls({ fund, onChanged }: { fund: Fund; onChanged: () => void }) {
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
    <>
      <Block title="Who can invest">
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
      </Block>

      <Block title="Approve an investor">
        <input
          value={investor}
          onChange={(e) => setInvestorInput(e.target.value.trim())}
          placeholder="G… address"
          aria-invalid={investor !== "" && !validInvestor}
          className={`num ${input}`}
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
      </Block>
    </>
  );
}

/** Hands the fund to a new manager: both must authorize `set_manager`, so it takes two signatures from two wallets. */
function Handover({ fund }: { fund: Fund }) {
  const { address } = useWallet();
  const [incoming, setIncoming] = useState("");
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });
  const [link, setLink] = useState<string | null>(null);
  const valid = StrKey.isValidEd25519PublicKey(incoming) && incoming !== fund.manager;

  async function prepare() {
    if (!address || !valid) return;
    setLink(null);
    setPhase({ state: "working", message: "Approve the handover in your wallet…" });
    try {
      const param = await prepareHandover(fund, address, incoming);
      setLink(`${window.location.origin}/fund/${fund.id}?handover=${param}`);
      setPhase({ state: "idle" });
    } catch (err) {
      setPhase({ state: "failed", message: explain(err) });
    }
  }

  return (
    <Block title="Hand over management">
      <p className="text-[0.8125rem] text-muted-foreground">
        The new manager must agree too. You approve here; they open a link, check it and sign a transaction from their own account that
        names them manager. Until they do, nothing changes.
      </p>
      <input value={incoming} onChange={(e) => setIncoming(e.target.value.trim())} placeholder="New manager, G… address" aria-invalid={incoming !== "" && !valid} className={`num ${input}`} />
      <Button variant="secondary" className="w-full" onClick={prepare} disabled={!valid} busy={phase.state === "working"}>
        Approve handover
      </Button>
      <TxNotice phase={phase} />
      {link && (
        <div className="space-y-2 rounded-lg border p-3 text-[0.8125rem]">
          <p>
            Send this link to the new manager. It's good for about a day, and only their account can use it. If their account sends another
            transaction first, approve again.
          </p>
          <div className="flex items-center gap-2">
            <input readOnly value={link} className={`num ${input} py-1.5 text-[0.75rem]`} onFocus={(e) => e.target.select()} aria-label="Handover link" />
            <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(link)}>
              Copy
            </Button>
          </div>
        </div>
      )}
    </Block>
  );
}

const QUOTE_HAIRCUT = 0.995;

/** The single-trade form for funds on code from before v0.4. */
function RebalanceForm({ fund, onChanged }: { fund: Fund; onChanged: () => void }) {
  const { address } = useWallet();
  const oracle = useAsync(() => rebalanceOracle(fund), `oracle:${fund.id}`);
  const legs = fund.components;
  const [sellIndex, setSellIndex] = useState(0);
  const [buyIndex, setBuyIndex] = useState(Math.min(1, legs.length - 1));
  const [amount, setAmount] = useState("");
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });
  const sell = legs[sellIndex];
  const buy = legs[buyIndex];
  const sold = toUnits(amount);

  const bought = useMemo(() => {
    const sellPrice = sell?.oracle?.priceUsd;
    const buyPrice = buy?.oracle?.priceUsd;
    if (!sold || !sellPrice || !buyPrice) return null;
    const value = (unitsToNumber(sold) * sellPrice * QUOTE_HAIRCUT) / buyPrice;
    return toUnits(value.toFixed(7));
  }, [sell, buy, sold]);

  if (oracle.data === null) {
    return <p className="text-[0.875rem] text-muted-foreground">This fund was deployed before rebalancing shipped.</p>;
  }

  async function run() {
    if (!address || !sell || !buy || !sold || !bought) return;
    setPhase({ state: "working", message: "Confirm the rebalance in your wallet…" });
    try {
      const result = await rebalance(fund, address, sell.token, sold, buy.token, bought);
      setPhase({ state: "done", message: `Rebalanced: ${formatAmount(sold)} ${sell.code} out, ${formatAmount(bought)} ${buy.code} in.`, url: result.url });
      setAmount("");
      onChanged();
    } catch (err) {
      setPhase({ state: "failed", message: explain(err) });
    }
  }

  return (
    <section className="space-y-3">
      <p className="text-[0.8125rem] text-muted-foreground">
        Swap one holding for another inside the fund. You send the asset bought; the fund sends back the asset sold. The contract rejects
        any fill worth less than 99% at oracle prices.
      </p>
      <div className="grid grid-cols-2 gap-2">
        <label className="space-y-1 text-[0.8125rem] text-muted-foreground">
          Sell
          <select className={input} value={sellIndex} onChange={(e) => setSellIndex(Number(e.target.value))}>
            {legs.map((leg, i) => (
              <option key={leg.token} value={i}>{leg.code === "XLM" ? "Lumens" : leg.code}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-[0.8125rem] text-muted-foreground">
          Buy
          <select className={input} value={buyIndex} onChange={(e) => setBuyIndex(Number(e.target.value))}>
            {legs.map((leg, i) => (
              <option key={leg.token} value={i}>{leg.code === "XLM" ? "Lumens" : leg.code}</option>
            ))}
          </select>
        </label>
      </div>
      <input
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(",", "."))}
        placeholder={`${sell?.code ?? ""} to sell, of ${sell ? formatAmount(sell.holding) : "0"} held`}
        className={`num ${input}`}
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

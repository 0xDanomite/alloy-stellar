import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { AssetDot, IssuerName, MANDATES, strandColor } from "../components/fund-bits";
import { ArrowLeft } from "../components/icons";
import { SetupChecklist } from "../components/SetupChecklist";
import { Button, TxNotice, Usd, type TxPhase } from "../components/ui";
import { formatBps, percentToBps, stakeAfter } from "../lib/fee-math";
import { formatAmount, formatUsd, shortId } from "../lib/format";
import { clearSetupDraft, draftFundIds, saveSetupDraft, setupCallCount, setupSteps, type SetupPlan } from "../lib/manager";
import {
  createFund,
  explain,
  findFund,
  isManager,
  loadShelf,
  oraclePrices,
  platformDeploysV4,
  type Compliance,
  type Fund,
  type FundMetadata,
  type Mandate,
  type ShelfAsset,
} from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { evenPercents, percentTotal, unitsForWeights } from "../lib/weights";
import { useWallet } from "../lib/wallet";

const SYMBOL_PATTERN = /^[A-Za-z0-9]{1,12}$/;
const WEBSITE_PATTERN = /^https:\/\/[^\s/]+\.[^\s]+$/;
const MAX_METADATA_BYTES = 512;
const MAX_COMPONENTS = 12;
const NAV_PRESETS = [1, 10, 100];
const FEE_PRESETS = ["0", "0.25", "0.5", "1", "2"];

const STEPS = ["Profile", "Mandate", "Basket", "Weights", "Fee", "Review", "Sign"] as const;
type StepName = (typeof STEPS)[number];

const fieldBase = "rounded-md border bg-surface-sunken px-3 py-2.5 outline-none focus:border-ring aria-[invalid=true]:border-destructive";
const field = `w-full ${fieldBase}`;
const bytes = (s: string) => new TextEncoder().encode(s).length;
const assetName = (code: string) => (code === "XLM" ? "Lumens" : code);

interface Draft {
  name: string;
  symbol: string;
  access: Compliance;
  metadata: Required<FundMetadata>;
  mandate: Mandate;
  tokens: string[];
  percents: Record<string, string>;
  launchNav: string;
  fee: string;
}

const EMPTY: Draft = {
  name: "",
  symbol: "a",
  access: "Open",
  metadata: { description: "", strategy: "", website: "" },
  mandate: "Locked",
  tokens: [],
  percents: {},
  launchNav: "10",
  fee: "0.5",
};

interface PricedLeg {
  asset: ShelfAsset;
  percent: number;
  priceUsd: number | null;
  basis: "oracle" | "SDEX" | null;
  units: bigint | null;
}

function StepRail({ current, reached, onPick }: { current: number; reached: number; onPick: (i: number) => void }) {
  return (
    <nav aria-label="Create a fund" className="mt-8">
      <div className="flex items-center justify-between gap-4 text-[0.875rem] sm:hidden">
        <span>
          Step <span className="num">{current + 1}</span> of <span className="num">{STEPS.length}</span>: {STEPS[current]}
        </span>
      </div>
      <div className="mt-2 flex h-1 overflow-hidden rounded-full bg-secondary sm:hidden">
        <span className="bg-primary transition-[width]" style={{ width: `${((current + 1) / STEPS.length) * 100}%` }} />
      </div>
      <ol className="hidden gap-1 sm:flex">
        {STEPS.map((name, i) => {
          const done = i < current;
          const enabled = i <= reached && current < STEPS.length - 1;
          return (
            <li key={name} className="flex-1">
              <button
                type="button"
                disabled={!enabled}
                onClick={() => onPick(i)}
                aria-current={i === current ? "step" : undefined}
                className={`flex w-full flex-col gap-2 border-t-2 pt-2.5 text-left text-label disabled:cursor-default ${
                  i === current ? "border-primary text-foreground" : done ? "border-primary/40 text-foreground" : "border-border text-muted-foreground"
                }`}
              >
                <span className="num text-[0.75rem] text-muted-foreground">{i + 1}</span>
                {name}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Labeled({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="flex items-baseline justify-between gap-3">
        <span className="text-label">{label}</span>
        <span aria-hidden>{hint}</span>
      </span>
      <span className="mt-2 block">{children}</span>
    </label>
  );
}

function ByteCount({ value }: { value: string }) {
  const used = bytes(value);
  return <span className={`num text-[0.75rem] ${used > MAX_METADATA_BYTES ? "text-destructive" : "text-muted-foreground"}`}>{used}/{MAX_METADATA_BYTES}</span>;
}

function V3Note({ children }: { children: ReactNode }) {
  return <p className="rounded-md bg-warning-surface px-3 py-2.5 text-[0.875rem]">{children}</p>;
}

/** Funds this browser started creating whose setup never finished. */
function UnfinishedFunds({ address }: { address: string }) {
  const ids = draftFundIds();
  const unfinished = useAsync(
    async () => {
      const funds = await Promise.all(ids.map((id) => findFund(id).catch(() => null)));
      return funds.filter((f): f is Fund => f !== null && f.manager === address && f.setup !== null && !f.setup.open);
    },
    ids.length ? `unfinished:${address}:${ids.join(",")}` : null,
  );
  if (!unfinished.data?.length) return null;
  return (
    <div className="mt-8 rounded-2xl border border-warning/40 bg-warning-surface p-5">
      <h2 className="text-heading">Finish setting up</h2>
      <p className="mt-1 text-[0.875rem] text-muted-foreground">These funds are deployed but not open for investment yet.</p>
      <ul className="mt-3 space-y-2">
        {unfinished.data.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-3">
            <span>
              {f.name} <span className="text-filing text-muted-foreground">{f.symbol}</span>
            </span>
            <Link to={`/fund/${f.id}?tab=manage`} className="rounded-full border bg-card px-3 py-1.5 text-label hover:bg-secondary">
              Continue setup
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function CreatePage() {
  const { address, connect, connecting } = useWallet();
  const navigate = useNavigate();
  const shelf = useAsync(() => loadShelf(), "shelf");
  const v4 = useAsync(() => platformDeploysV4(), "platform-code");
  const manager = useAsync(() => isManager(address ?? ""), address ? `manager:${address}` : null);
  const tokens = shelf.data?.map((a) => a.token) ?? [];
  const oracle = useAsync(() => oraclePrices(tokens), tokens.length ? `oracle:${tokens.join(",")}` : null);

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [step, setStep] = useState(0);
  const [reached, setReached] = useState(0);
  const [create, setCreate] = useState<TxPhase>({ state: "idle" });
  const [created, setCreated] = useState<Fund | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const update = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setMeta = (key: keyof FundMetadata, value: string) => setDraft((d) => ({ ...d, metadata: { ...d.metadata, [key]: value } }));
  const fullCode = v4.data !== false;

  const legs: PricedLeg[] = useMemo(() => {
    const byToken = new Map((shelf.data ?? []).map((a) => [a.token, a]));
    const picked = draft.tokens.map((t) => byToken.get(t)).filter((a): a is ShelfAsset => a !== undefined);
    const priced = picked.map((asset) => {
      const fromOracle = oracle.data?.get(asset.token);
      const priceUsd = fromOracle ?? asset.priceUsdc;
      return {
        asset,
        percent: Number(draft.percents[asset.token] ?? "0"),
        priceUsd,
        basis: fromOracle !== undefined ? ("oracle" as const) : asset.priceUsdc !== null ? ("SDEX" as const) : null,
      };
    });
    const units = unitsForWeights(
      priced.map((l) => ({ weight: l.percent / 100, priceUsd: l.priceUsd })),
      Number(draft.launchNav),
    );
    return priced.map((l, i) => ({ ...l, units: units?.[i] ?? null }));
  }, [shelf.data, oracle.data, draft.tokens, draft.percents, draft.launchNav]);

  const needsAllowlist = legs.some((l) => l.asset.status === "Permissioned");
  const compliance: Compliance = needsAllowlist ? "Allowlist" : draft.access;
  const feeBps = fullCode ? percentToBps(draft.fee) : 0;
  const total = percentTotal(legs.map((l) => l.percent));
  const navValid = Number(draft.launchNav) > 0 && /^\d+(\.\d{1,2})?$/.test(draft.launchNav);
  const plan: SetupPlan = {
    metadata: fullCode
      ? { description: draft.metadata.description.trim(), strategy: draft.metadata.strategy.trim(), website: draft.metadata.website.trim() }
      : {},
    feeBps: feeBps ?? 0,
    mandate: fullCode ? draft.mandate : "Locked",
  };

  const valid: Record<StepName, boolean> = {
    Profile:
      draft.name.trim().length > 0 &&
      SYMBOL_PATTERN.test(draft.symbol) &&
      Object.values(draft.metadata).every((v) => bytes(v.trim()) <= MAX_METADATA_BYTES) &&
      (draft.metadata.website.trim() === "" || WEBSITE_PATTERN.test(draft.metadata.website.trim())),
    Mandate: true,
    Basket: legs.length > 0 && legs.length <= MAX_COMPONENTS,
    Weights: navValid && total === 100 && legs.every((l) => l.percent > 0 && l.units !== null),
    Fee: feeBps !== null,
    Review: manager.data === true,
    Sign: true,
  };
  const current = STEPS[step] ?? "Profile";
  const firstInvalid = STEPS.findIndex((s) => !valid[s]);

  function go(next: number) {
    setStep(next);
    setReached((r) => Math.max(r, next));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function toggle(asset: ShelfAsset) {
    setDraft((d) => {
      const has = d.tokens.includes(asset.token);
      const nextTokens = has ? d.tokens.filter((t) => t !== asset.token) : [...d.tokens, asset.token].slice(0, MAX_COMPONENTS);
      const even = evenPercents(nextTokens.length);
      return { ...d, tokens: nextTokens, percents: Object.fromEntries(nextTokens.map((t, i) => [t, String(even[i] ?? 0)])) };
    });
  }

  function evenSplit() {
    const even = evenPercents(draft.tokens.length);
    update({ percents: Object.fromEntries(draft.tokens.map((t, i) => [t, String(even[i] ?? 0)])) });
  }

  async function submit() {
    if (!address || legs.some((l) => l.units === null)) return;
    setCreate({ state: "working", message: "Confirm the new fund in your wallet…" });
    try {
      const result = await createFund(address, {
        name: draft.name.trim(),
        symbol: draft.symbol,
        compliance,
        components: legs.map((l) => ({ token: l.asset.token, initialUnits: l.units ?? 0n })),
      });
      setCreatedId(result.fundId);
      if (fullCode) saveSetupDraft(result.fundId, plan);
      setCreate({ state: "done", message: `${draft.symbol} is deployed.`, url: result.url });
    } catch (err) {
      setCreate({ state: "failed", message: explain(err) });
    }
  }

  // The new fund takes a ledger or two to show in the platform's registry.
  useEffect(() => {
    if (!createdId || created) return;
    let cancelled = false;
    let tries = 0;
    const poll = async () => {
      const fund = await findFund(createdId, true).catch(() => null);
      if (cancelled) return;
      if (fund) setCreated(fund);
      else if (++tries < 8) setTimeout(poll, 2500);
    };
    poll();
    return () => {
      cancelled = true;
    };
  }, [createdId, created]);

  useEffect(() => {
    if (created && !created.setup) navigate(`/fund/${created.id}`);
  }, [created, navigate]);

  function finish() {
    if (!createdId) return;
    clearSetupDraft(createdId);
    navigate(`/fund/${createdId}`);
  }

  const setup = created ? setupSteps(created, plan) : [];
  const signatures = 1 + (fullCode ? setupCallCount(plan) : 0);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <p className="text-filing text-muted-foreground">Managers</p>
      <h1 className="mt-1 font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] font-semibold">
        Forge a <span className="text-primary">fund.</span>
      </h1>
      <p className="mt-3 max-w-[40rem] text-muted-foreground">
        Name it, choose how it may change, pick assets from the platform's shelf and weight them by value. The fund deploys as
        its own Soroban contract, priced by oracle NAV and redeemable in kind from the first share.
      </p>

      {address && <UnfinishedFunds address={address} />}
      <StepRail current={step} reached={Math.min(reached, firstInvalid === -1 ? STEPS.length - 1 : firstInvalid)} onPick={go} />

      <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_380px]">
        <section className="panel min-w-0 rounded-2xl p-5 sm:p-6" aria-labelledby="step-title">
          <h2 id="step-title" className="font-display text-[1.375rem] font-semibold">
            {
              {
                Profile: "Name and profile",
                Mandate: "How the fund may change",
                Basket: "Pick the assets",
                Weights: "Weight them by value",
                Fee: "Management fee",
                Review: "Review",
                Sign: "Sign and launch",
              }[current]
            }
          </h2>

          <div className="mt-5 space-y-5">
            {current === "Profile" && (
              <>
                <div className="grid gap-5 sm:grid-cols-[1fr_180px]">
                  <Labeled label="Fund name">
                    <input value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder="Alloy Cash Plus" maxLength={48} className={field} />
                  </Labeled>
                  <Labeled label="Symbol">
                    <input
                      value={draft.symbol}
                      onChange={(e) => update({ symbol: e.target.value.trim() })}
                      aria-invalid={draft.symbol !== "" && !SYMBOL_PATTERN.test(draft.symbol)}
                      className={`num ${field}`}
                    />
                  </Labeled>
                </div>
                {fullCode ? (
                  <>
                    <Labeled label="Description" hint={<ByteCount value={draft.metadata.description} />}>
                      <textarea
                        value={draft.metadata.description}
                        onChange={(e) => setMeta("description", e.target.value)}
                        rows={3}
                        placeholder="What the fund holds and who it's for."
                        aria-invalid={bytes(draft.metadata.description) > MAX_METADATA_BYTES}
                        className={`${field} resize-y`}
                      />
                    </Labeled>
                    <Labeled label="Strategy" hint={<ByteCount value={draft.metadata.strategy} />}>
                      <textarea
                        value={draft.metadata.strategy}
                        onChange={(e) => setMeta("strategy", e.target.value)}
                        rows={2}
                        placeholder="How you weight and rebalance it."
                        aria-invalid={bytes(draft.metadata.strategy) > MAX_METADATA_BYTES}
                        className={`${field} resize-y`}
                      />
                    </Labeled>
                    <Labeled label="Website" hint={<span className="text-[0.75rem] text-muted-foreground">optional</span>}>
                      <input
                        value={draft.metadata.website}
                        onChange={(e) => setMeta("website", e.target.value.trim())}
                        placeholder="https://"
                        inputMode="url"
                        aria-invalid={draft.metadata.website !== "" && !WEBSITE_PATTERN.test(draft.metadata.website)}
                        className={field}
                      />
                    </Labeled>
                    <p className="text-[0.8125rem] text-muted-foreground">The profile is stored on the fund contract. You can edit it later from the Manage tab.</p>
                  </>
                ) : (
                  <V3Note>This platform deploys v0.3 funds, which have no onchain profile. Description, strategy and website arrive with the v0.4 platform.</V3Note>
                )}
                <fieldset>
                  <legend className="text-label">Who can invest</legend>
                  <div className="mt-2 grid grid-cols-2 gap-2 rounded-full border p-1">
                    {(["Open", "Allowlist"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        disabled={needsAllowlist && option === "Open"}
                        onClick={() => update({ access: option })}
                        aria-pressed={compliance === option}
                        className={`rounded-full py-2 text-label disabled:opacity-40 ${compliance === option ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        {option === "Open" ? "Anyone" : "Approved investors"}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-[0.8125rem] text-muted-foreground">
                    {needsAllowlist
                      ? "A permissioned asset is in the basket, so the fund admits approved investors only."
                      : "You can switch this later from the Manage tab."}
                  </p>
                </fieldset>
              </>
            )}

            {current === "Mandate" && (
              <>
                {!fullCode && <V3Note>This platform deploys v0.3 funds, which are always Locked. The choice arrives with the v0.4 platform.</V3Note>}
                <div className="grid gap-3" role="radiogroup" aria-label="Mandate">
                  {(Object.keys(MANDATES) as Mandate[]).map((m) => {
                    const chosen = (fullCode ? draft.mandate : "Locked") === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        role="radio"
                        aria-checked={chosen}
                        disabled={!fullCode}
                        onClick={() => update({ mandate: m })}
                        className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed ${chosen ? "border-primary bg-accent/50" : "hover:bg-secondary/60"} ${!fullCode && !chosen ? "opacity-50" : ""}`}
                      >
                        <span className={`mt-1 grid size-4 shrink-0 place-items-center rounded-full border ${chosen ? "border-primary" : ""}`} aria-hidden>
                          {chosen && <span className="size-2 rounded-full bg-primary" />}
                        </span>
                        <span>
                          <span className="font-medium">{MANDATES[m].label}</span>
                          <span className="text-muted-foreground">: {MANDATES[m].summary.toLowerCase()}</span>
                          <span className="mt-1 block text-[0.875rem] text-muted-foreground">{MANDATES[m].detail}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[0.8125rem] text-muted-foreground">
                  The mandate is fixed before the fund opens, so every investor knows which one they bought. Redemption works the same under all three.
                </p>
              </>
            )}

            {current === "Basket" && (
              <>
                <p className="text-[0.875rem] text-muted-foreground">
                  Assets the platform admin has approved. Up to {MAX_COMPONENTS}; you weight them in the next step.
                </p>
                <div className="divide-y rounded-xl border">
                  {!shelf.data
                    ? Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton m-4 h-10" />)
                    : shelf.data.map((asset, i) => {
                        const selected = draft.tokens.includes(asset.token);
                        return (
                          <button
                            key={asset.token}
                            type="button"
                            onClick={() => toggle(asset)}
                            aria-pressed={selected}
                            className="flex w-full items-center gap-4 p-4 text-left hover:bg-secondary/40"
                          >
                            <span
                              className={`grid size-6 shrink-0 place-items-center rounded-md border text-[0.75rem] ${selected ? "border-primary bg-primary text-primary-foreground" : ""}`}
                              aria-hidden
                            >
                              {selected && "✓"}
                            </span>
                            <AssetDot code={asset.code} index={i} />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2 font-medium">
                                {assetName(asset.code)}
                                {asset.status === "Permissioned" && (
                                  <span className="chip px-1.5 py-0.5 text-[0.6875rem] font-normal text-muted-foreground">permissioned</span>
                                )}
                              </span>
                              <span className="block text-[0.8125rem]">
                                <IssuerName leg={asset} />
                              </span>
                            </span>
                            <span className="num text-[0.875rem] text-muted-foreground">
                              {asset.priceUsdc !== null ? `$${formatUsd(asset.priceUsdc)}` : "unpriced"}
                            </span>
                          </button>
                        );
                      })}
                </div>
              </>
            )}

            {current === "Weights" && (
              <>
                <div>
                  <span className="text-label">Price of one share at launch</span>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="relative">
                      <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">$</span>
                      <input
                        inputMode="decimal"
                        value={draft.launchNav}
                        onChange={(e) => update({ launchNav: e.target.value.replace(",", ".") })}
                        aria-invalid={!navValid}
                        aria-label="Launch price per share in USD"
                        className={`num w-28 pl-7 ${fieldBase}`}
                      />
                    </span>
                    {NAV_PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => update({ launchNav: String(p) })}
                        aria-pressed={Number(draft.launchNav) === p}
                        className={`chip px-3 py-1.5 text-label ${Number(draft.launchNav) === p ? "border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        ${p}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="rounded-xl border">
                  <div className="hidden grid-cols-[1fr_6rem_6rem_7.5rem] gap-3 border-b px-4 py-2.5 text-[0.8125rem] text-muted-foreground sm:grid">
                    <span>Asset</span>
                    <span className="text-right">Price</span>
                    <span className="text-right">Weight</span>
                    <span className="text-right">Per share</span>
                  </div>
                  <ul className="divide-y">
                    {legs.map((l, i) => (
                      <li key={l.asset.token} className="grid grid-cols-[1fr_6rem] items-center gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[1fr_6rem_6rem_7.5rem]">
                        <span className="flex min-w-0 items-center gap-2.5">
                          <AssetDot code={l.asset.code} index={i} />
                          <span className="font-medium">{assetName(l.asset.code)}</span>
                        </span>
                        <span className="num row-start-2 text-[0.8125rem] text-muted-foreground sm:row-start-auto sm:text-right sm:text-[0.9375rem] sm:text-foreground">
                          {l.priceUsd !== null ? `$${formatUsd(l.priceUsd)}` : "unpriced"}
                          {l.basis && <span className="ml-1 font-sans text-[0.6875rem] text-muted-foreground sm:block">{l.basis}</span>}
                        </span>
                        <span className="relative col-start-2 row-span-2 row-start-1 sm:col-start-auto sm:row-span-1 sm:row-start-auto">
                          <input
                            inputMode="decimal"
                            value={draft.percents[l.asset.token] ?? ""}
                            onChange={(e) => update({ percents: { ...draft.percents, [l.asset.token]: e.target.value.replace(",", ".") } })}
                            aria-label={`${l.asset.code} weight in percent`}
                            aria-invalid={!(l.percent > 0)}
                            className={`num w-full pr-7 text-right ${fieldBase} py-2`}
                          />
                          <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground">%</span>
                        </span>
                        <span className="num col-span-2 text-[0.8125rem] text-muted-foreground sm:col-span-1 sm:text-right sm:text-[0.9375rem] sm:text-foreground">
                          {l.units !== null ? formatAmount(l.units, 7) : "?"}
                          <span className="sm:hidden"> {l.asset.code} per share</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-surface-sunken/60 px-4 py-3">
                    <button type="button" onClick={evenSplit} className="text-label text-primary hover:underline">
                      Split evenly
                    </button>
                    <span className={`num text-[0.9375rem] ${total === 100 ? "text-muted-foreground" : "text-destructive"}`}>
                      {total}% of 100%
                    </span>
                  </div>
                </div>
                <p className="text-[0.8125rem] text-muted-foreground">
                  Units come from oracle prices where the NAV contract has a fresh one, else the Stellar DEX. The fund stores units, not
                  weights: after launch, weights drift with prices until you rebalance.
                </p>
                {legs.some((l) => l.priceUsd === null) && (
                  <p className="text-[0.875rem] text-destructive">
                    {legs.filter((l) => l.priceUsd === null).map((l) => l.asset.code).join(", ")} has no price right now, so its units can't be set by
                    value.
                  </p>
                )}
              </>
            )}

            {current === "Fee" && (
              <>
                {!fullCode && <V3Note>This platform deploys v0.3 funds, which charge no fee. Fees arrive with the v0.4 platform.</V3Note>}
                <div className={fullCode ? "" : "pointer-events-none opacity-50"}>
                  <span className="text-label">Annual fee</span>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="relative">
                      <input
                        inputMode="decimal"
                        value={draft.fee}
                        onChange={(e) => update({ fee: e.target.value.replace(",", ".") })}
                        aria-invalid={feeBps === null}
                        aria-label="Annual fee in percent"
                        className={`num w-24 pr-7 text-right ${fieldBase}`}
                      />
                      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground">%</span>
                    </span>
                    {FEE_PRESETS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => update({ fee: p })}
                        aria-pressed={draft.fee === p}
                        className={`chip px-3 py-1.5 text-label ${draft.fee === p ? "border-primary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        {p}%
                      </button>
                    ))}
                  </div>
                  {feeBps === null && <p className="mt-1 text-[0.8125rem] text-destructive">Enter 0 to 5, with up to two decimals.</p>}
                </div>
                <div className="space-y-3 rounded-xl border bg-surface-sunken/60 p-4 text-[0.9375rem]">
                  <p>
                    The fee is paid in new fund shares, minted to you second by second. Nothing is sold and no asset leaves the fund; each
                    holder's slice of it gets a little smaller instead.
                  </p>
                  {feeBps !== null && feeBps > 0 && (
                    <p>
                      At <span className="num">{formatBps(feeBps)}</span> a year, someone holding 1% of the fund today holds{" "}
                      <span className="num">{(stakeAfter(feeBps, 1)).toFixed(4).replace(/0+$/, "")}%</span> of it a year later, and you
                      hold the difference. On $100,000 in the fund that is about <span className="num">${formatUsd((100_000 * feeBps) / 10_000)}</span> a year.
                    </p>
                  )}
                  <p className="text-muted-foreground">
                    Frozen forever once the fund opens. The contract caps it at 5%. The platform may take up to half of it; it can never raise
                    it.
                  </p>
                </div>
              </>
            )}

            {current === "Review" && (
              <>
                <dl className="divide-y rounded-xl border">
                  <ReviewRow term="Fund" onEdit={() => go(0)}>
                    {draft.name.trim()} <span className="text-filing text-muted-foreground">{draft.symbol}</span>
                    <span className="block text-[0.875rem] text-muted-foreground">{compliance === "Open" ? "Open to anyone" : "Approved investors only"}</span>
                  </ReviewRow>
                  {fullCode && (plan.metadata.description || plan.metadata.strategy || plan.metadata.website) && (
                    <ReviewRow term="Profile" onEdit={() => go(0)}>
                      {plan.metadata.description && <span className="block">{plan.metadata.description}</span>}
                      {plan.metadata.strategy && <span className="block text-[0.875rem] text-muted-foreground">{plan.metadata.strategy}</span>}
                      {plan.metadata.website && <span className="block text-[0.875rem] text-primary">{plan.metadata.website}</span>}
                    </ReviewRow>
                  )}
                  <ReviewRow term="Mandate" onEdit={() => go(1)}>
                    {MANDATES[plan.mandate].label}
                    <span className="block text-[0.875rem] text-muted-foreground">{MANDATES[plan.mandate].summary}</span>
                  </ReviewRow>
                  <ReviewRow term="One share holds" onEdit={() => go(3)}>
                    <ul className="space-y-0.5">
                      {legs.map((l) => (
                        <li key={l.asset.token} className="flex justify-between gap-4">
                          <span>{assetName(l.asset.code)}</span>
                          <span className="num text-muted-foreground">
                            {l.units !== null ? formatAmount(l.units, 7) : "?"} · {l.percent}%
                          </span>
                        </li>
                      ))}
                    </ul>
                  </ReviewRow>
                  <ReviewRow term="Fee" onEdit={() => go(4)}>
                    {plan.feeBps > 0 ? `${formatBps(plan.feeBps)} a year, frozen once open` : "None"}
                  </ReviewRow>
                </dl>
                <p className="text-[0.875rem] text-muted-foreground">
                  {signatures === 1
                    ? "One signature: deploy the fund."
                    : `${signatures} signatures: one deploys the fund, then ${signatures - 1} short ones save the profile, fee and mandate and open it for investment. Stellar runs one contract call per transaction. If you stop partway, the Manage tab picks up where you left off.`}
                </p>
                {manager.data === false && address && (
                  <p className="rounded-md bg-warning-surface px-3 py-2.5 text-[0.875rem]">
                    Only approved managers can create funds. {shortId(address)} isn't on the platform's manager list.
                  </p>
                )}
              </>
            )}

            {current === "Sign" && (
              <>
                <div className="space-y-3">
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-[0.75rem] ${create.state === "done" ? "bg-success text-primary-foreground" : "bg-secondary"}`}
                      aria-hidden
                    >
                      {create.state === "done" ? <span className="check-draw">✓</span> : "1"}
                    </span>
                    <div className="min-w-0 flex-1 space-y-2">
                      <p>Deploy {draft.symbol}</p>
                      {create.state !== "done" && (
                        <Button className="w-full" onClick={submit} busy={create.state === "working"}>
                          Create {draft.symbol} on Stellar
                        </Button>
                      )}
                      <TxNotice phase={create} />
                    </div>
                  </div>
                </div>
                {createdId && fullCode && (
                  <div className="border-t pt-5">
                    <p className="mb-3 text-label">Then set it up</p>
                    {created ? (
                      setup.length ? (
                        <SetupChecklist steps={setup} onFinished={finish} actionLabel="Sign the setup steps" />
                      ) : (
                        <Button onClick={finish}>Go to the fund</Button>
                      )
                    ) : (
                      <p className="text-[0.875rem] text-muted-foreground">Waiting for the fund to appear in the platform's registry…</p>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {current !== "Sign" && (
            <div className="mt-8 flex items-center justify-between gap-3 border-t pt-5">
              <Button variant="ghost" onClick={() => go(step - 1)} disabled={step === 0}>
                <ArrowLeft className="size-4" />
                Back
              </Button>
              {!address && current === "Review" ? (
                <Button onClick={connect} busy={connecting}>
                  Connect wallet to create
                </Button>
              ) : (
                <Button onClick={() => go(step + 1)} disabled={!valid[current]} busy={current === "Review" && manager.loading}>
                  {current === "Review" ? "Continue to sign" : "Continue"}
                </Button>
              )}
            </div>
          )}
        </section>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="panel space-y-5 rounded-2xl p-5 shadow-overlay sm:p-6">
            <div>
              <div className="font-display text-[1.25rem] font-semibold">{draft.name.trim() || "Your fund"}</div>
              <div className="text-filing text-muted-foreground">{draft.symbol || "symbol"}</div>
            </div>
            <div>
              <div className="text-filing text-muted-foreground">NAV per share at launch</div>
              <Usd value={navValid ? Number(draft.launchNav) : null} className="text-figure-xl" />
            </div>
            {legs.length > 0 && (
              <div>
                <div className="flex h-2 overflow-hidden rounded-full bg-secondary">
                  {legs.map((l, i) => (
                    <span key={l.asset.token} style={{ width: `${total > 0 ? (l.percent / total) * 100 : 100 / legs.length}%`, background: strandColor(i) }} />
                  ))}
                </div>
                <ul className="mt-3 space-y-1.5 text-[0.9375rem]">
                  {legs.map((l) => (
                    <li key={l.asset.token} className="flex justify-between gap-3">
                      <span>{assetName(l.asset.code)}</span>
                      <span className="num text-muted-foreground">{l.percent || 0}%</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <dl className="grid grid-cols-2 gap-3 border-t pt-4 text-[0.875rem]">
              <div>
                <dt className="text-muted-foreground">Mandate</dt>
                <dd>{MANDATES[plan.mandate].label}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Annual fee</dt>
                <dd className="num">{feeBps === null ? "?" : formatBps(plan.feeBps)}</dd>
              </div>
            </dl>
            <p className="text-[0.8125rem] text-muted-foreground">
              You become the fund's manager. You can never pause redemptions. <Link to="/built" className="underline-offset-4 hover:underline">How it works</Link>
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function ReviewRow({ term, onEdit, children }: { term: string; onEdit: () => void; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3.5 sm:grid-cols-[9rem_1fr_auto] sm:gap-4">
      <dt className="text-[0.8125rem] text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
      <button type="button" onClick={onEdit} className="justify-self-start text-label text-primary hover:underline sm:justify-self-end">
        Edit
      </button>
    </div>
  );
}

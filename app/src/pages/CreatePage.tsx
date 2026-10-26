import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { formatAmount, formatUsd, shortId, toUnits, unitsToNumber } from "../lib/format";
import { createFund, explain, isManager, loadShelf, type Compliance, type ShelfAsset } from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";
import { AssetDot, IssuerName, strandColor } from "../components/fund-bits";
import { Button, TxNotice, Usd, type TxPhase } from "../components/ui";

const SYMBOL_PATTERN = /^[A-Za-z0-9]{1,12}$/;

interface Leg {
  asset: ShelfAsset;
  input: string;
  units: bigint | null;
  valueUsd: number | null;
}

export function CreatePage() {
  const { address, connect, connecting } = useWallet();
  const navigate = useNavigate();
  const shelf = useAsync(loadShelf, "shelf");
  const manager = useAsync(() => isManager(address ?? ""), address ? `manager:${address}` : null);

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("a");
  const [access, setAccess] = useState<Compliance>("Open");
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });

  const legs: Leg[] = useMemo(
    () =>
      (shelf.data ?? [])
        .filter((asset) => (amounts[asset.token] ?? "") !== "")
        .map((asset) => {
          const input = amounts[asset.token] ?? "";
          const units = toUnits(input);
          const valueUsd = units !== null && asset.priceUsdc !== null ? unitsToNumber(units) * asset.priceUsdc : null;
          return { asset, input, units, valueUsd };
        }),
    [shelf.data, amounts],
  );

  const needsAllowlist = legs.some((l) => l.asset.status === "Permissioned");
  const compliance: Compliance = needsAllowlist ? "Allowlist" : access;
  const priced = legs.length > 0 && legs.every((l) => l.valueUsd !== null);
  const navPreview = priced ? legs.reduce((sum, l) => sum + (l.valueUsd ?? 0), 0) : null;
  const legsValid = legs.length > 0 && legs.every((l) => l.units !== null && l.units > 0n);
  const symbolValid = SYMBOL_PATTERN.test(symbol);
  const ready = name.trim().length > 0 && symbolValid && legsValid && manager.data === true;

  function toggle(asset: ShelfAsset) {
    setAmounts((prev) => {
      const next = { ...prev };
      if (asset.token in next && next[asset.token] !== "") delete next[asset.token];
      else next[asset.token] = asset.code === "XLM" ? "1" : "0.5";
      return next;
    });
  }

  async function submit() {
    if (!address || !ready) return;
    setPhase({ state: "working", message: "Confirm the new fund in your wallet…" });
    try {
      const result = await createFund(address, {
        name: name.trim(),
        symbol,
        compliance,
        components: legs.map((l) => ({ token: l.asset.token, initialUnits: l.units ?? 0n })),
      });
      setPhase({ state: "done", message: `${symbol} is live on Stellar.`, url: result.url });
      setTimeout(() => navigate(`/fund/${result.fundId}`), 1600);
    } catch (err) {
      setPhase({ state: "failed", message: explain(err) });
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-14">
      <p className="text-filing text-muted-foreground">Managers</p>
      <h1 className="mt-1 font-display text-[clamp(2rem,5vw,3rem)] leading-[1.05] font-semibold">
        Forge a <span className="text-primary">fund.</span>
      </h1>
      <p className="mt-3 max-w-[40rem] text-muted-foreground">
        Pick assets from the platform's shelf and set what one share holds. The fund deploys as its own Soroban contract,
        priced by oracle NAV and redeemable in kind from the first share.
      </p>

      <div className="mt-10 grid gap-8 lg:grid-cols-[1fr_380px]">
        <div className="space-y-8">
          <section className="panel space-y-5 rounded-2xl p-5 sm:p-6">
            <div className="grid gap-5 sm:grid-cols-[1fr_180px]">
              <label className="block">
                <span className="text-label">Fund name</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Alloy Cash Plus"
                  maxLength={48}
                  className="mt-2 w-full rounded-md border bg-surface-sunken px-3 py-2.5 outline-none focus:border-ring"
                />
              </label>
              <label className="block">
                <span className="text-label">Symbol</span>
                <input
                  value={symbol}
                  onChange={(e) => setSymbol(e.target.value.trim())}
                  aria-invalid={symbol !== "" && !symbolValid}
                  className="num mt-2 w-full rounded-md border bg-surface-sunken px-3 py-2.5 outline-none focus:border-ring aria-[invalid=true]:border-destructive"
                />
              </label>
            </div>
            <fieldset>
              <legend className="text-label">Who can invest</legend>
              <div className="mt-2 grid grid-cols-2 gap-2 rounded-full border p-1">
                {(["Open", "Allowlist"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    disabled={needsAllowlist && option === "Open"}
                    onClick={() => setAccess(option)}
                    aria-pressed={compliance === option}
                    className={`rounded-full py-2 text-label disabled:opacity-40 ${compliance === option ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {option === "Open" ? "Anyone" : "Approved investors"}
                  </button>
                ))}
              </div>
              {needsAllowlist && (
                <p className="mt-2 text-[0.8125rem] text-muted-foreground">
                  A permissioned asset is in the mix, so the fund admits approved investors only.
                </p>
              )}
            </fieldset>
          </section>

          <section>
            <p className="text-filing text-muted-foreground">The shelf</p>
            <h2 className="mt-1 font-display text-[1.375rem] font-semibold">What one share holds</h2>
            <div className="panel mt-4 divide-y rounded-2xl">
              {!shelf.data
                ? Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton m-4 h-10" />)
                : shelf.data.map((asset, i) => {
                    const selected = (amounts[asset.token] ?? "") !== "";
                    const units = toUnits(amounts[asset.token] ?? "");
                    return (
                      <div key={asset.token} className="flex flex-wrap items-center gap-4 p-4">
                        <button
                          type="button"
                          onClick={() => toggle(asset)}
                          aria-pressed={selected}
                          className={`grid size-6 place-items-center rounded-md border text-[0.75rem] ${selected ? "border-primary bg-primary text-primary-foreground" : ""}`}
                          aria-label={`${selected ? "Remove" : "Add"} ${asset.code}`}
                        >
                          {selected && "✓"}
                        </button>
                        <AssetDot code={asset.code} index={i} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 font-medium">
                            {asset.code === "XLM" ? "Lumens" : asset.code}
                            {asset.status === "Permissioned" && (
                              <span className="chip px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">permissioned</span>
                            )}
                          </div>
                          <div className="text-[0.8125rem] text-muted-foreground">
                            <IssuerName leg={asset} />
                            {asset.priceUsdc !== null && <span className="num"> · ${formatUsd(asset.priceUsdc)}</span>}
                          </div>
                        </div>
                        {selected && (
                          <label className="flex items-center gap-2">
                            <input
                              inputMode="decimal"
                              value={amounts[asset.token]}
                              onChange={(e) => setAmounts((prev) => ({ ...prev, [asset.token]: e.target.value.replace(",", ".") }))}
                              aria-invalid={units === null || units <= 0n}
                              aria-label={`${asset.code} per share`}
                              className="num w-28 rounded-md border bg-surface-sunken px-3 py-2 text-right outline-none focus:border-ring aria-[invalid=true]:border-destructive"
                            />
                            <span className="w-16 text-[0.8125rem] text-muted-foreground">per share</span>
                          </label>
                        )}
                      </div>
                    );
                  })}
            </div>
          </section>
        </div>

        <aside className="lg:sticky lg:top-24 lg:self-start">
          <div className="panel space-y-5 rounded-2xl p-5 shadow-overlay sm:p-6">
            <div>
              <div className="font-display text-[1.25rem] font-semibold">{name.trim() || "Your fund"}</div>
              <div className="text-filing text-muted-foreground">{symbol || "symbol"}</div>
            </div>
            <div>
              <div className="text-filing text-muted-foreground">NAV per share at launch</div>
              {legs.length === 0 ? (
                <span className="text-figure-lg text-muted-foreground">$0.00</span>
              ) : (
                <Usd value={navPreview} className="text-figure-xl" />
              )}
            </div>
            {legs.length > 0 && (
              <div>
                <div className="flex h-2 overflow-hidden rounded-full bg-secondary">
                  {legs.map((l, i) => (
                    <span
                      key={l.asset.token}
                      style={{ width: `${navPreview && l.valueUsd ? (l.valueUsd / navPreview) * 100 : 100 / legs.length}%`, background: strandColor(i) }}
                    />
                  ))}
                </div>
                <ul className="mt-3 space-y-1.5 text-[0.9375rem]">
                  {legs.map((l) => (
                    <li key={l.asset.token} className="flex justify-between gap-3">
                      <span>{l.asset.code === "XLM" ? "Lumens" : l.asset.code}</span>
                      <span className="num text-muted-foreground">
                        {l.units ? formatAmount(l.units) : "?"}
                        {navPreview && l.valueUsd !== null && ` · ${Math.round((l.valueUsd / navPreview) * 100)}%`}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {!address ? (
              <Button className="w-full" onClick={connect} busy={connecting}>
                Connect wallet to create
              </Button>
            ) : manager.data === false ? (
              <p className="rounded-md bg-warning-surface px-3 py-2.5 text-[0.875rem]">
                Only approved managers can create funds. {shortId(address)} isn't on the platform's manager list.
              </p>
            ) : (
              <Button className="w-full" onClick={submit} disabled={!ready} busy={phase.state === "working" || manager.data === undefined}>
                Create {symbol || "fund"} on Stellar
              </Button>
            )}
            <TxNotice phase={phase} />
            <p className="text-[0.8125rem] text-muted-foreground">
              You become the fund's manager: you can switch who may invest and approve investors from the fund page. You
              can never pause redemptions. <Link to="/built" className="underline-offset-4 hover:underline">How it works</Link>
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

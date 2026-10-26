import { useMemo, useState, type ReactNode } from "react";
import { StrKey } from "@stellar/stellar-sdk";
import { AssetDot, IssuerName } from "../components/fund-bits";
import { Button, CopyId, TxNotice, type TxPhase } from "../components/ui";
import {
  adminCall,
  cancelOperation,
  describeOperation,
  executeOperation,
  explainAdmin,
  isManagerOn,
  loadControls,
  loadFundAdmin,
  loadQueue,
  loadRoutes,
  roleOf,
  setManagerCall,
  setNavCall,
  setPlatformFeeCall,
  setRouterCall,
  setShelfCall,
  type AdminCall,
  type AdminRole,
  type NavRoutes,
  type PlatformControl,
  type QueuedOperation,
} from "../lib/admin";
import { deployments, expert, oracleFor, SOROSWAP_ROUTER } from "../lib/config";
import { formatBps } from "../lib/fee-math";
import { formatAge, shortId } from "../lib/format";
import { explain, listFunds, loadShelf, type Fund, type ShelfStatus } from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { useWallet } from "../lib/wallet";

type Section = "managers" | "shelf" | "routes" | "funds" | "queue";

const control = "rounded-md border bg-surface-sunken px-3 py-2.5 text-[0.875rem] outline-none focus:border-ring aria-[invalid=true]:border-destructive";
const input = `w-full ${control}`;
const isAddress = (s: string) => StrKey.isValidEd25519PublicKey(s) || StrKey.isValidContract(s);
const STATUSES: ShelfStatus[] = ["Open", "Permissioned", "Unlisted"];
const ASSET_NAMES: Record<string, string> = Object.fromEntries(Object.entries(deployments?.assets ?? {}).map(([code, a]) => [a.contract, code]));
const toStatus = (value: string): ShelfStatus => STATUSES.find((s) => s === value) ?? "Unlisted";

function formatDelay(seconds: number): string {
  if (seconds < 120) return `${seconds} seconds`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}

/** Sends one admin call, directly or scheduled on the timelock, and reports where it landed. */
function useAdminAction(role: AdminRole, onDone: () => void) {
  const { address } = useWallet();
  const [phase, setPhase] = useState<TxPhase>({ state: "idle" });
  const canAct = Boolean(address && (role.isAdmin || role.isProposer));
  async function run(call: AdminCall, done: string) {
    if (!address || !canAct) return;
    const timelock = role.control.timelock;
    setPhase({ state: "working", message: timelock ? "Confirm scheduling in your wallet…" : "Confirm in your wallet…" });
    try {
      const result = await adminCall(role.control, address, call);
      setPhase({
        state: "done",
        message: result.scheduled ? `Scheduled: ${done.toLowerCase()} Runs after the ${formatDelay(timelock?.delaySeconds ?? 0)} delay, from the queue.` : done,
        url: result.url,
      });
      onDone();
    } catch (err) {
      setPhase({ state: "failed", message: explainAdmin(err, timelock ? "timelock" : call.kind) ?? explain(err) });
    }
  }
  return { phase, run, canAct, busy: phase.state === "working" };
}

function Panel({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel rounded-2xl p-5 sm:p-6">
      <h2 className="text-heading">{title}</h2>
      {note && <p className="mt-1 max-w-[44rem] text-[0.875rem] text-muted-foreground">{note}</p>}
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Managers({ role, funds }: { role: AdminRole; funds: Fund[] }) {
  const platform = role.control.slot.id;
  const [version, setVersion] = useState(0);
  const known = useMemo(() => [...new Set(funds.map((f) => f.manager))], [funds]);
  const status = useAsync(() => isManagerOn(platform, known), `managers:${platform}:${known.join(",")}`, version);
  const [address, setAddress] = useState("");
  const action = useAdminAction(role, () => setVersion((v) => v + 1));
  const valid = isAddress(address);

  return (
    <Panel title="Managers" note="Only approved managers can create funds on this platform. Removing one stops new funds; their existing funds keep running.">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="G… address" aria-label="Manager address" aria-invalid={address !== "" && !valid} className={`num ${input}`} />
        <div className="flex gap-2">
          <Button onClick={() => action.run(setManagerCall(platform, address, true), "Manager approved.")} disabled={!valid || !action.canAct} busy={action.busy}>
            Approve
          </Button>
          <Button variant="secondary" onClick={() => action.run(setManagerCall(platform, address, false), "Manager removed.")} disabled={!valid || !action.canAct || action.busy}>
            Remove
          </Button>
        </div>
      </div>
      <div className="mt-3">
        <TxNotice phase={action.phase} />
      </div>
      {known.length > 0 && (
        <ul className="mt-5 divide-y rounded-xl border">
          {known.map((m) => {
            const count = funds.filter((f) => f.manager === m).length;
            const approved = status.data?.get(m);
            return (
              <li key={m} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <CopyId id={m} kind={m.startsWith("C") ? "contract" : "account"} />
                <span className="flex items-center gap-3 text-[0.8125rem] text-muted-foreground">
                  <span>
                    <span className="num">{count}</span> {count === 1 ? "fund" : "funds"}
                  </span>
                  {approved === undefined ? (
                    <span className="skeleton w-16">approved</span>
                  ) : (
                    <span className={`chip px-2 py-0.5 ${approved ? "text-foreground" : "text-muted-foreground"}`}>{approved ? "approved" : "removed"}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

function Shelf({ role }: { role: AdminRole }) {
  const platform = role.control.slot.id;
  const [version, setVersion] = useState(0);
  const shelf = useAsync(() => loadShelf(platform, true), `shelf:${platform}`, version);
  const [edits, setEdits] = useState<Record<string, ShelfStatus>>({});
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<ShelfStatus>("Open");
  const action = useAdminAction(role, () => setVersion((v) => v + 1));

  return (
    <Panel
      title="Asset shelf"
      note="Assets managers may put in a fund. Permissioned assets force the fund's investor allowlist on. Delisting stops new funds from adding an asset; funds that hold it keep redeeming it."
    >
      <ul className="divide-y rounded-xl border">
        {!shelf.data
          ? [0, 1, 2].map((i) => <li key={i} className="skeleton m-4 block h-8" />)
          : shelf.data.map((asset, i) => {
              const wanted = edits[asset.token] ?? asset.status;
              return (
                <li key={asset.token} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <AssetDot code={asset.code} index={i} />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{asset.code === "XLM" ? "Lumens" : asset.code}</span>
                    <IssuerName leg={asset} />
                  </span>
                  <select
                    value={wanted}
                    onChange={(e) => setEdits((s) => ({ ...s, [asset.token]: toStatus(e.target.value) }))}
                    aria-label={`${asset.code} shelf status`}
                    className={`${control} py-2`}
                  >
                    {STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="secondary"
                    disabled={wanted === asset.status || !action.canAct}
                    busy={action.busy}
                    onClick={() => action.run(setShelfCall(platform, asset.token, wanted), `${asset.code} is ${wanted.toLowerCase()} on the shelf.`)}
                  >
                    Apply
                  </Button>
                </li>
              );
            })}
      </ul>
      <div className="mt-5 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <input value={token} onChange={(e) => setToken(e.target.value.trim())} placeholder="Asset contract, C…" aria-label="Asset contract to list" aria-invalid={token !== "" && !StrKey.isValidContract(token)} className={`num ${input}`} />
        <select value={status} onChange={(e) => setStatus(toStatus(e.target.value))} aria-label="Status for the new asset" className={control}>
          {STATUSES.slice(0, 2).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <Button onClick={() => action.run(setShelfCall(platform, token, status), "Asset listed.")} disabled={!StrKey.isValidContract(token) || !action.canAct} busy={action.busy}>
          List asset
        </Button>
      </div>
      <p className="mt-2 text-[0.8125rem] text-muted-foreground">
        Use the asset's Stellar Asset Contract. Pinned issuers are the only safe source: lookalike assets are common.
      </p>
      <div className="mt-3">
        <TxNotice phase={action.phase} />
      </div>
    </Panel>
  );
}

function RouteCell({ route }: { route: NavRoutes["primary"] }) {
  if (!route) return <span className="text-muted-foreground">none</span>;
  const known = oracleFor(route.source);
  return (
    <span className="block">
      <span className="font-medium">{known?.label ?? route.source}</span>
      <span className="block text-[0.8125rem] text-muted-foreground">
        {route.feed.tag === "Sep40" ? "SEP-40 feed" : "RedStone feed"}, quoted in {route.quote.tag === "Usd" ? "USD" : "USDC"}, stale after{" "}
        {formatAge(Number(route.max_age_secs)).replace(" ago", "")}
      </span>
      <a href={expert.contract(route.oracle)} target="_blank" rel="noreferrer" className="num text-[0.75rem] text-muted-foreground hover:text-primary">
        {shortId(route.oracle, 6, 6)}
      </a>
    </span>
  );
}

function Routes({ control }: { control: PlatformControl }) {
  const navId = control.slot.nav;
  const shelf = useAsync(() => loadShelf(control.slot.id, true), `shelf:${control.slot.id}`);
  const tokens = shelf.data?.map((a) => a.token) ?? [];
  const routes = useAsync(() => (navId ? loadRoutes(navId, tokens) : Promise.resolve([])), navId && tokens.length ? `routes:${navId}:${tokens.join(",")}` : null);
  const byToken = new Map((routes.data ?? []).map((r) => [r.token, r]));

  if (!navId) return <Panel title="Oracle routes"><p className="text-muted-foreground">This platform has no NAV contract configured.</p></Panel>;
  return (
    <Panel
      title="Oracle routes"
      note={
        <>
          How the NAV contract prices each shelf asset: a primary oracle, and a secondary it falls back to and checks for divergence. Read
          only here; routes change through the NAV contract's own admin. NAV contract <CopyId id={navId} head={4} tail={4} />
        </>
      }
    >
      <div className="overflow-hidden rounded-xl border">
        <div className="hidden grid-cols-[9rem_1fr_1fr] gap-4 border-b px-4 py-2.5 text-[0.8125rem] text-muted-foreground md:grid">
          <span>Asset</span>
          <span>Primary</span>
          <span>Secondary</span>
        </div>
        <ul className="divide-y">
          {(shelf.data ?? []).map((asset, i) => {
            const r = byToken.get(asset.token);
            return (
              <li key={asset.token} className="grid gap-3 px-4 py-3.5 md:grid-cols-[9rem_1fr_1fr] md:gap-4">
                <span className="flex items-center gap-2.5 font-medium">
                  <AssetDot code={asset.code} index={i} />
                  {asset.code === "XLM" ? "Lumens" : asset.code}
                </span>
                {r ? (
                  <>
                    <div>
                      <span className="text-[0.75rem] text-muted-foreground md:hidden">Primary</span>
                      <RouteCell route={r.primary} />
                    </div>
                    <div>
                      <span className="text-[0.75rem] text-muted-foreground md:hidden">Secondary</span>
                      <RouteCell route={r.secondary} />
                    </div>
                  </>
                ) : (
                  <span className="skeleton h-10 md:col-span-2" />
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Panel>
  );
}

function FundRow({ fund, role }: { fund: Fund; role: AdminRole }) {
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState(0);
  const state = useAsync(() => loadFundAdmin(fund.id, fund.setup !== null), open ? `fund-admin:${fund.id}` : null, version);
  const action = useAdminAction(role, () => setVersion((v) => v + 1));
  const [nav, setNav] = useState(role.control.slot.nav ?? "");
  const [router, setRouter] = useState(SOROSWAP_ROUTER ?? "");
  const [share, setShare] = useState(String((fund.setup?.platformFee?.shareBps ?? 0) / 100));
  const [recipient, setRecipient] = useState(fund.setup?.platformFee?.recipient ?? "");
  const shareBps = /^\d+(\.\d{0,2})?$/.test(share) ? Math.round(Number(share) * 100) : null;
  const shareValid = shareBps !== null && shareBps <= 5_000;

  return (
    <li>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3.5 text-left hover:bg-secondary/40">
        <span className="min-w-0 flex-1">
          <span className="font-medium">{fund.name}</span> <span className="text-filing text-muted-foreground">{fund.symbol}</span>
        </span>
        <span className="text-[0.8125rem] text-muted-foreground">
          {fund.setup ? "v0.4" : "before v0.4"}
          {fund.setup?.platformFee ? `, platform takes ${formatBps(fund.setup.platformFee.shareBps)} of the fee` : ""}
        </span>
        <span className="text-label text-primary">{open ? "Close" : "Configure"}</span>
      </button>
      {open && (
        <div className="space-y-4 border-t bg-surface-sunken/40 px-4 py-4 text-[0.875rem]">
          <dl className="grid gap-2 sm:grid-cols-2">
            <div>
              <dt className="text-[0.8125rem] text-muted-foreground">Oracle bounding trades</dt>
              <dd>
                {!state.data ? (
                  <span className="skeleton w-24">loading</span>
                ) : !state.data.hasNav ? (
                  <span className="text-muted-foreground">This fund's code predates rebalancing and takes no oracle.</span>
                ) : state.data.nav ? (
                  <CopyId id={state.data.nav} head={4} tail={4} />
                ) : (
                  "none"
                )}
              </dd>
            </div>
            {fund.setup && (
              <div>
                <dt className="text-[0.8125rem] text-muted-foreground">Swap router</dt>
                <dd>{state.data ? state.data.router ? <CopyId id={state.data.router} head={4} tail={4} /> : "none" : <span className="skeleton w-24">loading</span>}</dd>
              </div>
            )}
          </dl>
          {state.data?.hasNav && (
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <input value={nav} onChange={(e) => setNav(e.target.value.trim())} aria-label="NAV contract" placeholder="NAV contract, C…" className={`num ${input}`} />
              <Button variant="secondary" disabled={!StrKey.isValidContract(nav) || !action.canAct} busy={action.busy} onClick={() => action.run(setNavCall(fund.id, nav), "Oracle set.")}>
                Set oracle
              </Button>
            </div>
          )}
          {fund.setup && (
            <>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <input value={router} onChange={(e) => setRouter(e.target.value.trim())} aria-label="Swap router" placeholder="Router, C…" className={`num ${input}`} />
                <Button variant="secondary" disabled={!StrKey.isValidContract(router) || !action.canAct} busy={action.busy} onClick={() => action.run(setRouterCall(fund.id, router), "Router set.")}>
                  Set router
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-[7rem_1fr_auto]">
                <span className="relative">
                  <input value={share} onChange={(e) => setShare(e.target.value.replace(",", "."))} aria-label="Platform share of the fee, percent" aria-invalid={!shareValid} className={`num pr-7 text-right ${input}`} />
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground">%</span>
                </span>
                <input value={recipient} onChange={(e) => setRecipient(e.target.value.trim())} aria-label="Platform fee recipient" placeholder="Recipient, G…" className={`num ${input}`} />
                <Button
                  variant="secondary"
                  disabled={!shareValid || !isAddress(recipient) || !action.canAct}
                  busy={action.busy}
                  onClick={() => action.run(setPlatformFeeCall(fund.id, shareBps ?? 0, recipient), "Platform fee set.")}
                >
                  Set platform fee
                </Button>
              </div>
              <p className="text-[0.8125rem] text-muted-foreground">
                The platform's share splits the manager's fee, up to half of it; it never raises what holders pay. An allowlist fund needs the
                recipient approved as an investor first.
              </p>
            </>
          )}
          <TxNotice phase={action.phase} />
        </div>
      )}
    </li>
  );
}

function Funds({ role, funds }: { role: AdminRole; funds: Fund[] }) {
  return (
    <Panel
      title="Funds"
      note="Set the oracle that bounds each fund's trades, the router it swaps through, and the platform's cut of its fee. Managers can't change these; only the platform admin can."
    >
      {funds.length ? (
        <ul className="divide-y rounded-xl border">
          {funds.map((f) => (
            <FundRow key={f.id} fund={f} role={role} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">No funds on this platform yet.</p>
      )}
    </Panel>
  );
}

const STATUS_STYLE: Record<QueuedOperation["status"], string> = {
  waiting: "text-muted-foreground",
  ready: "border-success/50 text-success",
  done: "text-muted-foreground",
  cancelled: "text-muted-foreground line-through",
};

function Queue({ role }: { role: AdminRole }) {
  const { address } = useWallet();
  const timelock = role.control.timelock;
  const [version, setVersion] = useState(0);
  const queue = useAsync(() => (timelock ? loadQueue(timelock.id) : Promise.resolve([])), timelock ? `queue:${timelock.id}` : null, version);
  const [phases, setPhases] = useState<Record<string, TxPhase>>({});
  if (!timelock) return null;

  async function act(op: QueuedOperation, kind: "execute" | "cancel") {
    if (!address || !timelock) return;
    setPhases((p) => ({ ...p, [op.id]: { state: "working", message: "Confirm in your wallet…" } }));
    try {
      const result = kind === "execute" ? await executeOperation(timelock.id, address, op) : await cancelOperation(timelock.id, address, op);
      setPhases((p) => ({ ...p, [op.id]: { state: "done", message: kind === "execute" ? "Executed." : "Cancelled.", url: result.url } }));
      setVersion((v) => v + 1);
    } catch (err) {
      setPhases((p) => ({ ...p, [op.id]: { state: "failed", message: explainAdmin(err, "timelock") ?? explain(err) } }));
    }
  }

  const now = Date.now() / 1000;
  return (
    <Panel
      title="Timelock queue"
      note={`Every admin change waits ${formatDelay(timelock.delaySeconds)} after it's scheduled, so anyone watching can react before it lands. Shows operations scheduled within the RPC's event history, about a week.`}
    >
      {queue.error != null && !queue.data ? (
        <p className="text-muted-foreground">Couldn't read the timelock's events. {explain(queue.error)}</p>
      ) : !queue.data ? (
        <div className="skeleton h-24 w-full rounded-xl" />
      ) : queue.data.length === 0 ? (
        <p className="text-muted-foreground">Nothing scheduled in the last week.</p>
      ) : (
        <ul className="divide-y rounded-xl border">
          {queue.data.map((op) => (
            <li key={op.id} className="space-y-2 px-4 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium">{describeOperation(op, ASSET_NAMES)}</p>
                  <p className="text-[0.8125rem] text-muted-foreground">
                    on <a href={expert.contract(op.target)} target="_blank" rel="noreferrer" className="num hover:text-primary">{shortId(op.target, 4, 4)}</a>, proposed by{" "}
                    <span className="num">{shortId(op.proposer, 4, 4)}</span>,{" "}
                    <a href={expert.tx(op.txHash)} target="_blank" rel="noreferrer" className="hover:text-primary">
                      scheduled
                    </a>
                  </p>
                </div>
                <span className={`chip shrink-0 px-2 py-0.5 text-[0.75rem] ${STATUS_STYLE[op.status]}`}>
                  {op.status === "waiting" ? `ready in ${formatAge(op.readyAt - now).replace(" ago", "").replace("just now", "a minute")}` : op.status}
                </span>
              </div>
              {(op.status === "ready" || op.status === "waiting") && (
                <div className="flex flex-wrap gap-2">
                  {op.status === "ready" && (
                    <Button onClick={() => act(op, "execute")} disabled={!role.isExecutor} busy={phases[op.id]?.state === "working"} title={role.isExecutor ? undefined : "Only executors can run it"}>
                      Execute
                    </Button>
                  )}
                  <Button variant="secondary" onClick={() => act(op, "cancel")} disabled={!role.isProposer || phases[op.id]?.state === "working"}>
                    Cancel
                  </Button>
                </div>
              )}
              <TxNotice phase={phases[op.id] ?? { state: "idle" }} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function ControlSummary({ role }: { role: AdminRole }) {
  const { control } = role;
  const roles = [role.isAdmin && "admin", role.isProposer && "proposer", role.isExecutor && "executor"].filter(Boolean).join(", ");
  return (
    <div className="panel grid gap-5 rounded-2xl p-5 sm:grid-cols-3 sm:p-6">
      <div>
        <div className="text-filing text-muted-foreground">Platform</div>
        <div className="mt-1.5">
          <CopyId id={control.slot.id} head={4} tail={4} />
        </div>
      </div>
      <div>
        <div className="text-filing text-muted-foreground">Admin</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <CopyId id={control.admin} kind={control.admin.startsWith("C") ? "contract" : "account"} head={4} tail={4} />
          {control.timelock && <span className="text-[0.8125rem] text-muted-foreground">timelock, {formatDelay(control.timelock.delaySeconds)} delay</span>}
        </div>
      </div>
      <div>
        <div className="text-filing text-muted-foreground">You</div>
        <div className="mt-1.5">{roles ? <span className="chip px-2 py-0.5 text-[0.8125rem]">{roles}</span> : <span className="text-muted-foreground">read only</span>}</div>
      </div>
      {control.timelock && (
        <p className="text-[0.8125rem] text-muted-foreground sm:col-span-3">
          Changes made here are scheduled on the timelock and take effect when an executor runs them after the delay. Proposers{" "}
          <span className="num">{control.timelock.proposers.length}</span>, executors <span className="num">{control.timelock.executors.length}</span>.
        </p>
      )}
    </div>
  );
}

export function AdminPage() {
  const { address, connect, connecting } = useWallet();
  const controls = useAsync(loadControls, deployments ? "controls" : null);
  const funds = useAsync(() => listFunds(), deployments ? "funds" : null);
  const [platformIndex, setPlatformIndex] = useState(0);
  const [section, setSection] = useState<Section>("managers");
  const control = controls.data?.[platformIndex];
  const role = control ? roleOf(control, address ?? "") : null;
  const platformFunds = (funds.data ?? []).filter((f) => f.platform === control?.slot.id);
  const sections: { id: Section; label: string }[] = [
    { id: "managers", label: "Managers" },
    { id: "shelf", label: "Shelf" },
    { id: "routes", label: "Oracle routes" },
    { id: "funds", label: "Funds" },
    ...(control?.timelock ? [{ id: "queue" as const, label: "Queue" }] : []),
  ];

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6 lg:py-14">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-display text-[clamp(1.75rem,4.5vw,2.5rem)] leading-[1.08] font-semibold">Platform admin</h1>
          <p className="mt-2 max-w-[40rem] text-muted-foreground">
            Who may create funds, which assets they may hold, and the oracle, router and fee split each fund runs on. Nothing here can pause
            a redemption.
          </p>
        </div>
        {(controls.data?.length ?? 0) > 1 && (
          <div className="grid grid-cols-2 gap-1 rounded-full border p-1" role="tablist" aria-label="Platform">
            {controls.data?.map((c, i) => (
              <button
                key={c.slot.id}
                type="button"
                role="tab"
                aria-selected={i === platformIndex}
                onClick={() => setPlatformIndex(i)}
                className={`rounded-full px-4 py-1.5 text-label ${i === platformIndex ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {i === 0 ? "Original" : "v0.4"}
              </button>
            ))}
          </div>
        )}
      </div>

      {!address && (
        <div className="mt-6 flex flex-wrap items-center gap-3 rounded-2xl border p-4 text-[0.875rem]">
          <span className="text-muted-foreground">Connect the admin wallet or a timelock proposer to make changes.</span>
          <Button onClick={connect} busy={connecting}>
            Connect wallet
          </Button>
        </div>
      )}

      <div className="mt-8 space-y-6">
        {controls.error != null && !controls.data ? (
          <p className="text-muted-foreground">Couldn't read the platform. {explain(controls.error)}</p>
        ) : !role ? (
          <div className="skeleton h-28 w-full rounded-2xl" />
        ) : (
          <>
            <ControlSummary role={role} />
            <div className="flex gap-1 overflow-x-auto border-b" role="tablist" aria-label="Admin sections">
              {sections.map((s) => (
                <button
                  key={s.id}
                  role="tab"
                  type="button"
                  aria-selected={section === s.id}
                  onClick={() => setSection(s.id)}
                  className={`-mb-px shrink-0 border-b-2 px-3 py-2.5 text-label ${section === s.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                >
                  {s.label}
                </button>
              ))}
            </div>
            {section === "managers" && <Managers role={role} funds={platformFunds} />}
            {section === "shelf" && <Shelf role={role} />}
            {section === "routes" && <Routes control={role.control} />}
            {section === "funds" && <Funds role={role} funds={platformFunds} />}
            {section === "queue" && <Queue role={role} />}
          </>
        )}
      </div>
    </div>
  );
}

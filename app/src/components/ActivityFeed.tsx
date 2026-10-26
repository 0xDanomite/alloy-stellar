import { useState, type ReactNode } from "react";
import { loadActivity, type ActivityEvent, type ActivityPage } from "../lib/activity";
import { expert } from "../lib/config";
import { formatAge, formatAmount, shortId } from "../lib/format";
import { explain, type Fund } from "../lib/stellar";
import { useAsync } from "../lib/use-async";
import { Button } from "./ui";

const pageCache = new Map<string, { at: number; page: Promise<ActivityPage> }>();
const CACHE_MS = 60_000;

function firstPage(fundId: string): Promise<ActivityPage> {
  const hit = pageCache.get(fundId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.page;
  const page = loadActivity(fundId);
  pageCache.set(fundId, { at: Date.now(), page });
  page.catch(() => pageCache.delete(fundId));
  return page;
}

function Who({ id }: { id: unknown }) {
  if (typeof id !== "string") return <span>someone</span>;
  const href = id.startsWith("C") ? expert.contract(id) : expert.account(id);
  return (
    <a href={href} target="_blank" rel="noreferrer" className="num text-[0.8125rem] hover:text-primary" title={id}>
      {shortId(id)}
    </a>
  );
}

const big = (v: unknown): bigint => (typeof v === "bigint" ? v : 0n);
const field = (data: unknown, key: string): unknown =>
  typeof data === "object" && data !== null && key in data ? Reflect.get(data, key) : undefined;

const TONE: Record<string, string> = {
  issue: "var(--chart-2)",
  mint: "var(--chart-2)",
  redeem: "var(--chart-5)",
  burn: "var(--chart-5)",
  rebalance: "var(--chart-1)",
  transfer: "var(--chart-4)",
};

function describe(event: ActivityEvent, fund: Fund): { title: string; detail: ReactNode } {
  const code = (token: unknown) => fund.components.find((c) => c.token === token)?.code ?? "an asset";
  const [a, b] = event.topics;
  const shares = (n: bigint) => `${formatAmount(n)} ${n === 10_000_000n ? "share" : "shares"}`;
  switch (event.kind) {
    case "issue": {
      const amounts = (field(event.data, "amounts") as bigint[] | undefined) ?? [];
      const basket = amounts.map((amt, i) => `${formatAmount(amt)} ${fund.components[i]?.code ?? ""}`).join(", ");
      return {
        title: `Issued ${shares(big(field(event.data, "shares")))}`,
        detail: <>to <Who id={b ?? a} />{basket && <span className="block text-muted-foreground">deposited {basket}</span>}</>,
      };
    }
    case "redeem": {
      const amounts = (field(event.data, "amounts") as bigint[] | undefined) ?? [];
      const basket = amounts
        .map((amt, i) => (amt > 0n ? `${formatAmount(amt)} ${fund.components[i]?.code ?? ""}` : null))
        .filter(Boolean)
        .join(", ");
      return {
        title: `Redeemed ${shares(big(field(event.data, "shares")))}`,
        detail: <>by <Who id={a} />{basket && <span className="block text-muted-foreground">paid out {basket}</span>}</>,
      };
    }
    case "mint":
      return { title: `Minted ${shares(big(event.data))}`, detail: <>to <Who id={a} /></> };
    case "burn":
      return { title: `Burned ${shares(big(event.data))}`, detail: <>from <Who id={a} /></> };
    case "transfer":
      return { title: `Transferred ${shares(big(event.data))}`, detail: <><Who id={a} /> to <Who id={b} /></> };
    case "rebalance":
      return {
        title: "Rebalanced",
        detail: (
          <>
            sold {formatAmount(big(field(event.data, "sold")))} {code(field(event.data, "sell"))} for{" "}
            {formatAmount(big(field(event.data, "bought")))} {code(field(event.data, "buy"))}
          </>
        ),
      };
    case "investor_set":
      return {
        title: field(event.data, "allowed") === true ? "Investor approved" : "Investor removed",
        detail: <Who id={a} />,
      };
    case "compliance_set": {
      const tag = Array.isArray(event.data) ? String(event.data[0]) : String(event.data);
      return { title: "Compliance changed", detail: tag === "Allowlist" ? "now approved investors only" : "now open to anyone" };
    }
    case "manager_set":
      return { title: "Manager changed", detail: <>to <Who id={b} /></> };
    case "withdraw_owed":
      return {
        title: `Withdrew owed ${code(b)}`,
        detail: <>{formatAmount(big(field(event.data, "amount")))} {code(b)} by <Who id={a} /></>,
      };
    case "leftover_credited":
      return { title: `Credited leftover ${code(b)}`, detail: <>{formatAmount(big(field(event.data, "amount")))} to the manager</> };
    case "nav_set":
      return { title: "Rebalance oracle set", detail: <Who id={event.data} /> };
  }
}

function Row({ event, fund }: { event: ActivityEvent; fund: Fund }) {
  const { title, detail } = describe(event, fund);
  const age = Math.max(0, (Date.now() - event.at.getTime()) / 1000);
  return (
    <li className="grid grid-cols-[auto_1fr_auto] gap-x-3 px-5 py-3.5">
      <span className="mt-1.5 size-2 rounded-full" style={{ background: TONE[event.kind] ?? "var(--muted-foreground)" }} aria-hidden />
      <div className="min-w-0 text-[0.875rem]">
        <div className="font-medium">{title}</div>
        <div className="text-[0.8125rem] text-muted-foreground">{detail}</div>
      </div>
      <div className="text-right text-[0.75rem] text-muted-foreground">
        <time dateTime={event.at.toISOString()} title={event.at.toLocaleString()}>{formatAge(age)}</time>
        <a href={expert.tx(event.txHash)} target="_blank" rel="noreferrer" className="num mt-0.5 block hover:text-primary">
          {event.txHash.slice(0, 8)}
        </a>
      </div>
    </li>
  );
}

export function ActivityFeed({ fund }: { fund: Fund }) {
  const first = useAsync(() => firstPage(fund.id), fund.id);
  const [more, setMore] = useState<ActivityEvent[]>([]);
  const [before, setBefore] = useState<number | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);

  const page = first.data;
  const events = page ? [...page.events, ...more] : [];
  const cursor = before === undefined ? page?.before ?? null : before;

  const loadOlder = async () => {
    if (cursor === null) return;
    setLoadingMore(true);
    setMoreError(null);
    try {
      const next = await loadActivity(fund.id, { before: cursor, maxWindows: 2 });
      setMore((m) => [...m, ...next.events]);
      setBefore(next.before);
    } catch (err) {
      setMoreError(explain(err));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="panel overflow-hidden rounded-2xl">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-5 py-3">
        <span className="text-[0.8125rem] text-muted-foreground">
          The fund contract's own events, read from Stellar RPC
        </span>
        {page && (
          <span className="text-[0.75rem] text-muted-foreground">
            RPC keeps the last ~7 days, back to {page.oldestAt.toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        )}
      </div>
      {first.loading && !page ? (
        <ul className="divide-y" aria-hidden>
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-3 px-5 py-4">
              <span className="skeleton size-2 rounded-full" />
              <span className="skeleton h-4 w-48" />
              <span className="skeleton ml-auto h-3 w-12" />
            </li>
          ))}
        </ul>
      ) : first.error != null ? (
        <div className="px-5 py-6 text-[0.875rem]">
          <p className="text-muted-foreground">Couldn't read events from the network. {explain(first.error)}</p>
          <button type="button" onClick={first.reload} className="mt-2 text-primary underline-offset-4 hover:underline">
            Try again
          </button>
        </div>
      ) : (
        <>
          {events.length ? (
            <ul className="divide-y">
              {events.map((e) => (
                <Row key={e.id} event={e} fund={fund} />
              ))}
            </ul>
          ) : (
            <p className="px-5 py-6 text-[0.875rem] text-muted-foreground">
              {cursor === null ? "No activity in the RPC's retention window." : "Nothing in the last 40 hours or so."}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3">
            {cursor !== null ? (
              <Button variant="secondary" onClick={loadOlder} busy={loadingMore} className="min-h-9">
                Load earlier activity
              </Button>
            ) : (
              <span className="text-[0.8125rem] text-muted-foreground">That's everything the RPC still holds.</span>
            )}
            {moreError && <span className="text-[0.8125rem] text-destructive">{moreError}</span>}
          </div>
        </>
      )}
    </div>
  );
}

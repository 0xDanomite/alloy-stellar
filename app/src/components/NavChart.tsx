import { useId, useMemo, useState, type PointerEvent } from "react";
import { fundSeries, hasHistory, loadHistories, RANGES, type AssetHistory, type Range } from "../lib/history";
import { chartGeometry, rangeReturn, type ValuePoint } from "../lib/series";
import type { Fund } from "../lib/stellar";
import { useAsync } from "../lib/use-async";

const WIDTH = 640;
const HEIGHT = 168;

/** Modeled moves are often fractions of a cent, so the chart reads to four places. */
const fourPlaces = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });

const RANGE_LABEL: Record<Range, string> = { "1D": "1 day", "1W": "1 week", "1M": "1 month", "3M": "3 months" };

export function formatPct(value: number, digits = 2): string {
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value * 100).toFixed(digits)}%`;
}

export function changeTone(value: number | null): string {
  if (value === null || Math.abs(value) < 0.00005) return "text-muted-foreground";
  return value > 0 ? "text-success" : "text-destructive";
}

function formatWhen(t: number, range: Range): string {
  const date = new Date(t * 1000);
  return range === "1D" || range === "1W"
    ? date.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function sourceNote(fund: Fund, histories: Map<string, AssetHistory>, range: Range): string {
  const bySource = (source: AssetHistory["source"]) =>
    fund.components.filter((leg) => histories.get(leg.token)?.source === source).map((leg) => leg.code);
  const reflector = bySource("reflector");
  const sdex = bySource("sdex");
  const held = bySource("none");
  const parts = [];
  if (reflector.length) parts.push(`${reflector.join(", ")} from Reflector's 5-minute oracle rounds`);
  if (sdex.length) {
    const step = RANGES[range].sdexResolutionMs >= 86_400_000 ? "daily" : RANGES[range].sdexResolutionMs >= 3_600_000 ? "hourly" : "15-minute";
    parts.push(`${sdex.join(", ")} from ${step} Stellar DEX closes, median of three`);
  }
  let note = parts.length ? `Prices in USDC: ${parts.join("; ")}.` : "";
  if (held.length) note += ` ${held.join(", ")} ${held.length > 1 ? "have" : "has"} no price history here and ${held.length > 1 ? "are" : "is"} held at today's price.`;
  return note.trim();
}

function Plot({ series, range }: { series: ValuePoint[]; range: Range }) {
  const gradient = useId();
  const [hover, setHover] = useState<number | null>(null);
  const geometry = useMemo(() => chartGeometry(series, WIDTH, HEIGHT), [series]);
  if (!geometry) return null;
  const point = hover === null ? null : series[hover];
  const last = series[series.length - 1] as ValuePoint;
  const first = series[0] as ValuePoint;
  const up = last.value >= first.value;
  const low = Math.min(...series.map((p) => p.value));
  const high = Math.max(...series.map((p) => p.value));

  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const t = first.t + ratio * (last.t - first.t);
    let nearest = 0;
    for (let i = 1; i < series.length; i++) {
      if (Math.abs((series[i] as ValuePoint).t - t) < Math.abs((series[nearest] as ValuePoint).t - t)) nearest = i;
    }
    setHover(nearest);
  };

  const pctX = (t: number) => `${(geometry.x(t) / WIDTH) * 100}%`;
  const pctY = (v: number) => `${(geometry.y(v) / HEIGHT) * 100}%`;
  const stroke = up ? "var(--primary)" : "var(--destructive)";

  return (
    <div>
      <div
        className="relative h-40 touch-none sm:h-44"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Modeled value of one share over ${RANGE_LABEL[range]}, from $${fourPlaces(first.value)} to $${fourPlaces(last.value)}`}
      >
        <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible" aria-hidden>
          <defs>
            <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" style={{ stopColor: stroke, stopOpacity: 0.22 }} />
              <stop offset="100%" style={{ stopColor: stroke, stopOpacity: 0 }} />
            </linearGradient>
          </defs>
          <line x1="0" x2={WIDTH} y1={geometry.y(first.value)} y2={geometry.y(first.value)} stroke="var(--border)" strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          <path d={geometry.area} fill={`url(#${gradient})`} />
          <path d={geometry.line} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {point && (
            <line x1={geometry.x(point.t)} x2={geometry.x(point.t)} y1="0" y2={HEIGHT} stroke="var(--muted-foreground)" strokeOpacity="0.45" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        <span
          className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-4 ring-background"
          style={{ left: pctX((point ?? last).t), top: pctY((point ?? last).value), background: stroke }}
          aria-hidden
        />
        {point && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 -translate-y-[calc(100%+6px)] rounded-md border bg-card px-2 py-1 text-[0.75rem] whitespace-nowrap shadow-overlay"
            style={{ left: `clamp(4.5rem, ${pctX(point.t)}, calc(100% - 4.5rem))` }}
          >
            <span className="num">${fourPlaces(point.value)}</span>
            <span className="ml-2 text-muted-foreground">{formatWhen(point.t, range)}</span>
          </div>
        )}
      </div>
      <div className="mt-2 flex justify-between gap-3 text-[0.75rem] text-muted-foreground">
        <span>{formatWhen(first.t, range)}</span>
        <span className="num">
          low ${fourPlaces(low)}, high ${fourPlaces(high)}
        </span>
        <span>now</span>
      </div>
    </div>
  );
}

export function NavChart({ fund }: { fund: Fund }) {
  const [range, setRange] = useState<Range>("1D");
  const histories = useAsync(() => loadHistories(fund.components, range), `${fund.id}:${range}`);
  const data = histories.data;
  const series = useMemo(() => (data && hasHistory(fund, data) ? fundSeries(fund, data, range) : []), [data, fund, range]);
  const change = rangeReturn(series);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-[0.8125rem] text-muted-foreground">{RANGE_LABEL[range]}</span>
          {histories.loading && !data ? (
            <span className="skeleton w-14">0</span>
          ) : (
            change !== null && <span className={`num text-[0.9375rem] ${changeTone(change)}`}>{formatPct(change)}</span>
          )}
        </div>
        <div className="flex rounded-full border bg-surface-sunken/60 p-0.5" role="group" aria-label="Chart range">
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={`num min-h-8 rounded-full px-3 text-[0.75rem] ${range === r ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {histories.loading && !data ? (
          <div className="skeleton h-40 w-full sm:h-44" />
        ) : series.length >= 2 ? (
          <Plot series={series} range={range} />
        ) : (
          <div className="grid h-40 place-items-center rounded-lg border border-dashed text-center text-[0.875rem] text-muted-foreground sm:h-44">
            <p className="max-w-[28rem] px-4">
              {histories.error != null
                ? "Couldn't read price history right now."
                : `None of this fund's assets has price history over ${RANGE_LABEL[range]}.`}
            </p>
          </div>
        )}
      </div>

      <p className="mt-3 text-[0.8125rem] leading-snug text-muted-foreground">
        Modeled from current holdings and oracle price history: today's units per share, valued at each moment's prices.
        {data && hasHistory(fund, data) && <> {sourceNote(fund, data, range)}</>}
      </p>
    </div>
  );
}

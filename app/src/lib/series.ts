/** Unix seconds, ascending. */
export interface PricePoint {
  t: number;
  price: number;
}

export interface ValuePoint {
  t: number;
  value: number;
}

/** The last price at or before `t`, or null when history starts later. */
export function priceAt(points: readonly PricePoint[], t: number): number | null {
  let lo = 0;
  let hi = points.length - 1;
  let found: number | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const point = points[mid] as PricePoint;
    if (point.t <= t) {
      found = point.price;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * Replaces each price with the median of it and its neighbours, so a single
 * off-market print on a thin order book doesn't draw a spike. The first and
 * last points use their two nearest neighbours, since a stray print in the
 * newest bucket would otherwise set the range's return.
 */
export function medianOf3(points: readonly PricePoint[]): PricePoint[] {
  if (points.length < 3) return [...points];
  return points.map((p, i) => {
    const from = Math.min(Math.max(i - 1, 0), points.length - 3);
    const sorted = points
      .slice(from, from + 3)
      .map((q) => q.price)
      .sort((a, b) => a - b);
    return { t: p.t, price: sorted[1] as number };
  });
}

/** `steps + 1` evenly spaced times from `from` to `to`, both included. */
export function timeGrid(from: number, to: number, steps: number): number[] {
  if (steps < 1 || to <= from) return [to];
  const step = (to - from) / steps;
  return Array.from({ length: steps + 1 }, (_, i) => Math.round(from + i * step));
}

export interface LegHistory {
  /** Whole units of the asset in one share. */
  units: number;
  points: readonly PricePoint[];
  /** Price to hold the leg at when it has no history at all; null leaves the series unpriced. */
  fallback: number | null;
}

/**
 * What one share would have been worth at each time, holding today's units
 * fixed: the sum of units times each leg's price then. A leg without history
 * is held at its fallback price. Times before every leg has a price are dropped.
 */
export function modelSeries(legs: readonly LegHistory[], grid: readonly number[]): ValuePoint[] {
  const series: ValuePoint[] = [];
  for (const t of grid) {
    let value = 0;
    let priced = true;
    for (const leg of legs) {
      if (leg.units === 0) continue;
      const price = leg.points.length ? priceAt(leg.points, t) : leg.fallback;
      if (price === null) {
        priced = false;
        break;
      }
      value += leg.units * price;
    }
    if (priced) series.push({ t, value });
  }
  return series;
}

/** Fractional change from the first to the last point. */
export function rangeReturn(series: readonly ValuePoint[]): number | null {
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last || series.length < 2 || first.value <= 0) return null;
  return last.value / first.value - 1;
}

/** Fractional change of a price over `window` seconds ending at the latest point. */
export function changeOver(points: readonly PricePoint[], window: number): number | null {
  const last = points[points.length - 1];
  if (!last) return null;
  const then = priceAt(points, last.t - window);
  if (then === null || then <= 0) return null;
  return last.price / then - 1;
}

export interface Arc {
  start: number;
  end: number;
}

/** Turns weights into donut arcs in radians, clockwise from twelve o'clock, with a gap between slices. */
export function donutArcs(weights: readonly number[], gap = 0): Arc[] {
  const total = weights.reduce((sum, w) => sum + Math.max(0, w), 0);
  if (total <= 0) return weights.map(() => ({ start: 0, end: 0 }));
  const slices = weights.filter((w) => w > 0).length;
  const usable = Math.PI * 2 - (slices > 1 ? gap * slices : 0);
  let cursor = 0;
  return weights.map((w) => {
    const size = (Math.max(0, w) / total) * usable;
    const arc = { start: cursor, end: cursor + size };
    if (size > 0) cursor += size + (slices > 1 ? gap : 0);
    return arc;
  });
}

const point = (cx: number, cy: number, r: number, angle: number) =>
  `${(cx + r * Math.sin(angle)).toFixed(3)} ${(cy - r * Math.cos(angle)).toFixed(3)}`;

/** An SVG path for a ring slice between `inner` and `outer` radii. */
export function ringPath(cx: number, cy: number, outer: number, inner: number, arc: Arc): string {
  const sweep = arc.end - arc.start;
  if (sweep <= 0) return "";
  if (sweep >= Math.PI * 2 - 1e-6) {
    return `M ${point(cx, cy, outer, 0)} A ${outer} ${outer} 0 1 1 ${point(cx, cy, outer, Math.PI)} A ${outer} ${outer} 0 1 1 ${point(cx, cy, outer, 0)} M ${point(cx, cy, inner, 0)} A ${inner} ${inner} 0 1 0 ${point(cx, cy, inner, Math.PI)} A ${inner} ${inner} 0 1 0 ${point(cx, cy, inner, 0)} Z`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  return [
    `M ${point(cx, cy, outer, arc.start)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(cx, cy, outer, arc.end)}`,
    `L ${point(cx, cy, inner, arc.end)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(cx, cy, inner, arc.start)}`,
    "Z",
  ].join(" ");
}

export interface ChartGeometry {
  line: string;
  area: string;
  min: number;
  max: number;
  x: (t: number) => number;
  y: (value: number) => number;
}

/** Scales a series into a `width` by `height` box, padding the value range so a flat line sits mid-chart. */
export function chartGeometry(series: readonly ValuePoint[], width: number, height: number): ChartGeometry | null {
  const first = series[0];
  const last = series[series.length - 1];
  if (!first || !last || series.length < 2) return null;
  let min = Math.min(...series.map((p) => p.value));
  let max = Math.max(...series.map((p) => p.value));
  const spread = max - min;
  const pad = spread > 0 ? spread * 0.12 : Math.abs(max) * 0.01 || 1;
  min -= pad;
  max += pad;
  const span = last.t - first.t || 1;
  const x = (t: number) => ((t - first.t) / span) * width;
  const y = (value: number) => height - ((value - min) / (max - min)) * height;
  const line = series.map((p, i) => `${i === 0 ? "M" : "L"} ${x(p.t).toFixed(2)} ${y(p.value).toFixed(2)}`).join(" ");
  const area = `${line} L ${x(last.t).toFixed(2)} ${height} L ${x(first.t).toFixed(2)} ${height} Z`;
  return { line, area, min, max, x, y };
}

/**
 * One asset's price out of a Reflector history record: `mask` has bit `i`
 * set (least significant bit first) when asset `i` was priced, and `prices`
 * lists only the priced assets, in index order.
 */
export function reflectorPrice(mask: Uint8Array, prices: readonly bigint[], index: number): bigint | null {
  const byte = mask[index >> 3];
  if (byte === undefined || (byte & (1 << (index & 7))) === 0) return null;
  let position = 0;
  for (let i = 0; i < index; i++) {
    const b = mask[i >> 3] ?? 0;
    if (b & (1 << (i & 7))) position++;
  }
  return prices[position] ?? null;
}

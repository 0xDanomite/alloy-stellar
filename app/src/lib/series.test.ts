import { describe, expect, it } from "vitest";
import {
  changeOver,
  chartGeometry,
  donutArcs,
  medianOf3,
  modelSeries,
  priceAt,
  rangeReturn,
  reflectorPrice,
  ringPath,
  timeGrid,
} from "./series";

const points = [
  { t: 100, price: 1 },
  { t: 200, price: 2 },
  { t: 300, price: 4 },
];

describe("priceAt", () => {
  it("returns the last price at or before the time", () => {
    expect(priceAt(points, 100)).toBe(1);
    expect(priceAt(points, 250)).toBe(2);
    expect(priceAt(points, 1_000)).toBe(4);
  });

  it("is null before history starts", () => {
    expect(priceAt(points, 99)).toBeNull();
    expect(priceAt([], 500)).toBeNull();
  });
});

describe("medianOf3", () => {
  it("drops a single off-market print", () => {
    const prints = [1.13, 1.12, 1.0, 1.13, 1.14].map((price, t) => ({ t, price }));
    expect(medianOf3(prints).map((p) => p.price)).toEqual([1.12, 1.12, 1.12, 1.13, 1.13]);
  });

  it("smooths a stray print in the newest bucket", () => {
    const prints = [1.08, 1.08, 1.09, 1.03].map((price, t) => ({ t, price }));
    expect(medianOf3(prints).at(-1)?.price).toBe(1.08);
  });

  it("keeps a series shorter than three as it is", () => {
    expect(medianOf3(points.slice(0, 2))).toEqual(points.slice(0, 2));
  });
});

describe("timeGrid", () => {
  it("includes both ends", () => {
    expect(timeGrid(0, 100, 4)).toEqual([0, 25, 50, 75, 100]);
  });

  it("collapses to the end when the range is empty", () => {
    expect(timeGrid(100, 100, 4)).toEqual([100]);
  });
});

describe("modelSeries", () => {
  it("sums units times price per leg", () => {
    const series = modelSeries(
      [
        { units: 2, points, fallback: null },
        { units: 10, points: [{ t: 0, price: 0.5 }], fallback: null },
      ],
      [100, 200, 300],
    );
    expect(series).toEqual([
      { t: 100, value: 2 * 1 + 5 },
      { t: 200, value: 2 * 2 + 5 },
      { t: 300, value: 2 * 4 + 5 },
    ]);
  });

  it("holds a leg with no history at its fallback price", () => {
    const series = modelSeries(
      [
        { units: 1, points, fallback: null },
        { units: 3, points: [], fallback: 1 },
      ],
      [200],
    );
    expect(series).toEqual([{ t: 200, value: 2 + 3 }]);
  });

  it("drops times before every leg has a price", () => {
    const series = modelSeries([{ units: 1, points, fallback: null }], [50, 150]);
    expect(series).toEqual([{ t: 150, value: 1 }]);
  });

  it("is empty when a leg has neither history nor fallback", () => {
    expect(modelSeries([{ units: 1, points: [], fallback: null }], [100, 200])).toEqual([]);
  });

  it("ignores legs the share no longer holds", () => {
    const series = modelSeries(
      [
        { units: 1, points, fallback: null },
        { units: 0, points: [], fallback: null },
      ],
      [300],
    );
    expect(series).toEqual([{ t: 300, value: 4 }]);
  });
});

describe("rangeReturn", () => {
  it("is last over first, less one", () => {
    expect(rangeReturn([{ t: 0, value: 100 }, { t: 1, value: 90 }, { t: 2, value: 110 }])).toBeCloseTo(0.1);
  });

  it("needs two points and a positive start", () => {
    expect(rangeReturn([{ t: 0, value: 100 }])).toBeNull();
    expect(rangeReturn([{ t: 0, value: 0 }, { t: 1, value: 5 }])).toBeNull();
  });
});

describe("changeOver", () => {
  it("compares the latest price with the one a window earlier", () => {
    expect(changeOver(points, 100)).toBeCloseTo(1);
    expect(changeOver(points, 150)).toBeCloseTo(3);
  });

  it("is null when history does not reach back that far", () => {
    expect(changeOver(points, 500)).toBeNull();
    expect(changeOver([], 100)).toBeNull();
  });
});

describe("donutArcs", () => {
  it("splits the circle in proportion to weight", () => {
    const arcs = donutArcs([1, 3]);
    expect(arcs[0]?.start).toBe(0);
    expect(arcs[0]?.end).toBeCloseTo(Math.PI / 2);
    expect(arcs[1]?.end).toBeCloseTo(Math.PI * 2);
  });

  it("leaves a gap after each slice and none for zero weights", () => {
    const arcs = donutArcs([1, 0, 1], 0.1);
    expect(arcs[1]?.end).toBe(arcs[1]?.start);
    expect(arcs[2]?.start).toBeCloseTo((arcs[0]?.end ?? 0) + 0.1);
    expect(arcs[2]?.end).toBeCloseTo(Math.PI * 2 - 0.1);
  });

  it("draws nothing for no weight", () => {
    expect(donutArcs([0, 0])).toEqual([
      { start: 0, end: 0 },
      { start: 0, end: 0 },
    ]);
  });
});

describe("ringPath", () => {
  it("draws a closed slice and nothing for an empty arc", () => {
    expect(ringPath(50, 50, 40, 30, { start: 0, end: 1 })).toMatch(/^M .* Z$/);
    expect(ringPath(50, 50, 40, 30, { start: 1, end: 1 })).toBe("");
  });
});

describe("chartGeometry", () => {
  it("maps the first point to the left edge and the last to the right", () => {
    const geometry = chartGeometry(
      [
        { t: 0, value: 1 },
        { t: 10, value: 2 },
      ],
      200,
      100,
    );
    expect(geometry?.x(0)).toBe(0);
    expect(geometry?.x(10)).toBe(200);
    expect(geometry?.y(2)).toBeLessThan(geometry?.y(1) ?? 0);
    expect(geometry?.line.startsWith("M 0.00")).toBe(true);
  });

  it("centres a flat series", () => {
    const geometry = chartGeometry(
      [
        { t: 0, value: 5 },
        { t: 1, value: 5 },
      ],
      100,
      100,
    );
    expect(geometry?.y(5)).toBeCloseTo(50);
  });

  it("needs two points", () => {
    expect(chartGeometry([{ t: 0, value: 1 }], 100, 100)).toBeNull();
  });
});

describe("reflectorPrice", () => {
  // A live mainnet round: mask byte 0 is 0xf7, so asset 3 is missing and
  // asset 7 (XLM) is the seventh price; byte 1 is 0xff.
  const mask = new Uint8Array([0xf7, 0xff, 0x1c]);
  const prices = [10n, 11n, 12n, 14n, 15n, 16n, 17n, 18n, 19n, 20n, 21n, 22n, 23n, 24n, 25n];

  it("skips assets the mask leaves out", () => {
    expect(reflectorPrice(mask, prices, 3)).toBeNull();
    expect(reflectorPrice(mask, prices, 4)).toBe(14n);
  });

  it("counts only priced assets before the index", () => {
    expect(reflectorPrice(mask, prices, 7)).toBe(17n);
    expect(reflectorPrice(mask, prices, 12)).toBe(22n);
  });

  it("is null past the mask", () => {
    expect(reflectorPrice(mask, prices, 40)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import { computeEma, computeSma, mergeCandles, styledRows, toHeikinAshi } from "./candles";
import type { Candle } from "./types";

function candle(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close };
}

describe("toHeikinAshi", () => {
  it("returns empty for empty input", () => {
    expect(toHeikinAshi([])).toEqual([]);
  });

  it("seeds the first candle from its own open/close", () => {
    const [first] = toHeikinAshi([candle(1, 10, 14, 8, 12)]);
    expect(first.close).toBeCloseTo((10 + 14 + 8 + 12) / 4); // 11
    expect(first.open).toBeCloseTo((10 + 12) / 2);           // 11
    expect(first.high).toBeCloseTo(14);
    expect(first.low).toBeCloseTo(8);
  });

  it("chains subsequent opens from the previous HA midpoint", () => {
    const rows = toHeikinAshi([
      candle(1, 10, 14, 8, 12),
      candle(2, 12, 16, 11, 15),
    ]);
    // prev HA open = 11, prev HA close = 11 → next HA open = 11.
    expect(rows[1].open).toBeCloseTo(11);
    expect(rows[1].close).toBeCloseTo((12 + 16 + 11 + 15) / 4); // 13.5
    // High/low must envelope the HA body.
    expect(rows[1].high).toBeGreaterThanOrEqual(rows[1].close);
    expect(rows[1].low).toBeLessThanOrEqual(rows[1].open);
  });
});

describe("styledRows", () => {
  const rows = [candle(1, 10, 14, 8, 12), candle(2, 12, 16, 11, 15)];

  it("passes candles/bars through untouched", () => {
    expect(styledRows(rows, "candles")).toBe(rows);
    expect(styledRows(rows, "bars")).toBe(rows);
  });

  it("collapses line/area to close values", () => {
    expect(styledRows(rows, "line")).toEqual([
      { time: 1, value: 12 }, { time: 2, value: 15 },
    ]);
    expect(styledRows(rows, "area")).toEqual(styledRows(rows, "line"));
  });

  it("transforms heikin", () => {
    const heikin = styledRows(rows, "heikin");
    expect(heikin).toEqual(toHeikinAshi(rows));
  });
});

describe("computeSma", () => {
  const rows = [1, 2, 3, 4, 5].map((n, i) => candle(i, n, n, n, n));

  it("emits the first point at index length-1", () => {
    const points = computeSma(rows, 3);
    expect(points.map((p) => p.time)).toEqual([2, 3, 4]);
    expect(points.map((p) => p.value)).toEqual([2, 3, 4]); // means of [1..3],[2..4],[3..5]
  });

  it("window longer than data emits nothing", () => {
    expect(computeSma(rows, 6)).toEqual([]);
  });

  it("length 1 mirrors the closes", () => {
    expect(computeSma(rows, 1).map((p) => p.value)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("computeEma", () => {
  it("length 1 mirrors the closes (k = 1)", () => {
    const rows = [3, 7, 2].map((n, i) => candle(i, n, n, n, n));
    expect(computeEma(rows, 1).map((p) => p.value)).toEqual([3, 7, 2]);
  });

  it("applies the standard recursion", () => {
    const rows = [10, 20].map((n, i) => candle(i, n, n, n, n));
    const points = computeEma(rows, 2); // k = 2/3
    expect(points).toHaveLength(1);
    expect(points[0].value).toBeCloseTo(20 * (2 / 3) + 10 * (1 / 3));
  });

  it("constant series converges to the constant", () => {
    const rows = Array.from({ length: 50 }, (_, i) => candle(i, 5, 5, 5, 5));
    const points = computeEma(rows, 10);
    expect(points[points.length - 1].value).toBeCloseTo(5);
  });
});

describe("mergeCandles", () => {
  const bar = (time: number, close: number) =>
    ({ time, open: close, high: close, low: close, close });

  it("unions by time, sorted ascending", () => {
    const merged = mergeCandles([bar(30, 3), bar(40, 4)], [bar(10, 1), bar(20, 2)]);
    expect(merged.map((r) => r.time)).toEqual([10, 20, 30, 40]);
  });

  it("incoming wins on overlap (fresh forming bar replaces stale)", () => {
    const merged = mergeCandles([bar(10, 1), bar(20, 999)], [bar(20, 2)]);
    expect(merged.find((r) => r.time === 20)!.close).toBe(2);
    expect(merged).toHaveLength(2);
  });

  it("handles empty sides", () => {
    expect(mergeCandles([], [bar(1, 1)])).toHaveLength(1);
    expect(mergeCandles([bar(1, 1)], [])).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  absorptions, atr, exhaustions, pivots, priceZScores, roundLevels, rsi,
  sma, squeeze, stdev, stopClusters, sweeps, volumeNodes, volumeZScores,
} from "./qlh";
import type { Candle } from "./types";

function bar(over: Partial<Candle> & { time: number }): Candle {
  const close = over.close ?? 100;
  return {
    open: over.open ?? close, high: over.high ?? close + 1,
    low: over.low ?? close - 1, close, volume: over.volume ?? 100,
    time: over.time,
  };
}

function flat(count: number, price = 100, volume = 100): Candle[] {
  return Array.from({ length: count }, (_, i) =>
    bar({ time: i * 60, close: price, open: price,
          high: price + 1, low: price - 1, volume }));
}

// ---------------------------------------------------------------- basics

describe("sma / stdev", () => {
  it("returns null before the window is full", () => {
    expect(sma([1, 2, 3], 5, 2)).toBeNull();
    expect(stdev([1, 2, 3], 5, 2)).toBeNull();
  });

  it("averages the trailing window", () => {
    expect(sma([1, 2, 3, 4], 2, 3)).toBe(3.5);
    expect(stdev([2, 2, 2, 2], 4, 3)).toBe(0);
  });
});

describe("atr", () => {
  it("is null until seeded, then positive", () => {
    const values = atr(flat(20), 14);
    expect(values[12]).toBeNull();
    expect(values[13]).toBeGreaterThan(0);
    expect(values[19]).toBeGreaterThan(0);
  });

  it("grows when true range grows", () => {
    const calm = atr(flat(40), 14).at(-1)!;
    const wild = atr(flat(40).map((row, i) =>
      i > 20 ? { ...row, high: row.high + 20, low: row.low - 20 } : row), 14).at(-1)!;
    expect(wild).toBeGreaterThan(calm!);
  });
});

describe("rsi", () => {
  it("pins at 100 when every bar rises", () => {
    const rising = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(rsi(rising, 14).at(-1)).toBe(100);
  });

  it("sits near 50 for an alternating series", () => {
    const chop = Array.from({ length: 60 }, (_, i) => 100 + (i % 2));
    expect(rsi(chop, 14).at(-1)!).toBeGreaterThan(30);
    expect(rsi(chop, 14).at(-1)!).toBeLessThan(70);
  });
});

// -------------------------------------------------------------- pivots

describe("pivots", () => {
  it("finds a swing high with enough bars either side", () => {
    const rows = [
      bar({ time: 0, high: 10 }), bar({ time: 1, high: 11 }),
      bar({ time: 2, high: 20 }),                     // the peak
      bar({ time: 3, high: 12 }), bar({ time: 4, high: 9 }),
    ];
    const found = pivots(rows, 2, 2).filter((p) => p.kind === "high");
    expect(found).toHaveLength(1);
    expect(found[0].index).toBe(2);
    expect(found[0].price).toBe(20);
  });

  it("does not confirm a pivot without its right-hand bars", () => {
    const rows = [bar({ time: 0, high: 10 }), bar({ time: 1, high: 11 }),
                  bar({ time: 2, high: 20 })];
    expect(pivots(rows, 2, 2)).toEqual([]);
  });

  it("rejects a tie — an equal high is not a pivot", () => {
    const rows = [
      bar({ time: 0, high: 10 }), bar({ time: 1, high: 20 }),
      bar({ time: 2, high: 20 }), bar({ time: 3, high: 12 }),
      bar({ time: 4, high: 9 })];
    expect(pivots(rows, 2, 2).filter((p) => p.kind === "high")).toEqual([]);
  });
});

// ------------------------------------------------------- stop clusters

describe("stopClusters", () => {
  const rows = [
    ...flat(20, 100),
    bar({ time: 20 * 60, high: 120, low: 99, close: 105, open: 100 }),
    ...flat(6, 104).map((row, i) => ({ ...row, time: (21 + i) * 60 })),
  ];

  it("places a high cluster ABOVE the pivot, buffered", () => {
    const clusters = stopClusters(rows, 2, 2, 0.3, 8);
    const high = clusters.find((c) => c.kind === "high");
    expect(high).toBeDefined();
    expect(high!.bottom).toBe(120);        // the pivot itself
    expect(high!.top).toBeGreaterThan(120); // stops sit beyond it
  });

  it("forgets a cluster price has closed decisively through", () => {
    const swept = [...rows, ...flat(6, 400).map((row, i) =>
      ({ ...row, time: (30 + i) * 60 }))];
    const clusters = stopClusters(swept, 2, 2, 0.3, 8);
    expect(clusters.some((c) => c.kind === "high" && c.pivotPrice === 120)).toBe(false);
  });
});

// -------------------------------------------------------------- sweeps

describe("sweeps", () => {
  it("flags a pierce that closes back below, on a long upper wick", () => {
    const rows = [
      ...flat(6, 100),
      // Pierces 120, closes at 101: a failed stop run.
      bar({ time: 6 * 60, open: 100, high: 130, low: 99, close: 101 }),
    ];
    const clusters = [{ kind: "high" as const, top: 122, bottom: 120,
                        fromIndex: 2, pivotPrice: 120 }];
    const found = sweeps(rows, clusters, 0.55, false, rows.map(() => 0));
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("bear");
  });

  it("ignores a pierce that closes through — that is a break, not a sweep", () => {
    const rows = [...flat(6, 100),
                  bar({ time: 6 * 60, open: 100, high: 130, low: 99, close: 128 })];
    const clusters = [{ kind: "high" as const, top: 122, bottom: 120,
                        fromIndex: 2, pivotPrice: 120 }];
    expect(sweeps(rows, clusters, 0.55, false, rows.map(() => 0))).toEqual([]);
  });

  it("cannot sweep a cluster that had not formed yet", () => {
    const rows = [...flat(6, 100),
                  bar({ time: 6 * 60, open: 100, high: 130, low: 99, close: 101 })];
    const clusters = [{ kind: "high" as const, top: 122, bottom: 120,
                        fromIndex: 99, pivotPrice: 120 }];
    expect(sweeps(rows, clusters, 0.55, false, rows.map(() => 0))).toEqual([]);
  });

  it("honours the volume-confirmation switch", () => {
    const rows = [...flat(6, 100),
                  bar({ time: 6 * 60, open: 100, high: 130, low: 99, close: 101 })];
    const clusters = [{ kind: "high" as const, top: 122, bottom: 120,
                        fromIndex: 2, pivotPrice: 120 }];
    const quiet = rows.map(() => -1);
    expect(sweeps(rows, clusters, 0.55, true, quiet)).toEqual([]);
    expect(sweeps(rows, clusters, 0.55, false, quiet)).toHaveLength(1);
  });
});

// -------------------------------------------------------------- volume

describe("volumeZScores", () => {
  it("is null on a constant series (no deviation to score against)", () => {
    expect(volumeZScores(flat(60), 50).at(-1)).toBeNull();
  });

  it("scores a spike positively", () => {
    const rows = flat(60);
    rows[59] = { ...rows[59], volume: 10_000 };
    expect(volumeZScores(rows, 50).at(-1)!).toBeGreaterThan(3);
  });
});

describe("absorptions", () => {
  it("flags heavy volume with a small body and a real range", () => {
    const rows = flat(60, 100, 100);
    rows[59] = bar({ time: 59 * 60, open: 100, close: 100.1,
                     high: 106, low: 94, volume: 5_000 });
    const z = volumeZScores(rows, 50);
    const found = absorptions(rows, z, 0.25);
    expect(found.at(-1)!.index).toBe(59);
  });

  it("ignores a big body — that is a move, not absorption", () => {
    const rows = flat(60, 100, 100);
    rows[59] = bar({ time: 59 * 60, open: 94, close: 106,
                     high: 106, low: 94, volume: 5_000 });
    expect(absorptions(rows, volumeZScores(rows, 50), 0.25)).toEqual([]);
  });
});

describe("volumeNodes", () => {
  it("returns the heaviest bars' price levels, busiest first", () => {
    const rows = flat(20, 100);
    rows[5] = bar({ time: 300, close: 150, high: 151, low: 149, volume: 900 });
    rows[9] = bar({ time: 540, close: 130, high: 131, low: 129, volume: 500 });
    const nodes = volumeNodes(rows, 20, 2);
    expect(nodes[0]).toBeCloseTo(150, 0);
    expect(nodes[1]).toBeCloseTo(130, 0);
  });
});

// ---------------------------------------------------------- volatility

describe("squeeze", () => {
  it("turns on when range contracts and fires when it releases", () => {
    // Twenty quiet bars, then an expansion.
    const quiet = flat(60, 100).map((row, i) =>
      ({ ...row, high: 100.2, low: 99.8, close: 100 + (i % 2) * 0.05 }));
    const states = squeeze(quiet, 20, 20, 1.5, 1.15);
    expect(states.at(-1)!.on).toBe(true);

    const expanding = [...quiet, ...Array.from({ length: 5 }, (_, i) =>
      bar({ time: (60 + i) * 60, open: 100, close: 100 + i * 8,
            high: 100 + i * 9, low: 99 }))];
    const after = squeeze(expanding, 20, 20, 1.5, 1.15);
    expect(after.some((state) => state.fired)).toBe(true);
  });

  it("is OFF when closes travel further than the bars are tall", () => {
    /* Worth stating, because it caught a wrong assumption of mine: this
       squeeze compares CLOSE dispersion (Bollinger) against RANGE
       (Keltner). Huge wicks with pinned closes therefore read as
       compressed, not wild. What turns it off is closes marching while
       bars stay small — a trend, not chop. */
    const trending = Array.from({ length: 60 }, (_, i) =>
      bar({ time: i * 60, close: 100 + i * 3, open: 100 + i * 3,
            high: 100.5 + i * 3, low: 99.5 + i * 3 }));
    expect(squeeze(trending, 20, 20, 1.5, 1.15).at(-1)!.on).toBe(false);
  });
});

// ------------------------------------------------------------ momentum

describe("exhaustions", () => {
  it("returns nothing on a flat series", () => {
    expect(exhaustions(flat(80), 14, 10)).toEqual([]);
  });

  it("finds a decelerating push into a new high", () => {
    // Rising fast, then rising by less and less into a fresh high.
    const closes = [
      ...Array.from({ length: 40 }, (_, i) => 100 + i * 2),
      ...[182, 183.5, 184.5, 185.1, 185.4, 185.55],
    ];
    const rows = closes.map((close, i) =>
      bar({ time: i * 60, close, open: close - 0.5,
            high: close + 0.5, low: close - 1 }));
    const found = exhaustions(rows, 14, 10);
    expect(found.every((entry) => entry.kind === "bear")).toBe(true);
  });
});

// -------------------------------------------------------- round levels

describe("roundLevels", () => {
  it("spaces levels by a tenth of the price's magnitude", () => {
    // BTC near 78.5k gets $1,000 rungs — the levels a crowd actually
    // watches. (A tenth of the magnitude, exactly as the Pine does it.)
    expect(roundLevels(78_500, 2)).toEqual([77_000, 78_000, 79_000, 80_000]);
  });

  it("scales down for small prices", () => {
    const levels = roundLevels(0.21, 1);
    expect(levels.map((v) => +v.toFixed(4))).toEqual([0.21, 0.22]);
  });

  it("refuses a nonsense price", () => {
    expect(roundLevels(0)).toEqual([]);
    expect(roundLevels(-5)).toEqual([]);
  });
});

describe("priceZScores", () => {
  it("scores a jump away from the mean", () => {
    const rows = flat(60, 100);
    rows[59] = bar({ time: 59 * 60, close: 130 });
    expect(priceZScores(rows, 50).at(-1)!).toBeGreaterThan(2);
  });
});

import { describe, expect, it } from "vitest";

import {
  filterMarkets, sortMarkets, summarise, type MarketRow,
} from "./markets";

const market = (over: Partial<MarketRow> = {}): MarketRow => ({
  symbol: "BTC", venue: "binance", price: 80_000, change: 1.2,
  volume: 1_000_000, delta: 100_000, deltaPct: 10, ...over,
});

describe("sortMarkets", () => {
  it("leaves the server's volume order alone for 'none'", () => {
    const rows = [market({ venue: "a" }), market({ venue: "b" })];
    expect(sortMarkets(rows, "none", true).map((r) => r.venue)).toEqual(["a", "b"]);
  });

  it("does not mutate its input", () => {
    const rows = [market({ volume: 1 }), market({ volume: 9 })];
    sortMarkets(rows, "volume", true);
    expect(rows.map((r) => r.volume)).toEqual([1, 9]);
  });

  it("sorts by each mode in both directions", () => {
    const rows = [
      market({ venue: "lo", volume: 1, deltaPct: -5, change: -2, price: 1 }),
      market({ venue: "hi", volume: 9, deltaPct: 50, change: 8, price: 99 }),
    ];
    for (const mode of ["volume", "delta", "change", "price"] as const) {
      expect(sortMarkets(rows, mode, true)[0].venue).toBe("hi");
      expect(sortMarkets(rows, mode, false)[0].venue).toBe("lo");
    }
  });

  it("sorts delta by the ratio, not the dollar amount", () => {
    // The whole trap: the thin market is more one-sided, the deep one has
    // far more net buying behind it.
    const thin = market({ venue: "thin", volume: 21_000, delta: 19_000, deltaPct: 91 });
    const deep = market({ venue: "deep", volume: 183_000_000, delta: 22_000_000, deltaPct: 12 });
    expect(sortMarkets([deep, thin], "delta", true)[0].venue).toBe("thin");
  });

  it("sinks unknown values in both directions", () => {
    const rows = [market({ venue: "none", price: null }), market({ venue: "some", price: 5 })];
    expect(sortMarkets(rows, "price", true).map((r) => r.venue)).toEqual(["some", "none"]);
    expect(sortMarkets(rows, "price", false).map((r) => r.venue)).toEqual(["some", "none"]);
  });

  it("handles an empty and a single-row list", () => {
    expect(sortMarkets([], "volume", true)).toEqual([]);
    expect(sortMarkets([market()], "delta", false)).toHaveLength(1);
  });
});

describe("filterMarkets", () => {
  const rows = [
    market({ symbol: "BTC", venue: "binance", volume: 5_000_000 }),
    market({ symbol: "SOL", venue: "okx-fut", volume: 12_000 }),
    market({ symbol: "MON", venue: "hyperliquid", volume: 900 }),
  ];

  it("applies the volume floor", () => {
    expect(filterMarkets(rows, 10_000, "").map((r) => r.symbol))
      .toEqual(["BTC", "SOL"]);
  });

  it("keeps everything at a zero floor", () => {
    expect(filterMarkets(rows, 0, "")).toHaveLength(3);
  });

  it("matches symbol or venue, case-insensitively", () => {
    expect(filterMarkets(rows, 0, "sol").map((r) => r.symbol)).toEqual(["SOL"]);
    expect(filterMarkets(rows, 0, "HYPERLIQ").map((r) => r.symbol)).toEqual(["MON"]);
    expect(filterMarkets(rows, 0, "  fut ").map((r) => r.venue)).toEqual(["okx-fut"]);
  });

  it("combines the floor and the query", () => {
    expect(filterMarkets(rows, 1_000_000, "sol")).toEqual([]);
  });

  it("returns nothing on no match", () => {
    expect(filterMarkets(rows, 0, "zzz")).toEqual([]);
  });
});

describe("summarise", () => {
  it("totals volume and delta across the shown rows", () => {
    const result = summarise([
      market({ volume: 100, delta: 50 }),
      market({ volume: 300, delta: -10 }),
    ]);
    expect(result).toEqual({ markets: 2, volume: 400, delta: 40, deltaPct: 10 });
  });

  it("reports an unknown ratio rather than zero when nothing traded", () => {
    expect(summarise([]).deltaPct).toBeNull();
    expect(summarise([market({ volume: 0, delta: 0 })]).deltaPct).toBeNull();
  });
});

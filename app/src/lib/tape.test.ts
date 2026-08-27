import { describe, expect, it } from "vitest";

import {
  appendCapped, asLiqItem, asTradeItem, liqRows, liqTotals, sizeLevel,
  tradeRows,
} from "./tape";
import type { LiqEvent, Trade } from "./types";

const trade = (over: Partial<Trade> = {}): Trade => ({
  ts: 1_000, venue: "binance", side: "buy", price: 78_000, size: 1,
  notional: 78_000, symbol: "BTC", ...over,
});

const liq = (over: Partial<LiqEvent> = {}): LiqEvent => ({
  ts: 1_000, venue: "binance-fut", side: "long", price: 78_000, size: 1,
  notional: 78_000, symbol: "BTC", ...over,
});

describe("identity", () => {
  it("gives identical prints different ids", () => {
    // The bug: one order filling as several prints in the same
    // millisecond at the same price and size produced colliding React
    // keys, and React appended a duplicate node per render instead of
    // reusing one. 523 <li> for 121 trades.
    const a = asTradeItem(trade());
    const b = asTradeItem(trade());
    expect(a.id).not.toBe(b.id);
  });

  it("keeps ids monotonic across both kinds", () => {
    const first = asTradeItem(trade()).id;
    const second = asLiqItem(liq()).id;
    expect(second).toBeGreaterThan(first);
  });

  it("preserves the underlying fields the chart reads", () => {
    const item = asTradeItem(trade({ notional: 123_456, price: 78_912.5 }));
    expect(item.ts).toBe(1_000);
    expect(item.side).toBe("buy");
    expect(item.notional).toBe(123_456);
    expect(item.size).toBe(1);
  });

  it("pre-renders the display strings once", () => {
    const item = asTradeItem(trade({ notional: 1_234_567, price: 78_912 }));
    expect(item.usdText).toBe("1.23M");
    expect(item.priceText).toBe((78_912).toLocaleString());
    expect(item.timeText).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});

describe("appendCapped", () => {
  it("returns the same reference when nothing arrives", () => {
    const existing = [asTradeItem(trade())];
    expect(appendCapped(existing, [], 10)).toBe(existing);
  });

  it("drops the oldest past the cap, keeping the newest", () => {
    const items = Array.from({ length: 5 }, (_, i) => asTradeItem(trade({ ts: i })));
    const capped = appendCapped(items, [asTradeItem(trade({ ts: 99 }))], 3);
    expect(capped).toHaveLength(3);
    expect(capped.at(-1)!.ts).toBe(99);
    expect(capped[0].ts).toBe(3);
  });

  it("does not cap when under the limit", () => {
    expect(appendCapped([], [asTradeItem(trade())], 10)).toHaveLength(1);
  });
});

describe("tradeRows", () => {
  it("returns trades newest first", () => {
    const trades = [1, 2, 3].map((ts) => asTradeItem(trade({ ts })));
    expect(tradeRows(trades, 0, null, "BTC", 10).map((r) => r.ts)).toEqual([3, 2, 1]);
  });

  it("never returns liquidations — they have their own strip now", () => {
    const trades = [asTradeItem(trade())];
    const rows = tradeRows(trades, 0, null, "BTC", 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].side).toBe("buy");
  });

  it("gates on threshold, venue and symbol", () => {
    const trades = [
      asTradeItem(trade({ ts: 1, notional: 10 })),
      asTradeItem(trade({ ts: 2, notional: 200_000, venue: "okx" })),
      asTradeItem(trade({ ts: 3, notional: 200_000, symbol: "ETH" })),
    ];
    const rows = tradeRows(trades, 100_000, ["okx"], "BTC", 10);
    expect(rows.map((r) => r.ts)).toEqual([2]);
  });

  it("stops at the limit", () => {
    const trades = Array.from({ length: 50 }, (_, i) => asTradeItem(trade({ ts: i })));
    expect(tradeRows(trades, 0, null, "BTC", 5)).toHaveLength(5);
  });

  it("handles an empty tape", () => {
    expect(tradeRows([], 0, null, "BTC", 10)).toEqual([]);
  });
});

describe("liqRows", () => {
  it("returns liquidations newest first", () => {
    const liqs = [1, 2, 3].map((ts) => asLiqItem(liq({ ts })));
    expect(liqRows(liqs, null, "BTC", 10).map((r) => r.ts)).toEqual([3, 2, 1]);
  });

  it("ignores the big-trade threshold — a forced exit counts at any size", () => {
    const liqs = [asLiqItem(liq({ notional: 5 }))];
    expect(liqRows(liqs, null, "BTC", 10)).toHaveLength(1);
  });

  it("still respects the venue filter and symbol", () => {
    const liqs = [
      asLiqItem(liq({ ts: 1, venue: "okx-fut" })),
      asLiqItem(liq({ ts: 2, venue: "binance-fut" })),
      asLiqItem(liq({ ts: 3, venue: "okx-fut", symbol: "ETH" })),
    ];
    expect(liqRows(liqs, ["okx-fut"], "BTC", 10).map((r) => r.ts)).toEqual([1]);
  });

  it("stops at the limit", () => {
    const liqs = Array.from({ length: 30 }, (_, i) => asLiqItem(liq({ ts: i })));
    expect(liqRows(liqs, null, "BTC", 7)).toHaveLength(7);
  });
});

describe("liqTotals", () => {
  it("splits notional by the side that was forced out", () => {
    const rows = [
      asLiqItem(liq({ side: "long", notional: 100 })),
      asLiqItem(liq({ side: "long", notional: 50 })),
      asLiqItem(liq({ side: "short", notional: 25 })),
    ];
    expect(liqTotals(rows)).toEqual({ long: 150, short: 25 });
  });

  it("is zero on an empty strip", () => {
    expect(liqTotals([])).toEqual({ long: 0, short: 0 });
  });
});

describe("sizeLevel", () => {
  it("bands by multiples of the threshold", () => {
    expect(sizeLevel(1)).toBe(0);
    expect(sizeLevel(1.9)).toBe(0);
    expect(sizeLevel(2)).toBe(1);
    expect(sizeLevel(4.9)).toBe(1);
    expect(sizeLevel(5)).toBe(2);      // the chart's "monster" band
    expect(sizeLevel(500)).toBe(2);
  });

  it("treats nonsense as the quietest band", () => {
    expect(sizeLevel(0)).toBe(0);
    expect(sizeLevel(-1)).toBe(0);
    expect(sizeLevel(NaN)).toBe(0);
  });
});

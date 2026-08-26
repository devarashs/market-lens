import { describe, expect, it } from "vitest";

import {
  appendCapped, asLiqItem, asTradeItem, tintPercent, visibleRows,
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

describe("visibleRows", () => {
  const trades = [
    asTradeItem(trade({ ts: 10, notional: 10_000 })),
    asTradeItem(trade({ ts: 30, notional: 200_000, venue: "okx" })),
    asTradeItem(trade({ ts: 50, notional: 90_000 })),
  ];
  const liqs = [
    asLiqItem(liq({ ts: 20, notional: 150_000 })),
    asLiqItem(liq({ ts: 40, notional: 5_000 })),
  ];

  it("interleaves both kinds newest first", () => {
    const rows = visibleRows(trades, liqs, 0, null, "BTC", 10);
    expect(rows.map((r) => r.item.ts)).toEqual([50, 40, 30, 20, 10]);
    expect(rows.map((r) => r.kind))
      .toEqual(["trade", "liq", "trade", "liq", "trade"]);
  });

  it("applies the threshold to both kinds", () => {
    const rows = visibleRows(trades, liqs, 100_000, null, "BTC", 10);
    expect(rows.map((r) => r.item.ts)).toEqual([30, 20]);
  });

  it("applies the venue filter", () => {
    const rows = visibleRows(trades, liqs, 0, ["okx"], "BTC", 10);
    expect(rows.map((r) => r.item.ts)).toEqual([30]);
  });

  it("drops rows belonging to another symbol", () => {
    const stale = [asTradeItem(trade({ ts: 60, symbol: "ETH" }))];
    expect(visibleRows(stale, [], 0, null, "BTC", 10)).toEqual([]);
  });

  it("stops at the limit, newest kept", () => {
    const rows = visibleRows(trades, liqs, 0, null, "BTC", 2);
    expect(rows.map((r) => r.item.ts)).toEqual([50, 40]);
  });

  it("handles either list being empty", () => {
    expect(visibleRows([], liqs, 0, null, "BTC", 10)).toHaveLength(2);
    expect(visibleRows(trades, [], 0, null, "BTC", 10)).toHaveLength(3);
    expect(visibleRows([], [], 0, null, "BTC", 10)).toEqual([]);
  });
});

describe("tintPercent", () => {
  it("floors at the threshold and saturates for monsters", () => {
    expect(tintPercent(1)).toBe(21);
    expect(tintPercent(0)).toBe(12);
    expect(tintPercent(1000)).toBe(50);
  });
});

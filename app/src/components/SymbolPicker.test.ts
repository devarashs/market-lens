import { describe, expect, it } from "vitest";

import { SYMBOL_META, SYMBOL_NAMES } from "../lib/config";
import { matchScore } from "./SymbolPicker";

describe("matchScore", () => {
  it("keeps everything when the query is empty", () => {
    expect(matchScore("NVDA", "Nvidia", "")).toBe(0);
    expect(matchScore("NVDA", "Nvidia", "   ")).toBe(0);
  });

  it("ranks exact ticker above prefix above substring above name", () => {
    expect(matchScore("META", "Meta Facebook", "META")).toBe(0);
    expect(matchScore("METAX", undefined, "META")).toBe(1);
    expect(matchScore("UNITREE", undefined, "NIT")).toBe(2);
    expect(matchScore("AAPL", "Apple", "APPLE")).toBe(3);
  });

  it("finds tickers by company name", () => {
    expect(matchScore("NVDA", "Nvidia", "nvidia")).toBe(3);
    expect(matchScore("MSTR", "MicroStrategy", "micro")).toBe(3);
    expect(matchScore("SKHX", "SK Hynix", "hynix")).toBe(3);
  });

  it("returns null for a non-match", () => {
    expect(matchScore("NVDA", "Nvidia", "tesla")).toBeNull();
    expect(matchScore("BTC", "Bitcoin", "zzz")).toBeNull();
  });

  it("is case-insensitive on both sides", () => {
    expect(matchScore("nvda", "nvidia", "NVDA")).toBe(0);
  });
});

describe("symbol registry", () => {
  it("has unique keys", () => {
    const keys = SYMBOL_META.map((meta) => meta.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("only marks Binance-listed symbols as seconds-capable", () => {
    // Hyperliquid's finest candle is 1m, and everything added from the
    // builder dexes is HL-only — so a stock claiming 1s would 404.
    const secondsCapable = SYMBOL_META.filter((m) => m.seconds).map((m) => m.key);
    expect(secondsCapable).toEqual(["BTC", "ETH", "SOL", "BNB", "DOGE"]);
  });

  it("names every non-obvious ticker so search can find it", () => {
    const stocks = SYMBOL_META.filter((m) => m.cls !== "crypto");
    const unnamed = stocks.filter((m) => !SYMBOL_NAMES[m.key]);
    expect(unnamed.map((m) => m.key)).toEqual([]);
  });
});

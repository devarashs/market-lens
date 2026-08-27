import { describe, expect, it } from "vitest";

import { formatBps, formatPrice, formatUsd, formatUtcTime, shortVenue } from "./format";

describe("formatUsd", () => {
  it("covers each magnitude band", () => {
    expect(formatUsd(0)).toBe("0");
    expect(formatUsd(999)).toBe("999");
    expect(formatUsd(1_000)).toBe("1K");
    expect(formatUsd(25_500)).toBe("26K");
    expect(formatUsd(1_234_567)).toBe("1.23M");
    expect(formatUsd(2_500_000_000)).toBe("2.50B");
  });
});

describe("formatPrice", () => {
  it("scales decimals with magnitude", () => {
    expect(formatPrice(78185.4)).toBe("78,185");
    expect(formatPrice(4204.51)).toBe("4,205");
    expect(formatPrice(184.226)).toBe("184.23");
    expect(formatPrice(43.5)).toBe("43.50");
    expect(formatPrice(0.21786)).toBe("0.2179");
    expect(formatPrice(0.012345)).toBe("0.012345");
  });
});

describe("formatBps", () => {
  it("keeps two decimals below 1bp, where venue spreads actually live", () => {
    // A $0.10 spread on $80,000 is 0.0124bp. One decimal would print
    // "0.0bp" and hide the quantity being reported.
    expect(formatBps(0.012448)).toBe("0.01bp");
    expect(formatBps(0.1245)).toBe("0.12bp");
    expect(formatBps(0)).toBe("0.00bp");
  });

  it("drops to one decimal from 1bp up, where the basis lives", () => {
    expect(formatBps(1)).toBe("1.0bp");
    expect(formatBps(7.7333)).toBe("7.7bp");
    expect(formatBps(12.36)).toBe("12.4bp");
    expect(formatBps(250)).toBe("250.0bp");
  });

  it("switches on magnitude, so a negative reads the same either way", () => {
    expect(formatBps(-0.5)).toBe("-0.50bp");
    expect(formatBps(-7.7333)).toBe("-7.7bp");
  });

  it("rounds up across the band boundary without losing the unit", () => {
    expect(formatBps(0.9999)).toBe("1.00bp");
    expect(formatBps(0.999)).toBe("1.00bp");
  });

  it("does not render nonsense as a number", () => {
    expect(formatBps(NaN)).toBe("—");
    expect(formatBps(Infinity)).toBe("—");
    expect(formatBps(-Infinity)).toBe("—");
  });
});

describe("formatUtcTime", () => {
  it("formats epoch ms as UTC HH:MM:SS", () => {
    expect(formatUtcTime(0)).toBe("00:00:00");
    expect(formatUtcTime(Date.UTC(2026, 7, 25, 17, 19, 25, 768))).toBe("17:19:25");
  });
});

describe("shortVenue", () => {
  it("abbreviates every venue the collector emits", () => {
    expect(shortVenue("binance")).toBe("bin");
    expect(shortVenue("coinbase")).toBe("cb");
    expect(shortVenue("hyperliquid")).toBe("hl");
    expect(shortVenue("kraken")).toBe("krk");
  });

  it("keeps spot and perp distinguishable — they trade at a basis", () => {
    for (const spot of ["binance", "bybit", "okx"]) {
      expect(shortVenue(`${spot}-fut`)).not.toBe(shortVenue(spot));
      expect(shortVenue(`${spot}-fut`)).toMatch(/-f$/);
    }
  });

  it("stays short enough for the row, and degrades for unknown venues", () => {
    for (const venue of Object.keys({
      binance: 0, "binance-fut": 0, bybit: 0, "bybit-fut": 0, okx: 0,
      "okx-fut": 0, coinbase: 0, kraken: 0, hyperliquid: 0,
    })) {
      expect(shortVenue(venue).length).toBeLessThanOrEqual(5);
    }
    expect(shortVenue("some-new-dex").length).toBeLessThanOrEqual(6);
  });
});

import { describe, expect, it } from "vitest";

import { QLH_SETTINGS } from "./config";
import { computeHunter, valueAreaFromProfile } from "./hunter";
import type { Candle } from "./types";

const rows: Candle[] = Array.from({ length: 120 }, (_, i) => {
  const close = 100 + Math.sin(i / 6) * 8;
  return { time: i * 3600, open: close - 0.4, high: close + 1.4,
           low: close - 1.4, close, volume: 100 + (i % 7) * 30 };
});

describe("computeHunter", () => {
  it("returns an empty frame for no candles", () => {
    const frame = computeHunter([], QLH_SETTINGS);
    expect(frame.clusters).toEqual([]);
    expect(frame.squeezeNow).toBe(false);
    expect(frame.roundLevels).toEqual([]);
  });

  it("produces every field from a real-shaped series", () => {
    const frame = computeHunter(rows, QLH_SETTINGS);
    expect(frame.clusters.length).toBeGreaterThan(0);
    expect(frame.roundLevels.length).toBeGreaterThan(0);
    expect(frame.volumeNodes).toHaveLength(QLH_SETTINGS.volumeNodeCount);
    expect(typeof frame.squeezeNow).toBe("boolean");
    expect(typeof frame.priceExtreme).toBe("boolean");
  });

  it("keeps clusters within the cap", () => {
    const frame = computeHunter(rows, QLH_SETTINGS);
    expect(frame.clusters.length).toBeLessThanOrEqual(QLH_SETTINGS.maxClusters * 2);
  });
});

describe("valueAreaFromProfile", () => {
  it("puts the POC on the heaviest bin", () => {
    const area = valueAreaFromProfile(
      [[100, 10, 10], [101, 90, 90], [102, 5, 5]], 70);
    expect(area.poc).toBe(101);
  });

  it("expands outward to cover the target share", () => {
    // 40/100/40 either side: 70% of 200 total needs the POC plus one side.
    const area = valueAreaFromProfile(
      [[99, 10, 10], [100, 50, 50], [101, 20, 20]], 70);
    expect(area.poc).toBe(100);
    expect(area.val).toBeLessThanOrEqual(100);
    expect(area.vah).toBeGreaterThanOrEqual(100);
  });

  it("takes the heavier neighbour first", () => {
    // Totals 2 / 40 / 30 = 72; 90% needs 64.8, so the POC's 40 is not
    // enough and exactly one neighbour gets pulled in — the heavy one.
    const area = valueAreaFromProfile(
      [[99, 1, 1], [100, 20, 20], [101, 15, 15]], 90);
    expect(area.vah).toBe(101);   // the heavy side, not the light one
    expect(area.val).toBe(100);
  });

  it("handles an empty or zero-volume profile", () => {
    expect(valueAreaFromProfile([], 70)).toEqual({ poc: null, vah: null, val: null });
    expect(valueAreaFromProfile([[100, 0, 0]], 70))
      .toEqual({ poc: null, vah: null, val: null });
  });

  it("sorts by price before walking outward", () => {
    const area = valueAreaFromProfile(
      [[102, 5, 5], [100, 90, 90], [101, 10, 10]], 70);
    expect(area.poc).toBe(100);
  });
});

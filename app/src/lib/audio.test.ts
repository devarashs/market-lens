import { describe, expect, it } from "vitest";

import {
  SCHEDULE, liquidationParams, scheduleStarts, soundParams,
} from "./audio";

describe("soundParams", () => {
  it("buys ring above sells at equal size", () => {
    expect(soundParams("buy", 1).frequency)
      .toBeGreaterThan(soundParams("sell", 1).frequency);
  });

  it("bigger prints sit lower, last longer, sound louder", () => {
    const small = soundParams("buy", 1);
    const big = soundParams("buy", 16);
    expect(big.frequency).toBeLessThan(small.frequency);
    expect(big.duration).toBeGreaterThan(small.duration);
    expect(big.gain).toBeGreaterThan(small.gain);
  });

  it("register depth is capped for absurd sizes", () => {
    const monster = soundParams("sell", 10_000);
    expect(monster.frequency).toBeGreaterThan(40); // still audible
    expect(monster.duration).toBeLessThanOrEqual(0.5);
    expect(monster.gain).toBeLessThanOrEqual(0.34); // raised for audibility
  });

  it("timbres differ by side", () => {
    expect(soundParams("buy", 2).type).toBe("sine");
    expect(soundParams("sell", 2).type).toBe("triangle");
  });
});

describe("liquidationParams", () => {
  it("longs dying glide down, shorts dying glide up", () => {
    const long = liquidationParams("long", 1);
    const short = liquidationParams("short", 1);
    expect(long.glideTo!).toBeLessThan(long.frequency);
    expect(short.glideTo!).toBeGreaterThan(short.frequency);
  });

  it("uses a cutting timbre and caps duration", () => {
    const wail = liquidationParams("long", 100);
    expect(wail.type).toBe("sawtooth");
    expect(wail.duration).toBeLessThanOrEqual(0.7);
  });
});

describe("scheduleStarts", () => {
  const now = 100;

  it("spreads a same-millisecond burst instead of stacking a chord", () => {
    // Nine prints arriving in one batch, all timestamped identically —
    // the case that made the tape sound batched rather than flowing.
    const { starts } = scheduleStarts(new Array(9).fill(0), now, 0);
    const times = starts as number[];
    expect(times.every((t) => t !== null)).toBe(true);
    for (const [i, t] of times.slice(1).entries()) {
      expect(t - times[i]).toBeGreaterThanOrEqual(SCHEDULE.minGap - 1e-9);
    }
  });

  it("keeps the real rhythm of a burst when prints are spaced", () => {
    const { starts } = scheduleStarts([0, 0.2, 0.4], now, 0);
    const times = starts as number[];
    expect(times[1] - times[0]).toBeCloseTo(0.2, 6);
    expect(times[2] - times[1]).toBeCloseTo(0.2, 6);
  });

  it("never schedules in the past", () => {
    const { starts } = scheduleStarts([0, 0.05], now, 0);
    for (const t of starts) expect(t!).toBeGreaterThanOrEqual(now);
  });

  it("queues behind notes already scheduled", () => {
    const busy = now + 0.3;
    const { starts } = scheduleStarts([0], now, busy);
    expect(starts[0]).toBeGreaterThanOrEqual(busy);
  });

  it("thins out rather than lagging when the tape is violent", () => {
    const { starts } = scheduleStarts(new Array(200).fill(0), now, 0);
    expect(starts.some((t) => t === null)).toBe(true);
    for (const t of starts) {
      if (t !== null) expect(t).toBeLessThanOrEqual(now + SCHEDULE.maxAhead);
    }
  });

  it("reports a cursor the next batch can queue behind", () => {
    const first = scheduleStarts([0, 0], now, 0);
    const second = scheduleStarts([0], now, first.busyUntil);
    expect(second.starts[0]).toBeGreaterThanOrEqual(first.busyUntil);
  });

  it("recovers from a stale cursor left far in the past", () => {
    const { starts } = scheduleStarts([0], now, now - 50);
    expect(starts[0]).toBeGreaterThanOrEqual(now);
  });

  it("ignores negative offsets from out-of-order timestamps", () => {
    const { starts } = scheduleStarts([0, -5], now, 0);
    for (const t of starts) expect(t!).toBeGreaterThanOrEqual(now);
  });
});

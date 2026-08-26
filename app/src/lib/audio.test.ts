import { describe, expect, it } from "vitest";

import { liquidationParams, soundParams } from "./audio";

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
    expect(monster.gain).toBeLessThanOrEqual(0.16);
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

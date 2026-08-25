import { describe, expect, it } from "vitest";

import { backoffDelayMs } from "./socket";

describe("backoffDelayMs", () => {
  it("caps the ceiling at 15s however many attempts", () => {
    expect(backoffDelayMs(0, () => 1)).toBe(1_000);
    expect(backoffDelayMs(1, () => 1)).toBe(2_000);
    expect(backoffDelayMs(3, () => 1)).toBe(8_000);
    expect(backoffDelayMs(4, () => 1)).toBe(15_000);
    expect(backoffDelayMs(50, () => 1)).toBe(15_000);
  });

  it("applies full jitter from zero", () => {
    expect(backoffDelayMs(5, () => 0)).toBe(0);
    expect(backoffDelayMs(5, () => 0.5)).toBe(7_500);
  });
});

import { describe, expect, it } from "vitest";

import { formatBin } from "./grouping";

describe("formatBin", () => {
  it("names BTC's coarse rungs the way a trader says them", () => {
    expect(formatBin(1_000)).toBe("1k");
    expect(formatBin(5_000)).toBe("5k");
    expect(formatBin(10_000)).toBe("10k");
  });

  it("leaves ordinary dollar bins alone", () => {
    expect(formatBin(10)).toBe("10");
    expect(formatBin(500)).toBe("500");
    expect(formatBin(2.5)).toBe("2.5");
  });

  it("shows sub-dollar bins at their own resolution", () => {
    expect(formatBin(0.05)).toBe("0.05");
    expect(formatBin(0.0005)).toBe("0.0005");
    expect(formatBin(0.00001)).toBe("0.00001");
  });

  it("does not render nonsense as a number", () => {
    expect(formatBin(0)).toBe("—");
    expect(formatBin(-1)).toBe("—");
    expect(formatBin(NaN)).toBe("—");
    expect(formatBin(Infinity)).toBe("—");
  });
});

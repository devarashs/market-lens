import { describe, expect, it } from "vitest";

import { formatPrice, formatUsd, formatUtcTime } from "./format";

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

describe("formatUtcTime", () => {
  it("formats epoch ms as UTC HH:MM:SS", () => {
    expect(formatUtcTime(0)).toBe("00:00:00");
    expect(formatUtcTime(Date.UTC(2026, 7, 25, 17, 19, 25, 768))).toBe("17:19:25");
  });
});

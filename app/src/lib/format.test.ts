import { describe, expect, it } from "vitest";

import { formatUsd, formatUtcTime } from "./format";

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

describe("formatUtcTime", () => {
  it("formats epoch ms as UTC HH:MM:SS", () => {
    expect(formatUtcTime(0)).toBe("00:00:00");
    expect(formatUtcTime(Date.UTC(2026, 7, 25, 17, 19, 25, 768))).toBe("17:19:25");
  });
});

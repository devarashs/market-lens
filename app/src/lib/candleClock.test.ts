import { describe, expect, it } from "vitest";

import { formatCountdown, secondsUntilClose } from "./candleClock";

const MINUTE = 60_000;

describe("secondsUntilClose", () => {
  it("reads the full interval at a boundary and counts down to 1", () => {
    expect(secondsUntilClose(60, 0)).toBe(60);
    expect(secondsUntilClose(60, 1_000)).toBe(59);
    expect(secondsUntilClose(60, 59_000)).toBe(1);
    expect(secondsUntilClose(60, 60_000)).toBe(60); // next bar
  });

  it("aligns 5m bars to :00, :05, :10 rather than to page load", () => {
    const at0703 = Date.UTC(2026, 7, 26, 7, 3, 20);
    expect(secondsUntilClose(300, at0703)).toBe(100); // closes at 07:05:00
  });

  it("aligns the daily bar to 00:00 UTC", () => {
    const at2200 = Date.UTC(2026, 7, 26, 22, 0, 0);
    expect(secondsUntilClose(86_400, at2200)).toBe(2 * 3600);
  });

  it("rounds partial seconds up, so the display never sticks at 0", () => {
    expect(secondsUntilClose(60, 59_500)).toBe(1);
    expect(secondsUntilClose(60, 30 * 1_000 + 1)).toBe(30);
  });
});

describe("formatCountdown", () => {
  it("uses MM:SS under an hour", () => {
    expect(formatCountdown(0)).toBe("00:00");
    expect(formatCountdown(9)).toBe("00:09");
    expect(formatCountdown(272)).toBe("04:32");
    expect(formatCountdown(3_599)).toBe("59:59");
  });

  it("adds hours for 4h and daily bars", () => {
    expect(formatCountdown(3_600)).toBe("1:00:00");
    expect(formatCountdown(11_232)).toBe("3:07:12");
    expect(formatCountdown(23 * 3_600 + MINUTE / 1_000)).toBe("23:01:00");
  });
});

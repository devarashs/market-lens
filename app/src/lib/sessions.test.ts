import { describe, expect, it } from "vitest";

import {
  activeSession, formatCountdown, hoursUntilChange, isOpen, nextSession,
  utcHours, type SessionRow,
} from "./sessions";

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  key: "us", name: "United States", hubs: "New York",
  start: 14, end: 21, studyShare: 35, volume: 0, sharePct: null,
  driftPct: null, ...over,
});

const ASIA = session({ key: "asia", name: "Asia", start: 0, end: 8, studyShare: 28 });
const EUROPE = session({ key: "europe", name: "Europe", start: 8, end: 14, studyShare: 26 });
const US = session();
const LATE = session({ key: "late", name: "Late", start: 21, end: 24, studyShare: 10 });
const ALL = [ASIA, EUROPE, US, LATE];

describe("utcHours", () => {
  it("returns the fractional hour", () => {
    expect(utcHours(new Date(Date.UTC(2026, 7, 28, 14, 30, 0)))).toBeCloseTo(14.5, 5);
    expect(utcHours(new Date(Date.UTC(2026, 7, 28, 0, 0, 0)))).toBe(0);
  });
});

describe("isOpen", () => {
  it("includes the start hour and excludes the end hour", () => {
    expect(isOpen(US, 14)).toBe(true);
    expect(isOpen(US, 20.99)).toBe(true);
    expect(isOpen(US, 21)).toBe(false);   // 21:00 belongs to Late
    expect(isOpen(US, 13.99)).toBe(false);
  });
});

describe("hoursUntilChange", () => {
  it("counts down to the close while open", () => {
    expect(hoursUntilChange(US, 14)).toBe(7);
    expect(hoursUntilChange(US, 20.5)).toBeCloseTo(0.5, 5);
  });

  it("counts down to the open while closed", () => {
    expect(hoursUntilChange(US, 10)).toBe(4);
    expect(hoursUntilChange(ASIA, 22)).toBe(2);   // wraps midnight
  });

  it("counts to tomorrow's open for a session that just closed", () => {
    // At 21:00 the US window (14-21) has just ended, so it reopens at
    // 14:00 tomorrow -- 17 hours, not 24. Asserting 24 here was my own
    // error; the code was right.
    expect(hoursUntilChange(US, 21)).toBe(17);
    expect(hoursUntilChange(ASIA, 8)).toBe(16);   // 0-8 window, just closed
  });

  it("is never negative for any hour of the day", () => {
    for (const s of ALL) {
      for (let h = 0; h < 24; h += 0.25) {
        expect(hoursUntilChange(s, h)).toBeGreaterThan(0);
      }
    }
  });
});

describe("formatCountdown", () => {
  it("pads minutes so the width does not jitter each second", () => {
    expect(formatCountdown(3.117)).toBe("3h 07m");
    expect(formatCountdown(0.5)).toBe("0h 30m");
    expect(formatCountdown(7)).toBe("7h 00m");
  });

  it("never renders a negative countdown", () => {
    expect(formatCountdown(-1)).toBe("0h 00m");
  });
});

describe("activeSession", () => {
  it("finds the one open right now", () => {
    expect(activeSession(ALL, 3)?.key).toBe("asia");
    expect(activeSession(ALL, 9)?.key).toBe("europe");
    expect(activeSession(ALL, 15)?.key).toBe("us");
    expect(activeSession(ALL, 23.9)?.key).toBe("late");
  });

  it("covers every hour, because the windows are contiguous", () => {
    for (let h = 0; h < 24; h += 0.5) {
      expect(activeSession(ALL, h), `hour ${h}`).not.toBeNull();
    }
  });

  it("returns null rather than guessing when nothing matches", () => {
    expect(activeSession([US], 3)).toBeNull();
    expect(activeSession([], 3)).toBeNull();
  });
});

describe("nextSession", () => {
  it("names the one opening soonest", () => {
    expect(nextSession(ALL, 3)?.key).toBe("europe");   // 5h away
    expect(nextSession(ALL, 9)?.key).toBe("us");       // 5h away
    expect(nextSession(ALL, 22)?.key).toBe("asia");    // 2h away, over midnight
  });

  it("never returns the session that is currently open", () => {
    for (let h = 0; h < 24; h += 0.5) {
      expect(nextSession(ALL, h)?.key).not.toBe(activeSession(ALL, h)?.key);
    }
  });

  it("is null when there is nothing to wait for", () => {
    expect(nextSession([], 5)).toBeNull();
  });
});

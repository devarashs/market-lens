import { describe, expect, it } from "vitest";

import { availableMetrics, pickPositioningMetric } from "./positioning";
import type { PositioningSeries } from "./types";

const full: PositioningSeries = {
  "global-accounts": [[1, 5]],
  "top-accounts": [[1, 8]],
  "top-positions": [[1, 12]],
  "bitfinex-margin": [[1, 80]],
};

describe("pickPositioningMetric", () => {
  it("honours an explicit choice that has data", () => {
    expect(pickPositioningMetric(full, "global-accounts")).toBe("global-accounts");
  });

  it("falls back to the money-weighted metric when none is chosen", () => {
    expect(pickPositioningMetric(full, "")).toBe("top-positions");
  });

  it("falls back when the chosen metric has no data for this symbol", () => {
    const partial: PositioningSeries = { "bitfinex-margin": [[1, 80]] };
    expect(pickPositioningMetric(partial, "top-positions")).toBe("bitfinex-margin");
  });

  it("treats an empty array as no data", () => {
    const empty: PositioningSeries = { "top-positions": [], "top-accounts": [[1, 3]] };
    expect(pickPositioningMetric(empty, "top-positions")).toBe("top-accounts");
  });

  it("returns null when the symbol has none — most stocks", () => {
    expect(pickPositioningMetric({}, "")).toBeNull();
    expect(pickPositioningMetric({}, "top-positions")).toBeNull();
  });

  it("ignores unknown metric keys", () => {
    expect(pickPositioningMetric({ nonsense: [[1, 2]] } as PositioningSeries, ""))
      .toBeNull();
  });
});

describe("availableMetrics", () => {
  it("lists what the symbol has, in preference order", () => {
    expect(availableMetrics(full)).toEqual([
      "top-positions", "bitfinex-margin", "top-accounts", "global-accounts"]);
  });

  it("is empty for a symbol with no positioning data", () => {
    expect(availableMetrics({})).toEqual([]);
  });
});

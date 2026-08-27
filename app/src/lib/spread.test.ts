import { describe, expect, it } from "vitest";

import {
  crossVenueBasis,
  isInOverlap,
  overlapBand,
  tightestVenueSpread,
  venueSpreads,
  widestVenueDivergence,
} from "./spread";
import type { VenueBest } from "./spread";
import type { DepthLevel } from "./types";

/* The book that produced "-10.0bp" on screen, BTC 2026-08-27, copied from
   the reading taken that day. Every venue tight, not one of them crossed,
   and the aggregate crossed by ~7bp. Every regression test below leans on
   this fixture, so `fixture integrity` guards it first. */
const BTC_CROSSED: VenueBest = {
  kraken: { bid: 80_333.4, ask: 80_333.5 },
  coinbase: { bid: 80_328.8, ask: 80_328.8 },
  okx: { bid: 80_319.5, ask: 80_319.6 },
  binance: { bid: 80_309.9, ask: 80_310.0 },
  hyperliquid: { bid: 80_302.0, ask: 80_303.0 },
  "binance-fut": { bid: 80_274.4, ask: 80_274.5 },
  "okx-fut": { bid: 80_271.4, ask: 80_271.5 },
  "bybit-fut": { bid: 80_271.2, ask: 80_271.3 },
};

/** An ordinary uncrossed two-venue book, with arithmetic that stays exact
    in binary floating point so the assertions can be equalities. */
const CLEAN: VenueBest = {
  alpha: { bid: 99, ask: 101 }, // 2 wide over a mid of 100 -> 200bp
  beta: { bid: 98, ask: 104 }, // 6 wide over a mid of 101 -> ~594bp
};

describe("fixture integrity", () => {
  it("the live sample really does cross the aggregate", () => {
    // If this stops holding, the sample no longer reproduces the reported
    // bug and every regression test in this file proves nothing.
    const bids = Object.values(BTC_CROSSED).map((quote) => quote.bid!);
    const asks = Object.values(BTC_CROSSED).map((quote) => quote.ask!);
    expect(Math.min(...asks) - Math.max(...bids)).toBeLessThan(0);
  });

  it("no individual venue in the live sample is crossed", () => {
    // The whole point of the reading: the crossing is basis, not a broken
    // feed. Each venue quotes an ask at or above its own bid.
    for (const [venue, quote] of Object.entries(BTC_CROSSED)) {
      expect(quote.ask!, venue).toBeGreaterThanOrEqual(quote.bid!);
    }
  });
});

describe("venueSpreads", () => {
  it("never reports a negative spread on the book that read -10.0bp", () => {
    const spreads = venueSpreads(BTC_CROSSED);
    expect(spreads).toHaveLength(8);
    for (const spread of spreads) expect(spread.bps).toBeGreaterThanOrEqual(0);
  });

  it("measures each venue against its own mid", () => {
    const [alpha, beta] = venueSpreads(CLEAN);
    expect(alpha.venue).toBe("alpha");
    expect(alpha.bps).toBeCloseTo(200, 10);
    expect(beta.bps).toBeCloseTo((6 / 101) * 10_000, 10);
  });

  it("does not move one venue's number when another venue changes", () => {
    const before = venueSpreads(CLEAN).find((s) => s.venue === "alpha")!.bps;
    const withFarVenue = venueSpreads({ ...CLEAN, gamma: { bid: 10, ask: 11 } });
    expect(withFarVenue.find((s) => s.venue === "alpha")!.bps).toBe(before);
  });

  it("orders tightest first", () => {
    const spreads = venueSpreads(BTC_CROSSED);
    for (let i = 1; i < spreads.length; i += 1) {
      expect(spreads[i].bps).toBeGreaterThanOrEqual(spreads[i - 1].bps);
    }
  });

  it("keeps a locked venue rather than hiding it", () => {
    // coinbase quoted bid == ask in the live sample. Zero is a real
    // reading for a locked book, so it wins "tightest" honestly.
    const locked = venueSpreads(BTC_CROSSED).find((s) => s.venue === "coinbase");
    expect(locked?.bps).toBe(0);
  });

  it("skips a venue quoting its ask below its own bid", () => {
    // One book cannot really be crossed: that is a stale or garbled feed,
    // and it must never be handed the "tightest" label.
    const spreads = venueSpreads({ ...CLEAN, garbled: { bid: 105, ask: 95 } });
    expect(spreads.map((s) => s.venue)).toEqual(["alpha", "beta"]);
  });

  it("skips venues that are not quoting both sides", () => {
    const warming: VenueBest = {
      alpha: { bid: 99, ask: 101 },
      noAsk: { bid: 99, ask: null },
      noBid: { bid: null, ask: 101 },
      neither: { bid: null, ask: null },
    };
    expect(venueSpreads(warming).map((s) => s.venue)).toEqual(["alpha"]);
  });

  it("rejects prices that are not finite and positive", () => {
    const junk = {
      zero: { bid: 0, ask: 1 },
      negative: { bid: -1, ask: 1 },
      nan: { bid: NaN, ask: 1 },
      infinite: { bid: 1, ask: Infinity },
      stringy: { bid: "99" as unknown as number, ask: 101 },
    } as VenueBest;
    expect(venueSpreads(junk)).toEqual([]);
  });

  it("returns nothing for an absent or empty book", () => {
    expect(venueSpreads({})).toEqual([]);
    expect(venueSpreads(undefined)).toEqual([]);
    expect(venueSpreads(null)).toEqual([]);
  });

  it("breaks exact ties on venue name, whatever the key order", () => {
    // Two locked venues both score 0bp. The rendered label must not
    // flicker between them frame to frame.
    const one: VenueBest = { zulu: { bid: 100, ask: 100 }, alpha: { bid: 50, ask: 50 } };
    const other: VenueBest = { alpha: { bid: 50, ask: 50 }, zulu: { bid: 100, ask: 100 } };
    expect(venueSpreads(one).map((s) => s.venue)).toEqual(["alpha", "zulu"]);
    expect(venueSpreads(other).map((s) => s.venue)).toEqual(["alpha", "zulu"]);
  });
});

describe("tightestVenueSpread", () => {
  it("picks the tightest real spread from the crossed live book", () => {
    const tightest = tightestVenueSpread(BTC_CROSSED)!;
    expect(tightest.venue).toBe("coinbase");
    expect(tightest.bps).toBe(0);
    expect(tightest.bid).toBe(80_328.8);
    expect(tightest.ask).toBe(80_328.8);
  });

  it("reports a sub-0.1bp spread rather than rounding it away", () => {
    // kraken at 80,333.4 / 80,333.5 -> 1000 / 80,333.45 bp.
    const noLockedVenue = { ...BTC_CROSSED };
    delete noLockedVenue.coinbase;
    const tightest = tightestVenueSpread(noLockedVenue)!;
    expect(tightest.venue).toBe("kraken");
    expect(tightest.bps).toBeCloseTo(0.012448, 6);
  });

  it("is null when nothing is quoting both sides", () => {
    expect(tightestVenueSpread({})).toBeNull();
    expect(tightestVenueSpread({ warming: { bid: null, ask: null } })).toBeNull();
    expect(tightestVenueSpread(undefined)).toBeNull();
  });
});

describe("crossVenueBasis", () => {
  it("names the overlap on the live book, and its two sides", () => {
    // The widest pair, not the illustrative one: the docs narrate kraken
    // against binance-fut, but bybit-fut asks lower still, so that is the
    // true extreme and the number the UI reports.
    const basis = crossVenueBasis(BTC_CROSSED)!;
    expect(basis.bidVenue).toBe("kraken");
    expect(basis.askVenue).toBe("bybit-fut");
    expect(basis.bid).toBe(80_333.4);
    expect(basis.ask).toBe(80_271.3);
    // $62.10 wide over a mid of 80,302.35.
    expect(basis.bps).toBeCloseTo(7.7333, 3);
  });

  it("takes the extremes across every venue, not the first pair it sees", () => {
    const bids = Object.values(BTC_CROSSED).map((quote) => quote.bid!);
    const asks = Object.values(BTC_CROSSED).map((quote) => quote.ask!);
    const basis = crossVenueBasis(BTC_CROSSED)!;
    expect(basis.bid).toBe(Math.max(...bids));
    expect(basis.ask).toBe(Math.min(...asks));
  });

  it("reports a positive magnitude, never a negative spread", () => {
    expect(crossVenueBasis(BTC_CROSSED)!.bps).toBeGreaterThan(0);
  });

  it("is null when the venues agree", () => {
    expect(crossVenueBasis(CLEAN)).toBeNull();
  });

  it("is null when the two sides touch exactly", () => {
    // Highest bid equal to lowest ask is a locked aggregate, not an
    // overlap: there is no gap to call a basis.
    const touching: VenueBest = {
      alpha: { bid: 100, ask: 101 },
      beta: { bid: 99, ask: 100 },
    };
    expect(crossVenueBasis(touching)).toBeNull();
  });

  it("is null when one venue holds both extremes", () => {
    // A single crossed book is a feed fault. Labelling it "basis between
    // two instruments" would be a lie about what is on screen.
    expect(crossVenueBasis({ solo: { bid: 105, ask: 95 } })).toBeNull();
  });

  it("is null for a single healthy venue, as a venue filter produces", () => {
    expect(crossVenueBasis({ kraken: { bid: 80_333.4, ask: 80_333.5 } })).toBeNull();
  });

  it("still reports when the extremes come from two venues, one of them garbled", () => {
    // Deliberate: from the outside a venue quoting low is indistinguishable
    // from a perp at a discount, and the ladder genuinely does cross here.
    // The single-venue guard above covers the only unambiguous fault.
    const basis = crossVenueBasis({
      alpha: { bid: 100, ask: 101 },
      garbled: { bid: 99, ask: 98 },
    })!;
    expect(basis.bidVenue).toBe("alpha");
    expect(basis.askVenue).toBe("garbled");
    expect(basis.bps).toBeCloseTo((2 / 99) * 10_000, 10);
  });

  it("ignores venues quoting only one side when finding the extremes", () => {
    const basis = crossVenueBasis({
      alpha: { bid: 100, ask: null },
      beta: { bid: null, ask: 98 },
      junk: { bid: NaN, ask: 0 },
    })!;
    expect(basis.bidVenue).toBe("alpha");
    expect(basis.askVenue).toBe("beta");
  });

  it("is null for an absent or empty book", () => {
    expect(crossVenueBasis({})).toBeNull();
    expect(crossVenueBasis(undefined)).toBeNull();
    expect(crossVenueBasis(null)).toBeNull();
  });
});

describe("widestVenueDivergence", () => {
  it("finds the venue furthest from the aggregate mid, signed", () => {
    const above = widestVenueDivergence({ alpha: { bid: 99, ask: 101 } }, 100);
    expect(above).toEqual({ venue: "alpha", bps: 0 });

    const below = widestVenueDivergence(
      { high: { bid: 109, ask: 111 }, low: { bid: 89, ask: 91 } }, 100);
    // low's mid of 90 is 1000bp under; high's mid of 110 is 1000bp over.
    // Equal magnitude, so the name breaks the tie.
    expect(below).toEqual({ venue: "high", bps: 1000 });
  });

  it("keeps the sign of a venue quoting under the consensus", () => {
    const result = widestVenueDivergence({ low: { bid: 89, ask: 91 } }, 100)!;
    expect(result.bps).toBeCloseTo(-1000, 10);
  });

  it("picks the widest, not the last seen", () => {
    const result = widestVenueDivergence({
      near: { bid: 100, ask: 102 },
      far: { bid: 79, ask: 81 },
      alsoNear: { bid: 99, ask: 101 },
    }, 100)!;
    expect(result.venue).toBe("far");
  });

  it("is null when the aggregate mid is unusable", () => {
    expect(widestVenueDivergence(CLEAN, null)).toBeNull();
    expect(widestVenueDivergence(CLEAN, 0)).toBeNull();
    expect(widestVenueDivergence(CLEAN, NaN)).toBeNull();
    expect(widestVenueDivergence(CLEAN, undefined)).toBeNull();
  });

  it("is null when no venue quotes both sides", () => {
    expect(widestVenueDivergence({ warming: { bid: 100, ask: null } }, 100)).toBeNull();
    expect(widestVenueDivergence({}, 100)).toBeNull();
  });
});

describe("overlapBand", () => {
  /* The ladder as it rendered on 2026-08-27: ask rows at 80,100 / 80,090 /
     80,080 sitting BELOW bid rows at 80,160 / 80,150 / 80,140. Server
     order is nearest-mid first on both sides. */
  const crossedBids: DepthLevel[] = [[80_160, 4e5], [80_150, 3e5], [80_140, 2e5]];
  const crossedAsks: DepthLevel[] = [[80_080, 5e5], [80_090, 3e5], [80_100, 1e5]];

  it("spans the whole crossed region of the live ladder", () => {
    expect(overlapBand(crossedBids, crossedAsks)).toEqual({ low: 80_080, high: 80_160 });
  });

  it("marks every row of that ladder, on both sides", () => {
    const band = overlapBand(crossedBids, crossedAsks);
    for (const [price] of [...crossedBids, ...crossedAsks]) {
      expect(isInOverlap(price, band), String(price)).toBe(true);
    }
  });

  it("is null for an ordinary book whose sides do not meet", () => {
    expect(overlapBand([[99, 1], [98, 1]], [[101, 1], [102, 1]])).toBeNull();
  });

  it("does not mark one shared bin, which is grouping and not a cross", () => {
    // Seen live with Markets filtered to kraken at grp 10: a $0.10 spread
    // puts that venue's own bid and ask in the same $10 bin. Ubiquitous at
    // coarse grouping, so marking it would be decoration, not a signal.
    expect(overlapBand([[100, 1]], [[100, 1]])).toBeNull();
  });

  it("marks as soon as the bid bin is strictly above the ask bin", () => {
    expect(overlapBand([[110, 1]], [[100, 1]])).toEqual({ low: 100, high: 110 });
  });

  it("never marks a row the ladder has not actually drawn crossed", () => {
    // The marking explains a visual anomaly, so it must follow what is on
    // screen. Wherever the drawn ladder is not crossed there is nothing to
    // explain, whatever the underlying quotes are doing.
    const uncrossed: Array<[DepthLevel[], DepthLevel[]]> = [
      [[[99, 1]], [[101, 1]]], // ordinary
      [[[100, 1]], [[100, 1]]], // both sides in one bin
      [[[99, 1], [98, 1]], [[100, 1], [101, 1]]], // touching bins
    ];
    for (const [bids, asks] of uncrossed) {
      expect(overlapBand(bids, asks)).toBeNull();
    }
  });

  it("stays silent when coarse grouping hides a real basis inside one bin", () => {
    // overlapBand reads the BINNED ladder; crossVenueBasis reads raw
    // quotes. At grp 500 a $50 basis lands inside a single bin: the basis
    // is still reported, and correctly nothing is marked, because the
    // drawn ladder shows no bid above an ask.
    const best: VenueBest = {
      spot: { bid: 80_030, ask: 80_031 },
      perp: { bid: 79_979, ask: 79_980 },
    };
    expect(crossVenueBasis(best)).not.toBeNull();
    expect(overlapBand([[80_000, 1]], [[80_000, 1]])).toBeNull();
  });

  it("does not depend on the server's level ordering", () => {
    const shuffledBids: DepthLevel[] = [[80_140, 1], [80_160, 1], [80_150, 1]];
    const shuffledAsks: DepthLevel[] = [[80_100, 1], [80_080, 1], [80_090, 1]];
    expect(overlapBand(shuffledBids, shuffledAsks))
      .toEqual({ low: 80_080, high: 80_160 });
  });

  it("is null when either side is empty or absent", () => {
    expect(overlapBand([], [[100, 1]])).toBeNull();
    expect(overlapBand([[100, 1]], [])).toBeNull();
    expect(overlapBand(undefined, undefined)).toBeNull();
    expect(overlapBand(null, null)).toBeNull();
  });

  it("ignores level prices that are not finite and positive", () => {
    expect(overlapBand([[0, 1], [NaN, 1]], [[100, 1]])).toBeNull();
    expect(overlapBand([[120, 1], [Infinity, 1]], [[100, 1]]))
      .toEqual({ low: 100, high: 120 });
  });
});

describe("isInOverlap", () => {
  const band = { low: 80_080, high: 80_160 };

  it("includes both boundaries", () => {
    expect(isInOverlap(80_080, band)).toBe(true);
    expect(isInOverlap(80_160, band)).toBe(true);
  });

  it("excludes rows just outside the band", () => {
    expect(isInOverlap(80_079.99, band)).toBe(false);
    expect(isInOverlap(80_160.01, band)).toBe(false);
  });

  it("leaves rows away from the touch unmarked, as the docs promise", () => {
    expect(isInOverlap(79_000, band)).toBe(false);
    expect(isInOverlap(81_500, band)).toBe(false);
  });

  it("marks nothing when there is no band", () => {
    expect(isInOverlap(80_100, null)).toBe(false);
  });
});
